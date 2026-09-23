# Bills Hub — DigitalOcean deployment

Bills Hub is a plain Node 18+ Express app with its own MySQL database. It can sit
on the same droplet as WazzOCR (different port) or on its own, but its database
**must be on the same MySQL cluster as WazzOCR's**, because it reads WazzOCR's two
Xero tables to share the Xero grant.

## 1. Database

Create a **new database** on the same DigitalOcean MySQL cluster — not inside
WazzOCR's:

```sql
CREATE DATABASE billhub CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

Give the Bills Hub user read access to WazzOCR's two Xero tables, plus the one
write it cannot avoid — Xero invalidates a refresh token on use, so whoever
refreshes must store the replacement:

```sql
GRANT SELECT, UPDATE ON `wazzocr`.`xero_grants`       TO '<billhub user>'@'%';
GRANT SELECT          ON `wazzocr`.`xero_connections` TO '<billhub user>'@'%';
FLUSH PRIVILEGES;
```

Nothing else in `wazzocr` is read or written, and no table there is created,
altered or dropped.

Download the cluster's CA certificate from the DigitalOcean database page and put
it at `certs/do-mysql-ca.crt` (gitignored), or paste it inline as
`DB_CA_CERT_PEM`. DigitalOcean requires SSL and the app refuses to connect
without a verified certificate.

```bash
npm ci --omit=dev
npm run db:migrate     # idempotent; only creates Bills Hub's own tables
npm run db:test        # lists the tables and their row counts
```

## 2. Environment

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored — keep it out
of the repo and out of chat.

Three values must be **copied from WazzOCR's `.env`, not generated**:

| Variable | Why |
| --- | --- |
| `APP_ENCRYPTION_KEY` | Decrypts WazzOCR's stored Xero refresh token. A different key cannot read it. |
| `XERO_CLIENT_ID` | The two apps share one Xero app, so they share one grant. |
| `XERO_CLIENT_SECRET` | Same. |

Also set `WAZZOCR_DB_NAME` (WazzOCR's schema on the cluster) and `WAZZOCR_URL`
(where the UI sends people to connect Xero).

For the WhatsApp digest, set `WAZZUP_CHANNEL_ID`, `WAZZUP_API_KEY`,
`WAZZUP_SENDER_PHONE` and `DIGEST_QUEUE_URL`. These seed the digest settings on
**first run only** — after that the database holds them (the key encrypted) and
rotating the key means `PATCH /api/digest/settings`, not editing `.env`. The
digest ships switched off; turn it on in the Notifications tab once the
recipients are right.

**Set `AUTH_DISABLED=false` for anything reachable from the internet.** With it
on there is no sign-in at all, and Bills Hub can submit and approve bills in the
connected Xero organisations — so anyone who finds the URL can too. If you do
deploy it open for internal testing, put it behind a VPN, an IP allowlist or HTTP
basic auth at nginx.

## 3. Xero app

**Nothing to change at developer.xero.com.** Bills Hub has no redirect URI and no
consent flow, deliberately:

> "If the authorisation process is repeated for the same combination of Xero user
> and App, the newly issued set of tokens will supersede the previous set."
> — [Managing Tokens and Ids](https://developer.xero.com/documentation/best-practices/data-integrity/managing-tokens)

Authorising Bills Hub with the same Xero login on the same app would invalidate
WazzOCR's token and stop its live bill pipeline. `GET /api/xero/connect` returns
409 and points at WazzOCR so this cannot happen by accident.

Bills Hub needs `accounting.transactions` (write) to submit and approve bills
and to create batch payments, and `accounting.settings.read` to see the bank
accounts it can pay from. If WazzOCR's app was authorised without it, reconnect **in WazzOCR** after
adding the scope there; Bills Hub picks up the new grant automatically.

## 4. First run

Find the WazzOCR account id whose Xero grant to borrow:

```sql
SELECT id, name FROM wazzocr.accounts;
```

```bash
npm run create-account "Ayu Borneo Group" you@example.com <wazzocrAccountId>
npm start
```

Sign in and press **Sync Xero** — Xero is already connected through WazzOCR, so
there is nothing to authorise. `GET /api/xero/verify` confirms the borrowed token
works and reports how many organisations Xero says it can reach.

The first sync reads every organisation in full and can take a few minutes across
40 orgs; later runs are incremental. To backfill from the command line instead:

```bash
node scripts/sync-bills.js --full
```

## 5. Keeping it up

Run it under systemd (or pm2, matching whatever WazzOCR uses on the droplet):

```ini
# /etc/systemd/system/billhub.service
[Unit]
Description=Bills Hub
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/billhub
EnvironmentFile=/srv/billhub/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now billhub
sudo systemctl status billhub
curl -s localhost:3000/api/health
```

Put nginx in front for TLS and set `TRUST_PROXY_HOPS=1` so `req.ip` and the
secure-cookie flag come from the forwarded headers.

The app handles `SIGTERM` by stopping the sync scheduler and letting in-flight
Xero calls finish, so a restart mid-sync is safe: cursors only advance on
success, and an interrupted organisation simply re-reads its window next time.

## 6. Sync scheduling

The in-process scheduler runs every `SYNC_INTERVAL_MINUTES` (default 15). If you
would rather use cron, set `SYNC_INTERVAL_MINUTES=0` and:

```cron
*/15 * * * * cd /srv/billhub && /usr/bin/node scripts/sync-bills.js >> /var/log/billhub-sync.log 2>&1
```

## Health checks

| Check | Expect |
| --- | --- |
| `curl localhost:3000/api/health` | `{"ok":true,"db":"up","wazzocrGrantStore":"up"}` |
| Boot log | no `AUTH_DISABLED` warning block, unless you meant it |
| `npm run db:test` | every table listed |
| `GET /api/xero/status` (signed in) | `connected: true`, the org count, `needsReconnect: 0` |
| `GET /api/xero/verify` (signed in) | `xeroSees` matches `wazzocrHas`, `missingLocally` empty |
| `GET /api/bills/sync/status` | every organisation `ok`, with a recent `lastRunAt` |
| `GET /api/payments` | `bankStats` present; `unconfiguredFormats` is 0 |
| `GET /api/digest` | `settings.configured` is true; `nextRun` reads as expected |
| Boot log | `[digest] scheduler checking every 60s` |

`wazzocrGrantStore` anything other than `up` means the cross-database GRANT is
missing — fix that before debugging anything else.

## Troubleshooting

**`invalid_client`** — `XERO_CLIENT_SECRET` does not match WazzOCR's, or the
secret has been rotated in Xero.

**"Could not decrypt WazzOCR's Xero refresh token"** — `APP_ENCRYPTION_KEY` is not
the same value WazzOCR uses. Copy it across; do not generate a new one.

**`wazzocrGrantStore: unreadable`, or every org fails at once** — the Bills Hub DB
user is missing the GRANT on `wazzocr.xero_grants` / `wazzocr.xero_connections`,
or `WAZZOCR_DB_NAME` names the wrong schema.

**"This account is not linked to a WazzOCR account"** — set the mapping:
`UPDATE billhub.accounts SET wazzocr_account_id = <id> WHERE id = <id>;`

**An organisation shows `needsReconnect`** — its grant was refused, usually because
the refresh token went unused for 60 days or someone revoked the app in Xero.
Reconnect **in WazzOCR**; one consent there repairs every organisation, and Bills
Hub picks it up on the next call.

**Intermittent `invalid_grant`** — Bills Hub and WazzOCR refreshed the shared token
at the same moment. It normally self-heals on the next call, since both re-read
the row before refreshing and Xero honours the previous token for 30 minutes. If
it recurs, wrap WazzOCR's refresh in the same `SELECT … FOR UPDATE` on
`xero_grants` that Bills Hub uses (see `models/xeroConnections.js`).

**429s during a backfill** — lower `XERO_CALLS_PER_MIN` (default 55, ceiling 60)
and `SYNC_CONCURRENCY`. The client already retries with `Retry-After`.

**A bank rejects a payment file** — the layout is almost certainly wrong for that
customer registration. Layouts are data: fix the columns with
`PUT /api/payments/formats/:key` and download again, no deploy needed. Send a
single-line test payment before the next full run, and only then set
`verified: true`.

**"No paying accounts"** — run `POST /api/payments/sync`; it mirrors Xero's BANK
accounts. Then set each one's `formatKey`, or it falls back to `generic-csv`.

**The digest does not arrive** — check `GET /api/digest` first: `enabled`,
`configured`, and what `nextRun` says. Then `GET /api/digest/runs` — a `failed`
row carries Wazzup's own error, and a `skipped` row means that recipient had no
drafts in scope. `POST /api/digest/test` proves the channel independently of the
schedule.

**The digest arrives at the wrong hour** — `send_time` is local to
`digest_settings.timezone`, not the server clock. Check the timezone before the
time.

**A recharge will not post** — check the account codes first
(`GET /api/recharge`, `settings.configured`). Both must exist in *every*
organisation the recharge touches; Xero rejects the line otherwise and the
reason is shown on the recharge. Fix the code and post again — only the missing
documents are created.

**Bills missing after a sync** — check `GET /api/bills/sync/status` for that
organisation's `last_error`. A failed run leaves the cursor untouched, so the
next run retries the same window; a full re-read is
`node scripts/sync-bills.js --full`.

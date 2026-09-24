# Bills Hub — DigitalOcean deployment

Bills Hub is a plain Node 18+ Express app with its own MySQL database.

## Pick the grant mode first — it changes the database requirement

| | `XERO_GRANT_SOURCE=own` | `XERO_GRANT_SOURCE=wazzocr` |
| --- | --- | --- |
| Where the Xero token lives | Bills Hub's own `xero_grants` | `wazzocr.xero_grants` |
| Consent | Bills Hub runs its own | Borrowed; **never** start one here |
| Xero app | Its own client id and secret | WazzOCR's, copied |
| `APP_ENCRYPTION_KEY` | Generate a fresh one | **Copy WazzOCR's**, or the token will not decrypt |
| Database | Anywhere | **Same MySQL cluster as `wazzocr`**, with cross-database GRANTs |
| Organisations reachable | Only what you consented to | All 41, live ones included |

> **The database requirement is why the order matters.** A borrowed grant is
> read out of `wazzocr.xero_grants`. Bills Hub can only reach that table from
> the cluster it lives on, so `wazzocr` mode cannot be tried on a laptop against
> a local MySQL — there is no grant there to borrow. **Deploy in `own` mode
> first, then flip the variable on the server.** Section 7 is that switch.

---

## 0. Deploying next to WazzOCR — the short path

If Bills Hub goes on the same droplet, most of the setup is already on the box.
Four values have to match WazzOCR exactly, and retyping the encryption key is how
you get a deployment that fails every organisation at once with nothing in the
logs to explain it. So copy them off disk instead:

```bash
npm run adopt-env -- --from /srv/wazzocr/.env --db-name billhub --port 3311
```

It reads WazzOCR's `.env` and writes Bills Hub's: the encryption key, client id
and secret, and the database credentials, verbatim. It never prints a value —
the report shows a six-character fingerprint, which is enough to prove the two
files agree. It also lifts WazzOCR's own `DB_NAME` into `WAZZOCR_DB_NAME` (the
schema to read across into), refuses if you point Bills Hub's database at
WazzOCR's, and writes the file `chmod 600`.

Two things it sets deliberately:

- `AUTH_DISABLED=false` — this one is reachable from the internet.
- `XERO_TENANT_ALLOWLIST` to a value matching no tenant id, so **every Xero write
  is refused and every read works**. The first boot is then a look around that
  cannot change anything. Replace it when you have decided what may be written
  to; § 7c has the rest.

Use a second Xero client secret if you would rather the two apps be revocable
independently:

```bash
npm run adopt-env -- --from /srv/wazzocr/.env --client-secret <your second secret>
```

Then carry on at § 1 for the database, § 5 for systemd and nginx.

---

## 1. Database

Create a **new database** — not inside WazzOCR's:

```sql
CREATE DATABASE billhub CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

In `wazzocr` mode only, give the Bills Hub user read access to WazzOCR's two
Xero tables, plus the one write it cannot avoid — Xero invalidates a refresh
token on use, so whoever refreshes must store the replacement:

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

In `wazzocr` mode three values must be **copied from WazzOCR's `.env`, not
generated**:

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

### `own` mode

Register the deployed callback at developer.xero.com — it must match
`XERO_REDIRECT_URI` character for character:

```
https://<your-host>/api/xero/callback
```

Scopes, one per endpoint Bills Hub actually calls:

```
openid profile email offline_access
accounting.invoices          GET/POST /Invoices      bills, submit/approve, recharge
accounting.payments          POST /BatchPayments     paying a bank-file batch
accounting.contacts          GET/POST /Contacts      payees, and recharge CREATES
                                                     the counterparty contact
accounting.settings.read     GET /Accounts           bank accounts to pay from
```

> These must be the **granular** scopes. Xero assigns them to every Web app
> created since March 2026 and rejects the old broad `accounting.transactions`
> with `invalid_scope` — the consent screen never appears. Override with
> `XERO_SCOPES` only if your app is older and still on broad scopes.

### `wazzocr` mode

**Nothing to change at developer.xero.com**, and Bills Hub deliberately has no
consent flow:

> "If the authorisation process is repeated for the same combination of Xero user
> and App, the newly issued set of tokens will supersede the previous set."
> — [Managing Tokens and Ids](https://developer.xero.com/documentation/best-practices/data-integrity/managing-tokens)

Authorising Bills Hub with the same Xero login on the same app would invalidate
WazzOCR's token and stop its live bill pipeline. `GET /api/xero/connect` returns
409 and points at WazzOCR so this cannot happen by accident.

What the borrowed grant must already carry is checked, read-only, by
`node scripts/preflight.js` — see section 7.

## 4. First run

```bash
npm run create-account "Ayu Borneo Group" you@example.com
npm start
```

In `wazzocr` mode, pass the WazzOCR account id whose grant to borrow as a third
argument:

```sql
SELECT id, name FROM wazzocr.accounts;
```

```bash
npm run create-account "Ayu Borneo Group" you@example.com <wazzocrAccountId>
```

Then **Connect Xero** (own mode) or **Sync Xero** (wazzocr mode — already
connected, nothing to authorise). `GET /api/xero/verify` confirms the token works
and reports how many organisations Xero says it can reach.

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

## 7. Switching a deployment to WazzOCR's grant

Do this **on the server**, once it is running in `own` mode and the modules are
proven. Xero tenant ids identify the organisation rather than the app
connection, so `entities`, `bills` and everything keyed on them survive the
switch.

### 7a. Dry run — proves everything, changes nothing

Add the GRANTs (section 1), set the mapping, and put WazzOCR's three values in
`.env` alongside `XERO_GRANT_SOURCE=wazzocr`. Then:

```bash
UPDATE billhub.accounts SET wazzocr_account_id = <id> WHERE id = 1;
```

```bash
node scripts/preflight.js
```

Every script and the server read `.env` by default and `$ENV_FILE` when it is
set, so the two configurations can sit side by side instead of one overwriting
the other:

```bash
ENV_FILE=.env.wazzocr node scripts/preflight.js
```

That matters because the dry run can be done from a laptop — Bills Hub's own
tables have to be on WazzOCR's cluster, but the process reading them does not.
Point `DB_*` at the cluster (your IP will need to be in its trusted sources) and
the same checks run locally.

Set `XERO_TENANT_ALLOWLIST` to a value that matches no tenant id for that run.
Every write is then refused while every read still works, which is exactly what a
verification wants.

Read-only and **no Xero call at all**, so WazzOCR's refresh token is not rotated
and its pipeline is untouched. It proves:

- the cross-database `SELECT`, and the `UPDATE` (a no-op inside a rolled-back
  transaction)
- that `APP_ENCRYPTION_KEY` decrypts WazzOCR's stored token
- **the scopes on the borrowed grant**, read out of `xero_grants.scope`, each
  named with the feature it carries
- the account mapping, and the entity codes the 41 organisations would get
- whether `XERO_TENANT_ALLOWLIST` is set

### 7b. The scope that is probably missing

WazzOCR never creates a payment, so its grant is unlikely to carry
`accounting.payments`. Bills, recharge and the digest work without it; **only
bank-file posting fails**. The dry run says so by name.

Fixing it is the single riskiest step in the whole switch, because it means
re-consenting WazzOCR's live grant:

1. Add `accounting.payments` to `XERO_SCOPES` in WazzOCR and deploy it. Scopes
   are additive — nothing WazzOCR has is lost.
2. **Reconnect Xero in WazzOCR**, not here. The new token set supersedes the old
   one the moment consent completes, so WazzOCR must be the app that receives
   and stores it.
3. Re-run the dry run; the scope line turns `ok`.

If you would rather not touch WazzOCR's grant yet, switch anyway and leave bank
files on the `own`-mode instance until you do.

### 7c. Flip it

```bash
XERO_GRANT_SOURCE=wazzocr
WAZZOCR_DB_NAME=wazzocr
APP_ENCRYPTION_KEY=<WazzOCR's, copied>
XERO_CLIENT_ID=<WazzOCR's>
XERO_CLIENT_SECRET=<WazzOCR's>
XERO_TENANT_ALLOWLIST=<start restrictive>
```

Restart, then `npm run sync` and `npm run entities list` — **this is where the 41
real organisations appear.** Fence off what you are not ready for:

```bash
npm run entities only DEMO
```

and paste the allowlist line it prints into `.env`, then restart again. The boot
log must say:

```
[xero] XERO_TENANT_ALLOWLIST is set — writes are limited to 1 organisation(s).
```

If instead it prints the `no XERO_TENANT_ALLOWLIST` banner, the deployment can
write to every live organisation. Fix that before doing anything else.

### 7d. Check the guard before trusting it

Temporarily add a live organisation to `entities`, try to submit one of its
bills, and confirm you get *"This deployment may not write to Xero organisation
…"*. Then exclude it again. A guard nobody has seen fire is not yet a guard.

## Health checks

| Check | Expect |
| --- | --- |
| `curl localhost:3000/api/health` | `{"ok":true,"db":"up","grantSource":"…","grantStore":"up"}` |
| Boot log | no `AUTH_DISABLED` warning block, and no allowlist banner, unless you meant them |
| `npm run db:test` | every table listed |
| `node scripts/preflight.js` | all checks passed |
| `node scripts/smoke.js` | each module ready, or a named blocker |
| `GET /api/xero/status` (signed in) | `connected: true`, the org count, `needsReconnect: 0` |
| `GET /api/xero/verify` (signed in) | `xeroSees` matches what is recorded, `missingLocally` empty |
| `GET /api/bills/sync/status` | every organisation `ok`, with a recent `lastRunAt` |
| `GET /api/payments` | `bankStats` present; `unconfiguredFormats` is 0 |
| `GET /api/digest` | `settings.configured` is true; `nextRun` reads as expected |
| Boot log | `[digest] scheduler checking every 60s` |

`grantStore` anything other than `up` in `wazzocr` mode means the cross-database
GRANT is missing — fix that before debugging anything else.

## Troubleshooting

**`invalid_client`** — `XERO_CLIENT_SECRET` does not match the app's, or the
secret has been rotated in Xero.

**`invalid_scope` on consent** — the app is on granular scopes and `XERO_SCOPES`
still asks for `accounting.transactions`. Use the granular list in section 3.

**"Could not decrypt … refresh token"** — in `wazzocr` mode, `APP_ENCRYPTION_KEY`
was generated instead of copied from WazzOCR. In `own` mode, it changed since you
connected — reconnect.

**`grantStore: unreadable`, or every org fails at once** — the Bills Hub DB user
is missing the GRANT on `wazzocr.xero_grants` / `wazzocr.xero_connections`, or
`WAZZOCR_DB_NAME` names the wrong schema.

**"This account is not linked to a WazzOCR account"** — set the mapping:
`UPDATE billhub.accounts SET wazzocr_account_id = <id> WHERE id = <id>;`

**`cannot start its own` consent (409)** — you are in `wazzocr` mode. That is
deliberate; switch to `own`, or connect in WazzOCR.

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

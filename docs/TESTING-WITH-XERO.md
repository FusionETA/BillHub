# Testing on DigitalOcean against the Xero Demo Company

Everything so far has run against stubbed Xero and Wazzup. This is the walk from
that to a real deployment talking to a real Xero organisation, ordered so that
nothing can touch a live Ayu Borneo organisation by accident.

Read [DEPLOYMENT.md](DEPLOYMENT.md) for the server and database setup itself;
this document is about doing it *safely against real Xero*.

---

## The one risk to understand first

Bills Hub borrows WazzOCR's Xero grant, and that grant covers **all 41
organisations**. A test deployment pointed at it can therefore read — and
without the guards below, write to — every live organisation.

Two independent guards stop that. Use both.

| Guard | What it does | Where |
| --- | --- | --- |
| `XERO_TENANT_ALLOWLIST` | Refuses every Xero **write** outside the list, before the request is built. Reads are unaffected. | env var |
| `entities.included` | Stops an organisation being synced or shown at all. | `npm run entities` |

The allowlist is the one that matters: it holds regardless of what the UI, the
database or a mis-click say. Set it, and the deployment is structurally
incapable of changing a live organisation.

---

## 1. Connect the Demo Company — in WazzOCR, not here

Every Xero user has one Demo Company. Connect it **through WazzOCR**, because
Bills Hub deliberately has no consent flow:

> Xero supersedes the older token set whenever the same user re-authorises the
> same app. A consent started in Bills Hub would invalidate WazzOCR's token and
> stop its live pipeline.

So: open WazzOCR → Connect Xero → authorise, with the Demo Company selected
alongside the organisations already connected. WazzOCR stores the new grant;
Bills Hub reads it on the next call and sees the Demo Company automatically.

**Pick a quiet moment.** The reconnect rotates WazzOCR's refresh token. That is
routine and WazzOCR handles it, but a reconnect while bills are being processed
is worth avoiding. Take a backup first:

```sql
SELECT id, refresh_token FROM wazzocr.xero_grants;
```

## 2. Deploy, pointed at its own database

Follow [DEPLOYMENT.md](DEPLOYMENT.md), but give the test instance a database of
its own — `billhub_demo`, say — on the same cluster as `wazzocr`. Nothing about
a test run then touches the production Bills Hub data.

```sql
CREATE DATABASE billhub_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
GRANT SELECT, UPDATE ON `wazzocr`.`xero_grants`        TO '<user>'@'%';
GRANT SELECT          ON `wazzocr`.`xero_connections`  TO '<user>'@'%';
```

`.env` for the test instance:

```bash
DB_NAME=billhub_demo
WAZZOCR_DB_NAME=wazzocr
APP_ENCRYPTION_KEY=<copied from WazzOCR's .env — not generated>
XERO_CLIENT_ID=<copied from WazzOCR's .env>
XERO_CLIENT_SECRET=<copied from WazzOCR's .env>

# Leave the digest off until the recipients are right.
WAZZUP_CHANNEL_ID=...
WAZZUP_API_KEY=...

# Filled in at step 4.
XERO_TENANT_ALLOWLIST=
```

```bash
npm ci --omit=dev
npm run db:migrate
npm run create-account "Ayu Borneo Group (demo)" you@example.com <wazzocrAccountId>
```

## 3. Preflight

```bash
node scripts/preflight.js
```

Read-only: config, both databases, the cross-database GRANTs, that
`APP_ENCRYPTION_KEY` decrypts WazzOCR's token, and **the entity codes it would
derive from the real organisation names** — worth reading before they are
created.

```bash
node scripts/preflight.js --xero
```

adds one live call to prove the borrowed token works. It rotates WazzOCR's
refresh token, which is routine; do it in the same quiet window as step 1.

## 4. Fence off everything but the Demo Company

```bash
npm start                 # once, so the first sync creates the entity rows
npm run sync              # or press Sync Xero in the UI
npm run entities list
```

Find the Demo Company's code in that list, then:

```bash
npm run entities only DEMO        # exclude all the others
```

It prints the allowlist line to paste into `.env`:

```bash
XERO_TENANT_ALLOWLIST=<the Demo Company's tenant id>
```

Restart. The boot log must now say:

```
[xero] XERO_TENANT_ALLOWLIST is set — writes are limited to 1 organisation(s).
```

**Check the guard before trusting it.** Temporarily include a live organisation,
try to submit one of its bills, and confirm you get *"This deployment may not
write to Xero organisation …"*. Then exclude it again.

## 5. What to test, and what the Demo Company can and cannot show

### Bills — fully testable
Sync, the filters, the counts. Then in the Demo Company: create a draft bill in
Xero, sync, **Submit**, **Approve**, and check Xero shows the status change.

### Bank files — fully testable
`POST /api/payments/sync` mirrors the Demo Company's bank accounts and supplier
bank details. Set a paying account's format, pay an approved bill, download the
file, mark it uploaded, and confirm the **batch payment** appears in Xero under
the bank account.

> Check the generated file against your bank's spec sheet before this ever runs
> for real. `maybank-m2e-csv` ships **unverified** — the exact columns differ per
> customer registration.

### Notifications — fully testable
Add your own number, **Send test message**, then **Send digest now**. Leave the
schedule off until the recipient list is right; `last_sent_for` prevents repeats
but not a digest to the wrong people.

### Recharge — **only partly testable**
A recharge needs **two** organisations: an invoice in the payer and a mirror bill
in the subsidiary. You get one Demo Company per Xero login, so with the Demo
Company alone you can test the rules, the splits and every validation, but not
an actual posting.

To test it end to end, either:

- **Create a second Xero trial organisation** and connect it in WazzOCR, then
  allowlist both. This is the clean option.
- Or allowlist two *real* organisations you are willing to have test documents
  in, and void them in Xero afterwards. The documents are real accounting
  records — Bills Hub will not delete them for you.

You will also need account codes that exist in **both** organisations
(`Account codes` in the Recharge tab). Xero rejects the line otherwise, and the
reason is shown on the recharge.

## 6. Turning it into production

When the demo run is clean:

1. `XERO_TENANT_ALLOWLIST=` — empty, or list the organisations you actually want
   writable.
2. `npm run entities include …` for the real organisations.
3. Point at the production `billhub` database.
4. `AUTH_DISABLED=false`, and create the real logins.
5. Turn the digest on.

## If something looks wrong

| Symptom | Where to look |
| --- | --- |
| `403 … may not write to Xero organisation` | The allowlist is doing its job. Add the tenant id, or you meant a different organisation. |
| `Could not decrypt WazzOCR's Xero refresh token` | `APP_ENCRYPTION_KEY` was generated instead of copied. |
| `wazzocrGrantStore: unreadable` in `/api/health` | The cross-database GRANT is missing. |
| Organisations missing after a sync | `GET /api/bills/entities?all=true` — they may be excluded. |
| `invalid_grant` now and then | Bills Hub and WazzOCR refreshed the shared token at the same moment; it self-heals. See the README. |

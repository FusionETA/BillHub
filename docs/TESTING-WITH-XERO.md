# Testing on DigitalOcean against the Xero Demo Company

Everything so far has run against stubbed Xero and Wazzup. This is the walk from
that to a real deployment talking to a real Xero organisation, ordered so that
nothing can touch a live Ayu Borneo organisation by accident.

Read [DEPLOYMENT.md](DEPLOYMENT.md) for the server and database setup itself;
this document is about doing it *safely against real Xero*.

---

## Do it in two stages

**Stage 1 — your own Xero app.** Create a second app at developer.xero.com just
for Bills Hub, run `XERO_GRANT_SOURCE=own`, and connect the Demo Company through
Bills Hub's own consent. Different client id, different grant: WazzOCR is not
involved at all and cannot be affected. Prove every module here.

**Stage 2 — switch to WazzOCR's grant.** Once it all works, set
`XERO_GRANT_SOURCE=wazzocr` and the 41 real organisations arrive without another
consent. Xero tenant ids belong to the organisation rather than the app
connection, so everything already keyed on them carries over.

Stage 1 is the whole point: nothing you do can reach WazzOCR or a live
organisation, because the app holding the token has never been authorised for
them.

## The risk that appears in stage 2

WazzOCR's grant covers **all 41 organisations**, so from stage 2 onward a
deployment can read — and without the guards below, write to — every live one.

Two independent guards stop that. Use both, from the moment you switch.

| Guard | What it does | Where |
| --- | --- | --- |
| `XERO_TENANT_ALLOWLIST` | Refuses every Xero **write** outside the list, before the request is built. Reads are unaffected. | env var |
| `entities.included` | Stops an organisation being synced or shown at all. | `npm run entities` |

The allowlist is the one that matters: it holds regardless of what the UI, the
database or a mis-click say. Set it, and the deployment is structurally
incapable of changing a live organisation.

---

## 1. Create a Xero app for Bills Hub

At developer.xero.com → **New app**:

| Field | Value |
| --- | --- |
| App name | Bills Hub (test) |
| Company URL | anything of yours |
| Redirect URI | `https://<your-host>/api/xero/callback` |

Generate a secret. You now have a client id and secret **that have nothing to do
with WazzOCR** — authorising this app cannot supersede WazzOCR's token, because
the supersede rule is per Xero user *and app*.

Scopes Bills Hub asks for — one per endpoint it actually calls:

```
openid profile email offline_access
accounting.invoices          GET/POST /Invoices     bills, submit/approve, recharge
accounting.payments          POST /BatchPayments    paying a bank-file batch
accounting.contacts          GET/POST /Contacts     payees, and recharge CREATES
                                                    the counterparty contact
accounting.settings.read     GET /Accounts          bank accounts to pay from
```

> **These must be the granular scopes.** Xero has assigned granular scopes to
> every Web app created since March 2026, and rejects the old broad
> `accounting.transactions` on them with `invalid_scope` — the consent screen
> never even appears. `XERO_SCOPES` can override the default if your app is
> older and still on broad scopes.

## 2. Deploy, pointed at its own database

Follow [DEPLOYMENT.md](DEPLOYMENT.md), but give the test instance a database of
its own — `billhub_demo`, say — on the same cluster as `wazzocr`. Nothing about
a test run then touches the production Bills Hub data.

```sql
CREATE DATABASE billhub_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

`.env` for the test instance — note there is **nothing of WazzOCR's in it**:

```bash
DB_NAME=billhub_demo

XERO_GRANT_SOURCE=own
XERO_CLIENT_ID=<your new app>
XERO_CLIENT_SECRET=<your new app>
XERO_REDIRECT_URI=https://<your-host>/api/xero/callback

# Generate a fresh one; it is yours alone in this mode.
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
APP_ENCRYPTION_KEY=<generated>

# Leave the digest off until the recipients are right.
WAZZUP_CHANNEL_ID=...
WAZZUP_API_KEY=...
```

No cross-database GRANTs are needed in `own` mode, and `wazzocr_account_id` can
stay null.

```bash
npm ci --omit=dev
npm run db:migrate
npm run create-account "Ayu Borneo Group (demo)" you@example.com
```

(No WazzOCR account id — that argument is only for `wazzocr` mode.)

## 3. Connect the Demo Company

Start the app, sign in, and press **Connect Xero** in the header. Authorise with
your Xero login and pick the **Demo Company**.

Every Xero user has one Demo Company; it is a sandbox that resets periodically,
which is exactly what you want for a first run.

```bash
node scripts/preflight.js
```

Read-only. It checks the config and the database, that `APP_ENCRYPTION_KEY`
decrypts the stored token, and **the entity codes it would derive** — worth a
look before they are created. `GET /api/xero/verify` confirms the token reaches
Xero.

## 4. Sync

```bash
npm run sync              # or press Sync Xero in the UI
npm run entities list
```

In `own` mode the only organisation connected is the Demo Company, so there is
nothing to fence off yet — `XERO_TENANT_ALLOWLIST` and
`npm run entities only …` matter from stage 2, when the real organisations
appear.

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

### Recharge — **needs a second organisation**
A recharge posts an invoice in the payer and a mirror bill in the subsidiary, so
it needs **two** organisations. You get one Demo Company per Xero login, so with
the Demo Company alone you can test the rules, the splits and every validation,
but not an actual posting.

In `own` mode the fix is easy: **create a free Xero trial organisation**, connect
it to your Bills Hub app in the same consent, and recharge between the two. Still
nothing to do with WazzOCR.

You will also need account codes that exist in **both** organisations
(`Account codes` in the Recharge tab). Xero rejects the line otherwise, and the
reason is shown on the recharge.

## 6. Stage 2 — switching to WazzOCR's grant

Only once everything above is proven.

> **Add `accounting.payments` to WazzOCR first.** WazzOCR's `XERO_SCOPES` is
> currently
> `openid profile email offline_access accounting.invoices accounting.contacts accounting.settings accounting.attachments`
> — no payments scope, because WazzOCR never creates one. Bills Hub's batch
> payments would fail on the borrowed grant.
>
> Add `accounting.payments` to `XERO_SCOPES` in WazzOCR's `server.js` (or its
> env), deploy, and **reconnect Xero in WazzOCR** so the grant is re-consented
> with the wider scope. Scopes are additive, so nothing WazzOCR already has is
> lost. Bills, recharge and the digest would work without this; only bank-file
> posting needs it.

1. Add the cross-database grants:
   ```sql
   GRANT SELECT, UPDATE ON `wazzocr`.`xero_grants`       TO '<user>'@'%';
   GRANT SELECT          ON `wazzocr`.`xero_connections` TO '<user>'@'%';
   ```
2. Set the WazzOCR account id: `UPDATE accounts SET wazzocr_account_id = <id>;`
3. In `.env`:
   ```bash
   XERO_GRANT_SOURCE=wazzocr
   WAZZOCR_DB_NAME=wazzocr
   APP_ENCRYPTION_KEY=<WazzOCR's, copied>
   XERO_CLIENT_ID=<WazzOCR's>
   XERO_CLIENT_SECRET=<WazzOCR's>
   XERO_TENANT_ALLOWLIST=<start restrictive>
   ```
4. `node scripts/preflight.js` — now checking the GRANTs and that the key
   decrypts WazzOCR's token.
5. `npm run sync`, then `npm run entities list`. **This is where the 41 real
   organisations appear.** Fence off what you are not ready for:
   ```bash
   npm run entities only DEMO
   ```
   and paste the allowlist line it prints into `.env`, then restart. The boot log
   must say:
   ```
   [xero] XERO_TENANT_ALLOWLIST is set — writes are limited to 1 organisation(s).
   ```
6. **Check the guard before trusting it.** Temporarily include a live
   organisation, try to submit one of its bills, and confirm you get *"This
   deployment may not write to Xero organisation …"*. Then exclude it again.

The Xero app from stage 1 can be left alone; it simply stops being used. Revoke
its connection in Xero if you want it gone.

## 7. Turning it into production

1. Widen or empty `XERO_TENANT_ALLOWLIST`.
2. `npm run entities include …` for the real organisations.
3. Point at the production `billhub` database.
4. `AUTH_DISABLED=false`, and create the real logins.
5. Turn the digest on.

## If something looks wrong

| Symptom | Where to look |
| --- | --- |
| `403 … may not write to Xero organisation` | The allowlist is doing its job. Add the tenant id, or you meant a different organisation. |
| `Could not decrypt … refresh token` | In `wazzocr` mode, `APP_ENCRYPTION_KEY` was generated instead of copied from WazzOCR. In `own` mode, it changed since you connected — reconnect. |
| `cannot start its own` consent | You are in `wazzocr` mode. That is deliberate; switch to `own` or connect in WazzOCR. |
| `wazzocrGrantStore: unreadable` in `/api/health` | The cross-database GRANT is missing. |
| Organisations missing after a sync | `GET /api/bills/entities?all=true` — they may be excluded. |
| `invalid_grant` now and then | Bills Hub and WazzOCR refreshed the shared token at the same moment; it self-heals. See the README. |

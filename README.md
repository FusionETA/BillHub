# Bills Hub

Multi-entity bill management on top of Xero, for groups running many
organisations in one Xero account. All four modules are live:

| Module | State |
| --- | --- |
| **Bills** — sync, list, filter, submit, approve | **Done** |
| **Bank files** — payment batches, bank-format files, Xero batch payments | **Done** |
| **Notifications** — the scheduled WhatsApp draft digest | **Done** |
| **Recharge** — intercompany splits, AR/AP pairs, settlement | **Done** |

The stack mirrors [WazzOCR](https://github.com/FusionETA/WazzOCR): Node + Express,
CommonJS, `mysql2` against a DigitalOcean MySQL, models in `models/`, routers
mounted from `server.js`, and Xero refresh tokens encrypted at rest with
AES-256-GCM. `db/index.js`, `lib/crypto.js`, `lib/tokens.js` and `auth/*` are the
same files, so anything learned in one codebase carries over to the other.

Bills Hub has its **own database** on the same MySQL cluster as WazzOCR:

```
DigitalOcean MySQL cluster
├── wazzocr      ← untouched; Bills Hub adds nothing to it
└── billhub      ← every Bills Hub table lives here
```

The one thing that crosses the line is the **Xero grant**, which the two apps
share. See [Xero](#xero) for why that is not optional.

## Layout

```
server.js              Express bootstrap: mounts routers, serves public/, starts the sync
db/
  index.js             Pooled, TLS-verified MySQL + query helpers   (same as WazzOCR)
  schema.sql           Full schema, idempotent — Bills Hub tables only
lib/
  crypto.js            AES-256-GCM for secrets at rest              (same as WazzOCR)
  tokens.js            Random tokens + SHA-256 hashing              (same as WazzOCR)
  bankFile.js          Renders a batch into a bank's layout (layouts are data)
  wazzup.js            Wazzup24 sender + Malaysian phone normalising
  schedule.js          Timezone-aware "is the digest due?" 
  grantSource.js       Which Xero grant this deployment uses, and where it lives
  xero.js              Token rotation under a row lock, rate-limited API client
auth/
  middleware.js        attachUser / requireAuth                     (same as WazzOCR)
  sessions.js          Server-side sessions, hashed in the DB       (same as WazzOCR)
  passwords.js         scrypt hashing, no native dependency         (same as WazzOCR)
  router.js            POST /api/auth/login | logout, GET /me
models/
  accounts.js users.js
  xeroConnections.js   The borrowed grant: reads WazzOCR, rotates the token
  entities.js          Short codes ("ABKK") and names per Xero org
  bills.js             The bill mirror, its filters and its stats
  syncState.js         Per-organisation sync cursors and errors
  bankAccounts.js      Paying accounts, mirrored from Xero's BANK accounts
  bankFormats.js       File layouts, held as data
  payees.js            Supplier bank details
  batches.js           Payment batches and their lines
  digest.js            Digest settings, recipients and the send log
  recharge.js          Recharge settings, rules, runs and their lines
billhub/
  router.js            /api/bills — list, actions, sync
  xeroRouter.js        /api/xero  — status, verify, and the connect guard
  paymentsRouter.js    /api/payments — batches, files, formats, payees
  payments.js          Batch validation, file rendering, Xero batch payments
  digestRouter.js      /api/digest — settings, recipients, preview, send
  digest.js            Builds the message, sends it, and runs the schedule
  rechargeRouter.js    /api/recharge — rules, runs, settlement
  recharge.js          Splits a paid bill and posts both sides into Xero
  sync.js              Pulls ACCPAY invoices from every connected org
  viewModel.js         Formats rows exactly as the UI renders them
public/
  index.html           The Bills Hub app (React via Babel standalone, single file)
  login.html
scripts/               db-migrate, db-test, create-account, sync-bills,
                       entities, preflight, dev-local.sh
test/                  api / sync / grant / openaccess tests, seed.js
```

## Setup

```bash
npm install
cp .env.example .env     # then fill it in — see below
npm run db:migrate
# the third argument is WazzOCR's accounts.id, whose Xero grant this borrows
npm run create-account "Ayu Borneo Group" you@example.com 1
npm start
```

Then sign in and press **Sync Xero**. There is nothing to authorise — Xero is
already connected through WazzOCR.

### Running without sign-in

`AUTH_DISABLED=true` removes the login page entirely: every request runs as the
owner of `DEFAULT_ACCOUNT_ID` (or the only account, if there is one). Handy while
building — `scripts/dev-local.sh` sets it.

It leaves the app **completely open**, and Bills Hub writes to a live Xero, so
anyone who can reach the URL can submit and approve real bills. Two things make
that hard to forget: the server prints a warning block on boot, and the UI shows
a permanent amber banner. `POST /api/auth/login` returns 409 rather than issuing
a session the app would ignore.

The auth code is untouched, so putting sign-in back is one variable:

```bash
AUTH_DISABLED=false
```

Only expose the app on a network you control while this is on.

### Keeping a deployment away from live organisations

Bills Hub borrows a grant covering every connected organisation, so a test
instance can reach all of them. Two independent guards:

| Guard | Effect |
| --- | --- |
| `XERO_TENANT_ALLOWLIST` | Refuses every Xero **write** outside the list, before the request is built. Reads unaffected. |
| `npm run entities only <CODE>` | Stops the other organisations being synced or shown at all. |

The allowlist is the one that matters — it holds regardless of the UI or the
database. The boot log says so when it is set. See
[docs/TESTING-WITH-XERO.md](docs/TESTING-WITH-XERO.md).

### Environment

Every variable is documented in `.env.example`. The ones that need care:

- `APP_ENCRYPTION_KEY` — **copy WazzOCR's value, do not generate a new one.** It
  decrypts WazzOCR's stored Xero refresh token.
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` — the same app as WazzOCR, for the same
  reason. Put the secret straight into `.env` (which is gitignored); it should
  not pass through chat, a ticket or a commit.
- `WAZZOCR_DB_NAME` — WazzOCR's schema on the same cluster (default `wazzocr`).
- `WAZZOCR_URL` — where the UI sends people to connect or reconnect Xero.
- `AUTH_DISABLED` — see above. Defaults to `false`; only turn it on somewhere
  private.
- `XERO_TENANT_ALLOWLIST` — comma-separated tenant ids. When set, Xero writes are
  refused outside the list. Empty means no restriction.

`XERO_REDIRECT_URI` is needed in `own` mode and must match one registered on
that Xero app. In `wazzocr` mode there is no consent, so no redirect URI.

### Scopes

Bills Hub requests one granular scope per endpoint it calls:

| Scope | For |
| --- | --- |
| `accounting.invoices` | `/Invoices` — bills, submit/approve, both sides of a recharge |
| `accounting.payments` | `/BatchPayments` — paying a bank-file batch |
| `accounting.contacts` | `/Contacts` — payee details, and recharge **creates** the counterparty, so not `.read` |
| `accounting.settings.read` | `/Accounts` — the bank accounts to pay from |

Xero assigns **granular** scopes to every Web app created since March 2026 and
rejects the old broad `accounting.transactions` on them with `invalid_scope` —
the consent screen never appears. Override with `XERO_SCOPES` if your app is
older and still on broad scopes.

In `wazzocr` mode the borrowed grant must already carry these. WazzOCR's own
scope list has no `accounting.payments`, so add it there and reconnect before
expecting bank-file posting to work.

## Xero

### Two ways to hold the grant

`XERO_GRANT_SOURCE` decides where Bills Hub's Xero token comes from:

| Mode | What it means |
| --- | --- |
| `own` *(default)* | Bills Hub uses its own Xero app and runs its own consent, storing the grant in its own tables. Self-contained — it needs nothing from WazzOCR and cannot affect it. |
| `wazzocr` | Bills Hub borrows WazzOCR's existing grant by reading `wazzocr.xero_grants`. No second consent, so WazzOCR's token is never superseded, and every organisation arrives at once. |

Xero tenant ids identify the **organisation**, not the app connection, so an
organisation keeps its id across both modes — `entities`, `bills`, batches and
recharges all survive a switch.

The sensible path is `own` first: get a deployment working against a Xero app of
its own, with the Demo Company, where nothing you do can reach WazzOCR. Switch to
`wazzocr` once it is proven and you want the real organisations without another
consent.

### Why `wazzocr` mode exists at all

Xero's own guidance is blunt about this:

> "Access tokens are specific to the Xero user and your App. If the authorisation
> process is repeated for the same combination of Xero user and App, the newly
> issued set of tokens will supersede the previous set."
> — [Managing Tokens and Ids](https://developer.xero.com/documentation/best-practices/data-integrity/managing-tokens)

If Bills Hub ran its own consent **on WazzOCR's app with the same Xero login**,
Xero would supersede WazzOCR's tokens and its live pipeline would start failing
with `invalid_grant`. Reconnecting WazzOCR would then break Bills Hub, and so on.

`wazzocr` mode avoids that by sharing one grant rather than creating a second.
In that mode `GET /api/xero/connect` returns 409 and points at WazzOCR, so the
consent cannot be started here by accident.

A separate Xero app sidesteps the problem entirely, which is what `own` mode is
for — different client id, different grant, no interference.

### What Bills Hub touches in WazzOCR's database (`wazzocr` mode only)

Two existing tables, no schema changes, nothing created or dropped:

| Table | Access | Why |
| --- | --- | --- |
| `wazzocr.xero_grants` | `SELECT`, `UPDATE` | Read the encrypted refresh token; write the rotated one back |
| `wazzocr.xero_connections` | `SELECT` | Which organisations are connected, and their names |

```sql
GRANT SELECT, UPDATE ON `wazzocr`.`xero_grants`       TO '<billhub user>'@'%';
GRANT SELECT          ON `wazzocr`.`xero_connections` TO '<billhub user>'@'%';
```

The `UPDATE` is unavoidable: Xero invalidates a refresh token the moment it is
used, so whoever refreshes must persist the replacement. Bills Hub writes that
one column and nothing else — it never sets `needs_reconnect`, never adds a
connection, never touches a grant row it did not read.

`WAZZOCR_DB_NAME` names the schema (default `wazzocr`), and
`billhub.accounts.wazzocr_account_id` maps a Bills Hub account to the WazzOCR
account whose grant it borrows — ids are not shared between the two databases.

**`APP_ENCRYPTION_KEY` must be the same value WazzOCR uses.** The refresh token is
AES-256-GCM encrypted with it; a different key simply cannot decrypt it. Bills
Hub says so explicitly if decryption fails rather than leaving you with a bare
crypto error.

### Refresh safety

Refresh tokens are single-use, so a double refresh leaves someone holding a spent
token. Two layers guard against it:

- **Within Bills Hub** — callers are coalesced in-process, and the refresh runs
  inside `SELECT … FOR UPDATE` on the grant row, so separate Bills Hub processes
  serialise too. Ten concurrent callers produce exactly one refresh (covered by
  `test/grant.test.js`).
- **Between Bills Hub and WazzOCR** — WazzOCR does not take that lock, so a
  simultaneous refresh is still possible. It self-heals: both apps re-read the
  row before every refresh, Xero honours the previous token for 30 minutes, and
  each app's next refresh picks up whatever is in the row. Adding the same
  `FOR UPDATE` to WazzOCR's refresh path would close the window completely — a
  small change worth making if you ever see `invalid_grant` in the logs.

An access token is valid for **every** organisation under the grant, so it is
cached per grant, not per tenant: one refresh serves all 40 orgs.

### Rate limits

Xero allows 60 calls/minute and 5 concurrent calls per organisation. `lib/xero.js`
enforces a per-tenant minute budget and a global concurrency gate, retries 429s
using `Retry-After`, and refreshes once on a 401. Tune with `XERO_CALLS_PER_MIN`
and `XERO_MAX_CONCURRENT`.

## Going live against real Xero

Everything shipped so far runs against stubbed Xero responses. Before the first
real sync:

```bash
node scripts/preflight.js
```

Read-only and safe to point at production: it checks the config, both databases,
the cross-database GRANTs (proving `UPDATE` with a no-op inside a rolled-back
transaction), that `APP_ENCRYPTION_KEY` actually decrypts WazzOCR's token, the
account mapping, and prints the entity codes it would derive from the real
organisation names — so you can correct any that look wrong before they are
created.

```bash
node scripts/preflight.js --xero
```

adds one live call: refresh the shared grant, then `/connections`. That
**rotates WazzOCR's refresh token** — routine, and the new one is written back,
but run it when nobody is pushing bills through WazzOCR, and take a backup first:

```sql
SELECT id, refresh_token FROM wazzocr.xero_grants;
```

Then sync one organisation before all of them, so a surprise in Xero's response
shape costs one org and not forty.

For a full walkthrough of deploying and testing against the Xero Demo Company
without any risk to the live organisations, see
[docs/TESTING-WITH-XERO.md](docs/TESTING-WITH-XERO.md), and
[docs/TEST-PLAN.md](docs/TEST-PLAN.md) for what to exercise module by module.

```bash
npm run smoke
```

is a read-only readiness check: it proves each Xero scope by calling the
endpoint, counts what is synced, and says what is blocking each module.

## The bill sync

`billhub/sync.js` pulls `Type=="ACCPAY"` invoices from every connected
organisation into the `bills` table, `summaryOnly` (no line items — the list does
not show them, and it is far cheaper against the rate limit).

Each organisation keeps a cursor: the newest `UpdatedDateUTC` it has seen. The
next run sends that back as `If-Modified-Since`, **rewound by one minute**, because
Xero's timestamps carry sub-second precision and the header is exclusive — an
exact cursor can silently drop a bill updated in the same second as the last one
read. A 304 means nothing changed.

A failure is isolated to its organisation: the other 39 finish, the error is
recorded in `bill_sync_state`, and the cursor is left untouched so the next run
retries the same window rather than skipping it. A 401 also flags the connection
as needing reconnection.

The scheduler runs every `SYNC_INTERVAL_MINUTES` (default 15). Set it to `0` and
drive it from cron instead:

```bash
node scripts/sync-bills.js          # incremental, all accounts
node scripts/sync-bills.js --full   # ignore cursors, re-read everything
```

## Bank files

Paying bills creates a **batch**: a set of bills paid together from one bank
account. A batch maps onto a Xero **BatchPayment** (`PAYBATCH`), which is what
constrains its shape — Xero's API only accepts a batch inside one organisation,
in that organisation's base currency, containing bills and nothing else. Those
rules are checked when the batch is built rather than discovered when Xero
rejects it, along with: the bill is approved and still owing, and it isn't
already sitting in another live batch.

### The lifecycle, and when Xero is written to

```
Bills → Pay selected → ready → download → upload to the bank portal → mark uploaded
                                                                          ↓
                                                            Xero BatchPayment created
```

**Xero is not touched until you mark the batch uploaded.** That is the point at
which the money has actually left; posting at batch creation would show bills as
paid while the file still sat on someone's desktop. For a bill paid some other
way, `Already paid — just record it` skips the file and posts to Xero
immediately.

Posting is idempotent: once a batch carries a `BatchPaymentID` a second attempt
is refused, so a retry after a timeout cannot pay twice. A batch that has
reached Xero cannot be cancelled — reversing a payment is a Xero operation. A
batch that hasn't can be, which releases its bills for another run.

### Bank file layouts are data, not code

Every bank wants something different, and Maybank alone issues both CSV and
pipe-delimited variants depending on what the customer registered for. So a
layout is a row in `bank_formats`: delimiter, extension, line ending, an ordered
list of columns each with a field, transform, length and padding, plus optional
header and trailer records. Correcting one is an edit through
`PUT /api/payments/formats/:key`, never a deploy.

Two are shipped:

| Key | Verified | What it is |
| --- | --- | --- |
| `generic-csv` | yes | Readable, quoted CSV. Our own layout, so there is no external spec to be wrong about. A good base to copy. |
| `maybank-m2e-csv` | **no** | A starter shape for a Maybank bulk upload. |

**An unverified layout is flagged everywhere it appears** — in the pay dialog, on
the batch card, and in the API — because a wrong column order does not fail
safely: the bank may reject the file, or pay the wrong account. Check the output
against the spec sheet your bank gave you, send a single-line test payment, then
set `verified: true`. Editing any layout clears that flag automatically, so an
edited file can never inherit someone else's sign-off.

Fields a column can use: `seq`, `payeeName`, `payeeAccount`, `payeeBank`,
`amount`, `amountCents`, `reference`, `paymentDate`, `batchRef`, `payerName`,
`payerAccount`, `currency`, `total`, `totalCents`, `count`. Transforms: `safe`
(strips punctuation banks reject), `digits`, `upper`, `lower`, `trim`.

### Payee bank details

Xero keeps these as free text on the contact (`Contact.BankAccountDetails`), so
they are often blank or typed by hand. `POST /api/payments/sync` pulls them in
alongside the bank accounts; a value corrected through the API is marked
`manual` and a re-sync leaves it alone. A batch line with no account number is
flagged in the preview, on the card and in the generated file's warnings —
the bank will reject that row.

## Notifications

A WhatsApp digest of draft bills, sent through Wazzup24 on a schedule. Each
recipient gets the same message **scoped to the organisations they are
responsible for** — a branch accountant sees their own drafts, a director sees
the group. The figures come from the same queries the Bills screen uses, so the
digest can never disagree with the hub.

```
*Bills Hub · Draft bills*
Tue 22 Sep 2026, 09:00
Ayu Borneo Group · 40 Xero entities

Draft bills to clear: *11* across 7 entities
Total value: *RM 37,480.40*

• Ayu Borneo (KJ) — 3 bills · RM 28,539.00
• Ayu Borneo (KCH) — 1 bill · RM 2,216.80
…and 4 more entities

Oldest draft: 28 Aug 2026 · Ayu Borneo (SDK)

Open the queue: https://billhub.fusioneta.com.my
```

### Scheduling

Daily (optionally skipping weekends), weekly on a chosen day, or monthly on a
chosen date — `0` meaning the last day, and a 31st clamping to the 28th in
February rather than being skipped. The send time is **local wall-clock in the
account's timezone**, so 09:00 MYT stays 09:00 wherever the server runs; nothing
depends on the host's `TZ` and there is no timezone library to keep current.

Two guards worth knowing about:

- **No double sends.** `digest_settings.last_sent_for` holds the local date
  already sent and is written *before* the messages go out, so a restart, a slow
  run or an overlapping tick cannot send the same digest twice.
- **No surprise late sends.** A window missed by more than six hours is skipped.
  If the server was down all morning, a 09:00 digest arriving at 21:00 is worse
  than none.

### Sending

Bills Hub uses **its own Wazzup channel**, which is safe — unlike the Xero grant,
a Wazzup channel is not a single-use credential, so it does not interfere with
WazzOCR. The API key is AES-256-GCM encrypted at rest and is never returned by
the API; `/api/digest` reports only `hasApiKey`.

A recipient whose message fails is logged and the run continues — one bad number
cannot stop the rest. Recipients with nothing in their scope are skipped rather
than sent an empty digest, unless *"send even when there are no draft bills"* is
on. Every attempt is recorded in `digest_runs` **with the exact text**, so
"what did finance actually receive on Tuesday?" has an answer.

`POST /api/digest/test` sends one message to one number to check the channel.
`POST /api/digest/send` sends the real digest immediately without touching
`last_sent_for`, so the scheduled run still happens.

Phone numbers are stored and sent as digits with the country code
(`60123456789`); a number typed as `012-345 6789` gains the `60` automatically.

## Recharge

When one entity pays a bill on behalf of another, the cost is pushed across as a
matched pair of documents per subsidiary:

| Where | Document | Status |
| --- | --- | --- |
| The payer | AR invoice (`ACCREC`) addressed to the subsidiary | `AUTHORISED` |
| The subsidiary | Mirror bill (`ACCPAY`) from the payer | `DRAFT` |

They carry the same amount and the same reference, so the group nets to zero and
each side reconciles its own ledger. The subsidiary's bill is left as a draft on
purpose — it then goes through the normal Bills approval flow rather than a
payable appearing already authorised.

### Rules only suggest

A rule says *"bills from this supplier, paid by this entity, belong to those
entities"* — matched on the supplier name, optionally narrowed to references
containing some text. Shares must add up to 100%, checked when the rule is saved
rather than when a recharge is posted.

Rules never post anything. They surface **paid bills a rule covers that have not
been recharged**, with the split already worked out; a person drafts and posts.

### Nothing reaches Xero until you post

`POST /api/recharge/runs` works the split out locally and stops. `…/post`
creates the documents. Each id is saved the moment Xero returns it, so a failure
halfway leaves an exact record: the run stays `draft`, the line records which
side succeeded and why the other did not, and **a retry creates only what is
missing** — never a duplicate of what already exists. A run that has reached
Xero cannot be cancelled here; voiding real accounting documents belongs in Xero.

### The arithmetic

Percentage splits go through `splitAmount`, which works in cents and gives the
rounding difference to the last share, so the parts always sum to the whole —
1,276.40 split three ways is 425.47 / 425.47 / 425.46, never 425.46 × 3.

### Account codes

A recharge needs a receivable code in the payer and an expense code in the
subsidiary. Those differ per chart of accounts, so they are configuration and a
recharge is refused until they are set — the same reasoning as the bank file
layouts. Counterparty contacts are found by name in each Xero and created if
missing.

## Status mapping

Xero's statuses map to the four tabs the UI shows. `AUTHORISED` splits on the
outstanding balance, because Xero leaves a part-paid bill `AUTHORISED` and only
flips it to `PAID` once nothing is due.

| Xero | Bills Hub | Row action |
| --- | --- | --- |
| `DRAFT` | Draft | Submit |
| `SUBMITTED` | Awaiting approval | Approve |
| `AUTHORISED`, amount due > 0 | Awaiting payment | Pay (creates a batch) |
| `AUTHORISED` with nothing due, or `PAID` | Paid | — |
| `VOIDED`, `DELETED` | hidden from lists and totals | — |

"Overdue" is a slice of *awaiting payment* whose due date has passed, not a
separate status — which is why the overdue card can equal the awaiting-payment
card.

**Xero stays the source of truth.** A status change is pushed to Xero first and
mirrored locally only once Xero has accepted it. A bulk action attempts each bill
independently, so one rejection does not strand the rest, and the response names
which bills failed and why.

## API

All endpoints are cookie-authenticated and scoped to the signed-in user's account.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` `/logout` | Sign in / out (409 when `AUTH_DISABLED`) |
| `GET` | `/api/auth/me` | Current user and account |
| `GET` | `/api/xero/status` | The borrowed grant's health and the orgs it covers |
| `GET` | `/api/xero/verify` | Ask Xero which orgs the token can actually reach |
| `GET` | `/api/xero/connect` | Start a consent (`own`), or 409 pointing at WazzOCR |
| `GET` | `/api/xero/callback` | Store the grant and its organisations (`own`) |
| `GET` | `/api/bills` | The whole view model: stats, tabs, rows, meta, banner |
| `GET` | `/api/bills/entities` | Connected organisations (`?all=true` includes excluded) |
| `PATCH` | `/api/bills/entities/:tenantId` | Rename a code, or include/exclude an organisation |
| `GET` | `/api/bills/contacts` | Distinct suppliers, for the filter |
| `GET` | `/api/bills/:id` | One bill, with its Xero line items |
| `POST` | `/api/bills/:id/submit` `/approve` | Push a status change to Xero |
| `POST` | `/api/bills/bulk` | The same actions over a selection |
| `POST` | `/api/bills/sync` | Pull from Xero now (`{ "full": true }` to rebuild) |
| `GET` | `/api/bills/sync/status` | Per-organisation sync state |
| `GET` | `/api/payments` | The Bank files view model |
| `POST` | `/api/payments/sync` | Pull bank accounts + payee details from Xero |
| `POST` | `/api/payments/preview` | Dry-run a batch: totals, warnings, sample file |
| `POST` | `/api/payments/batches` | Create a batch (`generateFile: false` to just record it) |
| `GET` | `/api/payments/batches/:id/file` | Download the file (marks it downloaded) |
| `POST` | `/api/payments/batches/:id/uploaded` | Confirm sent — posts the Xero batch payment |
| `POST` | `/api/payments/batches/:id/cancel` | Abandon an unposted batch |
| `GET`/`PATCH` | `/api/payments/bank-accounts[/:id]` | Paying accounts and their layouts |
| `GET`/`PUT`/`DELETE` | `/api/payments/formats[/:key]` | File layouts |
| `GET`/`PUT` | `/api/payments/payees[/:tenantId/:contactId]` | Supplier bank details |
| `GET` | `/api/digest` | Settings, recipients, preview and recent sends |
| `PATCH` | `/api/digest/settings` | Schedule, content and channel |
| `GET` | `/api/digest/preview` | The message (`?recipientId=` to scope it) |
| `POST` | `/api/digest/test` | One message to one number |
| `POST` | `/api/digest/send` | Send the real digest now |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/digest/recipients[/:id]` | Recipients and their entities |
| `GET` | `/api/digest/runs` | The send log |
| `GET` | `/api/recharge` | The Recharge view model |
| `GET` | `/api/recharge/suggestions` | Paid bills a rule covers, not yet recharged |
| `PATCH` | `/api/recharge/settings` | Account codes, tax type, reference prefix |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/recharge/rules[/:id]` | Rules and their splits |
| `POST` | `/api/recharge/plan` | Dry-run a recharge |
| `POST` | `/api/recharge/runs` | Create one (nothing in Xero yet) |
| `POST` | `/api/recharge/runs/:id/post` | Create the AR/AP pairs in Xero |
| `POST` | `/api/recharge/runs/:id/cancel` | Abandon an unposted recharge |
| `POST` | `/api/recharge/runs/:id/lines/:lineId/settle` | Record the intercompany transfer |
| `GET` | `/api/health` | Liveness + database check |

`GET /api/bills` accepts `status`, `entities` (comma-separated tenant ids),
`contact`, `q`, `dateType` (`bill`/`due`/`paid`), `dateFrom`, `dateTo`,
`amountFrom`, `amountTo`, `limit`, `offset`. The amount range applies to the bill
total, not the outstanding balance.

### Status codes

`401` always means the **app session** has gone, and the client redirects to the
sign-in page. A **Xero** authorisation problem returns `424` with
`needsXeroReconnect: true`, so the user is told to reconnect Xero instead of
being logged out of something they are still signed in to. With `AUTH_DISABLED`
the server never returns `401` at all.

## Tests

The suites run against a real MySQL with a stubbed Xero, so the SQL, the
formatting and the Xero request shapes are all exercised.

```bash
npm run db:migrate
npm run create-account "Test Group" test@example.com 7
npm run test:seed      # also creates a stand-in wazzocr schema with a grant
npm test
```

Or, for a throwaway stack in one command (scratch MariaDB, schema, demo bills,
server, no sign-in):

```bash
./scripts/dev-local.sh
```

- `api.test.js` — auth, every filter, single and bulk actions, the transition
  guards, account scoping, and that Bills Hub adds nothing to WazzOCR's database.
- `sync.test.js` — pagination, the cursor, 304s, upsert deduplication,
  per-organisation error isolation, and that a failing org is not mutated in
  WazzOCR.
- `grant.test.js` — the shared grant: rotation written back, per-grant caching,
  ten concurrent callers causing exactly one refresh, clean hand-off between
  refreshes, and a failed refresh leaving WazzOCR's token untouched.
- `payments.test.js` — bank files end to end: every validation refusal, the
  rendered file, the download/upload lifecycle, the exact BatchPayment body sent
  to Xero, double-post and cancel guards, and that a Xero rejection leaves the
  batch unposted and the bill balances untouched.
- `digest.test.js` — notifications: the schedule maths (timezones, weekends,
  month-end, the double-send and missed-window guards), phone normalising,
  per-recipient scoping, the message itself, and sending — including that one
  bad number does not stop the rest and the key is never returned.
- `recharge.test.js` — intercompany: the split arithmetic, every validation
  refusal, both sides of the posting with their account codes and statuses
  asserted, idempotent re-posting, a half-failed line retrying only what is
  missing, settlement, rules and suggestions.
- `ownmode.test.js` — `XERO_GRANT_SOURCE=own`: the consent round trip, a signed
  state that rejects tampering, the token encrypted at rest in Bills Hub's own
  tables, and WazzOCR's schema left alone.
- `safety.test.js` — the two guards: the write allowlist refusing before any
  network call, and excluding an organisation from the sync and the lists.
- `openaccess.test.js` — `AUTH_DISABLED`: requests work with no cookie, `/me`
  reports the mode, login is refused rather than issuing a dead session, and no
  stray user row is created.

Each suite reseeds its fixtures first, so they are order-independent and can be
re-run without a wipe. **They run against their own database** (`billhub_suite`,
override with `BILLHUB_TEST_DB`) and the seed refuses outright if it finds bills
from a real Xero organisation — seeding wipes `bills` and `entities`, and doing
that to somebody's working instance is a silent, expensive mistake.

```bash
npm run db:migrate:test   # once
npm test
```

All but the last pin `AUTH_DISABLED=false` so they exercise the real sign-in
path whatever your local `.env` says.

For a throwaway local database, `DB_SSL=disable` skips the CA requirement. It is
ignored when `NODE_ENV=production`, so it cannot downgrade the live connection.

## The UI

`public/index.html` is a single file: React 18 and Babel standalone from a CDN,
with the design tokens as CSS custom properties. The Bills view reads everything
entirely from the API — `/api/bills`, `/api/payments`, `/api/digest` and
`/api/recharge`. The prototype's static `window.VM` object is gone; the original
mock-up is kept at `docs/bills-hub-prototype.html` for reference.

Formatting (money, dates, status colours, the summary strings) lives in
`billhub/viewModel.js` on the server, so the figures on screen, in the coming
WhatsApp digest and in an export cannot drift apart.

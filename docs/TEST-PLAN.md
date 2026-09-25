# Testing Bills Hub against a real Xero organisation

Work through this in order — each module leaves the data the next one needs.
Run `npm run smoke` at any point to see where you are.

```bash
npm run smoke
```

Read-only: it proves each Xero scope by calling the endpoint, counts what is
synced, and lists what is blocking each module. Safe against production.

---

## Before you start

**Keep the suite off your working database.** `npm test` seeds fixtures, which
means wiping bills and entities. The tests now run against `billhub_suite` and
the seed refuses outright if it finds real Xero data, but it is worth knowing
why rather than being surprised by it.

```bash
npm run db:migrate:test    # once, to create the suite's database
npm test                   # never touches your working data
```

**The organisations panel** is the header badge — click it to see every
connected organisation, its base currency, and which ones Bills Hub is using.
Codes are editable there, and switching one off keeps a test deployment away
from organisations you are not ready for.

**Currency looks after itself.** Each organisation's base currency is read from
Xero on the first sync, so a USD demo company shows USD and a Malaysian one
shows RM without any configuration. Connect both and the Bills screen drops the
symbol and warns you, rather than adding MYR to USD under one label.

---

## 1. Bills

**Set up** — either make bills by hand in Xero (Business → Bills to pay → New
bill), or generate a spread of them:

```bash
npm run demo-bills                      # lists the organisations
npm run demo-bills -- --tenant DCGLOBAL # creates 12 drafts
```

Twelve drafts across six suppliers, amounts from 129.95 to 7,400, and four
already past their due date so the Overdue card has something in it. Repeat
suppliers, so the contact filter and the recharge rules have something to match.

It refuses any organisation that does not look like a demo or trial company
unless you pass `--force` — these are real Xero documents.

**Then in Bills Hub**

| Do | Expect |
| --- | --- |
| Press **Sync Xero** | The drafts appear; the count on the Draft tab goes up |
| Check the stat cards | Draft total matches the sum of those bills |
| Tick a draft → **Submit for approval** | Status becomes *Awaiting approval*. **Check Xero**: the bill is now Submitted |
| Tick it → **Approve** | Status becomes *Awaiting payment*. In Xero it is Authorised |
| Try to submit the same bill twice | Refused — "is submitted in Xero, so it cannot be submitted" |
| Filter by entity, contact, a reference, a date range, an amount range | The count and the outstanding total both follow the filter |
| **Export** | CSV of exactly what is on screen, not the whole table |

**What this proves:** the sync, the status mapping, and that writes reach Xero.

---

## 2. Bank files

**Prerequisite:** at least one *approved, unpaid* bill from step 1.

**Set up** — press **Sync accounts & payees** in the Bank files tab. That mirrors
the organisation's bank accounts and its suppliers' bank details.

Some suppliers will have no bank account number — Xero keeps that as free text
and the Demo Company mostly leaves it blank. Fill one in:
`PUT /api/payments/payees/<tenantId>/<contactId>` with `{"accountNumber":"1234567890"}`,
or set it on the contact in Xero and re-sync.

| Do | Expect |
| --- | --- |
| Bills tab → tick an approved bill → **Pay selected** | The dialog shows the batch reference, total and the file it would produce |
| **Check the file** | The actual rows. Compare against your bank's spec sheet |
| Note the **Layout unverified** tag | Expected — `maybank-m2e-csv` ships unverified on purpose |
| **Create payment file** | Lands on Bank files with the batch *Ready to download*. **Nothing has changed in Xero yet** — confirm the bill is still Authorised there |
| **Download file** | The file downloads; the batch becomes *Downloaded* |
| **Mark uploaded** | **Now** Xero is written. Check Xero: a batch payment against the bank account, and the bill is Paid |
| Press **Mark uploaded** again | Refused — already recorded |

**What this proves:** the file layout, and that Xero is only written when the
money has actually gone.

> If a column is wrong for your bank, fix the layout — it is data, not code:
> `PUT /api/payments/formats/<key>` with a new `columns` array. Then download
> again. Send a single-line test payment before a real run.

---

## 3. Notifications

**Set up** — Notifications tab. Add yourself as a recipient with your own
WhatsApp number.

| Do | Expect |
| --- | --- |
| Look at **Message preview** | Real figures, matching the Bills screen |
| Add a second recipient, **Assign** them one entity | The preview, switched to them, is scoped to that entity |
| **Send digest now** | Each recipient gets their own scoped message |
| Clear every draft bill, then send again | They are *skipped*, not sent an empty digest |
| Turn on **Send even when there are no draft bills**, send again | Now they get "No draft bills waiting" |
| Set the schedule and switch the digest **on** | `npm run smoke` says the schedule is on; the next run fires at that local time |

> **Turn the schedule off again when you finish testing**, or leave only real
> numbers on it. It sends through your live Wazzup channel.

**What this proves:** the message, per-recipient scoping, and the send path.

---

## 4. Recharge

**Prerequisite: a second organisation.** A recharge posts an invoice in the payer
*and* a mirror bill in the subsidiary, so one Demo Company cannot exercise it.

Create a free Xero trial organisation, then press the Xero badge in the header to
run the consent again and select both. Your app allows 5 connections.

**Set up** — Recharge tab → **Account codes**. Pick a receivable code for the
payer and an expense code for the subsidiary. They must exist in **both**
organisations, or Xero rejects that line.

| Do | Expect |
| --- | --- |
| Pay a bill in the payer so it is *Paid* | Needed — an unpaid bill cannot be recharged |
| **New rule**: that supplier, paid by the payer, 100% to the subsidiary | Saved. A share that does not total 100% is refused |
| Look at the Recharge runs tab | The paid bill is suggested, with the split worked out |
| **Draft recharge** | A run appears as *Not posted yet*. **Nothing in Xero yet** |
| **Post to Xero** | Two documents. **Check Xero**: an authorised invoice in the payer, a draft bill in the subsidiary, same amount and reference |
| **Post to Xero** again | Nothing new is created |
| **Mark settled** with a transfer reference | The line shows Settled; when every line is, the run is *Fully settled* |
| Try a split across two subsidiaries, 60/40 | The parts sum to the bill exactly, to the cent |

**What this proves:** the two-sided posting, idempotency, and the split
arithmetic.

---

## When you are done

```bash
npm run smoke        # should be all green
```

Then, before this becomes production:

1. Turn the digest schedule **off** until the real recipients are in.
2. `AUTH_DISABLED=false`, and create the real logins.
3. Decide on the grant source — see
   [TESTING-WITH-XERO.md](TESTING-WITH-XERO.md) for switching to WazzOCR's.
4. Verify the bank layout against a real spec sheet and set `verified: true`.

## Things that will trip you up

| Symptom | Cause |
| --- | --- |
| Bills vanish after running tests | The seed wiped them. It now refuses when it sees real data — use `billhub_suite` for the suite. |
| `invalid_scope` on connect | The app is on granular scopes; the broad `accounting.transactions` is rejected. |
| Figures show "RM" against USD | `accounts.base_currency` — set it to the organisation's. |
| A payment line is blank in the file | That payee has no bank account number. |
| A recharge line fails | The account code does not exist in that organisation. |
| Demo Company data resets | Xero resets it periodically. Re-sync. |

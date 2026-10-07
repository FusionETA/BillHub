# Things that have actually gone wrong

Each of these cost real time or reached a deployment. They are written down
because none of them is obvious in advance and most are invisible until a bank
refuses a file.

## Contents

- [Reading the bank's file](#reading-the-banks-file)
- [The bank's tool is the deliverable](#the-banks-tool-is-the-deliverable)
- [Bank codes](#bank-codes)
- [Writing the file](#writing-the-file)
- [Field limits](#field-limits)
- [Shipping it](#shipping-it)
- [The Xero data behind it](#the-xero-data-behind-it)

---

## Reading the bank's file

### The column rule describes the output, not the cell

CIMB's BNM Code column is headed `Length: 2 (Num Only)`. Their own filled rows
hold `35-CIMB Bank Berhad`. The rule describes what their converter writes into
the `.txt` it produces; the cell holds the dropdown entry. Following the rule
produced a bare `35` and a file that was wrong in a way nobody would have
spotted until the bank processed it.

**Read the sample rows. When they disagree with the rules, the samples win.**

### Header rows vary and nothing announces them

Hong Leong: one row of field names. CIMB: three rows — column widths, length
rules, then field names — with the first hidden. A numeric-looking first row is
not necessarily data. Detect the row of field labels and count everything above
it.

### The workbook is often encrypted

`xlrd` raises "Workbook is encrypted". The key is almost always
`VelvetSweatshop`, Excel's published default for a read-only-recommended
workbook. It is a write-protection marker rather than a password anyone chose.
`msoffcrypto-tool` opens it without asking anybody for anything.

### .xls cannot be filled

An `.xls` is an OLE2 compound document; `lib/xlsx.js` reads ZIPs. A bank's
`.xls` has to be re-saved as `.xlsx` or `.xlsm` before it can be used as a
template. Say so plainly in the missing-template message, because "template
missing" is not something anybody can act on.

---

## The bank's tool is the deliverable

Some banks ship a converter rather than a form. CIMB's BizConverter is a
Windows application plus an eighteen-sheet workbook: you fill a sheet, run the
application, upload the `.txt` it makes. Its CompanyInfo page is compulsory and
its biller lists are looked up.

Handing over a single extracted sheet produces something the converter cannot
read. What it wants is **its own workbook with the payments written in**.

That workbook cannot be committed. It is the bank's licensed software, it is
large, and a customer's copy carries their company details and often live
payroll rows. It belongs in `templates/local/`, which git ignores, supplied per
deployment — and it will not survive a rebuild, so say so.

### Fill one sheet, leave everything else

`fillTemplate(buffer, rows, { sheetName })` resolves the sheet through
`xl/workbook.xml` and the workbook rels, because sheet order and file numbering
need not agree — in BizConverter they do not. Every other part is copied byte
for byte.

Two details that are easy to miss:

- **Drop `xl/calcChain.xml`.** A stale calcChain against changed cells makes
  Excel declare the workbook corrupt. Removing it just makes Excel rebuild it.
- **Write the sheets you are not using.** A template may arrive with the bank's
  sample rows still in another module. Filling that sheet with nothing is what
  clears it — otherwise somebody converts a module nobody filled.

### Macro-enabled and plain are different formats

CIMB's converter accepts `.xlsx` and refuses `.xlsm`, while the workbook a
customer has is the macro one. Three things make a workbook macro-enabled and
all three have to go together: `xl/vbaProject.bin`, the `Default Extension="bin"`
content type and the `macroEnabled.main+xml` override, and the workbook
relationship to the VBA project. Leaving any one behind gives Excel a file
promising a macro project it cannot find.

`stripMacros()` in `lib/xlsx.js` does this. Accept either extension on disk and
produce what the bank wants.

---

## Bank codes

### Each scheme is its own table

Hong Leong publishes four-character codes under three schemes that disagree
with each other. CIMB publishes BNM's two-digit codes and lists 33 IBG
participants against Hong Leong's 113. A bank payable from one is not
necessarily payable from the other, and that is correct, not a bug — say so in
the warning rather than letting it read as a gap.

### A near match is a different bank

`AMB` reads as AmBank and is the published Hong Leong code for **Alliance
Investment Bank**. Alliance Investment Bank is not Alliance Bank. Hong Leong
Investment Bank is not Hong Leong Bank. An Islamic subsidiary is not its
parent — each has its own code in the bank's own sheets, which is the evidence
that merging them is wrong.

Resolve only exact matches and documented trading-name aliases (Maybank is
Malayan Banking). Everything else resolves to nothing and warns. A wrong code
produces a file that looks completely valid and pays a different bank.

### Name the bank the warning is about

A warning that said "not a bank Hong Leong lists" on a run paid from CIMB sent
whoever read it to check the wrong list. Use the format's own `bank_name`.

---

## Writing the file

### Reproduce the form, do not approximate it

Fills, font colours, bold, borders, wrap, row heights, hidden rows, column
widths, and the data rows' **number formats**. The last one matters most: a
column formatted as `@` is how the bank stops Excel rewriting a long account
number as `5.12089E+11` when somebody opens and saves the file. That failure
turns a payment into nothing.

A filled sheet that looks different from the blank one is a sheet somebody has
to check before trusting.

### A ZIP can verify and still be broken

Rewriting a part by hand produced two empty files inside an otherwise perfect
workbook. `unzip -t` passed, CRCs matched, Python read it — the entries were
internally consistent and empty. Only parsing every XML part caught it.

An entry in `lib/xlsx.js` holds **compressed** bytes alongside its CRC and
sizes, so a rewritten part goes back through `replaceEntry` rather than being
hand-built.

### The dimension must cover the header

`<dimension>` computed from the data rows alone claimed `A1:I3` on a
fifteen-column sheet. Some readers take that literally and stop at the last
column it names.

---

## Field limits

### The portal enforces, the spec suggests

Hong Leong's portal refused an upload with "Line 2: Reference 2 field must not
exceed 20 characters". The layout said 30, which was a guess. Treat a limit as
unverified until a portal has either accepted or rejected it, and keep
`verified: 0` until then.

### Which end to truncate

A narrative is `entity · premises · supplier · period`, and the period is last.
Cutting at the limit removes the one part that says which month's bill this is,
while keeping premises that the account number already identifies. Assemble to
fit instead, and let the longest, least identifying part give way.

### Cut on a word boundary

`MA 49 49-1 49-2` cut at seven characters gives `MA 49 4`. That does not read
as a shortened premises, it reads as a different one, and the first thing
anyone asks is where the stray digit came from. `MA 49` is shorter and true.

### Identical lines are a hazard worth reporting

Four monthly bills can share a biller, an account, a reference and an amount
and still be four real payments. They also look exactly like duplicates, and
somebody tidying up the "extra" rows at the portal leaves a supplier unpaid.
Report them, name the lines, and say what would make them distinct.

---

## Shipping it

### Built-in layouts must update, not just insert

`seedBuiltIns()` originally skipped any layout already in the table, so a
layout was frozen at whatever it looked like the first time a database saw it.
Every correction since reached new databases and no existing one, silently — a
limit was changed from 30 to 20, deployed, and the next file was still built to
30.

It rewrites the shipped rows on every boot now. A layout a customer has
adjusted is stored against their account id and is left alone.

### And must actually insert

The opposite failure, found by a deployment: the INSERT listed seventeen
columns against sixteen values after a new column was added. Nothing caught it
because every test database already had every layout, so seeding always took
the update path. **Test the insert path by deleting a built-in row and
re-seeding.**

### The filename must match the content

A batch is named when it is created, from its layout. If the template is
missing and the renderer falls back, the content is no longer what the name
says — and Excel refuses a `.xlsx` called `.xlsm` with "the file format or file
extension is not valid". Name the download for what was produced, and set the
content type from that name; a macro-enabled workbook has its own type.

---

## The Xero data behind it

On every bank so far this has been the real blocker. Xero's contact field is
labelled **Bank account name**, and across one client's 2,212 payees it held at
least five different kinds of thing:

| What it held | Example | What it needs |
| --- | --- | --- |
| A bank name | `Public Bank Berhad` | nothing — this is the one that works |
| A house abbreviation | `PBB`, `ALB`, `AMB` | confirmation of each, one by one |
| A SWIFT/BIC code | `PBBEMYKL` | a BIC mapping |
| A premises code | `JS Hostel 11-A` | the biller code moved up from Details |
| The account holder's name | `Analin Binti Abdusali` | a bank, from somewhere |

`npm run bank-names` groups these by what is wrong with each, which turns a
vague complaint into a worklist. `npm run ready-to-pay` says which bills would
produce a usable line today, judged against the paying bank's own code table.

Two things worth knowing about correcting it:

- **Xero's API silently drops most of the Financial details block.** It accepts
  a Contact's `BatchPayments` and keeps only `BankAccountNumber`; the name,
  details and code read back empty. Typing them into Xero's UI works. A seeding
  script therefore cannot rely on Xero to hold them.
- **Writing a payee field in Bills Hub freezes that row against sync.**
  `setManual` sets `source='manual'`, which stops a later sync updating
  `bank_account_name` and `details` — the very fields somebody may be about to
  correct in Xero. Prefer a name-keyed mapping resolved at render time
  (`lib/payeeCodes.js` is the pattern) over writing to payee rows.

Say the number out loud early. A correct layout over a payee file that is 30%
usable is not a working integration, and the person who can fix the second part
is usually not the person who asked for the first.

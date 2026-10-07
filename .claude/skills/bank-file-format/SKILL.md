---
name: bank-file-format
description: Add support for a new bank's bulk payment file to Bills Hub, working from the bank's own template, converter or spec workbook. Use this whenever someone drops in a bank file — a .xls/.xlsx/.xlsm from CIMB, Maybank, RHB, Public Bank, Hong Leong or any other bank — and wants Bills Hub to generate payment files for it, or asks about bank file layouts, beneficiary bank codes, BNM/IBG/DuitNow/RENTAS codes, JomPay biller codes, payment file columns, or why a generated file was rejected by a banking portal. Also use it when changing an existing bank's layout, adding a second payment rail, or diagnosing a file the bank refused.
---

# Adding a bank's payment file to Bills Hub

A bank gives you a workbook. Bills Hub has to produce files that bank accepts,
from bills it syncs out of Xero. This is how that gets done, and more
usefully, which parts have gone wrong before.

The single most important habit: **read the bank's file, not your idea of what
a bank file looks like.** Every bank disagrees with every other bank about
column order, code schemes, field lengths, header rows and what counts as a
bank name. Nothing generalises. What follows is a procedure for extracting
facts, not a template to fill in from memory.

## The moving parts

| Where | What lives there |
| --- | --- |
| `lib/bankFile.js` | `BUILT_IN` layouts — columns, lengths, transforms, templates. The renderer. |
| `lib/malaysianBanks.js` | Bank code tables, one per scheme. Biller-code detection. |
| `lib/xlsx.js` | Filling a template workbook, by sheet name, leaving everything else alone. |
| `models/bankFormats.js` | `seedBuiltIns()` — pushes `BUILT_IN` into the database at boot. |
| `billhub/payments.js` | `layoutsFor()` picks a layout from the paying bank; rails; `planRuns`. |
| `templates/` | Templates we build and ship. |
| `templates/local/` | The bank's own tool, supplied per deployment. Gitignored. |

## 1. Read the file

```bash
python3 .claude/skills/bank-file-format/scripts/inspect_workbook.py "THE BANK FILE.xls"
```

It handles the two surprises these files arrive with: many are encrypted with
Excel's published default key (a write-protection marker, not a secret), and
many are `.xls`, which is an OLE2 compound document rather than a ZIP.

Read its output properly before writing anything. You are looking for:

- **Which sheet holds payments**, and whether there is more than one rail
- **How many header rows** — Hong Leong uses 1, CIMB uses 3. Get this wrong
  and every record is written into the wrong place.
- **The bank's own sample rows.** These are worth more than the column rules
  above them, and when the two disagree the sample is right. CIMB's BNM column
  is headed `Length: 2 (Num Only)` and its sample rows hold
  `35-CIMB Bank Berhad`, because the rule describes what their converter
  writes into its output, not what belongs in the cell.
- **Reference sheets** — bank codes, biller lists. Extract these; never retype
  a code list and never map one bank's codes onto another's.

If the file has no sample rows, ask for a filled one before guessing what the
columns mean. Guessing here has produced files that looked perfect and were
refused.

## 2. Decide what Bills Hub should hand over

Two shapes, and picking wrong wastes the rest of the work.

**A form the bank uploads.** One sheet, you fill it, the user uploads it to the
portal. Hong Leong's ConnectFirst works this way. Build a template with
`extract_template.py` and point the layout at it.

**The bank's own converter.** A workbook of many sheets with a CompanyInfo page
and macros, where the user fills a sheet, runs the bank's application, and
uploads the `.txt` it produces. CIMB's BizConverter works this way. Here the
deliverable is *their whole workbook with the payments written into it* —
handing over a single sheet produces something their converter cannot read.

For a converter, set `template` to the workbook's filename and `template_sheet`
to the sheet. The operator puts their copy in `templates/local/`, which git
ignores, because a bank's licensed tool with a customer's company details in it
has no business in a repository. `lib/xlsx.js` fills the named sheet and copies
every other part through byte for byte.

## 3. Bank codes get their own table

Banks do not agree on how to identify a bank. Hong Leong publishes
four-character codes and three different schemes (IBG, RENTAS, DuitNow) that
disagree with each other; CIMB publishes BNM's two-digit IBG codes and lists 33
participants where Hong Leong lists 113.

Extract each scheme into its own table in `lib/malaysianBanks.js`, keyed by the
normalised bank name, and say in a comment which file it came from. When two
tables disagree it has to be obvious which bank's documentation each reflects.

Two rules here have each already prevented a payment going to the wrong bank:

**Never collapse a subsidiary onto its parent.** Alliance Investment Bank is
not Alliance Bank; Hong Leong Investment Bank is not Hong Leong Bank. Hong
Leong's own sheets give each a different code, which is the clearest possible
evidence that merging them is wrong. Let them resolve to nothing and warn.

**Never infer a code from a short string.** `AMB` looks like AmBank and is in
fact the published code for Alliance Investment Bank. A near match is a
different bank, and the resulting file looks perfectly valid.

A SWIFT/BIC is the exception worth knowing: it names exactly one institution
worldwide, so it can be mapped — but say in the comment that it came from the
BIC registry rather than from the bank's file, because everything else in that
module was extracted and this was not.

## 4. Build the template

```bash
python3 .claude/skills/bank-file-format/scripts/extract_template.py "BANK.xls" \
    --sheet "Data" --header-rows 1 --out templates/newbank-bulk.xlsx
```

It reproduces the form exactly — fills, fonts, borders, number formats, row
heights, column widths, hidden rows — because a filled sheet that looks
different from the blank one is a sheet somebody has to check before trusting.

It also writes an empty prototype row below the header. `lib/xlsx.js` copies
that row's styles onto every record it writes and then drops it. This is how
filled rows end up formatted like the bank's own, and it carries the Text
format that stops Excel rewriting `512088143077` as `5.12089E+11` — a failure
that turns a payment into nothing and is invisible until it has happened.

Then open the result next to the original and compare.

## 5. Define the layout

Add an entry to `BUILT_IN` in `lib/bankFile.js`. Columns in the bank's order,
headers copied verbatim, `maxLength` from the bank's stated rule, `transform`
chosen for what that bank forbids. Existing transforms: `trim`, `digits`,
`upper`, `lower`, `safe`, `ref` (keeps hyphens), `cimb` (strips `-` and `/`).
Add one if a bank forbids something new rather than bending an existing one.

```js
{
  format_key: 'newbank-bulk',
  name: 'New Bank — bulk payment',
  bank_name: 'New Bank Berhad',
  template: 'newbank-bulk.xlsx',
  template_sheet: null,            // the sheet, if the template is a workbook
  template_header_rows: 1,
  extension: 'csv',                // the fallback when no template is present
  verified: 0,                     // until a real upload has been accepted
  notes: 'Where this came from and anything the portal enforces.',
  columns: [
    { header: '*Beneficiary Name', field: 'payeeName', transform: 'trim', maxLength: 40 },
    { header: '*Bank Code', field: 'payeeBankCode', maxLength: 4 },
    { header: '*Amount', field: 'amount' }
  ]
}
```

Leave `verified: 0` until a generated file has actually been accepted by the
portal. The UI shows "Layout unverified" and that is honest: everything up to
that point is inference from a spec, and specs have been wrong twice already.

Fields available to a column are built in `fieldsFor()` — read it rather than
guessing names. Add a new one there when a bank wants something nothing else
has asked for.

## 6. Wire up selection

`layoutsFor()` in `billhub/payments.js` maps a paying bank to its layouts, so
an account at that bank produces the right file with nothing configured:

```js
const LAYOUTS = {
  cimb: { transfer: 'cimb-bulk-email', biller: null },
  hlb: { transfer: 'hlb-connectfirst', biller: 'hlb-jompay' }
};
```

`biller: null` means that bank is not used for JomPay, and the refusal then
tells the user which account to use instead rather than suggesting they
configure something that would be wrong.

A paying account's `format_key` still overrides, which is what a second product
at the same bank needs.

## 7. Verify before claiming it works

Run the suite, then generate a real file and read it back:

```bash
npm test
npm run ready-to-pay -- --entity SOMECODE --from "New Bank"
```

Then check the output yourself rather than trusting the renderer:

- Every part of the workbook parses as XML. A ZIP can verify perfectly and
  still contain empty parts, which is how Excel ends up refusing a file that
  `unzip -t` calls fine.
- The header rows are byte-identical to the bank's.
- Records start on the right row.
- Long account numbers are text, not scientific notation.
- The filename extension matches what was actually produced.

`references/traps.md` has the full list of things that have gone wrong, with
what each one looked like. Read it when something behaves oddly — most odd
behaviour here has happened before.

## What usually turns out to be the real problem

The file format is rarely the hard part. On every bank so far the blocker has
been the Xero data behind it: contacts with a premises code where the bank name
should be, a SWIFT code instead of a name, an account-holder's name, a biller
code in the wrong field, no email address. `npm run bank-names` reports what is
actually in those fields, grouped by what is wrong with each, which turns a
vague data-quality problem into a worklist somebody can act on.

Say this out loud early. A layout that is correct and a payee file that is 30%
usable is not a working integration, and the person who can fix the second part
is usually not the person asking for the first.

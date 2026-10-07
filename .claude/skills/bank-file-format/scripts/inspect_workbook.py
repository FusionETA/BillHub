#!/usr/bin/env python3
"""Show what is actually inside a bank's workbook.

    python3 inspect_workbook.py "CIMB BizConverter.xls"
    python3 inspect_workbook.py "Bulk-Payment.xls" --sheet "Data"

This is the first thing to run on a file from a new bank, and most of what
you need comes out of it: the sheets, which one holds payments, how many
header rows there are, the column names and their stated rules, and — most
importantly — the bank's own sample rows.

The sample rows matter more than the rules. A column headed
"Length: 2 (Num Only)" can hold "35-CIMB Bank Berhad", because the rule
describes what the bank's converter writes into its output file, not what
goes in the cell. Reading the rule and ignoring the data produces a file the
bank rejects, and it is not obvious until someone uploads it.

Handles the two surprises these files come with: they are often encrypted
with Excel's published default key, and they are often .xls, which is an OLE2
compound document rather than a ZIP.

Needs: pip install xlrd msoffcrypto-tool
"""

import argparse
import os
import re
import sys
import tempfile

try:
    import xlrd
except ImportError:
    sys.exit('pip install xlrd  (1.2+ reads .xls; 2.x is fine and .xls-only)')

PAYMENT_HINTS = re.compile(r'bulk|payment|payroll|transfer|jompay|giro|ibg|credit', re.I)


def open_book(path):
    """Open the workbook, decrypting it if Excel write-protected it.

    'VelvetSweatshop' is Excel's own default key for a read-only-recommended
    workbook. It is published by Microsoft and is a write-protection marker,
    not a password anybody chose — so a file that opens with it was never
    meant to be secret.
    """
    try:
        return xlrd.open_workbook(path, formatting_info=True), None
    except xlrd.biffh.XLRDError as err:
        if 'encrypted' not in str(err).lower():
            raise
    try:
        import msoffcrypto
    except ImportError:
        sys.exit('This workbook is encrypted. pip install msoffcrypto-tool')
    tmp = tempfile.NamedTemporaryFile(suffix='.xls', delete=False)
    with open(path, 'rb') as fh:
        office = msoffcrypto.OfficeFile(fh)
        office.load_key(password='VelvetSweatshop')
        office.decrypt(tmp)
    tmp.close()
    return xlrd.open_workbook(tmp.name, formatting_info=True), tmp.name


def rgb(book, index):
    colour = book.colour_map.get(index)
    return '#%02X%02X%02X' % colour if colour else None


def describe_cell(book, sheet, r, c):
    xf = book.xf_list[sheet.cell_xf_index(r, c)]
    font = book.font_list[xf.font_index]
    fmt = book.format_map.get(xf.format_key)
    bits = []
    fill = rgb(book, xf.background.pattern_colour_index) if xf.background.fill_pattern == 1 else None
    if fill:
        bits.append('fill ' + fill)
    colour = rgb(book, font.colour_index)
    if colour and colour != '#000000':
        bits.append('text ' + colour)
    if font.bold:
        bits.append('bold')
    if xf.alignment.text_wrapped:
        bits.append('wrap')
    if fmt and fmt.format_str not in ('General',):
        bits.append('format ' + fmt.format_str)
    if xf.border.left_line_style:
        bits.append('bordered')
    return ', '.join(bits) or 'plain'


FIELD_WORDS = re.compile(
    r'name|amount|account|code|ref|date|descr|payee|beneficiary|currency|mode|email|id\b',
    re.I)


def guess_header_rows(sheet):
    """Where the data starts: the row of field labels, and everything above it.

    Looking for the labels rather than for "the first numeric row" matters,
    because a bank will happily put numbers in a header. CIMB's row 1 is the
    column widths — 40, 20, 2, 16 — and a numeric-row rule calls that data and
    the whole layout comes out shifted by three.

    Hong Leong labels in row 1, CIMB in row 3 under two rows of length rules.
    Treat the answer as a suggestion and confirm it against the sample rows.
    """
    best, score = None, 0
    for r in range(min(sheet.nrows, 12)):
        values = [str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)]
        labelled = sum(1 for v in values if FIELD_WORDS.search(v))
        starred = sum(1 for v in values if v.startswith('*'))
        # Mandatory markers are a strong signal; several field words is enough
        # on their own.
        here = labelled + starred * 2
        if here > score:
            best, score = r, here
    if best is None or score < 2:
        return min(sheet.nrows, 1)
    return best + 1


def show_sheet(book, sheet, name, sample=6):
    print('=' * 72)
    print('%s  —  %d rows x %d cols' % (name, sheet.nrows, sheet.ncols))
    print('=' * 72)
    if not sheet.nrows:
        print('  (empty)\n')
        return

    header_rows = guess_header_rows(sheet)
    print('  header rows look like: %d  (data from row %d)' % (header_rows, header_rows + 1))
    hidden = [r + 1 for r in range(min(sheet.nrows, header_rows))
              if r in sheet.rowinfo_map and sheet.rowinfo_map[r].hidden]
    if hidden:
        print('  hidden rows: %s  — reproduce these; the bank hides its own markers' % hidden)
    print()

    print('  COLUMNS')
    for c in range(sheet.ncols):
        header = ''
        for r in range(header_rows):
            v = ' '.join(str(sheet.cell_value(r, c)).split())
            if v and not v.replace('.', '').isdigit():
                header = v
                break
        width = sheet.computed_column_width(c) / 256.0
        print('    %-3s %-34s width %-6.1f %s'
              % (chr(65 + c) if c < 26 else 'A' + chr(65 + c - 26),
                 header[:34], width,
                 describe_cell(book, sheet, header_rows - 1, c) if header_rows else ''))
    print()

    print('  HEADER ROWS, verbatim — reproduce these exactly')
    for r in range(header_rows):
        cells = []
        for c in range(sheet.ncols):
            v = sheet.cell_value(r, c)
            if isinstance(v, float) and v == int(v):
                v = int(v)
            cells.append(' '.join(str(v).split())[:26])
        print('    row %d: %s' % (r + 1, ' | '.join(cells)))
    print()

    data = [r for r in range(header_rows, min(sheet.nrows, header_rows + sample))
            if any(str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols))]
    if data:
        print("  THE BANK'S OWN SAMPLE ROWS — trust these over the column rules")
        for r in data:
            cells = []
            for c in range(sheet.ncols):
                v = sheet.cell_value(r, c)
                if isinstance(v, float) and v == int(v):
                    v = int(v)
                cells.append(' '.join(str(v).split())[:26])
            print('    row %d: %s' % (r + 1, ' | '.join(cells)))
        print()
        print('  DATA ROW FORMATTING — copy it, especially the number formats')
        for c in range(sheet.ncols):
            d = describe_cell(book, sheet, data[0], c)
            print('    %-3s %s' % (chr(65 + c) if c < 26 else 'A' + chr(65 + c - 26), d))
        print()
        print('    A column formatted as @ (text) is how the bank stops Excel')
        print('    turning 512088143077 into 5.12089E+11. Carry it over.')
    else:
        print('  No sample rows. Ask for a filled example before guessing the')
        print('  column meanings — the rules alone have misled before.')
    print()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('workbook')
    ap.add_argument('--sheet', action='append', help='only these sheets (repeatable)')
    ap.add_argument('--all', action='store_true', help='every sheet, not just payment-looking ones')
    ap.add_argument('--sample', type=int, default=6, help='sample rows to show (default 6)')
    args = ap.parse_args()

    book, tmp = open_book(os.path.expanduser(args.workbook))
    try:
        names = book.sheet_names()
        print('\n%d sheet(s): %s\n' % (len(names), ', '.join(names)))
        if len(names) > 3:
            print('A whole workbook rather than a single form. If it is the bank\'s own')
            print('converter, Bills Hub should fill a copy of it and leave the rest alone —')
            print('see references/traps.md, "The bank\'s tool is the deliverable".\n')

        if args.sheet:
            wanted = [n for n in names if n.lower() in [s.lower() for s in args.sheet]]
        elif args.all:
            wanted = names
        else:
            wanted = [n for n in names if PAYMENT_HINTS.search(n)] or names[:3]
            skipped = [n for n in names if n not in wanted]
            if skipped:
                print('Showing the payment-looking sheets. Also present, --all to see them: %s\n'
                      % ', '.join(skipped))

        for n in wanted:
            show_sheet(book, book.sheet_by_name(n), n, args.sample)

        others = [n for n in names if re.search(r'bank|code|biller|bnm|swift|bic', n, re.I)]
        if others:
            print('Reference sheets worth extracting into a lookup table: %s' % ', '.join(others))
            print('Extract them — never retype a bank code list, and never map one')
            print("bank's codes onto another's. See references/traps.md.")
    finally:
        if tmp:
            os.unlink(tmp)


if __name__ == '__main__':
    main()

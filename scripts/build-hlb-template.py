#!/usr/bin/env python3
"""Rebuild templates/hlb-connectfirst.xlsx from Hong Leong's own ConnectFirst
workbook, keeping the header's formatting.

    python3 scripts/build-hlb-template.py ~/Downloads/CFRIST_Bulk_Empty.xls

Why this exists. ConnectFirst ships as .xls, Bills Hub fills and serves .xlsx,
and the first conversion carried the text across but not the lavender fill, the
red/teal column labels, the wrapped 96pt header row or the column widths. The
file worked and looked wrong, which is the kind of thing a person quite
reasonably does not trust.

So the conversion is a script rather than a one-off: when the bank reissues the
form, run this again instead of trying to remember what was done by hand.

Only the first sheet's header is restyled — that is the sheet the bank reads and
the one anybody looks at. The other five (the bank-code lists and the file
spec) are carried through untouched.

Dev-time only. Nothing at runtime imports this, and lib/xlsx.js stays
dependency-free.
"""

import os
import re
import shutil
import sys
import zipfile

import xlrd

TEMPLATE = os.path.join(os.path.dirname(__file__), '..', 'templates', 'hlb-connectfirst.xlsx')
SHEET = 'xl/worksheets/sheet1.xml'
STYLES = 'xl/styles.xml'


def rgb(triple):
    return 'FF%02X%02X%02X' % triple if triple else 'FF000000'


def read_header_format(xls_path):
    """The bank's own header formatting, one entry per column."""
    book = xlrd.open_workbook(xls_path, formatting_info=True)
    sheet = book.sheet_by_index(0)
    cols = []
    for c in range(sheet.ncols):
        xf = book.xf_list[sheet.cell_xf_index(0, c)]
        font = book.font_list[xf.font_index]
        cols.append({
            'fill': rgb(book.colour_map.get(xf.background.pattern_colour_index)),
            # colour_index 8/None both mean "automatic", which is black.
            'font': rgb(book.colour_map.get(font.colour_index) or (0, 0, 0)),
            'bold': bool(font.bold),
            'name': font.name,
            'size': font.height / 20.0,
            'wrap': bool(xf.alignment.text_wrapped),
            # 1/256ths of a character to Excel's column width unit.
            'width': round(sheet.computed_column_width(c) / 256.0, 2),
        })
    height = sheet.rowinfo_map[0].height / 20.0 if 0 in sheet.rowinfo_map else None
    return cols, height


def build_styles(styles_xml, cols):
    """Append the fonts, fills, border and cell formats the header needs.

    Appending rather than replacing: the indices already in the sheet keep
    meaning what they meant.
    """
    def count(tag):
        return len(re.findall(r'<%s[ />]' % tag[:-1].rstrip('s') if False else r'<%s[ />]' % tag, styles_xml))

    n_fonts = len(re.findall(r'<font>', styles_xml))
    n_fills = len(re.findall(r'<fill>', styles_xml))
    n_borders = len(re.findall(r'<border>', styles_xml))
    n_xfs = len(re.findall(r'<xf ', styles_xml.split('<cellXfs')[1]))

    fonts, fills, xfs, seen = [], [], [], {}
    out = []
    for col in cols:
        key = (col['font'], col['fill'], col['bold'], col['name'], col['size'], col['wrap'])
        if key not in seen:
            font_id = n_fonts + len(fonts)
            fonts.append(
                '<font>%s<sz val="%g"/><color rgb="%s"/><name val="%s"/><family val="2"/></font>'
                % ('<b/>' if col['bold'] else '', col['size'], col['font'], col['name']))
            fill_id = n_fills + len(fills)
            fills.append(
                '<fill><patternFill patternType="solid"><fgColor rgb="%s"/>'
                '<bgColor indexed="64"/></patternFill></fill>' % col['fill'])
            seen[key] = n_xfs + len(xfs)
            xfs.append(
                '<xf numFmtId="0" fontId="%d" fillId="%d" borderId="%d" xfId="0"'
                ' applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
                '<alignment horizontal="center" vertical="top" wrapText="%d"/></xf>'
                % (font_id, fill_id, n_borders, 1 if col['wrap'] else 0))
        out.append(seen[key])

    border = ('<border><left style="thin"><color indexed="64"/></left>'
              '<right style="thin"><color indexed="64"/></right>'
              '<top style="thin"><color indexed="64"/></top>'
              '<bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>')

    s = styles_xml
    s = re.sub(r'<fonts count="\d+">', '<fonts count="%d">' % (n_fonts + len(fonts)), s)
    s = s.replace('</fonts>', ''.join(fonts) + '</fonts>')
    s = re.sub(r'<fills count="\d+">', '<fills count="%d">' % (n_fills + len(fills)), s)
    s = s.replace('</fills>', ''.join(fills) + '</fills>')
    s = re.sub(r'<borders count="\d+">', '<borders count="%d">' % (n_borders + 1), s)
    s = s.replace('</borders>', border + '</borders>')
    s = re.sub(r'<cellXfs count="\d+">', '<cellXfs count="%d">' % (n_xfs + len(xfs)), s)
    s = s.replace('</cellXfs>', ''.join(xfs) + '</cellXfs>')
    return s, out


def apply_to_sheet(sheet_xml, style_ids, cols, height):
    """Point each header cell at its format, set the row height and the widths."""
    def letter(i):
        name = ''
        while True:
            name = chr(65 + i % 26) + name
            i = i // 26 - 1
            if i < 0:
                return name

    row = re.search(r'<row[^>]*r="1"[^>]*>.*?</row>', sheet_xml, re.S)
    if not row:
        raise SystemExit('Template sheet has no row 1.')
    new = row.group(0)
    for i, sid in enumerate(style_ids):
        ref = letter(i) + '1'
        # Replace an existing s=, or add one. Either way the cell keeps its text.
        new = re.sub(r'(<c r="%s")(?: s="\d+")?' % ref, r'\1 s="%d"' % sid, new, count=1)
    if height:
        new = re.sub(r'<row([^>]*)r="1"([^>]*?)(/?)>',
                     r'<row\1r="1"\2 ht="%g" customHeight="1"\3>' % height, new, count=1)
        new = re.sub(r'\s+ht="[^"]*" customHeight="1"(?=.*ht=)', '', new, count=1)
    out = sheet_xml.replace(row.group(0), new, 1)

    widths = ''.join(
        '<col min="%d" max="%d" width="%g" customWidth="1"/>' % (i + 1, i + 1, c['width'])
        for i, c in enumerate(cols))
    cols_xml = '<cols>%s</cols>' % widths
    if re.search(r'<cols>.*?</cols>', out, re.S):
        out = re.sub(r'<cols>.*?</cols>', cols_xml, out, count=1, flags=re.S)
    else:
        out = out.replace('<sheetData', cols_xml + '<sheetData', 1)
    return out


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    xls = os.path.expanduser(sys.argv[1])
    cols, height = read_header_format(xls)
    print('read %d header columns from %s (row height %gpt)' % (len(cols), os.path.basename(xls), height or 0))

    src = zipfile.ZipFile(TEMPLATE)
    parts = {n: src.read(n) for n in src.namelist()}
    src.close()

    styles, style_ids = build_styles(parts[STYLES].decode('utf8'), cols)
    parts[STYLES] = styles.encode('utf8')
    parts[SHEET] = apply_to_sheet(parts[SHEET].decode('utf8'), style_ids, cols, height).encode('utf8')

    shutil.copy(TEMPLATE, TEMPLATE + '.bak')
    with zipfile.ZipFile(TEMPLATE, 'w', zipfile.ZIP_DEFLATED) as out:
        for name, data in parts.items():
            out.writestr(name, data)
    print('wrote %s — %d distinct header formats, %d parts'
          % (os.path.relpath(TEMPLATE), len(set(style_ids)), len(parts)))


if __name__ == '__main__':
    main()

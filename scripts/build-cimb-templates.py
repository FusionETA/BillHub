#!/usr/bin/env python3
"""Build the two CIMB templates from a copy of CIMB BizConverter.xls.

    python3 scripts/build-cimb-templates.py ~/Downloads/"CIMB BizConverter.xls"

BizConverter is a converter, not an upload format: you fill its worksheets,
run its Windows app to produce a .txt, and upload that to BizChannel@CIMB. So
what Bills Hub produces is the worksheet, laid out exactly as BizConverter
expects, for pasting in.

The BizConverter itself is deliberately NOT committed. It is CIMB's licensed
tool, it is a megabyte of macros, and the copy we were given carries Ayu
Borneo's company details and live payroll rows — real names, account numbers
and amounts. None of that belongs in a public repository. This reads the
column names, rules and widths out of it and writes two small workbooks that
carry nothing else.

It is also encrypted, with Excel's published default key for a
"read-only recommended" workbook. That is a write-protection marker rather
than a secret, and msoffcrypto opens it without a password from anyone.

Dev-time only. Nothing at runtime imports this.
"""

import os
import re
import sys
import zipfile

import msoffcrypto
import xlrd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'templates')

SHEETS = [
    ('Bulk Payments - Without Email', 'cimb-bulk.xlsx'),
    ('Bulk Payments - With Email', 'cimb-bulk-email.xlsx'),
    ('JomPAY Payment', 'cimb-jompay.xlsx'),
]
HEADER_ROWS = 3


def decrypt(path):
    f = msoffcrypto.OfficeFile(open(path, 'rb'))
    f.load_key(password='VelvetSweatshop')
    tmp = os.path.join(HERE, '.cimb-decrypted.xls')
    with open(tmp, 'wb') as o:
        f.decrypt(o)
    return tmp


def esc(v):
    return (str(v).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def col_name(i):
    name = ''
    while True:
        name = chr(65 + i % 26) + name
        i = i // 26 - 1
        if i < 0:
            return name


def sheet_xml(rows, widths, heights):
    cols = ''.join('<col min="%d" max="%d" width="%g" customWidth="1"/>' % (i + 1, i + 1, w)
                   for i, w in enumerate(widths))
    out = []
    for r, cells in enumerate(rows, start=1):
        # Row 3 holds the field names and is the one anybody reads; row 1 is
        # BizConverter's own length markers, which it needs and nobody reads.
        style = 2 if r == HEADER_ROWS else 1
        h = heights[r - 1] if r - 1 < len(heights) and heights[r - 1] else None
        attrs = ' ht="%g" customHeight="1"' % h if h else ''
        cs = ''.join(
            '<c r="%s%d" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
            % (col_name(i), r, style, esc(v)) for i, v in enumerate(cells) if str(v) != '')
        out.append('<row r="%d"%s>%s</row>' % (r, attrs, cs))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<dimension ref="A1:%s%d"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15"/>%s<sheetData>%s</sheetData></worksheet>'
        % (col_name(len(widths) - 1), len(rows), cols, ''.join(out)))


# Two formats: the length/rule rows in grey, the field names in CIMB's own red
# on peach, so a filled sheet still looks like the one it came from.
STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>
<font><sz val="9"/><color rgb="FF555555"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>
<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>'''

PARTS = {
    '[Content_Types].xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '</Types>',
    '_rels/.rels':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>',
    'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '</Relationships>',
    'xl/styles.xml': STYLES,
}


def workbook_xml(sheet_name):
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>'
            % esc(sheet_name[:31]))


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = os.path.expanduser(sys.argv[1])
    tmp = decrypt(src)
    try:
        wb = xlrd.open_workbook(tmp, formatting_info=True)
        for sheet_name, out_name in SHEETS:
            sh = wb.sheet_by_name(sheet_name)
            rows = [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(HEADER_ROWS)]
            # Row 1 is BizConverter's length markers, stored as floats.
            rows[0] = [str(int(v)) if isinstance(v, float) else v for v in rows[0]]
            widths = [round(sh.computed_column_width(c) / 256.0, 1) for c in range(sh.ncols)]
            heights = [sh.rowinfo_map[r].height / 20.0 if r in sh.rowinfo_map else None
                       for r in range(HEADER_ROWS)]
            parts = dict(PARTS)
            parts['xl/workbook.xml'] = workbook_xml(sheet_name)
            parts['xl/worksheets/sheet1.xml'] = sheet_xml(rows, widths, heights)
            path = os.path.join(OUT, out_name)
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
                for name, data in parts.items():
                    z.writestr(name, data)
            print('%-22s %d columns, %d header rows -> %s'
                  % (sheet_name, sh.ncols, HEADER_ROWS, os.path.relpath(path)))
    finally:
        os.remove(tmp)


if __name__ == '__main__':
    main()

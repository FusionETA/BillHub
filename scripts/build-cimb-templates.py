#!/usr/bin/env python3
"""Build the CIMB templates from a copy of CIMB BizConverter.xls.

    python3 scripts/build-cimb-templates.py ~/Downloads/"CIMB BizConverter.xls"

BizConverter is a converter, not an upload format: you fill its worksheets,
run its Windows app to produce a .txt, and upload that to BizChannel@CIMB. So
what Bills Hub produces is the worksheet, and it has to look like the one the
person filling it already knows — grey header, red on the mandatory columns,
black on the optional, row 1 hidden, every cell bordered.

None of that is retyped here. Every fill, font, border, number format, row
height and column width is read out of their workbook and reproduced, so the
only way this drifts from CIMB's form is if CIMB changes the form and nobody
runs this again.

Row 4 is written out as an empty prototype row carrying the data formatting —
Text on the account columns, which is what stops Excel turning a long account
number into 3.45679E+11. lib/xlsx.js reads its styles and drops the row.

The BizConverter itself is deliberately NOT committed. It is CIMB's licensed
tool, a megabyte of macros, and the copy we were given carries Ayu Borneo's
company details and live payroll rows. It is also encrypted, with Excel's
published default key for a read-only-recommended workbook — a write
protection marker rather than a secret.

Dev-time only. Nothing at runtime imports this.
"""

import os
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
PROTOTYPE_ROW = 3          # zero-based: their first data row

BUILTIN_FORMATS = set(range(0, 50))   # ids Excel defines itself
H_ALIGN = {0: None, 1: 'left', 2: 'center', 3: 'right', 4: 'fill', 5: 'justify', 6: 'centerContinuous'}
V_ALIGN = {0: 'top', 1: 'center', 2: 'bottom', 3: 'justify'}


def esc(v):
    return str(v).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def col_name(i):
    name = ''
    while True:
        name = chr(65 + i % 26) + name
        i = i // 26 - 1
        if i < 0:
            return name


class Styles:
    """Collects the distinct formats actually used, and numbers them."""

    def __init__(self, wb):
        self.wb = wb
        self.fonts, self.fills, self.borders, self.numfmts, self.xfs = [], [], [], [], []
        self.index = {}
        # Index 0 of each has to be the default Excel expects.
        self._font('<font><sz val="11"/><name val="Calibri"/></font>')
        self._fill('<fill><patternFill/></fill>')
        self._fill('<fill><patternFill patternType="gray125"/></fill>')
        self._border('<border><left/><right/><top/><bottom/><diagonal/></border>')

    def _add(self, lst, xml):
        if xml not in lst:
            lst.append(xml)
        return lst.index(xml)

    def _font(self, xml):
        return self._add(self.fonts, xml)

    def _fill(self, xml):
        return self._add(self.fills, xml)

    def _border(self, xml):
        return self._add(self.borders, xml)

    def rgb(self, i):
        c = self.wb.colour_map.get(i)
        return 'FF%02X%02X%02X' % c if c else None

    def of(self, sheet, r, c):
        """The style index for one cell, adding whatever it needs."""
        xf = self.wb.xf_list[sheet.cell_xf_index(r, c)]
        f = self.wb.font_list[xf.font_index]

        colour = self.rgb(f.colour_index) or 'FF000000'
        font = '<font>%s<sz val="%g"/><color rgb="%s"/><name val="%s"/><family val="2"/></font>' % (
            '<b/>' if f.bold else '', f.height / 20.0, colour, esc(f.name or 'Calibri'))

        bg = self.rgb(xf.background.pattern_colour_index)
        fill = ('<fill><patternFill patternType="solid"><fgColor rgb="%s"/>'
                '<bgColor indexed="64"/></patternFill></fill>' % bg) if bg and xf.background.fill_pattern == 1 \
            else '<fill><patternFill/></fill>'

        b = xf.border
        side = lambda n, style: ('<%s style="thin"><color indexed="64"/></%s>' % (n, n)) if style else '<%s/>' % n
        border = '<border>%s%s%s%s<diagonal/></border>' % (
            side('left', b.left_line_style), side('right', b.right_line_style),
            side('top', b.top_line_style), side('bottom', b.bottom_line_style))

        # Custom number formats have to be declared; builtin ids do not.
        numfmt_id = xf.format_key
        if numfmt_id not in BUILTIN_FORMATS:
            fmt = self.wb.format_map.get(numfmt_id)
            if fmt:
                decl = '<numFmt numFmtId="%d" formatCode="%s"/>' % (numfmt_id, esc(fmt.format_str))
                self._add(self.numfmts, decl)

        align = ''
        h, v = H_ALIGN.get(xf.alignment.hor_align), V_ALIGN.get(xf.alignment.vert_align)
        wrap = xf.alignment.text_wrapped
        if h or v or wrap:
            align = '<alignment%s%s%s/>' % (
                ' horizontal="%s"' % h if h else '', ' vertical="%s"' % v if v else '',
                ' wrapText="1"' if wrap else '')

        key = (font, fill, border, numfmt_id, align)
        if key in self.index:
            return self.index[key]
        xml = ('<xf numFmtId="%d" fontId="%d" fillId="%d" borderId="%d" xfId="0"'
               ' applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"%s>%s</xf>'
               % (numfmt_id, self._font(font), self._fill(fill), self._border(border),
                  ' applyAlignment="1"' if align else '', align))
        self.xfs.append(xml)
        self.index[key] = len(self.xfs) - 1
        return self.index[key]

    def xml(self):
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '%s<fonts count="%d">%s</fonts><fills count="%d">%s</fills>'
                '<borders count="%d">%s</borders>'
                '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                '<cellXfs count="%d">%s</cellXfs>'
                '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
                '</styleSheet>'
                % ('<numFmts count="%d">%s</numFmts>' % (len(self.numfmts), ''.join(self.numfmts)) if self.numfmts else '',
                   len(self.fonts), ''.join(self.fonts), len(self.fills), ''.join(self.fills),
                   len(self.borders), ''.join(self.borders),
                   len(self.xfs), ''.join(self.xfs)))


def build(wb, sheet_name):
    sh = wb.sheet_by_name(sheet_name)
    st = Styles(wb)
    rows = []

    for r in range(HEADER_ROWS):
        cells = []
        for c in range(sh.ncols):
            v = sh.cell_value(r, c)
            if isinstance(v, float) and v == int(v):
                v = str(int(v))
            v = str(v)
            s = st.of(sh, r, c)
            cells.append('<c r="%s%d" s="%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>'
                         % (col_name(c), r + 1, s, esc(v)) if v != ''
                         else '<c r="%s%d" s="%d"/>' % (col_name(c), r + 1, s))
        ri = sh.rowinfo_map.get(r)
        attrs = ''
        if ri and ri.height:
            attrs += ' ht="%g" customHeight="1"' % (ri.height / 20.0)
        if ri and ri.hidden:
            attrs += ' hidden="1"'
        rows.append('<row r="%d"%s>%s</row>' % (r + 1, attrs, ''.join(cells)))

    # The prototype: empty cells carrying the data formatting. lib/xlsx.js
    # reads these styles for the rows it writes, then drops the row.
    proto = ''.join('<c r="%s%d" s="%d"/>' % (col_name(c), PROTOTYPE_ROW + 1, st.of(sh, PROTOTYPE_ROW, c))
                    for c in range(sh.ncols))
    rows.append('<row r="%d">%s</row>' % (PROTOTYPE_ROW + 1, proto))

    cols = ''.join('<col min="%d" max="%d" width="%g" customWidth="1"/>'
                   % (c + 1, c + 1, round(sh.computed_column_width(c) / 256.0, 2))
                   for c in range(sh.ncols))

    sheet_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                 '<dimension ref="A1:%s%d"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
                 '<sheetFormatPr defaultRowHeight="15"/>%s<sheetData>%s</sheetData></worksheet>'
                 % (col_name(sh.ncols - 1), PROTOTYPE_ROW + 1, cols, ''.join(rows)))
    return sh, sheet_xml, st.xml()


RELS = {
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
}


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = os.path.expanduser(sys.argv[1])
    f = msoffcrypto.OfficeFile(open(src, 'rb'))
    f.load_key(password='VelvetSweatshop')
    tmp = os.path.join(HERE, '.cimb-decrypted.xls')
    with open(tmp, 'wb') as o:
        f.decrypt(o)
    try:
        wb = xlrd.open_workbook(tmp, formatting_info=True)
        for sheet_name, out_name in SHEETS:
            sh, sheet_xml, styles_xml = build(wb, sheet_name)
            parts = dict(RELS)
            parts['xl/workbook.xml'] = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>'
                % esc(sheet_name[:31]))
            parts['xl/worksheets/sheet1.xml'] = sheet_xml
            parts['xl/styles.xml'] = styles_xml
            path = os.path.join(OUT, out_name)
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
                for name, data in parts.items():
                    z.writestr(name, data)
            print('%-32s %2d cols -> %s' % (sheet_name, sh.ncols, os.path.relpath(path)))
    finally:
        os.remove(tmp)


if __name__ == '__main__':
    main()

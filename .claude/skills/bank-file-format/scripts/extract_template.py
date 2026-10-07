#!/usr/bin/env python3
"""Turn one sheet of a bank's workbook into a Bills Hub template.

    python3 extract_template.py BANK.xls --sheet "Data" --out templates/x.xlsx
    python3 extract_template.py BANK.xls --sheet "Data" --header-rows 1 --out ...

Bills Hub fills a template rather than building a spreadsheet from nothing,
so that the file a bank receives looks like the form it published: same
header, same colours, same column widths, same number formats. A file that
looks different from the blank one is a file somebody has to check before
trusting.

Nothing here is retyped. Every fill, font, border, number format, row height
and column width is read out of the bank's own workbook, which is the only
way this stays right when the bank reissues the form — run it again.

Two things it does that are easy to miss:

  * Hidden rows stay hidden. Banks hide their own markers (CIMB's row 1 holds
    column widths) and their converter still reads them.

  * An empty row is written just below the header as a prototype. lib/xlsx.js
    copies its styles onto every row it writes and then drops it, which is how
    filled rows end up formatted like the bank's own — including the Text
    format that stops Excel rewriting 512088143077 as 5.12089E+11.

If the bank's file is its own converter — a workbook with many sheets and a
CompanyInfo page — you may not want a template at all. See
references/traps.md, "The bank's tool is the deliverable".

Needs: pip install xlrd msoffcrypto-tool
"""

import argparse
import os
import sys
import zipfile

import msoffcrypto
import xlrd

HERE = os.path.dirname(os.path.abspath(__file__))

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


def build(wb, sheet_name, HEADER_ROWS):
    PROTOTYPE_ROW = HEADER_ROWS      # zero-based: the bank's first data row
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
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('workbook')
    ap.add_argument('--sheet', required=True, help='sheet to turn into a template')
    ap.add_argument('--out', required=True, help='where to write the .xlsx')
    ap.add_argument('--header-rows', type=int,
                    help='rows to keep above the data (inspect_workbook.py suggests one)')
    args = ap.parse_args()

    src = os.path.expanduser(args.workbook)
    tmp = None
    try:
        wb = xlrd.open_workbook(src, formatting_info=True)
    except xlrd.biffh.XLRDError as err:
        if 'encrypted' not in str(err).lower():
            raise
        f = msoffcrypto.OfficeFile(open(src, 'rb'))
        f.load_key(password='VelvetSweatshop')
        tmp = os.path.join(HERE, '.decrypted.xls')
        with open(tmp, 'wb') as o:
            f.decrypt(o)
        wb = xlrd.open_workbook(tmp, formatting_info=True)

    try:
        header_rows = args.header_rows
        if header_rows is None:
            sys.exit('Pass --header-rows. Run inspect_workbook.py first; it suggests a '
                     'number and shows the rows so you can check it. Getting this wrong '
                     'shifts every record.')
        sh, sheet_xml, styles_xml = build(wb, args.sheet, header_rows)
        parts = dict(RELS)
        parts['xl/workbook.xml'] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>'
            % esc(args.sheet[:31]))
        parts['xl/worksheets/sheet1.xml'] = sheet_xml
        parts['xl/styles.xml'] = styles_xml
        out = os.path.expanduser(args.out)
        os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for name, data in parts.items():
                z.writestr(name, data)
        print('%s  (%d columns, %d header rows) -> %s' % (args.sheet, sh.ncols, header_rows, out))
        print('Check it against the original before using it: open both and compare the')
        print('header. A template that drifts from the form is the whole problem this solves.')
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)


if __name__ == '__main__':
    main()

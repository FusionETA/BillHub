// Just enough of the .xlsx container to fill a bank's own template.
//
// Hong Leong hand out a workbook with the header row already in it, and the
// instruction is to add rows underneath and change nothing else. So this does
// not build a workbook — it opens theirs, rewrites one sheet, and leaves every
// other part byte-for-byte as the bank shipped it. Styles, column widths,
// data validation and the reference sheets all survive, because they are never
// touched.
//
// An .xlsx is a ZIP of XML. Node has deflate but no ZIP container, and the one
// npm package that writes spreadsheets is 7.5MB and carries a published
// advisory, which is not a thing to add to something that moves money.
const zlib = require('zlib');

// ── CRC-32, which the ZIP central directory needs for every entry ──────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── Reading ────────────────────────────────────────────────────────────────

// Entries in the order the file has them, each keeping its already-compressed
// bytes so anything we are not changing can be copied straight through.
function readZip(buf) {
  // The end-of-central-directory record is last, after a comment of unknown
  // length, so scan back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file: no end-of-central-directory record.');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip: bad central directory entry.');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra field, at its own lengths.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    entries.push({ name, method, crc, compSize, rawSize, data: buf.subarray(dataStart, dataStart + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflate(entry) {
  if (entry.method === 0) return Buffer.from(entry.data);
  return zlib.inflateRawSync(entry.data);
}

// ── Writing ────────────────────────────────────────────────────────────────

function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(0, 10);              // time
    local.writeUInt16LE(0x21, 12);           // date — fixed, so output is reproducible
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.rawSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.rawSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + e.data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function replaceEntry(entries, name, content) {
  const data = zlib.deflateRawSync(content, { level: 9 });
  return entries.map((e) => (e.name === name
    ? { ...e, method: 8, crc: crc32(content), rawSize: content.length, data }
    : e));
}

// ── Sheet XML ──────────────────────────────────────────────────────────────

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Excel rejects most control characters outright.
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const colName = (n) => {
  let s = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
};

// Inline strings rather than the shared table: it keeps us out of
// sharedStrings.xml entirely, so the header's own strings are undisturbed.
function rowXml(rowNumber, values) {
  const cells = values.map((v, i) => {
    const ref = `${colName(i)}${rowNumber}`;
    if (v == null || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }).join('');
  return `<row r="${rowNumber}">${cells}</row>`;
}

// Keep `headerRows` rows of the template's sheet and put `rows` under them.
function fillSheet(sheetXml, rows, headerRows = 1) {
  const open = sheetXml.indexOf('<sheetData');
  if (open < 0) throw new Error('Template sheet has no sheetData.');
  const selfClosing = /<sheetData\s*\/>/.test(sheetXml.slice(open, open + 40));
  const bodyStart = selfClosing ? open : sheetXml.indexOf('>', open) + 1;
  const bodyEnd = selfClosing
    ? sheetXml.indexOf('/>', open) + 2
    : sheetXml.indexOf('</sheetData>', open);
  const body = selfClosing ? '' : sheetXml.slice(bodyStart, bodyEnd);

  // Everything the bank put in the header rows, exactly as it was.
  const kept = (body.match(/<row[\s\S]*?<\/row>|<row[^>]*\/>/g) || [])
    .filter((r) => {
      const n = Number((r.match(/\br="(\d+)"/) || [])[1] || 0);
      return n > 0 && n <= headerRows;
    });

  const added = rows.map((values, i) => rowXml(headerRows + 1 + i, values));
  const sheetData = `<sheetData>${kept.join('')}${added.join('')}</sheetData>`;

  let out = sheetXml.slice(0, open) + sheetData
    + sheetXml.slice(selfClosing ? bodyEnd : bodyEnd + '</sheetData>'.length);

  // A dimension that disagrees with the rows makes some readers stop early.
  const width = Math.max(1, ...rows.map((r) => r.length), headerRows ? 1 : 1);
  const lastRow = headerRows + rows.length;
  out = out.replace(/<dimension ref="[^"]*"\s*\/>/,
    `<dimension ref="A1:${colName(width - 1)}${Math.max(lastRow, 1)}"/>`);
  return out;
}

// Fill a template workbook and return the new .xlsx bytes.
function fillTemplate(templateBuffer, rows, { sheetPath = 'xl/worksheets/sheet1.xml', headerRows = 1 } = {}) {
  const entries = readZip(templateBuffer);
  const sheet = entries.find((e) => e.name === sheetPath);
  if (!sheet) throw new Error(`Template has no ${sheetPath}.`);
  const filled = fillSheet(inflate(sheet).toString('utf8'), rows, headerRows);
  return writeZip(replaceEntry(entries, sheetPath, Buffer.from(filled, 'utf8')));
}

module.exports = { fillTemplate, readZip, writeZip, replaceEntry, inflate, crc32, fillSheet, colName };

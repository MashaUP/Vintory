/**
 * ZIP senza dipendenze.
 * Scrittura: file «stored» (le foto sono già compresse), nomi UTF-8. Il risultato
 * è un Blob composto da parti: le foto non vengono copiate tutte in memoria.
 * Lettura: «stored» e «deflate» (DecompressionStream), per i backup ricompressi a mano.
 * Limiti del formato classico: 4 GB in totale e 65 535 file (niente ZIP64).
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX = 0xffffffff;

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipWriter {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
    this.stamp = dosTime();
  }

  /** Aggiunge un file. data: Uint8Array, stringa o Blob. */
  async add(name, data) {
    const bytes = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    if (this.offset + bytes.length + nameBytes.length + 30 > MAX) throw new Error("Archivio oltre i 4 GB: esporta una selezione più piccola (per esempio una collezione alla volta).");
    if (this.entries.length >= 0xffff) throw new Error("Troppi file per un solo archivio (massimo 65 535): esporta una selezione più piccola.");
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);            // nomi in UTF-8
    h.setUint16(8, 0, true);                 // stored
    h.setUint16(10, this.stamp.time, true);
    h.setUint16(12, this.stamp.date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    this.parts.push(new Uint8Array(h.buffer), nameBytes, data instanceof Blob ? data : bytes);
    this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset });
    this.offset += 30 + nameBytes.length + bytes.length;
  }

  finish(type = "application/zip") {
    const start = this.offset;
    let size = 0;
    for (const e of this.entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, this.stamp.time, true);
      c.setUint16(14, this.stamp.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.nameBytes.length, true);
      c.setUint32(42, e.offset, true);
      this.parts.push(new Uint8Array(c.buffer), e.nameBytes);
      size += 46 + e.nameBytes.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, start, true);
    this.parts.push(new Uint8Array(end.buffer));
    return new Blob(this.parts, { type });
  }
}

/** Indice di uno ZIP: Map nome → { size, blob(), text(), bytes() }. */
export async function readZip(blob) {
  const tailSize = Math.min(blob.size, 65557);
  const tail = new Uint8Array(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  if (eocd < 0) throw new Error("Il file non è uno ZIP valido.");
  const ev = new DataView(tail.buffer, eocd);
  const count = ev.getUint16(10, true);
  const cdSize = ev.getUint32(12, true);
  const cdOffset = ev.getUint32(16, true);
  if (cdOffset === MAX || count === 0xffff) throw new Error("ZIP64 non supportato: il backup supera i limiti del formato classico.");
  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const v = new DataView(cd.buffer);
  const files = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("Indice dello ZIP danneggiato.");
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const entry = {
      name, size: usize, crc, method,
      async blob(type = "") {
        const lh = new DataView(await blob.slice(local, local + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`ZIP danneggiato: ${name}`);
        const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = blob.slice(start, start + csize);
        if (method === 0) return type ? raw.slice(0, raw.size, type) : raw;
        if (method !== 8) throw new Error(`Compressione non supportata per ${name}`);
        const stream = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Blob([await new Response(stream).arrayBuffer()], { type });
      },
      async bytes() { return new Uint8Array(await (await entry.blob()).arrayBuffer()); },
      async text() { return dec.decode(await entry.bytes()); },
    };
    files.set(name, entry);
  }
  return files;
}

// eslint-disable-next-line no-control-regex -- toglie i caratteri di controllo che XML (Excel) non ammette
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const colName = (i) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** Foglio Excel minimo (.xlsx) da una tabella di righe: testo in linea, numeri come numeri. */
export async function buildXlsx(rows, sheetName = "Vintory") {
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (v == null || v === "") return "";
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const z = new ZipWriter();
  await z.add("[Content_Types].xml", `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  await z.add("_rels/.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  await z.add("xl/workbook.xml", `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  await z.add("xl/_rels/workbook.xml.rels", `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  await z.add("xl/worksheets/sheet1.xml", `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`);
  return z.finish("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

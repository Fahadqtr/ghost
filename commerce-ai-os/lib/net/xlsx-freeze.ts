// FREEZE THE HEADER ROW in a generated .xlsx.
//
// SheetJS 0.20.3 (and xlsx-js-style 0.18.5) write `!autofilter` but silently
// drop `!freeze` — verified against both writers: the emitted sheet XML is
// `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` with no <pane>.
// So the pane is injected here, after the fact, by rewriting the workbook zip.
//
// SAFETY: freezing is cosmetic and the DATA must never be put at risk for it.
// Every failure path — an unexpected zip layout, a deflated entry, a sheet XML
// that does not match the expected shape — returns the ORIGINAL bytes unchanged
// rather than throwing or emitting a half-patched archive. Call it with a
// workbook written using `compression: false`, which stores entries verbatim.

import { buildZip, type ZipEntry } from "./zip.ts";

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const STORE = 0; // compression method 0 — no deflate

const dec = new TextDecoder();
const enc = new TextEncoder();

/**
 * Read a STORE-only ZIP into its entries, in archive order.
 * Returns null when the archive is not in the simple shape this reader
 * understands (any deflated entry, a data descriptor, or a truncated header).
 */
export function readStoredZip(bytes: Uint8Array): ZipEntry[] | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = [];
  let at = 0;

  while (at + 30 <= bytes.length) {
    const sig = dv.getUint32(at, true);
    if (sig === CD_SIG) return entries; // reached the central directory — done
    if (sig !== LOCAL_SIG) return null;

    const flags = dv.getUint16(at + 6, true);
    const method = dv.getUint16(at + 8, true);
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);

    // Bit 3 puts the sizes in a trailing data descriptor: not supported here.
    if (method !== STORE || (flags & 0x08) !== 0) return null;

    const nameStart = at + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + size > bytes.length) return null;

    entries.push({
      name: dec.decode(bytes.subarray(nameStart, nameStart + nameLen)),
      data: bytes.slice(dataStart, dataStart + size),
    });
    at = dataStart + size;
  }
  // Running out of bytes without ever reaching the central directory means this
  // was not a well-formed archive — report failure rather than a partial list.
  return null;
}

/** True for the worksheet parts whose header row should be frozen. */
function isWorksheet(name: string): boolean {
  return /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
}

const PANE = '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
  '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';

/**
 * Insert a frozen top row into one worksheet XML. Handles both shapes SheetJS
 * can emit — a self-closing `<sheetView .../>` and an open/close pair — and
 * returns the input unchanged if neither is present or a pane already exists.
 */
export function freezeSheetXml(xml: string): string {
  if (xml.includes("<pane ")) return xml;

  const selfClosing = /<sheetView([^>]*?)\/>/;
  if (selfClosing.test(xml)) return xml.replace(selfClosing, `<sheetView$1>${PANE}</sheetView>`);

  const open = /<sheetView([^>]*?)>/;
  if (open.test(xml)) return xml.replace(open, `<sheetView$1>${PANE}`);

  return xml;
}

/**
 * Return the workbook with row 1 frozen on every worksheet, or the original
 * bytes when the archive cannot be safely rewritten.
 */
export function freezeTopRow(xlsx: Uint8Array): Uint8Array {
  try {
    const entries = readStoredZip(xlsx);
    if (!entries || entries.length === 0) return xlsx;

    let changed = false;
    const patched = entries.map((e) => {
      if (!isWorksheet(e.name)) return e;
      const before = dec.decode(e.data);
      const after = freezeSheetXml(before);
      if (after === before) return e;
      changed = true;
      return { name: e.name, data: enc.encode(after) };
    });

    return changed ? buildZip(patched) : xlsx;
  } catch {
    return xlsx;
  }
}

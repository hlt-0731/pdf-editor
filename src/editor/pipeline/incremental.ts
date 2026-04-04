/**
 * L4 Editor Layer — Save Pipeline: Incremental PDF Update
 *
 * Appends a new revision to an existing PDF without modifying the original
 * bytes, conforming to the PDF incremental update spec (PDF 32000-1:2008 §7.5.6).
 *
 * Structure appended after the original bytes:
 *
 *   N G obj
 *   <object data>
 *   endobj
 *   …(one block per modified object)…
 *   xref
 *   0 1
 *   0000000000 65535 f \n
 *   N 1
 *   OOOOOOOOOO GGGGG n \n
 *   trailer
 *   << /Size S /Root R /Prev P >>
 *   startxref
 *   X
 *   %%EOF
 */

import type { XRefTable, PDFTrailer } from '../../core/binary/xref';
import { ByteStreamWriter } from '../../core/binary/writer';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModifiedObject {
  /** Object number. */
  objNum: number;
  /** Generation number. */
  genNum: number;
  /** Serialized object bytes (the value only, without "obj"/"endobj" wrapper). */
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// buildIncrementalUpdate
// ---------------------------------------------------------------------------

/**
 * Append an incremental update to `originalPdf` and return the combined bytes.
 *
 * Steps:
 *   1. Copy the original PDF bytes unchanged.
 *   2. For each modified object write `N G obj\n{data}\nendobj\n` and record
 *      the byte offset at which it starts (relative to the beginning of the
 *      combined output).
 *   3. Write the new cross-reference table covering the free entry for object 0
 *      plus one entry per modified object.
 *   4. Write a minimal trailer dictionary pointing back to the original xref
 *      via /Prev.
 *   5. Write `startxref\n{xrefOffset}\n%%EOF\n`.
 */
export function buildIncrementalUpdate(
  originalPdf: Uint8Array,
  modifiedObjects: ModifiedObject[],
  originalXRef: XRefTable,
): Uint8Array {
  const writer = new ByteStreamWriter();

  // 1 — Original bytes unchanged.
  writer.writeBytes(originalPdf);

  // 2 — Emit modified indirect objects; record byte offsets in the new xref.
  const objectEntries: Array<{ objNum: number; genNum: number; offset: number }> = [];

  for (const obj of modifiedObjects) {
    const offset = writer.length;
    objectEntries.push({ objNum: obj.objNum, genNum: obj.genNum, offset });
    writer.writeBytes(serializeIndirectObject(obj.objNum, obj.genNum, obj.data));
  }

  // 3 — Write new xref table.
  const xrefOffset = writer.length;
  const prevOffset = originalXRef.trailer.prev ?? findOriginalXRefOffset(originalPdf);
  writer.writeBytes(
    buildXRefTable(objectEntries, originalXRef.trailer, prevOffset, calcNewSize(originalXRef, modifiedObjects)),
  );

  // 4 & 5 are handled inside buildXRefTable / the suffix written there.
  // (startxref + %%EOF are appended by buildXRefTable's caller below.)

  // Write startxref pointing at the xref table we just wrote.
  writer.writeLine('startxref');
  writer.writeLine(xrefOffset.toString());
  writer.writeString('%%EOF\n');

  return writer.toUint8Array();
}

// ---------------------------------------------------------------------------
// serializeIndirectObject
// ---------------------------------------------------------------------------

/**
 * Wrap `data` in an indirect object definition:
 *
 *   N G obj\n
 *   <data>\n
 *   endobj\n
 */
export function serializeIndirectObject(
  objNum: number,
  genNum: number,
  data: Uint8Array,
): Uint8Array {
  const writer = new ByteStreamWriter();
  writer.writeLine(`${objNum} ${genNum} obj`);
  writer.writeBytes(data);
  writer.writeLine('');   // ensure newline after data
  writer.writeLine('endobj');
  return writer.toUint8Array();
}

// ---------------------------------------------------------------------------
// buildXRefTable
// ---------------------------------------------------------------------------

/**
 * Build the xref table section plus the trailer dictionary.
 *
 * Format:
 *   xref
 *   0 1
 *   0000000000 65535 f \n
 *   N 1
 *   OOOOOOOOOO GGGGG n \n
 *   trailer
 *   << /Size S /Root R /Prev P >>
 *
 * Note: startxref and %%EOF are written by buildIncrementalUpdate after this
 * function returns, because the caller knows the xref offset.
 *
 * Each xref entry is exactly 20 bytes (per PDF §7.5.4):
 *   10-digit offset + SP + 5-digit generation + SP + type + SP + LF
 *   = 10 + 1 + 5 + 1 + 1 + 1 + 1 = 20
 */
export function buildXRefTable(
  entries: Array<{ objNum: number; genNum: number; offset: number }>,
  trailer: PDFTrailer,
  prevXRefOffset: number,
  newSize: number,
): Uint8Array {
  const writer = new ByteStreamWriter();

  writer.writeLine('xref');

  // Free entry for object 0 — always present.
  writer.writeLine('0 1');
  writer.writeString(xrefEntry(0, 65535, 'f'));

  // One subsection per modified object (sorted ascending for spec compliance).
  const sorted = entries.slice().sort((a, b) => a.objNum - b.objNum);
  for (const entry of sorted) {
    writer.writeLine(`${entry.objNum} 1`);
    writer.writeString(xrefEntry(entry.offset, entry.genNum, 'n'));
  }

  // Trailer dictionary.
  writer.writeLine('trailer');
  const rootRef = `${trailer.root.objNum} ${trailer.root.genNum} R`;
  writer.writeLine(`<< /Size ${newSize} /Root ${rootRef} /Prev ${prevXRefOffset} >>`);

  return writer.toUint8Array();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Format a single 20-byte xref entry.
 *
 *   "OOOOOOOOOO GGGGG X \n"
 *    ^10 digits  ^5    ^ space LF
 */
function xrefEntry(offset: number, generation: number, type: 'n' | 'f'): string {
  const off = offset.toString().padStart(10, '0');
  const gen = generation.toString().padStart(5, '0');
  // 10 + 1 + 5 + 1 + 1 + 1 + 1 = 20 bytes (SP LF EOL form)
  return `${off} ${gen} ${type} \n`;
}

/**
 * Compute the new /Size value for the trailer.
 *
 * /Size must be one greater than the highest object number in the document.
 * We take the maximum of the existing trailer size and any new object numbers
 * introduced by the update.
 */
function calcNewSize(
  originalXRef: XRefTable,
  modifiedObjects: ModifiedObject[],
): number {
  let size = originalXRef.trailer.size;
  for (const obj of modifiedObjects) {
    if (obj.objNum + 1 > size) {
      size = obj.objNum + 1;
    }
  }
  return size;
}

/**
 * Fall back to finding the original startxref value by scanning backward
 * through the original PDF bytes.  Used when the parsed XRefTable does not
 * carry a /Prev pointer (i.e. this is the first revision).
 *
 * Scans for the last occurrence of "startxref" in the file and reads the
 * decimal number that follows it.
 */
function findOriginalXRefOffset(originalPdf: Uint8Array): number {
  // Convert to string for simple scanning.  PDFs are ASCII-safe around xref
  // keywords so this is fine for the last ~1 KiB.
  const tail = originalPdf.slice(Math.max(0, originalPdf.length - 1024));
  let text = '';
  for (let i = 0; i < tail.length; i++) {
    text += String.fromCharCode(tail[i] ?? 0);
  }

  const idx = text.lastIndexOf('startxref');
  if (idx === -1) return 0;

  // Find the number after "startxref" and optional whitespace.
  const after = text.slice(idx + 'startxref'.length).trimStart();
  const match = /^(\d+)/.exec(after);
  if (match === null) return 0;

  return parseInt(match[1] ?? '0', 10);
}

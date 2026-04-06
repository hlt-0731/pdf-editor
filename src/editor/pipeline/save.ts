/**
 * L4 Editor Layer — Save Pipeline: Operator Rebuild & Serialization
 *
 * Rebuilds the content stream operator list after text editing and serializes
 * it back to PDF bytes.
 *
 * Strategy:
 *   - Unmodified operators are re-emitted verbatim from their `raw` bytes,
 *     preserving whitespace, comments, and exact byte representation.
 *   - Modified operators are re-serialized from their operands + operator name,
 *     replacing the original bytes.
 *
 * CID font support:
 *   - CID (Type0) fonts use 2-byte character codes.  When regenerating a Tj
 *     operator for a CID font, Unicode text is converted back to CID codes
 *     via the font's unicodeToCharCode() and encoded as a hex string `<...>`.
 *   - Simple fonts (Type1/TrueType) use the font's unicodeToCharCode() for
 *     1-byte encoding, with Latin-1 fallback.
 *
 * PDF 32000-1:2008 §7.3 (PDF objects), §9.4 (Text operators)
 */

import type { TextBlock } from '../../model/text-block';
import type { ContentOperator } from '../../core/content/operators';
import { PDFObjectType } from '../../core/objects/types';
import type { PDFObject } from '../../core/objects/types';
import type { ResolvedFont } from '../../core/font/manager';

// ---------------------------------------------------------------------------
// rebuildTextOperators
// ---------------------------------------------------------------------------

/**
 * Return a new operator array where every Tj/TJ operator referenced by a
 * modified TextBlock is replaced with a newly generated operator.  Unmodified
 * operators are returned by reference (no copy).
 *
 * Each TextBlock is guaranteed to map to exactly one operator (enforced by
 * the splitByOperator step in the grouping pipeline).  This makes the
 * rebuild trivial: the block's entire new text replaces the single operator.
 *
 * @param operators       The original operator array from the content stream.
 * @param modifiedBlocks  Only the TextBlock objects whose `modified` flag is true.
 * @param fonts           Optional font map for proper character encoding.
 */
export function rebuildTextOperators(
  operators: ContentOperator[],
  modifiedBlocks: TextBlock[],
  fonts?: Map<string, ResolvedFont>,
): ContentOperator[] {
  // Map operator index → replacement text for each modified block.
  const operatorReplacements = new Map<number, { text: string; fontName: string }>();

  for (const block of modifiedBlocks) {
    // Collect all distinct operator indices in this block (excluding synthetic chars).
    const opIndices: number[] = [];
    const opFontNames = new Map<number, string>();
    for (const ch of block.chars) {
      if (ch.synthetic) continue;
      if (!opFontNames.has(ch.operatorIndex)) {
        opIndices.push(ch.operatorIndex);
        opFontNames.set(ch.operatorIndex, ch.fontName);
      }
    }
    if (opIndices.length === 0) continue;

    // Sort by stream order.
    opIndices.sort((a, b) => a - b);

    // Assign the entire new text to the first operator.
    // All other operators in this merged block become empty.
    const firstOp = opIndices[0]!;
    operatorReplacements.set(firstOp, {
      text: block.text,
      fontName: opFontNames.get(firstOp)!,
    });
    for (let i = 1; i < opIndices.length; i++) {
      operatorReplacements.set(opIndices[i]!, {
        text: '',
        fontName: opFontNames.get(opIndices[i]!)!,
      });
    }
  }

  return operators.map((op, index): ContentOperator => {
    const replacement = operatorReplacements.get(index);
    if (replacement === undefined) {
      return op; // Not modified — keep original raw bytes.
    }

    const font = fonts?.get(replacement.fontName);
    return generateTJOperator(replacement.text, 0, replacement.fontName, font);
  });
}

// ---------------------------------------------------------------------------
// generateNewBlockOperators
// ---------------------------------------------------------------------------

/**
 * Generate a complete BT / Tf / Tm / Tj / ET operator sequence for a newly
 * created TextBlock (one that has `isNew: true` and no pre-existing operators).
 *
 * The text matrix (Tm) positions the text at the block's bounding-box origin
 * in **page coordinates** (PDF default: bottom-left origin, Y-up).  The caller
 * must supply `pageHeight` and `scale` so canvas-space coordinates can be
 * converted back to unscaled page coordinates.
 *
 * @param block       The new TextBlock.
 * @param pageHeight  Height of the page in PDF points (unscaled).
 * @param scale       Render scale factor (canvas px / PDF pt).
 * @param fonts       Optional font map for proper char code encoding.
 */
export function generateNewBlockOperators(
  block: TextBlock,
  pageHeight: number,
  scale: number,
  fonts?: Map<string, ResolvedFont>,
): ContentOperator[] {
  const bb = block.boundingBox;
  const fontSize = block.fontSize || 16;
  const fontName = block.fontName || 'F1';

  // Convert canvas-space coords → page-space coords.
  // Canvas Y is top-down; PDF Y is bottom-up.
  const pdfX = bb.x / scale;
  // The baseline in canvas space is bb.y + fontSize * 0.85.
  const baselineCanvasY = bb.y + fontSize * 0.85;
  const pdfY = pageHeight - baselineCanvasY / scale;
  const pdfFontSize = fontSize / scale;

  // BT
  const btOp = makeSyntheticOp('BT', []);

  // /FontName fontSize Tf
  const tfOp = makeSyntheticOp('Tf', [
    { type: PDFObjectType.Name, value: fontName },
    { type: PDFObjectType.Number, value: pdfFontSize },
  ]);

  // fontSize 0 0 fontSize x y Tm
  const tmOp = makeSyntheticOp('Tm', [
    { type: PDFObjectType.Number, value: pdfFontSize },
    { type: PDFObjectType.Number, value: 0 },
    { type: PDFObjectType.Number, value: 0 },
    { type: PDFObjectType.Number, value: pdfFontSize },
    { type: PDFObjectType.Number, value: pdfX },
    { type: PDFObjectType.Number, value: pdfY },
  ]);

  // (text) Tj
  const font = fonts?.get(fontName);
  const tjOp = generateTJOperator(block.text, 0, fontName, font);

  // ET
  const etOp = makeSyntheticOp('ET', []);

  return [btOp, tfOp, tmOp, tjOp, etOp];
}

/** Create a synthetic ContentOperator that is already serialized. */
function makeSyntheticOp(name: string, operands: PDFObject[]): ContentOperator {
  const op: ContentOperator = {
    name,
    operands,
    raw: new Uint8Array(0),
    offset: 0,
    modified: true,
  };
  op.raw = serializeSingleOperator(op);
  return op;
}

// ---------------------------------------------------------------------------
// generateTJOperator
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `Tj` ContentOperator for the given text.
 *
 * - CID fonts → hex string `<XXXX...>` with 2-byte char codes
 * - Simple fonts → literal string `(...)` with 1-byte char codes
 *
 * We always emit `Tj` (simple string show) rather than `TJ` (glyph array)
 * because the edited text is a plain Unicode string and kerning adjustments
 * from the original are intentionally discarded.
 *
 * @param text      Replacement text (plain Unicode string).
 * @param fontSize  Font size (informational; not embedded in Tj — Tf upstream).
 * @param fontName  Font resource name (informational).
 * @param font      Resolved font for proper char code encoding.
 */
export function generateTJOperator(
  text: string,
  _fontSize: number,
  _fontName: string,
  font?: ResolvedFont,
): ContentOperator {
  let pdfString: PDFObject;

  if (font?.isCID) {
    // CID font: convert Unicode → 2-byte CID codes → hex string
    const rawBytes = encodeCIDText(text, font);
    const hexStr = bytesToHex(rawBytes);
    pdfString = {
      type: PDFObjectType.HexString,
      value: text,
      raw: hexStr,
    };
  } else {
    // Simple font: convert Unicode → 1-byte char codes → literal string
    const encoded = font ? encodeSimpleText(text, font) : encodeLatin1(text);
    const encodedValue = uint8ArrayToLatin1String(encoded);
    pdfString = {
      type: PDFObjectType.String,
      value: encodedValue,
      raw: encoded,
    };
  }

  // Serialize the full operator to bytes for the `raw` field.
  const serialized = serializeSingleOperator({
    name: 'Tj',
    operands: [pdfString],
    raw: new Uint8Array(0),
    offset: 0,
    modified: true,
  });

  return {
    name: 'Tj',
    operands: [pdfString],
    raw: serialized,
    offset: 0,
    modified: true,
  };
}

// ---------------------------------------------------------------------------
// serializeOperators
// ---------------------------------------------------------------------------

/**
 * Concatenate all operators back into a content stream byte sequence.
 *
 * - Unmodified operators: emit `op.raw` verbatim.
 * - Modified operators:   serialize operands + operator name as PDF tokens.
 */
export function serializeOperators(operators: ContentOperator[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const NEWLINE = new Uint8Array([0x0a]);

  for (const op of operators) {
    if (!op.modified) {
      chunks.push(op.raw);
    } else {
      chunks.push(serializeSingleOperator(op));
    }
    // The tokenizer strips trailing whitespace from each operator's `raw` bytes.
    // Without an explicit separator, consecutive operators may merge when
    // re-serialized (e.g. "cm" + "q" → "cmq").  A newline after every operator
    // prevents this.  Extra whitespace is harmless in PDF content streams.
    chunks.push(NEWLINE);
  }

  return concatUint8Arrays(chunks);
}

// ---------------------------------------------------------------------------
// Text encoding helpers
// ---------------------------------------------------------------------------

/**
 * Encode Unicode text to CID 2-byte character codes.
 * Each Unicode character is converted to its CID code via the font's reverse
 * ToUnicode mapping.  Characters that cannot be mapped are silently dropped.
 */
function encodeCIDText(text: string, font: ResolvedFont): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = font.unicodeToCharCode(char);
    if (code !== null) {
      // Big-endian 2-byte encoding
      bytes.push((code >> 8) & 0xff);
      bytes.push(code & 0xff);
    } else if (char === ' ') {
      // Space fallback — most CID fonts support 0x0020 even when ToUnicode
      // doesn't list it.  Without this, spaces are silently dropped.
      bytes.push(0x00);
      bytes.push(0x20);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Encode Unicode text to 1-byte character codes using the font's encoding.
 * Characters that cannot be mapped by the font are silently dropped (encoded
 * as 0x00) to avoid garbled output.  The old fallback to charCodeAt produced
 * wrong codes for Type3 subset fonts whose custom encoding doesn't follow
 * ASCII/Latin-1 code positions.
 */
function encodeSimpleText(text: string, font: ResolvedFont): Uint8Array {
  const result: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === undefined) continue;
    const code = font.unicodeToCharCode(char);
    if (code !== null) {
      result.push(code & 0xff);
    } else if (char === ' ') {
      // Space fallback — 0x20 is the standard space code in virtually all
      // PDF font encodings.  Without this, spaces are silently dropped when
      // the ToUnicode CMap doesn't include a mapping for U+0020.
      result.push(0x20);
    }
    // Other characters without a mapping are dropped — the font doesn't have the glyph.
  }
  return new Uint8Array(result);
}

/** Encode a string to bytes using Latin-1 (fallback when no font is available). */
function encodeLatin1(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Convert a Uint8Array of byte values to a string (Latin-1 / ISO 8859-1). */
function uint8ArrayToLatin1String(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i] ?? 0);
  }
  return str;
}

/** Convert a byte array to a hex string (e.g. [0x30, 0x42] → "3042"). */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Internal serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a single modified ContentOperator to PDF bytes.
 *
 * Format: `<operand1> <operand2> … <operator>\n`
 */
function serializeSingleOperator(op: ContentOperator): Uint8Array {
  const parts: Uint8Array[] = [];

  for (const operand of op.operands) {
    parts.push(serializeOperand(operand));
    parts.push(new Uint8Array([0x20])); // space separator
  }

  // Operator keyword
  parts.push(asciiBytes(op.name));
  parts.push(new Uint8Array([0x0a])); // LF newline

  return concatUint8Arrays(parts);
}

/**
 * Serialize a PDFObject operand to its PDF token representation.
 *
 * Supported types:
 *   - String    → `(escaped text)`
 *   - HexString → `<hex digits>`
 *   - Number    → decimal number string
 *   - Name      → `/Name`
 *   - Array     → `[item1 item2 …]`
 *   - Boolean   → `true` / `false`
 *   - Null      → `null`
 *
 * Dictionary, Stream, Ref are not expected as Tj/TJ operands;
 * they fall back to an empty bytes sequence.
 */
function serializeOperand(obj: PDFObject): Uint8Array {
  switch (obj.type) {
    case PDFObjectType.String:
      return serializeLiteralString(obj.value);

    case PDFObjectType.HexString:
      return serializeHexStringToken(obj.raw);

    case PDFObjectType.Number:
      return asciiBytes(obj.value.toString());

    case PDFObjectType.Name:
      return asciiBytes(`/${obj.value}`);

    case PDFObjectType.Array: {
      const inner: Uint8Array[] = [new Uint8Array([0x5b])]; // '['
      for (let i = 0; i < obj.items.length; i++) {
        if (i > 0) inner.push(new Uint8Array([0x20]));
        const item = obj.items[i];
        if (item !== undefined) {
          inner.push(serializeOperand(item));
        }
      }
      inner.push(new Uint8Array([0x5d])); // ']'
      return concatUint8Arrays(inner);
    }

    case PDFObjectType.Boolean:
      return asciiBytes(obj.value ? 'true' : 'false');

    case PDFObjectType.Null:
      return asciiBytes('null');

    // These types are not expected as Tj/TJ operands.
    case PDFObjectType.Dictionary:
    case PDFObjectType.Stream:
    case PDFObjectType.Ref:
      return new Uint8Array(0);

    default:
      // PDFInlineImage ('inline_image') and any future union members.
      return new Uint8Array(0);
  }
}

/**
 * Serialize a string as a PDF literal string `(text)` with escape sequences
 * for `(`, `)`, and `\`.
 */
function serializeLiteralString(text: string): Uint8Array {
  // Worst-case: every char needs a backslash prefix → 2× length + 2 parens.
  const escaped: number[] = [0x28]; // '('

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) & 0xff;
    if (code === 0x5c) {
      // backslash → '\\'
      escaped.push(0x5c, 0x5c);
    } else if (code === 0x28) {
      // '(' → '\('
      escaped.push(0x5c, 0x28);
    } else if (code === 0x29) {
      // ')' → '\)'
      escaped.push(0x5c, 0x29);
    } else {
      escaped.push(code);
    }
  }

  escaped.push(0x29); // ')'
  return new Uint8Array(escaped);
}

/**
 * Serialize a hex string to PDF hex string format `<hex_digits>`.
 *
 * @param hexDigits  The hex digit string (without angle brackets).
 */
function serializeHexStringToken(hexDigits: string): Uint8Array {
  return asciiBytes(`<${hexDigits}>`);
}

/** Convert an ASCII string to a Uint8Array without TextEncoder allocation. */
function asciiBytes(s: string): Uint8Array {
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    buf[i] = s.charCodeAt(i);
  }
  return buf;
}

/** Concatenate multiple Uint8Array chunks into one. */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

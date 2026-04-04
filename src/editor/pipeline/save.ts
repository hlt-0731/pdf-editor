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
 * Prefix/suffix alignment strategy:
 *   When a block spans multiple operators with different fonts (common with
 *   Type3 CJK subset fonts), a naive character-position mapping would assign
 *   characters to operators with incompatible fonts, causing garbled output.
 *
 *   Instead, we compare the old text (from block.chars) and the new text
 *   (block.text) to find the longest common prefix and suffix.  Operators
 *   that belong entirely to the unchanged prefix/suffix are kept verbatim.
 *   Only operators in the changed middle region are re-encoded, and the
 *   changed portion of the new text is distributed across those operators
 *   using each operator's original font.
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
  // Build per-operator replacement instructions from all modified blocks.
  // `null` means "keep original raw bytes" (unchanged operator).
  const operatorReplacements = new Map<number, { text: string; fontName: string } | null>();

  for (const block of modifiedBlocks) {
    // Build char → operator mapping from the original block characters.
    const charOps = block.chars.map(ch => ({
      opIndex: ch.operatorIndex,
      fontName: ch.fontName,
    }));

    // Reconstruct original text from chars (matches what the user saw).
    const oldChars = [...block.chars.map(ch => ch.char).join('')];
    const newChars = [...block.text]; // split by code point

    // Find longest common prefix.
    let prefix = 0;
    while (
      prefix < oldChars.length &&
      prefix < newChars.length &&
      oldChars[prefix] === newChars[prefix]
    ) {
      prefix++;
    }

    // Find longest common suffix (not overlapping with prefix).
    let suffix = 0;
    while (
      suffix < oldChars.length - prefix &&
      suffix < newChars.length - prefix &&
      oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
    ) {
      suffix++;
    }

    const changedOldStart = prefix;
    const changedOldEnd = oldChars.length - suffix;

    // Collect the set of operator indices that are in the changed region.
    const changedOpIndices = new Set<number>();
    for (let i = changedOldStart; i < changedOldEnd; i++) {
      if (i < charOps.length) {
        changedOpIndices.add(charOps[i]!.opIndex);
      }
    }

    // Mark prefix/suffix operators as "keep original" (null), unless they
    // are also touched by the changed region (straddling a boundary).
    for (let i = 0; i < prefix; i++) {
      if (i < charOps.length) {
        const opIdx = charOps[i]!.opIndex;
        if (!changedOpIndices.has(opIdx)) {
          operatorReplacements.set(opIdx, null);
        }
      }
    }
    for (let i = oldChars.length - suffix; i < oldChars.length; i++) {
      if (i < charOps.length) {
        const opIdx = charOps[i]!.opIndex;
        if (!changedOpIndices.has(opIdx)) {
          operatorReplacements.set(opIdx, null);
        }
      }
    }

    // Extract the changed portion of the new text.
    const changedNewText = newChars.slice(prefix, newChars.length - suffix).join('');

    // Collect per-operator info for the changed region, in stream order.
    const opOrder: number[] = [];
    const opInfo = new Map<number, { fontName: string; charCount: number }>();

    for (let i = changedOldStart; i < changedOldEnd; i++) {
      if (i >= charOps.length) continue;
      const co = charOps[i]!;
      let info = opInfo.get(co.opIndex);
      if (info === undefined) {
        info = { fontName: co.fontName, charCount: 0 };
        opInfo.set(co.opIndex, info);
        opOrder.push(co.opIndex);
      }
      info.charCount++;
    }

    // Sort by stream order.
    opOrder.sort((a, b) => a - b);

    // Distribute the changed text across the changed operators.
    const changedChars = [...changedNewText];
    let pos = 0;

    for (let i = 0; i < opOrder.length; i++) {
      const opIdx = opOrder[i]!;
      const info = opInfo.get(opIdx)!;
      let slice: string;

      if (i === opOrder.length - 1) {
        // Last changed operator gets all remaining characters.
        slice = changedChars.slice(pos).join('');
      } else {
        slice = changedChars.slice(pos, pos + info.charCount).join('');
        pos += info.charCount;
      }

      operatorReplacements.set(opIdx, { text: slice, fontName: info.fontName });
    }
  }

  return operators.map((op, index): ContentOperator => {
    if (!operatorReplacements.has(index)) {
      return op; // Not part of any modified block.
    }
    const replacement = operatorReplacements.get(index);
    if (replacement === null || replacement === undefined) {
      return op; // Unchanged operator — keep original raw bytes.
    }

    const font = fonts?.get(replacement.fontName);
    return generateTJOperator(replacement.text, 0, replacement.fontName, font);
  });
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
    }
    // Characters without a mapping are dropped — the font doesn't have the glyph.
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

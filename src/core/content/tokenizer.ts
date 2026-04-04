/**
 * L2 Content Layer — ContentStreamTokenizer
 *
 * Parses a decoded PDF content stream (Uint8Array) into an ordered list of
 * ContentOperator values.  The tokenizer does NOT execute operators; it only
 * identifies the operand/operator boundary and captures the raw bytes of each
 * operator group.
 *
 * Grammar (simplified, PDF 32000-1:2008 §7.8.2):
 *
 *   content_stream  := ( operand* operator )*
 *   operand         := number | literal_string | hex_string | name | array | dict
 *   operator        := keyword   (any token that is not a recognised operand)
 *
 * Special sequences handled:
 *   - BI … ID <data> EI  (inline image, PDF §8.9.7)
 *   - Nested arrays  [ … ]
 *   - Nested dicts   << … >>  (rare in content streams, used in inline images)
 */

import {
  PDFObjectType,
  createDict,
  createName,
  createNumber,
  createArray,
} from '../objects/types';
import type {
  PDFObject,
  PDFDictionary,
  PDFArray,
} from '../objects/types';
import type { ContentOperator } from './operators';

// ---------------------------------------------------------------------------
// Byte constants
// ---------------------------------------------------------------------------

/** Returns true for PDF whitespace bytes (PDF §7.2.2). */
function isWS(b: number): boolean {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x20;
}

/** Returns true for Latin-1 digit bytes 0–9. */
function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

/**
 * Inline image object — carried as a synthetic operand on the 'BI' operator.
 * Not part of the standard PDFObject union; we embed it as a PDFDictionary
 * for the dict and a separate Uint8Array field attached to the operator's
 * `extra` field.  Instead we encode it into the operands as:
 *   operands[0] = PDFDictionary (parameter dict)
 *   operands[1] = PDFArray of PDFNumber (one byte value per image data byte)
 *
 * This avoids introducing a new PDFObject variant while still carrying all
 * information needed by the rendering layer.
 *
 * Upper layers that handle 'BI' operators should interpret:
 *   - operands[0] as the image parameter dictionary
 *   - operator.inlineImageData (see ContentOperatorWithInlineImage) as the raw pixel bytes
 *
 * We attach the raw bytes as a non-enumerable property on the operator object
 * through the extended interface below.
 */

/**
 * Extended ContentOperator that carries raw inline image data.
 * The `inlineImageData` field is set only when `name === 'BI'`.
 */
export interface ContentOperatorWithInlineImage extends ContentOperator {
  inlineImageData: Uint8Array;
}

export function isInlineImageOperator(
  op: ContentOperator,
): op is ContentOperatorWithInlineImage {
  return op.name === 'BI' && 'inlineImageData' in op;
}

// ---------------------------------------------------------------------------
// Known PDF content stream operator keywords
// ---------------------------------------------------------------------------

const KNOWN_OPERATORS = new Set<string>([
  // Text
  'BT', 'ET', 'Tf', 'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"',
  'Tc', 'Tw', 'TL', 'Tr', 'Ts', 'Tz',
  // Graphics state
  'q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs',
  // Path construction
  'm', 'l', 'c', 'v', 'y', 'h', 're',
  // Path painting
  'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'W', 'W*',
  // Colour
  'CS', 'cs', 'SC', 'SCN', 'sc', 'scn',
  'G', 'g', 'RG', 'rg', 'K', 'k',
  // XObject
  'Do',
  // Inline image
  'BI', 'ID', 'EI',
  // Marked content
  'BMC', 'BDC', 'EMC', 'MP', 'DP',
  // Shading / type 3 glyph
  'sh', 'd0', 'd1',
  // Compatibility
  'BX', 'EX',
]);

// ---------------------------------------------------------------------------
// ContentStreamTokenizer
// ---------------------------------------------------------------------------

export class ContentStreamTokenizer {
  private readonly data: Uint8Array;
  private pos: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Parse the entire content stream and return the ordered list of operators.
   *
   * Each ContentOperator carries:
   *   - name:      operator keyword
   *   - operands:  parsed PDFObject values (left to right)
   *   - raw:       source bytes from the start of the first operand (or the
   *                keyword when there are no operands) through the last byte
   *                of the keyword
   *   - offset:    byte offset of `raw[0]` within the content stream
   *   - modified:  false (set to true by editing layers when content changes)
   */
  tokenize(): ContentOperator[] {
    const operators: ContentOperator[] = [];
    const operands: PDFObject[] = [];

    this.pos = 0;
    this.skipWhitespace();
    let groupStart = this.pos;

    while (this.pos < this.data.length) {
      const b = this.data[this.pos];

      // --- Literal string (…) ---
      if (b === 0x28) {
        operands.push(this.parseLiteralString());
        this.skipWhitespace();
        continue;
      }

      // --- Hex string <…> or dict <<…>> ---
      if (b === 0x3c) {
        if (this.data[this.pos + 1] === 0x3c) {
          operands.push(this.parseDictionary());
        } else {
          operands.push(this.parseHexString());
        }
        this.skipWhitespace();
        continue;
      }

      // --- Name /Name ---
      if (b === 0x2f) {
        operands.push(this.parseName());
        this.skipWhitespace();
        continue;
      }

      // --- Array […] ---
      if (b === 0x5b) {
        operands.push(this.parseArray());
        this.skipWhitespace();
        continue;
      }

      // --- Stray closing ] — skip defensively ---
      if (b === 0x5d) {
        this.pos += 1;
        this.skipWhitespace();
        continue;
      }

      // --- Possible number ---
      if (
        isDigit(b) ||
        b === 0x2b || // '+'
        b === 0x2d || // '-'
        b === 0x2e    // '.'
      ) {
        const numObj = this.tryParseNumber();
        if (numObj !== null) {
          operands.push(numObj);
          this.skipWhitespace();
          continue;
        }
        // Not a number — fall through to keyword handling
      }

      // --- Keyword token ---
      const kwStart = this.pos;
      const token = this.readToken();
      if (token === '') break; // EOF

      if (token === 'BI') {
        // Inline image — consume everything up to and including EI
        operands.length = 0; // BI should have no preceding operands
        groupStart = kwStart;
        const inlineOp = this.readInlineImage(kwStart);
        operators.push(inlineOp);
        this.skipWhitespace();
        groupStart = this.pos;
        continue;
      }

      if (this.isOperator(token)) {
        const raw = this.data.slice(groupStart, this.pos);
        operators.push({
          name: token,
          operands: operands.splice(0),
          raw,
          offset: groupStart,
          modified: false,
        });
        this.skipWhitespace();
        groupStart = this.pos;
      } else {
        // Unknown token that isn't a recognised object type.
        // Re-attempt parse as a float (handles scientific notation etc.).
        const numVal = parseFloat(token);
        if (!isNaN(numVal) && isFinite(numVal)) {
          operands.push(createNumber(numVal));
        } else {
          // Treat as an unknown operator to keep the stack clean.
          const raw = this.data.slice(groupStart, this.pos);
          operators.push({
            name: token,
            operands: operands.splice(0),
            raw,
            offset: groupStart,
            modified: false,
          });
          groupStart = this.pos;
        }
        this.skipWhitespace();
      }
    }

    return operators;
  }

  // -------------------------------------------------------------------------
  // Whitespace
  // -------------------------------------------------------------------------

  private skipWhitespace(): void {
    while (this.pos < this.data.length) {
      const b = this.data[this.pos];
      if (isWS(b)) {
        this.pos += 1;
      } else if (b === 0x25) {
        // '%' comment — skip to end of line
        this.pos += 1;
        while (this.pos < this.data.length) {
          const c = this.data[this.pos];
          this.pos += 1;
          if (c === 0x0a || c === 0x0d) break;
        }
      } else {
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Raw token reader (for operator keywords)
  // -------------------------------------------------------------------------

  /**
   * Read a whitespace/delimiter-delimited token starting at `this.pos`.
   * The caller must have already consumed leading whitespace.
   * Returns an empty string at EOF.
   */
  private readToken(): string {
    const start = this.pos;
    while (this.pos < this.data.length) {
      const b = this.data[this.pos];
      if (
        isWS(b) ||
        b === 0x28 || b === 0x29 || // ( )
        b === 0x3c || b === 0x3e || // < >
        b === 0x5b || b === 0x5d || // [ ]
        b === 0x2f ||               // /
        b === 0x25                  // %
      ) {
        break;
      }
      this.pos += 1;
    }
    return latin1Slice(this.data, start, this.pos);
  }

  // -------------------------------------------------------------------------
  // Number parsing
  // -------------------------------------------------------------------------

  /**
   * Attempt to parse a PDF numeric object at `this.pos`.
   * Returns null if the token is not a clean number; `this.pos` is left
   * unchanged on failure.
   */
  private tryParseNumber(): PDFObject | null {
    const start = this.pos;
    let digitCount = 0;

    // Optional sign
    if (
      this.pos < this.data.length &&
      (this.data[this.pos] === 0x2b || this.data[this.pos] === 0x2d)
    ) {
      this.pos += 1;
    }

    // Digits before optional decimal point
    while (this.pos < this.data.length && isDigit(this.data[this.pos])) {
      this.pos += 1;
      digitCount += 1;
    }

    // Optional decimal point followed by more digits
    if (this.pos < this.data.length && this.data[this.pos] === 0x2e) {
      this.pos += 1;
      while (this.pos < this.data.length && isDigit(this.data[this.pos])) {
        this.pos += 1;
        digitCount += 1;
      }
    }

    // Must be followed by whitespace or a delimiter
    const next = this.pos < this.data.length ? this.data[this.pos] : 0x20;
    const terminated =
      isWS(next) ||
      next === 0x28 || next === 0x29 ||
      next === 0x3c || next === 0x3e ||
      next === 0x5b || next === 0x5d ||
      next === 0x2f || next === 0x25;

    if (!terminated || digitCount === 0) {
      this.pos = start;
      return null;
    }

    const str = latin1Slice(this.data, start, this.pos);
    return createNumber(parseFloat(str));
  }

  // -------------------------------------------------------------------------
  // PDFObject parsers
  // -------------------------------------------------------------------------

  /**
   * Parse a literal PDF string beginning with '(' at `this.pos`.
   */
  private parseLiteralString(): PDFObject {
    this.pos += 1; // skip '('
    const bytes: number[] = [];
    let depth = 1;

    while (this.pos < this.data.length && depth > 0) {
      const b = this.data[this.pos];

      if (b === 0x5c) {
        // Backslash escape
        this.pos += 1;
        if (this.pos >= this.data.length) break;
        const esc = this.data[this.pos];
        this.pos += 1;
        switch (esc) {
          case 0x6e: bytes.push(0x0a); break; // \n
          case 0x72: bytes.push(0x0d); break; // \r
          case 0x74: bytes.push(0x09); break; // \t
          case 0x62: bytes.push(0x08); break; // \b
          case 0x66: bytes.push(0x0c); break; // \f
          case 0x28: bytes.push(0x28); break; // \(
          case 0x29: bytes.push(0x29); break; // \)
          case 0x5c: bytes.push(0x5c); break; // \\
          case 0x0d:
            // Line continuation \<CR> or \<CRLF>
            if (this.pos < this.data.length && this.data[this.pos] === 0x0a) {
              this.pos += 1;
            }
            break;
          case 0x0a:
            // Line continuation \<LF>
            break;
          default:
            if (esc >= 0x30 && esc <= 0x37) {
              // Octal escape \ddd
              let octal = esc - 0x30;
              for (let i = 0; i < 2 && this.pos < this.data.length; i++) {
                const d = this.data[this.pos];
                if (d < 0x30 || d > 0x37) break;
                octal = octal * 8 + (d - 0x30);
                this.pos += 1;
              }
              bytes.push(octal & 0xff);
            } else {
              bytes.push(esc);
            }
        }
      } else if (b === 0x28) {
        // Nested '('
        depth += 1;
        bytes.push(b);
        this.pos += 1;
      } else if (b === 0x29) {
        depth -= 1;
        if (depth > 0) bytes.push(b);
        this.pos += 1;
      } else {
        bytes.push(b);
        this.pos += 1;
      }
    }

    const raw = new Uint8Array(bytes);
    // Build the decoded Latin-1 string value
    let value = '';
    for (const byte of bytes) {
      value += String.fromCharCode(byte);
    }
    const obj: import('../objects/types').PDFString = {
      type: PDFObjectType.String,
      value,
      raw,
    };
    return obj;
  }

  /**
   * Parse a hex string beginning with '<' at `this.pos`.
   */
  private parseHexString(): PDFObject {
    this.pos += 1; // skip '<'
    let rawHex = '';
    const bytes: number[] = [];

    while (this.pos < this.data.length) {
      const b = this.data[this.pos];
      if (b === 0x3e) { // '>'
        this.pos += 1;
        break;
      }
      if (isWS(b)) {
        this.pos += 1;
        continue;
      }
      const hi = hexDigit(b);
      rawHex += String.fromCharCode(b);
      this.pos += 1;
      let lo = 0;
      if (this.pos < this.data.length && this.data[this.pos] !== 0x3e) {
        const b2 = this.data[this.pos];
        if (!isWS(b2)) {
          lo = hexDigit(b2);
          rawHex += String.fromCharCode(b2);
          this.pos += 1;
        }
      }
      bytes.push((hi << 4) | lo);
    }

    let value = '';
    for (const byte of bytes) value += String.fromCharCode(byte);

    const obj: import('../objects/types').PDFHexString = {
      type: PDFObjectType.HexString,
      value,
      raw: rawHex,
    };
    return obj;
  }

  /**
   * Parse a PDF name beginning with '/' at `this.pos`.
   * Resolves #xx escape sequences per PDF §7.3.5.
   */
  private parseName(): PDFObject {
    this.pos += 1; // skip '/'
    const chars: number[] = [];

    while (this.pos < this.data.length) {
      const b = this.data[this.pos];
      if (
        isWS(b) ||
        b === 0x28 || b === 0x29 ||
        b === 0x3c || b === 0x3e ||
        b === 0x5b || b === 0x5d ||
        b === 0x7b || b === 0x7d ||
        b === 0x2f || b === 0x25
      ) {
        break;
      }
      if (b === 0x23 && this.pos + 2 < this.data.length) {
        // '#xx' escape
        chars.push(
          (hexDigit(this.data[this.pos + 1]) << 4) |
          hexDigit(this.data[this.pos + 2]),
        );
        this.pos += 3;
      } else {
        chars.push(b);
        this.pos += 1;
      }
    }

    return createName(String.fromCharCode(...chars));
  }

  /**
   * Parse a PDF array beginning with '[' at `this.pos`.
   */
  private parseArray(): PDFObject {
    this.pos += 1; // skip '['
    this.skipWhitespace();
    const items: PDFObject[] = [];

    while (this.pos < this.data.length) {
      if (this.data[this.pos] === 0x5d) { // ']'
        this.pos += 1;
        break;
      }
      const item = this.parseArrayElement();
      if (item !== null) items.push(item);
      this.skipWhitespace();
    }

    return createArray(items);
  }

  /**
   * Parse one element inside an array or dictionary-value context.
   * Returns null when an unexpected delimiter is encountered.
   */
  private parseArrayElement(): PDFObject | null {
    if (this.pos >= this.data.length) return null;
    const b = this.data[this.pos];

    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x2f) return this.parseName();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x3c) {
      if (this.data[this.pos + 1] === 0x3c) return this.parseDictionary();
      return this.parseHexString();
    }

    const numObj = this.tryParseNumber();
    if (numObj !== null) return numObj;

    // Keyword-like tokens inside arrays
    const saved = this.pos;
    const token = this.readToken();
    if (token === 'true') return { type: PDFObjectType.Boolean, value: true };
    if (token === 'false') return { type: PDFObjectType.Boolean, value: false };
    if (token === 'null') return { type: PDFObjectType.Null };
    if (token === '') return null;

    // Unrecognised token — rewind and skip one byte to avoid infinite loop
    this.pos = saved + 1;
    return null;
  }

  /**
   * Parse a PDF dictionary beginning with '<<' at `this.pos`.
   * Used for inline image parameter dicts and rare operand dicts.
   */
  private parseDictionary(): PDFObject {
    this.pos += 2; // skip '<<'
    this.skipWhitespace();
    const pairs: [string, PDFObject][] = [];

    while (this.pos < this.data.length) {
      // Check for '>>'
      if (
        this.data[this.pos] === 0x3e &&
        this.pos + 1 < this.data.length &&
        this.data[this.pos + 1] === 0x3e
      ) {
        this.pos += 2;
        break;
      }

      if (this.data[this.pos] !== 0x2f) {
        // Malformed: expected a name key
        this.pos += 1;
        this.skipWhitespace();
        continue;
      }

      const keyObj = this.parseName();
      if (keyObj.type !== PDFObjectType.Name) break;
      const key = keyObj.value;
      this.skipWhitespace();

      const value = this.parseArrayElement();
      if (value !== null) pairs.push([key, value]);
      this.skipWhitespace();
    }

    return createDict(pairs);
  }

  // -------------------------------------------------------------------------
  // Inline image (BI … ID <data> EI)
  // -------------------------------------------------------------------------

  /**
   * Read an inline image starting just after the 'BI' keyword was identified.
   * `biOffset` is the byte offset of 'B' in 'BI' within the content stream.
   *
   * The result is a ContentOperatorWithInlineImage whose operands[0] is the
   * parameter dictionary and whose `inlineImageData` field carries the raw
   * image bytes.
   *
   * PDF 32000-1:2008 §8.9.7
   */
  private readInlineImage(biOffset: number): ContentOperator {
    this.skipWhitespace();

    // --- Read key-value pairs until 'ID' ---
    const pairs: [string, PDFObject][] = [];

    while (this.pos < this.data.length) {
      this.skipWhitespace();
      if (this.pos >= this.data.length) break;

      const b = this.data[this.pos];

      if (b === 0x2f) {
        // Named key
        const keyObj = this.parseName();
        if (keyObj.type !== PDFObjectType.Name) break;
        this.skipWhitespace();
        const val = this.parseArrayElement();
        if (val !== null) pairs.push([keyObj.value, val]);
        continue;
      }

      // Non-name token — should be 'ID'
      const token = this.readToken();
      if (token === 'ID') break;

      // Abbreviated (no-slash) key — read value
      if (token !== '') {
        this.skipWhitespace();
        const val = this.parseArrayElement();
        if (val !== null) pairs.push([token, val]);
      }
    }

    // Skip exactly one whitespace byte after 'ID'
    if (this.pos < this.data.length && isWS(this.data[this.pos])) {
      this.pos += 1;
    }

    // --- Scan forward for whitespace + 'EI' + whitespace/delimiter/EOF ---
    const dataStart = this.pos;
    let dataEnd = dataStart;

    while (this.pos < this.data.length) {
      if (
        isWS(this.data[this.pos]) ||
        this.pos === dataStart
      ) {
        const checkAt = this.pos === dataStart ? dataStart : this.pos + 1;
        if (
          checkAt + 2 <= this.data.length &&
          this.data[checkAt] === 0x45 && // 'E'
          this.data[checkAt + 1] === 0x49 // 'I'
        ) {
          const after = checkAt + 2;
          if (
            after >= this.data.length ||
            isWS(this.data[after]) ||
            this.data[after] === 0x25 // '%'
          ) {
            dataEnd = this.pos === dataStart ? dataStart : this.pos;
            this.pos = after;
            break;
          }
        }
      }
      this.pos += 1;
    }

    const imageData = this.data.slice(dataStart, dataEnd);
    const paramDict = createDict(pairs) as PDFDictionary;

    const op: ContentOperatorWithInlineImage = {
      name: 'BI',
      operands: [paramDict],
      raw: this.data.slice(biOffset, this.pos),
      offset: biOffset,
      modified: false,
      inlineImageData: imageData,
    };
    return op;
  }

  // -------------------------------------------------------------------------
  // Operator classification
  // -------------------------------------------------------------------------

  /**
   * Return true when `token` should be treated as an operator keyword.
   *
   * Heuristic:
   *   1. In KNOWN_OPERATORS → always an operator.
   *   2. Starts with a digit, sign, or dot → not an operator (it is a number
   *      that tryParseNumber failed on, or a malformed number — emit as operand).
   *   3. Anything else → unknown operator (keeps the operand stack clean).
   */
  private isOperator(token: string): boolean {
    if (token === '') return false;
    if (KNOWN_OPERATORS.has(token)) return true;

    const first = token.charCodeAt(0);
    if (isDigit(first) || first === 0x2b || first === 0x2d || first === 0x2e) {
      return false;
    }

    return true; // unknown operator
  }
}

// -------------------------------------------------------------------------
// Module-level helpers
// -------------------------------------------------------------------------

/** Decode a Latin-1 slice of a Uint8Array into a JS string. */
function latin1Slice(data: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) {
    s += String.fromCharCode(data[i]);
  }
  return s;
}

/** Convert one ASCII hex character byte (0–9, A–F, a–f) to its value. */
function hexDigit(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return 0;
}

// Re-export PDFArray so callers can use it without importing objects/types directly
export type { PDFArray };

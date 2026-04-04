/**
 * L1 Object Layer — PDF Object Parser
 *
 * Tokenizes and parses PDF objects from a ByteStreamReader.
 * Implements the grammar described in PDF 32000-1:2008 §7.3.
 *
 * Parsing responsibilities:
 *   - Literal strings `(...)` with nested parens and all escape sequences
 *   - Hex strings `<...>`
 *   - Names `/...` with `#xx` escape resolution
 *   - Arrays `[...]`
 *   - Dictionaries `<<...>>` — auto-promoted to PDFStream when `stream` follows
 *   - Indirect references `N G R`
 *   - Numbers (integer and real)
 *   - Keywords: `null`, `true`, `false`, `obj`, `endobj`
 */

import { ByteStreamReader } from '../binary/reader.ts';
import {
  type PDFObject,
  type PDFDictionary,
  type PDFStream,
  type PDFArray,
  type PDFNumber,
  type PDFName,
  type PDFString,
  type PDFHexString,
  PDFObjectType,
  PDF_NULL,
  createDict,
  createRef,
} from './types.ts';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder('latin1');

/** PDF whitespace bytes: NUL, TAB, LF, FF, CR, SPACE */
const WHITESPACE = new Set<number>([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

const DELIMITERS = new Set<number>([
  0x28, 0x29, // ( )
  0x3c, 0x3e, // < >
  0x5b, 0x5d, // [ ]
  0x7b, 0x7d, // { }
  0x2f,       // /
  0x25,       // %
]);

function isWhitespace(b: number): boolean {
  return WHITESPACE.has(b);
}

function isDelimiter(b: number): boolean {
  return DELIMITERS.has(b);
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39; // '0'–'9'
}

function isOctalDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x37; // '0'–'7'
}

function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;        // 0-9
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;  // A-F
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;  // a-f
  return 0;
}

// ---------------------------------------------------------------------------
// PDFParser
// ---------------------------------------------------------------------------

export class PDFParser {
  readonly reader: ByteStreamReader;

  constructor(reader: ByteStreamReader) {
    this.reader = reader;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Parse the next PDF object at the current reader position.
   * Leading whitespace and comments are skipped automatically.
   */
  parseObject(): PDFObject {
    this.skipWhitespaceAndComments();

    if (this.reader.isEOF()) {
      throw new Error('PDFParser.parseObject: unexpected end of file');
    }

    const b = this.reader.peek();

    // Number or indirect reference: digit or sign
    if (isDigit(b) || b === 0x2b /* '+' */ || b === 0x2d /* '-' */ || b === 0x2e /* '.' */) {
      return this.parseNumberOrRef();
    }

    switch (b) {
      case 0x2f: // '/'
        return this.parseName();
      case 0x28: // '('
        return this.parseLiteralString();
      case 0x3c: { // '<'
        // Could be hex string '<...' or dictionary '<<...'
        const next = this.reader.peek(1);
        if (next === 0x3c) {
          return this.parseDictionaryOrStream();
        }
        return this.parseHexString();
      }
      case 0x5b: // '['
        return this.parseArray();
      default: {
        // Keyword: null, true, false — or unknown
        const keyword = this.readKeyword();
        switch (keyword) {
          case 'null':
            return PDF_NULL;
          case 'true':
            return { type: PDFObjectType.Boolean, value: true };
          case 'false':
            return { type: PDFObjectType.Boolean, value: false };
          default:
            throw new Error(
              `PDFParser.parseObject: unexpected token "${keyword}" at position ${this.reader.position}`,
            );
        }
      }
    }
  }

  /**
   * Parse an indirect object definition: `N G obj ... endobj`.
   * The reader must be positioned at the start of the object number.
   */
  parseIndirectObject(): { objNum: number; genNum: number; obj: PDFObject } {
    this.skipWhitespaceAndComments();

    const objNum = this.readInteger();
    this.skipWhitespaceAndComments();
    const genNum = this.readInteger();
    this.skipWhitespaceAndComments();

    const keyword = this.readKeyword();
    if (keyword !== 'obj') {
      throw new Error(
        `PDFParser.parseIndirectObject: expected "obj" keyword, got "${keyword}" at position ${this.reader.position}`,
      );
    }

    const obj = this.parseObject();

    this.skipWhitespaceAndComments();

    // Consume optional 'endobj'
    if (!this.reader.isEOF()) {
      const saved = this.reader.position;
      const end = this.readKeyword();
      if (end !== 'endobj') {
        // Not endobj — put position back (stream keyword may have consumed it)
        this.reader.seek(saved);
      }
    }

    return { objNum, genNum, obj };
  }

  /**
   * Seek to `offset`, then parse an indirect object definition.
   */
  parseObjectAt(offset: number): { objNum: number; genNum: number; obj: PDFObject } {
    this.reader.seek(offset);
    return this.parseIndirectObject();
  }

  // -------------------------------------------------------------------------
  // Number / indirect reference
  // -------------------------------------------------------------------------

  /**
   * Attempt to parse either:
   *   - an indirect reference `N G R`
   *   - a plain number
   *
   * Two-token lookahead strategy:
   *   if current token is integer, next token is also integer, and the token
   *   after that is the single character 'R', we have an indirect reference.
   */
  private parseNumberOrRef(): PDFObject {
    const firstToken = this.readNumericToken();

    // Check whether this looks like an integer (no decimal point or exponent)
    const firstIsInteger =
      !firstToken.includes('.') &&
      !firstToken.includes('e') &&
      !firstToken.includes('E');

    if (!firstIsInteger) {
      return { type: PDFObjectType.Number, value: parseFloat(firstToken) };
    }

    // Save position after first number
    const afterFirst = this.reader.position;
    this.skipWhitespaceAndComments();

    if (this.reader.isEOF() || !isDigit(this.reader.peek())) {
      // Not enough tokens for a ref — return first as number
      this.reader.seek(afterFirst);
      return { type: PDFObjectType.Number, value: parseInt(firstToken, 10) };
    }

    const secondToken = this.readNumericToken();
    const secondIsInteger =
      !secondToken.includes('.') &&
      !secondToken.includes('e') &&
      !secondToken.includes('E');

    if (!secondIsInteger) {
      // Second token is a float — back up to after first and return first
      this.reader.seek(afterFirst);
      return { type: PDFObjectType.Number, value: parseInt(firstToken, 10) };
    }

    this.skipWhitespaceAndComments();

    // Peek at next byte: is it 'R'?
    if (!this.reader.isEOF() && this.reader.peek() === 0x52 /* 'R' */) {
      // Tentatively consume 'R'
      const savedBeforeR = this.reader.position;
      this.reader.seek(this.reader.position + 1);
      const afterR = this.reader.position;

      // 'R' must be followed by whitespace, delimiter, or EOF
      if (
        afterR >= this.reader.length ||
        isWhitespace(this.reader.peek()) ||
        isDelimiter(this.reader.peek())
      ) {
        return createRef(parseInt(firstToken, 10), parseInt(secondToken, 10));
      }

      // Not a ref — rewind to before 'R'
      this.reader.seek(savedBeforeR);
    }

    // Not a ref — rewind to after first number and return it
    this.reader.seek(afterFirst);
    return { type: PDFObjectType.Number, value: parseInt(firstToken, 10) };
  }

  /** Read a raw numeric token string (sign, digits, optional decimal part). */
  private readNumericToken(): string {
    let token = '';
    const sign = this.reader.peek();

    // Optional leading sign
    if (sign === 0x2b /* '+' */ || sign === 0x2d /* '-' */) {
      token += String.fromCharCode(sign);
      this.reader.readByte();
    }

    // Digits before decimal point
    while (!this.reader.isEOF() && isDigit(this.reader.peek())) {
      token += String.fromCharCode(this.reader.readByte());
    }

    // Optional decimal part
    if (!this.reader.isEOF() && this.reader.peek() === 0x2e /* '.' */) {
      token += '.';
      this.reader.readByte();
      while (!this.reader.isEOF() && isDigit(this.reader.peek())) {
        token += String.fromCharCode(this.reader.readByte());
      }
    }

    return token;
  }

  // -------------------------------------------------------------------------
  // parseNumber (public — exposed for object-stream header parsing)
  // -------------------------------------------------------------------------

  /** Parse a number at the current position and return it. */
  parseNumber(): PDFNumber {
    const token = this.readNumericToken();
    const value = token.includes('.') ? parseFloat(token) : parseInt(token, 10);
    return { type: PDFObjectType.Number, value };
  }

  // -------------------------------------------------------------------------
  // parseName (public — used by parseDictionary and external callers)
  // -------------------------------------------------------------------------

  parseName(): PDFName {
    // Consume leading '/'
    this.reader.readByte();

    let name = '';
    while (!this.reader.isEOF()) {
      const b = this.reader.peek();
      if (isWhitespace(b) || isDelimiter(b)) break;

      if (b === 0x23 /* '#' */) {
        // Hex escape: #XX
        this.reader.readByte(); // consume '#'
        const hi = this.reader.readByte();
        const lo = this.reader.readByte();
        name += String.fromCharCode((hexVal(hi) << 4) | hexVal(lo));
      } else {
        name += String.fromCharCode(b);
        this.reader.readByte();
      }
    }

    return { type: PDFObjectType.Name, value: name };
  }

  // -------------------------------------------------------------------------
  // parseLiteralString
  // -------------------------------------------------------------------------

  parseLiteralString(): PDFString {
    this.reader.readByte(); // consume '('

    const bytes: number[] = [];
    let depth = 1;

    while (!this.reader.isEOF() && depth > 0) {
      const b = this.reader.readByte();

      if (b === 0x28 /* '(' */) {
        depth++;
        bytes.push(b);
      } else if (b === 0x29 /* ')' */) {
        depth--;
        if (depth > 0) bytes.push(b);
      } else if (b === 0x5c /* '\\' */) {
        // Escape sequence
        if (this.reader.isEOF()) break;
        const esc = this.reader.readByte();
        switch (esc) {
          case 0x6e: bytes.push(0x0a); break; // \n → LF
          case 0x72: bytes.push(0x0d); break; // \r → CR
          case 0x74: bytes.push(0x09); break; // \t → TAB
          case 0x62: bytes.push(0x08); break; // \b → BS
          case 0x66: bytes.push(0x0c); break; // \f → FF
          case 0x5c: bytes.push(0x5c); break; // \\ → '\'
          case 0x28: bytes.push(0x28); break; // \( → '('
          case 0x29: bytes.push(0x29); break; // \) → ')'
          case 0x0d: {                          // \CR — ignore line break
            if (!this.reader.isEOF() && this.reader.peek() === 0x0a) {
              this.reader.readByte(); // consume following LF
            }
            break;
          }
          case 0x0a: break;                     // \LF — ignore line break
          default: {
            if (isOctalDigit(esc)) {
              // Octal escape: up to 3 digits
              let octal = esc - 0x30;
              if (!this.reader.isEOF() && isOctalDigit(this.reader.peek())) {
                octal = octal * 8 + (this.reader.readByte() - 0x30);
              }
              if (!this.reader.isEOF() && isOctalDigit(this.reader.peek())) {
                octal = octal * 8 + (this.reader.readByte() - 0x30);
              }
              bytes.push(octal & 0xff);
            } else {
              // Unknown escape — treat as literal character per PDF spec §7.3.4.2
              bytes.push(esc);
            }
          }
        }
      } else {
        bytes.push(b);
      }
    }

    const raw = new Uint8Array(bytes);
    const value = textDecoder.decode(raw);
    return { type: PDFObjectType.String, value, raw };
  }

  // -------------------------------------------------------------------------
  // parseHexString
  // -------------------------------------------------------------------------

  parseHexString(): PDFHexString {
    this.reader.readByte(); // consume '<'

    let rawHex = '';

    while (!this.reader.isEOF()) {
      const b = this.reader.peek();
      if (b === 0x3e /* '>' */) {
        this.reader.readByte(); // consume '>'
        break;
      }
      if (isWhitespace(b)) {
        this.reader.readByte();
        continue;
      }
      rawHex += String.fromCharCode(b);
      this.reader.readByte();
    }

    // Odd-length hex: append '0' per PDF spec §7.3.4.3
    const hexPadded = rawHex.length % 2 === 0 ? rawHex : rawHex + '0';
    const bytes: number[] = [];

    for (let i = 0; i < hexPadded.length; i += 2) {
      const hiCode = hexPadded.charCodeAt(i);
      const loCode = hexPadded.charCodeAt(i + 1);
      bytes.push((hexVal(hiCode) << 4) | hexVal(loCode));
    }

    const value = textDecoder.decode(new Uint8Array(bytes));
    return { type: PDFObjectType.HexString, value, raw: rawHex };
  }

  // -------------------------------------------------------------------------
  // parseArray
  // -------------------------------------------------------------------------

  parseArray(): PDFArray {
    this.reader.readByte(); // consume '['
    const items: PDFObject[] = [];

    while (true) {
      this.skipWhitespaceAndComments();
      if (this.reader.isEOF()) {
        throw new Error('PDFParser.parseArray: unexpected end of file inside array');
      }
      if (this.reader.peek() === 0x5d /* ']' */) {
        this.reader.readByte();
        break;
      }
      items.push(this.parseObject());
    }

    return { type: PDFObjectType.Array, items };
  }

  // -------------------------------------------------------------------------
  // parseDictionary (public — used directly by object-stream resolution)
  // -------------------------------------------------------------------------

  parseDictionary(): PDFDictionary {
    // Consume '<<'
    this.reader.readByte();
    this.reader.readByte();

    const pairs: [string, PDFObject][] = [];

    while (true) {
      this.skipWhitespaceAndComments();
      if (this.reader.isEOF()) {
        throw new Error('PDFParser.parseDictionary: unexpected end of file inside dictionary');
      }

      // Check for '>>'
      if (this.reader.peek() === 0x3e && this.reader.peek(1) === 0x3e) {
        this.reader.readByte();
        this.reader.readByte();
        break;
      }

      // Key must be a name
      if (this.reader.peek() !== 0x2f /* '/' */) {
        throw new Error(
          `PDFParser.parseDictionary: expected name key (/) at position ${this.reader.position}, ` +
          `got byte 0x${this.reader.peek().toString(16)}`,
        );
      }
      const key = this.parseName();
      const value = this.parseObject();
      pairs.push([key.value, value]);
    }

    return createDict(pairs);
  }

  // -------------------------------------------------------------------------
  // parseStream (public — used by resolver for object streams)
  // -------------------------------------------------------------------------

  parseStream(dict: PDFDictionary): PDFStream {
    // Consume 'stream' keyword (caller has already confirmed it is next)
    this.readKeyword();

    // The stream data begins after exactly one end-of-line:
    // either LF (0x0A) or CR LF (0x0D 0x0A) per PDF spec §7.3.8.1.
    const eol = this.reader.readByte();
    if (eol === 0x0d /* CR */) {
      if (!this.reader.isEOF() && this.reader.peek() === 0x0a) {
        this.reader.readByte(); // consume LF of CRLF
      }
    } else if (eol !== 0x0a /* LF */) {
      throw new Error(
        `PDFParser.parseStream: expected line ending after "stream" keyword, ` +
        `got 0x${eol.toString(16)}`,
      );
    }

    const streamStart = this.reader.position;

    // Determine stream length from /Length entry
    const lengthObj = dict.get('Length');
    let rawData: Uint8Array;

    if (lengthObj !== undefined && lengthObj.type === PDFObjectType.Number) {
      rawData = this.reader.readBytes(lengthObj.value);
    } else {
      // Fallback: scan forward for 'endstream'
      rawData = this.scanToEndstream(streamStart);
    }

    // Skip optional whitespace then 'endstream'
    this.skipWhitespaceAndComments();
    if (!this.reader.isEOF()) {
      const saved = this.reader.position;
      const kw = this.readKeyword();
      if (kw !== 'endstream') {
        // Best-effort recovery — restore position
        this.reader.seek(saved);
      }
    }

    return {
      type: PDFObjectType.Stream,
      dict,
      rawData,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Parse `<<...>>` and then check if `stream` keyword follows.
   * If yes, delegate to parseStream; otherwise return the dictionary.
   */
  private parseDictionaryOrStream(): PDFObject {
    const dict = this.parseDictionary();

    // Peek ahead for 'stream' keyword
    const savedPos = this.reader.position;
    this.skipWhitespaceAndComments();

    if (!this.reader.isEOF() && this.peekKeyword() === 'stream') {
      return this.parseStream(dict);
    }

    // Not a stream — restore position (preserve whitespace for next call)
    this.reader.seek(savedPos);
    return dict;
  }

  /**
   * Scan forward from `startPos` looking for the byte sequence `endstream`,
   * returning all bytes before it (trimming trailing CR/LF).
   */
  private scanToEndstream(startPos: number): Uint8Array {
    const marker = new TextEncoder().encode('endstream');
    let pos = startPos;

    outer: while (pos + marker.length <= this.reader.length) {
      for (let j = 0; j < marker.length; j++) {
        if (this.reader.buffer[pos + j] !== marker[j]) {
          pos++;
          continue outer;
        }
      }
      // Found endstream — trim trailing CR/LF before it
      let end = pos;
      while (
        end > startPos &&
        (this.reader.buffer[end - 1] === 0x0a || this.reader.buffer[end - 1] === 0x0d)
      ) {
        end--;
      }
      this.reader.seek(pos);
      return this.reader.slice(startPos, end);
    }

    throw new Error('PDFParser.scanToEndstream: "endstream" marker not found');
  }

  /** Skip PDF whitespace bytes and comments (`%` through end-of-line). */
  private skipWhitespaceAndComments(): void {
    while (!this.reader.isEOF()) {
      const b = this.reader.peek();
      if (isWhitespace(b)) {
        this.reader.readByte();
      } else if (b === 0x25 /* '%' */) {
        this.reader.readByte();
        while (!this.reader.isEOF()) {
          const c = this.reader.readByte();
          if (c === 0x0a || c === 0x0d) break;
        }
      } else {
        break;
      }
    }
  }

  /** Peek at the next keyword without advancing the reader position. */
  private peekKeyword(): string {
    const saved = this.reader.position;
    const kw = this.readKeyword();
    this.reader.seek(saved);
    return kw;
  }

  /**
   * Read a keyword token (non-whitespace, non-delimiter characters) from the
   * current position. Stops at whitespace, delimiters, or EOF.
   */
  private readKeyword(): string {
    let kw = '';
    while (!this.reader.isEOF()) {
      const b = this.reader.peek();
      if (isWhitespace(b) || isDelimiter(b)) break;
      kw += String.fromCharCode(b);
      this.reader.readByte();
    }
    return kw;
  }

  /** Read a non-negative integer at the current position. Throws if none found. */
  private readInteger(): number {
    this.skipWhitespaceAndComments();
    let s = '';
    while (!this.reader.isEOF() && isDigit(this.reader.peek())) {
      s += String.fromCharCode(this.reader.readByte());
    }
    if (s.length === 0) {
      throw new Error(`PDFParser.readInteger: expected integer at position ${this.reader.position}`);
    }
    return parseInt(s, 10);
  }
}

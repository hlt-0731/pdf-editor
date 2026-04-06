/**
 * L0 Binary Layer — XRef (cross-reference) table / stream parser
 *
 * Handles both traditional cross-reference tables (PDF 1.0–1.4) and
 * cross-reference streams (PDF 1.5+).  The /Prev chain is followed
 * iteratively to collect all xref sections for incremental updates.
 *
 * Merge strategy: sections are visited oldest-first (by following /Prev to
 * the end of the chain, then iterating in reverse) so that newer revisions
 * overwrite older entries in the Map, matching PDF 32000-1:2008 §7.5.6.
 */

import type { ByteStreamReader } from './reader.ts';
import { decodeStream } from './stream.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface XRefEntry {
  /** Byte offset in file (type 1). Zero for free / compressed objects. */
  offset: number;
  /** Generation number. */
  generation: number;
  /** true = in use ('n' / type-1 / type-2), false = free ('f' / type-0). */
  inUse: boolean;
  /** true for compressed objects (PDF 1.5+ xref stream type-2 entries). */
  compressed?: boolean;
  /** Object number of the containing object stream (type-2). */
  streamObjNum?: number;
  /** Zero-based index within the object stream (type-2). */
  indexInStream?: number;
}

export interface PDFTrailer {
  /** /Size — total number of xref entries. */
  size: number;
  /** /Root indirect reference. */
  root: { objNum: number; genNum: number };
  /** /Info indirect reference (optional). */
  info?: { objNum: number; genNum: number };
  /** /Prev — byte offset of the previous xref section (for incremental updates). */
  prev?: number;
  /** /Encrypt indirect reference. */
  encrypt?: { objNum: number; genNum: number };
  /** /ID array — two opaque byte strings. */
  id?: [Uint8Array, Uint8Array];
}

export interface XRefTable {
  entries: Map<number, XRefEntry>;
  trailer: PDFTrailer;
}

// ---------------------------------------------------------------------------
// Minimal inline PDF value types
// Used only inside this module to avoid a circular dependency on the L1
// object layer (which is not yet built when the binary layer is loaded).
// ---------------------------------------------------------------------------

type PdfPrimitive =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: Uint8Array }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'array'; value: PdfPrimitive[] }
  | { kind: 'dict'; value: Map<string, PdfPrimitive> }
  | { kind: 'ref'; objNum: number; genNum: number };

// ---------------------------------------------------------------------------
// Minimal recursive-descent parser
// Parses just enough PDF syntax to read trailer dictionaries and xref
// stream headers: dicts, arrays, names, numbers, indirect refs, hex strings,
// literal strings, booleans and null.
// ---------------------------------------------------------------------------

class MiniPdfParser {
  private r: ByteStreamReader;

  constructor(reader: ByteStreamReader) {
    this.r = reader;
  }

  parseValue(): PdfPrimitive {
    this.r.skipWhitespace();
    const b = this.r.peek();
    if (b === -1) throw new Error('MiniPdfParser: unexpected EOF');

    if (b === 0x3c) {
      // '<' — dict '<<' or hex string '<…>'
      if (this.r.peek(1) === 0x3c) return this.parseDict();
      return this.parseHexString();
    }
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();  // '['
    if (b === 0x2f) return this.parseName();   // '/'
    if (isStartOfNumber(b)) return this.parseNumberOrRef();

    const token = this.r.readToken();
    if (token === 'true')  return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null')  return { kind: 'null' };
    throw new Error(`MiniPdfParser: unexpected token "${token}" at position ${this.r.position}`);
  }

  private parseDict(): PdfPrimitive {
    this.r.skip(2); // '<<'
    const map = new Map<string, PdfPrimitive>();
    for (;;) {
      this.r.skipWhitespace();
      if (this.r.peek() === 0x3e && this.r.peek(1) === 0x3e) {
        this.r.skip(2); // '>>'
        break;
      }
      if (this.r.isEOF()) throw new Error('MiniPdfParser: unterminated dictionary');
      const nameNode = this.parseName();
      const val = this.parseValue();
      map.set(nameNode.value, val);
    }
    return { kind: 'dict', value: map };
  }

  private parseArray(): PdfPrimitive {
    this.r.skip(1); // '['
    const items: PdfPrimitive[] = [];
    for (;;) {
      this.r.skipWhitespace();
      if (this.r.peek() === 0x5d) { // ']'
        this.r.skip(1);
        break;
      }
      if (this.r.isEOF()) throw new Error('MiniPdfParser: unterminated array');
      items.push(this.parseValue());
    }
    return { kind: 'array', value: items };
  }

  private parseName(): { kind: 'name'; value: string } {
    this.r.skip(1); // '/'
    const token = this.r.readToken();
    return { kind: 'name', value: token };
  }

  private parseHexString(): { kind: 'string'; value: Uint8Array } {
    this.r.skip(1); // '<'
    const bytes: number[] = [];
    for (;;) {
      this.r.skipWhitespace();
      const b = this.r.readByte();
      if (b === 0x3e) break; // '>'
      const hi = hexNibble(b);
      this.r.skipWhitespace();
      const b2 = this.r.peek();
      if (b2 === 0x3e) {
        // Odd number of hex digits — pad low nibble with 0
        this.r.skip(1);
        bytes.push(hi << 4);
        break;
      }
      bytes.push((hi << 4) | hexNibble(this.r.readByte()));
    }
    return { kind: 'string', value: new Uint8Array(bytes) };
  }

  private parseLiteralString(): { kind: 'string'; value: Uint8Array } {
    this.r.skip(1); // '('
    const bytes: number[] = [];
    let depth = 1;
    while (!this.r.isEOF()) {
      const b = this.r.readByte();
      if (b === 0x5c) {
        // backslash escape
        if (this.r.isEOF()) break;
        const esc = this.r.readByte();
        switch (esc) {
          case 0x6e: bytes.push(0x0a); break; // \n
          case 0x72: bytes.push(0x0d); break; // \r
          case 0x74: bytes.push(0x09); break; // \t
          case 0x62: bytes.push(0x08); break; // \b
          case 0x66: bytes.push(0x0c); break; // \f
          case 0x28: bytes.push(0x28); break; // \(
          case 0x29: bytes.push(0x29); break; // \)
          case 0x5c: bytes.push(0x5c); break; // \\
          case 0x0d: // \CR — ignore line continuation
            if (!this.r.isEOF() && this.r.peek() === 0x0a) this.r.skip(1);
            break;
          case 0x0a: break; // \LF — ignore line continuation
          default:
            if (esc >= 0x30 && esc <= 0x37) {
              // octal: 1–3 digits
              let oct = esc - 0x30;
              if (!this.r.isEOF() && this.r.peek() >= 0x30 && this.r.peek() <= 0x37) {
                oct = oct * 8 + (this.r.readByte() - 0x30);
                if (!this.r.isEOF() && this.r.peek() >= 0x30 && this.r.peek() <= 0x37) {
                  oct = oct * 8 + (this.r.readByte() - 0x30);
                }
              }
              bytes.push(oct & 0xff);
            }
            // Unknown escape: ignore per spec
        }
      } else if (b === 0x28) {
        depth++;
        bytes.push(b);
      } else if (b === 0x29) {
        depth--;
        if (depth === 0) break;
        bytes.push(b);
      } else {
        bytes.push(b);
      }
    }
    return { kind: 'string', value: new Uint8Array(bytes) };
  }

  private parseNumberOrRef(): PdfPrimitive {
    const firstToken = this.r.readToken();
    const firstNum = parseFloat(firstToken);
    if (!Number.isFinite(firstNum)) {
      return { kind: 'number', value: firstNum };
    }

    // Only integers can be part of an indirect reference
    if (!Number.isInteger(firstNum)) {
      return { kind: 'number', value: firstNum };
    }

    const posAfterFirst = this.r.position;
    this.r.skipWhitespace();

    if (!this.r.isEOF() && isDigitByte(this.r.peek())) {
      const secondToken = this.r.readToken();
      const secondNum = parseInt(secondToken, 10);
      if (Number.isInteger(secondNum) && secondNum >= 0) {
        this.r.skipWhitespace();
        if (this.r.peek() === 0x52) {
          // 'R' — indirect reference
          this.r.skip(1);
          return { kind: 'ref', objNum: firstNum, genNum: secondNum };
        }
      }
    }

    // Not a ref — restore position to after first token
    this.r.seek(posAfterFirst);
    return { kind: 'number', value: firstNum };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStartOfNumber(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2b || b === 0x2e;
}

function isDigitByte(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function hexNibble(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  throw new Error(`XRefParser: invalid hex nibble 0x${b.toString(16)}`);
}

function dictGetNumber(dict: Map<string, PdfPrimitive>, key: string): number | undefined {
  const v = dict.get(key);
  if (v === undefined) return undefined;
  if (v.kind !== 'number') throw new Error(`XRefParser: /${key} must be a number, got ${v.kind}`);
  return v.value;
}

function dictGetRef(
  dict: Map<string, PdfPrimitive>,
  key: string
): { objNum: number; genNum: number } | undefined {
  const v = dict.get(key);
  if (v === undefined) return undefined;
  if (v.kind !== 'ref') throw new Error(`XRefParser: /${key} must be an indirect ref, got ${v.kind}`);
  return { objNum: v.objNum, genNum: v.genNum };
}

function dictGetArray(dict: Map<string, PdfPrimitive>, key: string): PdfPrimitive[] | undefined {
  const v = dict.get(key);
  if (v === undefined) return undefined;
  if (v.kind !== 'array') throw new Error(`XRefParser: /${key} must be an array, got ${v.kind}`);
  return v.value;
}

function dictGetName(dict: Map<string, PdfPrimitive>, key: string): string | undefined {
  const v = dict.get(key);
  if (v === undefined) return undefined;
  if (v.kind !== 'name') throw new Error(`XRefParser: /${key} must be a name, got ${v.kind}`);
  return v.value;
}

function readMultiByteUint(data: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) {
    value = (value * 256 + (data[offset + i] ?? 0)) >>> 0;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Internal parsed stream object representation
// ---------------------------------------------------------------------------

interface ParsedStreamObject {
  dict: Map<string, PdfPrimitive>;
  data: Uint8Array;
  /** /Prev value extracted from the dict, if present. */
  prev: number | undefined;
}

// ---------------------------------------------------------------------------
// XRefParser
// ---------------------------------------------------------------------------

export class XRefParser {
  /**
   * Main entry point.
   *
   * 1. Finds %%EOF by searching backward from end of file.
   * 2. Reads startxref value (the number before %%EOF).
   * 3. Seeks to that offset and determines if it's a traditional xref table
   *    or an xref stream.
   * 4. Follows /Prev chain iteratively to collect all xref sections.
   * 5. Merges entries (newest revision wins).
   */
  parse(reader: ByteStreamReader): XRefTable {
    const startXRefOffset = this.findStartXRef(reader);

    // Follow /Prev chain and collect offsets, oldest-first
    const offsets = this.collectChain(reader, startXRefOffset);

    const entries = new Map<number, XRefEntry>();
    let trailer: PDFTrailer | undefined;

    for (const offset of offsets) {
      reader.seek(offset);
      reader.skipWhitespace();

      let table: XRefTable;
      if (this.peekKeyword(reader) === 'xref') {
        table = this.parseTraditionalXRef(reader);
      } else {
        const streamObj = this.readStreamObject(reader);
        table = this.parseXRefStream(reader, streamObj);
      }

      // Newer entries (later in offsets array) overwrite older ones
      for (const [objNum, entry] of table.entries) {
        entries.set(objNum, entry);
      }
      // Use the most-recent revision's trailer (last offset = newest revision)
      trailer = table.trailer;
    }

    if (trailer === undefined) {
      throw new Error('XRefParser: no trailer found');
    }

    return { entries, trailer };
  }

  // -------------------------------------------------------------------------
  // startxref location
  // -------------------------------------------------------------------------

  private findStartXRef(reader: ByteStreamReader): number {
    // Search backward from end for %%EOF
    reader.seek(reader.length);
    const eofPattern = strToBytes('%%EOF');
    const eofPos = reader.findBackward(eofPattern);
    if (eofPos === -1) {
      throw new Error('XRefParser: %%EOF marker not found');
    }

    // Search backward from %%EOF for "startxref"
    reader.seek(eofPos);
    const sxrPattern = strToBytes('startxref');
    const sxrPos = reader.findBackward(sxrPattern);
    if (sxrPos === -1) {
      throw new Error('XRefParser: "startxref" keyword not found');
    }

    reader.seek(sxrPos);
    reader.readToken(); // consume "startxref"
    reader.skipWhitespace();
    const offsetToken = reader.readToken();
    const offset = parseInt(offsetToken, 10);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error(`XRefParser: invalid startxref value "${offsetToken}"`);
    }
    return offset;
  }

  /**
   * Follow the /Prev chain from startXRefOffset to the oldest revision.
   * Returns offsets ordered oldest-first so newer revisions overwrite.
   */
  private collectChain(reader: ByteStreamReader, startOffset: number): number[] {
    const offsets: number[] = [];
    const visited = new Set<number>();
    let current: number | undefined = startOffset;

    while (current !== undefined) {
      if (visited.has(current)) break; // cycle guard
      visited.add(current);
      offsets.push(current);

      reader.seek(current);
      reader.skipWhitespace();

      let prev: number | undefined;
      if (this.peekKeyword(reader) === 'xref') {
        const table = this.parseTraditionalXRef(reader);
        prev = table.trailer.prev;
      } else {
        const streamObj = this.readStreamObject(reader);
        prev = streamObj.prev;
      }
      current = prev;
    }

    // Reverse so oldest xref is processed first
    return offsets.reverse();
  }

  // -------------------------------------------------------------------------
  // Traditional xref table
  // -------------------------------------------------------------------------

  /**
   * Parse a traditional "xref" ... "trailer" << ... >> section.
   * Reader must be positioned at the 'x' of "xref".
   */
  parseTraditionalXRef(reader: ByteStreamReader): XRefTable {
    reader.skipWhitespace();
    const keyword = reader.readToken();
    if (keyword !== 'xref') {
      throw new Error(`XRefParser: expected "xref", got "${keyword}"`);
    }

    const entries = new Map<number, XRefEntry>();

    for (;;) {
      reader.skipWhitespace();
      // Peek at the next token — if it's "trailer" we're done with entries
      if (this.peekKeyword(reader) === 'trailer') {
        reader.readToken(); // consume "trailer"
        break;
      }

      // Subsection header: startObj count
      const startTok = reader.readToken();
      const startObj = parseInt(startTok, 10);
      if (!Number.isFinite(startObj) || startObj < 0) {
        throw new Error(`XRefParser: invalid xref subsection start "${startTok}"`);
      }

      reader.skipWhitespace();
      const countTok = reader.readToken();
      const count = parseInt(countTok, 10);
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`XRefParser: invalid xref subsection count "${countTok}"`);
      }

      for (let i = 0; i < count; i++) {
        // Standard format: "oooooooooo ggggg n/f \r\n" (20 bytes)
        // We use readLine() for resilience against line-ending variations
        reader.skipWhitespace();
        const line = reader.readLine().trim();
        if (line.length === 0) {
          throw new Error(`XRefParser: empty xref entry for object ${startObj + i}`);
        }
        this.parseXRefEntryLine(entries, startObj + i, line);
      }
    }

    // Parser is now positioned after "trailer"; next is the trailer dict
    reader.skipWhitespace();
    const miniParser = new MiniPdfParser(reader);
    const dictNode = miniParser.parseValue();
    if (dictNode.kind !== 'dict') {
      throw new Error('XRefParser: trailer is not a dictionary');
    }
    const trailer = this.buildTrailer(dictNode.value);
    return { entries, trailer };
  }

  private parseXRefEntryLine(
    entries: Map<number, XRefEntry>,
    objNum: number,
    line: string
  ): void {
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      throw new Error(`XRefParser: malformed xref entry for object ${objNum}: "${line}"`);
    }
    const offsetStr  = parts[0] ?? '';
    const genStr     = parts[1] ?? '';
    const typeChar   = parts[2] ?? '';

    const offset     = parseInt(offsetStr, 10);
    const generation = parseInt(genStr, 10);

    if (!Number.isFinite(offset) || !Number.isFinite(generation)) {
      throw new Error(`XRefParser: non-numeric xref entry for object ${objNum}: "${line}"`);
    }
    if (typeChar !== 'n' && typeChar !== 'f') {
      throw new Error(`XRefParser: unknown xref entry type "${typeChar}" for object ${objNum}`);
    }
    entries.set(objNum, { offset, generation, inUse: typeChar === 'n' });
  }

  // -------------------------------------------------------------------------
  // Xref stream (PDF 1.5+)
  // -------------------------------------------------------------------------

  /**
   * Build an XRefTable from an already-decoded stream object.
   * The `reader` parameter is unused here but kept for API symmetry with
   * the spec (callers may pass the reader for future extension).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  parseXRefStream(_reader: ByteStreamReader, streamObj: ParsedStreamObject): XRefTable {
    return this.buildTableFromStreamObj(streamObj);
  }

  private buildTableFromStreamObj(streamObj: ParsedStreamObject): XRefTable {
    const { dict, data } = streamObj;

    const wArray = dictGetArray(dict, 'W');
    if (!wArray || wArray.length < 3) {
      throw new Error('XRefParser: /W array missing or has fewer than 3 elements in xref stream');
    }
    const fieldWidths = wArray.map((v) => {
      if (v.kind !== 'number') throw new Error('XRefParser: /W element must be a number');
      return v.value;
    });
    const w0 = fieldWidths[0] ?? 0;
    const w1 = fieldWidths[1] ?? 0;
    const w2 = fieldWidths[2] ?? 0;
    const entrySize = w0 + w1 + w2;

    const sizeVal = dictGetNumber(dict, 'Size') ?? 0;
    const indexArray = dictGetArray(dict, 'Index');

    // Build (startObj, count) pairs; default is [0, Size]
    const indexPairs: Array<[number, number]> = [];
    if (indexArray && indexArray.length >= 2) {
      for (let i = 0; i + 1 < indexArray.length; i += 2) {
        const a = indexArray[i];
        const b = indexArray[i + 1];
        if (a === undefined || b === undefined) break;
        if (a.kind !== 'number' || b.kind !== 'number') {
          throw new Error('XRefParser: /Index elements must be numbers');
        }
        indexPairs.push([a.value, b.value]);
      }
    } else {
      indexPairs.push([0, sizeVal]);
    }

    const entries = new Map<number, XRefEntry>();
    let dataOffset = 0;

    for (const [startObj, count] of indexPairs) {
      for (let i = 0; i < count; i++) {
        if (entrySize > 0 && dataOffset + entrySize > data.length) break;

        // If w0 is 0, default type is 1 (normal object)
        const typeVal  = w0 > 0 ? readMultiByteUint(data, dataOffset, w0)      : 1;
        const field2   = w1 > 0 ? readMultiByteUint(data, dataOffset + w0, w1) : 0;
        const field3   = w2 > 0 ? readMultiByteUint(data, dataOffset + w0 + w1, w2) : 0;
        dataOffset += entrySize;

        const objNum = startObj + i;
        switch (typeVal) {
          case 0: // free object
            entries.set(objNum, { offset: field2, generation: field3, inUse: false });
            break;
          case 1: // normal object at byte offset
            entries.set(objNum, { offset: field2, generation: field3, inUse: true });
            break;
          case 2: // compressed object in object stream
            entries.set(objNum, {
              offset: 0,
              generation: 0,
              inUse: true,
              compressed: true,
              streamObjNum: field2,
              indexInStream: field3,
            });
            break;
          default:
            // Unknown type — skip as per spec
        }
      }
    }

    const trailer = this.buildTrailer(dict, streamObj.prev);
    return { entries, trailer };
  }

  // -------------------------------------------------------------------------
  // Stream object reader
  // -------------------------------------------------------------------------

  /**
   * Read an indirect object header "N G obj" followed by a stream dictionary
   * and raw stream data.  Decodes the stream using its /Filter chain.
   *
   * Reader must be positioned at the start of the object number token.
   */
  private readStreamObject(reader: ByteStreamReader): ParsedStreamObject {
    reader.skipWhitespace();
    reader.readToken(); // object number
    reader.readToken(); // generation number
    const objKw = reader.readToken();
    if (objKw !== 'obj') {
      throw new Error(`XRefParser: expected "obj", got "${objKw}"`);
    }

    reader.skipWhitespace();
    const miniParser = new MiniPdfParser(reader);
    const dictNode = miniParser.parseValue();
    if (dictNode.kind !== 'dict') {
      throw new Error('XRefParser: xref stream object has no dictionary');
    }
    const dict = dictNode.value;

    // Validate /Type = /XRef
    const typeName = dictGetName(dict, 'Type');
    if (typeName !== 'XRef') {
      throw new Error(`XRefParser: stream /Type is "${typeName}", expected "XRef"`);
    }

    // Consume "stream" keyword + mandatory EOL
    reader.skipWhitespace();
    const streamKw = reader.readToken();
    if (streamKw !== 'stream') {
      throw new Error(`XRefParser: expected "stream", got "${streamKw}"`);
    }
    // PDF spec §7.3.8.1: "stream" must be followed by \n or \r\n
    const eolByte = reader.readByte();
    if (eolByte === 0x0d) {
      // CR — optionally followed by LF
      if (reader.peek() === 0x0a) reader.skip(1);
    } else if (eolByte !== 0x0a) {
      throw new Error('XRefParser: "stream" keyword must be followed by EOL');
    }

    const streamStart = reader.position;
    const lengthVal = dictGetNumber(dict, 'Length');
    if (lengthVal === undefined) {
      throw new Error('XRefParser: xref stream missing /Length');
    }

    const rawData = reader.slice(streamStart, streamStart + lengthVal);
    reader.seek(streamStart + lengthVal);

    // Decode via /Filter chain
    const filterEntry = dict.get('Filter');
    let decodedData: Uint8Array;

    if (filterEntry === undefined) {
      decodedData = rawData;
    } else {
      const filterNames: string[] = [];
      if (filterEntry.kind === 'name') {
        filterNames.push(filterEntry.value);
      } else if (filterEntry.kind === 'array') {
        for (const item of filterEntry.value) {
          if (item.kind !== 'name') throw new Error('XRefParser: /Filter element must be a name');
          filterNames.push(item.value);
        }
      } else {
        throw new Error('XRefParser: /Filter has unexpected type');
      }

      // Collect /DecodeParms if present
      const parmsEntry = dict.get('DecodeParms');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parms: any = undefined;
      if (parmsEntry !== undefined) {
        parms = parmsEntry;
      }

      decodedData = decodeStream(rawData, filterNames, parms);
    }

    const prev = dictGetNumber(dict, 'Prev');
    return { dict, data: decodedData, prev };
  }

  // -------------------------------------------------------------------------
  // Trailer builder
  // -------------------------------------------------------------------------

  private buildTrailer(
    dict: Map<string, PdfPrimitive>,
    prevOverride?: number
  ): PDFTrailer {
    const size = dictGetNumber(dict, 'Size');
    if (size === undefined) throw new Error('XRefParser: trailer missing /Size');

    const root = dictGetRef(dict, 'Root');
    if (root === undefined) throw new Error('XRefParser: trailer missing /Root');

    const info = dictGetRef(dict, 'Info');
    const prev = prevOverride ?? dictGetNumber(dict, 'Prev');

    // /ID — two byte strings
    let id: [Uint8Array, Uint8Array] | undefined;
    const idArray = dictGetArray(dict, 'ID');
    if (idArray && idArray.length >= 2) {
      const a = idArray[0];
      const b = idArray[1];
      if (a !== undefined && b !== undefined && a.kind === 'string' && b.kind === 'string') {
        id = [a.value, b.value];
      }
    }

    return { size, root, info, prev, id };
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  private peekKeyword(reader: ByteStreamReader): string {
    const saved = reader.position;
    reader.skipWhitespace();
    const token = reader.readToken();
    reader.seek(saved);
    return token;
  }
}

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------

function strToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }
  return bytes;
}

/**
 * L0 Binary Layer — Stream filter / decompression
 *
 * decodeStream applies the filter(s) listed in a PDF stream dictionary to
 * decompress / decode raw stream bytes.
 *
 * Supported filters (PDF 32000-1:2008 §7.4):
 *   FlateDecode    — zlib/deflate via pako
 *   ASCIIHexDecode — hex pair → byte
 *   ASCII85Decode  — base-85 decode
 *   LZWDecode      — variable-length LZW decompression
 *   RunLengthDecode— RLE byte-oriented
 *   DCTDecode      — pass-through (JPEG)
 *   JPXDecode      — pass-through (JPEG 2000)
 *
 * Filters are applied left-to-right (cascaded); each filter's output feeds
 * the next filter's input.
 */

import { inflate } from 'pako';

// ---------------------------------------------------------------------------
// Individual filter implementations
// ---------------------------------------------------------------------------

function applyFlateDecode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  return inflate(data);
}

function applyASCIIHexDecode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;

  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if (b === undefined) break;
    // Skip whitespace
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x00) continue;
    // '>' is the end-of-data marker
    if (b === 0x3e) break;

    const hi = hexNibbleByte(b);
    // Consume the second nibble, skipping whitespace between pairs
    let lo = 0;
    while (i < data.length) {
      const b2 = data[i++];
      if (b2 === undefined) break;
      if (b2 === 0x20 || b2 === 0x09 || b2 === 0x0a || b2 === 0x0d || b2 === 0x00) continue;
      if (b2 === 0x3e) {
        // Odd number of hex digits — treat missing low nibble as 0
        out.push(hi << 4);
        return new Uint8Array(out);
      }
      lo = hexNibbleByte(b2);
      break;
    }
    out.push((hi << 4) | lo);
  }
  return new Uint8Array(out);
}

/**
 * ASCII85Decode — base-85 encoding (PDF §7.4.3).
 *
 * Groups of 5 ASCII characters in range [!..u] represent 4 bytes.
 * 'z' is a shorthand for 5 '!' characters (4 zero bytes).
 * '~>' terminates the data stream.
 * Whitespace between groups is ignored.
 */
function applyASCII85Decode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;

  const out: number[] = [];
  let group: number[] = [];

  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if (b === undefined) break;

    // Skip whitespace
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x00) continue;

    // End-of-data marker '~>'
    if (b === 0x7e) {
      // Next byte must be '>'
      while (i < data.length) {
        const next = data[i++];
        if (next === undefined) break;
        if (next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d) continue;
        // Expect '>'
        break;
      }
      break;
    }

    // 'z' shorthand for four zero bytes
    if (b === 0x7a) {
      if (group.length !== 0) {
        throw new Error('ASCII85Decode: "z" shorthand inside a partial group');
      }
      out.push(0, 0, 0, 0);
      continue;
    }

    // Regular base-85 digit: '!' (0x21) through 'u' (0x75)
    if (b < 0x21 || b > 0x75) {
      throw new Error(`ASCII85Decode: invalid byte 0x${b.toString(16)}`);
    }
    group.push(b - 0x21);

    if (group.length === 5) {
      const v =
        (group[0]! * 85 * 85 * 85 * 85 +
         group[1]! * 85 * 85 * 85 +
         group[2]! * 85 * 85 +
         group[3]! * 85 +
         group[4]!) >>> 0;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group = [];
    }
  }

  // Handle partial final group (n digits → n-1 bytes)
  if (group.length > 0) {
    const n = group.length;
    // Pad with 'u' (84) to complete the group
    while (group.length < 5) group.push(84);
    const v =
      (group[0]! * 85 * 85 * 85 * 85 +
       group[1]! * 85 * 85 * 85 +
       group[2]! * 85 * 85 +
       group[3]! * 85 +
       group[4]!) >>> 0;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let k = 0; k < n - 1; k++) {
      out.push(bytes[k]!);
    }
  }

  return new Uint8Array(out);
}

/**
 * LZWDecode — variable-length LZW as used in PDF (PDF §7.4.4).
 *
 * Compatible with TIFF variant:
 *   - Initial code size = 9 bits
 *   - Clear code = 256
 *   - End-of-information code = 257
 *   - First assignable code = 258
 *   - Table grows: code size increases when table fills current range
 */
function applyLZWDecode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;

  const CLEAR_CODE = 256;
  const EOI_CODE   = 257;
  const FIRST_CODE = 258;

  // Bit-stream reader
  let byteIndex = 0;
  let bitBuffer = 0;
  let bitsInBuffer = 0;

  function readCode(codeSize: number): number {
    while (bitsInBuffer < codeSize) {
      if (byteIndex >= data.length) return EOI_CODE;
      bitBuffer = (bitBuffer << 8) | (data[byteIndex++] ?? 0);
      bitsInBuffer += 8;
    }
    bitsInBuffer -= codeSize;
    return (bitBuffer >>> bitsInBuffer) & ((1 << codeSize) - 1);
  }

  // Initialize string table with single-byte entries
  type LzwEntry = Uint8Array;
  const table: LzwEntry[] = new Array<LzwEntry>(FIRST_CODE);
  for (let i = 0; i < 256; i++) {
    table[i] = new Uint8Array([i]);
  }
  table[CLEAR_CODE] = new Uint8Array(0);
  table[EOI_CODE]   = new Uint8Array(0);

  const out: number[] = [];
  let codeSize = 9;
  let nextCode = FIRST_CODE;

  function resetTable(): void {
    table.length = FIRST_CODE;
    codeSize = 9;
    nextCode = FIRST_CODE;
  }

  // First code must be a clear code or a literal
  let prevEntry: Uint8Array | undefined;

  for (;;) {
    const code = readCode(codeSize);

    if (code === EOI_CODE) break;

    if (code === CLEAR_CODE) {
      resetTable();
      prevEntry = undefined;
      continue;
    }

    let entry: Uint8Array;

    if (code < table.length) {
      const tableEntry = table[code];
      if (tableEntry === undefined) throw new Error('LZWDecode: undefined table entry');
      entry = tableEntry;
    } else if (code === nextCode && prevEntry !== undefined) {
      // Special case: code not yet in table; entry = prevEntry + prevEntry[0]
      entry = new Uint8Array(prevEntry.length + 1);
      entry.set(prevEntry);
      entry[prevEntry.length] = prevEntry[0]!;
    } else {
      throw new Error(`LZWDecode: unexpected code ${code} (next=${nextCode})`);
    }

    for (let k = 0; k < entry.length; k++) {
      out.push(entry[k]!);
    }

    if (prevEntry !== undefined) {
      // Add prevEntry + entry[0] to the table
      const newEntry = new Uint8Array(prevEntry.length + 1);
      newEntry.set(prevEntry);
      newEntry[prevEntry.length] = entry[0]!;
      table[nextCode++] = newEntry;

      // Increase code size at powers-of-two boundaries
      if (nextCode === (1 << codeSize) && codeSize < 12) {
        codeSize++;
      }
    }

    prevEntry = entry;
  }

  return new Uint8Array(out);
}

function applyRunLengthDecode(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;

  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const length = data[i++];
    if (length === undefined || length === 128) break; // 128 = EOD
    if (length < 128) {
      // Copy next (length + 1) bytes literally
      const count = length + 1;
      for (let j = 0; j < count && i < data.length; j++) {
        out.push(data[i++]!);
      }
    } else {
      // Repeat next byte (257 - length) times
      const count = 257 - length;
      const byte = data[i++];
      if (byte === undefined) break;
      for (let j = 0; j < count; j++) {
        out.push(byte);
      }
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode raw PDF stream bytes by applying the specified filter chain.
 *
 * @param data    Raw (encoded) stream bytes.
 * @param filters Single filter name or ordered array of filter names.
 * @param params  Optional decode parameters (ignored for most filters;
 *                passed through for future DecodeParms support).
 * @returns       Decoded bytes after all filters have been applied.
 */
export function decodeStream(
  data: Uint8Array,
  filters: string | string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _params?: any | any[]
): Uint8Array {
  if (data.length === 0) return data;

  const filterList = Array.isArray(filters) ? filters : [filters];
  let current = data;

  for (const filterName of filterList) {
    switch (filterName) {
      case 'FlateDecode':
      case 'Fl':
        current = applyFlateDecode(current);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        current = applyASCIIHexDecode(current);
        break;
      case 'ASCII85Decode':
      case 'A85':
        current = applyASCII85Decode(current);
        break;
      case 'LZWDecode':
      case 'LZW':
        current = applyLZWDecode(current);
        break;
      case 'RunLengthDecode':
      case 'RL':
        current = applyRunLengthDecode(current);
        break;
      case 'DCTDecode':
      case 'DCT':
        // JPEG — pass through; higher layers handle JPEG natively
        break;
      case 'JPXDecode':
        // JPEG 2000 — pass through
        break;
      default:
        throw new Error(`decodeStream: unsupported filter "${filterName}"`);
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------

function hexNibbleByte(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;        // '0'–'9'
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;   // 'A'–'F'
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;   // 'a'–'f'
  throw new Error(`ASCIIHexDecode: invalid hex byte 0x${b.toString(16)}`);
}

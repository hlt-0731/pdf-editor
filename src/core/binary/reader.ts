/**
 * L0 Binary Layer — ByteStreamReader
 *
 * Wraps a Uint8Array and provides sequential and random-access reading
 * primitives needed by the PDF parser.  All methods operate on raw bytes;
 * higher layers are responsible for encoding semantics above ASCII.
 */

/** PDF whitespace byte values (PDF 32000-1:2008 §7.2.2) */
const PDF_WHITESPACE = new Set<number>([0x00, 0x09, 0x0a, 0x0d, 0x20]);

/** PDF delimiter byte values (PDF 32000-1:2008 §7.2.2) */
const PDF_DELIMITERS = new Set<number>([
  0x28, // (
  0x29, // )
  0x3c, // <
  0x3e, // >
  0x5b, // [
  0x5d, // ]
  0x7b, // {
  0x7d, // }
  0x2f, // /
  0x25, // %
]);

const textDecoder = new TextDecoder('latin1');

export class ByteStreamReader {
  readonly buffer: Uint8Array;
  readonly length: number;
  position: number;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.length = buffer.length;
    this.position = 0;
  }

  // -------------------------------------------------------------------------
  // Core read methods
  // -------------------------------------------------------------------------

  isEOF(): boolean {
    return this.position >= this.length;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.length) {
      throw new RangeError(
        `ByteStreamReader.seek: position ${pos} out of range [0, ${this.length}]`
      );
    }
    this.position = pos;
  }

  skip(n: number): void {
    const next = this.position + n;
    if (next > this.length) {
      throw new RangeError(
        `ByteStreamReader.skip: skip ${n} would exceed buffer length ${this.length}`
      );
    }
    this.position = next;
  }

  slice(start: number, end: number): Uint8Array {
    return this.buffer.slice(start, end);
  }

  peek(offset: number = 0): number {
    const idx = this.position + offset;
    if (idx < 0 || idx >= this.length) {
      return -1;
    }
    return this.buffer[idx];
  }

  readByte(): number {
    if (this.position >= this.length) {
      throw new RangeError('ByteStreamReader.readByte: unexpected end of buffer');
    }
    return this.buffer[this.position++];
  }

  readBytes(n: number): Uint8Array {
    if (this.position + n > this.length) {
      throw new RangeError(
        `ByteStreamReader.readBytes: requested ${n} bytes but only ${this.length - this.position} remain`
      );
    }
    const result = this.buffer.subarray(this.position, this.position + n);
    this.position += n;
    return result;
  }

  /**
   * Read until \n or \r\n and return the line content without the line ending.
   * If EOF is reached before a newline the remaining bytes are returned.
   */
  readLine(): string {
    const start = this.position;
    while (this.position < this.length) {
      const b = this.buffer[this.position];
      if (b === 0x0a) {
        // LF
        const line = textDecoder.decode(this.buffer.subarray(start, this.position));
        this.position += 1;
        return line;
      }
      if (b === 0x0d) {
        // CR — check for CRLF
        const line = textDecoder.decode(this.buffer.subarray(start, this.position));
        this.position += 1;
        if (this.position < this.length && this.buffer[this.position] === 0x0a) {
          this.position += 1;
        }
        return line;
      }
      this.position += 1;
    }
    // EOF reached — return whatever is left
    return textDecoder.decode(this.buffer.subarray(start, this.position));
  }

  // -------------------------------------------------------------------------
  // Search methods
  // -------------------------------------------------------------------------

  /**
   * Search backward from current position for the byte pattern.
   * Returns the position of the first byte of the pattern, or -1 if not found.
   * Does NOT advance position.
   */
  findBackward(pattern: Uint8Array): number {
    if (pattern.length === 0) return this.position;
    const limit = this.position - pattern.length;
    for (let i = limit; i >= 0; i--) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (this.buffer[i + j] !== pattern[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }

  /**
   * Search forward from current position for the byte pattern.
   * Returns the position of the first byte of the pattern, or -1 if not found.
   * Does NOT advance position.
   */
  findForward(pattern: Uint8Array): number {
    if (pattern.length === 0) return this.position;
    const limit = this.length - pattern.length;
    for (let i = this.position; i <= limit; i++) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (this.buffer[i + j] !== pattern[j]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // PDF-level helpers
  // -------------------------------------------------------------------------

  /**
   * Skip PDF whitespace bytes and comments (% through end-of-line).
   */
  skipWhitespace(): void {
    while (this.position < this.length) {
      const b = this.buffer[this.position];
      if (PDF_WHITESPACE.has(b)) {
        this.position += 1;
      } else if (b === 0x25) {
        // '%' — comment: skip to end of line
        this.position += 1;
        while (this.position < this.length) {
          const c = this.buffer[this.position];
          this.position += 1;
          if (c === 0x0a || c === 0x0d) break;
        }
      } else {
        break;
      }
    }
  }

  /**
   * Read the next token delimited by whitespace or PDF delimiter characters.
   * Skips leading whitespace/comments first.
   * Returns an empty string at EOF.
   */
  readToken(): string {
    this.skipWhitespace();
    if (this.isEOF()) return '';

    const start = this.position;
    while (this.position < this.length) {
      const b = this.buffer[this.position];
      if (PDF_WHITESPACE.has(b) || PDF_DELIMITERS.has(b)) break;
      this.position += 1;
    }
    return textDecoder.decode(this.buffer.subarray(start, this.position));
  }
}

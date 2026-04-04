/**
 * L0 Binary Layer — ByteStreamWriter
 *
 * Accumulates byte chunks in memory and flushes to a single Uint8Array on
 * demand.  All write operations are O(1) (append-only); the final concat is
 * O(n) and performed only once via toUint8Array().
 */

const textEncoder = new TextEncoder();

export class ByteStreamWriter {
  private chunks: Uint8Array[];
  private _length: number;

  constructor() {
    this.chunks = [];
    this._length = 0;
  }

  get length(): number {
    return this._length;
  }

  writeByte(b: number): void {
    const chunk = new Uint8Array(1);
    chunk[0] = b & 0xff;
    this.chunks.push(chunk);
    this._length += 1;
  }

  writeBytes(data: Uint8Array): void {
    if (data.length === 0) return;
    // Store a copy so callers can safely mutate their buffer afterwards
    this.chunks.push(data.slice());
    this._length += data.length;
  }

  /**
   * Write an ASCII/Latin-1 string.  Uses TextEncoder (UTF-8) which is
   * byte-identical for the ASCII range (0x00–0x7F).  For raw binary PDF
   * strings callers should use writeBytes() with a pre-encoded Uint8Array.
   */
  writeString(s: string): void {
    if (s.length === 0) return;
    const encoded = textEncoder.encode(s);
    this.chunks.push(encoded);
    this._length += encoded.length;
  }

  /** Write string followed by a LF newline (0x0A). */
  writeLine(s: string): void {
    this.writeString(s);
    this.writeByte(0x0a);
  }

  /**
   * Concatenate all accumulated chunks into a single Uint8Array.
   * The writer remains usable after this call (chunks are NOT cleared).
   */
  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this._length);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

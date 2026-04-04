/**
 * L2.5 Font Engine — CMap / ToUnicode parsing
 *
 * Parses ToUnicode CMap streams (PDF 32000-1:2008 §9.10) into a lookup map
 * from source character codes to Unicode code points.
 *
 * Supports:
 *   beginbfchar / endbfchar  — individual mappings
 *   beginbfrange / endbfrange — range mappings (scalar or array destinations)
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CMapEntry {
  type: 'char' | 'range';
  srcLow: number;
  srcHigh?: number;   // range only
  dst: number[];      // destination Unicode code points
}

// ---------------------------------------------------------------------------
// CMapParser
// ---------------------------------------------------------------------------

export class CMapParser {
  /** Source character code → Unicode code point(s). Populated by parse(). */
  private readonly map: Map<number, number[]> = new Map();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Parse a ToUnicode CMap stream (as a UTF-8 string) into the internal
   * lookup map.  Returns the map so callers can inspect it directly when
   * needed.
   *
   * @param stream  Decoded CMap stream text.
   */
  parse(stream: string): Map<number, number[]> {
    this.map.clear();
    this.parseBfChar(stream);
    this.parseBfRange(stream);
    return this.map;
  }

  /**
   * Convert a glyph/character code to a Unicode string using the parsed map.
   * Falls back to the direct Unicode scalar value when no mapping is found.
   *
   * @param glyphId  Source character code (as used in the PDF content stream).
   */
  glyphToUnicode(glyphId: number): string {
    const codePoints = this.map.get(glyphId);
    if (codePoints !== undefined && codePoints.length > 0) {
      return String.fromCodePoint(...codePoints);
    }
    // Fallback: treat the code as a Unicode scalar directly
    return String.fromCodePoint(glyphId);
  }

  /**
   * Reverse lookup: find the first source character code that maps to the
   * given Unicode character.  Returns null when no mapping exists.
   *
   * @param char  A single Unicode character (one or more UTF-16 code units).
   */
  unicodeToGlyph(char: string): number | null {
    const targetCodePoint = char.codePointAt(0);
    if (targetCodePoint === undefined) return null;

    for (const [srcCode, codePoints] of this.map) {
      if (codePoints.length === 1 && codePoints[0] === targetCodePoint) {
        return srcCode;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Private parsing helpers
  // -------------------------------------------------------------------------

  /** Parse all beginbfchar…endbfchar sections. */
  private parseBfChar(stream: string): void {
    const sectionRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let sectionMatch: RegExpExecArray | null;

    while ((sectionMatch = sectionRe.exec(stream)) !== null) {
      const body = sectionMatch[1];
      if (body === undefined) continue;

      const lineRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let lineMatch: RegExpExecArray | null;

      while ((lineMatch = lineRe.exec(body)) !== null) {
        const srcHex = lineMatch[1];
        const dstHex = lineMatch[2];
        if (srcHex === undefined || dstHex === undefined) continue;

        const srcCode = parseHex(srcHex);
        const dstCodePoints = parseHexToCodePoints(dstHex);
        this.map.set(srcCode, dstCodePoints);
      }
    }
  }

  /** Parse all beginbfrange…endbfrange sections. */
  private parseBfRange(stream: string): void {
    const sectionRe = /beginbfrange([\s\S]*?)endbfrange/g;
    let sectionMatch: RegExpExecArray | null;

    while ((sectionMatch = sectionRe.exec(stream)) !== null) {
      const body = sectionMatch[1];
      if (body === undefined) continue;

      this.parseRangeBody(body);
    }
  }

  /**
   * Parse the body text between beginbfrange…endbfrange.
   *
   * Each line is one of:
   *   <srcLow> <srcHigh> <dstStart>          — scalar destination
   *   <srcLow> <srcHigh> [<dst1> <dst2> ...]  — array destination
   */
  private parseRangeBody(body: string): void {
    // Tokenise: collect all <hex> tokens and [ / ] brackets in order
    const tokenRe = /<([0-9A-Fa-f]+)>|\[|\]/g;
    const tokens: string[] = [];
    let tokenMatch: RegExpExecArray | null;

    while ((tokenMatch = tokenRe.exec(body)) !== null) {
      tokens.push(tokenMatch[0]);
    }

    let i = 0;
    while (i < tokens.length) {
      const t0 = tokens[i];
      const t1 = tokens[i + 1];
      const t2 = tokens[i + 2];

      if (t0 === undefined || t1 === undefined || t2 === undefined) break;

      // Must start with two hex tokens
      if (!t0.startsWith('<') || !t1.startsWith('<')) {
        i++;
        continue;
      }

      const srcLow = parseHex(stripAngleBrackets(t0));
      const srcHigh = parseHex(stripAngleBrackets(t1));

      if (t2 === '[') {
        // Array destination: collect hex tokens until ']'
        i += 3; // skip srcLow, srcHigh, '['
        const dstArray: number[][] = [];

        while (i < tokens.length && tokens[i] !== ']') {
          const tok = tokens[i];
          if (tok !== undefined && tok.startsWith('<')) {
            dstArray.push(parseHexToCodePoints(stripAngleBrackets(tok)));
          }
          i++;
        }
        i++; // skip ']'

        // Map each code in [srcLow, srcHigh] to the corresponding array entry
        for (let code = srcLow; code <= srcHigh; code++) {
          const idx = code - srcLow;
          const dst = idx < dstArray.length ? dstArray[idx] : undefined;
          if (dst !== undefined) {
            this.map.set(code, dst);
          }
        }
      } else if (t2.startsWith('<')) {
        // Scalar destination: sequential mapping starting at dstStart
        const dstStart = parseHex(stripAngleBrackets(t2));
        i += 3;

        for (let code = srcLow; code <= srcHigh; code++) {
          const offset = code - srcLow;
          // Increment the last code point by offset for sequential mapping
          this.map.set(code, [dstStart + offset]);
        }
      } else {
        i++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private utilities
// ---------------------------------------------------------------------------

/** Parse a hex string to an integer. */
function parseHex(hex: string): number {
  return parseInt(hex, 16);
}

/** Remove leading `<` and trailing `>` from a hex token. */
function stripAngleBrackets(token: string): string {
  return token.slice(1, -1);
}

/**
 * Convert a hex string (from a CMap destination token) to an array of Unicode
 * code points.
 *
 * A destination hex string encodes one or more UTF-16 code units:
 *   - 2 bytes (4 hex digits) → one UTF-16 code unit → one code point
 *   - 4 bytes (8 hex digits) → a surrogate pair → one code point
 *   - Multiple code units are encoded sequentially
 */
function parseHexToCodePoints(hex: string): number[] {
  const codeUnits: number[] = [];

  // Each UTF-16 code unit is 2 bytes (4 hex digits)
  for (let i = 0; i < hex.length; i += 4) {
    const chunk = hex.slice(i, i + 4).padStart(4, '0');
    codeUnits.push(parseInt(chunk, 16));
  }

  const codePoints: number[] = [];
  let j = 0;
  while (j < codeUnits.length) {
    const cu = codeUnits[j];
    if (cu === undefined) break;

    // Detect surrogate pairs (UTF-16)
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const high = cu;
      const low = codeUnits[j + 1];
      if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
        const cp = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
        codePoints.push(cp);
        j += 2;
        continue;
      }
    }

    codePoints.push(cu);
    j++;
  }

  return codePoints;
}

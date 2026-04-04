/**
 * L3 Semantic Layer — Character → Word → Line → Block grouping
 *
 * Converts raw TextCharRaw values (PDF coordinates, byte char codes) produced
 * by the L2 ContentStreamProcessor into structured TextBlock values in canvas
 * coordinates with Unicode text.
 *
 * Pipeline (per `group` call):
 *   1. convertChars   — coordinate transform + Unicode mapping
 *   2. sortByReadingOrder — top-to-bottom, left-to-right
 *   3. detectWords    — insert synthetic space chars at word boundaries
 *   4. detectLines    — split char sequence into lines
 *   5. groupIntoBlocks — merge lines into blocks by vertical proximity
 *   6. splitByFont    — split blocks that contain multiple font names
 */

import type { TextCharRaw } from '../core/content/stream.ts';
import {
  type TextChar,
  type TextBlock,
  calculateBoundingBox,
  extractText,
  nextTextBlockId,
} from './text-block.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Thresholds that control the grouping heuristics. */
export interface GroupingConfig {
  /**
   * Fraction of the glyph's fontSize that defines the minimum horizontal gap
   * before two adjacent characters are considered to be in different words.
   * Default: 0.3
   */
  wordSpaceMultiplier: number;
  /**
   * Fraction of the glyph's fontSize that defines the minimum vertical
   * distance before two characters are considered to be on different lines.
   * Default: 0.5
   */
  lineBreakMultiplier: number;
  /**
   * Fraction of the line height that defines the minimum vertical gap between
   * consecutive lines before they are placed in different blocks.
   * Default: 1.5
   */
  blockBreakMultiplier: number;
}

export const DEFAULT_GROUPING_CONFIG: GroupingConfig = {
  wordSpaceMultiplier: 0.3,
  lineBreakMultiplier: 0.5,
  blockBreakMultiplier: 1.5,
};

// ---------------------------------------------------------------------------
// Default charCode → Unicode
// ---------------------------------------------------------------------------

/**
 * Fallback encoding: treat the charCode as a Latin-1 code point.
 * A real font engine would look up CIDToGIDMap / ToUnicode / Encoding dicts.
 */
function defaultCharCodeToUnicode(_fontName: string, charCode: number): string {
  return String.fromCharCode(charCode);
}

// ---------------------------------------------------------------------------
// Synthetic space character sentinel
// ---------------------------------------------------------------------------

/** charCode used for synthetic space characters inserted between words. */
const SPACE_CHAR_CODE = 0x20;

// ---------------------------------------------------------------------------
// TextGrouper
// ---------------------------------------------------------------------------

export class TextGrouper {
  private readonly config: GroupingConfig;
  private readonly charCodeToUnicode: (fontName: string, charCode: number) => string;

  constructor(
    config: GroupingConfig = DEFAULT_GROUPING_CONFIG,
    charCodeToUnicode: (fontName: string, charCode: number) => string = defaultCharCodeToUnicode,
  ) {
    this.config = config;
    this.charCodeToUnicode = charCodeToUnicode;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Convert raw characters from the L2 layer into semantic TextBlock values.
   *
   * @param rawChars   Raw characters from ContentStreamProcessor.process().
   * @param pageHeight Page height in points (PDF coordinates, for Y-axis flip).
   * @param scale      Render scale factor (canvas pixels per point).
   */
  group(rawChars: TextCharRaw[], pageHeight: number, scale: number): TextBlock[] {
    if (rawChars.length === 0) return [];

    const chars = this.convertChars(rawChars, pageHeight, scale);
    if (chars.length === 0) return [];

    const sorted = this.sortByReadingOrder(chars);
    const withSpaces = this.detectWords(sorted);
    const lines = this.detectLines(withSpaces);
    const blocks = this.groupIntoBlocks(lines);
    // Note: splitByFont is intentionally NOT called here.
    // Type3 subset fonts (common in CJK PDFs) assign a unique font name to
    // each glyph subset.  Splitting by font in that situation would create
    // one block per character, making editing impossible.  The save pipeline
    // handles per-operator font lookup, so mixed-font blocks are safe.
    return blocks;
  }

  // -------------------------------------------------------------------------
  // Step 1: Convert TextCharRaw → TextChar
  // -------------------------------------------------------------------------

  /**
   * Apply coordinate transformation and Unicode mapping to each raw character.
   *
   * PDF coordinate origin is bottom-left; canvas coordinate origin is top-left.
   *   canvasX = pdfX * scale
   *   canvasY = (pageHeight - pdfY) * scale
   *
   * The character height is approximated as `fontSize * scale` since PDF does
   * not store per-glyph bounding heights in the content stream.
   */
  private convertChars(
    rawChars: TextCharRaw[],
    pageHeight: number,
    scale: number,
  ): TextChar[] {
    const result: TextChar[] = [];

    for (const raw of rawChars) {
      const char = this.charCodeToUnicode(raw.fontName, raw.charCode);

      const canvasX = raw.x * scale;
      const canvasY = (pageHeight - raw.y) * scale;
      const canvasWidth = raw.width * scale;
      const canvasFontSize = raw.fontSize * scale;
      const canvasHeight = canvasFontSize;

      result.push({
        char,
        glyphId: raw.charCode,
        x: canvasX,
        y: canvasY,
        width: canvasWidth,
        height: canvasHeight,
        fontSize: canvasFontSize,
        fontName: raw.fontName,
        color: [raw.fillColor[0], raw.fillColor[1], raw.fillColor[2]],
        matrix: raw.matrix.slice(),
        operatorIndex: raw.operatorIndex,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Step 2: Sort by reading order
  // -------------------------------------------------------------------------

  /**
   * Sort characters into top-to-bottom, left-to-right reading order.
   *
   * We use `y` as the primary key (ascending, since canvas Y increases
   * downward from the top) and `x` as the secondary key.
   */
  private sortByReadingOrder(chars: TextChar[]): TextChar[] {
    return chars.slice().sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: Detect word boundaries
  // -------------------------------------------------------------------------

  /**
   * Insert synthetic space characters where the horizontal gap between
   * adjacent glyphs on the same line exceeds `fontSize * wordSpaceMultiplier`.
   *
   * Two characters are considered to be on the same line when their vertical
   * positions differ by less than `fontSize * lineBreakMultiplier`.
   */
  private detectWords(chars: TextChar[]): TextChar[] {
    if (chars.length <= 1) return chars.slice();

    const result: TextChar[] = [];
    result.push(chars[0]);

    for (let i = 1; i < chars.length; i++) {
      const prev = chars[i - 1];
      const curr = chars[i];

      // Determine if on the same line (vertical proximity)
      const fontSize = prev.fontSize > 0 ? prev.fontSize : 1;
      const verticalDiff = Math.abs(curr.y - prev.y);
      const onSameLine = verticalDiff <= fontSize * this.config.lineBreakMultiplier;

      if (onSameLine) {
        const gap = curr.x - (prev.x + prev.width);
        const wordGapThreshold = fontSize * this.config.wordSpaceMultiplier;

        if (gap > wordGapThreshold) {
          // Insert a synthetic space character between the words
          const spaceChar = this.charCodeToUnicode(prev.fontName, SPACE_CHAR_CODE);
          const syntheticSpace: TextChar = {
            char: spaceChar,
            glyphId: SPACE_CHAR_CODE,
            x: prev.x + prev.width,
            y: prev.y,
            width: gap,
            height: prev.height,
            fontSize: prev.fontSize,
            fontName: prev.fontName,
            color: [prev.color[0], prev.color[1], prev.color[2]],
            matrix: prev.matrix.slice(),
            operatorIndex: prev.operatorIndex,
          };
          result.push(syntheticSpace);
        }
      }

      result.push(curr);
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Step 4: Detect line boundaries
  // -------------------------------------------------------------------------

  /**
   * Split a flat character array into lines.
   *
   * A new line starts when the vertical distance between consecutive characters
   * exceeds `fontSize * lineBreakMultiplier`.
   */
  private detectLines(chars: TextChar[]): TextChar[][] {
    if (chars.length === 0) return [];

    const lines: TextChar[][] = [];
    let currentLine: TextChar[] = [chars[0]];

    for (let i = 1; i < chars.length; i++) {
      const prev = chars[i - 1];
      const curr = chars[i];

      const fontSize = prev.fontSize > 0 ? prev.fontSize : 1;
      const verticalDiff = Math.abs(curr.y - prev.y);

      if (verticalDiff > fontSize * this.config.lineBreakMultiplier) {
        lines.push(currentLine);
        currentLine = [curr];
      } else {
        currentLine.push(curr);
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    return lines;
  }

  // -------------------------------------------------------------------------
  // Step 5: Group lines into blocks
  // -------------------------------------------------------------------------

  /**
   * Merge consecutive lines into blocks.
   *
   * Two consecutive lines belong to the same block when the vertical gap
   * between them is at most `lineHeight * blockBreakMultiplier`.
   * `lineHeight` is taken as the maximum `fontSize` in the previous line.
   */
  private groupIntoBlocks(lines: TextChar[][]): TextBlock[] {
    if (lines.length === 0) return [];

    const blocks: TextBlock[] = [];
    let currentLines: TextChar[][] = [lines[0]];

    for (let i = 1; i < lines.length; i++) {
      const prevLine = lines[i - 1];
      const currLine = lines[i];

      // Compute representative Y values for the two lines
      const prevLineY = lineTopY(prevLine);
      const currLineY = lineTopY(currLine);

      // Line height: maximum fontSize in the previous line
      const lineHeight = maxFontSize(prevLine);
      const gapBetweenLines = Math.abs(currLineY - prevLineY);
      const blockBreakThreshold = lineHeight * this.config.blockBreakMultiplier;

      if (gapBetweenLines > blockBreakThreshold) {
        blocks.push(buildBlock(currentLines));
        currentLines = [currLine];
      } else {
        currentLines.push(currLine);
      }
    }

    if (currentLines.length > 0) {
      blocks.push(buildBlock(currentLines));
    }

    return blocks;
  }

}


// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

/**
 * Compute the top-most (smallest) Y coordinate in a line.
 * In canvas space, smaller Y values are higher on the page.
 */
function lineTopY(line: TextChar[]): number {
  let minY = Infinity;
  for (const ch of line) {
    if (ch.y < minY) minY = ch.y;
  }
  return minY === Infinity ? 0 : minY;
}

/** Return the maximum fontSize across a line of characters. */
function maxFontSize(line: TextChar[]): number {
  let max = 0;
  for (const ch of line) {
    if (ch.fontSize > max) max = ch.fontSize;
  }
  return max > 0 ? max : 1;
}

/**
 * Build a TextBlock from a list of lines, computing lineBreaks indices.
 *
 * `lineBreaks` records the index in the flat chars array of the first
 * character in each line except the very first line.
 */
function buildBlock(lines: TextChar[][]): TextBlock {
  const allChars: TextChar[] = [];
  const lineBreaks: number[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (li > 0) {
      lineBreaks.push(allChars.length);
    }
    for (const ch of line) {
      allChars.push(ch);
    }
  }

  const id = nextTextBlockId();
  const first = allChars[0];
  const fontName = first !== undefined ? first.fontName : '';
  const fontSize = first !== undefined ? first.fontSize : 0;
  const color: [number, number, number] =
    first !== undefined
      ? [first.color[0], first.color[1], first.color[2]]
      : [0, 0, 0];

  return {
    id,
    chars: allChars,
    boundingBox: calculateBoundingBox(allChars),
    fontName,
    fontSize,
    text: extractText(allChars),
    editable: true,
    modified: false,
    color,
    lineBreaks,
  };
}


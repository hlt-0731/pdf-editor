/**
 * L3 Semantic Layer — TextBlock model
 *
 * Defines the data structures for positioned, Unicode-decoded text characters
 * and the blocks they are grouped into.  All coordinates are in canvas space
 * (top-left origin, scaled by the render scale factor).
 */

// ---------------------------------------------------------------------------
// Counter for unique IDs
// ---------------------------------------------------------------------------

let textBlockCounter = 0;

/** Reset the ID counter (useful in tests). */
export function resetTextBlockCounter(): void {
  textBlockCounter = 0;
}

// ---------------------------------------------------------------------------
// Rect
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// TextChar
// ---------------------------------------------------------------------------

/**
 * A single positioned Unicode character extracted from a PDF content stream.
 *
 * Coordinates are in canvas space (top-left origin) after applying the render
 * scale factor.  The coordinate origin is the top-left corner of the page.
 */
export interface TextChar {
  /** Decoded Unicode character (e.g. "A", "あ"). */
  char: string;
  /**
   * Glyph ID in the font.  Defaults to the raw charCode when no font encoding
   * table is available; a font engine layer can replace this with the true GID.
   */
  glyphId: number;
  /** X position of the glyph origin in canvas coordinates (pt). */
  x: number;
  /** Y position of the glyph origin in canvas coordinates (pt). */
  y: number;
  /** Rendering advance width in canvas coordinates (pt). */
  width: number;
  /** Approximate glyph height based on fontSize and scale (pt). */
  height: number;
  /** Font size in canvas coordinates (pt). */
  fontSize: number;
  /** Font resource name (without leading slash). */
  fontName: string;
  /** Fill colour as linear RGB [0, 1]. */
  color: [number, number, number];
  /** Text rendering matrix [a b c d e f] in page coordinates. */
  matrix: number[];
  /** Index of the parent ContentOperator in the operators array. */
  operatorIndex: number;
  /**
   * True for characters synthetically inserted by the grouping algorithm
   * (e.g. word-boundary spaces).  These do not correspond to actual characters
   * in any PDF content stream operator and must be excluded from the save
   * pipeline's operator rebuild logic.
   */
  synthetic?: boolean;
}

// ---------------------------------------------------------------------------
// TextBlock
// ---------------------------------------------------------------------------

/**
 * A group of TextChar values that form a coherent text run on the page.
 *
 * Blocks are separated by:
 *   - Significant vertical gaps (different lines / paragraphs)
 *   - Font or size changes
 *   - Large horizontal gaps
 */
export interface TextBlock {
  /** Unique identifier, e.g. "tb_0", "tb_1". */
  id: string;
  /** All characters belonging to this block, in reading order. */
  chars: TextChar[];
  /** Axis-aligned bounding box in canvas coordinates (pt). */
  boundingBox: Rect;
  /** Representative font name (from the first character). */
  fontName: string;
  /** Representative font size (from the first character). */
  fontSize: number;
  /** Plain text content of the block. */
  text: string;
  /**
   * Whether this block can be edited.
   * Set to true for blocks whose content operators are well-understood (Tj/TJ).
   */
  editable: boolean;
  /** True when the block has been modified by an edit operation. */
  modified: boolean;
  /** Representative fill colour (from the first character). */
  color: [number, number, number];
  /**
   * Indices into `chars` where a line break occurs.
   * The character at each index is the first character of a new line.
   */
  lineBreaks: number[];
  /**
   * True when this block was created by the user (not extracted from the PDF).
   * The save pipeline uses this to inject a complete BT…ET operator sequence
   * rather than replacing an existing operator.
   */
  isNew?: boolean;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Calculate the axis-aligned bounding box for a non-empty array of TextChar
 * values.  Returns a zero-area rect at the origin when `chars` is empty.
 */
export function calculateBoundingBox(chars: TextChar[]): Rect {
  if (chars.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const ch of chars) {
    const x1 = ch.x;
    const x2 = ch.x + ch.width;
    // ch.y is the baseline position; text extends above it (ascent) and
    // slightly below (descent).  Use standard font metric ratios to
    // approximate the visual extent.
    const y1 = ch.y - ch.fontSize * 0.85;
    const y2 = ch.y + ch.fontSize * 0.15;

    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Extract plain text from an array of TextChar values.
 * Characters are joined without separator; word spaces are already represented
 * as space characters inserted by the grouping algorithm.
 */
export function extractText(chars: TextChar[]): string {
  let text = '';
  for (const ch of chars) {
    text += ch.char;
  }
  return text;
}

/**
 * Create a TextBlock from a unique ID and an array of TextChar values.
 *
 * The representative font, size, and colour are taken from the first character.
 * The `editable` flag is true by default; callers can set it to false when
 * the operator type does not support editing.
 */
export function createTextBlock(id: string, chars: TextChar[]): TextBlock {
  const first = chars[0];

  const fontName = first !== undefined ? first.fontName : '';
  const fontSize = first !== undefined ? first.fontSize : 0;
  const color: [number, number, number] =
    first !== undefined
      ? [first.color[0], first.color[1], first.color[2]]
      : [0, 0, 0];

  return {
    id,
    chars,
    boundingBox: calculateBoundingBox(chars),
    fontName,
    fontSize,
    text: extractText(chars),
    editable: true,
    modified: false,
    color,
    lineBreaks: [],
  };
}

/**
 * Generate the next unique TextBlock ID.
 * Uses a module-level counter: "tb_0", "tb_1", …
 */
export function nextTextBlockId(): string {
  return `tb_${textBlockCounter++}`;
}

/**
 * Create a new empty TextBlock at the given canvas-space position.
 *
 * Used when the user clicks on empty space in "Add Text" mode.
 * The block has no chars — the inline editor will render typed characters
 * using the bounding box position.  The save pipeline recognises `isNew`
 * blocks and injects a complete BT/Tf/Tm/Tj/ET operator sequence.
 *
 * @param canvasX   Click X in canvas coordinates.
 * @param canvasY   Click Y in canvas coordinates (baseline).
 * @param fontSize  Font size in canvas coordinates.
 * @param fontName  Font resource name to use.
 */
export function createEmptyTextBlock(
  canvasX: number,
  canvasY: number,
  fontSize: number,
  fontName: string,
): TextBlock {
  const defaultWidth = fontSize * 10;
  const defaultHeight = fontSize * 1.2;
  return {
    id: nextTextBlockId(),
    chars: [],
    boundingBox: {
      x: canvasX,
      y: canvasY - fontSize * 0.85,
      width: defaultWidth,
      height: defaultHeight,
    },
    fontName,
    fontSize,
    text: '',
    editable: true,
    modified: false,
    color: [0, 0, 0],
    lineBreaks: [],
    isNew: true,
  };
}

/**
 * Merge multiple TextBlocks into a single block.
 *
 * The blocks are sorted by their bounding-box position (top-to-bottom,
 * left-to-right) before merging so that the resulting text reads in natural
 * order.  A synthetic space character is inserted between adjacent blocks
 * that were not originally contiguous, so the merged text is readable.
 *
 * Each character retains its original `operatorIndex`, allowing the save
 * pipeline to distribute edited text back to the correct operators.
 */
export function mergeTextBlocks(blocks: TextBlock[]): TextBlock {
  if (blocks.length === 0) {
    return createTextBlock(nextTextBlockId(), []);
  }
  if (blocks.length === 1) {
    return blocks[0];
  }

  // Sort by position: top-to-bottom (y), then left-to-right (x).
  const sorted = blocks.slice().sort((a, b) => {
    const dy = a.boundingBox.y - b.boundingBox.y;
    if (Math.abs(dy) > 2) return dy; // allow small vertical tolerance
    return a.boundingBox.x - b.boundingBox.x;
  });

  const allChars: TextChar[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];

    // Insert a synthetic space between blocks so the text is readable.
    if (i > 0 && allChars.length > 0) {
      const last = allChars[allChars.length - 1]!;
      allChars.push({
        char: ' ',
        glyphId: 0x20,
        x: last.x + last.width,
        y: last.y,
        width: last.fontSize * 0.3,
        height: last.height,
        fontSize: last.fontSize,
        fontName: last.fontName,
        color: [last.color[0], last.color[1], last.color[2]],
        matrix: last.matrix.slice(),
        operatorIndex: last.operatorIndex,
        synthetic: true,
      });
    }

    for (const ch of block.chars) {
      allChars.push(ch);
    }
  }

  const id = nextTextBlockId();
  const first = allChars.find(ch => !ch.synthetic) ?? allChars[0];
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
    lineBreaks: [],
  };
}

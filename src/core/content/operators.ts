/**
 * L2 Content Layer — Operator definitions
 *
 * Defines the typed representation of a single PDF content stream operator
 * together with the graphics state model tracked while executing operators.
 *
 * PDF 32000-1:2008 §8 (Graphics), §9 (Text)
 */

import type { PDFObject } from '../objects/types';

// ---------------------------------------------------------------------------
// ContentOperator
// ---------------------------------------------------------------------------

/**
 * A single parsed PDF content stream operator with its operands.
 *
 * `raw` holds the original bytes from the start of the first operand up to
 * and including the operator keyword.  When `modified` is false the raw bytes
 * are emitted verbatim by the writer, preserving the original byte-for-byte
 * representation including whitespace and comments.
 */
export interface ContentOperator {
  /** Operator keyword, e.g. 'BT', 'Tf', 'Tj', 'TJ', 'cm', 'Do'. */
  name: string;
  /** Operand values in order (left to right, as they appear before the keyword). */
  operands: PDFObject[];
  /** Original bytes (operands + whitespace + keyword). */
  raw: Uint8Array;
  /** Byte offset of the start of this operator (first operand byte, or keyword byte if no operands). */
  offset: number;
  /** True when this operator was changed by an editing operation; raw bytes are ignored on write. */
  modified: boolean;
}

// ---------------------------------------------------------------------------
// GraphicsState
// ---------------------------------------------------------------------------

/**
 * PDF graphics state snapshot.
 *
 * We track only the subset of state that is needed for text extraction and
 * basic colour-aware rendering.  The full graphics state (PDF §8.4) contains
 * many more fields that are intentionally omitted here.
 *
 * All matrices are stored in the canonical PDF 6-element form [a b c d e f]
 * which maps to the transformation:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export interface GraphicsState {
  // --- Transformation ---
  /** Current Transformation Matrix (maps user space → device space). */
  ctm: number[];

  // --- Colour ---
  /** Fill colour as linear RGB [0, 1]. */
  fillColor: [number, number, number];
  /** Stroke colour as linear RGB [0, 1]. */
  strokeColor: [number, number, number];
  fillColorSpace: string;
  strokeColorSpace: string;

  // --- Line geometry ---
  lineWidth: number;

  // --- Text state (PDF §9.3) ---
  /** Text matrix Tm — updated with each text-positioning operator. */
  textMatrix: number[];
  /** Text line matrix Tlm — updated only by text-positioning operators, not Tj/TJ. */
  lineMatrix: number[];
  /** Resource name of the current font (without leading slash). */
  fontName: string;
  /** Current font size in unscaled text space units. */
  fontSize: number;
  /** Character spacing (Tc). */
  charSpacing: number;
  /** Word spacing (Tw). */
  wordSpacing: number;
  /** Leading (TL) — distance between baselines when using T* / ' / ". */
  leading: number;
  /** Text rise (Ts). */
  textRise: number;
  /** Text rendering mode (Tr): 0 = fill, 1 = stroke, … */
  renderMode: number;
  /** Horizontal scaling (Tz), stored as a fraction (100 → 1.0). */
  horizontalScaling: number;
}

/**
 * Return a fresh GraphicsState at the PDF-spec defaults.
 * (PDF 32000-1:2008 Table 52 & Table 104)
 */
export function createDefaultGraphicsState(): GraphicsState {
  return {
    ctm: [1, 0, 0, 1, 0, 0],
    fillColor: [0, 0, 0],
    strokeColor: [0, 0, 0],
    fillColorSpace: 'DeviceGray',
    strokeColorSpace: 'DeviceGray',
    lineWidth: 1,
    textMatrix: [1, 0, 0, 1, 0, 0],
    lineMatrix: [1, 0, 0, 1, 0, 0],
    fontName: '',
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    leading: 0,
    textRise: 0,
    renderMode: 0,
    horizontalScaling: 1,
  };
}

/**
 * Deep-clone a GraphicsState so that the state stack push/pop is safe.
 */
export function cloneGraphicsState(s: GraphicsState): GraphicsState {
  return {
    ctm: s.ctm.slice(),
    fillColor: [s.fillColor[0], s.fillColor[1], s.fillColor[2]],
    strokeColor: [s.strokeColor[0], s.strokeColor[1], s.strokeColor[2]],
    fillColorSpace: s.fillColorSpace,
    strokeColorSpace: s.strokeColorSpace,
    lineWidth: s.lineWidth,
    textMatrix: s.textMatrix.slice(),
    lineMatrix: s.lineMatrix.slice(),
    fontName: s.fontName,
    fontSize: s.fontSize,
    charSpacing: s.charSpacing,
    wordSpacing: s.wordSpacing,
    leading: s.leading,
    textRise: s.textRise,
    renderMode: s.renderMode,
    horizontalScaling: s.horizontalScaling,
  };
}

// ---------------------------------------------------------------------------
// Operator classification
// ---------------------------------------------------------------------------

/**
 * High-level category of a PDF content stream operator.
 */
export type OperatorCategory =
  | 'text'
  | 'graphics_state'
  | 'path'
  | 'color'
  | 'xobject'
  | 'marked_content'
  | 'inline_image'
  | 'other';

/**
 * Text operators — begin/end text blocks, glyph painting, text positioning,
 * and text state setters.  (PDF §9.4, §9.3)
 */
export const TEXT_OPERATORS: ReadonlySet<string> = new Set([
  'BT', 'ET',
  'Tf',
  'Td', 'TD', 'Tm', 'T*',
  'Tj', 'TJ', "'", '"',
  'Tc', 'Tw', 'TL', 'Tr', 'Ts', 'Tz',
]);

/**
 * Graphics state operators — save/restore stack, CTM, and device-independent
 * parameters.  (PDF §8.4.4)
 */
export const GRAPHICS_STATE_OPERATORS: ReadonlySet<string> = new Set([
  'q', 'Q', 'cm',
  'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs',
]);

/**
 * Path construction and painting operators.  (PDF §8.5)
 */
export const PATH_OPERATORS: ReadonlySet<string> = new Set([
  // construction
  'm', 'l', 'c', 'v', 'y', 'h', 're',
  // painting
  'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n',
  // clipping
  'W', 'W*',
]);

/**
 * Colour-space and colour-setting operators.  (PDF §8.6)
 */
export const COLOR_OPERATORS: ReadonlySet<string> = new Set([
  'CS', 'cs',
  'SC', 'SCN', 'sc', 'scn',
  'G', 'g',
  'RG', 'rg',
  'K', 'k',
]);

/** XObject invocation. */
export const XOBJECT_OPERATORS: ReadonlySet<string> = new Set(['Do']);

/** Marked-content operators.  (PDF §14.6) */
export const MARKED_CONTENT_OPERATORS: ReadonlySet<string> = new Set([
  'BMC', 'BDC', 'EMC', 'MP', 'DP',
]);

/** Inline image operators. */
export const INLINE_IMAGE_OPERATORS: ReadonlySet<string> = new Set(['BI', 'ID', 'EI']);

/**
 * Return the high-level category for a given operator keyword.
 */
export function getOperatorCategory(name: string): OperatorCategory {
  if (TEXT_OPERATORS.has(name)) return 'text';
  if (GRAPHICS_STATE_OPERATORS.has(name)) return 'graphics_state';
  if (PATH_OPERATORS.has(name)) return 'path';
  if (COLOR_OPERATORS.has(name)) return 'color';
  if (XOBJECT_OPERATORS.has(name)) return 'xobject';
  if (MARKED_CONTENT_OPERATORS.has(name)) return 'marked_content';
  if (INLINE_IMAGE_OPERATORS.has(name)) return 'inline_image';
  return 'other';
}

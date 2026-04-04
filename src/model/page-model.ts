/**
 * L3 Semantic Layer — Page-level model
 *
 * Aggregates all semantic objects for a single PDF page: positioned text
 * blocks, image blocks, the raw operator list, and the page dictionary.
 *
 * Also provides coordinate conversion utilities between PDF space (bottom-left
 * origin) and canvas space (top-left origin).
 */

import type { TextBlock } from './text-block.ts';
import type { ImageBlock } from './image-block.ts';
import type { ContentOperator } from '../core/content/operators.ts';
import type { PDFDictionary } from '../core/objects/types.ts';
import { PDFObjectType } from '../core/objects/types.ts';

// ---------------------------------------------------------------------------
// PageModel
// ---------------------------------------------------------------------------

/**
 * The complete semantic representation of a single page.
 *
 * `operators` is the same array reference consumed by the L2 layer; consumers
 * can mark individual operators as `modified` to trigger re-serialisation.
 */
export interface PageModel {
  /** Zero-based page index within the document. */
  pageIndex: number;
  /** Page width in points (from MediaBox or CropBox). */
  width: number;
  /** Page height in points (from MediaBox or CropBox). */
  height: number;
  /** Grouped, Unicode-decoded text blocks in reading order. */
  textBlocks: TextBlock[];
  /** Positioned image XObject blocks. */
  imageBlocks: ImageBlock[];
  /**
   * Full content operator list for this page.
   * Modifying `operator.modified` and `operator.operands` / `operator.raw`
   * lets the writer re-serialise only changed operators.
   */
  operators: ContentOperator[];
  /** Reference to the page dictionary (for resource and annotation access). */
  pageDict: PDFDictionary;
}

// ---------------------------------------------------------------------------
// Default page dimensions (US Letter)
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 612;
const DEFAULT_HEIGHT = 792;

// ---------------------------------------------------------------------------
// getPageDimensions
// ---------------------------------------------------------------------------

/**
 * Extract page dimensions from the page dictionary.
 *
 * Priority:
 *   1. /CropBox  — the visible page area (used when present)
 *   2. /MediaBox — the physical page area
 *   3. 612 × 792 — US Letter default
 *
 * Both boxes are arrays of four numbers [x1 y1 x2 y2].
 * Width  = x2 - x1
 * Height = y2 - y1
 */
export function getPageDimensions(pageDict: PDFDictionary): { width: number; height: number } {
  const cropBox = readBox(pageDict, 'CropBox');
  if (cropBox !== undefined) return cropBox;

  const mediaBox = readBox(pageDict, 'MediaBox');
  if (mediaBox !== undefined) return mediaBox;

  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

// ---------------------------------------------------------------------------
// Coordinate conversion utilities
// ---------------------------------------------------------------------------

/**
 * Convert a point from PDF coordinates (bottom-left origin) to canvas
 * coordinates (top-left origin).
 *
 *   canvasX = pdfX * scale
 *   canvasY = (pageHeight - pdfY) * scale
 */
export function pdfToCanvas(
  pdfX: number,
  pdfY: number,
  pageHeight: number,
  scale: number,
): { canvasX: number; canvasY: number } {
  return {
    canvasX: pdfX * scale,
    canvasY: (pageHeight - pdfY) * scale,
  };
}

/**
 * Convert a point from canvas coordinates (top-left origin) to PDF
 * coordinates (bottom-left origin).
 *
 *   pdfX = canvasX / scale
 *   pdfY = pageHeight - (canvasY / scale)
 */
export function canvasToPdf(
  canvasX: number,
  canvasY: number,
  pageHeight: number,
  scale: number,
): { pdfX: number; pdfY: number } {
  return {
    pdfX: canvasX / scale,
    pdfY: pageHeight - canvasY / scale,
  };
}

// ---------------------------------------------------------------------------
// buildPageModel
// ---------------------------------------------------------------------------

/**
 * Assemble a PageModel from its constituent parts.
 *
 * Dimensions are read from the page dictionary's MediaBox / CropBox.
 */
export function buildPageModel(
  pageIndex: number,
  pageDict: PDFDictionary,
  operators: ContentOperator[],
  textBlocks: TextBlock[],
  imageBlocks: ImageBlock[],
): PageModel {
  const { width, height } = getPageDimensions(pageDict);

  return {
    pageIndex,
    width,
    height,
    textBlocks,
    imageBlocks,
    operators,
    pageDict,
  };
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

/**
 * Read a box entry (MediaBox or CropBox) from a page dictionary.
 *
 * Returns undefined when the entry is absent or malformed.
 * A box is a PDF array of four numbers: [x1 y1 x2 y2].
 */
function readBox(
  dict: PDFDictionary,
  key: string,
): { width: number; height: number } | undefined {
  const entry = dict.get(key);
  if (entry === undefined) return undefined;
  if (entry.type !== PDFObjectType.Array) return undefined;

  const items = entry.items;
  if (items.length < 4) return undefined;

  const x1 = numberValue(items[0]);
  const y1 = numberValue(items[1]);
  const x2 = numberValue(items[2]);
  const y2 = numberValue(items[3]);

  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined;
  }

  const w = x2 - x1;
  const h = y2 - y1;

  if (w <= 0 || h <= 0) return undefined;

  return { width: w, height: h };
}

/** Extract a numeric value from a PDFObject, or return undefined. */
function numberValue(
  obj: import('../core/objects/types.ts').PDFObject | undefined,
): number | undefined {
  if (obj === undefined) return undefined;
  if (obj.type !== PDFObjectType.Number) return undefined;
  return obj.value;
}

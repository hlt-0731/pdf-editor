/**
 * L3 Semantic Layer — ImageBlock model
 *
 * Represents a single XObject image placed on a PDF page.  The bounding box
 * is computed from the placement matrix and the image's pixel dimensions,
 * converted to canvas space (top-left origin).
 */

import type { Rect } from './text-block.ts';

// ---------------------------------------------------------------------------
// Counter for unique IDs
// ---------------------------------------------------------------------------

let imageBlockCounter = 0;

/** Reset the ID counter (useful in tests). */
export function resetImageBlockCounter(): void {
  imageBlockCounter = 0;
}

/**
 * Generate the next unique ImageBlock ID.
 * Uses a module-level counter: "ib_0", "ib_1", …
 */
export function nextImageBlockId(): string {
  return `ib_${imageBlockCounter++}`;
}

// ---------------------------------------------------------------------------
// ImageBlock
// ---------------------------------------------------------------------------

/**
 * A single image XObject placed on a PDF page.
 *
 * The bounding box is in canvas coordinates (top-left origin, scaled by the
 * render scale factor).  The original PDF placement matrix is preserved for
 * round-trip editing.
 */
export interface ImageBlock {
  /** Unique identifier, e.g. "ib_0", "ib_1". */
  id: string;
  /** Resource name of the image XObject (without leading slash), e.g. "Im1". */
  xObjectName: string;
  /** Axis-aligned bounding box in canvas coordinates (pt). */
  boundingBox: Rect;
  /** Original PDF placement matrix [a b c d e f] in page coordinates. */
  matrix: number[];
  /** Image pixel width (from the XObject dictionary). */
  width: number;
  /** Image pixel height (from the XObject dictionary). */
  height: number;
  /** True when the image has been replaced or repositioned by an edit operation. */
  modified: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ImageBlock from its placement parameters.
 *
 * PDF images are rendered in a 1×1 user-space square transformed by the
 * placement matrix [a b c d e f].  The corners of the unit square under this
 * transform give the four corners of the image in page (PDF) coordinates:
 *
 *   (0, 0), (1, 0), (0, 1), (1, 1)  →  transform  →  four page-space corners
 *
 * We then convert all corners to canvas space and take the bounding box.
 *
 * Coordinate conversion:
 *   canvasX = pdfX * scale
 *   canvasY = (pageHeight - pdfY) * scale
 *
 * @param id            Unique block identifier.
 * @param xObjectName   Resource name without leading slash.
 * @param matrix        PDF placement matrix [a b c d e f].
 * @param width         Image pixel width (informational).
 * @param height        Image pixel height (informational).
 * @param pageHeight    Page height in points (for Y-axis flip).
 * @param scale         Render scale factor (canvas px per pt).
 */
export function createImageBlock(
  id: string,
  xObjectName: string,
  matrix: number[],
  width: number,
  height: number,
  pageHeight: number,
  scale: number,
): ImageBlock {
  // Unit square corners in image (object) space: (0,0), (1,0), (0,1), (1,1)
  const unitCorners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];

  // PDF matrix convention: [a b c d e f]
  //   x' = a*x + c*y + e
  //   y' = b*x + d*y + f
  const a = matrix[0] ?? 1;
  const b = matrix[1] ?? 0;
  const c = matrix[2] ?? 0;
  const d = matrix[3] ?? 1;
  const e = matrix[4] ?? 0;
  const f = matrix[5] ?? 0;

  let minCX = Infinity;
  let minCY = Infinity;
  let maxCX = -Infinity;
  let maxCY = -Infinity;

  for (const [ux, uy] of unitCorners) {
    const pdfX = a * ux + c * uy + e;
    const pdfY = b * ux + d * uy + f;

    const canvasX = pdfX * scale;
    const canvasY = (pageHeight - pdfY) * scale;

    if (canvasX < minCX) minCX = canvasX;
    if (canvasY < minCY) minCY = canvasY;
    if (canvasX > maxCX) maxCX = canvasX;
    if (canvasY > maxCY) maxCY = canvasY;
  }

  const boundingBox: Rect = {
    x: minCX,
    y: minCY,
    width: maxCX - minCX,
    height: maxCY - minCY,
  };

  return {
    id,
    xObjectName,
    boundingBox,
    matrix: matrix.slice(),
    width,
    height,
    modified: false,
  };
}

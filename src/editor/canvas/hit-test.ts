/**
 * L4 Editor Layer — Hit Testing
 *
 * Determines which content block (if any) lies under a given canvas-space
 * pointer coordinate.  Text blocks are tested before image blocks so that
 * overlapping text takes priority.
 */

import type { TextBlock } from '../../model/text-block';
import type { Rect } from '../../model/text-block';
import type { ImageBlock } from '../../model/image-block';

// ---------------------------------------------------------------------------
// HitTarget
// ---------------------------------------------------------------------------

export type HitTarget =
  | { type: 'text';  block: TextBlock  }
  | { type: 'image'; block: ImageBlock }
  | { type: 'none'  };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Test the given canvas-space point against all text and image blocks.
 *
 * Block bounding boxes are stored in canvas coordinates (already scaled),
 * so `canvasX` and `canvasY` can be compared directly.  The `scale` parameter
 * is accepted for API symmetry and future use (e.g. hit-padding based on zoom)
 * but is not applied to the stored coordinates.
 *
 * Text blocks are checked first; image blocks are checked only when no text
 * block is hit.
 */
export function hitTest(
  canvasX: number,
  canvasY: number,
  textBlocks: TextBlock[],
  imageBlocks: ImageBlock[],
  scale: number,
): HitTarget {
  for (const block of textBlocks) {
    if (isInsideRect(canvasX, canvasY, block.boundingBox, scale)) {
      return { type: 'text', block };
    }
  }

  for (const block of imageBlocks) {
    if (isInsideRect(canvasX, canvasY, block.boundingBox, scale)) {
      return { type: 'image', block };
    }
  }

  return { type: 'none' };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Return true if the point (x, y) is inside `rect`.
 *
 * Bounding boxes are stored in pre-scaled canvas coordinates, so no additional
 * scaling is applied.  The `scale` parameter is retained so callers may extend
 * this function with a zoom-aware hit-margin in the future.
 */
function isInsideRect(x: number, y: number, rect: Rect, _scale: number): boolean {
  return (
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height
  );
}

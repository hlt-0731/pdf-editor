/**
 * L2.5 Font Engine — Font metrics (glyph widths)
 *
 * Provides glyph-width lookup and string-width calculation for the three
 * width-specification styles found in PDF fonts:
 *
 *   1. /Widths array (Type1 / TrueType simple fonts)
 *   2. /W array     (CIDFont Type0 / Type2)
 *   3. Default width (fallback when no width data is available)
 *
 * Widths are stored in 1/1000 units (glyph-space units); the
 * `getStringWidth` helper converts to points given a font size.
 */

import type { PDFObject } from '../objects/types.ts';
import { isNumber, isArray } from '../objects/types.ts';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface FontMetrics {
  /** Return the width of a glyph in 1/1000 glyph-space units. */
  getGlyphWidth(glyphId: number): number;
  /** Return the total width of a string in typographic points. */
  getStringWidth(text: string, fontSize: number): number;
  /** Typographic ascent in 1/1000 units (positive = above baseline). */
  ascent: number;
  /** Typographic descent in 1/1000 units (negative = below baseline). */
  descent: number;
  /** Default glyph width used when no specific width is available. */
  defaultWidth: number;
}

// ---------------------------------------------------------------------------
// FontMetricsBuilder
// ---------------------------------------------------------------------------

export class FontMetricsBuilder {
  /**
   * Build metrics from a Type1 / TrueType /Widths array.
   *
   * @param firstChar  The character code corresponding to widths[0].
   * @param widths     Width values in 1/1000 glyph-space units.
   */
  buildFromWidthsArray(firstChar: number, widths: number[]): FontMetrics {
    const widthMap = new Map<number, number>();
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i];
      if (w !== undefined) {
        widthMap.set(firstChar + i, w);
      }
    }
    return createMetrics(widthMap, DEFAULT_WIDTH, DEFAULT_ASCENT, DEFAULT_DESCENT);
  }

  /**
   * Build metrics from a CIDFont /W array.
   *
   * The /W array alternates between two range formats:
   *   Format 1: startCID [w1 w2 ...]  — individual widths for a run of CIDs
   *   Format 2: startCID endCID w     — single width applied to a whole range
   *
   * @param w   The /W array items (already unwrapped from PDFArray).
   * @param dw  Default width from /DW (falls back to DEFAULT_WIDTH if absent).
   */
  buildFromCIDWidths(w: PDFObject[], dw: number): FontMetrics {
    const widthMap = new Map<number, number>();
    let i = 0;

    while (i < w.length) {
      const first = w[i];
      const second = w[i + 1];

      if (first === undefined || second === undefined) break;

      if (!isNumber(first)) {
        i++;
        continue;
      }

      const startCID = first.value;

      if (isArray(second)) {
        // Format 1: startCID [w1 w2 w3 ...]
        for (let k = 0; k < second.items.length; k++) {
          const item = second.items[k];
          if (item !== undefined && isNumber(item)) {
            widthMap.set(startCID + k, item.value);
          }
        }
        i += 2;
      } else if (isNumber(second)) {
        // Format 2: startCID endCID w  (needs a third element)
        const third = w[i + 2];
        if (third !== undefined && isNumber(third)) {
          const endCID = second.value;
          const width = third.value;
          for (let cid = startCID; cid <= endCID; cid++) {
            widthMap.set(cid, width);
          }
          i += 3;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return createMetrics(widthMap, dw, DEFAULT_ASCENT, DEFAULT_DESCENT);
  }

  /**
   * Build a metrics object using only a default width.
   * Used when the font dictionary provides no width information.
   *
   * @param defaultWidth  Width to return for every glyph. Defaults to 1000
   *                      (the width of a 1-em square in 1/1000 units).
   */
  buildDefault(defaultWidth?: number): FontMetrics {
    return createMetrics(new Map(), defaultWidth ?? DEFAULT_WIDTH, DEFAULT_ASCENT, DEFAULT_DESCENT);
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers and constants
// ---------------------------------------------------------------------------

/** Standard default glyph width in 1/1000 units when no /Widths is present. */
const DEFAULT_WIDTH = 1000;

/** Approximate ascent for an unknown font, in 1/1000 units. */
const DEFAULT_ASCENT = 800;

/** Approximate descent for an unknown font, in 1/1000 units (negative). */
const DEFAULT_DESCENT = -200;

/**
 * Create a FontMetrics implementation from a width map and scalar parameters.
 */
function createMetrics(
  widthMap: Map<number, number>,
  defaultWidth: number,
  ascent: number,
  descent: number,
): FontMetrics {
  return {
    ascent,
    descent,
    defaultWidth,

    getGlyphWidth(glyphId: number): number {
      return widthMap.get(glyphId) ?? defaultWidth;
    },

    getStringWidth(text: string, fontSize: number): number {
      let totalUnits = 0;
      for (const char of text) {
        const cp = char.codePointAt(0);
        if (cp !== undefined) {
          totalUnits += widthMap.get(cp) ?? defaultWidth;
        }
      }
      // Convert from 1/1000 glyph-space units to typographic points
      return (totalUnits / 1000) * fontSize;
    },
  };
}

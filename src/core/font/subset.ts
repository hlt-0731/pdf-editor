/**
 * L2.5 Font Engine — Font subset extension (stub)
 *
 * Placeholder for Phase 7 font subsetting support.
 * When a PDF embeds a font subset (indicated by a name prefix such as
 * "ABCDEF+FontName"), only the glyphs used in the original document are
 * included.  Editing the document may require adding new glyphs to the
 * subset.
 *
 * This stub records the intent of the API; the actual implementation will
 * require parsing the embedded font binary (TrueType / CFF) and updating
 * the glyph index, loca, hmtx, and cmap tables.
 */

export class FontSubsetExtender {
  /**
   * Check whether a specific glyph ID is present in the embedded font
   * subset.
   *
   * Phase 7 implementation note: this should parse the 'loca' table of a
   * TrueType font (or the charstring index of a CFF font) to determine
   * whether the glyph offset is non-zero / non-empty.
   *
   * @param _fontStream  Raw bytes of the embedded font program.
   * @param _glyphId     Glyph ID to look up.
   * @returns            Always false in this stub.
   */
  hasGlyph(_fontStream: Uint8Array, _glyphId: number): boolean {
    return false;
  }

  /**
   * Report whether this implementation supports extending font subsets.
   * Returns false in the stub; Phase 7 will return true after implementing
   * the font-binary rewriting logic.
   */
  canExtendSubset(): boolean {
    return false;
  }
}

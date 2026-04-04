/**
 * L2.5 Font Engine — Font dictionary resolution
 *
 * FontManager resolves PDF font resource dictionaries into ResolvedFont
 * objects that provide:
 *   - Unicode ↔ character-code conversion (via ToUnicode CMap or encoding table)
 *   - Glyph width information (via FontMetrics)
 *   - Metadata (baseFont, subtype, encoding, embedded/CID flags)
 *
 * Encoding resolution order for simple fonts (Type1, TrueType):
 *   1. ToUnicode CMap stream (highest fidelity)
 *   2. /Encoding name (/WinAnsiEncoding, /MacRomanEncoding)
 *   3. /Encoding dictionary with /Differences array
 *   4. Standard Latin fallback
 *
 * Security Rules impact: none — this module is pure read-only parsing.
 */

import type { ObjectResolver } from '../objects/resolver.ts';
import type { PDFDictionary } from '../objects/types.ts';
import {
  isRef,
  isDict,
  isName,
  isNumber,
  isArray,
  isStream,
  getName,
  getNumber,
} from '../objects/types.ts';
import { decodeStream } from '../binary/stream.ts';
import { CMapParser } from './cmap.ts';
import type { FontMetrics } from './metrics.ts';
import { FontMetricsBuilder } from './metrics.ts';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ResolvedFont {
  /** Font resource name as it appears in the content stream, e.g. "F1". */
  name: string;
  /** Value of /BaseFont, e.g. "Helvetica". */
  baseFont: string;
  /** Font subtype: Type1 | TrueType | Type0 | CIDFontType0 | CIDFontType2 */
  subtype: string;
  /** Encoding name: WinAnsiEncoding, MacRomanEncoding, Identity-H, etc. */
  encoding: string;
  /** Parsed ToUnicode CMap (present only when the font embeds a ToUnicode stream). */
  toUnicode?: CMapParser;
  /** Glyph width information. */
  metrics: FontMetrics;
  /** True when font data (e.g. FontFile / FontFile2 / FontFile3) is embedded. */
  isEmbedded: boolean;
  /** True for Type0 (composite / CID) fonts. */
  isCID: boolean;
  /** Decode a character code from the PDF content stream to a Unicode string. */
  charCodeToUnicode(code: number): string;
  /** Encode a Unicode character to a PDF content-stream character code. */
  unicodeToCharCode(char: string): number | null;
}

// ---------------------------------------------------------------------------
// FontManager
// ---------------------------------------------------------------------------

export class FontManager {
  private readonly fonts: Map<string, ResolvedFont> = new Map();
  private readonly builder = new FontMetricsBuilder();
  private readonly resolver: ObjectResolver;

  constructor(resolver: ObjectResolver) {
    this.resolver = resolver;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Resolve all fonts listed in a page's /Resources /Font sub-dictionary.
   * Returns the map of font resource names → ResolvedFont.
   *
   * @param resources  The page /Resources dictionary.
   */
  resolvePageFonts(resources: PDFDictionary): Map<string, ResolvedFont> {
    const fontDictEntry = resources.get('Font');
    if (fontDictEntry === undefined) return this.fonts;

    const fontDictObj = this.resolver.resolveIfRef(fontDictEntry);
    if (!isDict(fontDictObj)) return this.fonts;

    for (const [name, fontRef] of fontDictObj.entries) {
      if (this.fonts.has(name)) continue; // already resolved

      const fontDictRaw = this.resolver.resolveIfRef(fontRef);
      if (!isDict(fontDictRaw)) continue;

      const resolved = this.resolveFont(name, fontDictRaw);
      this.fonts.set(name, resolved);
    }

    return this.fonts;
  }

  /**
   * Look up a previously resolved font by its resource name.
   *
   * @param name  Font resource name, e.g. "F1".
   */
  getFont(name: string): ResolvedFont | undefined {
    return this.fonts.get(name);
  }

  // -------------------------------------------------------------------------
  // Private: font resolution dispatch
  // -------------------------------------------------------------------------

  private resolveFont(name: string, fontDict: PDFDictionary): ResolvedFont {
    const subtypeEntry = fontDict.get('Subtype');
    const subtype = getName(subtypeEntry) ?? 'Type1';

    if (subtype === 'Type0') {
      return this.resolveType0Font(name, fontDict);
    }
    return this.resolveSimpleFont(name, fontDict, subtype);
  }

  /**
   * Resolve a Type0 (composite / CID) font.
   * The actual width data lives in the first element of /DescendantFonts.
   */
  private resolveType0Font(name: string, fontDict: PDFDictionary): ResolvedFont {
    const baseFontEntry = fontDict.get('BaseFont');
    const baseFont = getName(baseFontEntry) ?? 'Unknown';

    const encodingEntry = fontDict.get('Encoding');
    const encoding = getName(encodingEntry) ?? 'Identity-H';

    // Resolve ToUnicode CMap
    const toUnicode = this.resolveToUnicode(fontDict);

    // Descendant fonts
    let metrics: FontMetrics = this.builder.buildDefault();
    let isEmbedded = false;

    const descEntry = fontDict.get('DescendantFonts');
    if (descEntry !== undefined) {
      const descObj = this.resolver.resolveIfRef(descEntry);
      if (isArray(descObj) && descObj.items.length > 0) {
        const firstItem = descObj.items[0];
        if (firstItem !== undefined) {
          const descendant = this.resolver.resolveIfRef(firstItem);
          if (isDict(descendant)) {
            metrics = this.buildCIDMetrics(descendant);
            isEmbedded = this.detectEmbedded(descendant);
          }
        }
      }
    }

    const resolvedFont: ResolvedFont = {
      name,
      baseFont,
      subtype: 'Type0',
      encoding,
      toUnicode,
      metrics,
      isEmbedded,
      isCID: true,
      charCodeToUnicode(code: number): string {
        if (toUnicode !== undefined) {
          return toUnicode.glyphToUnicode(code);
        }
        // Identity-H / Identity-V: treat code as Unicode directly
        return String.fromCodePoint(code);
      },
      unicodeToCharCode(char: string): number | null {
        if (toUnicode !== undefined) {
          return toUnicode.unicodeToGlyph(char);
        }
        return char.codePointAt(0) ?? null;
      },
    };

    return resolvedFont;
  }

  /**
   * Resolve a simple font (Type1, TrueType, MMType1, Type3).
   */
  private resolveSimpleFont(
    name: string,
    fontDict: PDFDictionary,
    subtype: string,
  ): ResolvedFont {
    const baseFontEntry = fontDict.get('BaseFont');
    const baseFont = getName(baseFontEntry) ?? 'Unknown';

    // Resolve ToUnicode CMap
    const toUnicode = this.resolveToUnicode(fontDict);

    // Build encoding table (char code → Unicode string)
    const encodingTable = this.buildSimpleEncoding(fontDict);
    const encodingEntry = fontDict.get('Encoding');
    let encodingName = getName(encodingEntry) ?? 'StandardEncoding';
    if (isDict(encodingEntry ?? { type: 'null' as const })) {
      const baseEnc = encodingEntry !== undefined && isDict(encodingEntry)
        ? getName(encodingEntry.get('BaseEncoding'))
        : undefined;
      encodingName = baseEnc ?? 'StandardEncoding';
    }

    // Build width metrics
    const metrics = this.buildSimpleMetrics(fontDict);
    const isEmbedded = this.detectEmbedded(fontDict);

    const resolvedFont: ResolvedFont = {
      name,
      baseFont,
      subtype,
      encoding: encodingName,
      toUnicode,
      metrics,
      isEmbedded,
      isCID: false,
      charCodeToUnicode(code: number): string {
        // ToUnicode CMap takes priority
        if (toUnicode !== undefined) {
          return toUnicode.glyphToUnicode(code);
        }
        const mapped = encodingTable.get(code);
        return mapped ?? String.fromCodePoint(code);
      },
      unicodeToCharCode(char: string): number | null {
        // ToUnicode CMap (reverse lookup) — authoritative for Type3 subsets
        if (toUnicode !== undefined) {
          const glyph = toUnicode.unicodeToGlyph(char);
          if (glyph !== null) return glyph;
          // When the font has a ToUnicode CMap but the character is not in it,
          // the font genuinely lacks that glyph.  Do NOT fall through to the
          // encoding table — its code→name mapping is often inconsistent with
          // the ToUnicode for Type3 subset fonts, leading to garbled output.
          return null;
        }
        // Encoding table reverse lookup (only when no ToUnicode is available)
        for (const [code, uStr] of encodingTable) {
          if (uStr === char) return code;
        }
        return null;
      },
    };

    return resolvedFont;
  }

  // -------------------------------------------------------------------------
  // Private: encoding table construction
  // -------------------------------------------------------------------------

  /**
   * Build a code → Unicode-string encoding table for a simple font dictionary.
   */
  private buildSimpleEncoding(fontDict: PDFDictionary): Map<number, string> {
    const encodingEntry = fontDict.get('Encoding');
    if (encodingEntry === undefined) {
      return buildNamedEncoding('WinAnsiEncoding');
    }

    const resolved = this.resolver.resolveIfRef(encodingEntry);

    if (isName(resolved)) {
      return buildNamedEncoding(resolved.value);
    }

    if (isDict(resolved)) {
      return this.parseEncodingDifferences(resolved);
    }

    return buildNamedEncoding('WinAnsiEncoding');
  }

  /**
   * Build an encoding table from an /Encoding dictionary that has a
   * /Differences array.  Starts from the named /BaseEncoding (or
   * WinAnsiEncoding as default) then applies the differences.
   */
  private parseEncodingDifferences(encoding: PDFDictionary): Map<number, string> {
    const baseEncEntry = encoding.get('BaseEncoding');
    const baseEncName = getName(baseEncEntry) ?? 'WinAnsiEncoding';
    const table = buildNamedEncoding(baseEncName);

    const diffsEntry = encoding.get('Differences');
    if (diffsEntry === undefined) return table;

    const diffs = this.resolver.resolveIfRef(diffsEntry);
    if (!isArray(diffs)) return table;

    let currentCode = 0;
    for (const item of diffs.items) {
      if (isNumber(item)) {
        currentCode = item.value;
      } else if (isName(item)) {
        const cp = ADOBE_GLYPH_LIST.get(item.value);
        if (cp !== undefined) {
          table.set(currentCode, String.fromCodePoint(cp));
        }
        currentCode++;
      }
    }

    return table;
  }

  // -------------------------------------------------------------------------
  // Private: metrics construction
  // -------------------------------------------------------------------------

  /** Build FontMetrics for a simple font from its /FirstChar + /Widths. */
  private buildSimpleMetrics(fontDict: PDFDictionary): FontMetrics {
    const firstCharEntry = fontDict.get('FirstChar');
    const widthsEntry = fontDict.get('Widths');

    const firstChar = getNumber(firstCharEntry);
    if (firstChar === undefined || widthsEntry === undefined) {
      return this.builder.buildDefault();
    }

    const widthsObj = this.resolver.resolveIfRef(widthsEntry);
    if (!isArray(widthsObj)) return this.builder.buildDefault();

    const widths: number[] = [];
    for (const item of widthsObj.items) {
      widths.push(isNumber(item) ? item.value : 0);
    }

    return this.builder.buildFromWidthsArray(firstChar, widths);
  }

  /** Build FontMetrics for a CIDFont from its /W and /DW entries. */
  private buildCIDMetrics(descendant: PDFDictionary): FontMetrics {
    const dwEntry = descendant.get('DW');
    const dw = getNumber(dwEntry) ?? 1000;

    const wEntry = descendant.get('W');
    if (wEntry === undefined) {
      return this.builder.buildFromCIDWidths([], dw);
    }

    const wObj = this.resolver.resolveIfRef(wEntry);
    if (!isArray(wObj)) return this.builder.buildFromCIDWidths([], dw);

    return this.builder.buildFromCIDWidths(wObj.items, dw);
  }

  // -------------------------------------------------------------------------
  // Private: ToUnicode CMap resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve and parse the /ToUnicode CMap stream if present.
   * Returns undefined when the font has no ToUnicode entry.
   */
  private resolveToUnicode(fontDict: PDFDictionary): CMapParser | undefined {
    const toUnicodeEntry = fontDict.get('ToUnicode');
    if (toUnicodeEntry === undefined) return undefined;

    let streamObj = isRef(toUnicodeEntry)
      ? this.resolver.resolve(toUnicodeEntry)
      : toUnicodeEntry;

    // May still be a ref inside the value
    if (isRef(streamObj)) {
      streamObj = this.resolver.resolve(streamObj);
    }

    if (!isStream(streamObj)) return undefined;

    // Decode the stream bytes
    const decoded = decodeStreamBytes(streamObj.rawData, streamObj.dict);
    const text = new TextDecoder('latin1').decode(decoded);

    const parser = new CMapParser();
    parser.parse(text);
    return parser;
  }

  // -------------------------------------------------------------------------
  // Private: embedded font detection
  // -------------------------------------------------------------------------

  /**
   * Return true if a font (or its FontDescriptor) contains an embedded
   * font program (FontFile, FontFile2, or FontFile3).
   */
  private detectEmbedded(fontDict: PDFDictionary): boolean {
    const descEntry = fontDict.get('FontDescriptor');
    if (descEntry === undefined) return false;

    const desc = this.resolver.resolveIfRef(descEntry);
    if (!isDict(desc)) return false;

    return (
      desc.has('FontFile') ||
      desc.has('FontFile2') ||
      desc.has('FontFile3')
    );
  }
}

// ---------------------------------------------------------------------------
// Module-private: stream decoding helper
// ---------------------------------------------------------------------------

/**
 * Decode stream bytes using the filters listed in the stream dictionary.
 */
function decodeStreamBytes(rawData: Uint8Array, dict: PDFDictionary): Uint8Array {
  const filterEntry = dict.get('Filter');
  if (filterEntry === undefined) return rawData;

  const filters: string[] = [];

  if (isName(filterEntry)) {
    filters.push(filterEntry.value);
  } else if (isArray(filterEntry)) {
    for (const item of filterEntry.items) {
      if (isName(item)) filters.push(item.value);
    }
  }

  if (filters.length === 0) return rawData;

  return decodeStream(rawData, filters);
}

// ---------------------------------------------------------------------------
// Named encoding tables
// ---------------------------------------------------------------------------

function buildNamedEncoding(name: string): Map<number, string> {
  switch (name) {
    case 'WinAnsiEncoding':
      return buildWinAnsiTable();
    case 'MacRomanEncoding':
      return buildMacRomanTable();
    default:
      return buildWinAnsiTable();
  }
}

// WinAnsi (cp1252) — standard printable ASCII + extended Latin
function buildWinAnsiTable(): Map<number, string> {
  const t = new Map<number, string>();

  // Standard ASCII printable range 0x20–0x7E
  for (let code = 0x20; code <= 0x7e; code++) {
    t.set(code, String.fromCodePoint(code));
  }

  // cp1252 extended block 0x80–0xFF
  // Reference: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP1252.TXT
  const cp1252Extra: ReadonlyArray<readonly [number, number]> = [
    [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e],
    [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6],
    [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
    [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c],
    [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
    [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
    [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
  ];
  for (const [code, cp] of cp1252Extra) {
    t.set(code, String.fromCodePoint(cp));
  }

  // 0xA0–0xFF map directly to Unicode (Latin-1 Supplement)
  for (let code = 0xa0; code <= 0xff; code++) {
    if (!t.has(code)) {
      t.set(code, String.fromCodePoint(code));
    }
  }

  return t;
}

// MacRoman encoding — standard Mac OS Roman code page
function buildMacRomanTable(): Map<number, string> {
  const t = new Map<number, string>();

  // Standard ASCII printable range
  for (let code = 0x20; code <= 0x7e; code++) {
    t.set(code, String.fromCodePoint(code));
  }

  // Mac OS Roman upper half (0x80–0xFF)
  // Reference: https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/ROMAN.TXT
  const macRomanUpper: ReadonlyArray<readonly [number, number]> = [
    [0x80, 0x00c4], [0x81, 0x00c5], [0x82, 0x00c7], [0x83, 0x00c9],
    [0x84, 0x00d1], [0x85, 0x00d6], [0x86, 0x00dc], [0x87, 0x00e1],
    [0x88, 0x00e0], [0x89, 0x00e2], [0x8a, 0x00e4], [0x8b, 0x00e5],
    [0x8c, 0x00e7], [0x8d, 0x00e9], [0x8e, 0x00e8], [0x8f, 0x00ea],
    [0x90, 0x00eb], [0x91, 0x00ed], [0x92, 0x00ec], [0x93, 0x00ee],
    [0x94, 0x00ef], [0x95, 0x00f1], [0x96, 0x00f3], [0x97, 0x00f2],
    [0x98, 0x00f4], [0x99, 0x00f6], [0x9a, 0x00fa], [0x9b, 0x00f9],
    [0x9c, 0x00fb], [0x9d, 0x00fc], [0x9e, 0x2020], [0x9f, 0x00b0],
    [0xa0, 0x00a2], [0xa1, 0x00a3], [0xa2, 0x00a7], [0xa3, 0x2022],
    [0xa4, 0x00b6], [0xa5, 0x00df], [0xa6, 0x00ae], [0xa7, 0x00a9],
    [0xa8, 0x2122], [0xa9, 0x00b4], [0xaa, 0x00a8], [0xab, 0x2260],
    [0xac, 0x00c6], [0xad, 0x00d8], [0xae, 0x221e], [0xaf, 0x00b1],
    [0xb0, 0x2264], [0xb1, 0x2265], [0xb2, 0x00a5], [0xb3, 0x00b5],
    [0xb4, 0x2202], [0xb5, 0x2211], [0xb6, 0x220f], [0xb7, 0x03c0],
    [0xb8, 0x222b], [0xb9, 0x00aa], [0xba, 0x00ba], [0xbb, 0x03a9],
    [0xbc, 0x00e6], [0xbd, 0x00f8], [0xbe, 0x00bf], [0xbf, 0x00a1],
    [0xc0, 0x00ac], [0xc1, 0x221a], [0xc2, 0x0192], [0xc3, 0x2248],
    [0xc4, 0x2206], [0xc5, 0x00ab], [0xc6, 0x00bb], [0xc7, 0x2026],
    [0xc8, 0x00a0], [0xc9, 0x00c0], [0xca, 0x00c3], [0xcb, 0x00d5],
    [0xcc, 0x0152], [0xcd, 0x0153], [0xce, 0x2013], [0xcf, 0x2014],
    [0xd0, 0x201c], [0xd1, 0x201d], [0xd2, 0x2018], [0xd3, 0x2019],
    [0xd4, 0x00f7], [0xd5, 0x25ca], [0xd6, 0x00ff], [0xd7, 0x0178],
    [0xd8, 0x2044], [0xd9, 0x20ac], [0xda, 0x2039], [0xdb, 0x203a],
    [0xdc, 0xfb01], [0xdd, 0xfb02], [0xde, 0x2021], [0xdf, 0x00b7],
    [0xe0, 0x201a], [0xe1, 0x201e], [0xe2, 0x2030], [0xe3, 0x00c2],
    [0xe4, 0x00ca], [0xe5, 0x00c1], [0xe6, 0x00cb], [0xe7, 0x00c8],
    [0xe8, 0x00cd], [0xe9, 0x00ce], [0xea, 0x00cf], [0xeb, 0x00cc],
    [0xec, 0x00d3], [0xed, 0x00d4], [0xee, 0xf8ff], [0xef, 0x00d2],
    [0xf0, 0x00da], [0xf1, 0x00db], [0xf2, 0x00d9], [0xf3, 0x0131],
    [0xf4, 0x02c6], [0xf5, 0x02dc], [0xf6, 0x00af], [0xf7, 0x02d8],
    [0xf8, 0x02d9], [0xf9, 0x02da], [0xfa, 0x00b8], [0xfb, 0x02dd],
    [0xfc, 0x02db], [0xfd, 0x02c7],
  ];
  for (const [code, cp] of macRomanUpper) {
    t.set(code, String.fromCodePoint(cp));
  }

  return t;
}

// ---------------------------------------------------------------------------
// Adobe Glyph List (AGL) — glyph name → Unicode code point
// Reference: https://github.com/adobe-type-tools/agl-aglfn
// ---------------------------------------------------------------------------

const ADOBE_GLYPH_LIST: ReadonlyMap<string, number> = new Map<string, number>([
  // Spacing / punctuation
  ['space',          0x0020], ['exclam',       0x0021], ['quotedbl',     0x0022],
  ['numbersign',     0x0023], ['dollar',        0x0024], ['percent',       0x0025],
  ['ampersand',      0x0026], ['quotesingle',   0x0027], ['parenleft',     0x0028],
  ['parenright',     0x0029], ['asterisk',      0x002a], ['plus',          0x002b],
  ['comma',          0x002c], ['hyphen',        0x002d], ['period',        0x002e],
  ['slash',          0x002f],
  // Digits
  ['zero',   0x0030], ['one',   0x0031], ['two',   0x0032], ['three', 0x0033],
  ['four',   0x0034], ['five',  0x0035], ['six',   0x0036], ['seven', 0x0037],
  ['eight',  0x0038], ['nine',  0x0039],
  // Colon … at-sign
  ['colon',      0x003a], ['semicolon', 0x003b], ['less',     0x003c],
  ['equal',      0x003d], ['greater',   0x003e], ['question', 0x003f],
  ['at',         0x0040],
  // Uppercase A–Z
  ['A', 0x0041], ['B', 0x0042], ['C', 0x0043], ['D', 0x0044], ['E', 0x0045],
  ['F', 0x0046], ['G', 0x0047], ['H', 0x0048], ['I', 0x0049], ['J', 0x004a],
  ['K', 0x004b], ['L', 0x004c], ['M', 0x004d], ['N', 0x004e], ['O', 0x004f],
  ['P', 0x0050], ['Q', 0x0051], ['R', 0x0052], ['S', 0x0053], ['T', 0x0054],
  ['U', 0x0055], ['V', 0x0056], ['W', 0x0057], ['X', 0x0058], ['Y', 0x0059],
  ['Z', 0x005a],
  // Brackets / special
  ['bracketleft',  0x005b], ['backslash',     0x005c], ['bracketright', 0x005d],
  ['asciicircum',  0x005e], ['underscore',    0x005f], ['grave',        0x0060],
  // Lowercase a–z
  ['a', 0x0061], ['b', 0x0062], ['c', 0x0063], ['d', 0x0064], ['e', 0x0065],
  ['f', 0x0066], ['g', 0x0067], ['h', 0x0068], ['i', 0x0069], ['j', 0x006a],
  ['k', 0x006b], ['l', 0x006c], ['m', 0x006d], ['n', 0x006e], ['o', 0x006f],
  ['p', 0x0070], ['q', 0x0071], ['r', 0x0072], ['s', 0x0073], ['t', 0x0074],
  ['u', 0x0075], ['v', 0x0076], ['w', 0x0077], ['x', 0x0078], ['y', 0x0079],
  ['z', 0x007a],
  // Braces / tilde
  ['braceleft', 0x007b], ['bar', 0x007c], ['braceright', 0x007d], ['asciitilde', 0x007e],
  // Common accented / extended Latin
  ['Agrave',    0x00c0], ['Aacute',  0x00c1], ['Acircumflex', 0x00c2],
  ['Atilde',    0x00c3], ['Adieresis',0x00c4], ['Aring',       0x00c5],
  ['AE',        0x00c6], ['Ccedilla', 0x00c7], ['Egrave',      0x00c8],
  ['Eacute',    0x00c9], ['Ecircumflex',0x00ca],['Edieresis',  0x00cb],
  ['Igrave',    0x00cc], ['Iacute',   0x00cd], ['Icircumflex', 0x00ce],
  ['Idieresis', 0x00cf], ['Eth',      0x00d0], ['Ntilde',      0x00d1],
  ['Ograve',    0x00d2], ['Oacute',   0x00d3], ['Ocircumflex', 0x00d4],
  ['Otilde',    0x00d5], ['Odieresis',0x00d6], ['multiply',    0x00d7],
  ['Oslash',    0x00d8], ['Ugrave',   0x00d9], ['Uacute',      0x00da],
  ['Ucircumflex',0x00db],['Udieresis',0x00dc], ['Yacute',      0x00dd],
  ['Thorn',     0x00de], ['germandbls',0x00df],
  ['agrave',    0x00e0], ['aacute',   0x00e1], ['acircumflex', 0x00e2],
  ['atilde',    0x00e3], ['adieresis',0x00e4], ['aring',       0x00e5],
  ['ae',        0x00e6], ['ccedilla', 0x00e7], ['egrave',      0x00e8],
  ['eacute',    0x00e9], ['ecircumflex',0x00ea],['edieresis',  0x00eb],
  ['igrave',    0x00ec], ['iacute',   0x00ed], ['icircumflex', 0x00ee],
  ['idieresis', 0x00ef], ['eth',      0x00f0], ['ntilde',      0x00f1],
  ['ograve',    0x00f2], ['oacute',   0x00f3], ['ocircumflex', 0x00f4],
  ['otilde',    0x00f5], ['odieresis',0x00f6], ['divide',      0x00f7],
  ['oslash',    0x00f8], ['ugrave',   0x00f9], ['uacute',      0x00fa],
  ['ucircumflex',0x00fb],['udieresis',0x00fc], ['yacute',      0x00fd],
  ['thorn',     0x00fe], ['ydieresis',0x00ff],
  // Latin Extended-A (common)
  ['Amacron',  0x0100], ['amacron',  0x0101], ['Abreve',    0x0102], ['abreve',    0x0103],
  ['Cacute',   0x0106], ['cacute',   0x0107], ['Ccaron',    0x010c], ['ccaron',    0x010d],
  ['Dcaron',   0x010e], ['dcaron',   0x010f], ['Emacron',  0x0112], ['emacron',  0x0113],
  ['Ecaron',   0x011a], ['ecaron',   0x011b], ['Gcircumflex',0x011c],['gcircumflex',0x011d],
  ['Lacute',   0x0139], ['lacute',   0x013a], ['Lcaron',    0x013d], ['lcaron',    0x013e],
  ['Nacute',   0x0143], ['nacute',   0x0144], ['Ncaron',    0x0147], ['ncaron',    0x0148],
  ['Omacron',  0x014c], ['omacron',  0x014d], ['Ohungarumlaut',0x0150],['ohungarumlaut',0x0151],
  ['OE',       0x0152], ['oe',       0x0153], ['Racute',    0x0154], ['racute',    0x0155],
  ['Rcaron',   0x0158], ['rcaron',   0x0159], ['Sacute',    0x015a], ['sacute',    0x015b],
  ['Scedilla', 0x015e], ['scedilla', 0x015f], ['Scaron',    0x0160], ['scaron',    0x0161],
  ['Tcaron',   0x0164], ['tcaron',   0x0165], ['Umacron',   0x016a], ['umacron',   0x016b],
  ['Uhungarumlaut',0x0170],['uhungarumlaut',0x0171],
  ['Uring',    0x016e], ['uring',    0x016f],
  ['Ydieresis',0x0178], ['Zacute',   0x0179], ['zacute',    0x017a],
  ['Zcaron',   0x017d], ['zcaron',   0x017e],
  // Commonly used punctuation / symbols in PDF text
  ['endash',     0x2013], ['emdash',    0x2014],
  ['quotedblleft', 0x201c], ['quotedblright', 0x201d],
  ['quoteleft',  0x2018], ['quoteright', 0x2019],
  ['quotesinglbase', 0x201a], ['quotedblbase', 0x201e],
  ['ellipsis',   0x2026], ['dagger',    0x2020], ['daggerdbl', 0x2021],
  ['bullet',     0x2022], ['perthousand', 0x2030],
  ['guilsinglleft', 0x2039], ['guilsinglright', 0x203a],
  ['guillemotleft', 0x00ab], ['guillemotright', 0x00bb],
  ['Euro',       0x20ac], ['trademark', 0x2122],
  ['fi',         0xfb01], ['fl',        0xfb02],
  ['fraction',   0x2044], ['dotaccent', 0x02d9],
  ['hungarumlaut',0x02dd], ['ogonek',   0x02db], ['caron',    0x02c7],
  ['dotlessi',   0x0131], ['lslash',   0x0142], ['Lslash',   0x0141],
  ['florin',     0x0192],
]);

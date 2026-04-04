/**
 * L2 Content Layer — ContentStreamProcessor
 *
 * Executes a parsed sequence of ContentOperator values to:
 *   1. Maintain the PDF graphics state (CTM, colour, text state, state stack).
 *   2. Extract raw character positions for every text-painting operator.
 *
 * The processor does NOT decode font encoding or perform Unicode mapping —
 * that responsibility belongs to the L3 font engine.  Here each character is
 * identified only by its raw byte code (charCode) and positioned in page
 * coordinates using the text rendering matrix.
 *
 * PDF 32000-1:2008 §8 (Graphics), §9 (Text)
 */

import type { ContentOperator, GraphicsState } from './operators';
import { createDefaultGraphicsState, cloneGraphicsState } from './operators';
import { PDFObjectType } from '../objects/types';
import type { PDFObject } from '../objects/types';

// ---------------------------------------------------------------------------
// FontInfo / FontInfoProvider
// ---------------------------------------------------------------------------

/**
 * Callback that tells the processor how to handle character codes
 * for a given font. Returns bytesPerChar (1 for simple fonts, 2 for CID)
 * and the glyph width function.
 */
export interface FontInfo {
  /** 1 for Type1/TrueType simple fonts, 2 for CID (Type0 Identity-H). */
  bytesPerChar: number;
  /** Return the glyph width in 1/1000 glyph-space units for the given char code. */
  getWidth(charCode: number): number;
}

/** Resolve font metadata by resource name (e.g. "F1"). */
export type FontInfoProvider = (fontName: string) => FontInfo | undefined;

// ---------------------------------------------------------------------------
// TextCharRaw
// ---------------------------------------------------------------------------

/**
 * One raw character extracted from a text-painting operator.
 *
 * Positions are in page (user) coordinates, derived from the text rendering
 * matrix at the moment the character is painted.
 */
export interface TextCharRaw {
  /** Raw byte value from the PDF string (font-encoding-specific). */
  charCode: number;
  /** Horizontal position of the glyph origin in page coordinates. */
  x: number;
  /** Vertical position of the glyph origin in page coordinates. */
  y: number;
  /** Advance width in page coordinates (used to position the next glyph). */
  width: number;
  /** Effective font size in page coordinates. */
  fontSize: number;
  /** Font resource name (without leading slash). */
  fontName: string;
  /** Fill colour at the time of painting: [R, G, B] in [0, 1]. */
  fillColor: [number, number, number];
  /** The text rendering matrix [a b c d e f] used for this character. */
  matrix: number[];
  /** Index of the parent operator in the operators array. */
  operatorIndex: number;
}

// ---------------------------------------------------------------------------
// Default glyph advance width
// ---------------------------------------------------------------------------

/**
 * Placeholder advance width used until real font metrics are available from
 * the L3 font engine (units: thousandths of a text space unit, matching the
 * PDF convention for Type 1 / OpenType fonts).
 *
 * 600 / 1000 = 0.6 of the font size, which approximates a medium-width glyph
 * in a proportionally-spaced Latin font.
 */
const DEFAULT_GLYPH_WIDTH_UNITS = 600;

// ASCII space character code
const SPACE_CHAR_CODE = 0x20;

// ---------------------------------------------------------------------------
// ContentStreamProcessor
// ---------------------------------------------------------------------------

export class ContentStreamProcessor {
  private readonly stateStack: GraphicsState[] = [];
  private state: GraphicsState;
  private readonly operators: ContentOperator[];
  private readonly fontInfoProvider: FontInfoProvider | undefined;

  constructor(operators: ContentOperator[], fontInfoProvider?: FontInfoProvider) {
    this.operators = operators;
    this.state = createDefaultGraphicsState();
    this.fontInfoProvider = fontInfoProvider;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Process all operators, updating graphics state as they are encountered,
   * and collecting TextCharRaw entries for every text-painting operator.
   *
   * Returns both the extracted characters and the (possibly annotated)
   * operator array.  The operator array is the same reference passed to the
   * constructor — it is returned for convenience so callers can chain.
   */
  process(): { chars: TextCharRaw[]; operators: ContentOperator[] } {
    const chars: TextCharRaw[] = [];

    for (let i = 0; i < this.operators.length; i++) {
      this.processOperator(this.operators[i], i, chars);
    }

    return { chars, operators: this.operators };
  }

  // -------------------------------------------------------------------------
  // Dispatcher
  // -------------------------------------------------------------------------

  private processOperator(
    op: ContentOperator,
    index: number,
    chars: TextCharRaw[],
  ): void {
    const ops = op.operands;

    switch (op.name) {
      // --- Text block delimiters ---
      case 'BT':
        this.processBT();
        break;
      case 'ET':
        this.processET();
        break;

      // --- Text state ---
      case 'Tf': {
        const fontName = getNameValue(ops[0]) ?? '';
        const fontSize = getNumberValue(ops[1]) ?? 0;
        this.processTf(fontName, fontSize);
        break;
      }
      case 'Tc':
        this.processTc(getNumberValue(ops[0]) ?? 0);
        break;
      case 'Tw':
        this.processTw(getNumberValue(ops[0]) ?? 0);
        break;
      case 'TL':
        this.processTL(getNumberValue(ops[0]) ?? 0);
        break;
      case 'Ts':
        this.processTs(getNumberValue(ops[0]) ?? 0);
        break;
      case 'Tr':
        this.processTr(getNumberValue(ops[0]) ?? 0);
        break;
      case 'Tz':
        // Horizontal scaling: operand is a percentage (100 = normal)
        this.state.horizontalScaling = (getNumberValue(ops[0]) ?? 100) / 100;
        break;

      // --- Text positioning ---
      case 'Td': {
        const tx = getNumberValue(ops[0]) ?? 0;
        const ty = getNumberValue(ops[1]) ?? 0;
        this.processTd(tx, ty);
        break;
      }
      case 'TD': {
        const tx = getNumberValue(ops[0]) ?? 0;
        const ty = getNumberValue(ops[1]) ?? 0;
        this.processTD(tx, ty);
        break;
      }
      case 'Tm': {
        const a = getNumberValue(ops[0]) ?? 1;
        const b = getNumberValue(ops[1]) ?? 0;
        const c = getNumberValue(ops[2]) ?? 0;
        const d = getNumberValue(ops[3]) ?? 1;
        const e = getNumberValue(ops[4]) ?? 0;
        const f = getNumberValue(ops[5]) ?? 0;
        this.processTm(a, b, c, d, e, f);
        break;
      }
      case 'T*':
        this.processTStar();
        break;

      // --- Text painting ---
      case 'Tj':
        this.processTj(ops[0], index, chars);
        break;
      case 'TJ':
        if (ops[0] !== undefined) {
          this.processTJ(ops[0], index, chars);
        }
        break;
      case "'":
        // Move to the next line, then show string (= T* followed by Tj)
        this.processTStar();
        this.processTj(ops[0], index, chars);
        break;
      case '"': {
        // Set word spacing, set char spacing, move to next line, show string
        const wordSpace = getNumberValue(ops[0]) ?? 0;
        const charSpace = getNumberValue(ops[1]) ?? 0;
        this.processTw(wordSpace);
        this.processTc(charSpace);
        this.processTStar();
        this.processTj(ops[2], index, chars);
        break;
      }

      // --- Graphics state ---
      case 'q':
        this.processQ();
        break;
      case 'Q':
        this.processQRestore();
        break;
      case 'cm': {
        const a = getNumberValue(ops[0]) ?? 1;
        const b = getNumberValue(ops[1]) ?? 0;
        const c = getNumberValue(ops[2]) ?? 0;
        const d = getNumberValue(ops[3]) ?? 1;
        const e = getNumberValue(ops[4]) ?? 0;
        const f = getNumberValue(ops[5]) ?? 0;
        this.processCm(a, b, c, d, e, f);
        break;
      }
      case 'w':
        this.state.lineWidth = getNumberValue(ops[0]) ?? 1;
        break;

      // --- Colour operators (device colour spaces) ---
      case 'rg': {
        const r = getNumberValue(ops[0]) ?? 0;
        const g = getNumberValue(ops[1]) ?? 0;
        const b = getNumberValue(ops[2]) ?? 0;
        this.processRg(r, g, b);
        break;
      }
      case 'RG': {
        const r = getNumberValue(ops[0]) ?? 0;
        const g = getNumberValue(ops[1]) ?? 0;
        const b = getNumberValue(ops[2]) ?? 0;
        this.state.strokeColor = [r, g, b];
        this.state.strokeColorSpace = 'DeviceRGB';
        break;
      }
      case 'g':
        this.processG(getNumberValue(ops[0]) ?? 0);
        break;
      case 'G': {
        const gray = getNumberValue(ops[0]) ?? 0;
        this.state.strokeColor = [gray, gray, gray];
        this.state.strokeColorSpace = 'DeviceGray';
        break;
      }
      case 'k': {
        const c = getNumberValue(ops[0]) ?? 0;
        const m = getNumberValue(ops[1]) ?? 0;
        const y = getNumberValue(ops[2]) ?? 0;
        const k = getNumberValue(ops[3]) ?? 0;
        this.processK(c, m, y, k);
        break;
      }
      case 'K': {
        const c = getNumberValue(ops[0]) ?? 0;
        const m = getNumberValue(ops[1]) ?? 0;
        const y = getNumberValue(ops[2]) ?? 0;
        const k = getNumberValue(ops[3]) ?? 0;
        const [r, g, b] = cmykToRgb(c, m, y, k);
        this.state.strokeColor = [r, g, b];
        this.state.strokeColorSpace = 'DeviceCMYK';
        break;
      }
      case 'CS':
        this.state.strokeColorSpace = getNameValue(ops[0]) ?? 'DeviceGray';
        break;
      case 'cs':
        this.state.fillColorSpace = getNameValue(ops[0]) ?? 'DeviceGray';
        break;

      // All other operators are currently pass-through (no state change needed)
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Text block
  // -------------------------------------------------------------------------

  private processBT(): void {
    // PDF §9.4.1 — BT begins a text object, resetting both text matrices
    this.state.textMatrix = [1, 0, 0, 1, 0, 0];
    this.state.lineMatrix = [1, 0, 0, 1, 0, 0];
  }

  private processET(): void {
    // PDF §9.4.1 — ET ends a text object; no state change needed here
    // (text matrices are reset on the next BT)
  }

  // -------------------------------------------------------------------------
  // Text state setters
  // -------------------------------------------------------------------------

  private processTf(fontName: string, fontSize: number): void {
    this.state.fontName = fontName;
    this.state.fontSize = fontSize;
  }

  private processTc(charSpace: number): void {
    this.state.charSpacing = charSpace;
  }

  private processTw(wordSpace: number): void {
    this.state.wordSpacing = wordSpace;
  }

  private processTL(leading: number): void {
    this.state.leading = leading;
  }

  private processTs(rise: number): void {
    this.state.textRise = rise;
  }

  private processTr(mode: number): void {
    this.state.renderMode = mode;
  }

  // -------------------------------------------------------------------------
  // Text positioning
  // -------------------------------------------------------------------------

  private processTd(tx: number, ty: number): void {
    // Td: move text position (add [tx ty] to line matrix translation)
    const lm = this.state.lineMatrix;
    // New line matrix = [1 0 0 1 tx ty] × lm
    this.state.lineMatrix = [
      lm[0], lm[1], lm[2], lm[3],
      tx * lm[0] + ty * lm[2] + lm[4],
      tx * lm[1] + ty * lm[3] + lm[5],
    ];
    this.state.textMatrix = this.state.lineMatrix.slice();
  }

  private processTD(tx: number, ty: number): void {
    // TD = set leading to −ty, then Td(tx, ty)  (PDF §9.4.2)
    this.processTL(-ty);
    this.processTd(tx, ty);
  }

  private processTm(
    a: number, b: number, c: number, d: number, e: number, f: number,
  ): void {
    // Tm: set both text matrix and line matrix
    this.state.textMatrix = [a, b, c, d, e, f];
    this.state.lineMatrix = [a, b, c, d, e, f];
  }

  private processTStar(): void {
    // T* = Td(0, -leading)
    this.processTd(0, -this.state.leading);
  }

  // -------------------------------------------------------------------------
  // Text painting
  // -------------------------------------------------------------------------

  private processTj(
    strObj: PDFObject | undefined,
    index: number,
    chars: TextCharRaw[],
  ): void {
    if (strObj === undefined) return;

    let bytes: Uint8Array | null = null;

    if (
      strObj.type === PDFObjectType.String ||
      strObj.type === PDFObjectType.HexString
    ) {
      if (strObj.type === PDFObjectType.String) {
        bytes = strObj.raw;
      } else {
        // PDFHexString: convert value string (decoded chars) to bytes
        const val = strObj.value;
        bytes = new Uint8Array(val.length);
        for (let i = 0; i < val.length; i++) {
          bytes[i] = val.charCodeAt(i) & 0xff;
        }
      }
    }

    if (bytes === null || bytes.length === 0) return;

    const fontInfo = this.fontInfoProvider?.(this.state.fontName);
    const bytesPerChar = fontInfo?.bytesPerChar ?? 1;

    let i = 0;
    while (i < bytes.length) {
      let charCode: number;
      if (bytesPerChar === 2 && i + 1 < bytes.length) {
        charCode = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
        i += 2;
      } else {
        charCode = bytes[i] ?? 0;
        i += 1;
      }

      const trm = this.getTextRenderingMatrix();
      chars.push({
        charCode,
        x: trm[4],
        y: trm[5],
        width: this.advanceForChar(charCode),
        fontSize: this.state.fontSize,
        fontName: this.state.fontName,
        fillColor: [
          this.state.fillColor[0],
          this.state.fillColor[1],
          this.state.fillColor[2],
        ],
        matrix: trm,
        operatorIndex: index,
      });
      this.advanceTextMatrix(charCode);
    }
  }

  private processTJ(
    arrObj: PDFObject | undefined,
    index: number,
    chars: TextCharRaw[],
  ): void {
    if (arrObj === undefined || arrObj.type !== PDFObjectType.Array) return;

    for (const item of arrObj.items) {
      if (item.type === PDFObjectType.Number) {
        // Kerning adjustment: negative value moves forward in writing direction
        // Adjust text matrix x by -(kerning / 1000) * fontSize
        const kerning = item.value;
        const dx = -(kerning / 1000) * this.state.fontSize * this.state.horizontalScaling;
        this.shiftTextMatrixX(dx);
      } else {
        // String or HexString — paint characters
        this.processTj(item, index, chars);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Graphics state
  // -------------------------------------------------------------------------

  private processQ(): void {
    // Save: push a deep copy of the current state
    this.stateStack.push(cloneGraphicsState(this.state));
  }

  private processQRestore(): void {
    // Restore: pop the top state
    const restored = this.stateStack.pop();
    if (restored !== undefined) {
      this.state = restored;
    }
    // If the stack is empty we leave the current state unchanged (defensive)
  }

  private processCm(
    a: number, b: number, c: number, d: number, e: number, f: number,
  ): void {
    // Concatenate [a b c d e f] onto the current CTM
    this.state.ctm = this.multiplyMatrix([a, b, c, d, e, f], this.state.ctm);
  }

  // -------------------------------------------------------------------------
  // Colour operators
  // -------------------------------------------------------------------------

  private processRg(r: number, g: number, b: number): void {
    this.state.fillColor = [r, g, b];
    this.state.fillColorSpace = 'DeviceRGB';
  }

  private processG(gray: number): void {
    this.state.fillColor = [gray, gray, gray];
    this.state.fillColorSpace = 'DeviceGray';
  }

  private processK(c: number, m: number, y: number, k: number): void {
    const [r, g, b] = cmykToRgb(c, m, y, k);
    this.state.fillColor = [r, g, b];
    this.state.fillColorSpace = 'DeviceCMYK';
  }

  // -------------------------------------------------------------------------
  // Matrix helpers
  // -------------------------------------------------------------------------

  /**
   * Multiply two 6-element PDF matrices.
   *
   * PDF uses column vectors and the convention:
   *   [a b c d e f] represents the 3×3 matrix:
   *     | a  b  0 |
   *     | c  d  0 |
   *     | e  f  1 |
   *
   * Multiplication: result = M × N  (M applied first, then N)
   */
  private multiplyMatrix(m: number[], n: number[]): number[] {
    return [
      m[0] * n[0] + m[1] * n[2],
      m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2],
      m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4],
      m[4] * n[1] + m[5] * n[3] + n[5],
    ];
  }

  /**
   * Compute the Text Rendering Matrix.
   *
   * Per PDF §9.4.4:
   *   trm = [fontSize * hz  0  0  fontSize  0  textRise] × textMatrix × ctm
   *
   * where hz = horizontal scaling (Tz / 100).
   *
   * We expand the matrix multiplication so the result carries the combined
   * translation (x, y) in trm[4] and trm[5] — these are the glyph origin
   * in page (user) coordinates.
   */
  private getTextRenderingMatrix(): number[] {
    const fs = this.state.fontSize;
    const hz = this.state.horizontalScaling;
    const rise = this.state.textRise;

    // Scale matrix (text space → user space)
    const scaleMat: number[] = [fs * hz, 0, 0, fs, 0, rise];

    // Combine: scaleMat × textMatrix × ctm
    const tm = this.state.textMatrix;
    const ctm = this.state.ctm;

    // scaleMat × textMatrix
    const stm = this.multiplyMatrix(scaleMat, tm);
    // result × ctm
    return this.multiplyMatrix(stm, ctm);
  }

  // -------------------------------------------------------------------------
  // Text advance helpers
  // -------------------------------------------------------------------------

  /**
   * Compute the advance width in page coordinates for one character code.
   *
   * Until real font metrics are available from the L3 font engine the advance
   * uses a fixed default of 600/1000 of the font size.
   *
   * Formula (PDF §9.4.4):
   *   advance = (glyphWidth / 1000 * fontSize + charSpacing
   *              + wordSpacing_if_space) * horizontalScaling
   */
  private advanceForChar(charCode: number): number {
    const fontInfo = this.fontInfoProvider?.(this.state.fontName);
    const glyphWidthUnits = fontInfo?.getWidth(charCode) ?? DEFAULT_GLYPH_WIDTH_UNITS;
    const glyphWidthFraction = glyphWidthUnits / 1000;
    const fs = this.state.fontSize;
    const cs = this.state.charSpacing;
    const ws = charCode === SPACE_CHAR_CODE ? this.state.wordSpacing : 0;
    const hz = this.state.horizontalScaling;

    return (glyphWidthFraction * fs + cs + ws) * hz;
  }

  /**
   * Advance the text matrix horizontally by the advance width of `charCode`.
   *
   * Only the translation component of textMatrix is updated; the rotational
   * components (a, b, c, d) are unchanged.
   */
  private advanceTextMatrix(charCode: number): void {
    const advance = this.advanceForChar(charCode);
    this.shiftTextMatrixX(advance);
  }

  /**
   * Shift the text matrix translation in the writing direction by `dx` user
   * space units.  The writing direction is the x-axis of the text matrix.
   */
  private shiftTextMatrixX(dx: number): void {
    const tm = this.state.textMatrix;
    // tx' = tx + dx * a; ty' = ty + dx * b  (where a=tm[0], b=tm[1])
    this.state.textMatrix = [
      tm[0], tm[1], tm[2], tm[3],
      tm[4] + dx * tm[0],
      tm[5] + dx * tm[1],
    ];
  }
}

// ---------------------------------------------------------------------------
// CMYK → RGB conversion helper
// ---------------------------------------------------------------------------

function cmykToRgb(
  c: number,
  m: number,
  y: number,
  k: number,
): [number, number, number] {
  return [
    (1 - c) * (1 - k),
    (1 - m) * (1 - k),
    (1 - y) * (1 - k),
  ];
}

// ---------------------------------------------------------------------------
// Operand extraction helpers
// ---------------------------------------------------------------------------

function getNumberValue(obj: PDFObject | undefined): number | undefined {
  if (obj === undefined) return undefined;
  if (obj.type === PDFObjectType.Number) return obj.value;
  return undefined;
}

function getNameValue(obj: PDFObject | undefined): string | undefined {
  if (obj === undefined) return undefined;
  if (obj.type === PDFObjectType.Name) return obj.value;
  return undefined;
}

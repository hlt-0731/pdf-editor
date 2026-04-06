import './style.css';

// ---------------------------------------------------------------------------
// PDF.js — pixel-perfect rendering
// ---------------------------------------------------------------------------

import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// ---------------------------------------------------------------------------
// Our custom parser — text extraction + editing pipeline
// ---------------------------------------------------------------------------

import { ByteStreamReader } from './core/binary/reader';
import { XRefParser } from './core/binary/xref';
import { ObjectResolver } from './core/objects/resolver';
import { ContentStreamTokenizer } from './core/content/tokenizer';
import { ContentStreamProcessor, type FontInfo, type FontInfoProvider } from './core/content/stream';
import { FontManager, type ResolvedFont } from './core/font/manager';
import { isNumber } from './core/objects/types';
import type { ContentOperator } from './core/content/operators';
import { TextGrouper } from './model/grouping';
import { resetTextBlockCounter, mergeTextBlocks, createEmptyTextBlock } from './model/text-block';
import type { TextBlock } from './model/text-block';
import { hitTest } from './editor/canvas/hit-test';
import { SelectionManager } from './editor/interaction/selector';
import { InlineEditor } from './editor/interaction/inline-edit';
import { rebuildTextOperators, serializeOperators, generateNewBlockOperators } from './editor/pipeline/save';
import { buildIncrementalUpdate, type ModifiedObject } from './editor/pipeline/incremental';

import { buildEncryptDictionary } from './core/crypto/encrypt';

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------

interface AppState {
  /** Current working PDF bytes (updated after each edit). */
  buffer: Uint8Array | null;
  /** PDF.js document for rendering. */
  pdfDoc: PDFDocumentProxy | null;
  /** Our custom resolver for text extraction. */
  resolver: ObjectResolver | null;
  /** Page dictionaries from our parser. */
  pages: any[];
  currentPageIndex: number;
  fonts: Map<string, ResolvedFont>;
  zoom: number;
  /** True when there are unsaved edits (for the Save button). */
  modified: boolean;
  textBlocks: TextBlock[];
  operators: ContentOperator[];
  pageWidth: number;
  pageHeight: number;
  /** Render generation counter to discard stale async renders. */
  renderGeneration: number;
  /** Whether to show editable block overlays. */
  showBlocks: boolean;
  /** Whether "Add Text" mode is active. */
  addTextMode: boolean;
}

const state: AppState = {
  buffer: null,
  pdfDoc: null,
  resolver: null,
  pages: [],
  currentPageIndex: 0,
  fonts: new Map(),
  zoom: 1.5,
  modified: false,
  textBlocks: [],
  operators: [],
  pageWidth: 0,
  pageHeight: 0,
  renderGeneration: 0,
  showBlocks: false,
  addTextMode: false,
};

const zoomLevels = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];

// ---------------------------------------------------------------------------
// Undo / Redo History
// ---------------------------------------------------------------------------

/** Maximum number of undo snapshots to keep (to limit memory usage). */
const MAX_HISTORY = 30;

/** A snapshot of the PDF buffer at a point in time. */
interface HistoryEntry {
  buffer: Uint8Array;
}

const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];

// ---------------------------------------------------------------------------
// UI Element References
// ---------------------------------------------------------------------------

const dropZone = document.getElementById('drop-zone')!;
const canvasContainer = document.getElementById('canvas-container')!;
const canvas = document.getElementById('pdf-canvas') as HTMLCanvasElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnInfo = document.getElementById('btn-info') as HTMLButtonElement;
const metadataModal = document.getElementById('metadata-modal') as HTMLElement;
const metadataContent = document.getElementById('metadata-content') as HTMLElement;
const btnZoomOut = document.getElementById('btn-zoom-out') as HTMLButtonElement;
const btnZoomIn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
const btnPrevPage = document.getElementById('btn-prev-page') as HTMLButtonElement;
const btnNextPage = document.getElementById('btn-next-page') as HTMLButtonElement;
const zoomLevel = document.getElementById('zoom-level')!;
const pageInfo = document.getElementById('page-info')!;
const statusMode = document.getElementById('status-mode')!;
const statusInfo = document.getElementById('status-info')!;
const interactionLayer = document.getElementById('interaction-layer')!;
const btnToggleBlocks = document.getElementById('btn-toggle-blocks') as HTMLButtonElement;
const btnMerge = document.getElementById('btn-merge') as HTMLButtonElement;
const btnAddText = document.getElementById('btn-add-text') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Editor Instances
// ---------------------------------------------------------------------------

const selectionManager = new SelectionManager();
const inlineEditor = new InlineEditor(canvasContainer, canvas);

// Make interaction layer focusable so clicking it causes the hidden input to
// blur (triggering edit confirmation).  tabIndex=-1 keeps it out of tab order.
interactionLayer.tabIndex = -1;
interactionLayer.style.outline = 'none';

// ---------------------------------------------------------------------------
// PDF Loading
// ---------------------------------------------------------------------------

/**
 * Load a PDF from an ArrayBuffer.  Sets up both PDF.js (rendering) and our
 * custom parser (text extraction + editing).
 */
async function loadPDF(arrayBuffer: ArrayBuffer): Promise<void> {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    state.buffer = bytes;

    // --- PDF.js document ---
    if (state.pdfDoc) {
      state.pdfDoc.destroy();
    }
    state.pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

    // --- Our custom parser ---
    const reader = new ByteStreamReader(bytes);
    const xref = new XRefParser().parse(reader);
    state.resolver = new ObjectResolver(reader, xref);
    state.pages = state.resolver.getPages();
    state.currentPageIndex = 0;
    state.modified = false;

    if (state.pages.length === 0) {
      alert('No pages found in PDF');
      return;
    }

    dropZone.hidden = true;
    canvasContainer.hidden = false;

    await parseCurrentPage();
    await renderCurrentPage();
    updatePageInfo();

    btnSave.disabled = false;
    btnInfo.disabled = false;
    btnToggleBlocks.disabled = false;
    btnAddText.disabled = false;
    btnPrevPage.disabled = state.currentPageIndex === 0;
    btnNextPage.disabled = state.currentPageIndex === state.pages.length - 1;
  } catch (error) {
    console.error('Error loading PDF:', error);
    alert(`Error loading PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    dropZone.hidden = false;
    canvasContainer.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Text Extraction (our custom parser)
// ---------------------------------------------------------------------------

function createFontInfoProvider(fonts: Map<string, ResolvedFont>): FontInfoProvider {
  return (fontName: string): FontInfo | undefined => {
    const font = fonts.get(fontName);
    if (!font) return undefined;
    return {
      bytesPerChar: font.isCID ? 2 : 1,
      getWidth: (charCode: number) => font.metrics.getGlyphWidth(charCode),
    };
  };
}

/**
 * Parse the current page's content stream into operators and TextBlocks
 * using our custom parser.  This provides the data needed for hit-testing,
 * selection, inline editing, and the save pipeline.
 *
 * Uses the PDF.js viewport dimensions (not the raw MediaBox) for coordinate
 * conversion so that TextBlock bounding boxes align with the PDF.js-rendered
 * canvas.  The content stream's initial CTM may scale coordinates to a
 * different range than the MediaBox declares.
 */
async function parseCurrentPage(): Promise<void> {
  const page = state.pages[state.currentPageIndex];
  if (!page || !state.resolver) return;

  // Get effective page dimensions from PDF.js viewport (at scale 1.0).
  // This accounts for MediaBox, CropBox, and Rotate — the same transform
  // that PDF.js uses when rendering to the canvas.
  if (state.pdfDoc) {
    const pdfPage = await state.pdfDoc.getPage(state.currentPageIndex + 1);
    const vp = pdfPage.getViewport({ scale: 1.0 });
    state.pageWidth = vp.width;
    state.pageHeight = vp.height;
  } else {
    // Fallback to MediaBox
    const mediaBoxObj = page.get('MediaBox');
    if (mediaBoxObj && mediaBoxObj.type === 'array') {
      const mediaBox = mediaBoxObj.items;
      const x0 = isNumber(mediaBox[0]) ? mediaBox[0].value : 0;
      const y0 = isNumber(mediaBox[1]) ? mediaBox[1].value : 0;
      const x1 = isNumber(mediaBox[2]) ? mediaBox[2].value : 612;
      const y1 = isNumber(mediaBox[3]) ? mediaBox[3].value : 792;
      state.pageWidth = x1 - x0;
      state.pageHeight = y1 - y0;
    }
  }

  // Resolve fonts
  const fontManager = new FontManager(state.resolver);
  let fonts: Map<string, ResolvedFont> = new Map();
  try {
    const resources = state.resolver.getPageResources(page);
    fonts = fontManager.resolvePageFonts(resources);
  } catch (e) {
    console.warn('Could not resolve page fonts:', e);
  }
  state.fonts = fonts;

  // Tokenize & process content stream
  const fontInfoProvider = createFontInfoProvider(fonts);
  const contentStream = state.resolver.getPageContentStream(page);
  const tokenizer = new ContentStreamTokenizer(contentStream);
  const operators = tokenizer.tokenize();
  const processor = new ContentStreamProcessor(operators, fontInfoProvider);
  const { chars } = processor.process();

  state.operators = operators;

  // Group into TextBlocks
  resetTextBlockCounter();
  const charCodeToUnicode = (fontName: string, charCode: number): string => {
    const font = fonts.get(fontName);
    if (font) return font.charCodeToUnicode(charCode);
    return String.fromCharCode(charCode);
  };
  const grouper = new TextGrouper(undefined, charCodeToUnicode);
  state.textBlocks = grouper.group(chars, state.pageHeight, state.zoom);
}

// ---------------------------------------------------------------------------
// Rendering (PDF.js)
// ---------------------------------------------------------------------------

/**
 * Render the current page using PDF.js for pixel-perfect display,
 * then draw editor overlays (selection highlight) on top.
 */
/** Track the current PDF.js render task so we can cancel it before starting
 *  a new one — PDF.js forbids concurrent render() calls on the same canvas. */
let currentRenderTask: ReturnType<PDFPageProxy['render']> | null = null;

async function renderCurrentPage(): Promise<void> {
  if (!state.pdfDoc) return;

  const gen = ++state.renderGeneration;

  // Cancel any in-flight render to avoid "cannot use same canvas" errors.
  if (currentRenderTask) {
    try { currentRenderTask.cancel(); } catch { /* already done */ }
    currentRenderTask = null;
  }

  const pdfPage: PDFPageProxy = await state.pdfDoc.getPage(state.currentPageIndex + 1);
  if (gen !== state.renderGeneration) return; // stale

  const viewport = pdfPage.getViewport({ scale: state.zoom });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const renderTask = pdfPage.render({ canvasContext: ctx, viewport });
  currentRenderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (e: any) {
    if (e?.name === 'RenderingCancelledException') return; // expected
    throw e;
  }
  currentRenderTask = null;
  if (gen !== state.renderGeneration) return; // stale

  // Draw editable block overlays (when toggled on)
  if (state.showBlocks) {
    drawBlockOverlays(ctx);
  }

  // Draw selection highlight on top of the rendered page
  const sel = selectionManager.getSelection();
  if (sel.type === 'text') {
    drawSelectionHighlight(sel.block);
  } else if (sel.type === 'multi') {
    for (const block of sel.blocks) {
      drawMultiSelectionHighlight(block);
    }
  }
}

function drawSelectionHighlight(block: TextBlock): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bb = block.boundingBox;
  const padding = 3;

  ctx.save();
  // Light background fill
  ctx.fillStyle = 'rgba(26, 115, 232, 0.08)';
  ctx.fillRect(
    bb.x - padding, bb.y - padding,
    bb.width + padding * 2, bb.height + padding * 2,
  );
  // Border
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(
    bb.x - padding, bb.y - padding,
    bb.width + padding * 2, bb.height + padding * 2,
  );
  ctx.restore();
}

function drawMultiSelectionHighlight(block: TextBlock): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bb = block.boundingBox;
  const padding = 2;

  ctx.save();
  // Filled highlight to make multi-selection visually distinct
  ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
  ctx.fillRect(
    bb.x - padding, bb.y - padding,
    bb.width + padding * 2, bb.height + padding * 2,
  );
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(
    bb.x - padding, bb.y - padding,
    bb.width + padding * 2, bb.height + padding * 2,
  );
  ctx.restore();
}

/**
 * Draw translucent overlays on all editable text blocks so the user can
 * see how the page is split into individually editable units.
 *
 * Each block gets a coloured background + border.  A rotating palette
 * ensures adjacent blocks are visually distinct.
 */
function drawBlockOverlays(ctx: CanvasRenderingContext2D): void {
  const palette = [
    { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.45)' },   // blue
    { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.45)' },   // amber
  ];

  const pad = 2;

  ctx.save();
  for (let i = 0; i < state.textBlocks.length; i++) {
    const block = state.textBlocks[i];
    if (!block.editable) continue;

    const bb = block.boundingBox;
    const color = palette[i % palette.length];

    // Filled background
    ctx.fillStyle = color.bg;
    ctx.fillRect(
      bb.x - pad, bb.y - pad,
      bb.width + pad * 2, bb.height + pad * 2,
    );

    // Border
    ctx.strokeStyle = color.border;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(
      bb.x - pad, bb.y - pad,
      bb.width + pad * 2, bb.height + pad * 2,
    );
  }
  ctx.restore();
}

function updatePageInfo(): void {
  pageInfo.textContent = `${state.currentPageIndex + 1} / ${state.pages.length}`;
}

// ---------------------------------------------------------------------------
// Edit → Rebuild → Re-render cycle
// ---------------------------------------------------------------------------

/**
 * Apply a text edit and immediately rebuild the PDF so the canvas shows
 * the updated content via PDF.js.  This keeps state.buffer always in sync
 * with the visual display.
 */
async function applyEditAndRefresh(block: TextBlock, newText: string): Promise<void> {
  // Save current buffer to undo stack before making changes.
  if (state.buffer) {
    pushUndo(state.buffer);
  }

  block.text = newText;
  block.modified = true;
  state.modified = true;
  btnSave.disabled = false;

  // Build modified PDF bytes via incremental update
  const newPdfBytes = buildModifiedPdfBytes();
  if (!newPdfBytes) {
    // Fallback: just re-render (text won't show visually but is stored)
    await renderCurrentPage();
    return;
  }

  // Replace the working buffer with the modified PDF
  state.buffer = newPdfBytes;

  // Re-create PDF.js document from the new bytes
  if (state.pdfDoc) {
    state.pdfDoc.destroy();
  }
  state.pdfDoc = await pdfjsLib.getDocument({ data: newPdfBytes.slice() }).promise;

  // Re-parse our structures from the new buffer
  const reader = new ByteStreamReader(newPdfBytes);
  const xref = new XRefParser().parse(reader);
  state.resolver = new ObjectResolver(reader, xref);
  state.pages = state.resolver.getPages();

  // Re-parse text blocks and render
  await parseCurrentPage();
  await renderCurrentPage();
}

/**
 * Build the modified PDF bytes from current state (operators + modified blocks).
 * Returns null if no modifications or build fails.
 */
function buildModifiedPdfBytes(): Uint8Array | null {
  if (!state.buffer || !state.resolver) return null;

  const modifiedBlocks = state.textBlocks.filter(b => b.modified && !b.isNew);
  const newBlocks = state.textBlocks.filter(b => b.modified && b.isNew);
  if (modifiedBlocks.length === 0 && newBlocks.length === 0) return null;

  const rebuiltOperators = rebuildTextOperators(state.operators, modifiedBlocks, state.fonts);

  // Append new block operators (BT/Tf/Tm/Tj/ET) at the end of the stream.
  for (const block of newBlocks) {
    const newOps = generateNewBlockOperators(block, state.pageHeight, state.zoom, state.fonts);
    rebuiltOperators.push(...newOps);
  }

  const newStreamData = serializeOperators(rebuiltOperators);

  const page = state.pages[state.currentPageIndex];
  const contentsObjNum = getContentsObjNum(page);

  const streamDict = `<< /Length ${newStreamData.length} >>`;
  const enc = new TextEncoder();
  const dictBytes = enc.encode(`${streamDict}\nstream\n`);
  const endStreamBytes = enc.encode('\nendstream');
  const objData = concatArrays(dictBytes, newStreamData, endStreamBytes);

  const modifiedObjects: ModifiedObject[] = [{
    objNum: contentsObjNum,
    genNum: 0,
    data: objData,
  }];

  try {
    const reader = new ByteStreamReader(state.buffer);
    const xref = new XRefParser().parse(reader);
    return buildIncrementalUpdate(state.buffer, modifiedObjects, xref);
  } catch (error) {
    console.error('Error building modified PDF:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Update the status bar to reflect the current mode and context. */
function updateStatusBar(): void {
  if (inlineEditor.isEditing()) {
    statusMode.textContent = '編集中';
    statusMode.className = 'mode-editing';
    const block = inlineEditor.getCurrentBlock();
    statusInfo.textContent = block ? `ブロック: ${block.id}  — Enter で確定 / Esc でキャンセル` : '';
    canvasContainer.classList.add('editing');
  } else if (state.addTextMode) {
    statusMode.textContent = 'テキスト追加モード';
    statusMode.className = 'mode-addtext';
    statusInfo.textContent = 'クリックでテキストを配置 — Esc で終了';
    canvasContainer.classList.remove('editing');
  } else {
    const sel = selectionManager.getSelection();
    if (sel.type === 'multi') {
      statusMode.textContent = '複数選択';
      statusMode.className = '';
      statusInfo.textContent = `${sel.blocks.length} ブロック選択中 — 結合ボタンで統合`;
    } else if (sel.type === 'text') {
      statusMode.textContent = '選択中';
      statusMode.className = '';
      statusInfo.textContent = `${sel.block.id} — ダブルクリックで編集`;
    } else {
      statusMode.textContent = '選択モード';
      statusMode.className = '';
      statusInfo.textContent = state.pdfDoc ? 'テキストをダブルクリックで編集' : '';
    }
    canvasContainer.classList.remove('editing');
  }
}

/**
 * Pick a default font name from the page's resolved fonts.
 * Prefers the first non-CID font; falls back to the first available or 'F1'.
 */
function getDefaultFontName(): string {
  for (const [name, font] of state.fonts) {
    if (!font.isCID) return name;
  }
  // Fallback: first font, or 'F1'
  const first = state.fonts.keys().next();
  return first.done ? 'F1' : first.value;
}

// ---------------------------------------------------------------------------
// Interaction Layer Events
// ---------------------------------------------------------------------------

/**
 * Find the text cursor position (character index) for a click at the given
 * canvas coordinates within a TextBlock.  Finds the nearest character and
 * decides whether the cursor goes before or after it based on whether the
 * click is past the character's horizontal centre.
 */
function findCursorPosition(canvasX: number, canvasY: number, block: TextBlock): number {
  const chars = block.chars;
  if (chars.length === 0) return 0;

  let bestIndex = 0;
  let bestDist = Infinity;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!ch) continue;
    const cx = ch.x + ch.width / 2;
    const cy = ch.y + ch.height / 2;
    const dist = Math.sqrt((canvasX - cx) ** 2 + (canvasY - cy) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }

  // If the click lands past the character's horizontal midpoint, place the
  // cursor *after* that character.
  const bestChar = chars[bestIndex];
  if (bestChar && canvasX > bestChar.x + bestChar.width / 2) {
    return bestIndex + 1;
  }
  return bestIndex;
}

/** Callback wired to onComplete when inline editing finishes. */
function handleEditComplete(editResult: import('./editor/interaction/inline-edit').EditResult): void {
  if (editResult.confirmed && editResult.newText !== editResult.block.text) {
    void applyEditAndRefresh(editResult.block, editResult.newText);
  } else {
    void renderCurrentPage();
  }
  updateStatusBar();
}

/** Helper: start inline editing on a block. */
function beginEditing(block: TextBlock, canvasX: number, canvasY: number): void {
  const cursorPos = findCursorPosition(canvasX, canvasY, block);
  inlineEditor.startEditing(block, handleEditComplete, cursorPos);
  updateStatusBar();
}

/**
 * Suppress the first click after a dblclick so that the selection change
 * triggered by the first click of a double-click doesn't cause an async
 * re-render that races with the editing canvas snapshot.
 */
let pendingDblClick = false;
let dblClickTimer: number | null = null;

/**
 * Click handler — select, confirm edit, or add text.
 * Editing is started by double-click (see below).
 */
interactionLayer.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const canvasX = event.clientX - rect.left;
  const canvasY = event.clientY - rect.top;
  if (detectEdge(canvasX, canvasY)) return;

  // ── Editing active ──
  if (inlineEditor.isEditing()) {
    const currentBlock = inlineEditor.getCurrentBlock();
    const result = hitTest(canvasX, canvasY, state.textBlocks, [], state.zoom);
    if (result.type === 'text' && currentBlock && result.block.id === currentBlock.id) {
      return; // clicking inside the same block — let hidden input handle it
    }
    // Clicking outside the editing block — confirm is handled by blur.
    // Don't call confirmEditing here to avoid double-fire with blur handler.
    return;
  }

  // ── Not editing ──
  if (state.textBlocks.length === 0 && !state.addTextMode) return;

  const result = hitTest(canvasX, canvasY, state.textBlocks, [], state.zoom);

  if (result.type === 'text' && result.block.editable) {
    // Shift+click → toggle multi-selection (for merge workflow)
    if (event.shiftKey) {
      selectionManager.toggleMulti(result.block);
      updateMergeButton();
      updateStatusBar();
      return;
    }

    // Delay selection slightly to see if this is a double-click.
    // If dblclick fires, we skip the selection and go straight to editing.
    pendingDblClick = false;
    if (dblClickTimer !== null) clearTimeout(dblClickTimer);

    const clickedBlock = result.block;
    dblClickTimer = window.setTimeout(() => {
      if (!pendingDblClick) {
        selectionManager.select({ type: 'text', block: clickedBlock });
        updateMergeButton();
        updateStatusBar();
      }
      dblClickTimer = null;
    }, 200);
  } else {
    // Clicked empty space

    // Add Text mode: create a new empty block at click position
    if (state.addTextMode) {
      const defaultFontSize = 12 * state.zoom;
      const defaultFontName = getDefaultFontName();
      const newBlock = createEmptyTextBlock(canvasX, canvasY, defaultFontSize, defaultFontName);
      state.textBlocks.push(newBlock);

      inlineEditor.startEditing(newBlock, (editResult) => {
        if (editResult.confirmed && editResult.newText.length > 0) {
          void applyEditAndRefresh(editResult.block, editResult.newText);
        } else {
          state.textBlocks = state.textBlocks.filter(b => b.id !== newBlock.id);
          void renderCurrentPage();
        }
        updateStatusBar();
      });
      updateStatusBar();
      return;
    }

    selectionManager.deselect();
    updateMergeButton();
    updateStatusBar();
  }
});

/**
 * Double-click → start inline editing on a text block.
 */
interactionLayer.addEventListener('dblclick', (event) => {
  // Cancel pending single-click selection
  pendingDblClick = true;
  if (dblClickTimer !== null) {
    clearTimeout(dblClickTimer);
    dblClickTimer = null;
  }

  const rect = canvas.getBoundingClientRect();
  const canvasX = event.clientX - rect.left;
  const canvasY = event.clientY - rect.top;

  if (inlineEditor.isEditing()) return;

  const result = hitTest(canvasX, canvasY, state.textBlocks, [], state.zoom);
  if (result.type === 'text' && result.block.editable) {
    beginEditing(result.block, canvasX, canvasY);
  }
});

// ---------------------------------------------------------------------------
// Block edge detection & drag-to-resize
// ---------------------------------------------------------------------------

/** How close (px) the pointer must be to an edge to trigger a resize handle. */
const EDGE_THRESHOLD = 6;

type ResizeEdge = 'right' | 'bottom' | 'left' | 'top' | null;

interface DragState {
  active: boolean;
  block: TextBlock | null;
  edge: ResizeEdge;
  startX: number;
  startY: number;
  origBB: { x: number; y: number; width: number; height: number };
}

const drag: DragState = {
  active: false,
  block: null,
  edge: null,
  startX: 0,
  startY: 0,
  origBB: { x: 0, y: 0, width: 0, height: 0 },
};

/**
 * Detect which edge of which block the pointer is near.
 * Returns the block and the edge name, or null if not near any edge.
 */
function detectEdge(
  canvasX: number,
  canvasY: number,
): { block: TextBlock; edge: ResizeEdge } | null {
  for (const block of state.textBlocks) {
    if (!block.editable) continue;
    const bb = block.boundingBox;
    const pad = EDGE_THRESHOLD;

    // Must be within the vertical extent (with tolerance)
    const inVertical = canvasY >= bb.y - pad && canvasY <= bb.y + bb.height + pad;
    // Must be within the horizontal extent (with tolerance)
    const inHorizontal = canvasX >= bb.x - pad && canvasX <= bb.x + bb.width + pad;

    // Right edge
    if (inVertical && Math.abs(canvasX - (bb.x + bb.width)) <= pad) {
      return { block, edge: 'right' };
    }
    // Bottom edge
    if (inHorizontal && Math.abs(canvasY - (bb.y + bb.height)) <= pad) {
      return { block, edge: 'bottom' };
    }
    // Left edge
    if (inVertical && Math.abs(canvasX - bb.x) <= pad) {
      return { block, edge: 'left' };
    }
    // Top edge
    if (inHorizontal && Math.abs(canvasY - bb.y) <= pad) {
      return { block, edge: 'top' };
    }
  }
  return null;
}

function edgeToCursor(edge: ResizeEdge): string {
  switch (edge) {
    case 'right': return 'ew-resize';
    case 'left': return 'ew-resize';
    case 'bottom': return 'ns-resize';
    case 'top': return 'ns-resize';
    default: return 'default';
  }
}

/** Update cursor and handle drag-resize on mouse move. */
interactionLayer.addEventListener('mousemove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const canvasX = event.clientX - rect.left;
  const canvasY = event.clientY - rect.top;

  // --- Active drag: update bounding box ---
  if (drag.active && drag.block && drag.edge) {
    const dx = canvasX - drag.startX;
    const dy = canvasY - drag.startY;
    const bb = drag.block.boundingBox;
    const orig = drag.origBB;
    const minSize = 10;

    switch (drag.edge) {
      case 'right':
        bb.width = Math.max(minSize, orig.width + dx);
        break;
      case 'left':
        bb.x = Math.min(orig.x + orig.width - minSize, orig.x + dx);
        bb.width = Math.max(minSize, orig.width - dx);
        break;
      case 'bottom':
        bb.height = Math.max(minSize, orig.height + dy);
        break;
      case 'top':
        bb.y = Math.min(orig.y + orig.height - minSize, orig.y + dy);
        bb.height = Math.max(minSize, orig.height - dy);
        break;
    }

    void renderCurrentPage();
    return;
  }

  // --- Not dragging: update cursor ---
  if (state.textBlocks.length === 0) {
    interactionLayer.style.cursor = state.addTextMode ? 'crosshair' : 'default';
    return;
  }

  const edgeHit = detectEdge(canvasX, canvasY);
  if (edgeHit) {
    interactionLayer.style.cursor = edgeToCursor(edgeHit.edge);
    return;
  }

  const result = hitTest(canvasX, canvasY, state.textBlocks, [], state.zoom);
  if (result.type === 'text') {
    interactionLayer.style.cursor = inlineEditor.isEditing() ? 'text' : 'pointer';
  } else {
    interactionLayer.style.cursor = state.addTextMode ? 'crosshair' : 'default';
  }
});

/** Start drag on mousedown if pointer is on a block edge. */
interactionLayer.addEventListener('mousedown', (event) => {
  if (inlineEditor.isEditing()) return;

  const rect = canvas.getBoundingClientRect();
  const canvasX = event.clientX - rect.left;
  const canvasY = event.clientY - rect.top;

  const edgeHit = detectEdge(canvasX, canvasY);
  if (edgeHit && edgeHit.edge) {
    event.preventDefault(); // prevent text selection
    const bb = edgeHit.block.boundingBox;
    drag.active = true;
    drag.block = edgeHit.block;
    drag.edge = edgeHit.edge;
    drag.startX = canvasX;
    drag.startY = canvasY;
    drag.origBB = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  }
});

/** End drag on mouseup. */
interactionLayer.addEventListener('mouseup', () => {
  if (drag.active) {
    drag.active = false;
    drag.block = null;
    drag.edge = null;
    void renderCurrentPage();
  }
});

/** Cancel drag if pointer leaves the interaction layer. */
interactionLayer.addEventListener('mouseleave', () => {
  if (drag.active && drag.block) {
    // Revert to original bounding box
    const bb = drag.block.boundingBox;
    bb.x = drag.origBB.x;
    bb.y = drag.origBB.y;
    bb.width = drag.origBB.width;
    bb.height = drag.origBB.height;
    drag.active = false;
    drag.block = null;
    drag.edge = null;
    void renderCurrentPage();
  }
});

selectionManager.onSelectionChange((_sel) => {
  // Skip re-render while editing — the canvas already shows the editing state
  if (!inlineEditor.isEditing()) {
    void renderCurrentPage();
  }
  updateStatusBar();
});

// ---------------------------------------------------------------------------
// File Handling
// ---------------------------------------------------------------------------

async function handleFile(file: File): Promise<void> {
  if (inlineEditor.isEditing()) {
    inlineEditor.cancelEditing();
  }
  selectionManager.deselect();

  const arrayBuffer = await file.arrayBuffer();
  await loadPDF(arrayBuffer);
}

btnOpen.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    void handleFile(file);
  }
});

dropZone.addEventListener('click', () => {
  fileInput.click();
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.remove('dragover');

  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    const file = files[0];
    if (file !== undefined && (file.type === 'application/pdf' || file.name.endsWith('.pdf'))) {
      void handleFile(file);
    } else {
      alert('Please drop a PDF file');
    }
  }
});

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

/** Push the current buffer onto the undo stack. */
function pushUndo(buffer: Uint8Array): void {
  undoStack.push({ buffer: buffer.slice() });
  if (undoStack.length > MAX_HISTORY) {
    undoStack.shift();
  }
  // Any new edit invalidates the redo history.
  redoStack.length = 0;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons(): void {
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
}

/**
 * Restore the PDF from a given buffer snapshot.
 * Rebuilds the PDF.js document and re-parses text blocks.
 */
async function restoreFromBuffer(buffer: Uint8Array): Promise<void> {
  state.buffer = buffer;

  if (state.pdfDoc) {
    state.pdfDoc.destroy();
  }
  state.pdfDoc = await pdfjsLib.getDocument({ data: buffer.slice() }).promise;

  const reader = new ByteStreamReader(buffer);
  const xref = new XRefParser().parse(reader);
  state.resolver = new ObjectResolver(reader, xref);
  state.pages = state.resolver.getPages();

  await parseCurrentPage();
  await renderCurrentPage();
  updateUndoRedoButtons();
}

btnUndo.addEventListener('click', () => {
  if (undoStack.length === 0 || !state.buffer) return;
  if (inlineEditor.isEditing()) {
    inlineEditor.cancelEditing();
  }
  selectionManager.deselect();

  // Save current state to redo stack.
  redoStack.push({ buffer: state.buffer.slice() });

  const entry = undoStack.pop()!;
  void restoreFromBuffer(entry.buffer);
});

btnRedo.addEventListener('click', () => {
  if (redoStack.length === 0 || !state.buffer) return;
  if (inlineEditor.isEditing()) {
    inlineEditor.cancelEditing();
  }
  selectionManager.deselect();

  // Save current state to undo stack (without clearing redo).
  undoStack.push({ buffer: state.buffer.slice() });

  const entry = redoStack.pop()!;
  void restoreFromBuffer(entry.buffer);
});

// ---------------------------------------------------------------------------
// Block Overlay Toggle
// ---------------------------------------------------------------------------

btnToggleBlocks.addEventListener('click', () => {
  state.showBlocks = !state.showBlocks;
  btnToggleBlocks.classList.toggle('active', state.showBlocks);
  void renderCurrentPage();
});

// ---------------------------------------------------------------------------
// Add Text Mode
// ---------------------------------------------------------------------------

btnAddText.addEventListener('click', () => {
  state.addTextMode = !state.addTextMode;
  btnAddText.classList.toggle('active', state.addTextMode);
  interactionLayer.style.cursor = state.addTextMode ? 'crosshair' : 'default';
  updateStatusBar();
});

// ---------------------------------------------------------------------------
// Block Merge
// ---------------------------------------------------------------------------

/** Enable the Merge button only when 2+ text blocks are selected. */
function updateMergeButton(): void {
  const blocks = selectionManager.getSelectedTextBlocks();
  btnMerge.disabled = blocks.length < 2;
}

btnMerge.addEventListener('click', () => {
  const blocks = selectionManager.getSelectedTextBlocks();
  if (blocks.length < 2) return;

  if (inlineEditor.isEditing()) {
    inlineEditor.confirmEditing();
  }

  // Create a merged block that replaces the source blocks in state.textBlocks.
  const merged = mergeTextBlocks(blocks);
  const sourceIds = new Set(blocks.map(b => b.id));
  state.textBlocks = state.textBlocks.filter(b => !sourceIds.has(b.id));

  // Insert the merged block at the position of the first source block in the
  // original array.  This preserves visual ordering for the overlay palette.
  let insertIdx = state.textBlocks.length;
  for (let i = 0; i < state.textBlocks.length; i++) {
    const bb = state.textBlocks[i].boundingBox;
    if (
      bb.y > merged.boundingBox.y ||
      (Math.abs(bb.y - merged.boundingBox.y) < 2 && bb.x > merged.boundingBox.x)
    ) {
      insertIdx = i;
      break;
    }
  }
  state.textBlocks.splice(insertIdx, 0, merged);

  // Select the newly merged block so the user can immediately edit it.
  selectionManager.select({ type: 'text', block: merged });
  updateMergeButton();
});

// ---------------------------------------------------------------------------
// Zoom Controls
// ---------------------------------------------------------------------------

btnZoomOut.addEventListener('click', () => {
  const currentIndex = zoomLevels.indexOf(state.zoom);
  if (currentIndex > 0) {
    if (inlineEditor.isEditing()) {
      inlineEditor.cancelEditing();
    }
    state.zoom = zoomLevels[currentIndex - 1] as number;
    void updateZoom();
  }
});

btnZoomIn.addEventListener('click', () => {
  const currentIndex = zoomLevels.indexOf(state.zoom);
  if (currentIndex < zoomLevels.length - 1) {
    if (inlineEditor.isEditing()) {
      inlineEditor.cancelEditing();
    }
    state.zoom = zoomLevels[currentIndex + 1] as number;
    void updateZoom();
  }
});

async function updateZoom(): Promise<void> {
  zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
  if (state.resolver) {
    await parseCurrentPage();
  }
  await renderCurrentPage();
}

// ---------------------------------------------------------------------------
// Page Navigation
// ---------------------------------------------------------------------------

btnPrevPage.addEventListener('click', () => {
  if (state.currentPageIndex > 0) {
    if (inlineEditor.isEditing()) {
      inlineEditor.cancelEditing();
    }
    selectionManager.deselect();
    state.currentPageIndex--;
    void (async () => {
      await parseCurrentPage();
      await renderCurrentPage();
    })();
    updatePageInfo();
    updateNavButtons();
  }
});

btnNextPage.addEventListener('click', () => {
  if (state.currentPageIndex < state.pages.length - 1) {
    if (inlineEditor.isEditing()) {
      inlineEditor.cancelEditing();
    }
    selectionManager.deselect();
    state.currentPageIndex++;
    void (async () => {
      await parseCurrentPage();
      await renderCurrentPage();
    })();
    updatePageInfo();
    updateNavButtons();
  }
});

function updateNavButtons(): void {
  btnPrevPage.disabled = state.currentPageIndex === 0;
  btnNextPage.disabled = state.currentPageIndex === state.pages.length - 1;
}

// ---------------------------------------------------------------------------
// Save Pipeline
// ---------------------------------------------------------------------------

btnSave.addEventListener('click', () => {
  if (!state.buffer) return;

  // state.buffer is always up-to-date (rebuilt after each edit)
  downloadPdf(state.buffer);
});

function getContentsObjNum(page: any): number {
  const contentsEntry = page.get('Contents');
  if (contentsEntry === undefined || contentsEntry === null) return 1;

  if (contentsEntry.type === 'ref') {
    return contentsEntry.objNum as number;
  }

  if (contentsEntry.type === 'array') {
    const first = contentsEntry.items[0];
    if (first !== undefined && first.type === 'ref') {
      return first.objNum as number;
    }
  }

  return 1;
}

function concatArrays(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function downloadPdf(data: Uint8Array): void {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'edited.pdf';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Metadata Panel
// ---------------------------------------------------------------------------

/** Editable metadata fields — PDF Info dictionary keys + Japanese labels. */
const METADATA_FIELDS: Array<{ key: string; label: string; editable: boolean }> = [
  { key: 'Title',    label: 'タイトル',            editable: true },
  { key: 'Author',   label: '作成者',              editable: true },
  { key: 'Subject',  label: '件名',                editable: true },
  { key: 'Keywords', label: 'キーワード',          editable: true },
  { key: 'Creator',  label: '作成アプリケーション', editable: true },
  { key: 'Producer', label: 'PDF生成ツール',        editable: true },
  { key: 'CreationDate', label: '作成日時',         editable: false },
  { key: 'ModDate',      label: '更新日時',         editable: false },
  { key: 'PDFFormatVersion', label: 'PDFバージョン', editable: false },
];

function parsePdfDate(dateStr: string): string {
  const match = dateStr.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, y, m, d, h, min, s] = match;
    return `${y}/${m}/${d} ${h}:${min}:${s}`;
  }
  return dateStr.replace(/^D:/, '');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Escape a string for use inside a PDF literal string `(…)`. */
function escapePdfString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Convert a JS string to a PDF UTF-16BE literal string with BOM. */
function toPdfUtf16String(str: string): string {
  if (str.length === 0) return '()';
  // Check if ASCII-only (no encoding needed)
  let ascii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) return `(${escapePdfString(str)})`;
  // UTF-16BE with BOM
  const codes: number[] = [0xFE, 0xFF]; // BOM
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    codes.push((code >> 8) & 0xFF);
    codes.push(code & 0xFF);
  }
  const hex = codes.map(b => b.toString(16).padStart(2, '0')).join('');
  return `<${hex}>`;
}

/** Build a serialized PDF Info dictionary from key-value pairs. */
function buildInfoDictBytes(fields: Map<string, string>): Uint8Array {
  let dict = '<< ';
  for (const [key, value] of fields) {
    if (value.length > 0) {
      dict += `/${key} ${toPdfUtf16String(value)} `;
    }
  }
  // Add ModDate as current time
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateStr = `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  dict += `/ModDate (${dateStr}) `;
  dict += '>>';
  return new TextEncoder().encode(dict);
}

/**
 * Get the Info dictionary's object number from the XRef trailer.
 * If no Info dict exists, returns the next available object number
 * (so we can create a new one).
 */
function getInfoObjNum(): { objNum: number; isNew: boolean } {
  if (!state.buffer) return { objNum: 1, isNew: true };

  const reader = new ByteStreamReader(state.buffer);
  const xref = new XRefParser().parse(reader);

  if (xref.trailer.info) {
    return { objNum: xref.trailer.info.objNum, isNew: false };
  }
  // Create new object — use trailer.size as the next available objNum
  return { objNum: xref.trailer.size, isNew: true };
}

/** Apply metadata changes via incremental PDF update. */
async function applyMetadataEdit(fields: Map<string, string>): Promise<void> {
  if (!state.buffer) return;

  pushUndo(state.buffer);

  const { objNum } = getInfoObjNum();
  const infoData = buildInfoDictBytes(fields);

  const modifiedObjects: ModifiedObject[] = [{
    objNum,
    genNum: 0,
    data: infoData,
  }];

  try {
    const reader = new ByteStreamReader(state.buffer);
    const xref = new XRefParser().parse(reader);

    // Ensure the trailer references the Info dictionary (may be new)
    xref.trailer.info = { objNum, genNum: 0 };

    const newPdf = buildIncrementalUpdate(state.buffer, modifiedObjects, xref);

    state.buffer = newPdf;
    state.modified = true;
    btnSave.disabled = false;

    // Reload PDF.js document
    if (state.pdfDoc) state.pdfDoc.destroy();
    state.pdfDoc = await pdfjsLib.getDocument({ data: newPdf.slice() }).promise;

    // Re-parse
    const newReader = new ByteStreamReader(newPdf);
    const newXref = new XRefParser().parse(newReader);
    state.resolver = new ObjectResolver(newReader, newXref);
    state.pages = state.resolver.getPages();
  } catch (error) {
    console.error('Error updating metadata:', error);
    alert(`メタデータ更新エラー: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}

/**
 * Apply password encryption to the PDF via incremental update.
 * Adds an /Encrypt dictionary and /ID array to the trailer.
 */
async function applyPasswordEncryption(
  userPassword: string,
  ownerPassword: string,
): Promise<void> {
  if (!state.buffer) return;

  pushUndo(state.buffer);

  const reader = new ByteStreamReader(state.buffer);
  const xref = new XRefParser().parse(reader);

  // Reuse existing /ID if present.
  const existingId = xref.trailer.id?.[0];

  const { encryptDictBytes, fileId } = buildEncryptDictionary(
    userPassword,
    ownerPassword,
    undefined, // default permissions
    existingId,
  );

  // Allocate a new object number for the /Encrypt dictionary.
  const encryptObjNum = xref.trailer.size;

  const modifiedObjects: ModifiedObject[] = [{
    objNum: encryptObjNum,
    genNum: 0,
    data: encryptDictBytes,
  }];

  // Update trailer to reference /Encrypt and /ID.
  xref.trailer.encrypt = { objNum: encryptObjNum, genNum: 0 };
  xref.trailer.id = [fileId, fileId];

  try {
    const newPdf = buildIncrementalUpdate(state.buffer, modifiedObjects, xref);
    state.buffer = newPdf;
    state.modified = true;
    btnSave.disabled = false;

    // Reload PDF.js document (will require password to display).
    if (state.pdfDoc) state.pdfDoc.destroy();
    state.pdfDoc = await pdfjsLib.getDocument({
      data: newPdf.slice(),
      password: userPassword,
    }).promise;

    // Re-parse
    const newReader = new ByteStreamReader(newPdf);
    const newXref = new XRefParser().parse(newReader);
    state.resolver = new ObjectResolver(newReader, newXref);
    state.pages = state.resolver.getPages();

    await parseCurrentPage();
    await renderCurrentPage();
  } catch (error) {
    console.error('Error applying password encryption:', error);
    alert(`パスワード設定エラー: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}

async function extractMetadata(): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (state.pdfDoc) {
    try {
      const meta = await state.pdfDoc.getMetadata();
      const info = meta.info as Record<string, unknown>;

      for (const field of METADATA_FIELDS) {
        const val = info[field.key];
        if (val !== undefined && val !== null && val !== '') {
          let displayVal = String(val);
          if ((field.key === 'CreationDate' || field.key === 'ModDate') && typeof val === 'string') {
            displayVal = parsePdfDate(val);
          }
          result.set(field.key, displayVal);
        } else {
          result.set(field.key, '');
        }
      }
    } catch (e) {
      console.warn('Could not get PDF.js metadata:', e);
    }
  }

  return result;
}

function showMetadataModal(metadata: Map<string, string>): void {
  let html = '<button class="metadata-close" id="btn-metadata-close">✕</button>';
  html += '<h2>PDF メタデータ</h2>';

  html += '<table>';
  for (const field of METADATA_FIELDS) {
    const value = metadata.get(field.key) ?? '';
    const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    html += `<tr><th>${field.label}</th><td>`;
    if (field.editable) {
      html += `<input type="text" class="metadata-input" data-key="${field.key}" value="${escaped}" placeholder="（なし）" />`;
    } else {
      html += escaped || '<span class="metadata-empty">（なし）</span>';
    }
    html += '</td></tr>';
  }
  html += '</table>';

  // File info (read-only)
  html += '<table style="margin-top: 12px; border-top: 2px solid #45475a;">';
  if (state.buffer) {
    html += `<tr><th>ファイルサイズ</th><td>${formatFileSize(state.buffer.byteLength)}</td></tr>`;
  }
  if (state.pages.length > 0) {
    html += `<tr><th>ページ数</th><td>${state.pages.length}</td></tr>`;
  }
  if (state.pageWidth > 0 && state.pageHeight > 0) {
    html += `<tr><th>ページサイズ</th><td>${Math.round(state.pageWidth)} × ${Math.round(state.pageHeight)} pt</td></tr>`;
  }
  html += '</table>';

  // Password protection section
  html += '<table style="margin-top: 12px; border-top: 2px solid #45475a;">';
  html += '<tr><td colspan="2" style="padding: 8px 0 4px; font-weight: bold; color: #cdd6f4;">パスワード保護</td></tr>';
  html += '<tr><th>開くパスワード</th><td><input type="password" id="input-user-password" placeholder="未設定" style="width: 100%;" /></td></tr>';
  html += '<tr><th>権限パスワード</th><td><input type="password" id="input-owner-password" placeholder="（空欄の場合は開くパスワードと同じ）" style="width: 100%;" /></td></tr>';
  html += '</table>';
  html += '<div style="margin-top: 8px; text-align: right;">';
  html += '<button class="metadata-close" id="btn-apply-password" style="background: #e85d1a; border-color: #e85d1a;">パスワードを設定</button>';
  html += '</div>';

  html += '<div style="margin-top: 16px; text-align: right;">';
  html += '<button class="metadata-close" id="btn-metadata-save" style="background: #1a73e8; border-color: #1a73e8; margin-left: 8px;">メタデータ保存</button>';
  html += '</div>';

  metadataContent.innerHTML = html;
  metadataModal.classList.add('active');

  document.getElementById('btn-metadata-close')?.addEventListener('click', () => {
    metadataModal.classList.remove('active');
  });

  document.getElementById('btn-metadata-save')?.addEventListener('click', () => {
    const inputs = metadataContent.querySelectorAll<HTMLInputElement>('.metadata-input');
    const updated = new Map<string, string>();
    for (const input of inputs) {
      const key = input.dataset.key;
      if (key) updated.set(key, input.value.trim());
    }
    // Preserve read-only fields from original
    const creationDate = metadata.get('CreationDate');
    if (creationDate) updated.set('CreationDate', creationDate);

    void (async () => {
      await applyMetadataEdit(updated);
      metadataModal.classList.remove('active');
      // Re-open to show updated values
      const newMeta = await extractMetadata();
      showMetadataModal(newMeta);
    })();
  });

  document.getElementById('btn-apply-password')?.addEventListener('click', () => {
    const userPwd = (document.getElementById('input-user-password') as HTMLInputElement).value;
    const ownerPwd = (document.getElementById('input-owner-password') as HTMLInputElement).value;

    if (!userPwd) {
      alert('開くパスワードを入力してください。');
      return;
    }

    void (async () => {
      await applyPasswordEncryption(userPwd, ownerPwd);
      metadataModal.classList.remove('active');
      alert('パスワードが設定されました。Save PDF で保存してください。');
    })();
  });
}

btnInfo.addEventListener('click', () => {
  void (async () => {
    const metadata = await extractMetadata();
    showMetadataModal(metadata);
  })();
});

metadataModal.addEventListener('click', (event) => {
  if (event.target === metadataModal) {
    metadataModal.classList.remove('active');
  }
});

// ---------------------------------------------------------------------------
// Keyboard Events
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;

  // --- Escape: cascaded dismiss ---
  if (event.key === 'Escape') {
    if (metadataModal.classList.contains('active')) {
      metadataModal.classList.remove('active');
      return;
    }
    if (inlineEditor.isEditing()) {
      inlineEditor.cancelEditing();
      updateStatusBar();
      return;
    }
    if (state.addTextMode) {
      state.addTextMode = false;
      btnAddText.classList.remove('active');
      interactionLayer.style.cursor = 'default';
      updateStatusBar();
      return;
    }
    selectionManager.deselect();
    updateMergeButton();
    updateStatusBar();
    return;
  }

  // --- Delete/Backspace: remove selected block text ---
  if ((event.key === 'Delete' || event.key === 'Backspace') && !inlineEditor.isEditing()) {
    const sel = selectionManager.getSelection();
    if (sel.type === 'text' && sel.block.editable) {
      void applyEditAndRefresh(sel.block, '');
    }
  }

  // --- Enter on selected block: start editing ---
  if (event.key === 'Enter' && !inlineEditor.isEditing()) {
    const sel = selectionManager.getSelection();
    if (sel.type === 'text' && sel.block.editable) {
      event.preventDefault();
      const bb = sel.block.boundingBox;
      beginEditing(sel.block, bb.x + 1, bb.y + bb.height / 2);
    }
  }

  // Don't intercept keyboard shortcuts while editing text
  if (inlineEditor.isEditing()) return;

  // --- Ctrl+Z / Cmd+Z → Undo ---
  if (mod && !event.shiftKey && event.key === 'z') {
    if (undoStack.length > 0) {
      event.preventDefault();
      btnUndo.click();
    }
  }

  // --- Ctrl+Y / Cmd+Shift+Z → Redo ---
  if (
    (mod && event.key === 'y') ||
    (mod && event.shiftKey && event.key === 'z')
  ) {
    if (redoStack.length > 0) {
      event.preventDefault();
      btnRedo.click();
    }
  }

  // --- Ctrl+O / Cmd+O → Open ---
  if (mod && event.key === 'o') {
    event.preventDefault();
    fileInput.click();
  }

  // --- Ctrl+S / Cmd+S → Save ---
  if (mod && event.key === 's') {
    event.preventDefault();
    if (state.buffer) btnSave.click();
  }

  // --- B → toggle blocks overlay ---
  if (event.key === 'b' && !mod) {
    if (state.pdfDoc) btnToggleBlocks.click();
  }

  // --- T → toggle add-text mode ---
  if (event.key === 't' && !mod) {
    if (state.pdfDoc) btnAddText.click();
  }
});

// ---------------------------------------------------------------------------
// Ctrl+Wheel → Zoom
// ---------------------------------------------------------------------------

document.getElementById('editor-area')!.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();

  const currentIndex = zoomLevels.indexOf(state.zoom);
  if (event.deltaY < 0 && currentIndex < zoomLevels.length - 1) {
    // Zoom in
    if (inlineEditor.isEditing()) inlineEditor.cancelEditing();
    state.zoom = zoomLevels[currentIndex + 1] as number;
    void updateZoom();
  } else if (event.deltaY > 0 && currentIndex > 0) {
    // Zoom out
    if (inlineEditor.isEditing()) inlineEditor.cancelEditing();
    state.zoom = zoomLevels[currentIndex - 1] as number;
    void updateZoom();
  }
}, { passive: false });

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

void updateZoom();
updateStatusBar();

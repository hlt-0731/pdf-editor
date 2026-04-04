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
import { resetTextBlockCounter } from './model/text-block';
import type { TextBlock } from './model/text-block';
import { hitTest } from './editor/canvas/hit-test';
import { SelectionManager } from './editor/interaction/selector';
import { InlineEditor } from './editor/interaction/inline-edit';
import { rebuildTextOperators, serializeOperators } from './editor/pipeline/save';
import { buildIncrementalUpdate, type ModifiedObject } from './editor/pipeline/incremental';

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
};

const zoomLevels = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];

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
const interactionLayer = document.getElementById('interaction-layer')!;

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
async function renderCurrentPage(): Promise<void> {
  if (!state.pdfDoc) return;

  const gen = ++state.renderGeneration;

  const pdfPage: PDFPageProxy = await state.pdfDoc.getPage(state.currentPageIndex + 1);
  if (gen !== state.renderGeneration) return; // stale

  const viewport = pdfPage.getViewport({ scale: state.zoom });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  if (gen !== state.renderGeneration) return; // stale

  // Draw selection highlight on top of the rendered page
  const sel = selectionManager.getSelection();
  if (sel.type === 'text') {
    drawSelectionHighlight(sel.block);
  }
}

function drawSelectionHighlight(block: TextBlock): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bb = block.boundingBox;
  const padding = 2;

  ctx.save();
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(
    bb.x - padding,
    bb.y - padding,
    bb.width + padding * 2,
    bb.height + padding * 2,
  );
  ctx.restore();
}

function updatePageInfo(): void {
  pageInfo.textContent = `Page ${state.currentPageIndex + 1} / ${state.pages.length}`;
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

  const modifiedBlocks = state.textBlocks.filter(b => b.modified);
  if (modifiedBlocks.length === 0) return null;

  const rebuiltOperators = rebuildTextOperators(state.operators, modifiedBlocks, state.fonts);
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

/**
 * Single click → start inline editing directly on the text block.
 *
 * Clicking on empty space while an edit is active confirms it via the
 * textarea's blur handler (focus leaves the textarea → blur fires →
 * confirmEditing runs).
 */
interactionLayer.addEventListener('click', (event) => {
  if (state.textBlocks.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const canvasX = event.clientX - rect.left;
  const canvasY = event.clientY - rect.top;

  const result = hitTest(canvasX, canvasY, state.textBlocks, [], state.zoom);

  if (result.type === 'text' && result.block.editable) {
    // If already editing this same block, let the hidden input handle it
    if (inlineEditor.isEditing() && inlineEditor.getCurrentBlock()?.id === result.block.id) {
      return;
    }

    const cursorPos = findCursorPosition(canvasX, canvasY, result.block);

    // Start editing FIRST so isEditing() is true before any selection
    // change triggers a re-render that would overwrite the canvas state.
    inlineEditor.startEditing(result.block, (editResult) => {
      if (editResult.confirmed && editResult.newText !== editResult.block.text) {
        void applyEditAndRefresh(editResult.block, editResult.newText);
      } else {
        void renderCurrentPage();
      }
    }, cursorPos);
  } else {
    // Clicked empty space — explicitly confirm any active edit
    if (inlineEditor.isEditing()) {
      inlineEditor.confirmEditing();
    }
    selectionManager.deselect();
  }
});

/** Show a text-editing cursor when hovering over editable text blocks. */
interactionLayer.addEventListener('mousemove', (event) => {
  if (state.textBlocks.length === 0) {
    interactionLayer.style.cursor = 'default';
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const canvasX = event.clientX - rect.left;
  const canvasY = event.clientY - rect.top;

  const result = hitTest(canvasX, canvasY, state.textBlocks, [], state.zoom);
  interactionLayer.style.cursor = result.type === 'text' ? 'text' : 'default';
});

selectionManager.onSelectionChange((_sel) => {
  // Skip re-render while editing — the canvas already shows the editing state
  if (!inlineEditor.isEditing()) {
    void renderCurrentPage();
  }
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

  html += '<div style="margin-top: 16px; text-align: right;">';
  html += '<button class="metadata-close" id="btn-metadata-save" style="background: #1a73e8; border-color: #1a73e8; margin-left: 8px;">保存</button>';
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
  if (event.key === 'Escape') {
    if (metadataModal.classList.contains('active')) {
      metadataModal.classList.remove('active');
      return;
    }
    if (inlineEditor.isEditing()) {
      inlineEditor.cancelEditing();
    } else {
      selectionManager.deselect();
    }
  }

  if ((event.key === 'Delete' || event.key === 'Backspace') && !inlineEditor.isEditing()) {
    const sel = selectionManager.getSelection();
    if (sel.type === 'text' && sel.block.editable) {
      void applyEditAndRefresh(sel.block, '');
    }
  }
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

void updateZoom();

console.log('PDF Editor initialized. Drag and drop a PDF or click to open.');

/**
 * L4 Editor Layer — InlineEditor (Canvas-based)
 *
 * Provides a "direct editing" experience by rendering edited text and a
 * blinking cursor directly on the PDF canvas.  A completely hidden <textarea>
 * captures keyboard input and IME composition — the user never sees any HTML
 * form element.  All visual feedback (text, cursor) is drawn on the canvas.
 *
 * Lifecycle:
 *   startEditing(block, onComplete, cursorPosition?)
 *     → user types, cursor blinks on canvas
 *     → Enter / click outside confirms; Escape cancels
 *     → onComplete called with EditResult
 *     → cleanup() removes hidden input, page re-renders
 */

import type { TextBlock } from '../../model/text-block';

// ---------------------------------------------------------------------------
// EditResult
// ---------------------------------------------------------------------------

export interface EditResult {
  /** The block that was being edited. */
  block: TextBlock;
  /** The text value at the time of confirmation or cancellation. */
  newText: string;
  /** True when the user confirmed the edit (Enter or blur); false on Escape. */
  confirmed: boolean;
}

// ---------------------------------------------------------------------------
// InlineEditor
// ---------------------------------------------------------------------------

export class InlineEditor {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;

  private hiddenInput: HTMLTextAreaElement | null = null;
  private currentBlock: TextBlock | null = null;
  private onComplete: ((result: EditResult) => void) | null = null;

  // Canvas snapshot saved when editing starts — restored before each
  // renderText() so neighbouring PDF content is never destroyed.
  private canvasSnapshot: ImageData | null = null;

  // Cursor blink state
  private cursorBlinkTimer: number | null = null;
  private cursorVisible = true;
  private savedCursorArea: ImageData | null = null;
  private lastCursorRect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(container: HTMLElement, canvas: HTMLCanvasElement) {
    this.container = container;
    this.canvas = canvas;
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Start editing the given block.  A hidden <textarea> is created for input
   * capture, and the block's text + cursor are rendered directly on the canvas.
   *
   * If another edit is already in progress it is **confirmed** first.
   *
   * @param cursorPosition  Optional character index for initial cursor placement.
   */
  startEditing(
    block: TextBlock,
    onComplete: (result: EditResult) => void,
    cursorPosition?: number,
  ): void {
    if (this.isEditing()) {
      this.confirmEditing();
    }

    this.currentBlock = block;
    this.onComplete = onComplete;

    // Save a snapshot of the entire canvas so we can restore it before
    // each renderText() — this prevents neighbouring content from being
    // erased by the white clearing rectangle.
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      this.canvasSnapshot = ctx.getImageData(
        0, 0, this.canvas.width, this.canvas.height,
      );
    }

    // Create hidden textarea for input capture
    this.hiddenInput = this.createHiddenInput(block);
    this.container.appendChild(this.hiddenInput);

    // Render initial editing state on canvas
    this.renderText();

    // Focus and set cursor position
    this.hiddenInput.focus();
    const pos = cursorPosition !== undefined
      ? Math.min(cursorPosition, this.hiddenInput.value.length)
      : this.hiddenInput.value.length;
    this.hiddenInput.setSelectionRange(pos, pos);

    // Start cursor blink
    this.startCursorBlink();
  }

  /** Confirm the current edit and call the onComplete callback. */
  confirmEditing(): void {
    if (!this.hiddenInput || !this.currentBlock || !this.onComplete) return;

    const result: EditResult = {
      block: this.currentBlock,
      newText: this.hiddenInput.value,
      confirmed: true,
    };

    const cb = this.onComplete;
    this.cleanup();
    cb(result);
  }

  /** Cancel the current edit without applying changes. */
  cancelEditing(): void {
    if (this.hiddenInput && this.currentBlock && this.onComplete) {
      const result: EditResult = {
        block: this.currentBlock,
        newText: this.currentBlock.text,
        confirmed: false,
      };
      const cb = this.onComplete;
      this.cleanup();
      cb(result);
    } else {
      this.cleanup();
    }
  }

  /** Return true if an edit is currently active. */
  isEditing(): boolean {
    return this.hiddenInput !== null;
  }

  /** Return the block currently being edited, or null. */
  getCurrentBlock(): TextBlock | null {
    return this.currentBlock;
  }

  // ─── Hidden textarea ──────────────────────────────────────────

  /**
   * Create an invisible <textarea> that captures keyboard input and IME
   * composition.  It is positioned near the block so the OS IME candidate
   * window appears at the right location.
   */
  private createHiddenInput(block: TextBlock): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    const bb = block.boundingBox;

    ta.style.position = 'absolute';
    ta.style.left = `${bb.x}px`;
    ta.style.top = `${bb.y}px`;
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.resize = 'none';
    ta.style.overflow = 'hidden';
    ta.style.opacity = '0';
    ta.style.zIndex = '10';
    ta.style.fontSize = `${block.fontSize}px`;
    ta.style.lineHeight = '1';
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('spellcheck', 'false');

    ta.value = block.text;

    // Capture reference for blur guard
    const thisInput = ta;

    // Re-render on input change
    ta.addEventListener('input', () => {
      this.renderText();
      this.resetCursorBlink();
    });

    // Keyboard shortcuts
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.cancelEditing();
        return;
      }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        this.confirmEditing();
        return;
      }
      // Update cursor after arrow keys / Home / End
      requestAnimationFrame(() => {
        this.eraseCursor();
        this.drawCursor();
        this.updateIMEPosition();
      });
    });

    // Blur → confirm (user clicked outside the editing area)
    ta.addEventListener('blur', () => {
      if (this.hiddenInput === thisInput) {
        this.confirmEditing();
      }
    });

    return ta;
  }

  /**
   * Move the hidden input to the current cursor position so the IME
   * candidate window appears near the blinking cursor.
   */
  private updateIMEPosition(): void {
    if (!this.hiddenInput || !this.currentBlock) return;
    const idx = this.hiddenInput.selectionStart ?? 0;
    const pos = this.getCursorCanvasPos(idx);
    this.hiddenInput.style.left = `${pos.x}px`;
    this.hiddenInput.style.top = `${pos.y}px`;
  }

  // ─── Canvas rendering ─────────────────────────────────────────

  /**
   * Repaint the block area on the canvas: clear → draw characters → cursor.
   *
   * Characters are drawn at their original positions from the TextBlock.chars
   * array.  If the user has typed more characters than the original, the extra
   * characters are rendered after the last original position using measured
   * widths.
   */
  private renderText(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.currentBlock || !this.hiddenInput) return;

    const block = this.currentBlock;
    const bb = block.boundingBox;
    const text = this.hiddenInput.value;
    const chars = block.chars;

    // Restore the canvas snapshot first so neighbouring content is intact.
    if (this.canvasSnapshot) {
      ctx.putImageData(this.canvasSnapshot, 0, 0);
    }

    // Clear the block area with a small padding.
    // The bounding box may have been expanded by the user via drag-to-resize,
    // so we always use bb dimensions (which are larger than the text extent
    // when manually widened).  Also add extra width for overflowing characters.
    const pad = 4;
    const extraW = Math.max(0, (text.length - chars.length)) * block.fontSize * 0.6;
    const clearW = Math.max(bb.width, bb.width) + extraW;
    ctx.save();
    ctx.fillStyle = 'white';
    ctx.fillRect(
      bb.x - pad,
      bb.y - pad,
      clearW + pad * 2,
      bb.height + pad * 2,
    );

    // Draw each character at its original position.
    ctx.textBaseline = 'alphabetic';

    // Base position for new (empty) blocks — derive from bounding box.
    const baseX = bb.x;
    const baseY = bb.y + block.fontSize * 0.85;
    const baseFontSize = block.fontSize || 16;
    const baseColor = block.color;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!c) continue;

      let x: number;
      let y: number;
      let fontSize: number;
      let r: number;
      let g: number;
      let b: number;

      if (i < chars.length) {
        const ch = chars[i]!;
        x = ch.x;
        y = ch.y;
        fontSize = ch.fontSize;
        [r, g, b] = ch.color;
      } else if (chars.length > 0) {
        // Extra characters appended beyond original length
        const last = chars[chars.length - 1]!;
        fontSize = last.fontSize;
        y = last.y;
        [r, g, b] = last.color;
        ctx.font = `${fontSize}px sans-serif`;
        const preceding = text.substring(chars.length, i);
        x = last.x + last.width + ctx.measureText(preceding).width;
      } else {
        // Empty block (newly created) — position from bounding box
        fontSize = baseFontSize;
        y = baseY;
        [r, g, b] = baseColor;
        ctx.font = `${fontSize}px sans-serif`;
        const preceding = text.substring(0, i);
        x = baseX + ctx.measureText(preceding).width;
      }

      ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillText(c, x, y);
    }

    ctx.restore();

    // Invalidate saved cursor area and redraw cursor
    this.savedCursorArea = null;
    this.drawCursor();
  }

  // ─── Cursor ────────────────────────────────────────────────────

  /** Draw the cursor line at the current textarea selection position. */
  private drawCursor(): void {
    if (!this.cursorVisible) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.hiddenInput) return;

    const idx = this.hiddenInput.selectionStart ?? 0;
    const pos = this.getCursorCanvasPos(idx);

    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cw = 3;
    const ch = Math.ceil(pos.height);

    this.lastCursorRect = { x: cx - 1, y: cy, w: cw, h: ch };

    // Save the pixels under the cursor for later restoration
    this.savedCursorArea = ctx.getImageData(cx - 1, cy, cw, ch);

    // Draw cursor line
    ctx.fillStyle = '#1a73e8';
    ctx.fillRect(cx - 0.5, cy, 1.5, ch);
  }

  /** Erase the cursor by restoring the saved image data. */
  private eraseCursor(): void {
    if (!this.savedCursorArea) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(
      this.savedCursorArea,
      this.lastCursorRect.x,
      this.lastCursorRect.y,
    );
    this.savedCursorArea = null;
  }

  /**
   * Compute the canvas position for the editing cursor at the given
   * character index.  The cursor is a vertical line that extends from
   * above the baseline (ascent) to below it (descent).
   */
  private getCursorCanvasPos(
    charIndex: number,
  ): { x: number; y: number; height: number } {
    const block = this.currentBlock;
    if (!block) return { x: 0, y: 0, height: 16 };
    const chars = block.chars;

    // Empty block (newly created) — derive position from bounding box.
    if (chars.length === 0) {
      const bb = block.boundingBox;
      const fontSize = block.fontSize || 16;
      const baseX = bb.x;
      const baseY = bb.y + fontSize * 0.85;
      let xOffset = 0;
      if (charIndex > 0 && this.hiddenInput) {
        const ctx = this.canvas.getContext('2d');
        if (ctx) {
          ctx.font = `${fontSize}px sans-serif`;
          xOffset = ctx.measureText(this.hiddenInput.value.substring(0, charIndex)).width;
        }
      }
      return {
        x: baseX + xOffset,
        y: baseY - fontSize * 0.85,
        height: fontSize,
      };
    }

    const refChar =
      charIndex < chars.length
        ? chars[charIndex]!
        : chars[chars.length - 1]!;
    const height = refChar.fontSize;

    if (charIndex <= 0) {
      return {
        x: chars[0]!.x,
        y: chars[0]!.y - height * 0.85,
        height,
      };
    }

    if (charIndex < chars.length) {
      const ch = chars[charIndex]!;
      return { x: ch.x, y: ch.y - height * 0.85, height };
    }

    // Beyond original chars — measure extra text width
    const last = chars[chars.length - 1]!;
    let extraWidth = 0;
    if (this.hiddenInput && charIndex > chars.length) {
      const ctx = this.canvas.getContext('2d');
      if (ctx) {
        ctx.font = `${last.fontSize}px sans-serif`;
        const extra = this.hiddenInput.value.substring(chars.length, charIndex);
        extraWidth = ctx.measureText(extra).width;
      }
    }

    return {
      x: last.x + last.width + extraWidth,
      y: last.y - height * 0.85,
      height,
    };
  }

  // ─── Blink timer ───────────────────────────────────────────────

  private startCursorBlink(): void {
    this.stopCursorBlink();
    this.cursorVisible = true;
    this.drawCursor();

    this.cursorBlinkTimer = window.setInterval(() => {
      if (this.cursorVisible) {
        this.eraseCursor();
        this.cursorVisible = false;
      } else {
        this.cursorVisible = true;
        this.drawCursor();
      }
    }, 530);
  }

  /** Reset the blink cycle so the cursor stays visible right after typing. */
  private resetCursorBlink(): void {
    this.startCursorBlink();
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkTimer !== null) {
      clearInterval(this.cursorBlinkTimer);
      this.cursorBlinkTimer = null;
    }
    this.eraseCursor();
  }

  // ─── Cleanup ───────────────────────────────────────────────────

  private cleanup(): void {
    this.stopCursorBlink();
    if (this.hiddenInput !== null) {
      // Detach the blur handler BEFORE removing the element to prevent
      // re-entrant confirmEditing() calls (removing a focused element
      // triggers blur, which would call confirmEditing again).
      const input = this.hiddenInput;
      this.hiddenInput = null; // clear first so blur guard sees null
      try { input.remove(); } catch { /* already removed */ }
    }
    this.currentBlock = null;
    this.onComplete = null;
    this.savedCursorArea = null;
    this.canvasSnapshot = null;
  }
}

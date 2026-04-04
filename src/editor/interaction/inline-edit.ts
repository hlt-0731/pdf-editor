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

    // Clear the block area.
    // bb.y may be at the baseline, so extend upward by fontSize to cover
    // the ascender region.  Extra width accommodates inserted characters.
    const pad = 6;
    const ascent = block.fontSize;
    ctx.save();
    ctx.fillStyle = 'white';
    ctx.fillRect(
      bb.x - pad,
      bb.y - ascent - pad,
      bb.width + pad * 2 + ascent,
      bb.height + ascent + pad * 2,
    );

    // Draw each character
    ctx.textBaseline = 'alphabetic';
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
      } else {
        // Extra characters appended beyond original length
        const last = chars[chars.length - 1]!;
        fontSize = last.fontSize;
        y = last.y;
        [r, g, b] = last.color;
        ctx.font = `${fontSize}px sans-serif`;
        const preceding = text.substring(chars.length, i);
        x = last.x + last.width + ctx.measureText(preceding).width;
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
    const chars = this.currentBlock?.chars;
    if (!chars || chars.length === 0) return { x: 0, y: 0, height: 16 };

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
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
    this.currentBlock = null;
    this.onComplete = null;
    this.savedCursorArea = null;
  }
}

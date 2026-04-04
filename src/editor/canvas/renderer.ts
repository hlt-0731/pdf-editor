/**
 * L4 Editor Layer — PageRenderer
 *
 * Renders a PageModel onto an HTMLCanvasElement using the 2D Canvas API.
 * Text characters are drawn individually so their positions exactly match the
 * positions extracted from the PDF content stream.  Image blocks are drawn as
 * placeholder rectangles until a full image-decoding pipeline is available.
 */

import type { TextBlock, TextChar } from '../../model/text-block';
import type { ImageBlock } from '../../model/image-block';
import type { PageModel } from '../../model/page-model';

// ---------------------------------------------------------------------------
// PageRenderer
// ---------------------------------------------------------------------------

export class PageRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private scale: number = 1.5;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('PageRenderer: failed to acquire 2D rendering context');
    }
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Render a complete page. */
  render(page: PageModel): void {
    this.canvas.width  = page.width  * this.scale;
    this.canvas.height = page.height * this.scale;

    // White background
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.renderImageBlocks(page.imageBlocks);
    this.renderTextBlocks(page.textBlocks);
  }

  /** Clear the canvas and re-render the given page. */
  refresh(page: PageModel): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.render(page);
  }

  /**
   * Draw a dashed blue selection rectangle around the bounding box of a block.
   * Call this after render() so the highlight sits on top of the content.
   */
  renderSelection(block: TextBlock | ImageBlock): void {
    const bb = block.boundingBox;
    this.ctx.save();
    this.ctx.strokeStyle = '#1a73e8';
    this.ctx.lineWidth   = 1.5;
    this.ctx.setLineDash([4, 3]);
    this.ctx.strokeRect(bb.x, bb.y, bb.width, bb.height);
    this.ctx.restore();
  }

  /** Set the zoom / device-pixel scale factor. */
  setScale(scale: number): void {
    this.scale = scale;
  }

  /** Return the current zoom scale. */
  getScale(): number {
    return this.scale;
  }

  /** Return the current canvas pixel dimensions. */
  getCanvasSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  // ---------------------------------------------------------------------------
  // Private rendering helpers
  // ---------------------------------------------------------------------------

  private renderTextBlocks(blocks: TextBlock[]): void {
    for (const block of blocks) {
      this.renderTextBlock(block);
    }
  }

  private renderTextBlock(block: TextBlock): void {
    for (const ch of block.chars) {
      this.renderTextChar(ch);
    }
  }

  private renderTextChar(ch: TextChar): void {
    const [r, g, b] = ch.color;
    const r255 = Math.round(r * 255);
    const g255 = Math.round(g * 255);
    const b255 = Math.round(b * 255);

    this.ctx.save();
    this.ctx.font      = `${ch.fontSize * this.scale}px sans-serif`;
    this.ctx.fillStyle = `rgb(${r255},${g255},${b255})`;
    this.ctx.fillText(ch.char, ch.x, ch.y);
    this.ctx.restore();
  }

  /**
   * Render image blocks as light-gray placeholder rectangles.
   * A full image-decoding pipeline would draw actual pixels here.
   */
  private renderImageBlocks(blocks: ImageBlock[]): void {
    for (const block of blocks) {
      const bb = block.boundingBox;
      this.ctx.save();
      this.ctx.fillStyle   = '#e8e8e8';
      this.ctx.strokeStyle = '#aaaaaa';
      this.ctx.lineWidth   = 1;
      this.ctx.fillRect(bb.x, bb.y, bb.width, bb.height);
      this.ctx.strokeRect(bb.x, bb.y, bb.width, bb.height);
      this.ctx.restore();
    }
  }
}

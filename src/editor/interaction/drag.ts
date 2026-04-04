/**
 * L4 Editor Layer — DragManager
 *
 * Tracks a pointer-drag gesture for repositioning an ImageBlock.
 *
 * Usage:
 *   onPointerDown → startDrag(block, x, y, onUpdate)
 *   onPointerMove → updateDrag(x, y)          ← calls onUpdate each move
 *   onPointerUp   → const moved = endDrag()   ← returns final ImageBlock
 */

import type { ImageBlock } from '../../model/image-block';
import type { Rect } from '../../model/text-block';

// ---------------------------------------------------------------------------
// DragState
// ---------------------------------------------------------------------------

export interface DragState {
  isDragging: boolean;
  block: ImageBlock | null;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

// ---------------------------------------------------------------------------
// DragManager
// ---------------------------------------------------------------------------

export class DragManager {
  private state: DragState = {
    isDragging: false,
    block: null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
  };

  private onUpdate: ((block: ImageBlock) => void) | null = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Begin a drag on `block`.  `canvasX`/`canvasY` are the pointer coordinates
   * at the moment of the pointer-down event.  `onUpdate` is called on every
   * subsequent updateDrag() call with a mutated copy of the block reflecting
   * the new position.
   */
  startDrag(
    block: ImageBlock,
    canvasX: number,
    canvasY: number,
    onUpdate: (block: ImageBlock) => void,
  ): void {
    this.state = {
      isDragging: true,
      block,
      startX: canvasX,
      startY: canvasY,
      offsetX: canvasX - block.boundingBox.x,
      offsetY: canvasY - block.boundingBox.y,
    };
    this.onUpdate = onUpdate;
  }

  /**
   * Update the drag position.  Computes a new position for the block based on
   * the pointer's current canvas coordinates and calls onUpdate.
   * No-op if no drag is in progress.
   */
  updateDrag(canvasX: number, canvasY: number): void {
    if (!this.state.isDragging || this.state.block === null || this.onUpdate === null) {
      return;
    }

    const newX = canvasX - this.state.offsetX;
    const newY = canvasY - this.state.offsetY;

    const original = this.state.block;
    const newBoundingBox: Rect = {
      x: newX,
      y: newY,
      width: original.boundingBox.width,
      height: original.boundingBox.height,
    };

    const updated: ImageBlock = {
      ...original,
      boundingBox: newBoundingBox,
      modified: true,
    };

    this.onUpdate(updated);
  }

  /**
   * End the drag.  Returns the final updated ImageBlock if a drag was in
   * progress, or null if no drag was active.  Resets internal state.
   */
  endDrag(): ImageBlock | null {
    if (!this.state.isDragging || this.state.block === null) {
      this.reset();
      return null;
    }

    const finalBlock = this.state.block;
    this.reset();
    return finalBlock;
  }

  /** Return true if a drag is currently in progress. */
  isDragging(): boolean {
    return this.state.isDragging;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private reset(): void {
    this.state = {
      isDragging: false,
      block: null,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
    };
    this.onUpdate = null;
  }
}

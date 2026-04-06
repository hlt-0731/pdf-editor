/**
 * L4 Editor Layer — SelectionManager
 *
 * Tracks which content block(s) (text or image) are currently selected and
 * notifies subscribers whenever the selection changes.
 *
 * Supports both single selection (click) and multi-selection (Shift+click)
 * of text blocks.  Multi-selection is used for the block merge workflow.
 *
 * The listener pattern keeps the manager decoupled from any specific UI
 * framework; React state, DOM mutation, or canvas re-render can all subscribe
 * via onSelectionChange().
 */

import type { TextBlock } from '../../model/text-block';
import type { ImageBlock } from '../../model/image-block';

// ---------------------------------------------------------------------------
// Selection type
// ---------------------------------------------------------------------------

export type Selection =
  | { type: 'none' }
  | { type: 'text';  block: TextBlock  }
  | { type: 'image'; block: ImageBlock }
  | { type: 'multi'; blocks: TextBlock[] };

// ---------------------------------------------------------------------------
// SelectionManager
// ---------------------------------------------------------------------------

export class SelectionManager {
  private selection: Selection = { type: 'none' };
  private readonly listeners: Array<(sel: Selection) => void> = [];

  // ---------------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------------

  /** Set the current selection and notify all listeners. */
  select(selection: Selection): void {
    this.selection = selection;
    this.notify();
  }

  /** Clear the current selection and notify all listeners. */
  deselect(): void {
    this.selection = { type: 'none' };
    this.notify();
  }

  /**
   * Toggle a text block in the multi-selection.
   *
   * - If nothing is selected, start a new single selection.
   * - If a single text block is selected, promote to multi and add the new block.
   * - If already multi, toggle the block (add if absent, remove if present).
   * - If only one block remains after removal, demote to single selection.
   */
  toggleMulti(block: TextBlock): void {
    if (this.selection.type === 'none') {
      this.selection = { type: 'text', block };
    } else if (this.selection.type === 'text') {
      if (this.selection.block.id === block.id) {
        // Deselect
        this.selection = { type: 'none' };
      } else {
        // Promote to multi
        this.selection = { type: 'multi', blocks: [this.selection.block, block] };
      }
    } else if (this.selection.type === 'multi') {
      const idx = this.selection.blocks.findIndex(b => b.id === block.id);
      if (idx !== -1) {
        // Remove from multi
        const remaining = this.selection.blocks.filter((_, i) => i !== idx);
        if (remaining.length <= 1) {
          this.selection = remaining.length === 1
            ? { type: 'text', block: remaining[0]! }
            : { type: 'none' };
        } else {
          this.selection = { type: 'multi', blocks: remaining };
        }
      } else {
        // Add to multi
        this.selection = { type: 'multi', blocks: [...this.selection.blocks, block] };
      }
    } else {
      // Image selection — start fresh with text
      this.selection = { type: 'text', block };
    }

    this.notify();
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Return the current selection (never undefined). */
  getSelection(): Selection {
    return this.selection;
  }

  /** Return all selected text blocks (works for single, multi, or none). */
  getSelectedTextBlocks(): TextBlock[] {
    if (this.selection.type === 'text') return [this.selection.block];
    if (this.selection.type === 'multi') return this.selection.blocks;
    return [];
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  /**
   * Register a listener that is called with the new Selection whenever it
   * changes.  Returns an unsubscribe function that removes the listener.
   */
  onSelectionChange(listener: (sel: Selection) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private notify(): void {
    const sel = this.selection;
    for (const listener of this.listeners) {
      listener(sel);
    }
  }
}

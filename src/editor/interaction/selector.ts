/**
 * L4 Editor Layer — SelectionManager
 *
 * Tracks which content block (text or image) is currently selected and
 * notifies subscribers whenever the selection changes.
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
  | { type: 'image'; block: ImageBlock };

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

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Return the current selection (never undefined). */
  getSelection(): Selection {
    return this.selection;
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

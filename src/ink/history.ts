// A note's undo history: a stack of operations that each know how to reverse and repeat
// themselves. Unlimited while the note is open; the view clears it when the note closes or
// another note is loaded. Free of the DOM: operations are closures over the store and view.

/** One undoable edit. `undo` reverses it; `redo` repeats it after an undo. */
export interface Op {
  /** What the edit was, e.g. "Add stroke" (for menus and debugging). */
  label: string;
  undo(): void;
  redo(): void;
}

export class History {
  private done: Op[] = [];
  private undone: Op[] = [];

  /** `changed` is called after every push, undo, redo and clear (to update buttons). */
  constructor(private changed: () => void = () => {}) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** The labels of the edits that can be undone, oldest first. */
  get labels(): string[] {
    return this.done.map(op => op.label);
  }

  /** Records an edit that has already been made. Clears what could be redone. */
  push(op: Op) {
    this.done.push(op);
    this.undone.length = 0;
    this.changed();
  }

  /**
   * Reverses the latest edit and returns it, or null if there's none. If its `undo` throws,
   * the edit is dropped from the history and the error is rethrown.
   */
  undo(): Op | null {
    const op = this.done.pop();
    if (!op) return null;
    try {
      op.undo();
      this.undone.push(op);
    } finally {
      this.changed();
    }
    return op;
  }

  /** Repeats the latest undone edit and returns it, or null if there's none. */
  redo(): Op | null {
    const op = this.undone.pop();
    if (!op) return null;
    try {
      op.redo();
      this.done.push(op);
    } finally {
      this.changed();
    }
    return op;
  }

  /** Forgets everything. */
  clear() {
    const had = this.canUndo || this.canRedo;
    this.done.length = 0;
    this.undone.length = 0;
    if (had) this.changed();
  }
}

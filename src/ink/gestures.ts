// Multi-finger taps: two fingers tapped together undo, three redo (as in Notability). A tap is
// fingers that land and lift within TAP_MS without any of them moving more than TAP_SLOP px;
// anything else (a two-finger scroll or pinch) is left alone. The listeners are passive and
// never call preventDefault, so native scrolling is untouched. Kept separate from the view so
// the gesture work in #9 can reuse or replace it.

/** The longest a tap may take, from the first finger down to the last finger up, in ms. */
export const TAP_MS = 300;
/** How far a finger may move during a tap, in CSS px. */
export const TAP_SLOP = 10;

/** The parts of a Touch this uses (Safari adds touchType; Chromium doesn't have it). */
export interface TouchLike {
  identifier: number;
  clientX: number;
  clientY: number;
  touchType?: string;
}

/** The parts of a TouchEvent this uses. */
export interface TouchEventLike {
  type: string;
  touches: ArrayLike<TouchLike>;
  changedTouches: ArrayLike<TouchLike>;
  timeStamp: number;
}

interface Gesture {
  start: number;
  /** Where each finger landed. */
  at: Map<number, { x: number; y: number }>;
  /** The most fingers down at once. */
  fingers: number;
  /** Set once the gesture can't be a tap (moved, too slow, a stylus, cancelled). */
  spoiled: boolean;
}

/**
 * Follows touch events and calls `tap(fingers)` when a tap with two or more fingers ends.
 * Feed it touchstart, touchmove, touchend and touchcancel.
 */
export class FingerTaps {
  private g: Gesture | null = null;

  constructor(private tap: (fingers: number) => void) {}

  handle(e: TouchEventLike) {
    const touches = Array.from(e.touches), changed = Array.from(e.changedTouches);
    if (e.type === 'touchstart') {
      // Every finger down is new: a fresh gesture (also recovers from a lost touchend).
      if (!this.g || touches.length === changed.length) this.g = { start: e.timeStamp, at: new Map(), fingers: 0, spoiled: false };
      const g = this.g;
      for (const t of changed) g.at.set(t.identifier, { x: t.clientX, y: t.clientY });
      g.fingers = Math.max(g.fingers, touches.length, g.at.size);
      if ([...touches, ...changed].some(t => t.touchType === 'stylus')) g.spoiled = true;
      return;
    }
    const g = this.g;
    if (!g) return;
    if (e.type === 'touchcancel') g.spoiled = true;
    for (const t of changed) {
      const p = g.at.get(t.identifier);
      if (p && Math.hypot(t.clientX - p.x, t.clientY - p.y) > TAP_SLOP) g.spoiled = true;
    }
    if (e.timeStamp - g.start > TAP_MS) g.spoiled = true;
    if ((e.type === 'touchend' || e.type === 'touchcancel') && touches.length === 0) {
      this.g = null;
      if (!g.spoiled && g.fingers >= 2) this.tap(g.fingers);
    }
  }

  /** Forgets a gesture in progress. */
  reset() {
    this.g = null;
  }
}

type Register = (type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', fn: (e: TouchEvent) => void,
  options: AddEventListenerOptions) => void;

/**
 * Listens for two- and three-finger taps through `register` (the view's registerDomEvent on
 * its pages container): two fingers call `undo`, three call `redo`.
 */
export function listenForUndoTaps(register: Register, undo: () => void, redo: () => void): FingerTaps {
  const taps = new FingerTaps(fingers => {
    if (fingers === 2) undo();
    else if (fingers === 3) redo();
  });
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
    register(type, e => taps.handle(e as unknown as TouchEventLike), { passive: true });
  }
  return taps;
}

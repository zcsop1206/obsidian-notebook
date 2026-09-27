// Pencil taps on controls (#53): which touch events the pages scroller's blockers prevent. The
// blockers are pure functions of the event; here the events are plain objects standing in for
// TouchEvents (no DOM in the unit tests). The view test (section 29) checks the same rules on
// the real elements, and that the blockers only listen on the scroller.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockFingerTouch, blockStylusTouch } from '../../src/ink/input';

/** The selector blockStylusTouch treats as a control (input.ts CONTROLS). */
const CONTROL = /^(button|select|input|textarea|a)$|\.nb-ink-control\b/;

/** An element stand-in: a tag, classes and a parent; `closest` matches tag names and `.class`. */
class El {
  constructor(readonly tag: string, readonly cls: string[] = [], readonly parent: El | null = null) {}
  matches(sel: string): boolean {
    return sel.split(',').map(s => s.trim()).some(s => s.startsWith('.') ? this.cls.includes(s.slice(1)) : s === this.tag);
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
  contains(other: El): boolean {
    for (let e: El | null = other; e; e = e.parent) if (e === this) return true;
    return false;
  }
}

interface FakeTouch {
  type: string;
  target: El;
  changedTouches: { touchType?: string }[];
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function touch(type: 'touchstart' | 'touchmove', target: El, touchType: 'stylus' | 'direct'): FakeTouch {
  return {
    type, target, changedTouches: [{ touchType }], prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

const stylus = (e: FakeTouch) => blockStylusTouch(e as unknown as TouchEvent);
const finger = (e: FakeTouch, area: El) => blockFingerTouch(e as unknown as TouchEvent, area as unknown as Element);

// What the pages scroller holds (view.ts onOpen, ruler-overlay.ts).
const scroller = new El('div', ['nb-ink-scroll']);
const pagesEl = new El('div', ['nb-ink-pages'], scroller);
const page = new El('div', ['nb-ink-page'], pagesEl);
const ghost = new El('div', ['nb-ink-ghost'], pagesEl);
const rulerLayer = new El('div', ['nb-ink-ruler-layer'], page);
const rulerBar = new El('div', ['nb-ink-ruler-bar'], rulerLayer);
const rulerLabel = new El('button', ['nb-ink-control', 'nb-ink-ruler-angle'], rulerLayer);
const rulerInput = new El('input', ['nb-ink-control', 'nb-ink-ruler-input'], rulerLayer);
const footer = new El('div', ['nb-ink-footer'], pagesEl);
const addPage = new El('button', ['nb-ink-add'], footer);
const addWith = new El('button', ['nb-ink-add-with'], footer);

test('controls: the test stand-in matches the control selector as input.ts has it', () => {
  for (const el of [rulerLabel, rulerInput, addPage, new El('select'), new El('textarea'), new El('a'), new El('div', ['nb-ink-control'])]) {
    assert.ok(el.closest('button, select, input, textarea, a, .nb-ink-control'), el.tag);
    assert.ok(CONTROL.test(el.tag) || el.cls.some(c => CONTROL.test('.' + c)), el.tag);
  }
});

test('controls: a Pencil touchstart or touchmove on the pages, the gaps or the ruler bar is prevented and stopped', () => {
  for (const el of [page, ghost, pagesEl, scroller, rulerBar]) {
    for (const type of ['touchstart', 'touchmove'] as const) {
      const e = touch(type, el, 'stylus');
      assert.equal(stylus(e), true, `${type} on ${el.cls[0]}`);
      assert.ok(e.prevented && e.stopped, `${type} on ${el.cls[0]}`);
    }
  }
});

test('controls: a Pencil touchstart and touchmove on a control in the scroller are left alone (tap, focus, select text)', () => {
  for (const el of [rulerLabel, rulerInput, addPage, addWith]) {
    for (const type of ['touchstart', 'touchmove'] as const) {
      const e = touch(type, el, 'stylus');
      assert.equal(stylus(e), false, `${type} on ${el.cls.join('.')}`);
      assert.ok(!e.prevented && !e.stopped, `${type} on ${el.cls.join('.')}`);
    }
  }
  // Inside a control too (an icon's svg in a button).
  const icon = new El('svg', [], addPage);
  assert.equal(stylus(touch('touchstart', icon, 'stylus')), false);
});

test('controls: a Pencil touch on any marked control is left alone wherever it is (the window blocker during a stroke)', () => {
  const panel = new El('div', ['nb-ink-control', 'nb-pages-panel']);
  const thumb = new El('div', ['nb-ink-control', 'nb-pages-thumb'], new El('div', ['nb-pages-list'], panel));
  const frame = new El('div', ['nb-pages-frame'], thumb);
  const picker = new El('div', ['nb-ink-control', 'nb-ink-picker']);
  for (const el of [thumb, frame, picker, new El('span', ['nb-ink-control'], picker)]) {
    for (const type of ['touchstart', 'touchmove'] as const) assert.equal(stylus(touch(type, el, 'stylus')), false, `${type} on ${el.tag}`);
  }
  // An unmarked element outside the view is still blocked by the window listener mid-stroke.
  assert.equal(stylus(touch('touchmove', new El('div', ['workspace-leaf']), 'stylus')), true);
});

test('controls: fingers are never blocked by the stylus rule; finger touchmoves over the pages are (navigation)', () => {
  const g = globalThis as { Node?: unknown };
  const had = 'Node' in g, old = g.Node;
  g.Node = El;  // blockFingerTouch checks `instanceof Node`
  try {
    for (const el of [page, addPage, rulerInput]) {
      assert.equal(stylus(touch('touchstart', el, 'direct')), false);
      assert.equal(stylus(touch('touchmove', el, 'direct')), false);
      assert.equal(finger(touch('touchstart', el, 'direct'), scroller), false, 'a finger touchstart: taps still click');
      const e = touch('touchmove', el, 'direct');
      assert.equal(finger(e, scroller), true, 'a finger touchmove in the scroller: the navigator pans');
      assert.ok(e.prevented && e.stopped);
    }
    assert.equal(finger(touch('touchmove', page, 'stylus'), scroller), false, 'the Pencil is the stylus rule\'s');
    assert.equal(finger(touch('touchmove', new El('div'), 'direct'), scroller), false, 'outside the scroller');
  } finally {
    if (had) g.Node = old;
    else delete g.Node;
  }
});

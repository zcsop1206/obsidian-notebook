// Finger navigation (#9): one- or two-finger panning with momentum, pinch zoom, Ctrl/Cmd+wheel
// zoom, and the frame times of these gestures.
//
// The scroll container (`.nb-ink-scroll`) stays the source of truth for the scroll position,
// but fingers don't scroll it natively: it has `touch-action: none` (which also keeps Obsidian's
// sidebar swipes out), and Navigator moves it from finger pointer events (`pointerType`
// 'touch', at most two). The Pencil and the mouse are other pointers, handled by PenInput, so a
// finger gesture and a pen stroke never interrupt each other. Mouse wheels and trackpads keep
// scrolling natively.
//
// A gesture starts once a finger has moved more than NAV_SLOP px from where it landed (so a
// two-finger tap, gestures.ts, never scrolls). From then on the scroll position follows the
// fingers' centroid. With two fingers, a pinch starts once their distance has changed by more
// than NAV_SLOP px:
// the zoom is the view's zoom times the ratio of the distance now to the distance then,
// clamped to 50-400%. While pinching, the pages layer gets `transform: scale(k)` around the
// content point that was under the centroid when the pinch started, so the existing bitmaps
// are scaled with no re-render; the centroid keeps panning through the scroll position. When
// the pinch ends (a finger lifts), the host commits the zoom: lays out again at the new zoom,
// drops the transform, scrolls so that the same page point is where it was on screen, and
// redraws the visible pages sharp.
//
// On release, the scroll keeps going (momentum) at the fingers' velocity over the last
// VELOCITY_MS, slowing by DECAY_PER_MS each ms (as iOS scroll views do) until it is under
// 0.1 px per frame or hits an edge; a new touch stops it.
//
// Ctrl/Cmd+wheel (and a trackpad pinch on desktop, which arrives as one) previews the same way
// around the cursor and commits WHEEL_COMMIT_MS after the last wheel event. The gesture's work
// happens once per animation frame; the time between those frames, from the start of a pan to
// the end of its momentum, is kept in NavStats for the stats overlay and the debug view. The
// pure parts (zoom steps, momentum, the pinch anchor) are exported for unit tests.
import { fmt, median } from '../debug/util';
import { TAP_SLOP } from './gestures';
import { pageAtY, type Layout } from './layout';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** The zoom commands' step. */
export const ZOOM_STEP = 0.25;
/**
 * A pan starts once a finger has moved more than this from where it landed, and a pinch once
 * the fingers' distance has changed by more than this, in px. The same as TAP_SLOP, so a tap
 * never moves the view.
 */
export const NAV_SLOP = TAP_SLOP;
/** Release velocity is measured over this many ms before the last finger lifts. */
export const VELOCITY_MS = 100;
/** Momentum keeps this fraction of its speed per ms (UIScrollView's normal deceleration). */
export const DECAY_PER_MS = 0.998;
export const FRAME_MS = 1000 / 60;
/** Momentum stops under 0.1 px per frame, in px per ms. */
export const STOP_SPEED = 0.1 / FRAME_MS;
/** Frames longer than this are counted as slow. */
export const SLOW_FRAME_MS = 32;
/** A Ctrl/Cmd+wheel zoom is committed this long after the last wheel event, in ms. */
export const WHEEL_COMMIT_MS = 150;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The next zoom step (multiples of 25%) above (`dir` 1) or below (-1) `zoom`, clamped. */
export function zoomStep(zoom: number, dir: 1 | -1): number {
  const n = zoom / ZOOM_STEP;
  const next = dir > 0 ? Math.floor(n + 1e-6) + 1 : Math.ceil(n - 1e-6) - 1;
  return clampZoom(next * ZOOM_STEP);
}

// ---- momentum (pure)

export interface Vec {
  x: number;
  y: number;
}

/** A finger position sample: the fingers' total movement so far at time t (ms). */
export interface PanSample extends Vec {
  t: number;
}

/**
 * The fingers' velocity at release in px per ms: the movement between the last sample and the
 * first one within VELOCITY_MS of it, over the time between them. Zero with fewer than two
 * samples in that window.
 */
export function releaseVelocity(samples: readonly PanSample[]): Vec {
  const last = samples[samples.length - 1];
  if (!last) return { x: 0, y: 0 };
  let first = last;
  for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= VELOCITY_MS; i--) first = samples[i];
  const dt = last.t - first.t;
  return dt > 0 ? { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt } : { x: 0, y: 0 };
}

/**
 * Advances momentum at velocity `v` (px per ms) by `dt` ms of exponential decay: returns the
 * distance covered (the integral of the decaying speed) and the velocity after, which is zero
 * once the speed is under STOP_SPEED.
 */
export function momentumStep(v: Vec, dt: number): { dx: number; dy: number; v: Vec } {
  const r = Math.pow(DECAY_PER_MS, dt), k = (r - 1) / Math.log(DECAY_PER_MS);
  const next = { x: v.x * r, y: v.y * r };
  const stopped = Math.hypot(next.x, next.y) < STOP_SPEED;
  return { dx: v.x * k, dy: v.y * k, v: stopped ? { x: 0, y: 0 } : next };
}

// ---- the pinch (pure)

/**
 * A point relative to a page: its index and its offset from the page's top-left corner as a
 * fraction of the page's box (so it matches the page element, whose size is rounded to whole px).
 */
export interface Anchor {
  index: number;
  fx: number;
  fy: number;
}

/**
 * The page point at (x, y) of the pages layer: on the page at or above y (the point may be
 * outside the page, in a margin or gap). Null if there are no pages.
 */
export function anchorAt(layout: Layout, x: number, y: number): Anchor | null {
  const index = pageAtY(layout, y);
  const box = layout.pages[index];
  if (!box) return null;
  return { index, fx: (x - box.left) / box.width, fy: (y - box.top) / box.height };
}

/** Where a page point is in the pages layer of `layout`. */
export function anchorPoint(layout: Layout, a: Anchor): Vec {
  const box = layout.pages[Math.min(a.index, layout.pages.length - 1)];
  return { x: box.left + a.fx * box.width, y: box.top + a.fy * box.height };
}

/** The scroll position that puts page point `a` of `layout` at (vx, vy) in the viewport. */
export function scrollToKeep(layout: Layout, a: Anchor, vx: number, vy: number): { left: number; top: number } {
  const p = anchorPoint(layout, a);
  return { left: p.x - vx, top: p.y - vy };
}

/** The preview scale of a pinch: `zoom` times d / d0, clamped to the zoom range, over `zoom`. */
export function pinchScale(zoom: number, d0: number, d: number): number {
  return d0 > 0 ? clampZoom(zoom * d / d0) / zoom : 1;
}

// ---- stats

export interface NavStats {
  /** The current zoom. */
  zoom: number;
  /** Finger gestures that moved the view. */
  gestures: number;
  /** Frames of the last gesture, momentum included. */
  frames: number;
  /** Time between those frames, median and worst, ms. The first is from the gesture's start. */
  medianMs: number;
  maxMs: number;
  /** Frames over SLOW_FRAME_MS, and which ones, as [index, ms]. */
  over32: number;
  slow: [number, number][];
  /** Pinches committed. */
  pinches: number;
  /** performance.now() of the last change. */
  at: number;
}

export const newNavStats = (): NavStats => ({
  zoom: 1, gestures: 0, frames: 0, medianMs: NaN, maxMs: NaN, over32: 0, slow: [], pinches: 0, at: 0,
});

/** The stats as text lines, for the ink view's overlay and the debug view. */
export function navStatsLines(s: NavStats): string[] {
  return [`zoom ${Math.round(s.zoom * 100)}%; last finger gesture: ${s.frames} frames, ${fmt(s.medianMs, 1)} ms median ` +
    `(max ${fmt(s.maxMs, 1)}), ${s.over32} over ${SLOW_FRAME_MS} ms; gestures ${s.gestures}, pinches ${s.pinches}`];
}

// ---- input

export interface NavHost {
  /** The current zoom. */
  zoom(): number;
  /**
   * Shows the pages layer scaled by `k` around (x, y) of the pages layer (untransformed), with
   * no relayout; k = 1 removes the transform.
   */
  preview(k: number, x: number, y: number): void;
  /**
   * Commits zoom `z`: lays out again, removes any preview, and scrolls so that the page point
   * at (x, y) of the pages layer (as laid out before) is at (vx, vy) in the viewport.
   */
  commit(z: number, x: number, y: number, vx: number, vy: number): void;
  /** The scroll position or the preview transform changed. */
  moved(): void;
  /** The navigation stats changed. */
  statsChanged(): void;
}

interface Finger {
  x: number;
  y: number;
  /** Where it landed. */
  x0: number;
  y0: number;
}

interface Pinch {
  /** Fingers' distance when the pinch started. */
  d0: number;
  /** The zoom then. */
  zoom: number;
  /** The pages-layer point the scale is around. */
  px: number;
  py: number;
  /** The current preview scale. */
  k: number;
}

type Listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => void;

export class Navigator {
  private fingers = new Map<number, Finger>();
  /** A pan is under way (a finger moved past the slop). */
  private panning = false;
  /** Scroll position and centroid (client px) the pan is measured from. */
  private base = { sx: 0, sy: 0, cx: 0, cy: 0, d: 0 };
  private pinch: Pinch | null = null;
  /** The fingers' total movement (centroid, without jumps when fingers come and go) and its samples. */
  private moved = { x: 0, y: 0 };
  private samples: PanSample[] = [];
  private momentum: { v: Vec; pos: Vec; last: number } | null = null;
  private frame = 0;
  /** The frame loop's last frame time, and the gesture's frame intervals. */
  private lastFrame = 0;
  private intervals: number[] = [];
  private wheel: { k: number; px: number; py: number; timer: number } | null = null;

  /** `listen` adds a listener on the scroll container (removed with the view). */
  constructor(private scroller: HTMLElement, private host: NavHost, listen: Listen, readonly stats: NavStats = newNavStats()) {
    listen('pointerdown', e => this.down(e));
    listen('pointermove', e => this.move(e));
    listen('pointerup', e => this.up(e, false));
    listen('pointercancel', e => this.up(e, true));
    listen('wheel', e => this.onWheel(e), { passive: false });
  }

  /** Whether a finger gesture or its momentum is moving the view. */
  get active(): boolean {
    return this.panning || this.momentum !== null;
  }

  /** Whether the pages layer has a zoom preview transform (a pinch or wheel zoom not yet committed). */
  get previewing(): boolean {
    return this.pinch !== null || this.wheel !== null;
  }

  /** The viewport point (px from the scroller's visible top-left) of a client point. */
  private viewport(x: number, y: number): Vec {
    const r = this.scroller.getBoundingClientRect();
    return { x: x - r.left - this.scroller.clientLeft, y: y - r.top - this.scroller.clientTop };
  }

  private centroid(): { x: number; y: number; d: number } {
    const f = [...this.fingers.values()];
    if (f.length === 1) return { x: f[0].x, y: f[0].y, d: 0 };
    return { x: (f[0].x + f[1].x) / 2, y: (f[0].y + f[1].y) / 2, d: Math.hypot(f[0].x - f[1].x, f[0].y - f[1].y) };
  }

  /** Measures the pan from here: the current scroll position and fingers. */
  private rebase() {
    const c = this.centroid();
    this.base = { sx: this.scroller.scrollLeft, sy: this.scroller.scrollTop, cx: c.x, cy: c.y, d: c.d };
  }

  private down(e: PointerEvent) {
    if (e.pointerType !== 'touch') return;
    this.stopMomentum();
    // The primary pointer is the first finger of a new touch: any finger still listed lost its
    // pointerup (say its target left the document), so start afresh.
    if (e.isPrimary && this.fingers.size) this.forget();
    if (this.fingers.size >= 2 || this.fingers.has(e.pointerId)) return;
    this.commitWheel();
    if (!this.fingers.size) {
      this.panning = false;
      this.moved = { x: 0, y: 0 };
      this.samples = [];
    }
    this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (this.pinch) this.endPinch();
    this.rebase();
  }

  private move(e: PointerEvent) {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    const n = this.fingers.size;
    this.moved.x += (e.clientX - f.x) / n;
    this.moved.y += (e.clientY - f.y) / n;
    f.x = e.clientX;
    f.y = e.clientY;
    this.samples.push({ t: e.timeStamp, x: this.moved.x, y: this.moved.y });
    if (this.samples.length > 64) this.samples.splice(0, 32);
    if (!this.panning && Math.hypot(f.x - f.x0, f.y - f.y0) > NAV_SLOP) {
      this.panning = true;
      this.rebase();
      this.intervals = [];
      this.lastFrame = performance.now();
      this.stats.gestures++;
    }
    if (this.panning) this.schedule();
  }

  private up(e: PointerEvent, cancelled: boolean) {
    if (!this.fingers.delete(e.pointerId)) return;
    if (this.pinch) this.endPinch();
    if (this.fingers.size) {
      this.rebase();
      return;
    }
    if (!this.panning) return;
    this.panning = false;
    const v = cancelled ? { x: 0, y: 0 } : releaseVelocity(this.samples);
    this.samples = [];
    if (Math.hypot(v.x, v.y) >= STOP_SPEED) {
      // The scroll moves against the fingers.
      this.momentum = { v: { x: -v.x, y: -v.y }, pos: { x: this.scroller.scrollLeft, y: this.scroller.scrollTop }, last: performance.now() };
      this.schedule();
    } else this.finish();
  }

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.tick());
  }

  /** One frame of a gesture or its momentum; keeps the loop going while either lasts. */
  private tick() {
    this.frame = 0;
    if (!this.active) return;
    const t = performance.now();
    this.intervals.push(t - this.lastFrame);
    this.lastFrame = t;
    if (this.panning) this.applyFingers();
    else if (this.momentum) this.applyMomentum(t);
    if (this.active) this.schedule();
    else this.finish();
  }

  /** Scrolls (and scales, when pinching) to follow the fingers. */
  private applyFingers() {
    const sc = this.scroller, c = this.centroid(), b = this.base;
    if (this.fingers.size === 2 && !this.pinch && Math.abs(c.d - b.d) > NAV_SLOP) {
      // The pinch starts: measure the pan from here, and scale around the point under the centroid.
      this.rebase();
      const v = this.viewport(c.x, c.y);
      this.pinch = { d0: c.d, zoom: this.host.zoom(), px: sc.scrollLeft + v.x, py: sc.scrollTop + v.y, k: 1 };
    }
    const p = this.pinch;
    if (p) {
      const k = pinchScale(p.zoom, p.d0, c.d);
      if (k !== p.k) {
        p.k = k;
        this.host.preview(k, p.px, p.py);
      }
    }
    // Whole px: browsers may truncate a fractional scroll position.
    const x = Math.round(b.sx - (c.x - b.cx)), y = Math.round(b.sy - (c.y - b.cy));
    sc.scrollLeft = x;
    sc.scrollTop = y;
    // At an edge, measure from here, so turning back moves at once (not while pinching, which
    // needs the point under the centroid to stay the one it started with).
    if (!p && (Math.abs(sc.scrollLeft - x) > 1 || Math.abs(sc.scrollTop - y) > 1)) this.rebase();
    this.host.moved();
  }

  private applyMomentum(t: number) {
    const m = this.momentum!, sc = this.scroller;
    const step = momentumStep(m.v, t - m.last);
    m.last = t;
    m.pos.x += step.dx;
    m.pos.y += step.dy;
    sc.scrollLeft = Math.round(m.pos.x);
    sc.scrollTop = Math.round(m.pos.y);
    m.v = step.v;
    // Stop along an axis at its edge.
    if (Math.abs(sc.scrollLeft - m.pos.x) > 1) {
      m.v.x = 0;
      m.pos.x = sc.scrollLeft;
    }
    if (Math.abs(sc.scrollTop - m.pos.y) > 1) {
      m.v.y = 0;
      m.pos.y = sc.scrollTop;
    }
    this.host.moved();
    if (!m.v.x && !m.v.y) this.momentum = null;
  }

  /** Commits the pinch in progress (a finger lifted or landed). */
  private endPinch() {
    const p = this.pinch!;
    this.pinch = null;
    const sc = this.scroller;
    // The scale is around (px, py), which is therefore where it was in the layer: keep it where
    // it is on screen. (Also when the scale came back to 1, so the pages skipped meanwhile get drawn.)
    this.host.commit(p.zoom * p.k, p.px, p.py, p.px - sc.scrollLeft, p.py - sc.scrollTop);
    if (p.k !== 1) this.stats.pinches++;
    this.samples = []; // the scroll jumped: no momentum from before
    this.stats.zoom = this.host.zoom();
    this.stats.at = performance.now();
    this.host.statsChanged();
  }

  /** Ends the gesture's frame loop and records its frames. */
  private finish() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const iv = this.intervals, s = this.stats;
    if (iv.length) {
      s.frames = iv.length;
      s.medianMs = median(iv);
      s.maxMs = Math.max(...iv);
      s.slow = iv.map((ms, i) => [i, ms] as [number, number]).filter(([, ms]) => ms > SLOW_FRAME_MS);
      s.over32 = s.slow.length;
    }
    this.intervals = [];
    s.zoom = this.host.zoom();
    s.at = performance.now();
    this.host.statsChanged();
  }

  /** Stops momentum (a new touch, a zoom). */
  stopMomentum() {
    if (!this.momentum) return;
    this.momentum = null;
    this.finish();
  }

  // ---- Ctrl/Cmd + wheel (and trackpad pinch on desktop, which arrives as ctrl+wheel)

  private onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey) || this.fingers.size) return;
    e.preventDefault();
    this.stopMomentum();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.scroller.clientHeight : 1;
    const factor = Math.exp(-e.deltaY * unit * 0.002);
    const zoom = this.host.zoom();
    let w = this.wheel;
    if (!w) {
      const v = this.viewport(e.clientX, e.clientY);
      w = this.wheel = { k: 1, px: this.scroller.scrollLeft + v.x, py: this.scroller.scrollTop + v.y, timer: 0 };
    }
    w.k = clampZoom(zoom * w.k * factor) / zoom;
    this.host.preview(w.k, w.px, w.py);
    this.host.moved();
    window.clearTimeout(w.timer);
    w.timer = window.setTimeout(() => this.commitWheel(), WHEEL_COMMIT_MS);
  }

  /** Commits a wheel zoom in progress. */
  commitWheel() {
    const w = this.wheel;
    if (!w) return;
    this.wheel = null;
    window.clearTimeout(w.timer);
    const sc = this.scroller;
    this.host.commit(this.host.zoom() * w.k, w.px, w.py, w.px - sc.scrollLeft, w.py - sc.scrollTop);
    this.stats.zoom = this.host.zoom();
    this.stats.at = performance.now();
    this.host.statsChanged();
  }

  /** Forgets the fingers of a gesture whose end was lost, committing any pinch. */
  private forget() {
    this.fingers.clear();
    if (this.pinch) this.endPinch();
    if (this.panning) {
      this.panning = false;
      this.finish();
    }
  }

  /** Forgets any gesture (the note closed); a preview is dropped, not committed. */
  reset() {
    this.fingers.clear();
    this.panning = false;
    this.pinch = null;
    if (this.wheel) window.clearTimeout(this.wheel.timer);
    this.wheel = null;
    this.momentum = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.intervals = [];
    this.samples = [];
  }
}

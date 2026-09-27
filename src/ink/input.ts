// The pen (#5): Pencil and mouse input on the ink view's pages, the stroke in progress, and
// input measurements.
//
// Who draws: pen and mouse (button 0) pointers that go down on a page. Touches never draw
// (palm rejection); pen hover is ignored. The pointer is captured, so a stroke continues when
// it runs off the page's edge.
//
// Sampling: every coalesced sample of each pointermove (about 4 per event on the iPad), in
// page px, rounded as the file stores them, so the live stroke and the saved one are computed
// from the same numbers. WebKit's coalesced lists repeat earlier samples (half of all samples
// in the owner's spike page were repeats, some with earlier timestamps), which would make the
// line double back on itself; samples older than the last one taken are dropped, as are those
// within MIN_STEP of it. Predicted samples are kept apart as a tail and never stored.
//
// Drawing: the event handlers only record samples; drawing happens at most once per animation
// frame. The stroke in progress is the same perfect-freehand outline as the saved page
// (strokePath in format/outline.ts with the stroke's options), filled through Path2D on two
// overlay canvases over the page: the tail canvas is cleared and redrawn every frame with the
// outline of the latest points plus the predicted tail; once more than LIVE_MAX points are
// live, the older ones are drawn once onto the head canvas and dropped from the tail (keeping
// LIVE_KEEP, with OVERLAP points shared so the pieces join inside the line). Per-frame work is
// therefore bounded by LIVE_MAX + OVERLAP points however long the stroke. On release the
// stroke goes to the host, which draws its exact outline into the page bitmap, and both
// overlays are cleared.
import { strokePath } from '../format/outline';
import { roundP, roundXY, type PenStroke, type Point, type Size } from '../format/page';
import { fmt, median, yn } from '../debug/util';
import type { PenSettings } from './pen';
import { pixelRatio } from './renderer';

/** Samples closer than this (page px) to the previous one are dropped. */
export const MIN_STEP = 0.25;
/** More live (unfrozen) points than this and the older ones are frozen onto the head canvas. */
export const LIVE_MAX = 192;
/** Points kept live after freezing. */
export const LIVE_KEEP = 64;
/** Points shared by a frozen piece and the piece after it. */
export const OVERLAP = 16;

export interface PageTarget {
  /** Identifies the page to the host. */
  key: unknown;
  el: HTMLElement;
  size: Size;
}

/** A finished stroke, without its id. */
export type NewPenStroke = Omit<PenStroke, 'id'>;

export interface PenHost {
  /** The writable page an event landed on, or null. */
  pageAt(target: EventTarget | null): PageTarget | null;
  /** The pen settings for a stroke starting now. */
  pen(): Readonly<PenSettings>;
  /** The colour a stroke of this colour is drawn in (the default ink follows the theme). */
  drawColor(color: string): string;
  /** A finished stroke on a page. */
  commit(target: PageTarget, stroke: NewPenStroke): void;
  /** The pen stats changed (a stroke ended or a touch was ignored). */
  statsChanged(): void;
}

// ---- sampling (pure; tested with fake events)

/** The parts of a PointerEvent sampling reads. */
export interface Sample {
  clientX: number;
  clientY: number;
  pressure: number;
  pointerType: string;
  timeStamp: number;
}

export interface SampledEvent extends Sample {
  getCoalescedEvents?(): Sample[];
  getPredictedEvents?(): Sample[];
}

/** From client px to page px, and the stroke's start time. */
export interface PageMap {
  left: number;
  top: number;
  /** Page px per client px. */
  sx: number;
  sy: number;
  /** timeStamp of the first sample. */
  t0: number;
}

/** A stroke's real samples. */
export interface Trace {
  points: Point[];
  /** timeStamp of the last sample taken. */
  lastStamp: number;
  /** Samples seen, including dropped ones. */
  samples: number;
}

export const newTrace = (): Trace => ({ points: [], lastStamp: -Infinity, samples: 0 });

export function pageMap(rect: DOMRect, size: Size, t0: number): PageMap {
  return { left: rect.left, top: rect.top, sx: size.width / rect.width, sy: size.height / rect.height, t0 };
}

/** A sample in page px, rounded as the file stores it. The mouse has pressure 0.5. */
export function toPoint(s: Sample, m: PageMap): Point {
  const p = s.pointerType === 'mouse' ? 0.5 : Math.min(1, Math.max(0, s.pressure || 0));
  return {
    x: roundXY((s.clientX - m.left) * m.sx),
    y: roundXY((s.clientY - m.top) * m.sy),
    p: roundP(p),
    t: Math.max(0, Math.round(s.timeStamp - m.t0)),
  };
}

/** The event's real samples: its coalesced events when there are any, else itself. */
export function samplesOf(e: SampledEvent): Sample[] {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}

/**
 * Adds samples to the trace, dropping those older than the last one taken (WebKit repeats
 * earlier samples in later coalesced lists) and those within MIN_STEP of the last point.
 * Times never decrease.
 */
export function addSamples(trace: Trace, samples: readonly Sample[], m: PageMap) {
  const pts = trace.points;
  for (const s of samples) {
    trace.samples++;
    if (s.timeStamp < trace.lastStamp) continue;
    const pt = toPoint(s, m);
    const prev = pts[pts.length - 1];
    if (prev && Math.hypot(pt.x - prev.x, pt.y - prev.y) < MIN_STEP) continue;
    if (prev && pt.t < prev.t) pt.t = prev.t;
    trace.lastStamp = s.timeStamp;
    pts.push(pt);
  }
}

/** The event's predicted samples as points after the trace's last one (not stored). */
export function predictedPoints(trace: Trace, e: SampledEvent, m: PageMap): Point[] {
  const list = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
  const out: Point[] = [];
  let prev = trace.points[trace.points.length - 1];
  for (const s of list) {
    const pt = toPoint(s, m);
    if (prev && Math.hypot(pt.x - prev.x, pt.y - prev.y) < MIN_STEP) continue;
    if (prev && pt.t < prev.t) pt.t = prev.t;
    out.push(pt);
    prev = pt;
  }
  return out;
}

// ---- the frozen head (pure)

export interface LivePlan {
  /** Points to draw onto the head canvas now, as slice(start, end), or null. */
  freeze: [number, number] | null;
  /** Points before this index are frozen. */
  frozen: number;
  /** The tail drawn every frame is the points from here on. */
  tail: number;
}

/** Given `count` points of which the first `frozen` are frozen, what to freeze and redraw. */
export function livePlan(count: number, frozen: number): LivePlan {
  let freeze: [number, number] | null = null;
  if (count - frozen > LIVE_MAX) {
    const to = count - LIVE_KEEP;
    freeze = [Math.max(0, frozen - OVERLAP), to];
    frozen = to;
  }
  return { freeze, frozen, tail: Math.max(0, frozen - OVERLAP) };
}

// ---- measurements

/** One stroke's input measurements. */
export interface StrokeInputStats {
  pointerType: string;
  /** pointermove events handled. */
  events: number;
  /** Samples seen (coalesced ones included, dropped ones too). */
  samples: number;
  /** Points kept. */
  points: number;
  /** From the first to the last point, ms. */
  ms: number;
  eventsPerS: number;
  samplesPerS: number;
  /** Time spent in the pointermove handler (entry to exit), median and worst, ms. */
  handlerMs: number;
  handlerMaxMs: number;
  /** Live-drawing frames and their time, median and worst, ms. */
  frames: number;
  frameMs: number;
  frameMaxMs: number;
  /** Most predicted points in one event. */
  maxPredicted: number;
  /** Pieces frozen onto the head canvas. */
  frozen: number;
  cancelled: boolean;
}

export interface PenStats {
  /** Strokes ended (committed or cancelled). */
  strokes: number;
  /** Strokes ended by pointercancel (still kept). */
  cancelled: number;
  /** Touch pointers that went down and were ignored (palm rejection). */
  touchesIgnored: number;
  /** Whether getCoalescedEvents / getPredictedEvents exist (null before the first stroke). */
  coalesced: boolean | null;
  predicted: boolean | null;
  /** Most predicted points seen in one event. */
  maxPredicted: number;
  last: StrokeInputStats | null;
  /** The last 10 strokes long enough to measure (over 150 ms and 3 events). */
  recent: StrokeInputStats[];
  /** performance.now() of the last change. */
  at: number;
}

export const newPenStats = (): PenStats => ({
  strokes: 0, cancelled: 0, touchesIgnored: 0, coalesced: null, predicted: null, maxPredicted: 0, last: null, recent: [], at: 0,
});

/** Medians over the recent strokes. */
export function recentMedians(stats: PenStats) {
  const med = (k: 'eventsPerS' | 'samplesPerS' | 'handlerMs' | 'frameMs') => median(stats.recent.map(s => s[k]).filter(Number.isFinite));
  return { strokes: stats.recent.length, eventsPerS: med('eventsPerS'), samplesPerS: med('samplesPerS'), handlerMs: med('handlerMs'), frameMs: med('frameMs') };
}

/** The stats as text lines, for the ink view's overlay and the debug view. */
export function penStatsLines(stats: PenStats, pen?: Readonly<PenSettings>): string[] {
  const L = stats.last, r = recentMedians(stats);
  const lines: string[] = [];
  if (pen) lines.push(`pen: ${pen.nib}, ${pen.color}, ${pen.size} px`);
  lines.push(L
    ? `last stroke: ${L.pointerType}, ${L.points} points, ${fmt(L.eventsPerS)} events/s, ${fmt(L.samplesPerS)} samples/s, ` +
      `handler ${fmt(L.handlerMs, 2)} ms median (max ${fmt(L.handlerMaxMs, 2)}), frame ${fmt(L.frameMs, 2)} ms median (max ${fmt(L.frameMaxMs, 2)}, ${L.frames} frames), frozen pieces ${L.frozen}`
    : 'last stroke: none yet');
  lines.push(`last ${r.strokes} strokes (median): ${fmt(r.eventsPerS)} events/s, ${fmt(r.samplesPerS)} samples/s, handler ${fmt(r.handlerMs, 2)} ms, frame ${fmt(r.frameMs, 2)} ms`);
  lines.push(`coalesced ${yn(stats.coalesced)}, predicted ${yn(stats.predicted)} (up to ${stats.maxPredicted} ahead); strokes ${stats.strokes}, cancelled ${stats.cancelled}, touches ignored ${stats.touchesIgnored}`);
  return lines;
}

// ---- stylus touches

/** Elements a Pencil tap must still reach. */
const CONTROLS = 'button, select, input, textarea, a, .nb-ink-control';

/**
 * Keeps a Pencil drag anywhere in the ink view from scrolling it or opening Obsidian's sidebars
 * (on the iPad the Pencil also sends touch events, with touchType "stylus"). Rules, for
 * touchstart and touchmove listeners (passive: false) on the whole view:
 * - a touch event with no stylus touch (fingers) is left alone, so fingers scroll natively;
 * - a stylus touchstart on a control (button, select, input, textarea, a, .nb-ink-control) is
 *   left alone, so Pencil taps on "Add page" and the pen strip still click;
 * - any other stylus touchstart, and every stylus touchmove, is prevented and stopped.
 * Returns whether the event was prevented.
 */
export function blockStylusTouch(e: TouchEvent): boolean {
  const stylus = Array.from(e.changedTouches).some(t => (t as Touch & { touchType?: string }).touchType === 'stylus');
  if (!stylus) return false;
  const el = e.target as Element | null;
  if (e.type === 'touchstart' && el && typeof el.closest === 'function' && el.closest(CONTROLS)) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

// ---- input

interface Live {
  pointerId: number;
  pointerType: string;
  target: PageTarget;
  map: PageMap;
  pen: PenSettings;
  color: string;
  trace: Trace;
  predicted: Point[];
  frozen: number;
  pieces: number;
  events: number;
  handler: number[];
  frames: number[];
  maxPredicted: number;
  /** What the tail canvas has drawn, in page px, or null. */
  tailBox: [number, number, number, number] | null;
  /** Anything on the head canvas. */
  head: boolean;
}

type Listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => void;

function overlay(cls: string): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.className = `nb-ink-live ${cls}`;
  return [c, c.getContext('2d')!];
}

export class PenInput {
  /** Frozen older parts of a long stroke in progress. */
  readonly head: HTMLCanvasElement;
  /** The latest part of the stroke in progress and the predicted tail, redrawn every frame. */
  readonly tail: HTMLCanvasElement;
  private headCtx: CanvasRenderingContext2D;
  private tailCtx: CanvasRenderingContext2D;
  private live: Live | null = null;
  private frame = 0;
  /** The path `d` of the tail drawn in the last frame (for tests). */
  livePath = '';

  /** `listen` adds a listener on the element holding the pages (removed with the view). */
  constructor(private host: PenHost, listen: Listen, readonly stats: PenStats = newPenStats()) {
    [this.head, this.headCtx] = overlay('nb-ink-live-head');
    [this.tail, this.tailCtx] = overlay('nb-ink-live-tail');
    listen('pointerdown', e => this.down(e));
    listen('pointermove', e => this.move(e));
    listen('pointerup', e => this.up(e));
    listen('pointercancel', e => this.up(e));
  }

  get drawing(): boolean {
    return this.live !== null;
  }

  private down(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.stats.touchesIgnored++;
      this.stats.at = performance.now();
      this.host.statsChanged();
      return;
    }
    if (this.live || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = this.host.pageAt(e.target);
    if (!target) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch (err) {
      // synthetic events have no active pointer to capture
    }
    const rect = target.el.getBoundingClientRect();
    this.place(target, rect);
    const pen = { ...this.host.pen() };
    this.stats.coalesced = typeof e.getCoalescedEvents === 'function';
    this.stats.predicted = typeof e.getPredictedEvents === 'function';
    const live: Live = this.live = {
      pointerId: e.pointerId, pointerType: e.pointerType, target, map: pageMap(rect, target.size, e.timeStamp), pen,
      color: this.host.drawColor(pen.color), trace: newTrace(), predicted: [], frozen: 0, pieces: 0,
      events: 0, handler: [], frames: [], maxPredicted: 0, tailBox: null, head: false,
    };
    addSamples(live.trace, [e], live.map);
    this.schedule();
  }

  private move(e: PointerEvent) {
    const live = this.live;
    if (!live || e.pointerId !== live.pointerId) return;
    const t0 = performance.now();
    e.preventDefault();
    live.events++;
    addSamples(live.trace, samplesOf(e), live.map);
    if (this.stats.predicted) {
      live.predicted = predictedPoints(live.trace, e, live.map);
      live.maxPredicted = Math.max(live.maxPredicted, live.predicted.length);
    }
    this.schedule();
    live.handler.push(performance.now() - t0);
  }

  private up(e: PointerEvent) {
    const live = this.live;
    if (!live || e.pointerId !== live.pointerId) return;
    this.live = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const cancelled = e.type === 'pointercancel';
    this.record(live, cancelled);
    // A cancelled stroke (the system took the pointer) is kept, like a finished one.
    const { points } = live.trace;
    if (points.length) this.host.commit(live.target, { tool: 'pen', nib: live.pen.nib, color: live.pen.color, size: live.pen.size, points });
    this.clear();
    this.host.statsChanged();
  }

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  /** The frame callback: freezes older points if needed and redraws the tail. */
  private draw() {
    this.frame = 0;
    const live = this.live;
    if (!live) return;
    const t0 = performance.now();
    const pts = live.trace.points;
    const plan = livePlan(pts.length, live.frozen);
    if (plan.freeze) {
      this.fill(this.headCtx, live, pts.slice(plan.freeze[0], plan.freeze[1]));
      live.frozen = plan.frozen;
      live.pieces++;
      live.head = true;
    }
    const ctx = this.tailCtx;
    if (live.tailBox) {
      const [x0, y0, x1, y1] = live.tailBox;
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    }
    const tail = pts.slice(plan.tail).concat(live.predicted);
    this.livePath = this.fill(ctx, live, tail);
    live.tailBox = box(tail, live.pen.size);
    live.frames.push(performance.now() - t0);
  }

  /** Fills the outline of these points in the stroke's settings; returns the path `d`. */
  private fill(ctx: CanvasRenderingContext2D, live: Live, points: Point[]): string {
    const d = strokePath({ tool: 'pen', nib: live.pen.nib, size: live.pen.size, points });
    if (d) {
      ctx.fillStyle = live.color;
      ctx.fill(new Path2D(d));
    }
    return d;
  }

  private record(live: Live, cancelled: boolean) {
    const pts = live.trace.points, stats = this.stats;
    const ms = pts.length ? pts[pts.length - 1].t : 0;
    const s: StrokeInputStats = {
      pointerType: live.pointerType,
      events: live.events,
      samples: live.trace.samples,
      points: pts.length,
      ms,
      eventsPerS: ms > 0 ? live.events / ms * 1000 : NaN,
      samplesPerS: ms > 0 ? (live.trace.samples - 1) / ms * 1000 : NaN,
      handlerMs: median(live.handler),
      handlerMaxMs: live.handler.length ? Math.max(...live.handler) : NaN,
      frames: live.frames.length,
      frameMs: median(live.frames),
      frameMaxMs: live.frames.length ? Math.max(...live.frames) : NaN,
      maxPredicted: live.maxPredicted,
      frozen: live.pieces,
      cancelled,
    };
    stats.strokes++;
    if (cancelled) stats.cancelled++;
    stats.maxPredicted = Math.max(stats.maxPredicted, live.maxPredicted);
    stats.last = s;
    if (ms > 150 && live.events > 3) {
      stats.recent.push(s);
      if (stats.recent.length > 10) stats.recent.shift();
    }
    stats.at = performance.now();
  }

  /** Puts the overlays over the page and sizes them; drawing is in page px. */
  private place(target: PageTarget, rect: DOMRect) {
    const r = pixelRatio(rect.width, rect.height);
    const w = Math.max(1, Math.round(rect.width * r)), h = Math.max(1, Math.round(rect.height * r));
    for (const [c, ctx] of [[this.head, this.headCtx], [this.tail, this.tailCtx]] as const) {
      if (c.parentElement !== target.el) target.el.appendChild(c);
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(w / target.size.width, 0, 0, h / target.size.height, 0, 0);
    }
  }

  /** The page moved under a stroke in progress (the view scrolled): follow it. */
  viewMoved() {
    const live = this.live;
    if (!live) return;
    const rect = live.target.el.getBoundingClientRect();
    live.map = pageMap(rect, live.target.size, live.map.t0);
  }

  private clear() {
    for (const [c, ctx] of [[this.head, this.headCtx], [this.tail, this.tailCtx]] as const) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.restore();
    }
  }

  /** Abandons a stroke in progress (the page it was on went away). */
  cancel() {
    this.live = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.clear();
  }

  destroy() {
    this.cancel();
    for (const c of [this.head, this.tail]) {
      c.width = c.height = 0;
      c.remove();
    }
  }
}

/** The bounding box of points drawn at this size, with a margin, in page px. */
function box(points: readonly Point[], size: number): [number, number, number, number] | null {
  if (!points.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { x, y } of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const m = size + 2; // the pressure nib reaches 1.25 × size / 2 from the line
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

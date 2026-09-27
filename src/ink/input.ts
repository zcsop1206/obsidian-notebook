// The pen (#5): Pencil and mouse input on the ink view's pages, the stroke in progress, and
// input measurements.
//
// Who draws: pen and mouse (button 0) pointers that go down on a page. Touches never draw
// (palm rejection); pen hover is ignored.
//
// A gesture belongs to the page it started on (#35): the page is looked up once, at
// pointerdown, and the gesture samples until its pointer goes up or is cancelled, wherever the
// pointer is, on the page, in the gap between pages, over the scroller's margin or outside
// the view. Points off the page are kept as they are (not clamped; see format/page.ts); the
// overlays and the page bitmap are page-sized, so drawing is clipped to the page. Only
// pointerdown is listened for on the pages layer. While a gesture is live, pointermove,
// pointerup and pointercancel are listened for on the pages layer's window, in the capture
// phase, for the gesture's pointerId, and those listeners are removed when it ends. The pointer
// is also captured, but that alone isn't relied on: once the pointer left the pages layer (16
// px beyond the pages at 100%) a stroke lost its moves and its pointerup whenever capture
// wasn't in effect (WebKit and the Pencil, or a capture call that throws), and the Pencil had
// to be lifted to write again. A window listener sees every event of the pointer whatever its
// target, and stylus touchmoves anywhere in the window are prevented meanwhile, so nothing
// outside the view scrolls under the Pencil or cancels its pointer. Fingers are unaffected: the
// listeners ignore other pointerIds and finger touches. A gesture that starts off the pages
// (in the gap) does nothing.
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
// (strokePath in format/outline.ts with the stroke's options) of the raw points, without the
// refit a finished pen stroke gets (#32), filled through Path2D on two
// overlay canvases over the page: the tail canvas is cleared and redrawn every frame with the
// outline of the latest points plus the predicted tail; once more than LIVE_MAX points are
// live, the older ones are drawn once onto the head canvas and dropped from the tail (keeping
// LIVE_KEEP, with OVERLAP points shared so the pieces join inside the line). Per-frame work is
// therefore bounded by LIVE_MAX + OVERLAP points however long the stroke. On release the
// stroke goes to the host, which draws its outline (refitted, as the file has it) into the
// page bitmap, and both overlays are cleared: that swap is the stroke settling.
//
// The highlighter (#6) is drawn translucent, at HIGHLIGHT_ALPHA like the page's highlight layer,
// but composited once so that its frozen head and its tail (and the stroke where it crosses
// itself) don't darken where they overlap: see PenInput.highlight.
//
// Erasing (#7): with the eraser selected, a pen or mouse drag draws nothing. Its samples are
// filtered as above and collected by the handlers; once per animation frame the host is given
// the path since the last frame (from the last sample already tested), hit-tests it and
// removes what it touches (whole strokes, or in partial mode, #15, the parts under the
// eraser), redrawing a page at most once. A circle of the hit radius follows
// the pointer on the tail overlay and is cleared on release. Touches never erase.
//
// The lasso (#11): with the lasso selected, a pen or mouse pointer going down on a page asks the
// host what it grabs (selectionHit): the selection's corner handle (a resize), its box (a move)
// or nothing. Nothing starts a new lasso: the selection is dropped, the loop is drawn on the
// tail overlay each frame (a dashed 1 CSS px line closing back to its start) and, on release,
// given to the host (lassoSelect), which selects what's inside. A move or resize drag is given
// to the host once per animation frame as its start and current point (page px of the page it
// started on, not clamped) and the pointer's client position (to find the page under it); the
// host draws the preview (see selection.ts) and commits on release (endSelectionDrag). Touches
// never lasso. Like every gesture, these follow their pointer on the window until it lifts.
// A lasso that never moves more than LASSO_TAP_SLOP CSS px from where it went down is a tap:
// it's given to the host's lassoTap, if it has one (#12: a tap on an image selects it).
//
// The ruler (#20): when the host shows a ruler (rulerEdge), a pen or highlighter stroke whose
// pointerdown lands within EDGE_REACH CSS px of one of its edges is ruled: the edge is put on the
// stroke's PageMap, and toPoint projects every sample (and the predicted tail) onto it before
// rounding, so the live stroke and the stored one are the same straight line, with pressure and
// times as sampled. While it's drawn the host is given its length once per frame (rulerMeasure).
//
// Shapes (#16): a pen or highlighter stroke (not a ruled one; not with the host's shapesOn
// false) whose pointer stays within HOLD_SLOP CSS px for HOLD_MS, after at least HOLD_MIN_PATH
// page px of path, is given to recognize (shapes.ts). The hold is timed by event timestamps
// (WebKit keeps sending pointermoves at the same place while the Pencil is held) and by a timer
// (for when no events come at all). A recognised shape replaces the live drawing (the head
// canvas hidden, the shape drawn translucent on the tail canvas) until the pen lifts, when it
// is given to the host's commitShape with the freehand stroke; moving more than HOLD_SLOP
// again drops it and the freehand stroke is drawn again, its points continuing.
import { strokePath } from '../format/outline';
import { roundP, roundXY, type HighlighterStroke, type PenStroke, type Point, type Size } from '../format/page';
import { fmt, median, yn } from '../debug/util';
import type { EraserMode, EraserSettings, PenSettings } from './pen';
import { EDGE_REACH, projectOnto, type Edge } from './ruler';
import { recognize, type Shape, type ShapeKind } from './shapes';
import { HIGHLIGHT_ALPHA, pixelRatio } from './renderer';

/** A lasso gesture staying within this many CSS px of its start is a tap (#12). */
export const LASSO_TAP_SLOP = 6;
/** A pen held within this many CSS px for HOLD_MS is holding still (#16). */
export const HOLD_SLOP = 3;
export const HOLD_MS = 600;
/** A stroke is only straightened after this much path, page px. */
export const HOLD_MIN_PATH = 20;
/** The live shape preview's opacity (the committed stroke is opaque). */
export const SHAPE_PREVIEW_ALPHA = 0.7;
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

/** A finished stroke of either tool, without its id. */
export type NewStroke = NewPenStroke | Omit<HighlighterStroke, 'id'>;

/** What a stroke is written with: its tool, colour and size, and the nib for a pen stroke. */
export type StrokeStyle = Omit<NewPenStroke, 'points'> | Omit<HighlighterStroke, 'id' | 'points'>;

export interface PenHost {
  /** The writable page an event landed on, or null. */
  pageAt(target: EventTarget | null): PageTarget | null;
  /** The pen settings for a stroke starting now. */
  pen(): Readonly<PenSettings>;
  /** The colour a stroke of this colour is drawn in (the default ink follows the theme). */
  drawColor(color: string): string;
  /** A finished stroke on a page. */
  commit(target: PageTarget, stroke: NewStroke): void;
  /** The pen stats changed (a stroke ended or a touch was ignored). */
  statsChanged(): void;
  /** What a stroke starting now is written with (the active tool's own colour and size). */
  strokeStyle(): StrokeStyle;
  /** The eraser settings for an erase starting now. */
  eraser(): Readonly<EraserSettings>;
  /**
   * The eraser moved along `path` (page px; one point for a tap) on a page since the last call:
   * erase what is within `radius` of it, in `mode` (whole strokes, or only the parts under the
   * eraser), and add what was done to `tally`. Called at most once per animation frame; `start`
   * is true for the first call of a gesture. `path` is reused afterwards, so don't keep it.
   */
  erase(target: PageTarget, path: readonly Point[], radius: number, start: boolean, mode: EraserMode, tally: EraseTally): void;
  /** With the lasso (#11): what a pointer going down at `point` (page px) on `target` grabs. */
  selectionHit(target: PageTarget, point: Point): SelectionHit;
  /** A new lasso starts: drop the selection. */
  clearSelection(): void;
  /** A lasso loop (page px, closed back to its start) was drawn on `target`: select what's inside. */
  lassoSelect(target: PageTarget, loop: readonly Point[]): void;
  /**
   * The selection is being dragged by its box (`move`) or corner handle (`resize`) from `from` to
   * `to` (page px of the page the drag started on); the pointer is at (clientX, clientY). Called
   * at most once per animation frame.
   */
  dragSelection(kind: 'move' | 'resize', from: Point, to: Point, clientX: number, clientY: number): void;
  /** The drag ended where dragSelection last put it: commit it, or with `cancelled` drop it. */
  endSelectionDrag(cancelled: boolean): void;
  /** A tap with the lasso (no loop) at `point` (page px) on `target` (#12: selects an image there). */
  lassoTap?(target: PageTarget, point: Point): void;
  /**
   * The ruler (#20): the ruler edge within `reach` page px of `point` (page px, unrounded) on
   * `target`, which a stroke starting there is drawn along, or null. Absent: no ruler.
   */
  rulerEdge?(target: PageTarget, point: { x: number; y: number }, reach: number): Edge | null;
  /** A ruled stroke is drawn from `from` to `to` (page px); null when it ended. Once per frame. */
  rulerMeasure?(target: PageTarget, from: Point | null, to: Point | null): void;
  /** Shapes (#16): whether a held stroke is straightened (absent: yes). */
  shapesOn?(): boolean;
  /**
   * A stroke straightened into `shape` (#16): commit `shape`, keeping `freehand` for undo.
   * Absent: the shape is committed as an ordinary stroke.
   */
  commitShape?(target: PageTarget, shape: NewStroke, freehand: NewStroke, kind: ShapeKind): void;
}

/** What a pointer going down grabs with the lasso: the selection's box, its corner handle, or nothing. */
export type SelectionHit = 'move' | 'resize' | null;

/** What an erase gesture did. */
export interface EraseTally {
  /** Strokes removed whole (in partial mode, strokes all under the eraser). */
  removed: number;
  /** Strokes cut (partial mode): each is replaced by its remnants. */
  split: number;
  /** Strokes left by the cuts. */
  remnants: number;
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
  /** A ruled stroke's edge (#20): samples are projected onto it. */
  edge?: Edge | null;
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
  let x = (s.clientX - m.left) * m.sx, y = (s.clientY - m.top) * m.sy;
  if (m.edge) ({ x, y } = projectOnto({ x, y }, m.edge));
  return {
    x: roundXY(x),
    y: roundXY(y),
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

/** The last erase gesture as text lines, for the ink view's stats overlay. */
export function eraseStatsLines(e: EraseStats | null): string[] {
  if (!e) return ['last erase: none yet'];
  return [`last erase: ${e.mode}, removed ${e.removed}, cuts ${e.split}, remnants ${e.remnants}; ` +
    `erase frame ${fmt(e.frameMs, 2)} ms median (max ${fmt(e.frameMaxMs, 2)}, ${e.frames} frames)`];
}

// ---- stylus touches

/** Elements a Pencil tap must still reach. */
const CONTROLS = 'button, select, input, textarea, a, .nb-ink-control';

const hasStylus = (e: TouchEvent) => Array.from(e.changedTouches).some(t => (t as Touch & { touchType?: string }).touchType === 'stylus');

/**
 * Keeps a Pencil drag anywhere in the ink view from scrolling it or opening Obsidian's sidebars
 * (on the iPad the Pencil also sends touch events, with touchType "stylus"). Rules, for
 * touchstart and touchmove listeners (passive: false) on the whole view:
 * - a touch event with no stylus touch (fingers) is left alone here (see blockFingerTouch);
 * - a stylus touchstart on a control (button, select, input, textarea, a, .nb-ink-control) is
 *   left alone, so Pencil taps on "Add page" and the pen strip still click;
 * - any other stylus touchstart, and every stylus touchmove, is prevented and stopped.
 * Returns whether the event was prevented.
 */
export function blockStylusTouch(e: TouchEvent): boolean {
  if (!hasStylus(e)) return false;
  const el = e.target as Element | null;
  if (e.type === 'touchstart' && el && typeof el.closest === 'function' && el.closest(CONTROLS)) return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

/**
 * Keeps finger drags over the pages (`area`, the scroll container) away from Obsidian, which
 * would otherwise open its sidebars on a swipe (#9: the view pans and zooms from finger pointer
 * events itself, see navigate.ts, and the scroll container has `touch-action: none`). For a
 * touchmove listener (passive: false) on the whole view: a finger touchmove (no stylus touch)
 * inside `area` is prevented and stopped. Touchstarts are left alone, so finger taps on "Add
 * page" still click, and fingers outside `area` (the pen strip) scroll natively. Returns whether
 * the event was prevented.
 */
export function blockFingerTouch(e: TouchEvent, area: Element): boolean {
  if (e.type !== 'touchmove' || hasStylus(e)) return false;
  const el = e.target;
  if (!(el instanceof Node) || !area.contains(el)) return false;
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
  /** What the stroke is written with. */
  style: StrokeStyle;
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
  /** Where (client px) and when (event timestamp and clock) the pointer last moved past HOLD_SLOP (#16). */
  hold: { x: number; y: number; stamp: number; clock: number; timer: number; tried: boolean } | null;
  /** The path length so far, page px, over the first `lenCount` points. */
  len: number;
  lenCount: number;
  /** The recognised shape shown instead of the stroke, or null. */
  shape: Shape | null;
}

/** An erase gesture in progress. */
interface Erasing {
  pointerId: number;
  pointerType: string;
  target: PageTarget;
  map: PageMap;
  /** Hit radius, page px. */
  radius: number;
  mode: EraserMode;
  tally: EraseTally;
  /** Samples not yet tested, after the last one tested (points[0], once `sent`). */
  trace: Trace;
  sent: boolean;
  /** The cursor circle's box on the tail canvas, page px, or null. */
  cursor: [number, number, number, number] | null;
  events: number;
  handler: number[];
  frames: number[];
}

/** One erase gesture's input measurements. */
export interface EraseStats {
  pointerType: string;
  /** pointermove events handled. */
  events: number;
  /** Samples seen (coalesced ones included, dropped ones too). */
  samples: number;
  /** Time in the pointermove handler, median and worst, ms. */
  handlerMs: number;
  handlerMaxMs: number;
  /** Erase frames (hit-testing, removing and redrawing) and their time, median and worst, ms. */
  frames: number;
  frameMs: number;
  frameMaxMs: number;
  mode: EraserMode;
  /** Strokes removed whole. */
  removed: number;
  /** Strokes cut, and the strokes left by the cuts (partial mode). */
  split: number;
  remnants: number;
}

/** A lasso loop or a selection drag in progress (#11). */
interface Lassoing {
  pointerId: number;
  target: PageTarget;
  map: PageMap;
  /** null: drawing a loop; else dragging the selection. */
  drag: 'move' | 'resize' | null;
  /** The loop's samples (drag: the first point is where it started). */
  trace: Trace;
  /** The drag's latest point, page px, and the pointer's client position. */
  now: Point | null;
  clientX: number;
  clientY: number;
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
  private erasing: Erasing | null = null;
  private lassoing: Lassoing | null = null;
  private frame = 0;
  /** The last erase gesture's measurements, or null. */
  lastErase: EraseStats | null = null;
  /** The path `d` of the tail drawn in the last frame (for tests). */
  livePath = '';
  /** Where a highlighter frame is put together before it's composited (see highlight). */
  private scratch: HTMLCanvasElement | null = null;

  /** `listen` adds a listener on the element holding the pages (removed with the view). */
  constructor(private host: PenHost, listen: Listen, readonly stats: PenStats = newPenStats()) {
    [this.head, this.headCtx] = overlay('nb-ink-live-head');
    [this.tail, this.tailCtx] = overlay('nb-ink-live-tail');
    listen('pointerdown', e => this.down(e));
  }

  /** The window listeners of the gesture in progress, or null. */
  private tracking: { win: Window; move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; touch: (e: TouchEvent) => void } | null = null;

  /** Follows the gesture's pointer everywhere until it ends (see the header, #35). */
  private track(el: HTMLElement) {
    this.untrack();
    const win = el.ownerDocument.defaultView ?? window;
    const t = this.tracking = { win, move: (e: PointerEvent) => this.move(e), up: (e: PointerEvent) => this.up(e), touch: (e: TouchEvent) => void blockStylusTouch(e) };
    win.addEventListener('pointermove', t.move, true);
    // The view blocks stylus touchmoves inside it; outside it too while the gesture lasts.
    win.addEventListener('touchmove', t.touch, { capture: true, passive: false });
    win.addEventListener('pointerup', t.up, true);
    win.addEventListener('pointercancel', t.up, true);
  }

  private untrack() {
    const t = this.tracking;
    if (!t) return;
    this.tracking = null;
    t.win.removeEventListener('pointermove', t.move, true);
    t.win.removeEventListener('pointerup', t.up, true);
    t.win.removeEventListener('pointercancel', t.up, true);
    t.win.removeEventListener('touchmove', t.touch, true);
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
    if (this.live || this.erasing || this.lassoing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const target = this.host.pageAt(e.target);
    if (!target) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch (err) {
      // synthetic events have no active pointer to capture
    }
    this.track(target.el);
    const rect = target.el.getBoundingClientRect();
    this.place(target, rect);
    if (this.host.pen().tool === 'eraser') {
      this.eraseDown(e, target, rect);
      return;
    }
    if (this.host.pen().tool === 'lasso') {
      this.lassoDown(e, target, rect);
      return;
    }
    const pen = { ...this.host.pen() };
    const style = { ...this.host.strokeStyle() };
    // The highlighter's head canvas only stores the frozen part, opaque; highlight() shows it.
    this.head.style.visibility = style.tool === 'highlighter' ? 'hidden' : '';
    this.stats.coalesced = typeof e.getCoalescedEvents === 'function';
    this.stats.predicted = typeof e.getPredictedEvents === 'function';
    const map = pageMap(rect, target.size, e.timeStamp);
    map.edge = this.rulerEdge(target, map, e);
    const live: Live = this.live = {
      pointerId: e.pointerId, pointerType: e.pointerType, target, map, pen,
      style, color: this.host.drawColor(style.color), trace: newTrace(), predicted: [], frozen: 0, pieces: 0,
      events: 0, handler: [], frames: [], maxPredicted: 0, tailBox: null, head: false,
      hold: null, len: 0, lenCount: 1, shape: null,
    };
    addSamples(live.trace, [e], live.map);
    this.holdMove(live, e);
    this.schedule();
  }

  private move(e: PointerEvent) {
    if (this.lassoing) {
      this.lassoMove(e);
      return;
    }
    if (this.erasing) {
      this.eraseMove(e);
      return;
    }
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
    this.holdMove(live, e);
    this.schedule();
    live.handler.push(performance.now() - t0);
  }

  private up(e: PointerEvent) {
    if (this.lassoing) {
      this.lassoUp(e);
      return;
    }
    if (this.erasing) {
      this.eraseUp(e);
      return;
    }
    const live = this.live;
    if (!live || e.pointerId !== live.pointerId) return;
    this.live = null;
    this.stopHold(live);
    this.untrack();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const cancelled = e.type === 'pointercancel';
    if (live.map.edge) this.host.rulerMeasure?.(live.target, null, null);
    this.record(live, cancelled);
    // A cancelled stroke (the system took the pointer) is kept, like a finished one.
    const { points } = live.trace;
    // A straightened stroke is committed as its shape on release (a cancelled one stays freehand).
    this.lastShape = live.shape && !cancelled ? live.shape.kind : null;
    if (live.shape && !cancelled) {
      const shape = { ...live.style, points: live.shape.points }, freehand = { ...live.style, points };
      if (this.host.commitShape) this.host.commitShape(live.target, shape, freehand, live.shape.kind);
      else this.host.commit(live.target, shape);
    } else if (points.length) this.host.commit(live.target, { ...live.style, points });
    this.clear();
    this.host.statsChanged();
  }

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  /** The frame callback: freezes older points if needed and redraws the tail. */
  private draw() {
    this.frame = 0;
    if (this.lassoing) {
      this.lassoFrame(this.lassoing);
      return;
    }
    if (this.erasing) {
      this.eraseFrame(this.erasing);
      return;
    }
    const live = this.live;
    if (!live) return;
    const t0 = performance.now();
    if (live.shape) {
      this.drawShape(live);
      live.frames.push(performance.now() - t0);
      return;
    }
    const pts = live.trace.points;
    const plan = livePlan(pts.length, live.frozen);
    if (plan.freeze) {
      this.fill(this.headCtx, live, pts.slice(plan.freeze[0], plan.freeze[1]));
      live.frozen = plan.frozen;
      live.pieces++;
      live.head = true;
    }
    const ctx = this.tailCtx;
    const tail = pts.slice(plan.tail).concat(live.predicted);
    if (live.style.tool === 'highlighter') this.livePath = this.highlight(live, tail);
    else {
      if (live.tailBox) {
        const [x0, y0, x1, y1] = live.tailBox;
        ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      }
      this.livePath = this.fill(ctx, live, tail);
    }
    live.tailBox = box(tail, live.style.size);
    if (live.map.edge && pts.length) this.host.rulerMeasure?.(live.target, pts[0], pts[pts.length - 1]);
    live.frames.push(performance.now() - t0);
  }

  // ---- shapes (#16)

  /** The kind of shape the last stroke was committed as, or null (for tests and the stats). */
  lastShape: ShapeKind | null = null;

  /** The shape shown for the stroke in progress, or null. */
  get previewShape(): ShapeKind | null {
    return this.live?.shape?.kind ?? null;
  }

  /** A pointer event of the live stroke: restart the hold when it moved, or recognise after one. */
  private holdMove(live: Live, e: PointerEvent) {
    const pts = live.trace.points;
    for (; live.lenCount < pts.length; live.lenCount++) {
      const a = pts[live.lenCount - 1], b = pts[live.lenCount];
      live.len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const h = live.hold;
    if (!h || Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) {
      if (live.shape) this.dropShape(live);
      this.stopHold(live);
      const win = live.target.el.ownerDocument.defaultView ?? window;
      const hold = live.hold = { x: e.clientX, y: e.clientY, stamp: e.timeStamp, clock: performance.now(), timer: 0, tried: false };
      hold.timer = win.setTimeout(() => {
        if (this.live === live && live.hold === hold && performance.now() - hold.clock >= HOLD_MS - 1) this.held(live);
      }, HOLD_MS + 5);
      return;
    }
    if (e.timeStamp - h.stamp >= HOLD_MS) this.held(live);
  }

  private stopHold(live: Live) {
    if (live.hold) (live.target.el.ownerDocument.defaultView ?? window).clearTimeout(live.hold.timer);
    live.hold = null;
  }

  /** The pen has held still: straighten the stroke if it's a shape. */
  private held(live: Live) {
    if (!live.hold || live.hold.tried || live.shape || live.map.edge || live.len < HOLD_MIN_PATH || this.host.shapesOn?.() === false) return;
    live.hold.tried = true; // once per hold
    const shape = recognize(live.trace.points);
    if (!shape) return;
    live.shape = shape;
    this.head.style.visibility = 'hidden';
    this.schedule();
  }

  /** The pen moved on after a shape was shown: back to the freehand stroke. */
  private dropShape(live: Live) {
    live.shape = null;
    if (live.style.tool !== 'highlighter') this.head.style.visibility = '';
    // The next frame redraws the whole tail canvas (the shape may have been anywhere on it).
    live.tailBox = [0, 0, live.target.size.width, live.target.size.height];
    this.schedule();
  }

  /** Draws the recognised shape, translucent, in place of the stroke. */
  private drawShape(live: Live) {
    const c = this.tail, ctx = this.tailCtx, shape = live.shape!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
    const d = strokePath({ ...live.style, points: shape.points }, true);
    if (d) {
      ctx.save();
      ctx.globalAlpha = (live.style.tool === 'highlighter' ? HIGHLIGHT_ALPHA : 1) * SHAPE_PREVIEW_ALPHA;
      ctx.fillStyle = live.color;
      ctx.fill(new Path2D(d));
      ctx.restore();
    }
    this.livePath = d;
    live.tailBox = [0, 0, live.target.size.width, live.target.size.height];
  }

  /** Fills the outline of these points in the stroke's settings; returns the path `d`. */
  private fill(ctx: CanvasRenderingContext2D, live: Live, points: Point[]): string {
    const d = strokePath({ ...live.style, points }, true);
    if (d) {
      ctx.fillStyle = live.color;
      ctx.fill(new Path2D(d));
    }
    return d;
  }

  /**
   * A highlighter frame. The frozen head is drawn opaque onto the head canvas, which is hidden.
   * Each frame, the part of the tail canvas that the tail covered last frame or covers now is
   * rebuilt: the head's pixels there and the tail's outline are drawn opaque onto a scratch
   * canvas, which then replaces that part of the tail canvas at HIGHLIGHT_ALPHA. Every pixel of
   * the live stroke is therefore composited once, like the saved highlight layer, with no darker
   * seam where head and tail overlap. A frame costs the tail's outline (at most LIVE_MAX +
   * OVERLAP points, as for the pen) plus two copies of the tail's bounding box. Returns the
   * tail's path `d`.
   */
  private highlight(live: Live, points: Point[]): string {
    const c = this.tail, ctx = this.tailCtx, size = live.target.size;
    const kx = c.width / size.width, ky = c.height / size.height;
    const d = strokePath({ ...live.style, points }, true);
    const now = box(points, live.style.size), was = live.tailBox;
    const b = now && was ? [Math.min(now[0], was[0]), Math.min(now[1], was[1]), Math.max(now[2], was[2]), Math.max(now[3], was[3])] : now ?? was;
    if (!b) return d;
    // In whole device pixels, so the area cleared is exactly the area redrawn.
    const x = Math.max(0, Math.floor(b[0] * kx)), y = Math.max(0, Math.floor(b[1] * ky));
    const w = Math.min(c.width, Math.ceil(b[2] * kx)) - x, h = Math.min(c.height, Math.ceil(b[3] * ky)) - y;
    if (w <= 0 || h <= 0) return d;
    const scratch = this.scratch ??= document.createElement('canvas');
    if (scratch.width < w || scratch.height < h) {
      scratch.width = Math.max(scratch.width, w);
      scratch.height = Math.max(scratch.height, h);
    }
    const s = scratch.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, w, h);
    if (live.head) s.drawImage(this.head, x, y, w, h, 0, 0, w, h);
    if (d) {
      s.setTransform(kx, 0, 0, ky, -x, -y);
      s.fillStyle = live.color;
      s.fill(new Path2D(d));
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(x, y, w, h);
    ctx.globalAlpha = HIGHLIGHT_ALPHA;
    ctx.drawImage(scratch, 0, 0, w, h, x, y, w, h);
    ctx.restore();
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

  /** The page moved under a stroke in progress (the view scrolled or zoomed): follow it. */
  viewMoved() {
    const er = this.erasing;
    if (er) er.map = pageMap(er.target.el.getBoundingClientRect(), er.target.size, er.map.t0);
    const la = this.lassoing;
    if (la) la.map = pageMap(la.target.el.getBoundingClientRect(), la.target.size, la.map.t0);
    const live = this.live;
    if (!live) return;
    const rect = live.target.el.getBoundingClientRect();
    live.map = { ...pageMap(rect, live.target.size, live.map.t0), edge: live.map.edge };
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
    this.untrack();
    if (this.live?.map.edge) this.host.rulerMeasure?.(this.live.target, null, null);
    if (this.live) this.stopHold(this.live);
    this.live = null;
    this.erasing = null;
    const la = this.lassoing;
    this.lassoing = null;
    if (la?.drag) this.host.endSelectionDrag(true);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.clear();
  }

  // ---- erasing

  private eraseDown(e: PointerEvent, target: PageTarget, rect: DOMRect) {
    const er: Erasing = this.erasing = {
      pointerId: e.pointerId, pointerType: e.pointerType, target, map: pageMap(rect, target.size, e.timeStamp),
      radius: this.host.eraser().size, mode: this.host.eraser().mode, tally: { removed: 0, split: 0, remnants: 0 },
      trace: newTrace(), sent: false, cursor: null, events: 0, handler: [], frames: [],
    };
    addSamples(er.trace, [e], er.map);
    this.schedule();
  }

  private eraseMove(e: PointerEvent) {
    const er = this.erasing!;
    if (e.pointerId !== er.pointerId) return;
    const t0 = performance.now();
    e.preventDefault();
    er.events++;
    addSamples(er.trace, samplesOf(e), er.map);
    this.schedule();
    er.handler.push(performance.now() - t0);
  }

  private eraseUp(e: PointerEvent) {
    const er = this.erasing!;
    if (e.pointerId !== er.pointerId) return;
    this.erasing = null;
    this.untrack();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.eraseStep(er); // samples since the last frame
    this.clear();
    this.lastErase = {
      pointerType: er.pointerType,
      events: er.events,
      samples: er.trace.samples,
      handlerMs: median(er.handler),
      handlerMaxMs: er.handler.length ? Math.max(...er.handler) : NaN,
      frames: er.frames.length,
      frameMs: median(er.frames),
      frameMaxMs: er.frames.length ? Math.max(...er.frames) : NaN,
      mode: er.mode,
      ...er.tally,
    };
    this.host.statsChanged();
  }

  /** Gives the host the path not yet tested; keeps its last point as the next path's start. */
  private eraseStep(er: Erasing) {
    const pts = er.trace.points;
    if (pts.length > 1 || (pts.length === 1 && !er.sent)) {
      this.host.erase(er.target, pts, er.radius, !er.sent, er.mode, er.tally);
      er.sent = true;
      pts.splice(0, pts.length - 1);
    }
  }

  /** The frame callback while erasing: erases along the new samples and moves the cursor. */
  private eraseFrame(er: Erasing) {
    const t0 = performance.now();
    this.eraseStep(er);
    const ctx = this.tailCtx;
    if (er.cursor) {
      const [x0, y0, x1, y1] = er.cursor;
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      er.cursor = null;
    }
    const pts = er.trace.points, p = pts[pts.length - 1];
    if (p) {
      const r = er.radius, line = er.map.sx; // 1 CSS px in page px
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(128, 128, 128, 0.18)';
      ctx.fill();
      ctx.lineWidth = line;
      ctx.strokeStyle = 'rgba(110, 110, 110, 0.9)';
      ctx.stroke();
      const m = r + line + 1;
      er.cursor = [p.x - m, p.y - m, p.x + m, p.y + m];
    }
    er.frames.push(performance.now() - t0);
  }

  // ---- the ruler (#20)

  /** Whether the last pen or highlighter stroke started was ruled (for tests). */
  lastRuled = false;

  /** The edge a stroke going down with `e` is drawn along: within EDGE_REACH CSS px of the pointer, or null. */
  private rulerEdge(target: PageTarget, map: PageMap, e: PointerEvent): Edge | null {
    const at = { x: (e.clientX - map.left) * map.sx, y: (e.clientY - map.top) * map.sy };
    const edge = this.host.rulerEdge?.(target, at, EDGE_REACH * map.sx) ?? null;
    this.lastRuled = !!edge;
    return edge;
  }

  // ---- the lasso (#11)

  /** The last selection drag's frames (host time included), for the stats and tests. */
  lastDrag: { kind: 'move' | 'resize'; frames: number; frameMs: number; frameMaxMs: number } | null = null;
  private dragFrames: number[] = [];

  private lassoDown(e: PointerEvent, target: PageTarget, rect: DOMRect) {
    const map = pageMap(rect, target.size, e.timeStamp);
    const at = toPoint(e, map);
    const drag = this.host.selectionHit(target, at);
    if (!drag) this.host.clearSelection();
    const la: Lassoing = this.lassoing = { pointerId: e.pointerId, target, map, drag, trace: newTrace(), now: null, clientX: e.clientX, clientY: e.clientY };
    addSamples(la.trace, [e], map);
    this.dragFrames = [];
    this.schedule();
  }

  private lassoMove(e: PointerEvent) {
    const la = this.lassoing!;
    if (e.pointerId !== la.pointerId) return;
    e.preventDefault();
    la.clientX = e.clientX;
    la.clientY = e.clientY;
    if (la.drag) la.now = toPoint(e, la.map);
    else addSamples(la.trace, samplesOf(e), la.map);
    this.schedule();
  }

  private lassoUp(e: PointerEvent) {
    const la = this.lassoing!;
    if (e.pointerId !== la.pointerId) return;
    this.lassoing = null;
    this.untrack();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const cancelled = e.type === 'pointercancel';
    if (la.drag) {
      // A tap on the selection (no move) changes nothing.
      if (!cancelled && la.now) {
        la.clientX = e.clientX;
        la.clientY = e.clientY;
        la.now = toPoint(e, la.map);
        this.dragStep(la);
      }
      this.host.endSelectionDrag(cancelled);
      const f = this.dragFrames;
      this.lastDrag = { kind: la.drag, frames: f.length, frameMs: median(f), frameMaxMs: f.length ? Math.max(...f) : NaN };
    } else {
      this.clear();
      const pts = la.trace.points, a = pts[0], slop = LASSO_TAP_SLOP * la.map.sx;
      const tap = !!a && !!this.host.lassoTap && pts.every(q => Math.abs(q.x - a.x) <= slop && Math.abs(q.y - a.y) <= slop);
      if (!cancelled && tap) this.host.lassoTap!(la.target, a);
      else if (!cancelled) this.host.lassoSelect(la.target, la.trace.points);
    }
    this.host.statsChanged();
  }

  private dragStep(la: Lassoing) {
    const from = la.trace.points[0];
    if (from && la.now) this.host.dragSelection(la.drag!, from, la.now, la.clientX, la.clientY);
  }

  /** The frame callback of the lasso: redraws the loop, or moves the selection's preview. */
  private lassoFrame(la: Lassoing) {
    const t0 = performance.now();
    if (la.drag) {
      if (!la.now) return;
      this.dragStep(la);
      this.dragFrames.push(performance.now() - t0);
      return;
    }
    const c = this.tail, ctx = this.tailCtx, pts = la.trace.points;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
    if (pts.length < 2) return;
    const line = la.map.sx; // 1 CSS px in page px
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineWidth = line;
    ctx.setLineDash([5 * line, 4 * line]);
    ctx.strokeStyle = 'rgba(40, 110, 230, 0.95)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Whether a lasso loop or selection drag is in progress. */
  get lassoActive(): boolean {
    return this.lassoing !== null;
  }

  destroy() {
    this.cancel();
    for (const c of [this.head, this.tail]) {
      c.width = c.height = 0;
      c.remove();
    }
    if (this.scratch) this.scratch.width = this.scratch.height = 0;
    this.scratch = null;
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

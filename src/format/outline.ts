// Stroke paths: each stroke is drawn as one path computed from its points. The pressure nib and
// the highlighter are filled outlines computed with perfect-freehand; the uniform nib (#60) is
// its refitted centreline, stroked `size` wide with round caps and joins (isStroked). The paths
// are derived data; a page's <metadata> is the source of truth.
import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { HighlighterStroke, Nib, PenStroke, Point } from './page';

/**
 * How far each smoothed point moves toward the next sample (perfect-freehand's streamline;
 * 0 follows the samples exactly). The iPad delivers about 471 samples/s in 0.5 px steps, so
 * some smoothing takes the staircase out of the line, and at that rate 0.35 trails the pen by
 * under half a sample (about 1 ms). The live stroke's tip is exact either way (`last`).
 */
const STREAMLINE = 0.35;

/** Pen with the `uniform` nib: the same width whatever the pressure or speed, round caps. */
export const UNIFORM_PEN_OPTIONS: Readonly<StrokeOptions> = Object.freeze({
  thinning: 0,
  smoothing: 0.5,
  streamline: STREAMLINE,
  simulatePressure: false,
  start: { cap: true, taper: 0 },
  end: { cap: true, taper: 0 },
  last: true,
});

/** How much pressure changes the pressure nib's width (perfect-freehand's thinning). */
const PRESSURE_THINNING = 0.6;

/**
 * The pressure nib's pressure curve: a square root, so the light pressures of normal writing
 * (the Pencil reports about 0.03 to 0.2, median 0.08, in the owner's spike page) still vary
 * the width visibly instead of all drawing about half width. Keeps 0.5 at 0.5, so `size` is
 * still the width at pressure 0.5. Widths over `size`: 0.4 at pressure 0, 0.55 at 0.03, 0.64
 * at 0.08, 0.76 at 0.18, 1 at 0.5 and 1.25 at 1.
 */
export const pressureCurve = (p: number) => 0.5 * Math.sqrt(2 * Math.max(0, p));

/**
 * perfect-freehand calls `easing` with `0.5 - thinning * (0.5 - pressure)` and takes the result
 * as radius / size; this applies pressureCurve to the pressure inside that.
 */
function pressureEasing(v: number): number {
  const p = 0.5 - (0.5 - v) / PRESSURE_THINNING;
  return 0.5 - PRESSURE_THINNING * (0.5 - pressureCurve(p));
}

/**
 * Pen with the `pressure` nib: width follows pressure through pressureCurve, round caps, no
 * speed dependence. `size` is the width at pressure 0.5.
 */
export const PEN_OPTIONS: Readonly<StrokeOptions> = Object.freeze({
  thinning: PRESSURE_THINNING,
  easing: pressureEasing,
  smoothing: 0.5,
  streamline: STREAMLINE,
  simulatePressure: false,
  start: { cap: true, taper: 0 },
  end: { cap: true, taper: 0 },
  last: true,
});

/** Highlighter: constant width `size`, flat ends. Tuned by #6. */
export const HIGHLIGHTER_OPTIONS: Readonly<StrokeOptions> = Object.freeze({
  thinning: 0,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
  start: { cap: false, taper: 0 },
  end: { cap: false, taper: 0 },
  last: true,
});

export const NIB_OPTIONS: Readonly<Record<Nib, Readonly<StrokeOptions>>> = {
  uniform: UNIFORM_PEN_OPTIONS,
  pressure: PEN_OPTIONS,
};

/** What an outline depends on. */
export type OutlineInput = Pick<PenStroke, 'tool' | 'nib' | 'size' | 'points'> | Pick<HighlighterStroke, 'tool' | 'size' | 'points'>;

export const outlineOptions = (s: OutlineInput): Readonly<StrokeOptions> =>
  s.tool === 'pen' ? NIB_OPTIONS[s.nib] : HIGHLIGHTER_OPTIONS;

/**
 * The uniform nib as a stroked centreline (#60). perfect-freehand's filled outline offsets each
 * point sideways along the direction of the segments around it; at the smallest sizes those
 * segments are the Pencil's 0.5 px steps and hand tremor, so the outline's width wobbled and its
 * edges zigzagged (and the outline was rounded to 0.1 px, a fifth of a 0.5 px width). A
 * centreline stroked `size` wide is exactly that wide everywhere, at any zoom, and its shape is
 * the smoothed centreline, as Notability's standard pen draws. true: uniform strokes are
 * centrelines everywhere (editor, file, thumbnails, PDF); false: back to the filled outline
 * (the pre-#60 drawing), to compare. The pressure nib and the highlighter are always filled.
 */
export const UNIFORM_STROKED = true;

/**
 * Whether a stroke's path (strokePath) is a centreline to be stroked `size` wide with round caps
 * and joins and no fill (the uniform pen, #60), rather than an outline to be filled.
 */
export function isStroked(s: { tool: string; nib?: string }): boolean {
  return UNIFORM_STROKED && s.tool === 'pen' && s.nib === 'uniform';
}

/** Rounds to 0.1 and formats without a trailing `.0` or `-0`. */
export function fmt1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? '0' : String(r);
}

/**
 * The SVG path `d` of a stroke. For the uniform pen (isStroked, #60) the centreline of its
 * refitted points (of the points as given with `live`), an open curve to stroke; otherwise its
 * filled outline, with coordinates rounded to 0.1 px. The pressure pen's outline is drawn with
 * quadratic curves through its points (smoothCurve), so its edges are curved rather than a
 * polygon's straight segments; the highlighter's stays a polygon, to keep its flat ends square.
 */
export function strokePath(stroke: OutlineInput, live = false): string {
  if (isStroked(stroke)) return centreline(live ? stroke.points : refit(stroke.points, refitStep(stroke)));
  return outlinePath(stroke, live);
}

/**
 * The SVG path `d` of a stroke's filled outline, whatever UNIFORM_STROKED says: strokePath of
 * the pressure pen and the highlighter, and the uniform pen's drawing before #60.
 */
export function outlinePath(stroke: OutlineInput, live = false): string {
  const { points, size } = stroke;
  if (points.length === 0) return '';
  if (points.length === 1) return dot(points[0].x, points[0].y, size / 2);
  const outline = strokeOutline(stroke, live);
  return stroke.tool === 'pen' ? smoothCurve(outline) : polygon(outline);
}

/**
 * The outline's points, as perfect-freehand computes them: of the refitted points for a
 * finished pen stroke, of the points as given with `live` (the pen's live overlay passes the
 * same refit, computed incrementally by LiveFit, #52) and for the highlighter.
 */
export function strokeOutline(stroke: OutlineInput, live = false): number[][] {
  const points = stroke.tool === 'pen' && !live ? refit(stroke.points) : stroke.points;
  return getStroke(points.map(pt => [pt.x, pt.y, pt.p]), { ...outlineOptions(stroke), size: stroke.size });
}

/**
 * The refit's strength (#32). A finished pen stroke is drawn from its points smoothed over
 * REFIT_RADIUS px of arc length on each side (a triangular weighting, narrowed near the ends so
 * the ends stay where they were drawn) and then thinned so that kept points are at least
 * REFIT_STEP px apart. This takes out the 0.5 px steps and hand tremor the Pencil reports,
 * which the live stroke shows; the stroke "settles" when the pen lifts. Larger values settle
 * more (and round tight corners more: a corner moves inward by at most about REFIT_RADIUS / 3).
 * Set REFIT_RADIUS to 0 to turn the refit off. The file keeps the raw points; the refit is
 * derived, like the outline.
 */
const REFIT_RADIUS = 1.5;
const REFIT_STEP = 0.3;

/**
 * How far apart a refit keeps its points for this stroke (refit's `step`, LiveFit's too). A
 * filled outline is computed from points REFIT_STEP apart; perfect-freehand then spaces the
 * outline's own points about `size / 2` apart, which smooths a large stroke's edges more than a
 * small one's. A stroked centreline (#60) is the curve through the refit points themselves, so
 * they are spaced 0.6 × size apart, but at least 0.6 px (so the Pencil's 0.5 px steps and 0.1 px
 * storage grid don't show at the smallest sizes, while tiny loops keep their shape within about
 * 0.15 px) and at most 1 px (as smooth as the outline was at 2.5 px, the default size). Measured
 * at 400% (test/run_view_test.py, section 32).
 */
export function refitStep(s: { tool: string; nib?: string; size: number }): number {
  return isStroked(s) ? Math.min(1, Math.max(0.6, Math.round(6 * s.size) / 10)) : REFIT_STEP;
}

/**
 * The points a finished pen stroke is drawn from: smoothed and thinned to points at least `step`
 * apart (see REFIT_RADIUS and refitStep), first and last points unchanged, pressure smoothed the
 * same way. Fewer than 3 points are returned as they are. Linear in the number of points for a
 * given sample spacing.
 */
export function refit(points: readonly Point[], step = REFIT_STEP): Point[] {
  const n = points.length;
  if (n < 3 || REFIT_RADIUS <= 0) return points.slice();
  // Arc length at each point.
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  const total = s[n - 1];
  const smooth: Point[] = new Array(n);
  smooth[0] = points[0];
  smooth[n - 1] = points[n - 1];
  let lo = 0, hi = 0;
  for (let i = 1; i < n - 1; i++) {
    // Symmetric window, no wider than the distance to the nearer end, so the ends don't pull in.
    const r = Math.min(REFIT_RADIUS, s[i], total - s[i]);
    while (s[lo] < s[i] - r) lo++;
    while (hi < n - 1 && s[hi + 1] <= s[i] + r) hi++;
    let w = 0, x = 0, y = 0, p = 0;
    for (let j = lo; j <= hi; j++) {
      const k = r > 0 ? 1 - Math.abs(s[j] - s[i]) / (r + 1e-9) : 1;
      if (k <= 0) continue;
      w += k; x += k * points[j].x; y += k * points[j].y; p += k * points[j].p;
    }
    smooth[i] = w > 0 ? { x: x / w, y: y / w, p: p / w, t: points[i].t } : points[i];
  }
  // Thin: keep points at least `step` from the last kept one; always keep the last.
  const out: Point[] = [smooth[0]];
  for (let i = 1; i < n - 1; i++) {
    const a = out[out.length - 1], b = smooth[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) >= step) out.push(b);
  }
  out.push(smooth[n - 1]);
  return out;
}

/**
 * The live stroke's points (#52): refit(points), computed incrementally as points arrive, so the
 * live stroke is drawn from the same smoothed points as the committed one and nothing moves when
 * the pen lifts. refit's smoothing of a point depends only on the points within REFIT_RADIUS of
 * arc length around it (its window narrows near the ends, which keeps the ends exact); once the
 * stroke has run on REFIT_RADIUS past a point, that point's smoothing and its thinning decision
 * are final. Those settled points are computed once and kept; each update only computes the
 * few points within REFIT_RADIUS of the tip (provisional, as refit of the stroke so far would
 * give them) and the new ones. The result equals refit(points) for every prefix (a unit test
 * checks it), so the tip stays exactly on the last sample. `points` must be the same growing
 * array (the live trace), appended to only.
 */
export class LiveFit {
  /** Arc length at each point seen. */
  private s: number[] = [];
  /** refit's output for the settled points (the first point and the smoothed, thinned ones). */
  private fitted: Point[] = [];
  /** The provisional points after them, the last sample last. */
  private rest: Point[] = [];
  /** The first point not settled yet, and refit's window bounds for it. */
  private next = 1;
  private lo = 0;
  private hi = 0;

  /** `step`: refit's, refitStep of the stroke. */
  constructor(private readonly step = REFIT_STEP) {}

  /** Brings the fit up to date with `points`; returns the number of points to draw. */
  update(points: readonly Point[]): number {
    const n = points.length, s = this.s;
    for (let i = s.length; i < n; i++) s.push(i ? s[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) : 0);
    if (n < 3 || REFIT_RADIUS <= 0) {
      // refit returns fewer than 3 points as they are (and everything when turned off).
      this.fitted.length = 0;
      this.rest = points.slice();
      return n;
    }
    const total = s[n - 1], fitted = this.fitted;
    if (!fitted.length) fitted.push(points[0]);
    // Settle the points REFIT_RADIUS or more before the tip: their window is final.
    while (this.next < n - 1 && total - s[this.next] >= REFIT_RADIUS) {
      const i = this.next++;
      const b = this.smooth(points, i, total);
      const a = fitted[fitted.length - 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) >= this.step) fitted.push(b);
    }
    // The rest as refit would give it now (windows narrowed toward the tip), thinned on from the
    // last settled point, and the last sample. The window bounds are put back afterwards.
    const rest: Point[] = [];
    let a = fitted[fitted.length - 1];
    const lo = this.lo, hi = this.hi;
    for (let i = this.next; i < n - 1; i++) {
      const b = this.smooth(points, i, total);
      if (Math.hypot(b.x - a.x, b.y - a.y) >= this.step) rest.push(a = b);
    }
    this.lo = lo;
    this.hi = hi;
    rest.push(points[n - 1]);
    this.rest = rest;
    return fitted.length + rest.length;
  }

  /** Points that no longer change: every point before this index is final. */
  get settled(): number {
    return this.fitted.length;
  }

  /** The points to draw from `from` to `to` (exclusive; default all), as update last computed them. */
  slice(from: number, to = Infinity): Point[] {
    const f = this.fitted, k = f.length;
    const end = Math.min(to, k + this.rest.length);
    if (from >= end) return [];
    if (end <= k) return f.slice(from, end);
    return (from < k ? f.slice(from) : []).concat(this.rest.slice(Math.max(0, from - k), end - k));
  }

  /** refit's smoothed point i (the same arithmetic, in the same order), moving the window bounds on. */
  private smooth(points: readonly Point[], i: number, total: number): Point {
    const s = this.s, n = points.length;
    const r = Math.min(REFIT_RADIUS, s[i], total - s[i]);
    let lo = this.lo, hi = this.hi;
    while (s[lo] < s[i] - r) lo++;
    while (hi < n - 1 && s[hi + 1] <= s[i] + r) hi++;
    let w = 0, x = 0, y = 0, p = 0;
    for (let j = lo; j <= hi; j++) {
      const k = r > 0 ? 1 - Math.abs(s[j] - s[i]) / (r + 1e-9) : 1;
      if (k <= 0) continue;
      w += k; x += k * points[j].x; y += k * points[j].y; p += k * points[j].p;
    }
    this.lo = lo;
    this.hi = hi;
    return w > 0 ? { x: x / w, y: y / w, p: p / w, t: points[i].t } : points[i];
  }
}

/** A closed polygon as `M x y L x y … Z`, dropping points that round onto the previous one. */
export function polygon(pts: readonly (readonly number[])[]): string {
  let d = '', last = '';
  for (const [x, y] of pts) {
    const xy = fmt1(x) + ' ' + fmt1(y);
    if (xy === last) continue;
    d += (d ? 'L' : 'M') + xy;
    last = xy;
  }
  return d ? d + 'Z' : '';
}

/**
 * A closed curve through an outline, perfect-freehand's recommended conversion: the midpoints
 * between consecutive points are on the curve and each point is the control point of a
 * quadratic (`M mid Q x y mid … Z`). Points that round onto the previous one are dropped first.
 */
export function smoothCurve(pts: readonly (readonly number[])[]): string {
  const q: number[][] = [];
  let last = '';
  for (const [x, y] of pts) {
    const xy = fmt1(x) + ' ' + fmt1(y);
    if (xy === last) continue;
    q.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    last = xy;
  }
  if (q.length > 1 && fmt1(q[0][0]) === fmt1(q[q.length - 1][0]) && fmt1(q[0][1]) === fmt1(q[q.length - 1][1])) q.pop();
  if (q.length < 3) return polygon(q);
  const mid = (a: number[], b: number[]) => fmt1((a[0] + b[0]) / 2) + ' ' + fmt1((a[1] + b[1]) / 2);
  let d = 'M' + mid(q[q.length - 1], q[0]);
  for (let i = 0; i < q.length; i++) d += 'Q' + fmt1(q[i][0]) + ' ' + fmt1(q[i][1]) + ' ' + mid(q[i], q[(i + 1) % q.length]);
  return d + 'Z';
}

/**
 * An open curve through a stroke's points, for stroking (#60): smoothCurve's conversion without
 * closing. The midpoints between consecutive points are on the curve and each inner point is the
 * control point of a quadratic; the curve starts at the first point and ends at the last
 * (`M p0 Q p1 m1 … Q p(n-2) p(n-1)`). Coordinates are rounded to 0.01 px, not 0.1 like the
 * outlines: a centreline's rounding moves both edges together, and 0.05 px is a tenth of a
 * 0.5 px line (at 10× zoom on a 2× display, a device pixel). Points that round onto the previous
 * one are dropped. Two points give a line; a single point (or points that all round onto one)
 * a zero-length line, which round caps draw as a dot `size` wide.
 */
export function centreline(pts: readonly { x: number; y: number }[]): string {
  const q: number[][] = [];
  let last = '';
  for (const { x, y } of pts) {
    const xy = fmt2(x) + ' ' + fmt2(y);
    if (xy === last) continue;
    q.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    last = xy;
  }
  const n = q.length;
  if (n === 0) return '';
  const at = (p: number[]) => fmt2(p[0]) + ' ' + fmt2(p[1]);
  if (n === 1) return `M${at(q[0])}L${at(q[0])}`;
  if (n === 2) return `M${at(q[0])}L${at(q[1])}`;
  const mid = (a: number[], b: number[]) => fmt2((a[0] + b[0]) / 2) + ' ' + fmt2((a[1] + b[1]) / 2);
  let d = 'M' + at(q[0]);
  for (let i = 1; i < n - 2; i++) d += 'Q' + at(q[i]) + ' ' + mid(q[i], q[i + 1]);
  return d + 'Q' + at(q[n - 2]) + ' ' + at(q[n - 1]);
}

/** Rounds to 0.01 and formats without trailing zeros or `-0`. */
export function fmt2(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? '0' : String(r);
}

/** A filled circle of radius `r` as two arcs. */
function dot(x: number, y: number, r: number): string {
  const rs = fmt1(r);
  return `M${fmt1(x - r)} ${fmt1(y)}A${rs} ${rs} 0 1 0 ${fmt1(x + r)} ${fmt1(y)}A${rs} ${rs} 0 1 0 ${fmt1(x - r)} ${fmt1(y)}Z`;
}

/** What strokePathCached last computed for a stroke object, and the fields it depended on. */
interface CachedPath {
  tool: string;
  nib: string | undefined;
  size: number;
  points: readonly Point[];
  n: number;
  first: Point;
  last: Point;
  d: string;
}
const paths = new WeakMap<object, CachedPath>();

/**
 * strokePath(stroke), memoised per stroke object (#37): the same string, computed again only
 * if the stroke's tool, nib, size or points (array identity, length, first or last point)
 * changed since. Strokes are replaced, not mutated, by every edit, so this is a hit for every
 * stroke but new ones; the key is a guard against in-place edits. Pure in output: the cache
 * only saves time. Shared by the renderer (Path2D) and writePage (the file's `d`).
 */
export function strokePathCached(stroke: OutlineInput): string {
  const { tool, size, points } = stroke;
  const nib = stroke.tool === 'pen' ? stroke.nib : undefined;
  const n = points.length, first = points[0], last = points[n - 1];
  const c = paths.get(stroke);
  if (c && c.tool === tool && c.nib === nib && c.size === size && c.points === points && c.n === n && c.first === first && c.last === last) return c.d;
  const d = flat(strokePath(stroke));
  paths.set(stroke, { tool, nib, size, points, n, first, last, d });
  return d;
}

/**
 * The string as one flat buffer. strokePath builds `d` by appending, which V8 keeps as a tree
 * of pieces (a rope); joining a thousand cached ropes into the file walked every tree again on
 * each save (about 60 ms for 1,000 strokes). Number() of a non-numeric string flattens it.
 */
function flat(s: string): string {
  Number(s);
  return s;
}

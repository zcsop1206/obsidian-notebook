// Stroke paths: each stroke is drawn as one path computed from its points. The pressure nib and
// the highlighter are filled outlines computed with perfect-freehand; the uniform nib (#60) is
// its refitted centreline, stroked `size` wide with round caps and joins (isStroked). The paths
// are derived data; a page's <metadata> is the source of truth.
//
// The uniform pen's tunables (#69), stored per stroke so that changing the settings never
// changes a stroke already written; each is absent in strokes written before #69 (and with the
// default settings), which means today's drawing:
// - `smooth`: the refit's radius in px (refitRadius; absent 1.5, 0 off); refitStep scales with it.
// - `stab`: a capture-time stabiliser, 0..1 (stabilise; absent 0): an exponential follow of the
//   samples, perfect-freehand's streamline, applied before the refit, live and committed alike
//   (LiveFit). The file keeps the raw samples; the stabilised points are derived like the refit.
// - `taper`: tapered ends, in multiples of the size (absent 0). The representation: the stroke
//   stays a stroked centreline for its even middle, and its two ends are one more path, filled
//   (both ends as closed polygons, wound the same way, nonzero), so the middle keeps #60's exact
//   width at every zoom. The middle is the untapered centreline's own curve cut at arc length L
//   from each end (its quadratics split exactly, by blossoming), L = min(taper × size, half the
//   length); each end is that curve from the tip to L, sampled 12 to 64 times and offset by a
//   width growing from TAPER_TIP × size at the (round) tip to `size` at L, where the middle's
//   round cap covers the join. The page SVG holds a tapered stroke as
//   `<g data-id><path stroked middle/><path filled ends/></g>`; the editor (paintPath), the
//   lasso's area (strokePath2D) and the PDF export (#18: `S`, then `f`) draw the same two paths,
//   so the editor, Obsidian's reading view, GitHub and the PDF agree. (Alternatives rejected: a
//   filled outline of the whole stroke would bring back the width wobble #60 removed; a variable
//   stroke width doesn't exist in SVG, canvas or PDF.)
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

/** What an outline depends on (#69: and a pen stroke's smoothing, stabiliser and taper, if set). */
export type OutlineInput = Pick<PenStroke, 'tool' | 'nib' | 'size' | 'points' | 'smooth' | 'stab' | 'taper'> | Pick<HighlighterStroke, 'tool' | 'size' | 'points'>;

/** A stroke's tunables (#69), as far as the path depends on them. */
type Tuned = { tool: string; nib?: string; smooth?: number; stab?: number; taper?: number };

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
 * With a taper (#69) it's the even middle of the centreline; strokeGeometry also gives the ends.
 * `ends` (a tapered stroke's live pieces, see strokeGeometry) says which ends are tapered.
 */
export function strokePath(stroke: OutlineInput, live = false, ends: TaperEnds = 'both'): string {
  return strokeGeometry(stroke, live, ends).d;
}

/** Which ends of a stroke (or of a live piece of one) are tapered (#69). */
export type TaperEnds = 'both' | 'head' | 'tail' | 'none';

/**
 * What a stroke is drawn as: `d`, its path (strokePath), and `ends`, the filled path of a
 * tapered uniform stroke's ends (#69; '' without a taper; see the header). With `live`, the
 * points are taken as already refitted (the pen's live overlay, LiveFit). `ends` picks the ends
 * to taper: the live overlay draws a long stroke in pieces, only the first having the stroke's
 * start and only the last its end. A piece with one end tapers it over min(taper × size, its own
 * length) instead of half the length: the same as the whole stroke's whenever the stroke is at
 * least twice the taper long, which every stroke long enough to be drawn in pieces is (over
 * 100 px) unless taper × size is over 50 px.
 */
export function strokeGeometry(stroke: OutlineInput, live = false, ends: TaperEnds = 'both'): StrokeGeometry {
  if (!isStroked(stroke)) return { d: outlinePath(stroke, live), ends: '' };
  const pts = live ? stroke.points : fitPoints(stroke);
  const taper = taperOf(stroke);
  if (!(taper > 0) || ends === 'none') return { d: centreline(pts), ends: '' };
  return tapered(centrelinePoints(pts), stroke.size, taper * stroke.size, ends);
}

export interface StrokeGeometry {
  /** The path: a filled outline, or a centreline to stroke (isStroked). */
  d: string;
  /** A tapered stroke's ends, to fill (#69); '' for none. */
  ends: string;
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
 * same refit, computed incrementally by LiveFit, #52) and for the highlighter. A filled
 * outline's refit keeps points REFIT_STEP apart (scaled by the stroke's own radius, #69) for
 * either nib: the uniform nib's outline (outlinePath, its pre-#60 drawing) too.
 */
export function strokeOutline(stroke: OutlineInput, live = false): number[][] {
  const points = stroke.tool === 'pen' && !live ? fitPoints(stroke, scaledStep(REFIT_STEP, stroke)) : stroke.points;
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
 * derived, like the outline. Since #69 a pen stroke may carry its own radius (`smooth`,
 * refitRadius); REFIT_RADIUS is the radius of strokes without one.
 */
export const REFIT_RADIUS = 1.5;
const REFIT_STEP = 0.3;

/** A stroke's refit radius in px (#69): its `smooth`, or REFIT_RADIUS. */
export function refitRadius(s: Tuned): number {
  return s.tool === 'pen' && s.smooth !== undefined ? s.smooth : REFIT_RADIUS;
}

/** A pen stroke's stabiliser (#69): its `stab`, 0..1, or 0 (none). */
export function stabOf(s: Tuned): number {
  return s.tool === 'pen' && s.stab !== undefined && s.stab > 0 ? Math.min(1, s.stab) : 0;
}

/** A stroke's taper (#69) in multiples of its size: its `taper` if it's a stroked centreline, else 0. */
export function taperOf(s: Tuned): number {
  return isStroked(s) && s.taper !== undefined && s.taper > 0 ? s.taper : 0;
}

/**
 * How far each stabilised point moves toward the next sample (#69): perfect-freehand's
 * streamline formula, so a stabiliser of 0.35 follows as the pressure nib's STREAMLINE does.
 * 0 follows the samples exactly (1); 1 moves 0.15 of the way.
 */
export const followRate = (stab: number) => 0.15 + (1 - stab) * 0.85;

/**
 * The stabiliser (#69): each point moved `followRate(stab)` of the way from the previous
 * stabilised point toward its sample (the first point kept), then the last sample itself, so the
 * line ends where the pen lifted. Pressure and times are the samples'. stab 0 (or fewer than 2
 * points): the points as they are. Applied before the refit; LiveFit computes the same.
 */
export function stabilise(points: readonly Point[], stab: number): Point[] {
  const n = points.length;
  if (!(stab > 0) || n < 2) return points.slice();
  const rate = followRate(stab), out: Point[] = [points[0]];
  let x = points[0].x, y = points[0].y;
  for (let i = 1; i < n; i++) {
    const q = points[i];
    x = x + rate * (q.x - x);
    y = y + rate * (q.y - y);
    out.push({ x, y, p: q.p, t: q.t });
  }
  const last = points[n - 1];
  if (x !== last.x || y !== last.y) out.push(last);
  return out;
}

/**
 * The points a finished pen stroke is drawn from: its samples stabilised (#69, if it has a
 * stabiliser) and refitted with its own radius and step.
 */
export function fitPoints(s: OutlineInput, step = refitStep(s)): Point[] {
  const stab = stabOf(s);
  return refit(stab ? stabilise(s.points, stab) : s.points, step, refitRadius(s));
}

/** The live overlay's refit of a stroke in progress (#52), with the stroke's radius, step and stabiliser (#69). */
export function liveFit(s: Tuned & { size: number }): LiveFit {
  return new LiveFit(refitStep(s), refitRadius(s), stabOf(s));
}

/**
 * How far apart a refit keeps its points for this stroke (refit's `step`, LiveFit's too). A
 * filled outline is computed from points REFIT_STEP apart; perfect-freehand then spaces the
 * outline's own points about `size / 2` apart, which smooths a large stroke's edges more than a
 * small one's. A stroked centreline (#60) is the curve through the refit points themselves, so
 * they are spaced 0.6 × size apart, but at least 0.6 px (so the Pencil's 0.5 px steps and 0.1 px
 * storage grid don't show at the smallest sizes, while tiny loops keep their shape within about
 * 0.15 px) and at most 1 px (as smooth as the outline was at 2.5 px, the default size). Measured
 * at 400% (test/run_view_test.py, section 32). With a stroke's own refit radius (#69), the step
 * scales with it (radius / REFIT_RADIUS), so stronger smoothing also keeps fewer points.
 */
export function refitStep(s: Tuned & { size: number }): number {
  return scaledStep(isStroked(s) ? Math.min(1, Math.max(0.6, Math.round(6 * s.size) / 10)) : REFIT_STEP, s);
}

/** A refit step scaled by the stroke's own radius (#69); `base` itself at REFIT_RADIUS. */
function scaledStep(base: number, s: Tuned): number {
  const r = refitRadius(s);
  return r > 0 && r !== REFIT_RADIUS ? base * r / REFIT_RADIUS : base;
}

/**
 * Points smoothed over `radius` px of arc length (see REFIT_RADIUS) and thinned to points at
 * least `step` apart (see refitStep), first and last points unchanged, pressure smoothed the
 * same way. Fewer than 3 points, or a radius of 0, return the points as they are. Linear in the
 * number of points for a given sample spacing.
 */
export function refit(points: readonly Point[], step = REFIT_STEP, radius = REFIT_RADIUS): Point[] {
  const n = points.length;
  if (n < 3 || radius <= 0) return points.slice();
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
    const r = Math.min(radius, s[i], total - s[i]);
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
 *
 * With a stabiliser (#69) the fit is of stabilise(points): the stabilised points are computed as
 * samples arrive and never change (each depends on the ones before), except the last sample,
 * appended after them as the tip, which is replaced when the next sample comes. So a point
 * settles only once the stabilised points without the tip have run on `radius` past it; any
 * point that comes later is further along than that, and its window is final as before.
 */
export class LiveFit {
  /** Arc length at each point of the fitted sequence (the samples, or the stabilised points and the tip). */
  private s: number[] = [];
  /** With a stabiliser: the stabilised points so far, then the tip if it differs from the last. */
  private own: Point[] = [];
  /** Samples stabilised so far, and whether `own` ends with the tip. */
  private followed = 0;
  private tip = false;
  /** How far each stabilised point follows its sample (followRate); 1: no stabiliser. */
  private readonly rate: number;
  /** refit's output for the settled points (the first point and the smoothed, thinned ones). */
  private fitted: Point[] = [];
  /** The provisional points after them, the last sample last. */
  private rest: Point[] = [];
  /** The first point not settled yet, and refit's window bounds for it. */
  private next = 1;
  private lo = 0;
  private hi = 0;

  /**
   * `step` and `radius`: refit's, refitStep and refitRadius of the stroke; `stab`: its
   * stabiliser (#69). liveFit(stroke) makes one from a stroke's settings.
   */
  constructor(private readonly step = REFIT_STEP, private readonly radius = REFIT_RADIUS, stab = 0) {
    this.rate = stab > 0 ? followRate(stab) : 1;
  }

  /** Brings the fit up to date with `points`; returns the number of points to draw. */
  update(points: readonly Point[]): number {
    const s = this.s;
    let pts: readonly Point[] = points, stable = points.length;
    if (this.rate < 1) {
      // stabilise(points), extended: drop the old tip, follow the new samples, add the new tip.
      const own = this.own, rate = this.rate;
      if (this.tip) {
        own.pop();
        s.pop();
        this.tip = false;
      }
      for (let i = this.followed; i < points.length; i++) {
        const q = points[i], a = own[own.length - 1];
        const pt = a ? { x: a.x + rate * (q.x - a.x), y: a.y + rate * (q.y - a.y), p: q.p, t: q.t } : q;
        s.push(a ? s[s.length - 1] + Math.hypot(pt.x - a.x, pt.y - a.y) : 0);
        own.push(pt);
      }
      this.followed = points.length;
      stable = own.length;
      const last = points[points.length - 1], f = own[own.length - 1];
      if (points.length > 1 && (f.x !== last.x || f.y !== last.y)) {
        s.push(s[s.length - 1] + Math.hypot(last.x - f.x, last.y - f.y));
        own.push(last);
        this.tip = true;
      }
      pts = own;
    } else {
      for (let i = s.length; i < points.length; i++) s.push(i ? s[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) : 0);
    }
    const n = pts.length, R = this.radius;
    if (n < 3 || R <= 0) {
      // refit returns fewer than 3 points as they are (and everything when turned off).
      this.fitted.length = 0;
      this.rest = pts.slice();
      return n;
    }
    const total = s[n - 1], fitted = this.fitted;
    if (!fitted.length) fitted.push(pts[0]);
    // Settle the points `radius` or more before the tip (before the last stabilised point, with a
    // stabiliser): their window is final.
    const settledTo = s[stable - 1];
    while (this.next < n - 1 && settledTo - s[this.next] >= R) {
      const i = this.next++;
      const b = this.smooth(pts, i, total);
      const a = fitted[fitted.length - 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) >= this.step) fitted.push(b);
    }
    // The rest as refit would give it now (windows narrowed toward the tip), thinned on from the
    // last settled point, and the last sample. The window bounds are put back afterwards.
    const rest: Point[] = [];
    let a = fitted[fitted.length - 1];
    const lo = this.lo, hi = this.hi;
    for (let i = this.next; i < n - 1; i++) {
      const b = this.smooth(pts, i, total);
      if (Math.hypot(b.x - a.x, b.y - a.y) >= this.step) rest.push(a = b);
    }
    this.lo = lo;
    this.hi = hi;
    rest.push(pts[n - 1]);
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
    const r = Math.min(this.radius, s[i], total - s[i]);
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
  return centrelineOf(centrelinePoints(pts));
}

/** centreline's points: rounded to 0.01 px, those that round onto the previous one dropped. */
function centrelinePoints(pts: readonly { x: number; y: number }[]): number[][] {
  const q: number[][] = [];
  let last = '';
  for (const { x, y } of pts) {
    const xy = fmt2(x) + ' ' + fmt2(y);
    if (xy === last) continue;
    q.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    last = xy;
  }
  return q;
}

/** The open curve through centrelinePoints (see centreline). */
function centrelineOf(q: readonly number[][]): string {
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

// ---- tapered ends (#69)

/** A tapered end's width at its tip, over the size (the tip is a round end of this width). */
export const TAPER_TIP = 0.15;

/**
 * A tapered end's width over the size at `u` (0 at the tip, 1 where the even middle starts): an
 * ease-out from TAPER_TIP to 1, level where it meets the middle, so the edge has no corner there.
 */
export const taperWidth = (u: number) => TAPER_TIP + (1 - TAPER_TIP) * (1 - (1 - u) * (1 - u));

type XY = [number, number];
/** One piece of a centreline: a quadratic from a to b with control c, or a line (c null). */
interface Seg { a: XY; c: XY | null; b: XY }

const r2 = (v: number) => Math.round(v * 100) / 100;

/** centrelineOf's pieces, with the same (rounded) numbers it writes; at least 2 points. */
function segments(q: readonly number[][]): Seg[] {
  const n = q.length, p = (i: number): XY => [q[i][0], q[i][1]];
  if (n === 2) return [{ a: p(0), c: null, b: p(1) }];
  const mid = (i: number): XY => [r2((q[i][0] + q[i + 1][0]) / 2), r2((q[i][1] + q[i + 1][1]) / 2)];
  const out: Seg[] = [];
  for (let i = 1; i <= n - 2; i++) out.push({ a: i === 1 ? p(0) : mid(i - 1), c: p(i), b: i === n - 2 ? p(n - 1) : mid(i) });
  return out;
}

/** The point of a piece at t. */
function pointAt(g: Seg, t: number): XY {
  const { a, c, b } = g, u = 1 - t;
  if (!c) return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** The direction of a piece at t (not normalised; 0 only for a degenerate piece). */
function tangentAt(g: Seg, t: number): XY {
  const { a, c, b } = g;
  if (!c) return [b[0] - a[0], b[1] - a[1]];
  return [2 * (1 - t) * (c[0] - a[0]) + 2 * t * (b[0] - c[0]), 2 * (1 - t) * (c[1] - a[1]) + 2 * t * (b[1] - c[1])];
}

/** The part of a piece from t0 to t1, exactly (a quadratic's control point by blossoming). */
function subSeg(g: Seg, t0: number, t1: number): Seg {
  if (!g.c) return { a: pointAt(g, t0), c: null, b: pointAt(g, t1) };
  const { a, c, b } = g, k0 = (1 - t0) * (1 - t1), k1 = (1 - t0) * t1 + t0 * (1 - t1), k2 = t0 * t1;
  return { a: pointAt(g, t0), c: [k0 * a[0] + k1 * c[0] + k2 * b[0], k0 * a[1] + k1 * c[1] + k2 * b[1]], b: pointAt(g, t1) };
}

/**
 * Arc length along the pieces: each piece flattened (chords within 0.01 px of the curve, at most
 * 0.5 px long) into samples of (piece, t, arc length), and the inverse, `at(s)`.
 */
function arcTable(segs: readonly Seg[]) {
  const g: number[] = [0], ts: number[] = [0], ss: number[] = [0];
  let total = 0;
  segs.forEach((seg, i) => {
    let k = 1;
    if (seg.c) {
      const { a, c, b } = seg, bend = Math.hypot(a[0] - 2 * c[0] + b[0], a[1] - 2 * c[1] + b[1]) / 4;
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(b[0] - c[0], b[1] - c[1]);
      k = Math.max(1, Math.min(64, Math.max(Math.ceil(Math.sqrt(bend / 0.01)), Math.ceil(len / 0.5))));
    }
    let prev = pointAt(seg, 0);
    for (let j = 1; j <= k; j++) {
      const t = j / k, pt = pointAt(seg, t);
      total += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
      g.push(i); ts.push(t); ss.push(total);
      prev = pt;
    }
  });
  /** The piece and t at arc length s (clamped to the curve). */
  const at = (s: number): { i: number; t: number } => {
    if (s <= 0) return { i: 0, t: 0 };
    if (s >= total) return { i: segs.length - 1, t: 1 };
    let lo = 0, hi = ss.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ss[m] <= s) lo = m;
      else hi = m;
    }
    const i = g[hi], t0 = g[lo] === i ? ts[lo] : 0, t1 = ts[hi];
    const f = ss[hi] > ss[lo] ? (s - ss[lo]) / (ss[hi] - ss[lo]) : 0;
    return { i, t: t0 + (t1 - t0) * f };
  };
  return { total, at };
}

/**
 * A tapered stroke (#69, see the header): the even middle of the centreline through `q`
 * (centrelinePoints) between arc lengths L and total − L, and the ends to fill. `len` is
 * taper × size; L is at most half the length with both ends tapered, at most the length with one.
 */
function tapered(q: readonly number[][], size: number, len: number, which: TaperEnds): StrokeGeometry {
  if (q.length < 2) return { d: centrelineOf(q), ends: '' };
  const segs = segments(q), { total, at } = arcTable(segs);
  const head = which === 'both' || which === 'head', tail = which === 'both' || which === 'tail';
  const L = Math.min(len, head && tail ? total / 2 : total);
  if (!(total > 0) || !(L > 0)) return { d: centrelineOf(q), ends: '' };
  const s0 = head ? L : 0, s1 = tail ? total - L : total;
  // The middle: the pieces from s0 to s1, the end pieces cut exactly.
  const A = at(s0), B = at(s1);
  const parts: Seg[] = [];
  if (A.i === B.i) parts.push(subSeg(segs[A.i], A.t, B.t));
  else {
    parts.push(subSeg(segs[A.i], A.t, 1));
    for (let i = A.i + 1; i < B.i; i++) parts.push(segs[i]);
    parts.push(subSeg(segs[B.i], 0, B.t));
  }
  const xy = (p: XY) => fmt2(p[0]) + ' ' + fmt2(p[1]);
  const start = xy(parts[0].a);
  let d = 'M' + start, cur = start;
  for (const p of parts) {
    const c = p.c ? xy(p.c) : null, b = xy(p.b);
    if (b === cur && (c === null || c === cur)) continue; // rounds onto a point
    d += c ? 'Q' + c + ' ' + b : 'L' + b;
    cur = b;
  }
  // Nothing left between the ends (or under 0.01 px): a zero-length line, a dot `size` wide.
  if (d === 'M' + start) d += 'L' + start;
  const ends = [head ? end(segs, at, 0, L, 1, size) : '', tail ? end(segs, at, total, L, -1, size) : ''].join('');
  return { d, ends };
}

/**
 * One tapered end as a closed polygon: the curve from its tip at arc length `tip` over `L`
 * (dir 1: forward, -1: backward), offset each side by half of size × taperWidth, around a round
 * tip, wound like canvas arc() (positive shoelace area in page px, y down), so that the ends and
 * the middle's area (centrelineArea) add up under nonzero filling.
 */
function end(segs: readonly Seg[], at: (s: number) => { i: number; t: number }, tip: number, L: number, dir: 1 | -1, size: number): string {
  const m = Math.max(12, Math.min(64, Math.ceil(L / 0.5)));
  const left: XY[] = [], right: XY[] = [];
  let tip0: { p: XY; t: XY; r: number } | null = null, prevT: XY = [1, 0];
  for (let j = 0; j <= m; j++) {
    const s = tip + dir * (j === m ? L : L * j / m), { i, t } = at(s);
    const p = pointAt(segs[i], t), v = tangentAt(segs[i], t), l = Math.hypot(v[0], v[1]);
    const u: XY = l > 1e-9 ? [dir * v[0] / l, dir * v[1] / l] : prevT;
    prevT = u;
    const r = size * taperWidth(j / m) / 2, nx = -u[1] * r, ny = u[0] * r;
    left.push([p[0] + nx, p[1] + ny]);
    right.push([p[0] - nx, p[1] - ny]);
    if (j === 0) tip0 = { p, t: u, r };
  }
  const poly: XY[] = [...left, ...right.reverse()];
  // The round tip: from the right side round the back to the left side.
  const { p, t, r } = tip0!;
  for (let k = 1; k < 6; k++) {
    const phi = k * Math.PI / 6, c = Math.cos(phi), sn = Math.sin(phi);
    // -n cos(phi) - t sin(phi), n = (-t.y, t.x)
    poly.push([p[0] + r * (t[1] * c - t[0] * sn), p[1] + r * (-t[0] * c - t[1] * sn)]);
  }
  let area = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) poly.reverse();
  let d = '', last = '';
  for (const pt of poly) {
    const xy = fmt2(pt[0]) + ' ' + fmt2(pt[1]);
    if (xy === last) continue;
    d += (d ? 'L' : 'M') + xy;
    last = xy;
  }
  return d ? d + 'Z' : '';
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
  /** The pen's tunables (#69). */
  smooth: number | undefined;
  stab: number | undefined;
  taper: number | undefined;
  d: string;
  ends: string;
}
const paths = new WeakMap<object, CachedPath>();

/**
 * strokePath(stroke), memoised per stroke object (#37): the same string, computed again only
 * if the stroke's tool, nib, size, tunables (#69) or points (array identity, length, first or
 * last point) changed since. Strokes are replaced, not mutated, by every edit, so this is a hit
 * for every stroke but new ones; the key is a guard against in-place edits. Pure in output: the
 * cache only saves time. Shared by the renderer (Path2D) and writePage (the file's `d`).
 */
export function strokePathCached(stroke: OutlineInput): string {
  return strokeGeometryCached(stroke).d;
}

/** strokeGeometry(stroke), memoised like strokePathCached (#69: the tapered ends with the path). */
export function strokeGeometryCached(stroke: OutlineInput): StrokeGeometry {
  const { tool, size, points } = stroke;
  const pen = stroke.tool === 'pen' ? stroke : null;
  const nib = pen?.nib, smooth = pen?.smooth, stab = pen?.stab, taper = pen?.taper;
  const n = points.length, first = points[0], last = points[n - 1];
  const c = paths.get(stroke);
  if (c && c.tool === tool && c.nib === nib && c.size === size && c.points === points && c.n === n && c.first === first && c.last === last &&
    c.smooth === smooth && c.stab === stab && c.taper === taper) return c;
  const g = strokeGeometry(stroke);
  const e: CachedPath = { tool, nib, size, points, n, first, last, smooth, stab, taper, d: flat(g.d), ends: flat(g.ends) };
  paths.set(stroke, e);
  return e;
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

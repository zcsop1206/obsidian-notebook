// Stroke outlines: each stroke is drawn as one filled path computed from its points with
// perfect-freehand. The paths are derived data; a page's <metadata> is the source of truth.
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

/** Rounds to 0.1 and formats without a trailing `.0` or `-0`. */
export function fmt1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? '0' : String(r);
}

/**
 * The SVG path `d` for a stroke's filled outline, with coordinates rounded to 0.1 px. The pen's
 * outline is drawn with quadratic curves through its points (smoothCurve), so its edges are
 * curved rather than a polygon's straight segments; the highlighter's stays a polygon, to keep
 * its flat ends square.
 */
export function strokePath(stroke: OutlineInput, live = false): string {
  const { points, size } = stroke;
  if (points.length === 0) return '';
  if (points.length === 1) return dot(points[0].x, points[0].y, size / 2);
  const outline = strokeOutline(stroke, live);
  return stroke.tool === 'pen' ? smoothCurve(outline) : polygon(outline);
}

/**
 * The outline's points, as perfect-freehand computes them: of the refitted points for a
 * finished pen stroke, of the raw points for a live one (`live`) and for the highlighter.
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
 * The points a finished pen stroke is drawn from: smoothed and thinned (see REFIT_RADIUS),
 * first and last points unchanged, pressure smoothed the same way. Fewer than 3 points are
 * returned as they are. Linear in the number of points for a given sample spacing.
 */
export function refit(points: readonly Point[]): Point[] {
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
  // Thin: keep points at least REFIT_STEP from the last kept one; always keep the last.
  const out: Point[] = [smooth[0]];
  for (let i = 1; i < n - 1; i++) {
    const a = out[out.length - 1], b = smooth[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) >= REFIT_STEP) out.push(b);
  }
  out.push(smooth[n - 1]);
  return out;
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

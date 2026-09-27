// The partial eraser's geometry (#15): the part of a stroke under the eraser is cut out, and
// what's left becomes new strokes. Pure; the ink view hit-tests through the page's spatial
// index first and splits only the strokes it hit.
//
// - Reach: a point is erased if it lies within r + halfWidth(stroke) of the eraser's path (a
//   polyline in page px, or a single point for a tap), the same test SpatialIndex uses, so a
//   stroke the index reports as hit always loses at least one point.
// - Clean cuts: where the stroke goes from a kept point to an erased one (or back), a boundary
//   point is inserted on the segment between them, where it crosses the eraser's reach (found
//   by bisection; x, y, p and t interpolated), so a remnant ends at the eraser's edge rather
//   than at the nearest sample. The boundary point is rounded as the format stores it (roundXY,
//   roundP, whole ms) and kept only if it is still strictly outside the reach after rounding,
//   so the next frame of the same drag doesn't hit the remnant again.
// - Remnants: each run of kept points is a new stroke with the original's style (tool, colour,
//   size, nib) and a new id (newStrokeId, unique among `taken`, which grows). Its times are
//   rebased so its first point has t = 0, as the format defines t. Runs of fewer than 2 points
//   are dropped. Highlighter strokes split the same way as pen strokes.
import { newStrokeId, type RandomSource, cryptoRandom } from '../format/ids';
import { roundP, roundXY, type Point, type Stroke } from '../format/page';
import { halfWidth, type XY } from './spatial';

/** Bisection steps for a boundary point (the segment is at most a few px: well under 0.01 px). */
const STEPS = 14;

/** Squared distance from (x, y) to the polyline `path` (a point if it has one point). */
export function dist2ToPath(x: number, y: number, path: readonly XY[]): number {
  if (path.length === 1) {
    const dx = x - path[0].x, dy = y - path[0].y;
    return dx * dx + dy * dy;
  }
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const ax = path[i - 1].x, ay = path[i - 1].y, dx = path[i].x - ax, dy = path[i].y - ay;
    const px = x - ax, py = y - ay, len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return best;
}

const lerp = (a: Point, b: Point, u: number): Point => ({
  x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, p: a.p + (b.p - a.p) * u, t: a.t + (b.t - a.t) * u,
});

/**
 * The point where the segment from `kept` (outside the reach) to `gone` (inside) crosses the
 * reach, rounded, or null if rounding put it inside.
 */
function boundary(kept: Point, gone: Point, path: readonly XY[], reach2: number): Point | null {
  let lo = 0, hi = 1;
  for (let i = 0; i < STEPS; i++) {
    const m = (lo + hi) / 2, q = lerp(kept, gone, m);
    if (dist2ToPath(q.x, q.y, path) > reach2) lo = m;
    else hi = m;
  }
  // Rounding can put the crossing back inside the reach: step back towards `kept` by up to two
  // storage steps (0.1 px) before giving up.
  const len = Math.hypot(gone.x - kept.x, gone.y - kept.y), back = len > 0 ? 0.1 / len : 1;
  for (let k = 0; k < 3; k++) {
    const u = lo - k * back;
    if (u <= 0) break;
    const q = lerp(kept, gone, u);
    const r = { x: roundXY(q.x), y: roundXY(q.y), p: roundP(q.p), t: Math.round(q.t) };
    if (r.x === kept.x && r.y === kept.y) break;
    if (dist2ToPath(r.x, r.y, path) > reach2) return r;
  }
  return null;
}

/**
 * Cuts the part of `stroke` within `radius` + its half width of `path` out of it. Returns null
 * if no point is within reach (the stroke is untouched), otherwise the remnants as new strokes
 * (possibly none), in drawing order, with new ids added to `taken`.
 */
export function splitStroke(stroke: Stroke, path: readonly XY[], radius: number, taken: Set<string>, random: RandomSource = cryptoRandom): Stroke[] | null {
  const pts = stroke.points;
  if (!path.length || !pts.length) return null;
  const reach = radius + halfWidth(stroke), reach2 = reach * reach;
  // The path's box grown by the reach: points outside it are kept without measuring.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { x, y } of path) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  x0 -= reach; y0 -= reach; x1 += reach; y1 += reach;
  const gone: boolean[] = new Array(pts.length);
  let any = false;
  for (let i = 0; i < pts.length; i++) {
    const { x, y } = pts[i];
    gone[i] = x >= x0 && x <= x1 && y >= y0 && y <= y1 && dist2ToPath(x, y, path) <= reach2;
    if (gone[i]) any = true;
  }
  if (!any) return null;
  const runs: Point[][] = [];
  let run: Point[] | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!gone[i]) {
      if (!run) {
        run = [];
        runs.push(run);
        const b = i > 0 ? boundary(p, pts[i - 1], path, reach2) : null;
        if (b) run.push(b);
      }
      run.push(p);
    } else if (run) {
      const b = boundary(pts[i - 1], p, path, reach2);
      if (b) run.push(b);
      run = null;
    }
  }
  const out: Stroke[] = [];
  for (const r of runs) {
    if (r.length < 2) continue;
    const t0 = r[0].t;
    let prev = 0;
    const points = r.map(q => {
      const t = Math.max(prev, q.t - t0);
      prev = t;
      return { x: q.x, y: q.y, p: q.p, t };
    });
    const id = newStrokeId(taken, random);
    taken.add(id);
    out.push({ ...stroke, id, points });
  }
  return out;
}

// The lasso's geometry (#11). Pure; the ink view and input.ts do the rest.
//
// - Selecting: a free-form loop (the lasso's samples, closed back to its start) selects the
//   strokes with more than half their points inside it (even-odd rule, so a loop that crosses
//   itself leaves its twisted parts out, as it looks).
// - Bounds: the box of the strokes' points grown by each stroke's half width (halfWidth, as the
//   eraser reaches), so it encloses the ink.
// - Transforms: a uniform scale by `k` around (ox, oy), then a move by (dx, dy), in page px. A
//   stroke transformed has its points and size rewritten, rounded as the format stores them
//   (roundXY, roundSize), and its size is at least MIN_STROKE_SIZE; pressure and times are kept.
// - Clipboard: strokes as JSON tagged CLIP_FORMAT (see encodeClip).
import { newStrokeId, type RandomSource, cryptoRandom } from '../format/ids';
import { roundSize, roundXY, type Stroke } from '../format/page';
import { halfWidth, type XY } from './spatial';

/** The smallest stroke width a resize leaves, page px. */
export const MIN_STROKE_SIZE = 0.5;
/** Limits of a resize's scale factor. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 20;
/** A resize keeps the box at least this big, page px. */
export const MIN_BOX = 4;
/** The tag of strokes put on the system clipboard. */
export const CLIP_FORMAT = 'notebook-ink/strokes';

/** A box in page px: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

/** Scale by k around (ox, oy), then move by (dx, dy). */
export interface Transform {
  k: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
}

export const IDENTITY: Readonly<Transform> = Object.freeze({ k: 1, ox: 0, oy: 0, dx: 0, dy: 0 });

export const moveBy = (dx: number, dy: number): Transform => ({ k: 1, ox: 0, oy: 0, dx, dy });

export const isIdentity = (t: Transform) => t.k === 1 && t.dx === 0 && t.dy === 0;

/** Whether (x, y) is inside the polygon (closed implicitly; even-odd rule). */
export function pointInPolygon(x: number, y: number, poly: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** How many of the stroke's points are inside the polygon. */
export function pointsInside(stroke: Stroke, poly: readonly XY[]): number {
  let n = 0;
  for (const p of stroke.points) if (pointInPolygon(p.x, p.y, poly)) n++;
  return n;
}

/**
 * The ids of the strokes with more than half their points inside the loop, in page order. A
 * loop of fewer than 3 points (a tap) selects nothing.
 */
export function lassoSelect(strokes: readonly Stroke[], loop: readonly XY[]): string[] {
  if (loop.length < 3) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { x, y } of loop) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const out: string[] = [];
  for (const s of strokes) {
    const need = Math.floor(s.points.length / 2) + 1; // more than half
    let n = 0, left = s.points.length;
    for (const p of s.points) {
      left--;
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && pointInPolygon(p.x, p.y, loop)) n++;
      if (n >= need || n + left < need) break;
    }
    if (n >= need) out.push(s.id);
  }
  return out;
}

/** The box around the strokes' ink (points grown by half widths), or null for none. */
export function strokesBounds(strokes: Iterable<Stroke>): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const hw = halfWidth(s);
    for (const { x, y } of s.points) {
      if (x - hw < x0) x0 = x - hw;
      if (y - hw < y0) y0 = y - hw;
      if (x + hw > x1) x1 = x + hw;
      if (y + hw > y1) y1 = y + hw;
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/** The box transformed (exactly; the strokes' rounding can differ by 0.05 px). */
export function transformBox(b: Box, t: Transform): Box {
  return [t.ox + (b[0] - t.ox) * t.k + t.dx, t.oy + (b[1] - t.oy) * t.k + t.dy, t.ox + (b[2] - t.ox) * t.k + t.dx, t.oy + (b[3] - t.oy) * t.k + t.dy];
}

/** A copy of the stroke transformed, points and size rounded as stored, size at least MIN_STROKE_SIZE. */
export function transformStroke<S extends Stroke>(s: S, t: Transform): S {
  const { k, ox, oy, dx, dy } = t;
  const points = s.points.map(p => ({ x: roundXY(ox + (p.x - ox) * k + dx), y: roundXY(oy + (p.y - oy) * k + dy), p: p.p, t: p.t }));
  const size = k === 1 ? s.size : Math.max(MIN_STROKE_SIZE, roundSize(s.size * k));
  return { ...s, points, size };
}

/**
 * The scale of a resize by the corner handle: the box's top-left corner stays, the bottom-right
 * one follows the pointer's projection on the diagonal (so the shape keeps its proportions).
 * Clamped to MIN_SCALE-MAX_SCALE and so the box stays at least MIN_BOX.
 */
export function resizeScale(box: Box, from: XY, to: XY): number {
  const ax = box[0], ay = box[1];
  const vx = from.x - ax, vy = from.y - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return 1;
  const k = ((to.x - ax) * vx + (to.y - ay) * vy) / len2;
  const big = Math.max(box[2] - box[0], box[3] - box[1], 1e-6);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, MIN_BOX / big, k));
}

/** The transform of a resize: scale around the box's top-left corner. */
export const resizeBy = (box: Box, k: number): Transform => ({ k, ox: box[0], oy: box[1], dx: 0, dy: 0 });

/**
 * Copies of the strokes (deep: their points too) with ids unique among `taken`, which grows.
 * With `always`, every copy gets a new id; otherwise only those whose id is taken.
 */
export function withIds(strokes: readonly Stroke[], taken: Set<string>, always: boolean, random: RandomSource = cryptoRandom): Stroke[] {
  return strokes.map(s => {
    const id = always || taken.has(s.id) ? newStrokeId(taken, random) : s.id;
    taken.add(id);
    return { ...s, id, points: s.points.map(p => ({ ...p })) };
  });
}

/** The move that puts the box's centre at (cx, cy), rounded to 0.1 px. */
export function centreOn(b: Box, cx: number, cy: number): Transform {
  return moveBy(roundXY(cx - (b[0] + b[2]) / 2), roundXY(cy - (b[1] + b[3]) / 2));
}

/** Strokes as JSON for the system clipboard: `{ "format": CLIP_FORMAT, "strokes": [...] }`, points as objects. */
export function encodeClip(strokes: readonly Stroke[]): string {
  return JSON.stringify({ format: CLIP_FORMAT, strokes });
}

/** The strokes of encodeClip's text, or null if it isn't that (only the shape is checked). */
export function decodeClip(text: string): Stroke[] | null {
  try {
    const d = JSON.parse(text);
    if (!d || d.format !== CLIP_FORMAT || !Array.isArray(d.strokes)) return null;
    const ok = d.strokes.every((s: Stroke) => s && typeof s.id === 'string' && (s.tool === 'pen' || s.tool === 'highlighter') &&
      typeof s.color === 'string' && typeof s.size === 'number' && Array.isArray(s.points) && s.points.length > 0);
    return ok ? d.strokes : null;
  } catch {
    return null;
  }
}

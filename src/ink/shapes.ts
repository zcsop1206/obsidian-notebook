// Shape recognition (#16): a stroke held still at its end is straightened into a line, arrow,
// triangle, rectangle, circle or ellipse. Pure and deterministic: points in page px in, the
// shape and the points of the stroke that replaces the drawn one out (or null: freehand stays).
//
// Rules (thresholds below):
// - Too small (bounding-box diagonal under MIN_DIAG) or too few points: nothing.
// - Closed when the end is within CLOSE_FRAC of the diagonal or CLOSE_PX of the start and the
//   path is long enough to go round (over 1.5 diagonals). An overshoot past the start is cut
//   at the point of the stroke's last fifth nearest the start.
// - Open: the stroke is simplified (radial distance, then Douglas-Peucker at SIMPLIFY_FRAC of
//   the diagonal). An arrow when the first simplified segment is the shaft (straight, most of
//   the length) and everything after the tip stays within HEAD_FRAC of the shaft's length of
//   it, with a back-stroke at 25°-75° to the shaft; else a line when the points stay close to
//   their least-squares line (rms under LINE_RMS, max under LINE_MAX of its length).
// - Closed: an ellipse when the points fit the principal-axes ellipse (mean |r - 1| under
//   ELLIPSE_MEAN, max under ELLIPSE_MAX); a circle when its axes are within 10%. Otherwise
//   corners are found from the turning angle along the resampled loop; each side between
//   corners gets a least-squares line, and the corners are where they meet. 3 corners: a
//   triangle; 4 with angles 90° ± 20°: a rectangle (axis-aligned when within 10° of the axes).
//   Sides must be straight (rms under SIDE_RMS of their length).
//
// The shape's points are dense (every STEP px, corners exact), rounded as the file stores them,
// with the drawn stroke's median pressure and times spread over its duration.

import { roundP, roundXY, type Point } from '../format/page';

export type ShapeKind = 'line' | 'arrow' | 'triangle' | 'rectangle' | 'circle' | 'ellipse';

export interface Shape {
  kind: ShapeKind;
  /** The stroke that replaces the drawn one. */
  points: Point[];
  /** The exact vertices (line and arrow ends, polygon corners); empty for ellipses. */
  corners: { x: number; y: number }[];
  /** 0..1, how well the drawn stroke fitted (for logging). */
  confidence: number;
}

export const MIN_DIAG = 16;
export const CLOSE_FRAC = 0.12;
export const CLOSE_PX = 20;
export const SIMPLIFY_FRAC = 0.02;
export const LINE_RMS = 0.03;
export const LINE_MAX = 0.08;
export const HEAD_FRAC = 0.45;
export const ELLIPSE_MEAN = 0.07;
export const ELLIPSE_MAX = 0.2;
export const SIDE_RMS = 0.05;
/** Spacing of the generated points, page px. */
export const STEP = 2;

interface XY { x: number; y: number }

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(p: readonly XY[]): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) n += dist(p[i - 1], p[i]);
  return n;
}

function bboxDiag(p: readonly XY[]): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { x, y } of p) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return Math.hypot(x1 - x0, y1 - y0);
}

/** Douglas-Peucker indices (kept) of an open polyline. */
function dp(p: readonly XY[], eps: number): number[] {
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, far = eps;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(p[i], p[a], p[b]);
      if (d > far) { far = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

function segDist(q: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L)) : 0;
  return Math.hypot(q.x - a.x - u * dx, q.y - a.y - u * dy);
}

/** Drops points within `r` of the last kept one (keeps the last point). */
function radial(p: readonly XY[], r: number): XY[] {
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) if (dist(p[i], out[out.length - 1]) >= r) out.push(p[i]);
  if (p.length > 1) out.push(p[p.length - 1]);
  return out;
}

/** Total least-squares line: a point on it (the centroid) and a unit direction. */
interface Line { cx: number; cy: number; dx: number; dy: number }

function fitLine(p: readonly XY[]): Line {
  let cx = 0, cy = 0;
  for (const q of p) { cx += q.x; cy += q.y; }
  cx /= p.length; cy /= p.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const q of p) {
    const x = q.x - cx, y = q.y - cy;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, dx: Math.cos(a), dy: Math.sin(a) };
}

const project = (q: XY, l: Line): XY => {
  const u = (q.x - l.cx) * l.dx + (q.y - l.cy) * l.dy;
  return { x: l.cx + u * l.dx, y: l.cy + u * l.dy };
};
const offLine = (q: XY, l: Line) => Math.abs((q.x - l.cx) * l.dy - (q.y - l.cy) * l.dx);

function lineError(p: readonly XY[], l: Line): { rms: number; max: number } {
  let s = 0, max = 0;
  for (const q of p) {
    const d = offLine(q, l);
    s += d * d;
    max = Math.max(max, d);
  }
  return { rms: Math.sqrt(s / p.length), max };
}

function intersect(a: Line, b: Line): XY | null {
  const det = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / det;
  return { x: a.cx + t * a.dx, y: a.cy + t * a.dy };
}

/** `n` points evenly spaced along a closed loop (the loop closes from the last point to the first). */
function resampleLoop(p: readonly XY[], n: number): XY[] {
  const loop = [...p, p[0]];
  const total = pathLength(loop), step = total / n, out: XY[] = [];
  let i = 1, acc = 0, prev = loop[0];
  out.push(prev);
  let want = step;
  while (out.length < n && i < loop.length) {
    const d = dist(prev, loop[i]);
    if (acc + d >= want && d > 0) {
      const u = (want - acc) / d;
      prev = { x: prev.x + u * (loop[i].x - prev.x), y: prev.y + u * (loop[i].y - prev.y) };
      acc = want;
      out.push(prev);
      want += step;
    } else {
      acc += d;
      prev = loop[i++];
    }
  }
  return out;
}

const angleBetween = (a: XY, b: XY) => {
  const d = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
  return Math.abs(d);
};

/** Recognises the shape of a drawn stroke, or null if it isn't one. */
export function recognize(drawn: readonly Point[]): Shape | null {
  if (drawn.length < 5) return null;
  const diag = bboxDiag(drawn);
  if (diag < MIN_DIAG) return null;
  const len = pathLength(drawn);
  const gap = dist(drawn[0], drawn[drawn.length - 1]);
  const closed = (gap <= CLOSE_FRAC * diag || gap <= CLOSE_PX) && len > 1.5 * diag;
  const found = closed ? closedShape(trimOvershoot(drawn), diag) : openShape(drawn, diag);
  if (!found) return null;
  return { ...found, points: toStroke(found.path, drawn) };
}

interface Found { kind: ShapeKind; path: XY[]; corners: XY[]; confidence: number }

// ---- open shapes

function openShape(p: readonly XY[], diag: number): Found | null {
  const simple = radial(p, Math.max(1, diag * 0.005));
  const idx = dp(simple, SIMPLIFY_FRAC * diag * 2);
  const v = idx.map(i => simple[i]);
  const arrow = arrowShape(simple, idx, v);
  if (arrow) return arrow;
  const l = fitLine(p), a = project(p[0], l), b = project(p[p.length - 1], l), L = dist(a, b);
  if (L < MIN_DIAG) return null;
  const e = lineError(p, l);
  if (e.rms > LINE_RMS * L || e.max > LINE_MAX * L) return null;
  return { kind: 'line', path: [a, b], corners: [a, b], confidence: 1 - e.rms / (LINE_RMS * L) };
}

function arrowShape(simple: readonly XY[], idx: number[], v: XY[]): Found | null {
  if (v.length < 3) return null;
  const S = v[0], T = v[1], shaft = dist(S, T);
  if (shaft < 3 * MIN_DIAG) return null;
  // Everything after the tip stays near it, and is short beside the shaft.
  const head = simple.slice(idx[1]);
  if (head.some(q => dist(q, T) > HEAD_FRAC * shaft)) return null;
  if (pathLength(head) > 1.5 * shaft) return null;
  const shaftPts = simple.slice(0, idx[1] + 1);
  const l = fitLine(shaftPts), e = lineError(shaftPts, l);
  if (e.rms > LINE_RMS * shaft || e.max > LINE_MAX * shaft) return null;
  // A back-stroke at 25°-75° to the shaft: some head vertex seen from the tip.
  const back = { x: S.x - T.x, y: S.y - T.y };
  let ok = false, barb = 0;
  for (const q of v.slice(2)) {
    const d = dist(q, T);
    if (d < 0.08 * shaft) continue;
    const ang = angleBetween(back, { x: q.x - T.x, y: q.y - T.y }) * 180 / Math.PI;
    if (ang >= 25 && ang <= 75) { ok = true; barb = Math.max(barb, d); }
  }
  if (!ok) return null;
  const s = project(S, l), t = project(T, l);
  const ux = (s.x - t.x) / dist(s, t), uy = (s.y - t.y) / dist(s, t);
  const bl = Math.max(0.12 * dist(s, t), Math.min(barb, 0.3 * dist(s, t)));
  const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
  const b1 = { x: t.x + bl * (ux * c - uy * sn), y: t.y + bl * (uy * c + ux * sn) };
  const b2 = { x: t.x + bl * (ux * c + uy * sn), y: t.y + bl * (uy * c - ux * sn) };
  return { kind: 'arrow', path: [s, t, b1, t, b2], corners: [s, t, b1, b2], confidence: 1 - e.rms / (LINE_RMS * shaft) };
}

// ---- closed shapes

/** Cuts a closed stroke's overshoot past its start. */
function trimOvershoot(p: readonly XY[]): XY[] {
  const from = Math.floor(p.length * 0.8);
  let best = p.length - 1, bd = Infinity;
  for (let i = from; i < p.length; i++) {
    const d = dist(p[i], p[0]);
    if (d < bd) { bd = d; best = i; }
  }
  return p.slice(0, best + 1);
}

const N = 64;

function closedShape(p: readonly XY[], diag: number): Found | null {
  const loop = resampleLoop(p, N);
  if (loop.length < N) return null;
  const ell = ellipseFit(loop);
  if (ell) return ell;
  return polygon(loop, diag);
}

function ellipseFit(loop: readonly XY[]): Found | null {
  const l = fitLine(loop); // principal axis
  const ux = l.dx, uy = l.dy;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const q of loop) {
    const u = (q.x - l.cx) * ux + (q.y - l.cy) * uy, v = -(q.x - l.cx) * uy + (q.y - l.cy) * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  let a = (u1 - u0) / 2, b = (v1 - v0) / 2;
  if (a < 3 || b < 3) return null;
  const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
  const cx = l.cx + mu * ux - mv * uy, cy = l.cy + mu * uy + mv * ux;
  let sum = 0, max = 0;
  for (const q of loop) {
    const u = (q.x - cx) * ux + (q.y - cy) * uy, v = -(q.x - cx) * uy + (q.y - cy) * ux;
    const r = Math.abs(Math.hypot(u / a, v / b) - 1);
    sum += r;
    max = Math.max(max, r);
  }
  const mean = sum / loop.length;
  if (mean > ELLIPSE_MEAN || max > ELLIPSE_MAX) return null;
  let kind: ShapeKind = 'ellipse', ang = Math.atan2(uy, ux);
  if (Math.max(a, b) / Math.min(a, b) <= 1.1) {
    kind = 'circle';
    a = b = (a + b) / 2;
  } else {
    // Near the axes: axis-aligned.
    const deg = ((ang * 180 / Math.PI) % 90 + 90) % 90;
    if (deg < 10 || deg > 80) {
      const snapped = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
      ang = snapped;
    }
  }
  const per = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  const n = Math.max(24, Math.ceil(per / STEP));
  const ca = Math.cos(ang), sa = Math.sin(ang), path: XY[] = [];
  for (let i = 0; i <= n; i++) {
    const th = 2 * Math.PI * (i % n) / n, x = a * Math.cos(th), y = b * Math.sin(th);
    path.push({ x: cx + x * ca - y * sa, y: cy + x * sa + y * ca });
  }
  return { kind, path, corners: [], confidence: 1 - mean / ELLIPSE_MEAN };
}

function polygon(loop: readonly XY[], diag: number): Found | null {
  const n = loop.length, K = 2;
  const turn = loop.map((q, i) => {
    const a = loop[(i - K + n) % n], b = loop[(i + K) % n];
    return angleBetween({ x: q.x - a.x, y: q.y - a.y }, { x: b.x - q.x, y: b.y - q.y }) * 180 / Math.PI;
  });
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < 40) continue;
    let peak = true;
    for (let j = -3; j <= 3 && peak; j++) {
      const t = turn[(i + j + n) % n];
      if (j && (t > turn[i] || (t === turn[i] && j < 0))) peak = false;
    }
    if (peak) corners.push(i);
  }
  const m = corners.length;
  if (m !== 3 && m !== 4) return null;
  // Each side: the loop between two corners, its ends (near the corners) left out.
  const sides: Line[] = [];
  let worst = 0;
  for (let s = 0; s < m; s++) {
    const i0 = corners[s], i1 = corners[(s + 1) % m], span = (i1 - i0 + n) % n;
    const pts: XY[] = [];
    const skip = Math.max(1, Math.round(span * 0.2));
    for (let j = skip; j <= span - skip; j++) pts.push(loop[(i0 + j) % n]);
    if (pts.length < 2) return null;
    const l = fitLine(pts), e = lineError(pts, l);
    const sideLen = dist(loop[i0], loop[i1]);
    if (sideLen < 0.08 * diag) return null;
    worst = Math.max(worst, e.rms / sideLen);
    sides.push(l);
  }
  if (worst > SIDE_RMS) return null;
  const conf = 1 - worst / SIDE_RMS;
  if (m === 3) {
    const v: XY[] = [];
    for (let s = 0; s < 3; s++) {
      const q = intersect(sides[(s + 2) % 3], sides[s]);
      if (!q || dist(q, loop[corners[s]]) > 0.25 * diag) return null;
      v.push(q);
    }
    return { kind: 'triangle', path: [...v, v[0]], corners: v, confidence: conf };
  }
  // A rectangle: every corner 90° ± 20°.
  for (let s = 0; s < 4; s++) {
    const a = sides[(s + 3) % 4], b = sides[s];
    const ang = Math.acos(Math.min(1, Math.abs(a.dx * b.dx + a.dy * b.dy))) * 180 / Math.PI;
    if (ang < 70) return null;
  }
  // One rotation for all four sides (mean of 4θ), then each side's offset in that frame.
  let sx = 0, sy = 0;
  for (const l of sides) {
    const t = 4 * Math.atan2(l.dy, l.dx);
    sx += Math.cos(t); sy += Math.sin(t);
  }
  let rot = Math.atan2(sy, sx) / 4;
  if (Math.abs(rot) * 180 / Math.PI < 10) rot = 0;
  const ux = Math.cos(rot), uy = Math.sin(rot);
  const us: number[] = [], vs: number[] = [];
  for (const l of sides) {
    const along = Math.abs(l.dx * ux + l.dy * uy) > Math.SQRT1_2;
    // A side along u is at a fixed v, and the other way round.
    if (along) vs.push(-l.cx * uy + l.cy * ux);
    else us.push(l.cx * ux + l.cy * uy);
  }
  if (us.length !== 2 || vs.length !== 2) return null;
  const [u0, u1] = us.sort((a, b) => a - b), [v0, v1] = vs.sort((a, b) => a - b);
  if (u1 - u0 < 0.08 * diag || v1 - v0 < 0.08 * diag) return null;
  const at = (u: number, v: number): XY => ({ x: u * ux - v * uy, y: u * uy + v * ux });
  // Start at the corner nearest the drawn start, going round the way it was drawn.
  let v = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  const area = signedArea(loop);
  if (area < 0) v = [v[0], v[3], v[2], v[1]];
  let k = 0;
  for (let i = 1; i < 4; i++) if (dist(v[i], loop[0]) < dist(v[k], loop[0])) k = i;
  v = [...v.slice(k), ...v.slice(0, k)];
  return { kind: 'rectangle', path: [...v, v[0]], corners: v, confidence: conf };
}

function signedArea(p: readonly XY[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// ---- the stroke

/**
 * The points of a stroke along `path` (a polyline): every STEP px, each vertex exactly,
 * rounded as the file stores them; the drawn stroke's median pressure and times spread
 * evenly over its duration.
 */
export function toStroke(path: readonly XY[], drawn: readonly Point[]): Point[] {
  const xy: XY[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    xy.push(a);
    const b = path[i + 1];
    if (!b) break;
    const d = dist(a, b), n = Math.floor(d / STEP);
    for (let j = 1; j < n; j++) xy.push({ x: a.x + (b.x - a.x) * j / n, y: a.y + (b.y - a.y) * j / n });
  }
  const ps = drawn.map(q => q.p).sort((a, b) => a - b);
  const p = roundP(ps[Math.floor(ps.length / 2)] ?? 0.5);
  const t0 = drawn[0]?.t ?? 0, t1 = drawn[drawn.length - 1]?.t ?? 0;
  const out: Point[] = [];
  for (let i = 0; i < xy.length; i++) {
    const q = { x: roundXY(xy[i].x), y: roundXY(xy[i].y), p, t: Math.round(t0 + (t1 - t0) * (xy.length > 1 ? i / (xy.length - 1) : 0)) };
    const prev = out[out.length - 1];
    if (prev && prev.x === q.x && prev.y === q.y) continue;
    out.push(q);
  }
  return out;
}

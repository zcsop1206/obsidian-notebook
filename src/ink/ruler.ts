// The ruler (#20): its geometry, pure and unit-tested. The on-screen ruler is ruler-overlay.ts;
// its effect on pen and highlighter strokes is in input.ts (a stroke starting near an edge has
// every sample projected onto that edge); the view ties them together ("the ruler (#20)").
//
// The ruler lives in page px of one page: a centre, an angle and a fixed width. Its length is
// twice the page's diagonal, so wherever its centre is on the page it crosses the whole page.
// The angle is in degrees, counter-clockwise from the page's +x axis as seen on screen (y points
// down in page px, so the ruler's direction is (cos a, −sin a)), in [0, 360). It has two long
// edges, each a line at ±width/2 from the centre line; a stroke is drawn along the nearer one.
// It is never saved.
import type { Size } from '../format/page';

export interface RulerState {
  /** Centre, page px. */
  cx: number;
  cy: number;
  /** Degrees counter-clockwise on screen, [0, 360). */
  angle: number;
}

/** A line: a point on it and its unit direction (page px). */
export interface Edge {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export type LengthUnit = 'cm' | 'in';

/** The ruler's width, page px (0.75 in). */
export const RULER_WIDTH = 72;
/** A pen stroke starting within this many CSS px of an edge is drawn along it. */
export const EDGE_REACH = 20;
/** The angle snaps to multiples of SNAP_STEP degrees when within SNAP_WITHIN of one. */
export const SNAP_STEP = 15;
export const SNAP_WITHIN = 2;
/** The page's real scale: 96 px per inch. */
export const PX_PER_IN = 96;
export const PX_PER_CM = PX_PER_IN / 2.54;

const RAD = Math.PI / 180;

/** The angle in [0, 360). */
export function normAngle(a: number): number {
  const r = ((a % 360) + 360) % 360;
  return r >= 360 - 1e-9 ? 0 : r;
}

/** The angle, snapped to the nearest multiple of SNAP_STEP when within SNAP_WITHIN of it; in [0, 360). */
export function snapAngle(a: number, step = SNAP_STEP, within = SNAP_WITHIN): number {
  const m = Math.round(a / step) * step;
  return normAngle(Math.abs(a - m) <= within ? m : a);
}

/** A typed angle: a number of degrees (a trailing ° allowed) in 0–360, normalised; else null. */
export function parseAngle(text: string): number | null {
  const s = text.trim().replace(/°$/, '').trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 360) return null;
  return normAngle(n);
}

/** The ruler's unit direction in page px (y down). */
export function direction(angle: number): { x: number; y: number } {
  return { x: Math.cos(angle * RAD), y: -Math.sin(angle * RAD) };
}

/** The unit normal to the ruler, pointing to its "lower" edge on screen at angle 0 (page px). */
export function normal(angle: number): { x: number; y: number } {
  return { x: Math.sin(angle * RAD), y: Math.cos(angle * RAD) };
}

/** The ruler's two long edges: [the one on the +normal side, the one on the −normal side]. */
export function edges(r: RulerState, width = RULER_WIDTH): [Edge, Edge] {
  const d = direction(r.angle), n = normal(r.angle), h = width / 2;
  return [
    { x: r.cx + n.x * h, y: r.cy + n.y * h, dx: d.x, dy: d.y },
    { x: r.cx - n.x * h, y: r.cy - n.y * h, dx: d.x, dy: d.y },
  ];
}

/** Distance from a point to the line. */
export function distanceTo(p: { x: number; y: number }, e: Edge): number {
  return Math.abs((p.x - e.x) * -e.dy + (p.y - e.y) * e.dx);
}

/** The point of the line nearest to p. */
export function projectOnto(p: { x: number; y: number }, e: Edge): { x: number; y: number } {
  const t = (p.x - e.x) * e.dx + (p.y - e.y) * e.dy;
  return { x: e.x + t * e.dx, y: e.y + t * e.dy };
}

/** The edge within `reach` (page px) of p, the nearer if both are; else null. */
export function nearestEdge(r: RulerState, p: { x: number; y: number }, reach: number, width = RULER_WIDTH): Edge | null {
  let best: Edge | null = null, bd = Infinity;
  for (const e of edges(r, width)) {
    const d = distanceTo(p, e);
    if (d <= reach && d < bd) {
      best = e;
      bd = d;
    }
  }
  return best;
}

/** Half the ruler's length for a page: the page's diagonal, so it always crosses the page. */
export function halfLength(size: Size): number {
  return Math.hypot(size.width, size.height);
}

/** The ruler moved by a finger from `from` to `to` (page px). */
export function moveRuler(r: RulerState, from: { x: number; y: number }, to: { x: number; y: number }): RulerState {
  return { cx: r.cx + to.x - from.x, cy: r.cy + to.y - from.y, angle: r.angle };
}

type Pt = { x: number; y: number };

/**
 * The ruler turned and moved by two fingers that went from `a` (a pair of points, page px) to
 * `b`: it turns by the change of the fingers' direction around their centroid (the angle then
 * snapped) and moves with the centroid. The centre follows the snapped turn, so the ruler stays
 * under the fingers.
 */
export function rotateRuler(r: RulerState, a: [Pt, Pt], b: [Pt, Pt], snap = true): RulerState {
  const va = { x: a[1].x - a[0].x, y: a[1].y - a[0].y }, vb = { x: b[1].x - b[0].x, y: b[1].y - b[0].y };
  if (Math.hypot(va.x, va.y) < 1e-6 || Math.hypot(vb.x, vb.y) < 1e-6) return moveRuler(r, mid(a), mid(b));
  // Turn in y-down page coordinates (clockwise on screen is positive), in degrees.
  const turn = (Math.atan2(vb.y, vb.x) - Math.atan2(va.y, va.x)) / RAD;
  const raw = normAngle(r.angle - turn);
  const angle = snap ? snapAngle(raw) : raw;
  // The turn actually applied, y-down radians.
  let applied = r.angle - angle;
  applied = ((applied + 540) % 360) - 180;
  const phi = applied * RAD, c = Math.cos(phi), s = Math.sin(phi);
  const ca = mid(a), cb = mid(b), ox = r.cx - ca.x, oy = r.cy - ca.y;
  return { cx: cb.x + ox * c - oy * s, cy: cb.y + ox * s + oy * c, angle };
}

function mid(p: [Pt, Pt]): Pt {
  return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
}

/** The direction from the first point to the last, in the ruler's convention (degrees, [0, 360)). */
export function angleOf(points: readonly Pt[]): number {
  const a = points[0], b = points[points.length - 1];
  return normAngle(Math.atan2(-(b.y - a.y), b.x - a.x) / RAD);
}

/** The difference between two line directions, ignoring which way they point (degrees, 0–90). */
export function lineAngleDiff(a: number, b: number): number {
  const d = Math.abs(normAngle(a - b)) % 180;
  return Math.min(d, 180 - d);
}

/**
 * The largest angle, from the line through `angle`, of the direction from the first point to
 * each point at least `minDist` page px away (degrees).
 */
export function maxAngularError(points: readonly Pt[], angle: number, minDist = 100): number {
  let worst = 0;
  const a = points[0];
  for (const p of points) {
    if (Math.hypot(p.x - a.x, p.y - a.y) < minDist) continue;
    worst = Math.max(worst, lineAngleDiff(angleOf([a, p]), angle));
  }
  return worst;
}

/** A length in page px as cm (one decimal) or inches (two decimals) at 96 px per inch. */
export function formatLength(px: number, unit: LengthUnit): string {
  return unit === 'in' ? `${(px / PX_PER_IN).toFixed(2)} in` : `${(px / PX_PER_CM).toFixed(1)} cm`;
}

/** The tick spacing (page px) and how many ticks make a long one: 5 mm (long at 1 cm), or ¼ in (long at 1 in). */
export function tickStep(unit: LengthUnit): { step: number; major: number } {
  return unit === 'in' ? { step: PX_PER_IN / 4, major: 4 } : { step: PX_PER_CM / 2, major: 2 };
}

/** An angle for display: whole degrees, or one decimal when it has one. */
export function fmtAngle(a: number): string {
  const r = Math.round(normAngle(a) * 10) / 10;
  return (r === 360 ? 0 : r).toFixed(Number.isInteger(r) ? 0 : 1);
}

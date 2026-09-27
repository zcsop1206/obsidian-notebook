// Stroke outlines: each stroke is drawn as one filled path computed from its points with
// perfect-freehand. The paths are derived data; a page's <metadata> is the source of truth.
import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { HighlighterStroke, Nib, PenStroke } from './page';

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

/** The SVG path `d` for a stroke's filled outline, with coordinates rounded to 0.1 px. */
export function strokePath(stroke: OutlineInput): string {
  const { points, size } = stroke;
  if (points.length === 0) return '';
  if (points.length === 1) return dot(points[0].x, points[0].y, size / 2);
  const outline = getStroke(points.map(pt => [pt.x, pt.y, pt.p]), { ...outlineOptions(stroke), size });
  return polygon(outline);
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

/** A filled circle of radius `r` as two arcs. */
function dot(x: number, y: number, r: number): string {
  const rs = fmt1(r);
  return `M${fmt1(x - r)} ${fmt1(y)}A${rs} ${rs} 0 1 0 ${fmt1(x + r)} ${fmt1(y)}A${rs} ${rs} 0 1 0 ${fmt1(x - r)} ${fmt1(y)}Z`;
}

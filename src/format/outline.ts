// Stroke outlines: each stroke is drawn as one filled path computed from its points with
// perfect-freehand. The paths are derived data; a page's <metadata> is the source of truth.
import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { HighlighterStroke, Nib, PenStroke } from './page';

/** Pen with the `uniform` nib: the same width whatever the pressure, round caps. Tuned by #5. */
export const UNIFORM_PEN_OPTIONS: Readonly<StrokeOptions> = Object.freeze({
  thinning: 0,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
  start: { cap: true, taper: 0 },
  end: { cap: true, taper: 0 },
  last: true,
});

/**
 * Pen with the `pressure` nib: width follows pressure, round caps. `size` is the width at
 * pressure 0.5. Tuned by #5.
 */
export const PEN_OPTIONS: Readonly<StrokeOptions> = Object.freeze({
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
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

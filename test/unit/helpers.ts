import { newPageId, newStrokeId } from '../../src/format/ids';
import { LETTER, newPage, type Page, type Point, type Stroke } from '../../src/format/page';
import type { Seeded } from '../seeded';

const COLORS = ['#000000', '#1e5bd8', '#d0312d', '#ffd400', '#3ddc84'];

/** Random, unrounded points: a wandering path with random pressures and fractional times. */
export function randomPoints(r: Seeded, n: number): Point[] {
  const points: Point[] = [];
  let x = r.range(0, LETTER.width), y = r.range(0, LETTER.height), t = r.range(0, 50);
  for (let i = 0; i < n; i++) {
    points.push({ x, y, p: r.next(), t });
    x += r.range(-6, 6);
    y += r.range(-6, 6);
    t += r.range(0, 9);
  }
  return points;
}

/** The kinds of stroke the tests draw: each pen nib and the highlighter. */
export const KINDS = ['pen/uniform', 'pen/pressure', 'highlighter'] as const;
export type Kind = typeof KINDS[number];

/** A page with `count` strokes of `kind` (or of all kinds in turn, for `mixed`). */
export function randomPage(r: Seeded, count: number, kind: Kind | 'mixed'): Page {
  const page = newPage(newPageId([], r.bytes));
  for (let i = 0; i < count; i++) {
    const k = kind === 'mixed' ? KINDS[i % KINDS.length] : kind;
    const n = i % 25 === 0 ? 1 : 2 + Math.floor(r.next() * 60);
    const base = {
      id: newStrokeId(page.strokes.map(s => s.id), r.bytes),
      color: COLORS[Math.floor(r.next() * COLORS.length)],
      size: r.range(0.5, 24),
      points: randomPoints(r, n),
    };
    const stroke: Stroke = k === 'highlighter' ? { ...base, tool: 'highlighter' }
      : { ...base, tool: 'pen', nib: k === 'pen/uniform' ? 'uniform' : 'pressure' };
    page.strokes.push(stroke);
  }
  return page;
}

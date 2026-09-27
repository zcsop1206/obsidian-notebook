// The spike's SVG ink writer (format notebook-ink/0): each stroke is a filled outline whose
// width follows pressure, with the raw points kept as JSON in <metadata>.
import { r1, r2 } from './util';

export const INK_BASE = 2.2; // stroke width in CSS px at pressure 0.5

/** One sample: x and y in CSS px, pressure 0..1, ms since the stroke started. */
export type Point = [x: number, y: number, p: number, t: number];

export interface InkStroke {
  t0: number;
  type: string;
  pts: Point[];
}

export const width = (p: number) => INK_BASE * (0.4 + 1.2 * (p > 0 ? p : 0.5));

export function outline(pts: Point[]) {
  const n = pts.length;
  if (n === 1) {
    const [x, y, p] = pts[0], r = r1(width(p) / 2);
    return `M${r1(x - r)} ${r1(y)}a${r} ${r} 0 1 0 ${r1(2 * r)} 0a${r} ${r} 0 1 0 ${r1(-2 * r)} 0Z`;
  }
  const left: string[] = [], right: string[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y, p] = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, r = width(p) / 2;
    const nx = -dy / len * r, ny = dx / len * r;
    left.push(`${r1(x + nx)} ${r1(y + ny)}`);
    right.push(`${r1(x - nx)} ${r1(y - ny)}`);
  }
  const rEnd = r1(width(pts[n - 1][2]) / 2), rStart = r1(width(pts[0][2]) / 2);
  const back = right.slice().reverse();
  return `M${left.join('L')}A${rEnd} ${rEnd} 0 0 0 ${back[0]}L${back.join('L')}A${rStart} ${rStart} 0 0 0 ${left[0]}Z`;
}

export function toSvg(strokes: InkStroke[], page: { w: number; h: number }) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s.pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const m = 12;
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  const data = {
    format: 'notebook-ink/0',
    created: new Date().toISOString(),
    page,
    strokes: strokes.map(s => ({ t0: s.t0, type: s.type, pts: s.pts.map(([x, y, p, t]) => [r1(x), r1(y), r2(p), t]) })),
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(x0)} ${r1(y0)} ${r1(x1 - x0)} ${r1(y1 - y0)}" width="${Math.ceil(x1 - x0)}" height="${Math.ceil(y1 - y0)}">\n` +
    `<style>path{fill:#1f1f1f}@media (prefers-color-scheme:dark){path{fill:#e6e3de}}</style>\n` +
    `<metadata><![CDATA[${JSON.stringify(data)}]]></metadata>\n` +
    strokes.map(s => `<path d="${outline(s.pts)}"/>`).join('\n') +
    '\n</svg>\n';
}

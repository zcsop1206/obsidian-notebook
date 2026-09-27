// The pen's outline (#32): quadratic curves through the outline's points, and the refit a
// finished pen stroke is drawn from (smoothed, thinned, ends kept; the file keeps raw points).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refit, smoothCurve, strokePath } from '../../src/format/outline';
import type { Point } from '../../src/format/page';

/** A seeded noisy straight line from (100, 200) along x, in the Pencil's 0.5 px steps. */
function noisyLine(n: number): Point[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round((100 + i * 0.4 + 0.4 * rnd()) * 2) / 2, y = Math.round((200 + 0.8 * rnd()) * 2) / 2;
    const q = pts[pts.length - 1];
    if (q && Math.hypot(x - q.x, y - q.y) < 0.25) continue;
    pts.push({ x, y, p: 0.08, t: i * 2 });
  }
  return pts;
}

test('refit: a noisy straight line comes back close to the line, ends kept, fewer points', () => {
  const pts = noisyLine(600), out = refit(pts);
  // RMS distance from the line, away from the ends (where the window narrows to keep them).
  const x1 = pts[pts.length - 1].x - 2;
  const dev = (ps: Point[]) => { const d = ps.filter(q => q.x > 102 && q.x < x1).map(q => (q.y - 200) ** 2); return Math.sqrt(d.reduce((a, b) => a + b) / d.length); };
  assert.ok(dev(out) < 0.22 && dev(out) < dev(pts) * 0.65, `RMS deviation ${dev(pts)} -> ${dev(out)}`);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
  assert.ok(out.length < pts.length * 0.9, `${pts.length} -> ${out.length} points`);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].x >= out[i - 1].x - 0.3, 'no doubling back');
  assert.deepEqual(refit(pts), out, 'deterministic');
});

test('refit: short strokes unchanged, the uniform nib still pressure-independent, the input not modified', () => {
  const two: Point[] = [{ x: 1, y: 2, p: 0.1, t: 0 }, { x: 3, y: 4, p: 0.2, t: 1 }];
  assert.deepEqual(refit(two), two);
  assert.deepEqual(refit(two.slice(0, 1)), two.slice(0, 1));
  assert.deepEqual(refit([]), []);
  const pts = noisyLine(300), copy = JSON.stringify(pts);
  refit(pts);
  assert.equal(JSON.stringify(pts), copy);
  const other = pts.map((q, i) => ({ ...q, p: (i % 7) / 7 }));
  assert.equal(strokePath({ tool: 'pen', nib: 'uniform', size: 2.5, points: pts }), strokePath({ tool: 'pen', nib: 'uniform', size: 2.5, points: other }));
});

test('refit: the committed outline keeps the round caps where they were (no shortening)', () => {
  const pts = noisyLine(600);
  const xs = (d: string) => (d.match(/-?[\d.]+ -?[\d.]+/g) ?? []).map(v => Number(v.split(' ')[0]));
  const live = xs(strokePath({ tool: 'pen', nib: 'uniform', size: 4, points: pts }, true));
  const done = xs(strokePath({ tool: 'pen', nib: 'uniform', size: 4, points: pts }));
  assert.ok(Math.abs(Math.min(...live) - Math.min(...done)) < 0.3 && Math.abs(Math.max(...live) - Math.max(...done)) < 0.3,
    `${Math.min(...live)}..${Math.max(...live)} vs ${Math.min(...done)}..${Math.max(...done)}`);
});

test('refit: the highlighter is not refitted and stays a polygon', () => {
  const pts = noisyLine(300);
  const d = strokePath({ tool: 'highlighter', size: 18, points: pts });
  assert.equal(d, strokePath({ tool: 'highlighter', size: 18, points: pts }, true));
  assert.ok(d.startsWith('M') && !d.includes('Q'));
});

test('refit: a 2,000-point stroke refits in well under 2 ms', () => {
  const pts: Point[] = Array.from({ length: 2000 }, (_, j) => ({
    x: Math.round((400 + 200 * Math.sin(j / 97) + 30 * Math.sin(j / 7)) * 2) / 2, y: Math.round((400 + 150 * Math.cos(j / 131)) * 2) / 2, p: 0.2, t: j }));
  for (let k = 0; k < 20; k++) refit(pts);
  const times: number[] = [];
  for (let k = 0; k < 50; k++) { const t0 = performance.now(); refit(pts); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  console.log(`refit 2000 points: median ${times[25].toFixed(3)} ms`);
  assert.ok(times[25] < 1, `${times[25]} ms`);
});

test('smoothCurve: quadratics through the outline points with midpoints on the curve', () => {
  assert.equal(smoothCurve([[0, 0], [10, 0], [10, 10], [0, 10]]), 'M0 5Q0 0 5 0Q10 0 10 5Q10 10 5 10Q0 10 0 5Z');
  assert.equal(smoothCurve([[0, 0], [0.01, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), 'M0 5Q0 0 5 0Q10 0 10 5Q10 10 5 10Q0 10 0 5Z', 'points rounding onto their neighbour dropped');
  assert.equal(smoothCurve([[1, 1], [2, 2]]), 'M1 1L2 2Z');
});

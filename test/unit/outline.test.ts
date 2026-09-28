// The pen's outline (#32): quadratic curves through the outline's points, and the refit a
// finished pen stroke is drawn from (smoothed, thinned, ends kept; the file keeps raw points),
// and LiveFit, the same refit computed incrementally for the live stroke (#52).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centreline, fmt2, isStroked, LiveFit, outlinePath, refit, refitStep, smoothCurve, strokePath, UNIFORM_STROKED } from '../../src/format/outline';
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

/** Handwriting-like loops in the Pencil's 0.5 px steps, points closer than 0.25 px dropped (as the pen samples). */
function loops(n: number, step = 0.5): Point[] {
  const pts: Point[] = [];
  for (let j = 0; j < n; j++) {
    const a = j / 14, x = Math.round((100 + j * 0.28 - 7 * Math.sin(a)) / step) * step, y = Math.round((200 - 9 * (1 - Math.cos(a))) / step) * step;
    const q = pts[pts.length - 1];
    if (q && Math.hypot(x - q.x, y - q.y) < 0.25) continue;
    pts.push({ x, y, p: 0.05 + 0.1 * Math.sin(j / 30) ** 2, t: j * 2 });
  }
  return pts;
}

test('LiveFit (#52): refit of the points so far, for every prefix, however the points arrive', () => {
  for (const [name, all] of [['noisy line', noisyLine(700)], ['loops', loops(900)], ['loops at 400%', loops(900, 0.125)]] as const) {
    for (const [per, step] of [[1, 0.3], [4, 0.3], [9, 0.3], [4, 0.6], [1, 1]]) {
      const fit = new LiveFit(step), pts: Point[] = [];
      let settled: Point[] = [];
      for (let i = 0; i < all.length; i += per) {
        pts.push(...all.slice(i, i + per));
        const n = fit.update(pts);
        const want = refit(pts, step);
        assert.equal(n, want.length, `${name}, ${per} per update, ${pts.length} points: count`);
        assert.deepEqual(fit.slice(0), want, `${name}, ${per} per update, ${pts.length} points`);
        // Settled points never change afterwards (they're what the head canvas freezes).
        assert.ok(fit.settled <= n);
        assert.deepEqual(want.slice(0, settled.length), settled, `${name}: settled points changed`);
        settled = want.slice(0, fit.settled);
      }
      assert.ok(fit.settled > (refit(pts, step).length) - 1.5 / step - 2, `${name}: only the last 1.5 px unsettled (${fit.settled} of ${refit(pts, step).length})`);
    }
  }
});

test('LiveFit: short strokes, slices, and the tip on the last sample', () => {
  const fit = new LiveFit(), pts: Point[] = [];
  assert.equal(fit.update(pts), 0);
  assert.deepEqual(fit.slice(0), []);
  pts.push({ x: 1, y: 1, p: 0.1, t: 0 });
  assert.equal(fit.update(pts), 1);
  pts.push({ x: 2, y: 1, p: 0.1, t: 1 });
  assert.deepEqual(fit.slice(0), [pts[0]], 'slice is of the last update');
  fit.update(pts);
  assert.deepEqual(fit.slice(0), pts);
  pts.push(...loops(200).map(q => ({ ...q, x: q.x - 97 })));
  const n = fit.update(pts), all = refit(pts);
  assert.deepEqual(fit.slice(5, 40), all.slice(5, 40));
  assert.deepEqual(fit.slice(n - 3), all.slice(n - 3));
  assert.deepEqual(fit.slice(fit.settled - 2, n), all.slice(fit.settled - 2));
  assert.deepEqual(fit.slice(n - 1)[0], pts[pts.length - 1], 'the tip is the last sample');
  assert.deepEqual(fit.slice(0, 1)[0], pts[0]);
});

test('LiveFit: the live outline is the committed one, and a 2,000-point stroke updates in well under a millisecond per frame', () => {
  const all = loops(2000), fit = new LiveFit(), pts: Point[] = [];
  const times: number[] = [];
  for (let i = 0; i < all.length; i += 4) {
    pts.push(...all.slice(i, i + 4));
    const t0 = performance.now();
    fit.update(pts);
    times.push(performance.now() - t0);
  }
  const s = { tool: 'pen' as const, nib: 'pressure' as const, size: 2.5, points: pts };
  assert.equal(strokePath({ ...s, points: fit.slice(0) }, true), strokePath(s));
  // The uniform nib's centreline (#60) is drawn from a refit with its own step: LiveFit given it.
  const u = { ...s, nib: 'uniform' as const }, ufit = new LiveFit(refitStep(u));
  ufit.update(pts);
  assert.equal(strokePath({ ...u, points: ufit.slice(0) }, true), strokePath(u));
  times.sort((a, b) => a - b);
  console.log(`LiveFit update: median ${times[times.length >> 1].toFixed(4)} ms, max ${times[times.length - 1].toFixed(3)} ms`);
  assert.ok(times[times.length >> 1] < 0.2, `${times[times.length >> 1]} ms`);
});

// ---- the uniform nib as a stroked centreline (#60)

test('centreline (#60): an open curve of quadratics through the midpoints, from the first point to the last, to 0.01 px', () => {
  const at = (pts: number[][]) => pts.map(([x, y]) => ({ x, y }));
  assert.equal(centreline(at([[0, 0], [10, 0], [10, 10], [0, 10]])), 'M0 0Q10 0 10 5Q10 10 0 10');
  assert.equal(centreline(at([[0, 0], [10, 0], [10, 10]])), 'M0 0Q10 0 10 10');
  assert.equal(centreline(at([[1.234, 2.345], [3.456, 4.567]])), 'M1.23 2.35L3.46 4.57', 'two points: a line');
  assert.equal(centreline(at([[5, 6]])), 'M5 6L5 6', 'one point: a zero-length line, a dot with round caps');
  assert.equal(centreline(at([[5, 6], [5.001, 6.004], [4.999, 5.998]])), 'M5 6L5 6', 'points rounding onto one: a dot');
  assert.equal(centreline(at([[0, 0], [0.001, 0], [10, 0], [10, 10]])), 'M0 0Q10 0 10 10', 'points rounding onto their neighbour dropped');
  assert.equal(centreline([]), '');
  assert.equal(fmt2(-0.001), '0');
  assert.equal(fmt2(1.005 + 1e-9), '1.01');
});

test('the uniform nib is stroked, the pressure nib and the highlighter filled; strokePath gives each its path', () => {
  assert.equal(UNIFORM_STROKED, true);
  assert.equal(isStroked({ tool: 'pen', nib: 'uniform' }), true);
  assert.equal(isStroked({ tool: 'pen', nib: 'pressure' }), false);
  assert.equal(isStroked({ tool: 'highlighter' }), false);
  const pts = loops(600);
  const u = { tool: 'pen' as const, nib: 'uniform' as const, size: 0.5, points: pts };
  assert.equal(strokePath(u), centreline(refit(pts, refitStep(u))));
  assert.equal(strokePath(u, true), centreline(pts));
  assert.ok(!strokePath(u).includes('Z') && strokePath(u).startsWith(`M${pts[0].x} ${pts[0].y}Q`), 'open, from the first point');
  assert.ok(strokePath(u).endsWith(` ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`), 'to the last point');
  // outlinePath is the filled outline whatever the switch: the pressure nib's strokePath, the uniform nib's before #60.
  const p = { ...u, nib: 'pressure' as const, size: 2.5 };
  assert.equal(strokePath(p), outlinePath(p));
  assert.ok(outlinePath(u).endsWith('Z') && outlinePath(u).includes('Q'));
  assert.equal(strokePath({ ...u, points: [pts[0]] }), `M${pts[0].x} ${pts[0].y}L${pts[0].x} ${pts[0].y}`);
});

test('refitStep (#60): the centreline\'s points 0.6 × size apart, within 0.6..1 px; the outlines\' 0.3 px', () => {
  const step = (size: number, nib: 'uniform' | 'pressure' = 'uniform') => refitStep({ tool: 'pen', nib, size });
  assert.deepEqual([0.25, 0.5, 1, 1.5, 2.5, 4, 16].map(k => step(k)), [0.6, 0.6, 0.6, 0.9, 1, 1, 1]);
  assert.equal(step(2.5, 'pressure'), 0.3);
  assert.equal(refitStep({ tool: 'highlighter', size: 18 }), 0.3);
  // Kept points are at least the step apart, the ends kept.
  const pts = noisyLine(600), out = refit(pts, 1);
  for (let i = 1; i < out.length - 1; i++) assert.ok(Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y) >= 1 - 1e-9);
  assert.deepEqual([out[0], out[out.length - 1]], [pts[0], pts[pts.length - 1]]);
  // Tiny loops (about 2 px across, as a 0.5 px pen writes small letters) keep their shape: the
  // centreline through points 0.6 px apart is within 0.2 px (at the tightest turn) of the one
  // through points 0.3 px apart.
  const tiny = loops(700).map(q => ({ ...q, x: 100 + (q.x - 100) * 0.3, y: 200 + (q.y - 200) * 0.3 }));
  const flatten = (d: string) => {
    const nums = d.match(/[MLQ]|-?[\d.]+/g)!, out: number[][] = [];
    let i = 0, cmd = '';
    const n = () => Number(nums[i++]);
    while (i < nums.length) {
      if (/^[MLQ]$/.test(nums[i])) cmd = nums[i++];
      if (cmd === 'Q') {
        const [x0, y0] = out[out.length - 1], cx = n(), cy = n(), x1 = n(), y1 = n();
        for (let j = 1; j <= 16; j++) { const t = j / 16, v = 1 - t; out.push([v * v * x0 + 2 * v * t * cx + t * t * x1, v * v * y0 + 2 * v * t * cy + t * t * y1]); }
      } else out.push([n(), n()]);
    }
    return out;
  };
  const a = flatten(centreline(refit(tiny, 0.6))), b = flatten(centreline(refit(tiny, 0.3)));
  let worst = 0;
  for (const [x, y] of a) worst = Math.max(worst, Math.min(...b.map(([u, v]) => Math.hypot(x - u, y - v))));
  console.log(`tiny loops: centreline at a 0.6 px step within ${worst.toFixed(3)} px of the 0.3 px one`);
  assert.ok(worst < 0.2, `${worst.toFixed(3)} px`);
});

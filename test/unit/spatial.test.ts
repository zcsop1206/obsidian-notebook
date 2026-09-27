// The eraser's spatial index (#7): hits and misses at the edge of radius + half width, adding
// and removing strokes, points off the page, and its speed on a full page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LETTER, type Point, type Stroke } from '../../src/format/page';
import { CELL, halfWidth, SpatialIndex } from '../../src/ink/spatial';
import { seeded } from '../seeded';

const pt = (x: number, y: number): Point => ({ x, y, p: 0.5, t: 0 });
const pen = (id: string, points: Point[], size = 2, nib: 'uniform' | 'pressure' = 'uniform'): Stroke =>
  ({ id, tool: 'pen', nib, color: '#000000', size, points });
const hl = (id: string, points: Point[], size = 20): Stroke => ({ id, tool: 'highlighter', color: '#ffd400', size, points });
const line = (x0: number, y0: number, x1: number, y1: number, n = 100) =>
  Array.from({ length: n + 1 }, (_, i) => pt(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n));
const ids = (a: string[]) => [...a].sort();

test('spatial: half widths per tool and nib', () => {
  assert.equal(halfWidth(pen('a', [pt(0, 0)], 4)), 2);
  assert.equal(halfWidth(pen('a', [pt(0, 0)], 4, 'pressure')), 2.6);
  assert.equal(halfWidth(hl('a', [pt(0, 0)], 20)), 10);
});

test('spatial: a point just inside radius + half width hits, just outside misses', () => {
  // A horizontal line at y = 100 from x 100 to 300, 4 px wide (half width 2); eraser radius 6.
  const idx = new SpatialIndex(LETTER, [pen('aaaaaaaa', line(100, 100, 300, 100), 4)]);
  const hitAt = (x: number, y: number) => idx.hit(pt(x, y), pt(x, y), 6);
  assert.deepEqual(hitAt(200, 100 + 8 - 0.01), ['aaaaaaaa']);
  assert.deepEqual(hitAt(200, 100 + 8 + 0.01), []);
  assert.deepEqual(hitAt(200, 100 - 8 + 0.01), ['aaaaaaaa']);
  assert.deepEqual(hitAt(300 + 8 - 0.01, 100), ['aaaaaaaa']); // past the end
  assert.deepEqual(hitAt(300 + 8 + 0.01, 100), []);
  // The pressure nib reaches 0.65 × size.
  const p = new SpatialIndex(LETTER, [pen('bbbbbbbb', line(100, 100, 300, 100), 4, 'pressure')]);
  assert.deepEqual(p.hit(pt(200, 108.59), pt(200, 108.59), 6), ['bbbbbbbb']);
  assert.deepEqual(p.hit(pt(200, 108.61), pt(200, 108.61), 6), []);
  // The large eraser reaches further.
  assert.deepEqual(idx.hit(pt(200, 115.99), pt(200, 115.99), 14), ['aaaaaaaa']);
  assert.deepEqual(idx.hit(pt(200, 116.01), pt(200, 116.01), 14), []);
});

test('spatial: a segment hits what it passes near, not only its ends; each id once', () => {
  // Three vertical lines at x 100, 200, 300 (y 50 to 150) and one far away.
  const idx = new SpatialIndex(LETTER, [
    pen('00000001', line(100, 50, 100, 150)), pen('00000002', line(200, 50, 200, 150)),
    pen('00000003', line(300, 50, 300, 150)), pen('00000004', line(100, 600, 300, 600)),
  ]);
  // One long segment across all three lines (spanning many cells).
  assert.deepEqual(ids(idx.hit(pt(50, 100), pt(350, 100), 6)), ['00000001', '00000002', '00000003']);
  // Parallel to a line, 10 px away: misses with radius 6 (reach 7), hits with 14.
  assert.deepEqual(idx.hit(pt(110, 60), pt(110, 140), 6), []);
  assert.deepEqual(idx.hit(pt(110, 60), pt(110, 140), 14), ['00000001']);
  // The polyline form tests every segment and reports each id once.
  assert.deepEqual(ids(idx.hitPath([pt(90, 100), pt(210, 100), pt(210, 120), pt(90, 120)], 6)), ['00000001', '00000002']);
  assert.deepEqual(idx.hitPath([pt(300, 150)], 6), ['00000003']);
  assert.deepEqual(idx.hitPath([], 6), []);
  // Appends to `out`.
  const out = ['x'];
  idx.hit(pt(100, 600), pt(100, 600), 6, out);
  assert.deepEqual(out, ['x', '00000004']);
});

test('spatial: add and remove keep the index in step; a re-added id replaces the old one', () => {
  const idx = new SpatialIndex(LETTER);
  const a = pen('aaaaaaaa', line(10, 10, 700, 900, 2000)); // crosses many cells
  const b = hl('bbbbbbbb', line(10, 500, 800, 500));
  idx.add(a);
  idx.add(b);
  assert.equal(idx.size, 2);
  assert.deepEqual(ids(idx.hit(pt(390, 450), pt(390, 510), 6)), ['aaaaaaaa', 'bbbbbbbb']);
  assert.equal(idx.remove('aaaaaaaa'), true);
  assert.equal(idx.remove('aaaaaaaa'), false);
  assert.equal(idx.has('aaaaaaaa'), false);
  assert.deepEqual(idx.hit(pt(390, 450), pt(390, 510), 6), ['bbbbbbbb']);
  assert.deepEqual(idx.hit(pt(10, 10), pt(10, 10), 6), []);
  idx.add(pen('bbbbbbbb', [pt(50, 50)])); // same id, moved
  assert.equal(idx.size, 1);
  assert.deepEqual(idx.hit(pt(400, 500), pt(400, 500), 6), []);
  assert.deepEqual(idx.hit(pt(50, 50), pt(50, 50), 6), ['bbbbbbbb']);
});

test('spatial: points off the page are found in the edge cells', () => {
  const idx = new SpatialIndex(LETTER, [pen('aaaaaaaa', line(780, 300, 900, 300)), pen('bbbbbbbb', [pt(-40, -40)])]);
  assert.deepEqual(idx.hit(pt(880, 290), pt(880, 310), 6), ['aaaaaaaa']);
  assert.deepEqual(idx.hit(pt(2000, 300), pt(2000, 300), 6), []);
  assert.deepEqual(idx.hit(pt(-40, -40), pt(-40, -40), 6), ['bbbbbbbb']);
  assert.deepEqual(idx.hit(pt(5, 5), pt(5, 5), 6), []);
  assert.equal(CELL, 32);
});

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

test('spatial: 1,000 strokes of 150 points build in under 200 ms; queries take under 1 ms', () => {
  const r = seeded(7);
  const strokes: Stroke[] = [];
  for (let i = 0; i < 1000; i++) {
    // Handwriting-like: a wandering path, about 0.5 px per sample.
    let x = r.range(20, LETTER.width - 20), y = r.range(20, LETTER.height - 20), a = r.range(0, 2 * Math.PI);
    const points: Point[] = [];
    for (let j = 0; j < 150; j++) {
      points.push(pt(x, y));
      a += r.range(-0.3, 0.3);
      x += 0.5 * Math.cos(a);
      y += 0.5 * Math.sin(a);
    }
    strokes.push(pen(i.toString(16).padStart(8, '0'), points, r.range(1.5, 4), i % 2 ? 'pressure' : 'uniform'));
  }
  let t0 = performance.now();
  const idx = new SpatialIndex(LETTER, strokes);
  const build = performance.now() - t0;
  // 500 eraser segments of a few px (the Pencil's movement in a frame), large radius.
  const segs = Array.from({ length: 500 }, () => {
    const x = r.range(0, LETTER.width), y = r.range(0, LETTER.height);
    return [pt(x, y), pt(x + r.range(-6, 6), y + r.range(-6, 6))];
  });
  let hits = 0;
  const out: string[] = [];
  t0 = performance.now();
  for (const [a, b] of segs) {
    out.length = 0;
    hits += idx.hit(a, b, 14, out).length;
  }
  const query = (performance.now() - t0) / segs.length;
  // A brute-force search agrees.
  let brute = 0;
  for (const [a, b] of segs.slice(0, 50)) {
    const want = strokes.filter(s => s.points.some(p => distToSeg(p, a, b) <= 14 + halfWidth(s))).map(s => s.id).sort();
    assert.deepEqual(ids(idx.hit(a, b, 14)), want);
    brute += want.length;
  }
  console.log(`spatial index: build ${build.toFixed(1)} ms for 1,000 strokes of 150 points; query ${(query * 1000).toFixed(1)} us ` +
    `on average over 500 (${hits} hits; ${brute} in the first 50, checked by brute force)`);
  assert.ok(build < 200, `build took ${build} ms`);
  assert.ok(query < 1, `a query took ${query} ms on average`);
  assert.ok(hits > 100, `${hits} hits`);
});

// The partial eraser's geometry (#15): splitStroke.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStrokeId } from '../../src/format/ids';
import type { Stroke } from '../../src/format/page';
import { SpatialIndex } from '../../src/ink/spatial';
import { dist2ToPath, splitStroke } from '../../src/ink/split';

/** A horizontal pen line at y = 50 from x = 0 to 100, one point per px, 2 ms apart, 2 px wide (reach = r + 1). */
const line = (tool: 'pen' | 'highlighter' = 'pen'): Stroke => {
  const base = { id: 'aaaaaaaa', color: '#1e5bd8', size: 2, points: Array.from({ length: 101 }, (_, j) => ({ x: j, y: 50, p: 0.3, t: 2 * j })) };
  return tool === 'pen' ? { ...base, tool, nib: 'uniform' } : { ...base, tool };
};
const vertical = (x: number) => [{ x, y: 0 }, { x, y: 100 }];

test('split: a cut in the middle leaves two strokes ending at the eraser, with boundary points', () => {
  const taken = new Set(['aaaaaaaa']);
  const out = splitStroke(line(), vertical(50), 5.55, taken)!;
  assert.equal(out.length, 2);
  const [a, b] = out;
  assert.equal(a.points.length, 45);  // x 0..43 and the boundary
  assert.deepEqual(a.points.slice(-2), [{ x: 43, y: 50, p: 0.3, t: 86 }, { x: 43.4, y: 50, p: 0.3, t: 87 }]);
  assert.equal(b.points.length, 45);  // the boundary and x 57..100
  assert.deepEqual(b.points.slice(0, 2), [{ x: 56.6, y: 50, p: 0.3, t: 0 }, { x: 57, y: 50, p: 0.3, t: 1 }]);
  assert.equal(b.points[b.points.length - 1].t, 200 - 113);
  for (const s of out) {
    assert.equal(s.tool, 'pen');
    assert.equal(s.color, '#1e5bd8');
    assert.equal(s.size, 2);
    assert.equal((s as { nib: string }).nib, 'uniform');
    assert.equal(s.points[0].t, 0, 't rebased');
    for (const q of s.points) assert.ok(dist2ToPath(q.x, q.y, vertical(50)) > 6.55 ** 2, 'every kept point is outside the reach');
  }
  assert.equal(a.points[0].t, 0);
  assert.ok(isStrokeId(a.id) && isStrokeId(b.id) && a.id !== b.id && a.id !== 'aaaaaaaa' && b.id !== 'aaaaaaaa');
  assert.ok(taken.has(a.id) && taken.has(b.id));
  // The remnants aren't hit again by the same path.
  const index = new SpatialIndex({ width: 816, height: 1056 }, out);
  assert.deepEqual(index.hitPath(vertical(50), 5.55), []);
});

test('split: a cut at one end leaves one stroke; missing leaves it alone; erasing everything leaves none', () => {
  const end = splitStroke(line(), vertical(98), 5, new Set())!;  // reach 6: x 92..100 go, the cut lands between 91 and 92
  assert.equal(end.length, 1);
  assert.equal(end[0].points[0].x, 0);
  assert.deepEqual(end[0].points.slice(-2).map(q => q.x), [91, 91.9]);
  assert.equal(splitStroke(line(), vertical(200), 5, new Set()), null);
  assert.deepEqual(splitStroke(line(), [{ x: 0, y: 50 }, { x: 100, y: 50 }], 5, new Set()), []);
  assert.deepEqual(splitStroke(line(), [{ x: 50, y: 50 }], 200, new Set()), [], 'a tap covering it all');
  assert.equal(splitStroke(line(), [], 5, new Set()), null);
});

test('split: a path crossing twice leaves three strokes; a tap cuts once', () => {
  const zig = [{ x: 30, y: 0 }, { x: 30, y: 100 }, { x: 70, y: 100 }, { x: 70, y: 0 }];
  const out = splitStroke(line(), zig, 3.5, new Set())!;  // reach 4.5: x 26..34 and 66..74 go
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(s => [s.points[0].x, s.points[s.points.length - 1].x]), [[0, 25.4], [34.6, 65.4], [74.6, 100]]);
  const tap = splitStroke(line(), [{ x: 50, y: 52 }], 4, new Set())!;
  assert.equal(tap.length, 2);
});

test('split: tiny remnants (under 2 points) are dropped; highlighter strokes split the same way', () => {
  const out = splitStroke(line(), vertical(2), 3, new Set())!; // cuts x 0..6: nothing survives on the left
  assert.equal(out.length, 1);
  assert.ok(out[0].points[0].x > 6);
  const hl = splitStroke(line('highlighter'), vertical(50), 5.55, new Set())!;
  assert.equal(hl.length, 2);
  assert.ok(hl.every(s => s.tool === 'highlighter' && !('nib' in s)));
  assert.deepEqual(hl.map(s => s.points.length), [45, 45]);
});

test('split: ids are unique across many splits of one page', () => {
  const taken = new Set<string>(['aaaaaaaa']);
  const ids: string[] = [];
  for (let x = 5; x < 100; x += 10) for (const s of splitStroke(line(), vertical(x), 1, taken)!) ids.push(s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(isStrokeId));
});

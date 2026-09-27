// The lasso (#11): its geometry (lasso.ts) and NoteStore.replaceStrokes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStrokeId } from '../../src/format/ids';
import { newNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage, type Point, type Stroke } from '../../src/format/page';
import {
  centreOn, CLIP_FORMAT, decodeClip, encodeClip, lassoSelect, MIN_STROKE_SIZE, moveBy, pointInPolygon, pointsInside, resizeBy, resizeScale,
  strokesBounds, transformBox, transformStroke, withIds, type Box,
} from '../../src/ink/lasso';
import { NoteStore, type NoteFiles } from '../../src/ink/store';
import { seeded } from '../seeded';

const xy = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));
const square = xy([[0, 0], [100, 0], [100, 100], [0, 100]]);
// A "C": the square with a notch cut from the right side (x 40..100, y 30..70).
const concave = xy([[0, 0], [100, 0], [100, 30], [40, 30], [40, 70], [100, 70], [100, 100], [0, 100]]);

const pts = (list: [number, number][]): Point[] => list.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 5 }));
const pen = (id: string, list: [number, number][], size = 2, nib: 'uniform' | 'pressure' = 'uniform'): Stroke =>
  ({ id, tool: 'pen', nib, color: '#000000', size, points: pts(list) });

test('lasso: point in polygon, convex and concave, open or closed loops', () => {
  assert.ok(pointInPolygon(50, 50, square));
  assert.ok(!pointInPolygon(150, 50, square));
  assert.ok(!pointInPolygon(-1, 50, square));
  assert.ok(pointInPolygon(20, 50, concave));
  assert.ok(!pointInPolygon(70, 50, concave), 'the notch is outside');
  assert.ok(pointInPolygon(70, 15, concave));
  assert.ok(pointInPolygon(70, 85, concave));
  // Closing the loop explicitly changes nothing.
  assert.ok(pointInPolygon(20, 50, [...concave, concave[0]]));
  assert.ok(!pointInPolygon(70, 50, [...concave, concave[0]]));
});

test('lasso: strokes with more than half their points inside are selected, in page order', () => {
  const inside = pen('00000001', [[10, 10], [20, 20], [30, 30]]);
  const half = pen('00000002', [[50, 50], [60, 60], [150, 150], [160, 160]]); // 2 of 4: not more than half
  const most = pen('00000003', [[50, 50], [60, 60], [70, 70], [160, 160]]); // 3 of 4
  const out = pen('00000004', [[150, 10], [160, 10]]);
  const notch = pen('00000005', [[60, 45], [70, 50], [80, 55]]); // in the C's notch
  const strokes = [inside, half, most, out, notch];
  assert.equal(pointsInside(half, square), 2);
  assert.deepEqual(lassoSelect(strokes, square), ['00000001', '00000003', '00000005']);
  assert.deepEqual(lassoSelect(strokes, concave), ['00000001']);
  assert.deepEqual(lassoSelect([pen('00000006', [[50, 50]])], square), ['00000006'], 'a dot inside');
  assert.deepEqual(lassoSelect(strokes, square.slice(0, 2)), [], 'a tap or a line selects nothing');
});

test('lasso: bounds grow by half widths (the pressure nib reaches further)', () => {
  assert.equal(strokesBounds([]), null);
  assert.deepEqual(strokesBounds([pen('00000001', [[10, 20], [30, 5]], 4)]), [8, 3, 32, 22]);
  const b = strokesBounds([pen('00000001', [[10, 20]], 4), pen('00000002', [[50, 60]], 10, 'pressure')])!;
  assert.deepEqual(b.map(n => Math.round(n * 10) / 10), [8, 18, 56.5, 66.5]);
  const hl: Stroke = { id: '00000003', tool: 'highlighter', color: '#ffd400', size: 20, points: pts([[0, 0]]) };
  assert.deepEqual(strokesBounds([hl]), [-10, -10, 10, 10]);
});

test('lasso: moving and scaling rewrite points and size, rounded as stored; minimum size', () => {
  const s = pen('00000001', [[10, 20], [30.3, 40.4]], 2.5);
  const moved = transformStroke(s, moveBy(5.04, -0.33));
  assert.deepEqual(moved.points.map(p => [p.x, p.y]), [[15, 19.7], [35.3, 40.1]]);
  assert.equal(moved.size, 2.5);
  assert.equal(moved.id, s.id);
  assert.deepEqual(moved.points.map(p => [p.p, p.t]), s.points.map(p => [p.p, p.t]), 'pressure and times kept');
  assert.deepEqual(s.points[0], { x: 10, y: 20, p: 0.5, t: 0 }, 'the original is untouched');
  const big = transformStroke(s, resizeBy([10, 20, 50, 60], 1.5));
  assert.deepEqual(big.points.map(p => [p.x, p.y]), [[10, 20], [40.5, 50.6]]);
  assert.equal(big.size, 3.8); // 3.75 rounded to 0.1
  const tiny = transformStroke(s, resizeBy([10, 20, 50, 60], 0.1));
  assert.equal(tiny.size, MIN_STROKE_SIZE);
  // Stored as given: a page with transformed strokes reads back the same.
  const page = newPage('p-000001');
  page.strokes = [moved, { ...big, id: '00000002' }, { ...tiny, id: '00000003' }];
  assert.deepEqual(readPage(writePage(page)).strokes, page.strokes);
  // The box follows the same transform.
  assert.deepEqual(transformBox([10, 20, 50, 60], resizeBy([10, 20, 50, 60], 2)), [10, 20, 90, 100]);
  assert.deepEqual(transformBox([10, 20, 50, 60], moveBy(1, 2)), [11, 22, 51, 62]);
});

test('lasso: the corner handle scales uniformly along the diagonal, clamped', () => {
  const box: Box = [0, 0, 100, 50];
  assert.equal(resizeScale(box, { x: 100, y: 50 }, { x: 200, y: 100 }), 2);
  assert.equal(resizeScale(box, { x: 100, y: 50 }, { x: 50, y: 25 }), 0.5);
  // Off the diagonal: the projection.
  assert.ok(Math.abs(resizeScale(box, { x: 100, y: 50 }, { x: 200, y: 50 }) - 1.8) < 1e-9);
  assert.equal(resizeScale(box, { x: 100, y: 50 }, { x: -500, y: -500 }), 0.05);
  assert.equal(resizeScale([0, 0, 10, 10], { x: 10, y: 10 }, { x: 0, y: 0 }), 0.4, 'the box stays at least 4 px');
  assert.equal(resizeScale(box, { x: 100, y: 50 }, { x: 1e6, y: 1e6 }), 20);
});

test('lasso: copies get ids unique on the page; centreOn moves a box centre', () => {
  const r = seeded(3);
  const a = pen('00000001', [[0, 0]]), b = pen('00000002', [[1, 1]]);
  const taken = new Set(['00000001']);
  const kept = withIds([a, b], taken, false, r.bytes);
  assert.notEqual(kept[0].id, '00000001');
  assert.equal(kept[1].id, '00000002');
  assert.ok(kept.every(s => isStrokeId(s.id)));
  assert.equal(taken.size, 3);
  kept[1].points[0].x = 99;
  assert.equal(b.points[0].x, 1, 'deep copies');
  const fresh = withIds([a, b], new Set(), true, r.bytes);
  assert.ok(fresh.every(s => s.id !== a.id && s.id !== b.id) && fresh[0].id !== fresh[1].id);
  assert.deepEqual(centreOn([0, 0, 10, 20], 100, 100), moveBy(95, 90));
});

test('lasso: clipboard JSON is tagged and round-trips; anything else is refused', () => {
  const s = [pen('00000001', [[0, 0], [5, 5]])];
  const text = encodeClip(s);
  assert.equal(JSON.parse(text).format, CLIP_FORMAT);
  assert.deepEqual(decodeClip(text), s);
  assert.equal(decodeClip('hello'), null);
  assert.equal(decodeClip('{"format":"other","strokes":[]}'), null);
  assert.equal(decodeClip(JSON.stringify({ format: CLIP_FORMAT, strokes: [{ id: 1 }] })), null);
});

class MemFiles implements NoteFiles {
  files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.files.set(path, text);
  }
  list(folder: string) {
    return [...this.files.keys()].filter(k => k.startsWith(folder + '/')).map(k => k.slice(folder.length + 1));
  }
}

test('store: replaceStrokes replaces in place, returns the old strokes with indices, marks the page once', async () => {
  const files = new MemFiles();
  const page = newPage('p-000001');
  page.strokes = ['00000001', '00000002', '00000003'].map((id, i) => pen(id, [[i * 10, 0]]));
  const note = newNote('lec', 'letter');
  note.pages = [page.id];
  files.files.set('lec.md', writeNote(note));
  files.files.set('lec/p-000001.svg', writePage(page));
  let edited = 0;
  const store = new NoteStore(files, 'lec.md', 'lec', { pageChanged() {}, indexChanged() {}, notice() {}, saved() {}, pageEdited: () => edited++ }, { delay: 10000 });
  await store.load();
  assert.deepEqual(store.replaceStrokes('p-000001', []), []);
  assert.deepEqual(store.replaceStrokes('p-999999', [{ id: '00000001', stroke: pen('00000001', [[5, 5]]) }]), []);
  assert.deepEqual(store.replaceStrokes('p-000001', [{ id: 'ffffffff', stroke: pen('ffffffff', [[5, 5]]) }]), []);
  assert.equal(store.unsaved, false);
  assert.equal(edited, 0);
  const slot = store.slots[0];
  const before = [...store.page(slot)!.strokes];
  const r = store.replaceStrokes('p-000001', [
    { id: '00000003', stroke: { ...before[2], color: '#e0301e' } },
    { id: '00000001', stroke: transformStroke(before[0], moveBy(1, 1)) },
  ]);
  assert.deepEqual(r, [{ index: 2, stroke: before[2] }, { index: 0, stroke: before[0] }]);
  const after = store.page(slot)!.strokes;
  assert.deepEqual(after.map(s => s.id), ['00000001', '00000002', '00000003']);
  assert.equal(after[2].color, '#e0301e');
  assert.deepEqual(after[0].points[0], { x: 1, y: 1, p: 0.5, t: 0 });
  assert.equal(edited, 1);
  assert.equal(store.unsaved, true);
  // Undo: replace them back.
  store.replaceStrokes('p-000001', r.map(e => ({ id: e.stroke.id, stroke: e.stroke })));
  assert.deepEqual(store.page(slot)!.strokes, before);
  await store.flush();
  assert.deepEqual(readPage(files.files.get('lec/p-000001.svg')!).strokes, before);
});

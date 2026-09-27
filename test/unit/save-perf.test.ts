// #37: writePage memoises each stroke's encoded points and outline; a save of a dense page
// after one new stroke only computes that stroke, and the bytes equal an uncached write.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newStrokeId } from '../../src/format/ids';
import { strokePath, strokePathCached } from '../../src/format/outline';
import { readPage, writePage, type Page, type Stroke } from '../../src/format/page';
import { moveBy, transformStroke, withIds } from '../../src/ink/lasso';
import { splitStroke } from '../../src/ink/split';
import { seeded } from '../seeded';
import { randomPage, randomPoints } from './helpers';

/** A deep copy: new stroke and point objects, so nothing is cached for it. */
const fresh = (page: Page): Page => JSON.parse(JSON.stringify(page));

/** Every <path>'s d equals strokePath of the stroke as read back. */
function checkPaths(svg: string) {
  const page = readPage(svg);
  const ds = new Map<string, string>();
  const re = /<path data-id="([0-9a-f]{8})" [^>]*d="([^"]*)"/g;
  for (let m = re.exec(svg); m; m = re.exec(svg)) ds.set(m[1], m[2]);
  for (const s of page.strokes) assert.equal(ds.get(s.id), strokePath(s), s.id);
}

function same(page: Page) {
  const svg = writePage(page);
  assert.equal(svg, writePage(fresh(page)));
  checkPaths(svg);
}

test('cached writePage: twice, after adding, and after each edit path equals a fresh write', () => {
  const r = seeded(37);
  const page = randomPage(r, 120, 'mixed');
  same(page);
  same(page); // all hits
  const add = (): Stroke => ({ id: newStrokeId(page.strokes.map(s => s.id), r.bytes), tool: 'pen', nib: 'pressure', color: '#000000', size: 3, points: randomPoints(r, 30) });
  page.strokes.push(add());
  same(page);
  // replaceStrokes: a move, a resize and a recolour replace the stroke object.
  page.strokes[1] = transformStroke(page.strokes[1], moveBy(12.3, -4.5));
  same(page);

  const t = transformStroke(page.strokes[2], { k: 1.7, ox: 3, oy: 4, dx: 1, dy: 2 });

  page.strokes[2] = t;
  same(page);
  page.strokes[3] = { ...page.strokes[3], color: '#d0312d' };
  same(page);
  // withIds (paste, move onto another page).
  const pasted = withIds(page.strokes.slice(4, 7), new Set(page.strokes.map(s => s.id)), true, r.bytes);
  page.strokes.push(...pasted);
  same(page);
  // splitStroke (the stroke eraser): remnants replace the stroke.
  const victim = page.strokes.find(s => s.points.length > 20)!;
  const mid = victim.points[10];
  const parts = splitStroke(victim, [{ x: mid.x, y: mid.y }], 4, new Set(page.strokes.map(s => s.id)), r.bytes);
  if (parts) page.strokes.splice(page.strokes.indexOf(victim), 1, ...parts);
  same(page);
  // In-place edits (no edit path does these, but the cache must not go stale on them).
  const s = page.strokes[5];
  s.points.push({ x: 10, y: 20, p: 0.5, t: 999 });
  same(page);
  s.points[s.points.length - 1] = { x: 11, y: 21, p: 0.4, t: 1000 };
  same(page);
  s.points = s.points.slice(0, 5);
  same(page);
  s.size = s.size + 1.23;
  same(page);
  if (s.tool === 'pen') s.nib = s.nib === 'uniform' ? 'pressure' : 'uniform';
  same(page);
  (s as Stroke).tool = s.tool === 'pen' ? 'highlighter' : 'pen';
  if (s.tool === 'pen') (s as Stroke & { nib: string }).nib = 'uniform'; else delete (s as { nib?: string }).nib;
  same(page);
  s.color = '#3ddc84';
  same(page);
});

test('strokePathCached equals strokePath and invalidates on in-place changes', () => {
  const r = seeded(3);
  const s: Stroke = { id: 'aaaaaaaa', tool: 'pen', nib: 'uniform', color: '#000000', size: 2, points: randomPoints(r, 40) };
  assert.equal(strokePathCached(s), strokePath(s));
  s.size = 5;
  assert.equal(strokePathCached(s), strokePath(s));
  s.points.push({ x: 1, y: 1, p: 0.5, t: 5000 });
  assert.equal(strokePathCached(s), strokePath(s));
});

test('a save of a 1,000-stroke page after one new stroke takes under 16 ms', () => {
  const r = seeded(1000);
  const page = readPage(writePage(randomPage(r, 1000, 'mixed'))); // as loaded from a file
  let t0 = performance.now();
  const cold = writePage(page);
  const coldMs = performance.now() - t0;
  page.strokes.push({ id: newStrokeId(page.strokes.map(s => s.id), r.bytes), tool: 'pen', nib: 'pressure', color: '#000000', size: 3, points: randomPoints(r, 200) });
  const times: number[] = [];
  let warm = '';
  for (let i = 0; i < 5; i++) {
    t0 = performance.now();
    warm = writePage(page);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`# 1,000 strokes: cold ${coldMs.toFixed(1)} ms, after one new stroke median ${times[2].toFixed(1)} ms, max ${times[4].toFixed(1)} ms`);
  assert.ok(cold.length > 0);
  assert.ok(times[2] < 16, `save took ${times[2].toFixed(1)} ms`);
  assert.equal(warm, writePage(fresh(page)));
});

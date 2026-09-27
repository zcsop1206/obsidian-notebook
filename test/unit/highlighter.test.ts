// The highlighter (#6): its settings, and that its outline (the live one and the saved one) is
// strokePath of the committed stroke, constant width with flat ends.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIGHLIGHTER_OPTIONS, strokePath } from '../../src/format/outline';
import { newPage, readPage, roundP, roundXY, writePage, type HighlighterStroke, type Point } from '../../src/format/page';
import type { NewStroke, StrokeStyle } from '../../src/ink/input';
import {
  clampHighlighterSize, DEFAULT_HIGHLIGHTER, DEFAULT_PEN, HIGHLIGHTER_COLORS, HIGHLIGHTER_SIZES, nextHighlighterColor,
  nextHighlighterSize, withHighlighter, withPen,
} from '../../src/ink/pen';

test('highlighter: defaults and presets', () => {
  assert.deepEqual(DEFAULT_HIGHLIGHTER, { color: '#ffd400', size: 18 });
  assert.deepEqual(HIGHLIGHTER_COLORS.map(c => c.color), ['#ffd400', '#3ddc84', '#ff5fa2', '#4fc3f7', '#ffa726']);
  assert.deepEqual(HIGHLIGHTER_COLORS.map(c => c.name), ['Yellow', 'Green', 'Pink', 'Blue', 'Orange']);
  assert.deepEqual(HIGHLIGHTER_SIZES, [14, 24]);
});

test('highlighter: withHighlighter validates colours and clamps sizes', () => {
  const h = withHighlighter(DEFAULT_HIGHLIGHTER, { color: '#4FC3F7', size: 23.8 });
  assert.deepEqual(h, { color: '#4fc3f7', size: 24 });
  assert.deepEqual(DEFAULT_HIGHLIGHTER, { color: '#ffd400', size: 18 }); // not changed
  assert.throws(() => withHighlighter(DEFAULT_HIGHLIGHTER, { color: 'yellow' }), /Invalid highlighter colour/);
  assert.throws(() => withHighlighter(DEFAULT_HIGHLIGHTER, { color: '#ffd40' }), /Invalid highlighter colour/);
  assert.equal(withHighlighter(DEFAULT_HIGHLIGHTER, { size: 1 }).size, 4);
  assert.equal(withHighlighter(DEFAULT_HIGHLIGHTER, { size: 100 }).size, 48);
  assert.equal(clampHighlighterSize(NaN), 18);
  assert.equal(clampHighlighterSize(14.2), 14);
  assert.deepEqual(withHighlighter(h, {}), h);
});

test('highlighter: the tool is part of the pen settings and switching keeps the pen\'s colour and size', () => {
  const pen = withPen(DEFAULT_PEN, { color: '#e0301e', size: 4 });
  const hl = withPen(pen, { tool: 'highlighter' });
  assert.deepEqual(hl, { tool: 'highlighter', nib: 'uniform', color: '#e0301e', size: 4 });
  assert.deepEqual(withPen(hl, { tool: 'pen' }), pen);
  assert.throws(() => withPen(pen, { tool: 'marker' as never }), /Unknown tool/);
});

test('highlighter: next colour and size cycle through the presets', () => {
  let c = HIGHLIGHTER_COLORS[0].color;
  const seen = [c];
  for (let i = 0; i < 5; i++) seen.push(c = nextHighlighterColor(c));
  assert.deepEqual(seen, [...HIGHLIGHTER_COLORS.map(p => p.color), HIGHLIGHTER_COLORS[0].color]);
  assert.equal(nextHighlighterColor('#123456'), '#ffd400');
  assert.equal(nextHighlighterSize(18), 24); // the default is between the presets
  assert.equal(nextHighlighterSize(24), 14);
  assert.equal(nextHighlighterSize(14), 24);
  assert.equal(nextHighlighterSize(4), 14);
});

/** Points along a horizontal line, rounded as the input rounds them, with rising pressure. */
const line = (x0: number, x1: number, y: number, n: number): Point[] =>
  Array.from({ length: n }, (_, j) => ({ x: roundXY(x0 + (x1 - x0) * j / (n - 1)), y, p: roundP(0.1 + 0.8 * j / n), t: j * 2 }));

/** The outline's vertices. */
function xs(d: string): number[][] {
  const out: number[][] = [], re = /[ML](-?[\d.]+) (-?[\d.]+)/g;
  for (let m = re.exec(d); m; m = re.exec(d)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

test('highlighter: the outline for the points is strokePath of the committed stroke, also after a save', () => {
  const style: StrokeStyle = { tool: 'highlighter', color: '#ffd400', size: 18 };
  const points = line(100, 400, 200, 300);
  // What PenInput draws live (strokePath of its style and the points) and what it commits.
  const live = strokePath({ ...style, points });
  const committed: NewStroke = { ...style, points };
  assert.equal(committed.tool, 'highlighter');
  assert.ok(!('nib' in committed));
  const stroke: HighlighterStroke = { id: '0000000a', ...committed } as HighlighterStroke;
  assert.equal(live, strokePath(stroke));
  const page = newPage('p-00000a');
  page.strokes.push(stroke);
  const text = writePage(page);
  assert.match(text, new RegExp(`<g id="highlight" opacity="0.4">[^]*data-id="0000000a"[^]*</g>[^]*<g id="ink"`));
  const back = readPage(text).strokes[0];
  assert.deepEqual(back, stroke);
  assert.equal(strokePath(back), live);
});

test('highlighter: constant width and flat ends, where the pen\'s ends are round', () => {
  assert.equal(HIGHLIGHTER_OPTIONS.thinning, 0);
  const points = line(100, 400, 200, 300);
  const hl = xs(strokePath({ tool: 'highlighter', size: 18, points }));
  const pen = xs(strokePath({ tool: 'pen', nib: 'uniform', size: 18, points }));
  const extent = (pts: number[][]) => [Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0]))];
  const [h0, h1] = extent(hl), [p0, p1] = extent(pen);
  // Flat: the outline stops at the first and last points; a round cap reaches size / 2 beyond.
  assert.ok(h0 > 99 && h1 < 401, `highlighter spans ${h0}..${h1}`);
  assert.ok(p0 < 92 && p1 > 408, `pen spans ${p0}..${p1}`);
  // Each end is a straight edge across the full width: points at the end x span 18 px in y.
  const atEnd = (x: number) => hl.filter(p => Math.abs(p[0] - x) < 0.6).map(p => p[1]);
  for (const x of [h0, h1]) {
    const ys = atEnd(x);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 17, `end at ${x}: ${ys}`);
  }
  // Constant width whatever the pressure.
  for (const x of [150, 250, 350]) {
    const ys = hl.filter(p => Math.abs(p[0] - x) < 1.5).map(p => p[1]);
    assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 18) < 0.5, `width at ${x}: ${ys}`);
  }
});

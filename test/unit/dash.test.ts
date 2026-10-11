// Dashed and dotted lines (#70): the per-stroke `dash` in the format (uniform nib only; absent =
// solid, so solid strokes keep their bytes), the dash arrays per size, the SVG attribute, the PDF
// `d` operator, the pen settings and favourites, and the partial eraser's remnants.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashArray, strokeGeometry, strokePath } from '../../src/format/outline';
import { newPage, readPage, writePage, type PenStroke, type Point } from '../../src/format/page';
import { strokeOps } from '../../src/ink/export-pdf';
import {
  DEFAULT_PEN, matchesPreset, parsePreset, parsePresets, parseToolState, presetOf, withPen, DEFAULT_HIGHLIGHTER, type PenSettings,
} from '../../src/ink/pen';
import { splitStroke } from '../../src/ink/split';

const pts = (n = 60): Point[] => Array.from({ length: n }, (_, j) => ({ x: 10 + j, y: 20 + 3 * Math.sin(j / 9), p: 0.3, t: 4 * j }));
const pen = (extra: Partial<PenStroke> = {}): PenStroke => ({ id: 'aaaaaaaa', tool: 'pen', nib: 'uniform', color: '#000000', size: 2.5, points: pts(), ...extra });

test('#70 dash arrays: dashed is 3 × size on, 2 × size off; dotted 0 on, 2 × size off; solid, pressure and highlighter none', () => {
  assert.deepEqual(dashArray({ tool: 'pen', nib: 'uniform', size: 2.5, dash: 'dashed' }), [7.5, 5]);
  assert.deepEqual(dashArray({ tool: 'pen', nib: 'uniform', size: 2.5, dash: 'dotted' }), [0, 5]);
  assert.deepEqual(dashArray({ tool: 'pen', nib: 'uniform', size: 1, dash: 'dashed' }), [3, 2]);
  assert.deepEqual(dashArray({ tool: 'pen', nib: 'uniform', size: 0.5, dash: 'dotted' }), [0, 1]);
  assert.deepEqual(dashArray({ tool: 'pen', nib: 'uniform', size: 0.7, dash: 'dashed' }), [2.1, 1.4], 'to 0.1 px, no float noise');
  assert.equal(dashArray({ tool: 'pen', nib: 'uniform', size: 2.5 }), null);
  assert.equal(dashArray({ tool: 'pen', nib: 'pressure', size: 2.5, dash: 'dashed' }), null);
  assert.equal(dashArray({ tool: 'highlighter', size: 18, dash: 'dashed' }), null);
});

test('#70 format: dash is written after size (and the tunables), round-trips, and the path gets stroke-dasharray', () => {
  const page = newPage('p-0a0b0c');
  page.strokes.push(pen({ id: 'aaaaaaa1', dash: 'dashed' }));
  page.strokes.push(pen({ id: 'aaaaaaa2', dash: 'dotted', color: '#1e6fff', size: 1, smooth: 3 }));
  page.strokes.push(pen({ id: 'aaaaaaa3' }));
  const text = writePage(page);
  assert.match(text, /\{"id":"aaaaaaa1","tool":"pen","nib":"uniform","color":"#000000","size":2.5,"dash":"dashed","points":/);
  assert.match(text, /\{"id":"aaaaaaa2","tool":"pen","nib":"uniform","color":"#1e6fff","size":1,"smooth":3,"dash":"dotted","points":/);
  assert.match(text, /\{"id":"aaaaaaa3","tool":"pen","nib":"uniform","color":"#000000","size":2.5,"points":/);
  const [a, b, c] = readPage(text).strokes; // the points as stored, to 0.1 px
  const line = (id: string) => text.split('\n').find(l => l.startsWith(`<path data-id="${id}"`));
  assert.equal(line('aaaaaaa1'), `<path data-id="aaaaaaa1" class="u" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="7.5 5" d="${strokePath(a)}"/>`);
  assert.equal(line('aaaaaaa2'), `<path data-id="aaaaaaa2" fill="none" stroke="#1e6fff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0 2" d="${strokePath(b)}"/>`);
  assert.equal(line('aaaaaaa3'), `<path data-id="aaaaaaa3" class="u" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="${strokePath(c)}"/>`);
  // The same centreline as solid: a reader that ignores `dash` draws it solid.
  assert.equal(strokePath(a), strokePath({ ...a, dash: undefined } as PenStroke));
  const back = readPage(text).strokes as PenStroke[];
  assert.deepEqual(back.map(s => s.dash), ['dashed', 'dotted', undefined]);
  assert.ok(!('dash' in back[2]));
  assert.equal(writePage(readPage(text)), text);
});

test('#70 format: solid is no dash; unknown dashes, dashes on the pressure nib or the highlighter are refused', () => {
  const page = (fields: Record<string, unknown>, nib = 'uniform', tool = 'pen') => {
    const s = { id: 'aaaaaaaa', tool, ...(tool === 'pen' ? { nib } : {}), color: '#000000', size: 2, ...fields, points: [1, 2, 0.5, 0] };
    return `<svg><metadata><![CDATA[${JSON.stringify({ format: 'notebook-ink/1', id: 'p-0a0b0c', size: { width: 100, height: 100 }, template: { kind: 'blank' }, strokes: [s] })}]]></metadata></svg>`;
  };
  assert.ok(!('dash' in readPage(page({ dash: 'solid' })).strokes[0]));
  assert.throws(() => readPage(page({ dash: 'dashdot' })), /unknown dash/);
  assert.throws(() => readPage(page({ dash: 'dashed' }, 'pressure')), /only the uniform nib/);
  assert.throws(() => readPage(page({ dash: 'dotted' }, '', 'highlighter')), /only pen strokes/);
});

test('#70 a dashed or dotted stroke has no taper; its area (the lasso) is the solid envelope', () => {
  const g = strokeGeometry(pen({ dash: 'dashed', taper: 2 }));
  assert.equal(g.ends, '');
  assert.equal(g.d, strokePath(pen()));
});

test('#70 PDF: the d operator with the same array, then back to solid', () => {
  const ops = strokeOps(pen({ dash: 'dashed', color: '#e0301e' }));
  assert.match(ops, /^0\.878 0\.188 0\.118 RG 2\.5 w 1 J 1 j \[7\.5 5\] 0 d\n[\s\S]*\nS\n\[\] 0 d\n$/);
  assert.match(strokeOps(pen({ dash: 'dotted', size: 1 })), / 1 w 1 J 1 j \[0 2\] 0 d\n/);
  assert.equal(strokeOps(pen()).includes(' d\n'), false, 'solid: no dash operator, as before');
});

test('#70 pen settings: the line is solid by default; dashed and dotted only with the uniform nib', () => {
  assert.equal(DEFAULT_PEN.dash, 'solid');
  const dashed = withPen(DEFAULT_PEN, { dash: 'dashed' });
  assert.deepEqual([dashed.nib, dashed.dash], ['uniform', 'dashed']);
  // Choosing the pressure nib makes the line solid.
  assert.deepEqual([withPen(dashed, { nib: 'pressure' }).nib, withPen(dashed, { nib: 'pressure' }).dash], ['pressure', 'solid']);
  // Choosing a dashed line with the pressure nib switches to the uniform nib.
  const p = withPen(DEFAULT_PEN, { nib: 'pressure' });
  assert.deepEqual([withPen(p, { dash: 'dotted' }).nib, withPen(p, { dash: 'dotted' }).dash], ['uniform', 'dotted']);
  // Both at once: the nib wins.
  assert.equal(withPen(DEFAULT_PEN, { nib: 'pressure', dash: 'dashed' }).dash, 'solid');
  assert.throws(() => withPen(DEFAULT_PEN, { dash: 'wavy' as PenSettings['dash'] }), /Unknown line/);
  // Saved and restored with the tools; a dashed pressure pen is read as solid.
  assert.equal(parseToolState({ pen: { nib: 'uniform', dash: 'dotted' } }).pen.dash, 'dotted');
  assert.equal(parseToolState({ pen: { nib: 'pressure', dash: 'dotted' } }).pen.dash, 'solid');
  assert.equal(parseToolState({ pen: {} }).pen.dash, 'solid');
});

test('#70 favourites carry the line: saved, parsed, matched', () => {
  const pen: PenSettings = { ...DEFAULT_PEN, dash: 'dashed' };
  const preset = presetOf(pen, DEFAULT_HIGHLIGHTER)!;
  assert.deepEqual(preset, { tool: 'pen', color: '#000000', size: 2.5, nib: 'uniform', dash: 'dashed' });
  assert.ok(matchesPreset(preset, pen, DEFAULT_HIGHLIGHTER));
  assert.ok(!matchesPreset(preset, DEFAULT_PEN, DEFAULT_HIGHLIGHTER), 'a solid pen is not the dashed favourite');
  assert.ok(!matchesPreset({ ...preset, dash: undefined }, pen, DEFAULT_HIGHLIGHTER));
  assert.deepEqual(presetOf(DEFAULT_PEN, DEFAULT_HIGHLIGHTER), { tool: 'pen', color: '#000000', size: 2.5, nib: 'uniform' }, 'solid: no dash, as before');
  assert.deepEqual(parsePreset(JSON.parse(JSON.stringify(preset))), preset);
  assert.equal(parsePreset({ tool: 'pen', color: '#000000', size: 2, nib: 'uniform', dash: 'dotted' })!.dash, 'dotted');
  assert.equal(parsePreset({ tool: 'pen', color: '#000000', size: 2, nib: 'pressure', dash: 'dotted' })!.dash, undefined);
  assert.equal(parsePreset({ tool: 'pen', color: '#000000', size: 2, dash: 'zigzag' })!.dash, undefined);
  assert.equal(parsePresets([preset])[0]!.dash, 'dashed');
});

test('#70 partial eraser: the remnants of a dashed stroke keep its dash', () => {
  const s = pen({ dash: 'dotted', points: Array.from({ length: 101 }, (_, j) => ({ x: j, y: 50, p: 0.3, t: 2 * j })) });
  const out = splitStroke(s, [{ x: 50, y: 0 }, { x: 50, y: 100 }], 5, new Set(['aaaaaaaa']))!;
  assert.equal(out.length, 2);
  for (const r of out) assert.equal((r as PenStroke).dash, 'dotted');
});

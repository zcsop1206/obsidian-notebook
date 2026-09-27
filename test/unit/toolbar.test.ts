// The toolbar (#10): size stepping, favourite presets (parsing, matching) and the saved tool
// state read back from settings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ERASER, DEFAULT_HIGHLIGHTER, DEFAULT_PEN, DEFAULT_PRESETS, matchesPreset, MAX_PRESETS, parsePreset, parsePresets,
  parseToolState, presetOf, stepSize,
} from '../../src/ink/pen';
import { previewPoints } from '../../src/ink/picker';

/** Runs fn with console.warn captured; returns the warnings. */
function warnings(fn: () => void): string[] {
  const out: string[] = [], warn = console.warn;
  console.warn = (...a: unknown[]) => void out.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return out;
}

test('toolbar: sizes step by 0.5 px within each tool\'s limits', () => {
  assert.equal(stepSize('pen', 2.5, 1), 3);
  assert.equal(stepSize('pen', 2.5, -1), 2);
  assert.equal(stepSize('pen', 0.5, -1), 0.5);
  assert.equal(stepSize('pen', 16, 1), 16);
  assert.equal(stepSize('pen', 2.3, 1), 3); // 2.8 rounds to the 0.5 grid
  let s = 0.5, steps = 0;
  while (s < 16) {
    s = stepSize('pen', s, 1);
    steps++;
  }
  assert.equal(steps, 31); // 0.5 to 16 in 0.5 steps
  assert.equal(stepSize('highlighter', 18, 1), 18.5);
  assert.equal(stepSize('highlighter', 4, -1), 4);
  assert.equal(stepSize('highlighter', 48, 1), 48);
});

test('toolbar: five default presets, valid and distinct', () => {
  assert.equal(DEFAULT_PRESETS.length, MAX_PRESETS);
  assert.deepEqual(DEFAULT_PRESETS.map(p => parsePreset(p)), DEFAULT_PRESETS);
  assert.deepEqual(DEFAULT_PRESETS[0], { tool: 'pen', color: '#000000', size: 2.5, nib: 'uniform' });
  assert.deepEqual(DEFAULT_PRESETS[4], { tool: 'highlighter', color: '#ffd400', size: 18 });
  assert.equal(new Set(DEFAULT_PRESETS.map(p => JSON.stringify(p))).size, 5);
});

test('toolbar: parsePreset normalises and rejects', () => {
  assert.deepEqual(parsePreset({ tool: 'pen', color: '#AABBCC', size: 2.3 }), { tool: 'pen', color: '#aabbcc', size: 2.5, nib: 'uniform' });
  assert.deepEqual(parsePreset({ tool: 'pen', color: '#000000', size: 99, nib: 'pressure' }), { tool: 'pen', color: '#000000', size: 16, nib: 'pressure' });
  assert.deepEqual(parsePreset({ tool: 'highlighter', color: '#ffd400', size: 1, nib: 'pressure' }), { tool: 'highlighter', color: '#ffd400', size: 4 });
  for (const bad of [null, 3, 'pen', {}, { tool: 'eraser', color: '#000000', size: 6 }, { tool: 'pen', color: 'red', size: 2 },
    { tool: 'pen', color: '#000000', size: '2' }, { tool: 'pen', color: '#000000', size: NaN }, { tool: 'pen', color: '#000000', size: 2, nib: 'brush' }]) {
    assert.equal(parsePreset(bad), null, JSON.stringify(bad));
  }
});

test('toolbar: parsePresets keeps at most five slots; bad entries become empty slots with a warning', () => {
  assert.deepEqual(parsePresets(undefined), DEFAULT_PRESETS);
  let got: unknown;
  assert.equal(warnings(() => (got = parsePresets('x'))).length, 1);
  assert.deepEqual(got, DEFAULT_PRESETS);
  const w = warnings(() => (got = parsePresets([{ tool: 'pen', color: '#1e6fff', size: 3 }, null, { tool: 'pen', color: 'nope', size: 3 }])));
  assert.deepEqual(got, [{ tool: 'pen', color: '#1e6fff', size: 3, nib: 'uniform' }, null, null]);
  assert.equal(w.length, 1);
  const many = Array.from({ length: 7 }, () => ({ tool: 'highlighter', color: '#ffd400', size: 14 }));
  assert.equal(warnings(() => (got = parsePresets(many))).length, 1);
  assert.equal((got as unknown[]).length, MAX_PRESETS);
  assert.deepEqual(parsePresets([]), []);
});

test('toolbar: the current settings match a preset only exactly, for the tool in use', () => {
  const pen = { ...DEFAULT_PEN }, hl = { ...DEFAULT_HIGHLIGHTER };
  assert.ok(matchesPreset(DEFAULT_PRESETS[0], pen, hl));
  assert.ok(!matchesPreset(DEFAULT_PRESETS[1], pen, hl));
  assert.ok(!matchesPreset(DEFAULT_PRESETS[3], pen, hl)); // black, but 4 px pressure
  assert.ok(matchesPreset(DEFAULT_PRESETS[3], { ...pen, size: 4, nib: 'pressure' }, hl));
  assert.ok(matchesPreset({ tool: 'pen', color: '#000000', size: 2.5 }, pen, hl)); // no nib: uniform
  assert.ok(!matchesPreset(DEFAULT_PRESETS[4], pen, hl)); // highlighter preset while the pen is in use
  assert.ok(matchesPreset(DEFAULT_PRESETS[4], { ...pen, tool: 'highlighter' }, hl));
  assert.ok(!matchesPreset(DEFAULT_PRESETS[4], { ...pen, tool: 'highlighter' }, { ...hl, size: 24 }));
  assert.ok(!matchesPreset(DEFAULT_PRESETS[0], { ...pen, tool: 'eraser' }, hl));
  assert.ok(!matchesPreset(null, pen, hl));
  // presetOf is the preset that matches
  assert.ok(matchesPreset(presetOf(pen, hl), pen, hl));
  assert.deepEqual(presetOf({ ...pen, tool: 'highlighter' }, hl), { tool: 'highlighter', color: '#ffd400', size: 18 });
  assert.equal(presetOf({ ...pen, tool: 'eraser' }, hl), null);
});

test('toolbar: the tool state round-trips and each bad field falls back on its own', () => {
  const state = {
    pen: { tool: 'highlighter' as const, nib: 'pressure' as const, color: '#e0301e', size: 4.5 },
    highlighter: { color: '#3ddc84', size: 24 },
    eraser: { size: 14, mode: 'stroke' as const },
  };
  assert.deepEqual(parseToolState(JSON.parse(JSON.stringify(state))), state);
  assert.deepEqual(parseToolState(undefined), { pen: DEFAULT_PEN, highlighter: DEFAULT_HIGHLIGHTER, eraser: DEFAULT_ERASER });
  let got: ReturnType<typeof parseToolState> | undefined;
  const w = warnings(() => (got = parseToolState({
    pen: { tool: 'lasso', nib: 'pressure', color: 'blue', size: 40 },
    highlighter: { color: '#3ddc84', size: 'big' },
    eraser: { size: 13, mode: 'smudge' },
  })));
  assert.deepEqual(got, {
    pen: { tool: 'pen', nib: 'pressure', color: '#000000', size: 16 },
    highlighter: { color: '#3ddc84', size: 18 },
    eraser: { size: 14, mode: 'partial' },
  });
  assert.equal(w.length, 4); // tool, colour, highlighter size, eraser mode
  assert.equal(warnings(() => (got = parseToolState('x'))).length, 1);
  assert.deepEqual(got!.pen, DEFAULT_PEN);
});

test('toolbar: the preview curve stays inside its canvas', () => {
  const pts = previewPoints(220, 60);
  assert.ok(pts.length > 10);
  for (const p of pts) assert.ok(p.x > 0 && p.x < 220 && p.y > 0 && p.y < 60 && p.p > 0 && p.p <= 1);
});

// The toolbar (#10): size stepping, favourite presets (parsing, matching) and the saved tool
// state read back from settings; #71: the size slider's scale, the layouts the toolbar tries,
// the size bar under the pen and highlighter buttons, and the toolbar size setting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ERASER, DEFAULT_HIGHLIGHTER, DEFAULT_PEN, DEFAULT_PRESETS, HIGHLIGHTER_SIZES, matchesPreset, MAX_PRESETS, parsePreset,
  parsePresets, parseToolState, presetOf, SIZE_PRESETS, sizeRange, sliderPosition, sliderSize, stepSize,
} from '../../src/ink/pen';
import { previewPoints } from '../../src/ink/picker';
import {
  parseToolbarSize, SIZE_BAR_MAX, sizeBarWidth, STRIP_MIN_WIDTH, TOOLBAR_BUTTON_PX, toolbarLayouts,
} from '../../src/ink/toolbar-layout';

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
    pen: { tool: 'ruler', nib: 'pressure', color: 'blue', size: 40 },
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

// ---- #71

test('size slider: every 0.5 px size round-trips through its position; the ends are the limits', () => {
  for (const tool of ['pen', 'highlighter'] as const) {
    const { min, max } = sizeRange(tool);
    assert.equal(sliderSize(tool, 0), min);
    assert.equal(sliderSize(tool, 1), max);
    assert.equal(sliderSize(tool, -3), min);
    assert.equal(sliderSize(tool, 7), max);
    assert.equal(sliderSize(tool, NaN), min);
    let last = -1;
    for (let s = min; s <= max; s += 0.5) {
      const u = sliderPosition(tool, s);
      assert.ok(u >= 0 && u <= 1 && u > last, `${tool} ${s}`);
      last = u;
      assert.equal(sliderSize(tool, u), s, `${tool} ${s}`);
    }
  }
});

test('size slider: sizes come in 0.5 px steps and grow with the position', () => {
  let prev = 0;
  for (let i = 0; i <= 1000; i++) {
    const s = sliderSize('pen', i / 1000);
    assert.equal(s * 2, Math.round(s * 2));
    assert.ok(s >= prev);
    prev = s;
  }
});

test('size slider: the quick sizes are spread out as ticks, not crowded at the start', () => {
  const pen = SIZE_PRESETS.map(s => sliderPosition('pen', s));
  assert.ok(pen[0] > 0.25 && pen[2] < 0.7, String(pen));
  for (let i = 1; i < pen.length; i++) assert.ok(pen[i] - pen[i - 1] > 0.1, String(pen)); // over 18 px apart on a 182 px track
  const hl = HIGHLIGHTER_SIZES.map(s => sliderPosition('highlighter', s));
  assert.ok(hl[1] - hl[0] > 0.1, String(hl));
});

test('toolbar layout: the colour strip from 900 px; labels drop first, then the page actions fold', () => {
  assert.deepEqual(toolbarLayouts(768), [
    { strip: false, collapsed: false, labels: true }, { strip: false, collapsed: false, labels: false }, { strip: false, collapsed: true, labels: false },
  ]);
  assert.deepEqual(toolbarLayouts(STRIP_MIN_WIDTH - 1).map(l => l.strip), [false, false, false]);
  assert.deepEqual(toolbarLayouts(STRIP_MIN_WIDTH), [
    { strip: true, collapsed: false, labels: true }, { strip: true, collapsed: false, labels: false }, { strip: true, collapsed: true, labels: false },
    { strip: false, collapsed: true, labels: false },
  ]);
  for (const w of [320, 768, 900, 1024, 1366]) assert.ok(toolbarLayouts(w).at(-1)!.collapsed, String(w)); // the last resort folds
});

test('toolbar: the size bar grows with the size over each tool\'s range and fits a compact button', () => {
  assert.equal(sizeBarWidth('pen', 0.5), 4);
  assert.equal(sizeBarWidth('pen', 16), SIZE_BAR_MAX);
  assert.equal(sizeBarWidth('highlighter', 4), 4);
  assert.equal(sizeBarWidth('highlighter', 48), SIZE_BAR_MAX);
  assert.ok(sizeBarWidth('pen', 1.5) < sizeBarWidth('pen', 2.5) && sizeBarWidth('pen', 2.5) < sizeBarWidth('pen', 4));
  assert.equal(sizeBarWidth('pen', 99), SIZE_BAR_MAX);
  assert.ok(SIZE_BAR_MAX < TOOLBAR_BUTTON_PX.compact);
});

test('toolbar size setting: compact 36 px or comfortable 44 px, comfortable by default and for bad values', () => {
  assert.equal(parseToolbarSize(undefined), 'comfortable');
  assert.equal(parseToolbarSize('compact'), 'compact');
  assert.equal(parseToolbarSize('huge'), 'comfortable');
  assert.deepEqual(TOOLBAR_BUTTON_PX, { compact: 36, comfortable: 44 });
});

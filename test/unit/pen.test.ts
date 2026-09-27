// The pen (#5): settings, sampling pointer events (with fake coalesced and predicted events),
// the frozen head of a long live stroke, and that the live outline is the saved one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pressureCurve, strokePath } from '../../src/format/outline';
import { newPage, readPage, writePage, type PenStroke, type Point } from '../../src/format/page';
import {
  addSamples, blockStylusTouch, LIVE_KEEP, LIVE_MAX, livePlan, MIN_STEP, newTrace, OVERLAP, predictedPoints, samplesOf,
  type PageMap, type Sample, type SampledEvent,
} from '../../src/ink/input';
import { clampSize, COLOR_PRESETS, DEFAULT_PEN, nextColor, nextSize, parseColor, SIZE_PRESETS, withPen } from '../../src/ink/pen';

test('pen: defaults, presets and clampSize', () => {
  assert.deepEqual(DEFAULT_PEN, { tool: 'pen', nib: 'uniform', color: '#000000', size: 2.5 });
  assert.deepEqual(COLOR_PRESETS.map(c => c.color),
    ['#000000', '#1e6fff', '#e0301e', '#1f9d55', '#f28c28', '#7b4fd6', '#ff5fa2', '#8a8a8a']);
  assert.deepEqual(SIZE_PRESETS, [1.5, 2.5, 4]);
  assert.equal(clampSize(0.1), 0.5);
  assert.equal(clampSize(-3), 0.5);
  assert.equal(clampSize(20), 16);
  assert.equal(clampSize(16), 16);
  assert.equal(clampSize(2.3), 2.5);
  assert.equal(clampSize(2.2), 2);
  assert.equal(clampSize(0.76), 1);
  assert.equal(clampSize(NaN), 2.5);
  assert.equal(clampSize(Infinity), 2.5);
});

test('pen: colours must be #rrggbb and are lowercased; withPen validates and clamps', () => {
  assert.equal(parseColor('#1E6FFF'), '#1e6fff');
  assert.equal(parseColor(' #abcdef '), '#abcdef');
  for (const bad of ['red', '#12345', '#1234567', '123456', '#ggg000', '', 5, null]) assert.equal(parseColor(bad), null, String(bad));
  const pen = withPen(DEFAULT_PEN, { color: '#A0B0C0', size: 7.3, nib: 'pressure' });
  assert.deepEqual(pen, { tool: 'pen', nib: 'pressure', color: '#a0b0c0', size: 7.5 });
  assert.deepEqual(DEFAULT_PEN, { tool: 'pen', nib: 'uniform', color: '#000000', size: 2.5 }); // not changed
  assert.throws(() => withPen(DEFAULT_PEN, { color: 'blue' }), /Invalid pen colour/);
  assert.throws(() => withPen(DEFAULT_PEN, { nib: 'fountain' as never }), /Unknown nib/);
  assert.equal(withPen(DEFAULT_PEN, { size: 99 }).size, 16);
});

test('pen: next colour and size cycle through the presets', () => {
  let c = COLOR_PRESETS[0].color;
  const seen = [c];
  for (let i = 0; i < 8; i++) seen.push(c = nextColor(c));
  assert.deepEqual(seen, [...COLOR_PRESETS.map(p => p.color), COLOR_PRESETS[0].color]);
  assert.equal(nextColor('#123456'), '#000000'); // a custom colour goes to the first preset
  assert.equal(nextSize(1.5), 2.5);
  assert.equal(nextSize(2.5), 4);
  assert.equal(nextSize(4), 1.5);
  assert.equal(nextSize(3), 4);
  assert.equal(nextSize(0.5), 1.5);
  assert.equal(nextSize(16), 1.5);
});

const MAP: PageMap = { left: 100, top: 50, sx: 0.5, sy: 0.5, t0: 1000 };
const s = (x: number, y: number, p: number, t: number, pointerType = 'pen'): Sample =>
  ({ clientX: 100 + x * 2, clientY: 50 + y * 2, pressure: p, pointerType, timeStamp: 1000 + t });
const ev = (last: Sample, coalesced?: Sample[], predicted?: Sample[]): SampledEvent => ({
  ...last,
  ...(coalesced ? { getCoalescedEvents: () => coalesced } : {}),
  ...(predicted ? { getPredictedEvents: () => predicted } : {}),
});

test('sampling: every coalesced sample, in page px, rounded as stored', () => {
  const trace = newTrace();
  addSamples(trace, [s(10, 10, 0.3, 0)], MAP);
  const list = [s(10.5, 10, 0.31, 2.1), s(11.04, 10.26, 0.333, 4.2), s(11.5, 10.5, 0.35, 6.4), s(12, 11, 0.4, 8.6)];
  const e = ev(list[3], list);
  assert.equal(samplesOf(e), list);
  addSamples(trace, samplesOf(e), MAP);
  assert.deepEqual(trace.points, [
    { x: 10, y: 10, p: 0.3, t: 0 }, { x: 10.5, y: 10, p: 0.31, t: 2 }, { x: 11, y: 10.3, p: 0.33, t: 4 },
    { x: 11.5, y: 10.5, p: 0.35, t: 6 }, { x: 12, y: 11, p: 0.4, t: 9 },
  ]);
  assert.equal(trace.samples, 5);
  // No coalesced events (or an empty list): the event itself.
  const alone = ev(s(13, 11, 0.4, 11));
  assert.deepEqual(samplesOf(alone), [alone]);
  assert.deepEqual(samplesOf(ev(s(14, 11, 0.4, 13), [])).length, 1);
  // The mouse has pressure 0.5; pen pressure is clamped.
  const t2 = newTrace();
  addSamples(t2, [s(0, 0, 0, 0, 'mouse'), s(1, 0, 1.7, 1), s(2, 0, -1, 2)], MAP);
  assert.deepEqual(t2.points.map(q => q.p), [0.5, 1, 0]);
});

test('sampling: repeated and older samples (WebKit coalesced lists) and near ones are dropped', () => {
  // From the owner's iPad spike page: each coalesced list repeats earlier samples, some with
  // earlier timestamps than samples already delivered.
  const trace = newTrace();
  addSamples(trace, [s(51, 35.5, 0.08, 0)], MAP);
  addSamples(trace, [s(51, 35, 0.08, 9), s(51, 34.5, 0.08, 17), s(51, 34, 0.07, 25)], MAP);
  addSamples(trace, [s(51, 35, 0.08, 13), s(51, 34.5, 0.08, 17), s(51, 34, 0.07, 25), s(51.5, 33.5, 0.07, 38)], MAP);
  addSamples(trace, [s(51, 34, 0.07, 30), s(51.5, 33.5, 0.07, 38)], MAP);
  addSamples(trace, [s(52, 33.5, 0.1, 55)], MAP);
  addSamples(trace, [s(51.5, 33.5, 0.08, 46), s(52, 33.5, 0.1, 55), s(52.5, 33.5, 0.11, 67), s(52.6, 33.6, 0.11, 69)], MAP);
  assert.deepEqual(trace.points.map(q => [q.x, q.y, q.t]), [
    [51, 35.5, 0], [51, 35, 9], [51, 34.5, 17], [51, 34, 25], [51.5, 33.5, 38], [52, 33.5, 55], [52.5, 33.5, 67],
  ]);
  assert.equal(trace.samples, 15);
  for (let i = 1; i < trace.points.length; i++) {
    const a = trace.points[i - 1], b = trace.points[i];
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) >= MIN_STEP && b.t >= a.t);
  }
});

test('sampling: predicted points are returned, never stored', () => {
  const trace = newTrace();
  addSamples(trace, [s(10, 10, 0.3, 0)], MAP);
  const real = [s(11, 10, 0.3, 4), s(12, 10, 0.3, 8)];
  const e = ev(real[1], real, [s(13, 10, 0.3, 12), s(13.1, 10, 0.3, 14), s(14, 10, 0.3, 16), s(15, 10, 0.3, 20)]);
  addSamples(trace, samplesOf(e), MAP);
  const predicted = predictedPoints(trace, e, MAP);
  assert.deepEqual(predicted.map(q => q.x), [13, 14, 15]); // 13.1 is within MIN_STEP of 13
  assert.deepEqual(trace.points.map(q => q.x), [10, 11, 12]);
  // The next event replaces them with real points.
  const next = [s(13, 10.2, 0.3, 12), s(14, 10.4, 0.3, 16)];
  addSamples(trace, samplesOf(ev(next[1], next)), MAP);
  assert.deepEqual(trace.points.map(q => [q.x, q.y]), [[10, 10], [11, 10], [12, 10], [13, 10.2], [14, 10.4]]);
  assert.deepEqual(predictedPoints(trace, ev(next[1], next), MAP), []);
});

test('live: a long stroke freezes its head in pieces; per-frame work stays bounded', () => {
  assert.deepEqual(livePlan(0, 0), { freeze: null, frozen: 0, tail: 0 });
  assert.deepEqual(livePlan(LIVE_MAX, 0), { freeze: null, frozen: 0, tail: 0 });
  assert.deepEqual(livePlan(LIVE_MAX + 1, 0), { freeze: [0, LIVE_MAX + 1 - LIVE_KEEP], frozen: LIVE_MAX + 1 - LIVE_KEEP, tail: LIVE_MAX + 1 - LIVE_KEEP - OVERLAP });
  // Simulate a 5000-point scribble arriving 4 points per frame.
  let frozen = 0, maxTail = 0;
  const covered = new Array(5000).fill(false);
  for (let count = 1; ; count = Math.min(count + 4, 5000)) {
    const plan = livePlan(count, frozen);
    if (plan.freeze) {
      const [a, b] = plan.freeze;
      assert.ok(a === 0 || a === frozen - OVERLAP, 'each piece overlaps the one before');
      assert.ok(b - a <= LIVE_MAX + OVERLAP + 4);
      for (let i = a; i < b; i++) covered[i] = true;
    }
    frozen = plan.frozen;
    maxTail = Math.max(maxTail, count - plan.tail);
    if (count === 5000) {
      for (let i = plan.tail; i < count; i++) covered[i] = true;
      break;
    }
  }
  assert.ok(maxTail <= LIVE_MAX + OVERLAP, `tail ${maxTail}`);
  assert.ok(covered.every(Boolean), 'the pieces and the tail cover every point');
});

/** A handwriting-like wave with pressure rising from 0.05 to 0.95, sampled through addSamples. */
function sampled(n: number): Point[] {
  const trace = newTrace();
  for (let i = 0; i < n; i++) addSamples(trace, [s(100 + i * 0.73, 200 + 12 * Math.sin(i / 9), 0.05 + 0.9 * i / n, i * 2.13)], MAP);
  return trace.points;
}

test('live: the live outline of finished points is the saved stroke\'s outline without the refit (#32)', () => {
  for (const nib of ['uniform', 'pressure'] as const) {
    const points = sampled(150);
    assert.ok(points.length < LIVE_MAX);
    const plan = livePlan(points.length, 0);
    const live = strokePath({ tool: 'pen', nib, size: 2.5, points: points.slice(plan.tail) }, true);
    const stroke: PenStroke = { id: '0000abcd', tool: 'pen', nib, color: '#1e6fff', size: 2.5, points };
    const page = newPage('p-00aa11');
    page.strokes.push(stroke);
    const text = writePage(page);
    const saved = readPage(text).strokes[0];
    assert.deepEqual(saved.points, points, 'sampled points survive the file unchanged');
    assert.equal(live, strokePath(saved, true));
    assert.notEqual(live, strokePath(saved), 'the committed stroke is refitted');
    assert.ok(text.includes(`d="${strokePath(stroke)}"`), 'the file draws the committed (refitted) path');
  }
});

/** The outline's vertical extent near x, for a stroke running along x. */
function widthAt(d: string, x: number): number {
  const ys: number[] = [];
  const re = /(-?[\d.]+) (-?[\d.]+)/g;
  for (let m = re.exec(d); m; m = re.exec(d)) if (Math.abs(Number(m[1]) - x) < 1.5) ys.push(Number(m[2]));
  return Math.max(...ys) - Math.min(...ys);
}

test('outline: the uniform nib ignores pressure; the pressure nib follows it; size is the width at 0.5', () => {
  const line = (p: (i: number) => number) => Array.from({ length: 200 }, (_, i) => ({ x: 100 + i * 2, y: 300, p: p(i), t: i * 2 }));
  const varying = line(i => 0.02 + 0.96 * i / 199), flat = line(() => 0.5);
  const u = strokePath({ tool: 'pen', nib: 'uniform', size: 4, points: varying });
  assert.equal(u, strokePath({ tool: 'pen', nib: 'uniform', size: 4, points: flat }), 'uniform: identical whatever the pressure');
  assert.ok(Math.abs(widthAt(u, 150) - 4) < 0.25 && Math.abs(widthAt(u, 450) - 4) < 0.25);
  const pr = strokePath({ tool: 'pen', nib: 'pressure', size: 4, points: varying });
  const lo = widthAt(pr, 150), hi = widthAt(pr, 450);
  assert.ok(hi > lo * 1.4, `pressure: ${lo} at low pressure, ${hi} at high`);
  assert.ok(Math.abs(widthAt(strokePath({ tool: 'pen', nib: 'pressure', size: 4, points: flat }), 300) - 4) < 0.25);
  assert.equal(pressureCurve(0.5), 0.5);
  assert.ok(pressureCurve(0.08) > 0.08 * 2 && pressureCurve(1) > 0.5);
});

test('stylus touches: prevented anywhere but a touchstart on a control; fingers never', () => {
  const run = (type: string, touchType: string, onControl: boolean) => {
    let prevented = false, stopped = false;
    const target = { closest: (sel: string) => (onControl && sel.includes('.nb-ink-control') ? {} : null) };
    const e = {
      type, target, changedTouches: [{ touchType }],
      preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; },
    } as unknown as TouchEvent;
    return [blockStylusTouch(e), prevented, stopped];
  };
  assert.deepEqual(run('touchstart', 'stylus', false), [true, true, true]);
  assert.deepEqual(run('touchstart', 'stylus', true), [false, false, false]);
  assert.deepEqual(run('touchmove', 'stylus', true), [true, true, true]);
  assert.deepEqual(run('touchstart', 'direct', false), [false, false, false]);
  assert.deepEqual(run('touchmove', 'direct', false), [false, false, false]);
});

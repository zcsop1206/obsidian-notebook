/**
 * S6 unit tests (docs/study/BOARD.md): the pure parts of the fog and drill blocks.
 * Covers reveal gating (MIN_STROKES fresh strokes per reveal), grading, and replay
 * timing / stall detection. UI acceptance (peeks, click through) is an iPad check
 * listed in the S6 thread's DONE entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_STROKES, STALL_MS, analyse, canFinish as drillCanFinish, drillEvent, frameList,
  replayTime, replayWallMs, strokeSpan,
} from '../../src/study/blocks/drill';
import {
  canFinish, canReveal, canShowRest, fogEvent, freshStrokes, gradeFor, unitsFor,
  type FogGate,
} from '../../src/study/blocks/fog';
import type { InkStroke } from '../../src/study/view/host';

const st = (t0: number, pts: [number, number, number, number][], e = 0): InkStroke =>
  ({ id: String(t0), p: pts, t0, e });
const gate = (x: Partial<FogGate>): FogGate =>
  ({ reveals: 0, units: 3, done: false, grade: null, shown: false, ...x });

test('unitsFor: steps reveal one at a time, chunks split in two halves', () => {
  assert.deepEqual(unitsFor(3, 'steps'), [[0], [1], [2]]);
  assert.deepEqual(unitsFor(4, 'chunks'), [[0, 1], [2, 3]]);
  assert.deepEqual(unitsFor(5, 'chunks'), [[0, 1, 2], [3, 4]]);
  assert.deepEqual(unitsFor(1, 'chunks'), [[0]]);
  assert.deepEqual(unitsFor(0, 'steps'), []);
  assert.deepEqual(unitsFor(4, 'cold'), [[0], [1], [2], [3]]);
});

test('gradeFor: no reveals clean, all revealed failed, else shaky', () => {
  assert.equal(gradeFor(0, 3), 'clean');
  assert.equal(gradeFor(1, 3), 'shaky');
  assert.equal(gradeFor(2, 3), 'shaky');
  assert.equal(gradeFor(3, 3), 'failed');
  assert.equal(gradeFor(9, 3), 'failed');
});

test('freshStrokes counts only strokes with e = the reveal count at pen-down', () => {
  const strokes = [st(0, [[0, 0, 0, 0]]), st(1, [[0, 0, 0, 1]], 0), st(2, [[0, 0, 0, 2]], 1)];
  assert.equal(freshStrokes(strokes, 0), 2); // the two e=0 (e unset reads 0)
  assert.equal(freshStrokes(strokes, 1), 1); // written after the first reveal
  assert.equal(freshStrokes(strokes, 2), 0);
});

test('canReveal: refused before 3 fresh strokes, allowed after', () => {
  const g = gate({ reveals: 0 });
  assert.equal(canReveal(g, MIN_STROKES - 1), false);
  assert.equal(canReveal(g, MIN_STROKES), true);
  assert.equal(canReveal(gate({ reveals: 3 }), 99), false); // nothing left to reveal
  assert.equal(canReveal(gate({ done: true }), 99), false); // attempt closed
});

test('canFinish: 3 strokes or one reveal; drill canFinish needs 3 strokes', () => {
  assert.equal(canFinish(gate({}), 0), false);
  assert.equal(canFinish(gate({}), MIN_STROKES), true);
  assert.equal(canFinish(gate({ reveals: 1 }), 0), true);
  assert.equal(canFinish(gate({ done: true }), 99), false);
  assert.equal(drillCanFinish(MIN_STROKES - 1), false);
  assert.equal(drillCanFinish(MIN_STROKES), true);
});

test('canShowRest: only a shaky done attempt with units left, once', () => {
  assert.equal(canShowRest(gate({ done: true, grade: 'shaky', reveals: 1 })), true);
  assert.equal(canShowRest(gate({ done: true, grade: 'clean', reveals: 0 })), false);
  assert.equal(canShowRest(gate({ done: true, grade: 'failed', reveals: 3 })), false);
  assert.equal(canShowRest(gate({ done: true, grade: 'shaky', reveals: 1, shown: true })), false);
  assert.equal(canShowRest(gate({})), false);
});

test('fogEvent: one fog event per done attempt, clean flag from reveals', () => {
  const e = fogEvent('basic', 4, 'P1', 0, 2);
  assert.deepEqual(e, { type: 'fog', doc: 'basic', proof: 'P1', build: 4, reveals: 0, steps: 2, done: true, clean: true });
  assert.equal(fogEvent('basic', 4, 'P1', 1, 2).clean, false);
});

/* ----- drill replay timing / stall detection (point t is ms since the stroke's t0) ----- */

test('strokeSpan: relative to the attempt start, clamped at 0', () => {
  const s = st(1_000, [[0, 0, 0, 100], [1, 1, 0, 160]]);
  assert.deepEqual(strokeSpan(s, 1_000), { t0: 100, t1: 160 });
  assert.deepEqual(strokeSpan(s, 2_000), { t0: 0, t1: 0 }); // before the start: clamps
});

test('analyse: gaps over 30 s between strokes and before the end are stalls; the longest wins', () => {
  const a = analyse(
    [st(0, [[0, 0, 0, 0], [0, 0, 0, 5_000]]), st(60_000, [[0, 0, 0, 0], [0, 0, 0, 20_000]])],
    0, 120_000,
  );
  assert.equal(a.total, 120_000);
  assert.equal(a.inking, 25_000);
  assert.equal(a.strokes, 2);
  assert.equal(a.stalls.length, 2);
  assert.equal(a.stalls[0].from, 5_000);   // 55 s gap before the second stroke
  assert.equal(a.stalls[0].to, 60_000);
  assert.equal(a.stalls[0].next, 1);
  assert.equal(a.stalls[1].from, 80_000);  // trailing gap to Done at 120 s
  assert.equal(a.stalls[1].next, -1);
  assert.equal(a.longest, a.stalls[0]);    // 55 s beats 40 s
});

test('analyse: dense strokes and a short tail have no stalls', () => {
  const a = analyse([st(0, [[0, 0, 0, 0], [0, 0, 0, 1_000]]), st(1_500, [[0, 0, 0, 0]])], 0, 5_000);
  assert.equal(a.stalls.length, 0);
  assert.equal(a.longest, null);
});

test('frameList: at T the finished strokes are whole, the live one is cut at T', () => {
  const strokes = [
    st(0, [[0, 0, 0, 0], [10, 0, 0, 1_000], [20, 0, 0, 2_000]]),          // 0 → 2 s
    st(5_000, [[30, 0, 0, 0], [40, 0, 0, 1_000], [50, 0, 0, 3_000]]),    // 5 s → 8 s
  ];
  const all = frameList(strokes, 0, 10_000);
  assert.equal(all.length, 2);
  assert.equal(all[1].p.length, 3);
  const mid = frameList(strokes, 0, 7_000);
  assert.equal(mid[0].p.length, 3); // first stroke finished at t = 2 s
  assert.equal(mid[1].p.length, 2); // the 8 s point is not drawn yet
  const early = frameList(strokes, 0, 4_000);
  assert.equal(early.length, 1);    // the second stroke has not begun
});

test('replayTime / replayWallMs: speed compresses wall time, clamped to the attempt', () => {
  assert.equal(replayTime(0, 1_000, 4, 10_000), 4_000); // 1 s wall at 4x = 4 s of ink
  assert.equal(replayTime(0, 99_000, 4, 10_000), 10_000);
  assert.equal(replayTime(8_000, 1_000, 1, 10_000), 9_000);
  assert.equal(replayWallMs(10_000, 4), 2_500);
  assert.equal(replayWallMs(0, 16), 0);
});

test('drillEvent: fields and src, ms rounded', () => {
  const e = drillEvent('basic', 'd1', 'clean', 1_234.6, 'recall');
  assert.equal(e.type, 'drill');
  assert.deepEqual(e, { type: 'drill', doc: 'basic', item: 'd1', grade: 'clean', ms: 1_235, src: 'recall' });
  const d = drillEvent('basic', 'P1', 'shaky', 0, 'drill');
  if (d.type === 'drill') assert.equal(d.src, 'drill');
});

test('STALL_MS is the 30 s of the spec', () => {
  assert.equal(STALL_MS, 30_000);
});

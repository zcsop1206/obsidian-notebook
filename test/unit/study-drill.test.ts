// The pure parts of the drill and recall blocks (S6): the Done gate, the drill event, and the
// replay arithmetic (stalls over 30 s, frames, timing at 1x / 4x / 16x).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_STROKES, STALL_MS, analyse, canFinish, canGrade, drillEvent, fmtDur, frameList, replayTime, replayWallMs } from '../../src/study/blocks/drill';
import type { InkStroke } from '../../src/study/view/host';

const T0 = 1763400000000;
/** A stroke written from `at` ms after T0, lasting `dur` ms, at height y. */
function stroke(at: number, dur = 400, y = 100, e?: number): InkStroke {
  return { id: `s${at}`, t0: T0 + at, p: [[10, y, 0.5, 0], [20, y + 1, 0.5, dur / 2], [30, y + 2, 0.5, dur]], ...(e === undefined ? {} : { e }) };
}

test('drills: Done after 3 strokes; one drill event per grade', () => {
  assert.equal(MIN_STROKES, 3);
  assert.equal(canFinish(2), false);
  assert.equal(canFinish(3), true);
  assert.deepEqual(drillEvent('fx-units', 'd-order-divides', 'shaky', 61234.4, 'drill'),
    { type: 'drill', doc: 'fx-units', item: 'd-order-divides', grade: 'shaky', ms: 61234, src: 'drill' });
  assert.deepEqual(drillEvent('fx-card', 'n1', 'clean', -5, 'recall'), { type: 'drill', doc: 'fx-card', item: 'n1', grade: 'clean', ms: 0, src: 'recall' });
});

test('replay: stalls over 30 s, inking time, the longest stall', () => {
  assert.equal(STALL_MS, 30000);
  // Strokes at 1 s, 2 s, then a 40 s gap, then 45 s; Done at 120 s (a 74.6 s stall before Done).
  const ss = [stroke(1000), stroke(2000), stroke(42400, 400, 300), stroke(45000)];
  const an = analyse(ss, T0, 120000);
  assert.equal(an.strokes, 4);
  assert.equal(an.total, 120000);
  assert.equal(an.inking, 1600);
  assert.equal(an.stalls.length, 2);
  assert.deepEqual(an.stalls[0], { from: 2400, to: 42400, next: 2, x: 10, y: 300 });
  assert.deepEqual(an.stalls[1], { from: 45400, to: 120000, next: -1 });
  assert.equal(an.longest, an.stalls[1]);
  // A gap of exactly 30 s is not a stall.
  assert.equal(analyse([stroke(0), stroke(30400)], T0, 30800).stalls.length, 0);
  // Order in the list does not matter.
  assert.deepEqual(analyse([...ss].reverse(), T0, 120000).stalls, an.stalls);
});

test('replay: frames cut the stroke being written and drop later ones', () => {
  const ss = [stroke(0, 400), stroke(1000, 400)];
  assert.equal(frameList(ss, T0, -1).length, 0);
  const mid = frameList(ss, T0, 200);
  assert.equal(mid.length, 1);
  assert.equal(mid[0].p.length, 2);
  assert.equal(frameList(ss, T0, 400)[0].p.length, 3);
  assert.equal(frameList(ss, T0, 999).length, 1);
  assert.equal(frameList(ss, T0, 1000).length, 2);
  assert.equal(frameList(ss, T0, 5000).length, 2);
  // The originals are untouched.
  assert.equal(ss[0].p.length, 3);
});

test('replay timing at 1x, 4x and 16x', () => {
  assert.equal(replayTime(0, 1000, 1, 60000), 1000);
  assert.equal(replayTime(0, 1000, 4, 60000), 4000);
  assert.equal(replayTime(0, 1000, 16, 60000), 16000);
  assert.equal(replayTime(10000, 1000, 16, 20000), 20000);
  assert.equal(replayTime(0, -5, 4, 100), 0);
  assert.equal(replayWallMs(60000, 1), 60000);
  assert.equal(replayWallMs(60000, 4), 15000);
  assert.equal(replayWallMs(60000, 16), 3750);
  assert.equal(fmtDur(0), '0:00');
  assert.equal(fmtDur(61500), '1:01');
  assert.equal(fmtDur(3723000), '1:02:03');
});

test('drill grading: once, only after Done; a given-up attempt only fails', () => {
  const st = (x: Partial<{ start: number | null; end: number | null; grade: 'clean' | 'shaky' | 'failed' | null; gaveUp: boolean }>) =>
    ({ start: 1, end: 5000, grade: null, gaveUp: false, ...x });
  assert.equal(canGrade(st({ start: null, end: null }), 'clean'), false, 'idle');
  assert.equal(canGrade(st({ end: null }), 'clean'), false, 'still writing');
  for (const g of ['clean', 'shaky', 'failed'] as const) assert.equal(canGrade(st({}), g), true, g);
  assert.equal(canGrade(st({ grade: 'shaky' }), 'clean'), false, 'graded already');
  assert.equal(canGrade(st({ gaveUp: true }), 'clean'), false);
  assert.equal(canGrade(st({ gaveUp: true }), 'shaky'), false);
  assert.equal(canGrade(st({ gaveUp: true }), 'failed'), true);
  assert.equal(canGrade(st({}), 'great' as never), false, 'not a grade');
});

// The problem block's session (S7): chips only after ink, two-tap verdicts, the two tick lists,
// the call and settle events with every types.ts field, Skip ticks, and rebuilding from the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  ARM_MS, CONF, callEvent, chipsOpen, commit, confirmCalled, confirmUsed, fromEvents, giveUp, hookItem, markLogged,
  mergeSession, methodChoices, methodHit, newSession, problemItem, readyToLog, settleEvent, skipTicks, solutionOpen,
  tapVerb, ticksOpen, toggleNone, toggleTick, verbsOpen, type Session,
} from '../../src/study/blocks/problem';
import { buildIndex } from '../../src/study/format/index-build';
import type { StudyEvent } from '../../src/study/types';

const FIX = 'test/fixtures/study';
/** The fixture files, one folder deep (as the parser test reads them). */
function files(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const read = (rel: string) => out.push({ path: `study/${rel}`, text: readFileSync(`${FIX}/${rel}`, 'utf8') });
  for (const top of readdirSync(FIX)) {
    if (top.endsWith('.md')) { read(top); continue; }
    for (const f of readdirSync(`${FIX}/${top}`)) if (f.endsWith('.md')) read(`${top}/${f}`);
  }
  return out;
}
const content = buildIndex(files());
const T = 1763400000000;

/** Two taps on a verb, `gap` ms apart. */
function settle(s: Session, v: Parameters<typeof tapVerb>[1], at: number, gap = 500): Session {
  return tapVerb(tapVerb(s, v, at), v, at + gap);
}
function committed(conf: number | null = 70, how = {}): Session {
  const s = commit(newSession('inv-fx-last-digit'), conf, T, 2, how);
  assert.ok(s);
  return s;
}

test('problem: the chips unlock only after ink, and a chip commits the call once', () => {
  const s = newSession('inv-fx-last-digit');
  assert.equal(chipsOpen(s, 0), false);
  assert.equal(commit(s, 70, T, 0, {}), null, 'refused before ink');
  assert.equal(chipsOpen(s, 1), true);
  assert.deepEqual(CONF, [50, 60, 70, 80, 90]);
  assert.equal(commit(s, 75, T, 1, {}), null, 'not a chip');
  const c = commit(s, null, T, 1, { hidden: true, reach: true });
  assert.ok(c);
  assert.equal(c.phase, 'attempt');
  assert.equal(c.conf, null, '"-" commits with no confidence');
  assert.equal(c.hidden, true);
  assert.equal(c.reach, true);
  assert.equal(commit(c, 80, T + 1, 3, {}), null, 'one commit only');
  assert.equal(s.phase, 'call', 'the input session is untouched');
});

test('problem: a verdict takes two taps within the arming window', () => {
  const s = committed();
  assert.equal(verbsOpen(newSession('x')), false, 'no verdict before the call');
  const armed = tapVerb(s, 'held', T + 60000);
  assert.equal(armed.phase, 'attempt');
  assert.equal(armed.armed, 'held');
  assert.equal(armed.verdict, null);
  const late = tapVerb(armed, 'held', T + 60000 + ARM_MS + 1);
  assert.equal(late.verdict, null, 'a second tap after the window only re-arms');
  const other = tapVerb(armed, 'missed', T + 60100);
  assert.equal(other.armed, 'missed', 'tapping another verb moves the arming');
  assert.equal(other.verdict, null);
  const done = tapVerb(armed, 'held', T + 61000);
  assert.equal(done.phase, 'settled');
  assert.equal(done.verdict, 'held');
  assert.equal(done.ms, 61000, 'ms runs from the commit to the second tap');
  // The verdict can change (two taps) until the called ticks are confirmed; ms stays.
  const changed = settle(done, 'blind', T + 90000);
  assert.equal(changed.verdict, 'blind');
  assert.equal(changed.ms, 61000);
  const confirmed = confirmCalled(toggleNone(changed, 'called'), []);
  assert.equal(verbsOpen(confirmed), false);
  assert.equal(settle(confirmed, 'held', T + 99000), confirmed, 'frozen after the called ticks');
});

test('problem: ticks (called, then used from the solution), then the settle is ready', () => {
  const s = settle(committed(80), 'missed', T + 30000);
  assert.equal(ticksOpen(s), true);
  assert.equal(solutionOpen(s), false, 'the solution waits for the called ticks');
  assert.equal(toggleTick(s, 'used', 'order'), s, 'the used list waits for the called list');
  assert.equal(confirmCalled(s, ['order']), s, 'an empty called list cannot be confirmed');
  let n = toggleTick(s, 'called', 'bezout');
  n = toggleTick(n, 'called', 'order');
  n = toggleTick(n, 'called', 'bezout');
  assert.deepEqual(n.called, ['order']);
  n = confirmCalled(n, ['order', 'fx-div/cong-arith', 'order']);
  assert.equal(n.calledDone, true);
  assert.deepEqual(n.used, ['order', 'fx-div/cong-arith'], 'used starts from the solution methods, deduped');
  assert.equal(solutionOpen(n), true);
  assert.equal(toggleTick(n, 'called', 'bezout'), n, 'called is frozen');
  assert.equal(readyToLog(n), false);
  n = confirmUsed(n);
  assert.equal(readyToLog(n), true);
  assert.equal(methodHit(n), false, 'the call missed fx-div/cong-arith');
  assert.equal(methodHit({ called: ['order', 'x'], used: ['order'] }), true);
  assert.equal(methodHit({ called: [], used: [] }), null);
  const done = markLogged(n);
  assert.equal(done.phase, 'done');
  assert.equal(markLogged(s), s, 'nothing to log before the ticks');
});

test('problem: moot settles at once with empty lists; give-up needs a solution and opens the ticks', () => {
  const m = settle(committed(), 'moot', T + 5000);
  assert.equal(readyToLog(m), true);
  assert.equal(ticksOpen(m), false);
  const ev = settleEvent(m, false);
  assert.equal(ev.type, 'settle');
  assert.deepEqual(ev, { type: 'settle', item: 'inv-fx-last-digit', verdict: 'moot', help: 0, gaveUp: false, ms: 5500, called: [], used: [], hidden: false, hook: false });

  const s = committed();
  assert.equal(giveUp(s, false), s, 'no give-up without a solution (bank problems)');
  const g = giveUp(s, true);
  assert.equal(g.gaveUp, true);
  assert.equal(g.phase, 'attempt');
  assert.equal(ticksOpen(g), true, 'the called ticks open before the solution');
  assert.equal(solutionOpen(g), false);
  const gc = confirmCalled(toggleTick(g, 'called', 'order'), ['order']);
  assert.equal(solutionOpen(gc), true);
  assert.equal(tapVerb(tapVerb(gc, 'help', T + 1), 'help', T + 2), gc, '"held after help" is not offered after a give-up');
  const gs = confirmUsed(settle(gc, 'held', T + 120000));
  assert.equal(readyToLog(gs), true);
  const ge = settleEvent(gs, false);
  assert.equal(ge.type === 'settle' && ge.help, 1, 'a give-up counts as help');
  assert.equal(ge.type === 'settle' && ge.gaveUp, true);
});

test('problem: the call and settle events carry every field in types.ts', () => {
  const item = problemItem(content, 'inv-fx-last-digit');
  assert.ok(item);
  assert.equal(item.d, 2.4);
  assert.deepEqual(item.methods, ['order', 'fx-div/cong-arith']);
  const s = committed(60, { hidden: true, reach: false });
  assert.deepEqual(callEvent(item, s), { type: 'call', item: 'inv-fx-last-digit', conf: 60, hidden: true, reach: false, d: 2.4 });
  // "held after help" is a button: it logs verdict held with help 1, so events keep four verdicts.
  let h = settle(s, 'help', T + 45000.4);
  h = confirmUsed(confirmCalled(toggleTick(h, 'called', 'order'), item.methods));
  const ev = settleEvent(h, false);
  assert.deepEqual(Object.keys(ev).sort(), ['called', 'gaveUp', 'help', 'hidden', 'hook', 'item', 'ms', 'type', 'used', 'verdict']);
  assert.deepEqual(ev, { type: 'settle', item: 'inv-fx-last-digit', verdict: 'held', help: 1, gaveUp: false, ms: 45500, called: ['order'], used: ['order', 'fx-div/cong-arith'], hidden: true, hook: false });
  // "none of these" logs an empty list.
  const none = confirmUsed(toggleNone(confirmCalled(toggleNone(settle(committed(), 'blind', T + 1000), 'called'), ['order']), 'used'));
  const ne = settleEvent(none, true);
  assert.equal(ne.type === 'settle' && ne.called.length + ne.used.length, 0);
  assert.equal(ne.type === 'settle' && ne.hook, true);
});

test('problem: Skip ticks settles a session whose tick step was never saved, with empty lists', () => {
  const s = settle(committed(), 'missed', T + 20000);
  const c = committed();
  assert.equal(skipTicks(c), c, 'nothing to skip before a verdict');
  const k = skipTicks(s);
  assert.equal(readyToLog(k), true);
  const ev = settleEvent(k, false);
  assert.equal(ev.type === 'settle' && ev.verdict, 'missed');
  assert.deepEqual(ev.type === 'settle' && [ev.called, ev.used], [[], []]);
  // A called list already confirmed is kept; only the used list logs empty.
  const half = confirmCalled(toggleTick(s, 'called', 'bezout'), ['order']);
  const hk = settleEvent(skipTicks(half), false);
  assert.deepEqual(hk.type === 'settle' && [hk.called, hk.used], [['bezout'], []]);
  const m = settle(committed(), 'moot', T + 1);
  assert.equal(skipTicks(m), m, 'moot has no ticks to skip');
});

test('problem: a session rebuilt from the log; a settle on another device wins over local state', () => {
  const ev = (type: string, t: number, x: object): StudyEvent => ({ v: 1, id: `ipad-${t}`, t: new Date(t).toISOString(), dev: 'ipad', type, ...x } as StudyEvent);
  const log: StudyEvent[] = [
    ev('call', T, { item: 'inv-fx-last-digit', conf: 70, hidden: true, reach: false, d: 2.4 }),
    ev('settle', T + 9000, { item: 'inv-fx-last-digit', verdict: 'held', help: 1, gaveUp: false, ms: 9000, called: ['order'], used: [], hidden: true, hook: false }),
  ];
  assert.equal(fromEvents(log, 'other'), null);
  const callOnly = fromEvents(log.slice(0, 1), 'inv-fx-last-digit');
  assert.equal(callOnly?.phase, 'attempt');
  assert.equal(callOnly?.conf, 70);
  const r = fromEvents(log, 'inv-fx-last-digit');
  assert.ok(r);
  assert.equal(r.phase, 'done');
  assert.equal(r.verdict, 'help', 'held with help and no give-up shows as "held after help"');
  assert.equal(r.usedNone, true);
  assert.equal(fromEvents(log, 'inv-fx-last-digit', T + 10000), null, 'events before a reset do not count');
  const local = settle(committed(), 'missed', T + 1000);
  assert.equal(mergeSession(local, r, 'inv-fx-last-digit'), r, 'the log is further along');
  assert.equal(mergeSession(local, callOnly, 'inv-fx-last-digit'), local, 'local is further along');
  assert.equal(mergeSession(null, null, 'z').phase, 'call');
});

test('problem: items from the index, hooks from a basic, and the tick choices', () => {
  const bank = problemItem(content, 'putnam-2019-a1');
  assert.ok(bank);
  assert.equal(bank.bank?.source, 'Putnam 2019 A1');
  assert.equal(bank.doc, null, 'a bank problem names no doc');
  assert.equal(bank.statement, '');
  assert.equal(problemItem(content, 'no-such-problem'), null);
  const units = content.docs.get('fx-units');
  assert.ok(units);
  const hook = hookItem(units, 'unit-gcd');
  assert.ok(hook);
  assert.equal(hook.id, 'fx-units/unit-gcd');
  assert.equal(hook.hook, true);
  assert.equal(hook.d, 1.5, 'd from the proof');
  assert.equal(hook.steps.length, 2);
  assert.equal(hookItem(units, 'nope'), null);
  const ids = methodChoices(content, { methods: ['order', 'fx-div/cong-arith'] }).map(m => m.id);
  for (const m of ['order', 'bezout', 'ghost', 'fx-div/cong-arith']) assert.ok(ids.includes(m), m);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
});

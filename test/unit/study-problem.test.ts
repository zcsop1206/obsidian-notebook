// The problem block's session (S7): chips only after ink, two-tap verdicts, the two tick lists,
// the call and settle events with every types.ts field, Skip ticks, and rebuilding from the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  ARM_MS, CONF, callEvent, chipsOpen, commit, confirmCalled, confirmUsed, fromEvents, giveUp, hookItem, markLogged,
  mergeSession, methodChoices, methodHit, newSession, problemItem, readyToLog, settleEvent, skipTicks, solutionOpen,
  tapVerb, ticksOpen, toggleNone, toggleTick, verbsOpen, workPaperFit, type Session,
} from '../../src/study/blocks/problem';
import {
  copyOldProblemInk, homeDoc, migrateOldProblemInk, movedInk, problemInkKeys, problemsDoc, serialQueue, strokesToCopy, type OldInkIO,
} from '../../src/study/blocks/home';
import { parseInkFile } from '../../src/study/ink/model';
import { DocInkStore, type InkAdapter } from '../../src/study/ink/store';
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
  // A basic/anchor method is labelled without its doc id, so a hidden pick's tick list does not name its topic.
  const labels = methodChoices(content, { methods: ['fx-div/cong-arith', 'fx-div/no-such'] }).map(m => m.label);
  assert.ok(labels.every(l => !l.includes('fx-div')), labels.join(' | '));
});

test('problem: the work paper grows to fit its lowest stroke, a step below it, in whole steps, up to the cap', () => {
  const at = (...ys: number[]) => ys.map(y => ({ p: [[10, y, 0.5, 0], [20, y - 5, 0.5, 10]] }));
  assert.equal(workPaperFit(480, []), 480, 'no work: as it is');
  assert.equal(workPaperFit(480, at(60)), 800, 'any work keeps a step of paper below it');
  assert.equal(workPaperFit(480, at(400)), 800, 'a whole number of steps');
  assert.equal(workPaperFit(480, at(401)), 1200);
  assert.equal(workPaperFit(480, at(1000, 120)), 1600, 'the lowest stroke counts');
  assert.equal(workPaperFit(480, at(2600)), 2800, 'capped');
  assert.equal(workPaperFit(1600, at(100)), 1600, 'never shrinks');
  // Later changes (onlyBelow): writing on the paper never moves it; a stroke below it (a copy, a sync) does.
  assert.equal(workPaperFit(480, at(60), true), 480, 'a stroke on the paper does not grow it');
  assert.equal(workPaperFit(480, at(480), true), 480, 'nor one at its very bottom');
  assert.equal(workPaperFit(480, at(481), true), 1200, 'a stroke below it grows it with a step to spare');
});

/* ------------------------- S12: the standalone view's home doc ------------------------- */

test('s12: homeDoc is the problem\'s own doc, the bank file for a bank problem, else the synthetic doc', () => {
  assert.equal(homeDoc(content, 'inv-fx-last-digit', 'study').id, 'fx-units');
  assert.equal(homeDoc(content, 'putnam-2019-a1', 'study').id, 'fxbank', 'a bank problem\'s home stays the bank file');
  const fb = homeDoc(content, 'no-such-problem', 'study');
  assert.equal(fb.id, 'problems');
  assert.equal(fb.path, 'study/problems.md');
  assert.deepEqual(homeDoc(content, 'no-such-problem', 'study'), problemsDoc('study'));
  assert.deepEqual(problemInkKeys('inv-fx-last-digit'), ['call:inv-fx-last-digit', 'work:inv-fx-last-digit']);
});

/** The old problems-doc ink file, for the old-strokes copy. */
function inkFiles() {
  const srcText = JSON.stringify({
    v: 1, doc: 'problems', strokes: [
      { id: 's-call', p: [[10, 40, 0.5, 0], [90, 44, 0.5, 300]], t0: 1, blk: 'call:inv-fx-last-digit' },
      { id: 's-work', p: [[10, 40, 0.5, 0], [90, 44, 0.5, 300]], t0: 2, blk: 'work:inv-fx-last-digit' },
      { id: 's-other', p: [[10, 40, 0.5, 0], [90, 44, 0.5, 300]], t0: 3, blk: 'call:inv-fx-consecutive' },
      { id: 's-page', p: [[10, 40, 0.5, 0], [90, 44, 0.5, 300]], t0: 4, blk: null, at: { a: 'x', dy: 0, rev: '', v: 1 } },
    ],
  });
  return { srcText, src: parseInkFile(srcText, 'problems') };
}

/** An in-memory vault for ink files, and an app with Obsidian's per-vault local storage. */
function memVault(init: [string, string][]) {
  const files = new Map<string, string>(init);
  const adapter: InkAdapter = {
    exists: async p => files.has(p) || [...files.keys()].some(k => k.startsWith(p + '/')),
    mkdir: async () => {},
    read: async p => { const t = files.get(p); if (t === undefined) throw new Error('ENOENT ' + p); return t; },
    write: async (p, d) => { files.set(p, d); },
    list: async p => ({ files: [...files.keys()].filter(k => k.startsWith(p + '/')), folders: [] }),
  };
  const local = new Map<string, string>();
  const app = {
    loadLocalStorage: (k: string): unknown => (local.has(k) ? JSON.parse(local.get(k)!) : null),
    saveLocalStorage: (k: string, d: unknown) => { local.set(k, JSON.stringify(d)); },
  };
  return { files, adapter, app };
}

test('s12: strokesToCopy takes only this problem\'s call and work strokes, keeping ids, and skips strokes copied before', () => {
  const { src } = inkFiles();
  const keys = problemInkKeys('inv-fx-last-digit');
  const moves = strokesToCopy(src, keys, new Set<string>());
  assert.deepEqual(moves.map(s => s.id), ['s-call', 's-work'], 'the problem\'s two keys, no other problem\'s, no page ink');
  assert.deepEqual(strokesToCopy(src, keys, new Set(['s-call'])).map(s => s.id), ['s-work'], 'a stroke copied before is not picked again');
  assert.equal(strokesToCopy(src, keys, new Set(['s-call', 's-work'])).length, 0);
});

test('s12: copyOldProblemInk copies through the home doc\'s store, once per stroke, and never edits the old file', async () => {
  const { srcText } = inkFiles();
  const v = memVault([
    ['study/ink/problems.ipad.json', srcText],
    ['study/ink/fx-units.ipad.json', JSON.stringify({ v: 1, doc: 'fx-units', strokes: [{ id: 's-own', p: [[1, 2, 0.5, 0], [3, 4, 0.5, 5]], t0: 9, blk: null, at: { a: 'x', dy: 0, rev: '', v: 1 } }], hide: ['laptop:s-x'], keep: { 'laptop:s-y': 'abc' } })],
  ]);
  // The home doc's store loaded before the copy: the doc was open earlier in the session.
  const store = new DocInkStore(v.adapter, 'study', 'ipad', 'fx-units');
  await store.ready;
  const told: string[] = [];
  store.onChange(why => { told.push(why); });
  // Each open builds its record afresh from storage, as register.ts does.
  const io = (): OldInkIO => ({
    adapter: v.adapter, root: 'study', device: 'ipad', moved: movedInk(v.app, 'ipad'),
    adopt: (doc, strokes) => { assert.equal(doc, 'fx-units'); return store.adopt(strokes); },
  });
  const homeIds = () => parseInkFile(v.files.get('study/ink/fx-units.ipad.json')!, 'fx-units').strokes.map(s => s.id);

  assert.equal(await copyOldProblemInk(io(), 'fx-units', 'inv-fx-last-digit'), 2);
  assert.deepEqual(store.strokesOf('call:inv-fx-last-digit').map(s => s.id), ['s-call'], 'the loaded store shows the copy at once');
  assert.ok(told.includes('add'), 'its surfaces are told');
  const written = parseInkFile(v.files.get('study/ink/fx-units.ipad.json')!, 'fx-units');
  assert.deepEqual(written.strokes.map(s => `${s.id}:${s.blk}`), ['s-own:null', 's-call:call:inv-fx-last-digit', 's-work:work:inv-fx-last-digit'], 'written at once: own strokes kept, the copy appended, ids kept');
  assert.deepEqual(written.hide, ['laptop:s-x']);
  assert.deepEqual(written.keep, { 'laptop:s-y': 'abc' });
  assert.equal(await copyOldProblemInk(io(), 'fx-units', 'inv-fx-last-digit'), 0, 'a second run copies nothing');

  // The store's next write keeps the copy (a copy written past a loaded store was lost to it).
  store.add({ id: 's-new', p: [[5, 6, 0.5, 0], [7, 8, 0.5, 9]], t0: 10, blk: 'work:inv-fx-last-digit' });
  await store.flush();
  assert.deepEqual(homeIds(), ['s-own', 's-call', 's-work', 's-new']);

  // Erased after the copy: it stays erased on the next open.
  store.remove(['ipad:s-call']);
  await store.flush();
  assert.equal(await copyOldProblemInk(io(), 'fx-units', 'inv-fx-last-digit'), 0, 'an erased copy never comes back');
  assert.deepEqual(store.strokesOf('call:inv-fx-last-digit'), []);
  assert.deepEqual(homeIds(), ['s-own', 's-work', 's-new']);
  assert.equal(v.files.get('study/ink/problems.ipad.json'), srcText, 'the old file is never edited');

  // A stroke that reaches the old file later (filed under the fallback doc) is copied, once.
  const later = JSON.parse(srcText);
  later.strokes.push({ id: 's-late', p: [[1, 2, 0.5, 0], [4, 5, 0.5, 6]], t0: 11, blk: 'call:inv-fx-last-digit' });
  v.files.set('study/ink/problems.ipad.json', JSON.stringify(later));
  assert.equal(await copyOldProblemInk(io(), 'fx-units', 'inv-fx-last-digit'), 1);
  assert.deepEqual(store.strokesOf('call:inv-fx-last-digit').map(s => s.id), ['s-late']);
  assert.equal(await copyOldProblemInk(io(), 'fx-units', 'inv-fx-last-digit'), 0);

  // The record is this device's, in the vault's local storage.
  assert.deepEqual(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), ['s-call', 's-work', 's-late']);
  assert.equal(v.app.loadLocalStorage('notebook-study-moved-ink:laptop'), null);

  // The fallback home and a missing old file are no-ops.
  assert.equal(await copyOldProblemInk(io(), 'problems', 'inv-fx-consecutive'), 0);
  v.files.delete('study/ink/problems.ipad.json');
  assert.equal(await copyOldProblemInk(io(), 'fx-units', 'inv-fx-consecutive'), 0);
});

test('s12: DocInkStore.adopt keeps ids, skips ids the file holds, and creates the file when there is none', async () => {
  const v = memVault([]);
  const store = new DocInkStore(v.adapter, 'study', 'ipad', 'fx-div');
  const s = { id: 's-a', p: [[1, 2, 0.5, 0], [3, 4, 0.5, 5]] as [number, number, number, number][], t0: 1, blk: 'call:x', dev: 'laptop' };
  assert.deepEqual(await store.adopt([s, { ...s }]), { added: 1, saved: true }, 'a duplicate in one batch is added once');
  assert.deepEqual(await store.adopt([s]), { added: 0, saved: true });
  const f = parseInkFile(v.files.get('study/ink/fx-div.ipad.json')!, 'fx-div');
  assert.deepEqual(f.strokes.map(x => [x.id, x.blk, (x as { dev?: string }).dev]), [['s-a', 'call:x', undefined]], 'filed as this device\'s own stroke');
  assert.equal(store.strokesOf('call:x')[0].dev, 'ipad');
});

test('s12: two records built at once keep each other\'s ids; without storage a record lasts as long as the object', () => {
  const v = memVault([]);
  const a = movedInk(v.app, 'ipad');
  const b = movedInk(v.app, 'ipad');
  a.add(['s-1', 's-2']);
  b.add(['s-3']);
  assert.deepEqual(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), ['s-1', 's-2', 's-3'], 'b\'s save kept a\'s ids');
  assert.ok(b.has('s-1'), 'and b knows them now');
  a.add([]);
  assert.deepEqual(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), ['s-1', 's-2', 's-3'], 'a\'s next save keeps b\'s');
  const bare = movedInk({}, 'ipad');
  bare.add(['s-x']);
  assert.ok(bare.has('s-x'));
  assert.equal(movedInk({}, 'ipad').has('s-x'), false, 'nothing stored: a new record starts empty');
});

test('s12: a copy whose write does not land is shown but not recorded; a later copy records it once written', async () => {
  const { srcText } = inkFiles();
  const v = memVault([['study/ink/problems.ipad.json', srcText]]);
  const write = v.adapter.write;
  let failing = true;
  v.adapter.write = async (p, d) => { if (failing) throw new Error('disk full'); return write(p, d); };
  const store = new DocInkStore(v.adapter, 'study', 'ipad', 'fx-units');
  const moved = movedInk(v.app, 'ipad');
  const io: OldInkIO = { adapter: v.adapter, root: 'study', device: 'ipad', moved, adopt: (_doc, strokes) => store.adopt(strokes) };
  const errors = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await store.adopt([]), { added: 0, saved: true }, 'nothing to write is saved');
    assert.equal(await copyOldProblemInk(io, 'fx-units', 'inv-fx-last-digit'), 2);
    assert.deepEqual(store.strokesOf('call:inv-fx-last-digit').map(s => s.id), ['s-call'], 'shown at once');
    assert.equal(store.pending(), true, 'the store keeps them and retries');
    assert.ok(!moved.has('s-call') && !moved.has('s-work'), 'not recorded while unwritten');
    assert.equal(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), null);
    failing = false;
    assert.equal(await copyOldProblemInk(io, 'fx-units', 'inv-fx-last-digit'), 0, 'the store holds them already');
    assert.equal(store.pending(), false);
    assert.deepEqual(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), ['s-call', 's-work'], 'recorded once written');
    assert.deepEqual(parseInkFile(v.files.get('study/ink/fx-units.ipad.json')!, 'fx-units').strokes.map(s => s.id), ['s-call', 's-work']);
  } finally {
    console.error = errors;
  }
});

test('s12: adopt is saved once a write holding its strokes lands, even when another change comes in meanwhile', async () => {
  const v = memVault([]);
  const store = new DocInkStore(v.adapter, 'study', 'ipad', 'fx-units');
  await store.ready;
  const write = v.adapter.write;
  let during: (() => void) | null = () => {
    // A page stroke written while the copy's write is on its way to disk.
    store.add({ id: 's-page', p: [[1, 2, 0.5, 0], [3, 4, 0.5, 5]], t0: 7, blk: null, at: { a: 'x', dy: 0, rev: '', v: 1 } });
  };
  v.adapter.write = async (p, d) => { const f = during; during = null; f?.(); return write(p, d); };
  const s = { id: 's-copy', p: [[1, 2, 0.5, 0], [3, 4, 0.5, 5]] as [number, number, number, number][], t0: 1, blk: 'work:x' };
  assert.deepEqual(await store.adopt([s]), { added: 1, saved: true }, 'the copy landed, though the page stroke still waits');
  assert.equal(store.pending(), true, 'the page stroke is written by the next flush');
  await store.flush();
  assert.deepEqual(parseInkFile(v.files.get('study/ink/fx-units.ipad.json')!, 'fx-units').strokes.map(x => x.id), ['s-copy', 's-page']);
});

test('s12: the load-time pass records a problem\'s copy only once it is saved, and leaves it pending until then', async () => {
  const { srcText } = inkFiles();
  const v = memVault([['study/ink/problems.ipad.json', srcText]]);
  let saved = false;
  const io: OldInkIO = {
    adapter: v.adapter, root: 'study', device: 'ipad', moved: movedInk(v.app, 'ipad'), serial: serialQueue(),
    adopt: async (_doc, strokes) => ({ added: strokes.length, saved }),
  };
  // inv-fx-consecutive is not in the fixtures, so its stroke stays pending either way.
  assert.deepEqual(await migrateOldProblemInk(io, content, 'study'), { copied: 0, pending: 3 }, 'unsaved: nothing counts as copied');
  assert.equal(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), null, 'and nothing is recorded');
  saved = true;
  assert.deepEqual(await migrateOldProblemInk(io, content, 'study'), { copied: 2, pending: 1 });
  assert.deepEqual(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), ['s-call', 's-work']);
  assert.deepEqual(await migrateOldProblemInk(io, content, 'study'), { copied: 0, pending: 1 }, 'recorded: not offered again');
});

/** An invented doc that holds `inv-fx-late`, a problem the fixtures lack, as if it reached the vault later. */
const LATE_DOC = [
  '---', 'study: basic', 'id: fx-late', 'title: A late doc (fixture)', 'area: nt', 'needs: []', 'build: 1', '---', '',
  '> Written by a model for Adit. Not Adit\'s words.', '',
  '> [!problem] A late problem (d 1)', '> Show that $2 + 2 = 4$.', '^inv-fx-late', '',
].join('\n');

test('s12: the load-time pass copies every problem\'s old ink into its home doc once; a missing problem stays pending', async () => {
  const old = JSON.parse(inkFiles().srcText);
  old.strokes.push(
    { id: 's-bank', p: [[1, 2, 0.5, 0], [3, 4, 0.5, 5]], t0: 5, blk: 'work:putnam-2019-a1' },
    { id: 's-late', p: [[1, 2, 0.5, 0], [3, 4, 0.5, 5]], t0: 6, blk: 'call:inv-fx-late' },
  );
  const srcText = JSON.stringify(old);
  const v = memVault([['study/ink/problems.ipad.json', srcText]]);
  const stores = new Map<string, DocInkStore>();
  const storeOf = (doc: string) => {
    let s = stores.get(doc);
    if (!s) { s = new DocInkStore(v.adapter, 'study', 'ipad', doc); stores.set(doc, s); }
    return s;
  };
  const adopted: string[] = [];
  const io: OldInkIO = {
    adapter: v.adapter, root: 'study', device: 'ipad', moved: movedInk(v.app, 'ipad'), serial: serialQueue(),
    adopt: (doc, strokes) => { adopted.push(`${doc}:${strokes.map(s => s.id).join('+')}`); return storeOf(doc).adopt(strokes); },
  };
  const home = (doc: string) => {
    const t = v.files.get(`study/ink/${doc}.ipad.json`);
    return t === undefined ? null : parseInkFile(t, doc).strokes.map(s => `${s.id}:${s.blk}`);
  };

  // Not in the fixtures: inv-fx-consecutive (s-other) and inv-fx-late (s-late). Page ink is never taken.
  assert.deepEqual(await migrateOldProblemInk(io, content, 'study'), { copied: 3, pending: 2 });
  assert.deepEqual(adopted, ['fx-units:s-call+s-work', 'fxbank:s-bank'], 'one problem after another, by id; no adopt for a missing one');
  assert.deepEqual(home('fx-units'), ['s-call:call:inv-fx-last-digit', 's-work:work:inv-fx-last-digit'], 'ids kept');
  assert.deepEqual(home('fxbank'), ['s-bank:work:putnam-2019-a1'], 'a bank problem\'s home is the bank file');
  assert.deepEqual(v.app.loadLocalStorage('notebook-study-moved-ink:ipad'), ['s-call', 's-work', 's-bank']);
  assert.equal(v.files.get('study/ink/problems.ipad.json'), srcText, 'the old file is never edited');

  assert.deepEqual(await migrateOldProblemInk(io, content, 'study'), { copied: 0, pending: 2 }, 'a second pass copies nothing');
  assert.equal(adopted.length, 2);
  storeOf('fx-units').remove(['ipad:s-call']);
  await storeOf('fx-units').flush();
  assert.deepEqual(await migrateOldProblemInk(io, content, 'study'), { copied: 0, pending: 2 });
  assert.deepEqual(home('fx-units'), ['s-work:work:inv-fx-last-digit'], 'an erased copy stays erased');

  // Its doc reaches the index (read through a getter, as register.ts passes ctx.content).
  const later = buildIndex([...files(), { path: 'study/basics/fx-late.md', text: LATE_DOC }]);
  assert.deepEqual(await migrateOldProblemInk(io, () => later, 'study'), { copied: 1, pending: 1 });
  assert.deepEqual(home('fx-late'), ['s-late:call:inv-fx-late']);

  // No old file: nothing to do. An old file that cannot be read: one pending, so a later pass reads it again.
  v.files.delete('study/ink/problems.ipad.json');
  assert.deepEqual(await migrateOldProblemInk(io, later, 'study'), { copied: 0, pending: 0 });
  const errors = console.error;
  console.error = () => {};
  try {
    const broken: OldInkIO = { ...io, adapter: { exists: async () => true, read: async () => { throw new Error('EIO'); } } };
    assert.deepEqual(await migrateOldProblemInk(broken, later, 'study'), { copied: 0, pending: 1 });
  } finally {
    console.error = errors;
  }
});

test('s12: copies run one at a time through the queue, in order, and one that fails does not stop the next', async () => {
  const q = serialQueue();
  const log: string[] = [];
  const job = (name: string, ms: number, fail = false) => () => new Promise<string>((resolve, reject) => {
    log.push(`start ${name}`);
    setTimeout(() => { log.push(`end ${name}`); if (fail) reject(new Error(name)); else resolve(name); }, ms);
  });
  const a = q(job('a', 15));
  const b = q(job('b', 1, true));
  const c = q(job('c', 1));
  assert.equal(await a, 'a');
  assert.equal(await b.then(() => 'resolved', () => 'rejected'), 'rejected');
  assert.equal(await c, 'c');
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('s12: an open during the load-time pass waits its turn, and neither copies a stroke the other did', async () => {
  const v = memVault([['study/ink/problems.ipad.json', inkFiles().srcText]]);
  const store = new DocInkStore(v.adapter, 'study', 'ipad', 'fx-units');
  let active = 0;
  let overlap = false;
  const io: OldInkIO = {
    adapter: v.adapter, root: 'study', device: 'ipad', moved: movedInk(v.app, 'ipad'), serial: serialQueue(),
    adopt: async (_doc, strokes) => {
      if (++active > 1) overlap = true;
      await new Promise(r => setTimeout(r, 5));
      try { return await store.adopt(strokes); } finally { active--; }
    },
  };
  const [pass, opened] = await Promise.all([migrateOldProblemInk(io, content, 'study'), copyOldProblemInk(io, 'fx-units', 'inv-fx-last-digit')]);
  assert.equal(pass.copied + opened, 2, 'each stroke copied once between them');
  assert.equal(pass.pending, 1, 'inv-fx-consecutive is not in the fixtures');
  assert.equal(overlap, false, 'never two copies at once');
  assert.deepEqual(parseInkFile(v.files.get('study/ink/fx-units.ipad.json')!, 'fx-units').strokes.map(s => s.id), ['s-call', 's-work']);
});

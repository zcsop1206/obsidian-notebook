// The study engine (SPEC.md, Engine): the demo's engine tests (lab/study-reader/test/engine.test.mjs)
// ported to the event fold, plus tests for the SPEC decisions. Content is the invented fixture set in
// test/fixtures/study-engine/, read through the real parser and index builder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildIndex, type SourceFile } from '../../src/study/format/index-build';
import { createEngine, foldState, hookItem, rules as X, type StudyEngine } from '../../src/study/engine';
import type { ContentIndex, StudyEvent } from '../../src/study/types';

const ROOT = 'test/fixtures/study-engine';
const DAY = 86400000;
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime(); // local noon on Sunday 2026-11-15
const at = (dayOffset: number, hours = 12) => new Date(2026, 10, 15 + dayOffset, hours, 0, 0).getTime();

// Independent copies of the agreed formulas, for checking the engine's numbers.
const Ex = (d: number, r: number) => 1 / (1 + 10 ** ((d - r) / 2));
const OFF65 = -0.5376906245851601; // 2 log10(1/0.65 - 1)
const OFF60 = -0.35218251811136236; // 2 log10(1/0.60 - 1)
const OFF70 = -0.7359535705891888; // 2 log10(1/0.70 - 1)
const OFF40 = 0.3521825181113625; // 2 log10(1/0.40 - 1)
const EH75 = 0.65 / 0.75; // Decision 1 with no data: p_id 0.75
const OFFH75 = 2 * Math.log10(1 / EH75 - 1); // about -1.63

function close(got: unknown, want: number, eps = 1e-9, msg = ''): void {
  assert.ok(typeof got === 'number' && Math.abs(got - want) <= eps, `${msg} expected ${want}, got ${String(got)}`);
}

/* ------------------------------------------------------------------------------ content */

function sources(edit: Record<string, (s: string) => string> = {}): SourceFile[] {
  const out: SourceFile[] = [];
  for (const dir of readdirSync(ROOT)) {
    for (const f of readdirSync(`${ROOT}/${dir}`)) {
      if (!f.endsWith('.md')) continue;
      const rel = `${dir}/${f}`;
      const text = readFileSync(`${ROOT}/${rel}`, 'utf8');
      out.push({ path: `study/${rel}`, text: edit[rel] ? edit[rel](text) : text });
    }
  }
  return out;
}
const CONTENT = buildIndex(sources());
function contentWith(edit: Record<string, (s: string) => string>): ContentIndex {
  return buildIndex(sources(edit));
}
const bumpBuild = (n: number) => (s: string) => s.replace(/^build: \d+$/m, `build: ${n}`);

/* ------------------------------------------------------------------------------- events */

let seq = 0;
function ev(type: string, fields: Record<string, unknown>, t: number): StudyEvent {
  return { v: 1, id: `t-${String(seq++).padStart(6, '0')}`, t: X.isoLocal(new Date(t)), dev: 'test', type, ...fields } as unknown as StudyEvent;
}

/** The demo's seed, reached through events: stages, push levels and due dates before 2026-11-15. */
function seed(): StudyEvent[] {
  const drill = (doc: string, grade: string, t: number) => ev('drill', { doc, item: 'd-x', grade, ms: 60000, src: 'drill' }, t);
  return [
    ev('open', { doc: 'fe-div' }, at(-10)), drill('fe-div', 'clean', at(-8)), drill('fe-div', 'clean', at(-4)), // stage 3, push 2
    ev('open', { doc: 'fe-units' }, at(-5)), drill('fe-units', 'shaky', at(-3)), // stage 1, push 0, due 11-14
    ev('open', { doc: 'fe-crt' }, at(-6)), drill('fe-crt', 'clean', at(-4)), // stage 2, push 1, due 11-15
    ev('open', { doc: 'fe-lfsr' }, at(-10)), drill('fe-lfsr', 'clean', at(-6)), // stage 2, push 1, due 11-13
    ev('open', { doc: 'fe-crc' }, at(-9)), drill('fe-crc', 'clean', at(-7)), drill('fe-crc', 'shaky', at(-3)), drill('fe-crc', 'clean', at(-2)), // stage 3, push 1
  ];
}

interface Rig {
  eng: StudyEngine;
  log: StudyEvent[];
  now(): number;
  setNow(t: number): void;
  advanceDays(n: number): void;
  add(type: string, fields: Record<string, unknown>): StudyEvent;
  setContent(c: ContentIndex): void;
  drill(doc: string, grade: string): void;
  fog(doc: string, proof: string, reveals: number, steps: number, done?: boolean, clean?: boolean): void;
  settle(item: string, verdict: string, o?: { help?: boolean; gaveUp?: boolean; called?: string[]; used?: string[]; hidden?: boolean; hook?: boolean }): void;
  kata(kata: string, o: { pass?: boolean; runs?: number; gaveUp?: boolean; called?: string[]; used?: string[]; hidden?: boolean }): void;
  mark(doc: string, a: string, verb: string): void;
  comfortable(area: string): void;
}

function make(events: StudyEvent[] = seed(), content: ContentIndex = CONTENT): Rig {
  let t = NOW;
  let c = content;
  const log = [...events];
  const eng = createEngine(() => new Date(t));
  eng.update(c, log);
  const rig: Rig = {
    eng, log,
    now: () => t,
    setNow: v => { t = v; },
    advanceDays: n => { t += n * DAY; },
    add(type, fields) { const e = ev(type, fields, t); log.push(e); eng.update(c, log); return e; },
    setContent(x) { c = x; eng.update(c, log); },
    drill: (doc, grade) => { rig.add('drill', { doc, item: 'd-x', grade, ms: 60000, src: 'drill' }); },
    fog: (doc, proof, reveals, steps, done = true, clean) => {
      rig.add('fog', { doc, proof, build: 1, reveals, steps, done, clean: clean === undefined ? reveals === 0 : clean });
    },
    settle: (item, verdict, o = {}) => {
      rig.add('settle', {
        item, verdict, help: o.help ? 1 : 0, gaveUp: !!o.gaveUp, ms: 1000, called: o.called || [], used: o.used || [],
        hidden: !!o.hidden, hook: !!o.hook,
      });
    },
    kata: (kata, o) => {
      rig.add('kata', { kata, pass: !!o.pass, runs: o.runs ?? 1, gaveUp: !!o.gaveUp, ms: 1000, called: o.called || [], used: o.used || [], hidden: !!o.hidden });
    },
    mark: (doc, a, verb) => {
      const d = c.docs.get(doc);
      rig.add('mark', { doc, a, verb, build: d ? d.build : 1 });
    },
    // The demo's makeComfortable, as events: every basic in the area set to stage 4, then one clean drill (stage 5, push 3).
    comfortable: area => {
      for (const d of c.docs.values()) {
        if (d.kind !== 'basic' || d.areas[0] !== area) continue;
        rig.add('stage-set', { basic: d.id, stage: 4 });
        rig.drill(d.id, 'clean');
      }
    },
  };
  return rig;
}
const ids = (L: { id: string }[]) => L.map(x => x.id);
const problems = (e: StudyEngine) => e.todayPlan().picks.filter(p => p.kind === 'problem');

/* ================================================================== pure rules (demo) */

test('expected score, stretch band, Decision 1 hidden and reach targets (exact numbers)', () => {
  close(X.expected(5, 5), 0.5, 1e-15);
  close(X.expected(2.5, 3), 0.6400649998028851, 1e-12);
  close(X.dForE(3, 0.65), 3 + OFF65, 1e-12);
  close(X.dForE(3, 0.65), 2.4623093754148399, 1e-12, 'd ~= r - 0.54');
  close(X.dForE(4, 0.6), 4 + OFF60, 1e-12);
  close(X.dForE(4, 0.7), 4 + OFF70, 1e-12);
  close(X.dForE(4, 0.4), 4 + OFF40, 1e-12);
  close(X.expected(X.dForE(4, 0.65), 4), 0.65, 1e-12);
  close(X.expected(X.dForE(4, X.hiddenE(0.75)), 4), EH75, 1e-12, 'hidden: E 0.87 with no data');
  close(X.dForE(4, X.hiddenE(0.75)) - 4, -1.6252, 1e-3, 'hidden: d = r - 1.63');
  close(X.expected(X.dForE(4, 0.4), 4), 0.4, 1e-12);
});

test('rating update r <- r + 0.6 (score - E); scores for verdicts and katas', () => {
  const E = 0.6400649998028851;
  close(X.rateUpdate(3, 2.5, 1).r, 3 + 0.6 * (1 - E), 1e-12);
  close(X.rateUpdate(3, 2.5, 1).r, 3.215961000118269, 1e-12);
  close(X.rateUpdate(3, 2.5, 0.75).r, 3 + 0.6 * (0.75 - E), 1e-12);
  close(X.rateUpdate(3, 2.5, 0).r, 2.615961000118269, 1e-12);
  close(X.rateUpdate(3, 2.5, 1, X.K_HOOK).r, 3 + 0.3 * (1 - E), 1e-12, 'hooks at half weight');
  assert.equal(X.rateUpdate(3, 2.5, null).r, 3, 'moot: no change');
  assert.equal(X.scoreFor('held', false), 1);
  assert.equal(X.scoreFor('held', true), 0.75);
  assert.equal(X.scoreFor('missed', false), 0);
  assert.equal(X.scoreFor('blind', false), 0);
  assert.equal(X.scoreFor('moot', false), null);
  assert.equal(X.kataScore(true, 1, false), 1);
  assert.equal(X.kataScore(true, 3, false), 0.75);
  assert.equal(X.kataScore(false, 2, true), 0);
  assert.equal(X.kataScore(true, 1, true), 0);
  assert.equal(X.kataScore(false, 0, false), 0);
});

test('drill stages, intervals 1,2,4,7,14,30 and the deadline cap max(1, floor(days_left/3))', () => {
  assert.equal(X.nextStage(0, 'clean'), 1);
  assert.equal(X.nextStage(5, 'clean'), 5);
  assert.equal(X.nextStage(3, 'shaky'), 3);
  assert.equal(X.nextStage(4, 'failed'), 0);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(s => X.intervalFor(s, null)), [1, 2, 4, 7, 14, 30]);
  assert.equal(X.intervalFor(4, 20), 6);
  assert.equal(X.intervalFor(5, 64), 21);
  assert.equal(X.intervalFor(2, 9), 3);
  assert.equal(X.intervalFor(3, 30), 7, 'cap 10 does not bind');
  assert.equal(X.intervalFor(0, 0), 1);
  assert.equal(X.intervalFor(5, 2), 1);
});

test('drill priority = overdue * (1 + 2 exp(-days_to_deadline/14))', () => {
  close(X.priority(1, 9), 2.0515760488515595, 1e-12);
  close(X.priority(2, 64), 2 * 1.0206863463932365, 1e-12);
  close(X.priority(3, null), 3, 1e-15);
  assert.equal(X.priority(0, 5), 0);
  close(X.deadlineFactor(0), 3, 1e-15);
});

test('push levels: earned from stage and clean streaks, one failure drops a level; fog grades', () => {
  assert.equal(X.eligiblePush(1, 5, 'clean'), 0);
  assert.equal(X.eligiblePush(2, 0, 'shaky'), 0);
  assert.equal(X.eligiblePush(2, 1, 'clean'), 1);
  assert.equal(X.eligiblePush(3, 1, 'clean'), 1);
  assert.equal(X.eligiblePush(3, 2, 'clean'), 2);
  assert.equal(X.eligiblePush(4, 0, 'shaky'), 3);
  assert.equal(X.eligiblePush(5, 0, null), 3);
  assert.equal(X.nextPush(3, 'failed', 0, 0), 2);
  assert.equal(X.nextPush(0, 'failed', 0, 0), 0);
  assert.equal(X.nextPush(1, 'shaky', 4, 0), 1, 'shaky holds');
  assert.equal(X.nextPush(1, 'clean', 3, 2), 2);
  assert.equal(X.nextPush(2, 'clean', 2, 1), 2, 'a clean result never lowers');
  assert.equal(X.fogGrade(0, 3), 'clean');
  assert.equal(X.fogGrade(1, 3), 'shaky');
  assert.equal(X.fogGrade(2, 3), 'shaky');
  assert.equal(X.fogGrade(3, 3), 'failed');
  assert.equal(X.fogGrade(2, 2), 'failed');
  assert.equal(X.fogGrade(0, 3, false), 'shaky');
});

test('hidden slot pattern: exactly one in three in push areas, none otherwise', () => {
  const push = [0, 1, 2, 3, 4, 5].map(i => X.isHiddenSlot(i, true));
  assert.deepEqual(push, [false, false, true, false, false, true]);
  assert.equal(push.filter(Boolean).length / push.length, 1 / 3);
  assert.ok([0, 1, 2, 3, 4, 5].every(i => !X.isHiddenSlot(i, false)));
});

/* ========================================================= seed, clock, deadlines (demo) */

test('seed through events: stages, push levels, due dates and starting ratings', () => {
  const { eng } = make();
  assert.equal(eng.today(), '2026-11-15');
  assert.equal(eng.now().getTime(), NOW);
  const st = { 'fe-div': 3, 'fe-units': 1, 'fe-crt': 2, 'fe-lfsr': 2, 'fe-crc': 3 };
  for (const [b, s] of Object.entries(st)) assert.equal(eng.basic(b).stage, s, b);
  const pl = { 'fe-div': 2, 'fe-units': 0, 'fe-crt': 1, 'fe-lfsr': 1, 'fe-crc': 1 };
  for (const [b, s] of Object.entries(pl)) assert.equal(eng.pushLevel(b), s, b);
  // fe-units: shaky on 11-12 at stage 1, residues in 12 d: min(2, 4) = 2 -> 11-14 (one day overdue)
  const due = { 'fe-div': '2026-11-18', 'fe-units': '2026-11-14', 'fe-crt': '2026-11-15', 'fe-lfsr': '2026-11-13', 'fe-crc': '2026-11-19' };
  for (const [b, d] of Object.entries(due)) assert.equal(eng.basic(b).due, d, b);
  assert.equal(eng.rating('nt'), 3);
  for (const a of ['comb', 'an', 'la', 'dd', 'gen']) assert.equal(eng.rating(a), 4, a);
  assert.equal(eng.basic('fe-units').last, 'shaky');
  assert.equal(eng.ratingHistory('nt').length, 1);
  assert.equal(eng.inPush('nt'), false);
  assert.equal(eng.inPush('dd'), false);
});

test('Decision 7, real clock: today() follows the injected now; there is no simulated day', () => {
  const r = make();
  assert.equal(r.eng.today(), '2026-11-15');
  r.advanceDays(2);
  assert.equal(r.eng.today(), '2026-11-17');
  assert.equal(r.eng.now().getTime(), NOW + 2 * DAY);
  assert.equal((r.eng as unknown as Record<string, unknown>).advanceDays, undefined);
  const real = createEngine();
  assert.ok(Math.abs(real.now().getTime() - Date.now()) < 5000, 'the default clock is the device clock');
});

test('deadline: the nearest live track that serves the basic (docs globs, areas, frontmatter); weight 0 and finished tracks ignored', () => {
  const r = make();
  const pick = (d: { date: string; daysLeft: number; track: string } | null) => d && [d.track, d.date, d.daysLeft];
  assert.deepEqual(pick(r.eng.deadline('fe-div')), ['putnam', '2026-12-05', 20], 'paused (weight 0, 11-16) and over (11-01) are ignored');
  assert.deepEqual(pick(r.eng.deadline('fe-units')), ['residues', '2026-11-24', 9]);
  assert.deepEqual(pick(r.eng.deadline('fe-crc')), ['framing', '2026-12-01', 16]);
  assert.deepEqual(pick(r.eng.deadline('fe-lfsr')), ['asic', '2027-01-18', 64]);
  r.advanceDays(21); // 2026-12-06: putnam and residues are over
  assert.equal(r.eng.deadline('fe-div'), null);
  assert.equal(r.eng.deadline('fe-units'), null);
  // a range counts until its end, with 0 days left inside it
  const c = contentWith({ 'meta/tracks.md': s => s + '| exams | 2026-11-10 to 2026-11-20 | 1 | | fe-* |\n' });
  const e2 = make(seed(), c);
  assert.deepEqual(pick(e2.eng.deadline('fe-div')), ['exams', '2026-11-10', 0]);
  e2.advanceDays(6);
  assert.deepEqual(pick(e2.eng.deadline('fe-div')), ['putnam', '2026-12-05', 14], 'the range is over on 11-21');
});

test('Today ranks due drills by the nearest deadline, then by days overdue; two to four by minutes', () => {
  const { eng } = make();
  const plan = eng.todayPlan(60);
  assert.equal(plan.date, '2026-11-15');
  // fe-units and fe-crt: residues in 9 d; fe-lfsr: asic in 64 d (2 d overdue, but its deadline is far)
  assert.deepEqual(plan.drills.map(d => d.basic), ['fe-units', 'fe-crt', 'fe-lfsr']);
  assert.deepEqual(plan.drills.map(d => d.track), ['residues', 'residues', 'asic']);
  assert.deepEqual(plan.drills.map(d => d.overdue), [1, 0, 2], 'same deadline: the overdue one first');
  assert.deepEqual(plan.drills.map(d => d.item), ['d-order', 'd-crt', 'd-lfsr'], 'each basic\'s derive prompt');
  assert.equal(eng.todayPlan(30).drills.length, 2, 'under 45 minutes: two');
  assert.equal(eng.todayPlan(60).drills.length, 3);
  assert.equal(eng.todayPlan().drills.length, 3, 'the default is 60 minutes');
  assert.deepEqual(plan.next, { track: 'residues', date: '2026-11-24', days: 9 });
  assert.equal(plan.settledToday, 0);
});

test('Today on a Saturday doubles the minutes; a crowded day plans four drills; the drill item rotates', () => {
  const r = make([...seed(), ev('stage-set', { basic: 'fe-div', stage: 3 }, at(-1))]);
  r.setNow(at(6)); // Saturday 2026-11-21: everything is due
  assert.equal(r.eng.todayPlan(30).drills.length, 3, '60 minutes on a Saturday');
  assert.equal(r.eng.todayPlan(60).drills.length, 4);
  r.setNow(at(7));
  assert.equal(r.eng.todayPlan(60).drills.length, 3, 'Sunday: as written');
  const first = r.eng.todayPlan(120).drills.find(d => d.basic === 'fe-div')!;
  assert.equal(first.item, 'd-common');
  r.add('drill', { doc: 'fe-div', item: 'd-common', grade: 'shaky', ms: 1000, src: 'drill' });
  assert.equal(r.eng.state().drillItem('fe-div'), 'd-three', 'the prompt drilled longest ago');
  r.add('drill', { doc: 'fe-div', item: 'd-three', grade: 'shaky', ms: 1000, src: 'drill' });
  assert.equal(r.eng.state().drillItem('fe-div'), 'd-common');
  assert.equal(r.eng.state().drillItem('fe-crc'), 'd-crc');
});

test('drills: clean +1 (once a day), shaky =, failed -> 0; the interval is capped near the deadline', () => {
  const r = make();
  r.drill('fe-units', 'clean');
  let b = r.eng.basic('fe-units');
  assert.equal(b.stage, 2);
  assert.equal(b.due, '2026-11-18', 'min(4, floor(9/3)) = 3');
  assert.equal(b.push, 1, 'stage 2 with a clean result');
  r.drill('fe-units', 'clean');
  b = r.eng.basic('fe-units');
  assert.equal(b.stage, 2, 'one stage per basic per day');
  assert.deepEqual(b.history.slice(-2).map(h => [h.grade, h.from, h.to, h.src]), [['clean', 1, 2, 'drill'], ['clean', 2, 2, 'drill']]);
  r.advanceDays(1); // 2026-11-16, 8 days to residues
  r.drill('fe-units', 'shaky');
  b = r.eng.basic('fe-units');
  assert.equal(b.stage, 2);
  assert.equal(b.due, '2026-11-18', 'min(4, floor(8/3)) = 2');
  assert.equal(b.push, 1, 'shaky holds the push level');
  r.drill('fe-units', 'failed');
  b = r.eng.basic('fe-units');
  assert.equal(b.stage, 0);
  assert.equal(b.due, '2026-11-17');
  assert.equal(b.push, 0, 'one failure drops a level');
  assert.equal(b.last, 'failed');
  const n = b.history.length;
  r.drill('fe-units', 'great');
  assert.equal(r.eng.basic('fe-units').history.length, n, 'an unknown grade moves nothing');
});

test('far deadline: stage 5 interval is min(30, floor(63/3)) = 21', () => {
  const r = make();
  r.drill('fe-lfsr', 'clean');
  assert.equal(r.eng.basic('fe-lfsr').stage, 3);
  assert.equal(r.eng.basic('fe-lfsr').due, '2026-11-22', 'cap 21 does not bind: 7');
  r.add('stage-set', { basic: 'fe-lfsr', stage: 4 });
  r.advanceDays(1);
  r.drill('fe-lfsr', 'clean');
  assert.equal(r.eng.basic('fe-lfsr').stage, 5);
  assert.equal(r.eng.basic('fe-lfsr').due, '2026-12-07', '11-16 + 21');
});

test('fog: grades, stage and push before/after; failure drops one level at a time', () => {
  const r = make();
  r.fog('fe-crt', 'p-crt', 1, 3, false);
  assert.equal(r.eng.basic('fe-crt').stage, 2, 'an unfinished fog moves nothing');
  r.fog('fe-crt', 'p-crt', 0, 3);
  assert.deepEqual([r.eng.basic('fe-crt').stage, r.eng.pushLevel('fe-crt')], [3, 2]);
  r.advanceDays(1);
  r.fog('fe-crt', 'p-crt', 0, 3);
  assert.deepEqual([r.eng.basic('fe-crt').stage, r.eng.pushLevel('fe-crt')], [4, 3], 'stage 4: level 3');
  assert.equal(r.eng.inPush('nt'), true);
  r.fog('fe-crt', 'p-crt', 1, 3);
  assert.deepEqual([r.eng.basic('fe-crt').last, r.eng.basic('fe-crt').stage, r.eng.pushLevel('fe-crt')], ['shaky', 4, 3]);
  r.fog('fe-crt', 'p-crt', 3, 3);
  assert.deepEqual([r.eng.basic('fe-crt').last, r.eng.basic('fe-crt').stage, r.eng.pushLevel('fe-crt')], ['failed', 0, 2]);
  assert.equal(r.eng.inPush('nt'), false);
  for (const want of [1, 0, 0]) {
    r.fog('fe-crt', 'p-crt', 2, 2);
    assert.equal(r.eng.pushLevel('fe-crt'), want);
  }
  const skipped = r.eng.skipped();
  r.fog('fe-moves', 'p-x', 0, 3);
  assert.equal(r.eng.skipped(), skipped + 1, 'a fog on a doc that is not a basic grades nothing');
});

test('fog counts the units the block revealed (its steps field): 2 of 2 chunks failed, 2 of 4 steps shaky', () => {
  const r = make();
  r.fog('fe-crt', 'p-crt', 2, 2);
  assert.equal(r.eng.basic('fe-crt').last, 'failed');
  r.fog('fe-units', 'p-order-thm', 2, 4);
  assert.equal(r.eng.basic('fe-units').last, 'shaky');
});

test('level 2 drills move push the same way: a failure drops one level', () => {
  const r = make();
  assert.equal(r.eng.pushLevel('fe-div'), 2);
  r.drill('fe-div', 'failed');
  assert.deepEqual([r.eng.basic('fe-div').stage, r.eng.pushLevel('fe-div')], [0, 1]);
});

/* ============================================================ picks, ease-off, reach (demo) */

test('target(): stretch E 0.65 and its band, hidden per Decision 1, reach E 0.40', () => {
  const { eng } = make();
  const t = eng.target('nt');
  close(t.d, 3 + OFF65, 1e-12);
  close(t.E, 0.65, 1e-12);
  close(t.band.lo, 3 + OFF70, 1e-12);
  close(t.band.hi, 3 + OFF60, 1e-12);
  const h = eng.target('comb', { hidden: true });
  close(h.d, 4 + OFFH75, 1e-12);
  close(h.E, EH75, 1e-12);
  const rc = eng.target('nt', { reach: true });
  close(rc.d, 3 + OFF40, 1e-12);
  close(rc.E, 0.4, 1e-12);
});

test('regular slots pick the problems nearest the stretch target; unchecked problems never', () => {
  const { eng } = make();
  const ps = problems(eng);
  assert.deepEqual(ids(ps), ['inv-nt-a', 'inv-nt-b', 'inv-nt-c'], 'inv-nt-u (d 2.4) is nearer but unchecked');
  assert.ok(ps.every(p => !p.hidden && !p.reach));
  close(ps[0].E!, Ex(2.5, 3), 1e-12);
  assert.match(ps[0].why, /^Stretch: E 0\.64 at r 3\.00/);
  assert.equal(eng.pickProblem('nt')!.id, 'inv-nt-a');
  assert.equal(eng.pickProblem(null)!.id, 'inv-nt-a', 'any area: nearest its own area\'s target');
});

test('ease-off: after 2 misses in a row (missed, blind) the next pick is d - 1; a hold ends it', () => {
  const r = make();
  r.settle('inv-nt-a', 'missed', { called: [], used: ['m-crt'] });
  const r1 = 3 - 0.6 * Ex(2.5, 3);
  close(r.eng.rating('nt'), r1, 1e-12);
  assert.equal(r.eng.target('nt').eased, false, 'one miss is not enough');
  r.settle('inv-nt-b', 'blind', { called: [], used: ['m-order'] });
  const r2 = r1 - 0.6 * Ex(2.0, r1);
  close(r.eng.rating('nt'), r2, 1e-12);
  const t = r.eng.target('nt');
  assert.equal(t.eased, true);
  close(t.d, r2 + OFF65 - 1, 1e-12);
  const ps = problems(r.eng);
  assert.deepEqual(ids(ps), ['inv-nt-f', 'inv-nt-h', 'inv-nt-e'], 'nearest the eased target');
  assert.ok(ps.every(p => /^Eased one step/.test(p.why)));
  r.settle('inv-nt-f', 'held', { called: ['m-crt'], used: ['m-crt'] });
  assert.equal(r.eng.target('nt').eased, false);
  assert.deepEqual(r.eng.streaks('nt'), { miss: 0, clean: 1 });
});

test('reach: after 3 clean holds one reach problem at E 0.40; it is spent once settled', () => {
  const r = make();
  r.settle('inv-nt-a', 'held', { called: ['m-crt'], used: ['m-crt'] });
  r.settle('inv-nt-b', 'held', { called: ['m-order'], used: ['m-order'] });
  assert.equal(problems(r.eng).filter(p => p.reach).length, 0, 'two holds: no reach yet');
  r.settle('inv-nt-c', 'held', { called: ['m-bezout'], used: ['m-bezout'] });
  let rr = 3;
  for (const d of [2.5, 2.0, 3.0]) rr = rr + 0.6 * (1 - Ex(d, rr));
  close(r.eng.rating('nt'), rr, 1e-12);
  const ps = problems(r.eng);
  const reach = ps.filter(p => p.reach);
  assert.equal(reach.length, 1, 'exactly one reach');
  assert.equal(ps[0].reach, true, 'the first slot');
  assert.equal(reach[0].id, 'inv-nt-d');
  close(r.eng.target('nt', { reach: true }).d, rr + OFF40, 1e-12);
  // The hold on inv-nt-c was a clean retrieval of fe-div (stage 3 -> 4, push 3): nt is in push mode, so slot 3 is hidden.
  assert.equal(r.eng.pushLevel('fe-div'), 3);
  assert.deepEqual(ids(ps), ['inv-nt-d', 'inv-nt-e', 'inv-gen-a']);
  // the problem block logs the call with reach: true, then the settle; the settle spends the reach
  r.add('call', { item: 'inv-nt-d', conf: 70, hidden: false, reach: true, d: 3.4 });
  r.settle('inv-nt-d', 'held', { called: ['m-order'], used: ['m-order'] });
  assert.equal(r.eng.settled('inv-nt-d')!.reach, true, 'read from the call event');
  assert.deepEqual(r.eng.streaks('nt'), { miss: 0, clean: 0 }, 'the reach is spent');
  assert.equal(problems(r.eng).filter(p => p.reach).length, 0);
});

test('held after help scores 0.75 and breaks both streaks; moot changes nothing; a second settle never re-rates', () => {
  const r = make();
  r.settle('inv-nt-a', 'held', { help: true, called: ['m-crt'], used: ['m-crt'] });
  const s = r.eng.settled('inv-nt-a')!;
  assert.equal(s.score, 0.75);
  close(s.rAfter, 3 + 0.6 * (0.75 - Ex(2.5, 3)), 1e-12);
  assert.deepEqual(r.eng.streaks('nt'), { miss: 0, clean: 0 });
  r.settle('inv-nt-b', 'moot', { called: [], used: ['m-order'] });
  const m = r.eng.settled('inv-nt-b')!;
  assert.equal(m.score, null);
  assert.equal(m.rAfter, null);
  assert.equal(m.hit, null);
  assert.equal(r.eng.ratingHistory('nt').length, 2, 'moot adds no rating point');
  r.settle('inv-nt-a', 'missed');
  close(r.eng.rating('nt'), s.rAfter!, 1e-12, 'settling twice does not re-rate');
  r.settle('inv-nt-c', 'missed', { gaveUp: true });
  const g = r.eng.settled('inv-nt-c')!;
  assert.deepEqual([g.verdict, g.score, g.help], ['missed', 0, true], 'gave up: missed, after help');
});

/* ================================================================ hidden topics (demo) */

test('push mode: one in three problem slots is hidden-topic, from another practised area or gen, with no topic shown', () => {
  const r = make();
  assert.ok(problems(r.eng).every(p => !p.hidden));
  r.comfortable('nt');
  assert.equal(r.eng.inPush('nt'), true);
  const ps = problems(r.eng);
  assert.equal(ps.length, 3);
  assert.deepEqual(ps.map(p => p.hidden), [false, false, true]);
  const h = ps[2];
  assert.equal(h.id, 'inv-gen-a', 'comb, an and la have no opened basics and nothing settled: only gen is open (nt is the slot\'s own area)');
  assert.ok(!/number|combinat|probab|analysis|algebra|geometry|digital|reasoning|\bnt\b|\bgen\b/i.test(h.why));
  close(r.eng.target('gen', { hidden: true }).d, 4 + OFFH75, 1e-12);
  close(h.E!, Ex(2.4, 4), 1e-12);
  assert.deepEqual(ids(ps.slice(0, 2)), ['inv-nt-a', 'inv-nt-b']);
  assert.ok(r.eng.todayPlan().picks.filter(p => p.kind === 'kata').every(k => !k.hidden), 'dd is not in push mode');
});

test('hidden picks come from practised areas or gen only, never the slot\'s own area; the share stays 1/3', () => {
  const r = make();
  r.comfortable('nt');
  for (let i = 0; i < 3; i++) {
    const ps = problems(r.eng);
    assert.equal(ps.filter(p => p.hidden).length, 1);
    assert.equal(ps.length, 3);
    r.advanceDays(1);
  }
  const st = r.eng.state();
  assert.deepEqual(['nt', 'dd', 'gen', 'comb', 'an', 'la'].map(a => st.practised(a)), [true, true, true, false, false, false]);
  assert.equal(r.eng.pickProblem('nt', { hidden: true })!.id, 'inv-gen-a', 'inv-comb-a and inv-an-a have methods, but their areas are not practised');
  r.settle('inv-gen-a', 'held', { called: [], used: ['m-invariant'], hidden: true });
  assert.equal(r.eng.pickProblem('nt', { hidden: true }), null, 'nothing practised is left: no hidden pick rather than an unpractised area');
  r.settle('inv-comb-b', 'held');
  assert.equal(st.practised('comb'), false, 'the old fold is a snapshot');
  assert.equal(r.eng.state().practised('comb'), true, 'a counted settle makes an area practised');
  assert.equal(r.eng.pickProblem('nt', { hidden: true })!.id, 'inv-comb-a');
  r.settle('inv-comb-a', 'missed', { called: [], used: ['m-pigeonhole'], hidden: true });
  assert.equal(r.eng.pickProblem('nt', { hidden: true }), null, 'inv-an-a stays out (an unpractised); inv-nt-h is the slot\'s own area');
});

test('a problem without methods is never a hidden pick (a bank problem without a tags row)', () => {
  const r = make();
  const st = r.eng.state();
  assert.equal(st.hiddenOK(CONTENT.problems.get('inv-comb-b')!), false);
  assert.equal(st.hiddenOK(CONTENT.problems.get('inv-comb-a')!), true);
});

test('katas: simple outside push; in push a harder kata comes first only within reach (E >= 0.40); hidden slots take hidden katas', () => {
  const r = make();
  let k = r.eng.todayPlan().picks.filter(p => p.kind === 'kata');
  assert.deepEqual(ids(k), ['k-crc'], 'one kata slot while asic is live: nearest the stretch target');
  assert.equal(r.eng.pickKata()!.id, 'k-crc');
  r.comfortable('dd');
  assert.equal(r.eng.inPush('dd'), true);
  close(Ex(5, 4), 0.24025307335204213, 1e-9, 'k-uart at r 4');
  assert.equal(r.eng.pickKata()!.id, 'k-crc', 'k-uart (E 0.24) is out of reach: nearest the stretch target instead');
  const hk = r.eng.pickKata({ hidden: true })!;
  assert.equal(hk.id, 'k-badframe');
  assert.equal(hk.hidden, true);
  assert.ok(!/crc|checksum|polynomial|digital|frame/i.test(hk.why));
  // The single kata slot is hidden one day in three in push mode.
  const hiddenDays: boolean[] = [];
  for (let i = 0; i < 6; i++) {
    hiddenDays.push(r.eng.todayPlan().picks.filter(p => p.kind === 'kata').some(p => p.hidden));
    r.advanceDays(1);
  }
  assert.equal(hiddenDays.filter(Boolean).length, 2, hiddenDays.join(' '));
  // Pass the simple katas and the hidden one: r 4.71, and k-uart (d 5) is within reach.
  r.kata('k-shift', { pass: true });
  r.kata('k-lfsr', { pass: true });
  r.kata('k-crc', { pass: true });
  r.kata('k-badframe', { pass: true });
  assert.ok(Ex(5, r.eng.rating('dd')) >= 0.4, String(r.eng.rating('dd')));
  const uart = r.eng.pickKata()!;
  assert.equal(uart.id, 'k-uart', 'within reach: the harder kata comes first');
  assert.equal(uart.reach, false);
  assert.match(uart.why, /^Push mode: a harder/);
});

test('ease-off never makes a pick harder: eased picks keep to d <= the plain target while any remain', () => {
  const r = make();
  for (const id of ['inv-nt-b', 'inv-nt-e', 'inv-nt-f', 'inv-nt-h']) r.settle(id, 'moot'); // the bank keeps only d >= 2.5
  r.settle('inv-nt-a', 'missed');
  r.settle('inv-nt-c', 'missed');
  assert.equal(r.eng.target('nt').eased, true);
  const ps = problems(r.eng);
  assert.deepEqual(ids(ps), ['inv-nt-d'], 'only d 3.4 is left');
  assert.match(ps[0].why, /nothing easier is left in the bank/);
  const e2 = make();
  e2.settle('inv-nt-c', 'missed');
  e2.settle('inv-nt-d', 'missed');
  const t = e2.eng.target('nt');
  const p2 = problems(e2.eng);
  assert.deepEqual(ids(p2), ['inv-nt-f', 'inv-nt-h', 'inv-nt-e'], 'inv-nt-b (d 2.0) is above the plain target ' + t.base.toFixed(3));
  assert.ok(p2.every(p => /^Eased one step/.test(p.why) && p.d! <= t.base + 1e-9));
});

/* ============================================================ methods and settles (demo) */

test('method identification: hits and misses per settle; method accuracy counts hidden settles only (Decision 1)', () => {
  const r = make();
  r.settle('inv-nt-c', 'held', { called: ['m-bezout'], used: ['m-bezout'] });
  let s = r.eng.settled('inv-nt-c')!;
  assert.equal(s.hit, true);
  close(s.E!, 0.5, 1e-12);
  close(s.rAfter!, 3.3, 1e-12);
  r.settle('inv-nt-a', 'missed', { called: ['m-order'], used: ['m-crt'] });
  s = r.eng.settled('inv-nt-a')!;
  assert.equal(s.hit, false);
  r.settle('inv-nt-e', 'held', { called: [] });
  s = r.eng.settled('inv-nt-e')!;
  assert.deepEqual(s.took, ['m-bezout'], 'no ticks for methods used: the solution\'s methods line');
  assert.equal(s.hit, false, 'held, but the call did not name the method');
  assert.deepEqual(r.eng.methodAccuracy('nt'), { p: 0.75, n: 0 }, 'none of these was hidden');
  r.settle('inv-nt-f', 'moot', { called: [], used: ['m-crt'], hidden: true });
  assert.equal(r.eng.methodAccuracy().n, 0, 'moot is not counted');
});

test('two-step ticks: a later settle event re-ticks the methods without re-rating', () => {
  const r = make();
  r.settle('inv-nt-e', 'held', { called: [], hidden: true });
  const s = r.eng.settled('inv-nt-e')!;
  assert.equal(s.hit, false);
  assert.deepEqual(r.eng.methodAccuracy(), { p: 3 / 5, n: 1 });
  r.settle('inv-nt-e', 'held', { called: ['m-bezout'], used: ['m-bezout'], hidden: true });
  assert.equal(r.eng.settled('inv-nt-e')!.hit, true, 'corrected ticks replace the entry');
  assert.deepEqual(r.eng.methodAccuracy(), { p: 4 / 5, n: 1 });
  close(r.eng.rating('nt'), s.rAfter!, 1e-12, 'no second rating update');
  r.kata('k-crc', { pass: true, runs: 1 });
  assert.equal(r.eng.settled('k-crc')!.hit, null, 'no ticks yet: not counted');
  r.kata('k-crc', { pass: true, runs: 1, called: ['d-crc'], used: ['d-crc'] });
  assert.equal(r.eng.settled('k-crc')!.hit, true);
});

test('method accuracy per area: a general method with no basic is counted', () => {
  const r = make();
  r.settle('inv-la-x', 'missed', { called: [], used: ['m-invariant'], hidden: true });
  r.settle('inv-la-y', 'missed', { called: [], hidden: true });
  assert.deepEqual(r.eng.settled('inv-la-y')!.took, ['m-invariant', 'fe-div/bezout']);
  assert.deepEqual(r.eng.methodAccuracy('la'), { p: 3 / 6, n: 2 });
  assert.deepEqual(r.eng.methodAccuracy(), { p: 3 / 6, n: 2 });
  assert.deepEqual(r.eng.methodAccuracy('nt'), { p: 0.75, n: 0 });
});

test('katas: first-run pass 1, pass after failures 0.75, gave up 0; settled katas leave the plan', () => {
  const r = make();
  r.kata('k-crc', { pass: true, runs: 1, called: ['d-crc'], used: ['d-crc'] });
  let s = r.eng.settled('k-crc')!;
  assert.equal(s.score, 1);
  close(s.E!, 0.6400649998028851, 1e-12);
  close(s.rAfter!, 4.215961000118269, 1e-12);
  assert.equal(s.hit, true);
  const r1 = s.rAfter!;
  r.kata('k-badframe', { pass: true, runs: 2, called: ['d-fsm'], used: ['d-crc'] });
  s = r.eng.settled('k-badframe')!;
  assert.equal(s.score, 0.75);
  close(s.rAfter!, r1 + 0.6 * (0.75 - Ex(4.5, r1)), 1e-12);
  assert.equal(s.hidden, true, 'a hidden-level kata is hidden');
  r.kata('k-shift', { pass: false, gaveUp: true, runs: 2 });
  s = r.eng.settled('k-shift')!;
  assert.equal(s.score, 0);
  assert.equal(s.verdict, 'gave up');
  assert.deepEqual(r.eng.streaks('dd'), { miss: 1, clean: 0 });
  assert.ok(!ids(r.eng.todayPlan().picks).includes('k-crc'), 'settled katas leave the plan');
  const before = r.eng.rating('dd');
  r.kata('k-crc', { pass: false });
  assert.equal(r.eng.rating('dd'), before, 'a second kata event does not re-rate');
});

/* ======================================================================= triage (demo) */

test('passage basics: links (and anchored items), kata needs; problem and solution passages leak nothing', () => {
  const { eng } = make();
  assert.deepEqual(eng.passageBasics('fe-moves', 'p-crt'), ['fe-crt', 'fe-div']);
  assert.deepEqual(eng.passageBasics('fe-moves', 'cue-order'), ['fe-units']);
  const list = CONTENT.anchors.get('fe-moves')!.get('cue-order')!;
  assert.deepEqual(eng.passageBasics('fe-moves', list.anchor), ['fe-units', 'fe-crt'], 'the whole list: every item');
  assert.deepEqual(eng.passageBasics('fe-moves', 'h-first-moves'), ['fe-div', 'fe-units', 'fe-crt'], 'a heading links nothing: the doc\'s needs');
  assert.deepEqual(eng.state().linkedBasics('fe-moves', 'inv-nt-a'), [], 'a problem passage never names its method');
  assert.deepEqual(eng.passageBasics('fe-crt', 'crt'), ['fe-div', 'fe-units'], 'its own proof is not a link');
  assert.deepEqual(eng.passageBasics('fe-framing', 'f-kata'), ['fe-lfsr'], 'a visible kata: its needs');
  assert.deepEqual(eng.passageBasics('fe-framing', 'f-hidden'), ['fe-crc', 'fe-lfsr'], 'a hidden kata is not used; falls back to needs');
});

test('a lost mark on a passage that links no basic is rationed, never rebuilt through the doc\'s needs', () => {
  const r = make();
  assert.equal(r.eng.weak('fe-units'), true, 'fe-units is weak (stage 1), and fe-moves needs it');
  assert.deepEqual(r.eng.state().linkedBasics('fe-moves', 'p-plain'), []);
  const t = r.eng.triage('fe-moves', 'p-plain', 'lost');
  assert.equal(t.action, 'scaffold');
  assert.deepEqual(t.action === 'scaffold' && t.basics, ['fe-div', 'fe-units', 'fe-crt']);
  r.drill('fe-crc', 'failed');
  assert.equal(r.eng.triage('fe-framing', 'f-hidden', 'lost').action, 'scaffold');
  const f = r.eng.triage('fe-framing', 'f-crc', 'lost');
  assert.deepEqual(f, { action: 'rebuild-basic', basics: ['fe-crc'] }, 'a passage that links the weak basic rebuilds it');
});

test('a second triage in the same cycle keeps its start; easy ends the cycle', () => {
  const r = make();
  const first = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.equal(first.action, 'scaffold');
  assert.equal(first.action === 'scaffold' && Date.parse(first.since), NOW);
  r.mark('fe-moves', 'p-crt', 'lost');
  r.advanceDays(0.5);
  const again = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.equal(again.action === 'scaffold' && Date.parse(again.since), NOW, 'still the first mark\'s cycle');
  assert.equal(again.action === 'scaffold' && Date.parse(again.eligibleAt!), NOW + DAY);
  r.mark('fe-moves', 'p-crt', 'easy');
  r.advanceDays(0.5);
  const fresh = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.equal(fresh.action === 'scaffold' && Date.parse(fresh.since), NOW + DAY, 'a lost mark after easy starts a new cycle');
  assert.equal(fresh.action === 'scaffold' && Date.parse(fresh.eligibleAt!), NOW + 2 * DAY);
});

test('Decision 6: scaffold, then eligible only after 24 h with ink in the attempt box; a request waits for the laptop', () => {
  const r = make();
  let t = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.equal(t.action, 'scaffold');
  assert.deepEqual(t.action === 'scaffold' && t.basics, ['fe-crt', 'fe-div']);
  r.mark('fe-moves', 'p-crt', 'lost');
  r.add('attempt', { doc: 'fe-moves', a: 'p-crt', strokes: 5 });
  t = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.equal(t.action, 'scaffold', 'ink, but not a day yet');
  assert.equal(t.action === 'scaffold' && Date.parse(t.eligibleAt!), NOW + DAY, 'the clock does not restart');
  r.advanceDays(1);
  r.add('attempt', { doc: 'fe-moves', a: 'p-crt', strokes: 0 });
  t = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.equal(t.action, 'scaffold', 'a day, but the box was cleared');
  r.add('attempt', { doc: 'fe-moves', a: 'p-crt', strokes: 4 });
  t = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.deepEqual(t, { action: 'eligible', left: 3 });
  const req = r.add('rewrite-request', { doc: 'fe-moves', a: 'p-crt', build: 1, rev: CONTENT.anchors.get('fe-moves')!.get('p-crt')!.hash });
  assert.deepEqual(r.eng.budget('fe-moves'), { left: 2, used: 1 });
  assert.deepEqual(r.eng.triage('fe-moves', 'p-crt', 'lost'), { action: 'requested', at: req.t });
  assert.deepEqual(r.eng.pendingRequests(), [{ doc: 'fe-moves', a: 'p-crt', kind: 'rewrite', t: req.t, build: 1 }]);
});

test('eligibility boundary: 23 h 59 min is not enough, exactly 24 h is', () => {
  const r = make();
  r.mark('fe-moves', 'p-div', 'lost');
  r.add('attempt', { doc: 'fe-moves', a: 'p-div', strokes: 3 });
  r.setNow(NOW + DAY - 60000);
  assert.equal(r.eng.triage('fe-moves', 'p-div', 'lost').action, 'scaffold');
  r.setNow(NOW + DAY);
  assert.equal(r.eng.triage('fe-moves', 'p-div', 'lost').action, 'eligible');
});

test('budget: 3 rewrites per doc, then no rewrite and a drill on the weakest linked basic, pulled forward to today', () => {
  const r = make();
  const anchors = ['p-crt', 'p-div', 'p-mix', 'p-last'];
  for (const a of anchors) { assert.equal(r.eng.triage('fe-moves', a, 'lost').action, 'scaffold'); r.mark('fe-moves', a, 'lost'); }
  r.advanceDays(1);
  for (const a of anchors) r.add('attempt', { doc: 'fe-moves', a, strokes: 2 });
  for (const a of anchors) assert.equal(r.eng.triage('fe-moves', a, 'lost').action, 'eligible', a);
  for (const a of anchors.slice(0, 3)) {
    assert.deepEqual(r.eng.triage('fe-moves', a, 'lost'), { action: 'eligible', left: 3 - anchors.indexOf(a) }, a);
    r.mark('fe-moves', a, 'lost');
    r.add('rewrite-request', { doc: 'fe-moves', a, build: 1 });
  }
  assert.deepEqual(r.eng.budget('fe-moves'), { left: 0, used: 3 });
  assert.equal(r.eng.basic('fe-div').due, '2026-11-18');
  const t = r.eng.triage('fe-moves', 'p-last', 'lost');
  assert.deepEqual(t, { action: 'budget-exhausted', drill: 'fe-div' });
  r.mark('fe-moves', 'p-last', 'lost');
  assert.equal(r.eng.basic('fe-div').due, '2026-11-16', 'the drill is pulled forward to today');
  assert.deepEqual(r.eng.budget('fe-units'), { left: 3, used: 0 }, 'budgets are per doc');
});

test('easy and forgot are noted; forgot pulls the drills the passage rests on forward; clear removes the mark', () => {
  const r = make();
  assert.deepEqual(r.eng.triage('fe-moves', 'p-crt', 'easy'), { action: 'noted' });
  r.mark('fe-moves', 'p-crt', 'easy');
  assert.equal(r.eng.marks('fe-moves')[0].verb, 'easy');
  assert.deepEqual(r.eng.triage('fe-moves', 'p-div', 'forgot'), { action: 'noted' });
  r.advanceDays(1);
  r.mark('fe-moves', 'p-div', 'forgot');
  assert.equal(r.eng.basic('fe-div').due, '2026-11-16', 'fe-div was due 11-18');
  assert.deepEqual(r.eng.marks().map(m => [m.a, m.verb]), [['p-div', 'forgot'], ['p-crt', 'easy']], 'newest first');
  r.mark('fe-moves', 'p-div', 'clear');
  assert.deepEqual(r.eng.marks().map(m => m.a), ['p-crt']);
  assert.deepEqual(r.eng.triage('nope', 'x', 'lost'), { action: 'noted' }, 'an unknown doc');
});

/* ======================================================== rebuilds of basics (demo + Decision 6) */

test('lost on a basic: rebuild-basic, budget-free; while it waits, requested; after it lands, rationed until a new retrieval', () => {
  const r = make();
  assert.deepEqual(r.eng.triage('fe-units', 'u-p2', 'lost'), { action: 'rebuild-basic', basics: ['fe-units'] });
  r.mark('fe-units', 'u-p2', 'lost');
  const req = r.add('rebuild-request', { doc: 'fe-units', build: 1, a: 'u-p2' });
  assert.deepEqual(r.eng.budget('fe-units'), { left: 3, used: 0 }, 'no rewrite budget spent');
  assert.deepEqual(r.eng.triage('fe-units', 'u-p1', 'lost'), { action: 'requested', at: req.t }, 'the rebuild has not landed');
  assert.deepEqual(r.eng.pendingRequests().map(p => [p.kind, p.doc]), [['rebuild', 'fe-units']]);
  r.setContent(contentWith({ 'basics/fe-units.md': bumpBuild(2) }));
  assert.deepEqual(r.eng.pendingRequests(), [], 'build 2 answers it');
  assert.deepEqual(r.eng.marks('fe-units'), [], 'the rebuild answered the lost mark');
  const t = r.eng.triage('fe-units', 'u-p1', 'lost');
  assert.equal(t.action, 'scaffold', 'already rebuilt: rationed like any passage');
  assert.deepEqual(t.action === 'scaffold' && t.basics, ['fe-div']);
  r.advanceDays(1);
  r.drill('fe-units', 'failed');
  assert.deepEqual(r.eng.triage('fe-units', 'u-p1', 'lost'), { action: 'rebuild-basic', basics: ['fe-units'] }, 'failed again after the rebuild: another');
});

test('lost on a topic passage resting on a weak basic rebuilds that basic, not the passage', () => {
  const r = make();
  assert.deepEqual(r.eng.triage('fe-moves', 'p-units', 'lost'), { action: 'rebuild-basic', basics: ['fe-units'] });
  r.mark('fe-moves', 'p-units', 'lost');
  const req = r.add('rebuild-request', { doc: 'fe-units', build: 1, a: 'fe-moves#p-units' });
  assert.equal(r.eng.budget('fe-moves').used, 0);
  assert.deepEqual(r.eng.triage('fe-moves', 'p-units', 'lost'), { action: 'requested', at: req.t });
  r.setContent(contentWith({ 'basics/fe-units.md': bumpBuild(2) }));
  const again = r.eng.triage('fe-moves', 'p-units', 'lost');
  assert.equal(again.action, 'scaffold', 'rebuilt: the passage is rationed now');
  assert.equal(again.action === 'scaffold' && Date.parse(again.since), NOW, 'a new cycle: the rebuild mark does not count');
});

test('a basic whose last drill failed counts as weak, at any stage', () => {
  const r = make();
  r.drill('fe-crc', 'failed');
  r.add('stage-set', { basic: 'fe-crc', stage: 3 });
  assert.equal(r.eng.basic('fe-crc').stage, 3);
  assert.equal(r.eng.weak('fe-crc'), true);
  assert.deepEqual(r.eng.triage('fe-framing', 'f-crc', 'lost'), { action: 'rebuild-basic', basics: ['fe-crc'] });
  assert.equal(r.eng.weak('fe-div'), false);
  const fresh = make([]);
  assert.equal(fresh.eng.weak('fe-units'), false, 'a basic never opened is not weak: read it first');
  assert.equal(fresh.eng.triage('fe-moves', 'p-units', 'lost').action, 'scaffold');
});

/* =================================================================== blockers (demo) */

test('blockers: each live track with the basics below stage 3 or weak; sorted by deadline', () => {
  const r = make();
  assert.deepEqual(r.eng.blockers(), [
    { track: 'residues', date: '2026-11-24', basics: ['fe-units', 'fe-crt'] },
    { track: 'framing', date: '2026-12-01', basics: [] },
    { track: 'putnam', date: '2026-12-05', basics: ['fe-units', 'fe-crt'] },
    { track: 'asic', date: '2027-01-18', basics: ['fe-lfsr'] },
  ]);
  r.comfortable('nt');
  assert.deepEqual(r.eng.blockers()[0], { track: 'residues', date: '2026-11-24', basics: [] });
  const fresh = make([]);
  assert.deepEqual(fresh.eng.blockers().find(b => b.track === 'putnam')!.basics, ['fe-crt', 'fe-div', 'fe-units'], 'never opened: stage 0 blocks');
});

/* ========================================================= determinism, history, purity (demo) */

test('the fold is the state: two devices\' logs, shuffled and duplicated, give the same engine', () => {
  const r = make();
  r.drill('fe-units', 'clean');
  r.settle('inv-nt-a', 'held', { called: ['m-crt'], used: ['m-crt'] });
  r.mark('fe-moves', 'p-crt', 'lost');
  const shuffled = [...r.log].reverse();
  const dup = [...shuffled, ...shuffled.slice(0, 5)];
  const other = foldState(CONTENT, dup, new Date(NOW));
  for (const id of ['fe-div', 'fe-units', 'fe-crt', 'fe-lfsr', 'fe-crc']) assert.deepEqual(other.basic(id), r.eng.basic(id), id);
  assert.equal(other.rating('nt'), r.eng.rating('nt'));
  assert.deepEqual(other.marks(), r.eng.marks());
  assert.deepEqual(other.todayPlan(), r.eng.todayPlan());
  assert.deepEqual(other.triage('fe-moves', 'p-crt', 'lost'), r.eng.triage('fe-moves', 'p-crt', 'lost'));
});

test('history and records are copies: callers cannot change the engine', () => {
  const r = make();
  const h0 = r.eng.basic('fe-units').history;
  assert.ok(h0.length >= 1 && h0.every(x => x.src === 'drill'));
  h0.push({ t: '', grade: 'clean', from: 0, to: 0, src: 'bogus' });
  assert.equal(r.eng.basic('fe-units').history.length, h0.length - 1);
  r.settle('inv-nt-a', 'missed', { called: [] });
  const s = r.eng.settled('inv-nt-a')!;
  s.called.push('x');
  assert.deepEqual(r.eng.settled('inv-nt-a')!.called, []);
});

test('the engine imports only the shared types and its own modules, and uses no eval, Function or network', () => {
  for (const f of ['index.ts', 'rules.ts', 'state.ts']) {
    const src = readFileSync(`src/study/engine/${f}`, 'utf8');
    const imports: string[] = [];
    const re = /from '([^']+)'/g;
    for (let m = re.exec(src); m; m = re.exec(src)) imports.push(m[1]);
    for (const i of imports) assert.ok(i === '../types' || i.startsWith('./'), `${f} imports ${i}`);
    assert.ok(!/\beval\s*\(|new\s+Function|\bfetch\s*\(|XMLHttpRequest|\bdocument\.|\bwindow\./.test(src), f);
  }
});

/* ======================================================================= SPEC decisions */

test('Decision 1: hidden d aims p_id x E at 0.65; p_id = (hits + 3) / (n + 4) over the last 20, clamped to E 0.65..0.88', () => {
  assert.equal(X.pIdSmoothed(0, 0), 0.75);
  close(X.hiddenE(0.75), 0.65 / 0.75, 1e-12);
  assert.equal(X.hiddenE(1), 0.65, 'naming every method: the plain stretch band');
  assert.equal(X.hiddenE(0.5), 0.88, 'clamped');
  assert.equal(X.hiddenE(0.2), 0.88);
  const r = make();
  close(r.eng.target('gen', { hidden: true }).d, 4 - 1.6252, 1e-3, 'no data: d = r - 1.63');
  // two hidden misses: p_id = 3/6 = 0.5 -> E 1.3 clamps to 0.88
  r.settle('inv-la-x', 'missed', { called: [], hidden: true });
  r.settle('inv-la-y', 'missed', { called: [], hidden: true });
  assert.deepEqual(r.eng.methodAccuracy(), { p: 0.5, n: 2 });
  close(r.eng.target('gen', { hidden: true }).E, 0.88, 1e-12);
  close(r.eng.target('gen', { hidden: true }).d, 4 + 2 * Math.log10(1 / 0.88 - 1), 1e-12);
  // the plain target does not change with p_id
  close(r.eng.target('gen').d, 4 + OFF65, 1e-12);
  // many hits: p_id rises toward 1 and the hidden target toward the plain band
  const hits: StudyEvent[] = [];
  for (let i = 0; i < 25; i++) {
    hits.push(ev('settle', { item: `bank-${i}`, verdict: 'held', help: 0, gaveUp: false, ms: 1, called: ['m'], used: ['m'], hidden: true, hook: false }, at(-1)));
  }
  const e2 = foldState(CONTENT, [...seed(), ...hits], new Date(NOW));
  assert.deepEqual(e2.methodAccuracy(), { p: 23 / 24, n: 20 }, 'only the last 20 count');
  close(e2.target('gen', { hidden: true }).E, 0.65 / (23 / 24), 1e-12);
});

test('Decision 2: a theorem hook grades its basic and moves the area rating at K 0.3 with the proof\'s (d x); no (d x), no rating', () => {
  const r = make();
  const item = hookItem('fe-div', 'bezout');
  assert.equal(item, 'thm:fe-div#bezout');
  const s0 = r.eng.basic('fe-div').stage;
  r.settle(item, 'held', { hook: true, called: ['m-bezout'], used: ['m-bezout'] });
  assert.equal(r.eng.basic('fe-div').stage, s0 + 1);
  assert.equal(r.eng.basic('fe-div').history.slice(-1)[0].src, 'hook');
  close(r.eng.rating('nt'), 3 + 0.3 * (1 - Ex(2, 3)), 1e-12, 'p-bezout is (d 2)');
  assert.deepEqual(r.eng.streaks('nt'), { miss: 0, clean: 0 }, 'the stretch streaks do not move');
  assert.ok(!problems(r.eng).some(p => /^thm:/.test(p.id)), 'never in Today\'s slots');
  const rr = r.eng.rating('nt');
  assert.equal(r.eng.nextHookItem('fe-units', 'order-thm'), 'thm:fe-units#order-thm');
  r.settle(hookItem('fe-units', 'order-thm'), 'held', { hook: true });
  assert.equal(r.eng.nextHookItem('fe-units', 'order-thm'), 'thm:fe-units#order-thm#2', 'the next attempt');
  assert.equal(r.eng.rating('nt'), rr, 'p-order-thm has no (d x): no rating');
  assert.equal(r.eng.basic('fe-units').last, 'clean');
  // a hook at push level 3 that misses fails the basic and drops one level; the proof anchor works too
  r.comfortable('nt');
  assert.equal(r.eng.pushLevel('fe-crt'), 3);
  r.settle('thm:fe-crt#p-crt', 'blind', { hook: true });
  assert.deepEqual([r.eng.basic('fe-crt').last, r.eng.basic('fe-crt').stage, r.eng.pushLevel('fe-crt')], ['failed', 0, 2]);
  close(r.eng.hooks().slice(-1)[0].rAfter!, r.eng.rating('nt'), 1e-12);
  const n0 = r.eng.basic('fe-units').history.length;
  r.settle(hookItem('fe-units', 'order-thm'), 'missed', { hook: true, called: ['m-order'], used: ['m-order'] });
  assert.equal(r.eng.basic('fe-units').history.length, n0, 'a second settle of one attempt only re-ticks');
  r.settle(r.eng.nextHookItem('fe-units', 'order-thm'), 'held', { hook: true, help: true });
  assert.equal(r.eng.basic('fe-units').last, 'shaky', 'attempt 2 is graded');
  const n = r.eng.basic('fe-units').history.length;
  r.settle(r.eng.nextHookItem('fe-units', 'order-thm'), 'moot', { hook: true });
  assert.equal(r.eng.basic('fe-units').history.length, n, 'moot grades nothing');
  assert.equal(r.eng.hooks().length, 5);
  const sk = r.eng.skipped();
  r.settle('thm:nope#x', 'held', { hook: true });
  assert.equal(r.eng.skipped(), sk + 1);
});

test('Decision 5: a rewrite request is answered by a higher build whose anchor text changed', () => {
  const r = make();
  const rev = CONTENT.anchors.get('fe-moves')!.get('p-crt')!.hash;
  r.mark('fe-moves', 'p-crt', 'lost');
  r.add('rewrite-request', { doc: 'fe-moves', a: 'p-crt', build: 1, rev });
  assert.equal(r.eng.pendingRequests().length, 1);
  // the laptop rewrote another passage: the build is higher, this passage's text is not
  r.setContent(contentWith({ 'topics/fe-moves.md': s => bumpBuild(2)(s).replace('Mix: ', 'Mix, rewritten: ') }));
  assert.equal(r.eng.pendingRequests().length, 1, 'same hash: still pending');
  assert.equal(r.eng.triage('fe-moves', 'p-crt', 'lost').action, 'requested');
  // the same build with the text changed is not an answer either
  r.setContent(contentWith({ 'topics/fe-moves.md': s => s.replace('Split: ', 'Split it: ') }));
  assert.equal(r.eng.pendingRequests().length, 1, 'build not higher: still pending');
  r.setContent(contentWith({ 'topics/fe-moves.md': s => bumpBuild(2)(s).replace('Split: ', 'Split it: ') }));
  assert.deepEqual(r.eng.pendingRequests(), [], 'higher build, changed hash: answered');
  assert.deepEqual(r.eng.marks('fe-moves'), [], 'the lost mark it answered is closed');
  assert.deepEqual(r.eng.budget('fe-moves'), { left: 2, used: 1 }, 'the rewrite still counts in the cycle');
  const t = r.eng.triage('fe-moves', 'p-crt', 'lost');
  assert.equal(t.action === 'scaffold' && Date.parse(t.since), NOW, 'lost again on the new text: a new cycle');
});

test('Decision 6: the rewrite count resets when a rebuild of the doc lands', () => {
  const r = make();
  for (const a of ['p-crt', 'p-div', 'p-mix']) r.add('rewrite-request', { doc: 'fe-moves', a, build: 1 });
  assert.deepEqual(r.eng.budget('fe-moves'), { left: 0, used: 3 });
  r.add('rebuild-request', { doc: 'fe-moves', build: 1, a: 'p-last' });
  r.add('rewrite-request', { doc: 'fe-moves', a: 'p-last', build: 1 });
  assert.deepEqual(r.eng.budget('fe-moves'), { left: 0, used: 4 }, 'not landed yet');
  r.setContent(contentWith({ 'topics/fe-moves.md': bumpBuild(2) }));
  assert.deepEqual(r.eng.budget('fe-moves'), { left: 3, used: 0 }, 'landed: requests from build 1 no longer count');
  r.add('rewrite-request', { doc: 'fe-moves', a: 'p-crt', build: 2 });
  assert.deepEqual(r.eng.budget('fe-moves'), { left: 2, used: 1 });
});

test('stages: 0 for a basic never opened, 1 from the first event on it; areas come from content', () => {
  const r = make([]);
  assert.deepEqual(r.eng.basic('fe-div'), { id: 'fe-div', stage: 0, due: null, push: 0, streak: 0, last: null, history: [] });
  assert.deepEqual(r.eng.todayPlan().drills, [], 'nothing opened, nothing due');
  r.add('open', { doc: 'fe-div' });
  assert.equal(r.eng.basic('fe-div').stage, 1);
  assert.equal(r.eng.basic('fe-div').due, '2026-11-17', 'one stage-1 interval later');
  r.add('mark', { doc: 'fe-units', a: 'u-p1', verb: 'easy', build: 1 });
  assert.equal(r.eng.basic('fe-units').stage, 1, 'any event on a basic opens it');
  assert.deepEqual(r.eng.basic('nope'), { id: 'nope', stage: 0, due: null, push: 0, streak: 0, last: null, history: [] });
  assert.deepEqual(r.eng.basics().map(b => b.id).sort(), ['fe-crc', 'fe-crt', 'fe-div', 'fe-lfsr', 'fe-units']);
  assert.deepEqual(r.eng.areas(), ['nt', 'comb', 'an', 'la', 'gen', 'dd']);
  assert.equal(r.eng.rating('nt'), 3);
  assert.equal(r.eng.rating('comb'), 4);
  assert.equal(r.eng.rating('bio'), 4, 'an area with nothing yet starts at 4');
  assert.equal(r.eng.ratingHistory('comb').length, 1);
});

test('a clean hold is a clean retrieval of the basics its methods are taught in (once a day per basic)', () => {
  const r = make();
  assert.equal(r.eng.basic('fe-crt').stage, 2);
  r.settle('inv-nt-a', 'held', { called: ['m-crt'], used: ['m-crt'] });
  assert.equal(r.eng.basic('fe-crt').stage, 3);
  assert.equal(r.eng.basic('fe-crt').history.slice(-1)[0].src, 'problem');
  r.settle('inv-nt-f', 'held', { called: ['m-crt'], used: ['m-crt'] });
  assert.equal(r.eng.basic('fe-crt').stage, 3, 'once a day');
  r.settle('inv-la-y', 'held', { help: true, called: [], hidden: true });
  assert.equal(r.eng.basic('fe-div').history.slice(-1)[0].src, 'drill', 'held after help moves no stage');
  r.settle('inv-nt-c', 'missed', { called: [], used: ['m-bezout'] });
  assert.equal(r.eng.basic('fe-div').stage, 3, 'a miss moves no stage');
});

test('Today: one kata slot only while a track that serves katas is live; settled today is counted', () => {
  const r = make();
  r.settle('inv-nt-a', 'held');
  r.kata('k-crc', { pass: true });
  assert.equal(r.eng.todayPlan().settledToday, 2);
  r.advanceDays(1);
  assert.equal(r.eng.todayPlan().settledToday, 0);
  const c = contentWith({ 'meta/tracks.md': s => s.replace(/^\| asic .*$/m, '| asic | 2026-11-01 | 2 | dd | |') });
  const e2 = make(seed(), c);
  assert.deepEqual(e2.eng.todayPlan().picks.filter(p => p.kind === 'kata'), [], 'asic is over');
  assert.equal(e2.eng.pickKata()!.id, 'k-crc', 'pickKata still works without a live track');
});

test('the fold skips events it cannot use and counts them', () => {
  const bad = [
    { v: 1, id: 'x1', t: 'not a time', dev: 'x', type: 'open', doc: 'fe-div' },
    { v: 1, id: 'x2', t: X.isoLocal(new Date(NOW)), dev: 'x', type: 'teleport' },
    { v: 1, id: 'x3', t: X.isoLocal(new Date(NOW)), dev: 'x', type: 'stage-set', basic: 'nope', stage: 3 },
  ] as unknown as StudyEvent[];
  const e = foldState(CONTENT, [...seed(), ...bad], new Date(NOW));
  assert.equal(e.skipped(), 3);
  assert.equal(e.basic('fe-div').stage, 3);
});

/* ======================================================== review fixes (PR #85) */

test('one malformed synced event never breaks the engine: fields are coerced, a throwing event is skipped, every query answers', () => {
  const T = (h: number) => X.isoLocal(new Date(at(0, h)));
  const raw = (id: string, h: number, fields: Record<string, unknown>) => ({ v: 1, id, t: T(h), dev: 'other', ...fields });
  const bad = [
    raw('m1', 8, { type: 'settle', item: 'inv-nt-a', verdict: 'held', called: 5, used: 'm-crt', help: 'no', hidden: 0, hook: false }),
    raw('m2', 8, { type: 'kata', kata: 'k-crc', pass: true, runs: 'two', called: { x: 1 }, used: null }),
    raw('m3', 8, { type: 'settle', item: 7, verdict: null, called: [1, null, 'm-order'], used: [{}], hook: 'yes' }),
    raw('m4', 8, { type: 'mark', doc: 'fe-moves', a: 'p-crt', verb: 9, build: 'one' }),
    raw('m5', 8, { type: 'mark', doc: 42, a: null, verb: 'lost', build: {} }),
    raw('m6', 9, { type: 'drill', doc: 'fe-div', item: null, grade: 5, ms: 'x', src: [] }),
    raw('m7', 9, { type: 'fog', doc: 'fe-crt', proof: {}, reveals: 'abc', steps: null, done: true, clean: 'no' }),
    raw('m8', 9, { type: 'attempt', doc: 'fe-moves', a: 'p-crt', strokes: 'lots' }),
    raw('m9', 9, { type: 'call', item: 'inv-nt-b', conf: 'high', hidden: 'false', reach: [], d: 'hard' }),
    raw('m10', 9, { type: 'rewrite-request', doc: 'fe-moves', a: 'p-div', build: 'two', rev: 5 }),
    raw('m11', 9, { type: 'rebuild-request', doc: null, a: 3, build: undefined }),
    raw('m12', 9, { type: 'stage-set', basic: 'fe-lfsr', stage: 'high' }),
    raw('m13', 9, { type: 'open' }),
  ];
  // An event whose field throws when read: the fold must catch it, not the caller.
  const hostile = raw('m14', 10, { type: 'mark', a: 'p-crt', verb: 'lost', build: 1 });
  Object.defineProperty(hostile, 'doc', { enumerable: true, get() { throw new Error('boom'); } });
  const log = [...seed(), ...bad, hostile] as unknown as StudyEvent[];
  const e = foldState(CONTENT, log, new Date(NOW));
  // The queries the review names, and the rest of the contract: none may throw.
  const queries: [string, () => unknown][] = [
    ['basic', () => e.basic('fe-div')], ['basics', () => e.basics()], ['todayPlan', () => e.todayPlan(60)],
    ['triage', () => e.triage('fe-moves', 'p-crt', 'lost')], ['budget', () => e.budget('fe-moves')], ['marks', () => e.marks()],
    ['pendingRequests', () => e.pendingRequests()], ['blockers', () => e.blockers()], ['rating', () => e.rating('nt')],
    ['ratingHistory', () => e.ratingHistory('nt')], ['methodAccuracy', () => e.methodAccuracy()], ['pickProblem', () => e.pickProblem('nt')],
    ['pickKata', () => e.pickKata()], ['areas', () => e.areas()], ['hooks', () => e.hooks()], ['settled', () => e.settled('inv-nt-a')],
  ];
  for (const [name, q] of queries) assert.doesNotThrow(q, name);
  assert.equal(e.skipped(), 2, 'the mark with verb 9 and the throwing event');
  // Coerced, not dropped: the settle with called 5 rated nt and counted its methods as not called.
  const s = e.settled('inv-nt-a')!;
  assert.deepEqual([s.verdict, s.help, s.called, s.took, s.hit], ['held', false, [], ['m-crt'], false]);
  close(s.rAfter!, 3 + 0.6 * (1 - Ex(2.5, 3)), 1e-12);
  assert.deepEqual(e.settled('7')!.called, ['1', 'm-order'], 'list items: numbers as text, junk dropped');
  assert.equal(e.settled('k-crc')!.score, 1, 'runs "two" reads as no count: first-run pass');
  assert.equal(e.basic('fe-lfsr').stage, 0, 'stage "high" coerces to 0');
  assert.equal(e.basic('fe-div').last, 'clean', 'a drill with grade 5 moves no stage');
  assert.equal(e.pendingRequests().some(p => p.a === 'p-div'), false, 'build "two" reads as 0 and rev 5 is dropped: build 1 answers it');
  assert.equal(e.budget('fe-moves').used, 1);
  assert.ok(e.todayPlan(60).picks.length > 0, 'Today still plans');
  // The same log through the live engine (as on a device after sync) answers too.
  const live = createEngine(() => new Date(NOW));
  live.update(CONTENT, log);
  assert.doesNotThrow(() => live.todayPlan());
});

test('Today: every area gets its own slots, so a push area that is not the first still gets its hidden pick', () => {
  // Two problem areas: nt (nearest deadline, not in push) and comb (in push, through a basic moved to comb for this test).
  const c = contentWith({
    'basics/fe-lfsr.md': s => s.replace(/^area: dd$/m, 'area: comb').replace(/^tracks: \[asic\]$/m, 'tracks: []'),
    'meta/tracks.md': s => s + '| counting | 2026-12-10 | 1 | comb | |\n',
  });
  const r = make(seed(), c);
  r.comfortable('comb');
  assert.equal(r.eng.inPush('comb'), true);
  assert.equal(r.eng.inPush('nt'), false);
  const ps = problems(r.eng);
  assert.deepEqual(ids(ps.slice(0, 3)), ['inv-nt-a', 'inv-nt-b', 'inv-nt-c'], 'nt: three visible slots');
  assert.ok(ps.slice(0, 3).every(p => !p.hidden));
  const comb = ps.slice(3);
  assert.deepEqual(comb.map(p => p.hidden), [false, false, true], 'comb: its third slot is hidden');
  assert.deepEqual(ids(comb.slice(0, 2)).sort(), ['inv-comb-a', 'inv-comb-b']);
  assert.notEqual(c.problems.get(comb[2].id)!.area, 'comb', 'a hidden pick comes from another practised area');
  // The pattern is per area: the round robin over three total slots gave comb only its slot 0, never a hidden one.
  assert.equal(ps.filter(p => p.hidden).length, 1);
});

test('settled today counts distinct items first settled today: re-ticks and second hook attempts are not new', () => {
  const r = make();
  r.settle('inv-nt-a', 'held', { called: [], used: ['m-crt'] });
  r.settle('inv-nt-a', 'held', { called: ['m-crt'], used: ['m-crt'] }); // re-tick
  r.kata('k-crc', { pass: true });
  r.kata('k-crc', { pass: true, called: ['d-shift'] }); // re-tick
  r.settle(hookItem('fe-div', 'bezout'), 'held', { hook: true });
  r.settle(hookItem('fe-div', 'bezout'), 'held', { hook: true, called: ['m-bezout'] }); // re-tick of attempt 1
  r.settle(hookItem('fe-div', 'bezout', 2), 'missed', { hook: true }); // attempt 2, same theorem
  assert.equal(r.eng.todayPlan().settledToday, 3, 'inv-nt-a, k-crc, the bezout hook');
  r.advanceDays(1);
  r.settle('inv-nt-a', 'missed'); // settled yesterday: a re-tick today is not a new settle
  r.settle(hookItem('fe-div', 'bezout', 3), 'held', { hook: true }); // first settled yesterday
  assert.equal(r.eng.todayPlan().settledToday, 0);
  r.settle('inv-nt-b', 'held');
  assert.equal(r.eng.todayPlan().settledToday, 1);
});

test('S5 contract: a rewrite request with rev is answered only by a higher build AND a changed hash; a cross-doc rebuild request (a = <doc>#<anchor>) closes the mark it came from', () => {
  const r = make();
  // rewrite with rev: a higher build alone is not an answer
  const rev = CONTENT.anchors.get('fe-moves')!.get('p-mix')!.hash;
  r.mark('fe-moves', 'p-mix', 'lost');
  r.add('rewrite-request', { doc: 'fe-moves', a: 'p-mix', build: 1, rev });
  r.setContent(contentWith({ 'topics/fe-moves.md': bumpBuild(3) }));
  assert.deepEqual(r.eng.pendingRequests().map(p => [p.kind, p.a]), [['rewrite', 'p-mix']], 'build 3, same text: pending');
  r.setContent(contentWith({ 'topics/fe-moves.md': s => bumpBuild(3)(s).replace('Mix: ', 'Mix them: ') }));
  assert.deepEqual(r.eng.pendingRequests(), [], 'build 3, new text: answered');
  // rebuild requested from a mark in a topic: the request names the basic; a names the marked passage
  r.mark('fe-moves', 'p-units', 'lost');
  r.add('rebuild-request', { doc: 'fe-units', build: 1, a: 'fe-moves#p-units' });
  assert.deepEqual(r.eng.pendingRequests().map(p => [p.kind, p.doc, p.a]), [['rebuild', 'fe-units', 'fe-moves#p-units']]);
  assert.deepEqual(r.eng.marks('fe-moves').map(m => m.a), ['p-units'], 'open while the rebuild waits');
  r.setContent(contentWith({ 'topics/fe-moves.md': s => bumpBuild(3)(s).replace('Mix: ', 'Mix them: '), 'basics/fe-units.md': bumpBuild(2) }));
  assert.deepEqual(r.eng.pendingRequests(), []);
  assert.deepEqual(r.eng.marks('fe-moves'), [], 'the landed rebuild of fe-units closes the topic\'s lost mark');
  // a rebuild of another basic does not close a mark it was not requested for
  r.mark('fe-moves', 'p-plain', 'lost');
  r.add('rebuild-request', { doc: 'fe-crt', build: 1, a: 'fe-moves#p-crt' });
  r.setContent(contentWith({ 'topics/fe-moves.md': s => bumpBuild(3)(s).replace('Mix: ', 'Mix them: '), 'basics/fe-units.md': bumpBuild(2), 'basics/fe-crt.md': bumpBuild(2) }));
  assert.deepEqual(r.eng.marks('fe-moves').map(m => m.a), ['p-plain']);
});

/* ==================================================== S14: track docs sections, hidden: never */

test('tracks: the docs column splits on `;`, each section `[folder] glob, glob`, matching by the docs column alone', () => {
  // Rows shaped like the real mie342, putnam and interviews rows: folder + glob sections, a section
  // without a folder, a trailing `;`, every areas column empty. One bank doc is added inline so the
  // bank section has something to match; no fixture file is touched.
  const bank: SourceFile = {
    path: 'study/bank/course-2025.md',
    text: [
      '---', 'study: bank', 'id: course-2025', 'title: Course 2025 (fixture)', '---', '',
      '| id | source | d | statement | solutions |',
      '|---|---|---|---|---|',
      '| course-q3 | Course 2025 Q3 | 2.37 | [paper](https://example.com/q.pdf) | [solutions](https://example.com/s.pdf) |',
      '',
    ].join('\n'),
  };
  const c = buildIndex([...sources({
    'meta/tracks.md': s => s + [
      '| s14-mie | 2026-12-08 | 1 | | basics fe-units, fe-crt; topics fe-count |',
      '| s14-bank | 2026-12-09 | 1 | | bank course-*; topics fe-gen; |',
      '| s14-loose | 2026-12-10 | 1 | | fe-geo, fe-an |',
      '| s14-old | 2026-12-11 | 1 | | basics fe-c* |',
      '',
    ].join('\n'),
  }), bank]);
  const r = make(seed(), c);
  const st = r.eng.state();
  const track = (id: string) => c.tracks.find(t => t.id === id)!;
  const serves = (tid: string) => (doc: string) => st.trackMatches(track(tid), c.docs.get(doc)!);

  // Folder + glob sections: only the named globs inside the named folder, per section.
  assert.deepEqual(['fe-units', 'fe-crt', 'fe-count'].map(serves('s14-mie')), [true, true, true]);
  assert.deepEqual(['fe-div', 'fe-gen', 'fe-geo', 'k-crc', 'course-2025'].map(serves('s14-mie')), [false, false, false, false, false],
    'a folder section neither leaks to the folder\'s other docs nor across to other sections');
  // A bank section with a glob, a topics section, and a trailing `;`.
  assert.equal(c.docs.has('course-q3'), false, 'course-q3 is a bank entry, not a doc: sections match doc ids');
  assert.deepEqual(['course-2025', 'fe-gen'].map(serves('s14-bank')), [true, true]);
  assert.deepEqual(['fe-count', 'fe-units'].map(serves('s14-bank')), [false, false]);
  // A section without a folder matches its globs in any folder.
  assert.deepEqual(['fe-geo', 'fe-an'].map(serves('s14-loose')), [true, true]);
  assert.deepEqual(['fe-count', 'fe-units'].map(serves('s14-loose')), [false, false]);
  // A row with no `;`: exactly the old rule (folders constrain the globs).
  assert.deepEqual(['fe-crc', 'fe-crt'].map(serves('s14-old')), [true, true]);
  assert.deepEqual(['fe-units', 'fe-count', 'k-crc'].map(serves('s14-old')), [false, false, false]);

  const pick = (d: { date: string; daysLeft: number; track: string } | null) => d && [d.track, d.date, d.daysLeft];
  assert.deepEqual(pick(r.eng.deadline('fe-count')), ['s14-mie', '2026-12-08', 23], 'a section match feeds the deadline');
  assert.deepEqual(pick(r.eng.deadline('fe-geo')), ['s14-loose', '2026-12-10', 25]);
  assert.deepEqual(pick(r.eng.deadline('fe-crt')), ['residues', '2026-11-24', 9], 's14-mie and s14-old are farther out');
});

test('tracks: a folder binds only its own section\'s globs, and a folder alone serves the whole folder', () => {
  // Rows that tell the section rule from near misses (one split of the whole column, a dropped folder
  // check, a folder-only section that matches nothing): a folder binds only its own section's globs, a
  // section without a folder matches its glob in any folder, and a folder alone serves every doc in that
  // folder and nothing else. The engine fixtures have no bank folder, so two bank docs are added inline;
  // no fixture file is touched.
  const bank = (id: string): SourceFile => ({
    path: `study/bank/${id}.md`,
    text: [
      '---', 'study: bank', `id: ${id}`, `title: ${id} (fixture)`, '---', '',
      '| id | source | d | statement | solutions |',
      '|---|---|---|---|---|',
      `| ${id}-q1 | ${id} Q1 | 2.00 | [paper](https://example.com/q.pdf) | [solutions](https://example.com/s.pdf) |`,
      '',
    ].join('\n'),
  });
  const c = buildIndex([...sources({
    'meta/tracks.md': s => s + [
      '| s14-each | 2026-12-08 | 1 | | basics fe-units; topics fe-c* |',
      '| s14-anywhere | 2026-12-08 | 1 | | basics fe-units; fe-geo |',
      '| s14-topics | 2026-12-08 | 1 | | topics |',
      '| s14-bank | 2026-12-08 | 1 | | basics fe-units; bank |',
      '',
    ].join('\n'),
  }), bank('quiz-a'), bank('quiz-b')]);
  const st = make([], c).eng.state();
  // Every doc in the index that the track serves: each list pins what is served and, by omission, what is not.
  const served = (tid: string) => {
    const t = c.tracks.find(x => x.id === tid)!;
    return [...c.docs.values()].filter(d => st.trackMatches(t, d)).map(d => d.id).sort();
  };

  assert.deepEqual(served('s14-each'), ['fe-count', 'fe-units'],
    'basics binds fe-units and topics binds fe-c*: fe-crc and fe-crt match fe-c* but are basics');
  assert.deepEqual(served('s14-anywhere'), ['fe-geo', 'fe-units'],
    'basics binds fe-units alone; fe-geo, a topic, matches because its section names no folder');
  assert.deepEqual(served('s14-topics'), ['fe-an', 'fe-count', 'fe-framing', 'fe-gen', 'fe-geo', 'fe-moves'],
    'every topic, and no basic, kata or bank doc');
  assert.deepEqual(served('s14-bank'), ['fe-units', 'quiz-a', 'quiz-b'], 'every bank doc and fe-units, and no other basic');
});

test('hidden: never on the bank file keeps its problems out of hidden picks but in visible ones', () => {
  // A course bank whose source names the chapter: course-q3 (area el, methods m-invariant) is the
  // nearest hidden candidate once el is practised — until `hidden: never` rules it out.
  const bank = (hidden: string): SourceFile => ({
    path: 'study/bank/course-2025.md',
    text: [
      '---', 'study: bank', 'id: course-2025', hidden + '---', '',
      '| id | source | d | statement | solutions |',
      '|---|---|---|---|---|',
      '| course-q3 | Course 2025 Q3 | 2.37 | [paper](https://example.com/q.pdf) | [solutions](https://example.com/s.pdf) |',
      '',
    ].join('\n'),
  });
  const tags: SourceFile = {
    path: 'study/bank/course-2025.tags.md',
    text: ['| id | area | methods |', '|---|---|---|', '| course-q3 | el | m-invariant |', ''].join('\n'),
  };
  const basic: SourceFile = {
    path: 'study/basics/el-ohm.md',
    text: [
      '---', 'study: basic', 'id: el-ohm', 'title: Ohm (fixture)', 'area: el', 'build: 1', '---', '',
      '> Written by a model for Adit. Not Adit\'s words.', '', 'An invented el basic for the hidden: never tests.', '',
    ].join('\n'),
  };
  const events = () => [...seed(), ev('open', { doc: 'el-ohm' }, at(-1))];

  const cOpen = buildIndex([...sources(), bank(''), tags, basic]);
  const open = make(events(), cOpen);
  assert.equal(open.eng.state().practised('el'), true, 'the opened el basic makes el practised');
  assert.equal(open.eng.state().hiddenOK(cOpen.problems.get('course-q3')!), true, 'unflagged: methods known');
  assert.equal(open.eng.pickProblem('nt', { hidden: true })!.id, 'course-q3', 'unflagged: nearer its hidden target than inv-gen-a');

  const cFlag = buildIndex([...sources(), bank('hidden: never\n'), tags, basic]);
  const flagged = make(events(), cFlag);
  assert.equal(flagged.eng.state().hiddenOK(cFlag.problems.get('course-q3')!), false, 'the bank file says hidden: never');
  assert.equal(flagged.eng.pickProblem('nt', { hidden: true })!.id, 'inv-gen-a', 'flagged out of hidden picks');
  assert.equal(flagged.eng.pickProblem('el')!.id, 'course-q3', 'still picked as a visible problem');
});

test('hidden: never on a doc keeps its invented problems out of hidden picks but in visible ones', () => {
  const c = contentWith({ 'topics/fe-count.md': s => s.replace('build: 1', 'build: 1\nhidden: never') });
  const r = make(seed(), c);
  const st = r.eng.state();
  const p = c.problems.get('inv-comb-a')!;
  assert.ok(p.methods.length > 0);
  assert.equal(st.hiddenOK(p), false, 'methods known, but the doc says hidden: never');
  assert.equal(st.hiddenOK(c.problems.get('inv-comb-b')!), false, 'still false without methods, as before');
  r.settle('inv-comb-b', 'moot');
  assert.equal(r.eng.pickProblem('comb')!.id, 'inv-comb-a', 'still a visible pick');
});

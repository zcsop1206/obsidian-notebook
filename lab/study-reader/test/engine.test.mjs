// Engine tests: node --test "lab/study-reader/test/engine.test.mjs"
// Loads src/engine.js with a fake window.SR {store, bus, content} (vm, in this realm)
// and checks every agreed rule with exact numbers. The fixture is inline and
// invented; it is not the page's content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(HERE, '..', 'src', 'engine.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const DAY = 86400000;
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime(); // local noon on 2026-11-15

// Independent copies of the agreed formulas, for checking the engine's numbers.
const Ex = (d, r) => 1 / (1 + 10 ** ((d - r) / 2));
const OFF65 = -0.5376906245851601;  // 2 log10(1/0.65 - 1)
const OFF60 = -0.35218251811136236; // 2 log10(1/0.60 - 1)
const OFF70 = -0.7359535705891888;  // 2 log10(1/0.70 - 1)
const OFF40 = 0.3521825181113625;   // 2 log10(1/0.40 - 1)

function close(got, want, eps = 1e-9, msg = '') {
  assert.ok(typeof got === 'number' && Math.abs(got - want) <= eps, `${msg} expected ${want}, got ${got}`);
}

function memStore(prefix = 'lab-study-reader-') {
  const m = new Map();
  return {
    get: k => (m.has(prefix + k) ? JSON.parse(m.get(prefix + k)) : null),
    set: (k, v) => { m.set(prefix + k, JSON.stringify(v)); },
    del: k => { m.delete(prefix + k); },
    map: m
  };
}
function throwingStore() {
  return { get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); }, del() { throw new Error('blocked'); } };
}
function fakeBus() {
  const events = [];
  return { on() {}, off() {}, emit(evt, data) { events.push([evt, data]); }, events };
}

// Run engine.js the way the page does: a script that attaches to window.SR.
function loadFile(win) {
  const mod = { exports: {} };
  const wrapper = vm.runInThisContext('(function (window, module) {\n' + SRC + '\n})', { filename: SRC_PATH });
  wrapper(win, mod);
  return mod.exports;
}
const X = loadFile({ SR: {} });
// The page's own content (src/content.js), for the checks that are about the problem bank itself.
const CONTENT_PATH = path.join(HERE, '..', 'src', 'content.js');
function loadContent() {
  const mod = { exports: {} };
  vm.runInThisContext('(function (window, module) {\n' + fs.readFileSync(CONTENT_PATH, 'utf8') + '\n})', { filename: CONTENT_PATH })({ SR: {} }, mod);
  return mod.exports;
}

function fixture() {
  const p = (id, d, area, methods, basics, extra = {}) => ({
    id, kind: 'invented', label: 'Invented ' + id, statement: 'Fixture statement ' + id + '.', solution: 'Fixture solution.',
    d, area, methods, basics, hiddenOK: false, ...extra
  });
  const steps = n => Array.from({ length: n }, (_, i) => ({ html: 'step ' + i, topic: 'topic ' + i }));
  return {
    docs: {
      'nt-divisibility': { id: 'nt-divisibility', title: 'Divisibility and Bézout', kind: 'basic', area: 'nt', track: 'putnam', needs: [],
        versions: { 1: '<h2 data-a="bezout">Bézout</h2><p data-a="bz-p">Combinations.</p><div class="blk" data-block="fog" data-id="f-bezout"></div>' } },
      'nt-units': { id: 'nt-units', title: 'Units mod n', kind: 'basic', area: 'nt', track: 'putnam', needs: ['nt-divisibility'],
        rebuiltFrom: 'Starts again from Bézout.',
        versions: {
          1: '<h2 data-a="units">Units</h2><p data-a="u-p1">A unit iff <a class="ref" data-to="nt-divisibility#bezout">Bézout</a>.</p><p data-a="u-p2">Order.</p>',
          2: '<h2 data-a="units">Units, rebuilt</h2><p data-a="u-p0">From divisibility up.</p><p data-a="u-p1">A unit iff gcd 1.</p><p data-a="u-p2">Order.</p>'
        } },
      'nt-crt': { id: 'nt-crt', title: 'Chinese remainder theorem', kind: 'basic', area: 'nt', track: 'putnam', needs: ['nt-divisibility', 'nt-units'],
        versions: { 1: '<h2 data-a="crt">CRT</h2><p data-a="crt-p">Uses <a class="ref" data-to="nt-units#u-p1">units</a>.</p><div class="blk" data-block="fog" data-id="f-crt"></div>' } },
      'dd-lfsr': { id: 'dd-lfsr', title: 'Shift registers and LFSRs over GF(2)', kind: 'basic', area: 'dd', track: 'asic', needs: [],
        versions: { 1: '<h2 data-a="lfsr">LFSR</h2><p data-a="l-p">Shift.</p><div class="blk" data-block="kata" data-id="k-shift"></div>' } },
      'dd-crc': { id: 'dd-crc', title: 'CRC as polynomial division over GF(2)', kind: 'basic', area: 'dd', track: 'asic', needs: ['dd-lfsr'],
        versions: { 1: '<h2 data-a="crc">CRC</h2><p data-a="c-p">Divide. <a class="ref" data-to="dd-lfsr#lfsr">LFSR</a></p>' } },
      'nt-moves': { id: 'nt-moves', title: 'Number theory: first moves', kind: 'topic', area: 'nt', track: 'putnam',
        needs: ['nt-divisibility', 'nt-units', 'nt-crt'],
        versions: { 1:
          '<h2 data-a="s1">First moves</h2>' +
          '<p data-a="p-units">Orders: <a class="ref" data-to="nt-units#u-p2">order</a>.</p>' +
          '<p data-a="p-crt">Split: <a class="ref" data-to="nt-crt#crt">CRT</a> and <a class="ref" data-to="nt-divisibility#bezout">Bézout</a>.</p>' +
          '<p data-a="p-div">Divide: <a class="ref" data-to="nt-divisibility#bezout">Bézout</a>.</p>' +
          '<p data-a="p-mix">Mix: <a class="ref" data-to="nt-crt#crt">CRT</a>.</p>' +
          '<p data-a="p-last">Last: <a class="ref" data-to="nt-divisibility#bezout">B</a>.</p>' +
          '<p data-a="p-hook">Try: <a class="ref" data-to="nt-divisibility#bezout">B</a>.</p><div class="blk" data-block="problem" data-id="nt-a" data-hook="1"></div>' +
          '<h2 data-a="s2">More</h2><p data-a="p-plain">No links here.</p>' } },
      'dd-framing': { id: 'dd-framing', title: 'Serial framing', kind: 'topic', area: 'dd', track: 'asic', needs: ['dd-crc', 'dd-lfsr'],
        versions: { 1:
          '<h2 data-a="f1">Framing</h2><p data-a="f-crc">Check: <a class="ref" data-to="dd-crc#crc">CRC</a>.</p>' +
          '<p data-a="f-kata">Build it.</p><div class="blk" data-block="kata" data-id="k-uart"></div>' +
          '<p data-a="f-hidden">Another.</p><div class="blk" data-block="kata" data-id="k-badframe"></div>' } }
    },
    fog: {
      'f-bezout': { doc: 'nt-divisibility', basic: 'nt-divisibility', anchor: 'bezout', statement: 'S', steps: steps(3), chunks: [[0, 1], [2]] },
      'f-crt': { doc: 'nt-crt', basic: 'nt-crt', anchor: 'crt', statement: 'S', steps: steps(3), chunks: [[0, 1], [2]] },
      'f-units': { doc: 'nt-units', basic: 'nt-units', anchor: 'units', statement: 'S', steps: steps(4) }
    },
    problems: [
      p('nt-a', 2.5, 'nt', ['m-crt'], ['nt-crt']),
      p('nt-b', 2.0, 'nt', ['m-order'], ['nt-units']),
      p('nt-c', 3.0, 'nt', ['m-bezout'], ['nt-divisibility']),
      p('nt-d', 3.4, 'nt', ['m-order'], ['nt-units'], { kind: 'competition', label: 'Putnam 2019 A2', link: 'https://kskedlaya.org/putnam-archive/2019.pdf', statement: undefined, solution: undefined }),
      p('nt-e', 1.5, 'nt', ['m-bezout'], ['nt-divisibility']),
      p('nt-f', 1.0, 'nt', ['m-crt'], ['nt-crt']),
      p('nt-h', 1.46, 'nt', ['m-bezout'], ['nt-divisibility'], { hiddenOK: true }),
      p('cp-a', 2.5, 'cp', ['m-pigeonhole'], [], { hiddenOK: true }),
      p('cp-b', 3.6, 'cp', ['m-pigeonhole'], []),
      p('gr-a', 2.4, 'gr', ['m-invariant'], [], { hiddenOK: true }),
      p('an-a', 5.0, 'an', ['m-invariant'], [], { hiddenOK: true }),
      p('lg-x', 4.0, 'lg', ['m-invariant'], ['nt-divisibility', 'nt-crt']),
      p('lg-y', 4.0, 'lg', ['m-invariant'], ['nt-divisibility'])
    ],
    katas: [
      { id: 'k-shift', title: 'Shift register with enable', d: 2.5, level: 'simple', hidden: false, spec: 's', skeleton: 'm', basics: ['dd-lfsr'], methods: ['d-shift'] },
      { id: 'k-lfsr', title: 'Galois LFSR', d: 3.0, level: 'simple', hidden: false, spec: 's', skeleton: 'm', basics: ['dd-lfsr'], methods: ['d-lfsr'] },
      { id: 'k-crc', title: 'Serial CRC-8', d: 3.5, level: 'simple', hidden: false, spec: 's', skeleton: 'm', basics: ['dd-crc'], methods: ['d-crc'] },
      { id: 'k-uart', title: 'UART transmitter', d: 5.0, level: 'hard', hidden: false, spec: 's', skeleton: 'm', basics: ['dd-crc'], methods: ['d-fsm', 'd-counter'] },
      { id: 'k-badframe', title: 'Frame check', d: 4.5, level: 'hard', hidden: true, spec: 's', skeleton: 'm', basics: ['dd-crc'], methods: ['d-crc'] }
    ],
    methods: {
      math: [
        { id: 'm-crt', label: 'Chinese remainder theorem', basic: 'nt-crt' },
        { id: 'm-bezout', label: 'Bézout', basic: 'nt-divisibility' },
        { id: 'm-order', label: 'Order of a unit', basic: 'nt-units' },
        { id: 'm-pigeonhole', label: 'Pigeonhole' },
        { id: 'm-invariant', label: 'Invariant' }
      ],
      design: [
        { id: 'd-shift', label: 'Shift register' },
        { id: 'd-lfsr', label: 'LFSR', basic: 'dd-lfsr' },
        { id: 'd-crc', label: 'CRC division', basic: 'dd-crc' },
        { id: 'd-fsm', label: 'State machine' },
        { id: 'd-counter', label: 'Counter' }
      ]
    },
    pmTasks: [
      { id: 't1', text: 'ASIC: framing block passes its testbench', project: 'asic', due: '2026-12-01', needs: ['dd-crc'], status: 'open' },
      { id: 't2', text: 'Putnam: timed set on residues', project: 'putnam', due: '2026-11-24', needs: ['nt-units', 'nt-crt'], status: 'open' },
      { id: 't3', text: 'A closed task', project: 'putnam', due: '2026-11-16', needs: ['nt-divisibility'], status: 'done' }
    ],
    tests: [{ id: 'putnam', date: '2026-12-05', track: 'putnam' }, { id: 'asic', date: '2027-01-18', track: 'asic' }],
    rewrites: { 'nt-moves': { 'p-crt': '<p data-a="p-crt">Rewritten passage.</p>', 'p-div': '<p data-a="p-div">Rewritten.</p>' } }
  };
}

function make({ content = fixture(), store = memStore(), bus = fakeBus(), now = NOW } = {}) {
  let t = now;
  const eng = X.createEngine({ content, store, bus, realNow: () => t });
  return { eng, store, bus, content, setReal: v => { t = v; } };
}
const ids = L => L.map(x => x.id);

/* ---------------------------------------------------------------- pure rules */

test('expected score, stretch band, hidden and reach targets (exact numbers)', () => {
  close(X.expected(5, 5), 0.5, 1e-15);
  close(X.expected(2.5, 3), 0.6400649998028851, 1e-12);
  close(X.dForE(3, 0.65), 3 + OFF65, 1e-12);
  close(X.dForE(3, 0.65), 2.4623093754148399, 1e-12, 'd ~= r - 0.54');
  close(X.dForE(4, 0.60), 4 + OFF60, 1e-12);
  close(X.dForE(4, 0.70), 4 + OFF70, 1e-12);
  close(X.dForE(4, 0.40), 4 + OFF40, 1e-12);
  close(X.expected(X.dForE(4, 0.65), 4), 0.65, 1e-12);
  close(X.expected(X.dForE(4, 0.65) - 1, 4), 0.85449892317165, 1e-12, 'hidden: one step below the target');
  close(X.expected(X.dForE(4, 0.40), 4), 0.40, 1e-12);
});

test('rating update r <- r + 0.6 (score - E)', () => {
  const E = 0.6400649998028851;
  close(X.rateUpdate(3, 2.5, 1).r, 3 + 0.6 * (1 - E), 1e-12);
  close(X.rateUpdate(3, 2.5, 1).r, 3.215961000118269, 1e-12);
  close(X.rateUpdate(3, 2.5, 0.75).r, 3 + 0.6 * (0.75 - E), 1e-12);
  close(X.rateUpdate(3, 2.5, 0).r, 2.615961000118269, 1e-12);
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

test('push levels: earned from stage and clean streaks, one failure drops a level', () => {
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

/* ----------------------------------------------------------- seed and clock */

test('seed: stages, push levels, due dates and starting ratings', () => {
  const { eng } = make();
  assert.equal(eng.today(), '2026-11-15');
  assert.equal(eng.now(), NOW);
  const st = { 'nt-divisibility': 3, 'nt-units': 1, 'nt-crt': 2, 'dd-lfsr': 2, 'dd-crc': 3 };
  for (const [b, s] of Object.entries(st)) assert.equal(eng.stage(b), s, b);
  const pl = { 'nt-divisibility': 2, 'nt-units': 0, 'nt-crt': 1, 'dd-lfsr': 1, 'dd-crc': 1 };
  for (const [b, s] of Object.entries(pl)) assert.equal(eng.pushLevel(b), s, b);
  const due = { 'nt-divisibility': '2026-11-17', 'nt-units': '2026-11-14', 'nt-crt': '2026-11-15', 'dd-lfsr': '2026-11-13', 'dd-crc': '2026-11-16' };
  for (const [b, d] of Object.entries(due)) assert.equal(eng.due(b), d, b);
  assert.equal(eng.rating('nt'), 3);
  for (const a of ['cp', 'an', 'lg', 'dd', 'gr']) assert.equal(eng.rating(a), 4, a);
  assert.equal(eng.lastDrill('nt-units').grade, 'shaky');
  assert.equal(eng.history('nt').length, 1);
  assert.equal(eng.inPush('nt'), false);
  assert.equal(eng.inPush('dd'), false);
});

test('simulated clock: advanceDays moves now() by n x 24 h and today() by n days', () => {
  const { eng, bus } = make();
  assert.equal(eng.advanceDays(2), '2026-11-17');
  assert.equal(eng.now(), NOW + 2 * DAY);
  assert.equal(eng.today(), '2026-11-17');
  const ev = bus.events.filter(([e, d]) => e === 'engine:change' && d.type === 'clock');
  assert.equal(ev.length, 1);
  assert.equal(eng.advanceDays(-2), '2026-11-15');
});

/* ------------------------------------------------- deadlines and drill plan */

test('deadline = min(test date of the track, earliest open pm task that needs the basic)', () => {
  const { eng } = make();
  assert.deepEqual(pick(eng.deadline('nt-divisibility')), { date: '2026-12-05', source: 'test', daysLeft: 20 }, 'the done task is ignored');
  assert.deepEqual(pick(eng.deadline('nt-units')), { date: '2026-11-24', source: 'task', daysLeft: 9 });
  assert.deepEqual(pick(eng.deadline('dd-crc')), { date: '2026-12-01', source: 'task', daysLeft: 16 });
  assert.deepEqual(pick(eng.deadline('dd-lfsr')), { date: '2027-01-18', source: 'test', daysLeft: 64 });
  assert.equal(eng.deadline('nt-divisibility').label, 'Putnam');
  eng.advanceDays(21); // 2026-12-06: Putnam is over, task t2 is open and past due
  assert.equal(eng.deadline('nt-divisibility'), null);
  assert.deepEqual(pick(eng.deadline('nt-units')), { date: '2026-11-24', source: 'task', daysLeft: 0 });
  const content = fixture();
  content.tests[0].label = 'Putnam 2026';
  assert.equal(make({ content }).eng.deadline('nt-divisibility').label, 'Putnam 2026', 'a test\'s own label wins');
  function pick(d) { return d && { date: d.date, source: d.source, daysLeft: d.daysLeft }; }
});

test('Today ranks due drills by min(test date, earliest task deadline), then by days overdue', () => {
  const { eng } = make();
  const drills = eng.todayPlan().drills;
  // nt-units and nt-crt: task t2 in 9 d; dd-lfsr: the ASIC test in 64 d (2 d overdue, but its deadline is far)
  assert.deepEqual(drills.map(d => d.basic), ['nt-units', 'nt-crt', 'dd-lfsr']);
  assert.deepEqual(drills.map(d => d.daysLeft), [9, 9, 64]);
  assert.deepEqual(drills.map(d => d.overdue), [1, 0, 2], 'same deadline: the overdue one first');
  close(drills[0].priority, 1 * (1 + 2 * Math.exp(-9 / 14)), 1e-12, 'priority (overdue x deadline weight) is still reported');
  close(drills[2].priority, 2 * (1 + 2 * Math.exp(-64 / 14)), 1e-12);
  assert.match(drills[0].why, /Nearest deadline: task .* 2026-11-24 \(9 d\); overdue 1 d\./);
  assert.match(drills[1].why, /due today/);
});

test('recordDrill: clean +1, shaky =, failed -> 0; the interval is capped near the deadline', () => {
  const { eng } = make();
  let r = eng.recordDrill('nt-units', 'clean');
  assert.equal(r.stageBefore, 1);
  assert.equal(r.stageAfter, 2);
  assert.equal(r.interval, 3, 'min(4, floor(9/3))');
  assert.equal(r.due, '2026-11-18');
  assert.equal(r.capped, true);
  assert.equal(r.pushAfter, 1, 'stage 2 with a clean result');
  r = eng.recordDrill('nt-units', 'clean');
  assert.equal(r.sameDay, true, 'one stage per basic per day');
  assert.equal(r.stageAfter, 2);
  eng.advanceDays(1); // 2026-11-16, 8 days to the task
  r = eng.recordDrill('nt-units', 'shaky');
  assert.equal(r.stageAfter, 2);
  assert.equal(r.interval, 2, 'min(4, floor(8/3))');
  assert.equal(r.due, '2026-11-18');
  assert.equal(r.pushAfter, 1, 'shaky holds the push level');
  r = eng.recordDrill('nt-units', 'failed');
  assert.equal(r.stageAfter, 0);
  assert.equal(r.interval, 1);
  assert.equal(r.due, '2026-11-17');
  assert.equal(r.pushAfter, 0, 'one failure drops a level');
  assert.equal(eng.lastDrill('nt-units').grade, 'failed');
  assert.equal(eng.recordDrill('nt-units', 'great'), null);
});

test('far deadline: stage 5 interval is min(30, floor(63/3)) = 21', () => {
  const { eng } = make();
  let r = eng.recordDrill('dd-lfsr', 'clean');
  assert.equal(r.stageAfter, 3);
  assert.equal(r.interval, 7, 'cap 21 does not bind');
  assert.equal(r.due, '2026-11-22');
  assert.equal(r.capped, false);
  eng.setStage('dd-lfsr', 4);
  eng.advanceDays(1);
  r = eng.recordDrill('dd-lfsr', 'clean');
  assert.equal(r.stageAfter, 5);
  assert.equal(r.interval, 21);
  assert.equal(r.due, '2026-12-07');
});

/* -------------------------------------------------------------- push levels */

test('recordFog: grades, stage and push before/after, failure drops one level at a time', () => {
  const { eng } = make();
  let r = eng.recordFog('f-crt', { reveals: 1, steps: 3, done: false });
  assert.equal(r.grade, null);
  assert.equal(r.stageAfter, r.stageBefore);
  r = eng.recordFog('f-crt', { reveals: 0, steps: 3, done: true, clean: true });
  assert.deepEqual([r.grade, r.stageBefore, r.stageAfter, r.pushBefore, r.pushAfter], ['clean', 2, 3, 1, 2]);
  eng.advanceDays(1);
  r = eng.recordFog('f-crt', { reveals: 0, steps: 3, done: true });
  assert.deepEqual([r.stageAfter, r.pushAfter], [4, 3], 'stage 4: level 3');
  assert.equal(eng.inPush('nt'), true);
  r = eng.recordFog('f-crt', { reveals: 1, steps: 3, done: true });
  assert.deepEqual([r.grade, r.stageAfter, r.pushAfter], ['shaky', 4, 3]);
  r = eng.recordFog('f-crt', { reveals: 3, steps: 3, done: true });
  assert.deepEqual([r.grade, r.stageAfter, r.pushBefore, r.pushAfter], ['failed', 0, 3, 2]);
  assert.equal(eng.inPush('nt'), false);
  assert.equal(eng.recordFog('f-crt', { reveals: 2, steps: 2, done: true }).pushAfter, 1);
  assert.equal(eng.recordFog('f-crt', { reveals: 2, steps: 2, done: true }).pushAfter, 0);
  assert.equal(eng.recordFog('f-crt', { reveals: 2, steps: 2, done: true }).pushAfter, 0);
  assert.equal(eng.recordFog('nope', { reveals: 0, steps: 3, done: true }), null);
  assert.equal(eng.recordFog('nope', { reveals: 0, steps: 3, done: true, basic: 'dd-crc' }).grade, 'clean');
});

test('recordFog without steps counts merged chunks at push level 1 and single steps at level 0', () => {
  const { eng } = make();
  assert.equal(eng.pushLevel('nt-crt'), 1);
  assert.equal(eng.recordFog('f-crt', { reveals: 2, done: true }).grade, 'failed', '2 of 2 chunks');
  assert.equal(eng.pushLevel('nt-units'), 0);
  assert.equal(eng.recordFog('f-units', { reveals: 2, done: true }).grade, 'shaky', '2 of 4 steps');
});

test('level 2 drills report through recordDrill and move push the same way', () => {
  const { eng } = make();
  assert.equal(eng.pushLevel('nt-divisibility'), 2);
  const r = eng.recordDrill('nt-divisibility', 'failed');
  assert.deepEqual([r.stageAfter, r.pushBefore, r.pushAfter], [0, 2, 1]);
});

/* -------------------------------------------- stretch picks, ease-off, reach */

test('target(): stretch E 0.65 and its band, hidden d = target - 1, reach E 0.40', () => {
  const { eng } = make();
  const t = eng.target('nt');
  close(t.d, 3 + OFF65, 1e-12);
  close(t.E, 0.65, 1e-12);
  close(t.band.lo, 3 + OFF70, 1e-12);
  close(t.band.hi, 3 + OFF60, 1e-12);
  const h = eng.target('cp', { hidden: true });
  close(h.d, 4 + OFF65 - 1, 1e-12);
  close(h.E, 0.85449892317165, 1e-12);
  const rc = eng.target('nt', { reach: true });
  close(rc.d, 3 + OFF40, 1e-12);
  close(rc.E, 0.40, 1e-12);
});

test('regular slots pick the problems nearest the stretch target', () => {
  const { eng } = make();
  const plan = eng.todayPlan();
  assert.deepEqual(ids(plan.problems), ['nt-a', 'nt-b', 'nt-c']);
  assert.ok(plan.problems.every(p => !p.hidden && !p.reach && !p.eased));
  close(plan.problems[0].E, Ex(2.5, 3), 1e-12);
  assert.equal(plan.problems[0].inBand, true);
  assert.equal(plan.problems[0].topic, 'number theory & algebra');
  assert.equal(eng.pickProblem('nt').id, 'nt-a');
  assert.equal(eng.pickProblem('nt', { exclude: ['nt-a'] }).id, 'nt-b');
});

test('ease-off: after 2 misses in a row (missed, blind) the next pick is d - 1; a hold ends it', () => {
  const { eng } = make();
  let s = eng.settleProblem('nt-a', { verdict: 'missed', called: [], took: ['m-crt'] });
  close(s.rAfter, 3 - 0.6 * Ex(2.5, 3), 1e-12);
  assert.equal(eng.target('nt').eased, false, 'one miss is not enough');
  s = eng.settleProblem('nt-b', { verdict: 'blind', called: [], took: ['m-order'] });
  const r2 = (3 - 0.6 * Ex(2.5, 3)) - 0.6 * Ex(2.0, 3 - 0.6 * Ex(2.5, 3));
  close(eng.rating('nt'), r2, 1e-12);
  const t = eng.target('nt');
  assert.equal(t.eased, true);
  close(t.d, r2 + OFF65 - 1, 1e-12);
  const plan = eng.todayPlan();
  assert.deepEqual(ids(plan.problems), ['nt-f', 'nt-h', 'nt-e'], 'nearest the eased target');
  assert.ok(plan.problems.every(p => p.eased));
  assert.equal(plan.slots.nt.filled, 3);
  eng.settleProblem('nt-f', { verdict: 'held', called: ['m-crt'], took: ['m-crt'] });
  assert.equal(eng.target('nt').eased, false);
  assert.deepEqual(eng.streaks('nt'), { miss: 0, clean: 1 });
});

test('reach: after 3 clean holds one reach problem at E 0.40; it is spent once settled', () => {
  const { eng } = make();
  eng.settleProblem('nt-a', { verdict: 'held', called: ['m-crt'], took: ['m-crt'] });
  eng.settleProblem('nt-b', { verdict: 'held', called: ['m-order'], took: ['m-order'] });
  assert.equal(eng.todayPlan().problems.filter(p => p.reach).length, 0, 'two holds: no reach yet');
  eng.settleProblem('nt-c', { verdict: 'held', called: ['m-bezout'], took: ['m-bezout'] });
  let r = 3;
  for (const d of [2.5, 2.0, 3.0]) r = r + 0.6 * (1 - Ex(d, r));
  close(eng.rating('nt'), r, 1e-12);
  const plan = eng.todayPlan();
  const reach = plan.problems.filter(p => p.reach);
  assert.equal(reach.length, 1, 'exactly one reach');
  assert.equal(reach[0].slot, 0);
  assert.equal(reach[0].id, 'nt-d');
  close(reach[0].target, r + OFF40, 1e-12);
  close(reach[0].targetE, 0.40, 1e-12);
  assert.deepEqual(ids(plan.problems), ['nt-d', 'nt-e', 'nt-h']);
  const s = eng.settleProblem('nt-d', { verdict: 'held', called: ['m-order'], took: ['m-order'] });
  assert.equal(s.reach, true, 'inferred from the plan');
  assert.deepEqual(eng.streaks('nt'), { miss: 0, clean: 0 }, 'the reach is spent');
  assert.equal(eng.todayPlan().problems.filter(p => p.reach).length, 0);
});

test('held after help scores 0.75 and breaks both streaks; moot changes nothing', () => {
  const { eng } = make();
  const s = eng.settleProblem('nt-a', { verdict: 'held', help: true, called: ['m-crt'], took: ['m-crt'] });
  assert.equal(s.score, 0.75);
  close(s.rAfter, 3 + 0.6 * (0.75 - Ex(2.5, 3)), 1e-12);
  assert.deepEqual(eng.streaks('nt'), { miss: 0, clean: 0 });
  const m = eng.settleProblem('nt-b', { verdict: 'moot', called: [], took: ['m-order'] });
  assert.equal(m.score, null);
  assert.equal(m.rAfter, m.rBefore);
  assert.equal(m.methodHit, null);
  assert.equal(eng.history('nt').length, 2, 'moot adds no rating point');
  const again = eng.settleProblem('nt-a', { verdict: 'missed' });
  assert.equal(again.already, true);
  close(eng.rating('nt'), s.rAfter, 1e-12, 'settling twice does not re-rate');
  assert.equal(eng.settleProblem('nt-c', {}), null, 'no settle verb: nothing recorded');
  assert.equal(eng.settled('nt-c'), null);
  const g = eng.settleProblem('nt-c', { verdict: 'gave up' });
  assert.deepEqual([g.verdict, g.score, g.help], ['missed', 0, true]);
});

test('a difficulty written as a numeric string still rates and picks', () => {
  const content = fixture();
  content.problems.find(p => p.id === 'nt-a').d = '2.5';
  const { eng } = make({ content });
  assert.equal(eng.todayPlan().problems[0].id, 'nt-a');
  close(eng.settleProblem('nt-a', { verdict: 'held' }).E, Ex(2.5, 3), 1e-12);
});

/* ---------------------------------------------------------- hidden topics */

test('push mode: one in three problem slots is hidden-topic, from another practised area or general reasoning, with no topic shown', () => {
  const { eng } = make();
  let plan = eng.todayPlan();
  assert.equal(plan.slots.nt.hidden, 0);
  assert.ok(plan.problems.every(p => !p.hidden));
  const mc = eng.makeComfortable('nt');
  assert.equal(mc.push, true);
  assert.equal(eng.inPush('nt'), true);
  plan = eng.todayPlan();
  assert.equal(plan.push.nt, true);
  assert.equal(plan.push.dd, false);
  assert.equal(plan.problems.length, 3);
  assert.deepEqual(plan.problems.map(p => p.hidden), [false, false, true]);
  assert.equal(plan.slots.nt.hidden / plan.slots.nt.total, 1 / 3);
  const h = plan.problems[2];
  assert.equal(h.id, 'gr-a', 'cp, an and lg have no basics and nothing settled: only general reasoning is open (nt-h is hiddenOK but nt)');
  assert.notEqual(h.problem.area, 'nt');
  assert.equal(h.problem.hiddenOK, true);
  assert.equal(h.topic, null);
  assert.doesNotMatch(h.why, /number|combinat|probab|analysis|algebra|geometry|digital|reasoning|\bnt\b|\bgr\b/i);
  close(h.target, eng.target('gr').d - 1, 1e-12);
  close(h.target, 4 + OFF65 - 1, 1e-12);
  close(h.targetE, 0.85449892317165, 1e-12);
  close(h.E, Ex(2.4, 4), 1e-12);
  assert.deepEqual(ids(plan.problems.slice(0, 2)), ['nt-a', 'nt-b']);
  assert.ok(plan.katas.every(k => !k.hidden), 'dd is not in push mode');
});

test('hidden picks come from practised areas or general reasoning only, never the slot\'s own area; the share stays 1/3', () => {
  const { eng } = make();
  eng.makeComfortable('nt');
  for (let i = 0; i < 3; i++) {
    const plan = eng.todayPlan();
    assert.equal(plan.problems.filter(p => p.hidden).length, 1);
    assert.equal(plan.problems.length, 3);
    eng.advanceDays(1);
  }
  assert.deepEqual(['nt', 'dd', 'gr', 'cp', 'an', 'lg'].map(a => eng.practised(a)), [true, true, true, false, false, false]);
  assert.equal(eng.pickProblem('nt', { hidden: true }).id, 'gr-a', 'cp-a and an-a are hiddenOK, but their areas are not practised');
  eng.settleProblem('gr-a', { verdict: 'held', called: [], took: ['m-invariant'] });
  assert.equal(eng.pickProblem('nt', { hidden: true }), null, 'nothing practised is left: no hidden pick rather than an unpractised area');
  eng.settleProblem('cp-b', { verdict: 'held', called: [], took: ['m-pigeonhole'] });
  assert.equal(eng.practised('cp'), true, 'a counted settle makes an area practised');
  assert.equal(eng.pickProblem('nt', { hidden: true }).id, 'cp-a');
  eng.settleProblem('cp-a', { verdict: 'missed', called: [], took: ['m-pigeonhole'] });
  assert.equal(eng.pickProblem('nt', { hidden: true }), null, 'an-a stays out (an unpractised); nt-h is the slot\'s own area');
});

test('katas: simple outside push; in push a harder kata comes first only within reach (E >= 0.40); one in three is hidden', () => {
  const { eng } = make();
  let plan = eng.todayPlan();
  assert.deepEqual(ids(plan.katas), ['k-crc', 'k-lfsr', 'k-shift']);
  assert.ok(plan.katas.every(k => !k.hidden && k.level === 'simple'));
  eng.makeComfortable('dd');
  assert.equal(eng.inPush('dd'), true);
  plan = eng.todayPlan();
  close(Ex(5, 4), 0.24025307335204213, 1e-9, 'k-uart at r 4');
  assert.deepEqual(ids(plan.katas), ['k-crc', 'k-lfsr', 'k-badframe'], 'k-uart (E 0.24) is out of reach: nearest the stretch target instead');
  assert.deepEqual(plan.katas.map(k => k.hidden), [false, false, true]);
  assert.equal(plan.slots.dd.hidden / plan.slots.dd.total, 1 / 3);
  const h = plan.katas[2];
  assert.equal(h.topic, null);
  assert.doesNotMatch(h.why, /crc|checksum|polynomial|digital/i);
  eng.simulateHolds('dd', 5);
  eng.simulateMisses('dd', 1);           // r 4.66, and the clean run that would open a reach slot is broken
  assert.ok(Ex(5, eng.rating('dd')) >= 0.40);
  plan = eng.todayPlan();
  assert.equal(plan.katas[0].id, 'k-uart', 'within reach: the harder kata comes first');
  assert.equal(plan.katas[0].level, 'hard');
  assert.equal(plan.katas[0].reach, false);
});

test('ease-off never makes a pick harder: eased picks keep to d <= the plain target while any remain', () => {
  const { eng } = make();
  for (const id of ['nt-b', 'nt-e', 'nt-f', 'nt-h']) eng.settleProblem(id, { verdict: 'moot' });   // the bank keeps only d >= 2.5
  eng.simulateMisses('nt', 2);
  const t = eng.target('nt');
  assert.equal(t.eased, true);
  const plan = eng.todayPlan();
  assert.deepEqual(ids(plan.problems), ['nt-a', 'nt-c', 'nt-d']);
  assert.ok(plan.problems.every(p => !p.eased && p.easeShort), 'nothing at or below the plain target is left: not labelled eased');
  assert.match(plan.problems[0].why, /nothing easier is left in the bank/);
  const { eng: e2 } = make();
  e2.simulateMisses('nt', 2);
  const p2 = e2.todayPlan().problems;
  assert.ok(p2.every(p => p.eased && !p.easeShort && p.d <= e2.target('nt').base + 1e-9), 'with easier problems left, every pick is eased and at or below the plain target');
  assert.match(p2[0].why, /^Eased one step/);
});

test('ease-off with the page\'s problem bank: after two misses in number theory every pick is easier than the band', () => {
  const content = loadContent();
  const { eng } = make({ content });
  eng.simulateMisses('nt', 2);
  let plan = eng.todayPlan();
  assert.equal(plan.problems.length, 3);
  assert.ok(plan.problems.every(p => p.eased && p.E > 0.70), JSON.stringify(plan.problems.map(p => [p.id, p.d, p.E])));
  // real settles from the seeded start: miss the first two picks, then the next picks are eased too
  const { eng: e2 } = make({ content: loadContent() });
  for (let i = 0; i < 2; i++) {
    const pick = e2.todayPlan().problems[0];
    assert.ok(pick.E >= 0.55, 'a stretch pick, not a discouraging one: ' + pick.id + ' E ' + pick.E);
    e2.settleProblem(pick.id, { verdict: 'missed', called: [], took: pick.problem.methods });
  }
  plan = e2.todayPlan();
  assert.ok(plan.problems.every(p => p.eased && p.E >= 0.65), JSON.stringify(plan.problems.map(p => [p.id, p.d, p.E])));
  e2.settleProblem(plan.problems[0].id, { verdict: 'held', called: plan.problems[0].problem.methods, took: plan.problems[0].problem.methods });
  plan = e2.todayPlan();
  assert.ok(plan.problems.filter(p => p.inBand).length >= 2, 'after a hold the band is stocked again: ' + JSON.stringify(plan.problems.map(p => [p.id, p.E])));
});

/* ------------------------------------------- method identification, settle */

test('method identification: hits, misses, recognition gaps logged to the topic doc, links back', () => {
  const { eng } = make();
  let s = eng.settleProblem('nt-c', { verdict: 'held', called: ['m-bezout'], took: ['m-bezout'], confidence: 70, ms: 540000 });
  assert.equal(s.methodHit, true);
  assert.equal(s.recognitionGap, null);
  close(s.E, 0.5, 1e-12);
  close(s.rAfter, 3.3, 1e-12);
  assert.deepEqual([s.confidence, s.ms], [70, 540000], 'the confidence chip and time are kept');
  assert.equal(eng.settled('nt-c').confidence, 70);
  s = eng.settleProblem('nt-a', { verdict: 'missed', called: ['m-order'], took: ['m-crt'] });
  assert.equal(s.methodHit, false);
  assert.equal(s.recognitionGap, null, 'nt-crt is at stage 2: not a recognition gap');
  assert.deepEqual(s.linksBack, ['nt-crt'], 'a miss links back to the basics it used');
  assert.deepEqual(s.extra, ['m-order']);
  s = eng.settleProblem('nt-e', { verdict: 'held', called: [], took: ['m-bezout'] });
  assert.equal(s.methodHit, false, 'held, but the call did not name the method');
  assert.ok(s.recognitionGap);
  assert.equal(s.recognitionGap.doc, 'nt-moves');
  assert.equal(s.recognitionGap.methods[0].method, 'm-bezout');
  assert.equal(s.recognitionGap.methods[0].basic, 'nt-divisibility');
  const rec = eng.recognise('nt-moves');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].kind, 'recognise');
  assert.match(rec[0].text, /Bézout/);
  assert.deepEqual(eng.methodAccuracy('nt'), { hits: 1, total: 3, rate: 1 / 3 });
  eng.settleProblem('nt-f', { verdict: 'moot', called: [], took: ['m-crt'] });
  assert.equal(eng.methodAccuracy('nt').total, 3, 'moot is not counted');
  assert.deepEqual(eng.solveRate('nt'), { held: 2, clean: 2, total: 3 }, 'solve rate is tracked separately: 2 of 3 held, method 1 of 3');
});

test('two-step settle: verdict first (method ticks pending), ticks later update without re-rating', () => {
  const { eng } = make();
  const s = eng.settleProblem('nt-e', { verdict: 'held' });
  assert.equal(s.methodsPending, true);
  assert.equal(s.methodHit, null);
  assert.deepEqual(eng.methodAccuracy('nt'), { hits: 0, total: 0, rate: null }, 'nothing counted before the ticks');
  const u = eng.settleProblem('nt-e', { called: [], took: ['m-bezout'] });
  assert.deepEqual([u.already, u.updated, u.methodsPending, u.methodHit], [true, true, false, false]);
  assert.equal(u.recognitionGap.doc, 'nt-moves');
  close(eng.rating('nt'), s.rAfter, 1e-12, 'no second rating update');
  assert.deepEqual(eng.methodAccuracy('nt'), { hits: 0, total: 1, rate: 0 });
  const u2 = eng.settleProblem('nt-e', { called: ['m-bezout'], took: ['m-bezout'] });
  assert.equal(u2.methodHit, true, 'corrected ticks replace the entry');
  assert.deepEqual(eng.methodAccuracy('nt'), { hits: 1, total: 1, rate: 1 });
  assert.equal(eng.recognise('nt-moves').length, 1, 'a cue is logged once per item and method');
  assert.equal(eng.settled('nt-e').methodHit, true);
  const k = eng.settleKata('k-crc', { pass: true, runs: 1 });
  assert.equal(k.methodsPending, true);
  assert.equal(eng.settleKata('k-crc', { called: ['d-crc'] }).methodHit, true, 'took defaults to the kata\'s methods');
});

test('a general method with no basic of its own is counted as missed but is never a recognition gap', () => {
  const { eng } = make();
  let s = eng.settleProblem('lg-x', { verdict: 'missed', called: [], took: ['m-invariant'] });
  assert.equal(s.recognitionGap, null);
  s = eng.settleProblem('lg-y', { verdict: 'missed', called: [], took: ['m-invariant'] });
  assert.equal(s.recognitionGap, null, 'lg-y rests on nt-divisibility (stage 3), but invariants are not taught by it');
  assert.deepEqual(s.linksBack, ['nt-divisibility'], 'links back to what the problem rests on');
  assert.deepEqual(eng.methodAccuracy('lg'), { hits: 0, total: 2, rate: 0 });
  assert.deepEqual(eng.methodAccuracy(null), { hits: 0, total: 2, rate: 0 });
  assert.equal(eng.recognise('nt-moves').length, 0);
});

test('settleKata: first-run pass 1, pass after failures 0.75, gave up 0; design-method gaps go to dd-framing', () => {
  const { eng } = make();
  let s = eng.settleKata('k-crc', { pass: true, runs: 1, called: ['d-crc'], took: ['d-crc'] });
  assert.equal(s.score, 1);
  close(s.E, 0.6400649998028851, 1e-12);
  close(s.rAfter, 4.215961000118269, 1e-12);
  assert.equal(s.methodHit, true);
  assert.deepEqual(s.linksBack, ['dd-crc']);
  const r1 = s.rAfter;
  s = eng.settleKata('k-badframe', { pass: true, runs: 2, called: ['d-fsm'], took: ['d-crc'] });
  assert.equal(s.score, 0.75);
  close(s.rAfter, r1 + 0.6 * (0.75 - Ex(4.5, r1)), 1e-12);
  assert.equal(s.hidden, true);
  assert.equal(s.recognitionGap.doc, 'dd-framing');
  assert.equal(eng.recognise('dd-framing').length, 1);
  s = eng.settleKata('k-shift', { pass: false, gaveUp: true, runs: 2 });
  assert.equal(s.score, 0);
  assert.equal(s.verdict, 'gave up');
  assert.deepEqual(eng.streaks('dd'), { miss: 1, clean: 0 });
  assert.ok(!ids(eng.todayPlan().katas).includes('k-crc'), 'settled katas leave the plan');
  assert.equal(eng.settleKata('k-crc', { pass: false }).already, true);
});

/* ------------------------------------------------------------------ triage */

test('passage basics: links, fog and kata blocks; problem hooks never leak their basics', () => {
  const { eng } = make();
  assert.deepEqual(eng.passageBasics('nt-moves', 's1'), ['nt-units', 'nt-crt', 'nt-divisibility'], 'a heading runs to the next heading');
  assert.deepEqual(eng.passageBasics('nt-moves', 'p-crt'), ['nt-crt', 'nt-divisibility']);
  assert.deepEqual(eng.passageBasics('nt-moves', 'p-hook'), ['nt-divisibility'], 'hook problem nt-a rests on nt-crt; not named');
  assert.deepEqual(eng.passageBasics('nt-crt', 'crt'), ['nt-units'], 'its own fog block is not a link');
  assert.deepEqual(eng.passageBasics('dd-framing', 'f-kata'), ['dd-crc']);
  assert.deepEqual(eng.passageBasics('dd-framing', 'f-hidden'), ['dd-crc', 'dd-lfsr'], 'a hidden kata is not used; falls back to needs');
  assert.deepEqual(eng.passageBasics('nt-moves', 'p-plain', ['dd-lfsr#lfsr']), ['dd-lfsr'], 'links from the reader');
});

test('a lost mark on a passage that links no basic is rationed, never rebuilt through the doc\'s needs', () => {
  const { eng } = make();
  assert.equal(eng.weak('nt-units'), true, 'nt-units is weak (stage 1), and nt-moves needs it');
  assert.deepEqual(eng.linkedBasics('nt-moves', 'p-plain'), []);
  assert.deepEqual(eng.passageBasics('nt-moves', 'p-plain'), ['nt-divisibility', 'nt-units', 'nt-crt'], 'the scaffold still shows what the doc rests on');
  const r = eng.triage({ docId: 'nt-moves', anchor: 'p-plain', verb: 'lost' });
  assert.equal(r.action, 'scaffold');
  assert.deepEqual(r.basics, ['nt-divisibility', 'nt-units', 'nt-crt']);
  assert.equal(eng.changes('nt-moves').length, 0, 'no rebuild logged');
  assert.equal(eng.docVersion('nt-units'), 1);
  // a failed drill makes dd-crc weak; a framing passage whose only block is a hidden kata links no basic
  eng.recordDrill('dd-crc', 'failed');
  assert.equal(eng.triage({ docId: 'dd-framing', anchor: 'f-hidden', verb: 'lost' }).action, 'scaffold');
  assert.equal(eng.triage({ docId: 'dd-framing', anchor: 'f-crc', verb: 'lost' }).action, 'rebuild-basic', 'a passage that links the weak basic still rebuilds it');
});

test('a recheck after a first lost mark reads as the scaffold, not as a second mark; easy ends the cycle', () => {
  const { eng } = make();
  eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost' });
  const r = eng.recheck('nt-moves', 'p-crt', 1);
  assert.equal(r.action, 'scaffold');
  assert.doesNotMatch(r.reason, /Still lost/);
  assert.match(r.reason, /^Not a gap in a basic/);
  const again = eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost', attemptStrokes: 1 });
  assert.match(again.reason, /^Still lost/);
  eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'easy' });
  eng.advanceDays(1);
  const fresh = eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost' });
  assert.equal(fresh.action, 'scaffold');
  assert.equal(fresh.since, NOW + DAY, 'a new lost mark after easy starts a new cycle');
  assert.equal(fresh.eligibleAt, NOW + 2 * DAY);
});

test('after the last rewrite on a doc, a recheck turns its other eligible marks into the drill instead', () => {
  const { eng } = make();
  const anchors = ['p-crt', 'p-div', 'p-mix', 'p-last'];
  for (const a of anchors) eng.triage({ docId: 'nt-moves', anchor: a, verb: 'lost' });
  eng.advanceDays(1);
  for (const a of anchors) assert.equal(eng.recheck('nt-moves', a, 1).action, 'eligible', a);
  assert.match(eng.recheck('nt-moves', 'p-last', 1).reason, /3 of 3 left/);
  eng.requestRewrite('nt-moves', 'p-crt');
  assert.match(eng.recheck('nt-moves', 'p-last', 1).reason, /2 of 3 left/, 'the reason follows the budget');
  eng.requestRewrite('nt-moves', 'p-div');
  eng.requestRewrite('nt-moves', 'p-mix');
  const r = eng.recheck('nt-moves', 'p-last', 1);
  assert.equal(r.action, 'budget-exhausted');
  assert.equal(r.drill, 'nt-divisibility');
  assert.equal(eng.requestRewrite('nt-moves', 'p-last').ok, false);
});

test('push level 3: a theorem is a problem-first item; settling grades its basic like a drill and leaves the rating', () => {
  const { eng } = make();
  const p = eng.problem('thm:f-bezout#1');
  assert.equal(p.kind, 'theorem');
  assert.deepEqual([p.fogId, p.attempt, p.basic, p.area, p.d, p.hiddenOK], ['f-bezout', 1, 'nt-divisibility', 'nt', X.CONSTANTS.THEOREM_D, false]);
  assert.match(p.solution, /Step 1 · topic 0\.<\/b> step 0/);
  assert.equal(eng.problem('thm:nope#1'), null);
  assert.ok(!eng.todayPlan().problems.some(x => /^thm:/.test(x.id)), 'never in Today\'s slots');
  const r0 = eng.rating('nt'), s0 = eng.stage('nt-divisibility');
  let s = eng.settleProblem('thm:f-bezout#1', { verdict: 'held', called: ['m-bezout'], took: ['m-bezout'], confidence: 80 });
  assert.equal(s.kind, 'theorem');
  assert.equal(s.grade, 'clean');
  assert.deepEqual([s.drill.stageBefore, s.drill.stageAfter], [s0, s0 + 1]);
  assert.equal(s.methodHit, true);
  assert.equal(eng.rating('nt'), r0, 'the rating does not move');
  assert.deepEqual(eng.streaks('nt'), { miss: 0, clean: 0 }, 'nor the stretch streaks');
  assert.equal(eng.lastDrill('nt-divisibility').src, 'hook');
  assert.deepEqual(eng.solveRate('nt'), { held: 0, clean: 0, total: 0 }, 'not counted as a solved problem');
  assert.deepEqual(eng.methodAccuracy(null, { kind: 'theorem' }), { hits: 1, total: 1, rate: 1 });
  assert.equal(eng.settled('thm:f-bezout#1').grade, 'clean');
  assert.equal(eng.settledAll()[0].kind, 'theorem');
  assert.equal(eng.settleProblem('thm:f-bezout#1', { verdict: 'missed' }).already, true, 'one settle per attempt');
  eng.makeComfortable('nt');
  assert.equal(eng.pushLevel('nt-crt'), 3);
  s = eng.settleProblem('thm:f-crt#2', { verdict: 'blind', called: [], took: ['m-crt'] });
  assert.deepEqual([s.grade, s.drill.stageAfter, s.drill.pushBefore, s.drill.pushAfter], ['failed', 0, 3, 2], 'a miss fails the basic and drops one push level');
  assert.equal(s.methodHit, false);
  assert.equal(s.recognitionGap.doc, 'nt-moves', 'known when calling (stage 4), not called: a recognition gap');
  s = eng.settleProblem('thm:f-units#1', { verdict: 'held', help: true, called: [], took: [] });
  assert.equal(s.grade, 'shaky');
  const m = eng.settleProblem('thm:f-units#2', { verdict: 'moot' });
  assert.deepEqual([m.grade, m.drill], [null, null]);
});

test('lost on a basic with a rebuilt version: rebuild-basic, budget-free; the reader switches and logs', () => {
  const { eng } = make();
  const r = eng.triage({ docId: 'nt-units', anchor: 'u-p2', verb: 'lost', attemptStrokes: 0 });
  assert.equal(r.action, 'rebuild-basic');
  assert.equal(r.status, 'rebuilt');
  assert.deepEqual(r.basics, ['nt-units']);
  assert.deepEqual(r.versions, { 'nt-units': 2 }, 'the build to switch to');
  assert.deepEqual(r.queued, []);
  assert.equal(eng.docVersion('nt-units'), 1, 'the engine decides; the reader switches the build');
  assert.equal(eng.changes('nt-units').length, 0, 'the reader writes the basic\'s Changes entry');
  eng.setDocVersion('nt-units', 2); // what reader.js does on rebuild-basic
  assert.equal(eng.docVersion('nt-units'), 2);
  assert.equal(eng.changes('nt-units').length, 0, 'setDocVersion does not log over the reader\'s entry');
  assert.deepEqual(eng.budget('nt-units'), { used: 0, max: 3, left: 3 });
  const again = eng.triage({ docId: 'nt-units', anchor: 'u-p1', verb: 'lost' });
  assert.equal(again.action, 'scaffold', 'already rebuilt: rationed like any passage');
  assert.deepEqual(again.basics, ['nt-divisibility']);
});

test('a basic is rebuilt once even if no build switch follows; then it is rationed', () => {
  const { eng } = make();
  assert.equal(eng.triage({ docId: 'nt-units', anchor: 'u-p2', verb: 'lost' }).action, 'rebuild-basic');
  assert.equal(eng.triage({ docId: 'nt-units', anchor: 'u-p1', verb: 'lost' }).action, 'scaffold');
});

test('lost on a topic passage resting on a weak basic (stage <= 1) rebuilds that basic, not the passage', () => {
  const { eng } = make();
  const r = eng.triage({ docId: 'nt-moves', anchor: 'p-units', verb: 'lost' });
  assert.equal(r.action, 'rebuild-basic');
  assert.deepEqual(r.basics, ['nt-units']);
  assert.deepEqual(r.versions, { 'nt-units': 2 });
  assert.equal(eng.budget('nt-moves').used, 0);
  const ch = eng.changes('nt-moves');
  assert.equal(ch.length, 1);
  assert.equal(ch[0].kind, 'rebuild');
  assert.match(ch[0].text, /Lost at #p-units: the gap is in Units mod n/);
  assert.equal(eng.changes('nt-units').length, 0);
  assert.equal(eng.mark('nt-moves', 'p-units').status, 'rebuilt');
  const again = eng.triage({ docId: 'nt-moves', anchor: 'p-units', verb: 'lost' });
  assert.equal(again.action, 'scaffold');
});

test('a basic whose last drill failed counts as weak; with no rebuilt version the rebuild is queued', () => {
  const { eng } = make();
  eng.recordDrill('dd-crc', 'failed');
  eng.setStage('dd-crc', 3);
  assert.equal(eng.weak('dd-crc'), true);
  const r = eng.triage({ docId: 'dd-framing', anchor: 'f-crc', verb: 'lost' });
  assert.equal(r.action, 'rebuild-basic');
  assert.deepEqual(r.queued, ['dd-crc']);
  assert.deepEqual(r.versions, {});
  assert.match(r.reason, /last drill failed/);
  assert.match(r.reason, /queued for the teach pass/);
  assert.equal(eng.docVersion('dd-crc'), 1);
  assert.match(eng.changes('dd-framing')[0].text, /CRC as polynomial division/);
  assert.equal(eng.triage({ docId: 'dd-framing', anchor: 'f-crc', verb: 'lost' }).action, 'scaffold');
});

test('rationing: scaffold, then eligible only after 24 h of simulated time with ink in the attempt box', () => {
  const { eng } = make();
  let r = eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost', attemptStrokes: 0 });
  assert.equal(r.action, 'scaffold');
  assert.deepEqual(r.basics, ['nt-crt', 'nt-divisibility']);
  assert.equal(r.eligibleAt, NOW + DAY);
  assert.equal(eng.mark('nt-moves', 'p-crt').status, 'struggling');
  r = eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost', attemptStrokes: 5 });
  assert.equal(r.action, 'scaffold', 'ink, but not a day yet');
  assert.equal(r.eligibleAt, NOW + DAY, 'the clock does not restart');
  assert.deepEqual(eng.requestRewrite('nt-moves', 'p-crt'), { ok: false, reason: 'not-eligible', used: 0, max: 3, left: 3 });
  eng.advanceDays(1);
  r = eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost', attemptStrokes: 0 });
  assert.equal(r.action, 'scaffold', 'a day, but the box is empty');
  assert.match(r.reason, /attempt/);
  r = eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost', attemptStrokes: 4 });
  assert.equal(r.action, 'eligible');
  assert.equal(r.left, 3);
  const w = eng.requestRewrite('nt-moves', 'p-crt');
  assert.deepEqual(w, { ok: true, used: 1, max: 3, left: 2, html: '<p data-a="p-crt">Rewritten passage.</p>' });
  assert.equal(eng.mark('nt-moves', 'p-crt').status, 'rewritten');
  assert.equal(eng.rewriteOf('nt-moves', 'p-crt'), '<p data-a="p-crt">Rewritten passage.</p>');
  assert.deepEqual(eng.rewritten('nt-moves'), ['p-crt']);
  const last = eng.changes('nt-moves').at(-1);
  assert.equal(last.kind, 'rewrite');
  assert.match(last.text, /1 of 3 rewrites used/);
  assert.equal(eng.requestRewrite('nt-moves', 'p-crt').ok, false, 'one rewrite per eligibility');
});

test('recheck re-evaluates a mark for re-renders and clock moves, and never starts a new cycle', () => {
  const { eng } = make();
  assert.equal(eng.recheck('nt-moves', 'p-crt', 0), null, 'no mark yet');
  eng.triage({ docId: 'nt-moves', anchor: 'p-units', verb: 'lost' });            // rebuilds nt-units
  const nChanges = eng.changes('nt-units').length;
  let r = eng.recheck('nt-moves', 'p-units', 9);
  assert.deepEqual([r.action, r.status, r.done], ['rebuild-basic', 'rebuilt', true]);
  assert.equal(eng.mark('nt-moves', 'p-units').status, 'rebuilt', 'recheck does not restart a struggle');
  assert.equal(eng.changes('nt-units').length, nChanges, 'and logs nothing new');
  eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost' });
  r = eng.recheck('nt-moves', 'p-crt', 3);
  assert.deepEqual([r.action, r.status, r.eligibleAt], ['scaffold', 'struggling', NOW + DAY]);
  eng.advanceDays(1);
  r = eng.recheck('nt-moves', 'p-crt', 3);
  assert.deepEqual([r.action, r.status, r.since], ['eligible', 'eligible', NOW]);
  eng.requestRewrite('nt-moves', 'p-crt');
  r = eng.recheck('nt-moves', 'p-crt');
  assert.deepEqual([r.action, r.status, r.html], ['noted', 'rewritten', '<p data-a="p-crt">Rewritten passage.</p>']);
  assert.equal(eng.budget('nt-moves').used, 1);
});

test('eligibility boundary: 23 h 59 min is not enough, exactly 24 h is', () => {
  const { eng, setReal } = make();
  eng.triage({ docId: 'nt-moves', anchor: 'p-div', verb: 'lost' });
  setReal(NOW + DAY - 60000);
  assert.equal(eng.triage({ docId: 'nt-moves', anchor: 'p-div', verb: 'lost', attemptStrokes: 3 }).action, 'scaffold');
  setReal(NOW + DAY);
  assert.equal(eng.triage({ docId: 'nt-moves', anchor: 'p-div', verb: 'lost', attemptStrokes: 3 }).action, 'eligible');
});

test('budget: 3 rewrites per doc, then no rewrite and a drill on the linked basic instead', () => {
  const { eng } = make();
  const anchors = ['p-crt', 'p-div', 'p-mix', 'p-last'];
  for (const a of anchors) assert.equal(eng.triage({ docId: 'nt-moves', anchor: a, verb: 'lost' }).action, 'scaffold');
  eng.advanceDays(1);
  for (const a of anchors.slice(0, 3)) {
    assert.equal(eng.triage({ docId: 'nt-moves', anchor: a, verb: 'lost', attemptStrokes: 2 }).action, 'eligible', a);
    assert.equal(eng.requestRewrite('nt-moves', a).ok, true, a);
  }
  assert.deepEqual(eng.budget('nt-moves'), { used: 3, max: 3, left: 0 });
  assert.equal(eng.due('nt-divisibility'), '2026-11-17');
  const r = eng.triage({ docId: 'nt-moves', anchor: 'p-last', verb: 'lost', attemptStrokes: 2 });
  assert.equal(r.action, 'budget-exhausted');
  assert.equal(r.drill, 'nt-divisibility');
  assert.equal(eng.due('nt-divisibility'), '2026-11-16', 'the drill is pulled forward to today');
  assert.deepEqual(eng.requestRewrite('nt-moves', 'p-last'), { ok: false, reason: 'budget', used: 3, max: 3, left: 0 });
  assert.equal(eng.changes('nt-moves').filter(c => c.kind === 'rewrite').length, 3);
  assert.match(eng.changes('nt-moves').filter(c => c.kind === 'rewrite')[2].text, /Queued for the teach pass/, 'p-mix has no demo rewrite');
  assert.equal(eng.budget('nt-units').used, 0, 'budgets are per doc');
});

test('easy and forgot are noted; forgot pulls the drills the passage rests on forward', () => {
  const { eng } = make();
  assert.equal(eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'easy' }).action, 'noted');
  assert.equal(eng.mark('nt-moves', 'p-crt').verb, 'easy');
  const r = eng.triage({ docId: 'nt-moves', anchor: 'p-div', verb: 'forgot' });
  assert.equal(r.action, 'noted');
  assert.match(r.reason, /Divisibility and Bézout/);
  assert.equal(eng.due('nt-divisibility'), '2026-11-15');
  assert.equal(eng.clearMark('nt-moves', 'p-div'), true);
  assert.equal(eng.mark('nt-moves', 'p-div'), null);
  assert.equal(eng.triage({ docId: 'nope', anchor: 'x', verb: 'lost' }).action, 'noted');
});

test('setDocVersion switches quietly; logChange feeds the Changes panel', () => {
  const { eng, bus } = make();
  eng.setDocVersion('nt-units', 2);
  eng.logChange('nt-moves', 'Kept ink on the rewritten passage.');
  assert.equal(eng.docVersion('nt-units'), 2);
  assert.equal(eng.changes('nt-units').length, 0);
  assert.ok(bus.events.some(([e, d]) => e === 'engine:change' && d.type === 'version' && d.docId === 'nt-units' && d.version === 2));
  assert.deepEqual(eng.changes('nt-moves').map(c => [c.kind, c.text, c.day]), [['note', 'Kept ink on the rewritten passage.', '2026-11-15']]);
  assert.equal(eng.changes('nt-moves')[0].t, NOW);
});

/* --------------------------------------------------------------- blockers */

test('blockers: open tasks whose basics are weak, with the date each can reach stage 3', () => {
  const { eng } = make();
  let b = eng.blockers();
  assert.equal(b.length, 1);
  assert.equal(b[0].task.id, 't2');
  assert.deepEqual(b[0].weakBasics, ['nt-units', 'nt-crt']);
  assert.deepEqual(b[0].detail.map(d => [d.basic, d.reachBy, d.atRisk]), [['nt-units', '2026-11-18', false], ['nt-crt', '2026-11-15', false]]);
  eng.makeComfortable('nt');
  assert.equal(eng.blockers().length, 0);

  const content = fixture();
  content.pmTasks.push({ id: 't4', text: 'Putnam: warm-up set', project: 'putnam', due: '2026-11-16', needs: ['nt-units'], status: 'open' });
  const m2 = make({ content });
  m2.eng.setStage('nt-units', 0);
  b = m2.eng.blockers();
  assert.deepEqual(b.map(x => x.task.id), ['t4', 't2'], 'sorted by due date');
  assert.deepEqual([b[0].detail[0].reachBy, b[0].detail[0].atRisk, b[0].atRisk], ['2026-11-17', true, true]);
});

/* ------------------------------------------------- demo helpers and storage */

test('simulateMisses lowers r at E 0.65 per miss and turns on the ease-off', () => {
  const { eng } = make();
  const r = eng.simulateMisses('nt', 2);
  close(r.rAfter, 3 - 2 * 0.6 * 0.65, 1e-12);
  assert.deepEqual(r.streak, { miss: 2, clean: 0 });
  assert.equal(eng.target('nt').eased, true);
  assert.ok(eng.todayPlan().problems.every(p => p.eased));
  const h = eng.simulateHolds('nt', 3);
  assert.deepEqual(h.streak, { miss: 0, clean: 3 });
  assert.equal(eng.todayPlan().problems.filter(p => p.reach).length, 1);
});

test('makeComfortable puts an area in push mode; reset restores the seed and the clock', () => {
  const { eng, bus } = make();
  eng.makeComfortable('dd');
  assert.equal(eng.inPush('dd'), true);
  assert.ok(eng.stage('dd-lfsr') >= 4 && eng.pushLevel('dd-lfsr') === 3);
  eng.advanceDays(3);
  eng.settleProblem('nt-a', { verdict: 'held' });
  eng.reset();
  assert.equal(eng.today(), '2026-11-15');
  assert.equal(eng.inPush('dd'), false);
  assert.equal(eng.rating('nt'), 3);
  assert.equal(eng.settled('nt-a'), null);
  assert.ok(bus.events.some(([e, d]) => e === 'engine:change' && d.type === 'reset'));
});

test('state persists through the store under the lab-study-reader- prefix', () => {
  const store = memStore();
  const a = make({ store });
  a.eng.recordDrill('nt-units', 'clean');
  a.eng.advanceDays(1);
  a.eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost' });
  assert.ok(store.map.has('lab-study-reader-engine'));
  const b = make({ store });
  assert.equal(b.eng.stage('nt-units'), 2);
  assert.equal(b.eng.today(), '2026-11-16');
  assert.equal(b.eng.mark('nt-moves', 'p-crt').status, 'struggling');
  store.set('engine', { v: 99 });
  assert.equal(make({ store }).eng.stage('nt-units'), 1, 'an unknown state version is reseeded');
});

test('integration APIs: drillHistory, roseToday, fogRecord, settledAll', () => {
  const { eng } = make();
  const h0 = eng.drillHistory('nt-units');
  assert.ok(Array.isArray(h0) && h0.length >= 1 && h0.every(x => x.src === 'seed'), 'the seed history is there');
  h0.push({ grade: 'bogus' });
  assert.equal(eng.drillHistory('nt-units').length, h0.length - 1, 'a copy: callers cannot change the engine');
  assert.equal(eng.roseToday('nt-units'), false);
  eng.recordDrill('nt-units', 'clean');
  assert.equal(eng.roseToday('nt-units'), true, 'the clean drill spent today\'s rise');
  const again = eng.recordDrill('nt-units', 'clean');
  assert.equal(again.sameDay, true);
  const h1 = eng.drillHistory('nt-units');
  assert.deepEqual(h1.slice(-2).map(x => [x.grade, x.from, x.to, x.src]), [['clean', 1, 2, 'drill'], ['clean', 2, 2, 'drill']]);
  assert.equal(eng.basicInfo('nt-units').roseToday, true);
  eng.advanceDays(1);
  assert.equal(eng.roseToday('nt-units'), false, 'a new day, a new rise');
  assert.equal(eng.fogRecord('f-crt'), null);
  eng.recordFog('f-crt', { reveals: 1, steps: 4, done: true });
  const fr = eng.fogRecord('f-crt');
  assert.equal(fr.grade, 'shaky');
  assert.equal(fr.reveals, 1);
  assert.equal(fr.steps, 4);
  assert.deepEqual(eng.settledAll(), []);
  const ps = eng.todayPlan().problems.map(x => x.id);
  eng.settleProblem(ps[0], { verdict: 'missed', called: [], took: ['modular'] });
  eng.advanceDays(0);
  eng.settleKata('k-shift', { pass: true, runs: 1, called: ['shift'], took: ['shift'] });
  const all = eng.settledAll();
  assert.deepEqual(all.map(x => x.kind).sort(), ['kata', 'problem']);
  assert.ok(all[0].t >= all[1].t, 'newest first');
  assert.deepEqual(all.map(x => x.id).sort(), [ps[0], 'k-shift'].sort());
});

test('a store that throws on every call does not break the engine', () => {
  const { eng } = make({ store: throwingStore() });
  assert.equal(eng.recordDrill('nt-units', 'clean').stageAfter, 2);
  assert.equal(eng.stage('nt-units'), 2);
  assert.equal(eng.triage({ docId: 'nt-moves', anchor: 'p-crt', verb: 'lost' }).action, 'scaffold');
  assert.doesNotThrow(() => eng.reset());
});

/* ---------------------------------------------------------- browser path */

test('engine.js attaches SR.engine to window.SR, reads SR.content lazily and emits engine:change', () => {
  const store = memStore(), bus = fakeBus();
  const win = { SR: { store, bus } };
  const exp = loadFile(win);
  assert.equal(typeof exp.createEngine, 'function');
  const E = win.SR.engine;
  const api = ['now', 'advanceDays', 'stage', 'setStage', 'lastDrill', 'rating', 'history', 'pushLevel', 'inPush', 'recordFog',
    'recordDrill', 'target', 'pickProblem', 'settleProblem', 'settleKata', 'methodAccuracy', 'triage', 'requestRewrite', 'budget',
    'logChange', 'changes', 'docVersion', 'setDocVersion', 'todayPlan', 'blockers', 'makeComfortable', 'simulateMisses', 'reset'];
  for (const k of api) assert.equal(typeof E[k], 'function', k);
  win.SR.content = fixture(); // content arrives after the engine: read lazily
  assert.equal(E.todayPlan().problems.length, 3);
  assert.equal(E.passageBasics('nt-moves', 'p-crt').length, 2);
  E.recordDrill('dd-crc', 'shaky');
  assert.ok(bus.events.some(([e, d]) => e === 'engine:change' && d.type === 'drill'));
  assert.ok(store.map.has('lab-study-reader-engine'));
});

test('engine.js uses no eval, no new Function and no network', () => {
  assert.doesNotMatch(SRC, /\beval\s*\(|new\s+Function|\bfetch\s*\(|XMLHttpRequest|window\.open|\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/);
  assert.match(SRC, /^\/\*[\s\S]*?Written by a model for Adit\. Not Adit's words\./);
});

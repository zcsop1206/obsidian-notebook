// node --test scripts/study-progress.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLib, progress } from './study-progress.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'test', 'fixtures', 'study');

const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

function ev(id, t, type, extra) { return JSON.stringify({ v: 1, id, t, dev: 'ipad', type, ...extra }); }

/** The shared invented fixture, copied, with a log. The fixture itself is never written. */
function makeRoot(lines) {
  const root = mkdtempSync(path.join(tmpdir(), 'study-progress-'));
  temps.push(root);
  cpSync(FIX, root, { recursive: true });
  mkdirSync(path.join(root, 'log'));
  writeFileSync(path.join(root, 'log', 'ipad.jsonl'), lines.join('\n') + '\n');
  return root;
}

const LOG = [
  ev('ipad-1', '2026-11-17T20:00:00-05:00', 'fog', { doc: 'fx-units', proof: 'p-unit-gcd', build: 2, reveals: 1, steps: 2, done: true, clean: false }),
  ev('ipad-2', '2026-11-17T20:10:00-05:00', 'fog', { doc: 'fx-units', proof: 'p-order-thm', build: 2, reveals: 0, steps: 2, done: false, clean: true }),
  ev('ipad-3', '2026-11-18T21:00:00-05:00', 'call', { item: 'inv-fx-last-digit', conf: 70, hidden: false, reach: false, d: 2.4 }),
  ev('ipad-4', '2026-11-18T21:30:00-05:00', 'settle', { item: 'inv-fx-last-digit', verdict: 'held', help: 0, gaveUp: false, ms: 1500000, called: [], used: [], hidden: false, hook: false }),
  ev('ipad-5', '2026-11-19T07:00:00-05:00', 'call', { item: 'inv-fx-unit-sum', conf: 40, hidden: true, reach: false, d: 3 }),
  ev('ipad-6', '2026-11-19T08:00:00-05:00', 'drill', { doc: 'fx-units', item: 'd-order-divides', grade: 'clean', ms: 240000, src: 'drill' }),
  ev('ipad-7', '2026-11-19T09:00:00-05:00', 'kata', { kata: 'k-fx', pass: true, runs: 2, gaveUp: false, ms: 2400000, called: [], used: [], hidden: false }),
];

const lib = loadLib();

test('progress: proofs fogged, Try list, open calls and timed events', () => {
  const root = makeRoot(LOG);
  const p = progress(root, '2026-11-20', { lib });
  const u = p.docs['fx-units'];
  assert.equal(u.kind, 'basic');
  assert.deepEqual(u.proofs.map((x) => [x.anchor, x.fogged]), [['p-unit-gcd', true], ['p-order-thm', false]]);
  assert.equal(u.proofsFogged, 1, 'an unfinished fog does not count');
  assert.equal(u.examples, 1);
  assert.equal(u.derives, 1);
  assert.ok(u.words > 0);
  assert.deepEqual(u.try.map((x) => [x.id, x.settled]), [['inv-fx-last-digit', true], ['inv-fx-unit-sum', false]]);
  assert.deepEqual(p.calls.map((c) => [c.item, c.day, c.hidden]), [['inv-fx-unit-sum', '2026-11-19', true]], 'a settled call is not open');
  assert.deepEqual(p.settles.map((s) => [s.item, s.day, s.ms, s.d]), [['inv-fx-last-digit', '2026-11-18', 1500000, 2.4]]);
  assert.deepEqual(p.drills.map((d) => [d.item, d.ms, d.grade]), [['d-order-divides', 240000, 'clean']]);
  assert.deepEqual(p.katas.map((k) => [k.kata, k.pass, k.ms]), [['k-fx', true, 2400000]]);
  assert.equal(p.docs['k-fx'].kata.passed, true);
  assert.equal(p.fogs.length, 2);
  assert.equal(p.fogs[0].day, '2026-11-17', 'the day is the device-local date in the event time');
});

test('progress: basics carry the engine stage and due date; docs list the tracks that serve them', () => {
  const root = makeRoot(LOG);
  const p = progress(root, '2026-11-20', { lib });
  const b = p.basics['fx-units'];
  assert.ok(b.stage >= 1, 'a fog starts a basic');
  assert.equal(typeof b.due, 'string');
  assert.deepEqual(p.docs['fx-units'].served, ['putnam']);
  assert.ok(!('fxbank' in p.docs), 'banks are not docs to plan');
  assert.ok(Array.isArray(p.today.drills) && Array.isArray(p.today.picks));
  for (const x of p.today.picks) assert.ok('hidden' in x && 'area' in x);
});

test('progress: an empty log gives an all-zero picture', () => {
  const root = makeRoot([]);
  const p = progress(root, '2026-11-20', { lib });
  assert.equal(p.counts.events, 0);
  assert.equal(p.calls.length, 0);
  assert.equal(p.docs['fx-units'].proofsFogged, 0);
  assert.ok(Object.values(p.basics).every((b) => b.stage === 0));
});

test('CLI prints JSON for --day and never writes into the root', () => {
  const root = makeRoot(LOG);
  const list = (dir) => readdirSync(dir, { recursive: true }).sort();
  const before = list(root);
  const logBefore = readFileSync(path.join(root, 'log', 'ipad.jsonl'), 'utf8');
  const out = execFileSync(process.execPath, [path.join(HERE, 'study-progress.mjs'), root, '--day=2026-11-21', '--minutes=30'], { encoding: 'utf8' });
  const p = JSON.parse(out);
  assert.equal(p.day, '2026-11-21');
  assert.equal(p.docs['fx-units'].proofsFogged, 1);
  assert.deepEqual(list(root), before);
  assert.equal(readFileSync(path.join(root, 'log', 'ipad.jsonl'), 'utf8'), logBefore);
});

// Against a real study folder, when one is given (the gate sets it). Read only.
const REAL = process.env.STUDY_CONTENT_DIR;
test('real folder: loads with no skipped events', { skip: !REAL && 'STUDY_CONTENT_DIR not set' }, () => {
  const p = progress(REAL, '2026-11-20', { lib });
  assert.ok(p.counts.docs > 0);
  assert.equal(p.counts.skipped, 0);
  for (const d of Object.values(p.docs)) assert.ok(d.proofsFogged <= d.proofs.length);
});

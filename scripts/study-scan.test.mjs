// node --test scripts/study-scan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'test', 'fixtures', 'study');

function ev(id, t, type, extra) { return JSON.stringify({ v: 1, id, t, dev: 'ipad', type, ...extra }); }

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'study-scan-'));
  cpSync(FIX, root, { recursive: true });
  mkdirSync(path.join(root, 'log'));
  writeFileSync(path.join(root, 'log', 'ipad.jsonl'), [
    ev('ipad-1', '2026-11-18T10:00:00-05:00', 'mark', { doc: 'fx-units', a: 'order-thm', verb: 'lost', build: 2 }),
    ev('ipad-2', '2026-11-18T10:01:00-05:00', 'rebuild-request', { doc: 'fx-units', a: 'order-thm', build: 2 }),
    ev('ipad-3', '2026-11-18T11:00:00-05:00', 'mark', { doc: 'fx-topic', a: 'cue-gcd', verb: 'lost', build: 1 }),
    ev('ipad-4', '2026-11-18T11:05:00-05:00', 'attempt', { doc: 'fx-topic', a: 'cue-gcd', strokes: 6 }),
    ev('ipad-5', '2026-11-19T12:00:00-05:00', 'rewrite-request', { doc: 'fx-topic', a: 'cue-gcd', build: 1 }),
    ev('ipad-6', '2026-11-19T13:00:00-05:00', 'mark', { doc: 'fx-div', a: 'bezout', verb: 'lost', build: 1 }),
    ev('ipad-7', '2026-11-19T14:00:00-05:00', 'call', { item: 'inv-fx-last-digit', conf: 70, hidden: false, reach: false, d: 2.4 }),
    ev('ipad-8', '2026-11-19T14:30:00-05:00', 'settle', { item: 'inv-fx-last-digit', verdict: 'held', help: 0, gaveUp: false, ms: 1800000, called: ['order'], used: ['order'], hidden: false, hook: false }),
    '{not json',
    ev('ipad-8', '2026-11-19T14:30:00-05:00', 'settle', { item: 'duplicate id is dropped' }),
  ].join('\n') + '\n');
  return root;
}

function run(root, ...args) {
  return execFileSync(process.execPath, [path.join(HERE, 'study-scan.mjs'), root, '--since=2026-11-01', ...args], { encoding: 'utf8' });
}

test('pending requests, scaffold marks and settles from the logs', () => {
  const root = makeRoot();
  const r = JSON.parse(run(root, '--json'));
  assert.equal(r.meta.events, 8);
  assert.equal(r.meta.skipped, 1);
  assert.deepEqual(r.requests.map((q) => [q.kind, q.doc, q.anchor, q.buildRequested, q.buildNow]), [
    ['rebuild', 'fx-units', 'order-thm', 2, 2], ['rewrite', 'fx-topic', 'cue-gcd', 1, 1],
  ]);
  assert.equal(r.requests[1].attemptStrokes, 6);
  assert.match(r.requests[0].passage, /Theorem 2 \(order\)/);
  assert.deepEqual(r.scaffold.map((s) => `${s.doc}#${s.anchor}`), ['fx-div#bezout']);
  assert.equal(r.settles.length, 1);
  assert.equal(r.settles[0].conf, 70);
});

test('a higher build answers a request; markdown output and lint', () => {
  const root = makeRoot();
  const p = path.join(root, 'topics', 'fx-topic.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('build: 1', 'build: 2'));
  const r = JSON.parse(run(root, '--json'));
  assert.deepEqual(r.requests.map((q) => q.doc), ['fx-units']);
  const md = run(root, '--lint');
  assert.match(md, /## Pending requests \(1\)/);
  assert.match(md, /## Parser warnings \(\d+\)/);
});

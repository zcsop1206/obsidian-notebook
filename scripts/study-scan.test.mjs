// node --test scripts/study-scan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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

/** The scan's exit status and output, for runs that may exit 1. */
function runStatus(root, ...args) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'study-scan.mjs'), root, '--since=2026-11-01', ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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
  assert.match(md, /## Lint\n\n0 error\(s\), \d+ warning\(s\), 0 info\./);
});

/* ------------------------------------------------------------------------------------- lint */

// The lint's vault, all invented: <tmp>/outer/.obsidian is a farther vault, <tmp>/outer/vault/.obsidian
// the nearest one, which holds attachments/ and study/ (a copy of the fixtures plus the cases below).

function svg(attrs) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- an invented test figure -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs} viewBox="0 0 120 80"><rect width="100%" height="100%" fill="#fff"/></svg>\n`;
}
const SIZED = svg('width="120" height="80"');

function put(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function edit(file, f) {
  writeFileSync(file, f(readFileSync(file, 'utf8')));
}

/** The 1-based line of the first line of a file that holds `needle`. */
function lineOf(file, needle) {
  const i = readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `"${needle}" is in ${file}`);
  return i + 1;
}

const LINT_DOC = [
  '---', 'study: topic', 'id: fx-lint', 'title: Lint cases (fixture)', 'area: [nt]', 'needs: [fx-units]', 'build: 1', 'hidden: never', '---', '',
  "> Written by a model for Adit. Not Adit's words.", '',
  'A wheel ![The units mod 8 on a wheel](fx-units--wheel.svg), a spaced name ![Spaced](fx%20spaced.svg), one outside the study',
  'folder ![Shared](fx-shared.svg), one only in the farther vault ![Outer](fx-outer-only.svg) and a remote one ![Remote](https://example.org/fx-remote.png).', '',
  'Not embeds: `![in a code span](fx-in-code-span.svg)` and a fence:', '',
  '```text', '![in a fence](fx-in-fence.png)', '```', '',
  '> [!problem] Figure only in the solution (d 2)',
  '> Count the units mod 8.',
  '^inv-fx-fig-only', '',
  '> [!solution]- Solution',
  '> methods: order',
  '> ![The four units circled](fx-units--wheel.svg)',
  '> Answer: 4.', '',
  '> [!problem] Figure in both (d 2)',
  '> ![The units mod 8 on a wheel](fx-units--wheel.svg)',
  '> Which units square to 1?',
  '^inv-fx-fig-both', '',
  '> [!solution]- Solution',
  '> methods: order',
  '> ![All four circled](fx-units--wheel.svg)',
  '> Answer: all four.', '',
  '> [!example] Embeds in a callout',
  '> ![Missing](fx-nowhere.svg)',
  '> ```text',
  '> ![in a callout fence](fx-in-callout-fence.svg)',
  '> ```',
  '^ex-embeds', '',
  '> [!solution]- Solution',
  '> ![By path](figures/fx-units--wheel.svg), ![Up a folder](../fx-units--wheel.svg) and ![[fx-units--wiki.svg|200]]',
  '> ![Twice](fx-twice.svg) and ![Only in a dot folder](fx-dot-only.svg)',
  '> ![Percent](fx-units--pct.svg) and ![No height](fx-units--no-height.svg)', '',
  'A paragraph between an item and a solution.', '',
  '> [!solution]- Solution',
  '> A solution with nothing right above it.', '',
  '> [!problem] Unfolded solution (d 2)',
  '> Find the order of 3 mod 7.',
  '^inv-fx-unfolded', '',
  '> [!solution] Solution',
  '> methods: order',
  '> Answer: 6.', '',
  '> [!note] A fence the callout never closes',
  '> ```text',
  '> ![in an unclosed callout fence](fx-in-open-fence.svg)', '',
  'The callout ended, and its fence with it: ![After the callout](fx-after-callout.svg)', '',
].join('\n');

const COMB_DOC = [
  '---', 'study: topic', 'id: fx-comb', 'title: Counting (fixture)', 'area: [comb, gen]', 'build: 1', '---', '',
  "> Written by a model for Adit. Not Adit's words.", '',
  'An invented topic whose areas a track can reach a bank through.', '',
].join('\n');

const TRACK_ROWS = [
  '| fx-quiz | 2026-12-20 | 1 | nt | bank fxbank |',
  '| fx-wide | 2026-12-20 | 1 | nt comb gen | bank fxbank |',
  '| fx-via-doc | 2026-12-20 | 1 | nt | topics fx-comb; bank |',
  '| fx-folder | 2026-12-20 | 1 | nt | topics fx-lint; bank |',
  '| fx-elsewhere | 2026-12-20 | 1 | nt | basics fxbank |',
  '| fx-paused | | 0 | | bank fxbank |',
];

function makeVault() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'study-lint-'));
  const outer = path.join(tmp, 'outer');
  const vault = path.join(outer, 'vault');
  const study = path.join(vault, 'study');
  put(path.join(outer, '.obsidian', 'app.json'), '{}');
  put(path.join(outer, 'fx-outer-only.svg'), SIZED);
  put(path.join(vault, '.obsidian', 'app.json'), '{}');
  // Copies in folders Obsidian does not see: they neither resolve an embed nor make one ambiguous.
  for (const dir of ['.obsidian', '.git', path.join('node_modules', 'pkg')]) put(path.join(vault, dir, 'fx-units--wheel.svg'), SIZED);
  put(path.join(vault, '.obsidian', 'fx-dot-only.svg'), SIZED);
  put(path.join(vault, 'attachments', 'fx-shared.svg'), SIZED);
  put(path.join(vault, 'attachments', 'fx-twice.svg'), SIZED);
  cpSync(FIX, study, { recursive: true });
  put(path.join(study, 'topics', 'fx-lint.md'), LINT_DOC);
  put(path.join(study, 'topics', 'fx-comb.md'), COMB_DOC);
  for (const name of ['fx-units--wheel.svg', 'fx-units--wiki.svg', 'fx-twice.svg', 'fx spaced.svg']) put(path.join(study, 'figures', name), SIZED);
  put(path.join(study, 'figures', 'fx-units--pct.svg'), svg('width="100%" height="80"'));
  put(path.join(study, 'figures', 'fx-units--no-height.svg'), svg('width="120pt"'));
  edit(path.join(study, 'bank', 'fxbank.md'), (s) => s.replace('title: Putnam (fixture)', 'title: Putnam (fixture)\nhidden: Never'));
  edit(path.join(study, 'basics', 'fx-div.md'), (s) => s.replace('build: 1', 'build: 1\nHidden: never'));
  edit(path.join(study, 'bank', 'fxbank.tags.md'), (s) => s.replace(/\n*$/, '\n') + '| putnam-2019-a2 | comb | pigeonhole |\n| putnam-2020-b9 | gen | invariants |\n');
  edit(path.join(study, 'tracks.md'), (s) => s.replace(/\n*$/, '\n') + TRACK_ROWS.join('\n') + '\n');
  return { tmp, outer, vault, study };
}

let shared = null;
/** One vault and one `--json --lint` run, shared by the rule tests below. */
function lintRun() {
  if (!shared) {
    const v = makeVault();
    const out = runStatus(v.study, '--json', '--lint');
    shared = { ...v, status: out.status, r: JSON.parse(out.stdout), doc: path.join(v.study, 'topics', 'fx-lint.md') };
  }
  return shared;
}

const pick = (items, rule) => items.filter((x) => x.rule === rule).map((x) => [x.doc, x.line]);

test('lint: findings are { rule, doc, line, message }, and --json keeps its other fields', () => {
  const { r } = lintRun();
  assert.deepEqual(Object.keys(r).filter((k) => k !== 'lint' && k !== 'warnings'), ['meta', 'requests', 'scaffold', 'settles', 'drills', 'katas']);
  assert.ok(Array.isArray(r.warnings) && r.warnings.every((w) => typeof w === 'string'), 'the parser warnings stay as they were');
  assert.deepEqual(Object.keys(r.lint), ['errors', 'warnings', 'info']);
  for (const x of [...r.lint.errors, ...r.lint.warnings, ...r.lint.info]) {
    assert.deepEqual(Object.keys(x).sort(), ['doc', 'line', 'message', 'rule']);
    assert.ok(x.line === null || Number.isInteger(x.line));
  }
  const plain = JSON.parse(run(lintRun().study, '--json'));
  assert.deepEqual(Object.keys(plain), ['meta', 'requests', 'scaffold', 'settles', 'drills', 'katas'], 'no lint keys without --lint');
});

test('lint: every error, and nothing else (no false positive)', () => {
  const { r, doc } = lintRun();
  const at = (needle) => lineOf(doc, needle);
  const D = 'topics/fx-lint.md';
  assert.deepEqual(r.lint.errors.map((e) => [e.rule, e.doc, e.line]), [
    ['embed-missing', D, at('fx-outer-only.svg')],
    ['embed-missing', D, at('fx-nowhere.svg')],
    ['embed-form', D, at('figures/fx-units--wheel.svg')],
    ['embed-form', D, at('figures/fx-units--wheel.svg')],
    ['embed-form', D, at('figures/fx-units--wheel.svg')],
    ['embed-ambiguous', D, at('fx-twice.svg')],
    ['embed-missing', D, at('fx-twice.svg')],
    ['svg-size', D, at('fx-units--pct.svg')],
    ['svg-size', D, at('fx-units--pct.svg')],
    ['solution-orphan', D, at('A solution with nothing right above it.') - 1],
    ['solution-unfolded', D, at('> [!solution] Solution')],
    ['embed-missing', D, at('fx-after-callout.svg')],
  ]);
});

test('lint embed-missing: by bare name anywhere in the nearest vault; not in code, fences or dot-folders', () => {
  const { r } = lintRun();
  const missing = r.lint.errors.filter((e) => e.rule === 'embed-missing').map((e) => e.message);
  assert.deepEqual(missing, [
    'no file named "fx-outer-only.svg" in the vault',
    'no file named "fx-nowhere.svg" in the vault',
    'no file named "fx-dot-only.svg" in the vault',
    'no file named "fx-after-callout.svg" in the vault',
  ], 'the farther vault and a dot-folder do not count; a remote URL, a code span and fences (in a callout too) are not checked; a fence ends with its callout');
  const all = JSON.stringify(r.lint);
  for (const name of ['fx-units--wheel.svg"', 'fx spaced.svg', 'fx-shared.svg', 'fx-remote.png', 'fx-in-code-span.svg', 'fx-in-fence.png', 'fx-in-callout-fence.svg', 'fx-in-open-fence.svg']) {
    assert.ok(!all.includes(`no file named "${name}`), `${name} is not reported missing`);
  }
  // A case-only mismatch says so.
  const v = makeVault();
  edit(path.join(v.study, 'topics', 'fx-comb.md'), (s) => s + '\n![Case](FX-Twice.svg)\n');
  const r2 = JSON.parse(runStatus(v.study, '--json', '--lint').stdout);
  const c = r2.lint.errors.find((e) => e.doc === 'topics/fx-comb.md');
  assert.equal(c.rule, 'embed-missing');
  assert.match(c.message, /"FX-Twice\.svg".*"fx-twice\.svg" differs only in case/);
});

test('lint: without a .obsidian folder above it, the vault is the study root', (t) => {
  const v = makeVault();
  const alone = path.join(mkdtempSync(path.join(tmpdir(), 'study-alone-')), 'study');
  cpSync(v.study, alone, { recursive: true });
  for (let dir = path.dirname(alone); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.obsidian'))) { t.skip(`a .obsidian folder above the temp folder (${dir})`); return; }
    if (path.dirname(dir) === dir) break;
  }
  const r = JSON.parse(runStatus(alone, '--json', '--lint').stdout);
  const rules = (name) => r.lint.errors.filter((e) => e.message.includes(`"${name}"`)).map((e) => e.rule);
  assert.deepEqual(rules('fx-shared.svg'), ['embed-missing'], 'attachments/ is outside the study root');
  assert.deepEqual(rules('fx-twice.svg'), [], 'one copy left, under the root: neither missing nor ambiguous');
});

test('lint embed-ambiguous: one bare name, two files in the vault', () => {
  const { r } = lintRun();
  const amb = r.lint.errors.filter((e) => e.rule === 'embed-ambiguous');
  assert.equal(amb.length, 1, 'fx-units--wheel.svg has copies only in .obsidian, .git and node_modules: not ambiguous');
  assert.equal(amb[0].message, '"fx-twice.svg" names 2 files in the vault: attachments/fx-twice.svg, study/figures/fx-twice.svg');
});

test('lint embed-form: a slash, `..` or a wikilink embed; a bare name is fine', () => {
  const { r } = lintRun();
  const form = r.lint.errors.filter((e) => e.rule === 'embed-form').map((e) => e.message);
  assert.deepEqual(form.sort(), [
    '`![By path](figures/fx-units--wheel.svg)` names a path: embed the file by its bare name, `![By path](fx-units--wheel.svg)`',
    '`![Up a folder](../fx-units--wheel.svg)` names a path: embed the file by its bare name, `![Up a folder](fx-units--wheel.svg)`',
    '`![[fx-units--wiki.svg|200]]` is a wikilink embed: write `![alt](fx-units--wiki.svg)`',
  ].sort());
});

test('lint svg-size: the root <svg> needs an absolute width and height', () => {
  const { r } = lintRun();
  const size = r.lint.errors.filter((e) => e.rule === 'svg-size').map((e) => e.message);
  assert.deepEqual(size, [
    'study/figures/fx-units--no-height.svg: the root <svg> has no height (give both in px or another absolute unit)',
    'study/figures/fx-units--pct.svg: the root <svg> has width "100%", which is not an absolute size (give both in px or another absolute unit)',
  ], 'a percentage on a child <rect> does not count; fx-units--wheel.svg and fx-shared.svg are sized, and each SVG is checked once');
});

test('lint solution-orphan and solution-unfolded: the parser\'s two solution warnings become errors, not repeated as warnings', () => {
  const { r, doc } = lintRun();
  assert.deepEqual(pick(r.lint.errors, 'solution-orphan'), [['topics/fx-lint.md', lineOf(doc, 'A solution with nothing right above it.') - 1]]);
  assert.deepEqual(pick(r.lint.errors, 'solution-unfolded'), [['topics/fx-lint.md', lineOf(doc, '> [!solution] Solution')]]);
  assert.equal(r.lint.warnings.filter((w) => /solution/.test(w.message)).length, 0);
  // The parser's other warnings stay warnings, with their doc and line where the parser gave one.
  const parser = r.lint.warnings.filter((w) => w.rule === 'parser');
  assert.ok(parser.some((w) => w.doc === 'methods.md' && /method "ghost" links a missing anchor/.test(w.message)));
  assert.ok(parser.some((w) => w.doc === 'topics/fx-topic.md' && Number.isInteger(w.line) && /a block id on its own line/.test(w.message)));
  assert.equal(r.warnings.length, parser.length + 2, 'the raw parser list has the two solution warnings too');
});

test('lint solution-figure-only (info): a figure only in the solution, not in the statement', () => {
  const { r, doc } = lintRun();
  assert.deepEqual(r.lint.info.map((x) => [x.rule, x.doc, x.line]), [['solution-figure-only', 'topics/fx-lint.md', lineOf(doc, 'Figure only in the solution')]]);
  assert.match(r.lint.info[0].message, /^problem inv-fx-fig-only: its solution embeds a figure \(fx-units--wheel\.svg\)/);
});

test('lint hidden-value: anything but exactly `hidden: never` is a warning', () => {
  const { r, study } = lintRun();
  assert.deepEqual(pick(r.lint.warnings, 'hidden-value'), [
    ['bank/fxbank.md', lineOf(path.join(study, 'bank', 'fxbank.md'), 'hidden: Never')],
    ['basics/fx-div.md', lineOf(path.join(study, 'basics', 'fx-div.md'), 'Hidden: never')],
  ], 'fx-lint.md says hidden: never, spelled exactly: no warning');
  assert.match(r.lint.warnings.find((w) => w.doc === 'bank/fxbank.md').message, /^"hidden: Never" has no effect/);
});

test('lint track-bank-areas: a bank served by the docs column, with problem areas the row does not reach', () => {
  const { r, study } = lintRun();
  const tracks = path.join(study, 'tracks.md');
  // The plugin's own matcher decides what a docs column serves: fx-folder serves the bank through a
  // folder-only section, while fx-elsewhere's glob is bound to basics/ and serves no bank.
  assert.deepEqual(pick(r.lint.warnings, 'track-bank-areas'), [['tracks.md', lineOf(tracks, '| fx-quiz |')], ['tracks.md', lineOf(tracks, '| fx-folder |')]],
    'fx-wide lists the areas; fx-via-doc reaches them through fx-comb; fx-elsewhere serves no bank; fx-paused has weight 0; putnam serves no bank');
  assert.match(r.lint.warnings.find((w) => w.rule === 'track-bank-areas').message,
    /^track "fx-quiz" serves the bank fxbank through its docs column, but not the areas of 2 of its problems \(comb, gen\): /);
});

test('exit codes: 1 with --lint and an error, else 0; markdown output', () => {
  const { study, status } = lintRun();
  assert.equal(status, 1, '--json --lint with errors');
  const md = runStatus(study, '--lint');
  assert.equal(md.status, 1, 'markdown --lint with errors');
  assert.match(md.stdout, /## Lint\n\n12 error\(s\), \d+ warning\(s\), 1 info\./);
  assert.match(md.stdout, /### Errors \(12\)\n\n- topics\/fx-lint\.md:\d+ embed-missing: no file named "fx-outer-only\.svg" in the vault\n/);
  assert.match(md.stdout, /### Info \(1\)\n\n- topics\/fx-lint\.md:\d+ solution-figure-only: /);
  assert.equal(runStatus(study).status, 0, 'without --lint nothing changes');
  const clean = runStatus(makeRoot(), '--json', '--lint');
  assert.equal(clean.status, 0, 'warnings only');
  assert.deepEqual(JSON.parse(clean.stdout).lint.errors, []);
});

// The study view's pure parts (S3): library grouping, search exclusions, link targets, anchored
// list items, peek contents, settings validation and the tap rule, on test/fixtures/study/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildIndex, type SourceFile } from '../../src/study/format/index-build';
import { docSignature, groupDocs, itemIndexes, peekParts, splitTo, joinTo, studyTarget, displayTitle, isUnrendered } from '../../src/study/view/model';
import { plainText, search } from '../../src/study/view/search';
import { cleanDevice, cleanRoot, parseStudySettings } from '../../src/study/view/settings';
import { isTap, TAP_MS, TAP_SLOP } from '../../src/study/view/gestures';
import type { StudyDoc } from '../../src/study/types';

const ROOT = 'test/fixtures/study';

function allFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  const read = (rel: string) => out.push({ path: `study/${rel}`, text: readFileSync(`${ROOT}/${rel}`, 'utf8') });
  for (const top of readdirSync(ROOT)) {
    if (top.endsWith('.md')) { read(top); continue; }
    for (const f of readdirSync(`${ROOT}/${top}`)) if (f.endsWith('.md')) read(`${top}/${f}`);
  }
  return out;
}

const idx = buildIndex(allFiles());
const doc = (id: string): StudyDoc => idx.docs.get(id)!;

test('library: grouped by kind (topics first), then area, sorted by title', () => {
  const g = groupDocs(idx.docs.values());
  assert.deepEqual(g.map(x => x.kind), ['topic', 'basic', 'kata', 'bank']);
  assert.deepEqual(g.map(x => x.label), ['Topics', 'Basics', 'Katas', 'Problem banks']);
  const basics = g[1];
  assert.deepEqual(basics.areas.map(a => a.area), ['nt']);
  assert.equal(basics.areas[0].label, 'Number theory and algebra');
  assert.deepEqual(basics.areas[0].docs.map(d => d.id), ['fx-div', 'fx-units']);
  assert.deepEqual(g[2].areas.map(a => a.area), ['dd']);
  assert.deepEqual(g[3].areas.map(a => a.area), ['other']);
});

test('library: a hidden kata shows no title and sits under Other', () => {
  const k = doc('k-fx');
  const hidden: StudyDoc = { ...k, id: 'k-hid', kata: { ...k.kata!, level: 'hidden' } };
  assert.equal(displayTitle(hidden), 'Hidden kata');
  const g = groupDocs([hidden]);
  assert.deepEqual(g[0].areas.map(a => a.area), ['other']);
});

test('search: titles and passages, accents and case ignored', () => {
  assert.ok(search(idx, 'bézout').some(h => h.doc === 'fx-div' && h.a === 'bezout'));
  assert.ok(search(idx, 'BEZOUT').some(h => h.doc === 'fx-div' && h.a === 'bezout'));
  assert.equal(search(idx, 'divisibility')[0].a, null, 'a title match ranks first');
  assert.ok(search(idx, 'huge exponent').some(h => h.doc === 'fx-units' && h.a === 'cue-exponent'), 'anchored list items are found');
  assert.ok(search(idx, 'order of 2').length > 0 || search(idx, 'powers').length > 0);
});

test('search: never proofs, solutions or kata code the block owns', () => {
  assert.deepEqual(search(idx, 'minimality'), [], 'proof text');
  assert.deepEqual(search(idx, '2401'), [], 'solution text');
  assert.deepEqual(search(idx, '2, 4, 1'), [], "an example's solution, though the page shows it folded");
  assert.deepEqual(search(idx, 'endmodule'), [], 'kata skeleton');
  assert.deepEqual(search(idx, 'comment line'), [], 'kata vectors');
});

test('search: plain text of TeX and links', () => {
  assert.equal(plainText('the [order](nt-units.md#^order-thm) divides $\\varphi(n)$'), 'the order divides φ(n)');
  assert.equal(plainText('> [!thm] Theorem 1\n> $a \\equiv 1 \\pmod n$'), 'Theorem 1 a ≡ 1 (mod n)');
});

test('links: study targets by relative path, same doc, and not external or other notes', () => {
  assert.deepEqual(studyTarget(idx, doc('fx-topic'), '../basics/fx-div.md#^bezout'), { doc: 'fx-div', anchor: 'bezout' });
  assert.deepEqual(studyTarget(idx, doc('fx-units'), '#^order-thm'), { doc: 'fx-units', anchor: 'order-thm' });
  assert.deepEqual(studyTarget(idx, doc('fx-units'), 'fx-div.md'), { doc: 'fx-div', anchor: null });
  assert.deepEqual(studyTarget(idx, doc('fx-units'), '../topics/fx-topic.md#First moves'), { doc: 'fx-topic', anchor: 'h-first-moves' });
  assert.equal(studyTarget(idx, doc('fx-units'), 'https://example.org/x.pdf'), null);
  assert.equal(studyTarget(idx, doc('fx-units'), '../notes-not-study.md'), null);
  assert.deepEqual(splitTo(joinTo({ doc: 'a', anchor: null })), { doc: 'a', anchor: null });
  assert.deepEqual(splitTo('a#b'), { doc: 'a', anchor: 'b' });
});

test('anchored list items map to their top-level item', () => {
  const units = doc('fx-units');
  const list = units.passages.find(p => (p.items || []).some(i => i.anchor === 'cue-exponent'))!;
  assert.deepEqual([...itemIndexes(list)], [['cue-exponent', 0]]);
  const topic = doc('fx-topic');
  const cues = topic.passages.find(p => (p.items || []).some(i => i.anchor === 'cue-gcd'))!;
  assert.deepEqual([...itemIndexes(cues)], [['cue-gcd', 0], ['cue-broken', 1]]);
});

test('a solution its block shows and kata-owned code get no element; an example\'s solution does', () => {
  const units = doc('fx-units');
  const sol = units.passages.filter(p => p.callout?.type === 'solution');
  assert.deepEqual(sol.map(p => [p.block?.id, isUnrendered(units, p)]), [['ex-order', false], ['inv-fx-last-digit', true]]);
  const k = doc('k-fx');
  assert.deepEqual(k.passages.filter(p => isUnrendered(k, p)).map(p => p.lang), ['skeleton', 'vectors']);
});

// An invented basic for the solution rules, each answer a word found nowhere else: a worked
// example's solution, one that belongs to nothing (right after another solution), and the ones a
// derive, a recall card and a bank problem show themselves.
const WORKED = [
  '---', 'study: basic', 'id: fx-worked', 'title: Worked answers (fixture)', 'area: nt', 'needs: []', 'build: 1', '---', '',
  "> Written by a model for Adit. Not Adit's words.", '',
  '## Halves', '',
  '> [!example] Half of six', '> Halve $6$.', '^ex-half', '',
  '> [!solution]- Solution', '> Three kumquats.', '',
  '> [!solution]- Solution', '> A stray persimmon.', '',
  '## Drills', '',
  '> [!derive] Show that half of an even number is whole.', '^d-half', '',
  '> [!solution]- Solution', '> Write it as twice a tamarind.', '',
  '> [!recall] How many halves make a whole?', '^r-halves', '',
  '> [!solution]- Answer', '> Two loquats.', '',
  '> [!problem] putnam-2019-a1', '^putnam-2019-a1', '',
  '> [!solution]- Solution', '> A mangosteen.', '',
].join('\n');

test('solutions by what they belong to: the page, peeks and search', () => {
  const idx2 = buildIndex([...allFiles(), { path: 'study/basics/fx-worked.md', text: WORKED }]);
  const d = idx2.docs.get('fx-worked')!;
  const word = (p: { markdown: string }) => /kumquat|persimmon|tamarind|loquat|mangosteen/.exec(p.markdown)?.[0];
  const sols = d.passages.filter(p => p.callout?.type === 'solution');
  assert.deepEqual(sols.map(p => [word(p), p.block?.id ?? null, isUnrendered(d, p)]), [
    ['kumquat', 'ex-half', false],
    ['persimmon', null, false],
    ['tamarind', 'd-half', true],
    ['loquat', 'r-halves', true],
    ['mangosteen', 'putnam-2019-a1', true],
  ]);
  // A heading's section holds the example and both solutions: the peek leaves every solution out.
  const sec = peekParts(d, 'h-halves');
  assert.deepEqual(sec.map(p => p.anchor), ['h-halves', 'ex-half']);
  assert.ok(sec.every(p => !p.placeholder && !word({ markdown: p.markdown ?? '' })));
  for (const p of sols) assert.deepEqual(peekParts(d, p.anchor), [], `a peek of the solution itself (${word(p)})`);
  for (const w of ['kumquat', 'persimmon', 'tamarind', 'loquat', 'mangosteen']) assert.deepEqual(search(idx2, w), [], w);
});

test('peek: the passage, a section for a heading, never a proof or a solution', () => {
  const units = doc('fx-units');
  const thm = peekParts(units, 'unit-gcd');
  assert.equal(thm.length, 1);
  assert.match(thm[0].markdown!, /\[!thm\] Theorem 1/);
  const sec = peekParts(units, 'h-units');
  assert.equal(sec.length, 4);
  assert.ok(sec.some(p => p.placeholder && /fogged/.test(p.placeholder)));
  assert.ok(sec.every(p => !p.markdown || !/ax - kn/.test(p.markdown)));
  const item = peekParts(units, 'cue-exponent');
  assert.match(item[0].markdown!, /huge exponent/);
  const ex = peekParts(units, 'ex-order');
  assert.deepEqual(ex.length, 1);
  assert.ok(!/2, 4, 1/.test(ex[0].markdown!));
  assert.match(peekParts(units, 'nope')[0].placeholder!, /not in build 2/);
  const top = peekParts(doc('fx-topic'), null);
  assert.match(top[0].markdown!, /## Recognise/);
});

test('signature changes with the text, not with an identical re-parse', () => {
  const again = buildIndex(allFiles());
  assert.equal(docSignature(again.docs.get('fx-units')!), docSignature(doc('fx-units')));
  const files = allFiles().map(f => f.path.endsWith('fx-units.md') ? { ...f, text: f.text.replace('which gets a hash anchor', 'which gets another hash anchor') } : f);
  assert.notEqual(docSignature(buildIndex(files).docs.get('fx-units')!), docSignature(doc('fx-units')));
});

test('settings: study section validated', () => {
  assert.deepEqual(parseStudySettings(undefined), { root: 'study', device: '', minutes: 60, devTools: false });
  assert.deepEqual(parseStudySettings({ root: ' /content\\study/ ', device: 'Adit iPad!', minutes: '45', devTools: true }), { root: 'content/study', device: 'adit-ipad', minutes: 45, devTools: true });
  assert.equal(parseStudySettings({ minutes: 2 }).minutes, 10);
  assert.equal(parseStudySettings({ minutes: 5000 }).minutes, 600);
  assert.equal(parseStudySettings({ minutes: 'lots' }).minutes, 60);
  assert.equal(parseStudySettings({ devTools: 'yes' }).devTools, false);
  assert.equal(parseStudySettings({ root: '../..' }).root, 'study');
  assert.equal(cleanRoot('a//b/./c/'), 'a/b/c');
  assert.equal(cleanDevice('  Lap_Top 2 '), 'lap-top-2');
});

test('taps: under 10 px and 300 ms', () => {
  assert.equal(TAP_SLOP, 10);
  assert.equal(TAP_MS, 300);
  assert.ok(isTap(3, 4, 120));
  assert.ok(!isTap(8, 8, 120));
  assert.ok(!isTap(0, 0, 300));
});

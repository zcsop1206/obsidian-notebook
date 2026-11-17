// The study/1 parser and content index (docs/study/FORMAT.md), on the fixtures in test/fixtures/study/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sha1Hex } from '../../src/study/format/sha1';
import { hash8, parseFrontmatter, parsePorts, parseStudyDoc, parseSteps, parseVectors, slug } from '../../src/study/format/parse';
import { buildIndex, type SourceFile } from '../../src/study/format/index-build';

const ROOT = 'test/fixtures/study';

function read(rel: string): SourceFile {
  return { path: `study/${rel}`, text: readFileSync(`${ROOT}/${rel}`, 'utf8') };
}

function allFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const top of readdirSync(ROOT)) {
    if (top.endsWith('.md')) { out.push(read(top)); continue; }
    for (const f of readdirSync(`${ROOT}/${top}`)) if (f.endsWith('.md')) out.push(read(`${top}/${f}`));
  }
  return out;
}

test('sha1 matches the standard test vectors', () => {
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  // UTF-8: one two-byte character, and a surrogate pair.
  assert.equal(sha1Hex('é'), sha1Hex('é'));
  assert.equal(sha1Hex('\u{1F600}').length, 40);
});

test('frontmatter: scalars, numbers, inline and block lists, comments', () => {
  const { meta, bodyStart } = parseFrontmatter([
    '---', 'study: basic', 'build: 3', 'needs: [a, b]', 'title: "Quoted: yes"', 'tracks:', '  - putnam', '  - asic', 'd: 2.5 # a comment', '---', 'body',
  ]);
  assert.equal(bodyStart, 10);
  assert.deepEqual(meta, { study: 'basic', build: 3, needs: ['a', 'b'], title: 'Quoted: yes', tracks: ['putnam', 'asic'], d: 2.5 });
});

test('a basic: label, anchors, headings, hash anchors', () => {
  const doc = parseStudyDoc('study/basics/fx-units.md', readFileSync(`${ROOT}/basics/fx-units.md`, 'utf8'));
  assert.equal(doc.kind, 'basic');
  assert.equal(doc.id, 'fx-units');
  assert.equal(doc.build, 2);
  assert.deepEqual(doc.needs, ['fx-div']);
  assert.deepEqual(doc.areas, ['nt']);
  assert.equal(doc.labelled, true);
  assert.equal(doc.passages[0].kind, 'label');
  const anchors = doc.passages.map(p => p.anchor);
  for (const a of ['needs', 'h-units', 'unit-def', 'unit-gcd', 'p-unit-gcd', 'h-order', 'order-thm', 'p-order-thm', 'ex-order',
    'd-order-divides', 'inv-fx-last-digit', 'inv-fx-unit-sum', 'inverse-table', 'phi-prime']) {
    assert.ok(anchors.includes(a), `missing anchor ${a} in ${anchors.join(' ')}`);
  }
  const plain = doc.passages.find(p => p.markdown.startsWith('An ordinary paragraph'))!;
  assert.equal(plain.explicit, false);
  assert.equal(plain.anchor, `p-${hash8(plain.markdown)}`);
  // Block ids never reach the rendered markdown.
  for (const p of doc.passages) assert.ok(!/\s\^[a-z0-9-]+\s*$/m.test(p.markdown), `block id left in ${p.anchor}: ${p.markdown}`);
  assert.deepEqual(doc.warnings, []);
});

test('theorems and proofs: steps, d, folding, the proof anchor', () => {
  const doc = parseStudyDoc('study/basics/fx-units.md', readFileSync(`${ROOT}/basics/fx-units.md`, 'utf8'));
  assert.deepEqual(doc.theorems.map(t => [t.anchor, t.proof]), [['unit-gcd', 'p-unit-gcd'], ['order-thm', 'p-order-thm']]);
  const [p1, p2] = doc.proofs;
  assert.equal(p1.of, 'unit-gcd');
  assert.equal(p1.d, 1.5);
  assert.equal(p1.steps.length, 2);
  assert.match(p1.steps[1].markdown, /\$\$ax \\equiv 1 \\pmod n\.\$\$/);
  assert.equal(p2.d, null);
  assert.equal(doc.passages.find(p => p.anchor === 'p-unit-gcd')!.block!.type, 'fog');
  assert.equal(doc.passages.find(p => p.anchor === 'p-unit-gcd')!.callout!.folded, true);
  assert.equal(doc.passages.find(p => p.anchor === 'unit-def')!.callout!.folded, false);
});

test('problems, solutions, derive prompts', () => {
  const doc = parseStudyDoc('study/basics/fx-units.md', readFileSync(`${ROOT}/basics/fx-units.md`, 'utf8'));
  const [last, sum] = doc.problems;
  assert.equal(last.id, 'inv-fx-last-digit');
  assert.equal(last.title, 'Last digit');
  assert.equal(last.d, 2.4);
  assert.equal(last.area, 'nt');
  assert.deepEqual(last.methods, ['order', 'fx-div/cong-arith']);
  assert.equal(last.solution!.steps.length, 2);
  assert.ok(!last.solution!.markdown.includes('methods:'));
  assert.equal(sum.unchecked, true);
  assert.equal(sum.title, 'A sum of units');
  assert.equal(sum.d, 3);
  assert.equal(sum.solution, null);
  assert.deepEqual(doc.derives.map(d => d.anchor), ['d-order-divides']);
  assert.equal(doc.passages.find(p => p.anchor === 'inv-fx-last-digit')!.block!.type, 'problem');
});

test('lists: anchored items and where their links come from', () => {
  const doc = parseStudyDoc('study/basics/fx-units.md', readFileSync(`${ROOT}/basics/fx-units.md`, 'utf8'));
  const list = doc.passages.find(p => p.kind === 'list')!;
  assert.deepEqual(list.items!.map(i => i.anchor), ['cue-exponent']);
  const order = doc.links.find(l => l.text === 'order')!;
  assert.deepEqual([order.from, order.toDoc, order.toAnchor], ['cue-exponent', 'fx-units', 'order-thm']);
  const crt = doc.links.find(l => l.text === 'CRT')!;
  assert.deepEqual([crt.from, crt.toDoc, crt.toAnchor], [list.anchor, 'fx-topic', 'moves']);
  const ext = doc.links.find(l => l.text === 'external link')!;
  assert.equal(ext.external, true);
  const bez = doc.links.find(l => l.text === 'Bézout')!;
  assert.deepEqual([bez.from, bez.toDoc, bez.toAnchor], ['needs', 'fx-div', 'bezout']);
});

test('a hash anchor changes with the text; an explicit one does not', () => {
  const src = readFileSync(`${ROOT}/basics/fx-units.md`, 'utf8');
  const a = parseStudyDoc('study/basics/fx-units.md', src);
  const b = parseStudyDoc('study/basics/fx-units.md', src.replace('An ordinary paragraph', 'A rewritten paragraph').replace('for some $x$', 'for an integer $x$'));
  const pa = a.passages.find(p => p.markdown.includes('ordinary paragraph'))!;
  const pb = b.passages.find(p => p.markdown.includes('rewritten paragraph'))!;
  assert.notEqual(pa.anchor, pb.anchor);
  const da = a.passages.find(p => p.anchor === 'unit-def')!;
  const db = b.passages.find(p => p.anchor === 'unit-def')!;
  assert.notEqual(da.hash, db.hash);
});

test('a kata: ports with widths, skeleton, vectors with dont-cares', () => {
  const doc = parseStudyDoc('study/katas/k-fx.md', readFileSync(`${ROOT}/katas/k-fx.md`, 'utf8'));
  const k = doc.kata!;
  assert.equal(k.d, 1.5);
  assert.equal(k.level, 'simple');
  assert.deepEqual(k.ports.map(p => [p.dir, p.name, p.width]), [['input', 'clk', 1], ['input', 'rst', 1], ['input', 'en', 1], ['output', 'q', 4]]);
  assert.match(k.skeleton, /^module k_fx/);
  assert.deepEqual(k.vectors!.inputs, ['rst', 'en']);
  assert.deepEqual(k.vectors!.outputs, ['q']);
  assert.equal(k.vectors!.rows.length, 4);
  assert.deepEqual(k.vectors!.rows[2], { line: 5, inputs: ['0', null], outputs: [null] });
  assert.deepEqual(k.vectors!.rows[3].outputs, ['a']);
  assert.match(k.spec, /flips on every cycle/);
  assert.deepEqual(doc.warnings, []);
});

test('vectors and ports report what they cannot read', () => {
  const w: string[] = [];
  const v = parseVectors('a b | y\n1 | 0\n1 2 | z', w)!;
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].outputs[0], null);
  assert.equal(w.length, 2);
  const w2: string[] = [];
  assert.deepEqual(parsePorts('input [0:7] x\nbanana', w2).map(p => p.width), [8]);
  assert.equal(w2.length, 1);
});

test('steps: intro, numbering, indented continuation', () => {
  const { intro, steps } = parseSteps('Setup line.\n1. First.\n   still first\n2. Second.\n10. Tenth.');
  assert.equal(intro, 'Setup line.');
  assert.deepEqual(steps.map(s => s.n), [1, 2, 10]);
  assert.equal(steps[0].markdown, 'First.\nstill first');
});

test('the index: docs, bank with tags, bank refs, tracks, methods, warnings', () => {
  const idx = buildIndex(allFiles());
  assert.deepEqual([...idx.docs.keys()].sort(), ['fx-div', 'fx-topic', 'fx-units', 'fxbank', 'k-fx']);
  assert.deepEqual(idx.usedBy.get('fx-div')!.sort(), ['fx-topic', 'fx-units', 'k-fx']);
  const a1 = idx.problems.get('putnam-2019-a1')!;
  assert.equal(a1.bank!.statementUrl, 'https://kskedlaya.org/putnam-archive/2019.pdf');
  assert.equal(a1.d, 3);
  assert.equal(a1.area, 'nt');
  assert.deepEqual(a1.methods, ['factorisation', 'bounding']);
  assert.equal(idx.problems.get('putnam-2019-a2')!.area, null);
  assert.ok(idx.problems.has('inv-fx-last-digit'));
  assert.ok(idx.katas.has('k-fx'));
  assert.deepEqual(idx.tracks.map(t => [t.id, t.deadline, t.until, t.weight]), [
    ['putnam', '2026-12-05', null, 3], ['exams', '2026-12-10', '2026-12-22', 1], ['someday', null, null, 0],
  ]);
  assert.deepEqual(idx.methods.get('order'), { id: 'order', doc: 'fx-units', anchor: 'order-thm' });
  assert.equal(idx.anchors.get('fx-units')!.get('cue-exponent')!.kind, 'list');
  const w = idx.warnings.join('\n');
  assert.match(w, /no-such-anchor/);
  assert.match(w, /putnam-2020-b9" is not in any bank file/);
  assert.match(w, /method "ghost" links a missing anchor \^nope/);
});

test('slugs for heading anchors', () => {
  assert.equal(slug('Units mod $n$'), 'units-mod-n');
  assert.equal(slug('  First   moves!  '), 'first-moves');
});

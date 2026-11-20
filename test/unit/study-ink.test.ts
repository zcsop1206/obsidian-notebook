// Anchored ink (S4, SPEC.md Storage: Ink): the file format, the union of device files, anchoring
// arithmetic, follow / dim / orphan across two builds of a fixture doc, and own-device undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStudyDoc } from '../../src/study/format/parse';
import type { InkStroke } from '../../src/study/view/host';
import {
  CHANGED_ALPHA, MIN_STEP, addSamples, anchorStroke, canvasScale, changedByAnchor, colorToken, deviceOf, docAnchors, inkPath,
  lastOwnIndex, nearestAnchor, newStrokeId, orphanGroups, pageBand, parseInkFile, placeStroke, reanchorCounts, serializeInkFile,
  strokeState, unionStrokes, type AnchorTop, type InkPoint,
} from '../../src/study/ink/model';
import { DocInkStore, unreadablePath, type InkAdapter } from '../../src/study/ink/store';

const V1_TEXT = readFileSync('test/fixtures/study/basics/fx-units.md', 'utf8').replace(/\r\n/g, '\n');

/** Build 3 of fx-units: a paragraph inserted at the top, Theorem 1 reworded, the example gone, a list item rewritten. */
function v2Text(): string {
  let t = V1_TEXT.replace('build: 2', 'build: 3');
  t = t.replace('## Units\n', '## Units\n\nA new opening paragraph, added in build 3.\n');
  t = t.replace('$a$ is a unit mod $n$ if and only if $\\gcd(a, n) = 1$.', '$a$ is invertible mod $n$ exactly when $\\gcd(a, n) = 1$.');
  t = t.replace(/> \[!example\] Powers of 2 mod 7\n> Find the order of \$2\$ mod \$7\$.\n\^ex-order\n\n> \[!solution\]- Solution\n> \$2, 4, 1\$: the order is \$3\$.\n\n/, '');
  t = t.replace('- An ordinary item with an [external link](https://example.org/x.pdf).', '- An ordinary item, reworded, with an [external link](https://example.org/x.pdf).');
  return t;
}

const V1 = parseStudyDoc('study/basics/fx-units.md', V1_TEXT);
const V2 = parseStudyDoc('study/basics/fx-units.md', v2Text());

/** Tops in document order, `step` apart from `start`; list items 10 px under their list. */
function tops(doc: typeof V1, start: number, step: number): AnchorTop[] {
  const out: AnchorTop[] = [];
  let y = start;
  for (const p of doc.passages) {
    if (p.kind === 'label' || p.kind === 'rule') continue;
    out.push({ a: p.anchor, top: y });
    for (const it of p.items ?? []) out.push({ a: it.anchor, top: y + 10 });
    y += step;
  }
  return out;
}
const topOf = (t: AnchorTop[]) => (a: string) => t.find(x => x.a === a)?.top ?? null;

function stroke(id: string, y: number, extra: Partial<InkStroke> = {}): InkStroke {
  return { id, p: [[100, y, 0.5, 0], [140, y + 6, 0.5, 16], [180, y + 2, 0.5, 32]], t0: 1000, blk: null, ...extra };
}

test('ink: paths, and the device from a file name', () => {
  assert.equal(inkPath('study', 'fx-units', 'ipad'), 'study/ink/fx-units.ipad.json');
  assert.equal(inkPath('/study/', 'a.b', 'desktop'), 'study/ink/a.b.desktop.json');
  assert.equal(deviceOf('study/ink/fx-units.ipad.json', 'study', 'fx-units'), 'ipad');
  assert.equal(deviceOf('study/ink/a.b.desktop.json', 'study', 'a.b'), 'desktop');
  assert.equal(deviceOf('study/ink/fx-units-2.ipad.json', 'study', 'fx-units'), null);
  assert.equal(deviceOf('study/ink/fx-units.x.ipad.json', 'study', 'fx-units'), null);
  assert.equal(deviceOf('study/log/ipad.jsonl', 'study', 'fx-units'), null);
});

test('ink: the file round-trips, rounds points, and survives garbage', () => {
  const s: InkStroke = { id: 's-1', p: [[1.234, 5.678, 0.4567, 12.6]], t0: 9, at: { a: 'order-thm', dy: 31.5, rev: '9f2c11ab', v: 2 }, e: 1, blk: null, dev: 'ipad' };
  const text = serializeInkFile('fx-units', [s, { id: 's-2', p: [[0, 0, 0.5, 0]], t0: 10, blk: 'fog:p-unit-gcd' }], ['laptop:s-9'], { 'laptop:s-8': 'abcd1234' });
  const f = parseInkFile(text, 'fx-units');
  assert.equal(f.v, 1);
  assert.equal(f.doc, 'fx-units');
  assert.deepEqual(f.strokes[0], { id: 's-1', p: [[1.2, 5.7, 0.46, 13]], t0: 9, at: { a: 'order-thm', dy: 31.5, rev: '9f2c11ab', v: 2 }, e: 1, blk: null });
  assert.equal(f.strokes[1].blk, 'fog:p-unit-gcd');
  assert.equal('dev' in f.strokes[0], false, 'the file name carries the device');
  assert.deepEqual(f.hide, ['laptop:s-9']);
  assert.deepEqual(f.keep, { 'laptop:s-8': 'abcd1234' });
  assert.match(text, /^\{"v": 1, "doc": "fx-units", "strokes": \[\n {2}\{/);
  assert.deepEqual(parseInkFile('not json', 'x'), { v: 1, doc: 'x', strokes: [] });
  assert.deepEqual(parseInkFile('{"strokes": [{"id": "a"}, {"id": "b", "p": [["x", 1]]}, 5]}', 'x').strokes, []);
  assert.deepEqual(parseInkFile('{"strokes": [{"id": "c", "p": [[1, 2]]}]}', 'x').strokes[0].p, [[1, 2, 0.5, 0]]);
});

test('ink: the union of device files, with hides and keeps', () => {
  const ipad = { v: 1, doc: 'd', strokes: [stroke('s-a', 10, { t0: 3 }), stroke('s-b', 20, { t0: 1, at: { a: 'x', dy: 0, rev: 'old', v: 1 } })], hide: ['laptop:s-c'] };
  const laptop = { v: 1, doc: 'd', strokes: [stroke('s-c', 30, { t0: 2 }), stroke('s-a', 40, { t0: 4 })], keep: { 'ipad:s-b': 'new' } };
  const u = unionStrokes([{ dev: 'ipad', file: ipad }, { dev: 'laptop', file: laptop }]);
  assert.deepEqual(u.map(s => `${s.dev}:${s.id}`), ['ipad:s-b', 'ipad:s-a', 'laptop:s-a'], 'sorted by t0; the hidden stroke is gone; same id on two devices are two strokes');
  assert.equal(u[0].at!.rev, 'new', 'a keep from another device applies');
  assert.equal(ipad.strokes[1].at!.rev, 'old', 'the files are not mutated');
  const dup = unionStrokes([{ dev: 'ipad', file: ipad }, { dev: 'ipad', file: ipad }]);
  assert.equal(dup.length, 2, 'duplicates by device and id collapse');
});

test('ink: anchoring arithmetic', () => {
  const t: AnchorTop[] = [{ a: 'h', top: 0 }, { a: 'p1', top: 100 }, { a: 'hidden', top: null }, { a: 'p2', top: 200 }, { a: 'item', top: 200 }];
  const at = (y0: number, y1: number) => nearestAnchor([[0, y0], [10, y1]], t)?.a ?? null;
  assert.equal(at(120, 160), 'p1', 'centre 140: the passage at or above');
  assert.equal(at(90, 120), 'p1', 'centre 105');
  assert.equal(at(96, 100), 'p1', 'centre 98: within the 2 px slop of p1');
  assert.equal(at(90, 100), 'h', 'centre 95: still above p1');
  assert.equal(at(250, 260), 'item', 'a tie goes to the later anchor (the item over its list)');
  assert.equal(at(-50, -40), 'h', 'above everything: the topmost');
  assert.equal(nearestAnchor([[0, 10]], [{ a: 'x', top: null }]), null);
  const revs = new Map([['p1', 'aaaa0000']]);
  assert.deepEqual(anchorStroke([[0, 130], [5, 150]], t, revs, 4), { a: 'p1', dy: 100, rev: 'aaaa0000', v: 4 });
  assert.deepEqual(anchorStroke([[0, 130]], [{ a: 'q', top: 33.333 }], revs, 1), { a: 'q', dy: 33.3, rev: '', v: 1 });
});

test('ink: the fixture doc anchors passages and list items by their own text', () => {
  const r1 = docAnchors(V1), r2 = docAnchors(V2);
  assert.ok(r1.has('unit-gcd') && r1.has('order-thm') && r1.has('ex-order') && r1.has('cue-exponent'));
  assert.ok(!r2.has('ex-order'), 'the example is gone in build 3');
  assert.notEqual(r1.get('unit-gcd'), r2.get('unit-gcd'), 'Theorem 1 was reworded');
  assert.equal(r1.get('order-thm'), r2.get('order-thm'));
  assert.equal(r1.get('cue-exponent'), r2.get('cue-exponent'), 'a sibling item changed, this item did not');
  const list1 = V1.passages.find(p => p.items?.some(i => i.anchor === 'cue-exponent'))!;
  const list2 = V2.passages.find(p => p.items?.some(i => i.anchor === 'cue-exponent'))!;
  assert.notEqual(list1.hash, list2.hash, 'the list as a whole changed');
  assert.equal([...r1.keys()].indexOf('cue-exponent'), [...r1.keys()].indexOf(list1.anchor) + 1, 'items come right after their list');
});

test('ink: reanchor across two builds: follow, dim, orphan', () => {
  const t1 = tops(V1, 50, 100);
  const r1 = docAnchors(V1);
  const yOf = (a: string) => topOf(t1)(a)!;
  const mk = (id: string, a: string) => {
    const s = stroke(id, yOf(a) + 12);
    s.at = anchorStroke(s.p, t1, r1, V1.build)!;
    return s;
  };
  const strokes = [mk('s-gcd', 'unit-gcd'), mk('s-ord', 'order-thm'), mk('s-ex', 'ex-order'), mk('s-cue', 'cue-exponent'), { ...stroke('s-blk', 5), blk: 'fog:p-unit-gcd' }];
  assert.deepEqual(strokes.slice(0, 4).map(s => s.at!.a), ['unit-gcd', 'order-thm', 'ex-order', 'cue-exponent']);
  assert.deepEqual(reanchorCounts(strokes, r1, V1.build), { moved: 0, changed: 0, orphaned: 0 }, 'same build: nothing to report');

  const r2 = docAnchors(V2);
  const t2 = tops(V2, 80, 100);
  assert.deepEqual(reanchorCounts(strokes, r2, V2.build), { moved: 2, changed: 1, orphaned: 1 });
  assert.deepEqual(strokes.map(s => strokeState(s, r2)), ['changed', 'follow', 'orphan', 'follow', 'free']);

  const strip = (a: string) => (a === 'ex-order' ? { top: 5000, minY: yOf('ex-order') + 12 } : null);
  const ord = placeStroke(strokes[1], r2, topOf(t2), strip)!;
  assert.equal(ord.dy, topOf(t2)('order-thm')! - yOf('order-thm'), 'follows: drawn at y + (top now - top then)');
  assert.ok(ord.dy > 0, 'the inserted paragraph pushed it down');
  assert.equal(ord.alpha, 1);
  const gcd = placeStroke(strokes[0], r2, topOf(t2), strip)!;
  assert.equal(gcd.alpha, CHANGED_ALPHA, 'rewritten text: dimmed');
  assert.equal(gcd.dy, topOf(t2)('unit-gcd')! - yOf('unit-gcd'));
  const ex = placeStroke(strokes[2], r2, topOf(t2), strip)!;
  assert.equal(strokes[2].p[0][1] + ex.dy, 5000, 'orphan: the group starts at the top of its strip space');
  assert.equal(placeStroke(strokes[2], r2, topOf(t2), () => null), null, 'no strip yet: not drawn');
  assert.equal(placeStroke(strokes[1], r2, () => null, strip), null, 'a hidden anchor (fog) hides its ink');

  const groups = orphanGroups(strokes, r2);
  assert.deepEqual(groups.map(g => [g.a, g.strokes.length]), [['ex-order', 1]]);
  assert.deepEqual([...changedByAnchor(strokes, r2).keys()], ['unit-gcd']);
});

test('ink: own-device undo and the stroke ids', () => {
  const l: InkStroke[] = [
    { ...stroke('a', 0), dev: 'ipad', t0: 1 }, { ...stroke('b', 0), dev: 'laptop', t0: 5 },
    { ...stroke('c', 0), dev: 'ipad', t0: 3 }, { ...stroke('d', 0), dev: 'ipad', t0: 9, blk: 'call:p1' },
  ];
  assert.equal(lastOwnIndex(l, 'ipad', null), 2);
  assert.equal(lastOwnIndex(l, 'ipad', 'call:p1'), 3);
  assert.equal(lastOwnIndex(l, 'laptop', 'call:p1'), -1);
  assert.match(newStrokeId(), /^s-[0-9a-z]{8}$/);
  assert.equal(newStrokeId(36 ** 4 + 35, () => 0.999), 's-000zzzzz');
});

test('ink: sampling keeps every coalesced sample once, in paper px', () => {
  const pts: InkPoint[] = [];
  const m = { left: 10, top: 20, k: 2, t0: 100, mouse: false };
  let last = -Infinity;
  last = addSamples(pts, last, [{ clientX: 10, clientY: 20, pressure: 0.3, timeStamp: 100 }], m);
  last = addSamples(pts, last, [
    { clientX: 15, clientY: 20, pressure: 0.4, timeStamp: 104 },
    { clientX: 12, clientY: 20, pressure: 0.4, timeStamp: 102 }, // older than the last: a WebKit repeat
    { clientX: 15.05, clientY: 20, pressure: 0.4, timeStamp: 105 }, // within MIN_STEP
    { clientX: 20.123, clientY: 25, pressure: 0, timeStamp: 108.6 },
  ], m);
  assert.deepEqual(pts, [[0, 0, 0.3, 0], [10, 0, 0.4, 4], [20.2, 10, 0.5, 9]]);
  assert.equal(last, 108.6);
  assert.ok(MIN_STEP > 0.05 * 2);
  const mouse: InkPoint[] = [];
  addSamples(mouse, -Infinity, [{ clientX: 0, clientY: 0, pressure: 0.9, timeStamp: 0 }], { ...m, left: 0, top: 0, mouse: true });
  assert.equal(mouse[0][2], 0.5, 'the mouse has pressure 0.5');
});

test('ink: canvas scale and the page band stay within 16 M pixels', () => {
  assert.equal(canvasScale(2, 800, 400), 2);
  const k = canvasScale(2.4, 920, 20000);
  assert.ok(920 * 20000 * k * k <= 16e6 + 1);
  const short = pageBand(3000, 0, 1000, 920, 2.4);
  assert.deepEqual([short.top, short.height, short.k], [0, 3000, 2.4], 'a page that fits is drawn whole');
  const b = pageBand(20000, 9000, 10100, 920, 2.4);
  assert.ok(b.top <= 9000 && b.top + b.height >= 10100, 'covers the visible part');
  assert.ok(920 * b.height * b.k * b.k <= 16e6 + 920 * b.k * b.k, 'within the budget');
  assert.equal(b.k, 2.4, 'full resolution');
  const end = pageBand(20000, 19500, 20600, 920, 2.4);
  assert.equal(end.top + end.height, 20000, 'clamped to the page end');
  const huge = pageBand(50000, 0, 20000, 920, 2.4);
  assert.ok(huge.k < 2.4 && 920 * 20000 * huge.k * huge.k <= 16e6 + 1, 'a visible part over budget lowers k');
  assert.deepEqual(colorToken('--ink'), { token: '--ink', fallback: null });
  assert.deepEqual(colorToken('var(--x, #123)'), { token: '--x', fallback: '#123' });
  assert.equal(colorToken('#abc'), null);
});

/** An in-memory DataAdapter. */
function fakeAdapter(files: Map<string, string>, dirs = new Set<string>()): InkAdapter & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async read(p) { const t = files.get(p); if (t === undefined) throw new Error('ENOENT ' + p); return t; },
    async write(p, d) { files.set(p, d); writes.push(p); },
    async list(p) {
      const kid = (q: string) => q.startsWith(p + '/') && !q.slice(p.length + 1).includes('/');
      return { files: [...files.keys()].filter(kid), folders: [...dirs].filter(kid) };
    },
  };
}

test('ink store: union of device files, writes only its own, own-device undo', async () => {
  const files = new Map<string, string>();
  files.set('study/ink/fx-units.laptop.json', serializeInkFile('fx-units', [stroke('s-lap', 300, { t0: 5, at: { a: 'order-thm', dy: 250, rev: 'x', v: 2 } })]));
  files.set('study/ink/fx-div.laptop.json', serializeInkFile('fx-div', [stroke('s-other-doc', 1)]));
  const ad = fakeAdapter(files, new Set(['study', 'study/ink']));
  const st = new DocInkStore(ad, 'study', 'ipad', 'fx-units');
  // A stroke written before the files finished loading is kept.
  st.add({ ...stroke('s-early', 100), t0: 10 });
  await st.ready;
  assert.deepEqual(st.strokes().map(s => `${s.dev}:${s.id}`), ['laptop:s-lap', 'ipad:s-early']);
  st.add({ ...stroke('s-call', 0), t0: 20, blk: 'call:p1' });
  st.add({ ...stroke('s-late', 120), t0: 30 });
  assert.equal(st.strokesOf(null).length, 3);
  assert.equal(st.strokesOf('call:p1').length, 1);
  await st.flush();
  assert.deepEqual(ad.writes, ['study/ink/fx-units.ipad.json'], 'only this device\'s file is written');
  const own = parseInkFile(files.get('study/ink/fx-units.ipad.json')!, 'fx-units');
  assert.deepEqual(own.strokes.map(s => s.id), ['s-early', 's-call', 's-late']);

  assert.equal(st.undo(null)!.id, 's-late', 'undo: this device\'s latest page stroke');
  assert.equal(st.undo(null)!.id, 's-early');
  assert.equal(st.undo(null), null, 'the laptop\'s stroke is never undone here');
  assert.deepEqual(st.strokesOf(null).map(s => s.id), ['s-lap']);
  assert.equal(st.strokesOf('call:p1').length, 1, 'undo on the page leaves block ink alone');

  // Keep and delete of another device's stroke go to this device's file.
  assert.equal(st.keep(['laptop:s-lap'], 'newrev', 3), 1);
  assert.equal(st.strokesOf(null)[0].at!.rev, 'newrev');
  await st.flush();
  assert.deepEqual(parseInkFile(files.get('study/ink/fx-units.ipad.json')!, 'fx-units').keep, { 'laptop:s-lap': 'newrev' });
  assert.equal(st.remove(['laptop:s-lap']), 1);
  assert.deepEqual(st.strokesOf(null), []);
  await st.flush();
  assert.equal(JSON.parse(files.get('study/ink/fx-units.laptop.json')!).strokes.length, 1, 'the laptop\'s file is untouched');
  assert.deepEqual(parseInkFile(files.get('study/ink/fx-units.ipad.json')!, 'fx-units').hide, ['laptop:s-lap']);

  // A sync brings a new laptop stroke: re-read on the vault event.
  files.set('study/ink/fx-units.laptop.json', serializeInkFile('fx-units', [stroke('s-lap', 300), stroke('s-lap2', 400, { t0: 50 })]));
  let why = '';
  st.onChange(w => { why = w; });
  assert.equal(await st.reload('study/ink/fx-units.laptop.json'), true);
  assert.equal(why, 'sync');
  assert.deepEqual(st.strokesOf(null).map(s => s.id), ['s-lap2'], 'still hidden: s-lap; new: s-lap2');
  assert.equal(await st.reload('study/ink/fx-units.ipad.json'), false, 'own-file events are our own writes');
  assert.equal(await st.reload('study/ink/fx-div.laptop.json'), false, 'another doc');

  // A fresh store (a reload of the plugin) reads back the same union.
  const again = new DocInkStore(ad, 'study', 'ipad', 'fx-units');
  await again.ready;
  assert.deepEqual(again.strokes().map(s => `${s.dev}:${s.id}`), st.strokes().map(s => `${s.dev}:${s.id}`));
});

test('ink store: creates the ink folder, and writes nothing when nothing changed', async () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const ad = fakeAdapter(files, dirs);
  const st = new DocInkStore(ad, 'notes/study', 'desktop', 'fx-div');
  await st.ready;
  await st.flush();
  assert.deepEqual(ad.writes, []);
  st.add(stroke('s-1', 1));
  await st.flush();
  assert.ok(dirs.has('notes') && dirs.has('notes/study') && dirs.has('notes/study/ink'));
  assert.deepEqual(ad.writes, ['notes/study/ink/fx-div.desktop.json']);
  await st.flush();
  assert.equal(ad.writes.length, 1, 'no second write without a change');
});

/** Runs `fn` with console.error silenced (the store logs the reads it could not make). */
async function quietly(fn: () => Promise<void>): Promise<void> {
  const errors = console.error;
  console.error = () => {};
  try { await fn(); } finally { console.error = errors; }
}

test('ink store: an own file whose read failed at load is read again before the first write and merged, never written over', async () => {
  const files = new Map<string, string>();
  const own = 'study/ink/fx-units.ipad.json';
  files.set(own, serializeInkFile('fx-units', [stroke('s-old', 50, { t0: 1 })], ['laptop:s-x'], { 'laptop:s-y': 'disk', 'laptop:s-z': 'z' }));
  const ad = fakeAdapter(files, new Set(['study', 'study/ink']));
  const read = ad.read.bind(ad);
  let fails = 1;
  ad.read = async p => { if (p === own && fails > 0) { fails--; throw new Error('EIO'); } return read(p); };
  await quietly(async () => {
    const st = new DocInkStore(ad, 'study', 'ipad', 'fx-units');
    await st.ready;
    assert.deepEqual(st.strokes(), [], 'the read failed: nothing shown');
    const told: string[] = [];
    st.onChange(w => { told.push(w); });
    assert.equal(st.keep(['laptop:s-y'], 'mine', 3), 1);
    st.add(stroke('s-new', 100, { t0: 2 }));
    await st.flush();
    const f = parseInkFile(files.get(own)!, 'fx-units');
    assert.deepEqual(f.strokes.map(s => s.id), ['s-old', 's-new'], 'the file\'s strokes merged in, not written over');
    assert.deepEqual(f.hide, ['laptop:s-x'], 'its hides kept');
    assert.deepEqual(f.keep, { 'laptop:s-y': 'mine', 'laptop:s-z': 'z' }, 'its keeps kept, a keep made here wins');
    assert.deepEqual(st.strokes().map(s => `${s.dev}:${s.id}`), ['ipad:s-old', 'ipad:s-new'], 'the merged strokes show');
    assert.ok(told.includes('sync'), 'its surfaces are told');
    assert.equal(st.pending(), false);
  });
});

test('ink store: while its own file still cannot be read, nothing is written and the change waits', async () => {
  const files = new Map<string, string>();
  const own = 'study/ink/fx-units.ipad.json';
  const before = serializeInkFile('fx-units', [stroke('s-old', 50, { t0: 1 })]);
  files.set(own, before);
  const ad = fakeAdapter(files, new Set(['study', 'study/ink']));
  const read = ad.read.bind(ad);
  let failing = true;
  ad.read = async p => { if (p === own && failing) throw new Error('EIO'); return read(p); };
  await quietly(async () => {
    const st = new DocInkStore(ad, 'study', 'ipad', 'fx-units');
    await st.ready;
    st.add(stroke('s-new', 100, { t0: 2 }));
    await st.flush();
    assert.deepEqual(ad.writes, [], 'the read throws again: not written');
    assert.equal(files.get(own), before);
    assert.equal(st.pending(), true, 'the change waits, as after a failed write');
    failing = false;
    await st.flush();
    assert.deepEqual(parseInkFile(files.get(own)!, 'fx-units').strokes.map(s => s.id), ['s-old', 's-new'], 'once readable: merged, then written');
    assert.equal(st.pending(), false);
  });
});

test('ink store: after a failed listing, the first write reads its own file and merges it', async () => {
  const files = new Map<string, string>();
  const own = 'study/ink/fx-div.desktop.json';
  files.set(own, serializeInkFile('fx-div', [stroke('s-old', 50, { t0: 1 })]));
  const ad = fakeAdapter(files, new Set(['study', 'study/ink']));
  ad.list = async () => { throw new Error('EIO'); };
  await quietly(async () => {
    const st = new DocInkStore(ad, 'study', 'desktop', 'fx-div');
    await st.ready;
    assert.deepEqual(st.strokes(), []);
    st.add(stroke('s-new', 100, { t0: 2 }));
    await st.flush();
    assert.deepEqual(parseInkFile(files.get(own)!, 'fx-div').strokes.map(s => s.id), ['s-old', 's-new']);
    assert.deepEqual(st.strokes().map(s => s.id), ['s-old', 's-new']);
  });
});

test('ink store: an own file that is not JSON is saved beside it before the first write replaces it', async () => {
  const files = new Map<string, string>();
  const own = 'study/ink/fx-units.ipad.json';
  const broken = '{"v": 1, "doc": "fx-units", "strokes": [\n  {"id": "s-old", "p": [[1, 2, 0.5, 0], [3, 4';
  files.set(own, broken);
  const ad = fakeAdapter(files, new Set(['study', 'study/ink']));
  const st = new DocInkStore(ad, 'study', 'ipad', 'fx-units');
  await st.ready;
  st.add(stroke('s-new', 100, { t0: 2 }));
  await st.flush();
  const copies = () => [...files.keys()].filter(p => p.includes('.unreadable-'));
  assert.equal(copies().length, 1);
  assert.match(copies()[0], /^study\/ink\/fx-units\.ipad\.json\.unreadable-\d{8}-\d{6}\.txt$/, 'beside the file, never .json');
  assert.equal(files.get(copies()[0]), broken, 'its text as it was');
  assert.deepEqual(ad.writes, [copies()[0], own], 'the copy is saved before the file is written');
  assert.deepEqual(parseInkFile(files.get(own)!, 'fx-units').strokes.map(s => s.id), ['s-new']);
  st.add(stroke('s-2', 200, { t0: 3 }));
  await st.flush();
  assert.equal(copies().length, 1, 'saved once');
  const again = new DocInkStore(ad, 'study', 'ipad', 'fx-units');
  await again.ready;
  assert.deepEqual(again.strokes().map(s => s.id), ['s-new', 's-2'], 'the copy is not read as ink');
  // A blank file holds nothing to lose: written over directly.
  files.set('study/ink/fx-div.ipad.json', '  \n');
  const blank = new DocInkStore(ad, 'study', 'ipad', 'fx-div');
  await blank.ready;
  blank.add(stroke('s-b', 10));
  await blank.flush();
  assert.equal(copies().length, 1, 'no copy of a blank file');
  assert.deepEqual(parseInkFile(files.get('study/ink/fx-div.ipad.json')!, 'fx-div').strokes.map(s => s.id), ['s-b']);
  assert.equal(unreadablePath('study/ink/a.ipad.json', new Date(2026, 10, 18, 9, 5, 7)), 'study/ink/a.ipad.json.unreadable-20261118-090507.txt');
});

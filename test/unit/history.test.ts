// Undo and redo (#8): the History stack, the store operations the view's undo records use
// (removeStrokes/insertStrokes, removePageFromIndex/insertPageInIndex, setNoteTemplateName),
// and the two- and three-finger taps of gestures.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { newPage, writePage, type Page } from '../../src/format/page';
import { parseTemplateName } from '../../src/format/template';
import { FingerTaps, TAP_MS, TAP_SLOP, type TouchEventLike, type TouchLike } from '../../src/ink/gestures';
import { History, type Op } from '../../src/ink/history';
import { NoteStore, type NoteFiles } from '../../src/ink/store';
import { randomPage } from './helpers';
import { seeded } from '../seeded';

// ---- History

/** An op that appends to `log` when undone or redone. */
const op = (label: string, log: string[]): Op => ({ label, undo: () => log.push('undo ' + label), redo: () => log.push('redo ' + label) });

test('history: undo reverses the latest edit first, redo repeats in order', () => {
  const log: string[] = [];
  let changes = 0;
  const h = new History(() => changes++);
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
  h.push(op('a', log));
  h.push(op('b', log));
  h.push(op('c', log));
  assert.deepEqual(h.labels, ['a', 'b', 'c']);
  assert.equal(h.canUndo, true);
  assert.equal(h.undo()!.label, 'c');
  assert.equal(h.undo()!.label, 'b');
  assert.equal(h.canRedo, true);
  assert.equal(h.redo()!.label, 'b');
  assert.equal(h.undo()!.label, 'b');
  assert.equal(h.undo()!.label, 'a');
  assert.equal(h.undo(), null);
  assert.equal(h.canUndo, false);
  assert.equal(h.redo()!.label, 'a');
  assert.equal(h.redo()!.label, 'b');
  assert.equal(h.redo()!.label, 'c');
  assert.equal(h.redo(), null);
  assert.deepEqual(log, ['undo c', 'undo b', 'redo b', 'undo b', 'undo a', 'redo a', 'redo b', 'redo c']);
  assert.equal(changes, 3 + 8); // pushes and successful undos/redos
});

test('history: a push clears what could be redone; clear forgets everything', () => {
  const log: string[] = [];
  const h = new History();
  h.push(op('a', log));
  h.push(op('b', log));
  h.undo();
  assert.equal(h.canRedo, true);
  h.push(op('c', log));
  assert.equal(h.canRedo, false);
  assert.equal(h.redo(), null);
  assert.deepEqual(h.labels, ['a', 'c']);
  h.undo();
  h.clear();
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), null);
  assert.deepEqual(log, ['undo b', 'undo c']);
});

test('history: an op whose undo throws is dropped, and the error comes through', () => {
  const h = new History();
  const log: string[] = [];
  h.push(op('a', log));
  h.push({ label: 'bad', undo: () => { throw new Error('boom'); }, redo: () => {} });
  assert.throws(() => h.undo(), /boom/);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo()!.label, 'a');
});

// ---- store operations

class MemFiles implements NoteFiles {
  files = new Map<string, string>();
  writes = 0;
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.writes++;
    this.files.set(path, text);
  }
  list(folder: string) {
    return [...this.files.keys()].filter(k => k.startsWith(folder + '/')).map(k => k.slice(folder.length + 1));
  }
}

async function openNote(pages: Page[]) {
  const files = new MemFiles();
  const note = newNote('lec', 'letter');
  note.pages = pages.map(p => p.id);
  files.files.set('dir/lec.md', writeNote(note));
  for (const p of pages) files.files.set(`dir/lec/${p.id}.svg`, writePage(p));
  const notices: string[] = [];
  const store = new NoteStore(files, 'dir/lec.md', 'lec', {
    pageChanged: () => {}, indexChanged: () => {}, notice: m => notices.push(m), saved: () => {},
  }, { delay: 1000, maxDelay: 5000, newId: taken => `p-${(taken.size + 0xa0).toString(16).padStart(6, '0')}` });
  await store.load();
  return { files, store, notices };
}

test('store: removeStrokes returns the removed strokes with their indices; insertStrokes puts them back exactly', async () => {
  const page = randomPage(seeded(8), 12, 'mixed');
  const { files, store } = await openNote([page]);
  const path = `dir/lec/${page.id}.svg`;
  const original = files.files.get(path)!;
  const ids = page.strokes.map(s => s.id);
  const gone = [ids[9], ids[0], ids[4], 'nope'];
  const removed = store.removeStrokes(page.id, gone);
  assert.deepEqual(removed.map(e => e.index), [0, 4, 9]);
  assert.deepEqual(removed.map(e => e.stroke.id), [ids[0], ids[4], ids[9]]);
  assert.equal(store.unsaved, true);
  await store.flush();
  const without = files.files.get(path)!;
  assert.notEqual(without, original);
  assert.equal(store.page(store.slots[0])!.strokes.length, 9);
  store.insertStrokes(page.id, [...removed].reverse()); // any order: applied by ascending index
  await store.flush();
  assert.equal(files.files.get(path), original, 'the page file is byte-identical again');
  // Removed again, the same file as the first time.
  store.removeStrokes(page.id, gone);
  await store.flush();
  assert.equal(files.files.get(path), without);
  store.close();
});

test('store: removeStrokes of nothing changes nothing; insertStrokes skips strokes already there', async () => {
  const page = randomPage(seeded(9), 4, 'pen/uniform');
  const { files, store } = await openNote([page]);
  assert.deepEqual(store.removeStrokes(page.id, ['00000000']), []);
  assert.deepEqual(store.removeStrokes('p-ffffff', [page.strokes[0].id]), []);
  assert.equal(store.unsaved, false);
  const [first] = store.removeStrokes(page.id, [page.strokes[0].id]);
  store.insertStrokes(page.id, [first]);
  store.insertStrokes(page.id, [first]);
  await store.flush();
  assert.equal(files.files.get(`dir/lec/${page.id}.svg`), writePage(page));
  store.close();
});

test('store: removePageFromIndex and insertPageInIndex round trip restores the index file', async () => {
  const pages = [newPage('p-000001'), newPage('p-000002'), newPage('p-000003')];
  const { files, store } = await openNote(pages);
  const original = files.files.get('dir/lec.md')!;
  assert.deepEqual(store.removePageFromIndex('p-000002'), { index: 1 });
  assert.deepEqual(store.removePageFromIndex('p-00ffff'), { index: -1 });
  assert.deepEqual(store.slots.map(s => s.id), ['p-000001', 'p-000003']);
  await store.flush();
  assert.deepEqual(readNote(files.files.get('dir/lec.md')!, 'lec').pages, ['p-000001', 'p-000003']);
  assert.equal(files.files.has('dir/lec/p-000002.svg'), true, 'the page file stays on disk');
  store.insertPageInIndex('p-000002', 1);
  assert.deepEqual(store.slots.map(s => s.id), ['p-000001', 'p-000002', 'p-000003']);
  await store.flush();
  assert.equal(files.files.get('dir/lec.md'), original, 'the index is byte-identical again');
  assert.throws(() => store.insertPageInIndex('p-000009', 0), /not taken out/);
  store.close();
});

test('store: an added page taken out before it was saved is written when it comes back, and its id is not reused', async () => {
  const { files, store } = await openNote([newPage('p-000001')]);
  const slot = store.addPage(parseTemplateName('grid-5mm'));
  const { index } = store.removePageFromIndex(slot.id);
  assert.equal(index, 1);
  await store.flush();
  assert.equal(files.files.has(slot.path), false, 'not written while out of the index');
  assert.deepEqual(readNote(files.files.get('dir/lec.md')!, 'lec').pages, ['p-000001']);
  const other = store.addPage();
  assert.notEqual(other.id, slot.id);
  store.removePageFromIndex(other.id);
  store.insertPageInIndex(slot.id, index);
  await store.flush();
  assert.equal(files.files.has(slot.path), true);
  assert.deepEqual(readNote(files.files.get('dir/lec.md')!, 'lec').pages, ['p-000001', slot.id]);
  store.close();
});

test('store: setNoteTemplateName restores any name, even one that is not a template', async () => {
  const { files, store } = await openNote([newPage('p-000001')]);
  store.index.template = 'my-own';
  const before = store.setAllTemplates(parseTemplateName('dots-5mm'));
  assert.equal(before.note, 'my-own');
  assert.equal(store.setNoteTemplateName(before.note), 'dots-5mm');
  await store.flush();
  assert.equal(readNote(files.files.get('dir/lec.md')!, 'lec').template, 'my-own');
  store.close();
});

// ---- finger taps

const touch = (identifier: number, clientX: number, clientY: number, touchType = 'direct'): TouchLike => ({ identifier, clientX, clientY, touchType });
const ev = (type: string, timeStamp: number, touches: TouchLike[], changedTouches: TouchLike[]): TouchEventLike => ({ type, timeStamp, touches, changedTouches });

/** Runs a gesture of `n` fingers down at t0, moved by `move` px, up at t0 + `ms`. */
function gesture(taps: FingerTaps, n: number, { ms = 100, move = 0, touchType = 'direct', t0 = 1000 } = {}) {
  const down = Array.from({ length: n }, (_, i) => touch(i, 100 + 50 * i, 200, touchType));
  const moved = down.map(t => ({ ...t, clientX: t.clientX + move, clientY: t.clientY + move / 2 }));
  taps.handle(ev('touchstart', t0, down, down));
  if (move) taps.handle(ev('touchmove', t0 + ms / 2, moved, moved));
  taps.handle(ev('touchend', t0 + ms, [], moved));
}

test('gestures: two- and three-finger taps are reported; one finger, moves, slow taps and the Pencil are not', () => {
  const seen: number[] = [];
  const taps = new FingerTaps(n => seen.push(n));
  gesture(taps, 2);
  gesture(taps, 3);
  gesture(taps, 1);
  gesture(taps, 2, { move: 30 });
  gesture(taps, 2, { move: TAP_SLOP - 2 });
  gesture(taps, 2, { ms: TAP_MS + 50 });
  gesture(taps, 2, { touchType: 'stylus' });
  assert.deepEqual(seen, [2, 3, 2]);
});

test('gestures: fingers landing and lifting one after another make one tap', () => {
  const seen: number[] = [];
  const taps = new FingerTaps(n => seen.push(n));
  const a = touch(1, 100, 100), b = touch(2, 160, 100);
  taps.handle(ev('touchstart', 0, [a], [a]));
  taps.handle(ev('touchstart', 30, [a, b], [b]));
  taps.handle(ev('touchend', 120, [b], [a]));
  assert.deepEqual(seen, []);
  taps.handle(ev('touchend', 150, [], [b]));
  assert.deepEqual(seen, [2]);
  // A cancelled gesture is not a tap; the next one starts fresh.
  taps.handle(ev('touchstart', 500, [a, b], [a, b]));
  taps.handle(ev('touchcancel', 520, [], [a, b]));
  taps.handle(ev('touchstart', 600, [a, b], [a, b]));
  taps.handle(ev('touchend', 650, [], [a, b]));
  assert.deepEqual(seen, [2, 2]);
});

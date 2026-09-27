// The eraser (#7): its settings, and NoteStore.removeStrokes (what it returns, dirty marking).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage, type Stroke } from '../../src/format/page';
import { DEFAULT_ERASER, ERASER_SIZES, nextEraserSize, withEraser } from '../../src/ink/pen';
import { NoteStore, type NoteFiles } from '../../src/ink/store';

test('eraser: two sizes, default small; withEraser snaps to a preset; nextEraserSize wraps', () => {
  assert.deepEqual(ERASER_SIZES, [6, 14]);
  assert.deepEqual(DEFAULT_ERASER, { size: 6, mode: 'partial' });
  assert.equal(Object.isFrozen(DEFAULT_ERASER), true);
  assert.deepEqual(withEraser(DEFAULT_ERASER, { size: 14 }), { size: 14, mode: 'partial' });
  assert.deepEqual(withEraser(DEFAULT_ERASER, { size: 12 }), { size: 14, mode: 'partial' });
  assert.deepEqual(withEraser(DEFAULT_ERASER, { size: 1 }), { size: 6, mode: 'partial' });
  assert.deepEqual(withEraser({ size: 14, mode: 'stroke' }, {}), { size: 14, mode: 'stroke' });
  assert.throws(() => withEraser(DEFAULT_ERASER, { size: NaN }), /Invalid eraser size/);
  assert.deepEqual(withEraser(DEFAULT_ERASER, { mode: 'stroke' }), { size: 6, mode: 'stroke' });
  assert.throws(() => withEraser(DEFAULT_ERASER, { mode: 'pixel' as never }), /Invalid eraser mode "pixel"/);
  assert.equal(nextEraserSize(6), 14);
  assert.equal(nextEraserSize(14), 6);
});

class MemFiles implements NoteFiles {
  files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.files.set(path, text);
  }
  list(folder: string) {
    return [...this.files.keys()].filter(k => k.startsWith(folder + '/')).map(k => k.slice(folder.length + 1));
  }
}

const dot = (id: string, x: number): Stroke => ({ id, tool: 'pen', nib: 'uniform', color: '#000000', size: 2, points: [{ x, y: 10, p: 0.5, t: 0 }] });

test('store: removeStrokes removes by id, returns them with their indices in order, and marks the page', async () => {
  const files = new MemFiles();
  const page = newPage('p-000001');
  page.strokes = ['00000001', '00000002', '00000003', '00000004', '00000005'].map((id, i) => dot(id, 10 + i * 10));
  page.strokes[3] = { id: '00000004', tool: 'highlighter', color: '#ffd400', size: 20, points: [{ x: 40, y: 10, p: 0.5, t: 0 }] };
  const note = newNote('lec', 'letter');
  note.pages = [page.id];
  files.files.set('lec.md', writeNote(note));
  files.files.set('lec/p-000001.svg', writePage(page));
  const store = new NoteStore(files, 'lec.md', 'lec', { pageChanged() {}, indexChanged() {}, notice() {}, saved() {} }, { delay: 10000 });
  await store.load();

  // Nothing to remove: nothing changes, the page isn't marked.
  assert.deepEqual(store.removeStrokes('p-000001', ['ffffffff']), []);
  assert.deepEqual(store.removeStrokes('p-000001', []), []);
  assert.deepEqual(store.removeStrokes('p-999999', ['00000001']), []);
  assert.equal(store.unsaved, false);

  const model = store.page(store.slots[0])!;
  const removed = store.removeStrokes('p-000001', new Set(['00000004', '00000002', 'ffffffff']));
  assert.deepEqual(removed.map(r => [r.index, r.stroke.id, r.stroke.tool]), [[1, '00000002', 'pen'], [3, '00000004', 'highlighter']]);
  assert.deepEqual(model.strokes.map(s => s.id), ['00000001', '00000003', '00000005']);
  assert.equal(store.unsaved, true);
  await store.flush();
  assert.deepEqual(readPage(files.files.get('lec/p-000001.svg')!).strokes.map(s => s.id), ['00000001', '00000003', '00000005']);

  // Inserting them back at their indices, in order, restores the page.
  for (const r of removed) model.strokes.splice(r.index, 0, r.stroke);
  assert.deepEqual(model.strokes.map(s => s.id), ['00000001', '00000002', '00000003', '00000004', '00000005']);
  store.close();
});

test('store: replaceStroke puts the replacements at the stroke\'s index and marks the page (#15)', async () => {
  const files = new MemFiles();
  const page = newPage('p-000001');
  page.strokes = ['00000001', '00000002', '00000003'].map((id, i) => dot(id, 10 + i * 10));
  const note = newNote('lec', 'letter');
  note.pages = [page.id];
  files.files.set('lec.md', writeNote(note));
  files.files.set('lec/p-000001.svg', writePage(page));
  const store = new NoteStore(files, 'lec.md', 'lec', { pageChanged() {}, indexChanged() {}, notice() {}, saved() {} }, { delay: 10000 });
  await store.load();
  assert.equal(store.replaceStroke('p-000001', 'ffffffff', []), null);
  assert.equal(store.replaceStroke('p-999999', '00000001', []), null);
  assert.equal(store.unsaved, false);
  const r = store.replaceStroke('p-000001', '00000002', [dot('0000000a', 1), dot('0000000b', 2)]);
  assert.deepEqual(r && [r.index, r.stroke.id], [1, '00000002']);
  const model = store.page(store.slots[0])!;
  assert.deepEqual(model.strokes.map(s => s.id), ['00000001', '0000000a', '0000000b', '00000003']);
  assert.equal(store.unsaved, true);
  await store.flush();
  assert.deepEqual(readPage(files.files.get('lec/p-000001.svg')!).strokes.map(s => s.id), ['00000001', '0000000a', '0000000b', '00000003']);
  // No replacements: the stroke is just removed.
  assert.deepEqual(store.replaceStroke('p-000001', '00000001', [])?.index, 0);
  assert.deepEqual(model.strokes.map(s => s.id), ['0000000a', '0000000b', '00000003']);
  store.close();
});

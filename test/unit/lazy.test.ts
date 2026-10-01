// Long notes are loaded lazily (#63): the store reads a page's file when it is asked for, and
// releases pages that weren't changed here once more than MAX_LOADED are in memory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage, type Size } from '../../src/format/page';
import { LAZY_OVER, MAX_LOADED, NoteStore, type NoteFiles, type PageSlot } from '../../src/ink/store';

class MemFiles implements NoteFiles {
  files = new Map<string, string>();
  reads: string[] = [];
  deleted: string[] = [];
  async read(path: string) {
    this.reads.push(path);
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.files.set(path, text);
  }
  list(folder: string) {
    return [...this.files.keys()].filter(k => k.startsWith(folder + '/')).map(k => k.slice(folder.length + 1));
  }
  async delete(path: string) {
    this.deleted.push(path);
    this.files.delete(path);
  }
}

const id = (i: number) => 'p-' + i.toString(16).padStart(6, '0');
const dot = (sid: string) => ({ id: sid, tool: 'pen' as const, nib: 'uniform' as const, color: '#000000', size: 2, points: [{ x: 5, y: 5, p: 0.5, t: 0 }] });
const SLIDE: Size = { width: 960, height: 540 };

/** A note of `n` pages of `size` (letter paper), opened. */
async function open(n: number, size?: Size) {
  const files = new MemFiles();
  const note = newNote('book');
  for (let i = 0; i < n; i++) {
    note.pages.push(id(i));
    files.files.set(`book/${id(i)}.svg`, writePage(newPage(id(i), size)));
  }
  files.files.set('book.md', writeNote(note));
  const events: string[] = [];
  const store = new NoteStore(files, 'book.md', 'book', {
    pageChanged: s => events.push('changed ' + s.id), indexChanged: () => events.push('index'), notice: m => events.push('notice ' + m), saved: () => {},
    pagesSized: () => events.push('sized'), pageLoaded: s => events.push('loaded ' + s.id),
  }, { delay: 10, maxDelay: 50 });
  await store.load();
  const pageReads = () => files.reads.filter(p => p.endsWith('.svg')).length;
  return { files, store, events, pageReads };
}

const inMemory = (store: NoteStore) => store.slots.filter(s => s.loaded).map(s => s.id);

test('a note of up to LAZY_OVER pages is read whole when it opens, and never releases a page', async () => {
  const { store, pageReads } = await open(LAZY_OVER);
  assert.equal(store.lazy, false);
  assert.equal(pageReads(), LAZY_OVER);
  assert.ok(store.slots.every(s => s.loaded && store.page(s)));
  for (const s of store.slots) await store.request(s);
  assert.equal(store.pagesInMemory, LAZY_OVER);
});

test('a longer note reads no page when it opens, and a page when it is asked for', async () => {
  const { store, events, pageReads } = await open(LAZY_OVER + 12);
  assert.equal(store.lazy, true);
  assert.equal(pageReads(), 0);
  assert.equal(store.slots.length, LAZY_OVER + 12);
  const slot = store.slots[5];
  assert.deepEqual([slot.loaded, slot.error, store.page(slot)], [false, null, null]);
  const twice = [store.request(slot), store.request(slot)];
  await Promise.all(twice);
  assert.equal(pageReads(), 1, 'asked for twice, read once');
  assert.equal(slot.loaded, true);
  assert.equal(store.page(slot)!.id, slot.id);
  assert.deepEqual(events, ['loaded ' + slot.id]);
  assert.equal(store.pagesLoaded, LAZY_OVER + 12, 'pages that could be shown');
  assert.equal(store.pagesInMemory, 1);
});

test('the pages asked for longest ago are released past MAX_LOADED; changed pages never are', async () => {
  const n = MAX_LOADED + 30;
  const { files, store, pageReads } = await open(n);
  await store.request(store.slots[0]);
  store.addStroke(store.slots[0], dot('00000001'));
  for (let i = 1; i < n; i++) await store.request(store.slots[i]);
  const loaded = inMemory(store);
  assert.equal(loaded.length, MAX_LOADED + 1, 'MAX_LOADED unchanged pages and the changed one');
  assert.ok(loaded.includes(id(0)), 'the changed page stays');
  assert.deepEqual(loaded.slice(1), store.slots.slice(n - MAX_LOADED).map(s => s.id), 'the newest asked for stay');
  const released = store.slots[1];
  assert.deepEqual([released.loaded, released.page, released.text, store.page(released)], [false, null, null, null]);
  // Asking again keeps a page: the view asks for the pages near the viewport whenever it moves.
  await store.request(store.slots[n - MAX_LOADED]);
  await store.request(released);
  assert.equal(released.loaded, true);
  assert.equal(store.slots[n - MAX_LOADED].loaded, true);
  assert.equal(store.slots[n - MAX_LOADED + 1].loaded, false);
  assert.equal(pageReads(), n + 1);
  // The changed page is still saved, and stays in memory after it.
  await store.flush();
  assert.equal(readPage(files.files.get(`book/${id(0)}.svg`)!).strokes.length, 1);
  for (let i = 1; i < n; i++) await store.request(store.slots[i]);
  assert.equal(store.slots[0].loaded, true);
  store.close();
});

test('pages not read yet take the size of the last page read; the listener lays out again once', async () => {
  const { store, events } = await open(LAZY_OVER + 2, SLIDE);
  assert.deepEqual(store.slots[9].size, { width: 816, height: 1056 }, 'the note\'s paper until a page is read');
  await store.request(store.slots[3]);
  assert.deepEqual(events, ['sized', 'loaded ' + id(3)]);
  assert.ok(store.slots.every(s => s.size.width === 960 && s.size.height === 540));
  await store.request(store.slots[4]);
  assert.deepEqual(events.slice(2), ['loaded ' + id(4)], 'as estimated: no new layout');
});

test('loadAll reads every page and keeps them until released', async () => {
  const n = MAX_LOADED + 20;
  const { store, pageReads } = await open(n);
  const seen: number[] = [];
  const release = await store.loadAll((done, total) => { assert.equal(total, n); seen.push(done); });
  assert.equal(pageReads(), n);
  assert.equal(seen.length, n);
  assert.equal(store.pagesInMemory, n);
  assert.equal(store.setAllTemplates({ kind: 'grid', spacing: '5mm' }).pages.length, n);
  release();
  assert.equal(store.pagesInMemory, n, 'all changed: all kept');
  store.close();
  const again = await open(n);
  const free = await again.store.loadAll();
  await again.store.request(again.store.slots[2]); // the page in view
  free();
  free();
  assert.equal(again.store.pagesInMemory, MAX_LOADED);
  assert.equal(again.store.slots[2].loaded, true);
});

test('a change on disk to a page that is not in memory reads nothing; a missing file shows when asked for', async () => {
  const { files, store, events, pageReads } = await open(LAZY_OVER + 5);
  files.files.set(`book/${id(7)}.svg`, writePage({ ...newPage(id(7)), strokes: [dot('00000002')] }));
  await store.external(`book/${id(7)}.svg`, 'modify');
  assert.equal(pageReads(), 0);
  assert.deepEqual(events, []);
  await store.request(store.slots[7]);
  assert.equal(store.page(store.slots[7])!.strokes.length, 1);
  files.files.delete(`book/${id(8)}.svg`);
  await store.request(store.slots[8]);
  assert.match(store.slots[8].error ?? '', /Page file missing/);
  assert.equal(store.pagesLoaded, LAZY_OVER + 4);
});

test('deleting a page that is not in memory leaves its file, so undo still has it', async () => {
  const { files, store } = await open(LAZY_OVER + 5);
  const slot: PageSlot = store.slots[9];
  const at = store.deletePage(slot.id).index;
  await store.flush();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(at, 9);
  assert.deepEqual(files.deleted, []);
  store.insertPageInIndex(slot.id, at);
  await store.flush();
  assert.equal(store.slots[9], slot);
  await store.request(slot);
  assert.equal(store.page(slot)!.id, slot.id);
  store.close();
});

test('a note that grows past LAZY_OVER on disk becomes lazy; pages already read stay', async () => {
  const { files, store, pageReads } = await open(LAZY_OVER);
  const note = newNote('book');
  for (let i = 0; i < LAZY_OVER + 10; i++) {
    note.pages.push(id(i));
    if (i >= LAZY_OVER) files.files.set(`book/${id(i)}.svg`, writePage(newPage(id(i))));
  }
  const md = writeNote(note);
  files.files.set('book.md', md);
  await store.external('book.md', 'modify');
  assert.equal(store.slots.length, LAZY_OVER + 10);
  assert.equal(store.lazy, true);
  assert.equal(pageReads(), LAZY_OVER, 'the new pages are not read');
  assert.equal(store.slots[LAZY_OVER].loaded, false);
  assert.equal(store.slots[0].loaded, true);
});

// Page management (#17): the store's insertPage, movePage, duplicatePage and deletePage, and
// bringing a deleted page back with insertPageInIndex (undo).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { readPage, writePage, type Page } from '../../src/format/page';
import { parseTemplateName } from '../../src/format/template';
import { NoteStore, type NoteFiles } from '../../src/ink/store';
import { randomPage } from './helpers';
import { seeded } from '../seeded';

class MemFiles implements NoteFiles {
  files = new Map<string, string>();
  written: string[] = [];
  deleted: string[] = [];
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.written.push(path);
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

async function openNote(n: number) {
  const pages: Page[] = [];
  const r = seeded(17);
  for (let i = 0; i < n; i++) pages.push(randomPage(r, 5 + i, 'mixed'));
  const files = new MemFiles();
  const note = newNote('lec', 'letter');
  note.pages = pages.map(p => p.id);
  files.files.set('dir/lec.md', writeNote(note));
  for (const p of pages) files.files.set(`dir/lec/${p.id}.svg`, writePage(p));
  const notices: string[] = [];
  let next = 0xa0;
  const store = new NoteStore(files, 'dir/lec.md', 'lec', {
    pageChanged: () => {}, indexChanged: () => {}, notice: m => notices.push(m), saved: () => {},
  }, { delay: 1000, maxDelay: 5000, newId: taken => { let id; do id = `p-${(next++).toString(16).padStart(6, '0')}`; while (taken.has(id)); return id; } });
  await store.load();
  return { files, store, notices, ids: pages.map(p => p.id) };
}

const saved = (files: MemFiles) => readNote(files.files.get('dir/lec.md')!, 'lec').pages;
const embeds = (files: MemFiles) => (files.files.get('dir/lec.md')!.match(/lec\/p-[0-9a-f]{6}\.svg/g) ?? []).map(m => m.slice(4, 12));
const pageFiles = (files: MemFiles) => new Map([...files.files].filter(([k]) => k.endsWith('.svg')));

test('pages: insertPage puts a new page at the index, clamped; addPage appends', async () => {
  const { files, store, ids } = await openNote(3);
  const a = store.insertPage(1);
  assert.equal(a.id, 'p-0000a0');
  const b = store.insertPage(-5, parseTemplateName('grid-5mm'));
  const c = store.insertPage(99);
  const d = store.addPage();
  const order = [b.id, ids[0], a.id, ids[1], ids[2], c.id, d.id];
  assert.deepEqual(store.index.pages, order);
  assert.deepEqual(store.slots.map(s => s.id), order);
  await store.flush();
  assert.deepEqual(saved(files), order);
  assert.deepEqual(embeds(files), order);
  assert.equal(readPage(files.files.get(`dir/lec/${b.id}.svg`)!).template.kind, 'grid');
  assert.equal(readPage(files.files.get(`dir/lec/${a.id}.svg`)!).strokes.length, 0);
});

test('pages: movePage changes only the index; page files keep their names and text', async () => {
  const { files, store, ids } = await openNote(4);
  const before = pageFiles(files);
  files.written.length = 0;
  assert.equal(store.movePage(ids[0], 2), 0);
  assert.deepEqual(store.index.pages, [ids[1], ids[2], ids[0], ids[3]]);
  assert.equal(store.movePage(ids[3], -1), 3);
  assert.equal(store.movePage(ids[1], 100), 1);
  const order = [ids[3], ids[2], ids[0], ids[1]];
  assert.deepEqual(store.index.pages, order);
  assert.deepEqual(store.slots.map(s => s.id), order);
  assert.equal(store.movePage('p-ffffff', 0), -1);
  assert.equal(store.movePage(ids[2], 1), 1); // already there: nothing to do
  await store.flush();
  assert.deepEqual(files.written, ['dir/lec.md']);
  assert.deepEqual(embeds(files), order);
  assert.deepEqual(pageFiles(files), before);
  // back again, as undo does
  store.movePage(ids[0], 0);
  store.movePage(ids[1], 1);
  store.movePage(ids[2], 2);
  await store.flush();
  assert.deepEqual(saved(files), ids);
});

test('pages: duplicatePage inserts a copy after the page with a new id and deep-copied strokes', async () => {
  const { files, store, ids } = await openNote(2);
  const dup = store.duplicatePage(ids[0])!;
  assert.ok(dup);
  assert.ok(!ids.includes(dup.id));
  assert.deepEqual(store.index.pages, [ids[0], dup.id, ids[1]]);
  const src = store.page(store.slots[0])!;
  assert.equal(dup.page!.id, dup.id);
  assert.deepEqual(dup.page!.strokes, src.strokes);
  assert.notEqual(dup.page!.strokes[0], src.strokes[0]);
  assert.notEqual(dup.page!.strokes[0].points, src.strokes[0].points);
  dup.page!.strokes[0].points[0].x = -1;
  assert.notEqual(src.strokes[0].points[0].x, -1);
  assert.equal(store.duplicatePage('p-ffffff'), null);
  await store.flush();
  const copy = readPage(files.files.get(`dir/lec/${dup.id}.svg`)!);
  assert.equal(copy.strokes.length, src.strokes.length);
  assert.deepEqual(copy.template, src.template);
  assert.deepEqual(embeds(files), [ids[0], dup.id, ids[1]]);
});

test('pages: deletePage removes the page and its file; insertPageInIndex brings both back; delete again removes it', async () => {
  const { files, store, ids } = await openNote(3);
  const path = `dir/lec/${ids[1]}.svg`;
  const original = files.files.get(path)!;
  assert.deepEqual(store.deletePage(ids[1]), { index: 1 });
  assert.deepEqual(store.index.pages, [ids[0], ids[2]]);
  await store.flush();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(files.files.has(path), false);
  assert.deepEqual(files.deleted, [path]);
  assert.deepEqual(embeds(files), [ids[0], ids[2]]);
  // the index was written before the file was deleted
  assert.ok(files.written.includes('dir/lec.md'));
  // undo
  store.insertPageInIndex(ids[1], 1);
  assert.equal(store.unsaved, true);
  await store.flush();
  assert.equal(files.files.get(path), original);
  assert.deepEqual(embeds(files), ids);
  // redo
  store.deletePage(ids[1]);
  await store.flush();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(files.files.has(path), false);
  assert.deepEqual(store.deletePage('p-ffffff'), { index: -1 });
  // a deleted page's id is not reused while it can come back
  const fresh = store.addPage();
  assert.notEqual(fresh.id, ids[1]);
});

test('pages: a delete undone before the file is deleted keeps the file', async () => {
  const { files, store, ids } = await openNote(2);
  const path = `dir/lec/${ids[0]}.svg`;
  store.deletePage(ids[0]);
  store.insertPageInIndex(ids[0], 0);
  await store.flush();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(files.files.has(path), true);
  assert.equal(readPage(files.files.get(path)!).strokes.length, 5);
  assert.deepEqual(embeds(files), ids);
});

test('pages: deleting a page with unsaved strokes, then undoing, writes the strokes', async () => {
  const { files, store, ids } = await openNote(2);
  const slot = store.slots[1];
  const page = store.page(slot)!;
  store.addStroke(slot, { ...page.strokes[0], id: 'deadbeef' });
  store.deletePage(ids[1]);
  await store.flush();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(files.files.has(`dir/lec/${ids[1]}.svg`), false);
  store.insertPageInIndex(ids[1], 5);
  await store.flush();
  assert.equal(readPage(files.files.get(`dir/lec/${ids[1]}.svg`)!).strokes.length, 7);
  assert.deepEqual(saved(files), ids);
});

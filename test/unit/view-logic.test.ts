// The ink view's pure parts: page layout, note names, and NoteStore (loading, autosave,
// write order and changes on disk) over an in-memory file map.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { A4, LETTER, newPage, readPage, writePage, type Page } from '../../src/format/page';
import { FOOTER, GAP, layoutPages, MARGIN, pageAtY, pagesInBand } from '../../src/ink/layout';
import { cleanName, DEFAULT_NAME, uniqueName } from '../../src/ink/names';
import { fingerprint, NoteStore, peekSize, type NoteFiles, type PageSlot } from '../../src/ink/store';

test('layout: pages fit the width at one scale, centred, stacked with a gap', () => {
  const l = layoutPages([LETTER, A4, LETTER], 848, LETTER);
  assert.equal(l.scale, (848 - 2 * MARGIN) / LETTER.width);
  assert.deepEqual(l.pages[0], { top: MARGIN, left: MARGIN, width: 816, height: 1056 });
  assert.equal(l.pages[1].top, MARGIN + 1056 + GAP);
  assert.equal(l.pages[1].width, 794);
  assert.equal(l.pages[1].left, 27); // narrower A4 page centred
  assert.equal(l.pages[2].top, l.pages[1].top + 1123 + GAP);
  assert.equal(l.footerTop, l.pages[2].top + 1056 + GAP);
  assert.equal(l.height, l.footerTop + FOOTER);
  const half = layoutPages([LETTER], 440, LETTER);
  assert.equal(half.pages[0].width, 408);
  assert.equal(half.pages[0].height, 528);
});

test('layout: pages in a band of the scroll area, and the page at a height', () => {
  const l = layoutPages([LETTER, LETTER, LETTER, LETTER], 848, LETTER); // pages 1056 tall, 1080 apart
  assert.deepEqual(pagesInBand(l, 0, 600), [0]);
  assert.deepEqual(pagesInBand(l, 1000, 1200), [0, 1]);
  assert.deepEqual(pagesInBand(l, 1073, 1096), []); // in the gap
  assert.deepEqual(pagesInBand(l, -2000, 10000), [0, 1, 2, 3]);
  assert.equal(pageAtY(l, 0), 0);
  assert.equal(pageAtY(l, 1100), 1);
  assert.equal(pageAtY(l, 99999), 3);
  assert.equal(pageAtY(layoutPages([], 848, LETTER), 10), -1);
});

test('names: unsafe characters become spaces; empty names get the default', () => {
  assert.equal(cleanName('  Lecture 4: waves?  '), 'Lecture 4 waves');
  assert.equal(cleanName('a/b\\c|d#e^f[g]h'), 'a b c d e f g h');
  assert.equal(cleanName('   '), DEFAULT_NAME);
  assert.equal(cleanName('..'), DEFAULT_NAME);
  assert.equal(cleanName('.hidden'), 'hidden');
  const taken = new Set(['Note', 'Note 1']);
  assert.equal(uniqueName('Note', n => taken.has(n)), 'Note 2');
  assert.equal(uniqueName('Other', n => taken.has(n)), 'Other');
});

test('peekSize reads the size without parsing strokes; fingerprint tells texts apart', () => {
  assert.deepEqual(peekSize(writePage(newPage('p-000001', A4))), { width: 794, height: 1123 });
  assert.equal(peekSize('<svg/>'), null);
  assert.equal(fingerprint('abc'), fingerprint('abc'));
  assert.notEqual(fingerprint('abc'), fingerprint('abd'));
});

// ---- NoteStore

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class MemFiles implements NoteFiles {
  files = new Map<string, string>();
  log: string[] = [];
  /** Pending writes wait for this many ms. */
  latency = 0;
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.log.push('start ' + path);
    if (this.latency) await sleep(this.latency);
    this.files.set(path, text);
    this.log.push('done ' + path);
  }
  list(folder: string) {
    return [...this.files.keys()].filter(k => k.startsWith(folder + '/')).map(k => k.slice(folder.length + 1));
  }
}

function makeNote(files: MemFiles, pages: Page[]) {
  const note = newNote('lec', 'letter');
  note.pages = pages.map(p => p.id);
  files.files.set('dir/lec.md', writeNote(note));
  for (const p of pages) files.files.set(`dir/lec/${p.id}.svg`, writePage(p));
}

function makeStore(files: MemFiles, delay = 40) {
  const events: string[] = [];
  const store = new NoteStore(files, 'dir/lec.md', 'lec', {
    pageChanged: (s: PageSlot) => events.push('page ' + s.id),
    indexChanged: () => events.push('index'),
    notice: m => events.push('notice ' + m),
    saved: p => events.push('saved ' + p),
  }, { delay, maxDelay: 200, newId: taken => `p-${(taken.size + 0xa0).toString(16).padStart(6, '0')}` });
  return { store, events };
}

const dot = (id: string, x = 10) => ({ id, tool: 'pen' as const, nib: 'uniform' as const, color: '#000000', size: 2, points: [{ x, y: 10, p: 0.5, t: 0 }] });

test('store: loads pages lazily; a missing page is an error slot, not a failure', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001', A4), newPage('p-000002')]);
  const note = readNote(files.files.get('dir/lec.md')!, 'lec');
  note.pages.push('p-000003');
  files.files.set('dir/lec.md', writeNote(note));
  const { store } = makeStore(files);
  await store.load();
  assert.deepEqual(store.slots.map(s => [s.id, s.path, s.page, !!s.text, s.error === null]), [
    ['p-000001', 'dir/lec/p-000001.svg', null, true, true],
    ['p-000002', 'dir/lec/p-000002.svg', null, true, true],
    ['p-000003', 'dir/lec/p-000003.svg', null, false, false],
  ]);
  assert.deepEqual(store.slots[0].size, A4);
  assert.equal(store.pagesLoaded, 2);
  assert.equal(store.page(store.slots[0])!.id, 'p-000001');
  assert.equal(store.slots[0].text, null);
  assert.equal(store.page(store.slots[2]), null);
  assert.match(store.slots[2].error!, /missing/);
});

test('store: a change is written after the quiet period, restarted by each change', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001')]);
  const { store, events } = makeStore(files, 60);
  await store.load();
  const slot = store.slots[0];
  store.addStroke(slot, dot('00000001'));
  await sleep(40);
  store.addStroke(slot, dot('00000002'));
  await sleep(40);
  assert.equal(files.log.length, 0, 'no write within 60 ms of the last change');
  await sleep(60);
  assert.deepEqual(files.log, ['start dir/lec/p-000001.svg', 'done dir/lec/p-000001.svg']);
  assert.equal(readPage(files.files.get('dir/lec/p-000001.svg')!).strokes.length, 2);
  assert.deepEqual(events, ['saved dir/lec/p-000001.svg']);
  assert.equal(store.unsaved, false);
});

test('store: continuous changes are still written after maxDelay', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001')]);
  const { store } = makeStore(files, 60); // maxDelay 200
  await store.load();
  for (let i = 0; i < 10; i++) {
    store.addStroke(store.slots[0], dot((i + 1).toString(16).padStart(8, '0')));
    await sleep(30);
  }
  assert.ok(files.log.length > 0, 'written during 300 ms of changes 30 ms apart');
});

test('store: writes to one file are serialized, and new pages are written before the index', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001')]);
  const { store } = makeStore(files);
  await store.load();
  files.latency = 20;
  store.addStroke(store.slots[0], dot('00000001'));
  const first = store.flush();
  store.addStroke(store.slots[0], dot('00000002'));
  const added = store.addPage();
  assert.equal(added.id, 'p-0000a1');
  const second = store.flush();
  await Promise.all([first, second]);
  const p1 = 'dir/lec/p-000001.svg', p2 = 'dir/lec/p-0000a1.svg';
  assert.deepEqual(files.log, [`start ${p1}`, `start ${p2}`, `done ${p1}`, `start ${p1}`, `done ${p2}`, `done ${p1}`, 'start dir/lec.md', 'done dir/lec.md']);
  assert.equal(readPage(files.files.get(p1)!).strokes.length, 2);
  assert.deepEqual(readNote(files.files.get('dir/lec.md')!, 'lec').pages, ['p-000001', 'p-0000a1']);
  assert.equal(store.saves, 4);
});

test('store: our own writes are ignored; other changes reload when nothing is unsaved', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001')]);
  const { store, events } = makeStore(files);
  await store.load();
  const slot = store.slots[0];
  store.addStroke(slot, dot('00000001'));
  await store.flush();
  events.length = 0;
  await store.external(slot.path, 'modify');
  assert.deepEqual(events, [], 'our own write');
  const other = newPage('p-000001');
  other.strokes.push(dot('0000000a'), dot('0000000b'));
  files.files.set(slot.path, writePage(other));
  await store.external(slot.path, 'modify');
  assert.deepEqual(events, ['page p-000001']);
  assert.deepEqual(store.page(slot)!.strokes.map(s => s.id), ['0000000a', '0000000b']);
  files.files.delete(slot.path);
  await store.external(slot.path, 'delete');
  assert.match(slot.error!, /missing/);
  await store.external('elsewhere.md', 'modify');
  assert.equal(events.length, 2);
});

test('store: with unsaved changes, a change on disk keeps them and gives one notice', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001')]);
  const { store, events } = makeStore(files, 1000);
  await store.load();
  const slot = store.slots[0];
  store.addStroke(slot, dot('00000001'));
  const other = newPage('p-000001');
  other.strokes.push(dot('0000000a'));
  files.files.set(slot.path, writePage(other));
  await store.external(slot.path, 'modify');
  await store.external(slot.path, 'modify');
  assert.deepEqual(events, ['notice p-000001.svg changed on disk; your unsaved changes are kept']);
  assert.deepEqual(store.page(slot)!.strokes.map(s => s.id), ['00000001']);
  await store.flush();
  store.close();
  assert.deepEqual(readPage(files.files.get(slot.path)!).strokes.map(s => s.id), ['00000001']);
});

test('store: a changed index reloads pages, keeping the ones already loaded', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001'), newPage('p-000002')]);
  const { store, events } = makeStore(files);
  await store.load();
  const kept = store.slots[1];
  files.files.set('dir/lec/p-000003.svg', writePage(newPage('p-000003')));
  const note = readNote(files.files.get('dir/lec.md')!, 'lec');
  note.pages = ['p-000002', 'p-000003'];
  files.files.set('dir/lec.md', writeNote(note));
  await store.external('dir/lec.md', 'modify');
  assert.deepEqual(events, ['index']);
  assert.deepEqual(store.slots.map(s => s.id), ['p-000002', 'p-000003']);
  assert.equal(store.slots[0], kept);
});

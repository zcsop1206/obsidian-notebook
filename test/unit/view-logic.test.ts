// The ink view's pure parts: page layout, note names, and NoteStore (loading, autosave,
// write order and changes on disk) over an in-memory file map.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { A4, LETTER, newPage, readPage, writePage, type Page } from '../../src/format/page';
import { parseTemplateName, templateName } from '../../src/format/template';
import { FOOTER, GAP, layoutPages, MARGIN, mostVisiblePage, pageAtY, pagesInBand } from '../../src/ink/layout';
import { cleanName, DEFAULT_NAME, uniqueName } from '../../src/ink/names';
import { fingerprint, noteTemplate, NoteStore, peekSize, type NoteFiles, type PageSlot } from '../../src/ink/store';

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

test('layout: the current page is the one taking up most of the viewport', () => {
  const l = layoutPages([LETTER, LETTER, LETTER], 848, LETTER); // pages 1056 tall, 1080 apart, from 16
  assert.equal(mostVisiblePage(l, 0, 700), 0);
  assert.equal(mostVisiblePage(l, 700, 1400), 0); // 372 px of page 0, 304 of page 1
  assert.equal(mostVisiblePage(l, 800, 1500), 1);
  assert.equal(mostVisiblePage(l, 1073, 1095), -1); // only the gap
  assert.equal(mostVisiblePage(l, 2000, 5000), 2);
  assert.equal(mostVisiblePage(layoutPages([], 848, LETTER), 0, 100), -1);
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

// ---- templates

test('store: noteTemplate reads a template name; an unknown one gives blank', () => {
  assert.deepEqual(noteTemplate('lined-wide-margin'), { kind: 'lined', rule: 'wide', margin: true });
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a); };
  try {
    assert.deepEqual(noteTemplate('wallpaper'), { kind: 'blank' });
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
});

test('store: setPageTemplate keeps the ink, returns the old template, and setting it back restores the file', async () => {
  const files = new MemFiles();
  const written = newPage('p-000001');
  written.strokes.push(dot('00000001'), dot('00000002', 40));
  makeNote(files, [written, newPage('p-000002')]);
  const original = files.files.get('dir/lec/p-000001.svg')!;
  const { store } = makeStore(files, 1000);
  await store.load();
  const grid = parseTemplateName('grid-5mm');
  const before = store.setPageTemplate('p-000001', grid);
  assert.deepEqual(before, { kind: 'blank' });
  assert.equal(store.unsaved, true);
  await store.flush();
  const page = readPage(files.files.get('dir/lec/p-000001.svg')!);
  assert.equal(templateName(page.template), 'grid-5mm');
  assert.deepEqual(page.strokes.map(s => s.id), ['00000001', '00000002']);
  assert.equal(files.log.filter(l => l.startsWith('start')).length, 1, 'only the changed page is written, not the index');
  // Reverse it (what undo will do).
  assert.deepEqual(store.setPageTemplate('p-000001', before!), grid);
  await store.flush();
  assert.equal(files.files.get('dir/lec/p-000001.svg'), original);
  // The same template again changes nothing; an unknown page gives null.
  files.log.length = 0;
  assert.deepEqual(store.setPageTemplate('p-000001', { kind: 'blank' }), { kind: 'blank' });
  assert.equal(store.unsaved, false);
  assert.equal(store.setPageTemplate('p-00ffff', grid), null);
  store.close();
});

test('store: setAllTemplates changes every readable page and the note default, returning what it replaced', async () => {
  const files = new MemFiles();
  const a = newPage('p-000001', LETTER, parseTemplateName('lined-college'));
  a.strokes.push(dot('00000001'));
  makeNote(files, [a, newPage('p-000002', LETTER, parseTemplateName('dots-5mm'))]);
  const note = readNote(files.files.get('dir/lec.md')!, 'lec');
  note.pages.push('p-000003'); // no file: skipped
  files.files.set('dir/lec.md', writeNote(note));
  const { store } = makeStore(files, 1000);
  await store.load();
  const before = store.setAllTemplates(parseTemplateName('grid-quarter-inch'));
  assert.deepEqual(before, {
    note: 'blank',
    pages: [{ id: 'p-000001', template: parseTemplateName('lined-college') }, { id: 'p-000002', template: parseTemplateName('dots-5mm') }],
  });
  assert.equal(store.index.template, 'grid-quarter-inch');
  await store.flush();
  assert.equal(readNote(files.files.get('dir/lec.md')!, 'lec').template, 'grid-quarter-inch');
  for (const id of ['p-000001', 'p-000002']) assert.equal(templateName(readPage(files.files.get(`dir/lec/${id}.svg`)!).template), 'grid-quarter-inch');
  assert.equal(readPage(files.files.get('dir/lec/p-000001.svg')!).strokes.length, 1);
  assert.equal(files.files.has('dir/lec/p-000003.svg'), false);
  // New pages take the new default; an explicit template wins.
  assert.equal(templateName(store.page(store.addPage())!.template), 'grid-quarter-inch');
  assert.equal(templateName(store.page(store.addPage(parseTemplateName('lined-wide')))!.template), 'lined-wide');
  // Reversing: the old default and each page's old template.
  assert.equal(store.setNoteTemplate(parseTemplateName(before.note)), 'grid-quarter-inch');
  for (const p of before.pages) store.setPageTemplate(p.id, p.template);
  await store.flush();
  assert.equal(readNote(files.files.get('dir/lec.md')!, 'lec').template, 'blank');
  assert.equal(templateName(readPage(files.files.get('dir/lec/p-000002.svg')!).template), 'dots-5mm');
  store.close();
});

test('store: a note with pages on three templates saves and reopens with them', async () => {
  const files = new MemFiles();
  makeNote(files, [newPage('p-000001', LETTER, parseTemplateName('lined-college-margin'))]);
  const { store } = makeStore(files, 1000);
  await store.load();
  store.addPage(parseTemplateName('grid-5mm'));
  store.addPage(parseTemplateName('dots-5mm'));
  await store.flush();
  store.close();
  const again = makeStore(files).store;
  await again.load();
  assert.deepEqual(again.slots.map(s => templateName(again.page(s)!.template)), ['lined-college-margin', 'grid-5mm', 'dots-5mm']);
  again.close();
});

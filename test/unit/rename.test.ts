// Renaming or moving a note keeps its pages (#26): the path arithmetic and the rename plan, and
// NoteStore following a rename and a moved page folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage } from '../../src/format/page';
import { locatePages, planRename, relative, resolve } from '../../src/ink/paths';
import { NoteStore, type NoteFiles } from '../../src/ink/store';

test('resolve and relative are inverse, with ../ where needed', () => {
  const cases: [string, string, string][] = [
    ['', 'lecture', 'lecture'],
    ['School', 'School/lecture', 'lecture'],
    ['School', 'lecture', '../lecture'],
    ['Archive/2024', 'School/lecture', '../../School/lecture'],
    ['a/b', 'a/c/d', '../c/d'],
  ];
  for (const [dir, target, rel] of cases) {
    assert.equal(relative(dir, target), rel, `${dir} -> ${target}`);
    assert.equal(resolve(dir, rel), target, `${dir} + ${rel}`);
  }
  assert.equal(resolve('', '../x'), null, 'outside the vault');
});

test('planRename: the note\'s own folder follows it; a taken name or a hand-named folder stays', () => {
  const none = () => false;
  assert.deepEqual(planRename('lecture.md', 'week1.md', 'lecture', none), { kind: 'move', from: 'lecture', to: 'week1' });
  assert.deepEqual(planRename('lecture.md', 'School/lecture.md', 'lecture', none), { kind: 'move', from: 'lecture', to: 'School/lecture' });
  assert.deepEqual(planRename('A/lecture.md', 'B/week1.md', 'A/lecture', none), { kind: 'move', from: 'A/lecture', to: 'B/week1' });
  // A parent folder was renamed: the pages already moved with the note.
  assert.deepEqual(planRename('School/lecture.md', 'Uni/lecture.md', 'Uni/lecture', none), { kind: 'none', at: 'Uni/lecture' });
  assert.deepEqual(planRename('lecture.md', 'week1.md', 'lecture', p => p === 'week1'), { kind: 'collision', at: 'lecture', to: 'week1' });
  assert.deepEqual(planRename('lecture.md', 'week1.md', 'my pages', none), { kind: 'none', at: 'my pages' });
  assert.deepEqual(planRename('lecture.md', 'week1.md', null, none), { kind: 'none', at: null });
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
  async delete(path: string) {
    this.files.delete(path);
  }
  isFolder(path: string) {
    return this.list(path).length > 0;
  }
  isFile(path: string) {
    return this.files.has(path);
  }
  find(name: string) {
    return [...this.files.keys()].find(k => k === name || k.endsWith('/' + name)) ?? null;
  }
  /** Moves every file under `from` to `to`. */
  move(from: string, to: string) {
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(from + '/')) {
        this.files.set(to + k.slice(from.length), this.files.get(k)!);
        this.files.delete(k);
      }
    }
  }
}

const dot = (id: string) => ({ id, tool: 'pen' as const, nib: 'uniform' as const, color: '#000000', size: 2, points: [{ x: 5, y: 5, p: 0.5, t: 0 }] });

async function setup() {
  const files = new MemFiles();
  const note = newNote('lec');
  note.pages = ['p-000001'];
  files.files.set('lec.md', writeNote(note));
  files.files.set('lec/p-000001.svg', writePage(newPage('p-000001')));
  const notices: string[] = [];
  const store = new NoteStore(files, 'lec.md', 'lec', {
    pageChanged: () => {}, indexChanged: () => {}, notice: m => notices.push(m), saved: () => {},
  }, { delay: 20, maxDelay: 100 });
  await store.load();
  return { files, store, notices };
}

test('locatePages: from the note, then from the vault root, then by file name (#62)', () => {
  const files = new Set(['B/lec/p-000001.svg', 'lec/p-000002.svg', 'p-000003.svg']);
  const lookup = { isFile: (p: string) => files.has(p), find: (n: string) => [...files].find(k => k === n || k.endsWith('/' + n)) ?? null };
  assert.equal(locatePages('B', 'lec', 'p-000001', lookup), 'B/lec', 'relative to the note');
  assert.equal(locatePages('A', 'B/lec', 'p-000001', lookup), 'B/lec', 'from the vault root');
  assert.equal(locatePages('A', '/B/lec', 'p-000001', lookup), 'B/lec', 'from the vault root, leading slash');
  assert.equal(locatePages('A', '', 'p-000001', lookup), 'B/lec', 'a bare name');
  assert.equal(locatePages('B', './lec', 'p-000001', lookup), 'B/lec');
  assert.equal(locatePages('B/x', '../lec', 'p-000001', lookup), 'B/lec');
  assert.equal(locatePages('A', 'gone', 'p-000001', lookup), 'B/lec', 'a folder that no longer holds the page: by name');
  assert.equal(locatePages('B', 'lec', 'p-000002', lookup), 'lec', 'not in the folder next to the note: from the root');
  assert.equal(locatePages('', '', 'p-000009', lookup), null, 'no such page');
  assert.equal(locatePages('', '', 'p-000003', lookup), null, 'pages are never in the vault root');
});

/** A store over `files` for the note at `path`, with a link update that settles when `settle` is called. */
async function open(files: MemFiles, path: string, held = false) {
  const notices: string[] = [];
  let settle = () => {};
  const settled = held ? new Promise<void>(r => { settle = r; }) : null;
  const store = new NoteStore(files, path, path.replace(/^.*\//, '').replace(/\.md$/, ''), {
    pageChanged: () => {}, indexChanged: () => {}, notice: m => notices.push(m), saved: () => {},
  }, { delay: 20, maxDelay: 100, linksSettled: settled ? () => settled : undefined });
  await store.load();
  return { store, notices, settle };
}

const FRONT = '---\nink: 1\npaper: letter\ntemplate: blank\n---\n';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('store: opens a note whose embeds Obsidian rewrote and writes them back as relative paths (#62)', async () => {
  for (const [form, embed] of [['shortest', 'p-000001.svg'], ['absolute', 'B/lec/p-000001.svg'], ['stale relative', 'lec/p-000001.svg'], ['./', './../B/lec/p-000001.svg']] as const) {
    const files = new MemFiles();
    files.files.set('A/lec.md', FRONT + `Text.\n\n![](${embed})\n`);
    files.files.set('B/lec/p-000001.svg', writePage({ ...newPage('p-000001'), strokes: [dot('00000001')] }));
    const { store, notices } = await open(files, 'A/lec.md');
    assert.equal(store.folder, 'B/lec', form);
    assert.equal(store.slots[0].error, null, form);
    assert.equal(store.page(store.slots[0])!.strokes.length, 1, form);
    await sleep(60);
    assert.equal(files.files.get('A/lec.md'), FRONT + 'Text.\n\n![](../B/lec/p-000001.svg)\n', form);
    assert.deepEqual(notices, [], form);
    store.close();
  }
});

test('store: pages that are nowhere give error slots, and the embeds are left as written', async () => {
  const files = new MemFiles();
  const md = FRONT + '![](p-000001.svg)\n';
  files.files.set('lec.md', md);
  const { store } = await open(files, 'lec.md');
  assert.match(store.slots[0].error ?? '', /Page file missing: lec\/p-000001\.svg/);
  await sleep(60);
  assert.equal(files.files.get('lec.md'), md);
  store.close();
});

test('store: Obsidian rewriting the open note\'s embeds is followed, and they are written back (#62)', async () => {
  const { files, store, notices } = await setup();
  // Shortest path: the index now names no folder; the pages are where they were.
  files.files.set('lec.md', FRONT + '![](p-000001.svg)\n');
  await store.external('lec.md', 'modify');
  assert.equal(store.folder, 'lec');
  assert.equal(store.slots.length, 1);
  assert.equal(store.slots[0].error, null);
  await sleep(60);
  assert.equal(readNote(files.files.get('lec.md')!, 'lec').folder, 'lec');
  assert.deepEqual(notices, []);
  store.close();
});

test('store: after a rename the index waits for Obsidian\'s link update, pages do not (#62)', async () => {
  const files = new MemFiles();
  const note = newNote('lec');
  note.pages = ['p-000001'];
  files.files.set('A/lec.md', writeNote(note));
  files.files.set('A/lec/p-000001.svg', writePage(newPage('p-000001')));
  const { store, notices, settle } = await open(files, 'A/lec.md', true);
  // The note and its folder are moved together; Obsidian will rewrite the embeds afterwards.
  files.move('A/lec', 'B/lec');
  files.files.set('B/lec.md', files.files.get('A/lec.md')!);
  files.files.delete('A/lec.md');
  store.renamed('B/lec.md');
  assert.equal(store.followRename('B/lec', 'A/lec', true), true, 'the page folder moved');
  store.addStroke(store.slots[0], dot('00000001'));
  await store.flush();
  assert.equal(readPage(files.files.get('B/lec/p-000001.svg')!).strokes.length, 1, 'the page is saved meanwhile');
  const before = files.files.get('B/lec.md')!;
  // Obsidian's update, at the old offsets, on the index as it was.
  files.files.set('B/lec.md', before.replace('lec/p-000001.svg', 'p-000001.svg'));
  await store.external('B/lec.md', 'modify');
  settle();
  await store.indexReleased();
  await store.flush();
  await sleep(60);
  assert.equal(files.files.get('B/lec.md'), before, 'relative embeds again');
  assert.equal(store.folder, 'B/lec');
  assert.deepEqual(notices, []);
  store.close();
});

test('store: a rename then movePages writes the unsaved stroke and the index to the new place only', async () => {
  const { files, store, notices } = await setup();
  store.addStroke(store.slots[0], dot('00000001'));
  files.files.set('week1.md', files.files.get('lec.md')!);
  files.files.delete('lec.md');
  store.renamed('week1.md');
  assert.equal(store.folder, 'lec', 'the pages stay until moved');
  let during: Promise<void> | null = null;
  const ok = await store.movePages('week1', async () => {
    during = store.flush();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(files.files.has('lec/p-000001.svg') && readPage(files.files.get('lec/p-000001.svg')!).strokes.length, 0, 'nothing written to the old place during the move');
    files.move('lec', 'week1');
  });
  assert.ok(ok);
  await during;
  await new Promise(r => setTimeout(r, 10)); // the timer's save, queued behind the move too
  assert.deepEqual([...files.files.keys()].sort(), ['week1.md', 'week1/p-000001.svg']);
  assert.equal(readPage(files.files.get('week1/p-000001.svg')!).strokes.length, 1);
  const index = readNote(files.files.get('week1.md')!, 'week1');
  assert.deepEqual([index.folder, index.pages], ['week1', ['p-000001']]);
  assert.equal(store.slots[0].path, 'week1/p-000001.svg');
  assert.deepEqual(notices, []);
  // Our own index write is not a change on disk.
  await store.external('week1.md', 'modify');
  assert.deepEqual(notices, []);
  store.close();
});

test('store: a note moved to another folder with its pages left behind embeds them with ../', async () => {
  const { files, store } = await setup();
  files.files.set('School/lec.md', files.files.get('lec.md')!);
  files.files.delete('lec.md');
  store.renamed('School/lec.md');
  await store.flush();
  assert.equal(readNote(files.files.get('School/lec.md')!, 'lec').folder, '../lec');
  assert.equal(store.slots[0].path, 'lec/p-000001.svg');
  store.close();
});

test('store: follows its page folder renamed by hand, in either event order', async () => {
  for (const folderFirst of [true, false]) {
    const { files, store } = await setup();
    files.move('lec', 'pages');
    if (folderFirst) {
      assert.ok(store.followRename('pages', 'lec', true));
      assert.equal(store.followRename('pages/p-000001.svg', 'lec/p-000001.svg', false), false, 'nothing more to do');
    } else {
      assert.ok(store.followRename('pages/p-000001.svg', 'lec/p-000001.svg', false));
      assert.equal(store.followRename('pages', 'lec', true), false, 'already followed');
    }
    assert.equal(store.folder, 'pages');
    assert.equal(store.slots[0].path, 'pages/p-000001.svg');
    await store.flush();
    assert.equal(readNote(files.files.get('lec.md')!, 'lec').folder, 'pages');
    assert.equal(store.followRename('other', 'elsewhere', true), false);
    store.close();
  }
});

async function twoPages() {
  const { files, store, notices } = await setup();
  store.insertPage(1);
  await store.flush();
  return { files, store, notices, second: store.slots[1].id };
}

test('store: a page deleted while its folder moves is deleted in the new place, and the move finishes', async () => {
  const { files, store, notices, second } = await twoPages();
  const moved = store.movePages('pages', async () => {
    store.deletePage(second);
    await new Promise(r => setTimeout(r, 20));
    files.move('lec', 'pages');
  });
  assert.ok(await moved);
  await store.flush();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual([...files.files.keys()].sort(), ['lec.md', 'pages/p-000001.svg']);
  assert.deepEqual(readNote(files.files.get('lec.md')!, 'lec').pages, ['p-000001']);
  assert.deepEqual(notices, []);
  store.close();
});

test('store: a folder moved while a page delete is queued waits for the delete, without deadlock', async () => {
  const { files, store, notices, second } = await twoPages();
  store.deletePage(second);
  assert.ok(await store.movePages('pages', async () => files.move('lec', 'pages')));
  await store.flush();
  assert.deepEqual([...files.files.keys()].sort(), ['lec.md', 'pages/p-000001.svg']);
  assert.equal(readNote(files.files.get('lec.md')!, 'lec').folder, 'pages');
  assert.deepEqual(notices, []);
  store.close();
});

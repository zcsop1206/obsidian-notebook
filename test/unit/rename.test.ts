// Renaming or moving a note keeps its pages (#26): the path arithmetic and the rename plan, and
// NoteStore following a rename and a moved page folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage } from '../../src/format/page';
import { planRename, relative, resolve } from '../../src/ink/paths';
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
  isFolder(path: string) {
    return this.list(path).length > 0;
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

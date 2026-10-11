// The notebook library (#73): which folders the file explorer hides (only ink notes' own page
// folders), and the library's subjects, sorting, search and labels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onlyPageFiles, pageFolderOf, pageFolders, type FolderLookup, type InkNoteRef } from '../../src/ink/page-folders';
import { groupNotes, matches, modifiedLabel, pagesLabel, subjectLabel, UNFILED, type LibNote } from '../../src/ink/library-model';

/** A vault of these file paths (folders implied). */
function vault(paths: string[]): FolderLookup {
  const files = new Set(paths);
  const folders = new Set<string>();
  for (const p of paths) for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) folders.add(p.slice(0, i));
  return {
    isFile: p => files.has(p),
    find: name => [...files].find(f => f === name || f.endsWith('/' + name)) ?? null,
    children: folder => {
      if (!folders.has(folder)) return null;
      const kids = new Map<string, boolean>();
      for (const p of [...files, ...folders]) {
        if (!p.startsWith(folder + '/')) continue;
        const rest = p.slice(folder.length + 1), slash = rest.indexOf('/');
        kids.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0 || folders.has(p));
      }
      return [...kids].map(([name, folder]) => ({ name, folder }));
    },
  };
}

const note = (path: string, folder: string, firstPage: string | null): InkNoteRef => ({ path, folder, firstPage });

test('page folders: an ink note\'s own folder, found through its index', () => {
  const v = vault(['notebook/lecture.md', 'notebook/lecture/p-aaaaaa.svg', 'notebook/lecture/p-bbbbbb.svg', 'notebook/lecture/lecture.pdf']);
  assert.equal(pageFolderOf(note('notebook/lecture.md', 'lecture', 'p-aaaaaa'), v), 'notebook/lecture');
  assert.deepEqual([...pageFolders([note('notebook/lecture.md', 'lecture', 'p-aaaaaa')], v)], ['notebook/lecture']);
});

test('page folders: a folder named like a note but without an index pointing into it is left alone', () => {
  // `essay.md` is a plain note (not ink, so not in the list) next to a folder `essay/` of its images.
  const v = vault(['notebook/essay.md', 'notebook/essay/figure.svg', 'notebook/lecture.md', 'notebook/lecture/p-aaaaaa.svg']);
  const hidden = pageFolders([note('notebook/lecture.md', 'lecture', 'p-aaaaaa')], v);
  assert.deepEqual([...hidden], ['notebook/lecture']);
  assert.ok(!hidden.has('notebook/essay'));
  // An ink note whose page file is missing: its folder of the same name isn't taken for a page folder.
  const missing = vault(['notebook/draft.md', 'notebook/draft/notes.txt']);
  assert.deepEqual([...pageFolders([note('notebook/draft.md', 'draft', 'p-cccccc')], missing)], []);
  // An ink note without pages has no page folder.
  assert.deepEqual([...pageFolders([note('notebook/empty.md', 'empty', null)], vault(['notebook/empty/x.png']))], []);
});

test('page folders: a page folder holding a markdown file or a subfolder is never hidden', () => {
  const md = vault(['a/lecture.md', 'a/lecture/p-aaaaaa.svg', 'a/lecture/todo.md']);
  assert.deepEqual([...pageFolders([note('a/lecture.md', 'lecture', 'p-aaaaaa')], md)], []);
  const sub = vault(['a/lecture.md', 'a/lecture/p-aaaaaa.svg', 'a/lecture/old/p-bbbbbb.svg']);
  assert.deepEqual([...pageFolders([note('a/lecture.md', 'lecture', 'p-aaaaaa')], sub)], []);
  assert.equal(onlyPageFiles([{ name: 'p-aaaaaa.svg', folder: false }, { name: 'x.pdf', folder: false }]), true);
  assert.equal(onlyPageFiles([{ name: 'Note.MD', folder: false }]), false);
});

test('page folders: wherever Obsidian\'s link update left the embeds (#62), and a folder named by hand (#26)', () => {
  const v = vault(['School/lecture.md', 'School/pages of lecture/p-aaaaaa.svg', 'notes.md', 'x/y.md', 'x/y/p-bbbbbb.svg']);
  assert.equal(pageFolderOf(note('School/lecture.md', 'pages of lecture', 'p-aaaaaa'), v), 'School/pages of lecture');
  assert.equal(pageFolderOf(note('School/lecture.md', '', 'p-aaaaaa'), v), 'School/pages of lecture', 'a bare embed, found by file name');
  assert.equal(pageFolderOf(note('x/y.md', 'x/y', 'p-bbbbbb'), v), 'x/y', 'a path from the vault root');
  // A page file in the vault root is never a folder to hide.
  assert.equal(pageFolderOf(note('notes.md', '', 'p-dddddd'), vault(['notes.md', 'p-dddddd.svg'])), null);
});

const lib = (path: string, mtime: number): LibNote => {
  const slash = path.lastIndexOf('/');
  return { path, name: path.slice(slash + 1).replace(/\.md$/, ''), subject: slash < 0 ? '' : path.slice(0, slash), pages: 1, mtime, pagesAt: null, firstPage: null };
};

test('subjects: labels from the notes folder; the root is Unfiled', () => {
  assert.equal(subjectLabel('', 'notebook'), UNFILED);
  assert.equal(subjectLabel('notebook', 'notebook'), 'notebook');
  assert.equal(subjectLabel('notebook/Physics', 'notebook'), 'Physics');
  assert.equal(subjectLabel('notebook/Physics/Labs', 'notebook'), 'Physics/Labs');
  assert.equal(subjectLabel('School/Maths', 'notebook'), 'School/Maths');
  assert.equal(subjectLabel('notebooks', 'notebook'), 'notebooks');
  assert.equal(subjectLabel('Physics', ''), 'Physics');
});

test('subjects: grouped by folder, ordered notes folder, inside it, elsewhere, Unfiled; notes newest first', () => {
  const notes = [lib('notebook/a.md', 1), lib('notebook/Physics/w1.md', 5), lib('notebook/Physics/w2.md', 9), lib('Loose.md', 3),
    lib('School/m.md', 2), lib('notebook/b.md', 7), lib('notebook/Chem/c.md', 4)];
  const s = groupNotes(notes, ['notebook/Empty'], 'notebook');
  assert.deepEqual(s.map(x => x.label), ['notebook', 'Chem', 'Empty', 'Physics', 'School', UNFILED]);
  assert.deepEqual(s[0].notes.map(n => n.name), ['b', 'a']);
  assert.deepEqual(s[3].notes.map(n => n.name), ['w2', 'w1']);
  assert.deepEqual(s[2].notes, [], 'an empty subject shows');
  // Same time: by name.
  assert.deepEqual(groupNotes([lib('n/b.md', 1), lib('n/a.md', 1)], [], 'n')[0].notes.map(n => n.name), ['a', 'b']);
});

test('search: every word, any case; subjects without a match are hidden', () => {
  assert.ok(matches('2026-10-10 Physics lecture', 'phys LECT'));
  assert.ok(!matches('2026-10-10 Physics lecture', 'chem'));
  const notes = [lib('notebook/Physics/Waves.md', 1), lib('notebook/Chem/Acids.md', 2)];
  const s = groupNotes(notes, ['notebook/Empty'], 'notebook', 'wav');
  assert.deepEqual(s.map(x => [x.label, x.notes.map(n => n.name)]), [['Physics', ['Waves']]]);
  assert.equal(groupNotes(notes, [], 'notebook', '  ').length, 2, 'a blank query shows everything');
});

test('card labels: pages and last modified', () => {
  assert.equal(pagesLabel(1), '1 page');
  assert.equal(pagesLabel(12), '12 pages');
  const now = new Date(2026, 9, 10, 15, 0).getTime();
  assert.equal(modifiedLabel(new Date(2026, 9, 10, 0, 5).getTime(), now), 'Today');
  assert.equal(modifiedLabel(new Date(2026, 9, 9, 23, 0).getTime(), now), 'Yesterday');
  assert.equal(modifiedLabel(new Date(2026, 0, 3).getTime(), now), '3 Jan 2026');
  assert.equal(modifiedLabel(0, now), '');
});

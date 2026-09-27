import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInkNote, newNote, readNote, writeNote } from '../../src/format/note';

const FRONT = '---\nink: 1\npaper: letter\ntemplate: blank\n---\n';

test('a new note: frontmatter, then one embed per page separated by blank lines', () => {
  const note = newNote('lecture', 'a4');
  assert.equal(writeNote(note), '---\nink: 1\npaper: a4\ntemplate: blank\n---\n');
  note.pages = ['p-000001', 'p-000002'];
  const md = writeNote(note);
  assert.equal(md, '---\nink: 1\npaper: a4\ntemplate: blank\n---\n![](lecture/p-000001.svg)\n\n![](lecture/p-000002.svg)\n');
  const read = readNote(md, 'lecture');
  assert.deepEqual([read.paper, read.template, read.pages], ['a4', 'blank', ['p-000001', 'p-000002']]);
  assert.equal(writeNote(read), md);
});

test('pages are read in body order; other text and unknown frontmatter are kept verbatim', () => {
  const md = [
    '---',
    'title: "Lecture 4: waves"',
    'ink: 1',
    'tags:',
    '  - physics',
    '  - paper: not a key at this depth',
    'paper: "letter"',
    'template: blank',
    'publish: false',
    '---',
    '# Lecture 4',
    '',
    'Some **notes** before the pages. ![inline](lecture/p-aaaaaa.svg) is not an embed line.',
    '',
    '![Page one](lecture/p-cccccc.svg)',
    '',
    '![](lecture/p-aaaaaa.svg)',
    '![](other/p-dddddd.svg)',
    '![](lecture/p-bbbbbb.png)',
    '',
    '![[lecture/p-eeeeee.svg]]',
    '![](lecture/p-bbbbbb.svg)',
    'Trailing text.',
    '',
  ].join('\n');
  const note = readNote(md, 'lecture');
  assert.deepEqual(note.pages, ['p-cccccc', 'p-aaaaaa', 'p-bbbbbb']);
  assert.equal(note.paper, 'letter');
  assert.equal(note.template, 'blank');
  // Unchanged index: only the quoted paper value is normalised.
  assert.equal(writeNote(note), md.replace('paper: "letter"', 'paper: letter'));
  assert.equal(writeNote(readNote(writeNote(note), 'lecture')), writeNote(note));
});

test('reordering pages keeps other lines in place and alt text with its page', () => {
  const md = FRONT + '# Title\n\n![Cover](n/p-000001.svg)\n\nBetween.\n\n![](n/p-000002.svg)\n\n![](n/p-000003.svg)\nEnd.\n';
  const note = readNote(md, 'n');
  note.pages = ['p-000003', 'p-000001', 'p-000002'];
  assert.equal(writeNote(note),
    FRONT + '# Title\n\n![](n/p-000003.svg)\n\nBetween.\n\n![Cover](n/p-000001.svg)\n\n![](n/p-000002.svg)\nEnd.\n');
});

test('new pages go after the last embed; removed pages take one blank line with them', () => {
  const md = FRONT + 'Intro.\n\n![](n/p-000001.svg)\n\n![](n/p-000002.svg)\n\nOutro.\n';
  const note = readNote(md, 'n');
  note.pages = ['p-000001', 'p-000002', 'p-000003', 'p-000004'];
  const added = writeNote(note);
  assert.equal(added, FRONT + 'Intro.\n\n![](n/p-000001.svg)\n\n![](n/p-000002.svg)\n\n![](n/p-000003.svg)\n\n![](n/p-000004.svg)\n\nOutro.\n');

  const back = readNote(added, 'n');
  back.pages = ['p-000001', 'p-000002'];
  assert.equal(writeNote(back), md);

  back.pages = ['p-000002'];
  assert.equal(writeNote(back), FRONT + 'Intro.\n\n![](n/p-000002.svg)\n\nOutro.\n');
  back.pages = [];
  assert.equal(writeNote(back), FRONT + 'Intro.\n\nOutro.\n');
});

test('with no embeds, new pages go at the end of the body', () => {
  const note = readNote(FRONT + 'Just text.\n', 'n');
  assert.deepEqual(note.pages, []);
  note.pages = ['p-00000a', 'p-00000b'];
  assert.equal(writeNote(note), FRONT + 'Just text.\n\n![](n/p-00000a.svg)\n\n![](n/p-00000b.svg)\n');
  const noNewline = readNote('---\nink: 1\n---\nText', 'n');
  noNewline.pages = ['p-00000a'];
  assert.equal(writeNote(noNewline), '---\nink: 1\n---\nText\n\n![](n/p-00000a.svg)'.replace('---\nink: 1\n', '---\npaper: letter\ntemplate: blank\nink: 1\n'));
});

test('known keys are updated in place; missing ones are added at the top', () => {
  const note = readNote('---\ntitle: x\nink: 1\nfoo: bar\n---\n', 'n');
  assert.deepEqual([note.paper, note.template], ['letter', 'blank']);
  note.paper = 'a4';
  assert.equal(writeNote(note), '---\npaper: a4\ntemplate: blank\ntitle: x\nink: 1\nfoo: bar\n---\n');
  const edited = readNote('---\nink: 1\npaper: letter\ntemplate: blank\n---\n', 'n');
  edited.template = 'grid';
  assert.equal(writeNote(edited), '---\nink: 1\npaper: letter\ntemplate: grid\n---\n');
});

test('names with spaces and brackets are percent-encoded; both forms are read', () => {
  const note = newNote('Week 3 (draft)');
  note.pages = ['p-000001'];
  const md = writeNote(note);
  assert.ok(md.includes('![](Week%203%20%28draft%29/p-000001.svg)'), md);
  assert.deepEqual(readNote(md, 'Week 3 (draft)').pages, ['p-000001']);
  assert.deepEqual(readNote(FRONT + '![](Week 3 (draft)/p-000002.svg)\n![](<Week 3 (draft)/p-000003.svg>)\n', 'Week 3 (draft)').pages, ['p-000002', 'p-000003']);
});

test('CRLF line endings are kept', () => {
  const md = '---\r\nink: 1\r\npaper: letter\r\ntemplate: blank\r\n---\r\nText\r\n![](n/p-000001.svg)\r\n';
  const note = readNote(md, 'n');
  assert.equal(writeNote(note), md);
  note.pages.push('p-000002');
  assert.equal(writeNote(note), md.replace('.svg)\r\n', '.svg)\r\n\r\n![](n/p-000002.svg)\r\n'));
});

test('non-ink notes and bad indexes are rejected', () => {
  assert.throws(() => readNote('# Just markdown\n', 'n'), /no frontmatter/);
  assert.throws(() => readNote('---\ntitle: x\n---\n', 'n'), /no "ink: 1"/);
  assert.throws(() => readNote('---\nink: 2\n---\n', 'n'), /Unsupported ink note version/);
  assert.throws(() => readNote('---\nink: 1\npaper: legal\n---\n', 'n'), /Unknown paper "legal"/);
  assert.throws(() => readNote(FRONT + '![](n/p-000001.svg)\n![](n/p-000001.svg)\n', 'n'), /embedded twice/);
  assert.throws(() => writeNote({ ...newNote('n'), pages: ['p-1'] }), /Invalid page id/);
  assert.throws(() => writeNote({ ...newNote('n'), pages: ['p-000001', 'p-000001'] }), /listed twice/);
  assert.ok(isInkNote(FRONT) && !isInkNote('---\ntitle: x\n---\nink: 1\n') && !isInkNote('text'));
});

test('the pages\' folder is read from the embeds; the default serializes as before', () => {
  const note = newNote('lecture');
  assert.equal(note.folder, 'lecture');
  note.pages = ['p-000001'];
  assert.equal(writeNote(note), FRONT + '![](lecture/p-000001.svg)\n');
  assert.equal(readNote(FRONT + 'Text.\n', 'week1').folder, 'week1', 'no embeds: the basename');

  const moved = FRONT + '![](lecture/p-000001.svg)\n\n![](lecture/p-000002.svg)\n';
  const read = readNote(moved, 'week1');
  assert.deepEqual([read.basename, read.folder, read.pages], ['week1', 'lecture', ['p-000001', 'p-000002']]);
  assert.equal(writeNote(read), moved, 'written back to the same folder');
  read.folder = 'week1';
  assert.equal(writeNote(read), moved.replace(/lecture\//g, 'week1/'));

  const deep = readNote(FRONT + '![](../School/My%20pages/p-000001.svg)\n', 'n');
  assert.equal(deep.folder, '../School/My pages');
  assert.equal(writeNote(deep), FRONT + '![](../School/My%20pages/p-000001.svg)\n');
});

test('page embeds from a second folder are text; bad folders are rejected', () => {
  const mixed = FRONT + '![](a/p-000001.svg)\n![](b/p-000002.svg)\n![](a/p-000003.svg)\n';
  const note = readNote(mixed, 'n');
  assert.deepEqual([note.folder, note.pages], ['a', ['p-000001', 'p-000003']]);
  assert.equal(writeNote(note), mixed);
  assert.throws(() => writeNote({ ...newNote('n'), folder: '/abs', pages: ['p-000001'] }), /Invalid page folder/);
  assert.throws(() => writeNote({ ...newNote('n'), folder: 'a//b', pages: ['p-000001'] }), /Invalid page folder/);
  // Not page embeds (kept as text): a URL, an absolute path, a page next to the note.
  const odd = FRONT + '![](https://x.org/a/p-000001.svg)\n![](/a/p-000002.svg)\n![](p-000003.svg)\n';
  assert.deepEqual(readNote(odd, 'n').pages, []);
});

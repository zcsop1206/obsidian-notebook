import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readNote, writeNote } from '../../src/format/note';
import { readPage, writePage } from '../../src/format/page';
import { buildFixture, FIXTURE_NAME } from '../fixture';

// Paths are relative to the repo root, where npm runs the tests.
const DIR = 'test/fixtures';

test('the committed fixture matches what test/fixture.ts generates (run `npm run fixture` after a format change)', () => {
  const files = buildFixture();
  const committed = [`${FIXTURE_NAME}.md`, ...readdirSync(`${DIR}/${FIXTURE_NAME}`).map(f => `${FIXTURE_NAME}/${f}`)].sort();
  assert.deepEqual(committed, [...files.keys()].sort());
  for (const [path, text] of files) assert.equal(readFileSync(`${DIR}/${path}`, 'utf8'), text, path);
});

test('the fixture round-trips: read → write gives the committed files', () => {
  const md = readFileSync(`${DIR}/${FIXTURE_NAME}.md`, 'utf8');
  const note = readNote(md, FIXTURE_NAME);
  assert.equal(note.pages.length, 3);
  assert.equal(writeNote(note), md);
  const counts = note.pages.map(id => {
    const svg = readFileSync(`${DIR}/${FIXTURE_NAME}/${id}.svg`, 'utf8');
    const page = readPage(svg);
    assert.equal(page.id, id);
    assert.equal(writePage(page), svg);
    return page.strokes.map(s => s.tool);
  });
  // Page 1: pen in three colours; page 2: highlighters under pen; page 3: empty.
  assert.ok(counts[0].length > 20 && counts[0].every(t => t === 'pen'));
  assert.ok(counts[1].filter(t => t === 'highlighter').length === 4 && counts[1].includes('pen'));
  assert.equal(counts[2].length, 0);
});

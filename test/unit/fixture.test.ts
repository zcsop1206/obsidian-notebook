import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readNote, writeNote } from '../../src/format/note';
import { readPage, writePage } from '../../src/format/page';
import { templateName } from '../../src/format/template';
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
  assert.equal(note.pages.length, 6);
  assert.equal(writeNote(note), md);
  const templates: string[] = [];
  const counts = note.pages.map(id => {
    const svg = readFileSync(`${DIR}/${FIXTURE_NAME}/${id}.svg`, 'utf8');
    const page = readPage(svg);
    assert.equal(page.id, id);
    assert.equal(writePage(page), svg);
    templates.push(templateName(page.template));
    return page.strokes.map(s => s.tool);
  });
  // Page 1: pen in three colours; page 2: highlighters under pen; page 3: empty; page 4: pen
  // on lined paper; pages 5 and 6: empty grid and dots.
  assert.ok(counts[0].length > 20 && counts[0].every(t => t === 'pen'));
  assert.ok(counts[1].filter(t => t === 'highlighter').length === 4 && counts[1].includes('pen'));
  assert.equal(counts[2].length, 0);
  assert.ok(counts[3].length > 20 && counts[3].every(t => t === 'pen'));
  assert.deepEqual([counts[4].length, counts[5].length], [0, 0]);
  assert.deepEqual(templates, ['blank', 'blank', 'blank', 'lined-college-margin', 'grid-5mm', 'dots-5mm']);
});

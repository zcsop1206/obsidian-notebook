// One-tap new notes (#72): the name pattern, cleaned and made unique, and the notes folder setting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanFolder, cleanName, DEFAULT_NAME, DEFAULT_NAME_PATTERN, patternName, uniqueName } from '../../src/ink/names';

/**
 * The part of moment's format the tests use, for 2026-10-10 09:05 (a Saturday): `[text]` kept as
 * written, YYYY, MM, DD, ddd, HH, mm; other letters as moment would leave them is not modelled.
 */
const day = (pattern: string) => pattern.replace(/\[([^\]]*)\]|YYYY|MM|DD|ddd|HH|mm/g, (m, text: string | undefined) =>
  text !== undefined ? text : ({ YYYY: '2026', MM: '10', DD: '10', ddd: 'Sat', HH: '09', mm: '05' } as Record<string, string>)[m]);
const none = () => false;

test('the default pattern gives "YYYY-MM-DD Note"', () => {
  assert.equal(DEFAULT_NAME_PATTERN, 'YYYY-MM-DD [Note]');
  assert.equal(patternName(DEFAULT_NAME_PATTERN, day, none), '2026-10-10 Note');
  assert.equal(patternName('', day, none), '2026-10-10 Note', 'an empty pattern is the default one');
  assert.equal(patternName('   ', day, none), '2026-10-10 Note');
});

test('other patterns: bracketed text kept, times, day names', () => {
  assert.equal(patternName('[Lecture] YYYY-MM-DD HH.mm', day, none), 'Lecture 2026-10-10 09.05');
  assert.equal(patternName('ddd DD', day, none), 'Sat 10');
  assert.equal(patternName('[Physics]', day, none), 'Physics');
});

test('a taken name gets 1, 2…: a second note the same day is "… 1"', () => {
  const taken = new Set<string>();
  const make = () => {
    const name = patternName(DEFAULT_NAME_PATTERN, day, n => taken.has(n));
    taken.add(name);
    return name;
  };
  assert.deepEqual([make(), make(), make()], ['2026-10-10 Note', '2026-10-10 Note 1', '2026-10-10 Note 2']);
  // A page folder named like the note takes the name too (the caller's `taken` says so).
  assert.equal(patternName(DEFAULT_NAME_PATTERN, day, n => n === '2026-10-10 Note'), '2026-10-10 Note 1');
  assert.equal(uniqueName('2026-10-10 Note', n => n !== '2026-10-10 Note 3' && n.startsWith('2026')), '2026-10-10 Note 3');
});

test('characters that break file names or links are cleaned; a formatter that throws gives the default name', () => {
  // A pattern with slashes (daily notes use them for folders) stays one name here.
  assert.equal(patternName('YYYY/MM/DD', day, none), '2026 10 10');
  assert.equal(patternName('[a: b?] YYYY', day, none), 'a b 2026');
  assert.equal(patternName('[..]', day, none), DEFAULT_NAME);
  assert.equal(patternName('YYYY', () => { throw new Error('bad'); }, none), DEFAULT_NAME);
  assert.equal(cleanName(day(DEFAULT_NAME_PATTERN)), '2026-10-10 Note');
});

test('the notes folder setting: slashes trimmed, empty and dot parts dropped, \'\' is the vault root', () => {
  assert.equal(cleanFolder('notebook'), 'notebook');
  assert.equal(cleanFolder('/notebook/'), 'notebook');
  assert.equal(cleanFolder(' School / Physics '), 'School/Physics');
  assert.equal(cleanFolder('a//b\\c'), 'a/b/c');
  assert.equal(cleanFolder('../x/./y'), 'x/y');
  assert.equal(cleanFolder(''), '');
  assert.equal(cleanFolder('/'), '');
});

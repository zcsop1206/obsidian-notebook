// Go to page (#64): the indicator's text and what a typed page number means.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageLabel, parsePageNumber } from '../../src/ink/page-number';

test('pageLabel: the current page and the count; empty with no pages', () => {
  assert.equal(pageLabel(0, 1), '1 / 1');
  assert.equal(pageLabel(36, 812), '37 / 812');
  assert.equal(pageLabel(-1, 5), '1 / 5', 'no page in view yet');
  assert.equal(pageLabel(0, 0), '');
});

test('parsePageNumber: a 1-based number to a 0-based page, clamped to the note', () => {
  assert.equal(parsePageNumber('37', 812), 36);
  assert.equal(parsePageNumber(' 37 ', 812), 36);
  assert.equal(parsePageNumber('37 / 812', 812), 36, 'the indicator text pasted back');
  assert.equal(parsePageNumber('1', 812), 0);
  assert.equal(parsePageNumber('812', 812), 811);
  assert.equal(parsePageNumber('0', 812), 0, 'before the first page');
  assert.equal(parsePageNumber('-5', 812), 0);
  assert.equal(parsePageNumber('9999', 812), 811, 'past the last page');
  assert.equal(parsePageNumber('3.7', 812), 2);
  assert.equal(parsePageNumber('', 812), null);
  assert.equal(parsePageNumber('abc', 812), null);
  assert.equal(parsePageNumber('5', 0), null, 'no pages');
});

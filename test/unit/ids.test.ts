import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cryptoRandom, isPageId, isStrokeId, newPageId, newStrokeId, randomHex, type RandomSource } from '../../src/format/ids';
import { seeded } from '../seeded';

test('page ids are p- and 6 hex characters, stroke ids 8 hex characters', () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(isPageId(newPageId([])), 'page id');
    assert.ok(isStrokeId(newStrokeId([])), 'stroke id');
  }
  assert.ok(!isPageId('p-7f3a') && !isPageId('p-7F3A0C') && !isPageId('7f3a0c') && isPageId('p-7f3a0c'));
  assert.ok(!isStrokeId('0123456') && !isStrokeId('0123456G') && isStrokeId('0123abcd'));
  assert.equal(randomHex(10, cryptoRandom).length, 10);
});

test('ids are unique within a note or page, even when the random source repeats', () => {
  const r = seeded(1);
  const pages: string[] = [];
  for (let i = 0; i < 2000; i++) pages.push(newPageId(pages, r.bytes));
  assert.equal(new Set(pages).size, pages.length);
  const strokes: string[] = [];
  for (let i = 0; i < 2000; i++) strokes.push(newStrokeId(strokes, r.bytes));
  assert.equal(new Set(strokes).size, strokes.length);

  // A source that returns the same bytes twice, then new ones: the clash is retried.
  let calls = 0;
  const stuck: RandomSource = b => { b.fill(calls++ < 2 ? 0xab : 0xcd); };
  assert.equal(newPageId([], stuck), 'p-ababab');
  assert.equal(newPageId(['p-ababab'], stuck), 'p-cdcdcd');
});

test('a seeded source gives reproducible ids', () => {
  const a = seeded(42), b = seeded(42);
  assert.equal(newPageId([], a.bytes), newPageId([], b.bytes));
  assert.equal(newStrokeId([], a.bytes), newStrokeId([], b.bytes));
});

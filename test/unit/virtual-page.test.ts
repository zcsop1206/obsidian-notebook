// The virtual blank page after the last page (#28): its place in the layout, which tools make it
// a real page, and which pages made from it are dropped when the note closes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A4, LETTER } from '../../src/format/page';
import { emptyGhostPages, FOOTER, GAP, inksGhost, layoutPages, MARGIN, mostVisiblePage, pageAtY, pagesInBand } from '../../src/ink/layout';

test('virtual page: laid out after the last page, the footer below it', () => {
  const plain = layoutPages([LETTER, A4], 848, LETTER);
  const l = layoutPages([LETTER, A4], 848, LETTER, 1, LETTER);
  assert.equal(plain.ghost, null);
  assert.deepEqual(l.pages, plain.pages); // real pages don't move
  assert.deepEqual(l.ghost, { top: plain.footerTop, left: MARGIN, width: 816, height: 1056 });
  assert.equal(l.footerTop, plain.footerTop + 1056 + GAP);
  assert.equal(l.height, l.footerTop + FOOTER);
  // Only real pages are pages: bands, the page at a height and the current page ignore it.
  assert.deepEqual(pagesInBand(l, l.ghost!.top, l.ghost!.top + 100), []);
  assert.equal(pageAtY(l, l.ghost!.top + 10), 1);
  assert.equal(mostVisiblePage(l, l.ghost!.top, l.ghost!.top + 500), -1);
  // A note with no pages still shows it.
  const none = layoutPages([], 848, LETTER, 1, LETTER);
  assert.deepEqual(none.ghost, { top: MARGIN, left: MARGIN, width: 816, height: 1056 });
});

test('virtual page: becoming a real page moves nothing, at any zoom', () => {
  for (const zoom of [0.5, 1, 2.5, 4]) {
    const before = layoutPages([A4, A4], 848, A4, zoom, LETTER);
    const after = layoutPages([A4, A4, LETTER], 848, A4, zoom, LETTER);
    assert.equal(after.scale, before.scale); // the wider virtual page counts in the fitted width
    assert.equal(after.width, before.width);
    assert.deepEqual(after.pages.slice(0, 2), before.pages);
    assert.deepEqual(after.pages[2], before.ghost);
    assert.equal(after.ghost!.top, before.ghost!.top + before.ghost!.height + GAP);
  }
});

test('virtual page: only the pen and highlighter make it a real page', () => {
  assert.deepEqual(['pen', 'highlighter', 'eraser', 'lasso'].map(inksGhost), [true, true, false, false]);
});

test('virtual page: empty pages made from it at the end are dropped, nothing else', () => {
  const made = new Set(['c', 'd', 'e']);
  const pages = (strokes: (number | null)[]) => strokes.map((n, i) => ({ id: 'abcde'[i], strokes: n }));
  assert.deepEqual(emptyGhostPages(pages([3, 0, 5, 0, 0]), made), ['e', 'd']);
  assert.deepEqual(emptyGhostPages(pages([3, 0, 0, 2, 0]), made), ['e']); // 'c' is not at the end
  assert.deepEqual(emptyGhostPages(pages([3, 0, 0, 0, 1]), made), []);
  assert.deepEqual(emptyGhostPages(pages([0, 0]), made), []); // added explicitly: kept
  assert.deepEqual(emptyGhostPages(pages([0, 0, 0, 0, null]), made), []); // unreadable: kept
  assert.deepEqual(emptyGhostPages([], made), []);
});

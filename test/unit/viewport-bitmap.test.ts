// Viewport bitmaps (#52): past iOS's canvas limit a page bitmap covers a band of the page around
// the viewport at full device resolution (bitmapBand), and is redrawn over another part as the
// view leaves it (bandNeed). Pure layout arithmetic; the view test (section 29) checks the pixels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandNeed, bitmapBand, type Band } from '../../src/ink/layout';

const MAX = 16_000_000;
/** A Letter page at 400% on the iPad (CSS px), its viewport in landscape and portrait. */
const PAGE = { w: 3264, h: 4224 };
const LANDSCAPE = { width: 1180, height: 760 }, PORTRAIT = { width: 820, height: 1120 };
const inside = (b: Band, v: Band, w: number, h: number) =>
  b.x <= Math.max(0, v.x) && b.y <= Math.max(0, v.y) && b.x + b.width >= Math.min(w, v.x + v.width) && b.y + b.height >= Math.min(h, v.y + v.height);

test('bitmapBand: the whole page (null) while it fits at device resolution, as before #52', () => {
  assert.equal(bitmapBand(816, 1056, { x: 0, y: 0, width: 816, height: 700 }, 2, MAX), null); // 100%: 3.4M device px
  assert.equal(bitmapBand(1632, 2112, { x: 100, y: 300, width: 1000, height: 700 }, 2, MAX), null); // 200% of an 816 px page: 13.8M
  assert.notEqual(bitmapBand(1706, 2208, { x: 0, y: 0, width: 885, height: 650 }, 2.5, MAX), null); // the same at a higher ratio
});

test('bitmapBand: at 400% a band around the viewport at full resolution, within the limit, in whole px, inside the page', () => {
  for (const vp of [LANDSCAPE, PORTRAIT]) {
    for (const [x, y] of [[1000, 1500], [0, 0], [PAGE.w - vp.width, PAGE.h - vp.height], [-40, 2000], [2500, -30]]) {
      const v = { x, y, ...vp }, b = bitmapBand(PAGE.w, PAGE.h, v, 2, MAX)!;
      assert.ok(b, 'a band');
      assert.ok(b.width * b.height * 4 <= MAX, `${b.width} x ${b.height} fits`);
      assert.ok(inside(b, v, PAGE.w, PAGE.h), `covers the visible part ${JSON.stringify(v)}: ${JSON.stringify(b)}`);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= PAGE.w && b.y + b.height <= PAGE.h, 'inside the page');
      for (const k of [b.x, b.y, b.width, b.height]) assert.ok(Number.isInteger(k), 'whole CSS px');
      assert.ok(b.width > vp.width && b.height > vp.height, 'with a margin');
    }
  }
  // Centred on the viewport when there's room: the viewport plus half a viewport each way (portrait: shrunk to fit).
  const b = bitmapBand(PAGE.w, PAGE.h, { x: 1000, y: 1500, ...LANDSCAPE }, 2, MAX)!;
  assert.ok(Math.abs(b.x + b.width / 2 - (1000 + LANDSCAPE.width / 2)) <= 1 && Math.abs(b.y + b.height / 2 - (1500 + LANDSCAPE.height / 2)) <= 1, JSON.stringify(b));
  assert.ok(b.width * b.height * 4 < 32_000_000 / 2, 'less than a whole capped page');
});

test('bitmapBand: a page off screen gets the part nearest the viewport; a viewport too big for the limit gets just itself', () => {
  const below = bitmapBand(PAGE.w, PAGE.h, { x: 800, y: -900, ...LANDSCAPE }, 2, MAX)!;
  assert.equal(below.y, 0, 'the top of a page below the view');
  const above = bitmapBand(PAGE.w, PAGE.h, { x: 800, y: PAGE.h + 500, ...LANDSCAPE }, 2, MAX)!;
  assert.equal(above.y + above.height, PAGE.h, 'the bottom of a page above it');
  const huge = bitmapBand(PAGE.w, PAGE.h, { x: 100, y: 100, width: 3000, height: 2000 }, 2, MAX)!;
  assert.deepEqual(huge, { x: 100, y: 100, width: 3000, height: 2000 }, 'the viewport alone (drawn at a lower resolution)');
});

test('bandNeed: ok inside the band, soon when half the margin is used, now when the view shows uncovered page', () => {
  const v = { x: 1000, y: 1500, ...LANDSCAPE }, b = bitmapBand(PAGE.w, PAGE.h, v, 2, MAX)!;
  const at = (dx: number, dy: number) => bandNeed(b, { ...v, x: v.x + dx, y: v.y + dy }, PAGE.w, PAGE.h);
  const mx = (b.width - LANDSCAPE.width) / 2, my = (b.height - LANDSCAPE.height) / 2;
  assert.equal(at(0, 0), 'ok');
  assert.equal(at(0, my * 0.4), 'ok');
  assert.equal(at(0, my * 0.6), 'soon');
  assert.equal(at(-mx * 0.6, 0), 'soon');
  assert.equal(at(0, my + 1), 'now');
  assert.equal(at(-mx - 1, 0), 'now');
  // At the page's edge the band can't move further: no need to redraw.
  const top = bitmapBand(PAGE.w, PAGE.h, { x: 1000, y: 0, ...LANDSCAPE }, 2, MAX)!;
  assert.equal(top.y, 0);
  assert.equal(bandNeed(top, { x: 1000, y: -200, ...LANDSCAPE }, PAGE.w, PAGE.h), 'ok');
  // A page out of view never needs it.
  assert.equal(bandNeed(b, { x: 0, y: PAGE.h + 100, ...LANDSCAPE }, PAGE.w, PAGE.h), 'ok');
});

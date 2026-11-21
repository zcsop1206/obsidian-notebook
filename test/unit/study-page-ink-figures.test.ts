// Page ink over passage figures (S18): a page stroke with at least half its points on a figure draws
// in the dark figure ink in both themes, the same colour as figure ink (S13); a stroke that only
// crosses a figure's edge, or lies off every figure, keeps the theme colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_FIGURE_INK, strokeOverFigure, type PaperRect } from '../../src/study/ink/page';
import { FIGURE_INK } from '../../src/study/blocks/figure-ink';

const fig: PaperRect = { x0: 100, y0: 200, x1: 400, y1: 350 };
const line = (x0: number, x1: number, y: number, n = 21) => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y, 0.5, i]);

test('page figure ink is the figure ink colour', () => {
  assert.equal(PAGE_FIGURE_INK, FIGURE_INK);
});

test('a stroke inside a figure is over it; one beside it is not', () => {
  assert.equal(strokeOverFigure(line(150, 350, 300), 0, [fig]), true);
  assert.equal(strokeOverFigure(line(150, 350, 500), 0, [fig]), false);
  assert.equal(strokeOverFigure(line(150, 350, 300), 0, []), false);
  assert.equal(strokeOverFigure([], 0, [fig]), false);
});

test('the placement offset moves the stroke onto or off a figure', () => {
  assert.equal(strokeOverFigure(line(150, 350, 50), 250, [fig]), true);
  assert.equal(strokeOverFigure(line(150, 350, 300), 300, [fig]), false);
});

test('half or more of the points decide: crossing an edge keeps the theme colour', () => {
  assert.equal(strokeOverFigure(line(0, 160, 300), 0, [fig]), false); // 8 of 21 points on the figure
  assert.equal(strokeOverFigure(line(200, 600, 300), 0, [fig]), true); // exactly half
  assert.equal(strokeOverFigure(line(150, 350, 351), 0, [fig]), true); // within the 2 px pad
  assert.equal(strokeOverFigure(line(150, 350, 360), 0, [fig]), false);
});

test('any of several figures counts', () => {
  const second: PaperRect = { x0: 100, y0: 600, x1: 400, y1: 700 };
  assert.equal(strokeOverFigure(line(150, 350, 650), 0, [fig, second]), true);
});

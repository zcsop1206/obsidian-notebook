// Zoom and finger navigation (#9): layout at a zoom, zoom steps, release velocity and momentum
// decay, and the pinch maths (the preview scale and the scroll that keeps the pinch centre on
// the same page point).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A4, LETTER } from '../../src/format/page';
import { GAP, layoutPages, MARGIN } from '../../src/ink/layout';
import {
  anchorAt, anchorPoint, clampZoom, DECAY_PER_MS, FRAME_MS, MAX_ZOOM, MIN_ZOOM, momentumStep, pinchScale, releaseVelocity,
  scrollToKeep, STOP_SPEED, VELOCITY_MS, zoomStep, type Vec,
} from '../../src/ink/navigate';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test('layout at a zoom: boxes scale, margins and gaps stay, the layer widens above 100%', () => {
  const one = layoutPages([LETTER, A4], 848, LETTER);
  assert.equal(one.zoom, 1);
  assert.equal(one.width, 848);
  const two = layoutPages([LETTER, A4], 848, LETTER, 2);
  assert.equal(two.scale, one.scale * 2);
  assert.deepEqual(two.pages[0], { top: MARGIN, left: MARGIN, width: 1632, height: 2112 });
  assert.equal(two.width, 1632 + 2 * MARGIN); // wider than the view: scrolls sideways
  assert.equal(two.pages[1].top, MARGIN + 2112 + GAP);
  assert.equal(two.pages[1].width, 1588);
  assert.equal(two.pages[1].left, MARGIN + Math.round((1632 - 1588) / 2)); // the narrower page centred in the layer
  const four = layoutPages([LETTER], 848, LETTER, 4);
  assert.deepEqual([four.pages[0].width, four.pages[0].height, four.width], [3264, 4224, 3264 + 2 * MARGIN]);
  // 1000% (#60): a Letter page fitted to 816 CSS px is 8160 wide; the layer scrolls sideways.
  const ten = layoutPages([LETTER, LETTER], 848, LETTER, 10);
  assert.deepEqual([ten.pages[0].width, ten.pages[0].height, ten.width], [8160, 10560, 8160 + 2 * MARGIN]);
  assert.equal(ten.pages[1].top, MARGIN + 10560 + GAP);
});

test('layout at a zoom: below 100% the pages stay centred in the view width', () => {
  const half = layoutPages([LETTER, A4], 848, LETTER, 0.5);
  assert.equal(half.width, 848);
  assert.deepEqual(half.pages[0], { top: MARGIN, left: Math.round((848 - 408) / 2), width: 408, height: 528 });
  assert.equal(half.pages[1].left, Math.round((848 - 397) / 2));
  assert.equal(half.pages[1].top, MARGIN + 528 + GAP);
});

test('zoom: clamped to 50-1000% (#60), commands step by 25% up to 400%, then 500, 600, 800, 1000%', () => {
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(MAX_ZOOM, 10);
  assert.equal(clampZoom(9), 9);
  assert.equal(clampZoom(12), MAX_ZOOM);
  assert.equal(zoomStep(1, 1), 1.25);
  assert.equal(zoomStep(1, -1), 0.75);
  assert.equal(zoomStep(1.1, 1), 1.25); // to the next step, not 1.35
  assert.equal(zoomStep(1.1, -1), 1);
  assert.equal(zoomStep(0.5, -1), 0.5);
  assert.equal(zoomStep(0.6, -1), 0.5);
  assert.equal(zoomStep(3.75, 1), 4);
  const up = [4];
  while (up[up.length - 1] < MAX_ZOOM) up.push(zoomStep(up[up.length - 1], 1));
  assert.deepEqual(up, [4, 5, 6, 8, 10]);
  assert.equal(zoomStep(10, 1), 10);
  const down = [10];
  while (down[down.length - 1] > 3) down.push(zoomStep(down[down.length - 1], -1));
  assert.deepEqual(down, [10, 8, 6, 5, 4, 3.75, 3.5, 3.25, 3]);
  assert.equal(zoomStep(4.2, 1), 5); // off a step: to the next one
  assert.equal(zoomStep(4.2, -1), 4);
  assert.equal(zoomStep(7, -1), 6);
  assert.equal(zoomStep(7, 1), 8);
});

test('momentum: release velocity over the last 100 ms', () => {
  assert.deepEqual(releaseVelocity([]), { x: 0, y: 0 });
  assert.deepEqual(releaseVelocity([{ t: 5, x: 1, y: 1 }]), { x: 0, y: 0 });
  // Slow at first, then 2 px/ms downwards over the last 100 ms: only the last 100 ms count.
  const samples = [];
  for (let t = 0; t <= 300; t += 10) samples.push({ t, x: 0, y: t < 200 ? t * 0.1 : 20 + (t - 200) * 2 });
  const v = releaseVelocity(samples);
  assert.ok(near(v.y, 2) && v.x === 0, JSON.stringify(v));
  assert.equal(VELOCITY_MS, 100);
});

test('momentum: exponential decay, the distance is the integral, and it stops under 0.1 px per frame', () => {
  // One step of 100 ms equals ten steps of 10 ms.
  const v0: Vec = { x: 0, y: 3 };
  const big = momentumStep(v0, 100);
  let v = v0, dy = 0;
  for (let i = 0; i < 10; i++) {
    const s = momentumStep(v, 10);
    dy += s.dy;
    v = s.v;
  }
  assert.ok(near(big.dy, dy, 1e-9) && near(big.v.y, v.y, 1e-12), `${big.dy} ${dy}`);
  assert.ok(near(big.v.y, 3 * Math.pow(DECAY_PER_MS, 100)));
  assert.ok(big.dy < 3 * 100 && big.dy > 3 * 100 * Math.pow(DECAY_PER_MS, 100));
  // Frame by frame until it stops: the total is close to v0 / -ln(decay), and it ends.
  v = { x: 1.2, y: -1.6 };
  let frames = 0, x = 0, y = 0;
  while ((v.x || v.y) && frames < 10000) {
    const s = momentumStep(v, FRAME_MS);
    x += s.dx;
    y += s.dy;
    v = s.v;
    frames++;
  }
  const total = 2 / -Math.log(DECAY_PER_MS);
  assert.ok(frames < 10000 && frames > 60, `${frames}`);
  assert.ok(Math.hypot(x, y) > total * 0.95 && Math.hypot(x, y) < total, `${Math.hypot(x, y)} ${total}`);
  assert.deepEqual(momentumStep({ x: STOP_SPEED * 0.9, y: 0 }, FRAME_MS).v, { x: 0, y: 0 });
});

test('pinch: the preview scale is the distance ratio, clamped to the zoom range', () => {
  assert.equal(pinchScale(1, 100, 200), 2);
  assert.equal(pinchScale(1, 100, 50), 0.5);
  assert.equal(pinchScale(1, 100, 20), 0.5); // 20% clamps to 50%
  assert.equal(pinchScale(2, 100, 400), 4); // 800%
  assert.equal(pinchScale(4, 100, 400), 2.5); // 1600% clamps to 1000%
  assert.equal(pinchScale(10, 100, 150), 1);
  assert.equal(pinchScale(1, 0, 100), 1);
});

test('pinch: after the zoom the same page point is under the pinch centre', () => {
  const sizes = [LETTER, LETTER, A4, LETTER];
  const before = layoutPages(sizes, 848, LETTER);
  // A point on page 2, seen at (300, 250) of the viewport.
  const scroll = { left: 0, top: 2300 }, v = { x: 300, y: 250 };
  const a = anchorAt(before, scroll.left + v.x, scroll.top + v.y)!;
  assert.equal(a.index, 2);
  for (const zoom of [0.5, 2, 4, 10]) {
    const after = layoutPages(sizes, 848, LETTER, zoom);
    const to = scrollToKeep(after, a, v.x, v.y);
    // Seen through the new scroll position, the point is at v and is the same page point.
    const b = anchorAt(after, to.left + v.x, to.top + v.y)!;
    assert.equal(b.index, 2);
    assert.ok(near(b.fx, a.fx, 1e-9) && near(b.fy, a.fy, 1e-9), `${zoom}: ${JSON.stringify([a, b])}`);
    const p = anchorPoint(after, a);
    assert.ok(near(p.x - to.left, v.x) && near(p.y - to.top, v.y));
    // Distances on the page scale with the zoom: 100 CSS px at 100% is 100 × zoom CSS px after
    // (up to the page boxes' rounding to whole px).
    const q = anchorPoint(after, { ...a, fx: a.fx + 100 / before.pages[2].width });
    assert.ok(Math.abs(q.x - p.x - 100 * zoom) < 0.5, `${q.x - p.x}`);
  }
  assert.equal(anchorAt(layoutPages([], 848, LETTER), 10, 10), null);
});

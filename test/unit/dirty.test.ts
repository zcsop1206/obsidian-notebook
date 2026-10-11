// Dirty rectangles (#68): the arithmetic of a page bitmap's partial redraw (src/ink/dirty.ts).
// The union of erased strokes' bounds, the page-to-device transform of whole-page and band
// bitmaps, the clip in device px (whole pixels, inside the bitmap, missing a band it's outside
// of), the page rectangle strokes must meet, the part of a template image to draw, and the
// tiles of a sharp PDF render. The view test (section 33) checks the pixels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipHolds, deviceClip, imagePart, meets, pageMatrix, pageRectOf, tiles, unionRect, unionRects, type Rect } from '../../src/ink/dirty';
import { strokeBounds } from '../../src/ink/renderer';
import type { Stroke } from '../../src/format/page';

const stroke = (id: string, size: number, pts: [number, number][]): Stroke =>
  ({ id, tool: 'pen', nib: 'uniform', color: '#000000', size, points: pts.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 8 })) });

test('strokeBounds union: grown by size + 1, the smallest rectangle holding all', () => {
  const a = stroke('s-1', 2, [[100, 200], [150, 210], [140, 260]]);
  const b = stroke('s-2', 4, [[300, 50], [320, 60]]);
  assert.deepEqual(strokeBounds(a), [97, 197, 153, 263]);
  assert.deepEqual(strokeBounds(b), [295, 45, 325, 65]);
  assert.deepEqual(unionRects([a, b].map(strokeBounds)), [97, 45, 325, 263]);
  assert.equal(unionRects([]), null);
  assert.deepEqual(unionRect(null, [1, 2, 3, 4]), [1, 2, 3, 4]);
  // A dot: one point, still a box around it.
  assert.deepEqual(strokeBounds(stroke('s-3', 1, [[10, 10]])), [8, 8, 12, 12]);
});

test('meets: overlapping and touching rectangles meet, separate ones do not', () => {
  const r: Rect = [10, 10, 20, 20];
  assert.ok(meets(r, [15, 15, 30, 30]));
  assert.ok(meets(r, [20, 0, 25, 10])); // corner touch
  assert.ok(meets(r, [0, 0, 100, 100])); // inside
  assert.ok(!meets(r, [21, 10, 30, 20]));
  assert.ok(!meets(r, [10, 20.5, 20, 30]));
});

test('pageMatrix: a whole page scales page px to the bitmap; a band shifts its corner to the origin', () => {
  // Letter at 100%, 2x: 816 x 1056 page px on a 1632 x 2112 bitmap.
  assert.deepEqual(pageMatrix(1632, 2112, 816, 1056, 816, 1056, null), { a: 2, d: 2, e: 0, f: 0 });
  // 400% on a 2x display: page box 3264 x 4224 CSS px, a band 2000 x 1500 CSS px at (1000, 1200), 4000 x 3000 device px.
  const m = pageMatrix(4000, 3000, 3264, 4224, 816, 1056, { x: 1000, y: 1200, width: 2000, height: 1500 });
  assert.deepEqual(m, { a: 8, d: 8, e: -2000, f: -2400 });
  // Page point (250, 300) is CSS (1000, 1200) of the box: the band's corner.
  assert.equal(250 * m.a + m.e, 0);
  assert.equal(300 * m.d + m.f, 0);
});

test('deviceClip: whole device px around the rectangle, grown one pixel, clamped to the bitmap', () => {
  const m = pageMatrix(1632, 2112, 816, 1056, 816, 1056, null);
  assert.deepEqual(deviceClip([10.2, 20.7, 30.1, 40], m, 1632, 2112), { x: 19, y: 40, width: 43, height: 41 });
  // Past the page's edges: clamped.
  assert.deepEqual(deviceClip([-50, -50, 5, 5], m, 1632, 2112), { x: 0, y: 0, width: 11, height: 11 });
  assert.deepEqual(deviceClip([810, 1050, 900, 1100], m, 1632, 2112), { x: 1619, y: 2099, width: 13, height: 13 });
  // Entirely off the bitmap: nothing.
  assert.equal(deviceClip([900, 10, 950, 20], m, 1632, 2112), null);
  // Without growing, an exact pixel-aligned rectangle stays as it is.
  assert.deepEqual(deviceClip([10, 20, 30, 40], m, 1632, 2112, 0), { x: 20, y: 40, width: 40, height: 40 });
});

test('deviceClip in a band bitmap: in the band\'s device px; a rectangle outside the band gives nothing', () => {
  const band = { x: 1000, y: 1200, width: 2000, height: 1500 }, m = pageMatrix(4000, 3000, 3264, 4224, 816, 1056, band);
  // Page px (260, 310)-(270, 320) is device (80, 80)-(160, 160) of the band, grown one pixel.
  assert.deepEqual(deviceClip([260, 310, 270, 320], m, 4000, 3000), { x: 79, y: 79, width: 82, height: 82 });
  // Straddling the band's top-left corner: clipped to it.
  assert.deepEqual(deviceClip([240, 290, 255, 305], m, 4000, 3000), { x: 0, y: 0, width: 41, height: 41 });
  // Above the band (another part of the page): nothing to redraw.
  assert.equal(deviceClip([100, 100, 200, 200], m, 4000, 3000), null);
  // The band's far edge: page x 250 + 4000 / 8 = 750.
  assert.equal(deviceClip([751, 400, 760, 410], m, 4000, 3000), null);
  assert.notEqual(deviceClip([745, 400, 760, 410], m, 4000, 3000), null);
});

test('clipHolds: a stroke\'s pixels wholly inside the clip, or off the bitmap', () => {
  const clip = { x: 100, y: 100, width: 50, height: 40 };
  assert.ok(clipHolds(clip, { x: 100, y: 100, width: 50, height: 40 }));
  assert.ok(clipHolds(clip, { x: 120, y: 110, width: 10, height: 10 }));
  assert.ok(clipHolds(clip, null));
  assert.ok(!clipHolds(clip, { x: 99, y: 110, width: 10, height: 10 }));
  assert.ok(!clipHolds(clip, { x: 140, y: 110, width: 11, height: 10 }));
  assert.ok(!clipHolds(clip, { x: 120, y: 135, width: 10, height: 6 }));
});

test('pageRectOf:the page rectangle of a clip, grown one device px; it covers the dirty rectangle', () => {
  for (const [m, w, h] of [
    [pageMatrix(1632, 2112, 816, 1056, 816, 1056, null), 1632, 2112],
    [pageMatrix(4000, 3000, 3264, 4224, 816, 1056, { x: 1000, y: 1200, width: 2000, height: 1500 }), 4000, 3000],
    [pageMatrix(300, 388, 816, 1056, 816, 1056, null), 300, 388], // a small bitmap: a device px is several page px
  ] as const) {
    const rect: Rect = [300.3, 400.6, 320.2, 433.9];
    const clip = deviceClip(rect, m, w, h)!, area = pageRectOf(clip, m);
    assert.ok(area[0] <= rect[0] && area[1] <= rect[1] && area[2] >= rect[2] && area[3] >= rect[3], JSON.stringify({ rect, area }));
    // One device px beyond the clip on every side.
    assert.ok(Math.abs((clip.x - 1 - m.e) / m.a - area[0]) < 1e-9);
    assert.ok(Math.abs((clip.y + clip.height + 1 - m.f) / m.d - area[3]) < 1e-9);
    // A stroke whose bounds miss it can't reach a pixel of the clip; one that touches it is drawn.
    const px = 1 / m.a;
    assert.ok(!meets([area[2] + px, area[1], area[2] + 5 * px, area[3]], area));
    assert.ok(meets([area[2], area[1], area[2] + 5 * px, area[3]], area));
  }
});

test('imagePart: whole source px around the region plus a margin, landing where the whole image puts them', () => {
  // A 1275 x 1650 JPEG (150 dpi Letter) drawn over a 1632 x 2112 bitmap.
  const p = imagePart(1275, 1650, 1632, 2112, [160, 320, 480, 640])!;
  const kx = 1275 / 1632, ky = 1650 / 2112;
  assert.deepEqual([p.sx, p.sy], [Math.floor(160 * kx) - 2, Math.floor(320 * ky) - 2]);
  assert.deepEqual([p.sx + p.sw, p.sy + p.sh], [Math.ceil(480 * kx) + 2, Math.ceil(640 * ky) + 2]);
  // The same scale as the whole image: source px s lands at s / k.
  assert.ok(Math.abs(p.dx - p.sx / kx) < 1e-9 && Math.abs(p.dw - p.sw / kx) < 1e-9);
  assert.ok(Math.abs(p.dy - p.sy / ky) < 1e-9 && Math.abs(p.dh - p.sh / ky) < 1e-9);
  // It covers the region.
  assert.ok(p.dx <= 160 && p.dy <= 320 && p.dx + p.dw >= 480 && p.dy + p.dh >= 640);
  // Clamped at the image's edges.
  const e = imagePart(100, 100, 200, 200, [-10, -10, 3, 250])!;
  assert.deepEqual([e.sx, e.sy, e.sx + e.sw, e.sy + e.sh], [0, 0, 4, 100]);
  // A 1:1 image (a sharp render at the bitmap's size, a band's line template): source = device px.
  const one = imagePart(1632, 2112, 1632, 2112, [19, 40, 62, 82], 0)!;
  assert.deepEqual(one, { sx: 19, sy: 40, sw: 43, sh: 42, dx: 19, dy: 40, dw: 43, dh: 42 });
  // Outside the image, or an image of unknown size: nothing.
  assert.equal(imagePart(100, 100, 200, 200, [210, 0, 220, 10], 0), null);
  assert.equal(imagePart(0, 0, 200, 200, [0, 0, 10, 10]), null);
});

test('tiles: a sharp render in tiles of at most 1024 px, covering it exactly once', () => {
  const t = tiles(2550, 3300, 1024);
  assert.equal(t.length, 3 * 4);
  assert.deepEqual(t[0], [0, 0, 1024, 1024]);
  assert.deepEqual(t[2], [2048, 0, 502, 1024]);
  assert.deepEqual(t[t.length - 1], [2048, 3072, 502, 228]);
  assert.equal(t.reduce((n, [, , w, h]) => n + w * h, 0), 2550 * 3300);
  assert.ok(t.every(([, , w, h]) => w <= 1024 && h <= 1024 && w > 0 && h > 0));
  assert.deepEqual(tiles(500, 300, 1024), [[0, 0, 500, 300]]);
});

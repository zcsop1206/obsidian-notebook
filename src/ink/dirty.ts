// Dirty rectangles (#68): the arithmetic behind a page bitmap's partial redraw. Erasing and
// highlighting used to redraw a whole page bitmap per eraser frame or highlighter stroke; on a
// PDF page that is a full-resolution image blit (up to 16M device px) each time. Now only the
// part of the bitmap that can have changed is redrawn: a rectangle in page px (the union of the
// changed strokes' bounds) is mapped to whole device pixels of the bitmap (`deviceClip`), the
// bitmap is clipped to it and everything that meets it is drawn again, the template through
// the 9-argument drawImage of only the part of its image under the clip (`imagePart`).
//
// Pure functions of numbers, so they're unit-tested (test/unit/dirty.test.ts); renderer.ts
// draws with them and the view test checks that a partial redraw equals a full one pixel for
// pixel.

/** A rectangle [x0, y0, x1, y1] (left, top, right, bottom), as strokeBounds returns. */
export type Rect = [number, number, number, number];

/** A rectangle of whole device pixels of a bitmap. */
export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The axis-aligned transform from page px to a bitmap's device px: x' = a·x + e, y' = d·y + f
 * (what PageBitmap's pageTransform sets).
 */
export interface PageMatrix {
  a: number;
  d: number;
  e: number;
  f: number;
}

/** The smallest rectangle holding both (`a` null: `b`). */
export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return [b[0], b[1], b[2], b[3]];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The union of these rectangles, or null for none. */
export function unionRects(rects: Iterable<Rect>): Rect | null {
  let u: Rect | null = null;
  for (const r of rects) u = unionRect(u, r);
  return u;
}

/** Whether two rectangles meet (touching edges count). */
export function meets(a: Rect, b: Rect): boolean {
  return a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
}

/**
 * The page-to-device transform of a bitmap `canvasW` × `canvasH` device px over a page box
 * `cssW` × `cssH` CSS px of a page `pageW` × `pageH` page px; with `band` (#52), the bitmap
 * covers only that part of the page box (CSS px), its corner at the device origin.
 */
export function pageMatrix(canvasW: number, canvasH: number, cssW: number, cssH: number, pageW: number, pageH: number,
  band: Clip | null): PageMatrix {
  if (!band) return { a: canvasW / pageW, d: canvasH / pageH, e: 0, f: 0 };
  const dx = canvasW / band.width, dy = canvasH / band.height;
  return { a: dx * cssW / pageW, d: dy * cssH / pageH, e: -band.x * dx, f: -band.y * dy };
}

/**
 * The whole device pixels of a `width` × `height` bitmap that `rect` (page px) covers, grown by
 * `grow` device px each way (antialiasing reaches one pixel past an edge), clamped to the
 * bitmap; null if that's empty (the rectangle is outside the bitmap, e.g. outside a band).
 */
export function deviceClip(rect: Rect, m: PageMatrix, width: number, height: number, grow = 1): Clip | null {
  const xa = rect[0] * m.a + m.e, xb = rect[2] * m.a + m.e, ya = rect[1] * m.d + m.f, yb = rect[3] * m.d + m.f;
  const x0 = Math.max(0, Math.floor(Math.min(xa, xb) - grow)), x1 = Math.min(width, Math.ceil(Math.max(xa, xb) + grow));
  const y0 = Math.max(0, Math.floor(Math.min(ya, yb) - grow)), y1 = Math.min(height, Math.ceil(Math.max(ya, yb) + grow));
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The page px rectangle a device clip covers, grown by `grow` device px each way: what a stroke
 * must meet (by its bounds) to put any pixel inside the clip, antialiasing included.
 */
export function pageRectOf(clip: Clip, m: PageMatrix, grow = 1): Rect {
  const xa = (clip.x - grow - m.e) / m.a, xb = (clip.x + clip.width + grow - m.e) / m.a;
  const ya = (clip.y - grow - m.f) / m.d, yb = (clip.y + clip.height + grow - m.f) / m.d;
  return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
}

/**
 * The tiles a `width` × `height` px image is drawn in, at most `tile` px square (#68: a sharp
 * PDF render, one pdf.js render per tile): [x, y, w, h], row by row from the top left.
 */
export function tiles(width: number, height: number, tile: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) out.push([x, y, Math.min(tile, width - x), Math.min(tile, height - y)]);
  }
  return out;
}

/** A source rectangle of an image and where it lands: the arguments of the 9-argument drawImage. */
export interface ImagePart {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * For an image `iw` × `ih` px drawn stretched over (0, 0, W, H) of some coordinate space, the
 * part of it to draw for the region `r` of that space: whole source pixels covering it plus
 * `margin` source px each way (so the image's resampling filter sees the same neighbours as when
 * the whole image is drawn, and the clip, not the part's edge, decides which pixels change),
 * clamped to the image, and its destination by the same scale. Drawing only this part, clipped
 * to `r`, paints the same pixels as drawing the whole image clipped to `r`. Null if empty.
 */
export function imagePart(iw: number, ih: number, W: number, H: number, r: Rect, margin = 2): ImagePart | null {
  if (!(iw > 0 && ih > 0 && W > 0 && H > 0)) return null;
  const kx = iw / W, ky = ih / H;
  const sx0 = Math.max(0, Math.floor(r[0] * kx) - margin), sx1 = Math.min(iw, Math.ceil(r[2] * kx) + margin);
  const sy0 = Math.max(0, Math.floor(r[1] * ky) - margin), sy1 = Math.min(ih, Math.ceil(r[3] * ky) + margin);
  if (!(sx1 > sx0 && sy1 > sy0)) return null;
  return { sx: sx0, sy: sy0, sw: sx1 - sx0, sh: sy1 - sy0, dx: sx0 / kx, dy: sy0 / ky, dw: (sx1 - sx0) / kx, dh: (sy1 - sy0) / ky };
}

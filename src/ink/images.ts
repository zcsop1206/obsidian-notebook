// Images on pages (#12): reading a picked, pasted or dropped image file, scaling it to at most
// MAX_IMAGE_EDGE px on its long edge and encoding it (JPEG, or PNG when it has transparency);
// where it lands on a page; the geometry the lasso needs (boxes, hits, transforms); the file
// picker. The view (view.ts, "images (#12)", with the "keep the ink?" question) does the rest; the format is in page.ts.
import { newImageId, type RandomSource, cryptoRandom } from '../format/ids';
import { roundXY, type PageImage, type Size, type Stroke } from '../format/page';
import { pointInPolygon, type Box, type Transform } from './lasso';
import type { XY } from './spatial';

/** Images are stored at their own resolution up to this many px on the long edge. */
export const MAX_IMAGE_EDGE = 4096;
export const JPEG_QUALITY = 0.9;
/** An inserted image is fitted to at most this fraction of the page's width (and its height). */
export const INSERT_FRACTION = 0.5;

/** The pixel size an image of w × h is stored at: scaled down to MAX_IMAGE_EDGE, never up. */
export function storedSize(w: number, h: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * The box (page px) an image of pixel size w × h gets when inserted on a page of `page` size:
 * its aspect kept, at most INSERT_FRACTION of the page's width and height, centred on (cx, cy)
 * and kept on the page.
 */
export function placeImage(w: number, h: number, page: Size, cx: number, cy: number): { x: number; y: number; width: number; height: number } {
  const k = Math.min(page.width * INSERT_FRACTION / w, page.height * INSERT_FRACTION / h);
  const width = roundXY(w * k), height = roundXY(h * k);
  const x = Math.min(Math.max(0, cx - width / 2), page.width - width);
  const y = Math.min(Math.max(0, cy - height / 2), page.height - height);
  return { x: roundXY(x), y: roundXY(y), width, height };
}

/** The size of a whole-page image (#12): the paper's width, the image's aspect. */
export function imagePageSize(w: number, h: number, paper: Size): Size {
  return { width: paper.width, height: roundXY(paper.width * h / Math.max(1, w)) };
}

export const imageBox = (im: Pick<PageImage, 'x' | 'y' | 'width' | 'height'>): Box => [im.x, im.y, im.x + im.width, im.y + im.height];

/** The topmost image whose box holds (x, y), or null. */
export function imageAt(images: readonly PageImage[] | undefined, x: number, y: number): PageImage | null {
  if (!images) return null;
  for (let i = images.length - 1; i >= 0; i--) {
    const im = images[i];
    if (x >= im.x && x <= im.x + im.width && y >= im.y && y <= im.y + im.height) return im;
  }
  return null;
}

/** The ids of the images whose centre is inside the lasso loop. */
export function imagesInLoop(images: readonly PageImage[] | undefined, loop: readonly XY[]): string[] {
  if (!images || loop.length < 3) return [];
  return images.filter(im => pointInPolygon(im.x + im.width / 2, im.y + im.height / 2, loop)).map(im => im.id);
}

/** The union of two boxes, either of which may be null. */
export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The box around the images, or null for none. */
export function imagesBounds(images: Iterable<PageImage>): Box | null {
  let b: Box | null = null;
  for (const im of images) b = unionBox(b, imageBox(im));
  return b;
}

/** A copy of the image transformed like transformStroke (lasso.ts), rounded as stored. */
export function transformImage(im: PageImage, t: Transform): PageImage {
  const { k, ox, oy, dx, dy } = t;
  return {
    ...im,
    x: roundXY(ox + (im.x - ox) * k + dx),
    y: roundXY(oy + (im.y - oy) * k + dy),
    width: Math.max(0.1, roundXY(im.width * k)),
    height: Math.max(0.1, roundXY(im.height * k)),
  };
}

/** The strokes written on these images (their `on`), in drawing order. */
export function inkOn(strokes: readonly Stroke[], imageIds: Iterable<string>): Stroke[] {
  const ids = new Set(imageIds);
  return ids.size ? strokes.filter(s => s.on !== undefined && ids.has(s.on)) : [];
}

/**
 * Copies of images and strokes (deep) with image ids unique among `taken` (which grows); with
 * `always`, every image gets a new id. Strokes' `on` follow their image's new id; strokes on
 * images not among these lose it.
 */
export function withImageIds(images: readonly PageImage[], strokes: readonly Stroke[], taken: Set<string>, always: boolean,
  random: RandomSource = cryptoRandom): { images: PageImage[]; strokes: Stroke[] } {
  const map = new Map<string, string>();
  const out = images.map(im => {
    const id = always || taken.has(im.id) ? newImageId(taken, random) : im.id;
    taken.add(id);
    map.set(im.id, id);
    return { ...im, id };
  });
  const moved = strokes.map(s => {
    if (s.on === undefined) return s;
    const on = map.get(s.on);
    if (on) return { ...s, on };
    const { on: _, ...rest } = s;
    return rest as Stroke;
  });
  return { images: out, strokes: moved };
}

/** A stroke without its `on`. */
export function offImage(s: Stroke): Stroke {
  if (s.on === undefined) return s;
  const { on: _, ...rest } = s;
  return rest as Stroke;
}

// ---- reading and encoding

export interface PreparedImage {
  /** A data URL: image/jpeg for opaque images, image/png with transparency. */
  data: string;
  /** The stored pixel size. */
  width: number;
  height: number;
  /** The source's pixel size. */
  sourceWidth: number;
  sourceHeight: number;
  /** Time to decode, and to scale and encode, in ms. */
  decodeMs: number;
  encodeMs: number;
}

/** Decodes an image file (EXIF orientation applied). Throws if it isn't an image the web view reads. */
async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall back to an <img> (older WebKit can't make bitmaps of some types)
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error("the file isn't an image this device can read");
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

/** Whether any pixel of the canvas is not fully opaque. */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const rows = Math.max(1, Math.floor(4_000_000 / w)); // read in bands of about 4 M pixels
  for (let y = 0; y < h; y += rows) {
    const d = ctx.getImageData(0, y, w, Math.min(rows, h - y)).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  }
  return false;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("couldn't read the encoded image"));
    r.readAsDataURL(blob);
  });
}

/**
 * Reads an image file and returns it as it's stored: at most MAX_IMAGE_EDGE px on its long edge,
 * JPEG (quality JPEG_QUALITY), or PNG if the file may have transparency (not a JPEG) and does.
 */
export async function prepareImage(blob: Blob, max = MAX_IMAGE_EDGE): Promise<PreparedImage> {
  const t0 = performance.now();
  const src = await decode(blob);
  const t1 = performance.now();
  try {
    if (!src.width || !src.height) throw new Error('the image is empty');
    const { width, height } = storedSize(src.width, src.height, max);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.source, 0, 0, width, height);
    const png = !/^image\/jpe?g$/i.test(blob.type) && hasAlpha(ctx, width, height);
    const type = png ? 'image/png' : 'image/jpeg';
    const encoded = await new Promise<Blob | null>(res => canvas.toBlob(res, type, JPEG_QUALITY));
    const data = encoded ? await blobToDataURL(encoded) : canvas.toDataURL(type, JPEG_QUALITY);
    canvas.width = canvas.height = 0; // free it now (iOS keeps canvas memory until shrunk)
    return { data, width, height, sourceWidth: src.width, sourceHeight: src.height, decodeMs: t1 - t0, encodeMs: performance.now() - t1 };
  } finally {
    src.close();
  }
}

/** The first image file of a paste or drop, or null. */
export function imageFromTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  for (const f of Array.from(data.files ?? [])) if (f.type.startsWith('image/')) return f;
  return null;
}

/**
 * Opens the system picker for an image (on the iPad: Photos, the camera or Files). Must run
 * within the user's tap or click.
 */
export function pickImageFile(onChoose: (file: File) => void) {
  const input = document.body.createEl('input', { type: 'file', cls: 'nb-image-file-input' });
  input.accept = 'image/*';
  const done = () => input.remove();
  input.addEventListener('cancel', done);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    done();
    if (file) onChoose(file);
  });
  input.click();
}

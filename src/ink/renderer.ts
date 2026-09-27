// Page bitmaps. Each page near the viewport gets a canvas at device resolution holding its
// finished strokes: paper colour, the template layer, highlighter strokes composited at 40%,
// then pen strokes, the same layers and colours as the page's SVG. A new stroke is drawn onto
// the existing bitmap; the whole page is redrawn only on load, resize, theme change or when
// strokes are removed. Images placed on the page (#12) are drawn over the template, under the
// highlighter layer, from decoded <img>s cached per image (ObjectImages).
//
// Viewport bitmaps (#52): when a whole page at device resolution would exceed MAX_CANVAS_PIXELS
// (a Letter page from about 200% up on the iPad), the view gives the page a bitmap of only the
// band of it around the viewport (`band`, see bitmapBand in layout.ts), at full device
// resolution, positioned over that part of the page; below the cap a bitmap is the whole page,
// as before. Everything is drawn in page px through pageTransform, so strokes, images and the
// highlighter layer outside the band are simply clipped.
import { DEFAULT_INK, prepareSave, type Page, type PageImage, type Size, type Stroke } from '../format/page';
import { strokePathCached } from '../format/outline';
import { fixedPaper, renderTemplate, type PdfTemplate, type Template } from '../format/template';
import type { Band } from './layout';

export interface Theme {
  dark: boolean;
  paper: string;
  /** The default ink (`#000000`) as drawn: the `.i` fill in the page SVG's <style>. */
  ink: string;
  /** Template lines: the `.t` stroke in the page SVG's <style>. */
  line: string;
}

export const LIGHT: Theme = { dark: false, paper: '#ffffff', ink: '#1f1f1f', line: '#c9c9c9' };
export const DARK: Theme = { dark: true, paper: '#1e1e1e', ink: '#e6e3de', line: '#3c3c3c' };

/** Obsidian's theme (its own setting, which can differ from the system's). */
export function currentTheme(): Theme {
  return document.body.classList.contains('theme-dark') ? DARK : LIGHT;
}

/**
 * The theme a page's ink is drawn in. A pdf page's paper is the PDF's own (white), so its
 * default ink stays the light theme's near-black in dark mode too, as in its SVG file (#14).
 */
export function pageTheme(page: Pick<Page, 'template'> | null | undefined, theme: Theme): Theme {
  return page && fixedPaper(page.template) && theme.ink !== LIGHT.ink ? { ...theme, ink: LIGHT.ink } : theme; // pdf, fill (#27)
}

export const strokeColor = (s: Pick<Stroke, 'color'>, theme: Theme) => (s.color === DEFAULT_INK ? theme.ink : s.color);

/** Matches the highlight layer's `opacity="0.4"` in the page SVG. */
export const HIGHLIGHT_ALPHA = 0.4;

/** iOS refuses canvases over 16,777,216 pixels; stay under it by lowering the resolution. */
export const MAX_CANVAS_PIXELS = 16_000_000;

/** Device pixels per CSS px for a canvas of this CSS size. */
export function pixelRatio(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1): number {
  const area = cssWidth * cssHeight;
  return area * dpr * dpr > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / area) : dpr;
}

// Outlines are computed once per stroke object and kept while it lives; the `d` they're made
// from is cached by strokePathCached, which writePage shares.
const outlines = new WeakMap<Stroke, Path2D>();

export function strokePath2D(stroke: Stroke): Path2D {
  let p = outlines.get(stroke);
  if (!p) {
    p = new Path2D(strokePathCached(stroke));
    outlines.set(stroke, p);
    // And its points as the file stores them, so the next save only encodes new strokes (#37).
    prepareSave(stroke);
  }
  return p;
}

// A stroke's bounds in page px (its points grown by its size, which covers the widest nib), kept
// per stroke object like its outline: a band bitmap (#52) skips strokes outside its band.
const bounds = new WeakMap<Stroke, [number, number, number, number]>();

export function strokeBounds(stroke: Stroke): [number, number, number, number] {
  let b = bounds.get(stroke);
  if (!b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { x, y } of stroke.points) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const m = stroke.size + 1;
    b = [x0 - m, y0 - m, x1 + m, y1 + m];
    bounds.set(stroke, b);
  }
  return b;
}

/**
 * Computes the outlines of a page's strokes not yet computed, until `deadline`
 * (performance.now() ms). Returns whether they are all done. Computing the outlines is most of
 * the cost of drawing a page for the first time (about 45 ms for 300 strokes in Chromium on a
 * desktop), so the view spreads it over frames ahead of drawing a page near the viewport (#9).
 */
export function warmOutlines(page: Page, deadline: number): boolean {
  for (const s of page.strokes) {
    if (outlines.has(s)) continue;
    if (performance.now() >= deadline) return false;
    strokePath2D(s);
  }
  return true;
}

/**
 * Template layers rasterised through an <img> of an SVG built from renderTemplate, so a new
 * template kind only needs template.ts. The SVG sets the `.t` line colour of Obsidian's theme
 * explicitly: inside an <img>, the page file's prefers-color-scheme follows the OS instead.
 * Drawn at the bitmap's device resolution, so lines stay crisp. Cached per template, pixel size
 * and theme.
 */
export class TemplateImages {
  private cache = new Map<string, { img: HTMLImageElement; ready: boolean; waiting: (() => void)[] }>();
  private pdf = new PdfImages();

  /**
   * The image to draw, or null if the template draws nothing or isn't loaded yet (then
   * `onReady` is called once it is).
   */
  get(template: Template, size: Size, width: number, height: number, theme: Theme, onReady: () => void): HTMLImageElement | null {
    if (template.kind === 'pdf') return this.pdf.get(template, size, width, height, onReady);
    if (template.kind === 'image') return template.image ? objectImages.get(template.image, onReady) : null; // #12: the image itself
    const items = renderTemplate(template, size);
    if (!items.length) return null;
    const key = `${JSON.stringify(template)} ${size.width}x${size.height} ${width}x${height} ${theme.line}`;
    let entry = this.cache.get(key);
    if (!entry) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.width} ${size.height}" width="${width}" height="${height}">` +
        `<style>.t{stroke:${theme.line}}</style>${items.join('')}</svg>`;
      const img = new Image();
      const e = { img, ready: false, waiting: [] as (() => void)[] };
      img.onload = () => {
        e.ready = true;
        e.waiting.splice(0).forEach(f => f());
      };
      img.onerror = () => {
        console.error('[notebook] template image failed to load', key);
        e.waiting.length = 0;
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      this.cache.set(key, e);
      entry = e;
    }
    if (entry.ready) return entry.img;
    entry.waiting.push(onReady);
    return null;
  }

  /** Template images of bands of pages (#52), least recently used first out. */
  private bands = new Map<string, BandImage>();
  static MAX_BANDS = 4;

  /**
   * The template layer for `bitmap`: what renderBase draws, null when there's nothing to draw,
   * or 'loading' (then `onReady` is called once it's ready). For a whole-page bitmap this is
   * get(). For a band bitmap (#52), lines, grids and dots are rasterised for the band alone (an
   * SVG whose viewBox is the band, at the band's pixel size); a pdf page (its sharp render at no
   * more than MAX_CANVAS_PIXELS for the whole page, as a whole-page bitmap would get) and an
   * image page are drawn over the whole page in page px, the band clipping them.
   */
  layer(template: Template, size: Size, bitmap: PageBitmap, theme: Theme, onReady: () => void): TemplateSource | null | 'loading' {
    const { canvas, band } = bitmap;
    if (!band) return this.get(template, size, canvas.width, canvas.height, theme, onReady) ?? (this.pending(template, size, canvas.width, canvas.height, theme) ? 'loading' : null);
    if (template.kind === 'pdf' || template.kind === 'image') {
      const r = pixelRatio(bitmap.cssWidth, bitmap.cssHeight);
      const w = Math.max(1, Math.round(bitmap.cssWidth * r)), h = Math.max(1, Math.round(bitmap.cssHeight * r));
      const img = this.get(template, size, w, h, theme, onReady);
      return img ? { page: img } : null;
    }
    const items = renderTemplate(template, size);
    if (!items.length) return null;
    // The band in page px.
    const kx = size.width / bitmap.cssWidth, ky = size.height / bitmap.cssHeight;
    const vb = [band.x * kx, band.y * ky, band.width * kx, band.height * ky].map(v => Math.round(v * 1000) / 1000);
    const key = `${JSON.stringify(template)} ${size.width}x${size.height} ${vb.join(',')} ${canvas.width}x${canvas.height} ${theme.line}`;
    let e = touch(this.bands, key);
    if (!e) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${canvas.width}" height="${canvas.height}" preserveAspectRatio="none">` +
        `<style>.t{stroke:${theme.line}}</style>${items.join('')}</svg>`;
      const img = new Image();
      const entry: BandImage = e = { img, ready: false, failed: false, waiting: [] };
      img.onload = () => {
        entry.ready = true;
        entry.waiting.splice(0).forEach(f => f());
      };
      img.onerror = () => {
        console.error('[notebook] template image failed to load', key);
        entry.failed = true;
        entry.waiting.length = 0;
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      this.bands.set(key, entry);
      while (this.bands.size > TemplateImages.MAX_BANDS) {
        const [k, old] = this.bands.entries().next().value!;
        this.bands.delete(k);
        old.waiting.length = 0;
        releaseImage(old.img);
      }
    }
    if (e.ready) return e.img;
    if (e.failed) return null;
    e.waiting = [onReady]; // one redraw when it arrives, for the latest caller
    return 'loading';
  }

  /** Whether get() of these arguments is waiting for its image (a line template being decoded). */
  private pending(template: Template, size: Size, width: number, height: number, theme: Theme): boolean {
    if (template.kind === 'pdf' || template.kind === 'image') return false;
    const e = this.cache.get(`${JSON.stringify(template)} ${size.width}x${size.height} ${width}x${height} ${theme.line}`);
    return !!e && !e.ready && e.waiting.length > 0;
  }

  clear() {
    this.cache.clear();
    this.pdf.clear();
    for (const e of this.bands.values()) releaseImage(e.img);
    this.bands.clear();
  }
}

type BandImage = { img: HTMLImageElement; ready: boolean; failed: boolean; waiting: (() => void)[] };

/**
 * What renderBase draws as the template layer: an image covering the bitmap (the whole page, or
 * the band of a band bitmap), or `{ page }`, an image covering the whole page, drawn in page px.
 */
export type TemplateSource = CanvasImageSource | { page: CanvasImageSource };

// ---- PDF pages (#14)

/**
 * Renders a PDF page at a pixel size from the PDF itself, or resolves null. Set by the plugin
 * (see pdf.ts); without it, PDF pages show their embedded image.
 */
export type SharpPdfRenderer = (template: PdfTemplate, width: number, height: number) => Promise<HTMLImageElement | null>;
let sharpPdf: SharpPdfRenderer | null = null;
export function setSharpPdfRenderer(render: SharpPdfRenderer | null) {
  sharpPdf = render;
}

/** Counts for tests: sharp renders requested and received, and times a sharp image was drawn. */
export const pdfStats = { requested: 0, received: 0, sharpDrawn: 0, jpegDrawn: 0 };

/** The embedded image's resolution: 150 dpi over CSS px at 96 per inch. */
const JPEG_PX_PER_CSS_PX = 150 / 96;

type PdfEntry = { img: HTMLImageElement | null; ready: boolean; failed: boolean; waiting: (() => void)[] };

/** Frees an image's decoded pixels, and its blob URL if it has one. */
function releaseImage(img: HTMLImageElement) {
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.removeAttribute('src');
}

/**
 * The template layer of pdf pages. The page's embedded JPEG is drawn first (fast, always
 * there); a render from the PDF at the bitmap's pixel size is requested at the same time and,
 * when it arrives, the page is redrawn with it. If it fails, the JPEG stays. Both caches are
 * small and least recently used first out, since images of pages at 400% are large.
 */
class PdfImages {
  static MAX_JPEGS = 6;
  static MAX_SHARP = 4;
  private jpegs = new Map<string, PdfEntry>();
  private sharp = new Map<string, PdfEntry>();

  get(t: PdfTemplate, size: Size, width: number, height: number, onReady: () => void): HTMLImageElement | null {
    try {
      const sharpKey = `${t.source}#${t.page} ${width}x${height}`;
      let s = touch(this.sharp, sharpKey);
      // Only when the bitmap has more pixels than the embedded image (not for thumbnails).
      const finer = width > size.width * JPEG_PX_PER_CSS_PX * 1.05 || !t.image;
      if (!s && sharpPdf && finer) {
        const entry: PdfEntry = s = { img: null, ready: false, failed: false, waiting: [] };
        this.sharp.set(sharpKey, entry);
        this.trim(this.sharp, PdfImages.MAX_SHARP);
        pdfStats.requested++;
        sharpPdf(t, width, height).then(img => {
          if (!img) throw new Error('no render');
          if (this.sharp.get(sharpKey) !== entry) return releaseImage(img); // evicted meanwhile
          pdfStats.received++;
          entry.img = img;
          entry.ready = true;
          entry.waiting.splice(0).forEach(f => f());
        }).catch(() => {
          entry.failed = true;
          entry.waiting.length = 0;
        });
      }
      if (s?.ready) {
        pdfStats.sharpDrawn++;
        return s.img;
      }
      // Only the latest caller is told when the sharp image arrives: one redraw, not one per call.
      if (s && !s.failed) s.waiting = [onReady];
      if (!t.image) return null;
      const jpegKey = `${t.source}#${t.page} ${t.image.length} ${t.image.slice(-32)}`;
      let j = touch(this.jpegs, jpegKey);
      if (!j) {
        const img = new Image();
        const entry: PdfEntry = j = { img, ready: false, failed: false, waiting: [] };
        img.onload = () => {
          entry.ready = true;
          entry.waiting.splice(0).forEach(f => f());
        };
        img.onerror = () => {
          console.error('[notebook] PDF page image failed to load', jpegKey);
          entry.failed = true;
          entry.waiting.length = 0;
        };
        img.src = t.image;
        this.jpegs.set(jpegKey, entry);
        this.trim(this.jpegs, PdfImages.MAX_JPEGS);
      }
      if (j.ready) {
        pdfStats.jpegDrawn++;
        return j.img;
      }
      if (!j.failed) j.waiting = [onReady];
      return null;
    } catch (e) {
      console.error('[notebook] PDF page template', e);
      return null;
    }
  }

  private trim(cache: Map<string, PdfEntry>, max: number) {
    while (cache.size > max) {
      const [key, e] = cache.entries().next().value!;
      cache.delete(key);
      e.waiting.length = 0;
      if (e.img) releaseImage(e.img);
    }
  }

  clear() {
    this.trim(this.jpegs, 0);
    this.trim(this.sharp, 0);
  }
}

/** Whether two bands (or the whole page, null) are the same. */
export function sameBand(a: Band | null, b: Band | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** The entry for `key`, moved to the most recently used end, or undefined. */
function touch<V>(cache: Map<string, V>, key: string): V | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

// ---- images on pages (#12)

/**
 * Decoded images for the objects layer (and image pages), keyed by their data, least recently
 * used first out. Decoding happens off the pen's path: `get` returns null until the image is
 * ready and calls `onReady` then (the page is drawn with a placeholder meanwhile).
 */
export class ObjectImages {
  static MAX = 24;
  private cache = new Map<string, { img: HTMLImageElement; ready: boolean; failed: boolean; waiting: (() => void)[] }>();
  /** Images decoded, for tests. */
  decoded = 0;

  get(data: string, onReady?: () => void): HTMLImageElement | null {
    if (!data) return null;
    const key = `${data.length} ${data.slice(0, 40)} ${data.slice(-40)}`;
    let e = touch(this.cache, key);
    if (!e) {
      const img = new Image();
      const entry: { img: HTMLImageElement; ready: boolean; failed: boolean; waiting: (() => void)[] } = e = { img, ready: false, failed: false, waiting: [] };
      img.onload = () => {
        entry.ready = true;
        this.decoded++;
        entry.waiting.splice(0).forEach(f => f());
      };
      img.onerror = () => {
        console.error('[notebook] image failed to load');
        entry.failed = true;
        entry.waiting.length = 0;
      };
      img.decoding = 'async';
      img.src = data;
      this.cache.set(key, entry);
      while (this.cache.size > ObjectImages.MAX) {
        const [k, old] = this.cache.entries().next().value!;
        this.cache.delete(k);
        old.waiting.length = 0;
        releaseImage(old.img);
      }
    }
    if (e.ready) return e.img;
    if (onReady && !e.failed && !e.waiting.includes(onReady)) e.waiting.push(onReady);
    return null;
  }
}

/** The one cache of decoded page images. */
export const objectImages = new ObjectImages();

/** Draws page images (page px transform set) under `skip`: each decoded one, or a placeholder box. */
export function drawImages(ctx: CanvasRenderingContext2D, images: readonly PageImage[] | undefined, skip?: ReadonlySet<string> | null, onReady?: () => void) {
  if (!images) return;
  for (const im of images) {
    if (skip?.has(im.id)) continue;
    const img = objectImages.get(im.data, onReady);
    if (img) ctx.drawImage(img, im.x, im.y, im.width, im.height);
    else {
      ctx.fillStyle = 'rgba(128, 128, 128, 0.25)';
      ctx.fillRect(im.x, im.y, im.width, im.height);
    }
  }
}

/** The shared offscreen canvas for compositing highlighter strokes. */
let scratch: HTMLCanvasElement | null = null;

function scratchCanvas(width: number, height: number): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const ctx = scratch.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

/** Frees the highlighter canvas (when the last view closes). */
export function releaseScratch() {
  if (scratch) scratch.width = scratch.height = 0;
  scratch = null;
}

/**
 * One page's bitmap: a canvas the size of the page element at device resolution, or (#52) of a
 * band of it (`band`, CSS px of the page box), positioned over that part of the page.
 */
export class PageBitmap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** The part of the page drawn, CSS px of the page box; null: the whole page. */
  band: Band | null = null;

  constructor(readonly cssWidth: number, readonly cssHeight: number, band: Band | null = null) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'nb-ink-bitmap';
    this.ctx = this.canvas.getContext('2d')!;
    this.setBand(band);
  }

  /**
   * Makes the bitmap cover `band` (null: the whole page), sized at device resolution (lowered
   * only past MAX_CANVAS_PIXELS) and placed over it. Clears it, unless nothing changed.
   */
  setBand(band: Band | null) {
    const c = this.canvas, b = band ?? { x: 0, y: 0, width: this.cssWidth, height: this.cssHeight };
    const r = pixelRatio(b.width, b.height);
    const w = Math.max(1, Math.round(b.width * r)), h = Math.max(1, Math.round(b.height * r));
    const same = sameBand(this.band, band) && c.width === w && c.height === h;
    this.band = band;
    if (same) return;
    c.width = w;
    c.height = h;
    const s = c.style;
    c.classList.toggle('nb-ink-band', !!band);
    if (band) {
      s.left = `${band.x}px`;
      s.top = `${band.y}px`;
      s.width = `${band.width}px`;
      s.height = `${band.height}px`;
    } else s.left = s.top = s.width = s.height = '';
  }

  /** Device pixels of the bitmap. */
  get pixels(): number {
    return this.canvas.width * this.canvas.height;
  }

  /** Whether a stroke can show on the bitmap: always for a whole page; for a band, if its bounds meet it. */
  private shows(s: Stroke, size: Size): boolean {
    const b = this.band;
    if (!b) return true;
    const kx = size.width / this.cssWidth, ky = size.height / this.cssHeight, [x0, y0, x1, y1] = strokeBounds(s);
    return x1 >= b.x * kx && x0 <= (b.x + b.width) * kx && y1 >= b.y * ky && y0 <= (b.y + b.height) * ky;
  }

  private pageTransform(ctx: CanvasRenderingContext2D, size: Size) {
    const c = this.canvas, b = this.band;
    if (!b) {
      ctx.setTransform(c.width / size.width, 0, 0, c.height / size.height, 0, 0);
      return;
    }
    // Device px per CSS px of the band, times CSS px per page px; the band's corner at the origin.
    const dx = c.width / b.width, dy = c.height / b.height;
    ctx.setTransform(dx * this.cssWidth / size.width, 0, 0, dy * this.cssHeight / size.height, -b.x * dx, -b.y * dy);
  }

  /**
   * Draws the whole page. `template` is the rasterised template layer, if any. Strokes whose id
   * is in `skip` are left out (the lasso's selection while it's dragged, #11).
   */
  render(page: Page, theme: Theme, template: TemplateSource | null, skip?: ReadonlySet<string> | null, onImage?: () => void) {
    this.renderBase(page, theme, template, skip, onImage);
    this.renderPen(page, theme, 0, Infinity, skip);
  }

  /**
   * Draws the page without its pen strokes: paper, template and highlighter layer. With
   * renderPen, a page can be drawn over several frames (#9), each rasterising only part of it.
   */
  renderBase(page: Page, theme: Theme, template: TemplateSource | null, skip?: ReadonlySet<string> | null, onImage?: () => void) {
    theme = pageTheme(page, theme);
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.paper;
    ctx.fillRect(0, 0, w, h);
    if (template && 'page' in template) {
      // A whole-page image over a band bitmap (#52): in page px, clipped to the band.
      this.pageTransform(ctx, page.size);
      ctx.drawImage(template.page, 0, 0, page.size.width, page.size.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else if (template) ctx.drawImage(template, 0, 0, w, h);
    if (page.images?.length) {
      // The objects layer (#12); `onImage` redraws once an image not yet decoded is.
      this.pageTransform(ctx, page.size);
      drawImages(ctx, page.images, skip, onImage);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // Highlighters at full opacity on their own canvas, then composited once at 40%, so
    // crossing highlighter strokes don't darken (as in the SVG).
    const highlights = page.strokes.filter(s => s.tool === 'highlighter' && !skip?.has(s.id) && this.shows(s, page.size));
    if (highlights.length) {
      const hctx = scratchCanvas(w, h);
      this.pageTransform(hctx, page.size);
      for (const s of highlights) {
        hctx.fillStyle = strokeColor(s, theme);
        hctx.fill(strokePath2D(s));
      }
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.drawImage(scratch!, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Draws up to `count` pen strokes, in order, from stroke index `from`, over what's drawn.
   * Returns the index to continue from (the number of strokes once all are drawn). A band
   * bitmap skips (and doesn't count) strokes outside its band.
   */
  renderPen(page: Page, theme: Theme, from: number, count: number, skip?: ReadonlySet<string> | null): number {
    theme = pageTheme(page, theme);
    this.pageTransform(this.ctx, page.size);
    const strokes = page.strokes;
    let i = from;
    for (let n = 0; i < strokes.length && n < count; i++) {
      if (strokes[i].tool !== 'pen' || skip?.has(strokes[i].id) || !this.shows(strokes[i], page.size)) continue;
      this.fill(strokes[i], theme);
      n++;
    }
    return i;
  }

  /**
   * Draws a stroke just appended to the page. A pen stroke goes on top of the bitmap; a
   * highlighter stroke belongs under the pen strokes, so it redraws the page.
   */
  addStroke(page: Page, stroke: Stroke, theme: Theme, template: TemplateSource | null) {
    if (stroke.tool === 'highlighter') {
      this.render(page, theme, template);
      return;
    }
    this.pageTransform(this.ctx, page.size);
    this.fill(stroke, pageTheme(page, theme));
  }

  private fill(s: Stroke, theme: Theme) {
    this.ctx.fillStyle = strokeColor(s, theme);
    this.ctx.fill(strokePath2D(s));
  }

  /** Frees the bitmap's memory now (iOS keeps it until the canvas is shrunk). */
  release() {
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
  }
}

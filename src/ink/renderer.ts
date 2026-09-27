// Page bitmaps. Each page near the viewport gets a canvas at device resolution holding its
// finished strokes: paper colour, the template layer, highlighter strokes composited at 40%,
// then pen strokes, the same layers and colours as the page's SVG. A new stroke is drawn onto
// the existing bitmap; the whole page is redrawn only on load, resize, theme change or when
// strokes are removed.
import { DEFAULT_INK, type Page, type Size, type Stroke } from '../format/page';
import { strokePath } from '../format/outline';
import { renderTemplate, type PdfTemplate, type Template } from '../format/template';

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
  return page?.template.kind === 'pdf' && theme.ink !== LIGHT.ink ? { ...theme, ink: LIGHT.ink } : theme;
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

// Outlines are computed once per stroke object and kept while it lives.
const outlines = new WeakMap<Stroke, Path2D>();

export function strokePath2D(stroke: Stroke): Path2D {
  let p = outlines.get(stroke);
  if (!p) {
    p = new Path2D(strokePath(stroke));
    outlines.set(stroke, p);
  }
  return p;
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

  clear() {
    this.cache.clear();
    this.pdf.clear();
  }
}

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

/** The entry for `key`, moved to the most recently used end, or undefined. */
function touch<V>(cache: Map<string, V>, key: string): V | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
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

/** One page's bitmap: a canvas the size of the page element at device resolution. */
export class PageBitmap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(readonly cssWidth: number, readonly cssHeight: number) {
    const r = pixelRatio(cssWidth, cssHeight);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'nb-ink-bitmap';
    this.canvas.width = Math.max(1, Math.round(cssWidth * r));
    this.canvas.height = Math.max(1, Math.round(cssHeight * r));
    this.ctx = this.canvas.getContext('2d')!;
  }

  private pageTransform(ctx: CanvasRenderingContext2D, size: Size) {
    ctx.setTransform(this.canvas.width / size.width, 0, 0, this.canvas.height / size.height, 0, 0);
  }

  /** Draws the whole page. `template` is the rasterised template layer, if any. */
  render(page: Page, theme: Theme, template: CanvasImageSource | null) {
    this.renderBase(page, theme, template);
    this.renderPen(page, theme, 0, Infinity);
  }

  /**
   * Draws the page without its pen strokes: paper, template and highlighter layer. With
   * renderPen, a page can be drawn over several frames (#9), each rasterising only part of it.
   */
  renderBase(page: Page, theme: Theme, template: CanvasImageSource | null) {
    theme = pageTheme(page, theme);
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.paper;
    ctx.fillRect(0, 0, w, h);
    if (template) ctx.drawImage(template, 0, 0, w, h);
    // Highlighters at full opacity on their own canvas, then composited once at 40%, so
    // crossing highlighter strokes don't darken (as in the SVG).
    const highlights = page.strokes.filter(s => s.tool === 'highlighter');
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
   * Returns the index to continue from (the number of strokes once all are drawn).
   */
  renderPen(page: Page, theme: Theme, from: number, count: number): number {
    theme = pageTheme(page, theme);
    this.pageTransform(this.ctx, page.size);
    const strokes = page.strokes;
    let i = from;
    for (let n = 0; i < strokes.length && n < count; i++) {
      if (strokes[i].tool !== 'pen') continue;
      this.fill(strokes[i], theme);
      n++;
    }
    return i;
  }

  /**
   * Draws a stroke just appended to the page. A pen stroke goes on top of the bitmap; a
   * highlighter stroke belongs under the pen strokes, so it redraws the page.
   */
  addStroke(page: Page, stroke: Stroke, theme: Theme, template: CanvasImageSource | null) {
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

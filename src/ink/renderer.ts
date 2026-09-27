// Page bitmaps. Each page near the viewport gets a canvas at device resolution holding its
// finished strokes: paper colour, the template layer, highlighter strokes composited at 40%,
// then pen strokes, the same layers and colours as the page's SVG. A new stroke is drawn onto
// the existing bitmap; the whole page is redrawn only on load, resize, theme change or when
// strokes are removed.
import { DEFAULT_INK, type Page, type Size, type Stroke } from '../format/page';
import { strokePath } from '../format/outline';
import { renderTemplate, type Template } from '../format/template';

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
 * Template layers rasterised through an <img> of an SVG built from renderTemplate, so a new
 * template kind only needs template.ts. Cached per template, pixel size and theme.
 */
export class TemplateImages {
  private cache = new Map<string, { img: HTMLImageElement; ready: boolean; waiting: (() => void)[] }>();

  /**
   * The image to draw, or null if the template draws nothing or isn't loaded yet (then
   * `onReady` is called once it is).
   */
  get(template: Template, size: Size, width: number, height: number, theme: Theme, onReady: () => void): HTMLImageElement | null {
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
    this.pageTransform(ctx, page.size);
    for (const s of page.strokes) if (s.tool === 'pen') this.fill(s, theme);
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
    this.fill(stroke, theme);
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

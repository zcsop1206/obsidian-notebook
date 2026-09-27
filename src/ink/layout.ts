// Where each page sits in the ink view: pages stacked vertically with a gap, centred, all at
// one scale. At zoom 1 (100%) that scale fits the widest page to the view width; zoom (#9,
// 0.5 to 4) multiplies it. Margins and gaps stay the same in CSS px at every zoom. Above 100%
// the pages are wider than the view and the pages layer is as wide as they are (plus margins),
// so the view scrolls sideways too; below it, pages stay centred in the view's width. Pure, so
// it's unit-tested; the view positions page elements absolutely from these numbers, so the
// scroll size is right before any page has a bitmap.
import type { Size } from '../format/page';

export const MARGIN = 16;
export const GAP = 24;
/** Room below the last page for the "Add page" control. */
export const FOOTER = 72;

export interface PageBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Layout {
  /** CSS px per page px (the fitted scale times the zoom). */
  scale: number;
  /** The zoom this layout was made at (1 = fitted to the view width). */
  zoom: number;
  /** Width of the pages layer: the view width, or the pages plus margins if wider. */
  width: number;
  pages: PageBox[];
  /** The virtual blank page below the last page (#28), when laid out with `extra`; else null. */
  ghost: PageBox | null;
  /** Top of the "Add page" control. */
  footerTop: number;
  /** Total scroll height. */
  height: number;
}

/**
 * Lays out pages for a view `viewWidth` CSS px wide at `zoom` (1 fits the widest page to the
 * width). Pages with no size use `fallback`. With `extra`, one more page of that size (the
 * virtual blank page, #28) goes after the last one, counted in the widest page so that it
 * becoming a real page (and another appearing below) moves nothing; the footer goes below it.
 */
export function layoutPages(sizes: readonly Size[], viewWidth: number, fallback: Size, zoom = 1, extra?: Size | null): Layout {
  const all = extra ? [...sizes, extra] : sizes;
  const widest = all.reduce((w, s) => Math.max(w, s.width), 0) || fallback.width;
  const scale = Math.max(0.05, (viewWidth - 2 * MARGIN) / widest) * zoom;
  const width = Math.max(viewWidth, Math.round(widest * scale) + 2 * MARGIN);
  let top = MARGIN;
  const boxes = all.map(s => {
    const w = Math.round(s.width * scale), height = Math.round(s.height * scale);
    const box = { top, left: Math.max(0, Math.round((width - w) / 2)), width: w, height };
    top += height + GAP;
    return box;
  });
  const pages = boxes.slice(0, sizes.length);
  const ghost = extra ? boxes[sizes.length] : null;
  return { scale, zoom, width, pages, ghost, footerTop: top, height: top + FOOTER };
}

/** Indexes of the pages overlapping the band [start, end) of the scroll area, in order. */
export function pagesInBand(layout: Layout, start: number, end: number): number[] {
  const out: number[] = [];
  layout.pages.forEach((p, i) => {
    if (p.top < end && p.top + p.height > start) out.push(i);
  });
  return out;
}

/** The page whose box contains y, or the nearest one above it; -1 if there are no pages. */
export function pageAtY(layout: Layout, y: number): number {
  let found = layout.pages.length ? 0 : -1;
  layout.pages.forEach((p, i) => {
    if (p.top <= y) found = i;
  });
  return found;
}

/**
 * The page taking up most of the band [start, end) (the viewport): the current page. The
 * first of equals wins; -1 if no page overlaps the band.
 */
export function mostVisiblePage(layout: Layout, start: number, end: number): number {
  let best = -1, most = 0;
  layout.pages.forEach((p, i) => {
    const seen = Math.min(end, p.top + p.height) - Math.max(start, p.top);
    if (seen > most) {
      most = seen;
      best = i;
    }
  });
  return best;
}

// ---- the virtual page (#28)

/** Whether a gesture of this tool on the virtual page makes it a real page: only tools that ink. */
export function inksGhost(tool: string): boolean {
  return tool === 'pen' || tool === 'highlighter';
}

/**
 * The pages to drop when a note closes (#28): the trailing run of pages that were made from the
 * virtual page (`fromGhost`) and still have no strokes (`strokes` 0), last first. A page added
 * explicitly, one with ink, or one that can't be read (`strokes` null) ends the run, so nothing
 * above it is dropped.
 */
export function emptyGhostPages(pages: readonly { id: string; strokes: number | null }[], fromGhost: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i];
    if (!fromGhost.has(p.id) || p.strokes !== 0) break;
    out.push(p.id);
  }
  return out;
}

// ---- viewport bitmaps (#52)

/** A rectangle in CSS px of a page's box (x, y from its top-left). */
export interface Band {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The part of a page (`width` × `height` CSS px) its bitmap covers, given the part of the page
 * box the viewport shows (`view`, in the page box's CSS px; it may reach past the page or miss
 * it). Null when the whole page fits in `maxPixels` at `dpr` device px per CSS px: the bitmap is
 * the whole page, as before #52. Otherwise the viewport plus up to half a viewport on each side,
 * shrunk until it fits at full `dpr` (down to the viewport alone), centred on the viewport and
 * slid into the page, in whole CSS px. A page off screen gets the part of it nearest the
 * viewport. If even the viewport alone doesn't fit, the band is the viewport and the caller
 * draws it at a lower resolution (pixelRatio).
 */
export function bitmapBand(width: number, height: number, view: Band, dpr: number, maxPixels: number): Band | null {
  const d2 = dpr * dpr;
  if (width * height * d2 <= maxPixels) return null;
  const vw = Math.min(width, Math.ceil(view.width)), vh = Math.min(height, Math.ceil(view.height));
  let bw = vw, bh = vh;
  for (let t = 1; t >= 0; t -= 0.125) {
    bw = Math.min(width, Math.ceil(vw + t * view.width));
    bh = Math.min(height, Math.ceil(vh + t * view.height));
    if (bw * bh * d2 <= maxPixels) break;
  }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x = clamp(Math.round(view.x + view.width / 2 - bw / 2), 0, width - bw);
  const y = clamp(Math.round(view.y + view.height / 2 - bh / 2), 0, height - bh);
  return { x, y, width: bw, height: bh };
}

/**
 * Whether a page bitmap covering `band` should be redrawn over another part of the page as the
 * viewport shows `view` of it (page `width` × `height` CSS px): 'now' when part of what's visible
 * isn't covered; 'soon' (once scrolling has settled) when less than half of `band`'s margin is
 * left beyond the visible part on a side where the page goes on; else 'ok'. A page not in view
 * is 'ok' whatever its band covers.
 */
export function bandNeed(band: Band, view: Band, width: number, height: number): 'ok' | 'soon' | 'now' {
  // The visible part of the page.
  const x0 = Math.max(0, view.x), y0 = Math.max(0, view.y);
  const x1 = Math.min(width, view.x + view.width), y1 = Math.min(height, view.y + view.height);
  if (x1 <= x0 || y1 <= y0) return 'ok';
  if (x0 < band.x || y0 < band.y || x1 > band.x + band.width || y1 > band.y + band.height) return 'now';
  // The room left beyond it on each side the band could move to, over the band's margin there.
  const mx = (band.width - Math.min(width, view.width)) / 2, my = (band.height - Math.min(height, view.height)) / 2;
  const room = (left: number, margin: number) => (margin > 0 ? left / margin : Infinity);
  const least = Math.min(
    band.x > 0 ? room(x0 - band.x, mx) : Infinity,
    band.x + band.width < width ? room(band.x + band.width - x1, mx) : Infinity,
    band.y > 0 ? room(y0 - band.y, my) : Infinity,
    band.y + band.height < height ? room(band.y + band.height - y1, my) : Infinity);
  return least < 0.5 ? 'soon' : 'ok';
}

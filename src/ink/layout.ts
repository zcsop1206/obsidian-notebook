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
  /** Top of the "Add page" control. */
  footerTop: number;
  /** Total scroll height. */
  height: number;
}

/**
 * Lays out pages for a view `viewWidth` CSS px wide at `zoom` (1 fits the widest page to the
 * width). Pages with no size use `fallback`.
 */
export function layoutPages(sizes: readonly Size[], viewWidth: number, fallback: Size, zoom = 1): Layout {
  const widest = sizes.reduce((w, s) => Math.max(w, s.width), 0) || fallback.width;
  const scale = Math.max(0.05, (viewWidth - 2 * MARGIN) / widest) * zoom;
  const width = Math.max(viewWidth, Math.round(widest * scale) + 2 * MARGIN);
  let top = MARGIN;
  const pages = sizes.map(s => {
    const w = Math.round(s.width * scale), height = Math.round(s.height * scale);
    const box = { top, left: Math.max(0, Math.round((width - w) / 2)), width: w, height };
    top += height + GAP;
    return box;
  });
  return { scale, zoom, width, pages, footerTop: top, height: top + FOOTER };
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

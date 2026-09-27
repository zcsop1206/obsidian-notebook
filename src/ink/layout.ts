// Where each page sits in the ink view: pages stacked vertically with a gap, centred, all at
// one scale that fits the widest page to the view width. Pure, so it's unit-tested; the view
// positions page elements absolutely from these numbers, so the scroll height is right before
// any page has a bitmap.
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
  /** CSS px per page px. */
  scale: number;
  pages: PageBox[];
  /** Top of the "Add page" control. */
  footerTop: number;
  /** Total scroll height. */
  height: number;
}

/** Lays out pages for a view `viewWidth` CSS px wide. Pages with no size use `fallback`. */
export function layoutPages(sizes: readonly Size[], viewWidth: number, fallback: Size): Layout {
  const widest = sizes.reduce((w, s) => Math.max(w, s.width), 0) || fallback.width;
  const scale = Math.max(0.05, (viewWidth - 2 * MARGIN) / widest);
  let top = MARGIN;
  const pages = sizes.map(s => {
    const width = Math.round(s.width * scale), height = Math.round(s.height * scale);
    const box = { top, left: Math.max(0, Math.round((viewWidth - width) / 2)), width, height };
    top += height + GAP;
    return box;
  });
  return { scale, pages, footerTop: top, height: top + FOOTER };
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

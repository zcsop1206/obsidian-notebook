/**
 * The seams between the study view (S3), ink (S4), marks (S5) and the blocks (S6, S7, S9), so
 * each ticket can be built against the others before they exist. Change only through the board.
 */
import type { StudyContext } from '../context';
import type { Passage, StudyDoc } from '../types';

/* ------------------------------- ink (implemented by S4) ------------------------------- */

export interface InkStroke {
  id: string;
  /** [x, y, pressure, t] in paper px; t in ms since t0. */
  p: [number, number, number, number][];
  t0: number;
  at?: { a: string; dy: number; rev: string; v: number };
  /** Fog reveals when written (provenance colour). */
  e?: number;
  /** A block's own canvas key, or null for the doc's page ink. */
  blk?: string | null;
  dev?: string;
}

export interface InkSurfaceOptions {
  /** Paper height in px, or a function read on layout. Default 320. */
  height?: number | (() => number);
  /** Colour per stroke: a CSS colour or `--token`. */
  color?: (s: InkStroke) => string;
  /** Fields merged into a new stroke at pen-down (e.g. `{e: reveals}`). */
  meta?: () => Partial<InkStroke>;
  readOnly?: boolean | (() => boolean);
}

/** A canvas inside a block (attempt boxes, call bands, drill pages, kata sketches). */
export interface InkSurface {
  el: HTMLElement;
  strokes(): InkStroke[];
  count(): number;
  onChange(fn: (strokes: InkStroke[]) => void): () => void;
  setReadOnly(on: boolean): void;
  undo(): InkStroke | null;
  clear(): void;
  layout(): void;
  destroy(): void;
}

/** The doc's page ink, over the passages. */
export interface PageInk {
  /** Re-place strokes after layout changes (fonts, math, blocks opening). */
  relayout(): void;
  /** After a new build: follow, dim or orphan strokes; returns the counts for the toast. */
  reanchor(): { moved: number; changed: number; orphaned: number };
  undo(): InkStroke | null;
  destroy(): void;
}

export interface InkApi {
  /** Page ink for a rendered doc. `stack` holds the passages at paper scale. */
  page(doc: StudyDoc, stack: HTMLElement, passageTop: (anchor: string) => number | null): PageInk;
  /** A block's canvas; strokes persist in the doc's ink file under `key`. */
  surface(doc: StudyDoc, container: HTMLElement, key: string, opts?: InkSurfaceOptions): InkSurface;
}

/* ------------------------------- blocks (S6, S7, S9) ------------------------------- */

export interface BlockEnv {
  ctx: StudyContext;
  doc: StudyDoc;
  passage: Passage;
  ink: InkApi;
  open(docId: string, anchor?: string): void;
  peek(docId: string, anchor: string | null, near: HTMLElement): void;
  /** Call after the block changes height. */
  relayout(): void;
  toast(message: string, ms?: number): void;
  /** Render markdown (math, links) the way the view renders passages. */
  render(markdown: string, into: HTMLElement): Promise<void>;
}

export interface BlockHandle {
  destroy(): void;
}

export type BlockMount = (el: HTMLElement, env: BlockEnv) => BlockHandle;

/* ------------------------------- marks (S5) ------------------------------- */

export interface MarksHost {
  ctx: StudyContext;
  doc(): StudyDoc;
  /** The rendered element of a passage or anchored list item. */
  passageEl(anchor: string): HTMLElement | null;
  /** The right margin column, in paper px, where dots go. */
  margin: HTMLElement;
  ink: InkApi;
  open(docId: string, anchor?: string): void;
  toast(message: string, ms?: number): void;
  relayout(): void;
  /** Re-render the doc (after a build changes). */
  rerender(): void;
}

export interface Marks {
  /** Re-place the dots after layout changes. */
  refresh(): void;
  destroy(): void;
}

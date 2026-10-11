// PDF rendering (#14) with the pdf.js Obsidian ships (`loadPdfJs`), loaded lazily on first use.
// Used by the import (page sizes and the ~150 dpi JPEG each page file embeds) and by the ink
// view, which draws a pdf page's template from the PDF itself at the bitmap's resolution so
// text stays sharp when zoomed (the embedded JPEG is drawn until that render arrives).
//
// #68: the view's sharp renders stay off the pen's hot path. A render is drawn in tiles of at
// most TILE × TILE device px, one pdf.js render per tile with a frame between tiles, assembled
// into the page image, so no single main-thread render runs much longer than a frame; the
// RenderTask of the tile in progress is kept and cancelled (where pdf.js offers `cancel`) when a
// pen or mouse goes down, and that tile is rendered again at the next idle. A finished render is
// handed over only once the pen has been up IDLE_MS, so the page isn't redrawn mid-stroke.
//
// Only the small part of the pdf.js API used here is typed; the tests' mock implements it.
import { loadPdfJs, normalizePath, type Vault } from 'obsidian';
import type { PdfTemplate } from '../format/template';
import { MAX_CANVAS_PIXELS, pdfStats } from './renderer';
import { tiles as pdfTiles } from './dirty';

export interface PdfViewport { width: number; height: number }
/** What page.render returns: pdf.js's RenderTask. `cancel` is feature-detected (#68). */
export interface PdfRenderTask { promise: Promise<unknown>; cancel?(): void }
export interface PdfPageProxy {
  getViewport(o: { scale: number }): PdfViewport;
  /** `transform` is applied before the viewport's (pdf.js's RenderParameters.transform). */
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; transform?: number[] }): PdfRenderTask;
  cleanup?(): void;
}
export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  destroy?(): unknown;
}
interface PdfJs {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

let lib: Promise<PdfJs> | null = null;

/** The pdf.js module, loaded once. Rejects if Obsidian can't load it (then the next call retries). */
export function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = Promise.resolve().then(() => loadPdfJs()).then(m => {
      if (!m || typeof m.getDocument !== 'function') throw new Error('pdf.js is not available');
      return m as PdfJs;
    });
    lib.catch(() => { lib = null; });
  }
  return lib;
}

/** Opens a PDF. The bytes are copied, since pdf.js may transfer (detach) its buffer to its worker. */
export async function openPdf(bytes: ArrayBuffer): Promise<PdfDocument> {
  const m = await pdfjs();
  return m.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
}

/**
 * Renders a page onto a new canvas at `scale` (device px per PDF point), on white. The canvas
 * is kept under `maxPixels` by lowering the scale. The caller frees it (width = 0).
 */
export async function renderPdfPage(page: PdfPageProxy, scale: number, maxPixels = MAX_CANVAS_PIXELS): Promise<HTMLCanvasElement> {
  const one = page.getViewport({ scale: 1 });
  const area = one.width * one.height * scale * scale;
  if (area > maxPixels) scale *= Math.sqrt(maxPixels / area);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** Joins a page folder ('' for the root) and a pdf template's source. */
export const pdfPath = (pageFolder: string, source: string) =>
  normalizePath(pageFolder && pageFolder !== '/' ? `${pageFolder}/${source}` : source);

const freeCanvas = (c: HTMLCanvasElement) => { c.width = c.height = 0; };

/** An image of a canvas (PNG through a blob URL, so it's lossless); the canvas is freed. */
function canvasImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      freeCanvas(canvas);
      if (!blob) return reject(new Error('toBlob failed'));
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image failed')); };
      img.src = url;
    }, 'image/png');
  });
}

/** The note a pdf page belongs to: the index's vault path and its page folder's vault path. */
export interface PdfNote {
  path: string;
  pages: string;
}

/** Resolves at the next animation frame, or after 50 ms if frames don't come (a hidden page). */
const nextFrame = () => new Promise<void>(resolve => {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    resolve();
  };
  requestAnimationFrame(go);
  window.setTimeout(go, 50);
});

/**
 * Sharp renders of PDF pages for the ink view. Documents are opened from the vault on demand
 * and kept per vault path (at most MAX_DOCS). Renders run one at a time and wait while a pen
 * or mouse is down and for IDLE_MS after it lifts, so pdf.js's main-thread drawing stays off
 * the pen's hot path. `noteOf` finds the vault path of the note a template belongs to.
 *
 * #68: a render is drawn TILE px square at a time (see the header), each tile after waiting for
 * idle; a pen or mouse going down cancels the tile being rendered (the RenderTask's `cancel`, if
 * it has one) and it is rendered again at the next idle. The finished image is decoded, then
 * handed over at the next idle.
 */
export class PdfPages {
  static MAX_DOCS = 2;
  static IDLE_MS = 300;
  /** Tile size, device px (#68). */
  static TILE = 1024;
  /** Renders started (for tests). */
  renders = 0;
  private docs = new Map<string, Promise<PdfDocument | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private down = new Set<number>();
  private lastUp = 0;
  /** The tile render in progress, and whether a pen going down cancelled it (#68). */
  private task: PdfRenderTask | null = null;
  private cancelled = false;
  private onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    this.down.add(e.pointerId);
    const task = this.task;
    if (task && typeof task.cancel === 'function' && !this.cancelled) {
      this.cancelled = true;
      pdfStats.cancelled++;
      try {
        task.cancel();
      } catch (err) {
        // a task that has just finished may throw; its tile is then rendered again anyway
      }
    }
  };
  private onUp = (e: PointerEvent) => { if (this.down.delete(e.pointerId)) this.lastUp = performance.now(); };

  constructor(private vault: Vault, private noteOf: (template: PdfTemplate) => PdfNote | null) {
    window.addEventListener('pointerdown', this.onDown, { capture: true, passive: true });
    window.addEventListener('pointerup', this.onUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', this.onUp, { capture: true, passive: true });
  }

  /**
   * The page rendered at `width` × `height` device px, as an image, or null if it can't be
   * (no pdf.js, the note or the PDF not found, a render error). Never rejects.
   */
  render(template: PdfTemplate, width: number, height: number): Promise<HTMLImageElement | null> {
    const note = this.noteOf(template); // now, while the template is on its page
    const run = async (): Promise<HTMLImageElement | null> => {
      if (note == null) return null;
      await this.idle();
      const doc = await this.doc(this.resolve(note, template.source));
      if (!doc || template.page > doc.numPages) return null;
      this.renders++;
      const page = await doc.getPage(template.page);
      const canvas = await this.renderTiled(page, width);
      page.cleanup?.();
      const img = await canvasImage(canvas);
      // Decoded now, so the first drawImage of it doesn't decode a large PNG mid-stroke.
      if (typeof img.decode === 'function') await img.decode().catch(() => undefined);
      await this.idle(); // handed over, and so drawn, only once the pen has been up a moment (#68)
      return img;
    };
    const result = this.queue.then(run).catch(e => {
      console.warn('[notebook] PDF page render failed', template.source, template.page, e);
      return null;
    });
    this.queue = result;
    return result;
  }

  /**
   * Renders a page `width` device px wide (kept under MAX_CANVAS_PIXELS, as renderPdfPage does)
   * on white, one tile per idle slot (#68), and records the times in pdfStats.
   */
  private async renderTiled(page: PdfPageProxy, width: number): Promise<HTMLCanvasElement> {
    const one = page.getViewport({ scale: 1 });
    let scale = width / one.width;
    const area = one.width * one.height * scale * scale;
    if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tile = document.createElement('canvas');
    let busy = 0, longest = 0, tiles = 0;
    try {
      for (const [x, y, w, h] of pdfTiles(canvas.width, canvas.height, PdfPages.TILE)) {
        for (;;) {
          await this.idle();
          if (tile.width !== w || tile.height !== h) {
            tile.width = w;
            tile.height = h;
          }
          const tctx = tile.getContext('2d')!;
          tctx.setTransform(1, 0, 0, 1, 0, 0);
          tctx.fillStyle = '#ffffff';
          tctx.fillRect(0, 0, w, h);
          const t0 = performance.now();
          this.cancelled = false;
          const task = this.task = page.render({ canvasContext: tctx, viewport, transform: [1, 0, 0, 1, -x, -y] });
          try {
            await task.promise;
          } catch (e) {
            if (!this.cancelled) throw e;
          } finally {
            this.task = null;
            busy += performance.now() - t0;
          }
          if (this.cancelled) continue; // a pen went down: this tile again at the next idle
          longest = Math.max(longest, performance.now() - t0);
          tiles++;
          break;
        }
        ctx.drawImage(tile, 0, 0, w, h, x, y, w, h);
        await nextFrame();
      }
    } catch (e) {
      freeCanvas(canvas);
      throw e;
    } finally {
      freeCanvas(tile);
    }
    pdfStats.renderMs = busy;
    pdfStats.tiles = tiles;
    pdfStats.tileMaxMs = longest;
    return canvas;
  }

  /**
   * The PDF's vault path:`source` from the note's page folder, where the page files are. A
   * rename or move of the note (#26) moves the folder with the PDF in it, so this still holds.
   */
  resolve(note: PdfNote, source: string): string {
    return pdfPath(note.pages, source);
  }

  private async idle() {
    for (;;) {
      const wait = this.down.size ? PdfPages.IDLE_MS : this.lastUp + PdfPages.IDLE_MS - performance.now();
      if (wait <= 0) return;
      await new Promise(r => window.setTimeout(r, wait));
    }
  }

  private doc(path: string): Promise<PdfDocument | null> {
    let d = this.docs.get(path);
    if (d) {
      this.docs.delete(path); // most recently used last
      this.docs.set(path, d);
      return d;
    }
    const file = this.vault.getFileByPath(path);
    d = file ? this.vault.readBinary(file).then(openPdf).catch(e => {
      console.warn('[notebook] could not open PDF', path, e);
      return null;
    }) : Promise.resolve(null);
    this.docs.set(path, d);
    while (this.docs.size > PdfPages.MAX_DOCS) {
      const [oldest, old] = this.docs.entries().next().value!;
      this.docs.delete(oldest);
      void old.then(doc => doc?.destroy?.());
    }
    // A missing file isn't cached, so a PDF that arrives later (sync) is found.
    if (!file) this.docs.delete(path);
    return d;
  }

  /** Closes the documents and stops listening (plugin unload). */
  destroy() {
    for (const d of this.docs.values()) void d.then(doc => doc?.destroy?.());
    this.docs.clear();
    window.removeEventListener('pointerdown', this.onDown, { capture: true });
    window.removeEventListener('pointerup', this.onUp, { capture: true });
    window.removeEventListener('pointercancel', this.onUp, { capture: true });
  }
}

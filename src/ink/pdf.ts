// PDF rendering (#14) with the pdf.js Obsidian ships (`loadPdfJs`), loaded lazily on first use.
// Used by the import (page sizes and the ~150 dpi JPEG each page file embeds) and by the ink
// view, which draws a pdf page's template from the PDF itself at the bitmap's resolution so
// text stays sharp when zoomed (the embedded JPEG is drawn until that render arrives).
//
// Only the small part of the pdf.js API used here is typed; the tests' mock implements it.
import { loadPdfJs, normalizePath, type Vault } from 'obsidian';
import type { PdfTemplate } from '../format/template';
import { MAX_CANVAS_PIXELS } from './renderer';

export interface PdfViewport { width: number; height: number }
export interface PdfPageProxy {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<unknown> };
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

/** Joins a note's folder ('' for the root) and a pdf template's source. */
export const pdfPath = (noteFolder: string, source: string) =>
  normalizePath(noteFolder && noteFolder !== '/' ? `${noteFolder}/${source}` : source);

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

/**
 * Sharp renders of PDF pages for the ink view. Documents are opened from the vault on demand
 * and kept per vault path (at most MAX_DOCS). Renders run one at a time and wait while a pen
 * or mouse is down and for IDLE_MS after it lifts, so pdf.js's main-thread drawing stays off
 * the pen's hot path. `noteOf` finds the vault path of the note a template belongs to.
 */
export class PdfPages {
  static MAX_DOCS = 2;
  static IDLE_MS = 300;
  /** Renders started (for tests). */
  renders = 0;
  private docs = new Map<string, Promise<PdfDocument | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private down = new Set<number>();
  private lastUp = 0;
  private onDown = (e: PointerEvent) => { if (e.pointerType !== 'touch') this.down.add(e.pointerId); };
  private onUp = (e: PointerEvent) => { if (this.down.delete(e.pointerId)) this.lastUp = performance.now(); };

  constructor(private vault: Vault, private noteOf: (template: PdfTemplate) => string | null) {
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
      const folder = note.includes('/') ? note.slice(0, note.lastIndexOf('/')) : '';
      const doc = await this.doc(pdfPath(folder, template.source));
      if (!doc || template.page > doc.numPages) return null;
      this.renders++;
      const page = await doc.getPage(template.page);
      const one = page.getViewport({ scale: 1 });
      const canvas = await renderPdfPage(page, width / one.width);
      page.cleanup?.();
      return canvasImage(canvas);
    };
    const result = this.queue.then(run).catch(e => {
      console.warn('[notebook] PDF page render failed', template.source, template.page, e);
      return null;
    });
    this.queue = result;
    return result;
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

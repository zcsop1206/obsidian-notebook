// First-page thumbnails for the notebook library (#73). A thumbnail is the page drawn through
// PageBitmap at THUMB_WIDTH CSS px wide (device resolution), saved as a PNG under the plugin's
// data folder (`<plugin dir>/thumbs/`, outside the notes, so it never reaches the portfolio), named
// after the page file's path (a hash), its mtime and the theme: `<hash>-<mtime>-<l|d>.png`. A page
// saved again has a new mtime, so its old thumbnail is never used; drawing the new one deletes
// the page's older ones. Drawing goes one page at a time and waits while a pen (the Pencil) is
// down and IDLE_MS after it lifts, so it never competes with writing in an ink view.
import type { App } from 'obsidian';
import { readPage, type Size } from '../format/page';
import type { Template } from '../format/template';
import { fingerprint } from './store';
import { currentTheme, PageBitmap, TemplateImages, type TemplateSource, type Theme } from './renderer';

/** Thumbnail width in CSS px. */
export const THUMB_WIDTH = 160;
/** Wait after the pen lifts before drawing, in ms. */
export const IDLE_MS = 300;

/** Counters for tests. */
export interface ThumbStats {
  /** Thumbnails read from the cache. */
  cached: number;
  /** Thumbnails drawn (and saved). */
  drawn: number;
  /** Cache files deleted because their page changed. */
  dropped: number;
  /** Draws that waited for a pen to lift. */
  waited: number;
}

const sleep = (ms: number) => new Promise(r => window.setTimeout(r, ms));

export class ThumbCache {
  stats: ThumbStats = { cached: 0, drawn: 0, dropped: 0, waited: 0 };
  /** The cache's file names, once the folder has been listed. */
  private names: Set<string> | null = null;
  private listing: Promise<void> | null = null;
  private images = new TemplateImages();
  private queue: Promise<unknown> = Promise.resolve();
  private down = new Set<number>();
  private lastUp = 0;
  private onDown = (e: PointerEvent) => { if (e.pointerType === 'pen') this.down.add(e.pointerId); };
  private onUp = (e: PointerEvent) => { if (this.down.delete(e.pointerId)) this.lastUp = performance.now(); };

  constructor(private app: App, readonly dir: string) {
    window.addEventListener('pointerdown', this.onDown, { capture: true, passive: true });
    window.addEventListener('pointerup', this.onUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', this.onUp, { capture: true, passive: true });
  }

  destroy() {
    window.removeEventListener('pointerdown', this.onDown, { capture: true });
    window.removeEventListener('pointerup', this.onUp, { capture: true });
    window.removeEventListener('pointercancel', this.onUp, { capture: true });
    this.images.clear();
  }

  /** Resolves when the draws asked for so far are done (for tests). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined);
  }

  /** Whether a pen is down (or lifted less than IDLE_MS ago). */
  get penBusy(): boolean {
    return this.down.size > 0 || performance.now() - this.lastUp < IDLE_MS;
  }

  private hash = (pagePath: string) => fingerprint(pagePath).replace(':', '-');

  private file = (pagePath: string, mtime: number, theme: Theme) => `${this.hash(pagePath)}-${mtime}-${theme.dark ? 'd' : 'l'}.png`;

  private list(): Promise<void> {
    if (this.names) return Promise.resolve();
    this.listing ??= (async () => {
      const names = new Set<string>();
      try {
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(this.dir)) for (const p of (await adapter.list(this.dir)).files) names.add(p.slice(p.lastIndexOf('/') + 1));
      } catch (e) {
        console.warn('[notebook] thumbnails folder', e);
      }
      this.names = names;
    })();
    return this.listing;
  }

  /** The cached PNG of the page at this mtime in the current theme, or null. */
  async cached(pagePath: string, mtime: number): Promise<ArrayBuffer | null> {
    await this.list();
    const name = this.file(pagePath, mtime, currentTheme());
    if (!this.names!.has(name)) return null;
    try {
      const bytes = await this.app.vault.adapter.readBinary(`${this.dir}/${name}`);
      this.stats.cached++;
      return bytes;
    } catch (e) {
      return null;
    }
  }

  /**
   * Draws the page into a PNG and caches it (one at a time, never while a pen is down); null if
   * the page can't be read.
   */
  draw(pagePath: string, mtime: number): Promise<ArrayBuffer | null> {
    const run = async () => {
      if (this.penBusy) this.stats.waited++;
      while (this.penBusy) await sleep(IDLE_MS / 3);
      const theme = currentTheme();
      const bytes = await this.render(pagePath, theme);
      if (bytes) await this.save(pagePath, mtime, theme, bytes);
      return bytes;
    };
    const job = this.queue.then(run, run).catch(e => {
      console.warn('[notebook] thumbnail', pagePath, e);
      return null;
    });
    this.queue = job;
    return job;
  }

  private async render(pagePath: string, theme: Theme): Promise<ArrayBuffer | null> {
    const file = this.app.vault.getFileByPath(pagePath);
    if (!file) return null;
    const page = readPage(await this.app.vault.read(file));
    const h = Math.max(1, Math.round(THUMB_WIDTH * page.size.height / page.size.width));
    const bitmap = new PageBitmap(THUMB_WIDTH, h);
    const template = await this.template(page.template, page.size, bitmap, theme);
    let imageReady: () => void = () => {};
    const images = new Promise<void>(r => { imageReady = r; });
    let waiting = false;
    bitmap.render(page, theme, template, null, () => { waiting = true; imageReady(); });
    // An image on the page (#12) was still decoding: draw again once it has (or after a second).
    if (page.images?.length) {
      await Promise.race([images, sleep(1000)]);
      if (waiting) bitmap.render(page, theme, template);
    }
    const blob = await new Promise<Blob | null>(r => bitmap.canvas.toBlob(r, 'image/png'));
    bitmap.release();
    return blob ? await blob.arrayBuffer() : null;
  }

  /** The template layer, waiting (a little) for a template image to decode. */
  private async template(t: Template, size: Size, bitmap: PageBitmap, theme: Theme): Promise<TemplateSource | null> {
    for (let tries = 0; tries < 3; tries++) {
      let ready: () => void = () => {};
      const loaded = new Promise<void>(r => { ready = r; });
      const layer = this.images.layer(t, size, bitmap, theme, () => ready());
      // A pdf or image page's picture decodes asynchronously and reads as null meanwhile.
      const slow = layer === null && (t.kind === 'pdf' || t.kind === 'image');
      if (layer !== 'loading' && !slow) return layer;
      await Promise.race([loaded, sleep(1500)]);
    }
    const last = this.images.layer(t, size, bitmap, theme, () => {});
    return last === 'loading' ? null : last;
  }

  private async save(pagePath: string, mtime: number, theme: Theme, bytes: ArrayBuffer) {
    await this.list();
    const adapter = this.app.vault.adapter, name = this.file(pagePath, mtime, theme), names = this.names!;
    try {
      if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
      await adapter.writeBinary(`${this.dir}/${name}`, bytes);
      names.add(name);
      this.stats.drawn++;
      // The page's thumbnails of earlier versions (either theme), and of another version in this theme.
      const hash = this.hash(pagePath) + '-', th = theme.dark ? 'd' : 'l';
      for (const old of [...names]) {
        if (old === name || !old.startsWith(hash)) continue;
        const m = /-(\d+)-([ld])\.png$/.exec(old);
        if (!m || Number(m[1]) < mtime || m[2] === th) {
          names.delete(old);
          await adapter.remove(`${this.dir}/${old}`).catch(() => {});
          this.stats.dropped++;
        }
      }
    } catch (e) {
      console.warn('[notebook] thumbnail cache', e);
    }
  }
}

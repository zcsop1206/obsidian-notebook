// An open ink note's data: the index and its pages, read through a small file interface (the
// view adapts Obsidian's vault to it; unit tests use a map). Tracks what changed and saves it:
// each changed page is written SAVE_DELAY ms after the last change (at most MAX_SAVE_DELAY
// after the first), and at once on flush(). Writes to one file are serialized, pages before
// the index, and the text of our own writes is remembered so their modify events are ignored.
// Changes made on disk by others (a sync) reload the file unless it has unsaved changes here.
import { newPageId } from '../format/ids';
import { pagePath, readNote, writeNote, type NoteIndex } from '../format/note';
import { newPage, PAPER_SIZES, readPage, writePage, type Page, type Size, type Stroke } from '../format/page';
import { defaultTemplate, isTemplateKind, type Template } from '../format/template';

export const SAVE_DELAY = 2000;
export const MAX_SAVE_DELAY = 10000;

/** The file access the store needs. Paths are vault paths. */
export interface NoteFiles {
  /** The file's text, or null if there is no such file. */
  read(path: string): Promise<string | null>;
  /** Writes the file, creating it and its folder if needed. */
  write(path: string, text: string): Promise<void>;
  /** Names of the files directly in a folder ([] if it doesn't exist). */
  list(folder: string): string[];
}

export interface StoreListener {
  /** A page was reloaded from disk (or became unreadable or missing). */
  pageChanged(slot: PageSlot): void;
  /** The index was reloaded from disk: pages may have been added, removed or reordered. */
  indexChanged(): void;
  notice(message: string): void;
  /** A file write finished. */
  saved(path: string): void;
}

export interface PageSlot {
  id: string;
  path: string;
  /** Known before the page is parsed, so the view can lay it out. */
  size: Size;
  /** The page once parsed (see NoteStore.page). */
  page: Page | null;
  /** The file's text until the page is parsed; pages are parsed when first drawn or changed. */
  text: string | null;
  /** Why the page can't be shown (missing or unreadable file). Such a page is never written. */
  error: string | null;
}

export interface StoreOptions {
  delay?: number;
  maxDelay?: number;
  /** Page ids for new pages; defaults to random ones. */
  newId?: (taken: Set<string>) => string;
}

/** A page's size read from the start of its metadata without parsing the strokes. */
export function peekSize(svg: string): Size | null {
  const m = /"size":\{"width":(\d+(?:\.\d+)?),"height":(\d+(?:\.\d+)?)\}/.exec(svg.slice(0, 4000));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** The template for new pages from the note's `template:` name; unknown names give blank. */
export function noteTemplate(name: string): Template {
  return defaultTemplate(isTemplateKind(name) ? name : 'blank');
}

/** 32-bit FNV-1a with the length: enough to recognise our own writes without keeping the text. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + text.length;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class NoteStore {
  index!: NoteIndex;
  slots: PageSlot[] = [];
  /** File writes completed. */
  saves = 0;
  private dirtyPages = new Set<string>();
  private indexDirty = false;
  /** Fingerprints of the texts recently written or read, per path. */
  private known = new Map<string, string[]>();
  /** The last write queued per path (resolves when it's done, never rejects). */
  private writes = new Map<string, Promise<void>>();
  private noticed = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstChange = 0;
  private closed = false;
  private delay: number;
  private maxDelay: number;
  private newId: (taken: Set<string>) => string;

  /**
   * `notePath` is the index's vault path; its pages are in the folder named after `basename`
   * next to it.
   */
  constructor(private files: NoteFiles, public notePath: string, readonly basename: string,
    private listener: StoreListener, options: StoreOptions = {}) {
    this.delay = options.delay ?? SAVE_DELAY;
    this.maxDelay = options.maxDelay ?? MAX_SAVE_DELAY;
    this.newId = options.newId ?? (taken => newPageId(taken));
  }

  /** The note's folder with a trailing slash, or '' at the vault root. */
  private get dir(): string {
    const slash = this.notePath.lastIndexOf('/');
    return slash < 0 ? '' : this.notePath.slice(0, slash + 1);
  }

  /** The folder holding the pages, e.g. `School/lecture`. */
  get folder(): string {
    return this.dir + this.basename;
  }

  get paperSize(): Size {
    return PAPER_SIZES[this.index.paper];
  }

  pagePath(id: string): string {
    return this.dir + pagePath(this.basename, id);
  }

  /** Reads the index (from `text` if given) and every page file. Throws if the index can't be read. */
  async load(text?: string): Promise<void> {
    const md = text ?? await this.files.read(this.notePath);
    if (md === null) throw new Error(`${this.notePath} not found`);
    this.index = readNote(md, this.basename);
    this.remember(this.notePath, md);
    this.slots = await Promise.all(this.index.pages.map(id => this.loadSlot(id)));
  }

  private async loadSlot(id: string): Promise<PageSlot> {
    const path = this.pagePath(id);
    const slot: PageSlot = { id, path, size: this.paperSize, page: null, text: null, error: null };
    let text: string | null;
    try {
      text = await this.files.read(path);
    } catch (e) {
      slot.error = `Couldn't read ${path}: ${errorText(e)}`;
      return slot;
    }
    if (text === null) {
      slot.error = `Page file missing: ${path}`;
      return slot;
    }
    this.setText(slot, text);
    return slot;
  }

  /** Takes a page file's text: the size now, the strokes when first needed. */
  private setText(slot: PageSlot, text: string) {
    this.remember(slot.path, text);
    slot.page = null;
    slot.error = null;
    slot.text = text;
    const size = peekSize(text);
    if (size) slot.size = size;
    else this.page(slot); // not laid out as writePage does, or not a page: parse now for the size or the error
  }

  /** The slot's page, parsed from its text on first use; null if the page can't be read. */
  page(slot: PageSlot): Page | null {
    if (slot.page || slot.error) return slot.page;
    if (slot.text === null) return null;
    try {
      slot.page = readPage(slot.text);
      slot.size = slot.page.size;
    } catch (e) {
      slot.error = `Couldn't read ${slot.path}: ${errorText(e)}`;
    }
    slot.text = null;
    return slot.page;
  }

  /** Pages read from disk (parsed or not) or created here. */
  get pagesLoaded(): number {
    return this.slots.filter(s => !s.error).length;
  }

  // ---- changes

  addStroke(slot: PageSlot, stroke: Stroke) {
    const page = this.page(slot);
    if (!page) return;
    page.strokes.push(stroke);
    this.changed(slot);
  }

  /** Marks a page as changed after editing its model in place. */
  changed(slot: PageSlot) {
    this.dirtyPages.add(slot.id);
    this.schedule();
  }

  /** Appends a page with the note's paper size and default template. */
  addPage(): PageSlot {
    const taken = new Set(this.index.pages);
    for (const name of this.files.list(this.folder)) {
      const m = /^(p-[0-9a-f]{6})\.svg$/.exec(name);
      if (m) taken.add(m[1]);
    }
    const id = this.newId(taken);
    const page = newPage(id, this.paperSize, noteTemplate(this.index.template));
    const slot: PageSlot = { id, path: this.pagePath(id), size: page.size, page, text: null, error: null };
    this.slots.push(slot);
    this.index.pages.push(id);
    this.dirtyPages.add(id);
    this.indexDirty = true;
    this.schedule();
    return slot;
  }

  /** Whether anything changed here is not yet written. */
  get unsaved(): boolean {
    return this.dirtyPages.size > 0 || this.indexDirty || this.writes.size > 0;
  }

  private hasUnsaved(path: string): boolean {
    if (this.writes.has(path)) return true;
    if (path === this.notePath) return this.indexDirty;
    const slot = this.slots.find(s => s.path === path);
    return !!slot && this.dirtyPages.has(slot.id);
  }

  private schedule() {
    if (this.closed) return;
    const now = Date.now();
    if (!this.firstChange) this.firstChange = now;
    if (this.timer !== null) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstChange + this.maxDelay - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  /** Writes every changed page, then the index if it changed. Resolves when they're written. */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.firstChange = 0;
    const pageWrites: Promise<boolean>[] = [];
    for (const id of this.dirtyPages) {
      const slot = this.slots.find(s => s.id === id);
      if (!slot || !slot.page) continue;
      let text: string;
      try {
        text = writePage(slot.page);
      } catch (e) {
        this.listener.notice(`Couldn't save ${slot.path}: ${errorText(e)}`);
        continue;
      }
      pageWrites.push(this.save(slot.path, text, () => this.retry(() => this.dirtyPages.add(id))));
    }
    this.dirtyPages.clear();
    let done: Promise<unknown> = Promise.all(pageWrites);
    if (this.indexDirty) {
      this.indexDirty = false;
      const text = writeNote(this.index);
      // After the pages, so the index never embeds a page file that isn't written yet.
      done = done.then(() => this.save(this.notePath, text, () => this.retry(() => { this.indexDirty = true; })));
    }
    return done.then(() => undefined);
  }

  private retry(mark: () => void) {
    mark();
    this.schedule();
  }

  /** Queues a write after any earlier write to the same file. Resolves true if it succeeded. */
  private save(path: string, text: string, onError: () => void): Promise<boolean> {
    this.remember(path, text); // before writing: the modify event may fire during the write
    const prev = this.writes.get(path) ?? Promise.resolve();
    const job = prev.then(() => this.files.write(path, text)).then(
      () => {
        this.saves++;
        this.listener.saved(path);
        return true;
      },
      e => {
        this.listener.notice(`Couldn't save ${path}: ${errorText(e)}`);
        if (!this.closed) onError();
        return false;
      });
    const tail = job.then(() => undefined);
    this.writes.set(path, tail);
    void tail.then(() => {
      if (this.writes.get(path) === tail) this.writes.delete(path);
    });
    return job;
  }

  private remember(path: string, text: string) {
    const list = this.known.get(path) ?? [];
    const f = fingerprint(text);
    if (list[list.length - 1] !== f) list.push(f);
    if (list.length > 4) list.shift();
    this.known.set(path, list);
  }

  private isKnown(path: string, text: string): boolean {
    return (this.known.get(path) ?? []).includes(fingerprint(text));
  }

  /** Stops the save timer. Call flush() first; writes already queued still complete. */
  close() {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The note was renamed or moved. Its pages stay where they are. */
  renamed(notePath: string) {
    const known = this.known.get(this.notePath);
    if (known) this.known.set(notePath, known);
    this.notePath = notePath;
  }

  // ---- changes on disk

  /** Whether a path is the index or one of the note's pages. */
  owns(path: string): boolean {
    return path === this.notePath || this.slots.some(s => s.path === path);
  }

  /**
   * A file of the note changed, appeared or disappeared on disk. Our own writes are ignored.
   * With no unsaved changes to that file here it's reloaded; otherwise the changes here are
   * kept (and saved over it) and a notice says so, once per change.
   */
  async external(path: string, kind: 'modify' | 'create' | 'delete'): Promise<void> {
    if (this.closed || !this.owns(path)) return;
    let text: string | null = null;
    if (kind !== 'delete') {
      try {
        text = await this.files.read(path);
      } catch (e) {
        return;
      }
      if (text === null || this.isKnown(path, text)) return;
    }
    if (this.closed) return;
    // Checked after the read, so a stroke added meanwhile isn't lost.
    if (this.hasUnsaved(path)) {
      const key = text === null ? 'deleted' : fingerprint(text);
      if (this.noticed.get(path) !== key) {
        this.noticed.set(path, key);
        const name = path.slice(path.lastIndexOf('/') + 1);
        this.listener.notice(`${name} changed on disk; your unsaved changes are kept`);
      }
      return;
    }
    this.noticed.delete(path);
    if (path === this.notePath) {
      if (text !== null) await this.reloadIndex(text);
      return;
    }
    const slot = this.slots.find(s => s.path === path);
    if (!slot) return;
    if (text === null) {
      slot.page = null;
      slot.text = null;
      slot.error = `Page file missing: ${path}`;
      this.known.delete(path);
    } else {
      this.setText(slot, text);
    }
    this.listener.pageChanged(slot);
  }

  private async reloadIndex(text: string) {
    let index: NoteIndex;
    try {
      index = readNote(text, this.basename);
    } catch (e) {
      this.listener.notice(`Couldn't read ${this.notePath}: ${errorText(e)}`);
      return;
    }
    this.remember(this.notePath, text);
    // A page removed elsewhere that has changes here: save them now, so nothing is lost.
    if (this.slots.some(s => !index.pages.includes(s.id) && this.dirtyPages.has(s.id))) await this.flush();
    const old = new Map(this.slots.map(s => [s.id, s] as const));
    const slots = await Promise.all(index.pages.map(id => old.get(id) ?? this.loadSlot(id)));
    if (this.closed) return;
    this.index = index;
    this.slots = slots;
    this.listener.indexChanged();
  }
}

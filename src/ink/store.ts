// An open ink note's data: the index and its pages, read through a small file interface (the
// view adapts Obsidian's vault to it; unit tests use a map). Tracks what changed and saves it:
// each changed page is written SAVE_DELAY ms after the last change (at most MAX_SAVE_DELAY
// after the first), and at once on flush(). Writes to one file are serialized, pages before
// the index, and the text of our own writes is remembered so their modify events are ignored.
// Changes made on disk by others (a sync) reload the file unless it has unsaved changes here.
import { newPageId } from '../format/ids';
import { isRelativeFolder, readNote, writeNote, type NoteIndex } from '../format/note';
import { dirOf, locatePages, nameOf, rebase, relative, resolve, within } from './paths';
import { newPage, paperSize, readPage, writePage, type Page, type Size, type Stroke } from '../format/page';
import { parseTemplate, parseTemplateName, sameTemplate, templateName, templateSize, type Template } from '../format/template';
import type { PageImage } from '../format/page';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const SAVE_DELAY = 2000;
export const MAX_SAVE_DELAY = 10000;
/**
 * A note with more pages than this is loaded lazily (#63): a page's file is read when the view
 * asks for it (NoteStore.request), not when the note opens. An imported textbook is hundreds of
 * pages, each with an embedded image of a few hundred KB.
 */
export const LAZY_OVER = 48;
/**
 * In a lazily loaded note, at most this many pages that weren't changed here are kept in memory;
 * past it the ones asked for longest ago are released. Not below LAZY_OVER, so a note loaded
 * whole never releases a page.
 */
export const MAX_LOADED = 48;

/** The file access the store needs. Paths are vault paths. */
export interface NoteFiles {
  /** The file's text, or null if there is no such file. */
  read(path: string): Promise<string | null>;
  /** Writes the file, creating it and its folder if needed. */
  write(path: string, text: string): Promise<void>;
  /** Names of the files directly in a folder ([] if it doesn't exist). */
  list(folder: string): string[];
  /**
   * Deletes the file if it exists (#17, deleting a page). Optional so file interfaces written
   * before page deletion still fit; without it a deleted page's file stays on disk, orphaned.
   */
  delete?(path: string): Promise<void>;
  /** Whether a folder exists (#26: tells a page folder moved from a page file moved). */
  isFolder?(path: string): boolean;
  /** Whether a file exists (#62: finds the pages when Obsidian has rewritten the embeds). */
  isFile?(path: string): boolean;
  /** The vault path of the file with this name, as Obsidian resolves a bare link; null if none (#62). */
  find?(name: string): string | null;
}

export interface StoreListener {
  /** A page was reloaded from disk (or became unreadable or missing). */
  pageChanged(slot: PageSlot): void;
  /** The index was reloaded from disk: pages may have been added, removed or reordered. */
  indexChanged(): void;
  notice(message: string): void;
  /** A file write finished. */
  saved(path: string): void;
  /** A page's model was changed here (strokes or template), e.g. to redraw its thumbnail (#17). */
  pageEdited?(slot: PageSlot): void;
  /** Pages' sizes became known or were re-estimated (#63): lay the pages out again. */
  pagesSized?(): void;
  /** A page asked for with request() is now in memory (or its error is): draw it (#63). */
  pageLoaded?(slot: PageSlot): void;
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
  /**
   * Whether the page's file has been read (or the page was made here). In a note loaded lazily
   * (#63) a page is read when NoteStore.request asks for it, and until then (and after it is
   * released again) it has no page, text or error, and `size` is an estimate.
   */
  loaded: boolean;
}

export interface StoreOptions {
  delay?: number;
  maxDelay?: number;
  /** Page ids for new pages; defaults to random ones. */
  newId?: (taken: Set<string>) => string;
  /**
   * Resolves when Obsidian has finished updating links after a rename (#62); the index isn't
   * written until then. Without it the index is written at once.
   */
  linksSettled?: () => Promise<void>;
  /**
   * Resolves a `template:` name that isn't built in, such as `pdf:<name>` (#21, a PDF template
   * from the templates folder): its template and page size, or null if unknown (then blank).
   */
  resolveTemplate?: (name: string) => { template: Template; size: Size } | null;
  /** The `template:` name of a template that has no built-in name (a PDF template), or null. */
  nameTemplate?: (template: Template) => string | null;
  /**
   * Called when a page gets a pdf template (added or changed), with the vault path of the page
   * folder, so the PDF it refers to can be copied there (#21).
   */
  templateUsed?: (template: Template, pageFolder: string) => void;
}

/** A page's size read from the start of its metadata without parsing the strokes. */
export function peekSize(svg: string): Size | null {
  const m = /"size":\{"width":(\d+(?:\.\d+)?),"height":(\d+(?:\.\d+)?)\}/.exec(svg.slice(0, 4000));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * The template for new pages from the note's `template:` name. The frontmatter can be edited
 * by hand, so an unknown name gives blank with a console warning rather than an error.
 */
export function noteTemplate(name: string): Template {
  try {
    return parseTemplateName(name);
  } catch (e) {
    console.warn('[notebook]', `${errorText(e)}; using blank`);
    return { kind: 'blank' };
  }
}

/** What setAllTemplates changed, to reverse it: the note's default and each page's template. */
export interface TemplatesBefore {
  /** The note's `template:` name. */
  note: string;
  /** Each page that could be read and the template it had (and its size, when a size was given). */
  pages: { id: string; template: Template; size?: Size }[];
}

/** 32-bit FNV-1a with the length: enough to recognise our own writes without keeping the text. */
export function fingerprint(text: string): string {
  return fnvDone(fnv(0x811c9dc5, text, 0, text.length), text);
}

function fnv(h: number, text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

const fnvDone = (h: number, text: string) => (h >>> 0).toString(16) + ':' + text.length;

/**
 * Characters fingerprinted per task (a few ms). A dense page's file is megabytes, and
 * fingerprinting it at once took about 30 ms of the frame the autosave ran in (#37).
 */
const FINGERPRINT_CHUNK = 1 << 19;

/** fingerprint(text), computed in FINGERPRINT_CHUNK slices on separate tasks for a long text. */
export function fingerprintLater(text: string): Promise<string> {
  if (text.length <= FINGERPRINT_CHUNK) return Promise.resolve(fingerprint(text));
  return new Promise(resolve => {
    let h = 0x811c9dc5, at = 0;
    const step = () => {
      const to = Math.min(text.length, at + FINGERPRINT_CHUNK);
      h = fnv(h, text, at, to);
      at = to;
      if (at < text.length) setTimeout(step, 0);
      else resolve(fnvDone(h, text));
    };
    setTimeout(step, 0);
  });
}

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
  private options: StoreOptions;
  /** Pages taken out of the index by removePageFromIndex, for insertPageInIndex (undo, #8). */
  private detached = new Map<string, { slot: PageSlot; dirty: boolean }>();
  /** The pages' folder as a vault path, once loaded (#26: it needn't be next to the note). */
  private pagesAt: string | null = null;
  /** While movePages moves the page folder: saves wait for it, and changes on disk are ignored. */
  private moving: Promise<void> | null = null;
  /**
   * While Obsidian may still update links after a rename (#62): the index isn't written, since
   * Obsidian replaces links at the offsets they had before the rename and a rewritten index
   * would be garbled. Pages are still saved.
   */
  private indexHold: Promise<void> | null = null;

  /**
   * `notePath` is the index's vault path; its pages are in the folder named after `basename`
   * next to it.
   */
  constructor(private files: NoteFiles, public notePath: string, public basename: string,
    private listener: StoreListener, options: StoreOptions = {}) {
    this.delay = options.delay ?? SAVE_DELAY;
    this.maxDelay = options.maxDelay ?? MAX_SAVE_DELAY;
    this.newId = options.newId ?? (taken => newPageId(taken));
    this.options = options;
  }

  /** The note's folder with a trailing slash, or '' at the vault root. */
  private get dir(): string {
    const slash = this.notePath.lastIndexOf('/');
    return slash < 0 ? '' : this.notePath.slice(0, slash + 1);
  }

  /** The folder holding the pages, e.g. `School/lecture`. */
  get folder(): string {
    return this.pagesAt ?? this.dir + this.basename;
  }

  get paperSize(): Size {
    return paperSize(this.index.paper);
  }

  /**
   * The note's default template for new pages and the size it comes in, if any: a built-in
   * name (a sized one such as `sticky-3in` has a size, #27), or a name the resolver knows
   * (`tpl:<name>`, a custom template, #54, or its older alias `pdf:<name>`, #21). Unknown names
   * give blank with a warning.
   */
  defaultTemplate(): { template: Template; size: Size | null } {
    const name = this.index.template;
    if (!/^(?:pdf|tpl):/.test(name)) return { template: noteTemplate(name), size: templateSize(name) };
    const r = this.options.resolveTemplate?.(name);
    if (r) return { template: parseTemplate(r.template), size: { ...r.size } };
    console.warn('[notebook]', `Unknown template "${name}"; using blank`);
    return { template: { kind: 'blank' }, size: null };
  }

  pagePath(id: string): string {
    return `${this.folder}/${id}.svg`;
  }

  /**
   * The page folder of a read index as a vault path: where its first page file is (#62: found
   * as Obsidian resolves the embed, whichever form it rewrote it to), else the folder the
   * embeds name from the note's folder (the default one if that leaves the vault). `found`
   * says the page file was seen there.
   */
  private pagesOf(index: NoteIndex): { at: string; found: boolean } {
    const dir = dirOf(this.notePath);
    const { isFile, find } = this.files;
    if (index.pages.length && isFile && find) {
      const at = locatePages(dir, index.folder, index.pages[0], { isFile: p => isFile.call(this.files, p), find: n => find.call(this.files, n) });
      if (at) return { at, found: true };
    }
    const named = isRelativeFolder(index.folder) ? resolve(dir, index.folder) : null;
    return { at: named ?? this.dir + this.basename, found: false };
  }

  /** Reads the index (from `text` if given) and every page file. Throws if the index can't be read. */
  async load(text?: string): Promise<void> {
    const md = text ?? await this.files.read(this.notePath);
    if (md === null) throw new Error(`${this.notePath} not found`);
    this.index = readNote(md, this.basename);
    const pages = this.pagesOf(this.index);
    this.pagesAt = pages.at;
    this.remember(this.notePath, md);
    // Embeds in another form (rewritten by Obsidian, #62) are written back as relative paths.
    this.setFolder(pages.at, pages.found);
    this.lazy = this.index.pages.length > LAZY_OVER;
    this.slots = await this.openSlots(this.index.pages);
  }

  // ---- loading pages (#63)
  // A note of up to LAZY_OVER pages is read whole when it opens. A longer one is lazy: its slots
  // start unloaded, the view asks for the pages near the viewport (request), and pages that
  // weren't changed here are released again once more than MAX_LOADED are in memory, the ones
  // asked for longest ago first. A page changed here stays (undo and redo refer to it). Until a
  // page is read its size is an estimate: the note's paper, or the size of the last page read
  // (the pages of an imported PDF are mostly one size).

  /** Whether pages are read on request rather than when the note opens. */
  lazy = false;
  /** Pages changed here since the note opened: never released. */
  private edited = new Set<string>();
  /** Reads under way, per page id. */
  private loading = new Map<string, Promise<void>>();
  /** When each loaded page was last asked for (a counter), for releasing the oldest. */
  private used = new Map<string, number>();
  private uses = 0;
  /** While set (loadAll), no page is released. */
  private keepAll = 0;
  /** The size given to pages not read yet, once a page has been read. */
  private estimate: Size | null = null;

  /** Slots for these page ids: read now, or unloaded in a lazy note. */
  private openSlots(ids: readonly string[]): Promise<PageSlot[]> {
    if (!this.lazy) return Promise.all(ids.map(id => this.loadSlot(id)));
    return Promise.resolve(ids.map(id => this.newSlot(id)));
  }

  private newSlot(id: string): PageSlot {
    return { id, path: this.pagePath(id), size: this.estimate ?? this.paperSize, page: null, text: null, error: null, loaded: false };
  }

  private async loadSlot(id: string): Promise<PageSlot> {
    const slot = this.newSlot(id);
    await this.read(slot);
    return slot;
  }

  /** Reads the slot's file into it (or the error). */
  private async read(slot: PageSlot): Promise<void> {
    const path = slot.path;
    let text: string | null;
    try {
      text = await this.files.read(path);
    } catch (e) {
      slot.error = `Couldn't read ${path}: ${errorText(e)}`;
      slot.loaded = true;
      return;
    }
    if (slot.loaded) return; // made or read meanwhile
    if (text === null) {
      slot.error = `Page file missing: ${path}`;
      slot.loaded = true;
      return;
    }
    this.setText(slot, text);
  }

  /**
   * Asks for a page of a lazy note: reads its file if it isn't in memory and tells the listener
   * (pagesSized if its size wasn't the estimate, then pageLoaded) when it is. Call it for every page that should stay in memory (the ones near
   * the viewport), each time the view moves: the pages asked for longest ago are released.
   * Resolves when the page is loaded (at once if it is).
   */
  request(slot: PageSlot): Promise<void> {
    this.used.set(slot.id, ++this.uses);
    if (slot.loaded) return Promise.resolve();
    let job = this.loading.get(slot.id);
    if (!job) {
      const size = slot.size;
      job = this.read(slot).then(() => {
        this.loading.delete(slot.id);
        if (this.closed || (!this.slots.includes(slot) && !this.detached.has(slot.id))) return;
        if (slot.size.width !== size.width || slot.size.height !== size.height) this.resize(slot);
        (this.listener.pageLoaded ?? this.listener.pageChanged).call(this.listener, slot);
        this.trim();
      });
      this.loading.set(slot.id, job);
    }
    return job;
  }

  /** A page was read at a size that wasn't expected: the pages not read yet are taken to have it too. */
  private resize(slot: PageSlot) {
    this.estimate = { ...slot.size };
    for (const s of this.slots) if (!s.loaded && !this.loading.has(s.id)) s.size = { ...slot.size };
    this.listener.pagesSized?.();
  }

  /**
   * Reads every page (for a change or an export of the whole note) and keeps them all until
   * `release` is called. `progress(done, total)` is called as pages are read.
   */
  async loadAll(progress?: (done: number, total: number) => void): Promise<() => void> {
    this.keepAll++;
    const slots = [...this.slots];
    let done = 0;
    for (const slot of slots) {
      if (!slot.loaded) await this.request(slot);
      progress?.(++done, slots.length);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.keepAll--;
      this.trim();
    };
  }

  /** Whether a loaded page may be released: unchanged here, with nothing of it being written. */
  private releasable(slot: PageSlot): boolean {
    return slot.loaded && !this.edited.has(slot.id) && !this.dirtyPages.has(slot.id) && !this.writes.has(slot.path);
  }

  /** Releases the pages asked for longest ago while more than MAX_LOADED unchanged ones are in memory. */
  private trim() {
    if (!this.lazy || this.keepAll) return;
    const free = this.slots.filter(s => this.releasable(s));
    if (free.length <= MAX_LOADED) return;
    free.sort((a, b) => (this.used.get(a.id) ?? 0) - (this.used.get(b.id) ?? 0));
    for (const slot of free.slice(0, free.length - MAX_LOADED)) {
      slot.page = null;
      slot.text = null;
      slot.error = null;
      slot.loaded = false;
      this.used.delete(slot.id);
      this.lastText.delete(slot.path);
    }
  }

  /** Pages in memory (for tests and stats). */
  get pagesInMemory(): number {
    return this.slots.filter(s => s.loaded && !s.error).length;
  }

  /** Takes a page file's text: the size now, the strokes when first needed. */
  private setText(slot: PageSlot, text: string) {
    // Only the fingerprint is kept of a text that was read: keeping the text of every page of
    // a long note took as much memory as the note has bytes (#63). A long text's fingerprint
    // is computed over later tasks, off the frame the page arrives in.
    const path = slot.path;
    if (text.length > FINGERPRINT_CHUNK) void fingerprintLater(text).then(f => { if (slot.path === path && !this.lastText.has(path)) this.rememberPrint(path, f, null); });
    else this.rememberPrint(path, fingerprint(text), null);
    slot.page = null;
    slot.error = null;
    slot.text = text;
    slot.loaded = true;
    const size = peekSize(text);
    if (size) slot.size = size;
    else this.page(slot); // not laid out as writePage does, or not a page: parse now for the size or the error
  }

  /**
   * The slot's page, parsed from its text on first use; null if the page can't be read, or
   * isn't loaded (a lazy note: see request).
   */
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
    this.edited.add(slot.id);
    this.dirtyPages.add(slot.id);
    this.schedule();
    this.listener.pageEdited?.(slot);
  }

  /**
   * Sets one page's template; the strokes are untouched. Returns the template it had (to undo,
   * set that again), or null if there's no such page or it can't be read.
   */
  setPageTemplate(pageId: string, template: Template, size?: Size): Template | null {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page) return null;
    const before = page.template;
    const next = parseTemplate(template);
    let changed = false;
    if (!sameTemplate(next, before)) {
      page.template = next;
      changed = true;
      if (next.kind === 'pdf') this.options.templateUsed?.(next, this.folder);
    }
    // A sized template (#27) or a PDF template (#21) brings its page size; the caller reads the
    // old size (slot.size) first to undo it.
    if (size && (size.width !== page.size.width || size.height !== page.size.height)) {
      page.size = { width: size.width, height: size.height };
      slot.size = page.size;
      changed = true;
    }
    if (changed) this.changed(slot);
    return before;
  }

  /**
   * Sets the template of every page that can be read, and makes it the note's default for new
   * pages (`name`, if given, is its `template:` name: a custom template's, #54). Returns what it
   * replaced.
   */
  setAllTemplates(template: Template, size?: Size, name?: string): TemplatesBefore {
    const pages: TemplatesBefore['pages'] = [];
    for (const slot of this.slots) {
      if (!this.page(slot)) continue;
      const had = { ...slot.size };
      const before = this.setPageTemplate(slot.id, template, size);
      if (before) pages.push(size ? { id: slot.id, template: before, size: had } : { id: slot.id, template: before });
    }
    return { note: this.setNoteTemplate(template, name), pages };
  }

  /**
   * Sets the note's default template for new pages (`name`, if given, is its `template:` name).
   * Returns the `template:` name it had.
   */
  setNoteTemplate(template: Template, given?: string): string {
    const before = this.index.template;
    const name = given || (this.options.nameTemplate?.(template) ?? templateName(template));
    if (name !== before) {
      this.index.template = name;
      this.indexDirty = true;
      this.schedule();
    }
    return before;
  }

  /** Appends a page with the note's paper size and the given template, or the note's default. */
  addPage(template?: Template, size?: Size): PageSlot {
    return this.insertPage(this.slots.length, template, size);
  }

  // ---- changes for undo and redo (#8)

  /**
   * Removes these strokes from the page. Returns the removed strokes with the indices they had,
   * in ascending index order (to put them back with insertStrokes). Marks the page changed if
   * anything was removed; unknown ids, pages and unreadable pages remove nothing.
   */
  removeStrokes(pageId: string, ids: Iterable<string>): { index: number; stroke: Stroke }[] {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page) return [];
    const remove = new Set(ids);
    const removed: { index: number; stroke: Stroke }[] = [];
    const kept: Stroke[] = [];
    page.strokes.forEach((stroke, index) => {
      if (remove.has(stroke.id)) removed.push({ index, stroke });
      else kept.push(stroke);
    });
    if (!removed.length) return removed;
    page.strokes = kept;
    this.changed(slot);
    return removed;
  }

  /**
   * Puts strokes back at these indices (as removeStrokes returned them), restoring the original
   * order. Indices past the end append; a stroke whose id is already on the page is skipped.
   */
  insertStrokes(pageId: string, entries: { index: number; stroke: Stroke }[]): void {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page || !entries.length) return;
    const present = new Set(page.strokes.map(s => s.id));
    for (const { index, stroke } of [...entries].sort((a, b) => a.index - b.index)) {
      if (present.has(stroke.id)) continue;
      page.strokes.splice(Math.min(index, page.strokes.length), 0, stroke);
      present.add(stroke.id);
    }
    this.changed(slot);
  }

  /**
   * Takes a page out of the index (undoing "Add page"). Only the index changes: the page file
   * is not deleted, so a page already written stays on disk, orphaned, until insertPageInIndex
   * puts it back (page deletion is #17). Returns the position it had, or -1 if it isn't in the
   * note. A page with unsaved changes isn't written while it's out of the index.
   */
  removePageFromIndex(pageId: string): { index: number } {
    const index = this.index.pages.indexOf(pageId);
    if (index < 0) return { index };
    const [slot] = this.slots.splice(index, 1);
    this.index.pages.splice(index, 1);
    this.detached.set(pageId, { slot, dirty: this.dirtyPages.delete(pageId) });
    this.indexDirty = true;
    this.schedule();
    return { index };
  }

  /** Puts a page taken out by removePageFromIndex back into the index at `index`. */
  insertPageInIndex(pageId: string, index: number): void {
    const out = this.detached.get(pageId);
    if (!out) throw new Error(`Page ${pageId} was not taken out of the index`);
    if (this.index.pages.includes(pageId)) return;
    this.detached.delete(pageId);
    const at = Math.max(0, Math.min(index, this.slots.length));
    this.slots.splice(at, 0, out.slot);
    this.index.pages.splice(at, 0, pageId);
    if (out.dirty) this.dirtyPages.add(pageId);
    this.indexDirty = true;
    this.schedule();
  }

  /**
   * Sets the note's `template:` name as it was, even a hand-edited name that isn't a known
   * template (undoing setAllTemplates). Returns the name it had.
   */
  setNoteTemplateName(name: string): string {
    const before = this.index.template;
    if (name !== before) {
      this.index.template = name;
      this.indexDirty = true;
      this.schedule();
    }
    return before;
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

  /** How long the last writePage of a flush took, in ms (#37: the view's stats.saveMs). */
  writeMs = 0;

  /** Writes every changed page, then the index if it changed. Resolves when they're written. */
  flush(): Promise<void> {
    if (this.moving) return this.moving.then(() => this.flush());
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.firstChange = 0;
    const pageWrites: Promise<boolean>[] = [];
    for (const id of this.dirtyPages) {
      const slot = this.slots.find(s => s.id === id);
      if (!slot || !slot.page) continue;
      let text: string;
      try {
        const t0 = performance.now();
        text = writePage(slot.page);
        this.writeMs = performance.now() - t0;
      } catch (e) {
        this.listener.notice(`Couldn't save ${slot.path}: ${errorText(e)}`);
        continue;
      }
      pageWrites.push(this.save(slot.path, text, () => this.retry(() => this.dirtyPages.add(id))));
    }
    this.dirtyPages.clear();
    let done: Promise<unknown> = Promise.all(pageWrites);
    if (this.indexDirty && !this.indexHold) {
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
    // Remembered before writing: the modify event may fire during the write. A long text's
    // fingerprint is computed over several tasks first (#37), still ahead of the write.
    const remembered = text.length > FINGERPRINT_CHUNK
      ? fingerprintLater(text).then(f => this.rememberPrint(path, f, text))
      : (this.remember(path, text), null);
    const prev = this.writes.get(path) ?? Promise.resolve();
    const job = (remembered ? Promise.all([prev, remembered]) : prev).then(() => this.files.write(path, text)).then(
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
    this.rememberPrint(path, fingerprint(text), text);
  }

  /**
   * The last text written or read per path, so recognising our own write in its modify event
   * is a string comparison instead of fingerprinting megabytes again (#37).
   */
  private lastText = new Map<string, { text: string; f: string }>();

  /** `text` is kept for a text written here; null for one that was read (only `f` is kept, #63). */
  private rememberPrint(path: string, f: string, text: string | null) {
    const list = this.known.get(path) ?? [];
    if (list[list.length - 1] !== f) list.push(f);
    if (list.length > 4) list.shift();
    this.known.set(path, list);
    if (text === null) this.lastText.delete(path);
    else this.lastText.set(path, { text, f });
  }

  private isKnown(path: string, text: string): boolean {
    const last = this.lastText.get(path);
    const f = last && last.text === text ? last.f : fingerprint(text);
    return (this.known.get(path) ?? []).includes(f);
  }

  /** Stops the save timer. Call flush() first; writes already queued still complete. */
  close() {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The note was renamed or moved. Its pages stay where they are (movePages moves them), so the
   * index's folder is recomputed from the new place; a save meanwhile embeds them correctly.
   */
  renamed(notePath: string) {
    if (notePath === this.notePath) return;
    const known = this.known.get(this.notePath);
    if (known) this.known.set(notePath, known);
    const pages = this.folder;
    this.notePath = notePath;
    this.basename = nameOf(notePath).replace(/\.md$/i, '');
    if (!this.index) return;
    this.index.basename = this.basename;
    this.pagesAt = pages;
    this.holdIndex();
    this.setFolder(pages);
  }

  /**
   * Sets the index's relative folder for pages at `pages`, marking the index changed if it
   * differs (unless `dirty` is false: a guess at where missing pages are isn't written).
   */
  private setFolder(pages: string, dirty = true) {
    const rel = relative(dirOf(this.notePath), pages);
    if (rel === this.index.folder) return;
    this.index.folder = rel;
    if (!dirty) return;
    this.indexDirty = true;
    this.schedule();
  }

  /** After a rename: holds the index back until Obsidian's link update is done, then saves (#62). */
  private holdIndex() {
    const settled = this.options.linksSettled?.();
    if (!settled) return;
    const hold: Promise<void> = settled.then(() => undefined, () => undefined).then(() => {
      if (this.indexHold !== hold) return;
      this.indexHold = null;
      if (this.indexDirty && !this.closed) void this.flush();
    });
    this.indexHold = hold;
  }

  /** Resolves once the index is no longer held back after a rename. */
  async indexReleased(): Promise<void> {
    while (this.indexHold) await this.indexHold;
  }

  /**
   * The page folder is now at `to` (moved by someone else, or by movePages): pages are read and
   * written there from now on and the index's embeds follow. Slot paths change at once.
   */
  pagesMoved(to: string) {
    const from = this.folder;
    if (to === from || !this.index) return;
    const move = (slot: PageSlot) => {
      const path = rebase(slot.path, from, to);
      const known = this.known.get(slot.path);
      if (known) {
        this.known.set(path, known);
        this.known.delete(slot.path);
      }
      slot.path = path;
    };
    for (const slot of this.slots) move(slot);
    for (const { slot } of this.detached.values()) move(slot);
    this.pagesAt = to;
    this.holdIndex();
    this.setFolder(to);
  }

  /**
   * Moves the page folder to `to` with `move` (the vault rename), with no page written to the old
   * place afterwards: saves wait until the move is done (queued writes finish first), then go
   * to the new place along with the rewritten index. Resolves false if the move failed.
   */
  async movePages(to: string, move: () => Promise<void>): Promise<boolean> {
    while (this.moving) await this.moving;
    // The writes queued now; later ones wait for the move (a page delete's job waits for a
    // flush, which waits for the move, so waiting for it here would never end).
    const queued = Promise.all([...this.writes.values()]);
    let release!: () => void;
    this.moving = new Promise(r => { release = r; });
    let ok = false;
    try {
      await queued;
      await move();
      this.pagesMoved(to);
      ok = true;
    } catch (e) {
      this.listener.notice(`Couldn't move the pages of ${nameOf(this.notePath)}: ${errorText(e)}`);
    } finally {
      this.moving = null;
      release();
    }
    return ok;
  }

  /**
   * A file or folder in the vault was renamed. Returns true if that was the page folder (or a
   * folder holding it) moving, which the store follows here, or a move by movePages; then the
   * rename is not a change on disk to the note's files.
   */
  followRename(newPath: string, oldPath: string, isFolder: boolean): boolean {
    const folder = this.folder;
    if (this.moving) return within(folder, oldPath) || within(oldPath, folder);
    if (!this.index) return false;
    if (isFolder) {
      if (!within(folder, oldPath)) return false;
      this.pagesMoved(rebase(folder, oldPath, newPath));
      return true;
    }
    // A page file whose folder moved, if its folder event hasn't come yet: the folder is gone.
    if (dirOf(oldPath) === folder && nameOf(oldPath) === nameOf(newPath) && this.files.isFolder && !this.files.isFolder(folder)) {
      this.pagesMoved(dirOf(newPath));
      return true;
    }
    return false;
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
    if (this.closed || this.moving || !this.owns(path)) return;
    if (kind === 'delete' && this.ownDeletes.has(path)) return; // deletePage's own delete (#17)
    // A page of a lazy note that isn't in memory: it is read when it's asked for (#63).
    const unloaded = path === this.notePath ? undefined : this.slots.find(s => s.path === path && !s.loaded);
    if (unloaded) return;
    let text: string | null = null;
    if (kind !== 'delete') {
      try {
        text = await this.files.read(path);
      } catch (e) {
        return;
      }
      if (text === null || this.isKnown(path, text)) return;
    }
    if (this.closed || this.moving || !this.owns(path)) return;
    // Checked after the read, so a stroke added meanwhile isn't lost.
    if (this.hasUnsaved(path)) {
      if (path === this.notePath && text !== null && this.samePages(text)) return; // only the embeds' form differs (#62)
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
    if (!slot.loaded) return; // released meanwhile
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

  /** Whether an index text lists the pages this one does, in order. */
  private samePages(text: string): boolean {
    try {
      const pages = readNote(text, this.basename).pages;
      return pages.length === this.index.pages.length && pages.every((id, i) => id === this.index.pages[i]);
    } catch (e) {
      return false;
    }
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
    // The embeds name another folder (edited by hand): its pages are other files, read afresh.
    const { at: pages, found } = this.pagesOf(index);
    const moved = pages !== this.folder;
    if (moved) {
      if (this.dirtyPages.size) await this.flush();
      this.pagesAt = pages;
    }
    // A page removed elsewhere that has changes here: save them now, so nothing is lost.
    if (this.slots.some(s => !index.pages.includes(s.id) && this.dirtyPages.has(s.id))) await this.flush();
    const old = new Map(moved ? [] : this.slots.map(s => [s.id, s] as const));
    if (index.pages.length > LAZY_OVER) this.lazy = true; // a note that grew; one loaded lazily stays so
    const fresh = await this.openSlots(index.pages.filter(id => !old.has(id)));
    const made = new Map(fresh.map(s => [s.id, s] as const));
    const slots = index.pages.map(id => old.get(id) ?? made.get(id)!);
    if (this.closed) return;
    this.index = index;
    this.slots = slots;
    this.setFolder(this.folder, found); // embeds rewritten by Obsidian go back to relative paths (#62)
    this.listener.indexChanged();
  }

  // ---- page management (#17)
  // Inserting, moving and duplicating change the index (a duplicate also writes its new file);
  // page files keep their names. Deleting takes the page out of the index like
  // removePageFromIndex, then deletes its file once the index no longer embeds it; the slot is
  // kept detached, marked changed, so insertPageInIndex (undo) puts it back and writes it again.

  /** Paths being deleted by deletePage: their delete events are not changes from elsewhere. */
  private ownDeletes = new Set<string>();

  /** A page id not used by the note, its folder or a detached page. */
  private freshId(): string {
    const taken = new Set(this.index.pages);
    for (const name of this.files.list(this.folder)) {
      const m = /^(p-[0-9a-f]{6})\.svg$/.exec(name);
      if (m) taken.add(m[1]);
    }
    for (const id of this.detached.keys()) taken.add(id); // unwritten pages that redo may bring back
    return this.newId(taken);
  }

  /** Puts a new slot into the note at `index` (clamped) and marks it and the index changed. */
  private placeSlot(slot: PageSlot, index: number): number {
    const at = Math.max(0, Math.min(Math.floor(index) || 0, this.slots.length));
    this.slots.splice(at, 0, slot);
    this.index.pages.splice(at, 0, slot.id);
    this.edited.add(slot.id);
    this.dirtyPages.add(slot.id);
    this.indexDirty = true;
    this.schedule();
    return at;
  }

  /**
   * Inserts a new page at `index` (clamped to 0..pages) with the note's paper size and the given
   * template, or the note's default. `size` overrides the size (#27: a sized template chosen
   * for this page); the note's default template brings its own size if it has one.
   */
  insertPage(index: number, template?: Template, size?: Size): PageSlot {
    const id = this.freshId();
    const def = template ? null : this.defaultTemplate();
    const t = template ? parseTemplate(template) : def!.template;
    const page = newPage(id, size ?? def?.size ?? this.paperSize, t);
    if (t.kind === 'pdf') this.options.templateUsed?.(t, this.folder);
    const slot: PageSlot = { id, path: this.pagePath(id), size: page.size, page, text: null, error: null, loaded: true };
    this.placeSlot(slot, index);
    return slot;
  }

  /**
   * Moves a page to position `toIndex` (clamped) of the pages as they are after taking it out.
   * Only the index changes. Returns the position it had (to undo, move it back there), or -1 if
   * it isn't in the note.
   */
  movePage(pageId: string, toIndex: number): number {
    const from = this.index.pages.indexOf(pageId);
    if (from < 0) return -1;
    const to = Math.max(0, Math.min(Math.floor(toIndex) || 0, this.slots.length - 1));
    if (to === from) return from;
    const [slot] = this.slots.splice(from, 1);
    this.index.pages.splice(from, 1);
    this.slots.splice(to, 0, slot);
    this.index.pages.splice(to, 0, pageId);
    this.indexDirty = true;
    this.schedule();
    return from;
  }

  /**
   * Inserts a copy of a page right after it: a new id and file, the same size and template, the
   * strokes deep-copied (stroke ids are unique within a page, so they're kept). Returns the new
   * slot, or null if there's no such page or it can't be read.
   */
  duplicatePage(pageId: string): PageSlot | null {
    const from = this.index.pages.indexOf(pageId);
    const source = from >= 0 ? this.page(this.slots[from]) : null;
    if (!source) return null;
    const id = this.freshId();
    const copy = JSON.parse(JSON.stringify(source)) as Page;
    copy.id = id;
    const slot: PageSlot = { id, path: this.pagePath(id), size: copy.size, page: copy, text: null, error: null, loaded: true };
    this.placeSlot(slot, from + 1);
    return slot;
  }

  /**
   * Deletes a page: takes it out of the index and deletes its file after the index is written
   * without it (and after any write to the file already queued). The page stays in memory,
   * detached, so insertPageInIndex(pageId, index) brings it back and writes the file again.
   * Returns the position it had, or -1 if it isn't in the note.
   */
  deletePage(pageId: string): { index: number } {
    const slot = this.slots.find(s => s.id === pageId);
    if (!slot) return { index: -1 };
    this.page(slot); // parsed now, so the page can be written again if the delete is undone
    const out = this.removePageFromIndex(pageId);
    this.detached.set(pageId, { slot, dirty: !slot.error });
    const del = this.files.delete?.bind(this.files);
    // A page that isn't in memory (#63) couldn't be written again if the delete were undone: its file stays.
    if (!del || !slot.loaded) return out;
    const path = slot.path;
    const indexWritten = this.flush();
    const prev = this.writes.get(path) ?? Promise.resolve();
    const job = Promise.all([prev, indexWritten]).then(async () => {
      // Undone (and so being written again) meanwhile: keep the file.
      if (this.slots.includes(slot)) return;
      const path = slot.path; // where it is now, if the page folder moved meanwhile (#26)
      this.ownDeletes.add(path);
      try {
        await del(path);
        this.known.delete(path);
      } catch (e) {
        this.listener.notice(`Couldn't delete ${path}: ${errorText(e)}`);
      } finally {
        this.ownDeletes.delete(path);
      }
    });
    this.writes.set(path, job);
    void job.then(() => {
      if (this.writes.get(path) === job) this.writes.delete(path);
    });
    return out;
  }

  /**
   * Replaces a stroke by `replacements` (the partial eraser's remnants, #15, possibly none) at
   * its index, so drawing order is kept, and marks the page changed. Returns the removed stroke
   * with its index (to undo with removeStrokes and insertStrokes), or null if it isn't there.
   */
  replaceStroke(pageId: string, id: string, replacements: Stroke[]): { index: number; stroke: Stroke } | null {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    const index = page ? page.strokes.findIndex(s => s.id === id) : -1;
    if (!slot || !page || index < 0) return null;
    const stroke = page.strokes[index];
    page.strokes.splice(index, 1, ...replacements);
    this.changed(slot);
    return { index, stroke };
  }

  // ---- the lasso (#11)

  /**
   * Replaces strokes in place, each `id` by `stroke` (which may carry another id), keeping
   * drawing order, and marks the page changed once. Returns the strokes replaced with their
   * indices, in the order given (to undo, replace them back); unknown ids are skipped, and an
   * unknown or unreadable page replaces nothing.
   */
  replaceStrokes(pageId: string, entries: readonly { id: string; stroke: Stroke }[]): { index: number; stroke: Stroke }[] {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page || !entries.length) return [];
    const at = new Map(page.strokes.map((s, i) => [s.id, i] as const));
    const out: { index: number; stroke: Stroke }[] = [];
    for (const { id, stroke } of entries) {
      const index = at.get(id);
      if (index === undefined) continue;
      out.push({ index, stroke: page.strokes[index] });
      page.strokes[index] = stroke;
      at.delete(id);
    }
    if (out.length) this.changed(slot);
    return out;
  }

  // ---- images (#12)
  // Each returns what it replaced, so the view can undo it; each marks the page changed once.

  /** Puts an image on the page at `index` of its images (default: on top). False if there's no such page or the id is taken. */
  addImage(pageId: string, image: PageImage, index = Infinity): boolean {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page) return false;
    const images = page.images ?? (page.images = []);
    if (images.some(im => im.id === image.id)) return false;
    images.splice(Math.max(0, Math.min(index, images.length)), 0, image);
    this.changed(slot);
    return true;
  }

  /** Removes these images; returns them with the indices they had, ascending (to put back with addImage). */
  removeImages(pageId: string, ids: Iterable<string>): { index: number; image: PageImage }[] {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page || !page.images) return [];
    const remove = new Set(ids);
    const removed: { index: number; image: PageImage }[] = [];
    page.images = page.images.filter((image, index) => {
      if (!remove.has(image.id)) return true;
      removed.push({ index, image });
      return false;
    });
    if (removed.length) this.changed(slot);
    return removed;
  }

  /** Replaces images in place, each `id` by `image`; returns the old ones (to undo, replace them back). */
  replaceImages(pageId: string, entries: readonly { id: string; image: PageImage }[]): { id: string; image: PageImage }[] {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page || !page.images || !entries.length) return [];
    const out: { id: string; image: PageImage }[] = [];
    for (const { id, image } of entries) {
      const i = page.images.findIndex(im => im.id === id);
      if (i < 0) continue;
      out.push({ id: image.id, image: page.images[i] });
      page.images[i] = image;
    }
    if (out.length) this.changed(slot);
    return out;
  }
}

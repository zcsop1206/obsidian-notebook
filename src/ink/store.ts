// An open ink note's data: the index and its pages, read through a small file interface (the
// view adapts Obsidian's vault to it; unit tests use a map). Tracks what changed and saves it:
// each changed page is written SAVE_DELAY ms after the last change (at most MAX_SAVE_DELAY
// after the first), and at once on flush(). Writes to one file are serialized, pages before
// the index, and the text of our own writes is remembered so their modify events are ignored.
// Changes made on disk by others (a sync) reload the file unless it has unsaved changes here.
import { newPageId } from '../format/ids';
import { readNote, writeNote, type NoteIndex } from '../format/note';
import { dirOf, nameOf, rebase, relative, resolve, within } from './paths';
import { newPage, paperSize, readPage, writePage, type Page, type Size, type Stroke } from '../format/page';
import { parseTemplate, parseTemplateName, sameTemplate, templateName, templateSize, type Template } from '../format/template';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  /**
   * Deletes the file if it exists (#17, deleting a page). Optional so file interfaces written
   * before page deletion still fit; without it a deleted page's file stays on disk, orphaned.
   */
  delete?(path: string): Promise<void>;
  /** Whether a folder exists (#26: tells a page folder moved from a page file moved). */
  isFolder?(path: string): boolean;
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
  /** Each page that could be read and the template it had. */
  pages: { id: string; template: Template }[];
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
   * (`pdf:<name>`, #21). Unknown names give blank with a warning.
   */
  defaultTemplate(): { template: Template; size: Size | null } {
    const name = this.index.template;
    if (!/^pdf:/.test(name)) return { template: noteTemplate(name), size: templateSize(name) };
    const r = this.options.resolveTemplate?.(name);
    if (r) return { template: parseTemplate(r.template), size: { ...r.size } };
    console.warn('[notebook]', `Unknown template "${name}"; using blank`);
    return { template: { kind: 'blank' }, size: null };
  }

  pagePath(id: string): string {
    return `${this.folder}/${id}.svg`;
  }

  /** The page folder a read index names, as a vault path (the default one if it leaves the vault). */
  private pagesOf(index: NoteIndex): string {
    return resolve(dirOf(this.notePath), index.folder) ?? this.dir + this.basename;
  }

  /** Reads the index (from `text` if given) and every page file. Throws if the index can't be read. */
  async load(text?: string): Promise<void> {
    const md = text ?? await this.files.read(this.notePath);
    if (md === null) throw new Error(`${this.notePath} not found`);
    this.index = readNote(md, this.basename);
    this.pagesAt = this.pagesOf(this.index);
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
    this.listener.pageEdited?.(slot);
  }

  /**
   * Sets one page's template; the strokes are untouched. Returns the template it had (to undo,
   * set that again), or null if there's no such page or it can't be read.
   */
  setPageTemplate(pageId: string, template: Template): Template | null {
    const slot = this.slots.find(s => s.id === pageId);
    const page = slot && this.page(slot);
    if (!slot || !page) return null;
    const before = page.template;
    const next = parseTemplate(template);
    if (!sameTemplate(next, before)) {
      page.template = next;
      this.changed(slot);
      if (next.kind === 'pdf') this.options.templateUsed?.(next, this.folder);
    }
    return before;
  }

  /**
   * Sets the template of every page that can be read, and makes it the note's default for new
   * pages. Returns what it replaced.
   */
  setAllTemplates(template: Template): TemplatesBefore {
    const pages: TemplatesBefore['pages'] = [];
    for (const slot of this.slots) {
      if (!this.page(slot)) continue;
      const before = this.setPageTemplate(slot.id, template);
      if (before) pages.push({ id: slot.id, template: before });
    }
    return { note: this.setNoteTemplate(template), pages };
  }

  /** Sets the note's default template for new pages. Returns the `template:` name it had. */
  setNoteTemplate(template: Template): string {
    const before = this.index.template;
    const name = this.options.nameTemplate?.(template) ?? templateName(template);
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
    this.setFolder(pages);
  }

  /** Sets the index's relative folder for pages at `pages`, marking the index changed if it differs. */
  private setFolder(pages: string) {
    const rel = relative(dirOf(this.notePath), pages);
    if (rel === this.index.folder) return;
    this.index.folder = rel;
    this.indexDirty = true;
    this.schedule();
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
    // The embeds name another folder (edited by hand): its pages are other files, read afresh.
    const pages = this.pagesOf(index);
    const moved = pages !== this.folder;
    if (moved) {
      if (this.dirtyPages.size) await this.flush();
      this.pagesAt = pages;
    }
    // A page removed elsewhere that has changes here: save them now, so nothing is lost.
    if (this.slots.some(s => !index.pages.includes(s.id) && this.dirtyPages.has(s.id))) await this.flush();
    const old = new Map(moved ? [] : this.slots.map(s => [s.id, s] as const));
    const slots = await Promise.all(index.pages.map(id => old.get(id) ?? this.loadSlot(id)));
    if (this.closed) return;
    this.index = index;
    this.slots = slots;
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
    const slot: PageSlot = { id, path: this.pagePath(id), size: page.size, page, text: null, error: null };
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
    const slot: PageSlot = { id, path: this.pagePath(id), size: copy.size, page: copy, text: null, error: null };
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
    if (!del) return out;
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
}

// The notebook library (#73): ink notes as cards, grouped by subject, so a note is reached and
// managed like Notability's subjects and notes, never as a markdown file beside a folder of SVGs.
// A subject is a folder (library-model.ts); the notes folder and the folders inside it show even
// without notes, other folders when they hold notes, the vault root as "Unfiled". A card shows
// the note's first page (thumbs.ts: drawn lazily, only for cards in view, cached by the page
// file's mtime), its name, page count and last change. A tap opens the note in the ink view; a
// long press, a right-click or the ⋯ button opens its actions (note-actions.ts): Rename (inline),
// Move to subject…, Duplicate, Delete, Export as PDF, Copy embed of first page. Subjects collapse
// from their header, open with a tap on their name (new notes and imported PDFs then go there),
// and are renamed or deleted (when empty of notes) from their ⋯ menu; "New subject" makes a folder
// in the notes folder. The list follows vault changes (NoteCatalog), except while a name is edited.
//
// Every control is a button or an input and nothing here blocks touches, so the Pencil and
// fingers tap and scroll it as any Obsidian view (#53).
import { FuzzySuggestModal, ItemView, Menu, Notice, setIcon, TFile, TFolder, type App, type WorkspaceLeaf } from 'obsidian';
import type { CatalogNote, NoteCatalog } from './catalog';
import { groupNotes, modifiedLabel, pagesLabel, subjectLabel, UNFILED, type Subject } from './library-model';
import { copyFirstPageEmbed, duplicateNote, exportNote, moveNote, renameNote, trashNote } from './note-actions';
import { cleanName } from './names';
import { ensureFolder } from './new-note';
import { dirOf, join, within } from './paths';
import { THUMB_WIDTH, type ThumbCache } from './thumbs';
import { confirm, NameModal } from './template-chooser';
import { VIEW_TYPE_INK } from './takeover';
import { LONG_PRESS_MS } from './toolbar';
import type { NotebookSettings } from '../settings';

export const VIEW_TYPE_LIBRARY = 'notebook-library';
/** Movement that cancels a long press, in CSS px. */
const PRESS_SLOP = 10;
/** Thumbnails kept in memory for re-renders (as data URLs, which need no revoking while an image may still load one). */
const MAX_URLS = 300;

/** A PNG's bytes as a data URL. */
function pngDataUrl(bytes: ArrayBuffer): string {
  const a = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(a.subarray(i, i + 0x8000)));
  return 'data:image/png;base64,' + btoa(s);
}

/** What the library needs of the plugin. */
export interface LibraryHost {
  settings: NotebookSettings;
  catalog: NoteCatalog;
  thumbs: ThumbCache;
  /** Creates and opens a note in `folder` (#72). */
  newInkNote(folder?: string): Promise<string | null>;
  /** Asks for a PDF and imports it as a note into `folder` (#14). */
  importPdf(folder?: string): void;
  /** Subjects collapsed in the library, kept while Obsidian runs. */
  collapsed: Set<string>;
}

/** Counters for tests. */
export interface LibraryStats {
  /** Lists drawn, and the time of the last one (catalog read and DOM), in ms. */
  renders: number;
  renderMs: number;
  /** Thumbnails shown (cached or drawn). */
  thumbs: number;
}

export class LibraryView extends ItemView {
  /** The subject (folder) open in the library, or null for all subjects. */
  subject: string | null = null;
  query = '';
  notes: CatalogNote[] = [];
  stats: LibraryStats = { renders: 0, renderMs: 0, thumbs: 0 };
  /** Resolves when the list reflects the vault as of the last refresh asked for. */
  ready: Promise<void> = Promise.resolve();
  private headerEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private backEl!: HTMLButtonElement;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private observer: IntersectionObserver | null = null;
  /** Thumbnails as data URLs, by page path, mtime and theme, most recently used last. */
  private urls = new Map<string, string>();
  /** While a card's name is edited, refreshes wait (they would rebuild the card). */
  private editing = false;
  private stale = false;
  private stop: (() => void) | null = null;
  /** Set by a long press so the click ending it doesn't also open the note. */
  private pressed = false;

  constructor(leaf: WorkspaceLeaf, private host: LibraryHost) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_LIBRARY;
  }

  getDisplayText() {
    return 'Notebook library';
  }

  getIcon() {
    return 'library';
  }

  getState(): Record<string, unknown> {
    return { subject: this.subject };
  }

  async setState(state: unknown, result: Parameters<ItemView['setState']>[1]) {
    const s = state as { subject?: unknown } | null;
    if (s && (typeof s.subject === 'string' || s.subject === null)) this.subject = s.subject;
    await super.setState(state, result);
    this.render();
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('nb-library');
    this.headerEl = root.createDiv({ cls: 'nb-lib-header' });
    const top = this.headerEl.createDiv({ cls: 'nb-lib-top' });
    this.backEl = this.button(top, 'nb-lib-back', 'chevron-left', 'All subjects', () => this.openSubject(null));
    this.titleEl = top.createDiv({ cls: 'nb-lib-title' });
    const actions = top.createDiv({ cls: 'nb-lib-actions' });
    this.button(actions, 'nb-lib-new', 'plus', 'New note', () => void this.host.newInkNote(this.folderForNew()));
    this.button(actions, 'nb-lib-import', 'file-down', 'Import PDF as ink note', () => this.host.importPdf(this.folderForNew()));
    this.button(actions, 'nb-lib-new-subject', 'folder-plus', 'New subject', () => this.newSubject());
    this.searchEl = this.headerEl.createEl('input', { type: 'search', cls: 'nb-lib-search', attr: { placeholder: 'Search notes', 'aria-label': 'Search notes' } });
    this.searchEl.addEventListener('input', () => {
      this.query = this.searchEl.value;
      this.render();
    });
    this.listEl = root.createDiv({ cls: 'nb-lib-list' });
    this.observer = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) void this.showThumb(e.target as HTMLElement);
    }, { root: this.listEl, rootMargin: '200px 0px' });
    this.stop = this.host.catalog.onChange(() => this.refresh());
    await this.refresh();
  }

  async onClose() {
    this.stop?.();
    this.observer?.disconnect();
    this.urls.clear();
  }

  /** The folder new notes and imports go in: the open subject, else the notes folder. */
  folderForNew(): string {
    return this.subject ?? this.host.settings.notesFolder;
  }

  /** Reads the notes again and redraws (deferred while a name is being edited). */
  refresh(): Promise<void> {
    if (this.editing) {
      this.stale = true;
      return this.ready;
    }
    this.ready = (async () => {
      const t0 = performance.now();
      this.notes = await this.host.catalog.notes();
      this.render();
      this.stats.renderMs = performance.now() - t0;
    })();
    return this.ready;
  }

  /** Opens a subject (null: all subjects). */
  openSubject(folder: string | null) {
    this.subject = folder;
    this.app.workspace.requestSaveLayout?.();
    this.render();
    this.listEl.scrollTop = 0;
  }

  // ---- the list

  /** Folders shown as subjects without notes: the notes folder and the folders in it that aren't page folders. */
  private emptySubjects(): string[] {
    const notesFolder = this.host.settings.notesFolder;
    const pages = new Set(this.notes.map(n => n.pagesAt).filter((p): p is string => !!p));
    const templates = this.host.settings.templatesFolder;
    const out: string[] = [];
    const root = this.app.vault.getAbstractFileByPath(notesFolder || '/');
    if (!(root instanceof TFolder)) return out;
    const walk = (f: TFolder) => {
      if (f.path !== '/' && f.path !== '' && ([...pages].some(p => within(f.path, p)) || within(f.path, templates) || f.name.startsWith('.'))) return;
      // The vault root is Unfiled, listed only with notes in it.
      if (!f.isRoot()) out.push(f.path);
      for (const c of f.children) if (c instanceof TFolder) walk(c);
    };
    if (notesFolder) walk(root);
    return out;
  }

  private subjects(): Subject<CatalogNote>[] {
    const all = groupNotes(this.notes, this.emptySubjects(), this.host.settings.notesFolder, this.query);
    if (this.subject === null) return all;
    const open = all.filter(s => s.folder === this.subject);
    if (!open.length && !this.query && !(this.app.vault.getAbstractFileByPath(this.subject) instanceof TFolder) && this.subject !== '') {
      this.subject = null; // the open subject was renamed or deleted
      return all;
    }
    return open;
  }

  render() {
    if (!this.listEl) return;
    this.stats.renders++;
    this.observer?.disconnect();
    const subjects = this.subjects();
    const label = this.subject === null ? 'Notebook' : subjectLabel(this.subject, this.host.settings.notesFolder);
    this.titleEl.setText(label);
    this.backEl.toggleClass('is-hidden', this.subject === null);
    this.listEl.empty();
    if (!subjects.length) {
      this.listEl.createDiv({ cls: 'nb-lib-empty', text: this.query ? 'No notes match.' : 'No notes yet. Tap + to start one.' });
      return;
    }
    for (const s of subjects) this.renderSubject(s);
  }

  private renderSubject(s: Subject<CatalogNote>) {
    const collapsed = this.host.collapsed.has(s.folder) && this.subject === null && !this.query;
    const section = this.listEl.createDiv({ cls: 'nb-lib-subject' + (collapsed ? ' is-collapsed' : '') });
    section.dataset.folder = s.folder;
    const header = section.createDiv({ cls: 'nb-lib-subject-header' });
    if (this.subject === null) {
      const c = this.button(header, 'nb-lib-collapse', collapsed ? 'chevron-right' : 'chevron-down', collapsed ? `Show ${s.label}` : `Hide ${s.label}`, () => {
        if (this.host.collapsed.has(s.folder)) this.host.collapsed.delete(s.folder);
        else this.host.collapsed.add(s.folder);
        this.render();
      });
      c.setAttribute('aria-expanded', String(!collapsed));
    }
    const name = header.createEl('button', { cls: 'nb-lib-subject-name', attr: { type: 'button' } });
    name.createSpan({ cls: 'nb-lib-subject-label', text: s.label });
    name.createSpan({ cls: 'nb-lib-subject-count', text: String(s.notes.length) });
    name.addEventListener('click', () => this.openSubject(s.folder));
    this.button(header, 'nb-lib-subject-new', 'plus', `New note in ${s.label}`, () => void this.host.newInkNote(s.folder));
    const more = this.button(header, 'nb-lib-subject-more', 'more-horizontal', `${s.label}: more`, e => this.subjectMenu(s, e));
    more.setAttribute('aria-haspopup', 'menu');
    if (collapsed) return;
    const cards = section.createDiv({ cls: 'nb-lib-cards' });
    if (!s.notes.length) cards.createDiv({ cls: 'nb-lib-empty', text: 'No notes in this subject yet.' });
    for (const n of s.notes) this.renderCard(cards, n);
  }

  private renderCard(parent: HTMLElement, n: CatalogNote) {
    const card = parent.createDiv({ cls: 'nb-lib-card', attr: { role: 'button', tabindex: '0', 'aria-label': `Open ${n.name}` } });
    card.dataset.path = n.path;
    const thumb = card.createDiv({ cls: 'nb-lib-thumb' });
    thumb.style.width = `${THUMB_WIDTH}px`;
    thumb.dataset.path = n.path;
    const info = card.createDiv({ cls: 'nb-lib-info' });
    info.createDiv({ cls: 'nb-lib-name', text: n.name });
    const meta = [pagesLabel(n.pages), modifiedLabel(n.mtime, Date.now())].filter(Boolean).join(' · ');
    info.createDiv({ cls: 'nb-lib-meta', text: meta });
    const more = this.button(card, 'nb-lib-more', 'more-horizontal', `${n.name}: actions`, e => {
      e.stopPropagation();
      this.cardMenu(n, e);
    });
    more.setAttribute('aria-haspopup', 'menu');
    card.addEventListener('click', e => {
      if (this.pressed) {
        this.pressed = false;
        return;
      }
      if ((e.target as Element).closest('button, input')) return;
      void this.openNote(n.file);
    });
    card.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
        e.preventDefault();
        void this.openNote(n.file);
      }
    });
    card.addEventListener('contextmenu', e => {
      e.preventDefault(); // iOS's own long-press menu, and the desktop's right-click
      if (!this.pressed) this.cardMenu(n, e);
    });
    this.longPress(card, (x, y) => this.cardMenu(n, { x, y }));
    this.observer?.observe(thumb);
    const url = this.urls.get(this.thumbKey(n));
    if (url) this.setThumb(thumb, url);
  }

  /** A press of LONG_PRESS_MS that doesn't move calls `run` (and the click ending it is ignored). */
  private longPress(el: HTMLElement, run: (x: number, y: number) => void) {
    let timer = 0, x = 0, y = 0;
    const cancel = () => window.clearTimeout(timer);
    el.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest('button, input')) return;
      cancel();
      this.pressed = false;
      x = e.clientX;
      y = e.clientY;
      timer = window.setTimeout(() => {
        this.pressed = true;
        run(x, y);
      }, LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', e => {
      if (Math.hypot(e.clientX - x, e.clientY - y) > PRESS_SLOP) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', cancel);
  }

  // ---- thumbnails

  private pagePath = (n: CatalogNote) => (n.pagesAt && n.firstPage ? `${n.pagesAt}/${n.firstPage}.svg` : null);

  private pageMtime(n: CatalogNote): number {
    const path = this.pagePath(n), f = path ? this.app.vault.getAbstractFileByPath(path) : null;
    return f instanceof TFile ? f.stat.mtime : 0;
  }

  private thumbKey = (n: CatalogNote) => `${this.pagePath(n)}@${this.pageMtime(n)}@${document.body.hasClass('theme-dark') ? 'd' : 'l'}`;

  /** Shows the card's thumbnail: from memory, the cache, or drawn (one at a time, never while a pen is down). */
  private async showThumb(el: HTMLElement) {
    const n = this.notes.find(x => x.path === el.dataset.path);
    if (!n || el.dataset.shown) return;
    const path = this.pagePath(n);
    if (!path) {
      el.addClass('is-empty');
      return;
    }
    const key = this.thumbKey(n), mtime = this.pageMtime(n);
    el.dataset.shown = 'loading';
    // A refresh rebuilds the cards while a thumbnail is on its way: they share the one load.
    let job = this.loading.get(key);
    if (!job) {
      job = this.loadThumb(key, path, mtime);
      this.loading.set(key, job);
      void job.then(() => this.loading.delete(key));
    }
    const url = await job;
    if (!url) {
      el.addClass('is-error');
      return;
    }
    if (el.isConnected) this.setThumb(el, url);
  }

  /** Thumbnail loads under way, by key. */
  private loading = new Map<string, Promise<string | null>>();

  /** The thumbnail's URL: kept, cached, or drawn. */
  private async loadThumb(key: string, path: string, mtime: number): Promise<string | null> {
    let url = this.urls.get(key);
    if (url) return url;
    const bytes = await this.host.thumbs.cached(path, mtime) ?? await this.host.thumbs.draw(path, mtime);
    if (!bytes) return null;
    url = pngDataUrl(bytes);
    this.urls.set(key, url);
    while (this.urls.size > MAX_URLS) this.urls.delete(this.urls.keys().next().value!);
    return url;
  }

  private setThumb(el: HTMLElement, url: string) {
    el.empty();
    el.createEl('img', { cls: 'nb-lib-thumb-img', attr: { src: url, alt: '', draggable: 'false' } });
    el.dataset.shown = 'yes';
    this.stats.thumbs++;
  }

  /** Whether every card in view shows its thumbnail (for tests). */
  get thumbsDone(): boolean {
    const box = this.listEl.getBoundingClientRect();
    return [...this.listEl.querySelectorAll<HTMLElement>('.nb-lib-thumb')].every(el => {
      const r = el.getBoundingClientRect();
      return r.bottom < box.top || r.top > box.bottom || el.dataset.shown === 'yes' || el.hasClass('is-empty') || el.hasClass('is-error');
    });
  }

  // ---- notes

  async openNote(file: TFile) {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_INK, state: { file: file.path }, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** The card's actions, as a menu at a pointer event or a point. */
  cardMenu(n: CatalogNote, at: MouseEvent | { x: number; y: number }) {
    const menu = new Menu();
    menu.addItem(i => i.setTitle('Rename').setIcon('pencil').onClick(() => this.startRename(n)));
    menu.addItem(i => i.setTitle('Move to subject…').setIcon('folder-input').onClick(() => this.moveTo(n)));
    menu.addItem(i => i.setTitle('Duplicate').setIcon('copy').onClick(() => void this.duplicate(n)));
    menu.addItem(i => i.setTitle('Export as PDF').setIcon('file-output').onClick(() => void exportNote(this.app, n.file)));
    menu.addItem(i => i.setTitle('Copy embed of first page').setIcon('link').onClick(() => void copyFirstPageEmbed(n.pagesAt, n.firstPage)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('Delete').setIcon('trash-2').onClick(() => void this.remove(n)));
    if (at instanceof MouseEvent) menu.showAtMouseEvent(at);
    else menu.showAtPosition(at);
  }

  /** Turns the card's name into a text field; Enter or leaving it renames, Escape keeps the name. */
  startRename(n: CatalogNote) {
    const card = this.cardEl(n.path), name = card?.querySelector<HTMLElement>('.nb-lib-name');
    if (!card || !name || this.editing) return;
    this.editing = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'nb-lib-rename';
    input.setAttribute('aria-label', 'Note name');
    input.setAttribute('enterkeyhint', 'done');
    input.value = n.name;
    name.replaceWith(input);
    let done = false;
    const finish = async (keep: boolean) => {
      if (done) return;
      done = true;
      const value = input.value;
      input.replaceWith(name);
      if (!keep && value.trim() && value !== n.name) {
        const why = await renameNote(this.app, n.file, value);
        if (why) new Notice(why);
      }
      this.editing = false;
      if (this.stale || !keep) {
        this.stale = false;
        await this.refresh();
      }
    };
    input.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void finish(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void finish(true);
      }
    });
    input.addEventListener('blur', () => void finish(false));
    input.addEventListener('click', e => e.stopPropagation());
    input.focus();
    input.select();
  }

  private cardEl = (path: string) => [...this.listEl.querySelectorAll<HTMLElement>('.nb-lib-card')].find(c => c.dataset.path === path) ?? null;

  /** Asks for a subject and moves the note there. */
  moveTo(n: CatalogNote) {
    const here = n.subject, notesFolder = this.host.settings.notesFolder;
    const folders = new Set<string>([...this.emptySubjects(), ...this.notes.map(x => x.subject), '']);
    const items = [...folders].filter(f => f !== here).map(folder => ({ folder, label: subjectLabel(folder, notesFolder) }));
    items.sort((a, b) => (a.folder === '' ? 1 : 0) - (b.folder === '' ? 1 : 0) || a.label.localeCompare(b.label));
    new SubjectChooser(this.app, items, async folder => {
      const why = await moveNote(this.app, n.file, folder);
      if (why) new Notice(why);
    }).open();
  }

  private async duplicate(n: CatalogNote) {
    try {
      const path = await duplicateNote(this.app, n.file, n.pagesAt);
      new Notice(`Duplicated as ${path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')}`);
    } catch (e) {
      new Notice(`Couldn't duplicate ${n.name}: ${(e as Error).message}`);
    }
  }

  private async remove(n: CatalogNote) {
    const ok = await confirm(this.app, {
      title: 'Delete note', ok: 'Delete', warning: true, cls: 'nb-lib-delete-confirm',
      text: `Delete "${n.name}" and its ${pagesLabel(n.pages)}? They go to Obsidian's trash.`,
    });
    if (!ok) return;
    const others = new Set(this.notes.filter(x => x.path !== n.path && x.pagesAt).map(x => x.pagesAt!));
    try {
      await trashNote(this.app, n.file, n.pagesAt, n.pageIds, others);
    } catch (e) {
      new Notice(`Couldn't delete ${n.name}: ${(e as Error).message}`);
    }
  }

  // ---- subjects

  newSubject() {
    const notesFolder = this.host.settings.notesFolder;
    new NameModal(this.app, 'New subject', '', 'Create', async name => {
      if (!name.trim()) return;
      const path = join(notesFolder, cleanName(name));
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice(`${subjectLabel(path, notesFolder)} already exists`);
        return;
      }
      try {
        await ensureFolder(this.app, path);
        this.host.catalog.changed();
      } catch (e) {
        new Notice(`Couldn't create the subject: ${(e as Error).message}`);
      }
    }).open();
  }

  private subjectMenu(s: Subject, e: MouseEvent) {
    const menu = new Menu();
    menu.addItem(i => i.setTitle('New note here').setIcon('plus').onClick(() => void this.host.newInkNote(s.folder)));
    // The vault root and the notes folder itself (a setting) aren't renamed or deleted here.
    if (s.folder && s.folder !== this.host.settings.notesFolder) {
      menu.addItem(i => i.setTitle('Rename subject…').setIcon('pencil').onClick(() => this.renameSubject(s)));
      menu.addItem(i => i.setTitle('Delete subject').setIcon('trash-2').onClick(() => void this.deleteSubject(s)));
    }
    menu.showAtMouseEvent(e);
  }

  renameSubject(s: Subject) {
    const folder = this.app.vault.getAbstractFileByPath(s.folder);
    if (!(folder instanceof TFolder)) return;
    new NameModal(this.app, 'Rename subject', folder.name, 'Rename', async name => {
      const base = cleanName(name);
      if (base === folder.name) return;
      const to = join(dirOf(folder.path), base);
      if (this.app.vault.getAbstractFileByPath(to)) {
        new Notice(`${base} already exists`);
        return;
      }
      const open = this.subject === s.folder;
      try {
        await this.app.fileManager.renameFile(folder, to);
        if (open) this.subject = to;
        this.host.catalog.changed();
      } catch (e) {
        new Notice(`Couldn't rename the subject: ${(e as Error).message}`);
      }
    }).open();
  }

  /** Deletes a subject's folder (to the trash) if it holds no notes; otherwise says how many it holds. */
  async deleteSubject(s: Subject) {
    const n = this.notes.filter(x => within(x.subject, s.folder)).length;
    if (n) {
      new Notice(`${s.label} holds ${n} note${n === 1 ? '' : 's'}; move or delete ${n === 1 ? 'it' : 'them'} first.`);
      return;
    }
    const folder = this.app.vault.getAbstractFileByPath(s.folder);
    if (!(folder instanceof TFolder)) return;
    const ok = await confirm(this.app, { title: 'Delete subject', ok: 'Delete', warning: true, cls: 'nb-lib-delete-confirm', text: `Delete the subject "${s.label}"? Its folder goes to Obsidian's trash.` });
    if (!ok) return;
    if (this.subject === s.folder) this.subject = null;
    await this.app.fileManager.trashFile(folder);
    this.host.catalog.changed();
  }

  private button(parent: HTMLElement, cls: string, icon: string, label: string, fn: (e: MouseEvent) => void): HTMLButtonElement {
    const b = parent.createEl('button', { cls: `nb-lib-button ${cls}`, attr: { type: 'button', 'aria-label': label, title: label } });
    setIcon(b, icon);
    b.addEventListener('click', fn);
    return b;
  }
}

/** Chooses a subject to move a note to. */
class SubjectChooser extends FuzzySuggestModal<{ folder: string; label: string }> {
  constructor(app: App, private items: { folder: string; label: string }[], private onChoose: (folder: string) => void) {
    super(app);
    this.setPlaceholder('Move to subject…');
  }

  getItems() {
    return this.items;
  }

  getItemText(item: { folder: string; label: string }) {
    return item.folder === '' ? `${UNFILED} (vault root)` : item.label;
  }

  onChooseItem(item: { folder: string; label: string }) {
    this.onChoose(item.folder);
  }
}

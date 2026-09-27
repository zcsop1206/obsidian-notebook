// The ink view: an ink note's pages stacked like paper in a native scrolling container, with
// the pen (input.ts) and its provisional controls, autosave and reloading after changes on disk. The note's data lives in
// NoteStore; page bitmaps in PageBitmap; this file ties them to Obsidian and the DOM.
import { FileView, Notice, TAbstractFile, TFile, TFolder, type App, type WorkspaceLeaf } from 'obsidian';
import { newStrokeId } from '../format/ids';
import { isInkNote } from '../format/note';
import type { Page } from '../format/page';
import type { Template } from '../format/template';
import { parseTemplate, templateName } from '../format/template';
import type { Stroke } from '../format/page';
import { listenForUndoTaps } from './gestures';
import { History } from './history';
import { blockStylusTouch, newPenStats, PenInput, penStatsLines, type NewStroke, type PageTarget, type PenStats, type StrokeStyle } from './input';
import { COLOR_PRESETS, DEFAULT_PEN, nextColor, nextSize, SIZE_PRESETS, SIZE_STEP, withPen, type PenSettings } from './pen';
import {
  DEFAULT_HIGHLIGHTER, HIGHLIGHTER_COLORS, HIGHLIGHTER_SIZES, nextHighlighterColor, nextHighlighterSize, withHighlighter,
  type HighlighterSettings, type ToolKind,
} from './pen';
import { layoutPages, MARGIN, mostVisiblePage, pageAtY, pagesInBand, type Layout } from './layout';
import { currentTheme, PageBitmap, releaseScratch, strokeColor, TemplateImages, type Theme } from './renderer';
import { NoteStore, type NoteFiles, type PageSlot, type TemplatesBefore } from './store';
import { VIEW_TYPE_INK } from './takeover';
import { TemplateChooser } from './template-chooser';

/** How long the view waits after a resize before redrawing bitmaps at the new size. */
const RESIZE_DELAY = 150;

/** Counters for tests and debugging. */
export interface InkStats {
  /** Pages of the open note whose file was read (or that were added here). */
  pagesLoaded: number;
  /** Pages that currently have a bitmap. */
  pagesRendered: number;
  /** Time of the last full page render, in ms. */
  lastRenderMs: number;
  /** Time from starting to load the note to its visible pages drawn, in ms. */
  openMs: number;
  /** File writes completed by this view. */
  saves: number;
  /** Pen input measurements (input.ts). */
  pen: PenStats;
}

interface PageView {
  slot: PageSlot;
  el: HTMLElement;
  bitmap: PageBitmap | null;
}

/** NoteStore's file access through the vault API, so Obsidian's embeds and caches follow. */
export function vaultFiles(app: App): NoteFiles {
  const vault = app.vault;
  const ensureFolder = async (path: string) => {
    let acc = '';
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      if (vault.getAbstractFileByPath(acc)) continue;
      try {
        await vault.createFolder(acc);
      } catch (e) {
        if (!vault.getAbstractFileByPath(acc)) throw e; // else another write created it first
      }
    }
  };
  return {
    async read(path) {
      const f = vault.getAbstractFileByPath(path);
      return f instanceof TFile ? vault.read(f) : null;
    },
    async write(path, text) {
      const f = vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        await vault.modify(f, text);
        return;
      }
      const slash = path.lastIndexOf('/');
      if (slash > 0) await ensureFolder(path.slice(0, slash));
      await vault.create(path, text);
    },
    list(folder) {
      const f = vault.getAbstractFileByPath(folder);
      return f instanceof TFolder ? f.children.map(c => c.name) : [];
    },
  };
}

export class InkView extends FileView {
  stats: InkStats = { pagesLoaded: 0, pagesRendered: 0, lastRenderMs: 0, openMs: 0, saves: 0, pen: newPenStats() };
  /** The settings of the next stroke. */
  pen: PenSettings = { ...DEFAULT_PEN };
  /** The highlighter's colour and size (the pen's `tool` says which one is in use). */
  highlighter: HighlighterSettings = { ...DEFAULT_HIGHLIGHTER };
  store: NoteStore | null = null;
  /** The open note's undo history (#8): cleared when the note closes or another is loaded. */
  readonly history = new History(() => this.renderHistory());
  private scroller!: HTMLElement;
  private pagesEl!: HTMLElement;
  /** The "Add page" controls below the last page. */
  private footer!: HTMLElement;
  private messageEl!: HTMLElement;
  private input!: PenInput;
  /** The provisional pen strip (#10 replaces it with the toolbar). */
  private strip!: HTMLElement;
  private statsEl!: HTMLElement;
  private pages: PageView[] = [];
  private layout: Layout | null = null;
  private theme: Theme = currentTheme();
  private templates = new TemplateImages();
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer = 0;
  private updateFrame = 0;
  private pumpFrame = 0;
  private width = 0;
  private loads = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_INK;
  }

  getIcon() {
    return 'pencil';
  }

  getDisplayText() {
    return this.file ? this.file.basename : 'Ink note';
  }

  canAcceptExtension(extension: string) {
    return extension === 'md';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('nb-ink-view');
    this.strip = root.createDiv({ cls: 'nb-ink-strip' });
    this.buildStrip();
    this.buildHistoryGroup();
    this.scroller = root.createDiv({ cls: 'nb-ink-scroll' });
    this.pagesEl = this.scroller.createDiv({ cls: 'nb-ink-pages' });
    this.messageEl = this.scroller.createDiv({ cls: 'nb-ink-message' });
    this.messageEl.hide();
    this.footer = this.pagesEl.createDiv({ cls: 'nb-ink-footer' });
    this.footer.hide();
    this.footer.createEl('button', { cls: 'nb-ink-add', text: 'Add page' }).addEventListener('click', () => this.addPage());
    this.footer.createEl('button', { cls: 'nb-ink-add-with', text: 'Add page with template…' })
      .addEventListener('click', () => this.chooseTemplate('add'));

    this.statsEl = root.createDiv({ cls: 'nb-ink-stats' });
    this.statsEl.hide();

    this.input = new PenInput({
      pageAt: target => this.pageAt(target),
      pen: () => this.pen,
      drawColor: color => strokeColor({ color }, this.theme),
      commit: (target, stroke) => this.commit(target, stroke),
      statsChanged: () => this.renderStats(),
      strokeStyle: () => this.strokeStyle(),
    }, (type, fn, options) => this.registerDomEvent(this.pagesEl, type, fn, options), this.stats.pen);
    // A Pencil drag anywhere in the view, on a page or not, never scrolls it; fingers do. The
    // rules are in blockStylusTouch.
    this.registerDomEvent(root, 'touchstart', e => blockStylusTouch(e), { passive: false });
    this.registerDomEvent(root, 'touchmove', e => blockStylusTouch(e), { passive: false });
    // Two fingers tapped undo, three redo; passive, so finger scrolling is untouched.
    listenForUndoTaps((type, fn, options) => this.registerDomEvent(this.pagesEl, type, fn, options), () => this.undo(), () => this.redo());
    // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z when focus is in the view, if the commands' hotkeys didn't take them.
    this.registerDomEvent(this.containerEl, 'keydown', e => this.historyKey(e));

    this.registerDomEvent(this.scroller, 'scroll', () => {
      this.input.viewMoved();
      this.requestUpdate();
    }, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.resized());
    this.resizeObserver.observe(this.scroller);

    this.addAction('file-text', 'Open as markdown', () => void this.openAsMarkdown());
    // Until #10's toolbar: also reachable from the view header on the iPad.
    this.addAction('layers', 'Change template of all pages', () => this.chooseTemplate('all'));
    this.addAction('layout-template', 'Change template of this page', () => this.chooseTemplate('page'));

    // Save at once when the app goes to the background or the page is torn down: on the iPad
    // that's the last chance before iOS may kill Obsidian.
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.save();
    });
    this.registerDomEvent(window, 'pagehide', () => void this.save());
    this.registerEvent(this.app.workspace.on('css-change', () => this.themeChanged()));

    const vault = this.app.vault;
    const onDisk = (kind: 'modify' | 'create' | 'delete') => (file: TAbstractFile) => {
      if (file instanceof TFile) void this.store?.external(file.path, kind);
    };
    this.registerEvent(vault.on('modify', onDisk('modify')));
    this.registerEvent(vault.on('create', onDisk('create')));
    this.registerEvent(vault.on('delete', onDisk('delete')));
    this.registerEvent(vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile) || !this.store) return;
      void this.store.external(oldPath, 'delete');
      void this.store.external(file.path, 'create');
    }));
  }

  async onClose() {
    await this.closeNote();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.clearTimeout(this.resizeTimer);
    cancelAnimationFrame(this.updateFrame);
    cancelAnimationFrame(this.pumpFrame);
    this.input.destroy();
    this.templates.clear();
    releaseScratch();
    await super.onClose();
  }

  async onLoadFile(file: TFile) {
    const load = ++this.loads;
    const t0 = performance.now();
    await this.closeNote();
    let text: string;
    try {
      text = await this.app.vault.read(file);
    } catch (e) {
      this.showMessage(`Couldn't read ${file.path}: ${(e as Error).message}`);
      return;
    }
    if (load !== this.loads) return;
    if (!isInkNote(text)) {
      // Not an ink note (Obsidian can load any markdown file into this view): show it as markdown.
      this.showMessage(`${file.path} is not an ink note.`);
      window.setTimeout(() => void this.leaf.setViewState({ type: 'markdown', state: { file: file.path } }), 0);
      return;
    }
    const store: NoteStore = new NoteStore(vaultFiles(this.app), file.path, file.basename, {
      pageChanged: slot => this.store === store && this.pageChanged(slot),
      indexChanged: () => this.store === store && this.indexChanged(),
      notice: message => new Notice(message),
      saved: () => this.stats.saves++,
    });
    try {
      await store.load(text);
    } catch (e) {
      if (load === this.loads) this.showMessage(`Couldn't open ${file.path} as an ink note: ${(e as Error).message}`);
      return;
    }
    if (load !== this.loads) return;
    this.store = store;
    this.theme = currentTheme();
    this.messageEl.hide();
    this.buildPages();
    this.relayout();
    this.update();
    this.stats.openMs = performance.now() - t0;
  }

  async onUnloadFile(file: TFile) {
    await this.closeNote();
    await super.onUnloadFile(file);
  }

  async onRename(file: TFile) {
    this.store?.renamed(file.path);
    await super.onRename(file);
  }

  /** Writes everything changed now. */
  save(): Promise<void> {
    return this.store ? this.store.flush() : Promise.resolve();
  }

  async openAsMarkdown() {
    const file = this.file;
    if (!file) return;
    await this.save();
    await this.leaf.setViewState({ type: 'markdown', state: { file: file.path, openAsMarkdown: true }, active: true });
  }

  /** Saves and forgets the open note. */
  private async closeNote() {
    const store = this.store;
    if (!store) return;
    this.store = null;
    this.history.clear();
    this.input.cancel();
    const saved = store.flush();
    store.close();
    this.clearPages();
    this.layout = null;
    await saved;
  }

  private showMessage(text: string) {
    this.clearPages();
    this.messageEl.setText(text);
    this.messageEl.show();
  }

  // ---- pages

  private clearPages() {
    for (const pv of this.pages) {
      pv.bitmap?.release();
      pv.el.remove();
    }
    this.pages = [];
    this.footer.hide();
    this.pagesEl.style.height = '';
    this.updateStats();
  }

  private buildPages() {
    this.clearPages();
    this.pages = this.store!.slots.map(slot => this.makePage(slot));
    this.footer.show();
    this.updateStats();
  }

  private makePage(slot: PageSlot): PageView {
    const el = this.pagesEl.createDiv({ cls: 'nb-ink-page' });
    el.dataset.page = slot.id;
    this.pagesEl.insertBefore(el, this.footer); // pages before the "Add page" controls
    const pv: PageView = { slot, el, bitmap: null };
    this.showError(pv);
    return pv;
  }

  /** Shows or clears the placeholder of a page that can't be read. */
  private showError(pv: PageView) {
    const error = pv.slot.error;
    pv.el.toggleClass('is-error', !!error);
    pv.el.querySelector('.nb-ink-error')?.remove();
    if (error) {
      this.dropBitmap(pv);
      pv.el.createDiv({ cls: 'nb-ink-error', text: error });
    }
  }

  /** Positions page elements for the current width. Returns false if the view has no width yet. */
  private relayout(): boolean {
    const store = this.store;
    const width = this.scroller.clientWidth;
    if (!store || width <= 0) return false;
    const old = this.layout;
    let anchor: { index: number; at: number } | null = null;
    if (old && old.pages.length) {
      const index = pageAtY(old, this.scroller.scrollTop);
      const box = old.pages[index];
      anchor = { index, at: (this.scroller.scrollTop - box.top) / box.height };
    }
    const layout = layoutPages(this.pages.map(pv => pv.slot.size), width, store.paperSize);
    this.layout = layout;
    this.width = width;
    this.pagesEl.style.height = `${layout.height}px`;
    this.pages.forEach((pv, i) => {
      const b = layout.pages[i], s = pv.el.style;
      s.top = `${b.top}px`;
      s.left = `${b.left}px`;
      s.width = `${b.width}px`;
      s.height = `${b.height}px`;
    });
    this.footer.style.top = `${layout.footerTop}px`;
    if (anchor && old && old.scale !== layout.scale && anchor.index < layout.pages.length) {
      const box = layout.pages[anchor.index];
      this.scroller.scrollTop = box.top + anchor.at * box.height;
    }
    return true;
  }

  private resized() {
    const width = this.scroller.clientWidth;
    if (!this.store) return;
    if (width === this.width && this.layout) {
      this.requestUpdate(); // only the height changed
      return;
    }
    if (!this.relayout()) return;
    // Bitmaps stretch with their page until they're redrawn at the new size.
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      for (const pv of this.pages) if (pv.bitmap) this.renderPage(pv);
      this.update();
    }, RESIZE_DELAY);
    this.update();
  }

  private requestUpdate() {
    if (!this.updateFrame) {
      this.updateFrame = requestAnimationFrame(() => {
        this.updateFrame = 0;
        this.update();
      });
    }
  }

  /** The pages to keep bitmaps for: the viewport and one page height either side. */
  private band(): { near: Set<number>; visible: number[] } {
    const layout = this.layout!;
    const top = this.scroller.scrollTop, height = this.scroller.clientHeight;
    const pageHeight = layout.pages.reduce((h, p) => Math.max(h, p.height), 0);
    return {
      near: new Set(pagesInBand(layout, top - pageHeight, top + height + pageHeight)),
      visible: pagesInBand(layout, top, top + height),
    };
  }

  /**
   * Drops bitmaps of pages far from the viewport, draws the visible pages now and the
   * pages near the viewport one per frame.
   */
  private update() {
    if (!this.store || !this.layout) return;
    const { near, visible } = this.band();
    this.pages.forEach((pv, i) => {
      if (!near.has(i)) this.dropBitmap(pv);
    });
    for (const i of visible) if (!this.pages[i].bitmap) this.renderPage(this.pages[i]);
    this.updateStats();
    this.pump();
  }

  private pump() {
    if (this.pumpFrame) return;
    this.pumpFrame = requestAnimationFrame(() => {
      this.pumpFrame = 0;
      if (!this.store || !this.layout) return;
      const { near, visible } = this.band();
      const mid = visible.length ? (visible[0] + visible[visible.length - 1]) / 2 : 0;
      const next = [...near]
        .filter(i => !this.pages[i].bitmap && !this.pages[i].slot.error)
        .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
      if (next === undefined) return;
      this.renderPage(this.pages[next]);
      this.updateStats();
      this.pump();
    });
  }

  /** Draws a page's bitmap from scratch, creating it at the page's current size if needed. */
  private renderPage(pv: PageView) {
    const store = this.store, layout = this.layout;
    if (!store || !layout) return;
    const page = store.page(pv.slot);
    if (!page) {
      this.showError(pv);
      return;
    }
    const box = layout.pages[this.pages.indexOf(pv)];
    if (!box) return;
    if (pv.bitmap && (pv.bitmap.cssWidth !== box.width || pv.bitmap.cssHeight !== box.height)) this.dropBitmap(pv);
    if (!pv.bitmap) {
      pv.bitmap = new PageBitmap(box.width, box.height);
      pv.el.insertBefore(pv.bitmap.canvas, pv.el.firstChild);
    }
    const t0 = performance.now();
    pv.bitmap.render(page, this.theme, this.template(pv, page));
    this.stats.lastRenderMs = performance.now() - t0;
  }

  /** The page's rasterised template, or null (then it's redrawn when the image is ready). */
  private template(pv: PageView, page: Page): HTMLImageElement | null {
    const c = pv.bitmap!.canvas;
    return this.templates.get(page.template, page.size, c.width, c.height, this.theme, () => {
      if (pv.bitmap && this.pages.includes(pv)) this.renderPage(pv);
    });
  }

  private dropBitmap(pv: PageView) {
    if (!pv.bitmap) return;
    pv.bitmap.release();
    pv.bitmap = null;
  }

  private updateStats() {
    this.stats.pagesRendered = this.pages.filter(pv => pv.bitmap).length;
    this.stats.pagesLoaded = this.store ? this.store.pagesLoaded : 0;
  }

  private themeChanged() {
    const theme = currentTheme();
    if (theme === this.theme) return;
    this.theme = theme;
    for (const pv of this.pages) if (pv.bitmap) this.renderPage(pv);
  }

  // ---- writing

  private pageAt(target: EventTarget | null): PageTarget | null {
    if (!this.store || !(target instanceof Element)) return null;
    const el = target.closest('.nb-ink-page');
    const pv = el && this.pages.find(p => p.el === el);
    if (!pv) return null;
    const page = this.store.page(pv.slot);
    if (!page) return null;
    return { key: pv, el: pv.el, size: page.size };
  }

  private commit(target: PageTarget, drawn: NewStroke) {
    const pv = target.key as PageView;
    const store = this.store;
    if (!store || !this.pages.includes(pv)) return;
    const page = store.page(pv.slot);
    if (!page) return;
    const stroke = { id: newStrokeId(page.strokes.map(s => s.id)), ...drawn };
    store.addStroke(pv.slot, stroke);
    if (pv.bitmap) pv.bitmap.addStroke(page, stroke, this.theme, this.template(pv, page));
    else this.renderPage(pv);
    this.updateStats();
    this.recordStrokes('Add stroke', pv.slot.id, [{ index: page.strokes.length - 1, stroke }], true);
  }

  // ---- pen settings and the provisional pen strip

  /**
   * Changes the pen for the next stroke. Sizes are clamped to 0.5-16 px in 0.5 px steps; an
   * unknown nib or a colour that isn't `#rrggbb` throws.
   */
  setPen(change: Partial<PenSettings>) {
    this.pen = withPen(this.pen, change);
    this.renderStrip();
    this.renderStats();
  }

  nextColor() {
    this.setPen({ color: nextColor(this.pen.color) });
  }

  nextSize() {
    this.setPen({ size: nextSize(this.pen.size) });
  }

  /**
   * PROVISIONAL (#10 replaces it with the toolbar): one small row with the nib toggle, the
   * eight colour swatches, the three sizes and a size stepper.
   */
  private buildStrip() {
    const strip = this.strip;
    strip.setAttribute('aria-label', 'Pen (provisional controls)');
    const button = (parent: HTMLElement, cls: string, text: string, label: string, fn: () => void) => {
      const b = parent.createEl('button', { cls: `nb-ink-control ${cls}`, text, attr: { 'aria-label': label, type: 'button' } });
      b.addEventListener('click', fn);
      return b;
    };
    const group = (cls: string) => strip.createDiv({ cls: `nb-ink-control nb-ink-group ${cls}` });
    const nibs = group('nb-ink-nibs');
    button(nibs, 'nb-ink-nib', 'Uniform', 'Uniform pen', () => this.setPen({ nib: 'uniform' })).dataset.nib = 'uniform';
    button(nibs, 'nb-ink-nib', 'Pressure', 'Pressure pen', () => this.setPen({ nib: 'pressure' })).dataset.nib = 'pressure';
    const colors = group('nb-ink-colors');
    for (const { color, name } of COLOR_PRESETS) {
      const b = button(colors, 'nb-ink-swatch', '', name, () => this.setPen({ color }));
      b.dataset.color = color;
      if (color === DEFAULT_PEN.color) b.addClass('is-default-ink');
      else b.style.backgroundColor = color;
    }
    const sizes = group('nb-ink-sizes');
    for (const size of SIZE_PRESETS) button(sizes, 'nb-ink-size', String(size), `Size ${size} px`, () => this.setPen({ size })).dataset.size = String(size);
    const stepper = group('nb-ink-stepper');
    button(stepper, 'nb-ink-step', '−', 'Thinner', () => this.setPen({ size: this.pen.size - SIZE_STEP })).dataset.step = '-1';
    stepper.createSpan({ cls: 'nb-ink-control nb-ink-size-value' });
    button(stepper, 'nb-ink-step', '+', 'Thicker', () => this.setPen({ size: this.pen.size + SIZE_STEP })).dataset.step = '1';
    strip.createSpan({ cls: 'nb-ink-control nb-ink-provisional', text: 'provisional' });
    this.buildToolGroups(button);
    this.renderStrip();
  }

  private renderStrip() {
    if (!this.strip) return;
    const pen = this.pen;
    const mark = (sel: string, on: (el: HTMLElement) => boolean) => this.strip.querySelectorAll<HTMLElement>(sel).forEach(el => {
      const active = on(el);
      el.toggleClass('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    });
    mark('.nb-ink-nib', el => el.dataset.nib === pen.nib);
    mark('.nb-ink-swatch', el => el.dataset.color === pen.color);
    mark('.nb-ink-size', el => Number(el.dataset.size) === pen.size);
    this.strip.querySelector<HTMLElement>('.nb-ink-size-value')?.setText(`${pen.size} px`);
    this.renderToolGroups();
  }

  // ---- tools and the highlighter (#6)

  /** What the next stroke is written with: the active tool's own colour and size. */
  strokeStyle(): StrokeStyle {
    const { pen, highlighter } = this;
    if (pen.tool === 'highlighter') return { tool: 'highlighter', color: highlighter.color, size: highlighter.size };
    return { tool: 'pen', nib: pen.nib, color: pen.color, size: pen.size };
  }

  /** Switches the tool; each tool keeps its own colour and size. An unknown tool throws. */
  setTool(tool: ToolKind) {
    this.setPen({ tool });
  }

  /**
   * Changes the highlighter's colour or size for its next stroke. Sizes are clamped to 4-48 px
   * in 0.5 px steps; a colour that isn't `#rrggbb` throws.
   */
  setHighlighter(change: Partial<HighlighterSettings>) {
    this.highlighter = withHighlighter(this.highlighter, change);
    this.renderStrip();
  }

  nextHighlighterColor() {
    this.setHighlighter({ color: nextHighlighterColor(this.highlighter.color) });
  }

  nextHighlighterSize() {
    this.setHighlighter({ size: nextHighlighterSize(this.highlighter.size) });
  }

  /**
   * PROVISIONAL (#10): the tool group (first in the strip) and the highlighter's group of five
   * swatches and two sizes (before the "provisional" label), shown while the highlighter is in use.
   */
  private buildToolGroups(button: (parent: HTMLElement, cls: string, text: string, label: string, fn: () => void) => HTMLElement) {
    const strip = this.strip;
    const tools = strip.createDiv({ cls: 'nb-ink-control nb-ink-group nb-ink-tools' });
    strip.prepend(tools);
    button(tools, 'nb-ink-tool', 'Pen', 'Pen', () => this.setTool('pen')).dataset.tool = 'pen';
    button(tools, 'nb-ink-tool', 'Highlighter', 'Highlighter', () => this.setTool('highlighter')).dataset.tool = 'highlighter';
    const hl = strip.createDiv({ cls: 'nb-ink-control nb-ink-group nb-ink-highlighter' });
    strip.insertBefore(hl, strip.querySelector('.nb-ink-provisional'));
    for (const { color, name } of HIGHLIGHTER_COLORS) {
      const b = button(hl, 'nb-ink-hl-swatch', '', `${name} highlighter`, () => this.setHighlighter({ color }));
      b.dataset.color = color;
      b.style.backgroundColor = color;
    }
    for (const size of HIGHLIGHTER_SIZES) {
      button(hl, 'nb-ink-hl-size', String(size), `Highlighter size ${size} px`, () => this.setHighlighter({ size })).dataset.size = String(size);
    }
  }

  private renderToolGroups() {
    const strip = this.strip, { pen, highlighter } = this;
    const mark = (sel: string, on: (el: HTMLElement) => boolean) => strip.querySelectorAll<HTMLElement>(sel).forEach(el => {
      const active = on(el);
      el.toggleClass('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    });
    mark('.nb-ink-tool', el => el.dataset.tool === pen.tool);
    mark('.nb-ink-hl-swatch', el => el.dataset.color === highlighter.color);
    mark('.nb-ink-hl-size', el => Number(el.dataset.size) === highlighter.size);
    const show = (sel: string, on: boolean) => strip.querySelectorAll<HTMLElement>(sel).forEach(el => (on ? el.show() : el.hide()));
    show('.nb-ink-nibs, .nb-ink-colors, .nb-ink-sizes, .nb-ink-stepper', pen.tool === 'pen');
    show('.nb-ink-highlighter', pen.tool === 'highlighter');
  }

  // ---- stats overlay

  get statsShown(): boolean {
    return !!this.statsEl && this.statsEl.style.display !== 'none';
  }

  /** Shows or hides the pen stats overlay. */
  toggleStats() {
    if (this.statsShown) this.statsEl.hide();
    else this.statsEl.show();
    this.renderStats();
  }

  private renderStats() {
    if (this.statsShown) this.statsEl.setText(penStatsLines(this.stats.pen, this.pen).join('\n'));
  }

  // ---- adding pages

  /** Appends a page with the given template, or the note's default, and scrolls to it. */
  addPage(template?: Template) {
    const store = this.store;
    if (!store) return;
    const pv = this.makePage(store.addPage(template));
    this.pages.push(pv);
    this.relayout();
    const box = this.layout?.pages[this.pages.length - 1];
    if (box) this.scroller.scrollTop = box.top - MARGIN;
    this.update();
    this.recordAddPage(pv.slot.id);
  }

  // ---- templates

  /** The index of the page taking up most of the viewport, or -1 if there are no pages. */
  currentPageIndex(): number {
    if (!this.layout) return -1;
    const top = this.scroller.scrollTop;
    const i = mostVisiblePage(this.layout, top, top + this.scroller.clientHeight);
    return i >= 0 ? i : pageAtY(this.layout, top);
  }

  /** Opens the template chooser to add a page, or to change this page's or every page's template. */
  chooseTemplate(scope: 'add' | 'page' | 'all') {
    if (!this.store) return;
    const placeholder = scope === 'add' ? 'Template of the new page' : scope === 'page' ? 'Template of this page' : 'Template of all pages';
    new TemplateChooser(this.app, placeholder, template => {
      if (scope === 'add') this.addPage(template);
      else if (scope === 'page') this.setPageTemplate(this.currentPageIndex(), template);
      else this.setAllTemplates(template);
    }).open();
  }

  /**
   * Changes page `index`'s template, keeping its ink, and redraws it. Returns the template it
   * had, or null if there's no such page or it can't be read.
   */
  setPageTemplate(index: number, template: Template): Template | null {
    const pv = this.pages[index];
    if (!this.store || !pv) return null;
    const before = this.store.setPageTemplate(pv.slot.id, template);
    if (before && pv.bitmap) this.renderPage(pv);
    if (before) this.recordPageTemplate(pv.slot.id, before, template);
    return before;
  }

  /** Changes every page's template and the note's default, and redraws. Returns what it replaced. */
  setAllTemplates(template: Template): TemplatesBefore | null {
    if (!this.store) return null;
    const before = this.store.setAllTemplates(template);
    for (const pv of this.pages) if (pv.bitmap) this.renderPage(pv);
    this.recordAllTemplates(before, template);
    return before;
  }

  // ---- changes on disk

  private pageChanged(slot: PageSlot) {
    const pv = this.pages.find(p => p.slot === slot);
    if (!pv) return;
    this.showError(pv);
    this.relayout(); // the size may have changed
    if (pv.bitmap) this.renderPage(pv);
    this.update();
  }

  private indexChanged() {
    this.input.cancel();
    this.history.clear(); // pages were added, removed or reordered elsewhere: the history no longer fits
    this.buildPages();
    this.relayout();
    this.update();
  }

  // ---- undo and redo (#8)
  // Each edit is recorded where it happens (commit, eraseStrokes, setPageTemplate,
  // setAllTemplates, addPage) as an Op whose closures change the store and redraw; the store
  // marks what changed, so autosave writes the result like any other edit.

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** Reverses the latest edit. Returns false if there was nothing to undo. */
  undo(): boolean {
    if (!this.store) return false;
    const op = this.history.undo();
    this.updateStats();
    return !!op;
  }

  /** Repeats the latest undone edit. Returns false if there was nothing to redo. */
  redo(): boolean {
    if (!this.store) return false;
    const op = this.history.redo();
    this.updateStats();
    return !!op;
  }

  /**
   * Removes strokes from page `pageIndex` as one undoable edit and redraws the page. MINIMAL
   * VERSION for #8: the stroke eraser (#7) routes all erasing through a method of this name and
   * signature; when the branches merge, keep one method that does both (the eraser's
   * behaviour plus this recording).
   */
  eraseStrokes(pageIndex: number, ids: Iterable<string>): void {
    const pv = this.pages[pageIndex];
    if (!this.store || !pv) return;
    const removed = this.store.removeStrokes(pv.slot.id, ids);
    if (!removed.length) return;
    this.redrawPage(pv.slot.id);
    this.recordStrokes('Erase', pv.slot.id, removed, false);
  }

  /**
   * Records strokes added to (`added`) or removed from a page, with the indices they have (or
   * had): undo removes or reinserts them, redo the opposite.
   */
  private recordStrokes(label: string, pageId: string, entries: { index: number; stroke: Stroke }[], added: boolean) {
    const store = this.store;
    if (!store) return;
    const ids = entries.map(e => e.stroke.id);
    const remove = () => {
      if (this.store !== store) return;
      store.removeStrokes(pageId, ids);
      this.redrawPage(pageId);
    };
    const insert = () => {
      if (this.store !== store) return;
      store.insertStrokes(pageId, entries);
      this.redrawPage(pageId);
    };
    this.history.push({ label, undo: added ? remove : insert, redo: added ? insert : remove });
  }

  private recordPageTemplate(pageId: string, before: Template, after: Template) {
    const store = this.store;
    if (!store || templateName(before) === templateName(parseTemplate(after))) return;
    const set = (template: Template) => () => {
      if (this.store !== store) return;
      store.setPageTemplate(pageId, template);
      this.redrawPage(pageId);
    };
    this.history.push({ label: 'Change page template', undo: set(before), redo: set(after) });
  }

  private recordAllTemplates(before: TemplatesBefore | null, after: Template) {
    const store = this.store;
    if (!store || !before) return;
    const name = templateName(parseTemplate(after));
    if (before.note === name && before.pages.every(p => templateName(p.template) === name)) return;
    const redrawAll = () => {
      for (const pv of this.pages) if (pv.bitmap) this.renderPage(pv);
    };
    this.history.push({
      label: 'Change all templates',
      undo: () => {
        if (this.store !== store) return;
        store.setNoteTemplateName(before.note);
        for (const p of before.pages) store.setPageTemplate(p.id, p.template);
        redrawAll();
      },
      redo: () => {
        if (this.store !== store) return;
        store.setAllTemplates(after);
        redrawAll();
      },
    });
  }

  /**
   * Records an added page: undo takes it out of the index (its file, if already written, stays
   * on disk, orphaned until redo; deleting page files is #17), redo puts it back where it was.
   */
  private recordAddPage(pageId: string) {
    const store = this.store;
    if (!store) return;
    let index = -1;
    this.history.push({
      label: 'Add page',
      undo: () => {
        if (this.store !== store) return;
        index = store.removePageFromIndex(pageId).index;
        this.removePageView(pageId);
      },
      redo: () => {
        if (this.store !== store) return;
        store.insertPageInIndex(pageId, index);
        this.insertPageView(pageId);
      },
    });
  }

  /** Redraws a page from its model if it has a bitmap (otherwise it's drawn when scrolled to). */
  private redrawPage(pageId: string) {
    const pv = this.pages.find(p => p.slot.id === pageId);
    if (pv?.bitmap) this.renderPage(pv);
    this.updateStats();
  }

  /** Drops the element of a page that left the index. */
  private removePageView(pageId: string) {
    const i = this.pages.findIndex(p => p.slot.id === pageId);
    if (i < 0) return;
    this.input.cancel();
    const [pv] = this.pages.splice(i, 1);
    this.dropBitmap(pv);
    pv.el.remove();
    this.relayout();
    this.update();
  }

  /** Adds the element of a page that came back into the index, at its position. */
  private insertPageView(pageId: string) {
    const store = this.store;
    const i = store ? store.slots.findIndex(s => s.id === pageId) : -1;
    if (!store || i < 0 || this.pages.some(p => p.slot.id === pageId)) return;
    const pv = this.makePage(store.slots[i]);
    this.pages.splice(i, 0, pv);
    this.pagesEl.insertBefore(pv.el, this.pages[i + 1]?.el ?? this.footer);
    this.relayout();
    this.update();
  }

  /** Ctrl/Cmd+Z undoes, Shift+Ctrl/Cmd+Z redoes. Skips keys already handled (by the commands' hotkeys). */
  private historyKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || !this.store) return;
    e.preventDefault();
    e.stopPropagation(); // so a hotkey listener further up doesn't run it again
    if (e.shiftKey) this.redo();
    else this.undo();
  }

  /** The Undo and Redo buttons, in their own group of the pen strip. */
  private buildHistoryGroup() {
    const strip = this.strip;
    const group = strip.createDiv({ cls: 'nb-ink-control nb-ink-group nb-ink-history' });
    strip.insertBefore(group, strip.querySelector('.nb-ink-provisional'));
    const button = (what: 'undo' | 'redo', text: string, fn: () => boolean) => {
      const b = group.createEl('button', { cls: `nb-ink-control nb-ink-${what}`, text, attr: { 'aria-label': text, type: 'button' } });
      b.addEventListener('click', () => void fn());
    };
    button('undo', 'Undo', () => this.undo());
    button('redo', 'Redo', () => this.redo());
    this.renderHistory();
  }

  private renderHistory() {
    if (!this.strip) return;
    const set = (sel: string, on: boolean) => {
      const b = this.strip.querySelector<HTMLButtonElement>(sel);
      if (b) b.disabled = !on;
    };
    set('.nb-ink-undo', this.history.canUndo);
    set('.nb-ink-redo', this.history.canRedo);
  }
}

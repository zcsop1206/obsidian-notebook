// The ink view: an ink note's pages stacked like paper in a native scrolling container, with
// the pen (input.ts) and the toolbar (toolbar.ts), finger panning and zoom (navigate.ts),
// autosave and reloading after changes on disk. The note's data lives in NoteStore; page
// bitmaps in PageBitmap; this file ties them to Obsidian and the DOM.
import { FileView, Notice, TAbstractFile, TFile, TFolder, type App, type WorkspaceLeaf } from 'obsidian';
import { newStrokeId } from '../format/ids';
import { isInkNote, markdownEmbed } from '../format/note';
import type { Page } from '../format/page';
import type { Template } from '../format/template';
import { parseTemplate, sameTemplate, templateName } from '../format/template';
import type { Stroke } from '../format/page';
import { listenForUndoTaps } from './gestures';
import { History } from './history';
import { blockFingerTouch, blockStylusTouch, eraseStatsLines, newPenStats, PenInput, penStatsLines, type EraseTally, type NewStroke, type PageTarget, type PenStats, type StrokeStyle } from './input';
import { DEFAULT_PEN, nextColor, nextSize, withPen, type PenSettings } from './pen';
import { DEFAULT_HIGHLIGHTER, nextHighlighterColor, nextHighlighterSize, withHighlighter, type HighlighterSettings, type ToolKind } from './pen';
import { DEFAULT_ERASER, nextEraserSize, withEraser, type EraserMode, type EraserSettings } from './pen';
import { DEFAULT_PRESETS, MAX_PRESETS, parseToolState, presetOf, type PenPreset } from './pen';
import { A4, LETTER, newPage, roundXY } from '../format/page';
import type { NotebookSettings } from '../settings';
import { Toolbar } from './toolbar';
import { splitStroke } from './split';
import { emptyGhostPages, inksGhost, layoutPages, MARGIN, mostVisiblePage, pageAtY, pagesInBand, type Layout } from './layout';
import { anchorAt, clampZoom, navStatsLines, Navigator, newNavStats, scrollToKeep, zoomStep, type NavStats } from './navigate';
import { currentTheme, PageBitmap, pageTheme, releaseScratch, strokeColor, TemplateImages, warmOutlines, type Theme } from './renderer';
import { SpatialIndex } from './spatial';
import { PagesPanel } from './pages-panel';
import { NoteStore, type NoteFiles, type PageSlot, type TemplatesBefore } from './store';
import { VIEW_TYPE_INK } from './takeover';
import { TemplateChooser } from './template-chooser';
import { centreOn, encodeClip, isIdentity, lassoSelect, moveBy, resizeBy, resizeScale, strokesBounds, transformStroke, withIds, type Box, type Transform } from './lasso';
import { hitSelection, SelectionMenu, SelectionOverlay } from './selection';
import type { Point } from '../format/page';
import type { SelectionHit } from './input';
import { templateRegistry } from './templates';
import type { Size } from '../format/page';

/** How long the view waits after a resize before redrawing bitmaps at the new size. */
const RESIZE_DELAY = 150;
/** Wait after a tool change before saving the settings, in ms. */
const SAVE_TOOLS_DELAY = 400;
/** Time per frame for computing the outlines of a page about to be drawn, in ms. */
const PUMP_BUDGET = 4;
/** Pen strokes the pump draws into a bitmap per frame. */
const PUMP_STROKES = 100;

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
  /** Finger navigation: zoom and the last gesture's frame times (navigate.ts). */
  nav: NavStats;
}

/** Where the view keeps the tools and favourite presets (#10): the plugin and its settings. */
export interface ToolSettingsHost {
  settings: NotebookSettings;
  saveSettings(): Promise<void>;
  /** Strokes copied with the lasso (#11), kept by the plugin so they paste into any note. */
  inkClipboard?: InkClipboard | null;
}

/** Strokes copied or cut with the lasso (#11): copies, in page px of the page they came from, in drawing order. */
export interface InkClipboard {
  strokes: Stroke[];
}

/** The clipboard of views without a plugin (never in the plugin). */
let localClipboard: InkClipboard | null = null;

interface PageView {
  slot: PageSlot;
  el: HTMLElement;
  bitmap: PageBitmap | null;
  /** The page's strokes for the eraser: built when the eraser first touches the page (#7). */
  spatial?: SpatialIndex | null;
  /**
   * While the pump draws the bitmap over several frames (#9): the index of the next stroke to
   * draw. Null or absent when the bitmap is complete.
   */
  pending?: number | null;
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
    async delete(path) {
      const f = vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await vault.delete(f);
    },
    isFolder: path => vault.getAbstractFileByPath(path) instanceof TFolder,
  };
}

export class InkView extends FileView {
  stats: InkStats = { pagesLoaded: 0, pagesRendered: 0, lastRenderMs: 0, openMs: 0, saves: 0, pen: newPenStats(), nav: newNavStats() };
  /** The settings of the next stroke. */
  pen: PenSettings = { ...DEFAULT_PEN };
  /** The highlighter's colour and size (the pen's `tool` says which one is in use). */
  highlighter: HighlighterSettings = { ...DEFAULT_HIGHLIGHTER };
  /** The eraser's settings (used when `pen.tool` is 'eraser'). */
  eraser: EraserSettings = { ...DEFAULT_ERASER };
  store: NoteStore | null = null;
  /** The open note's undo history (#8): cleared when the note closes or another is loaded. */
  readonly history = new History(() => this.renderHistory());
  private scroller!: HTMLElement;
  private pagesEl!: HTMLElement;
  /**
   * Holds the scroll size while a pinch scales the pages layer (a transform changes the
   * layer's scrollable overflow, and a smaller one would move the scroll position).
   */
  private sizer!: HTMLElement;
  private nav!: Navigator;
  /** Zoom on top of the fitted width (1 = 100%), kept while the note is open (#9). */
  private zoomLevel = 1;
  /** The "Add page" controls below the last page. */
  private footer!: HTMLElement;
  private messageEl!: HTMLElement;
  private input!: PenInput;
  /** The toolbar (#10): tools, favourite presets, undo and redo, pages. */
  toolbar: Toolbar | null = null;
  private saveToolsTimer = 0;
  private statsEl!: HTMLElement;
  private pages: PageView[] = [];
  private layout: Layout | null = null;
  private theme: Theme = currentTheme();
  private templates = new TemplateImages();
  /** The page the pen last landed on (pageAt), for the live stroke's colour. */
  private penPage: Page | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer = 0;
  private updateFrame = 0;
  private pumpFrame = 0;
  private width = 0;
  private loads = 0;

  constructor(leaf: WorkspaceLeaf, private settingsHost: ToolSettingsHost | null = null) {
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
    this.restoreTools();
    this.buildToolbar(root);
    this.buildPagesPanel(root);
    this.scroller = root.createDiv({ cls: 'nb-ink-scroll' });
    this.sizer = this.scroller.createDiv({ cls: 'nb-ink-sizer' });
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
      // The pen asks for the colour right after pageAt; a pdf page's default ink stays dark (#14).
      drawColor: color => strokeColor({ color }, pageTheme(this.penPage, this.theme)),
      commit: (target, stroke) => this.commit(target, stroke),
      statsChanged: () => this.renderStats(),
      strokeStyle: () => this.strokeStyle(),
      eraser: () => this.eraser,
      erase: (target, path, radius, start, mode, tally) => this.eraseAlong(target, path, radius, start, mode, tally),
      selectionHit: (target, point) => this.selectionHit(target, point),
      clearSelection: () => this.clearSelection(),
      lassoSelect: (target, loop) => this.selectLoop(target, loop),
      dragSelection: (kind, from, to, x, y) => this.dragSelection(kind, from, to, x, y),
      endSelectionDrag: cancelled => this.endSelectionDrag(cancelled),
    }, (type, fn, options) => this.registerDomEvent(this.pagesEl, type, fn, options), this.stats.pen);
    // A Pencil drag anywhere in the view, on a page or not, never scrolls it (blockStylusTouch);
    // finger drags over the pages move it through the navigator, never natively, and never
    // reach Obsidian's sidebar swipes (blockFingerTouch).
    this.registerDomEvent(root, 'touchstart', e => blockStylusTouch(e), { passive: false });
    this.registerDomEvent(root, 'touchmove', e => blockStylusTouch(e) || blockFingerTouch(e, this.scroller), { passive: false });
    // Two fingers tapped undo, three redo (a tap never pans: see NAV_SLOP in navigate.ts).
    listenForUndoTaps((type, fn, options) => this.registerDomEvent(this.pagesEl, type, fn, options), () => this.undo(), () => this.redo());
    // One or two fingers pan with momentum, two pinch-zoom; Ctrl/Cmd+wheel zooms.
    this.nav = new Navigator(this.scroller, {
      zoom: () => this.zoomLevel,
      preview: (k, x, y) => this.preview(k, x, y),
      commit: (z, x, y, vx, vy) => this.commitZoom(z, x, y, vx, vy),
      moved: () => this.input.viewMoved(),
      statsChanged: () => this.renderStats(),
    }, (type, fn, options) => this.registerDomEvent(this.scroller, type, fn, options), this.stats.nav);
    // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z when focus is in the view, if the commands' hotkeys didn't take them.
    this.registerDomEvent(this.containerEl, 'keydown', e => this.historyKey(e));
    // The lasso's selection (#11): its overlay, its menu, and Escape to drop it.
    this.selOverlay = new SelectionOverlay();
    this.selMenu = new SelectionMenu(root, {
      recolor: color => this.recolorSelection(color),
      remove: () => this.deleteSelection(),
      cut: () => this.cutSelection(),
      copy: () => this.copySelection(),
      duplicate: () => this.duplicateSelection(),
      paste: () => this.pasteStrokes(),
      canPaste: () => this.canPaste,
      theme: () => this.theme,
    });
    this.registerDomEvent(this.containerEl, 'keydown', e => {
      if (e.key !== 'Escape' || !this.sel) return;
      e.preventDefault();
      this.clearSelection();
    });

    this.registerDomEvent(this.scroller, 'scroll', () => {
      this.input.viewMoved();
      this.requestUpdate();
    }, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.resized());
    this.resizeObserver.observe(this.scroller);

    this.addAction('file-text', 'Open as markdown', () => void this.openAsMarkdown());

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
      if (this.store?.followRename(file.path, oldPath, file instanceof TFolder)) return; // the page folder moved (#26)
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
    this.nav.reset();
    this.input.destroy();
    this.selOverlay?.destroy();
    this.selMenu?.destroy();
    this.templates.clear();
    this.pagesPanel?.destroy();
    this.toolbar?.destroy();
    if (this.saveToolsTimer) this.saveTools();
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
      pageEdited: slot => this.store === store && this.pagesPanel?.changed(slot.id),
    }, templateRegistry()?.storeOptions());
    void templateRegistry()?.load(); // PDF templates (#21), for `pdf:` names and the chooser
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
    // Another note starts at 100%, at the top.
    this.zoomLevel = this.stats.nav.zoom = 1;
    this.buildPages();
    this.relayout();
    this.scroller.scrollTop = this.scroller.scrollLeft = 0;
    this.update();
    this.toolbar?.render(); // the page buttons need a note
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
    this.clearSelection();
    this.nav.reset();
    this.preview(1, 0, 0);
    this.dropEmptyGhostPages(store); // #28
    const saved = store.flush();
    store.close();
    this.clearPages();
    this.layout = null;
    this.toolbar?.closePicker();
    this.toolbar?.render();
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
    this.removeGhost(); // #28
    this.pagesPanel?.sync();
    this.footer.hide();
    this.pagesEl.style.height = this.pagesEl.style.width = '';
    this.sizer.style.height = this.sizer.style.width = '';
    this.updateStats();
  }

  private buildPages() {
    this.clearPages();
    this.pages = this.store!.slots.map(slot => this.makePage(slot));
    this.makeGhost(); // #28
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

  /**
   * Positions page elements for the current width and zoom. When the scale changed, the scroll
   * position is kept on the same part of the page at the top of the view, unless `keep` is false
   * (a zoom places it itself). Returns false if the view has no width yet.
   */
  private relayout(keep = true): boolean {
    const store = this.store;
    const width = this.scroller.clientWidth;
    if (!store || width <= 0) return false;
    const old = this.layout;
    let anchor: { index: number; at: number } | null = null;
    if (keep && old && old.pages.length) {
      const index = pageAtY(old, this.scroller.scrollTop);
      const box = old.pages[index];
      anchor = { index, at: (this.scroller.scrollTop - box.top) / box.height };
    }
    const layout = layoutPages(this.pages.map(pv => pv.slot.size), width, store.paperSize, this.zoomLevel, this.ghost?.page.size);
    this.layout = layout;
    this.width = width;
    for (const el of [this.pagesEl, this.sizer]) {
      el.style.width = `${layout.width}px`;
      el.style.height = `${layout.height}px`;
    }
    this.pages.forEach((pv, i) => {
      const b = layout.pages[i], s = pv.el.style;
      s.top = `${b.top}px`;
      s.left = `${b.left}px`;
      s.width = `${b.width}px`;
      s.height = `${b.height}px`;
    });
    this.placeGhost(layout); // #28
    this.footer.style.top = `${layout.footerTop}px`;
    this.pagesPanel?.sync(); // #17: pages may have been added, removed or reordered
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

  /**
   * The pages to keep bitmaps for: the viewport and one page height either side, a page height
   * at 100% when zoomed in (so at 400% at most two or three pages have bitmaps).
   */
  private band(): { near: Set<number>; visible: number[] } {
    const layout = this.layout!;
    const top = this.scroller.scrollTop, height = this.scroller.clientHeight;
    const pageHeight = layout.pages.reduce((h, p) => Math.max(h, p.height), 0) / Math.max(1, layout.zoom);
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
    // While a pinch scales the layer, the scroll position doesn't say what's on screen: keep the
    // bitmaps as they are until the zoom is committed.
    if (!this.store || !this.layout || this.nav.previewing) return;
    const { near, visible } = this.band();
    this.pages.forEach((pv, i) => {
      if (!near.has(i)) this.dropBitmap(pv);
    });
    for (const i of visible) {
      const pv = this.pages[i];
      if (!pv.bitmap || pv.pending != null) this.renderPage(pv);
    }
    this.updateGhost(); // #28
    this.updateStats();
    this.pump();
    if (this.sel && !this.selDrag) this.showSelection();
    if (this.pagesPanel?.isOpen) this.pagesPanel.setCurrent(this.currentPageIndex());
  }

  /**
   * Draws the pages near the viewport, nearest first. So that a page coming into view during a
   * pan doesn't cost a long frame (#9), the work is spread over frames: a page not yet parsed is
   * parsed in a frame of its own, then its stroke outlines are computed PUMP_BUDGET ms per
   * frame, then it's drawn PUMP_STROKES strokes per frame (each frame then rasterises only
   * those). A page that comes into view before it's done is finished at once by update().
   */
  private pump() {
    if (this.pumpFrame) return;
    this.pumpFrame = requestAnimationFrame(() => {
      const t0 = performance.now();
      this.pumpFrame = 0;
      if (!this.store || !this.layout || this.nav.previewing) return;
      const { near, visible } = this.band();
      const mid = visible.length ? (visible[0] + visible[visible.length - 1]) / 2 : 0;
      const next = [...near]
        .filter(i => (!this.pages[i].bitmap || this.pages[i].pending != null) && !this.pages[i].slot.error)
        .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
      if (next === undefined) return;
      const pv = this.pages[next], parsed = !!pv.slot.page, page = this.store.page(pv.slot);
      if (page && (!parsed || !warmOutlines(page, t0 + PUMP_BUDGET))) {
        this.pump(); // the rest of the outlines next frame
        return;
      }
      if (page) this.renderStep(pv, page);
      else this.renderPage(pv); // shows the error
      this.updateStats();
      this.pump();
    });
  }

  /** Draws the next PUMP_STROKES strokes of a page's bitmap, starting it if needed. */
  private renderStep(pv: PageView, page: Page) {
    if (pv.pending == null || !pv.bitmap) {
      if (!this.bitmapFor(pv)) return;
      pv.bitmap!.renderBase(page, this.theme, this.template(pv, page), this.hiddenOn(pv));
      pv.pending = 0;
    }
    const next = pv.bitmap!.renderPen(page, this.theme, pv.pending!, PUMP_STROKES, this.hiddenOn(pv));
    pv.pending = next < page.strokes.length ? next : null;
  }

  /** Gives the page a bitmap of its current size (keeping one that has it); false if it has no box. */
  private bitmapFor(pv: PageView): boolean {
    const box = this.layout?.pages[this.pages.indexOf(pv)];
    if (!box) return false;
    if (pv.bitmap && (pv.bitmap.cssWidth !== box.width || pv.bitmap.cssHeight !== box.height)) this.dropBitmap(pv);
    if (!pv.bitmap) {
      pv.bitmap = new PageBitmap(box.width, box.height);
      pv.el.insertBefore(pv.bitmap.canvas, pv.el.firstChild);
    }
    return true;
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
    if (!this.bitmapFor(pv)) return;
    const t0 = performance.now();
    pv.bitmap!.render(page, this.theme, this.template(pv, page), this.hiddenOn(pv));
    pv.pending = null;
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
    pv.pending = null;
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
    if (this.ghost?.bitmap) this.renderGhost(); // #28
  }

  // ---- writing

  private pageAt(target: EventTarget | null): PageTarget | null {
    if (!this.store || !(target instanceof Element)) return null;
    if (this.ghost && target.closest('.nb-ink-ghost') === this.ghost.el) return this.materialiseGhost(); // #28
    const el = target.closest('.nb-ink-page');
    const pv = el && this.pages.find(p => p.el === el);
    if (!pv) return null;
    const page = this.store.page(pv.slot);
    if (!page) return null;
    this.penPage = page;
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
    pv.spatial?.add(stroke);
    if (pv.bitmap && pv.pending == null) pv.bitmap.addStroke(page, stroke, this.theme, this.template(pv, page));
    else this.renderPage(pv);
    this.updateStats();
    this.recordStrokes('Add stroke', pv.slot.id, [{ index: page.strokes.length - 1, stroke }], true);
  }

  // ---- pen settings

  /**
   * Changes the pen for the next stroke. Sizes are clamped to 0.5-16 px in 0.5 px steps; an
   * unknown nib or a colour that isn't `#rrggbb` throws.
   */
  setPen(change: Partial<PenSettings>) {
    this.pen = withPen(this.pen, change);
    if (this.pen.tool !== 'lasso') this.clearSelection(); // switching tools drops the lasso's selection (#11)
    this.toolsChanged();
    this.renderStats();
  }

  nextColor() {
    this.setPen({ color: nextColor(this.pen.color) });
  }

  nextSize() {
    this.setPen({ size: nextSize(this.pen.size) });
  }

  // ---- tools and the highlighter (#6)

  /** What the next stroke is written with: the active tool's own colour and size. */
  strokeStyle(): StrokeStyle {
    const { pen, highlighter } = this;
    if (pen.tool === 'highlighter') return { tool: 'highlighter', color: highlighter.color, size: highlighter.size };
    return { tool: 'pen', nib: pen.nib, color: pen.color, size: pen.size };
  }

  /** Switches the tool (pen, highlighter or eraser); each keeps its own settings. An unknown tool throws. */
  setTool(tool: ToolKind) {
    this.setPen({ tool });
  }

  /**
   * Changes the highlighter's colour or size for its next stroke. Sizes are clamped to 4-48 px
   * in 0.5 px steps; a colour that isn't `#rrggbb` throws.
   */
  setHighlighter(change: Partial<HighlighterSettings>) {
    this.highlighter = withHighlighter(this.highlighter, change);
    this.toolsChanged();
  }

  nextHighlighterColor() {
    this.setHighlighter({ color: nextHighlighterColor(this.highlighter.color) });
  }

  nextHighlighterSize() {
    this.setHighlighter({ size: nextHighlighterSize(this.highlighter.size) });
  }

  // ---- the eraser (#7)

  /** Changes the eraser's size (snapped to one of ERASER_SIZES) or mode; an unknown mode throws. */
  setEraser(change: Partial<EraserSettings>) {
    this.eraser = withEraser(this.eraser, change);
    this.toolsChanged();
  }

  nextEraserSize() {
    this.setEraser({ size: nextEraserSize(this.eraser.size) });
  }

  /**
   * The eraser moved along `path` on a page: erases the strokes it touched (whole, or in partial
   * mode only the parts under it), one undo step per drag.
   */
  private eraseAlong(target: PageTarget, path: readonly { x: number; y: number }[], radius: number, start: boolean, mode: EraserMode, tally: EraseTally) {
    const pv = target.key as PageView;
    const index = this.pages.indexOf(pv);
    const page = this.store && index >= 0 ? this.store.page(pv.slot) : null;
    if (!page) return;
    if (!pv.spatial) pv.spatial = new SpatialIndex(page.size, page.strokes);
    if (start) this.lastErase = this.lastSplit = null; // a new drag: its first change is a new undo step
    const ids = pv.spatial.hitPath(path, radius, this.eraseHits);
    if (ids.length) {
      if (mode === 'stroke') tally.removed += this.eraseStrokes(index, ids, !start).length;
      else this.splitStrokes(index, ids, path, radius, !start, tally);
    }
    ids.length = 0;
  }

  /**
   * The partial eraser (#15): cuts the part of each of these strokes within `radius` of `path`
   * out of it (see split.ts), replacing the stroke by its remnants at its index, as one undoable
   * edit; keeps the page's eraser index in step and redraws the page once. With `join`, the
   * edit joins the previous one of the same drag (as eraseStrokes does), so a drag is one undo
   * step. Undo puts the originals back and takes the remnants out, latest first; redo cuts
   * again with the same remnants (same ids). Saved by the autosave.
   */
  private splitStrokes(pageIndex: number, ids: readonly string[], path: readonly { x: number; y: number }[], radius: number, join: boolean, tally: EraseTally) {
    const pv = this.pages[pageIndex];
    const store = this.store;
    const page = store && pv ? store.page(pv.slot) : null;
    if (!store || !pv || !page) return;
    const pageId = pv.slot.id;
    const byId = new Map(page.strokes.map(s => [s.id, s] as const));
    const taken = new Set(byId.keys());
    const cuts: { index: number; stroke: Stroke; remnants: Stroke[] }[] = [];
    for (const id of ids) {
      const stroke = byId.get(id);
      const remnants = stroke && splitStroke(stroke, path, radius, taken);
      if (!remnants) continue;
      const replaced = store.replaceStroke(pageId, id, remnants);
      if (!replaced) continue;
      if (pv.spatial) {
        pv.spatial.remove(id);
        for (const r of remnants) pv.spatial.add(r);
      }
      cuts.push({ ...replaced, remnants });
      if (remnants.length) {
        tally.split++;
        tally.remnants += remnants.length;
      } else tally.removed++;
    }
    if (!cuts.length) return;
    this.redrawPage(pageId);
    const last = this.lastSplit, depth = this.history.labels.length;
    if (join && last && last.store === store && last.pageId === pageId && last.depth === depth && !this.history.canRedo) {
      last.cuts.push(...cuts);
      return;
    }
    const all = cuts;
    const spatial = () => this.pages.find(p => p.slot.id === pageId)?.spatial;
    this.history.push({
      label: 'Erase',
      undo: () => {
        if (this.store !== store) return;
        const index = spatial();
        for (let i = all.length - 1; i >= 0; i--) {
          const c = all[i];
          store.removeStrokes(pageId, c.remnants.map(r => r.id));
          store.insertStrokes(pageId, [{ index: c.index, stroke: c.stroke }]);
          if (index) {
            for (const r of c.remnants) index.remove(r.id);
            index.add(c.stroke);
          }
        }
        this.redrawPage(pageId);
      },
      redo: () => {
        if (this.store !== store) return;
        const index = spatial();
        for (const c of all) {
          store.replaceStroke(pageId, c.stroke.id, c.remnants);
          if (index) {
            index.remove(c.stroke.id);
            for (const r of c.remnants) index.add(r);
          }
        }
        this.redrawPage(pageId);
      },
    });
    this.lastSplit = { store, pageId, cuts: all, depth: this.history.labels.length };
  }

  /** The latest partial erase edit, which the next frames of the same eraser drag join. */
  private lastSplit: { store: NoteStore; pageId: string; cuts: { index: number; stroke: Stroke; remnants: Stroke[] }[]; depth: number } | null = null;

  /** Reused for the ids each eraser frame hits. */
  private eraseHits: string[] = [];

  // ---- zoom (#9)

  /** The zoom on top of the fitted width: 1 is 100%, from 0.5 to 4. */
  get zoom(): number {
    return this.zoomLevel;
  }

  /**
   * Zooms to `z` (clamped to 0.5-4) keeping the page point at `centre` (px from the top-left of
   * the visible pages area; by default its middle) where it is, and redraws the visible pages.
   */
  setZoom(z: number, centre?: { x: number; y: number }) {
    this.nav.stopMomentum();
    this.nav.commitWheel();
    const sc = this.scroller;
    const c = centre ?? { x: sc.clientWidth / 2, y: sc.clientHeight / 2 };
    this.commitZoom(z, sc.scrollLeft + c.x, sc.scrollTop + c.y, c.x, c.y);
    this.renderStats();
  }

  /** The next 25% step up. */
  zoomIn() {
    this.setZoom(zoomStep(this.zoomLevel, 1));
  }

  /** The next 25% step down. */
  zoomOut() {
    this.setZoom(zoomStep(this.zoomLevel, -1));
  }

  resetZoom() {
    this.setZoom(1);
  }

  /** Scales the pages layer by k around (x, y) of the layer during a pinch; k = 1 removes it. */
  private preview(k: number, x: number, y: number) {
    const s = this.pagesEl.style;
    if (k === 1) {
      s.transform = s.transformOrigin = '';
      return;
    }
    s.transformOrigin = `${x}px ${y}px`;
    s.transform = `scale(${k})`;
  }

  /**
   * Makes `z` the zoom: removes any pinch transform, lays out again, scrolls so that the page
   * point at (x, y) of the pages layer (laid out as before) is at (vx, vy) of the viewport, then
   * redraws the visible pages at the new size and drops the other bitmaps of the old size.
   */
  private commitZoom(z: number, x: number, y: number, vx: number, vy: number) {
    this.preview(1, 0, 0);
    z = clampZoom(z);
    const old = this.layout, changed = z !== this.zoomLevel;
    this.zoomLevel = this.stats.nav.zoom = z;
    this.stats.nav.at = performance.now();
    if (!this.store || !old) return;
    const a = anchorAt(old, x, y);
    if (changed) this.relayout(false);
    if (a && this.layout) {
      // Whole px: browsers may truncate a fractional scroll position.
      const to = scrollToKeep(this.layout, a, vx, vy);
      this.scroller.scrollLeft = Math.round(to.left);
      this.scroller.scrollTop = Math.round(to.top);
    }
    if (changed) {
      const { visible } = this.band();
      this.pages.forEach((pv, i) => {
        if (!pv.bitmap) return;
        if (visible.includes(i)) this.renderPage(pv);
        else this.dropBitmap(pv);
      });
    }
    this.update();
    this.input.viewMoved();
  }

  // ---- stats overlay

  get statsShown(): boolean {
    return !!this.statsEl && this.statsEl.style.display !== 'none';
  }

  /** Shows or hides the stats overlay (pen and navigation). */
  toggleStats() {
    if (this.statsShown) this.statsEl.hide();
    else this.statsEl.show();
    this.renderStats();
  }

  private renderStats() {
    if (this.statsShown) this.statsEl.setText([...penStatsLines(this.stats.pen, this.pen), ...eraseStatsLines(this.input.lastErase), ...this.lassoStatsLines(), ...navStatsLines(this.stats.nav)].join('\n'));
  }

  // ---- adding pages

  /**
   * Appends a page with the given template, or the note's default, and scrolls to it. `size`
   * overrides the page size (a sized template or a custom size, #27).
   */
  addPage(template?: Template, size?: Size) {
    const store = this.store;
    if (!store) return;
    const pv = this.makePage(store.addPage(template, size));
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
    new TemplateChooser(this.app, placeholder, (template, size) => {
      if (scope === 'add') this.addPage(template, size);
      else if (scope === 'page') this.setPageTemplate(this.currentPageIndex(), template, size);
      else this.setAllTemplates(template, size);
    }, templateRegistry()?.entries ?? [], scope === 'add').open();
  }

  /**
   * Puts a standard markdown embed of the current page (#27), `![](<vault path, encoded>)`,
   * on the clipboard, for pasting into any note; shows it in a notice if the clipboard fails.
   * Returns the text.
   */
  async copyPageEmbed(): Promise<string | null> {
    const pv = this.pages[this.currentPageIndex()];
    if (!this.store || !pv) return null;
    const text = markdownEmbed(pv.slot.path);
    try {
      await navigator.clipboard.writeText(text);
      new Notice('Copied the embed for this page');
    } catch (e) {
      new Notice(`Couldn't use the clipboard; the embed is: ${text}`, 0);
    }
    return text;
  }

  /**
   * Changes page `index`'s template, keeping its ink, and redraws it. Returns the template it
   * had, or null if there's no such page or it can't be read.
   */
  setPageTemplate(index: number, template: Template, size?: Size): Template | null {
    const pv = this.pages[index];
    if (!this.store || !pv) return null;
    const hadSize = { ...pv.slot.size };
    const before = this.store.setPageTemplate(pv.slot.id, template, size);
    if (before) this.relayoutRedraw([pv.slot.id]);
    if (before) this.recordPageTemplate(pv.slot.id, before, template, hadSize, size);
    return before;
  }

  /** After page sizes may have changed (#27, #21): relays out and redraws these pages. */
  private relayoutRedraw(ids: string[]) {
    this.relayout();
    for (const pv of this.pages) if (ids.includes(pv.slot.id) && pv.bitmap) this.renderPage(pv);
    this.update();
  }

  /** Changes every page's template and the note's default, and redraws. Returns what it replaced. */
  setAllTemplates(template: Template, size?: Size): TemplatesBefore | null {
    if (!this.store) return null;
    const before = this.store.setAllTemplates(template, size);
    this.relayoutRedraw(this.pages.map(p => p.slot.id));
    this.recordAllTemplates(before, template, size);
    return before;
  }

  // ---- changes on disk

  private pageChanged(slot: PageSlot) {
    const pv = this.pages.find(p => p.slot === slot);
    if (!pv) return;
    this.pagesPanel?.changed(slot.id);
    if (this.sel?.pv === pv) this.clearSelection(); // reloaded from disk: the selection may no longer exist
    this.showError(pv);
    pv.spatial = null; // reloaded from disk: rebuilt when next erased
    this.relayout(); // the size may have changed
    if (pv.bitmap) this.renderPage(pv);
    this.update();
  }

  private indexChanged() {
    this.input.cancel();
    this.clearSelection();
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
    if (this.input.lassoActive) this.input.cancel();
    this.clearSelection();
    const op = this.history.undo();
    this.updateStats();
    return !!op;
  }

  /** Repeats the latest undone edit. Returns false if there was nothing to redo. */
  redo(): boolean {
    if (!this.store) return false;
    if (this.input.lassoActive) this.input.cancel();
    this.clearSelection();
    const op = this.history.redo();
    this.updateStats();
    return !!op;
  }

  /**
   * Removes these strokes from page `pageIndex` as one undoable edit, keeps the page's eraser
   * index in step and redraws the page once. Every erase goes through here (the eraser, #7, via
   * eraseAlong). With `join`, the removal joins the previous erase if that was on the same page
   * and is still the latest edit, so one eraser drag (erasing over many frames) is one undo
   * step. Returns the removed strokes with the indices they had (see NoteStore.removeStrokes);
   * nothing is recorded if nothing was removed. Saved by the autosave.
   */
  eraseStrokes(pageIndex: number, ids: Iterable<string>, join = false): { index: number; stroke: Stroke }[] {
    const pv = this.pages[pageIndex];
    const store = this.store;
    if (!store || !pv) return [];
    const pageId = pv.slot.id;
    const removed = store.removeStrokes(pageId, ids);
    if (!removed.length) return removed;
    if (pv.spatial) for (const r of removed) pv.spatial.remove(r.stroke.id);
    this.redrawPage(pageId);
    const last = this.lastErase, depth = this.history.labels.length;
    if (join && last && last.store === store && last.pageId === pageId && last.depth === depth && !this.history.canRedo) {
      last.batches.push(removed);
      return removed;
    }
    // Each batch's indices are those before it was removed: undo puts the batches back latest first.
    const batches = [removed];
    const spatial = () => this.pages.find(p => p.slot.id === pageId)?.spatial;
    this.history.push({
      label: 'Erase',
      undo: () => {
        if (this.store !== store) return;
        const index = spatial();
        for (let i = batches.length - 1; i >= 0; i--) {
          store.insertStrokes(pageId, batches[i]);
          if (index) for (const e of batches[i]) index.add(e.stroke);
        }
        this.redrawPage(pageId);
      },
      redo: () => {
        if (this.store !== store) return;
        const ids: string[] = [];
        for (const b of batches) for (const e of b) ids.push(e.stroke.id);
        store.removeStrokes(pageId, ids);
        const index = spatial();
        if (index) for (const id of ids) index.remove(id);
        this.redrawPage(pageId);
      },
    });
    this.lastErase = { store, pageId, batches, depth: this.history.labels.length };
    return removed;
  }

  /** The latest erase edit, which the next frames of the same eraser drag join. */
  private lastErase: { store: NoteStore; pageId: string; batches: { index: number; stroke: Stroke }[][]; depth: number } | null = null;

  /**
   * Records strokes added to (`added`) or removed from a page, with the indices they have (or
   * had): undo removes or reinserts them, redo the opposite.
   */
  private recordStrokes(label: string, pageId: string, entries: { index: number; stroke: Stroke }[], added: boolean) {
    const store = this.store;
    if (!store) return;
    const ids = entries.map(e => e.stroke.id);
    // The page's eraser index (#7), if built, follows the strokes in and out.
    const spatial = () => this.pages.find(p => p.slot.id === pageId)?.spatial;
    const remove = () => {
      if (this.store !== store) return;
      store.removeStrokes(pageId, ids);
      const index = spatial();
      if (index) for (const id of ids) index.remove(id);
      this.redrawPage(pageId);
    };
    const insert = () => {
      if (this.store !== store) return;
      store.insertStrokes(pageId, entries);
      const index = spatial();
      if (index) for (const e of entries) index.add(e.stroke);
      this.redrawPage(pageId);
    };
    this.history.push({ label, undo: added ? remove : insert, redo: added ? insert : remove });
  }

  private recordPageTemplate(pageId: string, before: Template, after: Template, beforeSize?: Size, afterSize?: Size) {
    const store = this.store;
    const resized = !!afterSize && !!beforeSize && (afterSize.width !== beforeSize.width || afterSize.height !== beforeSize.height);
    if (!store || (sameTemplate(before, after) && !resized)) return;
    const set = (template: Template, size?: Size) => () => {
      if (this.store !== store) return;
      store.setPageTemplate(pageId, template, size);
      this.relayoutRedraw([pageId]);
      this.updateStats();
    };
    this.history.push({ label: 'Change page template', undo: set(before, resized ? beforeSize : undefined), redo: set(after, afterSize) });
  }

  private recordAllTemplates(before: TemplatesBefore | null, after: Template, size?: Size) {
    const store = this.store;
    if (!store || !before) return;
    const name = templateName(parseTemplate(after));
    const sameSize = (s?: Size) => !size || !s || (s.width === size.width && s.height === size.height);
    if (before.note === name && before.pages.every(p => templateName(p.template) === name && sameSize(p.size))) return;
    const redrawAll = () => this.relayoutRedraw(this.pages.map(p => p.slot.id));
    this.history.push({
      label: 'Change all templates',
      undo: () => {
        if (this.store !== store) return;
        store.setNoteTemplateName(before.note);
        for (const p of before.pages) store.setPageTemplate(p.id, p.template, p.size);
        redrawAll();
      },
      redo: () => {
        if (this.store !== store) return;
        store.setAllTemplates(after, size);
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
    if (this.sel?.pv === pv) this.clearSelection();
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

  private renderHistory() {
    this.toolbar?.render();
  }

  // ---- page management (#17)
  // The Pages panel (pages-panel.ts) and the page operations it offers: insert after, duplicate,
  // delete and move. Each is one undo step, recorded like recordAddPage; the page elements are
  // brought in line with the store's slots by syncPageViews, which the panel follows through
  // relayout.

  /** The Pages panel: thumbnails of the pages, closed by default. */
  private pagesPanel: PagesPanel | null = null;

  get pagesPanelOpen(): boolean {
    return !!this.pagesPanel?.isOpen;
  }

  /** Opens or closes the Pages panel (or sets it with `open`). */
  togglePagesPanel(open = !this.pagesPanelOpen) {
    const panel = this.pagesPanel;
    if (!panel) return;
    // Below the toolbar; the pages area narrows beside it (relaid out through the ResizeObserver).
    const bar = this.toolbar?.el;
    panel.el.style.top = bar ? `${bar.offsetTop + bar.offsetHeight}px` : '0';
    this.contentEl.toggleClass('nb-pages-open', open);
    panel.setOpen(open);
    this.toolbar?.render();
  }

  /** The panel's stats (thumbnails drawn, frame times), for tests. */
  get pagesPanelStats() {
    return this.pagesPanel?.stats ?? null;
  }

  private buildPagesPanel(root: HTMLElement) {
    this.pagesPanel = new PagesPanel(root, {
      pages: () => this.pages.map(pv => ({ id: pv.slot.id, size: pv.slot.size })),
      page: id => {
        const pv = this.pages.find(p => p.slot.id === id);
        return pv && this.store ? this.store.page(pv.slot) : null;
      },
      bitmap: id => {
        const pv = this.pages.find(p => p.slot.id === id);
        return pv?.bitmap && pv.pending == null && !this.nav.previewing ? pv.bitmap.canvas : null;
      },
      theme: () => this.theme,
      template: (template, size, w, h, onReady) => this.templates.get(template, size, w, h, this.theme, onReady),
      current: () => this.currentPageIndex(),
      go: i => this.scrollToPage(i),
      insertAfter: i => this.insertPageAfter(i),
      duplicate: i => this.duplicatePage(i),
      remove: i => this.deletePage(i),
      move: (from, to) => this.movePage(from, to),
    });
  }

  /** Scrolls so page `index` is at the top of the view. */
  scrollToPage(index: number) {
    const box = this.layout?.pages[index];
    if (!box) return;
    this.nav.stopMomentum();
    this.scroller.scrollTop = Math.max(0, box.top - MARGIN);
    this.update();
  }

  /**
   * Inserts a page after page `index` (-1: before the first) with the given template, or the
   * note's default, and scrolls to it. One undo step.
   */
  insertPageAfter(index: number, template?: Template) {
    const store = this.store;
    if (!store) return;
    const slot = store.insertPage(index + 1, template);
    this.syncPageViews();
    this.scrollToPage(store.slots.indexOf(slot));
    this.recordNewPage('Insert page', slot.id);
  }

  /** Inserts a copy of page `index` after it and scrolls to the copy. One undo step. */
  duplicatePage(index: number) {
    const store = this.store, pv = this.pages[index];
    if (!store || !pv) return;
    const slot = store.duplicatePage(pv.slot.id);
    if (!slot) {
      new Notice("This page can't be read, so it can't be duplicated");
      return;
    }
    this.syncPageViews();
    this.scrollToPage(store.slots.indexOf(slot));
    this.recordNewPage('Duplicate page', slot.id);
  }

  /**
   * Deletes page `index` and its file, without asking: it's one undo step, and undo writes the
   * file again with its content.
   */
  deletePage(index: number) {
    const store = this.store, pv = this.pages[index];
    if (!store || !pv) return;
    const pageId = pv.slot.id;
    const at = store.deletePage(pageId).index;
    this.syncPageViews();
    new Notice(`Page ${index + 1} deleted (undo brings it back)`);
    this.history.push({
      label: 'Delete page',
      undo: () => {
        if (this.store !== store) return;
        store.insertPageInIndex(pageId, at);
        this.syncPageViews();
      },
      redo: () => {
        if (this.store !== store) return;
        store.deletePage(pageId);
        this.syncPageViews();
      },
    });
  }

  /** Moves page `from` to position `to` (of the pages without it). Only the index changes. One undo step. */
  movePage(from: number, to: number) {
    const store = this.store, pv = this.pages[from];
    if (!store || !pv) return;
    const pageId = pv.slot.id;
    const before = store.movePage(pageId, to);
    const after = store.index.pages.indexOf(pageId);
    if (before < 0 || before === after) return;
    this.syncPageViews();
    const move = (i: number) => () => {
      if (this.store !== store) return;
      store.movePage(pageId, i);
      this.syncPageViews();
    };
    this.history.push({ label: 'Move page', undo: move(before), redo: move(after) });
  }

  /** Records a page inserted or duplicated: undo takes it out of the index, redo puts it back. */
  private recordNewPage(label: string, pageId: string) {
    const store = this.store;
    if (!store) return;
    let index = -1;
    this.history.push({
      label,
      undo: () => {
        if (this.store !== store) return;
        index = store.removePageFromIndex(pageId).index;
        this.syncPageViews();
      },
      redo: () => {
        if (this.store !== store) return;
        store.insertPageInIndex(pageId, index);
        this.syncPageViews();
      },
    });
  }

  /**
   * Brings the page elements in line with the store's slots (after pages were inserted,
   * removed or reordered here), keeping the elements and bitmaps of pages still there.
   */
  private syncPageViews() {
    const store = this.store;
    if (!store) return;
    this.input.cancel();
    this.clearSelection();
    const old = new Map(this.pages.map(pv => [pv.slot, pv] as const));
    this.pages = store.slots.map(slot => {
      const pv = old.get(slot);
      old.delete(slot);
      return pv ?? this.makePage(slot);
    });
    for (const pv of old.values()) {
      this.dropBitmap(pv);
      pv.el.remove();
    }
    for (const pv of this.pages) this.pagesEl.insertBefore(pv.el, this.footer);
    this.relayout();
    this.update();
  }

  // ---- the toolbar (#10)
  // The toolbar (toolbar.ts) and its picker (picker.ts) talk to the view through a host. The
  // tool in use, each tool's settings and the favourite presets live in the plugin settings:
  // restored when the view opens, saved SAVE_TOOLS_DELAY ms after the last change.

  private buildToolbar(root: HTMLElement) {
    this.toolbar = new Toolbar(root, {
      pen: () => this.pen,
      highlighter: () => this.highlighter,
      eraser: () => this.eraser,
      setTool: tool => this.setTool(tool),
      setPen: change => this.setPen(change),
      setHighlighter: change => this.setHighlighter(change),
      setEraser: change => this.setEraser(change),
      presets: () => this.presets,
      applyPreset: i => this.applyPreset(i),
      savePreset: i => this.savePreset(i),
      canUndo: () => this.history.canUndo,
      canRedo: () => this.history.canRedo,
      undo: () => void this.undo(),
      redo: () => void this.redo(),
      hasNote: () => !!this.store,
      addPage: () => this.addPage(),
      chooseTemplate: scope => this.chooseTemplate(scope),
      paperLabel: () => this.paperLabel(),
      pagesOpen: () => this.pagesPanelOpen,
      togglePages: () => this.togglePagesPanel(),
      theme: () => this.theme,
      canPaste: () => this.canPaste,
      paste: () => this.pasteStrokes(),
    });
  }

  /** The favourite presets: MAX_PRESETS slots, null for an empty one. */
  get presets(): readonly (PenPreset | null)[] {
    const saved = this.settingsHost?.settings.presets ?? this.localPresets;
    return Array.from({ length: MAX_PRESETS }, (_, i) => saved[i] ?? null);
  }

  /** The presets when the view has no settings host (never in the plugin). */
  private localPresets: (PenPreset | null)[] = DEFAULT_PRESETS.map(p => ({ ...p }));

  /** Switches to preset `index`'s tool with its colour, size and nib. */
  applyPreset(index: number) {
    const p = this.presets[index];
    if (!p) return;
    if (p.tool === 'highlighter') {
      this.highlighter = withHighlighter(this.highlighter, { color: p.color, size: p.size });
      this.setPen({ tool: 'highlighter' });
    } else this.setPen({ tool: 'pen', color: p.color, size: p.size, nib: p.nib ?? 'uniform' });
  }

  /** Saves the pen or highlighter in use as preset `index`; returns false for the eraser or a bad slot. */
  savePreset(index: number): boolean {
    const preset = presetOf(this.pen, this.highlighter);
    if (!preset || index < 0 || index >= MAX_PRESETS) return false;
    const list = [...this.presets];
    list[index] = preset;
    if (this.settingsHost) this.settingsHost.settings.presets = list;
    else this.localPresets = list;
    this.toolsChanged();
    return true;
  }

  /** Opens the picker of the tool in use under its toolbar button. */
  openPicker() {
    this.toolbar?.openPicker();
  }

  /** The current page's paper for the page settings menu. */
  private paperLabel(): string | null {
    const pv = this.pages[Math.max(0, this.currentPageIndex())];
    if (!pv) return null;
    const { width, height } = pv.slot.size;
    const is = (s: { width: number; height: number }) => s.width === width && s.height === height;
    if (is(LETTER)) return 'Letter, 8.5 × 11 in';
    if (is(A4)) return 'A4, 210 × 297 mm';
    return `${width} × ${height} px`;
  }

  private restoreTools() {
    const saved = this.settingsHost?.settings.tools;
    if (!saved) return;
    // Parsed again: the settings object may have been changed since it was read.
    const t = parseToolState(JSON.parse(JSON.stringify(saved)));
    this.pen = t.pen;
    this.highlighter = t.highlighter;
    this.eraser = t.eraser;
  }

  /** A tool, its settings or a preset changed: redraw the toolbar and save soon. */
  private toolsChanged() {
    this.toolbar?.render();
    if (!this.settingsHost) return;
    this.settingsHost.settings.tools = { pen: { ...this.pen }, highlighter: { ...this.highlighter }, eraser: { ...this.eraser } };
    window.clearTimeout(this.saveToolsTimer);
    this.saveToolsTimer = window.setTimeout(() => this.saveTools(), SAVE_TOOLS_DELAY);
  }

  private saveTools() {
    window.clearTimeout(this.saveToolsTimer);
    this.saveToolsTimer = 0;
    this.settingsHost?.saveSettings().catch(e => console.error('[notebook]', 'saving tool settings', e));
  }

  // ---- the lasso (#11)
  // The lasso tool selects strokes of one page (input.ts draws the loop and drives the drags;
  // lasso.ts is the geometry; selection.ts draws the box, the drag preview and the menu). The
  // selection is a page and stroke ids, dropped by switching tools, Escape, a tap outside it,
  // undo and redo, and when the note closes, reloads, or its pages change. Every edit is one
  // undo step: moves, resizes and recolours replace the strokes in place (NoteStore.
  // replaceStrokes; undo puts the old ones back), a move onto another page takes them off one
  // page and appends them to the other (new ids only where they'd clash), delete and cut remove
  // them, duplicate and paste append copies with new ids, selected.

  /** The selected strokes: their page, ids (in drawing order) and ink box (page px). */
  private sel: { pv: PageView; ids: string[]; box: Box } | null = null;
  /** A drag of the selection in progress. */
  private selDrag: {
    kind: 'move' | 'resize';
    strokes: Stroke[];
    /** The page the preview is over, and the move from the selection's page onto it (page px). */
    to: PageView;
    ox: number;
    oy: number;
    t: Transform;
  } | null = null;
  /** Strokes left out of a page's bitmap while they're dragged. */
  private hidden: { pv: PageView; ids: Set<string> } | null = null;
  private selOverlay: SelectionOverlay | null = null;
  private selMenu: SelectionMenu | null = null;

  /** The selection, for tests and commands: page index, stroke ids and box (page px). */
  get selection(): { page: number; ids: string[]; box: Box } | null {
    const s = this.sel;
    return s ? { page: this.pages.indexOf(s.pv), ids: [...s.ids], box: [...s.box] } : null;
  }

  /** The last selection drag's frame times (input.ts), for tests. */
  get lassoStats() {
    return { lastDrag: this.input.lastDrag, previews: this.selOverlay?.previews ?? 0 };
  }

  get selectionMenuOpen(): boolean {
    return !!this.selMenu?.isOpen;
  }

  private hiddenOn(pv: PageView): ReadonlySet<string> | null {
    return this.hidden?.pv === pv ? this.hidden.ids : null;
  }

  private lassoStatsLines(): string[] {
    const d = this.input.lastDrag;
    if (!d) return [];
    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '-');
    return [`last lasso ${d.kind}: ${this.sel?.ids.length ?? 0} selected, frame ${f(d.frameMs)} ms median (max ${f(d.frameMaxMs)}, ${d.frames} frames)`];
  }

  private get clipboard(): InkClipboard | null {
    return this.settingsHost ? this.settingsHost.inkClipboard ?? null : localClipboard;
  }

  private set clipboard(clip: InkClipboard | null) {
    if (this.settingsHost) this.settingsHost.inkClipboard = clip;
    else localClipboard = clip;
  }

  get canPaste(): boolean {
    return !!this.clipboard?.strokes.length;
  }

  /** Selects these strokes of page `pageIndex` (the lasso's tool is switched to); an empty list deselects. */
  select(pageIndex: number, ids: readonly string[]) {
    const pv = this.pages[pageIndex];
    const page = pv && this.store?.page(pv.slot);
    if (!pv || !page) return;
    if (this.pen.tool !== 'lasso') this.setTool('lasso');
    const want = new Set(ids);
    const strokes = page.strokes.filter(s => want.has(s.id));
    const box = strokesBounds(strokes);
    if (!box) {
      this.clearSelection();
      return;
    }
    this.sel = { pv, ids: strokes.map(s => s.id), box };
    this.showSelection();
  }

  clearSelection() {
    const had = this.sel || this.selDrag;
    this.sel = null;
    this.selDrag = null;
    if (this.hidden) {
      const pv = this.hidden.pv;
      this.hidden = null;
      if (pv.bitmap && this.pages.includes(pv)) this.renderPage(pv);
    }
    if (!had) return;
    this.selOverlay?.clear();
    this.selOverlay?.canvas.remove();
    this.selMenu?.hide();
  }

  /** Draws the selection's box over its page and puts the menu by it. */
  private showSelection() {
    const sel = this.sel, overlay = this.selOverlay, page = sel && this.store?.page(sel.pv.slot);
    if (!sel || !overlay || !page) return;
    overlay.place(sel.pv.el, page.size);
    overlay.drawBox(sel.box);
    const r = sel.pv.el.getBoundingClientRect(), k = r.width / page.size.width;
    const bar = this.toolbar?.el;
    this.selMenu?.show(this.contentEl, {
      left: r.left + sel.box[0] * k, top: r.top + sel.box[1] * k, right: r.left + sel.box[2] * k, bottom: r.top + sel.box[3] * k,
    }, bar ? bar.offsetTop + bar.offsetHeight : 0);
  }

  /** The selected strokes, in drawing order. */
  private selectedStrokes(): Stroke[] {
    const sel = this.sel, page = sel && this.store?.page(sel.pv.slot);
    if (!sel || !page) return [];
    const ids = new Set(sel.ids);
    return page.strokes.filter(s => ids.has(s.id));
  }

  private selectionHit(target: PageTarget, point: Point): SelectionHit {
    const sel = this.sel;
    if (!sel || sel.pv !== target.key || !this.layout) return null;
    return hitSelection(sel.box, point, 1 / this.layout.scale);
  }

  private selectLoop(target: PageTarget, loop: readonly Point[]) {
    const pv = target.key as PageView;
    const page = this.store && this.pages.includes(pv) ? this.store.page(pv.slot) : null;
    if (!page) return;
    this.select(this.pages.indexOf(pv), lassoSelect(page.strokes, loop));
  }

  /** The page under a client point, or null (a gap, the margin, a page that can't be read). */
  private pageUnder(clientX: number, clientY: number): PageView | null {
    const layout = this.layout;
    if (!layout || !this.store) return null;
    const r = this.pagesEl.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
    const i = layout.pages.findIndex(b => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height);
    const pv = this.pages[i];
    return pv && this.store.page(pv.slot) ? pv : null;
  }

  private dragSelection(kind: 'move' | 'resize', from: Point, to: Point, clientX: number, clientY: number) {
    const sel = this.sel, store = this.store, layout = this.layout, overlay = this.selOverlay;
    if (!sel || !store || !layout || !overlay) return;
    let d = this.selDrag;
    if (!d) {
      // Start: the page without the selection; the selection on the overlay.
      d = this.selDrag = { kind, strokes: this.selectedStrokes(), to: sel.pv, ox: 0, oy: 0, t: moveBy(0, 0) };
      this.selMenu?.hide();
      this.hidden = { pv: sel.pv, ids: new Set(sel.ids) };
      if (sel.pv.bitmap) this.renderPage(sel.pv);
    }
    let dest = sel.pv;
    if (kind === 'resize') d.t = resizeBy(sel.box, resizeScale(sel.box, from, to));
    else {
      d.t = moveBy(roundXY(to.x - from.x), roundXY(to.y - from.y));
      dest = this.pageUnder(clientX, clientY) ?? sel.pv;
    }
    const a = layout.pages[this.pages.indexOf(sel.pv)], b = layout.pages[this.pages.indexOf(dest)];
    d.ox = roundXY((a.left - b.left) / layout.scale);
    d.oy = roundXY((a.top - b.top) / layout.scale);
    const page = store.page(dest.slot)!;
    if (d.to !== dest || overlay.canvas.parentElement !== dest.el) overlay.place(dest.el, page.size);
    d.to = dest;
    overlay.drawDrag(d.strokes, d.t, d.ox, d.oy, sel.box, pageTheme(page, this.theme));
  }

  private endSelectionDrag(cancelled: boolean) {
    const d = this.selDrag, sel = this.sel;
    this.selDrag = null;
    const hidden = this.hidden;
    this.hidden = null;
    if (!d || !sel || !this.store) {
      if (hidden?.pv.bitmap && this.pages.includes(hidden.pv)) this.renderPage(hidden.pv);
      return;
    }
    const same = d.to === sel.pv;
    if (cancelled || (same && isIdentity(d.t)) || !d.strokes.length) {
      if (sel.pv.bitmap) this.renderPage(sel.pv);
      this.showSelection();
      return;
    }
    if (same) {
      const entries = d.strokes.map(s => ({ id: s.id, stroke: transformStroke(s, d.t) }));
      this.replaceRecorded(d.kind === 'move' ? 'Move selection' : 'Resize selection', sel.pv, entries);
      this.select(this.pages.indexOf(sel.pv), entries.map(e => e.stroke.id));
      return;
    }
    this.moveAcross(sel.pv, d.to, d.strokes, { ...d.t, dx: d.t.dx + d.ox, dy: d.t.dy + d.oy });
  }

  /** The page's eraser index, if built, follows strokes out and in. */
  private reindex(pageId: string, out: Iterable<string>, add: Iterable<Stroke>) {
    const index = this.pages.find(p => p.slot.id === pageId)?.spatial;
    if (!index) return;
    for (const id of out) index.remove(id);
    for (const s of add) index.add(s);
  }

  /** Replaces strokes of a page in place as one undo step (undo puts the old ones back). */
  private replaceRecorded(label: string, pv: PageView, entries: { id: string; stroke: Stroke }[]) {
    const store = this.store;
    if (!store) return;
    const pageId = pv.slot.id;
    const apply = (list: { id: string; stroke: Stroke }[]) => {
      const old = store.replaceStrokes(pageId, list);
      this.reindex(pageId, old.map(o => o.stroke.id), list.map(e => e.stroke));
      this.redrawPage(pageId);
      return old;
    };
    const before = apply(entries).map(o => ({ id: o.stroke.id, stroke: o.stroke }));
    if (!before.length) return;
    this.history.push({
      label,
      undo: () => {
        if (this.store === store) apply(before);
      },
      redo: () => {
        if (this.store === store) apply(entries);
      },
    });
  }

  /** Appends strokes to a page as one undo step, and selects them. */
  private appendRecorded(label: string, pv: PageView, strokes: Stroke[]) {
    const store = this.store, page = store?.page(pv.slot);
    if (!store || !page || !strokes.length) return;
    const entries = strokes.map((stroke, i) => ({ index: page.strokes.length + i, stroke }));
    store.insertStrokes(pv.slot.id, entries);
    this.reindex(pv.slot.id, [], strokes);
    this.redrawPage(pv.slot.id);
    this.recordStrokes(label, pv.slot.id, entries, true);
    this.select(this.pages.indexOf(pv), strokes.map(s => s.id));
  }

  /**
   * Moves strokes from page `from` to the end of page `to`, transformed by `t` (which includes
   * the offset between the pages), with new ids where they'd clash; one undo step. Selects them.
   */
  private moveAcross(from: PageView, to: PageView, strokes: Stroke[], t: Transform) {
    const store = this.store, dst = store?.page(to.slot);
    if (!store || !dst) return;
    const src = from.slot.id, dstId = to.slot.id, ids = strokes.map(s => s.id);
    const moved = withIds(strokes.map(s => transformStroke(s, t)), new Set(dst.strokes.map(s => s.id)), false);
    const entries = moved.map((stroke, i) => ({ index: dst.strokes.length + i, stroke }));
    const movedIds = moved.map(s => s.id);
    let removed: { index: number; stroke: Stroke }[] = [];
    const apply = () => {
      removed = store.removeStrokes(src, ids);
      store.insertStrokes(dstId, entries);
      this.reindex(src, ids, []);
      this.reindex(dstId, [], moved);
      this.redrawPage(src);
      this.redrawPage(dstId);
    };
    apply();
    this.history.push({
      label: 'Move selection to another page',
      undo: () => {
        if (this.store !== store) return;
        store.removeStrokes(dstId, movedIds);
        store.insertStrokes(src, removed);
        this.reindex(dstId, movedIds, []);
        this.reindex(src, [], removed.map(r => r.stroke));
        this.redrawPage(src);
        this.redrawPage(dstId);
      },
      redo: () => {
        if (this.store === store) apply();
      },
    });
    this.select(this.pages.indexOf(to), movedIds);
  }

  /** Sets the colour of the selected pen strokes (highlighter strokes keep theirs). One undo step. */
  recolorSelection(color: string) {
    const sel = this.sel;
    if (!sel) return;
    const c = withPen(this.pen, { color }).color; // validates
    const entries = this.selectedStrokes().filter(s => s.tool === 'pen' && s.color !== c).map(s => ({ id: s.id, stroke: { ...s, color: c } }));
    if (entries.length) this.replaceRecorded('Recolour selection', sel.pv, entries);
    this.showSelection();
  }

  /** Deletes the selected strokes. One undo step. */
  deleteSelection(label = 'Delete selection') {
    const sel = this.sel, store = this.store;
    if (!sel || !store) return;
    const pageId = sel.pv.slot.id;
    this.clearSelection();
    const removed = store.removeStrokes(pageId, sel.ids);
    if (!removed.length) return;
    this.reindex(pageId, sel.ids, []);
    this.redrawPage(pageId);
    this.recordStrokes(label, pageId, removed, false);
  }

  /**
   * Copies the selected strokes to the plugin's clipboard (so they paste into any note), and as
   * JSON tagged notebook-ink/strokes to the system clipboard where that's allowed.
   */
  copySelection() {
    const strokes = withIds(this.selectedStrokes(), new Set(), false);
    if (!strokes.length) return;
    this.clipboard = { strokes };
    try {
      const done = navigator.clipboard?.writeText(encodeClip(strokes));
      if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch {
      // no system clipboard here (or not allowed): the plugin's clipboard is enough
    }
    this.showSelection();
  }

  cutSelection() {
    this.copySelection();
    this.deleteSelection('Cut selection');
  }

  /** Puts a copy of the selection 24 px right and down, with new ids, and selects it. One undo step. */
  duplicateSelection() {
    const sel = this.sel, page = sel && this.store?.page(sel.pv.slot);
    if (!sel || !page) return;
    const taken = new Set(page.strokes.map(s => s.id));
    const copies = withIds(this.selectedStrokes().map(s => transformStroke(s, moveBy(24, 24))), taken, true);
    this.appendRecorded('Duplicate selection', sel.pv, copies);
  }

  /**
   * Pastes the copied strokes onto the current page, centred on the middle of the visible area,
   * with new ids, and selects them (with the lasso). One undo step. Returns false if there's
   * nothing to paste or no page.
   */
  pasteStrokes(): boolean {
    const clip = this.clipboard, store = this.store;
    const pv = this.pages[this.currentPageIndex()], page = pv && store?.page(pv.slot);
    const box = clip && strokesBounds(clip.strokes);
    if (!clip || !pv || !page || !box) return false;
    const r = pv.el.getBoundingClientRect(), sc = this.scroller.getBoundingClientRect(), k = page.size.width / r.width;
    const cx = (sc.left + this.scroller.clientWidth / 2 - r.left) * k, cy = (sc.top + this.scroller.clientHeight / 2 - r.top) * k;
    const t = centreOn(box, cx, cy);
    const copies = withIds(clip.strokes.map(s => transformStroke(s, t)), new Set(page.strokes.map(s => s.id)), true);
    this.clearSelection();
    this.appendRecorded('Paste', pv, copies);
    return true;
  }

  // ---- virtual page (#28)
  // As in Notability, a blank page always follows the last page, so writing never stops to add
  // one. It's only in the view: an element (.nb-ink-ghost, not .nb-ink-page) laid out after the
  // last page at the size and with the template a new page gets (the note's paper and default
  // template, as store.insertPage makes them), drawn from a blank Page that is never in the
  // store, its index, the history, the pages panel or the stats. When the pen or highlighter
  // goes down on it, pageAt makes it real first: store.addPage() (as "Add page"), a page element
  // in its place (same box, so nothing moves), a new virtual page below and an "Add page" undo
  // step; the stroke then lands on the real page. The eraser and lasso do nothing on it.
  // Pages made this way that are still empty when the note closes, at the end of the note, are
  // dropped (store.deletePage: out of the index, the file deleted if autosave wrote it), so
  // reopening shows the written pages plus the virtual one. Pages added with "Add page" or the
  // pages panel are kept.

  /** The virtual page: its element, its bitmap while near the viewport, and the blank page it draws. */
  private ghost: { el: HTMLElement; bitmap: PageBitmap | null; page: Page; key: string } | null = null;
  /** Ids of pages made from the virtual page since the note opened, for dropEmptyGhostPages. */
  private fromGhost = new Set<string>();

  /** The virtual page's element (for tests), or null. */
  get ghostEl(): HTMLElement | null {
    return this.ghost?.el ?? null;
  }

  /** Which default template and paper the virtual page shows (it's remade when they change). */
  private ghostKey(): string {
    const index = this.store!.index;
    return `${index.template} ${index.paper}`;
  }

  /**
   * The blank page a new page without a template would be, as store.insertPage makes it: the
   * note's default template, at its size if it has one (#27), else the paper size.
   */
  private ghostModel(): { page: Page; key: string } {
    const store = this.store!;
    const def = store.defaultTemplate();
    return { page: newPage('p-000000', def.size ?? store.paperSize, def.template), key: this.ghostKey() };
  }

  private makeGhost() {
    this.removeGhost();
    const el = this.pagesEl.createDiv({ cls: 'nb-ink-ghost' });
    el.setAttribute('aria-label', 'New page: write here to add it');
    this.pagesEl.insertBefore(el, this.footer);
    this.ghost = { el, bitmap: null, ...this.ghostModel() };
  }

  private removeGhost() {
    const g = this.ghost;
    if (!g) return;
    g.bitmap?.release();
    g.el.remove();
    this.ghost = null;
  }

  private placeGhost(layout: Layout) {
    const g = this.ghost, b = layout.ghost;
    if (!g || !b) return;
    const s = g.el.style;
    s.top = `${b.top}px`;
    s.left = `${b.left}px`;
    s.width = `${b.width}px`;
    s.height = `${b.height}px`;
  }

  /** Keeps the virtual page's bitmap while it's near the viewport, at its size and template. */
  private updateGhost() {
    const g = this.ghost, box = this.layout?.ghost;
    if (!g || !box || !this.store) return;
    const stale = this.ghostKey() !== g.key; // the note's default template changed
    if (stale) {
      const size = g.page.size;
      Object.assign(g, this.ghostModel());
      if (g.page.size.width !== size.width || g.page.size.height !== size.height) {
        this.relayout();
        return this.update();
      }
    }
    const top = this.scroller.scrollTop, height = this.scroller.clientHeight;
    const pageHeight = box.height / Math.max(1, this.layout!.zoom);
    const near = box.top < top + height + pageHeight && box.top + box.height > top - pageHeight;
    if (!near) {
      g.bitmap?.release();
      g.bitmap = null;
      return;
    }
    if (g.bitmap && (stale || g.bitmap.cssWidth !== box.width || g.bitmap.cssHeight !== box.height)) {
      g.bitmap.release();
      g.bitmap = null;
    }
    if (!g.bitmap) this.renderGhost();
  }

  private renderGhost() {
    const g = this.ghost, box = this.layout?.ghost;
    if (!g || !box) return;
    if (!g.bitmap || g.bitmap.cssWidth !== box.width || g.bitmap.cssHeight !== box.height) {
      g.bitmap?.release();
      g.bitmap = new PageBitmap(box.width, box.height);
      g.el.insertBefore(g.bitmap.canvas, g.el.firstChild);
    }
    const c = g.bitmap.canvas;
    const img = this.templates.get(g.page.template, g.page.size, c.width, c.height, this.theme, () => {
      if (this.ghost === g && g.bitmap) this.renderGhost();
    });
    g.bitmap.render(g.page, this.theme, img);
  }

  /**
   * The pen or highlighter went down on the virtual page: makes it a real page and returns that
   * page's target (null for the eraser and lasso, which do nothing there).
   */
  private materialiseGhost(): PageTarget | null {
    const store = this.store;
    if (!store || !this.ghost || !inksGhost(this.pen.tool)) return null;
    const slot = store.addPage();
    const page = store.page(slot);
    const pv = this.makePage(slot);
    this.pages.push(pv);
    this.fromGhost.add(slot.id);
    this.relayout(); // the new page takes the virtual page's box; the virtual page moves below
    this.update(); // draws the new page (it's where the pen is, so visible)
    this.recordAddPage(slot.id);
    if (!page) return null;
    this.penPage = page;
    return { key: pv, el: pv.el, size: page.size };
  }

  /** Drops the empty pages made from the virtual page at the end of the note (see above). */
  private dropEmptyGhostPages(store: NoteStore) {
    const pages = store.slots.map(slot => {
      // Only pages made here are looked at (parsing every page on close would be slow).
      const page = this.fromGhost.has(slot.id) && !slot.error ? store.page(slot) : null;
      return { id: slot.id, strokes: page ? page.strokes.length : null };
    });
    for (const id of emptyGhostPages(pages, this.fromGhost)) store.deletePage(id);
    this.fromGhost.clear();
  }
}

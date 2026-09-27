// The ink view: an ink note's pages stacked like paper in a native scrolling container, with
// the pen (input.ts) and the toolbar (toolbar.ts), finger panning and zoom (navigate.ts),
// autosave and reloading after changes on disk. The note's data lives in NoteStore; page
// bitmaps in PageBitmap; this file ties them to Obsidian and the DOM.
import { FileView, Notice, TAbstractFile, TFile, TFolder, type App, type WorkspaceLeaf } from 'obsidian';
import { newStrokeId } from '../format/ids';
import { isInkNote, markdownEmbed } from '../format/note';
import type { Page } from '../format/page';
import type { Template } from '../format/template';
import { isTemplateName, parseTemplate, parseTemplateName, sameTemplate, templateLabel, templateName, templateSize } from '../format/template';
import type { Stroke } from '../format/page';
import { listenForUndoTaps } from './gestures';
import { History } from './history';
import { blockFingerTouch, blockStylusTouch, eraseStatsLines, newPenStats, PenInput, penStatsLines, type EraseTally, type NewStroke, type PageTarget, type PenStats, type StrokeStyle } from './input';
import { DEFAULT_PEN, nextColor, nextSize, withPen, type PenSettings } from './pen';
import { DEFAULT_HIGHLIGHTER, nextHighlighterColor, nextHighlighterSize, withHighlighter, type HighlighterSettings, type ToolKind } from './pen';
import { DEFAULT_ERASER, nextEraserSize, withEraser, type EraserMode, type EraserSettings } from './pen';
import { DEFAULT_PRESETS, MAX_PRESETS, parseToolState, presetOf, type PenPreset } from './pen';
import { A4, LETTER, newPage, paperSize, roundXY } from '../format/page';
import type { NotebookSettings } from '../settings';
import { Toolbar } from './toolbar';
import { splitStroke } from './split';
import { bandNeed, bitmapBand, emptyGhostPages, inksGhost, layoutPages, MARGIN, mostVisiblePage, pageAtY, pagesInBand, type Band, type Layout, type PageBox } from './layout';
import { anchorAt, clampZoom, navStatsLines, Navigator, newNavStats, scrollToKeep, zoomStep, type NavStats } from './navigate';
import { currentTheme, MAX_CANVAS_PIXELS, PageBitmap, pageTheme, releaseScratch, sameBand, strokeColor, TemplateImages, warmOutlines, type TemplateSource, type Theme } from './renderer';
import { SpatialIndex } from './spatial';
import { PagesPanel } from './pages-panel';
import { NoteStore, type NoteFiles, type PageSlot, type TemplatesBefore } from './store';
import { VIEW_TYPE_INK } from './takeover';
import { NameModal, TemplateChooser, templateItems } from './template-chooser';
import { pdfCopyName, pdfPages, type RenderedPdfPage } from './template-changes';
import { isFavourite } from './favourites';
import { addImageTemplateFlow, addPdfTemplateFlow } from './pdf-template';
import { ImageSourceModal, PdfSourceModal, renderPdfPages, stripPdf, type PdfChoice } from './pdf-import';
import { cleanName } from './names';
import type { ImportKind } from './picker';
import { centreOn, encodeClip, isIdentity, lassoSelect, moveBy, resizeBy, resizeScale, strokesBounds, transformStroke, withIds, type Box, type Transform } from './lasso';
import { hitSelection, SelectionMenu, SelectionOverlay } from './selection';
import type { Point } from '../format/page';
import type { SelectionHit } from './input';
import { templateRegistry } from './templates';
import { halfLength, nearestEdge, normAngle, type Edge, type LengthUnit, type RulerState } from './ruler';
import { RulerOverlay } from './ruler-overlay';
import type { Size } from '../format/page';
import { newImageId } from '../format/ids';
import { Modal } from 'obsidian';
import { Platform } from 'obsidian';
import { exportNotePdf } from './export-pdf';
import type { PageImage } from '../format/page';
import { objectImages } from './renderer';
import {
  imageAt, imageFromTransfer, imagePageSize, imagesBounds, imagesInLoop, inkOn, offImage, pickImageFile, placeImage, prepareImage,
  transformImage, unionBox, withImageIds,
} from './images';

/** How long the view waits after a resize before redrawing bitmaps at the new size. */
const RESIZE_DELAY = 150;
/** Wait after a tool change before saving the settings, in ms. */
const SAVE_TOOLS_DELAY = 400;
/** Time per frame for computing the outlines of a page about to be drawn, in ms. */
const PUMP_BUDGET = 4;
/** Pen strokes the pump draws into a bitmap per frame. */
const PUMP_STROKES = 100;
/** A band bitmap nearing the edge of what it covers is moved once scrolling has been still this long, ms (#52). */
const BAND_SETTLE = 100;

/** Counters for tests and debugging. */
export interface InkStats {
  /** Pages of the open note whose file was read (or that were added here). */
  pagesLoaded: number;
  /** Pages that currently have a bitmap. */
  pagesRendered: number;
  /** Device pixels of the page bitmaps (those shown and those being drawn for a new band, #52). */
  bitmapPixels?: number;
  /** Band bitmaps redrawn over another part of their page as the view scrolled (#52). */
  rebands?: number;
  /** Time of the last full page render, in ms. */
  lastRenderMs: number;
  /** Time from starting to load the note to its visible pages drawn, in ms. */
  openMs: number;
  /** File writes completed by this view. */
  saves: number;
  /** Time the last page save spent building the file (writePage), in ms (#37). */
  saveMs?: number;
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
  /** "Import PDF as ink note" (#14), for the Import menu with no note open (#54). */
  importPdf?(): void;
}

/** Strokes copied or cut with the lasso (#11): copies, in page px of the page they came from, in drawing order. */
export interface InkClipboard {
  strokes: Stroke[];
  /** Images copied with them (#12), with the strokes written on them. */
  images?: PageImage[];
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
  /**
   * A band bitmap (#52) being drawn over frames, off screen, for the part of the page the view
   * has scrolled to; it replaces `bitmap` when done. `pending` is the next stroke to draw, null
   * before the paper and template are; `waiting` while the template image loads.
   */
  next?: { bitmap: PageBitmap; pending: number | null; waiting: boolean } | null;
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
  /** When the view last scrolled, resized or zoomed (update ran), and the timer for band bitmaps to follow once it's still (#52). */
  private movedAt = 0;
  private bandTimer = 0;
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
      lassoTap: (target, point) => this.selectImageAt(target, point),
      rulerEdge: (target, point, reach) => this.rulerEdge(target, point, reach),
      rulerMeasure: (target, from, to) => this.rulerMeasure(target, from, to),
      shapesOn: () => this.shapesOn,
      commitShape: (target, shape, freehand) => this.commit(target, shape, freehand),
      overlayBand: target => this.overlayBand(target),
    }, (type, fn, options) => this.registerDomEvent(this.pagesEl, type, fn, options), this.stats.pen);
    // A Pencil drag over the pages never scrolls them (blockStylusTouch); finger drags over the
    // pages move them through the navigator, never natively, and never reach Obsidian's sidebar
    // swipes (blockFingerTouch). Only on the scroller (#53): the toolbar, pickers, Pages panel
    // and selection menu are outside it and take Pencil taps and drags as they take a finger's.
    this.registerDomEvent(this.scroller, 'touchstart', e => blockStylusTouch(e), { passive: false });
    this.registerDomEvent(this.scroller, 'touchmove', e => blockStylusTouch(e) || blockFingerTouch(e, this.scroller), { passive: false });
    // A drag that starts on the toolbar, Pages panel, a picker or the selection menu (Pencil or
    // finger) scrolls natively and taps still work, but its touchmoves stop at the view, so they
    // never reach Obsidian's sidebar swipes (not prevented: passive).
    this.registerDomEvent(root, 'touchmove', e => e.stopPropagation(), { passive: true });
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
    this.rulerOverlay = new RulerOverlay({
      ruler: () => this.ruler,
      setRuler: r => this.setRuler(r),
      unit: () => this.rulerUnit,
      dark: () => this.theme.dark,
    });
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
    this.listenForImagePaste();
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
    this.rulerOverlay?.destroy();
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
      saved: () => { this.stats.saves++; this.stats.saveMs = store.writeMs; },
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
    this.forgetRuler(); // #20
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
      this.dropBitmap(pv);
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
    // Band bitmaps (#52) follow the view: the pump redraws one whose band the view is leaving,
    // at once when part of what's visible isn't covered, else once scrolling has been still.
    this.movedAt = performance.now();
    if ([...near].some(i => this.rebandTo(this.pages[i]) === 'soon')) {
      window.clearTimeout(this.bandTimer);
      this.bandTimer = window.setTimeout(() => this.pump(), BAND_SETTLE + 5);
    }
    this.updateGhost(); // #28
    this.updateStats();
    this.pump();
    if (this.sel && !this.selDrag) this.showSelection();
    this.placeRuler(); // #20
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
        .filter(i => this.needsDrawing(this.pages[i]))
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

  /** Whether the pump has drawing to do for a page: a bitmap to make or finish, or a band to move (#52). */
  private needsDrawing(pv: PageView): boolean {
    if (pv.slot.error) return false;
    if (!pv.bitmap || pv.pending != null) return true;
    if (pv.next) return !pv.next.waiting;
    const need = this.rebandTo(pv);
    return need === 'now' || (need === 'soon' && performance.now() - this.movedAt >= BAND_SETTLE);
  }

  /** Draws the next PUMP_STROKES strokes of a page's bitmap, starting it if needed. */
  private renderStep(pv: PageView, page: Page) {
    if (pv.bitmap && pv.pending == null) {
      this.rebandStep(pv, page);
      return;
    }
    if (pv.pending == null || !pv.bitmap) {
      if (!this.bitmapFor(pv)) return;
      pv.bitmap!.renderBase(page, this.theme, this.template(pv, page), this.hiddenOn(pv), this.imageReady(pv));
      pv.pending = 0;
    }
    const next = pv.bitmap!.renderPen(page, this.theme, pv.pending!, PUMP_STROKES, this.hiddenOn(pv));
    pv.pending = next < page.strokes.length ? next : null;
  }

  // ---- band bitmaps (#52)
  //
  // Past MAX_CANVAS_PIXELS a whole page can't be drawn at device resolution, so its bitmap
  // covers only a band around the viewport (bitmapBand in layout.ts), at full resolution. As the
  // view scrolls towards the edge of a band, the pump draws a new band off screen over several
  // frames, the old one staying visible, and swaps it in (rebandStep). Everything else treats a
  // band bitmap like a whole one: renderPage draws it from scratch where it is (or where the
  // view now is, if it has left it), commit draws new strokes onto it, the eraser and the
  // lasso redraw it.

  /** The page's box in the current layout, or undefined. */
  private boxOf(pv: PageView): PageBox | undefined {
    return this.layout?.pages[this.pages.indexOf(pv)];
  }

  /** What the viewport shows of a page box, in the box's CSS px (may reach past it or miss it). */
  private viewOf(box: PageBox): Band {
    const sc = this.scroller;
    return { x: sc.scrollLeft - box.left, y: sc.scrollTop - box.top, width: sc.clientWidth, height: sc.clientHeight };
  }

  /** The band a new bitmap of this page box should cover now; null: the whole page. */
  private idealBand(box: PageBox): Band | null {
    return bitmapBand(box.width, box.height, this.viewOf(box), window.devicePixelRatio || 1, MAX_CANVAS_PIXELS);
  }

  /** Whether a page's finished band bitmap should move ('soon' or 'now'), or 'ok'. */
  private rebandTo(pv: PageView): 'ok' | 'soon' | 'now' {
    const b = pv.bitmap, box = this.boxOf(pv);
    if (!b?.band || pv.pending != null || !box || b.cssWidth !== box.width || b.cssHeight !== box.height) return 'ok';
    const need = bandNeed(b.band, this.viewOf(box), box.width, box.height);
    return need !== 'ok' && sameBand(this.idealBand(box), b.band) ? 'ok' : need;
  }

  /**
   * One frame of moving a band bitmap: starts the new band (paper, template, images and
   * highlighters), then draws PUMP_STROKES pen strokes a frame, then puts it in place of the old
   * one. Strokes added meanwhile are drawn too (they're appended); anything that redraws the
   * page (renderPage) drops it.
   */
  private rebandStep(pv: PageView, page: Page) {
    const box = this.boxOf(pv);
    if (!box || !pv.bitmap) return;
    let n = pv.next;
    if (!n) {
      const band = this.idealBand(box);
      if (sameBand(band, pv.bitmap.band)) return;
      n = pv.next = { bitmap: new PageBitmap(box.width, box.height, band), pending: null, waiting: false };
    }
    const job = n;
    if (job.pending == null) {
      const tpl = this.templates.layer(page.template, page.size, job.bitmap, this.theme, () => {
        if (pv.next !== job) return;
        job.waiting = false;
        this.pump();
      });
      if (tpl === 'loading') {
        job.waiting = true;
        return;
      }
      job.bitmap.renderBase(page, this.theme, tpl, this.hiddenOn(pv), this.imageReady(pv));
      job.pending = 0;
    }
    job.pending = job.bitmap.renderPen(page, this.theme, job.pending, PUMP_STROKES, this.hiddenOn(pv));
    if (job.pending < page.strokes.length) return;
    pv.el.insertBefore(job.bitmap.canvas, pv.bitmap.canvas);
    pv.bitmap.release();
    pv.bitmap = job.bitmap;
    pv.next = null;
    this.stats.rebands = (this.stats.rebands ?? 0) + 1;
  }

  /** Drops a band being drawn off screen. */
  private dropNext(pv: PageView) {
    if (!pv.next) return;
    pv.next.bitmap.release();
    pv.next = null;
  }

  /**
   * The live overlays' band for a page (#52; the pen asks at pointerdown and when the view
   * moves): the band a bitmap of the page would get now (null: the whole page) and what the
   * viewport shows of it, CSS px of the page box.
   */
  private overlayBand(target: PageTarget): { band: Band | null; view: Band } | null {
    const box = this.boxOf(target.key as PageView);
    if (!box) return null;
    return { band: this.idealBand(box), view: this.viewOf(box) };
  }

  /**
   * Gives the page a bitmap of its current size (keeping one that has it), covering the whole
   * page or, past MAX_CANVAS_PIXELS, a band around the viewport (#52: kept where it is unless
   * the view is leaving it); false if it has no box. The caller draws it from scratch.
   */
  private bitmapFor(pv: PageView): boolean {
    const box = this.boxOf(pv);
    if (!box) return false;
    if (pv.bitmap && (pv.bitmap.cssWidth !== box.width || pv.bitmap.cssHeight !== box.height)) this.dropBitmap(pv);
    this.dropNext(pv);
    const old = pv.bitmap?.band;
    const band = old && bandNeed(old, this.viewOf(box), box.width, box.height) !== 'now' ? old : this.idealBand(box);
    if (!pv.bitmap) {
      pv.bitmap = new PageBitmap(box.width, box.height, band);
      pv.el.insertBefore(pv.bitmap.canvas, pv.el.firstChild);
    } else pv.bitmap.setBand(band);
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
    pv.bitmap!.render(page, this.theme, this.template(pv, page), this.hiddenOn(pv), this.imageReady(pv));
    pv.pending = null;
    this.stats.lastRenderMs = performance.now() - t0;
  }

  /** The page's rasterised template, or null (then it's redrawn when the image is ready). */
  private template(pv: PageView, page: Page): TemplateSource | null {
    const t = this.templates.layer(page.template, page.size, pv.bitmap!, this.theme, () => {
      if (pv.bitmap && this.pages.includes(pv)) this.renderPage(pv);
    });
    return t === 'loading' ? null : t;
  }

  private dropBitmap(pv: PageView) {
    pv.pending = null;
    this.dropNext(pv);
    if (!pv.bitmap) return;
    pv.bitmap.release();
    pv.bitmap = null;
  }

  private updateStats() {
    this.stats.pagesRendered = this.pages.filter(pv => pv.bitmap).length;
    this.stats.bitmapPixels = this.pages.reduce((n, pv) => n + (pv.bitmap?.pixels ?? 0) + (pv.next?.bitmap.pixels ?? 0), 0);
    this.stats.pagesLoaded = this.store ? this.store.pagesLoaded : 0;
  }

  private themeChanged() {
    const theme = currentTheme();
    if (theme === this.theme) return;
    this.theme = theme;
    for (const pv of this.pages) if (pv.bitmap) this.renderPage(pv);
    if (this.ghost?.bitmap) this.renderGhost(); // #28
    this.placeRuler(true); // #20
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

  /** A finished stroke; with `freehand`, `drawn` is its straightened shape (#16, see recordStraighten). */
  private commit(target: PageTarget, drawn: NewStroke, freehand?: NewStroke) {
    const pv = target.key as PageView;
    const store = this.store;
    if (!store || !this.pages.includes(pv)) return;
    const page = store.page(pv.slot);
    if (!page) return;
    const stroke: Stroke = { id: newStrokeId(page.strokes.map(s => s.id)), ...drawn, ...this.writtenOn(page, drawn) };
    store.addStroke(pv.slot, stroke);
    pv.spatial?.add(stroke);
    if (stroke.tool === 'highlighter') this.dropNext(pv); // a band being drawn has its highlighter layer already (#52)
    if (pv.bitmap && pv.pending == null) pv.bitmap.addStroke(page, stroke, this.theme, this.template(pv, page));
    else this.renderPage(pv);
    this.updateStats();
    if (!freehand) {
      this.recordStrokes('Add stroke', pv.slot.id, [{ index: page.strokes.length - 1, stroke }], true);
      return;
    }
    // Undone, the stroke comes back freehand: redoing the add puts back the freehand stroke.
    const free: Stroke = { ...stroke, points: freehand.points };
    this.recordStrokes('Add stroke', pv.slot.id, [{ index: page.strokes.length - 1, stroke: free }], true);
    this.recordStraighten(pv.slot.id, free, stroke);
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
    new TemplateChooser(this.app, placeholder, (template, size, name) => {
      if (scope === 'add') this.addPage(template, size);
      else if (scope === 'page') this.setPageTemplate(this.currentPageIndex(), template, size);
      else this.setAllTemplates(template, size, name);
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

  /**
   * Changes every page's template and the note's default (`name`, if given, is the default's
   * `template:` name, e.g. a custom template's `tpl:<name>`, #54), and redraws. Returns what it
   * replaced.
   */
  setAllTemplates(template: Template, size?: Size, name?: string): TemplatesBefore | null {
    if (!this.store) return null;
    const before = this.store.setAllTemplates(template, size, name);
    this.relayoutRedraw(this.pages.map(p => p.slot.id));
    this.recordAllTemplates(before, template, size, name);
    return before;
  }

  // ---- custom templates and importing (#54)
  // The toolbar's Import menu (picker.ts): a PDF as pages of this note or one of its pages as a
  // template, an image as a page, as a template or onto this page, or pasted. A PDF's pages go
  // after the current page as pdf pages (the PDF copied into the page folder under a free name),
  // one "Import PDF" undo step that deletes them again. The page-settings menu saves the current
  // page's background (template and size, never its ink) as a template, and lists the favourite
  // templates for adding a page.

  /** Runs an entry of the Import menu; every entry first asks for its source (vault or device). */
  importAction(kind: ImportKind) {
    const registry = templateRegistry();
    switch (kind) {
      case 'pdf-pages':
        if (!this.store) {
          this.settingsHost?.importPdf?.(); // no note open: a new note, as "Import PDF as ink note"
          return;
        }
        new PdfSourceModal(this.app, choice => void this.importPdfIntoNote(choice), 'PDF to add after this page').open();
        return;
      case 'pdf-template':
        if (registry) void addPdfTemplateFlow(this.app, registry);
        return;
      case 'image-template':
        if (registry) void addImageTemplateFlow(this.app, registry, () => this.store?.paperSize ?? paperSize(this.settingsHost?.settings.paper ?? 'letter'));
        return;
      case 'image-page':
      case 'image-here':
        if (!this.store) {
          new Notice('Open an ink note first.');
          return;
        }
        new ImageSourceModal(this.app, file => void this.insertImageFile(file, kind === 'image-page'),
          kind === 'image-page' ? 'Image for a new page' : 'Image for this page').open();
        return;
      case 'paste-image':
        void this.pasteImage();
    }
  }

  /**
   * Inserts every page of a PDF after the current page (#54): each at its PDF page's size with
   * the page as a pdf template, the PDF copied into the page folder (`<name>.pdf`, or `<name>
   * 1.pdf`… if taken). One undo step. Resolves the new pages' ids, or null (a notice says why).
   */
  async importPdfIntoNote(choice: PdfChoice): Promise<string[] | null> {
    const store = this.store;
    if (!store) return null;
    const notice = new Notice('Importing PDF…', 0);
    let rendered: RenderedPdfPage[];
    try {
      rendered = await renderPdfPages(choice.bytes, (done, total) => notice.setMessage?.(`Importing PDF: page ${done} of ${total}`));
      if (this.store !== store) return null;
      const vault = this.app.vault, folder = store.folder;
      const file = pdfCopyName(cleanName(stripPdf(choice.basename)), n => !!vault.getAbstractFileByPath(`${folder}/${n}`));
      let acc = '';
      for (const part of folder.split('/')) {
        acc = acc ? `${acc}/${part}` : part;
        if (!vault.getAbstractFileByPath(acc)) await vault.createFolder(acc);
      }
      await vault.createBinary(`${folder}/${file}`, choice.bytes.slice(0));
      if (this.store !== store) return null;
      const at = this.currentPageIndex() + 1;
      const ids = pdfPages(file, rendered).map((p, i) => store.insertPage(at + i, p.template, p.size).id);
      this.clearSelection();
      this.syncPageViews();
      this.scrollToPage(at);
      const where: Record<string, number> = {};
      this.history.push({
        label: 'Import PDF',
        undo: () => {
          if (this.store !== store) return;
          for (const id of [...ids].reverse()) where[id] = store.deletePage(id).index;
          this.syncPageViews();
        },
        redo: () => {
          if (this.store !== store) return;
          for (const id of ids) store.insertPageInIndex(id, where[id]);
          this.syncPageViews();
        },
      });
      new Notice(`Added ${ids.length} PDF page${ids.length === 1 ? '' : 's'} after page ${at}`);
      return ids;
    } catch (e) {
      console.warn('[notebook] import PDF into the note', e);
      new Notice(`Couldn't import the PDF: ${(e as Error).message}`);
      return null;
    } finally {
      notice.hide();
    }
  }

  /**
   * Saves the current page's background, its template at its size (never its ink or images), as
   * a custom template (#54); asks for the name when none is given. A pdf page's PDF is copied
   * from the page folder beside the template. Resolves its `tpl:<name>`, or null.
   */
  async saveBackgroundAsTemplate(name?: string): Promise<string | null> {
    const store = this.store, registry = templateRegistry(), pv = this.pages[this.currentPageIndex()];
    const page = store && pv ? store.page(pv.slot) : null;
    if (!store || !registry || !page) return null;
    if (name === undefined) {
      return new Promise(resolve => new NameModal(this.app, "Save this page's background as a template", templateLabel(page.template), 'Save',
        n => void this.saveBackgroundAsTemplate(n).then(resolve), () => resolve(null)).open());
    }
    try {
      let pdf: ArrayBuffer | undefined;
      if (page.template.kind === 'pdf') {
        const f = this.app.vault.getFileByPath(`${store.folder}/${page.template.source}`);
        if (!f) throw new Error(`the PDF this page shows (${page.template.source}) isn't in the page folder`);
        pdf = await this.app.vault.readBinary(f);
      }
      const id = await registry.save(name, page.template, page.size, pdf);
      new Notice(`Saved this page's background as the template "${id.slice(4)}"`);
      return id;
    } catch (e) {
      new Notice(`Couldn't save the template: ${(e as Error).message}`);
      return null;
    }
  }

  /** The favourite templates that exist, for the page-settings menu (at most `max`). */
  favouriteTemplates(max = 5): { name: string; label: string }[] {
    const registry = templateRegistry(), favs = registry?.prefs?.favourites() ?? [];
    return templateItems(registry?.entries ?? [], false, favs).filter(i => isFavourite(favs, i.name)).slice(0, max)
      .map(i => ({ name: i.name, label: i.label }));
  }

  /** Appends a page with the named template (built-in or custom) at its size, if it has one. False if unknown. */
  addTemplatePage(name: string): boolean {
    const r = templateRegistry()?.resolve(name) ?? (isTemplateName(name) ? { template: parseTemplateName(name), size: templateSize(name) ?? undefined } : null);
    if (!r || !this.store) return false;
    this.addPage(r.template, r.size);
    return true;
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

  private recordAllTemplates(before: TemplatesBefore | null, after: Template, size?: Size, given?: string) {
    const store = this.store;
    if (!store || !before) return;
    const name = given || templateName(parseTemplate(after));
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
        store.setAllTemplates(after, size, given);
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
        return pv?.bitmap && !pv.bitmap.band && pv.pending == null && !this.nav.previewing ? pv.bitmap.canvas : null; // not a band (#52)
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
      insertImage: asPage => this.insertImage(asPage),
      pasteImage: () => void this.pasteImage(),
      exportPdf: () => void this.exportPdf(),
      importAction: kind => this.importAction(kind),
      saveTemplate: () => void this.saveBackgroundAsTemplate(),
      favouriteTemplates: () => this.favouriteTemplates(),
      addTemplatePage: name => void this.addTemplatePage(name),
      rulerOn: () => this.rulerOn,
      toggleRuler: () => this.toggleRuler(),
      rulerAngle: () => this.ruler?.angle ?? null,
      setRulerAngle: a => this.setRulerAngle(a),
      rulerUnit: () => this.rulerUnit,
      setRulerUnit: u => this.setRulerUnit(u),
    });
  }

  /** Exports the note as a PDF next to it (#18); returns its path, or null. */
  exportPdf(): Promise<string | null> {
    if (!this.store || !this.file) return Promise.resolve(null);
    return exportNotePdf(this.app.vault, this.store, this.file.path, this.file.basename, { notice: (m, t) => new Notice(m, t), ios: Platform.isIosApp });
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
  private sel: { pv: PageView; ids: string[]; box: Box; images: string[] } | null = null;
  /** A drag of the selection in progress. */
  private selDrag: {
    kind: 'move' | 'resize';
    strokes: Stroke[];
    /** Selected images (#12): they stay on their page. */
    images: PageImage[];
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
  get selection(): { page: number; ids: string[]; box: Box; images: string[] } | null {
    const s = this.sel;
    return s ? { page: this.pages.indexOf(s.pv), ids: [...s.ids], box: [...s.box], images: [...s.images] } : null;
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
    return !!(this.clipboard?.strokes.length || this.clipboard?.images?.length);
  }

  /**
   * Selects these strokes and images (#12) of page `pageIndex` (the lasso's tool is switched to);
   * nothing deselects. The box includes the ink written on the images.
   */
  select(pageIndex: number, ids: readonly string[], images: readonly string[] = []) {
    const pv = this.pages[pageIndex];
    const page = pv && this.store?.page(pv.slot);
    if (!pv || !page) return;
    if (this.pen.tool !== 'lasso') this.setTool('lasso');
    const want = new Set(ids);
    const strokes = page.strokes.filter(s => want.has(s.id));
    const wantImages = new Set(images);
    const ims = (page.images ?? []).filter(im => wantImages.has(im.id));
    const box = unionBox(strokesBounds([...strokes, ...inkOn(page.strokes, wantImages)]), imagesBounds(ims));
    if (!box) {
      this.clearSelection();
      return;
    }
    this.sel = { pv, ids: strokes.map(s => s.id), box, images: ims.map(im => im.id) };
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

  /** The selected strokes and the ink written on the selected images (#12), in drawing order. */
  private selectedStrokes(): Stroke[] {
    const sel = this.sel, page = sel && this.store?.page(sel.pv.slot);
    if (!sel || !page) return [];
    const ids = new Set(sel.ids), on = new Set(sel.images);
    return page.strokes.filter(s => ids.has(s.id) || (s.on !== undefined && on.has(s.on)));
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
    this.select(this.pages.indexOf(pv), lassoSelect(page.strokes, loop), imagesInLoop(page.images, loop));
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
      d = this.selDrag = { kind, strokes: this.selectedStrokes(), images: this.selectedImages(), to: sel.pv, ox: 0, oy: 0, t: moveBy(0, 0) };
      this.selMenu?.hide();
      this.hidden = { pv: sel.pv, ids: new Set([...d.strokes.map(s => s.id), ...sel.images]) };
      if (sel.pv.bitmap) this.renderPage(sel.pv);
    }
    let dest = sel.pv;
    if (kind === 'resize') d.t = resizeBy(sel.box, resizeScale(sel.box, from, to));
    else {
      d.t = moveBy(roundXY(to.x - from.x), roundXY(to.y - from.y));
      dest = sel.images.length ? sel.pv : this.pageUnder(clientX, clientY) ?? sel.pv; // images stay on their page
    }
    const a = layout.pages[this.pages.indexOf(sel.pv)], b = layout.pages[this.pages.indexOf(dest)];
    d.ox = roundXY((a.left - b.left) / layout.scale);
    d.oy = roundXY((a.top - b.top) / layout.scale);
    const page = store.page(dest.slot)!;
    if (d.to !== dest || overlay.canvas.parentElement !== dest.el) overlay.place(dest.el, page.size);
    d.to = dest;
    overlay.drawDrag(d.strokes, d.t, d.ox, d.oy, sel.box, pageTheme(page, this.theme), d.images);
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
    if (cancelled || (same && isIdentity(d.t)) || (!d.strokes.length && !d.images.length)) {
      if (sel.pv.bitmap) this.renderPage(sel.pv);
      this.showSelection();
      return;
    }
    if (same) {
      const entries = d.strokes.map(s => ({ id: s.id, stroke: transformStroke(s, d.t) }));
      if (d.images.length) {
        this.transformImagesRecorded(d.kind === 'move' ? 'Move selection' : 'Resize selection', sel, entries, d.images.map(im => ({ id: im.id, image: transformImage(im, d.t) })));
        return;
      }
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
    const moved = withIds(strokes.map(s => offImage(transformStroke(s, t))), new Set(dst.strokes.map(s => s.id)), false);
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
    if (sel.images.length) return this.deleteWithImages(label, sel, null);
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
    const images = this.selectedImages().map(im => ({ ...im }));
    if (!strokes.length && !images.length) return;
    this.clipboard = images.length ? { strokes, images } : { strokes };
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
    if (this.sel?.images.length) return this.deleteWithImages('Cut selection', this.sel, 'delete'); // the ink went with the copy
    this.deleteSelection('Cut selection');
  }

  /** Puts a copy of the selection 24 px right and down, with new ids, and selects it. One undo step. */
  duplicateSelection() {
    const sel = this.sel, page = sel && this.store?.page(sel.pv.slot);
    if (!sel || !page) return;
    const taken = new Set(page.strokes.map(s => s.id));
    const copies = withIds(this.selectedStrokes().map(s => transformStroke(s, moveBy(24, 24))), taken, true);
    if (sel.images.length) {
      const both = withImageIds(this.selectedImages().map(im => transformImage(im, moveBy(24, 24))), copies, new Set((page.images ?? []).map(im => im.id)), true);
      this.appendWithImages('Duplicate selection', sel.pv, both.strokes, both.images);
      return;
    }
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
    const box = clip && unionBox(strokesBounds(clip.strokes), imagesBounds(clip.images ?? []));
    if (!clip || !pv || !page || !box) return false;
    const r = pv.el.getBoundingClientRect(), sc = this.scroller.getBoundingClientRect(), k = page.size.width / r.width;
    const cx = (sc.left + this.scroller.clientWidth / 2 - r.left) * k, cy = (sc.top + this.scroller.clientHeight / 2 - r.top) * k;
    const t = centreOn(box, cx, cy);
    const copies = withIds(clip.strokes.map(s => transformStroke(s, t)), new Set(page.strokes.map(s => s.id)), true);
    this.clearSelection();
    if (clip.images?.length) {
      const both = withImageIds(clip.images.map(im => transformImage(im, t)), copies, new Set((page.images ?? []).map(im => im.id)), true);
      this.appendWithImages('Paste', pv, both.strokes, both.images);
      return true;
    }
    this.appendRecorded('Paste', pv, copies.map(offImage)); // pasted ink belongs to no image
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

  // ---- images (#12)
  // An image is inserted from a file (the picker: on the iPad, Photos or Files), the clipboard
  // (a paste event, or "Paste image" through the async clipboard) onto the current page, fitted
  // to half the page and centred in the visible area, selected; or as a page of its own (an
  // `image` template, sized to the paper's width and the image's aspect). images.ts reads and
  // encodes it; page.ts stores it. The lasso selects images (a tap on one, or a loop around its
  // centre); the selection's move, resize, copy, cut, duplicate, paste and delete take them and
  // the ink written on them (strokes whose `on` is their id: a stroke is written on the topmost
  // image under its first point) along. Images stay on their page. Deleting an image with ink
  // on it that isn't selected too asks whether to keep that ink. Every edit is one undo step.

  /** The last insert's size and times (ms), for tests and the owner's check. */
  imageStats: { width: number; height: number; sourceWidth: number; sourceHeight: number; bytes: number; decodeMs: number; encodeMs: number; totalMs: number } | null = null;
  private imageCallbacks = new WeakMap<PageView, () => void>();

  /** Redraws the page once an image it shows is decoded (one callback per page, so it's asked once). */
  private imageReady(pv: PageView): () => void {
    let f = this.imageCallbacks.get(pv);
    if (!f) {
      f = () => {
        if (pv.bitmap && this.pages.includes(pv) && this.store) this.renderPage(pv);
      };
      this.imageCallbacks.set(pv, f);
    }
    return f;
  }

  /** `{ on }` for a stroke whose first point is on an image of the page, else nothing. */
  private writtenOn(page: Page, drawn: NewStroke): { on?: string } {
    const a = drawn.points[0], im = a && imageAt(page.images, a.x, a.y);
    return im ? { on: im.id } : {};
  }

  /** The selected images, in drawing order. */
  private selectedImages(): PageImage[] {
    const sel = this.sel, page = sel && this.store?.page(sel.pv.slot);
    if (!sel || !page || !sel.images.length) return [];
    const ids = new Set(sel.images);
    return (page.images ?? []).filter(im => ids.has(im.id));
  }

  /** A lasso tap: selects the topmost image under it, if any. */
  private selectImageAt(target: PageTarget, point: Point) {
    const pv = target.key as PageView;
    const page = this.store && this.pages.includes(pv) ? this.store.page(pv.slot) : null;
    const im = page && imageAt(page.images, point.x, point.y);
    if (im) this.select(this.pages.indexOf(pv), [], [im.id]);
  }

  /** Opens the picker for an image to put on the current page, or (asPage) on a new page after it. */
  insertImage(asPage = false) {
    if (!this.store) return;
    pickImageFile(file => void this.insertImageFile(file, asPage));
  }

  /** Inserts the image on the clipboard (the async clipboard; asks the system's permission). */
  async pasteImage(): Promise<boolean> {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) return this.insertImageFile(await item.getType(type));
      }
    } catch (e) {
      console.warn('[notebook] reading the clipboard', e);
    }
    new Notice('There is no image on the clipboard.');
    return false;
  }

  /**
   * Inserts an image file: on the current page, fitted and centred in the visible area and
   * selected, or with `asPage` as a new page after the current one. One undo step. Returns false
   * if there's no note or the file can't be read (a notice says why).
   */
  async insertImageFile(file: Blob, asPage = false): Promise<boolean> {
    const store = this.store;
    if (!store) return false;
    const t0 = performance.now();
    const progress = new Notice('Inserting image…', 0);
    let im;
    try {
      im = await prepareImage(file);
    } catch (e) {
      progress.hide();
      new Notice(`Couldn't insert the image: ${(e as Error).message}`);
      return false;
    }
    progress.hide();
    if (this.store !== store) return false;
    this.imageStats = {
      width: im.width, height: im.height, sourceWidth: im.sourceWidth, sourceHeight: im.sourceHeight, bytes: im.data.length,
      decodeMs: im.decodeMs, encodeMs: im.encodeMs, totalMs: performance.now() - t0,
    };
    objectImages.get(im.data); // start decoding it for the bitmap now
    if (asPage) {
      const index = this.currentPageIndex();
      const slot = store.insertPage(index + 1, { kind: 'image', image: im.data }, imagePageSize(im.width, im.height, store.paperSize));
      this.clearSelection();
      this.syncPageViews();
      this.scrollToPage(store.slots.indexOf(slot));
      this.recordNewPage('Insert image as page', slot.id);
      return true;
    }
    const pv = this.pages[this.currentPageIndex()], page = pv && store.page(pv.slot);
    if (!pv || !page) return false;
    const r = pv.el.getBoundingClientRect(), sc = this.scroller.getBoundingClientRect(), k = page.size.width / Math.max(1, r.width);
    const cx = (sc.left + this.scroller.clientWidth / 2 - r.left) * k, cy = (sc.top + this.scroller.clientHeight / 2 - r.top) * k;
    const box = placeImage(im.width, im.height, page.size, cx, cy);
    const image: PageImage = { id: newImageId((page.images ?? []).map(i => i.id)), ...box, data: im.data };
    this.clearSelection();
    this.appendWithImages('Insert image', pv, [], [image]);
    return true;
  }

  /** Pasting an image file (a screenshot, a copied photo) while the view has focus inserts it. */
  private listenForImagePaste() {
    this.registerDomEvent(document, 'paste', (e: ClipboardEvent) => {
      if (!this.store) return;
      const t = e.target as Node | null;
      const here = t && this.containerEl.contains(t);
      const idle = (t === document.body || t === document.documentElement) && this.app.workspace.getActiveViewOfType(InkView) === this;
      if (!here && !idle) return;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      const file = imageFromTransfer(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      void this.insertImageFile(file);
    });
  }

  /** Adds images (on top) and strokes (at the end) to a page as one undo step, and selects them. */
  private appendWithImages(label: string, pv: PageView, strokes: Stroke[], images: PageImage[]) {
    const store = this.store, page = store?.page(pv.slot);
    if (!store || !page || (!strokes.length && !images.length)) return;
    const pageId = pv.slot.id, ids = strokes.map(s => s.id), imageIds = images.map(im => im.id);
    const entries = strokes.map((stroke, i) => ({ index: page.strokes.length + i, stroke }));
    const add = () => {
      if (this.store !== store) return;
      for (const im of images) store.addImage(pageId, im);
      store.insertStrokes(pageId, entries);
      this.reindex(pageId, [], strokes);
      this.redrawPage(pageId);
    };
    const remove = () => {
      if (this.store !== store) return;
      store.removeStrokes(pageId, ids);
      store.removeImages(pageId, imageIds);
      this.reindex(pageId, ids, []);
      this.redrawPage(pageId);
    };
    add();
    this.history.push({ label, undo: remove, redo: add });
    const onThem = new Set(imageIds);
    this.select(this.pages.indexOf(pv), strokes.filter(s => s.on === undefined || !onThem.has(s.on)).map(s => s.id), imageIds);
  }

  /** Moves or resizes selected images and strokes in place as one undo step; keeps them selected. */
  private transformImagesRecorded(label: string, sel: { pv: PageView; ids: string[]; images: string[] }, strokes: { id: string; stroke: Stroke }[],
    images: { id: string; image: PageImage }[]) {
    const store = this.store;
    if (!store) return;
    const pageId = sel.pv.slot.id;
    const apply = (se: { id: string; stroke: Stroke }[], ie: { id: string; image: PageImage }[]) => {
      const old = store.replaceStrokes(pageId, se);
      const oldImages = store.replaceImages(pageId, ie);
      this.reindex(pageId, old.map(o => o.stroke.id), se.map(e => e.stroke));
      this.redrawPage(pageId);
      return { se: old.map(o => ({ id: o.stroke.id, stroke: o.stroke })), ie: oldImages };
    };
    const before = apply(strokes, images);
    this.history.push({
      label,
      undo: () => {
        if (this.store === store) apply(before.se, before.ie);
      },
      redo: () => {
        if (this.store === store) apply(strokes, images);
      },
    });
    this.select(this.pages.indexOf(sel.pv), sel.ids, sel.images);
  }

  /**
   * Deletes the selection with its images. Ink written on them that isn't selected is deleted
   * too, or kept (no longer on an image), as `answer` says; with no answer, asks when there is
   * such ink. One undo step.
   */
  private deleteWithImages(label: string, sel: { pv: PageView; ids: string[]; images: string[] }, answer: 'keep' | 'delete' | null) {
    const store = this.store, page = store?.page(sel.pv.slot);
    if (!store || !page) return;
    const selected = new Set(sel.ids);
    const onInk = inkOn(page.strokes, sel.images).filter(s => !selected.has(s.id));
    if (onInk.length && !answer) {
      new KeepInkModal(this.app, onInk.length, a => {
        if (a && this.store === store) this.deleteWithImages(label, sel, a);
      }).open();
      return;
    }
    const pageId = sel.pv.slot.id;
    const removeIds = answer === 'delete' ? [...sel.ids, ...onInk.map(s => s.id)] : [...sel.ids];
    const keep = answer === 'keep' ? onInk.map(s => ({ id: s.id, stroke: offImage(s) })) : [];
    this.clearSelection();
    let removed: { index: number; stroke: Stroke }[] = [], kept: { index: number; stroke: Stroke }[] = [], images: { index: number; image: PageImage }[] = [];
    const apply = () => {
      removed = store.removeStrokes(pageId, removeIds);
      kept = store.replaceStrokes(pageId, keep);
      images = store.removeImages(pageId, sel.images);
      this.reindex(pageId, [...removeIds, ...keep.map(e => e.id)], keep.map(e => e.stroke));
      this.redrawPage(pageId);
    };
    apply();
    this.history.push({
      label,
      undo: () => {
        if (this.store !== store) return;
        for (const { index, image } of images) store.addImage(pageId, image, index);
        store.insertStrokes(pageId, removed);
        store.replaceStrokes(pageId, kept.map(o => ({ id: o.stroke.id, stroke: o.stroke })));
        this.reindex(pageId, keep.map(e => e.id), [...removed.map(r => r.stroke), ...kept.map(o => o.stroke)]);
        this.redrawPage(pageId);
      },
      redo: () => {
        if (this.store === store) apply();
      },
    });
  }

  // ---- shapes (#16)
  // A stroke held still at its end is straightened (input.ts, shapes.ts) and committed as its
  // shape: two undo steps, "Straighten" (back to the freehand stroke, same id and place) and the
  // usual "Add stroke". The freehand points live only in the history, never in the file.
  // Recognition is on by default; the "Toggle shape recognition" command turns it off for the
  // view (not saved).

  /** Whether held strokes are straightened. */
  shapesOn = true;

  toggleShapes() {
    this.shapesOn = !this.shapesOn;
    new Notice(this.shapesOn ? 'Shape recognition on' : 'Shape recognition off');
  }

  /** Records a straightened stroke: undo swaps in the freehand stroke, redo the shape. */
  private recordStraighten(pageId: string, free: Stroke, shape: Stroke) {
    const store = this.store;
    if (!store) return;
    const spatial = () => this.pages.find(p => p.slot.id === pageId)?.spatial;
    const swap = (from: Stroke, to: Stroke) => () => {
      if (this.store !== store) return;
      const [was] = store.removeStrokes(pageId, [from.id]);
      if (!was) return;
      store.insertStrokes(pageId, [{ index: was.index, stroke: to }]);
      const index = spatial();
      if (index) {
        index.remove(from.id);
        index.add(to);
      }
      this.redrawPage(pageId);
    };
    this.history.push({ label: 'Straighten', undo: swap(shape, free), redo: swap(free, shape) });
  }

  // ---- the ruler (#20)
  // A toggle, not a tool: the pen or highlighter stays in use. The ruler is shown over one page
  // (page px: centre and angle; ruler.ts is the geometry, ruler-overlay.ts the layer and the
  // fingers), placed over the current page when turned on, and stays on that page, where it is,
  // through scrolls and zooms. It's kept while the note is open (turning it off and on again
  // puts it back where it was if its page is the current one) and never saved. A pen or
  // highlighter stroke starting near one of its edges is drawn along it (input.ts), with its
  // length shown in cm or inches (rulerUnit, set in the pen and highlighter pickers).

  private rulerOverlay: RulerOverlay | null = null;
  /** Whether the ruler is shown. */
  rulerOn = false;
  private ruler: RulerState | null = null;
  private rulerPage: PageView | null = null;
  /** The unit of the length label and the ticks. */
  rulerUnit: LengthUnit = 'cm';

  /** The ruler for tests and commands: on, its page index, centre (page px) and angle. */
  get rulerState(): { on: boolean; page: number; cx: number; cy: number; angle: number } | null {
    const r = this.ruler;
    if (!r) return null;
    return { on: this.rulerOn, page: this.rulerPage ? this.pages.indexOf(this.rulerPage) : -1, cx: r.cx, cy: r.cy, angle: r.angle };
  }

  /** The ruler's layer, for tests. */
  get rulerLayer(): RulerOverlay | null {
    return this.rulerOverlay;
  }

  /** Shows or hides the ruler (toggles without an argument). */
  toggleRuler(on = !this.rulerOn) {
    this.rulerOn = on;
    if (on) {
      // Back on: over the current page, where it was if that's its page.
      const cur = this.pages[Math.max(0, this.currentPageIndex())];
      if (this.rulerPage !== cur) this.rulerPage = null;
    }
    this.placeRuler(true);
    this.toolbar?.render();
  }

  /** Sets the ruler's angle (degrees, counter-clockwise), turning it on if needed. */
  setRulerAngle(angle: number) {
    if (!Number.isFinite(angle)) return;
    if (!this.rulerOn) this.toggleRuler(true);
    if (!this.ruler) return;
    this.setRuler({ ...this.ruler, angle: normAngle(angle) });
    this.toolbar?.render();
  }

  /** Moves the ruler's centre (page px of its page), for tests and commands. */
  setRulerCentre(cx: number, cy: number) {
    if (this.ruler) this.setRuler({ ...this.ruler, cx, cy });
  }

  setRulerUnit(unit: LengthUnit) {
    this.rulerUnit = unit;
    this.placeRuler(true);
    this.toolbar?.render();
  }

  /** Opens the angle input on the ruler's label. */
  editRulerAngle() {
    if (!this.rulerOn) this.toggleRuler(true);
    this.rulerOverlay?.openInput();
  }

  private setRuler(r: RulerState) {
    const pv = this.rulerPage, page = pv && this.store?.page(pv.slot);
    if (!page) return;
    // The centre stays on the page, so the ruler can't be lost off it.
    this.ruler = { cx: Math.min(page.size.width, Math.max(0, r.cx)), cy: Math.min(page.size.height, Math.max(0, r.cy)), angle: normAngle(r.angle) };
    this.rulerOverlay?.render();
  }

  /** Puts the ruler's layer over its page (choosing the current page if it has none), or hides it. */
  private placeRuler(force = false) {
    const overlay = this.rulerOverlay;
    if (!overlay) return;
    if (!this.rulerOn || !this.store || !this.layout) {
      overlay.hide();
      return;
    }
    let pv = this.rulerPage;
    if (!pv || !this.pages.includes(pv) || !this.store.page(pv.slot)) {
      pv = this.pages[Math.max(0, this.currentPageIndex())] ?? null;
      const page = pv && this.store.page(pv.slot);
      if (!pv || !page) {
        overlay.hide();
        return;
      }
      this.rulerPage = pv;
      this.ruler = { ...this.visibleCentre(pv, page.size), angle: this.ruler?.angle ?? 0 };
      force = true;
    }
    overlay.place(pv.el, this.store.page(pv.slot)!.size, force);
  }

  /** The middle of the part of a page in view, page px. */
  private visibleCentre(pv: PageView, size: Size): { cx: number; cy: number } {
    const r = pv.el.getBoundingClientRect(), v = this.scroller.getBoundingClientRect();
    const x0 = Math.max(r.left, v.left), x1 = Math.min(r.right, v.right), y0 = Math.max(r.top, v.top), y1 = Math.min(r.bottom, v.bottom);
    const k = size.width / Math.max(1, r.width);
    const cx = x1 > x0 ? ((x0 + x1) / 2 - r.left) * k : size.width / 2, cy = y1 > y0 ? ((y0 + y1) / 2 - r.top) * k : size.height / 2;
    return { cx: Math.min(size.width, Math.max(0, cx)), cy: Math.min(size.height, Math.max(0, cy)) };
  }

  /** The note closed: the ruler goes (it's never saved). */
  private forgetRuler() {
    this.rulerOn = false;
    this.ruler = null;
    this.rulerPage = null;
    this.rulerOverlay?.hide();
  }

  private rulerEdge(target: PageTarget, point: { x: number; y: number }, reach: number): Edge | null {
    if (!this.rulerOn || !this.ruler || target.key !== this.rulerPage || !this.rulerOverlay?.shown) return null;
    const t = this.pen.tool;
    if (t !== 'pen' && t !== 'highlighter') return null;
    // Only where the ruler is (its ends are beyond the page anyway).
    const L = halfLength(target.size), d = Math.abs((point.x - this.ruler.cx) * Math.cos(this.ruler.angle * Math.PI / 180) - (point.y - this.ruler.cy) * Math.sin(this.ruler.angle * Math.PI / 180));
    if (d > L) return null;
    return nearestEdge(this.ruler, point, reach);
  }

  private rulerMeasure(target: PageTarget, from: Point | null, to: Point | null) {
    const overlay = this.rulerOverlay;
    if (!overlay) return;
    if (!from || !to || target.key !== this.rulerPage) {
      overlay.showLength(null);
      return;
    }
    overlay.showLength(to, Math.hypot(to.x - from.x, to.y - from.y));
  }
}

/** Asks whether to keep the writing on images being deleted. Answers 'keep', 'delete', or null (cancelled). */
class KeepInkModal extends Modal {
  private answered = false;

  constructor(app: App, private strokes: number, private onAnswer: (answer: 'keep' | 'delete' | null) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('Keep the ink written on it?');
    this.contentEl.createEl('p', {
      text: `${this.strokes} stroke${this.strokes === 1 ? ' was' : 's were'} written on the image. Keep ${this.strokes === 1 ? 'it' : 'them'} on the page, or delete ${this.strokes === 1 ? 'it' : 'them'} with the image?`,
    });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const answer = (a: 'keep' | 'delete' | null) => {
      if (this.answered) return;
      this.answered = true;
      this.close();
      this.onAnswer(a);
    };
    buttons.createEl('button', { text: 'Keep the ink', cls: 'mod-cta nb-keep-ink' }).addEventListener('click', () => answer('keep'));
    buttons.createEl('button', { text: 'Delete the ink too', cls: 'mod-warning nb-delete-ink' }).addEventListener('click', () => answer('delete'));
    buttons.createEl('button', { text: 'Cancel', cls: 'nb-cancel-delete' }).addEventListener('click', () => answer(null));
  }

  onClose() {
    this.contentEl.empty();
    if (!this.answered) {
      this.answered = true;
      this.onAnswer(null);
    }
  }
}

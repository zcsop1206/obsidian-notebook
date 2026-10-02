import { MarkdownView, Notice, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';
import type { Hotkey } from 'obsidian';
import { Recorder } from './debug/recorder';
import { DebugView, VIEW_TYPE_DEBUG } from './debug/view';
import { LOG_PREFIX } from './debug/util';
import { createInkNote, NewNoteModal, targetFolder } from './ink/new-note';
import { cachedIsInk, installTakeover, VIEW_TYPE_INK } from './ink/takeover';
import type { PenStats } from './ink/input';
import type { NavStats } from './ink/navigate';
import { InkView, type InkClipboard } from './ink/view';
import { RenameHandler } from './ink/rename';
import { importPdf, PdfNameModal, PdfSourceModal, type PdfChoice } from './ink/pdf-import';
import { PdfPages, type PdfNote } from './ink/pdf';
import { setSharpPdfRenderer } from './ink/renderer';
import type { PdfTemplate } from './format/template';
import { paperSize, type NotePaper } from './format/page';
import { isTemplateName } from './format/template';
import { addImageTemplateFlow, addPdfTemplateAs, addPdfTemplateFlow } from './ink/pdf-template';
import { setTemplateRegistry, TemplateRegistry } from './ink/templates';
import { defaultTemplateName, settingsPrefs } from './ink/favourites';
import { TemplateChooser } from './ink/template-chooser';
import { DEFAULT_SETTINGS, NotebookSettingTab, parseSettings, type NotebookSettings } from './settings';

/**
 * Notebook: handwritten notes with the Apple Pencil, stored as SVG pages in the vault.
 * Markdown files with `ink:` frontmatter open in the ink view. Also holds the spike's ink
 * debug view and test recorder.
 */
export default class NotebookPlugin extends Plugin {
  recorder!: Recorder;
  /** Sharp renders of PDF pages (#14); `renders` counts them, for the tests. */
  pdfPages!: PdfPages;
  settings: NotebookSettings = { ...DEFAULT_SETTINGS };
  /** Strokes copied with the lasso (#11), in memory, so they paste into any open note. */
  inkClipboard: InkClipboard | null = null;
  /** Custom templates in the templates folder (#21, #54). */
  templates!: TemplateRegistry;

  async onload() {
    this.settings = parseSettings(await this.loadData());

    this.registerView(VIEW_TYPE_INK, leaf => new InkView(leaf, this));
    this.register(installTakeover(this.app));
    // Renaming or moving an ink note moves its page folder along (#26).
    const renames = new RenameHandler(this.app);
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => void renames.onRename(file, oldPath)));
    // Embeds rewritten by Obsidian's link update go back to relative paths (#62).
    this.registerEvent(this.app.vault.on('modify', file => void renames.onModify(file)));
    this.addRibbonIcon('pencil', 'New ink note', () => this.newInkNote());
    this.addCommand({ id: 'new-ink-note', name: 'New ink note', callback: () => this.newInkNote() });
    this.addCommand({
      id: 'open-as-ink-note',
      name: 'Open as ink note',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file;
        if (!view || !file || !cachedIsInk(this.app, file)) return false;
        if (!checking) void this.openAsInk(file, view.leaf);
        return true;
      },
    });
    this.addTemplateCommand('change-page-template', 'Change template of this page', 'page');
    this.addTemplateCommand('change-all-templates', 'Change template of all pages', 'all');
    // Pen commands for desktop and the tests; the toolbar (#10) does the same.
    this.addInkCommand('pen-nib-uniform', 'Use the uniform pen', view => view.setPen({ nib: 'uniform' }));
    this.addInkCommand('pen-nib-pressure', 'Use the pressure pen', view => view.setPen({ nib: 'pressure' }));
    this.addInkCommand('pen-next-color', 'Next pen colour', view => view.nextColor());
    this.addInkCommand('pen-next-size', 'Next pen size', view => view.nextSize());
    this.addInkCommand('tool-pen', 'Use the pen', view => view.setTool('pen'));
    this.addInkCommand('tool-highlighter', 'Use the highlighter', view => view.setTool('highlighter'));
    this.addInkCommand('highlighter-next-color', 'Next highlighter colour', view => view.nextHighlighterColor());
    this.addInkCommand('highlighter-next-size', 'Next highlighter size', view => view.nextHighlighterSize());
    this.addInkCommand('toggle-ink-stats', 'Toggle ink stats overlay', view => view.toggleStats());
    this.addHistoryCommand('undo', 'Undo', { modifiers: ['Mod'], key: 'z' }, view => view.undo());
    this.addHistoryCommand('redo', 'Redo', { modifiers: ['Mod', 'Shift'], key: 'z' }, view => view.redo());
    // The eraser (#7), also in the toolbar.
    this.addInkCommand('tool-eraser', 'Use the eraser', view => view.setTool('eraser'));
    this.addInkCommand('eraser-next-size', 'Next eraser size', view => view.nextEraserSize());
    // The partial eraser (#15): erase only the part under the eraser, or whole strokes.
    this.addInkCommand('eraser-partial', 'Use the partial eraser', view => { view.setTool('eraser'); view.setEraser({ mode: 'partial' }); });
    this.addInkCommand('eraser-stroke', 'Use the stroke eraser', view => { view.setTool('eraser'); view.setEraser({ mode: 'stroke' }); });
    // Zoom (#9) in 25% steps, for desktop and the tests; on the iPad, pinch.
    this.addInkCommand('zoom-in', 'Zoom in', view => view.zoomIn());
    this.addInkCommand('zoom-out', 'Zoom out', view => view.zoomOut());
    this.addInkCommand('zoom-reset', 'Reset zoom to 100%', view => view.resetZoom());
    this.addInkCommand('toggle-pages-panel', 'Toggle pages panel', view => view.togglePagesPanel());
    // The toolbar (#10): the picker of the tool in use, as a second tap on its button opens it.
    this.addInkCommand('open-tool-picker', 'Open the picker of the tool in use', view => view.openPicker());
    // The lasso (#11): select, move, resize, recolour; paste what was copied into this note.
    this.addInkCommand('tool-lasso', 'Use the lasso', view => view.setTool('lasso'));
    this.addInkCommand('toggle-ruler', 'Toggle ruler', view => view.toggleRuler()); // #20
    this.addInkCommand('ruler-angle', 'Type the ruler angle', view => view.editRulerAngle());
    this.addInkCommand('toggle-shapes', 'Toggle shape recognition', view => view.toggleShapes()); // #16
    this.addCommand({
      id: 'paste-strokes',
      name: 'Paste strokes',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(InkView);
        if (!view || !view.store || !view.canPaste) return false;
        if (!checking) view.pasteStrokes();
        return true;
      },
    });
    // Images (#12): on the current page, as a page of their own, or from the clipboard.
    this.addInkCommand('insert-image', 'Insert image', view => view.insertImage(false));
    this.addInkCommand('insert-image-page', 'Insert image as a whole page', view => view.insertImage(true));
    this.addInkCommand('paste-image', 'Paste image', view => void view.pasteImage());
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
      if (!(file instanceof TFile) || !leaf || leaf.view.getViewType() !== 'markdown' || !cachedIsInk(this.app, file)) return;
      menu.addItem(item => item.setTitle('Open as ink note').setIcon('pencil').onClick(() => void this.openAsInk(file, leaf)));
    }));
    this.addSettingTab(new NotebookSettingTab(this.app, this));
    // PDF import (#14), and sharp rendering of PDF pages in the ink view.
    this.addCommand({ id: 'import-pdf', name: 'Import PDF as ink note', callback: () => this.importPdf() });
    const pdfPages = this.pdfPages = new PdfPages(this.app.vault, t => this.noteOfTemplate(t));
    setSharpPdfRenderer((t, w, h) => pdfPages.render(t, w, h));
    this.register(() => {
      setSharpPdfRenderer(null);
      pdfPages.destroy();
    });

    // Sized templates and page embeds (#27), PDF templates (#21).
    const templates = this.templates = new TemplateRegistry(this.app, () => this.settings.templatesFolder);
    templates.prefs = settingsPrefs(this); // favourite templates (#54)
    templates.watch(this);
    this.register(setTemplateRegistry(templates));
    this.app.workspace.onLayoutReady(() => void templates.load());
    this.addInkCommand('copy-page-embed', 'Copy embed for this page', view => void view.copyPageEmbed());
    // Export (#18): all pages as one PDF next to the note; on the iPad also the share sheet.
    this.addCommand({
      id: 'export-pdf',
      name: 'Export note as PDF',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(InkView);
        if (!view || !view.store) return false;
        if (!checking) void view.exportPdf();
        return true;
      },
    });
    this.addCommand({ id: 'add-pdf-template', name: 'Add PDF template', callback: () => this.addPdfTemplate() });
    // Custom templates and the Import menu (#54).
    this.addInkCommand('import-pdf-pages', 'Import PDF as pages after this page', view => view.importAction('pdf-pages'));
    this.addCommand({ id: 'add-image-template', name: 'Add image template', callback: () => void this.addImageTemplate() });
    this.addCommand({
      id: 'save-page-template',
      name: "Save this page's background as a template",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(InkView);
        if (!view || !view.store) return false;
        if (!checking) void view.saveBackgroundAsTemplate();
        return true;
      },
    });
    this.addCommand({ id: 'toggle-favourite-template', name: 'Star or unstar a template', callback: () => this.toggleFavouriteTemplate() });

    this.recorder = new Recorder(this);
    this.registerView(VIEW_TYPE_DEBUG, leaf => new DebugView(leaf, this));
    this.addCommand({ id: 'open-debug-view', name: 'Open ink debug view', callback: () => this.openDebugView() });
    this.addCommand({ id: 'toggle-recording', name: 'Start or stop test recording', callback: () => this.recorder.toggle() });
    this.app.workspace.onLayoutReady(() => {
      this.recorder.recover().catch(e => console.error(LOG_PREFIX, 'recover', e));
    });
  }

  onunload() {
    this.recorder.stop();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** A command shown only when an ink view is active. */
  private addInkCommand(id: string, name: string, run: (view: InkView) => void) {
    this.addCommand({
      id,
      name,
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(InkView);
        if (!view) return false;
        if (!checking) run(view);
        return true;
      },
    });
  }

  /**
   * Undo or redo in an open ink note, with a default hotkey. Outside an ink view the command
   * is unavailable, so the hotkey falls through to the markdown editor's own undo.
   */
  private addHistoryCommand(id: string, name: string, hotkey: Hotkey, run: (view: InkView) => void) {
    this.addCommand({
      id,
      name,
      hotkeys: [hotkey],
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(InkView);
        if (!view || !view.store) return false;
        if (!checking) run(view);
        return true;
      },
    });
  }

  /** The pen stats of the ink view written in most recently, or null if there's none. */
  inkPenStats(): PenStats | null {
    let best: PenStats | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      const view = leaf.view;
      if (view instanceof InkView && (!best || view.stats.pen.at > best.at)) best = view.stats.pen;
    }
    return best;
  }

  /** The navigation stats (zoom, finger gesture frame times) of the ink view navigated most recently, or null. */
  inkNavStats(): NavStats | null {
    let best: NavStats | null = null;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      const view = leaf.view;
      if (view instanceof InkView && (!best || view.stats.nav.at > best.at)) best = view.stats.nav;
    }
    return best;
  }

  /** A command, shown only in an open ink note, that opens the template chooser. */
  private addTemplateCommand(id: string, name: string, scope: 'page' | 'all') {
    this.addCommand({
      id,
      name,
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(InkView);
        if (!view || !view.store) return false;
        if (!checking) view.chooseTemplate(scope);
        return true;
      },
    });
  }

  /**
   * The template new notes start with (#54): the first favourite that exists, unless the
   * settings turn that off, else the settings' default template.
   */
  defaultTemplate(): string {
    const s = this.settings;
    return defaultTemplateName(s.template, s.favouriteDefault, s.favouriteTemplates, n => isTemplateName(n) || !!this.templates.get(n));
  }

  /** Asks for a name, paper and template, then creates the note in the active file's folder and opens it. */
  newInkNote() {
    const { paper } = this.settings;
    // The dialog lists the custom templates loaded so far (the registry loads on layout ready and
    // after each change to the templates folder).
    new NewNoteModal(this.app, { paper, template: this.defaultTemplate() }, c => void this.createInkNote(c.name, undefined, c.paper, c.template)).open();
  }

  /**
   * Creates an ink note with one page and opens it in a new tab; returns its path. The paper
   * and template (a template name) default to the settings (the template to defaultTemplate()).
   */
  async createInkNote(name: string, folder = targetFolder(this.app), paper: NotePaper = this.settings.paper,
    template: string = this.defaultTemplate()): Promise<string | null> {
    try {
      const path = await createInkNote(this.app, folder, name, paper, template);
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_INK, state: { file: path }, active: true });
      this.app.workspace.revealLeaf(leaf);
      return path;
    } catch (e) {
      console.error(LOG_PREFIX, 'new ink note', e);
      new Notice(`Couldn't create the ink note: ${(e as Error).message}`);
      return null;
    }
  }

  /** Asks for a PDF (vault or device) and a name, then imports it into the active file's folder and opens it. */
  importPdf() {
    new PdfSourceModal(this.app, choice => {
      new PdfNameModal(this.app, choice.basename, name => void this.importPdfAs(choice, name)).open();
    }).open();
  }

  /** Imports a chosen PDF as the note `name` and opens it in a new tab; returns its path. Progress shows in a notice. */
  async importPdfAs(choice: PdfChoice, name: string, folder = targetFolder(this.app)): Promise<string | null> {
    const notice = new Notice('Importing PDF…', 0);
    try {
      const path = await importPdf(this.app, folder, name, choice.basename + '.pdf', choice.bytes, this.settings.paper,
        (done, total) => notice.setMessage?.(`Importing PDF: page ${done} of ${total}`));
      notice.hide();
      const leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_INK, state: { file: path }, active: true });
      this.app.workspace.revealLeaf(leaf);
      return path;
    } catch (e) {
      notice.hide();
      console.warn(LOG_PREFIX, 'import PDF', e); // shown in a notice; often just a file pdf.js can't read
      new Notice(`Couldn't import the PDF: ${(e as Error).message}`);
      return null;
    }
  }

  /** Asks for a PDF (vault or device), a page and a name, then saves that page as a PDF template (#21). */
  addPdfTemplate() {
    void addPdfTemplateFlow(this.app, this.templates);
  }

  /** Saves page `page` of a chosen PDF as the template `name` in the templates folder; returns `tpl:<name>`. */
  addPdfTemplateAs(choice: PdfChoice, name: string, page = 1): Promise<string | null> {
    return addPdfTemplateAs(this.templates, choice, name, page);
  }

  /** Asks for an image (vault or device) and a name, then saves it as a template (#54), as wide as the open note's paper. */
  addImageTemplate(): Promise<string | null> {
    const paper = () => this.app.workspace.getActiveViewOfType(InkView)?.store?.paperSize ?? paperSize(this.settings.paper);
    return addImageTemplateFlow(this.app, this.templates, paper);
  }

  /** Asks for a template and stars it, or unstars it if it's a favourite (#54; the chooser's stars do the same). */
  toggleFavouriteTemplate() {
    const prefs = this.templates.prefs!;
    void this.templates.load().then(entries => new TemplateChooser(this.app, 'Template to star or unstar', (_t, _s, name) => {
      if (!name) return;
      const on = prefs.toggle(name);
      new Notice(on ? `Starred ${name}: it comes first in template lists` : `Unstarred ${name}`);
    }, entries, false, prefs).open());
  }

  /** The open ink note (index and page folder paths) that has a page with this template object, or null. */
  private noteOfTemplate(template: PdfTemplate): PdfNote | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      const view = leaf.view;
      if (!(view instanceof InkView) || !view.store || !view.file) continue;
      if (view.store.slots.some(s => s.page?.template === template)) return { path: view.file.path, pages: view.store.folder };
    }
    return null;
  }

  async openAsInk(file: TFile, leaf: WorkspaceLeaf) {
    await leaf.setViewState({ type: VIEW_TYPE_INK, state: { file: file.path }, active: true });
  }

  async openDebugView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE_DEBUG)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_DEBUG, active: true });
    }
    ws.revealLeaf(leaf);
  }
}

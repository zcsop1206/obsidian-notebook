import { MarkdownView, Notice, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';
import { Recorder } from './debug/recorder';
import { DebugView, VIEW_TYPE_DEBUG } from './debug/view';
import { LOG_PREFIX } from './debug/util';
import { createInkNote, NewNoteModal, targetFolder } from './ink/new-note';
import { cachedIsInk, installTakeover, VIEW_TYPE_INK } from './ink/takeover';
import { InkView } from './ink/view';
import type { Paper } from './format/page';
import { DEFAULT_SETTINGS, NotebookSettingTab, parseSettings, type NotebookSettings } from './settings';

/**
 * Notebook: handwritten notes with the Apple Pencil, stored as SVG pages in the vault.
 * Markdown files with `ink:` frontmatter open in the ink view. Also holds the spike's ink
 * debug view and test recorder.
 */
export default class NotebookPlugin extends Plugin {
  recorder!: Recorder;
  settings: NotebookSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    this.settings = parseSettings(await this.loadData());

    this.registerView(VIEW_TYPE_INK, leaf => new InkView(leaf));
    this.register(installTakeover(this.app));
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
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
      if (!(file instanceof TFile) || !leaf || leaf.view.getViewType() !== 'markdown' || !cachedIsInk(this.app, file)) return;
      menu.addItem(item => item.setTitle('Open as ink note').setIcon('pencil').onClick(() => void this.openAsInk(file, leaf)));
    }));
    this.addSettingTab(new NotebookSettingTab(this.app, this));

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

  /** Asks for a name, paper and template, then creates the note in the active file's folder and opens it. */
  newInkNote() {
    const { paper, template } = this.settings;
    new NewNoteModal(this.app, { paper, template }, c => void this.createInkNote(c.name, undefined, c.paper, c.template)).open();
  }

  /**
   * Creates an ink note with one page and opens it in a new tab; returns its path. The paper
   * and template (a template name) default to the settings.
   */
  async createInkNote(name: string, folder = targetFolder(this.app), paper: Paper = this.settings.paper,
    template: string = this.settings.template): Promise<string | null> {
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

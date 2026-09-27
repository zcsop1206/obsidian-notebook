// "New ink note": asks for a name, paper size and template, and creates `<folder>/<name>.md`
// with one empty page in `<folder>/<name>/`.
import { Modal, normalizePath, Setting, TFolder, type App } from 'obsidian';
import { newPageId } from '../format/ids';
import { newNote, pagePath, PAPERS, writeNote } from '../format/note';
import { newPage, PAPER_SIZES, writePage, type Paper } from '../format/page';
import { BUILT_IN_TEMPLATES, isTemplateName, parseTemplateName } from '../format/template';
import { cleanName, DEFAULT_NAME, uniqueName } from './names';

/** The folder for a new note: the active file's, else the vault root ('' ). */
export function targetFolder(app: App): string {
  const parent = app.workspace.getActiveFile()?.parent;
  return parent && !parent.isRoot() ? parent.path : '';
}

/**
 * Creates the note and its first page; returns the note's path. `template` is a template name
 * (see BUILT_IN_TEMPLATES): the note's default for new pages and its first page's template.
 * Throws on an unknown name.
 */
export async function createInkNote(app: App, folder: string, name: string, paper: Paper, template = 'blank'): Promise<string> {
  const first = parseTemplateName(template);
  const vault = app.vault;
  const dir = folder ? normalizePath(folder) + '/' : '';
  const base = uniqueName(cleanName(name), n =>
    !!vault.getAbstractFileByPath(normalizePath(`${dir}${n}.md`)) || !!vault.getAbstractFileByPath(normalizePath(dir + n)));
  const note = newNote(base, paper, template);
  const page = newPage(newPageId([]), PAPER_SIZES[paper], first);
  note.pages = [page.id];
  const pageFolder = normalizePath(dir + base);
  if (!(vault.getAbstractFileByPath(pageFolder) instanceof TFolder)) await vault.createFolder(pageFolder);
  await vault.create(normalizePath(dir + pagePath(base, page.id)), writePage(page));
  const notePath = normalizePath(`${dir}${base}.md`);
  await vault.create(notePath, writeNote(note));
  return notePath;
}

export interface NewNoteChoice {
  name: string;
  paper: Paper;
  /** A template name. */
  template: string;
}

const PAPER_LABELS: Record<Paper, string> = { letter: 'Letter', a4: 'A4' };

/** Asks for the new note's name, paper and template. Enter or Create confirms. */
export class NewNoteModal extends Modal {
  constructor(app: App, private defaults: { paper: Paper; template: string }, private onChoose: (choice: NewNoteChoice) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('New ink note');
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'nb-ink-name' });
    input.value = DEFAULT_NAME;
    let paper = this.defaults.paper;
    let template = isTemplateName(this.defaults.template) ? this.defaults.template : 'blank';
    new Setting(this.contentEl)
      .setName('Paper')
      .addDropdown(d => {
        for (const p of PAPERS) d.addOption(p, PAPER_LABELS[p]);
        d.setValue(paper).onChange(v => { paper = v === 'a4' ? 'a4' : 'letter'; });
      });
    new Setting(this.contentEl)
      .setName('Template')
      .addDropdown(d => {
        for (const t of BUILT_IN_TEMPLATES) d.addOption(t.name, t.label);
        d.setValue(template).onChange(v => { if (isTemplateName(v)) template = v; });
      });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'Create', cls: 'mod-cta' });
    const submit = () => {
      const name = input.value;
      this.close();
      this.onChoose({ name, paper, template });
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

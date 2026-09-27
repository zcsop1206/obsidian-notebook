// "New ink note": asks for a name and creates `<folder>/<name>.md` with one empty page in
// `<folder>/<name>/`.
import { Modal, normalizePath, TFolder, type App } from 'obsidian';
import { newPageId } from '../format/ids';
import { newNote, pagePath, writeNote } from '../format/note';
import { newPage, PAPER_SIZES, writePage, type Paper } from '../format/page';
import { cleanName, DEFAULT_NAME, uniqueName } from './names';
import { noteTemplate } from './store';

/** The folder for a new note: the active file's, else the vault root ('' ). */
export function targetFolder(app: App): string {
  const parent = app.workspace.getActiveFile()?.parent;
  return parent && !parent.isRoot() ? parent.path : '';
}

/** Creates the note and its first page; returns the note's path. */
export async function createInkNote(app: App, folder: string, name: string, paper: Paper): Promise<string> {
  const vault = app.vault;
  const dir = folder ? normalizePath(folder) + '/' : '';
  const base = uniqueName(cleanName(name), n =>
    !!vault.getAbstractFileByPath(normalizePath(`${dir}${n}.md`)) || !!vault.getAbstractFileByPath(normalizePath(dir + n)));
  const note = newNote(base, paper, 'blank');
  const page = newPage(newPageId([]), PAPER_SIZES[paper], noteTemplate(note.template));
  note.pages = [page.id];
  const pageFolder = normalizePath(dir + base);
  if (!(vault.getAbstractFileByPath(pageFolder) instanceof TFolder)) await vault.createFolder(pageFolder);
  await vault.create(normalizePath(dir + pagePath(base, page.id)), writePage(page));
  const notePath = normalizePath(`${dir}${base}.md`);
  await vault.create(notePath, writeNote(note));
  return notePath;
}

/** Asks for the new note's name. Enter or Create confirms. */
export class NewNoteModal extends Modal {
  constructor(app: App, private onName: (name: string) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('New ink note');
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'nb-ink-name' });
    input.value = DEFAULT_NAME;
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'Create', cls: 'mod-cta' });
    const submit = () => {
      const name = input.value;
      this.close();
      this.onName(name);
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

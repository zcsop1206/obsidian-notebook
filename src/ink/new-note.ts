// "New ink note": asks for a name, paper size and template, and creates `<folder>/<name>.md`
// with one empty page in `<folder>/<name>/`. A sized template (#27: sticky note, index card) or
// a custom template (#21, #54: its page's size) sets the note's paper to its size, so pages added
// later have it too; "Custom size…" in the paper list asks for a size in inches or mm. Favourite
// templates (#54) come first in the list.
import { Modal, normalizePath, Setting, TFolder, type App } from 'obsidian';
import { newPageId } from '../format/ids';
import { newNote, pagePath, PAPERS, writeNote } from '../format/note';
import { newPage, paperSize, sizePaper, writePage, type NotePaper, type Paper } from '../format/page';
import { isTemplateName, parseTemplateName, templateSize, type Template } from '../format/template';
import { cleanName, DEFAULT_NAME, uniqueName } from './names';
import { SizeModal, templateItems } from './template-chooser';
import { canonicalName, isCustomName, templateRegistry } from './templates';

/** The folder for a new note: the active file's, else the vault root ('' ). */
export function targetFolder(app: App): string {
  const parent = app.workspace.getActiveFile()?.parent;
  return parent && !parent.isRoot() ? parent.path : '';
}

/**
 * Creates the note and its first page; returns the note's path. `template` is a template name
 * (see BUILT_IN_TEMPLATES, or `tpl:<name>` for a custom template, #54, also read as the older
 * `pdf:<name>`, #21): the note's default for new pages and its first page's template. A sized or
 * custom template's size replaces `paper` (#27). Throws on an unknown name.
 */
export async function createInkNote(app: App, folder: string, name: string, paper: NotePaper, template = 'blank'): Promise<string> {
  let first: Template;
  template = canonicalName(template);
  if (isCustomName(template)) {
    const registry = templateRegistry();
    await registry?.load();
    const r = registry?.resolve(template);
    if (!r) throw new Error(`Unknown template "${template}"`);
    first = r.template;
    paper = sizePaper(r.size);
  } else {
    first = parseTemplateName(template);
    const size = templateSize(template);
    if (size) paper = sizePaper(size);
  }
  const vault = app.vault;
  const dir = folder ? normalizePath(folder) + '/' : '';
  const base = uniqueName(cleanName(name), n =>
    !!vault.getAbstractFileByPath(normalizePath(`${dir}${n}.md`)) || !!vault.getAbstractFileByPath(normalizePath(dir + n)));
  const note = newNote(base, paper, template);
  const page = newPage(newPageId([]), paperSize(paper), first);
  note.pages = [page.id];
  const pageFolder = normalizePath(dir + base);
  if (!(vault.getAbstractFileByPath(pageFolder) instanceof TFolder)) await vault.createFolder(pageFolder);
  if (first.kind === 'pdf') await templateRegistry()?.ensureCopied(first, pageFolder);
  await vault.create(normalizePath(dir + pagePath(base, page.id)), writePage(page));
  const notePath = normalizePath(`${dir}${base}.md`);
  await vault.create(notePath, writeNote(note));
  return notePath;
}

export interface NewNoteChoice {
  name: string;
  paper: NotePaper;
  /** A template name. */
  template: string;
}

const PAPER_LABELS: Record<Paper, string> = { letter: 'Letter', a4: 'A4' };
/** The paper dropdown's value for "Custom size…". */
const CUSTOM = 'custom';

/** A custom paper's label: `3 × 3 in` (px / 96, to 0.01 in). */
export function paperLabel(paper: NotePaper): string {
  if (paper === 'letter' || paper === 'a4') return PAPER_LABELS[paper];
  const s = paperSize(paper);
  const inch = (px: number) => String(Math.round(px / 96 * 100) / 100);
  return `${inch(s.width)} × ${inch(s.height)} in`;
}

/** Asks for the new note's name, paper and template. Enter or Create confirms. */
export class NewNoteModal extends Modal {
  constructor(app: App, private defaults: { paper: NotePaper; template: string }, private onChoose: (choice: NewNoteChoice) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('New ink note');
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'nb-ink-name' });
    input.value = DEFAULT_NAME;
    let paper = this.defaults.paper;
    const registry = templateRegistry();
    const entries = registry?.entries ?? [];
    const known = (name: string) => isTemplateName(name) || entries.some(e => e.name === name);
    let template = known(canonicalName(this.defaults.template)) ? canonicalName(this.defaults.template) : 'blank';
    new Setting(this.contentEl)
      .setName('Paper')
      .setDesc('A sticky note, index card or custom template brings its own size.')
      .addDropdown(d => {
        for (const p of PAPERS) d.addOption(p, PAPER_LABELS[p]);
        if (paper !== 'letter' && paper !== 'a4') d.addOption(paper, paperLabel(paper));
        d.addOption(CUSTOM, 'Custom size…');
        d.setValue(paper).onChange(v => {
          if (v !== CUSTOM) {
            paper = v === 'a4' ? 'a4' : v === 'letter' ? 'letter' : paper;
            return;
          }
          d.setValue(paper);
          new SizeModal(this.app, size => {
            paper = sizePaper(size);
            if (!Array.from(d.selectEl.options).some(o => o.value === paper)) d.addOption(paper, paperLabel(paper));
            d.setValue(paper);
          }).open();
        });
      });
    new Setting(this.contentEl)
      .setName('Template')
      .addDropdown(d => {
        const favourites = registry?.prefs?.favourites() ?? [];
        for (const t of templateItems(entries, false, favourites)) d.addOption(t.name, favourites.includes(t.name) ? `★ ${t.label}` : t.label);
        d.setValue(template).onChange(v => { if (known(v)) template = v; });
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

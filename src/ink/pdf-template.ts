// "Add PDF template" (#21): one page of a PDF (from the vault or the device) saved as a template
// in the templates folder: `<folder>/<name>.pdf`, the PDF copied, and `<folder>/<name>.svg`, an
// ink page with no strokes whose pdf template is that page (the JPEG at 150 dpi, as the import
// embeds, #14) at the page's size. The registry (templates.ts) lists it as `pdf:<name>`.
import { Modal, normalizePath, Setting, TFolder, type App } from 'obsidian';
import { newPageId } from '../format/ids';
import { newPage, writePage } from '../format/page';
import { cleanName, uniqueName } from './names';
import { openPdf } from './pdf';
import { pdfPageImage } from './pdf-import';
import { PDF_PREFIX } from './templates';

/** Creates a folder and its parents if missing. */
async function ensureFolder(app: App, path: string) {
  let acc = '';
  for (const part of path.split('/')) {
    acc = acc ? `${acc}/${part}` : part;
    if (app.vault.getAbstractFileByPath(acc) instanceof TFolder) continue;
    await app.vault.createFolder(acc);
  }
}

/**
 * Saves page `pageNo` (1-based) of the PDF as the template `<name>` in `folder`; returns its
 * `pdf:<name>` (the name made unique if taken). Throws if pdf.js can't read the PDF or the page
 * doesn't exist (then nothing is written).
 */
export async function addPdfTemplate(app: App, folder: string, name: string, bytes: ArrayBuffer, pageNo: number): Promise<string> {
  const doc = await openPdf(bytes);
  try {
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > doc.numPages) {
      throw new Error(`The PDF has no page ${pageNo} (it has ${doc.numPages})`);
    }
    const pg = await doc.getPage(pageNo);
    const { size, image } = await pdfPageImage(pg);
    pg.cleanup?.();
    const vault = app.vault;
    const dir = normalizePath(folder || '/');
    const prefix = dir === '/' ? '' : dir + '/';
    const base = uniqueName(cleanName(name), n =>
      !!vault.getAbstractFileByPath(`${prefix}${n}.svg`) || !!vault.getAbstractFileByPath(`${prefix}${n}.pdf`));
    if (prefix) await ensureFolder(app, dir);
    await vault.createBinary(`${prefix}${base}.pdf`, bytes.slice(0));
    const page = newPage(newPageId([]), size, { kind: 'pdf', source: `${base}.pdf`, page: pageNo, image });
    await vault.create(`${prefix}${base}.svg`, writePage(page));
    return PDF_PREFIX + base;
  } finally {
    void doc.destroy?.();
  }
}

/** Asks for the page number (default 1) and the template's name (default the PDF's). */
export class PdfTemplateModal extends Modal {
  constructor(app: App, private defaultName: string, private onChoose: (name: string, page: number) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('Add PDF template');
    let page = 1;
    new Setting(this.contentEl).setName('Page').addText(t => {
      t.inputEl.type = 'number';
      t.inputEl.min = '1';
      t.inputEl.addClass('nb-tpl-page');
      t.setValue('1').onChange(v => { page = Math.floor(Number(v)) || 1; });
    });
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'nb-ink-name' });
    input.value = this.defaultName;
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'Add', cls: 'mod-cta' });
    const submit = () => {
      const name = input.value;
      this.close();
      this.onChoose(name, Math.max(1, page));
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

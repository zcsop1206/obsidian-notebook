// Templates from files (#21, #54). "PDF page as a template" (`add-pdf-template`): one page of a
// PDF (from the vault or the device) saved as a template in the templates folder: `<name>.pdf`,
// the PDF copied, and `<name>.svg`, an ink page with no strokes whose pdf template is that page
// (the JPEG at 150 dpi, as the import embeds, #14) at the page's size. "Image as a template"
// (`add-image-template`, #54): an image (vault or device) read as "Insert image as page" reads
// it (#12), saved as `<name>.svg`, an ink page whose `image` template is the image, at the
// paper's width and the image's aspect. The registry (templates.ts) lists both as `tpl:<name>`.
import { Modal, Notice, Setting, type App } from 'obsidian';
import type { Size } from '../format/page';
import { imagePageSize, prepareImage } from './images';
import { openPdf } from './pdf';
import { ImageSourceModal, pdfPageImage, PdfSourceModal, type PdfChoice } from './pdf-import';
import { NameModal } from './template-chooser';
import type { TemplateRegistry } from './templates';

/**
 * Saves page `pageNo` (1-based) of the PDF as the template `<name>` in the templates folder;
 * returns its `tpl:<name>` (the name made unique if taken). Throws if pdf.js can't read the PDF
 * or the page doesn't exist (then nothing is written).
 */
export async function addPdfTemplate(registry: TemplateRegistry, name: string, bytes: ArrayBuffer, pageNo: number): Promise<string> {
  const doc = await openPdf(bytes);
  try {
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > doc.numPages) {
      throw new Error(`The PDF has no page ${pageNo} (it has ${doc.numPages})`);
    }
    const pg = await doc.getPage(pageNo);
    const { size, image } = await pdfPageImage(pg);
    pg.cleanup?.();
    return await registry.save(name, { kind: 'pdf', source: 'template.pdf', page: pageNo, image }, size, bytes);
  } finally {
    void doc.destroy?.();
  }
}

/**
 * Saves an image file as the template `<name>` (#54): stored as an inserted whole-page image is
 * (at most 4096 px, JPEG or PNG), on a page `paper` wide with the image's aspect. Returns its
 * `tpl:<name>`. Throws if the file isn't an image this device reads.
 */
export async function addImageTemplate(registry: TemplateRegistry, name: string, file: Blob, paper: Size): Promise<string> {
  const im = await prepareImage(file);
  return registry.save(name, { kind: 'image', image: im.data }, imagePageSize(im.width, im.height, paper));
}

/** Asks for a PDF (vault or device), a page and a name, then saves that page as a template; resolves its name or null. */
export function addPdfTemplateFlow(app: App, registry: TemplateRegistry): Promise<string | null> {
  return new Promise(resolve => {
    new PdfSourceModal(app, choice => {
      new PdfTemplateModal(app, choice.basename, (name, page) => void addPdfTemplateAs(registry, choice, name, page).then(resolve)).open();
    }, 'PDF for the template').open();
  });
}

/** Saves page `page` of a chosen PDF as the template `name`, with a notice; returns `tpl:<name>` or null. */
export async function addPdfTemplateAs(registry: TemplateRegistry, choice: PdfChoice, name: string, page = 1): Promise<string | null> {
  try {
    const id = await addPdfTemplate(registry, name, choice.bytes, page);
    new Notice(`Added the PDF template "${id.slice(4)}"`);
    return id;
  } catch (e) {
    console.warn('[notebook] add PDF template', e);
    new Notice(`Couldn't add the PDF template: ${(e as Error).message}`);
    return null;
  }
}

/** Asks for an image (vault or device) and a name, then saves it as a template `paper` wide; resolves its name or null. */
export function addImageTemplateFlow(app: App, registry: TemplateRegistry, paper: () => Size): Promise<string | null> {
  return new Promise(resolve => {
    new ImageSourceModal(app, (file, basename) => {
      new NameModal(app, 'Save image as a template', basename, 'Save', name => void addImageTemplateAs(registry, file, name, paper()).then(resolve),
        () => resolve(null)).open();
    }, 'Image for the template').open();
  });
}

/** Saves an image as the template `name`, with a notice; returns `tpl:<name>` or null. */
export async function addImageTemplateAs(registry: TemplateRegistry, file: Blob, name: string, paper: Size): Promise<string | null> {
  const progress = new Notice('Saving the image template…', 0);
  try {
    const id = await addImageTemplate(registry, name, file, paper);
    progress.hide();
    new Notice(`Added the image template "${id.slice(4)}"`);
    return id;
  } catch (e) {
    progress.hide();
    console.warn('[notebook] add image template', e);
    new Notice(`Couldn't add the image template: ${(e as Error).message}`);
    return null;
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

// "Import PDF as ink note" (#14): choose a PDF from the vault or the device (on the iPad, the
// Files app), name the note, then create `<folder>/<name>.md` with one page per PDF page, each
// at that page's own size, with the PDF copied to `<folder>/<name>/<original name>.pdf`. Each
// page's template is a pdf template: the page rendered at about 150 dpi as an embedded JPEG,
// and a reference to the copied PDF for sharp rendering in the editor.
import { FuzzySuggestModal, Modal, normalizePath, Notice, TFile, TFolder, type App } from 'obsidian';
import { newPageId } from '../format/ids';
import { newNote, pagePath, writeNote } from '../format/note';
import { newPage, writePage, type Paper } from '../format/page';
import { pointsToPx } from '../format/template';
import { cleanName, uniqueName } from './names';
import { openPdf, renderPdfPage } from './pdf';

/** Resolution of the embedded page images, and their JPEG quality. */
export const IMPORT_DPI = 150;
export const JPEG_QUALITY = 0.85;
/** The embedded image of a very large page is kept under this many pixels. */
const MAX_IMAGE_PIXELS = 8_000_000;

export interface PdfChoice {
  /** The PDF's file name without `.pdf`, the default note name. */
  basename: string;
  bytes: ArrayBuffer;
}

/** A PDF's name without its extension. */
const stripPdf = (name: string) => name.replace(/\.pdf$/i, '');

/**
 * Creates the note from a PDF's bytes and returns its path. `progress(done, total)` is called
 * after each page. Pages are written before the index, as createInkNote does. Throws if pdf.js
 * can't read the PDF (then nothing is written).
 */
export async function importPdf(app: App, folder: string, name: string, pdfName: string, bytes: ArrayBuffer,
  paper: Paper, progress: (done: number, total: number) => void = () => {}): Promise<string> {
  const doc = await openPdf(bytes);
  try {
    const vault = app.vault;
    const dir = folder && folder !== '/' ? normalizePath(folder) + '/' : '';
    const base = uniqueName(cleanName(name), n =>
      !!vault.getAbstractFileByPath(normalizePath(`${dir}${n}.md`)) || !!vault.getAbstractFileByPath(normalizePath(dir + n)));
    const pageFolder = normalizePath(dir + base);
    if (!(vault.getAbstractFileByPath(pageFolder) instanceof TFolder)) await vault.createFolder(pageFolder);
    const pdfFile = cleanName(stripPdf(pdfName)) + '.pdf';
    const source = `${base}/${pdfFile}`;
    await vault.createBinary(normalizePath(dir + source), bytes.slice(0));
    // Pages added later are blank at the note's paper size.
    const note = newNote(base, paper, 'blank');
    const total = doc.numPages;
    for (let n = 1; n <= total; n++) {
      const pg = await doc.getPage(n);
      const one = pg.getViewport({ scale: 1 });
      let image = '';
      try {
        const canvas = await renderPdfPage(pg, IMPORT_DPI / 72, MAX_IMAGE_PIXELS);
        image = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        canvas.width = canvas.height = 0;
      } catch (e) {
        console.warn('[notebook] PDF import: page', n, 'did not render', e);
      }
      pg.cleanup?.();
      const size = { width: pointsToPx(one.width), height: pointsToPx(one.height) };
      const page = newPage(newPageId(note.pages), size, { kind: 'pdf', source, page: n, image });
      await vault.create(normalizePath(dir + pagePath(base, page.id)), writePage(page));
      note.pages.push(page.id);
      progress(n, total);
      await new Promise(r => window.setTimeout(r, 0)); // let the UI breathe between pages
    }
    const notePath = normalizePath(`${dir}${base}.md`);
    await vault.create(notePath, writeNote(note));
    return notePath;
  } finally {
    void doc.destroy?.();
  }
}

const DEVICE = Symbol('device');
type SourceItem = TFile | typeof DEVICE;

/**
 * Chooses the PDF: the first row picks a file from the device through a file input (the
 * iPad's Files app), the others are the vault's PDFs.
 */
export class PdfSourceModal extends FuzzySuggestModal<SourceItem> {
  constructor(app: App, private onChoose: (choice: PdfChoice) => void) {
    super(app);
    this.setPlaceholder('PDF to import');
  }

  getItems(): SourceItem[] {
    const pdfs = this.app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'pdf')
      .sort((a, b) => a.path.localeCompare(b.path));
    return [DEVICE, ...pdfs];
  }

  getItemText(item: SourceItem): string {
    return item === DEVICE ? 'Choose a file from this device…' : item.path;
  }

  onChooseItem(item: SourceItem) {
    if (item === DEVICE) {
      pickDeviceFile(this.onChoose);
      return;
    }
    this.app.vault.readBinary(item).then(
      bytes => this.onChoose({ basename: item.basename, bytes }),
      e => new Notice(`Couldn't read ${item.path}: ${(e as Error).message}`));
  }
}

/** Opens the system file picker for a PDF (must run within the user's tap or click). */
export function pickDeviceFile(onChoose: (choice: PdfChoice) => void) {
  const input = document.body.createEl('input', { type: 'file', cls: 'nb-pdf-file-input' });
  input.accept = 'application/pdf,.pdf';
  const done = () => input.remove();
  input.addEventListener('cancel', done);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    done();
    if (!file) return;
    file.arrayBuffer().then(
      bytes => onChoose({ basename: stripPdf(file.name), bytes }),
      e => new Notice(`Couldn't read ${file.name}: ${(e as Error).message}`));
  });
  input.click();
}

/** Asks for the new note's name (default the PDF's). Enter or Import confirms. */
export class PdfNameModal extends Modal {
  constructor(app: App, private defaultName: string, private onChoose: (name: string) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('Import PDF as ink note');
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'nb-ink-name' });
    input.value = this.defaultName;
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'Import', cls: 'mod-cta' });
    const submit = () => {
      const name = input.value;
      this.close();
      this.onChoose(name);
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

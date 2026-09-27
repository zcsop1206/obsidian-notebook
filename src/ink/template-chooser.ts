// A searchable list of the page templates, for "Add page with template…" and the "Change
// template" commands: the built-ins (#19, with the sized ones of #27), the PDF templates of the
// templates folder (#21) after them, and, when adding a page, "Custom size…" (#27), a blank page
// of a size asked for in inches or mm. #10's toolbar will offer the same choices.
import { FuzzySuggestModal, Modal, Setting, type App } from 'obsidian';
import type { Size } from '../format/page';
import { BUILT_IN_TEMPLATES, parseTemplate, type Template } from '../format/template';
import type { PdfTemplateEntry } from './templates';

/** One row: a template and the page size it comes in, if any, or the custom-size entry. */
export interface TemplateItem {
  label: string;
  /** `blank`, `sticky-3in`, `pdf:<name>`…, or '' for "Custom size…". */
  name: string;
  template: Template | null;
  size?: Size;
}

export const CUSTOM_SIZE_LABEL = 'Custom size…';

/** The rows: built-ins, then PDF templates, then (if `custom`) "Custom size…". */
export function templateItems(pdfs: readonly PdfTemplateEntry[], custom: boolean): TemplateItem[] {
  const items: TemplateItem[] = BUILT_IN_TEMPLATES.map(b => ({ label: b.label, name: b.name, template: b.template, size: b.size }));
  for (const e of pdfs) items.push({ label: `${e.label} (PDF)`, name: e.name, template: e.template, size: e.size });
  if (custom) items.push({ label: CUSTOM_SIZE_LABEL, name: '', template: null });
  return items;
}

export class TemplateChooser extends FuzzySuggestModal<TemplateItem> {
  /**
   * `pdfs` are the PDF templates to list; `custom` adds "Custom size…". `onChoose` gets a fresh
   * template and the size it comes in (a sized built-in, a PDF template, a custom size).
   */
  constructor(app: App, placeholder: string, private onChoose: (template: Template, size?: Size) => void,
    private pdfs: readonly PdfTemplateEntry[] = [], private custom = false) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): TemplateItem[] {
    return templateItems(this.pdfs, this.custom);
  }

  getItemText(item: TemplateItem): string {
    return item.label;
  }

  onChooseItem(item: TemplateItem) {
    if (!item.template) {
      new SizeModal(this.app, size => this.onChoose({ kind: 'blank' }, size)).open();
      return;
    }
    this.onChoose(parseTemplate(item.template), item.size ? { ...item.size } : undefined);
  }
}

export type SizeUnit = 'in' | 'mm';
/** Limits of a custom size, per side, in inches. */
export const MIN_SIDE_IN = 1;
export const MAX_SIDE_IN = 20;

/**
 * A size in CSS px (96 px/in, to 0.1 px) from width and height in inches or mm, or null if a
 * side isn't a number from 1 to 20 in.
 */
export function customSize(width: number, height: number, unit: SizeUnit): Size | null {
  const perUnit = unit === 'in' ? 96 : 96 / 25.4;
  const px = (v: number) => Math.round(v * perUnit * 10) / 10;
  const ok = (v: number) => typeof v === 'number' && isFinite(v) &&
    px(v) >= MIN_SIDE_IN * 96 - 0.05 && px(v) <= MAX_SIDE_IN * 96 + 0.05;
  if (!ok(width) || !ok(height)) return null;
  return { width: px(width), height: px(height) };
}

/** Asks for a page size in inches or mm (1 to 20 in a side). */
export class SizeModal extends Modal {
  constructor(app: App, private onChoose: (size: Size) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('Custom page size');
    let width = 3, height = 3;
    let unit: SizeUnit = 'in';
    const number = (name: string, cls: string, value: number, set: (v: number) => void) =>
      new Setting(this.contentEl).setName(name).addText(t => {
        t.inputEl.type = 'number';
        t.inputEl.addClass(cls);
        t.setValue(String(value)).onChange(v => set(Number(v)));
      });
    number('Width', 'nb-size-width', width, v => { width = v; });
    number('Height', 'nb-size-height', height, v => { height = v; });
    new Setting(this.contentEl).setName('Unit').addDropdown(d => d
      .addOption('in', 'Inches').addOption('mm', 'Millimetres')
      .setValue(unit).onChange(v => { unit = v === 'mm' ? 'mm' : 'in'; }));
    const error = this.contentEl.createDiv({ cls: 'nb-size-error' });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'OK', cls: 'mod-cta' });
    ok.addEventListener('click', () => {
      const size = customSize(width, height, unit);
      if (!size) {
        error.setText(`Each side must be from ${MIN_SIDE_IN} to ${MAX_SIDE_IN} in (${MIN_SIDE_IN * 25.4} to ${MAX_SIDE_IN * 25.4} mm).`);
        return;
      }
      this.close();
      this.onChoose(size);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

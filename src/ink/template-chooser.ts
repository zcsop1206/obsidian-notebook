// A searchable list of the page templates, for "Add page with template…" and the "Change
// template" commands: the built-ins (#19, with the sized ones of #27), the custom templates of the
// templates folder (#21, #54) after them, favourites first (#54), and, when adding a page,
// "Custom size…" (#27), a blank page of a size asked for in inches or mm.
//
// Each row (#54) has a star (a tap stars or unstars it; the order changes the next time the list
// opens, so rows don't jump under the finger), and a custom template's row a small preview (the
// template drawn at thumbnail size, cached per template) and rename and delete buttons, each
// asking first. The row's controls stop their taps from choosing the row.
//
// Also here: the question modals of #54 and #56 (ConfirmModal, NameModal).
import { FuzzySuggestModal, Modal, Notice, setIcon, Setting, type App, type FuzzyMatch } from 'obsidian';
import type { Size } from '../format/page';
import { fixedPaper, parseTemplate, type Template } from '../format/template';
import { isFavourite, type TemplatePrefs } from './favourites';
import { templateItems, type TemplateItem } from './template-changes';
import { currentTheme, TemplateImages } from './renderer';
import { templateRegistry, type TemplateEntry } from './templates';

export { CUSTOM_SIZE_LABEL, customLabel, templateItems, type TemplateItem } from './template-changes';

/** Templates drawn for the previews, shared by every chooser. */
const previewImages = new TemplateImages();
/** A preview's longest side, in CSS px. */
export const PREVIEW_SIDE = 40;

/**
 * A canvas with the template drawn at thumbnail size (its paper, then its template layer once
 * the image is ready), fitted into PREVIEW_SIDE px keeping the page's shape.
 */
export function templatePreview(template: Template, size: Size): HTMLCanvasElement {
  const k = PREVIEW_SIDE / Math.max(size.width, size.height, 1);
  const w = Math.max(4, Math.round(size.width * k)), h = Math.max(4, Math.round(size.height * k));
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.className = 'nb-tpl-preview';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const theme = currentTheme();
  const draw = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = fixedPaper(template) ? '#ffffff' : theme.paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = previewImages.get(template, size, canvas.width, canvas.height, theme, draw);
    if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  draw();
  return canvas;
}

export class TemplateChooser extends FuzzySuggestModal<TemplateItem> {
  /**
   * `entries` are the custom templates to list; `custom` adds "Custom size…". `onChoose` gets a
   * fresh template, the size it comes in (a sized built-in, a custom template, a custom size) and
   * its name ('' for a custom size). `prefs` (the settings' favourites) adds the stars.
   */
  constructor(app: App, private prompt: string, private onChoose: (template: Template, size?: Size, name?: string) => void,
    private entries: readonly TemplateEntry[] = [], private custom = false,
    private prefs: TemplatePrefs | null = templateRegistry()?.prefs ?? null) {
    super(app);
    this.setPlaceholder(prompt);
  }

  getItems(): TemplateItem[] {
    return templateItems(this.entries, this.custom, this.prefs?.favourites() ?? []);
  }

  getItemText(item: TemplateItem): string {
    return item.label;
  }

  renderSuggestion(match: FuzzyMatch<TemplateItem>, el: HTMLElement) {
    const item = match.item;
    el.addClass('nb-tpl-row');
    if (item.custom && item.template && item.size) el.appendChild(templatePreview(item.template, item.size));
    el.createSpan({ cls: 'nb-tpl-label', text: item.label });
    if (!item.name) return;
    const prefs = this.prefs;
    if (prefs) {
      const star = this.action(el, 'nb-tpl-star', 'star', '', () => {
        const on = prefs.toggle(item.name);
        this.markStar(star, item.label, on);
      });
      this.markStar(star, item.label, isFavourite(prefs.favourites(), item.name));
    }
    if (item.custom) {
      this.action(el, 'nb-tpl-rename', 'pencil', `Rename ${item.label}`, () => this.rename(item));
      this.action(el, 'nb-tpl-delete', 'trash-2', `Delete ${item.label}`, () => this.delete(item));
    }
  }

  onChooseItem(item: TemplateItem) {
    if (!item.template) {
      new SizeModal(this.app, size => this.onChoose({ kind: 'blank' }, size, '')).open();
      return;
    }
    this.onChoose(parseTemplate(item.template), item.size ? { ...item.size } : undefined, item.name);
  }

  private markStar(b: HTMLElement, label: string, on: boolean) {
    b.toggleClass('is-active', on);
    b.setAttribute('aria-pressed', String(on));
    const text = on ? `Unstar ${label}` : `Star ${label} (favourites come first)`;
    b.setAttribute('aria-label', text);
    b.title = text;
  }

  /** A button in a row whose taps (Pencil, finger, mouse) never choose the row. */
  private action(row: HTMLElement, cls: string, icon: string, label: string, fn: () => void): HTMLButtonElement {
    const b = row.createEl('button', { cls: `nb-ink-control nb-tpl-action ${cls}`, attr: { type: 'button', 'aria-label': label, title: label } });
    setIcon(b, icon);
    const stop = (e: Event) => e.stopPropagation();
    b.addEventListener('pointerdown', stop);
    b.addEventListener('mousedown', stop);
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    return b;
  }

  /** A fresh chooser like this one, over the templates as they are now. */
  private reopen() {
    const registry = templateRegistry();
    new TemplateChooser(this.app, this.prompt, this.onChoose, registry?.entries ?? this.entries, this.custom, this.prefs).open();
  }

  private rename(item: TemplateItem) {
    const registry = templateRegistry();
    const entry = registry?.get(item.name);
    if (!registry || !entry) return;
    this.close();
    new NameModal(this.app, 'Rename template', entry.label, 'Rename', async name => {
      try {
        const to = await registry.rename(entry.name, name);
        if (to && to !== entry.name) this.prefs?.renamed(entry.name, to);
        if (to) new Notice(`Renamed the template to "${to.slice(4)}". Pages made from it are unchanged.`);
      } catch (e) {
        new Notice(`Couldn't rename the template: ${(e as Error).message}`);
      }
      this.reopen();
    }, () => this.reopen()).open();
  }

  private delete(item: TemplateItem) {
    const registry = templateRegistry();
    const entry = registry?.get(item.name);
    if (!registry || !entry) return;
    this.close();
    new ConfirmModal(this.app, {
      title: 'Delete template?',
      text: `Delete the template "${entry.label}" from ${registry.folder || 'the vault root'}? Pages made from it keep their background.`,
      ok: 'Delete', warning: true, cls: 'nb-delete-template',
    }, async ok => {
      if (ok) {
        try {
          if (await registry.delete(entry.name)) {
            this.prefs?.renamed(entry.name, null);
            new Notice(`Deleted the template "${entry.label}"`);
          }
        } catch (e) {
          new Notice(`Couldn't delete the template: ${(e as Error).message}`);
        }
      }
      this.reopen();
    }).open();
  }
}

/** Asks a yes/no question: `onAnswer(true)` for the OK button, false for Cancel or closing it. */
export class ConfirmModal extends Modal {
  private answered = false;

  constructor(app: App, private q: { title: string; text: string; ok: string; warning?: boolean; cls?: string },
    private onAnswer: (ok: boolean) => void) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('nb-confirm');
    if (this.q.cls) this.modalEl.addClass(this.q.cls);
    this.titleEl.setText(this.q.title);
    this.contentEl.createEl('p', { cls: 'nb-confirm-text', text: this.q.text });
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: this.q.ok, cls: `${this.q.warning ? 'mod-warning' : 'mod-cta'} nb-confirm-ok` })
      .addEventListener('click', () => this.answer(true));
    buttons.createEl('button', { text: 'Cancel', cls: 'nb-confirm-cancel' }).addEventListener('click', () => this.answer(false));
  }

  private answer(ok: boolean) {
    if (this.answered) return;
    this.answered = true;
    this.close();
    this.onAnswer(ok);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.answered) {
      this.answered = true;
      this.onAnswer(false);
    }
  }
}

/** ConfirmModal as a promise. */
export const confirm = (app: App, q: ConstructorParameters<typeof ConfirmModal>[1]): Promise<boolean> =>
  new Promise(resolve => new ConfirmModal(app, q, resolve).open());

/** Asks for a name (a template's). Enter or the button confirms; closing it otherwise calls `onCancel`. */
export class NameModal extends Modal {
  private done = false;

  constructor(app: App, private title: string, private defaultName: string, private button: string,
    private onChoose: (name: string) => void, private onCancel: () => void = () => {}) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.title);
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'nb-ink-name' });
    input.value = this.defaultName;
    const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: this.button, cls: 'mod-cta' });
    const submit = () => {
      const name = input.value;
      this.done = true;
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
    if (!this.done) {
      this.done = true;
      this.onCancel();
    }
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

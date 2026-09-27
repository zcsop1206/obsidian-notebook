// The ink toolbar (#10): one row of icon buttons at the top of the ink view, wrapping onto a
// second row when narrow. Left: the tools (pen, highlighter, eraser, lasso #11; ruler #20
// as a disabled placeholder). Middle: the favourite presets. Right: undo, redo, add page, page
// settings and the Pages panel toggle. Tapping the tool already in use opens its picker (a
// popover under the button, see picker.ts); so every tool, preset and picker option is at most
// two taps away. The toolbar knows nothing of the store: the view hands it a ToolbarHost.
//
// Pencil taps: blockStylusTouch (input.ts) lets a stylus touchstart through only on `button`,
// `input` or `.nb-ink-control`, so every element here is a button or carries that class.
import { setIcon } from 'obsidian';
import {
  matchesPreset, MAX_PRESETS, type EraserSettings, type HighlighterSettings, type PenPreset, type PenSettings,
  type ToolKind,
} from './pen';
import { Picker, type PickerHost } from './picker';

/** How long a press on a preset slot must last to save the current settings into it, in ms. */
export const LONG_PRESS_MS = 550;
/** Movement that cancels a long press, in CSS px. */
const PRESS_SLOP = 10;

export interface ToolbarHost extends PickerHost {
  pen(): Readonly<PenSettings>;
  highlighter(): Readonly<HighlighterSettings>;
  eraser(): Readonly<EraserSettings>;
  setTool(tool: ToolKind): void;
  /** The preset slots (null: empty). */
  presets(): readonly (PenPreset | null)[];
  applyPreset(index: number): void;
  /** Saves the current tool's settings into slot `index` (not for the eraser). */
  savePreset(index: number): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  /** Whether a note is open (page buttons are disabled otherwise). */
  hasNote(): boolean;
  addPage(): void;
  chooseTemplate(scope: 'add' | 'page' | 'all'): void;
  /** The current page's paper, e.g. "Letter, 8.5 × 11 in", or null. */
  paperLabel(): string | null;
  pagesOpen(): boolean;
  togglePages(): void;
}

type Tool = { tool: ToolKind; icon: string; label: string };
const TOOLS: Tool[] = [
  { tool: 'pen', icon: 'pen-line', label: 'Pen' },
  { tool: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser' },
  { tool: 'lasso', icon: 'lasso', label: 'Lasso' },
];

/** Tools that can't be saved as a favourite. */
const notPreset = (tool: ToolKind) => tool === 'eraser' || tool === 'lasso';

export class Toolbar {
  readonly el: HTMLElement;
  private picker: Picker;
  private presetEls: HTMLButtonElement[] = [];
  /** Set by a long press so that the click that ends it doesn't also apply the preset. */
  private pressed = -1;

  constructor(private root: HTMLElement, private host: ToolbarHost) {
    this.el = root.createDiv({ cls: 'nb-ink-toolbar', attr: { role: 'toolbar', 'aria-label': 'Ink tools' } });
    this.picker = new Picker(root, host);
    const group = (cls: string) => this.el.createDiv({ cls: `nb-ink-control nb-ink-group ${cls}` });

    const tools = group('nb-ink-tools');
    for (const t of TOOLS) {
      const b = this.button(tools, `nb-ink-tool nb-ink-${notPreset(t.tool) ? t.tool : `tool-${t.tool}`}`, t.icon, t.label, () => this.toolTapped(t.tool, b));
      b.dataset.tool = t.tool;
      b.setAttribute('aria-haspopup', 'dialog');
    }
    this.button(tools, 'nb-ink-ruler', 'ruler', 'Ruler: coming in #20', () => {}).disabled = true;

    const presets = group('nb-ink-presets');
    for (let i = 0; i < MAX_PRESETS; i++) {
      const b = this.button(presets, 'nb-ink-preset', null, '', () => this.presetTapped(i));
      b.dataset.slot = String(i);
      b.createSpan({ cls: 'nb-ink-preset-mark' });
      this.longPress(b, i);
      this.presetEls.push(b);
    }

    const page = group('nb-ink-page-actions');
    this.button(page, 'nb-ink-undo', 'undo-2', 'Undo', () => host.undo());
    this.button(page, 'nb-ink-redo', 'redo-2', 'Redo', () => host.redo());
    this.button(page, 'nb-ink-add-page', 'file-plus', 'Add page', () => host.addPage());
    const settings = this.button(page, 'nb-ink-page-settings', 'settings-2', 'Page settings', () => this.pageMenu(settings));
    settings.setAttribute('aria-haspopup', 'dialog');
    const pages = this.button(page, 'nb-ink-pages-toggle', 'layout-list', 'Toggle pages panel', () => host.togglePages());
    pages.setAttribute('aria-pressed', 'false');
    this.render();
  }

  get pickerOpen(): string | null {
    return this.picker.openFor;
  }

  /** Brings every button in line with the host's state (and the open picker). */
  render() {
    const h = this.host, pen = h.pen(), hl = h.highlighter();
    this.el.querySelectorAll<HTMLElement>('.nb-ink-tool').forEach(b => this.mark(b, b.dataset.tool === pen.tool));
    const presets = h.presets();
    this.presetEls.forEach((b, i) => {
      const p = presets[i] ?? null;
      const mark = b.querySelector<HTMLElement>('.nb-ink-preset-mark')!;
      b.toggleClass('is-empty', !p);
      b.dataset.tool = p?.tool ?? '';
      b.toggleClass('is-default-ink', p?.color === '#000000');
      mark.style.backgroundColor = p && p.color !== '#000000' ? p.color : '';
      // The mark's size follows the preset's width, within the button.
      const d = !p ? 0 : p.tool === 'highlighter' ? 10 : Math.max(6, Math.min(22, 4 + p.size * 2.2));
      mark.style.width = p?.tool === 'highlighter' ? '22px' : `${d}px`;
      mark.style.height = `${d}px`;
      const name = !p ? `Favourite ${i + 1}: empty (tap to save the current ${notPreset(pen.tool) ? 'pen' : pen.tool})`
        : `Favourite ${i + 1}: ${p.tool === 'highlighter' ? 'highlighter' : `${p.nib ?? 'uniform'} pen`} ${p.color} ${p.size} px (long-press to replace)`;
      b.setAttribute('aria-label', name);
      b.title = name;
      this.mark(b, matchesPreset(p, pen, hl));
    });
    const set = (sel: string, on: boolean) => {
      const b = this.el.querySelector<HTMLButtonElement>(sel);
      if (b) b.disabled = !on;
    };
    set('.nb-ink-undo', h.canUndo());
    set('.nb-ink-redo', h.canRedo());
    set('.nb-ink-add-page', h.hasNote());
    set('.nb-ink-page-settings', h.hasNote());
    this.mark(this.el.querySelector<HTMLElement>('.nb-ink-pages-toggle')!, h.pagesOpen());
    // A command or a preset switched tools: the other tool's picker no longer applies.
    const open = this.picker.openFor;
    if (open && open !== 'page' && open !== pen.tool) this.picker.close();
    this.picker.render();
  }

  closePicker() {
    this.picker.close();
  }

  destroy() {
    this.picker.close();
  }

  /** Opens the picker of the tool in use under its button (for tests and commands). */
  openPicker() {
    const b = this.el.querySelector<HTMLElement>('.nb-ink-tool.is-active');
    if (b) this.picker.open(this.host.pen().tool, b, this.el);
  }

  private toolTapped(tool: ToolKind, b: HTMLElement) {
    if (this.host.pen().tool !== tool) {
      this.picker.close();
      this.host.setTool(tool);
      return;
    }
    if (this.picker.openFor === tool) this.picker.close();
    else this.picker.open(tool, b, this.el);
  }

  private presetTapped(i: number) {
    if (this.pressed === i) {
      this.pressed = -1;
      return;
    }
    this.picker.close();
    if (this.host.presets()[i]) this.host.applyPreset(i);
    else if (!notPreset(this.host.pen().tool)) this.host.savePreset(i);
  }

  /** A long press on a slot saves the current pen or highlighter into it. */
  private longPress(b: HTMLElement, i: number) {
    let timer = 0, x = 0, y = 0;
    const cancel = () => window.clearTimeout(timer);
    b.addEventListener('pointerdown', e => {
      cancel();
      this.pressed = -1;
      x = e.clientX;
      y = e.clientY;
      timer = window.setTimeout(() => {
        if (notPreset(this.host.pen().tool)) return;
        this.pressed = i;
        this.host.savePreset(i);
      }, LONG_PRESS_MS);
    });
    b.addEventListener('pointermove', e => {
      if (Math.hypot(e.clientX - x, e.clientY - y) > PRESS_SLOP) cancel();
    });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('pointerleave', cancel);
    // iOS shows its own menu on a long press otherwise.
    b.addEventListener('contextmenu', e => e.preventDefault());
  }

  private pageMenu(b: HTMLElement) {
    if (this.picker.openFor === 'page') this.picker.close();
    else this.picker.open('page', b, this.el);
  }

  private button(parent: HTMLElement, cls: string, icon: string | null, label: string, fn: () => void): HTMLButtonElement {
    const b = parent.createEl('button', { cls: `nb-ink-control nb-ink-button ${cls}`, attr: { type: 'button', 'aria-label': label, title: label } });
    if (icon) setIcon(b, icon);
    b.addEventListener('click', fn);
    return b;
  }

  private mark(el: HTMLElement, on: boolean) {
    el.toggleClass('is-active', on);
    el.setAttribute('aria-pressed', String(on));
  }
}

// The ink toolbar (#10): one row of buttons at the top of the ink view. Left: the tools (pen,
// highlighter, eraser, lasso #11) and the ruler toggle (#20: shows or hides the ruler; not a
// tool, the pen stays in use). Then, on wide views, an inline strip of colours (#71); the
// favourite presets; and the page actions: undo, redo, add page, Page (the page menu: templates,
// adding pages, export), Import (#54: a menu of PDFs and images, once or as templates), the
// Pages panel toggle and the page indicator (#64). Tapping the tool already in use opens its
// picker (a popover under the button, see picker.ts); so every tool, preset and picker option is
// at most two taps away. The toolbar knows nothing of the store: the view hands it a ToolbarHost.
//
// At a glance (#71): the pen and highlighter buttons are drawn in their current colour, with a
// 3 px bar under the icon as long as the size; the eraser carries a Part / Whole badge; the
// active tool has a small chevron, "tap again for options". At 900 px and up the colours sit in
// the toolbar (the pen's 8, or the highlighter's 5 while it is in use; a tap sets the colour,
// switching to the pen from the eraser or lasso). The row never wraps: when the page actions
// don't fit, all but undo and redo fold into a "⋯" menu, and "Page" and "Import" lose their
// labels first (toolbar-layout.ts has the order; each candidate is measured). The buttons are
// 36 or 44 px (setting "Toolbar size"). A one-line hint under the toolbar explains the taps
// until it is dismissed (setting `hintsShown`).
//
// Pencil taps (#53): the view's stylus blocker (blockStylusTouch, input.ts) is on the pages
// scroller only, so the toolbar takes the Pencil as a finger; every element here is still a
// button or carries `.nb-ink-control`, the mark of a control the Pencil must reach.
import { setIcon } from 'obsidian';
import { DEFAULT_INK } from '../format/page';
import {
  COLOR_PRESETS, HIGHLIGHTER_COLORS, matchesPreset, MAX_PRESETS, type ColorPreset, type EraserSettings, type HighlighterSettings,
  type PenPreset, type PenSettings, type ToolKind,
} from './pen';
import { Picker, type MenuItem, type PickerHost, type PickerKind } from './picker';
import { sizeBarWidth, toolbarLayouts, type ToolbarLayout, type ToolbarSize } from './toolbar-layout';

/** How long a press on a preset slot must last to save the current settings into it, in ms. */
export const LONG_PRESS_MS = 550;
/** Movement that cancels a long press, in CSS px. */
const PRESS_SLOP = 10;

/** The first-run hint (#71). */
export const HINT_TEXT = 'Tap a tool to use it, tap it again for colours and sizes. Fingers scroll and zoom; the Pencil writes.';

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
  /** The page indicator's text, e.g. "37 / 812" ('' with no pages), and what a tap on it does (#64). */
  pageLabel?(): string;
  goToPage?(): void;
  /** The ruler (#20): whether it's shown, and showing or hiding it. */
  rulerOn?(): boolean;
  toggleRuler?(): void;
  /** The button size (#71, setting "Toolbar size"); comfortable when absent. */
  toolbarSize?(): ToolbarSize;
  /** Whether to show the first-run hint, and its dismissal (#71, setting `hintsShown`). */
  showHint?(): boolean;
  dismissHint?(): void;
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

/** A colour's name among the presets, or its hex. */
function colourName(list: readonly ColorPreset[], color: string): string {
  return list.find(c => c.color === color)?.name ?? color;
}

export class Toolbar {
  readonly el: HTMLElement;
  /** The first-run hint under the toolbar (#71), while shown. */
  hintEl: HTMLElement | null = null;
  private picker: Picker;
  private presetEls: HTMLButtonElement[] = [];
  private toolEls: HTMLButtonElement[] = [];
  private stripEl: HTMLElement;
  /** Which colours the strip holds now. */
  private stripKind: 'pen' | 'highlighter' | null = null;
  private pageButton: HTMLButtonElement;
  private importEl: HTMLButtonElement;
  private moreEl: HTMLButtonElement;
  private pageEl: HTMLButtonElement;
  private pageText = '';
  /** The layout in use (#71), and the width and size it was chosen at. */
  layout: ToolbarLayout = { strip: false, collapsed: false, labels: true };
  private laidOut = { width: -1, size: '' };
  private resizeObserver: ResizeObserver | null = null;
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
      // #71: the size bar (pen, highlighter) or the mode badge (eraser), and the "options" chevron.
      if (t.tool === 'pen' || t.tool === 'highlighter') b.createSpan({ cls: 'nb-ink-tool-bar' });
      if (t.tool === 'eraser') b.createSpan({ cls: 'nb-ink-tool-badge' });
      setIcon(b.createSpan({ cls: 'nb-ink-tool-chevron', attr: { 'aria-hidden': 'true' } }), 'chevron-down');
      this.toolEls.push(b);
    }
    const ruler = this.button(tools, 'nb-ink-ruler', 'ruler', 'Ruler', () => host.toggleRuler?.());
    ruler.setAttribute('aria-pressed', 'false');

    // The inline colours (#71), shown at STRIP_MIN_WIDTH and up.
    this.stripEl = group('nb-ink-inline-colors');
    this.stripEl.setAttribute('role', 'group');
    this.stripEl.setAttribute('aria-label', 'Colours');

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
    // The rest fold into "⋯" when they don't fit (#71).
    this.button(page, 'nb-ink-add-page nb-ink-collapsible', 'file-plus', 'Add page', () => host.addPage());
    this.pageButton = this.button(page, 'nb-ink-page-settings nb-ink-collapsible', 'file-text', 'Page', () => this.menu('page', this.pageButton), 'Page');
    this.pageButton.setAttribute('aria-haspopup', 'dialog');
    this.importEl = this.button(page, 'nb-ink-import nb-ink-collapsible', 'import', 'Import PDF or image', () => this.menu('import', this.importEl), 'Import');
    this.importEl.setAttribute('aria-haspopup', 'dialog');
    const pages = this.button(page, 'nb-ink-pages-toggle nb-ink-collapsible', 'layout-list', 'Toggle pages panel', () => host.togglePages());
    pages.setAttribute('aria-pressed', 'false');
    // The current page and the page count; a tap asks for a page to go to (#64).
    this.pageEl = this.button(page, 'nb-ink-page-indicator nb-ink-collapsible', null, 'Go to page', () => host.goToPage?.());
    this.pageEl.setAttribute('aria-haspopup', 'dialog');
    this.moreEl = this.button(page, 'nb-ink-more', 'more-horizontal', 'More page actions', () => this.moreTapped());
    this.moreEl.setAttribute('aria-haspopup', 'dialog');

    if (host.showHint?.()) this.showHint();
    this.render();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.relayout());
      this.resizeObserver.observe(this.el);
    }
  }

  /** Shows the page indicator's text (hidden when ''). Cheap to call on every scroll. */
  setPage(text: string) {
    if (text === this.pageText) return;
    const longer = text.length !== this.pageText.length;
    this.pageText = text;
    this.pageEl.textContent = text;
    this.pageEl.toggleClass('is-empty', !text);
    const label = text ? `Page ${text.replace(' / ', ' of ')}: go to page` : 'Go to page';
    this.pageEl.setAttribute('aria-label', label);
    this.pageEl.title = label;
    if (longer) this.relayout(true); // another digit may no longer fit
  }

  get pickerOpen(): string | null {
    return this.picker.openFor;
  }

  /** Brings every button in line with the host's state (and the open picker). */
  render() {
    const h = this.host, pen = h.pen(), hl = h.highlighter();
    this.renderTools();
    this.renderStrip();
    const presets = h.presets();
    this.presetEls.forEach((b, i) => {
      const p = presets[i] ?? null;
      const mark = b.querySelector<HTMLElement>('.nb-ink-preset-mark')!;
      b.toggleClass('is-empty', !p);
      b.dataset.tool = p?.tool ?? '';
      b.toggleClass('is-default-ink', p?.color === DEFAULT_INK);
      mark.style.backgroundColor = p && p.color !== DEFAULT_INK ? p.color : '';
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
    this.setPage(h.pageLabel?.() ?? '');
    this.mark(this.el.querySelector<HTMLElement>('.nb-ink-ruler')!, !!h.rulerOn?.());
    this.el.toggleClass('is-compact', h.toolbarSize?.() === 'compact');
    // A command or a preset switched tools: the other tool's picker no longer applies.
    const open = this.picker.openFor;
    if (open && open !== 'page' && open !== 'import' && open !== 'more' && open !== pen.tool) this.picker.close();
    this.picker.render();
    this.relayout();
  }

  closePicker() {
    this.picker.close();
  }

  destroy() {
    this.picker.close();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** Opens the picker of the tool in use under its button (for tests and commands). */
  openPicker() {
    const b = this.el.querySelector<HTMLElement>('.nb-ink-tool.is-active');
    if (b) this.picker.open(this.host.pen().tool, b, this.el);
  }

  /**
   * Picks the roomiest layout that fits the toolbar's width (#71): toolbarLayouts in order,
   * each applied and measured. Runs when the width or the button size changed (a ResizeObserver,
   * render), or with `force` when the content's width did (the page indicator's digits).
   */
  relayout(force = false) {
    const width = this.el.clientWidth, size = this.el.hasClass('is-compact') ? 'compact' : 'comfortable';
    if (!width) return; // not shown yet
    if (!force && width === this.laidOut.width && size === this.laidOut.size) return;
    this.laidOut = { width, size };
    const tries = toolbarLayouts(width);
    for (const [i, l] of tries.entries()) {
      this.applyLayout(l);
      if (i === tries.length - 1 || this.el.scrollWidth <= this.el.clientWidth) break;
    }
    // A menu hanging from a button that is no longer shown closes ("⋯"'s too, when it goes).
    const a = this.picker.anchorEl, l = this.layout;
    if (a && (a === this.moreEl ? !l.collapsed : l.collapsed && a.hasClass('nb-ink-collapsible'))) this.picker.close();
  }

  private applyLayout(l: ToolbarLayout) {
    this.layout = l;
    this.el.toggleClass('has-strip', l.strip);
    this.el.toggleClass('is-collapsed', l.collapsed);
    this.el.toggleClass('has-labels', l.labels);
  }

  /** The tools (#71): each one's colour, size bar or badge, and its tooltip. */
  private renderTools() {
    const pen = this.host.pen(), hl = this.host.highlighter(), er = this.host.eraser();
    for (const b of this.toolEls) {
      const tool = b.dataset.tool as ToolKind, active = tool === pen.tool;
      this.mark(b, active);
      let title = TOOLS.find(t => t.tool === tool)!.label;
      if (tool === 'pen' || tool === 'highlighter') {
        const color = tool === 'pen' ? pen.color : hl.color, size = tool === 'pen' ? pen.size : hl.size;
        const def = color === DEFAULT_INK;
        b.toggleClass('is-default-ink', def);
        if (def) b.style.removeProperty('--nb-tool-color');
        else b.style.setProperty('--nb-tool-color', color);
        b.querySelector<HTMLElement>('.nb-ink-tool-bar')!.style.width = `${sizeBarWidth(tool, size)}px`;
        title += `: ${colourName(tool === 'pen' ? COLOR_PRESETS : HIGHLIGHTER_COLORS, color)}, ${size} px${tool === 'pen' ? `, ${pen.nib}` : ''}`;
      } else if (tool === 'eraser') {
        b.querySelector('.nb-ink-tool-badge')!.setText(er.mode === 'partial' ? 'Part' : 'Whole');
        b.dataset.mode = er.mode;
        title += er.mode === 'partial' ? ': partial' : ': whole strokes';
      }
      if (active) title += ' (tap again for options)';
      b.title = title;
    }
  }

  /** The inline colours (#71): the highlighter's while it is in use, else the pen's. */
  private renderStrip() {
    const pen = this.host.pen(), kind = pen.tool === 'highlighter' ? 'highlighter' : 'pen';
    if (kind !== this.stripKind) {
      this.stripKind = kind;
      this.stripEl.empty();
      for (const { color, name } of kind === 'pen' ? COLOR_PRESETS : HIGHLIGHTER_COLORS) {
        const label = kind === 'pen' ? `${name} pen` : `${name} highlighter`;
        const b = this.button(this.stripEl, `nb-ink-inline-swatch${kind === 'highlighter' ? ' is-highlighter' : ''}`, null, label, () => this.swatchTapped(color));
        b.dataset.color = color;
        b.createSpan({ cls: 'nb-ink-inline-dot' });
        if (color === DEFAULT_INK) b.addClass('is-default-ink');
        else b.style.setProperty('--nb-swatch', color);
      }
    }
    const current = pen.tool === 'pen' ? pen.color : pen.tool === 'highlighter' ? this.host.highlighter().color : null;
    this.stripEl.querySelectorAll<HTMLElement>('.nb-ink-inline-swatch').forEach(b => this.mark(b, b.dataset.color === current));
  }

  /** A tap on an inline colour: the highlighter's or the pen's colour; from the eraser or lasso, the pen with it. */
  private swatchTapped(color: string) {
    const h = this.host;
    if (this.stripKind === 'highlighter') h.setHighlighter({ color });
    else if (h.pen().tool === 'pen') h.setPen({ color });
    else h.setPen({ tool: 'pen', color });
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

  /**
   * The Page or Import menu (#54), toggled by its button; when the button is folded into "⋯"
   * (#71), the menu hangs from "⋯" instead.
   */
  private menu(kind: PickerKind, b: HTMLElement) {
    if (this.picker.openFor === kind) {
      this.picker.close();
      return;
    }
    const folded = this.layout.collapsed;
    this.picker.open(kind, folded ? this.moreEl : b, this.el, { owner: b });
  }

  /** "⋯" (#71): the page actions that don't fit, as a menu; a second tap closes it (or a menu opened from it). */
  private moreTapped() {
    if (this.picker.openFor && this.picker.anchorEl === this.moreEl) {
      this.picker.close();
      return;
    }
    const h = this.host, note = h.hasNote(), label = h.pageLabel?.() ?? '';
    const done = (fn: () => void) => () => {
      this.picker.close();
      fn();
    };
    const items: MenuItem[] = [
      { cls: 'nb-ink-more-add-page', text: 'Add page', disabled: !note, run: done(() => h.addPage()) },
      { cls: 'nb-ink-more-page', text: 'Page…', disabled: !note, run: () => this.menu('page', this.pageButton) },
      { cls: 'nb-ink-more-import', text: 'Import…', run: () => this.menu('import', this.importEl) },
      { cls: 'nb-ink-more-pages', text: 'Pages panel', pressed: h.pagesOpen(), run: done(() => h.togglePages()) },
      { cls: 'nb-ink-more-go-to', text: label ? `Go to page… (${label})` : 'Go to page…', disabled: !label, run: done(() => h.goToPage?.()) },
    ];
    this.picker.open('more', this.moreEl, this.el, { items });
  }

  /** The first-run hint (#71): one line under the toolbar until its × is tapped. */
  private showHint() {
    const hint = this.hintEl = this.root.createDiv({ cls: 'nb-ink-control nb-ink-hint', attr: { role: 'note' } });
    hint.createSpan({ cls: 'nb-ink-hint-text', text: HINT_TEXT });
    const close = hint.createEl('button', { cls: 'nb-ink-control nb-ink-hint-close', attr: { type: 'button', 'aria-label': 'Dismiss hint', title: 'Dismiss hint' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => {
      hint.remove();
      this.hintEl = null;
      this.host.dismissHint?.();
    });
  }

  /** A toolbar button; `text` is a label shown beside the icon on wide layouts (#71). */
  private button(parent: HTMLElement, cls: string, icon: string | null, label: string, fn: () => void, text?: string): HTMLButtonElement {
    const b = parent.createEl('button', { cls: `nb-ink-control nb-ink-button ${cls}`, attr: { type: 'button', 'aria-label': label, title: label } });
    if (icon) setIcon(b, icon);
    if (text) {
      b.addClass('has-label');
      b.createSpan({ cls: 'nb-ink-button-label', text, attr: { 'aria-hidden': 'true' } });
    }
    b.addEventListener('click', fn);
    return b;
  }

  private mark(el: HTMLElement, on: boolean) {
    el.toggleClass('is-active', on);
    el.setAttribute('aria-pressed', String(on));
  }
}

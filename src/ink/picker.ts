// The toolbar's popover (#10): the picker of the tool in use (pen: nib, colours, custom colour,
// size in 0.5 px steps, a live preview and "Save as favourite"; highlighter: the same without
// the nib; eraser: sizes and mode; lasso, #11: a hint and Paste), the page settings menu
// (templates; #54, saving the page's background as a template and adding a page from a favourite
// template; export) and the Import menu (#54: PDFs and images, once or as templates, which took
// over #12's image entries from the page settings menu). A plain positioned div inside the
// ink view, not a Modal, so the page stays visible; closed by a tap elsewhere (starting to
// write included), Escape, or tapping its button again. Choosing an option leaves it open so
// that colour, nib and size can all be set in one visit.
//
// #71: the size is a slider (a log scale from 0.5 to 16 px, 4 to 48 for the highlighter; the
// quick sizes are tappable ticks under it, the value is shown beside its label, the preview
// follows every move; −/+ stay for exact 0.5 px steps, and so do the arrow keys). It is a div
// with role slider rather than an <input type=range>: WebKit's range input only follows a drag
// that starts on its thumb, where this one jumps to a tap anywhere on the track, and synthetic
// pointer events in the view test drive it exactly as a finger or the Pencil do. The page menu
// (now "Page") is grouped (Template, Add page, Export) with separators, and the toolbar's "⋯"
// overflow menu (kind `more`) is a list of entries the toolbar hands over.
import { strokePath } from '../format/outline';
import type { Nib, Point } from '../format/page';
import {
  COLOR_PRESETS, DEFAULT_PEN, ERASER_SIZES, HIGHLIGHTER_COLORS, HIGHLIGHTER_SIZES, MAX_PRESETS, SIZE_PRESETS, sizeRange, sliderPosition,
  sliderSize, stepSize, type ColorPreset, type EraserMode, type EraserSettings, type HighlighterSettings, type PenPreset, type PenSettings,
  type ToolKind,
} from './pen';
import { canvasPath, HIGHLIGHT_ALPHA, paintPath, type Theme } from './renderer';

export type PickerKind = ToolKind | 'page' | 'import' | 'more';

/** An entry of a menu the toolbar hands the picker (#71: the "⋯" overflow menu). */
export interface MenuItem {
  /** Its class, also its handle in tests. */
  cls: string;
  text: string;
  /** Run when tapped; the entry decides whether the menu closes. */
  run(): void;
  disabled?: boolean;
  /** For a toggle (the Pages panel): whether it is on. */
  pressed?: boolean;
}

/** How far the slider's keys move the size: arrows one 0.5 px step, Page Up/Down this many. */
const PAGE_STEPS = 4;

/** The Import menu's entries (#54). */
export type ImportKind = 'pdf-pages' | 'pdf-template' | 'image-page' | 'image-template' | 'image-here' | 'paste-image';

/** The Import menu (#54): each entry (also its class, `nb-ink-import-<entry>`) and its text. */
export const IMPORT_ITEMS: readonly [ImportKind, string][] = [
  ['pdf-pages', 'PDF as pages in this note…'],
  ['pdf-template', 'PDF page as a template…'],
  ['image-page', 'Image as a page…'],
  ['image-template', 'Image as a template…'],
  ['image-here', 'Image onto this page…'],
  ['paste-image', 'Paste image'],
];

export interface PickerHost {
  pen(): Readonly<PenSettings>;
  highlighter(): Readonly<HighlighterSettings>;
  eraser(): Readonly<EraserSettings>;
  setPen(change: Partial<PenSettings>): void;
  setHighlighter(change: Partial<HighlighterSettings>): void;
  setEraser(change: Partial<EraserSettings>): void;
  presets(): readonly (PenPreset | null)[];
  savePreset(index: number): void;
  theme(): Theme;
  chooseTemplate(scope: 'add' | 'page' | 'all'): void;
  paperLabel(): string | null;
  /** Whether strokes were copied (#11), and pasting them into the current page. */
  canPaste(): boolean;
  paste(): void;
  /** Export the note as a PDF (#18). */
  exportPdf?(): void;
  /** The Import menu's entries (#54). */
  importAction?(kind: ImportKind): void;
  /** Saves the current page's background as a template (#54). */
  saveTemplate?(): void;
  /** Favourite templates for "Add page" entries in the page menu (#54), and adding one. */
  favouriteTemplates?(): { name: string; label: string }[];
  addTemplatePage?(name: string): void;
  /** The ruler (#20), shown in the pen and highlighter pickers while it's on: angle and unit. */
  rulerOn?(): boolean;
  rulerAngle?(): number | null;
  setRulerAngle?(angle: number): void;
  rulerUnit?(): 'cm' | 'in';
  setRulerUnit?(unit: 'cm' | 'in'): void;
}

/** Preview canvas size in CSS px. */
const PREVIEW_W = 220, PREVIEW_H = 60;

/** The preview's S-curve in canvas px, with pressure rising then falling (for the pressure nib). */
export function previewPoints(width = PREVIEW_W, height = PREVIEW_H): Point[] {
  const pts: Point[] = [];
  const n = 40, x0 = 24, x1 = width - 24, amp = height * 0.22;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push({ x: x0 + (x1 - x0) * u, y: height / 2 - amp * Math.sin(u * 2 * Math.PI), p: 0.25 + 0.6 * Math.sin(u * Math.PI), t: i * 8 });
  }
  return pts;
}

export class Picker {
  readonly el: HTMLElement;
  /** What the popover shows, or null when closed. */
  openFor: PickerKind | null = null;
  /** Times the preview was drawn, for tests. */
  previews = 0;
  private anchor: HTMLElement | null = null;
  /** The button whose menu this is, when the popover hangs from another one (the "⋯" button, #71). */
  private owner: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private replaceRow: HTMLElement | null = null;
  private onDown = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (this.el.contains(t) || this.anchor?.contains(t))) return;
    this.close();
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    this.close();
  };

  constructor(private root: HTMLElement, private host: PickerHost) {
    this.el = root.createDiv({ cls: 'nb-ink-control nb-ink-picker', attr: { role: 'dialog' } });
    this.el.hide();
  }

  /** The button the popover hangs from, while open. */
  get anchorEl(): HTMLElement | null {
    return this.anchor;
  }

  /**
   * Opens the popover for `kind` under `anchor` (a button of `bar`). `owner` is the button whose
   * menu it is when that button is folded away and the popover hangs from "⋯" (#71); `items` are
   * the entries of the `more` menu.
   */
  open(kind: PickerKind, anchor: HTMLElement, bar: HTMLElement, opts: { owner?: HTMLElement; items?: readonly MenuItem[] } = {}) {
    this.close();
    this.openFor = kind;
    this.anchor = anchor;
    this.owner = opts.owner && opts.owner !== anchor ? opts.owner : null;
    this.el.empty();
    this.el.dataset.kind = kind;
    this.el.setAttribute('aria-label', kind === 'page' ? 'Page' : kind === 'import' ? 'Import' : kind === 'more' ? 'More page actions'
      : `${kind[0].toUpperCase()}${kind.slice(1)} settings`);
    if (kind === 'pen' || kind === 'highlighter') this.buildInk(kind);
    else if (kind === 'eraser') this.buildEraser();
    else if (kind === 'lasso') this.buildLasso();
    else if (kind === 'import') this.buildImport();
    else if (kind === 'more') this.buildMenu(opts.items ?? []);
    else this.buildPage();
    this.el.show();
    anchor.setAttribute('aria-expanded', 'true');
    this.owner?.setAttribute('aria-expanded', 'true');
    // Under the button, kept inside the view.
    const r = this.root.getBoundingClientRect(), a = anchor.getBoundingClientRect(), b = bar.getBoundingClientRect();
    this.el.style.top = `${b.bottom - r.top + 4}px`;
    const w = this.el.offsetWidth;
    this.el.style.left = `${Math.max(8, Math.min(a.left - r.left, r.width - w - 8))}px`;
    const doc = this.root.ownerDocument;
    doc.addEventListener('pointerdown', this.onDown, true);
    doc.addEventListener('keydown', this.onKey, true);
    this.render();
  }

  close() {
    if (!this.openFor) return;
    this.openFor = null;
    this.anchor?.setAttribute('aria-expanded', 'false');
    this.owner?.setAttribute('aria-expanded', 'false');
    this.anchor = this.owner = null;
    this.drag = null;
    this.canvas = this.replaceRow = null;
    this.el.hide();
    this.el.empty();
    const doc = this.root.ownerDocument;
    doc.removeEventListener('pointerdown', this.onDown, true);
    doc.removeEventListener('keydown', this.onKey, true);
  }

  /** Marks the chosen options and redraws the preview. */
  render() {
    const kind = this.openFor;
    if (!kind || kind === 'page' || kind === 'lasso' || kind === 'import' || kind === 'more') return;
    const h = this.host, pen = h.pen(), hl = h.highlighter(), er = h.eraser();
    const mark = (sel: string, on: (el: HTMLElement) => boolean) => this.el.querySelectorAll<HTMLElement>(sel).forEach(el => {
      const active = on(el);
      el.toggleClass('is-active', active);
      el.setAttribute('aria-pressed', String(active));
    });
    if (kind === 'eraser') {
      mark('.nb-ink-eraser-size', el => Number(el.dataset.eraserSize) === er.size);
      mark('.nb-ink-eraser-mode', el => el.dataset.eraserMode === er.mode);
      return;
    }
    const color = kind === 'pen' ? pen.color : hl.color, size = kind === 'pen' ? pen.size : hl.size;
    mark('.nb-ink-nib', el => el.dataset.nib === pen.nib);
    mark('.nb-ink-swatch, .nb-ink-hl-swatch', el => el.dataset.color === color);
    mark('.nb-ink-size, .nb-ink-hl-size', el => Number(el.dataset.size) === size);
    const custom = this.el.querySelector<HTMLInputElement>('.nb-ink-custom-color');
    if (custom) {
      custom.value = color;
      const isCustom = !(kind === 'pen' ? COLOR_PRESETS : HIGHLIGHTER_COLORS).some(c => c.color === color);
      custom.parentElement?.toggleClass('is-active', isCustom);
    }
    this.el.querySelector('.nb-ink-size-value')?.setText(`${size} px`);
    this.renderSlider(kind, size);
    mark('.nb-ink-ruler-unit', el => el.dataset.unit === h.rulerUnit?.());
    const angle = this.el.querySelector<HTMLInputElement>('.nb-ink-ruler-angle-input'), a = h.rulerAngle?.();
    if (angle && a != null && angle.ownerDocument.activeElement !== angle) angle.value = String(Math.round(a * 10) / 10);
    this.drawPreview(kind, color, size, pen.nib);
  }

  private buildInk(kind: 'pen' | 'highlighter') {
    const h = this.host, el = this.el;
    const set = (change: { color?: string; size?: number }) => (kind === 'pen' ? h.setPen(change) : h.setHighlighter(change));
    const size = () => (kind === 'pen' ? h.pen().size : h.highlighter().size);
    if (kind === 'pen') {
      const nibs = this.row('nb-ink-nibs', 'Pen type');
      for (const [nib, text] of [['uniform', 'Uniform'], ['pressure', 'Pressure']] as [Nib, string][]) {
        this.option(nibs, 'nb-ink-nib', text, `${text} pen`, () => h.setPen({ nib })).dataset.nib = nib;
      }
    }
    const colors = this.row(kind === 'pen' ? 'nb-ink-colors' : 'nb-ink-highlighter', 'Colour');
    const presets: readonly ColorPreset[] = kind === 'pen' ? COLOR_PRESETS : HIGHLIGHTER_COLORS;
    for (const { color, name } of presets) {
      const b = this.option(colors, kind === 'pen' ? 'nb-ink-swatch' : 'nb-ink-hl-swatch', '', kind === 'pen' ? name : `${name} highlighter`, () => set({ color }));
      b.dataset.color = color;
      if (color === DEFAULT_PEN.color) b.addClass('is-default-ink');
      else b.style.backgroundColor = color;
    }
    const wrap = colors.createEl('label', { cls: 'nb-ink-control nb-ink-custom', attr: { 'aria-label': 'Custom colour', title: 'Custom colour' } });
    const input = wrap.createEl('input', { cls: 'nb-ink-control nb-ink-custom-color', attr: { type: 'color' } });
    input.addEventListener('input', () => set({ color: input.value }));

    // Thickness (#71): the label and the value, then −, the slider with the quick sizes as ticks, +.
    const sizes = this.row(kind === 'pen' ? 'nb-ink-sizes' : 'nb-ink-hl-sizes', null);
    const head = sizes.createDiv({ cls: 'nb-ink-control nb-ink-slider-head' });
    head.createSpan({ cls: 'nb-ink-control nb-ink-picker-label', text: 'Thickness' });
    head.createSpan({ cls: 'nb-ink-control nb-ink-size-value' });
    this.option(sizes, 'nb-ink-step', '−', 'Thinner', () => set({ size: stepSize(kind, size(), -1) })).dataset.step = '-1';
    const slot = sizes.createDiv({ cls: 'nb-ink-control nb-ink-slider-wrap' });
    this.buildSlider(slot, kind, size, s => set({ size: s }));
    const ticks = slot.createDiv({ cls: 'nb-ink-control nb-ink-slider-ticks' });
    for (const s of kind === 'pen' ? SIZE_PRESETS : HIGHLIGHTER_SIZES) {
      const b = this.option(ticks, kind === 'pen' ? 'nb-ink-size' : 'nb-ink-hl-size', String(s), `${kind === 'pen' ? 'Size' : 'Highlighter size'} ${s} px`, () => set({ size: s }));
      b.dataset.size = String(s);
      b.style.setProperty('--nb-u', String(sliderPosition(kind, s)));
    }
    this.option(sizes, 'nb-ink-step', '+', 'Thicker', () => set({ size: stepSize(kind, size(), 1) })).dataset.step = '1';

    if (h.rulerOn?.()) this.buildRuler();

    this.canvas = el.createEl('canvas', { cls: 'nb-ink-control nb-ink-preview', attr: { 'aria-label': 'Preview' } });
    this.canvas.style.width = `${PREVIEW_W}px`;
    this.canvas.style.height = `${PREVIEW_H}px`;

    const fav = this.row('nb-ink-favourite', null);
    this.option(fav, 'nb-ink-save-preset', 'Save as favourite', 'Save as favourite', () => this.saveFavourite());
    const status = fav.createSpan({ cls: 'nb-ink-control nb-ink-save-status' });
    status.hide();
    this.replaceRow = this.row('nb-ink-replace', 'Replace');
    this.replaceRow.hide();
    for (let i = 0; i < MAX_PRESETS; i++) {
      this.option(this.replaceRow, 'nb-ink-replace-slot', String(i + 1), `Replace favourite ${i + 1}`, () => this.saved(i)).dataset.slot = String(i);
    }
  }

  /** The ruler's row (#20): an exact angle, and the unit of its ticks and length label. */
  private buildRuler() {
    const h = this.host, row = this.row('nb-ink-ruler-row', 'Ruler');
    const input = row.createEl('input', { cls: 'nb-ink-control nb-ink-ruler-angle-input',
      attr: { type: 'number', min: '0', max: '360', step: 'any', inputmode: 'decimal', 'aria-label': 'Ruler angle in degrees' } });
    const apply = () => {
      const n = Number(input.value);
      if (input.value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 360) h.setRulerAngle?.(n);
    };
    input.addEventListener('change', apply);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') apply();
    });
    row.createSpan({ cls: 'nb-ink-control nb-ink-picker-label', text: '°' });
    for (const unit of ['cm', 'in'] as const) {
      this.option(row, 'nb-ink-ruler-unit', unit, `Measure in ${unit === 'cm' ? 'centimetres' : 'inches'}`, () => h.setRulerUnit?.(unit)).dataset.unit = unit;
    }
  }

  /** The slider's drag: the pointer it follows, or null. */
  private drag: number | null = null;

  /**
   * The size slider (#71): a track with a fill and a thumb, on the log scale of `sliderSize`. A
   * tap or a drag anywhere on it sets the size from the pointer (finger, Pencil or mouse; the
   * pointer is captured, so a drag may leave it); the arrow keys step 0.5 px, Page Up/Down four
   * steps, Home/End go to the ends.
   */
  private buildSlider(parent: HTMLElement, kind: 'pen' | 'highlighter', size: () => number, set: (size: number) => void) {
    const { min, max } = sizeRange(kind);
    const slider = parent.createDiv({ cls: 'nb-ink-control nb-ink-slider', attr: {
      role: 'slider', tabindex: '0', 'aria-label': kind === 'pen' ? 'Pen thickness' : 'Highlighter thickness',
      'aria-valuemin': String(min), 'aria-valuemax': String(max), 'aria-orientation': 'horizontal',
    } });
    const track = slider.createDiv({ cls: 'nb-ink-control nb-ink-slider-track' });
    track.createDiv({ cls: 'nb-ink-control nb-ink-slider-fill' });
    slider.createDiv({ cls: 'nb-ink-control nb-ink-slider-thumb' });
    const setFrom = (x: number) => {
      const r = track.getBoundingClientRect();
      if (r.width <= 0) return;
      const s = sliderSize(kind, (x - r.left) / r.width);
      if (s !== size()) set(s);
    };
    slider.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      e.preventDefault(); // no text selection or native drag; focus by hand for the keys
      slider.focus({ preventScroll: true });
      this.drag = e.pointerId;
      try {
        slider.setPointerCapture(e.pointerId);
      } catch {
        // a synthetic or already-lifted pointer: the moves still arrive on the slider
      }
      setFrom(e.clientX);
    });
    slider.addEventListener('pointermove', e => {
      if (this.drag === e.pointerId) setFrom(e.clientX);
    });
    const end = (e: PointerEvent) => {
      if (this.drag !== e.pointerId) return;
      this.drag = null;
      try {
        slider.releasePointerCapture(e.pointerId);
      } catch {
        // not captured
      }
    };
    slider.addEventListener('pointerup', end);
    slider.addEventListener('pointercancel', end);
    slider.addEventListener('keydown', e => {
      const step = (dir: -1 | 1, n = 1) => {
        let s = size();
        for (let i = 0; i < n; i++) s = stepSize(kind, s, dir);
        return s;
      };
      let next: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = step(1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = step(-1);
      else if (e.key === 'PageUp') next = step(1, PAGE_STEPS);
      else if (e.key === 'PageDown') next = step(-1, PAGE_STEPS);
      else if (e.key === 'Home') next = min;
      else if (e.key === 'End') next = max;
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation(); // not the view's or Obsidian's keys
      if (next !== size()) set(next);
    });
  }

  /** Moves the slider's thumb and fill to `size` and says it to assistive tech. */
  private renderSlider(kind: 'pen' | 'highlighter', size: number) {
    const slider = this.el.querySelector<HTMLElement>('.nb-ink-slider');
    if (!slider) return;
    slider.style.setProperty('--nb-u', String(sliderPosition(kind, size)));
    slider.setAttribute('aria-valuenow', String(size));
    slider.setAttribute('aria-valuetext', `${size} px`);
  }

  private buildEraser() {
    const sizes = this.row('nb-ink-eraser-sizes', 'Size');
    ERASER_SIZES.forEach((size, i) => {
      this.option(sizes, 'nb-ink-eraser-size', i ? 'Large' : 'Small', `Eraser size ${size} px`, () => this.host.setEraser({ size })).dataset.eraserSize = String(size);
    });
    const modes = this.row('nb-ink-eraser-modes', 'Erase');
    const list: [EraserMode, string, string][] = [['partial', 'Partial', 'Erase only the part under the eraser'], ['stroke', 'Whole strokes', 'Erase whole strokes']];
    for (const [mode, text, label] of list) {
      this.option(modes, 'nb-ink-eraser-mode', text, label, () => this.host.setEraser({ mode })).dataset.eraserMode = mode;
    }
  }

  private buildLasso() {
    this.el.createDiv({ cls: 'nb-ink-control nb-ink-lasso-hint',
      text: 'Draw a loop around strokes to select them, or tap an image. Drag the selection to move it, its corner to resize it.' });
    const b = this.option(this.el, 'nb-ink-menu-item nb-ink-lasso-paste', 'Paste', 'Paste strokes', () => {
      this.close();
      this.host.paste();
    });
    b.disabled = !this.host.canPaste();
  }

  /**
   * The page menu (#10, named "Page" since #71), in groups under headings with separators between
   * them: Template (this page, all pages, saving this page's background, #54), Add page (with a
   * template, or a favourite template, #54) and Export (#18); then the paper size.
   */
  private buildPage() {
    const h = this.host;
    const item = (cls: string, text: string, label: string, fn: () => void) => this.option(this.el, `nb-ink-menu-item ${cls}`, text, label, () => {
      this.close();
      fn();
    });
    this.heading('Template', false);
    item('nb-ink-menu-page-template', 'Template of this page…', 'Template of this page…', () => h.chooseTemplate('page'));
    item('nb-ink-menu-all-templates', 'Template of all pages…', 'Template of all pages…', () => h.chooseTemplate('all'));
    if (h.saveTemplate) item('nb-ink-menu-save-template', "Save this page's background as a template…", "Save this page's background as a template", () => h.saveTemplate!());
    this.heading('Add page', true);
    item('nb-ink-menu-add-with', 'Add page with template…', 'Add page with template…', () => h.chooseTemplate('add'));
    for (const f of h.favouriteTemplates?.() ?? []) {
      item('nb-ink-menu-add-favourite', `Add page: ★ ${f.label}`, `Add a page with the favourite template ${f.label}`, () => h.addTemplatePage?.(f.name))
        .dataset.template = f.name;
    }
    if (h.exportPdf) {
      this.heading('Export', true);
      item('nb-ink-menu-export-pdf', 'Export as PDF…', 'Export as PDF…', () => h.exportPdf!());
    }
    this.separator();
    const paper = h.paperLabel();
    this.el.createDiv({ cls: 'nb-ink-control nb-ink-paper', text: `Paper size: ${paper ?? 'unknown'}` });
  }

  /** A group's heading in a menu, after a separator unless it is the first. */
  private heading(text: string, separated: boolean) {
    if (separated) this.separator();
    this.el.createDiv({ cls: 'nb-ink-control nb-ink-menu-heading', text });
  }

  private separator() {
    this.el.createDiv({ cls: 'nb-ink-control nb-ink-menu-sep', attr: { role: 'separator' } });
  }

  /** A menu of entries the toolbar hands over (#71: the "⋯" overflow menu). */
  private buildMenu(items: readonly MenuItem[]) {
    for (const it of items) {
      const b = this.option(this.el, `nb-ink-menu-item ${it.cls}`, it.text, it.text, () => it.run());
      b.disabled = !!it.disabled;
      if (it.pressed !== undefined) {
        b.setAttribute('aria-pressed', String(it.pressed));
        b.toggleClass('is-on', it.pressed);
      }
    }
  }

  /** The Import menu (#54): each entry asks for its source (vault or device) next. */
  private buildImport() {
    const h = this.host;
    for (const [kind, text] of IMPORT_ITEMS) {
      this.option(this.el, `nb-ink-menu-item nb-ink-import-${kind}`, text, text, () => {
        this.close();
        h.importAction?.(kind);
      }).dataset.import = kind;
    }
  }

  /** Saves into the first free slot, or asks which to replace when all are taken. */
  private saveFavourite() {
    const free = this.host.presets().findIndex(p => !p);
    const slots = this.host.presets().length;
    if (free >= 0) this.saved(free);
    else if (slots < MAX_PRESETS) this.saved(slots);
    else this.replaceRow?.show();
  }

  private saved(i: number) {
    this.host.savePreset(i);
    this.replaceRow?.hide();
    const status = this.el.querySelector<HTMLElement>('.nb-ink-save-status');
    status?.setText(`Saved as favourite ${i + 1}`);
    status?.show();
  }

  private drawPreview(kind: 'pen' | 'highlighter', color: string, size: number, nib: Nib) {
    const c = this.canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(PREVIEW_W * dpr), hgt = Math.round(PREVIEW_H * dpr);
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const theme = this.host.theme();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.paper;
    ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
    const points = previewPoints();
    const style = kind === 'pen' ? { tool: 'pen' as const, nib, size } : { tool: 'highlighter' as const, size };
    const d = strokePath({ ...style, points });
    if (kind === 'highlighter') ctx.globalAlpha = HIGHLIGHT_ALPHA;
    paintPath(ctx, style, canvasPath(style, d), color === DEFAULT_PEN.color ? theme.ink : color);
    ctx.globalAlpha = 1;
    this.previews++;
  }

  private row(cls: string, label: string | null): HTMLElement {
    const row = this.el.createDiv({ cls: `nb-ink-control nb-ink-picker-row ${cls}` });
    if (label) row.createSpan({ cls: 'nb-ink-control nb-ink-picker-label', text: label });
    return row;
  }

  private option(parent: HTMLElement, cls: string, text: string, label: string, fn: () => void): HTMLButtonElement {
    const b = parent.createEl('button', { cls: `nb-ink-control ${cls}`, text, attr: { type: 'button', 'aria-label': label, title: label } });
    b.addEventListener('click', fn);
    return b;
  }
}

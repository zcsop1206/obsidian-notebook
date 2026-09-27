// The toolbar's popover (#10): the picker of the tool in use (pen: nib, colours, custom colour,
// size in 0.5 px steps, a live preview and "Save as favourite"; highlighter: the same without
// the nib; eraser: sizes and mode; lasso, #11: a hint and Paste), the page settings menu
// (templates; #54, saving the page's background as a template and adding a page from a favourite
// template; export) and the Import menu (#54: PDFs and images, once or as templates, which took
// over #12's image entries from the page settings menu). A plain positioned div inside the
// ink view, not a Modal, so the page stays visible; closed by a tap elsewhere (starting to
// write included), Escape, or tapping its button again. Choosing an option leaves it open so
// that colour, nib and size can all be set in one visit.
import { strokePath } from '../format/outline';
import type { Nib, Point } from '../format/page';
import {
  COLOR_PRESETS, DEFAULT_PEN, ERASER_SIZES, HIGHLIGHTER_COLORS, HIGHLIGHTER_SIZES, MAX_PRESETS, SIZE_PRESETS, stepSize,
  type ColorPreset, type EraserMode, type EraserSettings, type HighlighterSettings, type PenPreset, type PenSettings, type ToolKind,
} from './pen';
import { HIGHLIGHT_ALPHA, type Theme } from './renderer';

export type PickerKind = ToolKind | 'page' | 'import';

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

  /** Opens the popover for `kind` under `anchor` (a button of `bar`). */
  open(kind: PickerKind, anchor: HTMLElement, bar: HTMLElement) {
    this.close();
    this.openFor = kind;
    this.anchor = anchor;
    this.el.empty();
    this.el.dataset.kind = kind;
    this.el.setAttribute('aria-label', kind === 'page' ? 'Page settings' : kind === 'import' ? 'Import' : `${kind[0].toUpperCase()}${kind.slice(1)} settings`);
    if (kind === 'pen' || kind === 'highlighter') this.buildInk(kind);
    else if (kind === 'eraser') this.buildEraser();
    else if (kind === 'lasso') this.buildLasso();
    else if (kind === 'import') this.buildImport();
    else this.buildPage();
    this.el.show();
    anchor.setAttribute('aria-expanded', 'true');
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
    this.anchor = null;
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
    if (!kind || kind === 'page' || kind === 'lasso' || kind === 'import') return;
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

    const sizes = this.row(kind === 'pen' ? 'nb-ink-sizes' : 'nb-ink-hl-sizes', 'Thickness');
    this.option(sizes, 'nb-ink-step', '−', 'Thinner', () => set({ size: stepSize(kind, size(), -1) })).dataset.step = '-1';
    sizes.createSpan({ cls: 'nb-ink-control nb-ink-size-value' });
    this.option(sizes, 'nb-ink-step', '+', 'Thicker', () => set({ size: stepSize(kind, size(), 1) })).dataset.step = '1';
    for (const s of kind === 'pen' ? SIZE_PRESETS : HIGHLIGHTER_SIZES) {
      this.option(sizes, kind === 'pen' ? 'nb-ink-size' : 'nb-ink-hl-size', String(s), `${kind === 'pen' ? 'Size' : 'Highlighter size'} ${s} px`, () => set({ size: s })).dataset.size = String(s);
    }

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

  private buildPage() {
    const h = this.host;
    const item = (cls: string, text: string, fn: () => void) => {
      this.option(this.el, `nb-ink-menu-item ${cls}`, text, text, () => {
        this.close();
        fn();
      });
    };
    item('nb-ink-menu-page-template', 'Template of this page…', () => h.chooseTemplate('page'));
    item('nb-ink-menu-all-templates', 'Template of all pages…', () => h.chooseTemplate('all'));
    item('nb-ink-menu-add-with', 'Add page with template…', () => h.chooseTemplate('add'));
    this.buildTemplateEntries();
    if (h.exportPdf) item('nb-ink-menu-export-pdf', 'Export as PDF…', () => h.exportPdf!());
    const paper = h.paperLabel();
    this.el.createDiv({ cls: 'nb-ink-control nb-ink-paper', text: `Paper size: ${paper ?? 'unknown'}` });
  }

  /** The page menu's template entries (#54): a page from each favourite template, and saving this page's background. */
  private buildTemplateEntries() {
    const h = this.host;
    const item = (cls: string, text: string, label: string, fn: () => void) => this.option(this.el, `nb-ink-menu-item ${cls}`, text, label, () => {
      this.close();
      fn();
    });
    for (const f of h.favouriteTemplates?.() ?? []) {
      item('nb-ink-menu-add-favourite', `Add page: ★ ${f.label}`, `Add a page with the favourite template ${f.label}`, () => h.addTemplatePage?.(f.name))
        .dataset.template = f.name;
    }
    if (h.saveTemplate) item('nb-ink-menu-save-template', "Save this page's background as a template…", "Save this page's background as a template", () => h.saveTemplate!());
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
    const d = kind === 'pen' ? strokePath({ tool: 'pen', nib, size, points }) : strokePath({ tool: 'highlighter', size, points });
    ctx.fillStyle = color === DEFAULT_PEN.color ? theme.ink : color;
    if (kind === 'highlighter') ctx.globalAlpha = HIGHLIGHT_ALPHA;
    ctx.fill(new Path2D(d));
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

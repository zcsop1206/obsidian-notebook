// The lasso's selection on screen (#11): the overlay canvas that shows the selection's box and
// corner handle, and the selected strokes while they're dragged; the hit test for the box and the
// handle; and the selection menu (recolour, delete, cut, copy, duplicate, paste). The selection
// itself (page and stroke ids) and every edit live in the view (view.ts, "the lasso").
//
// The overlay is a canvas over one page, in page px like the pen's overlays (input.ts), owned
// here. Idle, it shows a dashed box around the selected ink and a filled handle at its
// bottom-right corner. While the selection is dragged, the page bitmap is drawn without the
// selected strokes and the overlay draws them each frame from their cached Path2D outlines
// (strokePath2D) under a canvas transform (the drag's scale and move, and for a move onto
// another page, the offset between the pages; the overlay then sits over that page), so a
// frame costs a clear and one fill per selected stroke, whatever the drag.
//
// The menu is a popover in the view (like the picker), under the box, or above it when there's
// no room below; every element is a button (or .nb-ink-control) so Pencil taps reach it.
import type { Size, Stroke } from '../format/page';
import { COLOR_PRESETS, DEFAULT_PEN } from './pen';
import type { Box, Transform } from './lasso';
import type { SelectionHit } from './input';
import { HIGHLIGHT_ALPHA, pixelRatio, strokeColor, strokePath2D, type Theme } from './renderer';

/** Half the handle's hit area, CSS px (a 22 px square around the corner). */
export const HANDLE_HIT = 11;
/** The handle's drawn radius, CSS px. */
export const HANDLE_R = 6;
/** The box's hit area reaches this far beyond its dashed line, CSS px. */
export const BOX_SLOP = 6;
/** Room kept around the ink inside the dashed box, CSS px. */
export const BOX_PAD = 3;

const ACCENT = 'rgba(40, 110, 230, 0.95)';

/** What a pointer at `p` (page px) grabs of a selection with this box; `css` is page px per CSS px. */
export function hitSelection(box: Box, p: { x: number; y: number }, css: number): SelectionHit {
  const [x0, y0, x1, y1] = padBox(box, css), h = HANDLE_HIT * css, m = BOX_SLOP * css;
  if (Math.abs(p.x - x1) <= h && Math.abs(p.y - y1) <= h) return 'resize';
  if (p.x >= x0 - m && p.x <= x1 + m && p.y >= y0 - m && p.y <= y1 + m) return 'move';
  return null;
}

/** The dashed box drawn around the ink: the bounds with BOX_PAD CSS px of room. */
export function padBox(b: Box, css: number): Box {
  const m = BOX_PAD * css;
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
}

export class SelectionOverlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Page px per CSS px of the page it's on. */
  css = 1;
  private size: Size = { width: 1, height: 1 };
  /** Frames drawn while dragging, for tests. */
  previews = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'nb-ink-selection';
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** Puts the overlay over a page element, sized to it, cleared; drawing is in page px. */
  place(el: HTMLElement, size: Size) {
    const w0 = el.clientWidth || el.getBoundingClientRect().width, h0 = el.clientHeight || el.getBoundingClientRect().height;
    const r = pixelRatio(w0, h0);
    const w = Math.max(1, Math.round(w0 * r)), h = Math.max(1, Math.round(h0 * r));
    const c = this.canvas;
    if (c.parentElement !== el) el.appendChild(c);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.size = size;
    this.css = size.width / Math.max(1, w0);
    this.clear();
  }

  clear() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.pageTransform();
  }

  private pageTransform() {
    this.ctx.setTransform(this.canvas.width / this.size.width, 0, 0, this.canvas.height / this.size.height, 0, 0);
  }

  /** The dashed box around `box` (page px) and its corner handle. */
  drawBox(box: Box) {
    const ctx = this.ctx, css = this.css;
    const [x0, y0, x1, y1] = padBox(box, css);
    ctx.save();
    ctx.lineWidth = css;
    ctx.setLineDash([6 * css, 4 * css]);
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x1, y1, HANDLE_R * css, 0, 2 * Math.PI);
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.lineWidth = 1.5 * css;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.stroke();
    ctx.restore();
  }

  /**
   * One frame of a drag: the strokes (in page px of the page they're on) under `t`, then moved by
   * (ox, oy) onto the page the overlay is over, and the box around them.
   */
  drawDrag(strokes: readonly Stroke[], t: Transform, ox: number, oy: number, box: Box, theme: Theme) {
    this.clear();
    const ctx = this.ctx;
    ctx.save();
    // x' = ox + dx + tx + k (x - tx), as a canvas transform after the page one.
    const e = ox + t.dx + t.ox * (1 - t.k), f = oy + t.dy + t.oy * (1 - t.k);
    ctx.transform(t.k, 0, 0, t.k, e, f);
    ctx.globalAlpha = HIGHLIGHT_ALPHA;
    for (const s of strokes) {
      if (s.tool !== 'highlighter') continue;
      ctx.fillStyle = strokeColor(s, theme);
      ctx.fill(strokePath2D(s));
    }
    ctx.globalAlpha = 1;
    for (const s of strokes) {
      if (s.tool !== 'pen') continue;
      ctx.fillStyle = strokeColor(s, theme);
      ctx.fill(strokePath2D(s));
    }
    ctx.restore();
    const b = box;
    const tb: Box = [e + t.k * b[0], f + t.k * b[1], e + t.k * b[2], f + t.k * b[3]];
    this.drawBox(tb);
    this.previews++;
  }

  destroy() {
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
  }
}

export interface SelectionMenuHost {
  recolor(color: string): void;
  remove(): void;
  cut(): void;
  copy(): void;
  duplicate(): void;
  paste(): void;
  canPaste(): boolean;
  theme(): Theme;
}

/** The selection's menu: a popover in the view near the selection's box. */
export class SelectionMenu {
  readonly el: HTMLElement;
  private paste: HTMLButtonElement;

  constructor(root: HTMLElement, private host: SelectionMenuHost) {
    this.el = root.createDiv({ cls: 'nb-ink-control nb-ink-selmenu', attr: { role: 'menu', 'aria-label': 'Selection' } });
    const colors = this.el.createDiv({ cls: 'nb-ink-control nb-ink-selmenu-row nb-ink-selmenu-colors' });
    for (const { color, name } of COLOR_PRESETS) {
      const b = this.button(colors, 'nb-ink-swatch', '', `Recolour ${name.toLowerCase()}`, () => host.recolor(color));
      b.dataset.color = color;
      if (color === DEFAULT_PEN.color) b.addClass('is-default-ink');
      else b.style.backgroundColor = color;
    }
    const actions = this.el.createDiv({ cls: 'nb-ink-control nb-ink-selmenu-row' });
    this.button(actions, 'nb-ink-sel-duplicate', 'Duplicate', 'Duplicate', () => host.duplicate());
    this.button(actions, 'nb-ink-sel-copy', 'Copy', 'Copy', () => host.copy());
    this.button(actions, 'nb-ink-sel-cut', 'Cut', 'Cut', () => host.cut());
    this.button(actions, 'nb-ink-sel-delete', 'Delete', 'Delete', () => host.remove());
    this.paste = this.button(actions, 'nb-ink-sel-paste', 'Paste', 'Paste', () => host.paste());
    this.el.hide();
  }

  get isOpen(): boolean {
    return this.el.style.display !== 'none';
  }

  /**
   * Shows the menu under the client rect `box` (the selection's box on screen), or above it when
   * there's no room below, kept inside `root` (the view) and below `top` (the toolbar's bottom).
   */
  show(root: HTMLElement, box: DOMRect | { left: number; top: number; right: number; bottom: number }, top: number) {
    this.paste.style.display = this.host.canPaste() ? '' : 'none';
    this.el.show();
    const r = root.getBoundingClientRect(), w = this.el.offsetWidth, h = this.el.offsetHeight, gap = 10;
    let y = box.bottom - r.top + gap;
    if (y + h > r.height - 4) y = box.top - r.top - gap - h;
    y = Math.max(top + 4, Math.min(y, r.height - h - 4));
    const x = Math.max(8, Math.min(box.left - r.left, r.width - w - 8));
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
  }

  hide() {
    this.el.hide();
  }

  destroy() {
    this.el.remove();
  }

  private button(parent: HTMLElement, cls: string, text: string, label: string, fn: () => void): HTMLButtonElement {
    const b = parent.createEl('button', { cls: `nb-ink-control ${cls}`, text, attr: { type: 'button', 'aria-label': label, title: label } });
    b.addEventListener('click', fn);
    return b;
  }
}

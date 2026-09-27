// The on-screen ruler (#20): a layer over one page element holding a canvas (the translucent bar,
// its two edges and tick marks), an invisible rotated bar element that takes finger pointers, the
// angle label (tap it to type an angle), the angle input and the length label shown while a
// ruled stroke is drawn. The geometry is ruler.ts; the view owns the state and places the layer.
//
// Everything is placed in page px as percentages of the page element, so the layer follows
// scrolling and zoom without work; only the canvas is redrawn at a new resolution when the page
// is resized (place()).
//
// Fingers: the bar element has `touch-action: none` and takes touch pointers only. A finger going
// down on it is claimed: the event's propagation is stopped, so navigate.ts (on the scroller)
// never sees it and doesn't pan, and gestures.ts (on the pages layer) never counts it as a tap.
// While the ruler holds a finger, a second touch pointer going down anywhere in the window is
// claimed too (window, capture phase), so one finger on the ruler and one beside it rotate it
// rather than pan the view. One finger moves the ruler; two turn it around their centroid (and
// move it), with the angle snapped (ruler.ts). The moves and ups of claimed fingers are followed
// on the window until they lift, like the pen's gestures. The Pencil and the mouse are never
// handled here: their events pass through the bar to the page, so the Pencil draws over the
// ruler. The angle label takes every pointer (a Pencil tap on it opens the input too).
import type { Size } from '../format/page';
import {
  edges, fmtAngle, formatLength, halfLength, moveRuler, normAngle, parseAngle, RULER_WIDTH, rotateRuler, tickStep,
  type LengthUnit, type RulerState,
} from './ruler';
import { pixelRatio } from './renderer';

export interface RulerOverlayHost {
  /** The ruler's state. */
  ruler(): RulerState | null;
  /** The ruler was moved or turned by fingers, or its angle typed. */
  setRuler(r: RulerState): void;
  unit(): LengthUnit;
  dark(): boolean;
}

type Pt = { x: number; y: number };

export class RulerOverlay {
  readonly layer: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly bar: HTMLElement;
  readonly label: HTMLButtonElement;
  readonly length: HTMLElement;
  private input: HTMLInputElement | null = null;
  private ctx: CanvasRenderingContext2D;
  private el: HTMLElement | null = null;
  private size: Size = { width: 1, height: 1 };
  /** Claimed fingers: client position now, and page px where the current gesture step started. */
  private fingers = new Map<number, Pt>();
  /** The gesture's base: the ruler and the fingers' page points when it (re)started. */
  private base: { r: RulerState; pts: Map<number, Pt> } | null = null;
  private win: Window | null = null;
  /** Times the canvas was drawn, and finger gestures handled (for tests). */
  draws = 0;
  gestures = 0;

  constructor(private host: RulerOverlayHost) {
    const doc = document;
    this.layer = doc.createElement('div');
    this.layer.className = 'nb-ink-ruler-layer';
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'nb-ink-ruler-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.bar = doc.createElement('div');
    this.bar.className = 'nb-ink-ruler-bar';
    this.label = doc.createElement('button');
    this.label.type = 'button';
    this.label.className = 'nb-ink-control nb-ink-ruler-angle';
    this.label.setAttribute('aria-label', 'Ruler angle (tap to type)');
    this.length = doc.createElement('div');
    this.length.className = 'nb-ink-ruler-length';
    this.length.style.display = 'none';
    this.layer.append(this.canvas, this.bar, this.label, this.length);
    this.bar.addEventListener('pointerdown', e => this.down(e));
    // The label is a control: nothing under it pans, draws or moves the ruler.
    for (const t of ['pointerdown', 'pointermove', 'pointerup'] as const) this.label.addEventListener(t, e => e.stopPropagation());
    this.label.addEventListener('click', () => this.openInput());
  }

  /** Whether the layer is over a page. */
  get shown(): boolean {
    return !!this.layer.parentElement;
  }

  /** Puts the layer over a page element (page size `size`) and draws it; redraws the canvas only if its resolution changed or `force`. */
  place(el: HTMLElement, size: Size, force = false) {
    const moved = this.el !== el || this.layer.parentElement !== el;
    if (moved) el.appendChild(this.layer);
    this.el = el;
    const sized = this.size.width !== size.width || this.size.height !== size.height;
    this.size = size;
    const w0 = el.clientWidth || el.getBoundingClientRect().width, h0 = el.clientHeight || el.getBoundingClientRect().height;
    const k = pixelRatio(w0, h0);
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = this.canvas;
    const resized = c.width !== w || c.height !== h;
    if (resized) {
      c.width = w;
      c.height = h;
    }
    if (moved || sized || resized || force) this.render();
  }

  /** Takes the layer off its page and ends any finger gesture. */
  hide() {
    this.endGesture();
    this.closeInput();
    this.layer.remove();
    this.el = null;
  }

  /** Positions the bar and label and redraws the canvas from the host's state. */
  render() {
    const r = this.host.ruler();
    if (!r || !this.el) return;
    const { width, height } = this.size, L = halfLength(this.size);
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    const b = this.bar.style;
    b.left = pct(r.cx, width);
    b.top = pct(r.cy, height);
    b.width = pct(2 * L, width);
    b.height = pct(RULER_WIDTH, height);
    b.transform = `translate(-50%, -50%) rotate(${-r.angle}deg)`;
    this.label.style.left = pct(r.cx, width);
    this.label.style.top = pct(r.cy, height);
    this.label.textContent = `${fmtAngle(r.angle)}°`;
    this.draw(r);
  }

  private draw(r: RulerState) {
    const c = this.canvas, ctx = this.ctx, { width, height } = this.size;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(c.width / width, 0, 0, c.height / height, 0, 0);
    const css = width / Math.max(1, this.el?.clientWidth || width); // page px per CSS px
    const dark = this.host.dark();
    const L = halfLength(this.size);
    const [e1, e2] = edges(r);
    const d = { x: e1.dx, y: e1.dy };
    // The bar.
    ctx.beginPath();
    ctx.moveTo(e1.x - d.x * L, e1.y - d.y * L);
    ctx.lineTo(e1.x + d.x * L, e1.y + d.y * L);
    ctx.lineTo(e2.x + d.x * L, e2.y + d.y * L);
    ctx.lineTo(e2.x - d.x * L, e2.y - d.y * L);
    ctx.closePath();
    ctx.fillStyle = dark ? 'rgba(170, 190, 225, 0.16)' : 'rgba(90, 120, 170, 0.14)';
    ctx.fill();
    // The edges.
    ctx.lineWidth = 1.5 * css;
    ctx.strokeStyle = dark ? 'rgba(150, 190, 255, 0.95)' : 'rgba(30, 90, 200, 0.9)';
    ctx.beginPath();
    for (const e of [e1, e2]) {
      ctx.moveTo(e.x - d.x * L, e.y - d.y * L);
      ctx.lineTo(e.x + d.x * L, e.y + d.y * L);
    }
    ctx.stroke();
    // Ticks along both edges, from the centre out: every 5 mm (long at 1 cm) or ¼ in (long at 1 in).
    const { step, major } = tickStep(this.host.unit());
    const n = Math.floor(L / step);
    const inX = -(e1.x - r.cx) / (RULER_WIDTH / 2), inY = -(e1.y - r.cy) / (RULER_WIDTH / 2); // e1 → inside
    ctx.lineWidth = 1 * css;
    ctx.strokeStyle = dark ? 'rgba(200, 215, 240, 0.8)' : 'rgba(40, 60, 100, 0.75)';
    ctx.beginPath();
    for (let i = -n; i <= n; i++) {
      const len = i % major === 0 ? 14 : 7;
      for (const [e, s] of [[e1, 1], [e2, -1]] as const) {
        const x = e.x + d.x * i * step, y = e.y + d.y * i * step;
        if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;
        ctx.moveTo(x, y);
        ctx.lineTo(x + inX * s * len, y + inY * s * len);
      }
    }
    ctx.stroke();
    this.draws++;
  }

  /** Shows the length label at page point `at` with `px` (page px) in the host's unit; null hides it. */
  showLength(at: Pt | null, px = 0) {
    const s = this.length.style;
    if (!at || !this.el) {
      s.display = 'none';
      return;
    }
    s.display = '';
    s.left = `${(at.x / this.size.width) * 100}%`;
    s.top = `${(at.y / this.size.height) * 100}%`;
    this.length.textContent = formatLength(px, this.host.unit());
  }

  // ---- the angle input

  get inputOpen(): boolean {
    return !!this.input;
  }

  /** Opens a small input over the label to type an exact angle; Enter or leaving it applies, Escape cancels. */
  openInput() {
    const r = this.host.ruler();
    if (!r || this.input) return;
    const input = this.input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'nb-ink-control nb-ink-ruler-input';
    input.setAttribute('aria-label', 'Ruler angle in degrees (0–360)');
    input.value = fmtAngle(r.angle);
    input.style.left = this.label.style.left;
    input.style.top = this.label.style.top;
    for (const t of ['pointerdown', 'pointermove', 'pointerup'] as const) input.addEventListener(t, e => e.stopPropagation());
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      if (apply) this.applyAngle(input.value);
      this.closeInput();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    this.layer.appendChild(input);
    this.label.style.visibility = 'hidden';
    input.focus();
    input.select();
  }

  /** Sets the ruler's angle from typed text; returns whether it was a valid angle. */
  applyAngle(text: string): boolean {
    const a = parseAngle(text), r = this.host.ruler();
    if (a === null || !r) return false;
    this.host.setRuler({ ...r, angle: a });
    return true;
  }

  private closeInput() {
    const input = this.input;
    if (!input) return;
    this.input = null;
    input.remove();
    this.label.style.visibility = '';
  }

  // ---- fingers

  private toPage(x: number, y: number): Pt {
    const el = this.el!, rect = el.getBoundingClientRect();
    return { x: (x - rect.left) * this.size.width / rect.width, y: (y - rect.top) * this.size.height / rect.height };
  }

  private down(e: PointerEvent) {
    if (e.pointerType !== 'touch' || !this.el) return; // the Pencil and the mouse draw through the bar
    this.claim(e);
  }

  /** Takes a finger: it moves or turns the ruler until it lifts. */
  private claim(e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (this.fingers.size >= 2 || this.fingers.has(e.pointerId)) return;
    if (!this.fingers.size) {
      this.gestures++;
      this.track();
    }
    this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.rebase();
  }

  /** The gesture starts again from here (a finger came or went). */
  private rebase() {
    const r = this.host.ruler();
    if (!r) return;
    const pts = new Map<number, Pt>();
    for (const [id, f] of this.fingers) pts.set(id, this.toPage(f.x, f.y));
    this.base = { r: { ...r }, pts };
  }

  private onWinDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !this.fingers.size || this.fingers.has(e.pointerId)) return;
    if (this.fingers.size >= 2) return;
    this.claim(e);
  };

  private onMove = (e: PointerEvent) => {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    e.stopPropagation();
    e.preventDefault();
    f.x = e.clientX;
    f.y = e.clientY;
    const base = this.base;
    if (!base || !this.el) return;
    const ids = [...this.fingers.keys()];
    if (ids.length === 1) {
      const from = base.pts.get(ids[0])!, to = this.toPage(f.x, f.y);
      this.host.setRuler(moveRuler(base.r, from, to));
    } else {
      const a: [Pt, Pt] = [base.pts.get(ids[0])!, base.pts.get(ids[1])!];
      const f0 = this.fingers.get(ids[0])!, f1 = this.fingers.get(ids[1])!;
      this.host.setRuler(rotateRuler(base.r, a, [this.toPage(f0.x, f0.y), this.toPage(f1.x, f1.y)]));
    }
  };

  private onUp = (e: PointerEvent) => {
    if (!this.fingers.delete(e.pointerId)) return;
    e.stopPropagation();
    if (this.fingers.size) this.rebase();
    else this.endGesture();
  };

  private track() {
    const win = this.win = this.el?.ownerDocument.defaultView ?? window;
    win.addEventListener('pointerdown', this.onWinDown, true);
    win.addEventListener('pointermove', this.onMove, true);
    win.addEventListener('pointerup', this.onUp, true);
    win.addEventListener('pointercancel', this.onUp, true);
  }

  private endGesture() {
    this.fingers.clear();
    this.base = null;
    const win = this.win;
    if (!win) return;
    this.win = null;
    win.removeEventListener('pointerdown', this.onWinDown, true);
    win.removeEventListener('pointermove', this.onMove, true);
    win.removeEventListener('pointerup', this.onUp, true);
    win.removeEventListener('pointercancel', this.onUp, true);
  }

  /** Whether fingers are on the ruler. */
  get holding(): number {
    return this.fingers.size;
  }

  destroy() {
    this.hide();
    this.canvas.width = this.canvas.height = 0;
  }
}

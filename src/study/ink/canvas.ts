/**
 * The drawing and pen input under page ink and block surfaces: one canvas, Pointer Events.
 *
 * Input (SPEC.md, Input rules): the pen and the mouse (button 0) draw; touches never do (fingers
 * scroll, tap and peek). A stroke starts on pointerdown on the input element and from then follows
 * that pointer on the window (capture phase), so it continues past the canvas's edge, as the
 * notebook's pen does (#35). Every coalesced sample is taken, in paper px, rounded as the file
 * stores it; samples older than the last one are dropped (WebKit repeats them) and so are those
 * within 0.25 px of the last point. Stylus `touchstart`/`touchmove` are prevented over the input
 * element, so the Pencil never scrolls the page; finger touches are left alone. After a pen stroke
 * on the page the click that follows is swallowed, so the Pencil never follows a link it wrote over.
 *
 * Look: the notebook's uniform pen (src/format/outline.ts): the refit centreline stroked LINE_WIDTH
 * wide with round caps and joins. The stroke in progress is drawn as it comes (quadratics through
 * the midpoints of its samples) and replaced by the refit path when the pen lifts.
 *
 * Resolution: device pixels at devicePixelRatio and any CSS scale above, capped at 16 M pixels
 * like the notebook's bitmaps. A tall page draws only a band around the visible part (pageBand),
 * moved when scrolling leaves it.
 */
import { centreline, refit, refitStep } from '../../format/outline';
import type { InkStroke } from '../view/host';
import { LINE_WIDTH, addSamples, canvasScale, colorToken, pageBand, pathLength, type InkPoint, type Placement } from './model';

export interface InkCanvasOptions {
  /** Paper width in px. */
  width: number;
  /** Paper height in px, read on layout. */
  height: () => number;
  /**
   * Overlay: the canvas lies over `host`, which is already in paper px (the page stack; any CSS
   * scale is on an ancestor or on host itself) and draws a band of it. Otherwise a box is
   * appended to `host` and the paper is fitted to the box's width.
   */
  overlay: boolean;
  host: HTMLElement;
  /** Class of the fitted box (not overlay). */
  className?: string;
  strokes: () => readonly InkStroke[];
  /** Per stroke offset and opacity; null hides it. Default: as written. */
  place?: (s: InkStroke) => Placement | null;
  color: (s: InkStroke) => string;
  readOnly: () => boolean;
  /** true: this pointerdown (or stylus touch) is not ink (a control, a block's own canvas). */
  ignore?: (e: Event) => boolean;
  /** Fields merged into a new stroke at pen-down. */
  meta?: () => Partial<InkStroke> | null | undefined;
  /** A finished stroke (points in paper px); the owner stores it. */
  commit: (s: InkStroke) => void;
  /** Swallow the click after a pen stroke (page ink: the Pencil never follows a link it wrote over). */
  swallowClick?: boolean;
}

const MAX_PIXELS = 16_000_000;
const DEFAULT_COLOR = '--text-normal';

/** Cached Path2D per points array (the union copies strokes but shares their points). */
const paths = new WeakMap<object, { path: Path2D | null; dot: [number, number] | null }>();

function pathOf(p: readonly (readonly number[])[]): { path: Path2D | null; dot: [number, number] | null } {
  let c = paths.get(p);
  if (c) return c;
  const pts = p.map(q => ({ x: q[0], y: q[1], p: q[2] ?? 0.5, t: q[3] ?? 0 }));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  // A dot: drawn as a filled circle, since WebKit may not draw a zero-length round-capped line.
  if (maxX - minX < 0.05 && maxY - minY < 0.05) c = { path: null, dot: [pts[0].x, pts[0].y] };
  else {
    const d = centreline(refit(pts, refitStep({ tool: 'pen', nib: 'uniform', size: LINE_WIDTH })));
    let path: Path2D | null = null;
    try { path = new Path2D(d); } catch { path = null; }
    c = { path, dot: null };
  }
  paths.set(p, c);
  return c;
}

/** Quadratics through the midpoints, as the live stroke is drawn (and the fallback without Path2D). */
function drawRaw(g: CanvasRenderingContext2D, p: readonly (readonly number[])[], dy: number): void {
  const n = p.length;
  if (!n) return;
  g.beginPath();
  if (n === 1) { g.arc(p[0][0], p[0][1] + dy, LINE_WIDTH / 2, 0, Math.PI * 2); g.fill(); return; }
  g.moveTo(p[0][0], p[0][1] + dy);
  if (n === 2) g.lineTo(p[1][0], p[1][1] + dy);
  else {
    g.lineTo((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2 + dy);
    for (let i = 1; i < n - 1; i++) g.quadraticCurveTo(p[i][0], p[i][1] + dy, (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2 + dy);
    g.lineTo(p[n - 1][0], p[n - 1][1] + dy);
  }
  g.stroke();
}

interface Live {
  stroke: InkStroke;
  pid: number;
  type: string;
  ts0: number;
  last: number;
  drawn: number;
  map: { left: number; top: number; k: number };
}

export class InkCanvas {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private W: number;
  private H = 1;
  /** Device px per paper px. */
  private k = 1;
  /** The band (paper px) the canvas covers. */
  private bandTop = 0;
  private bandH = 1;
  private live: Live | null = null;
  private raf = 0;
  /** The live stroke's own frame, so a layout asked for mid-stroke is never dropped. */
  private liveRaf = 0;
  private scrollRaf = 0;
  private destroyed = false;
  private ro: ResizeObserver | null = null;
  private roOverride: boolean | null = null;
  private lastPenUp = -Infinity;
  private cleanups: (() => void)[] = [];

  constructor(private o: InkCanvasOptions) {
    this.W = o.width;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'nb-study-ink-canvas';
    if (o.overlay) {
      this.el = o.host;
      this.canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2;';
      o.host.appendChild(this.canvas);
    } else {
      this.el = document.createElement('div');
      this.el.className = 'nb-study-ink' + (o.className ? ' ' + o.className : '');
      this.el.style.cssText = 'position:relative;width:100%;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;';
      this.canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
      this.el.appendChild(this.canvas);
      o.host.appendChild(this.el);
    }
    this.g = this.canvas.getContext('2d');
    this.listen();
    if (!o.overlay && typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.schedule());
      this.ro.observe(this.el);
    }
    this.layout();
  }

  private on<E extends Event>(t: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions | boolean): void {
    const h = fn as unknown as EventListener;
    t.addEventListener(type, h, opts);
    this.cleanups.push(() => t.removeEventListener(type, h, opts));
  }

  private listen(): void {
    const surf = this.el;
    this.on(surf, 'pointerdown', (e: PointerEvent) => this.down(e));
    const stylus = (e: TouchEvent) => {
      if (this.isRO() || (this.o.ignore && this.o.ignore(e))) return;
      const lists = [e.changedTouches, e.touches];
      for (const tl of lists) {
        if (!tl) continue;
        for (let i = 0; i < tl.length; i++) {
          if ((tl[i] as Touch & { touchType?: string }).touchType === 'stylus') { if (e.cancelable) e.preventDefault(); return; }
        }
      }
    };
    this.on(surf, 'touchstart', stylus, { passive: false });
    this.on(surf, 'touchmove', stylus, { passive: false });
    if (this.o.swallowClick) {
      this.on(surf, 'click', (e: MouseEvent) => {
        if (performance.now() - this.lastPenUp < 500) { e.preventDefault(); e.stopPropagation(); this.lastPenUp = -Infinity; }
      }, true);
    }
    if (this.o.overlay) {
      // Re-band when scrolling leaves the band (any scroller: the capture phase sees them all).
      this.on(document, 'scroll', () => {
        if (this.scrollRaf) return;
        this.scrollRaf = requestAnimationFrame(() => { this.scrollRaf = 0; if (!this.live && this.bandStale()) this.layout(); });
      }, { capture: true, passive: true });
      this.on(window, 'resize', () => this.schedule());
    }
  }

  private isRO(): boolean {
    return this.roOverride ?? this.o.readOnly();
  }

  setReadOnly(on: boolean | null): void {
    this.roOverride = on;
    if (!this.o.overlay) this.el.classList.toggle('is-readonly', this.isRO());
  }

  isDrawing(): boolean { return !!this.live; }

  /* ------------------------------- layout ------------------------------- */

  private schedule(): void {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.layout(); });
  }

  /** CSS px per paper px on screen (ancestor transforms included) and the host's client rect. */
  private screen(): { s: number; rect: DOMRect } {
    const rect = this.el.getBoundingClientRect();
    const local = this.o.overlay ? this.W : this.el.clientWidth;
    return { s: local > 0 && rect.width > 0 ? rect.width / this.W : 0, rect };
  }

  private visible(rect: DOMRect, s: number): [number, number] {
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    return [(0 - rect.top) / s, (vh - rect.top) / s];
  }

  private bandStale(): boolean {
    if (!this.o.overlay || (this.bandTop === 0 && this.bandH >= this.H)) return false;
    const { s, rect } = this.screen();
    if (!(s > 0)) return false;
    const [vt, vb] = this.visible(rect, s);
    return Math.max(0, vt) < this.bandTop || Math.min(this.H, vb) > this.bandTop + this.bandH;
  }

  layout(): void {
    if (this.destroyed) return;
    this.H = Math.max(1, this.o.height());
    const dpr = window.devicePixelRatio || 1;
    if (this.o.overlay) {
      const { s, rect } = this.screen();
      const k = (s > 0 ? s : 1) * dpr;
      let band = { top: 0, height: this.H, k: canvasScale(k, this.W, this.H, MAX_PIXELS) };
      if (s > 0 && this.W * this.H * k * k > MAX_PIXELS) {
        const [vt, vb] = this.visible(rect, s);
        band = pageBand(this.H, vt, vb, this.W, k, MAX_PIXELS);
      }
      this.bandTop = band.top; this.bandH = band.height; this.k = band.k;
      this.canvas.style.top = band.top + 'px';
      this.canvas.style.width = this.W + 'px';
      this.canvas.style.height = band.height + 'px';
    } else {
      const cssW = this.el.clientWidth;
      if (cssW > 0) this.el.style.height = (this.H * cssW / this.W) + 'px';
      const { s } = this.screen();
      this.bandTop = 0; this.bandH = this.H;
      this.k = canvasScale((s > 0 ? s : 1) * dpr, this.W, this.H, MAX_PIXELS);
    }
    const cw = Math.max(1, Math.round(this.W * this.k)), ch = Math.max(1, Math.round(this.bandH * this.k));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.redraw();
  }

  /** Paper height now. */
  height(): number { return this.H; }

  /* ------------------------------- drawing ------------------------------- */

  private resolve(c: string | undefined): string {
    const v = c && c.trim() ? c : DEFAULT_COLOR;
    const t = colorToken(v);
    if (!t) return v;
    const got = getComputedStyle(this.o.overlay ? this.o.host : this.el).getPropertyValue(t.token).trim();
    return got || t.fallback || (t.token === DEFAULT_COLOR ? '#222' : '#888');
  }

  private style(s: InkStroke, alpha: number): void {
    const g = this.g!;
    const c = this.resolve(this.o.color(s));
    g.globalAlpha = alpha;
    g.strokeStyle = c; g.fillStyle = c;
    g.lineWidth = LINE_WIDTH; g.lineCap = 'round'; g.lineJoin = 'round';
  }

  private base(): void {
    const g = this.g!;
    g.setTransform(this.k, 0, 0, this.k, 0, -this.bandTop * this.k);
  }

  redraw(): void {
    const g = this.g;
    if (!g || this.destroyed) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.base();
    const top = this.bandTop - 4, bottom = this.bandTop + this.bandH + 4;
    for (const s of this.o.strokes()) {
      if (!s.p || !s.p.length) continue;
      const pl = this.o.place ? this.o.place(s) : { dy: 0, alpha: 1 };
      if (!pl) continue;
      const y0 = s.p[0][1] + pl.dy;
      // Cheap cull: skip strokes whose first point is far outside the band (strokes are short).
      if (this.o.overlay && (y0 < top - 2000 || y0 > bottom + 2000)) continue;
      this.style(s, pl.alpha);
      const c = pathOf(s.p);
      if (c.dot) { g.beginPath(); g.arc(c.dot[0], c.dot[1] + pl.dy, LINE_WIDTH / 2, 0, Math.PI * 2); g.fill(); continue; }
      if (c.path) {
        if (pl.dy) { g.save(); g.translate(0, pl.dy); g.stroke(c.path); g.restore(); }
        else g.stroke(c.path);
      } else drawRaw(g, s.p, pl.dy);
    }
    if (this.live) { this.live.drawn = 0; this.drawLive(); }
    g.globalAlpha = 1;
  }

  /** Draws the live stroke's segments not yet drawn. */
  private drawLive(): void {
    const L = this.live, g = this.g;
    if (!L || !g) return;
    const p = L.stroke.p, n = p.length;
    if (!n || L.drawn >= n) return;
    this.base();
    this.style(L.stroke, 1);
    if (L.drawn === 0) {
      if (n === 1) { g.beginPath(); g.arc(p[0][0], p[0][1], LINE_WIDTH / 2, 0, Math.PI * 2); g.fill(); L.drawn = 1; return; }
      drawRaw(g, p.slice(0, n - 1), 0);
      L.drawn = n - 1;
    }
    // Segments from the previous midpoint through each new sample's midpoint.
    g.beginPath();
    for (let i = Math.max(1, L.drawn); i < n; i++) {
      const a = p[i - 2] ?? p[i - 1], b = p[i - 1], c = p[i];
      if (i === 1) { g.moveTo(b[0], b[1]); g.lineTo((b[0] + c[0]) / 2, (b[1] + c[1]) / 2); continue; }
      g.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      g.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
    }
    g.stroke();
    L.drawn = n;
  }

  /* ------------------------------- input ------------------------------- */

  private paperMap(): { left: number; top: number; k: number } {
    const r = this.o.overlay ? this.o.host.getBoundingClientRect() : this.el.getBoundingClientRect();
    return { left: r.left, top: r.top, k: this.W / (r.width || 1) };
  }

  private down(e: PointerEvent): void {
    if (this.destroyed || this.live) return;
    // Any new press (a finger's tap, a mouse click, a pen on a control) clicks normally.
    this.lastPenUp = -Infinity;
    if (e.pointerType === 'touch') return; // fingers scroll, tap and peek
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.isRO()) return;
    if (this.o.ignore && this.o.ignore(e)) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not capturable: the window listeners still follow it */ }
    const stroke: InkStroke = { id: '', p: [], t0: Date.now() };
    if (this.o.meta) {
      let m: Partial<InkStroke> | null | undefined = null;
      try { m = this.o.meta(); } catch (er) { console.error('[study] ink meta failed', er); }
      if (m) for (const [k, v] of Object.entries(m)) if (k !== 'p') (stroke as unknown as Record<string, unknown>)[k] = v;
    }
    this.live = { stroke, pid: e.pointerId, type: e.pointerType || 'pen', ts0: e.timeStamp, last: -Infinity, drawn: 0, map: this.paperMap() };
    this.take([e]);
    const move = (ev: PointerEvent) => {
      if (!this.live || ev.pointerId !== this.live.pid) return;
      ev.preventDefault();
      const list = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
      this.take(list && list.length ? list : [ev]);
    };
    const up = (ev: PointerEvent) => {
      if (!this.live || ev.pointerId !== this.live.pid) return;
      if (ev.type === 'pointerup') this.take([ev]);
      end();
      this.finish();
    };
    const touch = (ev: TouchEvent) => {
      if (!this.live) return;
      const tl = ev.touches;
      for (let i = 0; i < (tl ? tl.length : 0); i++) if ((tl[i] as Touch & { touchType?: string }).touchType === 'stylus') { if (ev.cancelable) ev.preventDefault(); return; }
    };
    const end = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('touchmove', touch, true);
      this.endGesture = null;
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('touchmove', touch, { capture: true, passive: false });
    this.endGesture = end;
  }

  private endGesture: (() => void) | null = null;

  private take(samples: readonly PointerEvent[]): void {
    const L = this.live;
    if (!L) return;
    L.last = addSamples(L.stroke.p as InkPoint[], L.last, samples, { ...L.map, t0: L.ts0, mouse: L.type === 'mouse' });
    if (!this.liveRaf) this.liveRaf = requestAnimationFrame(() => { this.liveRaf = 0; if (this.live) this.drawLive(); });
  }

  private finish(): void {
    const L = this.live;
    this.live = null;
    if (!L) return;
    const p = L.stroke.p;
    if (!p.length || (L.type === 'mouse' && pathLength(p) < 2)) { this.redraw(); return; } // a click, not a stroke
    this.lastPenUp = performance.now();
    try { this.o.commit(L.stroke); } catch (e) { console.error('[study] ink commit failed', e); }
    this.redraw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.endGesture) this.endGesture();
    for (const c of this.cleanups) c();
    this.cleanups = [];
    if (this.ro) this.ro.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.liveRaf) cancelAnimationFrame(this.liveRaf);
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    this.canvas.remove();
    if (!this.o.overlay) this.el.remove();
  }
}

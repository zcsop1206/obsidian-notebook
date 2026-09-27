// PROVISIONAL PEN (#4). Just enough input to write, close and reopen a note: pen and mouse
// draw, fingers never do (palm rejection; they scroll). The stroke in progress is drawn as a
// plain polyline on one low-latency overlay canvas over the page being written; on release it
// becomes a Stroke with fixed settings and the view draws it into the page bitmap.
// #5 replaces the live rendering (perfect-freehand, predicted points) and adds presets.
import { DEFAULT_INK, type PenStroke, type Point, type Size } from '../format/page';
import { pixelRatio } from './renderer';

/** The provisional pen's stroke settings. */
export const PEN: Readonly<Pick<PenStroke, 'tool' | 'nib' | 'color' | 'size'>> =
  Object.freeze({ tool: 'pen', nib: 'uniform', color: DEFAULT_INK, size: 2 });

/** Samples closer than this (page px) to the previous one are dropped. */
const MIN_STEP = 0.25;

export interface PageTarget {
  /** Identifies the page to the host. */
  key: unknown;
  el: HTMLElement;
  size: Size;
}

export interface PenHost {
  /** The writable page an event landed on, or null. */
  pageAt(target: EventTarget | null): PageTarget | null;
  /** The colour to draw the stroke in progress (the theme's ink). */
  liveColor(): string;
  /** A finished stroke's points, in page px. */
  commit(target: PageTarget, points: Point[]): void;
}

interface Live {
  pointerId: number;
  target: PageTarget;
  rect: DOMRect;
  t0: number;
  points: Point[];
}

type Listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => void;

export class PenInput {
  readonly overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private live: Live | null = null;
  private coalesced: boolean | null = null;

  /** `listen` adds a listener on the element holding the pages (removed with the view). */
  constructor(private host: PenHost, listen: Listen) {
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'nb-ink-live';
    const opts = { desynchronized: true } as CanvasRenderingContext2DSettings;
    this.ctx = (this.overlay.getContext('2d', opts) || this.overlay.getContext('2d'))!;

    listen('pointerdown', e => this.down(e));
    listen('pointermove', e => this.move(e));
    listen('pointerup', e => this.up(e));
    listen('pointercancel', e => this.up(e));
    // A Pencil drag would otherwise scroll the view or open Obsidian's sidebars. Only stylus
    // touches on a page are stopped: fingers keep native scrolling, and the Pencil can still
    // tap buttons outside pages.
    const stopStylus = (e: TouchEvent) => {
      const stylus = Array.from(e.changedTouches).some(t => (t as Touch & { touchType?: string }).touchType === 'stylus');
      if (stylus && this.host.pageAt(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    listen('touchstart', stopStylus, { passive: false });
    listen('touchmove', stopStylus, { passive: false });
  }

  get drawing(): boolean {
    return this.live !== null;
  }

  private down(e: PointerEvent) {
    if (e.pointerType === 'touch' || this.live) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = this.host.pageAt(e.target);
    if (!target) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch (err) {
      // synthetic events have no active pointer to capture
    }
    const rect = target.el.getBoundingClientRect();
    this.place(target, rect);
    this.live = { pointerId: e.pointerId, target, rect, t0: e.timeStamp, points: [] };
    this.coalesced ??= typeof e.getCoalescedEvents === 'function';
    this.sample(e);
    this.draw(0);
  }

  private move(e: PointerEvent) {
    const live = this.live;
    if (!live || e.pointerId !== live.pointerId) return;
    e.preventDefault();
    const from = live.points.length;
    const list = this.coalesced ? e.getCoalescedEvents() : [];
    for (const ce of list.length ? list : [e]) this.sample(ce);
    this.draw(from);
  }

  private up(e: PointerEvent) {
    const live = this.live;
    if (!live || e.pointerId !== live.pointerId) return;
    this.live = null;
    // A cancelled stroke (the system took the pointer) is kept, like a finished one.
    if (live.points.length) this.host.commit(live.target, live.points);
    this.clear();
  }

  private sample(e: PointerEvent) {
    const live = this.live!;
    const { rect, target } = live;
    const x = (e.clientX - rect.left) * target.size.width / rect.width;
    const y = (e.clientY - rect.top) * target.size.height / rect.height;
    const prev = live.points[live.points.length - 1];
    if (prev && Math.hypot(x - prev.x, y - prev.y) < MIN_STEP) return;
    const p = e.pointerType === 'mouse' ? 0.5 : Math.min(1, Math.max(0, e.pressure || 0));
    live.points.push({ x, y, p, t: Math.max(0, e.timeStamp - live.t0) });
  }

  /** Puts the overlay over the page and sizes it; drawing is in page px. */
  private place(target: PageTarget, rect: DOMRect) {
    const c = this.overlay;
    if (c.parentElement !== target.el) target.el.appendChild(c);
    const r = pixelRatio(rect.width, rect.height);
    const w = Math.max(1, Math.round(rect.width * r)), h = Math.max(1, Math.round(rect.height * r));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.setTransform(w / target.size.width, 0, 0, h / target.size.height, 0, 0);
  }

  /** Draws the stroke in progress from point `from` on. */
  private draw(from: number) {
    const live = this.live!;
    const pts = live.points, ctx = this.ctx;
    if (!pts.length) return;
    ctx.strokeStyle = ctx.fillStyle = this.host.liveColor();
    ctx.lineWidth = PEN.size;
    ctx.lineCap = ctx.lineJoin = 'round';
    if (from === 0) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, PEN.size / 2, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (pts.length < 2 || from >= pts.length) return;
    ctx.beginPath();
    const start = Math.max(1, from);
    ctx.moveTo(pts[start - 1].x, pts[start - 1].y);
    for (let i = start; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  private clear() {
    const c = this.overlay;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, c.width, c.height);
    this.ctx.restore();
  }

  /** Abandons a stroke in progress (the page it was on went away). */
  cancel() {
    this.live = null;
    this.clear();
  }

  destroy() {
    this.cancel();
    this.overlay.width = this.overlay.height = 0;
    this.overlay.remove();
  }
}

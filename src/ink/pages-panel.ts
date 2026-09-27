// The Pages panel (#17): a narrow column of page thumbnails beside the pages of the ink view.
// A tap on a thumbnail scrolls to its page; the current page's thumbnail is highlighted and has
// small buttons to insert a page after it, duplicate it or delete it; a long press (or, with a
// mouse, a drag) picks a thumbnail up and dragging it reorders the pages. Fingers scroll the
// panel natively until a thumbnail is picked up.
//
// Thumbnails must not slow the editor: they are drawn only while the panel is open, only when
// in view (IntersectionObserver), at most THUMBS_PER_FRAME per frame, copied from the page's
// bitmap when the view has a finished one, otherwise drawn small through PageBitmap with the
// outlines warmed a few ms per frame. A page's thumbnail is redrawn THUMB_DELAY ms after it
// last changed. The panel knows nothing of the store: the view hands it a PagesHost.
import type { Page, Size } from '../format/page';
import type { Template } from '../format/template';
import { PageBitmap, warmOutlines, type Theme } from './renderer';

/** Thumbnail width in CSS px. */
export const THUMB_WIDTH = 120;
/** Wait after a page changes before redrawing its thumbnail, in ms. */
export const THUMB_DELAY = 500;
/** Thumbnails drawn per animation frame, at most. */
export const THUMBS_PER_FRAME = 2;
/** Time per frame for thumbnail work (outlines and drawing), in ms. */
const THUMB_BUDGET = 6;
/** How long a finger or the Pencil must rest on a thumbnail to pick it up, in ms. */
export const LIFT_MS = 350;
/** Movement that makes a press a scroll (or, with a mouse, a drag), in CSS px. */
const SLOP = 8;

/** A page as the panel sees it. */
export interface PanelPage {
  id: string;
  size: Size;
}

export interface PagesHost {
  /** The note's pages in order. */
  pages(): readonly PanelPage[];
  /** The page's model (parsed on demand), or null if it can't be read. */
  page(id: string): Page | null;
  /** The page's finished bitmap in the view, if it has one. */
  bitmap(id: string): HTMLCanvasElement | null;
  theme(): Theme;
  /** The template rasterised at this pixel size, or null (onReady is called when it loads). */
  template(template: Template, size: Size, width: number, height: number, onReady: () => void): HTMLImageElement | null;
  /** The index of the current page. */
  current(): number;
  go(index: number): void;
  insertAfter(index: number): void;
  duplicate(index: number): void;
  remove(index: number): void;
  /** Moves page `from` to position `to` of the pages without it. */
  move(from: number, to: number): void;
}

interface Thumb {
  id: string;
  el: HTMLElement;
  frame: HTMLElement;
  num: HTMLElement;
  bitmap: PageBitmap | null;
  /** Needs drawing (never drawn, or changed since). */
  stale: boolean;
  visible: boolean;
  /** Debounce timer after a change. */
  timer: number;
  /** While a thumbnail is drawn over several frames: the next pen stroke to draw. */
  pending: number | null;
}

/** Counters for tests. */
export interface PanelStats {
  /** Thumbnails drawn, in total. */
  drawn: number;
  /** Of those, copied from a page bitmap. */
  fromBitmap: number;
  /** Time spent drawing thumbnails in the latest frame that drew any, and the most in one frame, in ms. */
  lastFrameMs: number;
  maxFrameMs: number;
}

interface Press {
  pointerId: number;
  thumb: Thumb;
  x: number;
  y: number;
  mouse: boolean;
  lifted: boolean;
  dragging: boolean;
  moved: boolean;
  timer: number;
  to: number;
}

export class PagesPanel {
  readonly el: HTMLElement;
  readonly list: HTMLElement;
  readonly stats: PanelStats = { drawn: 0, fromBitmap: 0, lastFrameMs: 0, maxFrameMs: 0 };
  private thumbs: Thumb[] = [];
  private byEl = new Map<Element, Thumb>();
  private observer: IntersectionObserver | null = null;
  private frame = 0;
  private open = false;
  private currentIndex = -1;
  private press: Press | null = null;
  private dropLine: HTMLElement;
  private cleanup: (() => void)[] = [];

  constructor(parent: HTMLElement, private host: PagesHost) {
    this.el = parent.createDiv({ cls: 'nb-pages-panel', attr: { 'aria-label': 'Pages' } });
    this.el.hide();
    this.list = this.el.createDiv({ cls: 'nb-pages-list' });
    this.dropLine = this.list.createDiv({ cls: 'nb-pages-drop' });
    this.dropLine.hide();
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      el.addEventListener(type, fn, options);
      this.cleanup.push(() => el.removeEventListener(type, fn, options));
    };
    on(this.list, 'pointerdown', e => this.down(e));
    on(this.list, 'pointermove', e => this.move(e));
    on(this.list, 'pointerup', e => this.up(e, false));
    on(this.list, 'pointercancel', e => this.up(e, true));
    // Once a thumbnail is picked up, a finger drags it instead of scrolling the panel.
    on(this.list, 'touchmove', e => {
      if (this.press?.lifted) e.preventDefault();
    }, { passive: false });
    on(this.list, 'contextmenu', e => e.preventDefault());
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean) {
    if (open === this.open) return;
    this.open = open;
    if (open) {
      this.el.show();
      this.observer = new IntersectionObserver(entries => this.intersect(entries), { root: this.list, rootMargin: '120px 0px' });
      this.sync();
      for (const t of this.thumbs) this.observer.observe(t.el);
      this.setCurrent(this.host.current(), true);
    } else {
      this.el.hide();
      this.cancelPress();
      this.observer?.disconnect();
      this.observer = null;
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      // Free the thumbnails' memory; they are drawn again when the panel next opens.
      for (const t of this.thumbs) this.dropThumb(t);
    }
  }

  /** Brings the thumbnails in line with the note's pages (added, removed, reordered). */
  sync() {
    if (!this.open) {
      if (this.thumbs.length) this.clear();
      return;
    }
    const pages = this.host.pages();
    if (pages.length === this.thumbs.length && pages.every((p, i) => p.id === this.thumbs[i].id)) {
      this.thumbs.forEach((t, i) => this.size(t, pages[i].size));
      return;
    }
    this.cancelPress();
    const old = new Map(this.thumbs.map(t => [t.id, t] as const));
    this.thumbs = pages.map(p => {
      const t = old.get(p.id) ?? this.makeThumb(p.id);
      old.delete(p.id);
      this.size(t, p.size);
      return t;
    });
    for (const t of old.values()) this.removeThumb(t);
    this.thumbs.forEach((t, i) => {
      this.list.insertBefore(t.el, this.dropLine);
      t.num.setText(String(i + 1));
    });
    this.currentIndex = -1;
    this.setCurrent(this.host.current());
    this.schedule();
  }

  /** Marks the current page; with `reveal`, scrolls its thumbnail into the panel's view. */
  setCurrent(index: number, reveal = true) {
    if (!this.open || index === this.currentIndex) return;
    this.currentIndex = index;
    this.thumbs.forEach((t, i) => {
      t.el.toggleClass('is-current', i === index);
      t.el.setAttribute('aria-current', i === index ? 'page' : 'false');
    });
    const t = this.thumbs[index];
    if (reveal && t && !this.press) {
      const top = t.el.offsetTop, bottom = top + t.el.offsetHeight, l = this.list;
      if (top < l.scrollTop) l.scrollTop = top - 8;
      else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight + 8;
    }
  }

  /** A page changed (strokes, template, reloaded): its thumbnail is redrawn after THUMB_DELAY. */
  changed(id: string) {
    const t = this.thumbs.find(th => th.id === id);
    if (!t) return;
    window.clearTimeout(t.timer);
    t.timer = window.setTimeout(() => {
      t.timer = 0;
      t.stale = true;
      this.schedule();
    }, THUMB_DELAY);
  }

  /** Whether any thumbnail in view still needs drawing (for tests). */
  get busy(): boolean {
    return this.thumbs.some(t => t.visible && (t.stale || t.timer));
  }

  destroy() {
    this.setOpen(false);
    this.clear();
    for (const f of this.cleanup.splice(0)) f();
    this.el.remove();
  }

  // ---- thumbnails

  private makeThumb(id: string): Thumb {
    const el = createDiv({ cls: 'nb-pages-thumb' });
    el.dataset.page = id;
    const frame = el.createDiv({ cls: 'nb-pages-frame' });
    const num = el.createDiv({ cls: 'nb-pages-num' });
    const actions = el.createDiv({ cls: 'nb-pages-actions' });
    const t: Thumb = { id, el, frame, num, bitmap: null, stale: true, visible: false, timer: 0, pending: null };
    const action = (cls: string, text: string, label: string, fn: (i: number) => void) => {
      const b = actions.createEl('button', { cls: `nb-pages-action ${cls}`, text, attr: { 'aria-label': label, type: 'button' } });
      b.addEventListener('click', e => {
        e.stopPropagation();
        const i = this.thumbs.indexOf(t);
        if (i >= 0) fn(i);
      });
    };
    action('nb-pages-insert', '+', 'Insert page after', i => this.host.insertAfter(i));
    action('nb-pages-duplicate', 'Copy', 'Duplicate page', i => this.host.duplicate(i));
    action('nb-pages-delete', 'Delete', 'Delete page', i => this.host.remove(i));
    this.byEl.set(el, t);
    this.observer?.observe(el);
    return t;
  }

  private size(t: Thumb, size: Size) {
    const h = Math.max(1, Math.round(THUMB_WIDTH * size.height / size.width));
    const s = t.frame.style;
    if (s.height !== `${h}px`) {
      s.width = `${THUMB_WIDTH}px`;
      s.height = `${h}px`;
      if (t.bitmap && t.bitmap.cssHeight !== h) t.stale = true;
    }
  }

  private removeThumb(t: Thumb) {
    window.clearTimeout(t.timer);
    this.observer?.unobserve(t.el);
    this.dropThumb(t);
    this.byEl.delete(t.el);
    t.el.remove();
  }

  private dropThumb(t: Thumb) {
    t.bitmap?.release();
    t.bitmap = null;
    t.pending = null;
    t.stale = true;
    t.visible = false;
  }

  private clear() {
    for (const t of this.thumbs) this.removeThumb(t);
    this.thumbs = [];
    this.currentIndex = -1;
  }

  private intersect(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      const t = this.byEl.get(e.target);
      if (t) t.visible = e.isIntersecting;
    }
    this.schedule();
  }

  private schedule() {
    if (this.frame || !this.open) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.drawSome();
    });
  }

  /** Draws up to THUMBS_PER_FRAME stale thumbnails in view, within THUMB_BUDGET ms. */
  private drawSome() {
    if (!this.open) return;
    const t0 = performance.now(), deadline = t0 + THUMB_BUDGET;
    let drawn = 0, more = false;
    for (const t of this.thumbs) {
      if (!t.visible || !t.stale || t.timer) continue;
      if (drawn >= THUMBS_PER_FRAME || performance.now() >= deadline) {
        more = true;
        break;
      }
      const done = this.draw(t, deadline);
      if (done) drawn++;
      else {
        more = true; // outlines to finish next frame
        break;
      }
    }
    if (drawn) {
      const ms = performance.now() - t0;
      this.stats.lastFrameMs = ms;
      this.stats.maxFrameMs = Math.max(this.stats.maxFrameMs, ms);
    }
    if (more) this.schedule();
  }

  /** Draws one thumbnail; false if the page's outlines aren't ready by `deadline` (try again). */
  private draw(t: Thumb, deadline: number): boolean {
    const i = this.thumbs.indexOf(t);
    const p = this.host.pages()[i];
    if (!p) return true;
    const w = THUMB_WIDTH, h = Math.max(1, Math.round(THUMB_WIDTH * p.size.height / p.size.width));
    if (!t.bitmap || t.bitmap.cssHeight !== h) {
      t.pending = null;
      t.bitmap?.release();
      t.bitmap = new PageBitmap(w, h);
      t.bitmap.canvas.className = 'nb-pages-canvas';
      t.frame.prepend(t.bitmap.canvas);
    }
    const c = t.bitmap.canvas;
    const source = t.pending == null ? this.host.bitmap(t.id) : null;
    if (source && source.width > 0) {
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(source, 0, 0, c.width, c.height);
      this.stats.fromBitmap++;
    } else {
      const page = this.host.page(t.id);
      const theme = this.host.theme();
      if (!page) {
        const ctx = c.getContext('2d')!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = theme.paper;
        ctx.fillRect(0, 0, c.width, c.height);
        t.el.addClass('is-error');
      } else {
        t.el.removeClass('is-error');
        if (!warmOutlines(page, deadline)) return false;
        if (t.pending == null) {
          const img = this.host.template(page.template, page.size, c.width, c.height, () => {
            t.stale = true;
            this.schedule();
          });
          t.bitmap.renderBase(page, theme, img);
          t.pending = 0;
        }
        // Pen strokes in chunks until the frame's budget is spent; the rest next frame.
        while (t.pending < page.strokes.length) {
          if (performance.now() >= deadline) return false;
          t.pending = t.bitmap.renderPen(page, theme, t.pending, 40);
        }
        t.pending = null;
      }
    }
    t.stale = false;
    this.stats.drawn++;
    return true;
  }

  // ---- tapping and dragging

  private thumbAt(target: EventTarget | null): Thumb | null {
    const el = target instanceof Element ? target.closest('.nb-pages-thumb') : null;
    return el ? this.byEl.get(el) ?? null : null;
  }

  private down(e: PointerEvent) {
    if (this.press || !e.isPrimary || e.button > 0) return;
    if (e.target instanceof Element && e.target.closest('.nb-pages-action')) return; // a button: its click handles it
    const thumb = this.thumbAt(e.target);
    if (!thumb) return;
    const mouse = e.pointerType === 'mouse';
    const press: Press = { pointerId: e.pointerId, thumb, x: e.clientX, y: e.clientY, mouse, lifted: false, dragging: false, moved: false, timer: 0, to: -1 };
    this.press = press;
    if (!mouse) press.timer = window.setTimeout(() => this.lift(press), LIFT_MS);
  }

  private lift(press: Press) {
    if (this.press !== press || press.moved) return;
    press.lifted = true;
    press.thumb.el.addClass('is-lifted');
    this.list.addClass('is-dragging');
    try {
      this.list.setPointerCapture(press.pointerId);
    } catch (e) {
      // the pointer is gone
    }
  }

  private move(e: PointerEvent) {
    const press = this.press;
    if (!press || e.pointerId !== press.pointerId) return;
    const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (!press.lifted) {
      if (dist <= SLOP) return;
      press.moved = true;
      if (!press.mouse) {
        // A finger moving before the long press: a scroll of the panel.
        this.cancelPress();
        return;
      }
      this.lift(press); // a mouse drags at once
    }
    e.preventDefault();
    press.dragging = true;
    press.thumb.el.addClass('is-dragging');
    this.autoScroll(e.clientY);
    press.to = this.dropIndex(press.thumb, e.clientY);
    this.showDrop(press.thumb, press.to);
  }

  private up(e: PointerEvent, cancelled: boolean) {
    const press = this.press;
    if (!press || e.pointerId !== press.pointerId) return;
    const from = this.thumbs.indexOf(press.thumb);
    const { dragging, moved, to } = press;
    this.cancelPress();
    if (cancelled || from < 0) return;
    if (dragging) {
      if (to >= 0 && to !== from) this.host.move(from, to);
    } else if (!moved) {
      this.host.go(from);
    }
  }

  private cancelPress() {
    const press = this.press;
    if (!press) return;
    this.press = null;
    window.clearTimeout(press.timer);
    press.thumb.el.removeClass('is-lifted');
    press.thumb.el.removeClass('is-dragging');
    this.list.removeClass('is-dragging');
    this.dropLine.hide();
    try {
      if (this.list.hasPointerCapture(press.pointerId)) this.list.releasePointerCapture(press.pointerId);
    } catch (e) {
      // the pointer is gone
    }
  }

  /** Where the dragged thumbnail would go: its index among the other pages, by the pointer's y. */
  private dropIndex(dragged: Thumb, clientY: number): number {
    let to = 0;
    for (const t of this.thumbs) {
      if (t === dragged) continue;
      const r = t.el.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) to++;
    }
    return to;
  }

  private showDrop(dragged: Thumb, to: number) {
    const others = this.thumbs.filter(t => t !== dragged);
    const before = others[to];
    const after = others[to - 1];
    const y = before ? before.el.offsetTop - 4 : after ? after.el.offsetTop + after.el.offsetHeight + 4 : 0;
    this.dropLine.style.top = `${y}px`;
    this.dropLine.show();
  }

  /** Scrolls the panel while a thumbnail is dragged near its top or bottom edge. */
  private autoScroll(clientY: number) {
    const r = this.list.getBoundingClientRect(), edge = 40;
    if (clientY < r.top + edge) this.list.scrollTop -= 12;
    else if (clientY > r.bottom - edge) this.list.scrollTop += 12;
  }
}

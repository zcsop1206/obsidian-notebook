/**
 * Link input in the study view (SPEC.md, input rules): a finger (or mouse) tap follows a link
 * (under TAP_SLOP px and TAP_MS ms), a finger hold of HOLD_MS peeks, a drag scrolls (the browser
 * does that), and the Pencil on the page text never follows a link: it writes there. Where the
 * Pencil cannot write (the peek, blocks' controls, panels) it taps like a finger. Fingers never
 * draw (the ink layer, S4, ignores touch). Owned by S3.
 */

export const TAP_SLOP = 10;
export const TAP_MS = 300;
export const HOLD_MS = 450;

/** A press that moved less than TAP_SLOP px and lasted less than TAP_MS ms. */
export function isTap(dx: number, dy: number, ms: number): boolean {
  return Math.hypot(dx, dy) < TAP_SLOP && ms < TAP_MS;
}

/** Touches with touchType "stylus" are the Pencil (iPadOS sends touch events alongside pointer events). */
export function hasStylus(e: TouchEvent): boolean {
  return Array.from(e.changedTouches).some(t => (t as Touch & { touchType?: string }).touchType === 'stylus');
}

/** Elements a Pencil tap must still reach on the page (the page ink's PAGE_INK_SKIP controls, plus the view's own). */
export const PEN_CONTROLS = 'button, select, input, textarea, label, summary, [contenteditable="true"], [contenteditable=""], [role="button"], .no-ink, .nb-study-no-ink, .nb-study-control';

export interface GestureHost {
  /** The link under an event target that this view handles, or null. */
  linkAt(target: EventTarget | null): HTMLElement | null;
  /** True where the Pencil writes over this link instead of following it. */
  penWrites(link: HTMLElement): boolean;
  follow(link: HTMLElement): void;
  peek(link: HTMLElement): void;
  /** Every primary pointer down in the root (closes the peek when outside it). */
  down?(e: PointerEvent): void;
}

interface Press { id: number; x: number; y: number; t: number; link: HTMLElement; timer: number; held: boolean }

export class LinkGestures {
  private press: Press | null = null;
  private offs: (() => void)[] = [];
  /** For tests and the debug readout. */
  readonly stats = { taps: 0, holds: 0, penIgnored: 0, clicksSwallowed: 0 };

  constructor(private root: HTMLElement, private host: GestureHost) {
    const win = root.ownerDocument.defaultView || window;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(root, 'pointerdown', e => this.onDown(e), { capture: true });
    on(win, 'pointermove', e => this.onMove(e), { capture: true, passive: true });
    on(win, 'pointerup', e => this.onUp(e), { capture: true });
    on(win, 'pointercancel', e => this.onCancel(e), { capture: true });
    // Links are followed from pointer events; the click that follows them (and a pen tap's) is
    // swallowed so Obsidian or the web view never navigates. A keyboard click (detail 0) follows.
    on(root, 'click', e => this.onClick(e), { capture: true });
    on(root, 'contextmenu', e => { if (this.host.linkAt(e.target)) e.preventDefault(); }, { capture: true });
  }

  destroy(): void {
    this.cancel();
    for (const off of this.offs.splice(0)) off();
  }

  private onDown(e: PointerEvent): void {
    if (e.isPrimary !== false) this.host.down?.(e);
    const link = this.host.linkAt(e.target);
    if (!link) return;
    if (e.pointerType === 'pen' && this.host.penWrites(link)) { this.stats.penIgnored++; return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.cancel();
    const p: Press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), link, timer: 0, held: false };
    p.timer = window.setTimeout(() => {
      if (this.press !== p) return;
      p.held = true;
      this.stats.holds++;
      this.host.peek(link);
    }, HOLD_MS);
    this.press = p;
  }

  private onMove(e: PointerEvent): void {
    const p = this.press;
    if (p && e.pointerId === p.id && !p.held && Math.hypot(e.clientX - p.x, e.clientY - p.y) >= TAP_SLOP) this.cancel();
  }

  private onUp(e: PointerEvent): void {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.cancel();
    if (!p.held && isTap(e.clientX - p.x, e.clientY - p.y, performance.now() - p.t)) {
      this.stats.taps++;
      this.host.follow(p.link);
    }
  }

  private onCancel(e: PointerEvent): void {
    if (this.press && e.pointerId === this.press.id) this.cancel();
  }

  private onClick(e: MouseEvent): void {
    const link = this.host.linkAt(e.target);
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.detail === 0) this.host.follow(link);
    else this.stats.clicksSwallowed++;
  }

  private cancel(): void {
    if (this.press) window.clearTimeout(this.press.timer);
    this.press = null;
  }
}

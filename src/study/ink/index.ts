/**
 * Anchored ink for study docs and blocks (SPEC.md, Storage: Ink). Owned by S4 on docs/study/BOARD.md.
 *
 * createInkApi(ctx) gives the view (S3) page ink over a doc's passage stack and the blocks (S6,
 * S7, S9) their own canvases. Every surface and the page of one doc share one DocInkStore: the
 * doc's ink files under `<root>/ink/`, the union of every device's shown, only this device's
 * written (1 s after the last stroke, at once on pagehide and when the page is hidden). Stores
 * are cached per context for the session, so reopening a doc never races its own pending write.
 * Another device's file changing on disk (a sync) is re-read and redrawn.
 *
 * Pieces: model.ts (pure: file format, union, anchoring, placement, undo), store.ts (the files),
 * canvas.ts (pen input and drawing), page.ts (page ink, changed chips, orphan strip).
 */
import type { StudyContext } from '../context';
import type { StudyDoc } from '../types';
import type { InkApi, InkStroke, InkSurface, InkSurfaceOptions, PageInk } from '../view/host';
import { InkCanvas } from './canvas';
import { PAPER_WIDTH, newStrokeId, strokeKey } from './model';
import { PageInkImpl } from './page';
import { DocInkStore, type InkAdapter } from './store';

export { PAGE_INK_SKIP } from './page';

/** Where the Pencil does not write inside a block surface (it taps controls like a finger). */
const SURFACE_SKIP = 'button, input, textarea, select, label, [contenteditable="true"], [contenteditable=""], [role="button"], .no-ink, .nb-study-no-ink';

interface Shared {
  stores: Map<string, DocInkStore>;
  surfaces: Set<{ el: HTMLElement; canvas: InkCanvas }>;
  /** Every live canvas (pages and surfaces), repainted when the theme changes. */
  canvases: Set<InkCanvas>;
  wired: boolean;
}

const shared = new WeakMap<StudyContext, Shared>();

function sharedOf(ctx: StudyContext): Shared {
  let s = shared.get(ctx);
  if (!s) { s = { stores: new Map(), surfaces: new Set(), canvases: new Set(), wired: false }; shared.set(ctx, s); }
  return s;
}

/** Writes every doc's pending ink now (pagehide, hidden, unload). */
export function flushInk(ctx: StudyContext): Promise<void> {
  const s = shared.get(ctx);
  if (!s) return Promise.resolve();
  return Promise.all([...s.stores.values()].map(st => st.flush())).then(() => undefined);
}

function wire(ctx: StudyContext, sh: Shared): void {
  if (sh.wired) return;
  sh.wired = true;
  const flush = () => { void flushInk(ctx); };
  const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVis);
  const plugin = ctx.plugin as unknown as { register?: (fn: () => void) => void; registerEvent?: (ref: unknown) => void } | undefined;
  try {
    plugin?.register?.(() => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onVis); flush(); });
  } catch { /* a test context without a plugin */ }
  // Ink colours are theme tokens read at draw time, so a theme change only needs a repaint.
  const ws = ctx.app?.workspace as unknown as { on?: (name: string, cb: () => void) => unknown } | undefined;
  if (ws && typeof ws.on === 'function') {
    try {
      const ref = ws.on('css-change', () => { for (const c of sh.canvases) { try { c.redraw(); } catch (e) { console.error('[study] ink repaint', e); } } });
      plugin?.registerEvent?.(ref);
    } catch { /* an API without the event */ }
  }
  // Another device's ink file changed on disk (a sync): re-read it in every store it belongs to.
  const vault = ctx.app?.vault as unknown as { on?: (name: string, cb: (f: { path?: string }) => void) => unknown } | undefined;
  if (vault && typeof vault.on === 'function') {
    const onFile = (f: { path?: string }) => {
      const p = f && typeof f.path === 'string' ? f.path : '';
      if (!p.endsWith('.json')) return;
      for (const st of sh.stores.values()) void st.reload(p);
    };
    for (const name of ['modify', 'create', 'delete']) {
      try {
        const ref = vault.on(name, onFile);
        plugin?.registerEvent?.(ref);
      } catch { /* an API without the event */ }
    }
  }
}

function heightOf(opts?: InkSurfaceOptions): () => number {
  return () => {
    const h = typeof opts?.height === 'function' ? opts.height() : opts?.height;
    return typeof h === 'number' && h > 0 ? h : 320;
  };
}

export function createInkApi(ctx: StudyContext): InkApi {
  const sh = sharedOf(ctx);
  wire(ctx, sh);

  const storeFor = (docId: string): DocInkStore => {
    const { root, device } = ctx.settings();
    const key = `${root}\u0000${device}\u0000${docId}`;
    let st = sh.stores.get(key);
    if (!st) {
      st = new DocInkStore(ctx.app.vault.adapter as unknown as InkAdapter, root, device, docId);
      sh.stores.set(key, st);
    }
    return st;
  };

  const track = (c: InkCanvas) => { sh.canvases.add(c); return () => { sh.canvases.delete(c); }; };

  const layoutSurfaces = (stack: HTMLElement) => {
    for (const s of sh.surfaces) if (stack.contains(s.el)) { try { s.canvas.layout(); } catch (e) { console.error('[study] ink surface layout', e); } }
  };

  return {
    page(doc: StudyDoc, stack: HTMLElement, passageTop: (anchor: string) => number | null): PageInk {
      const store = storeFor(doc.id);
      return new PageInkImpl(doc, stack, passageTop, { ctx, store, layoutSurfaces, track, release: () => { void store.flush(); } });
    },

    surface(doc: StudyDoc, container: HTMLElement, key: string, opts?: InkSurfaceOptions): InkSurface {
      const store = storeFor(doc.id);
      const fns = new Set<(strokes: InkStroke[]) => void>();
      const mine = () => store.strokesOf(key);
      const ro = () => (typeof opts?.readOnly === 'function' ? !!opts.readOnly() : !!opts?.readOnly);
      const canvas = new InkCanvas({
        width: PAPER_WIDTH,
        height: heightOf(opts),
        overlay: false,
        host: container,
        className: 'nb-study-ink-surface',
        strokes: mine,
        color: s => (opts?.color ? opts.color(s) : '') || '--text-normal',
        readOnly: ro,
        ignore: e => { const t = e.target as Element | null; return !!(t && typeof t.closest === 'function' && t.closest(SURFACE_SKIP)); },
        meta: opts?.meta,
        commit: s => { store.add({ ...s, id: newStrokeId(), blk: key }); },
      });
      canvas.el.style.border = '1px solid var(--background-modifier-border, #ddd)';
      canvas.el.style.borderRadius = '6px';
      canvas.el.style.boxSizing = 'border-box';
      canvas.el.dataset.inkKey = key;
      const entry = { el: canvas.el, canvas };
      sh.surfaces.add(entry);
      const untrack = track(canvas);
      const signature = (l: InkStroke[]) => l.map(s => `${strokeKey(s)}:${s.p.length}`).join(',');
      let sig = signature(mine());
      const off = store.onChange(() => {
        const l = mine();
        canvas.redraw();
        const n = signature(l);
        if (n === sig) return;
        sig = n;
        for (const fn of [...fns]) { try { fn(l); } catch (e) { console.error('[study] ink surface onChange', e); } }
      });
      let destroyed = false;
      return {
        el: canvas.el,
        strokes: mine,
        count: () => mine().length,
        onChange: fn => { fns.add(fn); return () => { fns.delete(fn); }; },
        setReadOnly: on => canvas.setReadOnly(on),
        undo: () => store.undo(key),
        clear: () => { store.remove(mine().map(strokeKey)); },
        layout: () => canvas.layout(),
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          off();
          sh.surfaces.delete(entry);
          untrack();
          canvas.destroy();
          void store.flush();
        },
      };
    },
  };
}

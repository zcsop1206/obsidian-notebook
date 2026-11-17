/**
 * Page ink: the doc's own ink, over the passage stack (SPEC.md, Storage: Ink; S4 brief).
 *
 * A new stroke is anchored to the nearest anchored passage at or above its centre (model.ts) and
 * drawn relative to that passage's top, so it follows the passage when layout changes (fonts,
 * math, a block opening) and when a new build moves it. After a rewrite (the passage's hash
 * changed) its strokes are drawn at 35% with a "changed" chip in the margin: keep (the ink now
 * belongs to the new text) or delete. Strokes whose anchor is gone wait in an "Orphaned ink"
 * strip appended to the end of the stack, one group per old anchor, each with a delete button.
 * Nothing is deleted without a tap.
 */
import type { StudyContext } from '../context';
import type { StudyDoc } from '../types';
import type { InkStroke, PageInk } from '../view/host';
import { InkCanvas } from './canvas';
import {
  PAPER_WIDTH, anchorStroke, changedByAnchor, docAnchors, newStrokeId, orphanGroups, placeStroke, reanchorCounts, strokeKey,
  type AnchorTop,
} from './model';
import type { DocInkStore } from './store';

/** Where the Pencil does not write on the page: controls, block canvases, the ink's own chips, and anything marked `no-ink`. */
export const PAGE_INK_SKIP = [
  '.nb-study-ink', '.nb-study-ink-chip', '.nb-study-ink-orphans', 'button', 'input', 'textarea', 'select', 'label', 'summary',
  '[contenteditable="true"]', '[contenteditable=""]', '[role="button"]', '.no-ink', '.nb-study-no-ink',
].join(', ');
/** Where the mouse does not write either: links and chips, so a click follows them. */
const MOUSE_SKIP = 'a[href], a.internal-link, a.external-link, .sr-ref, [data-href], .chip, [data-act]';

function plural(n: number, w: string): string { return `${n} ${w}${n === 1 ? '' : 's'}`; }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, css?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface PageDeps {
  ctx: StudyContext;
  store: DocInkStore;
  /** Re-lay out block surfaces inside this stack (their own ResizeObserver misses an ancestor's scale). */
  layoutSurfaces(stack: HTMLElement): void;
  release(): void;
}

export class PageInkImpl implements PageInk {
  private doc: StudyDoc;
  private revs: Map<string, string>;
  private tops = new Map<string, number | null>();
  private orphanPos = new Map<string, { top: number; minY: number }>();
  private canvas: InkCanvas;
  private strip: HTMLElement | null = null;
  private stripSig = '';
  private chips: HTMLElement;
  private chipSig = '';
  private off: () => void;
  private destroyed = false;

  constructor(doc: StudyDoc, private stack: HTMLElement, private passageTop: (anchor: string) => number | null, private d: PageDeps) {
    this.doc = doc;
    this.revs = docAnchors(doc);
    if (getComputedStyle(stack).position === 'static') stack.style.position = 'relative';
    this.chips = el('div', 'nb-study-ink-chips', 'position:absolute;left:0;top:0;width:100%;height:0;z-index:3;pointer-events:none;');
    stack.appendChild(this.chips);
    const W = stack.offsetWidth > 0 ? stack.offsetWidth : PAPER_WIDTH;
    this.canvas = new InkCanvas({
      width: W,
      height: () => Math.max(stack.offsetHeight, stack.scrollHeight, 1),
      overlay: true,
      host: stack,
      strokes: () => this.d.store.strokesOf(null),
      place: s => placeStroke(s, this.revs, a => (this.tops.has(a) ? this.tops.get(a)! : null), a => this.orphanPos.get(a) ?? null),
      color: () => '--text-normal',
      readOnly: () => false,
      ignore: e => this.ignore(e),
      swallowClick: true,
      commit: s => this.commit(s),
    });
    this.off = this.d.store.onChange(why => { if (!this.destroyed) { if (why === 'add') this.canvas.redraw(); else this.relayout(); } });
    this.relayout();
  }

  private ignore(e: Event): boolean {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== 'function') return false;
    if (t.closest(PAGE_INK_SKIP)) return true;
    if ((e as PointerEvent).pointerType === 'mouse' && t.closest(MOUSE_SKIP)) return true;
    return false;
  }

  /** The doc's anchors in document order (list items after their list), with their tops now. */
  private measure(): AnchorTop[] {
    const out: AnchorTop[] = [];
    this.tops.clear();
    for (const a of this.revs.keys()) {
      let top: number | null = null;
      try { top = this.passageTop(a); } catch { top = null; }
      if (typeof top !== 'number' || !isFinite(top)) top = null;
      this.tops.set(a, top);
      out.push({ a, top });
    }
    return out;
  }

  private commit(s: InkStroke): void {
    const tops = this.measure();
    const at = anchorStroke(s.p, tops, this.revs, this.doc.build);
    const st: InkStroke = { ...s, id: newStrokeId(), blk: null };
    if (at) st.at = at; else delete st.at;
    this.d.store.add(st);
  }

  /** Paper px per CSS px of the stack, and a child's top in paper px. */
  private paperTop(child: HTMLElement): number {
    const sr = this.stack.getBoundingClientRect(), r = child.getBoundingClientRect();
    const s = this.stack.offsetWidth > 0 && sr.width > 0 ? sr.width / this.stack.offsetWidth : 1;
    return (r.top - sr.top) / s;
  }

  private buildStrip(): void {
    const groups = orphanGroups(this.d.store.strokesOf(null), this.revs);
    const sig = groups.map(g => `${g.a}:${g.strokes.length}:${Math.round(g.minY)}:${Math.round(g.maxY)}`).join('|') + `#${this.doc.build}`;
    if (!groups.length) {
      if (this.strip) { this.strip.remove(); this.strip = null; this.stripSig = ''; }
      this.orphanPos.clear();
      return;
    }
    if (!this.strip || sig !== this.stripSig) {
      if (!this.strip) this.strip = el('div', 'nb-study-ink-orphans no-ink', 'margin:40px 0 24px;padding:12px 0 0;border-top:1px dashed var(--background-modifier-border, #ccc);');
      const s = this.strip;
      s.textContent = '';
      s.appendChild(el('div', 'nb-study-ink-orphans-title', 'font-weight:600;font-size:1.1em;margin-bottom:4px;', 'Orphaned ink'));
      s.appendChild(el('div', 'nb-study-ink-orphans-meta', 'color:var(--text-muted, #666);font-size:0.9em;margin-bottom:8px;',
        `Strokes whose passage is gone from build ${this.doc.build} of ${this.doc.title || this.doc.id}. They wait here until you delete them.`));
      for (const g of groups) {
        const box = el('div', 'nb-study-ink-orphan');
        box.dataset.a = g.a;
        const lbl = el('div', 'nb-study-ink-orphan-label', 'display:flex;gap:8px;align-items:center;color:var(--text-muted, #666);font-size:0.9em;');
        const code = el('code', '', '', `#${g.a}`);
        lbl.append('was at ', code, ` · ${plural(g.strokes.length, 'stroke')}`);
        const del = el('button', 'nb-study-ink-orphan-delete', '', 'delete');
        del.type = 'button';
        del.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); this.deleteOrphans(g.a); });
        lbl.appendChild(del);
        box.appendChild(lbl);
        const space = el('div', 'nb-study-ink-orphan-space', `height:${Math.round(Math.max(40, Math.min(1400, g.maxY - g.minY + 28)))}px;`);
        box.appendChild(space);
        s.appendChild(box);
      }
      this.stripSig = sig;
    }
    if (this.stack.lastElementChild !== this.strip) this.stack.appendChild(this.strip);
  }

  private placeOrphans(): void {
    this.orphanPos.clear();
    if (!this.strip) return;
    const groups = orphanGroups(this.d.store.strokesOf(null), this.revs);
    const minY = new Map(groups.map(g => [g.a, g.minY]));
    this.strip.querySelectorAll<HTMLElement>('.nb-study-ink-orphan').forEach(box => {
      const a = box.dataset.a || '';
      const space = box.querySelector<HTMLElement>('.nb-study-ink-orphan-space');
      if (!space || !minY.has(a)) return;
      this.orphanPos.set(a, { top: this.paperTop(space) + 14, minY: minY.get(a)! });
    });
  }

  private buildChips(): void {
    const changed = changedByAnchor(this.d.store.strokesOf(null), this.revs);
    const items: { a: string; top: number; n: number }[] = [];
    for (const [a, l] of changed) { const top = this.tops.get(a); if (typeof top === 'number') items.push({ a, top, n: l.length }); }
    items.sort((x, y) => x.top - y.top);
    const sig = items.map(i => `${i.a}:${i.n}:${i.top.toFixed(1)}`).join('|');
    if (sig === this.chipSig) return;
    this.chipSig = sig;
    this.chips.textContent = '';
    let y = -Infinity;
    for (const it of items) {
      // In the right margin, just under the passage's mark dot; chips never overlap each other.
      const top = Math.max(it.top + 26, y + 4);
      const chip = el('div', 'nb-study-ink-chip no-ink',
        `position:absolute;right:4px;top:${top.toFixed(1)}px;width:108px;pointer-events:auto;font-size:12px;line-height:1.3;padding:4px 6px;border-radius:6px;` +
        'background:var(--background-secondary, #f2f2f2);border:1px solid var(--background-modifier-border, #ddd);color:var(--text-muted, #666);');
      chip.dataset.a = it.a;
      chip.appendChild(el('div', '', '', `changed · ${plural(it.n, 'stroke')}`));
      const row = el('div', '', 'display:flex;gap:4px;margin-top:3px;');
      const keep = el('button', 'nb-study-ink-keep', 'flex:1;font-size:12px;padding:2px 4px;', 'keep');
      const del = el('button', 'nb-study-ink-delete', 'flex:1;font-size:12px;padding:2px 4px;', 'delete');
      keep.type = 'button'; del.type = 'button';
      keep.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); this.keep(it.a); });
      del.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); this.deleteChanged(it.a); });
      row.append(keep, del);
      chip.appendChild(row);
      this.chips.appendChild(chip);
      y = top + 52;
    }
  }

  private keep(a: string): void {
    const l = changedByAnchor(this.d.store.strokesOf(null), this.revs).get(a) ?? [];
    const rev = this.revs.get(a);
    if (!l.length || rev === undefined) return;
    this.d.store.keep(l.map(strokeKey), rev, this.doc.build);
    this.d.ctx.ui.toast('Kept: the ink now belongs to the new text.');
  }

  private deleteChanged(a: string): void {
    const l = changedByAnchor(this.d.store.strokesOf(null), this.revs).get(a) ?? [];
    const n = this.d.store.remove(l.map(strokeKey));
    if (n) this.d.ctx.ui.toast(`Deleted ${plural(n, 'stroke')} on the old text.`);
  }

  private deleteOrphans(a: string): void {
    const g = orphanGroups(this.d.store.strokesOf(null), this.revs).find(x => x.a === a);
    const n = g ? this.d.store.remove(g.strokes.map(strokeKey)) : 0;
    if (n) this.d.ctx.ui.toast(`Deleted ${plural(n, 'orphaned stroke')}.`);
  }

  relayout(): void {
    if (this.destroyed) return;
    this.buildStrip();
    this.measure();
    this.placeOrphans();
    this.buildChips();
    this.canvas.layout();
    this.d.layoutSurfaces(this.stack);
  }

  reanchor(): { moved: number; changed: number; orphaned: number } {
    let latest: StudyDoc | undefined;
    try { latest = this.d.ctx.content()?.docs?.get(this.doc.id); } catch { latest = undefined; }
    if (latest && latest !== this.doc) { this.doc = latest; this.revs = docAnchors(latest); }
    this.relayout();
    return reanchorCounts(this.d.store.strokesOf(null), this.revs, this.doc.build);
  }

  undo(): InkStroke | null {
    return this.d.store.undo(null);
  }

  /** Tests and debugging: each page stroke's state and placement now. */
  placements(): { key: string; a: string | null; dy: number | null; alpha: number | null }[] {
    return this.d.store.strokesOf(null).map(s => {
      const pl = placeStroke(s, this.revs, a => (this.tops.has(a) ? this.tops.get(a)! : null), a => this.orphanPos.get(a) ?? null);
      return { key: strokeKey(s), a: s.at?.a ?? null, dy: pl ? pl.dy : null, alpha: pl ? pl.alpha : null };
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.off();
    this.canvas.destroy();
    this.chips.remove();
    if (this.strip) this.strip.remove();
    this.d.release();
  }
}

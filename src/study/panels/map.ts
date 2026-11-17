/**
 * The Map panel (SPEC.md, Today and Map; ticket S8): the basics graph layered by `needs` (node
 * fill = drill stage, ring count = push level), ratings per area with a sparkline and the stretch
 * band, method-identification accuracy, and the tracks with deadlines and the basics blocking
 * them. Re-renders on `ctx.onChange`. The engine owns every number; calls are guarded so the
 * panel still renders before S2 lands.
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { StudyContext } from '../context';
import type { BasicState, StudyDoc } from '../types';

export const VIEW_TYPE_STUDY_MAP = 'notebook-study-map';

const DAY = 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Stretch band and target as expected scores (SPEC.md, Engine). */
const E_TARGET = 0.65;
const E_LO = 0.6;
const E_HI = 0.7;
const PUSH_TEXT = [
  'Level 0: proofs fogged step by step; each reveal needs 3 new strokes.',
  'Level 1: proof steps merged into bigger chunks.',
  'Level 2: proofs hidden; written cold as a blank-page drill.',
  'Level 3: theorems turn into problem-first hooks, and the area gets hidden-topic slots.',
];

function dayNum(s: string): number {
  const a = s.split('-');
  return Math.round(Date.UTC(+a[0], +a[1] - 1, +a[2]) / DAY);
}
function validDate(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function nice(s: string | null): string {
  if (!validDate(s)) return s || '—';
  const a = s.split('-');
  return `${MON[+a[1] - 1]} ${+a[2]}`;
}
function f2(x: number): string {
  return isFinite(x) ? (Math.round(x * 100) / 100).toFixed(2) : '–';
}
function pct(x: number): string {
  return isFinite(x) ? `${Math.round(x * 100)}%` : '–';
}
function clampStage(n: number): number {
  n = Math.round(+n || 0);
  return n < 0 ? 0 : n > 5 ? 5 : n;
}
function clampPush(n: number): number {
  n = Math.round(+n || 0);
  return n < 0 ? 0 : n > 3 ? 3 : n;
}
/** The difficulty at which a pick of difficulty d has expected score E at rating r (SPEC D1's inverse). */
function dForE(e: number, r: number): number {
  return r + 2 * Math.log10(1 / e - 1);
}

interface GraphNode {
  id: string;
  basic: BasicState | null;
  doc: StudyDoc | null;
  needs: string[];
  layer: number;
}

export class MapView extends ItemView {
  private off: (() => void) | null = null;
  private sel: string | null = null;

  constructor(leaf: WorkspaceLeaf, private ctx: StudyContext) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_STUDY_MAP;
  }
  getDisplayText(): string {
    return 'Study map';
  }
  getIcon(): string {
    return 'map';
  }

  async onOpen(): Promise<void> {
    this.off = this.ctx.onChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.off?.();
    this.off = null;
    this.contentEl.empty();
  }

  private call<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      console.error('[study map]', e);
      return fallback;
    }
  }
  private title(id: string): string {
    return this.ctx.content().docs.get(id)?.title || id;
  }
  private today(): string {
    return this.call(() => this.ctx.engine().today(), '');
  }

  render(): void {
    const el = this.contentEl;
    el.empty();
    const root = el.createDiv({ cls: 'nb-sp nb-sp-map' });
    root.createDiv({ cls: 'nb-sp-date', text: 'Study map' });
    this.basicsSec(root);
    this.ratingsSec(root);
    this.methodsSec(root);
    this.tracksSec(root);
    requestAnimationFrame(() => this.drawEdges(root));
  }

  /* ---------------- basics graph ---------------- */

  private graph(): GraphNode[] {
    const content = this.ctx.content();
    const basics = new Map<string, BasicState>();
    for (const b of this.call(() => this.ctx.engine().basics(), [] as BasicState[])) basics.set(b.id, b);
    // Engine state for basics not yet in its list (fresh docs start at stage 0/1 per SPEC).
    for (const [id, d] of content.docs) {
      if (d.kind === 'basic' && !basics.has(id)) {
        basics.set(id, { id, stage: 0, due: null, push: 0, streak: 0, last: null, history: [] });
      }
    }
    const nodes = new Map<string, GraphNode>();
    for (const [id, b] of basics) nodes.set(id, { id, basic: b, doc: content.docs.get(id) ?? null, needs: [], layer: 0 });
    // Topic docs sit in the graph too, as plain nodes (the demo's "topic doc").
    for (const [id, d] of content.docs) {
      if (d.kind === 'topic') nodes.set(id, { id, basic: null, doc: d, needs: [], layer: 0 });
    }
    for (const n of nodes.values()) {
      const needs = (n.basic ? n.doc?.needs ?? [] : n.doc?.needs ?? []).filter(x => x !== n.id && nodes.has(x));
      n.needs = [...new Set(needs)];
    }
    const layerOf = (id: string, seen: Set<string>): number => {
      const n = nodes.get(id);
      if (!n || n.layer > 0) return n ? n.layer : 0;
      if (seen.has(id)) return 0;
      seen.add(id);
      let m = -1;
      for (const x of n.needs) m = Math.max(m, layerOf(x, seen));
      return (n.layer = m + 1);
    };
    for (const id of nodes.keys()) layerOf(id, new Set());
    return [...nodes.values()];
  }

  private basicsSec(root: HTMLElement): void {
    const sec = root.createEl('section', { cls: 'nb-sp-sec' });
    const nodes = this.graph();
    const h = sec.createEl('h3', { text: 'Basics' });
    h.createSpan({ cls: 'nb-sp-count', text: `${nodes.filter(n => n.basic).length} basics` });
    sec.createDiv({
      cls: 'nb-sp-sub',
      text: 'Each basic rests on the ones above it. Fill is the drill stage, one ring per push level. Tap a node for detail.',
    });
    const legend = sec.createDiv({ cls: 'nb-map-legend' });
    for (let i = 0; i <= 5; i++) legend.createSpan({ cls: `nb-map-sw s${i}`, text: String(i) });
    legend.createSpan({ cls: 'nb-sp-sub', text: ' stage · ringed = push level' });
    if (!nodes.length) {
      sec.createDiv({ cls: 'nb-sp-empty', text: 'No basics in the study root yet.' });
      return;
    }
    const maxLayer = Math.max(...nodes.map(n => n.layer));
    const order = [...this.ctx.content().docs.keys()];
    const graph = sec.createDiv({ cls: 'nb-map-graph' });
    const edgesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    edgesSvg.setAttribute('class', 'nb-map-edges');
    edgesSvg.setAttribute('aria-hidden', 'true');
    graph.appendChild(edgesSvg);
    for (let li = 0; li <= maxLayer; li++) {
      const row = graph.createDiv({ cls: 'nb-map-layer' });
      for (const n of nodes.filter(x => x.layer === li).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))) {
        row.appendChild(this.nodeEl(n));
      }
    }
    const detail = sec.createDiv({ cls: 'nb-map-detail' });
    this.renderDetail(detail);
  }

  private nodeEl(n: GraphNode): HTMLElement {
    const st = n.basic ? clampStage(n.basic.stage) : 0;
    const pu = n.basic ? clampPush(n.basic.push ?? this.call(() => this.ctx.engine().pushLevel(n.id), 0)) : 0;
    const cls = n.basic ? `nb-map-node s${st} p${pu}` : 'nb-map-node topic';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls + (this.sel === n.id ? ' sel' : '');
    b.dataset.node = n.id;
    b.dataset.layer = String(n.layer);
    b.dataset.ring = String(pu * 4);
    b.createSpan({ cls: 'nb-map-nt', text: n.doc?.title || n.id });
    b.createSpan({ cls: 'nb-map-nm', text: n.basic ? `stage ${st} · push ${pu}` : 'topic doc' });
    b.addEventListener('click', () => {
      this.sel = this.sel === n.id ? null : n.id;
      const detail = this.contentEl.querySelector('.nb-map-detail') as HTMLElement | null;
      if (detail) this.renderDetail(detail);
      this.contentEl.querySelectorAll('.nb-map-node').forEach(el => {
        el.classList.toggle('sel', (el as HTMLElement).dataset.node === this.sel);
      });
    });
    return b;
  }

  /** Edges between layers, drawn after layout from node rects (as the demo's drawEdges). */
  private drawEdges(root: HTMLElement): void {
    const g = root.querySelector('.nb-map-graph') as HTMLElement | null;
    const svg = g?.querySelector('svg.nb-map-edges') as SVGSVGElement | null;
    if (!g || !svg) return;
    const W = g.clientWidth;
    const H = g.clientHeight;
    if (!W || !H) return;
    const gr = g.getBoundingClientRect();
    const k = W / gr.width || 1;
    const pos = new Map<string, { l: number; t: number; r: number; b: number; layer: number; ring: number }>();
    g.querySelectorAll('[data-node]').forEach(el => {
      const e = el as HTMLElement;
      const r = e.getBoundingClientRect();
      pos.set(e.dataset.node || '', {
        l: (r.left - gr.left) * k, t: (r.top - gr.top) * k, r: (r.right - gr.left) * k, b: (r.bottom - gr.top) * k,
        layer: +(e.dataset.layer || 0), ring: +(e.dataset.ring || 0),
      });
    });
    const paths: string[] = [];
    for (const n of this.graph()) {
      const bb = pos.get(n.id);
      if (!bb) continue;
      for (const x of n.needs) {
        const aa = pos.get(x);
        if (!aa) continue;
        const x1 = (aa.l + aa.r) / 2;
        const y1 = aa.b + aa.ring;
        const x2 = (bb.l + bb.r) / 2;
        const y2 = bb.t - bb.ring - 2;
        const my = (y1 + y2) / 2;
        paths.push(`<path class="nb-map-edge" d="M${x1.toFixed(1)} ${y1.toFixed(1)}C${x1.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`);
      }
    }
    // No width/height attributes: inset:0 stretches the svg to the graph box; the paths are in
    // CSS px so no viewBox is needed (a fixed pixel width would overflow narrow layouts).
    svg.innerHTML = paths.join('');
  }

  private linkRow(parent: HTMLElement, ids: string[]): void {
    if (!ids.length) {
      parent.createSpan({ cls: 'nb-sp-empty', text: 'none' });
      return;
    }
    ids.forEach((id, i) => {
      if (i) parent.appendText(', ');
      const a = parent.createEl('button', { cls: 'nb-st-basiclink', text: this.title(id) });
      a.addEventListener('click', () => void this.ctx.ui.openDoc(id));
    });
  }

  private renderDetail(box: HTMLElement): void {
    box.empty();
    const id = this.sel;
    const content = this.ctx.content();
    const d = id ? content.docs.get(id) : undefined;
    if (!id || !d) {
      box.createDiv({ cls: 'nb-sp-empty', text: 'Tap a basic for its stage, push level, due date, what it rests on and feeds, and what it blocks.' });
      return;
    }
    const b = this.call(() => this.ctx.engine().basic(id), null as BasicState | null);
    const st = b ? clampStage(b.stage) : 0;
    const pu = b ? clampPush(b.push ?? this.call(() => this.ctx.engine().pushLevel(id), 0)) : 0;
    const card = box.createDiv({ cls: 'nb-sp-item nb-map-card' });
    const head = card.createDiv();
    head.createSpan({ cls: 'nb-sp-t', text: d.title || id });
    head.createSpan({ text: ' ' });
    head.createSpan({ cls: 'nb-sp-chip', text: d.kind });
    const kv = card.createEl('dl', { cls: 'nb-map-kv' });
    const row = (k: string, v: string) => {
      kv.createEl('dt', { text: k });
      kv.createEl('dd', { text: v });
    };
    if (b) {
      row('Stage', `${st} of 5${b.streak ? ` · clean run ${b.streak}` : ''}`);
      row('Push', PUSH_TEXT[pu]);
      const today = this.today();
      const od = validDate(b.due) && validDate(today) ? dayNum(b.due) - dayNum(today) : null;
      row('Due', b.due ? `${nice(b.due)}${od !== null ? (od > 0 ? ` · in ${od} d` : od === 0 ? ' · due today' : ` · ${-od} d overdue`) : ''}` : '—');
      row('Last', b.last ? `${b.last}` : 'no graded drill yet');
    }
    kv.createEl('dt', { text: 'Rests on' });
    const restDd = kv.createEl('dd');
    this.linkRow(restDd, d.needs);
    const feeds = [...(content.usedBy.get(id) || [])];
    kv.createEl('dt', { text: 'Feeds' });
    const feedDd = kv.createEl('dd');
    this.linkRow(feedDd, feeds);
    const acts = card.createDiv({ cls: 'nb-st-row' });
    const open = acts.createEl('button', { cls: 'primary', text: 'Open' });
    open.addEventListener('click', () => void this.ctx.ui.openDoc(id));
    if (d.derives.length) {
      const dr = acts.createEl('button', { text: 'Drill' });
      dr.addEventListener('click', () => void this.ctx.ui.openDrill(id, d.derives[0].anchor));
    }
  }

  /* ---------------- ratings ---------------- */

  private areas(): string[] {
    const out = new Set<string>();
    for (const d of this.ctx.content().docs.values()) for (const a of d.areas) out.add(a);
    for (const t of this.ctx.content().tracks) for (const a of t.areas) out.add(a);
    return [...out].sort();
  }

  private sparkline(hist: { t: string; r: number }[]): SVGSVGElement | null {
    const v = hist.map(x => +x.r).filter(x => isFinite(x));
    if (!v.length) return null;
    const w = 120, h = 30;
    let lo = Math.min(...v), hi = Math.max(...v);
    if (hi - lo < 0.5) {
      const m = (hi + lo) / 2;
      lo = m - 0.25;
      hi = m + 0.25;
    }
    const pts = v.map((r, i) => {
      const x = v.length === 1 ? w - 6 : 6 + (i * (w - 12)) / (v.length - 1);
      const y = h - 6 - ((r - lo) / (hi - lo)) * (h - 12);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const last = pts[pts.length - 1].split(',');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'nb-map-spark');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `rating history, ${v.length} points`);
    svg.innerHTML =
      (v.length > 1 ? `<polyline points="${pts.join(' ')}"/>` : `<line x1="6" x2="${w - 6}" y1="${last[1]}" y2="${last[1]}"/>`) +
      `<circle cx="${last[0]}" cy="${last[1]}" r="3.5"/>`;
    return svg;
  }

  /** Rating card: name, r, the stretch band on a difficulty ladder, the history sparkline. */
  private rateCard(parent: HTMLElement, area: string): void {
    const r = this.call(() => this.ctx.engine().rating(area), NaN);
    if (!isFinite(r)) return;
    const card = parent.createDiv({ cls: 'nb-map-rate' });
    const head = card.createDiv();
    head.createEl('b', { text: area });
    head.createSpan({ cls: 'nb-sp-num nb-map-rv', text: f2(r) });
    // Ladder: d from r-2 to r+2, the stretch band (E 0.60–0.70), the target tick (E 0.65), r as a dot.
    const w = 300, h = 34, d0 = r - 2.5, d1 = r + 2.5, y = 18;
    const x = (d: number) => 8 + ((Math.max(d0, Math.min(d1, d)) - d0) * (w - 16)) / (d1 - d0);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'nb-map-lad');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `difficulty ladder: r ${f2(r)}, stretch band E ${E_LO} to ${E_HI}`);
    const blo = dForE(E_HI, r);
    const bhi = dForE(E_LO, r);
    const tgt = dForE(E_TARGET, r);
    svg.innerHTML =
      `<line class="ax" x1="${x(d0)}" x2="${x(d1)}" y1="${y}" y2="${y}"/>` +
      `<rect class="band" x="${x(blo)}" y="${y - 6}" width="${Math.max(3, x(bhi) - x(blo))}" height="12" rx="3"/>` +
      `<line class="tgt" x1="${x(tgt)}" x2="${x(tgt)}" y1="${y - 9}" y2="${y + 9}"/>` +
      `<circle class="r" cx="${x(r)}" cy="${y}" r="5"/>` +
      `<text x="${x(d0)}" y="${y + 20}">d ${d0.toFixed(1)}</text>` +
      `<text x="${x(d1)}" y="${y + 20}" text-anchor="end">${d1.toFixed(1)}</text>`;
    card.appendChild(svg);
    const foot = card.createDiv({ cls: 'nb-sp-m' });
    const spark = this.sparkline(this.call(() => this.ctx.engine().ratingHistory(area), []));
    if (spark) foot.appendChild(spark);
    foot.createSpan({ cls: 'nb-sp-sub', text: `band d ${blo.toFixed(2)}–${bhi.toFixed(2)} · target ${tgt.toFixed(2)}` });
  }

  private ratingsSec(root: HTMLElement): void {
    const sec = root.createEl('section', { cls: 'nb-sp-sec' });
    sec.createEl('h3', { text: 'Ratings' });
    sec.createDiv({
      cls: 'nb-sp-sub',
      text: 'A pick of difficulty d has expected score E = 1/(1 + 10^((d − r)/2)); the band is the stretch target E 0.60–0.70.',
    });
    const areas = this.areas();
    if (!areas.length) {
      sec.createDiv({ cls: 'nb-sp-empty', text: 'No areas in the study root yet.' });
      return;
    }
    for (const a of areas) this.rateCard(sec, a);
  }

  /* ---------------- method identification ---------------- */

  private methodsSec(root: HTMLElement): void {
    const sec = root.createEl('section', { cls: 'nb-sp-sec' });
    sec.createEl('h3', { text: 'Method identification' });
    const all = this.call(() => this.ctx.engine().methodAccuracy(), { p: 0.75, n: 0 });
    const bar = sec.createDiv({ cls: 'nb-map-acc' });
    const fill = bar.createDiv({ cls: 'nb-map-accfill' });
    fill.style.width = `${Math.round(all.p * 100)}%`;
    sec.createDiv({
      cls: 'nb-sp-sub',
      text: `The call named the method right ${pct(all.p)} of the time over ${all.n} hidden settle${all.n === 1 ? '' : 's'} (smoothed).`,
    });
  }

  /* ---------------- tracks ---------------- */

  private tracksSec(root: HTMLElement): void {
    const sec = root.createEl('section', { cls: 'nb-sp-sec' });
    sec.createEl('h3', { text: 'Tracks' });
    const today = this.today();
    const tracks = this.ctx.content().tracks.filter(t => t.weight > 0);
    if (!tracks.length) {
      sec.createDiv({ cls: 'nb-sp-empty', text: 'No live tracks in tracks.md.' });
      return;
    }
    const blockers = this.call(() => this.ctx.engine().blockers(), [] as { track: string; date: string | null; basics: string[] }[]);
    for (const t of tracks) {
      const card = sec.createDiv({ cls: 'nb-sp-item nb-map-track' });
      const head = card.createDiv();
      head.createSpan({ cls: 'nb-sp-t', text: t.id });
      const meta = card.createDiv({ cls: 'nb-sp-m' });
      if (validDate(t.deadline)) {
        const days = validDate(today) ? dayNum(t.deadline) - dayNum(today) : null;
        meta.createSpan({ cls: 'nb-sp-num', text: `${nice(t.deadline)}${t.until ? `–${nice(t.until)}` : ''}` });
        if (days !== null) {
          meta.createSpan({ cls: `nb-sp-flag ${days < 0 ? 'muted' : days < 30 ? 'bad' : 'warn'}`, text: days < 0 ? 'past' : `${days} d left` });
        }
      } else {
        meta.createSpan({ cls: 'nb-sp-flag muted', text: 'no deadline' });
      }
      if (t.docs) meta.createSpan({ cls: 'nb-sp-sub', text: `docs: ${t.docs}` });
      const bl = blockers.filter(b => b.track === t.id);
      const weak = bl.length ? bl[0].basics : [];
      if (weak.length) {
        const row = card.createDiv({ cls: 'nb-sp-m' });
        row.createSpan({ cls: 'nb-sp-sub', text: 'Blocked by' });
        weak.forEach(id => {
          const st = clampStage(this.call(() => this.ctx.engine().basic(id).stage, 0));
          const b = row.createEl('button', { cls: 'nb-map-need' });
          b.createSpan({ cls: `nb-map-dot s${st}` });
          b.createSpan({ text: `${this.title(id)} (stage ${st})` });
          b.addEventListener('click', () => void this.ctx.ui.openDoc(id));
        });
      } else {
        card.createDiv({ cls: 'nb-sp-m' }).createSpan({ cls: 'nb-sp-sub', text: 'Every basic it needs is on track.' });
      }
    }
  }
}

/** Map-only CSS, injected with the panels stylesheet (see register.ts). */
export const MAP_CSS = `
.nb-map-legend { display: flex; gap: 4px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.nb-map-sw { display: inline-block; width: 18px; height: 18px; border-radius: 4px; text-align: center;
  font-size: 11px; line-height: 18px; color: #fff; }
.nb-map-graph { position: relative; margin: 4px 0 10px; }
.nb-map-edges { position: absolute; inset: 0; pointer-events: none; }
.nb-map-edge { fill: none; stroke: var(--text-muted, #999); stroke-width: 1.4; opacity: 0.75; }
.nb-map-layer { position: relative; display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; z-index: 1; }
.nb-map-node { flex: 1 1 130px; max-width: 220px; border: 1px solid var(--background-modifier-border, #ccc);
  border-radius: 8px; padding: 6px 8px; font-size: 12px; cursor: pointer; text-align: left;
  background: var(--background-secondary, #eee); color: var(--text-normal, #222); }
.nb-map-node .nb-map-nt { display: block; font-weight: 600; }
.nb-map-node .nb-map-nm { display: block; font-size: 11px; opacity: 0.85; }
.nb-map-node.s0 { background: #9e9e9e; color: #fff; } .nb-map-node.s1 { background: #c25e00; color: #fff; }
.nb-map-node.s2 { background: #b8860b; color: #fff; } .nb-map-node.s3 { background: #6b8e23; color: #fff; }
.nb-map-node.s4 { background: #2e7d32; color: #fff; } .nb-map-node.s5 { background: #00695c; color: #fff; }
.nb-map-node.topic { background: var(--background-primary, #fff); }
.nb-map-node.p1 { box-shadow: 0 0 0 2px var(--interactive-accent, #705dcf); }
.nb-map-node.p2 { box-shadow: 0 0 0 2px var(--interactive-accent, #705dcf), 0 0 0 5px rgba(112,93,207,0.45); }
.nb-map-node.p3 { box-shadow: 0 0 0 2px var(--interactive-accent, #705dcf), 0 0 0 5px rgba(112,93,207,0.45), 0 0 0 8px rgba(112,93,207,0.22); }
.nb-map-node.sel { outline: 2px solid var(--text-normal, #222); outline-offset: 2px; }
.nb-map-detail { min-height: 40px; }
.nb-map-card { cursor: default; }
.nb-map-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; margin: 6px 0; }
.nb-map-kv dt { color: var(--text-muted, #777); margin: 0; }
.nb-map-kv dd { margin: 0; }
.nb-map-rate { border: 1px solid var(--background-modifier-border, #ddd); border-radius: 8px;
  padding: 8px 10px; margin: 6px 0; }
.nb-map-rate .nb-map-rv { float: right; font-size: 15px; font-weight: 600; }
.nb-map-lad { display: block; width: 100%; max-width: 340px; height: auto; }
.nb-map-lad .ax { stroke: var(--text-muted, #999); }
.nb-map-lad .band { fill: rgba(46,125,50,0.22); }
.nb-map-lad .tgt { stroke: var(--interactive-accent, #705dcf); stroke-width: 2; }
.nb-map-lad .r { fill: var(--text-normal, #222); }
.nb-map-lad text { font-size: 9px; fill: var(--text-muted, #777); }
.nb-map-spark { width: 120px; height: 30px; }
.nb-map-spark polyline, .nb-map-spark line { fill: none; stroke: var(--text-muted, #777); stroke-width: 1.4; }
.nb-map-spark circle { fill: var(--interactive-accent, #705dcf); }
.nb-map-acc { height: 10px; border-radius: 5px; background: var(--background-secondary, #eee); overflow: hidden; }
.nb-map-accfill { height: 100%; background: var(--interactive-accent, #705dcf); }
.nb-map-need { display: inline-flex; gap: 5px; align-items: center; border: 1px solid var(--background-modifier-border, #ccc);
  border-radius: 10px; padding: 2px 8px; font-size: 12px; cursor: pointer; background: var(--background-primary, #fff); color: var(--text-normal, #222); }
.nb-map-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
.nb-map-dot.s0 { background: #9e9e9e; } .nb-map-dot.s1 { background: #c25e00; } .nb-map-dot.s2 { background: #b8860b; }
.nb-map-dot.s3 { background: #6b8e23; } .nb-map-dot.s4 { background: #2e7d32; } .nb-map-dot.s5 { background: #00695c; }
`;

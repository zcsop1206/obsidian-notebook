/**
 * The study view (SPEC.md, The study view): view type `notebook-study`. A doc is laid out on
 * 800 paper px (a 120 px right margin for marks and ink) and scaled to the view width, at most
 * 1.4x. Each passage is rendered on its own with MarkdownRenderer into `div.sr-passage[data-a]`;
 * anchored list items get `data-a` on their `<li>`; block passages mount through `mountFor`;
 * solutions get no element. Passages render in order in small slices so a long doc never blocks
 * the page; navigation waits only for the passages up to its target.
 *
 * Also here: the header (Library, tabs, Back, Today, Map, Changes, Undo ink), the back stack with
 * scroll restore and a flash on the target, the library (by kind and area, with search), the peek,
 * page ink (S4) and marks (S5) through the seams in host.ts, and re-rendering on content changes.
 * Owned by S3 on docs/study/BOARD.md.
 */
import { ItemView, MarkdownRenderer, TFile, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type { StudyContext } from '../context';
import type { ContentIndex, Passage, StudyDoc } from '../types';
import { MODEL_LABEL } from '../format/parse';
import { mountFor } from '../blocks/index';
import { createInkApi } from '../ink/index';
import type { BlockEnv, BlockHandle, InkApi, Marks, MarksHost, PageInk } from './host';
import { attachMarks } from './marks';
import { openChanges } from './changes';
import { hasStylus, LinkGestures, PEN_CONTROLS } from './gestures';
import {
  displayTitle, docAtPath, docSignature, groupDocs, isUnrendered, itemIndexes, joinTo, metaLine,
  passageIndex, peekParts, shortTitle, splitTo, studyTarget, type StudyTarget,
} from './model';
import { search, snippet } from './search';

export const VIEW_TYPE_STUDY = 'notebook-study';
/** Paper width in px: the text column plus the right margin. */
export const PAPER_W = 800;
export const MARGIN_W = 120;
export const MAX_SCALE = 1.4;
export const MAX_TABS = 6;
const MAX_BACK = 30;
/** Render this long (ms) before yielding to the browser. */
const SLICE_MS = 12;

const LABEL_TEXT = MODEL_LABEL.replace(/^>\s*/, '');

/** One doc's rendered DOM, kept while its tab is open. */
class Rendered {
  count = 0;
  done = false;
  dead = false;
  scroll = 0;
  ms = 0;
  readonly els = new Map<string, HTMLElement>();
  readonly blocks: BlockHandle[] = [];
  ink: PageInk | null = null;
  marks: Marks | null = null;
  /** Page ink and marks attached (once, when first on screen fully rendered). */
  layered = false;
  private waiters: { i: number; resolve: () => void }[] = [];

  constructor(public doc: StudyDoc, public sig: string, readonly root: HTMLElement, readonly margin: HTMLElement, readonly body: HTMLElement) {}

  /** Resolves once the passage at index `i` (and every one before it) is rendered. */
  until(i: number): Promise<void> {
    if (this.done || this.dead || this.count > i) return Promise.resolve();
    return new Promise(resolve => this.waiters.push({ i, resolve }));
  }

  advance(n: number): void {
    this.count = n;
    this.waiters = this.waiters.filter(w => { if (n > w.i) { w.resolve(); return false; } return true; });
  }

  finish(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w.resolve();
  }
}

const yieldNow = () => new Promise<void>(r => window.setTimeout(r, 0));

export class StudyView extends ItemView {
  private tabs: string[] = [];
  private cache = new Map<string, Rendered>();
  private current: Rendered | null = null;
  private backStack: { doc: string; top: number }[] = [];
  private scale = 1;
  private readonly inkApi: InkApi;
  private gestures: LinkGestures | null = null;
  private offs: (() => void)[] = [];
  private relayoutRaf = 0;
  private peekToken = 0;
  private libIndex: ContentIndex | null = null;
  private searchTimer = 0;
  private resize: ResizeObserver | null = null;

  private hdr!: HTMLElement;
  private tabsEl!: HTMLElement;
  private backBtn!: HTMLButtonElement;
  private changesBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private body!: HTMLElement;
  private scroller!: HTMLElement;
  private sizer!: HTMLElement;
  private libEl!: HTMLElement;
  private peekEl!: HTMLElement;

  /** For tests and the debug readout. */
  readonly stats = { renders: 0, passages: 0, lastOpenMs: 0, lastRenderMs: 0, follows: 0, peeks: 0 };

  constructor(leaf: WorkspaceLeaf, private ctx: StudyContext) {
    super(leaf);
    this.navigation = false;
    this.inkApi = createInkApi(ctx);
  }

  getViewType(): string { return VIEW_TYPE_STUDY; }
  getIcon(): string { return 'graduation-cap'; }
  getDisplayText(): string { return this.current ? `Study: ${displayTitle(this.current.doc)}` : 'Study'; }

  /** The doc on screen, or null when the library shows with no doc open. */
  currentDoc(): string | null { return this.current ? this.current.doc.id : null; }
  openTabs(): string[] { return this.tabs.slice(); }
  backDepth(): number { return this.backStack.length; }
  /** The doc on screen has every passage rendered (tests). */
  renderDone(): boolean { return !!this.current && this.current.done; }
  /** The gesture counters (tests). */
  gestureStats(): LinkGestures['stats'] | null { return this.gestures ? this.gestures.stats : null; }

  async onOpen(): Promise<void> {
    const c = this.contentEl;
    c.empty();
    c.addClass('nb-study');
    this.hdr = c.createDiv({ cls: 'nb-study-hdr' });
    const btn = (text: string, act: string, parent: HTMLElement = this.hdr) =>
      parent.createEl('button', { text, cls: 'nb-study-btn', attr: { 'data-act': act, type: 'button' } });
    btn('Library', 'library');
    this.tabsEl = this.hdr.createEl('nav', { cls: 'nb-study-tabs', attr: { 'aria-label': 'Open study docs' } });
    this.backBtn = btn('Back', 'back');
    const tools = this.hdr.createDiv({ cls: 'nb-study-tools' });
    btn('Today', 'today', tools);
    btn('Map', 'map', tools);
    this.changesBtn = btn('Changes', 'changes', tools);
    this.undoBtn = btn('Undo ink', 'undo', tools);
    this.body = c.createDiv({ cls: 'nb-study-body' });
    this.scroller = this.body.createDiv({ cls: 'nb-study-scroll' });
    this.sizer = this.scroller.createDiv({ cls: 'nb-study-sizer' });
    this.libEl = this.body.createDiv({ cls: 'nb-study-lib' });
    this.libEl.hide();
    this.peekEl = this.body.createDiv({ cls: 'nb-study-peek', attr: { role: 'dialog', 'aria-label': 'Peek' } });
    this.peekEl.hide();

    this.registerDomEvent(this.hdr, 'click', e => this.onHeaderClick(e));
    this.registerDomEvent(this.tabsEl, 'click', e => this.onTabsClick(e));
    this.registerDomEvent(this.peekEl, 'click', e => this.onPeekClick(e));
    this.registerDomEvent(this.libEl, 'click', e => this.onLibraryClick(e));
    this.registerDomEvent(this.libEl, 'input', () => this.scheduleSearch());
    this.registerDomEvent(c.ownerDocument, 'keydown', e => this.onKey(e));
    this.gestures = new LinkGestures(c, {
      linkAt: t => this.linkAt(t),
      penWrites: a => !!this.current && this.current.body.contains(a) && !a.closest('.sr-block, .no-ink'),
      follow: a => this.followLink(a),
      peek: a => this.peekLink(a),
      down: e => { if (!this.peekEl.isShown() || !(e.target instanceof Node) || !this.peekEl.contains(e.target)) this.closePeek(); },
    });
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => this.requestRelayout());
      this.resize.observe(this.scroller);
    }
    this.offs.push(this.ctx.onChange(what => { if (what === 'content') void this.onContent(); }));
    this.updateHeader();
    // Kick the index load, so the library and the first doc are ready sooner.
    this.ctx.content();
  }

  async onClose(): Promise<void> {
    for (const off of this.offs.splice(0)) off();
    this.gestures?.destroy();
    this.gestures = null;
    this.resize?.disconnect();
    if (this.relayoutRaf) cancelAnimationFrame(this.relayoutRaf);
    window.clearTimeout(this.searchTimer);
    for (const r of this.cache.values()) this.destroyRendered(r);
    this.cache.clear();
    this.current = null;
  }

  onResize(): void { this.requestRelayout(); }

  getState(): Record<string, unknown> {
    return { doc: this.current ? this.current.doc.id : null, tabs: this.tabs.slice() };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state && typeof state === 'object' ? state : {}) as { doc?: unknown; a?: unknown; tabs?: unknown; library?: unknown };
    if (Array.isArray(s.tabs)) this.tabs = s.tabs.filter((x): x is string => typeof x === 'string').slice(-MAX_TABS);
    if (typeof s.doc === 'string' && s.doc) {
      const a = typeof s.a === 'string' && s.a ? s.a : null;
      await this.navigate(s.doc, a, { push: !!this.current, flash: !!a });
    } else if (s.library === true || !this.current) {
      this.showLibrary();
    }
    await super.setState(state, result);
  }

  /* ------------------------------------------------------------------ content ------------ */

  /** The content index, waiting (up to 4 s) for the first load. */
  private async index(): Promise<ContentIndex> {
    const now = this.ctx.content();
    if (now.docs.size > 0) return now;
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; off(); window.clearTimeout(timer); resolve(this.ctx.content()); };
      const off = this.ctx.onChange(w => { if (w === 'content') finish(); });
      const timer = window.setTimeout(finish, 4000);
    });
  }

  private async onContent(): Promise<void> {
    const idx = this.ctx.content();
    for (const r of [...this.cache.values()]) {
      const nd = idx.docs.get(r.doc.id);
      if (!nd) {
        this.drop(r.doc.id);
        this.tabs = this.tabs.filter(t => t !== r.doc.id);
        if (r === this.current) {
          this.current = null;
          this.ctx.ui.toast(`${displayTitle(r.doc)} is no longer in the study folder.`);
          this.showLibrary();
        }
        continue;
      }
      const sig = docSignature(nd);
      if (sig === r.sig) { r.doc = nd; continue; }
      if (r === this.current) await this.rerenderCurrent(nd);
      else this.drop(r.doc.id);
    }
    this.renderTabs();
    if (this.libEl.isShown()) this.renderLibrary();
  }

  /** Re-render the doc on screen with new content, keeping the passage at the top of the view where it was. */
  private async rerenderCurrent(nd: StudyDoc): Promise<void> {
    const old = this.current;
    if (!old) return;
    const oldBuild = old.doc.build;
    // Render the new DOM off screen, then swap it in whole: no flicker, and the scroll can be
    // restored against the full height.
    const r = this.build(nd);
    await r.until(Infinity);
    const latest = this.ctx.content().docs.get(nd.id);
    if (r.dead || this.current !== old || old.dead || !latest || docSignature(latest) !== r.sig) {
      // Navigated away meanwhile, or a newer change is rendering: that one wins.
      this.destroyRendered(r);
      return;
    }
    const keep = this.topVisible(old);
    this.destroyRendered(old);
    this.cache.set(nd.id, r);
    this.attach(r);
    if (keep) {
      const el = r.els.get(keep.a);
      if (el) this.scroller.scrollTop = Math.max(0, this.contentTop(r, el) - keep.offset);
    }
    if (!r.ink || nd.build === oldBuild) return;
    try {
      const n = r.ink.reanchor();
      if (n.changed || n.orphaned) this.ctx.ui.toast(`${displayTitle(nd)} is now build ${nd.build}: ${n.moved} strokes followed their passages, ${n.changed} sit on changed text, ${n.orphaned} orphaned.`, 6000);
    } catch (e) { console.error('[study] reanchor failed', e); }
  }

  /** The first passage whose bottom is below the top of the view, and its offset from that top. */
  private topVisible(r: Rendered): { a: string; offset: number } | null {
    const top = this.scroller.getBoundingClientRect().top;
    for (const p of r.doc.passages) {
      const el = r.els.get(p.anchor);
      if (!el || !el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > top) return { a: p.anchor, offset: rect.top - top };
    }
    return null;
  }

  /* ------------------------------------------------------------------ navigation --------- */

  /**
   * Open a doc, at an anchor if given: pushes the doc on screen to the back stack (`push`), waits
   * until the target is rendered, scrolls it near the top and flashes it (`flash`).
   */
  async navigate(docId: string, anchor: string | null, opts: { push?: boolean; flash?: boolean } = {}): Promise<boolean> {
    const t0 = performance.now();
    const idx = await this.index();
    const doc = idx.docs.get(docId);
    if (!doc) { this.ctx.ui.toast(`No study doc "${docId}" in ${this.ctx.settings().root}/.`); return false; }
    if (opts.push !== false && this.current) {
      this.backStack.push({ doc: this.current.doc.id, top: this.scroller.scrollTop });
      if (this.backStack.length > MAX_BACK) this.backStack.shift();
    }
    this.closePeek();
    const r = this.show(docId, doc);
    if (!anchor) {
      this.scroller.scrollTop = 0;
      this.stats.lastOpenMs = performance.now() - t0;
      this.updateHeader();
      return true;
    }
    const i = passageIndex(doc, anchor);
    if (i < 0) {
      this.scroller.scrollTop = 0;
      this.ctx.ui.toast(`#${anchor} is not in build ${doc.build} of ${displayTitle(doc)}.`);
      this.updateHeader();
      return true;
    }
    await r.until(i);
    if (r !== this.current) return true;
    this.scrollToAnchor(r, anchor, opts.flash !== false);
    this.stats.lastOpenMs = performance.now() - t0;
    this.updateHeader();
    return true;
  }

  /** Follow a link from the doc on screen (back stack, flash). */
  async follow(docId: string, anchor: string | null): Promise<boolean> {
    this.stats.follows++;
    return this.navigate(docId, anchor, { push: true, flash: true });
  }

  /** Pop the back stack: the doc comes back at the scroll position it was left at. */
  async back(): Promise<void> {
    const b = this.backStack.pop();
    this.updateHeader();
    if (!b) return;
    const idx = await this.index();
    const doc = idx.docs.get(b.doc);
    if (!doc) { this.ctx.ui.toast('That doc is no longer in the study folder.'); return; }
    this.closePeek();
    const r = this.show(b.doc, doc);
    await r.until(Infinity);
    if (r !== this.current) return;
    this.updateSize();
    this.scroller.scrollTop = b.top;
    this.updateHeader();
  }

  private scrollToAnchor(r: Rendered, anchor: string, flash: boolean): void {
    this.updateSize();
    const el = r.els.get(anchor);
    if (!el || !el.isConnected) { this.scroller.scrollTop = 0; return; }
    this.scroller.scrollTop = Math.max(0, this.contentTop(r, el) - 16);
    if (flash) {
      el.removeClass('sr-flash');
      void el.offsetWidth;
      el.addClass('sr-flash');
      window.setTimeout(() => el.removeClass('sr-flash'), 1800);
    }
  }

  /** An element's top in the scroller's content, in screen px. */
  private contentTop(r: Rendered, el: HTMLElement): number {
    return el.getBoundingClientRect().top - r.root.getBoundingClientRect().top;
  }

  /** Put a doc on screen (rendering it if needed) without touching the back stack. */
  private show(docId: string, doc: StudyDoc): Rendered {
    let r = this.cache.get(docId);
    if (r && r.sig !== docSignature(doc)) { this.drop(docId); r = undefined; }
    if (!r) { r = this.build(doc); this.cache.set(docId, r); }
    else r.doc = doc;
    this.ensureTab(docId);
    if (this.current !== r) this.attach(r);
    this.libEl.hide();
    this.renderTabs();
    return r;
  }

  private attach(r: Rendered): void {
    if (this.current && this.current !== r) {
      this.current.scroll = this.scroller.scrollTop;
      this.current.root.detach();
    }
    this.current = r;
    this.sizer.empty();
    this.sizer.appendChild(r.root);
    this.resize?.observe(r.root);
    this.updateSize();
    if (r.done) this.attachLayers(r);
    this.updateHeader();
  }

  private ensureTab(id: string): void {
    if (this.tabs.includes(id)) return;
    this.tabs.push(id);
    while (this.tabs.length > MAX_TABS) {
      const k = this.tabs[0] === id ? 1 : 0;
      const [gone] = this.tabs.splice(k, 1);
      if (gone !== this.current?.doc.id) this.drop(gone);
    }
  }

  private drop(id: string): void {
    const r = this.cache.get(id);
    if (!r) return;
    this.cache.delete(id);
    this.destroyRendered(r);
    if (this.current === r) this.current = null;
  }

  /* ------------------------------------------------------------------ rendering ---------- */

  private build(doc: StudyDoc): Rendered {
    const root = createDiv({ cls: 'nb-study-doc', attr: { 'data-doc': doc.id } });
    const margin = root.createDiv({ cls: 'nb-study-margin' });
    const head = root.createDiv({ cls: 'sr-dochead' });
    head.createEl('h1', { cls: 'sr-title', text: displayTitle(doc) });
    head.createDiv({ cls: 'sr-meta', text: metaLine(doc) });
    if (doc.by === 'model' && !doc.labelled) head.createDiv({ cls: 'sr-label', text: LABEL_TEXT });
    const body = root.createDiv({ cls: 'nb-study-passages' });
    // On the root itself (not registered): they go with it when the doc is dropped.
    root.addEventListener('touchstart', e => this.blockStylus(e), { passive: false });
    root.addEventListener('touchmove', e => this.blockStylus(e), { passive: false });
    const r = new Rendered(doc, docSignature(doc), root, margin, body);
    this.stats.renders++;
    void this.renderAll(r);
    return r;
  }

  /** The Pencil writes on the page: a stylus touch there never scrolls or selects (controls excepted). */
  private blockStylus(e: TouchEvent): void {
    if (!hasStylus(e)) return;
    const el = e.target as Element | null;
    if (el && typeof el.closest === 'function' && el.closest(PEN_CONTROLS)) return;
    e.preventDefault();
  }

  private async renderAll(r: Rendered): Promise<void> {
    const t0 = performance.now();
    let slice = t0;
    const ps = r.doc.passages;
    for (let i = 0; i < ps.length; i++) {
      if (r.dead) return;
      try { await this.renderPassage(r, ps[i]); }
      catch (e) { console.error('[study] passage failed to render', ps[i].anchor, e); }
      r.advance(i + 1);
      if (performance.now() - slice > SLICE_MS) {
        await yieldNow();
        slice = performance.now();
        if (r === this.current) this.updateSize();
      }
    }
    if (r.dead) return;
    r.ms = this.stats.lastRenderMs = performance.now() - t0;
    r.finish();
    if (r === this.current) { this.updateSize(); this.attachLayers(r); }
  }

  private async renderPassage(r: Rendered, p: Passage): Promise<void> {
    const doc = r.doc;
    if (isUnrendered(doc, p)) return;
    const el = r.body.createDiv({ cls: `sr-passage sr-k-${p.kind}`, attr: { 'data-a': p.anchor } });
    if (p.callout) el.addClass(`sr-c-${p.callout.type}`);
    r.els.set(p.anchor, el);
    this.stats.passages++;
    if (p.kind === 'label') {
      el.addClass('sr-label');
      el.setText(LABEL_TEXT);
      return;
    }
    if (p.block) {
      el.addClass('sr-block');
      el.setAttribute('data-block', p.block.type);
      const mount = mountFor(p.block);
      if (!mount) return;
      try { r.blocks.push(mount(el, this.blockEnv(r, p))); }
      catch (e) {
        console.error('[study] block failed to mount', p.anchor, e);
        el.createDiv({ cls: 'sr-block-error', text: `This ${p.block.type} block failed to load.` });
      }
      return;
    }
    await MarkdownRenderer.render(this.app, p.markdown, el, doc.path, this);
    if (r.dead) return;
    this.decorateLinks(doc, el);
    if (p.items && p.items.length) {
      const list = Array.from(el.querySelectorAll('ul, ol')).find(l => !l.parentElement || !l.parentElement.closest('ul, ol'));
      const lis = list ? Array.from(list.children).filter(c => c.tagName === 'LI') as HTMLElement[] : [];
      for (const [a, k] of itemIndexes(p)) {
        const li = lis[k];
        if (!li) continue;
        li.setAttribute('data-a', a);
        li.addClass('sr-item');
        r.els.set(a, li);
      }
    }
  }

  /** Page ink (S4) and marks (S5), once every passage is on the page. */
  private attachLayers(r: Rendered): void {
    if (r.layered || r.dead) return;
    r.layered = true;
    try { r.ink = this.inkApi.page(r.doc, r.root, a => this.passageTop(r, a)); }
    catch (e) { console.error('[study] page ink failed', e); }
    const host: MarksHost = {
      ctx: this.ctx,
      doc: () => r.doc,
      passageEl: a => r.els.get(a) ?? null,
      margin: r.margin,
      ink: this.inkApi,
      open: (d, a) => void this.follow(d, a ?? null),
      toast: (m, ms) => this.ctx.ui.toast(m, ms),
      relayout: () => this.requestRelayout(),
      rerender: () => void this.rerender(r.doc.id),
    };
    try { r.marks = attachMarks(host); }
    catch (e) { console.error('[study] marks failed', e); }
  }

  /** Render a doc again from the current index (marks call this after a build changes). */
  async rerender(docId: string): Promise<void> {
    const nd = this.ctx.content().docs.get(docId);
    if (!nd) return;
    if (this.current && this.current.doc.id === docId) await this.rerenderCurrent(nd);
    else this.drop(docId);
  }

  private blockEnv(r: Rendered, p: Passage): BlockEnv {
    return {
      ctx: this.ctx,
      doc: r.doc,
      passage: p,
      ink: this.inkApi,
      open: (d, a) => void this.follow(d, a ?? null),
      peek: (d, a) => void this.openPeek({ doc: d, anchor: a }),
      relayout: () => this.requestRelayout(),
      toast: (m, ms) => this.ctx.ui.toast(m, ms),
      render: async (md, into) => {
        await MarkdownRenderer.render(this.app, md, into, r.doc.path, this);
        this.decorateLinks(r.doc, into);
      },
    };
  }

  /** Mark the links the view follows itself: `data-study-to="doc#anchor"` on links into study docs. */
  private decorateLinks(doc: StudyDoc, el: HTMLElement): void {
    const idx = this.ctx.content();
    el.querySelectorAll('a').forEach(a => {
      a.setAttribute('draggable', 'false');
      // The view follows links itself (gestures.ts). A click must never navigate the web view,
      // even one that lands after the link left the DOM (a peek closing under the finger).
      a.addEventListener('click', e => e.preventDefault());
      a.setAttribute('data-study-src', doc.path);
      if (a.classList.contains('external-link')) return;
      const href = a.getAttribute('data-href') ?? a.getAttribute('href');
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      let t = studyTarget(idx, doc, href);
      if (!t) {
        // Obsidian may resolve a link our relative reading missed (e.g. a shortest-path link).
        const hash = href.indexOf('#');
        const path = hash >= 0 ? href.slice(0, hash) : href;
        const f = path ? this.app.metadataCache.getFirstLinkpathDest(decodeSafe(path), doc.path) : null;
        const id = f ? docAtPath(idx, f.path) : null;
        if (id) {
          const frag = hash >= 0 ? decodeSafe(href.slice(hash + 1)) : '';
          t = { doc: id, anchor: frag.startsWith('^') ? frag.slice(1) : frag ? `h-${frag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : null };
        }
      }
      if (t) { a.setAttribute('data-study-to', joinTo(t)); a.addClass('sr-ref'); }
    });
  }

  private destroyRendered(r: Rendered): void {
    r.dead = true;
    r.finish();
    for (const b of r.blocks.splice(0)) { try { b.destroy(); } catch (e) { console.error('[study] block destroy failed', e); } }
    try { r.ink?.destroy(); } catch (e) { console.error('[study] ink destroy failed', e); }
    try { r.marks?.destroy(); } catch (e) { console.error('[study] marks destroy failed', e); }
    r.ink = null;
    r.marks = null;
    this.resize?.unobserve(r.root);
    r.root.remove();
  }

  /* ------------------------------------------------------------------ layout ------------- */

  /** A passage's (or anchored item's) top in paper px from the top of the doc, or null when it is not on the page. */
  passageTop(r: Rendered, anchor: string): number | null {
    const el = r.els.get(anchor);
    if (!el || !el.isConnected || !el.getClientRects().length) return null;
    return (el.getBoundingClientRect().top - r.root.getBoundingClientRect().top) / (this.scale || 1);
  }

  private requestRelayout(): void {
    if (this.relayoutRaf) return;
    this.relayoutRaf = requestAnimationFrame(() => { this.relayoutRaf = 0; this.relayout(); });
  }

  private relayout(): void {
    this.updateSize();
    const r = this.current;
    if (!r || !r.done) return;
    try { r.ink?.relayout(); } catch (e) { console.error('[study] ink relayout failed', e); }
    try { r.marks?.refresh(); } catch (e) { console.error('[study] marks refresh failed', e); }
  }

  /** Scale the paper to the view width (at most MAX_SCALE) and size the scroll area to it. */
  private updateSize(): void {
    if (!this.scroller) return;
    const w = this.scroller.clientWidth;
    this.contentEl.toggleClass('is-narrow', this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < 600);
    if (!w) return;
    const s = Math.max(0.2, Math.min(MAX_SCALE, w / PAPER_W));
    this.scale = s;
    const r = this.current;
    if (!r) { this.sizer.style.height = '0px'; return; }
    r.root.style.transform = `scale(${s})`;
    this.sizer.style.width = `${Math.floor(PAPER_W * s)}px`;
    this.sizer.style.height = `${Math.ceil(r.root.offsetHeight * s)}px`;
  }

  /* ------------------------------------------------------------------ header and tabs ---- */

  private onHeaderClick(e: MouseEvent): void {
    const b = (e.target as Element | null)?.closest?.('[data-act]');
    if (!b || this.tabsEl.contains(b)) return;
    switch (b.getAttribute('data-act')) {
      case 'library':
        if (this.libEl.isShown() && this.current) this.libEl.hide();
        else this.showLibrary();
        break;
      case 'back': void this.back(); break;
      case 'today': void this.ctx.ui.openToday(); break;
      case 'map': void this.ctx.ui.openMap(); break;
      case 'changes': if (this.current) void openChanges(this.ctx, this.current.doc.id); break;
      case 'undo': {
        const s = this.current?.ink?.undo() ?? null;
        if (!s) this.ctx.ui.toast('No ink of yours to undo on this doc.');
        break;
      }
    }
  }

  private updateHeader(): void {
    if (!this.backBtn) return;
    const n = this.backStack.length;
    this.backBtn.disabled = n === 0;
    this.backBtn.setText(n > 1 ? `Back (${n})` : 'Back');
    this.changesBtn.disabled = !this.current;
    this.undoBtn.disabled = !this.current;
  }

  private renderTabs(): void {
    if (!this.tabsEl) return;
    const idx = this.ctx.content();
    this.tabsEl.empty();
    for (const id of this.tabs) {
      const doc = idx.docs.get(id) ?? this.cache.get(id)?.doc;
      const tab = this.tabsEl.createDiv({ cls: 'nb-study-tab', attr: { 'data-tab': id } });
      if (this.current && this.current.doc.id === id) tab.addClass('is-active');
      tab.createEl('button', { cls: 'nb-study-tab-open', text: doc ? shortTitle(doc) : id, attr: { type: 'button', 'data-open-tab': id, title: doc ? displayTitle(doc) : id } });
      if (this.tabs.length > 1) tab.createEl('button', { cls: 'nb-study-tab-close', text: '×', attr: { type: 'button', 'data-close-tab': id, 'aria-label': `Close ${doc ? displayTitle(doc) : id}` } });
    }
    // Keep the active tab in view; moves only the strip, never the page.
    const on = this.tabsEl.querySelector<HTMLElement>('.nb-study-tab.is-active');
    if (on && this.tabsEl.scrollWidth > this.tabsEl.clientWidth) {
      const tr = this.tabsEl.getBoundingClientRect(), ar = on.getBoundingClientRect();
      if (ar.right > tr.right) this.tabsEl.scrollLeft += ar.right - tr.right + 8;
      else if (ar.left < tr.left) this.tabsEl.scrollLeft -= tr.left - ar.left + 8;
    }
  }

  private onTabsClick(e: MouseEvent): void {
    const t = e.target as Element | null;
    const close = t?.closest?.('[data-close-tab]');
    if (close) {
      const id = close.getAttribute('data-close-tab')!;
      const i = this.tabs.indexOf(id);
      if (i < 0 || this.tabs.length < 2) return;
      this.tabs.splice(i, 1);
      const wasCurrent = this.current?.doc.id === id;
      this.drop(id);
      if (wasCurrent) void this.switchTab(this.tabs[Math.max(0, i - 1)]);
      else this.renderTabs();
      return;
    }
    const open = t?.closest?.('[data-open-tab]');
    if (open) void this.switchTab(open.getAttribute('data-open-tab')!);
  }

  /** Show a tab's doc where it was left. */
  async switchTab(id: string): Promise<void> {
    if (this.current?.doc.id === id && !this.libEl.isShown()) return;
    const idx = await this.index();
    const doc = idx.docs.get(id);
    if (!doc) { this.tabs = this.tabs.filter(t => t !== id); this.renderTabs(); return; }
    this.closePeek();
    const r = this.show(id, doc);
    const top = r.scroll;
    if (top > 0) await r.until(Infinity);
    if (r !== this.current) return;
    this.updateSize();
    this.scroller.scrollTop = top;
  }

  /* ------------------------------------------------------------------ library ------------ */

  showLibrary(): void {
    this.closePeek();
    this.libEl.show();
    this.renderLibrary();
    this.ctx.content();
  }

  private renderLibrary(): void {
    const idx = this.ctx.content();
    let input = this.libEl.querySelector<HTMLInputElement>('input.nb-study-search');
    if (!input) {
      this.libEl.empty();
      const head = this.libEl.createDiv({ cls: 'nb-study-lib-head' });
      head.createEl('h2', { text: 'Library' });
      head.createEl('button', { cls: 'nb-study-btn nb-study-lib-close', text: 'Close', attr: { type: 'button', 'data-lib-close': '' } });
      input = this.libEl.createEl('input', { cls: 'nb-study-search', type: 'search', attr: { placeholder: 'Search titles and passages', 'aria-label': 'Search study docs', autocomplete: 'off', spellcheck: 'false' } });
      this.libEl.createDiv({ cls: 'nb-study-results' });
      this.libEl.createDiv({ cls: 'nb-study-groups' });
    }
    const closeBtn = this.libEl.querySelector<HTMLElement>('.nb-study-lib-close');
    if (closeBtn) closeBtn.toggleClass('is-hidden', !this.current);
    this.renderResults();
    if (this.libIndex === idx && this.libEl.querySelector('.nb-study-groups')!.childElementCount) return;
    this.libIndex = idx;
    const box = this.libEl.querySelector<HTMLElement>('.nb-study-groups')!;
    box.empty();
    const groups = groupDocs(idx.docs.values());
    if (!groups.length) {
      box.createEl('p', { cls: 'nb-study-hint', text: `No study docs in ${this.ctx.settings().root}/ yet. The study folder is set in Settings, Notebook, Study mode.` });
      return;
    }
    for (const g of groups) {
      const kind = box.createDiv({ cls: 'nb-study-kind', attr: { 'data-kind': g.kind } });
      kind.createEl('h3', { text: g.label });
      for (const a of g.areas) {
        const area = kind.createDiv({ cls: 'nb-study-area', attr: { 'data-area': a.area } });
        area.createEl('h4', { text: a.label });
        for (const d of a.docs) {
          const row = area.createEl('button', { cls: 'nb-study-row', attr: { type: 'button', 'data-open': d.id } });
          row.createSpan({ cls: 'nb-study-row-title', text: displayTitle(d) });
          const n = d.passages.filter(p => p.kind !== 'label' && p.kind !== 'rule').length;
          row.createSpan({ cls: 'nb-study-row-meta', text: `build ${d.build} · ${n} passages` });
        }
      }
    }
  }

  private scheduleSearch(): void {
    window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => this.renderResults(), 120);
  }

  private renderResults(): void {
    const input = this.libEl.querySelector<HTMLInputElement>('input.nb-study-search');
    const box = this.libEl.querySelector<HTMLElement>('.nb-study-results');
    if (!input || !box) return;
    box.empty();
    const q = input.value.trim();
    if (q.length < 2) return;
    const idx = this.ctx.content();
    const hits = search(idx, q);
    if (!hits.length) { box.createEl('p', { cls: 'nb-study-hint', text: 'No matches.' }); return; }
    box.createDiv({ cls: 'nb-study-kick', text: `${hits.length}${hits.length >= 40 ? '+' : ''} ${hits.length === 1 ? 'match' : 'matches'}` });
    for (const h of hits) {
      const d = idx.docs.get(h.doc);
      const row = box.createEl('button', { cls: 'nb-study-hit', attr: { type: 'button', 'data-open': joinTo({ doc: h.doc, anchor: h.a }) } });
      row.createSpan({ cls: 'nb-study-row-title', text: d ? displayTitle(d) : h.doc });
      if (h.a) row.createEl('code', { text: `#${h.a}` });
      row.createSpan({ cls: 'nb-study-hit-text', text: snippet(h.text, q) });
    }
  }

  private onLibraryClick(e: MouseEvent): void {
    const t = e.target as Element | null;
    if (t?.closest?.('[data-lib-close]')) { if (this.current) this.libEl.hide(); return; }
    const row = t?.closest?.('[data-open]');
    if (!row) return;
    const to = splitTo(row.getAttribute('data-open')!);
    void this.navigate(to.doc, to.anchor, { push: true, flash: !!to.anchor });
  }

  /* ------------------------------------------------------------------ links and peek ----- */

  private linkAt(target: EventTarget | null): HTMLElement | null {
    const el = target as Element | null;
    if (!el || typeof el.closest !== 'function') return null;
    const a = el.closest('a') as HTMLElement | null;
    if (!a || !this.contentEl.contains(a) || this.hdr.contains(a) || this.libEl.contains(a)) return null;
    return a;
  }

  private followLink(a: HTMLElement): void {
    const to = a.getAttribute('data-study-to');
    if (to) {
      const t = splitTo(to);
      this.closePeek();
      void this.follow(t.doc, t.anchor);
      return;
    }
    const href = a.getAttribute('href') ?? '';
    if (a.classList.contains('external-link') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (href) window.open(href, '_blank');
      return;
    }
    const dh = a.getAttribute('data-href') ?? href;
    const src = a.getAttribute('data-study-src') ?? '';
    if (!dh) return;
    const path = dh.split('#')[0];
    const dest = path ? this.app.metadataCache.getFirstLinkpathDest(decodeSafe(path), src) : null;
    if (!(dest instanceof TFile)) { this.ctx.ui.toast(`Nothing in the vault at ${dh}.`); return; }
    void this.app.workspace.openLinkText(dh, src, 'tab');
  }

  private peekLink(a: HTMLElement): void {
    const to = a.getAttribute('data-study-to');
    if (!to) return;
    void this.openPeek(splitTo(to));
  }

  /** The peek: the target passage rendered, never a fogged proof, a solution or a hidden kata's topic. */
  async openPeek(t: StudyTarget): Promise<void> {
    const doc = this.ctx.content().docs.get(t.doc);
    if (!doc) { this.ctx.ui.toast(`No study doc "${t.doc}".`); return; }
    const token = ++this.peekToken;
    this.stats.peeks++;
    const box = this.peekEl;
    box.empty();
    box.setAttribute('data-to', joinTo(t));
    const head = box.createDiv({ cls: 'nb-study-peek-head' });
    head.createSpan({ cls: 'nb-study-peek-title', text: `Peek · ${displayTitle(doc)}` });
    if (t.anchor) head.createEl('code', { text: `#${t.anchor}` });
    head.createEl('button', { cls: 'nb-study-btn', text: 'Open', attr: { type: 'button', 'data-peek-open': '' } });
    head.createEl('button', { cls: 'nb-study-btn', text: '×', attr: { type: 'button', 'data-peek-close': '', 'aria-label': 'Close the peek' } });
    const body = box.createDiv({ cls: 'nb-study-peek-body' });
    box.show();
    for (const part of peekParts(doc, t.anchor)) {
      if (token !== this.peekToken) return;
      if (part.placeholder) { body.createDiv({ cls: 'nb-study-peek-ph', text: part.placeholder }); continue; }
      const el = body.createDiv({ cls: 'sr-peek-passage' });
      await MarkdownRenderer.render(this.app, part.markdown ?? '', el, doc.path, this);
      this.decorateLinks(doc, el);
    }
  }

  closePeek(): void {
    if (!this.peekEl || !this.peekEl.isShown()) return;
    this.peekToken++;
    this.peekEl.hide();
    this.peekEl.empty();
  }

  private onPeekClick(e: MouseEvent): void {
    const t = e.target as Element | null;
    if (t?.closest?.('[data-peek-close]')) { this.closePeek(); return; }
    if (t?.closest?.('[data-peek-open]')) {
      const to = splitTo(this.peekEl.getAttribute('data-to') ?? '');
      this.closePeek();
      void this.follow(to.doc, to.anchor);
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || this.app.workspace.getActiveViewOfType(StudyView) !== this) return;
    if (this.peekEl.isShown()) { this.closePeek(); e.preventDefault(); return; }
    if (this.libEl.isShown() && this.current) { this.libEl.hide(); e.preventDefault(); }
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

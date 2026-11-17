/**
 * Margin marks and the triage UI (SPEC.md, Marks and triage; Decision 6). Owned by S5 on
 * docs/study/BOARD.md. Ported from the demo's reader.js marks code (lab/study-reader), adapted to
 * the plugin's interfaces: dots are buttons in `host.margin`, mark state comes from
 * `engine.marks()` (the engine folds `mark` events), `engine.triage` doubles as the recheck call,
 * and rewrites/rebuilds are requests the laptop answers — so `rebuild-basic` and `eligible` log
 * `rebuild-request` / `rewrite-request` events after a two-tap confirm instead of switching builds.
 */

import type { InkSurface, Marks, MarksHost, PageInk } from './host';
import type { MarkVerb, Passage, StudyDoc, TriageAction } from '../types';

const REWRITE_MAX = 3; // rewrites per build cycle (SPEC.md, Decision 6)
const ATTEMPT_DEBOUNCE_MS = 2000;
const TWO_TAP_MS = 3500;
const DEFAULT_ATTEMPT_H = 220;
const MORE_PAPER_STEP = 176;

/** Passage kinds that carry no margin dot. */
const UNMARKABLE = new Set(['label', 'rule']);

/** What the UI tracks for one anchor. `action` is the last triage result. */
interface MarkUi {
  anchor: string;
  verb: MarkVerb;
  action: TriageAction | null;
  /** `rebuild-basic` was confirmed and `rebuild-request` events logged. */
  confirmed: boolean;
  /** Attempt box height in paper px ("More paper" grows it). */
  attemptH: number;
  scaffold: Scaffold | null;
}

interface Scaffold {
  el: HTMLElement;
  surface: InkSurface | null;
  /** debounce timer for the `attempt` event log. */
  timer: number | null;
  destroy(): void;
}

interface PendingReq {
  doc: string;
  a: string;
  kind: 'rewrite' | 'rebuild';
  build: number;
}

function titleOf(host: MarksHost, id: string): string {
  return host.ctx.content().docs.get(id)?.title || id;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

/** The first tap arms a button (armed class + armedText), the second within `ms` runs `fn`. */
function twoTap(btn: HTMLButtonElement, armedText: string, fn: () => void, ms = TWO_TAP_MS): void {
  let timer = 0;
  const orig = btn.textContent || '';
  const disarm = () => {
    timer = 0;
    btn.classList.remove('armed');
    btn.textContent = orig;
  };
  btn.addEventListener('click', () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = armedText;
      timer = window.setTimeout(disarm, ms);
      return;
    }
    window.clearTimeout(timer);
    disarm();
    fn();
  });
}

/** Injected once (styles.css is another ticket's file); removed when the last marks UI detaches. */
const STYLE_ID = 'nb-st-marks-css';
let styleUsers = 0;
const CSS = `
.nb-st-margin { position: absolute; top: 0; right: 0; width: 116px; }
.nb-st-dot { position: absolute; right: 8px; min-width: 20px; height: 20px; padding: 0 6px;
  border-radius: 10px; border: 1px solid var(--background-modifier-border, #ccc);
  background: var(--background-secondary, #eee); color: var(--text-muted, #777);
  font-size: 11px; line-height: 18px; cursor: pointer; white-space: nowrap; }
.nb-st-dot:hover { border-color: var(--text-muted, #999); }
.nb-st-dot.on { font-weight: 600; }
.nb-st-dot.on.lost, .nb-st-dot.on.struggling { background: var(--text-error, #c33); border-color: transparent; color: #fff; }
.nb-st-dot.on.eligible { background: #b8860b; border-color: transparent; color: #fff; }
.nb-st-dot.on.exhausted { background: var(--text-muted, #777); border-color: transparent; color: #fff; }
.nb-st-dot.on.requested, .nb-st-dot.on.rebuilt { background: var(--interactive-accent, #705dcf); border-color: transparent; color: #fff; }
.nb-st-dot.on.easy { background: #2e7d32; border-color: transparent; color: #fff; }
.nb-st-dot.on.forgot { background: #c25e00; border-color: transparent; color: #fff; }
.nb-st-menu { position: absolute; right: 8px; z-index: 30; display: flex; gap: 4px; padding: 6px;
  background: var(--background-primary, #fff); border: 1px solid var(--background-modifier-border, #ccc);
  border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.18); }
.nb-st-menu button { font-size: 12px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--background-modifier-border, #ccc); background: var(--background-secondary, #eee); color: var(--text-normal, #222); }
.nb-st-menu button.lost { border-color: var(--text-error, #c33); }
.nb-st-scaffold { margin: 10px 0; padding: 10px 12px; border: 1px solid var(--background-modifier-border, #ccc);
  border-radius: 8px; background: var(--background-secondary, #f6f5f2); }
.nb-st-scaffold .nb-st-kick { display: block; font-weight: 600; font-size: 13px; margin-bottom: 2px; }
.nb-st-hint { color: var(--text-muted, #777); font-size: 12px; }
.nb-st-sc-banner { padding: 6px 8px; margin: 6px 0; border-left: 3px solid var(--interactive-accent, #705dcf); font-size: 13px; }
.nb-st-sc-basics { margin: 6px 0; font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.nb-st-basiclink { cursor: pointer; color: var(--text-accent, #705dcf); border: 0; background: none; padding: 2px 4px; font-size: 13px; }
.nb-st-stage { display: inline-block; font-size: 11px; border-radius: 8px; padding: 1px 6px; color: #fff; vertical-align: middle; }
.nb-st-stage.s0 { background: #9e9e9e; } .nb-st-stage.s1 { background: #c25e00; } .nb-st-stage.s2 { background: #b8860b; }
.nb-st-stage.s3 { background: #6b8e23; } .nb-st-stage.s4 { background: #2e7d32; } .nb-st-stage.s5 { background: #00695c; }
.nb-st-sc-att { margin-top: 8px; }
.nb-st-sc-lab { font-size: 12px; color: var(--text-muted, #777); margin-bottom: 4px; }
.nb-st-sc-ink { border: 1px dashed var(--background-modifier-border, #bbb); border-radius: 6px;
  background: var(--background-primary, #fff); }
.nb-st-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.nb-st-row .nb-st-sp { flex: 1; }
.nb-st-row button { font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--background-modifier-border, #ccc); background: var(--background-primary, #fff); color: var(--text-normal, #222); }
.nb-st-row button.primary { background: var(--interactive-accent, #705dcf); border-color: transparent; color: var(--text-on-accent, #fff); }
.nb-st-row button.armed { outline: 2px solid var(--text-error, #c33); }
.nb-st-sc-status { margin-top: 6px; }
`;

/**
 * Attaches the margin-mark UI for one rendered doc. The host (the study view, S3) re-renders the
 * doc and calls `refresh()` after layout changes; everything else (verbs, triage, scaffolds,
 * request logging, rebuild-landing) is driven from here.
 */
export function attachMarks(host: MarksHost): Marks {
  styleUsers++;
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const margin = host.margin;
  margin.classList.add('nb-st-margin');

  const ui = new Map<string, MarkUi>();
  const dots = new Map<string, HTMLButtonElement>();
  let menu: { el: HTMLElement; anchor: string } | null = null;
  let destroyed = false;
  /** Pending requests seen last recheck, to spot a rebuild landing. */
  let prevPending = new Map<string, PendingReq>();
  /** The build this attach saw; a change means the doc was rebuilt or rewritten. */
  let lastBuild = host.doc().build;

  /* ---------------- helpers ---------------- */

  function engine() {
    try {
      return host.ctx.engine();
    } catch (e) {
      console.error('[study marks] engine()', e);
      return null;
    }
  }
  function call<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      console.error('[study marks]', e);
      return fallback;
    }
  }
  function doc(): StudyDoc {
    return host.doc();
  }
  /** The view's page ink, if the host exposes it (S4 lands it later). Used for the rebuild toast. */
  function pageInk(): PageInk | null {
    const h = host as MarksHost & { pageInk?: PageInk | (() => PageInk | null) };
    const pi = h.pageInk;
    if (typeof pi === 'function') return pi();
    return pi ?? null;
  }
  function markable(): { anchor: string; item: boolean }[] {
    const out: { anchor: string; item: boolean }[] = [];
    for (const p of doc().passages) {
      if (!UNMARKABLE.has(p.kind) && !p.block) out.push({ anchor: p.anchor, item: false });
      if (p.items) for (const it of p.items) out.push({ anchor: it.anchor, item: true });
    }
    return out;
  }
  /** Top of `el` in paper px relative to the margin. Rects are scaled; the element's own scale converts. */
  function topOf(el: HTMLElement): number | null {
    if (!el.getClientRects().length) return null;
    const er = el.getBoundingClientRect();
    const mr = margin.getBoundingClientRect();
    const scale = el.offsetHeight > 0 ? er.height / el.offsetHeight : 1;
    return (er.top - mr.top) / (scale || 1);
  }
  function openMarks(): Map<string, { verb: MarkVerb; t: string }> {
    const e = engine();
    const out = new Map<string, { verb: MarkVerb; t: string }>();
    if (!e) return out;
    for (const m of call(() => e.marks(doc().id), [] as { doc: string; a: string; verb: MarkVerb; t: string; build: number }[])) {
      if (m.verb !== 'clear') out.set(m.a, { verb: m.verb, t: m.t });
    }
    return out;
  }
  function pending(): Map<string, PendingReq> {
    const e = engine();
    const out = new Map<string, PendingReq>();
    if (!e) return out;
    for (const r of call(() => e.pendingRequests(), [] as PendingReq[])) {
      out.set(`${r.doc}|${r.a}|${r.kind}`, r);
    }
    return out;
  }
  function budget(): { left: number; used: number } {
    const e = engine();
    return e ? call(() => e.budget(doc().id), { left: REWRITE_MAX, used: 0 }) : { left: REWRITE_MAX, used: 0 };
  }
  /** Whether a rebuild request names this doc's `anchor`: bare on this doc, `<doc>#<anchor>` on a linked basic. */
  function rebuildAnchorMatches(r: PendingReq, anchor: string): boolean {
    const d = doc().id;
    return r.doc === d ? r.a === anchor : r.a === `${d}#${anchor}`;
  }
  function attemptCount(anchor: string): number {
    const sc = ui.get(anchor)?.scaffold;
    return sc?.surface ? sc.surface.count() : 0;
  }
  /** The first derive prompt of a basic, for "Drill <basic> instead". */
  function firstDerive(basic: string): string | null {
    const d = host.ctx.content().docs.get(basic);
    return d && d.derives.length ? d.derives[0].anchor : null;
  }

  /* ---------------- dots ---------------- */

  function labelFor(u: MarkUi | undefined, isHeading: boolean): string {
    if (!u) return isHeading ? 'mark' : '';
    if (u.verb !== 'lost') return u.verb;
    const a = u.action?.action;
    switch (a) {
      case 'eligible': return 'rewrite ready';
      case 'budget-exhausted': return 'lost, no rewrites';
      case 'requested': return 'requested';
      case 'rebuild-basic': return u.confirmed ? 'rebuild asked' : 'lost';
      default: return 'lost';
    }
  }
  function clsFor(u: MarkUi | undefined): string {
    if (!u) return '';
    if (u.verb !== 'lost') return u.verb;
    const a = u.action?.action;
    if (a === 'requested' || (a === 'rebuild-basic' && u.confirmed)) return 'requested';
    if (a === 'budget-exhausted') return 'exhausted';
    if (a === 'eligible') return 'eligible';
    if (a === 'scaffold') return 'struggling';
    return 'lost';
  }

  function placeDots(): void {
    const anchors = markable();
    const seen = new Set<string>();
    const items: { anchor: string; el: HTMLElement; top: number; heading: boolean }[] = [];
    for (const { anchor } of anchors) {
      seen.add(anchor);
      const el = host.passageEl(anchor);
      if (!el) continue;
      const top = topOf(el);
      if (top === null) continue;
      items.push({ anchor, el, top, heading: /^H[1-6]$/.test(el.tagName) });
    }
    // Drop dots whose anchor left the doc.
    for (const [a, d] of dots) {
      if (!seen.has(a)) {
        d.remove();
        dots.delete(a);
      }
    }
    if (menu && !seen.has(menu.anchor)) closeMenu();
    items.sort((x, y) => x.top - y.top);
    let y = -Infinity;
    for (const it of items) {
      const top = Math.max(it.top - 2, y + 3);
      let dot = dots.get(it.anchor);
      if (!dot) {
        dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'nb-st-dot';
        dot.dataset.a = it.anchor;
        dot.addEventListener('click', () => onDot(it.anchor));
        dots.set(it.anchor, dot);
        margin.appendChild(dot);
      }
      const u = ui.get(it.anchor);
      const on = !!u;
      dot.className = 'nb-st-dot' + (on ? ` on ${clsFor(u)}` : '');
      const label = labelFor(u, it.heading);
      dot.textContent = label || (on ? '' : '');
      dot.setAttribute('aria-label', (on ? 'Marked ' : 'Mark ') + '#' + it.anchor);
      dot.style.top = `${top.toFixed(1)}px`;
      y = top + 24;
    }
  }

  function closeMenu(): void {
    if (menu) {
      menu.el.remove();
      menu = null;
    }
  }

  function onDot(anchor: string): void {
    if (ui.has(anchor)) {
      // One tap on a marked dot clears (S5 brief).
      void setVerb(anchor, 'clear');
      return;
    }
    if (menu && menu.anchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    const dot = dots.get(anchor);
    const el = document.createElement('div');
    el.className = 'nb-st-menu';
    for (const verb of ['lost', 'easy', 'forgot'] as MarkVerb[]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = verb;
      b.className = verb;
      b.addEventListener('click', () => void setVerb(anchor, verb));
      el.appendChild(b);
    }
    const top = dot ? parseFloat(dot.style.top || '0') + 24 : 0;
    el.style.top = `${top}px`;
    margin.appendChild(el);
    menu = { el, anchor };
  }

  /* ---------------- marks and triage ---------------- */

  /** Always logs the `mark` event; triage is asked first ("before it is logged", types.ts). */
  async function setVerb(anchor: string, verb: MarkVerb): Promise<void> {
    closeMenu();
    const d = doc();
    const e = engine();
    const res = e ? call(() => e.triage(d.id, anchor, verb), { action: 'noted' } as TriageAction) : ({ action: 'noted' } as TriageAction);
    let u = ui.get(anchor);
    const prev = u?.action?.action ?? null;
    if (!u) {
      u = { anchor, verb, action: res, confirmed: false, attemptH: DEFAULT_ATTEMPT_H, scaffold: null };
      ui.set(anchor, u);
    }
    if (verb === 'clear') {
      // The scaffold is found through ui, so it goes before the entry does.
      removeScaffold(anchor);
      ui.delete(anchor);
    }
    try {
      await host.ctx.log({ type: 'mark', doc: d.id, a: anchor, verb, build: d.build });
    } catch (err) {
      console.error('[study marks] log(mark)', err);
    }
    if (verb === 'clear') {
      placeDots();
      host.toast('Mark cleared');
      host.relayout();
      return;
    }
    act(u, prev);
  }

  /** Act on the triage result, as the demo's reader does. `prev` is the mark's earlier action. */
  function act(u: MarkUi, prev: string | null): void {
    const res = u.action;
    if (u.verb !== 'lost' || !res || res.action === 'noted') {
      removeScaffold(u.anchor);
      placeDots();
      host.relayout();
      host.toast(`Marked #${u.anchor} ${u.verb}`, 4200);
      return;
    }
    switch (res.action) {
      case 'rebuild-basic':
        ensureScaffold(u);
        host.toast('The gap is in a basic. Confirm the rebuild request in the scaffold.', 5200);
        break;
      case 'scaffold':
        ensureScaffold(u);
        host.toast(
          prev === 'scaffold' || prev === 'eligible'
            ? 'Not yet: a rewrite needs a day still lost and ink in the attempt box.'
            : 'Lost here: try it on paper first. The basics it rests on are linked.',
          4600);
        break;
      case 'eligible':
        ensureScaffold(u);
        host.toast('Still lost after a day, with an attempt: you can request a rewrite.', 4600);
        break;
      case 'budget-exhausted':
        ensureScaffold(u);
        host.toast(`No rewrites left on ${titleOf(host, doc().id)}. Drill the basic instead.`, 4600);
        break;
      case 'requested':
        ensureScaffold(u);
        break;
      default:
        removeScaffold(u.anchor);
        host.toast(`Marked #${u.anchor} lost`);
    }
    placeDots();
    host.relayout();
  }

  /* ---------------- the scaffold under the passage ---------------- */

  function scaffoldParent(after: HTMLElement): { parent: HTMLElement; before: HTMLElement | null } {
    // As the demo's insertAfterPassage: an H2's scaffold goes at the end of its section; a list
    // item's after its list; inline elements' after their block container.
    if (after.tagName === 'H2') {
      let n = after.nextElementSibling;
      while (n && n.tagName !== 'H2') n = n.nextElementSibling;
      return { parent: after.parentElement as HTMLElement, before: n as HTMLElement | null };
    }
    let hostEl = after;
    if (after.tagName === 'LI' && after.parentElement && /^(UL|OL)$/.test(after.parentElement.tagName)) {
      hostEl = after.parentElement as HTMLElement;
    } else if (/^(TD|TH|TR|DT|DD|SPAN|B|I|EM|STRONG|A)$/.test(after.tagName)) {
      hostEl = (after.closest('table, dl, p, div') as HTMLElement) || after;
    }
    return { parent: hostEl.parentElement as HTMLElement, before: hostEl.nextElementSibling as HTMLElement | null };
  }

  function ensureScaffold(u: MarkUi): void {
    if (u.scaffold) {
      renderScaffold(u);
      return;
    }
    const el = host.passageEl(u.anchor);
    if (!el) return;
    const sc = document.createElement('div');
    // The scaffold root is NOT .no-ink: the attempt box inside it must take the Pencil (S4's
    // surfaces drop strokes whose target is inside .no-ink). Only the rows around it are .no-ink.
    sc.className = 'nb-st-scaffold';
    sc.dataset.a = u.anchor;
    sc.innerHTML =
      '<div class="nb-st-sc-h no-ink"></div><div class="nb-st-sc-banner no-ink" hidden></div>' +
      '<div class="nb-st-sc-basics no-ink" hidden></div>' +
      '<div class="nb-st-sc-att" hidden><div class="nb-st-sc-lab no-ink">Your attempt: what the passage claims and why, in your own words.</div>' +
      '<div class="nb-st-sc-ink"></div>' +
      '<div class="nb-st-row nb-st-sc-tools no-ink"><button type="button" data-sc="undo">Undo</button>' +
      '<button type="button" data-sc="more">More paper</button><span class="nb-st-sp"></span>' +
      '<span class="nb-st-hint nb-st-sc-count"></span></div></div>' +
      '<div class="nb-st-row nb-st-sc-foot no-ink"></div><div class="nb-st-hint nb-st-sc-status no-ink"></div>';
    const { parent, before } = scaffoldParent(el);
    parent.insertBefore(sc, before);
    const handle: Scaffold = {
      el: sc,
      surface: null,
      timer: null,
      destroy() {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.surface?.destroy();
        this.surface = null;
        sc.remove();
      },
    };
    u.scaffold = handle;
    sc.addEventListener('click', ev => {
      const b = (ev.target as HTMLElement).closest('[data-sc]') as HTMLElement | null;
      if (!b) return;
      const what = b.dataset.sc;
      if (what === 'undo') handle.surface?.undo();
      else if (what === 'more') {
        u.attemptH = Math.min(1600, u.attemptH + MORE_PAPER_STEP);
        handle.surface?.layout();
      }
    });
    renderScaffold(u);
  }

  function removeScaffold(anchor: string): void {
    const u = ui.get(anchor);
    u?.scaffold?.destroy();
    if (u) u.scaffold = null;
  }

  function headFor(u: MarkUi): string {
    const a = u.action?.action;
    if (a === 'rebuild-basic') return u.confirmed ? 'Lost here: rebuild requested' : 'Lost here: the gap is in a basic';
    if (a === 'eligible') return 'Lost here: rewrite ready';
    if (a === 'budget-exhausted') return 'Lost here: no rewrites left';
    if (a === 'requested') return 'Lost here: rewrite requested';
    return 'Lost here: struggling';
  }

  function stagePill(id: string): string {
    const e = engine();
    if (!e) return '';
    const b = call(() => e.basic(id), null as { stage: number } | null);
    if (!b) return '';
    const st = Math.max(0, Math.min(5, Math.round(b.stage || 0)));
    const pl = call(() => e.pushLevel(id), 0);
    return `<span class="nb-st-stage s${st}">stage ${st}${pl ? ' · push ' + pl : ''}</span>`;
  }

  function renderScaffold(u: MarkUi): void {
    const sc = u.scaffold;
    if (!sc) return;
    const el = sc.el;
    const res = u.action;
    const h = el.querySelector('.nb-st-sc-h') as HTMLElement;
    const basics = res && 'basics' in res ? (res.basics || []).filter(b => host.ctx.content().docs.has(b)) : [];
    h.innerHTML = `<span class="nb-st-kick"></span>`;
    (h.querySelector('.nb-st-kick') as HTMLElement).textContent = headFor(u);

    // The basics it rests on, with stages and links (hidden after the rebuild is requested).
    const bl = el.querySelector('.nb-st-sc-basics') as HTMLElement;
    const showBasics = basics.length > 0 && !(res?.action === 'rebuild-basic' && u.confirmed) && res?.action !== 'requested';
    bl.hidden = !showBasics;
    if (showBasics) {
      bl.innerHTML = '<span class="nb-st-hint">Rests on</span> ';
      for (const b of basics) {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'nb-st-basiclink';
        a.innerHTML = '';
        a.textContent = titleOf(host, b);
        a.addEventListener('click', () => host.open(b));
        bl.appendChild(a);
        bl.insertAdjacentHTML('beforeend', stagePill(b) + ' ');
      }
    }

    // The banner: rebuild / rewrite requested.
    const banner = el.querySelector('.nb-st-sc-banner') as HTMLElement;
    if (res?.action === 'rebuild-basic' && u.confirmed) {
      banner.hidden = false;
      banner.textContent =
        `Rebuild requested for ${basics.map(b => titleOf(host, b)).join(', ')}: /teach on the laptop will rebuild it from its prerequisites. No rewrite budget spent.`;
    } else if (res?.action === 'requested') {
      banner.hidden = false;
      // The request may live on a linked basic (rebuild), not the marked doc.
      const kind = [...pending().values()].some(r => r.kind === 'rebuild' && rebuildAnchorMatches(r, u.anchor)) ? 'Rebuild' : 'Rewrite';
      banner.textContent = `${kind} requested ${fmtTime(res.at)}; /teach on the laptop will answer it.`;
    } else {
      banner.hidden = true;
    }

    // The attempt surface: ink in the box is what makes a rewrite requestable.
    const att = el.querySelector('.nb-st-sc-att') as HTMLElement;
    const showAtt = res?.action === 'scaffold' || res?.action === 'eligible' || res?.action === 'budget-exhausted' || res?.action === 'requested';
    att.hidden = !showAtt;
    if (showAtt && !sc.surface) {
      const box = el.querySelector('.nb-st-sc-ink') as HTMLElement;
      sc.surface = host.ink.surface(doc(), box, `attempt:${u.anchor}`, { height: () => u.attemptH });
      sc.surface.onChange(() => {
        if (sc.timer !== null) window.clearTimeout(sc.timer);
        sc.timer = window.setTimeout(() => {
          sc.timer = null;
          const n = sc.surface ? sc.surface.count() : 0;
          void host.ctx.log({ type: 'attempt', doc: doc().id, a: u.anchor, strokes: n }).catch(err => console.error('[study marks] log(attempt)', err));
          updateScaffoldStatus(u);
        }, ATTEMPT_DEBOUNCE_MS);
      });
    }
    renderFoot(u);
    updateScaffoldStatus(u);
  }

  function renderFoot(u: MarkUi): void {
    const sc = u.scaffold;
    if (!sc) return;
    const foot = sc.el.querySelector('.nb-st-sc-foot') as HTMLElement;
    foot.innerHTML = '';
    const res = u.action;
    const btn = (label: string, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      foot.appendChild(b);
      return b;
    };
    const sp = () => {
      const s = document.createElement('span');
      s.className = 'nb-st-sp';
      foot.appendChild(s);
    };
    const basics = res && 'basics' in res ? (res.basics || []).filter(b => host.ctx.content().docs.has(b)) : [];
    if (res?.action === 'rebuild-basic' && !u.confirmed) {
      const targets = basics.length ? basics : [doc().id];
      const rb = btn(targets.length === 1 ? `Request rebuild of ${titleOf(host, targets[0])}` : `Request rebuild (${plural(targets.length, 'basic')})`, 'primary');
      twoTap(rb, 'Tap again to request the rebuild', () => requestRebuild(u, targets));
    } else if (res?.action === 'scaffold') {
      const still = btn('Still lost');
      still.addEventListener('click', () => void setVerb(u.anchor, 'lost'));
    } else if (res?.action === 'eligible') {
      const b = budget();
      const rb = btn(`Request rewrite (${b.left} of ${b.left + b.used} left)`, 'primary');
      twoTap(rb, `Tap again to spend 1 of ${b.left}`, () => requestRewrite(u));
    } else if (res?.action === 'budget-exhausted') {
      const drills = (res.drill && host.ctx.content().docs.has(res.drill) ? [res.drill] : []).concat(
        res.drill ? [] : basics.slice(0, 1));
      for (const bid of drills) {
        const b = btn(`Drill ${titleOf(host, bid)} instead`, 'primary');
        b.addEventListener('click', () => void host.ctx.ui.openDrill(bid, firstDerive(bid) ?? ''));
      }
      if (!drills.length) {
        const h = document.createElement('span');
        h.className = 'nb-st-hint';
        h.textContent = 'No linked basic to drill.';
        foot.appendChild(h);
      }
    }
    sp();
    const clr = btn('Clear mark');
    clr.addEventListener('click', () => void setVerb(u.anchor, 'clear'));
  }

  function updateScaffoldStatus(u: MarkUi): void {
    const sc = u.scaffold;
    if (!sc) return;
    const res = u.action;
    const n = attemptCount(u.anchor);
    const cnt = sc.el.querySelector('.nb-st-sc-count') as HTMLElement | null;
    if (cnt) cnt.textContent = n ? plural(n, 'stroke') : 'empty';
    const b = budget();
    const out = sc.el.querySelector('.nb-st-sc-status') as HTMLElement | null;
    if (!out) return;
    let txt = '';
    if (res?.action === 'scaffold') {
      const at = res.eligibleAt ? fmtTime(res.eligibleAt) : null;
      txt =
        (res.since ? `Since ${fmtTime(res.since)} · ` : '') +
        (at ? `rewrite possible from ${at} with ink in the box` : 'a rewrite needs 24 h still lost and ink in the box') +
        ` · ${b.left} of ${b.left + b.used} rewrites left on this doc.`;
    } else if (res?.action === 'eligible') {
      txt = `A rewrite spends 1 of the ${b.left} left on this doc.`;
    } else if (res?.action === 'budget-exhausted') {
      txt = `All ${b.left + b.used} rewrites on this doc are used.`;
    } else if (res?.action === 'requested') {
      txt = 'Waiting for the laptop. The attempt stays below.';
    }
    out.textContent = txt;
    out.hidden = !txt;
  }

  /** Two-tap confirm done: log one rebuild-request per target basic (Decision 5). */
  function requestRebuild(u: MarkUi, targets: string[]): void {
    const d = doc();
    u.confirmed = true;
    for (const b of targets) {
      const build = host.ctx.content().docs.get(b)?.build ?? d.build;
      // On another doc (a linked basic), `a` names the marked passage as `<doc>#<anchor>`.
      const a = b === d.id ? u.anchor : `${d.id}#${u.anchor}`;
      void host.ctx.log({ type: 'rebuild-request', doc: b, build, a }).catch(err => console.error('[study marks] log(rebuild-request)', err));
    }
    host.toast(`Rebuild requested: ${targets.map(t => titleOf(host, t)).join(', ')}. /teach on the laptop will answer it.`, 5200);
    renderScaffold(u);
    placeDots();
  }

  /** Two-tap confirm done: log the rewrite-request; the budget drops (the engine counts). */
  function requestRewrite(u: MarkUi): void {
    const d = doc();
    // rev: the passage's hash now, so the request is answered only when its text changes (Decision 5).
    const rev = host.ctx.content().anchors.get(d.id)?.get(u.anchor)?.hash;
    void host.ctx.log({ type: 'rewrite-request', doc: d.id, a: u.anchor, build: d.build, ...(rev ? { rev } : {}) }).catch(err => console.error('[study marks] log(rewrite-request)', err));
    // The 'events' change re-checks this mark; a real engine then answers 'requested'.
    resync();
  }

  /* ---------------- recheck ---------------- */

  /**
   * Re-derive every open mark's state from the engine: `triage` is the recheck call (a lost mark
   * that already has one continues its cycle; see the S5 thread). Run after `mark` events, attempt
   * ink, content rebuilds and budget changes.
   */
  function resync(): void {
    if (destroyed) return;
    const marks = openMarks();
    for (const [a, m] of marks) {
      let u = ui.get(a);
      if (!u) {
        u = { anchor: a, verb: m.verb, action: null, confirmed: false, attemptH: DEFAULT_ATTEMPT_H, scaffold: null };
        ui.set(a, u);
      }
      u.verb = m.verb;
      if (m.verb === 'lost') {
        const e = engine();
        if (e) u.action = call(() => e.triage(doc().id, a, 'lost'), u.action);
      } else {
        u.action = { action: 'noted' };
      }
    }
    for (const [a, u] of [...ui]) {
      if (!marks.has(a)) {
        u.scaffold?.destroy();
        ui.delete(a);
      }
    }
    for (const u of ui.values()) {
      if (u.verb === 'lost' && u.action && u.action.action !== 'noted') ensureScaffold(u);
      else removeScaffold(u.anchor);
    }
    detectLanded();
    placeDots();
  }

  /** A request leaves `pendingRequests` when its doc's build passes it: the laptop answered. */
  function detectLanded(): void {
    const now = pending();
    const content = host.ctx.content();
    const landed: PendingReq[] = [];
    for (const [k, req] of prevPending) {
      if (now.has(k)) continue;
      const d = content.docs.get(req.doc);
      if (d && d.build > req.build) landed.push(req);
    }
    prevPending = now;
    for (const req of landed) {
      const d = content.docs.get(req.doc);
      if (!d) continue;
      if (req.doc === doc().id) {
        lastBuild = d.build;
        const counts = pageInk()?.reanchor?.();
        const inkNote = counts ? ` ${plural(counts.moved, 'stroke')} followed, ${counts.changed} on rewritten text, ${counts.orphaned} orphaned.` : '';
        host.toast(`Rebuilt ${titleOf(host, req.doc)} (build ${d.build}):${inkNote}`, 6200);
        host.rerender();
        return;
      }
      // A basic an open scaffold asked about was rebuilt: refresh its pills.
      for (const u of ui.values()) {
        const res = u.action;
        if (res && 'basics' in res && (res.basics || []).includes(req.doc)) {
          host.toast(`Rebuilt ${titleOf(host, req.doc)} (build ${d.build}).`, 4600);
          renderScaffold(u);
        }
      }
    }
    if (doc().build !== lastBuild) {
      lastBuild = doc().build;
      host.rerender();
    }
  }

  /* ---------------- wiring ---------------- */

  const offChange = host.ctx.onChange(what => {
    if (destroyed) return;
    if (what === 'events' || what === 'content') resync();
  });

  resync();
  prevPending = pending();

  return {
    refresh: () => {
      placeDots();
    },
    destroy: () => {
      destroyed = true;
      offChange();
      closeMenu();
      for (const u of ui.values()) u.scaffold?.destroy();
      ui.clear();
      for (const d of dots.values()) d.remove();
      dots.clear();
      margin.classList.remove('nb-st-margin');
      if (--styleUsers <= 0) {
        styleUsers = 0;
        document.getElementById(STYLE_ID)?.remove();
      }
    },
  };
}

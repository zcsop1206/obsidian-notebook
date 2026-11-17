// Bundled by test/build.mjs into test/out/study-fixture.js for test/harness.html: the study
// fixture for test/run_study_test.py. Exposes on window.study: a fixture StudyDoc builder, a
// ContentIndex builder, a mock engine (S5/S8 mock S2 until it lands), a mock StudyContext that
// records logged events and ui calls, a DOM MarksHost that renders passages the way the study
// view will, and the modules under test (attachMarks, openChanges, the panels' register).
// `obsidian` is external: the bundle reads the mock on window.obsidian.
import type { App, Plugin } from 'obsidian';
import type { StudyContext, StudySettings } from '../src/study/context';
import { DEFAULT_STUDY_SETTINGS } from '../src/study/context';
import type {
  BankEntry, BasicState, ContentIndex, Derive, DocLink, Engine, Kata,
  MarkVerb, MethodEntry, Passage, PassageKind, Pick, Problem, Proof, Recall,
  StudyDoc, StudyEvent, Theorem, TodayPlan, Track, TriageAction,
} from '../src/study/types';
import type { InkApi, InkStroke, InkSurface, MarksHost, PageInk } from '../src/study/view/host';
import { attachMarks } from '../src/study/view/marks';
import { createInkApi } from '../src/study/ink';
import { changesSection, openChanges } from '../src/study/view/changes';
import { register as registerPanels } from '../src/study/panels/register';
import { TodayView, VIEW_TYPE_STUDY_TODAY } from '../src/study/panels/today';
import { MapView, VIEW_TYPE_STUDY_MAP } from '../src/study/panels/map';

/* ---------------------------------- docs ---------------------------------- */

let seq = 0;
export function passage(anchor: string, kind: PassageKind, markdown: string, extra: Partial<Passage> = {}): Passage {
  return {
    anchor, explicit: anchor.startsWith('^') ? false : true, kind, start: ++seq, end: seq,
    source: markdown, markdown, hash: 'h' + seq.toString(16), ...extra,
  };
}

export interface DocOpts {
  title?: string;
  needs?: string[];
  build?: number;
  areas?: string[];
  tracks?: string[];
  derives?: Derive[];
  passages?: Passage[];
  by?: 'model' | 'adit';
}

export function doc(id: string, kind: StudyDoc['kind'], opts: DocOpts = {}): StudyDoc {
  return {
    id, path: `study/${id}.md`, kind, title: opts.title ?? id,
    areas: opts.areas ?? [], needs: opts.needs ?? [], build: opts.build ?? 1,
    tracks: opts.tracks ?? [], by: opts.by ?? 'model', labelled: true, meta: {},
    passages: opts.passages ?? [], links: [] as DocLink[], theorems: [] as Theorem[], proofs: [] as Proof[],
    derives: opts.derives ?? [], problems: [] as Problem[], recalls: [] as Recall[], kata: null,
    bank: [] as BankEntry[], bankRefs: [], warnings: [],
  };
}

/** A ContentIndex over `docs`, with the maps the panels and marks code read. */
export function index(docs: StudyDoc[], tracks: Track[] = [], problems: Problem[] = [], katas: Kata[] = []): ContentIndex {
  const idx: ContentIndex = {
    docs: new Map(docs.map(d => [d.id, d])),
    usedBy: new Map(),
    anchors: new Map(),
    problems: new Map(problems.map(p => [p.id, p])),
    katas: new Map(katas.map(k => [k.id, k])),
    bank: new Map<string, BankEntry>(),
    tracks,
    methods: new Map<string, MethodEntry>(),
    warnings: [],
  };
  for (const d of docs) {
    const am = new Map<string, Passage>();
    for (const p of d.passages) {
      am.set(p.anchor, p);
      for (const it of p.items ?? []) am.set(it.anchor, p);
    }
    idx.anchors.set(d.id, am);
    for (const n of d.needs) {
      const l = idx.usedBy.get(n) ?? [];
      l.push(d.id);
      idx.usedBy.set(n, l);
    }
  }
  return idx;
}

/* --------------------------------- engine --------------------------------- */

interface MarkRow { doc: string; a: string; verb: MarkVerb; t: string; build: number }
interface PendRow { doc: string; a: string; kind: 'rewrite' | 'rebuild'; t: string; build: number }

/**
 * A mock Engine (S5/S8 ticket notes: mock S2 until it lands). Defaults answer like the demo's
 * engine: a lost mark with nothing pending scaffolds; a pending request answers `requested`; an
 * exhausted budget answers `budget-exhausted`. `triageOverride` replaces the policy outright.
 */
export class MockEngine implements Engine {
  todayStr = '2025-06-10';
  marksByDoc = new Map<string, Map<string, MarkRow>>();
  budgetVal = { left: 3, used: 0 };
  pending: PendRow[] = [];
  triageBasics: string[] = [];
  triageCalls: { doc: string; a: string; verb: MarkVerb }[] = [];
  /** Set to force a triage answer ({action:'eligible'} etc.); a function for full control. */
  triageOverride: TriageAction | ((doc: string, a: string, verb: MarkVerb) => TriageAction) | null = null;
  plan: TodayPlan = { date: '2025-06-10', drills: [], picks: [], next: null, settledToday: 0 };
  basicsList: BasicState[] = [];
  ratings = new Map<string, number>();
  hist = new Map<string, { t: string; r: number }[]>();
  acc = { p: 0.8, n: 12 };
  pushLevels = new Map<string, number>();
  blockersList: { track: string; date: string | null; basics: string[] }[] = [];

  now(): Date { return new Date(this.todayStr + 'T12:00:00'); }
  today(): string { return this.todayStr; }
  update(): void { /* the mock folds events in ctx.log directly */ }

  basic(id: string): BasicState {
    return this.basicsList.find(b => b.id === id) ?? { id, stage: 0, due: null, push: 0, streak: 0, last: null, history: [] };
  }
  basics(): BasicState[] { return this.basicsList; }
  rating(area: string): number { return this.ratings.get(area) ?? NaN; }
  ratingHistory(area: string): { t: string; r: number }[] { return this.hist.get(area) ?? []; }
  methodAccuracy(): { p: number; n: number } { return this.acc; }
  pushLevel(basic: string): number { return this.pushLevels.get(basic) ?? this.basic(basic).push; }
  expected(d: number, r: number): number { return 1 / (1 + Math.pow(10, (d - r) / 2)); }

  triage(docId: string, a: string, verb: MarkVerb): TriageAction {
    this.triageCalls.push({ doc: docId, a, verb });
    if (typeof this.triageOverride === 'function') return this.triageOverride(docId, a, verb);
    if (this.triageOverride) return this.triageOverride;
    if (verb !== 'lost') return { action: 'noted' };
    if (this.pending.some(r => r.doc === docId && r.a === a)) return { action: 'requested', at: new Date().toISOString() };
    if (this.budgetVal.left <= 0) return { action: 'budget-exhausted', drill: this.triageBasics[0] ?? null };
    return { action: 'scaffold', basics: this.triageBasics.slice(), since: this.todayStr + 'T08:00:00', eligibleAt: null };
  }
  budget(): { left: number; used: number } { return { ...this.budgetVal }; }
  marks(docId?: string): MarkRow[] {
    const out: MarkRow[] = [];
    for (const [d, m] of this.marksByDoc) {
      if (docId && d !== docId) continue;
      for (const row of m.values()) if (row.verb !== 'clear') out.push(row);
    }
    return out.sort((x, y) => (x.t < y.t ? 1 : -1));
  }
  pendingRequests(): PendRow[] { return this.pending.slice(); }

  todayPlan(): TodayPlan { return this.plan; }
  pickProblem(): Pick | null { return null; }
  pickKata(): Pick | null { return null; }
  blockers(): { track: string; date: string | null; basics: string[] }[] { return this.blockersList; }

  /** Fold one event the way the real engine will (marks, requests). Called by ctx.log. */
  noteEvent(e: StudyEvent): void {
    if (e.type === 'mark') {
      const m = this.marksByDoc.get(e.doc) ?? new Map<string, MarkRow>();
      if (e.verb === 'clear') m.delete(e.a);
      else m.set(e.a, { doc: e.doc, a: e.a, verb: e.verb, t: e.t, build: e.build });
      this.marksByDoc.set(e.doc, m);
    } else if (e.type === 'rewrite-request' || e.type === 'rebuild-request') {
      this.pending.push({ doc: e.doc, a: e.a, kind: e.type === 'rewrite-request' ? 'rewrite' : 'rebuild', t: e.t, build: e.build });
    }
  }
}

/* --------------------------------- context -------------------------------- */

export interface UiCall { fn: string; args: unknown[] }
export interface MockCtx extends StudyContext {
  logged: StudyEvent[];
  uiCalls: UiCall[];
  toasts: string[];
  /** Fire the onChange listeners the modules registered. */
  fire(what: 'content' | 'events'): void;
  mockEngine: MockEngine;
}

export function makeCtx(opts: {
  engine?: MockEngine; content?: ContentIndex; settings?: Partial<StudySettings>; plugin?: Plugin;
} = {}): MockCtx {
  const w = window as unknown as { obsidian: { Plugin: new () => Plugin; app: App } };
  const plugin = opts.plugin ?? new w.obsidian.Plugin();
  const mockEngine = opts.engine ?? new MockEngine();
  const idx = opts.content ?? index([]);
  const evts: StudyEvent[] = [];
  const logged: StudyEvent[] = [];
  const uiCalls: UiCall[] = [];
  const toasts: string[] = [];
  const listeners: ((what: 'content' | 'events') => void)[] = [];
  let n = 0;
  const ui = {} as StudyContext['ui'];
  for (const fn of ['openDoc', 'openDrill', 'openProblem', 'openKata', 'openToday', 'openMap'] as const) {
    (ui as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
      uiCalls.push({ fn, args });
      return Promise.resolve();
    };
  }
  ui.toast = (m: string) => toasts.push(m);
  const ctx: MockCtx = {
    app: (plugin as unknown as { app: App }).app,
    plugin,
    ui,
    settings: () => ({ ...DEFAULT_STUDY_SETTINGS, ...(opts.settings ?? {}) }),
    content: () => idx,
    events: () => evts,
    log: async e => {
      const full = { v: 1 as const, id: `ipad-t${(++n).toString(36)}`, t: new Date().toISOString(), dev: 'ipad', ...e };
      evts.push(full);
      logged.push(full);
      mockEngine.noteEvent(full);
      for (const fn of listeners.slice()) fn('events');
      return full;
    },
    engine: () => mockEngine,
    onChange: fn => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    logged, uiCalls, toasts, mockEngine,
    fire: what => { for (const fn of listeners.slice()) fn(what); },
  };
  return ctx;
}

/* ----------------------------------- ink ----------------------------------- */

export interface MockSurface extends InkSurface {
  /** Test helper: add `n` strokes and fire onChange, as a pen stroke would. */
  addStrokes(n?: number): void;
  destroyed: boolean;
}
export const inkSurfaces = new Map<string, MockSurface>();

function mockSurface(container: HTMLElement, key: string, opts?: { height?: number | (() => number) }): MockSurface {
  const strokes: InkStroke[] = [];
  const cbs: ((s: InkStroke[]) => void)[] = [];
  const el = document.createElement('div');
  el.className = 'nb-mock-ink';
  el.style.cssText = 'width:100%;background:#fff;border-radius:6px;';
  el.dataset.inkKey = key;
  const h = typeof opts?.height === 'function' ? opts.height() : opts?.height ?? 220;
  el.style.height = `${h}px`;
  container.appendChild(el);
  const s: MockSurface = {
    el,
    destroyed: false,
    strokes: () => strokes.slice(),
    count: () => strokes.length,
    onChange(fn) {
      cbs.push(fn);
      return () => { const i = cbs.indexOf(fn); if (i >= 0) cbs.splice(i, 1); };
    },
    setReadOnly() { /* the mock is always writable */ },
    undo: () => strokes.pop() ?? null,
    clear() { strokes.length = 0; },
    layout() {
      const nh = typeof opts?.height === 'function' ? opts.height() : opts?.height ?? 220;
      el.style.height = `${nh}px`;
    },
    destroy() { s.destroyed = true; el.remove(); },
    addStrokes(n = 1) {
      for (let i = 0; i < n; i++) {
        strokes.push({ id: `s${strokes.length}`, p: [[4 + strokes.length * 8, 20, 0.4, 0], [60, 40, 0.4, 40]], t0: Date.now() });
      }
      for (const fn of cbs.slice()) fn(strokes.slice());
    },
  };
  inkSurfaces.set(key, s);
  return s;
}

export interface MockPageInk extends PageInk {
  relayouts: number;
  reanchors: number;
}

/* ---------------------------------- host ----------------------------------- */

export interface MockHost {
  host: MarksHost;
  /** Re-render the fixture DOM (called by rerender); increments rerenders. */
  rerenders: number;
  relayouts: number;
  toasts: string[];
  opened: { doc: string; anchor?: string }[];
  pageInk: MockPageInk;
  wrap: HTMLElement;
  /** The passage elements by anchor. */
  els: Map<string, HTMLElement>;
}

/**
 * A DOM stand-in for the study view's rendered doc: the passages stacked in a column, the margin
 * column at the right where the dots live. `attachMarks` is driven against this.
 */
export function makeHost(ctx: StudyContext, d: StudyDoc, parent: HTMLElement, opts: { ink?: InkApi } = {}): MockHost {
  const wrap = parent.createDiv({ cls: 'nb-study-doc' });
  wrap.style.cssText = 'position:relative;width:560px;padding-right:130px;';
  const els = new Map<string, HTMLElement>();
  const toasts: string[] = [];
  const opened: { doc: string; anchor?: string }[] = [];
  const pageInk: MockPageInk = {
    relayouts: 0, reanchors: 0,
    relayout() { this.relayouts++; },
    reanchor() { this.reanchors++; return { moved: 2, changed: 1, orphaned: 0 }; },
    undo: () => null,
    destroy() { /* nothing to free */ },
  };
  // `opts.ink` (the real createInkApi from src/study/ink) replaces the mock surfaces.
  const ink: InkApi = opts.ink ?? {
    page: () => pageInk,
    surface: (dd, box, key, so) => mockSurface(box, key, so),
  };
  const render = () => {
    els.clear();
    for (const el of [...wrap.children]) if (el !== margin) el.remove();
    for (const p of d.passages) {
      let el: HTMLElement;
      if (p.kind === 'heading') {
        el = document.createElement(`h${Math.min(6, Math.max(1, p.level ?? 2))}`);
        el.textContent = p.text || p.markdown;
      } else if (p.kind === 'list') {
        el = document.createElement('ul');
        for (const it of p.items ?? []) {
          const li = document.createElement('li');
          li.textContent = it.text || `item ${it.anchor}`;
          el.appendChild(li);
          els.set(it.anchor, li);
        }
        if (!(p.items ?? []).length) {
          const li = document.createElement('li');
          li.textContent = p.markdown;
          el.appendChild(li);
        }
      } else if (p.kind === 'rule') {
        el = document.createElement('hr');
      } else {
        el = document.createElement('p');
        el.textContent = p.markdown || `passage ${p.anchor}`;
      }
      (el as HTMLElement).dataset.a = p.anchor;
      wrap.insertBefore(el, margin);
      els.set(p.anchor, el);
    }
  };
  const margin = document.createElement('div');
  margin.className = 'nb-st-margin';
  wrap.appendChild(margin);
  const mock: MockHost = {
    host: null as unknown as MarksHost,
    rerenders: 0,
    relayouts: 0,
    toasts, opened, pageInk, wrap, els,
  };
  mock.host = {
    ctx,
    doc: () => d,
    passageEl: a => els.get(a) ?? null,
    margin,
    ink,
    open: (docId, anchor) => opened.push({ doc: docId, anchor }),
    toast: (m: string) => toasts.push(m),
    relayout: () => { mock.relayouts++; },
    rerender: () => { mock.rerenders++; render(); },
  } as MarksHost & { pageInk?: PageInk };
  (mock.host as MarksHost & { pageInk?: PageInk }).pageInk = pageInk;
  render();
  return mock;
}

/* --------------------------------- window ---------------------------------- */

(window as unknown as { study: unknown }).study = {
  attachMarks, openChanges, changesSection, registerPanels,
  TodayView, MapView, VIEW_TYPE_STUDY_TODAY, VIEW_TYPE_STUDY_MAP,
  MockEngine, makeCtx, makeHost, inkSurfaces, doc, index, passage, createInkApi,
};

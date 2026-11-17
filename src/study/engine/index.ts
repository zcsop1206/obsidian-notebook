/**
 * The engine (SPEC.md, Engine): pure state over (content, events, now). Ported from
 * lab/study-reader/src/engine.js with the SPEC decisions applied; the rules are in rules.ts and the
 * fold in state.ts. Imports nothing but the shared types, so the laptop scripts can use it:
 *
 *   const eng = foldState(index, events, new Date());   // or createEngine(() => now) + update()
 *   eng.pendingRequests(); eng.marks(); eng.todayPlan(60);
 *
 * One rule lives in one place: the view and blocks call this; they never compute stages, ratings,
 * picks, rations or budgets themselves. `triage` only decides; the caller logs the events.
 */
import type { BasicState, ContentIndex, Engine, MarkVerb, Pick, StudyEvent, TodayPlan, TriageAction } from '../types';
import { expected, isoLocal, ymd } from './rules';
import { StudyState, emptyIndex, type Deadline, type SettleRec, type Target } from './state';

export * as rules from './rules';
export { StudyState, emptyIndex, sortEvents } from './state';
export type { Deadline, SettleRec, Target, BasicRec, MarkRec, RequestRec } from './state';

/** The Engine contract plus read-only extras the panels, blocks and laptop scripts may use. */
export interface StudyEngine extends Engine {
  /** Every rating area the content or logs mention, in FORMAT.md's order. */
  areas(): string[];
  /** The pick target for an area now (stretch, hidden per Decision 1, eased, reach). */
  target(area: string, opts?: { hidden?: boolean; reach?: boolean }): Target;
  streaks(area: string): { miss: number; clean: number };
  /** The settle record of a problem or kata (the first settle; re-ticks update its methods). */
  settled(item: string): SettleRec | null;
  /** Theorem hook settles, oldest first. */
  hooks(): SettleRec[];
  /** The nearest deadline of a track that serves the doc. */
  deadline(doc: string): Deadline | null;
  /** The basics a passage rests on, as the scaffold shows them. */
  passageBasics(doc: string, anchor: string): string[];
  /** Stage <= 1 or the last drill failed (opened basics only). */
  weak(basic: string): boolean;
  /** Some basic in the area is at push level 3. */
  inPush(area: string): boolean;
  /** The canonical item id for a theorem hook's settle and call events (attempt n, default 1). */
  hookItem(doc: string, theoremAnchor: string, attempt?: number): string;
  /** The item id for the next attempt at a theorem hook: each attempt is graded once, later settles on it only re-tick. */
  nextHookItem(doc: string, theoremAnchor: string): string;
  /** Events the fold skipped (bad shape, unknown type or basic). */
  skipped(): number;
  /** The folded state, for scripts and tests. */
  state(): StudyState;
}

/**
 * The item id of a theorem posed as a problem (push level 3): `thm:<doc>#<theorem anchor>`, and
 * `thm:<doc>#<theorem anchor>#<n>` for attempt n > 1. Each attempt is graded once.
 */
export function hookItem(doc: string, theoremAnchor: string, attempt = 1): string {
  return attempt > 1 ? `thm:${doc}#${theoremAnchor}#${attempt}` : `thm:${doc}#${theoremAnchor}`;
}

export function createEngine(now: () => Date = () => new Date()): StudyEngine {
  let content: ContentIndex = emptyIndex();
  let events: StudyEvent[] = [];
  let st: StudyState | null = null;
  const S = (): StudyState => st || (st = new StudyState(content, events));
  const ms = () => now().getTime();
  const today = () => ymd(now());

  const basicState = (id: string): BasicState => {
    const b = S().basics.get(id);
    if (!b) return { id, stage: 0, due: null, push: 0, streak: 0, last: null, history: [] };
    return {
      id: b.id, stage: b.stage, due: b.due, push: Math.max(0, Math.min(3, b.push)), streak: b.streak, last: b.last,
      history: b.history.map(h => ({ t: h.t, grade: h.grade, from: h.from, to: h.to, src: h.src })),
    };
  };

  return {
    now,
    today,
    update(c: ContentIndex, e: StudyEvent[]): void {
      content = c || emptyIndex();
      events = e || [];
      st = null; // folded again on the next read
    },

    basic: basicState,
    basics: () => [...S().basics.keys()].map(basicState),
    rating: (area: string) => S().rating(area),
    ratingHistory: (area: string) => {
      const a = S().ratings.get(area);
      const t0 = S().t0 || isoLocal(now());
      return a ? a.hist.map(h => ({ t: h.t || t0, r: h.r })) : [{ t: t0, r: S().rating(area) }];
    },
    methodAccuracy: (area?: string) => {
      const m = S().methodAccuracy(area);
      return { p: m.p, n: m.n };
    },
    pushLevel: (basic: string) => S().pushLevel(basic),
    expected,

    triage: (doc: string, anchor: string, verb: MarkVerb): TriageAction => S().triageAt(doc, anchor, verb, ms()),
    budget: (doc: string) => S().budget(doc, ms()),
    marks: (doc?: string) => S().openMarks(ms(), doc),
    pendingRequests: () => S().pendingRequests(ms()),

    todayPlan: (minutes?: number): TodayPlan => S().todayPlan(today(), minutes == null ? 60 : minutes),
    pickProblem: (area: string | null, opts?: { hidden?: boolean; reach?: boolean }): Pick | null => {
      const s = S();
      const hidden = !!opts?.hidden, reach = !!opts?.reach && !hidden;
      const p = s.pickProblemRaw(area, { hidden, reach }, today());
      return p ? s.problemPick(p, area, hidden, reach) : null;
    },
    pickKata: (opts?: { hidden?: boolean; reach?: boolean }): Pick | null => {
      const s = S();
      const hidden = !!opts?.hidden, reach = !!opts?.reach && !hidden;
      let areas = s.kataAreas(today());
      if (!areas.length) areas = [...new Set([...s.content.katas.values()].map(k => k.area).filter(Boolean))];
      const k = s.pickKataRaw(areas, { hidden, reach }, today());
      return k ? s.kataPick(k, hidden, reach) : null;
    },
    blockers: () => S().blockers(today()),

    areas: () => S().areas(),
    target: (area: string, opts?: { hidden?: boolean; reach?: boolean }) => S().target(area, opts),
    streaks: (area: string) => S().streaks(area),
    settled: (item: string) => {
      const r = S().settled.get(item);
      return r ? { ...r, called: [...r.called], took: [...r.took] } : null;
    },
    hooks: () => S().hooks.map(r => ({ ...r, called: [...r.called], took: [...r.took] })),
    deadline: (doc: string) => S().deadline(doc, today()),
    passageBasics: (doc: string, anchor: string) => S().passageBasics(doc, anchor),
    weak: (basic: string) => S().weak(basic),
    inPush: (area: string) => S().inPush(area),
    hookItem,
    nextHookItem: (doc: string, theoremAnchor: string) => {
      const s = S();
      const h = s.resolveHook(hookItem(doc, theoremAnchor));
      const n = h ? s.hooks.filter(r => { const x = s.resolveHook(r.item); return !!x && x.doc.id === h.doc.id && x.theorem === h.theorem; }).length : 0;
      return hookItem(doc, theoremAnchor, n + 1);
    },
    skipped: () => S().skipped,
    state: S,
  };
}

/** Fold the logs over the content at a fixed moment, without Obsidian: for tests and the laptop bridge. */
export function foldState(content: ContentIndex, events: StudyEvent[], now: Date = new Date()): StudyEngine {
  const eng = createEngine(() => now);
  eng.update(content, events);
  return eng;
}

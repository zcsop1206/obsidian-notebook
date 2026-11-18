/**
 * The engine's state: a fold over (ContentIndex, StudyEvent[]) in time order, plus the queries the
 * Engine answers at a given moment. Pure: imports only the shared types and the rules, so the laptop
 * scripts can run it under node (SPEC.md, Engine).
 *
 * Ported from lab/study-reader/src/engine.js. The demo kept mutable state in localStorage; here every
 * number is recomputed from the event logs, so two devices that see the same logs agree.
 */
import type {
  ContentIndex, DrillGrade, Kata, MarkVerb, Pick, Problem, StudyDoc, StudyEvent, Track, TriageAction,
} from '../types';
import {
  CLEAN_RUN, E_HI, E_LO, E_REACH, E_TARGET, EASE_STEP, ELIGIBLE_MS, GEN_AREA, HISTORY_MAX, K, K_HOOK, KNOWN_STAGE,
  MISS_RUN, P_ID_WINDOW, RATING_HISTORY_MAX, REWRITE_MAX, SLOTS, addDays, clampStage, dForE, dayDiff, dayNum, drillCount,
  eventDay, expected, f2, fogGrade, globMatch, hash01, hiddenE, intervalFor, isHiddenSlot, isoLocal, kataScore, nextPush,
  nextStage, pIdSmoothed, scoreFor, startRating, weekday, type Grade,
} from './rules';

/* ------------------------------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------------------------------ */

export interface HistoryEntry { t: string; ms: number; grade: DrillGrade; from: number; to: number; src: string }

export interface BasicRec {
  id: string;
  stage: number;
  due: string | null;
  push: number;
  streak: number;
  last: DrillGrade | null;
  /** The day a clean result last raised the stage (one rise per basic per day). */
  raisedOn: string | null;
  /** The day of the first event on this basic; null = never opened (stage 0, nothing due). */
  opened: string | null;
  history: HistoryEntry[];
}

export interface AreaRec { r: number; hist: { t: string; r: number }[]; miss: number; clean: number }

export interface SettleRec {
  item: string;
  kind: 'problem' | 'kata' | 'theorem';
  area: string | null;
  d: number | null;
  verdict: string;
  help: boolean;
  score: number | null;
  /** Expected score at the rating before; null when nothing was rated. */
  E: number | null;
  rBefore: number | null;
  rAfter: number | null;
  hidden: boolean;
  reach: boolean;
  t: string;
  day: string;
  called: string[];
  took: string[];
  /** Every method it took was called; null when not counted (moot, or no methods known). */
  hit: boolean | null;
  /** Theorem hooks: the basic graded and its grade. */
  basic: string | null;
  grade: DrillGrade | null;
}

export interface MethodRec { item: string; kind: SettleRec['kind']; area: string | null; hidden: boolean; hit: boolean; t: string }

export interface MarkRec {
  doc: string;
  a: string;
  verb: MarkVerb;
  t: string;
  ms: number;
  build: number;
  /** What triage said when this mark was made (lost marks only); rationed cycles start only at rationed marks. */
  action: TriageAction['action'] | null;
}

export interface RequestRec { kind: 'rewrite' | 'rebuild'; doc: string; a: string; t: string; ms: number; build: number; rev: string | null }

export interface AttemptRec { doc: string; a: string; strokes: number; t: string; ms: number }

export interface CallRec { hidden: boolean; reach: boolean; d: number | null; conf: number | null; t: string }

export interface Target {
  d: number;
  E: number;
  r: number;
  /** The plain stretch d (E 0.65), before hiding, easing or reaching. */
  base: number;
  eased: boolean;
  hidden: boolean;
  reach: boolean;
  band: { lo: number; hi: number };
}

export interface Deadline { track: string; date: string; daysLeft: number }

export function emptyIndex(): ContentIndex {
  return {
    docs: new Map(), usedBy: new Map(), anchors: new Map(), problems: new Map(), katas: new Map(),
    bank: new Map(), tracks: [], methods: new Map(), warnings: [],
  };
}

/** FORMAT.md's area table order; areas not in it follow, alphabetically. */
const AREA_ORDER = ['nt', 'comb', 'an', 'la', 'gen', 'dd', 'ca', 'th', 'mc', 'pd', 'sp', 'op', 'el', 'mat', 'qc', 'bio'];
const FOLDERS = new Set(['basics', 'topics', 'katas', 'bank', 'cards']);
const MARK_VERBS: readonly string[] = ['lost', 'easy', 'forgot', 'clear'];

function uniq<T>(a: readonly (T | null | undefined)[]): T[] {
  const out: T[] = [];
  for (const x of a) if (x != null && !out.includes(x)) out.push(x);
  return out;
}

function parseMs(t: unknown): number {
  return typeof t === 'string' ? Date.parse(t) : NaN;
}

/** Valid events, deduped by id, sorted by time then id. */
export function sortEvents(events: readonly StudyEvent[]): { events: StudyEvent[]; skipped: number } {
  const seen = new Set<string>();
  const out: { e: StudyEvent; ms: number }[] = [];
  let skipped = 0;
  for (const e of events) {
    const ms = parseMs(e && e.t);
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.type !== 'string' || !isFinite(ms)) { skipped++; continue; }
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ e, ms });
  }
  out.sort((a, b) => a.ms - b.ms || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
  return { events: out.map(x => x.e), skipped };
}

/* ------------------------------------------------------------------------------------------ *
 * Coercion: synced logs come from other devices and other plugin versions, so every field is
 * checked before the fold uses it. A wrong type becomes a safe default instead of a throw.
 * ------------------------------------------------------------------------------------------ */

function str(x: unknown): string {
  return typeof x === 'string' ? x : typeof x === 'number' && isFinite(x) ? String(x) : '';
}

function num(x: unknown): number {
  const n = typeof x === 'number' || typeof x === 'string' ? Number(x) : NaN;
  return isFinite(n) ? n : 0;
}

function numOrNull(x: unknown): number | null {
  if (x == null || x === '') return null;
  const n = typeof x === 'number' || typeof x === 'string' ? Number(x) : NaN;
  return isFinite(n) ? n : null;
}

function bool(x: unknown): boolean {
  return x === true || x === 1 || x === 'true';
}

/** A list of ids: an array keeps its strings (numbers as text); anything else is empty. */
function list(x: unknown): string[] {
  return Array.isArray(x) ? x.map(y => (typeof y === 'number' && isFinite(y) ? String(y) : y)).filter((y): y is string => typeof y === 'string' && y !== '') : [];
}

/** A copy of the event with every field the fold reads coerced to its type (strings, numbers, booleans, lists). Unknown types pass through. */
export function coerceEvent(e: StudyEvent): StudyEvent {
  const x = e as unknown as Record<string, unknown>;
  const base = { v: 1, id: str(x.id), t: str(x.t), dev: str(x.dev), type: str(x.type) };
  let out: Record<string, unknown>;
  switch (base.type) {
    case 'mark': out = { doc: str(x.doc), a: str(x.a), verb: str(x.verb), build: num(x.build) }; break;
    case 'attempt': out = { doc: str(x.doc), a: str(x.a), strokes: Math.max(0, num(x.strokes)) }; break;
    case 'rewrite-request': out = { doc: str(x.doc), a: str(x.a), build: num(x.build), ...(typeof x.rev === 'string' && x.rev ? { rev: x.rev } : {}) }; break;
    case 'rebuild-request': out = { doc: str(x.doc), a: str(x.a), build: num(x.build) }; break;
    case 'fog':
      out = {
        doc: str(x.doc), proof: str(x.proof), build: num(x.build), reveals: Math.max(0, num(x.reveals)), steps: Math.max(0, num(x.steps)),
        done: bool(x.done), clean: typeof x.clean === 'boolean' ? x.clean : undefined,
      };
      break;
    case 'drill': out = { doc: str(x.doc), item: str(x.item), grade: str(x.grade), ms: num(x.ms), src: str(x.src) || 'drill' }; break;
    case 'call': out = { item: str(x.item), conf: numOrNull(x.conf), hidden: bool(x.hidden), reach: bool(x.reach), d: numOrNull(x.d) }; break;
    case 'settle':
      out = {
        item: str(x.item), verdict: str(x.verdict), help: bool(x.help) ? 1 : 0, gaveUp: bool(x.gaveUp), ms: num(x.ms),
        called: list(x.called), used: list(x.used), hidden: bool(x.hidden), hook: bool(x.hook),
      };
      break;
    case 'kata':
      out = {
        kata: str(x.kata), pass: bool(x.pass), runs: num(x.runs), gaveUp: bool(x.gaveUp), ms: num(x.ms),
        called: list(x.called), used: list(x.used), hidden: bool(x.hidden),
      };
      break;
    case 'stage-set': out = { basic: str(x.basic), stage: num(x.stage) }; break;
    case 'open': out = { doc: str(x.doc) }; break;
    default: return e;
  }
  return { ...base, ...out } as unknown as StudyEvent;
}

/** The passage a request was made on: `a` is `<doc>#<anchor>` when the mark sat in another doc than the one to rebuild. */
export function requestTarget(r: { doc: string; a: string }): { doc: string; a: string } {
  const i = r.a.indexOf('#');
  return i > 0 ? { doc: r.a.slice(0, i), a: r.a.slice(i + 1).replace(/^\^/, '') } : { doc: r.doc, a: r.a };
}

/* ------------------------------------------------------------------------------------------ *
 * The state
 * ------------------------------------------------------------------------------------------ */

export class StudyState {
  readonly basics = new Map<string, BasicRec>();
  readonly ratings = new Map<string, AreaRec>();
  /** Problems and katas by item id; the first settle rates, later ones only re-tick the methods. */
  readonly settled = new Map<string, SettleRec>();
  /** Theorem hooks, every attempt. */
  readonly hooks: SettleRec[] = [];
  readonly methods: MethodRec[] = [];
  readonly marks: MarkRec[] = [];
  readonly requests: RequestRec[] = [];
  readonly attempts: AttemptRec[] = [];
  readonly calls = new Map<string, CallRec>();
  /** `<doc>#<item>` -> time of the last drill on it. */
  readonly drilled = new Map<string, number>();
  readonly events: StudyEvent[];
  /** Events the fold could not use (bad shape or time, unknown type, unknown basic). */
  skipped = 0;
  /** The first event's time, for the start point of each rating history. */
  readonly t0: string | null;

  constructor(readonly content: ContentIndex, events: readonly StudyEvent[]) {
    for (const d of content.docs.values()) if (d.kind === 'basic') this.basics.set(d.id, newBasic(d.id));
    const sorted = sortEvents(events);
    this.skipped = sorted.skipped;
    this.t0 = sorted.events.length ? sorted.events[0].t : null;
    // One bad event from a synced log must never break every query on every device: each event is
    // coerced to its field types, and one the fold still cannot apply is counted and skipped.
    const kept: StudyEvent[] = [];
    for (const raw of sorted.events) {
      try {
        const e = coerceEvent(raw);
        this.apply(e);
        kept.push(e);
      } catch {
        this.skipped++;
      }
    }
    this.events = kept;
  }

  /* -------------------------------------------------------------------- content helpers */

  doc(id: string): StudyDoc | null {
    return this.content.docs.get(id) || null;
  }

  isBasic(id: string | null | undefined): id is string {
    return !!id && this.content.docs.get(id)?.kind === 'basic';
  }

  areaOf(docId: string): string | null {
    const d = this.content.docs.get(docId);
    return d && d.areas.length ? d.areas[0] : null;
  }

  /** The basic a method id or a `basic/anchor` pair is taught in, if it is a basic. */
  methodBasics(m: string): string[] {
    const slash = m.indexOf('/');
    const doc = slash > 0 ? m.slice(0, slash) : this.content.methods.get(m)?.doc;
    return this.isBasic(doc) ? [doc] : [];
  }

  /**
   * A track serves a doc when the doc lists it, its areas include the doc's area, or its docs column
   * matches. The docs column is `;`-separated sections, each `[folder] glob, glob`: a section matches
   * when the doc sits in one of the section's folders (if it names any) and its id matches one of the
   * globs; a section of folder names only matches the whole folder. One matching section is enough.
   * A row with no `;` is a single section and matches exactly as it always did.
   */
  trackMatches(t: Track, d: StudyDoc): boolean {
    if (d.tracks.includes(t.id)) return true;
    if (t.areas.some(a => d.areas.includes(a))) return true;
    const parts = d.path.split('/');
    const folder = parts.length > 1 ? parts[parts.length - 2] : '';
    for (const section of t.docs.split(';')) {
      const tokens = section.split(/[\s,]+/).filter(Boolean);
      if (!tokens.length) continue;
      const folders = tokens.filter(x => FOLDERS.has(x));
      const globs = tokens.filter(x => !FOLDERS.has(x));
      if (folders.length && !folders.includes(folder)) continue;
      if (globs.length ? globs.some(g => globMatch(g, d.id)) : folders.length > 0) return true;
    }
    return false;
  }

  /** Tracks that count on a day: weight > 0 and not over (a range counts until its end). */
  liveTracks(day: string): Track[] {
    return this.content.tracks.filter(t => t.weight > 0 && (!t.deadline || dayDiff(t.until || t.deadline, day) >= 0));
  }

  /** Days from `day` to a live track's deadline (0 inside a range), or null without a date. */
  trackDays(t: Track, day: string): number | null {
    return t.deadline ? Math.max(0, dayDiff(t.deadline, day)) : null;
  }

  /** The nearest deadline of a track that serves the doc (weight-0 and finished tracks ignored). */
  deadline(docId: string, day: string): Deadline | null {
    const d = this.doc(docId);
    if (!d) return null;
    let best: Deadline | null = null;
    for (const t of this.content.tracks) {
      if (t.weight === 0 || !t.deadline || dayDiff(t.until || t.deadline, day) < 0 || !this.trackMatches(t, d)) continue;
      const daysLeft = Math.max(0, dayDiff(t.deadline, day));
      if (!best || daysLeft < best.daysLeft) best = { track: t.id, date: t.deadline, daysLeft };
    }
    return best;
  }

  /** Every rating area the content or the logs mention, in FORMAT.md's order. */
  areas(): string[] {
    const set = new Set<string>();
    for (const d of this.content.docs.values()) for (const a of d.areas) set.add(a);
    for (const p of this.content.problems.values()) if (p.area) set.add(p.area);
    for (const k of this.content.katas.values()) if (k.area) set.add(k.area);
    for (const t of this.content.tracks) for (const a of t.areas) set.add(a);
    for (const a of this.ratings.keys()) set.add(a);
    const known = AREA_ORDER.filter(a => set.has(a));
    const rest = [...set].filter(a => !AREA_ORDER.includes(a)).sort();
    return [...known, ...rest];
  }

  /* ----------------------------------------------------------------------------- fold */

  private apply(e: StudyEvent): void {
    const ms = Date.parse(e.t);
    const day = eventDay(e.t);
    switch (e.type) {
      case 'mark': {
        if (!MARK_VERBS.includes(e.verb)) { this.skipped++; return; }
        this.touch(e.doc, day);
        let action: MarkRec['action'] = null;
        if (e.verb === 'forgot') {
          this.pullForward([...(this.isBasic(e.doc) ? [e.doc] : []), ...this.passageBasics(e.doc, e.a)], day);
        } else if (e.verb === 'lost') {
          const act = this.triageAt(e.doc, e.a, 'lost', ms);
          action = act.action;
          if (act.action === 'budget-exhausted' && act.drill) this.pullForward([act.drill], day);
        }
        this.marks.push({ doc: e.doc, a: e.a, verb: e.verb, t: e.t, ms, build: Number(e.build) || 0, action });
        return;
      }
      case 'attempt':
        this.touch(e.doc, day);
        this.attempts.push({ doc: e.doc, a: e.a, strokes: Math.max(0, Number(e.strokes) || 0), t: e.t, ms });
        return;
      case 'rewrite-request':
      case 'rebuild-request': {
        const rev = e.type === 'rewrite-request' ? e.rev : undefined;
        this.requests.push({
          kind: e.type === 'rewrite-request' ? 'rewrite' : 'rebuild', doc: e.doc, a: e.a, t: e.t, ms,
          build: Number(e.build) || 0, rev: typeof rev === 'string' ? rev : null,
        });
        return;
      }
      case 'fog':
        this.touch(e.doc, day);
        if (!e.done) return;
        if (!this.isBasic(e.doc)) { this.skipped++; return; }
        this.applyResult(e.doc, fogGrade(e.reveals, e.steps, e.clean), 'fog', day, e.t, ms);
        return;
      case 'drill':
        this.touch(e.doc, day);
        this.drilled.set(`${e.doc}#${e.item}`, ms);
        // Recall drills on numbers cards have no basic: they are logged, and move no stage.
        if (this.isBasic(e.doc) && (e.grade === 'clean' || e.grade === 'shaky' || e.grade === 'failed')) {
          this.applyResult(e.doc, e.grade, e.src === 'drill' ? 'drill' : e.src, day, e.t, ms);
        }
        return;
      case 'call':
        this.calls.set(e.item, { hidden: !!e.hidden, reach: !!e.reach, d: e.d ?? null, conf: e.conf ?? null, t: e.t });
        return;
      case 'settle':
        if (e.hook) this.settleHook(e, day, ms);
        else this.settleProblem(e, day, ms);
        return;
      case 'kata':
        this.settleKata(e, day, ms);
        return;
      case 'stage-set': {
        const b = this.basics.get(e.basic);
        if (!b) { this.skipped++; return; }
        b.stage = clampStage(e.stage);
        if (!b.opened) b.opened = day;
        if (b.due == null) b.due = addDays(day, intervalFor(b.stage, this.deadline(b.id, day)?.daysLeft));
        return;
      }
      case 'open':
        this.touch(e.doc, day);
        return;
      default:
        // An event type newer than this engine.
        this.skipped++;
    }
  }

  /** The first event on a basic opens it: stage 1, first drill due one stage-1 interval later. */
  private touch(docId: string, day: string): void {
    const b = this.basics.get(docId);
    if (!b || b.opened) return;
    b.opened = day;
    if (b.stage === 0 && !b.history.length) b.stage = 1;
    if (b.due == null) b.due = addDays(day, intervalFor(b.stage, this.deadline(docId, day)?.daysLeft));
  }

  /** One graded retrieval of a basic (drill, fog, hook, held problem). The stage rises at most once a day. */
  private applyResult(id: string, grade: Grade, src: string, day: string, t: string, ms: number): void {
    const b = this.basics.get(id);
    if (!b) return;
    if (!b.opened) b.opened = day;
    const from = b.stage;
    const pushBefore = b.push;
    if (grade === 'clean') {
      if (b.raisedOn !== day) { b.stage = nextStage(b.stage, 'clean'); b.raisedOn = day; }
      b.streak += 1;
    } else if (grade === 'shaky') {
      b.streak = 0;
    } else {
      b.stage = 0;
      b.streak = 0;
      b.raisedOn = null;
    }
    b.last = grade;
    b.push = nextPush(pushBefore, grade, b.stage, b.streak);
    b.due = addDays(day, intervalFor(b.stage, this.deadline(id, day)?.daysLeft));
    b.history.push({ t, ms, grade, from, to: b.stage, src });
    if (b.history.length > HISTORY_MAX) b.history.splice(0, b.history.length - HISTORY_MAX);
  }

  private pullForward(ids: string[], day: string): void {
    for (const id of uniq(ids)) {
      const b = this.basics.get(id);
      if (b && b.due != null && dayDiff(b.due, day) > 0) b.due = day;
    }
  }

  area(area: string): AreaRec {
    let a = this.ratings.get(area);
    if (!a) {
      const r = startRating(area);
      a = { r, hist: [{ t: this.t0 || '', r }], miss: 0, clean: 0 };
      this.ratings.set(area, a);
    }
    return a;
  }

  private rate(area: string, d: number, score: number, k: number, t: string, streaks: boolean, reach: boolean): { E: number; rBefore: number; rAfter: number } {
    const a = this.area(area);
    const rBefore = a.r;
    const E = expected(d, rBefore);
    a.r = rBefore + k * (score - E);
    a.hist.push({ t, r: a.r });
    if (a.hist.length > RATING_HISTORY_MAX) a.hist.splice(0, a.hist.length - RATING_HISTORY_MAX);
    if (streaks) {
      if (score === 1) { a.clean += 1; a.miss = 0; } else if (score === 0) { a.miss += 1; a.clean = 0; } else { a.miss = 0; a.clean = 0; }
      if (reach) a.clean = 0; // the reach is spent
    }
    return { E, rBefore, rAfter: a.r };
  }

  /** Method identification: every method it took was called. Re-ticks replace the item's entry in place. */
  private countMethods(rec: SettleRec): void {
    const i = this.methods.findIndex(m => m.kind === rec.kind && m.item === rec.item);
    if (rec.hit == null) { if (i >= 0) this.methods.splice(i, 1); return; }
    const m: MethodRec = { item: rec.item, kind: rec.kind, area: rec.area, hidden: rec.hidden, hit: rec.hit, t: rec.t };
    if (i >= 0) this.methods[i] = m; else this.methods.push(m);
  }

  private retick(rec: SettleRec, called: string[], used: string[]): void {
    if (used.length) rec.took = used;
    rec.called = called;
    rec.hit = rec.score != null && rec.took.length ? rec.took.every(m => called.includes(m)) : null;
    this.countMethods(rec);
  }

  /** A held problem (no help) is a clean retrieval of the basics its methods are taught in. */
  private holdMovesBasics(took: string[], day: string, t: string, ms: number): void {
    const basics: string[] = [];
    for (const m of took) basics.push(...this.methodBasics(m));
    for (const b of uniq(basics)) this.applyResult(b, 'clean', 'problem', day, t, ms);
  }

  private settleProblem(e: Extract<StudyEvent, { type: 'settle' }>, day: string, ms: number): void {
    const called = uniq(e.called || []);
    const used = uniq(e.used || []);
    const prev = this.settled.get(e.item);
    if (prev) { this.retick(prev, called, used); return; }
    const p = this.content.problems.get(e.item) || null;
    const help = !!e.help || !!e.gaveUp;
    const score = scoreFor(e.verdict, help);
    const hidden = !!e.hidden;
    const reach = !hidden && !!this.calls.get(e.item)?.reach;
    const took = used.length ? used : p ? uniq(p.methods) : [];
    const area = p ? p.area : null;
    const d = p && p.d != null && isFinite(p.d) ? p.d : null;
    const rec: SettleRec = {
      item: e.item, kind: 'problem', area, d, verdict: e.verdict, help, score, E: null, rBefore: null, rAfter: null, hidden, reach,
      t: e.t, day, called, took, hit: score != null && took.length ? took.every(m => called.includes(m)) : null, basic: null, grade: null,
    };
    if (score != null && area && d != null) Object.assign(rec, this.rate(area, d, score, K, e.t, true, reach));
    this.settled.set(e.item, rec);
    this.countMethods(rec);
    if (score === 1) this.holdMovesBasics(took, day, e.t, ms);
  }

  private settleKata(e: Extract<StudyEvent, { type: 'kata' }>, day: string, ms: number): void {
    const called = uniq(e.called || []);
    const used = uniq(e.used || []);
    const prev = this.settled.get(e.kata);
    if (prev) { this.retick(prev, called, used); return; }
    const k = this.content.katas.get(e.kata) || null;
    const score = kataScore(!!e.pass, Number(e.runs) || 0, !!e.gaveUp);
    const hidden = !!e.hidden || k?.level === 'hidden';
    const reach = !hidden && !!this.calls.get(e.kata)?.reach;
    const area = k ? k.area || null : null;
    const d = k && k.d != null && isFinite(k.d) ? k.d : null;
    const rec: SettleRec = {
      item: e.kata, kind: 'kata', area, d, verdict: score > 0 ? 'held' : e.gaveUp ? 'gave up' : 'missed', help: score === 0.75, score,
      E: null, rBefore: null, rAfter: null, hidden, reach, t: e.t, day, called, took: used,
      hit: used.length ? used.every(m => called.includes(m)) : null, basic: null, grade: null,
    };
    if (area && d != null) Object.assign(rec, this.rate(area, d, score, K, e.t, true, reach));
    this.settled.set(e.kata, rec);
    this.countMethods(rec);
    // A kata moves no stage: stages move only by drills, fog results, hooks and held problems.
  }

  /**
   * A theorem posed as a problem before its proof (push level 3; Decision 2). Grades its basic like a
   * drill (held clean, held after help shaky, missed or blind failed, moot nothing) and moves the
   * area rating at K 0.3 with the proof's (d x); a proof without (d x) moves no rating. The stretch
   * streaks do not move: they steer bank picks.
   */
  private settleHook(e: Extract<StudyEvent, { type: 'settle' }>, day: string, ms: number): void {
    // Ticks sent again for the same attempt update the methods only: one grading per attempt.
    const prev = this.hooks.find(r => r.item === e.item);
    if (prev) { this.retick(prev, uniq(e.called || []), uniq(e.used || [])); return; }
    const h = this.resolveHook(e.item);
    if (!h) { this.skipped++; return; }
    const help = !!e.help || !!e.gaveUp;
    const score = scoreFor(e.verdict, help);
    const grade: DrillGrade | null = e.verdict === 'moot' ? null : e.verdict === 'held' ? (help ? 'shaky' : 'clean') : 'failed';
    const area = this.areaOf(h.doc.id);
    const d = h.proof && h.proof.d != null && isFinite(h.proof.d) ? h.proof.d : null;
    const called = uniq(e.called || []);
    const took = uniq(e.used || []);
    const rec: SettleRec = {
      item: e.item, kind: 'theorem', area, d, verdict: e.verdict, help, score, E: null, rBefore: null, rAfter: null,
      hidden: false, reach: false, t: e.t, day, called, took, hit: score != null && took.length ? took.every(m => called.includes(m)) : null,
      basic: h.doc.id, grade,
    };
    if (grade) this.applyResult(h.doc.id, grade, 'hook', day, e.t, ms);
    if (score != null && area && d != null) Object.assign(rec, this.rate(area, d, score, K_HOOK, e.t, false, false));
    this.hooks.push(rec);
  }

  /** `thm:<doc>#<anchor>` (canonical), also `<doc>#<anchor>` or `<doc>/<anchor>`, with an optional `#<attempt>`; the anchor is the theorem's or its proof's. */
  resolveHook(item: string): { doc: StudyDoc; proof: StudyDoc['proofs'][number] | null; theorem: string } | null {
    const m = /^(?:thm:)?([^#/]+)[#/]\^?([^#/]+)(?:#\d+)?$/.exec(String(item || ''));
    if (!m) return null;
    const doc = this.content.docs.get(m[1]);
    if (!doc || doc.kind !== 'basic') return null;
    const a = m[2];
    const proof = doc.proofs.find(p => p.anchor === a || p.of === a) || null;
    const theorem = proof?.of || (doc.theorems.some(t => t.anchor === a) ? a : null);
    if (!proof && !theorem) return null;
    return { doc, proof, theorem: theorem || a };
  }

  /* --------------------------------------------------------------------- basics queries */

  weak(id: string): boolean {
    const b = this.basics.get(id);
    return !!b && b.opened != null && (b.stage <= 1 || b.last === 'failed');
  }

  pushLevel(id: string): number {
    const b = this.basics.get(id);
    return b ? Math.max(0, Math.min(3, b.push)) : 0;
  }

  inPush(area: string): boolean {
    for (const b of this.basics.values()) if (b.push >= 3 && this.areaOf(b.id) === area) return true;
    return false;
  }

  weakest(ids: string[]): string | null {
    const L = uniq(ids).filter(id => this.basics.has(id)).sort((a, b) => {
      const A = this.basics.get(a)!, B = this.basics.get(b)!;
      const da = A.due ? dayNum(A.due) : Infinity, db = B.due ? dayNum(B.due) : Infinity;
      return A.stage - B.stage || (da === db ? 0 : da - db) || (a < b ? -1 : 1);
    });
    return L.length ? L[0] : null;
  }

  /** The drill item for a basic: its derive prompt drilled longest ago, else its first proof or theorem. */
  drillItem(id: string): string {
    const d = this.doc(id);
    if (!d) return '';
    if (d.derives.length) {
      let best = d.derives[0].anchor, bestMs = Infinity;
      for (const x of d.derives) {
        const last = this.drilled.get(`${id}#${x.anchor}`) ?? -Infinity;
        if (last < bestMs) { best = x.anchor; bestMs = last; }
      }
      return best;
    }
    return d.proofs[0]?.anchor || d.theorems[0]?.anchor || '';
  }

  /* -------------------------------------------------------------------- passages, triage */

  /**
   * Basics a passage links to: links from the passage (or its anchored items) to basics, and the
   * needs of a visible kata it links. A problem or solution passage links nothing here, so a scaffold
   * never names a hook's method.
   */
  linkedBasics(docId: string, anchor: string): string[] {
    const d = this.doc(docId);
    if (!d) return [];
    const p = this.content.anchors.get(docId)?.get(anchor);
    if (p?.block && (p.block.type === 'problem' || p.block.type === 'solution')) return [];
    const froms = new Set([anchor]);
    if (p && p.anchor === anchor) for (const it of p.items || []) froms.add(it.anchor);
    const out: string[] = [];
    const add = (id: string) => { if (id !== docId && this.isBasic(id) && !out.includes(id)) out.push(id); };
    for (const l of d.links) {
      if (!froms.has(l.from) || l.external || !l.toDoc) continue;
      const target = this.doc(l.toDoc);
      if (!target) continue;
      if (target.kind === 'basic') add(target.id);
      else if (target.kind === 'kata' && target.kata?.level !== 'hidden') for (const n of target.needs) add(n);
    }
    return out;
  }

  /** What the scaffold shows: the linked basics, failing that the doc's needs. Only linked basics decide a rebuild. */
  passageBasics(docId: string, anchor: string): string[] {
    const linked = this.linkedBasics(docId, anchor);
    if (linked.length) return linked;
    const d = this.doc(docId);
    return d ? uniq(d.needs.filter(n => n !== docId && this.isBasic(n))) : [];
  }

  /** Decision 5: answered when the doc's build is higher than the request's and (for a rewrite) the anchor's hash changed. */
  answered(r: RequestRec): boolean {
    const d = this.doc(r.doc);
    if (!d || d.build <= r.build) return false;
    if (r.kind === 'rebuild' || r.rev == null) return true;
    const p = this.content.anchors.get(r.doc)?.get(r.a);
    return !p || p.hash !== r.rev;
  }

  private requestsOf(kind: RequestRec['kind'], doc: string, ms: number, a?: string): RequestRec[] {
    return this.requests.filter(r => r.kind === kind && r.doc === doc && r.ms <= ms && (a === undefined || r.a === a));
  }

  pendingRebuild(basic: string, ms: number): RequestRec | null {
    const L = this.requestsOf('rebuild', basic, ms).filter(r => !this.answered(r));
    return L.length ? L[L.length - 1] : null;
  }

  /** The latest rebuild of the doc that has landed, by build. */
  landedRebuild(doc: string, ms: number): RequestRec | null {
    let best: RequestRec | null = null;
    for (const r of this.requestsOf('rebuild', doc, ms)) if (this.answered(r) && (!best || r.build >= best.build)) best = r;
    return best;
  }

  /** A basic may be rebuilt when no rebuild is waiting, and, after one landed, only once a graded retrieval came after it. */
  rebuildable(basic: string, ms: number): boolean {
    const reqs = this.requestsOf('rebuild', basic, ms);
    if (!reqs.length) return true;
    if (reqs.some(r => !this.answered(r))) return false;
    const last = reqs[reqs.length - 1];
    const b = this.basics.get(basic);
    return !!b && b.history.some(h => h.ms > last.ms);
  }

  /** The rewrite budget: rewrite requests since the doc's last rebuild landed (Decision 6). */
  budget(doc: string, ms: number): { left: number; used: number } {
    const rb = this.landedRebuild(doc, ms);
    const used = this.requestsOf('rewrite', doc, ms).filter(r => !rb || r.build > rb.build).length;
    return { left: Math.max(0, REWRITE_MAX - used), used };
  }

  /** The first rationed lost mark of the passage's current cycle, or null when a new cycle starts. */
  private cycleStart(doc: string, a: string, ms: number): MarkRec | null {
    const L = this.marks.filter(m => m.doc === doc && m.a === a && m.ms <= ms);
    let after = -Infinity;
    for (const m of L) if (m.verb !== 'lost') after = m.ms;
    const rws = this.requestsOf('rewrite', doc, ms, a);
    const rw = rws.length ? rws[rws.length - 1] : null;
    const rb = this.isBasic(doc) ? this.landedRebuild(doc, ms) : null;
    if (rw) after = Math.max(after, rw.ms);
    for (const m of L) {
      if (m.verb !== 'lost' || m.ms <= after) continue;
      if (m.action !== 'scaffold' && m.action !== 'eligible' && m.action !== 'budget-exhausted') continue;
      if (rw && m.build <= rw.build) continue;
      if (rb && m.build <= rb.build) continue;
      return m;
    }
    return null;
  }

  /** Strokes in the attempt box: the latest attempt event since the cycle started. */
  private attemptInk(doc: string, a: string, sinceMs: number, ms: number): number {
    let s = 0;
    for (const x of this.attempts) if (x.doc === doc && x.a === a && x.ms >= sinceMs && x.ms <= ms) s = x.strokes;
    return s;
  }

  /** What a margin mark should do at time ms, before it is logged (SPEC.md, Decisions 5 and 6). */
  triageAt(docId: string, anchor: string, verb: MarkVerb, ms: number): TriageAction {
    if (verb !== 'lost') return { action: 'noted' };
    const d = this.doc(docId);
    if (!d || !anchor) return { action: 'noted' };
    const rws = this.requestsOf('rewrite', docId, ms, anchor);
    const rw = rws.length ? rws[rws.length - 1] : null;
    if (rw && !this.answered(rw)) return { action: 'requested', at: rw.t };

    // 1. The gap is in a basic: the passage links a weak basic, or the mark is inside a basic.
    // Rebuild the whole basic (budget-free), once; after it lands, only a new retrieval opens another.
    // The weak linked basic wins over the marked doc: the gap is downstream (the demo's order).
    const weakLinked = this.linkedBasics(docId, anchor).filter(b => this.weak(b));
    const targets = weakLinked.filter(b => this.rebuildable(b, ms));
    if (targets.length) return { action: 'rebuild-basic', basics: targets };
    if (d.kind === 'basic') {
      const pr = this.pendingRebuild(docId, ms);
      if (pr) return { action: 'requested', at: pr.t };
      if (this.rebuildable(docId, ms)) return { action: 'rebuild-basic', basics: [docId] };
    }
    const waiting = weakLinked.map(b => this.pendingRebuild(b, ms)).filter((r): r is RequestRec => !!r).sort((x, y) => x.ms - y.ms);
    if (waiting.length) return { action: 'requested', at: waiting[waiting.length - 1].t };

    // 2. Rationed: the scaffold first; a rewrite only after a day still lost with ink in the attempt box.
    const rest = this.passageBasics(docId, anchor);
    const start = this.cycleStart(docId, anchor, ms);
    if (!start) return { action: 'scaffold', basics: rest, since: isoLocal(new Date(ms)), eligibleAt: isoLocal(new Date(ms + ELIGIBLE_MS)) };
    const at = start.ms + ELIGIBLE_MS;
    if (ms < at || this.attemptInk(docId, anchor, start.ms, ms) <= 0) {
      return { action: 'scaffold', basics: rest, since: start.t, eligibleAt: isoLocal(new Date(at)) };
    }
    const bud = this.budget(docId, ms);
    if (bud.left <= 0) return { action: 'budget-exhausted', drill: this.weakest(rest.length ? rest : d.kind === 'basic' ? [docId] : []) };
    return { action: 'eligible', left: bud.left };
  }

  /** Open marks, newest first: the latest mark per passage, without clears and without lost marks a landed rewrite or rebuild answered. */
  openMarks(ms: number, doc?: string): { doc: string; a: string; verb: MarkVerb; t: string; build: number }[] {
    const latest = new Map<string, MarkRec>();
    for (const m of this.marks) if (m.ms <= ms && (!doc || m.doc === doc)) latest.set(`${m.doc}#${m.a}`, m);
    const out: MarkRec[] = [];
    for (const m of latest.values()) {
      if (m.verb === 'clear') continue;
      if (m.verb === 'lost') {
        const done = this.requests.some(r => r.ms <= ms && r.ms >= m.ms && this.requestAnswersMark(r, m) && this.answered(r));
        if (done) continue;
      }
      out.push(m);
    }
    out.sort((x, y) => y.ms - x.ms || (x.doc + x.a < y.doc + y.a ? -1 : 1));
    return out.map(m => ({ doc: m.doc, a: m.a, verb: m.verb, t: m.t, build: m.build }));
  }

  /**
   * A request covers a lost mark when it was made on that passage (a rewrite, or a rebuild whose `a`
   * names it, as `<doc>#<anchor>` when the mark sat in another doc), or when it rebuilds the marked doc itself.
   */
  requestAnswersMark(r: RequestRec, m: { doc: string; a: string }): boolean {
    const at = requestTarget(r);
    if (at.doc === m.doc && at.a === m.a) return true;
    return r.kind === 'rebuild' && r.doc === m.doc;
  }

  /** A later request on the same doc, anchor and kind supersedes the earlier one. */
  pendingRequests(ms: number): { doc: string; a: string; kind: 'rewrite' | 'rebuild'; t: string; build: number }[] {
    const latest = new Map<string, RequestRec>();
    for (const r of this.requests) if (r.ms <= ms) latest.set(`${r.kind}:${r.doc}#${r.a}`, r);
    return [...latest.values()].filter(r => !this.answered(r)).map(r => ({ doc: r.doc, a: r.a, kind: r.kind, t: r.t, build: r.build }));
  }

  /* --------------------------------------------------------------- ratings and picks */

  rating(area: string): number {
    return this.ratings.get(area)?.r ?? startRating(area);
  }

  streaks(area: string): { miss: number; clean: number } {
    const a = this.ratings.get(area);
    return { miss: a ? a.miss : 0, clean: a ? a.clean : 0 };
  }

  /** p_id on hidden settles (problems and katas), over the last 20, smoothed (Decision 1). */
  methodAccuracy(area?: string): { p: number; n: number; hits: number } {
    const L = this.methods.filter(m => m.hidden && (m.kind === 'problem' || m.kind === 'kata') && (!area || m.area === area)).slice(-P_ID_WINDOW);
    const hits = L.filter(m => m.hit).length;
    return { p: pIdSmoothed(hits, L.length), n: L.length, hits };
  }

  /**
   * Stretch target E 0.65 and its band. Hidden: E = clamp(0.65 / p_id, 0.65, 0.88) (Decision 1).
   * Eased one step after 2 misses in a row. Reach (after 3 clean holds): E 0.40.
   */
  target(area: string, opt: { hidden?: boolean; reach?: boolean } = {}): Target {
    const r = this.rating(area);
    const st = this.streaks(area);
    const base = dForE(r, E_TARGET);
    let d: number;
    let eased = false;
    const hidden = !!opt.hidden;
    const reach = !!opt.reach && !hidden;
    if (reach) d = dForE(r, E_REACH);
    else {
      d = hidden ? dForE(r, hiddenE(this.methodAccuracy().p)) : base;
      if (st.miss >= MISS_RUN) { d -= EASE_STEP; eased = true; }
    }
    return { d, E: expected(d, r), r, base, eased, hidden, reach, band: { lo: dForE(r, E_HI), hi: dForE(r, E_LO) } };
  }

  /** An area is practised when a basic in it was opened or something in it was settled and counted. General reasoning always is. */
  practised(area: string): boolean {
    if (area === GEN_AREA) return true;
    for (const b of this.basics.values()) if (b.opened && this.areaOf(b.id) === area) return true;
    for (const s of this.settled.values()) if (s.area === area && s.score !== null) return true;
    return false;
  }

  private pickableProblem(p: Problem): boolean {
    return p.d != null && isFinite(p.d) && !p.unchecked && !!p.area && !this.settled.has(p.id);
  }

  /**
   * A problem can be a hidden-topic pick when its methods are known (a solution's methods line, or a
   * tags row) and its file does not say `hidden: never` in the frontmatter — the bank file for bank
   * problems, the doc for invented ones. A `hidden: never` file names the topic (a course chapter),
   * so its problems only ever come up as visible picks.
   */
  hiddenOK(p: Problem): boolean {
    if (p.methods.length === 0) return false;
    const file = this.doc(p.bank ? p.bank.bank : p.doc);
    return !file || file.meta.hidden !== 'never';
  }

  private closest<T extends { id: string }>(cands: T[], dOf: (x: T) => number, targetOf: (x: T) => number, day: string): T | null {
    let best: T | null = null, bs = Infinity, bh = 0;
    for (const x of cands) {
      const s = Math.abs(dOf(x) - targetOf(x)), h = hash01(day + '|' + x.id);
      if (s < bs - 1e-9 || (Math.abs(s - bs) <= 1e-9 && h < bh)) { best = x; bs = s; bh = h; }
    }
    return best;
  }

  /** Eased picks keep to items at or below the plain stretch target while any are left: never harder than an uneased pick. */
  private easeFilter<T>(area: string, cands: T[], dOf: (x: T) => number): T[] {
    const tg = this.target(area);
    if (!tg.eased) return cands;
    const easier = cands.filter(x => dOf(x) <= tg.base + 1e-9);
    return easier.length ? easier : cands;
  }

  /** Regular: the area's problems nearest its target. Hidden: from another practised area (or gen), nearest that area's hidden target. area null: any area. */
  pickProblemRaw(area: string | null, opt: { hidden?: boolean; reach?: boolean; exclude?: string[] }, day: string): Problem | null {
    const ex = opt.exclude || [];
    const hidden = !!opt.hidden;
    const reach = !!opt.reach && !hidden;
    let cands = [...this.content.problems.values()].filter(p => {
      if (!this.pickableProblem(p) || ex.includes(p.id)) return false;
      if (hidden) return this.hiddenOK(p) && p.area !== area && this.practised(p.area!);
      return area == null || p.area === area;
    });
    const dOf = (p: Problem) => p.d as number;
    if (!hidden && !reach && area != null) cands = this.easeFilter(area, cands, dOf);
    return this.closest(cands, dOf, p => this.target(hidden || area == null ? p.area! : area, { hidden, reach }).d, day);
  }

  problemPick(p: Problem, slotArea: string | null, hidden: boolean, reach: boolean): Pick {
    const d = p.d as number;
    const E = expected(d, this.rating(p.area!));
    const t = this.target(hidden || slotArea == null ? p.area! : slotArea, { hidden, reach });
    const easedOK = t.eased && d <= t.base + 1e-9;
    let why: string;
    if (hidden) why = `Topic hidden: naming the method is part of the problem. Pitched at E ${f2(t.E)}, so the whole chance with the method to find is about ${f2(E_TARGET)}.`;
    else if (reach) why = `Reach, after ${CLEAN_RUN} clean holds in a row: E ${f2(E)} (target E ${f2(E_REACH)}).`;
    else if (t.eased) why = easedOK ? `Eased one step after ${MISS_RUN} misses in a row: E ${f2(E)}.`
      : `After ${MISS_RUN} misses in a row this pick should be one step easier, but nothing easier is left in the bank: E ${f2(E)}.`;
    else why = `Stretch: E ${f2(E)} at r ${f2(t.r)} (band ${f2(E_LO)} to ${f2(E_HI)}).`;
    return { kind: 'problem', id: p.id, d, E, hidden, reach, why };
  }

  /** Areas that get problem slots: the areas of live tracks (their own and their docs'), nearest deadline first, that have a problem left to pick. */
  problemAreas(day: string): string[] {
    const live = this.liveTracks(day).sort((a, b) => {
      const da = this.trackDays(a, day) ?? Infinity, db = this.trackDays(b, day) ?? Infinity;
      return (da === db ? 0 : da - db) || b.weight - a.weight || (a.id < b.id ? -1 : 1);
    });
    const out: string[] = [];
    for (const t of live) {
      const areas = [...t.areas];
      for (const d of this.content.docs.values()) if (d.kind !== 'kata' && this.trackMatches(t, d)) areas.push(...d.areas);
      for (const a of areas) if (!out.includes(a) && this.pickProblemRaw(a, {}, day)) out.push(a);
    }
    return out;
  }

  /* ---------------------------------------------------------------------------- katas */

  /** Kata areas a live track serves (by the kata doc, its area or the track's docs), nearest deadline first. */
  kataAreas(day: string): string[] {
    const out: string[] = [];
    const live = this.liveTracks(day).sort((a, b) => (this.trackDays(a, day) ?? Infinity) - (this.trackDays(b, day) ?? Infinity));
    for (const t of live) {
      for (const k of this.content.katas.values()) {
        const d = this.doc(k.id);
        const serves = d ? this.trackMatches(t, d) : t.areas.includes(k.area);
        if (serves && k.area && !out.includes(k.area)) out.push(k.area);
      }
    }
    return out;
  }

  private kataD(k: Kata): number {
    return k.d as number;
  }

  /**
   * Hidden slots take hidden katas only. Otherwise: simple katas outside push mode; in push mode a
   * harder kata comes first when it is within reach (E >= 0.40), else the nearest visible kata; a reach
   * slot may take any visible kata.
   */
  pickKataRaw(areas: string[], opt: { hidden?: boolean; reach?: boolean; exclude?: string[] }, day: string): Kata | null {
    const ex = opt.exclude || [];
    const hidden = !!opt.hidden;
    const reach = !!opt.reach && !hidden;
    let all: Kata[] = [];
    for (const area of areas) {
      let cands = [...this.content.katas.values()].filter(k => k.area === area && k.d != null && isFinite(k.d) && !this.settled.has(k.id)
        && !ex.includes(k.id) && (hidden ? k.level === 'hidden' : k.level !== 'hidden'));
      if (!hidden && !reach) {
        if (this.inPush(area)) {
          const r = this.rating(area);
          const hard = cands.filter(k => k.level === 'hard' && expected(this.kataD(k), r) >= E_REACH - 1e-9);
          if (hard.length) cands = hard;
        } else {
          cands = cands.filter(k => k.level !== 'hard');
        }
        cands = this.easeFilter(area, cands, k => this.kataD(k));
      }
      all = all.concat(cands);
    }
    return this.closest(all, k => this.kataD(k), k => this.target(k.area, { hidden, reach }).d, day);
  }

  kataPick(k: Kata, hidden: boolean, reach: boolean): Pick {
    const d = this.kataD(k);
    const E = expected(d, this.rating(k.area));
    const t = this.target(k.area, {});
    const eased = !hidden && !reach && t.eased;
    const easedOK = eased && d <= t.base + 1e-9;
    const why = hidden ? 'Technique not named: work out what the spec needs.'
      : reach ? `Reach, after ${CLEAN_RUN} clean passes in a row: E ${f2(E)}.`
        : easedOK ? `Eased one step after ${MISS_RUN} misses in a row: E ${f2(E)}.`
          : eased ? `After ${MISS_RUN} misses in a row this kata should be one step easier, but nothing easier is left: E ${f2(E)}.`
            : k.level === 'hard' ? `Push mode: a harder multi-part kata, within reach (E ${f2(E)}).`
              : `Kata near your stretch (E ${f2(E)}).`;
    return { kind: 'kata', id: k.id, d, E, hidden, reach, why };
  }

  /* ---------------------------------------------------------------------------- Today */

  todayPlan(day: string, minutes: number): {
    date: string;
    drills: { basic: string; item: string; overdue: number; track: string | null }[];
    picks: Pick[];
    next: { track: string; date: string; days: number } | null;
    settledToday: number;
  } {
    // Drills: due basics, nearest deadline first, then most overdue.
    const due = [...this.basics.values()].filter(b => b.due != null && dayDiff(day, b.due) >= 0).map(b => {
      const dl = this.deadline(b.id, day);
      return { b, overdue: dayDiff(day, b.due!), dl };
    }).sort((x, y) => {
      const da = x.dl ? x.dl.daysLeft : Infinity, db = y.dl ? y.dl.daysLeft : Infinity;
      return (da === db ? 0 : da - db) || y.overdue - x.overdue || x.b.stage - y.b.stage || (x.b.id < y.b.id ? -1 : 1);
    });
    const drills = due.slice(0, drillCount(minutes, weekday(day))).map(x => ({
      basic: x.b.id, item: this.drillItem(x.b.id), overdue: x.overdue, track: x.dl ? x.dl.track : null,
    }));

    // Problem slots, as the demo's slotSpecs: each area gets SLOTS slots, counted per area, so every
    // third slot of an area in push mode is hidden-topic whatever the other areas do; the first
    // visible slot of an area is its reach after three clean holds.
    const picks: Pick[] = [];
    const used: string[] = [];
    for (const area of this.problemAreas(day)) {
      const push = this.inPush(area);
      let reachLeft = this.streaks(area).clean >= CLEAN_RUN;
      for (let slot = 0; slot < SLOTS; slot++) {
        const hidden = isHiddenSlot(slot, push);
        const reach = !hidden && reachLeft;
        if (reach) reachLeft = false;
        const p = this.pickProblemRaw(area, { hidden, reach, exclude: used }, day);
        if (!p) continue;
        used.push(p.id);
        picks.push(this.problemPick(p, area, hidden, reach));
      }
    }

    // One kata slot while a track that serves katas is live; every third day it is hidden in push mode.
    const kAreas = this.kataAreas(day);
    if (kAreas.length) {
      const hidden = isHiddenSlot(dayNum(day) % 3, kAreas.some(a => this.inPush(a)));
      const reach = !hidden && kAreas.some(a => this.streaks(a).clean >= CLEAN_RUN);
      let k = this.pickKataRaw(kAreas, { hidden, reach }, day);
      let h = hidden, r = reach;
      if (!k && (hidden || reach)) { k = this.pickKataRaw(kAreas, {}, day); h = false; r = false; }
      if (k) picks.push(this.kataPick(k, h, r));
    }

    let next: { track: string; date: string; days: number } | null = null;
    for (const t of this.liveTracks(day)) {
      const days = this.trackDays(t, day);
      if (days == null || !t.deadline) continue;
      if (!next || days < next.days) next = { track: t.id, date: t.deadline, days };
    }
    const settledToday = this.settledOn(day);
    return { date: day, drills, picks, next, settledToday };
  }

  /**
   * Distinct items first settled on a day: problems and katas by item (re-ticks are not new settles),
   * theorem hooks by theorem (a second attempt the same day is the same theorem).
   */
  settledOn(day: string): number {
    const first = new Map<string, string>();
    const see = (key: string, d: string) => { const f = first.get(key); if (f === undefined || d < f) first.set(key, d); };
    for (const r of this.settled.values()) see(`${r.kind}:${r.item}`, r.day);
    for (const h of this.hooks) {
      const x = this.resolveHook(h.item);
      see(x ? `theorem:${x.doc.id}#${x.theorem}` : `theorem:${h.item}`, h.day);
    }
    let n = 0;
    for (const d of first.values()) if (d === day) n++;
    return n;
  }

  /** Weak basics blocking each live track: stage below 3, or weak (stage <= 1 or the last drill failed). */
  blockers(day: string): { track: string; date: string | null; basics: string[] }[] {
    const out = this.liveTracks(day).map(t => {
      const basics = [...this.basics.values()].filter(b => {
        const d = this.doc(b.id);
        return !!d && this.trackMatches(t, d) && (b.stage < KNOWN_STAGE || this.weak(b.id));
      }).sort((x, y) => x.stage - y.stage || (x.id < y.id ? -1 : 1)).map(b => b.id);
      return { track: t.id, date: t.deadline, basics };
    });
    return out.sort((a, b) => {
      const da = a.date ? dayNum(a.date) : Infinity, db = b.date ? dayNum(b.date) : Infinity;
      return (da === db ? 0 : da - db) || (a.track < b.track ? -1 : 1);
    });
  }
}

function newBasic(id: string): BasicRec {
  return { id, stage: 0, due: null, push: 0, streak: 0, last: null, raisedOn: null, opened: null, history: [] };
}

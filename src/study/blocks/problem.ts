/**
 * The problem block (SPEC.md, Blocks: Problem; Decisions 1 to 3, 9): a problem that asks for a call
 * first. The statement (or the bank reference with its links), a call band where ink comes first and
 * the confidence chips (50 to 90, and "-") unlock only after ink, a timer, then held / held after help
 * / missed / blind / moot (two taps each), then two tick lists (the methods the call named, the
 * methods it took) and the solution. Hidden picks show "?" for the topic and the title until settled.
 * Logs `call` when a chip is tapped and `settle` once the ticks are saved (moot at once).
 *
 * Also `mountHook` (fog at push 3 poses a basic's theorem as a problem; Decision 2) and
 * `openProblem` (the standalone view `notebook-study-problem`, registered in register.ts).
 * Owned by S7 on docs/study/BOARD.md. Reference: lab/study-reader/src/block-problem.js.
 * The session's rules are pure functions below (unit-tested in test/unit/study-problem.test.ts).
 */
import type { NewEvent, StudyContext } from '../context';
import type { BankEntry, ContentIndex, Problem, ProofStep, StudyDoc, StudyEvent } from '../types';
import type { BlockEnv, BlockHandle, BlockMount, InkSurface } from '../view/host';
import { MODEL_LABEL, button, ensureStyles, fmtDur, fogBars, lastEvent, loadLocal, safe, saveLocal, timeOf, twoTap } from './drill';
import { mountFigureInk } from './figure-ink';

export const PROBLEM_VIEW = 'notebook-study-problem';

/* ------------------------------------------------------------------------------------------ *
 * The item: an invented problem, a bank reference, or a theorem posed as a problem (a hook)
 * ------------------------------------------------------------------------------------------ */

export interface ProblemItem {
  /** The event `item`: a problem id, or `<doc>/<theorem anchor>` for a hook. */
  id: string;
  /** The problem's title, a bank problem's source (`Putnam 2019 A2`), or the theorem's title. */
  title: string;
  d: number | null;
  area: string | null;
  /** The doc it lives in (never shown on a hidden pick before the settle). */
  doc: string | null;
  /** Markdown statement; empty for a bank reference. */
  statement: string;
  bank: BankEntry | null;
  /** The model's solution markdown, shown after the call ticks. */
  solution: string | null;
  /** Solution steps (a hook's proof), shown one by one instead of `solution`. */
  steps: ProofStep[];
  /** Hidden until a settle: the solution's methods line, the bank's tags. */
  methods: string[];
  hook: boolean;
  unchecked: boolean;
}

function fromProblem(p: Problem): ProblemItem {
  return {
    id: p.id,
    title: p.bank ? p.bank.source : p.title,
    d: p.d ?? (p.bank ? p.bank.d : null),
    area: p.area,
    doc: p.bank ? null : p.doc,
    statement: p.statement,
    bank: p.bank,
    solution: p.solution ? p.solution.markdown : null,
    steps: [],
    methods: p.methods.slice(),
    hook: false,
    unchecked: p.unchecked,
  };
}

/** A problem (invented or bank) by id, from the content index; `doc` is searched as a fallback. */
export function problemItem(content: ContentIndex, id: string, doc?: StudyDoc): ProblemItem | null {
  const p = content.problems.get(id) || (doc ? doc.problems.find(x => x.id === id) : undefined);
  return p ? fromProblem(p) : null;
}

/** A basic's theorem posed as a problem (push level 3): item `<doc>/<theorem anchor>`, d from its proof. */
export function hookItem(doc: StudyDoc, theoremAnchor: string): ProblemItem | null {
  const t = doc.theorems.find(x => x.anchor === theoremAnchor);
  if (!t) return null;
  const pr = t.proof ? doc.proofs.find(p => p.anchor === t.proof) : undefined;
  return {
    id: `${doc.id}/${t.anchor}`,
    title: t.title,
    d: pr ? pr.d : null,
    area: doc.areas[0] ?? null,
    doc: doc.id,
    statement: t.statement,
    bank: null,
    solution: pr && !pr.steps.length ? pr.intro : null,
    steps: pr ? pr.steps : [],
    methods: [],
    hook: true,
    unchecked: false,
  };
}

/** A method id's label: the id for `methods.md` entries, the callout's title for `basic/anchor` pairs. */
export function methodLabel(content: ContentIndex, id: string): string {
  if (content.methods.has(id)) return id;
  const slash = id.indexOf('/');
  if (slash > 0) {
    const p = content.anchors.get(id.slice(0, slash))?.get(id.slice(slash + 1));
    const t = p && p.callout ? p.callout.title : '';
    // As the demo's mLabel: the callout's title alone. Naming the doc would show a hidden pick's
    // topic in the tick list before the reveal.
    if (t) return t;
    return id.slice(slash + 1);
  }
  return id;
}

/** The list to tick from: every method in methods.md, plus the item's own methods, by label. */
export function methodChoices(content: ContentIndex, item: Pick<ProblemItem, 'methods'>): { id: string; label: string }[] {
  const out = new Map<string, string>();
  for (const m of content.methods.values()) out.set(m.id, m.id);
  for (const m of item.methods) if (!out.has(m)) out.set(m, methodLabel(content, m));
  return [...out].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Where a method is taught: methods.md's link, or the basic/anchor pair itself. */
export function methodHome(content: ContentIndex, id: string): { doc: string; anchor: string | null } | null {
  const m = content.methods.get(id);
  if (m) return { doc: m.doc, anchor: m.anchor };
  const slash = id.indexOf('/');
  if (slash > 0 && content.docs.has(id.slice(0, slash))) return { doc: id.slice(0, slash), anchor: id.slice(slash + 1) };
  return null;
}

/* ------------------------------------------------------------------------------------------ *
 * The session: a pure state machine
 *   call (writing the call) -> attempt (a chip committed it; `call` logged)
 *   -> settled (a verdict, two taps) -> ticks (called, then used) -> done (`settle` logged)
 * Giving up (two taps, not for bank problems) opens the called ticks, then the solution, before
 * the verdict. A verdict can change (two taps) until the called ticks are confirmed.
 * ------------------------------------------------------------------------------------------ */

export const CONF = [50, 60, 70, 80, 90];
export const ARM_MS = 3500;
export type VerbId = 'held' | 'help' | 'missed' | 'blind' | 'moot';
export const VERBS: { v: VerbId; label: string; sub: string }[] = [
  { v: 'held', label: 'held', sub: 'the call worked' },
  { v: 'help', label: 'held after help', sub: 'worked, after help' },
  { v: 'missed', label: 'missed', sub: 'chose wrong' },
  { v: 'blind', label: 'blind', sub: 'unknown unknown' },
  { v: 'moot', label: 'moot', sub: 'does not count' },
];
export type Phase = 'call' | 'attempt' | 'settled' | 'done';

export interface Session {
  v: 1;
  id: string;
  phase: Phase;
  /** The chip tapped: 50..90, or null for "-". */
  conf: number | null;
  committedAt: number | null;
  /** Fixed at the commit from how the problem was opened. */
  hidden: boolean;
  reach: boolean;
  gaveUp: boolean;
  verdict: VerbId | null;
  armed: VerbId | null;
  armedAt: number;
  /** From the commit to the first verdict. */
  ms: number | null;
  called: string[];
  calledNone: boolean;
  calledDone: boolean;
  used: string[];
  usedNone: boolean;
  usedInit: boolean;
  usedDone: boolean;
}

export function newSession(id: string): Session {
  return {
    v: 1, id, phase: 'call', conf: null, committedAt: null, hidden: false, reach: false, gaveUp: false,
    verdict: null, armed: null, armedAt: 0, ms: null, called: [], calledNone: false, calledDone: false,
    used: [], usedNone: false, usedInit: false, usedDone: false,
  };
}

const copyS = (s: Session): Session => ({ ...s, called: s.called.slice(), used: s.used.slice() });

/** The chips unlock only once the call band has ink. */
export function chipsOpen(s: Session, inkCount: number): boolean {
  return s.phase === 'call' && inkCount > 0;
}

/** Tapping a chip commits the call; refused (null) before ink or after a commit. */
export function commit(s: Session, conf: number | null, now: number, inkCount: number, how: { hidden?: boolean; reach?: boolean }): Session | null {
  if (!chipsOpen(s, inkCount)) return null;
  if (conf !== null && CONF.indexOf(conf) < 0) return null;
  const n = copyS(s);
  n.phase = 'attempt';
  n.conf = conf;
  n.committedAt = now;
  n.hidden = how.hidden === true;
  n.reach = how.reach === true;
  return n;
}

export function verbsOpen(s: Session): boolean {
  return s.phase === 'attempt' || (s.phase === 'settled' && !s.calledDone && s.verdict !== 'moot');
}

/** A verb tap: the first arms it, a second within ARM_MS sets the verdict. */
export function tapVerb(s: Session, v: VerbId, now: number, bank = false): Session {
  if (!verbsOpen(s) || s.verdict === v) return s;
  if (v === 'help' && s.gaveUp) return s;
  const n = copyS(s);
  if (s.armed === v && now - s.armedAt <= ARM_MS) {
    if (n.phase === 'attempt') n.ms = Math.max(0, now - (n.committedAt ?? now));
    n.verdict = v;
    n.phase = 'settled';
    n.armed = null;
    n.armedAt = 0;
    if (v === 'moot') {
      n.called = []; n.used = []; n.calledNone = false; n.usedNone = false;
      n.calledDone = true; n.usedDone = true;
    }
    void bank;
    return n;
  }
  n.armed = v;
  n.armedAt = now;
  return n;
}

export function disarm(s: Session): Session {
  if (!s.armed) return s;
  const n = copyS(s);
  n.armed = null;
  n.armedAt = 0;
  return n;
}

/** Give up (two taps in the UI): only while attempting, and only when there is a solution to open. */
export function giveUp(s: Session, hasSolution: boolean): Session {
  if (s.phase !== 'attempt' || s.gaveUp || !hasSolution) return s;
  const n = copyS(s);
  n.gaveUp = true;
  n.armed = null;
  return n;
}

/** The first tick list (what the call named) opens after a verdict or a give-up, before any solution. */
export function ticksOpen(s: Session): boolean {
  return s.phase !== 'done' && s.verdict !== 'moot' && (s.phase === 'settled' || s.gaveUp);
}

export function solutionOpen(s: Session): boolean {
  return s.phase === 'done' || ((s.phase === 'settled' || s.gaveUp) && (s.calledDone || s.verdict === 'moot'));
}

export function toggleTick(s: Session, list: 'called' | 'used', m: string): Session {
  if (list === 'called' ? !ticksOpen(s) || s.calledDone : s.phase !== 'settled' || !s.calledDone || s.usedDone) return s;
  const n = copyS(s);
  const a = list === 'called' ? n.called : n.used;
  const i = a.indexOf(m);
  if (i >= 0) a.splice(i, 1); else a.push(m);
  if (list === 'called') n.calledNone = false; else n.usedNone = false;
  return n;
}

export function toggleNone(s: Session, list: 'called' | 'used'): Session {
  if (list === 'called' ? !ticksOpen(s) || s.calledDone : s.phase !== 'settled' || !s.calledDone || s.usedDone) return s;
  const n = copyS(s);
  if (list === 'called') { n.calledNone = !n.calledNone; if (n.calledNone) n.called = []; }
  else { n.usedNone = !n.usedNone; if (n.usedNone) n.used = []; }
  return n;
}

/** Confirms what the call named; the used list starts from the solution's methods. */
export function confirmCalled(s: Session, solutionMethods: string[]): Session {
  if (!ticksOpen(s) || s.calledDone || !(s.called.length || s.calledNone)) return s;
  const n = copyS(s);
  n.calledDone = true;
  if (!n.usedInit) { n.usedInit = true; n.used = [...new Set(solutionMethods)]; }
  return n;
}

export function confirmUsed(s: Session): Session {
  if (s.phase !== 'settled' || !s.calledDone || s.usedDone || !(s.used.length || s.usedNone)) return s;
  const n = copyS(s);
  n.usedDone = true;
  return n;
}

/**
 * Skip ticks: a session settled earlier whose tick step was never saved (shown again on the next open)
 * settles without the method check. Lists not yet confirmed log empty; a confirmed called list stays.
 */
export function skipTicks(s: Session): Session {
  if (s.phase !== 'settled' || !s.verdict || s.verdict === 'moot' || s.usedDone) return s;
  const n = copyS(s);
  if (!n.calledDone) { n.called = []; n.calledNone = true; n.calledDone = true; }
  n.usedInit = true;
  n.used = [];
  n.usedNone = true;
  n.usedDone = true;
  return n;
}

/** The verdict and both lists are in: the settle event can be written. */
export function readyToLog(s: Session): boolean {
  return s.phase === 'settled' && !!s.verdict && (s.verdict === 'moot' || (s.calledDone && s.usedDone));
}

export function markLogged(s: Session): Session {
  if (!readyToLog(s)) return s;
  const n = copyS(s);
  n.phase = 'done';
  return n;
}

export function callEvent(item: Pick<ProblemItem, 'id' | 'd'>, s: Session): NewEvent {
  return { type: 'call', item: item.id, conf: s.conf, hidden: s.hidden, reach: s.reach, d: item.d };
}

export function settleEvent(s: Session, hook: boolean): NewEvent {
  const v = s.verdict || 'moot';
  return {
    type: 'settle',
    item: s.id,
    verdict: v === 'help' ? 'held' : v,
    help: v === 'help' || (s.gaveUp && v !== 'moot') ? 1 : 0,
    gaveUp: s.gaveUp,
    ms: Math.max(0, Math.round(s.ms ?? 0)),
    called: s.calledNone ? [] : s.called.slice(),
    used: s.usedNone ? [] : s.used.slice(),
    hidden: s.hidden,
    hook,
  };
}

/** The method check: every method it took was named by the call. Null when nothing was taken. */
export function methodHit(s: Pick<Session, 'called' | 'used'>): boolean | null {
  if (!s.used.length) return null;
  return s.used.every(m => s.called.indexOf(m) >= 0);
}

/** A session rebuilt from the event log (another device, or local state lost), or null. */
export function fromEvents(events: StudyEvent[], id: string, since = 0): Session | null {
  const call = lastEvent(events, 'call', e => e.item === id && timeOf(e) >= since);
  const settle = lastEvent(events, 'settle', e => e.item === id && timeOf(e) >= since);
  if (!call && !settle) return null;
  const s = newSession(id);
  if (call) {
    s.phase = 'attempt';
    s.conf = call.conf;
    s.committedAt = timeOf(call);
    s.hidden = call.hidden;
    s.reach = call.reach;
  }
  if (settle) {
    s.phase = 'done';
    s.verdict = settle.verdict === 'held' && settle.help && !settle.gaveUp ? 'help' : settle.verdict;
    s.gaveUp = settle.gaveUp;
    s.ms = settle.ms;
    s.hidden = settle.hidden;
    s.called = settle.called.slice();
    s.used = settle.used.slice();
    s.calledNone = !settle.called.length && settle.verdict !== 'moot';
    s.usedNone = !settle.used.length && settle.verdict !== 'moot';
    s.calledDone = s.usedDone = s.usedInit = true;
  }
  return s;
}

const RANK: Record<Phase, number> = { call: 0, attempt: 1, settled: 2, done: 3 };

/** Local state unless the log is further along (a settle made on another device wins). */
export function mergeSession(local: Session | null, logged: Session | null, id: string): Session {
  if (local && logged) return RANK[logged.phase] > RANK[local.phase] ? logged : local;
  return local || logged || newSession(id);
}

const LKEY = (id: string) => `problem:${id}`;
const SINCE = (id: string) => `problem-since:${id}`;

/** Starts a fresh card for `id` on this device (a hook tried again): earlier events stop counting. */
export function resetProblem(id: string, now = Date.now()): void {
  saveLocal(SINCE(id), now);
  saveLocal(LKEY(id), null);
}

export function loadSession(events: StudyEvent[], id: string): Session {
  const since = loadLocal<number>(SINCE(id)) || 0;
  const local = loadLocal<Session>(LKEY(id));
  return mergeSession(local && local.v === 1 && local.id === id ? local : null, fromEvents(events, id, since), id);
}

/* ------------------------------------------------------------------------------------------ *
 * The session's DOM
 * ------------------------------------------------------------------------------------------ */

export interface SessionOpts {
  hidden?: boolean;
  reach?: boolean;
  why?: string;
  /** Inside a doc (the problem's own doc, or a fog block): no doc link, no repeated byline. */
  inline?: boolean;
}

export interface SessionHandle extends BlockHandle {
  el: HTMLElement;
  state(): Session;
}

const CALL_H = 230;
const WORK_H = 480;
const WORK_STEP = 400;
const WORK_MAX = 2800;

/**
 * The work paper's height that shows every stroke given, never below `h`: the lowest point's
 * paper y plus one WORK_STEP, rounded up to a multiple of WORK_STEP, capped at WORK_MAX. The doc's
 * block and the standalone view share the work ink, so work written lower in one shows in the other.
 * With `onlyBelow`, it grows only when a stroke lies below the paper (an adopted copy or a sync), so
 * writing near the bottom never moves the paper; More paper stays the way to get more.
 */
export function workPaperFit(h: number, strokes: readonly { p: readonly (readonly number[])[] }[], onlyBelow = false): number {
  let low = -Infinity;
  for (const s of strokes) for (const q of s.p) if (q[1] > low) low = q[1];
  if (!isFinite(low) || (onlyBelow && low <= h)) return h;
  return Math.max(h, Math.min(WORK_MAX, Math.ceil((low + WORK_STEP) / WORK_STEP) * WORK_STEP));
}

export function mountSession(host: HTMLElement, env: BlockEnv, item: ProblemItem, o: SessionOpts = {}): SessionHandle {
  ensureStyles();
  const ctx = env.ctx;
  const bank = !!item.bank;
  const hasSolution = !bank && (!!item.solution || item.steps.length > 0);
  let S = loadSession(ctx.events(), item.id);
  /** Settled on an earlier open, ticks never saved: the tick step shows again, with Skip ticks. */
  const resumed = S.phase === 'settled' && S.verdict !== 'moot';
  let dead = false;
  let timer = 0;
  let armTimer = 0;
  let logging = false;
  let workH = WORK_H;
  let solDone = '';
  let figInk: (() => void) | null = null;
  const content = () => ctx.content();
  const save = () => { if (!dead) saveLocal(LKEY(item.id), S); };
  const hiddenNow = () => (S.phase === 'call' ? o.hidden === true : S.hidden);
  const revealed = () => solutionOpen(S);

  const root = host.createDiv({ cls: 'nb-sb nb-sb-pb' });
  root.setAttribute('data-problem', item.id);

  /* card */
  const card = root.createDiv({ cls: 'nb-sb-card nb-sb-pbcard' });
  const head = card.createDiv({ cls: 'nb-sb-row' });
  const kick = head.createSpan({ cls: 'nb-sb-kick nb-sb-pbkick' });
  const badges = head.createSpan({ cls: 'nb-sb-badges' });
  const body = card.createDiv({ cls: 'nb-sb-pbbody' });
  const meta = card.createDiv({ cls: 'nb-sb-hint nb-sb-pbmeta' });

  /* call */
  const callSec = root.createDiv({ cls: 'nb-sb-card nb-sb-callsec' });
  const callHead = callSec.createDiv({ cls: 'nb-sb-row' });
  callHead.createSpan({ cls: 'nb-sb-kick', text: 'Call' });
  callHead.createSpan({ cls: 'nb-sb-sp' });
  const stamp = callHead.createSpan({ cls: 'nb-sb-hint nb-sb-stamp' });
  const callHint = callSec.createEl('p', {
    cls: 'nb-sb-hint',
    text: 'In ink: the method you will use and your plan. Then tap a confidence to commit. Nothing below opens before that.',
  });
  const callBox = callSec.createDiv({ cls: 'nb-sb-paper nb-sb-callink' });
  const callInk: InkSurface = env.ink.surface(env.doc, callBox, `call:${item.id}`, {
    height: CALL_H,
    readOnly: () => dead || S.phase !== 'call',
  });
  const callRow = callSec.createDiv({ cls: 'nb-sb-row' });
  const cundo = button(callRow, 'Undo', 'cundo');
  const chips = callRow.createSpan({ cls: 'nb-sb-chips' });
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Confidence');
  for (const c of [...CONF.map(String), 'none']) {
    const b = button(chips, c === 'none' ? '-' : `${c}%`, 'conf');
    b.setAttribute('data-conf', c);
  }

  /* lock */
  const lock = root.createDiv({ cls: 'nb-sb-lock' });
  fogBars(lock, 3, item.id.length);
  lock.createEl('p', { cls: 'nb-sb-hint', text: 'Locked until you commit a call: the work paper, settling, the solution.' });

  /* below */
  const below = root.createDiv({ cls: 'nb-sb-below' });
  const workSec = below.createDiv({ cls: 'nb-sb-card' });
  const workHead = workSec.createDiv({ cls: 'nb-sb-row' });
  workHead.createSpan({ cls: 'nb-sb-kick', text: 'Work' });
  workHead.createSpan({ cls: 'nb-sb-sp' });
  const timerEl = workHead.createSpan({ cls: 'nb-sb-timer' });
  workSec.createEl('p', { cls: 'nb-sb-hint', text: 'Ink written after you settle or give up shows in the after colour.' });
  const workBox = workSec.createDiv({ cls: 'nb-sb-paper nb-sb-workink' });
  const workInk: InkSurface = env.ink.surface(env.doc, workBox, `work:${item.id}`, {
    height: () => workH,
    readOnly: () => dead || S.phase === 'call',
    meta: () => ({ e: S.gaveUp || S.phase === 'settled' || S.phase === 'done' ? 1 : 0 }),
    color: st => ((st.e || 0) > 0 ? '--color-purple' : '--text-normal'),
  });
  /** Grows the work paper to fit its lowest stroke (workPaperFit); later changes only when one lies below it. True when it grew. */
  const fitWork = (onlyBelow = false): boolean => {
    const h = workPaperFit(workH, workInk.strokes(), onlyBelow);
    if (h === workH) return false;
    workH = h;
    workInk.layout();
    return true;
  };
  fitWork();
  const workRow = workSec.createDiv({ cls: 'nb-sb-row' });
  button(workRow, 'Undo', 'wundo');
  const moreB = button(workRow, 'More paper', 'more');

  const settleSec = below.createDiv({ cls: 'nb-sb-card nb-sb-settlesec' });
  settleSec.createDiv({ cls: 'nb-sb-kick', text: 'Settle the call' });
  const settleHint = settleSec.createEl('p', { cls: 'nb-sb-hint' });
  const verbs = settleSec.createDiv({ cls: 'nb-sb-verbs' });
  for (const x of VERBS) {
    const b = button(verbs, '', 'verb');
    b.setAttribute('data-verb', x.v);
    b.createSpan({ text: x.label });
    b.createEl('small', { text: x.sub });
  }
  const giveRow = settleSec.createDiv({ cls: 'nb-sb-row' });
  const giveB = hasSolution ? button(giveRow, 'Give up and open the solution', 'giveup') : null;
  const giveTap = giveB ? twoTap(giveB, 'Tap again to give up and open it', () => act(s => giveUp(s, hasSolution))) : null;

  const afterSec = below.createDiv({ cls: 'nb-sb-card nb-sb-aftersec' });
  afterSec.createDiv({ cls: 'nb-sb-kick', text: 'Settled' });
  const result = afterSec.createDiv({ cls: 'nb-sb-result' });
  const reveal = afterSec.createDiv({ cls: 'nb-sb-reveal' });
  const stepA = afterSec.createDiv({ cls: 'nb-sb-stepA' });
  stepA.createDiv({ cls: 'nb-sb-kick', text: '1 · Which methods did your call name?' });
  stepA.createEl('p', { cls: 'nb-sb-hint', text: 'Read your call above and tick what it named. The solution opens after this, so these ticks are yours alone.' });
  const ticksA = stepA.createDiv({ cls: 'nb-sb-ticks' });
  ticksA.setAttribute('data-list', 'called');
  const calldone = button(stepA.createDiv({ cls: 'nb-sb-row' }), 'These are what my call named', 'calldone', 'mod-cta');
  const sumA = afterSec.createEl('p', { cls: 'nb-sb-hint nb-sb-sumA' });
  const stepB = afterSec.createDiv({ cls: 'nb-sb-stepB' });
  stepB.createDiv({ cls: 'nb-sb-kick', text: '2 · Which methods did it actually take?' });
  stepB.createEl('p', {
    cls: 'nb-sb-hint',
    text: bank ? 'Read the archive solution (or your own route, if it worked), then tick the methods it took.'
      : 'Pre-ticked with the methods of the solution below. If your own route worked, tick the methods it used instead.',
  });
  const ticksB = stepB.createDiv({ cls: 'nb-sb-ticks' });
  ticksB.setAttribute('data-list', 'used');
  const useddone = button(stepB.createDiv({ cls: 'nb-sb-row' }), 'Save and settle', 'useddone', 'mod-cta');
  const skipRow = afterSec.createDiv({ cls: 'nb-sb-row nb-sb-skip' });
  button(skipRow, 'Skip ticks', 'skip');
  skipRow.createSpan({ cls: 'nb-sb-hint', text: 'Settles without the method check (logs empty lists).' });
  const final = afterSec.createDiv({ cls: 'nb-sb-final' });

  const solSec = below.createDiv({ cls: 'nb-sb-card nb-sb-solsec' });
  solSec.createDiv({ cls: 'nb-sb-kick', text: bank ? 'Solutions' : item.hook ? 'The model’s proof' : 'Solution' });
  const sol = solSec.createDiv({ cls: 'nb-sb-sol' });

  /* ----- static parts: the statement or the reference ----- */
  function renderBody(): void {
    body.empty();
    if (bank && item.bank) {
      body.createDiv({ cls: 'nb-sb-pbtitle', text: item.bank.source });
      if (item.bank.statementUrl) {
        const a = body.createEl('a', { cls: 'nb-sb-ext', text: 'Open the statement ↗' });
        a.setAttribute('href', item.bank.statementUrl);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      }
      body.createEl('p', { cls: 'nb-sb-hint', text: 'Competition problems appear here by source and number only. Work it from the paper.' });
    } else if (item.hook && o.inline) {
      body.createEl('p', { cls: 'nb-sb-hint', text: 'The statement is the theorem just above: prove it, after the call.' });
    } else {
      const st = body.createDiv({ cls: 'nb-sb-stmt' });
      void env.render(item.statement || '(No statement.)', st).then(() => { figInk?.(); figInk = mountFigureInk(st, env, item.id); env.relayout(); });
      if (!o.inline) body.createEl('p', { cls: 'nb-sb-by', text: MODEL_LABEL });
    }
  }

  /* ----- dynamic parts ----- */
  function render(): void {
    if (dead) return;
    root.setAttribute('data-phase', S.phase);
    renderHead();
    renderCall();
    lock.hidden = S.phase !== 'call';
    below.hidden = S.phase === 'call';
    renderWork();
    renderSettle();
    renderAfter();
    renderSol();
    syncTimer();
    callInk.setReadOnly(S.phase !== 'call');
    workInk.setReadOnly(S.phase === 'call');
    env.relayout();
  }

  function renderHead(): void {
    const hid = hiddenNow() && !revealed();
    const d = item.d === null ? '' : ` · d ${Math.round(item.d * 100) / 100}`;
    if (item.hook) kick.textContent = `Prove it, problem first${d}`;
    else if (hid && !bank) kick.textContent = `Problem ?${d}`;
    else kick.textContent = `Problem · ${item.title}${d}`;
    badges.empty();
    if (hid) {
      badges.createSpan({ cls: 'nb-sb-q', text: '?' }).setAttribute('aria-label', 'Topic hidden');
      badges.createSpan({ cls: 'nb-sb-hint', text: ' topic hidden' });
    }
    if ((S.phase === 'call' ? o.reach : S.reach)) badges.createSpan({ cls: 'nb-sb-chip', text: 'reach' });
    if (item.unchecked) badges.createSpan({ cls: 'nb-sb-chip', text: 'unchecked' });
    meta.empty();
    if (item.hook) {
      meta.setText('The theorem above, posed as a problem: call the method and your plan before you write the proof. Settling grades this basic like a drill.');
    } else if (o.why) meta.setText(o.why);
  }

  function renderCall(): void {
    const frozen = S.phase !== 'call';
    const n = callInk.count();
    cundo.hidden = frozen;
    cundo.disabled = !n;
    callHint.hidden = frozen;
    chips.querySelectorAll('button').forEach(b => {
      const raw = b.getAttribute('data-conf');
      const c = raw === 'none' ? null : Number(raw);
      const btn = b as HTMLButtonElement;
      btn.disabled = frozen || !chipsOpen(S, n);
      btn.setAttribute('aria-pressed', String(frozen && S.conf === c));
      btn.hidden = frozen && S.conf !== c;
    });
    stamp.textContent = frozen
      ? `Committed ${S.committedAt ? new Date(S.committedAt).toTimeString().slice(0, 5) : ''} · ${S.conf === null ? 'no confidence' : S.conf + '%'}`
      : n ? 'Tap a confidence to commit.' : 'Confidence unlocks once the call has ink.';
  }

  function renderWork(): void {
    moreB.disabled = workH >= WORK_MAX;
    renderTimer();
  }
  function renderTimer(): void {
    if (S.phase === 'call') timerEl.textContent = 'not started';
    else if (S.phase === 'attempt') timerEl.textContent = fmtDur(Date.now() - (S.committedAt || Date.now()));
    else timerEl.textContent = `${fmtDur(S.ms || 0)} · settled`;
  }
  function syncTimer(): void {
    if (S.phase === 'attempt' && !timer) timer = window.setInterval(() => { if (!dead) renderTimer(); }, 1000);
    else if (S.phase !== 'attempt' && timer) { window.clearInterval(timer); timer = 0; }
  }

  function verdictText(): string {
    const v = S.verdict;
    if (v === 'help') return 'held after help';
    if (v === 'held' && S.gaveUp) return 'held after giving up';
    if (S.gaveUp && (v === 'missed' || v === 'blind')) return `${v} (gave up)`;
    return v || '';
  }

  function renderSettle(): void {
    const open = verbsOpen(S);
    verbs.querySelectorAll('button').forEach(b => {
      const v = b.getAttribute('data-verb') as VerbId;
      const x = VERBS.find(y => y.v === v)!;
      const armed = open && S.armed === v;
      const btn = b as HTMLButtonElement;
      btn.classList.toggle('nb-sb-armed', armed);
      btn.setAttribute('aria-pressed', String(S.verdict === v));
      btn.disabled = !open || S.verdict === v;
      btn.hidden = v === 'help' && S.gaveUp && S.verdict !== 'help';
      const small = btn.querySelector('small');
      if (small) small.textContent = armed ? (S.phase === 'settled' ? 'tap again to change' : 'tap again to settle') : x.sub;
    });
    if (giveB) giveB.hidden = S.gaveUp || S.phase !== 'attempt';
    settleHint.textContent = S.phase === 'attempt'
      ? (S.gaveUp ? (S.calledDone ? 'You gave up and the solution is open below. Now settle the call: did the method you named work? Two taps.'
        : 'You gave up. First tick what your call named, below; the solution opens after that. Then settle the call here (two taps).')
        : 'When you are done, settle the call: did the method you named work? Each verb takes two taps.')
      : open ? `Verdict: ${verdictText()}. Two taps on another verb change it, until you confirm the ticks below.`
        : `Settled ${verdictText()}${S.ms !== null ? ' at ' + fmtDur(S.ms) : ''}.`;
  }

  function renderTicks(box: HTMLElement, list: 'called' | 'used'): void {
    box.empty();
    const sel = list === 'called' ? S.called : S.used;
    for (const m of methodChoices(content(), item)) {
      const b = button(box, m.label, 'tick');
      b.setAttribute('data-m', m.id);
      b.setAttribute('data-list', list);
      b.setAttribute('aria-pressed', String(sel.indexOf(m.id) >= 0));
    }
    const none = button(box, 'none of these', 'none');
    none.setAttribute('data-list', list);
    none.setAttribute('aria-pressed', String(list === 'called' ? S.calledNone : S.usedNone));
  }

  function labels(ids: string[]): string {
    return ids.map(m => methodLabel(content(), m)).join(', ');
  }

  function renderAfter(): void {
    const show = S.phase === 'settled' || S.phase === 'done' || S.gaveUp;
    afterSec.hidden = !show;
    if (!show) return;
    const moot = S.verdict === 'moot';
    result.empty();
    if (S.phase === 'attempt') result.createEl('b', { text: 'Gave up' });
    else {
      result.createEl('b', { text: verdictText() });
      result.createSpan({ text: `${S.ms !== null ? ' · ' + fmtDur(S.ms) : ''} · called at ${S.conf === null ? '-' : S.conf + '%'}` });
      if (S.phase === 'settled') result.createSpan({ text: moot ? '' : ' · logged when you save the ticks below' });
      else if (!item.hook && item.area) {
        const r = safe(() => ctx.engine().rating(item.area as string), NaN);
        if (isFinite(r)) result.createSpan({ text: ` · r ${Math.round(r * 100) / 100} in ${item.area} now` });
      }
    }
    reveal.empty();
    if (revealed() && (S.hidden || !o.inline) && item.doc) {
      const docTitle = content().docs.get(item.doc)?.title || item.doc;
      reveal.createSpan({ text: S.hidden ? 'Topic, hidden while you worked: ' : 'From ' });
      reveal.createEl('b', { text: `${item.area ? item.area + ' · ' : ''}${docTitle}` });
      reveal.createSpan({ text: ' ' });
      const b = button(reveal, 'Open it', 'opendoc');
      b.setAttribute('data-doc', item.doc);
    } else if (revealed() && S.hidden && bank && item.area) {
      reveal.createSpan({ text: 'Topic, hidden while you worked (a model’s reading): ' });
      reveal.createEl('b', { text: item.area });
    }
    stepA.hidden = !ticksOpen(S) || S.calledDone;
    sumA.hidden = moot || !S.calledDone;
    stepB.hidden = moot || S.phase !== 'settled' || !S.calledDone || S.usedDone;
    if (!stepA.hidden) { renderTicks(ticksA, 'called'); calldone.disabled = !(S.called.length || S.calledNone); }
    if (!sumA.hidden) sumA.textContent = `Your call named: ${S.calledNone || !S.called.length ? 'none of the listed methods' : labels(S.called)}.`;
    if (!stepB.hidden) { renderTicks(ticksB, 'used'); useddone.disabled = !(S.used.length || S.usedNone) || logging; }
    skipRow.hidden = !resumed || S.phase !== 'settled' || moot || S.usedDone || logging;
    final.empty();
    if (S.phase === 'settled' && readyToLog(S) && !logging) {
      final.createEl('p', { cls: 'nb-sb-hint', text: 'Not logged yet.' });
      button(final, 'Log the settle', 'retry', 'mod-cta');
    }
    if (S.phase === 'done') {
      if (moot) final.createEl('p', { cls: 'nb-sb-hint', text: 'Moot: nothing counted.' });
      else {
        const hit = methodHit({ called: S.calledNone ? [] : S.called, used: S.usedNone ? [] : S.used });
        const p = final.createEl('p', { cls: 'nb-sb-method' });
        if (hit === true) p.setText(`Method: hit. Your call named every method it took (${labels(S.used)}).`);
        else if (hit === false) {
          const miss = S.used.filter(m => S.called.indexOf(m) < 0);
          p.setText(`Method: missed. It took ${labels(miss)}, which your call did not name.`);
        } else p.setText('Method check not counted: no method ticked.');
        const homes = S.used.map(m => ({ m, h: methodHome(content(), m) })).filter(x => x.h);
        if (homes.length) {
          const row = final.createDiv({ cls: 'nb-sb-row nb-sb-homes' });
          row.createSpan({ cls: 'nb-sb-hint', text: 'Where it is taught: ' });
          for (const { m, h } of homes) {
            const b = button(row, labels([m]), 'home');
            b.setAttribute('data-doc', h!.doc);
            if (h!.anchor) b.setAttribute('data-anchor', h!.anchor);
          }
        }
      }
      if (item.hook) {
        const again = button(final.createDiv({ cls: 'nb-sb-row' }), 'Try it again', 'again');
        twoTap(again, 'Tap again: a fresh card for this theorem', () => restart());
      }
    }
  }

  function renderSol(): void {
    const open = solutionOpen(S);
    const key = `${open}:${S.phase}`;
    if (key === solDone) return;
    solDone = key;
    sol.empty();
    if (bank && item.bank) {
      if (open && item.bank.solutionUrl) {
        const a = sol.createEl('a', { cls: 'nb-sb-ext', text: 'Solutions in the archive ↗' });
        a.setAttribute('href', item.bank.solutionUrl);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
        a.setAttribute('data-sb', 'solutions');
        sol.createEl('p', { cls: 'nb-sb-hint', text: 'Written by the archive’s authors, not reproduced here.' });
      } else {
        const b = button(sol, 'Solutions (after you settle)', 'solutions');
        b.disabled = true;
      }
      return;
    }
    if (!open) {
      sol.createEl('p', { cls: 'nb-sb-hint', text: S.phase === 'settled' || S.gaveUp ? 'Opens once you tick what your call named.' : 'Locked until you settle, or give up.' });
      return;
    }
    if (item.steps.length) {
      for (const s of item.steps) {
        const d = sol.createDiv({ cls: 'nb-sb-step shown' });
        d.createDiv({ cls: 'nb-sb-stepk', text: `Step ${s.n}` });
        void env.render(s.markdown, d.createDiv()).then(() => env.relayout());
      }
    } else if (item.solution) {
      void env.render(item.solution, sol.createDiv({ cls: 'nb-sb-solbody' })).then(() => env.relayout());
    } else sol.createEl('p', { cls: 'nb-sb-hint', text: 'No model solution in this doc.' });
    if (!o.inline) sol.createEl('p', { cls: 'nb-sb-by', text: MODEL_LABEL });
  }

  /* ----- actions ----- */
  function act(f: (s: Session) => Session): void {
    const n = f(S);
    if (n === S) return;
    S = n;
    save();
    if (S.armed) {
      if (armTimer) window.clearTimeout(armTimer);
      armTimer = window.setTimeout(() => { armTimer = 0; if (!dead) { S = disarm(S); save(); render(); } }, ARM_MS);
    }
    render();
    if (readyToLog(S)) void logSettle();
  }

  async function logSettle(): Promise<void> {
    if (logging || !readyToLog(S)) return;
    logging = true;
    render();
    try {
      await ctx.log(settleEvent(S, item.hook));
      S = markLogged(S);
      save();
    } catch (e) {
      console.error('[study] problem: logging the settle failed', e);
      env.toast('Could not log the settle: ' + String(e));
    }
    logging = false;
    render();
  }

  async function onCommit(raw: string | null): Promise<void> {
    const conf = raw === 'none' || raw === null ? null : Number(raw);
    const n = commit(S, conf, Date.now(), callInk.count(), { hidden: o.hidden, reach: o.reach });
    if (!n) return;
    S = n;
    save();
    render();
    try { await ctx.log(callEvent(item, S)); } catch (e) {
      console.error('[study] problem: logging the call failed', e);
      env.toast('Could not log the call: ' + String(e));
    }
  }

  function restart(): void {
    resetProblem(item.id);
    callInk.clear();
    workInk.clear();
    S = newSession(item.id);
    solDone = '';
    save();
    render();
  }

  function onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    const b = t && t.closest ? (t.closest('button') as HTMLButtonElement | null) : null;
    if (!b || !root.contains(b) || b.disabled) return;
    switch (b.getAttribute('data-sb')) {
      case 'conf': void onCommit(b.getAttribute('data-conf')); break;
      case 'verb': act(s => tapVerb(s, b.getAttribute('data-verb') as VerbId, Date.now(), bank)); break;
      case 'tick': act(s => toggleTick(s, b.getAttribute('data-list') as 'called' | 'used', b.getAttribute('data-m') || '')); break;
      case 'none': act(s => toggleNone(s, b.getAttribute('data-list') as 'called' | 'used')); break;
      case 'calldone': act(s => confirmCalled(s, item.methods)); break;
      case 'useddone': act(s => confirmUsed(s)); break;
      case 'skip': act(s => skipTicks(s)); break;
      case 'retry': void logSettle(); break;
      case 'cundo': if (S.phase === 'call') { callInk.undo(); render(); } break;
      case 'wundo': workInk.undo(); break;
      case 'more': workH = Math.min(WORK_MAX, workH + WORK_STEP); workInk.layout(); render(); break;
      case 'opendoc': case 'home': {
        const d = b.getAttribute('data-doc');
        if (d) env.open(d, b.getAttribute('data-anchor') || undefined);
        break;
      }
    }
  }
  root.addEventListener('click', onClick);
  const offCall = callInk.onChange(() => { if (!dead) renderCall(); });
  // Work strokes that arrive later below the paper (an adopted copy, a sync) grow it; writing does not.
  const offWork = workInk.onChange(() => { if (!dead && fitWork(true)) render(); });
  const offEvents = ctx.onChange(what => {
    if (dead || what !== 'events') return;
    // A settle from another device (after a sync) moves this card on.
    const merged = mergeSession(S, fromEvents(ctx.events(), item.id, loadLocal<number>(SINCE(item.id)) || 0), item.id);
    if (merged !== S) { S = merged; save(); render(); }
  });

  renderBody();
  render();
  if (readyToLog(S)) void logSettle();

  return {
    el: root,
    state: () => copyS(S),
    destroy: () => {
      if (dead) return;
      dead = true;
      if (timer) window.clearInterval(timer);
      if (armTimer) window.clearTimeout(armTimer);
      giveTap?.destroy();
      offWork();
      offCall();
      offEvents();
      figInk?.();
      figInk = null;
      root.removeEventListener('click', onClick);
      callInk.destroy();
      workInk.destroy();
      root.remove();
    },
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Mounts
 * ------------------------------------------------------------------------------------------ */

/** Mounts `item()` into `el` now, or once the content index has it (it loads lazily). */
function mountWhenReady(el: HTMLElement, env: BlockEnv, find: () => ProblemItem | null, o: SessionOpts, missing: string): BlockHandle & { session(): SessionHandle | null } {
  let sess: SessionHandle | null = null;
  let off: (() => void) | null = null;
  const tryMount = (): boolean => {
    const item = find();
    if (!item) return false;
    el.empty();
    sess = mountSession(el, env, item, o);
    return true;
  };
  if (!tryMount()) {
    el.createDiv({ cls: 'nb-sb nb-sb-hint', text: missing });
    off = env.ctx.onChange(w => {
      if (w === 'content' && !sess && tryMount()) { off?.(); off = null; }
    });
  }
  return {
    session: () => sess,
    destroy: () => { off?.(); sess?.destroy(); el.empty(); },
  };
}

/** The problem block inside a doc: a problem callout or a bank reference. Never hidden: its doc is on screen. */
export const mount: BlockMount = (el, env) => {
  const id = env.passage.block?.id || env.passage.anchor;
  return mountWhenReady(el, env, () => problemItem(env.ctx.content(), id, env.doc), { inline: true }, `Problem ${id} is not in the study folder.`);
};

/** Fog at push 3: the basic's theorem `theoremAnchor` as a problem-first card (Decision 2). */
export function mountHook(el: HTMLElement, env: BlockEnv, theoremAnchor: string): BlockHandle & { session(): SessionHandle | null } {
  return mountWhenReady(el, env, () => hookItem(env.doc, theoremAnchor), { inline: true }, `Theorem ${theoremAnchor} is not in this doc.`);
}

/** Opens a problem in its own tab (Today, Map): `notebook-study-problem`, registered in register.ts. */
export async function openProblem(ctx: StudyContext, id: string, opts: { hidden?: boolean; reach?: boolean; why?: string } = {}): Promise<void> {
  const ws = ctx.app.workspace;
  const existing = ws.getLeavesOfType(PROBLEM_VIEW).find(l => {
    const st = l.view.getState() as { id?: unknown };
    return st.id === id;
  });
  const leaf = existing || ws.getLeaf('tab');
  await leaf.setViewState({ type: PROBLEM_VIEW, active: true, state: { id, hidden: opts.hidden === true, reach: opts.reach === true, why: opts.why || '' } });
  ws.revealLeaf(leaf);
}

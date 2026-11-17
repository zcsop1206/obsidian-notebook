/**
 * Study mode: the shared types every study module codes against.
 *
 * Contract between the parser (format/), the engine (engine/), the study view (view/), the ink
 * layer (ink/), the blocks (blocks/), the kata runner (kata/) and the panels (panels/). Change a
 * type here only through the board (docs/study/BOARD.md): every ticket depends on this file.
 * The file format these types describe is docs/study/FORMAT.md; the rules are docs/study/SPEC.md.
 */

/* ------------------------------------------------------------------------------------------ *
 * Content: what the parser reads from the study folder
 * ------------------------------------------------------------------------------------------ */

export type DocKind = 'basic' | 'topic' | 'kata' | 'bank' | 'card' | 'tracks' | 'methods' | 'registry' | 'other';

export type PassageKind =
  | 'label' // the "Written by a model for Adit" line; not markable
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'math' // a $$ display block
  | 'code' // a fenced block (kata ports, skeleton, vectors, or plain code)
  | 'callout'
  | 'quote' // a blockquote that is not a callout
  | 'rule'; // a thematic break; not markable

/** The study callouts FORMAT.md defines; anything else parses as 'other'. */
export type CalloutType =
  | 'def' | 'thm' | 'proof' | 'example' | 'derive' | 'problem' | 'solution' | 'recall' | 'kata' | 'trap'
  | 'note' | 'warning' | 'other';

export interface Callout {
  type: CalloutType;
  /** The type as written, lowercased (keeps unknown types for rendering). */
  rawType: string;
  /** Written with `-` after the type: folded by default in Obsidian. */
  folded: boolean;
  /** The title text after `[!type]`, with a trailing `(d x)` and `unchecked` removed. */
  title: string;
  /** `(d x)` in the title, else null. */
  d: number | null;
  /** The title says `unchecked`: never picked. */
  unchecked: boolean;
  /** The body as markdown, with the leading `>` of each line removed. */
  body: string;
}

/** One anchored item inside a list passage (`- text ^id`). */
export interface ListItemAnchor {
  anchor: string;
  /** 0-based line in the file. */
  line: number;
  /** The item's markdown with the block id removed. */
  text: string;
}

export interface Passage {
  /** Unique in the doc: an explicit block id, `h-<slug>` for headings, else `p-<sha1 8 hex>`. */
  anchor: string;
  /** The anchor was written as a block id (stable across rewrites). */
  explicit: boolean;
  kind: PassageKind;
  /** 0-based first and last line in the file (frontmatter included), inclusive. */
  start: number;
  end: number;
  /** The passage's markdown exactly as in the file, block id lines included. */
  source: string;
  /** The markdown to render: block ids removed. */
  markdown: string;
  /** First 8 hex digits of SHA-1 of the trimmed `markdown`: changes when a rewrite changes the text. */
  hash: string;
  /** Heading level 1-6, headings only. */
  level?: number;
  /** Heading text, headings only. */
  text?: string;
  callout?: Callout;
  /** Fenced code info string (`ports`, `skeleton`, `vectors`, a language), code passages only. */
  lang?: string;
  /** Anchored list items, list passages only. */
  items?: ListItemAnchor[];
  /** The passage is a study block the view mounts (proof, problem, derive, recall, kata, solution). */
  block?: BlockRef;
}

export interface BlockRef {
  type: 'fog' | 'problem' | 'drill' | 'recall' | 'kata' | 'solution';
  /** For fog: the proof's anchor; for problem: the problem id; for drill: the derive anchor; etc. */
  id: string;
}

export interface DocLink {
  /** The passage (or list item) the link sits in. */
  from: string;
  text: string;
  href: string;
  /** Resolved target doc id (the file name), or null for an external link. */
  toDoc: string | null;
  /** The target's vault path, resolved against the linking doc's folder; null for an external link. */
  toPath: string | null;
  /** The anchor in the target, or null for the doc's top. */
  toAnchor: string | null;
  external: boolean;
}

export interface Theorem {
  anchor: string;
  title: string;
  statement: string;
  /** The proof's anchor, if a proof follows. */
  proof: string | null;
}

export interface ProofStep {
  /** 1-based, as numbered in the file. */
  n: number;
  markdown: string;
}

export interface Proof {
  /** `p-<theorem anchor>` unless written explicitly. */
  anchor: string;
  /** The theorem it proves, or null if no thm callout precedes it. */
  of: string | null;
  /** Difficulty of proving it cold, from `(d x)`; null = never moves a rating. */
  d: number | null;
  /** Markdown before the first numbered step (rare). */
  intro: string;
  steps: ProofStep[];
}

export interface Solution {
  /** The anchor of the passage it solves (problem, example, derive or recall). */
  of: string;
  /** Method ids or `basic/anchor` pairs from the `methods:` line. */
  methods: string[];
  /** The body after the methods line. */
  markdown: string;
  steps: ProofStep[];
}

export interface Problem {
  /** Unique across the study root: the anchor (`inv-<area>-<slug>` or a bank id). */
  id: string;
  doc: string;
  /** From the bank when this is a bank reference. */
  bank: BankEntry | null;
  title: string;
  d: number | null;
  /** Rating area: the doc's first area, the bank tags' area, or null. */
  area: string | null;
  statement: string;
  solution: Solution | null;
  /** Hidden until a settle: from the solution's methods line or the bank's tags. */
  methods: string[];
  unchecked: boolean;
}

export interface Derive {
  anchor: string;
  doc: string;
  prompt: string;
  solution: Solution | null;
}

export interface Recall {
  anchor: string;
  doc: string;
  prompt: string;
  answer: Solution | null;
}

export interface KataPort {
  dir: 'input' | 'output';
  name: string;
  /** Bit width (1 when no range). */
  width: number;
}

export interface Kata {
  id: string;
  title: string;
  area: string;
  needs: string[];
  d: number | null;
  level: 'simple' | 'hard' | 'hidden';
  spec: string;
  ports: KataPort[];
  skeleton: string;
  vectors: Vectors | null;
}

export interface Vectors {
  inputs: string[];
  outputs: string[];
  /** One row per cycle: values as bigint-safe hex strings, or null for don't care. */
  rows: { line: number; inputs: (string | null)[]; outputs: (string | null)[] }[];
}

export interface BankEntry {
  id: string;
  source: string;
  d: number | null;
  statementUrl: string | null;
  solutionUrl: string | null;
  /** From `<bank>.tags.md`, if a row exists. */
  area: string | null;
  methods: string[];
  /** The bank doc id. */
  bank: string;
}

export interface Track {
  id: string;
  /** Deadline (or range start) as YYYY-MM-DD, or null. */
  deadline: string | null;
  /** Range end for `a to b`, else null. */
  until: string | null;
  weight: number;
  areas: string[];
  /** The docs column, as written (globs like `nt-*` are allowed). */
  docs: string;
}

export interface MethodEntry {
  id: string;
  doc: string;
  anchor: string | null;
}

export interface StudyDoc {
  id: string;
  /** Vault path. */
  path: string;
  kind: DocKind;
  title: string;
  areas: string[];
  needs: string[];
  build: number;
  tracks: string[];
  /** `by: adit` in the frontmatter, else 'model'. */
  by: 'model' | 'adit';
  /** The first body line is the model label. */
  labelled: boolean;
  /** Raw frontmatter values. */
  meta: Record<string, string | number | string[]>;
  passages: Passage[];
  links: DocLink[];
  theorems: Theorem[];
  proofs: Proof[];
  derives: Derive[];
  problems: Problem[];
  recalls: Recall[];
  kata: Kata | null;
  bank: BankEntry[];
  /** Problems from in-doc problem callouts that reference bank ids (resolved by buildIndex). */
  bankRefs: string[];
  warnings: string[];
}

export interface ContentIndex {
  docs: Map<string, StudyDoc>;
  /** basic id -> ids of docs whose `needs` include it. */
  usedBy: Map<string, string[]>;
  /** doc id -> anchor -> passage (and anchored list items, as their list passage). */
  anchors: Map<string, Map<string, Passage>>;
  problems: Map<string, Problem>;
  katas: Map<string, Kata>;
  bank: Map<string, BankEntry>;
  tracks: Track[];
  methods: Map<string, MethodEntry>;
  warnings: string[];
}

/* ------------------------------------------------------------------------------------------ *
 * Events: the append-only logs in study/log/<device>.jsonl (SPEC.md, Storage)
 * ------------------------------------------------------------------------------------------ */

export type MarkVerb = 'lost' | 'easy' | 'forgot' | 'clear';
export type DrillGrade = 'clean' | 'shaky' | 'failed';
export type Verdict = 'held' | 'missed' | 'blind' | 'moot';

interface EventBase {
  /** Format version. */
  v: 1;
  /** Unique: `<device>-<ms base36>-<4 random base36>`. */
  id: string;
  /** ISO time with offset, from the device clock. */
  t: string;
  dev: string;
}

export type StudyEvent = EventBase & (
  | { type: 'mark'; doc: string; a: string; verb: MarkVerb; build: number }
  | { type: 'attempt'; doc: string; a: string; strokes: number }
  | { type: 'rewrite-request'; doc: string; a: string; build: number }
  | { type: 'rebuild-request'; doc: string; build: number; a: string }
  | { type: 'fog'; doc: string; proof: string; build: number; reveals: number; steps: number; done: boolean; clean: boolean }
  | { type: 'drill'; doc: string; item: string; grade: DrillGrade; ms: number; src: 'drill' | 'probe' | 'recall' }
  | { type: 'call'; item: string; conf: number | null; hidden: boolean; reach: boolean; d: number | null }
  | { type: 'settle'; item: string; verdict: Verdict; help: 0 | 1; gaveUp: boolean; ms: number; called: string[]; used: string[]; hidden: boolean; hook: boolean }
  | { type: 'kata'; kata: string; pass: boolean; runs: number; gaveUp: boolean; ms: number; called: string[]; used: string[]; hidden: boolean }
  | { type: 'stage-set'; basic: string; stage: number }
);

export type StudyEventType = StudyEvent['type'];

/* ------------------------------------------------------------------------------------------ *
 * Engine: pure state over (content, events, now). Implemented in engine/ (ticket S2).
 * ------------------------------------------------------------------------------------------ */

export type TriageAction =
  | { action: 'rebuild-basic'; basics: string[] } // a gap in a fundamental: request a whole-basic rebuild
  | { action: 'scaffold'; basics: string[]; since: string; eligibleAt: string | null } // struggle first
  | { action: 'eligible'; left: number } // may request a rewrite: two taps
  | { action: 'budget-exhausted'; drill: string | null } // no rewrites left: drill the weakest basic instead
  | { action: 'requested'; at: string } // a rewrite or rebuild is waiting for the laptop
  | { action: 'noted' }; // easy, forgot or clear: recorded, nothing to do

export interface BasicState {
  id: string;
  stage: number; // 0..5
  due: string | null; // YYYY-MM-DD
  push: number; // 0 steps, 1 chunks, 2 cold, 3 hook
  streak: number;
  last: DrillGrade | null;
  history: { t: string; grade: DrillGrade; from: number; to: number; src: string }[];
}

export interface Pick {
  kind: 'problem' | 'kata' | 'theorem';
  id: string;
  d: number | null;
  /** Expected score at the current rating. */
  E: number | null;
  hidden: boolean;
  reach: boolean;
  /** One line on why it was picked (never names the topic of a hidden pick). */
  why: string;
}

export interface TodayPlan {
  date: string;
  drills: { basic: string; item: string; overdue: number; track: string | null }[];
  picks: Pick[];
  /** The nearest track deadline. */
  next: { track: string; date: string; days: number } | null;
  settledToday: number;
}

export interface Engine {
  now(): Date;
  today(): string;
  /** Re-fold after new events or content; cheap. */
  update(content: ContentIndex, events: StudyEvent[]): void;

  basic(id: string): BasicState;
  basics(): BasicState[];
  rating(area: string): number;
  ratingHistory(area: string): { t: string; r: number }[];
  /** P(identify the method) on hidden settles, smoothed (SPEC.md, Decisions 1). */
  methodAccuracy(area?: string): { p: number; n: number };
  pushLevel(basic: string): number;
  expected(d: number, r: number): number;

  /** What a margin mark should do now, before it is logged. */
  triage(doc: string, anchor: string, verb: MarkVerb): TriageAction;
  /** The rewrite budget left on a doc (3 per build cycle; SPEC.md). */
  budget(doc: string): { left: number; used: number };
  /** Open marks, newest first. */
  marks(doc?: string): { doc: string; a: string; verb: MarkVerb; t: string; build: number }[];
  /** Rewrite and rebuild requests not yet answered by a newer build. */
  pendingRequests(): { doc: string; a: string; kind: 'rewrite' | 'rebuild'; t: string; build: number }[];

  todayPlan(minutes?: number): TodayPlan;
  pickProblem(area: string | null, opts?: { hidden?: boolean; reach?: boolean }): Pick | null;
  pickKata(opts?: { hidden?: boolean; reach?: boolean }): Pick | null;
  /** Weak basics blocking each track (Map). */
  blockers(): { track: string; date: string | null; basics: string[] }[];
}

/**
 * The engine's pure rules and constants (SPEC.md, Engine), ported from the demo's
 * lab/study-reader/src/engine.js with the SPEC decisions applied. No state, no DOM, no Obsidian:
 * the laptop scripts import this file as it is.
 */

export const DAY = 86400000;

/** r <- r + K (score - E); theorem hooks move the rating at half weight (Decision 2). */
export const K = 0.6;
export const K_HOOK = 0.3;
/** The stretch band: aim at E 0.65, accept 0.60 to 0.70. */
export const E_TARGET = 0.65;
export const E_LO = 0.6;
export const E_HI = 0.7;
/** One reach after CLEAN_RUN clean holds in a row. */
export const E_REACH = 0.4;
/** Hidden-topic picks aim the overall chance at E_TARGET: E_hidden = clamp(0.65 / p_id, 0.65, 0.88) (Decision 1). */
export const E_HIDDEN_MAX = 0.88;
/** p_id = (hits + 3) / (n + 4) over the last 20 hidden settles. */
export const P_ID_HITS = 3;
export const P_ID_N = 4;
export const P_ID_WINDOW = 20;
/** After MISS_RUN misses in a row the target eases one step. */
export const EASE_STEP = 1;
export const MISS_RUN = 2;
export const CLEAN_RUN = 3;
/** Problem slots a day; in push areas every third slot is hidden-topic. */
export const SLOTS = 3;
export const HIDDEN_EVERY = 3;
/** Drill intervals in days, by stage 0..5. */
export const INTERVALS = [1, 2, 4, 7, 14, 30];
export const MAX_STAGE = 5;
/** Stage >= 3: Adit knows the basic's methods. */
export const KNOWN_STAGE = 3;
/** Rewrites per doc per build cycle, and the wait before a rewrite (Decision 6). */
export const REWRITE_MAX = 3;
export const ELIGIBLE_MS = DAY;
/** Starting ratings: every area 4, number theory 3. */
export const R_START_DEFAULT = 4;
export const R_START: Record<string, number> = { nt: 3 };
/** Graded retrievals kept per basic, rating points kept per area. */
export const HISTORY_MAX = 40;
export const RATING_HISTORY_MAX = 200;
/** General reasoning: always open to hidden picks (Decision 3). */
export const GEN_AREA = 'gen';

export type Grade = 'clean' | 'shaky' | 'failed';

export function startRating(area: string): number {
  return Object.prototype.hasOwnProperty.call(R_START, area) ? R_START[area] : R_START_DEFAULT;
}

/** Expected score of a problem of difficulty d at rating r. */
export function expected(d: number, r: number): number {
  return 1 / (1 + Math.pow(10, (d - r) / 2));
}

/** The difficulty whose expected score at rating r is E. */
export function dForE(r: number, E: number): number {
  return r + 2 * Math.log10(1 / E - 1);
}

export function rateUpdate(r: number, d: number, score: number | null, k: number = K): { E: number; r: number } {
  const E = expected(d, r);
  return { E, r: score == null ? r : r + k * (score - E) };
}

/** p_id smoothed: (hits + 3) / (n + 4). With no data, 0.75. */
export function pIdSmoothed(hits: number, n: number): number {
  return (hits + P_ID_HITS) / (n + P_ID_N);
}

/** Decision 1: the plain-score target for a hidden pick, so that p_id * E = 0.65. */
export function hiddenE(pId: number): number {
  const p = pId > 0 ? pId : 1e-9;
  return Math.min(E_HIDDEN_MAX, Math.max(E_TARGET, E_TARGET / p));
}

export function clampStage(n: number): number {
  const s = Math.round(Number(n) || 0);
  return s < 0 ? 0 : s > MAX_STAGE ? MAX_STAGE : s;
}

/** Drill stages: clean +1, shaky stays, failed back to 0. */
export function nextStage(stage: number, grade: Grade): number {
  const s = clampStage(stage);
  if (grade === 'clean') return Math.min(MAX_STAGE, s + 1);
  if (grade === 'failed') return 0;
  return s;
}

/** Interval for a stage, capped near a deadline at max(1, floor(days_left / 3)). */
export function intervalFor(stage: number, daysLeft: number | null | undefined): number {
  let iv = INTERVALS[clampStage(stage)];
  if (typeof daysLeft === 'number' && isFinite(daysLeft)) iv = Math.min(iv, Math.max(1, Math.floor(Math.max(0, daysLeft) / 3)));
  return iv;
}

export function deadlineFactor(daysLeft: number | null | undefined): number {
  if (typeof daysLeft !== 'number' || !isFinite(daysLeft)) return 1;
  return 1 + 2 * Math.exp(-Math.max(0, daysLeft) / 14);
}

/** priority = overdue days * (1 + 2 exp(-days_to_deadline / 14)) */
export function priority(overdue: number, daysLeft: number | null | undefined): number {
  return Math.max(0, overdue) * deadlineFactor(daysLeft);
}

/** The push level a basic has earned: 1 at stage >= 2 with the last result clean, 2 at stage >= 3 with >= 2 clean in a row, 3 at stage >= 4. */
export function eligiblePush(stage: number, streak: number, last: Grade | null): number {
  if (stage >= 4) return 3;
  if (stage >= 3 && streak >= 2) return 2;
  if (stage >= 2 && last === 'clean') return 1;
  return 0;
}

/** Raised by a clean result (to what it has earned), held by shaky, one failure drops a level. */
export function nextPush(push: number, grade: Grade, stageAfter: number, streakAfter: number): number {
  const p = Math.max(0, Math.min(3, Number(push) || 0));
  if (grade === 'failed') return Math.max(0, p - 1);
  if (grade === 'clean') return Math.max(p, eligiblePush(stageAfter, streakAfter, 'clean'));
  return p;
}

/** held 1, held after help 0.75, missed or blind 0, moot no score. */
export function scoreFor(verdict: string, help: boolean | number): number | null {
  if (verdict === 'moot') return null;
  if (verdict === 'held') return help ? 0.75 : 1;
  return 0;
}

/** Kata: pass on the first run 1, pass after failed runs 0.75, gave up or no pass 0. */
export function kataScore(pass: boolean, runs: number, gaveUp: boolean): number {
  if (pass && !gaveUp) return (Number(runs) || 1) <= 1 ? 1 : 0.75;
  return 0;
}

export function isHiddenSlot(i: number, push: boolean): boolean {
  return !!push && i % HIDDEN_EVERY === HIDDEN_EVERY - 1;
}

/** Fog: no reveals is clean, every step revealed is failed, anything between is shaky. */
export function fogGrade(reveals: number, steps: number, clean?: boolean): Grade {
  const r = Math.max(0, Number(reveals) || 0);
  const s = Math.max(0, Number(steps) || 0);
  if (s > 0 && r >= s) return 'failed';
  if (r > 0) return 'shaky';
  return clean === false ? 'shaky' : 'clean';
}

/** Drills Today plans by minutes (Saturday doubles them): under 45 two, under 90 three, else four. */
export function drillCount(minutes: number, weekday: number): number {
  const m = (Number(minutes) || 0) * (weekday === 6 ? 2 : 1);
  return m < 45 ? 2 : m < 90 ? 3 : 4;
}

/* ------------------------------------------------------------------------------------------ *
 * Dates: YYYY-MM-DD strings, day arithmetic in UTC days
 * ------------------------------------------------------------------------------------------ */

function pad(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/** The local calendar date of a time. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function validDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function dayNum(s: string): number {
  const a = s.split('-');
  return Math.round(Date.UTC(+a[0], +a[1] - 1, +a[2]) / DAY);
}

export function fromDayNum(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function addDays(s: string, k: number): string {
  return fromDayNum(dayNum(s) + k);
}

/** a - b in days. */
export function dayDiff(a: string, b: string): number {
  return dayNum(a) - dayNum(b);
}

/** 0 Sunday .. 6 Saturday. */
export function weekday(s: string): number {
  return new Date(dayNum(s) * DAY).getUTCDay();
}

/** The device-local date of an event time: its ISO string carries the device's offset, so the date part is the day there. */
export function eventDay(t: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  if (m) return m[1];
  const ms = Date.parse(t);
  return isFinite(ms) ? ymd(new Date(ms)) : '1970-01-01';
}

/** ISO time with the local offset, e.g. 2026-11-17T14:05:00.000+05:30 (SPEC.md, Storage). */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** A stable pseudo-random number in [0, 1) for tie-breaks (FNV-1a). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** `nt-*` style globs against a doc id: `*` any run, `?` one character. */
export function globMatch(pattern: string, id: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(id);
}

export function f2(x: number): string {
  return (Math.round(x * 100) / 100).toFixed(2);
}

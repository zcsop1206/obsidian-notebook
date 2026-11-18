/**
 * The drill block (SPEC.md, Blocks: Drill): a derive prompt drilled on a blank page. Done unlocks
 * after 3 strokes and only then shows the model's steps or solution; a self-grade (clean, shaky,
 * failed; one tap) logs one `drill` event; the attempt replays at 1x, 4x or 16x with stalls over 30 s
 * marked on the timeline. Owned by S6 on docs/study/BOARD.md. Reference: lab/study-reader/src/block-drill.js.
 *
 * Also the shared parts of S6 and S7's blocks: `runDrill` (used by fog at push 2 and by recall), the
 * pure replay arithmetic, the per-device session store, the two-tap button and the blocks' CSS.
 * Nothing here imports 'obsidian', so the pure parts run under node:test.
 */
import type { NewEvent } from '../context';
import type { DrillGrade, ProofStep, StudyEvent } from '../types';
import type { BlockEnv, BlockHandle, BlockMount, InkStroke, InkSurface } from '../view/host';
import { mountFigureInk } from './figure-ink';

/* ------------------------------------------------------------------------------------------ *
 * Constants and pure helpers (unit-tested in test/unit/study-fog.test.ts)
 * ------------------------------------------------------------------------------------------ */

/** Done, Give up, Show and a fog reveal all need this many strokes of the reader's own first. */
export const MIN_STROKES = 3;
/** A gap with no ink longer than this is a stall. */
export const STALL_MS = 30000;
export const SPEEDS = [1, 4, 16];
export const GRADES: DrillGrade[] = ['clean', 'shaky', 'failed'];
export const MODEL_LABEL = "Written by a model for Adit. Not Adit's words.";

export function canFinish(strokes: number): boolean {
  return strokes >= MIN_STROKES;
}

/** Epoch ms of a stroke's first and last point. */
export function strokeStart(s: InkStroke): number {
  return (s.t0 || 0) + (s.p.length ? +s.p[0][3] || 0 : 0);
}
export function strokeEnd(s: InkStroke): number {
  return (s.t0 || 0) + (s.p.length ? +s.p[s.p.length - 1][3] || 0 : 0);
}

/** Start and end of a stroke in ms from the attempt's start. */
export function strokeSpan(s: InkStroke, start: number): { t0: number; t1: number } {
  const t0 = Math.max(0, strokeStart(s) - start);
  return { t0, t1: Math.max(t0, strokeEnd(s) - start) };
}

export interface Stall {
  /** ms from the start. */
  from: number;
  to: number;
  /** Index (in time order) of the stroke after the stall, or -1 for a stall before Done. */
  next: number;
  /** Where the next stroke began, paper px. */
  x?: number;
  y?: number;
}

export interface Analysis {
  total: number;
  inking: number;
  strokes: number;
  stalls: Stall[];
  longest: Stall | null;
}

function byStart(strokes: InkStroke[]): InkStroke[] {
  return strokes.filter(s => s && Array.isArray(s.p) && s.p.length > 0).sort((a, b) => strokeStart(a) - strokeStart(b));
}

/** Stalls over STALL_MS, inking time and the longest stall of an attempt from `start`, `end` ms long. */
export function analyse(strokes: InkStroke[], start: number, end: number): Analysis {
  const ss = byStart(strokes);
  const stalls: Stall[] = [];
  let prev = 0;
  let inking = 0;
  ss.forEach((s, i) => {
    const sp = strokeSpan(s, start);
    if (sp.t0 - prev > STALL_MS) stalls.push({ from: prev, to: sp.t0, next: i, x: s.p[0][0], y: s.p[0][1] });
    prev = Math.max(prev, sp.t1);
    inking += sp.t1 - sp.t0;
  });
  const total = Math.max(0, end);
  if (total - prev > STALL_MS) stalls.push({ from: prev, to: total, next: -1 });
  let longest: Stall | null = null;
  for (const st of stalls) if (!longest || st.to - st.from > longest.to - longest.from) longest = st;
  return { total, inking, strokes: ss.length, stalls, longest };
}

/** The strokes as they stood T ms after the start: later ones left out, the one being written cut. */
export function frameList(strokes: InkStroke[], start: number, T: number): InkStroke[] {
  const out: InkStroke[] = [];
  for (const s of byStart(strokes)) {
    const base = (s.t0 || 0) - start;
    const p = s.p;
    if (base + (+p[0][3] || 0) > T) continue;
    if (base + (+p[p.length - 1][3] || 0) <= T) { out.push(s); continue; }
    let n = 1;
    while (n < p.length && base + (+p[n][3] || 0) <= T) n++;
    out.push({ ...s, p: p.slice(0, n) });
  }
  return out;
}

/** Replay position after `wallMs` of playing at `speed` from `T0`, clamped to the attempt's length. */
export function replayTime(T0: number, wallMs: number, speed: number, end: number): number {
  return Math.max(0, Math.min(end, T0 + Math.max(0, wallMs) * speed));
}

/** Wall-clock ms a full replay of an attempt `end` ms long takes at `speed`. */
export function replayWallMs(end: number, speed: number): number {
  return Math.max(0, end) / Math.max(1, speed);
}

/** A grade is taken once, only after Done; a given-up attempt can only be failed. */
export function canGrade(st: { start: number | null; end: number | null; grade: DrillGrade | null; gaveUp: boolean }, g: DrillGrade): boolean {
  if (st.start === null || st.end === null || st.grade) return false;
  if (GRADES.indexOf(g) < 0) return false;
  return !st.gaveUp || g === 'failed';
}

export function drillEvent(doc: string, item: string, grade: DrillGrade, ms: number, src: 'drill' | 'probe' | 'recall'): NewEvent {
  return { type: 'drill', doc, item, grade, ms: Math.max(0, Math.round(ms)), src };
}

export function fmtDur(ms: number): string {
  let s = Math.floor(Math.max(0, ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s %= 60;
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s);
}

export function timeOf(e: StudyEvent): number {
  const t = Date.parse(e.t);
  return isFinite(t) ? t : 0;
}

/** The newest event of `type` matching `pred`, or null. */
export function lastEvent<K extends StudyEvent['type']>(events: StudyEvent[], type: K, pred: (e: Extract<StudyEvent, { type: K }>) => boolean): Extract<StudyEvent, { type: K }> | null {
  let best: Extract<StudyEvent, { type: K }> | null = null;
  for (const e of events) {
    if (e.type !== type) continue;
    const x = e as Extract<StudyEvent, { type: K }>;
    if (!pred(x)) continue;
    if (!best || timeOf(x) >= timeOf(best)) best = x;
  }
  return best;
}

/** Runs `fn`, returning `fallback` if it throws (engine stubs throw until S2 lands). */
export function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

/** The push level of the doc's basic: 0 steps, 1 chunks, 2 cold, 3 hook. */
export function pushOf(env: BlockEnv): number {
  const n = Math.floor(Number(safe(() => env.ctx.engine().pushLevel(env.doc.id), 0)));
  return n >= 0 && n <= 3 ? n : 0;
}

/* ------------------------------------------------------------------------------------------ *
 * Per-device session state: an in-memory map mirrored to localStorage. Only conveniences live
 * here (a clock started, a verdict chosen before the ticks); results go to the event log.
 * ------------------------------------------------------------------------------------------ */

const mem = new Map<string, unknown>();
const LS_PREFIX = 'notebook-study:';

export function loadLocal<T>(key: string): T | null {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + key);
    if (raw) {
      const v = JSON.parse(raw) as T;
      mem.set(key, v);
      return v;
    }
  } catch { /* private mode, node, or blocked storage: memory only */ }
  return null;
}

export function saveLocal(key: string, v: unknown): void {
  if (v === null || v === undefined) mem.delete(key);
  else mem.set(key, v);
  try {
    if (v === null || v === undefined) window.localStorage.removeItem(LS_PREFIX + key);
    else window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(v));
  } catch { /* memory only */ }
}

/* ------------------------------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------------------------------ */

/** First tap arms the button (class nb-sb-armed, `armedText`), a second within `ms` runs `fn`. */
export function twoTap(btn: HTMLButtonElement, armedText: string, fn: () => void, ms = 3500): { disarm(): void; destroy(): void } {
  let armed = false;
  let timer = 0;
  let text = btn.textContent || '';
  const disarm = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    if (armed) { armed = false; btn.classList.remove('nb-sb-armed'); btn.textContent = text; }
  };
  const onClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    if (!armed) {
      text = btn.textContent || '';
      armed = true;
      btn.classList.add('nb-sb-armed');
      btn.textContent = armedText;
      timer = window.setTimeout(disarm, ms);
      return;
    }
    disarm();
    fn();
  };
  btn.addEventListener('click', onClick);
  return { disarm, destroy: () => { disarm(); btn.removeEventListener('click', onClick); } };
}

export function button(parent: HTMLElement, text: string, act: string, cls = ''): HTMLButtonElement {
  const b = parent.createEl('button', cls ? { text, cls } : { text });
  b.type = 'button';
  b.setAttribute('data-sb', act);
  return b;
}

/** Grey bars standing in for fogged text: no words of it are in the DOM. */
export function fogBars(parent: HTMLElement, rows: number, seed: number): HTMLElement {
  const W = [[96, 88, 72], [92, 97, 64, 80], [85, 94, 58], [98, 76, 90, 52]];
  const box = parent.createDiv({ cls: 'nb-sb-bars' });
  for (let r = 0; r < rows; r++) {
    const set = W[(seed + Math.floor(r / 3)) % W.length];
    box.createSpan().style.width = set[r % set.length] + '%';
  }
  return box;
}

/** Draws strokes on a canvas in paper px (800 wide): the replay. */
export function paintStrokes(canvas: HTMLCanvasElement, strokes: InkStroke[], heightPx: number): void {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const w = 800;
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(heightPx * ratio)) {
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(heightPx * ratio);
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, w, heightPx);
  g.strokeStyle = (getComputedStyle(canvas).getPropertyValue('--text-normal') || '').trim() || '#222';
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const s of strokes) {
    const p = s.p;
    if (!p.length) continue;
    g.beginPath();
    g.moveTo(p[0][0], p[0][1]);
    if (p.length === 1) g.lineTo(p[0][0] + 0.1, p[0][1]);
    for (let i = 1; i < p.length - 1; i++) g.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
    if (p.length > 1) g.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    g.stroke();
  }
}

export const BLOCK_CSS = `
.nb-sb{font-size:14px;line-height:1.45;color:var(--text-normal);margin:10px 0 16px}
.nb-sb .nb-sb-row{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;margin:6px 0}
.nb-sb .nb-sb-sp{flex:1}
.nb-sb .nb-sb-kick{font-size:12px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--text-muted)}
.nb-sb .nb-sb-chip{font-size:11px;font-weight:600;border:1px solid var(--background-modifier-border);border-radius:999px;padding:0 8px;color:var(--text-muted)}
.nb-sb .nb-sb-yours{font-size:11px;font-weight:650;background:var(--color-green,#2e8b57);color:var(--background-primary,#fff);border-radius:999px;padding:0 9px}
.nb-sb .nb-sb-status{font-size:12px;border:1px solid currentColor;border-radius:999px;padding:0 8px;color:var(--text-muted)}
.nb-sb .nb-sb-hint{font-size:12.5px;color:var(--text-muted);margin:4px 0}
.nb-sb .nb-sb-by{font-size:12px;color:var(--text-muted);font-style:italic;margin:4px 0}
.nb-sb .nb-sb-paper{position:relative;border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden}
.nb-sb .nb-sb-ovl{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:14px;text-align:center;background:var(--background-primary,#fff);color:var(--text-muted)}
.nb-sb .nb-sb-ovl[hidden]{display:none}
.nb-sb .nb-sb-ovl p{margin:0;max-width:46ch}
.nb-sb .nb-sb-step{margin:8px 0;padding:6px 10px;border-radius:0 8px 8px 0}
.nb-sb .nb-sb-step.shown{border-left:3px solid var(--color-purple,#8a3ffc)}
.nb-sb .nb-sb-step.late{border-left-style:dashed}
.nb-sb .nb-sb-stepk{font-size:12px;font-weight:600;color:var(--text-muted)}
.nb-sb .nb-sb-bars{display:flex;flex-direction:column;gap:7px;padding:6px 0}
.nb-sb .nb-sb-bars span{display:block;height:10px;border-radius:5px;background:var(--background-modifier-border)}
.nb-sb .nb-sb-tl{position:relative;height:40px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;cursor:pointer;touch-action:none}
.nb-sb .nb-sb-tl .nb-sb-ink{position:absolute;top:22px;height:10px;background:var(--text-normal);opacity:.5;min-width:2px}
.nb-sb .nb-sb-tl .nb-sb-stall{position:absolute;top:0;bottom:0;border-left:2px solid var(--color-orange,#b7791f);background:rgba(183,121,31,.18)}
.nb-sb .nb-sb-tl .nb-sb-stall.longest{border-left-color:var(--color-red,#c33);background:rgba(204,51,51,.18)}
.nb-sb .nb-sb-tl .nb-sb-stall span{position:absolute;top:2px;left:4px;font-size:11px;font-weight:600;white-space:nowrap}
.nb-sb .nb-sb-tl .nb-sb-head{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--interactive-accent,#2f5fd0)}
.nb-sb canvas.nb-sb-replay{width:100%;display:block;border:1px solid var(--background-modifier-border);border-radius:8px;margin-top:6px}
.nb-sb button.nb-sb-sel,.nb-sb button[aria-pressed="true"]{background:var(--interactive-accent,#2f5fd0);color:var(--text-on-accent,#fff)}
.nb-sb button.nb-sb-armed{outline:2px solid var(--color-red,#c33)}
.nb-sb .nb-sb-lock{padding:10px 14px;border-radius:8px;background:var(--background-secondary)}
.nb-sb .nb-sb-q{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--color-purple,#8a3ffc);color:var(--color-purple,#8a3ffc);font-weight:700}
.nb-sb .nb-sb-card{border:1px solid var(--background-modifier-border);border-radius:10px;padding:10px 12px;margin:8px 0}
.nb-sb .nb-sb-verbs{display:flex;flex-wrap:wrap;gap:6px}
.nb-sb .nb-sb-verbs button{display:flex;flex-direction:column;align-items:center;min-width:104px;min-height:48px}
.nb-sb .nb-sb-verbs small{font-size:11px;opacity:.8}
.nb-sb .nb-sb-ticks{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.nb-sb .nb-sb-gap{padding:8px 12px;border-left:3px solid var(--color-purple,#8a3ffc);background:var(--background-secondary)}
.nb-sb .nb-sb-legend i{display:inline-block;width:16px;height:3px;border-radius:2px;vertical-align:middle;margin:0 5px 0 8px}
.nb-study-figure{display:inline-block;max-width:100%;line-height:0;position:relative;isolation:isolate}
.nb-study-figure img{display:block;width:100%;height:auto;-webkit-user-drag:none}
.nb-study-figure .nb-study-figure-undo{position:absolute;top:6px;right:6px;z-index:1;margin:0;height:auto;min-height:0;padding:4px 10px;font-size:12px;line-height:1.3;border-radius:999px;border:1px solid var(--background-modifier-border,#ddd);background:var(--background-primary,#fff);color:var(--text-normal);box-shadow:0 1px 4px rgba(0,0,0,.18);cursor:pointer}
.nb-study-figure .nb-study-figure-undo[hidden]{display:none}
`;

const STYLE_ID = 'nb-study-blocks-css';

/** Injects the blocks' CSS once. register.ts removes it on unload. */
export function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = BLOCK_CSS;
  document.head.appendChild(s);
}

export function removeStyles(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(STYLE_ID)?.remove();
}

/* ------------------------------------------------------------------------------------------ *
 * The blank-page runner: derive drills, cold proofs (fog at push 2) and recall cards
 * ------------------------------------------------------------------------------------------ */

export interface DrillSpec {
  /** The anchor drilled: a derive, a proof or a recall prompt. Logged as the event's `item`. */
  item: string;
  /** The ink surface key (`drill:<anchor>`, `recall:<anchor>`). */
  key: string;
  src: 'drill' | 'recall';
  /** Markdown shown above the page (the derive or recall prompt); omitted when the doc shows it. */
  prompt?: string | null;
  /** The model's steps, shown after Done. */
  steps?: ProofStep[];
  /** The model's answer or solution markdown, shown after Done when there are no steps. */
  answer?: string | null;
  kicker?: string;
  onGrade?(g: DrillGrade): void;
  onStart?(): void;
}

export interface DrillApi {
  el: HTMLElement;
  phase(): 'idle' | 'live' | 'done';
  grade(): DrillGrade | null;
  destroy(): void;
}

interface DrillState {
  v: 1;
  start: number | null;
  end: number | null;
  grade: DrillGrade | null;
  gaveUp: boolean;
  h: number;
}

const H_PAGE = 600;
const H_MORE = 400;
const H_MAX = 4000;
const H_RECALL = 260;

export function runDrill(host: HTMLElement, env: BlockEnv, spec: DrillSpec): DrillApi {
  ensureStyles();
  const recall = spec.src === 'recall';
  const lkey = `${spec.key}@${env.doc.id}`;
  const blank = (): DrillState => ({ v: 1, start: null, end: null, grade: null, gaveUp: false, h: recall ? H_RECALL : H_PAGE });
  const stored = loadLocal<DrillState>(lkey);
  let st: DrillState = stored && stored.v === 1 ? { ...blank(), ...stored } : blank();
  /** False until this attempt is known to be fresh or has adopted the strokes already in the file. */
  let restored = !!stored;
  let dead = false;
  let timer = 0;
  const save = () => { if (!dead) saveLocal(lkey, st); };
  const phase = (): 'idle' | 'live' | 'done' => (st.start === null ? 'idle' : st.end === null ? 'live' : 'done');

  const root = host.createDiv({ cls: 'nb-sb nb-sb-drill' + (recall ? ' nb-sb-recall' : '') });
  root.setAttribute('data-item', spec.item);
  const head = root.createDiv({ cls: 'nb-sb-row' });
  head.createSpan({ cls: 'nb-sb-kick', text: spec.kicker || (recall ? 'Recall' : 'Blank-page drill') });
  const status = head.createSpan({ cls: 'nb-sb-status' });
  head.createSpan({ cls: 'nb-sb-sp' });
  const clock = head.createSpan({ cls: 'nb-sb-timer', text: recall ? '' : '0:00' });
  if (spec.prompt) {
    const pr = root.createDiv({ cls: 'nb-sb-prompt' });
    void env.render(spec.prompt, pr).then(() => { figInk?.(); figInk = mountFigureInk(pr, env, spec.item); env.relayout(); });
  }
  const paper = root.createDiv({ cls: 'nb-sb-paper' });
  const surface: InkSurface = env.ink.surface(env.doc, paper, spec.key, {
    height: () => st.h,
    readOnly: () => dead || (recall ? phase() === 'done' : phase() !== 'live'),
  });
  let ovl: HTMLElement | null = null;
  if (!recall) {
    ovl = paper.createDiv({ cls: 'nb-sb-ovl' });
    ovl.createEl('p', { text: 'Blank page. Write it out from memory. None of the model’s version shows until you tap Done.' });
    button(ovl, 'Start', 'start', 'mod-cta');
    ovl.createEl('p', { cls: 'nb-sb-hint', text: 'The clock starts when you tap Start. The Pencil writes; fingers scroll.' });
  }
  const tools = root.createDiv({ cls: 'nb-sb-row' });
  const undoB = button(tools, 'Undo', 'undo');
  const moreB = button(tools, 'More paper', 'more');
  const gate = tools.createSpan({ cls: 'nb-sb-hint nb-sb-gate' });
  tools.createSpan({ cls: 'nb-sb-sp' });
  const giveB = recall ? null : button(tools, 'Give up', 'giveup');
  const doneB = button(tools, recall ? 'Show' : 'Done', 'done', 'mod-cta');
  const after = root.createDiv({ cls: 'nb-sb-after' });
  after.hidden = true;

  const giveTap = giveB ? twoTap(giveB, 'Tap again: show it, counts as failed', () => finish(true)) : null;
  let againTap: { destroy(): void } | null = null;
  let figInk: (() => void) | null = null;

  /* ----- replay state ----- */
  const rp = { T: 0, playing: false, speed: 4, raf: 0, wall0: 0, T0: 0 };
  let replayCanvas: HTMLCanvasElement | null = null;
  let tlHead: HTMLElement | null = null;
  let rpTime: HTMLElement | null = null;
  let afterSig = '';

  const strokes = (): InkStroke[] => surface.strokes();
  const count = (): number => surface.count();

  function syncTools(): void {
    const ph = phase();
    const n = count();
    const live = recall ? ph !== 'done' : ph === 'live';
    undoB.hidden = !live;
    undoB.disabled = !n;
    moreB.hidden = !live;
    moreB.disabled = st.h >= H_MAX;
    doneB.hidden = !live;
    doneB.disabled = !canFinish(n);
    if (giveB) { giveB.hidden = !live; giveB.disabled = !canFinish(n); if (!live) giveTap?.disarm(); }
    gate.textContent = live && !canFinish(n) ? `${recall ? 'Show' : 'Done'} unlocks after ${MIN_STROKES} strokes (${n} so far).` : '';
    status.textContent = ph === 'idle' ? (recall ? 'write first' : 'not started') : ph === 'live' ? (recall ? 'writing' : 'clock running')
      : (st.gaveUp ? 'gave up' : 'attempt ended') + (st.grade ? ` · graded ${st.grade}` : ' · grade it');
    if (ovl) ovl.hidden = ph !== 'idle';
    surface.setReadOnly(recall ? ph === 'done' : ph !== 'live');
    root.setAttribute('data-phase', ph);
    tick();
  }

  function tick(): void {
    if (recall) return;
    const ph = phase();
    clock.textContent = fmtDur(ph === 'idle' ? 0 : ph === 'live' ? Date.now() - (st.start || Date.now()) : st.end || 0);
  }
  function startTimer(): void {
    if (timer || recall) return;
    timer = window.setInterval(() => { if (dead || phase() !== 'live') stopTimer(); else tick(); }, 500);
  }
  function stopTimer(): void { if (timer) { window.clearInterval(timer); timer = 0; } }

  function sync(): void {
    if (dead) return;
    syncTools();
    if (phase() === 'live') startTimer(); else stopTimer();
    if (phase() === 'done') renderAfter();
    else if (afterSig || !after.hidden) { pause(); after.hidden = true; after.empty(); afterSig = ''; }
    env.relayout();
  }

  /* ----- after Done: replay, stats, the model's version, the grade ----- */
  function renderAfter(): void {
    const sig = `${st.start}|${st.end}|${st.grade}|${count()}`;
    if (sig === afterSig) return;
    afterSig = sig;
    pause();
    againTap?.destroy();
    againTap = null;
    after.empty();
    after.hidden = false;
    const start = st.start || 0;
    const end = st.end || 0;
    if (!recall) {
      const an = analyse(strokes(), start, end);
      const rpBox = after.createDiv({ cls: 'nb-sb-rp' });
      const ctl = rpBox.createDiv({ cls: 'nb-sb-row' });
      button(ctl, 'Play', 'play');
      for (const s of SPEEDS) {
        const b = button(ctl, `${s}×`, 'speed');
        b.setAttribute('data-speed', String(s));
        b.setAttribute('aria-pressed', String(s === rp.speed));
      }
      ctl.createSpan({ cls: 'nb-sb-sp' });
      rpTime = ctl.createSpan({ cls: 'nb-sb-hint' });
      const tl = rpBox.createDiv({ cls: 'nb-sb-tl no-ink' });
      const tot = Math.max(1, end);
      const pct = (v: number) => (Math.max(0, Math.min(1, v / tot)) * 100).toFixed(3) + '%';
      for (const s of an.stalls) {
        const d = tl.createDiv({ cls: 'nb-sb-stall' + (s === an.longest ? ' longest' : '') });
        d.style.left = pct(s.from);
        d.style.width = pct(s.to - s.from);
        d.setAttribute('data-ms', String(s.to - s.from));
        d.createSpan({ text: fmtDur(s.to - s.from) });
      }
      for (const s of strokes()) {
        if (!s.p.length) continue;
        const sp = strokeSpan(s, start);
        const d = tl.createDiv({ cls: 'nb-sb-ink' });
        d.style.left = pct(sp.t0);
        d.style.width = pct(sp.t1 - sp.t0);
      }
      tlHead = tl.createDiv({ cls: 'nb-sb-head' });
      tl.addEventListener('pointerdown', e => {
        pause();
        const r = tl.getBoundingClientRect();
        seek(((e.clientX - r.left) / (r.width || 1)) * end);
      });
      replayCanvas = rpBox.createEl('canvas', { cls: 'nb-sb-replay' });
      rp.T = end;
      drawReplay();
      const L = an.longest;
      after.createDiv({
        cls: 'nb-sb-stats nb-sb-hint',
        text: `Total ${fmtDur(an.total)} · inking ${fmtDur(an.inking)} in ${an.strokes} strokes · ` +
          (an.stalls.length ? `${an.stalls.length} stall${an.stalls.length === 1 ? '' : 's'} over 30 s, longest ${fmtDur(L ? L.to - L.from : 0)}` : 'no stall over 30 s'),
      });
    }
    const model = after.createDiv({ cls: 'nb-sb-model' });
    model.createDiv({ cls: 'nb-sb-kick', text: recall ? 'The answer' : 'The model’s version' });
    const steps = spec.steps || [];
    if (steps.length) {
      for (const s of steps) {
        const d = model.createDiv({ cls: 'nb-sb-step shown' });
        d.createDiv({ cls: 'nb-sb-stepk', text: `Step ${s.n}` });
        void env.render(s.markdown, d.createDiv()).then(() => env.relayout());
      }
    } else if (spec.answer) {
      void env.render(spec.answer, model.createDiv()).then(() => env.relayout());
    } else {
      model.createEl('p', { cls: 'nb-sb-hint', text: 'No model answer in this doc: grade against your sources.' });
    }
    const gr = after.createDiv({ cls: 'nb-sb-grade' });
    gr.createDiv({ cls: 'nb-sb-kick', text: 'Grade yourself' });
    if (st.gaveUp) gr.createEl('p', { cls: 'nb-sb-hint', text: 'You gave up, so this attempt counts as failed.' });
    else if (!st.grade) gr.createEl('p', { cls: 'nb-sb-hint', text: 'Clean: every step there, in order. Shaky: there, with a gap or a slip. Failed: a step missing.' });
    const row = gr.createDiv({ cls: 'nb-sb-row nb-sb-grades' });
    for (const g of GRADES) {
      const b = button(row, g[0].toUpperCase() + g.slice(1), 'grade');
      b.setAttribute('data-grade', g);
      b.setAttribute('aria-pressed', String(st.grade === g));
      b.disabled = !!st.grade;
    }
    if (st.grade) {
      gr.createEl('p', { cls: 'nb-sb-hint nb-sb-logged', text: `Graded ${st.grade}. Logged.` + stageLine() });
      const again = button(gr.createDiv({ cls: 'nb-sb-row' }), 'New attempt', 'again');
      againTap = twoTap(again, 'Tap again: this page is cleared', () => doAgain());
    }
  }

  function stageLine(): string {
    const b = safe(() => env.ctx.engine().basic(env.doc.id), null);
    return b ? ` ${env.doc.title}: stage ${b.stage}${b.due ? `, next drill ${b.due}` : ''}.` : '';
  }

  function drawReplay(): void {
    if (!replayCanvas || st.start === null || st.end === null) return;
    paintStrokes(replayCanvas, frameList(strokes(), st.start, rp.T), st.h);
    const tot = Math.max(1, st.end);
    if (tlHead) tlHead.style.left = (Math.min(1, rp.T / tot) * 100) + '%';
    if (rpTime) rpTime.textContent = `${fmtDur(rp.T)} / ${fmtDur(st.end)}`;
    root.setAttribute('data-replay-t', String(Math.round(rp.T)));
  }
  function seek(t: number): void {
    if (st.end === null) return;
    rp.T = Math.max(0, Math.min(st.end, t));
    drawReplay();
  }
  function frame(now: number): void {
    rp.raf = 0;
    if (!rp.playing || dead || st.end === null) return;
    rp.T = replayTime(rp.T0, now - rp.wall0, rp.speed, st.end);
    drawReplay();
    if (rp.T >= st.end) { rp.playing = false; syncPlay(); return; }
    rp.raf = window.requestAnimationFrame(frame);
  }
  function play(): void {
    if (st.end === null) return;
    if (rp.T >= st.end) rp.T = 0;
    rp.playing = true;
    rp.T0 = rp.T;
    rp.wall0 = performance.now();
    if (!rp.raf) rp.raf = window.requestAnimationFrame(frame);
    syncPlay();
  }
  function pause(): void {
    rp.playing = false;
    if (rp.raf) { window.cancelAnimationFrame(rp.raf); rp.raf = 0; }
    syncPlay();
  }
  function syncPlay(): void {
    const b = after.querySelector('[data-sb="play"]');
    if (b) b.textContent = rp.playing ? 'Pause' : 'Play';
    after.querySelectorAll('[data-speed]').forEach(x => x.setAttribute('aria-pressed', String(Number(x.getAttribute('data-speed')) === rp.speed)));
  }

  /* ----- actions ----- */
  function doStart(): void {
    if (phase() !== 'idle') return;
    st.start = Date.now();
    restored = true;
    save();
    spec.onStart?.();
    sync();
  }
  function finish(gaveUp: boolean): void {
    if (recall ? phase() === 'done' : phase() !== 'live') return;
    if (!canFinish(count())) return;
    const ss = strokes();
    if (st.start === null) st.start = ss.reduce((m, s) => Math.min(m, strokeStart(s)), Date.now());
    let lastT = 0;
    for (const s of ss) if (s.p.length) lastT = Math.max(lastT, strokeSpan(s, st.start).t1);
    st.end = Math.max(Date.now() - st.start, lastT, 1);
    st.gaveUp = gaveUp;
    save();
    sync();
    if (gaveUp) void doGrade('failed');
  }
  async function doGrade(g: DrillGrade): Promise<void> {
    if (!canGrade(st, g)) return;
    st.grade = g;
    save();
    afterSig = '';
    sync();
    try {
      await env.ctx.log(drillEvent(env.doc.id, spec.item, g, st.end || 0, spec.src));
    } catch (e) {
      console.error('[study] drill: logging the grade failed', e);
      env.toast('Could not log the grade: ' + String(e));
    }
    spec.onGrade?.(g);
  }
  function doAgain(): void {
    if (phase() !== 'done' || !st.grade) return;
    surface.clear();
    st = blank();
    restored = false;
    save();
    afterSig = '';
    sync();
  }
  function onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    const b = t && t.closest ? (t.closest('button') as HTMLButtonElement | null) : null;
    if (!b || !root.contains(b) || b.disabled) return;
    switch (b.getAttribute('data-sb')) {
      case 'start': doStart(); break;
      case 'undo': if (phase() !== 'done') surface.undo(); syncTools(); break;
      case 'more':
        if (phase() !== 'done') { st.h = Math.min(H_MAX, st.h + H_MORE); save(); surface.layout(); syncTools(); env.relayout(); }
        break;
      case 'done': finish(false); break;
      case 'play': if (rp.playing) pause(); else play(); break;
      case 'speed':
        rp.speed = Number(b.getAttribute('data-speed')) || 4;
        if (rp.playing) { rp.T0 = rp.T; rp.wall0 = performance.now(); }
        syncPlay();
        break;
      case 'grade': void doGrade(b.getAttribute('data-grade') as DrillGrade); break;
    }
  }
  root.addEventListener('click', onClick);

  /* Strokes already in the file (an earlier session, or the surface loading late): the attempt resumes
     from the first stroke, or shows graded if a drill event for this item came after the last stroke. */
  function adoptLoaded(): void {
    if (restored || phase() !== 'idle') return;
    const ss = strokes();
    if (!ss.length) return;
    restored = true;
    const first = ss.reduce((m, s) => Math.min(m, strokeStart(s)), Infinity);
    const last = ss.reduce((m, s) => Math.max(m, strokeEnd(s)), 0);
    st.start = isFinite(first) ? first : Date.now();
    const ev = lastEvent(env.ctx.events(), 'drill', e => e.doc === env.doc.id && e.item === spec.item && timeOf(e) >= last);
    if (ev) { st.end = Math.max(1, ev.ms || last - st.start); st.grade = ev.grade; }
    save();
  }
  const offInk = surface.onChange(() => {
    if (dead) return;
    adoptLoaded();
    sync();
  });
  adoptLoaded();
  sync();

  return {
    el: root,
    phase,
    grade: () => st.grade,
    destroy: () => {
      if (dead) return;
      dead = true;
      stopTimer();
      pause();
      giveTap?.destroy();
      againTap?.destroy();
      offInk();
      figInk?.();
      figInk = null;
      root.removeEventListener('click', onClick);
      surface.destroy();
      root.remove();
    },
  };
}

/* ------------------------------------------------------------------------------------------ *
 * The drill block, on derive passages
 * ------------------------------------------------------------------------------------------ */

export const mount: BlockMount = (el, env): BlockHandle => {
  const anchor = env.passage.block?.id || env.passage.anchor;
  const dv = env.doc.derives.find(d => d.anchor === anchor);
  if (!dv) {
    el.createDiv({ cls: 'nb-sb nb-sb-hint', text: `Drill ${anchor} is not in this doc.` });
    return { destroy: () => el.empty() };
  }
  const api = runDrill(el, env, {
    item: dv.anchor,
    key: `drill:${dv.anchor}`,
    src: 'drill',
    prompt: dv.prompt,
    steps: dv.solution && dv.solution.steps.length ? dv.solution.steps : undefined,
    answer: dv.solution ? dv.solution.markdown : null,
    kicker: 'Derive',
  });
  return { destroy: () => { api.destroy(); el.empty(); } };
};

/**
 * The kata block (SPEC.md, Blocks: Kata; FORMAT.md, Kata), ported from
 * lab/study-reader/src/block-kata.js for ticket S9. A kata runs in this order:
 *
 * 1. The design call: an ink sketch (the block's own surface, `kata:<id>`), one typed line and a
 *    confidence chip. The chips stay locked until the call has ink or a line; committing locks the
 *    call, opens the editor and starts the clock.
 * 2. The editor: the skeleton in a textarea, saved on change (400 ms) and on pagehide. Run executes
 *    the kata's vectors in the interpreter (src/study/kata/): the inputs of a row are applied, one
 *    rising edge of clk happens, the outputs are compared, and the first mismatch is shown with a
 *    small waveform around it. Compile and port errors are not counted as runs.
 * 3. Settle: the first pass (or a two-tap give-up) stops the clock; later runs are practice. Then
 *    two tick steps — the methods the call named, then the methods the kata took (pre-ticked with
 *    the methods taught by the kata's `needs`) — and the `kata` event is logged once.
 *
 * `level: hidden` katas show no title or needs before the settle (FORMAT.md). Working state lives
 * in the vault's local storage (per device), keyed `nb-study-kata:<doc>:<kata>`; the durable record
 * is the `kata` event.
 */
import type { StudyContext } from '../context';
import type { Kata, MethodEntry } from '../types';
import type { BlockEnv, BlockMount, InkSurface } from '../view/host';
import { fmtV, runVectors, waveSvg, type VectorRun } from '../kata/vectors';

const MODEL_LABEL = 'Written by a model for Adit. Not Adit\'s words.';
const CONF = [50, 60, 70, 80, 90];
const PAD_H = 220, LINE_H = 22, MIN_ROWS = 14, PASS_WIN = 32;

const TEXT = {
  callHint: 'Sketch the design with the Pencil or a mouse, then write the call in one line. Committing opens the editor and starts the clock.',
  chipsLocked: 'The chips unlock once the call has ink or a line.',
  editorLocked: 'The editor opens when you commit the call.',
  hiddenWhy: 'Topic hidden: working out what the spec needs is part of the kata.',
  calledHint: 'Read your call above and tick the methods it named. None ticked means it named none of these.',
  tookHint: 'Pre-ticked with the methods this kata’s basics teach. If your design took another route, tick what it used instead.',
  practice: 'Runs from here on are practice: the rating does not move again.',
  lang: 'The editor takes a small Verilog subset, run in the page.\n' +
    'module name ( input [7:0] a, output reg b ); … endmodule\n' +
    'input / output [reg] [N:0] name;   reg [N:0] name;   wire [N:0] name [= expr];\n' +
    'parameter NAME = 4;   localparam NAME = 4;\n' +
    'assign name = expr;\n' +
    'always @(posedge clk) statement     (nonblocking <= only; reset is synchronous)\n' +
    'if (…) … else …   begin … end   case (x) v1, v2: … default: … endcase\n' +
    'name[i] <= …   name[h:l] <= …\n' +
    '+ - * / %   & | ^ ~^ ~ !   << >>   == != < <= > >=   && ||   ?:\n' +
    "unary & | ^ (reductions)   a[i]  a[h:l]  {a, b}  {4{a}}   8'h07  4'b1010  1'b0  42\n\n" +
    'Widths follow Verilog sizing rules, up to 64 bits. Registers power up with random values. ' +
    'No x or z, no loops, no functions, no blocking assignments, no memories. ' +
    'Outputs are checked after every rising edge.',
};

/* ------------------------------------------------------------------------------------------ *
 * Working state, kept on this device (the `kata` event is the durable record)
 * ------------------------------------------------------------------------------------------ */

interface KataRun {
  ok: boolean;
  err: boolean;
  cyc: number | null;
  sig: string | null;
  at: number;
  practice: boolean;
}

interface KataState {
  v: 1;
  committed: boolean;
  call: string;
  conf: number | null;
  t0: number | null;
  t1: number | null;
  code: string;
  runs: KataRun[];
  status: 'open' | 'passed' | 'gaveup';
  runsAtSettle: number | null;
  lastSrc: string | null;
  practicePass: boolean;
  called: string[];
  calledDone: boolean;
  used: string[];
  usedInit: boolean;
  usedDone: boolean;
  logged: boolean;
}

function fresh(k: Kata): KataState {
  return {
    v: 1, committed: false, call: '', conf: null, t0: null, t1: null,
    code: String(k.skeleton || ''), runs: [], status: 'open', runsAtSettle: null, lastSrc: null,
    practicePass: false, called: [], calledDone: false, used: [], usedInit: false, usedDone: false,
    logged: false,
  };
}

function counted(s: KataState): number {
  return s.runs.filter(r => !r.err && !r.practice).length;
}
function uniq(a: string[]): string[] {
  const o: string[] = [];
  for (const x of a) if (x != null && o.indexOf(x) < 0) o.push(x);
  return o;
}
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = `${m}`.padStart(h ? 2 : 1, '0'), sss = `${ss}`.padStart(2, '0');
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}
function fmtD(d: number): string {
  return d % 1 ? d.toFixed(1) : String(d);
}
function scoreOf(s: KataState): number {
  const n = s.runsAtSettle ?? counted(s);
  if (s.status === 'passed' && n <= 1) return 1;
  if (s.status === 'passed') return 0.75;
  return 0;
}

/** Two taps to confirm a destructive or final action, as the demo's SR.twoTap. */
function twoTap(btn: HTMLElement, confirmText: string, fn: () => void): () => void {
  let armed = false, t = 0;
  const label = btn.textContent || '';
  const on = () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmText;
      t = window.setTimeout(() => { armed = false; btn.textContent = label; }, 3000);
      return;
    }
    window.clearTimeout(t);
    armed = false;
    btn.textContent = label;
    fn();
  };
  btn.addEventListener('click', on);
  return () => { window.clearTimeout(t); btn.removeEventListener('click', on); };
}

function chip(parent: HTMLElement, text: string, cls = ''): HTMLButtonElement {
  const b = parent.createEl('button', { text, cls: `nb-study-kata-chip ${cls}` });
  b.style.minHeight = '32px';
  return b;
}
function kick(parent: HTMLElement, text: string): void {
  const k = parent.createDiv({ text, cls: 'nb-study-kata-kick' });
  k.style.cssText = 'font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px';
}
function hint(parent: HTMLElement, text: string): HTMLElement {
  const h = parent.createEl('p', { text, cls: 'nb-study-kata-hint' });
  h.style.cssText = 'font-size:13px;color:var(--text-muted);margin:4px 0';
  return h;
}
function sec(parent: HTMLElement): HTMLElement {
  const s = parent.createDiv({ cls: 'nb-study-kata-sec' });
  s.style.cssText = 'margin-top:12px;border-top:1px dashed var(--background-modifier-border);padding-top:10px';
  return s;
}

/* ------------------------------------------------------------------------------------------ *
 * The mounted block
 * ------------------------------------------------------------------------------------------ */

function kataFor(env: BlockEnv): Kata | null {
  if (env.doc.kata) return env.doc.kata;
  const id = env.passage.block?.id;
  const fromIndex = id ? env.ctx.content().katas.get(id) : undefined;
  if (fromIndex) return fromIndex;
  /* A simple kata callout inline in a basic or topic has only its spec. */
  const c = env.passage.callout;
  if (c) {
    return {
      id: env.passage.block?.id || env.passage.anchor, title: c.title || 'kata', area: env.doc.areas[0] || '',
      needs: [], d: c.d, level: 'simple', spec: c.body, ports: [], skeleton: '', vectors: null,
    };
  }
  return null;
}

export const mount: BlockMount = (host, env) => {
  const ctx = env.ctx;
  const kk = kataFor(env);
  if (!kk) {
    host.createDiv({ cls: 'nb-study-block-todo', text: 'Design kata: this doc has no kata parts.' });
    return { destroy: () => host.empty() };
  }
  const k: Kata = kk;
  const vectors = k.vectors;
  const key = `nb-study-kata:${env.doc.id}:${k.id}`;
  const mem = new Map<string, unknown>();
  const kvGet = (): unknown => {
    try {
      const a = ctx.app as unknown as { loadLocalStorage?: (k: string) => unknown };
      if (typeof a.loadLocalStorage === 'function') return a.loadLocalStorage(key);
    } catch (e) { /* fall through */ }
    try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return mem.get(key) ?? null; }
  };
  const kvSet = (v: unknown): void => {
    mem.set(key, v);
    try {
      const a = ctx.app as unknown as { saveLocalStorage?: (k: string, d: unknown) => void };
      if (typeof a.saveLocalStorage === 'function') { a.saveLocalStorage(key, v); return; }
    } catch (e) { /* fall through */ }
    try { window.localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage may be off */ }
  };
  function load(): KataState {
    let s = kvGet() as KataState | null;
    if (!s || typeof s !== 'object' || s.v !== 1) s = fresh(k);
    if (!Array.isArray(s.runs)) s.runs = [];
    if (!Array.isArray(s.called)) s.called = [];
    if (!Array.isArray(s.used)) s.used = [];
    if (typeof s.code !== 'string') s.code = String(k.skeleton || '');
    return s;
  }
  const save = (s: KataState) => kvSet(s);

  /* A kata the engine already holds a `kata` event for shows as settled here too. */
  function synced(): KataState {
    const s = load();
    if (!s.logged) {
      const ev = ctx.events().find(e => e.type === 'kata' && e.kata === k.id);
      if (ev && ev.type === 'kata') {
        s.committed = true;
        s.logged = true;
        if (s.status === 'open') s.status = ev.pass ? 'passed' : 'gaveup';
        if (s.runsAtSettle === null) s.runsAtSettle = ev.runs;
        s.called = ev.called.slice(); s.used = ev.used.slice();
        s.calledDone = s.usedInit = s.usedDone = true;
        save(s);
      }
    }
    return s;
  }

  /* The methods the tick lists offer: every method in methods.md, the ones taught by the kata's
     needs first (they are the kata's tags). */
  function allMethods(): MethodEntry[] {
    return [...ctx.content().methods.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  function needMethods(): string[] {
    return allMethods().filter(m => k.needs.indexOf(m.doc) >= 0).map(m => m.id);
  }
  const hidden = () => k.level === 'hidden';
  const settled = (s: KataState) => s.status !== 'open';

  const el = host.createDiv({ cls: 'nb-study-kata' });
  el.style.cssText = 'font-size:14px;line-height:1.45;position:relative';
  let pad: InkSurface | null = null;
  let timer = 0, saveT = 0;
  const offs: (() => void)[] = [];
  let dead = false;

  const q = <T extends HTMLElement>(sel: string): T | null => el.querySelector(sel) as T | null;
  function relayout() { try { env.relayout(); } catch (e) { /* view gone */ } }
  function destroyPad() { if (pad) { try { pad.destroy(); } catch (e) { /* noop */ } pad = null; } }
  function stopTimer() { if (timer) { window.clearInterval(timer); timer = 0; } }
  function startTimer() {
    stopTimer();
    const s = load();
    if (!s.t0 || s.t1) return;
    timer = window.setInterval(() => {
      if (dead) { stopTimer(); return; }
      const t = q<HTMLElement>('.nb-study-kata-time');
      if (t && s.t0) t.textContent = fmtDur(Date.now() - s.t0);
    }, 1000);
  }
  /* The editor saves 400 ms after the last keystroke; a reload or a discarded iPad tab inside that
     window would lose the edit, so every pending save flushes on hide and unload. */
  function flush() {
    if (!saveT) return;
    window.clearTimeout(saveT);
    saveT = 0;
    const ta = q<HTMLTextAreaElement>('.nb-study-kata-src');
    if (ta) { const s = load(); s.code = ta.value; save(s); }
  }
  const onHide = () => flush();
  window.addEventListener('pagehide', onHide);
  window.addEventListener('beforeunload', onHide);
  const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onVis);
  offs.push(() => {
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('beforeunload', onHide);
    document.removeEventListener('visibilitychange', onVis);
  });

  /* ---------------------------------------- head and meta ---------------------------------------- */

  function expectedNow(): { E: number; r: number; d: number } | null {
    if (k.d === null || k.d === undefined) return null;
    try {
      const r = ctx.engine().rating(k.area || 'dd');
      const E = ctx.engine().expected(k.d, r);
      return typeof E === 'number' && isFinite(E) ? { E, r, d: k.d } : null;
    } catch (e) { return null; }   // the engine lands with S2
  }
  function statusText(s: KataState): string {
    if (s.status === 'passed') return 'passed';
    if (s.status === 'gaveup') return s.practicePass ? 'gave up, passed later' : 'gave up';
    return s.committed ? 'open' : 'call first';
  }
  function renderMeta(s?: KataState) {
    s = s || load();
    const m = q<HTMLElement>('.nb-study-kata-meta');
    if (!m) return;
    m.empty();
    const x = expectedNow();
    const mk = (label: string, val: string, cls = '') => {
      const sp = m.createSpan({ cls: `nb-study-kata-mi ${cls}` });
      sp.style.marginRight = '14px';
      sp.appendText(`${label} `);
      const b = sp.createEl('b', { text: val });
      b.style.cssText = 'font-weight:600;font-family:var(--font-monospace)';
    };
    if (k.d !== null && k.d !== undefined) mk('difficulty', fmtD(k.d));
    if (x) mk('E', `${x.E.toFixed(2)} at r ${x.r.toFixed(2)}`);
    mk('runs', String(counted(s)), 'nb-study-kata-runs');
    const tm = m.createSpan();
    tm.style.marginRight = '14px';
    tm.appendText('time ');
    tm.createEl('b', { text: s.t0 ? fmtDur((s.t1 || Date.now()) - s.t0) : '–', cls: 'nb-study-kata-time' })
      .style.cssText = 'font-weight:600;font-family:var(--font-monospace)';
    mk('status', statusText(s));
  }
  function renderHead(s: KataState) {
    const head = el.createDiv({ cls: 'nb-study-kata-head' });
    head.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center';
    kick(head, 'Design kata');
    const badge = head.createSpan({ text: hidden() && !settled(s) ? '?' : k.level, cls: 'nb-study-kata-badge' });
    badge.style.cssText = 'font-size:12px;border:1px solid var(--background-modifier-border);border-radius:999px;padding:1px 8px;color:var(--text-muted)';
    if (hidden() && !settled(s)) badge.setAttribute('aria-label', 'Topic hidden');
    head.createSpan().style.flex = '1';
    const t = el.createDiv({ cls: 'nb-study-kata-title' });
    t.style.cssText = 'font-weight:650;font-size:17px;line-height:1.3;margin:6px 0 2px';
    t.textContent = hidden() && !settled(s) ? 'Design kata' : (k.title || k.id);
    const meta = el.createDiv({ cls: 'nb-study-kata-meta' });
    meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px 0;font-size:12.5px;color:var(--text-muted);margin:2px 0 6px;align-items:baseline';
    if (hidden() && !settled(s)) hint(el, TEXT.hiddenWhy);
    renderMeta(s);
  }

  function renderSpec() {
    const sp = el.createDiv({ cls: 'nb-study-kata-spec' });
    const by = sp.createDiv({ text: MODEL_LABEL });
    by.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0 0 4px';
    const body = sp.createDiv();
    if (k.spec) void env.render(k.spec, body);
    else hint(body, 'No spec in the content.');
    if (k.ports.length) {
      const p = sp.createEl('p');
      p.style.cssText = 'color:var(--text-muted);font-size:13px';
      const label = (t: string) => { const l = p.createSpan({ text: t }); l.style.cssText = 'font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin:0 6px 0 10px'; };
      const port = (n: string, w: number) => { const c = p.createEl('code', { text: w > 1 ? `${n}[${w - 1}:0]` : n }); c.style.marginRight = '8px'; };
      label('in');
      k.ports.filter(x => x.dir === 'input').forEach(x => port(x.name, x.width));
      label('out');
      k.ports.filter(x => x.dir === 'output').forEach(x => port(x.name, x.width));
    }
  }

  /* ---------------------------------------- 1. the design call ---------------------------------------- */

  function hasCall(): boolean {
    const line = q<HTMLInputElement>('.nb-study-kata-line');
    return (pad ? pad.count() : 0) > 0 || !!(line && line.value.trim());
  }
  function refreshCall() {
    const cm = q<HTMLButtonElement>('[data-k="commit"]'), h = q<HTMLElement>('.nb-study-kata-callhint');
    if (!cm) return;
    const s = load(), has = hasCall();
    el.querySelectorAll<HTMLButtonElement>('[data-conf]').forEach(b => { b.disabled = !has; });
    cm.disabled = !(has && s.conf);
    if (h) h.textContent = !has ? TEXT.chipsLocked : !s.conf ? 'Pick a confidence to commit.' : 'Committing locks the call and starts the clock.';
  }
  function renderCall(s: KataState) {
    const secEl = q<HTMLElement>('.nb-study-kata-call');
    if (!secEl) return;
    secEl.empty();
    destroyPad();
    if (!s.committed) {
      kick(secEl, 'Design call');
      hint(secEl, TEXT.callHint);
      const padBox = secEl.createDiv({ cls: 'nb-study-kata-pad' });
      padBox.style.cssText = 'margin:6px 0;border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden';
      pad = env.ink.surface(env.doc, padBox, `kata:${k.id}`, { height: PAD_H });
      const tools = secEl.createDiv();
      tools.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
      const undo = chip(tools, 'Undo');
      undo.addEventListener('click', () => { if (pad) pad.undo(); });
      const clr = chip(tools, 'Clear sketch');
      offs.push(twoTap(clr, 'Tap again to clear', () => { if (pad) pad.clear(); }));
      const line = secEl.createEl('input', { cls: 'nb-study-kata-line' }) as HTMLInputElement;
      line.type = 'text';
      line.maxLength = 200;
      line.placeholder = 'Your call, one line';
      line.setAttribute('aria-label', 'Your call, one line');
      line.setAttribute('autocomplete', 'off');
      line.setAttribute('autocapitalize', 'off');
      line.setAttribute('autocorrect', 'off');
      line.setAttribute('spellcheck', 'false');
      line.style.cssText = 'display:block;width:100%;font-size:15px;padding:8px 10px;margin:4px 0;box-sizing:border-box';
      line.value = s.call || '';
      line.addEventListener('input', () => { const s2 = load(); s2.call = line.value; save(s2); refreshCall(); });
      const confRow = secEl.createDiv();
      confRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0';
      const confHint = confRow.createSpan({ text: 'Confidence the first run passes' });
      confHint.style.cssText = 'font-size:13px;color:var(--text-muted);margin-right:6px';
      const paintConf = () => {
        el.querySelectorAll<HTMLButtonElement>('[data-conf]').forEach(x => {
          const on = x.classList.contains('sel');
          x.style.fontWeight = on ? '600' : '';
          x.style.background = on ? 'var(--background-modifier-hover)' : '';
        });
      };
      CONF.forEach(c => {
        const b = chip(confRow, `${c}%`);
        b.setAttribute('data-conf', String(c));
        if (s.conf === c) b.classList.add('sel');
        b.addEventListener('click', () => {
          if (b.disabled) return;
          const s2 = load();
          s2.conf = c;
          save(s2);
          el.querySelectorAll('[data-conf]').forEach(x => x.classList.toggle('sel', x === b));
          paintConf();
          refreshCall();
        });
      });
      paintConf();
      const row = secEl.createDiv();
      row.style.cssText = 'display:flex;gap:8px;align-items:center';
      const cm = chip(row, 'Commit call', 'primary');
      cm.setAttribute('data-k', 'commit');
      cm.addEventListener('click', commit);
      const ch = row.createSpan({ cls: 'nb-study-kata-callhint' });
      ch.style.cssText = 'font-size:13px;color:var(--text-muted)';
      refreshCall();
      return;
    }
    kick(secEl, 'Design call');
    const ro = secEl.createDiv();
    ro.style.cssText = 'border-left:3px solid var(--text-accent);padding:4px 0 4px 10px;margin-top:8px;font-size:15px';
    const ct = ro.createDiv();
    if (s.call) ct.textContent = s.call;
    else { const m = ct.createSpan({ text: '(no typed line)' }); m.style.color = 'var(--text-muted)'; }
    const ch2 = ro.createDiv({ text: s.conf ? `${s.conf}% that the first run passes` : 'no confidence given' });
    ch2.style.cssText = 'font-size:13px;color:var(--text-muted)';
    /* The sketch stays readable: the surface holds the strokes, drawn read-only. */
    const padBox = secEl.createDiv({ cls: 'nb-study-kata-pad' });
    padBox.style.cssText = 'margin:6px 0;border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden';
    pad = env.ink.surface(env.doc, padBox, `kata:${k.id}`, { height: PAD_H, readOnly: true });
  }
  function commit() {
    const line = q<HTMLInputElement>('.nb-study-kata-line');
    const s = load();
    if (s.committed || !hasCall() || !s.conf) return;
    s.call = line ? line.value.trim() : s.call;
    s.committed = true;
    s.t0 = Date.now();
    s.t1 = null;
    save(s);
    renderCall(s);
    renderCode(s);
    renderMeta(s);
    startTimer();
    relayout();
  }

  /* ---------------------------------------- 2. the editor and the runs ---------------------------------------- */

  function gutter(ta: HTMLTextAreaElement, errLine: number | null) {
    const g = ta.parentElement && ta.parentElement.querySelector<HTMLElement>('.nb-study-kata-gut');
    if (!g) return;
    const n = ta.value.split('\n').length;
    const out: HTMLElement[] = [];
    for (let i = 1; i <= n; i++) {
      const d = document.createElement('div');
      d.textContent = String(i);
      if (i === errLine) { d.style.color = 'var(--text-error)'; d.style.fontWeight = '700'; }
      out.push(d);
    }
    g.replaceChildren(...out);
  }
  /* The editor grows with its text (no scroll inside a scaled page); 14 rows at least. */
  function grow(ta: HTMLTextAreaElement) {
    const rows = Math.max(MIN_ROWS, ta.value.split('\n').length + 1);
    ta.style.height = `${rows * LINE_H + 34}px`;
  }
  function onEdit(ta: HTMLTextAreaElement, now: boolean) {
    gutter(ta, null);
    grow(ta);
    if (saveT) { window.clearTimeout(saveT); saveT = 0; }
    const fn = () => { saveT = 0; const s = load(); s.code = ta.value; save(s); };
    if (now) fn(); else saveT = window.setTimeout(fn, 400);
  }
  function insert(ta: HTMLTextAreaElement, text: string) {
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + text.length;
    onEdit(ta, false);
  }
  function onKey(ta: HTMLTextAreaElement, e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insert(ta, '  '); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      const v = ta.value, st = ta.selectionStart, ls = v.lastIndexOf('\n', st - 1) + 1;
      const ind = (/^[ \t]*/.exec(v.slice(ls, st)) || [''])[0];
      if (ind) { e.preventDefault(); insert(ta, `\n${ind}`); }
    }
  }
  function updateTools(s: KataState) {
    const gb = q<HTMLButtonElement>('[data-k="giveup"]');
    if (gb) gb.disabled = !(s.committed && s.status === 'open');
  }
  function renderCode(s: KataState) {
    const secEl = q<HTMLElement>('.nb-study-kata-code');
    if (!secEl) return;
    secEl.empty();
    if (!s.committed) { kick(secEl, 'RTL'); hint(secEl, TEXT.editorLocked); return; }
    kick(secEl, 'RTL');
    const ed = secEl.createDiv();
    ed.style.cssText = 'display:flex;border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden;background:var(--background-secondary);margin-top:4px';
    const gut = ed.createDiv({ cls: 'nb-study-kata-gut' });
    gut.style.cssText = `font-family:var(--font-monospace);font-size:12.5px;line-height:${LINE_H}px;padding:10px 6px;color:var(--text-muted);text-align:right;user-select:none;min-width:38px;white-space:pre;border-right:1px solid var(--background-modifier-border)`;
    gut.setAttribute('aria-hidden', 'true');
    const ta = ed.createEl('textarea', { cls: 'nb-study-kata-src' }) as HTMLTextAreaElement;
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('wrap', 'off');
    ta.setAttribute('aria-label', 'RTL editor');
    ta.style.cssText = `flex:1;min-width:0;display:block;font-family:var(--font-monospace);font-size:14px;line-height:${LINE_H}px;padding:10px;border:0;border-radius:0;outline:0;resize:none;background:transparent;color:var(--text-normal);white-space:pre;overflow-x:auto;overflow-y:hidden;tab-size:2`;
    ta.value = s.code;
    gutter(ta, null);
    grow(ta);
    ta.addEventListener('input', () => onEdit(ta, false));
    ta.addEventListener('keydown', e => onKey(ta, e));
    ta.addEventListener('blur', flush);
    const tools = secEl.createDiv();
    tools.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px';
    const run = chip(tools, 'Run', 'primary');
    run.setAttribute('data-k', 'run');
    if (!vectors) run.disabled = true;
    run.addEventListener('click', () => doRun(ta));
    const gb = chip(tools, 'Give up');
    gb.setAttribute('data-k', 'giveup');
    offs.push(twoTap(gb, 'Tap again to give up', doGiveUp));
    const sk = chip(tools, 'Restore skeleton');
    offs.push(twoTap(sk, 'Tap again to restore', () => { ta.value = String(k.skeleton || ''); onEdit(ta, true); }));
    const th = tools.createSpan({ text: vectors ? 'Compile errors do not count as runs.' : 'This kata has no test vectors.' });
    th.style.cssText = 'font-size:13px;color:var(--text-muted)';
    secEl.createDiv({ cls: 'nb-study-kata-result' }).setAttribute('aria-live', 'polite');
    const hist = secEl.createEl('ol', { cls: 'nb-study-kata-hist' });
    hist.style.cssText = 'font-size:12.5px;color:var(--text-muted);margin:8px 0 0;padding-left:22px';
    updateTools(s);
    renderHist(s);
    if (s.lastSrc != null && vectors) {
      const res = runVectors(k.ports, vectors, s.lastSrc);
      const last = s.runs.length ? s.runs[s.runs.length - 1] : null;
      showResult(res, s, last);
      if (res.error && res.line && ta.value === s.lastSrc) gutter(ta, res.line);
    }
    const lang = secEl.createEl('details', { cls: 'nb-study-kata-lang' });
    lang.style.marginTop = '12px';
    const sm = lang.createEl('summary', { text: 'Language reference' });
    sm.style.cssText = 'cursor:pointer;color:var(--text-muted);font-size:13px';
    const pre = lang.createEl('pre', { text: TEXT.lang });
    pre.style.cssText = 'font-family:var(--font-monospace);font-size:12.5px;line-height:1.5;white-space:pre-wrap;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:6px;padding:8px 10px;margin:6px 0';
  }
  function doRun(ta: HTMLTextAreaElement) {
    if (!vectors) return;
    flush();
    const src = ta.value, s = load();
    s.code = src;
    const res = runVectors(k.ports, vectors, src);
    const entry: KataRun = {
      ok: !!res.ok, err: !!res.error, cyc: res.mismatch ? res.mismatch.cycle : null,
      sig: res.mismatch ? res.mismatch.signal : null,
      at: s.t0 ? Date.now() - s.t0 : 0, practice: s.status !== 'open',
    };
    s.runs.push(entry);
    s.lastSrc = src;
    let settleNow = false;
    if (res.ok && s.status === 'open') { s.status = 'passed'; s.t1 = Date.now(); s.runsAtSettle = counted(s); settleNow = true; }
    else if (res.ok && s.status === 'gaveup') s.practicePass = true;
    save(s);
    if (settleNow) { stopTimer(); }
    showResult(res, s, entry);
    gutter(ta, res.error && res.line ? res.line : null);
    renderHist(s);
    renderMeta(s);
    updateTools(s);
    if (settleNow) renderSettle(load());
    relayout();
  }
  function doGiveUp() {
    flush();
    const s = load();
    if (!s.committed || s.status !== 'open') return;
    s.status = 'gaveup';
    s.t1 = Date.now();
    s.runsAtSettle = counted(s);
    save(s);
    stopTimer();
    renderMeta(s);
    updateTools(s);
    renderSettle(load());
    relayout();
  }
  function resBox(res: VectorRun, ok: boolean): HTMLElement {
    const box = document.createElement('div');
    box.style.cssText = `margin-top:10px;border-radius:8px;padding:10px 12px;border:1px solid ${ok ? 'var(--text-success)' : 'var(--text-error)'};background:var(--background-primary)`;
    const big = box.createDiv();
    big.style.cssText = `font-weight:700;font-size:16px;color:${ok ? 'var(--text-success)' : 'var(--text-error)'}`;
    return box;
  }
  function showResult(res: VectorRun, s: KataState, entry: KataRun | null) {
    const box = q<HTMLElement>('.nb-study-kata-result');
    if (!box) return;
    box.empty();
    const waveWrap = (svg: string) => {
      const w = document.createElement('div');
      w.style.cssText = 'overflow-x:auto;margin-top:10px;border:1px solid var(--background-modifier-border);border-radius:8px;background:var(--background-secondary)';
      w.innerHTML = svg;
      return w;
    };
    if (res.error) {
      const b = resBox(res, false);
      b.firstElementChild!.textContent = 'Compile error';
      const pre = b.createEl('pre', { text: res.error });
      pre.style.cssText = 'font-family:var(--font-monospace);font-size:13px;white-space:pre-wrap;margin:6px 0 0';
      const h = b.createDiv({ text: 'Not counted as a run.' });
      h.style.cssText = 'font-size:13px;color:var(--text-muted)';
      box.appendChild(b);
      return;
    }
    if (res.ok) {
      const n = Math.min(res.trace.length, PASS_WIN);
      const b = resBox(res, true);
      b.firstElementChild!.textContent = 'PASS';
      b.createDiv({ text: `${res.cycles} cycles; every output matched.${entry && entry.practice ? ' Practice run.' : ''}` });
      b.appendChild(waveWrap(waveSvg(k.ports, vectors!, res.trace, 0, n, null)));
      const h = b.createDiv({ text: `Cycles 1 to ${n} of ${res.cycles}.` });
      h.style.cssText = 'font-size:13px;color:var(--text-muted)';
      box.appendChild(b);
      return;
    }
    const m = res.mismatch!, w = k.ports.find(p => p.name === m.signal)?.width ?? 1;
    const a = Math.max(0, m.cycle - 1 - 14), bb = Math.min(res.trace.length, m.cycle - 1 + 8);
    const b = resBox(res, false);
    b.firstElementChild!.textContent = 'FAIL';
    b.createDiv({ text: `First mismatch at cycle ${m.cycle} (vectors line ${m.line}), checked after the rising edge.` });
    const tb = b.createEl('table');
    tb.style.cssText = 'border-collapse:collapse;font-size:13px;margin:8px 0 0';
    const row = (cells: string[], head: boolean) => {
      const tr = tb.createEl('tr');
      cells.forEach(c => {
        const td = tr.createEl(head ? 'th' : 'td', { text: c });
        td.style.cssText = 'border:1px solid var(--background-modifier-border);padding:3px 8px;text-align:left' + (head ? '' : ';font-family:var(--font-monospace)');
      });
    };
    row(['cycle', 'signal', 'expected', 'got'], true);
    row([String(m.cycle), m.signal, fmtV(m.expected, w), fmtV(m.actual, w)], false);
    b.appendChild(waveWrap(waveSvg(k.ports, vectors!, res.trace, a, bb, m)));
    if (s.status === 'open') {
      const h = b.createDiv({ text: 'A pass now scores 0.75.' });
      h.style.cssText = 'font-size:13px;color:var(--text-muted)';
    }
    box.appendChild(b);
  }
  function renderHist(s: KataState) {
    const ol = q<HTMLOListElement>('.nb-study-kata-hist');
    if (!ol) return;
    ol.empty();
    ol.style.display = s.runs.length ? '' : 'none';
    for (const r of s.runs) {
      const what = r.ok ? 'pass' : r.err ? 'compile error (not counted)' : `fail at cycle ${r.cyc}${r.sig ? ` (${r.sig})` : ''}`;
      ol.createEl('li', { text: `${r.practice ? 'practice: ' : ''}${what} · ${fmtDur(r.at)}` });
    }
  }

  /* ---------------------------------------- 3. settled: verdict, then the tick steps ---------------------------------------- */

  function logKata(s: KataState) {
    if (s.logged) return;
    s.logged = true;
    save(s);
    void ctx.log({
      type: 'kata', kata: k.id,
      pass: s.status === 'passed', runs: s.runsAtSettle ?? counted(s), gaveUp: s.status === 'gaveup',
      ms: s.t0 && s.t1 ? s.t1 - s.t0 : 0, called: s.called.slice(), used: s.used.slice(), hidden: hidden(),
    }).catch(e => console.error('[study] kata log failed', e));
  }
  function verdictText(s: KataState): string {
    const n = s.runsAtSettle ?? counted(s);
    let t = s.status === 'passed' ? `Passed on run ${n}.` : `Gave up${n ? ` after ${n} run${n === 1 ? '' : 's'}` : ''}.`;
    if (s.status !== 'passed' && s.practicePass) t += ' Passed later, in practice.';
    return t;
  }
  function toggles(list: 'called' | 'used', sel: string[], locked: boolean): HTMLElement {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-list', list);
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:8px 0';
    for (const m of allMethods()) {
      const on = sel.indexOf(m.id) >= 0;
      const b = chip(wrap, m.id);
      b.setAttribute('data-m', m.id);
      b.setAttribute('aria-pressed', String(on));
      if (on) { b.style.fontWeight = '600'; b.style.background = 'var(--background-modifier-hover)'; }
      if (locked) b.disabled = true;
    }
    return wrap;
  }
  function renderSettle(s: KataState) {
    const secEl = q<HTMLElement>('.nb-study-kata-settle');
    if (!secEl) return;
    secEl.empty();
    if (!settled(s)) { secEl.style.display = 'none'; return; }
    secEl.style.display = '';
    /* A hidden kata's title and badge open up once it settles. */
    const tt = q<HTMLElement>('.nb-study-kata-title');
    if (tt && hidden()) tt.textContent = k.title || k.id;
    const bg = q<HTMLElement>('.nb-study-kata-badge');
    if (bg && hidden()) { bg.textContent = k.level; bg.removeAttribute('aria-label'); }
    kick(secEl, 'Settled');
    const v = secEl.createEl('p');
    v.style.fontVariantNumeric = 'tabular-nums';
    const vb = v.createEl('b', { text: verdictText(s) });
    vb.style.marginRight = '6px';
    v.appendText(`score ${scoreOf(s)}`);
    if (s.usedDone) renderTickResult(secEl, s);
    else if (!s.calledDone) {
      const st = secEl.createDiv();
      st.style.marginTop = '10px';
      const h = st.createDiv({ text: '1. What your call named' });
      h.style.cssText = 'font-weight:650;margin-bottom:2px';
      hint(st, TEXT.calledHint);
      st.appendChild(toggles('called', s.called, false));
      const row = st.createDiv();
      const b = chip(row, 'These are what my call named', 'primary');
      b.setAttribute('data-k', 'calldone');
      b.addEventListener('click', () => {
        const s2 = load();
        if (s2.calledDone) return;
        s2.calledDone = true;
        if (!s2.usedInit) { s2.usedInit = true; s2.used = needMethods(); }
        save(s2);
        renderSettle(s2);
        wireToggles();
        relayout();
      });
    } else {
      const st = secEl.createDiv();
      st.style.marginTop = '10px';
      const h = st.createDiv({ text: '1. What your call named' });
      h.style.cssText = 'font-weight:650;margin-bottom:2px';
      st.createEl('p', { text: s.called.length ? `${s.called.join(', ')}.` : 'None of the listed methods.' });
      const h2 = st.createDiv({ text: '2. What the kata took' });
      h2.style.cssText = 'font-weight:650;margin-bottom:2px';
      hint(st, TEXT.tookHint);
      st.appendChild(toggles('used', s.used, false));
      const row = st.createDiv();
      row.style.cssText = 'display:flex;gap:8px;align-items:center';
      const b = chip(row, 'Save', 'primary');
      b.setAttribute('data-k', 'useddone');
      const n = row.createSpan({ cls: 'nb-study-kata-usedn' });
      n.style.cssText = 'font-size:13px;color:var(--text-muted)';
      b.addEventListener('click', () => {
        const s2 = load();
        if (!s2.calledDone || s2.usedDone || (!s2.used.length && allMethods().length)) return;
        s2.usedDone = true;
        save(s2);
        logKata(s2);
        renderSettle(s2);
        wireToggles();
        relayout();
      });
      b.disabled = !s.used.length && allMethods().length > 0;
      n.textContent = s.used.length || !allMethods().length ? '' : 'Tick at least one.';
    }
    hint(secEl, TEXT.practice);
    wireToggles();
  }
  /* Tick toggles are wired once per render: a tap flips membership and restyles the button. */
  function wireToggles() {
    el.querySelectorAll<HTMLButtonElement>('.nb-study-kata-settle [data-list] button[data-m]').forEach(b => {
      if (b.dataset.wired) return;
      b.dataset.wired = '1';
      b.addEventListener('click', () => {
        const list = b.parentElement!.getAttribute('data-list') as 'called' | 'used';
        const id = b.getAttribute('data-m')!;
        const s = load();
        if (list === 'called' ? s.calledDone : s.usedDone) return;
        const arr = list === 'called' ? s.called : s.used;
        const i = arr.indexOf(id);
        if (i >= 0) arr.splice(i, 1); else arr.push(id);
        save(s);
        const on = arr.indexOf(id) >= 0;
        b.style.fontWeight = on ? '600' : '';
        b.style.background = on ? 'var(--background-modifier-hover)' : '';
        b.setAttribute('aria-pressed', String(on));
        const ub = q<HTMLButtonElement>('[data-k="useddone"]');
        const nn = q<HTMLElement>('.nb-study-kata-usedn');
        if (ub) { ub.disabled = !s.used.length && allMethods().length > 0; }
        if (nn) nn.textContent = s.used.length || !allMethods().length ? '' : 'Tick at least one.';
      });
    });
  }
  function renderTickResult(secEl: HTMLElement, s: KataState) {
    const st = secEl.createDiv();
    st.style.marginTop = '10px';
    const called = s.called || [], used = s.used || [];
    const hit = used.every(m => called.indexOf(m) >= 0);
    const p = st.createEl('p');
    if (hit) {
      const b = p.createEl('b', { text: 'Method: hit.' });
      b.style.color = 'var(--text-success)';
      p.appendText(` Your call named every method it took (${used.join(', ') || 'none'}).`);
    } else {
      const b = p.createEl('b', { text: 'Method: missed.' });
      b.style.color = 'var(--text-error)';
      const miss = used.filter(m => called.indexOf(m) < 0);
      p.appendText(` It took ${miss.join(', ')}, which your call did not name.${called.length ? ` Your call named ${called.join(', ')}.` : ''}`);
    }
    const extra = called.filter(m => used.indexOf(m) < 0);
    if (extra.length) hint(st, `Also named, not needed: ${extra.join(', ')}.`);
    try {
      const acc = ctx.engine().methodAccuracy(k.area || undefined);
      if (acc && acc.n) hint(st, `Method named right on hidden settles: about ${Math.round(acc.p * 100)}% over ${acc.n} samples.`);
    } catch (e) { /* engine lands with S2 */ }
    const ids = uniq(k.needs).filter(d => ctx.content().docs.has(d));
    if (ids.length) {
      const bad = s.status !== 'passed' || !hit;
      kick(st, bad ? 'Back to the basics it used' : 'The basics it used');
      const links = st.createDiv();
      links.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;margin:6px 0';
      for (const d of ids) {
        const sp = links.createSpan();
        const a = sp.createEl('a', { text: ctx.content().docs.get(d)!.title || d });
        a.addEventListener('click', ev => { ev.preventDefault(); env.open(d); });
        try {
          const stage = ctx.engine().basic(d).stage;
          const pill = sp.createSpan({ text: ` stage ${stage}` });
          pill.style.cssText = 'font-size:11px;color:var(--text-muted)';
        } catch (e) { /* engine lands with S2 */ }
      }
      hint(st, 'Tap to open one; hold to peek.');
    }
  }

  /* ---------------------------------------- the whole block ---------------------------------------- */

  function render() {
    if (dead) return;
    flush();
    destroyPad();
    stopTimer();
    const s = synced();
    renderHead(s);
    renderSpec();
    const work = el.createDiv({ cls: 'nb-study-kata-work' });
    const callS = sec(work); callS.classList.add('nb-study-kata-call');
    const codeS = sec(work); codeS.classList.add('nb-study-kata-code');
    const settleS = sec(work); settleS.classList.add('nb-study-kata-settle');
    renderCall(s);
    renderCode(s);
    renderSettle(s);
    startTimer();
    relayout();
  }

  render();
  return {
    destroy() {
      if (dead) return;
      flush();
      dead = true;
      destroyPad();
      stopTimer();
      if (saveT) { window.clearTimeout(saveT); saveT = 0; }
      offs.forEach(f => { try { f(); } catch (e) { /* noop */ } });
      offs.length = 0;
      el.remove();
    },
  };
};

/** Called by blocks/register.ts: fills the context's openKata with "open the kata's doc". */
export function registerUi(ctx: StudyContext): void {
  ctx.ui.openKata = async (id: string, opts?: { hidden?: boolean; reach?: boolean; why?: string }) => {
    const k = ctx.content().katas.get(id);
    if (!k) { ctx.ui.toast('That kata is not in the content.'); return; }
    if (opts?.why) ctx.ui.toast(opts.why);
    await ctx.ui.openDoc(id);
  };
}

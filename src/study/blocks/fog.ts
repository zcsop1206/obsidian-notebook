/**
 * The fog block (SPEC.md, Blocks: Fog): a proof callout, fogged by the push level of its doc's
 * basic, `ctx.engine().pushLevel(basic)`:
 *   0 steps   one step per reveal; each reveal needs 3 new strokes in the block's surface
 *   1 chunks  the steps in two bigger parts; the same gate
 *   2 cold    the proof is hidden; the blank-page drill (drill.ts runDrill) runs in place
 *   3 hook    the theorem is posed as a problem first (S7's mountHook, Decision 2)
 * Ink after a reveal draws in the after-reveal colour (`opts.meta` sets `e`). Done after 3 strokes
 * or one reveal grades by reveals (0 clean, all failed, else shaky) and logs one `fog` event. A
 * clean proof collapses the model's text behind "show the model's version" and shows "yours".
 * Owned by S6 on docs/study/BOARD.md. Reference: lab/study-reader/src/block-fog.js.
 * No step text is in the DOM until that step is revealed. Nothing here imports 'obsidian', so the
 * pure parts run under node:test (test/unit/study-fog.test.ts).
 */
import type { DrillGrade, Proof, StudyEvent } from '../types';
import type { BlockHandle, BlockMount, InkStroke, InkSurface } from '../view/host';
import {
  button, ensureStyles, fogBars, lastEvent, loadLocal, pushOf, runDrill, safe,
  saveLocal, twoTap, MIN_STROKES, type DrillApi,
} from './drill';
import { mountHook } from './problem';

/* ------------------------------------------------------------------------------------------ *
 * Pure parts (unit-tested in test/unit/study-fog.test.ts)
 * ------------------------------------------------------------------------------------------ */

export type FogMode = 'steps' | 'chunks' | 'cold' | 'hook';
export const MODES: FogMode[] = ['steps', 'chunks', 'cold', 'hook'];
const CHIP: Record<FogMode, string> = { steps: 'fog: steps', chunks: 'fog: chunks', cold: 'fog: cold', hook: 'fog: hook' };
const TIP: Record<FogMode, string> = {
  steps: 'Push level 0: the proof opens one step at a time; each reveal needs 3 new strokes of yours.',
  chunks: 'Push level 1: the proof opens in two bigger parts; each reveal needs 3 new strokes of yours.',
  cold: 'Push level 2: the proof is hidden; write it on a blank page, then Done shows all of it.',
  hook: 'Push level 3: the statement is a problem now; call the method and plan, then prove it.',
};

const H0 = 400;
const H_STEP = 264;
const H_MAX = 2000;

function range(a: number, b: number): number[] {
  const o: number[] = [];
  for (let i = a; i < b; i++) o.push(i);
  return o;
}

/**
 * The reveal units: one per step at level 0. FORMAT.md has no per-proof chunk list, so chunks are
 * the demo's fallback (two halves, in order). Cold and hook have no stepwise fog.
 */
export function unitsFor(nSteps: number, mode: FogMode): number[][] {
  const n = Math.max(0, Math.floor(nSteps));
  if (mode === 'chunks' && n > 1) {
    const h = Math.ceil(n / 2);
    return [range(0, h), range(h, n)];
  }
  return range(0, n).map(i => [i]);
}

/** The grade a finished attempt earns: no reveals clean, every unit revealed failed, else shaky. */
export function gradeFor(reveals: number, units: number): DrillGrade {
  if (units > 0 && reveals >= units) return 'failed';
  return reveals > 0 ? 'shaky' : 'clean';
}

/** Strokes written since the last reveal: each carries `e` = the reveal count at pen-down. */
export function freshStrokes(strokes: InkStroke[], reveals: number): number {
  let n = 0;
  for (const s of strokes) if ((s.e || 0) === reveals) n++;
  return n;
}

export interface FogGate {
  reveals: number;
  units: number;
  done: boolean;
  grade: DrillGrade | null;
  shown: boolean;
}

/** A reveal is allowed while the attempt is open, units remain and 3 new strokes are in. */
export function canReveal(st: FogGate, fresh: number): boolean {
  return !st.done && st.reveals < st.units && fresh >= MIN_STROKES;
}

/** Done counts once 3 strokes are written or at least one reveal was lifted. */
export function canFinish(st: FogGate, strokes: number): boolean {
  return !st.done && (strokes >= MIN_STROKES || st.reveals > 0);
}

/** After a shaky Done the remaining units can be shown without changing the grade. */
export function canShowRest(st: FogGate): boolean {
  return st.done && st.grade === 'shaky' && !st.shown && st.reveals < st.units;
}

export function fogEvent(doc: string, build: number, proof: string, reveals: number, units: number)
  : { type: 'fog'; doc: string; proof: string; build: number; reveals: number; steps: number; done: boolean; clean: boolean } {
  return { type: 'fog', doc, proof, build, reveals, steps: units, done: true, clean: gradeFor(reveals, units) === 'clean' };
}

/* ------------------------------------------------------------------------------------------ *
 * Per-proof session state: a device-local convenience (drill.ts's store); a finished attempt is
 * rebuilt from the `fog` events, and the strokes' `e` gives a lower bound on the reveals.
 * ------------------------------------------------------------------------------------------ */

interface FogState extends FogGate {
  v: 1;
  mode: FogMode;
  h: number;
  /** The attempt is under way: it no longer follows the push level. */
  started: boolean;
}

const blank = (mode: FogMode, units: number): FogState =>
  ({ v: 1, mode, reveals: 0, units, done: false, grade: null, shown: false, h: H0, started: false });

const idle = (st: FogState, strokes: number): boolean =>
  !st.done && !st.started && !strokes && !st.reveals;

const fkey = (doc: string, anchor: string) => `fog:${anchor}@${doc}`;

function loadFog(docId: string, anchor: string, nSteps: number): FogState | null {
  const s = loadLocal<FogState>(fkey(docId, anchor));
  if (!s || s.v !== 1 || MODES.indexOf(s.mode) < 0) return null;
  const units = unitsFor(nSteps, s.mode).length;
  const st = blank(s.mode, units);
  st.reveals = Math.max(0, Math.min(units, Math.floor(s.reveals || 0)));
  st.done = !!s.done;
  st.grade = s.grade && (s.grade === 'clean' || s.grade === 'shaky' || s.grade === 'failed') ? s.grade : null;
  if (st.done && !st.grade) st.done = false;
  st.shown = !!s.shown;
  st.started = !!s.started;
  st.h = Math.max(H0, Math.min(H_MAX, +s.h || H0));
  return st;
}

/** A finished attempt from the event log (this or another device's). */
function fogFromEvents(events: StudyEvent[], docId: string, anchor: string, nSteps: number, mode: FogMode): FogState | null {
  const ev = lastEvent(events, 'fog', e => e.doc === docId && e.proof === anchor && e.done);
  if (!ev) return null;
  const units = unitsFor(nSteps, mode).length;
  const st = blank(mode, units);
  st.done = true;
  st.started = true;
  st.reveals = Math.max(0, Math.min(units, Math.floor(ev.reveals || 0)));
  st.grade = ev.clean ? 'clean' : gradeFor(Math.max(1, st.reveals), units);
  return st;
}

/* ------------------------------------------------------------------------------------------ *
 * The block
 * ------------------------------------------------------------------------------------------ */

export const mount: BlockMount = (el, env): BlockHandle => {
  ensureStyles();
  const anchor = env.passage.block?.id || env.passage.anchor;
  const found = env.doc.proofs.find(p => p.anchor === anchor);
  if (!found || !found.steps.length) {
    el.createDiv({ cls: 'nb-sb nb-sb-hint', text: `Proof ${anchor} is not in this doc.` });
    return { destroy: () => el.empty() };
  }
  const proof: Proof = found;
  const doc = env.doc;
  const modeNow = () => MODES[pushOf(env)];
  const unitsOf = (m: FogMode) => unitsFor(proof.steps.length, m).length;
  let st: FogState | null = null;
  let surface: InkSurface | null = null;
  let drill: DrillApi | null = null;
  let hook: BlockHandle | null = null;
  let destroyed = false;

  const state = (): FogState => {
    if (st) return st;
    st = loadFog(doc.id, anchor, proof.steps.length)
      || fogFromEvents(env.ctx.events(), doc.id, anchor, proof.steps.length, modeNow());
    if (!st) st = blank(modeNow(), unitsOf(modeNow()));
    else if (idle(st, surface ? surface.count() : 0) && st.mode !== modeNow()) {
      st.mode = modeNow();
      st.units = unitsOf(st.mode);
    }
    return st;
  };
  const save = () => { if (!destroyed && st) saveLocal(fkey(doc.id, anchor), st); };
  const fresh = () => (surface ? freshStrokes(surface.strokes(), state().reveals) : 0);
  const strokeCount = () => (surface ? surface.count() : 0);

  /* ----- rendering ----- */
  function render(): void {
    teardown();
    const s = state();
    el.empty();
    el.classList.add('nb-sb', 'nb-sb-fog');
    const head = el.createDiv({ cls: 'nb-sb-row' });
    head.createSpan({ cls: 'nb-sb-kick', text: 'Proof' });
    const chip = head.createSpan({ cls: 'nb-sb-chip', text: CHIP[s.mode] });
    chip.setAttribute('title', TIP[s.mode]);
    const yours = head.createSpan({ cls: 'nb-sb-yours', text: 'yours' });
    yours.hidden = !(s.done && s.grade === 'clean');
    head.createSpan({ cls: 'nb-sb-sp' });
    head.createSpan({ cls: 'nb-sb-status', text: statusText(s) });

    if (s.mode === 'steps' || s.mode === 'chunks') renderInked(s);
    else if (s.mode === 'cold') renderCold(s);
    else renderHook(s);
    renderFoot(s);
    env.relayout();
  }

  function statusText(s: FogState): string {
    const inkedMode = s.mode === 'steps' || s.mode === 'chunks';
    if (s.done && s.grade) {
      let t = s.grade;
      if (inkedMode && s.grade === 'shaky') t += ` · ${s.reveals} of ${s.units} revealed`;
      return t;
    }
    if (inkedMode && (strokeCount() || s.reveals)) return 'open' + (s.reveals ? ` · ${s.reveals} of ${s.units} revealed` : '');
    return s.started ? 'open' : 'not started';
  }

  function renderInked(s: FogState): void {
    const word = s.mode === 'chunks' ? 'part' : 'step';
    const lab = el.createDiv({ cls: 'nb-sb-row nb-sb-hint' });
    lab.createSpan({ text: 'Your attempt: write the proof before you lift the fog.' });
    lab.createSpan({ cls: 'nb-sb-sp' });
    /* Legend swatches are inline styles, so no change to the shared stylesheet is needed. */
    const leg = lab.createSpan({ cls: 'nb-sb-legend' });
    leg.createEl('i').style.background = 'var(--text-normal)';
    leg.createSpan({ text: ' before any reveal ' });
    leg.createEl('i').style.background = 'var(--color-purple,#8a3ffc)';
    leg.createSpan({ text: ' after a reveal' });
    const inkBox = el.createDiv({ cls: 'nb-sb-paper nb-sb-fogink' });
    surface = env.ink.surface(doc, inkBox, `fog:${anchor}`, {
      height: () => state().h,
      color: st2 => ((st2.e || 0) > 0 ? '--color-purple' : '--text-normal'),
      meta: () => ({ e: state().reveals }),
      readOnly: () => destroyed || state().done,
    });
    const tools = el.createDiv({ cls: 'nb-sb-row' });
    const undoB = button(tools, 'Undo', 'undo');
    const moreB = button(tools, 'More paper', 'more');
    tools.createSpan({ cls: 'nb-sb-sp' });
    const revealB = button(tools, 'Write first', 'reveal', 'mod-cta');
    const doneB = button(tools, 'Done', 'done');
    const need = el.createDiv({ cls: 'nb-sb-hint' });
    need.setAttribute('aria-live', 'polite');
    const proofBox = el.createDiv({ cls: 'nb-sb-fogproof' });
    renderProof(s, proofBox);
    const res = el.createDiv({ cls: 'nb-sb-hint' });
    if (s.done && s.grade) {
      res.setText(s.grade === 'clean'
        ? 'Clean: no reveals. Your ink is the proof now; the model’s version waits behind the link.'
        : s.grade === 'shaky' ? `Shaky: ${s.reveals} of ${s.units} ${word}s revealed.`
        : `Failed: every ${word} was revealed.`);
    }

    const syncTools = (): void => {
      const n = strokeCount();
      const fr = fresh();
      undoB.disabled = s.done || !n;
      moreB.disabled = s.done || s.h >= H_MAX;
      doneB.hidden = s.done;
      doneB.disabled = !canFinish(s, n);
      let note = '';
      if (s.done) {
        if (canShowRest(s)) {
          revealB.hidden = false;
          revealB.disabled = false;
          revealB.textContent = 'Show the rest';
          note = 'Attempt closed. Showing the rest does not change the grade.';
        } else revealB.hidden = true;
      } else if (s.reveals >= s.units) {
        revealB.disabled = true;
        revealB.textContent = 'All revealed';
        note = `Every ${word} is revealed.`;
      } else if (fr < MIN_STROKES) {
        revealB.disabled = true;
        revealB.textContent = 'Write first';
        note = `${fr} of ${MIN_STROKES} new strokes for the next reveal.`;
      } else {
        revealB.disabled = false;
        revealB.textContent = `Reveal ${word} ${s.reveals + 1} of ${s.units}`;
        note = 'The next reveal is open.';
      }
      if (!s.done) note += canFinish(s, n) ? ` Done now counts ${gradeFor(s.reveals, s.units)}.` : ` Done needs ${MIN_STROKES} strokes of your own.`;
      need.textContent = note;
    };
    surface.onChange(() => {
      if (destroyed || !surface) return;
      /* `e` provenance: strokes written after a reveal raise the floor under `reveals`. */
      let maxE = s.reveals;
      for (const k of surface.strokes()) maxE = Math.max(maxE, k.e || 0);
      if (maxE > s.reveals) s.reveals = Math.min(s.units, maxE);
      if (surface.count()) s.started = true;
      save();
      syncTools();
      renderProof(s, proofBox);
    });
    undoB.onclick = () => { if (!s.done) surface?.undo(); syncTools(); };
    moreB.onclick = () => {
      if (s.done) return;
      s.h = Math.min(H_MAX, s.h + H_STEP);
      save();
      surface?.layout();
      env.relayout();
    };
    revealB.onclick = () => {
      if (s.done) {
        if (canShowRest(s)) { s.shown = true; save(); renderProof(s, proofBox); syncTools(); env.relayout(); }
        return;
      }
      if (!canReveal(s, fresh())) return;
      s.reveals++;
      s.started = true;
      save();
      renderProof(s, proofBox);
      syncTools();
      env.relayout();
    };
    doneB.onclick = () => {
      if (!canFinish(s, strokeCount())) return;
      s.done = true;
      s.started = true;
      s.grade = gradeFor(s.reveals, s.units);
      save();
      void env.ctx.log(fogEvent(doc.id, doc.build, anchor, s.reveals, s.units)).catch(e => {
        console.error('[study] fog: logging the result failed', e);
        env.toast('Could not log the fog result: ' + String(e));
      });
      surface?.setReadOnly(true);
      render();
    };
    syncTools();
  }

  function renderProof(s: FogState, box: HTMLElement): void {
    box.empty();
    const units = unitsFor(proof.steps.length, s.mode);
    const word = s.mode === 'chunks' ? 'Part' : 'Step';
    if (s.done && s.grade === 'clean') {
      const det = box.createEl('details', { cls: 'nb-sb-model' });
      det.createEl('summary', { text: 'show the model’s version' });
      const body = det.createDiv();
      units.forEach((u, i) => unitInto(body, u, i, units.length, word, false));
      det.addEventListener('toggle', () => env.relayout());
      return;
    }
    box.createDiv({ cls: 'nb-sb-kick', text: 'The model’s proof' });
    units.forEach((u, i) => {
      if (i < s.reveals) unitInto(box, u, i, units.length, word, false);
      else if (s.done && s.shown) unitInto(box, u, i, units.length, word, true);
      else {
        const d = box.createDiv({ cls: 'nb-sb-step nb-sb-fogged' });
        d.createDiv({ cls: 'nb-sb-stepk', text: `${word} ${i + 1} of ${units.length}, fogged` });
        fogBars(d, s.mode === 'chunks' ? Math.min(8, 2 + u.length) : 3, i + anchor.length);
      }
    });
  }

  function unitInto(box: HTMLElement, u: number[], i: number, n: number, word: string, late: boolean): void {
    const d = box.createDiv({ cls: 'nb-sb-step shown' + (late ? ' late' : '') });
    d.createDiv({ cls: 'nb-sb-stepk', text: `${word} ${i + 1} of ${n}${late ? ' · shown after Done' : ''}` });
    for (const k of u) {
      const step = proof.steps[k];
      if (!step) continue;
      const body = d.createDiv();
      void env.render(step.markdown, body).then(() => env.relayout());
    }
  }

  function renderCold(s: FogState): void {
    if (s.done) {
      el.createDiv({ cls: 'nb-sb-hint', text: `Graded ${s.grade} on the blank page.${basicLine()}` });
      const again = button(el.createDiv({ cls: 'nb-sb-row' }), 'Try again', 'again');
      twoTap(again, 'Tap again: a fresh page', () => restart());
      return;
    }
    el.createDiv({
      cls: 'nb-sb-hint',
      text: 'The proof is hidden at this push level. Write it cold on a blank page; Done shows all of it, then you grade it.',
    });
    drill = runDrill(el.createDiv(), env, {
      item: proof.anchor,
      key: `drill:${proof.anchor}`,
      src: 'drill',
      prompt: null,
      steps: proof.steps,
      kicker: 'Cold proof',
      onGrade: g => {
        s.done = true;
        s.started = true;
        s.grade = g;
        save();
        if (!destroyed) render();
      },
    });
  }

  function renderHook(s: FogState): void {
    if (!proof.of) {
      /* No theorem above to pose: the cold drill stands in. */
      renderCold(s);
      return;
    }
    hook = mountHook(el.createDiv(), env, proof.of);
    const note = el.createDiv({ cls: 'nb-sb-hint' });
    note.createSpan({ text: 'Push mode: problems in this area may hide their topic in Today. ' });
    const b = button(note, 'Open Today', 'today');
    b.onclick = () => void env.ctx.ui.openToday();
    if (s.done && s.grade) el.createDiv({ cls: 'nb-sb-hint', text: `Earlier attempt: ${s.grade}.` });
  }

  function renderFoot(s: FogState): void {
    if (s.mode !== 'steps' && s.mode !== 'chunks') return;
    if (!s.done) return;
    const foot = el.createDiv({ cls: 'nb-sb-row' });
    const again = button(foot, `Try again at ${CHIP[modeNow()]}`, 'again');
    twoTap(again, 'Tap again: this page is cleared', () => restart());
  }

  function basicLine(): string {
    const b = safe(() => env.ctx.engine().basic(doc.id), null);
    return b ? ` ${doc.title}: stage ${b.stage}${b.due ? `, next drill ${b.due}` : ''}.` : '';
  }

  function restart(): void {
    if (surface) surface.clear();
    st = blank(modeNow(), unitsOf(modeNow()));
    save();
    render();
  }

  function teardown(): void {
    if (surface) { try { surface.destroy(); } catch (e) { console.error(e); } surface = null; }
    if (drill) { try { drill.destroy(); } catch (e) { console.error(e); } drill = null; }
    if (hook) { try { hook.destroy(); } catch (e) { console.error(e); } hook = null; }
  }

  /* An idle block follows the push level; a started one keeps its mode. */
  const offChange = env.ctx.onChange(() => {
    if (destroyed || !st) return;
    const want = modeNow();
    if (idle(st, strokeCount()) && st.mode !== want) {
      st.mode = want;
      st.units = unitsOf(want);
      save();
      render();
    }
  });

  render();
  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      offChange();
      teardown();
      el.empty();
    },
  };
};

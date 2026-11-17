/**
 * The Today panel (SPEC.md, Today and Map; ticket S8): the date, the nearest deadline, today's
 * drills and picks, what was settled today, and pending rewrite/rebuild requests. Every row opens
 * its target in one tap. Data comes only from `ctx.engine()` and `ctx.content()` — the engine owns
 * the rules; the stub engine (before S2 lands) makes each section degrade to a "not built" note,
 * as the demo's no-engine build does.
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { StudyContext } from '../context';
import type { Pick, TodayPlan } from '../types';

export const VIEW_TYPE_STUDY_TODAY = 'notebook-study-today';

const DAY = 864e5;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const E_LO = 0.6;
const E_HI = 0.7;

function pad(n: number): string {
  return (n < 10 ? '0' : '') + n;
}
function dayNum(s: string): number {
  const a = s.split('-');
  return Math.round(Date.UTC(+a[0], +a[1] - 1, +a[2]) / DAY);
}
function nice(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const a = s.split('-');
  return `${MON[+a[1] - 1]} ${+a[2]}`;
}
function niceDow(s: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${DOW[new Date(dayNum(s) * DAY).getUTCDay()]} ${nice(s)}` : nice(s);
}
function f2(x: number | null): string {
  return x == null || !isFinite(x) ? '–' : (Math.round(x * 100) / 100).toFixed(2);
}
function f1(x: number | null): string {
  return x == null || !isFinite(x) ? '–' : (Math.round(x * 10) / 10).toFixed(1);
}

export class TodayView extends ItemView {
  private off: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private ctx: StudyContext) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_STUDY_TODAY;
  }
  getDisplayText(): string {
    return 'Today';
  }
  getIcon(): string {
    return 'calendar-days';
  }

  async onOpen(): Promise<void> {
    this.off = this.ctx.onChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.off?.();
    this.off = null;
    this.contentEl.empty();
  }

  private call<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      console.error('[study today]', e);
      return fallback;
    }
  }

  private title(id: string): string {
    return this.ctx.content().docs.get(id)?.title || id;
  }

  render(): void {
    const el = this.contentEl;
    el.empty();
    const root = el.createDiv({ cls: 'nb-sp nb-sp-today' });

    let plan: TodayPlan | null = null;
    let engineMissing = false;
    try {
      plan = this.ctx.engine().todayPlan(this.ctx.settings().minutes);
    } catch (e) {
      engineMissing = true;
    }
    if (!plan) {
      root.createDiv({ cls: 'nb-sp-date', text: 'Today' });
      root.createDiv({
        cls: 'nb-sp-empty',
        text: engineMissing
          ? 'The study engine is not built yet (ticket S2): the drills, problems and katas for the day all come from it.'
          : 'The plan for today could not be computed.',
      });
      this.requestsSec(root);
      return;
    }

    root.createDiv({ cls: 'nb-sp-date', text: niceDow(plan.date) });
    const next = plan.next;
    root.createDiv({
      cls: 'nb-sp-next',
      text: next
        ? `Nearest deadline: ${next.track} · ${nice(next.date)} · ${next.days} d left`
        : 'No deadline ahead.',
    });

    // Drills.
    const dsec = root.createEl('section', { cls: 'nb-sp-sec' });
    const dh = dsec.createEl('h3', { text: 'Drills' });
    dh.createSpan({ cls: 'nb-sp-count', text: plan.drills.length ? `${plan.drills.length} due` : 'none due' });
    if (!plan.drills.length) {
      dsec.createDiv({ cls: 'nb-sp-empty', text: 'Nothing due today.' });
    }
    for (const x of plan.drills) {
      const card = dsec.createEl('button', { cls: 'nb-sp-item' });
      const head = card.createDiv();
      head.createSpan({ cls: 'nb-sp-t', text: this.title(x.basic) });
      const meta = card.createDiv({ cls: 'nb-sp-m' });
      meta.createSpan({
        cls: `nb-sp-flag ${x.overdue > 0 ? 'bad' : 'warn'}`,
        text: x.overdue > 0 ? `${x.overdue} d overdue` : 'due today',
      });
      if (x.track) meta.createSpan({ cls: 'nb-sp-num', text: x.track });
      card.createSpan({ cls: 'nb-sp-why', text: `Drill item ${x.item}` });
      card.addEventListener('click', () => void this.ctx.ui.openDrill(x.basic, x.item));
    }

    // Problem and kata slots.
    const psec = root.createEl('section', { cls: 'nb-sp-sec' });
    const ph = psec.createEl('h3', { text: 'Problems and katas' });
    ph.createSpan({ cls: 'nb-sp-count', text: String(plan.picks.length) });
    psec.createDiv({ cls: 'nb-sp-sub', text: 'Picks aim at the stretch band (E 0.60–0.70); hidden picks show "?" until they settle.' });
    if (!plan.picks.length) {
      psec.createDiv({ cls: 'nb-sp-empty', text: 'No picks today.' });
    }
    for (const x of plan.picks) {
      this.pickCard(psec, x);
    }

    // Settled today.
    const ssec = root.createEl('section', { cls: 'nb-sp-sec' });
    ssec.createEl('h3', { text: 'Settled today' });
    ssec.createDiv({
      cls: 'nb-sp-empty',
      text: plan.settledToday ? `${plan.settledToday} settled so far.` : 'Nothing settled yet.',
    });

    this.requestsSec(root);
  }

  /** A pick card. A hidden pick shows "?" where the topic would be and nothing that names a method. */
  private pickCard(parent: HTMLElement, x: Pick): void {
    const card = parent.createEl('button', { cls: 'nb-sp-item' });
    const doc = this.ctx.content();
    const it = x.kind === 'kata' ? doc.katas.get(x.id) : doc.problems.get(x.id);
    const head = card.createDiv();
    head.createSpan({ cls: 'nb-sp-t', text: x.hidden ? '?' : it?.title || x.id });
    head.createSpan({ text: ' ' });
    if (x.hidden) head.createSpan({ cls: 'nb-sp-chip q', attr: { title: 'Topic hidden' }, text: '?' });
    else head.createSpan({ cls: 'nb-sp-chip', text: x.kind });
    if (x.reach) head.createSpan({ text: ' ' }), head.createSpan({ cls: 'nb-sp-flag after', text: 'reach' });
    const meta = card.createDiv({ cls: 'nb-sp-m' });
    if (x.E != null && isFinite(x.E)) {
      const g = meta.createSpan({ cls: 'nb-sp-gauge' });
      const m = Math.max(0, Math.min(1, x.E));
      const b = g.createSpan({ cls: 'b' });
      b.style.left = `${(E_LO * 100).toFixed(1)}%`;
      b.style.width = `${((E_HI - E_LO) * 100).toFixed(1)}%`;
      const mk = g.createSpan({ cls: 'm' });
      mk.style.left = `${(m * 100).toFixed(1)}%`;
    }
    meta.createSpan({ cls: 'nb-sp-num', text: `d ${f1(x.d)} · E ${f2(x.E)}` });
    if (x.hidden) meta.createSpan({ cls: 'nb-sp-flag after', text: 'hidden topic' });
    else if (x.reach) meta.createSpan({ cls: 'nb-sp-flag muted', text: 'reach' });
    else if (x.E != null && x.E >= E_LO - 1e-9 && x.E <= E_HI + 1e-9) meta.createSpan({ cls: 'nb-sp-flag good', text: 'in band' });
    if (x.why) card.createSpan({ cls: 'nb-sp-why', text: x.why });
    card.addEventListener('click', () => {
      const opts = { hidden: x.hidden, reach: x.reach, why: x.why };
      if (x.kind === 'kata') void this.ctx.ui.openKata(x.id, opts);
      else void this.ctx.ui.openProblem(x.id, opts);
    });
  }

  /** Pending rewrite and rebuild requests the laptop has not answered yet. */
  private requestsSec(root: HTMLElement): void {
    const rsec = root.createEl('section', { cls: 'nb-sp-sec' });
    const rh = rsec.createEl('h3', { text: 'Requests' });
    const reqs = this.call(() => this.ctx.engine().pendingRequests(), []);
    rh.createSpan({ cls: 'nb-sp-count', text: String(reqs.length) });
    if (!reqs.length) {
      rsec.createDiv({ cls: 'nb-sp-empty', text: 'No pending rewrite or rebuild requests.' });
      return;
    }
    for (const r of reqs) {
      const card = rsec.createEl('button', { cls: 'nb-sp-item' });
      const head = card.createDiv();
      head.createSpan({ cls: `nb-sp-flag ${r.kind === 'rebuild' ? 'bad' : 'after'}`, text: r.kind });
      head.createSpan({ text: ' ' });
      // A rebuild asked from another doc names the passage as `<doc>#<anchor>` (SPEC, S5 contract):
      // the card names both and opens the basic at the top, since the anchor is not in it.
      const hash = r.a.indexOf('#');
      const from = hash > 0 ? { doc: r.a.slice(0, hash), a: r.a.slice(hash + 1) } : null;
      head.createSpan({ cls: 'nb-sp-t', text: from ? `${this.title(r.doc)} (lost at ${this.title(from.doc)} #${from.a})` : `${this.title(r.doc)} #${r.a}` });
      card.createSpan({ cls: 'nb-sp-why', text: `asked ${r.t.slice(0, 10)} at build ${r.build} · /teach answers it` });
      card.addEventListener('click', () => void this.ctx.ui.openDoc(r.doc, from ? undefined : r.a));
    }
  }
}

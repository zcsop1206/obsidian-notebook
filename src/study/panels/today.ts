/**
 * The Today panel (SPEC.md, Today and Map; ticket S8): the date, the nearest deadline, today's
 * drills and picks, what was settled today, and pending rewrite/rebuild requests. Every row opens
 * its target in one tap. Data comes only from `ctx.engine()` and `ctx.content()` — the engine owns
 * the rules; the stub engine (before S2 lands) makes each section degrade to a "not built" note,
 * as the demo's no-engine build does.
 *
 * S42: when the day file `<root>/plan/<today>.md` exists (the laptop planner writes it), its rows
 * come first under "Plan" and the problem and kata picks fold under "More (n)". Without that file
 * the panel is exactly the S8 one. The file is read through `ctx.app`; a change to it (a sync, a
 * tick) reaches the panel through `ctx.onChange`, since the content loader rebuilds on any `.md`
 * under the root.
 */
import { ItemView, TFile, type WorkspaceLeaf } from 'obsidian';
import type { StudyContext } from '../context';
import type { Pick, TodayPlan } from '../types';
import { isPrivate, labelSegments, parseDayFile, toggleRow, type DayRow } from './plan-day';

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

/** Thrown inside `vault.process` when the row's line changed, so nothing is written. */
class PlanChanged extends Error {}

export class TodayView extends ItemView {
  private off: (() => void) | null = null;
  private live = false;
  /** Bumped by every render: an async day-file read fills its render only if no later one began. */
  private gen = 0;
  /** The last day file read, so a re-render shows its rows at once and refreshes after the read. */
  private cache: { path: string; text: string } | null = null;
  /** The "More (n)" fold's state, kept across re-renders while the panel is open. */
  private moreOpen = false;

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
    this.live = true;
    this.off = this.ctx.onChange(() => this.render());
    this.render();
  }

  async onClose(): Promise<void> {
    this.live = false;
    this.gen++;
    this.moreOpen = false;
    this.cache = null;
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

  /**
   * Rebuilds the panel. `.nb-sp` is the panel's scroller and a render replaces it, so the old
   * scroll position is carried over: a tick or a sync must not send Today back to the top.
   */
  render(): void {
    const gen = ++this.gen;
    const el = this.contentEl;
    const prev = el.querySelector<HTMLElement>(':scope > .nb-sp');
    const keep = { inner: prev?.scrollTop ?? 0, outer: el.scrollTop };
    el.empty();
    const root = el.createDiv({ cls: 'nb-sp nb-sp-today' });
    this.draw(root, gen);
    if (keep.outer) el.scrollTop = keep.outer;
    if (keep.inner) root.scrollTop = keep.inner;
  }

  private draw(root: HTMLElement, gen: number): void {
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

    // The day file, when there is one for the plan's date.
    const day = this.call(() => this.dayFile(plan!.date), null);
    if (day) this.planSec(root, day.path, day.file, gen);

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

    // Problem and kata slots; under a "More (n)" fold when the day file leads.
    let pparent: HTMLElement = root;
    if (day) {
      const fold = root.createEl('details', { cls: 'nb-sp-sec nb-sp-more' }) as HTMLDetailsElement;
      if (this.moreOpen) fold.open = true;
      fold.createEl('summary', { cls: 'nb-sp-more-sum', text: `More (${plan.picks.length})` });
      fold.addEventListener('toggle', () => {
        if (fold.isConnected) this.moreOpen = fold.open;
      });
      pparent = fold;
    }
    const psec = pparent.createEl('section', { cls: 'nb-sp-sec' });
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

  /** `<root>/plan/<date>.md` when that file exists, else null. */
  private dayFile(date: string): { path: string; file: TFile } | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const root = this.ctx.settings().root.replace(/^\/+|\/+$/g, '');
    const path = `${root ? root + '/' : ''}plan/${date}.md`;
    const file = this.ctx.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? { path, file } : null;
  }

  /**
   * The Plan section. It shows the cached rows at once when the file was read before (else a
   * "Plan" heading and a reading line), then reads the file and fills the section again if the
   * text differs, unless a later render has begun.
   */
  private planSec(root: HTMLElement, path: string, file: TFile, gen: number): void {
    const sec = root.createEl('section', { cls: 'nb-sp-sec nb-sp-plan' });
    let shown: string | null = null;
    if (this.cache && this.cache.path === path) {
      shown = this.cache.text;
      this.fillPlan(sec, path, shown);
    } else {
      // Not read yet: give the section its label and some height now, so what lies below does
      // not jump down when the read lands.
      sec.createEl('h3', { text: 'Plan' });
      sec.createDiv({ cls: 'nb-sp-empty nb-sp-planwait', text: 'Reading the day file…' });
    }
    this.ctx.app.vault.cachedRead(file).then(
      text => {
        if (gen !== this.gen) return;
        this.cache = { path, text };
        if (text !== shown) this.fillPlan(sec, path, text);
      },
      e => {
        if (gen !== this.gen) return;
        console.error('[study today] the day file', e);
        sec.empty();
        sec.createEl('h3', { text: 'Plan' });
        sec.createDiv({ cls: 'nb-sp-empty', text: 'The day file could not be read.' });
      },
    );
  }

  private fillPlan(sec: HTMLElement, path: string, text: string): void {
    sec.empty();
    const day = parseDayFile(text);
    let total = 0;
    let done = 0;
    for (const r of day.rows) {
      total += r.minutes ?? 0;
      if (r.ticked) done += r.minutes ?? 0;
    }
    const h = sec.createEl('h3', { text: 'Plan' });
    h.createSpan({
      cls: 'nb-sp-count',
      text: `${done} / ${total} min done` + (day.header ? ` · day ${day.header.minutes} min` : ''),
    });
    const sub = sec.createDiv({ cls: 'nb-sp-sub' });
    const open = sub.createEl('button', { cls: 'nb-sp-planfile', text: 'Open the day file' });
    open.addEventListener('click', () => void this.ctx.app.workspace.openLinkText(path, '', 'tab'));
    if (!day.rows.length) sec.createDiv({ cls: 'nb-sp-empty', text: 'The day file has no rows.' });
    for (const r of day.rows) this.planRow(sec, path, r);
  }

  /**
   * One day-file row: the checkbox and the row body are separate targets (a checkbox inside a
   * button is unreliable on the iPad). The body opens the first linked study doc, if any.
   */
  private planRow(sec: HTMLElement, path: string, r: DayRow): void {
    const docs = this.ctx.content().docs;
    const target = r.links.find(l => docs.has(l.id)) ?? null;
    const row = sec.createDiv({
      cls: `nb-sp-item nb-sp-row${r.ticked ? ' is-done' : ''}`,
      attr: { 'data-line': String(r.line) },
    });
    const tick = row.createEl('label', { cls: 'nb-sp-tick' });
    const box = tick.createEl('input', { attr: { type: 'checkbox', 'aria-label': r.ticked ? 'Mark not done' : 'Mark done' } }) as HTMLInputElement;
    box.checked = r.ticked;
    box.addEventListener('change', () => void this.tick(path, r, box));
    const body = target ? row.createEl('button', { cls: 'nb-sp-rowbody' }) : row.createDiv({ cls: 'nb-sp-rowbody' });
    const lab = body.createDiv({ cls: 'nb-sp-rowlabel' });
    const priv = isPrivate(r);
    if (priv) {
      lab.createSpan({ cls: 'nb-sp-private', text: 'private' });
    } else {
      for (const s of labelSegments(r.label)) {
        const into = s.bold ? lab.createEl('strong') : lab;
        // A link to a study doc is coloured as one; any other link reads as plain text.
        if (s.link && docs.has(s.link.id)) into.createSpan({ cls: 'nb-sp-link', text: s.link.alias ?? this.title(s.link.id) });
        else into.createSpan({ text: s.text });
      }
    }
    const meta = body.createDiv({ cls: 'nb-sp-m' });
    if (r.minutes != null) meta.createSpan({ cls: 'nb-sp-num', text: `${r.minutes} min` });
    if (r.deliverable && !priv) meta.createSpan({ cls: 'nb-sp-chip', text: r.deliverable });
    if (target) body.addEventListener('click', () => void this.ctx.ui.openDoc(target.id));
  }

  /** Ticks or unticks one row in the file, only if its line still reads as it did when shown. */
  private async tick(path: string, r: DayRow, box: HTMLInputElement): Promise<void> {
    box.disabled = true;
    const vault = this.ctx.app.vault;
    const file = vault.getAbstractFileByPath(path);
    let changed = !(file instanceof TFile);
    if (file instanceof TFile) {
      try {
        const text = await vault.process(file, data => {
          const next = toggleRow(data, r.line, r.raw);
          if (next == null) throw new PlanChanged();
          return next;
        });
        this.cache = { path, text };
      } catch (e) {
        if (e instanceof PlanChanged) changed = true;
        else {
          console.error('[study today] tick', e);
          this.ctx.ui.toast('The tick could not be saved to the day file.');
        }
      }
    }
    if (changed) this.ctx.ui.toast('The plan changed since Today showed it. Nothing was saved; try again.');
    if (this.live) this.render();
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

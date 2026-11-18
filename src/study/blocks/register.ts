/**
 * Registers what the study blocks need outside a doc: the standalone problem view
 * `notebook-study-problem` behind `ctx.ui.openProblem` (Today and Map open a problem there, invented
 * or bank, without showing the doc it lives in), the blocks' CSS, and the pass that copies old
 * standalone problem ink into the problems' home docs once the content loads (S12). The blocks
 * inside a doc are mounted by the study view through blocks/index.ts. Owned by S6 (fog and
 * drill), S7 (problem) and S9 (kata) on docs/study/BOARD.md. S9's registerUi fills `ctx.ui.openKata`.
 */
import { Component, ItemView, MarkdownRenderer, type WorkspaceLeaf } from 'obsidian';
import type { StudyContext } from '../context';
import type { Passage, StudyDoc } from '../types';
import type { BlockEnv } from '../view/host';
import type { InkAdapter } from '../ink/store';
import { adoptInk, createInkApi } from '../ink';
import { ensureStyles, removeStyles } from './drill';
import {
  copyOldProblemInk, homeDoc, migrateOldProblemInk, movedInk, problemsDoc, serialQueue, PROBLEMS_DOC,
  type MovedInk, type OldInkIO, type OldInkPass, type Serial,
} from './home';
import { PROBLEM_VIEW, mountSession, openProblem, problemItem, type SessionHandle } from './problem';
import { registerUi as registerKataUi } from './kata';

export { PROBLEMS_DOC, problemsDoc };

/**
 * The copies of old standalone problem ink (home.ts), per StudyContext: the queue they all run
 * through, this device's record of the ids copied (one object per device, so the load-time pass
 * and an open see each other's), and the load-time pass.
 */
interface OldInk {
  serial: Serial;
  moved: Map<string, MovedInk>;
  /** The pass running now; it runs once more before it resolves when `again` is set and strokes are pending. */
  pass: Promise<OldInkPass> | null;
  again: boolean;
  last: OldInkPass | null;
}

const oldInks = new WeakMap<StudyContext, OldInk>();

function oldInkOf(ctx: StudyContext): OldInk {
  let o = oldInks.get(ctx);
  if (!o) { o = { serial: serialQueue(), moved: new Map(), pass: null, again: false, last: null }; oldInks.set(ctx, o); }
  return o;
}

/** What a copy needs, for the context's settings now. */
function oldInkIO(ctx: StudyContext): OldInkIO {
  const o = oldInkOf(ctx);
  const s = ctx.settings();
  let moved = o.moved.get(s.device);
  if (!moved) { moved = movedInk(ctx.app, s.device); o.moved.set(s.device, moved); }
  return {
    adapter: ctx.app.vault.adapter as unknown as InkAdapter, root: s.root, device: s.device,
    adopt: (docId, strokes) => adoptInk(ctx, docId, strokes),
    moved, serial: o.serial,
  };
}

/** Starts the load-time pass, or has the running one run once more. */
function runOldInkPass(ctx: StudyContext): void {
  const o = oldInkOf(ctx);
  if (o.pass) { o.again = true; return; }
  o.pass = (async () => {
    let r: OldInkPass = { copied: 0, pending: 0 };
    try {
      do {
        o.again = false;
        r = await migrateOldProblemInk(oldInkIO(ctx), () => ctx.content(), ctx.settings().root);
        o.last = r;
      } while (o.again && r.pending > 0);
    } finally {
      o.pass = null;
    }
    return r;
  })();
}

/**
 * Old ink reaches its doc without a Today open (S12 review): the load-time pass (home.ts
 * migrateOldProblemInk) starts once the content index has docs, when the layout is ready (the
 * vault has loaded) or on the first content change; and again on a later content change while
 * the last pass left strokes pending (a problem or its doc missing, a write that did not land).
 * Never two at once: a change during a pass runs one more after it while strokes are pending.
 * Returns the unsubscribe.
 */
function watchOldInk(ctx: StudyContext): () => void {
  const o = oldInkOf(ctx);
  const kick = () => {
    try {
      if (o.pass) o.again = true;
      else if (o.last ? o.last.pending > 0 : ctx.content().docs.size > 0) runOldInkPass(ctx);
    } catch (e) { console.error('[study] old problem ink: the pass did not start', e); }
  };
  const off = ctx.onChange(what => { if (what === 'content') kick(); });
  const ws = ctx.app.workspace as unknown as { onLayoutReady?: (cb: () => void) => void } | undefined;
  if (ws && typeof ws.onLayoutReady === 'function') ws.onLayoutReady(kick);
  else kick();
  return off;
}

/** The load-time pass now running (with any run it still owes), else the last one's result; null before the first. Tests await it. */
export function oldInkPass(ctx: StudyContext): Promise<OldInkPass | null> {
  const o = oldInks.get(ctx);
  return o && o.pass ? o.pass : Promise.resolve(o ? o.last : null);
}

function problemPassage(id: string): Passage {
  return { anchor: id, explicit: true, kind: 'callout', start: 0, end: 0, source: '', markdown: '', hash: '', block: { type: 'problem', id } };
}

interface ProblemState {
  id: string;
  hidden: boolean;
  reach: boolean;
  why: string;
}

/** Renders markdown with Obsidian's renderer from the home doc's path (figures and links resolve as in the doc); as plain text where there is none (the test harness's mock). */
async function renderMarkdown(ctx: StudyContext, owner: Component, doc: StudyDoc, markdown: string, into: HTMLElement): Promise<void> {
  const R = MarkdownRenderer as unknown as { render?: typeof MarkdownRenderer.render } | undefined;
  if (R && typeof R.render === 'function') {
    await R.render(ctx.app, markdown, into, doc.path, owner);
    return;
  }
  into.createDiv({ cls: 'nb-sb-md', text: markdown });
}

export class ProblemView extends ItemView {
  private st: ProblemState = { id: '', hidden: false, reach: false, why: '' };
  private sess: SessionHandle | null = null;
  private mounted = false;
  private mountSeq = 0;
  private offContent: (() => void) | null = null;
  private renderOwner: Component | null = null;
  private ctx: StudyContext;

  constructor(leaf: WorkspaceLeaf, ctx: StudyContext) {
    super(leaf);
    this.ctx = ctx;
  }

  getViewType(): string { return PROBLEM_VIEW; }
  getIcon(): string { return 'target'; }

  /** Never names a hidden pick: the tab says "Problem ?". */
  getDisplayText(): string {
    if (!this.st.id) return 'Problem';
    if (this.st.hidden) return 'Problem ?';
    const it = problemItem(this.ctx.content(), this.st.id);
    return it ? `Problem · ${it.title}` : 'Problem';
  }

  getState(): Record<string, unknown> {
    return { ...this.st };
  }

  async setState(state: unknown, result: Parameters<ItemView['setState']>[1]): Promise<void> {
    const s = (state || {}) as Partial<Record<keyof ProblemState, unknown>>;
    const next: ProblemState = {
      id: typeof s.id === 'string' ? s.id : '',
      hidden: s.hidden === true,
      reach: s.reach === true,
      why: typeof s.why === 'string' ? s.why : '',
    };
    const same = next.id === this.st.id && next.hidden === this.st.hidden && next.reach === this.st.reach && next.why === this.st.why;
    this.st = next;
    if (!same || !this.mounted) this.mountNow();
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    ensureStyles();
    this.contentEl.addClass('nb-study-problem-view');
  }

  async onClose(): Promise<void> {
    this.unmount();
  }

  /** The current session (tests). */
  session(): SessionHandle | null {
    return this.sess;
  }

  private unmount(): void {
    this.offContent?.();
    this.offContent = null;
    this.sess?.destroy();
    this.sess = null;
    this.renderOwner?.unload();
    this.renderOwner = null;
    this.mounted = false;
    this.contentEl.empty();
  }

  private mountNow(): void {
    this.unmount();
    this.mounted = true;
    const seq = ++this.mountSeq;
    const id = this.st.id;
    if (!id) {
      this.contentEl.createDiv({ cls: 'nb-sb nb-sb-hint', text: 'No problem chosen.' });
      return;
    }
    const ctx = this.ctx;
    const owner = new Component();
    owner.load();
    this.renderOwner = owner;
    const env: BlockEnv = {
      ctx,
      doc: problemsDoc(ctx.settings().root),
      passage: problemPassage(id),
      ink: createInkApi(ctx),
      open: (docId, anchor) => { void ctx.ui.openDoc(docId, anchor); },
      peek: (docId, anchor) => { void ctx.ui.openDoc(docId, anchor || undefined); },
      relayout: () => { /* the view scrolls; nothing to re-place */ },
      toast: (m, ms) => ctx.ui.toast(m, ms),
      render: (md, into) => renderMarkdown(ctx, owner, env.doc, md, into),
    };
    const host = this.contentEl.createDiv({ cls: 'nb-study-problem-host' });
    host.style.maxWidth = '820px';
    host.style.margin = '0 auto';
    host.style.padding = '8px 16px 40px';
    const o = { hidden: this.st.hidden, reach: this.st.reach, why: this.st.why };
    const tryMount = async (): Promise<boolean> => {
      // Looked up in the whole index, never through a doc, so a hidden pick shows nothing of its doc.
      const item = problemItem(ctx.content(), id);
      if (!item) return false;
      // The home doc (S12) is only the render path and the ink file: its title, id and path never
      // reach the DOM here, so a hidden pick still shows nothing of it before the settle. Old
      // strokes are copied first, through the home doc's shared store, so its surfaces show them.
      env.doc = homeDoc(ctx.content(), id, ctx.settings().root);
      await copyOldProblemInk(oldInkIO(ctx), env.doc.id, id);
      if (seq !== this.mountSeq || !this.mounted || this.sess) return true;
      host.empty();
      this.sess = mountSession(host, env, item, o);
      return true;
    };
    const missing = () => {
      if (seq !== this.mountSeq || this.sess) return;
      host.createDiv({ cls: 'nb-sb nb-sb-hint', text: `Problem ${id} is not in the study folder.` });
      this.offContent = ctx.onChange(w => {
        if (w === 'content' && !this.sess) {
          void tryMount().then(ok => {
            if (ok && this.offContent) { this.offContent(); this.offContent = null; }
          });
        }
      });
    };
    void tryMount().then(ok => { if (!ok) missing(); });
  }
}

export function register(ctx: StudyContext): void {
  ctx.plugin.registerView(PROBLEM_VIEW, leaf => new ProblemView(leaf, ctx));
  ctx.ui.openProblem = (id, opts) => openProblem(ctx, id, opts);
  ctx.plugin.register(() => removeStyles());
  registerKataUi(ctx);
  ctx.plugin.register(watchOldInk(ctx));
}

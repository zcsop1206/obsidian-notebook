/**
 * The Changes panel for a doc (SPEC.md, The study view): the doc's build, the rewrite budget,
 * pending rewrite/rebuild requests, the doc's open marks, and its `## Changes` section. Owned by
 * S5 on docs/study/BOARD.md. A `Modal`, the plugin's stand-in for the demo's side sheet.
 */
import { Component, MarkdownRenderer, Modal } from 'obsidian';
import type { StudyContext } from '../context';
import type { Passage, StudyDoc } from '../types';

const STYLE_ID = 'nb-st-changes-css';
const CSS = `
.nb-st-changes .nb-st-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; }
.nb-st-changes .nb-st-kv dt { color: var(--text-muted, #777); margin: 0; }
.nb-st-changes .nb-st-kv dd { margin: 0; }
.nb-st-changes h4 { margin: 14px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted, #777); }
.nb-st-changes .nb-st-req, .nb-st-changes .nb-st-mark { display: flex; gap: 8px; align-items: baseline;
  padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.nb-st-changes .nb-st-req:hover, .nb-st-changes .nb-st-mark:hover { background: var(--background-secondary, #eee); }
.nb-st-changes .nb-st-kind { font-size: 11px; border-radius: 8px; padding: 1px 7px; background: var(--interactive-accent, #705dcf); color: #fff; white-space: nowrap; }
.nb-st-changes .nb-st-kind.rebuild { background: var(--text-error, #c33); }
.nb-st-changes .nb-st-verb { font-size: 11px; border-radius: 8px; padding: 1px 7px; color: #fff; white-space: nowrap; }
.nb-st-changes .nb-st-verb.lost { background: var(--text-error, #c33); }
.nb-st-changes .nb-st-verb.easy { background: #2e7d32; }
.nb-st-changes .nb-st-verb.forgot { background: #c25e00; }
.nb-st-changes .nb-st-anchor { font-family: var(--font-monospace, monospace); font-size: 12px; }
.nb-st-changes .nb-st-when { margin-left: auto; color: var(--text-muted, #777); font-size: 11px; white-space: nowrap; }
.nb-st-changes .nb-st-empty { color: var(--text-muted, #777); font-size: 13px; }
.nb-st-changes .nb-st-section { font-size: 13px; }
`;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The passages of the doc's `## Changes` section (the heading excluded), or []. */
export function changesSection(doc: StudyDoc): Passage[] {
  const idx = doc.passages.findIndex(p => p.kind === 'heading' && p.level === 2 && /^\s*changes\s*$/i.test(p.text || ''));
  if (idx < 0) return [];
  const out: Passage[] = [];
  for (let i = idx + 1; i < doc.passages.length; i++) {
    const p = doc.passages[i];
    if (p.kind === 'heading' && (p.level ?? 6) <= 2) break;
    out.push(p);
  }
  return out;
}

class ChangesModal extends Modal {
  /** Renders the `## Changes` passages (Modal is not a Component in the Obsidian API). */
  private renderCmp = new Component();

  constructor(private ctx: StudyContext, private doc: StudyDoc) {
    super(ctx.app);
  }

  onOpen(): void {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      document.head.appendChild(st);
      // Removed when the plugin unloads (the modal itself may open many times).
      const plugin = this.ctx.plugin as { register?: (fn: () => void) => void } | undefined;
      if (plugin && typeof plugin.register === 'function') plugin.register(() => st.remove());
    }
    const { contentEl, titleEl } = this;
    this.renderCmp.load();
    const ctx = this.ctx;
    const doc = this.doc;
    contentEl.addClass('nb-st-changes');
    titleEl.setText(`Changes · ${doc.title || doc.id}`);

    const call = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (e) {
        console.error('[study changes]', e);
        return fallback;
      }
    };

    // Build and budget.
    const kv = contentEl.createEl('dl', { cls: 'nb-st-kv' });
    kv.createEl('dt', { text: 'Build' });
    kv.createEl('dd', { text: `${doc.build}${doc.tracks.length ? ` · ${doc.tracks.join(', ')}` : ''}` });
    const b = call(() => ctx.engine().budget(doc.id), { left: 3, used: 0 });
    kv.createEl('dt', { text: 'Rewrite budget' });
    kv.createEl('dd', { text: `${b.used} of ${b.used + b.left} used this build (${b.left} left); resets when a rebuild lands` });

    // Pending requests on this doc.
    contentEl.createEl('h4', { text: 'Pending requests' });
    // This doc's own requests, and rebuilds of a basic asked from here (`a` = `<this doc>#<anchor>`).
    const reqs = call(() => ctx.engine().pendingRequests(), []).filter(r => r.doc === doc.id || r.a.startsWith(`${doc.id}#`));
    if (!reqs.length) {
      contentEl.createDiv({ cls: 'nb-st-empty', text: 'None. Rewrite and rebuild requests the laptop has not answered yet appear here.' });
    }
    for (const r of reqs) {
      const row = contentEl.createDiv({ cls: 'nb-st-req' });
      row.createSpan({ cls: `nb-st-kind ${r.kind}`, text: r.kind });
      const hash = r.a.indexOf('#');
      const from = hash > 0 ? { doc: r.a.slice(0, hash), a: r.a.slice(hash + 1) } : null;
      const title = (id: string) => ctx.content().docs.get(id)?.title || id;
      // A cross-doc rebuild: on the marked doc it names the basic; on the basic, where it was lost.
      const label = !from ? `#${r.a}` : r.doc === doc.id ? `lost at ${title(from.doc)} #${from.a}` : `#${from.a} → ${title(r.doc)}`;
      row.createSpan({ cls: 'nb-st-anchor', text: label });
      row.createSpan({ cls: 'nb-st-when', text: `${fmtTime(r.t)} · asked at build ${r.build}` });
      row.addEventListener('click', () => {
        this.close();
        if (!from) void ctx.ui.openDoc(r.doc, r.a);
        else if (r.doc === doc.id) void ctx.ui.openDoc(from.doc, from.a);
        else void ctx.ui.openDoc(doc.id, from.a);
      });
    }

    // Open marks on this doc.
    contentEl.createEl('h4', { text: 'Marks' });
    const marks = call(() => ctx.engine().marks(doc.id), []);
    if (!marks.length) {
      contentEl.createDiv({ cls: 'nb-st-empty', text: 'No open marks.' });
    }
    for (const m of marks) {
      const row = contentEl.createDiv({ cls: 'nb-st-mark' });
      row.createSpan({ cls: `nb-st-verb ${m.verb}`, text: m.verb });
      row.createSpan({ cls: 'nb-st-anchor', text: `#${m.a}` });
      row.createSpan({ cls: 'nb-st-when', text: `${fmtTime(m.t)} · build ${m.build}` });
      row.addEventListener('click', () => {
        this.close();
        void ctx.ui.openDoc(m.doc, m.a);
      });
    }

    // The doc's `## Changes` section, if it has one.
    const section = changesSection(doc);
    contentEl.createEl('h4', { text: 'Changes section' });
    if (!section.length) {
      contentEl.createDiv({ cls: 'nb-st-empty', text: 'No `## Changes` section in this build. The laptop adds one when it answers a request.' });
      return;
    }
    const box = contentEl.createDiv({ cls: 'nb-st-section' });
    for (const p of section) {
      const el = box.createDiv();
      if (typeof MarkdownRenderer !== 'undefined' && MarkdownRenderer) {
        void MarkdownRenderer.render(ctx.app, p.markdown, el, doc.path, this.renderCmp)
          .catch(e => console.error('[study changes] render', e));
      } else {
        // The test harness has no MarkdownRenderer until S3 lands it: show the text.
        el.textContent = p.markdown;
      }
    }
  }

  onClose(): void {
    this.renderCmp.unload();
    this.contentEl.empty();
  }
}

/** Opens the Changes panel for `docId` (the study view header's Changes button). */
export async function openChanges(ctx: StudyContext, docId: string): Promise<void> {
  const doc = ctx.content().docs.get(docId);
  if (!doc) {
    ctx.ui.toast(`No study doc "${docId}".`);
    return;
  }
  new ChangesModal(ctx, doc).open();
}

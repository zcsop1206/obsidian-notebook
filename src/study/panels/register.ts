/**
 * Registers the Today and Map panels (SPEC.md, Today and Map). Owned by S8 on docs/study/BOARD.md.
 * Each is an ItemView opened in a tab, like the repo's other views; commands and a ribbon icon open
 * them, and the shared `ctx.ui.openToday` / `ctx.ui.openMap` hooks are filled in here.
 */
import type { WorkspaceLeaf } from 'obsidian';
import type { StudyContext } from '../context';
import { TodayView, VIEW_TYPE_STUDY_TODAY } from './today';
import { MapView, MAP_CSS, VIEW_TYPE_STUDY_MAP } from './map';

/** Panel CSS, injected here because styles.css's study section is S3's file. */
const STYLE_ID = 'nb-st-panels-css';
export const PANEL_CSS = `
.nb-sp { padding: 12px 14px; font-size: 14px; line-height: 1.45; overflow-y: auto; height: 100%; }
.nb-sp h3 { margin: 16px 0 4px; font-size: 14px; }
.nb-sp h3 .nb-sp-count { float: right; font-weight: 400; color: var(--text-muted, #777); font-size: 12px; }
.nb-sp .nb-sp-sub { color: var(--text-muted, #777); font-size: 12px; margin: 0 0 8px; }
.nb-sp .nb-sp-date { font-size: 20px; font-weight: 600; margin: 4px 0 2px; }
.nb-sp .nb-sp-next { font-size: 13px; color: var(--text-muted, #777); margin-bottom: 8px; }
.nb-sp-item { display: block; width: 100%; box-sizing: border-box; text-align: left; border: 1px solid var(--background-modifier-border, #ddd);
  border-radius: 8px; background: var(--background-primary, #fff); padding: 8px 10px; margin: 6px 0;
  cursor: pointer; color: var(--text-normal, #222); font-size: 13px; }
.nb-sp-item:hover { border-color: var(--interactive-accent, #705dcf); }
.nb-sp-item .nb-sp-t { font-weight: 600; }
.nb-sp-item .nb-sp-m { display: flex; gap: 8px; align-items: center; margin-top: 3px; font-size: 12px; flex-wrap: wrap; }
.nb-sp-item .nb-sp-why { display: block; margin-top: 3px; color: var(--text-muted, #777); font-size: 12px; }
.nb-sp-flag { font-size: 11px; border-radius: 8px; padding: 1px 7px; white-space: nowrap; }
.nb-sp-flag.bad { background: var(--text-error, #c33); color: #fff; }
.nb-sp-flag.warn { background: #b8860b; color: #fff; }
.nb-sp-flag.good { background: #2e7d32; color: #fff; }
.nb-sp-flag.muted { background: var(--background-secondary, #eee); color: var(--text-muted, #777); }
.nb-sp-flag.after { background: var(--interactive-accent, #705dcf); color: #fff; }
.nb-sp-chip { display: inline-block; min-width: 16px; text-align: center; font-size: 11px; border-radius: 8px;
  padding: 1px 6px; background: var(--background-secondary, #eee); color: var(--text-muted, #777); }
.nb-sp-chip.q { background: var(--interactive-accent, #705dcf); color: #fff; font-weight: 700; }
.nb-sp-num { font-family: var(--font-monospace, monospace); font-size: 12px; }
.nb-sp-empty { color: var(--text-muted, #777); font-size: 13px; padding: 6px 0; }
.nb-sp-gauge { position: relative; display: inline-block; width: 64px; height: 8px; border-radius: 4px;
  background: var(--background-secondary, #eee); vertical-align: middle; }
.nb-sp-gauge .b { position: absolute; top: 0; bottom: 0; background: rgba(46,125,50,0.25); border-radius: 4px; }
.nb-sp-gauge .m { position: absolute; top: -2px; width: 3px; height: 12px; margin-left: -1.5px;
  background: var(--text-normal, #222); border-radius: 2px; }
.nb-sp-sec { border-top: 1px solid var(--background-modifier-border, #e0e0e0); padding-top: 4px; }
`;

export function register(ctx: StudyContext): void {
  const { plugin } = ctx;
  plugin.registerView(VIEW_TYPE_STUDY_TODAY, (leaf: WorkspaceLeaf) => new TodayView(leaf, ctx));
  plugin.registerView(VIEW_TYPE_STUDY_MAP, (leaf: WorkspaceLeaf) => new MapView(leaf, ctx));

  const openPanel = async (type: string): Promise<void> => {
    const ws = ctx.app.workspace;
    let leaf = ws.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type, active: true });
    }
    ws.revealLeaf(leaf);
  };
  ctx.ui.openToday = () => openPanel(VIEW_TYPE_STUDY_TODAY);
  ctx.ui.openMap = () => openPanel(VIEW_TYPE_STUDY_MAP);

  plugin.addCommand({ id: 'open-study-today', name: 'Open Today', callback: () => void ctx.ui.openToday() });
  plugin.addCommand({ id: 'open-study-map', name: 'Open study map', callback: () => void ctx.ui.openMap() });
  plugin.addRibbonIcon('calendar-days', 'Open Today', () => void ctx.ui.openToday());

  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = PANEL_CSS + MAP_CSS;
    document.head.appendChild(st);
  }
  plugin.register(() => document.getElementById(STYLE_ID)?.remove());
}

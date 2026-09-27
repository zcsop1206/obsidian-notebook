// Opens markdown files with `ink:` frontmatter in the ink view. Obsidian opens every file by
// calling WorkspaceLeaf.setViewState with the view type registered for its extension
// (`markdown`), from the file explorer, links, quick switcher and restored layouts alike, so
// patching that one method catches them all before a markdown view is ever built (the Kanban
// plugin does the same with monkey-around; this is the hand-written equivalent). The patch is
// removed on unload, or becomes a pass-through if another plugin patched on top of it.
//
// "Open as markdown" passes `openAsMarkdown: true` in the view state; the leaf then stays
// markdown for that file (even when Obsidian sets its state again without the flag) until it
// shows another file or another view.
import { TFile, WorkspaceLeaf, type App, type ViewState } from 'obsidian';
import { isInkNote } from '../format/note';

export const VIEW_TYPE_INK = 'notebook-ink';

/** Whether the metadata cache says a file is an ink note; null if it hasn't read the file yet. */
export function cachedIsInk(app: App, file: TFile): boolean | null {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return null;
  const fm = cache.frontmatter;
  return !!fm && Object.prototype.hasOwnProperty.call(fm, 'ink');
}

/** Whether a markdown file is an ink note, reading it if the metadata cache hasn't yet. */
export async function isInkFile(app: App, file: TFile): Promise<boolean> {
  if (file.extension !== 'md') return false;
  const cached = cachedIsInk(app, file);
  if (cached !== null) return cached;
  try {
    return isInkNote(await app.vault.cachedRead(file));
  } catch (e) {
    return false;
  }
}

type SetViewState = (this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>;

/** Installs the patch; returns the function that removes it. */
export function installTakeover(app: App): () => void {
  const proto = WorkspaceLeaf.prototype;
  const original: SetViewState = proto.setViewState;
  /** Leaves the user switched to markdown, with the file they show. */
  const asMarkdown = new WeakMap<WorkspaceLeaf, string>();
  let active = true;

  const route = (leaf: WorkspaceLeaf, state: ViewState): ViewState | Promise<ViewState> => {
    const inner = state.state ?? {};
    const path = typeof inner.file === 'string' ? inner.file : null;
    if (state.type !== 'markdown' || !path) {
      asMarkdown.delete(leaf);
      return state;
    }
    if (inner.openAsMarkdown) {
      asMarkdown.set(leaf, path);
      const rest = { ...inner };
      delete rest.openAsMarkdown;
      return { ...state, state: rest };
    }
    if (asMarkdown.get(leaf) === path) return state;
    asMarkdown.delete(leaf);
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') return state;
    const toInk = (ink: boolean): ViewState => (ink ? { ...state, type: VIEW_TYPE_INK } : state);
    const cached = cachedIsInk(app, file);
    if (cached !== null) return toInk(cached);
    return isInkFile(app, file).then(toInk);
  };

  const patched: SetViewState = function (this: WorkspaceLeaf, state, eState) {
    if (!active || !state) return original.call(this, state, eState);
    let next: ViewState | Promise<ViewState>;
    try {
      next = route(this, state);
    } catch (e) {
      console.error('[notebook] ink takeover', e);
      next = state;
    }
    if (next instanceof Promise) return next.then(s => original.call(this, s, eState), () => original.call(this, state, eState));
    return original.call(this, next, eState);
  };
  proto.setViewState = patched;

  return () => {
    active = false;
    if (proto.setViewState === patched) proto.setViewState = original;
  };
}

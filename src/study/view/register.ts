/**
 * Registers the study view (ItemView type notebook-study), its commands ("Open study",
 * "Open as study doc"), the file-menu item, the ribbon icon, the protocol handler
 * `obsidian://notebook?study=<id>&a=<anchor>`, and fills ctx.ui.openDoc and ctx.ui.openDrill.
 * Owned by S3 on docs/study/BOARD.md (S4 and S5 plug into the view through view/host.ts).
 */
import { TFile, type WorkspaceLeaf } from 'obsidian';
import type { StudyContext } from '../context';
import { docAtPath } from './model';
import { StudyView, VIEW_TYPE_STUDY } from './view';

const STUDY_KINDS = ['basic', 'topic', 'kata', 'bank', 'card'];

export function register(ctx: StudyContext): void {
  const plugin = ctx.plugin;
  plugin.registerView(VIEW_TYPE_STUDY, leaf => new StudyView(leaf, ctx));

  ctx.ui.openDoc = async (docId, anchor) => {
    const view = await studyView(ctx);
    if (view) await view.navigate(docId, anchor ?? null, { push: true, flash: !!anchor });
  };
  // A derive prompt is a drill block in its doc: open the doc there and flash the prompt.
  ctx.ui.openDrill = async (docId, anchor) => {
    const view = await studyView(ctx);
    if (view) await view.navigate(docId, anchor, { push: true, flash: true });
  };

  plugin.addRibbonIcon('graduation-cap', 'Open study', () => void openLibrary(ctx));
  plugin.addCommand({ id: 'open-study', name: 'Open study', callback: () => void openLibrary(ctx) });
  plugin.addCommand({
    id: 'open-as-study',
    name: 'Open as study doc',
    checkCallback: checking => {
      const file = ctx.app.workspace.getActiveFile();
      const id = file ? studyDocId(ctx, file) : null;
      if (!id) return false;
      if (!checking) void ctx.ui.openDoc(id);
      return true;
    },
  });
  plugin.registerEvent(ctx.app.workspace.on('file-menu', (menu, file) => {
    if (!(file instanceof TFile)) return;
    const id = studyDocId(ctx, file);
    if (!id) return;
    menu.addItem(item => item.setTitle('Open as study doc').setIcon('graduation-cap').onClick(() => void ctx.ui.openDoc(id)));
  }));
  plugin.registerObsidianProtocolHandler('notebook', params => {
    const id = typeof params.study === 'string' ? params.study.trim() : '';
    if (!id || id === 'true') { if ('study' in params) void openLibrary(ctx); return; }
    const a = typeof params.a === 'string' && params.a !== 'true' ? params.a.replace(/^\^/, '') : '';
    void ctx.ui.openDoc(id, a || undefined);
  });
}

/** The study doc id of a vault file: a markdown file under the study root whose frontmatter says `study:`. */
export function studyDocId(ctx: StudyContext, file: TFile): string | null {
  if (file.extension !== 'md') return null;
  const root = ctx.settings().root.replace(/\/+$/, '');
  if (!file.path.startsWith(root + '/')) return null;
  const loaded = docAtPath(ctx.content(), file.path);
  if (loaded) return loaded;
  const fm = ctx.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  const kind = typeof fm?.study === 'string' ? fm.study.trim() : '';
  if (!STUDY_KINDS.includes(kind)) return null;
  return typeof fm?.id === 'string' && fm.id.trim() ? fm.id.trim() : file.basename;
}

/** The study view's leaf: the open one, else a new tab. */
async function studyView(ctx: StudyContext): Promise<StudyView | null> {
  const ws = ctx.app.workspace;
  let leaf: WorkspaceLeaf | undefined = ws.getLeavesOfType(VIEW_TYPE_STUDY)[0];
  if (!leaf) {
    leaf = ws.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_STUDY, active: true });
  }
  await ws.revealLeaf(leaf);
  const deferred = leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> };
  if (typeof deferred.loadIfDeferred === 'function') await deferred.loadIfDeferred();
  return leaf.view instanceof StudyView ? leaf.view : null;
}

async function openLibrary(ctx: StudyContext): Promise<void> {
  const view = await studyView(ctx);
  view?.showLibrary();
}

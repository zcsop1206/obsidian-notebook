// Hides ink notes' page folders in Obsidian's file explorer (#73, setting "Hide page folders in
// the file explorer"): each `.nav-folder` whose title's `data-path` is a known page folder gets
// the class `nb-ink-pages-folder`, which styles.css hides. The notes' own `.md` files stay, so
// links, search and sync work as before. The known folders come from the ink notes' indexes
// (NoteCatalog.pageFolders: only folders an index points into that hold nothing but page files,
// see page-folders.ts), recomputed on vault changes. The explorer rebuilds its items as folders
// are opened, renamed or sorted, so a MutationObserver on each explorer leaf marks new items
// again, and layout changes find new explorer leaves. Turned off, every mark is removed.
import type { App, Plugin } from 'obsidian';
import type { NoteCatalog } from './catalog';

export const PAGES_FOLDER_CLASS = 'nb-ink-pages-folder';

export class ExplorerMarker {
  /** The page folders to hide, once known. */
  folders = new Set<string>();
  /** Folder items marked in the last pass (for tests). */
  marked = 0;
  private observers = new Map<HTMLElement, MutationObserver>();
  private frame = 0;

  constructor(private app: App, private catalog: NoteCatalog, private on: () => boolean) {}

  /** Starts following the vault and the workspace; `plugin` stops it on unload. */
  watch(plugin: Plugin) {
    plugin.register(this.catalog.onChange(() => void this.update()));
    plugin.registerEvent(this.app.workspace.on('layout-change', () => this.attach()));
    plugin.register(() => this.destroy());
    this.app.workspace.onLayoutReady(() => void this.update());
  }

  /** Reads the page folders again and marks the explorer (or unmarks it, when off). */
  async update(): Promise<void> {
    this.folders = this.on() ? await this.catalog.pageFolders() : new Set();
    this.attach();
    this.mark();
  }

  /** Observes every file explorer leaf not observed yet. */
  attach() {
    const live = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
      const el = leaf.view.containerEl;
      live.add(el);
      if (this.observers.has(el)) continue;
      const mo = new MutationObserver(() => this.schedule());
      mo.observe(el, { childList: true, subtree: true });
      this.observers.set(el, mo);
    }
    for (const [el, mo] of this.observers) if (!live.has(el)) {
      mo.disconnect();
      this.observers.delete(el);
    }
    this.schedule();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.mark();
    });
  }

  /** Marks the folder items of known page folders, and unmarks the rest. */
  mark() {
    let n = 0;
    for (const el of this.observers.keys()) {
      for (const title of Array.from(el.querySelectorAll<HTMLElement>('.nav-folder-title[data-path]'))) {
        const item = title.closest<HTMLElement>('.nav-folder');
        if (!item) continue;
        const hide = this.folders.has(title.dataset.path ?? '');
        if (hide) n++;
        if (item.classList.contains(PAGES_FOLDER_CLASS) !== hide) item.classList.toggle(PAGES_FOLDER_CLASS, hide);
      }
    }
    this.marked = n;
  }

  destroy() {
    window.cancelAnimationFrame(this.frame);
    for (const mo of this.observers.values()) mo.disconnect();
    this.folders = new Set();
    this.mark(); // takes every mark off
    this.observers.clear();
  }
}

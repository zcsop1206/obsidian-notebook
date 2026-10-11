// The vault's ink notes, for the notebook library and the file explorer's page-folder hiding
// (#73). A note is a markdown file with `ink:` frontmatter (from metadataCache; a file the cache
// hasn't read yet is read and checked); its index is read once per file version (path, mtime and
// size) for its pages and page folder (found as the store finds it, #62: locatePages). Its last
// change is the latest mtime of the index and its page files, since writing on a page saves only
// the page. Vault events mark the list stale and tell the listeners, at most every REFRESH_MS.
import { TFile, TFolder, type App, type Plugin } from 'obsidian';
import { readNote } from '../format/note';
import { pageFolderOf, pageFolders, type FolderLookup } from './page-folders';
import type { LibNote } from './library-model';
import { cachedIsInk } from './takeover';
import { dirOf } from './paths';

/** Wait after a vault change before the listeners hear of it, in ms. */
export const REFRESH_MS = 150;

/** An ink note as listed: the library's model plus its file and its index's page list. */
export interface CatalogNote extends LibNote {
  file: TFile;
  /** Page ids in order. */
  pageIds: string[];
  /** The index's page folder as written (NoteIndex.folder). */
  folder: string;
}

type Indexed = { key: string; folder: string; pages: string[] } | { key: string; folder: null; pages: [] };

export class NoteCatalog {
  private indexes = new Map<string, Indexed>();
  private listeners = new Set<() => void>();
  private timer = 0;
  /** Index reads (for tests: a cached list reads nothing). */
  reads = 0;

  constructor(private app: App) {}

  /** Listens to the vault; `plugin` unregisters on unload. */
  watch(plugin: Plugin) {
    const vault = this.app.vault;
    const changed = () => this.changed();
    plugin.registerEvent(vault.on('create', changed));
    plugin.registerEvent(vault.on('delete', changed));
    plugin.registerEvent(vault.on('rename', changed));
    plugin.registerEvent(vault.on('modify', changed));
    plugin.registerEvent(this.app.metadataCache.on('changed', changed));
    plugin.register(() => window.clearTimeout(this.timer));
  }

  /** Calls `fn` (debounced) after the vault changes; returns the function that stops it. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tells the listeners soon (a vault change, or a change made here). */
  changed() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      for (const fn of [...this.listeners]) fn();
    }, REFRESH_MS);
  }

  /** The lookup locatePages and pageFolders use, over the vault. */
  lookup(): FolderLookup {
    const vault = this.app.vault;
    return {
      isFile: p => vault.getAbstractFileByPath(p) instanceof TFile,
      find: name => (this.app.metadataCache.getFirstLinkpathDest(name, '') ?? vault.getFiles().find(f => f.name === name))?.path ?? null,
      children: p => {
        const f = vault.getAbstractFileByPath(p);
        return f instanceof TFolder ? f.children.map(c => ({ name: c.name, folder: c instanceof TFolder })) : null;
      },
    };
  }

  /** Every ink note in the vault, read where its file changed since the last call. */
  async notes(): Promise<CatalogNote[]> {
    const lookup = this.lookup();
    const files = this.app.vault.getMarkdownFiles().filter(f => cachedIsInk(this.app, f) !== false);
    const seen = new Set<string>();
    const out: CatalogNote[] = [];
    await Promise.all(files.map(async file => {
      seen.add(file.path);
      const index = await this.index(file);
      if (index.folder === null) return;
      const ref = { path: file.path, folder: index.folder, firstPage: index.pages[0] ?? null };
      const pagesAt = pageFolderOf(ref, lookup);
      out.push({
        file, path: file.path, name: file.basename, subject: dirOf(file.path), pages: index.pages.length, pageIds: index.pages,
        folder: index.folder, firstPage: ref.firstPage, pagesAt, mtime: this.mtime(file, pagesAt),
      });
    }));
    for (const path of [...this.indexes.keys()]) if (!seen.has(path)) this.indexes.delete(path);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** The folders the file explorer may hide: the notes' own page folders (see page-folders.ts). */
  async pageFolders(): Promise<Set<string>> {
    const notes = await this.notes();
    return pageFolders(notes.map(n => ({ path: n.path, folder: n.folder, firstPage: n.firstPage })), this.lookup());
  }

  /** The note's index (page folder as written and page ids); `folder` null if it isn't an ink note. */
  private async index(file: TFile): Promise<Indexed> {
    const key = `${file.stat.mtime}:${file.stat.size}`;
    const had = this.indexes.get(file.path);
    if (had && had.key === key) return had;
    let index: Indexed = { key, folder: null, pages: [] };
    try {
      this.reads++;
      const n = readNote(await this.app.vault.cachedRead(file), file.basename);
      index = { key, folder: n.folder, pages: n.pages };
    } catch (e) {
      // not an ink note, or one that can't be read: not listed
    }
    this.indexes.set(file.path, index);
    return index;
  }

  /** The latest mtime of the note and its page files. */
  private mtime(file: TFile, pagesAt: string | null): number {
    let t = file.stat.mtime;
    const folder = pagesAt ? this.app.vault.getAbstractFileByPath(pagesAt) : null;
    if (folder instanceof TFolder) for (const c of folder.children) if (c instanceof TFile && c.stat.mtime > t) t = c.stat.mtime;
    return t;
  }
}

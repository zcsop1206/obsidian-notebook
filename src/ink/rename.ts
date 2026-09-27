// Renaming or moving an ink note keeps its pages (#26). Obsidian's rename moves only the `.md`,
// so on a vault 'rename' of an ink note this moves the page folder alongside (`lecture/` ->
// `week1/`, next to the note) with vault.rename, and rewrites the index's embeds. When the
// target folder is taken the pages stay and the embeds point at them where they are. A page
// folder renamed by hand has its sibling notes' embeds rewritten to follow.
//
// This handler is the one place that moves folders. When an ink view has the note open, its
// store does the rest: it takes the new note path (idempotent with the view's onRename), holds
// its saves while the folder moves (so no page is written to the old place), then writes the
// rewritten index through its own save path, whose writes it recognises as its own. The view's
// own rename listener lets the store follow a page folder moved by anyone (NoteStore.followRename);
// notes that aren't open are rewritten on disk here.
import { Notice, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';
import { isInkNote, readNote, writeNote } from '../format/note';
import { cachedIsInk, VIEW_TYPE_INK } from './takeover';
import { InkView } from './view';
import type { NoteStore } from './store';
import { dirOf, planRename, rebase, relative, resolve, within } from './paths';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class RenameHandler {
  /** Page folders this handler is moving: their own rename events are not renames by hand. */
  private moving = new Set<string>();

  constructor(private app: App) {}

  /** For vault.on('rename'). Resolves when the pages have followed. */
  async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    try {
      if (file instanceof TFile) await this.noteRenamed(file, oldPath);
      else if (file instanceof TFolder) await this.folderRenamed(file, oldPath);
    } catch (e) {
      console.error('[notebook] rename', e);
      new Notice(`Couldn't update the pages after renaming ${oldPath}: ${errorText(e)}`);
    }
  }

  private isFolder = (path: string) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder;

  /** The store of an ink view showing this note, if any. */
  private openStore(...paths: string[]): NoteStore | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      const view = leaf.view;
      if (view instanceof InkView && view.store && paths.includes(view.store.notePath)) return view.store;
    }
    return null;
  }

  /** Where pages last seen at `pages` (seen from the note's old place) are now; null if missing. */
  private locate(pages: string | null, oldNote: string, newNote: string): string | null {
    if (pages && this.isFolder(pages)) return pages;
    // A parent folder was renamed: the pages moved with the note.
    const moved = pages && resolve(dirOf(newNote), relative(dirOf(oldNote), pages));
    return moved && this.isFolder(moved) ? moved : null;
  }

  private async noteRenamed(file: TFile, oldPath: string) {
    if (file.extension !== 'md' || cachedIsInk(this.app, file) === false) return;
    const newPath = file.path;
    const store = this.openStore(newPath, oldPath);
    if (store) {
      store.renamed(newPath);
      const pages = this.locate(store.folder, oldPath, newPath);
      if (pages && pages !== store.folder) store.pagesMoved(pages);
      const plan = planRename(oldPath, newPath, pages, this.isFolder);
      if (plan.kind === 'move') await this.move(plan.from, plan.to, to => store.movePages(to, () => this.renameFolder(plan.from, to)));
      if (plan.kind === 'collision') this.collision(plan.at, plan.to);
      await store.flush();
      return;
    }

    const text = await this.app.vault.read(file);
    if (!isInkNote(text)) return;
    const index = readNote(text, file.basename);
    const pages = this.locate(resolve(dirOf(oldPath), index.folder), oldPath, newPath);
    const plan = planRename(oldPath, newPath, pages, this.isFolder);
    let at = pages;
    if (plan.kind === 'move' && await this.move(plan.from, plan.to, async to => { await this.renameFolder(plan.from, to); return true; })) at = plan.to;
    if (plan.kind === 'collision') this.collision(plan.at, plan.to);
    if (at === null) return;
    const folder = relative(dirOf(newPath), at);
    if (folder !== index.folder) await this.rewrite(file, text, folder);
  }

  /** Runs a move of page folder `from` to `to`, whose own rename events are ignored here. */
  private async move(from: string, to: string, run: (to: string) => Promise<boolean>): Promise<boolean> {
    this.moving.add(from);
    try {
      return await run(to);
    } finally {
      this.moving.delete(from);
    }
  }

  private async renameFolder(from: string, to: string) {
    const folder = this.app.vault.getAbstractFileByPath(from);
    if (!(folder instanceof TFolder)) throw new Error(`${from} is not a folder`);
    await this.app.vault.rename(folder, to);
  }

  private collision(at: string, to: string) {
    new Notice(`${to} already exists, so the pages stay in ${at}; the note still shows them.`);
  }

  /** Rewrites a closed note's embeds to `folder`, if the file hasn't changed since `text` was read. */
  private async rewrite(file: TFile, text: string, folder: string) {
    const vault = this.app.vault;
    const now = await vault.read(file);
    if (now !== text) return;
    const index = readNote(now, file.basename);
    index.folder = folder;
    await vault.modify(file, writeNote(index));
  }

  /**
   * A folder was renamed. If it was (or held) a page folder renamed by hand, the notes next to
   * its old place whose embeds pointed into it follow. Open notes follow in their view.
   */
  private async folderRenamed(folder: TFolder, oldPath: string) {
    if (this.moving.has(oldPath)) return;
    const parent = this.app.vault.getAbstractFileByPath(dirOf(oldPath) || '/');
    if (!(parent instanceof TFolder)) return;
    for (const child of parent.children) {
      if (!(child instanceof TFile) || child.extension !== 'md' || cachedIsInk(this.app, child) === false) continue;
      if (this.openStore(child.path)) continue;
      const text = await this.app.vault.read(child);
      if (!isInkNote(text)) continue;
      let index;
      try {
        index = readNote(text, child.basename);
      } catch (e) {
        continue;
      }
      const pages = resolve(dirOf(child.path), index.folder);
      if (!pages || !within(pages, oldPath) || this.isFolder(pages)) continue;
      await this.rewrite(child, text, relative(dirOf(child.path), rebase(pages, oldPath, folder.path)));
    }
  }
}


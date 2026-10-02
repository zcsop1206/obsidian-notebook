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
//
// Obsidian updates links itself after a rename from its file explorer (#62): with the default
// "shortest path" link format a page embed becomes the bare `p-7f3a0c.svg`, with "absolute path"
// a path from the vault root. Those are read (format/note.ts, locatePages), and put back as
// relative paths here for notes that aren't open (the store does it for an open one), so GitHub
// and the site still find the pages. Obsidian replaces links at the offsets they had before the
// rename, so no index is written until its update is done (linkUpdatesDone).
import { MarkdownView, Notice, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';
import { isInkNote, isRelativeFolder, readNote, writeNote, type NoteIndex } from '../format/note';
import { cachedIsInk, VIEW_TYPE_INK } from './takeover';
import { InkView, vaultFiles } from './view';
import type { NoteStore } from './store';
import { dirOf, locatePages, planRename, relative, resolve, type PageLookup } from './paths';
import { linkUpdatesDone } from './links';

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

  /**
   * For vault.on('modify'): an ink note that isn't open, changed on disk (as by Obsidian's link
   * update), has its embeds put back as relative paths if they are in another form.
   */
  async onModify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md' || cachedIsInk(this.app, file) === false) return;
    try {
      await linkUpdatesDone(this.app);
      await this.canonicalise(file);
    } catch (e) {
      console.error('[notebook] embeds', e);
    }
  }

  private isFolder = (path: string) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder;

  private lookup(): PageLookup {
    const files = vaultFiles(this.app);
    return { isFile: path => files.isFile!(path), find: name => files.find!(name) };
  }

  /** Where the pages of a read index are, seen from the note at `notePath`; null if not found. */
  private pagesOf(index: NoteIndex, notePath: string): string | null {
    return index.pages.length ? locatePages(dirOf(notePath), index.folder, index.pages[0], this.lookup()) : null;
  }

  /** Whether the note is open in a markdown editor, where a rewrite would change the text being edited. */
  private inEditor(path: string): boolean {
    return this.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === path);
  }

  /**
   * Rewrites a note's embeds as relative paths to where its pages are, if it isn't open, is an
   * ink note, its pages are found and the embeds are in another form or name another folder.
   */
  private async canonicalise(file: TFile) {
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) return;
    if (this.openStore(file.path) || this.inEditor(file.path)) return;
    const text = await this.app.vault.read(file);
    if (!isInkNote(text)) return;
    let index: NoteIndex;
    try {
      index = readNote(text, file.basename);
    } catch (e) {
      return;
    }
    const pages = this.pagesOf(index, file.path);
    if (!pages) return;
    const folder = relative(dirOf(file.path), pages);
    if (folder !== index.folder) await this.rewrite(file, text, folder);
  }

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
      await store.indexReleased(); // not before Obsidian's own link update (#62)
      await store.flush();
      return;
    }

    const text = await this.app.vault.read(file);
    if (!isInkNote(text)) return;
    const index = readNote(text, file.basename);
    const pages = this.pagesOf(index, newPath)
      ?? this.locate(isRelativeFolder(index.folder) ? resolve(dirOf(oldPath), index.folder) : null, oldPath, newPath);
    const plan = planRename(oldPath, newPath, pages, this.isFolder);
    if (plan.kind === 'move') await this.move(plan.from, plan.to, async to => { await this.renameFolder(plan.from, to); return true; });
    if (plan.kind === 'collision') this.collision(plan.at, plan.to);
    await linkUpdatesDone(this.app);
    await this.canonicalise(file);
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
   * its old place whose embeds pointed into it follow (their pages are found by file name).
   * Open notes follow in their view.
   */
  private async folderRenamed(folder: TFolder, oldPath: string) {
    if (this.moving.has(oldPath)) return;
    const parent = this.app.vault.getAbstractFileByPath(dirOf(oldPath) || '/');
    if (!(parent instanceof TFolder)) return;
    const notes = parent.children.filter((c): c is TFile => c instanceof TFile && c.extension === 'md' && cachedIsInk(this.app, c) !== false);
    if (!notes.length) return;
    await linkUpdatesDone(this.app);
    for (const note of notes) await this.canonicalise(note);
  }
}


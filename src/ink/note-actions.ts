// What can be done to a whole ink note from outside it: from the ink view's title (#72) and the
// notebook library's cards (#73). Renames and moves go through fileManager.renameFile, as the
// file explorer's do, so RenameHandler (#26) moves the page folder and Obsidian's link update
// (#62) runs; nothing here moves a page folder itself. Duplicating copies the note and its page
// folder with new page ids; deleting puts the note and its own page folder in Obsidian's trash.
import { MarkdownView, Notice, TFile, TFolder, type App } from 'obsidian';
import { newPageId } from '../format/ids';
import { markdownEmbed, readNote, writeNote } from '../format/note';
import { readPage, writePage } from '../format/page';
import { cleanName, uniqueName } from './names';
import { ensureFolder, nameTaken } from './new-note';
import { dirOf, join } from './paths';
import { onlyPageFiles } from './page-folders';
import { NoteStore } from './store';
import { exportNotePdf } from './export-pdf';
import { InkView, vaultFiles } from './view';
import { VIEW_TYPE_INK } from './takeover';
import { linkUpdatesDone } from './links';
import { Platform } from 'obsidian';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Renames a note in its folder (the name cleaned as a new note's is). Resolves to why it
 * couldn't, or null (also when the name is unchanged).
 */
export async function renameNote(app: App, file: TFile, name: string): Promise<string | null> {
  const base = cleanName(name);
  if (base === file.basename) return null;
  const path = join(dirOf(file.path), `${base}.md`);
  if (app.vault.getAbstractFileByPath(path)) return `There is already a note named "${base}" here.`;
  try {
    await app.fileManager.renameFile(file, path);
  } catch (e) {
    return `Couldn't rename the note: ${errorText(e)}`;
  }
  return null;
}

/** Moves a note into `folder` ('' the vault root), keeping its name. Resolves to why it couldn't, or null. */
export async function moveNote(app: App, file: TFile, folder: string): Promise<string | null> {
  if (dirOf(file.path) === folder) return null;
  const path = join(folder, file.name);
  if (app.vault.getAbstractFileByPath(path)) return `There is already a note named "${file.basename}" in ${folder || 'the vault root'}.`;
  try {
    await ensureFolder(app, folder);
    await app.fileManager.renameFile(file, path);
  } catch (e) {
    return `Couldn't move the note: ${errorText(e)}`;
  }
  return null;
}

/**
 * Copies a note next to itself as `<name> 1` (or the next free name) with its pages under new
 * ids in a page folder of its own, and the other files of its page folder (a PDF the pages refer
 * to, #14). Returns the copy's path. `pagesAt` is where the note's pages are.
 */
export async function duplicateNote(app: App, file: TFile, pagesAt: string | null): Promise<string> {
  const vault = app.vault, dir = dirOf(file.path);
  const index = readNote(await vault.read(file), file.basename);
  const base = uniqueName(file.basename, n => nameTaken(app, dir, n));
  const target = join(dir, base);
  await ensureFolder(app, target);
  const ids: string[] = [], taken = new Set<string>(index.pages);
  for (const id of index.pages) {
    const page = pagesAt ? vault.getFileByPath(`${pagesAt}/${id}.svg`) : null;
    if (!page) continue;
    const p = readPage(await vault.read(page));
    p.id = newPageId(taken);
    taken.add(p.id);
    await vault.create(`${target}/${p.id}.svg`, writePage(p));
    ids.push(p.id);
  }
  const folder = pagesAt ? vault.getAbstractFileByPath(pagesAt) : null;
  if (folder instanceof TFolder) {
    for (const c of folder.children) {
      if (!(c instanceof TFile) || /^p-[0-9a-f]{6}\.svg$/.test(c.name) || c.extension === 'md') continue;
      await vault.createBinary(`${target}/${c.name}`, await vault.readBinary(c));
    }
  }
  index.basename = base;
  index.folder = base;
  index.pages = ids;
  const path = join(dir, `${base}.md`);
  await vault.create(path, writeNote(index));
  return path;
}

/** Closes every tab showing the note (ink or markdown), saving an open ink note first. */
async function closeLeaves(app: App, path: string) {
  for (const leaf of [...app.workspace.getLeavesOfType(VIEW_TYPE_INK), ...app.workspace.getLeavesOfType('markdown')]) {
    const v = leaf.view;
    if ((v instanceof InkView || v instanceof MarkdownView) && v.file?.path === path) leaf.detach();
  }
  await linkUpdatesDone(app);
}

/**
 * Puts a note in Obsidian's trash with its page folder, if the folder is its own: no other note
 * keeps its pages there and it holds only page files (else only this note's page files go).
 * `others` are the page folders of the other ink notes.
 */
export async function trashNote(app: App, file: TFile, pagesAt: string | null, pageIds: readonly string[], others: ReadonlySet<string>): Promise<void> {
  await closeLeaves(app, file.path);
  const fm = app.fileManager, vault = app.vault;
  const folder = pagesAt ? vault.getAbstractFileByPath(pagesAt) : null;
  if (folder instanceof TFolder && pagesAt) {
    const own = !others.has(pagesAt) && onlyPageFiles(folder.children.map(c => ({ name: c.name, folder: c instanceof TFolder })));
    if (own) await fm.trashFile(folder);
    else for (const id of pageIds) {
      const f = vault.getAbstractFileByPath(`${pagesAt}/${id}.svg`);
      if (f) await fm.trashFile(f);
    }
  }
  await fm.trashFile(file);
}

/** Exports a note as a PDF next to it (#18): through its open ink view if it has one, else read for the export. */
export async function exportNote(app: App, file: TFile): Promise<string | null> {
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
    const v = leaf.view;
    if (v instanceof InkView && v.file?.path === file.path && v.store) return v.exportPdf();
  }
  const store = new NoteStore(vaultFiles(app), file.path, file.basename, {
    pageChanged: () => {}, indexChanged: () => {}, notice: m => new Notice(m), saved: () => {},
  }, { linksSettled: () => linkUpdatesDone(app) });
  try {
    await store.load();
    const release = await store.loadAll();
    try {
      return await exportNotePdf(app.vault, store, file.path, file.basename, { notice: (m, t) => new Notice(m, t), ios: Platform.isIosApp });
    } finally {
      release();
    }
  } catch (e) {
    new Notice(`Couldn't export ${file.basename}: ${errorText(e)}`);
    return null;
  } finally {
    await store.flush();
    store.close();
  }
}

/** Puts a markdown embed of the note's first page (#27) on the clipboard; returns it, or null without pages. */
export async function copyFirstPageEmbed(pagesAt: string | null, firstPage: string | null): Promise<string | null> {
  if (!pagesAt || !firstPage) {
    new Notice('This note has no pages');
    return null;
  }
  const text = markdownEmbed(`${pagesAt}/${firstPage}.svg`);
  try {
    await navigator.clipboard.writeText(text);
    new Notice('Copied the embed of the first page');
  } catch (e) {
    new Notice(`Couldn't use the clipboard; the embed is: ${text}`, 0);
  }
  return text;
}

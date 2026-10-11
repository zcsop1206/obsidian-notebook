// Which folders are ink notes' page folders (#73), pure, so the rule that decides what the file
// explorer hides is unit-tested. A note's page folder is found as the store finds it (#62:
// locatePages, from the index's embeds and its first page), never by name alone: a folder named
// like a note but without an index that points into it is left alone. A folder is only hidden
// when it holds nothing but the pages and their files (PDFs, #14): no markdown file and no
// subfolder, so a note or a folder someone put there never disappears with it.
import { dirOf, locatePages, type PageLookup } from './paths';

/** An ink note as read for the library and the explorer: its path and its index's page folder and first page. */
export interface InkNoteRef {
  /** The note's vault path (`School/lecture.md`). */
  path: string;
  /** The index's page folder as read (NoteIndex.folder). */
  folder: string;
  /** The first page's id, or null for a note without pages. */
  firstPage: string | null;
}

/** What pageFolders asks of the vault besides finding page files. */
export interface FolderLookup extends PageLookup {
  /** The folder's children, or null if there is no such folder. */
  children(folder: string): { name: string; folder: boolean }[] | null;
}

/** The vault path of a note's page folder (where its first page file is), or null if not found. */
export function pageFolderOf(note: InkNoteRef, lookup: PageLookup): string | null {
  return note.firstPage ? locatePages(dirOf(note.path), note.folder, note.firstPage, lookup) : null;
}

/** Whether a folder's children are only files that aren't markdown (page SVGs, a copied PDF). */
export function onlyPageFiles(children: readonly { name: string; folder: boolean }[]): boolean {
  return children.every(c => !c.folder && !/\.md$/i.test(c.name));
}

/** The folders the file explorer may hide: every ink note's page folder that holds only page files. */
export function pageFolders(notes: readonly InkNoteRef[], lookup: FolderLookup): Set<string> {
  const out = new Set<string>();
  for (const note of notes) {
    const at = pageFolderOf(note, lookup);
    if (!at || out.has(at)) continue;
    const children = lookup.children(at);
    if (children && onlyPageFiles(children)) out.add(at);
  }
  return out;
}

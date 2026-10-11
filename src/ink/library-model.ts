// The notebook library's model (#73), pure: ink notes grouped by subject, sorted and filtered.
// A subject is a note's folder (one level: a subfolder is its own subject, named with its path).
// Subjects are named from the notes folder: the notes folder itself by its own name, a folder
// inside it by its path below it (`Physics`, `Physics/Labs`), any other folder by its vault path,
// and the vault root "Unfiled". Order: the notes folder, the subjects inside it by name, other
// folders by name, Unfiled last. Notes: last modified first, then by name.
import { within } from './paths';

export interface LibNote {
  /** The note's vault path. */
  path: string;
  /** Its name (basename). */
  name: string;
  /** Its folder ('' at the vault root). */
  subject: string;
  /** Number of pages in its index. */
  pages: number;
  /** Last modified, ms: the latest of the index and its page files. */
  mtime: number;
  /** Its page folder's vault path, or null if not found. */
  pagesAt: string | null;
  /** The first page's id, or null. */
  firstPage: string | null;
}

export interface Subject<N extends LibNote = LibNote> {
  /** The folder's vault path ('' for Unfiled). */
  folder: string;
  label: string;
  notes: N[];
}

export const UNFILED = 'Unfiled';

/** A subject's label (see the module comment). */
export function subjectLabel(folder: string, notesFolder: string): string {
  if (!folder) return UNFILED;
  if (notesFolder && folder.startsWith(notesFolder + '/')) return folder.slice(notesFolder.length + 1);
  return folder;
}

/** Sort rank of a subject: the notes folder, inside it, elsewhere, Unfiled. */
function rank(folder: string, notesFolder: string): number {
  if (!folder) return 3;
  if (notesFolder && folder === notesFolder) return 0;
  if (notesFolder && within(folder, notesFolder)) return 1;
  return 2;
}

/** Whether a note's name matches a search: every word of the query, case-insensitively. */
export function matches(name: string, query: string): boolean {
  const n = name.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(w => n.includes(w));
}

/**
 * The library's subjects: the folders holding notes, plus `folders` (subjects without notes,
 * such as one just made with "New subject"), notes sorted in each. With a query, only matching
 * notes, and only the subjects that have some.
 */
export function groupNotes<N extends LibNote>(notes: readonly N[], folders: readonly string[], notesFolder: string, query = ''): Subject<N>[] {
  const by = new Map<string, N[]>();
  for (const f of folders) by.set(f, []);
  for (const n of notes) {
    if (!by.has(n.subject)) by.set(n.subject, []);
    if (!query.trim() || matches(n.name, query)) by.get(n.subject)!.push(n);
  }
  const out: Subject<N>[] = [];
  for (const [folder, list] of by) {
    if (query.trim() && !list.length) continue;
    list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    out.push({ folder, label: subjectLabel(folder, notesFolder), notes: list });
  }
  return out.sort((a, b) => rank(a.folder, notesFolder) - rank(b.folder, notesFolder) || a.label.localeCompare(b.label));
}

/** "Today", "Yesterday", or the date (`10 Oct 2026`), for a card's last-modified line. */
export function modifiedLabel(mtime: number, now: number): string {
  if (!mtime) return '';
  const day = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(now) - day(mtime)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(mtime);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** "1 page", "12 pages". */
export const pagesLabel = (n: number) => `${n} page${n === 1 ? '' : 's'}`;

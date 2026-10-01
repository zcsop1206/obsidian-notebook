// Vault path arithmetic for a note's page folder (#26), pure: vault paths are `/`-separated with
// no leading slash, '' is the vault root; a note's `folder` is relative to the note's own folder.

/** The folder part of a vault path ('' at the root). */
export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The last part of a vault path. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** `name` inside folder `dir` ('' is the root). */
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The vault path of `rel` (which may start with `../`) seen from folder `dir`; null if it leaves the vault. */
export function resolve(dir: string, rel: string): string | null {
  const out = dir ? dir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else if (part !== '.' && part !== '') {
      out.push(part);
    }
  }
  return out.length ? out.join('/') : null;
}

/** The relative path from folder `dir` to vault path `target` (`../` where needed). */
export function relative(dir: string, target: string): string {
  const from = dir ? dir.split('/') : [];
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

/** What locatePages asks of the vault. */
export interface PageLookup {
  isFile(path: string): boolean;
  /** The vault path of the file with this name, as Obsidian resolves a bare link; null if none. */
  find(name: string): string | null;
}

/**
 * The folder holding a note's pages, found the way Obsidian resolves the embeds (#62): `folder`
 * (the embeds' folder as written) from the note's folder `noteDir`, then from the vault root,
 * then wherever the file `<page>.svg` is. Null if the page file is in none of them (or sits in
 * the vault root, where pages can't be).
 */
export function locatePages(noteDir: string, folder: string, page: string, lookup: PageLookup): string | null {
  const name = `${page}.svg`;
  const candidates: (string | null)[] = [];
  if (folder && !folder.startsWith('/')) candidates.push(resolve(noteDir, folder));
  if (folder) candidates.push(resolve('', folder));
  for (const c of candidates) if (c && lookup.isFile(`${c}/${name}`)) return c;
  const found = lookup.find(name);
  return found && dirOf(found) ? dirOf(found) : null;
}

/** Whether `path` is `folder` or inside it. */
export const within = (path: string, folder: string) => path === folder || path.startsWith(folder + '/');

/** `path` with its leading `from` folder replaced by `to` (path must be within `from`). */
export const rebase = (path: string, from: string, to: string) => to + path.slice(from.length);

export type RenamePlan =
  /** Move the page folder `from` to `to`. */
  | { kind: 'move'; from: string; to: string }
  /** The target is taken: leave the pages in `at`. */
  | { kind: 'collision'; at: string; to: string }
  /** Nothing to move: the pages are already where they belong, missing, or in a folder named by hand. */
  | { kind: 'none'; at: string | null };

/**
 * What to do with a note's page folder when the note moves from `oldNote` to `newNote` (vault
 * paths of the `.md`). `pages` is where its pages are now (null if missing). The folder follows
 * the note only when it is the note's own (named after the old basename, next to the note before
 * or after the move, as when a parent folder was renamed); a folder named otherwise stays put.
 */
export function planRename(oldNote: string, newNote: string, pages: string | null, exists: (path: string) => boolean): RenamePlan {
  if (pages === null) return { kind: 'none', at: null };
  const base = (p: string) => nameOf(p).replace(/\.md$/i, '');
  const to = join(dirOf(newNote), base(newNote));
  if (pages === to) return { kind: 'none', at: pages };
  const own = nameOf(pages) === base(oldNote) && (dirOf(pages) === dirOf(oldNote) || dirOf(pages) === dirOf(newNote));
  if (!own) return { kind: 'none', at: pages };
  if (exists(to)) return { kind: 'collision', at: pages, to };
  return { kind: 'move', from: pages, to };
}

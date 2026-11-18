/**
 * The standalone problem view's home doc (S12, docs/study/threads/S12.md). A problem opened from
 * Today or Map behaves as it does inside its doc: the statement renders with the home doc's path
 * (so bare-name figures and relative links resolve as they do in the doc), and its call and work
 * ink live in the home doc's ink file under `call:<id>` / `work:<id>`, so both places see the same
 * strokes. The home doc is `content.problems.get(id).doc` looked up in `content.docs`; when the
 * problem or its doc is missing, the synthetic `problems` doc stands in (the pre-0.15.1 filing
 * place). It serves only as the render path and the ink file — its title, id and path are never
 * shown, so a hidden pick still names no topic before the settle.
 *
 * Old strokes: strokes this device wrote under those keys in `ink/problems.<device>.json` are
 * copied into the home doc's ink once each (`copyOldProblemInk`). The copy goes through the home
 * doc's shared ink store (ink/index.ts adoptInk), so a store already loaded this session shows
 * them at once and never writes them away. This device keeps a record of the stroke ids it has
 * copied (`movedInk`, Obsidian's per-vault local storage), so a copied stroke erased later never
 * comes back. The old file is never edited or deleted.
 *
 * Kept out of register.ts so the unit tests can import it: register.ts pulls `obsidian` runtime
 * symbols, which the node test bundle cannot resolve.
 */
import type { ContentIndex, StudyDoc } from '../types';
import type { InkFile } from '../ink/model';
import { inkPath, parseInkFile } from '../ink/model';
import type { InkAdapter } from '../ink/store';
import type { InkStroke } from '../view/host';

/** The doc a standalone problem's ink was filed under before 0.15.1 (and the fallback now). */
export const PROBLEMS_DOC = 'problems';

/** A minimal doc for the standalone view when no home doc resolves: it carries only the id the ink store files under. */
export function problemsDoc(root: string): StudyDoc {
  return {
    id: PROBLEMS_DOC, path: `${root}/${PROBLEMS_DOC}.md`, kind: 'other', title: 'Problems', areas: [], needs: [], build: 0,
    tracks: [], by: 'model', labelled: false, meta: {}, passages: [], links: [], theorems: [], proofs: [], derives: [],
    problems: [], recalls: [], kata: null, bank: [], bankRefs: [], warnings: [],
  };
}

/** The block-canvas keys a problem uses: the call band and the work paper (SPEC.md, Storage: Ink). */
export function problemInkKeys(id: string): [string, string] {
  return [`call:${id}`, `work:${id}`];
}

/**
 * The doc a standalone problem renders against and files its ink under: the problem's own doc
 * from the index (a bank problem's home is the bank file), else the synthetic `problems` doc when
 * the problem or its doc is missing.
 */
export function homeDoc(content: ContentIndex, id: string, root: string): StudyDoc {
  const p = content.problems.get(id);
  const d = p ? content.docs.get(p.doc) : undefined;
  return d ?? problemsDoc(root);
}

/** This device's record of the old strokes it has already copied, by stroke id. */
export interface MovedInk {
  has(id: string): boolean;
  add(ids: readonly string[]): void;
}

/**
 * The record kept in Obsidian's per-vault local storage on this device (window.localStorage
 * where the app has none; memory for the session where neither works). Per device, like the old
 * file it guards: stroke ids are random per device.
 */
export function movedInk(app: unknown, device: string): MovedInk {
  const key = `notebook-study-moved-ink:${device}`;
  const a = (app || {}) as { loadLocalStorage?: (k: string) => unknown; saveLocalStorage?: (k: string, d: unknown) => void };
  let stored: unknown = null;
  try {
    stored = typeof a.loadLocalStorage === 'function' ? a.loadLocalStorage(key) : JSON.parse(window.localStorage.getItem(key) || 'null');
  } catch { /* no storage: start empty */ }
  const ids = new Set(Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []);
  return {
    has: id => ids.has(id),
    add: more => {
      for (const id of more) ids.add(id);
      const list = [...ids];
      try {
        if (typeof a.saveLocalStorage === 'function') a.saveLocalStorage(key, list);
        else window.localStorage.setItem(key, JSON.stringify(list));
      } catch { /* storage off: the record lasts this session */ }
    },
  };
}

/**
 * Which of `src`'s strokes still need copying: those under one of `keys` (this device's
 * `call:<id>`/`work:<id>` strokes) that this device has not copied before. A stroke copied once
 * is never picked again, even after it is erased from the home doc.
 */
export function strokesToCopy(src: InkFile, keys: readonly string[], moved: Pick<MovedInk, 'has'>): InkStroke[] {
  return src.strokes.filter(s => typeof s.blk === 'string' && keys.indexOf(s.blk) >= 0 && !moved.has(s.id));
}

/** What the old-strokes copy needs: the old file's reader, where it lives, the home doc's store, and the record. */
export interface OldInkIO {
  adapter: Pick<InkAdapter, 'exists' | 'read'>;
  root: string;
  device: string;
  /** Adds strokes to a doc's ink through its shared store, skipping ids it holds; resolves to how many were added. */
  adopt(docId: string, strokes: InkStroke[]): Promise<number>;
  moved: MovedInk;
}

/**
 * Copies this device's strokes under `call:<id>`/`work:<id>` from `ink/problems.<device>.json`
 * into the home doc's ink through its store, keeping ids, and records them as copied. Each stroke
 * is copied once: a second run copies nothing, and a copied stroke erased later stays erased. The
 * old file is never edited or deleted. Returns how many strokes were added; 0 when the home doc
 * is the `problems` fallback, the old file is missing, or there is nothing new. Never throws: a
 * failure is logged and reported as 0, so the problem still opens.
 */
export async function copyOldProblemInk(io: OldInkIO, homeId: string, id: string): Promise<number> {
  try {
    if (homeId === PROBLEMS_DOC) return 0;
    const srcPath = inkPath(io.root, PROBLEMS_DOC, io.device);
    if (!(await io.adapter.exists(srcPath))) return 0;
    const src = parseInkFile(await io.adapter.read(srcPath), PROBLEMS_DOC);
    const todo = strokesToCopy(src, problemInkKeys(id), io.moved);
    if (!todo.length) return 0;
    const n = await io.adopt(homeId, todo);
    io.moved.add(todo.map(s => s.id));
    return n;
  } catch (e) {
    console.error('[study] copying old problem ink failed', e);
    return 0;
  }
}

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
 * copied into the home doc's ink once each: every problem's by a pass after the plugin loads
 * (`migrateOldProblemInk`), and one problem's again when it opens (`copyOldProblemInk`), both
 * through one queue. The copy goes through the home doc's shared ink store (ink/index.ts
 * adoptInk), so a store already loaded this session shows them at once and never writes them
 * away. Once the home doc's ink is written, this device records the stroke ids it copied
 * (`movedInk`, Obsidian's per-vault local storage), so a copied stroke erased later never comes
 * back. The old file is never edited or deleted.
 *
 * Kept out of register.ts so the unit tests can import it: register.ts pulls `obsidian` runtime
 * symbols, which the node test bundle cannot resolve.
 */
import type { ContentIndex, StudyDoc } from '../types';
import type { InkFile } from '../ink/model';
import { inkPath, parseInkFile } from '../ink/model';
import type { Adopted, InkAdapter } from '../ink/store';
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
 * where the app has none). Per device, like the old file it guards: stroke ids are random per
 * device. `add` reads the stored list again and merges before it saves, so two records built at
 * once never drop each other's ids. Without storage, the record lasts as long as this object.
 */
export function movedInk(app: unknown, device: string): MovedInk {
  const key = `notebook-study-moved-ink:${device}`;
  const a = (app || {}) as { loadLocalStorage?: (k: string) => unknown; saveLocalStorage?: (k: string, d: unknown) => void };
  const stored = (): string[] => {
    let v: unknown = null;
    try {
      v = typeof a.loadLocalStorage === 'function' ? a.loadLocalStorage(key) : JSON.parse(window.localStorage.getItem(key) || 'null');
    } catch { /* no storage: nothing stored */ }
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  const ids = new Set(stored());
  return {
    has: id => ids.has(id),
    add: more => {
      for (const id of stored()) ids.add(id);
      for (const id of more) ids.add(id);
      const list = [...ids];
      try {
        if (typeof a.saveLocalStorage === 'function') a.saveLocalStorage(key, list);
        else window.localStorage.setItem(key, JSON.stringify(list));
      } catch { /* no storage: the ids live in this object only */ }
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

/** Runs a job after every job given before it has settled, and resolves as the job does. */
export type Serial = <T>(job: () => Promise<T>) => Promise<T>;

/** A queue of jobs run one at a time, in order (register.ts keeps one per StudyContext for the copies of old ink). */
export function serialQueue(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** What the old-strokes copy needs: the old file's reader, where it lives, the home doc's store, and the record. */
export interface OldInkIO {
  adapter: Pick<InkAdapter, 'exists' | 'read'>;
  root: string;
  device: string;
  /**
   * Adds strokes to a doc's ink through its shared store, skipping ids it holds, and flushes it
   * (ink/index.ts adoptInk): how many were added, and whether nothing is left unwritten.
   */
  adopt(docId: string, strokes: InkStroke[]): Promise<Adopted>;
  moved: MovedInk;
  /**
   * The queue every copy runs through, one problem at a time, so two copies of one problem never
   * interleave (one per StudyContext: the load-time pass and the standalone view share it).
   * Without it a copy runs at once.
   */
  serial?: Serial;
}

const queued = <T>(io: OldInkIO, job: () => Promise<T>): Promise<T> => (io.serial ? io.serial(job) : job());

/**
 * Copies this device's strokes under `call:<id>`/`work:<id>` from `ink/problems.<device>.json`
 * into the home doc's ink through its store, keeping ids, and records them as copied once the
 * home doc's ink is written (`saved`). A copy whose write did not land stays on screen (the store
 * retries) and is recorded by a later copy that finds it written. Each stroke is copied once: a
 * second run copies nothing, and a copied stroke erased later stays erased. The old file is never
 * edited or deleted. Returns how many strokes were added; 0 when the home doc is the `problems`
 * fallback, the old file is missing, or there is nothing new. Runs in the copy queue. Never
 * throws: a failure is logged and reported as 0, so the problem still opens.
 */
export function copyOldProblemInk(io: OldInkIO, homeId: string, id: string): Promise<number> {
  return queued(io, async () => {
    try {
      if (homeId === PROBLEMS_DOC) return 0;
      const srcPath = inkPath(io.root, PROBLEMS_DOC, io.device);
      if (!(await io.adapter.exists(srcPath))) return 0;
      const src = parseInkFile(await io.adapter.read(srcPath), PROBLEMS_DOC);
      const todo = strokesToCopy(src, problemInkKeys(id), io.moved);
      if (!todo.length) return 0;
      const r = await io.adopt(homeId, todo);
      if (r.saved) io.moved.add(todo.map(s => s.id));
      return r.added;
    } catch (e) {
      console.error('[study] copying old problem ink failed', e);
      return 0;
    }
  });
}

/** What a load-time pass did: strokes copied into their home docs and written, and strokes left for a later pass. */
export interface OldInkPass {
  copied: number;
  pending: number;
}

/** The problem a call band or work paper key names (`call:<id>`, `work:<id>`), else null. */
function problemOfKey(blk: string | null | undefined): string | null {
  const m = typeof blk === 'string' ? /^(?:call|work):(.+)$/.exec(blk) : null;
  return m ? m[1] : null;
}

/**
 * The load-time pass (register.ts starts it): copies this device's old standalone problem ink
 * into every problem's home doc, so a problem Today never picks again still shows its call in its
 * doc. Reads `ink/problems.<device>.json` once and takes every stroke under `call:<id>` or
 * `work:<id>` whose id the record lacks, grouped by problem. Then, one problem after another
 * (sorted ids, each a job in the copy queue), resolves its home doc in `content` (an index, or a
 * getter read at each problem): the `problems` fallback (the problem or its doc is missing)
 * leaves its strokes pending; otherwise they are adopted into the home doc's store and their ids
 * recorded once written, else they too stay pending. An old file that exists but cannot be read
 * counts as one pending stroke (its strokes are unknown), so a later pass reads it again. Never
 * throws.
 */
export async function migrateOldProblemInk(io: OldInkIO, content: ContentIndex | (() => ContentIndex), root: string): Promise<OldInkPass> {
  const out: OldInkPass = { copied: 0, pending: 0 };
  let src: InkFile;
  try {
    const path = inkPath(io.root, PROBLEMS_DOC, io.device);
    if (!(await io.adapter.exists(path))) return out;
    src = parseInkFile(await io.adapter.read(path), PROBLEMS_DOC);
  } catch (e) {
    console.error('[study] reading old problem ink failed', e);
    return { copied: 0, pending: 1 };
  }
  const groups = new Map<string, InkStroke[]>();
  for (const s of src.strokes) {
    const id = problemOfKey(s.blk);
    if (!id || io.moved.has(s.id)) continue;
    const g = groups.get(id);
    if (g) g.push(s); else groups.set(id, [s]);
  }
  const index = typeof content === 'function' ? content : () => content;
  for (const id of [...groups.keys()].sort()) {
    const r = await queued(io, async (): Promise<OldInkPass> => {
      let todo: InkStroke[] = [];
      try {
        // An open of this problem may have copied some of them since the read.
        todo = (groups.get(id) || []).filter(s => !io.moved.has(s.id));
        if (!todo.length) return { copied: 0, pending: 0 };
        const home = homeDoc(index(), id, root);
        if (home.id === PROBLEMS_DOC) return { copied: 0, pending: todo.length };
        const a = await io.adopt(home.id, todo);
        if (!a.saved) return { copied: 0, pending: todo.length };
        io.moved.add(todo.map(s => s.id));
        return { copied: a.added, pending: 0 };
      } catch (e) {
        console.error('[study] copying old problem ink failed', id, e);
        return { copied: 0, pending: todo.length };
      }
    });
    out.copied += r.copied;
    out.pending += r.pending;
  }
  return out;
}

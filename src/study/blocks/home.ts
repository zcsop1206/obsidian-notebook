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
 * copied once into the home doc's file for this device (`copyOldProblemInk`). Ids are kept, so a
 * second copy changes nothing; the old file is never edited or deleted.
 *
 * Kept out of register.ts so the unit tests can import it: register.ts pulls `obsidian` runtime
 * symbols, which the node test bundle cannot resolve.
 */
import type { ContentIndex, StudyDoc } from '../types';
import type { InkFile } from '../ink/model';
import { inkPath, parseInkFile, serializeInkFile } from '../ink/model';
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

/**
 * Which of `src`'s strokes still need copying into `home`: those under one of `keys` (this
 * device's `call:<id>`/`work:<id>` strokes) whose id `home` does not already hold. Ids are kept,
 * so applying the result a second time copies nothing.
 */
export function strokesToCopy(src: InkFile, home: InkFile, keys: readonly string[]): InkStroke[] {
  const have = new Set(home.strokes.map(s => s.id));
  return src.strokes.filter(s => typeof s.blk === 'string' && keys.indexOf(s.blk) >= 0 && !have.has(s.id));
}

/**
 * Copies this device's strokes under `call:<id>`/`work:<id>` from `ink/problems.<device>.json`
 * into `ink/<homeId>.<device>.json`, keeping ids (a second run copies nothing). The old file is
 * never edited or deleted, and the home file's own strokes, `hide` and `keep` are preserved.
 * Returns how many strokes were copied; 0 when the home doc is the `problems` fallback, the old
 * file is missing, or there is nothing new to copy. Never throws: a copy failure is logged and
 * reported as 0, so the problem still opens.
 */
export async function copyOldProblemInk(adapter: InkAdapter, root: string, device: string, homeId: string, id: string): Promise<number> {
  try {
    if (homeId === PROBLEMS_DOC) return 0;
    const srcPath = inkPath(root, PROBLEMS_DOC, device);
    if (!(await adapter.exists(srcPath))) return 0;
    const keys = problemInkKeys(id);
    const src = parseInkFile(await adapter.read(srcPath), PROBLEMS_DOC);
    if (!src.strokes.some(s => typeof s.blk === 'string' && keys.indexOf(s.blk) >= 0)) return 0;
    const homePath = inkPath(root, homeId, device);
    const home: InkFile = (await adapter.exists(homePath))
      ? parseInkFile(await adapter.read(homePath), homeId)
      : { v: 1, doc: homeId, strokes: [] };
    const moves = strokesToCopy(src, home, keys);
    if (!moves.length) return 0;
    await adapter.write(homePath, serializeInkFile(homeId, [...home.strokes, ...moves], home.hide, home.keep));
    return moves.length;
  } catch (e) {
    console.error('[study] copying old problem ink failed', e);
    return 0;
  }
}

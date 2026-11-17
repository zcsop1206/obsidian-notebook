/**
 * Anchored ink, the pure parts (SPEC.md, Storage: Ink): the ink file format, the union of every
 * device's file, stroke anchoring and placement after a rebuild, and own-device undo. No DOM and
 * no vault here, so all of it is unit-tested (test/unit/study-ink.test.ts).
 *
 * Coordinates are paper px. A page stroke carries `at = {a, dy, rev, v}`: `a` the nearest anchored
 * passage at or above the stroke's vertical centre when it was written, `dy` that passage's top
 * then, `rev` its text hash then, `v` the doc's build then. It is drawn at
 * `y + (top(a) now - dy)`, so it follows its passage wherever layout or a rewrite moves it.
 */
import { hash8 } from '../format/parse';
import type { StudyDoc } from '../types';
import type { InkStroke } from '../view/host';

export const INK_FILE_VERSION = 1;
/** Opacity of a stroke whose passage was rewritten since it was written. */
export const CHANGED_ALPHA = 0.35;
/** Paper width of a doc page and the default for block surfaces. */
export const PAPER_WIDTH = 800;
/** Uniform pen width in paper px. */
export const LINE_WIDTH = 1.6;
/** A stroke's centre may sit this far above an anchor's top and still belong to it. */
export const ANCHOR_SLOP = 2;
/** Save this long after the last change (SPEC.md). */
export const SAVE_DELAY_MS = 1000;

export type InkPoint = [number, number, number, number];

/** What one device's file holds (SPEC.md): its own strokes, plus its decisions on other devices' strokes. */
export interface InkFile {
  v: number;
  doc: string;
  strokes: InkStroke[];
  /**
   * Other devices' strokes this device deleted, as `<dev>:<id>` (a device never writes another's
   * file, so a delete of someone else's stroke is recorded here and applied to the union).
   */
  hide?: string[];
  /** Other devices' changed strokes this device kept: `<dev>:<id>` -> the passage hash kept. */
  keep?: Record<string, string>;
}

/* ------------------------------- paths ------------------------------- */

export function inkFolder(root: string): string {
  const r = root.replace(/^\/+|\/+$/g, '');
  return r ? `${r}/ink` : 'ink';
}

export function inkPath(root: string, docId: string, device: string): string {
  return `${inkFolder(root)}/${docId}.${device}.json`;
}

/**
 * The device of an ink file path for `docId`, or null when the path is not one of that doc's ink
 * files. The device is the part between the doc id and `.json` (doc ids may contain dots; device
 * names do not).
 */
export function deviceOf(path: string, root: string, docId: string): string | null {
  const prefix = `${inkFolder(root)}/${docId}.`;
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return null;
  const dev = path.slice(prefix.length, -'.json'.length);
  return dev && !dev.includes('.') && !dev.includes('/') ? dev : null;
}

/* ------------------------------- the file ------------------------------- */

function isPoint(q: unknown): q is number[] {
  return Array.isArray(q) && q.length >= 2 && typeof q[0] === 'number' && typeof q[1] === 'number' && isFinite(q[0]) && isFinite(q[1]);
}

const KNOWN = new Set(['id', 'p', 't0', 'at', 'e', 'blk', 'dev']);

/** A stroke read from a file, cleaned: bad points dropped, missing pressure and time filled. */
export function cleanStroke(s: unknown): InkStroke | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || !Array.isArray(o.p)) return null;
  const p: InkPoint[] = [];
  for (const q of o.p) if (isPoint(q)) p.push([q[0], q[1], typeof q[2] === 'number' ? q[2] : 0.5, typeof q[3] === 'number' ? q[3] : 0]);
  if (!p.length) return null;
  const out: InkStroke = { id: o.id, p, t0: typeof o.t0 === 'number' ? o.t0 : 0 };
  const at = o.at as Record<string, unknown> | undefined | null;
  if (at && typeof at === 'object' && typeof at.a === 'string') {
    out.at = { a: at.a, dy: typeof at.dy === 'number' ? at.dy : 0, rev: typeof at.rev === 'string' ? at.rev : '', v: typeof at.v === 'number' ? at.v : 0 };
  }
  if (typeof o.e === 'number') out.e = o.e;
  out.blk = typeof o.blk === 'string' ? o.blk : null;
  // Fields a caller's meta() added (provenance) are kept as they are.
  const rec = out as unknown as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN.has(k)) rec[k] = o[k];
  return out;
}

/** Parses one device's file; anything unreadable gives an empty file (never throws). */
export function parseInkFile(text: string, docId: string): InkFile {
  let j: unknown = null;
  try { j = JSON.parse(text); } catch { j = null; }
  const o = (j && typeof j === 'object' && !Array.isArray(j) ? j : {}) as Record<string, unknown>;
  const strokes: InkStroke[] = [];
  if (Array.isArray(o.strokes)) for (const s of o.strokes) { const c = cleanStroke(s); if (c) strokes.push(c); }
  const file: InkFile = { v: typeof o.v === 'number' ? o.v : INK_FILE_VERSION, doc: typeof o.doc === 'string' ? o.doc : docId, strokes };
  if (Array.isArray(o.hide)) file.hide = o.hide.filter((x): x is string => typeof x === 'string');
  if (o.keep && typeof o.keep === 'object' && !Array.isArray(o.keep)) {
    const keep: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.keep as Record<string, unknown>)) if (typeof v === 'string') keep[k] = v;
    file.keep = keep;
  }
  return file;
}

/** A point rounded as the file stores it: 0.1 px, pressure 0.01, whole ms. */
export function roundPoint(q: readonly number[]): InkPoint {
  return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, Math.round((q[2] ?? 0.5) * 100) / 100, Math.max(0, Math.round(q[3] ?? 0))];
}

/**
 * This device's file text: its own strokes (without `dev`, which the file name carries), one
 * stroke per line so a diff or a sync conflict copy is readable, plus its hides and keeps.
 */
export function serializeInkFile(docId: string, own: readonly InkStroke[], hide?: Iterable<string>, keep?: Record<string, string>): string {
  const lines = own.map(s => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (k !== 'dev' && v !== undefined) o[k] = v;
    o.p = s.p.map(q => roundPoint(q));
    if (!('blk' in o)) o.blk = null;
    return '  ' + JSON.stringify(o);
  });
  let out = `{"v": ${INK_FILE_VERSION}, "doc": ${JSON.stringify(docId)}, "strokes": [` + (lines.length ? '\n' + lines.join(',\n') + '\n' : '') + ']';
  const h = hide ? [...hide].sort() : [];
  if (h.length) out += ', "hide": ' + JSON.stringify(h);
  if (keep && Object.keys(keep).length) out += ', "keep": ' + JSON.stringify(keep);
  return out + '}\n';
}

/** `<dev>:<id>`: a stroke's key across devices (ids are random per device; two devices could collide). */
export const strokeKey = (s: InkStroke): string => `${s.dev ?? ''}:${s.id}`;

/**
 * The union every device shows: each file's strokes tagged with the file's device, minus the
 * strokes any device hid, with any device's keep applied (the passage hash a changed stroke now
 * belongs to). Duplicates (same device and id) keep the first. Sorted by t0, then key.
 */
export function unionStrokes(files: readonly { dev: string; file: InkFile }[]): InkStroke[] {
  const hidden = new Set<string>();
  const keep = new Map<string, string>();
  for (const { file } of files) {
    for (const h of file.hide ?? []) hidden.add(h);
    for (const [k, rev] of Object.entries(file.keep ?? {})) keep.set(k, rev);
  }
  const seen = new Set<string>();
  const out: InkStroke[] = [];
  for (const { dev, file } of files) {
    for (const s of file.strokes) {
      const st: InkStroke = { ...s, dev };
      const k = strokeKey(st);
      if (seen.has(k) || hidden.has(k)) continue;
      seen.add(k);
      const kept = keep.get(k);
      if (kept !== undefined && st.at) st.at = { ...st.at, rev: kept };
      out.push(st);
    }
  }
  out.sort((x, y) => (x.t0 - y.t0) || cmp(strokeKey(x), strokeKey(y)));
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------- ids ------------------------------- */

/** `s-` + 8 base36: four from the time and four random ones. */
export function newStrokeId(now = Date.now(), rnd: () => number = Math.random): string {
  const t = (Math.floor(now) % 1679616).toString(36).padStart(4, '0');
  let r = '';
  for (let i = 0; i < 4; i++) r += Math.min(35, Math.floor(rnd() * 36)).toString(36);
  return `s-${t}${r}`;
}

/* ------------------------------- anchors ------------------------------- */

/**
 * The doc's anchors and their text hashes: every passage, and every anchored list item (its hash
 * is of the item's own text, so a rewrite of one item does not dim ink on its siblings).
 * The label and thematic breaks are not anchors for ink.
 */
export function docAnchors(doc: StudyDoc): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of doc.passages) {
    if (p.kind === 'label' || p.kind === 'rule') continue;
    if (!m.has(p.anchor)) m.set(p.anchor, p.hash);
    for (const it of p.items ?? []) if (!m.has(it.anchor)) m.set(it.anchor, hash8(it.text));
  }
  return m;
}

/** A measured anchor: its top in paper px now (null when it exists but is not shown, e.g. fogged). */
export interface AnchorTop {
  a: string;
  top: number | null;
}

/** The vertical extent of a stroke's points. */
export function yExtent(p: readonly (readonly number[])[]): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const q of p) { if (q[1] < min) min = q[1]; if (q[1] > max) max = q[1]; }
  return { min, max };
}

/**
 * The anchor a new stroke belongs to: the lowest shown anchor whose top is at or above the
 * stroke's vertical centre (within ANCHOR_SLOP); when the stroke is above every anchor, the
 * topmost. Ties go to the later anchor in `tops` (a list item over the list that holds it, when
 * items are listed after their list). Null when no anchor is shown.
 */
export function nearestAnchor(p: readonly (readonly number[])[], tops: readonly AnchorTop[]): { a: string; top: number } | null {
  const { min, max } = yExtent(p);
  if (!isFinite(min)) return null;
  const cy = (min + max) / 2;
  let best: { a: string; top: number } | null = null;
  for (const t of tops) {
    if (t.top === null) continue;
    if (t.top <= cy + ANCHOR_SLOP && (best === null || t.top >= best.top)) best = { a: t.a, top: t.top };
  }
  if (best) return best;
  for (const t of tops) if (t.top !== null && (best === null || t.top < best.top)) best = { a: t.a, top: t.top };
  return best;
}

/** `at` for a new stroke, from the nearest anchor (null when no anchor is shown). */
export function anchorStroke(p: readonly (readonly number[])[], tops: readonly AnchorTop[], revs: ReadonlyMap<string, string>, build: number): NonNullable<InkStroke['at']> | null {
  const n = nearestAnchor(p, tops);
  if (!n) return null;
  return { a: n.a, dy: Math.round(n.top * 10) / 10, rev: revs.get(n.a) ?? '', v: build };
}

export type InkState = 'follow' | 'changed' | 'orphan' | 'free';

/**
 * Where a page stroke stands against the doc's current anchors: `free` without an anchor (drawn
 * where written), `orphan` when its anchor is gone, `changed` when the anchor's text hash differs
 * from the one it was written on, else `follow`.
 */
export function strokeState(s: InkStroke, revs: ReadonlyMap<string, string>): InkState {
  if (!s.at) return 'free';
  const rev = revs.get(s.at.a);
  if (rev === undefined) return 'orphan';
  return rev !== s.at.rev ? 'changed' : 'follow';
}

/**
 * The counts reanchor() reports after a new build: page strokes written on another build (`at.v`
 * differs from the doc's build) that follow their anchor unchanged, sit on rewritten text, or lost
 * their anchor. Strokes of the current build and block strokes are not counted.
 */
export function reanchorCounts(strokes: readonly InkStroke[], revs: ReadonlyMap<string, string>, build: number): { moved: number; changed: number; orphaned: number } {
  let moved = 0, changed = 0, orphaned = 0;
  for (const s of strokes) {
    if (s.blk || !s.at || s.at.v === build) continue;
    const st = strokeState(s, revs);
    if (st === 'follow') moved++;
    else if (st === 'changed') changed++;
    else if (st === 'orphan') orphaned++;
  }
  return { moved, changed, orphaned };
}

/** Where a page stroke is drawn: an offset added to its points' y and an opacity. */
export interface Placement {
  dy: number;
  alpha: number;
}

/**
 * The placement of a page stroke: by its anchor's top now (35% opacity when the text changed);
 * an orphan by its group's space in the orphan strip (`orphanTop`: the space's top and the
 * group's highest point, so the group's ink starts at the top of its space); null (not drawn)
 * for a stroke whose anchor exists but is not shown (a fogged proof, a collapsed block).
 */
export function placeStroke(
  s: InkStroke,
  revs: ReadonlyMap<string, string>,
  topOf: (a: string) => number | null,
  orphanTop: (a: string) => { top: number; minY: number } | null,
): Placement | null {
  const st = strokeState(s, revs);
  if (st === 'free' || !s.at) return { dy: 0, alpha: 1 };
  if (st === 'orphan') {
    const g = orphanTop(s.at.a);
    return g ? { dy: g.top - g.minY, alpha: 1 } : null;
  }
  const top = topOf(s.at.a);
  if (top === null) return null;
  return { dy: top - s.at.dy, alpha: st === 'changed' ? CHANGED_ALPHA : 1 };
}

export interface OrphanGroup {
  a: string;
  strokes: InkStroke[];
  minY: number;
  maxY: number;
}

/** Orphaned page strokes grouped by their old anchor, in order of first appearance, with each group's y extent. */
export function orphanGroups(strokes: readonly InkStroke[], revs: ReadonlyMap<string, string>): OrphanGroup[] {
  const groups = new Map<string, OrphanGroup>();
  for (const s of strokes) {
    if (s.blk || !s.at || strokeState(s, revs) !== 'orphan') continue;
    let g = groups.get(s.at.a);
    if (!g) { g = { a: s.at.a, strokes: [], minY: Infinity, maxY: -Infinity }; groups.set(s.at.a, g); }
    g.strokes.push(s);
    const e = yExtent(s.p);
    g.minY = Math.min(g.minY, e.min);
    g.maxY = Math.max(g.maxY, e.max);
  }
  return [...groups.values()];
}

/** Changed page strokes per anchor (for the keep / delete chips). */
export function changedByAnchor(strokes: readonly InkStroke[], revs: ReadonlyMap<string, string>): Map<string, InkStroke[]> {
  const m = new Map<string, InkStroke[]>();
  for (const s of strokes) {
    if (s.blk || !s.at || strokeState(s, revs) !== 'changed') continue;
    const l = m.get(s.at.a);
    if (l) l.push(s); else m.set(s.at.a, [s]);
  }
  return m;
}

/* ------------------------------- own-device edits ------------------------------- */

/**
 * The index of this device's latest stroke in `blk` (null = page ink), or -1. Undo removes only
 * that one: another device's strokes are never undone here.
 */
export function lastOwnIndex(strokes: readonly InkStroke[], device: string, blk: string | null): number {
  let best = -1;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    if (s.dev !== device || (s.blk ?? null) !== blk) continue;
    if (best < 0 || s.t0 >= strokes[best].t0) best = i;
  }
  return best;
}

/**
 * Keep: a changed stroke now belongs to the new text. Own strokes take the new hash and build in
 * place; another device's go into this device's keep map (applied by unionStrokes).
 */
export function keepStroke(s: InkStroke, rev: string, build: number, device: string, keep: Record<string, string>): void {
  if (!s.at) return;
  if (s.dev === device) s.at = { ...s.at, rev, v: build };
  else { keep[strokeKey(s)] = rev; s.at = { ...s.at, rev }; }
}

/* ------------------------------- colour ------------------------------- */

/** A `--token` or `var(--token, fallback)` as the token name and fallback, else null (a plain colour). */
export function colorToken(c: string): { token: string; fallback: string | null } | null {
  const s = c.trim();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(s);
  if (m) return { token: m[1], fallback: m[2] ? m[2].trim() : null };
  if (s.startsWith('--')) return { token: s, fallback: null };
  return null;
}

/* ------------------------------- sampling ------------------------------- */

/** The parts of a PointerEvent (or one of its coalesced events) sampling reads. */
export interface InkSample {
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
}

/** From client px to paper px: the box's client rect and paper px per client px. */
export interface PaperMap {
  left: number;
  top: number;
  k: number;
  /** timeStamp of the stroke's first sample. */
  t0: number;
  mouse: boolean;
}

/** Samples closer than this to the last point are dropped (paper px), as the notebook's pen does. */
export const MIN_STEP = 0.25;

/**
 * Adds samples to a stroke's points: in paper px, rounded as the file stores them; samples older
 * than the last one taken are dropped (WebKit repeats earlier samples in later coalesced lists),
 * as are those within MIN_STEP of the last point. The mouse has pressure 0.5. Returns the new
 * last timeStamp taken.
 */
export function addSamples(points: InkPoint[], lastStamp: number, samples: readonly InkSample[], m: PaperMap): number {
  for (const s of samples) {
    if (s.timeStamp < lastStamp) continue;
    const pr = m.mouse || !(s.pressure > 0) ? 0.5 : Math.min(1, s.pressure);
    const q = roundPoint([(s.clientX - m.left) * m.k, (s.clientY - m.top) * m.k, pr, s.timeStamp - m.t0]);
    const prev = points[points.length - 1];
    if (prev && Math.hypot(q[0] - prev[0], q[1] - prev[1]) < MIN_STEP) continue;
    if (prev && q[3] < prev[3]) q[3] = prev[3];
    lastStamp = s.timeStamp;
    points.push(q);
  }
  return lastStamp;
}

/** Total path length of a stroke's points (a mouse click under 2 paper px is not a stroke). */
export function pathLength(p: readonly (readonly number[])[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
}

/** Device pixels per paper px for a canvas of `w` x `h` paper px, capped at `maxPixels` (the notebook's bitmap cap). */
export function canvasScale(wanted: number, w: number, h: number, maxPixels = 16_000_000): number {
  const area = Math.max(1, w) * Math.max(1, h);
  const cap = Math.sqrt(maxPixels / area);
  const k = Math.min(wanted, cap);
  return k > 0 && isFinite(k) ? k : 1;
}

/**
 * The band of a tall page the canvas covers (paper px): the visible part plus up to one visible
 * height either side, within the page and within the pixel budget at scale k. When the visible
 * part alone exceeds the budget, k is lowered instead.
 */
export function pageBand(H: number, visTop: number, visBottom: number, W: number, k: number, maxPixels = 16_000_000): { top: number; height: number; k: number } {
  const vt = Math.max(0, Math.min(H, visTop)), vb = Math.max(vt, Math.min(H, visBottom));
  const vis = Math.max(1, vb - vt);
  let kk = k;
  if (W * vis * kk * kk > maxPixels) kk = Math.sqrt(maxPixels / (W * vis));
  const maxH = Math.max(vis, Math.floor(maxPixels / (W * kk * kk)));
  if (H <= maxH) return { top: 0, height: Math.max(1, H), k: kk };
  const extra = Math.min(vis, (maxH - vis) / 2);
  let top = Math.max(0, vt - extra);
  let height = Math.min(maxH, vb + extra - top);
  if (top + height > H) { top = Math.max(0, H - height); }
  // Spend what is left of the budget below and above, in that order.
  const spare = maxH - height;
  if (spare > 0) { const down = Math.min(spare, H - (top + height)); height += down; const up = Math.min(spare - down, top); top -= up; height += up; }
  return { top: Math.floor(top), height: Math.max(1, Math.ceil(height)), k: kk };
}

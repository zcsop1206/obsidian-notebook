/**
 * The study view's pure helpers (no DOM, no Obsidian): names and grouping for the library, link
 * targets, anchored list items, what a peek may show, and a doc's render signature. Owned by S3.
 */
import { resolveLink } from '../format/parse';
import type { ContentIndex, DocKind, Passage, StudyDoc } from '../types';

/** Rating areas, FORMAT.md's table. */
export const AREA_NAMES: Record<string, string> = {
  nt: 'Number theory and algebra',
  comb: 'Combinatorics and probability',
  an: 'Analysis and inequalities',
  la: 'Linear algebra and geometry',
  gen: 'General reasoning',
  dd: 'Digital design and verification',
  ca: 'Computer architecture and accelerators',
  th: 'Heat transfer, thermodynamics and fluids',
  mc: 'Mechanics, dynamics, vibration and control',
  pd: 'Precision design and metrology',
  sp: 'Semiconductor processes, vacuum and plasma',
  op: 'Optics and photonics',
  el: 'Circuits, power electronics and batteries',
  mat: 'Materials and additive manufacturing',
  qc: 'Quantum hardware and cryogenics',
  bio: 'Neural interfaces and implants',
};

export const KIND_ORDER: DocKind[] = ['topic', 'basic', 'kata', 'card', 'bank'];
export const KIND_GROUP: Partial<Record<DocKind, string>> = { topic: 'Topics', basic: 'Basics', kata: 'Katas', card: 'Numbers cards', bank: 'Problem banks' };
export const KIND_ONE: Partial<Record<DocKind, string>> = { topic: 'Topic', basic: 'Basic', kata: 'Kata', card: 'Numbers card', bank: 'Problem bank' };

export function areaName(id: string): string {
  return AREA_NAMES[id] ?? (id === 'other' ? 'Other' : id);
}

/** A `level: hidden` kata never shows its title before a settle (FORMAT.md, Kata). */
export function isHiddenKata(doc: StudyDoc): boolean {
  return doc.kind === 'kata' && doc.kata?.level === 'hidden';
}

export function displayTitle(doc: StudyDoc): string {
  return isHiddenKata(doc) ? 'Hidden kata' : doc.title;
}

export function shortTitle(doc: StudyDoc, max = 26): string {
  const t = displayTitle(doc);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** One line under a doc's title: kind, areas, build. */
export function metaLine(doc: StudyDoc): string {
  const bits = [KIND_ONE[doc.kind] ?? 'Doc'];
  if (!isHiddenKata(doc)) for (const a of doc.areas) bits.push(areaName(a));
  bits.push(`build ${doc.build}`);
  if (doc.by === 'adit') bits.push("Adit's notes");
  return bits.join(' · ');
}

export interface LibraryGroup {
  kind: DocKind;
  label: string;
  areas: { area: string; label: string; docs: StudyDoc[] }[];
}

/** Docs grouped by kind (topics first), then by first area, each sorted by title. */
export function groupDocs(docs: Iterable<StudyDoc>): LibraryGroup[] {
  const byKind = new Map<DocKind, Map<string, StudyDoc[]>>();
  for (const d of docs) {
    if (!KIND_GROUP[d.kind]) continue;
    const area = isHiddenKata(d) ? 'other' : d.areas[0] || 'other';
    const m = byKind.get(d.kind) ?? new Map<string, StudyDoc[]>();
    byKind.set(d.kind, m);
    const list = m.get(area) ?? [];
    list.push(d);
    m.set(area, list);
  }
  const areaOrder = Object.keys(AREA_NAMES);
  const rank = (a: string) => { const i = areaOrder.indexOf(a); return i < 0 ? (a === 'other' ? 1e6 : 1e5) : i; };
  const out: LibraryGroup[] = [];
  for (const kind of KIND_ORDER) {
    const m = byKind.get(kind);
    if (!m) continue;
    const areas = [...m.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(area => ({
      area, label: areaName(area),
      docs: m.get(area)!.sort((x, y) => displayTitle(x).localeCompare(displayTitle(y)) || x.id.localeCompare(y.id)),
    }));
    out.push({ kind, label: KIND_GROUP[kind]!, areas });
  }
  return out;
}

/** What a rendered doc depends on: when this changes, the doc is rendered again. */
export function docSignature(doc: StudyDoc): string {
  return [doc.path, doc.build, doc.title, doc.kata?.level ?? '', ...doc.passages.map(p => `${p.anchor}:${p.hash}:${p.block ? p.block.type : ''}:${(p.items || []).map(i => i.anchor).join('+')}`)].join('|');
}

export interface StudyTarget { doc: string; anchor: string | null }

export function joinTo(t: StudyTarget): string { return `${t.doc}#${t.anchor ?? ''}`; }
export function splitTo(to: string): StudyTarget {
  const i = to.indexOf('#');
  if (i < 0) return { doc: to, anchor: null };
  return { doc: to.slice(0, i), anchor: to.slice(i + 1) || null };
}

const pathMaps = new WeakMap<ContentIndex, Map<string, string>>();

/** The study doc id at a vault path, or null. */
export function docAtPath(index: ContentIndex, path: string): string | null {
  let m = pathMaps.get(index);
  if (!m) {
    m = new Map();
    for (const d of index.docs.values()) m.set(d.path, d.id);
    pathMaps.set(index, m);
  }
  return m.get(path) ?? null;
}

/**
 * Where a link in `doc` goes, when it goes to a study doc: by the path resolved against the doc's
 * folder first, then by the file name (ids are unique across the study root). Null for external
 * links and links to anything else in the vault.
 */
export function studyTarget(index: ContentIndex, doc: StudyDoc, href: string): StudyTarget | null {
  const l = resolveLink(doc, '', '', href);
  if (l.external) return null;
  let id = l.toPath ? docAtPath(index, l.toPath) : null;
  if (!id && l.toDoc && index.docs.has(l.toDoc) && /\.md$/i.test(l.toPath || '') ) id = l.toDoc;
  if (!id && l.toDoc === doc.id) id = doc.id;
  return id ? { doc: id, anchor: l.toAnchor } : null;
}

/** The index of the passage holding `anchor` (a passage or an anchored list item), or -1. */
export function passageIndex(doc: StudyDoc, anchor: string): number {
  return doc.passages.findIndex(p => p.anchor === anchor || (p.items || []).some(i => i.anchor === anchor));
}

const TOP_ITEM = /^([-*+]|\d{1,9}[.)])(\s+|$)/;

/** Anchored items of a list passage -> the 0-based position of their item among the list's top-level items. */
export function itemIndexes(p: Passage): Map<string, number> {
  const out = new Map<string, number>();
  if (!p.items || p.items.length === 0) return out;
  const at = new Map<number, number>();
  let n = -1;
  p.source.split('\n').forEach((l, k) => { if (TOP_ITEM.test(l)) at.set(p.start + k, ++n); });
  for (const it of p.items) { const i = at.get(it.line); if (i !== undefined) out.set(it.anchor, i); }
  return out;
}

/** Kata code passages the kata block shows itself (S9), so the page does not repeat them. */
export function isKataOwnCode(doc: StudyDoc, p: Passage): boolean {
  return doc.kind === 'kata' && p.kind === 'code' && (p.lang === 'skeleton' || p.lang === 'vectors');
}

/** A solution callout, whatever it belongs to. Peeks and search never show one. */
export function isSolution(p: Passage): boolean {
  return p.block?.type === 'solution' || (p.kind === 'callout' && p.callout?.type === 'solution');
}

/** Blocks that show their own solution: a problem after its settle, a derive's drill and a recall card after grading. */
const SHOWS_OWN_SOLUTION = new Set<string>(['problem', 'drill', 'recall']);

/**
 * Passages that get no element on the page: a solution whose item (its block id, the passage right
 * above it) is a block that shows it, and kata-owned code. An example is not a block, so its
 * solution renders as the folded callout it is, closed until tapped; so does a solution that
 * belongs to nothing.
 */
export function isUnrendered(doc: StudyDoc, p: Passage): boolean {
  if (p.block?.type === 'solution') {
    const id = p.block.id;
    const item = doc.passages.find(q => q.anchor === id);
    return !!item?.block && SHOWS_OWN_SOLUTION.has(item.block.type);
  }
  return isKataOwnCode(doc, p);
}

const PLACEHOLDER: Record<string, string> = {
  fog: 'Proof fogged: open the doc to work it.',
  problem: 'A problem: open the doc to work it.',
  drill: 'A derive prompt: open the doc to work it.',
  recall: 'A recall card: open the doc to work it.',
  kata: 'A design kata: open the doc to work it.',
};

export interface PeekPart { markdown?: string; placeholder?: string; anchor?: string }

/**
 * What a peek of `anchor` in `doc` shows: the passage (a heading brings its section, at most four
 * passages; no anchor, the first section). Never a proof, a solution, a block's content or a
 * hidden kata's topic: those become placeholders or are left out.
 */
export function peekParts(doc: StudyDoc, anchor: string | null): PeekPart[] {
  if (isHiddenKata(doc)) return [{ placeholder: 'A hidden kata: its topic shows after you settle it.' }];
  const ps = doc.passages;
  let list: Passage[] = [];
  if (anchor) {
    const i = passageIndex(doc, anchor);
    if (i < 0) return [{ placeholder: `#${anchor} is not in build ${doc.build} of this doc.` }];
    const p = ps[i];
    const item = (p.items || []).find(it => it.anchor === anchor);
    if (item) return [{ markdown: item.text, anchor }];
    list = p.kind === 'heading' ? section(ps, i) : [p];
  } else {
    const h = ps.findIndex(p => p.kind === 'heading');
    list = h >= 0 ? section(ps, h) : ps.filter(p => p.kind !== 'label' && p.kind !== 'rule').slice(0, 1);
  }
  const out: PeekPart[] = [];
  for (const p of list) {
    // Every solution is left out, an example's too (the page shows that one folded): a peek never gives an answer away.
    if (p.kind === 'label' || p.kind === 'rule' || isSolution(p) || isUnrendered(doc, p)) continue;
    if (p.callout?.type === 'proof') { out.push({ placeholder: PLACEHOLDER.fog, anchor: p.anchor }); continue; }
    if (p.block) { out.push({ placeholder: PLACEHOLDER[p.block.type] ?? 'Open the doc to see this.', anchor: p.anchor }); continue; }
    out.push({ markdown: p.markdown, anchor: p.anchor });
  }
  return out;
}

function section(ps: Passage[], i: number): Passage[] {
  const level = ps[i].level ?? 6;
  const out = [ps[i]];
  for (let k = i + 1; k < ps.length && out.length < 4; k++) {
    if (ps[k].kind === 'heading' && (ps[k].level ?? 6) <= level) break;
    out.push(ps[k]);
  }
  return out;
}

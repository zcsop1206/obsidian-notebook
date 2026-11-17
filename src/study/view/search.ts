/**
 * Library search over titles and passage text (SPEC.md, the study view). Pure. Never indexes
 * proofs, solutions, kata code the block owns, hidden katas or bank tags (the tags files are not
 * docs in the index at all). Owned by S3.
 */
import type { ContentIndex, Passage, StudyDoc } from '../types';
import { displayTitle, isHiddenKata, isUnrendered } from './model';

export interface SearchEntry {
  doc: string;
  /** Null for the doc's title. */
  a: string | null;
  text: string;
  /** Lowercased, accents folded, TeX and markdown stripped. */
  plain: string;
  rank: number;
  order: number;
}

export interface SearchHit { doc: string; a: string | null; text: string }

const TEX: [RegExp, string][] = [
  [/\\varphi|\\phi/g, 'φ'], [/\\equiv/g, '≡'], [/\\pmod\{([^}]*)\}/g, '(mod $1)'], [/\\pmod\s*(\w+)/g, '(mod $1)'],
  [/\\bmod/g, 'mod'], [/\\gcd/g, 'gcd'], [/\\cdot(?![a-z])/g, '·'], [/\\times/g, '×'], [/\\(?:leq|le)(?![a-z])/g, '≤'],
  [/\\(?:geq|ge)(?![a-z])/g, '≥'], [/\\(?:neq|ne)(?![a-z])/g, '≠'], [/\\nmid/g, '∤'], [/\\mid/g, '|'], [/\\in(?![a-z])/g, '∈'],
  [/\\to(?![a-z])/g, '→'], [/\\(?:ldots|cdots|dots)/g, '…'], [/\\infty/g, '∞'], [/\\sum/g, 'Σ'],
  [/\\(?:operatorname|text|mathrm|mathbf|textbf|mathit|mathbb)\{([^}]*)\}/g, '$1'], [/\\[,;:! ]/g, ' '], [/\\[a-zA-Z]+/g, ''], [/[{}$]/g, ''],
];

/** Readable text of a passage's markdown: links keep their text, TeX becomes symbols, markup goes. */
export function plainText(md: string): string {
  let s = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\[!([A-Za-z][\w-]*)\][+-]?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+]|\d{1,9}[.)])\s+/gm, '')
    .replace(/[*_`|]+/g, ' ');
  for (const [re, to] of TEX) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** A passage the search may show. */
export function searchable(doc: StudyDoc, p: Passage): boolean {
  if (p.kind === 'label' || p.kind === 'rule' || isUnrendered(doc, p)) return false;
  if (p.block?.type === 'fog') return false;
  const t = p.callout?.type;
  return t !== 'proof' && t !== 'solution';
}

const cache = new WeakMap<ContentIndex, SearchEntry[]>();

export function searchEntries(index: ContentIndex): SearchEntry[] {
  const hit = cache.get(index);
  if (hit) return hit;
  const out: SearchEntry[] = [];
  let order = 0;
  for (const doc of index.docs.values()) {
    if (isHiddenKata(doc)) continue;
    const title = displayTitle(doc);
    out.push({ doc: doc.id, a: null, text: title, plain: fold(`${title} ${doc.id}`), rank: 3, order: order++ });
    for (const p of doc.passages) {
      if (!searchable(doc, p)) continue;
      const text = plainText(p.kind === 'callout' && p.callout ? [p.callout.title, p.callout.body].filter(Boolean).join(' ') : p.markdown);
      if (!text) continue;
      out.push({ doc: doc.id, a: p.anchor, text, plain: fold(text), rank: p.kind === 'heading' ? 2 : 1, order: order++ });
      for (const it of p.items || []) {
        const t = plainText(it.text);
        if (t) out.push({ doc: doc.id, a: it.anchor, text: t, plain: fold(t), rank: 1.5, order: order++ });
      }
    }
  }
  cache.set(index, out);
  return out;
}

/** Entries matching every word of `q` (accents and case ignored), best first. */
export function search(index: ContentIndex, q: string, limit = 40): SearchHit[] {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = searchEntries(index).filter(e => terms.every(t => e.plain.includes(t)));
  hits.sort((x, y) => y.rank - x.rank || x.order - y.order);
  return hits.slice(0, limit).map(e => ({ doc: e.doc, a: e.a, text: e.text }));
}

/** About 160 characters of `text` around the first match. */
export function snippet(text: string, q: string): string {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  const low = fold(text);
  let i = -1;
  for (const t of terms) { i = low.indexOf(t); if (i >= 0) break; }
  const start = Math.max(0, i - 50), end = Math.min(text.length, Math.max(0, i) + 110);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

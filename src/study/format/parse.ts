/**
 * The study/1 parser: one markdown file in, one StudyDoc out. Pure: no vault, no DOM, no Obsidian.
 * Runs in the plugin (iPad and laptop) and in node (tests, laptop scripts). FORMAT.md is the spec;
 * where this file and FORMAT.md disagree, FORMAT.md wins and this file is fixed.
 */
import { sha1Hex } from './sha1';
import type {
  BankEntry, BlockRef, Callout, CalloutType, Derive, DocKind, DocLink, Kata, KataPort, ListItemAnchor,
  MethodEntry, Passage, PassageKind, Problem, Proof, ProofStep, Recall, Solution, StudyDoc, Theorem, Track, Vectors,
} from '../types';

export const MODEL_LABEL = "> Written by a model for Adit. Not Adit's words.";

const ID_RE = '[A-Za-z0-9][A-Za-z0-9-]*';
const BLOCK_ID_TRAIL = new RegExp(`\\s\\^(${ID_RE})\\s*$`);
const BLOCK_ID_LINE = new RegExp(`^\\s*\\^(${ID_RE})\\s*$`);
const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const TOP_NUMBERED = /^(\d{1,9})[.)]\s+(.*)$/;
const TABLE = /^\s{0,3}\|/;
const QUOTE = /^\s{0,3}>/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const CALLOUT_HEAD = /^\[!([A-Za-z][\w-]*)\]([+-]?)\s*(.*)$/;
const D_IN_TITLE = /\(\s*d\s*([0-9]+(?:\.[0-9]+)?)\s*\)/i;
const LINK = /(!?)\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

const CALLOUT_ALIASES: Record<string, CalloutType> = {
  def: 'def', definition: 'def',
  thm: 'thm', theorem: 'thm', lemma: 'thm', proposition: 'thm', corollary: 'thm', identity: 'thm', law: 'thm',
  proof: 'proof', example: 'example', derive: 'derive', problem: 'problem',
  solution: 'solution', answer: 'solution', recall: 'recall', kata: 'kata', trap: 'trap',
  note: 'note', warning: 'warning',
};

const KINDS: DocKind[] = ['basic', 'topic', 'kata', 'bank', 'card', 'tracks', 'methods', 'registry'];

/* ------------------------------------------------------------------------------------------ */

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_$\\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function hash8(text: string): string {
  return sha1Hex(text.trim()).slice(0, 8);
}

/** Doc id from a vault path: the file name without `.md`. */
export function docIdFromPath(path: string): string {
  const base = path.split('/').pop() || path;
  return base.replace(/\.md$/i, '');
}

/* ---------------------------------------- frontmatter ---------------------------------------- */

export function parseFrontmatter(lines: string[]): { meta: Record<string, string | number | string[]>; bodyStart: number } {
  const meta: Record<string, string | number | string[]> = {};
  if (lines.length === 0 || lines[0].trim() !== '---') return { meta, bodyStart: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') { end = i; break; }
  }
  if (end < 0) return { meta, bodyStart: 0 };
  let listKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = meta[listKey];
      const arr = Array.isArray(cur) ? cur : [];
      arr.push(unquote(stripComment(item[1]).trim()));
      meta[listKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    const key = kv[1];
    const raw = stripComment(kv[2]).trim();
    if (raw === '') { meta[key] = []; listKey = key; continue; }
    listKey = null;
    meta[key] = scalarOrList(raw);
  }
  return { meta, bodyStart: end + 1 };
}

function stripComment(s: string): string {
  // A ` #` starts a comment unless inside quotes.
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) return s.slice(1, -1);
  return s;
}

function scalarOrList(raw: string): string | number | string[] {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(x => unquote(x.trim())).filter(x => x !== '');
  }
  const v = unquote(raw);
  if (v === raw && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return v;
}

function metaList(v: string | number | string[] | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (s === '') return [];
  return s.split(/[\s,]+/).filter(Boolean);
}

function metaNumber(v: string | number | string[] | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

/* ---------------------------------------- blocks ---------------------------------------- */

interface RawBlock {
  kind: PassageKind;
  start: number;
  end: number;
  /** An id-only line right after the block was taken as its anchor. */
  idLine: string | null;
  lang?: string;
}

function isBlank(s: string | undefined): boolean {
  return s === undefined || s.trim() === '';
}

function startsBlock(line: string): boolean {
  return HEADING.test(line) || FENCE_OPEN.test(line) || QUOTE.test(line) || TABLE.test(line)
    || line.trim().startsWith('$$') || RULE.test(line);
}

function interruptsParagraph(line: string): boolean {
  if (startsBlock(line)) return true;
  return /^\s{0,3}([-*+]|1[.)])\s+\S/.test(line);
}

/** Split the body into top-level blocks. `from` and the returned lines are file line numbers. */
export function splitBlocks(lines: string[], from: number, warnings: string[]): RawBlock[] {
  const out: RawBlock[] = [];
  let i = from;
  const n = lines.length;
  const takeIdLine = (b: RawBlock) => {
    if (b.end + 1 < n && BLOCK_ID_LINE.test(lines[b.end + 1])) { b.idLine = lines[b.end + 1]; b.end += 1; }
  };
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    if (BLOCK_ID_LINE.test(line)) {
      warnings.push(`line ${i + 1}: a block id on its own line with nothing directly above it to anchor`);
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[2];
      const lang = fence[3].trim().split(/\s+/)[0] || '';
      let j = i + 1;
      const close = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      while (j < n && !close.test(lines[j])) j++;
      if (j >= n) { warnings.push(`line ${i + 1}: code fence never closed`); j = n - 1; }
      const b: RawBlock = { kind: 'code', start: i, end: j, idLine: null, lang };
      takeIdLine(b);
      out.push(b);
      i = b.end + 1;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('$$')) {
      let j = i;
      const single = trimmed.length > 4 && trimmed.endsWith('$$');
      if (!single) {
        j = i + 1;
        while (j < n && !lines[j].trim().endsWith('$$')) j++;
        if (j >= n) { warnings.push(`line ${i + 1}: display math never closed`); j = n - 1; }
      }
      const b: RawBlock = { kind: 'math', start: i, end: j, idLine: null };
      takeIdLine(b);
      out.push(b);
      i = b.end + 1;
      continue;
    }

    if (HEADING.test(line)) { out.push({ kind: 'heading', start: i, end: i, idLine: null }); i++; continue; }
    if (RULE.test(line)) { out.push({ kind: 'rule', start: i, end: i, idLine: null }); i++; continue; }

    if (QUOTE.test(line)) {
      let j = i;
      while (j + 1 < n && QUOTE.test(lines[j + 1])) j++;
      const b: RawBlock = { kind: 'quote', start: i, end: j, idLine: null };
      takeIdLine(b);
      out.push(b);
      i = b.end + 1;
      continue;
    }

    if (TABLE.test(line)) {
      let j = i;
      while (j + 1 < n && TABLE.test(lines[j + 1])) j++;
      const b: RawBlock = { kind: 'table', start: i, end: j, idLine: null };
      takeIdLine(b);
      out.push(b);
      i = b.end + 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      let j = i;
      while (j + 1 < n) {
        const next = lines[j + 1];
        if (isBlank(next)) {
          // A blank line continues the list only if the next non-blank line is an item or indented.
          let k = j + 1;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && (LIST_ITEM.test(lines[k]) || /^\s{2,}\S/.test(lines[k])) && !BLOCK_ID_LINE.test(lines[k])) { j = k; continue; }
          break;
        }
        if (LIST_ITEM.test(next) || /^\s+\S/.test(next) || (!startsBlock(next))) { j++; continue; }
        break;
      }
      out.push({ kind: 'list', start: i, end: j, idLine: null });
      i = j + 1;
      continue;
    }

    // Paragraph: until a blank line or a line that starts another block.
    let j = i;
    while (j + 1 < n && !isBlank(lines[j + 1]) && !interruptsParagraph(lines[j + 1])) j++;
    out.push({ kind: 'paragraph', start: i, end: j, idLine: null });
    i = j + 1;
  }
  return out;
}

/* ---------------------------------------- callouts ---------------------------------------- */

function unquoteLines(src: string[]): string[] {
  return src.map(l => l.replace(/^\s{0,3}>\s?/, ''));
}

export function parseCallout(quoteLines: string[]): Callout | null {
  const lines = unquoteLines(quoteLines);
  const head = CALLOUT_HEAD.exec(lines[0].trim());
  if (!head) return null;
  const rawType = head[1].toLowerCase();
  const type: CalloutType = CALLOUT_ALIASES[rawType] || 'other';
  let title = head[3].trim();
  let d: number | null = null;
  const dm = D_IN_TITLE.exec(title);
  if (dm) { d = Number(dm[1]); title = title.replace(D_IN_TITLE, ' '); }
  const unchecked = /\bunchecked\b/i.test(title);
  if (unchecked) title = title.replace(/\bunchecked\b/ig, ' ');
  title = title.replace(/\s*[·,;:-]\s*$/, '').replace(/^\s*[·,;:-]\s*/, '').replace(/\s{2,}/g, ' ').trim();
  return { type, rawType, folded: head[2] === '-', title, d, unchecked, body: lines.slice(1).join('\n').replace(/\s+$/, '') };
}

/** Top-level numbered items of a body: proof or solution steps. */
export function parseSteps(body: string): { intro: string; steps: ProofStep[] } {
  const lines = body.split('\n');
  const steps: ProofStep[] = [];
  const intro: string[] = [];
  let cur: { n: number; lines: string[] } | null = null;
  for (const line of lines) {
    const m = TOP_NUMBERED.exec(line);
    if (m && !/^\s/.test(line)) {
      if (cur) steps.push({ n: cur.n, markdown: cur.lines.join('\n').trim() });
      cur = { n: Number(m[1]), lines: [m[2]] };
      continue;
    }
    if (cur) cur.lines.push(line.replace(/^ {1,4}/, ''));
    else intro.push(line);
  }
  if (cur) steps.push({ n: cur.n, markdown: cur.lines.join('\n').trim() });
  return { intro: intro.join('\n').trim(), steps };
}

function parseSolutionBody(body: string): { methods: string[]; markdown: string } {
  const lines = body.split('\n');
  let k = 0;
  while (k < lines.length && lines[k].trim() === '') k++;
  const m = k < lines.length ? /^methods\s*:\s*(.*)$/i.exec(lines[k].trim()) : null;
  if (!m) return { methods: [], markdown: body.trim() };
  const raw = m[1].trim();
  const methods = (raw.includes(',') ? raw.split(',') : raw.split(/\s+/)).map(x => x.trim()).filter(Boolean);
  return { methods, markdown: lines.slice(k + 1).join('\n').trim() };
}

/* ---------------------------------------- the doc ---------------------------------------- */

export function parseStudyDoc(path: string, text: string): StudyDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const warnings: string[] = [];
  const { meta, bodyStart } = parseFrontmatter(lines);
  const fileId = docIdFromPath(path);
  const kindRaw = typeof meta.study === 'string' ? meta.study : '';
  const kind: DocKind = (KINDS as string[]).includes(kindRaw) ? (kindRaw as DocKind) : 'other';
  const id = typeof meta.id === 'string' && meta.id ? meta.id : fileId;
  if (id !== fileId) warnings.push(`frontmatter id "${id}" differs from the file name "${fileId}"`);

  const doc: StudyDoc = {
    id, path, kind,
    title: typeof meta.title === 'string' ? meta.title : fileId,
    areas: metaList(meta.area),
    needs: metaList(meta.needs),
    build: metaNumber(meta.build) ?? 1,
    tracks: metaList(meta.tracks),
    by: meta.by === 'adit' ? 'adit' : 'model',
    labelled: false,
    meta,
    passages: [], links: [], theorems: [], proofs: [], derives: [], problems: [], recalls: [],
    kata: null, bank: [], bankRefs: [], warnings,
  };

  const blocks = splitBlocks(lines, bodyStart, warnings);
  const used = new Set<string>();
  const claim = (want: string, explicit: boolean, line: number): string => {
    if (!used.has(want)) { used.add(want); return want; }
    if (explicit) warnings.push(`line ${line + 1}: anchor ^${want} is used twice in this doc`);
    let k = 2;
    while (used.has(`${want}-${k}`)) k++;
    used.add(`${want}-${k}`);
    return `${want}-${k}`;
  };

  let firstContent = true;
  for (const b of blocks) {
    const srcLines = lines.slice(b.start, b.end + 1);
    const source = srcLines.join('\n');
    let bodyLines = b.idLine ? srcLines.slice(0, -1) : srcLines.slice();
    let explicitId: string | null = b.idLine ? (BLOCK_ID_LINE.exec(b.idLine) as RegExpExecArray)[1] : null;
    let kind: PassageKind = b.kind;
    let callout: Callout | undefined;
    let items: ListItemAnchor[] | undefined;
    let level: number | undefined;
    let headingText: string | undefined;

    if (kind === 'heading') {
      const h = HEADING.exec(bodyLines[0]) as RegExpExecArray;
      level = h[1].length;
      headingText = h[2];
      const trail = BLOCK_ID_TRAIL.exec(headingText);
      if (trail) {
        warnings.push(`line ${b.start + 1}: a block id on a heading is ignored; headings anchor as h-<slug>`);
        headingText = headingText.replace(BLOCK_ID_TRAIL, '').trim();
        bodyLines = [bodyLines[0].replace(BLOCK_ID_TRAIL, '')];
      }
    } else if (kind === 'quote') {
      if (firstContent && bodyLines.length === 1 && bodyLines[0].trim() === MODEL_LABEL) {
        kind = 'label';
        doc.labelled = true;
      } else {
        // A trailing id on the last quoted line anchors the callout when no id line follows it.
        const last = bodyLines[bodyLines.length - 1];
        const onlyId = /^\s{0,3}>\s*\^([A-Za-z0-9][A-Za-z0-9-]*)\s*$/.exec(last);
        if (!explicitId && onlyId) { explicitId = onlyId[1]; bodyLines = bodyLines.slice(0, -1); }
        else if (!explicitId) {
          const trail = BLOCK_ID_TRAIL.exec(last);
          if (trail) { explicitId = trail[1]; bodyLines[bodyLines.length - 1] = last.replace(BLOCK_ID_TRAIL, ''); }
        }
        const c = parseCallout(bodyLines);
        if (c) { kind = 'callout'; callout = c; }
      }
    } else if (kind === 'paragraph' || kind === 'math' || kind === 'table' || kind === 'code') {
      if (!explicitId && kind !== 'code') {
        const last = bodyLines[bodyLines.length - 1];
        const lone = BLOCK_ID_LINE.exec(last);
        if (lone && bodyLines.length > 1) { explicitId = lone[1]; bodyLines = bodyLines.slice(0, -1); }
        else {
          const trail = BLOCK_ID_TRAIL.exec(last);
          if (trail) { explicitId = trail[1]; bodyLines[bodyLines.length - 1] = last.replace(BLOCK_ID_TRAIL, ''); }
        }
      }
    } else if (kind === 'list') {
      items = [];
      // Item ids: a trailing ^id on any line of an item (usually its last line).
      let itemStart = -1;
      const itemLines: number[] = [];
      const flush = () => {
        if (itemStart < 0) return;
        for (let k = itemLines.length - 1; k >= 0; k--) {
          const li = itemLines[k];
          const rel = li - b.start;
          const l = bodyLines[rel];
          const lone = BLOCK_ID_LINE.exec(l);
          const trail = BLOCK_ID_TRAIL.exec(l);
          const found = lone ? lone[1] : trail ? trail[1] : null;
          if (found) {
            bodyLines[rel] = lone ? '' : l.replace(BLOCK_ID_TRAIL, '');
            const text = itemLines.map(x => bodyLines[x - b.start]).join('\n').replace(LIST_ITEM, '').trim();
            items!.push({ anchor: found, line: itemStart, text });
            break;
          }
        }
      };
      for (let li = b.start; li <= b.end; li++) {
        const l = lines[li];
        const m = LIST_ITEM.exec(l);
        if (m && m[1].length === 0) { flush(); itemStart = li; itemLines.length = 0; }
        if (itemStart >= 0) itemLines.push(li);
      }
      flush();
      bodyLines = bodyLines.filter((l, k) => !(l === '' && BLOCK_ID_LINE.test(srcLines[k])));
    }

    if (kind !== 'rule') firstContent = false;
    const markdown = bodyLines.join('\n').replace(/\s+$/, '');
    const hash = hash8(markdown);
    let anchor: string;
    let explicit = false;
    if (kind === 'heading') anchor = claim(`h-${slug(headingText || '') || hash}`, false, b.start);
    else if (explicitId) { anchor = claim(explicitId, true, b.start); explicit = true; }
    else anchor = claim(`p-${hash}`, false, b.start);

    const p: Passage = { anchor, explicit, kind, start: b.start, end: b.end, source, markdown, hash };
    if (level !== undefined) { p.level = level; p.text = headingText; }
    if (callout) p.callout = callout;
    if (b.lang !== undefined) p.lang = b.lang;
    if (items && items.length) {
      for (const it of items) {
        if (used.has(it.anchor)) warnings.push(`line ${it.line + 1}: anchor ^${it.anchor} is used twice in this doc`);
        else used.add(it.anchor);
      }
      p.items = items;
    }
    doc.passages.push(p);
  }

  assemble(doc, warnings, used);
  return doc;
}

/** Theorems, proofs, problems, solutions, kata parts, links: the second pass over passages. */
function assemble(doc: StudyDoc, warnings: string[], used: Set<string>): void {
  let lastThm: Theorem | null = null;
  let prev: Passage | null = null;
  const solvable = new Map<string, { kind: 'problem' | 'derive' | 'recall' | 'example'; ref: Problem | Derive | Recall | null }>();
  const kataParts: { spec: string; ports: KataPort[]; skeleton: string; vectors: Vectors | null } = { spec: '', ports: [], skeleton: '', vectors: null };

  for (const p of doc.passages) {
    const c = p.callout;
    if (p.kind === 'heading') lastThm = null;
    if (c) {
      switch (c.type) {
        case 'thm': {
          const t: Theorem = { anchor: p.anchor, title: c.title, statement: c.body, proof: null };
          if (!p.explicit) warnings.push(`line ${p.start + 1}: a theorem without a block id`);
          doc.theorems.push(t);
          lastThm = t;
          break;
        }
        case 'proof': {
          const { intro, steps } = parseSteps(c.body);
          if (!p.explicit && lastThm) {
            const want = `p-${lastThm.anchor}`;
            if (!used.has(want)) { used.delete(p.anchor); used.add(want); p.anchor = want; }
          }
          if (!lastThm) warnings.push(`line ${p.start + 1}: a proof with no theorem above it`);
          if (steps.length === 0) warnings.push(`line ${p.start + 1}: a proof with no numbered steps`);
          if (steps.length > 9) warnings.push(`line ${p.start + 1}: a proof with ${steps.length} steps (at most 9; split with a lemma)`);
          if (!c.folded) warnings.push(`line ${p.start + 1}: a proof callout that is not folded ([!proof]-)`);
          const pr: Proof = { anchor: p.anchor, of: lastThm ? lastThm.anchor : null, d: c.d, intro, steps };
          doc.proofs.push(pr);
          if (lastThm) lastThm.proof = p.anchor;
          lastThm = null;
          p.block = { type: 'fog', id: p.anchor };
          break;
        }
        case 'problem': {
          const bankId = c.body.trim() === '' && /^[a-z][a-z0-9-]*$/.test(c.title) ? c.title : null;
          if (bankId) {
            doc.bankRefs.push(bankId);
            p.block = { type: 'problem', id: bankId };
            solvable.set(p.anchor, { kind: 'problem', ref: null });
            break;
          }
          if (!p.explicit) warnings.push(`line ${p.start + 1}: a problem without a block id (its id)`);
          const pb: Problem = {
            id: p.anchor, doc: doc.id, bank: null, title: c.title, d: c.d,
            area: doc.areas[0] ?? null, statement: c.body, solution: null, methods: [], unchecked: c.unchecked,
          };
          if (pb.d === null) warnings.push(`line ${p.start + 1}: problem ${pb.id} has no (d x)`);
          doc.problems.push(pb);
          solvable.set(p.anchor, { kind: 'problem', ref: pb });
          p.block = { type: 'problem', id: pb.id };
          break;
        }
        case 'derive': {
          if (!p.explicit) warnings.push(`line ${p.start + 1}: a derive prompt without a block id`);
          const dv: Derive = { anchor: p.anchor, doc: doc.id, prompt: [c.title, c.body].filter(Boolean).join('\n'), solution: null };
          doc.derives.push(dv);
          solvable.set(p.anchor, { kind: 'derive', ref: dv });
          p.block = { type: 'drill', id: p.anchor };
          break;
        }
        case 'recall': {
          const rc: Recall = { anchor: p.anchor, doc: doc.id, prompt: [c.title, c.body].filter(Boolean).join('\n'), answer: null };
          doc.recalls.push(rc);
          solvable.set(p.anchor, { kind: 'recall', ref: rc });
          p.block = { type: 'recall', id: p.anchor };
          break;
        }
        case 'example':
          solvable.set(p.anchor, { kind: 'example', ref: null });
          break;
        case 'solution': {
          const target = prev && solvable.get(prev.anchor);
          if (!prev || !target) { warnings.push(`line ${p.start + 1}: a solution with no problem, example, derive or recall right above it`); break; }
          if (!c.folded) warnings.push(`line ${p.start + 1}: a solution callout that is not folded ([!solution]-)`);
          const { methods, markdown } = parseSolutionBody(c.body);
          const sol: Solution = { of: prev.anchor, methods, markdown, steps: parseSteps(markdown).steps };
          if (target.kind === 'problem' && target.ref) {
            const pb = target.ref as Problem;
            pb.solution = sol;
            pb.methods = methods;
            if (methods.length === 0) warnings.push(`line ${p.start + 1}: solution of ${pb.id} has no methods: line`);
          } else if (target.kind === 'derive' && target.ref) (target.ref as Derive).solution = sol;
          else if (target.kind === 'recall' && target.ref) (target.ref as Recall).answer = sol;
          p.block = { type: 'solution', id: prev.anchor } as BlockRef;
          break;
        }
        case 'kata':
          kataParts.spec = c.body;
          p.block = { type: 'kata', id: doc.id };
          break;
        default:
          break;
      }
    }
    if (p.kind === 'code' && doc.kind === 'kata') {
      const body = p.markdown.split('\n').slice(1, -1).join('\n');
      if (p.lang === 'ports') kataParts.ports = parsePorts(body, warnings);
      else if (p.lang === 'skeleton') kataParts.skeleton = body;
      else if (p.lang === 'vectors') kataParts.vectors = parseVectors(body, warnings);
    }
    collectLinks(doc, p);
    prev = p;
  }

  if (doc.kind === 'kata') {
    const lvl = String(doc.meta.level || 'simple');
    doc.kata = {
      id: doc.id, title: doc.title, area: doc.areas[0] || 'dd', needs: doc.needs,
      d: metaNumber(doc.meta.d), level: lvl === 'hard' || lvl === 'hidden' ? lvl : 'simple',
      spec: kataParts.spec, ports: kataParts.ports, skeleton: kataParts.skeleton, vectors: kataParts.vectors,
    };
    if (!kataParts.vectors) warnings.push('kata without a vectors block');
    if (kataParts.ports.length === 0) warnings.push('kata without a ports block');
  }
  if (doc.kind === 'bank' && !/\.tags\.md$/i.test(doc.path)) doc.bank = parseBankTable(doc);
}

function scanLinks(doc: StudyDoc, text: string, from: string, into: DocLink[]): void {
  LINK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK.exec(text))) {
    if (m[1] === '!') continue;
    into.push(resolveLink(doc, from, m[2], m[3]));
  }
  LINK.lastIndex = 0;
}

/** Links of a passage; a link inside an anchored list item is attributed to that item. */
function collectLinks(doc: StudyDoc, p: Passage): void {
  if (!p.items || p.items.length === 0) { scanLinks(doc, p.markdown, p.anchor, doc.links); return; }
  const fromItems: DocLink[] = [];
  for (const it of p.items) scanLinks(doc, it.text, it.anchor, fromItems);
  const all: DocLink[] = [];
  scanLinks(doc, p.markdown, p.anchor, all);
  const pending = fromItems.map(l => `${l.text}\u0000${l.href}`);
  for (const l of all) {
    const k = pending.indexOf(`${l.text}\u0000${l.href}`);
    if (k >= 0) pending.splice(k, 1);
    else fromItems.push(l);
  }
  doc.links.push(...fromItems);
}

export function resolveLink(doc: StudyDoc, from: string, text: string, href: string): DocLink {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { from, text, href, toDoc: null, toPath: null, toAnchor: null, external: true };
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { /* keep raw */ }
  const hashAt = decoded.indexOf('#');
  const pathPart = hashAt >= 0 ? decoded.slice(0, hashAt) : decoded;
  const frag = hashAt >= 0 ? decoded.slice(hashAt + 1) : '';
  const toDoc = pathPart === '' ? doc.id : docIdFromPath(pathPart);
  const toPath = pathPart === '' ? doc.path : joinPath(doc.path, pathPart);
  let toAnchor: string | null = null;
  if (frag.startsWith('^')) toAnchor = frag.slice(1);
  else if (frag) toAnchor = `h-${slug(frag)}`;
  return { from, text, href, toDoc, toPath, toAnchor, external: false };
}

/** Resolve `rel` against the folder of `fromPath`, normalising `.` and `..`. */
export function joinPath(fromPath: string, rel: string): string {
  const parts = rel.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/* ---------------------------------------- tables ---------------------------------------- */

export function parseTables(markdown: string): string[][][] {
  const tables: string[][][] = [];
  let cur: string[][] | null = null;
  for (const line of markdown.split('\n')) {
    if (TABLE.test(line)) {
      const cells = splitRow(line);
      if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue;
      if (!cur) { cur = []; tables.push(cur); }
      cur.push(cells);
    } else cur = null;
  }
  return tables;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function tableRows(markdown: string, need: string[]): Record<string, string>[] {
  for (const t of parseTables(markdown)) {
    if (t.length === 0) continue;
    const head = t[0].map(h => h.toLowerCase());
    if (!need.every(k => head.includes(k))) continue;
    return t.slice(1).map(row => {
      const r: Record<string, string> = {};
      head.forEach((h, k) => { r[h] = row[k] ?? ''; });
      return r;
    });
  }
  return [];
}

function firstHref(cell: string): string | null {
  LINK.lastIndex = 0;
  const m = LINK.exec(cell);
  LINK.lastIndex = 0;
  if (m) return m[3];
  return /^https?:\/\//.test(cell.trim()) ? cell.trim() : null;
}

function parseBankTable(doc: StudyDoc): BankEntry[] {
  const body = doc.passages.filter(p => p.kind === 'table').map(p => p.markdown).join('\n\n');
  return tableRows(body, ['id', 'source']).filter(r => r.id).map(r => ({
    id: r.id.trim(),
    source: r.source.trim(),
    d: /^\d+(\.\d+)?$/.test((r.d || '').trim()) ? Number(r.d.trim()) : null,
    statementUrl: firstHref(r.statement || ''),
    solutionUrl: firstHref(r.solutions || r.solution || ''),
    area: null,
    methods: [],
    bank: doc.id,
  }));
}

export function parseTags(markdown: string): Map<string, { area: string | null; methods: string[] }> {
  const out = new Map<string, { area: string | null; methods: string[] }>();
  for (const r of tableRows(markdown, ['id', 'area'])) {
    if (!r.id) continue;
    const m = (r.methods || '').trim();
    out.set(r.id.trim(), {
      area: (r.area || '').trim() || null,
      methods: m ? (m.includes(',') ? m.split(',') : m.split(/\s+/)).map(x => x.trim()).filter(Boolean) : [],
    });
  }
  return out;
}

export function parseTracks(markdown: string): Track[] {
  return tableRows(markdown, ['track']).filter(r => r.track).map(r => {
    const dl = (r.deadline || '').trim();
    const range = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/.exec(dl);
    const one = /^(\d{4}-\d{2}-\d{2})$/.exec(dl);
    const w = Number((r.weight || '').trim());
    return {
      id: r.track.trim(),
      deadline: range ? range[1] : one ? one[1] : null,
      until: range ? range[2] : null,
      weight: isFinite(w) && (r.weight || '').trim() !== '' ? w : 1,
      areas: (r.areas || '').split(/[\s,]+/).filter(Boolean),
      docs: (r.docs || '').trim(),
    };
  });
}

export function parseMethods(markdown: string): MethodEntry[] {
  const out: MethodEntry[] = [];
  for (const r of tableRows(markdown, ['method'])) {
    if (!r.method) continue;
    const href = firstHref(r.basic || '');
    if (!href) { out.push({ id: r.method.trim(), doc: (r.basic || '').trim(), anchor: null }); continue; }
    const hashAt = href.indexOf('#');
    const pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const frag = hashAt >= 0 ? href.slice(hashAt + 1) : '';
    out.push({ id: r.method.trim(), doc: docIdFromPath(pathPart), anchor: frag.startsWith('^') ? frag.slice(1) : null });
  }
  return out;
}

/* ---------------------------------------- kata parts ---------------------------------------- */

export function parsePorts(body: string, warnings: string[] = []): KataPort[] {
  const out: KataPort[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const m = /^(input|output)\s+(?:(?:reg|wire|logic)\s+)?(?:\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*)?([A-Za-z_][\w]*)\s*[;,]?$/.exec(line);
    if (!m) { warnings.push(`ports: cannot read "${line}"`); continue; }
    const width = m[2] !== undefined ? Math.abs(Number(m[2]) - Number(m[3])) + 1 : 1;
    out.push({ dir: m[1] as 'input' | 'output', name: m[4], width });
  }
  return out;
}

export function parseVectors(body: string, warnings: string[] = []): Vectors | null {
  const rows: Vectors['rows'] = [];
  let inputs: string[] | null = null;
  let outputs: string[] = [];
  const lines = body.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k].trim();
    if (!line || line.startsWith('#')) continue;
    const bar = line.indexOf('|');
    if (bar < 0) { warnings.push(`vectors line ${k + 1}: no "|"`); continue; }
    const left = line.slice(0, bar).trim().split(/\s+/).filter(Boolean);
    const right = line.slice(bar + 1).trim().split(/\s+/).filter(Boolean);
    if (!inputs) { inputs = left; outputs = right; continue; }
    if (left.length !== inputs.length || right.length !== outputs.length) {
      warnings.push(`vectors line ${k + 1}: expected ${inputs.length} inputs and ${outputs.length} outputs`);
      continue;
    }
    const val = (v: string): string | null => {
      if (/^x+$/i.test(v)) return null;
      if (!/^[0-9a-f]+$/i.test(v)) { warnings.push(`vectors line ${k + 1}: "${v}" is not hexadecimal`); return null; }
      return v.toLowerCase();
    };
    rows.push({ line: k + 1, inputs: left.map(val), outputs: right.map(val) });
  }
  if (!inputs) return null;
  return { inputs, outputs, rows };
}

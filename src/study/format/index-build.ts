/**
 * The content index: every study doc in the study folder, parsed and cross-linked. Pure; the
 * caller reads the files (vault in the plugin, fs in node) and passes `{path, text}` pairs.
 */
import type { BankEntry, ContentIndex, MethodEntry, Passage, Problem, StudyDoc, Track } from '../types';
import { parseMethods, parseStudyDoc, parseTags, parseTracks } from './parse';

export interface SourceFile {
  /** Vault path, e.g. `study/basics/nt-units.md`. */
  path: string;
  text: string;
}

export function buildIndex(files: SourceFile[]): ContentIndex {
  const docs = new Map<string, StudyDoc>();
  const warnings: string[] = [];
  const tags = new Map<string, { area: string | null; methods: string[] }>();
  let tracks: Track[] = [];
  const methods = new Map<string, MethodEntry>();

  for (const f of files) {
    if (!/\.md$/i.test(f.path)) continue;
    const doc = parseStudyDoc(f.path, f.text);
    if (/\.tags\.md$/i.test(f.path)) {
      // A bank's tags file: read its table whatever its frontmatter says.
      const body = doc.passages.filter(p => p.kind === 'table').map(p => p.markdown).join('\n\n');
      for (const [id, t] of parseTags(body)) tags.set(id, t);
      continue;
    }
    if (doc.kind === 'other') continue;
    for (const w of doc.warnings) warnings.push(`${f.path}: ${w}`);
    if (doc.kind === 'tracks') { tracks = parseTracks(doc.passages.map(p => p.markdown).join('\n\n')); continue; }
    if (doc.kind === 'methods') {
      for (const m of parseMethods(doc.passages.map(p => p.markdown).join('\n\n'))) methods.set(m.id, m);
      continue;
    }
    if (doc.kind === 'registry') continue;
    if (docs.has(doc.id)) { warnings.push(`${f.path}: doc id "${doc.id}" also used by ${docs.get(doc.id)!.path}`); continue; }
    docs.set(doc.id, doc);
  }

  const bank = new Map<string, BankEntry>();
  for (const d of docs.values()) {
    for (const b of d.bank) {
      const t = tags.get(b.id);
      if (t) { b.area = t.area; b.methods = t.methods; }
      if (bank.has(b.id)) warnings.push(`${d.path}: bank id "${b.id}" listed twice`);
      bank.set(b.id, b);
    }
  }

  const problems = new Map<string, Problem>();
  for (const d of docs.values()) {
    for (const p of d.problems) {
      if (problems.has(p.id)) warnings.push(`${d.path}: problem id "${p.id}" also used in ${problems.get(p.id)!.doc}`);
      else problems.set(p.id, p);
    }
  }
  for (const b of bank.values()) {
    if (problems.has(b.id)) continue;
    problems.set(b.id, {
      id: b.id, doc: b.bank, bank: b, title: b.source, d: b.d, area: b.area,
      statement: '', solution: null, methods: b.methods, unchecked: false,
    });
  }
  for (const d of docs.values()) {
    for (const ref of d.bankRefs) {
      const p = problems.get(ref);
      if (!p || !p.bank) warnings.push(`${d.path}: bank problem "${ref}" is not in any bank file`);
    }
  }

  const katas = new Map<string, NonNullable<StudyDoc['kata']>>();
  for (const d of docs.values()) if (d.kata) katas.set(d.kata.id, d.kata);

  const anchors = new Map<string, Map<string, Passage>>();
  for (const d of docs.values()) {
    const m = new Map<string, Passage>();
    for (const p of d.passages) {
      m.set(p.anchor, p);
      for (const it of p.items || []) if (!m.has(it.anchor)) m.set(it.anchor, p);
    }
    anchors.set(d.id, m);
  }

  const usedBy = new Map<string, string[]>();
  for (const d of docs.values()) {
    for (const need of d.needs) {
      if (!docs.has(need)) warnings.push(`${d.path}: needs "${need}", which is not in the study folder`);
      const arr = usedBy.get(need) || [];
      arr.push(d.id);
      usedBy.set(need, arr);
    }
  }

  for (const d of docs.values()) {
    for (const l of d.links) {
      if (l.external || !l.toDoc) continue;
      const target = anchors.get(l.toDoc);
      if (!target) {
        // Links to non-study files (images, project pages) are fine; only flag study-looking ids.
        if (/^[a-z][a-z0-9-]*$/.test(l.toDoc)) warnings.push(`${d.path}: link "${l.href}" points to a doc that is not in the study folder`);
        continue;
      }
      if (l.toAnchor && !target.has(l.toAnchor)) warnings.push(`${d.path}: link "${l.href}" points to a missing anchor ^${l.toAnchor}`);
    }
  }

  for (const m of methods.values()) {
    if (!docs.has(m.doc)) warnings.push(`methods.md: method "${m.id}" links "${m.doc}", which is not in the study folder`);
    else if (m.anchor && !anchors.get(m.doc)!.has(m.anchor)) warnings.push(`methods.md: method "${m.id}" links a missing anchor ^${m.anchor} in ${m.doc}`);
  }

  return { docs, usedBy, anchors, problems, katas, bank, tracks, methods, warnings };
}

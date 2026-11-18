// study-scan: what the iPad asked for, read on the laptop (docs/study/SPEC.md, Laptop side; ticket S10).
//
//   node scripts/study-scan.mjs <study root> [--since=YYYY-MM-DD] [--json] [--lint] [--figures]
//
// <study root> is the study folder in the vault (in the portfolio: content/study). The script reads
// every log/*.jsonl and every doc under it, and reports:
//   - pending rebuild and rewrite requests (a request is answered once the doc's `build` is higher
//     than the build it was made on), each with the passage's source and the attempt ink it had;
//   - lost marks still in their scaffold (no request yet: the plugin's ration decides when);
//   - settles and drills since --since (default: 7 days ago);
//   - with --lint, a lint of the content in three levels, error, warning and info (the rules are listed
//     above lint() below), and exit code 1 when it finds an error;
//   - with --figures, the images under the root that no doc embeds.
// It never writes anything. /teach reads its --json output. The parser and the track matcher are the
// plugin's own (src/study/format, src/study/engine/state.ts), bundled on the fly with esbuild, so the
// laptop and the iPad read docs alike.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

function loadLib() {
  const require = createRequire(import.meta.url);
  const esbuild = require('esbuild');
  const out = path.join(HERE, '.cache', 'study-lib.cjs');
  mkdirSync(path.dirname(out), { recursive: true });
  const contents = [
    "export { buildIndex } from './src/study/format/index-build';",
    "export { parseFrontmatter } from './src/study/format/parse';",
    "export { StudyState, trackDocsMatch } from './src/study/engine/state';",
  ].join('\n');
  const r = esbuild.buildSync({
    stdin: { contents, resolveDir: REPO, loader: 'ts', sourcefile: 'study-lib.ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', write: false, logLevel: 'error',
  });
  writeFileSync(out, r.outputFiles[0].text);
  return require(out);
}

export function readStudy(root) {
  const files = [];
  const logs = [];
  (function walk(dir, rel) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) {
        if (name === 'ink' || name.startsWith('.')) continue;
        walk(full, r);
      } else if (name.endsWith('.md')) files.push({ path: `study/${r}`, text: readFileSync(full, 'utf8') });
      else if (r.startsWith('log/') && name.endsWith('.jsonl')) logs.push({ file: r, text: readFileSync(full, 'utf8') });
    }
  })(root, '');
  const events = [];
  let skipped = 0;
  const seen = new Set();
  for (const l of logs) {
    for (const line of l.text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e || typeof e.id !== 'string' || typeof e.type !== 'string' || seen.has(e.id)) continue;
        seen.add(e.id);
        events.push(e);
      } catch { skipped++; }
    }
  }
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { files, events, skipped, logFiles: logs.map((l) => l.file) };
}

export function scan(index, events, since) {
  const docBuild = (id) => (index.docs.get(id) ? index.docs.get(id).build : null);
  const passage = (doc, a) => {
    const m = index.anchors.get(doc);
    return m && m.get(a) ? m.get(a).source : null;
  };
  const attempts = new Map(); // doc#a -> strokes
  for (const e of events) if (e.type === 'attempt') attempts.set(`${e.doc}#${e.a}`, e.strokes);

  const requests = [];
  for (const e of events) {
    if (e.type !== 'rewrite-request' && e.type !== 'rebuild-request') continue;
    const now = docBuild(e.doc);
    const answered = now !== null && now > e.build;
    if (answered) continue;
    // A later request on the same doc and anchor supersedes an earlier one.
    const key = `${e.type}:${e.doc}#${e.a}`;
    const i = requests.findIndex((r) => r.key === key);
    if (i >= 0) requests.splice(i, 1);
    requests.push({
      key, kind: e.type === 'rebuild-request' ? 'rebuild' : 'rewrite', doc: e.doc, anchor: e.a, t: e.t, dev: e.dev,
      buildRequested: e.build, buildNow: now, missingDoc: now === null,
      passage: passage(e.doc, e.a), attemptStrokes: attempts.get(`${e.doc}#${e.a}`) || 0,
      kindOfDoc: index.docs.get(e.doc) ? index.docs.get(e.doc).kind : null,
      needs: index.docs.get(e.doc) ? index.docs.get(e.doc).needs : [],
    });
  }

  // Marks: the latest verb per doc#anchor; lost marks without a pending request are in their scaffold.
  const marks = new Map();
  for (const e of events) if (e.type === 'mark') marks.set(`${e.doc}#${e.a}`, e);
  const requested = new Set(requests.map((r) => `${r.doc}#${r.anchor}`));
  const scaffold = [];
  for (const [k, e] of marks) {
    if (e.verb !== 'lost' || requested.has(k)) continue;
    const now = docBuild(e.doc);
    if (now !== null && now > e.build) continue; // the passage was rewritten since the mark
    scaffold.push({ doc: e.doc, anchor: e.a, t: e.t, attemptStrokes: attempts.get(k) || 0 });
  }

  const settles = events.filter((e) => e.type === 'settle' && e.t.slice(0, 10) >= since)
    .map((e) => ({ t: e.t, item: e.item, verdict: e.verdict, help: e.help, hidden: e.hidden, hook: e.hook, called: e.called, used: e.used, min: Math.round((e.ms || 0) / 60000) }));
  const calls = new Map();
  for (const e of events) if (e.type === 'call') calls.set(e.item, e);
  for (const s of settles) { const c = calls.get(s.item); if (c) s.conf = c.conf; }
  const drills = events.filter((e) => e.type === 'drill' && e.t.slice(0, 10) >= since)
    .map((e) => ({ t: e.t, doc: e.doc, item: e.item, grade: e.grade, src: e.src }));
  const katas = events.filter((e) => e.type === 'kata' && e.t.slice(0, 10) >= since)
    .map((e) => ({ t: e.t, kata: e.kata, pass: e.pass, runs: e.runs, gaveUp: e.gaveUp }));
  return { requests, scaffold, settles, drills, katas };
}

/* ---------------------------------------------------------------------- lint (FORMAT.md) */

// The lint's rules, by level. Each finding is { rule, doc, line, message }: doc is the file's path under
// the study root, line its 1-based line in the file, or null where it is not known.
//   error    embed-missing        an embed names no file in the vault, by bare file name (URL-decoded)
//            embed-ambiguous      the bare name names more than one file in the vault
//            embed-form           the href holds a slash or `..`, or the embed is a wikilink ![[...]]
//            svg-size             an embedded SVG's root <svg> lacks an absolute width or height
//            solution-orphan      a solution with no problem, example, derive or recall right above it
//            solution-unfolded    a solution callout that is not folded ([!solution]-)
//   warning  hidden-value         a `hidden` frontmatter key other than exactly `hidden: never`
//            track-bank-areas     a tracks row whose docs column serves a bank with problem areas it does
//                                 not reach, so Today picks those problems only through another track
//            parser               the parser's other warnings
//   info     solution-figure-only a problem whose solution embeds a figure while its statement has none
// The vault is the nearest folder at or above the study root that holds `.obsidian`, else the root.

const IMAGE = /\.(svg|png|jpe?g|gif|webp|bmp|avif)$/i;
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const MD_EMBED = /!\[((?:[^\]\\]|\\.)*)\]\(\s*(?:<([^>\n]*)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const WIKI_EMBED = /!\[\[([^\]\n]+)\]\]/g;
const QUOTE_MARK = /^\s{0,3}>\s?/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
// The parser's own words for the two solution errors (src/study/format/parse.ts, assemble).
const SOLUTION_ORPHAN = /^a solution with no problem, example, derive or recall right above it$/;
const SOLUTION_UNFOLDED = /^a solution callout that is not folded/;
const ABSOLUTE_SIZE = /^\s*(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*(px|pt|pc|mm|cm|in|q)?\s*$/i;

function splitLines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** A line with its code spans blanked out (same length), so an embed shown as code is not an embed. */
function blankCodeSpans(s) {
  const runs = [...s.matchAll(/`+/g)].map((m) => ({ at: m.index, n: m[0].length }));
  let out = s;
  for (let i = 0; i < runs.length; i++) {
    const j = runs.findIndex((r, k) => k > i && r.n === runs[i].n);
    if (j < 0) continue;
    const a = runs[i].at, b = runs[j].at + runs[j].n;
    out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
    i = j;
  }
  return out;
}

/**
 * Embeds in markdown text, in callouts too, but not in code fences or code spans (nor the frontmatter):
 * `{ wiki: false, alt, href, line }` for ![alt](href), `{ wiki: true, target, line }` for ![[target]].
 */
export function findEmbeds(text, { frontmatter = true } = {}) {
  const lines = splitLines(text);
  const out = [];
  let i = 0;
  if (frontmatter && lines[0].trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && (l.trim() === '---' || l.trim() === '...'));
    if (end > 0) i = end + 1;
  }
  let fence = null; // { depth, close }: a fence opened inside `depth` quote levels
  for (; i < lines.length; i++) {
    let s = lines[i];
    if (fence) {
      let inside = true;
      for (let k = 0; k < fence.depth && inside; k++) {
        const q = QUOTE_MARK.exec(s);
        if (q) s = s.slice(q[0].length); else inside = false;
      }
      if (inside) { if (fence.close.test(s)) fence = null; continue; }
      fence = null; // the callout around the fence ended, and this line is outside both
      s = lines[i];
    }
    let depth = 0, q;
    while ((q = QUOTE_MARK.exec(s))) { s = s.slice(q[0].length); depth++; }
    const f = FENCE_OPEN.exec(s);
    if (f) {
      fence = { depth, close: new RegExp(`^\\s{0,3}${f[1][0] === '`' ? '`' : '~'}{${f[1].length},}\\s*$`) };
      continue;
    }
    const t = blankCodeSpans(s);
    for (const m of t.matchAll(WIKI_EMBED)) out.push({ wiki: true, target: m[1], line: i + 1 });
    for (const m of t.matchAll(MD_EMBED)) out.push({ wiki: false, alt: m[1], href: m[2] !== undefined ? m[2] : m[3], line: i + 1 });
  }
  return out;
}

/** What an embed names: its target (URL-decoded, without `#...`) and bare file name; null for an external URL. */
function embedTarget(e) {
  let raw = e.wiki ? e.target.split('|')[0] : e.href;
  if (!e.wiki && EXTERNAL.test(raw)) return null;
  if (!e.wiki) { try { raw = decodeURIComponent(raw); } catch { /* keep it as written */ } }
  const hash = raw.indexOf('#');
  const target = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  if (!target) return null;
  return { target, name: target.split(/[\\/]/).pop(), pathForm: /[\\/]/.test(target) || target.includes('..') };
}

/** An embed of an image (a figure), by its target's extension, external or not. */
function isFigure(e) {
  return IMAGE.test((e.wiki ? e.target.split('|')[0] : e.href).replace(/[?#].*$/, ''));
}

/** The vault the study root sits in: the nearest folder at or above it that holds `.obsidian`, else the root. */
export function findVaultRoot(root) {
  const start = path.resolve(root);
  for (let dir = start; ; dir = path.dirname(dir)) {
    const cfg = path.join(dir, '.obsidian');
    if (existsSync(cfg) && statSync(cfg).isDirectory()) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

/** Every file in the vault, by bare name. Obsidian does not see dot-folders (.obsidian, .git, .trash); node_modules is skipped too. */
function vaultFiles(vault) {
  const byName = new Map();
  (function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.') && ent.name !== 'node_modules') walk(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        const list = byName.get(ent.name) || [];
        list.push(path.join(dir, ent.name));
        byName.set(ent.name, list);
      }
    }
  })(vault);
  return byName;
}

/** Why an SVG's root element does not size itself (absolute width and height), or null when it does. */
export function svgSizeProblem(text) {
  const m = /<([A-Za-z_][\w:.-]*)([^>]*)>/.exec(text.replace(/<!--[\s\S]*?-->/g, ''));
  if (!m || m[1].replace(/^.*:/, '') !== 'svg') return 'the file has no root <svg> element';
  const attrs = {};
  for (const a of m[2].matchAll(/(?:^|\s)([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
  const bad = [];
  for (const k of ['width', 'height']) {
    const v = attrs[k];
    if (v === undefined) bad.push(`no ${k}`);
    else if (!ABSOLUTE_SIZE.test(v) || !(parseFloat(v) > 0)) bad.push(`${k} "${v}", which is not an absolute size`);
  }
  return bad.length ? `the root <svg> has ${bad.join(' and ')} (give both in px or another absolute unit)` : null;
}

/** The 1-based line of a frontmatter key, or null. */
function frontmatterLine(text, key) {
  const lines = splitLines(text);
  if (lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') break;
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(lines[i]);
    if (m && m[1] === key) return i + 1;
  }
  return null;
}

/** The 1-based line of a track's row in tracks.md (its `track` cell), or null. */
function trackRowLine(text, id) {
  const lines = splitLines(text);
  let col = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s{0,3}\|/.test(lines[i])) { col = -1; continue; }
    const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
    if (col < 0) { col = cells.findIndex((c) => c.toLowerCase() === 'track'); continue; }
    if (cells[col] === id) return i + 1;
  }
  return null;
}

function compareFindings(a, b) {
  const da = a.doc || '', db = b.doc || '';
  if (da !== db) return da < db ? -1 : 1;
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

/**
 * The lint (its rules are listed above). `files` are readStudy's markdown files, `index` the parser's
 * index of them and `lib` the bundled plugin code. Returns { vault, errors, warnings, info }.
 */
export function lint({ root, files, index, lib }) {
  const errors = [], warnings = [], info = [];
  const underRoot = (p) => p.replace(/^study\//, '');
  const vault = findVaultRoot(root);
  const byName = vaultFiles(vault);
  const byLower = new Map();
  for (const n of byName.keys()) byLower.set(n.toLowerCase(), [...(byLower.get(n.toLowerCase()) || []), n]);
  const inVault = (full) => path.relative(vault, full).split(path.sep).join('/');

  // Embeds, in every markdown file under the root. Each embedded SVG is checked once, at its first embed.
  const svgChecked = new Set();
  for (const f of files) {
    const doc = underRoot(f.path);
    for (const e of findEmbeds(f.text)) {
      const t = embedTarget(e);
      if (e.wiki) {
        errors.push({ rule: 'embed-form', doc, line: e.line, message: `\`![[${e.target}]]\` is a wikilink embed: write \`![alt](${t ? t.name : e.target})\`` });
        continue;
      }
      if (!t) continue;
      if (t.pathForm) errors.push({ rule: 'embed-form', doc, line: e.line, message: `\`![${e.alt}](${e.href})\` names a path: embed the file by its bare name, \`![${e.alt}](${t.name})\`` });
      let hits = byName.get(t.name);
      if (!hits && !path.extname(t.name)) hits = byName.get(`${t.name}.md`);
      if (!hits) {
        const near = byLower.get(t.name.toLowerCase());
        errors.push({ rule: 'embed-missing', doc, line: e.line, message: `no file named "${t.name}" in the vault${near ? ` ("${near[0]}" differs only in case)` : ''}` });
      } else if (hits.length > 1) {
        errors.push({ rule: 'embed-ambiguous', doc, line: e.line, message: `"${t.name}" names ${hits.length} files in the vault: ${hits.map(inVault).sort().join(', ')}` });
      } else if (/\.svg$/i.test(t.name) && !svgChecked.has(hits[0])) {
        svgChecked.add(hits[0]);
        let why;
        try { why = svgSizeProblem(readFileSync(hits[0], 'utf8')); } catch { why = 'the file cannot be read'; }
        if (why) errors.push({ rule: 'svg-size', doc, line: e.line, message: `${inVault(hits[0])}: ${why}` });
      }
    }
  }

  // The parser's warnings: a detached or unfolded solution is an error, the rest stay warnings.
  for (const w of index.warnings) {
    const m = /^(.*?\.md): (.*)$/i.exec(w);
    let message = m ? m[2] : w;
    const lm = /^line (\d+): (.*)$/.exec(message);
    if (lm) message = lm[2];
    const rule = SOLUTION_ORPHAN.test(message) ? 'solution-orphan' : SOLUTION_UNFOLDED.test(message) ? 'solution-unfolded' : 'parser';
    (rule === 'parser' ? warnings : errors).push({ rule, doc: m ? underRoot(m[1]) : null, line: lm ? Number(lm[1]) : null, message });
  }

  // hidden: the engine reads exactly `hidden: never` (StudyState.hiddenOK), per file.
  const textOf = new Map(files.map((f) => [f.path, f.text]));
  for (const d of index.docs.values()) {
    for (const [k, v] of Object.entries(d.meta)) {
      if (k.toLowerCase() !== 'hidden' || (k === 'hidden' && v === 'never')) continue;
      const shown = Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
      warnings.push({
        rule: 'hidden-value', doc: underRoot(d.path), line: frontmatterLine(textOf.get(d.path) || '', k),
        message: `"${k}: ${shown}" has no effect: only "hidden: never", spelled exactly, keeps this file's problems out of hidden-topic picks`,
      });
    }
  }

  // Tracks: a bank the docs column serves adds no areas of its own (as in StudyState.problemAreas).
  const tracksFile = files.filter((f) => !/\.tags\.md$/i.test(f.path) && lib.parseFrontmatter(splitLines(f.text)).meta.study === 'tracks').pop();
  const state = new lib.StudyState(index, []);
  for (const t of index.tracks) {
    if (t.weight === 0) continue; // the engine ignores the row
    const served = [...index.docs.values()].filter((d) => d.kind !== 'kata' && state.trackMatches(t, d));
    const reach = new Set(t.areas);
    for (const d of served) for (const a of d.areas) reach.add(a);
    for (const b of served) {
      if (b.kind !== 'bank' || !lib.trackDocsMatch(t, b)) continue;
      const missed = new Map();
      for (const e of b.bank) if (e.area && !reach.has(e.area)) missed.set(e.area, (missed.get(e.area) || 0) + 1);
      if (!missed.size) continue;
      const areas = [...missed.keys()].sort();
      const n = [...missed.values()].reduce((x, y) => x + y, 0);
      warnings.push({
        rule: 'track-bank-areas', doc: tracksFile ? underRoot(tracksFile.path) : null, line: tracksFile ? trackRowLine(tracksFile.text, t.id) : null,
        message: `track "${t.id}" serves the bank ${b.id} through its docs column, but not the areas of ${n} of its problems (${areas.join(', ')}): a bank adds no areas of its own, so Today picks them only through another track; add ${areas.join(', ')} to the row's areas column`,
      });
    }
  }

  // A figure only in a problem's solution: listed so a writer checks the statement does not need one.
  for (const d of index.docs.values()) {
    for (const p of d.problems) {
      if (!p.solution) continue;
      const inSolution = findEmbeds(p.solution.markdown, { frontmatter: false }).filter(isFigure);
      if (!inSolution.length || findEmbeds(p.statement, { frontmatter: false }).some(isFigure)) continue;
      const at = index.anchors.get(d.id)?.get(p.id);
      const names = inSolution.map((e) => (e.wiki ? e.target.split('|')[0] : e.href));
      info.push({
        rule: 'solution-figure-only', doc: underRoot(d.path), line: at ? at.start + 1 : null,
        message: `problem ${p.id}: its solution embeds a figure (${names.join(', ')}) but its statement embeds none`,
      });
    }
  }

  for (const list of [errors, warnings, info]) list.sort(compareFindings);
  return { vault, errors, warnings, info };
}

/** Images under the study root that no markdown file under it embeds, by bare name (paths under the root). */
export function unusedFigures(root, files) {
  const used = new Set();
  for (const f of files) for (const e of findEmbeds(f.text)) { const t = embedTarget(e); if (t) used.add(t.name); }
  const out = [];
  (function walk(dir, rel) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (ent.name !== 'ink' && !ent.name.startsWith('.')) walk(path.join(dir, ent.name), r); }
      else if (IMAGE.test(ent.name) && !used.has(ent.name)) out.push(r);
    }
  })(root, '');
  return out.sort();
}

function fmtLint(l) {
  const out = ['## Lint', '', `${l.errors.length} error(s), ${l.warnings.length} warning(s), ${l.info.length} info. Vault: ${l.vault}`];
  for (const [title, items] of [['Errors', l.errors], ['Warnings', l.warnings], ['Info', l.info]]) {
    out.push('', `### ${title} (${items.length})`, '');
    out.push(items.length ? items.map((x) => `- ${x.doc || '-'}${x.line != null ? `:${x.line}` : ''} ${x.rule}: ${x.message}`).join('\n') : 'None.');
  }
  return out.join('\n');
}

function fmt(r, meta) {
  const out = [];
  out.push(`# Study scan`);
  out.push('');
  out.push(`${meta.docs} docs, ${meta.events} events from ${meta.logFiles.length} log file(s)${meta.skipped ? `, ${meta.skipped} unreadable line(s) skipped` : ''}. Since ${meta.since}.`);
  out.push('');
  out.push(`## Pending requests (${r.requests.length})`);
  out.push('');
  if (!r.requests.length) { out.push('None.'); out.push(''); }
  for (const q of r.requests) {
    out.push(`### ${q.kind} ${q.doc}#${q.anchor} (${q.t.slice(0, 16)}, ${q.dev})`);
    out.push('');
    out.push(`Requested on build ${q.buildRequested}; the doc is at build ${q.buildNow ?? 'missing'}. ${q.kindOfDoc || 'unknown kind'}${q.needs.length ? `, needs ${q.needs.join(', ')}` : ''}. Attempt ink: ${q.attemptStrokes} stroke(s).`);
    if (q.passage) { out.push(''); out.push('```markdown'); out.push(q.passage); out.push('```'); }
    out.push('');
  }
  out.push(`## Lost marks still in their scaffold (${r.scaffold.length})`);
  out.push('');
  out.push(r.scaffold.length ? r.scaffold.map((s) => `- ${s.doc}#${s.anchor} (${s.t.slice(0, 10)}), attempt ink ${s.attemptStrokes}`).join('\n') : 'None.');
  out.push('');
  out.push(`## Settles (${r.settles.length})`);
  out.push('');
  out.push(r.settles.length ? r.settles.map((s) => `- ${s.t.slice(0, 10)} ${s.item}: ${s.verdict}${s.help ? ' after help' : ''}${s.conf != null ? `, confidence ${s.conf}` : ''}, ${s.min} min${s.hidden ? ', hidden' : ''}${s.hook ? ', hook' : ''}; called ${s.called.join(', ') || '-'}; used ${s.used.join(', ') || '-'}`).join('\n') : 'None.');
  out.push('');
  out.push(`## Drills (${r.drills.length})`);
  out.push('');
  out.push(r.drills.length ? r.drills.map((d) => `- ${d.t.slice(0, 10)} ${d.doc}#${d.item}: ${d.grade}${d.src !== 'drill' ? ` (${d.src})` : ''}`).join('\n') : 'None.');
  out.push('');
  if (r.katas.length) {
    out.push(`## Katas (${r.katas.length})`);
    out.push('');
    out.push(r.katas.map((k) => `- ${k.t.slice(0, 10)} ${k.kata}: ${k.pass ? 'pass' : 'no pass'}, ${k.runs} run(s)${k.gaveUp ? ', gave up' : ''}`).join('\n'));
    out.push('');
  }
  return out.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  if (!root || !existsSync(root)) { console.error('usage: node scripts/study-scan.mjs <study root> [--since=YYYY-MM-DD] [--json] [--lint] [--figures]'); process.exit(2); }
  const sinceArg = args.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice(8) : new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const lib = loadLib();
  const { files, events, skipped, logFiles } = readStudy(root);
  const index = lib.buildIndex(files);
  const r = scan(index, events, since);
  const meta = { docs: index.docs.size, events: events.length, skipped, logFiles, since };
  const l = args.includes('--lint') ? lint({ root, files, index, lib }) : null;
  const unused = args.includes('--figures') ? unusedFigures(root, files) : null;
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({
      meta, ...r, warnings: l ? index.warnings : undefined,
      lint: l ? { errors: l.errors, warnings: l.warnings, info: l.info } : undefined, unusedFigures: unused || undefined,
    }, null, 1) + '\n');
  } else {
    process.stdout.write(fmt(r, meta) + '\n');
    if (l) process.stdout.write(`\n${fmtLint(l)}\n`);
    if (unused) process.stdout.write(`\n## Unused figures (${unused.length})\n\n${unused.length ? unused.map((u) => `- ${u}`).join('\n') : 'None.'}\n`);
  }
  if (l && l.errors.length) process.exitCode = 1;
}

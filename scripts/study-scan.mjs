// study-scan: what the iPad asked for, read on the laptop (docs/study/SPEC.md, Laptop side; ticket S10).
//
//   node scripts/study-scan.mjs <study root> [--since=YYYY-MM-DD] [--json] [--lint]
//
// <study root> is the study folder in the vault (in the portfolio: content/study). The script reads
// every log/*.jsonl and every doc under it, and reports:
//   - pending rebuild and rewrite requests (a request is answered once the doc's `build` is higher
//     than the build it was made on), each with the passage's source and the attempt ink it had;
//   - lost marks still in their scaffold (no request yet: the plugin's ration decides when);
//   - settles and drills since --since (default: 7 days ago);
//   - with --lint, the parser's warnings for every doc.
// It never writes anything. /teach reads its --json output. The parser is the plugin's own
// (src/study/format), bundled on the fly with esbuild, so the laptop and the iPad read docs alike.
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
  const entry = path.join(REPO, 'src', 'study', 'format', 'index-build.ts');
  const r = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node18', write: false, logLevel: 'error' });
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
  if (!root || !existsSync(root)) { console.error('usage: node scripts/study-scan.mjs <study root> [--since=YYYY-MM-DD] [--json] [--lint]'); process.exit(2); }
  const sinceArg = args.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice(8) : new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const lib = loadLib();
  const { files, events, skipped, logFiles } = readStudy(root);
  const index = lib.buildIndex(files);
  const r = scan(index, events, since);
  const meta = { docs: index.docs.size, events: events.length, skipped, logFiles, since };
  if (args.includes('--json')) process.stdout.write(JSON.stringify({ meta, ...r, warnings: args.includes('--lint') ? index.warnings : undefined }, null, 1) + '\n');
  else {
    process.stdout.write(fmt(r, meta) + '\n');
    if (args.includes('--lint')) {
      process.stdout.write(`\n## Parser warnings (${index.warnings.length})\n\n`);
      process.stdout.write(index.warnings.length ? index.warnings.map((w) => `- ${w}`).join('\n') + '\n' : 'None.\n');
    }
  }
}

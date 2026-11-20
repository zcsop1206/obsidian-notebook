// study-progress: what has been done in each study doc, and how long things took, read on the laptop
// (ticket S38).
//
//   node scripts/study-progress.mjs <study root> [--day=YYYY-MM-DD] [--minutes=N]
//
// <study root> is the study folder in the vault (in the portfolio: content/study). The script reads
// every doc and every log/*.jsonl under it and prints one JSON object:
//   - docs: per study doc, its size (prose words, proof steps, examples, derives, recalls), which of
//     its proofs have a finished fog, and its Try list (the problems it holds, invented or bank) with
//     what was settled;
//   - basics: every basic's stage and due date, as the engine folds them;
//   - calls: the calls not yet settled;
//   - settles, drills, katas, fogs: the timed events, each with its day (the device's local date);
//   - today: Today's drills and picks for --day at --minutes (default 60);
//   - tracks: the tracks as the plugin parses them.
// It never writes into the root. The portfolio's planner (pm/plan.mjs, private) reads its output to
// plan each day. The parser and the engine are the plugin's own, bundled on the fly with esbuild,
// as in study-scan.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readStudy } from './study-scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

/** The plugin's parser and engine, bundled for node. */
export function loadLib() {
  const require = createRequire(import.meta.url);
  const esbuild = require('esbuild');
  const out = path.join(HERE, '.cache', 'study-progress-lib.cjs');
  mkdirSync(path.dirname(out), { recursive: true });
  const contents = [
    "export { buildIndex } from './src/study/format/index-build';",
    "export { StudyState } from './src/study/engine/state';",
  ].join('\n');
  const r = esbuild.buildSync({
    stdin: { contents, resolveDir: REPO, loader: 'ts', sourcefile: 'study-progress-lib.ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', write: false, logLevel: 'error',
  });
  writeFileSync(out, r.outputFiles[0].text);
  delete require.cache[out];
  return require(out);
}

/** Words of prose: a formula counts as one word. */
const words = (s) => s.replace(/\$\$[\s\S]*?\$\$/g, ' M ').replace(/\$[^$\n]*\$/g, ' M ').split(/\s+/).filter(Boolean).length;
const dayOf = (t) => String(t).slice(0, 10);

/**
 * Progress over the study root on `day`. `lib` is loadLib()'s result (pass it to avoid a rebuild).
 */
export function progress(root, day, { minutes = 60, lib = loadLib() } = {}) {
  const { files, events, skipped } = readStudy(root);
  const index = lib.buildIndex(files);
  const st = new lib.StudyState(index, events);
  const ev = st.events;

  const foggedBy = new Map(); // doc -> Set of proof anchors with a finished fog
  for (const e of ev) {
    if (e.type !== 'fog' || !e.done) continue;
    if (!foggedBy.has(e.doc)) foggedBy.set(e.doc, new Set());
    foggedBy.get(e.doc).add(e.proof);
  }
  const passedKatas = new Set(ev.filter((e) => e.type === 'kata' && e.pass).map((e) => e.kata));
  const settled = (id) => st.settled.get(id) || null;

  const docs = {};
  for (const d of index.docs.values()) {
    if (d.kind === 'bank') continue;
    let prose = 0;
    for (const p of d.passages) {
      const t = p.callout && p.callout.type;
      if (t === 'proof' || t === 'solution' || p.kind === 'code') continue;
      prose += words(p.markdown);
    }
    const fogged = foggedBy.get(d.id) || new Set();
    const proofs = d.proofs.map((p) => ({ anchor: p.anchor, steps: p.steps.length, fogged: fogged.has(p.anchor) }));
    const tryIds = [...d.problems.filter((p) => !p.bank).map((p) => p.id), ...d.bankRefs.filter((id) => !d.problems.some((p) => p.id === id))];
    const tryList = tryIds.map((id) => {
      const p = index.problems.get(id);
      const s = settled(id);
      return { id, d: p ? p.d : null, bank: p && p.bank ? p.bank.bank : null, area: p ? p.area : null, settled: !!s, verdict: s ? s.verdict : null };
    });
    docs[d.id] = {
      path: d.path, kind: d.kind, title: d.title, areas: d.areas, tracks: d.tracks, build: d.build,
      served: index.tracks.filter((t) => st.trackMatches(t, d)).map((t) => t.id),
      words: prose,
      proofs,
      proofsFogged: proofs.filter((p) => p.fogged).length,
      examples: d.passages.filter((p) => p.callout && p.callout.type === 'example').length,
      derives: d.derives.length,
      recalls: d.recalls.length,
      try: tryList,
      kata: d.kata ? { id: d.kata.id, d: d.kata.d, level: d.kata.level, passed: passedKatas.has(d.kata.id) } : null,
    };
  }

  const basics = {};
  for (const b of st.basics.values()) basics[b.id] = { stage: b.stage, due: b.due, opened: b.opened, last: b.last };

  const calls = [...st.calls.entries()].filter(([id]) => !st.settled.has(id))
    .map(([item, c]) => ({ item, day: dayOf(c.t), hidden: c.hidden, d: c.d }));

  const prob = (id) => index.problems.get(id) || null;
  const settles = ev.filter((e) => e.type === 'settle').map((e) => {
    const p = prob(e.item);
    return { item: e.item, day: dayOf(e.t), ms: e.ms, verdict: e.verdict, hidden: e.hidden, d: p ? p.d : null, bank: p && p.bank ? p.bank.bank : null };
  });
  const drills = ev.filter((e) => e.type === 'drill').map((e) => ({ doc: e.doc, item: e.item, day: dayOf(e.t), ms: e.ms, grade: e.grade, src: e.src }));
  const katas = ev.filter((e) => e.type === 'kata').map((e) => {
    const k = index.katas.get(e.kata);
    return { kata: e.kata, day: dayOf(e.t), ms: e.ms, pass: e.pass, d: k ? k.d : null, level: k ? k.level : null };
  });
  const fogs = ev.filter((e) => e.type === 'fog').map((e) => ({ doc: e.doc, proof: e.proof, t: e.t, day: dayOf(e.t), done: e.done, steps: e.steps, reveals: e.reveals }));

  const plan = st.todayPlan(day, minutes);
  const today = {
    drills: plan.drills.map((x) => ({ basic: x.basic, item: x.item, overdue: x.overdue, track: x.track })),
    picks: plan.picks.map((x) => ({ id: x.id, kind: x.kind, d: x.d, hidden: x.hidden, area: x.kind === 'kata' ? null : (prob(x.id) || {}).area || null })),
    next: plan.next,
  };

  return {
    day, root: path.resolve(root),
    counts: { docs: index.docs.size, events: ev.length, skipped: skipped + st.skipped, warnings: index.warnings.length },
    tracks: index.tracks, docs, basics, calls, settles, drills, katas, fogs, today,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  if (!root) {
    process.stderr.write('usage: node scripts/study-progress.mjs <study root> [--day=YYYY-MM-DD] [--minutes=N]\n');
    process.exit(2);
  }
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const day = opt('day') || local;
  const minutes = Number(opt('minutes') || 60);
  process.stdout.write(JSON.stringify(progress(root, day, { minutes }), null, 1) + '\n');
}

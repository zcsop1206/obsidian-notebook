#!/usr/bin/env node
// Concatenates src/ into one artifact page: <title>, <style> (base.css), the app root, one <script> per
// source file, then the MathJax tag. The artifact host adds doctype/html/head/body and the viewport meta,
// so the output must not contain them; the build refuses to write a page that does.
//
//   node build.mjs                 -> index.html from src/ (missing files are skipped)
//   node build.mjs --fixture       -> test/fixture-content.js stands in for src/content.js
//   node build.mjs --bare          -> only base.css, core.js, content (or fixture), reader.js, main.js
//   node build.mjs --bare --add engine.js,block-fog.js -> the bare set plus the named files
//   node build.mjs --out <path>    -> write somewhere else (relative to this folder)
//   node build.mjs --quiet         -> no per-file listing
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');
const ORDER = ['base.css', 'core.js', 'content.js', 'engine.js', 'reader.js', 'block-fog.js', 'block-kata.js',
  'block-problem.js', 'block-drill.js', 'panel-map.js', 'main.js'];
const BARE = new Set(['base.css', 'core.js', 'content.js', 'reader.js', 'main.js']);
const MATHJAX = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js';
const TITLE = '<title>Study Reader</title>';
const MAX_BYTES = 16 * 1024 * 1024;

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
const fixture = flag('--fixture');
const bare = flag('--bare');
const quiet = flag('--quiet');
const out = resolve(HERE, opt('--out') || 'index.html');
for (const n of (opt('--add') || '').split(',').map((s) => s.trim()).filter(Boolean)) BARE.add(n.endsWith('.js') || n.endsWith('.css') ? n : n + '.js');

const errors = [];
const warnings = [];
const included = [];
const skipped = [];

function sourceFor(name) {
  if (name === 'content.js' && fixture) return join(HERE, 'test', 'fixture-content.js');
  return join(SRC, name);
}

// Inside a <script>, "</script" would end the element early; "<\/script" means the same in a JS string,
// template or regex. Nothing else in the sources is changed.
function scriptSafe(code) { return code.replace(/<\/(script)/gi, '<\\/$1'); }

let css = '';
const scripts = [];
for (const name of ORDER) {
  if (bare && !BARE.has(name)) { skipped.push(name + ' (bare)'); continue; }
  const file = sourceFor(name);
  if (!existsSync(file)) { skipped.push(name + ' (missing)'); continue; }
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rel = relative(HERE, file).split('\\').join('/');
  included.push(`${rel} (${Buffer.byteLength(text)} B)`);
  if (name.endsWith('.css')) {
    if (/<\/style/i.test(text)) errors.push(`${rel}: contains "</style"`);
    css += `/* ${rel} */\n${text}\n`;
  } else {
    if (/<!--/.test(text) && /<script/i.test(text)) warnings.push(`${rel}: has both "<!--" and "<script" inside script text; check the page parses`);
    scripts.push(`<script>\n/* ${rel} */\n${scriptSafe(text)}\n</script>`);
  }
}

const page = [
  TITLE,
  `<style>\n${css}</style>`,
  '<div id="sr-app" class="sr-app"></div>',
  '<noscript><p style="padding:16px">The study reader needs JavaScript.</p></noscript>',
  ...scripts,
  `<script async src="${MATHJAX}"></script>`,
  ''
].join('\n');

// ---- checks against the page contract
const forbidden = [
  [/<!doctype/i, '<!DOCTYPE>'],
  [/<html[\s>]/i, '<html>'],
  [/<head[\s>]/i, '<head>'],
  [/<body[\s>]/i, '<body>'],
  [/<meta[^>]*name\s*=\s*["']?viewport/i, 'a viewport meta']
];
for (const [re, what] of forbidden) {
  const m = re.exec(page);
  if (m) errors.push(`output contains ${what} near: ${JSON.stringify(page.slice(Math.max(0, m.index - 40), m.index + 40))}`);
}
if (page.indexOf(TITLE) !== 0) errors.push('the page must start with <title>Study Reader</title>');
for (const m of page.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
  if (!/^https:\/\/cdn\.jsdelivr\.net\/npm\/[^/@]+@\d+\.\d+\.\d+\//.test(m[1])) errors.push(`external script not allowed: ${m[1]}`);
}
if (/<link\b[^>]*rel\s*=\s*["']?stylesheet/i.test(page)) errors.push('external stylesheets are not allowed');
const risky = [
  [/\beval\s*\(/, 'eval('], [/\bnew\s+Function\s*\(/, 'new Function('], [/(?<![.\w])alert\s*\(/, 'alert('],
  [/(?<![.\w])confirm\s*\(/, 'confirm('], [/(?<![.\w])prompt\s*\(/, 'prompt('], [/window\.open\s*\(/, 'window.open('],
  [/(?<![.\w])fetch\s*\(/, 'fetch('], [/XMLHttpRequest/, 'XMLHttpRequest'], [/\bimport\s*\(/, 'dynamic import(']
];
for (const [re, what] of risky) if (re.test(page)) warnings.push(`page text contains ${what}; the contract forbids it unless it is only in a string or comment`);
const bytes = Buffer.byteLength(page);
if (bytes > MAX_BYTES) errors.push(`page is ${bytes} B, over the 16 MB limit`);

if (!quiet) {
  console.log('included: ' + (included.length ? '\n  ' + included.join('\n  ') : 'nothing'));
  if (skipped.length) console.log('skipped:  ' + skipped.join(', '));
}
for (const w of warnings) console.warn('warning: ' + w);
if (errors.length) {
  for (const e of errors) console.error('error: ' + e);
  console.error('not written: ' + relative(HERE, out));
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, 'utf8');
console.log(`wrote ${relative(HERE, out).split('\\').join('/')} (${bytes} B${fixture ? ', fixture content' : ''}${bare ? ', bare' : ''})`);

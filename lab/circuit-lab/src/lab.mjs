// The lab page: switching circuits (sketch, Run, scores, x1/2 and x2) and AC (a phasor prediction, then
// a Bode sketch and sweep). localStorage keeps the round counter, the last circuit and a score log; every
// read and write is wrapped, so the page works without it. Written by a model.
import { SWITCHING, AC, drawValues, rng, byId } from './circuits.mjs';
import { solveSwitching, scoreSketch, sketchReady, phasors, bode, phasorFreq, scorePhasor, scoreBode, coverage, cplx, TOL } from './analysis.mjs';
import { schematicSVG, si } from './schematic.mjs';
import { UNIT } from './circuits.mjs';
import { InkPlot, pen, symTicks, logTicks } from './plot.mjs';

const LABEL = "Written by a model for Adit. Not Adit's words.";
const KEY = 'circuit-lab:v1';
const store = {
  load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } },
  save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage is a convenience */ } },
};
const saved = store.load();
const S = {
  base: Number.isInteger(saved.base) ? saved.base : Math.floor(Math.random() * 1e6),
  round: Number.isInteger(saved.round) ? saved.round : 0,
  tab: saved.tab === 'ac' ? 'ac' : 'sw',
  sw: byId(saved.sw) ? saved.sw : 'any',
  ac: byId(saved.ac) ? saved.ac : AC[0].id,
  penOnly: !!saved.penOnly,
  log: Array.isArray(saved.log) ? saved.log.slice(-300) : [],
};
pen.only = S.penOnly;
const persist = () => store.save({ base: S.base, round: S.round, tab: S.tab, sw: S.sw, ac: S.ac, penOnly: pen.only, log: S.log });
const logResult = (r) => { S.log.push({ at: new Date().toISOString(), ...r }); S.log = S.log.slice(-300); persist(); };

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}
const nextSeed = () => { S.round += 1; persist(); return (S.base * 7919 + S.round * 104729) >>> 0; };
const subName = (n) => { const i = n.indexOf('_'); return i < 0 ? n : h('span', {}, n.slice(0, i), h('sub', {}, n.slice(i + 1))); };
const pill = (g) => h('span', { class: `pill ${g}` }, { ok: 'ok', close: 'close', off: 'off', none: '—' }[g]);
const fmtTicks = (v, unit) => (Math.abs(v) < 1e-15 ? '0' : si(v, unit).replace(' ', ' '));

// ---------------------------------------------------------------- shell

const app = document.getElementById('lab');
const penBox = h('input', { type: 'checkbox', id: 'pen-only', checked: pen.only || null, onchange: (e) => { pen.only = e.target.checked; persist(); } });
pen.listeners.add(() => { penBox.checked = true; persist(); });
const tabs = h('div', { class: 'tabs', role: 'tablist' });
const swView = h('section', { id: 'sw-view', 'aria-label': 'Switching circuits' });
const acView = h('section', { id: 'ac-view', 'aria-label': 'AC circuits' });
const setTab = (t) => {
  S.tab = t; persist();
  swView.hidden = t !== 'sw'; acView.hidden = t !== 'ac';
  for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === t));
};
tabs.append(
  h('button', { role: 'tab', 'data-tab': 'sw', id: 'tab-sw', onclick: () => setTab('sw') }, 'Switching'),
  h('button', { role: 'tab', 'data-tab': 'ac', id: 'tab-ac', onclick: () => setTab('ac') }, 'AC'),
);
app.append(
  h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('h1', {}, 'Circuit Lab'), h('p', { class: 'lede' }, 'Predict first, then run the solver. Every round draws new standard values.')),
    h('div', { class: 'top-tools' }, tabs, h('label', { class: 'check', for: 'pen-only' }, penBox, 'Pencil only')),
  ),
  swView, acView,
  h('footer', {},
    h('p', {}, 'Circuits, values and this page are generated. None is a course problem. Tolerances are provisional until the iPad check. Scores stay in this browser.'),
    h('p', { class: 'muted' }, LABEL)),
);

// ---------------------------------------------------------------- switching

const SW = { spec: null, vals: null, sol: null, seed: 0, variant: null, phase: 'predict', ghost: null, prev: null };
const swChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Circuit' });
const swSch = h('div', { class: 'sch-box' });
const swMeta = h('p', { class: 'meta' });
const swPlotHost = h('div', { class: 'plot-box' });
const swTitle = h('h3', {});
const swWhy = h('p', { class: 'why', role: 'status' });
const swRun = h('button', { class: 'primary', id: 'sw-run', disabled: true, onclick: () => runSwitching() }, 'Run');
const swResults = h('div', { class: 'results', id: 'sw-results' });
const swVar = h('div', { class: 'variants', id: 'sw-variants' });
let swPlot = null;

for (const s of [{ id: 'any', title: 'Any' }, ...SWITCHING]) {
  swChips.append(h('button', { class: 'chip', 'data-id': s.id, 'aria-pressed': String(S.sw === s.id), onclick: () => { S.sw = s.id; persist(); for (const c of swChips.children) c.setAttribute('aria-pressed', String(c.dataset.id === s.id)); newSwitching(); } }, s.title));
}
swView.append(
  swChips,
  h('div', { class: 'bench' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Circuit'), h('button', { id: 'sw-new', onclick: () => newSwitching() }, 'New values')), swSch, swMeta),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, swTitle),
      swPlotHost,
      h('div', { class: 'tools' }, h('button', { onclick: () => swPlot.undo() }, 'Undo stroke'), h('button', { onclick: () => swPlot.clear() }, 'Clear'), h('span', { class: 'sp' }), swRun),
      swWhy)),
  swResults, swVar,
);

function swAxes(sol, spec) {
  const T = sol.tstop, u = spec.probe.unit;
  return {
    x: { min: -0.15 * T, max: T, ticks: [0, T / 5, (2 * T) / 5, (3 * T) / 5, (4 * T) / 5, T], fmt: (v) => fmtTicks(v, 's') },
    y: { min: -sol.top, max: sol.top, ticks: symTicks(sol.top), fmt: (v) => fmtTicks(v, u) },
    xLabel: 't', yLabel: `${spec.probe.name.replace('_', '')} (${u})`, mark0: true,
  };
}

function newSwitching() {
  SW.seed = nextSeed();
  const r = rng(SW.seed);
  SW.spec = S.sw === 'any' ? SWITCHING[Math.floor(r() * SWITCHING.length)] : byId(S.sw);
  SW.vals = drawValues(SW.spec, SW.seed);
  SW.sol = solveSwitching(SW.spec, SW.vals);
  SW.variant = null; SW.ghost = null; SW.prev = null;
  startPrediction();
}

function startPrediction() {
  SW.phase = 'predict';
  swSch.innerHTML = schematicSVG(SW.spec, SW.vals);
  swMeta.textContent = `${SW.spec.title} · round ${S.round} · seed ${SW.seed}. The switch acts at t = 0 after a long time in its drawn position.`;
  swTitle.replaceChildren(SW.variant ? 'Sketch the new ' : 'Sketch ', subName(SW.spec.probe.name), '(t)');
  const axes = swAxes(SW.sol, SW.spec);
  if (!swPlot) swPlot = new InkPlot(swPlotHost, { ...axes, onInk: onSwInk });
  swPlot.setGhost(SW.ghost || { strokes: [], curves: [] });
  swPlot.setTruth([]);
  swPlot.o.inkClass = SW.variant ? 'ink2' : '';
  swPlot.setAxes(axes);
  swPlot.lock(false);
  swPlot.clear();
  swResults.replaceChildren();
  if (!SW.variant) swVar.replaceChildren();
  else swVar.replaceChildren(h('p', { class: 'why' }, `${SW.variant.label}. The earlier sketch and curve are grey. Sketch the new response before you run.`));
}

function onSwInk(strokes) {
  if (SW.phase !== 'predict') return;
  const r = sketchReady(strokes, SW.sol, SW.spec.probe.name.replace('_', ''));
  swRun.disabled = !r.ok;
  swWhy.textContent = r.ok ? 'Ready. Run overlays the solver’s curve.' : r.why;
}

function runSwitching() {
  if (SW.phase !== 'predict' || !sketchReady(swPlot.strokes, SW.sol).ok) return;
  SW.phase = 'shown';
  swRun.disabled = true;
  swPlot.lock(true);
  swPlot.setTruth([{ pts: SW.sol.curve, cls: 'truth' }]);
  const rows = scoreSketch(swPlot.strokes, SW.sol);
  const u = SW.spec.probe.unit;
  const st = SW.sol.storage;
  const lv = (x) => si(Math.abs(x) < 5e-4 * SW.sol.top ? 0 : x, u);
  swTitle.replaceChildren(subName(SW.spec.probe.name), '(t): your sketch and the solver');
  swWhy.textContent = 'Solver curve in teal. Change one element below, or take the next circuit.';
  const tbl = h('table', { class: 'score' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Your sketch'), h('th', {}, 'Solver'), h('th', {}, 'Off by'), h('th', {}, ''))),
    h('tbody', {}, rows.map((r) => {
      if (r.key === 'shape') return h('tr', { class: 'shape' }, h('th', {}, 'Shape'), h('td', { colspan: 2, class: 'muted' }, 'RMS over the window'), h('td', {}, r.err === null ? '—' : `${(r.err * 100).toFixed(1)}% of axis`), h('td', {}, pill(r.grade)));
      if (r.key === 'τ') {
        return h('tr', {}, h('th', {}, 'τ'), h('td', {}, r.flat ? 'no transient' : r.pred === null ? '—' : si(r.pred, 's')), h('td', {}, si(r.truth, 's')),
          h('td', {}, r.ratio === null || r.flat ? '—' : `×${r.ratio.toFixed(2)}`), h('td', {}, pill(r.grade)));
      }
      return h('tr', {}, h('th', {}, r.key), h('td', {}, r.pred === null ? '—' : lv(r.pred)), h('td', {}, lv(r.truth)),
        h('td', {}, r.err === null ? '—' : lv(r.pred - r.truth)), h('td', {}, pill(r.grade)));
    })));
  const prev = SW.prev ? h('p', { class: 'muted' }, `Before the change: 0+ was ${lv(SW.prev.x0p)}, ∞ was ${lv(SW.prev.xinf)} and τ was ${si(SW.prev.tau, 's')}.`) : null;
  swResults.replaceChildren(
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Result')),
      h('div', { class: 'table-wrap' }, tbl),
      h('p', { class: 'muted' }, `For t > 0, ${st} sees a Thevenin resistance of ${si(SW.sol.rth, 'Ω')}. Grades use provisional tolerances: levels within ${TOL.level[0] * 100}% of the axis top is ok and within ${TOL.level[1] * 100}% close; τ within ${TOL.tau[0] * 100}% is ok and within ${TOL.tau[1] * 100}% close.`),
      prev));
  logResult({ mode: 'sw', topo: SW.spec.id, seed: SW.seed, variant: SW.variant?.key || null, rows: rows.map((r) => ({ k: r.key, e: r.err === null ? null : +r.err.toFixed(4), g: r.grade })) });
  renderVariants();
}

function renderVariants() {
  const box = h('div', { class: 'var-grid' });
  for (const k of Object.keys(SW.vals)) {
    box.append(h('div', { class: 'var' }, h('span', { class: 'var-name' }, subName(k)),
      h('button', { 'data-var': `${k}x0.5`, onclick: () => vary(k, 0.5) }, '×½'),
      h('button', { 'data-var': `${k}x2`, onclick: () => vary(k, 2) }, '×2')));
  }
  swVar.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Change one element'), h('button', { onclick: () => newSwitching() }, 'Next circuit')),
    h('p', { class: 'muted' }, 'Each change asks for a new sketch before it runs.'), box));
}

function vary(k, f) {
  SW.ghost = { strokes: swPlot.strokes.slice(), curves: [SW.sol.curve] };
  SW.prev = SW.sol;
  const old = SW.vals[k];
  SW.vals = { ...SW.vals, [k]: +(old * f).toPrecision(4) };
  try {
    SW.sol = solveSwitching(SW.spec, SW.vals, { tstop: SW.prev.tstop, top: SW.prev.top });
  } catch (err) {
    SW.vals = { ...SW.vals, [k]: old };
    swWhy.textContent = `That change has no stable answer here (${err.message}). Try another.`;
    return;
  }
  SW.variant = { key: `${k}x${f}`, label: `${k} is now ${si(SW.vals[k], UNIT[k[0]] || '')} (${f === 2 ? '×2' : '×½'}).` };
  startPrediction();
}

// ---------------------------------------------------------------- AC

const ACS = { spec: null, vals: null, seed: 0, f: 0, ph: null, bode: null, phase: 'predict' };
const acChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Circuit' });
const acSch = h('div', { class: 'sch-box' });
const acMeta = h('p', { class: 'meta' });
const acSrc = h('p', { class: 'src' });
const inMag = h('input', { id: 'ac-mag', type: 'number', inputmode: 'decimal', step: 'any', 'aria-label': 'Predicted amplitude of V_o in volts' });
const inDeg = h('input', { id: 'ac-deg', type: 'number', inputmode: 'decimal', step: 'any', 'aria-label': 'Predicted phase of V_o in degrees' });
const acCheck = h('button', { class: 'primary', id: 'ac-check', disabled: true, onclick: () => checkPhasor() }, 'Check');
const acPhOut = h('div', { class: 'ph-out' });
const magHost = h('div', { class: 'plot-box' }), phHost = h('div', { class: 'plot-box' });
const sweepRun = h('button', { class: 'primary', id: 'ac-run', disabled: true, onclick: () => runSweep() }, 'Run sweep');
const sweepWhy = h('p', { class: 'why', role: 'status' });
const sweepOut = h('div', { class: 'results' });
let magPlot = null, phPlot = null;
const updCheck = () => { acCheck.disabled = !(inMag.value !== '' && inDeg.value !== '' && Number.isFinite(+inMag.value) && Number.isFinite(+inDeg.value)) || ACS.phase !== 'predict'; };
inMag.addEventListener('input', updCheck); inDeg.addEventListener('input', updCheck);

for (const s of AC) {
  acChips.append(h('button', { class: 'chip', 'data-id': s.id, 'aria-pressed': String(S.ac === s.id), onclick: () => { S.ac = s.id; persist(); for (const c of acChips.children) c.setAttribute('aria-pressed', String(c.dataset.id === s.id)); newAC(); } }, s.title));
}
acView.append(
  acChips,
  h('div', { class: 'bench' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Circuit'), h('button', { id: 'ac-new', onclick: () => newAC() }, 'New values')), acSch, acSrc, acMeta),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Phasor at one frequency')),
      h('p', {}, 'Predict the output phasor, as amplitude and phase against the source.'),
      h('div', { class: 'pred' },
        h('label', { for: 'ac-mag' }, h('span', {}, '|V', h('sub', {}, 'o'), '| (V)'), inMag),
        h('label', { for: 'ac-deg' }, h('span', {}, '∠V', h('sub', {}, 'o'), ' (°)'), inDeg),
        acCheck),
      acPhOut)),
  h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Frequency response'), h('span', { class: 'muted' }, 'H = V', h('sub', {}, 'o'), ' / V', h('sub', {}, 's'))),
    h('p', {}, 'Sketch |H| in dB and its phase across the four decades, then run the sweep.'),
    h('div', { class: 'bode' }, magHost, phHost),
    h('div', { class: 'tools' }, h('button', { onclick: () => { (lastBode || magPlot).undo(); } }, 'Undo stroke'), h('button', { onclick: () => { magPlot.clear(); phPlot.clear(); } }, 'Clear both'), h('span', { class: 'sp' }), sweepRun),
    sweepWhy, sweepOut),
);
let lastBode = null;

function newAC() {
  ACS.seed = nextSeed();
  ACS.spec = byId(S.ac);
  ACS.vals = drawValues(ACS.spec, ACS.seed);
  ACS.f = phasorFreq(ACS.spec, ACS.vals, rng(ACS.seed ^ 0x5bd1e995));
  ACS.ph = phasors(ACS.spec, ACS.vals, ACS.f);
  ACS.bode = bode(ACS.spec, ACS.vals);
  ACS.phase = 'predict';
  acSch.innerHTML = schematicSVG(ACS.spec, ACS.vals, { ac: true });
  acSrc.replaceChildren('v', h('sub', {}, 's'), `(t) = ${ACS.vals.V1} cos(2π · ${si(ACS.f, 'Hz')} · t) V`);
  acMeta.textContent = `${ACS.spec.title} · round ${S.round} · seed ${ACS.seed}. Sinusoidal steady state.`;
  inMag.value = ''; inDeg.value = ''; inMag.disabled = false; inDeg.disabled = false; updCheck();
  acPhOut.replaceChildren();
  const { flo, fhi } = ACS.bode;
  const lt = logTicks(flo, fhi);
  const xa = { min: flo, max: fhi, log: true, ticks: lt.major, minor: lt.minor, fmt: (v) => fmtTicks(v, 'Hz') };
  const ma = { x: xa, y: { min: -60, max: 40, ticks: [-60, -40, -20, 0, 20, 40], fmt: (v) => `${v}` }, xLabel: 'f', yLabel: '|H| (dB)', aspect: 0.42 };
  const pa = { x: xa, y: { min: -180, max: 180, ticks: [-180, -90, 0, 90, 180], fmt: (v) => `${v}°` }, xLabel: 'f', yLabel: '∠H (°)', aspect: 0.42 };
  if (!magPlot) {
    magPlot = new InkPlot(magHost, { ...ma, onInk: () => { lastBode = magPlot; onBodeInk(); } });
    phPlot = new InkPlot(phHost, { ...pa, onInk: () => { lastBode = phPlot; onBodeInk(); } });
  }
  for (const [p, a] of [[magPlot, ma], [phPlot, pa]]) { p.setTruth([]); p.setGhost({ strokes: [], curves: [] }); p.setAxes(a); p.lock(false); p.clear(); }
  sweepOut.replaceChildren();
}

function onBodeInk() {
  if (ACS.phase === 'swept') return;
  const { flo, fhi } = ACS.bode;
  const cm = coverage(magPlot.strokes, flo, fhi, 60, true), cp = coverage(phPlot.strokes, flo, fhi, 60, true);
  const ok = cm >= 0.5 && cp >= 0.5;
  sweepRun.disabled = !ok;
  sweepWhy.textContent = ok ? 'Ready. Run overlays the swept response.' : `Sketch at least half the band on both plots (now ${Math.round(cm * 100)}% and ${Math.round(cp * 100)}%).`;
}

const polar = (z, unit) => `${si(cplx.mag(z), unit)} ∠ ${cplx.deg(z).toFixed(1)}°`;

function checkPhasor() {
  if (ACS.phase !== 'predict') return;
  ACS.phase = 'checked';
  inMag.disabled = true; inDeg.disabled = true; updCheck();
  const rows = scorePhasor({ mag: +inMag.value, deg: +inDeg.value }, ACS.ph.out);
  logResult({ mode: 'phasor', topo: ACS.spec.id, seed: ACS.seed, rows: rows.map((r) => ({ k: r.key, e: +r.err.toFixed(4), g: r.grade })) });
  const score = h('table', { class: 'score' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'You'), h('th', {}, 'Solver'), h('th', {}, 'Off by'), h('th', {}, ''))),
    h('tbody', {},
      h('tr', {}, h('th', {}, '|V', h('sub', {}, 'o'), '|'), h('td', {}, si(rows[0].pred, 'V')), h('td', {}, si(rows[0].truth, 'V')), h('td', {}, `${(rows[0].err * 100).toFixed(1)}%`), h('td', {}, pill(rows[0].grade))),
      h('tr', {}, h('th', {}, '∠V', h('sub', {}, 'o')), h('td', {}, `${rows[1].pred}°`), h('td', {}, `${rows[1].truth.toFixed(1)}°`), h('td', {}, `${rows[1].err.toFixed(1)}°`), h('td', {}, pill(rows[1].grade)))));
  const all = h('table', { class: 'phasors' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Voltage'), h('th', {}, 'Current'))),
    h('tbody', {}, ACS.ph.rows.map((r) => h('tr', {}, h('th', {}, subName(r.name)), h('td', {}, polar(r.v, 'V')), h('td', {}, polar(r.i, 'A')))),
      ACS.spec.out.kind === 'node' ? h('tr', {}, h('th', {}, 'V', h('sub', {}, 'o')), h('td', {}, polar(ACS.ph.out, 'V')), h('td', {}, '')) : null));
  acPhOut.replaceChildren(
    h('div', { class: 'table-wrap' }, score),
    h('div', { class: 'ph-grid' }, h('div', { class: 'table-wrap' }, all), h('div', { class: 'ph-diagram', html: phasorSVG(ACS.ph, ACS.spec) })),
    h('p', { class: 'muted' }, `Voltages are drawn to one scale and currents (dashed) to another. Provisional tolerances: amplitude within ${TOL.mag[0] * 100}%, phase within ${TOL.phase[0]}°.`));
}

function phasorSVG(p, spec) {
  const vs = p.rows.map((r) => ({ name: r.name, z: r.v, cls: `ph-${r.kind}` }));
  if (spec.out.kind === 'node') vs.push({ name: 'V_o', z: p.out, cls: 'ph-o' });
  const vmax = Math.max(...vs.map((v) => cplx.mag(v.z)));
  const cur = p.rows.find((r) => r.kind === 'V').i;
  const R = 100;
  const items = [];
  const arrow = (z, scale, cls, name, dashed) => {
    const m = cplx.mag(z); if (m < 1e-12) return;
    const x = (z[0] / scale) * R, y = (-z[1] / scale) * R;
    const L = Math.hypot(x, y); const ux = x / L, uy = y / L;
    const hx = x - ux * 8, hy = y - uy * 8;
    items.push(`<line class="${cls}${dashed ? ' dash' : ''}" x1="0" y1="0" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}"/>`);
    items.push(`<path class="${cls} fill" d="M${x.toFixed(1)} ${y.toFixed(1)} L${(hx - uy * 4).toFixed(1)} ${(hy + ux * 4).toFixed(1)} L${(hx + uy * 4).toFixed(1)} ${(hy - ux * 4).toFixed(1)} Z"/>`);
    const i = name.indexOf('_');
    const label = i < 0 ? name : `${name.slice(0, i)}<tspan dy="3" font-size="9">${name.slice(i + 1)}</tspan>`;
    items.push(`<text class="${cls} lbl" x="${(x + ux * 12).toFixed(1)}" y="${(y + uy * 12 + 4).toFixed(1)}" text-anchor="middle">${label}</text>`);
  };
  for (const v of vs) arrow(v.z, vmax, v.cls, v.name.startsWith('V') ? v.name : `V_${v.name}`);
  arrow(cur, cplx.mag(cur) / 0.6, 'ph-i', 'I', true);
  return `<svg viewBox="-135 -135 270 270" role="img" aria-label="Phasor diagram"><line class="axis" x1="-125" y1="0" x2="125" y2="0"/><line class="axis" x1="0" y1="-125" x2="0" y2="125"/><text class="tick" x="122" y="-4" text-anchor="end">Re</text><text class="tick" x="4" y="-118">Im</text>${items.join('')}</svg>`;
}

function runSweep() {
  if (ACS.phase === 'swept' || sweepRun.disabled) return;
  ACS.phase = 'swept';
  sweepRun.disabled = true;
  magPlot.lock(true); phPlot.lock(true);
  const pts = ACS.bode.pts;
  const fcLine = (lo, hi) => ({ pts: [[ACS.bode.fc, lo], [ACS.bode.fc, hi]], cls: 'fc' });
  magPlot.setTruth([{ pts: pts.map((q) => [q.f, q.db]) }, fcLine(-60, 40)]);
  phPlot.setTruth([{ pts: pts.map((q) => [q.f, q.ph]) }, fcLine(-180, 180)]);
  const m = scoreBode(magPlot.strokes, pts, 'db', TOL.db), p = scoreBode(phPlot.strokes, pts, 'ph', TOL.deg);
  logResult({ mode: 'bode', topo: ACS.spec.id, seed: ACS.seed, rows: [{ k: 'db', e: m.rms, g: m.grade }, { k: 'deg', e: p.rms, g: p.grade }] });
  const fcName = ACS.spec.id === 'ac-rlc' ? 'the resonant frequency' : 'the corner frequency';
  sweepOut.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'score' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'RMS error'), h('th', {}, 'Worst'), h('th', {}, ''))),
    h('tbody', {},
      h('tr', {}, h('th', {}, '|H|'), h('td', {}, `${m.rms.toFixed(1)} dB`), h('td', {}, `${m.worst.toFixed(1)} dB at ${si(m.at, 'Hz')}`), h('td', {}, pill(m.grade))),
      h('tr', {}, h('th', {}, '∠H'), h('td', {}, `${p.rms.toFixed(0)}°`), h('td', {}, `${p.worst.toFixed(0)}° at ${si(p.at, 'Hz')}`), h('td', {}, pill(p.grade)))))),
  h('p', { class: 'muted' }, `The dashed line is ${fcName}, ${si(ACS.bode.fc, 'Hz')}. Provisional tolerances: ${TOL.db[0]} dB and ${TOL.deg[0]}° RMS are ok.`));
}

// ---------------------------------------------------------------- start

newSwitching();
newAC();
setTab(S.tab);
window.circuitLab = { S, SW, ACS, plots: () => ({ sw: swPlot, mag: magPlot, ph: phPlot }) };

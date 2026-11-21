// What the lab computes from a circuit: the first-order numbers (0-, 0+, infinity, tau), the solver's
// curve, the plot axes, AC phasors and a Bode sweep, and the scores of a sketch or a typed prediction.
// Written by a model. Pure functions: no DOM, so node --test runs them.
import { parse, op, tran, acop } from './mna.mjs';

// ---------------------------------------------------------------- 1-2-5 steps

const STEPS = [1, 2, 5];
/** The smallest 1-2-5 value at or above x (x > 0). */
export function up125(x) {
  const d = Math.floor(Math.log10(x));
  for (const k of [d - 1, d, d + 1]) for (const m of STEPS) { const v = m * 10 ** k; if (v >= x * (1 - 1e-12)) return +v.toPrecision(3); }
  return 10 ** (d + 2);
}
/** The next 1-2-5 value above a 1-2-5 value. */
export const next125 = (x) => up125(x * 1.0001);

/** A 1-2-5 window between 3 tau and 8 tau, the one nearest 5 tau on a log scale. One always exists. */
export function pickWindow(tau) {
  const c = [];
  for (let k = Math.floor(Math.log10(3 * tau)) - 1; k <= Math.ceil(Math.log10(8 * tau)); k++) {
    for (const m of STEPS) { const v = m * 10 ** k; if (v >= 3 * tau * (1 - 1e-9) && v <= 8 * tau * (1 + 1e-9)) c.push(+v.toPrecision(3)); }
  }
  c.sort((a, b) => Math.abs(Math.log(a / (5 * tau))) - Math.abs(Math.log(b / (5 * tau))));
  return c[0];
}

// ---------------------------------------------------------------- probes

const vd = (r, n) => r.v(n[0]) - r.v(n[1]);

/** A probe as a function of one solve. kind v: voltage across el, + at its first node; kind i: current
 * through el from its first node to its second. A resistor that controls a source is split by the parser
 * (a 0 V sense source in series), so its nodes are read from the parsed list. */
export function probeFn(probe, els) {
  const el = els.find((e) => e.name === probe.el);
  if (!el) throw new Error(`probe: no element ${probe.el}`);
  if (probe.kind === 'v') return (r) => vd(r, el.n);
  if (el.k === 'L' || el.k === 'V') return (r) => r.i(el.name);
  if (el.k === 'R') return (r) => vd(r, el.n) / el.v;
  throw new Error(`probe: cannot read the current of ${el.name}`);
}

const sourceScale = (els, unit) => {
  const vs = els.filter((e) => e.k === 'V' && !e.name.includes('#')).map((e) => Math.abs(e.v));
  const is = els.filter((e) => e.k === 'I').map((e) => Math.abs(e.v));
  const rs = els.filter((e) => e.k === 'R').map((e) => e.v);
  if (unit === 'V') return vs.length ? Math.max(...vs) : Math.max(...is) * Math.max(...rs);
  return is.length ? Math.max(...is) : Math.max(...vs) / Math.min(...rs);
};

/** Symmetric axis top: 1.25 times the largest source in the probe's unit, up to 1-2-5, widened until
 * nothing the response reaches would clip. The axes never show the answer or its sign. */
export function axisTop(els, unit, reach) {
  let top = up125(1.25 * sourceScale(els, unit));
  while (reach > 0.96 * top) top = next125(top);
  return top;
}

// ---------------------------------------------------------------- switching

/**
 * Solves a first-order switching circuit. Returns the four numbers, the Thevenin resistance the storage
 * element sees after t = 0, the window, the axis top and the solver's curve as [t, x] points (from
 * -0.15 tstop, with the step at t = 0 drawn as two points).
 * opts.tstop keeps a given window (the x1/2 and x2 variations keep it while it still suits tau).
 */
export function solveSwitching(spec, vals, opts = {}) {
  const text = spec.net(vals);
  const fresh = () => parse(text);
  const els = fresh();
  const store = els.filter((e) => e.k === 'C' || e.k === 'L');
  if (store.length !== 1) throw new Error(`${spec.id}: expected one C or L, found ${store.length}`);
  const st = store[0];
  const pf = probeFn(spec.probe, els);

  const x0m = pf(op(fresh(), -1));
  const xinf = pf(op(fresh(), 1));

  // Thevenin resistance seen by the storage element for t > 0: independent sources zeroed, the element
  // replaced by a 1 V source of the same name (so a source it controls still finds its branch current).
  const z = fresh().map((e) => (e.k === 'V' || e.k === 'I' ? { ...e, v: 0 } : e));
  const k = z.findIndex((e) => e.name === st.name);
  z[k] = { k: 'V', name: st.name, n: st.n, v: 1 };
  const rth = -1 / op(z, 1).i(st.name);
  if (!(rth > 0) || !Number.isFinite(rth)) throw new Error(`${spec.id}: Thevenin resistance ${rth} is not positive`);
  const tau = st.k === 'C' ? rth * st.v : st.v / rth;

  // 0+: one backward-Euler step far shorter than tau holds every v_C and i_L at its 0- value.
  const x0p = tran(fresh(), tau * 1e-7, 1, [pf]).out[0][1];

  let tstop = opts.tstop;
  if (!tstop || tau > tstop / 2.5 || tau < tstop / 12) tstop = pickWindow(tau);
  const steps = 600;
  const { out } = tran(fresh(), tstop, steps, [pf]);
  const curve = [[-0.15 * tstop, x0m], [0, x0m], [0, x0p], ...out.map((p) => [p[0], p[1]])];
  const top = opts.top && Math.max(Math.abs(x0m), Math.abs(x0p), Math.abs(xinf)) <= 0.96 * opts.top
    ? opts.top
    : axisTop(els, spec.probe.unit, Math.max(Math.abs(x0m), Math.abs(x0p), Math.abs(xinf)));
  return { x0m, x0p, xinf, tau, rth, tstop, top, curve, storage: st.name };
}

/** The exact first-order response at t >= 0. */
export const firstOrderAt = (s, t) => s.xinf + (s.x0p - s.xinf) * Math.exp(-t / s.tau);

// ---------------------------------------------------------------- sketches

/** The sketch's value at x: the newest stroke that spans x wins, so a correction stroke replaces. */
export function sketchAt(strokes, x) {
  for (let s = strokes.length - 1; s >= 0; s--) {
    const p = strokes[s];
    for (let i = 1; i < p.length; i++) {
      const [x1, y1] = p[i - 1], [x2, y2] = p[i];
      if ((x >= x1 && x <= x2) || (x >= x2 && x <= x1)) {
        if (x1 === x2) return y2;
        return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
      }
    }
  }
  return null;
}

const median = (a) => { const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const lin = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

/** How much of [a, b] the sketch covers (0 to 1). */
export function coverage(strokes, a, b, n = 60, log = false) {
  const xs = log ? lin(Math.log10(a), Math.log10(b), n).map((u) => 10 ** u) : lin(a, b, n);
  return xs.filter((x) => sketchAt(strokes, x) !== null).length / n;
}

/** Provisional tolerances, as fractions of the axis top (levels) and of tau. Adit's iPad check sets them. */
export const TOL = { level: [0.05, 0.12], tau: [0.2, 0.4], rms: [0.06, 0.12], mag: [0.05, 0.15], phase: [5, 15], db: [3, 6], deg: [10, 20] };
const grade = (err, [ok, close]) => (err === null ? 'none' : err <= ok ? 'ok' : err <= close ? 'close' : 'off');

/** What a switching sketch needs before Run: some ink before t = 0 and most of the window after it. */
export function sketchReady(strokes, s, name = 'the response') {
  const pre = coverage(strokes, -0.13 * s.tstop, -0.02 * s.tstop, 12) > 0;
  const post = coverage(strokes, 0.01 * s.tstop, s.tstop, 60);
  if (!strokes.length) return { ok: false, why: `Sketch ${name}(t) first, before and after t = 0.` };
  if (!pre) return { ok: false, why: 'Your sketch has nothing before t = 0. Where does it sit at 0−?' };
  if (post < 0.6) return { ok: false, why: `Your sketch covers ${Math.round(post * 100)}% of the window after t = 0. Carry it to the right edge.` };
  return { ok: true, why: '' };
}

/** Reads 0-, 0+, infinity and tau off a sketch and scores them against the solution. */
export function scoreSketch(strokes, s) {
  const T = s.tstop, top = s.top;
  const at = (x) => sketchAt(strokes, x);
  const pre = lin(-0.13 * T, -0.02 * T, 8).map(at).filter((y) => y !== null);
  const s0m = pre.length ? median(pre) : null;
  let s0p = null;
  for (const f of [0.004, 0.008, 0.015, 0.025, 0.04]) { const y = at(f * T); if (y !== null) { s0p = y; break; } }
  const tail = lin(0.9 * T, T, 8).map(at).filter((y) => y !== null);
  const sinf = tail.length ? median(tail) : null;

  // tau: where the sketch first crosses 63.2 % of the way from its own 0+ to its own final value.
  let stau = null;
  const jump = Math.abs(s.xinf - s.x0p) > 0.02 * top;
  if (jump && s0p !== null && sinf !== null && Math.abs(sinf - s0p) > 0.02 * top) {
    const level = s0p + (1 - Math.exp(-1)) * (sinf - s0p);
    const xs = lin(0.004 * T, T, 400);
    let prev = null;
    for (const x of xs) {
      const y = at(x);
      if (y === null) { prev = null; continue; }
      if (prev && (prev[1] - level) * (y - level) <= 0) {
        stau = prev[1] === y ? x : prev[0] + ((level - prev[1]) * (x - prev[0])) / (y - prev[1]);
        break;
      }
      prev = [x, y];
    }
  }

  let sq = 0, n = 0;
  for (const x of lin(0.01 * T, T, 120)) { const y = at(x); if (y !== null) { sq += (y - firstOrderAt(s, x)) ** 2; n++; } }
  const rms = n ? Math.sqrt(sq / n) / top : null;

  const lv = (pred, truth) => (pred === null ? null : Math.abs(pred - truth) / top);
  const rows = [
    { key: '0−', pred: s0m, truth: s.x0m, err: lv(s0m, s.x0m) },
    { key: '0+', pred: s0p, truth: s.x0p, err: lv(s0p, s.x0p) },
    { key: '∞', pred: sinf, truth: s.xinf, err: lv(sinf, s.xinf) },
  ].map((r) => ({ ...r, grade: grade(r.err, TOL.level) }));
  const tauErr = jump && stau !== null ? Math.abs(stau / s.tau - 1) : null;
  rows.push({ key: 'τ', pred: stau, truth: s.tau, err: tauErr, grade: jump ? grade(tauErr, TOL.tau) : 'none', ratio: stau !== null ? stau / s.tau : null, flat: !jump });
  rows.push({ key: 'shape', pred: null, truth: null, err: rms, grade: grade(rms, TOL.rms) });
  return rows;
}

// ---------------------------------------------------------------- AC

const C = {
  mag: (z) => Math.hypot(z[0], z[1]),
  deg: (z) => (Math.atan2(z[1], z[0]) * 180) / Math.PI,
  sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  scale: (a, k) => [a[0] * k, a[1] * k],
};
export const cplx = C;

/** Every phasor at f Hz, the source being V1's value as amplitude at 0 degrees. */
export function phasors(spec, vals, f) {
  const els = parse(spec.net(vals));
  const src = els.find((e) => e.k === 'V' && !e.name.includes('#'));
  const r = acop(els, src.name, f);
  const w = 2 * Math.PI * f;
  const A = src.v;
  const rows = [{ name: src.name, kind: 'V', v: [A, 0], i: C.scale(C.mul([-1, 0], r.i(src.name)), A) }];
  for (const e of els) {
    if (!'RLC'.includes(e.k)) continue;
    const v = C.scale(C.sub(r.v(e.n[0]), r.v(e.n[1])), A);
    const i = e.k === 'R' ? C.scale(v, 1 / e.v) : e.k === 'C' ? C.mul([0, w * e.v], v) : C.scale(r.i(e.name), A);
    rows.push({ name: e.name, kind: e.k, v, i });
  }
  const out = spec.out.kind === 'node' ? C.scale(r.v(spec.out.node), A) : rows.find((x) => x.name === spec.out.el).v;
  return { f, w, amp: A, rows, out };
}

/** H(f) = V_o / V_s over 4 decades, with the characteristic frequency inside the middle decades. */
export function bode(spec, vals, n = 241) {
  const fc = spec.fc(vals);
  const flo = 10 ** (Math.floor(Math.log10(fc)) - 2);
  const fhi = flo * 1e4;
  const els = parse(spec.net(vals));
  const src = els.find((e) => e.k === 'V' && !e.name.includes('#'));
  const oel = spec.out.kind === 'v' ? els.find((e) => e.name === spec.out.el) : null;
  const pts = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const f = flo * 10 ** ((4 * i) / (n - 1));
    const r = acop(els, src.name, f);
    const h = oel ? C.sub(r.v(oel.n[0]), r.v(oel.n[1])) : r.v(spec.out.node);
    let ph = C.deg(h);
    if (prev !== null) { while (ph - prev > 180) ph -= 360; while (ph - prev < -180) ph += 360; }
    prev = ph;
    pts.push({ f, db: 20 * Math.log10(Math.max(C.mag(h), 1e-12)), ph });
  }
  return { fc, flo, fhi, pts };
}

/** A frequency for the phasor step: a standard value between fc / 3 and 3 fc. */
export function phasorFreq(spec, vals, r) {
  const fc = spec.fc(vals);
  const c = [];
  for (let k = Math.floor(Math.log10(fc / 3)) - 1; k <= Math.ceil(Math.log10(3 * fc)); k++) {
    for (const m of [1, 1.5, 2.2, 3.3, 4.7, 6.8]) { const v = +(m * 10 ** k).toPrecision(3); if (v >= fc / 3 && v <= 3 * fc) c.push(v); }
  }
  return c[Math.floor(r() * c.length)];
}

/** Scores a typed phasor prediction: relative magnitude error and wrapped phase error in degrees. */
export function scorePhasor(pred, out) {
  const mag = C.mag(out), ph = C.deg(out);
  const em = Math.abs(pred.mag - mag) / mag;
  let ep = pred.deg - ph;
  while (ep > 180) ep -= 360;
  while (ep <= -180) ep += 360;
  return [
    { key: '|V_o|', pred: pred.mag, truth: mag, err: em, grade: grade(em, TOL.mag) },
    { key: '∠V_o', pred: pred.deg, truth: ph, err: Math.abs(ep), grade: grade(Math.abs(ep), TOL.phase) },
  ];
}

/** Scores a Bode sketch (strokes in [f, value]) against the sweep: RMS and worst error where sketched. */
export function scoreBode(strokes, pts, key, tol) {
  let sq = 0, n = 0, worst = 0, at = null;
  for (const p of pts) {
    const y = sketchAt(strokes, p.f);
    if (y === null) continue;
    const e = Math.abs(y - p[key]);
    sq += e * e; n++;
    if (e > worst) { worst = e; at = p.f; }
  }
  const rms = n ? Math.sqrt(sq / n) : null;
  return { rms, worst: n ? worst : null, at, covered: n / pts.length, grade: grade(rms, tol) };
}

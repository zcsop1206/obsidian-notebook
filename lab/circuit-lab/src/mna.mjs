// A small MNA circuit solver (DC operating point, transient with a t=0 switch event, AC sweep). Written by a model.
// Netlist lines (SPICE-like): R/C/L/V/I name n1 n2 value; E (VCVS) name n+ n- nc+ nc- gain;
// G (VCCS) same; H (CCVS) name n+ n- ctrl gain; F (CCCS) name n+ n- ctrl gain, where ctrl is an element
// with a branch current (V, L, E, H, a closed switch) or R (a sense source is added);
// S name n1 n2 before after (1 closed, 0 open; t<0 then t>0); O name out in+ in- (ideal op amp).
// Values take SI suffixes: f p n u m k meg g. "ic=" on C or L overrides the t=0- value.
const SUF = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9 };
export function num(s) {
  const m = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(meg|[fpnumkg])?/i.exec(String(s).trim());
  if (!m) throw new Error(`bad value ${s}`);
  return parseFloat(m[1]) * (m[2] ? SUF[m[2].toLowerCase()] : 1);
}

export function parse(src) {
  const els = [];
  for (const raw of src.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    const name = t[0], k = name[0].toUpperCase();
    const kv = Object.fromEntries(t.filter(x => x.includes('=')).map(x => x.split('=')));
    const a = t.filter(x => !x.includes('='));
    if ('RCLVI'.includes(k)) els.push({ k, name, n: [a[1], a[2]], v: num(a[3]), ic: kv.ic !== undefined ? num(kv.ic) : undefined });
    else if (k === 'E' || k === 'G') els.push({ k, name, n: [a[1], a[2]], c: [a[3], a[4]], v: num(a[5]) });
    else if (k === 'H' || k === 'F') els.push({ k, name, n: [a[1], a[2]], ctrl: a[3], v: num(a[4]) });
    else if (k === 'S') els.push({ k, name, n: [a[1], a[2]], before: a[3] === '1', after: a[4] === '1' });
    else if (k === 'O') els.push({ k, name, n: [a[1], a[2], a[3]] });
    else throw new Error(`unknown element ${name}`);
  }
  // A current-controlled source controlled by a resistor: split the resistor with a 0 V sense source.
  for (const e of els) {
    if ((e.k === 'H' || e.k === 'F')) {
      const c = els.find(x => x.name === e.ctrl);
      if (!c) throw new Error(`${e.name}: no element ${e.ctrl}`);
      if (c.k === 'R') {
        const mid = `${c.name}#s`;
        els.push({ k: 'V', name: `${c.name}#sense`, n: [mid, c.n[1]], v: 0 });
        c.n = [c.n[0], mid];
        e.ctrl = `${c.name}#sense`;
      }
    }
  }
  return els;
}

// Dense Gaussian elimination with partial pivoting over real or complex ([re, im]) entries.
function solve(A, b, cplx) {
  const n = b.length;
  const abs = x => (cplx ? Math.hypot(x[0], x[1]) : Math.abs(x));
  const mul = (x, y) => (cplx ? [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]] : x * y);
  const sub = (x, y) => (cplx ? [x[0] - y[0], x[1] - y[1]] : x - y);
  const div = (x, y) => { if (!cplx) return x / y; const d = y[0] * y[0] + y[1] * y[1]; return [(x[0] * y[0] + x[1] * y[1]) / d, (x[1] * y[0] - x[0] * y[1]) / d]; };
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (abs(A[r][c]) > abs(A[p][c])) p = r;
    if (abs(A[p][c]) < 1e-18) throw new Error('singular circuit (a floating node or a loop of voltage sources?)');
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = div(A[r][c], A[c][c]);
      if (abs(f) === 0) continue;
      for (let k = c; k < n; k++) A[r][k] = sub(A[r][k], mul(f, A[c][k]));
      b[r] = sub(b[r], mul(f, b[c]));
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s = sub(s, mul(A[r][k], x[k]));
    x[r] = div(s, A[r][r]);
  }
  return x;
}

// One linear solve. mode: 'dc' (C open, L short), 'tran' (trapezoid or backward Euler companions), 'ac' (complex, at w).
function system(els, mode, opt) {
  const nodes = new Map();
  const node = s => (s === '0' || s.toLowerCase() === 'gnd' ? -1 : (nodes.has(s) ? nodes.get(s) : (nodes.set(s, nodes.size), nodes.size - 1)));
  for (const e of els) for (const s of [...e.n, ...(e.c || [])]) node(s);
  const sw = e => (opt.t < 0 ? e.before : e.after);
  const branch = new Map();
  let nb = nodes.size;
  for (const e of els) if ('VEHO'.includes(e.k) || e.k === 'L' || (e.k === 'S' && sw(e))) branch.set(e.name, nb++);
  const cplx = mode === 'ac';
  const Z = () => (cplx ? [0, 0] : 0);
  const A = Array.from({ length: nb }, () => Array.from({ length: nb }, Z));
  const b = Array.from({ length: nb }, Z);
  const add = (r, c, v) => { if (r < 0 || c < 0) return; A[r][c] = cplx ? [A[r][c][0] + (v[0] ?? v), A[r][c][1] + (v[1] ?? 0)] : A[r][c] + v; };
  const addb = (r, v) => { if (r < 0) return; b[r] = cplx ? [b[r][0] + (v[0] ?? v), b[r][1] + (v[1] ?? 0)] : b[r] + v; };
  const G = (p, q, g) => { add(p, p, g); add(q, q, g); add(p, q, cplx ? [-(g[0] ?? g), -(g[1] ?? 0)] : -g); add(q, p, cplx ? [-(g[0] ?? g), -(g[1] ?? 0)] : -g); };
  const I = (p, q, i) => { addb(p, cplx ? [-(i[0] ?? i), -(i[1] ?? 0)] : -i); addb(q, i); }; // current i flows p -> q through the element
  for (let k = 0; k < nodes.size; k++) add(k, k, 1e-12); // gmin: no floating node is singular
  const neg = v => (cplx ? [-(v[0] ?? v), -(v[1] ?? 0)] : -v);
  for (const e of els) {
    const [p, q] = e.n.map(node);
    const br = branch.get(e.name);
    if (e.k === 'R') G(p, q, 1 / e.v);
    else if (e.k === 'C') {
      if (mode === 'ac') G(p, q, [0, opt.w * e.v]);
      else if (mode === 'tran') { const g = (opt.be ? 1 : 2) * e.v / opt.h; const st = opt.prev[e.name]; G(p, q, g); I(p, q, -(g * st.v + (opt.be ? 0 : st.i))); }
    } else if (e.k === 'L') {
      add(p, br, 1); add(q, br, -1); add(br, p, 1); add(br, q, -1);
      if (mode === 'ac') add(br, br, [0, -opt.w * e.v]);
      else if (mode === 'tran') { const r = (opt.be ? 1 : 2) * e.v / opt.h; const st = opt.prev[e.name]; add(br, br, -r); addb(br, -r * st.i - (opt.be ? 0 : st.v)); }
    } else if (e.k === 'V' || (e.k === 'S' && sw(e))) {
      add(p, br, 1); add(q, br, -1); add(br, p, 1); add(br, q, -1);
      if (e.k === 'V') addb(br, mode === 'ac' ? (opt.src === e.name ? [1, 0] : [0, 0]) : e.v);
    } else if (e.k === 'I') { if (mode === 'ac') { if (opt.src === e.name) I(p, q, [1, 0]); } else I(p, q, e.v); }
    else if (e.k === 'E') { const [cp, cq] = e.c.map(node); add(p, br, 1); add(q, br, -1); add(br, p, 1); add(br, q, -1); add(br, cp, neg(e.v)); add(br, cq, e.v); }
    else if (e.k === 'G') { const [cp, cq] = e.c.map(node); add(p, cp, e.v); add(p, cq, neg(e.v)); add(q, cp, neg(e.v)); add(q, cq, e.v); }
    else if (e.k === 'H') { const cb = branch.get(e.ctrl); add(p, br, 1); add(q, br, -1); add(br, p, 1); add(br, q, -1); add(br, cb, neg(e.v)); }
    else if (e.k === 'F') { const cb = branch.get(e.ctrl); add(p, cb, e.v); add(q, cb, neg(e.v)); }
    else if (e.k === 'O') { const [o, ip, im] = e.n.map(node); add(o, br, 1); add(br, ip, 1); add(br, im, -1); }
  }
  const x = solve(A, b, cplx);
  const v = s => { const k = node(s); return k < 0 ? (cplx ? [0, 0] : 0) : x[k]; };
  const i = name => x[branch.get(name)];
  return { v, i, nodes };
}

const vdiff = (r, e) => r.v(e.n[0]) - r.v(e.n[1]);

/** DC operating point; t < 0 uses the switches' before state. */
export function op(els, t = -1) { return system(els, 'dc', { t }); }

/** Transient from 0+ to tstop: the 0- operating point sets every v_C and i_L (unless ic= is given). */
export function tran(els, tstop, steps = 2000, probes = []) {
  const r0 = op(els, -1);
  const prev = {};
  for (const e of els) {
    if (e.k === 'C') prev[e.name] = { v: e.ic ?? vdiff(r0, e), i: 0 };
    if (e.k === 'L') prev[e.name] = { i: e.ic ?? r0.i(e.name), v: 0 };
  }
  const h = tstop / steps, out = [];
  for (let s = 1; s <= steps; s++) {
    const t = s * h;
    const r = system(els, 'tran', { t, h, prev, be: s <= 2 });
    for (const e of els) {
      if (e.k === 'C') { const v = vdiff(r, e); const g = (s <= 2 ? 1 : 2) * e.v / h; prev[e.name] = { v, i: g * (v - prev[e.name].v) - (s <= 2 ? 0 : prev[e.name].i) }; }
      if (e.k === 'L') prev[e.name] = { i: r.i(e.name), v: vdiff(r, e) };
    }
    out.push([t, ...probes.map(p => p(r))]);
  }
  return { r0, out };
}

/** AC transfer v(outp)/(unit source src) at f Hz. */
export function ac(els, src, outp, f) {
  const r = system(els, 'ac', { w: 2 * Math.PI * f, src, t: 1 });
  const v = r.v(outp);
  return { mag: Math.hypot(v[0], v[1]), phase: Math.atan2(v[1], v[0]) * 180 / Math.PI };
}

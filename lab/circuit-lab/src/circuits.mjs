// The lab's circuits: invented topologies, each with a netlist (mna.mjs syntax), the standard values it
// draws each round, what it probes, and its schematic layout on a grid (schematic.mjs). Written by a model.
// None of these is a course problem.
//
// Schematic parts are named as in the netlist. A two-terminal part runs from a to b, and a is the netlist's
// first node (n+), so a source's + end, a current source's arrow tail and a probe's + mark sit at a.

export const E6 = [1, 1.5, 2.2, 3.3, 4.7, 6.8];
export const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
export const SOURCES = [5, 6, 9, 10, 12, 15, 18, 20, 24];

/** mulberry32: a small seeded generator, so a round can be replayed from its seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard values of a series within [lo, hi]. */
export function series(name, lo, hi) {
  const base = name === 'E6' ? E6 : E12;
  const out = [];
  for (let d = Math.floor(Math.log10(lo)) - 1; d <= Math.ceil(Math.log10(hi)); d++) {
    for (const m of base) {
      const v = +(m * 10 ** d).toPrecision(3);
      if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v);
    }
  }
  return out;
}

const pick = (r, a) => a[Math.floor(r() * a.length)];

/** Draws a value for every key of spec.draw from the seed; retries until spec.ok accepts the set. */
export function drawValues(spec, seed) {
  const r = rng(seed);
  for (let tries = 0; tries < 500; tries++) {
    const v = {};
    for (const [k, d] of Object.entries(spec.draw)) {
      v[k] = d[0] === 'list' ? pick(r, d[1]) : pick(r, series(d[0], d[1], d[2]));
    }
    if (!spec.ok || spec.ok(v)) return v;
  }
  throw new Error(`no value draw satisfies ${spec.id}`);
}

/** The unit of each element kind, for labels. Dependent sources carry their own (see gainUnit). */
export const UNIT = { R: 'Ω', C: 'F', L: 'H', V: 'V', I: 'A' };

const R = (lo = 1e3, hi = 10e3) => ['E12', lo, hi];
const C = (lo = 1e-6, hi = 10e-6) => ['E6', lo, hi];
const L = (lo = 10e-3, hi = 100e-3) => ['E6', lo, hi];
const VS = ['list', SOURCES];

// ---------------------------------------------------------------- switching (first order)

export const SWITCHING = [
  {
    id: 'rc-charge',
    title: 'RC, switch closes',
    draw: { V1: VS, R1: R(), C1: C(), R2: R() },
    net: (v) => `V1 s 0 ${v.V1}\nR1 s a ${v.R1}\nS1 a b 0 1\nC1 b 0 ${v.C1}\nR2 b 0 ${v.R2}`,
    probe: { kind: 'v', el: 'C1', name: 'v_C', unit: 'V' },
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'R1', a: [0, 0], b: [2, 0] },
        { n: 'S1', a: [2, 0], b: [3, 0], sw: 'close' },
        { n: 'C1', a: [3, 0], b: [3, 2] },
        { n: 'R2', a: [5, 0], b: [5, 2] },
      ],
      wires: [[[3, 0], [5, 0]], [[0, 2], [5, 2]]],
      dots: [[3, 0], [3, 2]],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'rc-handover',
    title: 'RC, capacitor handed to a new load',
    draw: { V1: VS, R1: R(), C1: C(), R2: R(), R3: R() },
    net: (v) => `V1 s 0 ${v.V1}\nR1 s x ${v.R1}\nS1 x a 1 0\nS2 a y 0 1\nC1 a 0 ${v.C1}\nR2 y 0 ${v.R2}\nR3 y 0 ${v.R3}`,
    probe: { kind: 'v', el: 'C1', name: 'v_C', unit: 'V' },
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'R1', a: [0, 0], b: [2, 0] },
        { spdt: ['S1', 'S2'], p: [3, 0.6], c1: [2.5, 0], c2: [3.5, 0] },
        { n: 'C1', a: [3, 0.6], b: [3, 2] },
        { n: 'R2', a: [5, 0], b: [5, 2] },
        { n: 'R3', a: [6.5, 0], b: [6.5, 2] },
      ],
      wires: [[[2, 0], [2.5, 0]], [[3.5, 0], [6.5, 0]], [[0, 2], [6.5, 2]]],
      dots: [[5, 0], [5, 2], [3, 2]],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'rl-open',
    title: 'RL, source switched out',
    draw: { V1: VS, R1: R(), L1: L(), R2: R(220, 4.7e3) },
    ok: (v) => v.R2 <= 2 * v.R1 && v.R2 >= 0.2 * v.R1,
    net: (v) => `V1 s 0 ${v.V1}\nS1 s p 1 0\nR1 p a ${v.R1}\nL1 a 0 ${v.L1}\nR2 a 0 ${v.R2}`,
    probe: { kind: 'v', el: 'R2', name: 'v_o', unit: 'V' },
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'S1', a: [0, 0], b: [1, 0], sw: 'open' },
        { n: 'R1', a: [1, 0], b: [3, 0] },
        { n: 'L1', a: [3, 0], b: [3, 2] },
        { n: 'R2', a: [5, 0], b: [5, 2] },
      ],
      wires: [[[3, 0], [5, 0]], [[0, 2], [5, 2]]],
      dots: [[3, 0], [3, 2]],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'rl-current',
    title: 'RL fed by a current source',
    draw: { I1: ['E6', 1e-3, 10e-3], R1: R(), L1: L(), R2: R() },
    net: (v) => `I1 0 a ${v.I1}\nR1 a 0 ${v.R1}\nS1 a b 0 1\nL1 b c ${v.L1}\nR2 c 0 ${v.R2}`,
    probe: { kind: 'i', el: 'L1', name: 'i_L', unit: 'A' },
    sch: {
      parts: [
        { n: 'I1', a: [0, 2], b: [0, 0], side: 'l' },
        { n: 'R1', a: [2, 0], b: [2, 2] },
        { n: 'S1', a: [2, 0], b: [3, 0], sw: 'close' },
        { n: 'L1', a: [3, 0], b: [5, 0] },
        { n: 'R2', a: [5, 0], b: [5, 2] },
      ],
      wires: [[[0, 0], [2, 0]], [[0, 2], [5, 2]]],
      dots: [[2, 0], [2, 2]],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'rc-cccs',
    title: 'RC with a current-controlled current source',
    draw: { V1: VS, R1: R(), C1: C(), R2: R(), F1: ['list', [0.5, 1, 2, 3]] },
    net: (v) => `V1 s 0 ${v.V1}\nS1 s a 0 1\nR1 a b ${v.R1}\nC1 b 0 ${v.C1}\nR2 b 0 ${v.R2}\nF1 0 b R1 ${v.F1}`,
    probe: { kind: 'v', el: 'C1', name: 'v_C', unit: 'V' },
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'S1', a: [0, 0], b: [1, 0], sw: 'close' },
        { n: 'R1', a: [1, 0], b: [3, 0], mark: { kind: 'i', name: 'i_x' } },
        { n: 'C1', a: [3, 0], b: [3, 2] },
        { n: 'R2', a: [4.6, 0], b: [4.6, 2] },
        { n: 'F1', a: [6.2, 2], b: [6.2, 0], gain: 'i_x' },
      ],
      wires: [[[3, 0], [6.2, 0]], [[0, 2], [6.2, 2]]],
      dots: [[3, 0], [4.6, 0], [3, 2], [4.6, 2]],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'rc-swap',
    title: 'RC, source swapped at t = 0',
    draw: { V1: VS, V2: VS, R1: R(), C1: C(), R2: R() },
    net: (v) => `V1 s1 0 ${v.V1}\nV2 0 s2 ${v.V2}\nS1 s1 a 1 0\nS2 s2 a 0 1\nR1 a b ${v.R1}\nC1 b 0 ${v.C1}\nR2 b 0 ${v.R2}`,
    probe: { kind: 'v', el: 'C1', name: 'v_C', unit: 'V' },
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'V2', a: [1.5, 2], b: [1.5, 0.5] },
        { spdt: ['S1', 'S2'], p: [2.6, 0], c1: [2, -0.5], c2: [2, 0.5] },
        { n: 'R1', a: [3, 0], b: [5, 0] },
        { n: 'C1', a: [5, 0], b: [5, 2] },
        { n: 'R2', a: [6.6, 0], b: [6.6, 2] },
      ],
      wires: [[[0, 0], [0, -0.5], [2, -0.5]], [[1.5, 0.5], [2, 0.5]], [[2.6, 0], [3, 0]], [[5, 0], [6.6, 0]], [[0, 2], [6.6, 2]]],
      dots: [[1.5, 2], [5, 2]],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'rl-ccvs',
    title: 'RL with a current-controlled voltage source',
    draw: { V1: VS, R1: R(), L1: L(), H1: ['E6', 100, 2.2e3] },
    net: (v) => `V1 s 0 ${v.V1}\nS1 s a 0 1\nR1 a b ${v.R1}\nL1 b c ${v.L1}\nH1 c 0 L1 ${v.H1}`,
    probe: { kind: 'i', el: 'L1', name: 'i_L', unit: 'A' },
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'S1', a: [0, 0], b: [1, 0], sw: 'close' },
        { n: 'R1', a: [1, 0], b: [3, 0] },
        { n: 'L1', a: [3, 0], b: [5, 0], side: 'b' },
        { n: 'H1', a: [5, 0], b: [5, 2], gain: 'i_L' },
      ],
      wires: [[[0, 2], [5, 2]]],
      dots: [],
      gnd: [[0, 2]],
    },
  },
];

// ---------------------------------------------------------------- AC (one source, cosine reference)

export const AC = [
  {
    id: 'ac-rc',
    title: 'RC low-pass',
    draw: { V1: VS, R1: R(), C1: ['E6', 10e-9, 1e-6] },
    net: (v) => `V1 in 0 ${v.V1}\nR1 in out ${v.R1}\nC1 out 0 ${v.C1}`,
    out: { kind: 'v', el: 'C1', name: 'V_o' },
    fc: (v) => 1 / (2 * Math.PI * v.R1 * v.C1),
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'R1', a: [0, 0], b: [2.5, 0] },
        { n: 'C1', a: [2.5, 0], b: [2.5, 2] },
      ],
      wires: [[[0, 2], [2.5, 2]]],
      dots: [],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'ac-rl',
    title: 'RL high-pass',
    draw: { V1: VS, R1: R(100, 2.2e3), L1: L(1e-3, 100e-3) },
    net: (v) => `V1 in 0 ${v.V1}\nR1 in out ${v.R1}\nL1 out 0 ${v.L1}`,
    out: { kind: 'v', el: 'L1', name: 'V_o' },
    fc: (v) => v.R1 / (2 * Math.PI * v.L1),
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'R1', a: [0, 0], b: [2.5, 0] },
        { n: 'L1', a: [2.5, 0], b: [2.5, 2] },
      ],
      wires: [[[0, 2], [2.5, 2]]],
      dots: [],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'ac-rlc',
    title: 'Series RLC band-pass',
    draw: { V1: VS, L1: L(1e-3, 100e-3), C1: ['E6', 10e-9, 1e-6], R1: ['E12', 10, 2.2e3] },
    net: (v) => `V1 in 0 ${v.V1}\nL1 in a ${v.L1}\nC1 a b ${v.C1}\nR1 b 0 ${v.R1}`,
    out: { kind: 'v', el: 'R1', name: 'V_o' },
    fc: (v) => 1 / (2 * Math.PI * Math.sqrt(v.L1 * v.C1)),
    // Q between 0.5 and 10, so the peak is neither invisible nor a spike off the plot.
    ok: (v) => { const q = Math.sqrt(v.L1 / v.C1) / v.R1; return q >= 0.5 && q <= 10; },
    sch: {
      parts: [
        { n: 'V1', a: [0, 0], b: [0, 2], side: 'l' },
        { n: 'L1', a: [0, 0], b: [2, 0] },
        { n: 'C1', a: [2, 0], b: [4, 0] },
        { n: 'R1', a: [4, 0], b: [4, 2] },
      ],
      wires: [[[0, 2], [4, 2]]],
      dots: [],
      gnd: [[0, 2]],
    },
  },
  {
    id: 'ac-opamp',
    title: 'Op-amp low-pass (inverting)',
    draw: { V1: ['list', [1, 2, 5]], R1: R(), R2: R(1e3, 47e3), C1: ['E6', 1e-9, 100e-9] },
    ok: (v) => v.R2 / v.R1 >= 0.5 && v.R2 / v.R1 <= 10,
    net: (v) => `V1 in 0 ${v.V1}\nR1 in n ${v.R1}\nR2 n out ${v.R2}\nC1 n out ${v.C1}\nO1 out 0 n`,
    out: { kind: 'node', node: 'out', name: 'V_o' },
    fc: (v) => 1 / (2 * Math.PI * v.R2 * v.C1),
    sch: {
      parts: [
        { n: 'V1', a: [0, 1.25], b: [0, 3], side: 'l' },
        { n: 'R1', a: [0, 1.25], b: [2.4, 1.25], side: 'b' },
        { n: 'R2', a: [2.4, 0.4], b: [4.6, 0.4] },
        { n: 'C1', a: [2.4, -0.8], b: [4.6, -0.8] },
        { opamp: 'O1', at: [3.5, 1.5] },
      ],
      wires: [
        [[2.4, 1.25], [3, 1.25]],
        [[2.4, 1.25], [2.4, -0.8]],
        [[4.6, -0.8], [4.6, 1.5]],
        [[4, 1.5], [5.4, 1.5]],
        [[3, 1.75], [2.8, 1.75], [2.8, 3]],
        [[0, 3], [2.8, 3]],
      ],
      dots: [[2.4, 1.25], [2.4, 0.4], [4.6, 0.4], [4.6, 1.5]],
      gnd: [[0, 3]],
      terminals: [{ at: [5.4, 1.5], name: 'v_o' }],
    },
  },
];

export const ALL = [...SWITCHING, ...AC];
export const byId = (id) => ALL.find((s) => s.id === id);

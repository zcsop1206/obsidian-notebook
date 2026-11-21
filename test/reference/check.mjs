// Checks lab/circuit-lab/src/mna.mjs on 15 numbers. The circuits are invented and model-written: four drills
// (d-mesh, d-thevenin, d-rl, d-rc) from a model-written study doc, and three textbook-shape cases. None is a
// course problem. Run: node test/reference/check.mjs (exit 1 on any failure).
import { parse, op, tran, ac } from '../../lab/circuit-lab/src/mna.mjs';

let fails = 0;
const near = (name, got, want, tol = 1e-3) => {
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got.toPrecision(6)} (want ${want.toPrecision(6)})`);
};
const t0 = performance.now();

// d-mesh: i1 through R4 (a to b), i2 through R2 (b to c); the dependent source 3 i1 has + at c.
{
  const els = parse(`V1 a 0 20
R4 a b 4
R6 b 0 6
R2 b c 2
H1 c 0 R4 3`);
  const r = op(els, 1);
  const i1 = r.i('R4#sense');
  const i2 = (r.v('b') - r.v('c')) / 2;
  near('d-mesh i1', i1, 80 / 31);
  near('d-mesh i2', i2, 30 / 31);
  near('d-mesh P absorbed by 3i1', r.v('c') * i2, 7200 / 961);
}

// d-thevenin: Voc, Isc, Rth.
{
  const base = `V1 in 0 10
R1 in a 2
R2 a 0 4
G1 a 0 a 0 0.25`;
  const voc = op(parse(base), 1).v('a');
  const isc = op(parse(`${base}\nVsc a 0 0`), 1).i('Vsc');
  near('d-thevenin Voc', voc, 5);
  near('d-thevenin Isc', isc, 5);
  near('d-thevenin Rth', voc / isc, 1);
}

// d-rl: 2 A at 0-, a loop with 10 ohm and 4 i_L dropping along i_L; then flipped.
for (const [flip, rate] of [[false, 280], [true, 120]]) {
  const els = parse(`L1 a 0 50m ic=2
R1 0 b 10
H1 ${flip ? 'a b' : 'b a'} L1 4`);
  const tau = 1 / rate;
  const { out } = tran(els, 3 * tau, 3000, [r => r.i('L1')]);
  const at = out[999];
  near(`d-rl${flip ? ' flipped' : ''} i_L(tau)`, at[1], 2 / Math.E);
}

// d-rc: 2 uF charged from 15 V through 5k; at 0 it moves to 3k || 6k.
{
  const els = parse(`V1 s 0 15
R1 s x 5k
S2 x a 1 0
C1 a 0 2u
S1 a y 0 1
R3 y 0 3k
R6 y 0 6k`);
  const { r0, out } = tran(els, 8e-3, 4000, [r => r.v('a'), r => r.v('y') / 6000]);
  near('d-rc v_C(0-)', r0.v('a'), 15);
  near('d-rc i_6k(0+)', out[0][2], 2.5e-3, 5e-3);
  const cross = out.find(p => p[1] <= 5)[0];
  near('d-rc time to 5 V (ms)', cross * 1e3, 4 * Math.log(3), 2e-3);
}

// Second order: series RLC switched onto 10 V; underdamped peak at pi/wd.
{
  const els = parse(`V1 s 0 10
S1 s a 0 1
R1 a b 2
L1 b c 1m
C1 c 0 10u`);
  const { out } = tran(els, 1e-3, 4000, [r => r.v('c')]);
  const peak = Math.max(...out.map(p => p[1]));
  const wd = Math.sqrt(1e8 - 1e6);
  near('RLC step peak v_C', peak, 10 * (1 + Math.exp(-1000 * Math.PI / wd)), 2e-3);
}

// AC: RC low-pass at its corner; ideal inverting op amp at DC.
{
  const els = parse(`V1 in 0 1
R1 in out 1k
C1 out 0 1u`);
  const h = ac(els, 'V1', 'out', 1 / (2 * Math.PI * 1e-3));
  near('RC low-pass |H(fc)|', h.mag, Math.SQRT1_2);
  near('RC low-pass phase(fc)', h.phase, -45);
  const oa = op(parse(`V1 in 0 1
R1 in n 1k
R2 n out 10k
O1 out 0 n`), 1);
  near('inverting amp v_out', oa.v('out'), -10);
}

console.log(`${fails} failure(s), ${(performance.now() - t0).toFixed(0)} ms`);
process.exit(fails ? 1 : 0);

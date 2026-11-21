// node --test lab/circuit-lab/test/draws.test.mjs
// Every topology solves for 20 seeded value draws, the solver's curve agrees with the exact first-order
// response, the axes hold every level, a perfect sketch scores ok on every row, and AC phasors agree with
// the sweep. Also: every netlist element is drawn in its schematic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SWITCHING, AC, drawValues, rng } from '../src/circuits.mjs';
import { parse } from '../src/mna.mjs';
import { solveSwitching, firstOrderAt, scoreSketch, sketchReady, phasors, bode, scorePhasor, scoreBode, phasorFreq, pickWindow, up125, cplx } from '../src/analysis.mjs';

const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + 37 * i);

test('1-2-5 helpers', () => {
  assert.equal(up125(13), 20);
  assert.equal(up125(20), 20);
  assert.equal(up125(0.0031), 0.005);
  for (const tau of [1e-6, 3.3e-5, 4.7e-3, 0.1, 2.2]) {
    const w = pickWindow(tau);
    assert.ok(w >= 3 * tau * 0.999 && w <= 8 * tau * 1.001, `window ${w} for tau ${tau}`);
  }
});

for (const spec of SWITCHING) {
  test(`${spec.id}: 20 draws solve, curve matches the exact response, perfect sketch scores ok`, () => {
    for (const seed of SEEDS) {
      const vals = drawValues(spec, seed);
      const s = solveSwitching(spec, vals);
      for (const k of ['x0m', 'x0p', 'xinf', 'tau', 'rth']) assert.ok(Number.isFinite(s[k]), `${spec.id} seed ${seed}: ${k} = ${s[k]}`);
      assert.ok(s.tau > 0);
      const reach = Math.max(Math.abs(s.x0m), Math.abs(s.x0p), Math.abs(s.xinf));
      assert.ok(reach <= 0.96 * s.top, `${spec.id} seed ${seed}: reach ${reach} vs top ${s.top}`);
      assert.ok(Math.abs(s.x0p - s.xinf) > 0.02 * s.top, `${spec.id} seed ${seed}: no visible transient`);
      for (const [t, x] of s.curve) {
        if (t <= 0) continue;
        assert.ok(Math.abs(x - firstOrderAt(s, t)) <= 0.01 * s.top, `${spec.id} seed ${seed} t ${t}: ${x} vs ${firstOrderAt(s, t)}`);
      }
      const perfect = [[[-0.15 * s.tstop, s.x0m], [0, s.x0m]], Array.from({ length: 200 }, (_, i) => { const t = (s.tstop * i) / 199; return [t, firstOrderAt(s, t)]; })];
      assert.ok(sketchReady(perfect, s).ok);
      for (const row of scoreSketch(perfect, s)) assert.equal(row.grade, 'ok', `${spec.id} seed ${seed} ${row.key}: ${row.err}`);
      // x2 on every element still solves.
      for (const k of Object.keys(vals)) for (const f of [0.5, 2]) solveSwitching(spec, { ...vals, [k]: vals[k] * f }, { tstop: s.tstop, top: s.top });
    }
  });
}

test('a wrong sketch is not scored ok, and a sketch without 0- is refused', () => {
  const spec = SWITCHING[0];
  const s = solveSwitching(spec, drawValues(spec, 7));
  const flat = [[[-0.15 * s.tstop, 0], [s.tstop, 0]]];
  const rows = scoreSketch(flat, s);
  assert.notEqual(rows.find((r) => r.key === '∞').grade, 'ok');
  assert.equal(sketchReady([[[0, 0], [s.tstop, 1]]], s).ok, false);
  assert.equal(sketchReady([], s).ok, false);
});

for (const spec of AC) {
  test(`${spec.id}: 20 draws give finite phasors that match the sweep, KVL holds, perfect predictions score ok`, () => {
    for (const seed of SEEDS) {
      const vals = drawValues(spec, seed);
      const f = phasorFreq(spec, vals, rng(seed));
      assert.ok(f >= spec.fc(vals) / 3 && f <= 3 * spec.fc(vals));
      const p = phasors(spec, vals, f);
      for (const r of p.rows) for (const z of [r.v, r.i]) assert.ok(z.every(Number.isFinite), `${spec.id} seed ${seed} ${r.name}`);
      const sc = scorePhasor({ mag: cplx.mag(p.out), deg: cplx.deg(p.out) }, p.out);
      assert.ok(sc.every((r) => r.grade === 'ok'));
      const b = bode(spec, vals);
      assert.ok(b.pts.every((q) => Number.isFinite(q.db) && Number.isFinite(q.ph)));
      // The sweep at f agrees with the phasor step's |V_o| / V_s.
      const one = b.pts[Math.floor(b.pts.length / 2) + (seed % 50)];
      const q = phasors(spec, vals, one.f);
      assert.ok(Math.abs(one.db - 20 * Math.log10(cplx.mag(q.out) / q.amp)) < 1e-6, `${spec.id} seed ${seed}: sweep vs phasor`);
      const perfect = [b.pts.map((q) => [q.f, q.db])];
      assert.equal(scoreBode(perfect, b.pts, 'db', [3, 6]).grade, 'ok');
    }
  });
}

test('series RLC: KVL around the loop, and |H| = 1 at f0', () => {
  const spec = AC.find((s) => s.id === 'ac-rlc');
  const vals = drawValues(spec, 3);
  const f0 = spec.fc(vals);
  const p = phasors(spec, vals, f0);
  const sum = p.rows.filter((r) => r.kind !== 'V').reduce((a, r) => [a[0] + r.v[0], a[1] + r.v[1]], [0, 0]);
  assert.ok(Math.hypot(sum[0] - p.amp, sum[1]) < 1e-6 * p.amp);
  assert.ok(Math.abs(cplx.mag(p.out) / p.amp - 1) < 1e-6);
});

test('op-amp low-pass: DC gain -R2/R1 and -3 dB at fc', () => {
  const spec = AC.find((s) => s.id === 'ac-opamp');
  const vals = drawValues(spec, 11);
  const lo = phasors(spec, vals, spec.fc(vals) / 1e4);
  assert.ok(Math.abs(lo.out[0] / lo.amp + vals.R2 / vals.R1) < 1e-3 * vals.R2 / vals.R1);
  const at = phasors(spec, vals, spec.fc(vals));
  assert.ok(Math.abs(cplx.mag(at.out) / at.amp - (vals.R2 / vals.R1) * Math.SQRT1_2) < 1e-6 * vals.R2 / vals.R1);
});

test('every netlist element is drawn in its schematic', () => {
  for (const spec of [...SWITCHING, ...AC]) {
    const drawn = new Set(spec.sch.parts.flatMap((p) => p.spdt || [p.n || p.opamp]));
    for (const e of parse(spec.net(drawValues(spec, 1)))) {
      if (e.name.includes('#')) continue;
      assert.ok(drawn.has(e.name), `${spec.id}: ${e.name} is not drawn`);
    }
  }
});

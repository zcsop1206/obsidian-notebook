/**
 * The kata vector runner: runs a design (the Verilog subset in verilog.ts) against the `vectors`
 * block of a kata doc, exactly as FORMAT.md defines it: the inputs of a row are applied, one rising
 * edge of clk happens, then the outputs are sampled and compared. `x` is don't care; the run stops
 * at the first mismatch and reports the cycle, the signal, the expected and the actual value.
 *
 * An input cell of `x` leaves the input at its last driven value (the value does not matter). A
 * compile or port error is not a run: the result carries `error` instead of a mismatch. The trace
 * of every cycle up to and including the mismatch feeds the small waveform the block draws.
 */
import type { KataPort, Vectors } from '../types';
import { compile, createSim, fail } from './verilog';

declare const BigInt: (value: number | string | bigint | boolean) => bigint;
/* The ES2018 lib has no BigInt interface, so the radix toString is undeclared; the web view's real
   BigInt has it. */
declare global {
  interface BigInt {
    toString(radix?: number): string;
  }
}

export interface VectorMismatch {
  /** 1-based count of vector rows after the header (FORMAT.md). */
  cycle: number;
  /** The row's line number inside the `vectors` block, for finding it in the file. */
  line: number;
  signal: string;
  expected: bigint;
  actual: bigint;
}

export interface TraceCycle {
  /** Input column -> value the sim held after the row's inputs were applied (x rows keep the last). */
  inputs: Map<string, bigint>;
  /** Output column -> sampled value after the rising edge. */
  outputs: Map<string, bigint>;
  /** Output column -> expected value, or null for x. */
  expected: Map<string, bigint | null>;
}

export interface VectorRun {
  /** True when every row matched: a pass. False with `error` = not a run (compile or port error);
      false with `mismatch` = a failed run. */
  ok: boolean;
  error?: string;
  /** The design source line of a compile error, for the editor gutter. */
  line?: number;
  /** The port a port-shape error names. */
  port?: string;
  mismatch?: VectorMismatch;
  /** One entry per executed row, ending at the mismatch (or at the last row on a pass). */
  trace: TraceCycle[];
  /** The number of vector rows (the length of a full run). */
  cycles: number;
}

export function runVectors(ports: KataPort[], vectors: Vectors, src: string): VectorRun {
  let M;
  try { M = compile(src); } catch (e) {
    const f = fail(e);
    return { ok: false, error: f.error, line: f.line, trace: [], cycles: vectors.rows.length };
  }
  for (const pd of ports) {
    const s = M.sigs.get(pd.name);
    if (!s || s.dir !== pd.dir || s.w !== pd.width) {
      return {
        ok: false, trace: [], cycles: vectors.rows.length, port: pd.name,
        error: `port '${pd.name}' must be ${pd.dir}${pd.width > 1 ? ` [${pd.width - 1}:0]` : ''}, as in the ports block`,
      };
    }
  }
  /* The header names ports only; clk is implicit (FORMAT.md). */
  for (const name of vectors.inputs) {
    const p = ports.find(x => x.name === name);
    if (name === 'clk' || !p || p.dir !== 'input') {
      return { ok: false, trace: [], cycles: vectors.rows.length, error: `vectors: '${name}' is not an input port of this kata` };
    }
  }
  for (const name of vectors.outputs) {
    const p = ports.find(x => x.name === name);
    if (!p || p.dir !== 'output') {
      return { ok: false, trace: [], cycles: vectors.rows.length, error: `vectors: '${name}' is not an output port of this kata` };
    }
  }
  const parseCell = (v: string | null): bigint | null => (v === null ? null : BigInt(`0x${v}`));
  const trace: TraceCycle[] = [];
  let mismatch: VectorMismatch | null = null;
  try {
    const sim = createSim(M, 99);
    for (let t = 0; t < vectors.rows.length; t++) {
      const row = vectors.rows[t];
      vectors.inputs.forEach((name, i) => {
        const x = parseCell(row.inputs[i]);
        if (x !== null) sim.set(name, x);
      });
      sim.settle();
      const inputs = new Map<string, bigint>();
      vectors.inputs.forEach(name => { inputs.set(name, sim.get(name)); });
      sim.tick();
      const outputs = new Map<string, bigint>(), expected = new Map<string, bigint | null>();
      vectors.outputs.forEach((name, i) => {
        outputs.set(name, sim.get(name));
        expected.set(name, parseCell(row.outputs[i]));
      });
      trace.push({ inputs, outputs, expected });
      for (const name of vectors.outputs) {
        const e = expected.get(name)!, got = outputs.get(name)!;
        if (e !== null && e !== got) {
          mismatch = { cycle: t + 1, line: row.line, signal: name, expected: e, actual: got };
          break;
        }
      }
      if (mismatch) break;
    }
  } catch (e) {
    const f = fail(e);
    return { ok: false, error: f.error, line: f.line, trace, cycles: vectors.rows.length };
  }
  return { ok: !mismatch, mismatch: mismatch ?? undefined, trace, cycles: vectors.rows.length };
}

/* ------------------------------------------------------------------------------------------ *
 * Presentation helpers (shared by the block; pure so the unit tests can reach them)
 * ------------------------------------------------------------------------------------------ */

export function escH(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** A signal value as Verilog would write it: 1-bit bare, up to 4 bits binary, wider hex. */
export function fmtV(v: bigint | number | null | undefined, w: number): string {
  if (v === null || v === undefined) return '';
  const x = BigInt(v);
  if (w === 1) return String(x);
  if (w <= 4) {
    let s = x.toString(2);
    while (s.length < w) s = `0${s}`;
    return `${w}'b${s}`;
  }
  let s = x.toString(16).toUpperCase();
  while (s.length < Math.ceil(w / 4)) s = `0${s}`;
  return `${w}'h${s}`;
}

const CW = 26, RH = 28, LW = 102;

/**
 * The small waveform SVG around a run: cycles [a, b) of the trace. With a mismatch, its column is
 * shaded and the expected values of its signal get a row of their own. Colours are Obsidian theme
 * variables, so light and dark both work.
 */
export function waveSvg(ports: KataPort[], vectors: Vectors, tr: TraceCycle[], a: number, b: number, m?: VectorMismatch | null): string {
  const rows: { n: string; w: number; f: (c: TraceCycle) => bigint | null; exp?: boolean }[] = [];
  b = Math.min(b, tr.length);
  a = Math.max(0, Math.min(a, b));
  const widthOf = (name: string): number => ports.find(p => p.name === name)?.width ?? 1;
  vectors.inputs.forEach(n => { rows.push({ n, w: widthOf(n), f: c => c.inputs.get(n) ?? null }); });
  vectors.outputs.forEach(n => {
    rows.push({ n, w: widthOf(n), f: c => c.outputs.get(n) ?? null });
    if (m && m.signal === n) rows.push({ n: `${n} exp`, w: widthOf(n), f: c => c.expected.get(n) ?? null, exp: true });
  });
  const n = b - a, Wd = LW + n * CW + 8, H = 22 + rows.length * RH;
  let s = `<svg width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Waveform, cycles ${a + 1} to ${b}"` +
    ' style="display:block;font-family:var(--font-monospace);font-size:11px">';
  if (m) s += `<rect x="${LW + (m.cycle - 1 - a) * CW}" y="0" width="${CW}" height="${H}" style="fill:var(--text-error);opacity:.16"/>`;
  for (let c = a; c < b; c++) {
    const x = LW + (c - a) * CW;
    s += `<line x1="${x}" y1="16" x2="${x}" y2="${H}" style="stroke:var(--background-modifier-border);stroke-width:1"/>`;
    if ((c + 1) % 5 === 0 || c === 0) s += `<text x="${x + 2}" y="12" style="fill:var(--text-muted)">${c + 1}</text>`;
  }
  rows.forEach((r, ri) => {
    const y0 = 22 + ri * RH, hi = y0 + 4, lo = y0 + RH - 6;
    const col = r.exp ? 'var(--text-accent)' : 'var(--text-normal)';
    s += `<text x="4" y="${y0 + RH / 2 + 2}" style="fill:${r.exp ? 'var(--text-accent)' : 'var(--text-muted)'}">${escH(r.n)}</text>`;
    if (r.w === 1) {
      let pts = '';
      for (let cc = a; cc < b; cc++) {
        const vv = r.f(tr[cc]);
        const yy = vv === null ? (hi + lo) / 2 : vv ? hi : lo;
        const xx = LW + (cc - a) * CW;
        pts += `${xx},${yy} ${xx + CW},${yy} `;
      }
      s += `<polyline points="${pts}" style="fill:none;stroke:${col};stroke-width:1.6"/>`;
    } else {
      let c0 = a;
      while (c0 < b) {
        const v0 = r.f(tr[c0]);
        let c1 = c0 + 1;
        while (c1 < b && r.f(tr[c1]) === v0) c1++;
        const x0 = LW + (c0 - a) * CW + 1, x1 = LW + (c1 - a) * CW - 1, ym = (hi + lo) / 2;
        s += `<polygon points="${x0},${ym} ${x0 + 3},${hi} ${x1 - 3},${hi} ${x1},${ym} ${x1 - 3},${lo} ${x0 + 3},${lo}` +
          `" style="fill:none;stroke:${col};stroke-width:1.2"/>`;
        const lab = v0 === null ? 'x' : v0.toString(16).toUpperCase();
        let padded = lab;
        while (padded.length < Math.ceil(r.w / 4)) padded = `0${padded}`;
        if (v0 === null) padded = 'x';
        if (x1 - x0 > padded.length * 7 + 4) s += `<text x="${(x0 + x1) / 2}" y="${ym + 4}" text-anchor="middle" style="fill:${col}">${padded}</text>`;
        c0 = c1;
      }
    }
  });
  return `${s}</svg>`;
}

// The kata interpreter (src/study/kata/verilog.ts) and the vector runner
// (src/study/kata/vectors.ts), on the fixture kata test/fixtures/study/katas/k-fx.md.
// The designs here are invented for the tests; no reference design or kata test vector from the
// portfolio or the demo is ever committed (docs/study/BOARD.md, rule 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStudyDoc } from '../../src/study/format/parse';
import { compile, createSim, KataError, mask, normalize } from '../../src/study/kata/verilog';
import { fmtV, runVectors, waveSvg } from '../../src/study/kata/vectors';
import type { Vectors } from '../../src/study/types';

/* BigInt literals are not allowed by the ES2018 target; the function is. */
declare const BigInt: (value: number | string | bigint | boolean) => bigint;
const B = BigInt;

const K_FX = parseStudyDoc('study/katas/k-fx.md', readFileSync('test/fixtures/study/katas/k-fx.md', 'utf8')).kata!;

function simOf(src: string) {
  return createSim(compile(src), 99);
}
function compileErr(src: string): KataError {
  try { compile(src); } catch (e) { assert.ok(e instanceof KataError, `expected KataError, got ${e}`); return e as KataError; }
  throw new Error('expected a compile error');
}

test('normalize: curly quotes and no-break spaces read as plain ones', () => {
  assert.equal(normalize('a b c d e'), 'a b c d e');
  assert.equal(normalize('4’hF'), "4'hF");
  assert.equal(normalize('x\r\ny\rz'), 'x\ny\nz');
  // A design written with an iPad keyboard compiles: curly apostrophes in literals, NBSPs as spaces.
  const M = compile('module m(input clk, input rst, output reg q);\nalways @(posedge clk)\n  q <= rst ? 1’b0 : 1’b1;\nendmodule');
  assert.ok(M.sigs.has('q'));
});

test('literals and widths: sized, unsized, binary, octal, decimal, hex, underscores', () => {
  const s = simOf([
    'module m(input clk, output reg [7:0] a, output reg [3:0] b, output reg [31:0] c, output reg [3:0] d);',
    "always @(posedge clk) begin a <= 8'hA5; b <= 4'b1010; c <= 'd300; d <= 4'o17; end",
    'endmodule',
  ].join('\n'));
  s.settle(); s.tick();
  assert.equal(s.get('a'), B(0xA5));
  assert.equal(s.get('b'), B(0b1010));
  assert.equal(s.get('c'), B(300));
  assert.equal(s.get('d'), B(0o17));
});

test('widths follow the widest operand; literals mask to their width', () => {
  const s = simOf([
    'module m(input clk, output reg [3:0] a, output reg [7:0] b, output reg [7:0] c);',
    "always @(posedge clk) begin a <= 4'hFF + 4'd1; b <= 8'd300; c <= {4'hF, 4'h0} >> 4; end",
    'endmodule',
  ].join('\n'));
  s.settle(); s.tick();
  assert.equal(s.get('a'), B(0));          // 4'hFF + 1 in 4 bits wraps
  assert.equal(s.get('b'), B(44));         // 300 masked to 8 bits
  assert.equal(s.get('c'), B(0x0F));
});

test('concatenation, replication, part and bit selects', () => {
  const s = simOf([
    'module m(input clk, input [3:0] x, output reg [7:0] a, output reg [7:0] b, output reg [3:0] hi, output reg bit0, output reg [11:0] rep);',
    'always @(posedge clk) begin',
    "  a <= {x, x}; b <= {4{2'b10}}; hi <= {x[3:1], 1'b0}; bit0 <= x[0]; rep <= {3{x}};",
    'end',
    'endmodule',
  ].join('\n'));
  s.set('x', B(0xD)); s.settle(); s.tick();
  assert.equal(s.get('a'), B(0xDD));
  assert.equal(s.get('b'), B(0b10101010));
  assert.equal(s.get('hi'), B(0b1100));    // 1101 -> 110,0
  assert.equal(s.get('bit0'), B(1));
  assert.equal(s.get('rep'), B(0xDDD));
});

test('case with several labels and default; reductions; ternary', () => {
  const s = simOf([
    'module m(input clk, input [3:0] x, output reg [1:0] y, output reg r);',
    'always @(posedge clk) begin',
    '  case (x[1:0])',
    "    2'd0, 2'd2: y <= |x ? 2'd1 : 2'd2;",
    "    2'd1: y <= &x[3:0] ? 2'd3 : 2'd0;",
    "    default: y <= ^x ? 2'd2 : 2'd1;",
    '  endcase',
    "  r <= !x[3] && x[2] || x == 4'd15;",
    'end',
    'endmodule',
  ].join('\n'));
  s.set('x', B(0b0010)); s.settle(); s.tick();
  assert.equal(s.get('y'), B(1));          // x[1:0]=2, first label list hits; |x true
  assert.equal(s.get('r'), B(0));          // (!x[3] && x[2]) = 0; x != 15
  s.set('x', B(0xF)); s.settle(); s.tick();
  assert.equal(s.get('y'), B(1));          // x[1:0]=3 -> default; parity of 1111 is 0 -> 2'd1
  assert.equal(s.get('r'), B(1));
  s.set('x', B(0b0111)); s.settle(); s.tick();
  assert.equal(s.get('y'), B(2));          // x[1:0]=3 -> default; parity of 0111 is 1 -> 2'd2
});

test('nonblocking: two regs swap on one edge; bit and part-select assigns merge', () => {
  const s = simOf([
    'module m(input clk, input en, output reg [3:0] a, output reg [3:0] b);',
    'always @(posedge clk) begin',
    "  if (en) begin a <= b; b <= a; a[0] <= ~b[0]; b[3:2] <= 2'b01; end",
    'end',
    'endmodule',
  ].join('\n'));
  s.set('a', B(0)); s.set('b', B(0b1010)); s.set('en', B(1)); s.settle(); s.tick();
  // a <= b (1010), then a[0] <= ~b[0] (1) merges into the pending value.
  assert.equal(s.get('a'), B(0b1011));
  assert.equal(s.get('b'), B(0b0100));     // b <= a (0), then b[3:2] <= 01
});

test('an input cannot be reg or assigned; wires are not assigned in always', () => {
  assert.match(compileErr('module m(input reg clk); endmodule').message, /input cannot be reg/);
  assert.match(compileErr(['module m(input clk, input x, output reg y);',
    "always @(posedge clk) y <= x; assign x = 1'b0; endmodule"].join('\n')).message, /can't be driven/);
  assert.match(compileErr(['module m(input clk, input x, output y);',
    'always @(posedge clk) y <= x; endmodule'].join('\n')).message, /must be declared reg/);
});

test('blocking = inside always is an error; only posedge clk; synchronous reset', () => {
  assert.match(compileErr(['module m(input clk, input x, output reg y);',
    'always @(posedge clk) y = x; endmodule'].join('\n')).message, /nonblocking/);
  assert.match(compileErr(['module m(input clk, input x, output reg y);',
    'always @(negedge clk) y <= x; endmodule'].join('\n')).message, /only always @\(posedge clk\)/);
  assert.match(compileErr(['module m(input clk, input rst, input x, output reg y);',
    'always @(posedge clk or posedge rst) y <= x; endmodule'].join('\n')).message, /synchronous/);
});

test('errors carry line numbers; undeclared, undriven, x/z, unterminated comment', () => {
  const e1 = compileErr(['module m(input clk, input x, output reg y);',
    'always @(posedge clk) begin',
    '  y <= z;',
    'end endmodule'].join('\n'));
  assert.equal(e1.line, 3);
  assert.match(e1.message, /'z' is not declared/);
  assert.match(compileErr('module m(input clk, input x, output y); assign x = x; endmodule').message, /an input; it can't be driven/);
  assert.match(compileErr('module m(input clk, input x, output y); endmodule').message, /output 'y' is never driven/);
  assert.match(compileErr("module m(input clk, output reg [3:0] y); always @(posedge clk) y <= 4'bx1; endmodule").message, /x and z/);
  const e5 = compileErr('module m;\n/* never closed\ninput a;');
  assert.equal(e5.line, 2);
  const e6 = compileErr(['module m(input clk, input x, output reg y);',
    'always @(posedge clk) begin',
    '  y <= x;'].join('\n'));
  assert.equal(e6.line, 2);
  assert.match(e6.message, /'begin' has no matching 'end'/);
});

test('part-select out of range; redeclared signal; parameters and localparams in widths', () => {
  assert.match(compileErr(['module m(input clk, input [3:0] x, output reg y);',
    'always @(posedge clk) y <= x[7:0]; endmodule'].join('\n')).message, /outside 'x'/);
  assert.match(compileErr(['module m(input clk, input [3:0] x, output reg y);',
    'wire x; always @(posedge clk) y <= x[0]; endmodule'].join('\n')).message, /already declared/);
  const M = compile(['module m(input clk, input en, output reg [7:0] q);',
    'localparam W = 4;',
    'parameter H = W - 1;',
    'reg [H:0] half;',
    'always @(posedge clk) if (en) begin half <= q[3:0]; q <= {half, half}; end',
    'endmodule'].join('\n'));
  assert.equal(M.sigs.get('half')!.w, 4);
  const s = createSim(M, 5);
  s.set('en', B(1)); s.settle(); s.tick();  // the always body elaborates and runs
});

test('64-bit signals work past the number range', () => {
  const s = simOf(['module m(input clk, input en, output reg [63:0] q);',
    "always @(posedge clk) if (en) q <= {q[62:0], 1'b1};",
    'endmodule'].join('\n'));
  s.set('q', B(1)); s.set('en', B(1)); s.settle(); s.tick();
  assert.equal(s.get('q'), B(3));
  for (let i = 0; i < 62; i++) s.tick();
  assert.equal(s.get('q'), mask(64));
});

test('a combinational loop is reported when the assigns never settle', () => {
  const M = compile(['module m(input clk, input x, output y);',
    'wire a, b;',
    'assign a = ~b;',
    'assign b = a;',
    'assign y = a;',
    'endmodule'].join('\n'));
  const s = createSim(M, 1);
  s.set('x', B(1));
  assert.throws(() => s.settle(), /combinational loop/);
});

test('registers start random but masked; the seed makes it deterministic', () => {
  const src = 'module m(input clk, output reg [15:0] q); always @(posedge clk) q <= q; endmodule';
  const a = createSim(compile(src), 7), b = createSim(compile(src), 7);
  assert.equal(a.get('q'), b.get('q'));
  assert.ok(a.get('q') <= mask(16));
});

/* ---------------------------------------- the vector runner ---------------------------------------- */

/* q goes 0 -> 1 -> A -> A under en; rst clears (the fixture's invented vectors: en=x on row 3 is
   consistent under any reading, since f(1) = f(A) = A). */
const K_FX_OK = [
  'module k_fx(input clk, input rst, input en, output reg [3:0] q);',
  'always @(posedge clk) begin',
  "  if (rst) q <= 4'd0;",
  "  else if (en) q <= (q == 4'd0) ? 4'd1 : 4'hA;",
  'end',
  'endmodule',
].join('\n');

const K_FX_WRONG_LATE = [   // passes the first rows, fails the last
  'module k_fx(input clk, input rst, input en, output reg [3:0] q);',
  'always @(posedge clk) begin',
  "  if (rst) q <= 4'd0;",
  "  else if (en) q <= q + 4'd1;",
  'end',
  'endmodule',
].join('\n');

const K_FX_WRONG_EARLY = [  // no reset: fails the first row
  'module k_fx(input clk, input rst, input en, output reg [3:0] q);',
  'always @(posedge clk) begin',
  "  if (en) q <= 4'd1;",
  'end',
  'endmodule',
].join('\n');

test('vectors: a correct design passes the fixture kata', () => {
  const r = runVectors(K_FX.ports, K_FX.vectors!, K_FX_OK);
  assert.equal(r.ok, true);
  assert.equal(r.mismatch, undefined);
  assert.equal(r.trace.length, 4);
  assert.equal(r.cycles, 4);
});

test('vectors: a late mistake reports cycle, signal, expected and actual', () => {
  const r = runVectors(K_FX.ports, K_FX.vectors!, K_FX_WRONG_LATE);
  assert.equal(r.ok, false);
  assert.equal(r.error, undefined);
  const m = r.mismatch!;
  assert.equal(m.cycle, 4);          // 1-based row count after the header
  assert.equal(m.line, 6);           // the row's line inside the vectors block
  assert.equal(m.signal, 'q');
  assert.equal(m.expected, B(0xA));
  assert.equal(m.actual, B(3));      // en held at 1 through the x row: 0->1->2->3
  assert.equal(r.trace.length, 4);   // the run stops at the mismatch
});

test('vectors: a design without the reset fails on the first row', () => {
  const r = runVectors(K_FX.ports, K_FX.vectors!, K_FX_WRONG_EARLY);
  assert.equal(r.ok, false);
  const m = r.mismatch!;
  assert.equal(m.cycle, 1);
  assert.equal(m.signal, 'q');
  assert.equal(m.expected, B(0));
});

test('vectors: compile errors and port mismatches are errors, not runs', () => {
  const e1 = runVectors(K_FX.ports, K_FX.vectors!, 'module broken(');
  assert.equal(e1.ok, false);
  assert.ok(e1.error);
  assert.equal(e1.mismatch, undefined);
  const wide = K_FX_WRONG_LATE.replace('output reg [3:0] q', 'output reg [7:0] q').replace(/4'd/g, "8'd");
  const e2 = runVectors(K_FX.ports, K_FX.vectors!, wide);
  assert.equal(e2.ok, false);
  assert.match(e2.error!, /port 'q' must be output \[3:0\]/);
  assert.equal(e2.port, 'q');
});

test('vectors: an x input holds the last driven value; an x output is never compared', () => {
  const vectors: Vectors = {
    inputs: ['en'], outputs: ['q'],
    rows: [
      { line: 2, inputs: ['1'], outputs: ['1'] },
      { line: 3, inputs: [null], outputs: ['1'] },   // en don't care: it holds 1, so q stays 1
      { line: 4, inputs: ['0'], outputs: ['0'] },
      { line: 5, inputs: ['0'], outputs: [null] },   // output don't care
    ],
  };
  const src = ['module m(input clk, input en, output reg q);',
    'always @(posedge clk) q <= en;',
    'endmodule'].join('\n');
  const ports = [
    { dir: 'input' as const, name: 'clk', width: 1 },
    { dir: 'input' as const, name: 'en', width: 1 },
    { dir: 'output' as const, name: 'q', width: 1 },
  ];
  const r = runVectors(ports, vectors, src);
  assert.equal(r.ok, true);
});

test('vectors: a bad column name is a testbench error, not a mismatch', () => {
  const vectors: Vectors = {
    inputs: ['rst', 'nope'], outputs: ['q'],
    rows: [{ line: 2, inputs: ['1', '0'], outputs: ['0'] }],
  };
  const r = runVectors(K_FX.ports, vectors, K_FX_OK);
  assert.equal(r.ok, false);
  assert.match(r.error!, /'nope' is not an input port/);
});

test('fmtV writes values the way Verilog sizes them', () => {
  assert.equal(fmtV(B(1), 1), '1');
  assert.equal(fmtV(B(0xA), 4), "4'b1010");
  assert.equal(fmtV(B(0xA5), 8), "8'hA5");
  assert.equal(fmtV(B(0), 8), "8'h00");
  assert.equal(fmtV(null, 4), '');
});

test('waveSvg draws inputs, outputs and an expected row for the mismatched signal', () => {
  const r = runVectors(K_FX.ports, K_FX.vectors!, K_FX_WRONG_LATE);
  const svg = waveSvg(K_FX.ports, K_FX.vectors!, r.trace, 0, r.trace.length, r.mismatch!);
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  assert.ok(svg.includes('>q<') && svg.includes('>q exp<') && svg.includes('>rst<') && svg.includes('>en<'));
  assert.ok(svg.includes('>1<'));   // the first cycle's label
});

test('the bare skeleton does not run: every output must be driven', () => {
  const r = runVectors(K_FX.ports, K_FX.vectors!, K_FX.skeleton);
  assert.equal(r.ok, false);
  assert.match(r.error!, /never driven/);
});

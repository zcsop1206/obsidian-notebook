/**
 * The kata design language: a small interpreted Verilog subset, ported from
 * lab/study-reader/src/block-kata.js for ticket S9 (docs/study/threads/S9.md). Values are BigInt
 * (built with BigInt(), never literal syntax: the bundle targets ES2018), widths 1..64, no x or z,
 * one clock: `always @(posedge clk)` with nonblocking assignments; assigns settle in dependency
 * order after every input change and every edge.
 *
 * No reference designs or kata test vectors live here; the vectors a design runs against are data
 * from the kata doc (FORMAT.md, Kata).
 */
/* BigInt the function is not declared in the ES2018 lib the bundle targets, though the bigint type
   and its operators are. Declared here per module; every supported web view has it. */
declare const BigInt: (value: number | string | bigint | boolean) => bigint;

const N0 = BigInt(0), N1 = BigInt(1), N16 = BigInt(16);
const MK: bigint[] = [];
export function mask(w: number): bigint {
  if (!MK[w]) MK[w] = (N1 << BigInt(w)) - N1;
  return MK[w];
}

/** A compile or elaboration error the block shows as its message, with the design's line number. */
export class KataError extends Error {
  kata = true;
  line: number;
  constructor(line: number, msg: string) {
    super((line ? `line ${line}: ` : '') + msg);
    this.line = line;
  }
}
function err(line: number, msg: string): never {
  throw new KataError(line, msg);
}

const KW = new Set((
  'module endmodule input output inout wire reg logic assign always posedge negedge or begin end if else case endcase ' +
  'default parameter localparam integer for while initial function task generate'
).split(' '));
function kw(s: string): boolean {
  return KW.has(s);
}

/* iPad keyboards turn ' into a curly quote and may insert no-break spaces; Verilog wants neither. */
export function normalize(src: string | null | undefined): string {
  return String(src ?? '').replace(/\r\n?/g, '\n').replace(/[‘’ʼ]/g, "'").replace(/[\u00a0\u2007\u2009\u202f]/g, ' ');
}

/* ------------------------------------------------------------------------------------------ *
 * AST
 * ------------------------------------------------------------------------------------------ */

export interface NumE { t: 'num'; v: bigint; w: number; line: number }
export interface IdE { t: 'id'; name: string; line: number; w?: number }
export interface IdxE { t: 'idx'; name: string; i: Expr; line: number; w?: number }
export interface PartE { t: 'part'; name: string; h: number; l: number; line: number; w?: number }
export interface CatE { t: 'cat'; items: Expr[]; line: number; w?: number }
export interface RepE { t: 'rep'; n: number; items: Expr[]; line: number; w?: number }
export interface UnE { t: 'un'; op: string; a: Expr; line: number; w?: number }
export interface BinE { t: 'bin'; op: string; a: Expr; b: Expr; line: number; w?: number }
export interface TernE { t: 'tern'; c: Expr; a: Expr; b: Expr; line: number; w?: number }
export type Expr = NumE | IdE | IdxE | PartE | CatE | RepE | UnE | BinE | TernE;

export interface LValue {
  name: string;
  line: number;
  i?: Expr;            // bit select
  h?: number; l?: number; // part select
  w?: number;          // resolved width, set by elaborate
}

export interface BlkS { t: 'blk'; body: Stmt[] }
export interface IfS { t: 'if'; c: Expr; th: Stmt; el: Stmt | null; line: number }
export interface CaseS { t: 'case'; sel: Expr; items: { labels: Expr[]; s: Stmt }[]; def: Stmt | null; line: number }
export interface NbS { t: 'nb'; lv: LValue; rhs: Expr; line: number }
export type Stmt = BlkS | IfS | CaseS | NbS;

export interface Sig { name: string; dir: 'input' | 'output' | null; kind: 'wire' | 'reg'; w: number; line: number }
export interface Assign { lhs: string; rhs: Expr; line: number }
export interface Module {
  name: string | null;
  sigs: Map<string, Sig>;
  params: Map<string, bigint>;
  assigns: Assign[];
  blocks: Stmt[];
}

/* ------------------------------------------------------------------------------------------ *
 * Lexer
 * ------------------------------------------------------------------------------------------ */

interface Tok {
  k: 'num' | 'id' | 'op' | 'eof';
  /** The token text (the raw literal for numbers). */
  s: string;
  /** Value and width for number literals. */
  v: bigint;
  w: number;
  line: number;
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  const reNum = /(\d+)?'([bBhHdDoO])([0-9a-fA-F_xXzZ?]+)|(\d[\d_]*)/y, reId = /[A-Za-z_][A-Za-z0-9_$]*/y;
  const ops2 = ['<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '~^', '^~'];
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const open = line;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      if (i >= n) err(open, "'/*' has no matching '*/'");
      i += 2;
      continue;
    }
    if (/[\d']/.test(c)) {
      reNum.lastIndex = i;
      const m = reNum.exec(src);
      if (!m) err(line, `bad number near '${src.substr(i, 8)}'`);
      const raw = m[0];
      let v: bigint, w: number;
      if (m[4] !== undefined) { v = BigInt(m[4].replace(/_/g, '')) & mask(32); w = 32; }
      else {
        const digs = m[3].replace(/_/g, '');
        if (/[xXzZ?]/.test(digs)) err(line, `x and z values are not supported in '${raw}'`);
        const b = m[2].toLowerCase();
        try { v = b === 'd' ? BigInt(digs) : BigInt(`0${b === 'h' ? 'x' : b}${digs}`); } catch (e) { err(line, `bad number '${raw}'`); }
        w = m[1] ? Number(m[1]) : 32;
        if (w < 1 || w > 64) err(line, 'literal width must be 1..64');
        v = v & mask(w);
      }
      toks.push({ k: 'num', s: raw, v, w, line });
      i += raw.length;
      continue;
    }
    reId.lastIndex = i;
    const m2 = reId.exec(src);
    if (m2) { toks.push({ k: 'id', s: m2[0], v: N0, w: 0, line }); i += m2[0].length; continue; }
    const two = src.substr(i, 2);
    if (ops2.indexOf(two) >= 0) { toks.push({ k: 'op', s: two, v: N0, w: 0, line }); i += 2; continue; }
    if ('+-*/%&|^~!<>?:;,()[]{}@=#.'.indexOf(c) >= 0) { toks.push({ k: 'op', s: c, v: N0, w: 0, line }); i++; continue; }
    err(line, `unexpected character '${c}'`);
  }
  return toks;
}

/* ------------------------------------------------------------------------------------------ *
 * Parser
 * ------------------------------------------------------------------------------------------ */

function parse(src: string): Module {
  const T = lex(src);
  let p = 0;
  const lastLine = T.length ? T[T.length - 1].line : 1;
  function peek(): Tok { return T[p] || { k: 'eof', s: '', v: N0, w: 0, line: lastLine }; }
  function next(): Tok { const t = peek(); p++; return t; }
  function is(s: string): boolean { const t = peek(); return (t.k === 'op' || t.k === 'id') && t.s === s; }
  function accept(s: string): boolean { if (is(s)) { p++; return true; } return false; }
  function desc(t: Tok): string { return t.k === 'eof' ? 'end of file' : t.s; }
  function expect(s: string): Tok { if (!is(s)) err(peek().line, `expected '${s}' but found '${desc(peek())}'`); return next(); }
  function ident(): Tok { const t = peek(); if (t.k !== 'id' || kw(t.s)) err(t.line, `expected a name but found '${desc(t)}'`); p++; return t; }
  const M: Module = { sigs: new Map(), params: new Map(), assigns: [], blocks: [], name: null };

  function cval(n: Expr): bigint {
    switch (n.t) {
      case 'num': return n.v;
      case 'id':
        if (M.params.has(n.name)) return M.params.get(n.name)!;
        err(n.line, `'${n.name}' is not a constant`);
        break;
      case 'un': {
        const a = cval(n.a);
        if (n.op === '-') return (-a) & mask(64);
        if (n.op === '~') return (~a) & mask(64);
        if (n.op === '!') return a ? N0 : N1;
        if (n.op === '+') return a;
        break;
      }
      case 'bin': {
        const x = cval(n.a), y = cval(n.b);
        switch (n.op) {
          case '+': return (x + y) & mask(64);
          case '-': return (x - y) & mask(64);
          case '*': return (x * y) & mask(64);
          case '/': return y ? x / y : N0;
          case '%': return y ? x % y : N0;
          case '<<': if (y > BigInt(64)) return N0; return (x << y) & mask(64);
          case '>>': return x >> y;
          case '&': return x & y;
          case '|': return x | y;
          case '^': return x ^ y;
        }
      }
    }
    err(n.line, 'this must be a constant expression');
  }

  function declare(dir: 'input' | 'output' | null, kind: 'wire' | 'reg', w: number, nt: Tok): void {
    const name = nt.s, ex = M.sigs.get(name);
    if (M.params.has(name)) err(nt.line, `'${name}' is already a parameter`);
    if (ex) {
      if (kind === 'reg' && !dir && ex.dir === 'output' && ex.kind !== 'reg') {
        if (ex.w !== w) err(nt.line, `'${name}' is ${w} bits here but the port is ${ex.w} bits`);
        ex.kind = 'reg';
        return;
      }
      err(nt.line, `'${name}' is already declared on line ${ex.line}`);
    }
    M.sigs.set(name, { name, dir, kind, w, line: nt.line });
  }
  function range(): number {
    if (!accept('[')) return 1;
    const t = peek();
    const h = Number(cval(expr())); expect(':'); const l = Number(cval(expr())); expect(']');
    if (l !== 0) err(t.line, 'ranges must be written [N:0] here');
    if (h < 0 || h > 63) err(t.line, 'widths must be 1..64 bits');
    return h + 1;
  }
  const BIN = [['||'], ['&&'], ['|'], ['^', '~^', '^~'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  function expr(): Expr {
    const c = bin(0);
    if (is('?')) { const q = next(); const a = expr(); expect(':'); const b = expr(); return { t: 'tern', c, a, b, line: q.line }; }
    return c;
  }
  function bin(lv: number): Expr {
    if (lv === BIN.length) return unary();
    let a = bin(lv + 1);
    for (;;) {
      const t = peek();
      if (t.k === 'op' && BIN[lv].indexOf(t.s) >= 0) { next(); const b = bin(lv + 1); a = { t: 'bin', op: t.s === '^~' ? '~^' : t.s, a, b, line: t.line }; }
      else return a;
    }
  }
  function unary(): Expr {
    const t = peek();
    if (t.k === 'op' && ['~', '!', '-', '+', '&', '|', '^'].indexOf(t.s) >= 0) { next(); return { t: 'un', op: t.s, a: unary(), line: t.line }; }
    return primary();
  }
  function primary(): Expr {
    const t = next();
    if (t.k === 'num') return { t: 'num', v: t.v, w: t.w!, line: t.line };
    if (t.k === 'op' && t.s === '(') { const e = expr(); expect(')'); return e; }
    if (t.k === 'op' && t.s === '{') {
      const first = expr();
      if (is('{')) {
        next();
        const its = [expr()];
        while (accept(',')) its.push(expr());
        expect('}'); expect('}');
        return { t: 'rep', n: Number(cval(first)), items: its, line: t.line };
      }
      const items = [first];
      while (accept(',')) items.push(expr());
      expect('}');
      return { t: 'cat', items, line: t.line };
    }
    if (t.k === 'id' && !kw(t.s)) {
      if (accept('[')) {
        const a = expr();
        if (accept(':')) { const b = expr(); expect(']'); return { t: 'part', name: t.s, h: Number(cval(a)), l: Number(cval(b)), line: t.line }; }
        expect(']');
        return { t: 'idx', name: t.s, i: a, line: t.line };
      }
      return { t: 'id', name: t.s, line: t.line };
    }
    err(t.line, `unexpected '${desc(t)}' in an expression`);
  }
  function stmt(): Stmt {
    const t = peek();
    if (accept('begin')) {
      if (accept(':')) ident();
      const body: Stmt[] = [];
      while (!is('end')) { if (peek().k === 'eof') err(t.line, "'begin' has no matching 'end'"); body.push(stmt()); }
      next();
      return { t: 'blk', body };
    }
    if (accept('if')) {
      expect('('); const c = expr(); expect(')');
      const th = stmt();
      let el: Stmt | null = null;
      if (accept('else')) el = stmt();
      return { t: 'if', c, th, el, line: t.line };
    }
    if (accept('case')) {
      expect('('); const sel = expr(); expect(')');
      const items: { labels: Expr[]; s: Stmt }[] = [];
      let def: Stmt | null = null;
      while (!accept('endcase')) {
        if (peek().k === 'eof') err(t.line, "'case' has no matching 'endcase'");
        if (accept('default')) { accept(':'); def = stmt(); continue; }
        const labels = [expr()];
        while (accept(',')) labels.push(expr());
        expect(':');
        items.push({ labels, s: stmt() });
      }
      return { t: 'case', sel, items, def, line: t.line };
    }
    if (accept(';')) return { t: 'blk', body: [] };
    if (t.k === 'id' && !kw(t.s)) {
      const nt = next();
      const lv: LValue = { name: nt.s, line: nt.line };
      if (accept('[')) {
        const a = expr();
        if (accept(':')) { const b = expr(); expect(']'); lv.h = Number(cval(a)); lv.l = Number(cval(b)); }
        else { expect(']'); lv.i = a; }
      }
      const op = peek();
      if (is('=')) err(op.line, "use '<=' (nonblocking) inside always @(posedge clk)");
      if (!accept('<=')) err(op.line, `expected '<=' after '${nt.s}' but found '${desc(op)}'`);
      const rhs = expr();
      expect(';');
      return { t: 'nb', lv, rhs, line: nt.line };
    }
    err(t.line, `unexpected '${desc(t)}' in an always block`);
  }
  function item(): void {
    const t = peek();
    if (t.k !== 'id') err(t.line, `unexpected '${desc(t)}' (expected a declaration, assign or always)`);
    let w: number, dir: 'input' | 'output', kind: 'wire' | 'reg', nt: Tok;
    switch (t.s) {
      case 'input': case 'output':
        next(); dir = t.s; kind = 'wire';
        if (accept('reg')) { if (dir === 'input') err(t.line, 'an input cannot be reg'); kind = 'reg'; } else accept('wire');
        w = range();
        do { declare(dir, kind, w, ident()); } while (accept(','));
        expect(';');
        return;
      case 'reg': case 'wire':
        next(); w = range();
        do {
          nt = ident(); declare(null, t.s, w, nt);
          if (t.s === 'wire' && accept('=')) M.assigns.push({ lhs: nt.s, rhs: expr(), line: nt.line });
        } while (accept(','));
        expect(';');
        return;
      case 'parameter': case 'localparam':
        next(); range();
        do {
          nt = ident(); expect('=');
          const v = cval(expr());
          if (M.params.has(nt.s) || M.sigs.has(nt.s)) err(nt.line, `'${nt.s}' is already declared`);
          M.params.set(nt.s, v);
        } while (accept(','));
        expect(';');
        return;
      case 'assign':
        next(); nt = ident();
        if (is('[')) err(nt.line, 'assign drives whole signals only');
        expect('=');
        { const rhs = expr(); expect(';'); M.assigns.push({ lhs: nt.s, rhs, line: nt.line }); }
        return;
      case 'always':
        next(); expect('@'); expect('(');
        if (!accept('posedge')) err(t.line, 'only always @(posedge clk) is supported here');
        { const ck = ident();
          if (ck.s !== 'clk') err(ck.line, 'the clock is clk');
          if (is('or') || is(',')) err(peek().line, 'reset is synchronous here: always @(posedge clk)');
          expect(')');
          M.blocks.push(stmt()); }
        return;
      case 'endmodule': err(t.line, "unexpected 'endmodule'");
    }
    if (kw(t.s)) err(t.line, `'${t.s}' is not part of this kata language`);
    err(t.line, `unexpected '${t.s}' (expected a declaration, assign or always)`);
  }
  if (accept('module')) {
    M.name = ident().s;
    if (accept('(')) {
      if (!accept(')')) {
        let dir: 'input' | 'output' | null = null, kind: 'wire' | 'reg' = 'wire', w = 1;
        for (;;) {
          if (is('input') || is('output') || is('inout')) {
            const dt = next();
            if (dt.s === 'inout') err(dt.line, 'inout is not supported');
            dir = dt.s as 'input' | 'output'; kind = 'wire';
            if (accept('reg')) { if (dir === 'input') err(dt.line, 'an input cannot be reg'); kind = 'reg'; } else accept('wire');
            w = range();
          }
          const pn = ident();
          if (dir) declare(dir, kind, w, pn);
          if (accept(',')) continue;
          expect(')');
          break;
        }
      }
    }
    expect(';');
    while (peek().k !== 'eof' && !is('endmodule')) item();
    expect('endmodule');
    if (peek().k !== 'eof') err(peek().line, `unexpected '${desc(peek())}' after endmodule`);
  } else {
    while (peek().k !== 'eof') item();
  }
  return M;
}

/* ------------------------------------------------------------------------------------------ *
 * Elaboration: widths, drivers, assign order
 * ------------------------------------------------------------------------------------------ */

const ARITH = ['+', '-', '*', '/', '%', '&', '|', '^', '~^'];
/* The signal names an expression reads (for ordering the assigns). */
function reads(n: Expr | null | undefined, out: string[]): string[] {
  if (!n) return out;
  switch (n.t) {
    case 'id': case 'part': out.push(n.name); return out;
    case 'idx': out.push(n.name); return reads(n.i, out);
    case 'cat': case 'rep': n.items.forEach(x => { reads(x, out); }); return out;
    case 'un': return reads(n.a, out);
    case 'bin': reads(n.a, out); return reads(n.b, out);
    case 'tern': reads(n.c, out); reads(n.a, out); return reads(n.b, out);
  }
  return out;
}
/* Assigns in dependency order, or null when they form a loop (settle then iterates and may report it). */
function ordered(A: Assign[]): Assign[] | null {
  const by: Record<string, number> = Object.create(null);
  for (let i = 0; i < A.length; i++) by[A[i].lhs] = i;
  const deps = A.map(a =>
    reads(a.rhs, []).filter(nm => by[nm] !== undefined).map(nm => by[nm]));
  const mark = A.map(() => 0);
  const out: Assign[] = [];
  let ok = true;
  function visit(j: number): void {
    if (mark[j] === 2 || !ok) return;
    if (mark[j] === 1) { ok = false; return; }
    mark[j] = 1;
    deps[j].forEach(visit);
    mark[j] = 2;
    out.push(A[j]);
  }
  for (let i = 0; i < A.length; i++) visit(i);
  return ok ? out : null;
}

function elaborate(M: Module): Module {
  const S = M.sigs;
  function sig(n: IdE | IdxE | PartE): Sig {
    const s = S.get(n.name);
    if (!s) err(n.line, M.params.has(n.name) ? `can't select bits of parameter '${n.name}'` : `'${n.name}' is not declared`);
    return s!;
  }
  function W(n: Expr): number {
    switch (n.t) {
      case 'num': return n.w;
      case 'id':
        if (M.params.has(n.name)) {
          const num = n as unknown as NumE;
          num.t = 'num'; num.v = M.params.get(n.name)! & mask(32); num.w = 32;
          return 32;
        }
        { const s = sig(n); n.w = s.w; return n.w; }
      case 'idx': sig(n); W(n.i); n.w = 1; return 1;
      case 'part': {
        const s = sig(n);
        if (n.h < n.l || n.h >= s.w || n.l < 0) err(n.line, `[${n.h}:${n.l}] is outside '${n.name}' [${s.w - 1}:0]`);
        n.w = n.h - n.l + 1; return n.w;
      }
      case 'cat': { let w = 0; for (const x of n.items) w += W(x); n.w = w; return w; }
      case 'rep': {
        if (!(n.n > 0)) err(n.line, 'replication count must be positive');
        let w = 0; for (const x of n.items) w += W(x);
        n.w = w * n.n; return n.w;
      }
      case 'un': { const w = W(n.a); n.w = (n.op === '~' || n.op === '-' || n.op === '+') ? w : 1; return n.w; }
      case 'bin': {
        const a = W(n.a), b = W(n.b);
        n.w = ARITH.indexOf(n.op) >= 0 ? Math.max(a, b) : (n.op === '<<' || n.op === '>>') ? a : 1;
        return n.w;
      }
      case 'tern': W(n.c); n.w = Math.max(W(n.a), W(n.b)); return n.w;
    }
  }
  const drv = new Map<string, { line: number; blk: number }>();
  M.assigns.forEach(a => {
    const s = S.get(a.lhs);
    if (!s) err(a.line, `'${a.lhs}' is not declared`);
    if (s.dir === 'input') err(a.line, `'${a.lhs}' is an input; it can't be driven`);
    if (s.kind === 'reg') err(a.line, `'${a.lhs}' is declared reg, so assign can't drive it`);
    if (drv.has(a.lhs)) err(a.line, `'${a.lhs}' already has a driver on line ${drv.get(a.lhs)!.line}`);
    drv.set(a.lhs, { line: a.line, blk: -1 });
    W(a.rhs);
  });
  function walk(s: Stmt, bi: number): void {
    switch (s.t) {
      case 'blk': s.body.forEach(x => { walk(x, bi); }); return;
      case 'if': W(s.c); walk(s.th, bi); if (s.el) walk(s.el, bi); return;
      case 'case':
        W(s.sel);
        s.items.forEach(it => { it.labels.forEach(W); walk(it.s, bi); });
        if (s.def) walk(s.def, bi);
        return;
      case 'nb': {
        const lv = s.lv, g = S.get(lv.name);
        if (!g) err(s.line, `'${lv.name}' is not declared`);
        if (g.dir === 'input') err(s.line, `'${lv.name}' is an input; it can't be assigned`);
        if (g.kind !== 'reg') err(s.line, `'${lv.name}' is assigned in an always block, so it must be declared reg`);
        const d = drv.get(lv.name);
        if (d && d.blk !== bi) err(s.line, `'${lv.name}' is also driven on line ${d.line}`);
        if (!d) drv.set(lv.name, { line: s.line, blk: bi });
        if (lv.i) W(lv.i);
        if (lv.h !== undefined && (lv.h < lv.l! || lv.h >= g.w || lv.l! < 0)) err(s.line, `[${lv.h}:${lv.l}] is outside '${lv.name}'`);
        lv.w = lv.h !== undefined ? lv.h - lv.l! + 1 : lv.i ? 1 : g.w;
        W(s.rhs);
        return;
      }
    }
  }
  M.blocks.forEach((b, bi) => { walk(b, bi); });
  S.forEach(s => { if (s.dir === 'output' && !drv.has(s.name)) err(s.line, `output '${s.name}' is never driven`); });
  const ord = ordered(M.assigns);
  if (ord) M.assigns = ord;
  return M;
}

/** Compile a design's source to an elaborated module; throws KataError with a line number. */
export function compile(src: string): Module {
  const M = parse(normalize(src));
  elaborate(M);
  return M;
}

/** Shape a thrown error for the block: kata errors carry their line; anything else is internal. */
export function fail(e: unknown): { ok: false; error: string; line?: number } {
  if (e instanceof KataError || (e && (e as KataError).kata)) {
    const ke = e as KataError;
    return { ok: false, error: ke.message, line: ke.line };
  }
  return { ok: false, error: `internal error: ${e && (e as Error).message ? (e as Error).message : String(e)}` };
}

/* ------------------------------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------------------------------ */

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Sim {
  /** Drive an input (masked to its width). */
  set(n: string, x: bigint | number): void;
  /** The current value of a signal. */
  get(n: string): bigint;
  /** Re-settle combinational assigns after input changes or an edge. */
  settle(): void;
  /** One rising edge of clk: every nonblocking rhs sampled first, then all updates land. */
  tick(): void;
}

export function createSim(M: Module, seed?: number): Sim {
  const v: Record<string, bigint> = Object.create(null);
  const r = rng(seed ?? 7);
  M.sigs.forEach((s, n) => {
    let x = N0;
    if (s.kind === 'reg') { for (let k = 0; k < s.w; k += 16) x = (x << N16) | BigInt(Math.floor(r() * 65536)); x &= mask(s.w); }
    v[n] = x;
  });
  function ev(n: Expr, cw: number): bigint {
    switch (n.t) {
      case 'num': return n.v & mask(cw);
      case 'id': return v[n.name];
      case 'idx': {
        const i = ev(n.i, n.i.w!);
        if (i >= BigInt(M.sigs.get(n.name)!.w)) return N0;
        return (v[n.name] >> i) & N1;
      }
      case 'part': return (v[n.name] >> BigInt(n.l)) & mask(n.w!);
      case 'cat': {
        let x = N0;
        for (const it of n.items) x = (x << BigInt(it.w!)) | ev(it, it.w!);
        return x;
      }
      case 'rep': {
        let one = N0;
        for (const it of n.items) one = (one << BigInt(it.w!)) | ev(it, it.w!);
        const iw = BigInt(n.w! / n.n);
        let x = N0;
        for (let q = 0; q < n.n; q++) x = (x << iw) | one;
        return x;
      }
      case 'un': {
        switch (n.op) {
          case '~': return (~ev(n.a, cw)) & mask(cw);
          case '-': return (-ev(n.a, cw)) & mask(cw);
          case '+': return ev(n.a, cw);
          case '!': return ev(n.a, n.a.w!) === N0 ? N1 : N0;
          case '&': return ev(n.a, n.a.w!) === mask(n.a.w!) ? N1 : N0;
          case '|': return ev(n.a, n.a.w!) !== N0 ? N1 : N0;
          case '^': { let x = ev(n.a, n.a.w!); let par = N0; while (x) { par ^= x & N1; x >>= N1; } return par; }
        }
        break;
      }
      case 'bin': {
        const op = n.op;
        if (op === '&&') return (ev(n.a, n.a.w!) !== N0 && ev(n.b, n.b.w!) !== N0) ? N1 : N0;
        if (op === '||') return (ev(n.a, n.a.w!) !== N0 || ev(n.b, n.b.w!) !== N0) ? N1 : N0;
        if (op === '<<' || op === '>>') {
          const a = ev(n.a, cw), b = ev(n.b, n.b.w!);
          if (b >= BigInt(cw)) return N0;
          return op === '<<' ? (a << b) & mask(cw) : a >> b;
        }
        if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
          const ow = Math.max(n.a.w!, n.b.w!);
          const a = ev(n.a, ow), b = ev(n.b, ow);
          const res = op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
          return res ? N1 : N0;
        }
        const a = ev(n.a, cw), b = ev(n.b, cw);
        let x: bigint;
        switch (op) {
          case '+': x = a + b; break;
          case '-': x = a - b; break;
          case '*': x = a * b; break;
          case '/': x = b ? a / b : N0; break;
          case '%': x = b ? a % b : N0; break;
          case '&': x = a & b; break;
          case '|': x = a | b; break;
          case '^': x = a ^ b; break;
          case '~^': x = ~(a ^ b); break;
          default: x = N0;
        }
        return x & mask(cw);
      }
      case 'tern': return ev(n.c, n.c.w!) !== N0 ? ev(n.a, cw) : ev(n.b, cw);
    }
    return N0;
  }
  function settle(): void {
    const A = M.assigns;
    for (let pass = 0; pass <= A.length + 1; pass++) {
      let ch = false;
      for (const a of A) {
        const s = M.sigs.get(a.lhs)!;
        const nv = ev(a.rhs, Math.max(s.w, a.rhs.w!)) & mask(s.w);
        if (nv !== v[a.lhs]) { v[a.lhs] = nv; ch = true; }
      }
      if (!ch) return;
    }
    if (A.length) err(A[0].line, 'combinational loop: the assigns never settle');
  }
  function exec(s: Stmt, pend: Map<string, bigint>): void {
    switch (s.t) {
      case 'blk': for (const x of s.body) exec(x, pend); return;
      case 'if': if (ev(s.c, s.c.w!) !== N0) exec(s.th, pend); else if (s.el) exec(s.el, pend); return;
      case 'case': {
        let cw = s.sel.w!;
        s.items.forEach(it => { it.labels.forEach(l => { cw = Math.max(cw, l.w!); }); });
        const x = ev(s.sel, cw);
        for (const it of s.items) {
          for (const l of it.labels) if (ev(l, cw) === x) { exec(it.s, pend); return; }
        }
        if (s.def) exec(s.def, pend);
        return;
      }
      case 'nb': {
        const lv = s.lv, g = M.sigs.get(lv.name)!;
        const val = ev(s.rhs, Math.max(lv.w!, s.rhs.w!)) & mask(lv.w!);
        if (lv.h === undefined && !lv.i) { pend.set(lv.name, val); return; }
        const base = pend.has(lv.name) ? pend.get(lv.name)! : v[lv.name];
        let lo: bigint, wd: bigint;
        if (lv.i) { lo = ev(lv.i, lv.i.w!); if (lo >= BigInt(g.w)) return; wd = N1; }
        else { lo = BigInt(lv.l!); wd = BigInt(lv.h! - lv.l! + 1); }
        const m = ((N1 << wd) - N1) << lo;
        pend.set(lv.name, (base & ~m & mask(g.w)) | ((val << lo) & m));
        return;
      }
    }
  }
  function tick(): void {
    const pend = new Map<string, bigint>();
    for (const b of M.blocks) exec(b, pend);
    pend.forEach((x, k) => { v[k] = x; });
    settle();
  }
  return {
    set(n: string, x: bigint | number): void { v[n] = BigInt(x) & mask(M.sigs.get(n)!.w); },
    get(n: string): bigint { return v[n]; },
    settle,
    tick,
  };
}

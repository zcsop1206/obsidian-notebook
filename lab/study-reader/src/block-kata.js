/* block-kata.js: design katas, inline in docs (SR.blocks 'kata') and from Today (SR.kata.open).
   A kata runs in this order:
   1. The design call: an ink sketch, one typed line and a confidence chip. The chips stay disabled until
      the call has ink or a line; committing locks the call, opens the editor and starts the clock.
   2. The editor and the testbench: a Verilog-subset interpreter runs the design against a JS reference
      model of the spec, cycle by cycle, and reports the first mismatch with a waveform. Compile errors
      do not count as runs.
   3. Settling: the first pass (score 1 on the first counted run, else 0.75) or a two-tap give-up (0) goes
      to engine.settleKata. Then two tick steps, as in block-problem.js: the methods the call named, then
      the methods the kata took (pre-ticked with the kata's tags once the first step is locked); the
      engine gets both and returns method hit, the recognition gap and the basics to go back to.
   Hard katas inside docs wait behind a one-tap gate until their area is in push mode. Hidden katas never
   name a technique, a method or a basic before they settle. Ported from lab/asic-katas (interpreter,
   testbench, waveform). Reference designs live only in test/kata-solutions.txt, which the build never
   reads; nothing in this file solves a kata.
   Node: module.exports carries the interpreter and the reference models (test/kata.test.mjs).
   Written by a model for Adit. Not Adit's words. */
(function (root) {
  'use strict';
  var SR = root.SR = root.SR || {};
  var MODEL_LABEL = "Written by a model for Adit. Not Adit's words.";

  /* ==================================================================================================
     Verilog subset, interpreted (ported from lab/asic-katas). Values are BigInt (built with BigInt(),
     never literal syntax), widths 1..64, no x or z, one clock: always @(posedge clk) with nonblocking
     assignments; assigns settle in dependency order after every input change and every edge.
     ================================================================================================== */
  var V = (function () {
    var OK = typeof BigInt === 'function';
    var BI = OK ? BigInt : function (x) { return x; };
    var N0 = BI(0), N1 = BI(1), N16 = BI(16);
    var MK = [];
    function mask(w) { if (!MK[w]) MK[w] = (N1 << BI(w)) - N1; return MK[w]; }
    function err(line, msg) { var e = new Error((line ? 'line ' + line + ': ' : '') + msg); e.line = line; e.kata = true; throw e; }
    var KW = Object.create(null);
    ('module endmodule input output inout wire reg logic assign always posedge negedge or begin end if else case endcase ' +
      'default parameter localparam integer for while initial function task generate').split(' ').forEach(function (w) { KW[w] = true; });
    function kw(s) { return KW[s] === true; }
    /* iPad keyboards turn ' into a curly quote and may insert no-break spaces; Verilog wants neither. */
    function normalize(src) {
      return String(src == null ? '' : src).replace(/\r\n?/g, '\n').replace(/[‘’ʼ]/g, "'").replace(/[    ]/g, ' ');
    }

    function lex(src) {
      var toks = [], i = 0, line = 1, n = src.length, m;
      var reNum = /(\d+)?'([bBhHdDoO])([0-9a-fA-F_xXzZ?]+)|(\d[\d_]*)/y, reId = /[A-Za-z_][A-Za-z0-9_$]*/y;
      var ops2 = ['<=', '>=', '==', '!=', '&&', '||', '<<', '>>', '~^', '^~'];
      while (i < n) {
        var c = src[i];
        if (c === '\n') { line++; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') {
          var open = line;
          i += 2;
          while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
          if (i >= n) err(open, "'/*' has no matching '*/'");
          i += 2;
          continue;
        }
        if (/[\d']/.test(c)) {
          reNum.lastIndex = i;
          m = reNum.exec(src);
          if (!m) err(line, "bad number near '" + src.substr(i, 8) + "'");
          var raw = m[0], v, w;
          if (m[4] !== undefined) { v = BI(m[4].replace(/_/g, '')) & mask(32); w = 32; }
          else {
            var digs = m[3].replace(/_/g, '');
            if (/[xXzZ?]/.test(digs)) err(line, "x and z values are not supported in '" + raw + "'");
            var b = m[2].toLowerCase();
            try { v = b === 'd' ? BI(digs) : BI('0' + (b === 'h' ? 'x' : b) + digs); } catch (e) { err(line, "bad number '" + raw + "'"); }
            w = m[1] ? Number(m[1]) : 32;
            if (w < 1 || w > 64) err(line, 'literal width must be 1..64');
            v = v & mask(w);
          }
          toks.push({ k: 'num', v: v, w: w, raw: raw, line: line });
          i += raw.length;
          continue;
        }
        reId.lastIndex = i;
        m = reId.exec(src);
        if (m) { toks.push({ k: 'id', s: m[0], line: line }); i += m[0].length; continue; }
        var two = src.substr(i, 2);
        if (ops2.indexOf(two) >= 0) { toks.push({ k: 'op', s: two, line: line }); i += 2; continue; }
        if ('+-*/%&|^~!<>?:;,()[]{}@=#.'.indexOf(c) >= 0) { toks.push({ k: 'op', s: c, line: line }); i++; continue; }
        err(line, "unexpected character '" + c + "'");
      }
      return toks;
    }

    function parse(src) {
      var T = lex(src), p = 0;
      var lastLine = T.length ? T[T.length - 1].line : 1;
      function peek() { return T[p] || { k: 'eof', s: '', line: lastLine }; }
      function next() { var t = peek(); p++; return t; }
      function is(s) { var t = peek(); return (t.k === 'op' || t.k === 'id') && t.s === s; }
      function accept(s) { if (is(s)) { p++; return true; } return false; }
      function desc(t) { return t.k === 'eof' ? 'end of file' : t.k === 'num' ? t.raw : t.s; }
      function expect(s) { if (!is(s)) err(peek().line, "expected '" + s + "' but found '" + desc(peek()) + "'"); return next(); }
      function ident() { var t = peek(); if (t.k !== 'id' || kw(t.s)) err(t.line, "expected a name but found '" + desc(t) + "'"); p++; return t; }
      var M = { sigs: new Map(), params: new Map(), assigns: [], blocks: [], name: null };
      function cval(n) {
        switch (n.t) {
          case 'num': return n.v;
          case 'id':
            if (M.params.has(n.name)) return M.params.get(n.name);
            err(n.line, "'" + n.name + "' is not a constant");
            break;
          case 'un': {
            var a = cval(n.a);
            if (n.op === '-') return (-a) & mask(64);
            if (n.op === '~') return (~a) & mask(64);
            if (n.op === '!') return a ? N0 : N1;
            if (n.op === '+') return a;
            break;
          }
          case 'bin': {
            var x = cval(n.a), y = cval(n.b);
            switch (n.op) {
              case '+': return (x + y) & mask(64);
              case '-': return (x - y) & mask(64);
              case '*': return (x * y) & mask(64);
              case '/': return y ? x / y : N0;
              case '%': return y ? x % y : N0;
              case '<<': if (y > BI(64)) return N0; return (x << y) & mask(64);
              case '>>': return x >> y;
              case '&': return x & y;
              case '|': return x | y;
              case '^': return x ^ y;
            }
          }
        }
        err(n.line, 'this must be a constant expression');
      }
      function declare(dir, kind, w, nt) {
        var name = nt.s, ex = M.sigs.get(name);
        if (M.params.has(name)) err(nt.line, "'" + name + "' is already a parameter");
        if (ex) {
          if (kind === 'reg' && !dir && ex.dir === 'output' && ex.kind !== 'reg') {
            if (ex.w !== w) err(nt.line, "'" + name + "' is " + w + ' bits here but the port is ' + ex.w + ' bits');
            ex.kind = 'reg';
            return;
          }
          err(nt.line, "'" + name + "' is already declared on line " + ex.line);
        }
        M.sigs.set(name, { name: name, dir: dir, kind: kind, w: w, line: nt.line });
      }
      function range() {
        if (!accept('[')) return 1;
        var t = peek(), h = Number(cval(expr())); expect(':'); var l = Number(cval(expr())); expect(']');
        if (l !== 0) err(t.line, 'ranges must be written [N:0] here');
        if (h < 0 || h > 63) err(t.line, 'widths must be 1..64 bits');
        return h + 1;
      }
      var BIN = [['||'], ['&&'], ['|'], ['^', '~^', '^~'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
      function expr() {
        var c = bin(0);
        if (is('?')) { var q = next(); var a = expr(); expect(':'); var b = expr(); return { t: 'tern', c: c, a: a, b: b, line: q.line }; }
        return c;
      }
      function bin(lv) {
        if (lv === BIN.length) return unary();
        var a = bin(lv + 1);
        for (;;) {
          var t = peek();
          if (t.k === 'op' && BIN[lv].indexOf(t.s) >= 0) { next(); var b = bin(lv + 1); a = { t: 'bin', op: t.s === '^~' ? '~^' : t.s, a: a, b: b, line: t.line }; }
          else return a;
        }
      }
      function unary() {
        var t = peek();
        if (t.k === 'op' && ['~', '!', '-', '+', '&', '|', '^'].indexOf(t.s) >= 0) { next(); return { t: 'un', op: t.s, a: unary(), line: t.line }; }
        return primary();
      }
      function primary() {
        var t = next();
        if (t.k === 'num') return { t: 'num', v: t.v, w: t.w, line: t.line };
        if (t.k === 'op' && t.s === '(') { var e = expr(); expect(')'); return e; }
        if (t.k === 'op' && t.s === '{') {
          var first = expr();
          if (is('{')) {
            next();
            var its = [expr()];
            while (accept(',')) its.push(expr());
            expect('}'); expect('}');
            return { t: 'rep', n: Number(cval(first)), items: its, line: t.line };
          }
          var items = [first];
          while (accept(',')) items.push(expr());
          expect('}');
          return { t: 'cat', items: items, line: t.line };
        }
        if (t.k === 'id' && !kw(t.s)) {
          if (accept('[')) {
            var a = expr();
            if (accept(':')) { var b = expr(); expect(']'); return { t: 'part', name: t.s, h: Number(cval(a)), l: Number(cval(b)), line: t.line }; }
            expect(']');
            return { t: 'idx', name: t.s, i: a, line: t.line };
          }
          return { t: 'id', name: t.s, line: t.line };
        }
        err(t.line, "unexpected '" + desc(t) + "' in an expression");
      }
      function stmt() {
        var t = peek();
        if (accept('begin')) {
          if (accept(':')) ident();
          var body = [];
          while (!is('end')) { if (peek().k === 'eof') err(t.line, "'begin' has no matching 'end'"); body.push(stmt()); }
          next();
          return { t: 'blk', body: body };
        }
        if (accept('if')) {
          expect('('); var c = expr(); expect(')');
          var th = stmt(), el = null;
          if (accept('else')) el = stmt();
          return { t: 'if', c: c, th: th, el: el, line: t.line };
        }
        if (accept('case')) {
          expect('('); var sel = expr(); expect(')');
          var items = [], def = null;
          while (!accept('endcase')) {
            if (peek().k === 'eof') err(t.line, "'case' has no matching 'endcase'");
            if (accept('default')) { accept(':'); def = stmt(); continue; }
            var labels = [expr()];
            while (accept(',')) labels.push(expr());
            expect(':');
            items.push({ labels: labels, s: stmt() });
          }
          return { t: 'case', sel: sel, items: items, def: def, line: t.line };
        }
        if (accept(';')) return { t: 'blk', body: [] };
        if (t.k === 'id' && !kw(t.s)) {
          var nt = next(), lv = { name: nt.s, line: nt.line };
          if (accept('[')) {
            var a = expr();
            if (accept(':')) { var b = expr(); expect(']'); lv.h = Number(cval(a)); lv.l = Number(cval(b)); }
            else { expect(']'); lv.i = a; }
          }
          var op = peek();
          if (is('=')) err(op.line, "use '<=' (nonblocking) inside always @(posedge clk)");
          if (!accept('<=')) err(op.line, "expected '<=' after '" + nt.s + "' but found '" + desc(op) + "'");
          var rhs = expr();
          expect(';');
          return { t: 'nb', lv: lv, rhs: rhs, line: nt.line };
        }
        err(t.line, "unexpected '" + desc(t) + "' in an always block");
      }
      function item() {
        var t = peek();
        if (t.k !== 'id') err(t.line, "unexpected '" + desc(t) + "' (expected a declaration, assign or always)");
        var nt, w, dir, kind;
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
              var v = cval(expr());
              if (M.params.has(nt.s) || M.sigs.has(nt.s)) err(nt.line, "'" + nt.s + "' is already declared");
              M.params.set(nt.s, v);
            } while (accept(','));
            expect(';');
            return;
          case 'assign':
            next(); nt = ident();
            if (is('[')) err(nt.line, 'assign drives whole signals only');
            expect('=');
            var rhs = expr();
            expect(';');
            M.assigns.push({ lhs: nt.s, rhs: rhs, line: nt.line });
            return;
          case 'always':
            next(); expect('@'); expect('(');
            if (!accept('posedge')) err(t.line, 'only always @(posedge clk) is supported here');
            var ck = ident();
            if (ck.s !== 'clk') err(ck.line, 'the clock is clk');
            if (is('or') || is(',')) err(peek().line, 'reset is synchronous here: always @(posedge clk)');
            expect(')');
            M.blocks.push(stmt());
            return;
          case 'endmodule': err(t.line, "unexpected 'endmodule'");
        }
        if (kw(t.s)) err(t.line, "'" + t.s + "' is not part of this kata language");
        err(t.line, "unexpected '" + t.s + "' (expected a declaration, assign or always)");
      }
      if (accept('module')) {
        M.name = ident().s;
        if (accept('(')) {
          if (!accept(')')) {
            var dir = null, kind = 'wire', w = 1;
            for (;;) {
              if (is('input') || is('output') || is('inout')) {
                var dt = next();
                if (dt.s === 'inout') err(dt.line, 'inout is not supported');
                dir = dt.s; kind = 'wire';
                if (accept('reg')) { if (dir === 'input') err(dt.line, 'an input cannot be reg'); kind = 'reg'; } else accept('wire');
                w = range();
              }
              var pn = ident();
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
        if (peek().k !== 'eof') err(peek().line, "unexpected '" + desc(peek()) + "' after endmodule");
      } else {
        while (peek().k !== 'eof') item();
      }
      return M;
    }

    var ARITH = ['+', '-', '*', '/', '%', '&', '|', '^', '~^'];
    /* The signal names an expression reads (for ordering the assigns). */
    function reads(n, out) {
      if (!n) return out;
      switch (n.t) {
        case 'id': case 'part': out.push(n.name); return out;
        case 'idx': out.push(n.name); return reads(n.i, out);
        case 'cat': case 'rep': n.items.forEach(function (x) { reads(x, out); }); return out;
        case 'un': return reads(n.a, out);
        case 'bin': reads(n.a, out); return reads(n.b, out);
        case 'tern': reads(n.c, out); reads(n.a, out); return reads(n.b, out);
      }
      return out;
    }
    /* Assigns in dependency order, or null when they form a loop (settle then iterates and may report it). */
    function ordered(A) {
      var by = Object.create(null), i;
      for (i = 0; i < A.length; i++) by[A[i].lhs] = i;
      var deps = A.map(function (a) {
        return reads(a.rhs, []).filter(function (nm) { return by[nm] !== undefined; }).map(function (nm) { return by[nm]; });
      });
      var mark = A.map(function () { return 0; }), out = [], ok = true;
      function visit(j) {
        if (mark[j] === 2 || !ok) return;
        if (mark[j] === 1) { ok = false; return; }
        mark[j] = 1;
        deps[j].forEach(visit);
        mark[j] = 2;
        out.push(A[j]);
      }
      for (i = 0; i < A.length; i++) visit(i);
      return ok ? out : null;
    }
    function elaborate(M) {
      var S = M.sigs;
      function sig(n) {
        var s = S.get(n.name);
        if (!s) err(n.line, M.params.has(n.name) ? "can't select bits of parameter '" + n.name + "'" : "'" + n.name + "' is not declared");
        return s;
      }
      function W(n) {
        var s, w, i;
        switch (n.t) {
          case 'num': return n.w;
          case 'id':
            if (M.params.has(n.name)) { n.t = 'num'; n.v = M.params.get(n.name) & mask(32); n.w = 32; return 32; }
            s = sig(n); n.w = s.w; return n.w;
          case 'idx': sig(n); W(n.i); n.w = 1; return 1;
          case 'part':
            s = sig(n);
            if (n.h < n.l || n.h >= s.w || n.l < 0) err(n.line, '[' + n.h + ':' + n.l + "] is outside '" + n.name + "' [" + (s.w - 1) + ':0]');
            n.w = n.h - n.l + 1; return n.w;
          case 'cat': w = 0; for (i = 0; i < n.items.length; i++) w += W(n.items[i]); n.w = w; return w;
          case 'rep':
            if (!(n.n > 0)) err(n.line, 'replication count must be positive');
            w = 0; for (i = 0; i < n.items.length; i++) w += W(n.items[i]);
            n.w = w * n.n; return n.w;
          case 'un': w = W(n.a); n.w = (n.op === '~' || n.op === '-' || n.op === '+') ? w : 1; return n.w;
          case 'bin': {
            var a = W(n.a), b = W(n.b);
            n.w = ARITH.indexOf(n.op) >= 0 ? Math.max(a, b) : (n.op === '<<' || n.op === '>>') ? a : 1;
            return n.w;
          }
          case 'tern': W(n.c); n.w = Math.max(W(n.a), W(n.b)); return n.w;
        }
      }
      var drv = new Map();
      M.assigns.forEach(function (a) {
        var s = S.get(a.lhs);
        if (!s) err(a.line, "'" + a.lhs + "' is not declared");
        if (s.dir === 'input') err(a.line, "'" + a.lhs + "' is an input; it can't be driven");
        if (s.kind === 'reg') err(a.line, "'" + a.lhs + "' is declared reg, so assign can't drive it");
        if (drv.has(a.lhs)) err(a.line, "'" + a.lhs + "' already has a driver on line " + drv.get(a.lhs).line);
        drv.set(a.lhs, { line: a.line, blk: -1 });
        W(a.rhs);
      });
      function walk(s, bi) {
        switch (s.t) {
          case 'blk': s.body.forEach(function (x) { walk(x, bi); }); return;
          case 'if': W(s.c); walk(s.th, bi); if (s.el) walk(s.el, bi); return;
          case 'case':
            W(s.sel);
            s.items.forEach(function (it) { it.labels.forEach(W); walk(it.s, bi); });
            if (s.def) walk(s.def, bi);
            return;
          case 'nb': {
            var lv = s.lv, g = S.get(lv.name);
            if (!g) err(s.line, "'" + lv.name + "' is not declared");
            if (g.dir === 'input') err(s.line, "'" + lv.name + "' is an input; it can't be assigned");
            if (g.kind !== 'reg') err(s.line, "'" + lv.name + "' is assigned in an always block, so it must be declared reg");
            var d = drv.get(lv.name);
            if (d && d.blk !== bi) err(s.line, "'" + lv.name + "' is also driven on line " + d.line);
            if (!d) drv.set(lv.name, { line: s.line, blk: bi });
            if (lv.i) W(lv.i);
            if (lv.h !== undefined && (lv.h < lv.l || lv.h >= g.w || lv.l < 0)) err(s.line, '[' + lv.h + ':' + lv.l + "] is outside '" + lv.name + "'");
            lv.w = lv.h !== undefined ? lv.h - lv.l + 1 : lv.i ? 1 : g.w;
            W(s.rhs);
            return;
          }
        }
      }
      M.blocks.forEach(function (b, bi) { walk(b, bi); });
      S.forEach(function (s) { if (s.dir === 'output' && !drv.has(s.name)) err(s.line, "output '" + s.name + "' is never driven"); });
      var ord = ordered(M.assigns);
      if (ord) M.assigns = ord;
      return M;
    }

    function rng(seed) {
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function Sim(M, seed) {
      var v = Object.create(null), r = rng(seed || 7);
      M.sigs.forEach(function (s, n) {
        var x = N0;
        if (s.kind === 'reg') { for (var k = 0; k < s.w; k += 16) x = (x << N16) | BI(Math.floor(r() * 65536)); x &= mask(s.w); }
        v[n] = x;
      });
      function ev(n, cw) {
        var a, b, x;
        switch (n.t) {
          case 'num': return n.v & mask(cw);
          case 'id': return v[n.name];
          case 'idx': {
            var i = ev(n.i, n.i.w);
            if (i >= BI(M.sigs.get(n.name).w)) return N0;
            return (v[n.name] >> i) & N1;
          }
          case 'part': return (v[n.name] >> BI(n.l)) & mask(n.w);
          case 'cat':
            x = N0;
            for (var k = 0; k < n.items.length; k++) x = (x << BI(n.items[k].w)) | ev(n.items[k], n.items[k].w);
            return x;
          case 'rep': {
            var one = N0;
            for (var j = 0; j < n.items.length; j++) one = (one << BI(n.items[j].w)) | ev(n.items[j], n.items[j].w);
            var iw = BI(n.w / n.n);
            x = N0;
            for (var q = 0; q < n.n; q++) x = (x << iw) | one;
            return x;
          }
          case 'un':
            switch (n.op) {
              case '~': return (~ev(n.a, cw)) & mask(cw);
              case '-': return (-ev(n.a, cw)) & mask(cw);
              case '+': return ev(n.a, cw);
              case '!': return ev(n.a, n.a.w) === N0 ? N1 : N0;
              case '&': return ev(n.a, n.a.w) === mask(n.a.w) ? N1 : N0;
              case '|': return ev(n.a, n.a.w) !== N0 ? N1 : N0;
              case '^': { x = ev(n.a, n.a.w); var par = N0; while (x) { par ^= x & N1; x >>= N1; } return par; }
            }
            break;
          case 'bin': {
            var op = n.op;
            if (op === '&&') return (ev(n.a, n.a.w) !== N0 && ev(n.b, n.b.w) !== N0) ? N1 : N0;
            if (op === '||') return (ev(n.a, n.a.w) !== N0 || ev(n.b, n.b.w) !== N0) ? N1 : N0;
            if (op === '<<' || op === '>>') {
              a = ev(n.a, cw); b = ev(n.b, n.b.w);
              if (b >= BI(cw)) return N0;
              return op === '<<' ? (a << b) & mask(cw) : a >> b;
            }
            if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
              var ow = Math.max(n.a.w, n.b.w);
              a = ev(n.a, ow); b = ev(n.b, ow);
              var res = op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
              return res ? N1 : N0;
            }
            a = ev(n.a, cw); b = ev(n.b, cw);
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
            }
            return x & mask(cw);
          }
          case 'tern': return ev(n.c, n.c.w) !== N0 ? ev(n.a, cw) : ev(n.b, cw);
        }
        return N0;
      }
      function settle() {
        var A = M.assigns;
        for (var pass = 0; pass <= A.length + 1; pass++) {
          var ch = false;
          for (var i = 0; i < A.length; i++) {
            var a = A[i], s = M.sigs.get(a.lhs), nv = ev(a.rhs, Math.max(s.w, a.rhs.w)) & mask(s.w);
            if (nv !== v[a.lhs]) { v[a.lhs] = nv; ch = true; }
          }
          if (!ch) return;
        }
        err(A[0].line, 'combinational loop: the assigns never settle');
      }
      function exec(s, pend) {
        switch (s.t) {
          case 'blk': for (var i = 0; i < s.body.length; i++) exec(s.body[i], pend); return;
          case 'if': if (ev(s.c, s.c.w) !== N0) exec(s.th, pend); else if (s.el) exec(s.el, pend); return;
          case 'case': {
            var cw = s.sel.w;
            s.items.forEach(function (it) { it.labels.forEach(function (l) { cw = Math.max(cw, l.w); }); });
            var x = ev(s.sel, cw);
            for (var k = 0; k < s.items.length; k++) {
              for (var j = 0; j < s.items[k].labels.length; j++) if (ev(s.items[k].labels[j], cw) === x) { exec(s.items[k].s, pend); return; }
            }
            if (s.def) exec(s.def, pend);
            return;
          }
          case 'nb': {
            var lv = s.lv, g = M.sigs.get(lv.name), val = ev(s.rhs, Math.max(lv.w, s.rhs.w)) & mask(lv.w);
            if (lv.h === undefined && !lv.i) { pend.set(lv.name, val); return; }
            var base = pend.has(lv.name) ? pend.get(lv.name) : v[lv.name], lo, wd;
            if (lv.i) { lo = ev(lv.i, lv.i.w); if (lo >= BI(g.w)) return; wd = N1; }
            else { lo = BI(lv.l); wd = BI(lv.h - lv.l + 1); }
            var m = ((N1 << wd) - N1) << lo;
            pend.set(lv.name, (base & ~m & mask(g.w)) | ((val << lo) & m));
            return;
          }
        }
      }
      function tick() {
        var pend = new Map();
        for (var i = 0; i < M.blocks.length; i++) exec(M.blocks[i], pend);
        pend.forEach(function (x, k) { v[k] = x; });
        settle();
      }
      return {
        set: function (n, x) { v[n] = BI(x) & mask(M.sigs.get(n).w); },
        get: function (n) { return Number(v[n]); },
        settle: settle,
        tick: tick
      };
    }
    function compile(src) { var M = parse(normalize(src)); elaborate(M); return M; }
    function fail(e) {
      if (e && e.kata) return { ok: false, error: e.message, line: e.line };
      return { ok: false, error: 'internal error: ' + (e && e.message ? e.message : String(e)) };
    }
    /* Runs a design against a model {ports, ins, outs, stim()}. Outputs are compared after every rising
       edge; the run stops 10 cycles after the first mismatch so the waveform shows what follows it. */
    function run(model, src) {
      if (!OK) return { ok: false, error: 'This browser has no BigInt, so the testbench cannot run here.' };
      var M;
      try { M = compile(src); } catch (e) { return fail(e); }
      for (var i = 0; i < model.ports.length; i++) {
        var pd = model.ports[i], s = M.sigs.get(pd[0]);
        if (!s || s.dir !== pd[1] || s.w !== pd[2]) {
          return { ok: false, error: "port '" + pd[0] + "' must be " + pd[1] + (pd[2] > 1 ? ' [' + (pd[2] - 1) + ':0]' : '') + ', as in the skeleton', port: pd[0] };
        }
      }
      var st = model.stim(), trace = [], mism = null, stop = st.length;
      try {
        var sim = Sim(M, 99);
        for (var t = 0; t < st.length && t < stop; t++) {
          var c = st[t];
          for (var k in c.i) if (Object.prototype.hasOwnProperty.call(c.i, k)) sim.set(k, c.i[k]);
          sim.settle();
          sim.tick();
          var got = {}, j;
          for (j = 0; j < model.outs.length; j++) got[model.outs[j]] = sim.get(model.outs[j]);
          trace.push({ i: c.i, e: c.e, g: got, n: c.n || '' });
          if (!mism) {
            for (j = 0; j < model.outs.length; j++) {
              var o = model.outs[j];
              if (got[o] !== c.e[o]) { mism = { cycle: t, sig: o, exp: c.e[o], got: got[o], note: c.n || '' }; stop = t + 10; break; }
            }
          }
        }
      } catch (e2) { return fail(e2); }
      return { ok: !mism, mism: mism, trace: trace, cycles: st.length };
    }
    return { ok: OK, compile: compile, run: run, rng: rng, normalize: normalize };
  })();

  /* ==================================================================================================
     Reference models: one per kata id in content.js, with the same ports, reset, bit order and timing
     as its spec. Each stim() is deterministic and returns [{i: inputs, e: expected outputs, n: note}].
     ================================================================================================== */
  function lfsrStep(s) { return (s >> 1) ^ ((s & 1) ? 0xB8 : 0); }
  function crcStep(c, b) { var fb = ((c >> 7) & 1) ^ (b & 1); return ((c << 1) & 0xFF) ^ (fb ? 0x07 : 0); }
  function crcBytes(bytes, c0) {
    var c = c0 || 0;
    for (var i = 0; i < bytes.length; i++) for (var k = 7; k >= 0; k--) c = crcStep(c, (bytes[i] >> k) & 1);
    return c;
  }
  function h2(x) { return (x < 16 ? '0' : '') + x.toString(16).toUpperCase(); }

  var MODELS = {
    'k-shift': {
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['en', 'input', 1], ['din', 'input', 1], ['q', 'output', 4]],
      ins: ['rst', 'en', 'din'], outs: ['q'],
      stim: function () {
        var r = V.rng(44), out = [], q = 0, EX = [1, 0, 1, 1];
        for (var t = 0; t < 240; t++) {
          var rst = (t < 2 || t === 97 || t === 98 || t === 181 || t === 210) ? 1 : 0;
          var en = t < 24 ? 1 : (r() < 0.7 ? 1 : 0);
          var din = r() < 0.5 ? 1 : 0;
          if (t >= 2 && t < 6) din = EX[t - 2];           /* the spec's example: 0001, 0010, 0101, 1011 */
          if (t === 97 || t === 181) en = 1;              /* rst wins over en */
          if (t >= 206 && t < 210) { en = 1; din = 1; }   /* q = 1111, then a reset with en low must still clear it */
          if (t === 210 || t === 211) en = 0;
          var n;
          if (rst) { q = 0; n = 'rst high' + (en ? ' (en high too: rst wins)' : ' with en low: q still clears'); }
          else if (en) { q = ((q << 1) | din) & 15; n = 'en high, din ' + din; }
          else n = 'en low: q holds';
          out.push({ i: { rst: rst, en: en, din: din }, e: { q: q }, n: n });
        }
        return out;
      }
    },
    'k-lfsr': {
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['en', 'input', 1], ['seed', 'input', 8], ['state', 'output', 8], ['bit_out', 'output', 1]],
      ins: ['rst', 'en', 'seed'], outs: ['state', 'bit_out'],
      stim: function () {
        var r = V.rng(11), out = [], s = 0;
        for (var t = 0; t < 320; t++) {
          var rst = (t < 2 || t === 150 || t === 151 || t === 240 || t === 280) ? 1 : 0;
          var seed = t < 2 ? 1 : (t === 150 || t === 151) ? 0x5A : 1 + Math.floor(r() * 255);
          var en = t < 40 ? 1 : (r() < 0.8 ? 1 : 0);
          if (t === 280) { en = 0; seed = s !== 0x3C ? 0x3C : 0xC3; }   /* a reset with en low still loads seed */
          if (t === 281) en = 0;
          var n;
          if (rst) { s = seed; n = "rst high: state loads seed 8'h" + h2(seed) + (en ? ' (en high too: rst wins)' : ' (en low: rst still loads it)'); }
          else if (en) { s = lfsrStep(s); n = 'en high: one step'; }
          else n = 'en low: state holds';
          out.push({ i: { rst: rst, en: en, seed: seed }, e: { state: s, bit_out: s & 1 }, n: n });
        }
        return out;
      }
    },
    'k-crc': {
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['din', 'input', 1], ['valid', 'input', 1], ['crc', 'output', 8]],
      ins: ['rst', 'valid', 'din'], outs: ['crc'],
      stim: function () {
        var r = V.rng(22), out = [], c = 0, nb = 0, msg = [], one = [], oi = 0, j;
        '123456789'.split('').forEach(function (ch) { var b = ch.charCodeAt(0); for (var k = 7; k >= 0; k--) msg.push((b >> k) & 1); });
        for (j = 7; j >= 0; j--) one.push((1 >> j) & 1);
        for (var t = 0; t < 420; t++) {
          var rst = (t < 2 || t === 120 || t === 200 || t === 330) ? 1 : 0;
          var din = r() < 0.5 ? 1 : 0, valid = r() < 0.6 ? 1 : 0;
          if (t < 2 || t === 200) valid = 1;                               /* rst wins over valid */
          if (t >= 2 && t < 74) { din = msg[t - 2]; valid = 1; }          /* "123456789" back to back: F4 */
          if (t > 120 && t < 170 && valid && oi < 8) din = one[oi++];     /* 8'h01 with gaps: 07 */
          var n;
          if (rst) { c = 0; nb = 0; n = 'rst high' + (valid ? ' (valid high too: rst wins)' : ''); }
          else if (valid) { c = crcStep(c, din); nb++; n = 'valid high: message bit ' + nb + ' since reset, din ' + din; }
          else n = 'valid low: crc holds';
          out.push({ i: { rst: rst, valid: valid, din: din }, e: { crc: c }, n: n });
        }
        return out;
      }
    },
    'k-uart': {
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['start', 'input', 1], ['data', 'input', 8], ['tx', 'output', 1], ['busy', 'output', 1]],
      ins: ['rst', 'start', 'data'], outs: ['tx', 'busy'],
      stim: function () {
        var CPB = 4, r = V.rng(33), out = [], busy = 0, cnt = 0, bits = null, f0 = 0;
        for (var t = 0; t < 520; t++) {
          var rst = (t < 2 || t === 300) ? 1 : 0;
          var start = (t >= 380 && t < 480) ? 1 : (r() < 0.12 ? 1 : 0);
          var data = Math.floor(r() * 256);
          if (t === 1 || t === 300) start = 1;                              /* rst wins over start */
          var was = busy, n;
          if (rst) {
            n = 'rst high' + (start ? ' (start high too: rst wins)' : '') + (was ? ', aborting the frame from cycle ' + f0 : '');
            busy = 0; cnt = 0;
          } else if (!busy) {
            if (start) {
              busy = 1; cnt = 0; f0 = t; bits = [0];
              for (var k = 0; k < 8; k++) bits.push((data >> k) & 1);
              bits.push(1);
              n = "start while idle: edge 0 of a frame, data 8'h" + h2(data);
            } else n = 'idle';
          } else {
            cnt++;
            if (cnt === 10 * CPB) { busy = 0; n = 'edge 40 of the frame from cycle ' + f0 + ': busy drops' + (start ? ', and this start is ignored' : ''); }
            else {
              var bi = Math.floor(cnt / CPB);
              n = 'edge ' + cnt + ' of the frame from cycle ' + f0 + ': ' + (bi === 0 ? 'start bit' : bi === 9 ? 'stop bit' : 'data bit ' + (bi - 1)) + (start ? ' (start ignored)' : '');
            }
          }
          out.push({ i: { rst: rst, start: start, data: data }, e: { tx: busy ? bits[Math.floor(cnt / CPB)] : 1, busy: busy }, n: n });
        }
        return out;
      }
    },
    'k-badframe': {
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['in_valid', 'input', 1], ['in_byte', 'input', 8], ['in_last', 'input', 1],
        ['frame_done', 'output', 1], ['frame_bad', 'output', 1]],
      ins: ['rst', 'in_valid', 'in_byte', 'in_last'], outs: ['frame_done', 'frame_bad'],
      stim: function () {
        var r = V.rng(55), cyc = [], t, j;
        function rnd() { return Math.floor(r() * 256); }
        function idle() { cyc.push({ rst: 0, in_valid: 0, in_byte: rnd(), in_last: r() < 0.5 ? 1 : 0 }); }
        function put(b, last) { cyc.push({ rst: 0, in_valid: 1, in_byte: b, in_last: last ? 1 : 0 }); }
        function frame(p, chk) {
          for (var i = 0; i < p.length; i++) { if (r() < 0.25) idle(); put(p[i], false); }
          if (r() < 0.25) idle();
          put(chk, true);
        }
        cyc.push({ rst: 1, in_valid: 1, in_byte: 0x55, in_last: 1 });   /* rst wins over everything */
        cyc.push({ rst: 1, in_valid: 0, in_byte: 0x00, in_last: 0 });
        frame([0xA5], 0x72);                                             /* the spec's examples, both right */
        frame([0x31, 0x32, 0x33], 0xC0);
        frame([0xA5], 0x73);                                             /* one bit off */
        var cut = false, cutLow = false, afterDone = false;
        while (cyc.length < 400) {
          var len = 1 + Math.floor(r() * 4), p = [];
          for (j = 0; j < len; j++) p.push(rnd());
          if (!cut && cyc.length > 180) {                                /* a reset inside a frame drops it */
            cut = true;
            put(p[0], false);
            put(len > 1 ? p[1] : rnd(), false);
            cyc.push({ rst: 1, in_valid: 1, in_byte: rnd(), in_last: 0 });
            continue;
          }
          if (!cutLow && cyc.length > 250) {                             /* so does a reset with in_valid low */
            cutLow = true;
            put(p[0], false);
            put(len > 1 ? p[1] : rnd(), false);
            cyc.push({ rst: 1, in_valid: 0, in_byte: rnd(), in_last: 1 });
            continue;
          }
          var chk = crcBytes(p), flagNext = !afterDone && cyc.length > 320;
          if (flagNext) chk ^= 0x5A;                                     /* a bad frame, then a reset on the very next edge */
          else if (r() < 0.4) chk ^= 1 + Math.floor(r() * 255);
          frame(p, chk);
          if (flagNext) { afterDone = true; cyc.push({ rst: 1, in_valid: 0, in_byte: rnd(), in_last: 0 }); continue; }
          if (r() < 0.3) idle();
        }
        var out = [], c = 0, f = 1, nb = 0, wasDone = 0;
        for (t = 0; t < cyc.length; t++) {
          var x = cyc[t], done = 0, bad = 0, n;
          if (x.rst) {
            n = 'rst high' + (nb ? ': drops the partial frame' : '') + (wasDone ? ' right after a last byte: both outputs back to 0' : '') +
              (x.in_valid ? ' (in_valid high too: rst wins)' : nb ? ' (in_valid low: rst still drops it)' : '');
            c = 0; nb = 0;
          }
          else if (!x.in_valid) n = 'in_valid low: nothing accepted' + (x.in_last ? ' (in_last high, ignored)' : '');
          else if (x.in_last) {
            done = 1; bad = x.in_byte !== c ? 1 : 0;
            n = 'frame ' + f + ': last byte (byte ' + (nb + 1) + '), check value ' + (bad ? 'wrong' : 'right');
            c = 0; nb = 0; f++;
          } else { c = crcBytes([x.in_byte], c); nb++; n = 'frame ' + f + ': byte ' + nb; }
          out.push({ i: { rst: x.rst, in_valid: x.in_valid, in_byte: x.in_byte, in_last: x.in_last }, e: { frame_done: done, frame_bad: bad }, n: n });
          wasDone = done;
        }
        return out;
      }
    },
    'k-deser': {
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['din', 'input', 1], ['valid', 'input', 1], ['byte_out', 'output', 8], ['byte_valid', 'output', 1]],
      ins: ['rst', 'valid', 'din'], outs: ['byte_out', 'byte_valid'],
      stim: function () {
        var r = V.rng(66), cyc = [], j;
        function bitsOf(b) { var o = []; for (var k = 7; k >= 0; k--) o.push((b >> k) & 1); return o; }
        function put(bits, gaps) {
          bits.forEach(function (b) {
            if (gaps && r() < 0.3) cyc.push({ rst: 0, valid: 0, din: r() < 0.5 ? 1 : 0 });
            cyc.push({ rst: 0, valid: 1, din: b });
          });
        }
        cyc.push({ rst: 1, valid: 1, din: 1 });                         /* rst wins over valid */
        cyc.push({ rst: 1, valid: 0, din: 0 });
        put(bitsOf(0xA5), false);                                         /* the spec's example, back to back */
        put(bitsOf(0x3C), true);                                          /* a second byte, with gaps */
        for (j = 0; j < 6; j++) cyc.push({ rst: 0, valid: 0, din: r() < 0.5 ? 1 : 0 });   /* byte_out holds */
        put([1, 0, 1], false);                                            /* a partial byte, then a reset drops it */
        cyc.push({ rst: 1, valid: 1, din: 1 });
        put(bitsOf(0x81), false);
        put([0, 1, 1, 0, 1], false);                                      /* another partial byte; a reset with valid low drops it too */
        cyc.push({ rst: 1, valid: 0, din: 0 });
        put(bitsOf(0x5A), false);
        while (cyc.length < 300) cyc.push({ rst: 0, valid: r() < 0.7 ? 1 : 0, din: r() < 0.5 ? 1 : 0 });
        var out = [], sh = 0, n = 0, by = 0, nb = 0;
        cyc.forEach(function (x) {
          var bv = 0, note;
          if (x.rst) {
            note = 'rst high' + (n ? ': drops the partial byte (' + n + ' bits)' : '') + (x.valid ? ' (valid high too: rst wins)' : n ? ' (valid low: rst still drops it)' : '');
            sh = 0; n = 0; by = 0;
          }
          else if (!x.valid) note = 'valid low: nothing accepted, byte_out holds';
          else {
            sh = ((sh << 1) | x.din) & 255; n++;
            if (n === 8) { by = sh; bv = 1; n = 0; nb++; note = "bit 8 of byte " + nb + ": byte 8'h" + h2(by) + ' complete'; }
            else note = 'bit ' + n + ' of byte ' + (nb + 1) + ', din ' + x.din;
          }
          out.push({ i: { rst: x.rst, valid: x.valid, din: x.din }, e: { byte_out: by, byte_valid: bv }, n: note });
        });
        return out;
      }
    },
    'k-pattern': {
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['din', 'input', 1], ['valid', 'input', 1], ['hit', 'output', 1]],
      ins: ['rst', 'valid', 'din'], outs: ['hit'],
      stim: function () {
        var r = V.rng(77), cyc = [];
        function put(bits, gaps) {
          bits.forEach(function (b) {
            if (gaps && r() < 0.35) cyc.push({ rst: 0, valid: 0, din: r() < 0.5 ? 1 : 0 });
            cyc.push({ rst: 0, valid: 1, din: b });
          });
        }
        cyc.push({ rst: 1, valid: 1, din: 1 });                         /* rst wins over valid */
        cyc.push({ rst: 1, valid: 0, din: 0 });
        put([1, 1, 0, 1, 1, 0, 1], false);                                /* the spec's overlap example: two hits */
        cyc.push({ rst: 0, valid: 0, din: 1 });                         /* valid low right after a hit: hit drops */
        put([0, 1, 1, 0, 1], true);                                       /* a match with idle edges inside it */
        put([1, 1, 0], false);                                            /* three of four, then a reset forgets them */
        cyc.push({ rst: 1, valid: 0, din: 0 });
        put([1, 0, 1, 1, 0, 1], false);
        put([1, 1, 0], false);                                            /* 1, 1, 0, then rst with valid high and din 1: */
        cyc.push({ rst: 1, valid: 1, din: 1 });                          /* accepting that bit would complete a match; rst wins */
        put([1, 0, 1], false);
        while (cyc.length < 320) cyc.push({ rst: 0, valid: r() < 0.75 ? 1 : 0, din: r() < 0.55 ? 1 : 0 });
        var out = [], h = 0, n = 0;
        cyc.forEach(function (x) {
          var hit = 0, note;
          if (x.rst) { note = 'rst high: forgets ' + Math.min(n, 4) + ' remembered bits' + (x.valid ? ' (valid high too: rst wins)' : ''); h = 0; n = 0; }
          else if (!x.valid) note = 'valid low: nothing accepted, hit 0';
          else {
            h = ((h << 1) | x.din) & 15; n++;
            hit = n >= 4 && h === 13 ? 1 : 0;
            note = 'accepted din ' + x.din + '; last four since reset: ' + (n >= 4 ? [3, 2, 1, 0].map(function (k) { return (h >> k) & 1; }).join(', ') : 'fewer than four');
          }
          out.push({ i: { rst: x.rst, valid: x.valid, din: x.din }, e: { hit: hit }, n: note });
        });
        return out;
      }
    }
  };
  function widthsOf(model) { var w = {}; model.ports.forEach(function (p) { w[p[0]] = p[2]; }); return w; }

  /* ---------- pure presentation helpers (also exported for the node test) ---------- */
  function escH(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function fmtV(v, w) {
    if (v == null) return '';
    if (w === 1) return String(v);
    var s;
    if (w <= 4) { s = v.toString(2); while (s.length < w) s = '0' + s; return w + "'b" + s; }
    s = v.toString(16).toUpperCase();
    while (s.length < Math.ceil(w / 4)) s = '0' + s;
    return w + "'h" + s;
  }
  /* Waveform of cycles [a, b) as SVG; with a mismatch m, its column is shaded and the expected values of
     its signal get a row of their own. Colours are CSS tokens, so both themes work. */
  function waveSvg(model, widths, tr, a, b, m) {
    var rows = [];
    b = Math.min(b, tr.length);
    a = Math.max(0, Math.min(a, b));
    model.ins.forEach(function (n) { rows.push({ n: n, w: widths[n], f: function (c) { return c.i[n]; } }); });
    model.outs.forEach(function (n) {
      rows.push({ n: n, w: widths[n], f: function (c) { return c.g[n]; } });
      if (m && m.sig === n) rows.push({ n: n + ' exp', w: widths[n], f: function (c) { return c.e[n]; }, exp: true });
    });
    var CW = 26, RH = 28, LW = 102, n = b - a, Wd = LW + n * CW + 8, H = 22 + rows.length * RH, c, x;
    var s = '<svg width="' + Wd + '" height="' + H + '" viewBox="0 0 ' + Wd + ' ' + H + '" role="img" aria-label="Waveform, cycles ' + a + ' to ' + (b - 1) +
      '" style="display:block;font-family:var(--mono);font-size:11px">';
    if (m) s += '<rect x="' + (LW + (m.cycle - a) * CW) + '" y="0" width="' + CW + '" height="' + H + '" style="fill:var(--bad);opacity:.16"/>';
    for (c = a; c < b; c++) {
      x = LW + (c - a) * CW;
      s += '<line x1="' + x + '" y1="16" x2="' + x + '" y2="' + H + '" style="stroke:var(--line);stroke-width:1"/>';
      if (c % 5 === 0) s += '<text x="' + (x + 2) + '" y="12" style="fill:var(--muted)">' + c + '</text>';
    }
    rows.forEach(function (r, ri) {
      var y0 = 22 + ri * RH, hi = y0 + 4, lo = y0 + RH - 6, col = r.exp ? 'var(--accent)' : 'var(--text)', cc, xx;
      s += '<text x="4" y="' + (y0 + RH / 2 + 2) + '" style="fill:' + (r.exp ? 'var(--accent)' : 'var(--muted)') + '">' + escH(r.n) + '</text>';
      if (r.w === 1) {
        var pts = '';
        for (cc = a; cc < b; cc++) { var vv = r.f(tr[cc]), yy = vv ? hi : lo; xx = LW + (cc - a) * CW; pts += xx + ',' + yy + ' ' + (xx + CW) + ',' + yy + ' '; }
        s += '<polyline points="' + pts + '" style="fill:none;stroke:' + col + ';stroke-width:1.6"/>';
      } else {
        var c0 = a;
        while (c0 < b) {
          var v0 = r.f(tr[c0]), c1 = c0 + 1;
          while (c1 < b && r.f(tr[c1]) === v0) c1++;
          var x0 = LW + (c0 - a) * CW + 1, x1 = LW + (c1 - a) * CW - 1, ym = (hi + lo) / 2;
          s += '<polygon points="' + x0 + ',' + ym + ' ' + (x0 + 3) + ',' + hi + ' ' + (x1 - 3) + ',' + hi + ' ' + x1 + ',' + ym + ' ' + (x1 - 3) + ',' + lo + ' ' + (x0 + 3) + ',' + lo +
            '" style="fill:none;stroke:' + col + ';stroke-width:1.2"/>';
          var lab = v0.toString(16).toUpperCase();
          while (lab.length < Math.ceil(r.w / 4)) lab = '0' + lab;
          if ((x1 - x0) > lab.length * 7 + 4) s += '<text x="' + ((x0 + x1) / 2) + '" y="' + (ym + 4) + '" text-anchor="middle" style="fill:' + col + '">' + lab + '</text>';
          c0 = c1;
        }
      }
    });
    return s + '</svg>';
  }

  /* Words the UI shows. None names a technique: the same text serves hidden katas. */
  var TEXT = {
    callHint: 'Sketch the design with the Pencil or a mouse, then write the call in one line. Committing opens the editor and starts the clock.',
    chipsLocked: 'The chips unlock once the call has ink or a line.',
    editorLocked: 'The editor opens when you commit the call.',
    hiddenWhy: 'Topic hidden: working out what the spec needs is part of the kata.',
    calledHint: 'Read your call above and tick the methods it named. None ticked means it named none of these. The kata’s tags show after this step.',
    tookHint: 'Pre-ticked with the kata’s tags. If your design took another route, tick what it used instead.',
    practice: 'Runs from here on are practice: the rating does not move again.',
    lang: '<p class="sr-hint">The editor takes a small Verilog subset, run in the page.</p><pre>' +
      'module name ( input [7:0] a, output reg b ); … endmodule\n' +
      'input / output [reg] [N:0] name;   reg [N:0] name;   wire [N:0] name [= expr];\n' +
      'parameter NAME = 4;   localparam NAME = 4;\n' +
      'assign name = expr;\n' +
      'always @(posedge clk) statement     (nonblocking &lt;= only; reset is synchronous)\n' +
      'if (…) … else …   begin … end   case (x) v1, v2: … default: … endcase\n' +
      'name[i] &lt;= …   name[h:l] &lt;= …\n' +
      '+ - * / %   &amp; | ^ ~^ ~ !   &lt;&lt; &gt;&gt;   == != &lt; &lt;= &gt; &gt;=   &amp;&amp; ||   ?:\n' +
      'unary &amp; | ^ (reductions)   a[i]  a[h:l]  {a, b}  {4{a}}   8\'h07  4\'b1010  1\'b0  42</pre>' +
      '<p class="sr-hint">Widths follow Verilog sizing rules, up to 64 bits. Registers power up with random values. No x or z, no loops, ' +
      'no functions, no blocking assignments, no memories. Outputs are checked after every rising edge.</p>',
    gate: function (areaName, E) {
      var band = '';
      if (typeof E === 'number' && isFinite(E)) {
        band = E < 0.6 ? ' At your rating it sits above your stretch band (E ' + E.toFixed(2) + ', against 0.60 to 0.70).'
          : E > 0.7 ? ' At your rating it sits below your stretch band (E ' + E.toFixed(2) + ').'
          : ' At your rating it sits inside your stretch band (E ' + E.toFixed(2) + ').';
      }
      return 'A push kata: Today offers it once ' + areaName + ' is in push mode.' + band + ' Open it now if you want the reach.';
    }
  };

  var api = {
    ok: V.ok, compile: V.compile, run: V.run, rng: V.rng, normalize: V.normalize,
    models: MODELS, widths: widthsOf, lfsrStep: lfsrStep, crcStep: crcStep, crcBytes: crcBytes,
    waveSvg: waveSvg, fmtV: fmtV, text: TEXT
  };
  var K = SR.kata = SR.kata || {};
  K.sim = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  /* ==================================================================================================
     UI (browser only)
     ================================================================================================== */
  var esc = SR.esc || escH;
  var CONF = [50, 60, 70, 80, 90];
  var PAD_W = 800, PAD_H = 220, LINE_H = 22, MIN_ROWS = 14, PASS_WIN = 32;
  var views = [], seq = 0;
  /* The editor saves 400 ms after the last keystroke. A reload, a closed tab or an iPad tab discarded in the
     background inside that window would lose the last edit, so every open view saves at once when the page
     is hidden or unloads. */
  function flushAll() { views.slice().forEach(function (v) { if (!v.dead && typeof v.flush === 'function') { try { v.flush(); } catch (e) {} } }); }
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('pagehide', flushAll);
    root.addEventListener('beforeunload', flushAll);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushAll(); });
  }

  SR.style && SR.style('kata', [
    '.kt{font:14px/1.45 var(--ui);color:var(--text);position:relative}',
    '.kt.kt-doc{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:12px 16px 14px}',
    '.kt.kt-sheet{max-width:940px;margin:0 auto}',
    '.kt.kt-gate,.kt.kt-parked{border-style:dashed}',
    '.kt .kt-h{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}',
    '.kt .kt-h .sp{flex:1}',
    '.kt .kt-h button{font-size:13px;min-height:30px;padding:4px 10px}',
    '.kt .kt-q{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--after);color:var(--after);font:700 13px/1 var(--ui)}',
    '.kt .kt-push{color:var(--warn)}',
    '.kt .kt-t{font-weight:650;font-size:17px;line-height:1.3;margin:6px 0 2px}',
    '.kt .kt-meta{display:flex;flex-wrap:wrap;gap:2px 14px;font-size:12.5px;color:var(--muted);margin:2px 0 6px;align-items:baseline}',
    '.kt .kt-meta b{font:600 12.5px var(--mono);color:var(--text)}',
    '.kt .kt-meta .sr-demo{margin-left:4px}',
    '.kt .kt-why{margin:4px 0 8px}',
    '.kt .kt-smallhint{display:none;margin:2px 0 6px}',
    '.kt.kt-small .kt-smallhint{display:block}',
    'div.kt .kt-spec{font-size:14.5px;line-height:1.5;margin-top:8px}',
    'div.kt .kt-spec .sr-by{margin:0 0 4px}',
    'div.kt p{margin:6px 0}',
    'div.kt ul{padding-left:20px;margin:6px 0}',
    'div.kt li{margin:3px 0}',
    'div.kt code{font:13px var(--mono)}',
    '.kt .kt-ports{color:var(--muted);font-size:13px}',
    '.kt .kt-pl{font:600 11px/1.4 var(--ui);letter-spacing:.06em;text-transform:uppercase;margin:0 6px 0 10px}',
    '.kt .kt-pl:first-child{margin-left:0}',
    '.kt .kt-sec{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}',
    '.kt .kt-pad{margin:6px 0}',
    '.kt .kt-padtools{margin-bottom:8px}',
    'div.kt input.kt-line{display:block;width:100%;font-size:15px;padding:8px 10px;margin:4px 0}',
    '.kt .kt-conf{margin:6px 0}',
    '.kt .kt-chips{display:inline-flex;flex-wrap:wrap;gap:6px}',
    '.kt .kt-chips button{border-radius:999px;font:13px var(--mono);min-height:32px;padding:4px 12px;min-width:56px}',
    '.kt .kt-callro{border-left:3px solid var(--accent);padding:4px 0 4px 10px;margin-top:8px;font-size:15px}',
    '.kt .kt-ed{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);margin-top:4px}',
    '.kt .kt-gut{font:12.5px/' + LINE_H + 'px var(--mono);padding:10px 6px;color:var(--muted);text-align:right;user-select:none;-webkit-user-select:none;min-width:38px;white-space:pre;border-right:1px solid var(--line)}',
    '.kt .kt-gut .el{color:var(--bad);font-weight:700}',
    'div.kt textarea.kt-src{flex:1;min-width:0;display:block;font:14px/' + LINE_H + 'px var(--mono);padding:10px;border:0;border-radius:0;outline:0;resize:none;background:transparent;color:var(--text);white-space:pre;overflow-x:auto;overflow-y:hidden;tab-size:2;-moz-tab-size:2}',
    '@media (pointer:coarse){div.kt textarea.kt-src,div.kt input.kt-line{font-size:16px}}',
    '.kt .kt-tools{margin-top:8px}',
    '.kt .kt-res{margin-top:10px;border-radius:8px;padding:10px 12px;border:1px solid var(--line);background:var(--paper)}',
    '.kt .kt-res.pass{border-color:var(--good)}.kt .kt-res.fail{border-color:var(--bad)}',
    '.kt .kt-big{font-weight:700;font-size:16px}',
    '.kt .kt-res.pass .kt-big{color:var(--good)}.kt .kt-res.fail .kt-big{color:var(--bad)}',
    'div.kt .kt-res pre{font:13px/1.45 var(--mono);white-space:pre-wrap;margin:6px 0 0;background:none;border:0;padding:0}',
    'div.kt table{border-collapse:collapse;font:13px/1.4 var(--ui);margin:8px 0 0}',
    'div.kt th,div.kt td{border:1px solid var(--line);padding:3px 8px;text-align:left}',
    'div.kt td{font-family:var(--mono)}',
    '.kt .kt-wave{overflow-x:auto;margin-top:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);-webkit-overflow-scrolling:touch}',
    'div.kt .kt-wave svg{max-width:none;display:block}',
    '.kt .kt-hist{font-size:12.5px;color:var(--muted);margin:8px 0 0;padding-left:22px}',
    '.kt .kt-verdict{font-variant-numeric:tabular-nums}',
    '.kt .kt-up{color:var(--good)}.kt .kt-down{color:var(--bad)}',
    '.kt .kt-step{margin-top:10px}',
    '.kt .kt-steph{font-weight:650;margin-bottom:2px}',
    '.kt .kt-toggles{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}',
    '.kt .kt-toggles button{font-size:13px;padding:5px 10px;min-height:32px}',
    '.kt .kt-toggles button.on{font-weight:600;background:var(--tint)}',
    '.kt .kt-hit{color:var(--good)}.kt .kt-miss{color:var(--bad)}',
    '.kt .kt-gap{margin:10px 0;padding:8px 12px;border-left:3px solid var(--after);background:var(--tint);border-radius:0 8px 8px 0}',
    '.kt .kt-links{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;margin:6px 0}',
    '.kt .kt-links .sr-stage{margin-left:5px}',
    '.kt details.kt-lang{margin-top:12px}',
    '.kt details.kt-lang summary{cursor:pointer;color:var(--muted);font-size:13px}',
    'div.kt .kt-lang pre{font:12.5px/1.5 var(--mono);white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:6px 0}'
  ].join('\n'));

  /* ---------- content, engine, store ---------- */
  function content() { return SR.content || {}; }
  function kataById(id) {
    var L = content().katas;
    if (!Array.isArray(L)) return null;
    for (var i = 0; i < L.length; i++) if (L[i] && L[i].id === id) return L[i];
    return null;
  }
  function eng(fn) {
    var e = SR.engine;
    if (!e || typeof e[fn] !== 'function') return undefined;
    try { return e[fn].apply(e, [].slice.call(arguments, 1)); }
    catch (er) { console.error('[SR] engine.' + fn + ' failed:', er); return undefined; }
  }
  function designMethods(k) {
    var m = content().methods, L = m && Array.isArray(m.design) ? m.design.slice() : [];
    (k && k.methods || []).forEach(function (id) { if (!L.some(function (x) { return x && x.id === id; })) L.push({ id: id, label: methodLabel(id) }); });
    return L;
  }
  function methodEntry(id) {
    var m = content().methods || {}, all = [].concat(m.design || [], m.math || []);
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
    return null;
  }
  function methodLabel(id) {
    var e = methodEntry(id);
    if (e && e.label) return String(e.label);
    var l = eng('methodLabel', id);
    return l ? String(l) : String(id);
  }
  function labels(list) { return (list || []).map(methodLabel).join(', '); }
  function docOf(id) { var d = content().docs || {}; return Object.prototype.hasOwnProperty.call(d, id) ? d[id] : null; }
  function docTitle(id) { var d = docOf(id); return d && d.title ? String(d.title) : String(id); }
  function areaName(a) {
    var ar = content().areas || {};
    if (ar[a] && ar[a].label) return String(ar[a].label);
    return a === 'dd' ? 'Digital design' : String(a || '');
  }
  function sget(k, d) { try { return SR.store ? SR.store.get(k, d) : d; } catch (e) { return d; } }
  function sset(k, v) { try { if (SR.store) SR.store.set(k, v); } catch (e) {} }
  function stKey(id) { return 'kata-' + id; }
  function inkKey(id) { return 'kata-ink-' + id; }
  function fresh(k) {
    return { v: 1, committed: false, call: '', conf: null, t0: null, t1: null, code: String(k.skeleton || ''), runs: [], status: 'open',
      lastSrc: null, settle: null, practicePass: false, opened: false,
      called: [], calledDone: false, took: [], tookInit: false, tookDone: false, tick: null };
  }
  function load(k) {
    var s = sget(stKey(k.id), null);
    if (!s || typeof s !== 'object' || s.v !== 1) s = fresh(k);
    if (!Array.isArray(s.runs)) s.runs = [];
    if (!Array.isArray(s.called)) s.called = [];
    if (!Array.isArray(s.took)) s.took = [];
    if (typeof s.code !== 'string') s.code = String(k.skeleton || '');
    return s;
  }
  function save(k, s) { sset(stKey(k.id), s); }
  function counted(s) { return s.runs.filter(function (r) { return !r.err && !r.practice; }).length; }
  function num(x) { var n = typeof x === 'number' ? x : parseFloat(x); return isFinite(n) ? n : NaN; }
  function f2(x) { return (+x).toFixed(2); }
  function fmtD(d) { return d % 1 ? d.toFixed(1) : String(d); }
  function uniq(a) { var o = []; (a || []).forEach(function (x) { if (x != null && o.indexOf(x) < 0) o.push(x); }); return o; }
  function brief(r) {
    return { E: r.E, rBefore: r.rBefore, rAfter: r.rAfter, score: r.score, verdict: r.verdict, pass: !!r.pass, runs: r.runs,
      gaveUp: !!r.gaveUp, hidden: !!r.hidden, reach: !!r.reach, area: r.area };
  }
  /* The engine is the record of a settle: a kata it already holds shows as settled here too. */
  function synced(k) {
    var s = load(k), rec = eng('kataResult', k.id);
    if (rec && !s.settle) {
      s.settle = brief(rec);
      s.committed = true;
      if (s.status === 'open') s.status = rec.pass ? 'passed' : 'gaveup';
      if (!rec.methodsPending) {
        s.called = (rec.called || []).slice(); s.took = (rec.took || []).slice();
        s.calledDone = s.tookInit = s.tookDone = true;
        s.tick = { hit: rec.methodHit, extra: rec.extra || [], gap: rec.recognitionGap || null, links: rec.linksBack || [] };
      }
      save(k, s);
    }
    return s;
  }
  function padBg(ctx, w, h) {
    ctx.fillStyle = SR.ink && SR.ink.color ? SR.ink.color('--line') : '#d9d4ca';
    for (var x = 20; x < w; x += 40) for (var y = 20; y < h; y += 40) ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
  }
  function sheetOpen(id) { return views.some(function (v) { return v.sheet && !v.dead && v.id === id; }); }
  function refreshInline(id) { views.slice().forEach(function (v) { if (!v.sheet && !v.dead && v.id === id) v.render(); }); }
  function emit(id) { if (SR.bus) SR.bus.emit('kata:change', { id: id }); }

  /* ---------- one view of one kata: inline in a doc (o.ctx) or in a sheet (o.sheet) ---------- */
  function createView(host, k, o) {
    o = o || {};
    var self = { id: k.id, k: k, sheet: !!o.sheet, o: o, dead: false, gateWas: null, uid: ++seq };
    var model = MODELS[k.id] || null, widths = model ? widthsOf(model) : {};
    var el = document.createElement('div');
    el.setAttribute('data-kata', k.id);
    host.innerHTML = '';
    host.appendChild(el);
    var pad = null, timer = 0, saveT = 0, offs = [], tt = { t0: null, t1: null };

    function q(sel) { return el.querySelector(sel); }
    function area() { return k.area || 'dd'; }
    function hidden() { return !!k.hidden || o.hidden === true; }
    function relayout() {
      if (self.sheet || !o.ctx || typeof o.ctx.relayout !== 'function') return;
      try { o.ctx.relayout(); } catch (e) {}
    }
    function destroyPad() { if (pad) { try { pad.destroy(); } catch (e) {} pad = null; } }
    function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }
    function startTimer() {
      stopTimer();
      if (!tt.t0 || tt.t1) return;
      timer = setInterval(function () {
        if (self.dead) { stopTimer(); return; }
        var t = q('.kt-time');
        if (t && SR.fmt) t.textContent = SR.fmt.dur(Date.now() - tt.t0);
      }, 1000);
    }
    function flush() {
      if (!saveT) return;
      clearTimeout(saveT);
      saveT = 0;
      var ta = q('.kt-src');
      if (ta) { var s = load(k); s.code = ta.value; save(k, s); }
    }

    /* ----- head and meta ----- */
    function expectedNow() {
      var d = num(k.d), r = eng('rating', area());
      if (!isFinite(d) || typeof r !== 'number' || !isFinite(r)) return null;
      var E = eng('expected', d, r);
      return typeof E === 'number' && isFinite(E) ? { E: E, r: r, d: d } : null;
    }
    function timeText(s) { return s.t0 && SR.fmt ? SR.fmt.dur((s.t1 || Date.now()) - s.t0) : '–'; }
    function statusText(s) {
      if (s.status === 'passed') return 'passed';
      if (s.status === 'gaveup') return s.practicePass ? 'gave up, passed later' : 'gave up';
      return s.committed ? 'open' : 'call first';
    }
    function metaHtml(s, short) {
      var x = expectedNow(), d = num(k.d), h = '';
      if (isFinite(d)) h += '<span>difficulty <b>' + fmtD(d) + '</b></span>';
      if (x) h += '<span title="Expected score at your ' + esc(areaName(area()).toLowerCase()) + ' rating">E <b>' + f2(x.E) + '</b> at r <b>' + f2(x.r) + '</b> <span class="sr-demo">' + esc(SR.LABEL_DEMO || 'Demo data') + '</span></span>';
      if (short) return h;
      h += '<span>runs <b class="kt-runs">' + counted(s) + '</b></span>';
      h += '<span>time <b class="kt-time">' + timeText(s) + '</b></span>';
      h += '<span>status <b>' + esc(statusText(s)) + '</b></span>';
      return h;
    }
    function renderMeta(s) { var m = q('.kt-meta'); if (m) m.innerHTML = metaHtml(s || load(k), !!q('.kt-gatebox')); }
    function headHtml(s) {
      var hard = k.level === 'hard';
      var h = '<div class="kt-h"><span class="sr-kick">Design kata</span><span class="sr-badge">' + (hard ? 'hard' : 'simple') + '</span>';
      if (hidden()) h += '<span class="kt-q" title="Topic hidden" aria-label="Topic hidden">?</span>';
      if (o.reach) h += '<span class="sr-badge kt-push">reach</span>';
      else if (hard && !hidden() && eng('inPush', area()) === true) h += '<span class="sr-badge kt-push">push</span>';
      h += '<span class="sp"></span>';
      if (!self.sheet) h += '<button type="button" data-k="panel">Open in a panel</button>';
      h += '</div><div class="kt-t">' + esc(k.title || k.id) + '</div><div class="kt-meta">' + metaHtml(s) + '</div>';
      if (!self.sheet) h += '<p class="sr-hint kt-smallhint">The page is scaled down on this screen: open the kata in a panel to sketch and type.</p>';
      var why = o.why || (hidden() ? TEXT.hiddenWhy : '');
      if (why) h += '<p class="sr-hint kt-why">' + esc(why) + '</p>';
      return h;
    }
    /* Inside a doc the page is CSS-scaled; on a phone that makes the editor too small to use. */
    function markSmall() {
      if (self.sheet || self.dead || !el.isConnected) return;
      var w = el.offsetWidth, r = el.getBoundingClientRect().width, small = w > 0 && r > 0 && r / w < 0.7;
      el.classList.toggle('kt-small', small);
      var pb = q('[data-k="panel"]');
      if (pb) pb.classList.toggle('primary', small);
    }
    function specHtml() {
      var ports = model ? model.ports : (Array.isArray(k.ports) ? k.ports : []), ins = [], outs = [];
      ports.forEach(function (p) {
        var t = '<code>' + esc(p[0]) + (p[2] > 1 ? '[' + (p[2] - 1) + ':0]' : '') + '</code>';
        (p[1] === 'input' ? ins : outs).push(t);
      });
      return '<div class="kt-spec"><div class="sr-by">' + esc(SR.LABEL_MODEL || MODEL_LABEL) + '</div>' +
        (k.spec ? String(k.spec) : '<p class="sr-hint">No spec in the content.</p>') +
        (ports.length ? '<p class="kt-ports"><span class="kt-pl">in</span>' + ins.join(', ') + '<span class="kt-pl">out</span>' + outs.join(', ') + '</p>' : '') +
        '</div>';
    }

    /* ----- gate (hard katas in docs, outside push mode) and parked (open in a sheet) ----- */
    function gated(s) {
      if (self.sheet || k.level !== 'hard' || hidden()) return false;
      if (s.opened || s.committed || s.settle) return false;
      return eng('inPush', area()) === false;
    }
    function gateHtml(s) {
      var x = expectedNow();
      return '<div class="kt-h"><span class="sr-kick">Design kata</span><span class="sr-badge">hard</span><span class="sr-badge kt-push">push</span></div>' +
        '<div class="kt-t">' + esc(k.title || k.id) + '</div><div class="kt-meta">' + metaHtml(s, true) + '</div>' +
        '<div class="kt-gatebox"><p class="sr-hint">' + esc(TEXT.gate(areaName(area()).toLowerCase(), x ? x.E : null)) + '</p>' +
        '<div class="sr-row"><button type="button" data-k="open">Open it now</button></div></div>';
    }
    function parkedHtml() {
      return '<div class="kt-h"><span class="sr-kick">Design kata</span></div><div class="kt-t">' + esc(k.title || k.id) + '</div>' +
        '<p class="sr-hint">Open in a panel. Close the panel to carry on here.</p>';
    }

    /* ----- the whole view ----- */
    function render() {
      if (self.dead) return;
      flush();
      destroyPad();
      stopTimer();
      var s = synced(k);
      tt.t0 = s.t0; tt.t1 = s.t1;
      if (!self.sheet && sheetOpen(k.id)) {
        self.gateWas = null;
        el.className = 'kt kt-doc kt-parked';
        el.innerHTML = parkedHtml();
        relayout();
        return;
      }
      var g = gated(s);
      self.gateWas = g;
      if (g) {
        el.className = 'kt kt-doc kt-gate';
        el.innerHTML = gateHtml(s);
        q('[data-k="open"]').addEventListener('click', function () {
          var s2 = load(k);
          s2.opened = true;
          save(k, s2);
          render();
          emit(k.id);
        });
        relayout();
        return;
      }
      el.className = 'kt ' + (self.sheet ? 'kt-sheet' : 'kt-doc');
      el.innerHTML = headHtml(s) + specHtml() +
        '<div class="kt-work no-ink"><section class="kt-sec kt-call"></section><section class="kt-sec kt-code"></section>' +
        '<section class="kt-sec kt-settle" hidden></section>' +
        '<details class="kt-lang"><summary>Language reference</summary>' + TEXT.lang + '</details></div>';
      var pb = q('[data-k="panel"]');
      if (pb) pb.addEventListener('click', function () { open(k); });
      renderCall(s);
      renderCode(s);
      renderSettle(s);
      if (/\$|\\\(/.test(String(k.spec || '')) && SR.typeset) SR.typeset(q('.kt-spec'));
      startTimer();
      markSmall();
      relayout();
    }

    /* ----- 1. the design call ----- */
    function renderCall(s) {
      var sec = q('.kt-call');
      if (!sec) return;
      destroyPad();
      if (!s.committed) {
        sec.innerHTML = '<div class="sr-kick">Design call</div><p class="sr-hint">' + esc(TEXT.callHint) + '</p>' +
          '<div class="kt-pad" role="group" aria-label="Design call sketch"></div>' +
          '<div class="sr-row kt-padtools"><button type="button" data-k="undo">Undo</button><button type="button" data-k="clear">Clear sketch</button></div>' +
          '<input type="text" class="kt-line" maxlength="200" placeholder="Your call, one line" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Your call, one line">' +
          '<div class="sr-row kt-conf"><span class="sr-hint">Confidence the first run passes</span><span class="kt-chips">' +
          CONF.map(function (c) { return '<button type="button" data-conf="' + c + '"' + (s.conf === c ? ' class="sel"' : '') + '>' + c + '%</button>'; }).join('') +
          '</span></div><div class="sr-row"><button type="button" class="primary" data-k="commit">Commit call</button><span class="sr-hint kt-callhint"></span></div>';
        var line = sec.querySelector('.kt-line');
        line.value = s.call || '';
        if (SR.ink) pad = SR.ink.create(sec.querySelector('.kt-pad'), { width: PAD_W, height: PAD_H, key: inkKey(k.id), background: padBg, onChange: refreshCall });
        sec.querySelector('[data-k="undo"]').addEventListener('click', function () { if (pad) pad.undo(); });
        SR.twoTap(sec.querySelector('[data-k="clear"]'), 'Tap again to clear', function () { if (pad) pad.clear(); });
        line.addEventListener('input', function () { var s2 = load(k); s2.call = line.value; save(k, s2); refreshCall(); });
        [].forEach.call(sec.querySelectorAll('[data-conf]'), function (b) {
          b.addEventListener('click', function () {
            if (b.disabled) return;
            var s2 = load(k);
            s2.conf = +b.getAttribute('data-conf');
            save(k, s2);
            [].forEach.call(sec.querySelectorAll('[data-conf]'), function (x) { x.classList.toggle('sel', x === b); });
            refreshCall();
          });
        });
        sec.querySelector('[data-k="commit"]').addEventListener('click', commit);
        refreshCall();
        return;
      }
      var n = (sget(inkKey(k.id), []) || []).length;
      sec.innerHTML = '<div class="sr-kick">Design call</div>' + (n ? '<div class="kt-pad" role="img" aria-label="Your sketch"></div>' : '<p class="sr-hint">No sketch.</p>') +
        '<div class="kt-callro"><div class="kt-calltext">' + (s.call ? esc(s.call) : '<span class="muted">(no typed line)</span>') + '</div>' +
        '<div class="sr-hint">' + (s.conf ? s.conf + '% that the first run passes' : 'no confidence given') + '</div></div>';
      if (n && SR.ink) pad = SR.ink.create(sec.querySelector('.kt-pad'), { width: PAD_W, height: PAD_H, key: inkKey(k.id), background: padBg, readOnly: true });
    }
    function hasCall() {
      var line = q('.kt-call .kt-line');
      return (pad ? pad.count() : 0) > 0 || !!(line && line.value.trim());
    }
    function refreshCall() {
      var sec = q('.kt-call'), cm = sec && sec.querySelector('[data-k="commit"]'), hint = sec && sec.querySelector('.kt-callhint');
      if (!cm) return;
      var s = load(k), has = hasCall();
      [].forEach.call(sec.querySelectorAll('[data-conf]'), function (b) { b.disabled = !has; });
      cm.disabled = !(has && s.conf);
      if (hint) hint.textContent = !has ? TEXT.chipsLocked : !s.conf ? 'Pick a confidence to commit.' : 'Committing locks the call and starts the clock.';
    }
    function commit() {
      var line = q('.kt-call .kt-line'), s = load(k);
      if (s.committed || !hasCall() || !s.conf) return;
      s.call = line ? line.value.trim() : s.call;
      s.committed = true;
      s.t0 = Date.now();
      s.t1 = null;
      save(k, s);
      tt.t0 = s.t0; tt.t1 = null;
      renderCall(s);
      renderCode(s);
      renderMeta(s);
      startTimer();
      emit(k.id);
      relayout();
    }

    /* ----- 2. the editor and the testbench ----- */
    function renderCode(s) {
      var sec = q('.kt-code');
      if (!sec) return;
      if (!s.committed) { sec.innerHTML = '<div class="sr-kick">RTL</div><p class="sr-hint">' + esc(TEXT.editorLocked) + '</p>'; return; }
      sec.innerHTML = '<div class="sr-kick">RTL</div>' +
        '<div class="kt-ed"><div class="kt-gut" aria-hidden="true"></div><textarea class="kt-src" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="RTL editor"></textarea></div>' +
        '<div class="sr-row kt-tools"><button type="button" class="primary" data-k="run"' + (model ? '' : ' disabled') + '>Run testbench</button>' +
        '<button type="button" data-k="giveup">Give up</button><button type="button" data-k="skel">Restore skeleton</button>' +
        '<span class="sr-hint">' + (model ? 'Compile errors do not count as runs.' : 'No testbench for this kata in this build.') + '</span></div>' +
        '<div class="kt-result" aria-live="polite"></div><ol class="kt-hist" hidden></ol>';
      var ta = sec.querySelector('.kt-src');
      ta.value = s.code;
      gutter(ta, null);
      grow(ta);
      ta.addEventListener('input', function () { onEdit(ta, false); });
      ta.addEventListener('keydown', function (e) { onKey(ta, e); });
      ta.addEventListener('blur', flush);
      sec.querySelector('[data-k="run"]').addEventListener('click', function () { doRun(ta); });
      SR.twoTap(sec.querySelector('[data-k="giveup"]'), 'Tap again to give up', doGiveUp);
      SR.twoTap(sec.querySelector('[data-k="skel"]'), 'Tap again to restore', function () {
        ta.value = String(k.skeleton || '');
        onEdit(ta, true);
      });
      updateTools(s);
      renderHist(s);
      if (s.lastSrc != null && model) {
        var res = V.run(model, s.lastSrc), last = s.runs.length ? s.runs[s.runs.length - 1] : null;
        showResult(res, s, last);
        if (res.error && res.line && ta.value === s.lastSrc) gutter(ta, res.line);
      }
    }
    function gutter(ta, errLine) {
      var g = ta.parentNode && ta.parentNode.querySelector('.kt-gut');
      if (!g) return;
      var n = ta.value.split('\n').length, out = [];
      for (var i = 1; i <= n; i++) out.push(i === errLine ? '<span class="el">' + i + '</span>' : String(i));
      g.innerHTML = out.join('\n');
    }
    /* The editor grows with its text (no scroll inside a scaled page); 14 rows at least. */
    function grow(ta) {
      var rows = Math.max(MIN_ROWS, ta.value.split('\n').length + 1);
      ta.style.height = (rows * LINE_H + 20 + 14) + 'px';
    }
    function onEdit(ta, now) {
      gutter(ta, null);
      grow(ta);
      clearTimeout(saveT);
      saveT = 0;
      var fn = function () { saveT = 0; var s = load(k); s.code = ta.value; save(k, s); };
      if (now) fn(); else saveT = setTimeout(fn, 400);
    }
    function insert(ta, text) {
      var done = false;
      try { done = !!(document.execCommand && document.execCommand('insertText', false, text)); } catch (e) { done = false; }
      if (!done) {
        var a = ta.selectionStart, b = ta.selectionEnd;
        ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
        ta.selectionStart = ta.selectionEnd = a + text.length;
        onEdit(ta, false);
      }
    }
    function onKey(ta, e) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insert(ta, '  '); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        var v = ta.value, st = ta.selectionStart, ls = v.lastIndexOf('\n', st - 1) + 1, ind = /^[ \t]*/.exec(v.slice(ls, st))[0];
        if (ind) { e.preventDefault(); insert(ta, '\n' + ind); }
      }
    }
    function updateTools(s) {
      var gb = q('.kt-code [data-k="giveup"]');
      if (gb) gb.disabled = !(s.committed && s.status === 'open');
    }
    function doRun(ta) {
      if (!model) return;
      flush();
      var src = ta.value, s = load(k);
      s.code = src;
      var res = V.run(model, src);
      var entry = { ok: !!res.ok, err: !!res.error, cyc: res.mism ? res.mism.cycle : null, sig: res.mism ? res.mism.sig : null,
        at: s.t0 ? Date.now() - s.t0 : 0, practice: s.status !== 'open' };
      s.runs.push(entry);
      s.lastSrc = src;
      var settleNow = false;
      if (res.ok && s.status === 'open') { s.status = 'passed'; s.t1 = Date.now(); settleNow = true; }
      else if (res.ok && s.status === 'gaveup') s.practicePass = true;
      save(k, s);
      if (settleNow) { settle(s, 'pass'); s = load(k); tt.t1 = s.t1; stopTimer(); }
      showResult(res, s, entry);
      gutter(ta, res.error && res.line ? res.line : null);
      renderHist(s);
      renderMeta(s);
      updateTools(s);
      if (settleNow) renderSettle(s);
      emit(k.id);
      relayout();
    }
    function settle(s, how) {
      var opt = { pass: how === 'pass', runs: counted(s), gaveUp: how === 'gaveup' };
      if (s.conf) opt.confidence = s.conf;
      if (s.t0 && s.t1) opt.ms = s.t1 - s.t0;
      if (typeof o.hidden === 'boolean') opt.hidden = o.hidden || !!k.hidden;
      if (typeof o.reach === 'boolean') opt.reach = o.reach;
      var res = eng('settleKata', k.id, opt);
      s.settle = res ? brief(res) : { local: true, pass: opt.pass, runs: opt.runs, gaveUp: opt.gaveUp, score: opt.pass ? (opt.runs <= 1 ? 1 : 0.75) : 0 };
      save(k, s);
    }
    function doGiveUp() {
      flush();
      var s = load(k);
      if (!s.committed || s.status !== 'open') return;
      s.status = 'gaveup';
      s.t1 = Date.now();
      save(k, s);
      settle(s, 'gaveup');
      s = load(k);
      tt.t1 = s.t1;
      stopTimer();
      renderMeta(s);
      updateTools(s);
      renderSettle(s);
      emit(k.id);
      relayout();
    }
    function showResult(res, s, entry) {
      var box = q('.kt-result');
      if (!box) return;
      var h;
      if (res.error) {
        h = '<div class="kt-res fail"><div class="kt-big">Compile error</div><pre>' + esc(res.error) + '</pre><div class="sr-hint">Not counted as a run.</div></div>';
      } else if (res.ok) {
        var n = Math.min(res.trace.length, PASS_WIN);
        h = '<div class="kt-res pass"><div class="kt-big">PASS</div><div>' + res.cycles + ' cycles; every output matched the reference model.' +
          (entry && entry.practice ? ' Practice run.' : '') + '</div><div class="kt-wave">' + waveSvg(model, widths, res.trace, 0, n, null) + '</div>' +
          '<div class="sr-hint">Cycles 0 to ' + (n - 1) + ' of ' + res.cycles + '.</div></div>';
      } else {
        var m = res.mism, w = widths[m.sig], a = Math.max(0, m.cycle - 14), b = Math.min(res.trace.length, m.cycle + 8);
        h = '<div class="kt-res fail"><div class="kt-big">FAIL</div><div>First mismatch at cycle ' + m.cycle + ', checked after the rising edge' +
          (m.note ? ' (' + esc(m.note) + ')' : '') + '.</div>' +
          '<table><tr><th>cycle</th><th>signal</th><th>expected</th><th>got</th></tr><tr><td>' + m.cycle + '</td><td>' + esc(m.sig) + '</td><td>' +
          fmtV(m.exp, w) + '</td><td>' + fmtV(m.got, w) + '</td></tr></table>' +
          '<div class="kt-wave">' + waveSvg(model, widths, res.trace, a, b, m) + '</div>' +
          (s.status === 'open' ? '<div class="sr-hint">A pass now scores 0.75.</div>' : '') + '</div>';
      }
      box.innerHTML = h;
    }
    function renderHist(s) {
      var ol = q('.kt-hist');
      if (!ol) return;
      ol.hidden = !s.runs.length;
      ol.innerHTML = s.runs.map(function (r) {
        var what = r.ok ? 'pass' : r.err ? 'compile error (not counted)' : 'fail at cycle ' + r.cyc + (r.sig ? ' (' + esc(r.sig) + ')' : '');
        return '<li>' + (r.practice ? 'practice: ' : '') + what + ' · ' + (SR.fmt ? SR.fmt.dur(r.at) : '') + '</li>';
      }).join('');
    }

    /* ----- 3. settled: the result, then the two tick steps ----- */
    function verdictText(s) {
      var st = s.settle, n = st.runs != null ? st.runs : counted(s);
      var t = st.pass ? 'Passed on run ' + n + '.' : 'Gave up' + (n ? ' after ' + n + ' run' + (n === 1 ? '' : 's') : '') + '.';
      if (!st.pass && s.practicePass) t += ' Passed later, in practice.';
      return t;
    }
    function scoreHtml(st) {
      if (st.local) return '<span class="sr-hint">Not rated: engine.js is not in this build.</span>';
      if (typeof st.rBefore !== 'number' || typeof st.rAfter !== 'number') return '';
      var d = st.rAfter - st.rBefore, cls = d > 0.0005 ? 'kt-up' : d < -0.0005 ? 'kt-down' : '';
      return 'score ' + esc(String(st.score)) + ' &middot; E ' + f2(st.E) + ' &middot; r ' + f2(st.rBefore) + ' &rarr; <b class="' + cls + '">' + f2(st.rAfter) +
        '</b> (' + (d >= 0 ? '+' : '') + f2(d) + ') in ' + esc(areaName(area()));
    }
    function toggles(list, sel, locked) {
      return '<div class="kt-toggles" data-list="' + list + '">' + designMethods(k).map(function (m) {
        var on = sel.indexOf(m.id) >= 0;
        return '<button type="button" data-m="' + esc(m.id) + '" aria-pressed="' + on + '"' + (on ? ' class="on"' : '') + (locked ? ' disabled' : '') + '>' + esc(m.label || m.id) + '</button>';
      }).join('') + '</div>';
    }
    function renderSettle(s) {
      var sec = q('.kt-settle');
      if (!sec) return;
      if (!s.settle) { sec.hidden = true; sec.innerHTML = ''; return; }
      sec.hidden = false;
      var st = s.settle;
      var h = '<div class="sr-kick">Settled</div><p class="kt-verdict"><b>' + esc(verdictText(s)) + '</b> ' + scoreHtml(st) + '</p>';
      if (s.tookDone) h += resultHtml(s);
      else if (!s.calledDone) {
        h += '<div class="kt-step"><div class="kt-steph">1. What your call named</div><p class="sr-hint">' + esc(TEXT.calledHint) + '</p>' +
          toggles('called', s.called, false) +
          '<div class="sr-row"><button type="button" class="primary" data-k="calldone">These are what my call named</button></div></div>';
      } else {
        h += '<div class="kt-step"><div class="kt-steph">1. What your call named</div><p>' +
          (s.called.length ? esc(labels(s.called)) + '.' : 'None of the listed methods.') + '</p></div>' +
          '<div class="kt-step"><div class="kt-steph">2. What the kata took</div><p class="sr-hint">' + esc(TEXT.tookHint) + '</p>' +
          toggles('took', s.took, false) +
          '<div class="sr-row"><button type="button" class="primary" data-k="tookdone">Save</button><span class="sr-hint kt-tookn"></span></div></div>';
      }
      h += '<p class="sr-hint">' + esc(TEXT.practice) + '</p>';
      sec.innerHTML = h;
      wireSettle(sec);
    }
    function wireSettle(sec) {
      [].forEach.call(sec.querySelectorAll('.kt-toggles button[data-m]'), function (b) {
        b.addEventListener('click', function () {
          var list = b.parentNode.getAttribute('data-list'), id = b.getAttribute('data-m'), s = load(k);
          if (list === 'called' ? s.calledDone : s.tookDone) return;
          var arr = list === 'called' ? s.called : s.took, i = arr.indexOf(id);
          if (i >= 0) arr.splice(i, 1); else arr.push(id);
          save(k, s);
          var on = arr.indexOf(id) >= 0;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
          tookState(sec, s);
        });
      });
      var cd = sec.querySelector('[data-k="calldone"]');
      if (cd) cd.addEventListener('click', function () {
        var s = load(k);
        if (s.calledDone) return;
        s.calledDone = true;
        if (!s.tookInit) { s.tookInit = true; s.took = uniq(k.methods || []); }
        save(k, s);
        renderSettle(s);
        relayout();
      });
      var td = sec.querySelector('[data-k="tookdone"]');
      if (td) td.addEventListener('click', function () { finishTicks(); });
      tookState(sec, load(k));
    }
    function tookState(sec, s) {
      var td = sec.querySelector('[data-k="tookdone"]'), n = sec.querySelector('.kt-tookn');
      if (!td) return;
      td.disabled = !s.took.length;
      if (n) n.textContent = s.took.length ? '' : 'Tick at least one.';
    }
    function finishTicks() {
      var s = load(k);
      if (!s.calledDone || s.tookDone || !s.took.length) return;
      var called = s.called.slice(), took = s.took.slice();
      var res = eng('settleKata', k.id, { called: called, took: took });
      s.tookDone = true;
      s.tick = res ? { hit: res.methodHit, extra: res.extra || [], gap: res.recognitionGap || null, links: res.linksBack || [] }
        : { hit: took.every(function (m) { return called.indexOf(m) >= 0; }), extra: called.filter(function (m) { return took.indexOf(m) < 0; }), gap: null, links: (k.basics || []).slice(), local: true };
      save(k, s);
      renderSettle(s);
      emit(k.id);
      relayout();
    }
    function resultHtml(s) {
      var r = s.tick || {}, took = s.took || [], called = s.called || [], h = '<div class="kt-step">';
      if (r.hit === true) h += '<p><b class="kt-hit">Method: hit.</b> Your call named every method it took (' + esc(labels(took)) + ').</p>';
      else if (r.hit === false) {
        var miss = took.filter(function (m) { return called.indexOf(m) < 0; });
        h += '<p><b class="kt-miss">Method: missed.</b> It took ' + esc(labels(miss)) + ', which your call did not name.' +
          (called.length ? ' Your call named ' + esc(labels(called)) + '.' : '') + '</p>';
      } else h += '<p class="sr-hint">Method check not counted.</p>';
      if (r.extra && r.extra.length) h += '<p class="sr-hint">Also named, not needed: ' + esc(labels(r.extra)) + '.</p>';
      if (r.gap) h += gapHtml(r.gap);
      h += accuracyHtml();
      h += '<p class="sr-hint">Tagged in the content: ' + esc(labels(k.methods || [])) + '.</p>';
      return h + linksHtml(s, r) + '</div>';
    }
    function gapHtml(g) {
      var links = (g.methods || []).map(function (x) {
        var e = methodEntry(x.method), cue = e && e.cue && docOf(String(e.cue).split('#')[0]) ? String(e.cue) : null;
        var to = cue || (x.doc || g.doc);
        return to ? '<a class="ref" data-to="' + esc(to) + '">' + (cue ? 'The cue for ' : 'Recognise list: ') + esc(x.label || methodLabel(x.method)) + '</a>' : '';
      }).join('');
      return '<div class="kt-gap">' + esc(g.note || 'Recognition gap.') + (links ? '<div class="kt-links">' + links + '</div>' : '') + '</div>';
    }
    function accuracyHtml() {
      var all = eng('methodAccuracy') || {}, ar = eng('methodAccuracy', area()) || {}, hid = eng('methodAccuracy', null, { hidden: true }) || {};
      var sr = eng('solveRate', area()) || {}, bits = [];
      if (all.total) bits.push('Method named right: ' + all.hits + ' of ' + all.total + ' overall');
      if (ar.total && ar.total !== all.total) bits.push(ar.hits + ' of ' + ar.total + ' in ' + areaName(area()));
      if (hid.total) bits.push(hid.hits + ' of ' + hid.total + ' with the topic hidden');
      if (sr.total) bits.push('solved (tracked separately): ' + sr.held + ' of ' + sr.total + ' in ' + areaName(area()));
      return bits.length ? '<p class="sr-hint">' + esc(bits.join(' · ')) + '.</p>' : '';
    }
    function stagePill(b) {
      var st = eng('stage', b);
      return typeof st === 'number' ? '<span class="sr-stage s' + st + '">stage ' + st + '</span>' : '';
    }
    function linksHtml(s, r) {
      var ids = uniq((r.links && r.links.length ? r.links : k.basics) || []).filter(function (b) { return !!docOf(b); });
      var bad = !(s.settle && s.settle.pass) || r.hit === false;
      var head = '<div class="sr-kick">' + (bad ? 'Back to the basics it used' : 'The basics it used') + '</div>';
      if (!ids.length) return '';
      return '<div class="kt-back">' + head + '<div class="kt-links">' + ids.map(function (b) {
        return '<span><a class="ref" data-to="' + esc(b) + '">' + esc(docTitle(b)) + '</a>' + stagePill(b) + '</span>';
      }).join('') + '</div><p class="sr-hint">Tap to open one; hold to peek.</p></div>';
    }

    /* ----- lifecycle ----- */
    function destroy() {
      if (self.dead) return;
      flush();
      self.dead = true;
      destroyPad();
      stopTimer();
      offs.forEach(function (f) { try { f(); } catch (e) {} });
      offs = [];
      var i = views.indexOf(self);
      if (i >= 0) views.splice(i, 1);
    }
    if (!self.sheet) {
      var rsT = 0, onResize = function () { clearTimeout(rsT); rsT = setTimeout(markSmall, 200); };
      window.addEventListener('resize', onResize);
      offs.push(function () { clearTimeout(rsT); window.removeEventListener('resize', onResize); });
      if (SR.bus) offs.push(SR.bus.on('reader:doc', function () { if (!self.dead) markSmall(); }));
    }
    if (SR.bus) {
      offs.push(SR.bus.on('engine:change', function (d) {
        if (self.dead) return;
        var t = d && d.type;
        if (t === 'reset') return;                       /* the reader remounts every block after a reset */
        if (self.gateWas !== null && gated(load(k)) !== self.gateWas) { render(); return; }
        if (t === 'settle' || t === 'demo' || t === 'clock' || t === 'drill' || t === 'fog' || t === 'stage') renderMeta(load(k));
      }));
    }
    self.render = render;
    self.destroy = destroy;
    self.flush = flush;
    self.el = el;
    views.push(self);
    return self;
  }

  /* ---------- SR.kata.open: a kata in a sheet (Today, or "Open in a panel" from a doc) ---------- */
  function boolOf(a, b) { return typeof a === 'boolean' ? a : typeof b === 'boolean' ? b : undefined; }
  function open(x, o) {
    o = o || {};
    var k = x, entry = {};
    if (x && typeof x === 'object' && x.kata && typeof x.kata === 'object') { entry = x; k = x.kata; }
    if (typeof k === 'string') k = kataById(k);
    else if (k && typeof k === 'object' && k.id && !k.spec) k = kataById(k.id) || k;
    if (!k || !k.id) { if (SR.toast) SR.toast('That kata is not in the content.'); return null; }
    if (!SR.sheet || typeof SR.sheet.open !== 'function') return null;
    var opts = { sheet: true, hidden: boolOf(o.hidden, entry.hidden), reach: boolOf(o.reach, entry.reach), why: o.why || entry.why || null };
    var sh = SR.sheet.open({ id: 'kata-' + k.id, title: 'Design kata · ' + (k.title || k.id), wide: true });
    if (sh.__kt && !sh.__kt.dead) {
      if (typeof opts.hidden === 'boolean') sh.__kt.o.hidden = opts.hidden;
      if (typeof opts.reach === 'boolean') sh.__kt.o.reach = opts.reach;
      if (opts.why) sh.__kt.o.why = opts.why;
      sh.__kt.render();
      return sh;
    }
    sh.body.innerHTML = '';
    var host = document.createElement('div');
    sh.body.appendChild(host);
    var v = createView(host, k, opts);
    sh.__kt = v;
    var prev = sh.onClose;
    sh.onClose = function () {
      v.destroy();
      refreshInline(k.id);
      if (typeof prev === 'function') prev();
    };
    v.render();
    refreshInline(k.id);
    return sh;
  }

  K.open = open;
  K.state = function (id) { var k = kataById(id); return k ? load(k) : null; };
  K.views = function () { return views.slice(); };
  if (SR.blocks && typeof SR.blocks.register === 'function') {
    SR.blocks.register('kata', {
      mount: function (el, id, ctx) {
        var k = kataById(id);
        if (!k) { el.innerHTML = '<div class="blk-ph">Design kata ' + esc(id) + ' is not in the content.</div>'; return {}; }
        var v = createView(el, k, { ctx: ctx || null });
        v.render();
        return { destroy: v.destroy, view: v };
      }
    });
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

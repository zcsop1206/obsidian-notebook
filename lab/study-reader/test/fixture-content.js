/* test/fixture-content.js: a two-doc stand-in for src/content.js, used by `node build.mjs --fixture`.
   Same shape as SR.content (see INTERFACES.md). nt-moves is a topic doc that links into nt-units, a
   basic with a rebuilt build 2: build 2 adds #notation, rewrites #euler-check and drops #phi-remark,
   so ink can be seen following, dimming and orphaning. Written by a model for Adit. */
(function () {
  'use strict';
  var SR = window.SR = window.SR || {};
  var unitsCommon1 =
    '<h2 data-a="units-def">What a unit is</h2>' +
    '<p data-a="units-p">Work with residues mod $n$: add and multiply as integers, then reduce. A residue $a$ is a <b>unit</b> if some $b$ has $ab\\equiv 1 \\pmod n$; such a $b$ is an inverse of $a$. Write $\\varphi(n)$ for the number of $a$ in $\\{1,\\dots,n\\}$ with $\\gcd(a,n)=1$.</p>' +
    '<div class="thm" data-a="unit-gcd"><span class="lbl">Theorem 1.</span> $a$ is a unit mod $n$ if and only if $\\gcd(a,n)=1$. So there are exactly $\\varphi(n)$ units mod $n$.' +
    '<div class="blk" data-block="fog" data-id="fx-unit-gcd"></div></div>';
  var units2 =
    '<p class="new" data-a="notation"><b>Notation.</b> For a unit $a$ write $a^{-1}$ for its inverse. It is unique: if $ab\\equiv ac\\equiv 1$ then $b\\equiv b(ac)=(ba)c\\equiv c$.</p>' +
    unitsCommon1 +
    '<h2 data-a="euler-sec">Euler\'s theorem</h2>' +
    '<div class="thm" data-a="euler"><span class="lbl">Theorem 2 (Euler).</span> If $\\gcd(a,n)=1$ then $a^{\\varphi(n)}\\equiv 1 \\pmod n$.' +
    '<div class="blk" data-block="fog" data-id="fx-euler"></div></div>' +
    '<p data-a="euler-check"><b>Check.</b> $\\varphi(10)=4$ and $3^4=81=8\\cdot 10+1$, so $3^4\\equiv 1 \\pmod{10}$.</p>';
  var units1 =
    unitsCommon1 +
    '<p class="rem" data-a="phi-remark"><b>Remark.</b> For a prime power, $\\varphi(p^k)=p^k-p^{k-1}$: among $1,\\dots,p^k$ the numbers sharing a factor with $p^k$ are exactly the multiples of $p$, and there are $p^{k-1}$ of them.</p>' +
    '<h2 data-a="euler-sec">Euler\'s theorem</h2>' +
    '<div class="thm" data-a="euler"><span class="lbl">Theorem 2 (Euler).</span> If $\\gcd(a,n)=1$ then $a^{\\varphi(n)}\\equiv 1 \\pmod n$.' +
    '<div class="blk" data-block="fog" data-id="fx-euler"></div></div>' +
    '<p data-a="euler-check"><b>Check.</b> $\\varphi(9)=6$ and $2^6=64=7\\cdot 9+1$, so $2^6\\equiv 1 \\pmod 9$.</p>';
  var moves1 =
    '<h2 data-a="recognise">Recognise</h2>' +
    '<p data-a="recognise-p">Reach for residues when a question asks for a remainder, a last digit, or whether a huge power is divisible by something. The size is the signal: you never compute $a^k$ for large $k$, only what it is mod $n$.</p>' +
    '<h2 data-a="moves">First moves</h2>' +
    '<p data-a="moves-1"><b>Reduce the base.</b> Replace $a$ by its remainder mod $n$; $a^k \\bmod n$ does not change.</p>' +
    '<p data-a="moves-2"><b>Check for a unit.</b> If $\\gcd(a,n)=1$ then $a$ is <a class="ref" data-to="nt-units#unit-gcd">invertible mod $n$</a>, and by <a class="ref" data-to="nt-units#euler">Euler\'s theorem</a> the exponent only matters mod $\\varphi(n)$.</p>' +
    '<p data-a="moves-3"><b>Split the modulus</b> into coprime prime-power factors when the base shares a prime with it, and work in each factor; for a prime power, $\\varphi$ is easy (<a class="ref" data-to="nt-units#phi-remark">the remark</a>).</p>' +
    '<h2 data-a="traps">Traps</h2>' +
    '<p data-a="trap-1"><b>Euler needs a unit.</b> $\\varphi(12)=4$, yet $2^4=16\\equiv 4 \\pmod{12}$, not $1$.</p>' +
    '<h2 data-a="example">Worked example</h2>' +
    '<p data-a="example-q">Find $3^{100} \\bmod 7$ before you open the steps.</p>' +
    '<div class="blk" data-block="fog" data-id="fx-example"></div>';

  SR.content = {
    docs: {
      'nt-moves': { id: 'nt-moves', title: 'Number theory: first moves', kind: 'topic', area: 'nt', track: 'putnam', needs: ['nt-units'], versions: { 1: moves1 } },
      'nt-units': { id: 'nt-units', title: 'Units mod n', kind: 'basic', area: 'nt', track: 'putnam', needs: [], versions: { 1: units1, 2: units2 },
        rebuiltFrom: 'A notation paragraph for inverses comes first; the check uses a new modulus; the prime-power remark moves out.' }
    },
    fog: {
      'fx-unit-gcd': { doc: 'nt-units', basic: 'nt-units', anchor: 'unit-gcd', statement: '$a$ is a unit mod $n$ if and only if $\\gcd(a,n)=1$.',
        steps: [
          { topic: 'a unit forces gcd 1', html: 'If $ab\\equiv 1$ then $ab-1=qn$ for some integer $q$, so a common divisor of $a$ and $n$ divides $ab-qn=1$.' },
          { topic: 'Bezout', html: 'If $\\gcd(a,n)=1$, B&eacute;zout gives integers $s,t$ with $sa+tn=1$. Read mod $n$, this says $sa\\equiv 1$, so $s$ is an inverse of $a$.' }
        ] },
      'fx-euler': { doc: 'nt-units', basic: 'nt-units', anchor: 'euler', statement: 'If $\\gcd(a,n)=1$ then $a^{\\varphi(n)}\\equiv 1 \\pmod n$.',
        steps: [
          { topic: 'multiplying permutes the units', html: 'List the units $u_1,\\dots,u_m$ with $m=\\varphi(n)$. The residues $au_1,\\dots,au_m$ are units and pairwise distinct, since $au_i\\equiv au_j$ gives $u_i\\equiv u_j$ after multiplying by an inverse of $a$. So they are the same list in another order.' },
          { topic: 'cancel the product', html: 'Multiply each list out: $a^m u_1\\cdots u_m\\equiv u_1\\cdots u_m$. A product of units is a unit, so it cancels, and $a^m\\equiv 1$.' }
        ] },
      'fx-example': { doc: 'nt-moves', basic: 'nt-units', anchor: 'example', statement: 'Find $3^{100} \\bmod 7$.',
        steps: [
          { topic: 'Euler', html: '$\\gcd(3,7)=1$ and $\\varphi(7)=6$, so $3^6\\equiv 1 \\pmod 7$.' },
          { topic: 'reduce the exponent', html: '$100=16\\cdot 6+4$, so $3^{100}=(3^6)^{16}\\cdot 3^4\\equiv 3^4=81=11\\cdot 7+4\\equiv 4 \\pmod 7$.' }
        ] }
    },
    problems: [],
    katas: [],
    methods: { math: [], design: [] },
    pmTasks: [],
    tests: [{ id: 'putnam', date: '2026-12-05', track: 'putnam' }, { id: 'asic', date: '2027-01-18', track: 'asic' }],
    rewrites: {
      'nt-moves': {
        'moves-2': '<p data-a="moves-2"><b>Check for a unit.</b> Compute $\\gcd(a,n)$ first. When it is $1$, $a$ has an inverse mod $n$ (<a class="ref" data-to="nt-units#unit-gcd">Theorem 1</a>), and <a class="ref" data-to="nt-units#euler">Euler\'s theorem</a> gives $a^{\\varphi(n)}\\equiv 1$. Writing $k=q\\varphi(n)+r$ with $0\\le r\\lt\\varphi(n)$, $a^k=(a^{\\varphi(n)})^q a^r\\equiv a^r$, so only $r$ matters.</p>'
      }
    }
  };
})();

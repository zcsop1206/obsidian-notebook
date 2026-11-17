/* content.js: the study reader's docs, fog blocks (proofs), problems, katas, method lists,
   sample pm tasks and test dates, as SR.content. Written by a model for Adit. Not Adit's words.
   Problems from competitions appear only by source, number and link; every statement and
   solution here is invented, and every invented answer was checked numerically.
   Doc HTML: byline + h1 data-a="top" at the head (the reader adds .meta), anchors on every
   markable passage, theorem statements in .thm with the proof as a fog block right after.
   Rewrites are whole elements carrying the same data-a as the passage they replace. */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  var SR = root.SR = root.SR || {};
  var R = String.raw;
  var MODEL = "Written by a model for Adit. Not Adit's words.";
  function head(title) { return '<div class="byline">' + MODEL + '</div><h1 data-a="top">' + title + '</h1>'; }
  function fogBlk(id) { return '<div class="blk" data-block="fog" data-id="' + id + '"></div>'; }
  function kataBlk(id) { return '<div class="blk" data-block="kata" data-id="' + id + '"></div>'; }

  /* =====================================================================================
     DOCS
     ===================================================================================== */

  /* ---------- topic: Number theory: first moves ---------- */
  var ntMoves = head('Number theory: first moves') + R`
<h2 data-a="recognise">Recognise</h2>
<p data-a="rec-intro">Cues in a statement, and where each one points. When a settled problem shows a cue you knew but did not call, it is added to this list.</p>
<ul>
<li data-a="cue-exponent"><b>A huge exponent, a fixed modulus.</b> Only the exponent's class modulo the <a class="ref" data-to="nt-units#order-thm">order</a> matters, and the order divides $\varphi(n)$ (<a class="ref" data-to="nt-units#euler-thm">Euler</a>).</li>
<li data-a="cue-split"><b>A composite modulus.</b> Split it into coprime prime powers, solve each piece, glue (<a class="ref" data-to="nt-crt#crt">CRT</a>).</li>
<li data-a="cue-two-periods"><b>Two conditions that repeat with different periods.</b> Each fixes $n$ modulo its own period; together they fix $n$ modulo the lcm (<a class="ref" data-to="nt-crt#crt-many-thm">several moduli</a>).</li>
<li data-a="cue-count-roots"><b>"How many $x$ with $f(x) \equiv 0 \pmod n$?"</b> Count per prime power and multiply (<a class="ref" data-to="nt-crt#crt-count">counting by splitting</a>).</li>
<li data-a="cue-gcd"><b>A gcd of two expressions in $n$.</b> Run <a class="ref" data-to="nt-divisibility#euclid">Euclid's algorithm</a> on the expressions until a constant is left.</li>
<li data-a="cue-linear"><b>$ax + by = c$ in integers.</b> Solvable exactly when $\gcd(a, b) \mid c$ (<a class="ref" data-to="nt-divisibility#bezout">Bézout</a>).</li>
<li data-a="cue-prime-factor"><b>"Which primes divide $a^k - 1$?"</b> A prime $p \nmid a$ divides it exactly when $\operatorname{ord}_p(a) \mid k$, and $\operatorname{ord}_p(a) \mid p - 1$ (<a class="ref" data-to="nt-units#order-thm">order</a>, <a class="ref" data-to="nt-units#euler-thm">Fermat</a>).</li>
</ul>

<h2 data-a="moves">First moves</h2>
<ol>
<li data-a="move-small"><b>Small cases first.</b> Compute the first few values, and tabulate the expression mod a few small primes. Periods show up fast.</li>
<li data-a="move-factor"><b>Factor what you can.</b> The modulus, the expression, and differences of powers: $a^{2k} - 1 = (a^k - 1)(a^k + 1)$.</li>
<li data-a="move-unit"><b>Is the base a unit?</b> If it shares a prime with the modulus, split the modulus so that prime sits in a factor of its own, and handle that factor by hand.</li>
<li data-a="move-reduce"><b>Reduce.</b> The base mod $n$; the exponent mod the order, or mod $\varphi(n)$ when the order is unknown.</li>
<li data-a="move-glue"><b>Glue last.</b> Keep the pieces apart until each one is solved, then combine them with the <a class="ref" data-to="nt-crt#crt">CRT</a>.</li>
</ol>

<h2 data-a="traps">Traps</h2>
<ul>
<li data-a="trap-euler"><b>Euler needs a unit.</b> $\varphi(10) = 4$, but $2^4 = 16 \equiv 6 \pmod{10}$.</li>
<li data-a="trap-exp"><b>Reduce exponents mod $\varphi(n)$ or the order, never mod $n$.</b> $3^8 \equiv 3^2 \equiv 2 \pmod 7$, since $\varphi(7) = 6$; reducing $8$ mod $7$ instead gives $3^1 = 3$, which is wrong.</li>
<li data-a="trap-cancel"><b>Cancelling needs coprimality.</b> $4 \cdot 2 \equiv 4 \cdot 5 \pmod{12}$, yet $2 \not\equiv 5$. Cancel $c$ only when $\gcd(c, n) = 1$ (<a class="ref" data-to="nt-divisibility#cong-cancel">why</a>).</li>
<li data-a="trap-crt"><b>The CRT needs coprime moduli.</b> Check the gcd before gluing: with a shared factor the two conditions can contradict each other (<a class="ref" data-to="nt-crt#crt-coprime">example</a>).</li>
<li data-a="trap-order"><b>The order divides $\varphi(n)$; it need not equal it.</b> $\operatorname{ord}_7(2) = 3$, while $\varphi(7) = 6$.</li>
<li data-a="trap-tower"><b>Towers.</b> $a^{b^c}$ means $a^{(b^c)}$. The exponent $b^c$ is reduced mod the order of $a$, and computing $b^c$ mod that order may need the same moves one level down.</li>
</ul>

<h2 data-a="worked">Worked example</h2>
<p data-a="worked-q">Find the last three digits of $2^{2026}$. Work it on paper before you lift the fog.</p>
` + fogBlk('f-moves-worked') + R`

<h2 data-a="try">Try one cold</h2>
<p data-a="try-intro">A problem that rests on this page. At the top push level it opens before the page does.</p>
<div class="blk" data-block="problem" data-id="inv-2" data-hook="1"></div>
`;

  /* ---------- basic: Divisibility and Bézout ---------- */
  var ntDiv = head('Divisibility and Bézout') + R`
<p class="note" data-a="uses">Needs nothing. The other number theory pages stand on this one.</p>

<h2 data-a="divides">Divisibility</h2>
<p class="def" data-a="div-def"><b>Definition.</b> For integers $a$ and $b$, $a$ <b>divides</b> $b$, written $a \mid b$, when $b = ak$ for some integer $k$. Every integer divides $0$, and $0$ divides only $0$.</p>
<p data-a="div-comb">If $d \mid a$ and $d \mid b$, then $d \mid ax + by$ for all integers $x, y$: with $a = da'$ and $b = db'$, $ax + by = d(a'x + b'y)$. Most arguments on this page are this line, used once.</p>
<div class="thm" data-a="div-alg"><span class="lbl">Theorem 1 (division with remainder).</span> For integers $a$ and $b$ with $b \gt 0$ there are unique integers $q$ and $r$ with $a = qb + r$ and $0 \le r \lt b$.</div>
` + fogBlk('f-div-alg') + R`
<p data-a="rem-def">This $r$ is the <b>remainder</b> of $a$ mod $b$, written $a \bmod b$. It is never negative: $-17 = (-4) \cdot 5 + 3$, so $-17 \bmod 5 = 3$.</p>

<h2 data-a="gcd">Greatest common divisor</h2>
<p class="def" data-a="gcd-def"><b>Definition.</b> For $a, b$ not both $0$, $\gcd(a, b)$ is the largest integer dividing both. Signs do not matter, and $\gcd(a, 0) = |a|$. Two integers are <b>coprime</b> when their gcd is $1$.</p>
<div class="thm" data-a="euclid"><span class="lbl">Theorem 2 (Euclid's algorithm).</span> For every integer $q$, $\gcd(a, b) = \gcd(b, a - qb)$. Starting from $a, b \ge 0$ with $b \gt 0$ and repeatedly replacing $(a, b)$ by $(b, a \bmod b)$ reaches a pair $(g, 0)$ after finitely many steps, and $g = \gcd(a, b)$.</div>
` + fogBlk('f-euclid') + R`
<div class="ex" data-a="ex-euclid"><span class="lbl">Example.</span> $1001 = 4 \cdot 221 + 117$, $221 = 1 \cdot 117 + 104$, $117 = 1 \cdot 104 + 13$, $104 = 8 \cdot 13$. So $\gcd(1001, 221) = 13$. Reading the lines from the bottom up writes $13$ as a combination of the two numbers: $13 = 117 - 104 = 2 \cdot 117 - 221 = 2 \cdot 1001 - 9 \cdot 221$.</div>
<div class="thm" data-a="bezout"><span class="lbl">Theorem 3 (Bézout).</span> If $a, b$ are not both $0$, then $\gcd(a, b)$ is the least positive integer of the form $ax + by$ with $x, y$ integers. Consequently $ax + by = c$ has an integer solution if and only if $\gcd(a, b) \mid c$.</div>
` + fogBlk('f-bezout') + R`

<h2 data-a="primes">Primes and factorisation</h2>
<p class="def" data-a="prime-def"><b>Definition.</b> An integer $p \gt 1$ is <b>prime</b> if its only positive divisors are $1$ and $p$.</p>
<div class="thm" data-a="euclid-lemma"><span class="lbl">Theorem 4 (Euclid's lemma).</span> If $n \mid ab$ and $\gcd(n, a) = 1$, then $n \mid b$. In particular, a prime that divides a product divides one of the factors.</div>
` + fogBlk('f-euclid-lemma') + R`
<div class="thm" data-a="fta"><span class="lbl">Theorem 5 (unique factorisation).</span> Every integer $n \gt 1$ is a product of primes, and any two such products for the same $n$ contain the same primes with the same multiplicities.</div>
` + fogBlk('f-fta') + R`

<h2 data-a="congruence">Congruences</h2>
<p class="def" data-a="cong-def"><b>Definition.</b> For $n \ge 1$, $a \equiv b \pmod n$ means $n \mid a - b$. By Theorem 1 every integer is congruent to exactly one of $0, 1, \dots, n - 1$, its remainder; these are the <b>residues</b> mod $n$. Congruence mod $n$ is reflexive, symmetric and transitive, so it sorts the integers into $n$ classes.</p>
<div class="thm" data-a="cong-arith"><span class="lbl">Theorem 6 (congruences add and multiply).</span> If $a \equiv a'$ and $b \equiv b' \pmod n$, then $a + b \equiv a' + b'$ and $ab \equiv a'b' \pmod n$. So inside any expression built from $+$, $-$, $\times$ and powers, a base, term or factor may be replaced by anything congruent to it mod $n$. An exponent may not: $3 \equiv 0 \pmod 3$, yet $2^3 = 8 \equiv 2$ while $2^0 = 1$. Exponents are reduced through the order of the base instead, on the Units mod n page.</div>
` + fogBlk('f-cong-arith') + R`
<div class="rem" data-a="cong-cancel"><span class="lbl">Cancelling.</span> Dividing both sides is not automatic: $2 \cdot 3 \equiv 2 \cdot 0 \pmod 6$, yet $3 \not\equiv 0$. If $\gcd(c, n) = 1$, then $ac \equiv bc$ does give $a \equiv b \pmod n$, because $n \mid (a - b)c$ and <a class="ref" data-to="nt-divisibility#euclid-lemma">Euclid's lemma</a> applies.</div>
<div class="ex" data-a="ex-cong"><span class="lbl">Example.</span> $10 \equiv 1 \pmod 9$, so every power of $10$ is $\equiv 1$, and a number $\sum d_i 10^i$ is congruent mod $9$ to its digit sum $\sum d_i$. For instance $2026 \equiv 2 + 0 + 2 + 6 = 10 \equiv 1 \pmod 9$.</div>
`;

  /* ---------- basic: Units mod n, build 1 ---------- */
  var unitsPhi = R`<p data-a="phi">Computing $\varphi$: among $1, \dots, p^k$ exactly the multiples of $p$ share a factor with $p^k$, so $\varphi(p^k) = p^k - p^{k-1}$; for example $\varphi(9) = 6$ and $\varphi(8) = 4$. For coprime $m, n$, $\varphi(mn) = \varphi(m)\varphi(n)$, proved on the <a class="ref" data-to="nt-crt#crt-units">CRT page</a>.</p>`;
  var unitsGcdThm = R`<div class="thm" data-a="unit-gcd"><span class="lbl">Theorem 1.</span> $a$ is a unit mod $n$ if and only if $\gcd(a, n) = 1$. The inverse is unique mod $n$, and products and inverses of units are units.</div>`;
  var orderThm = R`<div class="thm" data-a="order-thm"><span class="lbl">Theorem 2 (order).</span> Let $a$ be a unit mod $n$. Some power $a^k$ with $k \ge 1$ is $\equiv 1$, and the least such $k$ is the <b>order</b> $\operatorname{ord}_n(a)$. For $m \ge 0$, $a^m \equiv 1$ if and only if $\operatorname{ord}_n(a) \mid m$. Hence $a^m \equiv a^{m'}$ exactly when $m \equiv m' \pmod{\operatorname{ord}_n(a)}$.</div>`;
  var exOrder = R`<div class="ex" data-a="ex-order"><span class="lbl">Example.</span> Mod $7$ the powers of $3$ run $3, 2, 6, 4, 5, 1$, so $\operatorname{ord}_7(3) = 6$; the powers of $2$ run $2, 4, 1$, so $\operatorname{ord}_7(2) = 3$. Hence $2^{100} \equiv 2^1 = 2 \pmod 7$, because $100 \equiv 1 \pmod 3$.</div>`;
  var eulerThm = R`<div class="thm" data-a="euler-thm"><span class="lbl">Theorem 3 (Euler).</span> If $\gcd(a, n) = 1$, then $\operatorname{ord}_n(a) \mid \varphi(n)$, so $a^{\varphi(n)} \equiv 1 \pmod n$. For a prime $p$ with $p \nmid a$ this is Fermat's little theorem: $a^{p-1} \equiv 1 \pmod p$.</div>`;

  var units1 = head('Units mod n') + R`
<p class="note" data-a="uses">Uses <a class="ref" data-to="nt-divisibility#bezout">Bézout</a> and <a class="ref" data-to="nt-divisibility#cong-arith">congruence arithmetic</a>.</p>

<h2 data-a="units">Units</h2>
<p class="def" data-a="unit-def"><b>Definition.</b> Fix $n \ge 2$. An integer $a$ is a <b>unit</b> mod $n$ if $ax \equiv 1 \pmod n$ for some integer $x$, an <b>inverse</b> of $a$, written $a^{-1}$. Being a unit depends only on $a \bmod n$. $U(n)$ is the set of residues mod $n$ that are units, and $\varphi(n)$ is its size.</p>
` + unitsGcdThm + fogBlk('f-unit-gcd') + R`
<div class="ex" data-a="ex-units"><span class="lbl">Example.</span> $U(12) = \{1, 5, 7, 11\}$, so $\varphi(12) = 4$; each is its own inverse, since $25$, $49$ and $121$ are all $\equiv 1 \pmod{12}$. For a prime $p$ every residue $1, \dots, p - 1$ is coprime to $p$, so $\varphi(p) = p - 1$.</div>

<h2 data-a="order">Order</h2>
` + orderThm + fogBlk('f-order') + exOrder + R`

<h2 data-a="euler">Euler's theorem</h2>
` + eulerThm + fogBlk('f-euler') + unitsPhi;

  /* ---------- basic: Units mod n, build 2 (rebuilt from prerequisites) ---------- */
  var units2 = head('Units mod n') + R`
<p class="note" data-a="uses">Uses the three facts in the first section and nothing else; every other term is defined on this page.</p>

<h2 data-a="v2-stands">What this page stands on</h2>
<p data-a="v2-stands-p">Three facts from <a class="ref" data-to="nt-divisibility#top">Divisibility and Bézout</a>, used below by name. Open each one that is not solid yet; their proofs live there.</p>
<ul>
<li data-a="v2-use-div"><b>Division with remainder.</b> For $b \gt 0$, every integer $a$ is $qb + r$ with $0 \le r \lt b$, in exactly one way (<a class="ref" data-to="nt-divisibility#div-alg">Theorem 1</a>).</li>
<li data-a="v2-use-bezout"><b>Bézout.</b> If $\gcd(a, b) = 1$, then $ax + by = 1$ for some integers $x, y$ (<a class="ref" data-to="nt-divisibility#bezout">Theorem 3</a>).</li>
<li data-a="v2-use-cong"><b>Congruences add and multiply.</b> If $a \equiv a'$ and $b \equiv b' \pmod n$, then $a + b \equiv a' + b'$ and $ab \equiv a'b'$ (<a class="ref" data-to="nt-divisibility#cong-arith">Theorem 6</a>).</li>
</ul>

<h2 data-a="v2-residues">Arithmetic mod n</h2>
<p class="def" data-a="v2-res-def"><b>Residues.</b> Fix $n \ge 2$. $a \equiv b \pmod n$ means $n \mid a - b$. Every integer is congruent to exactly one <b>residue</b> $0, 1, \dots, n - 1$, its remainder. To add or multiply residues, add or multiply them as integers and take the remainder; the third fact above says the answer does not depend on which integers stood for the residues.</p>
<div class="ex" data-a="v2-ex-mod6"><span class="lbl">Example.</span> Mod $6$: $4 + 5 = 9 \equiv 3$ and $4 \cdot 5 = 20 \equiv 2$. Multiplying the residues $0, 1, 2, 3, 4, 5$ by $2$ gives $0, 2, 4, 0, 2, 4$: only even residues appear, so $2x \equiv 1$ has no solution. Multiplying them by $5$ gives $0, 5, 4, 3, 2, 1$: every residue appears once, and $5 \cdot 5 \equiv 1$.</div>
<p data-a="v2-division">So dividing mod $n$ works for some numbers and fails for others. The ones it works for are the units.</p>

<h2 data-a="units">Units</h2>
<p class="def" data-a="unit-def"><b>Definition.</b> An integer $a$ is a <b>unit</b> mod $n$ if $ax \equiv 1 \pmod n$ for some integer $x$. Such an $x$ is an <b>inverse</b> of $a$; once Theorem 1 shows it is unique mod $n$, it is written $a^{-1}$. Whether $a$ is a unit depends only on its residue. $U(n)$ is the set of residues that are units, and $\varphi(n)$ is the number of them.</p>
` + unitsGcdThm + fogBlk('f-unit-gcd-v2') + R`
<div class="ex" data-a="ex-units"><span class="lbl">Example.</span> $U(12) = \{1, 5, 7, 11\}$, the residues coprime to $12$, so $\varphi(12) = 4$; each is its own inverse, since $25$, $49$ and $121$ are all $\equiv 1 \pmod{12}$. For a prime $p$ all of $1, \dots, p - 1$ are units, so $\varphi(p) = p - 1$.</div>
<div class="ex" data-a="ex-inverse"><span class="lbl">Finding an inverse.</span> $\gcd(17, 60) = 1$, so $17$ is a unit mod $60$. Euclid: $60 = 3 \cdot 17 + 9$, $17 = 1 \cdot 9 + 8$, $9 = 1 \cdot 8 + 1$. Back up: $1 = 9 - 8 = 2 \cdot 9 - 17 = 2 \cdot 60 - 7 \cdot 17$. So $(-7) \cdot 17 \equiv 1$, and $17^{-1} \equiv -7 \equiv 53 \pmod{60}$. Check: $17 \cdot 53 = 901 = 15 \cdot 60 + 1$.</div>

<h2 data-a="order">Order</h2>
<p data-a="v2-order-see">Take a unit and list its powers. Mod $10$ the powers of $3$ are $3, 9, 7, 1, 3, 9, 7, 1, \dots$: the list comes back to $1$ and then repeats. Theorem 2 says this always happens and pins down when.</p>
` + orderThm + fogBlk('f-order-v2') + exOrder + R`

<h2 data-a="euler">Euler's theorem</h2>
<p data-a="v2-euler-see">Euler's theorem says every unit's order divides one fixed number, $\varphi(n)$. Check it on $U(12)$ before lifting the fog: each of $1, 5, 7, 11$ has order $1$ or $2$, and $\varphi(12) = 4$.</p>
` + eulerThm + fogBlk('f-euler-v2') + unitsPhi;

  /* ---------- basic: The Chinese remainder theorem ---------- */
  var ntCrt = head('The Chinese remainder theorem') + R`
<p class="note" data-a="uses">Uses <a class="ref" data-to="nt-divisibility#bezout">Bézout</a> and <a class="ref" data-to="nt-divisibility#euclid-lemma">Euclid's lemma</a>; the last section uses <a class="ref" data-to="nt-units#unit-gcd">units</a>.</p>

<h2 data-a="crt-sec">Two moduli</h2>
<div class="thm" data-a="crt"><span class="lbl">Theorem 1 (CRT).</span> Let $m, n \ge 1$ be coprime. For any integers $a, b$ there is an integer $x$ with $x \equiv a \pmod m$ and $x \equiv b \pmod n$, and any two such $x$ are congruent mod $mn$. Equivalently, $x \bmod mn \mapsto (x \bmod m,\ x \bmod n)$ is a bijection from residues mod $mn$ to pairs of residues, and it respects $+$ and $\times$.</div>
` + fogBlk('f-crt') + R`
<div class="ex" data-a="ex-crt"><span class="lbl">Example.</span> $x \equiv 3 \pmod 8$ and $x \equiv 4 \pmod 9$. The numbers $\equiv 4 \pmod 9$ run $4, 13, 22, 31, 40, 49, 58, 67, \dots$, and the first of them that is $\equiv 3 \pmod 8$ is $67 = 8 \cdot 8 + 3$. By Theorem 1 it is the only solution mod $72$.</div>
<p data-a="crt-coprime">Coprimality matters: $x \equiv 1 \pmod 4$ makes $x$ odd and $x \equiv 2 \pmod 6$ makes it even, so that pair has no solution.</p>

<h2 data-a="crt-many">Several moduli</h2>
<div class="thm" data-a="crt-many-thm"><span class="lbl">Theorem 2.</span> If $n_1, \dots, n_k$ are pairwise coprime, the system $x \equiv a_i \pmod{n_i}$ for $i = 1, \dots, k$ has a solution, and it is unique mod $n_1 n_2 \cdots n_k$.</div>
` + fogBlk('f-crt-many') + R`

<h2 data-a="crt-solve">Counting solutions by splitting</h2>
<div class="thm" data-a="crt-count"><span class="lbl">Theorem 3.</span> Let $f$ be a polynomial with integer coefficients and $m, n$ coprime. If $f(x) \equiv 0$ has $N_m$ solutions mod $m$ and $N_n$ solutions mod $n$, then it has $N_m N_n$ solutions mod $mn$.</div>
` + fogBlk('f-crt-count') + R`
<div class="ex" data-a="ex-count"><span class="lbl">Example.</span> $x^2 \equiv 1 \pmod{35}$. Checking every residue, the solutions are $\pm 1$ mod $5$ and $\pm 1$ mod $7$, so there are $2 \cdot 2 = 4$ mod $35$: $1, 6, 29, 34$.</div>

<h2 data-a="crt-units-sec">Units split too</h2>
<div class="thm" data-a="crt-units"><span class="lbl">Theorem 4.</span> For coprime $m, n$, an integer is a unit mod $mn$ if and only if it is a unit mod $m$ and a unit mod $n$. Hence $\varphi(mn) = \varphi(m)\varphi(n)$, and for $n = p_1^{e_1} \cdots p_k^{e_k}$ with distinct primes $p_i$, $\varphi(n) = n \prod_i (1 - 1/p_i)$.</div>
` + fogBlk('f-crt-units') + R`
<div class="ex" data-a="ex-phi"><span class="lbl">Example.</span> $\varphi(360) = \varphi(8)\varphi(9)\varphi(5) = 4 \cdot 6 \cdot 4 = 96$. Without coprimality the rule fails: $\varphi(4) = 2$, but $\varphi(2)\varphi(2) = 1$.</div>
`;

  /* ---------- topic: Serial framing ---------- */
  var ddFraming = head('Serial framing') + R`
<h2 data-a="fr-why">What a frame is for</h2>
<p data-a="fr-intro">A serial link carries one bit per bit-time on one wire. The receiver has to answer three questions the wire does not answer by itself: where a byte starts, which bit is which, and whether the bits arrived intact. A frame is the agreed answer.</p>

<h2 data-a="fr-uart">The UART frame</h2>
<p data-a="fr-uart-def">The line idles high. A frame is a start bit ($0$), the data bits least significant first, an optional parity bit, and a stop bit ($1$). 8N1 means 8 data bits, no parity, 1 stop bit: 10 bit-times per byte. The falling edge that opens the start bit is the only timing reference the receiver gets for each byte.</p>
<p data-a="fr-timing">Bit timing comes from counting clock cycles. With <code>CLKS_PER_BIT</code> $= N$, each bit is held for exactly $N$ cycles, so a counter that wraps every $N$ cycles marks the bit boundaries, and a <a class="ref" data-to="dd-lfsr#shift">shift register</a> holding the frame moves out one bit per boundary. A receiver samples each bit near its middle, about $N/2$ cycles after the boundary it infers from the start edge.</p>
<p data-a="fr-errors">A stop bit read as $0$ is a <b>framing error</b>: the receiver has lost the bit boundaries, or the line is held low. Parity is the 1-bit <a class="ref" data-to="dd-crc#crc-parity">CRC with generator $x + 1$</a>: it catches any odd number of flipped bits and no even number.</p>

<h2 data-a="fr-packets">Frames of many bytes</h2>
<p data-a="fr-delim">Above the byte level a frame needs a boundary rule (a length field, a reserved delimiter byte with escaping, or an idle gap) and an integrity check over the whole frame, usually a <a class="ref" data-to="dd-crc#crc-rem">CRC</a> appended to the payload. The receiver can recompute it and compare, or run the same register over payload and check together and test for zero (<a class="ref" data-to="dd-crc#crc-residue">why that works</a>).</p>

<h2 data-a="fr-recognise">Recognise</h2>
<ul>
<li data-a="fr-cue-rate"><b>A bit rate slower than the clock.</b> A counter that wraps once per bit-time.</li>
<li data-a="fr-cue-order"><b>Bits leaving in a fixed order.</b> A <a class="ref" data-to="dd-lfsr#shift">shift register</a>: loaded in parallel, shifted out one bit at a time.</li>
<li data-a="fr-cue-phases"><b>Distinct phases (idle, start, data, stop).</b> A small state machine, or a bit counter that doubles as the state.</li>
<li data-a="fr-cue-check"><b>A remainder or checksum defined by a polynomial over bits.</b> A <a class="ref" data-to="dd-crc#crc-shift">CRC register</a>, one bit per step, or several steps unrolled per byte.</li>
</ul>

<h2 data-a="fr-traps">Traps</h2>
<ul>
<li data-a="fr-trap-order"><b>Bit order.</b> UART data goes least significant bit first; the CRCs here go most significant bit first. Mixing the two conventions is the commonest bug.</li>
<li data-a="fr-trap-off1"><b>Off by one at the boundaries.</b> Count the cycles each bit is held in the waveform, not in the code.</li>
<li data-a="fr-trap-busy"><b>Start while busy.</b> A start request during a frame must be ignored, and the data latched on the accepting edge; reading <code>data</code> later sends whatever is on it then.</li>
<li data-a="fr-trap-reset"><b>Reset value is not initial value.</b> A per-frame register (a CRC, a bit counter) returns to its initial value at every frame boundary, not only on reset.</li>
</ul>

<h2 data-a="fr-kata">Kata</h2>
<p data-a="fr-kata-p">The transmitter, cycle-exact. Make the design call before writing code.</p>
` + kataBlk('k-uart') + `
`;

  /* ---------- basic: Shift registers and LFSRs over GF(2) ---------- */
  var ddLfsr = head('Shift registers and LFSRs over GF(2)') + R`
<p class="note" data-a="uses">Needs nothing. The CRC page builds on it.</p>

<h2 data-a="gf2">Bits as a field</h2>
<p class="def" data-a="gf2-def"><b>GF(2)</b> is the set $\{0, 1\}$ with addition XOR and multiplication AND. Every element is its own negative ($1 + 1 = 0$), so subtracting is the same as adding. A polynomial over GF(2) is a bit vector: $x^8 + x^6 + x^5 + x^4 + 1$ is <code>1_0111_0001</code>, read from $x^8$ down to $x^0$. Adding two polynomials is the XOR of their vectors, and multiplying by $x$ is a shift by one place.</p>

<h2 data-a="shift">Shift registers</h2>
<p class="def" data-a="shift-def"><b>Definition.</b> An $n$-bit shift register is $n$ flip-flops in a chain. On each rising clock edge with enable high, every bit moves one place along and a new bit enters at one end. The convention on this page: the sampled <code>din</code> enters at bit $0$, bit $k$ moves to bit $k + 1$, and the old bit $n - 1$ is lost. With enable low every bit holds.</p>
<div class="thm" data-a="shift-delay"><span class="lbl">Theorem 1 (delay line).</span> Keep enable high, number the rising edges $1, 2, 3, \dots$, and let $d_t$ be the value of <code>din</code> sampled at edge $t$. Right after edge $t$, bit $k$ of the register holds $d_{t-k}$, for every $k$ with $0 \le k \le n - 1$ and $t - k \ge 1$.</div>
` + fogBlk('f-shift-delay') + R`
<p data-a="shift-try">Build one; the testbench checks every cycle.</p>
` + kataBlk('k-shift') + R`

<h2 data-a="lfsr">Linear feedback</h2>
<p class="def" data-a="lfsr-def"><b>Definition.</b> A <b>linear feedback shift register</b> (LFSR) is a shift register whose new bits are XORs of its own bits. In the <b>Galois</b> form used here, each step moves every bit one place toward bit $0$ (bit $n - 1$ receives $0$), and if the bit that left bit $0$ was $1$, a fixed <b>tap mask</b> is XORed into the result.</p>
<p data-a="lfsr-linear">Each new bit is an XOR of old bits, so one step is a linear map on $n$-bit vectors over GF(2): stepping $q \oplus q'$ gives the XOR of the two stepped values. In particular the all-zero state steps to itself, which is why an LFSR needs a nonzero seed.</p>
<div class="thm" data-a="lfsr-poly"><span class="lbl">Theorem 2 (the Galois step is multiplication).</span> Read an 8-bit state as the polynomial $S(x) = \sum_{i=0}^{7} q_i x^i$ over GF(2), and let $p(x) = x^8 + x^6 + x^5 + x^4 + 1$. The Galois step with tap mask <code>8'hB8</code> sends $S$ to $x^{-1} S \bmod p$, where $x^{-1} = x^7 + x^5 + x^4 + x^3$ is the inverse of $x$ mod $p$.</div>
` + fogBlk('f-lfsr-poly') + R`
<div class="thm" data-a="lfsr-period"><span class="lbl">Theorem 3 (period bound).</span> If the tap mask has bit $n - 1$ set, the Galois step is invertible, the states from any seed return to that seed, and from a nonzero seed they visit at most $2^n - 1$ states before returning.</div>
` + fogBlk('f-lfsr-period') + R`
<p data-a="lfsr-max">By Theorem 2, from seed $1$ the state after $t$ steps is $x^{-t} \bmod p$, so the period from seed $1$ is the least $t \ge 1$ with $x^t \equiv 1 \pmod p$: the order of $x$, the same notion as the <a class="ref" data-to="nt-units#order-thm">order of a unit mod $n$</a>. For this $p$ it is $255 = 2^8 - 1$, the most Theorem 3 allows; a polynomial with that property is called <b>primitive</b>. The kata's testbench runs the register, so you can watch the period rather than take it on trust.</p>
<div class="ex" data-a="ex-lfsr"><span class="lbl">Example.</span> One step from <code>8'h17</code> = <code>0001_0111</code> with tap mask <code>8'hB8</code>: the bit leaving bit $0$ is $1$; moving every bit toward bit $0$ gives <code>0000_1011</code>; XORing <code>1011_1000</code> gives <code>1011_0011</code> = <code>8'hB3</code>.</div>
<p data-a="lfsr-fib">The other common form, <b>Fibonacci</b>, XORs the tapped bits into a single feedback bit that enters at one end. The Galois form spreads the XORs out, at most one in front of each flip-flop, which keeps the logic between flip-flops shallow.</p>
` + kataBlk('k-lfsr') + `
`;

  /* ---------- basic: CRC as polynomial division over GF(2) ---------- */
  var ddCrc = head('CRC as polynomial division over GF(2)') + R`
<p class="note" data-a="uses">Uses <a class="ref" data-to="dd-lfsr#gf2">bits as GF(2)</a> and the <a class="ref" data-to="dd-lfsr#shift">shift register</a>.</p>

<h2 data-a="crc-def">The definition</h2>
<p data-a="crc-msg">Read a message of $k$ bits $b_1 b_2 \dots b_k$, in the order sent, as the polynomial $M(x) = b_1 x^{k-1} + b_2 x^{k-2} + \dots + b_k$ over GF(2): the first bit sent is the highest power. Fix a <b>generator</b> $G(x)$ of degree $r \ge 1$ with constant term $1$.</p>
<div class="thm" data-a="poly-div"><span class="lbl">Theorem 1 (division over GF(2)).</span> For polynomials $A$ and $G \ne 0$ over GF(2) there are unique $Q$ and $R$ with $A = QG + R$ and $\deg R \lt \deg G$ (the zero polynomial has degree $-\infty$).</div>
` + fogBlk('f-poly-div') + R`
<p data-a="poly-bezout">With degree in place of size and Theorem 1 in place of division with remainder, the proofs of <a class="ref" data-to="nt-divisibility#bezout">Bézout</a> and <a class="ref" data-to="nt-divisibility#euclid-lemma">Euclid's lemma</a> go through word for word for polynomials over GF(2). They are used below in that form.</p>
<p class="def" data-a="crc-rem"><b>Definition.</b> The <b>CRC</b> of the message is the remainder $R(x)$ of $M(x)\,x^r$ on division by $G(x)$. It has degree below $r$, so it fits in $r$ bits, and the sender appends them to the message, highest power first. This is the plain form: initial value $0$, no bit reflection, no final XOR. The katas use CRC-8 with $G = x^8 + x^2 + x + 1$, written <code>8'h07</code> once its leading term is dropped.</p>
<div class="ex" data-a="ex-crc"><span class="lbl">Example.</span> The byte <code>8'h80</code> is $M = x^7$, so its CRC is $x^{15} \bmod G$. Since $x^8 \equiv x^2 + x + 1$: $x^{15} = x^7 \cdot x^8 \equiv x^9 + x^8 + x^7$, and $x^9 \equiv x^3 + x^2 + x$, so $x^{15} \equiv x^7 + x^3 + 1$, the byte <code>8'h89</code>. In the same way the byte <code>8'h01</code> gives $x^8 \bmod G$, which is <code>8'h07</code>.</div>

<h2 data-a="crc-why">What it catches</h2>
<div class="thm" data-a="crc-check"><span class="lbl">Theorem 2 (the codeword is a multiple of G).</span> The transmitted word $T(x) = M(x)\,x^r + R(x)$ is a multiple of $G$. If the channel flips the bits marked by an error polynomial $E$, the received word $T + E$ leaves remainder $E \bmod G$, so the error goes unnoticed exactly when $G \mid E$.</div>
` + fogBlk('f-crc-check') + R`
<div class="thm" data-a="crc-detect"><span class="lbl">Theorem 3 (what a generator catches).</span> Let $G$ have degree $r \ge 1$ and constant term $1$. (a) Every single flipped bit is caught. (b) If $x + 1$ divides $G$, every odd number of flipped bits is caught. (c) Every burst is caught whose flipped bits all lie within $r$ consecutive positions.</div>
` + fogBlk('f-crc-detect') + R`
<p data-a="crc-parity">Two consequences. CRC-8's $G$ has four terms, so it vanishes at $x = 1$; hence $x + 1$ divides it and (b) applies. And with $G = x + 1$ itself ($r = 1$), the remainder of $M(x)\,x$ is $M(1)$, the XOR of all the bits: a parity bit is the 1-bit CRC.</p>

<h2 data-a="crc-serial">Computing it one bit at a time</h2>
<div class="thm" data-a="crc-shift"><span class="lbl">Theorem 4 (the serial register).</span> Keep an $r$-bit register $c$, starting at $0$. For each message bit $b$, in order: let $f = c_{r-1} \oplus b$; shift $c$ up one place, dropping bit $r - 1$ and putting $0$ in bit $0$; if $f = 1$, XOR in the low $r$ coefficient bits of $G$. After the last bit, $c = R$, the CRC. No zeros need to be appended.</div>
` + fogBlk('f-crc-shift') + R`
<div class="thm" data-a="crc-residue"><span class="lbl">Theorem 5 (checking by running on).</span> Run the register of Theorem 4 over the message followed by its $r$ CRC bits: it ends at $0$. With any other $r$ bits in place of the CRC it ends at a nonzero value.</div>
` + fogBlk('f-crc-residue') + R`
<p data-a="crc-try">Build the CRC-8 register; the testbench feeds it messages one bit per <code>valid</code> cycle.</p>
` + kataBlk('k-crc') + `
`;

  var docs = {
    'nt-moves': {id: 'nt-moves', title: 'Number theory: first moves', kind: 'topic', area: 'nt', track: 'putnam',
      needs: ['nt-divisibility', 'nt-units', 'nt-crt'], versions: {1: ntMoves}},
    'nt-divisibility': {id: 'nt-divisibility', title: 'Divisibility and Bézout', kind: 'basic', area: 'nt', track: 'putnam',
      needs: [], versions: {1: ntDiv}},
    'nt-units': {id: 'nt-units', title: 'Units mod n', kind: 'basic', area: 'nt', track: 'putnam',
      needs: ['nt-divisibility'], versions: {1: units1, 2: units2},
      rebuiltFrom: "Starts from the three divisibility facts it uses, defines residues and arithmetic mod n before units, adds a worked inverse and a power-cycle example, and splits each proof into smaller fogged steps. Build 1's anchors are kept, so ink follows."},
    'nt-crt': {id: 'nt-crt', title: 'The Chinese remainder theorem', kind: 'basic', area: 'nt', track: 'putnam',
      needs: ['nt-divisibility', 'nt-units'], versions: {1: ntCrt}},
    'dd-framing': {id: 'dd-framing', title: 'Serial framing', kind: 'topic', area: 'dd', track: 'asic',
      needs: ['dd-lfsr', 'dd-crc'], versions: {1: ddFraming}},
    'dd-lfsr': {id: 'dd-lfsr', title: 'Shift registers and LFSRs over GF(2)', kind: 'basic', area: 'dd', track: 'asic',
      needs: [], versions: {1: ddLfsr}},
    'dd-crc': {id: 'dd-crc', title: 'CRC as polynomial division over GF(2)', kind: 'basic', area: 'dd', track: 'asic',
      needs: ['dd-lfsr'], versions: {1: ddCrc}}
  };

  /* =====================================================================================
     FOG BLOCKS: one per proof. steps reveal one at a time (push 0); chunks merge them into
     two (push 1); push 2 drills the whole proof cold; push 3 turns the statement into a hook.
     ===================================================================================== */
  var fog = {
    /* --- nt-divisibility --- */
    'f-div-alg': {doc: 'nt-divisibility', basic: 'nt-divisibility', anchor: 'div-alg', title: 'Division with remainder',
      statement: R`For integers $a$ and $b$ with $b \gt 0$ there are unique integers $q$ and $r$ with $a = qb + r$ and $0 \le r \lt b$.`,
      steps: [
        {topic: 'least element', html: R`Consider the numbers $a - qb$ for all integers $q$, and keep those that are $\ge 0$. Some are kept: $q = -|a|$ gives $a + |a|b \ge a + |a| \ge 0$, since $b \ge 1$. Let $r = a - qb$ be the least kept number.`},
        {topic: 'minimality', html: R`If $r \ge b$, then $r - b = a - (q + 1)b$ is also kept and is smaller than $r$. So $0 \le r \lt b$, which proves existence.`},
        {topic: 'uniqueness', html: R`If also $a = q'b + r'$ with $0 \le r' \lt b$, then $b(q - q') = r' - r$. The right side lies strictly between $-b$ and $b$, and the only multiple of $b$ there is $0$. So $r' = r$, and then $q' = q$.`}
      ], chunks: [[0, 1], [2]]},
    'f-euclid': {doc: 'nt-divisibility', basic: 'nt-divisibility', anchor: 'euclid', title: "Euclid's algorithm",
      statement: R`For every integer $q$, $\gcd(a, b) = \gcd(b, a - qb)$. Starting from $a, b \ge 0$ with $b \gt 0$, repeatedly replacing $(a, b)$ by $(b, a \bmod b)$ reaches a pair $(g, 0)$ after finitely many steps, and $g = \gcd(a, b)$.`,
      steps: [
        {topic: 'same common divisors', html: R`If $d \mid a$ and $d \mid b$, then $d \mid a - qb$. If $d \mid b$ and $d \mid a - qb$, then $d \mid (a - qb) + qb = a$. So $(a, b)$ and $(b, a - qb)$ have exactly the same common divisors, hence the same greatest one.`},
        {topic: 'termination', html: R`Each step replaces the second entry $b$ by $a \bmod b$, which lies in $\{0, 1, \dots, b - 1\}$. The second entries form a strictly decreasing sequence of nonnegative integers, so after finitely many steps one of them is $0$.`},
        {topic: 'reading the answer', html: R`When the pair is $(g, 0)$, $g$ was the previous second entry, so $g \gt 0$, and the common divisors of $g$ and $0$ are the divisors of $g$: the gcd is $g$. By step 1 the gcd never changed along the way, so $g = \gcd(a, b)$.`}
      ], chunks: [[0], [1, 2]]},
    'f-bezout': {doc: 'nt-divisibility', basic: 'nt-divisibility', anchor: 'bezout', title: 'Bézout',
      statement: R`If $a, b$ are not both $0$, then $\gcd(a, b)$ is the least positive integer of the form $ax + by$ with $x, y$ integers; and $ax + by = c$ has an integer solution if and only if $\gcd(a, b) \mid c$.`,
      steps: [
        {topic: 'least element', html: R`Positive values of $ax + by$ exist: $a \cdot a + b \cdot b \gt 0$. Let $g = ax_0 + by_0$ be the least of them.`},
        {topic: 'division with remainder', html: R`Divide $a$ by $g$: $a = sg + r$ with $0 \le r \lt g$. Then $r = a - s(ax_0 + by_0) = a(1 - sx_0) + b(-sy_0)$ is again of the form $ax + by$. A positive $r$ would undercut $g$, so $r = 0$ and $g \mid a$. In the same way $g \mid b$.`},
        {topic: 'every common divisor', html: R`Any common divisor $d$ of $a$ and $b$ divides $ax_0 + by_0 = g$, so $d \le g$. Therefore $g$ is the greatest common divisor.`},
        {topic: 'which right-hand sides', html: R`If $ax + by = c$, then $\gcd(a, b)$ divides $c$, because it divides $a$ and $b$. Conversely, if $c = kg$, then $x = kx_0$, $y = ky_0$ is a solution.`}
      ], chunks: [[0, 1], [2, 3]]},
    'f-euclid-lemma': {doc: 'nt-divisibility', basic: 'nt-divisibility', anchor: 'euclid-lemma', title: "Euclid's lemma",
      statement: R`If $n \mid ab$ and $\gcd(n, a) = 1$, then $n \mid b$. In particular, a prime that divides a product divides one of the factors.`,
      steps: [
        {topic: 'Bézout', html: R`Since $\gcd(n, a) = 1$, Bézout gives integers $x, y$ with $nx + ay = 1$.`},
        {topic: 'multiply through', html: R`Multiply by $b$: $b = n(bx) + (ab)y$. The first term is a multiple of $n$, and so is the second, because $n \mid ab$. So $n \mid b$.`},
        {topic: 'primes', html: R`Let $p$ be prime with $p \mid ab$ and $p \nmid a$. The positive divisors of $p$ are $1$ and $p$, and $p$ does not divide $a$, so $\gcd(p, a) = 1$, and the first part gives $p \mid b$.`}
      ], chunks: [[0, 1], [2]]},
    'f-fta': {doc: 'nt-divisibility', basic: 'nt-divisibility', anchor: 'fta', title: 'Unique factorisation',
      statement: R`Every integer $n \gt 1$ is a product of primes, and any two such products for the same $n$ contain the same primes with the same multiplicities.`,
      steps: [
        {topic: 'strong induction', html: R`Existence, by strong induction on $n$. If $n$ is prime, it is a product of one prime. Otherwise $n = uv$ with $1 \lt u, v \lt n$; both are products of primes by the induction hypothesis, and so is $n$.`},
        {topic: "Euclid's lemma", html: R`Uniqueness. Suppose $p_1 p_2 \cdots p_k = q_1 q_2 \cdots q_m$ with every factor prime. $p_1$ divides the right side, so by Euclid's lemma, applied to $q_1 \cdot (q_2 \cdots q_m)$ and repeated, $p_1 \mid q_j$ for some $j$. A prime that divides a prime equals it: $p_1 = q_j$.`},
        {topic: 'cancel and repeat', html: R`Cancel $p_1$ against $q_j$ and repeat on the shorter products (induction on $k$). If one side runs out of factors it equals $1$, so the other side has run out too, since a product of primes exceeds $1$. So the two lists agree up to order.`}
      ], chunks: [[0], [1, 2]]},
    'f-cong-arith': {doc: 'nt-divisibility', basic: 'nt-divisibility', anchor: 'cong-arith', title: 'Congruences add and multiply',
      statement: R`If $a \equiv a'$ and $b \equiv b' \pmod n$, then $a + b \equiv a' + b'$ and $ab \equiv a'b' \pmod n$.`,
      steps: [
        {topic: 'name the differences', html: R`Write $a' = a + sn$ and $b' = b + tn$ with integers $s, t$.`},
        {topic: 'sum', html: R`$a' + b' = (a + b) + (s + t)n$, so $a' + b' \equiv a + b$. Differences work the same way.`},
        {topic: 'product', html: R`$a'b' = ab + (at + bs + stn)\,n$, so $a'b' \equiv ab$.`},
        {topic: 'induction', html: R`Powers: if $a'^k \equiv a^k$, the product rule gives $a'^{k+1} = a'^k a' \equiv a^k a = a^{k+1}$. Any expression is built one operation at a time, so the replacements can be made one at a time.`}
      ], chunks: [[0, 1], [2, 3]]},

    /* --- nt-units, build 1 --- */
    'f-unit-gcd': {doc: 'nt-units', basic: 'nt-units', anchor: 'unit-gcd', title: 'Units are the residues coprime to n',
      statement: R`$a$ is a unit mod $n$ if and only if $\gcd(a, n) = 1$. The inverse is unique mod $n$, and products and inverses of units are units.`,
      steps: [
        {topic: 'a unit forces gcd 1', html: R`If $ax \equiv 1$, then $ax - 1 = ny$ for some integer $y$, so every common divisor of $a$ and $n$ divides $ax - ny = 1$. Hence $\gcd(a, n) = 1$.`},
        {topic: 'Bézout', html: R`If $\gcd(a, n) = 1$, Bézout gives $ax + ny = 1$. Read mod $n$, this says $ax \equiv 1$.`},
        {topic: 'uniqueness', html: R`If $ax \equiv 1$ and $ax' \equiv 1$, then $x \equiv x(ax') = (xa)x' \equiv x'$.`},
        {topic: 'closure', html: R`If $ax \equiv 1$ and $by \equiv 1$, then $(ab)(xy) = (ax)(by) \equiv 1$. And $xa \equiv 1$ says $x$ is a unit with inverse $a$.`}
      ], chunks: [[0, 1], [2, 3]]},
    'f-order': {doc: 'nt-units', basic: 'nt-units', anchor: 'order-thm', title: 'Order',
      statement: R`Let $a$ be a unit mod $n$. Some power $a^k$ with $k \ge 1$ is $\equiv 1$; if $d$ is the least such $k$, then $a^m \equiv 1$ exactly when $d \mid m$, and $a^m \equiv a^{m'}$ exactly when $m \equiv m' \pmod d$.`,
      steps: [
        {topic: 'pigeonhole on powers', html: R`The $n + 1$ powers $a, a^2, \dots, a^{n+1}$ take at most $n$ values mod $n$, so $a^i \equiv a^j$ for some $1 \le i \lt j$. Multiplying by $(a^{-1})^i$ gives $a^{j-i} \equiv 1$. So a least exponent $d \ge 1$ with $a^d \equiv 1$ exists.`},
        {topic: 'multiples of d', html: R`If $d \mid m$, then $a^m = (a^d)^{m/d} \equiv 1$.`},
        {topic: 'division with remainder', html: R`If $a^m \equiv 1$, write $m = qd + r$ with $0 \le r \lt d$. Then $1 \equiv a^m = (a^d)^q a^r \equiv a^r$, and since $d$ is least, $r$ cannot be positive. So $r = 0$ and $d \mid m$.`},
        {topic: 'two exponents', html: R`For $m \ge m'$, multiplying by $(a^{-1})^{m'}$ (or back by $a^{m'}$) shows that $a^m \equiv a^{m'}$ is equivalent to $a^{m - m'} \equiv 1$, that is, to $d \mid m - m'$.`}
      ], chunks: [[0, 1], [2, 3]]},
    'f-euler': {doc: 'nt-units', basic: 'nt-units', anchor: 'euler-thm', title: "Euler's theorem",
      statement: R`If $\gcd(a, n) = 1$, then $\operatorname{ord}_n(a) \mid \varphi(n)$, so $a^{\varphi(n)} \equiv 1 \pmod n$.`,
      steps: [
        {topic: 'the powers of a', html: R`Let $d = \operatorname{ord}_n(a)$ and $H = \{1, a, \dots, a^{d-1}\}$. By Theorem 2 these are $d$ different units and every power of $a$ is one of them. So $H$ contains the product of any two of its elements, and the inverse $a^{d-i}$ of each $a^i$.`},
        {topic: 'cosets have size d', html: R`For a unit $u$ put $uH = \{uh : h \in H\}$. Multiplying by $u$ is one-to-one on residues (multiply back by $u^{-1}$), so $uH$ has exactly $d$ elements, all units.`},
        {topic: 'equal or disjoint', html: R`If $uH$ and $vH$ share an element, $uh \equiv vh'$, then $u \equiv v\,h'h^{-1}$ with $h'h^{-1} \in H$. So every $uk$ with $k \in H$ equals $v(h'h^{-1}k) \in vH$: $uH \subseteq vH$, and by symmetry $uH = vH$.`},
        {topic: 'count', html: R`Each unit $u$ lies in its own $uH$. So $U(n)$ is cut into disjoint sets of size $d$, and $d \mid \varphi(n)$. Finally $a^{\varphi(n)} = (a^d)^{\varphi(n)/d} \equiv 1$.`}
      ], chunks: [[0, 1], [2, 3]]},

    /* --- nt-units, build 2: the same theorems in smaller steps --- */
    'f-unit-gcd-v2': {doc: 'nt-units', version: 2, basic: 'nt-units', anchor: 'unit-gcd', title: 'Units are the residues coprime to n',
      statement: R`$a$ is a unit mod $n$ if and only if $\gcd(a, n) = 1$. The inverse is unique mod $n$, and products and inverses of units are units.`,
      steps: [
        {topic: 'what ax ≡ 1 says', html: R`Suppose $ax \equiv 1 \pmod n$. By definition $n \mid ax - 1$, so $ax - 1 = ny$ for some integer $y$; that is, $ax - ny = 1$.`},
        {topic: 'common divisors', html: R`Let $d$ be a positive common divisor of $a$ and $n$. Then $d$ divides $ax - ny = 1$, so $d = 1$. Hence $\gcd(a, n) = 1$.`},
        {topic: 'Bézout', html: R`Conversely, suppose $\gcd(a, n) = 1$. Bézout gives integers $x, y$ with $ax + ny = 1$. Then $ax - 1 = -ny$ is a multiple of $n$, so $ax \equiv 1$ and $a$ is a unit.`},
        {topic: 'uniqueness', html: R`If $x$ and $x'$ are both inverses of $a$, then, using that congruences multiply, $x \equiv x \cdot 1 \equiv x(ax') = (xa)x' \equiv 1 \cdot x' = x'$.`},
        {topic: 'closure', html: R`If $ax \equiv 1$ and $by \equiv 1$, then $(ab)(xy) = (ax)(by) \equiv 1$, so $ab$ is a unit. And $xa \equiv 1$ says $x$ is a unit, with inverse $a$.`}
      ], chunks: [[0, 1, 2], [3, 4]]},
    'f-order-v2': {doc: 'nt-units', version: 2, basic: 'nt-units', anchor: 'order-thm', title: 'Order',
      statement: R`Let $a$ be a unit mod $n$. Some power $a^k$ with $k \ge 1$ is $\equiv 1$; if $d$ is the least such $k$, then $a^m \equiv 1$ exactly when $d \mid m$, and $a^m \equiv a^{m'}$ exactly when $m \equiv m' \pmod d$.`,
      steps: [
        {topic: 'finitely many residues', html: R`There are only $n$ residues mod $n$, so among the $n + 1$ powers $a^1, a^2, \dots, a^{n+1}$ two are congruent: $a^i \equiv a^j$ with $1 \le i \lt j$.`},
        {topic: 'cancel a unit', html: R`Let $x$ be an inverse of $a$. Multiply both sides by $x^i$: on the left $a^i x^i = (ax)^i \equiv 1$, on the right $a^j x^i = a^{j-i}(ax)^i \equiv a^{j-i}$. So $a^{j-i} \equiv 1$ with $j - i \ge 1$, and there is a least exponent $d \ge 1$ with $a^d \equiv 1$.`},
        {topic: 'multiples of d', html: R`If $m = qd$, then $a^m = (a^d)^q \equiv 1^q = 1$.`},
        {topic: 'division with remainder', html: R`If $a^m \equiv 1$, write $m = qd + r$ with $0 \le r \lt d$. Then $1 \equiv a^m = (a^d)^q a^r \equiv a^r$. Since $r \lt d$ and $d$ is the least positive exponent giving $1$, $r$ cannot be positive: $r = 0$, so $d \mid m$.`},
        {topic: 'comparing two powers', html: R`For $m \ge m' \ge 0$: multiplying $a^m \equiv a^{m'}$ by $x^{m'}$ gives $a^{m-m'} \equiv 1$, and multiplying that back by $a^{m'}$ returns the first. So $a^m \equiv a^{m'}$ exactly when $d \mid m - m'$.`}
      ], chunks: [[0, 1], [2, 3, 4]]},
    'f-euler-v2': {doc: 'nt-units', version: 2, basic: 'nt-units', anchor: 'euler-thm', title: "Euler's theorem",
      statement: R`If $\gcd(a, n) = 1$, then $\operatorname{ord}_n(a) \mid \varphi(n)$, so $a^{\varphi(n)} \equiv 1 \pmod n$.`,
      steps: [
        {topic: 'the powers of a', html: R`Let $d = \operatorname{ord}_n(a)$ and $H = \{a^0, a^1, \dots, a^{d-1}\}$. By Theorem 2 these are $d$ different residues, every power of $a$ is one of them, and each is a unit.`},
        {topic: 'H is closed', html: R`The product of $a^i$ and $a^j$ is $a^{i+j}$, a power of $a$, so it lies in $H$. The inverse of $a^i$ is $a^{d-i}$ (for $i \gt 0$), also in $H$.`},
        {topic: 'shifted copies', html: R`For a unit $u$ let $uH = \{u a^0, u a^1, \dots, u a^{d-1}\}$. These $d$ residues are different (if $ua^i \equiv ua^j$, multiply by $u^{-1}$), and all are units, being products of units.`},
        {topic: 'equal or disjoint', html: R`Suppose $uH$ and $vH$ share an element: $uh \equiv vh'$ with $h, h' \in H$. Then $u \equiv v\,h'h^{-1}$, and $h'h^{-1} \in H$ by step 2. So each $uk$ with $k \in H$ equals $v(h'h^{-1}k)$, an element of $vH$: $uH \subseteq vH$. Swapping the roles gives $vH \subseteq uH$.`},
        {topic: 'count', html: R`Each unit $u$ lies in its own copy, as $u = ua^0$. So $U(n)$ is cut into disjoint copies of size $d$; with $c$ copies, $\varphi(n) = cd$. Then $a^{\varphi(n)} = (a^d)^c \equiv 1$.`}
      ], chunks: [[0, 1, 2], [3, 4]]},

    /* --- nt-crt --- */
    'f-crt': {doc: 'nt-crt', basic: 'nt-crt', anchor: 'crt', title: 'The Chinese remainder theorem',
      statement: R`Let $m, n \ge 1$ be coprime. For any integers $a, b$ there is an integer $x$ with $x \equiv a \pmod m$ and $x \equiv b \pmod n$, and any two such $x$ are congruent mod $mn$.`,
      steps: [
        {topic: 'at most one', html: R`If $x$ and $y$ both work, then $m \mid x - y$ and $n \mid x - y$. Write $x - y = mk$. Then $n \mid mk$ with $\gcd(n, m) = 1$, so $n \mid k$ by Euclid's lemma, and $mn \mid x - y$.`},
        {topic: 'a formula from Bézout', html: R`Bézout gives $mu + nv = 1$. Put $x = a\,nv + b\,mu$. Mod $m$: $nv = 1 - mu \equiv 1$ and $mu \equiv 0$, so $x \equiv a$. Mod $n$, symmetrically, $x \equiv b$.`},
        {topic: 'the map', html: R`The map $x \bmod mn \mapsto (x \bmod m, x \bmod n)$ is well defined, since $mn \mid x - x'$ forces $m \mid x - x'$ and $n \mid x - x'$. Step 2 says every pair is reached; step 1 says residues mod $mn$ with the same pair are equal. It respects $+$ and $\times$ because reducing mod $m$, or mod $n$, does.`}
      ], chunks: [[0], [1, 2]]},
    'f-crt-many': {doc: 'nt-crt', basic: 'nt-crt', anchor: 'crt-many-thm', title: 'Several moduli',
      statement: R`If $n_1, \dots, n_k$ are pairwise coprime, the system $x \equiv a_i \pmod{n_i}$ for $i = 1, \dots, k$ has a solution, unique mod $n_1 n_2 \cdots n_k$.`,
      steps: [
        {topic: 'coprime to a product', html: R`If $\gcd(n_1, n_3) = \gcd(n_2, n_3) = 1$, then $\gcd(n_1 n_2, n_3) = 1$: otherwise some prime divides both $n_1 n_2$ and $n_3$, and by Euclid's lemma it divides $n_1$ or $n_2$ as well as $n_3$.`},
        {topic: 'glue two at a time', html: R`By Theorem 1, the conditions mod $n_1$ and mod $n_2$ together say exactly $x \equiv c \pmod{n_1 n_2}$ for one residue $c$. The system now has $k - 1$ conditions, and by step 1 the moduli $n_1 n_2, n_3, \dots, n_k$ are still pairwise coprime.`},
        {topic: 'induction', html: R`Repeat, by induction on $k$. When one condition $x \equiv c \pmod{n_1 \cdots n_k}$ is left, it has a solution, unique mod $n_1 \cdots n_k$.`}
      ], chunks: [[0], [1, 2]]},
    'f-crt-count': {doc: 'nt-crt', basic: 'nt-crt', anchor: 'crt-count', title: 'Counting solutions by splitting',
      statement: R`Let $f$ be a polynomial with integer coefficients and $m, n$ coprime. If $f(x) \equiv 0$ has $N_m$ solutions mod $m$ and $N_n$ solutions mod $n$, then it has $N_m N_n$ solutions mod $mn$.`,
      steps: [
        {topic: 'residues decide', html: R`$f(x) \bmod m$ depends only on $x \bmod m$, because congruences add and multiply. So it makes sense to count solutions among residues.`},
        {topic: 'split the condition', html: R`$mn \mid f(x)$ if and only if $m \mid f(x)$ and $n \mid f(x)$. One way is clear; for the other, write $f(x) = mk$, so $n \mid mk$, and Euclid's lemma gives $n \mid k$.`},
        {topic: 'match the pairs', html: R`Under the bijection of Theorem 1, the solutions mod $mn$ therefore correspond exactly to pairs (solution mod $m$, solution mod $n$). There are $N_m N_n$ such pairs.`}
      ], chunks: [[0, 1], [2]]},
    'f-crt-units': {doc: 'nt-crt', basic: 'nt-crt', anchor: 'crt-units', title: 'Units split too',
      statement: R`For coprime $m, n$, an integer is a unit mod $mn$ if and only if it is a unit mod $m$ and mod $n$. Hence $\varphi(mn) = \varphi(m)\varphi(n)$, and $\varphi(n) = n \prod_{p \mid n} (1 - 1/p)$.`,
      steps: [
        {topic: 'the gcd splits', html: R`$\gcd(x, mn) = 1$ if and only if $\gcd(x, m) = 1$ and $\gcd(x, n) = 1$. A common divisor of $x$ and $m$ also divides $mn$, which gives one direction. For the other, a prime dividing $x$ and $mn$ divides $m$ or $n$, by Euclid's lemma.`},
        {topic: 'units correspond', html: R`Being a unit means being coprime to the modulus (Theorem 1 of the units page), so step 1 says: $x$ is a unit mod $mn$ exactly when its residues mod $m$ and mod $n$ are units. The bijection of Theorem 1 therefore carries $U(mn)$ onto $U(m) \times U(n)$, and $\varphi(mn) = \varphi(m)\varphi(n)$.`},
        {topic: 'the product formula', html: R`Powers of distinct primes are pairwise coprime, so by induction $\varphi(n) = \prod_i \varphi(p_i^{e_i})$. With $\varphi(p^e) = p^e - p^{e-1} = p^e(1 - 1/p)$, this is $n \prod_i (1 - 1/p_i)$.`}
      ], chunks: [[0], [1, 2]]},

    /* --- nt-moves: the worked example --- */
    'f-moves-worked': {doc: 'nt-moves', basic: 'nt-units', anchor: 'worked-q', title: 'Worked example: the last three digits of 2^2026',
      statement: R`Find the last three digits of $2^{2026}$, that is, $2^{2026} \bmod 1000$.`,
      steps: [
        {topic: 'split the modulus', html: R`$1000 = 8 \cdot 125$ with $\gcd(8, 125) = 1$. The base $2$ is not a unit mod $1000$, but it is a unit mod $125$: the split isolates the shared prime.`},
        {topic: 'the non-unit piece', html: R`Mod $8$: $2^3 = 8 \equiv 0$, so every higher power is $0$ too: $2^{2026} \equiv 0 \pmod 8$.`},
        {topic: 'reduce the exponent', html: R`Mod $125$: $\gcd(2, 125) = 1$ and $\varphi(125) = 100$, so $2^{2026} \equiv 2^{26}$. With $2^7 = 128 \equiv 3$: $2^{26} = (2^7)^3 \cdot 2^5 \equiv 27 \cdot 32 = 864 \equiv 114 \pmod{125}$.`},
        {topic: 'glue', html: R`Need $x \equiv 0 \pmod 8$ and $x \equiv 114 \pmod{125}$. Try $x = 114 + 125t$: mod $8$ this is $2 + 5t \equiv 0$, so $5t \equiv 6$, $t \equiv 6 \pmod 8$, and $x = 114 + 750 = 864$. The last three digits are $864$.`},
        {topic: 'check', html: R`$2^{26} = 67\,108\,864$ also ends in $864$, as it must: $2^{2026} - 2^{26} = 2^{26}(2^{2000} - 1)$ is divisible by $8$, and by $125$ because $100 \mid 2000$.`}
      ], chunks: [[0, 1, 2], [3, 4]]},

    /* --- dd-lfsr --- */
    'f-shift-delay': {doc: 'dd-lfsr', basic: 'dd-lfsr', anchor: 'shift-delay', title: 'A shift register is a delay line',
      statement: R`Keep enable high, number the rising edges $1, 2, 3, \dots$, and let $d_t$ be the value of din sampled at edge $t$. Right after edge $t$, bit $k$ of the register holds $d_{t-k}$, for every $k$ with $0 \le k \le n - 1$ and $t - k \ge 1$.`,
      steps: [
        {topic: 'the step, bit by bit', html: R`The convention says: right after an enabled edge, bit $0$ holds the <code>din</code> sampled at that edge, and bit $k \ge 1$ holds what bit $k - 1$ held just before the edge.`},
        {topic: 'induction on k', html: R`For $k = 0$ the claim is the first half of step 1. Suppose it holds for $k - 1$ at every edge. Right after edge $t$, bit $k$ holds what bit $k - 1$ held right after edge $t - 1$, which is $d_{(t-1)-(k-1)} = d_{t-k}$.`},
        {topic: 'what it means', html: R`Bit $k$ is the input delayed by $k$ edges: an $n$-bit shift register holds the last $n$ inputs, newest at bit $0$. If enable sometimes drops, the same holds with edges counted only when enable is high.`}
      ], chunks: [[0], [1, 2]]},
    'f-lfsr-poly': {doc: 'dd-lfsr', basic: 'dd-lfsr', anchor: 'lfsr-poly', title: 'The Galois step is multiplication',
      statement: R`Read an 8-bit state as $S(x) = \sum_{i=0}^{7} q_i x^i$ over GF(2), and let $p(x) = x^8 + x^6 + x^5 + x^4 + 1$. The Galois step with tap mask 8'hB8 sends $S$ to $x^{-1} S \bmod p$, where $x^{-1} = x^7 + x^5 + x^4 + x^3$.`,
      steps: [
        {topic: 'an inverse of x', html: R`$x\,(x^7 + x^5 + x^4 + x^3) = x^8 + x^6 + x^5 + x^4 = p(x) + 1 \equiv 1 \pmod p$. So $x^{-1} = x^7 + x^5 + x^4 + x^3$, whose coefficients sit at bits $7, 5, 4, 3$: the mask <code>1011_1000</code>, which is <code>8'hB8</code>.`},
        {topic: 'the terms that shift', html: R`Split $S = q_0 + \sum_{i=1}^{7} q_i x^i$. For $i \ge 1$, $x^{-1} \cdot q_i x^i = q_i x^{i-1}$: bit $i$ moves to bit $i - 1$, and nothing lands in bit $7$. That is the move toward bit $0$.`},
        {topic: 'the term that wraps', html: R`The remaining term is $x^{-1} \cdot q_0 = q_0 (x^7 + x^5 + x^4 + x^3)$: the mask is XORed in exactly when $q_0 = 1$, the bit that left bit $0$. The sum of the two parts is the Galois step, and it has degree below $8$, so nothing is left to reduce.`}
      ], chunks: [[0], [1, 2]]},
    'f-lfsr-period': {doc: 'dd-lfsr', basic: 'dd-lfsr', anchor: 'lfsr-period', title: 'Period bound',
      statement: R`If the tap mask has bit $n - 1$ set, the Galois step is invertible, the states from any seed return to that seed, and from a nonzero seed they visit at most $2^n - 1$ states before returning.`,
      steps: [
        {topic: 'undo a step', html: R`After a step, bit $n - 1$ is $0$ from the move, XOR bit $n - 1$ of the mask if the mask went in. With that mask bit set, the new bit $n - 1$ equals the old bit $0$. So from the new state you can read whether the mask went in, XOR it back out, move the bits back up, and restore bit $0$: the step is invertible.`},
        {topic: 'invertible maps make cycles', html: R`Follow the steps from a seed: $s_0, s_1, s_2, \dots$. There are finitely many states, so some state repeats; take the first $j$ with $s_j = s_i$ for some $i \lt j$. If $i \gt 0$, then $s_{i-1}$ and $s_{j-1}$ step to the same state, so they are equal by invertibility: an earlier repeat, a contradiction. So $i = 0$, and the states return to the seed.`},
        {topic: 'zero is alone', html: R`The zero state steps to itself, and by invertibility nothing else steps to zero. So the cycle through a nonzero seed never contains zero, and it has at most $2^n - 1$ states.`}
      ], chunks: [[0], [1, 2]]},

    /* --- dd-crc --- */
    'f-poly-div': {doc: 'dd-crc', basic: 'dd-crc', anchor: 'poly-div', title: 'Division over GF(2)',
      statement: R`For polynomials $A$ and $G \ne 0$ over GF(2) there are unique $Q$ and $R$ with $A = QG + R$ and $\deg R \lt \deg G$.`,
      steps: [
        {topic: 'cancel the top term', html: R`If $\deg A \lt \deg G$, take $Q = 0$ and $R = A$. Otherwise both leading coefficients are $1$, so $A - x^{\deg A - \deg G}\,G$ has the top term of $A$ cancelled, and smaller degree.`},
        {topic: 'induction on degree', html: R`By induction on $\deg A$, that smaller polynomial is $Q'G + R$ with $\deg R \lt \deg G$, and then $A = (Q' + x^{\deg A - \deg G})\,G + R$. Each cancellation is one XOR of a shifted $G$: one line of long division.`},
        {topic: 'uniqueness', html: R`If $QG + R = Q'G + R'$, then $(Q - Q')G = R' - R$. The right side has degree below $\deg G$; the left side has degree at least $\deg G$ unless $Q = Q'$. So $Q = Q'$, and then $R = R'$.`}
      ], chunks: [[0, 1], [2]]},
    'f-crc-check': {doc: 'dd-crc', basic: 'dd-crc', anchor: 'crc-check', title: 'The codeword is a multiple of G',
      statement: R`The transmitted word $T = M x^r + R$ is a multiple of $G$, and the received word $T + E$ leaves remainder $E \bmod G$.`,
      steps: [
        {topic: 'divide', html: R`By Theorem 1, $M x^r = QG + R$ with $\deg R \lt r$.`},
        {topic: 'subtracting is adding', html: R`Over GF(2), $R + R = 0$, so $T = M x^r + R = QG + R + R = QG$.`},
        {topic: 'the error', html: R`$T + E = QG + E$, so $T + E$ and $E$ leave the same remainder on division by $G$ (uniqueness in Theorem 1). It is zero exactly when $G \mid E$.`}
      ], chunks: [[0, 1], [2]]},
    'f-crc-detect': {doc: 'dd-crc', basic: 'dd-crc', anchor: 'crc-detect', title: 'What a generator catches',
      statement: R`Let $G$ have degree $r \ge 1$ and constant term $1$. (a) Every single flipped bit is caught. (b) If $x + 1$ divides $G$, every odd number of flipped bits is caught. (c) Every burst within $r$ consecutive positions is caught.`,
      steps: [
        {topic: 'single bits', html: R`A single flip is $E = x^i$. Suppose $GQ = x^i$. In a product over GF(2) the lowest term is the product of the two lowest terms and the highest term the product of the two highest, with nothing to cancel them. Both equal $x^i$, which forces $G$ to be a single term. But $G$ has at least the two terms $x^r$ and $1$.`},
        {topic: 'evaluate at 1', html: R`$E(1)$ is the number of flipped bits mod $2$, so for an odd number of flips $E(1) = 1$. If $(x + 1) \mid G$ and $G \mid E$, then $(x + 1) \mid E$ and $E(1) = 0$. So $G \nmid E$.`},
        {topic: 'bursts', html: R`A burst within $r$ positions is $E = x^i B$ with $B(0) = 1$ and $\deg B \le r - 1$. A divisor of $x^i$ is a single term by step 1's argument, and it divides $G$ only if it is $1$, since $G(0) = 1$; so $\gcd(G, x^i) = 1$. If $G \mid x^i B$, Euclid's lemma gives $G \mid B$, impossible for a nonzero $B$ of degree below $\deg G$.`}
      ], chunks: [[0], [1, 2]]},
    'f-crc-shift': {doc: 'dd-crc', basic: 'dd-crc', anchor: 'crc-shift', title: 'The serial register',
      statement: R`Keep an $r$-bit register $c$, starting at $0$. For each message bit $b$: let $f = c_{r-1} \oplus b$, shift $c$ up one place (bit $r - 1$ drops, $0$ enters bit $0$), and if $f = 1$ XOR in the low $r$ coefficient bits of $G$. After the last bit, $c$ is the CRC.`,
      steps: [
        {topic: 'the invariant', html: R`Let $M_j$ be the polynomial of the first $j$ bits. Claim: after $j$ bits the register holds $M_j(x)\,x^r \bmod G$. For $j = 0$ both sides are $0$.`},
        {topic: 'one more bit', html: R`$M_{j+1} = x M_j + b$, so $M_{j+1} x^r = x\,(M_j x^r) + b\,x^r \equiv x\,c + b\,x^r \pmod G$, where $c$ is the register before the bit.`},
        {topic: 'reduce the overflow', html: R`$x\,c$ is $c$ shifted up one place plus $c_{r-1} x^r$ for the bit that falls off the top. So $x c + b x^r$ is the shifted $c$ plus $f\,x^r$, with $f = c_{r-1} \oplus b$. Write $G = x^r + g$ with $\deg g \lt r$; then $x^r \equiv g$, so replace $f x^r$ by $f g$. What is left has degree below $r$, so it is the remainder, and it is exactly the register update.`},
        {topic: 'conclude', html: R`By induction the claim holds after all $k$ bits: the register ends at $M x^r \bmod G = R$.`}
      ], chunks: [[0, 1], [2, 3]]},
    'f-crc-residue': {doc: 'dd-crc', basic: 'dd-crc', anchor: 'crc-residue', title: 'Checking by running on',
      statement: R`Run the serial register over the message followed by its $r$ CRC bits: it ends at $0$. With any other $r$ bits in place of the CRC it ends at a nonzero value.`,
      steps: [
        {topic: 'what the register computes', html: R`Feeding the message $M$ and then a trailer $C$ of $r$ bits feeds the polynomial $T = M x^r + C$, with $\deg C \lt r$. By Theorem 4 the register ends at $T x^r \bmod G$.`},
        {topic: 'G is coprime to x', html: R`As in the proof of Theorem 3(c), $\gcd(G, x^r) = 1$ because $G(0) = 1$. So by Euclid's lemma $G \mid T x^r$ exactly when $G \mid T$.`},
        {topic: 'compare with R', html: R`$G \mid T = M x^r + C$ exactly when $C \equiv M x^r \equiv R \pmod G$. Both $C$ and $R$ have degree below $r$, so by uniqueness in Theorem 1 this means $C = R$.`}
      ], chunks: [[0], [1, 2]]}
  };

  /* =====================================================================================
     METHODS: the fixed lists for calls and settling. basic: the demo basic that teaches it
     (a recognition gap needs that basic at stage >= 3). cue: its line in a topic's Recognise list.
     ===================================================================================== */
  var methods = {
    math: [
      {id: 'invariant', label: 'Invariant / monovariant'},
      {id: 'extremal', label: 'Extremal choice / minimal counterexample'},
      {id: 'pigeonhole', label: 'Pigeonhole'},
      {id: 'induction', label: 'Induction / recursion'},
      {id: 'modular', label: 'Modular arithmetic / orders', basic: 'nt-units', cue: 'nt-moves#cue-exponent'},
      {id: 'crt', label: 'CRT splitting', basic: 'nt-crt', cue: 'nt-moves#cue-split'},
      {id: 'bijection', label: 'Bijection / double counting'},
      {id: 'linearity', label: 'Linearity of expectation'},
      {id: 'genfunc', label: 'Generating functions'},
      {id: 'inequalities', label: 'Inequalities (AM-GM, Cauchy, Jensen)'},
      {id: 'polynomials', label: 'Polynomials / roots'},
      {id: 'linalg', label: 'Linear algebra'},
      {id: 'calculus', label: 'Calculus / MVT'},
      {id: 'construction', label: 'Construction'},
      {id: 'parity', label: 'Parity / colouring'}
    ],
    design: [
      {id: 'shift', label: 'Shift register', basic: 'dd-lfsr', cue: 'dd-framing#fr-cue-order'},
      {id: 'lfsr', label: 'LFSR', basic: 'dd-lfsr'},
      {id: 'counter', label: 'Counter / divider', cue: 'dd-framing#fr-cue-rate'},
      {id: 'fsm', label: 'FSM', cue: 'dd-framing#fr-cue-phases'},
      {id: 'crc', label: 'CRC / checksum', basic: 'dd-crc', cue: 'dd-framing#fr-cue-check'},
      {id: 'fifo', label: 'FIFO / handshake'},
      {id: 'pipeline', label: 'Pipelining'}
    ]
  };

  /* =====================================================================================
     PROBLEMS. Competition: label and link only; area, methods and basics are a model's guess
     (guess: true). Invented: statement and solution in a model's words; the solution shows only
     after settling. d from the Putnam position: A1/B1 3, A2/B2 4, A3/B3 5.5, A4/B4 6.5.
     ===================================================================================== */
  var DPOS = {1: 3, 2: 4, 3: 5.5, 4: 6.5};
  function putnam(year, pos, area, ms, basics, hiddenOK) {
    return {id: 'p' + year + pos.toLowerCase(), kind: 'competition', label: 'Putnam ' + year + ' ' + pos,
      link: 'https://kskedlaya.org/putnam-archive/' + year + '.pdf', d: DPOS[pos.charAt(1)], area: area,
      methods: ms, basics: basics || [], hiddenOK: hiddenOK !== false, guess: true};
  }
  var competition = [
    /* number theory & algebra */
    putnam(2016, 'A1', 'nt', ['polynomials', 'modular'], ['nt-divisibility']),
    putnam(2017, 'A1', 'nt', ['modular', 'induction'], ['nt-divisibility']),
    putnam(2018, 'A1', 'nt', ['modular'], ['nt-divisibility']),
    putnam(2019, 'A1', 'nt', ['polynomials', 'modular', 'construction'], ['nt-divisibility']),
    putnam(2020, 'A1', 'nt', ['modular', 'crt'], ['nt-units', 'nt-crt']),
    putnam(2020, 'B1', 'nt', ['bijection', 'polynomials'], ['nt-divisibility']),
    putnam(2022, 'B1', 'nt', ['genfunc', 'parity'], []),
    putnam(2024, 'A1', 'nt', ['modular', 'extremal'], ['nt-divisibility']),
    putnam(2015, 'A2', 'nt', ['modular', 'induction'], ['nt-divisibility']),
    putnam(2017, 'B2', 'nt', ['modular', 'construction'], ['nt-divisibility']),
    putnam(2023, 'B2', 'nt', ['modular', 'construction'], ['nt-units']),
    putnam(2018, 'B3', 'nt', ['modular'], ['nt-units']),
    putnam(2022, 'A3', 'nt', ['modular', 'bijection'], ['nt-units']),
    putnam(2024, 'A4', 'nt', ['modular', 'polynomials'], ['nt-units']),
    /* combinatorics & probability */
    putnam(2021, 'B1', 'cp', ['calculus'], [], false),
    putnam(2023, 'B1', 'cp', ['bijection']),
    putnam(2020, 'A2', 'cp', ['bijection', 'induction', 'genfunc']),
    putnam(2023, 'B3', 'cp', ['linearity']),
    putnam(2022, 'A4', 'cp', ['linearity', 'calculus']),
    putnam(2015, 'B4', 'cp', ['genfunc']),
    /* analysis */
    putnam(2015, 'B1', 'an', ['calculus']),
    putnam(2016, 'B1', 'an', ['calculus']),
    putnam(2021, 'B2', 'an', ['inequalities', 'construction']),
    putnam(2016, 'A3', 'an', ['invariant', 'calculus']),
    putnam(2020, 'A3', 'an', ['calculus', 'inequalities']),
    putnam(2019, 'A4', 'an', ['construction', 'calculus'], [], false),
    /* linear algebra & geometry */
    putnam(2018, 'A2', 'lg', ['linalg', 'induction']),
    putnam(2022, 'B2', 'lg', ['construction', 'linalg']),
    putnam(2019, 'B3', 'lg', ['linalg'], [], false),
    /* general reasoning */
    putnam(2018, 'B1', 'gr', ['parity', 'construction']),
    putnam(2021, 'A1', 'gr', ['parity', 'inequalities', 'construction']),
    putnam(2024, 'B1', 'gr', ['invariant', 'parity', 'construction']),
    putnam(2016, 'B3', 'gr', ['extremal']),
    putnam(2017, 'A4', 'gr', ['construction', 'extremal'])
  ];

  var invented = [
    {id: 'inv-1', kind: 'invented', label: 'Invented 1', d: 3, area: 'nt', methods: ['modular', 'crt'], basics: ['nt-units', 'nt-crt'], hiddenOK: true,
      statement: R`<p>Let $R_k$ be the number whose decimal digits are $k$ ones, so $R_1 = 1$, $R_2 = 11$, $R_3 = 111$. For how many $k$ with $1 \le k \le 2026$ is $R_k$ divisible by $3367$?</p>`,
      solution: R`<p><b>Answer: 337.</b></p>
<p>$9R_k = 10^k - 1$ and $\gcd(9, 3367) = 1$, so $3367 \mid R_k$ exactly when $3367 \mid 10^k - 1$, that is, $10^k \equiv 1 \pmod{3367}$.</p>
<p>$3367 = 7 \cdot 13 \cdot 37$, three primes, so by the CRT this holds exactly when $10^k \equiv 1$ mod each of $7$, $13$, $37$, that is, when each order divides $k$.</p>
<p>Mod $7$: $10 \equiv 3$, whose powers run $3, 2, 6, 4, 5, 1$, so the order is $6$. Mod $13$: $10^2 \equiv 9$ and $10^3 \equiv 90 \equiv -1$, so $10^6 \equiv 1$ while $10^1, 10^2, 10^3 \not\equiv 1$: order $6$. Mod $37$: $10^3 = 1000 = 27 \cdot 37 + 1$, and $10, 10^2 \not\equiv 1$: order $3$.</p>
<p>So the condition is $\operatorname{lcm}(6, 6, 3) = 6 \mid k$, and there are $\lfloor 2026/6 \rfloor = 337$ such $k$.</p>`},
    {id: 'inv-2', kind: 'invented', label: 'Invented 2', d: 4, area: 'nt', methods: ['modular', 'crt'], basics: ['nt-units', 'nt-crt'], hiddenOK: true,
      statement: R`<p>For how many integers $n$ with $1 \le n \le 2026$ is $2^n + n$ divisible by $7$?</p>`,
      solution: R`<p><b>Answer: 289.</b></p>
<p>$\operatorname{ord}_7(2) = 3$ (the powers run $2, 4, 1$), so $2^n \bmod 7$ depends only on $n \bmod 3$: it is $1, 2, 4$ for $n \equiv 0, 1, 2$. The other term depends on $n \bmod 7$. So the condition depends only on the pair ($n \bmod 3$, $n \bmod 7$), and by the CRT each pair occurs exactly once in every $21$ consecutive integers.</p>
<p>The condition is $n \equiv -2^n \pmod 7$. For $n \equiv 0 \pmod 3$ it reads $n \equiv 6 \pmod 7$; for $n \equiv 1$, $n \equiv 5$; for $n \equiv 2$, $n \equiv 3$. These pairs are the classes $n \equiv 6, 19, 17 \pmod{21}$.</p>
<p>$2026 = 21 \cdot 96 + 10$. The integers $1, \dots, 2016$ contain $96 \cdot 3 = 288$ solutions, and among $2017, \dots, 2026$ (residues $1$ to $10$ mod $21$) only $2022 \equiv 6$ works. Total $289$.</p>`},
    {id: 'inv-3', kind: 'invented', label: 'Invented 3', d: 4, area: 'nt', methods: ['crt', 'polynomials', 'modular'], basics: ['nt-crt', 'nt-units'], hiddenOK: true,
      statement: R`<p>How many integers $x$ with $1 \le x \le 1729$ have $x^3 - 1$ divisible by $1729$?</p>`,
      solution: R`<p><b>Answer: 27.</b></p>
<p>$1729 = 7 \cdot 13 \cdot 19$. By the CRT the count is the product of the numbers of solutions of $x^3 \equiv 1$ mod $7$, mod $13$ and mod $19$ (and $1, \dots, 1729$ is one full set of residues mod $1729$).</p>
<p>Mod a prime $p$ there are at most three solutions. If $x^3 \equiv 1$ and $x \not\equiv 1$, then $p \mid (x - 1)(x^2 + x + 1)$ gives $x^2 + x + 1 \equiv 0$ by Euclid's lemma. If $s$ and $t$ both satisfy that, then $0 \equiv (s^2 + s + 1) - (t^2 + t + 1) = (s - t)(s + t + 1)$, so $t \equiv s$ or $t \equiv -1 - s$: at most two besides $1$.</p>
<p>Three occur for each prime: mod $7$, $1, 2, 4$ ($2^3 = 8$, $4^3 = 64 = 9 \cdot 7 + 1$); mod $13$, $1, 3, 9$ ($27 = 2 \cdot 13 + 1$, $729 = 56 \cdot 13 + 1$); mod $19$, $1, 7, 11$ ($343 = 18 \cdot 19 + 1$, $1331 = 70 \cdot 19 + 1$).</p>
<p>So there are $3 \cdot 3 \cdot 3 = 27$.</p>`},
    {id: 'inv-4', kind: 'invented', label: 'Invented 4', d: 5, area: 'nt', methods: ['modular', 'bijection'], basics: ['nt-units'], hiddenOK: true,
      statement: R`<p>For how many positive integers $n$ is the decimal expansion of $1/n$ purely periodic with smallest period exactly $6$? (Purely periodic: the repeating block starts right after the decimal point, as in $1/7 = 0.\overline{142857}$.)</p>`,
      solution: R`<p><b>Answer: 53.</b></p>
<p>For $n \ge 2$, $1/n$ is purely periodic with period $k$ (not necessarily the smallest) exactly when $n \mid 10^k - 1$. If $1/n = 0.\overline{a_1 \dots a_k}$, then $10^k/n = A + 1/n$ where $A$ is the block read as an integer, so $10^k - 1 = nA$. Conversely, if $10^k - 1 = nA$, then $0 \lt A \lt 10^k$ and $1/n = A/(10^k - 1) = A(10^{-k} + 10^{-2k} + \dots)$, which repeats the $k$-digit block of $A$.</p>
<p>So such $n$ are coprime to $10$, the periods that work are the $k$ with $10^k \equiv 1 \pmod n$, which are the multiples of $\operatorname{ord}_n(10)$, and the smallest period is $\operatorname{ord}_n(10)$. Order exactly $6$ means: $n$ divides $10^6 - 1 = 999999$ but neither $10^3 - 1 = 999$ (orders $1$ and $3$) nor $10^2 - 1 = 99$ (orders $1$ and $2$).</p>
<p>$999999 = 3^3 \cdot 7 \cdot 11 \cdot 13 \cdot 37$ has $4 \cdot 2 \cdot 2 \cdot 2 \cdot 2 = 64$ divisors; $999 = 3^3 \cdot 37$ has $8$; $99 = 3^2 \cdot 11$ has $6$; the divisors of both are the divisors of $\gcd(999, 99) = 9$, which are $3$. So $64 - (8 + 6 - 3) = 53$.</p>`},
    {id: 'inv-5', kind: 'invented', label: 'Invented 5', d: 2, area: 'nt', methods: ['crt'], basics: ['nt-crt'], hiddenOK: true,
      statement: R`<p>Find the smallest positive integer $n$ such that $2$ divides $n$, $3$ divides $n + 1$, $5$ divides $n + 2$, $7$ divides $n + 3$ and $11$ divides $n + 4$.</p>`,
      solution: R`<p><b>Answer: 788.</b></p>
<p>The conditions say $n \equiv 0 \pmod 2$, $n \equiv 2 \pmod 3$, $n \equiv 3 \pmod 5$, $n \equiv 4 \pmod 7$ and $n \equiv 7 \pmod{11}$. The moduli are pairwise coprime, so by the CRT there is exactly one solution mod $2 \cdot 3 \cdot 5 \cdot 7 \cdot 11 = 2310$, and the answer is that residue.</p>
<p>Glue one modulus at a time. $n \equiv 0 \pmod 2$ and $n \equiv 2 \pmod 3$ give $n \equiv 2 \pmod 6$. Of $2, 8, 14, 20, 26$ the one that is $\equiv 3 \pmod 5$ is $8$, so $n \equiv 8 \pmod{30}$. Of $8, 38, 68, 98, 128, 158, 188$ the one that is $\equiv 4 \pmod 7$ is $158$, so $n \equiv 158 \pmod{210}$. Finally $158 \equiv 4$ and $210 \equiv 1 \pmod{11}$, so $158 + 210k \equiv 4 + k$, which is $\equiv 7$ for $k = 3$: $n = 158 + 630 = 788$.</p>
<p>Check: $788 = 2 \cdot 394$, $789 = 3 \cdot 263$, $790 = 5 \cdot 158$, $791 = 7 \cdot 113$, $792 = 11 \cdot 72$.</p>`},
    {id: 'inv-6', kind: 'invented', label: 'Invented 6', d: 3, area: 'cp', methods: ['linearity'], basics: [], hiddenOK: true,
      statement: R`<p>Twelve people sit down at random around a round table with twelve seats; six wear red and six wear blue. What is the expected number of pairs of neighbours who wear the same colour?</p>`,
      solution: R`<p><b>Answer: $60/11$.</b></p>
<p>There are $12$ pairs of neighbouring seats. For one such pair, whatever the first person wears, the second is one of the other $11$ people, $5$ of whom share that colour. So the pair matches with probability $5/11$.</p>
<p>The number of matching pairs is a sum of $12$ indicators, and expectation adds even though the indicators are dependent: $12 \cdot 5/11 = 60/11$.</p>`},
    {id: 'inv-7', kind: 'invented', label: 'Invented 7', d: 5, area: 'cp', methods: ['bijection', 'inequalities', 'construction'], basics: [], hiddenOK: true,
      statement: R`<p>Nine players play a round robin: every two of them play once, and there are no draws. Call a set of three players a <i>cycle</i> if each of the three beat exactly one of the other two. What is the largest possible number of cycles?</p>`,
      solution: R`<p><b>Answer: 30.</b></p>
<p>Count the triples that are not cycles. In a triple the three games give within-triple win counts $1, 1, 1$ (a cycle) or $2, 1, 0$; so each non-cycle has exactly one player who beat both others. Player $i$ with $w_i$ wins in total is that player for $\binom{w_i}{2}$ triples. Hence the number of cycles is $\binom{9}{3} - \sum_i \binom{w_i}{2} = 84 - \sum_i \binom{w_i}{2}$.</p>
<p>The wins add up to the number of games, $\binom{9}{2} = 36$. Now $\sum_i \binom{w_i}{2} = \tfrac12 \sum_i w_i^2 - 18$, and by Cauchy–Schwarz $\sum_i w_i^2 \ge (\sum_i w_i)^2/9 = 144$. So $\sum_i \binom{w_i}{2} \ge 54$, and there are at most $84 - 54 = 30$ cycles.</p>
<p>Equality: seat the players at positions $0, \dots, 8$ around a circle and let each one beat the next four clockwise. Every player then has $4$ wins, so there are exactly $30$ cycles.</p>`},
    {id: 'inv-8', kind: 'invented', label: 'Invented 8', d: 3, area: 'gr', methods: ['pigeonhole', 'bijection'], basics: [], hiddenOK: true,
      statement: R`<p>Ten people form eight committees of four members each. Prove that some two of the committees have at least two members in common.</p>`,
      solution: R`<p>Count pairs of people who sit on a committee together, committee by committee. Each committee contains $\binom{4}{2} = 6$ pairs, so the eight committees contain $48$ pairs, counted with repetition. There are only $\binom{10}{2} = 45$ different pairs of people, so by pigeonhole some pair appears in two different committees, and those two committees share at least those two members.</p>`},
    {id: 'inv-9', kind: 'invented', label: 'Invented 9', d: 4, area: 'gr', methods: ['invariant', 'parity', 'construction'], basics: ['nt-divisibility'], hiddenOK: true,
      statement: R`<p>A row of $2026$ lamps, numbered $1$ to $2026$, are all off. A move picks three adjacent lamps and switches each of them (off to on, on to off). For which pairs $j \lt k$ can a sequence of moves leave exactly lamps $j$ and $k$ on?</p>`,
      solution: R`<p><b>Answer: exactly when $3 \mid k - j$.</b></p>
<p><i>Necessary.</i> Sort the lamps into three classes by their number mod $3$. Three adjacent lamps contain one lamp of each class, so a move changes the number of lit lamps in every class by one: the three parities flip together. They start equal (all even), so they stay equal. If exactly lamps $j$ and $k$ are on with $j \not\equiv k \pmod 3$, two classes have an odd count and one an even count, which is impossible.</p>
<p><i>Sufficient.</i> The moves at $i$ and at $i + 1$ (lamps $i, i+1, i+2$ and lamps $i+1, i+2, i+3$) together switch exactly lamps $i$ and $i + 3$. Doing this for $i = j, j + 3, \dots, k - 3$ switches lamps $j$ and $k$ once each and every lamp in between twice, that is, not at all.</p>`},
    {id: 'inv-10', kind: 'invented', label: 'Invented 10', d: 4, area: 'gr', methods: ['inequalities'], basics: [], hiddenOK: true,
      statement: R`<p>Which is larger, $2^{100}$ or $3^{63}$? Prove your answer without computing either number.</p>`,
      solution: R`<p><b>Answer: $2^{100}$.</b></p>
<p>$3^{63} = (3^7)^9 = 2187^9$ and $2^{100} = 2 \cdot (2^{11})^9 = 2 \cdot 2048^9$, so it is enough to show $(2187/2048)^9 \lt 2$.</p>
<p>$2187/2048 = 1 + 139/2048$, and $1 + t \le e^t$, so $(2187/2048)^9 \le e^{9 \cdot 139/2048} = e^{1251/2048}$. Since $3 \cdot 1251 = 3753 \lt 4096 = 2 \cdot 2048$, the exponent is below $2/3$. Finally $e^{2/3} \lt 2$ because $e^2 \lt 8$: indeed $e \lt 2.8$ and $2.8^2 = 7.84$.</p>`},
    /* Three number theory problems a little below Putnam A1 (d 2.3 to 2.5), so the first nt picks at
       r 3 land inside the stretch band (target d 2.46, band 2.26 to 2.65). Answers checked by brute force. */
    {id: 'inv-11', kind: 'invented', label: 'Invented 11', d: 2.4, area: 'nt', methods: ['modular'], basics: ['nt-units'], hiddenOK: true,
      statement: R`<p>What are the last two digits of $7^{7^7}$? (The exponent is $7^7$, not $49$.)</p>`,
      solution: R`<p><b>Answer: 43.</b></p>
<p>$7^2 = 49$ and $7^4 = 49^2 = 2401 \equiv 1 \pmod{100}$, so the order of $7$ mod $100$ is $4$ (the powers run $7, 49, 43, 1$), and $7^k \bmod 100$ depends only on $k \bmod 4$.</p>
<p>The exponent mod $4$: $7 \equiv -1 \pmod 4$, so $7^7 \equiv (-1)^7 = -1 \equiv 3 \pmod 4$.</p>
<p>So $7^{7^7} \equiv 7^3 = 343 \equiv 43 \pmod{100}$. Euler's theorem would reduce the exponent mod $\varphi(100) = 40$ instead, which also works ($7^7 \equiv 23 \pmod{40}$ and $23 \equiv 3 \pmod 4$); the order is the shorter route.</p>`},
    {id: 'inv-12', kind: 'invented', label: 'Invented 12', d: 2.5, area: 'nt', methods: ['modular', 'crt'], basics: ['nt-units', 'nt-crt'], hiddenOK: true,
      statement: R`<p>Prove that $n^5 - n$ is divisible by $30$ for every integer $n$.</p>`,
      solution: R`<p>$30 = 2 \cdot 3 \cdot 5$, three distinct primes. It is enough to show that each of them divides $n^5 - n$: a number divisible by pairwise coprime $2$, $3$ and $5$ is divisible by their product (the CRT, or Euclid's lemma used twice).</p>
<p><i>Mod 5.</i> If $5 \nmid n$, then $\gcd(n, 5) = 1$ and Euler's theorem with $\varphi(5) = 4$ gives $n^4 \equiv 1$, so $n^5 \equiv n$. If $5 \mid n$, both sides are $0$.</p>
<p><i>Mod 3.</i> If $3 \nmid n$, then $n^2 \equiv 1$ (Euler, $\varphi(3) = 2$), so $n^5 = n \cdot (n^2)^2 \equiv n$. If $3 \mid n$, both sides are $0$.</p>
<p><i>Mod 2.</i> $n^5$ and $n$ have the same parity.</p>
<p>So $2$, $3$ and $5$ all divide $n^5 - n$, and so does $30$.</p>`},
    {id: 'inv-13', kind: 'invented', label: 'Invented 13', d: 2.3, area: 'nt', methods: ['modular', 'crt'], basics: ['nt-divisibility', 'nt-crt'], hiddenOK: true,
      statement: R`<p>For how many integers $n$ with $1 \le n \le 1000$ is $n^2 + n$ divisible by $6$?</p>`,
      solution: R`<p><b>Answer: 666.</b></p>
<p>$n^2 + n = n(n + 1)$ is a product of two consecutive integers, so it is always even. Since $\gcd(2, 3) = 1$, $6 \mid n(n + 1)$ exactly when $3 \mid n(n + 1)$, and since $3$ is prime (Euclid's lemma) that happens exactly when $3 \mid n$ or $3 \mid n + 1$, that is, $n \equiv 0$ or $2 \pmod 3$.</p>
<p>Among $1, \dots, 999$ each residue mod $3$ occurs $333$ times, and $1000 \equiv 1 \pmod 3$ adds nothing. So there are $2 \cdot 333 = 666$.</p>`},
    /* Six number theory warm-ups (d 0.8 to 1.8) for the low end of the scale: after two misses at r near 2.2 the
       eased target is d near 0.7, and once a hold ends the ease-off the band sits near d 1.5 to 2.0. With
       inv-5 (d 2) they keep eased and post-miss picks at or below the stretch target. Answers checked by brute force. */
    {id: 'inv-14', kind: 'invented', label: 'Invented 14', d: 0.8, area: 'nt', methods: ['modular'], basics: ['nt-units'], hiddenOK: true,
      statement: R`<p>What is the remainder when $3^{2026}$ is divided by $8$?</p>`,
      solution: R`<p><b>Answer: 1.</b></p>
<p>$3^2 = 9 \equiv 1 \pmod 8$, so $3^{2026} = (3^2)^{1013} \equiv 1^{1013} = 1$.</p>`},
    {id: 'inv-15', kind: 'invented', label: 'Invented 15', d: 1, area: 'nt', methods: ['modular'], basics: ['nt-units'], hiddenOK: true,
      statement: R`<p>What is the last decimal digit of $7^{2026}$?</p>`,
      solution: R`<p><b>Answer: 9.</b></p>
<p>Mod $10$ the powers of $7$ run $7, 9, 3, 1$ and then repeat, since $7^4 = 2401 \equiv 1$. So $7^k \bmod 10$ depends only on $k \bmod 4$. As $2026 = 4 \cdot 506 + 2$, $7^{2026} \equiv 7^2 = 49 \equiv 9 \pmod{10}$.</p>`},
    {id: 'inv-16', kind: 'invented', label: 'Invented 16', d: 1.2, area: 'nt', methods: ['crt'], basics: ['nt-crt'], hiddenOK: true,
      statement: R`<p>Find the smallest positive integer $x$ with $x \equiv 1 \pmod 4$, $x \equiv 2 \pmod 5$ and $x \equiv 3 \pmod 7$.</p>`,
      solution: R`<p><b>Answer: 17.</b></p>
<p>$4$, $5$ and $7$ are pairwise coprime, so by the CRT there is exactly one solution mod $140$. The numbers $\equiv 2 \pmod 5$ run $2, 7, 12, 17, \dots$, and the first that is $\equiv 1 \pmod 4$ is $17$; so the first two conditions say $x \equiv 17 \pmod{20}$. And $17 = 2 \cdot 7 + 3$ already satisfies the third, so $x \equiv 17 \pmod{140}$ and the smallest positive solution is $17$.</p>`},
    {id: 'inv-17', kind: 'invented', label: 'Invented 17', d: 1.5, area: 'nt', methods: ['crt'], basics: ['nt-crt'], hiddenOK: true,
      statement: R`<p>Find the smallest positive integer $n$ such that $6$ divides $n + 1$, $10$ divides $n + 3$ and $7$ divides $n$.</p>`,
      solution: R`<p><b>Answer: 77.</b></p>
<p>The conditions are $n \equiv 5 \pmod 6$, $n \equiv 7 \pmod{10}$ and $n \equiv 0 \pmod 7$. The moduli $6$ and $10$ are not coprime, so first check that the two conditions agree on what they share: both say $n$ is odd. Split them into prime parts: $n$ odd, $n \equiv 2 \pmod 3$ and $n \equiv 2 \pmod 5$, which together say $n \equiv 17 \pmod{30}$. (Had they disagreed mod $2$, there would be no solution.)</p>
<p>Of $17, 47, 77$, the first multiple of $7$ is $77 = 7 \cdot 11$. Check: $78 = 6 \cdot 13$ and $80 = 10 \cdot 8$.</p>`},
    {id: 'inv-18', kind: 'invented', label: 'Invented 18', d: 1.6, area: 'nt', methods: ['modular'], basics: ['nt-divisibility'], hiddenOK: true,
      statement: R`<p>For how many integers $n$ with $1 \le n \le 200$ is $n^2 + 1$ divisible by $5$?</p>`,
      solution: R`<p><b>Answer: 80.</b></p>
<p>Whether $5$ divides $n^2 + 1$ depends only on $n \bmod 5$. The squares of $0, 1, 2, 3, 4$ are $\equiv 0, 1, 4, 4, 1 \pmod 5$, so $n^2 + 1 \equiv 0$ exactly when $n \equiv 2$ or $3 \pmod 5$. Each residue occurs $40$ times among $1, \dots, 200$, so there are $80$.</p>`},
    {id: 'inv-19', kind: 'invented', label: 'Invented 19', d: 1.8, area: 'nt', methods: ['modular'], basics: ['nt-units'], hiddenOK: true,
      statement: R`<p>What is the remainder when $1 + 3 + 3^2 + \dots + 3^{2025}$ is divided by $13$?</p>`,
      solution: R`<p><b>Answer: 1.</b></p>
<p>$3^3 = 27 = 2 \cdot 13 + 1$, so mod $13$ the powers of $3$ run $1, 3, 9, 1, 3, 9, \dots$ with period $3$. The sum has the $2026$ terms $3^0, \dots, 3^{2025}$. Group them in threes from the start: each group is $\equiv 1 + 3 + 9 = 13 \equiv 0$. The $675$ groups use up $3^0, \dots, 3^{2024}$, and the one term left is $3^{2025} = (3^3)^{675} \equiv 1$.</p>`}
  ];

  /* =====================================================================================
     KATAS. Specs are exact: reset, widths, bit order and timing, checked after every rising
     edge. Skeletons hold ports only. Hidden katas never name the technique.
     ===================================================================================== */
  var katas = [
    {id: 'k-shift', title: '4-bit shift register with enable', d: 2.5, level: 'simple', hidden: false, area: 'dd',
      basics: ['dd-lfsr'], methods: ['shift'],
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['en', 'input', 1], ['din', 'input', 1], ['q', 'output', 4]],
      spec: R`<p>A 4-bit shift register with enable.</p>
<ul>
<li><code>rst</code> (synchronous, active high): on a rising edge with <code>rst</code> high, <code>q</code> becomes <code>4'b0000</code>. <code>rst</code> wins over <code>en</code>.</li>
<li><code>en</code>: on a rising edge with <code>rst</code> low and <code>en</code> high, the sampled <code>din</code> enters at bit 0, every bit moves one place toward bit 3, and the old bit 3 is lost.</li>
<li>With <code>en</code> low (and <code>rst</code> low), <code>q</code> holds.</li>
</ul>
<p>Example after reset, <code>en</code> high, <code>din</code> = 1, 0, 1, 1: <code>q</code> = 0001, 0010, 0101, 1011. Outputs are checked after every rising edge.</p>`,
      skeleton: R`// 4-bit shift register with enable
module shift4 (
  input        clk,
  input        rst,
  input        en,
  input        din,
  output [3:0] q
);

endmodule
`},
    {id: 'k-lfsr', title: '8-bit Galois LFSR, taps 0xB8', d: 3, level: 'simple', hidden: false, area: 'dd',
      basics: ['dd-lfsr'], methods: ['lfsr', 'shift'],
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['en', 'input', 1], ['seed', 'input', 8], ['state', 'output', 8], ['bit_out', 'output', 1]],
      spec: R`<p>An 8-bit Galois LFSR for x<sup>8</sup> + x<sup>6</sup> + x<sup>5</sup> + x<sup>4</sup> + 1, moving toward bit 0, tap mask <code>8'hB8</code>.</p>
<ul>
<li><code>rst</code> (synchronous, active high): on a rising edge with <code>rst</code> high, <code>state</code> takes the value on <code>seed</code>. <code>rst</code> wins over <code>en</code>.</li>
<li><code>en</code>: on a rising edge with <code>rst</code> low and <code>en</code> high, every bit of <code>state</code> moves one place toward bit 0 (bit 7 receives 0), and if the bit that left bit 0 was 1, <code>8'hB8</code> is XORed into the result. With <code>en</code> low, <code>state</code> holds.</li>
<li><code>bit_out</code> equals <code>state[0]</code> at all times.</li>
</ul>
<p>Example, seed <code>8'h01</code>, <code>en</code> high: 01, B8, 5C, 2E, 17, B3, E1, C8, 64, … From any nonzero seed the state is back at the seed after exactly 255 enabled steps. Outputs are checked after every rising edge.</p>`,
      skeleton: R`// 8-bit Galois LFSR, tap mask 8'hB8
module lfsr8 (
  input        clk,
  input        rst,
  input        en,
  input  [7:0] seed,
  output [7:0] state,
  output       bit_out
);

endmodule
`},
    {id: 'k-crc', title: 'Serial CRC-8 (0x07, init 0, MSB first)', d: 4, level: 'simple', hidden: false, area: 'dd',
      basics: ['dd-crc', 'dd-lfsr'], methods: ['crc', 'lfsr'],
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['din', 'input', 1], ['valid', 'input', 1], ['crc', 'output', 8]],
      spec: R`<p>Serial CRC-8: generator x<sup>8</sup> + x<sup>2</sup> + x + 1 (<code>8'h07</code>), initial value <code>8'h00</code>, no reflection, no final XOR.</p>
<ul>
<li>One message bit arrives on <code>din</code> at each rising edge where <code>valid</code> is high, each byte most significant bit first. Edges with <code>valid</code> low are not part of the message, and <code>crc</code> holds.</li>
<li>After the edge that accepts a bit, <code>crc</code> is the CRC of every bit accepted since the last reset.</li>
<li><code>rst</code> (synchronous, active high) starts a new message: <code>crc</code> becomes <code>8'h00</code>. <code>rst</code> wins over <code>valid</code>.</li>
</ul>
<p>Check values: the single byte <code>8'h01</code> gives <code>8'h07</code>, and the nine ASCII bytes of <code>"123456789"</code> give <code>8'hF4</code>. Outputs are checked after every rising edge.</p>`,
      skeleton: R`// Serial CRC-8
module crc8_serial (
  input        clk,
  input        rst,
  input        din,
  input        valid,
  output [7:0] crc
);

endmodule
`},
    {id: 'k-uart', title: 'UART transmitter, 8N1', d: 5, level: 'hard', hidden: false, area: 'dd',
      basics: ['dd-lfsr'], methods: ['counter', 'shift', 'fsm'],
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['start', 'input', 1], ['data', 'input', 8], ['tx', 'output', 1], ['busy', 'output', 1]],
      spec: R`<p>UART transmitter, 8N1, <code>CLKS_PER_BIT</code> = 4 clock cycles per bit.</p>
<ul>
<li>Idle: <code>tx</code> = 1, <code>busy</code> = 0.</li>
<li>A rising edge with <code>start</code> high while <code>busy</code> is 0 accepts <code>data</code>; call it edge 0. Right after edge 0, <code>tx</code> = 0 (start bit) and <code>busy</code> = 1. Right after edge 4k + 4, for k = 0 … 7, <code>tx</code> = <code>data[k]</code> (least significant bit first). Right after edge 36, <code>tx</code> = 1 (stop bit). Right after edge 40, <code>busy</code> = 0 and <code>tx</code> stays 1. Each bit lasts exactly 4 cycles; a frame lasts 40.</li>
<li><code>busy</code> is 1 right after edges 0 through 39. A <code>start</code> sampled while <code>busy</code> is 1 is ignored; that includes edge 40, so the earliest next frame is accepted at edge 41. Only the value of <code>data</code> at edge 0 matters.</li>
<li><code>rst</code> (synchronous, active high) aborts any frame: right after the edge, <code>tx</code> = 1 and <code>busy</code> = 0. <code>rst</code> wins over <code>start</code>.</li>
</ul>
<p>Outputs are checked after every rising edge.</p>`,
      skeleton: R`// UART transmitter, 8N1
module uart_tx (
  input        clk,
  input        rst,
  input        start,
  input  [7:0] data,
  output       tx,
  output       busy
);
  parameter CLKS_PER_BIT = 4;

endmodule
`},
    {id: 'k-badframe', title: 'Frame checker', d: 5.5, level: 'hard', hidden: true, area: 'dd',
      basics: ['dd-crc', 'dd-lfsr'], methods: ['crc'],
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['in_valid', 'input', 1], ['in_byte', 'input', 8], ['in_last', 'input', 1], ['frame_done', 'output', 1], ['frame_bad', 'output', 1]],
      spec: R`<p>Bytes arrive one per accepted clock edge. Flag every frame whose last byte is not the check value of the bytes before it.</p>
<ul>
<li><b>Input.</b> At each rising edge with <code>in_valid</code> high, the byte on <code>in_byte</code> is accepted. A frame is the run of accepted bytes from the first one after reset, or after the previous frame's last byte, up to and including the byte accepted with <code>in_last</code> high. Every frame has at least two bytes: one or more payload bytes, then the check byte. Edges with <code>in_valid</code> low accept nothing, and <code>in_last</code> is ignored on them.</li>
<li><b>Check value.</b> Write the payload bits in arrival order, each byte most significant bit first, as b<sub>1</sub>, b<sub>2</sub>, …, b<sub>k</sub>. Form P(x) = b<sub>1</sub>x<sup>k+7</sup> + b<sub>2</sub>x<sup>k+6</sup> + … + b<sub>k</sub>x<sup>8</sup>, with coefficients added and multiplied mod 2, and divide it by x<sup>8</sup> + x<sup>2</sup> + x + 1. The remainder c<sub>7</sub>x<sup>7</sup> + … + c<sub>1</sub>x + c<sub>0</sub> is the check value: the byte whose bit i is c<sub>i</sub>.</li>
<li><b>Output.</b> Right after the edge that accepts a frame's last byte, <code>frame_done</code> = 1, and <code>frame_bad</code> = 1 if that byte differs from the check value of the frame's payload, else 0. After every other edge both are 0. A new frame may begin at the very next edge.</li>
<li><b>Reset.</b> <code>rst</code> (synchronous, active high) drops any partial frame and sets both outputs to 0. It wins over everything else.</li>
</ul>
<p>Examples: the payload <code>8'hA5</code> has check value <code>8'h72</code>; the payload <code>8'h31 8'h32 8'h33</code> has check value <code>8'hC0</code>. Outputs are checked after every rising edge.</p>`,
      skeleton: R`// frame checker
module frame_check (
  input        clk,
  input        rst,
  input        in_valid,
  input  [7:0] in_byte,
  input        in_last,
  output       frame_done,
  output       frame_bad
);

endmodule
`},
    /* Two katas added at integration, so the kata slots can sit near the stretch band at the starting
       dd rating (r 4: target d 3.46, hidden-topic pitch d 2.46). Reference designs live in
       test/kata-solutions.txt, never in the page. */
    {id: 'k-deser', title: 'Byte deserializer', d: 3.5, level: 'simple', hidden: false, area: 'dd',
      basics: ['dd-lfsr'], methods: ['shift', 'counter'],
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['din', 'input', 1], ['valid', 'input', 1], ['byte_out', 'output', 8], ['byte_valid', 'output', 1]],
      spec: R`<p>Collect a serial bit stream into bytes.</p>
<ul>
<li>A bit is accepted from <code>din</code> at each rising edge where <code>valid</code> is high. Edges with <code>valid</code> low accept nothing. Bytes arrive most significant bit first, back to back: bits 1 to 8 after reset are the first byte, bits 9 to 16 the second, and so on.</li>
<li>Right after the edge that accepts the 8th bit of a byte, <code>byte_valid</code> = 1 and <code>byte_out</code> holds that byte. <code>byte_valid</code> is 0 after every other edge, and <code>byte_out</code> keeps the last complete byte until the next one completes.</li>
<li><code>rst</code> (synchronous, active high) drops a partial byte: right after it <code>byte_out</code> = <code>8'h00</code>, <code>byte_valid</code> = 0, and the next accepted bit is the first bit of a new byte. <code>rst</code> wins over <code>valid</code>.</li>
</ul>
<p>Example: the accepted bits 1, 0, 1, 0, 0, 1, 0, 1 give <code>byte_out</code> = <code>8'hA5</code> with <code>byte_valid</code> = 1 right after the eighth. Outputs are checked after every rising edge.</p>`,
      skeleton: R`// byte deserializer
module deser8 (
  input        clk,
  input        rst,
  input        din,
  input        valid,
  output [7:0] byte_out,
  output       byte_valid
);

endmodule
`},
    {id: 'k-pattern', title: 'Pattern flag', d: 3, level: 'simple', hidden: true, area: 'dd',
      basics: ['dd-lfsr'], methods: ['shift'],
      ports: [['clk', 'input', 1], ['rst', 'input', 1], ['din', 'input', 1], ['valid', 'input', 1], ['hit', 'output', 1]],
      spec: R`<p>Watch a bit stream for the pattern 1, 1, 0, 1.</p>
<ul>
<li>A bit is accepted from <code>din</code> at each rising edge where <code>valid</code> is high; edges with <code>valid</code> low accept nothing.</li>
<li>Right after an edge that accepts a bit, <code>hit</code> = 1 exactly when the last four bits accepted since reset are 1, 1, 0, 1, oldest first. Matches may overlap: the accepted bits 1, 1, 0, 1, 1, 0, 1 raise <code>hit</code> after the 4th and after the 7th.</li>
<li>Right after an edge with <code>valid</code> low, <code>hit</code> = 0.</li>
<li><code>rst</code> (synchronous, active high) forgets every bit accepted so far and makes <code>hit</code> 0; a match needs four bits accepted after it. <code>rst</code> wins over <code>valid</code>.</li>
</ul>
<p>Outputs are checked after every rising edge.</p>`,
      skeleton: R`// pattern flag
module pattern_flag (
  input  clk,
  input  rst,
  input  din,
  input  valid,
  output hit
);

endmodule
`}
  ];

  /* =====================================================================================
     SAMPLE PM TASKS (demo data, invented) in the ledger's line format:
     - [ ] <text> #<area> <YYYY-MM-DD> ><chain>   (! marks priority, - [x] is done)
     ===================================================================================== */
  function task(id, text, project, due, needs, status, chain, priority) {
    var line = '- [' + (status === 'done' ? 'x' : ' ') + '] ' + (priority ? '! ' : '') + text + ' #' + project + ' ' + due + (chain ? ' >' + chain : '');
    return {id: id, text: text, project: project, due: due, needs: needs, status: status, line: line, chain: chain || null, priority: !!priority};
  }
  var pmTasks = [
    task('t-nt-set', 'Number theory set: orders and CRT, five problems written up', 'putnam', '2026-11-22', ['nt-units', 'nt-crt'], 'open'),
    task('t-mock', 'Timed mock: six problems in three hours, settled the same night', 'putnam', '2026-11-28', ['nt-divisibility', 'nt-units', 'nt-crt'], 'open', null, true),
    task('t-crc-kata', 'Serial CRC-8 passes the testbench', 'asic', '2026-11-12', ['dd-crc'], 'done', 'asic-framer'),
    task('t-uart', 'UART transmitter for the debug port, 8N1', 'asic', '2026-12-06', ['dd-lfsr', 'dd-framing'], 'open', 'asic-framer'),
    task('t-prbs', 'PRBS source for the link test, 8-bit LFSR', 'asic', '2026-12-13', ['dd-lfsr'], 'open', 'asic-framer'),
    task('t-framer', 'Framer block: flag received frames whose check byte is wrong', 'asic', '2026-12-20', ['dd-crc', 'dd-framing'], 'open', 'asic-framer', true),
    task('t-tb', 'Self-checking testbench for the framer, corrupted frames included', 'asic', '2027-01-08', ['dd-crc', 'dd-lfsr'], 'open', 'asic-framer'),
    task('t-page', 'Project page: the framer, with the waveform of a caught bad frame', 'asic', '2027-01-15', [], 'open', 'asic-framer/ship')
  ];

  /* =====================================================================================
     REWRITES: what "Request rewrite" swaps in for a passage that stayed lost. Each is a whole
     element with the passage's data-a; the reader replaces the passage with it.
     ===================================================================================== */
  var rewrites = {
    'nt-moves': {
      'cue-exponent': R`<li data-a="cue-exponent"><p><b>A huge exponent, a fixed modulus.</b> When a statement asks about $a^N \bmod n$ with $N$ far too large to compute, the exponent matters only through a remainder. If $\gcd(a, n) = 1$, the powers of $a$ mod $n$ cycle from the very start with period $\operatorname{ord}_n(a)$, so $a^N \equiv a^{N \bmod \operatorname{ord}_n(a)}$ (<a class="ref" data-to="nt-units#order-thm">order</a>).</p><p>You rarely know the order in advance, but it divides $\varphi(n)$ (<a class="ref" data-to="nt-units#euler-thm">Euler</a>), so reducing $N$ mod $\varphi(n)$ is always safe, and mod the order is sharper. See the cycle once: mod $5$ the powers of $3$ run $3, 4, 2, 1, 3, 4, \dots$, period $4$. If $\gcd(a, n) \gt 1$ the powers still repeat eventually, but not from the start: split the modulus first (next cue).</p></li>`,
      'cue-split': R`<li data-a="cue-split"><p><b>A composite modulus.</b> If $n = n_1 n_2 \cdots n_k$ with pairwise coprime factors, a congruence mod $n$ holds exactly when it holds mod every $n_i$, and a residue mod $n$ carries the same information as its list of residues mod the $n_i$ (<a class="ref" data-to="nt-crt#crt">CRT</a>). So one question mod $n$ becomes $k$ smaller ones.</p><p>Split all the way to prime powers, as in $360 = 8 \cdot 9 \cdot 5$. Each piece may need a different tool (a base sharing the piece's prime is handled by hand, a unit base by its order), and one of them is often trivial. Glue at the very end, by Theorem 1 of the CRT page or by trying the few candidates.</p></li>`,
      'cue-two-periods': R`<li data-a="cue-two-periods"><p><b>Two conditions that repeat with different periods.</b> Suppose whether $n$ works depends on $n \bmod p$ through one part of the condition and on $n \bmod q$ through another. Then it depends only on the pair ($n \bmod p$, $n \bmod q$). When $\gcd(p, q) = 1$, the <a class="ref" data-to="nt-crt#crt">CRT</a> says this pair takes each of its $pq$ values exactly once in every block of $pq$ consecutive integers.</p><p>So counting the $n$ that work in a block is counting the pairs that work, and a long range is whole blocks plus a short tail. For instance, "$n$ even" and "$n \equiv 1 \pmod 3$" together say $n \equiv 4 \pmod 6$: one class in six.</p></li>`,
      'trap-cancel': R`<li data-a="trap-cancel"><p><b>Cancelling needs coprimality.</b> From $ac \equiv bc \pmod n$ you may conclude $a \equiv b \pmod n$ only when $\gcd(c, n) = 1$: then $c$ is a <a class="ref" data-to="nt-units#unit-gcd">unit</a>, and multiplying both sides by its inverse cancels it.</p><p>Otherwise the congruence only says $n \mid (a - b)c$, and part of $n$ can divide $c$ instead of $a - b$. In $4 \cdot 2 \equiv 4 \cdot 5 \pmod{12}$, the factor $4$ takes $4$ out of the $12$, and all that is left is $2 \equiv 5 \pmod 3$.</p></li>`
    },
    'dd-framing': {
      'fr-timing': R`<div data-a="fr-timing"><p><b>Bit timing by counting.</b> The clock is much faster than the bit rate, so each bit occupies $N$ = <code>CLKS_PER_BIT</code> cycles. A counter running $0, 1, \dots, N - 1, 0, \dots$ marks the cycle where one bit ends and the next begins: its wrap. A transmitter needs only that. At each wrap it moves to the next bit of the frame, for instance by moving a register that holds the frame (the <a class="ref" data-to="dd-lfsr#shift">shift register</a>), and it counts wraps to know when the frame is over.</p><p>Draw the waveform before writing code: with $N = 4$, the start bit fills the 4 cycles after the accepting edge, data bit 0 the next 4, and so on. A receiver works the other way round: from the falling edge that opens the start bit it infers the boundaries, and samples each bit near its middle, about $N/2$ cycles after a boundary.</p></div>`
    }
  };

  SR.content = {
    docs: docs,
    fog: fog,
    problems: competition.concat(invented),
    katas: katas,
    methods: methods,
    pmTasks: pmTasks,
    tests: [
      {id: 'putnam', date: '2026-12-05', track: 'putnam', label: 'Putnam 2026'},
      {id: 'asic', date: '2027-01-18', track: 'asic', label: 'ASIC competition'}
    ],
    rewrites: rewrites,
    /* extras: not required by the interface, safe to ignore */
    library: ['nt-moves', 'nt-divisibility', 'nt-units', 'nt-crt', 'dd-framing', 'dd-lfsr', 'dd-crc'],
    areas: {
      nt: {label: 'Number theory & algebra', track: 'putnam', topic: 'nt-moves'},
      cp: {label: 'Combinatorics & probability', track: 'putnam'},
      an: {label: 'Analysis', track: 'putnam'},
      lg: {label: 'Linear algebra & geometry', track: 'putnam'},
      dd: {label: 'Digital design', track: 'asic', topic: 'dd-framing'},
      gr: {label: 'General reasoning', track: 'putnam'}
    },
    labels: {model: MODEL, demo: 'Demo data', guess: "Area and methods are a model's guess."}
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SR.content;
})();

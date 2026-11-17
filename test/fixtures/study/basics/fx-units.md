---
study: basic
id: fx-units
title: Units mod n (fixture)
area: nt
needs: [fx-div]
build: 2
tracks: [putnam]
---

> Written by a model for Adit. Not Adit's words.

Needs: [Bézout](fx-div.md#^bezout) and [congruences](fx-div.md#^cong-arith). ^needs

## Units

> [!def] Unit
> An integer $a$ is a **unit** mod $n$ when $ax \equiv 1 \pmod n$ for some $x$.
^unit-def

> [!thm] Theorem 1
> $a$ is a unit mod $n$ if and only if $\gcd(a, n) = 1$.
^unit-gcd

> [!proof]- Proof (d 1.5)
> 1. If $ax \equiv 1$, then $ax - kn = 1$, so a common divisor of $a$ and $n$ divides $1$.
> 2. If $\gcd(a, n) = 1$, Bézout gives $ax + ny = 1$:
>    $$ax \equiv 1 \pmod n.$$

An ordinary paragraph with no block id, which gets a hash anchor.

## Order

> [!thm] Theorem 2 (order)
> The least $k \ge 1$ with $a^k \equiv 1$ divides every $m$ with $a^m \equiv 1$.
^order-thm

> [!proof]- Proof
> 1. Write $m = qk + r$ with $0 \le r < k$.
> 2. Then $a^r \equiv 1$, so $r = 0$ by minimality.
^p-order-thm

> [!example] Powers of 2 mod 7
> Find the order of $2$ mod $7$.
^ex-order

> [!solution]- Solution
> $2, 4, 1$: the order is $3$.

- A huge exponent and a fixed modulus: reduce through the [order](#^order-thm). ^cue-exponent
- A composite modulus: split it ([CRT](../topics/fx-topic.md#^moves)).
- An ordinary item with an [external link](https://example.org/x.pdf).

> [!derive] Prove that the order of a unit divides $\varphi(n)$.
^d-order-divides

> [!problem] Last digit (d 2.4)
> Find the last digit of $7^{2026}$.
^inv-fx-last-digit

> [!solution]- Solution
> methods: order, fx-div/cong-arith
> 1. $7^4 = 2401 \equiv 1 \pmod{10}$.
> 2. $2026 = 4 \cdot 506 + 2$, so $7^{2026} \equiv 49 \equiv 9$.
> Answer: $9$.

> [!problem] A sum of units unchecked (d 3)
> Show that the units mod $n$ sum to $0$ mod $n$ for $n > 2$.
^inv-fx-unit-sum

| a | a^-1 |
|---|---|
| 3 | 7 |
^inverse-table

$$\varphi(p) = p - 1$$
^phi-prime

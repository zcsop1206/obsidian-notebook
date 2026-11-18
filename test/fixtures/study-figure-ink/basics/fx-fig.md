---
study: basic
id: fx-fig
title: Nodal practice (figure-ink fixture)
area: el
needs: []
build: 1
---

> Written by a model for Adit. Not Adit's words.

## Two-node circuits

An invented circuit for the figure-ink checks. The figures are bare file names, as docs embed them.

> [!problem] Essential nodes (d 1.5)
> In this two-resistor circuit, mark the essential nodes and pick the reference node before you
> write any equations.
>
> ![two-resistor circuit](s13-circuit.svg)
^inv-el-nodes

> [!solution]- Solution
> methods: nodal
> 1. The bottom rail is the reference node.
> 2. One essential node sits between the two resistors.

> [!problem] Mesh loops (d 2)
> On this circuit, draw the two mesh currents you would write KVL for.
>
> ![two-mesh circuit](s13-mesh-a.svg)
^inv-el-mesh

> [!solution]- Solution
> methods: mesh
> 1. One mesh goes round each loop, both clockwise.

> [!problem] Two figures (d 1)
> Pick a reference node in each of these two circuits.
>
> ![two-resistor circuit](s13-circuit.svg)
>
> ![resistor bridge](s13-bridge.svg)
^inv-el-pair

> [!solution]- Solution
> methods: nodal
> 1. The bottom rail in the first, the bottom corner of the bridge in the second.

> [!derive] From this bridge circuit, derive the balance condition in terms of the four resistors.
>
> ![resistor bridge](s13-bridge.svg)
^d-bridge-balance

> [!solution]- Solution
> 1. Balance means no current through the middle arm, so the ratios match: R1/R2 = R3/R4.

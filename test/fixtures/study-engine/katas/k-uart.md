---
study: kata
id: k-uart
title: UART transmitter (fixture)
area: dd
needs: [fe-crc]
build: 1
d: 5.0
level: hard
---

> Written by a model for Adit. Not Adit's words.

> [!kata] UART transmitter
> Fixture spec.
^spec

```ports
input clk
input rst
output q
```

```vectors
rst | q
1 | 0
```

---
study: kata
id: k-fx
title: Toggle (fixture)
area: dd
needs: [fx-div]
build: 1
d: 1.5
level: simple
---

> Written by a model for Adit. Not Adit's words.

> [!kata] Toggle
> `q` flips on every cycle with `en` high; `rst` clears it.
^spec

```ports
input clk
input rst
input en
output reg [3:0] q
```

```skeleton
module k_fx(input clk, input rst, input en, output reg [3:0] q);
endmodule
```

```vectors
# comment line
rst en | q
1 0 | 0
0 1 | 1
0 x | x
0 1 | A
```

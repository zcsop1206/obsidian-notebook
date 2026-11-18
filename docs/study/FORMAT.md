# Study docs: the file format (study/1)

What a study doc is on disk. The plugin's study view, the content writers (people or models) and the laptop scripts all follow this file; when they disagree, this file wins and the others are fixed. Change it only through the board (`docs/study/BOARD.md`).

Design rule: **a study doc is plain markdown that reads well in Obsidian without the plugin.** Proofs and solutions sit in callouts that Obsidian folds by default, so nothing is handed over at a glance even before study mode is installed. The study view adds fog, drills, calls, marks and ink on top.

## Folder layout (in the vault)

```
study/                      the study root (a plugin setting; in the portfolio vault it is content/study/)
  README.md                 what this folder is, for a person
  tracks.md                 tracks with deadlines and weights (the owner edits it; Tracks, below)
  registry.md               every basic: id, title, area, needs, key anchors, wave (generated or written once)
  methods.md                method ids, each linked to the basic that teaches it
  basics/<id>.md            fundamentals: the only place a result is proved
  topics/<id>.md            derived docs: recognise, first moves, traps; they link basics, never re-prove them
  katas/<id>.md             design katas (digital design and others), one per file
  bank/<source>.md          competition problems by source and number only, with links; no statements
  bank/<source>.tags.md     the bank's area and method tags (hidden from the owner until a settle)
  cards/<slug>.md           numbers cards for the owner's public projects (recall drills)
  figures/<doc-id>--<slug>.svg  figures, embedded by bare file name (Figures, below)
  log/<device>.jsonl        event logs, written only by the plugin (see SPEC.md)
  ink/<doc-id>.<device>.json  ink sidecars, one per device, written only by the plugin (see SPEC.md)
```

A doc's id is its file name without `.md`. Ids are unique across the whole study root: lowercase letters, digits and hyphens, starting with a letter.

## Frontmatter

```yaml
---
study: basic            # basic | topic | kata | bank | card
id: nt-units            # equals the file name
title: Units mod n
area: nt                # rating area (table below); a topic or card may list several: [nt, alg]
needs: [nt-divisibility]  # basics this doc stands on; a basic's prerequisites, a topic's basics
build: 1                # starts at 1; every rewrite or rebuild adds 1
tracks: [putnam]        # optional: the tracks in tracks.md this doc serves
hidden: never           # optional: its problems are never hidden-topic picks (below)
---
```

The first body line is the label, exactly:

```markdown
> Written by a model for Adit. Not Adit's words.
```

(Docs Adit writes leave it out and set `by: adit` in the frontmatter.)

**`hidden: never`** in a doc's or a bank file's frontmatter keeps that file's problems out of hidden-topic picks; they stay visible picks. Use it where the file names the topic, as a course chapter's topic or a course's bank does. It applies per file: a problem checks its own doc, a bank problem its bank file, so a course topic and its bank each need it. Spell it exactly `hidden: never`; any other key or value does nothing (the scan's `--lint` warns).

## Rating areas

| id | area |
|---|---|
| nt | number theory and algebra |
| comb | combinatorics and probability |
| an | analysis and inequalities |
| la | linear algebra and geometry |
| gen | general reasoning: estimation, dimensions, limiting cases, invariants used outside math |
| dd | digital design and verification |
| ca | computer architecture and accelerators |
| th | heat transfer, thermodynamics and fluids |
| mc | mechanics of solids, dynamics, vibration and control |
| pd | precision design, metrology and measurement |
| sp | semiconductor processes, vacuum and plasma |
| op | optics and photonics |
| el | circuits, power electronics and batteries |
| mat | materials and additive manufacturing |
| qc | quantum hardware and cryogenics |
| bio | neural interfaces and implants |

Every area starts at rating 4 (number theory 3). Difficulty `d` uses the same scale (SPEC.md, Engine).

## Tracks

`tracks.md` holds one table, a row per track; the owner edits it.

```markdown
| track | deadline | weight | areas | docs |
|---|---|---|---|---|
| contest | 2026-12-05 | 3 | nt comb an | basics nt-*, comb-*; topics contest-*; bank contest |
| finals | 2026-12-10 to 2026-12-22 | 1 | th | basics th-* |
```

- `deadline` is a date, a range `a to b` (the track counts until its end), or empty. `weight` 0 pauses a track; an empty weight is 1.
- `areas` lists rating areas, split on spaces, commas or `;`.
- `docs` is `;`-separated sections, each `[folder] glob, glob`. A folder is `basics`, `topics`, `katas`, `bank` or `cards`; a glob matches doc ids (`nt-*`). A section with folders serves the docs in those folders whose id matches one of its globs, a section of folder names only serves those whole folders, and a section without a folder matches its globs in any folder. One matching section is enough.
- A track serves a doc when the doc lists it in `tracks:`, when one of the doc's areas is in `areas`, or when `docs` matches the doc.
- Today gives problem slots to a track's areas and to the areas of the docs it serves. A bank named in the `docs` column adds no areas of its own, so list its problems' areas (from its tags rows) in the `areas` column; otherwise Today picks them only through another track.

## Passages and anchors

A **passage** is one top-level markdown block: a heading, a paragraph, a whole list, a table, a display-math block, a code block, or a whole callout. Passages are separated by blank lines. Each passage is what a margin mark, a link and a stroke of ink attach to.

- A passage gets an **anchor** from a block id at its end: `^order-thm` as the last thing on its last line, or alone on the line right after a callout or table. Anchors are unique within the doc.
- Headings get the anchor `h-` + a slug of the heading text (lowercase, non-alphanumerics to `-`). Write no block id on a heading.
- A list item may carry its own block id (`- A huge exponent ... ^cue-exponent`); the list is still one passage, and each anchored item can be marked and linked on its own.
- A passage without a block id gets `p-` + the first 8 hex digits of the SHA-1 of its trimmed source. That anchor changes when the text changes, which is fine: ink on it is shown dimmed after a rewrite (SPEC.md, Ink).
- **Anchors are never renamed or deleted by a rewrite.** A retired anchor stays as a one-line passage or moves to the passage that replaced it.

Every theorem, definition, derive prompt, problem, example, cue, trap and key paragraph gets an explicit block id, so links and marks survive rewrites.

## Links

Standard markdown links, relative to the doc (wikilinks are off in this vault):

```markdown
the [order](nt-units.md#^order-thm) divides $\varphi(n)$          (basic to basic, same folder)
split the modulus ([CRT](../basics/nt-crt.md#^crt))               (topic to basic)
```

- Link to an anchor whenever one exists. A link with no `#^anchor` opens the doc at its top.
- A topic states a result in one line and links the basic that proves it. It never proves it again.
- External links (problem statements, solutions, datasheets) are ordinary `https://` links.

## Figures

- A figure is an image file in `figures/` under the study root, named `<doc-id>--<slug>.svg`: the id of the doc that uses it, two hyphens, and a short slug of what it shows (`nt-units--power-cycle.svg`).
- Embed it inside the callout that uses it, by its bare file name: `![The powers of 3 mod 7 repeat with period 6](nt-units--power-cycle.svg)`. No path, no `../`, no `![[ ]]`. Obsidian finds the file by its name anywhere in the vault, so the name must be unique there.
- The alt text says what the figure shows.
- A figure has a white background (a white rectangle under the drawing), so it reads in dark mode.
- An SVG's root `<svg>` carries `width` and `height` as absolute sizes (`480`, `480px`, `12cm`; not `%` or `em`), so the view knows its size before it loads.
- A figure that gives an answer away goes inside the folded solution, not in the statement.
- Ink on a figure is filed under its file name, so a renamed figure is a new version and its ink starts blank. Rename a figure when its drawing changes enough that old ink would mislead; otherwise edit it in place.

The laptop scan checks these rules with `--lint` and lists figures no doc embeds with `--figures` (SPEC.md, Laptop side).

## Callouts the study view understands

Callout type names are lowercase. A trailing `-` after the type folds the callout in Obsidian (`> [!proof]-`). Anything the study view does not understand renders as Obsidian renders it.

| callout | folded | what it is |
|---|---|---|
| `> [!def] Name` | no | a definition |
| `> [!thm] Theorem 2 (order)` | no | a statement only: theorem, lemma, proposition, corollary, identity, law |
| `> [!proof]- Proof` | **yes** | the proof of the `thm` callout right above it; steps are its top-level numbered items |
| `> [!example] Title` | no | an invented example; a worked answer goes in a folded `solution` right after it |
| `> [!derive] Prompt` | no | a derive prompt: a statement to prove or derive on a blank page; never a solution |
| `> [!problem] Title` | no | a problem with its statement (invented) or its reference (bank) |
| `> [!solution]- Solution` | **yes** | the solution of the `problem`, `example`, `derive` or `recall` right above it |
| `> [!recall] Prompt` | no | a recall prompt on a numbers card |
| `> [!kata] Title` | no | a design kata's spec (only in `katas/`) |
| `> [!trap] Title` | no | a common error, with the smallest counterexample |
| `> [!note]`, `> [!warning]` | either | ordinary prose |

**An item's solution comes right after it.** A worked answer is a folded `> [!solution]-` callout, and it is the next passage after the `problem`, `example`, `derive` or `recall` it solves, with only a blank line between them (the item's block id line belongs to the item). A solution is found only there: one anywhere else belongs to no item, and the scan's `--lint` reports it as an error, as it does a solution that is not folded.

### Theorem and proof

```markdown
> [!thm] Theorem 2 (order)
> Let $a$ be a unit mod $n$. Some power $a^k$ with $k \ge 1$ is $\equiv 1$; the least such $k$ is the
> **order** $\operatorname{ord}_n(a)$, and $a^m \equiv 1$ exactly when $\operatorname{ord}_n(a) \mid m$.
^order-thm

> [!proof]- Proof (d 2.5)
> 1. The powers $a, a^2, \dots$ take finitely many values mod $n$, so $a^i \equiv a^j$ for some $i < j$.
> 2. $a$ is a unit, so multiply by $a^{-i}$: $a^{j-i} \equiv 1$ with $j - i \ge 1$. Let $k$ be the least such exponent.
> 3. Write $m = qk + r$ with $0 \le r < k$. Then $a^m = (a^k)^q a^r \equiv a^r$, which is $1$ only when $r = 0$, by minimality.
^p-order-thm
```

- The `proof` belongs to the nearest `thm` above it. Its anchor is `p-` + the theorem's anchor.
- **Steps** are the callout's top-level numbered items, in order. One step is one move a reader could try to make alone: usually one sentence, at most three. A display equation inside a step is indented under its item. Fog reveals one step at a time.
- `(d 2.5)` in the title is the difficulty of proving the statement cold (Engine). Leave it out when the proof is a routine check; such a proof is still drilled, but a cold proof of it never moves a rating.
- A proof with more than 9 steps is split by a lemma (`thm` + `proof`) above it.

### Derive prompt

```markdown
> [!derive] Prove that if $\gcd(a, n) = 1$ then $\operatorname{ord}_n(a) \mid \varphi(n)$, using only Theorem 2 and Lagrange's idea of cosets.
^d-order-divides
```

A statement, never a solution and never a hint at the method beyond what the doc already taught. Each basic ends with 3 to 6 of them; they are the basic's drill items. An optional folded `solution` after a derive is allowed only in basics, and the study view hides it until a drill is graded.

### Problem (invented)

```markdown
> [!problem] Last digits (d 2.4)
> Find the last three digits of $7^{2026}$.
^inv-nt-last-digits

> [!solution]- Solution
> methods: nt-units/order-thm, nt-crt/crt
> 1. $1000 = 8 \cdot 125$, coprime, so solve mod 8 and mod 125 and glue.
> 2. ...
> Answer: $449$.
```

- The anchor is the problem's id; it is unique across the study root. Invented problems use `inv-<area>-<slug>`.
- The solution's first line `methods:` lists method ids (`methods.md`) or `basic/anchor` pairs. The study view never shows them before a settle.
- An invented problem's answer is checked numerically or symbolically by its writer before it goes in. A problem whose answer was not checked says `unchecked` in its title and never enters a pick.

### Problem (bank reference)

Bank files hold references only: no statement, no solution, no wording from the source.

```markdown
| id | source | d | statement | solutions |
|---|---|---|---|---|
| putnam-2019-a2 | Putnam 2019 A2 | 4 | [paper](https://kskedlaya.org/putnam-archive/2019.pdf) | [solutions](https://kskedlaya.org/putnam-archive/2019s.pdf) |
```

`bank/<source>.tags.md` has `| id | area | methods |` rows: a model's reading of the statement (never of a solution), labelled as such at the top. A problem without a tags row is never picked as hidden-topic.

**Using a bank problem in a doc** (a topic's Try section, a basic's problems): a `problem` callout whose title is the bank id and whose body is empty, anchored with the same id. The study view fills in the source, the links and `d` from the bank.

```markdown
> [!problem] putnam-2019-a2
^putnam-2019-a2
```

Difficulty by position: Putnam A1/B1 3, A2/B2 4, A3/B3 5.5, A4/B4 6.5, A5/B5 8, A6/B6 9.5 (old shape; 2026 sessions: first of a session 3.5, second 5.5, third 8 until the real spread is known). USAJMO P1/P4 4, USAMO P1/P4 6, P2/P5 8, IMO P1/P4 6, P2/P5 8, P3/P6 9.5.

### Kata

A kata file holds one kata: the spec, the ports, a skeleton, and test vectors. Never a reference design.

````markdown
---
study: kata
id: k-uart-tx
title: UART transmitter
area: dd
needs: [dd-serial, dd-fsm]
build: 1
d: 3
level: simple            # simple (inline in a basic or topic) | hard (push mode) | hidden (topic never shown)
---

> Written by a model for Adit. Not Adit's words.

> [!kata] UART transmitter, 8N1
> Send `data` as one 8N1 frame when `start` is high for one cycle while `busy` is low. ...
^spec

```ports
input clk
input rst
input start
input [7:0] data
output tx
output busy
```

```skeleton
module k_uart_tx(input clk, input rst, input start, input [7:0] data, output reg tx, output reg busy);
  // your design
endmodule
```

```vectors
rst start data | tx busy
1 0 00 | 1 0
0 1 a5 | 1 1
0 0 00 | 0 1
...
```
````

- **Vectors, exactly.** The first non-comment line names the input columns, a `|`, then the output columns; every name is a port from `ports` except `clk`, which is implicit. Each later line is one clock cycle: the inputs are applied, one rising edge of `clk` happens, then the outputs are sampled and compared. Values are hexadecimal without a prefix (one digit or more, sized by the port's width); `x` means don't care. Lines starting with `#` are comments. A run stops at the first mismatch and reports the cycle (1-based line count after the header), the signal, the expected and the actual value.
- Vectors are generated from a reference model the writer keeps outside the vault, and checked by running a reference design through an interpreter before they go in. The study view's Verilog-subset interpreter runs the owner's design against them.
- `level: hidden` katas never show their title or `needs` before a settle; the spec is written so it does not name the technique.

### Numbers card

```markdown
> [!recall] CACT: the chamber's thermal resistance at the highest power you measured, with its units and the uncertainty.
^n1

> [!solution]- Answer
> ... (taken from the public project page, with its section named)
```

A card has five numbers, three decisions ("A over B because C") and one failure, each as a `recall` + folded `solution`, taken only from the owner's public project page. A card never states a number the page does not.

## Topics (derived docs)

A topic has these sections, as `##` headings, in this order, and nothing else of substance:

1. **Recognise**: cues in a statement and where each points; one anchored list item per cue, each linking a basic.
2. **First moves**: the opening moves, as an anchored numbered list.
3. **Traps**: `trap` callouts, each with the smallest counterexample.
4. **Where it hides**: problems from other areas this topic carries (names only, no hints).
5. **Try**: 2 to 6 `problem` callouts or bank ids, easiest first.

A topic proves nothing a basic proves. A "bridge lemma" no basic holds may be stated and proved in a topic, at most two per topic.

## What a writer must never do

- Copy a statement, solution or sentence from a book, paper or competition. Competition problems appear by source and number only. Examples and invented problems are invented.
- Put a method name, hint or tag where the owner sees it before a settle: problem titles name the object, not the technique.
- Prove a result in two places. Link the basic instead.
- Rename or delete an anchor in a rewrite.
- Write in `log/`, `ink/` or the owner's calls ledger.
- Embed a figure by path or with `![[ ]]`.
- Leave a solution unfolded or away from its item.

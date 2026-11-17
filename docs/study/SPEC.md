# Study mode: spec for 0.15

Written by a model for Adit. Not Adit's words. The file format is [FORMAT.md](FORMAT.md); the work is split into tickets on [BOARD.md](BOARD.md). The demo in `lab/study-reader/` is the reference implementation of most behaviour here: Adit tried it on 2026-11-15 and said the linked reader was "quite close" to what they wanted. Where this spec is silent, do what the demo does; where they differ, this spec wins.

## Goal and dates

Study notes on the iPad that teach without spoonfeeding: linked theory docs with the Pencil on the page, proofs under fog, drills from a blank page, problems that ask for a call first, design katas, and a schedule that keeps the fundamentals fresh toward real deadlines.

| date | what |
|---|---|
| 2026-11-17 | foundation on `study-mode`: FORMAT, SPEC, types, parser and index with tests, wiring stubs |
| 2026-11-22 | S2 to S9 merged into `study-mode` |
| 2026-11-24 | 0.15.0-beta released from `study-mode` for Adit's iPad check |
| 2026-11-28 | 0.15.0 on `main`, used for the Putnam mock that day |
| 2026-12-01 to 12-05 | **freeze**: no release (Putnam is 12-05; nothing may break the week before) |
| after 12-05 | 0.16: Map ties into the task ledger, peeks of other docs' figures, kata waveform, polish from use |

**Slip rule:** Putnam never depends on the plugin. The docs are plain markdown with folded proofs, so they read in Obsidian without study mode.

## Decisions (made 2026-11-17 on Adit's instruction "use your best judgement")

1. **Hidden-topic difficulty is adaptive.** A hidden-topic problem is harder than its rating says, because naming the method is part of the work. The engine aims the *overall* chance of success at the stretch target: it picks d so that `p_id * E(d, r) = 0.65`, where `p_id` is the smoothed rate of naming the method right on hidden settles, `(hits + 3) / (n + 4)` over the last 20. So `E_hidden = clamp(0.65 / p_id, 0.65, 0.88)` and `d = r + 2 log10(1/E_hidden - 1)`. With no data, `p_id = 0.75`, `E = 0.87`, `d = r - 1.63` (the demo used a fixed `r - 1.54`; the design text said `r - 1`). As Adit gets better at naming methods, hidden problems approach the plain stretch band.
2. **Theorem hooks count, at half weight.** At push level 3 a basic's theorem is posed as a problem before its proof shows. Settling it moves the basic's stage (as in the demo) and also the area rating, with K = 0.3 instead of 0.6, using the proof's `(d x)`. A proof without `(d x)` moves no rating. Reason: a cold proof is the zero-shot skill being trained, but its difficulty is a model's guess, so it moves the rating half as far.
3. **General-reasoning problems no longer dead-end.** Hidden picks may come from area `gen` (estimation, dimensions, limiting cases, induction, extremal, pigeonhole, invariants). Their methods link `methods.md`, which links the basics `found-induction`, `comb-invariants`, `gen-estimation` and `gen-dimensions`, so a settle always shows where the method is taught.
4. **Markdown, not LaTeX and PDF.** Docs are markdown (FORMAT.md) rendered by Obsidian's own renderer, so math, links and callouts work everywhere, the laptop needs no TeX build, diffs are readable, and anchors are block ids that survive rewrites. The design doc's PDF pipeline is dropped. The old teach PDFs stay as they are.
5. **Rewrites happen on the laptop.** The plugin enforces the ration and records requests; `/teach` on the laptop reads them and rewrites the passage (or rebuilds the whole basic), bumping `build:`. A request is answered when the doc's `build` is higher than the request's and the anchor's text hash changed.
6. **The ration.** A `lost` mark on a passage of a basic (a fundamental) asks for a rebuild of the whole basic at once. Anywhere else it first shows the scaffold: the basics the passage rests on with their stages, and an attempt box. A rewrite becomes requestable only after 24 hours *and* ink in the attempt box; each doc has 3 rewrites per build cycle (the count resets when a rebuild lands); when they are gone, the mark offers a drill on the weakest linked basic instead.
7. **Real clock.** No simulated days in the product; the demo's clock and buttons sit behind the `devTools` setting.
8. **Build on `main`.** Study mode touches `src/main.ts` (one line), `styles.css` (its own section) and new files under `src/study/`. The six open ink PRs (#74 to #79) stay as they are.
9. **Calls in problems are ink plus a confidence chip.** No typing on the iPad. `calls.md` stays Adit's typed ledger for builds; problem calls live in the event log.

## Architecture

```
src/study/
  types.ts          shared types (contract; change only through the board)
  context.ts        StudyContext and settings (contract)
  index.ts          registerStudy(plugin): builds the context, calls each module's register(ctx)
  format/           parser, index builder, sha1 (done, S1)
  content/loader.ts vault -> ContentIndex, lazy, rebuilt on change (done, S1; S3 may extend)
  store/events.ts   event logs (S2)
  engine/           rules: ratings, stages, push, picks, triage, rations, Today (S2)
  view/             the study view: rendering, anchors, links, back, peek, tabs, marks UI (S3, S5)
  ink/              anchored ink on docs and in blocks (S4)
  blocks/           fog and drill (S6), problem (S7), kata UI (S9), recall (S6)
  kata/             Verilog-subset interpreter and vector runner (S9)
  panels/           Today and Map (S8)
```

One rule lives in one place: the engine owns stages, ratings, push levels, picks, rations and budgets; the view and blocks only display and call it.

## Storage

All under the study root, synced like any vault file. **Each device writes only its own files**, so sync never has to merge one file from two devices.

**Event logs**: `log/<device>.jsonl`, one `StudyEvent` (types.ts) per line, append-only, never edited. Ids are `<device>-<ms base36>-<4 random base36>`; times are ISO with the device's offset. The store reads every `log/*.jsonl`, skips lines it cannot parse (and counts them), dedupes by id, and sorts by `t` then `id`. Append uses `adapter.append` (create the file when missing). A log that grows past 5 MB starts `log/<device>-2.jsonl`.

**Ink**: `ink/<doc-id>.<device>.json`:

```json
{"v": 1, "doc": "nt-units", "strokes": [
  {"id": "s-k3f2a9", "p": [[x, y, pressure, t], ...], "t0": 1763400000000,
   "at": {"a": "order-thm", "dy": 31.5, "rev": "9f2c11ab", "v": 2}, "e": 0, "blk": null}
]}
```

Coordinates are paper px (the doc is laid out 800 px wide, then scaled to the screen). `at.a` is the nearest anchored passage at or above the stroke's centre, `at.dy` that passage's top in paper px when the stroke was written (the stroke draws at `p.y + top(now) - dy`), `at.rev` the passage hash then, `at.v` the build. A device's file may also hold `hide: ["<dev>:<id>"]` and `keep: {"<dev>:<id>": "<rev>"}`, which record deleting or keeping another device's strokes without writing that device's file. `e` is the number of fog reveals at the time of writing (provenance colour). `blk` names a block's own canvas (`fog:<proof>`, `call:<problem>`, `attempt:<anchor>`, `kata:<id>`) or null for the doc's page ink. A device shows the union of every device's ink file for the doc and edits only its own (undo removes only its own strokes).

**On a new build** (the doc's `build` differs from a stroke's `at.v`): a stroke whose anchor still exists follows it; if the anchor's hash changed, it is drawn at 35% opacity with a "changed" chip offering keep or delete; a stroke whose anchor is gone goes to an "Orphaned ink" strip at the end of the doc, labelled with the old anchor. Nothing is ever deleted without a tap.

## Engine (S2)

Port `lab/study-reader/src/engine.js` and its 81 tests (`lab/study-reader/test/engine.test.mjs`) to TypeScript, as a fold over `(ContentIndex, StudyEvent[], now)`. Keep its constants and pure rules (`expected`, `dForE`, `rateUpdate`, `nextStage`, `intervalFor`, `priority`, `eligiblePush`, `nextPush`, `scoreFor`, `kataScore`, `fogGrade`, `isHiddenSlot`) and change only what the Decisions say:

- Areas come from content (FORMAT.md's table), not a fixed list. Start ratings: 4, number theory 3.
- Hidden-topic d per Decision 1; `methodAccuracy` returns `p_id`.
- Theorem hooks per Decision 2.
- Rations per Decision 6; requests and answers per Decision 5. `budget(doc)` counts `rewrite-request` events since the doc's last rebuild landed.
- Stages start at 1 for every basic Adit has opened, 0 for one never opened, and move only by drills, fog results, hooks and held problems (at most once a day per basic, as in the demo).
- Deadlines come from `tracks.md` (`ContentIndex.tracks`); a basic's deadline is the nearest deadline of a track whose `docs` pattern matches it (`nt-*` style globs) or whose `areas` include its area. Weight 0 tracks are ignored.
- Today: drills ranked by deadline then overdue days, two to four by the minutes setting; problem slots as the demo (three per live area, so the count varies; stretch, every third slot hidden in push areas, one reach after three clean holds); one kata slot when the `asic` track is live.
- No simulated clock except an injected `now` for tests and `devTools`.

## The study view (S3 to S5)

Opens by command "Open study" (library), by "Open as study doc" in a study doc's file menu, by `obsidian://notebook?study=<id>&a=<anchor>`, and from links, Today and Map. View type `notebook-study`. Layout: the doc at 800 paper px scaled to the view width (max 1.4x), a 120 px right margin for marks and ink, header with Library, tabs (at most 6, the active one kept in view), Back, Today, Map, Changes.

Rendering: each passage is rendered on its own with `MarkdownRenderer.render` into `<div class="sr-passage" data-a="<anchor>">`, so anchors map to DOM exactly. Passages with a `block` get their block mounted instead (blocks/). Anchored list items get `data-a` on their `<li>` after rendering. The label passage renders as a small grey byline.

Input rules (as the demo, and the reason the Pencil feels right):
- The Pencil writes everywhere on the page, including over links and formulas, and never follows a link there. In panels, sheets and blocks' buttons it taps like a finger.
- A finger tap follows a link (under 10 px and 300 ms); a finger hold of 450 ms peeks; a finger drag scrolls. Fingers never draw.
- Margin dot per passage (and per anchored item): tap for lost / easy / forgot / clear. Two taps to mark, one to clear.
- Back restores the scroll position; following a link flashes the target passage.

Peek: a popover with the target passage rendered (never a fogged proof, a problem's solution or a hidden pick's topic).

Marks and triage (S5): on `lost`, call `engine.triage` and act on the result exactly as the demo's reader does for `rebuild-basic`, `scaffold`, `eligible`, `budget-exhausted`, plus `requested` (show "Rewrite requested <time>; /teach on the laptop will answer it"). Log the `mark` event (and `rewrite-request` / `rebuild-request` on the two taps). A `rewrite-request` carries `rev`, the passage hash when asked. A rebuild of a linked basic asked from another doc logs `a` as `<doc>#<anchor>` (the passage where Adit was lost); it is answered when that basic's rebuild lands. One tap on a marked dot clears it.

Changes panel: the doc's build, the rewrite budget, pending requests, the doc's marks, and the doc's `## Changes` section if it has one.

## Blocks (S6, S7, S9)

As the demo's block-fog.js, block-drill.js, block-problem.js and block-kata.js, reading their data from the parsed doc instead of `SR.content`:

- **Fog** (proof callouts): push 0 one step per reveal, each reveal after 3 new strokes in the block; push 1 chunks; push 2 cold (blank-page drill of the theorem); push 3 a hook (problem-first, Decision 2). Ink after a reveal draws in the after-reveal colour. A clean proof collapses the text and shows "yours". Logs `fog`.
- **Drill** (derive prompts, and cold proofs): blank-page canvas, Done after 3 strokes, then the steps or solution, then clean / shaky / failed. Replay with stall markers. Logs `drill`.
- **Recall** (numbers cards): the prompt, a canvas, Show after 3 strokes, then clean / shaky / failed. Logs `drill` with `src: 'recall'`.
- **Problem**: the statement (or the bank reference with its links), a call band where ink comes first and the confidence chips (50 to 90, and "-") unlock after ink, a timer, then held / missed / blind / moot (two taps), then two tick lists (methods called, methods used, from `methods.md` and the solution) and the solution. Hidden picks show "?" for the topic until the called ticks are confirmed, and tick lists label methods by title, never by doc. Logs `call` then `settle`; a settled session with no ticks shows its tick step again on the next open, with "Skip ticks" (logs empty lists). Today and Map open a problem in a standalone view (`notebook-study-problem`, `ctx.ui.openProblem`) that never shows its doc; its ink is filed under `ink/problems.<device>.json`, keys `call:<id>` and `work:<id>`.
- **Kata**: design call (sketch + confidence) before the editor; the editor; Run executes the vectors (FORMAT.md semantics) in the interpreter and shows the first mismatch; settle; ticks (or "Skip ticks"). Logs `kata` when the ticks are saved, retrying on the next open if the write failed.

## Today and Map (S8)

**Today**: the date, the nearest deadline with days left, the drills (2 to 4), the problem and kata slots (hidden ones show "?"), what was settled today, and pending rewrite requests. Each row opens its doc or block in one tap.

**Map**: the basics graph from `needs` (fill = stage, ring = push level), ratings per area with sparkline and the stretch band, method accuracy, and each track with its deadline and the weak basics blocking it. The task-ledger tie-in waits for 0.16.

## Laptop side (S10)

- `scripts/study-scan.mjs` (in this repo, runs with node on the laptop): reads a vault's `study/log/*.jsonl` and the docs, and prints open lost marks, pending rewrite and rebuild requests with the passages' source, and settled calls since a date. `/teach` uses it.
- `/teach` v2 (a Claude Code skill in the portfolio repo): for each pending request, rewrite the passage (or rebuild the basic from its prerequisites), keep every anchor, bump `build:`, add a line to the doc's `## Changes`. It never writes in `log/` or `ink/`.

## Testing

- Unit tests (`test/unit/study-*.test.ts`, node:test, run by `npm run test:unit`): parser (done), engine (ported from the demo's 81), event store against a fake adapter, interpreter and vectors, triage flows.
- View tests (Playwright on the mock harness, like run_view_test.py, all in `npm test`): `test/run_study_test.py` (the view on the real plugin: library, links, back, peek, Pencil over links, tabs, page ink, marks over the engine, Today and Map; then S5 and S8 on a mock context), `test/run_study_ink_test.py` (anchored ink), `test/run_study_blocks_test.py` (fog, drill, recall, problem and the standalone problem view), `test/run_study_kata_test.py` (the kata block on an invented kata).
- Real content: `test/run_study_content_check.py` with `STUDY_CONTENT_DIR` set opens every doc of a real study folder, Today and Map, and fails on a console error or a doc with missing passages. The folder is read into the mock vault in memory; it is never copied into the repo.
- Every PR: `npm run build` and `npm run test:unit` pass; the PR says which iPad checks it needs.

## iPad checks for 0.15.0 (Adit)

1. Open the library, open a basic, follow a link with a finger, come back.
2. Write over a link with the Pencil: it writes, it does not follow.
3. Mark a passage lost in a topic: the scaffold shows; in a basic: a rebuild is requested.
4. Reveal a fogged proof step after three strokes.
5. Start Today's problem: ink, confidence, settle, ticks.
6. Run a kata to its first mismatch.
7. Close Obsidian, reopen: ink, marks and settles are all still there; after a sync the laptop's `study-scan` lists the mark.

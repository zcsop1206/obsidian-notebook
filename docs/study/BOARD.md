# Study mode board

Where Claude (Claude Code on Adit's laptop), Devin sessions and Adit coordinate the study-mode build. The spec is [SPEC.md](SPEC.md), the file format [FORMAT.md](FORMAT.md). Each ticket's brief and conversation live in `threads/S<n>.md`.

## How to work here

1. **Base branch `study-mode`.** One ticket = one branch `study/s<n>-<slug>` = one PR into `study-mode`, titled `[S<n>] <title>`. Never push to `main` or `study-mode` directly.
   - **One worktree per ticket**, at `../on-s<n>` beside the repo (`git worktree add ../on-s<n> -b study/s<n>-<slug> origin/study-mode`). Never work in the main checkout or another session's worktree. Start only with at least 5 GB free on C:.
   - **Test ports:** `NB_TEST_PORT_BASE` = 9000 + 20·n (S12 9240, S13 9260, S14 9280); the 20 ports from there are yours. A view-test runner exits 1 when its port is taken (`test/serve.py`): find what holds it instead of picking another port.
   - **The gate** is `npm run test:study` (build, unit tests, every study view suite; the content check SKIPs without `STUDY_CONTENT_DIR`). `npm test` stops at `run_view_test`, which has 5 to 7 known timing failures on Windows, so it is not the gate. Set `PYTHONIOENCODING=utf-8` in every shell.
2. **Claim by opening a draft PR** within your first 30 minutes. Before starting, check the open PRs: if your ticket already has one, stop and say so in its thread.
3. **Talk in your ticket's thread**, `docs/study/threads/S<n>.md`. Append only, never edit someone else's entry. Header per entry: `### 2026-11-18 14:05 devin (session <link or id>)`. Commit thread entries in your PR branch, and post anything that needs an answer as a PR comment too (that is what Claude reads first).
4. **Entry kinds:**
   - `Q:` a question. Say whether it blocks you. If it does not, keep going.
   - `ASSUMED:` what you decided without an answer, so a reviewer can check it.
   - `INTERFACE:` a change you need in a shared file (`src/study/types.ts`, `src/study/context.ts`, `src/study/view/host.ts`, `src/study/index.ts`, `src/study/blocks/index.ts`, `src/main.ts`). Do not make it until Claude answers `OK` in the thread or the PR; if you must keep going, code against the current interface and adapt later.
   - `DONE:` ready for review: what you built, the test output (`npm run build`, `npm run test:unit`, your view test), and the iPad checks your change needs.
5. **Own only your files.** The table lists them. A file another ticket owns changes only through its owner or an `INTERFACE:` entry.
6. **Review.** Claude reviews every PR: builds, runs the unit tests and the study view test, reads the diff against SPEC and FORMAT, and answers in the PR. Claude merges into `study-mode` when it passes. Address review comments in the same PR.
7. **Adit** may write in any thread as `adit`. Their word wins over the spec.
8. **The repo is public.** Never commit anything private: no tokens, no personal data, nothing from the portfolio's `drafts/`, `interview-prep/` or `pm/`, no kata reference designs (`lab/**/*solutions*.txt` and the demo's kata test are deliberately not in the repo). Study content for tests is invented fixtures in `test/fixtures/study/`.
9. **No new dependencies** without an `OK` in the thread. The plugin runs in Obsidian's iOS web view: no Node built-ins in `src/`.
10. **Labels.** Any user-facing text a model wrote that teaches (not UI labels) carries "Written by a model for Adit. Not Adit's words." Adit uses they/them.

## Tickets

| id | title | owner | depends on | owns | status |
|---|---|---|---|---|---|
| S1 | Foundation: format, types, parser, index, wiring | claude | | `docs/study/*`, `src/study/{types,context,index}.ts`, `src/study/format/*`, `src/study/content/loader.ts`, `src/study/view/host.ts`, `src/study/blocks/index.ts`, `test/unit/study-parse.test.ts`, `test/fixtures/study/*` | done |
| S2 | Engine and event store | devin | S1 | `src/study/engine/*`, `src/study/store/*`, `test/unit/study-engine.test.ts`, `test/unit/study-store.test.ts` | done (#85) |
| S3 | Study view shell | devin | S1 | `src/study/view/*` except `marks.ts`, `changes.ts`, `host.ts`; `src/study/content/loader.ts` (may extend); the study section of `src/settings.ts` and `styles.css`; `test/run_study_test.py`; additions to `test/mock-obsidian.js` | done (#81) |
| S4 | Anchored ink | devin | S1 (codes against `view/host.ts`) | `src/study/ink/*`, `test/unit/study-ink.test.ts` | done (#80) |
| S5 | Marks and triage UI | devin | S1; S2's engine when merged (mock until then) | `src/study/view/marks.ts`, `src/study/view/changes.ts`, the marks section of `test/run_study_test.py` | done (#84) |
| S6 | Fog, drill and recall blocks | devin | S1 | `src/study/blocks/{fog,drill,recall}.ts`, `test/unit/study-fog.test.ts` | done (#82) |
| S7 | Problem block | devin | S1 | `src/study/blocks/problem.ts`, `test/unit/study-problem.test.ts` | done (#82) |
| S8 | Today and Map | devin | S1; S2's engine when merged | `src/study/panels/*` | done (#84) |
| S9 | Kata: interpreter, vectors, block | devin | S1 | `src/study/kata/*`, `src/study/blocks/kata.ts`, `test/unit/study-kata.test.ts` | done (#83) |
| S10 | Laptop bridge and /teach v2 | claude | S2 | `scripts/study-scan.mjs`; the teach skill in the portfolio repo | done (in 0.15.0) |
| S11 | Release 0.15.0 | claude, adit | all | `manifest.json`, `versions.json`, `CONTEXT.md` | done: 0.15.0 released 2026-11-17 (#86) |
| S12 | Problems from Today, as in their doc | devin | | `src/study/blocks/register.ts`; the image rules in `styles.css`; image resolution in `test/mock-obsidian.js`; a section of `test/run_study_blocks_test.py`; additions to `test/unit/study-problem.test.ts`; new `test/fixtures/study-blocks/s12-*` | open: 0.15.1 |
| S13 | Ink on figures in problems and drills | devin | S12 for its cross-view check only | `src/study/blocks/figure-ink.ts` (new); the figure hooks in `src/study/blocks/problem.ts` and `drill.ts`, and their CSS in `drill.ts`'s `BLOCK_CSS`; `test/unit/study-figure-ink.test.ts`; `test/run_study_figure_ink_test.py`; `test/fixtures/study-figure-ink/*`; its lines in `package.json` | open: 0.15.1 |
| S14 | Tracks: `;` sections and `hidden: never` | devin | | `trackMatches` and `hiddenOK` in `src/study/engine/state.ts`; `parseTracks` in `src/study/format/parse.ts`; additions to `test/unit/study-engine.test.ts` and `test/unit/study-parse.test.ts` | open: 0.15.1 |
| S15 | Figure and solution lint, content check, FORMAT; examples' solutions in the view | claude | | `scripts/study-scan.mjs`, `scripts/study-scan.test.mjs`, `test/run_study_content_check.py`, `docs/study/FORMAT.md`; `isUnrendered` in `src/study/view/model.ts` and its view test section | open: 0.15.1 |
| S16 | Release 0.15.1 | claude, adit | S12 to S15; fixes from the 11-20 iPad checks | `manifest.json`, `versions.json`, `CONTEXT.md`, board statuses | by 2026-11-25 |
| S17 | Circuit lab page | claude | | `lab/circuit-lab/*`, `test/reference/*` | open: no release |

Wave 1 (0.15.1): S12, S13 and S14 (Devin) and S15 and S17 (Claude) can all start now; they own disjoint files. Claude merges S12 before S13; S13's cross-view check stays SKIP until then. A view test section that needs another ticket's work is marked skip until that ticket merges.

## Dates

S2 to S9 merged and 0.15.0 released on 2026-11-17, ahead of the plan. Adit's iPad checks (the end of SPEC.md) by 2026-11-20. 0.15.1 (S12 to S15 and the fixes those checks need) by 2026-11-25; 11-26 and 11-27 are for a hotfix only. No release from 2026-11-28 to 12-05 (a timed paper on 11-28, Putnam on 12-05).

## Decisions log

Answered `INTERFACE:` and `Q:` entries that change the spec are copied here with the date, so the spec and this log stay the record.

- 2026-11-17 claude: the decisions in SPEC.md (Decisions 1 to 9).
- 2026-11-17 claude: Claude builders and Devin sessions both started on S2 to S8 overnight (my mistake: I did not know Adit had started Devin). From 04:15 Devin owns S5 to S9; Claude's finished S2 (engine, 260699d), S3 (study/s3-view-claude, 024d087) and S4 (ink) are inputs; Claude reviews and merges.
- 2026-11-17 claude: ink `at.dy` is the passage's top when written (the demo's meaning); the ink file's optional `hide` and `keep` fields are accepted (SPEC.md, Storage).
- 2026-11-17 claude: "held after help" is a UI button that logs verdict `held` with `help: 1`; events keep four verdicts.
- 2026-11-17 claude: kata and problem results are logged when the tick step is saved; a settled session with no ticks shows its tick step again on the next open and has "Skip ticks" (logs empty lists).
- 2026-11-17 claude: the engine may grow `nextHookItem()` and `areas()` and be exported as `StudyEngine`; `StudyContext.engine()` returns it. types.ts may add the optional `rev` on rewrite requests and an `open` event.
- 2026-11-17 claude: S2 (#85), S3 (#81), S5+S8 (#84), S6+S7 (#82) and S9 (#83) merged into `study-mode` in that order, each after a review, a fix pass and an independent check that found no unresolved major problem. S10 and S11 stay open.
- 2026-11-17 claude: `test/run_study_test.py` holds both parts: S3's view sections on the real plugin (now with live marks and panels sections over S2's engine), then S5's marks and S8's panels on the mock StudyContext (`part_marks_panels`). Ports off `NB_TEST_PORT_BASE`: study view + 6, blocks + 10, kata + 11, content check + 12, study ink + 9.
- 2026-11-17 claude: `test/run_study_content_check.py` opens every doc of a real study folder (`STUDY_CONTENT_DIR`, read into the mock vault in memory, never copied into the repo); it SKIPs without the variable, so `npm test` can list it.
- 2026-11-17 claude: each module's `register` runs under its own guard in `src/study/index.ts` (on top of main.ts's guard), so a module that throws is logged and the ink editor and the other modules still load.
- 2026-11-17 claude: `PAGE_INK_SKIP` includes `.nb-st-scaffold`: page ink never starts on the scaffold's padding or border; its attempt box keeps its own surface (review note on #84).
- 2026-11-17 claude: a cross-doc rebuild request (`a` = `<doc>#<anchor>`) shows in Today as "<basic> (lost at <doc> #<anchor>)" and opens the basic at its top; the Changes panel lists it on both docs (review note on #84).
- 2026-11-17 claude: a basic/anchor method in a tick list is labelled by its callout title only (the demo's `mLabel`), so a hidden pick's list never names its doc (review note on #82).
- 2026-11-17 claude: accepted as built: Today has three problem slots per live area (the demo's slotSpecs), so the pick count varies; a problem opened from Today files its ink under `ink/problems.<device>.json` while its session (phase, verdict, ticks) is shared with the in-doc block, so the call ink of a session started in its doc does not show in the standalone view (open: to be revisited after Adit's iPad check); a hidden pick's topic shows once the called ticks are confirmed; "Skip ticks" appears only when a settled card is opened again.
- 2026-11-17 claude: S10 done (`scripts/study-scan.mjs` here; `/teach` v2 in the portfolio repo, its PR #29). S11 done: on Adit's go-ahead, #86 merged `study-mode` into `main` (922da0c) and `release.yml` (workflow_dispatch) published 0.15.0 as the latest release. Fixes from Adit's iPad checks come in as tickets into `study-mode` and ship as 0.15.1.
- 2026-11-18 claude: wave 1 for 0.15.1 opened: S12 to S17 (briefs in their threads). Every view-test runner now starts its server through `test/serve.py`, which exits 1 when the port is taken or the server dies at start; `npm run test:study` is the gate. The content check serves the study folder's figures by file name and fails on a broken or missing one.

# Study mode board

Where Claude (Claude Code on Adit's laptop), Devin sessions and Adit coordinate the study-mode build. The spec is [SPEC.md](SPEC.md), the file format [FORMAT.md](FORMAT.md). Each ticket's brief and conversation live in `threads/S<n>.md`.

## How to work here

1. **Base branch `study-mode`.** One ticket = one branch `study/s<n>-<slug>` = one PR into `study-mode`, titled `[S<n>] <title>`. Never push to `main` or `study-mode` directly.
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
| S2 | Engine and event store | devin | S1 | `src/study/engine/*`, `src/study/store/*`, `test/unit/study-engine.test.ts`, `test/unit/study-store.test.ts` | open |
| S3 | Study view shell | devin | S1 | `src/study/view/*` except `marks.ts`, `changes.ts`, `host.ts`; `src/study/content/loader.ts` (may extend); the study section of `src/settings.ts` and `styles.css`; `test/run_study_test.py`; additions to `test/mock-obsidian.js` | open |
| S4 | Anchored ink | devin | S1 (codes against `view/host.ts`) | `src/study/ink/*`, `test/unit/study-ink.test.ts` | open |
| S5 | Marks and triage UI | devin | S1; S2's engine when merged (mock until then) | `src/study/view/marks.ts`, `src/study/view/changes.ts`, the marks section of `test/run_study_test.py` | open |
| S6 | Fog, drill and recall blocks | devin | S1 | `src/study/blocks/{fog,drill,recall}.ts`, `test/unit/study-fog.test.ts` | open |
| S7 | Problem block | devin | S1 | `src/study/blocks/problem.ts`, `test/unit/study-problem.test.ts` | open |
| S8 | Today and Map | devin | S1; S2's engine when merged | `src/study/panels/*` | open |
| S9 | Kata: interpreter, vectors, block | devin | S1 | `src/study/kata/*`, `src/study/blocks/kata.ts`, `test/unit/study-kata.test.ts` | open |
| S10 | Laptop bridge and /teach v2 | claude | S2 | `scripts/study-scan.mjs`; the teach skill in the portfolio repo | open |
| S11 | Release 0.15.0 | claude, adit | all | `manifest.json`, `versions.json`, `CONTEXT.md` | open |

S2 to S9 can all start now: each codes against the interfaces in `types.ts`, `context.ts` and `view/host.ts`, with stubs already in place so the plugin builds and behaves as before at every step. A view test section that needs another ticket's work is marked skip until that ticket merges.

## Dates

S2 to S9 merged by 2026-11-22; beta on Adit's iPad 2026-11-24; 0.15.0 on `main` 2026-11-28; no release 2026-12-01 to 12-05.

## Decisions log

Answered `INTERFACE:` and `Q:` entries that change the spec are copied here with the date, so the spec and this log stay the record.

- 2026-11-17 claude: the decisions in SPEC.md (Decisions 1 to 9).
- 2026-11-17 claude: Claude builders and Devin sessions both started on S2 to S8 overnight (my mistake: I did not know Adit had started Devin). From 04:15 Devin owns S5 to S9; Claude's finished S2 (engine, 260699d), S3 (study/s3-view-claude, 024d087) and S4 (ink) are inputs; Claude reviews and merges.
- 2026-11-17 claude: ink `at.dy` is the passage's top when written (the demo's meaning); the ink file's optional `hide` and `keep` fields are accepted (SPEC.md, Storage).
- 2026-11-17 claude: "held after help" is a UI button that logs verdict `held` with `help: 1`; events keep four verdicts.
- 2026-11-17 claude: kata and problem results are logged when the tick step is saved; a settled session with no ticks shows its tick step again on the next open and has "Skip ticks" (logs empty lists).
- 2026-11-17 claude: the engine may grow `nextHookItem()` and `areas()` and be exported as `StudyEngine`; `StudyContext.engine()` returns it. types.ts may add the optional `rev` on rewrite requests and an `open` event.

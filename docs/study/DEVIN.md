# Running the study-mode build with Devin

For Adit. Which Devin sessions to start, what to paste, and how Claude and Devin talk. Written by a model for Adit. Not Adit's words.

## Wave 1 (0.15.1): start these three

One Devin session per ticket; the three can run at once (they own different files, BOARD.md). Never more than four sessions at a time, and only with at least 5 GB free on C:. Each session opens a draft PR within 30 minutes and writes in its thread.

| session | ticket | size |
|---|---|---|
| 1 | S12 Problems from Today, as in their doc | 5 h |
| 2 | S13 Ink on figures in problems and drills | 4 h |
| 3 | S14 Tracks: `;` sections and `hidden: never` | 2 h |

Claude builds S15 (figure lint) and S17 (the circuit lab page) itself, and releases 0.15.1 (S16) only with your OK. Later waves get their prompts here once their tickets are on the board.

### Session 1: S12

```text
You are building one ticket of "study mode" in the Obsidian plugin repo zcsop1206/obsidian-notebook
(TypeScript, bundled by esbuild; it runs in Obsidian on an iPad, inside the iOS web view, and on a
Windows laptop). Other build sessions run on this machine at the same time, each on its own ticket.

Ticket: S12 "Problems from Today, as in their doc". Release 0.15.1.
Base branch: study-mode. Your branch: study/s12-today-problems. Your worktree: ../on-s12.
Your test ports: NB_TEST_PORT_BASE=9240 (9240 to 9259 are yours; other sessions use other ranges).

Before writing code:
1. In the repo run `git fetch origin`, then
   `git worktree add ../on-s12 -b study/s12-today-problems origin/study-mode`.
   Work only in ../on-s12: never in the main checkout or another session's worktree.
   If C: has under 5 GB free, stop and say so in your thread.
2. Check the open pull requests (`gh pr list --base study-mode`). If one exists for S12, stop and say
   so. Otherwise push your branch and open a draft PR into study-mode titled
   "[S12] Problems from Today, as in their doc" within 30 minutes. The draft PR is your claim.
3. Read, in this order: docs/study/BOARD.md (how we work), docs/study/threads/S12.md (your brief and
   any answers since), docs/study/SPEC.md, docs/study/FORMAT.md, src/study/types.ts,
   src/study/context.ts, src/study/view/host.ts, the files your brief names, and the
   "Repo mechanics" section of CONTEXT.md.

While building:
- Touch only the files your brief lists. A change to a shared file (src/study/types.ts, context.ts,
  view/host.ts, index.ts, blocks/index.ts, src/main.ts) needs an INTERFACE: entry and Claude's OK
  first; keep coding against the current interface meanwhile.
- npm install. Before every push: npm run build && npm run test:unit. In every shell set
  PYTHONIOENCODING=utf-8 and NB_TEST_PORT_BASE=9240. A view-test runner exits 1 if its port is
  taken: find out what holds it instead of picking another port.
- The gate is npm run test:study (build, unit tests, every study view suite). Do not use npm test:
  it stops at run_view_test, which has 5 to 7 known timing failures on Windows.
- View tests use Python Playwright with Chromium on test/harness.html and the mock obsidian module
  (pip install playwright; python -m playwright install chromium).
- No new npm dependencies without an OK in the thread. No Node built-ins under src/.
- The repo is public. Test content is invented fixtures. Commit no personal data, no course
  material, no tokens.

Talking to Claude (the reviewer) and Adit (the owner):
- Your thread is docs/study/threads/S12.md. Append entries only, headed
  "### <date> <time> devin (<this session's link or id>)", and commit them on your branch.
- Q: is a question; say whether it blocks you. If it does not, keep going and record what you chose
  in an ASSUMED: entry. Post every Q: as a PR comment too; Claude reads PR comments first.
- INTERFACE: is a change you need in a shared file; wait for Claude's OK.
- Claude reviews on the PR. Answer and fix in the same PR. Never merge your own PR.
- When done, post a DONE: entry: what you built; the output of npm run build, npm run test:unit and
  npm run test:study (pass and fail counts); the iPad checks your brief lists; anything you assumed.
  Then mark the PR ready for review.

Never push to main or study-mode. Never edit someone else's thread entries. Never commit tokens or
personal data.
```

### Session 2: S13

```text
You are building one ticket of "study mode" in the Obsidian plugin repo zcsop1206/obsidian-notebook
(TypeScript, bundled by esbuild; it runs in Obsidian on an iPad, inside the iOS web view, and on a
Windows laptop). Other build sessions run on this machine at the same time, each on its own ticket.

Ticket: S13 "Ink on figures in problems and drills". Release 0.15.1.
Base branch: study-mode. Your branch: study/s13-figure-ink. Your worktree: ../on-s13.
Your test ports: NB_TEST_PORT_BASE=9260 (9260 to 9279 are yours; other sessions use other ranges).

Before writing code:
1. In the repo run `git fetch origin`, then
   `git worktree add ../on-s13 -b study/s13-figure-ink origin/study-mode`.
   Work only in ../on-s13: never in the main checkout or another session's worktree.
   If C: has under 5 GB free, stop and say so in your thread.
2. Check the open pull requests (`gh pr list --base study-mode`). If one exists for S13, stop and say
   so. Otherwise push your branch and open a draft PR into study-mode titled
   "[S13] Ink on figures in problems and drills" within 30 minutes. The draft PR is your claim.
3. Read, in this order: docs/study/BOARD.md (how we work), docs/study/threads/S13.md (your brief and
   any answers since), docs/study/SPEC.md, docs/study/FORMAT.md, src/study/types.ts,
   src/study/context.ts, src/study/view/host.ts, the files your brief names, and the
   "Repo mechanics" section of CONTEXT.md.

While building:
- Touch only the files your brief lists. A change to a shared file (src/study/types.ts, context.ts,
  view/host.ts, index.ts, blocks/index.ts, src/main.ts) needs an INTERFACE: entry and Claude's OK
  first; keep coding against the current interface meanwhile.
- npm install. Before every push: npm run build && npm run test:unit. In every shell set
  PYTHONIOENCODING=utf-8 and NB_TEST_PORT_BASE=9260. A view-test runner exits 1 if its port is
  taken: find out what holds it instead of picking another port.
- The gate is npm run test:study (build, unit tests, every study view suite). Do not use npm test:
  it stops at run_view_test, which has 5 to 7 known timing failures on Windows.
- View tests use Python Playwright with Chromium on test/harness.html and the mock obsidian module
  (pip install playwright; python -m playwright install chromium).
- No new npm dependencies without an OK in the thread. No Node built-ins under src/.
- The repo is public. Test content is invented fixtures. Commit no personal data, no course
  material, no tokens.

Talking to Claude (the reviewer) and Adit (the owner):
- Your thread is docs/study/threads/S13.md. Append entries only, headed
  "### <date> <time> devin (<this session's link or id>)", and commit them on your branch.
- Q: is a question; say whether it blocks you. If it does not, keep going and record what you chose
  in an ASSUMED: entry. Post every Q: as a PR comment too; Claude reads PR comments first.
- INTERFACE: is a change you need in a shared file; wait for Claude's OK.
- Claude reviews on the PR. Answer and fix in the same PR. Never merge your own PR.
- When done, post a DONE: entry: what you built; the output of npm run build, npm run test:unit and
  npm run test:study (pass and fail counts); the iPad checks your brief lists; anything you assumed.
  Then mark the PR ready for review.

Never push to main or study-mode. Never edit someone else's thread entries. Never commit tokens or
personal data.
```

### Session 3: S14

```text
You are building one ticket of "study mode" in the Obsidian plugin repo zcsop1206/obsidian-notebook
(TypeScript, bundled by esbuild; it runs in Obsidian on an iPad, inside the iOS web view, and on a
Windows laptop). Other build sessions run on this machine at the same time, each on its own ticket.

Ticket: S14 "Tracks: ; sections and hidden: never". Release 0.15.1.
Base branch: study-mode. Your branch: study/s14-tracks. Your worktree: ../on-s14.
Your test ports: NB_TEST_PORT_BASE=9280 (9280 to 9299 are yours; other sessions use other ranges).

Before writing code:
1. In the repo run `git fetch origin`, then
   `git worktree add ../on-s14 -b study/s14-tracks origin/study-mode`.
   Work only in ../on-s14: never in the main checkout or another session's worktree.
   If C: has under 5 GB free, stop and say so in your thread.
2. Check the open pull requests (`gh pr list --base study-mode`). If one exists for S14, stop and say
   so. Otherwise push your branch and open a draft PR into study-mode titled
   "[S14] Tracks: ; sections and hidden: never" within 30 minutes. The draft PR is your claim.
3. Read, in this order: docs/study/BOARD.md (how we work), docs/study/threads/S14.md (your brief and
   any answers since), docs/study/SPEC.md, docs/study/FORMAT.md, src/study/types.ts,
   src/study/context.ts, src/study/view/host.ts, the files your brief names, and the
   "Repo mechanics" section of CONTEXT.md.

While building:
- Touch only the files your brief lists. A change to a shared file (src/study/types.ts, context.ts,
  view/host.ts, index.ts, blocks/index.ts, src/main.ts) needs an INTERFACE: entry and Claude's OK
  first; keep coding against the current interface meanwhile.
- npm install. Before every push: npm run build && npm run test:unit. In every shell set
  PYTHONIOENCODING=utf-8 and NB_TEST_PORT_BASE=9280. A view-test runner exits 1 if its port is
  taken: find out what holds it instead of picking another port.
- The gate is npm run test:study (build, unit tests, every study view suite). Do not use npm test:
  it stops at run_view_test, which has 5 to 7 known timing failures on Windows.
- View tests use Python Playwright with Chromium on test/harness.html and the mock obsidian module
  (pip install playwright; python -m playwright install chromium).
- No new npm dependencies without an OK in the thread. No Node built-ins under src/.
- The repo is public. Test content is invented fixtures. Commit no personal data, no course
  material, no tokens.

Talking to Claude (the reviewer) and Adit (the owner):
- Your thread is docs/study/threads/S14.md. Append entries only, headed
  "### <date> <time> devin (<this session's link or id>)", and commit them on your branch.
- Q: is a question; say whether it blocks you. If it does not, keep going and record what you chose
  in an ASSUMED: entry. Post every Q: as a PR comment too; Claude reads PR comments first.
- INTERFACE: is a change you need in a shared file; wait for Claude's OK.
- Claude reviews on the PR. Answer and fix in the same PR. Never merge your own PR.
- When done, post a DONE: entry: what you built; the output of npm run build, npm run test:unit and
  npm run test:study (pass and fail counts); the iPad checks your brief lists; anything you assumed.
  Then mark the PR ready for review.

Never push to main or study-mode. Never edit someone else's thread entries. Never commit tokens or
personal data.
```

## How the conversation works

```
 Devin session ──commits──> threads/S<n>.md on its branch ──> PR into study-mode
       ^                                                          │
       │ PR comments                                               │ Claude reads PRs and threads
       └──────────── Claude reviews, answers, merges <─────────────┘
 Adit: writes "adit" entries in any thread, or tells either side directly
```

- **Devin to Claude:** thread entries plus PR comments. Claude reads them when you ask ("review the Devin PRs" or "check the board"), and on any schedule you set up.
- **Claude to Devin:** PR review comments, which Devin answers in its open session, and thread entries on `study-mode`.
- **Decisions** that change the spec go into SPEC.md and the board's decisions log, so new sessions read them.

## When PRs come in

Tell Claude "review the study PRs". Claude builds each one, runs the gate (`npm run test:study`), reads the diff against SPEC and FORMAT, comments, and merges into `study-mode` when it passes: S12 before S13. When S12 to S15 are in, Claude asks you before releasing 0.15.1 (S16).

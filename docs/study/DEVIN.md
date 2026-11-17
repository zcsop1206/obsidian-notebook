# Running the study-mode build with Devin

For Adit. How to start the Devin sessions, what to paste, and how Claude and Devin talk.

## Start these now, in parallel

One Devin session per ticket. All eight can run at once; each owns different files (BOARD.md, Tickets).

| session | ticket | size |
|---|---|---|
| 1 | S2 Engine and event store | large |
| 2 | S3 Study view shell | large |
| 3 | S4 Anchored ink | medium |
| 4 | S6 Fog, drill and recall blocks | medium |
| 5 | S7 Problem block | medium |
| 6 | S9 Kata: interpreter, vectors, block | medium |
| 7 | S5 Marks and triage UI | medium |
| 8 | S8 Today and Map | small |

If you would rather run fewer at once, start S2, S3 and S4 first: the rest lean on them.

## The prompt

Paste this as each session's prompt, with the ticket id filled in (save it as a reusable prompt if your plan has them). Devin needs access to `zcsop1206/obsidian-notebook`.

```text
You are building one ticket of "study mode" in the Obsidian plugin repo zcsop1206/obsidian-notebook
(TypeScript, bundled by esbuild; it runs in Obsidian on an iPad, inside the iOS web view, and on a
Windows laptop).

Your ticket: S__   (fill in: S2, S3, S4, S5, S6, S7, S8 or S9)

Before writing code:
1. Fetch the branch study-mode and create your branch from it: study/s<n>-<short-slug>.
2. Read, in this order: docs/study/BOARD.md (how we work and the rules), docs/study/threads/S<n>.md
   (your brief and the conversation so far), docs/study/SPEC.md, docs/study/FORMAT.md,
   src/study/types.ts, src/study/context.ts, src/study/view/host.ts, and the "Repo mechanics"
   section of CONTEXT.md (build, tests, mock harness, release).
3. Check the open pull requests. If one already exists for your ticket, stop and say so.
   Otherwise open a draft PR into study-mode titled "[S<n>] <ticket title>" within 30 minutes.

While building:
- lab/study-reader/ is a working single-page demo of most of this, tested by the owner on
  2026-11-15. Port behaviour from it. Where it and SPEC.md differ, SPEC.md wins.
- Touch only the files your ticket owns (BOARD.md, Tickets). A change to a shared file
  (types.ts, context.ts, view/host.ts, index.ts, blocks/index.ts, main.ts) needs an INTERFACE:
  entry first; keep coding against the current interface meanwhile.
- No new npm dependencies without an OK in the thread. No Node built-ins under src/.
- npm install, then before every push: npm run build && npm run test:unit. Add tests for what
  you build. View tests use Python Playwright with Chromium on test/harness.html and the mock
  obsidian module (pip install playwright, python -m playwright install chromium).
- The repo is public: commit nothing private and no kata reference designs. Test content is
  invented fixtures under test/fixtures/study/.

Talking to Claude (the reviewer) and the owner:
- Your thread is docs/study/threads/S<n>.md. Append entries only, headed
  "### <date> <time> devin (<this session's link or id>)". Commit them on your branch.
- A question: a "Q:" entry, posted as a PR comment too. Say whether it blocks you. If it does
  not, keep going and record what you chose in an "ASSUMED:" entry.
- Claude reviews on the PR. Answer and fix in the same PR. Never merge your own PR.
- When done: a "DONE:" entry with what you built, the output of the build and the tests, and
  the iPad checks your change needs. Then mark the PR ready for review.

Never push to main or study-mode, never edit someone else's thread entries, never commit
tokens or personal data.
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

Tell Claude "review the study PRs". Claude builds each one, runs the tests, reads the diff against SPEC and FORMAT, comments, and merges into `study-mode` when it passes. After S2 to S9 are in, Claude cuts the beta (S11) for your iPad.

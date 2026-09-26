# Context for working on this repo

Read this first. It records what the plugin is for, what has been decided, what exists, and what comes next. Update it when a decision changes.

## Goal

An engineering notebook kept on an iPad in Obsidian, synced through GitHub, and published as part of a portfolio site (`zcsop1206/EngineeringPortfolio`, Astro, deployed to GitHub Pages on push to `main`).

The notebook should record work as it happens (dated entries, sketches, measurements, recordings, decisions), not only finished writeups. The site shows both.

This repo is the Obsidian plugin that makes the iPad side work: handwriting and audio recording. GitHub sync is a separate plugin in its own repo (see Decisions). Everything either plugin produces is plain files in the vault, readable without the plugin.

The end state: every device (iPad and laptop now, others later) holds a copy of the portfolio and can update it. The laptop uses plain git from a terminal or IDE; the sync plugin exists for devices where that isn't possible.

## Constraints

- Development happens on Windows. No Mac, so no Xcode, no native iOS app, no PencilKit.
- The owner will not pay for Working Copy.
- The owner does not want Obsidian Git. It crashed and hung Obsidian on his laptop. The laptop vault then sat inside an Astro project, next to `.astro/` and `node_modules/.vite` caches.
- Everything runs inside Obsidian's iOS web view (WKWebView): web APIs only, no Node modules (`fs`, `child_process`) on mobile.
- The notebook repo is public by default. Anything sensitive needs a deliberate escape hatch (see below).

## Decisions made

| Decision | Choice | Why |
|---|---|---|
| Ink tool | Obsidian plugin, not a native app | No Mac needed; writes straight into the vault; same code on laptop and iPad |
| Plugin delivery to iPad | BRAT (installs from this repo's GitHub releases) | Free, standard for unreleased plugins, updates automatically |
| Sync | Through the GitHub REST API | No `.git` on the iPad, no full history download, no Working Copy, no Obsidian Git |
| Where sync lives | A separate plugin with its own repo, not part of this one | It's a different job from ink and audio, and it's what lets any future device update the portfolio; it releases and is tested on its own |
| Sync plugin platforms | Only needs to work on mobile (iPad now) | The laptop and any machine with a terminal use plain git |
| Laptop sync | Plain git in a terminal or IDE, no Obsidian plugin | Avoids the hangs seen before |
| Audio | Robust recording wanted; audio synced to ink is NOT needed | Owner's call |
| Notebook visibility | Public by default | Owner's call |
| Portfolio site | Leaving Starlight for plain Astro | Owner agreed; separate work in the portfolio repo |

## Proposed, not yet confirmed

- **Ink file format:** one SVG per page.
  - Each stroke is a filled path whose width follows pressure.
  - Raw points are stored inside `<metadata>` as JSON (`format: notebook-ink/0`, strokes of `[x, y, pressure, ms]`).
  - An inner `<style>` switches the fill for `prefers-color-scheme: dark`.
  - Paper (grid, dots) is drawn by whatever displays the page, never stored in the file.
  - Why SVG: it renders in Obsidian, on GitHub and on the site with no converter, and a native app could read the same files later.
- **Vault layout:**
  ```
  projects/<slug>/index.md        writeup
  projects/<slug>/log/YYYY-MM-DD.md
  projects/<slug>/ink/  media/
  notebook/                       entries not tied to a project
  templates/
  ```
  Entry frontmatter: `date`, `project`, `type` (log / test / decision / sketch), `publish`.
- **Private escape hatch:** a `private/` folder, gitignored in the public repo and synced as its own small private repo.
- **Audio:** kept out of the public repo by default, because of size (about 43 MB per hour at 96 kbps) and other people's voices. A clip is published on purpose.
- **Links:** Obsidian wikilinks turned off, standard markdown links used, so the site needs no link-rewriting step.
- **Where the vault lives:** not decided. The Working Copy link assumption (vault = repo root) no longer applies. With API sync, the plugin could sync a vault to any repo and path. The goal of each device holding the portfolio and updating it points toward syncing with the portfolio repo itself (the whole repo, or a notebook folder inside it) rather than a separate notebook repo the site pulls in at build time, but this isn't settled.

## What exists now (0.0.1, the spike)

A throwaway plugin, id `notebook-spike`, to measure whether the plugin approach holds up on the iPad before building the real thing. Plain CommonJS in `main.js`, no build step. It writes only under `_spike/` in the vault.

- **View:** ribbon pencil icon or command "Open pen and audio test".
  - Graph-paper canvas with Clear, Save page and Record buttons, and an on-screen readout.
  - The readout shows: last pointer type, pressure, tilt, altitude and azimuth; median move events/s and samples/s over the last 10 strokes; median handler delay; whether coalesced and predicted events exist; cancelled strokes, ignored finger touches and pen hover events.
  - Handler delay is `performance.now() - event.timeStamp`: the OS-to-JavaScript part only, not pen-to-glass latency.
- **Input handling:**
  - Pen and mouse draw, touch is ignored (palm rejection).
  - Coalesced events are used when available.
  - `touch-action: none`, plus `preventDefault` and `stopPropagation` on `touchstart`/`touchmove`, so Pencil drags don't scroll, select text or open Obsidian's sidebars.
- **Save page:** writes `_spike/ink-<stamp>.svg` in the format above, cropped to the ink with a 12 px margin. It also appends measurements to `_spike/_results.md`.
- **Recording:**
  - `MediaRecorder` at 96 kbps, preferring `audio/mp4` (iOS), then webm or ogg, with a 2 s timeslice.
  - Each chunk is written to disk as it arrives, through a serial write queue. If `adapter.appendBinary` exists (Obsidian 1.12.3+), chunks are appended to `audio-NN.<ext>`; otherwise they go to `parts-NN/00001.bin`… and are merged on stop.
  - On `visibilitychange` back to visible: if the mic track ended, reopen the mic and start a new segment; if the recorder stopped, start a new segment. A mic muted for over 3 s while visible also triggers a reopen.
  - Tries to hold a screen wake lock.
  - Logs to `_spike/rec-<stamp>/_log.md`: device, format, mic settings, app hidden/visible, pagehide, freeze, mute/unmute/ended, late chunks (over 3.5 s apart), wake lock, a summary every minute. `meta.json` holds the format.
  - **Recovery:** on layout ready, any `rec-*` folder whose log lacks "session stopped" has its parts merged, and the log is marked "recovered after unclean exit".
- **Why `_` prefixes:** every `.md` the spike writes starts with `_`, so the portfolio's Astro content loader (`**/[^_]*.md`) would skip them if the vault ever sat inside it.

### Verified so far

**On the iPad (owner, 2026-09-26):** the test protocol ran and the basic functions all work inside Obsidian's iOS web view: Pencil drawing, saving a page and audio recording. The plugin approach holds up, so the go/no-go in Next steps step 1 is a go. The measured numbers (`_spike/_results.md`, `_log.md`) haven't been recorded here yet; add them when available, especially:
- real Pencil sample rate and delay;
- whether `getCoalescedEvents` exists in Obsidian's web view;
- whether Safari's MediaRecorder honours the timeslice;
- whether a truncated mp4 plays after recovery;
- what happens to the mic on screen lock and app switch;
- whether the wake lock is allowed.

In headless Chromium, through `test/run_spike_test.py`:
- Synthetic pen strokes, a finger touch, a tap and a real mouse stroke all draw.
- The saved SVG renders in light and dark, and stroke end caps round outward (checked zoomed in).
- A recording with a simulated app hide, killed mic and return produced two segments that decode to 6.5 s and 4.7 s.
- With `appendBinary` removed, a simulated crash left parts that recovery merged into a file decoding to 6.1 s.

### iPad test protocol (owner ran this; rerun after changes that affect ink or audio)

1. Install via BRAT (`zcsop1206/obsidian-notebook`), enable Notebook spike.
2. Write a paragraph fast; write with the palm resting on the screen; Save page.
3. Record 2 min, stop, play back.
4. Record, lock the screen 30 s, unlock, stop.
5. Record, switch apps 30 s, return, stop.
6. Record, force-quit Obsidian, reopen, play the recovered file.
7. Send back `_spike/_results.md` and the `_log.md` files (pasted text or screenshots), plus a subjective comparison of pen feel against Notability.

## Next steps

1. **Read the iPad results.** Done: the basics work, so building continues. Still record the measured numbers (see Verified so far), since they shape the ink and audio work.
2. **GitHub API sync, as its own plugin and repo:** the first real feature, because everything else depends on it. It doesn't exist yet; this design moves to the new repo's context file once it's created. It only needs to run on mobile, since the laptop uses plain git. Design:
   - A fine-grained personal access token with Contents read/write on one repo, entered by the owner in plugin settings, stored in plugin data.
   - Config: repo, branch, and the vault subfolder that maps to the repo path.
   - State: the last synced commit SHA, plus each file's blob SHA at that commit.
   - **Pull:** compare the last synced commit to the branch head (`GET /repos/{o}/{r}/compare/{base}...{head}`, or a tree diff), then download changed blobs.
   - **Push:** local changes are files whose content hash differs from the recorded blob SHA (git blob SHA-1 = `sha1("blob <len>\0" + bytes)`). Create blobs, a tree with `base_tree`, and a commit, then update the ref. If the ref moved, pull first and retry.
   - **Conflicts:** if a file changed on both sides, keep both (`name (iPad).md`) and show a notice. Never silently overwrite.
   - Deletes and renames need explicit handling and tests.
   - Never block the editor: async with a concurrency cap, visible progress, cancellable. Only sync note and attachment extensions, and respect an ignore list that includes `.obsidian/workspace*.json` and audio.
   - Test hard against a throwaway repo before it touches real notes. The laptop can run it for testing (Obsidian desktop or the headless harness) even though it isn't needed there day to day.
   - It must not fight plain git on the laptop: both sides push ordinary commits to the same branch, so the laptop just pulls before working and pushes after.
3. **Ink:**
   - The real page view: continuous vertical scroll, fixed page width, paper templates.
   - Tools: pen, highlighter, stroke eraser, lasso-move, hold-to-straighten line, pasted photos.
   - Stroke smoothing with pressure-shaped outlines (for example the approach of `perfect-freehand`).
   - Embed in notes by linking the SVG.
4. **Audio:** turn the spike recorder into a feature, shaped by what the iPad test shows about backgrounding.
5. **Later ideas:**
   - CI transcription of ink pages to searchable text and alt text.
   - Replaying stroke timestamps on the site.
   - Using git history as the notebook's dated, tamper-evident record.

## Repo mechanics

- **Files:** `main.js`, `manifest.json`, `styles.css`, `versions.json` at the root. No build step yet; add esbuild + TypeScript when the code outgrows one file. Typings: `https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts`.
- **Release:** bump `version` in `manifest.json` and add it to `versions.json`, commit, then push a tag equal to the version. `.github/workflows/release.yml` checks the tag matches the manifest and attaches the three files to a release. BRAT picks it up.
- **Test:** `python test/run_spike_test.py` needs Python Playwright with its bundled Chromium. It serves the repo root on port 8765 and loads `test/harness.html`. The harness provides a mock `obsidian` module: `Plugin`, `ItemView`, `Notice`, an in-memory `vault.adapter` with the `appendBinary` path, and Obsidian's DOM helpers. Chromium runs with a fake mic. Screenshots and the exported SVG go to `test/out/` (gitignored). The mock covers only the API surface the spike uses; extend it as the plugin grows.
- **Obsidian API notes:** `DataAdapter.appendBinary` exists only from 1.12.3, so feature-detect it. Views use `ItemView`, opened with `workspace.getLeaf('tab').setViewState(...)`. On mobile, `Platform.isIosApp` and friends are available.

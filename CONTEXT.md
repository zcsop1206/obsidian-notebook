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

- **Ink file format:** decided in outline, specified in issue #3 (which wins over anything here). One SVG per page; a note is a markdown index (frontmatter plus one standard markdown image embed per page) and a folder of page SVGs.
  - Each stroke is a filled path whose width follows pressure. Raw points live in `<metadata>` as JSON (`notebook-ink/1`; the spike wrote `notebook-ink/0`) and are the source of truth.
  - An inner `<style>` switches default black ink and template lines for `prefers-color-scheme: dark`.
  - **Templates are stored in the page file** (owner, 2026-09-26): a `<g id="template">` layer holds the lines, grid, dots or PDF page image, so a page looks the same in Obsidian, on GitHub and on the site. The earlier idea of leaving paper out and letting each viewer draw it is dropped.
  - File size is not a constraint for now: images and PDF page images are embedded in the page SVG at full resolution.
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

## What exists now (0.4.0: the ink editor, M1 in progress)

The plugin is **Notebook**, id `notebook`: a TypeScript project under `src/`, built to `main.js` by esbuild (see Repo mechanics). Up to 0.0.2 it shipped as the throwaway spike, id `notebook-spike`, which measured whether the plugin approach holds up on the iPad; the spike's view and recorder live on as the **ink debug view** (described further down).

### The ink editor (issues #3, #4, #19, #5, #6, #7, #8 merged)

- **Notes:** a markdown index with `ink: 1`, `paper`, `template` frontmatter plus one standard image embed per page, and a folder of page SVGs (`p-` + 6 hex). Format `notebook-ink/1` in `src/format/` (see issue #3 and the module headers). Pages render in Obsidian reading view, on GitHub and in browsers without the plugin (owner-verified on the iPad, 0.2.0).
- **Ink view** (`src/ink/`): markdown files with `ink:` frontmatter open in it through a reversible patch of `WorkspaceLeaf.prototype.setViewState`; "Open as markdown" switches back. "New ink note" (ribbon pencil, command) asks for a name, paper and template. Pages stack centred at fitted width; one bitmap per page, only pages near the viewport rendered, page metadata parsed lazily (a 20-page, 6,000-stroke note opens in about 120 ms in Chromium). Autosave 2 s after the last change, at once on close or hide, through the vault API; changes on disk reload the file or keep unsaved work with a notice.
- **Templates:** blank, lined (college/wide, optional margin), grid (5 mm, ¼ in), dots (5 mm), per page, changeable for one page or all; default template and paper in settings.
- **Pen:** uniform nib (default, pressure-independent) and pressure nib (square-root curve), same perfect-freehand outline live and saved, predicted tail, once-per-frame drawing with a bounded per-frame cost. WebKit repeats already-delivered samples in `getCoalescedEvents()`; the pen drops samples older than the last one taken. Stylus drags never scroll the view; fingers scroll natively.
- **Highlighter:** constant width, flat ends, own colours (5) and sizes (2), drawn under the ink, composited once at 0.4 so crossings don't darken.
- **Stroke eraser:** whole strokes, 2 sizes, a 32 px grid spatial index per page (built lazily), one drag = one undo step.
- **Undo/redo:** per-note history of strokes, erasing, template changes and added pages; strip buttons, commands with Mod+Z / Mod+Shift+Z, two-finger tap undo and three-finger tap redo.
- **Provisional strip** (tool, nib, colours, sizes, undo/redo) until the toolbar (#10). Stats: `view.stats` and the command "Toggle ink stats overlay".
- **Known gaps, filed:** #26 renaming a note orphans its page folder; #32 pen polish (rough edges, post-stroke refit, strokes that run off the page break); #9 zoom and finger scrolling and #10 toolbar are next in M1.

### The ink debug view (the spike)

Command "Open ink debug view". It still writes only under `_spike/` in the vault.

- **View:** command "Open ink debug view" (the ribbon icon and the "Open pen and audio test" command are gone). The command "Start or stop test recording" is kept.
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
  - On `visibilitychange` back to visible after being hidden (0.0.2): always reopen the mic and start a new segment, because on iOS the old recorder never delivers audio again (see Verified so far). Otherwise, if the mic track ended, reopen; if the recorder stopped, start a new segment. A mic muted for over 3 s while visible also triggers a reopen.
  - Watchdog (0.0.2): if no chunk arrives for 3 timeslices (6 s) while visible, reopen the mic and start a new segment.
  - Tries to hold a screen wake lock.
  - Logs to `_spike/rec-<stamp>/_log.md`: device, format, mic settings, app hidden/visible, pagehide, freeze, mute/unmute/ended, late chunks (over 3.5 s apart), wake lock, a summary every minute. `meta.json` holds the format.
  - **Recovery:** on layout ready, any `rec-*` folder whose log lacks "session stopped" has its parts merged, and the log is marked "recovered after unclean exit".
- **Why `_` prefixes:** every `.md` the spike writes starts with `_`, so the portfolio's Astro content loader (`**/[^_]*.md`) would skip them if the vault ever sat inside it.

### Verified so far

**On the iPad (owner, 2026-09-26):** the test protocol ran and the basic functions all work inside Obsidian's iOS web view: Pencil drawing, saving a page and audio recording. The plugin approach holds up, so the go/no-go in Next steps step 1 is a go.

Ink numbers, from `_spike/_results.md` (one page, 2026-09-26 2:56 PM, synced to the laptop through the sync plugin):
- 69 strokes, 14,345 points, 582 kB SVG; the canvas was 1180 × 537 CSS px (landscape).
- Median over 81 strokes: **120 move events/s, 471 samples/s**, handler delay **4.0 ms**. So each move event carries about 4 coalesced samples: coalesced events are essential, not optional.
- `getCoalescedEvents` **yes**; `getPredictedEvents` **yes**, up to 4 points ahead. Predicted points could be drawn as a throwaway tail to hide latency.
- Pressure is reported per sample (for example 0.08 at the start of the first stroke).
- Looked at again for the pen (#5), from the page's raw points (`notebook-sync-test/_spike/ink-20260926-145613.svg` on the laptop):
  - **WebKit repeats samples in coalesced lists.** Each `getCoalescedEvents()` list starts with samples already delivered by earlier events, some with *earlier* timestamps than samples already seen: 7,199 of the 14,345 recorded points are such repeats. Appended in order, as the debug view and the 0.2.0 pen did, the line doubles back on itself by up to about 1 px, which makes blobs and gaps in outlines. The pen drops any sample older than the last one it took.
  - Positions come in 0.5 CSS px steps (device pixels): every recorded x and y is a multiple of 0.5.
  - Pressure while writing is light: median 0.08, 90% below 0.18 (`force / maximumPossibleForce`). Runs of pressure 0 occur mid-stroke too. With a linear curve the pressure nib would draw about half its size nearly everywhere, so it uses a square-root curve (see `outline.ts`).
- 0 cancelled strokes. The 1 finger touch was ignored as intended. 1,055 pen hover events arrived, so hover works (possible cursor preview).
- The user agent reports as desktop Safari (`Macintosh; Intel Mac OS X 10_15_7 … Mobile/15E148 obsidian`), as iPadOS does. Don't detect the iPad from the user agent; use Obsidian's `Platform`.
- Size: about 40 bytes per point (582 kB / 14,345), since every point is stored twice: in the path outline and raw in `<metadata>`. Worth trimming (fewer decimals, delta-encoded timestamps, or dropping samples closer than a threshold) before real use.

Audio numbers, from `_spike/rec-20260926-201500/` (a 15 s recording in the foreground, 2026-09-26 8:15 PM):
- Format `audio/mp4` (saved as `.m4a`). `appendBinary` exists, so chunks were appended to one file live, with no parts to merge.
- The timeslice is honoured: 8 chunks in 15 s, 0 late, longest gap 2 s.
- 689 kB/min, about 41 MB/hour, matching the 96 kbps estimate.
- Mic "iPad Microphone" at 48 kHz, echo cancellation on. Channel count, noise suppression and auto gain aren't reported.
- Screen wake lock: allowed, held while recording and released on stop.

Backgrounding (protocol steps 4–6, 2026-09-26 8:20 PM; the lock and switch were short, 3 s and 9 s, not 30 s):
- **iOS cuts the mic whenever Obsidian isn't visible.** On both screen lock (`rec-20260926-202056`) and app switch (`rec-20260926-202120`), the app went hidden and the mic track was muted at the same moment. The recorder stayed in the "recording" state with no error, but delivered no chunks until the app came back. The gaps were 5.7 s and 12.1 s.
- **Coming back looks fine but isn't (0.0.1).** The mic unmuted, the page resumed and the wake lock was reacquired, all within the same second, and the recorder still said "recording". But the owner found it never recorded again: the files hold only the audio from before the hide. The sizes agree: 83 kB ≈ 7 s and 36 kB ≈ 3 s at the foreground rate. The only chunk after returning was the final flush on stop. 0.0.1 didn't notice, because it only reopened when the track had ended or the recorder had stopped.
- **Fix in 0.0.2:** coming back from hidden always reopens the mic and starts a new segment, and a watchdog reopens if no audio arrives for 6 s while visible. Checked in headless Chromium by simulating the stall (audio C in the test). **Confirmed on the iPad** (`rec-20260926-203712`, 8:37 PM): hidden for 7 s, then segment 02 started within a second of returning and recorded 72 kB in 6 s, the full foreground rate. Only one of the two runs (lock or app switch) was on 0.0.2; the other still needs a run.
- **Race seen in that run:** on return, the watchdog ran before the `visibilitychange` event, because the page already reported visible. It reopened the mic under "no audio for 7.6 s", and the visibility handler's reopen was skipped. The result was right, but the log lost the "back after N s hidden" line, and if the watchdog's reopen had finished first, a second, needless reopen could follow. Fixed after 0.0.2 (not yet released): the watchdog treats a pending hide as a return, and the visibility handler does nothing while a reopen is running.
- **Wake lock can be refused:** in one 0.0.1 run (`rec-20260926-202628`) the request failed with `NotAllowedError`, where every other run got it. Possibly Low Power Mode. Recording worked regardless, but without the lock, auto-lock would cut it after the screen timeout.
- **Audio is lost while hidden, with no silence in its place:** the owner reports that the file skips the hidden time entirely. So a position in the audio doesn't map to wall-clock time across a gap. Anything that lines audio up with time (notes, ink) has to use the per-segment start times, not an offset into one file. Separate segments per return, as 0.0.2 makes, keep that honest.
- **Force quit** (`rec-20260926-202140`): recovery ran on the next launch. The log was marked "recovered after unclean exit: audio was appended live, nothing to rebuild". The owner reports the file **plays**, roughly like the others, so appending chunks live survives a force quit with no rebuild step needed.
- **Implication:** in Obsidian's web view, recording only works while Obsidian is in front and the screen is on. The wake lock stops auto-lock, but a manual lock or an app switch drops audio for as long as it lasts. Background recording would need a native app, which is out given the constraints. So either live with foreground-only recording (make it obvious that it's paused while hidden, restart on return, and log the gaps), or record long sessions in Voice Memos and import the file.

**Editor releases on the iPad (owner):**
- **0.2.0 (2026-09-26):** create, write, close and reopen work; reading view with the plugin disabled shows the pages; a force quit 3 s after writing loses nothing; Pencil drags on a page don't scroll and fingers scroll. Bug: a stroke running off the page's right edge scrolled (fixed in 0.3.0).
- **0.3.0 (2026-09-27):** pen "acceptable but not quite at Notability's level": edges slightly rough, Notability applies a subtle refit as the stroke settles, and a stroke that goes too far off the page breaks (has to lift and put down again). All tracked in #32. The edge-scroll fix works. The stats overlay is reached through the command palette ("Toggle ink stats overlay").

In headless Chromium, through `test/run_spike_test.py`:
- Synthetic pen strokes, a finger touch, a tap and a real mouse stroke all draw.
- The saved SVG renders in light and dark, and stroke end caps round outward (checked zoomed in).
- A recording with a simulated app hide, killed mic and return produced two segments that decode to 6.5 s and 4.7 s.
- With `appendBinary` removed, a simulated crash left parts that recovery merged into a file decoding to 6.1 s.

### iPad test protocol (owner ran this; rerun after changes that affect ink or audio)

1. Install via BRAT (`zcsop1206/obsidian-notebook`), enable Notebook. (Up to 0.0.2 this was "Notebook spike"; the new id installs as a separate plugin, so remove Notebook spike.) The pen and audio test is now the ink debug view: command "Open ink debug view".
2. Write a paragraph fast; write with the palm resting on the screen; Save page.
3. Record 2 min, stop, play back.
4. Record, lock the screen 30 s, unlock, stop.
5. Record, switch apps 30 s, return, stop.
6. Record, force-quit Obsidian, reopen, play the recovered file.
7. Send back `_spike/_results.md` and the `_log.md` files (pasted text or screenshots), plus a subjective comparison of pen feel against Notability.
8. Pen (#5), side by side with Notability, uniform pen first: write a paragraph at normal speed and fast, pressing lightly and hard; look for lag, dropped or broken strokes, and any width change with the uniform pen. Try the pressure pen. Drag the Pencil off a page's edge and in the gaps between pages (nothing should scroll); scroll with a finger; tap "Add page" and the pen strip with the Pencil. Then run "Toggle ink stats overlay" (or open the ink debug view) on a page with about 300 strokes and note the median handler time (should be under 4 ms).

## Next steps

1. **Read the iPad results.** Done: the basics work, so building continues. Ink and foreground audio numbers are recorded (see Verified so far); screen lock, app switching and force-quit recovery still need testing on the iPad (protocol steps 4–6).
2. **GitHub API sync, as its own plugin and repo:** the first real feature, because everything else depends on it. It lives in `zcsop1206/obsidian-github-sync` (locally `Documents/obsidian-github-sync`), whose `CONTEXT.md` holds the design and status. It only needs to run on mobile, since the laptop uses plain git.
3. **Ink editor, meant to replace Notability on the iPad.** The GitHub issues are the spec; each has Goal, Scope, Out of scope, Acceptance criteria and Depends on. Build exactly what an issue scopes; file or edit an issue before building anything else. Milestone order (owner, 2026-09-26):
   - **M1 Editor foundation:** done: #2 build setup, #3 file format, #4 ink view, #19 templates, #5 pen, #6 highlighter, #7 stroke eraser, #8 undo/redo. Next: #9 pinch zoom and finger scrolling → #10 toolbar and presets → #26 rename keeps pages → #32 pen polish (owner: low priority). Released 0.1.0 (#2), 0.2.0 (#4), 0.3.0 (#19, #5), 0.4.0 (#6, #7, #8).
   - **M2 Lasso** (#11), then **M3 Images** (#12), then **M4 PDF** (#14 import and write on a PDF, #17 page management, #21 PDF page templates, #27 sized templates such as sticky notes with a copy-embed command), then **M5 Ruler** (#20).
   - **Backlog, not started:** #1 audio stitching, #15 partial eraser, #16 shape recognition, #18 PDF export, #23 more pen and highlighter types, #28 always a blank page after the last. **Not wanted:** #13 text boxes (closed), audio synced to ink.
   - Releases go out for iPad checks after #4 and #5 and at the end of each milestone; an issue closes only when its iPad criteria are met too.
4. **Audio:** turn the spike recorder into a feature, shaped by what the iPad test shows about backgrounding: recording is foreground-only; a lock or app switch splits it into segments.
   - `meta.json` now records each segment's `startMs` and, when known, `audioEndMs`, so segments can be placed on one timeline.
   - Playing split segments as one recording is an open, low-priority issue: https://github.com/zcsop1206/obsidian-notebook/issues/1. Workaround: keep Obsidian in front while recording.
5. **Later ideas:**
   - CI transcription of ink pages to searchable text and alt text.
   - Replaying stroke timestamps on the site.
   - Using git history as the notebook's dated, tamper-evident record.

## Repo mechanics

- **Files:** TypeScript source under `src/`; `manifest.json` (id `notebook`, name "Notebook"), `styles.css` and `versions.json` at the root. `main.js` is a build output: gitignored, attached to releases.
  - `src/main.ts`: the plugin class `NotebookPlugin` (`export default`). Registers the ink view and its takeover, the ribbon icon and command "New ink note" (`new-ink-note`), "Change template of this page" (`change-page-template`) and "Change template of all pages" (`change-all-templates`, both shown only in an ink view), "Open as ink note" (`open-as-ink-note`, also in the file menu of a markdown leaf), the settings tab, the debug view, the pen commands shown only in an ink view ("Use the uniform pen" `pen-nib-uniform`, "Use the pressure pen" `pen-nib-pressure`, "Next pen colour" `pen-next-color`, "Next pen size" `pen-next-size`, "Toggle ink stats overlay" `toggle-ink-stats`), the commands "Open ink debug view" (`open-debug-view`) and "Start or stop test recording" (`toggle-recording`), and recording recovery on layout ready. Exposes `settings`, `createInkNote(name, folder?, paper?, template?)`, `recorder`, `openDebugView()` and `inkPenStats()` (the latest ink view's pen stats, which the debug view's readout prints), which the tests drive.
  - `src/ink/` (#4), the ink view: `view.ts` (`InkView`, a `FileView` with view type `notebook-ink`, `nb-ink-*` CSS classes, a `stats` object for tests), `store.ts` (`NoteStore`: loads the index and pages through a small file interface, parses pages lazily, autosaves 2 s after the last change or 10 s after the first, serializes writes per file, pages before the index, and handles changes on disk), `renderer.ts` (page bitmaps, template rasterising, theme colours), `input.ts` (the pen, #5: see below), `pen.ts` (pen settings: nib, colour, size; the 8 colour and 3 size presets; `clampSize`, `withPen`, in memory until #10), `layout.ts` (page positions, pure), `takeover.ts` (the `WorkspaceLeaf.prototype.setViewState` patch that opens `ink:` notes in the ink view, undone on unload), `new-note.ts` and `names.ts` (New ink note, with paper and template), `template-chooser.ts` (a `FuzzySuggestModal` over the built-in templates). The store's `setPageTemplate`, `setAllTemplates` and `setNoteTemplate` return what they replaced, for undo (#8); the view redraws a page when its template changes, and its current page is the one taking up most of the viewport (`mostVisiblePage` in `layout.ts`).
  - **The pen** (`src/ink/input.ts`, #5): pen and mouse (button 0) draw, touches never do, pen hover is ignored; the pointer is captured, so a stroke continues off the page's edge. Handlers only record samples: every coalesced sample, in page px, rounded as the file stores them, dropping samples older than the last one taken (see Verified so far) or within 0.25 px of it; predicted samples are a tail that is never stored. Drawing happens once per animation frame as the same perfect-freehand outline as the saved page (`strokePath`), filled through `Path2D` on two overlay canvases over the page: the tail is redrawn every frame; past 192 live points the older ones are drawn once onto the head canvas (keeping 64 live, 16 shared), so per-frame work is bounded however long the stroke. On release the view draws the stroke into the page bitmap and the overlays are cleared. `blockStylusTouch` stops stylus `touchstart`/`touchmove` anywhere in the view (not a `touchstart` on a control, so Pencil taps still click); fingers scroll natively. The view has a provisional pen strip (`.nb-ink-strip`, replaced by #10's toolbar), `setPen`, and `stats.pen` (events and samples per second, handler and frame times, coalesced and predicted support, cancelled strokes, ignored touches; medians over the last 10 strokes), shown by "Toggle ink stats overlay". Outline options (`outline.ts`): streamline 0.35 for both nibs; uniform thinning 0; pressure thinning 0.6 on a square-root pressure curve, so `size` is still the width at pressure 0.5.
  - `src/settings.ts`: `NotebookSettings` (`paper`, `template`: defaults for new notes) and the settings tab.
  - `src/debug/view.ts`: the ink debug view (`DebugView`, view type `notebook-debug`, `nbspike-*` CSS classes).
  - `src/format/`: the ink note format `notebook-ink/1` (#3), pure functions over strings with no vault access. `page.ts` (page model, `readPage`/`writePage`, `LETTER`/`A4`), `note.ts` (markdown index, `readNote`/`writeNote`), `ids.ts` (page and stroke ids with an injectable random source), `outline.ts` (perfect-freehand outlines: `PEN_OPTIONS`, `UNIFORM_PEN_OPTIONS`, `HIGHLIGHTER_OPTIONS`), `template.ts` (#19: the `Template` union of kinds `blank`, `lined` (`rule` college 27 px or wide 33 px, `margin`), `grid` (`spacing` 5mm 18.9 px or 1/4in 24 px) and `dots` (5mm); `parseTemplate`; `renderTemplate`, the SVG of the template layer: one `<path class="t">` of line segments, dots as small circles of two arcs (radius 0.5 px, 1 px stroke; not zero-length round-capped segments, which WebKit may not draw), the margin line a fixed `#e8a0a0`; and the reversible names `blank`, `lined-college`, `lined-college-margin`, `lined-wide`, `lined-wide-margin`, `grid-5mm`, `grid-quarter-inch`, `dots-5mm` with labels in `BUILT_IN_TEMPLATES`, `templateName`/`parseTemplateName`). A note's `template:` frontmatter holds one of these names; `parseTemplateName` throws on an unknown name, and readers of files the user can edit (the frontmatter, via `noteTemplate` in `store.ts`, and the saved settings) fall back to blank with a console warning. The ink view's renderer rasterises the template layer with the theme's explicit line colour, since inside an `<img>` `prefers-color-scheme` follows the OS, not Obsidian.
  - `src/debug/recorder.ts`: the test recorder. `src/debug/ink-svg.ts`: the SVG ink writer (`outline`, `toSvg`, format `notebook-ink/0`). `src/debug/util.ts`: shared helpers and the write queue.
- **Build:** `npm install`, then `npm run build` (runs `tsc -noEmit -skipLibCheck`, then `esbuild.config.mjs production`) or `npm run dev` (watches, inline source map). esbuild bundles `src/main.ts` to `main.js` at the root: cjs, target es2018, not minified. `obsidian`, `electron`, `@codemirror/*` and `@lezer/*` are external. Node built-ins are deliberately not external, so importing one fails the build: the plugin runs in the iOS web view.
  - TypeScript is strict. Types come from the `obsidian` npm package. `skipLibCheck` is needed because `obsidian.d.ts` itself fails to type-check (Menu, Modal and PopoverSuggest don't implement `onHistoryBack` from HistoryHandler).
  - Dependencies are limited to `obsidian`, `typescript`, `esbuild` and `perfect-freehand` (MIT, for stroke outlines). Ask before adding anything else. `package-lock.json` is committed.
- **Release:** bump `version` in `manifest.json` and add it to `versions.json`, commit, then push a tag equal to the version. `.github/workflows/release.yml` runs `npm ci` and `npm run build`, checks the tag matches the manifest, and attaches `main.js`, `manifest.json` and `styles.css` to a release. BRAT picks it up.
- **Test:** `npm test` builds, then runs `python test/run_spike_test.py`, which needs Python Playwright with its bundled Chromium. It serves the repo root on port 8765 and loads the built `main.js` into `test/harness.html`, taking the plugin class from `module.exports.default`. The harness loads the mock `obsidian` module from `test/mock-obsidian.js`: `Plugin`, `ItemView`, `FileView`, `MarkdownView`, `WorkspaceLeaf` (one leaf shown at a time), `TFile`/`TFolder`, `Modal`, `Setting`, `Notice`, a vault (`create`, `modify`, `read`, `createFolder`, events) and `vault.adapter` over one in-memory map (`window.fs`), a frontmatter-reading `metadataCache`, and Obsidian's DOM helpers. Chromium runs with a fake mic. Each check prints PASS or FAIL, and any failure exits 1: typed ink strokes, the SVG parsing with its metadata, audio A (two decodable segments), audio C (return and watchdog restarts), audio B (recovery), and no page errors. Screenshots and the exported SVG go to `test/out/` (gitignored). The mock covers only the API surface the plugin uses; extend it as the plugin grows.
- **View test:** `npm test` then runs `test/run_view_test.py` (port 8767) against the same harness, with the format functions and a seeded large-note generator from `test/out/view-fixture.js` (built from `test/view-fixture.ts` by `test/build.mjs`). It creates a note through the modal, writes with synthetic pen events, checks the 2 s autosave and the immediate saves (hidden, pagehide, close), reopens, simulates changes on disk, adds pages, opens a 20-page note with 300 strokes per page (printing open time and scroll frame times), checks the takeover and templates, and tests the pen with synthetic events carrying coalesced and predicted events: uniform and pressure widths, the live overlay mid-stroke against the committed bitmap (light and dark screenshots `pen_*.png`), saved paths, touches, stylus touch events (Chromium's `Touch` has no `touchType`, so the test defines one), the pen strip and commands, the stats overlay, and the handler time with 300 strokes on the page. The pen's pure parts (settings, sampling with fake WebKit-like coalesced lists, the frozen head) have unit tests in `test/unit/pen.test.ts`. The view's pure parts have unit tests in `test/unit/view-logic.test.ts`.
- **Format tests:** `npm test` also runs the unit tests (`test/unit/*.test.ts` with `node:test`, bundled to `test/out/unit.js` by `test/build.mjs`; Node types are hand-declared in `test/unit/node-shims.d.ts`, since `@types/node` isn't installed) and `test/run_format_test.py`, which renders the sample note in `test/fixtures/` in light and dark on port 8766. `npm run fixture` regenerates the fixture from `test/fixture.ts` (seeded, reproducible); a unit test fails if the committed files differ. `.gitattributes` keeps the fixture LF.
- **Obsidian API notes:** `DataAdapter.appendBinary` exists only from 1.12.3, so feature-detect it. Views use `ItemView`, opened with `workspace.getLeaf('tab').setViewState(...)`. On mobile, `Platform.isIosApp` and friends are available.

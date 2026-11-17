# Study Reader: interfaces

What every file in `src/` implements, as integrated into one page. Names match the ARCHITECTURE
section of the brief; everything marked *extension* is extra. Written by a model for Adit. Not
Adit's words.

Each rule lives in exactly one place. engine.js owns builds, budgets, Changes, rationing, stages,
push levels, ratings and picks; the reader and the blocks only display and call it. There are no
duplicate fallbacks: a build missing a module says so where that module's part would appear.

| missing file | what the page does |
|---|---|
| engine.js | docs read normally; a margin mark is only noted (toast says why); blocks show "not recorded"; Today and Map say the engine is missing |
| block-drill.js | cold proofs and drills show "the blank-page drill is not loaded"; Today's Drill button opens the basic |
| block-problem.js / block-kata.js | the block shows a "not loaded" placeholder; Today's card shows a toast |
| panel-map.js | Today and Map open a sheet saying so |
| core.js or reader.js | boot fails with a message on the page |

main.js reports what a build carries in `SR.modules` (`{'engine.js': true, ...}`) and warns once in
the console about anything missing.

## Build

```
node build.mjs                      # index.html from src/ in the fixed order; missing files are skipped
node build.mjs --fixture            # test/fixture-content.js stands in for src/content.js
node build.mjs --bare               # only base.css, core.js, content.js (or fixture), reader.js, main.js
node build.mjs --bare --add engine.js,block-fog.js   # the bare set plus named files
node build.mjs --out test/out/x.html --quiet
```

Order: `base.css` (inlined in `<style>`), `core.js`, `content.js`, `engine.js`, `reader.js`,
`block-fog.js`, `block-kata.js`, `block-problem.js`, `block-drill.js`, `panel-map.js`, `main.js`.
Output: `<title>Study Reader</title>`, `<style>`, `<div id="sr-app">`, one `<script>` per JS file
(so one file throwing at load does not stop the others), then
`<script async src="https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js">`.

The build changes nothing in the sources except `</script` inside JS, written `<\/script`. It refuses
to write (exit 1) if the page would contain `<!doctype`, `<html>`, `<head>`, `<body>`, a viewport
meta, `</style` in CSS, an external script that is not `cdn.jsdelivr.net/npm/<pkg>@x.y.z/`, an
external stylesheet, or more than 16 MB. It warns on `eval(`, `new Function(`, `alert(`, `confirm(`,
`prompt(`, `window.open(`, `fetch(`, `XMLHttpRequest` and dynamic `import(` anywhere in the page text
(comments included, so keep those words out of them).

## core.js

All of it hangs off `window.SR`. Labels: `SR.LABEL_MODEL` = "Written by a model for Adit. Not Adit's
words.", `SR.LABEL_DEMO` = "Demo data".

### SR.store
`get(k, default?)`, `set(k, v) -> bool`, `del(k)`; *extensions* `keys()`, `clear()` (every key under
the prefix), `persistent` (false when localStorage throws), `prefix` = `'lab-study-reader-'`.
Values are JSON; `get` returns a fresh parse each time, so mutate and `set` back. Every read and write
goes through an in-memory copy first, so the page keeps working for the session when localStorage
throws (sandboxed frame, private mode); nothing persists then.

### SR.bus
`on(evt, fn) -> off()`, `off(evt, fn)`, `emit(evt, data) -> number of handlers run`. A throwing
handler is logged with `console.error` and the rest still run. Handlers get `(data, evt)`.

| event | from | data | when |
|---|---|---|---|
| `typeset` | core | elements | after each MathJax pass |
| `math:ready` | core | | MathJax is usable |
| `blocks:register` | core | type | a block type registered |
| `sheet:open` / `sheet:close` | core | sheet id | a side sheet opened or closed |
| `theme` | core, reader | `'auto'`/`'light'`/`'dark'` | theme or colour scheme changed (ink repaints itself) |
| `engine:change` | engine | `{type, ...}` | any engine state change (`clock`, `drill`, `fog`, `settle`, `triage`, `rewrite`, `version`, `change`, `demo`, `reset`, ...) |
| `reader:doc` | reader | `{docId, version}` | a doc is shown |
| `reader:follow` / `reader:peek` | reader | `{to}` | a link was followed / a peek opened |
| `reader:marks` | reader | marks map | a margin mark changed |
| `reader:changes` | reader | `{docId}` | the reader wrote a Changes entry |
| `demo:reset` | reader | | Reset demo ran (store cleared, engine reset) |
| `drill:start` / `drill:done` / `drill:grade` | block-drill | `{key, fogId, basic, ...}` | a drill attempt started, ended, was graded |
| `problem:state` | block-problem | `{id, src, phase}` | a problem session changed |
| `kata:change` | block-kata | `{id}` | a kata's state changed |
| `boot` | main | `{modules}` | main.js finished booting |

### SR.typeset(el) -> Promise
Typesets `el` with `MathJax.typesetPromise([el])`, chained so passes never overlap. Before MathJax is
ready the element is queued; the first pass typesets the queue in one call, minus any element that
sits inside another queued element (one call over an element and its own ancestor makes MathJax throw
`splitText` and leave the doc half typeset). So blocks may typeset at any time, inside a doc or not.
Offline the promise never resolves and the raw TeX stays readable. *Extension:* `SR.mathReady()`.
core.js sets `window.MathJax = {tex:{inlineMath:[['$','$'],['\\(','\\)']]}, svg:{fontCache:'global'},
options:{enableMenu:false}, startup:{typeset:false, pageReady}}` before the MathJax tag runs (only if
`window.MathJax` is not already set). `enableMenu:false` keeps formulas unfocusable, so a finger tap
beside a link is not retargeted onto a formula.

### SR.css(name), SR.esc(s), SR.twoTap(button, armedText, fn, ms?)
`SR.css('--accent')` or `SR.css('accent')` reads a token from `:root`. `SR.esc` escapes `& < > " '`.
`SR.twoTap`: the first tap arms the button (class `armed`, text `armedText`, 3.5 s), the second runs
`fn(event)`; returns `{disarm(), destroy()}`.

### SR.ink.create(container, opts) -> api
Pointer Events; `pen` and `mouse` draw, `touch` never draws. Non-passive `touchstart`/`touchmove`
call `preventDefault` only for a touch with `touchType === 'stylus'` (and not when read-only or
ignored). `getCoalescedEvents` when present; samples older than the last are dropped. Points are
`[x, y, pressure, t]` in paper units (`opts.width`, default 800, wide), `t` in ms since the stroke's
`t0` (epoch ms); mouse pressure is 0.5; a mouse click (under 2 paper px of travel) is not a stroke.
Canvas at devicePixelRatio (and any ancestor CSS scale), capped at 16 M pixels; quadratic curves
through midpoints, round caps and joins, width 1.6.

Modes: **fit** (default) appends a `.sr-ink` box to `container` and scales the paper to the box
width; a ResizeObserver re-lays it out. **overlay** (`opts.overlay: true`) lays a canvas over
`container`, which must already be in paper units (the reader's page stack); the owner calls `layout()`.

| opts | meaning |
|---|---|
| `width` | paper width, default 800 |
| `height` | number or `() => number`, paper height (default 400); change it, then call `layout()` |
| `key` | SR.store key; strokes load from and save to it after every change |
| `color(stroke)` | colour per stroke: `'#hex'`, `'rgb(...)'`, `'--token'` or `'var(--token)'`; default `--ink` |
| `readOnly()` | `true` blocks new strokes (also a plain boolean) |
| `onStroke(stroke)` | after a stroke is pushed, before it is saved, so it may add fields |
| `background(ctx, w, h)` | paints under the ink, in paper units |
| *ext* `meta(stroke)` | at pen-down: fields merged into the new stroke (e.g. `{e: reveals}`) |
| *ext* `lineWidth` | number or `(stroke) => number`, default 1.6 |
| *ext* `strokes()` | the caller owns the array (then `key` is ignored and the caller persists) |
| *ext* `place(stroke)` | `{dx, dy, alpha, color}` per stroke at draw time; `null` hides it |
| *ext* `ignore(event)` | `true` skips starting a stroke (and the stylus scroll block) for this event |
| *ext* `onChange(list)` | after any stroke, undo or clear |
| *ext* `overlay`, `surface`, `className` | overlay mode, the element that receives pointer events, an extra class |

api: `strokes()`, `redraw(list?)` (with a list, paints that list: replay passes truncated copies),
`undo() -> removed stroke`, `clear()`, `setReadOnly(bool|null)`, `layout()`; *extensions* `el`,
`canvas`, `count()`, `height()`, `setStrokes(arr)`, `save()`, `toPaper(event)`, `isDrawing()`,
`destroy()`. Also `SR.ink.drawPath`, `SR.ink.color(c)`, `SR.ink.instances()`, `SR.ink.redrawAll()`.

Stroke: `{p: [[x, y, pressure, t], ...], t0: epoch ms, at?: {a, dy, rev, v}, e?: reveals at write}`.
For the reader's doc ink, `at.a` is the nearest `[data-a]` at or above the stroke's centre, `at.dy`
that anchor's top when written (the stroke draws at `p.y + (anchorTop(now) - at.dy)`), `at.rev` the
passage's text hash then (35% alpha when it no longer matches), `at.v` the build.

### SR.blocks
`register(type, {mount(el, id, ctx) -> {destroy?()}})`, `mountAll(rootEl, ctx) -> handles`;
*extensions* `unmountAll(rootEl)`, `has(type)`, `types()`. A block is
`<div class="blk" data-block="TYPE" data-id="ID">`; each element mounts once. An unregistered type
gets a placeholder that shows none of its content. Blocks own their contents, their state (in
SR.store: docs are re-rendered when a build or rewrite changes, which remounts their blocks) and
their own `SR.typeset` calls.

Inside a doc a block lives in the page stack, 800 px wide and CSS-scaled to the screen:
`clientWidth`/`offsetHeight` are unscaled paper px, `getBoundingClientRect()` is scaled, and
`position: fixed` is relative to the stack. Put overlays in `SR.sheet` or `SR.toast`.

ctx (from the reader): `{docId, version, engine, open(docId, anchor), peek(ref, anchorEl)}`;
*extensions* `doc`, `area`, `track`, `relayout()`, `toast(msg)`.

### UI helpers (*extensions*)
- `SR.toast(msg, ms?)` (pointer-events none, so it never blocks a tap).
- `SR.sheet.open({id, title, html | node, wide, className, onClose, keepOnNav}) -> {id, el, body, close(), setTitle(t), setBody(htmlOrNode)}`:
  a right-hand panel over a backdrop (tap outside, Close or Escape closes it). Same `id` reuses the open
  sheet. Sheets stack. `SR.sheet.get(id)`, `top()`, `all()`, `close(id?)`, `closeAll(exceptKeepOnNav?)`.
  Ids in use: `library`, `changes`, `demo`, `today`, `map`, `problem-<id>`, `kata-<id>`, `drill-<basic>`.
- `SR.style(id, cssText)`, `SR.el(html)`, `SR.now()` (the engine's simulated clock), `SR.fmt.date/dateTime/iso/dur/num`.

### CSS vocabulary in base.css
Tokens from the brief plus `--ink`, `--tint`, `--flash`, `--fog`, `--shadow`, stage colours
`--s0..--s5` with text colours `--s0t..--s5t`, `--serif`, `--ui`, `--mono`; light, dark media and
`[data-theme]` variants. Buttons are styled globally: `.primary`, `.warn`, `.armed`, `.sel`, `.on`,
`:disabled`. Shared classes: `.sr-card`, `.sr-kick`, `.sr-row`, `.sr-ui`, `.sr-hint`, `.sr-badge`,
`.sr-ink`, `.sr-fog`, `.sr-by`, `.sr-demo`, `.sr-stage.s0..s5`, `.blk-ph`. Inside `.page`,
`.blk[data-block=kata]` and `.blk[data-block=drill]` extend 120 px into the right margin. Add class
`no-ink` to any element the Pencil should not write over in the doc ink.

## main.js

On DOMContentLoaded: checks which modules the build carries (`SR.modules`), fails visibly if core.js
or reader.js is missing, warns once about any other missing file, runs `SR.reader.init()`, then
`SR.panels.init()`, then makes sure SR.typeset starts once MathJax is up (the pageReady hook in
core.js, else MathJax's startup promise), and emits `boot`.

## content.js

`SR.content = {docs, fog, problems, katas, methods, pmTasks, tests, rewrites, library, areas, labels}`
(also `module.exports` for node). The shape is the brief's; extra fields are `method.basic`,
`method.cue`, `problem.guess`, `kata.ports`, `kata.area`, `fog.title`, `fog.version`, `task.line`,
`task.chain`, `task.priority`, `content.library` (doc order), `content.areas` (labels, track, topic doc).

- Docs: topics `nt-moves`, `dd-framing`; basics `nt-divisibility`, `nt-units` (builds 1 and 2),
  `nt-crt`, `dd-lfsr`, `dd-crc`. 25 fog blocks. 5 rewrites (four in nt-moves, one in dd-framing).
- Problems: 34 Putnam references (label and archive link only; area and methods a model's guess) and
  19 invented ones with statement and solution. `inv-11` to `inv-13` (d 2.3 to 2.5) put the first number
  theory picks at r 3 inside the stretch band; `inv-5` (d 2) and `inv-14` to `inv-19` (d 0.8 to 1.8) stock
  the low end, so picks after two misses are easier than the band and the band is stocked again after a hold.
- Katas: `k-shift`, `k-lfsr`, `k-crc`, `k-deser` (simple), `k-uart` (hard, push), `k-badframe`
  (hard, hidden), `k-pattern` (hidden). `k-deser` (d 3.5) and `k-pattern` (d 3) were added at
  integration so the kata slots sit near the stretch band at the starting dd rating. Reference
  designs are in `test/kata-solutions.txt`, never in the page.
- pmTasks: 8 invented sample tasks in the ledger's line format (Putnam and ASIC only).

## engine.js

`SR.engine`, created over `SR.content`, `SR.store` (key `engine`) and `SR.bus` (read lazily); in node,
`module.exports = {createEngine, CONSTANTS, expected, dForE, rateUpdate, nextStage, intervalFor, ...}`.
Without a store it keeps its state in memory.

- Clock: `now()`, `today()`, `advanceDays(n)` (simulated offset, persisted).
- Basics: `stage`, `setStage`, `lastDrill`, `drillHistory(basic)` (every graded retrieval, oldest
  first: `{t, day, grade, from, to, src, push}`), `roseToday(basic)` (a clean result raises the stage
  at most once a simulated day), `due`, `deadline`, `pushLevel`, `inPush(area)`, `weak`, `basics()`,
  `basicInfo(basic)` (includes `roseToday`).
- Results: `recordDrill(basic, grade)`, `recordFog(fogId, {reveals, steps, done, clean})`,
  `fogRecord(fogId)` (the last finished attempt).
- Ratings and picks: `rating`, `history`, `streaks`, `target(area, {hidden, reach})`,
  `pickProblem`, `pickKata`, `expected(d, r)`, `practised(area)`. Hidden-topic picks come from other
  practised areas (a basic in the demo, or a counted settle) or general reasoning. Eased picks keep to
  d <= the plain stretch target while any remain (else `easeShort`, and the why says so). In push mode a
  hard kata comes first only within reach (E >= 0.40).
- Theorem items: `problem('thm:<fog id>#<n>')` is a basic's theorem posed as a problem (push level 3);
  `settleProblem` on it grades the basic like a drill (held clean, held after help shaky, missed or blind
  failed, moot nothing; `src: 'hook'`), counts the method ticks (kind `theorem`) and leaves the rating.
- Settling: `settleProblem(id, {verdict, help, gaveUp, called, took, hidden?, reach?, confidence?, ms?})`,
  `settleKata(id, {pass, runs, gaveUp, called, took})`, `settled(id)`, `kataResult(id)`,
  `settledAll()` (every settled problem and kata, newest first, each with `kind`),
  `methodAccuracy(area?, {hidden, kind})`, `solveRate(area?)`, `methodLabel`, `problem(id)`, `kata(id)`.
- Marks: `triage({docId, anchor, verb, attemptStrokes, links?})`, `recheck(docId, anchor, strokes)`,
  `requestRewrite`, `budget`, `marks`, `mark`, `clearMark`, `rewriteOf`, `rewritten`,
  `linkedBasics` (decides a rebuild), `passageBasics` (linked, else the doc's needs: what the scaffold
  shows), `logChange(docId, text, kind?)`, `changes`, `recognise`, `docVersion`, `setDocVersion`.
- Today's drills are ranked by the nearest deadline that needs the basic, then by days overdue.
- Panels: `todayPlan()`, `blockers()`.
- Demo: `makeComfortable(area)`, `simulateMisses(area, n)`, `simulateHolds(area, n)`, `reset()`.
- Constants: `AREAS`, `AREA_NAMES`, `constants` (K, E_TARGET, E_LO, E_HI, E_REACH, HIDDEN_STEP, ...).

## reader.js

`SR.reader.init()` builds the shell inside `#sr-app`: header (Study reader + Demo tag, Library, tabs,
Back, Today, Map, Changes, Undo ink, Demo, theme), the model label and "Demo data" pill, the page
stack, the peek.

| API | does |
|---|---|
| `open(docId, anchor?)` / `follow('DOC#ANCHOR')` | close sheets (except `keepOnNav` ones), navigate with the back stack, flash the target |
| `show(docId)` | show a doc without touching the back stack |
| `back()`, `current()` | pop the back stack (restores scroll); the doc on screen |
| `peek(ref, anchorEl?)`, `closePeek()` | the long-press peek |
| `relayout()`, `rerender(docId?)` | re-measure anchors, re-place ink and chips; rebuild a doc's DOM |
| `openPanel('library'|'changes'|'demo'|'today'|'map')` | open a panel (Today and Map: `SR.panels`) |
| `marks()`, `setMark(key, verb)`, `clearMark(key)` | margin marks, key `'DOC#ANCHOR'` |
| `ink()`, `inkOf(docId)`, `anchors()` | the doc ink api, a doc's strokes, measured anchors |
| `version(docId)`, `setVersion(docId, v)` | current build (from the engine); switching re-anchors ink |
| `title(docId)`, `docs()`, `ctx(docId)`, `search(q)` | helpers |
| `drill(basicId)` | `SR.drill.open(basic, {choose: true})` in a sheet, else opens the basic |
| `reset()`, `theme(mode)` | Reset demo; set theme |

Links: `<a class="ref" data-to="DOC#ANCHOR">`. Finger or mouse tap follows; hold 450 ms peeks; on the page
text the Pencil writes over links and never follows them, elsewhere (panels, peek, no-ink blocks) a pen tap
follows. Escape closes the peek first, then the top sheet. Peeks and search never show fogged proofs,
problems or solutions.

Margin marks call `engine.triage` and act on `action`: `rebuild-basic` (switch each basic to
`versions[b]`, write its Changes entry, re-render and re-anchor ink: followed / dimmed with keep and
delete / orphaned), `scaffold` (struggling: the linked basics with stage pills and a fogged attempt
box, key `attempt-DOC#ANCHOR`), `eligible` ("Request rewrite (n of 3 left)", two taps, then
`content.rewrites[doc][anchor]` swaps in), `budget-exhausted` ("Drill <basic> instead"), `noted`.
`engine.recheck` runs when the clock moves, the attempt box changes, or a rewrite spends the doc's
budget (every mark on that doc). The scaffold's since and eligibleAt are the engine's. Nothing is logged
twice. A rebuild's toast and Changes entry say what happened to proof attempts on the old build.

Changes panel (per doc): build and build switcher, rewrite budget, Recognise list, log, marks.
Demo drawer: simulated clock + Advance a day; area chips + Make comfortable, Simulate 2 misses,
Simulate 3 clean holds (opens one reach pick); Reset demo (second tap; clears every SR.store key
except the theme, then `engine.reset()`).

Store keys: `doc`, `tabs`, `theme`, `marks`, `ink-<docId>`, `attempt-<DOC#ANCHOR>`, `rewritten`.

## block-fog.js

`SR.blocks.register('fog')`; handle `{destroy, id, mode(), state()}`; `SR.fog = {MODES, CHIP, units,
grade, stateOf(id)}`. Push level of the proof's basic: 0 steps (each reveal needs 3 new strokes), 1
chunks, 2 cold (`SR.drill.run` in place), 3 hook (a block-problem.js session over `thm:<fog id>#<n>`:
call band, confidence locked until ink, settle verbs, method ticks; without block-problem.js the old
"Prove it cold" drill card stands in), plus the push-mode note. An unfinished attempt on the same proof in
another build of the doc carries over once (reveals mapped by proportion); a finished one shows read-only.
`SR.fog.attempts(docId, version)`, `SR.fog.siblings(id)`. Provenance ink: strokes carry
`e` = reveals at write and draw in `--after` after a reveal. Done calls `engine.recordFog` once; a
clean proof collapses the model's text and shows "yours". An attempt keeps its view while open or
finished; idle blocks follow the level. Store key `fog-<id>`.

## block-drill.js

`SR.drill.run(el, spec)` (spec: `fogId, basic, steps, title, statement, showStatement, key, fixed,
choose, autoStart, onStart, onDone, onGrade(res, attempt)`) returns `{phase, attempt, analysis, start,
done, giveUp, grade, again, more, select, play, pause, seek, speed, timeMap, replayTime, proofs, key,
fogId, destroy}`. `SR.drill.open(fogOrBasic, {choose})` opens it in sheet `drill-<basic>`;
`SR.blocks.register('drill')`. Done after 3 strokes shows every step; grades go to
`engine.recordDrill` (the pre-grade text uses `engine.roseToday`). Give up also needs 3 strokes. A live
attempt moves to the same proof in the build shown (`SR.drill.carry(fogId)`). Replay 1x/4x/16x with stalls over
30 s and a time map. Store keys `drill-<fogId>`, `drill-hist`.

## block-problem.js

`SR.problem.open(problem | id | Today entry, {hidden, reach, why})` (sheet `problem-<id>`),
`.mount(el, problem, opts)`, `.state(id)`, `.status(id)` (`new`, `call`, `attempt`, `settled` (a
verdict without saved ticks), `done`), `.find`, `.hookBasics`; `SR.blocks.register('problem')` (a hook
opens inline at the top of its doc when every basic it rests on is at push 3). Call band above a
commit line, confidence chips locked until ink, timer, settle verbs (two taps), then the two tick
lists and one `engine.settleProblem` call. Giving up asks for the called ticks before the solution opens.
Theorem items (`kind: 'theorem'`) show the basic's stage move instead of a rating. Store key `problem-<id>`.

## block-kata.js

`SR.kata.open(kata | id | Today entry, {hidden, reach, why})` (sheet `kata-<id>`), `.state(id)`,
`.views()`, `.sim` (interpreter, reference models, waveform); `SR.blocks.register('kata')`. Design call
(sketch + one line + confidence) before the editor, the Verilog-subset interpreter with a JS reference
model per kata, first mismatch and waveform, `engine.settleKata`, then the two tick lists. Hidden katas
never name the technique. Every stimulus resets with its qualifier low after state has built up, and
resets where rst wins over valid matter. Pending editor text is saved on pagehide and when the tab is
hidden. Store keys `kata-<id>`, `kata-ink-<id>`.

## panel-map.js

`SR.panels = {init, open(name), today(), map(), refresh()}`; sheets `today` and `map`; re-renders on
`engine:change`, `reader:changes`, `demo:reset`, `problem:state` and `kata:change`. Today: drills ranked
by priority, the next ship date, problem and kata slots (hidden picks show "?" only), a session flag on
each problem card (call begun, in progress, finish settling), settled today. Map: basics graph (fill =
stage, rings = push, fog of war), node detail with the drill history (`engine.drillHistory`), ship
dates with blockers, ratings with sparklines and the stretch band, method identification
(`engine.settledAll`). Store key `map-sel`.

## Tests

From `obsidian-notebook`: `node --test lab/study-reader/test/engine.test.mjs lab/study-reader/test/kata.test.mjs`.
From `lab/study-reader`: `python test/smoke.py` (shell suites on fixture builds with and without
engine.js, a sandboxed iframe, real input, then the full build) and `python test/e2e.py` (builds
index.html, checks the page contract, and runs the whole journey at 1024x768 and 390x844 with real
mouse, touch and pen input). Screenshots go to `test/out/`.

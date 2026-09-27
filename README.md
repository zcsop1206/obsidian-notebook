# obsidian-notebook

**Notebook** is an Obsidian plugin for handwritten notes with the Apple Pencil on the iPad, meant to replace Notability. Pages are stored as SVG files in the vault, so they render in Obsidian, on GitHub and on a website without the plugin. It's part of an engineering notebook kept in Obsidian and published with a portfolio site.

## Status

Early but usable: **New ink note** (ribbon pencil or command) creates a note whose pages stack in the ink view, with blank, lined, grid or dots templates (per page, changeable at any time), Letter or A4 paper, a uniform or pressure pen with colours and sizes (a provisional strip until the toolbar lands), and autosave 2 s after the last change. Markdown files with `ink:` frontmatter open in the ink view; "Open as markdown" switches back. Progress is tracked in the GitHub issues and milestones (M1 editor foundation → M2 lasso → M3 images → M4 PDF → M5 ruler). The **ink debug view** (command **Open ink debug view**) is the old spike: a graph-paper canvas that measures Apple Pencil input and tests audio recording, writing under `_spike/`. **Start or stop test recording** starts or stops a recording without opening it.

Planned: a page view with paper templates, pen, highlighter and eraser tools, pressure-shaped strokes (with [`perfect-freehand`](https://github.com/steveruizok/perfect-freehand)), ink notes embedded in markdown, and audio recording. Syncing the vault through GitHub is handled by a separate plugin.

## Page templates

Each page of an ink note has its own paper: blank, lined (college or wide rule, with or without a pink margin line), grid (5 mm or ¼ in) or dots (5 mm). The lines are drawn into the page's SVG, in a light grey that turns dark grey in dark mode, so a page looks the same in Obsidian's reading view and on GitHub. Choose the paper size and template in the **New ink note** dialog (the defaults are in the plugin settings), add a page with another template with **Add page with template…** under the last page, and change the template of the current page or of every page with the commands (or header buttons) **Change template of this page** and **Change template of all pages**. The writing is never touched. A note's `template:` frontmatter names the template for new pages, e.g. `lined-college-margin`.

## Pen

Write with the Apple Pencil (or the mouse on desktop); fingers never draw, and a Pencil drag never scrolls the page. The pen has two nibs: **Uniform** (the default), which draws the same width whatever the pressure or speed, and **Pressure**, which gets wider as you press harder. Strokes are smoothed with [`perfect-freehand`](https://github.com/steveruizok/perfect-freehand), and the line you see while writing is the same outline that is saved. Pick the nib, one of eight colours (default black turns light in dark mode), and a size from 0.5 to 16 px in the small pen strip above the pages; it's provisional until the toolbar arrives. The commands **Use the uniform pen**, **Use the pressure pen**, **Next pen colour** and **Next pen size** do the same, and **Toggle ink stats overlay** shows input measurements (events and samples per second, handler and frame times), which the ink debug view also prints.

## Install on the iPad

1. Install **BRAT** from Community plugins and enable it.
2. BRAT → Add beta plugin → `zcsop1206/obsidian-notebook`.
3. Enable **Notebook** under Community plugins.

If you installed the earlier **Notebook spike**, remove it under Community plugins. The plugin id changed from `notebook-spike` to `notebook`, so BRAT installs Notebook as a separate plugin rather than updating the spike.

## Development

Needs Node 22 (npm), and for the tests Python 3 with [Playwright](https://playwright.dev/python/) and its Chromium (`pip install playwright`, then `python -m playwright install chromium`).

```sh
npm install
npm run dev     # rebuild main.js on every change, with an inline source map
npm run build   # type-check, then build main.js for release
npm test        # build, then run the headless tests in test/
```

Source is TypeScript under `src/`: `main.ts` is the plugin class, `src/format/` reads and writes the ink note format (`notebook-ink/1`: a markdown index plus one SVG per page), `src/ink/` is the ink view (loading and autosaving notes in `store.ts`, page bitmaps in `renderer.ts`, the pen in `input.ts` with its settings in `pen.ts`, and `takeover.ts`, which opens markdown files with `ink:` frontmatter in the ink view), `settings.ts` holds the settings, and `src/debug/` holds the ink debug view and test recorder. esbuild bundles it into `main.js` at the repo root, which is not committed. The plugin runs in Obsidian's iOS web view, so use web APIs only, never Node modules.

`npm test` builds, runs the unit tests (`test/unit/*.test.ts`, bundled by `test/build.mjs` and run with `node --test`), then the Playwright tests. `test/run_format_test.py` renders the sample note in `test/fixtures/` as images in light and dark. The fixture is generated by `npm run fixture` (from `test/fixture.ts`); a unit test fails if the committed files differ from what it generates, so rerun it and commit after a deliberate format change. `test/run_view_test.py` drives the ink view: creating a note, writing with synthetic pen events, autosave, reopening, changes on disk, adding pages, a 20-page note, the markdown takeover, templates and the pen (live and saved outlines, nibs, stylus touches, the pen strip and handler time with 300 strokes on a page). `test/run_spike_test.py` serves the repo on port 8765, loads the built `main.js` into `test/harness.html` (a mock of the Obsidian API with an in-memory vault, in `test/mock-obsidian.js`) in headless Chromium with a fake microphone, and drives pen strokes, saving a page and three recording scenarios. It exits non-zero if a check fails. Screenshots and the saved SVG go to `test/out/`.

To try a build in a desktop vault, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/notebook/`.

## Release

Bump `version` in `manifest.json` and add it to `versions.json`, commit, then push a tag equal to the version (for example `0.0.3`). The release workflow runs `npm ci` and `npm run build`, checks the tag matches the manifest, and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release, which BRAT installs.

# Drives the ink view in headless Chromium against the built main.js, with the mock obsidian
# module and in-memory vault of test/harness.html and the format functions from
# test/out/view-fixture.js (built by test/build.mjs). Covers creating a note, writing with
# synthetic pen events, autosave timing, saving when hidden or closed, reopening, changes on
# disk, adding pages, a 20-page note, the markdown takeover, page templates, and the pen (live
# and committed outlines, nibs, stylus touches, the pen strip, stats and handler time), and the
# highlighter (tools, layers, crossings, the live overlay, long strokes). Run by
# `npm test`; screenshots land in test/out/. Exits non-zero if any check fails.
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 2
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail != '' and not ok else ''))
    if not ok:
        failures.append(name)

# Test helpers, on window.T in the page.
HELPERS = """() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pages = () => [...view.contentEl.querySelectorAll('.nb-ink-page')];
  const T = window.T = {
    sleep,
    pages,
    /** A synthetic stroke over page i through `pts` (page px). */
    async stroke(i, pts, type = 'pen', id = 7, gap = 4) {
      const el = pages()[i], r = el.getBoundingClientRect(), k = r.width / view.store.slots[i].size.width;
      const target = el.querySelector('canvas.nb-ink-bitmap') || el;
      const fire = (t, [x, y], p) => target.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: type, pressure: p,
        clientX: r.left + x * k, clientY: r.top + y * k, bubbles: true, cancelable: true, button: 0, buttons: t === 'pointerup' ? 0 : 1 }));
      fire('pointerdown', pts[0], 0.3);
      for (let j = 1; j < pts.length; j++) { fire('pointermove', pts[j], 0.3 + 0.5 * j / pts.length); if (gap) await sleep(gap); }
      fire('pointerup', pts[pts.length - 1], 0);
    },
    wave: (x0, y0, n = 60) => Array.from({ length: n }, (_, j) => [x0 + j * 8, y0 + 20 * Math.sin(j / 6)]),
    /** Pixels of page i's bitmap that differ clearly from the paper colour. */
    ink(i) {
      const c = pages()[i].querySelector('canvas.nb-ink-bitmap');
      if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - d[0]) + Math.abs(d[k + 1] - d[1]) + Math.abs(d[k + 2] - d[2]) > 60) n++;
      return n;
    },
    /** The colour at page px (x, y) of page i's bitmap. */
    pixel(i, x, y) {
      const c = pages()[i].querySelector('canvas.nb-ink-bitmap'), s = c.width / view.store.slots[i].size.width;
      return [...c.getContext('2d').getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data.slice(0, 3)];
    },
    /** Pixels of page i's bitmap within `tol` of the colour `rgb`. */
    near(i, rgb, tol = 24) {
      const c = pages()[i].querySelector('canvas.nb-ink-bitmap');
      if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - rgb[0]) <= tol && Math.abs(d[k + 1] - rgb[1]) <= tol && Math.abs(d[k + 2] - rgb[2]) <= tol) n++;
      return n;
    },
    /** Picks the template with this label in the open chooser (the newest modal). */
    async choose(label) {
      const m = modals[modals.length - 1];
      [...m.contentEl.querySelectorAll('.suggestion-item')].find(e => e.textContent === label).click();
      await sleep(150);  // the template image loads, then the page is redrawn
    },
    /** The template name of each page of the open note. */
    templates: () => view.store.slots.map(s => ink.templateName(view.store.page(s).template)),
    /** Pixels on the live overlays (head and tail) with at least `min` alpha. */
    liveInk(min = 1) {
      let n = 0;
      for (const c of view.contentEl.querySelectorAll('canvas.nb-ink-live')) {
        if (!c.width) continue;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let k = 3; k < d.length; k += 4) if (d[k] >= min) n++;
      }
      return n;
    },
    /**
     * A pen stroke on page i through `pts` ([x, y, p] in page px), as the iPad sends it: `per`
     * coalesced samples per pointermove and `predict` predicted ones, waiting for an animation
     * frame after each event. With `up` false the stroke is left in progress.
     */
    async pen(i, pts, { type = 'pen', id = 11, per = 4, predict = 2, up = true } = {}) {
      const el = pages()[i], r = el.getBoundingClientRect(), k = r.width / view.store.slots[i].size.width;
      const target = el.querySelector('canvas.nb-ink-bitmap') || el;
      const init = ([x, y, p]) => ({ pointerId: id, pointerType: type, pressure: p, clientX: r.left + x * k, clientY: r.top + y * k,
        bubbles: true, cancelable: true, button: 0, buttons: 1 });
      target.dispatchEvent(new PointerEvent('pointerdown', init(pts[0])));
      for (let j = 1; j < pts.length; j += per) {
        const group = pts.slice(j, j + per);
        const coalescedEvents = group.map(q => new PointerEvent('pointermove', init(q)));
        const predictedEvents = pts.slice(j + per, j + per + predict).map(q => new PointerEvent('pointermove', init(q)));
        target.dispatchEvent(new PointerEvent('pointermove', { ...init(group[group.length - 1]), coalescedEvents, predictedEvents }));
        await new Promise(res => requestAnimationFrame(res));
      }
      if (up) T.penUp(i, pts[pts.length - 1], id, type);
    },
    penUp(i, [x, y], id = 11, type = 'pen', kind = 'pointerup') {
      const el = pages()[i], r = el.getBoundingClientRect(), k = r.width / view.store.slots[i].size.width;
      el.dispatchEvent(new PointerEvent(kind, { pointerId: id, pointerType: type, clientX: r.left + x * k, clientY: r.top + y * k, bubbles: true, cancelable: true, button: 0, buttons: 0 }));
    },
    /** Handwriting-like loops from (x0, y0): n samples about 0.4 px apart, pressure p(j). */
    loops: (x0, y0, n, p = j => 0.08 + 0.1 * Math.sin(j / 40)) => Array.from({ length: n }, (_, j) => {
      const a = j / 14;
      return [x0 + j * 0.28 - 7 * Math.sin(a), y0 - 9 * (1 - Math.cos(a)), p(j)];
    }),
    /** The outline's vertical extent near page x, for a stroke along x. */
    widthAt(d, x) {
      const ys = [], re = /[ML](-?[\d.]+) (-?[\d.]+)/g;
      for (let m = re.exec(d); m; m = re.exec(d)) if (Math.abs(Number(m[1]) - x) < 1.5) ys.push(Number(m[2]));
      return Math.max(...ys) - Math.min(...ys);
    },
    /** Dispatches a TouchEvent with one touch of this touchType at element `el`; returns defaultPrevented. */
    touch(el, type, touchType) {
      const r = el.getBoundingClientRect();
      const t = new Touch({ identifier: 1, target: el, clientX: r.left + 5, clientY: r.top + 5 });
      Object.defineProperty(t, 'touchType', { value: touchType });  // Chromium's Touch has no touchType
      const e = new TouchEvent(type, { changedTouches: [t], touches: [t], bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    },
    strokesOnDisk: path => ink.readPage(fs.get(path)).strokes.length,
    /** Writes to a path through the vault API since T.mark(). */
    writesTo: path => app.vault.writes.slice(T.marked).filter(p => p === path).length,
    mark() { T.marked = app.vault.writes.length; },
    marked: 0,
    setVisibility(v) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
      document.dispatchEvent(new Event('visibilitychange'));
    },
    /** Renders an SVG file as an <img> and counts dark pixels (n) and non-white ones (marks). */
    async imageInk(path) {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fs.get(path));
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight), g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, marks = 0;
      for (let k = 0; k < d.length; k += 4) {
        if (d[k] < 200) n++;
        if (d[k] < 250) marks++;
      }
      return { n, marks, w: img.naturalWidth, h: img.naturalHeight };
    },
  };
}"""

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(device_scale_factor=2, viewport={'width': 1000, 'height': 700})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.add_script_tag(url=f'http://localhost:{port}/test/out/view-fixture.js')
        page.evaluate(HELPERS)
        page.evaluate("async () => { window.original = obsidian.WorkspaceLeaf.prototype.setViewState; window.p = await loadPlugin(); }")
        ev = page.evaluate

        # --- 1. New ink note, through the command's modal
        r = ev("""async () => {
          commands['new-ink-note'].callback();
          const m = modals[0], input = m.contentEl.querySelector('input');
          const had = input.value;
          input.value = 'Physics';
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          for (let i = 0; i < 50 && !(window.view && view.getViewType() === 'notebook-ink'); i++) await T.sleep(20);
          await T.sleep(100);
          const md = fs.get('Physics.md');
          const svgs = [...fs.keys()].filter(k => k.startsWith('Physics/'));
          const note = ink.readNote(md, 'Physics'), pg = ink.readPage(fs.get(svgs[0]));
          const el = T.pages()[0], sc = view.contentEl.querySelector('.nb-ink-scroll');
          const scale = (sc.clientWidth - 32) / 816;
          return { had, modals: modals.length, md, svgs, pages: note.pages, paper: note.paper, id: pg.id, size: pg.size, strokes: pg.strokes.length,
            type: view.getViewType(), file: view.file.path, els: T.pages().length, w: el.offsetWidth, h: el.offsetHeight,
            ew: Math.round(816 * scale), eh: Math.round(1056 * scale), ink: T.ink(0) };
        }""")
        print('new note:', {k: r[k] for k in ('svgs', 'pages', 'size', 'w', 'h', 'ew', 'eh')})
        check('new: the modal suggests "Untitled ink note" and closes on Enter', r['had'] == 'Untitled ink note' and r['modals'] == 0, r['had'])
        check('new: Physics.md with one page file', len(r['svgs']) == 1 and r['md'].startswith('---\nink: 1\npaper: letter\ntemplate: blank\n---\n'), r)
        check('new: the index embeds the page (readNote round trip)', r['pages'] == [r['id']] and r['svgs'][0] == f"Physics/{r['id']}.svg", r)
        check('new: the page is an empty Letter page (readPage round trip)', r['size'] == {'width': 816, 'height': 1056} and r['strokes'] == 0, r)
        check('new: opens in the ink view', r['type'] == 'notebook-ink' and r['file'] == 'Physics.md', r)
        check('new: one page element, Letter at the fitted scale', r['els'] == 1 and abs(r['w'] - r['ew']) <= 1 and abs(r['h'] - r['eh']) <= 1, r)
        check('new: the empty page renders blank', r['ink'] == 0, r['ink'])
        r = ev("async () => { await p.createInkNote('Physics'); await T.sleep(50); const a = view.file.path; await p.createInkNote('a/b: c?', ''); return [a, view.file.path]; }")
        check('new: a taken name gets a number; unsafe characters are replaced', r == ['Physics 1.md', 'a b c.md'], r)
        ev("async () => { dirs.add('School'); await p.createInkNote('Waves', 'School'); }")
        check('new: in a folder', ev("() => view.file.path === 'School/Waves.md' && [...fs.keys()].some(k => k.startsWith('School/Waves/p-'))"))

        # --- 2. Write, with the 2 s autosave
        ev("async () => { await app.workspace.getLeaf(false).openFile(app.vault.getFile('Physics.md')); await T.sleep(100); }")
        path = ev("() => view.store.slots[0].path")
        r = ev("""async () => {
          const before = T.ink(0);
          T.mark();
          await T.stroke(0, T.wave(100, 200));
          window.t1 = performance.now();
          const liveAfter = T.liveInk();
          await T.stroke(0, T.wave(100, 400), 'touch', 9);  // a finger: palm rejection
          const s = view.store.slots[0].page.strokes;
          return { before, after: T.ink(0), liveAfter, count: s.length, stroke: s[0] && { ...s[0], points: s[0].points.length,
            ps: new Set(s[0].points.map(q => q.p.toFixed(2))).size, t: s[0].points.map(q => q.t) }, onDisk: T.writesTo(view.store.slots[0].path) };
        }""")
        st = r['stroke']
        check('write: the pen stroke is drawn into the page bitmap', r['before'] == 0 and r['after'] > 500, (r['before'], r['after']))
        check('write: the live canvas is cleared after pointerup', r['liveAfter'] == 0, r['liveAfter'])
        check('write: a finger touch draws nothing', r['count'] == 1, r['count'])
        check('write: the stroke is in the page model (pen, uniform, default ink, 2.5 px)',
              st and st['tool'] == 'pen' and st['nib'] == 'uniform' and st['color'] == '#000000' and st['size'] == 2.5 and st['points'] > 50, st)
        check('write: points carry pressure and increasing ms', st and st['ps'] > 5 and st['t'][0] == 0 and all(a <= b for a, b in zip(st['t'], st['t'][1:])) and st['t'][-1] > 100, st and st['t'][-3:])
        check('write: nothing written at once', r['onDisk'] == 0, r['onDisk'])
        ev("async () => { await T.sleep(500 - (performance.now() - t1)); await T.stroke(0, T.wave(100, 300), 'pen', 7, 0); window.t2 = performance.now(); window.pageObj = view.store.slots[0].page; }")
        r = ev(f"async () => {{ await T.sleep(1700 - (performance.now() - t1)); return T.writesTo('{path}'); }}")
        check('write: a second stroke 0.5 s later: no write 1.7 s after the first stroke', r == 0, r)
        r = ev(f"async () => {{ await T.sleep(2500 - (performance.now() - t2)); return [T.writesTo('{path}'), T.strokesOnDisk('{path}'), view.store.slots[0].page === pageObj, notices.length]; }}")
        check('write: one write 2 s after the last stroke, holding both strokes', r[0] == 1 and r[1] == 2, r)
        check('write: our own write is not reloaded as a change on disk', r[2] and r[3] == 0, r)

        # --- 3. Hidden and pagehide save at once; a real mouse drag draws
        box = page.locator('.nb-ink-page').first.bounding_box()
        page.mouse.move(box['x'] + 100, box['y'] + 420)
        page.mouse.down()
        for i in range(30):
            page.mouse.move(box['x'] + 100 + i * 12, box['y'] + 420 + (i % 8) * 3, steps=2)
        page.mouse.up()
        r = ev(f"async () => {{ const n = view.store.slots[0].page.strokes.length; T.setVisibility('hidden'); await T.sleep(60); const disk = T.strokesOnDisk('{path}'); T.setVisibility('visible'); return [n, disk]; }}")
        check('hidden: a mouse drag draws a stroke', r[0] == 3, r)
        check('hidden: going to the background writes at once', r[1] == 3, r)
        r = ev(f"async () => {{ await T.stroke(0, T.wave(100, 520), 'pen', 7, 0); window.dispatchEvent(new Event('pagehide')); await T.sleep(60); return T.strokesOnDisk('{path}'); }}")
        check('hidden: pagehide writes at once', r == 4, r)

        # --- 4. Close and reopen
        r = ev(f"""async () => {{
          await T.stroke(0, T.wave(100, 640), 'pen', 7, 0);
          await app.workspace.activeLeaf.detach();
          await T.sleep(30);
          const onClose = T.strokesOnDisk('{path}');
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Physics.md'));
          await T.sleep(100);
          return {{ onClose, type: view.getViewType(), loaded: view.stats.pagesLoaded, strokes: view.store.page(view.store.slots[0]).strokes.length, ink: T.ink(0) }};
        }}""")
        check('reopen: closing the view writes at once', r['onClose'] == 5, r)
        check('reopen: opens as ink with its page loaded', r['type'] == 'notebook-ink' and r['loaded'] == 1, r)
        check('reopen: the strokes are back and drawn', r['strokes'] == 5 and r['ink'] > 1500, r)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'view_written.png'))
        r = ev(f"() => T.imageInk('{path}')")
        check('reopen: the saved page renders as a plain SVG image, without the plugin', r['n'] > 1000 and r['w'] == 816 and r['h'] == 1056, r)

        # --- 5. Changes on disk
        r = ev(f"""async () => {{
          const pg = ink.readPage(fs.get('{path}'));
          pg.strokes.length = 2;
          const inkBefore = T.ink(0);
          externalWrite('{path}', ink.writePage(pg));
          await T.sleep(150);
          return {{ strokes: view.store.page(view.store.slots[0]).strokes.length, inkBefore, inkAfter: T.ink(0), notices: notices.length }};
        }}""")
        check('disk: with no unsaved changes, a changed page reloads', r['strokes'] == 2 and r['inkAfter'] < r['inkBefore'] and r['notices'] == 0, r)
        r = ev(f"""async () => {{
          await T.stroke(0, T.wave(100, 760), 'pen', 7, 0);
          const pg = ink.readPage(fs.get('{path}'));
          pg.strokes.length = 1;
          const text = ink.writePage(pg);
          externalWrite('{path}', text);
          await T.sleep(100);
          externalWrite('{path}', text);  // the same change reported again
          await T.sleep(100);
          const kept = view.store.page(view.store.slots[0]).strokes.length, shown = [...notices];
          await T.sleep(2300);
          return {{ kept, shown, onDisk: T.strokesOnDisk('{path}') }};
        }}""")
        check('disk: with an unsaved change, the change is kept', r['kept'] == 3, r)
        check('disk: ... and one notice says so', len(r['shown']) == 1 and 'changed on disk; your unsaved changes are kept' in r['shown'][0], r['shown'])
        check('disk: ... and the kept change is saved over it', r['onDisk'] == 3, r)

        # --- 6. Add page
        r = ev("""async () => {
          view.contentEl.querySelector('.nb-ink-add').click();
          const now = [view.store.slots.length, T.pages().length];
          await T.sleep(2400);
          const note = ink.readNote(fs.get('Physics.md'), 'Physics');
          const ids = view.store.slots.map(s => s.id);
          const newPath = `Physics/${ids[1]}.svg`;
          const pg = fs.has(newPath) ? ink.readPage(fs.get(newPath)) : null;
          const sc = view.contentEl.querySelector('.nb-ink-scroll'), el = T.pages()[1];
          return { now, ids, pages: note.pages, md: fs.get('Physics.md'), pg: pg && { size: pg.size, strokes: pg.strokes.length, tpl: pg.template.kind },
            visible: el.offsetTop < sc.scrollTop + sc.clientHeight && el.offsetTop + el.offsetHeight > sc.scrollTop, rendered: T.ink(1) };
        }""")
        check('add page: a second page element at once', r['now'] == [2, 2], r['now'])
        check('add page: its file is written (Letter, blank, empty)', r['pg'] == {'size': {'width': 816, 'height': 1056}, 'strokes': 0, 'tpl': 'blank'}, r['pg'])
        check('add page: the index has two embeds in order', r['pages'] == r['ids'] and len(r['ids']) == 2 and r['md'].count('![](Physics/') == 2, r['md'])
        check('add page: scrolled to the new page, which is drawn', r['visible'] and r['rendered'] == 0, r)
        r = ev("""async () => {
          const extra = 'Physics/p-00e0e0.svg';
          const pg = ink.readPage(fs.get(`Physics/${view.store.slots[0].id}.svg`));
          pg.id = 'p-00e0e0';
          externalWrite(extra, ink.writePage(pg));
          const note = ink.readNote(fs.get('Physics.md'), 'Physics');
          note.pages = [note.pages[0], 'p-00e0e0', 'p-0bad00', note.pages[1]];  // p-0bad00 has no file
          externalWrite('Physics.md', ink.writeNote(note));
          await T.sleep(200);
          return { ids: view.store.slots.map(s => s.id), els: T.pages().length, errors: T.pages().map(e => e.classList.contains('is-error')),
            text: (T.pages()[2].querySelector('.nb-ink-error') || {}).textContent, notices: notices.length };
        }""")
        check('disk: a changed index reloads, with a new page in order', r['els'] == 4 and r['ids'][1] == 'p-00e0e0', r)
        check('disk: a missing page file shows a placeholder and the rest still works', r['errors'] == [False, False, True, False] and 'missing' in (r['text'] or ''), r)

        # --- dark theme
        r = ev("""async () => {
          view.contentEl.querySelector('.nb-ink-scroll').scrollTop = 0;
          await T.sleep(100);
          document.body.classList.add('theme-dark');
          app.workspace.trigger('css-change');
          const st = view.store.slots[0].page.strokes[0].points[10];
          const res = { paper: T.pixel(0, 5, 5), ink: T.pixel(0, st.x, st.y) };
          document.body.classList.remove('theme-dark');
          app.workspace.trigger('css-change');
          res.lightPaper = T.pixel(0, 5, 5);
          res.lightInk = T.pixel(0, st.x, st.y);
          return res;
        }""")
        check('theme: dark paper and default ink in dark mode', r['paper'] == [0x1e, 0x1e, 0x1e] and all(abs(a - b) < 40 for a, b in zip(r['ink'], [0xe6, 0xe3, 0xde])), r)
        check('theme: white paper and near-black ink in light mode', r['lightPaper'] == [255, 255, 255] and all(abs(a - b) < 40 for a, b in zip(r['lightInk'], [0x1f, 0x1f, 0x1f])), r)

        # --- 7. A 20-page note with 300 strokes per page
        r = ev("""async () => {
          const files = ink.largeNote('Big', 'Lecture', 20, 300);
          dirs.add('Big'); dirs.add('Big/Lecture');
          for (const [k, v] of Object.entries(files)) fs.set(k, v);
          const bytes = Object.values(files).reduce((n, s) => n + s.length, 0);
          const leaf = app.workspace.getLeaf('tab');
          const t0 = performance.now();
          await leaf.openFile(app.vault.getFile('Big/Lecture.md'));
          const wall = performance.now() - t0;
          const atOpen = view.stats.pagesRendered;
          await T.sleep(800);
          const rendered = () => T.pages().map((e, i) => e.querySelector('canvas.nb-ink-bitmap') ? i : -1).filter(i => i >= 0);
          const top = rendered();
          return { bytes, wall, open: view.stats.openMs, render: view.stats.lastRenderMs, loaded: view.stats.pagesLoaded, atOpen, top, stat: view.stats.pagesRendered, ink0: T.ink(0) };
        }""")
        print(f"large note: {r['bytes'] / 1e6:.1f} MB in 21 files; opened in {r['wall']:.0f} ms (view's own measure {r['open']:.0f} ms); "
              f"one page renders in {r['render']:.0f} ms; bitmaps at open {r['atOpen']}, after settling {r['top']}")
        check('large: opens with all 20 pages loaded', r['loaded'] == 20, r['loaded'])
        check('large: opens in under 1 s here', r['wall'] < 1000, r['wall'])
        check('large: only pages near the top have bitmaps', r['atOpen'] <= 2 and 1 <= len(r['top']) <= 4 and r['top'][0] == 0 and r['stat'] == len(r['top']), r)
        check('large: the first page is drawn', r['ink0'] > 10000, r['ink0'])
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'view_large_top.png'))
        r = ev("""async () => {
          const sc = view.contentEl.querySelector('.nb-ink-scroll');
          const frames = [];
          let last = performance.now();
          while (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1) {
            sc.scrollTop += 120;
            await new Promise(r => requestAnimationFrame(r));
            const now = performance.now(); frames.push(now - last); last = now;
          }
          await T.sleep(800);
          const rendered = T.pages().map((e, i) => e.querySelector('canvas.nb-ink-bitmap') ? i : -1).filter(i => i >= 0);
          frames.sort((a, b) => a - b);
          return { rendered, stat: view.stats.pagesRendered, n: frames.length, median: frames[frames.length >> 1], p95: frames[Math.floor(frames.length * 0.95)], worst: frames[frames.length - 1], ink19: T.ink(19) };
        }""")
        print(f"large note scroll: {r['n']} frames, median {r['median']:.0f} ms, 95th percentile {r['p95']:.0f} ms, worst {r['worst']:.0f} ms; bitmaps at the bottom {r['rendered']}")
        check('large: at the bottom the bitmaps moved to the last pages', r['rendered'] and r['rendered'][-1] == 19 and 0 not in r['rendered'] and len(r['rendered']) <= 4, r['rendered'])
        check('large: the last page is drawn', r['ink19'] > 10000, r['ink19'])
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'view_large_bottom.png'))

        # --- 8. Takeover
        r = ev("""async () => {
          const leaf = app.workspace.getLeaf(false);
          await leaf.setViewState({ type: 'markdown', state: { file: 'Physics.md' } });
          const a = leaf.view.getViewType();
          window.coldCache = true;
          await leaf.setViewState({ type: 'markdown', state: { file: 'Physics 1.md' } });
          const cold = leaf.view.getViewType();
          window.coldCache = false;
          await leaf.setViewState({ type: 'markdown', state: { file: 'Physics.md' } });
          view.actionsEl.querySelector('[aria-label="Open as markdown"]').click();
          await T.sleep(100);
          const b = leaf.view.getViewType(), text = view.contentEl.textContent;
          await leaf.setViewState({ type: 'markdown', state: leaf.view.getState() });  // as a mode switch would
          const c = leaf.view.getViewType();
          const menu = new obsidian.Menu();
          app.workspace.trigger('file-menu', menu, app.vault.getFile('Physics.md'), 'more-options', leaf);
          const cmd = commands['open-as-ink-note'].checkCallback(true);
          commands['open-as-ink-note'].checkCallback(false);
          await T.sleep(100);
          const d = leaf.view.getViewType();
          view.actionsEl.querySelector('[aria-label="Open as markdown"]').click();
          await T.sleep(100);
          await leaf.openFile(app.vault.getFile('Physics 1.md'));
          const e = leaf.view.getViewType();
          await leaf.openFile(app.vault.getFile('Physics.md'));
          return { a, cold, b, c, d, e, f: leaf.view.getViewType(), text: text.slice(0, 80), menu: menu.items.map(i => i.title), cmd };
        }""")
        check('takeover: an ink note opened as markdown becomes the ink view', r['a'] == 'notebook-ink', r)
        check('takeover: also before the metadata cache has the file', r['cold'] == 'notebook-ink', r)
        check('takeover: "Open as markdown" shows the markdown', r['b'] == 'markdown' and 'ink: 1' in r['text'], r)
        check('takeover: ... and it stays markdown when its state is set again', r['c'] == 'markdown', r)
        check('takeover: "Open as ink note" in the file menu and as a command', r['menu'] == ['Open as ink note'] and r['cmd'] is True and r['d'] == 'notebook-ink', r)
        check('takeover: after showing another file, the note opens as ink again', r['e'] == 'notebook-ink' and r['f'] == 'notebook-ink', r)

        # --- 9. Markdown without ink frontmatter stays markdown
        r = ev("""async () => {
          fs.set('Plain.md', '---\\ntags: [a]\\ninky: 1\\n---\\n# Plain\\n');
          fs.set('Bare.md', '# No frontmatter\\n\\nink: 1\\n');
          const leaf = app.workspace.getLeaf(false), out = [];
          for (const cold of [false, true]) {
            window.coldCache = cold;
            for (const f of ['Plain.md', 'Bare.md']) { await leaf.openFile(app.vault.getFile(f)); out.push(leaf.view.getViewType()); }
          }
          window.coldCache = false;
          return out;
        }""")
        check('no takeover: frontmatter without ink, or no frontmatter, opens as markdown', r == ['markdown'] * 4, r)

        # --- 10. Templates: settings default, new-note dialog, change a written page, add pages, reopen
        r = ev("""async () => {
          const tab = p.settingTabs[0];
          tab.display();
          const names = [...tab.containerEl.querySelectorAll('.setting-item')].map(e => e.dataset.name);
          const sel = tab.containerEl.querySelector('.setting-item[data-name="Default template for new notes"] select');
          const options = [...sel.options].map(o => o.value);
          sel.value = 'lined-college-margin';
          sel.dispatchEvent(new Event('change'));
          await T.sleep(10);
          const saved = pluginData && pluginData.template;
          commands['new-ink-note'].callback();
          const m = modals[0], selects = [...m.contentEl.querySelectorAll('select')];
          const defaults = selects.map(s => s.value);
          selects[0].value = 'a4';
          selects[0].dispatchEvent(new Event('change'));
          const input = m.contentEl.querySelector('input');
          input.value = 'Paper';
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          for (let i = 0; i < 50 && !(view.file && view.file.path === 'Paper.md' && view.store); i++) await T.sleep(20);
          await T.sleep(200);
          const note = ink.readNote(fs.get('Paper.md'), 'Paper'), path = view.store.slots[0].path, pg = ink.readPage(fs.get(path));
          return { names, options, saved, defaults, paper: note.paper, noteTpl: note.template, tpl: ink.templateName(pg.template), size: pg.size, path,
            line: T.near(0, [0xc9, 0xc9, 0xc9], 6), dark: T.near(0, [0x3c, 0x3c, 0x3c], 6), pink: T.near(0, [0xe8, 0xa0, 0xa0], 12) };
        }""")
        tpath = r['path']
        print('templates:', {k: r[k] for k in ('defaults', 'paper', 'noteTpl', 'tpl', 'line', 'dark', 'pink')})
        check('templates: the settings have a default template beside the paper size, saved on change',
              r['names'] == ['Default paper size', 'Default template for new notes'] and len(r['options']) == 8 and r['saved'] == 'lined-college-margin', r)
        check('templates: the new-note dialog offers paper and template, defaulting to the settings', r['defaults'] == ['letter', 'lined-college-margin'], r['defaults'])
        check('templates: the note is A4 with the chosen template, in the index and its first page',
              r['paper'] == 'a4' and r['noteTpl'] == 'lined-college-margin' and r['tpl'] == 'lined-college-margin' and r['size'] == {'width': 794, 'height': 1123}, r)
        check('templates: the bitmap has light template lines and the pink margin (explicit colours)', r['line'] > 2000 and r['pink'] > 300 and r['dark'] == 0, r)
        r = ev("""async () => {
          document.body.classList.add('theme-dark');
          app.workspace.trigger('css-change');
          await T.sleep(200);
          const res = { paper: T.pixel(0, 5, 5), dark: T.near(0, [0x3c, 0x3c, 0x3c], 6), light: T.near(0, [0xc9, 0xc9, 0xc9], 6), pink: T.near(0, [0xe8, 0xa0, 0xa0], 12) };
          document.body.classList.remove('theme-dark');
          app.workspace.trigger('css-change');
          await T.sleep(200);
          return res;
        }""")
        check('templates: in the dark theme the lines are dark grey, the margin still pink', r['paper'] == [0x1e] * 3 and r['dark'] > 2000 and r['light'] == 0 and r['pink'] > 300, r)
        r = ev(f"""async () => {{
          await T.stroke(0, T.wave(200, 300));
          const strokes = view.store.page(view.store.slots[0]).strokes.length;
          const shown = commands['change-page-template'].checkCallback(true);
          commands['change-page-template'].checkCallback(false);
          const labels = [...modals[0].contentEl.querySelectorAll('.suggestion-item')].map(e => e.textContent);
          await T.choose('Grid, 5 mm');
          const after = {{ strokes: view.store.page(view.store.slots[0]).strokes.length, tpl: T.templates()[0], grid: T.near(0, [0xc9, 0xc9, 0xc9], 6), pink: T.near(0, [0xe8, 0xa0, 0xa0], 12) }};
          await view.save();
          const pg = ink.readPage(fs.get('{tpath}'));
          const img = await T.imageInk('{tpath}');
          // The previous template comes back, for undo; setting it again restores the page.
          const prev = view.setPageTemplate(0, {{ kind: 'blank' }});
          await T.sleep(50);
          const blankLines = T.near(0, [0xc9, 0xc9, 0xc9], 6);
          view.setPageTemplate(0, prev);
          await T.sleep(150);
          return {{ strokes, shown, labels, after, disk: {{ tpl: ink.templateName(pg.template), strokes: pg.strokes.length }}, img,
            prev: ink.templateName(prev), blankLines, again: T.templates()[0], gridAgain: T.near(0, [0xc9, 0xc9, 0xc9], 6) }};
        }}""")
        print('templates: change page:', {k: r[k] for k in ('strokes', 'after', 'disk', 'img', 'prev', 'blankLines', 'gridAgain')})
        check('templates: "Change template of this page" is offered in an ink view and lists the eight templates',
              r['shown'] is True and r['labels'][0] == 'Blank' and 'Lined, college rule, with margin' in r['labels'] and len(r['labels']) == 8, r['labels'])
        check('templates: lined to grid keeps the writing and redraws the page',
              r['strokes'] == 1 and r['after']['strokes'] == 1 and r['after']['tpl'] == 'grid-5mm' and r['after']['grid'] > 5000 and r['after']['pink'] == 0, r)
        check('templates: the page file says grid-5mm and still has the stroke', r['disk'] == {'tpl': 'grid-5mm', 'strokes': 1}, r['disk'])
        check('templates: the saved page renders as a plain SVG image, grid and stroke', r['img']['marks'] > 50000 and r['img']['n'] > 500 and r['img']['w'] == 794, r['img'])
        check('templates: setPageTemplate returns the previous template, and setting it back restores the page',
              r['prev'] == 'grid-5mm' and r['blankLines'] < 1000 and r['again'] == 'grid-5mm' and abs(r['gridAgain'] - r['after']['grid']) < 50, r)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'view_templates_grid.png'))
        r = ev("""async () => {
          view.contentEl.querySelector('.nb-ink-add-with').click();
          await T.choose('Dots, 5 mm');
          view.contentEl.querySelector('.nb-ink-add-with').click();
          await T.choose('Lined, wide rule');
          const current = view.currentPageIndex();
          view.contentEl.querySelector('.nb-ink-add').click();  // the note's default
          await T.sleep(150);
          const live = T.templates();
          await app.workspace.activeLeaf.detach();
          await T.sleep(30);
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Paper.md'));
          await T.sleep(200);
          const ids = view.store.slots.map(s => s.id);
          return { current, live, reopened: T.templates(), disk: ids.map(id => ink.templateName(ink.readPage(fs.get(`Paper/${id}.svg`)).template)),
            strokes: view.store.page(view.store.slots[0]).strokes.length, grid: T.near(0, [0xc9, 0xc9, 0xc9], 6) };
        }""")
        print('templates: add pages and reopen:', r)
        check('templates: "Add page with template..." adds pages with the chosen templates; "Add page" uses the note default',
              r['live'] == ['grid-5mm', 'dots-5mm', 'lined-wide', 'lined-college-margin'], r['live'])
        check('templates: the current page is the one scrolled to', r['current'] == 2, r['current'])
        check('templates: closed and reopened, every page has its template back', r['reopened'] == r['live'] and r['disk'] == r['live'] and r['strokes'] == 1 and r['grid'] > 5000, r)
        page.evaluate("() => { view.contentEl.querySelector('.nb-ink-scroll').scrollTop = 1400; }")
        page.wait_for_timeout(300)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'view_templates_light.png'))
        page.evaluate("() => { document.body.classList.add('theme-dark'); app.workspace.trigger('css-change'); }")
        page.wait_for_timeout(300)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'view_templates_dark.png'))
        page.evaluate("() => { document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change'); }")
        r = ev("""async () => {
          view.contentEl.querySelector('.nb-ink-scroll').scrollTop = 0;
          await T.sleep(100);
          view.actionsEl.querySelector('[aria-label="Change template of all pages"]').click();
          await T.choose('Grid, ¼ in');
          await view.save();
          const note = ink.readNote(fs.get('Paper.md'), 'Paper');
          const disk = note.pages.map(id => ink.templateName(ink.readPage(fs.get(`Paper/${id}.svg`)).template));
          const strokes = ink.readPage(fs.get(`Paper/${note.pages[0]}.svg`)).strokes.length;
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(app.vault.getFile('Plain.md'));
          const hidden = [commands['change-page-template'].checkCallback(true), commands['change-all-templates'].checkCallback(true)];
          return { noteTpl: note.template, disk, strokes, hidden };
        }""")
        check('templates: "Change template of all pages" (view action) changes every page and the note default',
              r['noteTpl'] == 'grid-quarter-inch' and r['disk'] == ['grid-quarter-inch'] * 4 and r['strokes'] == 1, r)
        check('templates: the template commands are hidden outside an ink view', r['hidden'] == [False, False], r['hidden'])

        # --- 11. The pen
        ev("async () => { await p.createInkNote('Pen'); await T.sleep(150); }")
        pen_path = ev("() => view.store.slots[0].path")
        # (1) nibs: a straight line with pressure rising from 0.05 to 0.9
        r = ev(f"""async () => {{
          const line = Array.from({{ length: 401 }}, (_, j) => [100 + j, 100, 0.05 + 0.85 * j / 400]);
          await T.pen(0, line);
          view.setPen({{ nib: 'pressure' }});
          await T.pen(0, line.map(([x, y, p]) => [x, y + 40, p]));
          view.setPen({{ nib: 'uniform' }});
          await view.save();
          const disk = ink.readPage(fs.get('{pen_path}')).strokes;
          const w = s => {{ const d = ink.strokePath(s); return [T.widthAt(d, 150), T.widthAt(d, 450)]; }};
          return {{ nibs: disk.map(s => s.nib), uniform: w(disk[0]), pressure: w(disk[1]), ps: [disk[0].points[50].p, disk[0].points[350].p] }};
        }}""")
        print('pen: widths at low and high pressure:', r)
        check('pen: strokes save with their nib (uniform by default)', r['nibs'] == ['uniform', 'pressure'], r['nibs'])
        check('pen: the uniform nib is 2.5 px wide whatever the pressure', all(abs(w - 2.5) < 0.3 for w in r['uniform']) and r['ps'][1] > r['ps'][0] + 0.5, r)
        check('pen: the pressure nib gets wider with pressure', r['pressure'][1] > r['pressure'][0] * 1.4, r['pressure'])

        # (2) mid-stroke: the overlay has the live outline; after pointerup it's clear and the bitmap has the stroke
        r = ev("""async () => {
          T.pts = T.loops(120, 230, 150);
          const before = T.ink(0);
          await T.pen(0, T.pts, { predict: 0, up: false });
          const inp = view.input, live = inp.live;
          const points = live.trace.points.map(q => ({ ...q }));
          // alpha 145 over white paper is where the ink (#1f1f1f) gets darker than 128
          return { before, live: T.liveInk(), live145: T.liveInk(145), frames: live.frames.length, events: live.events,
            same: inp.livePath === ink.strokePath({ tool: 'pen', nib: 'uniform', size: 2.5, points }), points: points.length };
        }""")
        check('pen: mid-stroke, the live overlay has ink after the frames', r['live'] > 300 and r['frames'] >= 10, r)
        check('pen: the live outline is strokePath of the points so far (same options, same code)', r['same'], r)
        page.locator('.nb-ink-page').first.screenshot(path=os.path.join(OUT, 'pen_live_light.png'))
        live_px = r['live145']
        r = ev("""async () => {
          const n = view.store.slots[0].page.strokes.length;
          T.penUp(0, T.pts[T.pts.length - 1]);
          const s = view.store.slots[0].page.strokes;
          return { live: T.liveInk(), added: s.length - n, ink: T.ink(0), stroke: s[s.length - 1].points.length };
        }""")
        check('pen: after pointerup the overlay is clear and the stroke is in the page', r['live'] == 0 and r['added'] == 1, r)
        page.locator('.nb-ink-page').first.screenshot(path=os.path.join(OUT, 'pen_committed_light.png'))
        # The committed bitmap stroke covers as many pixels as the live one did (same outline).
        r2 = ev("""() => {
          const c = T.pages()[0].querySelector('canvas.nb-ink-bitmap'), s = c.width / 816, g = c.getContext('2d');
          const d = g.getImageData(Math.round(100 * s), Math.round(200 * s), Math.round(120 * s), Math.round(45 * s)).data;
          let n = 0;
          for (let k = 0; k < d.length; k += 4) if (d[k] < 128) n++;
          return n;
        }""")
        check('pen: the committed stroke covers the same pixels as the live one', abs(r2 - live_px) < live_px * 0.03, (live_px, r2))

        # the same in the dark theme
        ev("async () => { document.body.classList.add('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(100); T.pts = T.loops(120, 300, 150); await T.pen(0, T.pts, { up: false }); }")
        page.locator('.nb-ink-page').first.screenshot(path=os.path.join(OUT, 'pen_live_dark.png'))
        r = ev("""() => {
          const c = view.contentEl.querySelector('canvas.nb-ink-live-tail'), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data;
          for (let k = 0; k < d.length; k += 4) if (d[k + 3] === 255) return [d[k], d[k + 1], d[k + 2]];
          return null;
        }""")
        check('pen: in the dark theme the live default ink is the light ink colour', r == [0xe6, 0xe3, 0xde], r)
        ev("() => T.penUp(0, T.pts[T.pts.length - 1])")
        page.locator('.nb-ink-page').first.screenshot(path=os.path.join(OUT, 'pen_committed_dark.png'))
        ev("async () => { document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(100); }")

        # (3) the committed stroke's path is strokePath of the saved stroke
        r = ev(f"""async () => {{
          await view.save();
          const mem = view.store.slots[0].page.strokes, text = fs.get('{pen_path}'), disk = ink.readPage(text).strokes;
          return mem.map((s, i) => {{
            const m = new RegExp(`data-id="${{s.id}}"[^>]* d="([^"]*)"`).exec(text);
            return !!m && m[1] === ink.strokePath(s) && m[1] === ink.strokePath(disk[i]) && JSON.stringify(disk[i].points) === JSON.stringify(s.points);
          }});
        }}""")
        check("pen: each committed stroke's path in the file is strokePath of the saved stroke (and of the drawn one)", len(r) == 4 and all(r), r)

        # (4) touches never draw; a stroke off the page's edge continues and keeps its points
        r = ev("""async () => {
          const n = view.store.slots[0].page.strokes.length, ignored = view.stats.pen.touchesIgnored;
          await T.pen(0, T.loops(120, 400, 80), { type: 'touch', id: 21 });
          const touch = view.store.slots[0].page.strokes.length - n;
          await T.pen(0, Array.from({ length: 80 }, (_, j) => [760 + j, 460, 0.2]));  // runs off the right edge (816)
          const s = view.store.slots[0].page.strokes;
          return { touch, ignored: view.stats.pen.touchesIgnored - ignored, off: s.length - n, maxX: Math.max(...s[s.length - 1].points.map(q => q.x)) };
        }""")
        check('pen: touches never draw and are counted', r['touch'] == 0 and r['ignored'] == 1, r)
        check('pen: a stroke that runs off the page continues', r['off'] == 1 and r['maxX'] > 816, r)

        # (5) stylus touches never scroll: prevented anywhere in the view, except a touchstart on a control
        r = ev("""() => {
          const sc = view.contentEl.querySelector('.nb-ink-scroll'), pagesEl = view.contentEl.querySelector('.nb-ink-pages');
          const add = view.contentEl.querySelector('.nb-ink-add'), swatch = view.contentEl.querySelector('.nb-ink-swatch');
          return {
            offPage: [T.touch(pagesEl, 'touchstart', 'stylus'), T.touch(pagesEl, 'touchmove', 'stylus')],
            scroller: [T.touch(sc, 'touchstart', 'stylus'), T.touch(sc, 'touchmove', 'stylus')],
            onPage: [T.touch(T.pages()[0], 'touchstart', 'stylus'), T.touch(T.pages()[0], 'touchmove', 'stylus')],
            finger: [T.touch(pagesEl, 'touchstart', 'direct'), T.touch(T.pages()[0], 'touchmove', 'direct')],
            control: [T.touch(add, 'touchstart', 'stylus'), T.touch(swatch, 'touchstart', 'stylus'), T.touch(add, 'touchmove', 'stylus')],
          };
        }""")
        check('pen: a stylus touch outside any page is prevented (touchstart and touchmove)', r['offPage'] == [True, True] and r['scroller'] == [True, True], r)
        check('pen: a stylus touch on a page is prevented', r['onPage'] == [True, True], r)
        check('pen: a finger touch is not prevented', r['finger'] == [False, False], r)
        check('pen: a stylus touchstart on a control is not prevented (taps work); touchmove is', r['control'] == [False, False, True], r)

        # (7) the pen strip and the commands set the next stroke's nib, colour and size
        r = ev(f"""async () => {{
          const strip = view.contentEl.querySelector('.nb-ink-strip'), q = sel => strip.querySelector(sel);
          const layout = {{ height: strip.offsetHeight, controls: strip.querySelectorAll('.nb-ink-control').length, swatches: strip.querySelectorAll('.nb-ink-swatch').length }};
          q('[data-nib="pressure"]').click();
          q('[data-color="#e0301e"]').click();
          q('[data-size="4"]').click();
          q('[data-step="1"]').click();
          const shown = {{ nib: q('.nb-ink-nib.is-active').dataset.nib, color: q('.nb-ink-swatch.is-active').dataset.color, value: q('.nb-ink-size-value').textContent }};
          await T.pen(0, T.loops(120, 520, 120));
          commands['pen-nib-uniform'].checkCallback(false);
          commands['pen-next-color'].checkCallback(false);
          commands['pen-next-size'].checkCallback(false);
          const afterCmds = {{ ...view.pen }};
          await T.pen(0, T.loops(120, 600, 120));
          let threw = '';
          try {{ view.setPen({{ color: 'red' }}); }} catch (e) {{ threw = e.message; }}
          view.setPen({{ color: '#ABCDEF', size: 40 }});
          const custom = {{ ...view.pen, active: strip.querySelectorAll('.nb-ink-swatch.is-active').length }};
          view.setPen({{ color: '#000000', size: 2.5 }});
          await view.save();
          const disk = ink.readPage(fs.get('{pen_path}')).strokes.slice(-2).map(s => [s.nib, s.color, s.size]);
          return {{ layout, shown, afterCmds, disk, threw, custom, red: T.near(0, [0xe0, 0x30, 0x1e], 30) }};
        }}""")
        print('pen strip:', r)
        check('pen strip: one row with nib, 8 swatches, 3 sizes and a stepper', r['layout']['height'] < 44 and r['layout']['swatches'] == 8, r['layout'])
        check('pen strip: clicks set nib, colour and size, and show them', r['shown'] == {'nib': 'pressure', 'color': '#e0301e', 'value': '4.5 px'}, r['shown'])
        check('pen strip: the next stroke saves with them, drawn in red', r['disk'][0] == ['pressure', '#e0301e', 4.5] and r['red'] > 200, r)
        check('pen commands: uniform nib, next colour and next size', r['afterCmds'] == {'tool': 'pen', 'nib': 'uniform', 'color': '#1f9d55', 'size': 1.5} and r['disk'][1] == ['uniform', '#1f9d55', 1.5], r)
        check('pen: setPen refuses a colour that is not #rrggbb, lowercases one that is, clamps sizes',
              'Invalid pen colour' in r['threw'] and r['custom'] == {'tool': 'pen', 'nib': 'uniform', 'color': '#abcdef', 'size': 16, 'active': 0}, r)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'pen_strip.png'))

        # (8) the stats overlay toggles
        r = ev("""() => {
          const el = view.contentEl.querySelector('.nb-ink-stats'), hidden = el.style.display === 'none';
          const shown = commands['toggle-ink-stats'].checkCallback(true);
          commands['toggle-ink-stats'].checkCallback(false);
          const visible = el.style.display !== 'none', text = el.textContent;
          commands['toggle-ink-stats'].checkCallback(false);
          return { hidden, shown, visible, text, hiddenAgain: el.style.display === 'none' };
        }""")
        check('stats overlay: hidden at first, toggled by "Toggle ink stats overlay"', r['hidden'] and r['shown'] and r['visible'] and r['hiddenAgain'], r)
        check('stats overlay: shows the pen and the handler and frame times', 'pen: uniform, #000000, 2.5 px' in r['text'] and 'handler' in r['text'] and 'frame' in r['text'], r['text'])
        ev("() => commands['toggle-ink-stats'].checkCallback(false)")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'pen_stats.png'))
        ev("() => commands['toggle-ink-stats'].checkCallback(false)")

        # (6) handler time with 300 strokes on the page, and a long scribble that freezes its head
        r = ev("""async () => {
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Big/Lecture.md'));
          await T.sleep(300);
          const strokes = view.store.slots[0].page.strokes.length;
          await T.pen(0, T.loops(80, 120, 200, j => 0.05 + 0.3 * j / 200));
          const a = { ...view.stats.pen.last };
          const scribble = Array.from({ length: 3000 }, (_, j) => [400 + 200 * Math.sin(j / 97) + 30 * Math.sin(j / 7), 400 + 150 * Math.cos(j / 131) + 30 * Math.cos(j / 9), 0.2]);
          await T.pen(0, scribble, { up: false, per: 8 });
          const liveTail = view.input.live.trace.points.length - view.input.live.frozen;
          const livePx = T.liveInk();
          T.penUp(0, scribble[scribble.length - 1]);
          const b = { ...view.stats.pen.last };
          return { strokes, a, b, liveTail, livePx, median10: view.stats.pen.recent.length };
        }""")
        a, b2 = r['a'], r['b']
        print(f"pen on a page with {r['strokes']} strokes: {a['points']} points, {a['events']} events, handler median {a['handlerMs']:.3f} ms "
              f"(max {a['handlerMaxMs']:.3f}), frame median {a['frameMs']:.2f} ms (max {a['frameMaxMs']:.2f}), predicted up to {a['maxPredicted']}")
        print(f"long scribble: {b2['points']} points, {b2['frozen']} frozen pieces, live tail {r['liveTail']} points, handler median {b2['handlerMs']:.3f} ms, "
              f"frame median {b2['frameMs']:.2f} ms (max {b2['frameMaxMs']:.2f})")
        check('pen perf: a 200-sample stroke on a page with 300 strokes', r['strokes'] >= 300 and a['samples'] >= 200 and a['events'] == 50, r)
        check('pen perf: median handler time under 4 ms (Chromium)', a['handlerMs'] < 4, a['handlerMs'])
        check('pen perf: coalesced and predicted events seen', a['maxPredicted'] == 2 and a['frames'] >= 40, a)
        check('pen perf: a long scribble freezes its head; the live tail stays bounded', b2['frozen'] >= 10 and r['liveTail'] <= 192 and r['livePx'] > 5000, r)
        check('pen perf: frame time does not grow with stroke length', b2['frameMs'] < max(4 * a['frameMs'], 4), (a['frameMs'], b2['frameMs']))

        # the debug view's readout shows the ink view's pen stats
        r = ev("""async () => {
          await p.openDebugView();
          await T.sleep(50);
          view.renderHud();
          return view.hud.textContent;
        }""")
        check('debug view: the readout includes the ink view pen stats', 'ink view last stroke:' in r and 'handler' in r, r)

        # ======== 12. The highlighter (#6) ========
        def near(a, b, tol):
            return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))
        ev("async () => { await app.workspace.getLeaf(false).openFile(app.vault.getFile('Pen.md')); await p.createInkNote('Highlights', undefined, 'letter', 'blank'); await T.sleep(150); }")
        hl_path = ev("() => view.store.slots[0].path")
        # The colour and alpha at page px (x, y) of the live tail canvas.
        ev("""() => {
          T.tailPixel = (x, y) => {
            const c = view.contentEl.querySelector('canvas.nb-ink-live-tail'), s = c.width / view.store.slots[0].size.width;
            return [...c.getContext('2d').getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data];
          };
        }""")
        # (1) switching tools: the command, then the strip; each tool shows its own groups
        r = ev("""() => {
          const strip = view.contentEl.querySelector('.nb-ink-strip'), q = sel => strip.querySelector(sel);
          const shown = sel => q(sel).style.display !== 'none';
          const groups = () => ({ tool: view.pen.tool, active: q('.nb-ink-tool.is-active').dataset.tool,
            pen: ['.nb-ink-nibs', '.nb-ink-colors', '.nb-ink-sizes', '.nb-ink-stepper'].map(shown), hl: shown('.nb-ink-highlighter') });
          const first = strip.firstElementChild.classList.contains('nb-ink-tools');
          const start = groups();
          const visible = commands['tool-highlighter'].checkCallback(true);
          commands['tool-highlighter'].checkCallback(false);
          const byCommand = groups();
          commands['tool-pen'].checkCallback(false);
          const back = groups();
          q('[data-tool="highlighter"]').click();
          const byStrip = { ...groups(), swatches: strip.querySelectorAll('.nb-ink-hl-swatch').length,
            sizes: [...strip.querySelectorAll('.nb-ink-hl-size')].map(b => Number(b.dataset.size)),
            color: q('.nb-ink-hl-swatch.is-active').dataset.color, height: strip.offsetHeight };
          return { first, start, visible, byCommand, back, byStrip };
        }""")
        print('highlighter: tools:', r)
        check('highlighter: the strip starts with the tool group; the pen is the default tool with its groups shown',
              r['first'] and r['start'] == {'tool': 'pen', 'active': 'pen', 'pen': [True] * 4, 'hl': False}, r)
        check('highlighter: "Use the highlighter" switches to it and shows only its group',
              r['visible'] and r['byCommand'] == {'tool': 'highlighter', 'active': 'highlighter', 'pen': [False] * 4, 'hl': True}, r)
        check('highlighter: "Use the pen" switches back', r['back'] == r['start'], r['back'])
        check('highlighter: the strip button switches to it; 5 swatches and 2 sizes, yellow active; still one row',
              r['byStrip']['tool'] == 'highlighter' and r['byStrip']['swatches'] == 5 and r['byStrip']['sizes'] == [14, 24]
              and r['byStrip']['color'] == '#ffd400' and r['byStrip']['height'] < 44, r['byStrip'])
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'highlighter_strip.png'))

        # (2) a pen stroke, a highlight over it, a pen stroke after it, and a crossing highlight of the same colour
        r = ev(f"""async () => {{
          const strip = view.contentEl.querySelector('.nb-ink-strip'), q = sel => strip.querySelector(sel);
          view.setTool('pen');
          await T.pen(0, Array.from({{ length: 60 }}, (_, j) => [200, 150 + j * 2, 0.3]));   // pen, before
          q('[data-tool="highlighter"]').click();
          q('.nb-ink-hl-size[data-size="24"]').click();
          await T.pen(0, Array.from({{ length: 200 }}, (_, j) => [100 + j * 2, 200, 0.3]));  // highlight along y 200
          view.setTool('pen');
          await T.pen(0, Array.from({{ length: 60 }}, (_, j) => [400, 150 + j * 2, 0.3]));   // pen, after
          view.setTool('highlighter');
          await T.pen(0, Array.from({{ length: 100 }}, (_, j) => [300, 100 + j * 2, 0.3]));  // highlight along x 300
          await view.save();
          const text = fs.get('{hl_path}'), disk = ink.readPage(text).strokes;
          const hlGroup = /<g id="highlight" opacity="0.4">([^]*?)<\\/g>/.exec(text)[1], inkGroup = /<g id="ink"[^>]*>([^]*?)<\\/g>/.exec(text)[1];
          const inLayer = (g, s) => g.includes(`data-id="${{s.id}}"`);
          return {{
            disk: disk.map(s => ({{ tool: s.tool, nib: s.nib ?? null, color: s.color, size: s.size }})),
            layers: disk.map(s => [inLayer(hlGroup, s), inLayer(inkGroup, s)]),
            order: text.indexOf('id="highlight"') < text.indexOf('id="ink"'),
            before: T.pixel(0, 200, 200), after: T.pixel(0, 400, 200),
            single: [T.pixel(0, 250, 200), T.pixel(0, 300, 125), T.pixel(0, 350, 200)], cross: T.pixel(0, 300, 200),
          }};
        }}""")
        print('highlighter: strokes and pixels:', r)
        check('highlighter: strokes save as tool "highlighter" with no nib, in its colour and size',
              r['disk'][1] == {'tool': 'highlighter', 'nib': None, 'color': '#ffd400', 'size': 24} and r['disk'][3]['tool'] == 'highlighter'
              and r['disk'][0]['tool'] == 'pen' and r['disk'][2] == {'tool': 'pen', 'nib': 'uniform', 'color': '#000000', 'size': 2.5}, r['disk'])
        check("highlighter: highlights are in the file's highlight layer, under the ink layer; pen strokes in the ink layer",
              r['order'] and r['layers'] == [[False, True], [True, False], [False, True], [True, False]], r['layers'])
        yellow = [255, round(255 * 0.6 + 0xd4 * 0.4), round(255 * 0.6)]
        check('highlighter: a single highlight is #ffd400 at 40% over the paper', all(near(px, yellow, 3) for px in r['single']), (r['single'], yellow))
        check('highlighter: two crossing highlights of one colour give the same pixel as one (no darker overlap)',
              near(r['cross'], r['single'][0], 2), (r['cross'], r['single']))
        check('highlighter: ink written before a highlight is drawn over it (ink colour at the crossing)', near(r['before'], [0x1f] * 3, 12), r['before'])
        check('highlighter: ink written after a highlight is drawn over it (ink colour at the crossing)', near(r['after'], [0x1f] * 3, 12), r['after'])
        page.locator('.nb-ink-page').first.screenshot(path=os.path.join(OUT, 'highlighter_light.png'))
        # The saved SVG, rendered as an image, shows the same.
        r = ev(f"""async () => {{
          const img = new Image();
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fs.get('{hl_path}'));
          await img.decode();
          const c = new OffscreenCanvas(816, 1056), g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, 816, 1056); g.drawImage(img, 0, 0, 816, 1056);
          const px = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
          return {{ single: px(250, 200), cross: px(300, 200), before: px(200, 200), after: px(400, 200), view: T.pixel(0, 250, 200) }};
        }}""")
        check('highlighter: in the saved SVG crossings are not darker, ink is over the highlights, and the colour matches the editor',
              near(r['cross'], r['single'], 3) and all(v < 60 for v in r['before'] + r['after']) and near(r['single'], r['view'], 3), r)
        ev("async () => { document.body.classList.add('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(150); }")
        page.locator('.nb-ink-page').first.screenshot(path=os.path.join(OUT, 'highlighter_dark.png'))
        r = ev("() => ({ single: T.pixel(0, 250, 200), cross: T.pixel(0, 300, 200), before: T.pixel(0, 200, 200), after: T.pixel(0, 400, 200) })")
        print('highlighter: dark theme pixels:', r)
        check('highlighter: dark theme, crossing highlights match a single one and ink stays on top',
              near(r['cross'], r['single'], 2) and near(r['before'], [0xe6, 0xe3, 0xde], 12) and near(r['after'], [0xe6, 0xe3, 0xde], 12), r)
        ev("async () => { document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(150); }")

        # (3) mid-stroke: the overlay holds translucent highlight pixels; the live outline is the saved one's
        r = ev("""async () => {
          view.setHighlighter({ color: '#3ddc84', size: 24 });
          T.pts = Array.from({ length: 120 }, (_, j) => [100 + j * 2, 400 + 10 * Math.sin(j / 15), 0.3]);
          await T.pen(0, T.pts, { predict: 0, up: false });
          const live = view.input.live, points = live.trace.points.map(q => ({ ...q }));
          const c = view.contentEl.querySelector('canvas.nb-ink-live-tail'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0, opaque = 0, maxA = 0;
          for (let k = 3; k < d.length; k += 4) if (d[k]) { n++; if (d[k] === 255) opaque++; maxA = Math.max(maxA, d[k]); }
          return { n, opaque, maxA, mid: T.tailPixel(200, 400 + 10 * Math.sin(50 / 15)), headHidden: view.input.head.style.visibility === 'hidden',
            same: view.input.livePath === ink.strokePath({ tool: 'highlighter', size: 24, points }) };
        }""")
        print('highlighter: live overlay:', r)
        check('highlighter: mid-stroke the overlay has translucent highlight pixels (the colour at 40% alpha, none opaque)',
              r['n'] > 2000 and r['opaque'] == 0 and abs(r['maxA'] - 102) <= 1 and near(r['mid'], [0x3d, 0xdc, 0x84, 102], 3), r)
        check('highlighter: the live outline is strokePath of the highlighter stroke so far', r['same'], r)
        page.locator('.nb-ink-page').first.screenshot(path=os.path.join(OUT, 'highlighter_live_light.png'))
        r = ev("""async () => {
          T.penUp(0, T.pts[T.pts.length - 1]);
          const s = view.store.slots[0].page.strokes, last = s[s.length - 1];
          return { live: T.liveInk(), tool: last.tool, color: last.color };
        }""")
        check('highlighter: after pointerup the overlay is clear and the green highlight is in the page', r['live'] == 0 and r['tool'] == 'highlighter' and r['color'] == '#3ddc84', r)

        # (4) a long highlight (600+ samples, frozen in pieces) shows no darker seam, live or committed
        r = ev("""async () => {
          view.setHighlighter({ color: '#ffd400', size: 14 });
          T.pts = Array.from({ length: 700 }, (_, j) => [60 + j, 700, 0.3]);
          await T.pen(0, T.pts, { up: false, per: 8 });
          const live = view.input.live, alphas = [];
          for (let x = 62; x <= 755; x++) alphas.push(T.tailPixel(x, 700)[3]);
          const r = { pieces: live.pieces, points: live.trace.points.length, min: Math.min(...alphas), max: Math.max(...alphas) };
          T.penUp(0, T.pts[T.pts.length - 1]);
          const px = [];
          for (let x = 62; x <= 755; x++) px.push(T.pixel(0, x, 700));
          r.bitmapMin = [0, 1, 2].map(k => Math.min(...px.map(p => p[k])));
          r.bitmapMax = [0, 1, 2].map(k => Math.max(...px.map(p => p[k])));
          return r;
        }""")
        print('highlighter: long highlight:', r)
        check('highlighter: a long live highlight is frozen in pieces and shows no darker seam (even alpha along it)',
              r['points'] >= 600 and r['pieces'] >= 2 and r['min'] >= 100 and r['max'] <= 104, r)
        check('highlighter: committed, the long highlight is even along its length', all(r['bitmapMax'][k] - r['bitmapMin'][k] <= 3 for k in range(3)), r)

        # (5) switching back to the pen restores the pen's colour and size; the highlighter keeps its own
        r = ev(f"""async () => {{
          view.setTool('pen');
          view.setPen({{ color: '#e0301e', size: 4 }});
          view.setTool('highlighter');
          commands['highlighter-next-color'].checkCallback(false);
          commands['highlighter-next-size'].checkCallback(false);
          const hl = {{ ...view.highlighter }};
          await T.pen(0, Array.from({{ length: 60 }}, (_, j) => [100 + j * 3, 800, 0.3]));
          view.setTool('pen');
          const pen = {{ ...view.pen }}, penColor = view.contentEl.querySelector('.nb-ink-strip .nb-ink-swatch.is-active')?.dataset.color ?? null;
          await T.pen(0, Array.from({{ length: 60 }}, (_, j) => [100 + j * 3, 850, 0.3]));
          view.setTool('highlighter');
          const hlAgain = {{ ...view.highlighter }};
          let threw = '';
          try {{ view.setHighlighter({{ color: 'yellow' }}); }} catch (e) {{ threw = e.message; }}
          view.setTool('pen');
          view.setPen({{ color: '#000000', size: 2.5 }});
          await view.save();
          const disk = ink.readPage(fs.get('{hl_path}')).strokes.slice(-2).map(s => [s.tool, s.nib ?? null, s.color, s.size]);
          return {{ hl, pen, hlAgain, threw, disk, penColor }};
        }}""")
        print('highlighter: switching back:', r)
        check('highlighter commands: next colour and next size', r['hl'] == {'color': '#3ddc84', 'size': 24}, r['hl'])
        check("highlighter: switching back to the pen restores the pen's colour and size",
              r['pen']['tool'] == 'pen' and r['pen']['color'] == '#e0301e' and r['pen']['size'] == 4 and r['penColor'] == '#e0301e'
              and r['disk'] == [['highlighter', None, '#3ddc84', 24], ['pen', 'uniform', '#e0301e', 4]], r)
        check('highlighter: switching back to it restores its own colour and size; setHighlighter refuses a bad colour',
              r['hlAgain'] == r['hl'] and 'Invalid highlighter colour' in r['threw'], r)
        r = ev("""async () => {
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Plain.md'));
          return ['tool-pen', 'tool-highlighter', 'highlighter-next-color', 'highlighter-next-size'].map(id => commands[id].checkCallback(true));
        }""")
        check('highlighter: the tool commands are hidden outside an ink view', r == [False] * 4, r)
        # ======== end of the highlighter (#6) ========

        # --- 13. Undo and redo (#8) --------------------------------------------------------
        ev("""() => {
          /** Saves, then compares page i's file with the model and its bitmap with a fresh full render. */
          T.consistent = async (i = 0) => {
            await view.save();
            const pv = view.pages[i], disk = fs.get(pv.slot.path) === ink.writePage(view.store.page(pv.slot));
            if (!pv.bitmap) return { disk, screen: null };
            const c = pv.bitmap.canvas, g = c.getContext('2d');
            const a = g.getImageData(0, 0, c.width, c.height).data;
            view.renderPage(pv);
            const b = g.getImageData(0, 0, c.width, c.height).data;
            let diff = 0;
            for (let k = 0; k < a.length; k += 4) if (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2]) diff++;
            return { disk, screen: diff };
          };
          T.ids = (i = 0) => view.store.page(view.store.slots[i]).strokes.map(s => s.id);
          T.buttons = () => ['.nb-ink-undo', '.nb-ink-redo'].map(s => !view.contentEl.querySelector(s).disabled);
          /** A Ctrl(+Shift)+Z keydown on the strip; returns [handled, defaultPrevented]. */
          T.key = (shift = false, prevented = false) => {
            const e = new KeyboardEvent('keydown', { key: shift ? 'Z' : 'z', ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
            if (prevented) e.preventDefault();
            const n = view.history.labels.length;
            view.contentEl.querySelector('.nb-ink-strip').dispatchEvent(e);
            return [view.history.labels.length !== n, e.defaultPrevented];
          };
          /** Fingers tapped (or dragged by `move` px) on the pages container. */
          T.fingers = async (n, move = 0) => {
            const el = view.contentEl.querySelector('.nb-ink-pages'), r = T.pages()[0].getBoundingClientRect();
            const at = dx => Array.from({ length: n }, (_, i) => new Touch({ identifier: 40 + i, target: el, clientX: r.left + 100 + 60 * i + dx, clientY: r.top + 300 + dx }));
            const fire = (type, touches, changed) => el.dispatchEvent(new TouchEvent(type, { touches, changedTouches: changed, bubbles: true, cancelable: true }));
            fire('touchstart', at(0), at(0));
            await T.sleep(40);
            if (move) fire('touchmove', at(move), at(move));
            await T.sleep(40);
            fire('touchend', [], at(move));
          };
        }""")
        r = ev("""async () => {
          const U = window.U = {};
          await p.createInkNote('Undo');
          await T.sleep(150);
          const path = view.store.slots[0].path;
          const fresh = { undo: view.canUndo, redo: view.canRedo, buttons: T.buttons() };
          Object.assign(U, { ink: T.ink(0), tpl: T.templates()[0] });  // the empty page, with the default template
          await T.stroke(0, T.wave(100, 200));
          const ink1 = T.ink(0);
          await T.stroke(0, T.wave(100, 500));
          await view.save();
          Object.assign(U, { path, two: fs.get(path), ids: T.ids() });
          const buttons = T.buttons(), labels = view.history.labels;
          view.contentEl.querySelector('.nb-ink-undo').click();
          const s2 = view.store.page(view.store.slots[0]).strokes;
          const after = { ids: T.ids(), ink: T.ink(0), ink1, buttons: T.buttons() };
          T.mark();
          await T.sleep(2400);  // autosave
          const disk = ink.readPage(fs.get(path)).strokes.map(s => s.id);
          return { fresh, buttons, labels, after, ids: U.ids, disk, writes: T.writesTo(path), cons: await T.consistent() };
        }""")
        print('undo: after one undo:', {k: r[k] for k in ('fresh', 'buttons', 'labels', 'writes', 'cons')})
        check('undo: a new note has nothing to undo or redo; both buttons disabled',
              r['fresh'] == {'undo': False, 'redo': False, 'buttons': [False, False]}, r['fresh'])
        check('undo: two strokes record two edits; Undo enabled, Redo disabled', r['labels'] == ['Add stroke', 'Add stroke'] and r['buttons'] == [True, False], r)
        check('undo: the Undo button removes the second stroke from the model and the bitmap',
              r['after']['ids'] == r['ids'][:1] and abs(r['after']['ink'] - r['after']['ink1']) < r['after']['ink1'] * 0.02 and r['after']['buttons'] == [True, True], r['after'])
        check('undo: ... and autosave writes the page without it', r['disk'] == r['ids'][:1] and r['writes'] == 1, r)
        check('undo: the saved page and the bitmap match the model', r['cons'] == {'disk': True, 'screen': 0}, r['cons'])
        r = ev("""async () => {
          const shown = commands['redo'].checkCallback(true);
          commands['redo'].checkCallback(false);
          const cons = await T.consistent();
          const same = fs.get(U.path) === U.two;
          const keys = [T.key(), T.key()];
          const none = T.key();  // nothing left to undo: still taken, nothing happens
          const zero = { ids: T.ids(), ink: T.ink(0) === U.ink, cons: await T.consistent(), disk: T.strokesOnDisk(U.path), buttons: T.buttons() };
          const prevented = T.key(true, true);  // already handled (by the hotkey): ignored
          const redoKeys = [T.key(true), T.key(true)];
          const back = { cons: await T.consistent(), same: fs.get(U.path) === U.two, ids: T.ids() };
          return { shown, cons, same, keys, none, zero, prevented, redoKeys, back,
            hotkeys: [commands['undo'].hotkeys, commands['redo'].hotkeys], names: [commands['undo'].name, commands['redo'].name] };
        }""")
        check('undo: the Redo command brings the stroke back; the file is byte-identical to before the undo',
              r['shown'] is True and r['same'] and r['cons'] == {'disk': True, 'screen': 0}, r)
        check('undo: Ctrl+Z in the view undoes both strokes (handled once, default prevented)',
              r['keys'] == [[True, True], [True, True]] and r['zero']['ids'] == [] and r['zero']['ink'] is True and r['zero']['disk'] == 0
              and r['zero']['cons'] == {'disk': True, 'screen': 0} and r['zero']['buttons'] == [False, True], r)
        check('undo: a keydown already handled by the hotkey is not undone again', r['prevented'] == [False, True], r['prevented'])
        check('undo: Shift+Ctrl+Z redoes both; the file is byte-identical to the two-stroke page',
              r['redoKeys'] == [[True, True], [True, True]] and r['back'] == {'cons': {'disk': True, 'screen': 0}, 'same': True, 'ids': ev("() => U.ids")}, r)
        check('undo: commands "Undo" and "Redo" with default hotkeys Mod+Z and Mod+Shift+Z',
              r['names'] == ['Undo', 'Redo'] and r['hotkeys'] == [[{'modifiers': ['Mod'], 'key': 'z'}], [{'modifiers': ['Mod', 'Shift'], 'key': 'z'}]], r)

        # templates: one page, then all pages and the note default
        r = ev("""async () => {
          const note0 = fs.get('Undo.md');
          const prev = view.setPageTemplate(0, { kind: 'grid', spacing: '5mm' });
          await T.sleep(150);
          const grid = { tpl: T.templates()[0], cons: await T.consistent(), text: fs.get(U.path) };
          view.undo();
          await T.sleep(150);
          const undone = { tpl: T.templates()[0], cons: await T.consistent(), same: fs.get(U.path) === U.two };
          view.redo();
          await T.sleep(150);
          const redone = { tpl: T.templates()[0], cons: await T.consistent(), same: fs.get(U.path) === grid.text };
          const noop = view.history.labels.length;
          view.setPageTemplate(0, { kind: 'grid', spacing: '5mm' });  // the same template: nothing to undo
          const noopAfter = view.history.labels.length;
          view.setAllTemplates({ kind: 'dots', spacing: '5mm' });
          await T.sleep(150);
          await view.save();
          const all = { note: fs.get('Undo.md'), page: fs.get(U.path), tpl: T.templates()[0] };
          view.undo();
          await T.sleep(150);
          const allUndone = { cons: await T.consistent(), note: fs.get('Undo.md') === note0, page: fs.get(U.path) === grid.text, tpl: T.templates()[0] };
          view.redo();
          await T.sleep(150);
          const allRedone = { cons: await T.consistent(), note: fs.get('Undo.md') === all.note, page: fs.get(U.path) === all.page };
          view.undo();
          view.undo();
          await T.sleep(150);
          const both = { cons: await T.consistent(), note: fs.get('Undo.md') === note0, page: fs.get(U.path) === U.two, tpl: T.templates()[0] };
          return { prev: prev && ink.templateName(prev), grid: { tpl: grid.tpl, cons: grid.cons }, undone, redone, noop: noopAfter - noop, allTpl: all.tpl, allUndone, allRedone, both,
            noteTpl: ink.readNote(all.note, 'Undo').template };
        }""")
        print('undo: templates:', r)
        ok = {'disk': True, 'screen': 0}
        tpl0 = ev("() => U.tpl")  # the settings' default template (section 10 set it)
        check('undo: a page template change undoes and redoes byte for byte',
              r['prev'] == tpl0 and r['grid']['tpl'] == 'grid-5mm' and r['undone'] == {'tpl': tpl0, 'cons': ok, 'same': True}
              and r['redone'] == {'tpl': 'grid-5mm', 'cons': ok, 'same': True}, r)
        check('undo: setting the template a page already has records nothing', r['noop'] == 0, r['noop'])
        check('undo: "all pages" undoes the pages and the note default, and redoes them, byte for byte',
              r['allTpl'] == 'dots-5mm' and r['noteTpl'] == 'dots-5mm' and r['allUndone'] == {'cons': ok, 'note': True, 'page': True, 'tpl': 'grid-5mm'}
              and r['allRedone'] == {'cons': ok, 'note': True, 'page': True} and r['both'] == {'cons': ok, 'note': True, 'page': True, 'tpl': tpl0}, r)

        # erasing (the eraser, #7, calls view.eraseStrokes) and adding a page
        r = ev("""async () => {
          view.eraseStrokes(0, [U.ids[0], 'nope']);
          const erased = { ids: T.ids(), cons: await T.consistent(), label: view.history.labels.slice(-1)[0] };
          view.undo();
          const undone = { ids: T.ids(), cons: await T.consistent(), same: fs.get(U.path) === U.two };
          view.redo();
          const redone = { ids: T.ids(), cons: await T.consistent() };
          view.undo();
          const n = view.history.labels.length;
          view.eraseStrokes(0, ['nope']);
          return { erased, undone, redone, nothing: view.history.labels.length - n };
        }""")
        check('undo: erased strokes come back in place on undo and go again on redo',
              r['erased']['ids'] == ev("() => U.ids.slice(1)") and r['erased']['label'] == 'Erase' and r['undone']['same'] and r['undone']['cons'] == ok
              and r['redone']['ids'] == r['erased']['ids'] and r['redone']['cons'] == ok, r)
        check('undo: erasing nothing records nothing', r['nothing'] == 0, r['nothing'])
        r = ev("""async () => {
          const note1 = fs.get('Undo.md');
          view.contentEl.querySelector('.nb-ink-add').click();
          await T.sleep(2400);  // autosave writes the new page and the index
          const id = view.store.slots[1].id, pagePath = `Undo/${id}.svg`, note2 = fs.get('Undo.md');
          const added = { els: T.pages().length, embeds: ink.readNote(note2, 'Undo').pages.length, file: fs.has(pagePath) };
          commands['undo'].checkCallback(false);
          const undoneNow = { els: T.pages().length, slots: view.store.slots.length };
          await view.save();
          const undone = { embeds: ink.readNote(fs.get('Undo.md'), 'Undo').pages, same: fs.get('Undo.md') === note1, file: fs.has(pagePath) };
          commands['redo'].checkCallback(false);
          await T.sleep(100);
          await view.save();
          const redone = { els: T.pages().length, dom: T.pages().map(e => e.dataset.page), same: fs.get('Undo.md') === note2, notices: notices.length };
          return { id, added, undoneNow, undone, redone, first: view.store.slots[0].id };
        }""")
        check('undo: "Add page" undone takes the page out of the index; its file stays on disk',
              r['added'] == {'els': 2, 'embeds': 2, 'file': True} and r['undoneNow'] == {'els': 1, 'slots': 1}
              and r['undone']['embeds'] == [r['first']] and r['undone']['same'] and r['undone']['file'], r)
        check('undo: ... and redone puts it back: two embeds, the index byte-identical', r['redone']['els'] == 2 and r['redone']['dom'] == [r['first'], r['id']] and r['redone']['same'], r)

        # two- and three-finger taps on the pages
        r = ev("""async () => {
          view.contentEl.querySelector('.nb-ink-scroll').scrollTop = 0;
          await T.sleep(50);
          await T.stroke(0, T.wave(100, 800));
          const n = T.ids().length;
          await T.fingers(2);
          const two = T.ids().length;
          await T.fingers(3);
          const three = T.ids().length;
          await T.fingers(2, 30);
          const moved = T.ids().length;
          await T.fingers(1);
          const one = T.ids().length;
          return { n, two, three, moved, one, cons: await T.consistent() };
        }""")
        check('undo: a two-finger tap undoes, a three-finger tap redoes', r['two'] == r['n'] - 1 and r['three'] == r['n'], r)
        check('undo: two fingers that move 30 px (a scroll) and a one-finger tap do nothing', r['moved'] == r['n'] and r['one'] == r['n'] and r['cons'] == ok, r)

        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'undo_strip.png'))

        # the history is per note and goes when it closes
        r = ev("""async () => {
          const before = view.canUndo;
          await app.workspace.activeLeaf.detach();
          await T.sleep(30);
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Undo.md'));
          await T.sleep(100);
          const reopened = { undo: view.canUndo, redo: view.canRedo, buttons: T.buttons(), undid: view.undo(), key: T.key() };
          await T.stroke(0, T.wave(100, 900));
          const wrote = view.canUndo;
          await leaf.openFile(app.vault.getFile('Paper.md'));
          await T.sleep(100);
          const other = { undo: view.canUndo, buttons: T.buttons() };
          await leaf.openFile(app.vault.getFile('Plain.md'));
          const outside = [commands['undo'].checkCallback(true), commands['redo'].checkCallback(true)];
          return { before, reopened, wrote, other, outside };
        }""")
        check('undo: closed and reopened, the note has no history', r['before'] and r['reopened'] == {'undo': False, 'redo': False, 'buttons': [False, False], 'undid': False, 'key': [False, True]}, r)
        check('undo: loading another note in the view clears the history', r['wrote'] and r['other'] == {'undo': False, 'buttons': [False, False]}, r)
        check('undo: the commands are unavailable outside an ink view (the editor keeps its own undo)', r['outside'] == [False, False], r['outside'])
        # --- end of 13. Undo and redo (#8) -------------------------------------------------

        # ======== 14. The stroke eraser (#7) ========
        ev("""async () => {
          await p.createInkNote('Eraser', '', 'letter', 'blank');
          await T.sleep(150);
          /** Pixels darker than 128 in page i's bitmap inside the page-px box. */
          T.darkIn = (i, x0, y0, x1, y1) => {
            const c = T.pages()[i].querySelector('canvas.nb-ink-bitmap'), s = c.width / view.store.slots[i].size.width;
            const d = c.getContext('2d').getImageData(Math.round(x0 * s), Math.round(y0 * s), Math.round((x1 - x0) * s), Math.round((y1 - y0) * s)).data;
            let n = 0;
            for (let k = 0; k < d.length; k += 4) if (d[k] < 128) n++;
            return n;
          };
          T.col = x => Array.from({ length: 201 }, (_, j) => [x, 200 + j, 0.3]);  // a vertical line, 1 px per sample
          T.ids = () => view.store.slots[0].page.strokes.map(s => s.id);
        }""")
        r = ev("""async () => {
          for (const x of [150, 250, 350, 450, 550]) await T.pen(0, T.col(x), { predict: 0 });
          // A highlighter stroke through the view's commit path (the highlighter tool is #6).
          view.commit({ key: view.pages[0] }, { tool: 'highlighter', color: '#ffd400', size: 20,
            points: Array.from({ length: 301 }, (_, j) => ({ x: 100 + j, y: 600, p: 0.5, t: 2 * j })) });
          await view.save();
          const strip = view.contentEl.querySelector('.nb-ink-strip');
          const sizes = strip.querySelector('.nb-ink-eraser-sizes');
          const before = { sizesHidden: sizes.style.display === 'none', cmd: commands['tool-eraser'].checkCallback(true) };
          strip.querySelector('.nb-ink-eraser').click();
          const after = { tool: view.pen.tool, active: strip.querySelector('.nb-ink-eraser').classList.contains('is-active'),
            sizesShown: sizes.style.display !== 'none', small: strip.querySelector('.nb-ink-eraser-size.is-active').dataset.eraserSize };
          return { ids: T.ids(), tools: view.store.slots[0].page.strokes.map(s => s.tool), before, after,
            yellow: T.near(0, [255, 239, 153], 14), lines: [150, 250, 350, 450, 550].map(x => T.darkIn(0, x - 5, 280, x + 5, 320)) };
        }""")
        er_ids = r['ids']
        print('eraser: setup:', {k: r[k] for k in ('tools', 'before', 'after', 'yellow', 'lines')})
        check('eraser setup: five pen lines and a highlighter stroke, drawn', r['tools'] == ['pen'] * 5 + ['highlighter'] and all(n > 20 for n in r['lines']) and r['yellow'] > 1000, r)
        check('eraser strip: the Eraser button selects the eraser and shows its sizes (small first)',
              r['before'] == {'sizesHidden': True, 'cmd': True} and r['after'] == {'tool': 'eraser', 'active': True, 'sizesShown': True, 'small': '6'}, r)

        # A drag across the middle three lines, checked mid-drag (cursor) and after release.
        r = ev("""async () => {
          T.mark();
          const drag = Array.from({ length: 301 }, (_, j) => [200 + j, 300, 0.3]);
          await T.pen(0, drag, { predict: 0, up: false });
          const mid = { live: T.liveInk(), ids: T.ids().length };
          const c = view.contentEl.querySelector('canvas.nb-ink-live-tail'), s = c.width / 816;
          const g = c.getContext('2d'), at = (x, y) => g.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data[3];
          mid.center = at(500, 300);  // the last sample
          mid.away = at(480, 300);    // 20 px behind it: the cursor moved on
          mid.area = Math.PI * (6 * s) ** 2;
          T.penUp(0, drag[drag.length - 1]);
          return { mid, ids: T.ids(), live: T.liveInk(), last: view.input.lastErase,
            lines: [150, 250, 350, 450, 550].map(x => T.darkIn(0, x - 5, 220, x + 5, 380)), writesNow: T.writesTo(view.store.slots[0].path) };
        }""")
        print('eraser: drag:', {k: r[k] for k in ('mid', 'ids', 'live', 'lines', 'last')})
        check('eraser: the cursor circle (radius 6) shows on the overlay at the pointer during the drag',
              r['mid']['center'] > 0 and r['mid']['away'] == 0 and 0.5 * r['mid']['area'] < r['mid']['live'] < 2 * r['mid']['area'], r['mid'])
        check('eraser: a drag across three of five lines removes exactly those three from the model',
              r['ids'] == [er_ids[0], er_ids[4], er_ids[5]] and r['last']['removed'] == 3, (r['ids'], er_ids))
        check('eraser: ... and from the bitmap; the untouched lines stay',
              r['lines'][1:4] == [0, 0, 0] and r['lines'][0] > 50 and r['lines'][4] > 50, r['lines'])
        check('eraser: the eraser never draws (no stroke added, overlay clear after up)', r['live'] == 0 and len(r['ids']) == 3, r)
        check('eraser: nothing written at once', r['writesNow'] == 0, r['writesNow'])
        r = ev("""async () => {
          await T.sleep(2400);
          const path = view.store.slots[0].path;
          return { writes: T.writesTo(path), disk: ink.readPage(fs.get(path)).strokes.map(s => s.id) };
        }""")
        check('eraser: the autosave writes the page without the erased strokes', r['writes'] == 1 and r['disk'] == [er_ids[0], er_ids[4], er_ids[5]], r)

        # Undo and redo (#8): one drag that erases two lines (over several frames) is one undo step.
        r = ev("""async () => {
          const path = view.store.slots[0].path, n = view.history.labels.length;
          await T.pen(0, Array.from({ length: 501 }, (_, j) => [100 + j, 300, 0.3]), { predict: 0 });
          const erased = { ids: T.ids(), steps: view.history.labels.length - n, label: view.history.labels.slice(-1)[0],
            frames: view.input.lastErase.frames, lines: [150, 550].map(x => T.darkIn(0, x - 5, 220, x + 5, 380)) };
          const undid = view.undo();
          await view.save();
          const undone = { undid, ids: T.ids(), disk: ink.readPage(fs.get(path)).strokes.map(s => s.id), lines: [150, 550].map(x => T.darkIn(0, x - 5, 220, x + 5, 380)) };
          view.redo();
          await view.save();
          const redone = { ids: T.ids(), disk: ink.readPage(fs.get(path)).strokes.map(s => s.id), lines: [150, 550].map(x => T.darkIn(0, x - 5, 220, x + 5, 380)) };
          view.undo();  // back to three strokes for the checks below
          await view.save();
          return { erased, undone, redone, index: view.pages[0].spatial.size, strokes: T.ids().length };
        }""")
        print('eraser: undo and redo:', r)
        check('eraser: a drag erasing two lines over several frames is one "Erase" undo step',
              r['erased']['ids'] == [er_ids[5]] and r['erased']['steps'] == 1 and r['erased']['label'] == 'Erase' and r['erased']['frames'] > 10 and r['erased']['lines'] == [0, 0], r['erased'])
        check('eraser: undo brings both lines back, in place (model, bitmap, and the file after saving)',
              r['undone']['undid'] and r['undone']['ids'] == [er_ids[0], er_ids[4], er_ids[5]] and r['undone']['disk'] == r['undone']['ids'] and all(n > 50 for n in r['undone']['lines']), r['undone'])
        check('eraser: redo removes them again (model, bitmap, file)',
              r['redone']['ids'] == [er_ids[5]] and r['redone']['disk'] == [er_ids[5]] and r['redone']['lines'] == [0, 0], r['redone'])
        check('eraser: the page index follows undo and redo', r['index'] == r['strokes'] == 3, r)

        # The highlighter stroke, touches, sizes and commands.
        r = ev("""async () => {
          const n = T.ids().length;
          await T.pen(0, Array.from({ length: 40 }, (_, j) => [300, 570 + j, 0.3]), { type: 'touch', id: 31, predict: 0 });
          const touch = n - T.ids().length;
          await T.pen(0, Array.from({ length: 40 }, (_, j) => [300, 570 + j, 0.3]), { predict: 0 });
          const hl = { ids: T.ids(), yellow: T.near(0, [255, 239, 153], 14) };
          // 10 px beside the first line (reach: radius + 1.25): the small eraser misses, the large one hits.
          const beside = Array.from({ length: 100 }, (_, j) => [160, 250 + j, 0.3]);
          await T.pen(0, beside, { predict: 0 });
          const small = T.ids().length;
          view.contentEl.querySelector('[data-eraser-size="14"]').click();
          const large = view.eraser.size;
          await T.pen(0, beside, { predict: 0 });
          const afterLarge = T.ids().length;
          commands['eraser-next-size'].checkCallback(false);
          const next = view.eraser.size;
          // Erasing where there is nothing removes nothing and draws nothing.
          await T.pen(0, Array.from({ length: 100 }, (_, j) => [700, 900 + j, 0.3]), { predict: 0 });
          return { touch, hl, small, large, afterLarge, next, empty: T.ids().length, live: T.liveInk() };
        }""")
        print('eraser: highlighter, sizes:', r)
        check('eraser: a touch never erases', r['touch'] == 0, r)
        check('eraser: a highlighter stroke is erasable (model and bitmap)', r['hl']['ids'] == [er_ids[0], er_ids[4]] and r['hl']['yellow'] == 0, r['hl'])
        check('eraser: the large size (from the strip) reaches further than the small one',
              r['small'] == 2 and r['large'] == 14 and r['afterLarge'] == 1, r)
        check('eraser: "Next eraser size" cycles back to the small size', r['next'] == 6, r)
        check('eraser: erasing empty paper changes nothing', r['empty'] == 1 and r['live'] == 0, r)

        # A page reloaded from disk gets a fresh index; switching back to the pen draws again.
        r = ev("""async () => {
          await view.save();
          const path = view.store.slots[0].path, pg = ink.readPage(fs.get(path));
          pg.strokes.push({ ...pg.strokes[0], id: 'e0e0e0e0', points: pg.strokes[0].points.map(q => ({ ...q, x: 650 })) });
          externalWrite(path, ink.writePage(pg));
          await T.sleep(150);
          const reloaded = T.ids();
          await T.pen(0, Array.from({ length: 60 }, (_, j) => [620 + j, 300, 0.3]), { predict: 0 });
          const erased = T.ids();
          view.contentEl.querySelector('.nb-ink-tool[data-tool="pen"]').click();  // back to the pen
          const tool = view.pen.tool, sizesHidden = view.contentEl.querySelector('.nb-ink-eraser-sizes').style.display === 'none';
          await T.pen(0, T.col(400), { predict: 0 });
          const drawn = T.ids().length;
          commands['tool-eraser'].checkCallback(false);
          const viaCmd = view.pen.tool;
          view.setTool('pen');
          return { reloaded, erased, tool, sizesHidden, drawn, viaCmd, line: T.darkIn(0, 395, 280, 405, 320) };
        }""")
        check('eraser: after a reload from disk, a stroke that came from disk is erasable', r['reloaded'][-1] == 'e0e0e0e0' and 'e0e0e0e0' not in r['erased'], r)
        check('eraser: the Pen button goes back to the pen, which draws again', r['tool'] == 'pen' and r['sizesHidden'] and r['drawn'] == len(r['erased']) + 1 and r['line'] > 20, r)
        check('eraser: "Use the eraser" selects the eraser', r['viaCmd'] == 'eraser', r)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'eraser.png'))

        # A 1,000-stroke page: an erase drag across it, measured.
        r = ev("""async () => {
          const files = ink.largeNote('Dense', 'Thousand', 1, 1000);
          dirs.add('Dense'); dirs.add('Dense/Thousand');
          for (const [k, v] of Object.entries(files)) fs.set(k, v);
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Dense/Thousand.md'));
          await T.sleep(300);
          const before = view.store.slots[0].page.strokes.length;
          view.setTool('eraser');
          view.setEraser({ size: 14 });
          const pv = view.pages[0], bm = pv.bitmap, render = bm.render;
          let renders = 0;
          bm.render = function (...a) { renders++; return render.apply(this, a); };
          const t0 = performance.now();
          // A wavy diagonal sweep, about 1 px per sample, 8 coalesced samples per event and a frame after each.
          const sweep = Array.from({ length: 800 }, (_, j) => [80 + j * 0.8, 150 + j * 0.9 + 30 * Math.sin(j / 40), 0.3]);
          await T.pen(0, sweep, { per: 8, predict: 0, up: false });
          const frames = view.input.erasing.frames.map((ms, i) => [i, ms]).sort((a, b) => b[1] - a[1]).slice(0, 3);
          T.penUp(0, sweep[sweep.length - 1]);
          const wall = performance.now() - t0;
          bm.render = render;
          const after = view.store.slots[0].page.strokes.length;
          const last = view.input.lastErase;
          view.setTool('pen');
          const tb = performance.now();
          new pv.spatial.constructor(view.store.slots[0].page.size, view.store.slots[0].page.strokes);  // what the first erase frame builds
          const build = performance.now() - tb;
          const tr = performance.now();
          bm.render(view.store.slots[0].page, { dark: false, paper: '#ffffff', ink: '#1f1f1f', line: '#c9c9c9' }, null);  // one redraw
          const redraw = performance.now() - tr;
          return { before, after, renders, wall, last, build, redraw, frames, index: pv.spatial ? pv.spatial.size : -1 };
        }""")
        L = r['last']
        print(f"eraser on a page with {r['before']} strokes: {L['events']} events, {L['samples']} samples, removed {L['removed']}; "
              f"handler median {L['handlerMs']:.3f} ms (max {L['handlerMaxMs']:.3f}), frame (hit test + remove + redraw) median {L['frameMs']:.2f} ms "
              f"(max {L['frameMaxMs']:.2f}, {L['frames']} frames), page redraws {r['renders']}, drag {r['wall']:.0f} ms; "
              f"index build {r['build']:.1f} ms (in the first frame), one page redraw {r['redraw']:.1f} ms; slowest frames [index, ms] {r['frames']}")
        check('eraser perf: the sweep removes strokes from the 1,000-stroke page, the index kept in step',
              r['before'] == 1000 and L['removed'] > 20 and r['after'] == 1000 - L['removed'] and r['index'] == r['after'], r)
        check('eraser perf: median handler time under 4 ms (Chromium)', L['handlerMs'] < 4, L['handlerMs'])
        check('eraser perf: the page is redrawn at most once per frame', 0 < r['renders'] <= L['frames'] + 1, (r['renders'], L['frames']))
        # ======== end of 14. The stroke eraser (#7) ========

        # --- unload removes the patch
        r = ev("""async () => {
          p.unload();
          const restored = obsidian.WorkspaceLeaf.prototype.setViewState === original;
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(app.vault.getFile('Physics.md'));
          return [restored, leaf.view.getViewType()];
        }""")
        check('unload: the setViewState patch is removed', r == [True, 'markdown'], r)

        print('notices:', ev("() => notices"))
        print('page errors:', errors)
        check('no page errors', not errors, errors)
        b.close()
finally:
    srv.terminate()

if failures:
    print(f'\n{len(failures)} check(s) FAILED: ' + '; '.join(failures))
    sys.exit(1)
print('\nAll view checks passed.')

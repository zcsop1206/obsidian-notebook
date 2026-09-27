# Drives the ink view in headless Chromium against the built main.js, with the mock obsidian
# module and in-memory vault of test/harness.html and the format functions from
# test/out/view-fixture.js (built by test/build.mjs). Covers creating a note, writing with
# synthetic pen events, autosave timing, saving when hidden or closed, reopening, changes on
# disk, adding pages, a 20-page note, the markdown takeover, page templates, and the pen (live
# and committed outlines, nibs, stylus touches, the pen strip, stats and handler time). Run by
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
        check('pen commands: uniform nib, next colour and next size', r['afterCmds'] == {'nib': 'uniform', 'color': '#1f9d55', 'size': 1.5} and r['disk'][1] == ['uniform', '#1f9d55', 1.5], r)
        check('pen: setPen refuses a colour that is not #rrggbb, lowercases one that is, clamps sizes',
              'Invalid pen colour' in r['threw'] and r['custom'] == {'nib': 'uniform', 'color': '#abcdef', 'size': 16, 'active': 0}, r)
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

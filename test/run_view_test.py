# Drives the ink view in headless Chromium against the built main.js, with the mock obsidian
# module and in-memory vault of test/harness.html and the format functions from
# test/out/view-fixture.js (built by test/build.mjs). Covers creating a note, writing with
# synthetic pen events, autosave timing, saving when hidden or closed, reopening, changes on
# disk, adding pages, a 20-page note, the markdown takeover, page templates, and the pen (live
# and committed outlines, nibs, stylus touches, the toolbar, stats and handler time), and the
# highlighter (tools, layers, crossings, the live overlay, long strokes), undo and redo, the
# eraser, and zoom and finger navigation (#9: pans with momentum, pinches, zoom commands and
# Ctrl+wheel, strokes at 50-400%, the pen during finger gestures, touch rules, frame times on
# the 20-page note, bitmap memory at 400%), renaming or moving notes and page folders (#26), and PDF import (#14:
# pages, the copied PDF, the embedded JPEG, sharp renders at 200%, writing on PDF pages). Run by `npm test`; screenshots land in test/out/.
# Exits non-zero if any check fails.
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
    /** The toolbar (#10). */
    bar: () => view.contentEl.querySelector('.nb-ink-toolbar'),
    /** The picker of the tool in use, opened as a second tap on its active toolbar button does. */
    picker() {
      if (!view.toolbar.pickerOpen) view.contentEl.querySelector('.nb-ink-toolbar .nb-ink-tool.is-active').click();
      return view.contentEl.querySelector('.nb-ink-picker');
    },
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
      const ys = [], re = /(-?[\d.]+) (-?[\d.]+)/g;  // every point and control point (M, L, Q)
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
          T.bar().querySelector('.nb-ink-page-settings').click();  // the toolbar's page settings (#10)
          view.contentEl.querySelector('.nb-ink-picker .nb-ink-menu-all-templates').click();
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
        check('templates: "Template of all pages" (toolbar page settings) changes every page and the note default',
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
            same: inp.livePath === ink.strokePath({ tool: 'pen', nib: 'uniform', size: 2.5, points }, true), points: points.length };
        }""")
        check('pen: mid-stroke, the live overlay has ink after the frames', r['live'] > 300 and r['frames'] >= 10, r)
        check('pen: the live outline is strokePath of the points so far (same options, same code, live: not refitted)', r['same'], r)
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
          const add = view.contentEl.querySelector('.nb-ink-add'), swatch = view.contentEl.querySelector('.nb-ink-toolbar .nb-ink-tool');
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
        check('pen: a finger touchstart is not prevented; a finger touchmove over the pages is (#9: the view pans itself)', r['finger'] == [False, True], r)
        check('pen: a stylus touchstart on a control is not prevented (taps work); touchmove is', r['control'] == [False, False, True], r)

        # (7) the toolbar's pen picker and the commands set the next stroke's nib, colour and size
        r = ev(f"""async () => {{
          const strip = T.picker(), q = sel => strip.querySelector(sel);
          const layout = {{ height: T.bar().offsetHeight, controls: strip.querySelectorAll('.nb-ink-control').length, swatches: strip.querySelectorAll('.nb-ink-swatch').length }};
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
          view.toolbar.closePicker();
          await view.save();
          const disk = ink.readPage(fs.get('{pen_path}')).strokes.slice(-2).map(s => [s.nib, s.color, s.size]);
          return {{ layout, shown, afterCmds, disk, threw, custom, red: T.near(0, [0xe0, 0x30, 0x1e], 30) }};
        }}""")
        print('pen picker:', r)
        check('pen picker: the toolbar is one row; the picker has nib, 8 swatches, 3 sizes and a stepper', r['layout']['height'] < 56 and r['layout']['swatches'] == 8, r['layout'])
        check('pen picker: clicks set nib, colour and size, and show them', r['shown'] == {'nib': 'pressure', 'color': '#e0301e', 'value': '4.5 px'}, r['shown'])
        check('pen picker: the next stroke saves with them, drawn in red', r['disk'][0] == ['pressure', '#e0301e', 4.5] and r['red'] > 200, r)
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
        # (1) switching tools: the command, then the toolbar; each tool's picker shows its own groups
        r = ev("""() => {
          const strip = T.bar(), q = sel => strip.querySelector(sel);
          const shown = sel => !!T.picker().querySelector(sel);
          const groups = () => ({ tool: view.pen.tool, active: q('.nb-ink-tool.is-active').dataset.tool,
            pen: ['.nb-ink-nibs', '.nb-ink-colors', '.nb-ink-sizes', '.nb-ink-sizes .nb-ink-step'].map(shown), hl: shown('.nb-ink-highlighter') });
          const first = strip.firstElementChild.classList.contains('nb-ink-tools');
          const start = groups();
          const visible = commands['tool-highlighter'].checkCallback(true);
          commands['tool-highlighter'].checkCallback(false);
          const byCommand = groups();
          commands['tool-pen'].checkCallback(false);
          const back = groups();
          view.toolbar.closePicker();
          q('[data-tool="highlighter"]').click();
          const picker = T.picker();
          const byStrip = { ...groups(), swatches: picker.querySelectorAll('.nb-ink-hl-swatch').length,
            sizes: [...picker.querySelectorAll('.nb-ink-hl-size')].map(b => Number(b.dataset.size)),
            color: picker.querySelector('.nb-ink-hl-swatch.is-active').dataset.color, height: strip.offsetHeight };
          return { first, start, visible, byCommand, back, byStrip };
        }""")
        print('highlighter: tools:', r)
        check('highlighter: the toolbar starts with the tool group; the pen is the default tool with its groups shown',
              r['first'] and r['start'] == {'tool': 'pen', 'active': 'pen', 'pen': [True] * 4, 'hl': False}, r)
        check('highlighter: "Use the highlighter" switches to it and shows only its group',
              r['visible'] and r['byCommand'] == {'tool': 'highlighter', 'active': 'highlighter', 'pen': [False] * 4, 'hl': True}, r)
        check('highlighter: "Use the pen" switches back', r['back'] == r['start'], r['back'])
        check('highlighter: the toolbar button switches to it; its picker has 5 swatches and 2 sizes, yellow active; still one row',
              r['byStrip']['tool'] == 'highlighter' and r['byStrip']['swatches'] == 5 and r['byStrip']['sizes'] == [14, 24]
              and r['byStrip']['color'] == '#ffd400' and r['byStrip']['height'] < 56, r['byStrip'])
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'highlighter_strip.png'))
        ev("() => view.toolbar.closePicker()")

        # (2) a pen stroke, a highlight over it, a pen stroke after it, and a crossing highlight of the same colour
        r = ev(f"""async () => {{
          const q = sel => T.bar().querySelector(sel);
          view.setTool('pen');
          await T.pen(0, Array.from({{ length: 60 }}, (_, j) => [200, 150 + j * 2, 0.3]));   // pen, before
          q('[data-tool="highlighter"]').click();
          T.picker().querySelector('.nb-ink-hl-size[data-size="24"]').click();
          view.toolbar.closePicker();
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
          const pen = {{ ...view.pen }}, penColor = T.picker().querySelector('.nb-ink-swatch.is-active')?.dataset.color ?? null;
          view.toolbar.closePicker();
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
          /** A Ctrl(+Shift)+Z keydown on the toolbar; returns [handled, defaultPrevented]. */
          T.key = (shift = false, prevented = false) => {
            const e = new KeyboardEvent('keydown', { key: shift ? 'Z' : 'z', ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
            if (prevented) e.preventDefault();
            const n = view.history.labels.length;
            T.bar().dispatchEvent(e);
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
          view.setEraser({ mode: 'stroke' });  // this section tests the stroke eraser; the partial one (#15) is section 19
        }""")
        r = ev("""async () => {
          for (const x of [150, 250, 350, 450, 550]) await T.pen(0, T.col(x), { predict: 0 });
          // A highlighter stroke through the view's commit path (the highlighter tool is #6).
          view.commit({ key: view.pages[0] }, { tool: 'highlighter', color: '#ffd400', size: 20,
            points: Array.from({ length: 301 }, (_, j) => ({ x: 100 + j, y: 600, p: 0.5, t: 2 * j })) });
          await view.save();
          const strip = T.bar();
          const before = { sizesHidden: !view.contentEl.querySelector('.nb-ink-eraser-sizes'), cmd: commands['tool-eraser'].checkCallback(true) };
          strip.querySelector('.nb-ink-eraser').click();
          const picker = T.picker();
          const after = { tool: view.pen.tool, active: strip.querySelector('.nb-ink-eraser').classList.contains('is-active'),
            sizesShown: !!picker.querySelector('.nb-ink-eraser-sizes'), small: picker.querySelector('.nb-ink-eraser-size.is-active').dataset.eraserSize };
          view.toolbar.closePicker();
          return { ids: T.ids(), tools: view.store.slots[0].page.strokes.map(s => s.tool), before, after,
            yellow: T.near(0, [255, 239, 153], 14), lines: [150, 250, 350, 450, 550].map(x => T.darkIn(0, x - 5, 280, x + 5, 320)) };
        }""")
        er_ids = r['ids']
        print('eraser: setup:', {k: r[k] for k in ('tools', 'before', 'after', 'yellow', 'lines')})
        check('eraser setup: five pen lines and a highlighter stroke, drawn', r['tools'] == ['pen'] * 5 + ['highlighter'] and all(n > 20 for n in r['lines']) and r['yellow'] > 1000, r)
        check('eraser toolbar: the Eraser button selects the eraser; its picker shows its sizes (small first)',
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
          T.picker().querySelector('[data-eraser-size="14"]').click();
          view.toolbar.closePicker();
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
        check('eraser: the large size (from the picker) reaches further than the small one',
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
          const tool = view.pen.tool, sizesHidden = !view.contentEl.querySelector('.nb-ink-eraser-sizes');
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

        # ======== 15. Zoom and finger navigation (#9) ========
        ev("""async () => {
          T.sc = () => view.contentEl.querySelector('.nb-ink-scroll');
          T.frame = () => new Promise(r => requestAnimationFrame(r));
          T.targets = {};
          /** A finger pointer event at client (x, y), on the element under the finger when it landed. */
          T.finger = (type, id, x, y) => {
            if (type === 'pointerdown') {
              const el = document.elementFromPoint(x, y);
              T.targets[id] = el && T.sc().contains(el) ? el : T.sc();
            }
            const e = new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 101, clientX: x, clientY: y,
              bubbles: true, cancelable: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 });
            (T.targets[id] || T.sc()).dispatchEvent(e);
            return e;
          };
          /** Moves fingers from `from` ([[x, y], ...]) to `to` in n steps, a frame after each. */
          T.drag = async (from, to, n, { down = true, up = true } = {}) => {
            const at = (i, s) => [from[i][0] + (to[i][0] - from[i][0]) * s / n, from[i][1] + (to[i][1] - from[i][1]) * s / n];
            if (down) from.forEach(([x, y], i) => T.finger('pointerdown', 101 + i, x, y));
            for (let s = 1; s <= n; s++) {
              from.forEach((_, i) => T.finger('pointermove', 101 + i, ...at(i, s)));
              await T.frame();
            }
            if (up) to.forEach(([x, y], i) => T.finger('pointerup', 101 + i, x, y));
          };
          /** Waits for momentum to end; returns whether it did. */
          T.settle = async (ms = 6000) => {
            const t0 = performance.now();
            while (view.nav.active && performance.now() - t0 < ms) await T.sleep(50);
            return !view.nav.active;
          };
          T.centre = () => { const sc = T.sc(), r = sc.getBoundingClientRect(); return [r.left + sc.clientWidth / 2, r.top + sc.clientHeight / 2]; };
          /** The page point under client (x, y): [page index, page x, page y], or null. */
          T.pagePoint = (x, y) => {
            for (const [i, el] of T.pages().entries()) {
              const r = el.getBoundingClientRect(), s = view.store.slots[i].size;
              if (y >= r.top && y < r.bottom) return [i, (x - r.left) * s.width / r.width, (y - r.top) * s.height / r.height];
            }
            return null;
          };
          /** Where page point [i, x, y] is on screen. */
          T.screenPoint = ([i, x, y]) => {
            const r = T.pages()[i].getBoundingClientRect(), s = view.store.slots[i].size;
            return [r.left + x * r.width / s.width, r.top + y * r.height / s.height];
          };
          T.off = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
          T.bitmapWidth = i => { const c = T.pages()[i].querySelector('canvas.nb-ink-bitmap'); return c ? c.width : 0; };
          /**
           * A pen stroke through client points `pts`, a frame after each move; `between(j)` runs
           * before move j. Returns the page and, for each sample, the page point under it at the
           * moment it was sent (through the page's bounding rect).
           */
          T.penAt = async (pts, { id = 61, between = null } = {}) => {
            const target = document.elementFromPoint(pts[0][0], pts[0][1]), pageEl = target.closest('.nb-ink-page');
            const i = T.pages().indexOf(pageEl), size = view.store.slots[i].size;
            const init = ([x, y], b = 1) => ({ pointerId: id, pointerType: 'pen', pressure: 0.5, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: b });
            const under = ([x, y]) => { const r = pageEl.getBoundingClientRect(); return [(x - r.left) * size.width / r.width, (y - r.top) * size.height / r.height]; };
            const expected = [under(pts[0])];
            target.dispatchEvent(new PointerEvent('pointerdown', init(pts[0])));
            for (let j = 1; j < pts.length; j++) {
              if (between) await between(j);
              expected.push(under(pts[j]));
              target.dispatchEvent(new PointerEvent('pointermove', init(pts[j])));
              await T.frame();
            }
            target.dispatchEvent(new PointerEvent('pointerup', init(pts[pts.length - 1], 0)));
            return { i, expected };
          };
          /** The largest distance between the last stroke on page i and `expected` (page px), or -1 if the counts differ. */
          T.landed = (i, expected) => {
            const s = view.store.page(view.store.slots[i]).strokes, pts = s[s.length - 1].points;
            if (pts.length !== expected.length) return -1;
            return Math.max(...pts.map((q, j) => Math.max(Math.abs(q.x - expected[j][0]), Math.abs(q.y - expected[j][1]))));
          };
          await p.createInkNote('Zoom', '', 'letter', 'lined-college');
          await T.sleep(150);
          for (let i = 0; i < 3; i++) view.addPage();
          T.sc().scrollTop = 0;
          await T.sleep(150);
        }""")
        r = ev("""() => {
          const sc = T.sc(), cs = getComputedStyle(sc), pagesEl = view.contentEl.querySelector('.nb-ink-pages');
          return { touchAction: cs.touchAction, overflowX: cs.overflowX, zoom: view.zoom, layer: [pagesEl.style.width, pagesEl.style.height],
            client: sc.clientWidth, scrollW: sc.scrollWidth };
        }""")
        check('zoom: the pages area takes no native touch panning (touch-action: none) and can scroll sideways',
              r['touchAction'] == 'none' and r['overflowX'] == 'auto', r)
        check('zoom: a note opens at 100%, the pages layer explicitly sized to the view width (no sideways scroll)',
              r['zoom'] == 1 and r['layer'][0] == f"{r['client']}px" and r['scrollW'] == r['client'], r)

        # (1) one finger pans, then coasts (momentum) and stops
        r = ev("""async () => {
          const sc = T.sc(), [cx, cy] = T.centre();
          let y = cy;
          T.finger('pointerdown', 101, cx, y);
          y -= 12; T.finger('pointermove', 101, cx, y); await T.frame();  // past the slop (10 px): the pan starts here
          const start = sc.scrollTop;
          for (let s = 0; s < 15; s++) { y -= 20; T.finger('pointermove', 101, cx, y); await T.frame(); }
          const dragged = sc.scrollTop - start;
          T.finger('pointerup', 101, cx, y);
          const atUp = sc.scrollTop;
          await T.sleep(300);
          const coasting = view.nav.active, after300 = sc.scrollTop;
          const stopped = await T.settle();
          const end = sc.scrollTop;
          await T.sleep(200);
          return { start, dragged, atUp, coasting, after300, stopped, end, still: sc.scrollTop === end, nav: { ...view.stats.nav } };
        }""")
        print(f"finger pan: dragged {r['dragged']:.1f} px for 300 px of finger; momentum carried {r['end'] - r['atUp']:.0f} px; "
              f"frames {r['nav']['frames']}, median {r['nav']['medianMs']:.1f} ms, max {r['nav']['maxMs']:.1f} ms, slow {r['nav']['slow']}")
        check('nav: a one-finger drag scrolls with the finger (slop eaten, no jump)', r['start'] == 0 and abs(r['dragged'] - 300) <= 1, r)
        check('nav: after release the view keeps coasting (momentum)', r['coasting'] and r['after300'] > r['atUp'] + 50, r)
        check('nav: ... slows down and stops', r['stopped'] and r['still'] and 150 < r['end'] - r['atUp'] < 1500, r)
        r = ev("""async () => {
          const sc = T.sc(), [cx, cy] = T.centre();
          sc.scrollTop = 0;
          await T.sleep(50);
          await T.drag([[cx, cy]], [[cx, cy - 250]], 10);
          await T.sleep(120);
          const moving = view.nav.active, a = sc.scrollTop;
          T.finger('pointerdown', 103, cx, cy);
          const stopped = !view.nav.active;
          await T.sleep(150);
          const b = sc.scrollTop;
          T.finger('pointerup', 103, cx, cy);
          return { moving, stopped, a, b };
        }""")
        check('nav: a new touch stops the momentum', r['moving'] and r['stopped'] and r['a'] == r['b'] and r['a'] > 0, r)
        r = ev("""async () => {
          const sc = T.sc(), [cx, cy] = T.centre();
          sc.scrollTop = 100;
          await T.sleep(50);
          const from = [[cx - 60, cy], [cx + 60, cy]];
          await T.drag(from, from.map(([x, y]) => [x, y - 12]), 1, { up: false });
          const start = sc.scrollTop;
          await T.drag(from.map(([x, y]) => [x, y - 12]), from.map(([x, y]) => [x, y - 212]), 20, { down: false });
          const moved = sc.scrollTop - start;
          await T.settle();
          return { moved, zoom: view.zoom, transform: view.contentEl.querySelector('.nb-ink-pages').style.transform, pinches: view.stats.nav.pinches };
        }""")
        check('nav: two fingers moving together pan (no zoom)', abs(r['moved'] - 200) <= 1 and r['zoom'] == 1 and r['transform'] == '' and r['pinches'] == 0, r)

        # (2) pinch out to 2x, then in to 0.5x, around the pinch centre
        r = ev("""async () => {
          const sc = T.sc(), pagesEl = view.contentEl.querySelector('.nb-ink-pages');
          sc.scrollTop = T.pages()[1].offsetTop + 200;
          await T.sleep(300);
          const [cx, cy] = T.centre(), before = T.pagePoint(cx, cy), i = before[0];
          const w0 = T.bitmapWidth(i), pw0 = T.pages()[i].offsetWidth, renders = view.stats.lastRenderMs;
          const from = [[cx - 50, cy], [cx + 50, cy]];
          await T.drag(from, [[cx - 62, cy], [cx + 62, cy]], 1, { up: false });  // the pan and the pinch start (distance 124)
          await T.drag([[cx - 62, cy], [cx + 62, cy]], [[cx - 124, cy], [cx + 124, cy]], 12, { down: false, up: false });  // to 248: 2x
          const during = { transform: pagesEl.style.transform, zoom: view.zoom, w: T.bitmapWidth(i), pw: T.pages()[i].offsetWidth,
            off: T.off(T.screenPoint(before), [cx, cy]), scrollH: sc.scrollHeight };
          T.finger('pointerup', 101, cx - 124, cy);
          T.finger('pointerup', 102, cx + 124, cy);
          const after = { zoom: view.zoom, transform: pagesEl.style.transform, w: T.bitmapWidth(i), pw: T.pages()[i].offsetWidth,
            off: T.off(T.screenPoint(before), [cx, cy]), layerW: parseFloat(pagesEl.style.width), client: sc.clientWidth, left: sc.scrollLeft };
          await T.sleep(100);
          return { before, w0, pw0, during, after, active: view.nav.active, nav: { ...view.stats.nav } };
        }""")
        print('pinch out:', r)
        d, a = r['during'], r['after']
        check('pinch: during the pinch the pages layer is scaled by a transform, with no relayout or re-render',
              d['transform'] == 'scale(2)' and d['zoom'] == 1 and d['w'] == r['w0'] and d['pw'] == r['pw0'], d)
        check('pinch: ... and the page point under the pinch centre stays under it', d['off'] < 1, d['off'])
        check('pinch: on release the zoom is committed at 2x: relaid out, no transform', a['zoom'] == 2 and a['transform'] == '' and abs(a['pw'] - 2 * r['pw0']) <= 1, a)
        check('pinch: ... the page point under the centre is still under it (within 1 px)', a['off'] < 1, a['off'])
        check('pinch: ... the visible page is redrawn sharp at the new size', abs(a['w'] - 2 * r['w0']) <= 2, (r['w0'], a['w']))
        check('pinch: ... and the view scrolls sideways at 2x', a['layerW'] > a['client'] and a['left'] > 0, a)
        r = ev("""async () => {
          const sc = T.sc(), pagesEl = view.contentEl.querySelector('.nb-ink-pages');
          const [cx, cy] = T.centre(), before = T.pagePoint(cx, cy), i = before[0], w0 = T.bitmapWidth(i);
          await T.drag([[cx - 220, cy], [cx + 220, cy]], [[cx - 208, cy], [cx + 208, cy]], 1, { up: false });  // distance 416
          await T.drag([[cx - 208, cy], [cx + 208, cy]], [[cx - 52, cy], [cx + 52, cy]], 15, { down: false, up: false });  // 104: a quarter
          const during = { transform: pagesEl.style.transform, off: T.off(T.screenPoint(before), [cx, cy]), top: sc.scrollTop };
          T.finger('pointerup', 101, cx - 52, cy);
          T.finger('pointerup', 102, cx + 52, cy);
          const after = { zoom: view.zoom, transform: pagesEl.style.transform, w: T.bitmapWidth(i), off: T.off(T.screenPoint(before), [cx, cy]),
            layerW: parseFloat(pagesEl.style.width), client: sc.clientWidth, left: sc.scrollLeft, pw: T.pages()[i].offsetWidth };
          await T.sleep(300);
          const visible = T.pages().map((el, j) => [j, el.getBoundingClientRect()]).filter(([, rc]) => rc.bottom > sc.getBoundingClientRect().top && rc.top < sc.getBoundingClientRect().bottom).map(([j]) => j);
          return { before, w0, during, after, visible, drawn: visible.map(T.bitmapWidth) };
        }""")
        print('pinch in:', r)
        d, a = r['during'], r['after']
        check('pinch in: scaled by a quarter during the pinch, the centre point kept', d['transform'] == 'scale(0.25)' and d['off'] < 1, d)
        check('pinch in: committed at 0.5x (clamped range), centre point within 1 px, pages centred in the view width',
              a['zoom'] == 0.5 and a['transform'] == '' and a['off'] < 1 and a['layerW'] == a['client'] and a['left'] == 0, a)
        check('pinch in: the page is redrawn at a quarter of the 2x resolution, and all visible pages are drawn',
              abs(a['w'] - r['w0'] / 4) <= 2 and len(r['visible']) >= 2 and all(w > 0 for w in r['drawn']), r)

        # (3) zoom commands and Ctrl+wheel
        r = ev("""async () => {
          const sc = T.sc(), out = [];
          commands['zoom-reset'].checkCallback(false);
          sc.scrollTop = T.pages()[1].offsetTop + 100;
          await T.sleep(50);
          const [cx, cy] = T.centre();
          let off = 0;
          for (const c of ['zoom-in', 'zoom-in', 'zoom-out', 'zoom-out', 'zoom-out', 'zoom-reset']) {
            const before = T.pagePoint(cx, cy);
            commands[c].checkCallback(false);
            out.push(view.zoom);
            off = Math.max(off, T.off(T.screenPoint(before), [cx, cy]));
          }
          view.setZoom(9);
          const max = view.zoom;
          view.setZoom(0.1);
          const min = view.zoom;
          view.setZoom(1);
          const shown = [commands['zoom-in'].checkCallback(true), commands['zoom-out'].checkCallback(true), commands['zoom-reset'].checkCallback(true)];
          return { out, off, max, min, shown };
        }""")
        check('zoom commands: in and out by 25%, reset to 100%, clamped to 50-400%',
              r['out'] == [1.25, 1.5, 1.25, 1, 0.75, 1] and r['max'] == 4 and r['min'] == 0.5 and r['shown'] == [True, True, True], r)
        check('zoom commands: the page point at the middle of the view stays there (within 1 px each time)', r['off'] < 1, r['off'])
        r = ev("""async () => {
          const sc = T.sc(), pagesEl = view.contentEl.querySelector('.nb-ink-pages'), r0 = sc.getBoundingClientRect();
          const x = r0.left + 200, y = r0.top + 150, before = T.pagePoint(x, y);
          const wheel = (ctrlKey, deltaY) => { const e = new WheelEvent('wheel', { deltaY, ctrlKey, clientX: x, clientY: y, bubbles: true, cancelable: true }); sc.dispatchEvent(e); return e.defaultPrevented; };
          const plain = wheel(false, 40), plainZoom = view.zoom;
          await T.sleep(50);
          const top = sc.scrollTop;
          const prevented = [wheel(true, -100), wheel(true, -100), wheel(true, -100)];
          const during = { zoom: view.zoom, transform: pagesEl.style.transform, off: T.off(T.screenPoint(before), [x, y]) };
          await T.sleep(300);
          return { plain, plainZoom, prevented, during, zoom: view.zoom, expected: Math.exp(0.6), off: T.off(T.screenPoint(before), [x, y]), top };
        }""")
        check('wheel: a plain wheel is left to native scrolling', r['plain'] is False and r['plainZoom'] == 1, r)
        check('wheel: Ctrl+wheel is taken and previewed as a transform around the cursor', r['prevented'] == [True] * 3 and r['during']['zoom'] == 1
              and r['during']['transform'].startswith('scale(') and r['during']['off'] < 1, r)
        check('wheel: ... then committed, the point under the cursor kept', abs(r['zoom'] - r['expected']) < 1e-6 and r['off'] < 1, r)

        # (4) strokes land under the pointer at 50%, 100% and 400%
        r = ev("""async () => {
          const out = {};
          for (const z of [0.5, 1, 4]) {
            view.setZoom(z);
            // the middle of page 1 in the middle of the view
            const sc = T.sc(), pg = T.pages()[1];
            sc.scrollTop = pg.offsetTop + pg.offsetHeight / 2 - sc.clientHeight / 2;
            sc.scrollLeft = pg.offsetLeft + pg.offsetWidth / 2 - sc.clientWidth / 2;
            await T.sleep(100);
            // a wavy line inside the view, 4 px apart on screen, on the page under the view's middle
            const [cx, cy] = T.centre();
            const pts = Array.from({ length: 40 }, (_, j) => [cx - 80 + 4 * j, cy + 20 * Math.sin(j / 5)]);
            const { i, expected } = await T.penAt(pts);
            out[z] = { page: i, worst: T.landed(i, expected), n: expected.length, first: expected[0] };
          }
          view.setZoom(1);
          return out;
        }""")
        print('strokes at zoom (worst distance from the pointer, page px):', {k: round(v['worst'], 3) for k, v in r.items()})
        check('zoom: strokes at 50%, 100% and 400% land under the pointer (within 0.2 page px)',
              all(0 <= v['worst'] <= 0.2 for v in r.values()) and len(r) == 3, r)

        # (5) the pen keeps writing while a finger pans or two fingers pinch
        r = ev("""async () => {
          const sc = T.sc();
          sc.scrollTop = T.pages()[1].offsetTop + 100;
          await T.sleep(100);
          const [cx, cy] = T.centre(), n = view.store.slots.reduce((k, s) => k + view.store.page(s).strokes.length, 0);
          const top0 = sc.scrollTop;
          let fy = cy + 100;
          T.finger('pointerdown', 101, cx + 150, fy);
          const pts = Array.from({ length: 30 }, (_, j) => [cx - 150 + 5 * j, cy]);
          const pan = await T.penAt(pts, { between: async () => { fy -= 12; T.finger('pointermove', 101, cx + 150, fy); await T.frame(); } });
          T.finger('pointerup', 101, cx + 150, fy);
          await T.settle();
          const panned = { worst: T.landed(pan.i, pan.expected), moved: sc.scrollTop - top0, strokes: view.store.slots.reduce((k, s) => k + view.store.page(s).strokes.length, 0) - n,
            span: pan.expected[pan.expected.length - 1][1] - pan.expected[0][1] };
          // Now a pinch from 100% towards 150% while writing; the zoom is committed mid-stroke.
          const f = [[cx - 60, cy + 120], [cx + 60, cy + 120]];
          T.finger('pointerdown', 101, ...f[0]);
          T.finger('pointerdown', 102, ...f[1]);
          let spread = 60;
          const pts2 = Array.from({ length: 30 }, (_, j) => [cx - 150 + 5 * j, cy - 60]);
          const pinch = await T.penAt(pts2, { id: 62, between: async j => {
            if (j < 20) {
              spread += 3;
              T.finger('pointermove', 101, cx - spread, cy + 120);
              T.finger('pointermove', 102, cx + spread, cy + 120);
              await T.frame();
            } else if (j === 20) {
              T.finger('pointerup', 101, cx - spread, cy + 120);
              T.finger('pointerup', 102, cx + spread, cy + 120);
            }
          } });
          const pinched = { worst: T.landed(pinch.i, pinch.expected), zoom: view.zoom,
            strokes: view.store.slots.reduce((k, s) => k + view.store.page(s).strokes.length, 0) - n };
          view.setZoom(1);
          return { panned, pinched, live: T.liveInk() };
        }""")
        print('pen during finger gestures:', r)
        check('nav: a pen stroke while a finger pans is one stroke, every point under the pen (within 0.2 page px)',
              r['panned']['strokes'] == 1 and 0 <= r['panned']['worst'] <= 0.2 and r['panned']['moved'] > 200 and r['panned']['span'] > 150, r['panned'])
        check('nav: a pen stroke while two fingers pinch (zoom committed mid-stroke) is one stroke, every point under the pen',
              r['pinched']['strokes'] == 2 and 0 <= r['pinched']['worst'] <= 0.2 and r['pinched']['zoom'] > 1.2, r['pinched'])
        check('nav: fingers never draw; the live overlays are clear afterwards', r['live'] == 0, r['live'])

        # (6) a two-finger tap still undoes, without panning or zooming
        r = ev("""async () => {
          const sc = T.sc(), [cx, cy] = T.centre();
          await T.stroke(1, T.wave(100, 300));
          const n = view.store.page(view.store.slots[1]).strokes.length;
          const top = sc.scrollTop, zoom = view.zoom;
          // As the iPad sends it: pointer events and touch events for the same two fingers, moving 3 px.
          const pagesEl = view.contentEl.querySelector('.nb-ink-pages');
          const touches = dx => [0, 1].map(i => new Touch({ identifier: 70 + i, target: pagesEl, clientX: cx - 40 + 80 * i + dx, clientY: cy + dx }));
          const fire = (type, t, c) => { const e = new TouchEvent(type, { touches: t, changedTouches: c, bubbles: true, cancelable: true }); pagesEl.dispatchEvent(e); return e.defaultPrevented; };
          T.finger('pointerdown', 101, cx - 40, cy); T.finger('pointerdown', 102, cx + 40, cy);
          fire('touchstart', touches(0), touches(0));
          await T.sleep(40);
          T.finger('pointermove', 101, cx - 37, cy + 3); T.finger('pointermove', 102, cx + 43, cy + 3);
          const moveBlocked = fire('touchmove', touches(3), touches(3));
          await T.frame();
          await T.sleep(40);
          T.finger('pointerup', 101, cx - 37, cy + 3); T.finger('pointerup', 102, cx + 43, cy + 3);
          fire('touchend', [], touches(3));
          await T.sleep(50);
          return { before: n, after: view.store.page(view.store.slots[1]).strokes.length, moved: sc.scrollTop - top, zoom: view.zoom === zoom, moveBlocked };
        }""")
        check('nav: a two-finger tap (pointer and touch events) still undoes, and neither scrolls nor zooms',
              r['after'] == r['before'] - 1 and r['moved'] == 0 and r['zoom'], r)

        # (7) touch rules: finger touchmoves over the pages are prevented, touchstarts and the toolbar are not
        r = ev("""() => {
          const sc = T.sc(), pagesEl = view.contentEl.querySelector('.nb-ink-pages'), add = view.contentEl.querySelector('.nb-ink-add');
          const strip = T.bar(), swatch = T.bar().querySelector('.nb-ink-preset');
          return {
            fingerMove: [T.touch(T.pages()[0], 'touchmove', 'direct'), T.touch(pagesEl, 'touchmove', 'direct'), T.touch(sc, 'touchmove', 'direct'), T.touch(add, 'touchmove', 'direct')],
            fingerStart: [T.touch(T.pages()[0], 'touchstart', 'direct'), T.touch(add, 'touchstart', 'direct')],
            strip: [T.touch(strip, 'touchstart', 'direct'), T.touch(swatch, 'touchmove', 'direct')],
            stylus: [T.touch(T.pages()[0], 'touchstart', 'stylus'), T.touch(T.pages()[0], 'touchmove', 'stylus'), T.touch(add, 'touchstart', 'stylus')],
          };
        }""")
        check('touch: a finger touchmove anywhere over the pages is prevented (no sidebar swipes)', r['fingerMove'] == [True] * 4, r)
        check('touch: finger touchstarts are not prevented, so taps on "Add page" still click', r['fingerStart'] == [False, False], r)
        check('touch: fingers on the toolbar are left alone', r['strip'] == [False, False], r)
        check('touch: stylus rules unchanged (prevented, except a touchstart on a control)', r['stylus'] == [True, True, False], r)
        r = ev("""async () => {
          const add = view.contentEl.querySelector('.nb-ink-add'), n = view.store.slots.length;
          add.scrollIntoView();
          await T.sleep(50);
          const rc = add.getBoundingClientRect(), x = rc.left + rc.width / 2, y = rc.top + rc.height / 2;
          const hit = document.elementFromPoint(x, y) === add;
          T.finger('pointerdown', 101, x, y);
          T.finger('pointerup', 101, x, y);
          add.click();  // what the tap's click does
          await T.sleep(50);
          const added = view.store.slots.length - n === 1;
          view.undo();
          return { hit, added };
        }""")
        check('touch: "Add page" can be tapped with a finger at 100%', r['hit'] and r['added'], r)

        # (8) zoom and scroll are kept while the note is open, reset for another note
        r = ev("""async () => {
          const sc = T.sc();
          view.setZoom(2);
          sc.scrollLeft = 150;
          sc.scrollTop = 900;
          await T.sleep(50);
          view.contentEl.querySelector('.nb-ink-add').click();
          const added = { zoom: view.zoom, left: sc.scrollLeft, newPage: T.pagePoint(...T.centre()) };
          view.undo();
          await T.sleep(50);
          const undone = { zoom: view.zoom, left: sc.scrollLeft };
          sc.scrollTop = 1200;
          await T.sleep(50);
          const path = view.file.path, kept = { zoom: view.zoom, top: sc.scrollTop, left: sc.scrollLeft };
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Physics.md'));
          await T.sleep(100);
          const other = { zoom: view.zoom, top: T.sc().scrollTop, left: T.sc().scrollLeft, w: T.pages()[0].offsetWidth, client: T.sc().clientWidth };
          await app.workspace.getLeaf(false).openFile(app.vault.getFile(path));
          await T.sleep(100);
          return { added, undone, kept, other, back: { zoom: view.zoom, top: T.sc().scrollTop } };
        }""")
        check('keep: after adding a page the zoom and sideways scroll are kept (and the new page is shown)',
              r['added']['zoom'] == 2 and r['added']['left'] == 150 and r['added']['newPage'] and r['added']['newPage'][0] == 4, r['added'])
        check('keep: ... and after undoing it', r['undone'] == {'zoom': 2, 'left': 150}, r['undone'])
        check('keep: loading another note in the view resets to 100% and the top', r['other']['zoom'] == 1 and r['other']['top'] == 0 and r['other']['left'] == 0
              and r['other']['w'] == r['other']['client'] - 32, r['other'])
        check('keep: zoom is not saved: the note comes back at 100%, at the top', r['back'] == {'zoom': 1, 'top': 0}, r['back'])

        # (9) the 20-page note, 300 strokes per page: frame times of a finger pan, zoom 4 memory
        r = ev("""async () => {
          const files = ink.largeNote('Big3', 'Lecture', 20, 300);
          dirs.add('Big3'); dirs.add('Big3/Lecture');
          for (const [k, v] of Object.entries(files)) fs.set(k, v);
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Big3/Lecture.md'));
          await T.sleep(800);
          const sc = T.sc(), r0 = sc.getBoundingClientRect(), x = r0.left + 300;
          let y = r0.top + 450;
          T.finger('pointerdown', 101, x, y);
          const t0 = performance.now();
          while (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2 && performance.now() - t0 < 60000) {
            y -= 25;  // 25 px a frame, 1.5 px/ms: a brisk pan through all 20 pages, fresh (outlines not yet computed)
            T.finger('pointermove', 101, x, y);
            await T.frame();
          }
          T.finger('pointerup', 101, x, y);
          await T.settle();
          const nav = { ...view.stats.nav }, fromPlugin = p.inkNavStats();
          const rendered = T.pages().map((e, i) => e.querySelector('canvas.nb-ink-bitmap') ? i : -1).filter(i => i >= 0);
          return { nav, same: fromPlugin && fromPlugin.frames === nav.frames, rendered, bottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2, ink19: T.ink(19) };
        }""")
        n = r['nav']
        print(f"large note finger pan (20 pages, 300 strokes each, fresh): {n['frames']} frames, median {n['medianMs']:.1f} ms, "
              f"max {n['maxMs']:.1f} ms, over 32 ms: {n['over32']} {n['slow']}; bitmaps at the bottom {r['rendered']}")
        check('large pan: reaches the bottom with the last page drawn', r['bottom'] and r['ink19'] > 10000 and len(r['rendered']) <= 4, r)
        check('large pan: no frame over 32 ms in Chromium (one outlier allowed, printed above)', n['frames'] > 500 and n['over32'] <= 1, n)
        check('large pan: plugin.inkNavStats() returns the same numbers (the debug view prints them)', r['same'], r)
        r = ev("""async () => {
          const sc = T.sc();
          sc.scrollTop = T.pages()[10].offsetTop;
          await T.sleep(400);
          const at1 = view.pages.filter(pv => pv.bitmap).length;
          view.setZoom(4);
          await T.sleep(600);
          const live = () => view.pages.map((pv, i) => pv.bitmap && [i, pv.bitmap.canvas.width, pv.bitmap.canvas.height]).filter(Boolean);
          const at4 = live();
          // pan down three pages' worth at 400%, with a finger
          const [cx, cy] = T.centre();
          let y = cy;
          T.finger('pointerdown', 101, cx, y);
          for (let s = 0; s < 150; s++) { y -= 25; T.finger('pointermove', 101, cx, y); await T.frame(); }
          T.finger('pointerup', 101, cx, y);
          await T.settle();
          await T.sleep(600);
          const panned = live();
          const cssW = T.pages()[panned[0][0]].offsetWidth, cssH = T.pages()[panned[0][0]].offsetHeight;
          const nav = { ...view.stats.nav };
          view.setZoom(1);
          return { at1, at4, panned, cssW, cssH, nav, dpr: devicePixelRatio };
        }""")
        mb = lambda pages: sum(w * h * 4 for _, w, h in pages) / 1e6
        print(f"zoom 400% on the large note: page {r['cssW']}x{r['cssH']} CSS px; bitmaps {r['at4']} ({mb(r['at4']):.0f} MB), "
              f"after panning {r['panned']} ({mb(r['panned']):.0f} MB); at 100% {r['at1']} bitmaps; "
              f"pan at 400%: {r['nav']['frames']} frames, median {r['nav']['medianMs']:.1f} ms, max {r['nav']['maxMs']:.1f} ms, over 32 ms {r['nav']['over32']}")
        check("zoom 4: at most 3 pages keep bitmaps, each within iOS's 16M-pixel canvas limit",
              1 <= len(r['at4']) <= 3 and 1 <= len(r['panned']) <= 3 and all(w * h <= 16_777_216 for _, w, h in r['at4'] + r['panned']), r)

        # (10) the stats overlay and the debug readout show navigation
        r = ev("""() => {
          view.toggleStats();
          const text = view.contentEl.querySelector('.nb-ink-stats').textContent;
          view.toggleStats();
          return text;
        }""")
        check('stats overlay: shows the zoom and the last finger gesture frame times', 'zoom 100%' in r and 'last finger gesture' in r and 'over 32 ms' in r, r)
        # This view hasn't erased yet (section 19 checks the line after a partial erase).
        check('stats overlay: has a line for the last erase', 'last erase: none yet' in r, r)
        # ======== end of 15. Zoom and finger navigation (#9) ========

        # ======== 16. Page management (#17) ========
        ev("""async () => {
          T.panel = () => view.contentEl.querySelector('.nb-pages-panel');
          T.thumbs = () => [...view.contentEl.querySelectorAll('.nb-pages-thumb')];
          T.order = () => T.thumbs().map(t => t.dataset.page);
          T.pageOrder = () => T.pages().map(el => el.dataset.page);
          T.saved = name => ink.readNote(fs.get(name + '.md'), name).pages;
          T.idle = async () => { for (let i = 0; i < 200 && view.pagesPanelOpen && view.contentEl && T.busy(); i++) await T.sleep(20); };
          T.busy = () => { const t = T.thumbs(); return view['pagesPanel'].busy; };
          /** Pixels of thumbnail i's canvas that differ clearly from its first pixel (-1 if not drawn). */
          T.thumbInk = i => {
            const c = T.thumbs()[i] && T.thumbs()[i].querySelector('canvas');
            if (!c || !c.width) return -1;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - d[0]) + Math.abs(d[k + 1] - d[1]) + Math.abs(d[k + 2] - d[2]) > 60) n++;
            return n;
          };
          /** A pointer event of `type` on the thumbnail list at the middle of thumbnail i (dy: offset). */
          T.onThumb = (type, i, { pointerType = 'touch', dy = 0, id = 301, target } = {}) => {
            const t = T.thumbs()[i], r = t.querySelector('.nb-pages-frame').getBoundingClientRect();
            const e = new PointerEvent(type, { pointerId: id, pointerType, isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 + dy,
              bubbles: true, cancelable: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 });
            (target || t.querySelector('.nb-pages-frame')).dispatchEvent(e);
          };
          T.act = what => view.contentEl.querySelector('.nb-pages-thumb.is-current .nb-pages-' + what).click();
          await p.createInkNote('Sorter', '', 'letter', 'blank');
          await T.sleep(150);
          for (let i = 0; i < 3; i++) view.addPage();
          // page i gets i + 1 strokes, so each page can be told apart
          for (let i = 0; i < 4; i++) {
            view.scrollToPage(i);
            await T.sleep(60);
            for (let j = 0; j <= i; j++) await T.stroke(i, T.wave(80, 150 + 120 * j, 40), 'pen', 7, 0);
          }
          view.history.clear();
          await view.save();
          view.scrollToPage(0);
          await T.sleep(100);
        }""")
        r = ev("""() => ({ shown: T.panel().style.display !== 'none', open: view.pagesPanelOpen, thumbs: T.thumbs().length,
          margin: getComputedStyle(T.sc()).marginLeft, button: !!view.contentEl.querySelector('.nb-ink-toolbar .nb-ink-pages-toggle'),
          strokes: view.store.slots.map(s => view.store.page(s).strokes.length) })""")
        check('pages: the panel is closed by default (no thumbnails, pages area full width)', not r['shown'] and not r['open'] and r['thumbs'] == 0 and r['margin'] == '0px', r)
        check('pages: the toolbar has a Pages button', r['button'], r)
        check('pages: the test note has 4 pages with 1-4 strokes', r['strokes'] == [1, 2, 3, 4], r)

        # (1) the toolbar button opens it: a thumbnail per page, numbered, drawn
        r = ev("""async () => {
          const w0 = T.pages()[0].offsetWidth;
          view.contentEl.querySelector('.nb-ink-pages-toggle').click();
          await T.sleep(400);
          await T.idle();
          const nums = T.thumbs().map(t => t.querySelector('.nb-pages-num').textContent);
          return { open: view.pagesPanelOpen, shown: T.panel().style.display !== 'none', order: T.order(), ids: view.store.index.pages, nums,
            ink: T.thumbs().map((_, i) => T.thumbInk(i)), w0, w1: T.pages()[0].offsetWidth, margin: getComputedStyle(T.sc()).marginLeft,
            panelW: T.panel().offsetWidth, thumbW: T.thumbs()[0].querySelector('canvas').offsetWidth, stats: { ...view.pagesPanelStats },
            pressed: view.contentEl.querySelector('.nb-ink-pages-toggle').getAttribute('aria-pressed') };
        }""")
        print('pages panel:', {k: r[k] for k in ('nums', 'ink', 'w0', 'w1', 'panelW', 'thumbW', 'stats')})
        check('pages: the Pages button opens the panel, pressed', r['open'] and r['shown'] and r['pressed'] == 'true', r)
        check('pages: a thumbnail per page, in order, numbered 1-4', r['order'] == r['ids'] and r['nums'] == ['1', '2', '3', '4'], r)
        check('pages: thumbnails are 120 px wide and show the ink', r['thumbW'] == 120 and all(n > 20 for n in r['ink']), r)
        check('pages: the pages area narrows beside the panel', r['margin'] == f"{r['panelW']}px" and r['w1'] < r['w0'], r)
        check('pages: thumbnails drawn at most 2 per frame, from the page bitmap where there is one', r['stats']['drawn'] >= 4 and r['stats']['fromBitmap'] >= 1, r['stats'])

        # (2) the current page's thumbnail follows the scroll; a tap scrolls to a page
        r = ev("""async () => {
          const cur = () => T.thumbs().findIndex(t => t.classList.contains('is-current'));
          const at0 = cur();
          const sc = T.sc();
          sc.scrollTop = T.pages()[2].offsetTop - 10;
          await T.sleep(150);
          const at2 = [cur(), view.currentPageIndex()];
          T.onThumb('pointerdown', 1);
          T.onThumb('pointerup', 1);
          await T.sleep(150);
          const tapped = [cur(), view.currentPageIndex(), Math.abs(sc.scrollTop - (T.pages()[1].offsetTop - 16))];
          // a finger that moves on the panel scrolls it: no tap
          T.onThumb('pointerdown', 3);
          T.onThumb('pointermove', 3, { dy: 30 });
          T.onThumb('pointerup', 3, { dy: 30 });
          await T.sleep(100);
          const scrolled = view.currentPageIndex();
          return { at0, at2, tapped, scrolled, actions: T.thumbs().map(t => getComputedStyle(t.querySelector('.nb-pages-actions')).display) };
        }""")
        check('pages: the first page is highlighted at the top', r['at0'] == 0, r)
        check('pages: the highlight follows a scroll to page 3', r['at2'] == [2, 2], r)
        check('pages: a tap on a thumbnail scrolls to its page', r['tapped'][0] == 1 and r['tapped'][1] == 1 and r['tapped'][2] <= 1, r)
        check('pages: a finger moving before the long press does not tap', r['scrolled'] == 1, r)
        check("pages: only the current page's thumbnail shows its actions", r['actions'] == ['none', 'flex', 'none', 'none'], r)

        # (3) a long press, then a drag, reorders: only the index is written
        r = ev("""async () => {
          const ids = view.store.index.pages.slice();
          const files = Object.fromEntries(ids.map(id => [id, fs.get('Sorter/' + id + '.svg')]));
          T.mark();
          T.onThumb('pointerdown', 0);
          await T.sleep(450);
          const lifted = T.thumbs()[0].classList.contains('is-lifted');
          const list = view.contentEl.querySelector('.nb-pages-list');
          for (const dy of [10, 40, 80]) { T.onThumb('pointermove', 0, { dy, target: list }); await T.sleep(16); }
          const r2 = T.thumbs()[2].getBoundingClientRect(), r3 = T.thumbs()[3].getBoundingClientRect();
          const y = (r2.top + r2.height / 2 + r3.top + r3.height / 2) / 2 - T.thumbs()[0].querySelector('.nb-pages-frame').getBoundingClientRect().top - T.thumbs()[0].querySelector('.nb-pages-frame').offsetHeight / 2;
          T.onThumb('pointermove', 0, { dy: y, target: list });
          const drop = view.contentEl.querySelector('.nb-pages-drop').style.display !== 'none';
          T.onThumb('pointerup', 0, { dy: y, target: list });
          await T.sleep(100);
          const order = view.store.index.pages.slice();
          await view.save();
          const saved = T.saved('Sorter');
          const same = ids.every(id => fs.get('Sorter/' + id + '.svg') === files[id]);
          const writes = app.vault.writes.slice(T.marked);
          const strokes = view.store.slots.map(s => view.store.page(s).strokes.length);
          const res = { ids, lifted, drop, order, saved, same, writes, thumbs: T.order(), els: T.pageOrder(), strokes };
          view.undo();
          await view.save();
          res.undone = [view.store.index.pages.slice(), T.saved('Sorter'), T.order(), T.pageOrder()];
          view.redo();
          await view.save();
          res.redone = [T.saved('Sorter'), T.order()];
          res.label = view.history.labels.slice(-1)[0];
          return res;
        }""")
        ids = r['ids']
        moved = [ids[1], ids[2], ids[0], ids[3]]
        check('pages: a long press picks a thumbnail up and the drag shows the drop line', r['lifted'] and r['drop'], r)
        check('pages: dragging page 1 between pages 3 and 4 reorders the note', r['order'] == moved and r['saved'] == moved, r)
        check('pages: the reorder writes only the index; page files unchanged', r['same'] and r['writes'] == ['Sorter.md'], r)
        check('pages: the editor and the thumbnails show the new order', r['els'] == moved and r['thumbs'] == moved and r['strokes'] == [2, 3, 1, 4], r)
        check('pages: undo restores the order (index, editor, thumbnails), redo moves it again',
              r['undone'] == [ids, ids, ids, ids] and r['redone'] == [moved, moved] and r['label'] == 'Move page', r)

        # (4) insert a page after the current one; (5) duplicate; undo each
        r = ev("""async () => {
          view.scrollToPage(1);
          await T.sleep(100);
          const before = view.store.index.pages.slice();
          T.act('insert');
          await T.sleep(100);
          await view.save();
          const after = view.store.index.pages.slice(), added = after.find(id => !before.includes(id));
          const ins = { before, after, at: after.indexOf(added), file: !!fs.get('Sorter/' + added + '.svg'), saved: T.saved('Sorter'),
            current: view.currentPageIndex(), thumbs: T.thumbs().length, strokes: ink.readPage(fs.get('Sorter/' + added + '.svg')).strokes.length };
          view.undo();
          await view.save();
          ins.undone = [T.saved('Sorter'), T.thumbs().length];
          // duplicate page 2 (index 1), which has 3 strokes
          view.scrollToPage(1);
          await T.sleep(100);
          const src = view.store.index.pages[1];
          T.act('duplicate');
          await T.sleep(100);
          await view.save();
          const now = view.store.index.pages.slice(), copy = now[2];
          const dup = { src, copy, order: now, saved: T.saved('Sorter'), file: fs.get('Sorter/' + copy + '.svg'), current: view.currentPageIndex() };
          const a = ink.readPage(fs.get('Sorter/' + src + '.svg')), b = ink.readPage(dup.file);
          dup.same = JSON.stringify(a.strokes) === JSON.stringify(b.strokes) && a.strokes.length === 3 && b.id === copy;
          dup.file = !!dup.file;
          await T.sleep(700);
          await T.idle();
          dup.thumbInk = [T.thumbInk(1), T.thumbInk(2)];
          view.undo();
          await view.save();
          dup.undone = T.saved('Sorter');
          return { ins, dup };
        }""")
        ins, dup = r['ins'], r['dup']
        check('pages: "Insert page after" adds a blank page after the current one and scrolls to it',
              ins['at'] == 2 and ins['file'] and ins['saved'] == ins['after'] and ins['strokes'] == 0 and ins['current'] == 2 and ins['thumbs'] == 5, ins)
        check('pages: undo of the insert takes it out again', ins['undone'] == [ins['before'], 4], ins)
        check('pages: "Duplicate" inserts a copy after the page: new id, new file, same strokes',
              dup['copy'] != dup['src'] and dup['order'][1] == dup['src'] and dup['file'] and dup['same'] and dup['saved'] == dup['order'] and dup['current'] == 2, dup)
        check('pages: the copy gets a thumbnail like the original', dup['thumbInk'][1] > 20 and abs(dup['thumbInk'][1] - dup['thumbInk'][0]) <= dup['thumbInk'][0] * 0.25, dup['thumbInk'])
        check('pages: undo of the duplicate takes it out of the note', dup['undone'] == ins['before'], dup)

        # (6) delete: file gone, undo writes it back with its content, redo deletes again
        r = ev("""async () => {
          view.scrollToPage(3);
          await T.sleep(100);
          const ids = view.store.index.pages.slice(), gone = ids[3], path = 'Sorter/' + gone + '.svg', text = fs.get(path);
          const n0 = notices.length;
          T.act('delete');
          await T.sleep(50);
          await view.save();
          await T.sleep(50);
          const del = { ids, gone, exists: fs.has(path), saved: T.saved('Sorter'), thumbs: T.order(), els: T.pageOrder(), notice: notices.slice(n0),
            modals: modals.length };
          view.undo();
          await view.save();
          await T.sleep(50);
          del.undone = { same: fs.get(path) === text, strokes: fs.has(path) && ink.readPage(fs.get(path)).strokes.length, saved: T.saved('Sorter'), thumbs: T.order() };
          view.redo();
          await view.save();
          await T.sleep(50);
          del.redone = { exists: fs.has(path), saved: T.saved('Sorter'), thumbs: T.order() };
          del.errors = notices.slice(n0).filter(n => /couldn|changed on disk/i.test(n));
          return del;
        }""")
        rest = [i for i in r['ids'] if i != r['gone']]
        check('pages: "Delete" removes the page from the note and deletes its file, without asking',
              not r['exists'] and r['saved'] == rest and r['thumbs'] == rest and r['els'] == rest and r['modals'] == 0, r)
        check('pages: undo of the delete writes the file back with its content', r['undone']['same'] and r['undone']['strokes'] == 4 and r['undone']['saved'] == r['ids'] and r['undone']['thumbs'] == r['ids'], r['undone'])
        check('pages: redo deletes it again', not r['redone']['exists'] and r['redone']['saved'] == rest and r['redone']['thumbs'] == rest, r['redone'])
        check('pages: no error or "changed on disk" notice from our own delete', not r['errors'], r['errors'])

        # (7) a stroke refreshes its page's thumbnail after the debounce; a reorder on disk updates the panel
        r = ev("""async () => {
          view.scrollToPage(0);
          await T.sleep(100);
          await T.idle();
          const before = T.thumbInk(0), drawn = view.pagesPanelStats.drawn;
          await T.stroke(0, T.wave(80, 700, 60), 'pen', 7, 0);
          await T.sleep(200);
          const early = view.pagesPanelStats.drawn - drawn;
          await T.sleep(500);
          await T.idle();
          const after = T.thumbInk(0);
          await view.save();
          const note = ink.readNote(fs.get('Sorter.md'), 'Sorter');
          note.pages.reverse();
          externalWrite('Sorter.md', ink.writeNote(note));
          await T.sleep(200);
          return { before, after, early, disk: note.pages, thumbs: T.order(), els: T.pageOrder(), nums: T.thumbs().map(t => t.querySelector('.nb-pages-num').textContent) };
        }""")
        check('pages: a new stroke redraws the thumbnail after the debounce (not before)', r['early'] == 0 and r['after'] > r['before'], r)
        check('pages: a reorder on disk (a sync) updates the editor and the panel', r['thumbs'] == r['disk'] and r['els'] == r['disk'] and r['nums'] == ['1', '2', '3'], r)

        # (8) the command closes and opens it; closed, thumbnails are released
        r = ev("""async () => {
          const cmd = commands['toggle-pages-panel'];
          cmd.checkCallback(false);
          await T.sleep(200);
          const closed = { open: view.pagesPanelOpen, shown: T.panel().style.display !== 'none', thumbs: T.thumbs().length, margin: getComputedStyle(T.sc()).marginLeft };
          cmd.checkCallback(false);
          await T.sleep(300);
          await T.idle();
          const opened = { open: view.pagesPanelOpen, thumbs: T.thumbs().length, ink: T.thumbInk(0) };
          return { closed, opened, name: cmd.name };
        }""")
        check('pages: the command "Toggle pages panel" closes it (thumbnails released, pages area full width)',
              r['name'] == 'Toggle pages panel' and not r['closed']['open'] and not r['closed']['shown'] and r['closed']['margin'] == '0px', r)
        check('pages: the command opens it again with drawn thumbnails', r['opened']['open'] and r['opened']['thumbs'] == 3 and r['opened']['ink'] > 20, r)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'pages_panel.png'))

        # (9) thumbnail cost on the 20-page, 300-strokes-per-page note: drawn with no page bitmaps
        r = ev("""async () => {
          const files = ink.largeNote('Thumbs', 'Lecture', 20, 300);
          dirs.add('Thumbs'); dirs.add('Thumbs/Lecture');
          for (const [path, text] of Object.entries(files)) fs.set(path, text);
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Thumbs/Lecture.md'));
          await T.sleep(300);
          const s = view.pagesPanelStats;
          s.maxFrameMs = 0; s.drawn = 0; s.fromBitmap = 0;
          const frames = [];
          let last = performance.now(), run = true;
          const tick = () => { const now = performance.now(); frames.push(now - last); last = now; if (run) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          const list = view.contentEl.querySelector('.nb-pages-list');
          const t0 = performance.now();
          for (let i = 0; i < 40; i++) { list.scrollTop += 60; await T.sleep(50); }
          await T.idle();
          const t1 = performance.now() - t0;
          run = false;
          frames.sort((a, b) => a - b);
          return { open: view.pagesPanelOpen, thumbs: T.thumbs().length, drawn: s.drawn, fromBitmap: s.fromBitmap, maxMs: s.maxFrameMs, ms: t1,
            median: frames[frames.length >> 1], worst: frames[frames.length - 1], over32: frames.filter(f => f > 32).length, n: frames.length };
        }""")
        print(f"thumbnails on the 20-page note: {r['drawn']} drawn ({r['fromBitmap']} from bitmaps) while scrolling the panel for {r['ms']:.0f} ms; "
              f"thumbnail work max {r['maxMs']:.1f} ms per frame; frames {r['n']}, median {r['median']:.1f} ms, worst {r['worst']:.1f} ms, over 32 ms {r['over32']}")
        check('pages: the panel stays open for another note and follows it', r['open'] and r['thumbs'] == 20, r)
        check('pages: thumbnails drawn only as they come into view, never more than about a frame of work',
              0 < r['drawn'] <= 20 and r['maxMs'] < 40, r)
        ev("() => view.togglePagesPanel(false)")
        # ======== end of 16. Page management (#17) ========

        # ======== 17. Renaming or moving a note keeps its pages (#26) ========
        # Helpers: the page files under a folder, the strokes of each, and the index's folder and pages.
        ev("""() => {
          T.under = dir => [...fs.keys()].filter(k => k.startsWith(dir + '/')).sort();
          T.index = path => { const n = ink.readNote(fs.get(path), path.replace(/^.*\\//, '').replace(/\\.md$/, '')); return { folder: n.folder, pages: n.pages }; };
          T.strokesIn = dir => T.under(dir).filter(k => k.endsWith('.svg')).map(k => T.strokesOnDisk(k));
        }""")
        # (1) rename an open note with an unsaved stroke
        r = ev("""async () => {
          await p.createInkNote('Lecture', '', 'letter', 'blank');
          await T.sleep(150);
          const id = view.store.slots[0].id;
          await T.stroke(0, T.wave(100, 200), 'pen', 7, 0);
          const unsaved = view.store.unsaved, n0 = notices.length;
          await app.vault.rename(app.vault.getFile('Lecture.md'), 'Week1.md');
          await T.sleep(100);
          const r = { id, unsaved, file: view.file.path, title: view.getDisplayText(), folder: view.store.folder, slot: view.store.slots[0].path,
            old: T.under('Lecture').length + (fs.has('Lecture.md') ? 1 : 0) + (dirs.has('Lecture') ? 1 : 0), now: T.under('Week1'),
            index: T.index('Week1.md'), strokes: T.strokesIn('Week1'), saved: !view.store.unsaved, notices: notices.slice(n0) };
          await T.stroke(0, T.wave(100, 400), 'pen', 7, 0);
          await T.sleep(2400);
          r.after = { strokes: T.strokesIn('Week1'), old: T.under('Lecture').length, ink: T.ink(0) };
          r.image = await T.imageInk(`Week1/${id}.svg`);
          return r;
        }""")
        check('rename open: the page folder is renamed and nothing is left at the old path',
              r['old'] == 0 and r['now'] == [f"Week1/{r['id']}.svg"], r)
        check('rename open: the view follows (file, title, store folder, slot paths)',
              r['file'] == 'Week1.md' and r['title'] == 'Week1' and r['folder'] == 'Week1' and r['slot'] == f"Week1/{r['id']}.svg", r)
        check('rename open: the embeds point at the new folder', r['index'] == {'folder': 'Week1', 'pages': [r['id']]}, r)
        check('rename open: the unsaved stroke is saved to the new path, with no notice',
              r['unsaved'] and r['saved'] and r['strokes'] == [1] and r['notices'] == [], r)
        check('rename open: the view still draws and autosaves to the new path afterwards',
              r['after']['strokes'] == [2] and r['after']['old'] == 0 and r['after']['ink'] > 500, r['after'])
        check('rename open: the moved page renders as a plain SVG image', r['image']['n'] > 500, r['image'])
        pid = r['id']

        # (2) move the open note to another folder, with an unsaved stroke
        r = ev("""async () => {
          await app.vault.createFolder('Archive');
          await T.stroke(0, T.wave(100, 600), 'pen', 7, 0);
          await app.vault.rename(app.vault.getFile('Week1.md'), 'Archive/Week1.md');
          await T.sleep(100);
          const r = { file: view.file.path, folder: view.store.folder, old: T.under('Week1').length + (dirs.has('Week1') ? 1 : 0),
            index: T.index('Archive/Week1.md'), strokes: T.strokesIn('Archive/Week1') };
          await T.stroke(0, T.wave(100, 700), 'pen', 7, 0);
          await view.save();
          r.after = { strokes: T.strokesIn('Archive/Week1'), old: T.under('Week1').length };
          return r;
        }""")
        check('move open: the page folder moves along and the embeds follow',
              r['file'] == 'Archive/Week1.md' and r['folder'] == 'Archive/Week1' and r['old'] == 0 and r['index'] == {'folder': 'Week1', 'pages': [pid]}, r)
        check('move open: the unsaved stroke and a later one are saved in the new place', r['strokes'] == [3] and r['after'] == {'strokes': [4], 'old': 0}, r)

        # (3) a name collision leaves the folder where it is, with a notice
        r = ev("""async () => {
          await app.vault.createFolder('Archive/Taken');
          const n0 = notices.length;
          await T.stroke(0, T.wave(100, 800), 'pen', 7, 0);
          await app.vault.rename(app.vault.getFile('Archive/Week1.md'), 'Archive/Taken.md');
          await T.sleep(100);
          const r = { notices: notices.slice(n0), folder: view.store.folder, index: T.index('Archive/Taken.md'), strokes: T.strokesIn('Archive/Week1'),
            taken: T.under('Archive/Taken') };
          await T.stroke(0, T.wave(100, 900), 'pen', 7, 0);
          await view.save();
          r.after = T.strokesIn('Archive/Week1');
          return r;
        }""")
        check('collision: the folder stays, the embeds keep pointing at it, and a notice says so',
              r['folder'] == 'Archive/Week1' and r['index'] == {'folder': 'Week1', 'pages': [pid]} and r['taken'] == []
              and len(r['notices']) == 1 and 'already exists' in r['notices'][0], r)
        check('collision: the view keeps saving to the pages where they are', r['strokes'] == [5] and r['after'] == [6], r)

        # (4) the page folder renamed by hand while the note is open, with an unsaved stroke
        r = ev("""async () => {
          const n0 = notices.length;
          await T.stroke(0, T.wave(100, 1000), 'pen', 7, 0);
          await app.vault.rename(app.vault.getFolder('Archive/Week1'), 'Archive/By hand');
          await T.sleep(50);
          const r = { folder: view.store.folder, slot: view.store.slots[0].path, missing: view.store.slots[0].error };
          await view.save();
          Object.assign(r, { index: T.index('Archive/Taken.md'), strokes: T.strokesIn('Archive/By hand'), old: T.under('Archive/Week1').length + (dirs.has('Archive/Week1') ? 1 : 0),
            notices: notices.slice(n0), md: fs.get('Archive/Taken.md') });
          return r;
        }""")
        check('folder by hand, open: the view follows the folder and saves the unsaved stroke there',
              r['folder'] == 'Archive/By hand' and r['missing'] is None and r['strokes'] == [7] and r['old'] == 0 and r['notices'] == [], r)
        check('folder by hand, open: the embeds are rewritten (percent-encoded)',
              r['index'] == {'folder': 'By hand', 'pages': [pid]} and f'](By%20hand/{pid}.svg)' in r['md'], r)

        # (5) a closed note: rename and move it, then rename its folder by hand
        r = ev("""async () => {
          await app.workspace.activeLeaf.detach();
          await p.createInkNote('Closed', '', 'letter', 'blank');
          await T.sleep(150);
          const id = view.store.slots[0].id;
          await T.stroke(0, T.wave(100, 200), 'pen', 7, 0);
          await app.workspace.activeLeaf.detach();
          await T.sleep(30);
          await app.vault.createFolder('Moved');
          await app.vault.rename(app.vault.getFile('Closed.md'), 'Moved/Closed 2.md');
          await T.sleep(100);
          const moved = { index: T.index('Moved/Closed 2.md'), files: T.under('Moved/Closed 2'), old: T.under('Closed').length + (dirs.has('Closed') ? 1 : 0) };
          await app.vault.rename(app.vault.getFolder('Moved/Closed 2'), 'Moved/Pages');
          await T.sleep(100);
          const byHand = T.index('Moved/Closed 2.md');
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Moved/Closed 2.md'));
          await T.sleep(150);
          return { id, moved, byHand, type: view.getViewType(), folder: view.store.folder, loaded: view.stats.pagesLoaded,
            strokes: view.store.page(view.store.slots[0]).strokes.length, ink: T.ink(0) };
        }""")
        check('closed note: renaming and moving it moves its page folder and rewrites the embeds',
              r['moved'] == {'index': {'folder': 'Closed 2', 'pages': [r['id']]}, 'files': [f"Moved/Closed 2/{r['id']}.svg"], 'old': 0}, r)
        check('closed note: renaming its folder by hand rewrites the embeds', r['byHand'] == {'folder': 'Pages', 'pages': [r['id']]}, r)
        check('closed note: it reopens with its pages', r['type'] == 'notebook-ink' and r['folder'] == 'Moved/Pages' and r['loaded'] == 1
              and r['strokes'] == 1 and r['ink'] > 500, r)

        # (6) the collision note, whose folder isn't named after it, reopens with its pages
        r = ev("""async () => {
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Archive/Taken.md'));
          await T.sleep(150);
          return { type: view.getViewType(), loaded: view.stats.pagesLoaded, ids: view.store.slots.map(s => s.id), strokes: view.store.page(view.store.slots[0]).strokes.length };
        }""")
        check('reopen: the renamed note lists its pages from the folder its embeds name', r == {'type': 'notebook-ink', 'loaded': 1, 'ids': [pid], 'strokes': 7}, r)
        # ======== end of 17. Renaming or moving a note keeps its pages (#26) ========

        # ======== 18. Gestures across page edges (#35) ========
        # A gesture belongs to the page it started on and continues wherever the pointer goes.
        # Off-page samples are dispatched on another element (the pages layer, as in the gap
        # between pages; the scroller, as in its margin; or the body, outside the view), as a
        # browser that doesn't honour pointer capture would. Chromium's synthetic events can't
        # reproduce WebKit's capture, so this checks the robust path: the window listeners.
        ev("""async () => {
          await p.createInkNote('Edges', '', 'letter', 'blank');
          await T.sleep(150);
          view.contentEl.querySelector('.nb-ink-add').click();
          await T.sleep(150);
          view.contentEl.querySelector('.nb-ink-scroll').scrollTop = 0;
          await T.sleep(100);
          view.setTool('pen');
          T.el = which => which === 'layer' ? view.pagesEl : which === 'scroller' ? view.contentEl.querySelector('.nb-ink-scroll') : document.body;
          /**
           * A gesture on page i through pts ([x, y] page px), one sample per event and a frame
           * after each; samples off the page are dispatched on T.el(off). Returns nothing.
           */
          T.edge = async (i, pts, off, { id = 41, up = true } = {}) => {
            const pg = T.pages()[i], size = view.store.slots[i].size;
            const fire = (type, [x, y]) => {
              const r = pg.getBoundingClientRect(), k = r.width / size.width;
              const on = x >= 0 && y >= 0 && x <= size.width && y <= size.height;
              (on ? pg : T.el(off)).dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', pressure: 0.3,
                clientX: r.left + x * k, clientY: r.top + y * k, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
            };
            fire('pointerdown', pts[0]);
            for (let j = 1; j < pts.length; j++) { fire('pointermove', pts[j]); await new Promise(r => requestAnimationFrame(r)); }
            if (up) fire('pointerup', pts[pts.length - 1]);
          };
          T.line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, j) => [x0 + (x1 - x0) * j / n, y0 + (y1 - y0) * j / n]);
          T.ids = i => view.store.slots[i].page.strokes.map(s => s.id);
        }""")

        # (1) Pen: off the right edge and back is one stroke, its off-page points kept as they are.
        for off in ('layer', 'scroller', 'outside'):
            r = ev(f"""async () => {{
              const n = view.store.slots[0].page.strokes.length;
              const pts = [...T.line(700, 150, 900, 150, 50), ...T.line(900, 154, 700, 154, 50).slice(1)];
              await T.edge(0, pts, '{off}');
              const drawing = view.input.drawing;
              view.input.cancel();
              const s = view.store.slots[0].page.strokes;
              const st = s[s.length - 1];
              await view.save();
              const saved = ink.readPage(fs.get(view.store.slots[0].path)).strokes.slice(-1)[0];
              return {{ diskMaxX: saved && Math.max(...saved.points.map(q => q.x)), added: s.length - n, drawing, points: st && st.points.length, maxX: st && Math.max(...st.points.map(q => q.x)),
                ends: st && [st.points[0].x, st.points[0].y, st.points[st.points.length - 1].x, st.points[st.points.length - 1].y],
                xs: st && st.points.slice(45, 56).map(q => q.x), ink: T.darkIn ? T.darkIn(0, 690, 140, 816, 165) : T.ink(0) }};
            }}""")
            check(f'edges ({off}): a pen stroke off the right edge and back is one stroke, ended by pointerup',
                  r['added'] == 1 and not r['drawing'] and r['points'] == 101, r)
            check(f'edges ({off}): off-page points are stored as they are (x up to 900), start and end on the page',
                  r['maxX'] == 900 and r['diskMaxX'] == 900 and r['ends'] == [700, 150, 700, 154], r)
        r = ev("() => ({ ink: T.ink(0), live: T.liveInk() })")
        check('edges: the strokes are drawn on the page (clipped), the overlays cleared', r['ink'] > 500 and r['live'] == 0, r)

        # (2) A gesture that starts in the gap between pages does nothing.
        r = ev("""async () => {
          const n = T.ids(0).length + T.ids(1).length;
          const r0 = T.pages()[0].getBoundingClientRect(), r1 = T.pages()[1].getBoundingClientRect(), k = r0.width / 816;
          const y = (r0.bottom + r1.top) / 2, fire = (type, x) => view.pagesEl.dispatchEvent(new PointerEvent(type, { pointerId: 42,
            pointerType: 'pen', pressure: 0.3, clientX: r0.left + x * k, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 }));
          fire('pointerdown', 100);
          for (let x = 110; x < 300; x += 10) fire('pointermove', x);
          fire('pointerup', 300);
          await T.sleep(50);
          return { added: T.ids(0).length + T.ids(1).length - n, drawing: view.input.drawing, live: T.liveInk() };
        }""")
        check('edges: a pen gesture starting in the gap between pages draws nothing', r == {'added': 0, 'drawing': False, 'live': 0}, r)

        # (3) The stroke eraser keeps erasing across the right edge and the bottom edge (into the gap).
        def edge_erase(mode, off):
            return ev(f"""async () => {{
              view.setTool('pen');
              for (const i of [0, 1]) {{ const ids = T.ids(i); if (ids.length) view.eraseStrokes(i, ids); }}
              const vline = (x, y0, y1) => T.edge(0, T.line(x, y0, x, y1, Math.round(y1 - y0)), 'layer');
              await vline(700, 280, 320);   // hit on the way out of the right edge
              await vline(812, 440, 460);   // 4 px inside the edge: hit by the leg 2 px outside it
              await vline(700, 580, 620);   // hit after coming back
              await vline(400, 280, 620);   // never touched
              await vline(200, 1010, 1040); // hit going down into the gap
              await vline(550, 1010, 1050); // hit coming back up from the gap
              await vline(350, 990, 1010);  // under the part of the drag in the gap, 70 px away
              const before = T.ids(0);
              view.setTool('eraser');
              view.setEraser({{ mode: '{mode}' }});
              await T.edge(0, [...T.line(600, 300, 818, 300, 60), ...T.line(818, 300, 818, 600, 60).slice(1), ...T.line(818, 600, 600, 600, 60).slice(1)], '{off}');
              const right = T.ids(0), rightSamples = view.input.lastErase && view.input.lastErase.samples;
              await T.edge(0, [...T.line(200, 1000, 200, 1080, 20), ...T.line(200, 1080, 550, 1080, 60).slice(1), ...T.line(550, 1080, 550, 1000, 20).slice(1)], '{off}');
              const bottom = T.ids(0), erasing = !!view.input.erasing, bottomSamples = view.input.lastErase && view.input.lastErase.samples;
              view.input.cancel();
              view.setTool('pen');
              return {{ before, right, bottom, erasing, rightSamples, bottomSamples, strokes: view.store.slots[0].page.strokes.map(s => [s.id, s.points.length, Math.round(s.points[0].x)]) }};
            }}""")
        for off in ('scroller', 'outside'):
            r = edge_erase('stroke', off)
            bf = r['before']
            check(f'edges ({off}): the eraser follows every sample off the page (181 right, 101 bottom)',
                  r['rightSamples'] == 181 and r['bottomSamples'] == 101, r)
            check(f'edges ({off}): the eraser dragged off the right edge and back removes the lines on both sides of the exit and the one at the edge',
                  r['right'] == [bf[3], bf[4], bf[5], bf[6]], r)
            check(f'edges ({off}): the eraser dragged into the gap below and back up removes the lines on both sides, not the one 70 px away',
                  r['bottom'] == [bf[3], bf[6]] and not r['erasing'], r)
        # The partial eraser (#15, the default) keeps erasing across edges too: the lines it crossed
        # are cut (replaced by remnants), the line at the edge and the far ones are untouched.
        for off in ('scroller', 'outside'):
            r = edge_erase('partial', off)
            bf, right, bottom = r['before'], set(r['right']), set(r['bottom'])
            check(f'edges ({off}, partial): the eraser follows every sample off the page', r['rightSamples'] == 181 and r['bottomSamples'] == 101, r)
            check(f'edges ({off}, partial): off the right edge and back cuts the lines on both sides of the exit and at the edge; the rest stay',
                  not right & set(bf[0:3]) and set(bf[3:7]) <= right and len(right) >= 4 + 2, r)
            check(f'edges ({off}, partial): into the gap below and back cuts the lines on both sides, not the one 70 px away',
                  not bottom & {bf[4], bf[5]} and {bf[3], bf[6]} <= bottom and not r['erasing'], r)
        # ======== end of 18. Gestures across page edges (#35) ========

        # ======== 19. The partial eraser (#15) ========
        # A "word" of four strokes (three pen lines and a highlighter stroke) erased across the middle.
        r = ev("""async () => {
          delete p.settings.tools;  // a fresh install's tools: #10 saves them, and section 14 changed the eraser's
          await p.createInkNote('Partial', '', 'letter', 'blank');
          await T.sleep(150);
          view.setTool('pen');
          T.pids = () => view.store.slots[0].page.strokes.map(s => s.id);
          for (const x of [200, 230, 260]) await T.pen(0, Array.from({ length: 101 }, (_, j) => [x, 250 + j, 0.3]), { predict: 0 });
          view.commit({ key: view.pages[0] }, { tool: 'highlighter', color: '#ffd400', size: 12,
            points: Array.from({ length: 101 }, (_, j) => ({ x: 320, y: 250 + j, p: 0.5, t: 2 * j })) });
          const strip = { querySelector: sel => T.picker().querySelector(sel) };  // the eraser's picker (#10)
          const active = () => strip.querySelector('.nb-ink-eraser-mode.is-active')?.dataset.eraserMode;
          const modes = { fresh: view.eraser.mode };
          commands['eraser-stroke'].checkCallback(false);
          modes.stroke = [view.pen.tool, view.eraser.mode, active()];
          strip.querySelector('[data-eraser-mode="partial"]').click();
          modes.clicked = [view.eraser.mode, active(), strip.querySelector('[data-eraser-mode="partial"]').getAttribute('aria-pressed')];
          view.setTool('pen');
          commands['eraser-partial'].checkCallback(false);
          modes.partial = [view.pen.tool, view.eraser.mode, active()];
          modes.shown = !!strip.querySelector('.nb-ink-eraser-sizes');
          view.toolbar.closePicker();
          const before = view.store.slots[0].page.strokes.map(s => ({ id: s.id, n: s.points.length }));
          const n = view.history.labels.length;
          await T.pen(0, Array.from({ length: 301 }, (_, j) => [150 + j, 300, 0.3]), { predict: 0 });
          const after = view.store.slots[0].page.strokes.map(s => ({ id: s.id, tool: s.tool, n: s.points.length, y0: s.points[0].y, y1: s.points[s.points.length - 1].y, t0: s.points[0].t }));
          const band = [200, 230, 260].map(x => T.darkIn(0, x - 4, 294, x + 4, 306));
          const kept = [200, 230, 260].map(x => [T.darkIn(0, x - 4, 255, x + 4, 285), T.darkIn(0, x - 4, 315, x + 4, 345)]);
          return { modes, before, after, band, kept, last: view.input.lastErase, steps: view.history.labels.length - n, label: view.history.labels.slice(-1)[0],
            yellow: T.near(0, [255, 239, 153], 14), index: view.pages[0].spatial.size };
        }""")
        print('partial eraser: setup and word:', {k: r[k] for k in ('modes', 'band', 'kept', 'last', 'steps')})
        check('partial: the default eraser mode is partial', r['modes']['fresh'] == 'partial', r['modes'])
        check('partial: "Use the stroke eraser" selects the eraser in stroke mode; the picker shows it',
              r['modes']['stroke'] == ['eraser', 'stroke', 'stroke'], r['modes'])
        check('partial: the picker\'s Partial button switches the mode', r['modes']['clicked'] == ['partial', 'partial', 'true'], r['modes'])
        check('partial: "Use the partial eraser" selects the eraser in partial mode, the picker shown',
              r['modes']['partial'] == ['eraser', 'partial', 'partial'] and r['modes']['shown'], r['modes'])
        old_ids = {x['id'] for x in r['before']}
        after = r['after']
        check('partial: each of the four strokes is cut in two: eight remnants with new ids, in drawing order, top then bottom',
              len(after) == 8 and not old_ids & {a['id'] for a in after} and [a['tool'] for a in after] == ['pen'] * 6 + ['highlighter'] * 2
              and all(a['y1'] < 300 for a in after[0::2]) and all(a['y0'] > 300 for a in after[1::2]), after)
        check('partial: the remnants end at the eraser\'s edge (reach 7.25 for the pen, 12 for the highlighter) and start at t = 0',
              all(abs(a['y1'] - (300 - 7.25)) < 0.2 for a in after[0:6:2]) and all(abs(a['y0'] - (300 + 7.25)) < 0.2 for a in after[1:6:2])
              and abs(after[6]['y1'] - 288) < 0.2 and all(a['t0'] == 0 for a in after), after)
        check('partial: the cut is gone from the bitmap, the untouched parts are drawn; the highlighter parts too',
              r['band'] == [0, 0, 0] and all(a > 30 and b > 30 for a, b in r['kept']) and r['yellow'] > 500, r)
        # As the eraser moves over a line frame by frame, each frame cuts a little more, so a stroke
        # (then its remnants) is cut several times; the stats count each cut.
        check('partial: the drag is one "Erase" undo step; the stats count the cuts, none removed whole; the index follows',
              r['steps'] == 1 and r['label'] == 'Erase' and r['last']['mode'] == 'partial' and r['last']['split'] >= 4
              and r['last']['remnants'] - r['last']['split'] == 4 and r['last']['removed'] == 0 and r['index'] == 8, r)
        partial_after = after

        # Saved and reopened: the remnants are on disk, with the same points.
        r = ev("""async () => {
          await view.save();
          const path = view.store.slots[0].path;
          const disk = ink.readPage(fs.get(path)).strokes.map(s => ({ id: s.id, n: s.points.length }));
          await app.workspace.activeLeaf.detach();
          await T.sleep(30);
          await app.workspace.getLeaf('tab').openFile(app.vault.getFile('Partial.md'));
          await T.sleep(150);
          const reopened = view.store.page(view.store.slots[0]).strokes.map(s => ({ id: s.id, n: s.points.length }));
          return { disk, reopened, kept: [200, 230, 260].map(x => [T.darkIn(0, x - 4, 255, x + 4, 285), T.darkIn(0, x - 4, 315, x + 4, 345)]),
            band: [200, 230, 260].map(x => T.darkIn(0, x - 4, 294, x + 4, 306)) };
        }""")
        want = [{'id': a['id'], 'n': a['n']} for a in partial_after]
        check('partial: the remnants are saved and come back when the note is reopened, drawn',
              r['disk'] == want and r['reopened'] == want and r['band'] == [0, 0, 0] and all(a > 30 and b > 30 for a, b in r['kept']), r)

        # Undo restores the originals (after the reopen, the history is new: cut again first).
        r = ev("""async () => {
          view.setTool('eraser');
          view.setEraser({ mode: 'partial' });
          const before = view.store.slots[0].page.strokes.map(s => ({ id: s.id, n: s.points.length }));
          await T.pen(0, Array.from({ length: 301 }, (_, j) => [150 + j, 330, 0.3]), { predict: 0 });  // cuts the lower remnants
          const cut = view.store.slots[0].page.strokes.map(s => ({ id: s.id, n: s.points.length }));
          const undid = view.undo();
          const undone = view.store.slots[0].page.strokes.map(s => ({ id: s.id, n: s.points.length }));
          const inkUndone = [200, 230, 260].map(x => T.darkIn(0, x - 4, 324, x + 4, 336));
          const index = view.pages[0].spatial.size;
          view.redo();
          const redone = view.store.slots[0].page.strokes.map(s => ({ id: s.id, n: s.points.length }));
          const inkRedone = [200, 230, 260].map(x => T.darkIn(0, x - 4, 324, x + 4, 336));
          await view.save();
          const disk = ink.readPage(fs.get(view.store.slots[0].path)).strokes.map(s => ({ id: s.id, n: s.points.length }));
          return { before, cut, undid, undone, redone, inkUndone, inkRedone, disk, index, index2: view.pages[0].spatial.size, split: view.input.lastErase.split };
        }""")
        check('partial: a second cut splits the lower remnants again (4 more strokes)', len(r['cut']) == 12 and r['split'] >= 4, r)
        check('partial: undo puts the originals back in place (model, bitmap, index)',
              r['undid'] and r['undone'] == r['before'] and all(n > 10 for n in r['inkUndone']) and r['index'] == 8, r)
        check('partial: redo cuts them again with the same remnants (model, bitmap, index, file)',
              r['redone'] == r['cut'] and r['inkRedone'] == [0, 0, 0] and r['index2'] == 12 and r['disk'] == r['cut'], r)

        # The stroke mode still removes whole strokes.
        r = ev("""async () => {
          commands['eraser-stroke'].checkCallback(false);
          const before = T.pids();
          await T.pen(0, Array.from({ length: 141 }, (_, j) => [150 + j, 270, 0.3]), { predict: 0 });  // the upper pen remnants
          const after = T.pids();
          return { before, after, last: view.input.lastErase, band: [200, 230, 260].map(x => T.darkIn(0, x - 4, 250, x + 4, 290)) };
        }""")
        check('partial: stroke mode removes the three upper pen remnants whole, no new strokes',
              len(r['after']) == len(r['before']) - 3 and set(r['after']) <= set(r['before']) and r['last']['removed'] == 3 and r['last']['split'] == 0
              and r['band'] == [0, 0, 0], r)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'partial_eraser.png'))

        # A 300-stroke page: a partial erase sweep across it, measured.
        r = ev("""async () => {
          const files = ink.largeNote('Dense', 'ThreeHundred', 1, 300);
          dirs.add('Dense'); dirs.add('Dense/ThreeHundred');
          for (const [k, v] of Object.entries(files)) fs.set(k, v);
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Dense/ThreeHundred.md'));
          await T.sleep(300);
          const before = view.store.slots[0].page.strokes.length;
          view.setTool('eraser');
          view.setEraser({ mode: 'partial', size: 14 });
          const sweep = Array.from({ length: 800 }, (_, j) => [80 + j * 0.8, 150 + j * 0.9 + 30 * Math.sin(j / 40), 0.3]);
          await T.pen(0, sweep, { per: 8, predict: 0 });
          const last = view.input.lastErase, strokes = view.store.slots[0].page.strokes;
          const ids = new Set(strokes.map(s => s.id)), index = view.pages[0].spatial.size, count = strokes.length;
          view.setTool('pen');
          const steps = view.history.labels.length;
          view.undo();
          const undone = view.store.slots[0].page.strokes.length;
          return { before, last, after: count, unique: ids.size === count, index, undone, steps };
        }""")
        L = r['last']
        print(f"partial eraser on a page with {r['before']} strokes: {L['frames']} frames, frame (hit test + split + redraw) median {L['frameMs']:.2f} ms "
              f"(max {L['frameMaxMs']:.2f}); split {L['split']}, remnants {L['remnants']}, removed whole {L['removed']}; strokes {r['before']} -> {r['after']}")
        check('partial perf: the sweep cuts strokes on the 300-stroke page; ids unique, the index in step; one undo restores them all',
              L['split'] > 10 and r['after'] == r['before'] - L['split'] - L['removed'] + L['remnants'] and r['unique']
              and r['index'] == r['after'] and r['undone'] == r['before'], r)
        check('partial perf: median erase frame under 8 ms (Chromium)', L['frameMs'] < 8, L['frameMs'])
        r = ev("() => { view.toggleStats(); const t = view.contentEl.querySelector('.nb-ink-stats').textContent; view.toggleStats(); return t; }")
        check('partial: the stats overlay shows the partial erase with its cuts and remnants',
              f"last erase: partial, removed {L['removed']}, cuts {L['split']}, remnants {L['remnants']}; erase frame" in r, r)
        # ======== end of 19. The partial eraser (#15) ========

        # ======== 20. Import a PDF and write on it (#14) ========
        # With the fake pdf.js of test/mock-obsidian.js (loadPdfJs): a page renders a red marker
        # square (red 40 x page number) and vertical lines 1 device px wide every 3 points.
        ev("""() => {
          T.pdfBytes = fakePdf([[612, 792], [792, 612], [595.28, 841.89]]);
          dirs.add('Slides');
          fs.set('Slides/lecture.pdf', new Uint8Array(T.pdfBytes));
          T.waitFor = async (f, ms = 3000) => { const t = performance.now(); while (!f() && performance.now() - t < ms) await T.sleep(20); return f(); };
          /** Grey (antialiased or blurred) and black pixels in the line pattern of a canvas of a PDF page `wPt` points wide. */
          T.sharpness = (c, wPt) => {
            const s = c.width / wPt, x0 = Math.round(100 * s), y0 = Math.round(100 * s), n = Math.round(150 * s);
            const d = c.getContext('2d').getImageData(x0, y0, n, n).data;
            let black = 0, grey = 0;
            for (let k = 0; k < d.length; k += 4) { const v = d[k + 1]; if (v < 50) black++; else if (v < 205) grey++; }
            return { black, grey, ratio: grey / Math.max(1, black + grey) };
          };
        }""")
        r = ev("""async () => {
          const before = notices.length;
          commands['import-pdf'].callback();
          const m = modals[modals.length - 1];
          const items = [...m.contentEl.querySelectorAll('.suggestion-item')].map(e => e.textContent);
          [...m.contentEl.querySelectorAll('.suggestion-item')].find(e => e.textContent === 'Slides/lecture.pdf').click();
          await T.waitFor(() => modals.length && modals[modals.length - 1].titleEl.textContent === 'Import PDF as ink note');
          const nm = modals[modals.length - 1], input = nm.contentEl.querySelector('input');
          const name = input.value;
          const t0 = performance.now();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await T.waitFor(() => view.file && view.file.basename === 'lecture' && view.store);
          const ms = performance.now() - t0;
          await T.sleep(100);
          const path = view.file.path, dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
          const md = fs.get(path), note = ink.readNote(md, 'lecture');
          const pages = note.pages.map(id => {
            const svg = fs.get(`${dir}lecture/${id}.svg`), pg = ink.readPage(svg);
            const meta = /<metadata><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/.exec(svg)[1];
            return { size: pg.size, kind: pg.template.kind, source: pg.template.source, page: pg.template.page,
              jpeg: pg.template.image.startsWith('data:image/jpeg;base64,'), imageLen: pg.template.image.length,
              once: svg.split(pg.template.image).length === 2, metaBytes: meta.includes('base64') };
          });
          const pdf = fs.get(`${dir}lecture/lecture.pdf`);
          const same = pdf instanceof Uint8Array && pdf.length === T.pdfBytes.byteLength && pdf.every((b, i) => b === new Uint8Array(T.pdfBytes)[i]);
          const els = T.pages().map(e => e.offsetWidth / e.offsetHeight);
          return { items, name, ms, path, md, pages, same, els, type: view.getViewType(), progress: notices.slice(before),
            files: [...fs.keys()].filter(k => k.startsWith(dir + 'lecture/')).length };
        }""")
        print('pdf import:', {k: r[k] for k in ('path', 'ms', 'items', 'progress')}, r['pages'])
        check('pdf import: the chooser offers the device first, then the vault\'s PDFs', r['items'][:1] == ['Choose a file from this device…'] and 'Slides/lecture.pdf' in r['items'], r['items'])
        check('pdf import: the name defaults to the PDF\'s', r['name'] == 'lecture', r['name'])
        check('pdf import: opens the note in the ink view', r['type'] == 'notebook-ink' and r['path'].endswith('lecture.md'), r)
        check('pdf import: one page per PDF page, each at its own size (points x 96/72)',
              [p['size'] for p in r['pages']] == [{'width': 816, 'height': 1056}, {'width': 1056, 'height': 816}, {'width': 793.7, 'height': 1122.5}], r['pages'])
        check('pdf import: each page records the copied PDF and its page number',
              all(p['kind'] == 'pdf' and p['source'] == 'lecture.pdf' and p['page'] == i + 1 for i, p in enumerate(r['pages'])), r['pages'])
        check('pdf import: each page embeds a JPEG once, not in the metadata',
              all(p['jpeg'] and p['imageLen'] > 1000 and p['once'] and not p['metaBytes'] for p in r['pages']), r['pages'])
        check('pdf import: the PDF is copied byte for byte into the page folder', r['same'] and r['files'] == 4, r)
        check('pdf import: the note\'s template stays blank', '\ntemplate: blank\n' in r['md'], r['md'][:120])
        check('pdf import: page elements have the pages\' own aspect ratios',
              [round(a, 2) for a in r['els']] == [round(816 / 1056, 2), round(1056 / 816, 2), round(793.7 / 1122.5, 2)], r['els'])
        check('pdf import: progress in a notice', any('page 3 of 3' in n for n in r['progress']), r['progress'])

        # The page files render with their backgrounds as plain <img> (reading view, GitHub).
        r = ev("""async () => {
          const dir = view.file.path.includes('/') ? view.file.path.slice(0, view.file.path.lastIndexOf('/') + 1) : '';
          const out = [];
          for (const id of view.store.slots.map(s => s.id)) out.push(await T.imageInk(`${dir}lecture/${id}.svg`));
          return out;
        }""")
        check('pdf import: each page file renders its PDF page as an image', all(x['n'] > 2000 for x in r) and [x['w'] for x in r] == [816, 1056, 794], r)

        # At 200% the bitmap is drawn from a sharp render of the PDF at its pixel size, not the JPEG.
        r = ev("""async () => {
          view.setZoom(2);
          const c = () => T.pages()[0].querySelector('canvas.nb-ink-bitmap');
          const hit = () => c() && pdfjsStats.renders.some(([n, w, h]) => n === 1 && w === c().width && Math.abs(h - c().height) <= 1);
          const got = await T.waitFor(hit, 4000);
          // The render then becomes a PNG image and the page is redrawn with it.
          await T.waitFor(() => T.sharpness(c(), 612).ratio < 0.05, 4000);
          const bmp = c(), sharp = T.sharpness(bmp, 612);
          // The embedded JPEG scaled to the same size, for comparison.
          const img = new Image(); img.src = view.store.page(view.store.slots[0]).template.image; await img.decode();
          const j = document.createElement('canvas'); j.width = bmp.width; j.height = bmp.height;
          j.getContext('2d').drawImage(img, 0, 0, j.width, j.height);
          const jpeg = T.sharpness(j, 612);
          return { got, w: bmp.width, h: bmp.height, sharp, jpeg, renders: p.pdfPages.renders, zoom: view.zoom, marker: T.pixel(0, 10, 10) };
        }""")
        print('pdf at 200%:', r)
        check('pdf 200%: a sharp render at the bitmap\'s pixel size was drawn', r['got'] and r['renders'] >= 1 and r['zoom'] == 2, r)
        check('pdf 200%: the pattern\'s lines are crisp (few grey pixels), unlike the scaled JPEG',
              r['sharp']['black'] > 1000 and r['sharp']['ratio'] < 0.05 and r['jpeg']['ratio'] > 0.3, r)
        check('pdf 200%: it is page 1 (red marker 40)', abs(r['marker'][0] - 40) <= 8 and r['marker'][1] <= 8, r['marker'])

        # A stroke on a PDF page saves, keeping the page's PDF template and image.
        r = ev("""async () => {
          view.resetZoom();
          await T.sleep(100);
          const slot = view.store.slots[1], img = view.store.page(slot).template.image;
          await T.pen(1, T.loops(200, 300, 400));
          await view.save();
          const pg = ink.readPage(fs.get(slot.path));
          return { strokes: pg.strokes.length, kind: pg.template.kind, page: pg.template.page, same: pg.template.image === img, ink: T.near(1, [0x1f, 0x1f, 0x1f], 30) };
        }""")
        check('pdf page: a pen stroke saves, and the page keeps its PDF page and image',
              r['strokes'] == 1 and r['kind'] == 'pdf' and r['page'] == 2 and r['same'] and r['ink'] > 100, r)
        r = ev("""async () => {
          const slot = view.store.slots[1];
          return T.imageInk(slot.path);
        }""")
        check('pdf page: the annotated page file still renders its background', r['n'] > 2000, r)
        r = ev("""async () => {
          view.setTool('highlighter');
          await T.pen(2, T.loops(150, 400, 300));
          view.setTool('eraser');
          await T.pen(1, T.loops(200, 300, 400));
          view.setTool('pen');
          view.undo();
          await view.save();
          const s = view.store.slots;
          return [ink.readPage(fs.get(s[1].path)).strokes.length, ink.readPage(fs.get(s[2].path)).strokes.map(x => x.tool)];
        }""")
        check('pdf page: the highlighter, eraser and undo work on PDF pages', r == [1, ['highlighter']], r)

        # In dark mode a pdf page's default ink stays dark (its paper is the PDF's white), live and committed.
        r = ev("""async () => {
          document.body.classList.add('theme-dark'); app.workspace.trigger('css-change');
          await T.sleep(100);
          const pts = Array.from({ length: 40 }, (_, j) => [300 + j * 4, 700, 0.5]);
          await T.pen(0, pts, { up: false });
          const oc = [...T.pages()[0].querySelectorAll('canvas')].filter(c => !c.classList.contains('nb-ink-bitmap'));
          let live = null;
          for (const c of oc) {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let k = 0; k < d.length; k += 4) if (d[k + 3] > 200) { live = [d[k], d[k + 1], d[k + 2]]; break; }
            if (live) break;
          }
          T.penUp(0, pts[pts.length - 1]);
          await T.sleep(50);
          const committed = T.pixel(0, 360, 700);
          view.undo();
          document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change');
          await T.sleep(100);
          return { live, committed };
        }""")
        check('pdf page dark mode: default ink stays near-black, live and committed',
              r['live'] is not None and max(r['live']) < 80 and max(r['committed']) < 80, r)

        # Without the PDF (not synced yet, or deleted), the page keeps its embedded image.
        r = ev("""async () => {
          const path = view.file.path, dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
          const pdf = fs.get(`${dir}lecture/lecture.pdf`);
          fs.delete(`${dir}lecture/lecture.pdf`);
          p.pdfPages.docs.clear();  // forget the open document, as after a restart
          await view.leaf.setViewState({ type: 'markdown', state: { file: path } });
          await app.workspace.getLeaf(false).setViewState({ type: 'notebook-ink', state: { file: path }, active: true });
          await T.waitFor(() => view.store && T.pages().length === 3);
          const n = p.pdfPages.renders;
          view.setZoom(2);
          await T.sleep(1200);
          const marker = T.pixel(0, 10, 10), c = T.pages()[0].querySelector('canvas.nb-ink-bitmap');
          const out = { renders: p.pdfPages.renders - n, marker, lines: T.sharpness(c, 612) };
          view.resetZoom();
          fs.set(`${dir}lecture/lecture.pdf`, pdf);
          return out;
        }""")
        check('pdf missing: no sharp render, the embedded image is drawn instead',
              r['renders'] == 0 and abs(r['marker'][0] - 40) <= 16 and r['lines']['black'] + r['lines']['grey'] > 1000, r)

        # From the device: the first row opens a file input (the iPad's Files app).
        r = ev("""async () => {
          const click = HTMLInputElement.prototype.click;
          let picked = null;
          HTMLInputElement.prototype.click = function () { picked = this; };
          try {
            commands['import-pdf'].callback();
            const m = modals[modals.length - 1];
            m.contentEl.querySelector('.suggestion-item').click();
          } finally { HTMLInputElement.prototype.click = click; }
          const accept = picked && picked.accept, type = picked && picked.type;
          const dt = new DataTransfer();
          dt.items.add(new File([fakePdf([[420, 595]])], 'Worksheet 2.pdf', { type: 'application/pdf' }));
          picked.files = dt.files;
          picked.dispatchEvent(new Event('change'));
          await T.waitFor(() => modals.length && modals[modals.length - 1].titleEl.textContent === 'Import PDF as ink note');
          const nm = modals[modals.length - 1], input = nm.contentEl.querySelector('input');
          const name = input.value;
          input.value = 'WS';
          nm.contentEl.querySelector('button.mod-cta').click();
          await T.waitFor(() => view.file && view.file.basename === 'WS' && view.store);
          const path = view.file.path, dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
          const pg = ink.readPage(fs.get(view.store.slots[0].path));
          return { accept, type, name, path, inputGone: !document.body.contains(picked), pdf: fs.has(`${dir}WS/Worksheet 2.pdf`),
            size: pg.size, source: pg.template.source, pages: view.store.slots.length };
        }""")
        check('pdf from device: a PDF file input, the name from the file, the PDF copied',
              r['type'] == 'file' and 'application/pdf' in r['accept'] and r['name'] == 'Worksheet 2' and r['inputGone'] and r['pdf']
              and r['source'] == 'Worksheet 2.pdf' and r['size'] == {'width': 560, 'height': 793.3} and r['pages'] == 1, r)

        # A file pdf.js can't read: a notice, and nothing written.
        r = ev("""async () => {
          fs.set('Slides/broken.pdf', new TextEncoder().encode('not a pdf'));
          const files = fs.size, before = notices.length;
          commands['import-pdf'].callback();
          [...modals[modals.length - 1].contentEl.querySelectorAll('.suggestion-item')].find(e => e.textContent === 'Slides/broken.pdf').click();
          await T.waitFor(() => modals.length && modals[modals.length - 1].titleEl.textContent === 'Import PDF as ink note');
          modals[modals.length - 1].contentEl.querySelector('button.mod-cta').click();
          await T.waitFor(() => notices.slice(before).some(n => n.startsWith("Couldn't import")));
          return { notices: notices.slice(before), added: fs.size - files };
        }""")
        check('pdf import: an unreadable PDF gives a notice and writes nothing', any(n.startswith("Couldn't import the PDF") for n in r['notices']) and r['added'] == 0, r)
        # Renaming the note (#26) moves its page folder with the PDF; the pages' source is relative
        # to that folder, so it is unchanged and the sharp render finds the PDF.
        r = ev("""async () => {
          const from = view.file.path, dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
          await app.vault.rename(app.vault.getFile(from), `${dir}WS renamed.md`);
          await T.sleep(200);
          const n = pdfjsStats.renders.length;
          view.setZoom(1.5);
          const c = () => T.pages()[0].querySelector('canvas.nb-ink-bitmap');
          const got = await T.waitFor(() => c() && pdfjsStats.renders.slice(n).some(([pg, w]) => pg === 1 && w === c().width), 4000);
          const t = view.store.page(view.store.slots[0]).template;
          view.resetZoom();
          return { file: view.file.path, pdf: fs.has(`${dir}WS renamed/Worksheet 2.pdf`), old: fs.has(`${dir}WS/Worksheet 2.pdf`), source: t.source, got };
        }""")
        check('pdf rename: the PDF moves with the page folder and still renders sharply',
              r['file'].endswith('WS renamed.md') and r['pdf'] and not r['old'] and r['source'] == 'Worksheet 2.pdf' and r['got'], r)

        # Duplicating and deleting pages (#17) never touches the PDF.
        r = ev("""async () => {
          const dir = view.file.path.includes('/') ? view.file.path.slice(0, view.file.path.lastIndexOf('/') + 1) : '';
          const pdf = `${dir}WS renamed/Worksheet 2.pdf`, bytes = fs.get(pdf);
          view.duplicatePage(0);
          await T.sleep(100);
          const dup = view.store.page(view.store.slots[1]).template;
          view.deletePage(1);
          view.deletePage(0);
          await view.save();
          await T.sleep(100);
          return { dup: [dup.kind, dup.page, dup.image.length > 1000], kept: fs.get(pdf) === bytes, pages: view.store.slots.length };
        }""")
        check('pdf pages: duplicate copies the PDF template; deleting pages leaves the PDF file',
              r['dup'] == ['pdf', 1, True] and r['kept'], r)
        # ======== end of 20. Import a PDF and write on it (#14) ========
        # ======== 21. The toolbar and pen presets (#10) ========
        r = ev("""async () => {
          delete p.settings.tools;  // a fresh install
          await p.createInkNote('Toolbar', '', 'letter', 'blank');
          await T.sleep(150);
          T.tb = sel => T.bar().querySelector(sel);
          T.tool = t => T.tb(`.nb-ink-tool[data-tool="${t}"]`);
          T.slot = i => T.tb(`.nb-ink-preset[data-slot="${i}"]`);
          T.activeSlots = () => [...T.bar().querySelectorAll('.nb-ink-preset.is-active')].map(b => Number(b.dataset.slot));
          const bar = T.bar(), groups = [...bar.children].map(g => g.classList[2]);
          const buttons = [...bar.querySelectorAll('button')];
          const size = buttons.map(b => [b.offsetWidth, b.offsetHeight]);
          const lasso = T.tb('.nb-ink-lasso'), ruler = T.tb('.nb-ink-ruler');
          // Every tool in one tap, from every tool.
          const taps = [];
          for (const from of ['pen', 'highlighter', 'eraser']) for (const to of ['pen', 'highlighter', 'eraser']) {
            if (from === to) continue;
            view.setTool(from);
            T.tool(to).click();
            taps.push(view.pen.tool === to && !view.toolbar.pickerOpen && T.tool(to).getAttribute('aria-pressed') === 'true');
          }
          view.setTool('pen');
          return { groups, buttons: buttons.length, size, icons: buttons.filter(b => b.querySelector('svg') || b.dataset.icon || b.getAttribute('data-icon')).length,
            lasso: [lasso.disabled, lasso.getAttribute('aria-label')], ruler: [ruler.disabled, ruler.getAttribute('aria-label')], taps,
            header: [...view.actionsEl.querySelectorAll('[aria-label]')].map(a => a.getAttribute('aria-label')),
            strip: !!view.contentEl.querySelector('.nb-ink-strip, .nb-ink-provisional') };
        }""")
        print('toolbar:', {k: r[k] for k in ('groups', 'buttons', 'lasso', 'ruler', 'header')})
        check('toolbar: tools, presets and page actions in three groups; the provisional strip is gone',
              r['groups'] == ['nb-ink-tools', 'nb-ink-presets', 'nb-ink-page-actions'] and not r['strip'], r)
        check('toolbar: 15 buttons, each a 40 px target; all but the five presets have an icon',
              r['buttons'] == 15 and r['icons'] == 10 and all(w >= 40 and h >= 40 for w, h in r['size']), r)
        check('toolbar: the lasso is a tool (#11); the ruler is a placeholder, disabled with its issue', r['lasso'] == [False, 'Lasso'] and r['ruler'] == [True, 'Ruler: coming in #20'], r)
        check('toolbar: every tool is one tap from every other', r['taps'] == [True] * 6, r['taps'])
        check('toolbar: "Open as markdown" stays the header action', r['header'] == ['Open as markdown'], r['header'])

        # The picker: the second tap on the active tool, nib, colour, size, custom colour and the preview.
        r = ev("""async () => {
          const pen = T.tool('pen');
          pen.click();  // already the pen: the second tap opens its picker
          const picker = view.contentEl.querySelector('.nb-ink-picker');
          const opened = { open: view.toolbar.pickerOpen, shown: picker.style.display !== 'none', expanded: pen.getAttribute('aria-expanded'),
            below: picker.getBoundingClientRect().top >= T.bar().getBoundingClientRect().bottom };
          const canvas = picker.querySelector('canvas.nb-ink-preview');
          const previewInk = rgb => {
            const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let n = 0, m = 0;
            for (let k = 0; k < d.length; k += 4) {
              if (Math.abs(d[k] - 255) + Math.abs(d[k + 1] - 255) + Math.abs(d[k + 2] - 255) > 60) n++;
              if (rgb && Math.abs(d[k] - rgb[0]) + Math.abs(d[k + 1] - rgb[1]) + Math.abs(d[k + 2] - rgb[2]) < 30) m++;
            }
            return rgb ? m : n;
          };
          const p0 = view.toolbar['picker'].previews, ink0 = previewInk();
          picker.querySelector('[data-nib="pressure"]').click();
          picker.querySelector('.nb-ink-swatch[data-color="#1e6fff"]').click();
          const inkThin = previewInk();
          for (let i = 0; i < 3; i++) picker.querySelector('[data-step="1"]').click();
          const after = { ...view.pen, value: picker.querySelector('.nb-ink-size-value').textContent, open: view.toolbar.pickerOpen,
            swatch: picker.querySelector('.nb-ink-swatch.is-active')?.dataset.color, previews: view.toolbar['picker'].previews - p0,
            blue: previewInk([0x1e, 0x6f, 0xff]), inkThin, inkThick: previewInk(), ink0 };
          const custom = picker.querySelector('input.nb-ink-custom-color');
          custom.value = '#12ab34';
          custom.dispatchEvent(new Event('input', { bubbles: true }));
          const customed = { color: view.pen.color, active: picker.querySelectorAll('.nb-ink-swatch.is-active').length,
            customActive: picker.querySelector('.nb-ink-custom').classList.contains('is-active'), green: previewInk([0x12, 0xab, 0x34]) };
          await T.pen(0, T.loops(120, 300, 150));
          const closedByWriting = view.toolbar.pickerOpen;
          await view.save();
          const disk = ink.readPage(fs.get(view.store.slots[0].path)).strokes.slice(-1).map(s => [s.nib, s.color, s.size])[0];
          T.tool('pen').click();
          const reopened = view.toolbar.pickerOpen;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const byEscape = view.toolbar.pickerOpen;
          T.tool('pen').click();
          T.tool('pen').click();
          const byToggle = view.toolbar.pickerOpen;
          T.tool('pen').click();
          document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
          const byTapElsewhere = view.toolbar.pickerOpen;
          // The highlighter's and the eraser's pickers.
          T.tool('highlighter').click(); T.tool('highlighter').click();
          const hp = view.contentEl.querySelector('.nb-ink-picker');
          hp.querySelector('.nb-ink-hl-swatch[data-color="#3ddc84"]').click();
          hp.querySelector('[data-step="-1"]').click();
          const hl = { ...view.highlighter, nibs: hp.querySelectorAll('.nb-ink-nib').length, preview: previewInkOf(hp) };
          function previewInkOf(el) { const c = el.querySelector('canvas.nb-ink-preview'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - 255) + Math.abs(d[k + 2] - 255) > 60) n++; return n; }
          T.tool('eraser').click();
          const hlClosed = view.toolbar.pickerOpen;
          T.tool('eraser').click();
          const ep = view.contentEl.querySelector('.nb-ink-picker');
          ep.querySelector('[data-eraser-size="14"]').click();
          ep.querySelector('[data-eraser-mode="stroke"]').click();
          const er = { ...view.eraser, open: view.toolbar.pickerOpen };
          T.bar().querySelector('.nb-ink-page-settings').click();
          const menu = { kind: view.toolbar.pickerOpen, items: [...view.contentEl.querySelectorAll('.nb-ink-picker .nb-ink-menu-item')].map(b => b.textContent),
            paper: view.contentEl.querySelector('.nb-ink-picker .nb-ink-paper').textContent };
          view.toolbar.closePicker();
          return { opened, after, customed, closedByWriting, disk, reopened, byEscape, byToggle, byTapElsewhere, hl, hlClosed, er, menu };
        }""")
        print('toolbar picker:', r)
        check('picker: a second tap on the active tool opens its picker under the toolbar',
              r['opened'] == {'open': 'pen', 'shown': True, 'expanded': 'true', 'below': True}, r['opened'])
        a = r['after']
        check('picker: nib, colour and 0.5 px steps change the pen and stay open', a['nib'] == 'pressure' and a['color'] == '#1e6fff' and a['size'] == 4
              and a['value'] == '4 px' and a['swatch'] == '#1e6fff' and a['open'] == 'pen', a)
        check('picker: the preview is drawn on each change, in the colour, thicker with the size',
              a['previews'] >= 5 and a['ink0'] > 100 and a['blue'] > 100 and a['inkThick'] > a['inkThin'], a)
        check('picker: the custom colour sets the pen (no preset swatch active) and the preview', r['customed']['color'] == '#12ab34'
              and r['customed']['active'] == 0 and r['customed']['customActive'] and r['customed']['green'] > 100, r['customed'])
        check('picker: starting to write closes it; the stroke has the chosen pen', r['closedByWriting'] is None and r['disk'] == ['pressure', '#12ab34', 4], r)
        check('picker: closed by Escape, by its button again and by a tap elsewhere', r['reopened'] == 'pen' and r['byEscape'] is None
              and r['byToggle'] is None and r['byTapElsewhere'] is None, r)
        check('picker: the highlighter has colours and 0.5 px sizes, no nib, with a preview', r['hl']['color'] == '#3ddc84' and r['hl']['size'] == 17.5
              and r['hl']['nibs'] == 0 and r['hl']['preview'] > 100, r['hl'])
        check('picker: switching tool closes the other tool\'s picker; the eraser\'s has sizes and mode',
              r['hlClosed'] is None and r['er'] == {'size': 14, 'mode': 'stroke', 'open': 'eraser'}, r)
        check('picker: page settings lists the template choices and the paper size', r['menu']['kind'] == 'page'
              and r['menu']['items'] == ['Template of this page…', 'Template of all pages…', 'Add page with template…']
              and r['menu']['paper'] == 'Paper size: Letter, 8.5 × 11 in', r['menu'])

        # Add page from the toolbar, and page settings' template change.
        r = ev("""async () => {
          const n = view.store.slots.length;
          T.tb('.nb-ink-add-page').click();
          await T.sleep(50);
          const added = view.store.slots.length - n, label = view.history.labels.slice(-1)[0];
          T.tb('.nb-ink-page-settings').click();
          view.contentEl.querySelector('.nb-ink-picker .nb-ink-menu-page-template').click();
          await T.choose('Dots, 5 mm');
          const tpl = ink.templateName(view.store.slots[view.currentPageIndex()].page.template);
          return { added, label, tpl, closed: view.toolbar.pickerOpen, undo: !T.tb('.nb-ink-undo').disabled };
        }""")
        check('toolbar: "Add page" adds a page (undoable); page settings changes this page\'s template',
              r['added'] == 1 and r['label'] == 'Add page' and r['tpl'] == 'dots-5mm' and r['closed'] is None and r['undo'], r)

        # Presets: one tap applies, the matching one is highlighted, save and long-press replace.
        r = ev("""async () => {
          const out = {};
          out.labels = [0, 1, 2, 3, 4].map(i => T.slot(i).getAttribute('aria-label'));
          view.setTool('pen');
          T.slot(1).click();
          out.blue = [{ ...view.pen }, T.activeSlots()];
          T.slot(4).click();
          out.hl = [view.pen.tool, { ...view.highlighter }, T.activeSlots()];
          T.slot(3).click();
          out.pressure = [{ ...view.pen }, T.activeSlots()];
          view.setPen({ size: 5 });
          out.none = T.activeSlots();
          // "Save as favourite" with every slot taken asks which to replace.
          T.tool('pen').click();
          const picker = view.contentEl.querySelector('.nb-ink-picker');
          picker.querySelector('.nb-ink-save-preset').click();
          out.asks = picker.querySelector('.nb-ink-replace').style.display !== 'none';
          picker.querySelector('.nb-ink-replace-slot[data-slot="2"]').click();
          out.saved = [{ ...view.presets[2] }, T.activeSlots(), picker.querySelector('.nb-ink-save-status').textContent];
          view.toolbar.closePicker();
          // An empty slot: one tap saves the current pen; "Save as favourite" fills the first free slot.
          p.settings.presets[4] = null;
          view.toolbar.render();
          out.empty = T.slot(4).classList.contains('is-empty');
          view.setPen({ color: '#7b4fd6', size: 1.5, nib: 'uniform' });
          T.slot(4).click();
          out.filled = [{ ...view.presets[4] }, T.activeSlots()];
          p.settings.presets[0] = null;
          view.setTool('highlighter');
          T.tool('highlighter').click();
          view.contentEl.querySelector('.nb-ink-picker .nb-ink-save-preset').click();
          out.free = { ...view.presets[0] };
          view.toolbar.closePicker();
          // A long press replaces a slot with the current settings, without applying it.
          view.setTool('pen');
          view.setPen({ color: '#f28c28', size: 6, nib: 'pressure' });
          const b = T.slot(1), r = b.getBoundingClientRect(), at = { clientX: r.left + 20, clientY: r.top + 20, bubbles: true, pointerType: 'pen' };
          b.dispatchEvent(new PointerEvent('pointerdown', at));
          await T.sleep(700);
          b.dispatchEvent(new PointerEvent('pointerup', at));
          b.click();
          out.long = [{ ...view.presets[1] }, { ...view.pen }, T.activeSlots()];
          // A short press only applies.
          T.slot(2).dispatchEvent(new PointerEvent('pointerdown', at));
          T.slot(2).dispatchEvent(new PointerEvent('pointerup', at));
          T.slot(2).click();
          out.short = [{ ...view.presets[2] }, view.pen.size, T.activeSlots()];
          // The eraser can't be saved.
          view.setTool('eraser');
          out.eraser = view.savePreset(3);
          view.setTool('pen');
          return out;
        }""")
        print('presets:', r)
        check('presets: five labelled slots with the defaults', all(l.startswith(f'Favourite {i + 1}: ') for i, l in enumerate(r['labels']))
              and 'uniform pen #1e6fff 2.5 px' in r['labels'][1] and 'highlighter #ffd400 18 px' in r['labels'][4], r['labels'])
        check('presets: one tap applies a pen preset and highlights it', r['blue'] == [{'tool': 'pen', 'nib': 'uniform', 'color': '#1e6fff', 'size': 2.5}, [1]], r['blue'])
        check('presets: one tap applies the highlighter preset (switching tool)', r['hl'] == ['highlighter', {'color': '#ffd400', 'size': 18}, [4]], r['hl'])
        check('presets: the pressure preset; black 2.5 is not highlighted with it', r['pressure'] == [{'tool': 'pen', 'nib': 'pressure', 'color': '#000000', 'size': 4}, [3]], r['pressure'])
        check('presets: no highlight once the settings match none', r['none'] == [], r['none'])
        check('presets: "Save as favourite" with all slots taken asks which to replace, then saves there',
              r['asks'] and r['saved'] == [{'tool': 'pen', 'color': '#000000', 'size': 5, 'nib': 'pressure'}, [2], 'Saved as favourite 3'], r)
        check('presets: a tap on an empty slot saves the current pen into it', r['empty'] and r['filled'] == [{'tool': 'pen', 'color': '#7b4fd6', 'size': 1.5, 'nib': 'uniform'}, [4]], r)
        check('presets: "Save as favourite" fills the first free slot', r['free'] == {'tool': 'highlighter', 'color': '#ffd400', 'size': 18}, r['free'])
        check('presets: a long press replaces the slot with the current pen and does not apply the old one',
              r['long'][0] == {'tool': 'pen', 'color': '#f28c28', 'size': 6, 'nib': 'pressure'} and r['long'][1]['color'] == '#f28c28' and r['long'][2] == [1], r['long'])
        check('presets: a short press applies', r['short'][1] == 5 and r['short'][2] == [2], r['short'])
        check('presets: the eraser is not saved as a preset', r['eraser'] is False, r)

        # Persistence: saved in the plugin data (debounced), and back after the plugin reloads.
        r = ev("""async () => {
          view.setTool('highlighter');
          view.setHighlighter({ color: '#4fc3f7', size: 22.5 });
          view.setPen({ nib: 'uniform', color: '#8a8a8a', size: 3.5 });
          view.setTool('eraser');
          view.setEraser({ size: 14, mode: 'stroke' });
          const soon = JSON.stringify(pluginData && pluginData.tools);
          await T.sleep(700);
          const data = JSON.parse(JSON.stringify(pluginData));
          const presets = JSON.stringify(view.presets);
          // Reload: a new plugin instance reads the data; a view it opens has the same tools and presets.
          const old = view, oldLeaf = view.leaf;
          const q = await loadPlugin();
          const leaf = app.workspace.getLeaf('tab');
          await leaf.setViewState({ type: 'notebook-ink', state: { file: 'Toolbar.md' }, active: true });
          app.workspace.revealLeaf(leaf);
          await T.sleep(150);
          const v = leaf.view;
          const back = { pen: { ...v.pen }, highlighter: { ...v.highlighter }, eraser: { ...v.eraser }, presets: JSON.stringify(v.presets),
            active: v.contentEl.querySelector('.nb-ink-tool.is-active').dataset.tool, other: v !== old };
          // Bad saved values fall back to the defaults, with a warning.
          const warned = [], warn = console.warn;
          console.warn = (...a) => warned.push(a.join(' '));
          window.pluginData = { ...data, tools: { pen: { tool: 'quill', color: 'blue', size: 3 } }, presets: [{ tool: 'pen', color: '#000000', size: 2 }, 7] };
          const bad = await loadPlugin();
          console.warn = warn;
          const parsed = { tools: bad.settings.tools, presets: bad.settings.presets };
          bad.unload();
          window.pluginData = data;
          await leaf.detach();
          q.unload();
          app.workspace.revealLeaf(oldLeaf);
          window.view = old;
          await T.sleep(100);
          return { soon, data: { tools: data.tools, presets: data.presets }, presets, back, warned: warned.length, parsed };
        }""")
        print('toolbar persistence:', r)
        want = {'pen': {'tool': 'eraser', 'nib': 'uniform', 'color': '#8a8a8a', 'size': 3.5}, 'highlighter': {'color': '#4fc3f7', 'size': 22.5}, 'eraser': {'size': 14, 'mode': 'stroke'}}
        check('persist: tools are saved in the plugin data after a short delay', r['data']['tools'] == want and r['soon'] != __import__('json').dumps(want), r)
        check('persist: presets are saved in the plugin data', __import__('json').loads(r['presets']) == r['data']['presets'] and len(r['data']['presets']) == 5, r)
        check('persist: after a plugin reload a new view has the same tool, settings and presets',
              r['back']['other'] and {k: r['back'][k] for k in ('pen', 'highlighter', 'eraser')} == want and r['back']['active'] == 'eraser'
              and r['back']['presets'] == r['presets'], r['back'])
        check('persist: invalid saved tools and presets fall back to defaults with warnings',
              r['warned'] >= 3 and r['parsed']['tools']['pen'] == {'tool': 'pen', 'nib': 'uniform', 'color': '#000000', 'size': 3}
              and r['parsed']['presets'] == [{'tool': 'pen', 'color': '#000000', 'size': 2, 'nib': 'uniform'}, None], r['parsed'])

        # Portrait and landscape iPad widths: at most two rows, nothing cut off; the picker fits.
        fits = {}
        for name, w, h in (('portrait', 768, 1024), ('landscape', 1024, 768)):
            page.set_viewport_size({'width': w, 'height': h})
            # The view as wide as the iPad screen (sidebars closed), less Obsidian's own bars in height.
            ev(f"() => {{ const s = document.getElementById('leaf').style; s.width = '{w}px'; s.height = '{h - 120}px'; s.boxSizing = 'border-box'; }}")
            page.wait_for_timeout(300)
            fits[name] = ev("""async () => {
              const bar = T.bar(), r = bar.getBoundingClientRect(), buttons = [...bar.querySelectorAll('button')];
              const rows = new Set(buttons.map(b => Math.round(b.getBoundingClientRect().top))).size;
              const inside = buttons.every(b => { const q = b.getBoundingClientRect(); return q.left >= r.left - 0.5 && q.right <= r.right + 0.5; });
              T.tool(view.pen.tool).click();
              const p = view.contentEl.querySelector('.nb-ink-picker').getBoundingClientRect(), c = view.contentEl.getBoundingClientRect();
              const picker = p.left >= c.left && p.right <= c.right;
              return { width: Math.round(r.width), height: Math.round(r.height), rows, inside, scroll: bar.scrollWidth <= bar.clientWidth, picker };
            }""")
            page.locator('.nb-ink-toolbar').screenshot(path=os.path.join(OUT, f'toolbar_{name}.png'))
            page.locator('#leaf').screenshot(path=os.path.join(OUT, f'toolbar_{name}_view.png'))
            ev("() => view.toolbar.closePicker()")
        page.set_viewport_size({'width': 1000, 'height': 700})
        ev("() => { const s = document.getElementById('leaf').style; s.width = s.height = s.boxSizing = ''; }")
        page.wait_for_timeout(200)
        print('toolbar fits:', fits)
        for name in ('portrait', 'landscape'):
            f = fits[name]
            check(f'toolbar: fits the iPad {name} width in at most two rows, no overflow; the picker inside the view',
                  f['width'] <= (768 if name == 'portrait' else 1024) and f['rows'] <= 2 and f['inside'] and f['scroll'] and f['picker'], f)

        # Pencil taps on the toolbar and the picker still register (touchstart not prevented).
        r = ev("""() => {
          T.tool(view.pen.tool).click();
          const picker = view.contentEl.querySelector('.nb-ink-picker');
          const els = [T.tool('pen'), T.tool('eraser'), T.slot(0), T.tb('.nb-ink-undo'), T.tb('.nb-ink-add-page'), T.tb('.nb-ink-page-settings'),
            T.tb('.nb-ink-pages-toggle'), ...picker.querySelectorAll('button, input, canvas')];
          const starts = els.map(el => T.touch(el, 'touchstart', 'stylus'));
          const moves = [T.touch(T.tool('pen'), 'touchmove', 'stylus')];
          view.toolbar.closePicker();
          return { n: els.length, prevented: starts.filter(Boolean).length, moves };
        }""")
        check('toolbar: Pencil touchstarts on toolbar and picker controls are not prevented (taps work); touchmove is',
              r['n'] > 10 and r['prevented'] == 0 and r['moves'] == [True], r)
        # ======== end of 21. The toolbar and pen presets (#10) ========

        # ======== 21. Pen polish (#32): smooth edges and the settled stroke ========
        # The same iPad-like stroke (a gentle arc, samples in 0.5 px steps as the Pencil reports
        # them) rasterised at device pixel ratio 2, the way the page bitmap draws it: before, the
        # raw points' outline as a straight-segment polygon (0.3.0); after, strokePath (the refitted
        # points' outline as quadratic curves). Edge roughness is the RMS second difference, column
        # by column, of the stroke's centre (alpha-weighted) and of its coverage: a staircase or a
        # polygon's kinks show up in both, a smooth edge in neither.
        r = ev("""() => {
          const pts = [];
          for (let j = 0, lastX = -1, lastY = -1; j < 700; j++) {
            const a = j / 700, x = Math.round((60 + 300 * a) * 2) / 2, y = Math.round((80 - 60 * Math.sin(Math.PI * a) + 0.35 * Math.sin(j * 1.7)) * 2) / 2;
            if (Math.hypot(x - lastX, y - lastY) < 0.25) continue;
            pts.push({ x, y, p: 0.08, t: j * 2.1 });
            lastX = x; lastY = y;
          }
          const s = { tool: 'pen', nib: 'uniform', size: 2.5, points: pts };
          const paths = { before: ink.polygon(ink.strokeOutline(s, true)), after: ink.strokePath(s) };
          const out = {}, R = 2, W = 420, H = 110;
          for (const [k, d] of Object.entries(paths)) {
            const c = document.createElement('canvas');
            c.width = W * R; c.height = H * R;
            const g = c.getContext('2d');
            g.setTransform(R, 0, 0, R, 0, 0);
            g.fillStyle = '#000';
            g.fill(new Path2D(d));
            const a = g.getImageData(0, 0, c.width, c.height).data, cen = [], cov = [];
            for (let x = 100 * R; x < 320 * R; x++) {
              let sw = 0, sy = 0;
              for (let y = 0; y < c.height; y++) { const v = a[(y * c.width + x) * 4 + 3] / 255; sw += v; sy += v * y; }
              cen.push(sy / sw); cov.push(sw);
            }
            const rough = v => { let q = 0; for (let i = 1; i < v.length - 1; i++) q += (v[i - 1] - 2 * v[i] + v[i + 1]) ** 2; return Math.sqrt(q / (v.length - 2)); };
            out[k] = { centre: rough(cen), coverage: rough(cov) };
            // Evidence: a 6x nearest-neighbour zoom of the device pixels of part of the arc.
            const z = document.createElement('canvas'), zx = 70 * R, zy = 16 * R, zw = 80 * R, zh = 30 * R;
            z.width = zw * 6; z.height = zh * 6;
            const zg = z.getContext('2d');
            zg.fillStyle = '#fff'; zg.fillRect(0, 0, z.width, z.height);
            zg.imageSmoothingEnabled = false;
            zg.drawImage(c, zx, zy, zw, zh, 0, 0, z.width, z.height);
            out[k].png = z.toDataURL('image/png');
          }
          return { ...out, points: pts.length, d: [paths.before.length, paths.after.length] };
        }""")
        import base64
        for k in ('before', 'after'):
            with open(os.path.join(OUT, f'pen_edges_{k}.png'), 'wb') as f:
                f.write(base64.b64decode(r[k].pop('png').split(',', 1)[1]))
        print(f"pen edges: {r['points']} points; roughness (RMS second difference, device px) centre {r['before']['centre']:.4f} -> {r['after']['centre']:.4f}, "
              f"coverage {r['before']['coverage']:.4f} -> {r['after']['coverage']:.4f}; path length {r['d'][0]} -> {r['d'][1]} chars")
        check('pen edges (#32): the curved, refitted outline is smoother than the 0.3.0 polygon (centre and coverage roughness down by a third)',
              r['after']['centre'] < 0.67 * r['before']['centre'] and r['after']['coverage'] < 0.67 * r['before']['coverage'], r)
        # ======== end of 21. Pen polish (#32) ========

        # ======== 22. The lasso (#11) ========
        # A "paragraph" of short handwriting-like strokes on page 1 of a two-page note, a stroke
        # below it and a highlighter under it; the lasso selects, moves, resizes, recolours,
        # duplicates, deletes, cuts, copies and pastes (here and into another note), and moves onto
        # page 2; each step is undone and redone, and the saved page is compared with the model.
        r = ev("""async () => {
          await p.createInkNote('Lasso', '', 'letter', 'blank');  // the clipboard is on the view's plugin: view['settingsHost']
          await T.sleep(150);
          view.addPage();
          view.scrollToPage(0);
          await T.sleep(100);
          T.P = i => view.store.slots[i].page;
          T.path = i => view.store.slots[i].path;
          /** A closed loop around the box [x0, y0, x1, y1] (page px), as a pen or mouse drag. */
          T.loop = ([x0, y0, x1, y1], n = 12) => {
            const pts = [];
            for (let j = 0; j < n; j++) pts.push([x0 + (x1 - x0) * j / n, y0, 0.3]);
            for (let j = 0; j < n; j++) pts.push([x1, y0 + (y1 - y0) * j / n, 0.3]);
            for (let j = 0; j < n; j++) pts.push([x1 - (x1 - x0) * j / n, y1, 0.3]);
            for (let j = 0; j <= n; j++) pts.push([x0, y1 - (y1 - y0) * j / n, 0.3]);
            return pts;
          };
          T.lasso = (box, type = 'pen', id = 21) => T.pen(0, T.loop(box), { type, id, predict: 0 });
          /** A drag (page px of page i) from a to b in n steps, left down with up false. */
          T.drag = (i, [ax, ay], [bx, by], { n = 12, up = true, type = 'pen' } = {}) =>
            T.pen(i, Array.from({ length: n + 1 }, (_, j) => [ax + (bx - ax) * j / n, ay + (by - ay) * j / n, 0.3]), { type, id: 23, per: 1, predict: 0, up });
          T.snap = i => JSON.parse(JSON.stringify(T.P(i).strokes));
          T.disk = async i => { await view.save(); return ink.readPage(fs.get(T.path(i))).strokes; };
          T.selInk = () => {
            const c = view.contentEl.querySelector('canvas.nb-ink-selection');
            if (!c || !c.isConnected || !c.width) return 0;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
            return n;
          };
          // The paragraph: three lines of five "words" at y 150, 200, 250, x 100..500.
          view.setTool('pen');
          for (const y of [150, 200, 250]) for (let w = 0; w < 5; w++) {
            const x0 = 100 + w * 80;
            await T.pen(0, Array.from({ length: 30 }, (_, j) => [x0 + j * 2, y + 8 * Math.sin(j / 3), 0.3]), { predict: 0 });
          }
          view.commit({ key: view.pages[0] }, { tool: 'highlighter', color: '#ffd400', size: 14,
            points: Array.from({ length: 60 }, (_, j) => ({ x: 120 + j * 5, y: 200, p: 0.5, t: 2 * j })) });
          await T.pen(0, Array.from({ length: 30 }, (_, j) => [100 + j * 4, 600, 0.3]), { predict: 0 });  // outside
          T.para = view.store.slots[0].page.strokes.slice(0, 16).map(s => s.id);
          T.outside = view.store.slots[0].page.strokes[16].id;
          return { n: T.P(0).strokes.length, tools: T.P(0).strokes.map(s => s.tool).join(','), lassoBtn: !!T.bar().querySelector('.nb-ink-lasso:not([disabled])'),
            cmd: commands['tool-lasso'].checkCallback(true), paste: commands['paste-strokes'].checkCallback(true) };
        }""")
        check('lasso setup: 15 words, a highlighter and a stroke outside; the lasso button is enabled; "Use the lasso" is available, "Paste strokes" not yet',
              r['n'] == 17 and r['lassoBtn'] and r['cmd'] and not r['paste'], r)

        # The Pencil lassos the paragraph; the menu opens; a finger never lassos; a tap outside deselects.
        r = ev("""async () => {
          T.bar().querySelector('.nb-ink-lasso').click();
          const tool = view.pen.tool;
          T.bar().querySelector('.nb-ink-lasso').click();  // second tap: the hint and Paste
          const picker = view.contentEl.querySelector('.nb-ink-picker');
          const hint = { open: view.toolbar.pickerOpen, text: !!picker.querySelector('.nb-ink-lasso-hint'), pasteDisabled: picker.querySelector('.nb-ink-lasso-paste').disabled };
          view.toolbar.closePicker();
          const n0 = T.P(0).strokes.length;
          await T.lasso([80, 120, 520, 280]);
          await T.sleep(30);
          const sel = view.selection;
          const out = { tool, hint, sel: sel && sel.ids.slice().sort(), live: T.liveInk(), selInk: T.selInk(), menu: view.selectionMenuOpen, same: T.P(0).strokes.length === n0 };
          view.clearSelection();
          await T.lasso([80, 120, 520, 280], 'touch', 31);
          out.finger = view.selection;
          view.scrollToPage(0);  // the finger panned the view (with momentum): back to the top
          await T.sleep(100);
          return out;
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'lasso_selected.png'))
        para = ev("() => T.para.slice().sort()")
        check('lasso: the toolbar button selects the lasso; a second tap shows the hint, Paste disabled with nothing copied',
              r['tool'] == 'lasso' and r['hint'] == {'open': 'lasso', 'text': True, 'pasteDisabled': True}, r['hint'])
        check('lasso: a Pencil loop selects the paragraph and its highlighter (16), not the stroke outside; nothing is drawn',
              r['sel'] == para and r['same'], r)
        check('lasso: the loop is cleared on release; the box and handle are drawn; the menu opens', r['live'] == 0 and r['selInk'] > 500 and r['menu'], r)
        check('lasso: a finger drawing a loop selects nothing', r['finger'] is None, r['finger'])

        # A real mouse drag lassos too.
        box = ev("() => { const r = T.pages()[0].getBoundingClientRect(); return { x: r.left, y: r.top, k: r.width / 816 }; }")
        k = box['k']
        loop = ev("() => T.loop([80, 120, 520, 280])")
        page.mouse.move(box['x'] + loop[0][0] * k, box['y'] + loop[0][1] * k)
        page.mouse.down()
        for x, y, _ in loop[1:]:
            page.mouse.move(box['x'] + x * k, box['y'] + y * k, steps=2)
        page.mouse.up()
        page.wait_for_timeout(50)
        r = ev("() => view.selection && view.selection.ids.slice().sort()")
        check('lasso: a mouse loop selects the same strokes', r == para, r)

        # Move: drag from inside the box by (+40, +30); the saved points shift by exactly that.
        r = ev("""async () => {
          view.select(0, T.para);
          const before = T.snap(0), inkBefore = T.ink(0);
          await T.drag(0, [300, 200], [340, 230], { up: false });
          const mid = { ink: T.ink(0), selInk: T.selInk(), menu: view.selectionMenuOpen, n: T.P(0).strokes.length };
          T.penUp(0, [340, 230], 23);
          await T.sleep(20);
          const after = T.snap(0), disk = await T.disk(0);
          const moved = after.filter(s => T.para.includes(s.id));
          const orig = new Map(before.map(s => [s.id, s]));
          const shift = moved.every(s => s.points.every((q, j) => Math.abs(q.x - orig.get(s.id).points[j].x - 40) < 1e-9 && Math.abs(q.y - orig.get(s.id).points[j].y - 30) < 1e-9)
            && s.size === orig.get(s.id).size);
          const outside = JSON.stringify(after.find(s => s.id === T.outside)) === JSON.stringify(orig.get(T.outside));
          const order = after.map(s => s.id).join() === before.map(s => s.id).join();
          const undo = view.undo(), undone = JSON.stringify(T.snap(0)) === JSON.stringify(before), selAfterUndo = view.selection;
          view.redo();
          const redone = JSON.stringify(T.snap(0)) === JSON.stringify(after);
          return { inkBefore, mid, shift, outside, order, disk: JSON.stringify(disk) === JSON.stringify(after), undo, undone, selAfterUndo, redone,
            labels: view.history.labels.slice(-1), sel: view.selection, drag: view.lassoStats.lastDrag };
        }""")
        print('lasso move:', {k: r[k] for k in ('inkBefore', 'mid', 'drag')})
        check('lasso move: while dragged, the page is drawn without the selection and the overlay shows it; the menu hides',
              r['mid']['ink'] < r['inkBefore'] * 0.5 and r['mid']['selInk'] > 1000 and not r['mid']['menu'] and r['mid']['n'] == 17, r['mid'])
        check('lasso move: every selected point moves by the drag (+40, +30), sizes kept, drawing order kept, the rest untouched',
              r['shift'] and r['outside'] and r['order'], r)
        check('lasso move: the saved page matches the model', r['disk'])
        check('lasso move: one undo step ("Move selection"); undo restores and deselects; redo moves again',
              r['labels'] == ['Move selection'] and r['undo'] and r['undone'] and r['selAfterUndo'] is None and r['redone'], r)

        # Resize by the corner handle: points and sizes scale around the top-left corner; the minimum size.
        r = ev("""async () => {
          view.select(0, T.para);
          const box = view.selection.box, s = 1 / (T.pages()[0].getBoundingClientRect().width / 816);
          const before = T.snap(0), orig = new Map(before.map(q => [q.id, q]));
          const hx = box[2] + 3 * s, hy = box[3] + 3 * s;  // the handle: the padded box's corner
          const tx = box[0] + (hx - box[0]) * 1.5, ty = box[1] + (hy - box[1]) * 1.5;
          await T.drag(0, [hx, hy], [tx, ty]);
          await T.sleep(20);
          const after = T.snap(0), sel = after.filter(q => T.para.includes(q.id));
          // The scale the view used, from one point, then every point and size checked against it.
          // The point farthest from the corner gives the scale most precisely.
          let a = null, o = null;
          for (const q of sel) q.points.forEach((pt, j) => { const op = orig.get(q.id).points[j]; if (!o || op.x - box[0] > o.x - box[0]) { a = pt; o = op; } });
          const kx = (a.x - box[0]) / (o.x - box[0]);
          const r1 = n => Math.round(n * 10) / 10;
          const bad = [];
          let errMax = 0;
          for (const q of sel) {
            const o = orig.get(q.id);
            q.points.forEach((pt, j) => { errMax = Math.max(errMax, Math.abs(pt.x - (box[0] + (o.points[j].x - box[0]) * kx)), Math.abs(pt.y - (box[1] + (o.points[j].y - box[1]) * kx))); });
            if (Math.abs(q.size - Math.max(0.5, r1(o.size * kx))) > 0.1001) bad.push([q.id, o.size, q.size]);
          }
          const disk = JSON.stringify(await T.disk(0)) === JSON.stringify(after);
          const labels = view.history.labels.slice(-1);
          // Smallest: the handle dragged onto the top-left corner.
          view.select(0, T.para);
          const b2 = view.selection.box;
          await T.drag(0, [b2[2] + 3 * s, b2[3] + 3 * s], [b2[0], b2[1]]);
          await T.sleep(20);
          const tiny = T.P(0).strokes.filter(q => T.para.includes(q.id) && q.tool === 'pen').map(q => q.size);
          const tinyBox = view.selection.box;
          view.undo();
          const back1 = JSON.stringify(T.snap(0)) === JSON.stringify(after);
          view.undo();
          const back0 = JSON.stringify(T.snap(0)) === JSON.stringify(before);
          view.redo();
          const again = JSON.stringify(T.snap(0)) === JSON.stringify(after);
          return { k: kx, errMax, bad, disk, labels, tiny: [Math.min(...tiny), Math.max(...tiny)], tinyW: Math.max(tinyBox[2] - tinyBox[0], tinyBox[3] - tinyBox[1]), back1, back0, again };
        }""")
        print('lasso resize:', {k: r[k] for k in ('k', 'errMax', 'tiny', 'tinyW')})
        check('lasso resize: the handle scales uniformly about 1.5x; every point scales around the box corner (to 0.05 px); sizes scale, rounded to 0.1',
              abs(r['k'] - 1.5) < 0.02 and r['errMax'] <= 0.06 and not r['bad'], r)
        check('lasso resize: the saved page matches; one undo step ("Resize selection")', r['disk'] and r['labels'] == ['Resize selection'], r)
        check('lasso resize: shrunk to the smallest, pen stroke sizes stop at 0.5 px and the box stays a few px', r['tiny'] == [0.5, 0.5] and 3 < r['tinyW'] < 40, r)
        check('lasso resize: undo and redo step through each resize', r['back1'] and r['back0'] and r['again'], r)

        # Recolour from the menu: pen strokes turn red, the highlighter keeps its colour.
        r = ev("""async () => {
          view.undo();  // back to the moved paragraph
          view.select(0, T.para);
          const before = T.snap(0);
          view.contentEl.querySelector('.nb-ink-selmenu .nb-ink-swatch[data-color="#e0301e"]').click();
          const sel = T.P(0).strokes.filter(q => T.para.includes(q.id));
          const colors = [...new Set(sel.map(q => q.tool + ' ' + q.color))].sort();
          const red = T.near(0, [0xe0, 0x30, 0x1e], 30);
          const disk = JSON.stringify(await T.disk(0)) === JSON.stringify(T.snap(0));
          const labels = view.history.labels.slice(-1), after = T.snap(0);
          view.undo();
          const undone = JSON.stringify(T.snap(0)) === JSON.stringify(before);
          view.redo();
          return { colors, red, disk, labels, undone, redone: JSON.stringify(T.snap(0)) === JSON.stringify(after), outside: T.P(0).strokes.find(q => q.id === T.outside).color };
        }""")
        check('lasso recolour: the selected pen strokes turn red on screen and on disk; the highlighter and the stroke outside keep theirs',
              r['colors'] == ['highlighter #ffd400', 'pen #e0301e'] and r['red'] > 500 and r['disk'] and r['outside'] == '#000000', r)
        check('lasso recolour: one undo step; undo and redo', r['labels'] == ['Recolour selection'] and r['undone'] and r['redone'], r)

        # Duplicate: a copy 24 px right and down, new ids, selected; delete; both undoable.
        r = ev("""async () => {
          view.select(0, T.para);
          const before = T.snap(0), n0 = before.length;
          view.contentEl.querySelector('.nb-ink-sel-duplicate').click();
          const after = T.snap(0), sel = view.selection;
          const copies = after.slice(n0), orig = before.filter(q => T.para.includes(q.id));
          const offset = copies.length === orig.length && copies.every((c, i) => c.points.every((pt, j) => Math.abs(pt.x - orig[i].points[j].x - 24) < 1e-9 && Math.abs(pt.y - orig[i].points[j].y - 24) < 1e-9) && c.color === orig[i].color && c.size === orig[i].size);
          const ids = new Set(after.map(q => q.id));
          const dup = { n: after.length - n0, offset, uniqueIds: ids.size === after.length, selected: sel && sel.ids.join() === copies.map(q => q.id).join(), labels: view.history.labels.slice(-1),
            disk: JSON.stringify(await T.disk(0)) === JSON.stringify(after) };
          view.contentEl.querySelector('.nb-ink-sel-delete').click();
          const del = { n: T.P(0).strokes.length, sel: view.selection, labels: view.history.labels.slice(-1), same: JSON.stringify(T.snap(0)) === JSON.stringify(before) };
          view.undo();
          del.undone = JSON.stringify(T.snap(0)) === JSON.stringify(after);
          view.undo();
          dup.undone = JSON.stringify(T.snap(0)) === JSON.stringify(before);
          view.redo();
          dup.redone = JSON.stringify(T.snap(0)) === JSON.stringify(after);
          view.redo();
          del.redone = JSON.stringify(T.snap(0)) === JSON.stringify(before);
          return { dup, del };
        }""")
        check('lasso duplicate: 16 copies 24 px right and down, same style, new ids unique on the page, selected, saved',
              r['dup']['n'] == 16 and r['dup']['offset'] and r['dup']['uniqueIds'] and r['dup']['selected'] and r['dup']['disk'], r['dup'])
        check('lasso delete: the selection is removed and deselected', r['del']['n'] == 17 and r['del']['sel'] is None and r['del']['same'], r['del'])
        check('lasso duplicate and delete: one undo step each; undo and redo', r['dup']['labels'] == ['Duplicate selection'] and r['del']['labels'] == ['Delete selection']
              and r['del']['undone'] and r['dup']['undone'] and r['dup']['redone'] and r['del']['redone'], r)

        # Copy, paste (centred on the view), cut, in this note.
        r = ev("""async () => {
          view.select(0, T.para);
          const before = T.snap(0), n0 = before.length;
          clipboardWrites.length = 0;
          view.contentEl.querySelector('.nb-ink-sel-copy').click();
          const clip = view['settingsHost'].inkClipboard, sys = clipboardWrites.length ? JSON.parse(clipboardWrites[0]) : null;
          const out = { clip: clip && clip.strokes.length, sys: sys && [sys.format, sys.strokes.length], same: JSON.stringify(T.snap(0)) === JSON.stringify(before),
            cmd: commands['paste-strokes'].checkCallback(true), pasteBtn: view.contentEl.querySelector('.nb-ink-sel-paste').style.display !== 'none' };
          const sc = view.contentEl.querySelector('.nb-ink-scroll');
          sc.scrollTop = 150;
          await T.sleep(60);
          commands['paste-strokes'].callback ? commands['paste-strokes'].callback() : commands['paste-strokes'].checkCallback(false);
          const after = T.snap(0), pasted = after.slice(n0);
          const b = ink.bounds ? null : null;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const q of pasted) for (const pt of q.points) { const h = q.tool === 'pen' && q.nib === 'pressure' ? q.size * 0.65 : q.size / 2;
            x0 = Math.min(x0, pt.x - h); y0 = Math.min(y0, pt.y - h); x1 = Math.max(x1, pt.x + h); y1 = Math.max(y1, pt.y + h); }
          const r = T.pages()[0].getBoundingClientRect(), s = sc.getBoundingClientRect(), k = 816 / r.width;
          const cx = (s.left + sc.clientWidth / 2 - r.left) * k, cy = (s.top + sc.clientHeight / 2 - r.top) * k;
          out.paste = { n: pasted.length, centre: [Math.round((x0 + x1) / 2 - cx), Math.round((y0 + y1) / 2 - cy)], newIds: new Set(after.map(q => q.id)).size === after.length,
            selected: view.selection && view.selection.ids.join() === pasted.map(q => q.id).join(), labels: view.history.labels.slice(-1),
            disk: JSON.stringify(await T.disk(0)) === JSON.stringify(after) };
          view.undo();
          out.paste.undone = JSON.stringify(T.snap(0)) === JSON.stringify(before);
          view.redo();
          out.paste.redone = JSON.stringify(T.snap(0)) === JSON.stringify(after);
          view.undo();
          sc.scrollTop = 0;
          await T.sleep(60);
          // Cut: removed and on the clipboard.
          view.select(0, [T.outside]);
          view['settingsHost'].inkClipboard = null;
          view.contentEl.querySelector('.nb-ink-sel-cut').click();
          out.cut = { n: T.P(0).strokes.length, clip: view['settingsHost'].inkClipboard && view['settingsHost'].inkClipboard.strokes.map(q => q.id), labels: view.history.labels.slice(-1) };
          view.undo();
          out.cut.undone = JSON.stringify(T.snap(0)) === JSON.stringify(before);
          view.select(0, T.para);
          view.copySelection();
          return out;
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'lasso_menu.png'))
        print('lasso copy/paste:', r)
        check('lasso copy: the plugin clipboard holds the 16 strokes, the system clipboard their JSON tagged notebook-ink/strokes; the page is unchanged',
              r['clip'] == 16 and r['sys'] == ['notebook-ink/strokes', 16] and r['same'], r)
        check('lasso paste: "Paste strokes" is available; the menu offers Paste', r['cmd'] and r['pasteBtn'], r)
        check('lasso paste: 16 strokes centred on the visible area, new ids, selected, saved; one undo step; undo and redo',
              r['paste']['n'] == 16 and all(abs(v) <= 1 for v in r['paste']['centre']) and r['paste']['newIds'] and r['paste']['selected'] and r['paste']['disk']
              and r['paste']['labels'] == ['Paste'] and r['paste']['undone'] and r['paste']['redone'], r['paste'])
        check('lasso cut: removed from the page and on the clipboard; undo puts it back',
              r['cut']['n'] == 16 and r['cut']['clip'] == [ev("() => T.outside")] and r['cut']['labels'] == ['Cut selection'] and r['cut']['undone'], r['cut'])

        # Paste into a second note.
        r = ev("""async () => {
          await view.save();  // the first note stays open in its tab
          const first = view.file.path;
          await p.createInkNote('Lasso 2', '', 'letter', 'blank');
          await T.sleep(150);
          const other = view.file.path;
          commands['paste-strokes'].checkCallback(false);
          const n = T.P(0).strokes.length, disk = (await T.disk(0)).length, sel = view.selection && view.selection.ids.length;
          const labels = view.history.labels;
          view.undo();
          const undone = T.P(0).strokes.length;
          view.redo();
          await view.save();
          await app.workspace.getLeaf(false).openFile(app.vault.getFile(first));
          await T.sleep(150);
          return { other, n, disk, sel, labels, undone, back: view.file.path === first && view.selection === null && view.pen.tool };
        }""")
        check('lasso paste into another note: the 16 strokes land there, selected and saved; undo and redo', r['n'] == 16 and r['disk'] == 16 and r['sel'] == 16
              and r['labels'] == ['Paste'] and r['undone'] == 0 and r['back'] == 'lasso', r)

        # Move onto the next page: the source loses the strokes, the target gains them where they were shown.
        r = ev("""async () => {
          view.scrollToPage(0);
          await T.sleep(60);
          view.select(0, T.para);
          const before0 = T.snap(0), before1 = T.snap(1);
          const r0 = T.pages()[0].getBoundingClientRect(), r1 = T.pages()[1].getBoundingClientRect(), k = 816 / r0.width;
          const dy = (r1.top - r0.top) * k + 100;  // page 1 px: 100 px further down, on page 2
          await T.drag(0, [300, 200], [300, 200 + dy], { up: false, n: 16 });
          const mid = { onPage2: view.contentEl.querySelector('canvas.nb-ink-selection')?.parentElement === T.pages()[1], selInk: T.selInk() };
          T.penUp(0, [300, 200 + dy], 23);
          await T.sleep(30);
          const after0 = T.snap(0), after1 = T.snap(1);
          const moved = after1.slice(before1.length), orig = before0.filter(q => T.para.includes(q.id));
          const off = (r1.top - r0.top) * k;
          let err = 0;
          moved.forEach((q, i) => q.points.forEach((pt, j) => { err = Math.max(err, Math.abs(pt.x - orig[i].points[j].x), Math.abs(pt.y - (orig[i].points[j].y + dy - off))); }));
          const disk0 = await T.disk(0), disk1 = await T.disk(1);
          const out = { mid, n0: after0.length, n1: after1.length, err, ids: moved.map(q => q.id).join() === orig.map(q => q.id).join(),
            sel: view.selection && [view.selection.page, view.selection.ids.length], labels: view.history.labels.slice(-1),
            disk: JSON.stringify(disk0) === JSON.stringify(after0) && JSON.stringify(disk1) === JSON.stringify(after1) };
          view.undo();
          out.undone = JSON.stringify(T.snap(0)) === JSON.stringify(before0) && JSON.stringify(T.snap(1)) === JSON.stringify(before1);
          view.redo();
          out.redone = JSON.stringify(T.snap(0)) === JSON.stringify(after0) && JSON.stringify(T.snap(1)) === JSON.stringify(after1);
          return out;
        }""")
        ev("async () => { T.pages()[1].scrollIntoView(); await T.sleep(100); }")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'lasso_moved_page.png'))
        ev("async () => { view.scrollToPage(0); await T.sleep(100); }")
        print('lasso move to page 2:', {k: r[k] for k in ('mid', 'n0', 'n1', 'err', 'sel')})
        check('lasso move to another page: the preview follows onto page 2', r['mid']['onPage2'] and r['mid']['selInk'] > 500, r['mid'])
        check('lasso move to another page: page 1 loses the 16 strokes, page 2 gains them (ids kept, no clash) where they were shown (to 0.25 px: rounding and whole-px page boxes), selected there',
              r['n0'] == 1 and r['n1'] == 16 and r['err'] <= 0.25 and r['ids'] and r['sel'] == [1, 16], r)
        check('lasso move to another page: both pages saved as shown; one undo step; undo and redo', r['disk'] and r['labels'] == ['Move selection to another page'] and r['undone'] and r['redone'], r)

        # Deselecting: a tap outside, switching tools, Escape.
        r = ev("""async () => {
          view.undo();
          view.select(0, T.para);
          await T.pen(0, [[700, 900, 0.3]], { id: 41 });  // a tap far from the box
          const tap = view.selection;
          view.select(0, T.para);
          view.setTool('pen');
          const tool = [view.selection, T.selInk(), view.selectionMenuOpen];
          view.select(0, T.para);
          view.contentEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const esc = view.selection;
          view.select(0, T.para);
          const box = view.selection.box;
          await T.pen(0, [[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, 0.3]], { id: 42 });  // a tap inside keeps it
          return { tap, tool, esc, inside: view.selection && view.selection.ids.length, n: T.P(0).strokes.length };
        }""")
        check('lasso: a tap outside, switching tools and Escape deselect; a tap inside keeps the selection; taps draw nothing',
              r['tap'] is None and r['tool'] == [None, 0, False] and r['esc'] is None and r['inside'] == 16 and r['n'] == 17, r)

        # Dark theme: the box and menu stay visible.
        ev("() => { document.body.classList.add('theme-dark'); app.workspace.trigger('css-change'); }")
        page.wait_for_timeout(100)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'lasso_dark.png'))
        ev("() => { document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change'); }")

        # Drag frame time on a page of 300 strokes, with 100 of them selected.
        r = ev("""async () => {
          view.clearSelection();
          const pg = T.P(1);
          view.setTool('pen');
          for (let i = 0; i < 300; i++) {
            const x0 = 60 + (i % 15) * 46, y0 = 80 + Math.floor(i / 15) * 45;
            view.commit({ key: view.pages[1] }, { tool: 'pen', nib: 'uniform', color: '#000000', size: 2.5,
              points: Array.from({ length: 80 }, (_, j) => ({ x: x0 + j * 0.5, y: y0 + 10 * Math.sin(j / 5), p: 0.4, t: j * 2 })) });
          }
          view.scrollToPage(1);
          await T.sleep(100);
          view.select(1, pg.strokes.slice(0, 100).map(q => q.id));
          const box = view.selection.box, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
          await T.drag(1, [cx, cy], [cx + 60, cy + 90], { n: 60 });
          await T.sleep(20);
          return { d: view.lassoStats.lastDrag, sel: view.selection.ids.length, n: pg.strokes.length };
        }""")
        d = r['d']
        print(f"lasso drag on a 300-stroke page ({r['sel']} selected): {d['frames']} frames, median {d['frameMs']:.2f} ms, max {d['frameMaxMs']:.2f} ms")
        check('lasso drag: 100 of 300 strokes dragged at a median frame under 8 ms', r['sel'] == 100 and d['frames'] >= 30 and d['frameMs'] < 8, r)
        ev("() => { view.clearSelection(); view.setTool('pen'); }")
        # ======== end of 22. The lasso (#11) ========

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

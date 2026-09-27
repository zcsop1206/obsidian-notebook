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
# pages, the copied PDF, the embedded JPEG, sharp renders at 200%, writing on PDF pages), and images on pages (#12),
# and the pen at zoom (#52: viewport bitmaps, the live stroke against the committed one, seams, pointercancel).
# Run by `npm test`; screenshots land in test/out/.
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
      [...m.contentEl.querySelectorAll('.suggestion-item')].find(e => (e.querySelector('.nb-tpl-label') || e).textContent === label).click();
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
              r['names'][:2] == ['Default paper size', 'Default template for new notes'] and 'Templates folder' in r['names'] and len(r['options']) == 10 and r['saved'] == 'lined-college-margin', r)
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
          const labels = [...modals[0].contentEl.querySelectorAll('.suggestion-item')].map(e => (e.querySelector('.nb-tpl-label') || e).textContent);
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
        check('templates: "Change template of this page" is offered in an ink view and lists the ten built-in templates (#19, #27)',
              r['shown'] is True and r['labels'][0] == 'Blank' and 'Lined, college rule, with margin' in r['labels'] and r['labels'][8:] == ['Sticky note 3 × 3 in', 'Index card 5 × 3 in'], r['labels'])
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
            same: inp.livePath === ink.strokePath({ tool: 'pen', nib: 'uniform', size: 2.5, points }), points: points.length };
        }""")
        check('pen: mid-stroke, the live overlay has ink after the frames', r['live'] > 300 and r['frames'] >= 10, r)
        check('pen: the live outline is strokePath of the points so far (same options, same code; #52: refitted, as committed)', r['same'], r)
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

        # (5) stylus touches never scroll: prevented anywhere over the pages, except on a control (#53: touchstart and touchmove)
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
        check('pen: a stylus touchstart or touchmove on a control is not prevented (taps work, #53)', r['control'] == [False, False, False], r)

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
          // #55: the current page's two rows of 36 px buttons push page 4's thumbnail out of view here.
          const list = view.contentEl.querySelector('.nb-pages-list');
          list.scrollTop = list.scrollHeight;
          await T.sleep(100);
          await T.idle();
          list.scrollTop = 0;
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
        check('toolbar: 16 buttons (Import, #54, among them), each a 40 px target; all but the five presets have an icon',
              r['buttons'] == 16 and r['icons'] == 11 and all(w >= 40 and h >= 40 for w, h in r['size']), r)
        check('toolbar: the lasso is a tool (#11); the ruler is a toggle (#20)', r['lasso'] == [False, 'Lasso'] and r['ruler'] == [False, 'Ruler'], r)
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
              and r['menu']['items'][:3] == ['Template of this page…', 'Template of all pages…', 'Add page with template…']
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
        check('toolbar: Pencil touchstarts and touchmoves on toolbar and picker controls are not prevented (taps work, #53)',
              r['n'] > 10 and r['prevented'] == 0 and r['moves'] == [False], r)
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

        # ======== 23. Sized templates and page embeds (#27), PDF templates (#21) =
        # Section 21 loaded and unloaded other plugin instances, whose commands and view factory the
        # mock kept; reload the plugin so this section drives one instance (and its registry).
        ev("""async () => { p.unload(); window.p = await loadPlugin(); }""")
        ev("""() => {
          T.light = async () => { document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(100); };
          T.dark = async () => { document.body.classList.add('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(100); };
          /** Fills the new-note dialog (name, template value) and creates the note; waits for it to open. */
          T.newNote = async (name, template, paper) => {
            commands['new-ink-note'].callback();
            const m = modals[modals.length - 1], selects = [...m.contentEl.querySelectorAll('select')];
            const options = [...selects[1].options].map(o => o.value), papers = [...selects[0].options].map(o => o.textContent);
            if (paper) { selects[0].value = paper; selects[0].dispatchEvent(new Event('change')); }
            if (template) { selects[1].value = template; selects[1].dispatchEvent(new Event('change')); }
            m.contentEl.querySelector('input.nb-ink-name').value = name;
            m.contentEl.querySelector('button.mod-cta').click();
            await T.waitFor(() => view.file && view.file.basename === name && view.store && T.pages().length);
            await T.sleep(200);
            view.setTool('pen');  // the saved tool state may hold another tool
            view.setPen({ color: '#000000' });
            return { options, papers };
          };
          T.dirOf = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        }""")
        # A sticky note through the dialog: 288 x 288, its fill drawn, default ink dark in dark mode.
        r = ev("""async () => {
          await T.dark();
          const { options } = await T.newNote('Sticky', 'sticky-3in');
          const md = fs.get(view.file.path), note = ink.readNote(md, 'Sticky');
          const pg = ink.readPage(fs.get(view.store.slots[0].path));
          await T.pen(0, T.loops(40, 150, 300));
          await T.sleep(50);
          const fill = T.pixel(0, 5, 5), inkDark = T.near(0, [0x1f, 0x1f, 0x1f], 30), inkLight = T.near(0, [0xe6, 0xe3, 0xde], 30);
          view.addPage();
          await T.sleep(200);
          await view.save();
          const added = ink.readPage(fs.get(view.store.slots[1].path));
          const saved = ink.readPage(fs.get(view.store.slots[0].path));
          const el = T.pages()[0];
          return { options, paper: note.paper, tpl: note.template, size: pg.size, kind: pg.template.kind, color: pg.template.color,
            fill, inkDark, inkLight, ratio: el.offsetWidth / el.offsetHeight, added: [added.size, ink.templateName(added.template)],
            strokes: saved.strokes.length, file: view.file.path };
        }""")
        print('sticky:', r)
        check('sticky: the dialog offers the sticky note and index card', 'sticky-3in' in r['options'] and 'index-card' in r['options'], r['options'])
        check('sticky: the note\'s paper is 288x288 and its template sticky-3in', r['paper'] == '288x288' and r['tpl'] == 'sticky-3in', r)
        check('sticky: the first page is 288 x 288 with the pale yellow fill', r['size'] == {'width': 288, 'height': 288} and r['kind'] == 'fill' and r['color'] == '#fff59d' and abs(r['ratio'] - 1) < 0.01, r)
        check('sticky: the fill is drawn in dark mode', abs(r['fill'][0] - 0xff) <= 4 and abs(r['fill'][1] - 0xf5) <= 4 and abs(r['fill'][2] - 0x9d) <= 6, r['fill'])
        check('sticky: default ink is dark on it in dark mode', r['inkDark'] > 100 and r['inkLight'] < 10 and r['strokes'] == 1, r)
        check('sticky: an added page inherits the size and the fill', r['added'] == [{'width': 288, 'height': 288}, 'sticky-3in'], r['added'])
        sticky_file = r['file']

        # Copy embed: the page's vault path as a standard markdown embed, on the clipboard.
        r = ev("""async () => {
          await T.light();
          const clip = [], before = notices.length;
          const orig = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { clip.push(t); } } });
          view.scroller.scrollTop = 0;
          await T.sleep(50);
          const shown = commands['copy-page-embed'].checkCallback(true);
          commands['copy-page-embed'].checkCallback(false);
          await T.sleep(50);
          const path = view.store.slots[view.currentPageIndex()].path;
          const ok = notices.slice(before);
          // A clipboard that throws: the text goes in a notice instead.
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
          const text = await view.copyPageEmbed();
          delete navigator.clipboard;
          if (orig) Object.defineProperty(Navigator.prototype, 'clipboard', orig);
          const img = await T.imageInk(path);
          return { shown, clip, path, ok, fallback: notices.slice(before + ok.length), text, img };
        }""")
        print('copy embed:', r)
        check('copy embed: offered in an ink view; writes ![](<page path>) to the clipboard with a notice',
              r['shown'] is True and r['clip'] == [f"![]({r['path']})"] and any('Copied' in n for n in r['ok']), r)
        check('copy embed: if the clipboard fails, a notice shows the embed', r['text'] == r['clip'][0] and any(r['text'] in n for n in r['fallback']), r)
        check('copy embed: the page file renders at its own size as an image', r['img']['w'] == 288 and r['img']['h'] == 288 and r['img']['n'] > 100, r['img'])

        # A Letter note with a sticky page added through the chooser saves and reopens.
        r = ev("""async () => {
          await T.newNote('Mixed', 'blank', 'letter');
          view.chooseTemplate('add');
          const labels = [...modals[modals.length - 1].contentEl.querySelectorAll('.suggestion-item')].map(e => (e.querySelector('.nb-tpl-label') || e).textContent);
          await T.choose('Sticky note 3 × 3 in');
          await T.pen(1, T.loops(40, 150, 200));
          await view.save();
          const path = view.file.path;
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Physics.md'));
          await T.sleep(100);
          await app.workspace.getLeaf(false).setViewState({ type: 'notebook-ink', state: { file: path }, active: true });
          await T.waitFor(() => view.store && view.file.path === path && T.pages().length === 2);
          await T.sleep(200);
          const pages = view.store.slots.map(s => { const pg = view.store.page(s); return [pg.size, ink.templateName(pg.template), pg.strokes.length]; });
          const note = ink.readNote(fs.get(path), 'Mixed');
          return { labels, pages, paper: note.paper, ratios: T.pages().map(e => Math.round(e.offsetWidth / e.offsetHeight * 100) / 100),
            widths: T.pages().map(e => e.offsetWidth) };
        }""")
        print('mixed:', r)
        check('mixed: the add chooser lists the sized templates and "Custom size…"', 'Sticky note 3 × 3 in' in r['labels'] and r['labels'][-1] == 'Custom size…', r['labels'])
        check('mixed: a Letter page and a sticky page save and reopen with their sizes, templates and ink',
              r['paper'] == 'letter' and r['pages'] == [[{'width': 816, 'height': 1056}, 'blank', 0], [{'width': 288, 'height': 288}, 'sticky-3in', 1]], r)
        check('mixed: each page element has its own shape', r['ratios'] == [round(816 / 1056, 2), 1.0], r)

        # Custom size: from the chooser (100 x 50 mm), rejected out of range, and from the new-note dialog.
        r = ev("""async () => {
          view.chooseTemplate('add');
          await T.choose('Custom size…');
          const m = modals[modals.length - 1], title = m.titleEl.textContent;
          const set = (cls, v) => { const i = m.contentEl.querySelector(cls); i.value = v; i.dispatchEvent(new Event('input')); };
          set('.nb-size-width', '0.5');
          m.contentEl.querySelector('button.mod-cta').click();
          const error = m.contentEl.querySelector('.nb-size-error').textContent, stillOpen = modals.includes(m);
          set('.nb-size-width', '100'); set('.nb-size-height', '50');
          const unit = m.contentEl.querySelector('select'); unit.value = 'mm'; unit.dispatchEvent(new Event('change'));
          m.contentEl.querySelector('button.mod-cta').click();
          await T.sleep(150);
          const last = view.store.page(view.store.slots[view.store.slots.length - 1]);
          // The new-note dialog: Paper → Custom size… (3 x 2 in).
          commands['new-ink-note'].callback();
          const nm = modals[modals.length - 1], paperSel = nm.contentEl.querySelectorAll('select')[0];
          paperSel.value = 'custom'; paperSel.dispatchEvent(new Event('change'));
          const sm = modals[modals.length - 1];
          const sset = (cls, v) => { const i = sm.contentEl.querySelector(cls); i.value = v; i.dispatchEvent(new Event('input')); };
          sset('.nb-size-width', '3'); sset('.nb-size-height', '2');
          sm.contentEl.querySelector('button.mod-cta').click();
          const paperValue = paperSel.value, paperLabel = paperSel.selectedOptions[0].textContent;
          nm.contentEl.querySelectorAll('select')[1].value = 'grid-5mm';
          nm.contentEl.querySelectorAll('select')[1].dispatchEvent(new Event('change'));
          nm.contentEl.querySelector('input.nb-ink-name').value = 'Card';
          nm.contentEl.querySelector('button.mod-cta').click();
          await T.waitFor(() => view.file && view.file.basename === 'Card' && view.store && T.pages().length);
          await T.sleep(100);
          const note = ink.readNote(fs.get(view.file.path), 'Card'), pg = view.store.page(view.store.slots[0]);
          view.addPage();
          const added = view.store.page(view.store.slots[1]);
          return { title, error, stillOpen, size: last.size, kind: last.template.kind, paperValue, paperLabel, paper: note.paper,
            first: [pg.size, ink.templateName(pg.template)], added: added.size };
        }""")
        print('custom size:', r)
        check('custom size: the chooser asks for a size; under 1 in is refused with a message', r['title'] == 'Custom page size' and r['stillOpen'] and 'from 1 to 20 in' in r['error'], r)
        check('custom size: 100 x 50 mm gives a blank 378 x 189 px page', r['size'] == {'width': 378, 'height': 189} and r['kind'] == 'blank', r)
        check('custom size: the new-note dialog\'s paper takes a custom size; the note\'s paper and pages have it',
              r['paperValue'] == '288x192' and r['paperLabel'] == '3 × 2 in' and r['paper'] == '288x192'
              and r['first'] == [{'width': 288, 'height': 192}, 'grid-5mm'] and r['added'] == {'width': 288, 'height': 192}, r)

        # Add PDF template: page 2 of a vault PDF, saved in the templates folder.
        r = ev("""async () => {
          fs.set('Slides/engineering.pdf', new Uint8Array(fakePdf([[612, 792], [595.28, 841.89]])));
          const before = notices.length;
          commands['add-pdf-template'].callback();
          const m = modals[modals.length - 1], placeholder = m.placeholder;
          [...m.contentEl.querySelectorAll('.suggestion-item')].find(e => e.textContent === 'Slides/engineering.pdf').click();
          await T.waitFor(() => modals.length && modals[modals.length - 1].titleEl.textContent === 'Add PDF template');
          const tm = modals[modals.length - 1];
          const pageInput = tm.contentEl.querySelector('input.nb-tpl-page');
          pageInput.value = '2'; pageInput.dispatchEvent(new Event('input'));
          const name = tm.contentEl.querySelector('input.nb-ink-name').value;
          tm.contentEl.querySelector('button.mod-cta').click();
          await T.waitFor(() => fs.has('templates/ink/engineering.svg') && p.templates.entries.length);
          const svg = fs.get('templates/ink/engineering.svg'), pg = ink.readPage(svg);
          const pdf = fs.get('templates/ink/engineering.pdf'), src = fs.get('Slides/engineering.pdf');
          return { placeholder, name, size: pg.size, strokes: pg.strokes.length, tpl: [pg.template.kind, pg.template.source, pg.template.page],
            jpeg: pg.template.image.startsWith('data:image/jpeg;base64,') && pg.template.image.length > 1000,
            same: pdf.length === src.length && pdf.every((b, i) => b === src[i]), entries: p.templates.entries.map(e => e.name),
            notices: notices.slice(before), img: await T.imageInk('templates/ink/engineering.svg') };
        }""")
        print('pdf template:', {k: r[k] for k in ('placeholder', 'name', 'size', 'tpl', 'entries', 'notices')})
        check('pdf template: the name defaults to the PDF\'s; files written in the templates folder',
              r['name'] == 'engineering' and r['same'] and r['strokes'] == 0, r)
        check('pdf template: an ink page with the PDF page (source, page 2, JPEG) at its size',
              r['tpl'] == ['pdf', 'engineering.pdf', 2] and r['jpeg'] and r['size'] == {'width': 793.7, 'height': 1122.5}, r)
        check('pdf template: the registry lists it as tpl:engineering, with a notice', r['entries'] == ['tpl:engineering'] and any('engineering' in n for n in r['notices']), r)
        check('pdf template: its page file renders the PDF page as an image at its size', r['img']['n'] > 2000 and r['img']['w'] == 794, r['img'])

        # A note started with it: every page gets the PDF page at its size, the PDF copied into the
        # page folder, and a sharp render at 200%.
        r = ev("""async () => {
          const { options } = await T.newNote('Engineering log', 'tpl:engineering');
          const path = view.file.path, dir = T.dirOf(path), note = ink.readNote(fs.get(path), 'Engineering log');
          view.addPage();
          view.insertPageAfter(0);
          await view.save();
          await T.sleep(100);
          const pages = view.store.slots.map(s => { const pg = ink.readPage(fs.get(s.path)); return [pg.size, pg.template.kind, pg.template.source, pg.template.page, (pg.template.image || '').length > 1000, ink.templateName(pg.template)]; });
          const pdf = fs.get(`${dir}Engineering log/engineering.pdf`), src = fs.get('templates/ink/engineering.pdf');
          const imgs = [];
          for (const s of view.store.slots) imgs.push((await T.imageInk(s.path)).n);
          view.scroller.scrollTop = 0;
          const n = pdfjsStats.renders.length;
          view.setZoom(2);
          const c = () => T.pages()[0].querySelector('canvas.nb-ink-bitmap');
          // The bitmap's width, or for a band bitmap (#52: past 16M pixels) the whole page's at up to 16M pixels.
          const want = () => { const e = T.pages()[0], k = Math.min(devicePixelRatio, Math.sqrt(16e6 / (e.offsetWidth * e.offsetHeight)));
            return c().classList.contains('nb-ink-band') ? Math.round(e.offsetWidth * k) : c().width; };
          const sharp = await T.waitFor(() => c() && pdfjsStats.renders.slice(n).some(([pg, w]) => pg === 2 && w === want()), 4000);
          view.resetZoom();
          return { options, paper: note.paper, tpl: note.template, pages, copied: !!pdf && pdf.length === src.length, sharp, imgs,
            md: fs.get(path).slice(0, 80) };
        }""")
        print('pdf template note:', r)
        check('pdf template note: the dialog offers tpl:engineering after the built-ins', r['options'][-1] == 'tpl:engineering', r['options'])
        check('pdf template note: the note\'s template is tpl:engineering and its paper the PDF page\'s size',
              r['tpl'] == 'tpl:engineering' and r['paper'] == '793.7x1122.5', r)
        check('pdf template note: every page (first, added, inserted) has the PDF page as its background',
              len(r['pages']) == 3 and all(pg == [{'width': 793.7, 'height': 1122.5}, 'pdf', 'engineering.pdf', 2, True, 'pdf'] for pg in r['pages']), r['pages'])
        check('pdf template note: the PDF is copied into the page folder', r['copied'], r)
        check('pdf template note: each page file renders its background (GitHub, reading view)', all(n > 2000 for n in r['imgs']), r['imgs'])
        check('pdf template note: a sharp render of the PDF page at 200%', r['sharp'], r)

        # Changing a Letter page to the PDF template takes the PDF page's size; undo restores both.
        r = ev("""async () => {
          await T.newNote('Resize', 'blank', 'letter');
          const size = () => ({ ...view.store.slots[0].size }), kind = () => view.store.page(view.store.slots[0]).template.kind;
          const ratio = () => Math.round(T.pages()[0].offsetWidth / T.pages()[0].offsetHeight * 1000) / 1000;
          commands['change-page-template'].checkCallback(false);
          await T.choose('engineering (PDF)');
          await T.sleep(100);
          const after = [size(), kind(), ratio()];
          view.undo();
          await T.sleep(100);
          const undone = [size(), kind(), ratio()];
          view.chooseTemplate('all');
          await T.choose('Sticky note 3 × 3 in');
          const all = [size(), kind()];
          view.undo();
          await view.save();
          return { after, undone, all, disk: ink.readPage(fs.get(view.store.slots[0].path)).size };
        }""")
        print('resize:', r)
        check('resize: a Letter page changed to the PDF template gets the PDF page\'s size, and undo restores 816 x 1056 and blank',
              r['after'][:2] == [{'width': 793.7, 'height': 1122.5}, 'pdf'] and abs(r['after'][2] - 793.7 / 1122.5) < 0.01
              and r['undone'][:2] == [{'width': 816, 'height': 1056}, 'blank'] and abs(r['undone'][2] - 816 / 1056) < 0.01, r)
        check('resize: "all pages" to the sticky note resizes too; undo restores the size on disk',
              r['all'] == [{'width': 288, 'height': 288}, 'fill'] and r['disk'] == {'width': 816, 'height': 1056}, r)

        # The chooser lists PDF templates after the built-ins; "Custom size…" only when adding.
        r = ev("""async () => {
          await app.workspace.getLeaf(false).setViewState({ type: 'notebook-ink', state: { file: '""" + sticky_file + """' }, active: true });
          await T.waitFor(() => view.store && view.file.path === '""" + sticky_file + """' && T.pages().length);
          commands['change-page-template'].checkCallback(false);
          const labels = [...modals[modals.length - 1].contentEl.querySelectorAll('.suggestion-item')].map(e => (e.querySelector('.nb-tpl-label') || e).textContent);
          await T.choose('engineering (PDF)');
          await T.sleep(200);
          await view.save();
          const pg = ink.readPage(fs.get(view.store.slots[0].path)), dir = T.dirOf(view.file.path);
          return { labels, tpl: [pg.template.kind, pg.template.page], strokes: pg.strokes.length, copied: fs.has(`${dir}Sticky/engineering.pdf`) };
        }""")
        print('chooser:', r)
        check('chooser: PDF templates are listed after the built-ins; no "Custom size…" when changing a page',
              len(r['labels']) == 11 and r['labels'][8] == 'Sticky note 3 × 3 in' and r['labels'][10:] == ['engineering (PDF)'], r['labels'])
        check('chooser: a page changed to the PDF template keeps its ink and gets the PDF copied beside it',
              r['tpl'] == ['pdf', 2] and r['strokes'] == 1 and r['copied'], r)
        # ======== end of 23. Sized templates and page embeds (#27), PDF templates (#21) ========

        # ======== 24. The virtual page (#28) ========
        # A blank page always follows the last page: an element (.nb-ink-ghost), not in the store,
        # the index, the panel or the stats; the pen or highlighter going down on it makes it a
        # real page first. Empty pages made that way are dropped when the note closes.
        r = ev("""async () => {
          view.togglePagesPanel(false);
          view.setTool('pen');
          await p.createInkNote('Ghost', '', 'letter', 'lined-college');
          await T.sleep(150);
          const g = view.ghostEl, last = T.pages()[0];
          T.ghostDown = (x, y, id = 51) => {
            const el = view.ghostEl, r = el.getBoundingClientRect(), k = r.width / 816;
            el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: id, pointerType: 'pen', pressure: 0.3,
              clientX: r.left + x * k, clientY: r.top + y * k, bubbles: true, cancelable: true, button: 0, buttons: 1 }));
            return { r, k };
          };
          /** A stroke starting on the virtual page; moves and pointerup go to the page element it became. */
          T.ghostStroke = async (pts, id = 52) => {
            const n = view.store.slots.length, { r, k } = T.ghostDown(pts[0][0], pts[0][1], id);
            const el = T.pages()[n] || view.ghostEl;
            const fire = (t, [x, y]) => el.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'pen', pressure: 0.4,
              clientX: r.left + x * k, clientY: r.top + y * k, bubbles: true, cancelable: true, button: 0, buttons: t === 'pointerup' ? 0 : 1 }));
            for (let j = 1; j < pts.length; j++) { fire('pointermove', pts[j]); await T.sleep(2); }
            fire('pointerup', pts[pts.length - 1]);
            await T.sleep(20);
          };
          T.svgs = () => [...fs.keys()].filter(k => k.startsWith('Ghost/')).sort();
          const gc = g && g.querySelector('canvas');
          let lines = 0;
          if (gc) {
            const d = gc.getContext('2d').getImageData(0, 0, gc.width, gc.height).data;
            for (let k = 0; k < d.length; k += 4) if (d[k] < 235) lines++;
          }
          view.togglePagesPanel(true);
          await T.sleep(100);
          const thumbs = view.contentEl.querySelectorAll('.nb-pages-thumb').length;
          view.togglePagesPanel(false);
          await T.sleep(50);
          return { ghost: !!g, isPage: g && g.classList.contains('nb-ink-page'), slots: view.store.slots.length, els: T.pages().length,
            top: g && g.offsetTop, want: last.offsetTop + last.offsetHeight + 24, w: g && g.offsetWidth, h: g && g.offsetHeight, lw: last.offsetWidth, lh: last.offsetHeight,
            lines, thumbs, loaded: view.stats.pagesLoaded, svgs: T.svgs().length, index: ink.readNote(fs.get('Ghost.md'), 'Ghost').pages.length,
            footer: view.contentEl.querySelector('.nb-ink-footer').offsetTop > g.offsetTop + g.offsetHeight };
        }""")
        print('virtual page: new note:', r)
        check('virtual page: a new note shows its page plus one virtual page right below it, the same size', r['ghost'] and not r['isPage'] and r['els'] == 1
              and r['top'] == r['want'] and r['w'] == r['lw'] and r['h'] == r['lh'], r)
        check('virtual page: drawn with the note\'s default template (lined)', r['lines'] > 1000, r['lines'])
        check('virtual page: not in the store, the index, the panel, the stats or on disk', r['slots'] == 1 and r['index'] == 1 and r['thumbs'] == 1
              and r['loaded'] == 1 and r['svgs'] == 1, r)
        check('virtual page: the "Add page" controls are below it', r['footer'], r)

        r = ev("""async () => {
          const out = {};
          for (const tool of ['eraser', 'lasso']) {
            view.setTool(tool);
            await T.ghostStroke(T.wave(100, 200, 20));
            out[tool] = [view.store.slots.length, view.history.labels.length, T.pages().length];
          }
          view.setTool('pen');
          return out;
        }""")
        check('virtual page: the eraser and lasso do nothing on it', r['eraser'] == [1, 0, 1] and r['lasso'][0] == 1 and r['lasso'][2] == 1, r)

        r = ev("""async () => {
          T.mark();
          const top = view.ghostEl.offsetTop, scroll = view.contentEl.querySelector('.nb-ink-scroll').scrollTop;
          await T.ghostStroke(T.wave(100, 200));
          const el = T.pages()[1], g = view.ghostEl;
          const res = { slots: view.store.slots.length, strokes: view.store.slots[1].page.strokes.length, top: el.offsetTop, was: top,
            scrollKept: view.contentEl.querySelector('.nb-ink-scroll').scrollTop === scroll, ink: T.ink(1), tpl: T.templates()[1],
            ghostTop: g.offsetTop, want: el.offsetTop + el.offsetHeight + 24, labels: view.history.labels.slice(-2),
            thumbs: view.store.slots.length };
          await T.sleep(2400);
          res.index = ink.readNote(fs.get('Ghost.md'), 'Ghost').pages;
          res.ids = view.store.slots.map(s => s.id);
          res.disk = T.strokesOnDisk(`Ghost/${res.ids[1]}.svg`);
          return res;
        }""")
        print('virtual page: stroke on it:', {k: r[k] for k in ('slots', 'strokes', 'top', 'was', 'ghostTop', 'want', 'ink', 'tpl')})
        check('virtual page: a stroke on it makes a real page where it was (no jump), with the stroke on it',
              r['slots'] == 2 and r['strokes'] == 1 and r['top'] == r['was'] and r['scrollKept'] and r['ink'] > 200, r)
        check('virtual page: the new page has the note\'s default template', r['tpl'] == 'lined-college', r['tpl'])
        check('virtual page: the next virtual page appears below it', r['ghostTop'] == r['want'], r)
        check('virtual page: "Add page" then "Add stroke" in the history', r['labels'] == ['Add page', 'Add stroke'], r['labels'])
        check('virtual page: autosave writes the page and the index', r['index'] == r['ids'] and r['disk'] == 1, r)

        r = ev("""async () => {
          const sc = view.contentEl.querySelector('.nb-ink-scroll');
          sc.scrollTop = view.ghostEl.offsetTop - 200;
          await T.sleep(50);
          await T.ghostStroke(T.wave(100, 300), 53);
          sc.scrollTop = view.ghostEl.offsetTop - 200;
          await T.sleep(50);
          await T.ghostStroke(T.wave(100, 300), 54);
          const n = view.store.slots.length, strokes = view.store.slots.map(s => s.page ? s.page.strokes.length : -1);
          // Undo: the stroke, then the page it made.
          view.undo();
          const afterStroke = [view.store.slots.length, view.store.slots[3].page.strokes.length];
          view.undo();
          const afterPage = view.store.slots.length;
          view.redo(); view.redo();
          return { n, strokes, afterStroke, afterPage, again: [view.store.slots.length, view.store.slots[3].page.strokes.length] };
        }""")
        check('virtual page: writing on two virtual pages in a row makes two pages, no taps', r['n'] == 4 and r['strokes'] == [0, 1, 1, 1], r)
        check('virtual page: undo takes out the stroke, then the page ("Add page"); redo brings both back',
              r['afterStroke'] == [4, 0] and r['afterPage'] == 3 and r['again'] == [4, 1], r)

        r = ev("""async () => {
          const sc = view.contentEl.querySelector('.nb-ink-scroll');
          // A pen-down whose stroke is cancelled before any ink is committed.
          sc.scrollTop = view.ghostEl.offsetTop - 200;
          await T.sleep(50);
          T.ghostDown(100, 100, 55);
          view['input'].cancel();
          T.penUp(4, [100, 100], 55);
          await T.sleep(20);
          const cancelled = [view.store.slots.length, view.store.slots[4].page.strokes.length];
          // A stroke that is undone (the page stays until the note closes).
          sc.scrollTop = view.ghostEl.offsetTop - 200;
          await T.sleep(50);
          await T.ghostStroke(T.wave(100, 300), 56);
          view.undo();
          const undone = [view.store.slots.length, view.store.slots[5].page.strokes.length];
          await T.sleep(2400);  // autosave writes the two empty pages
          const ids = view.store.slots.map(s => s.id);
          const writtenEmpty = [fs.has(`Ghost/${ids[4]}.svg`), fs.has(`Ghost/${ids[5]}.svg`)];
          await app.workspace.activeLeaf.detach();
          await T.sleep(100);
          const index = ink.readNote(fs.get('Ghost.md'), 'Ghost').pages;
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Ghost.md'));
          await T.sleep(150);
          return { cancelled, undone, writtenEmpty, index, kept: ids.slice(0, 4), svgs: T.svgs(), reopened: view.store.slots.map(s => s.id),
            els: T.pages().length, ghost: !!view.ghostEl, loaded: view.stats.pagesLoaded };
        }""")
        print('virtual page: empty pages on close:', r)
        check('virtual page: a pen-down with no ink, and an undone stroke, leave empty pages while open', r['cancelled'] == [5, 0] and r['undone'] == [6, 0], r)
        check('virtual page: closing drops them: out of the index, their files deleted', r['writtenEmpty'] == [True, True] and r['index'] == r['kept']
              and r['svgs'] == sorted(f'Ghost/{i}.svg' for i in r['kept']), r)
        check('virtual page: reopening shows exactly the written pages plus one virtual page', r['reopened'] == r['kept'] and r['els'] == 4 and r['ghost'] and r['loaded'] == 4, r)

        r = ev("""async () => {
          view.chooseTemplate('add');
          await T.choose('Grid, 5 mm');
          const res = { slots: view.store.slots.length, tpl: T.templates()[4], ghostBelow: view.ghostEl.offsetTop > T.pages()[4].offsetTop + T.pages()[4].offsetHeight };
          await app.workspace.activeLeaf.detach();
          await T.sleep(100);
          res.index = ink.readNote(fs.get('Ghost.md'), 'Ghost').pages.length;
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Ghost.md'));
          await T.sleep(150);
          res.reopened = view.store.slots.length;
          return res;
        }""")
        check('virtual page: "Add page with template" still adds a page with that template, above the virtual page', r['slots'] == 5 and r['tpl'] == 'grid-5mm' and r['ghostBelow'], r)
        check('virtual page: a page added with "Add page" is kept though empty', r['index'] == 5 and r['reopened'] == 5, r)

        r = ev("""async () => {
          const out = {};
          for (const z of [2, 0.5]) {
            view.setZoom(z);
            await T.sleep(100);
            const last = T.pages()[4], g = view.ghostEl;
            out[z] = { top: g.offsetTop, want: last.offsetTop + last.offsetHeight + 24, w: g.offsetWidth, lw: last.offsetWidth, left: g.offsetLeft, ll: last.offsetLeft };
          }
          view.resetZoom();
          await T.sleep(100);
          return out;
        }""")
        check('virtual page: zoom keeps it placed below the last page at the same size',
              all(v['top'] == v['want'] and v['w'] == v['lw'] and v['left'] == v['ll'] for v in r.values()), r)

        ev("async () => { const sc = view.contentEl.querySelector('.nb-ink-scroll'); sc.scrollTop = view.ghostEl.offsetTop - 300; await T.sleep(150); }")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'virtual_page_light.png'))
        ev("async () => { document.body.classList.add('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(150); }")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'virtual_page_dark.png'))
        r = ev("""() => {
          const c = view.ghostEl.querySelector('canvas'), d = c.getContext('2d').getImageData(2, 2, 1, 1).data;
          return [...d.slice(0, 3)];
        }""")
        check('virtual page: dark paper in the dark theme', r == [0x1e, 0x1e, 0x1e], r)
        ev("() => { document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change'); }")
        r = ev("""async () => {
          await p.createInkNote('Ghost sticky', '', 'letter', 'sticky-3in');
          await T.sleep(150);
          const g = view.ghostEl, last = T.pages()[0];
          await T.ghostStroke(T.wave(20, 100, 20), 57);
          const pg = view.store.page(view.store.slots[1]);
          return { w: g.offsetWidth, h: g.offsetHeight, lw: last.offsetWidth, lh: last.offsetHeight, size: pg.size, tpl: ink.templateName(pg.template) };
        }""")
        check('virtual page: a sized default template (sticky note) gives it that size, and the page it becomes too',
              r['w'] == r['lw'] and r['h'] == r['lh'] and r['size'] == {'width': 288, 'height': 288} and r['tpl'] == 'sticky-3in', r)
        # ======== end of 24. The virtual page (#28) ========

        # ======== 25. Images on pages (#12) ========
        # Insert a synthetic photo (a file, as the picker gives it) onto a note's page, paste one,
        # write on it, select it with a lasso tap, move and resize it with its ink, delete it
        # (keeping or deleting the ink, and cancelling), undo and redo each step, insert one as a
        # whole page, time a 12-megapixel photo, and read everything back after reopening.
        r = ev("""async () => {
          await p.createInkNote('Photos', '', 'letter', 'blank');
          await T.sleep(150);
          T.P = i => view.store.slots[i].page;
          T.path = i => view.store.slots[i].path;
          /** A synthetic photo: quadrants red, green, blue, yellow; as a File of `type`. */
          T.photo = async (w, h, type = 'image/jpeg', alpha = false) => {
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d');
            if (!alpha) { g.fillStyle = '#d02020'; g.fillRect(0, 0, w / 2, h / 2); g.fillStyle = '#20a040'; g.fillRect(w / 2, 0, w / 2, h / 2);
              g.fillStyle = '#2040d0'; g.fillRect(0, h / 2, w / 2, h / 2); g.fillStyle = '#e0c020'; g.fillRect(w / 2, h / 2, w / 2, h / 2); }
            else { g.fillStyle = 'rgba(200, 0, 0, 0.5)'; g.fillRect(0, 0, w / 2, h); }
            const blob = await new Promise(res => c.toBlob(res, type, 0.92));
            return new File([blob], 'photo', { type });
          };
          T.disk = async i => { await view.save(); return fs.get(T.path(i)); };
          view.setTool('pen');
          const file = await T.photo(1600, 1200);
          const ok = await view.insertImageFile(file);
          await T.sleep(150);  // the image decodes, the page is redrawn
          const pg = T.P(0), im = pg.images && pg.images[0];
          const svg = await T.disk(0);
          const meta = /<metadata><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/.exec(svg)[1];
          const cx = im.x + im.width / 2, cy = im.y + im.height / 2;
          return { ok, n: pg.images.length, id: im.id, box: [im.x, im.y, im.width, im.height], jpeg: im.data.startsWith('data:image/jpeg;base64,'),
            stats: view.imageStats, sel: view.selection, tool: view.pen.tool, menu: view.selectionMenuOpen,
            once: svg.split(im.data).length - 1, metaBytes: meta.includes('data:'), metaImage: JSON.parse(meta).images,
            red: T.pixel(0, im.x + im.width / 4, im.y + im.height / 4), yellow: T.pixel(0, cx + im.width / 4, cy + im.height / 4),
            paper: T.pixel(0, 50, 50), cmd: [commands['insert-image'].checkCallback(true), commands['insert-image-page'].checkCallback(true)] };
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'images_inserted.png'))
        near = lambda a, b, tol=40: all(abs(x - y) <= tol for x, y in zip(a, b))
        print(f"image insert (1600 x 1200): {r['stats']}")
        check('images: an inserted photo lands on the page at its own resolution, fitted to half the page width, centred in view',
              r['ok'] and r['n'] == 1 and r['jpeg'] and r['stats']['width'] == 1600 and r['stats']['height'] == 1200 and r['box'][2] == 408 and r['box'][3] == 306
              and abs(r['box'][0] - 204) < 1, r)
        check('images: the inserted image is selected with the lasso, its menu open', r['sel'] and r['sel']['images'] == [r['id']] and r['sel']['ids'] == [] and r['tool'] == 'lasso' and r['menu'], r['sel'])
        check('images: the bytes are saved once, in the SVG, not in the metadata (which holds the box)',
              r['once'] == 1 and not r['metaBytes'] and r['metaImage'] == [{'id': r['id'], 'x': r['box'][0], 'y': r['box'][1], 'width': 408, 'height': 306}], r)
        check('images: the photo is drawn on the page bitmap', near(r['red'], (0xd0, 0x20, 0x20)) and near(r['yellow'], (0xe0, 0xc0, 0x20)) and near(r['paper'], (255, 255, 255), 4), r)
        check('images: "Insert image" and "Insert image as a whole page" commands are available', r['cmd'] == [True, True], r['cmd'])

        # Big, transparent and broken files; undo and redo of an insert.
        r = ev("""async () => {
          const big = await T.photo(6000, 1500);
          await view.insertImageFile(big);
          const bigStats = view.imageStats, bigBox = T.P(0).images[1];
          view.undo();
          const afterUndo = T.P(0).images.length;
          view.redo();
          const afterRedo = T.P(0).images.length;
          view.undo();
          await view.insertImageFile(await T.photo(300, 200, 'image/png', true));
          const png = T.P(0).images[1].data.startsWith('data:image/png;base64,');
          view.undo();
          const n0 = notices.length;
          const bad = await view.insertImageFile(new File(['not an image'], 'x.jpg', { type: 'image/jpeg' }));
          return { bigStats, bigBox: [bigBox.width, bigBox.height], afterUndo, afterRedo, png, bad, notice: notices.slice(n0), n: T.P(0).images.length };
        }""")
        check('images: a 6000 px photo is stored at 4096 px on its long edge', r['bigStats']['width'] == 4096 and r['bigStats']['height'] == 1024 and r['bigBox'] == [408, 102], r)
        check('images: an insert is one undo step (undo removes it, redo puts it back)', r['afterUndo'] == 1 and r['afterRedo'] == 2, r)
        check('images: a transparent image is stored as PNG', r['png'], r)
        check("images: a file that isn't an image inserts nothing, with a notice", r['bad'] is False and r['n'] == 1 and any("Couldn't insert the image" in n for n in r['notice']), r)

        # Paste: an image file on the clipboard, pasted into the view.
        r = ev("""async () => {
          const dt = new DataTransfer();
          dt.items.add(await T.photo(400, 400));
          const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          view.contentEl.querySelector('.nb-ink-page').dispatchEvent(e);
          for (let i = 0; i < 50 && T.P(0).images.length < 2; i++) await T.sleep(20);
          const out = { n: T.P(0).images.length, prevented: e.defaultPrevented, sel: view.selection.images, box: [T.P(0).images[1].width, T.P(0).images[1].height] };
          const txt = new DataTransfer();
          txt.setData('text/plain', 'hello');
          view.contentEl.querySelector('.nb-ink-page').dispatchEvent(new ClipboardEvent('paste', { clipboardData: txt, bubbles: true, cancelable: true }));
          await T.sleep(100);
          out.afterText = T.P(0).images.length;
          view.undo();
          out.afterUndo = T.P(0).images.length;
          return out;
        }""")
        check('images: pasting an image inserts it, selected; pasting text inserts nothing', r['n'] == 2 and r['prevented'] and len(r['sel']) == 1 and r['box'] == [408, 408] and r['afterText'] == 2 and r['afterUndo'] == 1, r)

        # Write on the photo: a stroke starting on it belongs to it; one starting beside it doesn't.
        r = ev("""async () => {
          view.clearSelection();
          view.setTool('pen');
          const im = T.P(0).images[0];
          T.im = () => T.P(0).images[0];
          await T.pen(0, Array.from({ length: 30 }, (_, j) => [im.x + 40 + j * 6, im.y + 150 + 10 * Math.sin(j / 3), 0.4]), { predict: 0 });
          await T.pen(0, Array.from({ length: 30 }, (_, j) => [im.x + 60 + j * 4, im.y + 60, 0.4]), { predict: 0, id: 12 });
          await T.pen(0, Array.from({ length: 30 }, (_, j) => [100 + j * 4, 900, 0.4]), { predict: 0, id: 13 });
          const s = T.P(0).strokes;
          T.onIds = s.filter(q => q.on === im.id).map(q => q.id);
          const disk = ink.readPage(await T.disk(0));
          return { on: s.map(q => q.on || null), id: im.id, diskOn: disk.strokes.map(q => q.on || null), ink: T.pixel(0, im.x + 40 + 60, im.y + 150 + 10 * Math.sin(10 / 3)) };
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'images_annotated.png'))
        check('images: ink written on the photo belongs to it (on), ink beside it not; saved so',
              r['on'] == [r['id'], r['id'], None] and r['diskOn'] == r['on'], r)
        check('images: the ink is drawn over the photo', r['ink'][0] < 80 and r['ink'][1] < 80 and r['ink'][2] < 80, r['ink'])

        # A lasso tap on the photo selects it (no loop); a tap off it selects nothing.
        r = ev("""async () => {
          view.setTool('lasso');
          const im = T.im();
          await T.pen(0, [[im.x + 20, im.y + im.height - 20, 0.3]], { id: 41, predict: 0 });
          await T.sleep(20);
          const sel = view.selection;
          await T.pen(0, [[700, 1000, 0.3]], { id: 42, predict: 0 });
          const off = view.selection;
          await T.pen(0, [[im.x + 20, im.y + im.height - 20, 0.3], [im.x + 21, im.y + im.height - 19, 0.3]], { id: 43, predict: 0 });
          return { sel, off, again: view.selection && view.selection.images, id: im.id, box: T.imBox = [im.x, im.y, im.x + im.width, im.y + im.height] };
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'images_selected.png'))
        check('images: a lasso tap on the photo selects it (and its ink goes in the box); a tap elsewhere deselects',
              r['sel'] and r['sel']['images'] == [r['id']] and r['sel']['ids'] == [] and r['off'] is None and r['again'] == [r['id']], r)

        # A lasso loop around the photo's centre selects it with the strokes inside.
        r = ev("""async () => {
          view.clearSelection();
          const [x0, y0, x1, y1] = T.imBox;
          await T.pen(0, T.loop([x0 - 10, y0 - 10, x1 + 10, y1 + 10]), { id: 44, predict: 0 });
          const loop = view.selection;
          view.clearSelection();
          await T.pen(0, T.loop([x0 + 5, y0 + 5, x0 + 40, y0 + 40]), { id: 45, predict: 0 });  // not around its centre
          return { loop, small: view.selection };
        }""")
        check('images: a lasso loop around the photo selects it and the ink inside; a loop not around its centre does not',
              r['loop'] and len(r['loop']['images']) == 1 and len(r['loop']['ids']) == 2 and (r['small'] is None or r['small']['images'] == []), r)

        # Move and resize carry the ink written on it, even when only the photo is selected.
        r = ev("""async () => {
          view.clearSelection();
          const im0 = { ...T.im() }, ink0 = T.P(0).strokes.filter(s => T.onIds.includes(s.id)).map(s => s.points[0]);
          view.select(0, [], [im0.id]);
          const cx = im0.x + im0.width / 2, cy = im0.y + im0.height / 2;
          await T.drag(0, [cx, cy], [cx + 50, cy + 60], { n: 20 });
          await T.sleep(20);
          const im1 = { ...T.im() }, ink1 = T.P(0).strokes.filter(s => T.onIds.includes(s.id)).map(s => s.points[0]);
          const other = T.P(0).strokes[2].points[0];
          const b = view.selection.box;
          await T.drag(0, [b[2], b[3]], [b[2] + 102, b[3] + 76.5], { n: 20 });
          await T.sleep(20);
          const im2 = { ...T.im() }, ink2 = T.P(0).strokes.filter(s => T.onIds.includes(s.id)).map(s => s.points[0]);
          const rel = (p, im) => [(p.x - im.x) / im.width, (p.y - im.y) / im.height];
          const disk = ink.readPage(await T.disk(0));
          const out = { im0, im1, im2, rel0: ink0.map(p => rel(p, im0)), rel1: ink1.map(p => rel(p, im1)), rel2: ink2.map(p => rel(p, im2)),
            other: [other.x, other.y], sel: view.selection, diskIm: disk.images[0], diskOn: disk.strokes.map(s => s.on || null) };
          view.undo();
          out.undo1 = { ...T.im() };
          out.undoInk1 = T.P(0).strokes.filter(s => T.onIds.includes(s.id)).map(s => s.points[0]);
          view.undo();
          out.undo2 = { ...T.im() };
          out.undoInk2 = T.P(0).strokes.filter(s => T.onIds.includes(s.id)).map(s => s.points[0]);
          out.ink0 = ink0;
          view.redo(); view.redo();
          out.redo = { ...T.im() };
          await T.sleep(100);
          return out;
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'images_moved.png'))
        close = lambda a, b, tol=0.01: all(abs(x - y) <= tol for pa, pb in zip(a, b) for x, y in zip(pa, pb))
        del_im = lambda im: {k: v for k, v in im.items() if k != 'data'}
        print('image move/resize:', del_im(r['im0']), '->', del_im(r['im1']), '->', del_im(r['im2']))
        check('images: moving the photo moves the ink written on it; the ink stays at the same place on the photo',
              r['im1']['x'] == r['im0']['x'] + 50 and r['im1']['y'] == r['im0']['y'] + 60 and r['im1']['width'] == r['im0']['width'] and close(r['rel0'], r['rel1']), r)
        check('images: resizing the photo scales it (aspect kept) and its ink with it',
              abs(r['im2']['width'] / r['im1']['width'] - 1.25) < 0.02 and abs(r['im2']['height'] / r['im2']['width'] - 0.75) < 0.01 and close(r['rel1'], r['rel2']), r)
        check('images: ink not on the photo stays put; the moved photo and its ink are saved', abs(r['other'][0] - 100) < 0.5 and abs(r['other'][1] - 900) < 0.5 and del_im(r['diskIm']) == del_im(r['im2']) and r['diskOn'][:2] == [r['im2']['id']] * 2, r)
        check('images: move and resize are one undo step each, photo and ink together; redo repeats them',
              del_im(r['undo1']) == del_im(r['im1']) and del_im(r['undo2']) == del_im(r['im0']) and close([[p['x'], p['y']] for p in r['undoInk2']], [[p['x'], p['y']] for p in r['ink0']], 0.11)
              and del_im(r['redo']) == del_im(r['im2']), r)

        # Delete asks whether to keep the ink: cancel, keep (undo, redo), delete the ink too (undo).
        r = ev("""async () => {
          const id = T.im().id, n0 = T.P(0).strokes.length;
          view.select(0, [], [id]);
          view.contentEl.querySelector('.nb-ink-sel-delete').click();
          const m = modals[modals.length - 1];
          const asked = { open: modals.length > 0, title: m && m.titleEl.textContent };
          m.contentEl.querySelector('.nb-cancel-delete').click();
          const cancelled = { images: T.P(0).images.length, strokes: T.P(0).strokes.length, modals: modals.length };
          view.select(0, [], [id]);
          view.deleteSelection();
          modals[modals.length - 1].contentEl.querySelector('.nb-keep-ink').click();
          const keep = { images: T.P(0).images.length, strokes: T.P(0).strokes.length, on: T.P(0).strokes.map(s => s.on || null) };
          const disk = ink.readPage(await T.disk(0));
          keep.disk = { images: (disk.images || []).length, on: disk.strokes.map(s => s.on || null) };
          view.undo();
          const undoKeep = { images: T.P(0).images.length, on: T.P(0).strokes.map(s => s.on || null) };
          view.redo();
          const redoKeep = { images: T.P(0).images.length, on: T.P(0).strokes.map(s => s.on || null) };
          view.undo();
          view.select(0, [], [id]);
          view.deleteSelection();
          modals[modals.length - 1].contentEl.querySelector('.nb-delete-ink').click();
          const del = { images: T.P(0).images.length, strokes: T.P(0).strokes.length };
          view.undo();
          const undoDel = { images: T.P(0).images.length, strokes: T.P(0).strokes.length, on: T.P(0).strokes.map(s => s.on || null) };
          // Image and all its ink selected: nothing to ask.
          view.select(0, T.onIds, [id]);
          const m0 = modals.length;
          view.deleteSelection();
          const noAsk = { modals: modals.length - m0, images: T.P(0).images.length, strokes: T.P(0).strokes.length };
          view.undo();
          return { id, n0, asked, cancelled, keep, undoKeep, redoKeep, del, undoDel, noAsk };
        }""")
        id_ = r['id']
        check('images: deleting a photo with ink on it asks "Keep the ink written on it?"; Cancel deletes nothing',
              r['asked'] == {'open': True, 'title': 'Keep the ink written on it?'} and r['cancelled'] == {'images': 1, 'strokes': 3, 'modals': 0}, r)
        check('images: "Keep the ink" deletes the photo and keeps its ink, no longer on it (saved so); undo and redo',
              r['keep']['images'] == 0 and r['keep']['strokes'] == 3 and r['keep']['on'] == [None] * 3 and r['keep']['disk'] == {'images': 0, 'on': [None] * 3}
              and r['undoKeep'] == {'images': 1, 'on': [id_, id_, None]} and r['redoKeep'] == {'images': 0, 'on': [None] * 3}, r)
        check('images: "Delete the ink too" deletes the photo and its ink; undo puts both back',
              r['del'] == {'images': 0, 'strokes': 1} and r['undoDel'] == {'images': 1, 'strokes': 3, 'on': [id_, id_, None]}, r)
        check('images: deleting a photo selected with all its ink asks nothing', r['noAsk'] == {'modals': 0, 'images': 0, 'strokes': 1}, r)

        # Copy, paste and duplicate take the photo and its ink; the copies' ink is on the copy.
        r = ev("""async () => {
          const id = T.im().id;
          view.select(0, [], [id]);
          view.duplicateSelection();
          const dup = { images: T.P(0).images.map(i => i.id), sel: view.selection.images, on: T.P(0).strokes.map(s => s.on || null) };
          view.undo();
          view.select(0, [], [id]);
          view.copySelection();
          view.clearSelection();
          const pasted = view.pasteStrokes();
          const pst = { images: T.P(0).images.length, strokes: T.P(0).strokes.length, on: T.P(0).strokes.slice(3).map(s => s.on || null), sel: view.selection.images };
          view.undo();
          return { id, dup, pasted, pst, after: T.P(0).images.length };
        }""")
        d = r['dup']
        check('images: duplicate copies the photo with a new id and its ink onto the copy; paste too; each one undo step',
              len(d['images']) == 2 and d['sel'] == [d['images'][1]] and d['on'][3:] == [d['images'][1]] * 2 and r['pasted']
              and r['pst']['images'] == 2 and len(r['pst']['sel']) == 1 and r['pst']['on'] == r['pst']['sel'] * 2 and r['after'] == 1, r)

        # Insert as a whole page: a page after the current one, the paper's width and the photo's aspect.
        r = ev("""async () => {
          view.clearSelection();
          const n0 = view.store.slots.length;
          await view.insertImageFile(await T.photo(1600, 1200), true);
          await T.sleep(200);
          const i = view.store.slots.length - 1, pg = T.P(1);
          const out = { n0, n: view.store.slots.length, size: pg.size, kind: pg.template.kind, idx: view.currentPageIndex() };
          view.setTool('pen');
          await T.pen(1, Array.from({ length: 30 }, (_, j) => [100 + j * 10, 300, 0.4]), { predict: 0, id: 14 });
          out.red = T.pixel(1, 200, 150);
          out.yellow = T.pixel(1, 600, 450);
          out.ink = T.pixel(1, 200, 300);
          const svg = await T.disk(1);
          out.once = svg.split(pg.template.image).length - 1;
          out.meta = /"template":\\{"kind":"image"\\}/.test(svg);
          document.body.classList.add('theme-dark'); app.workspace.trigger('css-change');
          await T.sleep(100);
          out.darkInk = T.pixel(1, 200, 300);
          document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change');
          view.undo();
          out.undoStroke = T.P(1).strokes.length;
          view.undo();
          out.undoPage = view.store.slots.length;
          view.redo();
          out.redoPage = view.store.slots.length;
          await T.sleep(100);
          return out;
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'images_page.png'))
        check('images: "Insert as a whole page" adds a page after the current one, at the paper width and the photo aspect, with an image template',
              r['n'] == r['n0'] + 1 and r['size'] == {'width': 816, 'height': 612} and r['kind'] == 'image' and r['idx'] == 1, r)
        check('images: the image page shows the photo, ink written on it, dark ink in dark mode; its bytes saved once',
              near(r['red'], (0xd0, 0x20, 0x20)) and near(r['yellow'], (0xe0, 0xc0, 0x20)) and max(r['ink']) < 80 and max(r['darkInk']) < 80
              and r['once'] == 1 and r['meta'], r)
        check('images: the image page is one undo step', r['undoStroke'] == 0 and r['undoPage'] == r['n0'] and r['redoPage'] == r['n'], r)

        # A 12-megapixel photo (4000 x 3000, noisy like a real one) decodes and encodes in about a second.
        r = ev("""async () => {
          const w = 4000, h = 3000, c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d');
          const grad = g.createLinearGradient(0, 0, w, h);
          grad.addColorStop(0, '#305080'); grad.addColorStop(0.5, '#c0a070'); grad.addColorStop(1, '#204020');
          g.fillStyle = grad; g.fillRect(0, 0, w, h);
          const tile = g.createImageData(500, 500);
          for (let k = 0; k < tile.data.length; k++) tile.data[k] = (k & 3) === 3 ? 60 : (Math.random() * 255) | 0;
          const t = document.createElement('canvas'); t.width = t.height = 500; t.getContext('2d').putImageData(tile, 0, 0);
          for (let x = 0; x < w; x += 500) for (let y = 0; y < h; y += 500) g.drawImage(t, x, y);
          const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
          c.width = c.height = 0;
          const file = new File([blob], 'IMG_0001.jpg', { type: 'image/jpeg' });
          view.scrollToPage(0);
          await T.sleep(50);
          const t0 = performance.now();
          const ok = await view.insertImageFile(file);
          const ms = performance.now() - t0;
          await T.sleep(300);
          const out = { ok, ms, fileMB: file.size / 1e6, stats: view.imageStats, n: T.P(0).images.length };
          view.undo();
          return out;
        }""")
        s = r['stats']
        print(f"12 MP photo ({r['fileMB']:.1f} MB JPEG): insert {r['ms']:.0f} ms (decode {s['decodeMs']:.0f} ms, scale and encode {s['encodeMs']:.0f} ms), stored {s['width']} x {s['height']}, {s['bytes'] / 1e6:.1f} MB data URL")
        check('images: a 12-megapixel photo is inserted at full resolution in under 2 s in Chromium', r['ok'] and s['width'] == 4000 and s['height'] == 3000 and r['ms'] < 2000, r)

        # Reopen: the photo, its ink and the image page read back and render.
        r = ev("""async () => {
          await app.workspace.activeLeaf.detach();
          await T.sleep(30);
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Photos.md'));
          await T.sleep(300);
          const pg = view.store.page(view.store.slots[0]), p2 = view.store.page(view.store.slots[1]);
          const im = pg.images[0];
          return { images: pg.images.length, data: im.data.startsWith('data:image/jpeg;base64,'), on: pg.strokes.map(s => s.on || null), id: im.id,
            kind: p2.template.kind, p2img: p2.template.image.length > 1000,
            red: T.pixel(0, im.x + im.width / 4, im.y + im.height / 4) };
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'images_reopened.png'))
        check('images: after reopening, the photo, the ink on it and the image page are read back and drawn',
              r['images'] == 1 and r['data'] and r['on'] == [r['id'], r['id'], None] and r['kind'] == 'image' and r['p2img'] and near(r['red'], (0xd0, 0x20, 0x20)), r)

        # The page menu's entries; picking a file through the file input inserts it.
        r = ev("""async () => {
          view.contentEl.querySelector('.nb-ink-page-settings').click();
          const picker = view.contentEl.querySelector('.nb-ink-picker');
          const items = ['.nb-ink-menu-insert-image', '.nb-ink-menu-insert-image-page', '.nb-ink-menu-paste-image'].map(c => !!picker.querySelector(c));
          const n0 = T.P(0).images.length;
          picker.querySelector('.nb-ink-menu-insert-image').click();
          const input = document.querySelector('input.nb-image-file-input');
          const accept = input && input.accept;
          const dt = new DataTransfer();
          dt.items.add(await T.photo(200, 100));
          input.files = dt.files;
          input.dispatchEvent(new Event('change'));
          for (let i = 0; i < 50 && T.P(0).images.length === n0; i++) await T.sleep(20);
          const out = { items, accept, n0, n: T.P(0).images.length, gone: !document.querySelector('input.nb-image-file-input') };
          view.undo();
          view.clearSelection();
          view.setTool('pen');
          return out;
        }""")
        check('images: the page menu offers Insert image, Insert image as page and Paste image; the file input (image/*) inserts the chosen file',
              r['items'] == [True, True, True] and r['accept'] == 'image/*' and r['n'] == r['n0'] + 1 and r['gone'], r)
        # ======== end of 25. Images on pages (#12) ========

        # ======== 26. The ruler (#20) ========
        r = ev("""async () => {
          await p.createInkNote('Ruler', '', 'letter', 'blank');
          await T.sleep(150);
          view.setTool('pen');
          T.rl = () => view.rulerLayer;
          // Pressure rising along the stroke (T.penAt sends 0.5 throughout).
          const penAt = T.penAt;
          T.rpen = (pts, opts) => {
            const P = window.PointerEvent;
            let j = 0;
            window.PointerEvent = class extends P { constructor(type, init) { super(type, { ...init, pressure: type === 'pointerup' ? 0 : 0.15 + 0.7 * Math.min(1, j++ / pts.length) }); } };
            return penAt(pts, opts).finally(() => { window.PointerEvent = P; });
          };
          /** Scrolls page 0's centre to the middle of the view. */
          T.middle = () => {
            const sc = T.sc(), c = T.screenPoint([0, 408, 528]), m = T.centre();
            sc.scrollTop += c[1] - m[1];
            sc.scrollLeft += c[0] - m[0];
          };
          /** Moves fingers from `from` ([[x, y], ...]) to `to` in n steps, a frame after each (section 15's; section 22 reused the name). */
          T.fdrag = async (from, to, n) => {
            const at = (i, s) => [from[i][0] + (to[i][0] - from[i][0]) * s / n, from[i][1] + (to[i][1] - from[i][1]) * s / n];
            from.forEach(([x, y], i) => T.finger('pointerdown', 101 + i, x, y));
            for (let s = 1; s <= n; s++) {
              from.forEach((_, i) => T.finger('pointermove', 101 + i, ...at(i, s)));
              await T.frame();
            }
            to.forEach(([x, y], i) => T.finger('pointerup', 101 + i, x, y));
          };
          T.rs = () => view.rulerState;
          /** Client point of the ruler's centre line `along` page px from its centre (plus `off` page px along the normal). */
          T.onRuler = (along, off = 0) => {
            const s = T.rs(), a = s.angle * Math.PI / 180, d = [Math.cos(a), -Math.sin(a)], n = [Math.sin(a), Math.cos(a)];
            return T.screenPoint([s.page, s.cx + d[0] * along + n[0] * off, s.cy + d[1] * along + n[1] * off]);
          };
          /** The largest angle (degrees) between the line at `angle` and the direction from the first point to each point 100+ px away. */
          T.angErr = (pts, angle) => {
            let worst = 0;
            for (const q of pts) {
              const dx = q.x - pts[0].x, dy = q.y - pts[0].y;
              if (Math.hypot(dx, dy) < 100) continue;
              let d = Math.abs(((Math.atan2(-dy, dx) * 180 / Math.PI - angle) % 180 + 360) % 180);
              worst = Math.max(worst, Math.min(d, 180 - d));
            }
            return worst;
          };
          T.lastStroke = i => { const s = view.store.page(view.store.slots[i]).strokes; return s[s.length - 1]; };
          const btn = T.tb('.nb-ink-ruler');
          const out = { label: btn.getAttribute('aria-label'), disabled: btn.disabled, tool0: view.pen.tool };
          btn.click();
          await T.sleep(50);
          out.onByButton = [view.rulerOn, btn.getAttribute('aria-pressed'), !!T.pages()[0].querySelector('.nb-ink-ruler-layer'), view.pen.tool];
          const layer = T.pages()[0].querySelector('.nb-ink-ruler-layer');
          out.drawn = T.rl().draws > 0;
          const c = layer.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
          out.canvasInk = n;
          out.label0 = layer.querySelector('.nb-ink-ruler-angle').textContent;
          btn.click();
          out.offByButton = [view.rulerOn, btn.getAttribute('aria-pressed'), !!T.pages()[0].querySelector('.nb-ink-ruler-layer')];
          const shown = commands['toggle-ruler'].checkCallback(true);
          commands['toggle-ruler'].checkCallback(false);
          out.onByCommand = [shown, view.rulerOn, !!T.pages()[0].querySelector('.nb-ink-ruler-layer'), btn.getAttribute('aria-pressed')];
          commands['toggle-ruler'].checkCallback(false);
          out.offByCommand = view.rulerOn;
          commands['toggle-ruler'].checkCallback(false);
          out.state = T.rs();
          return out;
        }""")
        print('ruler: toggle:', r)
        check('ruler: the toolbar button is enabled ("Ruler") and toggles the ruler over the current page; the pen stays the tool',
              r['label'] == 'Ruler' and not r['disabled'] and r['onByButton'] == [True, 'true', True, 'pen'] and r['offByButton'] == [False, 'false', False], r)
        check('ruler: the "Toggle ruler" command turns it on and off', r['onByCommand'] == [True, True, True, 'true'] and r['offByCommand'] is False, r)
        check('ruler: drawn (bar, edges, ticks) with its angle label, at 0°', r['drawn'] and r['canvasInk'] > 20000 and r['label0'] == '0°'
              and r['state']['on'] and r['state']['page'] == 0 and r['state']['angle'] == 0, r)

        r = ev("""async () => {
          const sc = T.sc(), s0 = T.rs(), top0 = sc.scrollTop, left0 = sc.scrollLeft, g0 = view.stats.nav.gestures;
          const k = T.pages()[0].getBoundingClientRect().width / 816;
          // One finger on the bar, 150 px right of the centre, dragged 40 px right and 30 px down (CSS).
          const a = T.onRuler(150), hit = document.elementFromPoint(...a).className;
          await T.fdrag([a], [[a[0] + 40, a[1] + 30]], 8);
          const s1 = T.rs();
          const moved = [s1.cx - s0.cx, s1.cy - s0.cy].map(v => Math.round(v * k * 10) / 10);
          const panned = [sc.scrollTop - top0, sc.scrollLeft - left0, view.stats.nav.gestures - g0];
          // Two fingers on the bar either side of the centre, turned 29° counter-clockwise: snaps to 30.
          const turn = async (deg, from = 0) => {
            const s = T.rs(), c = T.screenPoint([0, s.cx, s.cy]);
            const at = (d, sign) => { const r = (from + d) * Math.PI / 180; return [c[0] + sign * 150 * k * Math.cos(r), c[1] - sign * 150 * k * Math.sin(r)]; };
            await T.fdrag([at(0, -1), at(0, 1)], [at(deg, -1), at(deg, 1)], 10);
            return T.rs();
          };
          const s2 = await turn(29);
          const centreKept = Math.hypot(s2.cx - s1.cx, s2.cy - s1.cy);
          const s3 = await turn(-8, 30);  // 22°: not near a multiple of 15
          const s4 = await turn(-21, 22); // 1° snaps to 0°
          const panned2 = [sc.scrollTop - top0, sc.scrollLeft - left0, view.stats.nav.gestures - g0];
          // One finger on the ruler and one beside it (off the bar) also turn it.
          const s = T.rs(), c = T.screenPoint([0, s.cx, s.cy]);
          const p1 = [c[0] - 150 * k, c[1]], p2 = [c[0] + 150 * k, c[1] + 120 * k];
          const hit2 = document.elementFromPoint(...p2).className;
          const r2 = 45 * Math.PI / 180, rot = ([x, y]) => [c[0] + (x - c[0]) * Math.cos(r2) + (y - c[1]) * Math.sin(r2), c[1] - (x - c[0]) * Math.sin(r2) + (y - c[1]) * Math.cos(r2)];
          const b0 = Math.atan2(-(p2[1] - p1[1]), p2[0] - p1[0]) * 180 / Math.PI;
          await T.fdrag([p1, p2], [rot(p1), rot(p2)], 10);
          const s5 = T.rs();
          const panned3 = [sc.scrollTop - top0, sc.scrollLeft - left0, view.stats.nav.gestures - g0];
          view.setRulerAngle(0);
          // A finger off the ruler pans as usual.
          const off = T.onRuler(0, 250);
          const hitOff = document.elementFromPoint(...off).className;
          await T.fdrag([off], [[off[0], off[1] - 150]], 8);
          await T.settle();
          const pannedOff = sc.scrollTop - top0;
          return { hit, moved, panned, s2: s2.angle, centreKept, s3: s3.angle, s4: s4.angle, panned2, hit2, s5: s5.angle, b0, panned3, hitOff, pannedOff,
            label: T.rl().label.textContent };
        }""")
        print('ruler: fingers:', r)
        check('ruler: one finger on the bar moves it with the finger (40, 30 CSS px)', 'nb-ink-ruler-bar' in r['hit'] and r['moved'] == [40, 30], r)
        check('ruler: two fingers turn it; 29° snaps to 30°, 22° stays, 1° snaps to 0°; turning about its centre keeps it there',
              r['s2'] == 30 and abs(r['s3'] - 22) < 0.05 and r['s4'] == 0 and r['centreKept'] < 0.01, r)
        check('ruler: one finger on it and one beside it turn it too (45°)', 'nb-ink-ruler-bar' not in r['hit2'] and r['s5'] == 45, r)
        check('ruler: fingers on the ruler never pan the view', r['panned'] == [0, 0, 0] and r['panned2'] == [0, 0, 0] and r['panned3'] == [0, 0, 0], r)
        check('ruler: a finger off the ruler pans', 'nb-ink-ruler-bar' not in r['hitOff'] and r['pannedOff'] > 100, r)

        r = ev("""async () => {
          T.sc().scrollTop = 0;
          await T.sleep(50);
          const label = T.rl().label;
          label.click();
          const input = T.pages()[0].querySelector('.nb-ink-ruler-input');
          const opened = !!input && document.activeElement === input;
          input.value = '30';
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const typed = T.rs().angle, closed = !T.pages()[0].querySelector('.nb-ink-ruler-input'), text = label.textContent;
          // A bad value changes nothing.
          label.click();
          const i2 = T.pages()[0].querySelector('.nb-ink-ruler-input');
          i2.value = '400';
          i2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const bad = T.rs().angle;
          // From the pen's picker too.
          const pk = T.picker();
          const pin = pk.querySelector('.nb-ink-ruler-angle-input');
          const shown = pin ? pin.value : null;
          pin.value = '12.5';
          pin.dispatchEvent(new Event('change', { bubbles: true }));
          const fromPicker = T.rs().angle;
          pk.querySelector('.nb-ink-ruler-unit[data-unit="in"]').click();
          const unit = view.rulerUnit;
          pk.querySelector('.nb-ink-ruler-unit[data-unit="cm"]').click();
          view.toolbar.closePicker();
          view.setRulerAngle(30);
          return { opened, typed, closed, text, bad, shown, fromPicker, unit, after: view.rulerUnit };
        }""")
        check('ruler: tapping the angle opens an input; typing 30 sets 30°', r['opened'] and r['typed'] == 30 and r['closed'] and r['text'] == '30°', r)
        check('ruler: an angle over 360 is ignored', r['bad'] == 30, r)
        check('ruler: the pen picker shows the angle and sets it, and switches cm / in', r['shown'] == '30' and r['fromPicker'] == 12.5 and r['unit'] == 'in' and r['after'] == 'cm', r)

        r = ev("""async () => {
          const out = {};
          for (const z of [0.5, 1, 4]) {
            view.setZoom(z);
            await T.sleep(120);
            // Page 0's centre in the middle of the view (as far as it scrolls), the ruler's centre on it.
            T.middle();
            await T.sleep(50);
            view.setRulerCentre(408, 528);
            view.setRulerAngle(30);
            await T.frame();
            const k = T.pages()[0].getBoundingClientRect().width / 816;
            // From 8 CSS px outside the edge, 100 page px back along it (60 at 400%, to stay in view), to as far forward, 6 CSS px inside, with a wobble.
            const half = z === 4 ? 60 : 100;
            const e = 36 + 8 / k, pts = [];
            for (let j = 0; j <= 40; j++) {
              const u = j / 40;
              pts.push(T.onRuler(half * (2 * u - 1), 36 + (8 - 14 * u + 3 * Math.sin(j)) / k));
            }
            let label = null;
            const res = await T.rpen(pts, { id: 70, between: j => { if (j === 30) { const l = T.rl().length; label = l.style.display !== 'none' ? l.textContent : null; } } });
            const st = T.lastStroke(res.i);
            const d = st.points.map(q => Math.abs((q.x - T.rs().cx) * Math.sin(Math.PI / 6) + (q.y - T.rs().cy) * Math.cos(Math.PI / 6) - 36));
            out[z] = { page: res.i, ruled: view.input.lastRuled, n: st.points.length, err: T.angErr(st.points, 30), off: Math.max(...d),
              ps: new Set(st.points.map(q => q.p)).size, label, after: T.rl().length.style.display };
          }
          // A stroke starting 40 CSS px from the edge is an ordinary stroke.
          view.resetZoom();
          await T.sleep(120);
          T.middle();
          await T.sleep(50);
          view.setRulerCentre(408, 528);
          await T.frame();
          const k = T.pages()[0].getBoundingClientRect().width / 816, pts = [];
          for (let j = 0; j <= 40; j++) pts.push(T.onRuler(-100 + 5 * j, 36 + (40 + 10 * Math.sin(j / 4)) / k));
          const res = await T.penAt(pts, { id: 71 });
          const st = T.lastStroke(res.i);
          out.far = { ruled: view.input.lastRuled, landed: T.landed(res.i, res.expected), err: T.angErr(st.points, 30) };
          return out;
        }""")
        for z in ('0.5', '1', '4'):
            print(f'ruler: zoom {z}:', r[z])
        print('ruler: 40 px away:', r['far'])
        check('ruler: a pen stroke starting near the edge is stored on it at 30° ± 0.1° at 50%, 100% and 400%',
              all(r[z]['ruled'] and r[z]['page'] == 0 and r[z]['n'] > 20 and r[z]['err'] <= 0.1 and r[z]['off'] <= 0.1 for z in ('0.5', '1', '4')), r)
        check('ruler: the ruled stroke keeps its pressure', all(r[z]['ps'] > 5 for z in ('0.5', '1', '4')), r)
        check('ruler: its length is shown while drawing (cm) and hidden after', all((r[z]['label'] or '').endswith(' cm') and r[z]['after'] == 'none' for z in ('0.5', '1', '4')), r)
        check('ruler: a stroke starting 40 px from the edge is untouched', not r['far']['ruled'] and r['far']['landed'] >= 0 and r['far']['landed'] <= 0.06 and r['far']['err'] > 1, r)

        r = ev("""async () => {
          view.setRulerAngle(0);
          T.middle();
          await T.sleep(50);
          view.setRulerCentre(408, 528);
          await T.frame();
          const L = 10 / 2.54 * 96, pts = [];
          for (let j = 0; j <= 50; j++) pts.push(T.onRuler(-L / 2 + L * j / 50, 36 + 0.4 * Math.sin(j)));
          pts.push(pts[50]);  // one more move, so the label after the last real one is seen
          let label = null;
          const res = await T.penAt(pts, { id: 72, between: j => { if (j === 51) label = T.rl().length.textContent; } });
          const st = T.lastStroke(res.i), a = st.points[0], b = st.points[st.points.length - 1];
          const mm = Math.hypot(b.x - a.x, b.y - a.y) / 96 * 25.4;
          view.setRulerUnit('in');
          T.rl().showLength({ x: 100, y: 100 }, L);
          const inch = T.rl().length.textContent;
          T.rl().showLength(null);
          view.setRulerUnit('cm');
          return { mm, label, inch };
        }""")
        print('ruler: 10 cm line:', r)
        check('ruler: a 10 cm ruled line is stored 10 cm ± 0.5 mm long, labelled 10.0 cm while drawn', abs(r['mm'] - 100) <= 0.5 and r['label'] in ('9.9 cm', '10.0 cm'), r)
        check('ruler: in inches the label reads 3.94 in', r['inch'] == '3.94 in', r)

        r = ev("""async () => {
          const s0 = T.rs(), sc = T.sc();
          const place = () => { const b = T.rl().bar.getBoundingClientRect(), s = T.rs(), c = T.screenPoint([s.page, s.cx, s.cy]);
            return Math.hypot((b.left + b.right) / 2 - c[0], (b.top + b.bottom) / 2 - c[1]); };
          const before = place();
          sc.scrollTop += 120;
          await T.sleep(80);
          const scrolled = [T.rs(), place()];
          view.setZoom(2);
          await T.sleep(150);
          const zoomed = [T.rs(), place()];
          view.resetZoom();
          await T.sleep(150);
          // Toggling off and on keeps it where it was (same page).
          view.toggleRuler(); view.toggleRuler();
          return { s0, before, scrolled, zoomed, again: T.rs() };
        }""")
        same = lambda a, b: all(abs(a[k] - b[k]) < 1e-9 for k in ('cx', 'cy', 'angle', 'page'))
        check('ruler: it keeps its page position across a scroll and a zoom, and is drawn there',
              same(r['scrolled'][0], r['s0']) and same(r['zoomed'][0], r['s0']) and r['before'] < 1 and r['scrolled'][1] < 1 and r['zoomed'][1] < 1, r)
        check('ruler: turned off and on, it comes back where it was', same(r['again'], r['s0']), r)

        ev("async () => { view.setRulerAngle(30); await T.frame(); }")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'ruler_light.png'))
        ev("async () => { document.body.classList.add('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(150); }")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'ruler_dark.png'))
        ev("async () => { document.body.classList.remove('theme-dark'); app.workspace.trigger('css-change'); await T.sleep(50); }")

        r = ev("""async () => {
          await view.save();
          const path = view.store.slots[0].path, text = fs.get(path), pg = ink.readPage(text), model = view.store.page(view.store.slots[0]);
          const same = ink.writePage(model) === text;
          const md = fs.get('Ruler.md');
          await app.workspace.activeLeaf.detach();
          await T.sleep(50);
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(app.vault.getFile('Ruler.md'));
          await T.sleep(150);
          return { strokes: pg.strokes.length, same, mentions: /ruler/i.test(text) || /ruler/i.test(md.replace(/Ruler/g, '')), reopened: [view.rulerOn, !!view.rulerState, !!T.pages()[0].querySelector('.nb-ink-ruler-layer')],
            tools: pg.strokes.map(s => s.tool) };
        }""")
        check('ruler: not saved: the page file is exactly its strokes (ordinary pen strokes), with no trace of the ruler',
              r['strokes'] == 5 and r['same'] and not r['mentions'] and all(t == 'pen' for t in r['tools']), r)
        check('ruler: reopening the note shows no ruler', r['reopened'] == [False, False, False], r)
        # ======== end of 26. The ruler (#20) ========

        # ======== 27. Shapes: hold to straighten (#16) ========
        r = ev("""async () => {
          view.resetZoom();
          await T.sleep(120);
          T.middle();
          await T.sleep(50);
          view.setTool('pen');
          /** A hand-drawn path through `corners` (page px), ~2 px steps with a wobble, as [x, y, p]. */
          T.hand = (corners, wob = 1.5) => {
            const out = [];
            let s = 0;
            for (let i = 1; i < corners.length; i++) {
              const [ax, ay] = corners[i - 1], [bx, by] = corners[i], L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(L / 2));
              for (let j = i === 1 ? 0 : 1; j <= n; j++) {
                const u = j / n, w = wob * Math.sin(s / 23);
                out.push([ax + (bx - ax) * u - (by - ay) / L * w, ay + (by - ay) * u + (bx - ax) / L * w, 0.3 + 0.2 * Math.sin(s / 50)]);
                s += L / n;
              }
            }
            return out;
          };
          T.rect = (x, y, w, h) => T.hand([[x + 10, y + 2], [x + w - 6, y - 1], [x + w, y + 5], [x + w + 2, y + h - 6], [x + w - 5, y + h], [x + 5, y + h + 2], [x - 1, y + h - 5], [x + 1, y + 6], [x + 12, y + 1]]);
          T.circle = (cx, cy, R) => T.hand(Array.from({ length: 49 }, (_, j) => [cx + R * Math.cos(j / 46 * 2 * Math.PI), cy + R * Math.sin(j / 46 * 2 * Math.PI)]), 1);
          /** Draws `pts` on page 0 and holds still for `ms` with the pointer down; returns the preview then and before. */
          T.hold = async (pts, { ms = 700, id = 80, type = 'pen', repeat = false } = {}) => {
            await T.pen(0, pts, { id, type, up: false });
            await T.frame();
            const before = { shape: view.input.previewShape, path: view.input.livePath };
            if (repeat) {
              // WebKit keeps sending pointermoves at (nearly) the same place while the Pencil is held.
              const el = T.pages()[0], r = el.getBoundingClientRect(), k = r.width / 816, [x, y] = pts[pts.length - 1];
              for (let t = 0; t < ms; t += 40) {
                el.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, pointerType: type, pressure: 0.4, clientX: r.left + x * k + (t % 80 ? 0.5 : 0), clientY: r.top + y * k,
                  bubbles: true, cancelable: true, buttons: 1 }));
                await T.sleep(40);
              }
            } else await T.sleep(ms);
            await T.frame();
            return { before, shape: view.input.previewShape, path: view.input.livePath, live: T.liveInk(1) };
          };
          T.labels = () => view.history.labels.slice(-2);
          return true;
        }""")

        # A rough rectangle, held, then lifted.
        r = ev("""async () => {
          const pts = T.rect(250, 380, 300, 200), n0 = view.store.page(view.store.slots[0]).strokes.length;
          const h = await T.hold(pts);
          return { h, n0, pts: pts.length };
        }""")
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'shapes_preview.png'))
        r2 = ev("""async () => {
          T.penUp(0, T.rect(250, 380, 300, 200).slice(-1)[0], 80);
          await T.frame();
          const st = T.lastStroke(0), pts = st.points;
          const xs = pts.map(q => q.x), ys = pts.map(q => q.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          const onSides = pts.every(q => q.x === x0 || q.x === x1 || q.y === y0 || q.y === y1);
          const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].filter(([x, y]) => pts.some(q => q.x === x && q.y === y)).length;
          const out = { kind: view.input.lastShape, n: view.store.page(view.store.slots[0]).strokes.length, tool: st.tool, onSides, corners, box: [x0, y0, x1, y1],
            closed: pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y, id: st.id, labels: T.labels(), live: T.liveInk(1) };
          view.undo();
          const u = T.lastStroke(0);
          out.undo = { id: u.id, n: u.points.length, straight: u.points.every(q => q.x === x0 || q.x === x1 || q.y === y0 || q.y === y1), count: view.store.page(view.store.slots[0]).strokes.length };
          view.redo();
          const re = T.lastStroke(0);
          out.redo = { same: JSON.stringify(re.points) === JSON.stringify(pts), id: re.id };
          view.undo(); view.undo();
          out.twice = view.store.page(view.store.slots[0]).strokes.length;
          view.redo();
          out.redoAdd = T.lastStroke(0).points.length;
          view.redo();
          out.redoBoth = JSON.stringify(T.lastStroke(0).points) === JSON.stringify(pts);
          return out;
        }""")
        print('shapes: rectangle:', r, r2)
        check('shapes: holding a rough rectangle still for 600 ms previews a rectangle in place of the stroke',
              r['h']['before']['shape'] is None and r['h']['shape'] == 'rectangle' and r['h']['path'] != r['h']['before']['path'] and r['h']['live'] > 1000, r)
        check('shapes: lifted, the saved stroke is the rectangle: axis-aligned, 4 exact corners, closed; the overlay is cleared',
              r2['kind'] == 'rectangle' and r2['n'] == r['n0'] + 1 and r2['onSides'] and r2['corners'] == 4 and r2['closed'] and r2['tool'] == 'pen' and r2['live'] == 0, r2)
        check('shapes: undo steps are "Add stroke", "Straighten"; undo restores the freehand stroke (same id), redo the rectangle',
              r2['labels'] == ['Add stroke', 'Straighten'] and r2['undo']['id'] == r2['id'] and not r2['undo']['straight'] and r2['undo']['count'] == r2['n']
              and r2['redo']['same'] and r2['redo']['id'] == r2['id'], r2)
        check('shapes: a second undo removes the stroke; redo brings it back freehand, then straightened',
              r2['twice'] == r['n0'] and r2['redoAdd'] == r2['undo']['n'] and r2['redoBoth'], r2)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'shapes_rectangle.png'))

        # A line, and a circle held with WebKit-style repeated pointermoves.
        r = ev("""async () => {
          const out = {};
          const line = T.hand([[200, 700], [560, 640]], 2);
          out.lineHold = (await T.hold(line, { id: 81 })).shape;
          T.penUp(0, line[line.length - 1], 81);
          await T.frame();
          let st = T.lastStroke(0), a = st.points[0], b = st.points[st.points.length - 1];
          const off = q => Math.abs((q.x - a.x) * (b.y - a.y) - (q.y - a.y) * (b.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
          out.line = { kind: view.input.lastShape, off: Math.max(...st.points.map(off)), n: st.points.length, labels: T.labels() };
          const circle = T.circle(620, 450, 70);
          out.circleHold = (await T.hold(circle, { id: 82, repeat: true })).shape;
          T.penUp(0, circle[circle.length - 1], 82);
          await T.frame();
          st = T.lastStroke(0);
          const xs = st.points.map(q => q.x), ys = st.points.map(q => q.y), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          const rs = st.points.map(q => Math.hypot(q.x - cx, q.y - cy));
          out.circle = { kind: view.input.lastShape, spread: Math.max(...rs) - Math.min(...rs), r: rs[0] };
          view.undo();
          out.circleUndo = T.lastStroke(0).points.length !== st.points.length;
          view.redo();
          return out;
        }""")
        print('shapes: line and circle:', r)
        check('shapes: a held wobbly line is saved straight (every point within 0.1 px of the line through its ends)',
              r['lineHold'] == 'line' and r['line']['kind'] == 'line' and r['line']['off'] <= 0.1 and r['line']['labels'] == ['Add stroke', 'Straighten'], r)
        check('shapes: a circle held with repeated pointermoves in place is saved as a circle (radius spread under 0.3 px about its box centre); undo restores the freehand one',
              r['circleHold'] == 'circle' and r['circle']['kind'] == 'circle' and r['circle']['spread'] < 0.3 and r['circleUndo'], r)

        # Moving on after the hold, the ruler, the highlighter and the toggle.
        r = ev("""async () => {
          const out = {};
          const line = T.hand([[200, 330], [500, 330]], 1.5);
          out.held = (await T.hold(line, { id: 83 })).shape;
          await T.pen(0, T.hand([[500, 330], [520, 420], [470, 470]], 0).slice(1), { id: 83, up: false });
          await T.frame();
          out.after = view.input.previewShape;
          out.path = view.input.livePath.length > 0;
          T.penUp(0, [470, 470], 83);
          await T.frame();
          out.moved = { kind: view.input.lastShape, n: T.lastStroke(0).points.length, label: T.labels()[1] };
          // The ruler: a ruled stroke is never straightened.
          view.toggleRuler();
          view.setRulerCentre(408, 528);
          view.setRulerAngle(0);
          await T.frame();
          const pts = [];
          for (let j = 0; j <= 30; j++) pts.push(T.onRuler(-100 + 5 * j, 36 + 3 / (T.pages()[0].getBoundingClientRect().width / 816)));
          pts.push(pts[30]);
          let ruledHold = 'unset';
          await T.penAt(pts, { id: 84, between: async j => { if (j === 31) { await T.sleep(700); ruledHold = view.input.previewShape; } } });
          out.ruler = { ruled: view.input.lastRuled, hold: ruledHold, kind: view.input.lastShape, label: T.labels()[1] };
          view.toggleRuler();
          await T.frame();
          // The highlighter.
          view.setTool('highlighter');
          const hl = T.rect(150, 800, 200, 120);
          out.hlHold = (await T.hold(hl, { id: 85 })).shape;
          T.penUp(0, hl[hl.length - 1], 85);
          await T.frame();
          const hs = T.lastStroke(0);
          out.hl = { kind: view.input.lastShape, tool: hs.tool, labels: T.labels() };
          view.setTool('pen');
          // Recognition off: the command toggles it.
          commands['toggle-shapes'].checkCallback(false);
          out.off = view.shapesOn;
          const r2 = T.rect(420, 800, 200, 120);
          out.offHold = (await T.hold(r2, { id: 86 })).shape;
          T.penUp(0, r2[r2.length - 1], 86);
          await T.frame();
          out.offKind = view.input.lastShape;
          out.offLabel = T.labels()[1];
          commands['toggle-shapes'].checkCallback(false);
          out.on = view.shapesOn;
          return out;
        }""")
        print('shapes: moved, ruler, highlighter, toggle:', r)
        check('shapes: moving on after the hold drops the shape and the stroke stays freehand, one "Add stroke"',
              r['held'] == 'line' and r['after'] is None and r['path'] and r['moved']['kind'] is None and r['moved']['label'] == 'Add stroke', r)
        check('shapes: a ruled stroke held still is not straightened', r['ruler']['ruled'] and r['ruler']['hold'] is None and r['ruler']['kind'] is None and r['ruler']['label'] == 'Add stroke', r)
        check('shapes: the highlighter straightens too (a highlighter rectangle)', r['hlHold'] == 'rectangle' and r['hl']['kind'] == 'rectangle' and r['hl']['tool'] == 'highlighter'
              and r['hl']['labels'] == ['Add stroke', 'Straighten'], r)
        check('shapes: "Toggle shape recognition" turns it off (a held rectangle stays freehand) and on again',
              r['off'] is False and r['offHold'] is None and r['offKind'] is None and r['offLabel'] == 'Add stroke' and r['on'] is True, r)
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'shapes_all.png'))

        r = ev("""async () => {
          await view.save();
          const path = view.store.slots[0].path, pg = ink.readPage(fs.get(path)), model = view.store.page(view.store.slots[0]);
          return { same: ink.writePage(model) === fs.get(path), n: pg.strokes.length, n1: model.strokes.length };
        }""")
        check('shapes: saved as ordinary strokes (the file reads back and writes identically)', r['same'] and r['n'] == r['n1'], r)
        # ======== end of 27. Shapes (#16) ========

        # ======== 28. Autosave on a dense page (#37) ========
        # A 1,000-stroke page: write one stroke, then record every frame until the autosave has
        # written the page. The save only outlines and encodes the new stroke (the rest are
        # cached from drawing the page), so it takes a few ms and no frame around it is long.
        r = ev("""async () => {
          const files = ink.largeNote('Dense', 'Page', 1, 1000);
          dirs.add('Dense'); dirs.add('Dense/Page');
          for (const [k, v] of Object.entries(files)) fs.set(k, v);
          await app.workspace.getLeaf(false).openFile(app.vault.getFile('Dense/Page.md'));
          await T.sleep(800);
          const path = view.store.slots[0].path, before = fs.get(path);
          // For comparison, an uncached write of the same page (fresh stroke objects).
          let t0 = performance.now();
          ink.writePage(ink.readPage(before));
          const coldMs = performance.now() - t0;
          const saves0 = view.stats.saves;
          await T.stroke(0, T.wave(100, 300));
          await T.sleep(300);  // the stroke is committed and drawn; the autosave is 2 s after it
          const frames = [];
          let last = performance.now(), savedAt = 0;
          t0 = last;
          while (performance.now() - t0 < 5000 && (!savedAt || performance.now() - savedAt < 300)) {
            await T.frame();
            const now = performance.now();
            frames.push([Math.round(now - t0), now - last]);
            last = now;
            if (!savedAt && view.stats.saves > saves0) savedAt = now;
          }
          const slow = frames.filter(f => f[1] > 32);
          const text = fs.get(path), pg = ink.readPage(text);
          return { strokes: pg.strokes.length, saved: view.stats.saves > saves0, saveMs: view.stats.saveMs, coldMs,
                   maxFrame: Math.max(...frames.map(f => f[1])), frames: frames.length, slow, savedAt: Math.round(savedAt - t0), same: ink.writePage(pg) === text };
        }""")
        print(f"dense page autosave (1,001 strokes): writePage {r['saveMs']:.1f} ms (uncached {r['coldMs']:.1f} ms), "
              f"longest frame {r['maxFrame']:.1f} ms over {r['frames']} frames; saved at {r['savedAt']} ms; slow [ms, frame] {r['slow']}")
        check('dense save: the autosave writes the page with the new stroke, byte-identical to a fresh write',
              r['saved'] and r['strokes'] == 1001 and r['same'], r)
        check('dense save: writePage after one new stroke on a 1,000-stroke page takes under 16 ms', r['saveMs'] < 16, r)
        check('dense save: no frame over 32 ms while the autosave runs', r['maxFrame'] <= 32, r)
        # ======== end of 28. Autosave on a dense page (#37) ========

        # ======== 29. The Pencil on every control (#53) and the Pages panel's buttons (#55) ========
        # On the iPad a Pencil tap sends pen pointer events and stylus touch events; WebKit clicks
        # (and focuses) the element only if the touchstart wasn't prevented, and scrolls or selects
        # only if the touchmoves weren't. T.pencilTap sends both, then clicks and focuses as WebKit
        # would when the touchstart went through. The stylus blockers now listen on the pages
        # scroller only; inside it, controls (the ruler's label and input, "Add page") are exempt.
        r = ev("""async () => {
          T.CONTROL = 'button, select, input, textarea, a, .nb-ink-control';
          /** A Pencil tap on el; returns [touchstart prevented, touchmove prevented]. */
          T.pencilTap = (el, { click = true } = {}) => {
            const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
            const pe = type => el.dispatchEvent(new PointerEvent(type, { pointerId: 91, pointerType: 'pen', isPrimary: true, pressure: type === 'pointerup' ? 0 : 0.3,
              clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
            pe('pointerdown');
            const start = T.touch(el, 'touchstart', 'stylus'), move = T.touch(el, 'touchmove', 'stylus');
            pe('pointerup');
            T.touch(el, 'touchend', 'stylus');
            if (!start && click) {
              if (el.matches('input, select, textarea')) el.focus();
              el.click();
            }
            return [start, move];
          };
          /** Stylus touchstart and touchmove on each element: the ones prevented, or not a control, as [text, why]. */
          T.audit = els => els.flatMap(el => {
            const name = el.className && typeof el.className === 'string' ? el.className.split(' ').filter(c => c !== 'nb-ink-control').join('.') : el.tagName.toLowerCase();
            const bad = [];
            if (T.touch(el, 'touchstart', 'stylus')) bad.push([name, 'touchstart prevented']);
            if (T.touch(el, 'touchmove', 'stylus')) bad.push([name, 'touchmove prevented']);
            if (!el.closest(T.CONTROL)) bad.push([name, 'not marked as a control']);
            return bad;
          });
          T.interactive = root => [...root.querySelectorAll('button, input, select, textarea, a, label, canvas.nb-ink-preview, .nb-pages-thumb, .suggestion-item')];
          T.strokeCount = () => view.store.slots.reduce((n, s) => n + view.store.page(s).strokes.length, 0);
          await p.createInkNote('Controls', '', 'letter', 'blank');
          await T.sleep(150);
          view.addPage();
          view.addPage();
          view.scrollToPage(0);
          view.setTool('pen');
          await T.sleep(100);
          await T.pen(0, Array.from({ length: 40 }, (_, j) => [120 + j * 5, 200 + 6 * Math.sin(j / 4), 0.3]), { predict: 0 });
          view.togglePagesPanel(true);
          if (!view.rulerOn) commands['toggle-ruler'].checkCallback(false);
          await T.sleep(300);
          return { pages: view.store.slots.length, open: view.pagesPanelOpen, ruler: view.rulerOn, strokes: T.strokeCount() };
        }""")
        check('controls setup: a 3-page note with a stroke, the Pages panel open, the ruler on', r == {'pages': 3, 'open': True, 'ruler': True, 'strokes': 1}, r)

        # (1) where the blockers listen: the scroller, not the view
        r = ev("""() => {
          const sc = T.sc(), pagesEl = view.contentEl.querySelector('.nb-ink-pages'), ghost = view.contentEl.querySelector('.nb-ink-ghost');
          const list = view.contentEl.querySelector('.nb-pages-list'), thumb = T.thumbs()[1];
          return {
            pencilOverPages: [T.pages()[0], ghost, pagesEl, sc].flatMap(el => [T.touch(el, 'touchstart', 'stylus'), T.touch(el, 'touchmove', 'stylus')]),
            fingerOverPages: [T.touch(T.pages()[0], 'touchmove', 'direct'), T.touch(sc, 'touchmove', 'direct'), T.touch(T.pages()[0], 'touchstart', 'direct')],
            pencilElsewhere: [view.contentEl, T.bar(), list, thumb, T.panel()].flatMap(el => [T.touch(el, 'touchstart', 'stylus'), T.touch(el, 'touchmove', 'stylus')]),
            fingerOnPanel: [T.touch(thumb, 'touchmove', 'direct'), T.touch(list, 'touchmove', 'direct')],
            listScrolls: getComputedStyle(list).touchAction,
          };
        }""")
        check('controls: a Pencil touchstart and touchmove over the pages (page, virtual page, gap, margin) are still prevented',
              r['pencilOverPages'] == [True] * 8, r['pencilOverPages'])
        check('controls: a finger touchmove over the pages is still prevented (the navigator pans), a finger touchstart is not',
              r['fingerOverPages'] == [True, True, False], r['fingerOverPages'])
        check('controls: outside the scroller (view, toolbar, Pages panel) the Pencil is never prevented: the blockers listen on the scroller only',
              r['pencilElsewhere'] == [False] * 10, r['pencilElsewhere'])
        check('controls: fingers and the Pencil scroll the Pages panel natively (touch-action pan-y, touchmove not prevented)',
              r['fingerOnPanel'] == [False, False] and r['listScrolls'] == 'pan-y', r)
        # ... and a drag that starts on a control area never reaches Obsidian (a listener on the document), though not prevented
        r = ev("""() => {
          let reached = 0;
          const count = () => reached++;
          document.addEventListener('touchmove', count);
          const menu = view.contentEl.querySelector('.nb-ink-selmenu'), picker = view.contentEl.querySelector('.nb-ink-picker');
          const cases = [[T.tb('.nb-ink-undo'), 'stylus'], [T.bar(), 'stylus'], [T.tb('.nb-ink-undo'), 'direct'], [T.thumbs()[1], 'stylus'],
            [T.thumbs()[1], 'direct'], [view.contentEl.querySelector('.nb-pages-list'), 'direct'], [menu, 'stylus'], [picker, 'direct']];
          const out = cases.map(([el, type]) => { const n = reached, prevented = T.touch(el, 'touchmove', type); return [prevented, reached - n]; });
          const start = T.touch(T.tb('.nb-ink-undo'), 'touchstart', 'stylus');
          document.removeEventListener('touchmove', count);
          return { out, start };
        }""")
        check('controls: a Pencil or finger touchmove on the toolbar, Pages panel, selection menu or picker is not prevented but never reaches the document (no sidebar swipe)',
              r['out'] == [[False, 0]] * 8 and r['start'] is False, r)

        # (2) the audit: every interactive element the view creates, in each state, takes the Pencil
        r = ev("""async () => {
          const out = {};
          const base = T.interactive(view.contentEl).filter(el => el.offsetParent !== null);
          out.base = { n: base.length, bad: T.audit(base),
            kinds: { toolbar: base.filter(el => T.bar().contains(el)).length, panel: base.filter(el => T.panel().contains(el)).length,
              footer: base.filter(el => el.closest('.nb-ink-footer')).length, ruler: base.filter(el => el.closest('.nb-ink-ruler-layer')).length } };
          const pickers = {};
          for (const [tool, open] of [['pen', 'pen'], ['highlighter', 'highlighter'], ['eraser', 'eraser'], ['lasso', 'lasso'], ['pen', 'page']]) {
            view.setTool(tool);
            if (open === 'page') T.tb('.nb-ink-page-settings').click(); else T.picker();
            const picker = view.contentEl.querySelector('.nb-ink-picker'), els = T.interactive(picker);
            pickers[open] = { n: els.length, bad: T.audit([picker, ...els]), kind: view.toolbar.pickerOpen };
            view.toolbar.closePicker();
          }
          out.pickers = pickers;
          // The selection menu: lasso the stroke on page 1.
          view.setTool('lasso');
          await T.lasso([90, 160, 400, 240]);
          await T.sleep(50);
          const menu = view.contentEl.querySelector('.nb-ink-selmenu');
          out.selmenu = { shown: menu.style.display !== 'none', inScroller: T.sc().contains(menu), n: T.interactive(menu).length, bad: T.audit([menu, ...T.interactive(menu)]) };
          // The ruler's label, and its input once the label is tapped.
          view.setTool('pen');
          const label = view.contentEl.querySelector('.nb-ink-ruler-angle');
          const n0 = T.strokeCount();
          const tap = T.pencilTap(label);
          await T.sleep(20);
          const input = view.contentEl.querySelector('.nb-ink-ruler-input');
          out.ruler = { tap, input: !!input, focused: !!input && document.activeElement === input, inScroller: T.sc().contains(label),
            bad: T.audit([label, ...(input ? [input] : [])]), strokes: T.strokeCount() - n0 };
          if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return out;
        }""")
        print('controls audit:', {'base': r['base']['n'], 'kinds': r['base']['kinds'], 'pickers': {k: v['n'] for k, v in r['pickers'].items()}, 'selmenu': r['selmenu']['n']})
        check('controls audit: toolbar, preset slots, Pages panel thumbnails and buttons, footer and ruler label: Pencil never prevented, all marked',
              r['base']['n'] >= 24 and r['base']['bad'] == [] and r['base']['kinds']['toolbar'] == 15 and r['base']['kinds']['panel'] >= 6
              and r['base']['kinds']['footer'] == 2 and r['base']['kinds']['ruler'] == 1, r['base'])
        check('controls audit: every picker (pen with the ruler row, highlighter, eraser, lasso, page settings): Pencil never prevented, all marked',
              all(v['bad'] == [] and v['n'] >= 1 and v['kind'] == k for k, v in r['pickers'].items()) and r['pickers']['pen']['n'] >= 20, r['pickers'])
        check('controls audit: the selection menu (outside the scroller): Pencil never prevented, all marked',
              r['selmenu']['shown'] and not r['selmenu']['inScroller'] and r['selmenu']['n'] >= 12 and r['selmenu']['bad'] == [], r['selmenu'])
        check('controls audit: the ruler label (inside the scroller) opens its input on a Pencil tap and the input takes focus; no stroke',
              r['ruler']['tap'] == [False, False] and r['ruler']['input'] and r['ruler']['focused'] and r['ruler']['inScroller']
              and r['ruler']['bad'] == [] and r['ruler']['strokes'] == 0, r['ruler'])

        # (3) Pencil taps do what a finger's do: toolbar, pickers, selection menu, footer, Pages panel
        r = ev("""async () => {
          const out = {}, taps = [];
          const tap = el => { const t = T.pencilTap(el); taps.push(t[0] || t[1]); return t; };
          view.toolbar.closePicker();
          view.setTool('pen');
          tap(T.tool('highlighter'));
          out.tool = view.pen.tool;
          tap(T.tool('highlighter'));
          out.picker = view.toolbar.pickerOpen;
          const picker = view.contentEl.querySelector('.nb-ink-picker');
          const size0 = view.highlighter.size;
          tap(picker.querySelector('.nb-ink-hl-swatch[data-color]:not(.is-active)'));
          out.hlColor = view.highlighter.color !== undefined && picker.querySelector('.nb-ink-hl-swatch.is-active') !== null;
          tap(picker.querySelector('.nb-ink-step[data-step="1"]'));
          out.stepped = view.highlighter.size > size0;
          tap(T.tool('pen'));
          tap(T.tool('pen'));
          const pp = view.contentEl.querySelector('.nb-ink-picker');
          tap(pp.querySelector('[data-nib="pressure"]'));
          out.nib = view.pen.nib;
          tap(pp.querySelector('[data-color="#e0301e"]'));
          out.color = view.pen.color;
          const angle = pp.querySelector('.nb-ink-ruler-angle-input');
          tap(angle);
          out.angleFocused = document.activeElement === angle;
          tap(pp.querySelector('.nb-ink-custom-color'));
          out.customFocused = document.activeElement === pp.querySelector('.nb-ink-custom-color');
          view.toolbar.closePicker();
          view.setPen({ nib: 'uniform', color: '#000000' });
          // A preset slot: tap saves the pen into an empty slot or applies a saved one.
          const presets0 = JSON.stringify(view.presets ?? null);
          tap(T.slot(4));
          out.slot = T.slot(4).classList.contains('is-active') || JSON.stringify(view.presets ?? null) !== presets0;
          // Selection menu: recolour, from the Pencil.
          view.setTool('lasso');
          await T.lasso([90, 160, 400, 240]);
          await T.sleep(50);
          const menu = view.contentEl.querySelector('.nb-ink-selmenu');
          out.menuOpen = menu.style.display !== 'none';
          tap(menu.querySelector('.nb-ink-swatch[data-color="#1f9d55"]'));
          out.recoloured = view.store.page(view.store.slots[0]).strokes[0].color;
          view.clearSelection();
          view.setTool('pen');
          // Footer: "Add page".
          const n0 = view.store.slots.length, s0 = T.strokeCount();
          const add = view.contentEl.querySelector('.nb-ink-add');
          add.scrollIntoView();
          await T.sleep(50);
          tap(add);
          out.added = view.store.slots.length - n0;
          out.noStroke = T.strokeCount() === s0;
          view.undo();
          await T.sleep(50);
          // Undo/redo from the toolbar.
          out.undoEnabled = !T.tb('.nb-ink-undo').disabled;
          view.scrollToPage(0);
          await T.sleep(150);
          out.taps = taps;
          return out;
        }""")
        check('controls: Pencil taps switch tools, open the picker and set colour, size, nib, the ruler angle field and the custom colour',
              r['tool'] == 'highlighter' and r['picker'] == 'highlighter' and r['hlColor'] and r['stepped'] and r['nib'] == 'pressure'
              and r['color'] == '#e0301e' and r['angleFocused'] and r['customFocused'], r)
        check('controls: a Pencil tap on a favourite slot saves or applies it', r['slot'], r)
        check('controls: a Pencil tap on the selection menu recolours the selection', r['menuOpen'] and r['recoloured'] == '#1f9d55', r)
        check('controls: a Pencil tap on "Add page" (inside the scroller) adds a page and draws nothing', r['added'] == 1 and r['noStroke'], r)
        check('controls: none of those Pencil touches was prevented', r['taps'] and not any(r['taps']), r['taps'])

        # (4) the Pages panel with the Pencil: tap a thumbnail, the icon buttons, a long press and drag
        r = ev("""async () => {
          const out = {};
          const cur = () => T.thumbs().findIndex(t => t.classList.contains('is-current'));
          const s0 = T.strokeCount();
          out.thumbTap = T.pencilTap(T.thumbs()[1].querySelector('.nb-pages-frame'));
          await T.sleep(150);
          out.afterTap = [cur(), view.currentPageIndex(), T.strokeCount() - s0];
          const btn = what => view.contentEl.querySelector('.nb-pages-thumb.is-current .nb-pages-' + what);
          out.icons = [...T.thumbs()[cur()].querySelectorAll('.nb-pages-action')].map(b => b.getAttribute('data-icon'));
          out.buttons = [...T.thumbs()[cur()].querySelectorAll('.nb-pages-action')].map(b => [b.dataset.action, b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-icon') && !!b.querySelector('svg'),
            [...b.childNodes].filter(c => c.nodeType === 3).map(c => c.textContent).join('').trim()]);
          const ids = view.store.index.pages.slice();
          // Move down: page 2 becomes page 3 and stays current, so its buttons follow it.
          const labels0 = view.history.labels.length;
          out.down = T.pencilTap(btn('down'));
          await T.sleep(150);
          out.afterDown = { order: view.store.index.pages.slice(), cur: cur(), view: view.currentPageIndex(), currentId: T.thumbs()[cur()].dataset.page,
            steps: view.history.labels.length - labels0, label: view.history.labels.slice(-1)[0] };
          out.downDisabled = btn('down').disabled;
          out.up = T.pencilTap(btn('up'));
          await T.sleep(150);
          out.afterUp = { order: view.store.index.pages.slice(), cur: cur() };
          view.undo();
          await T.sleep(100);
          out.undone = view.store.index.pages.slice();
          view.undo();
          await T.sleep(100);
          out.undone2 = view.store.index.pages.slice();
          view.scrollToPage(0);
          await T.sleep(150);
          out.firstUpDisabled = btn('up').disabled;
          out.firstDownDisabled = btn('down').disabled;
          // Insert, duplicate, delete with the Pencil; each undone.
          const n0 = view.store.slots.length;
          T.pencilTap(btn('insert')); await T.sleep(100);
          out.inserted = view.store.slots.length - n0; view.undo(); await T.sleep(100);
          view.scrollToPage(0); await T.sleep(150);
          T.pencilTap(btn('duplicate')); await T.sleep(100);
          out.duplicated = view.store.slots.length - n0; view.undo(); await T.sleep(100);
          view.scrollToPage(0); await T.sleep(150);
          T.pencilTap(btn('delete')); await T.sleep(100);
          out.deleted = n0 - view.store.slots.length; view.undo(); await T.sleep(100);
          out.back = view.store.index.pages.slice();
          out.ids = ids;
          // A Pencil long press picks thumbnail 1 up; its touchmoves are then prevented (no scroll); a drag reorders.
          view.scrollToPage(0); await T.sleep(150);
          const list = view.contentEl.querySelector('.nb-pages-list'), frame = T.thumbs()[0].querySelector('.nb-pages-frame');
          T.onThumb('pointerdown', 0, { pointerType: 'pen', id: 92 });
          out.beforeLift = T.touch(frame, 'touchmove', 'stylus');
          await T.sleep(450);
          out.lifted = T.thumbs()[0].classList.contains('is-lifted');
          out.afterLift = T.touch(frame, 'touchmove', 'stylus');
          const r1 = T.thumbs()[1].getBoundingClientRect(), r2 = T.thumbs()[2].getBoundingClientRect(), f0 = frame.getBoundingClientRect();
          const dy = (r1.top + r1.height / 2 + r2.top + r2.height / 2) / 2 - (f0.top + f0.height / 2);
          for (const d of [10, dy / 2, dy]) { T.onThumb('pointermove', 0, { pointerType: 'pen', id: 92, dy: d, target: list }); await T.sleep(16); }
          T.onThumb('pointerup', 0, { pointerType: 'pen', id: 92, dy, target: list });
          await T.sleep(100);
          out.dragged = view.store.index.pages.slice();
          view.undo();
          await T.sleep(100);
          out.dragUndone = view.store.index.pages.slice();
          // A finger long press still works too.
          T.onThumb('pointerdown', 0, { pointerType: 'touch', id: 93 });
          await T.sleep(450);
          out.fingerLifted = T.thumbs()[0].classList.contains('is-lifted');
          out.fingerAfterLift = T.touch(frame, 'touchmove', 'direct');
          T.onThumb('pointerup', 0, { pointerType: 'touch', id: 93 });
          out.strokes = T.strokeCount() - s0;
          return out;
        }""")
        ids = r['ids']
        check('pages panel: a Pencil tap on a thumbnail goes to its page (touchstart not prevented, no stroke)',
              r['thumbTap'] == [False, False] and r['afterTap'] == [1, 1, 0], r)
        check('pages panel: five icon buttons with labels and tooltips: plus, copy, trash, arrow-up, arrow-down, no text',
              r['buttons'] == [['insert', 'Insert page after', 'Insert page after', True, ''], ['duplicate', 'Duplicate page', 'Duplicate page', True, ''],
                               ['delete', 'Delete page', 'Delete page', True, ''], ['up', 'Move page up', 'Move page up', True, ''],
                               ['down', 'Move page down', 'Move page down', True, '']]
              and r['icons'] == ['plus', 'copy', 'trash', 'arrow-up', 'arrow-down'], r['buttons'])
        check('pages panel: "Move down" moves the page one place, one undo step, and it stays the current page',
              r['down'] == [False, False] and r['afterDown']['order'] == [ids[0], ids[2], ids[1]] and r['afterDown']['cur'] == 2
              and r['afterDown']['view'] == 2 and r['afterDown']['currentId'] == ids[1] and r['afterDown']['steps'] == 1 and r['afterDown']['label'] == 'Move page', r)
        check('pages panel: on the last page "Move down" is disabled; "Move up" moves it back', r['downDisabled'] and r['afterUp'] == {'order': ids, 'cur': 1}, r)
        check('pages panel: undo undoes each move', r['undone'] == [ids[0], ids[2], ids[1]] and r['undone2'] == ids, r)
        check('pages panel: on the first page "Move up" is disabled, "Move down" is not', r['firstUpDisabled'] and not r['firstDownDisabled'], r)
        check('pages panel: Pencil taps on insert, duplicate and delete work (each undone)',
              r['inserted'] == 1 and r['duplicated'] == 1 and r['deleted'] == 1 and r['back'] == ids, r)
        check('pages panel: a Pencil long press picks a thumbnail up; its touchmoves are prevented only once lifted (before, the panel scrolls)',
              r['lifted'] and r['beforeLift'] is False and r['afterLift'] is True, r)
        check('pages panel: a Pencil drag reorders (page 1 between pages 2 and 3); undo restores', r['dragged'] == [ids[1], ids[0], ids[2]] and r['dragUndone'] == ids, r)
        check('pages panel: a finger long press still lifts, and then blocks the scroll', r['fingerLifted'] and r['fingerAfterLift'] is True, r)
        check('pages panel: no Pencil tap or drag on the panel drew a stroke', r['strokes'] == 0, r)

        # (5) a stroke in progress: the window blocker stops stylus touchmoves anywhere, until the pen lifts
        r = ev("""async () => {
          const s0 = T.strokeCount();
          await T.pen(0, Array.from({ length: 20 }, (_, j) => [120 + j * 5, 500, 0.3]), { up: false, predict: 0 });
          const during = [T.touch(document.body, 'touchmove', 'stylus'), T.touch(T.pages()[0], 'touchmove', 'stylus')];
          T.penUp(0, [215, 500]);
          await T.sleep(30);
          const after = T.touch(document.body, 'touchmove', 'stylus');
          const n = T.strokeCount() - s0;
          view.undo();
          return { during, after, n };
        }""")
        check('controls: during a stroke a stylus touchmove anywhere in the window is prevented; after it, not', r['during'] == [True, True] and r['after'] is False and r['n'] == 1, r)

        # (6) the plugin's dialogs and the settings tab: Pencil taps focus fields, open dropdowns, choose rows
        r = ev("""async () => {
          const out = {};
          const modal = () => modals[modals.length - 1];
          const fields = m => [...m.modalEl.querySelectorAll('input, select, textarea, button, .suggestion-item')];
          const focusTest = els => els.filter(el => el.matches('input, select')).map(el => { document.body.focus(); T.pencilTap(el, { click: false }); el.focus(); return document.activeElement === el; });
          // New ink note: name, paper, template, Create.
          commands['new-ink-note'].callback();
          await T.sleep(20);
          let m = modal(), els = fields(m);
          out.newNote = { n: els.length, selects: els.filter(e => e.tagName === 'SELECT').length, bad: T.audit(els).filter(b => b[1] !== 'not marked as a control'), focus: focusTest(els) };
          m.close();
          // Template chooser (Add page with template…) from the page settings menu, with the Pencil; then Custom size.
          view.scrollToPage(0);
          await T.sleep(100);
          T.pencilTap(T.tb('.nb-ink-page-settings'));
          const item = view.contentEl.querySelector('.nb-ink-menu-add-with');
          T.pencilTap(item);
          await T.sleep(20);
          m = modal();
          const rows = [...m.contentEl.querySelectorAll('.suggestion-item')];
          out.chooser = { rows: rows.length, bad: T.audit(rows).filter(b => b[1] !== 'not marked as a control') };
          rows.find(e => /custom size/i.test(e.textContent)).click();
          await T.sleep(20);
          m = modal();
          els = fields(m);
          out.size = { title: m.titleEl.textContent, n: els.length, bad: T.audit(els).filter(b => b[1] !== 'not marked as a control'), focus: focusTest(els) };
          m.close();
          // A Pencil tap on a chooser row picks it.
          const n0 = view.store.slots.length;
          view.chooseTemplate('add');
          await T.sleep(20);
          const blank = [...modal().contentEl.querySelectorAll('.suggestion-item')][0];
          out.rowTap = T.pencilTap(blank);
          await T.sleep(150);
          out.rowAdded = view.store.slots.length - n0;
          if (out.rowAdded) view.undo();
          // PDF import: the source chooser's rows and the name dialog.
          fs.set('Audit/a.pdf', new Uint8Array(fakePdf([[612, 792]])));
          dirs.add('Audit');
          commands['import-pdf'].callback();
          await T.sleep(20);
          m = modal();
          const src = [...m.contentEl.querySelectorAll('.suggestion-item')];
          out.pdfRows = { n: src.length, bad: T.audit(src).filter(b => b[1] !== 'not marked as a control') };
          T.pencilTap(src.find(e => e.textContent === 'Audit/a.pdf'));
          await T.waitFor(() => modals.length && modal().titleEl.textContent === 'Import PDF as ink note');
          m = modal();
          els = fields(m);
          out.pdfName = { n: els.length, bad: T.audit(els).filter(b => b[1] !== 'not marked as a control'), focus: focusTest(els) };
          m.close();
          fs.delete('Audit/a.pdf');
          // The settings tab.
          const tab = p.settingTabs[0];
          tab.display();
          document.body.appendChild(tab.containerEl);
          els = [...tab.containerEl.querySelectorAll('input, select, textarea, button')];
          out.settings = { n: els.length, bad: T.audit(els).filter(b => b[1] !== 'not marked as a control'), focus: focusTest(els) };
          tab.containerEl.remove();
          out.modals = modals.length;
          return out;
        }""")
        print('dialogs:', {k: (v['n'] if isinstance(v, dict) and 'n' in v else v) for k, v in r.items()})
        check('dialogs: New ink note: the name field, the paper and template dropdowns and Create take Pencil taps; the fields focus',
              r['newNote']['n'] >= 4 and r['newNote']['selects'] >= 2 and r['newNote']['bad'] == [] and all(r['newNote']['focus']), r['newNote'])
        check('dialogs: the template chooser, opened from the page settings menu with the Pencil, lists rows that take Pencil taps',
              r['chooser']['rows'] >= 5 and r['chooser']['bad'] == [], r['chooser'])
        check('dialogs: Custom page size: width, height, unit and OK take Pencil taps; the fields focus',
              r['size']['title'] == 'Custom page size' and r['size']['n'] >= 4 and r['size']['bad'] == [] and all(r['size']['focus']), r['size'])
        check('dialogs: a Pencil tap on a chooser row picks it (a page is added)', r['rowTap'] == [False, False] and r['rowAdded'] == 1, r)
        check('dialogs: PDF import: the source rows and the name dialog take Pencil taps; the name field focuses',
              r['pdfRows']['n'] >= 2 and r['pdfRows']['bad'] == [] and r['pdfName']['n'] >= 2 and r['pdfName']['bad'] == [] and all(r['pdfName']['focus']), r)
        check("dialogs: the settings tab's dropdowns take Pencil taps and focus", r['settings']['n'] >= 2 and r['settings']['bad'] == [] and all(r['settings']['focus']), r['settings'])
        check('dialogs: all closed', r['modals'] == 0, r['modals'])

        # (7) #55: the panel's buttons fit, at iPad widths with a mobile font and Obsidian's mobile button padding,
        # with enough pages that the panel scrolls (a desktop scrollbar takes room in Chromium)
        ev("""async () => {
          for (let i = 0; i < 5; i++) view.addPage();
          await T.sleep(100);
          const s = document.createElement('style');
          s.id = 'nb-mobile';
          // Obsidian's mobile look, roughly: bigger UI font and roomy text buttons.
          s.textContent = `html { font-size: 20px; } body.is-mobile { --font-ui-smaller: 16px; --font-ui-small: 18px; font-size: 20px; }
            body.is-mobile button:not(.clickable-icon) { font-size: 18px; padding: 6px 18px; height: 44px; min-width: 44px; }`;
          document.head.appendChild(s);
          document.body.classList.add('is-mobile');
        }""")
        fits = {}
        for name, w, h in (('portrait', 768, 1024), ('landscape', 1024, 768)):
            page.set_viewport_size({'width': w, 'height': h})
            ev(f"() => {{ const s = document.getElementById('leaf').style; s.width = '{w}px'; s.height = '{h - 120}px'; s.boxSizing = 'border-box'; }}")
            page.wait_for_timeout(300)
            fits[name] = ev("""async () => {
              view.scrollToPage(1);
              await T.sleep(200);
              const panel = T.panel(), list = panel.querySelector('.nb-pages-list'), pr = panel.getBoundingClientRect(), lr = list.getBoundingClientRect();
              const thumb = panel.querySelector('.nb-pages-thumb.is-current'), actions = thumb.querySelector('.nb-pages-actions');
              const buttons = [...actions.querySelectorAll('.nb-pages-action')];
              const boxes = buttons.map(b => b.getBoundingClientRect());
              // Inside the panel and left of the list's scrollbar (its client area), and on top where they are.
              const right = lr.left + list.clientLeft + list.clientWidth;
              const inside = boxes.every(q => q.left >= pr.left - 0.5 && q.right <= Math.min(pr.right, right) + 0.5);
              const onTop = boxes.every((q, i) => document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2)?.closest('.nb-pages-action') === buttons[i]);
              return { scrolls: list.scrollHeight > list.clientHeight, panelW: Math.round(pr.width), margin: getComputedStyle(T.sc()).marginLeft, count: buttons.length, inside, onTop,
                sizes: boxes.map(q => [Math.round(q.width), Math.round(q.height)]), rows: new Set(boxes.map(q => Math.round(q.top))).size,
                listScroll: [list.scrollWidth, list.clientWidth], actionsScroll: [actions.scrollWidth, actions.clientWidth],
                fontPx: getComputedStyle(document.documentElement).fontSize, pageLeft: Math.round(T.pages()[0].getBoundingClientRect().left - pr.right) };
            }""")
            page.locator('.nb-pages-panel').screenshot(path=os.path.join(OUT, f'pages_panel_{name}.png'))
            page.locator('#leaf').screenshot(path=os.path.join(OUT, f'pages_panel_{name}_view.png'))
        ev("() => { document.getElementById('nb-mobile').remove(); document.body.classList.remove('is-mobile'); }")
        page.set_viewport_size({'width': 1000, 'height': 700})
        ev("() => { const s = document.getElementById('leaf').style; s.width = s.height = s.boxSizing = ''; }")
        page.wait_for_timeout(200)
        print('pages panel fits:', fits)
        for name in ('portrait', 'landscape'):
            f = fits[name]
            check(f'pages panel: at the iPad {name} width with a 20 px mobile font, all five buttons lie inside the panel, uncovered, in at most two rows; nothing scrolls sideways',
                  f['count'] == 5 and f['inside'] and f['onTop'] and f['rows'] <= 2 and f['fontPx'] == '20px' and f['scrolls']
                  and f['listScroll'][0] <= f['listScroll'][1] and f['actionsScroll'][0] <= f['actionsScroll'][1], f)
            check(f'pages panel: ({name}) each button is at least 36 px square; the panel is about 172 px and the pages area starts beside it',
                  all(w >= 36 and h >= 36 for w, h in f['sizes']) and 160 <= f['panelW'] <= 180 and f['margin'] == f"{f['panelW']}px" and f['pageLeft'] >= 0, f)
        ev("async () => { for (let i = 0; i < 5; i++) view.undo(); view.togglePagesPanel(false); if (view.rulerOn) commands['toggle-ruler'].checkCallback(false); await T.sleep(50); }")
        # ======== end of 29. The Pencil on every control (#53) and the Pages panel's buttons (#55) ========

        # ======== 30. The pen at zoom and across a pointercancel (#52) ========
        # Viewport bitmaps: past iOS's 16M-pixel canvas limit (a Letter page from about 200% at
        # device pixel ratio 2) a page's bitmap and the pen's overlays cover a band around the
        # viewport at full device resolution instead of the whole page at a lowered one. The
        # comparisons are made on screenshots (device pixels, what the owner sees): the committed
        # ink against an ideal rendering of the same outline at the screen's resolution, the live
        # stroke against the committed one, and the live stroke along its centre line. Then a
        # pointercancel mid-stroke followed by a pointerdown of the pen near where it left off.
        import base64 as b64mod

        def shot(clip):
            """A screenshot of `clip` (client CSS px) as a base64 PNG, in device pixels."""
            return b64mod.b64encode(page.screenshot(clip=clip)).decode()

        def save_shot(name, data):
            with open(os.path.join(OUT, name), 'wb') as f:
                f.write(b64mod.b64decode(data))

        ev("""async () => {
          T.sc = () => view.contentEl.querySelector('.nb-ink-scroll');
          T.frame = () => new Promise(r => requestAnimationFrame(r));
          /** Puts page point (x, y) of page i at the middle of the view at zoom z, and lets the bitmaps settle. */
          T.z52at = async (z, i, x, y, wait = 500) => {
            if (view.zoom !== z) view.setZoom(z);
            const sc = T.sc(), el = T.pages()[i], k = el.offsetWidth / view.store.slots[i].size.width;
            sc.scrollLeft = Math.round(el.offsetLeft + x * k - sc.clientWidth / 2);
            sc.scrollTop = Math.round(el.offsetTop + y * k - sc.clientHeight / 2);
            await T.sleep(wait);
          };
          /** Client point of page point (x, y) of page i, in the Pencil's 0.5 CSS px steps. */
          T.z52client = (i, x, y) => {
            const r = T.pages()[i].getBoundingClientRect(), k = r.width / view.store.slots[i].size.width;
            return [Math.round((r.left + x * k) * 2) / 2, Math.round((r.top + y * k) * 2) / 2];
          };
          /** Pen events through client points (4 coalesced samples per move, a frame after each); `up` false leaves it in progress. */
          T.z52pen = async (pts, { id = 91, type = 'pen', up = true } = {}) => {
            const el = document.elementFromPoint(pts[0][0], pts[0][1]);
            const init = ([x, y], b = 1) => ({ pointerId: id, pointerType: type, pressure: 0.2, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: b });
            el.dispatchEvent(new PointerEvent('pointerdown', init(pts[0])));
            for (let j = 1; j < pts.length; j += 4) {
              const group = pts.slice(j, j + 4);
              el.dispatchEvent(new PointerEvent('pointermove', { ...init(group[group.length - 1]), coalescedEvents: group.map(q => new PointerEvent('pointermove', init(q))) }));
              await T.frame();
            }
            if (up) el.dispatchEvent(new PointerEvent('pointerup', init(pts[pts.length - 1], 0)));
            await T.frame();
          };
          /** Lifts the pen of T.z52pen (id 91) at the last of T.z52pts. */
          T.z52up = async () => {
            const q = T.z52pts[T.z52pts.length - 1];
            T.pages()[1].dispatchEvent(new PointerEvent('pointerup', { pointerId: 91, pointerType: 'pen', clientX: q[0], clientY: q[1], bubbles: true, cancelable: true, button: 0, buttons: 0 }));
            await T.frame();
            await T.frame();
          };
          /** Decodes a base64 PNG into ImageData. */
          T.z52img = async b64 => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + b64;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0);
            return g.getImageData(0, 0, c.width, c.height);
          };
          /**
           * Compares a screenshot of `clip` with the outline `d` (page px of page i) filled in the
           * default ink on white at the screen's resolution: `err` is the summed grey difference
           * over the ideal's ink (0: identical); `soft` the partially covered pixels per inked
           * column (about 2 for a crisp stroke, one per edge; more when an upscaled bitmap blurs it).
           */
          T.z52ideal = async (b64, clip, i, d) => {
            const a = await T.z52img(b64), W = a.width, H = a.height, R = W / clip.width;
            const r = T.pages()[i].getBoundingClientRect(), k = r.width / view.store.slots[i].size.width;
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const g = c.getContext('2d');
            g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
            g.setTransform(R * k, 0, 0, R * k, R * (r.left - clip.x), R * (r.top - clip.y));
            g.fillStyle = '#1f1f1f';
            g.fill(new Path2D(d));
            const b = g.getImageData(0, 0, W, H);
            let diff = 0, ink = 0, partial = 0, cols = 0;
            for (let x = 0; x < W; x++) {
              let any = false;
              for (let y = 0; y < H; y++) {
                const q = (y * W + x) * 4, v = a.data[q], w = b.data[q];
                diff += Math.abs(v - w); ink += 255 - w;
                if (v > 40 && v < 215) partial++;
                if (v < 128) any = true;
              }
              if (any) cols++;
            }
            return { err: diff / Math.max(1, ink), soft: partial / Math.max(1, cols), px: [W, H] };
          };
          /** Pixels that differ clearly (over 64 grey levels) between two screenshots of the same clip; `ink` counts the second's ink. */
          T.z52diff = async (b64a, b64b) => {
            const a = await T.z52img(b64a), b = await T.z52img(b64b), W = a.width, H = a.height;
            let diff = 0, ink = 0, worst = 0;
            const cell = new Map();
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
              const q = (y * W + x) * 4;
              if (b.data[q] < 128) ink++;
              if (Math.abs(a.data[q] - b.data[q]) > 64) {
                diff++;
                const key = `${x >> 5},${y >> 5}`, n = (cell.get(key) || 0) + 1;
                cell.set(key, n);
                worst = Math.max(worst, n);
              }
            }
            return { diff, ink, frac: diff / Math.max(1, ink), worstCell: worst };
          };
          /** The screen rect (client CSS px, whole px) of page box [x0, y0, x1, y1] (page px) of page i, clipped to the view. */
          T.z52clip = (i, [x0, y0, x1, y1]) => {
            const r = T.pages()[i].getBoundingClientRect(), k = r.width / view.store.slots[i].size.width, v = T.sc().getBoundingClientRect();
            const a = Math.max(v.left, Math.floor(r.left + x0 * k)), b = Math.max(v.top, Math.floor(r.top + y0 * k));
            const c = Math.min(v.left + T.sc().clientWidth, Math.ceil(r.left + x1 * k)), d = Math.min(v.top + T.sc().clientHeight, Math.ceil(r.top + y1 * k));
            return { x: a, y: b, width: c - a, height: d - b };
          };
          /** The page bitmaps: page, device size, device px per CSS px, whether a band. */
          T.z52maps = () => view.pages.map((pv, i) => pv.bitmap && { i, w: pv.bitmap.canvas.width, h: pv.bitmap.canvas.height,
            ratio: pv.bitmap.canvas.width / pv.bitmap.canvas.getBoundingClientRect().width, band: pv.bitmap.canvas.classList.contains('nb-ink-band') }).filter(Boolean);
          /** Whether page i's bitmap covers the part of it the view shows. */
          T.z52covers = i => {
            const c = view.pages[i].bitmap?.canvas, sc = T.sc(), vr = sc.getBoundingClientRect(), pr = T.pages()[i].getBoundingClientRect();
            const vis = [Math.max(vr.left, pr.left), Math.max(vr.top, pr.top), Math.min(vr.left + sc.clientWidth, pr.right), Math.min(vr.top + sc.clientHeight, pr.bottom)];
            if (vis[3] <= vis[1] || vis[2] <= vis[0]) return true; // not visible
            const cr = c && c.getBoundingClientRect();
            return !!cr && cr.left <= vis[0] + 0.01 && cr.top <= vis[1] + 0.01 && cr.right >= vis[2] - 0.01 && cr.bottom >= vis[3] - 0.01;
          };
          await p.createInkNote('Zoom52', '', 'letter', 'blank');
          await T.sleep(150);
          view.addPage();
          await T.sleep(150);
        }""")

        # (1) viewport bitmaps: whole pages at 100%, bands at full device resolution at 400%
        r = ev("""async () => {
          await T.z52at(1, 0, 408, 300);
          const at1 = T.z52maps(), px1 = T.z52maps().reduce((n, m) => n + m.w * m.h, 0);
          await T.z52at(4, 0, 300, 300);
          const c = view.pages[0].bitmap.canvas;
          return { at1, px1, at4: T.z52maps(), px4: T.z52maps().reduce((n, m) => n + m.w * m.h, 0), stat: view.stats.bitmapPixels, covers: T.z52covers(0), dpr: devicePixelRatio,
                   ratio4: c.width / c.getBoundingClientRect().width, whole4: [T.pages()[0].offsetWidth, T.pages()[0].offsetHeight] };
        }""")
        print(f"viewport bitmaps: at 100% {r['at1']}; at 400% (page {r['whole4'][0]}x{r['whole4'][1]} CSS px) {r['at4']}, "
              f"{r['px4'] / 1e6:.1f}M device px ({r['px4'] * 4 / 1e6:.0f} MB) in bitmaps")
        check('viewport bitmaps: at 100% every page bitmap is the whole page (no band)', r['at1'] and all(not m['band'] for m in r['at1']), r['at1'])
        check('viewport bitmaps: at 400% the visible page has a band bitmap at full device resolution (device px per CSS px = 2) covering the visible part',
              r['ratio4'] == r['dpr'] == 2 and r['covers'] and any(m['band'] and m['i'] == 0 for m in r['at4']), r)
        check('viewport bitmaps: each within 16M pixels, and less in all than two whole capped pages (32M)',
              all(m['w'] * m['h'] <= 16_000_000 for m in r['at4']) and r['px4'] < 32_000_000, r)

        # (2) the committed ink at 400% against an ideal rendering at the screen's resolution, and the same at 100%
        r = ev("""async () => {
          await T.z52at(1, 0, 408, 300);
          const pts = [];
          for (let j = 0; j <= 400; j++) pts.push(T.z52client(0, 250 + 0.35 * j, 300 - 30 * Math.sin(Math.PI * j / 400) + 0.3 * Math.sin(j * 1.7)));
          const n = view.store.page(view.store.slots[0]).strokes.length;
          await T.z52pen(pts);
          const s = view.store.page(view.store.slots[0]).strokes;
          T.z52stroke = s[s.length - 1];
          return { added: s.length - n };
        }""")
        smooth = {}
        for z in (1, 4):
            ev(f"async () => {{ await T.z52at({z}, 0, 320, 285); }}")
            clip = ev("() => T.z52clip(0, [300, 262, 340, 305])")
            sb = shot(clip)
            smooth[z] = ev("async ([b, clip]) => T.z52ideal(b, clip, 0, ink.strokePath(T.z52stroke))", [sb, clip])
            save_shot(f'zoom52_committed_{z * 100}.png', sb)
        print(f"committed ink against an ideal rendering at the screen's resolution (grey error over the ink; partial pixels per column): "
              f"100% {smooth[1]['err']:.3f} / {smooth[1]['soft']:.2f}, 400% {smooth[4]['err']:.3f} / {smooth[4]['soft']:.2f}")
        check('zoom 400%: the committed ink is drawn at the screen resolution (grey error against the ideal under 0.05, as at 100%)',
              smooth[4]['err'] < 0.05 and smooth[1]['err'] < 0.05, smooth)
        check('zoom 400%: its edges are as crisp as at 100% (partial pixels per column within 0.5 of it)',
              smooth[4]['soft'] < smooth[1]['soft'] + 0.5, smooth)

        # (3) live against committed while writing at 100% and at 400%: screenshots mid-stroke and after the lift
        lvc = {}
        for z, y0 in ((1, 305), (4, 345)):
            ev(f"async () => {{ await T.z52at({z}, 1, 290, {y0 - 5}); }}")
            ev(f"""() => {{
              T.z52pts = [];
              // handwriting-like loops, 180 samples in the Pencil's 0.5 CSS px steps
              for (let j = 0; j < 180; j++) {{ const a = j / 14; T.z52pts.push(T.z52client(1, 262 + j * 0.28 - 7 * Math.sin(a), {y0} - 9 * (1 - Math.cos(a)))); }}
            }}""")
            ev("async () => { await T.z52pen(T.z52pts, { up: false }); await T.frame(); }")
            clip = ev(f"() => T.z52clip(1, [250, {y0 - 25}, 320, {y0 + 8}])")
            sa = shot(clip)
            ev("() => T.z52up()")
            sb = shot(clip)
            lvc[z] = ev("async ([a, b]) => T.z52diff(a, b)", [sa, sb])
            save_shot(f'zoom52_live_{z * 100}.png', sa)
            save_shot(f'zoom52_committed_loops_{z * 100}.png', sb)
        print(f"live against committed (pixels changing by over 64 grey levels at the lift, over the committed ink): "
              f"100% {lvc[1]['diff']} of {lvc[1]['ink']} ({100 * lvc[1]['frac']:.2f}%), 400% {lvc[4]['diff']} of {lvc[4]['ink']} ({100 * lvc[4]['frac']:.2f}%)")
        check('live vs committed: lifting the pen changes under 1% of the ink pixels at 100% and at 400% (the live stroke is drawn from the refit points)',
              lvc[1]['frac'] < 0.01 and lvc[4]['frac'] < 0.01, lvc)

        # (4) seams between the frozen head and the live tail at 400%: a long stroke (several frozen
        # pieces), mid-stroke, scanned along its centre line on the overlays, and against the committed stroke
        ev("async () => { await T.z52at(4, 1, 330, 500); }")
        ev("""() => {
          T.z52pts = [];
          for (let j = 0; j < 900; j++) { const a = j / 16; T.z52pts.push(T.z52client(1, 250 + j * 0.17 - 8 * Math.sin(a), 510 - 10 * (1 - Math.cos(a)))); }
        }""")
        r = ev("""async () => {
          await T.z52pen(T.z52pts, { up: false });
          await T.frame();
          const inp = view.input, live = inp.live;
          // the overlays' alpha (head over tail) at each drawn point, where the ink is solid
          const pts = inp.livePoints || live.trace.points;
          const read = c => c.getContext('2d').getImageData(0, 0, c.width, c.height);
          const head = read(inp.head), tail = read(inp.tail), hr = inp.head.getBoundingClientRect(), W = inp.head.width;
          const pr = T.pages()[1].getBoundingClientRect(), k = pr.width / view.store.slots[1].size.width, R = W / hr.width;
          let min = 255, gaps = 0, n = 0;
          for (const q of pts) {
            const x = Math.round((pr.left + q.x * k - hr.left) * R), y = Math.round((pr.top + q.y * k - hr.top) * R);
            if (x < 0 || y < 0 || x >= W || y >= inp.head.height) continue;
            const o = (y * W + x) * 4 + 3, a = 255 - (255 - head.data[o]) * (255 - tail.data[o]) / 255;
            n++; min = Math.min(min, a); if (a < 250) gaps++;
          }
          return { pieces: live.pieces, points: live.trace.points.length, n, min, gaps, ratio: R };
        }""")
        clip = ev("() => T.z52clip(1, [235, 490, 420, 525])")
        sa = shot(clip)
        ev("() => T.z52up()")
        sb = shot(clip)
        seam = ev("async ([a, b]) => T.z52diff(a, b)", [sa, sb])
        save_shot('zoom52_seam_live.png', sa)
        save_shot('zoom52_seam_committed.png', sb)
        print(f"long stroke at 400%: {r['points']} points, {r['pieces']} frozen pieces; overlays at {r['ratio']:.2f} device px per CSS px; "
              f"centre line alpha min {r['min']:.0f} over {r['n']} points ({r['gaps']} under 250); "
              f"live vs committed {seam['diff']} of {seam['ink']} px ({100 * seam['frac']:.2f}%), worst 32 px cell {seam['worstCell']}")
        check('seam: at 400% the live overlays are at full device resolution and the centre line is solid ink across the frozen pieces (no gap)',
              r['pieces'] >= 3 and r['ratio'] == 2 and r['n'] > 500 and r['gaps'] == 0, r)
        # Each frozen piece's outline is computed with context on both sides and clipped to the
        # piece, so its ends match the committed outline (1.6% of ink pixels differed before #52,
        # 0.8-1.4% with plain slices of the refit points, 0.1-0.7% now: what's left is where
        # perfect-freehand spaces a piece's outline points differently from the whole's); a gap or
        # a doubled band would be a cluster.
        check('seam: ... and the long live stroke matches the committed one (under 1% of ink pixels differ, no cluster over 64 px)',
              seam['frac'] < 0.01 and seam['worstCell'] <= 64, seam)
        r = ev("""async () => {
          view.setTool('highlighter');
          T.z52pts = T.z52pts.map(([x, y]) => [x, y + 120]);
          await T.z52pen(T.z52pts, { up: false });
          await T.frame();
          const inp = view.input, live = inp.live, c = inp.tail, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const cr = c.getBoundingClientRect(), R = c.width / cr.width;
          let min = 255, max = 0, n = 0;
          const odd = [];
          for (const [j, [x0, y0]] of T.z52pts.entries()) {
            if (j < 3 || j > T.z52pts.length - 4) continue; // the flat ends: half covered at their very edge
            const x = Math.round((x0 - cr.left) * R), y = Math.round((y0 - cr.top) * R);
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
            const a = d[(y * c.width + x) * 4 + 3];
            if (a !== 102 && odd.length < 10) odd.push([j, a]);
            min = Math.min(min, a); max = Math.max(max, a); n++;
          }
          const pieces = live.pieces;
          await T.z52up();
          view.setTool('pen');
          return { min, max, n, pieces, ratio: R, odd };
        }""")
        print('long highlighter stroke at 400%, tail overlay alpha along the centre:', r)
        check('seam: a long highlighter stroke at 400% is composited once: the same alpha (102) along its centre, across the frozen pieces',
              r['pieces'] >= 3 and r['min'] == r['max'] == 102 and r['n'] > 500, r)

        # (5) a pointercancel mid-stroke: the pen coming back near where it left within 300 ms continues the stroke
        r = ev("""async () => {
          await T.z52at(1, 0, 408, 600);
          const strokes = () => view.store.page(view.store.slots[0]).strokes;
          const fire = (el, type, id, [x, y], b = 1) => { const e = new PointerEvent(type, { pointerId: id, pointerType: 'pen', pressure: 0.2, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: b }); el.dispatchEvent(e); return e; };
          const line = (y, x0, x1) => Array.from({ length: 40 }, (_, j) => T.z52client(0, x0 + (x1 - x0) * j / 39, y));
          const out = {}, st = view.stats.pen, c0 = st.cancels || 0, j0 = st.joined || 0, n0 = strokes().length;
          // (a) cancel, then the pen down 6 px from the last sample 100 ms later, outside the view (the body)
          let a = line(600, 200, 400), b = line(600, 402, 600);
          await T.z52pen(a, { id: 31, up: false });
          fire(T.pages()[0], 'pointercancel', 31, a[a.length - 1], 0);
          const suspended = view.input.suspended, drawing = view.input.drawing, liveThen = T.liveInk();
          await T.sleep(100);
          const down = fire(document.body, 'pointerdown', 32, [a[a.length - 1][0] + 6, a[a.length - 1][1]]);
          for (const q of b) { fire(document.body, 'pointermove', 32, q); await T.frame(); }
          fire(document.body, 'pointerup', 32, b[b.length - 1], 0);
          await T.frame();
          const s = strokes();
          out.joined = { added: s.length - n0, suspended, drawing, liveThen: liveThen > 500, taken: down.defaultPrevented,
            xs: [s[s.length - 1].points[0].x, Math.max(...s[s.length - 1].points.map(q => q.x))], points: s[s.length - 1].points.length,
            cancels: (st.cancels || 0) - c0, continued: (st.joined || 0) - j0, labels: view.history.labels.slice(-1), live: T.liveInk() };
          // (b) cancel, then nothing for 400 ms: the stroke ends as it was; a later pen down is a new stroke
          const n1 = strokes().length, cancelled = st.cancelled;
          a = line(650, 200, 400);
          await T.z52pen(a, { id: 33, up: false });
          fire(T.pages()[0], 'pointercancel', 33, a[a.length - 1], 0);
          await T.sleep(400);
          const afterGrace = { added: strokes().length - n1, cancelled: st.cancelled - cancelled, suspended: view.input.suspended, live: T.liveInk() };
          await T.z52pen(line(650, 402, 600), { id: 34 });
          out.expired = { ...afterGrace, total: strokes().length - n1 };
          // (c) cancel, then a pen down 60 px away within the grace: the first ends, the second is a new stroke
          const n2 = strokes().length;
          a = line(700, 200, 400);
          await T.z52pen(a, { id: 35, up: false });
          fire(T.pages()[0], 'pointercancel', 35, a[a.length - 1], 0);
          await T.sleep(50);
          await T.z52pen(line(700, 400 + 60 / (T.pages()[0].offsetWidth / 816), 600), { id: 36 });
          out.far = { added: strokes().length - n2 };
          // (d) the eraser: cancel and come back continues the same erase (one undo step)
          const n3 = strokes().length, depth = view.history.labels.length;
          view.setTool('eraser');
          view.setEraser({ mode: 'stroke' });
          const e1 = [[250, 590], [250, 610]].map(([x, y]) => T.z52client(0, x, y)), e2 = T.z52client(0, 250, 710);
          fire(T.pages()[0], 'pointerdown', 37, e1[0]);
          await T.frame();
          fire(T.pages()[0], 'pointermove', 37, e1[1]);
          await T.frame();
          fire(T.pages()[0], 'pointercancel', 37, e1[1], 0);
          await T.sleep(80);
          fire(T.pages()[0], 'pointerdown', 38, [e1[1][0], e1[1][1] + 10]);
          for (let j = 1; j <= 8; j++) { fire(T.pages()[0], 'pointermove', 38, [e2[0], e1[1][1] + 10 + (e2[1] - e1[1][1] - 10) * j / 8]); await T.frame(); }
          fire(T.pages()[0], 'pointerup', 38, e2, 0);
          await T.frame();
          out.eraser = { removed: n3 - strokes().length, steps: view.history.labels.length - depth, label: view.history.labels.slice(-1) };
          view.setTool('pen');
          view.toggleStats();
          out.text = view.contentEl.querySelector('.nb-ink-stats').textContent;
          view.toggleStats();
          return out;
        }""")
        print('pointercancel:', {k: v for k, v in r.items() if k != 'text'})
        j = r['joined']
        check('cancel: a pointercancel keeps the stroke open (still drawn) for the grace period',
              j['suspended'] and j['drawing'] and j['liveThen'], j)
        check('cancel: a pen down within 300 ms and 24 px of the last sample continues it: one stroke, one undo step, all points',
              j['added'] == 1 and j['taken'] and j['xs'][0] < 201 and j['xs'][1] > 599 and j['points'] >= 80 and j['labels'] == ['Add stroke'] and j['live'] == 0, j)
        check('cancel: counted in the pen stats (1 pointercancel, 1 continued)', j['cancels'] == 1 and j['continued'] == 1, j)
        check('cancel: with no pen down within 300 ms the stroke ends as it was (kept, counted as cancelled); the next is a new stroke',
              r['expired']['added'] == 1 and r['expired']['cancelled'] == 1 and not r['expired']['suspended'] and r['expired']['live'] == 0 and r['expired']['total'] == 2, r['expired'])
        check('cancel: a pen down farther than 24 px within the grace ends the stroke and starts a new one', r['far']['added'] == 2, r['far'])
        check('cancel: an erase continues across a pointercancel too (one undo step)', r['eraser']['removed'] >= 2 and r['eraser']['steps'] == 1, r['eraser'])
        check('cancel: the stats overlay shows the pointercancels and those continued', 'pointercancels 4, continued 2' in r['text'], r['text'])

        # (6) panning at 400%: the band follows the view; ink outside the first band is drawn when scrolled to
        r = ev("""async () => {
          await T.z52at(4, 0, 300, 300);
          const rebands = view.stats.rebands || 0;
          const sc = T.sc(), cx = sc.getBoundingClientRect().left + sc.clientWidth / 2, cy = sc.getBoundingClientRect().top + sc.clientHeight / 2;
          const finger = (type, x, y) => sc.dispatchEvent(new PointerEvent(type, { pointerId: 141, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
            bubbles: true, cancelable: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1 }));
          let y = cy;
          finger('pointerdown', cx, y);
          const frames = [];
          let last = performance.now();
          for (let s = 0; s < 60; s++) { y -= 20; finger('pointermove', cx, y); await T.frame(); const now = performance.now(); frames.push(now - last); last = now; }
          finger('pointerup', cx, y);
          const t0 = performance.now();
          while (view.nav.active && performance.now() - t0 < 6000) await T.sleep(50);
          await T.sleep(400);
          frames.sort((a, b) => a - b);
          return { moved: sc.scrollTop, rebands: (view.stats.rebands || 0) - rebands, covers: T.z52covers(0) && T.z52covers(1),
                   median: frames[frames.length >> 1], max: frames[frames.length - 1], over32: frames.filter(f => f > 32).length };
        }""")
        print(f"pan at 400% (1,200 px over 60 frames): {r['rebands']} bands redrawn; frames median {r['median']:.1f} ms, max {r['max']:.1f} ms, over 32 ms {r['over32']}")
        check('pan at 400%: the band bitmap follows the view (redrawn over frames) and covers what is visible after the pan',
              r['rebands'] >= 1 and r['covers'], r)
        clip = ev("""async () => {
          // the loops written at 100% on page 1, viewed at 400% after coming from far away
          await T.z52at(4, 1, 700, 1000);
          await T.z52at(4, 1, 290, 300, 800);
          return T.z52clip(1, [250, 280, 320, 310]);
        }""")
        n = ev("async (b) => { const a = await T.z52img(b); let n = 0; for (let k = 0; k < a.data.length; k += 4) if (a.data[k] < 128) n++; return n; }", shot(clip))
        check('pan at 400%: ink scrolled into view is drawn in the band', n > 2000, n)
        ev("() => view.setZoom(1)")
        # ======== end of 30. The pen at zoom and across a pointercancel (#52) ========

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

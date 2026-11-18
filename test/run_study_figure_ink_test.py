# Ink on figures (S13) in a browser: an ink surface sits over each image in a problem statement
# and a drill prompt, exactly as wide as the displayed image; a pen stroke persists after a
# remount, keyed `fig:`; after a viewport resize from 1024 to 600 px the surface still lies exactly
# on the image and the stroke over the same image pixel (measured against the img, not the canvas);
# a renamed figure shows a blank surface; a finger drag over the figure
# draws nothing and is not prevented (so the view scrolls); a hidden pick shows nothing new
# before the settle; a figure stroke written in the doc's problem block shows on the same figure
# in the standalone problem view and the reverse, both filed in the home doc's ink file (S12's
# home-doc env.doc), with nothing written to ink/problems.<device>.json; in the dark theme a figure
# stroke still draws dark (the figures are white whatever the theme); each figure's undo chip takes
# this device's latest stroke on that figure only, shows only while there is one, and is never
# written on; a drill's New attempt clears its prompt's figure with the page; a problem or drill
# destroyed before its render resolves leaves no figure surface behind. Uses the mock obsidian
# module's in-memory vault (test/harness.html), the S4 ink module and the blocks bundled by
# test/study-blocks-build.mjs; figure files are served by file name, as the content check does,
# so nothing asserts on an image's src (S12 changes how the mock resolves it).
# Run: python test/run_study_figure_ink_test.py (port NB_TEST_PORT_BASE + 13, or NB_STUDY_FIGINK_PORT).
# Exits 1 on any failure.
import json, os, re, subprocess, sys, time
from urllib.parse import unquote, urlparse
from playwright.sync_api import sync_playwright
import serve  # test/serve.py: the static server, refusing a port another run holds

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_STUDY_FIGINK_PORT', int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 13))

subprocess.run(['node', 'test/study-blocks-build.mjs'], cwd=ROOT, check=True, shell=(os.name == 'nt'))
srv = serve.start(port, ROOT)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    sys.stdout.flush()
    if not ok:
        failures.append(name)

IMAGE = re.compile(r'\.(svg|png|jpe?g|gif|webp)$', re.I)
FIG_DIR = os.path.join(ROOT, 'test', 'fixtures', 'study-figure-ink', 'figs')
figs = {n: os.path.join(FIG_DIR, n) for n in os.listdir(FIG_DIR)} if os.path.isdir(FIG_DIR) else {}

# The S1 fixtures plus this ticket's own (an invented basic with figures in a problem statement,
# a second problem's statement and a derive prompt). The figures go into the mock vault too, at
# their place in the fixture tree: the mock resolves an embed through the vault (S12), so a figure
# the vault lacks renders data-unresolved, with no src.
FILES = []
FIG_PATHS = []
for base in ('test/fixtures/study', 'test/fixtures/study-figure-ink'):
    for dirpath, _, names in os.walk(os.path.join(ROOT, base)):
        for n in sorted(names):
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, os.path.join(ROOT, base)).replace('\\', '/')
            if IMAGE.search(n):
                FIG_PATHS.append('study/' + rel)
            if not n.endswith('.md'):
                continue
            with open(full, encoding='utf-8') as f:
                FILES.append({'path': 'study/' + rel, 'text': f.read().replace('\r\n', '\n')})

SETUP = r"""
(files => {
  const SB = window.studyBlocks;
  window.FILES = files;
  window.content = SB.buildIndex(files);
  window.events = [];
  window.toasts = [];
  window.opened = [];
  const listeners = new Set();
  let n = 0;
  window.emit = what => { for (const fn of [...listeners]) fn(what); };
  window.ctx = {
    app: window.app,
    plugin: new obsidian.Plugin(),
    ui: { toast: m => toasts.push(m), openDoc: async (d, a) => { opened.push([d, a]); }, openToday: async () => {} },
    settings: () => ({ root: 'study', device: 'desktop', minutes: 60, devTools: false }),
    content: () => window.content,
    events: () => window.events,
    log: async e => {
      const ev = { v: 1, id: 'desktop-' + (++n), t: new Date().toISOString(), dev: 'desktop', ...e };
      events.push(ev);
      emit('events');
      return ev;
    },
    engine: () => ({ pushLevel: () => 0, basic: id => ({ id, stage: 1, due: null }), rating: () => 3 }),
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  window.inkCtx = ctx;
  /* The ink API, with every fig: surface tracked until it is destroyed (figLive): a surface nobody
     destroys keeps a store listener, a ResizeObserver and a canvas alive. */
  const realInk = SB.createInkApi(ctx);
  window.figLive = new Set();
  window.ink = {
    page: (...a) => realInk.page(...a),
    surface: (doc, container, key, opts) => {
      const s = realInk.surface(doc, container, key, opts);
      if (key.startsWith('fig:')) {
        figLive.add(s);
        const destroy = s.destroy;
        s.destroy = () => { figLive.delete(s); destroy(); };
      }
      return s;
    },
  };
  window.renderComp = new obsidian.Component();
  const leaf = document.getElementById('leaf');
  leaf.style.cssText = 'width:94vw;height:80vh;overflow:auto;position:relative;border:1px solid #ccc';
  /* Mounts a block (`drill`, `recall`, `problem`) on a passage of a doc into a fresh box, with the
     mock's MarkdownRenderer so ![fig](name) becomes a real <img> the harness serves. A render
     waits for window.holdRender when set; window.lastRender is the element it last rendered into. */
  window.mountBlock = (kind, docId, anchor) => {
    leaf.innerHTML = '';
    const doc = content.docs.get(docId);
    const passage = doc.passages.find(p => p.anchor === anchor || (p.block && p.block.id === anchor)) ||
      { anchor, block: { type: kind, id: anchor } };
    const el = document.createElement('div');
    el.style.cssText = 'width:min(820px, 86vw);padding:8px';
    leaf.appendChild(el);
    const env = {
      ctx, doc, passage, ink,
      open: (d, a) => opened.push([d, a]),
      peek: () => {},
      relayout: () => {},
      toast: m => toasts.push(m),
      render: async (md, into) => {
        if (window.holdRender) await window.holdRender;
        await obsidian.MarkdownRenderer.render(app, md, into, doc.path, renderComp);
        window.lastRender = into;
      },
    };
    window.box = el;
    window.env = env;
    window.handle = kind === 'hook' ? SB.mountHook(el, env, anchor) : SB[kind](el, env);
    return el;
  };
  window.surf = key => box.querySelector(`[data-ink-key="${CSS.escape(key)}"]`);
  /* A figure's undo chip, found from its surface's ink key under root. */
  window.chipOf = (key, root = box) => {
    const s = root.querySelector(`[data-ink-key="${CSS.escape(key)}"]`);
    const f = s && s.closest('.nb-study-figure');
    return f ? f.querySelector('.nb-study-figure-undo') : null;
  };
  /* A pen stroke from client points (pointer events, as the Pencil sends). */
  window.penStroke = (target, pts, type = 'pen', id = 7) => {
    const init = (q, extra = {}) => ({ pointerId: id, pointerType: type, pressure: 0.5, clientX: q[0], clientY: q[1], bubbles: true, cancelable: true, button: 0, buttons: 1, ...extra });
    target.dispatchEvent(new PointerEvent('pointerdown', init(pts[0])));
    for (let i = 1; i < pts.length; i++) target.dispatchEvent(new PointerEvent('pointermove', init(pts[i])));
    target.dispatchEvent(new PointerEvent('pointerup', init(pts[pts.length - 1], { buttons: 0, pressure: 0 })));
  };
  /* A short stroke across the point (fx, fy) of el's box — the image pixel at those fractions. */
  window.strokeAt = (el, fx, fy, type = 'pen') => {
    const r = el.getBoundingClientRect();
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push([r.left + r.width * (fx - 0.04 + 0.008 * i), r.top + r.height * fy + 3 * Math.sin(i / 2)]);
    penStroke(el, pts, type);
  };
  /* Ink pixels (alpha > 0) within rad device px of (fx, fy) of the surface's canvas. */
  window.inkAt = (surfEl, fx, fy, rad = 4) => {
    const c = surfEl.querySelector('canvas');
    if (!c) return -1;
    const X = Math.round(fx * c.width), Y = Math.round(fy * c.height);
    const x0 = Math.max(0, X - rad), y0 = Math.max(0, Y - rad);
    const w = Math.min(c.width - x0, 2 * rad), h = Math.min(c.height - y0, 2 * rad);
    const d = c.getContext('2d').getImageData(x0, y0, Math.max(1, w), Math.max(1, h)).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  };
  /* The mean colour [r, g, b, n] of the solid ink pixels (alpha >= 128) within rad device px of
     (fx, fy) of the surface's canvas; null when there are none. */
  window.inkRGB = (surfEl, fx, fy, rad = 8) => {
    const c = surfEl.querySelector('canvas');
    if (!c) return null;
    const X = Math.round(fx * c.width), Y = Math.round(fy * c.height);
    const x0 = Math.max(0, X - rad), y0 = Math.max(0, Y - rad);
    const w = Math.min(c.width - x0, 2 * rad), h = Math.min(c.height - y0, 2 * rad);
    const d = c.getContext('2d').getImageData(x0, y0, Math.max(1, w), Math.max(1, h)).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return n ? [r / n, g / n, b / n, n] : null;
  };
  /* Where a surface's ink lies on its image, as the screen shows it: the alpha-weighted centroid of
     the canvas's ink pixels, taken to client px through the canvas's own client rect, as fractions
     of the img's client rect ({fx, fy}), with the img's size ({w, h}) to read a drift in image px. */
  window.inkOnImage = surfEl => {
    const c = surfEl.querySelector('canvas'), img = surfEl.querySelector('img');
    if (!c || !img) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const a = d[(y * c.width + x) * 4 + 3];
      if (a) { sx += (x + 0.5) * a; sy += (y + 0.5) * a; n += a; }
    }
    if (!n) return null;
    const cr = c.getBoundingClientRect(), ir = img.getBoundingClientRect();
    const cx = cr.left + (sx / n) * cr.width / c.width, cy = cr.top + (sy / n) * cr.height / c.height;
    return { fx: (cx - ir.left) / ir.width, fy: (cy - ir.top) / ir.height, w: ir.width, h: ir.height };
  };
  /* The img's, the surface's and the canvas's client rects as [left, top, width, height]. */
  window.figRects = surfEl => [surfEl.querySelector('img'), surfEl, surfEl.querySelector('canvas')].map(e => {
    const r = e.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  });
  /* A finger event over el: whether the browser would act on it (not prevented). */
  window.fingerTouch = (el, type, touchType) => {
    const r = el.getBoundingClientRect();
    const t = new Touch({ identifier: 5, target: el, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    Object.defineProperty(t, 'touchType', { value: touchType });
    const e = new TouchEvent(type, { touches: [t], changedTouches: [t], bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };
  window.fileJson = p => (fs.has(p) ? JSON.parse(fs.get(p)) : null);
})
"""

def ev(page, js):
    return page.evaluate(js)

def serve_figure(route, figs):
    path = unquote(urlparse(route.request.url).path)
    if os.path.isfile(os.path.join(ROOT, path.lstrip('/'))):
        return route.continue_()
    name = path.rsplit('/', 1)[-1]
    if name in figs:
        return route.fulfill(path=figs[name])
    return route.fulfill(status=404, body='')

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        context = b.new_context(viewport={'width': 1024, 'height': 800})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.route(lambda url: bool(IMAGE.search(urlparse(url).path)), lambda route: serve_figure(route, figs))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.add_script_tag(url=f'http://localhost:{port}/test/out/study-blocks.js')
        page.evaluate(SETUP, FILES)
        # The figures' vault entries (the route above serves the bytes by file name).
        page.evaluate("""paths => {
          for (const p of paths) {
            fs.set(p, '(figure: served by file name)');
            const parts = p.split('/');
            for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join('/'));
          }
        }""", FIG_PATHS)

        KEY_CIRCUIT = 'fig:inv-el-nodes:s13-circuit.svg'
        KEY_MESH_A = 'fig:inv-el-mesh:s13-mesh-a.svg'
        KEY_MESH_B = 'fig:inv-el-mesh:s13-mesh-b.svg'
        KEY_BRIDGE = 'fig:d-bridge-balance:s13-bridge.svg'

        # --- 1. a surface sits over the problem statement's image, exactly as wide as the image
        ev(page, "() => mountBlock('problem', 'fx-fig', 'inv-el-nodes')")
        ok = True
        try:
            page.wait_for_function(f"() => surf('{KEY_CIRCUIT}')", timeout=8000)
        except Exception:
            ok = False
        check('the statement image gets an ink surface', ok)
        r = ev(page, f"""() => {{
          const s = surf('{KEY_CIRCUIT}');
          if (!s) return null;
          const img = s.querySelector('img');
          const sr = s.getBoundingClientRect(), ir = img.getBoundingClientRect();
          const box = s.closest('.nb-study-figure');
          return [sr.width, ir.width, Math.abs(sr.top - ir.top), Math.abs(sr.left - ir.left),
                  !!box, img.parentElement === s, img.naturalWidth, box.getBoundingClientRect().width];
        }}""")
        check('the surface is exactly over the image, which sits under the canvas', bool(r) and abs(r[0] - r[1]) < 1 and r[2] < 1 and r[3] < 1 and r[4] and r[5], r)
        check('the box is exactly as wide as the displayed image', bool(r) and abs(r[7] - r[1]) < 1, r)
        check('the image loaded (natural size known)', bool(r) and r[6] == 1200, r)
        # the paper height is the image's aspect ratio: 800 x 800/1200 paper px at the display scale
        h = ev(page, f"() => surf('{KEY_CIRCUIT}').getBoundingClientRect().height / (surf('{KEY_CIRCUIT}').getBoundingClientRect().width / 800)")
        check('the surface height is the image aspect ratio in paper px', bool(h) and abs(h - 800 * 800 / 1200) < 2, h)
        check('figure ink is there before the call is made', ev(page, "() => box.querySelector('.nb-sb-pb').dataset.phase") == 'call')

        # --- 2. a pen stroke on the figure persists after a remount, keyed fig:
        ev(page, f"() => strokeAt(surf('{KEY_CIRCUIT}'), 0.5, 0.4)")
        page.wait_for_timeout(80)
        f = ev(page, "async () => { await studyBlocks.flushInk(inkCtx); const j = fileJson('study/ink/fx-fig.desktop.json'); return j ? j.strokes.map(s => s.blk) : null; }")
        check('the stroke filed under the fig: key', f == [KEY_CIRCUIT], f)
        ev(page, "() => { handle.destroy(); mountBlock('problem', 'fx-fig', 'inv-el-nodes'); }")
        try:
            page.wait_for_function(f"() => surf('{KEY_CIRCUIT}') && inkAt(surf('{KEY_CIRCUIT}'), 0.5, 0.4) > 0", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('after a remount the stroke shows on the figure again', ok)

        # --- 3. viewport 1024 -> 600: the stroke still lies over the same image pixel. Measured on
        # the image, not the canvas (a canvas that drifts off the image still has its ink at the same
        # canvas fraction): the ink's centroid as a fraction of the img's client rect, before and after.
        p0 = ev(page, f"() => inkOnImage(surf('{KEY_CIRCUIT}'))")
        check('before the resize the stroke lies where it was drawn on the image (setup)',
              bool(p0) and abs(p0['fx'] - 0.5) * p0['w'] <= 3 and abs(p0['fy'] - 0.4) * p0['h'] <= 3, p0)
        before = ev(page, f"() => surf('{KEY_CIRCUIT}').querySelector('img').getBoundingClientRect().width")
        page.set_viewport_size({'width': 600, 'height': 800})
        ok = True
        try:
            page.wait_for_function(f"() => Math.abs(surf('{KEY_CIRCUIT}').querySelector('img').getBoundingClientRect().width - {before}) > 100", timeout=5000)
        except Exception:
            ok = False
        check('the figure resized with the viewport (setup)', ok, before)
        page.wait_for_timeout(300)
        rects = ev(page, f"() => figRects(surf('{KEY_CIRCUIT}'))")
        check('the figure really did get narrower', bool(rects) and rects[0][2] < before - 100, [before, rects])
        check('after the resize the surface and its canvas lie exactly on the image',
              bool(rects) and all(abs(a - b) < 1 for r in rects[1:] for a, b in zip(r, rects[0])), rects)
        p1 = ev(page, f"() => inkOnImage(surf('{KEY_CIRCUIT}'))")
        drift = [abs(p1['fx'] - p0['fx']) * max(p0['w'], p1['w']), abs(p1['fy'] - p0['fy']) * max(p0['h'], p1['h'])] if p0 and p1 else None
        check('after the resize the stroke still lies over the same image pixel (same image fraction within 2 px)',
              bool(drift) and drift[0] <= 2 and drift[1] <= 2, [p0, p1, drift])

        # --- 4. a renamed figure (a new version, FORMAT.md) shows a blank surface
        ev(page, "() => mountBlock('problem', 'fx-fig', 'inv-el-mesh')")
        try:
            page.wait_for_function(f"() => surf('{KEY_MESH_A}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('the mesh figure gets its surface (setup for the rename)', ok)
        ev(page, f"() => strokeAt(surf('{KEY_MESH_A}'), 0.5, 0.5)")
        page.wait_for_timeout(80)
        r = ev(page, """() => {
          const files2 = FILES.map(f => f.path === 'study/basics/fx-fig.md' ? { ...f, text: f.text.replace('s13-mesh-a.svg', 's13-mesh-b.svg') } : f);
          window.content = studyBlocks.buildIndex(files2);
          handle.destroy();
          mountBlock('problem', 'fx-fig', 'inv-el-mesh');
          return true;
        }""")
        try:
            page.wait_for_function(f"() => surf('{KEY_MESH_B}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('the renamed figure still gets a surface', ok)
        n = ev(page, f"() => inkAt(surf('{KEY_MESH_B}'), 0.5, 0.5, 8)")
        check('a renamed figure shows a blank surface', n == 0, n)
        f = ev(page, "async () => { await studyBlocks.flushInk(inkCtx); const j = fileJson('study/ink/fx-fig.desktop.json'); return j.strokes.map(s => s.blk); }")
        check('the old strokes stay in the file, unshown', KEY_MESH_A in f, f)

        # --- 5. a finger drag over the figure draws nothing and is not prevented (the view scrolls)
        ev(page, "() => { const files2 = FILES.map(f => ({ ...f })); window.content = studyBlocks.buildIndex(files2); mountBlock('problem', 'fx-fig', 'inv-el-nodes'); }")
        try:
            page.wait_for_function(f"() => surf('{KEY_CIRCUIT}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('the circuit figure is back (setup for the finger check)', ok)
        ev(page, "async () => { await studyBlocks.flushInk(inkCtx); }")
        ev(page, f"() => strokeAt(surf('{KEY_CIRCUIT}'), 0.3, 0.6, 'touch')")
        page.wait_for_timeout(80)
        f = ev(page, "async () => { await studyBlocks.flushInk(inkCtx); const j = fileJson('study/ink/fx-fig.desktop.json'); return j.strokes.filter(s => s.blk === '" + KEY_CIRCUIT + "').length; }")
        check('a finger drag adds no stroke', f == 1, f)  # only the stroke from check 2 remains
        t = ev(page, f"() => [fingerTouch(surf('{KEY_CIRCUIT}'), 'touchstart', 'direct'), fingerTouch(surf('{KEY_CIRCUIT}'), 'touchmove', 'direct'), getComputedStyle(surf('{KEY_CIRCUIT}')).touchAction]")
        check('finger touches are not prevented and panning is allowed', t == [False, False, 'auto'], t)

        # --- 6. a drill prompt's figure gets the same treatment
        ev(page, "() => mountBlock('drill', 'fx-fig', 'd-bridge-balance')")
        try:
            page.wait_for_function(f"() => surf('{KEY_BRIDGE}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('a surface sits over the drill prompt image', ok)
        ev(page, f"() => strokeAt(surf('{KEY_BRIDGE}'), 0.5, 0.5)")
        page.wait_for_timeout(80)
        f = ev(page, "async () => { await studyBlocks.flushInk(inkCtx); return fileJson('study/ink/fx-fig.desktop.json').strokes.filter(s => s.blk === '" + KEY_BRIDGE + "').length; }")
        check('ink on the prompt figure files under its own fig: key', f == 1, f)

        # --- 7. a hidden pick's standalone view shows nothing new before the settle
        r = ev(page, """async () => {
          studyBlocks.register(ctx);
          await ctx.ui.openProblem('inv-el-mesh', { hidden: true, why: 'A stretch pick.' });
          const v = app.workspace.getLeavesOfType('notebook-study-problem')[0].view;
          // S12: the view mounts after the old-ink copy settles, not within openProblem's promise.
          for (let i = 0; i < 100 && !v.contentEl.querySelector('.nb-sb-pb'); i++) await new Promise(r => setTimeout(r, 20));
          window.pv = v;
          return v.contentEl.textContent;
        }""")
        check('a hidden pick opens in the standalone view', 'two mesh currents' in r or 'mesh currents' in r, r[:200])
        check('a hidden pick shows neither the doc title nor the problem title', 'Nodal practice' not in r and 'Mesh loops' not in r, r[:200])
        try:
            page.wait_for_function(f"() => pv.contentEl.querySelector('[data-ink-key=\"{KEY_MESH_A}\"]')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('the figure surface is there on a hidden pick, with nothing new shown', ok)
        r = ev(page, f"""() => {{
          const c = chipOf('{KEY_MESH_A}', pv.contentEl);
          return c ? [c.hidden, c.textContent, c.outerHTML] : null;
        }}""")
        check("on a hidden pick the figure's undo chip shows (this device's stroke) and names nothing about the topic",
              bool(r) and r[0] is False and r[1] == 'Undo' and not any(w in r[2] for w in ('inv-el-mesh', 'fx-fig', 'Mesh loops', 'Nodal practice')), r)

        # --- 8. the same strokes in the doc and in the standalone view (S12's home doc). A stroke
        # on the statement figure in the doc's problem block shows on the same figure in the
        # standalone view, and a stroke there shows in the doc: both file under the home doc's ink
        # (fx-fig), and nothing goes to ink/problems.desktop.json.
        circuit_ids = ("async () => { await studyBlocks.flushInk(inkCtx); const j = fileJson('study/ink/fx-fig.desktop.json'); "
                       f"return j ? j.strokes.filter(s => s.blk === '{KEY_CIRCUIT}').map(s => s.id) : []; }}")
        ev(page, "() => mountBlock('problem', 'fx-fig', 'inv-el-nodes')")
        try:
            page.wait_for_function(f"() => surf('{KEY_CIRCUIT}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('the doc block shows the circuit figure (setup for the cross-view check)', ok)
        before = ev(page, circuit_ids)
        ev(page, f"() => strokeAt(surf('{KEY_CIRCUIT}'), 0.25, 0.75)")
        page.wait_for_timeout(80)
        after_doc = ev(page, circuit_ids)
        doc_new = [i for i in after_doc if i not in before]
        check('a figure stroke written in the doc files under the home doc\'s ink', len(doc_new) == 1, [before, after_doc])
        ev(page, """async () => {
          handle.destroy();
          studyBlocks.register(ctx);
          await ctx.ui.openProblem('inv-el-nodes', { why: 'S13 cross-view check' });
          window.sv = app.workspace.getLeavesOfType('notebook-study-problem').find(l => l.view.getState().id === 'inv-el-nodes').view;
          window.svSurf = key => sv.contentEl.querySelector(`[data-ink-key="${CSS.escape(key)}"]`);
        }""")
        try:
            page.wait_for_function(f"() => svSurf('{KEY_CIRCUIT}') && inkAt(svSurf('{KEY_CIRCUIT}'), 0.25, 0.75) > 0", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('a figure stroke written in the doc shows on the same figure in the standalone view', ok)
        n = ev(page, f"() => svSurf('{KEY_CIRCUIT}') ? inkAt(svSurf('{KEY_CIRCUIT}'), 0.75, 0.25, 3) : -1")
        check('and nowhere else on it (the spot the reverse stroke takes is blank)', n == 0, n)
        ev(page, f"() => strokeAt(svSurf('{KEY_CIRCUIT}'), 0.75, 0.25)")
        page.wait_for_timeout(80)
        after_sv = ev(page, circuit_ids)
        sv_new = [i for i in after_sv if i not in after_doc]
        check('a figure stroke written in the standalone view files under the home doc\'s ink, beside the doc\'s',
              len(sv_new) == 1 and all(i in after_sv for i in doc_new), [after_doc, after_sv])
        ev(page, "() => mountBlock('problem', 'fx-fig', 'inv-el-nodes')")
        try:
            page.wait_for_function(f"() => surf('{KEY_CIRCUIT}') && inkAt(surf('{KEY_CIRCUIT}'), 0.75, 0.25) > 0 && inkAt(surf('{KEY_CIRCUIT}'), 0.25, 0.75) > 0", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('a figure stroke written in the standalone view shows on the same figure in the doc', ok)
        check('nothing was written to ink/problems.desktop.json', ev(page, "() => !fs.has('study/ink/problems.desktop.json')") is True)

        # --- 9. the dark theme: figure ink stays dark. The figures are drawn on white whatever the
        # theme, so ink in the theme's --text-normal (light grey in the dark theme) would leave the
        # labels nearly invisible. The harness styles Obsidian's body.theme-dark.
        ev(page, "() => { document.body.classList.add('theme-dark'); mountBlock('problem', 'fx-fig', 'inv-el-nodes'); }")
        try:
            page.wait_for_function(f"() => surf('{KEY_CIRCUIT}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('the circuit figure is back (setup for the dark theme check)', ok)
        light = ev(page, f"() => surf('{KEY_CIRCUIT}') ? getComputedStyle(surf('{KEY_CIRCUIT}')).getPropertyValue('--text-normal').trim() : null")
        check('the dark theme is on (setup): --text-normal is light grey over the figure', light == '#dadada', light)
        ev(page, f"() => strokeAt(surf('{KEY_CIRCUIT}'), 0.62, 0.15)")  # a blank stretch of the figure
        page.wait_for_timeout(80)
        rgb = ev(page, f"() => inkRGB(surf('{KEY_CIRCUIT}'), 0.62, 0.15)")
        check('in the dark theme a figure stroke draws dark on the white figure', bool(rgb) and max(rgb[:3]) < 100, rgb)
        ev(page, "() => document.body.classList.remove('theme-dark')")

        # --- 10. each figure's undo chip: it takes this device's latest stroke on that figure and
        # nothing else (not page ink, not the other figure, not another device's stroke), shows only
        # while this device has a stroke there, sits above the canvas in the box's top-right corner,
        # and a Pencil on it writes nothing.
        KEY_PAIR_A = 'fig:inv-el-pair:s13-circuit.svg'
        KEY_PAIR_B = 'fig:inv-el-pair:s13-bridge.svg'
        ev(page, "() => mountBlock('problem', 'fx-fig', 'inv-el-pair')")
        try:
            page.wait_for_function(f"() => surf('{KEY_PAIR_A}') && surf('{KEY_PAIR_B}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('both figures of a two-figure statement get a surface (setup for the undo chip)', ok)
        # Another device's stroke on figure B, arriving as a sync does (paper px; the bridge is 560 high).
        ev(page, f"""() => externalWrite('study/ink/fx-fig.ipad.json', JSON.stringify({{ v: 1, doc: 'fx-fig', strokes: [
          {{ id: 's-ipad0001', t0: Date.now() - 60000, blk: '{KEY_PAIR_B}', p: [[300, 205, 0.5, 0], [400, 205, 0.5, 40], [500, 205, 0.5, 80]] }}] }}))""")
        try:
            page.wait_for_function(f"() => inkAt(surf('{KEY_PAIR_B}'), 0.5, 205 / 560) > 0", timeout=5000)
            ok = True
        except Exception:
            ok = False
        check("another device's stroke shows on figure B (setup)", ok)
        r = ev(page, f"() => [chipOf('{KEY_PAIR_A}').hidden, chipOf('{KEY_PAIR_B}').hidden, getComputedStyle(chipOf('{KEY_PAIR_B}')).display]")
        check("a figure's undo chip is hidden while this device has no stroke on it (another device's stroke included)", r == [True, True, 'none'], r)
        counts = (f"async () => {{ await studyBlocks.flushInk(inkCtx); const j = fileJson('study/ink/fx-fig.desktop.json'); "
                  f"const n = k => j.strokes.filter(s => (s.blk || null) === k).length; return [n(null), n('{KEY_PAIR_A}'), n('{KEY_PAIR_B}')]; }}")
        ev(page, "() => { window.pageInk = ink.page(env.doc, box, () => null); }")  # page ink over the block
        c0 = ev(page, counts)
        ev(page, "() => strokeAt(box.querySelector('.nb-sb-stmt p'), 0.5, 0.5)")  # a page stroke on the statement text
        for key, fx, fy in ((KEY_PAIR_A, 0.3, 0.3), (KEY_PAIR_A, 0.7, 0.7), (KEY_PAIR_B, 0.5, 0.75)):
            page.wait_for_timeout(40)  # distinct start times: "latest" is well defined
            ev(page, f"() => strokeAt(surf('{key}'), {fx}, {fy})")
        page.wait_for_timeout(80)
        c1 = ev(page, counts)
        check('setup: one page stroke, two on figure A and one on figure B', c1 == [c0[0] + 1, 2, 1], [c0, c1])
        r = ev(page, f"""() => {{
          const c = chipOf('{KEY_PAIR_A}'), f = c.closest('.nb-study-figure');
          const cr = c.getBoundingClientRect(), fr = f.getBoundingClientRect();
          const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
          return [c.hidden, chipOf('{KEY_PAIR_B}').hidden, fr.right - cr.right, cr.top - fr.top, hit === c, cr.width > 0 && cr.height > 0,
                  c.tagName, c.getAttribute('aria-label'), c.classList.contains('nb-study-no-ink')];
        }}""")
        check('with strokes of its own each figure shows its undo chip', bool(r) and r[0] is False and r[1] is False, r)
        check("the chip sits in the box's top-right corner above the canvas, so a tap there lands on it",
              bool(r) and 0 <= r[2] <= 12 and 0 <= r[3] <= 12 and r[4] is True and r[5] is True, r)
        check('the chip is a no-ink button named for what it does',
              bool(r) and r[6] == 'BUTTON' and r[7] == 'Undo the last stroke on this figure' and r[8] is True, r)
        ev(page, f"""() => {{
          const c = chipOf('{KEY_PAIR_A}'), r = c.getBoundingClientRect(), y = r.top + r.height / 2;
          penStroke(c, [[r.left + 2, y], [r.left + r.width / 2, y + 2], [r.right - 2, y]]);
        }}""")
        page.wait_for_timeout(80)
        c2 = ev(page, counts)
        check('a Pencil stroke on the chip writes nothing: no figure stroke, no page stroke', c2 == c1, [c1, c2])
        ev(page, f"() => chipOf('{KEY_PAIR_A}').click()")
        page.wait_for_timeout(80)
        c3 = ev(page, counts)
        px = ev(page, f"() => [inkAt(surf('{KEY_PAIR_A}'), 0.3, 0.3), inkAt(surf('{KEY_PAIR_A}'), 0.7, 0.7), chipOf('{KEY_PAIR_A}').hidden]")
        check("Undo takes the figure's latest stroke; the earlier one stays, and so does the chip",
              c3[1] == 1 and px[0] > 0 and px[1] == 0 and px[2] is False, [c3, px])
        check('page ink and the other figure are untouched by it', c3[0] == c1[0] and c3[2] == c1[2], [c1, c3])
        ev(page, f"() => chipOf('{KEY_PAIR_A}').click()")
        page.wait_for_timeout(80)
        r = ev(page, f"() => [chipOf('{KEY_PAIR_A}').hidden, inkAt(surf('{KEY_PAIR_A}'), 0.3, 0.3)]")
        c4 = ev(page, counts)
        check("once this device's last stroke on the figure is undone the chip hides", r == [True, 0] and c4[1] == 0, [r, c4])
        ev(page, f"() => chipOf('{KEY_PAIR_B}').click()")
        page.wait_for_timeout(80)
        r = ev(page, f"() => [chipOf('{KEY_PAIR_B}').hidden, inkAt(surf('{KEY_PAIR_B}'), 0.5, 0.75), inkAt(surf('{KEY_PAIR_B}'), 0.5, 205 / 560)]")
        c5 = ev(page, counts)
        check("Undo never takes another device's stroke: it stays, the chip hides", r[0] is True and r[1] == 0 and r[2] > 0 and c5 == [c1[0], 0, 0], [r, c5])
        ev(page, "() => { pageInk.destroy(); window.pageInk = null; }")

        # --- 11. a drill's New attempt clears the prompt's figure with the page: marks made while
        # reading the model's steps do not stay into the next blank-page attempt.
        KEY_DRILL = 'drill:d-bridge-balance'
        ev(page, "() => mountBlock('drill', 'fx-fig', 'd-bridge-balance')")
        try:
            page.wait_for_function(f"() => surf('{KEY_BRIDGE}') && surf('{KEY_DRILL}')", timeout=8000)
            ok = True
        except Exception:
            ok = False
        check('the drill shows its prompt figure and its page (setup for New attempt)', ok)
        ev(page, "() => box.querySelector('[data-sb=\"start\"]').click()")
        for i in range(3):
            ev(page, f"() => strokeAt(surf('{KEY_DRILL}'), {0.2 + 0.25 * i}, 0.3)")
            page.wait_for_timeout(30)
        ev(page, "() => box.querySelector('[data-sb=\"done\"]').click()")
        for fx, fy in ((0.3, 0.2), (0.7, 0.8)):  # marks on the figure while reading the model's steps
            ev(page, f"() => strokeAt(surf('{KEY_BRIDGE}'), {fx}, {fy})")
            page.wait_for_timeout(30)
        mine = (f"async () => {{ await studyBlocks.flushInk(inkCtx); const j = fileJson('study/ink/fx-fig.desktop.json'); "
                f"return [j.strokes.filter(s => s.blk === '{KEY_BRIDGE}').length, j.strokes.filter(s => s.blk === '{KEY_DRILL}').length]; }}")
        n0 = ev(page, mine)
        ok = ev(page, "() => { const g = box.querySelector('[data-grade=\"clean\"]'); if (!g) return false; g.click(); return true; }")
        try:
            page.wait_for_function("() => box.querySelector('[data-sb=\"again\"]')", timeout=5000)
        except Exception:
            ok = False
        check('setup: page strokes, Done, figure strokes, graded clean', ok and n0[0] >= 2 and n0[1] == 3, n0)
        ev(page, "() => { const b = box.querySelector('[data-sb=\"again\"]'); b.click(); b.click(); }")  # two taps
        try:
            page.wait_for_function("() => box.querySelector('.nb-sb-drill').dataset.phase === 'idle'", timeout=5000)
            ok = True
        except Exception:
            ok = False
        check('New attempt starts a fresh attempt (setup)', ok)
        page.wait_for_timeout(80)
        n1 = ev(page, mine)
        blank = ev(page, f"() => [inkAt(surf('{KEY_BRIDGE}'), 0.5, 0.5, 1e6), inkAt(surf('{KEY_DRILL}'), 0.5, 0.5, 1e6)]")
        check("New attempt leaves the prompt's figure empty, as the page", blank == [0, 0], blank)
        check("and the ink file holds none of this device's strokes under the figure's key", n1 == [0, 0], [n0, n1])

        # --- 12. a block destroyed before its statement or prompt finishes rendering mounts no
        # figure surface afterwards: nothing would destroy it. The render is held until after the
        # destroy, then the check waits for its image to load (where a surface would mount).
        for kind, anchor in (('problem', 'inv-el-nodes'), ('drill', 'd-bridge-balance')):
            r = ev(page, f"""async () => {{
              let release;
              window.holdRender = new Promise(res => {{ release = res; }});
              window.lastRender = null;
              const before = figLive.size;
              mountBlock('{kind}', 'fx-fig', '{anchor}');
              handle.destroy();
              release();
              window.holdRender = null;
              const wait = () => new Promise(res => setTimeout(res, 20));
              for (let i = 0; i < 200 && !lastRender; i++) await wait();
              const imgs = lastRender ? [...lastRender.querySelectorAll('img')] : [];
              for (let i = 0; i < 200 && !imgs.every(m => m.complete); i++) await wait();
              await new Promise(res => setTimeout(res, 150));
              return [before, figLive.size, imgs.length, imgs.length > 0 && imgs.every(m => m.naturalWidth > 0),
                      !!(lastRender && lastRender.querySelector('.nb-study-figure'))];
            }}""")
            check(f'a {kind} destroyed before its render resolves leaves no figure surface',
                  bool(r) and r[1] == r[0] and r[4] is False, r)
            check(f'(setup: that {kind} rendered its figure later and it loaded)', bool(r) and r[2] >= 1 and r[3] is True, r)

        page.screenshot(path=os.path.join(OUT, 'study-figure-ink.png'))
        check('no page errors', not errors, errors[:3])
        b.close()
finally:
    srv.terminate()

print(f'{len(failures)} failure(s)' if failures else 'all figure-ink checks passed')
sys.exit(1 if failures else 0)

# Ink on figures (S13) in a browser: an ink surface sits over each image in a problem statement
# and a drill prompt, exactly as wide as the displayed image; a pen stroke persists after a
# remount, keyed `fig:`; after a viewport resize from 1024 to 600 px the stroke still lies over
# the same image pixel; a renamed figure shows a blank surface; a finger drag over the figure
# draws nothing and is not prevented (so the view scrolls); a hidden pick shows nothing new
# before the settle. The doc/standalone same-strokes check stays SKIP until S12 merges (its
# home-doc env.doc is what puts both views on the same ink file). Uses the mock obsidian
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
# a second problem's statement and a derive prompt).
FILES = []
for base in ('test/fixtures/study', 'test/fixtures/study-figure-ink'):
    for dirpath, _, names in os.walk(os.path.join(ROOT, base)):
        for n in sorted(names):
            if not n.endswith('.md'):
                continue
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, os.path.join(ROOT, base)).replace('\\', '/')
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
  window.ink = SB.createInkApi(ctx);
  window.renderComp = new obsidian.Component();
  const leaf = document.getElementById('leaf');
  leaf.style.cssText = 'width:94vw;height:80vh;overflow:auto;position:relative;border:1px solid #ccc';
  /* Mounts a block (`drill`, `recall`, `problem`) on a passage of a doc into a fresh box, with the
     mock's MarkdownRenderer so ![fig](name) becomes a real <img> the harness serves. */
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
      render: async (md, into) => { await obsidian.MarkdownRenderer.render(app, md, into, doc.path, renderComp); },
    };
    window.box = el;
    window.env = env;
    window.handle = kind === 'hook' ? SB.mountHook(el, env, anchor) : SB[kind](el, env);
    return el;
  };
  window.surf = key => box.querySelector(`[data-ink-key="${CSS.escape(key)}"]`);
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

        # --- 3. viewport 1024 -> 600: the stroke still lies over the same image pixel
        before = ev(page, f"() => surf('{KEY_CIRCUIT}').getBoundingClientRect().width")
        page.set_viewport_size({'width': 600, 'height': 800})
        ok = True
        try:
            page.wait_for_function(f"() => Math.abs(surf('{KEY_CIRCUIT}').getBoundingClientRect().width - {before}) > 100", timeout=5000)
        except Exception:
            ok = False
        check('the figure resized with the viewport (setup)', ok, before)
        page.wait_for_timeout(300)
        after = ev(page, f"() => surf('{KEY_CIRCUIT}').getBoundingClientRect().width")
        check('the figure really did get narrower', bool(after) and after < before - 100, [before, after])
        n = ev(page, f"() => inkAt(surf('{KEY_CIRCUIT}'), 0.5, 0.4, 3)")
        check('after the resize the stroke still lies over the same image pixel', isinstance(n, int) and n > 0, n)
        n2 = ev(page, f"() => inkAt(surf('{KEY_CIRCUIT}'), 0.85, 0.4, 3)")
        check('and not over a different pixel', n2 == 0, n2)

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

        # --- 8. the same strokes in the doc and in the standalone view (needs S12's home doc)
        print('SKIP same strokes in doc and standalone view: waits on S12 (its env.doc is the home doc), merged after this branch')

        page.screenshot(path=os.path.join(OUT, 'study-figure-ink.png'))
        check('no page errors', not errors, errors[:3])
        b.close()
finally:
    srv.terminate()

print(f'{len(failures)} failure(s)' if failures else 'all figure-ink checks passed')
sys.exit(1 if failures else 0)

# Smoke test for the study reader shell: core.js, reader.js, main.js and build.mjs.
#
#   python test/smoke.py            # fixture build (bare: core + fixture content + engine + reader + main),
#                                   # a build without engine.js, then the full build when src/content.js exists
#   python test/smoke.py --fixture  # fixture builds only
#
# The fixture build is the shell with engine.js and two small fixture docs, so the checks stay
# deterministic; engine.js owns every rule (builds, budget, Changes, rationing). A second fixture build
# leaves engine.js out to check the page still reads and a mark is only noted. Pages are wrapped the way
# the artifact host wraps them (doctype, charset, viewport with viewport-fit=cover) and served over http.
# A sandboxed iframe without allow-same-origin, where localStorage throws, checks the in-memory store.
# Screenshots land in test/out/. Exits non-zero if any check fails.
import functools, http.server, json, os, subprocess, sys, threading, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
ONLY_FIXTURE = '--fixture' in sys.argv

failures, notes = [], []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(name)


def note(msg):
    print('NOTE ' + msg)
    notes.append(msg)


def build(args, out_rel):
    r = subprocess.run(['node', 'build.mjs', *args, '--out', out_rel, '--quiet'], cwd=ROOT, capture_output=True, text=True)
    print((r.stdout + r.stderr).strip())
    check('build ' + ' '.join(args or ['(full)']), r.returncode == 0, r.stderr.strip())
    return r.returncode == 0


def contract(path):
    import re
    t = open(path, encoding='utf-8').read()
    bad = [w for w, rx in (('doctype', r'<!doctype'), ('html', r'<html[\s>]'), ('head', r'<head[\s>]'), ('body', r'<body[\s>]'),
                           ('viewport meta', r'<meta[^>]*viewport')) if re.search(rx, t, re.I)]
    check(os.path.basename(path) + ': no doctype/html/head/body/viewport of its own', not bad, bad)
    check(os.path.basename(path) + ': starts with <title>Study Reader</title>', t.startswith('<title>Study Reader</title>'))
    srcs = re.findall(r'<script[^>]*\ssrc="([^"]+)"', t)
    check(os.path.basename(path) + ': external scripts only from jsdelivr with exact versions',
          all(re.match(r'^https://cdn\.jsdelivr\.net/npm/[^/@]+@\d+\.\d+\.\d+/', u) for u in srcs), srcs)


def host_wrap(src, dst):
    body = open(src, encoding='utf-8').read()
    page = ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '</head><body>' + body + '</body></html>')
    open(dst, 'w', encoding='utf-8').write(page)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    handler = functools.partial(QuietHandler, directory=directory)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


HELPERS = r"""() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fire = (type, x, y, o = {}) => {
    const el = o.target || document.elementFromPoint(x, y) || document.body;
    el.dispatchEvent(new PointerEvent(type, { pointerId: o.id || 7, pointerType: o.ptype || 'pen', pressure: o.p == null ? 0.5 : o.p,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true }));
    return el;
  };
  window.T = {
    sleep,
    fire,
    center(sel) {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height };
    },
    /* A synthetic stroke through client points. Each event goes to the element under the point. */
    async stroke(pts, ptype = 'pen', id = 7) {
      fire('pointerdown', pts[0][0], pts[0][1], { ptype, id, p: 0.3 });
      for (let i = 1; i < pts.length; i++) { fire('pointermove', pts[i][0], pts[i][1], { ptype, id, p: 0.5 }); await sleep(4); }
      fire('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1], { ptype, id, p: 0 });
      await sleep(30);
    },
    wave(x0, y0, w = 160, n = 24) { return Array.from({ length: n }, (_, j) => [x0 + j * w / n, y0 + 6 * Math.sin(j / 3)]); },
    /* A tap: pointerdown/up of a type, then a click, on an element. */
    async tap(el, ptype = 'touch') {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(), x = r.left + Math.min(8, r.width / 2), y = r.top + r.height / 2;
      fire('pointerdown', x, y, { ptype, id: 11, target: el });
      await sleep(30);
      fire('pointerup', x, y, { ptype, id: 11, target: el });
      el.click();
      await sleep(60);
      return true;
    },
    async hold(el, ms = 650) {
      if (typeof el === 'string') el = document.querySelector(el);
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(), x = r.left + 6, y = r.top + r.height / 2;
      fire('pointerdown', x, y, { ptype: 'touch', id: 12, target: el });
      await sleep(ms);
      fire('pointerup', x, y, { ptype: 'touch', id: 12, target: el });
      el.click();
      await sleep(60);
    },
    /* Non-transparent pixels of a canvas inside a client rect. */
    inkIn(canvas, rect) {
      const cr = canvas.getBoundingClientRect(), k = canvas.width / cr.width;
      const x = Math.max(0, Math.floor((rect.left - cr.left) * k)), y = Math.max(0, Math.floor((rect.top - cr.top) * k));
      const w = Math.min(canvas.width - x, Math.ceil(rect.width * k)), h = Math.min(canvas.height - y, Math.ceil(rect.height * k));
      if (w <= 0 || h <= 0) return 0;
      const d = canvas.getContext('2d').getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n;
    },
    docCanvas() { return document.querySelector('#sr-stack > canvas.sr-ink-canvas'); },
    text(sel) { const el = document.querySelector(sel); return el ? el.textContent : null; }
  };
}"""


def attach_errors(page, errors):
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append('console: ' + m.text))


def real_errors(errors):
    # A failed MathJax download (offline machine) is a network problem, not a page error.
    return [e for e in errors if 'Failed to load resource' not in e and 'net::ERR' not in e]


def wait_ready(page, frame=None):
    f = frame or page
    f.wait_for_function('() => window.SR && SR.reader && SR.reader.current && !!SR.reader.current()', timeout=15000)
    f.evaluate(HELPERS)


def mathjax_status(f, wait_ms=12000):
    try:
        f.wait_for_function("() => !!document.querySelector('#sr-dochost mjx-container')", timeout=wait_ms)
        return True
    except Exception:
        return False


def fixture_suite(pw, base):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={'width': 820, 'height': 1180}, device_scale_factor=2)
    page = ctx.new_page()
    errors = []
    attach_errors(page, errors)
    page.goto(base + '/host-fixture.html')
    wait_ready(page)
    E = page.evaluate

    check('title is Study Reader', page.title() == 'Study Reader', page.title())
    check('opens on the topic doc', E('SR.reader.current()') == 'nt-moves', E('SR.reader.current()'))
    check('h1 rendered', E("document.querySelector('#sr-dochost h1').textContent") == 'Number theory: first moves')
    check('model label on the page', "Not Adit's words" in E("document.querySelector('#sr-dochost .byline').textContent"))
    check('Demo tag in header', E("document.querySelector('.sr-hdr .tag').textContent") == 'Demo')
    check('tabs rendered', E("document.querySelectorAll('#sr-tabs .sr-tab').length") >= 1)
    check('engine.js is in the fixture build', E("!!(SR.engine && SR.engine.triage)"))
    # nt-units is seeded at stage 1 (weak): a lost mark resting on it would rebuild it. Lift it to stage 3 so
    # this walk-through sees the rationed path (scaffold, eligible, rewrite); engine_suite covers the other.
    E("SR.engine.setStage('nt-units', 3)")
    check('missing fog block shows a placeholder, nothing of the proof', E("""() => {
      const b = document.querySelector('#sr-dochost .blk[data-block="fog"]'); return !!b && /not loaded/.test(b.textContent) && !/\\\\varphi\\(7\\)/.test(b.textContent); }"""))
    mj = mathjax_status(page)
    if mj:
        check('MathJax typeset the doc', True)
    else:
        note('MathJax did not typeset within 12 s (CDN unreachable?); raw TeX stays readable')
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, 'ipad-portrait.png'))

    # ---- links and back
    y0 = E('window.scrollY')
    E("T.tap('.ref[data-to=\"nt-units#unit-gcd\"]', 'touch')")
    page.wait_for_timeout(150)
    check('finger tap on a link opens the target doc', E('SR.reader.current()') == 'nt-units', E('SR.reader.current()'))
    check('target passage flashes', E("!!document.querySelector('#sr-dochost [data-a=\"unit-gcd\"].flash')"))
    check('back button shows', E("!document.getElementById('sr-back').hidden"))
    E("document.getElementById('sr-back').click()")
    page.wait_for_timeout(100)
    check('back returns to the topic doc', E('SR.reader.current()') == 'nt-moves')
    check('back button hides again', E("document.getElementById('sr-back').hidden"))

    # ---- peek
    E("T.hold('.ref[data-to=\"nt-units#euler\"]')")
    page.wait_for_timeout(150)
    check('long press opens a peek', E("!document.getElementById('sr-peek').hidden"))
    check('peek shows the target passage', 'Euler' in (E("T.text('#sr-peek')") or ''))
    check('peek fogs the proof', 'Proof fogged' in (E("T.text('#sr-peek')") or ''))
    check('the click after a long press does not navigate', E('SR.reader.current()') == 'nt-moves')
    E("document.querySelector('#sr-peek [data-close]').click()")
    check('peek closes', E("document.getElementById('sr-peek').hidden"))
    E("T.hold('.ref[data-to=\"nt-units#euler\"]')")
    E("document.querySelector('#sr-peek [data-open]').click()")
    page.wait_for_timeout(100)
    check("peek's Open follows the link", E('SR.reader.current()') == 'nt-units' and E("document.getElementById('sr-peek').hidden"))
    E("document.getElementById('sr-back').click()")
    page.wait_for_timeout(100)

    # ---- the Pencil never follows links
    n0 = E("SR.reader.inkOf('nt-moves').length")
    E("T.tap('.ref[data-to=\"nt-units#euler\"]', 'pen')")
    check('pen tap on a link does not navigate', E('SR.reader.current()') == 'nt-moves')
    n1 = E("SR.reader.inkOf('nt-moves').length")
    if n1 > n0:
        E("document.getElementById('sr-undo').click()")

    # ---- ink anchored to text
    pt = E("T.center('[data-a=\"moves-1\"]')")
    E(f"T.stroke(T.wave({pt['left'] + 10}, {pt['y']}))")
    ink = E("SR.reader.inkOf('nt-moves')")
    check('pen stroke lands in the doc ink', len(ink) == 1, len(ink))
    check('stroke anchored to the passage under it', bool(ink) and ink[-1].get('at', {}).get('a') == 'moves-1', ink[-1].get('at') if ink else None)
    check('stroke points are paper coordinates (800 wide)', bool(ink) and all(0 <= p[0] <= 800 for p in ink[-1]['p']) and len(ink[-1]['p'][0]) == 4)
    rect = E(f"({{left: {pt['left']}, top: {pt['y'] - 14}, width: 180, height: 28}})")
    px = E(f"T.inkIn(T.docCanvas(), {json.dumps(rect)})")
    check('stroke is drawn on the canvas', px > 20, px)
    E(f"T.stroke(T.wave({pt['left'] + 10}, {pt['y']}), 'touch')")
    check('finger drag never draws', E("SR.reader.inkOf('nt-moves').length") == 1)
    E(f"T.stroke(T.wave({pt['left'] + 10}, {pt['y'] + 4}), 'mouse')")
    check('mouse drag draws', E("SR.reader.inkOf('nt-moves').length") == 2)
    E("document.getElementById('sr-undo').click()")
    check('undo removes the last stroke', E("SR.reader.inkOf('nt-moves').length") == 1)

    # ---- marks: lost on a topic passage -> scaffold (engine.triage: not a gap in a basic)
    E("T.tap('.mark[data-key=\"nt-moves#moves-2\"]', 'mouse')")
    check('chip tap opens the mark menu', E("!!document.querySelector('.markmenu')"))
    E("document.querySelector('.markmenu [data-verb=\"lost\"]').click()")
    page.wait_for_timeout(150)
    m = E("SR.reader.marks()['nt-moves#moves-2']")
    check('lost mark on a topic passage scaffolds', bool(m) and m.get('state') == 'struggling', m)
    check('scaffold links the basic it rests on', E("!!document.querySelector('.sr-scaffold[data-key=\"nt-moves#moves-2\"] .sr-sc-basics .ref[data-to=\"nt-units\"]')"))
    check('chip shows struggling', E("(document.querySelector('.mark[data-key=\"nt-moves#moves-2\"]') || {}).textContent") == 'struggling')
    page.wait_for_timeout(200)
    page.screenshot(path=os.path.join(OUT, 'scaffold.png'))
    # a stroke on the passage itself, to see it dim after the rewrite
    p2 = E("T.center('[data-a=\"moves-2\"]')")
    E(f"T.stroke(T.wave({p2['left'] + 30}, {p2['y']}, 120))")
    check('second doc stroke anchored to moves-2', E("SR.reader.inkOf('nt-moves').slice(-1)[0].at.a") == 'moves-2')
    nd = E("SR.reader.inkOf('nt-moves').length")
    box = E("T.center('.sr-scaffold[data-key=\"nt-moves#moves-2\"] .sr-ink canvas')")
    E(f"T.stroke(T.wave({box['left'] + 20}, {box['top'] + 40}, 140))")
    check('attempt box takes its own ink', E("(SR.store.get('attempt-nt-moves#moves-2') || []).length") == 1)
    check('doc ink ignores the attempt box', E("SR.reader.inkOf('nt-moves').length") == nd)
    E("document.querySelector('.sr-scaffold [data-sc-act=\"still\"]').click()")
    page.wait_for_timeout(100)
    check('still lost the same day stays struggling', E("SR.reader.marks()['nt-moves#moves-2'].state") == 'struggling')
    # eligibility: a day of simulated time with ink in the box; the reader rechecks when the clock moves
    E("SR.engine.advanceDays(1)")
    page.wait_for_timeout(100)
    check('a day later, still lost with ink, the mark turns eligible', E("SR.reader.marks()['nt-moves#moves-2'].state") == 'eligible')
    btn = '.sr-scaffold [data-sc-act="rewrite"]'
    check('rewrite control shows the budget', '3 of 3 left' in (E(f"T.text('{btn}')") or ''), E(f"T.text('{btn}')"))
    E(f"document.querySelector('{btn}').click()")
    check('first tap only arms the rewrite', 'Tap again' in (E(f"T.text('{btn}')") or '') and not E("!!document.querySelector('.sr-rewritten')"))
    E(f"document.querySelector('{btn}').click()")
    page.wait_for_timeout(200)
    check('second tap swaps in the rewrite', E("!!document.querySelector('#sr-dochost .sr-rewritten[data-a=\"moves-2\"]')"))
    check('rewrite spends the budget', E("SR.engine.budget('nt-moves').used") == 1)
    check('ink on the rewritten passage dims with keep/delete', E("!!document.querySelector('#sr-ovl .cchip')"))
    check('Changes counts the rewrite', 'Changes (1)' in E("document.getElementById('sr-changes').textContent"))
    page.screenshot(path=os.path.join(OUT, 'rewrite.png'))

    # ---- rebuild of a basic with re-anchoring
    E("T.tap('.ref[data-to=\"nt-units#euler\"]', 'touch')")
    page.wait_for_timeout(150)
    check('on the basic, build 1', E('SR.reader.current()') == 'nt-units' and E("SR.reader.version('nt-units')") == 1)
    anchors = ['units-p', 'euler-check', 'phi-remark']
    for a in anchors:
        c = E(f"T.center('[data-a=\"{a}\"]')")
        E(f"T.stroke(T.wave({c['left'] + 20}, {c['y']}, 150))")
    got = [s['at']['a'] for s in E("SR.reader.inkOf('nt-units')")]
    check('three strokes on three passages', got == anchors, got)
    before_top = E("SR.reader.anchors()['units-p'].top")
    E("T.tap('.mark[data-key=\"nt-units#euler\"]', 'mouse')")
    E("document.querySelector('.markmenu [data-verb=\"lost\"]').click()")
    page.wait_for_timeout(250)
    check('lost mark on a basic rebuilds it whole', E("SR.reader.version('nt-units')") == 2)
    check('build 2 is on the page', E("!!document.querySelector('#sr-dochost [data-a=\"notation\"]')"))
    after_top = E("SR.reader.anchors()['units-p'].top")
    check('unchanged passage moved down in build 2', after_top > before_top + 10, (before_top, after_top))
    check('ink on the unchanged passage follows it (same text, shifted down)', E("""() => {
      const st = SR.reader.inkOf('nt-units').find(s => s.at.a === 'units-p'), A = SR.reader.anchors()['units-p'];
      return !!st && A.rev === st.at.rev && A.top - st.at.dy > 10; }"""))
    c2 = E("T.center('[data-a=\"units-p\"]')")
    px2 = E(f"T.inkIn(T.docCanvas(), {{left: {c2['left']}, top: {c2['top']}, width: 220, height: {c2['h']}}})")
    check('followed stroke is drawn at the passage in build 2', px2 > 20, px2)
    check('ink on the rewritten check dims (changed chip)', 'changed' in (E("T.text('#sr-ovl')") or ''))
    check('ink on the removed remark goes to the orphan page', 'phi-remark' in (E("T.text('#sr-orph')") or ''))
    toast = E("T.text('#sr-toast')") or ''
    check('rebuild toast counts followed/changed/orphaned', '1 stroke followed' in toast and '1 on rewritten text' in toast and '1 orphaned' in toast, toast)
    page.wait_for_timeout(250)
    page.screenshot(path=os.path.join(OUT, 'rebuild.png'), full_page=True)
    E("document.getElementById('sr-changes').click()")
    page.wait_for_timeout(100)
    check('Changes panel logs the rebuild', 'Rebuilt whole from its prerequisites' in (E("T.text('.sr-sheet[data-sheet=\"changes\"]')") or ''))
    E("SR.sheet.closeAll()")

    # ---- persistence across reload
    page.reload()
    wait_ready(page)
    check('ink persists across reload', len(E("SR.reader.inkOf('nt-units')")) == 3 and len(E("SR.reader.inkOf('nt-moves')")) == 2)
    check('build 2 persists across reload', E("SR.reader.version('nt-units')") == 2)
    check('marks persist across reload', E("Object.keys(SR.reader.marks()).length") == 2)
    E("document.querySelector('#sr-ovl .cchip [data-act=\"keep\"]').click()")
    page.wait_for_timeout(100)
    check('keep re-attaches dimmed ink to the new text', not E("!!document.querySelector('#sr-ovl .cchip')") and
          E("(() => { const s = SR.reader.inkOf('nt-units').find(x => x.at.a === 'euler-check'); return !!s && s.at.rev === SR.reader.anchors()['euler-check'].rev; })()"))
    E("document.querySelector('#sr-orph [data-act=\"odel\"]').click()")
    page.wait_for_timeout(100)
    check('delete clears orphaned ink and the orphan page', len(E("SR.reader.inkOf('nt-units')")) == 2 and not E("!!document.querySelector('#sr-orph .orphan')"))

    # ---- Today / Map without panel-map.js: a sheet says so, nothing throws
    E("document.getElementById('sr-today').click()")
    check('Today without panel-map.js opens a placeholder sheet', 'panel-map.js' in (E("T.text('.sr-sheet')") or ''))
    E("SR.sheet.closeAll()")

    # ---- library and search
    E("document.getElementById('sr-lib').click()")
    E("""() => { const i = document.querySelector('.sr-search'); i.value = 'euler'; i.dispatchEvent(new Event('input')); }""")
    hits = E("[...document.querySelectorAll('.sr-res')].map(b => b.dataset.open)")
    check('search finds Euler across docs', 'nt-units#euler' in hits and any(h.startswith('nt-moves') for h in hits), hits)
    check('search does not index fogged proofs', not E("SR.reader.search('cancel the product').length"))
    E("document.querySelector('.sr-res[data-open=\"nt-units#euler\"]').click()")
    page.wait_for_timeout(100)
    check('a search hit opens its passage', E('SR.reader.current()') == 'nt-units' and E("document.querySelectorAll('.sr-sheet').length") == 0)
    ntabs = E("document.querySelectorAll('#sr-tabs .sr-tab').length")
    E("document.querySelector('#sr-tabs [data-close=\"nt-units\"]').click()")
    page.wait_for_timeout(100)
    check('closing the current tab shows a neighbour', E('SR.reader.current()') == 'nt-moves' and E("document.querySelectorAll('#sr-tabs .sr-tab').length") == ntabs - 1)

    # ---- demo drawer: reset needs a second tap
    E("document.getElementById('sr-demo').click()")
    rb = '.sr-sheet[data-sheet="demo"] [data-demo="reset"]'
    E(f"document.querySelector('{rb}').click()")
    check('reset arms on the first tap', 'Tap again' in (E(f"T.text('{rb}')") or '') and len(E("SR.reader.inkOf('nt-units')")) == 2)
    E(f"document.querySelector('{rb}').click()")
    page.wait_for_timeout(150)
    check('reset clears ink, marks and builds', len(E("SR.reader.inkOf('nt-units')")) == 0 and E("Object.keys(SR.reader.marks()).length") == 0
          and E("SR.reader.version('nt-units')") == 1 and E('SR.reader.current()') == 'nt-moves')

    # ---- layouts
    page.set_viewport_size({'width': 1180, 'height': 820})
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, 'ipad-landscape.png'))
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_timeout(300)
    sw = E("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    check('no horizontal page scroll at phone width', sw[0] <= sw[1], sw)
    page.screenshot(path=os.path.join(OUT, 'phone.png'))
    page.set_viewport_size({'width': 820, 'height': 1180})
    page.emulate_media(color_scheme='dark')
    page.wait_for_timeout(200)
    bg = E("getComputedStyle(document.body).backgroundColor")
    check('dark scheme switches the body background', bg in ('rgb(22, 21, 20)',), bg)
    c = E("T.center('[data-a=\"moves-1\"]')")
    E(f"T.stroke(T.wave({c['left'] + 10}, {c['y']}))")
    page.wait_for_timeout(150)
    page.screenshot(path=os.path.join(OUT, 'dark.png'))
    page.emulate_media(color_scheme='light')
    seen = []
    for _ in range(3):
        E("document.getElementById('sr-theme').click()")
        seen.append([E("document.documentElement.getAttribute('data-theme')"), E("getComputedStyle(document.body).backgroundColor")])
    check('theme button cycles light, dark, auto', seen == [['light', 'rgb(244, 242, 238)'], ['dark', 'rgb(22, 21, 20)'], [None, 'rgb(244, 242, 238)']], seen)

    errs = real_errors(errors)
    check('no console errors (fixture build)', not errs, errs[:5])
    b.close()


def no_engine_suite(pw, base):
    # The shell without engine.js: docs, links and ink still work; a mark is only noted, nothing rebuilds.
    b = pw.chromium.launch()
    page = b.new_page(viewport={'width': 820, 'height': 1000})
    errors = []
    attach_errors(page, errors)
    page.goto(base + '/host-noengine.html')
    wait_ready(page)
    E = page.evaluate
    check('no engine: the doc renders', E('SR.reader.current()') == 'nt-moves' and not E('!!SR.engine'))
    E("T.tap('.ref[data-to=\"nt-units#unit-gcd\"]', 'touch')")
    page.wait_for_timeout(100)
    check('no engine: links work', E('SR.reader.current()') == 'nt-units')
    E("document.getElementById('sr-back').click()")
    page.wait_for_timeout(100)
    E("T.tap('.mark[data-key=\"nt-moves#moves-2\"]', 'mouse')")
    E("document.querySelector('.markmenu [data-verb=\"lost\"]').click()")
    page.wait_for_timeout(100)
    check('no engine: a lost mark is only noted', E("SR.reader.marks()['nt-moves#moves-2'].state") == 'noted' and
          not E("!!document.querySelector('.sr-scaffold')") and 'engine.js' in (E("T.text('#sr-toast')") or ''))
    check('no engine: SR.modules reports it', E("SR.modules && SR.modules['engine.js']") is False)
    errs = real_errors(errors)
    check('no console errors (no engine)', not errs, errs[:5])
    b.close()


def sandbox_suite(pw, base):
    b = pw.chromium.launch()
    page = b.new_page(viewport={'width': 820, 'height': 1000})
    errors = []
    attach_errors(page, errors)
    page.goto(base + '/sandbox.html')
    page.wait_for_timeout(500)
    fr = page.frames[1] if len(page.frames) > 1 else None
    check('sandboxed frame loaded', fr is not None)
    if not fr:
        b.close()
        return
    wait_ready(page, fr)
    check('localStorage throws in the sandbox, store falls back to memory', fr.evaluate('SR.store.persistent') is False)
    c = fr.evaluate("T.center('[data-a=\"moves-1\"]')")
    fr.evaluate(f"T.stroke(T.wave({c['left'] + 10}, {c['y']}))")
    check('ink works without localStorage', len(fr.evaluate("SR.reader.inkOf('nt-moves')")) == 1)
    fr.evaluate("T.tap('.ref[data-to=\"nt-units#unit-gcd\"]', 'touch')")
    check('links work without localStorage', fr.evaluate('SR.reader.current()') == 'nt-units')
    errs = real_errors(errors)
    check('no console errors in the sandbox', not errs, errs[:5])
    b.close()


def real_input_suite(pw, base):
    # Real input instead of synthetic events: a touchscreen tap, a mouse drag (pointer capture,
    # coalesced events) and a CDP touch long-press.
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={'width': 820, 'height': 1180}, device_scale_factor=2, has_touch=True)
    page = ctx.new_page()
    errors = []
    attach_errors(page, errors)
    page.goto(base + '/host-fixture.html')
    wait_ready(page)
    E = page.evaluate
    E("SR.reader.reset()")
    mathjax_status(page)  # typesetting moves text; measure after it settles
    page.wait_for_timeout(300)
    c = E("""T.center('[data-a="moves-1"]')""")
    page.mouse.move(c['left'] + 10, c['y'])
    page.mouse.down()
    for i in range(1, 16):
        page.mouse.move(c['left'] + 10 + i * 10, c['y'] + (4 if i % 2 else -4))
    page.mouse.up()
    page.wait_for_timeout(50)
    st = E("SR.reader.inkOf('nt-moves')")
    check('real mouse drag draws one anchored stroke', len(st) == 1 and st[0]['at']['a'] == 'moves-1' and len(st[0]['p']) >= 10, [len(st)] + ([st[0]['at']] if st else []))
    r = E("""T.center('.ref[data-to="nt-units#euler"]')""")
    cdp = ctx.new_cdp_session(page)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': r['left'] + 6, 'y': r['y']}]})
    page.wait_for_timeout(700)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(250)
    check('real touch long-press peeks without navigating', not E("document.getElementById('sr-peek').hidden") and E('SR.reader.current()') == 'nt-moves')
    E("SR.reader.closePeek()")
    r = E("""T.center('.ref[data-to="nt-units#unit-gcd"]')""")
    page.touchscreen.tap(r['left'] + 6, r['y'])
    page.wait_for_timeout(250)
    check('real touchscreen tap follows a link', E('SR.reader.current()') == 'nt-units')
    check('real touch never draws', len(E("SR.reader.inkOf('nt-units')")) == 0)
    errs = real_errors(errors)
    check('no console errors (real input)', not errs, errs[:5])
    b.close()


def engine_suite(pw, base):
    # Fixture content with the real engine.js (no blocks), from the seed: nt-units starts weak, so a lost
    # mark on a passage resting on it rebuilds the basic; the reader must act on the engine's results and
    # never log twice.
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={'width': 820, 'height': 1180}, device_scale_factor=2)
    page = ctx.new_page()
    errors = []
    attach_errors(page, errors)
    page.goto(base + '/host-fixture.html')
    wait_ready(page)
    E = page.evaluate
    check('engine loaded with the fixture', E("!!(SR.engine && SR.engine.triage)"))
    check('simulated clock in the header', 'Simulated clock' in (E("T.text('#sr-clock')") or ''))
    E("T.tap('.mark[data-key=\"nt-moves#moves-2\"]', 'mouse')")
    E("document.querySelector('.markmenu [data-verb=\"lost\"]').click()")
    page.wait_for_timeout(200)
    check('engine: lost on a passage resting on a weak basic rebuilds the basic', E("SR.engine.docVersion('nt-units')") == 2 and E("SR.reader.version('nt-units')") == 2)
    check('engine: scaffold banner links the rebuilt basic', E("!!document.querySelector('.sr-scaffold .sr-sc-banner .ref[data-to=\"nt-units\"]')"))
    rebuilt_logs = E("SR.engine.changes('nt-units').filter(c => /Rebuilt (whole )?from its prerequisites/.test(c.text)).length")
    check('engine: the rebuild is logged once', rebuilt_logs == 1, rebuilt_logs)
    check('engine: the topic doc logs where the gap was', E("SR.engine.changes('nt-moves').length") == 1)
    E("T.tap('.mark[data-key=\"nt-moves#moves-2\"]', 'mouse')")
    E("document.querySelector('.markmenu [data-verb=\"lost\"]').click()")
    page.wait_for_timeout(150)
    check('engine: lost again once the basic is rebuilt scaffolds', E("SR.reader.marks()['nt-moves#moves-2'].state") == 'struggling')
    box = E("T.center('.sr-scaffold[data-key=\"nt-moves#moves-2\"] .sr-ink canvas')")
    E(f"T.stroke(T.wave({box['left'] + 20}, {box['top'] + 40}, 140))")
    page.wait_for_timeout(100)
    check('engine: an attempt alone, same day, stays struggling', E("SR.reader.marks()['nt-moves#moves-2'].state") == 'struggling')
    E("document.getElementById('sr-demo').click()")
    E("document.querySelector('[data-demo=\"day\"]').click()")
    page.wait_for_timeout(150)
    check('engine: a day later with ink the mark turns eligible by itself', E("SR.reader.marks()['nt-moves#moves-2'].state") == 'eligible')
    E("SR.sheet.closeAll()")
    btn = '.sr-scaffold [data-sc-act="rewrite"]'
    E(f"document.querySelector('{btn}').click()")
    E(f"document.querySelector('{btn}').click()")
    page.wait_for_timeout(200)
    check('engine: rewrite swaps the passage', E("!!document.querySelector('#sr-dochost .sr-rewritten[data-a=\"moves-2\"]')"))
    check('engine: rewrite spends the engine budget', E("SR.engine.budget('nt-moves').used") == 1)
    rw_logs = E("SR.engine.changes('nt-moves').filter(c => /Rewrote #moves-2/.test(c.text)).length")
    check('engine: the rewrite is logged once', rw_logs == 1, rw_logs)
    E("T.tap('.mark[data-key=\"nt-moves#trap-1\"]', 'mouse')")
    E("document.querySelector('.markmenu [data-verb=\"forgot\"]').click()")
    page.wait_for_timeout(100)
    check('engine: forgot is noted with the engine reason', 'forgot' in (E("T.text('#sr-toast')") or '').lower())
    page.screenshot(path=os.path.join(OUT, 'engine-rewrite.png'))
    E("document.getElementById('sr-changes').click()")
    page.wait_for_timeout(100)
    page.screenshot(path=os.path.join(OUT, 'engine-changes.png'))
    E("SR.sheet.closeAll()")
    E("T.tap('.ref[data-to=\"nt-units#euler\"]', 'touch')")
    page.wait_for_timeout(150)
    check('engine: the basic opens at build 2', '2 of 2' in (E("T.text('#sr-dochost .meta')") or ''))
    E("document.getElementById('sr-demo').click()")
    for sel in ('[data-area=\"nt\"]', '[data-demo=\"comfy\"]', '[data-demo=\"miss\"]'):
        E(f"document.querySelector('.sr-sheet[data-sheet=\"demo\"] {sel}').click()")
        page.wait_for_timeout(60)
    rb = '.sr-sheet[data-sheet="demo"] [data-demo="reset"]'
    E(f"document.querySelector('{rb}').click()")
    E(f"document.querySelector('{rb}').click()")
    page.wait_for_timeout(200)
    check('engine: reset puts the basic back to build 1', E("SR.engine.docVersion('nt-units')") == 1 and E("SR.reader.version('nt-units')") == 1)
    check('engine: reset clears marks and budget', E("Object.keys(SR.reader.marks()).length") == 0 and E("SR.engine.budget('nt-moves').used") == 0)
    errs = real_errors(errors)
    check('no console errors (engine build)', not errs, errs[:5])
    b.close()


def full_suite(pw, base):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={'width': 820, 'height': 1180}, device_scale_factor=2)
    page = ctx.new_page()
    errors = []
    attach_errors(page, errors)
    page.goto(base + '/host-full.html')
    try:
        wait_ready(page)
    except Exception as e:
        check('full build boots', False, str(e)[:200])
        print('\n'.join(real_errors(errors)[:10]))
        b.close()
        return
    E = page.evaluate
    check('full build boots', True)
    docs = E('SR.reader.docs()')
    note('full build docs: ' + ', '.join(docs))
    blocks = E('SR.blocks.types()')
    note('registered blocks: ' + (', '.join(blocks) or 'none'))
    mathjax_status(page, 8000)
    page.wait_for_timeout(500)
    page.screenshot(path=os.path.join(OUT, 'full-ipad.png'))
    refs = E("[...document.querySelectorAll('#sr-dochost .ref[data-to]')].map(r => r.dataset.to)")
    check('full build doc has links', len(refs) > 0, refs[:5])
    if refs:
        start = E('SR.reader.current()')
        E("T.tap(document.querySelector('#sr-dochost .ref[data-to]'), 'touch')")
        page.wait_for_timeout(200)
        target = refs[0].split('#')[0]
        check('full build: a link opens its target', E('SR.reader.current()') == target, (start, refs[0], E('SR.reader.current()')))
        page.screenshot(path=os.path.join(OUT, 'full-target.png'))
        E("document.getElementById('sr-back').click()")
    for name in ('today', 'map'):
        E(f"document.getElementById('sr-{name}').click()")
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(OUT, f'full-{name}.png'))
        E("SR.sheet.closeAll()")
        E("document.querySelectorAll('.sr-backdrop').forEach(x => x.click())")
    errs = real_errors(errors)
    check('no console errors (full build)', not errs, errs[:8])
    b.close()


def main():
    ok = build(['--fixture', '--bare', '--add', 'engine.js'], 'test/out/fixture.html')
    if ok:
        contract(os.path.join(OUT, 'fixture.html'))
        host_wrap(os.path.join(OUT, 'fixture.html'), os.path.join(OUT, 'host-fixture.html'))
        open(os.path.join(OUT, 'sandbox.html'), 'w', encoding='utf-8').write(
            '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
            '<iframe sandbox="allow-scripts" src="host-fixture.html" style="border:0;width:100vw;height:100vh"></iframe></body></html>')
    noeng = build(['--fixture', '--bare'], 'test/out/fixture-noengine.html')
    if noeng:
        host_wrap(os.path.join(OUT, 'fixture-noengine.html'), os.path.join(OUT, 'host-noengine.html'))
    full = (not ONLY_FIXTURE) and os.path.exists(os.path.join(ROOT, 'src', 'content.js'))
    if full and build([], 'test/out/full.html'):
        contract(os.path.join(OUT, 'full.html'))
        host_wrap(os.path.join(OUT, 'full.html'), os.path.join(OUT, 'host-full.html'))
    elif not full:
        note('full build skipped (src/content.js missing or --fixture)')
    srv = serve(OUT)
    base = f'http://127.0.0.1:{srv.server_address[1]}'
    try:
        with sync_playwright() as pw:
            if ok:
                fixture_suite(pw, base)
                sandbox_suite(pw, base)
                real_input_suite(pw, base)
                engine_suite(pw, base)
            if noeng:
                no_engine_suite(pw, base)
            if full and os.path.exists(os.path.join(OUT, 'host-full.html')):
                full_suite(pw, base)
    finally:
        srv.shutdown()
    print(f"\n{len(failures)} failed" + (': ' + ', '.join(failures) if failures else '') + (f"; {len(notes)} notes" if notes else ''))
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()

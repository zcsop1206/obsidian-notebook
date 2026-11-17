# End-to-end journey through the combined study reader, in headless Chromium, with real input where it
# matters: Playwright mouse clicks and drags, CDP touch for the long-press peek, and CDP pen events for the
# Pencil (pointerType 'pen').
#
#   python test/e2e.py             # builds index.html, checks the page contract, runs the journey at
#                                  # 1024x768 and at 390x844, then reloads and checks persistence
#
# The journey: (1) nt-moves, follow a link with a click, peek with a long press, back; (2) lost mark on a
# topic passage -> scaffold; a day later, with ink in the attempt box, still lost -> eligible -> rewrite ->
# Changes logs it, budget 1 of 3; (3) lost mark in nt-units -> the whole basic is rebuilt to build 2 and doc
# ink follows its anchor; (4) three pen strokes in a fog block, a reveal, a stroke in the after colour;
# (5) Demo: nt comfortable -> fog levels move up, Today shows hidden '?' problems; open one, write a call,
# commit, settle missed with method ticks -> rating drops, links back; (6) k-lfsr: commit a call, paste the
# reference design from test/kata-solutions.txt into the editor, run -> PASS; (7) Map -> ledger blockers;
# (8) no console errors and no horizontal scroll anywhere. Screenshots go to test/out/e2e-<width>-*.png.
# Exits non-zero if any check fails.
import functools, http.server, json, os, re, subprocess, sys, threading
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
MATHJAX = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js'

failures, notes = [], []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(name)
    return ok


def note(msg):
    print('NOTE ' + msg)
    notes.append(msg)


# ---------------------------------------------------------------- build and the page contract
def build():
    r = subprocess.run(['node', 'build.mjs', '--quiet'], cwd=ROOT, capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    print(out)
    check('node build.mjs writes index.html', r.returncode == 0, out[-300:])
    check('build prints no contract warnings', 'warning' not in out.lower(), out[-300:])
    return r.returncode == 0


def contract(path):
    t = open(path, encoding='utf-8').read()
    check('contract: first line is <title>Study Reader</title>', t.split('\n', 1)[0] == '<title>Study Reader</title>', t[:60])
    bad = [w for w, rx in (('doctype', r'<!doctype'), ('<html>', r'<html[\s>]'), ('<head>', r'<head[\s>]'), ('<body>', r'<body[\s>]'),
                           ('viewport meta', r'<meta[^>]*viewport')) if re.search(rx, t, re.I)]
    check('contract: no doctype, html, head, body or viewport meta', not bad, bad)
    calls = [w for w, rx in (('alert(', r'(?<![.\w$])alert\s*\('), ('confirm(', r'(?<![.\w$])confirm\s*\('), ('prompt(', r'(?<![.\w$])prompt\s*\('),
                             ('eval(', r'(?<![.\w$])eval\s*\('), ('new Function(', r'\bnew\s+Function\s*\('), ('window.open(', r'window\.open\s*\('),
                             ('fetch(', r'(?<![.\w$])fetch\s*\('), ('XMLHttpRequest', r'XMLHttpRequest')) if re.search(rx, t)]
    check('contract: no alert, confirm, prompt, eval, new Function, window.open, fetch or XHR', not calls, calls)
    srcs = re.findall(r'<script\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\']', t, re.I)
    check('contract: the only external script is MathJax 3.2.2, pinned', srcs == [MATHJAX], srcs)
    check('contract: no external stylesheet', not re.search(r'<link\b[^>]*stylesheet', t, re.I))
    check('contract: MathJax config set before the MathJax tag', t.find('window.MathJax = {') < t.find(MATHJAX) and "fontCache: 'global'" in t)
    check('contract: under 16 MB', len(t.encode('utf-8')) < 16 * 1024 * 1024, len(t))
    labels = ("Written by a model for Adit. Not Adit's words." in t or "Written by a model for Adit. Not Adit&#39;s words." in t) and 'Demo data' in t
    check('contract: model and demo-data labels present', labels)


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
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=directory))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def solution(kata_id):
    text = open(os.path.join(HERE, 'kata-solutions.txt'), encoding='utf-8').read()
    m = re.search(r'^=== ' + re.escape(kata_id) + r' ===\s*$(.*?)(?=^=== |\Z)', text, re.M | re.S)
    return m.group(1).strip() + '\n'


# ---------------------------------------------------------------- page helpers (installed in the page)
HELPERS = r"""() => {
  if (window.E2E) return;
  const ptr = [];
  document.addEventListener('pointerdown', (e) => { ptr.push(e.pointerType); if (ptr.length > 50) ptr.shift(); }, true);
  window.E2E = {
    ptr,
    el(sel, scope) { const root = scope ? document.querySelector(scope) : document; return root ? root.querySelector(sel) : null; },
    /* Scrolls the element to the middle of its scroll containers, then returns its client rect. */
    rect(sel, scope) {
      const el = typeof sel === 'string' ? E2E.el(sel, scope) : sel;
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
    hscroll() { const d = document.documentElement; return { sw: d.scrollWidth, cw: d.clientWidth, bw: document.body.scrollWidth }; },
    /* Pixels of a canvas inside a client rect: [alpha > 40, near rgb within tol]. */
    pixels(canvas, rect, rgb, tol) {
      if (typeof canvas === 'string') canvas = document.querySelector(canvas);
      const cr = canvas.getBoundingClientRect(), k = canvas.width / cr.width;
      const x = Math.max(0, Math.floor((rect.x - cr.left) * k)), y = Math.max(0, Math.floor((rect.y - cr.top) * k));
      const w = Math.min(canvas.width - x, Math.ceil(rect.w * k)), h = Math.min(canvas.height - y, Math.ceil(rect.h * k));
      if (w <= 0 || h <= 0) return [0, 0];
      const d = canvas.getContext('2d').getImageData(x, y, w, h).data;
      let n = 0, c = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 40) n++;
        if (rgb && d[i + 3] > 150 && Math.abs(d[i] - rgb[0]) <= tol && Math.abs(d[i + 1] - rgb[1]) <= tol && Math.abs(d[i + 2] - rgb[2]) <= tol) c++;
      }
      return [n, c];
    },
    rgb(token) {
      const s = SR.css(token), m = /^#([0-9a-f]{6})$/i.exec(s);
      if (m) { const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
      const r = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
      return r ? [+r[1], +r[2], +r[3]] : null;
    },
    topSheet() { const s = SR.sheet.top(); return s ? s.el.getAttribute('data-sheet') : null; },
    text(sel, scope) { const el = E2E.el(sel, scope); return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  };
}"""


class Journey:
    def __init__(self, pw, base, w, h, mobile):
        self.w, self.h, self.tag = w, h, f'{w}'
        self.b = pw.chromium.launch()
        self.ctx = self.b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, has_touch=True, is_mobile=mobile)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append('pageerror: ' + str(e)))
        self.page.on('console', lambda m: m.type == 'error' and self.errors.append('console: ' + m.text))
        self.cdp = self.ctx.new_cdp_session(self.page)
        self.base = base
        self.shot_n = 0
        self.hs = []

    # ---- basics
    def E(self, js, arg=None):
        return self.page.evaluate(js, arg) if arg is not None else self.page.evaluate(js)

    def wait(self, ms):
        self.page.wait_for_timeout(ms)

    def name(self, s):
        return f'[{self.tag}] {s}'

    def ok(self, s, cond, detail=''):
        return check(self.name(s), cond, detail)

    def open(self):
        self.page.goto(self.base + '/host-e2e.html')
        self.page.wait_for_function('() => window.SR && SR.reader && SR.reader.current && !!SR.reader.current()', timeout=20000)
        self.E(HELPERS)

    def mathjax(self):
        try:
            self.page.wait_for_function("() => !!document.querySelector('#sr-dochost mjx-container') && SR.mathReady()", timeout=20000)
            return True
        except Exception:
            return False

    def shot(self, label, full=False):
        self.shot_n += 1
        self.wait(250)
        self.page.screenshot(path=os.path.join(OUT, f'e2e-{self.tag}-{self.shot_n}-{label}.png'), full_page=full)

    def hscroll(self, where):
        x = self.E('E2E.hscroll()')
        if x['sw'] > x['cw'] or x['bw'] > x['cw']:
            self.hs.append((where, x))

    # ---- real input
    def click(self, sel):
        self.page.locator(sel).first.click(timeout=8000)
        self.wait(120)

    def rect(self, sel, scope=None):
        r = self.E('([s, c]) => E2E.rect(s, c)', [sel, scope])
        self.wait(60)
        return self.E('([s, c]) => { const el = E2E.el(s, c); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2}; }', [sel, scope]) if r else None

    def mouse_stroke(self, pts):
        m = self.page.mouse
        m.move(pts[0][0], pts[0][1])
        m.down()
        for x, y in pts[1:]:
            m.move(x, y)
        m.up()
        self.wait(60)

    def pen_stroke(self, pts):
        """The Pencil: CDP mouse events with pointerType 'pen' arrive as pen PointerEvents."""
        def ev(t, x, y, buttons):
            self.cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': x, 'y': y, 'button': 'left', 'buttons': buttons,
                                                       'clickCount': 1, 'pointerType': 'pen', 'force': 0.5})
        ev('mousePressed', pts[0][0], pts[0][1], 1)
        for x, y in pts[1:]:
            ev('mouseMoved', x, y, 1)
        ev('mouseReleased', pts[-1][0], pts[-1][1], 0)
        self.wait(60)

    def long_press(self, x, y, ms=700):
        self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        self.wait(ms)
        self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        self.wait(250)

    @staticmethod
    def wave(x0, y0, w, n=18, amp=5):
        import math
        return [(x0 + j * w / n, y0 + amp * math.sin(j / 2.5)) for j in range(n + 1)]

    def close_sheets(self):
        self.E('SR.sheet.closeAll()')
        self.wait(120)

    def open_doc(self, doc_id):
        """Library, then the row: the way a finger would get there."""
        self.close_sheets()
        self.click('#sr-lib')
        self.click(f'.sr-sheet[data-sheet="library"] .sr-librow[data-open="{doc_id}"]')
        self.wait(250)
        return self.E('SR.reader.current()') == doc_id

    def mark(self, key, verb):
        self.click(f'.mark[data-key="{key}"]')
        self.click(f'.markmenu[data-key="{key}"] [data-verb="{verb}"]')
        self.wait(250)

    # ---------------------------------------------------------------- the steps
    def step1_links(self):
        self.ok('opens on nt-moves', self.E('SR.reader.current()') == 'nt-moves', self.E('SR.reader.current()'))
        if self.mathjax():
            self.ok('MathJax typeset the doc', True)
        else:
            note(self.name('MathJax did not typeset within 20 s (CDN unreachable?); raw TeX stays readable'))
        self.wait(300)
        link = '#sr-dochost .ref[data-to="nt-units#order-thm"]'
        self.rect(link)
        self.click(link)
        self.wait(250)
        self.ok('a mouse click on a link opens its target', self.E('SR.reader.current()') == 'nt-units', self.E('SR.reader.current()'))
        self.ok('the target passage flashes', self.E("""!!document.querySelector('#sr-dochost [data-a="order-thm"].flash')"""))
        self.ok('Back shows', self.E("!document.getElementById('sr-back').hidden"))
        r = self.rect('#sr-dochost .ref[data-to^="nt-divisibility"]')
        self.long_press(r['x'] + min(8, r['w'] / 2), r['cy'])
        self.ok('a touch long press opens a peek', self.E("!document.getElementById('sr-peek').hidden"))
        self.ok('the peek does not navigate', self.E('SR.reader.current()') == 'nt-units')
        pk = self.E("E2E.text('#sr-peek')")
        self.ok('the peek shows the target passage, and no proof steps', 'Divisibility' in pk and
                not self.E("!!document.querySelector('#sr-peek .fg-step, #sr-peek .blk')"), pk[:120])
        self.shot('peek')
        self.click('#sr-peek [data-close]')
        self.ok('the peek closes', self.E("document.getElementById('sr-peek').hidden"))
        self.click('#sr-back')
        self.wait(200)
        self.ok('Back returns to nt-moves', self.E('SR.reader.current()') == 'nt-moves')
        self.hscroll('links')

    def step2_scaffold_rewrite(self):
        key = 'nt-moves#cue-split'
        self.mark(key, 'lost')
        m = self.E(f"SR.reader.marks()['{key}']") or {}
        self.ok('lost on a topic passage: struggling, with a scaffold', m.get('state') == 'struggling' and
                self.E(f"""!!document.querySelector('.sr-scaffold[data-key="{key}"]')"""), m.get('state'))
        basics = self.E(f"""[...document.querySelectorAll('.sr-scaffold[data-key="{key}"] .sr-sc-basics .ref')].map(a => a.dataset.to)""")
        self.ok('the scaffold links the basics the passage rests on', 'nt-crt' in basics, basics)
        self.ok('no rewrite offered yet', not self.E(f"""!!document.querySelector('.sr-scaffold[data-key="{key}"] [data-sc-act="rewrite"]')"""))
        self.shot('scaffold')
        # a day later, by the Demo drawer's clock
        day0 = self.E('SR.engine.today()')
        self.click('#sr-demo')
        self.click('.sr-sheet[data-sheet="demo"] [data-demo="day"]')
        self.close_sheets()
        self.ok('Demo: the simulated clock moved a day', self.E('SR.engine.today()') != day0)
        canvas = f'.sr-scaffold[data-key="{key}"] .sr-sc-ink canvas'
        r = self.rect(canvas)
        self.pen_stroke(self.wave(r['x'] + r['w'] * 0.1, r['y'] + r['h'] * 0.3, r['w'] * 0.5))
        self.pen_stroke(self.wave(r['x'] + r['w'] * 0.1, r['y'] + r['h'] * 0.55, r['w'] * 0.4))
        self.ok('the Pencil writes in the attempt box (pen events)', self.E(f"(SR.store.get('attempt-{key}') || []).length") == 2 and
                self.E('E2E.ptr.slice(-1)[0]') == 'pen', self.E('E2E.ptr.slice(-3)'))
        self.mark(key, 'lost')
        self.ok('still lost a day later with ink: eligible', self.E(f"SR.reader.marks()['{key}'].state") == 'eligible')
        btn = f'.sr-scaffold[data-key="{key}"] [data-sc-act="rewrite"]'
        self.ok('the rewrite control shows the budget', '3 of 3 left' in self.E(f"E2E.text('{btn}')"), self.E(f"E2E.text('{btn}')"))
        self.click(btn)
        self.ok('the first tap only arms it', 'Tap again' in self.E(f"E2E.text('{btn}')") and not self.E("""!!document.querySelector('#sr-dochost .sr-rewritten[data-a="cue-split"]')"""))
        self.click(btn)
        self.wait(300)
        self.ok('the second tap swaps in the rewrite', self.E("""!!document.querySelector('#sr-dochost .sr-rewritten[data-a="cue-split"]')"""))
        self.click('#sr-changes')
        ch = self.E("""E2E.text('.sr-sheet[data-sheet="changes"]')""")
        self.ok('Changes logs the rewrite once', ch.count('Rewrote #cue-split') == 1, ch[:200])
        self.ok('Changes shows the budget at 1 of 3 used', '1 of 3 rewrites used' in ch, ch[:200])
        self.ok('the engine agrees: budget 1 of 3', self.E("SR.engine.budget('nt-moves')") == {'used': 1, 'max': 3, 'left': 2})
        self.shot('changes')
        self.close_sheets()
        self.hscroll('rewrite')

    def step3_rebuild(self):
        self.ok('library opens nt-units at build 1', self.open_doc('nt-units') and self.E("SR.reader.version('nt-units')") == 1)
        # one stroke on a passage build 2 keeps word for word (#ex-order), one on a passage it rewrites (#ex-units)
        for a in ('ex-order', 'ex-units'):
            r = self.rect(f'#sr-dochost [data-a="{a}"]')
            self.mouse_stroke(self.wave(r['x'] + r['w'] * 0.15, r['cy'], r['w'] * 0.4))
        ink = self.E("SR.reader.inkOf('nt-units')")
        self.ok('mouse strokes land in the doc ink, anchored to the passages under them', [s['at']['a'] for s in ink] == ['ex-order', 'ex-units'],
                [s.get('at') for s in ink])
        dy0 = {s['at']['a']: s['at']['dy'] for s in ink}
        self.mark('nt-units#unit-gcd', 'lost')
        self.wait(400)
        toast = self.E("E2E.text('#sr-toast')")
        self.ok('lost in a basic: the whole basic is rebuilt to build 2', self.E("SR.engine.docVersion('nt-units')") == 2 and
                self.E("SR.reader.version('nt-units')") == 2 and self.E("""!!document.querySelector('#sr-dochost [data-a="v2-stands"]')"""))
        A = self.E("(() => { const o = {}; ['ex-order', 'ex-units'].forEach(a => { const x = SR.reader.anchors()[a]; o[a] = x ? {top: x.top, rev: x.rev} : null; }); return o; })()")
        st = {s['at']['a']: s['at'] for s in self.E("SR.reader.inkOf('nt-units')")}
        self.ok('ink is re-anchored: both strokes move down with their passages in build 2',
                all(A.get(a) and A[a]['top'] - dy0[a] > 20 for a in dy0), (A, dy0))
        self.ok('ink on the unchanged passage follows it at full strength', A['ex-order'] and A['ex-order']['rev'] == st['ex-order']['rev'])
        self.ok('ink on the rewritten passage is dimmed, with keep/delete', A['ex-units'] and A['ex-units']['rev'] != st['ex-units']['rev'] and
                self.E("""!!document.querySelector('#sr-ovl .cchip [data-act="keep"][data-a="ex-units"]')"""))
        m = re.search(r'(\d+) strokes? followed (?:its anchor|their anchors), (\d+) on rewritten text, (\d+) orphaned', toast)
        self.ok('the rebuild toast counts 1 followed, 1 on rewritten text, 0 orphaned', bool(m) and m.groups() == ('1', '1', '0'), toast)
        r2 = self.rect('#sr-dochost [data-a="ex-order"]')
        px = self.E('([r]) => E2E.pixels("#sr-stack > canvas.sr-ink-canvas", r)', [{'x': r2['x'], 'y': r2['y'], 'w': r2['w'], 'h': r2['h']}])
        self.ok('the followed stroke is drawn at its passage in build 2', px[0] > 15, px)
        ch = self.E("SR.engine.changes('nt-units').map(c => c.text).join(' | ')")
        self.ok('the rebuild is logged in the basic\'s Changes', 'Rebuilt whole from its prerequisites (build 2)' in ch, ch[:160])
        self.shot('rebuild')
        self.hscroll('rebuild')

    def step4_fog(self):
        fog = '#sr-dochost .blk[data-block="fog"][data-id="f-unit-gcd-v2"]'
        self.ok('the build 2 proof is fogged step by step (push 0)', self.E(f"(document.querySelector('{fog}') || {{}}).getAttribute && document.querySelector('{fog}').getAttribute('data-mode')") == 'steps')
        self.ok('no step text is in the page before a reveal', self.E(f"document.querySelectorAll('{fog} .fg-step.shown').length") == 0)
        canvas = fog + ' .fg-ink canvas'
        r = self.rect(canvas)
        for i in range(3):
            self.pen_stroke(self.wave(r['x'] + r['w'] * 0.08, r['y'] + r['h'] * (0.18 + 0.12 * i), r['w'] * 0.5))
        reveal = fog + ' [data-fog="reveal"]'
        self.ok('three pen strokes open the reveal', self.E(f"!document.querySelector('{reveal}').disabled") and
                'Reveal step 1' in self.E(f"E2E.text('{reveal}')"), self.E(f"E2E.text('{reveal}')"))
        self.click(reveal)
        self.wait(200)
        self.ok('one step is revealed', self.E(f"document.querySelectorAll('{fog} .fg-step.shown').length") == 1)
        r = self.rect(canvas)
        y4 = r['y'] + r['h'] * 0.62
        self.pen_stroke(self.wave(r['x'] + r['w'] * 0.08, y4, r['w'] * 0.5, amp=6))
        strokes = self.E("SR.fog.stateOf('f-unit-gcd-v2').strokes.map(s => s.e || 0)")
        self.ok('strokes carry their reveal count (provenance)', strokes == [0, 0, 0, 1], strokes)
        after = self.E("E2E.rgb('--after')")
        r = self.rect(canvas)
        band = {'x': r['x'] + r['w'] * 0.05, 'y': r['y'] + r['h'] * 0.62 - 14, 'w': r['w'] * 0.6, 'h': 28}
        px = self.E('([c, b, rgb]) => E2E.pixels(c, b, rgb, 40)', [canvas, band, after])
        self.ok('the stroke after the reveal is drawn in the after colour', px[1] > 30, (px, after))
        band0 = {'x': r['x'] + r['w'] * 0.05, 'y': r['y'] + r['h'] * 0.18 - 14, 'w': r['w'] * 0.6, 'h': 28}
        px0 = self.E('([c, b, rgb]) => E2E.pixels(c, b, rgb, 40)', [canvas, band0, after])
        self.ok('strokes before the reveal are not', px0[1] < 5, px0)
        self.shot('fog')
        self.hscroll('fog')

    def step5_push_today_problem(self):
        modes = {}
        for doc in ('nt-crt', 'nt-divisibility'):
            self.open_doc(doc)
            modes[doc] = self.E("[...document.querySelectorAll('#sr-dochost .blk[data-block=\"fog\"]')].map(b => b.getAttribute('data-mode'))")
        self.ok('seeded push levels: nt-crt proofs in chunks, nt-divisibility proofs cold',
                modes['nt-crt'] and set(modes['nt-crt']) == {'chunks'} and modes['nt-divisibility'] and set(modes['nt-divisibility']) == {'cold'}, modes)
        self.click('#sr-demo')
        self.click('.sr-sheet[data-sheet="demo"] [data-area="nt"]')
        self.click('.sr-sheet[data-sheet="demo"] [data-demo="comfy"]')
        self.close_sheets()
        self.ok('Demo: nt is in push mode', self.E("SR.engine.inPush('nt')") is True)
        self.open_doc('nt-crt')
        hooks = self.E("[...document.querySelectorAll('#sr-dochost .blk[data-block=\"fog\"]')].map(b => b.getAttribute('data-mode'))")
        self.ok('idle proofs follow push 3: problem-first hooks', hooks and set(hooks) == {'hook'}, hooks)
        self.open_doc('nt-units')
        kept = self.E("document.querySelector('#sr-dochost .blk[data-block=\"fog\"][data-id=\"f-unit-gcd-v2\"]').getAttribute('data-mode')")
        self.ok('the proof with an open attempt keeps its view', kept == 'steps', kept)
        self.click('#sr-today')
        self.wait(300)
        hid = self.E("""[...document.querySelectorAll('.sr-sheet[data-sheet="today"] [data-act="problem"]')].filter(b => b.querySelector('.pn-chip.q')).map(b => b.dataset.id)""")
        self.ok("Today shows a hidden-topic '?' problem", len(hid) >= 1, hid)
        if not hid:
            self.shot('today')
            return
        pid = hid[0]
        self.rect(f'.sr-sheet[data-sheet="today"] [data-act="problem"][data-id="{pid}"]')
        self.shot('today')
        card = self.E(f"""E2E.text('.sr-sheet[data-sheet="today"] [data-act="problem"][data-id="{pid}"]')""")
        area_names = ['Number theory', 'Combinatorics', 'Analysis', 'Linear algebra', 'General reasoning']
        self.ok('the hidden card names no area or topic', not any(a in card for a in area_names), card)
        self.click(f'.sr-sheet[data-sheet="today"] [data-act="problem"][data-id="{pid}"]')
        self.wait(300)
        sh = f'.sr-sheet[data-sheet="problem-{pid}"]'
        self.ok('the problem opens in its own panel', self.E('E2E.topSheet()') == f'problem-{pid}', self.E('E2E.topSheet()'))
        self.ok('the card hides the topic', '?' in self.E(f"E2E.text('.pb-badges', '{sh}')") and 'topic hidden' in self.E(f"E2E.text('.pb-badges', '{sh}')"))
        self.ok('confidence is locked until the call has ink', self.E(f"""document.querySelector('{sh} [data-conf="60"]').disabled"""))
        r = self.rect(f'{sh} .pb-callink canvas')
        self.pen_stroke(self.wave(r['x'] + r['w'] * 0.08, r['y'] + r['h'] * 0.3, r['w'] * 0.6))
        self.pen_stroke(self.wave(r['x'] + r['w'] * 0.08, r['y'] + r['h'] * 0.55, r['w'] * 0.45))
        self.ok('the call band takes the Pencil; confidence unlocks', not self.E(f"""document.querySelector('{sh} [data-conf="60"]').disabled"""))
        self.click(f'{sh} [data-conf="60"]')
        self.ok('a confidence chip commits the call', self.E(f"!document.querySelector('{sh} .pb-below').hidden") and
                'Committed' in self.E(f"E2E.text('.pb-stamp', '{sh}')"))
        today_card = f'.sr-sheet[data-sheet="today"] [data-act="problem"][data-id="{pid}"]'
        self.wait(150)
        self.ok('Today, under the panel, shows the attempt in progress', 'in progress' in self.E(f"E2E.text('{today_card}')"), self.E(f"E2E.text('{today_card}')"))
        r0 = self.E(f"SR.engine.rating(SR.content.problems.find(p => p.id === '{pid}').area)")
        self.click(f'{sh} [data-verb="missed"]')
        self.ok('settling takes two taps', self.E(f"!SR.engine.settled('{pid}')") and 'tap again' in self.E(f"""E2E.text('[data-verb="missed"]', '{sh}')"""))
        self.click(f'{sh} [data-verb="missed"]')
        self.wait(200)
        self.ok('with the verdict given but no ticks, Today says to finish settling', 'finish settling' in self.E(f"E2E.text('{today_card}')") and
                not self.E(f"SR.engine.settled('{pid}')"), self.E(f"E2E.text('{today_card}')"))
        self.click(f'{sh} [data-pb="cnone"]')
        self.click(f'{sh} [data-pb="calldone"]')
        if self.E(f"!!document.querySelector('{sh} [data-pb=\"guess\"]') && !document.querySelector('{sh} .pb-guess').hidden"):
            self.click(f'{sh} [data-pb="guess"]')
        if self.E(f"""document.querySelector('{sh} [data-list="took"][data-m="modular"]').getAttribute('aria-pressed')""") != 'true':
            self.click(f'{sh} [data-list="took"][data-m="modular"]')
        self.click(f'{sh} [data-pb="tookdone"]')
        self.wait(300)
        rec = self.E(f"SR.engine.settled('{pid}')") or {}
        self.ok('settled missed: the rating drops', rec.get('verdict') == 'missed' and rec.get('rAfter', 9) < r0, (r0, rec.get('rAfter')))
        self.ok('method ticks recorded: a miss, counted apart from solving', rec.get('methodHit') is False and rec.get('methodsPending') is False and
                'modular' in (rec.get('took') or []), (rec.get('methodHit'), rec.get('took')))
        res = self.E(f"E2E.text('.pb-result', '{sh}')")
        self.ok('the result shows r before and after', '→' in res and 'missed' in res.lower(), res[:160])
        links = self.E(f"[...document.querySelectorAll('{sh} .pb-back .ref')].map(a => a.dataset.to)")
        self.ok('links back to the basics it used', 'nt-units' in links, links)
        self.ok('a recognition gap is noted and logged to the Recognise list', self.E(f"!!document.querySelector('{sh} .pb-gap')") and
                self.E("SR.engine.recognise('nt-moves').length") >= 1)
        self.ok('the topic is revealed after settling', 'Topic, hidden while you worked' in self.E(f"E2E.text('.pb-reveal', '{sh}')"))
        self.shot('problem')
        self.close_sheets()
        self.hscroll('problem')

    def step8_drill(self):
        """Today's top drill opens the blank-page drill (block-drill.js) for that basic, graded into the engine."""
        self.close_sheets()
        self.click('#sr-today')
        self.wait(300)
        basic = self.E("""(document.querySelector('.sr-sheet[data-sheet="today"] [data-act="drill"]') || {dataset: {}}).dataset.basic""")
        self.ok('Today lists a drill', bool(basic), basic)
        if not basic:
            return
        stage0 = self.E(f"SR.engine.stage('{basic}')")
        self.click(f'.sr-sheet[data-sheet="today"] [data-act="drill"][data-basic="{basic}"]')
        self.wait(300)
        sh = f'.sr-sheet[data-sheet="drill-{basic}"]'
        self.ok('the drill opens in a panel, nothing shown before Start', self.E('E2E.topSheet()') == f'drill-{basic}' and
                not self.E(f"!!document.querySelector('{sh} .drl-steps')"), self.E('E2E.topSheet()'))
        self.click(f'{sh} [data-drl="start"]')
        r = self.rect(f'{sh} .drl-paper canvas')
        # the blank page is taller than the screen: write in its visible part, below the sheet's sticky bar
        y0 = max(r['y'], 0) + 130
        for i in range(3):
            self.pen_stroke(self.wave(r['x'] + r['w'] * 0.1, y0 + 50 * i, r['w'] * 0.5))
        n = self.E(f"(() => {{ const h = [...document.querySelectorAll('{sh} .sr-sheet-b > div')].find(d => d.__srDrill); const a = h && h.__srDrill.attempt(); return a ? a.strokes.length : -1; }})()")
        self.ok('the blank page takes the Pencil', n == 3, n)
        self.click(f'{sh} .drl-bar [data-drl="done"]')
        self.wait(300)
        self.ok('Done shows the model steps', self.E(f"document.querySelectorAll('{sh} .drl-steps li').length") >= 2)
        self.click(f'{sh} [data-grade="clean"]')
        self.wait(300)
        last = self.E(f"SR.engine.lastDrill('{basic}')") or {}
        self.ok('a clean grade goes to the engine and raises the stage', last.get('grade') == 'clean' and last.get('src') == 'drill' and
                self.E(f"SR.engine.stage('{basic}')") == min(5, stage0 + 1), (stage0, last))
        self.ok('the engine knows the stage rose today', self.E(f"SR.engine.roseToday('{basic}')") is True)
        self.shot('drill')
        self.close_sheets()
        self.hscroll('drill')

    def step6_kata(self):
        self.ok('library opens dd-lfsr', self.open_doc('dd-lfsr'))
        blk = '#sr-dochost .blk[data-block="kata"][data-id="k-lfsr"]'
        self.ok('k-lfsr sits inline in the doc', self.E(f"!!document.querySelector('{blk} [data-kata=\"k-lfsr\"]')"))
        small = self.E(f"document.querySelector('{blk} .kt').classList.contains('kt-small')")
        if small:
            self.rect(f'{blk} [data-k="panel"]')
            self.click(f'{blk} [data-k="panel"]')
            self.wait(300)
            scope = '.sr-sheet[data-sheet="kata-k-lfsr"]'
            self.ok('on a narrow screen the kata opens in a panel', self.E('E2E.topSheet()') == 'kata-k-lfsr')
        else:
            scope = blk
        self.ok('the editor is closed until the call is committed', not self.E(f"!!document.querySelector('{scope} .kt-src')") and
                self.E(f"""document.querySelector('{scope} [data-k="commit"]').disabled"""))
        self.rect(f'{scope} .kt-line')
        self.page.locator(f'{scope} .kt-line').fill('Galois form: shift right, XOR 8\'hB8 in when bit 0 is 1; rst loads seed')
        self.click(f'{scope} [data-conf="70"]')
        self.click(f'{scope} [data-k="commit"]')
        self.ok('committing the call opens the editor', self.E(f"!!document.querySelector('{scope} .kt-src')"))
        self.rect(f'{scope} .kt-src')
        self.page.locator(f'{scope} .kt-src').fill(solution('k-lfsr'))
        self.click(f'{scope} [data-k="run"]')
        self.wait(400)
        res = self.E(f"E2E.text('.kt-result', '{scope}')")
        self.ok('the reference design runs: PASS', res.startswith('PASS'), res[:160])
        kr = self.E("SR.engine.kataResult('k-lfsr')") or {}
        self.ok('the engine settles the kata: first run, score 1', kr.get('pass') is True and kr.get('score') == 1, (kr.get('pass'), kr.get('score')))
        self.rect(f'{scope} .kt-result')
        self.shot('kata')
        self.close_sheets()
        self.hscroll('kata')

    def step7_map(self):
        self.click('#sr-map')
        self.wait(400)
        sh = '.sr-sheet[data-sheet="map"]'
        self.ok('the Map opens', self.E('E2E.topSheet()') == 'map')
        self.ok('the basics graph is drawn', self.E(f"document.querySelectorAll('{sh} .pn-node').length") >= 5)
        blocked = self.E(f"""[...document.querySelectorAll('{sh} [data-sec="ship"] .pn-task')].filter(t => t.classList.contains('blocked') || t.classList.contains('risk')).length""")
        self.ok('ledger tasks show as blocked by weak basics', blocked >= 1, blocked)
        weak = self.E(f"""[...document.querySelectorAll('{sh} [data-sec="ship"] .pn-need .ref')].map(a => a.dataset.to)""")
        self.ok('the weak basic dd-lfsr is linked from a blocked task', 'dd-lfsr' in weak, weak)
        self.ok('ledger lines are in the ledger format', self.E(f"""[...document.querySelectorAll('{sh} .pn-line')].some(c => /^- \\[[ x]\\] .*#asic \\d{{4}}-\\d{{2}}-\\d{{2}}/.test(c.textContent))"""))
        self.rect(f'{sh} [data-sec="ship"]')
        self.shot('map')
        self.close_sheets()
        self.hscroll('map')

    def step9_reach(self):
        """The Demo drawer's three clean holds open one reach pick in Today."""
        self.click('#sr-demo')
        self.click('.sr-sheet[data-sheet="demo"] [data-area="nt"]')
        self.click('.sr-sheet[data-sheet="demo"] [data-demo="holds"]')
        self.close_sheets()
        self.click('#sr-today')
        self.wait(300)
        reach = self.E("""[...document.querySelectorAll('.sr-sheet[data-sheet="today"] [data-act="problem"]')].filter(b => b.querySelector('.pn-chip.reach')).length""")
        self.ok('Demo: three clean holds open one reach pick in Today', reach == 1, reach)
        self.close_sheets()

    def reload_on(self, doc_id):
        """Shows doc_id, reloads, and waits for MathJax: the doc and the blocks inside it typeset before MathJax was ready."""
        self.open_doc(doc_id)
        self.page.reload()
        self.page.wait_for_function('() => window.SR && SR.reader && SR.reader.current && !!SR.reader.current()', timeout=20000)
        self.E(HELPERS)
        typeset = self.mathjax()
        self.wait(500)
        raw = self.E("(document.querySelector('#sr-dochost .sr-doc').textContent.match(/\\$/g) || []).length")
        return typeset, raw

    def reload_persists(self):
        typeset, raw = self.reload_on('nt-units')
        ok = (self.E("SR.reader.version('nt-units')") == 2 and self.E("SR.engine.budget('nt-moves').used") == 1 and
              self.E("Object.keys(SR.reader.marks()).length") == 2 and self.E("(SR.engine.kataResult('k-lfsr') || {}).pass") is True and
              self.E("SR.engine.settledAll().length") == 2 and len(self.E("SR.reader.inkOf('nt-units')")) == 2)
        self.ok('after a reload: build, budget, marks, ink and settles persist', ok)
        self.ok('after a reload the revealed proof step is still revealed', self.E("document.querySelectorAll('#sr-dochost .blk[data-id=\"f-unit-gcd-v2\"] .fg-step.shown').length") == 1)
        if typeset:
            self.ok('a doc with a revealed proof step typesets fully at load (no raw TeX left)', raw == 0, raw)
        typeset, raw = self.reload_on('nt-moves')
        self.ok('after a reload the rewrite is still in place', self.E("""!!document.querySelector('#sr-dochost .sr-rewritten[data-a="cue-split"]')"""))
        self.ok('in push mode the problem-first hook opens at the top of nt-moves', self.E("!!document.querySelector('#sr-dochost .blk[data-block=\"problem\"] .pb-callink')"))
        if typeset:
            self.ok('a doc with an open problem hook typesets fully at load (no raw TeX left)', raw == 0, raw)
        else:
            note(self.name('MathJax not ready after reload; raw-TeX checks skipped'))

    def finish(self):
        errs = [e for e in self.errors if 'Failed to load resource' not in e and 'net::ERR' not in e]
        self.ok('no console errors', not errs, errs[:6])
        self.ok('no horizontal page scroll at any step', not self.hs, self.hs[:3])
        self.b.close()


def run(pw, base, w, h, mobile):
    j = Journey(pw, base, w, h, mobile)
    try:
        j.open()
        j.hscroll('start')
        for step in (j.step1_links, j.step2_scaffold_rewrite, j.step3_rebuild, j.step4_fog, j.step5_push_today_problem, j.step6_kata,
                     j.step7_map, j.step8_drill, j.step9_reach, j.reload_persists):
            try:
                step()
            except Exception as e:
                check(j.name(step.__name__ + ' ran without an exception'), False, str(e).split('\n')[0][:300])
                try:
                    j.shot('error-' + step.__name__)
                except Exception:
                    pass
    finally:
        j.finish()


def main():
    if not build():
        sys.exit(1)
    index = os.path.join(ROOT, 'index.html')
    contract(index)
    host_wrap(index, os.path.join(OUT, 'host-e2e.html'))
    srv = serve(OUT)
    base = f'http://127.0.0.1:{srv.server_address[1]}'
    try:
        with sync_playwright() as pw:
            run(pw, base, 1024, 768, False)
            run(pw, base, 390, 844, True)
    finally:
        srv.shutdown()
    print(f"\n{len(failures)} failed" + (': ' + '; '.join(failures) if failures else '') + (f"; {len(notes)} notes" if notes else ''))
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()

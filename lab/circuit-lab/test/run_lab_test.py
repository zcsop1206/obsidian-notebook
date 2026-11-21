# Chromium checks for the circuit lab: python lab/circuit-lab/test/run_lab_test.py [--shots <dir>]
# Serves lab/circuit-lab on a free port and wraps index.html in the skeleton the artifact host adds.
# Checks, at 1280 px and at 390 px: no console errors, no sideways scroll, every circuit draws, Run is
# refused until a sketch exists, a mouse sketch of the solver's curve scores ok, x2 asks for a new sketch
# over a grey ghost, the AC phasor check and the Bode sweep score ok, Pencil-only ignores touch, and the
# page works when localStorage throws. Screenshots go to lab/circuit-lab/out/ (gitignored).
import functools, http.server, os, sys, threading
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
OUT = os.path.join(LAB, 'out')
if '--shots' in sys.argv:
    OUT = os.path.abspath(sys.argv[sys.argv.index('--shots') + 1])
os.makedirs(OUT, exist_ok=True)

SKELETON = ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '<base href="../"><style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);color-scheme:light}'
            'body{margin:0;font-size:14px;font-family:system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>')


class Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.js': 'text/javascript'}

    def log_message(self, *a):
        pass


fails = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f': {detail}' if detail and not ok else ''))
    if not ok:
        fails.append(name)


def draw(page, plot_sel, pts):
    """Draws a polyline given in data coordinates on the plot, with the mouse."""
    page.locator(plot_sel + ' svg.plot').scroll_into_view_if_needed()
    screen = page.evaluate("""([sel, pts]) => {
      const svg = document.querySelector(sel + ' svg.plot');
      const P = window.__plots[sel];
      const m = svg.getScreenCTM();
      return pts.map(([x, y]) => { const p = new DOMPoint(P.px(x), P.py(y)).matrixTransform(m); return [p.x, p.y]; });
    }""", [plot_sel, pts])
    page.mouse.move(*screen[0])
    page.mouse.down()
    for p in screen[1:]:
        page.mouse.move(*p, steps=2)
    page.mouse.up()


def expose_plots(page):
    page.evaluate("""() => { const p = window.circuitLab.plots(); window.__plots = {
      '#sw-view': p.sw, '#ac-view .bode > .plot-box:nth-child(1)': p.mag, '#ac-view .bode > .plot-box:nth-child(2)': p.ph }; }""")


def perfect_switching(page, wobble=0.0):
    return page.evaluate("""(w) => {
      const s = window.circuitLab.SW.sol, T = s.tstop;
      const pre = [[-0.14 * T, s.x0m], [-0.005 * T, s.x0m]];
      const post = [];
      for (let i = 0; i <= 60; i++) { const t = 0.002 * T + (T * 0.996 * i) / 60; post.push([t, s.xinf + (s.x0p - s.xinf) * Math.exp(-t / s.tau) + w * s.top * Math.sin(i)]); }
      return [pre, post];
    }""", wobble)


def sketch_and_run(page, tag):
    run = page.locator('#sw-run')
    check(f'{tag}: Run refused before a sketch', run.is_disabled())
    pre, post = perfect_switching(page)
    draw(page, '#sw-view', pre)
    check(f'{tag}: Run still refused with only the 0- part', run.is_disabled())
    draw(page, '#sw-view', post)
    check(f'{tag}: Run allowed after the sketch', run.is_enabled(), page.locator('#sw-view .why').first.inner_text())
    run.click()
    grades = page.locator('#sw-results .pill').all_inner_texts()
    check(f'{tag}: five scored rows', len(grades) == 5, str(grades))
    bad = [g for g in grades if g not in ('ok', '—')]
    check(f'{tag}: a sketch of the solver curve scores ok', not bad, str(grades))
    check(f'{tag}: the solver curve is drawn', page.locator('#sw-view .plot .truth').count() == 1)


def run_page(page, url, width, tag):
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_selector('#sw-view svg.plot')
    page.evaluate('document.fonts.ready')
    expose_plots(page)
    over = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    check(f'{tag}: no sideways scroll ({over}px)', over <= 0)

    # Every switching circuit draws and solves.
    chips = page.locator('#sw-view .chip')
    for i in range(1, chips.count()):
        chips.nth(i).click()
        cid = chips.nth(i).get_attribute('data-id')
        check(f'{tag}: {cid} schematic', page.locator('#sw-view .sch').count() == 1)
        if width > 600:
            page.locator('#sw-view .sch-box').screenshot(path=os.path.join(OUT, f'sch-{cid}.png'))
    chips.nth(1).click()
    sketch_and_run(page, f'{tag} rc-charge')
    page.screenshot(path=os.path.join(OUT, f'{tag}-switching-run.png'), full_page=True)

    # x2 on the first element: a new prediction first, over a ghost.
    page.locator('#sw-variants button[data-var$="x2"]').first.click()
    check(f'{tag}: x2 shows the ghost curve', page.locator('#sw-view .plot .ghost-curve').count() == 1)
    check(f'{tag}: x2 clears the result', page.locator('#sw-results .pill').count() == 0)
    sketch_and_run(page, f'{tag} variant')
    check(f'{tag}: the new sketch is in the second colour', page.locator('#sw-view .plot .ink.ink2').count() >= 2)
    page.screenshot(path=os.path.join(OUT, f'{tag}-switching-variant.png'), full_page=True)

    # A circuit with a dependent source, and one with a jump at 0+.
    for cid in ('rc-cccs', 'rl-open', 'rl-ccvs'):
        page.locator(f'#sw-view .chip[data-id="{cid}"]').click()
        sketch_and_run(page, f'{tag} {cid}')

    # AC.
    page.locator('#tab-ac').click()
    for cid in ('ac-rc', 'ac-rl', 'ac-rlc', 'ac-opamp'):
        page.locator(f'#ac-view .chip[data-id="{cid}"]').click()
        if width > 600:
            page.locator('#ac-view .sch-box').screenshot(path=os.path.join(OUT, f'sch-{cid}.png'))
        check(f'{tag}: {cid} Check refused before a prediction', page.locator('#ac-check').is_disabled())
        mag, deg = page.evaluate('() => { const o = window.circuitLab.ACS.ph.out; return [Math.hypot(o[0], o[1]), Math.atan2(o[1], o[0]) * 180 / Math.PI]; }')
        page.fill('#ac-mag', f'{mag:.4g}')
        page.fill('#ac-deg', f'{deg:.1f}')
        page.locator('#ac-check').click()
        grades = page.locator('#ac-view .ph-out .pill').all_inner_texts()
        check(f'{tag}: {cid} exact phasor scores ok', grades == ['ok', 'ok'], str(grades))
        check(f'{tag}: {cid} phasor diagram', page.locator('#ac-view .ph-diagram svg line').count() >= 3)
        run = page.locator('#ac-run')
        check(f'{tag}: {cid} sweep refused before a sketch', run.is_disabled())
        expose_plots(page)
        pts = page.evaluate('() => window.circuitLab.ACS.bode.pts.filter((_, i) => i % 6 === 0).map(q => [q.f, q.db, q.ph])')
        draw(page, '#ac-view .bode > .plot-box:nth-child(1)', [[p[0], max(-59.5, p[1])] for p in pts])
        check(f'{tag}: {cid} sweep refused with one plot sketched', run.is_disabled())
        draw(page, '#ac-view .bode > .plot-box:nth-child(2)', [[p[0], p[2]] for p in pts])
        check(f'{tag}: {cid} sweep allowed', run.is_enabled())
        run.click()
        grades = page.locator('#ac-view .results .pill').all_inner_texts()
        if cid == 'ac-rc' or cid == 'ac-opamp':
            check(f'{tag}: {cid} a sketch of the sweep scores ok', grades == ['ok', 'ok'], str(grades))
        else:
            check(f'{tag}: {cid} sweep scored', len(grades) == 2, str(grades))
        if cid == 'ac-rlc':
            page.screenshot(path=os.path.join(OUT, f'{tag}-ac.png'), full_page=True)

    # Pencil only: a pen event turns it on, then touch draws nothing.
    page.locator('#tab-sw').click()
    page.locator('#sw-new').click()
    page.evaluate("""() => { const svg = document.querySelector('#sw-view svg.plot'); const r = svg.getBoundingClientRect();
      const ev = (type, pointerType, x) => svg.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType, clientX: r.left + x, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      ev('pointerdown', 'pen', 80); ev('pointermove', 'pen', 120); ev('pointerup', 'pen', 120);
      ev('pointerdown', 'touch', 80); ev('pointermove', 'touch', 200); ev('pointerup', 'touch', 200); }""")
    check(f'{tag}: a pen stroke turns Pencil only on', page.locator('#pen-only').is_checked())
    n = page.evaluate('window.circuitLab.plots().sw.strokes.length')
    check(f'{tag}: touch is ignored under Pencil only', n == 1, str(n))

    check(f'{tag}: no console errors', not errors, '; '.join(errors[:3]))
    return errors


def main():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=LAB))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with open(os.path.join(LAB, 'index.html'), encoding='utf-8') as f:
        body = f.read()
    os.makedirs(os.path.join(LAB, 'out'), exist_ok=True)
    with open(os.path.join(LAB, 'out', 'page.html'), 'w', encoding='utf-8') as f:
        f.write(SKELETON + body + '</body></html>')
    url = f'http://127.0.0.1:{srv.server_address[1]}/out/page.html'
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for width, height, tag in ((1280, 900, 'desktop'), (390, 844, 'phone')):
            ctx = b.new_context(viewport={'width': width, 'height': height}, device_scale_factor=2 if width < 600 else 1)
            run_page(ctx.new_page(), url, width, tag)
            ctx.close()
        # Dark theme screenshot, and a page whose localStorage throws.
        ctx = b.new_context(viewport={'width': 1280, 'height': 900}, color_scheme='dark')
        page = ctx.new_page()
        page.goto(url)
        page.wait_for_selector('#sw-view svg.plot')
        page.evaluate('document.fonts.ready')
        page.screenshot(path=os.path.join(OUT, 'desktop-dark.png'), full_page=True)
        ctx.close()
        ctx = b.new_context(viewport={'width': 1280, 'height': 900})
        ctx.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });")
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto(url)
        page.wait_for_selector('#sw-view svg.plot')
        check('blocked storage: the page still renders', page.locator('#sw-view .sch').count() == 1 and not errs, '; '.join(errs))
        ctx.close()
        b.close()
    srv.shutdown()
    print(f'{len(fails)} failure(s)')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()

# Renders the committed sample note (test/fixtures/sample.md and its page SVGs) in headless
# Chromium as <img>, the way Obsidian's reading view and GitHub show them, in light and dark.
# Checks that drawn pages aren't blank, that the empty page is, that default black ink switches
# colour with the colour scheme while other colours don't, and that crossing highlighter strokes
# don't darken. Run by `npm test`; screenshots land in test/out/. Exits non-zero on a failure.
import base64, os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = 8766
base_url = f'http://localhost:{port}'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(name)

BG = {'light': '#ffffff', 'dark': '#1e1e1e'}
# Colours as drawn, from the page's <style> and the fixture's pens (see test/fixture.ts).
INK = {'light': (0x1f, 0x1f, 0x1f), 'dark': (0xe6, 0xe3, 0xde)}
BLUE = (0x1e, 0x5b, 0xd8)
# Highlighters at 40% over white: green alone, and green over yellow if crossings darkened.
GREEN_HL = (177, 241, 206)
GREEN_OVER_YELLOW = (177, 231, 145)

# Counts pixels in a PNG screenshot: differing from the background, and near each given colour.
COUNT_JS = """async ([png, bg, colors]) => {
  const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
  const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const near = (i, [r, gg, b], tol) => Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - gg) <= tol && Math.abs(d[i + 2] - b) <= tol;
  let ink = 0; const counts = colors.map(() => 0);
  for (let i = 0; i < d.length; i += 4) {
    if (!near(i, bg, 8)) ink++;
    colors.forEach((col, k) => { if (near(i, col, 4)) counts[k]++; });
  }
  return { ink, counts, width: img.width, height: img.height };
}"""

def rgb(hex_):
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))

md = open(os.path.join(HERE, 'fixtures', 'sample.md'), encoding='utf8').read()
pages = re.findall(r'^!\[[^\]]*\]\(sample/(p-[0-9a-f]{6})\.svg\)$', md, re.M)
check('fixture: sample.md embeds three pages', len(pages) == 3, pages)

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(device_scale_factor=2, viewport={'width': 900, 'height': 1100})
        results = {}
        for scheme in ['light', 'dark']:
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
            page.emulate_media(color_scheme=scheme)
            page.goto(f'{base_url}/test/fixtures/')  # same origin as the images; replaced below
            for pid in pages:
                page.set_content(f"<body style='margin:0;background:{BG[scheme]}'><img id='p' src='{base_url}/test/fixtures/sample/{pid}.svg'></body>")
                page.wait_for_function("() => { const i = document.getElementById('p'); return i.complete; }")
                size = page.evaluate("() => { const i = document.getElementById('p'); return [i.naturalWidth, i.naturalHeight]; }")
                shot = page.locator('#p').screenshot(path=os.path.join(OUT, f'format_{pid}_{scheme}.png'))
                colors = [INK['light'], INK['dark'], BLUE, GREEN_HL, GREEN_OVER_YELLOW]
                r = page.evaluate(COUNT_JS, [base64.b64encode(shot).decode(), list(rgb(BG[scheme])), [list(c) for c in colors]])  # tuples don't serialize
                results[(pid, scheme)] = r
                print(f'{pid} {scheme}: natural {size}, {r["ink"]} non-background px, near [light ink, dark ink, blue, green hl, green over yellow] {r["counts"]}')
                check(f'{pid} {scheme}: loads at 816 x 1056', size == [816, 1056], size)
            # The whole note as a reading view would stack it, for a human to look at.
            imgs = ''.join(f"<p><img style='max-width:100%;display:block' src='{base_url}/test/fixtures/sample/{pid}.svg'></p>" for pid in pages)
            page.set_content(f"<body style='margin:0 auto;max-width:700px;padding:16px;background:{BG[scheme]};color:{'#222' if scheme == 'light' else '#ddd'};font-family:sans-serif'><h1>Sample ink note</h1>{imgs}</body>")
            page.wait_for_function("() => [...document.images].every(i => i.complete)")
            page.screenshot(path=os.path.join(OUT, f'format_note_{scheme}.png'), full_page=True)
            check(f'{scheme}: no page errors', not errors, errors)
            page.close()

        pen, hl, empty = pages
        for scheme in ['light', 'dark']:
            check(f'pen page {scheme}: not blank', results[(pen, scheme)]['ink'] > 5000, results[(pen, scheme)]['ink'])
            check(f'highlighter page {scheme}: not blank', results[(hl, scheme)]['ink'] > 5000, results[(hl, scheme)]['ink'])
            check(f'empty page {scheme}: blank', results[(empty, scheme)]['ink'] == 0, results[(empty, scheme)]['ink'])
            check(f'pen page {scheme}: blue ink stays blue', results[(pen, scheme)]['counts'][2] > 300, results[(pen, scheme)]['counts'])
        # counts: [near light-mode ink, near dark-mode ink, blue, ...]. The light-mode ink colour
        # can't be told apart from the dark background, so compare the dark-mode ink colour.
        lp, dp = results[(pen, 'light')]['counts'], results[(pen, 'dark')]['counts']
        check('pen page light: default ink is near-black', lp[0] > 1000 and lp[0] > 10 * lp[1], lp)
        check('pen page dark: default ink is near-white', dp[1] > 1000, dp)
        check('pen page: default ink colour differs between light and dark', dp[1] > 10 * lp[1], (lp, dp))
        check('pen page: ink as visible in dark as in light', abs(results[(pen, 'dark')]['ink'] - results[(pen, 'light')]['ink']) < 0.02 * results[(pen, 'light')]['ink'])
        check('pen page: blue ink is the same in light and dark', lp[2] == dp[2], (lp[2], dp[2]))
        hc = results[(hl, 'light')]['counts']
        check('highlighter page: crossing highlighters do not darken', hc[3] > 1000 and hc[4] < 30, hc)
        b.close()
finally:
    srv.terminate()

if failures:
    print(f'\n{len(failures)} check(s) FAILED: ' + '; '.join(failures))
    sys.exit(1)
print('\nAll format checks passed.')

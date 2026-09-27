# Renders the committed sample note (test/fixtures/sample.md and its page SVGs) in headless
# Chromium as <img>, the way Obsidian's reading view and GitHub show them, in light and dark.
# Checks that drawn pages aren't blank, that the empty page is, that default black ink switches
# colour with the colour scheme while other colours don't, and that crossing highlighter strokes
# don't darken. The template pages (lined with margin, grid, dots) must show their lines in the
# grey of each scheme (light grey on white, dark grey on dark), with the margin line pink in
# both. A PDF page (#14), written at test time by the format functions into test/out, must show
# its embedded page image with the ink over it in both schemes. Run by `npm test`; screenshots land in test/out/. Exits non-zero on a failure.
import base64, os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 1
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
# Template lines, from the page's <style> (.t), and the margin line's fixed colour.
LINE = {'light': (0xc9, 0xc9, 0xc9), 'dark': (0x3c, 0x3c, 0x3c)}
PINK = (0xe8, 0xa0, 0xa0)

# Counts pixels in a PNG screenshot: differing from the background, near each given colour, and
# (of those differing from the background) neutral greys between `grey[0]` and `grey[1]`; and
# returns the colour at each sample point.
COUNT_JS = """async ([png, bg, colors, grey, samples]) => {
  const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
  const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const near = (i, [r, gg, b], tol) => Math.abs(d[i] - r) <= tol && Math.abs(d[i + 1] - gg) <= tol && Math.abs(d[i + 2] - b) <= tol;
  let ink = 0, greys = 0; const counts = colors.map(() => 0);
  for (let i = 0; i < d.length; i += 4) {
    if (!near(i, bg, 8)) {
      ink++;
      const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
      if (Math.max(r, gg, b) - Math.min(r, gg, b) <= 4 && r >= grey[0] && r <= grey[1]) greys++;
    }
    colors.forEach((col, k) => { if (near(i, col, 4)) counts[k]++; });
  }
  const at = samples.map(([x, y]) => [...d.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)]);
  return { ink, greys, counts, at, width: img.width, height: img.height };
}"""

def rgb(hex_):
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))

md = open(os.path.join(HERE, 'fixtures', 'sample.md'), encoding='utf8').read()
pages = re.findall(r'^!\[[^\]]*\]\(sample/(p-[0-9a-f]{6})\.svg\)$', md, re.M)
check('fixture: sample.md embeds six pages', len(pages) == 6, pages)
# Screenshot pixels (2 per page px): on the first ruled line (y 96) and between lines, at the
# margin line (x 120), and at the first dot (18.9, 18.9).
SAMPLES = [[20, 192], [300, 192], [20, 220], [240, 600], [37, 37], [48, 48]]
# Neutral greys a template line can be drawn in, antialiased towards the paper.
GREYS = {'light': [0xc9 - 6, 0xff], 'dark': [0x1e, 0x3c + 6]}

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
                colors = [INK['light'], INK['dark'], BLUE, GREEN_HL, GREEN_OVER_YELLOW, LINE['light'], LINE['dark'], PINK]
                r = page.evaluate(COUNT_JS, [base64.b64encode(shot).decode(), list(rgb(BG[scheme])), [list(c) for c in colors], list(GREYS[scheme]), [list(p) for p in SAMPLES]])  # fresh lists: tuples, and objects reused across calls, don't serialize
                results[(pid, scheme)] = r
                print(f'{pid} {scheme}: natural {size}, {r["ink"]} non-background px ({r["greys"]} template grey), '
                      f'near [light ink, dark ink, blue, green hl, green over yellow, light line, dark line, pink] {r["counts"]}')
                check(f'{pid} {scheme}: loads at 816 x 1056', size == [816, 1056], size)
            # The whole note as a reading view would stack it, for a human to look at.
            imgs = ''.join(f"<p><img style='max-width:100%;display:block' src='{base_url}/test/fixtures/sample/{pid}.svg'></p>" for pid in pages)
            page.set_content(f"<body style='margin:0 auto;max-width:700px;padding:16px;background:{BG[scheme]};color:{'#222' if scheme == 'light' else '#ddd'};font-family:sans-serif'><h1>Sample ink note</h1>{imgs}</body>")
            page.wait_for_function("() => [...document.images].every(i => i.complete)")
            page.screenshot(path=os.path.join(OUT, f'format_note_{scheme}.png'), full_page=True)
            check(f'{scheme}: no page errors', not errors, errors)
            page.close()

        pen, hl, empty, lined, grid, dots = pages
        near = lambda a, b, tol=6: all(abs(x - y) <= tol for x, y in zip(a, b))
        LINE_I = {'light': 5, 'dark': 6}  # indexes in counts
        PINK_I = 7
        for scheme in ['light', 'dark']:
            bg = rgb(BG[scheme])
            other = 'dark' if scheme == 'light' else 'light'
            lr, gr, dr = results[(lined, scheme)], results[(grid, scheme)], results[(dots, scheme)]
            # (The written page has a few pixels of antialiased ink in the other grey.)
            for name, res in [('lined', lr), ('grid', gr), ('dots', dr)]:
                ours, theirs = res['counts'][LINE_I[scheme]], res['counts'][LINE_I[other]]
                check(f'{name} page {scheme}: lines in the {scheme} grey, not the {other} grey',
                      ours > 1000 and theirs < (0.02 * ours if name == 'lined' else 20), res['counts'])
            check(f'lined page {scheme}: ruled lines across the page', lr['counts'][LINE_I[scheme]] > 50000, lr['counts'])
            check(f'lined page {scheme}: the first line at 1 in, paper between lines',
                  near(lr['at'][0], LINE[scheme]) and near(lr['at'][1], LINE[scheme]) and near(lr['at'][2], bg), lr['at'][:3])
            check(f'lined page {scheme}: the margin line is pink', lr['counts'][PINK_I] > 3000 and near(lr['at'][3], PINK), (lr['counts'][PINK_I], lr['at'][3]))
            check(f'lined page {scheme}: the writing is there', lr['counts'][2] > 300 and lr['ink'] > lr['counts'][LINE_I[scheme]] + lr['counts'][PINK_I] + 5000, lr['counts'])
            for name, res in [('grid', gr), ('dots', dr)]:
                check(f'{name} page {scheme}: not blank', res['ink'] > (100000 if name == 'grid' else 10000), res['ink'])
                check(f'{name} page {scheme}: nothing but template grey', res['greys'] == res['ink'], (res['greys'], res['ink']))
            check(f'dots page {scheme}: a dot one spacing in, paper beside it', near(dr['at'][4], LINE[scheme], 30) and near(dr['at'][5], bg), dr['at'][4:])
        check('lined page: the margin line is the same pink in light and dark',
              abs(results[(lined, 'light')]['counts'][PINK_I] - results[(lined, 'dark')]['counts'][PINK_I]) < 50, [results[(lined, s)]['counts'][PINK_I] for s in BG])
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
        check('pen page: blue ink is the same in light and dark', abs(lp[2] - dp[2]) < 50, (lp[2], dp[2]))
        hc = results[(hl, 'light')]['counts']
        check('highlighter page: crossing highlighters do not darken', hc[3] > 1000 and hc[4] < 30, hc)

        # ---- a PDF page (#14), generated into test/out by the format functions: its embedded
        # JPEG (white with a red square and a blue bar) must render under the ink in both schemes.
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'{base_url}/test/harness.html')
        page.add_script_tag(url=f'{base_url}/test/out/view-fixture.js')
        svg = page.evaluate("""() => {
          const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;  // A4 at 150 dpi
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.fillStyle = '#d00000'; g.fillRect(0, 0, 200, 200);
          g.fillStyle = '#0030c0'; g.fillRect(100, 800, 1040, 60);
          const image = c.toDataURL('image/jpeg', 0.85);
          const points = Array.from({ length: 40 }, (_, i) => ({ x: 100 + i * 10, y: 600, p: 0.5, t: i * 8 }));
          return ink.writePage({ id: 'p-0f0f0f', size: { width: 793.7, height: 1122.5 },
            template: { kind: 'pdf', source: 'lecture.pdf', page: 1, image },
            strokes: [{ id: '0000beef', tool: 'pen', nib: 'uniform', color: '#000000', size: 6, points }] });
        }""")
        page.close()
        check('pdf page: generated without errors', not errors and svg.count('data:image/jpeg;base64,') == 1, errors)
        with open(os.path.join(OUT, 'format_pdf_page.svg'), 'w', encoding='utf8') as f:
            f.write(svg)
        RED, BLUEBAR = (0xd0, 0, 0), (0, 0x30, 0xc0)
        for scheme in ['light', 'dark']:
            page = ctx.new_page()
            page.emulate_media(color_scheme=scheme)
            page.goto(f'{base_url}/test/out/')
            page.set_content(f"<body style='margin:0;background:{BG[scheme]}'><img id='p' src='{base_url}/test/out/format_pdf_page.svg'></body>")
            page.wait_for_function("() => document.getElementById('p').complete")
            size = page.evaluate("() => { const i = document.getElementById('p'); return [i.naturalWidth, i.naturalHeight]; }")
            shot = page.locator('#p').screenshot(path=os.path.join(OUT, f'format_pdf_page_{scheme}.png'))
            # Screenshot px are 2 per page px: the red square spans 0-128 page px, the bar y 512-550,
            # the stroke y 600 from x 100 to 490.
            r = page.evaluate(COUNT_JS, [base64.b64encode(shot).decode(), list(rgb(BG[scheme])), [list(RED), list(BLUEBAR), list(INK[scheme])],
                                         [0, 0], [[40, 40], [600, 1060], [600, 1200], [1500, 2000]]])
            near = lambda a, b, tol=40: all(abs(x - y) <= tol for x, y in zip(a, b))
            print(f'pdf page {scheme}: natural {size}, samples {r["at"]}, counts [red, blue bar, ink] {r["counts"]}')
            check(f'pdf page {scheme}: loads at its own size', size == [794, 1123], size)
            check(f'pdf page {scheme}: the embedded page image is the background (red square, blue bar, white paper)',
                  near(r['at'][0], RED) and near(r['at'][1], BLUEBAR) and near(r['at'][3], (255, 255, 255), 8), r['at'])
            # The paper is the PDF's own white in both schemes, so default ink stays near-black.
            check(f'pdf page {scheme}: the default ink is drawn over it, near-black in both schemes', near(r['at'][2], INK['light'], 30), r['at'][2])
            page.close()

        # ---- a sticky page (#27): 288 x 288, its pale yellow fill drawn in both schemes, and
        # default ink near-black on it in dark mode too (the fill doesn't follow dark mode).
        page = ctx.new_page()
        page.goto(f'{base_url}/test/harness.html')
        page.add_script_tag(url=f'{base_url}/test/out/view-fixture.js')
        svg = page.evaluate("""() => {
          const points = Array.from({ length: 30 }, (_, i) => ({ x: 40 + i * 7, y: 150, p: 0.5, t: i * 8 }));
          return ink.writePage({ id: 'p-0e0e0e', size: { width: 288, height: 288 }, template: ink.parseTemplateName('sticky-3in'),
            strokes: [{ id: '0000cafe', tool: 'pen', nib: 'uniform', color: '#000000', size: 6, points }] });
        }""")
        page.close()
        with open(os.path.join(OUT, 'format_sticky_page.svg'), 'w', encoding='utf8') as f:
            f.write(svg)
        STICKY = (0xff, 0xf5, 0x9d)
        for scheme in ['light', 'dark']:
            page = ctx.new_page()
            page.emulate_media(color_scheme=scheme)
            page.goto(f'{base_url}/test/out/')
            page.set_content(f"<body style='margin:0;background:{BG[scheme]}'><img id='p' src='{base_url}/test/out/format_sticky_page.svg'></body>")
            page.wait_for_function("() => document.getElementById('p').complete")
            size = page.evaluate("() => { const i = document.getElementById('p'); return [i.naturalWidth, i.naturalHeight]; }")
            shot = page.locator('#p').screenshot(path=os.path.join(OUT, f'format_sticky_page_{scheme}.png'))
            # Screenshot px are 2 per page px: the stroke is at y 150 from x 40 to 243.
            r = page.evaluate(COUNT_JS, [base64.b64encode(shot).decode(), list(rgb(BG[scheme])), [list(STICKY), list(INK['light']), list(INK['dark'])],
                                         [0, 0], [[20, 20], [300, 300], [560, 560]]])
            near = lambda a, b, tol=12: all(abs(x - y) <= tol for x, y in zip(a, b))
            print(f'sticky page {scheme}: natural {size}, samples {r["at"]}, counts [fill, light ink, dark ink] {r["counts"]}')
            check(f'sticky page {scheme}: loads at 288 x 288', size == [288, 288], size)
            check(f'sticky page {scheme}: the pale yellow fill covers the page', near(r['at'][0], STICKY) and near(r['at'][2], STICKY), r['at'])
            check(f'sticky page {scheme}: the default ink is near-black on it', near(r['at'][1], INK['light'], 30) and r['counts'][2] == 0, r)
        b.close()
finally:
    srv.terminate()

if failures:
    print(f'\n{len(failures)} check(s) FAILED: ' + '; '.join(failures))
    sys.exit(1)
print('\nAll format checks passed.')

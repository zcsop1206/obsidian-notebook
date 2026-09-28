# "Export note as PDF" (#18) in headless Chromium, against the built main.js with the mock
# obsidian module and in-memory vault of test/harness.html. Builds a note with the format
# functions (pen strokes in two colours, crossing highlighter strokes on a lined page with a
# margin, a sticky note, a page with a JPEG and a PNG image with ink on them, and a pdf-kind
# page), runs the export command, reads the PDF's bytes from the mock vault and checks them with
# pypdf: page count and sizes in points, vector ink (a fill operator per stroke, cubic curves,
# the stroke colours; #60: thin uniform strokes stroked, round-capped), an image XObject per image and pdf page, the highlighter's transparency
# group drawn with ExtGState ca 0.4, the Title. Also: a second export gets a unique name, the
# page settings menu's entry exports, and the share sheet is offered on iOS only.
# Needs Python Playwright and pypdf (`pip install pypdf`). Run by `npm test`; the PDFs land in
# test/out/. Exits non-zero if any check fails.
import base64, io, os, re, subprocess, sys, time
try:
    import pypdf
except Exception as e:  # missing, or a broken dependency (e.g. cryptography)
    sys.exit(f'run_export_test.py needs pypdf: pip install pypdf ({e!r})')
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 3
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail != '' and not ok else ''))
    if not ok:
        failures.append(name)

# Writes the note `Export` (4 pages) into the vault and opens it. Returns the stroke counts.
SETUP = """async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  window.p = await loadPlugin();
  await p.createInkNote('Export', '', 'letter', 'blank');
  await sleep(100);
  await app.workspace.activeLeaf.detach();
  const note = ink.readNote(fs.get('Export.md'), 'Export');
  const image = (w, h, type) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (type === 'image/png') { g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(200,0,0,0.5)'; g.fillRect(0, 0, w / 2, h); }
    else { g.fillStyle = '#3070c0'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(10, 10, w / 3, h / 3); }
    return c.toDataURL(type, 0.9);
  };
  const line = (x0, y0, x1, y1, n = 30) => Array.from({ length: n }, (_, j) => ({ x: x0 + (x1 - x0) * j / (n - 1), y: y0 + (y1 - y0) * j / (n - 1) + 3 * Math.sin(j / 3), p: 0.3 + 0.02 * j, t: j * 8 }));
  const pen = (id, color, pts, extra = {}) => ({ id, tool: 'pen', nib: 'pressure', color, size: 2.5, points: pts, ...extra });
  const hl = (id, color, pts) => ({ id, tool: 'highlighter', color, size: 14, points: pts });
  const ids = ['p-e00001', 'p-e00002', 'p-e00003', 'p-e00004'];
  const pages = [
    { id: ids[0], size: { width: 816, height: 1056 }, template: { kind: 'lined', rule: 'college', margin: true }, strokes: [
      pen('00000001', '#000000', line(150, 200, 600, 220)),
      pen('00000002', '#1e5bd8', line(150, 300, 600, 260)),
      hl('00000003', '#ffeb3b', line(140, 400, 600, 400)),
      hl('00000004', '#69f0ae', line(300, 300, 320, 500)),
      pen('00000005', '#000000', [{ x: 700, y: 700, p: 0.5, t: 0 }]),  // a dot
      // #60: thin uniform strokes, stroked centrelines (a line and a dot)
      pen('0000000a', '#000000', line(150, 560, 600, 580, 120), { nib: 'uniform', size: 0.5 }),
      pen('0000000b', '#1e5bd8', [{ x: 650, y: 580, p: 0.5, t: 0 }], { nib: 'uniform', size: 0.5 }),
    ] },
    { id: ids[1], size: { width: 288, height: 288 }, template: { kind: 'fill', color: '#fff59d' }, strokes: [pen('00000006', '#000000', line(30, 100, 250, 150))] },
    { id: ids[2], size: { width: 816, height: 1056 }, template: { kind: 'blank' },
      images: [{ id: 'i-000001', x: 100, y: 100, width: 400, height: 300, data: image(320, 240, 'image/jpeg') },
               { id: 'i-000002', x: 100, y: 500, width: 200, height: 200, data: image(100, 100, 'image/png') }],
      strokes: [pen('00000007', '#d32f2f', line(120, 150, 450, 350), { on: 'i-000001' }), pen('00000008', '#000000', line(100, 800, 700, 800))] },
    { id: ids[3], size: { width: 816, height: 1056 }, template: { kind: 'pdf', source: 'missing.pdf', page: 1, image: image(612, 792, 'image/jpeg') },
      strokes: [pen('00000009', '#000000', line(100, 100, 500, 600))] },
  ];
  dirs.add('Export');
  for (const f of [...fs.keys()]) if (f.startsWith('Export/')) fs.delete(f);
  for (const pg of pages) fs.set(`Export/${pg.id}.svg`, ink.writePage(pg));
  note.pages = ids;
  fs.set('Export.md', ink.writeNote(note));
  const leaf = app.workspace.getLeaf('tab');
  await leaf.openFile(app.vault.getFile('Export.md'));
  await sleep(200);
  // Strokes drawn as filled outlines on each page (the uniform ones are stroked, #60).
  return pages.map(pg => pg.strokes.filter(s => s.nib !== 'uniform').length);
}"""

def pdf_of(ev, path):
    b64 = ev(f"() => {{ const d = fs.get({path!r}); if (!(d instanceof Uint8Array)) return null; let s = ''; for (const c of d) s += String.fromCharCode(c); return btoa(s); }}")
    return base64.b64decode(b64) if b64 is not None else None

def page_ops(page):
    """The page's content operators and those of the Form XObjects it draws, as text."""
    text = page['/Contents'].get_object().get_data().decode('latin1')  # as written, not re-serialized
    forms = ''
    res = page.get('/Resources') or {}
    xo = res.get('/XObject') or {}
    for name in xo:
        o = xo[name].get_object()
        if o.get('/Subtype') == '/Form':
            forms += o.get_data().decode('latin1')
    return text, forms

def images_on(page):
    xo = (page.get('/Resources') or {}).get('/XObject') or {}
    return [n for n in xo if xo[n].get_object().get('/Subtype') == '/Image']

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={'width': 1000, 'height': 700})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.add_script_tag(url=f'http://localhost:{port}/test/out/view-fixture.js')
        ev = page.evaluate
        counts = ev(SETUP)
        check('setup: the note opens with 4 pages', ev("() => view.store.slots.length") == 4)

        # --- 1. The command writes Export.pdf next to the note
        r = ev("""async () => {
          const c = commands['export-pdf'];
          const available = c.checkCallback(true);
          const n = notices.length;
          c.checkCallback(false);
          for (let i = 0; i < 200 && !fs.has('Export.pdf'); i++) await new Promise(r => setTimeout(r, 25));
          await new Promise(r => setTimeout(r, 50));
          return { available, notices: notices.slice(n), shares: shares.length };
        }""")
        check('command: available in an ink view', r['available'] is True, r)
        check('command: notice names the file', any('Export.pdf' in str(m) for m in r['notices']), r['notices'])
        check('command: progress notice for a 4-page note', any('page 4 of 4' in str(m) for m in r['notices']), r['notices'])
        check('command: no share sheet off iOS', r['shares'] == 0, r)
        data = pdf_of(ev, 'Export.pdf')
        check('command: Export.pdf written through createBinary', data is not None and ev("() => app.vault.writes.includes('Export.pdf')"))
        if data is None:
            raise SystemExit
        open(os.path.join(OUT, 'export_note.pdf'), 'wb').write(data)
        print(f'Export.pdf: {len(data)} bytes')
        check('pdf: starts with %PDF-1.4', data.startswith(b'%PDF-1.4'))
        rd = pypdf.PdfReader(io.BytesIO(data), strict=True)
        check('pdf: parses strictly with 4 pages', len(rd.pages) == 4, len(rd.pages))
        sizes = [[float(x) for x in pg.mediabox] for pg in rd.pages]
        check('pdf: Letter pages are 612 x 792 pt, the sticky note 216 x 216',
              sizes == [[0, 0, 612, 792], [0, 0, 216, 216], [0, 0, 612, 792], [0, 0, 612, 792]], sizes)
        check('pdf: Title is the note name, Producer the plugin',
              rd.metadata.title == 'Export' and rd.metadata.producer == 'Notebook plugin', rd.metadata)

        ops = [page_ops(pg) for pg in rd.pages]
        fills = [len(re.findall(r'^f$', a + '\n' + f, re.M)) for a, f in ops]
        check('vector ink: a fill per stroke on each page (plus the sticky fill)',
              fills[0] >= counts[0] and fills[1] >= counts[1] and fills[2] >= counts[2] and fills[3] >= counts[3], (fills, counts))
        check('vector ink: curves (c operators), not images, on every page',
              all(len(re.findall(r' c$', a + '\n' + f, re.M)) > 20 for a, f in ops), [len(re.findall(r' c$', a + '\n' + f, re.M)) for a, f in ops])
        a0, f0 = ops[0]
        thin = re.findall(r'(\S+ \S+ \S+) RG 0\.5 w 1 J 1 j\n((?:[^\n]* [mlc]\n)+)S\n', a0)
        print('thin uniform strokes in the PDF:', [(c, len(body.split('\n')) - 1) for c, body in thin])
        check('thin uniform pen (#60): stroked centrelines 0.5 px wide with round caps and joins (w, 1 J, 1 j, S), in their colours, one open subpath each',
              [c for c, _ in thin] == ['0 0 0', '0.118 0.357 0.847'] and all(body.count(' m\n') == 1 and ' h\n' not in body for _, body in thin)
              and thin[0][1].count(' c\n') > 20 and re.fullmatch(r'650 580 m\n650 580 l\n', thin[1][1]) is not None, thin)
        check('vector ink: pen strokes in black and blue on the page, after the highlights',
              '0 0 0 rg' in a0 and '0.118 0.357 0.847 rg' in a0 and a0.index('/Hl Do') < a0.index('0.118 0.357 0.847 rg'), a0[:300])
        check('page transform: px scaled by 0.75 with y flipped', a0.startswith('q\n0.75 0 0 -0.75 0 792 cm'), a0[:60])
        check('highlighter: both strokes inside the form, in their colours, opaque',
              '1 0.922 0.231 rg' in f0 and '0.412 0.941 0.682 rg' in f0 and 'gs' not in f0, f0[:200])
        res0 = rd.pages[0]['/Resources']
        gs = [res0['/ExtGState'][k].get_object() for k in res0['/ExtGState']]
        form = res0['/XObject']['/Hl'].get_object()
        check('highlighter: ExtGState ca 0.4, drawn around the group', any(float(g.get('/ca', 1)) == 0.4 for g in gs) and 'q /Ha gs /Hl Do Q' in a0, gs)
        check('highlighter: the form is a knockout transparency group',
              form['/Group']['/S'] == '/Transparency' and bool(form['/Group']['/K']), form.get('/Group'))
        check('template: lined page lines in light grey, margin in pink',
              '0.788 0.788 0.788 RG' in a0 and '0.91 0.627 0.627 RG 1 w 120 0 m 120 1056 l S' in a0 and a0.count(' l\n') >= 35)
        check('template: sticky note filled pale yellow', '1 0.961 0.616 rg 0 0 288 288 re f' in ops[1][0], ops[1][0][:120])
        imgs = [images_on(pg) for pg in rd.pages]
        check('images: none on page 1-2, two on page 3, the pdf page image on page 4',
              [len(i) for i in imgs] == [0, 0, 2, 1], imgs)
        xo3 = rd.pages[2]['/Resources']['/XObject']
        dims = sorted((int(xo3[n]['/Width']), int(xo3[n]['/Height']), xo3[n]['/Filter']) for n in imgs[2])
        check('images: JPEG embedded at its pixel size, PNG re-encoded as JPEG', dims == [(100, 100, '/DCTDecode'), (320, 240, '/DCTDecode')], dims)
        check('images: drawn at the stored box', 'q 400 0 0 -300 100 400 cm /Im0 Do Q' in ops[2][0], ops[2][0][:200])
        p4 = ops[3][0]
        check('pdf page: its image stretched to the page, ink over it',
              'q 816 0 0 -1056 0 1056 cm /T0 Do Q' in p4 and p4.index('/T0 Do') < p4.index('rg'), p4[:200])
        t4 = rd.pages[3]['/Resources']['/XObject']['/T0']
        check('pdf page: image at 612 x 792 px', (int(t4['/Width']), int(t4['/Height'])) == (612, 792))

        # --- 2. Again: a unique name; from the page settings menu; share sheet on iOS
        r = ev("""async () => {
          obsidian.Platform.isIosApp = true;
          view.contentEl.querySelector('.nb-ink-page-settings').click();
          const item = view.contentEl.querySelector('.nb-ink-menu-export-pdf');
          const label = item && item.textContent;
          item.click();
          for (let i = 0; i < 200 && !(fs.has('Export 1.pdf') && shares.length); i++) await new Promise(r => setTimeout(r, 25));
          obsidian.Platform.isIosApp = false;
          return { label, has: fs.has('Export 1.pdf'), shares };
        }""")
        check('menu: "Export as PDF…" in page settings', r['label'] == 'Export as PDF…', r['label'])
        check('second export: Export 1.pdf', r['has'], r)
        check('iOS: the share sheet gets the PDF as a file',
              len(r['shares']) == 1 and r['shares'][0]['files'][0]['name'] == 'Export 1.pdf' and r['shares'][0]['files'][0]['type'] == 'application/pdf'
              and r['shares'][0]['files'][0]['size'] > 1000, r['shares'])
        r = ev("""async () => {
          obsidian.Platform.isIosApp = true; window.noShareFiles = true;
          const n = await view.exportPdf();
          obsidian.Platform.isIosApp = false; window.noShareFiles = false;
          return { n, shares: shares.length };
        }""")
        check('iOS without file sharing: the file is still written, no share, no error', r['n'] == 'Export 2.pdf' and r['shares'] == 1, r)
        check('no page errors', not errors, errors)
        b.close()
finally:
    srv.terminate()

print(f'{len(failures)} failure(s)' if failures else 'All export checks passed')
sys.exit(1 if failures else 0)

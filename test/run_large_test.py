# Large notes (#63): an 800-page note like an imported textbook (each page a pdf template with an
# embedded JPEG of a few hundred KB) in headless Chromium, against the built main.js with the
# mock obsidian module. Checks that the note opens without reading its pages, that the store
# keeps only the pages near the viewport and the changed ones in memory, that scrolling is as
# smooth as in a 20-page note of the same kind, that a page far away is drawn soon after a
# jump, that a change to a page survives the page leaving the viewport, that changing every
# page's template and exporting read every page, that a PDF import can be cancelled, and going
# to page n from the toolbar's page indicator (#64).
# Run by `npm test`. NB_LARGE_PAGES sets the page count (default 800).
# Exits non-zero if any check fails.
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
port = int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 4
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
PAGES = int(os.environ.get('NB_LARGE_PAGES', 800))

failures = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail != '' and not ok else ''))
    if not ok:
        failures.append(name)


HELPERS = """() => {
  window.T = {
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    /** A JPEG data URL like a rendered textbook page at 150 dpi: lines of text, page number n. */
    jpeg(n) {
      const c = document.createElement('canvas');
      c.width = 1275; c.height = 1650;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#111'; g.font = '22px serif';
      let seed = n * 7919;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let y = 120; y < 1550; y += 30) {
        let line = '';
        while (line.length < 95) line += Math.floor(rnd() * 1e9).toString(36) + ' ';
        g.fillText(line, 110, y);
      }
      g.font = '40px serif'; g.fillText('Page ' + n, 560, 80);
      return c.toDataURL('image/jpeg', 0.85);
    },
    /** Puts a note of `pages` PDF-like pages in the vault (the first 3 with 40 strokes each). */
    note(folder, name, pages, size = { width: 816, height: 1056 }) {
      T.images ??= [0, 1, 2, 3].map(k => T.jpeg(k + 1));
      const files = ink.pdfNote(folder, name, pages, size, n => T.images[n % 4], 3, 40);
      dirs.add(folder); dirs.add(`${folder}/${name}`);
      let chars = 0;
      for (const [k, v] of Object.entries(files)) { fs.set(k, v); chars += v.length; }
      return { files: Object.keys(files).length, chars, image: T.images[0].length };
    },
    /** Opens a note and waits for its first page to be drawn; long tasks meanwhile. */
    async open(path) {
      const long = [];
      const po = new PerformanceObserver(l => { for (const e of l.getEntries()) long.push(e.duration); });
      po.observe({ entryTypes: ['longtask'] });
      T.reads = 0;
      const t0 = performance.now();
      await app.workspace.getLeaf(false).openFile(app.vault.getFile(path));
      for (let i = 0; i < 2000 && !(window.view && view.file?.path === path && view.store && T.drawn(0)); i++) await T.sleep(5);
      const firstDraw = performance.now() - t0;
      await T.sleep(600);
      po.disconnect();
      return { openMs: view.stats.openMs, firstDraw, longMax: Math.max(0, ...long), longSum: long.reduce((a, b) => a + b, 0), reads: T.reads,
        held: T.held(), pages: view.store.slots.length, lazy: view.store.lazy, els: view.contentEl.querySelectorAll('.nb-ink-page').length };
    },
    /** Whether page i has a finished bitmap. */
    drawn: i => { const pv = view.pages[i]; return !!pv && !!pv.bitmap && pv.pending == null; },
    scroller: () => view.contentEl.querySelector('.nb-ink-scroll'),
    /** Frame intervals (ms) while `run` runs. */
    async frames(run) {
      const times = [];
      let on = true, last = performance.now();
      const tick = t => { times.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      await run();
      on = false;
      const s = times.slice(1).sort((a, b) => a - b);
      return { n: s.length, median: s[s.length >> 1] ?? 0, worst: s[s.length - 1] ?? 0, over32: s.filter(x => x > 32).length };
    },
    /** Scrolls down 120 frames of 180 px, as a fast drag would. */
    scroll: () => T.frames(async () => {
      const sc = T.scroller();
      for (let i = 0; i < 120; i++) { sc.scrollTop += 180; await new Promise(r => requestAnimationFrame(r)); }
    }),
    /** What the store holds on to: characters of page text, of remembered text and of embedded images, and pages in memory. */
    held() {
      const st = view.store;
      let text = 0, images = 0, loaded = 0;
      for (const s of st.slots) {
        if (s.loaded !== false && !s.error) loaded++;
        if (s.text) text += s.text.length;
        if (s.page) images += (s.page.template.image || '').length;
      }
      let last = 0;
      for (const v of st.lastText.values()) last += v.text.length;
      return { text, images, last, loaded };
    },
  };
  // Count page files read through the vault.
  const read = app.vault.read.bind(app.vault);
  T.reads = 0;
  app.vault.read = f => { if (f.path.endsWith('.svg')) T.reads++; return read(f); };
}"""

MB = 1e6

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
        page.evaluate("async () => { window.p = await loadPlugin(); }")
        page.evaluate(HELPERS)
        ev = page.evaluate

        # ---- the baseline: a 20-page note of the same kind, read whole
        ev("() => T.note('Books', 'Chapter', 20)")
        r = ev("() => T.open('Books/Chapter.md')")
        check('20 pages: read whole when it opens', not r['lazy'] and r['reads'] == 20 and r['held']['loaded'] == 20, r)
        base = ev("() => T.scroll()")
        print(f"20 pages: opens in {r['openMs']:.0f} ms; scrolling {base['n']} frames, median {base['median']:.1f} ms, worst {base['worst']:.1f} ms, over 32 ms {base['over32']}")

        # ---- the long note
        r = ev(f"() => T.note('Books', 'Textbook', {PAGES})")
        total_mb = r['chars'] / MB
        print(f"fixture: {r['files'] - 1} pages, {total_mb:.0f} MB of text, {r['image'] / 1e3:.0f} KB per embedded image")
        r = ev("() => T.open('Books/Textbook.md')")
        held = r['held']
        print(f"{PAGES} pages: opens in {r['openMs']:.0f} ms, first page drawn after {r['firstDraw']:.0f} ms (longest task {r['longMax']:.0f} ms); "
              f"{r['reads']} page files read, {held['loaded']} pages in memory holding {(held['text'] + held['images'] + held['last']) / MB:.1f} MB")
        check('open: the long note is lazy, with an element per page', r['lazy'] and r['pages'] == PAGES and r['els'] == PAGES, r)
        check('open: under 500 ms to the first page drawn, no task over 250 ms', r['firstDraw'] < 500 and r['longMax'] < 250, r)
        check('open: only the pages near the viewport are read (at most 6)', 1 <= r['reads'] <= 6 and held['loaded'] == r['reads'], r)
        check('open: the text of pages that were read is not kept once parsed, nor remembered (only the index is)', held['last'] < 0.1 * MB and held['text'] < 3 * MB, held)

        r = ev("""async () => {
          const f = await T.scroll();
          await T.sleep(400);
          return { f, held: T.held(), at: view.currentPageIndex(), drawn: T.drawn(view.currentPageIndex()) };
        }""")
        f, held = r['f'], r['held']
        print(f"{PAGES} pages: scrolling {f['n']} frames, median {f['median']:.1f} ms, worst {f['worst']:.1f} ms, over 32 ms {f['over32']}; "
              f"{held['loaded']} pages in memory holding {(held['text'] + held['images'] + held['last']) / MB:.1f} MB")
        check('scroll: as smooth as the 20-page note (frames over 32 ms within 4 of it, none over 100 ms)',
              f['over32'] <= base['over32'] + 4 and f['worst'] < 100 and f['median'] < 20, (f, base))
        check('scroll: the page reached is drawn', r['at'] > 10 and r['drawn'], r)

        r = ev("""async () => {
          const sc = T.scroller();
          // Through 150 pages, a page at a time.
          for (let i = 0; i < 150; i++) { view.scrollToPage(20 + i); await new Promise(r => requestAnimationFrame(r)); await T.sleep(0); }
          await T.sleep(500);
          const held = T.held();
          const t0 = performance.now();
          view.scrollToPage(500);
          for (let i = 0; i < 400 && !T.drawn(500); i++) await T.sleep(5);
          const jumpMs = performance.now() - t0;
          return { held, jumpMs, at: view.currentPageIndex(), drawn: T.drawn(500), page: view.store.page(view.store.slots[500])?.template.page };
        }""")
        held = r['held']
        print(f"{PAGES} pages: after 150 more pages, {held['loaded']} in memory holding {(held['text'] + held['images'] + held['last']) / MB:.1f} MB; jump to page 501 drawn after {r['jumpMs']:.0f} ms")
        check('memory: at most 48 pages stay in memory however far the view has scrolled', 3 <= held['loaded'] <= 48, held)
        check('memory: what the store holds does not grow with the note (under 60 MB of an %d MB note)' % total_mb,
              held['text'] + held['images'] + held['last'] < 60 * MB, held)
        check('jump: page 501 is the current page and drawn within a second', r['at'] == 500 and r['drawn'] and r['jumpMs'] < 1000 and r['page'] == 501, r)

        # ---- a change to a page survives the page leaving the viewport
        r = ev("""async () => {
          const st = view.store, slot = st.slots[500];
          const src = ink.readPage(fs.get(st.slots[0].path)).strokes[0];
          st.addStroke(slot, { ...src, id: '0000abcd' });
          view.pageChanged(slot);
          view.scrollToPage(100);
          for (let i = 0; i < 80; i++) { view.scrollToPage(100 + i); await new Promise(r => requestAnimationFrame(r)); await T.sleep(0); }
          await T.sleep(300);
          const away = { loaded: slot.loaded, first: st.slots[0].loaded, held: T.held().loaded };
          await view.save();
          const disk = ink.readPage(fs.get(slot.path)).strokes.map(s => s.id);
          view.scrollToPage(500);
          for (let i = 0; i < 400 && !T.drawn(500); i++) await T.sleep(5);
          return { away, disk, back: st.page(slot).strokes.length, drawn: T.drawn(500) };
        }""")
        check('edit: a changed page stays in memory while 80 other pages pass, and is saved', r['away']['loaded'] and r['disk'] == ['0000abcd'], r)
        check('edit: unchanged pages far away are released meanwhile', not r['away']['first'] and r['away']['held'] <= 49, r['away'])
        check('edit: back on the page, the stroke is there and drawn', r['back'] == 1 and r['drawn'], r)

        # ---- go to page n (#64): the indicator in the toolbar, its dialog, and the command
        r = ev("""async () => {
          const ind = view.contentEl.querySelector('.nb-ink-page-indicator');
          const at500 = ind.textContent;
          const sc = T.scroller();
          sc.scrollTop += 3 * view.pages[500].el.offsetHeight;
          await T.sleep(100);
          const scrolled = ind.textContent;
          // A tap opens the dialog at the current page; a number and Enter go there.
          ind.click();
          const m = modals[modals.length - 1], input = m.contentEl.querySelector('input');
          const dialog = { title: m.titleEl.textContent, value: input.value, of: m.contentEl.querySelector('.nb-goto-total').textContent, type: input.type };
          input.value = '650';
          const t0 = performance.now();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          for (let i = 0; i < 400 && !T.drawn(649); i++) await T.sleep(5);
          const ms = performance.now() - t0;
          await T.sleep(50);
          const went = { modals: modals.length, at: view.currentPageIndex(), label: ind.textContent, drawn: T.drawn(649), ms,
            page: view.store.page(view.store.slots[649])?.template.page, top: Math.round(view.pages[649].el.getBoundingClientRect().top - sc.getBoundingClientRect().top) };
          // Past the end and before the start; text that isn't a number keeps the dialog open.
          commands['go-to-page'].checkCallback(false);
          const m2 = modals[modals.length - 1], in2 = m2.contentEl.querySelector('input');
          in2.value = '';
          m2.contentEl.querySelector('button.mod-cta').click();
          const stays = modals.includes(m2);
          in2.value = '99999';
          m2.contentEl.querySelector('button.mod-cta').click();
          await T.sleep(100);
          const last = { at: view.currentPageIndex(), label: ind.textContent, modals: modals.length };
          const first = view.goToPage(-3);
          await T.sleep(100);
          return { at500, scrolled, dialog, went, stays, last, first, firstLabel: ind.textContent, total: view.pages.length,
            command: commands['go-to-page'].checkCallback(true), label: ind.getAttribute('aria-label') };
        }""")
        n = r['total']
        check('go to page: the toolbar shows the current page and the count, and follows scrolling',
              r['at500'] == f'501 / {n}' and r['scrolled'] == f'504 / {n}', r)
        check('go to page: a tap opens a dialog at the current page with a number field',
              r['dialog'] == {'title': 'Go to page', 'value': '504', 'of': f'of {n}', 'type': 'number'}, r['dialog'])
        check('go to page: a number and Enter go there: page 650 at the top, drawn within a second',
              r['went']['modals'] == 0 and r['went']['at'] == 649 and r['went']['label'] == f'650 / {n}' and r['went']['drawn'] and r['went']['ms'] < 1000
              and r['went']['page'] == 650 and abs(r['went']['top']) <= 20, r['went'])
        check('go to page: the command opens the dialog; no number keeps it open; past the end goes to the last page',
              r['command'] and r['stays'] and r['last'] == {'at': n - 1, 'label': f'{n} / {n}', 'modals': 0}, r)
        check('go to page: before the start goes to the first page', r['first'] == 0 and r['firstLabel'] == f'1 / {n}' and r['label'] == f'Page 1 of {n}: go to page', r)

        # ---- the first pages, released, are read again with their strokes
        r = ev("""async () => {
          for (let i = 0; i < 60; i++) { view.scrollToPage(300 + i); await new Promise(r => requestAnimationFrame(r)); await T.sleep(0); }
          await T.sleep(200);
          T.reads = 0;
          view.scrollToPage(0);
          for (let i = 0; i < 400 && !T.drawn(0); i++) await T.sleep(5);
          return { reads: T.reads, strokes: view.store.page(view.store.slots[0])?.strokes.length, drawn: T.drawn(0) };
        }""")
        check('back at the top: page 1 is read again and drawn with its 40 strokes', r['reads'] >= 1 and r['strokes'] == 40 and r['drawn'], r)

        # ---- the pages panel reads pages for the thumbnails in view only
        r = ev("""async () => {
          T.reads = 0;
          view.togglePagesPanel(true);
          await T.sleep(800);
          const thumbs = view.contentEl.querySelectorAll('.nb-pages-thumb, .nb-ink-thumb').length;
          const r = { reads: T.reads, held: T.held().loaded, current: view.store.slots[0].loaded, page0: !!view.store.page(view.store.slots[0]) };
          view.togglePagesPanel(false);
          return r;
        }""")
        check('pages panel: opening it reads a few pages for thumbnails, and the page in view stays in memory', r['reads'] < 30 and r['held'] <= 49 and r['current'] and r['page0'], r)

        # ---- whole-note operations read every page: a template for all pages, then an export
        ev("() => T.note('Books', 'Slides', 60, { width: 960, height: 540 })")
        r = ev("() => T.open('Books/Slides.md')")
        check('60 pages: lazy; the pages take the size of the first one read (960 x 540), not the paper size of the note',
              r['lazy'] and r['reads'] <= 8 and ev("() => view.store.slots.every(s => s.size.width === 960 && s.size.height === 540)"), r)
        r = ev("""async () => {
          const n0 = notices.length;
          T.reads = 0;
          const ok = await view.changeAllTemplates({ kind: 'grid', spacing: '5mm' });
          const reads = T.reads;
          await view.save();
          const kinds = view.store.slots.map(s => ink.readPage(fs.get(s.path)).template.kind);
          view.history.undo();
          await view.save();
          const undone = view.store.slots.map(s => ink.readPage(fs.get(s.path)).template.kind);
          return { ok, reads, grid: kinds.filter(k => k === 'grid').length, pdf: undone.filter(k => k === 'pdf').length, held: T.held().loaded,
            notices: notices.slice(n0).filter(m => /Reading the pages/.test(m)).length };
        }""")
        check('all templates: every page is read, changed and saved, with progress; undo puts all 60 back',
              r['ok'] and r['reads'] >= 52 and r['grid'] == 60 and r['pdf'] == 60 and r['held'] == 60 and r['notices'] >= 2, r)
        ev("() => T.note('Books', 'Handout', 60)")
        r = ev("() => T.open('Books/Handout.md')")
        r = ev("""async () => {
          T.reads = 0;
          const before = T.held().loaded;
          const path = await view.exportPdf();
          const bytes = path ? fs.get(path) : null;
          const head = bytes ? String.fromCharCode(...bytes.slice(0, 5)) : '';
          const text = bytes ? new TextDecoder('latin1').decode(bytes) : '';
          await T.sleep(100);
          return { path, head, pages: (text.match(/\\/Type\\s*\\/Page[^s]/g) || []).length, reads: T.reads, before, held: T.held().loaded, top: view.store.slots[0].loaded,
            unread: notices.filter(m => /unreadable/.test(m)).length };
        }""")
        check('export: every page is read and exported (60 pages, none blank for being unread)',
              r['path'] == 'Books/Handout.pdf' and r['head'] == '%PDF-' and r['pages'] == 60 and r['reads'] >= 52 and r['unread'] == 0, {k: r[k] for k in r if k != 'text'})
        check('export: afterwards the pages are released again, the ones in view last', r['held'] <= 48 and r['top'], r)

        # ---- a PDF import can be cancelled, keeping the pages done so far
        r = ev("""async () => {
          dirs.add('Imports');
          const bytes = fakePdf(Array.from({ length: 40 }, () => [612, 792]));
          const n0 = notices.length;
          const done = p.importPdfAs({ basename: 'Long', bytes }, 'Long', 'Imports');
          for (let i = 0; i < 400 && !notices.slice(n0).some(m => /page 3 of 40/.test(m)); i++) await T.sleep(5);
          const button = lastNotice.noticeEl.querySelector('.nb-import-cancel');
          const had = !!button;
          button?.click();
          const path = await done;
          await T.sleep(200);
          const n = ink.readNote(fs.get('Imports/Long.md'), 'Long').pages.length;
          return { had, path, n, files: [...fs.keys()].filter(k => k.startsWith('Imports/Long/') && k.endsWith('.svg')).length,
            said: notices.slice(n0).filter(m => /Import stopped/.test(m)), open: view.file.path, slots: view.store.slots.length };
        }""")
        check('import: Cancel stops it after the page under way; the note holds the pages done and opens',
              r['had'] and r['path'] == 'Imports/Long.md' and 3 <= r['n'] < 40 and r['files'] == r['n'] and r['open'] == 'Imports/Long.md' and r['slots'] == r['n']
              and len(r['said']) == 1 and f"first {r['n']} of 40 pages" in r['said'][0], r)

        check('no page errors', errors == [], errors[:3])

except Exception:
    import traceback
    traceback.print_exc()
    failures.append('crashed')
finally:
    srv.terminate()

if failures:
    print(f'\n{len(failures)} failed: {failures}')
    sys.exit(1)
print('\nlarge-note checks passed')

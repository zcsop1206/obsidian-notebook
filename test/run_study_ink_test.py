# Anchored ink for study mode (S4): mounts page ink over a fake passage stack and a block
# surface, writes with synthetic pen events (coalesced, with WebKit-style repeated samples),
# saves, reloads, and checks the strokes come back anchored; then a new build of the doc:
# follow, dim with a keep/delete chip, orphan strip. Uses the mock obsidian module's in-memory
# vault (test/harness.html) and the ink module bundled by test/study-ink-build.mjs.
# Run: python test/run_study_ink_test.py (port 8774, or NB_STUDY_INK_PORT). Exits 1 on any failure.
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
import serve  # test/serve.py: the static server, refusing a port another run holds

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_STUDY_INK_PORT', int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 9))

subprocess.run(['node', 'test/study-ink-build.mjs'], cwd=ROOT, check=True, shell=(os.name == 'nt'))
srv = serve.start(port, ROOT)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(name)

with open(os.path.join(ROOT, 'test/fixtures/study/basics/fx-units.md'), encoding='utf-8') as f:
    V1 = f.read().replace('\r\n', '\n')
V2 = (V1.replace('build: 2', 'build: 3')
        .replace('## Units\n', '## Units\n\nA new opening paragraph, added in build 3.\n')
        .replace('$a$ is a unit mod $n$ if and only if $\\gcd(a, n) = 1$.', '$a$ is invertible mod $n$ exactly when $\\gcd(a, n) = 1$.')
        .replace('> [!example] Powers of 2 mod 7\n> Find the order of $2$ mod $7$.\n^ex-order\n\n> [!solution]- Solution\n> $2, 4, 1$: the order is $3$.\n\n', ''))
assert V2 != V1 and '^ex-order' not in V2 and 'invertible' in V2

# Helpers in the page: a fake study view (a stack of passages at paper scale, CSS-scaled), a
# fake StudyContext, and pen / finger / touch event drivers.
SETUP = r"""
(() => {
  const SI = window.studyInk;
  window.toasts = [];
  window.docs = new Map();
  window.mkctx = device => ({
    app: window.app,
    plugin: { register() {}, registerEvent() {} },
    ui: { toast: m => toasts.push(m) },
    settings: () => ({ root: 'study', device, minutes: 60, devTools: false }),
    content: () => ({ docs: window.docs }),
    events: () => [], log: async () => null, engine: () => null, onChange: () => () => {},
  });
  const leaf = document.getElementById('leaf');
  leaf.style.cssText = 'width:900px;height:640px;overflow:auto;position:relative;border:1px solid #ccc';
  window.SCALE = 0.85;
  window.renderDoc = (doc, spacer) => {
    leaf.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = `width:${920 * SCALE}px;`;
    const stack = document.createElement('div');
    stack.className = 'sr-stack';
    stack.style.cssText = `width:920px;transform:scale(${SCALE});transform-origin:0 0;font:16px/1.5 serif;`;
    if (spacer) { const s = document.createElement('div'); s.style.height = spacer + 'px'; stack.appendChild(s); }
    for (const p of doc.passages) {
      if (p.kind === 'rule') continue;
      const el = document.createElement('div');
      el.className = 'sr-passage';
      el.dataset.a = p.anchor;
      el.style.cssText = 'width:760px;padding:6px 20px;white-space:pre-wrap;min-height:40px;';
      if (p.items && p.items.length) {
        const ul = document.createElement('ul');
        for (const line of p.markdown.split('\n')) {
          const li = document.createElement('li');
          li.textContent = line.replace(/^- /, '');
          const it = p.items.find(i => line.includes(i.text.slice(0, 20)));
          if (it) li.dataset.a = it.anchor;
          ul.appendChild(li);
        }
        el.appendChild(ul);
      } else el.textContent = p.markdown;
      if (p.anchor === 'unit-gcd') {
        const a = document.createElement('a');
        a.href = '#'; a.className = 'internal-link'; a.textContent = ' [a link to Bezout]';
        a.addEventListener('click', e => { e.preventDefault(); window.linkClicks = (window.linkClicks || 0) + 1; });
        el.appendChild(a);
      }
      if (p.anchor === 'p-unit-gcd' || (p.block && p.block.id === 'unit-gcd')) el.dataset.box = '1';
      stack.appendChild(el);
    }
    wrap.appendChild(stack);
    leaf.appendChild(wrap);
    window.stack = stack;
    window.boxHost = stack.querySelector('[data-box]') || stack.querySelector('[data-a="unit-gcd"]');
    return stack;
  };
  window.passageTop = a => {
    const el = stack.querySelector(`[data-a="${CSS.escape(a)}"]`);
    if (!el || !el.getClientRects().length) return null;
    return (el.getBoundingClientRect().top - stack.getBoundingClientRect().top) / SCALE;
  };
  window.mount = (doc, device, spacer) => {
    window.ctx = mkctx(device);
    window.docs.set(doc.id, doc);
    renderDoc(doc, spacer);
    window.ink = SI.createInkApi(ctx);
    window.pageInk = ink.page(doc, stack, passageTop);
    window.surf = ink.surface(doc, boxHost, 'attempt:unit-gcd', { height: 160, meta: () => ({ e: 2 }) });
  };
  window.unmount = async () => { pageInk.destroy(); surf.destroy(); await SI.flushInk(ctx); };
  /* A pen stroke from client points: one pointerdown, pointermoves carrying coalesced events in
     groups of 3, each list repeating the previous group's last sample (as WebKit does), pointerup. */
  window.penStroke = (target, pts, type = 'pen', id = 7) => {
    let t = performance.now();
    const init = (q, extra = {}) => ({ pointerId: id, pointerType: type, pressure: 0.5, clientX: q[0], clientY: q[1], bubbles: true, cancelable: true, button: 0, buttons: 1, ...extra });
    target.dispatchEvent(new PointerEvent('pointerdown', init(pts[0])));
    let prev = null;
    for (let j = 1; j < pts.length; j += 3) {
      const group = pts.slice(j, j + 3);
      const list = (prev ? [prev] : []).concat(group).map(q => new PointerEvent('pointermove', init(q)));
      prev = group[group.length - 1];
      target.dispatchEvent(new PointerEvent('pointermove', { ...init(prev), coalescedEvents: list }));
    }
    target.dispatchEvent(new PointerEvent('pointerup', init(pts[pts.length - 1], { buttons: 0, pressure: 0 })));
  };
  /* A wavy stroke across an element, `dy` CSS px under its top. */
  window.strokeOver = (el, dy, type = 'pen', target = null) => {
    const r = el.getBoundingClientRect();
    const pts = [];
    for (let i = 0; i <= 24; i++) pts.push([r.left + 60 + i * 12, r.top + dy + 6 * Math.sin(i / 3)]);
    penStroke(target || el, pts, type);
  };
  window.byA = a => stack.querySelector(`[data-a="${CSS.escape(a)}"]`);
  /* Ink pixels (alpha > 0) in the page canvas within a paper-px rectangle. */
  window.inkPixels = (x0, y0, x1, y1) => {
    const c = stack.querySelector(':scope > canvas.nb-study-ink-canvas');
    const k = c.width / 920, top = parseFloat(c.style.top) || 0;
    const g = c.getContext('2d');
    const X = Math.max(0, Math.floor(x0 * k)), Y = Math.max(0, Math.floor((y0 - top) * k));
    const w = Math.max(1, Math.floor((x1 - x0) * k)), h = Math.max(1, Math.floor((y1 - y0) * k));
    const d = g.getImageData(X, Y, w, h).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  };
  window.touch = (el, type, touchType) => {
    const r = el.getBoundingClientRect();
    const t = new Touch({ identifier: 5, target: el, clientX: r.left + 30, clientY: r.top + 10 });
    Object.defineProperty(t, 'touchType', { value: touchType });  // Chromium's Touch has no touchType
    const e = new TouchEvent(type, { touches: [t], changedTouches: [t], bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };
  window.fileJson = p => (fs.has(p) ? JSON.parse(fs.get(p)) : null);
})();
"""

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        context = b.new_context(device_scale_factor=2, viewport={'width': 1000, 'height': 760})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.add_script_tag(url=f'http://localhost:{port}/test/out/study-ink.js')
        page.evaluate(SETUP)
        page.evaluate('([v1, v2]) => { window.D1 = studyInk.parseStudyDoc("study/basics/fx-units.md", v1); window.D2 = studyInk.parseStudyDoc("study/basics/fx-units.md", v2); }', [V1, V2])

        # --- 1. another device's file already on disk; mount page ink and a surface
        page.evaluate("""() => {
          renderDoc(D1);
          const top = passageTop('phi-prime');
          fs.set('study/ink/fx-units.ipad.json', JSON.stringify({ v: 1, doc: 'fx-units', strokes: [
            { id: 's-ipad1', p: [[100, top + 8, 0.5, 0], [300, top + 14, 0.5, 40]], t0: 1, at: { a: 'phi-prime', dy: top, rev: studyInk.model.docAnchors(D1).get('phi-prime'), v: 2 }, blk: null }] }));
          dirs.add('study'); dirs.add('study/ink');
          mount(D1, 'desktop');
        }""")
        page.wait_for_timeout(150)
        check('the other device\'s stroke loads into the union', page.evaluate("() => pageInk.placements().map(p => p.key)") == ['ipad:s-ipad1'])

        # --- 2. pen strokes: over a link, over two more passages, into the surface
        page.evaluate("""() => {
          window.linkClicks = 0;
          strokeOver(byA('unit-gcd'), 14);
          // a pen tap on the link: a dot of ink, and the click that follows must not follow the link
          const a = byA('unit-gcd').querySelector('a'), r = a.getBoundingClientRect();
          penStroke(a, [[r.left + 5, r.top + 5]]);
          a.click();
          strokeOver(byA('order-thm'), 12);
          strokeOver(byA('ex-order'), 10);
          strokeOver(surf.el, 40);
        }""")
        n_page = page.evaluate("() => pageInk.placements().length")
        check('pen strokes on the page are kept (3 strokes, 1 dot, 1 from the ipad)', n_page == 5, n_page)
        check('the Pencil never follows a link it writes over', page.evaluate('() => window.linkClicks') == 0, page.evaluate('() => window.linkClicks'))
        check('the surface has its stroke, with the meta field', page.evaluate("() => surf.count() === 1 && surf.strokes()[0].e === 2 && surf.strokes()[0].blk === 'attempt:unit-gcd'"))
        anchors = page.evaluate("() => pageInk.placements().filter(p => p.key.startsWith('desktop:')).map(p => p.a)")
        check('each page stroke is anchored to the passage it was written on', sorted(anchors) == ['ex-order', 'order-thm', 'unit-gcd', 'unit-gcd'], anchors)
        dense = page.evaluate("""() => {
          const st = surf.strokes()[0];
          const xs = st.p.map(q => q[0]);
          return { n: st.p.length, increasing: xs.every((x, i) => i === 0 || x > xs[i - 1]), paperW: Math.max(...xs) };
        }""")
        check('coalesced samples are all taken once (25 points, no doubling back)', dense['n'] == 25 and dense['increasing'], dense)

        # --- 3. fingers never draw; mouse on a link follows it; stylus touches are prevented
        page.evaluate("""() => {
          strokeOver(byA('h-order'), 10, 'touch');
          strokeOver(surf.el, 80, 'touch');
          const a = byA('unit-gcd').querySelector('a'), r = a.getBoundingClientRect();
          penStroke(a, [[r.left + 4, r.top + 4], [r.left + 30, r.top + 6]], 'mouse');
          a.click();
        }""")
        check('finger strokes never draw (page and surface)', page.evaluate("() => pageInk.placements().length === 5 && surf.count() === 1"))
        check('a mouse press on a link does not draw and the click follows', page.evaluate("() => window.linkClicks") == 1)
        check('a stylus touchmove over the page is prevented', page.evaluate("() => touch(byA('order-thm'), 'touchmove', 'stylus')") is True)
        check('a stylus touchstart over a surface is prevented', page.evaluate("() => touch(surf.el, 'touchstart', 'stylus')") is True)
        check('a finger touchmove is left alone', page.evaluate("() => touch(byA('order-thm'), 'touchmove', 'direct')") is False)

        # --- 4. the strokes are drawn where they were written
        px = page.evaluate("""() => { const t = passageTop('order-thm'); return [inkPixels(60, t + 2, 400, t + 26), inkPixels(60, t + 40, 400, t + 60)]; }""")
        check('page ink pixels sit on the order theorem', px[0] > 50 and px[1] == 0, px)
        canvas = page.evaluate("() => { const c = stack.querySelector(':scope > canvas.nb-study-ink-canvas'); return [c.width, c.height, parseFloat(c.style.height)]; }")
        check('the page canvas is at device resolution (0.85 x 2 per paper px)', abs(canvas[0] - round(920 * 0.85 * 2)) <= 1, canvas)

        # --- 5. undo removes only this device's latest stroke
        page.evaluate("() => strokeOver(byA('phi-prime'), 30)")
        undone = page.evaluate("() => { const s = pageInk.undo(); return s && s.dev + ':' + (s.at && s.at.a); }")
        check('undo removes this device\'s latest page stroke', undone == 'desktop:phi-prime', undone)
        page.evaluate("() => { for (let i = 0; i < 4; i++) pageInk.undo(); }")
        left = page.evaluate("() => pageInk.placements().map(p => p.key.split(':')[0])")
        check('undo never removes another device\'s stroke', left == ['ipad'], left)
        # redraw the four for the rest of the test
        page.evaluate("""() => {
          strokeOver(byA('unit-gcd'), 14); strokeOver(byA('order-thm'), 12); strokeOver(byA('ex-order'), 10);
        }""")

        # --- 6. saved 1 s after the last stroke, only this device's file
        page.wait_for_timeout(400)
        check('not saved before 1 s', page.evaluate("() => { const f = fileJson('study/ink/fx-units.desktop.json'); return !f || f.strokes.length !== 4; }"))
        page.wait_for_timeout(900)
        saved = page.evaluate("() => fileJson('study/ink/fx-units.desktop.json')")
        check('saved to study/ink/fx-units.desktop.json', saved is not None and saved['doc'] == 'fx-units' and len(saved['strokes']) == 4, saved and len(saved['strokes']))
        if saved:
            check('the file holds anchors and the block key', sorted(s['at']['a'] if s.get('at') else s['blk'] for s in saved['strokes']) == ['attempt:unit-gcd', 'ex-order', 'order-thm', 'unit-gcd'])
        check('the other device\'s file is untouched', page.evaluate("() => fileJson('study/ink/fx-units.ipad.json').strokes.length") == 1)
        page.evaluate("() => strokeOver(byA('h-units'), 8)")
        page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")  # visible: no flush
        page.evaluate("() => window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        page.wait_for_timeout(100)
        check('pagehide saves at once', page.evaluate("() => fileJson('study/ink/fx-units.desktop.json').strokes.length") == 5)
        page.evaluate("() => pageInk.undo()")
        page.wait_for_timeout(1200)

        before = page.evaluate("() => { const o = {}; for (const p of pageInk.placements()) o[p.key] = p; return o; }")
        top_before = page.evaluate("() => passageTop('order-thm')")
        page.screenshot(path=os.path.join(OUT, 'study_ink_written.png'))

        # --- 7. reload: a fresh context and stores read the files back; the layout moved 150 px down
        page.evaluate("async () => { await unmount(); }")
        page.evaluate("() => mount(D1, 'desktop', 150)")
        page.wait_for_timeout(200)
        after = page.evaluate("() => { const o = {}; for (const p of pageInk.placements()) o[p.key] = p; return o; }")
        top_after = page.evaluate("() => passageTop('order-thm')")
        check('after a reload every page stroke is back', sorted(after) == sorted(before), (sorted(before), sorted(after)))
        moved = [after[k]['dy'] - before[k]['dy'] for k in before if k in after]
        check('they follow their passages down by the new layout\'s 150 px', all(abs(m - 150) < 0.6 for m in moved) and abs(top_after - top_before - 150) < 0.6, moved)
        px2 = page.evaluate("""() => { const t = passageTop('order-thm'); return [inkPixels(60, t + 2, 400, t + 26), inkPixels(60, t - 148, 400, t - 124)]; }""")
        check('and are drawn there, not at the old place', px2[0] > 50 and px2[1] == 0, px2)
        check('the surface stroke is back', page.evaluate("() => surf.count()") == 1)
        page.screenshot(path=os.path.join(OUT, 'study_ink_reloaded.png'))

        # --- 8. a new build: follow, dim with a chip, orphan strip; keep and delete
        page.evaluate("async () => { await unmount(); window.docs.set('fx-units', D2); }")
        page.evaluate("() => { window.ctx = mkctx('desktop'); renderDoc(D2); window.ink = studyInk.createInkApi(ctx); window.pageInk = ink.page(D2, stack, passageTop); }")
        page.wait_for_timeout(200)
        counts = page.evaluate("() => pageInk.reanchor()")
        check('reanchor counts: 2 follow, 1 on rewritten text, 1 orphaned', counts == {'moved': 2, 'changed': 1, 'orphaned': 1}, counts)
        alphas = page.evaluate("() => { const o = {}; for (const p of pageInk.placements()) o[p.a] = p.alpha; return o; }")
        check('ink on the rewritten theorem is at 35%', abs(alphas.get('unit-gcd', 0) - 0.35) < 1e-9 and alphas.get('order-thm') == 1, alphas)
        chip = page.evaluate("() => { const c = stack.querySelector('.nb-study-ink-chip'); return c && c.textContent; }")
        check('a changed chip offers keep and delete', chip is not None and 'changed' in chip and 'keep' in chip and 'delete' in chip, chip)
        strip = page.evaluate("() => { const s = stack.querySelector('.nb-study-ink-orphans'); return s && [s.textContent, s === stack.lastElementChild]; }")
        check('the orphan strip is at the end, labelled with the old anchor', strip is not None and 'Orphaned ink' in strip[0] and '#ex-order' in strip[0] and strip[1], strip)
        orph = page.evaluate("""() => { const s = stack.querySelector('.nb-study-ink-orphan-space'); const sr = stack.getBoundingClientRect(), r = s.getBoundingClientRect();
          const top = (r.top - sr.top) / SCALE; const p = pageInk.placements().find(x => x.a === 'ex-order'); return [top, p && p.dy, inkPixels(60, top, 400, top + 40)]; }""")
        check('the orphaned stroke is drawn inside its strip space', orph[1] is not None and orph[2] > 30, orph)
        page.screenshot(path=os.path.join(OUT, 'study_ink_rebuilt.png'))
        page.evaluate("() => stack.querySelector('.nb-study-ink-keep').click()")
        alphas2 = page.evaluate("() => { const o = {}; for (const p of pageInk.placements()) o[p.a] = p.alpha; return o; }")
        check('keep: the ink is at full strength and the chip is gone', alphas2.get('unit-gcd') == 1 and page.evaluate("() => !stack.querySelector('.nb-study-ink-chip')"), alphas2)
        h_before = page.evaluate("() => parseFloat(stack.querySelector(':scope > canvas.nb-study-ink-canvas').style.height)")
        page.evaluate("() => stack.querySelector('.nb-study-ink-orphan-delete').click()")
        check('delete in the strip removes the orphans and the strip', page.evaluate("() => !stack.querySelector('.nb-study-ink-orphans') && !pageInk.placements().some(p => p.a === 'ex-order')"))
        page.evaluate("() => { pageInk.relayout(); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }")
        h_after = page.evaluate("() => [parseFloat(stack.querySelector(':scope > canvas.nb-study-ink-canvas').style.height), stack.offsetHeight]")
        check('the page canvas shrinks when the strip goes, to the content height', h_after[0] < h_before and abs(h_after[0] - h_after[1]) <= 2, [h_before, h_after])
        check('toasts said so', any('Kept' in t for t in page.evaluate('() => toasts')) and any('orphaned' in t for t in page.evaluate('() => toasts')))
        page.evaluate("async () => { pageInk.destroy(); await studyInk.flushInk(ctx); }")
        saved2 = page.evaluate("() => fileJson('study/ink/fx-units.desktop.json')")
        kept = [s for s in saved2['strokes'] if s.get('at') and s['at']['a'] == 'unit-gcd']
        check('the kept stroke now carries the new hash and build', kept and kept[0]['at']['v'] == 3 and kept[0]['at']['rev'] == page.evaluate("() => studyInk.model.docAnchors(D2).get('unit-gcd')"), kept)
        check('the orphan is gone from the file, the rest stay', sorted(s['at']['a'] if s.get('at') else s['blk'] for s in saved2['strokes']) == ['attempt:unit-gcd', 'order-thm', 'unit-gcd'])

        # --- 9. a sync brings another device's new stroke: re-read and drawn
        page.evaluate("() => { window.ctx = mkctx('desktop'); renderDoc(D2); window.ink = studyInk.createInkApi(ctx); window.pageInk = ink.page(D2, stack, passageTop); }")
        page.wait_for_timeout(150)
        page.evaluate("""() => {
          const f = fileJson('study/ink/fx-units.ipad.json'), top = passageTop('order-thm');
          f.strokes.push({ id: 's-ipad2', p: [[100, top + 30, 0.5, 0], [200, top + 30, 0.5, 9]], t0: 99, at: { a: 'order-thm', dy: top, rev: studyInk.model.docAnchors(D2).get('order-thm'), v: 3 }, blk: null });
          externalWrite('study/ink/fx-units.ipad.json', JSON.stringify(f));
        }""")
        page.wait_for_timeout(150)
        check('a synced stroke from the ipad appears', page.evaluate("() => pageInk.placements().some(p => p.key === 'ipad:s-ipad2')"))
        page.evaluate("() => pageInk.destroy()")

        # --- 10. a surface's colour per stroke (provenance) and a theme repaint
        red = page.evaluate("""() => {
          window.ctx = mkctx('desktop'); renderDoc(D2); window.ink = studyInk.createInkApi(ctx);
          const host = byA('h-order');
          window.surf2 = ink.surface(D2, host, 'fog:p-order-thm', { height: 120, meta: () => ({ e: 1 }), color: s => (s.e ? '#ff0000' : '--text-normal') });
          strokeOver(surf2.el, 30);
          const c = surf2.el.querySelector('canvas'), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data;
          let r = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60) r++;
          return r;
        }""")
        check('a surface draws each stroke in its own colour (fog reveals in a second colour)', red > 50, red)
        repainted = page.evaluate("""() => {
          const s = ink.surface(D2, byA('h-units'), 'call:x', { height: 80 });
          strokeOver(s.el, 20);
          document.body.style.setProperty('--text-normal', '#00ff00');
          app.workspace.trigger('css-change');
          const c = s.el.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let gr = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i + 1] > 200 && d[i] < 60) gr++;
          s.destroy(); surf2.destroy(); document.body.style.removeProperty('--text-normal');
          return gr;
        }""")
        check('the default ink is the theme text colour, repainted on css-change', repainted > 50, repainted)

        # --- 11. a tall doc: the page canvas covers a band around the view, within 16 M pixels
        band = page.evaluate("""async () => {
          window.ctx = mkctx('desktop'); renderDoc(D2, 24000); window.ink = studyInk.createInkApi(ctx);
          window.pageInk = ink.page(D2, stack, passageTop);
          await new Promise(r => setTimeout(r, 100));
          const c = stack.querySelector(':scope > canvas.nb-study-ink-canvas');
          const first = [parseFloat(c.style.top), c.width * c.height];
          const leaf = document.getElementById('leaf');
          byA('phi-prime').scrollIntoView();
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          strokeOver(byA('phi-prime'), 8);
          const t = passageTop('phi-prime');
          const second = [parseFloat(c.style.top), c.width * c.height, inkPixels(60, t, 400, t + 30), c.width / 920];
          pageInk.destroy();
          return { first, second };
        }""")
        f, s2 = band['first'], band['second']
        check('a tall page draws a band, at full resolution and under 16 M pixels', f[1] <= 16_000_000 and s2[1] <= 16_000_000 and abs(s2[3] - 1.7) < 0.01, band)
        check('scrolling far down moves the band and the ink is drawn there', s2[0] > 10000 and s2[2] > 50, band)

        check('no page errors', not errors, errors[:3])
        b.close()
finally:
    srv.terminate()

print(f'{len(failures)} failure(s)' if failures else 'all study ink checks passed')
sys.exit(1 if failures else 0)

# The study view (docs/study/SPEC.md, The study view; tickets S3, S4, S5 on docs/study/BOARD.md),
# on the mock harness (test/harness.html + test/mock-obsidian.js), like run_view_test.py. Loads the
# fixtures in test/fixtures/study/ into the mock vault under study/, plus a generated 60-passage
# doc (fx-long) and 120 generated basics, then checks: settings, the library (groups, search, no
# proofs or solutions), every passage rendered with its data-a, block mounts, finger taps that
# follow and flash, Back with scroll restore, a 450 ms hold that peeks (never a proof), Pencil
# events over a link that do not navigate, tabs, the header buttons, the protocol handler, "Open
# as study doc", re-render on a content change, and the layout at 1024x768 and 390x844.
# A second part (part_marks_panels) runs S5's marks and S8's Today and Map against the mock
# StudyContext and mock engine in test/out/study-fixture.js (built by test/build.mjs).
# Port: NB_STUDY_TEST_PORT, else NB_TEST_PORT_BASE + 6 (8771). Screenshots land in test/out/.
# Exits non-zero on a failure.
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
import serve  # test/serve.py: the static server, refusing a port another run holds

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
FIX = os.path.join(HERE, 'fixtures', 'study')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_STUDY_TEST_PORT', int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 6))
base_url = f'http://localhost:{port}'

failures = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    sys.stdout.flush()
    if not ok:
        failures.append(name)


def skip(name, why):
    print(f'SKIP {name}: {why}')


# ---------------------------------------------------------------- content

def fixture_files():
    files = {}
    for dirpath, _, names in os.walk(FIX):
        for n in names:
            if not n.endswith('.md'):
                continue
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, FIX).replace(os.sep, '/')
            with open(full, encoding='utf-8') as f:
                files['study/' + rel] = f.read().replace('\r\n', '\n')
    return files


LABEL = "> Written by a model for Adit. Not Adit's words."


def long_doc():
    """fx-long: a topic of 67 passages (6 headings, 60 paragraphs and lists), with links near the end."""
    out = ['---', 'study: topic', 'id: fx-long', 'title: A long doc (fixture)', 'area: [nt]', 'needs: [fx-units]', 'build: 1', '---', '', LABEL, '']
    for n in range(1, 61):
        if n % 10 == 1:
            out += [f'## Part {n // 10 + 1}', '']
        if n == 30:
            out += ['- An item to mark on its own. ^long-item-a', f'- An item with a [link to a cue](../topics/fx-topic.md#^cue-gcd). ^long-item-b', '']
            continue
        extra = ''
        if n == 5:
            extra = ' It rests on [Bézout](../basics/fx-div.md#^bezout).'
        if n == 50:
            extra = ' Follow the [order](../basics/fx-units.md#^order-thm) from here.'
        if n == 52:
            extra = ' Peek at the [units section](../basics/fx-units.md#Units) from here.'
        if n == 54:
            extra = ' What it [needs](../basics/fx-units.md#^needs).'
        out += [f'Passage {n}: an invented paragraph about residues, long enough to wrap onto a second line at the paper width, so the doc is tall.{extra} ^long-{n}', '']
    return '\n'.join(out)


AREAS = ['nt', 'comb', 'an', 'la', 'gen', 'dd', 'ca', 'th', 'mc', 'pd', 'sp', 'op']


def generated_docs(n=120):
    files = {}
    for i in range(n):
        area = AREAS[i % len(AREAS)]
        files[f'study/gen/g-{i:03d}.md'] = '\n'.join([
            '---', 'study: basic', f'id: g-{i:03d}', f'title: Generated basic {i:03d}', f'area: {area}', 'needs: []', 'build: 1', '---', '', LABEL, '',
            '## Idea', '', f'Generated paragraph {i} about an invented idea. ^g{i}-p1', '',
            f'> [!thm] Fact {i}', '> A generated statement.', f'^g{i}-thm', '',
            f'> [!derive] Prove fact {i}.', f'^g{i}-d', '',
        ])
    return files


SETUP_JS = """(files) => {
  for (const [p, t] of Object.entries(files)) {
    fs.set(p, t);
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join('/'));
  }
  const leaf = document.getElementById('leaf');
  leaf.style.cssText = 'width:100vw;height:100vh;border:0';
  document.body.style.margin = '0';
  window.pageErrors = [];
  window.sleep = ms => new Promise(r => setTimeout(r, ms));
  window.V = () => { const l = app.workspace.getLeavesOfType('notebook-study')[0]; return l ? l.view : null; };
  window.scroller = () => document.querySelector('.nb-study-scroll');
  // The doc's own elements: S5's margin dots and scaffolds also carry data-a, so they are skipped.
  window.studyEl = sel => [...document.querySelectorAll('.nb-study-doc ' + sel)].find(e => !e.closest('.nb-study-margin, .nb-st-scaffold')) || null;
  // Synthetic pointer events (touch, pen or mouse) at an element's centre, then the click a tap makes.
  window.press = async (el, type, ms, opts = {}) => {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 20), y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, pointerId: opts.id || 11, pointerType: type, isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 1, pressure: type === 'pen' ? 0.5 : 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', base));
    if (opts.move) { await sleep(ms / 2); window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + opts.move, clientY: y + opts.move })); await sleep(ms / 2); }
    else await sleep(ms);
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, clientX: x + (opts.move || 0), clientY: y + (opts.move || 0) }));
    if (!opts.noClick) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, detail: 1 }));
  };
  // The passages the view must render for a doc: all but solutions and kata-owned code.
  window.expectedAnchors = id => {
    const d = plugin.study.content().docs.get(id);
    return d.passages.filter(p => !(p.block && p.block.type === 'solution') && !(p.callout && p.callout.type === 'solution')
      && !(d.kind === 'kata' && p.kind === 'code' && (p.lang === 'skeleton' || p.lang === 'vectors'))).map(p => p.anchor);
  };
  window.renderedAnchors = () => [...document.querySelectorAll('.nb-study-doc .sr-passage[data-a]')].map(e => e.getAttribute('data-a'));
  // Where an element sits in the view: its top relative to the scroller's top, in screen px.
  window.topInView = el => el.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  // A pen stroke from client points (coalesced events in groups of 3, WebKit-style repeats), as
  // in test/run_study_ink_test.py; the ink layer listens for pointerdown on the doc stack.
  window.penStroke = (target, pts, type = 'pen', id = 7) => {
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
  // A wavy stroke across an element, `dy` CSS px under its top.
  window.strokeOver = (el, dy, type = 'pen') => {
    const r = el.getBoundingClientRect();
    const pts = [];
    for (let i = 0; i <= 24; i++) pts.push([r.left + 60 + i * 12, r.top + dy + 6 * Math.sin(i / 3)]);
    penStroke(el, pts, type);
  };
  window.fileJson = p => (fs.has(p) ? JSON.parse(fs.get(p)) : null);
  // Ink pixels (alpha > 0) in the page canvas within a paper-px rectangle of the 800 px paper.
  window.inkPx = (x0, y0, x1, y1) => {
    const c = document.querySelector('.nb-study-doc > canvas.nb-study-ink-canvas');
    if (!c) return -1;
    const k = c.width / 800, top = parseFloat(c.style.top) || 0;
    const g = c.getContext('2d');
    const X = Math.max(0, Math.floor(x0 * k)), Y = Math.max(0, Math.floor((y0 - top) * k));
    const w = Math.max(1, Math.floor((x1 - x0) * k)), h = Math.max(1, Math.floor((y1 - y0) * k));
    const d = g.getImageData(X, Y, w, h).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  };
}"""


def wait_js(page, js, timeout=5000, arg=None):
    try:
        page.wait_for_function(js, arg=arg, timeout=timeout)
        return True
    except Exception:
        return False


def wait_doc(page, doc, timeout=6000):
    return wait_js(page, "d => V() && V().currentDoc() === d && V().renderDone()", timeout, doc)


def open_doc(page, doc, anchor=None):
    page.evaluate("([d, a]) => plugin.study.ui.openDoc(d, a || undefined)", [doc, anchor])
    return wait_doc(page, doc)


# ---------------------------------------------------------------- sections

def section_settings(page):
    st = page.evaluate("() => ({ s: plugin.settings.study, ctx: plugin.study.settings() })")
    check('settings: settings.study parsed and validated', st['s'] == {'root': 'study', 'device': 'test-pad', 'minutes': 45, 'devTools': False}, json.dumps(st['s']))
    check('settings: the study context reads them', st['ctx']['device'] == 'test-pad' and st['ctx']['root'] == 'study' and st['ctx']['minutes'] == 45)
    rows = page.evaluate("""() => {
      const tab = plugin.settingTabs[0];
      tab.display();
      document.body.appendChild(tab.containerEl);
      const names = [...tab.containerEl.querySelectorAll('.setting-item')].map(e => e.dataset.name).filter(Boolean);
      return names;
    }""")
    want = ['Study mode', 'Study folder', 'Device name', 'Weekday minutes', 'Developer tools']
    check('settings tab: the study rows', all(w in rows for w in want), json.dumps(rows[-6:]))
    saved = page.evaluate("""async () => {
      const tab = plugin.settingTabs[0];
      const input = tab.containerEl.querySelector('.nb-study-setting-minutes input');
      input.value = '90'; input.dispatchEvent(new Event('input'));
      const dev = tab.containerEl.querySelector('.nb-study-setting-device input');
      dev.value = 'Lap Top'; dev.dispatchEvent(new Event('input'));
      const tog = tab.containerEl.querySelector('.nb-study-setting-devtools input');
      tog.checked = true; tog.dispatchEvent(new Event('change'));
      await sleep(50);
      const out = JSON.parse(JSON.stringify(window.pluginData.study));
      // Back to the test values.
      input.value = '45'; input.dispatchEvent(new Event('input'));
      dev.value = 'test-pad'; dev.dispatchEvent(new Event('input'));
      tog.checked = false; tog.dispatchEvent(new Event('change'));
      await sleep(50);
      tab.containerEl.remove();
      return out;
    }""")
    check('settings tab: rows save cleaned values', saved == {'root': 'study', 'device': 'lap-top', 'minutes': 90, 'devTools': True}, json.dumps(saved))


def section_library(page):
    t0 = time.time()
    page.evaluate("() => commands['open-study'].callback()")
    ok = wait_js(page, "() => document.querySelectorAll('.nb-study-row').length > 100", 8000)
    lib_ms = (time.time() - t0) * 1000
    check('library: opens from "Open study" with every doc', ok)
    info = page.evaluate("""() => ({
      rows: [...document.querySelectorAll('.nb-study-row')].map(b => b.dataset.open),
      kinds: [...document.querySelectorAll('.nb-study-kind > h3')].map(h => h.textContent),
      areas: [...document.querySelectorAll('.nb-study-kind[data-kind=basic] .nb-study-area')].map(a => a.dataset.area),
      ntBasics: [...document.querySelectorAll('.nb-study-kind[data-kind=basic] .nb-study-area[data-area=nt] .nb-study-row')].map(b => b.dataset.open),
      ribbon: plugin.ribbon.map(r => r.title),
    })""")
    rows = info['rows']
    print(f'  library: {len(rows)} rows in {lib_ms:.0f} ms (open to listed; the content index loads when the plugin does)')
    for d in ['fx-topic', 'fx-long', 'fx-units', 'fx-div', 'k-fx', 'fxbank']:
        check(f'library: lists {d}', d in rows)
    check('library: 120 generated basics listed', sum(1 for r in rows if r.startswith('g-')) == 120)
    check('library: notes that are not study docs are not listed', 'notes-not-study' not in rows and 'methods' not in rows and 'tracks' not in rows)
    check('library: grouped by kind, topics first', info['kinds'] == ['Topics', 'Basics', 'Katas', 'Problem banks'], json.dumps(info['kinds']))
    check('library: basics grouped by area in FORMAT order', info['areas'][:4] == ['nt', 'comb', 'an', 'la'], json.dumps(info['areas']))
    check('library: fx-div and fx-units under number theory', 'fx-div' in info['ntBasics'] and 'fx-units' in info['ntBasics'])
    check('library: a ribbon icon opens it', 'Open study' in info['ribbon'])

    page.fill('.nb-study-search', 'Bézout')
    ok = wait_js(page, "() => !!document.querySelector('.nb-study-hit[data-open=\"fx-div#bezout\"]')", 3000)
    check('library search: finds a passage by its text (accents folded)', ok)
    page.fill('.nb-study-search', 'minimality')
    page.wait_for_timeout(300)
    hits = page.evaluate("() => document.querySelectorAll('.nb-study-hit').length")
    check('library search: never a proof', hits == 0, f'{hits} hits')
    page.fill('.nb-study-search', '2401')
    page.wait_for_timeout(300)
    check('library search: never a solution', page.evaluate("() => document.querySelectorAll('.nb-study-hit').length") == 0)
    t0 = time.time()
    page.fill('.nb-study-search', 'generated')
    ok = wait_js(page, "() => document.querySelectorAll('.nb-study-hit').length >= 40", 3000)
    print(f'  library search over 126 docs: {(time.time() - t0) * 1000:.0f} ms (including the 120 ms debounce)')
    check('library search: many matches capped at 40', ok)
    page.fill('.nb-study-search', '')


def section_render(page):
    page.click('.nb-study-row[data-open="fx-units"]')
    ok = wait_doc(page, 'fx-units')
    check('render: a library row opens the doc', ok)
    want = page.evaluate("() => expectedAnchors('fx-units')")
    got = page.evaluate("() => renderedAnchors()")
    check('render: every passage in order with its data-a (solutions left out)', got == want, f'got {got} want {want}')
    info = page.evaluate("""() => ({
      item: !!studyEl('li.sr-item[data-a="cue-exponent"]'),
      itemInList: !!studyEl('.sr-passage li[data-a="cue-exponent"]'),
      label: (studyEl('.sr-passage.sr-label') || {}).textContent,
      title: (studyEl('.sr-title') || {}).textContent,
      meta: (studyEl('.sr-meta') || {}).textContent,
      fog: document.querySelectorAll('.nb-study-doc .sr-block[data-block=fog]').length,
      drill: document.querySelectorAll('.nb-study-doc .sr-block[data-block=drill]').length,
      problem: document.querySelectorAll('.nb-study-doc .sr-block[data-block=problem]').length,
      blocksFilled: [...document.querySelectorAll('.nb-study-doc .sr-block')].every(b => b.childElementCount > 0),
      proofText: document.querySelector('.nb-study-doc').textContent.includes('ax - kn'),
      solutionText: document.querySelector('.nb-study-doc').textContent.includes('2401'),
      math: !!studyEl('.sr-passage[data-a="phi-prime"] .math'),
      table: !!studyEl('.sr-passage[data-a="inverse-table"] table'),
      callout: !!studyEl('.sr-passage[data-a="unit-def"] .callout[data-callout="def"]'),
      studyLinks: document.querySelectorAll('.nb-study-doc a[data-study-to]').length,
      external: !!studyEl('a.external-link'),
      renders: window.markdownRenders,
    })""")
    check('render: anchored list items get data-a on their <li>', info['item'] and info['itemInList'])
    check('render: the model label as a byline', info['label'] == "Written by a model for Adit. Not Adit's words.", str(info['label']))
    check('render: title and meta line', info['title'] == 'Units mod n (fixture)' and 'build 2' in (info['meta'] or ''), f"{info['title']} / {info['meta']}")
    check('render: blocks mount (2 fog, 1 drill, 2 problem)', info['fog'] == 2 and info['drill'] == 1 and info['problem'] == 2 and info['blocksFilled'], json.dumps(info))
    check('render: no proof or solution text on the page', not info['proofText'] and not info['solutionText'])
    check('render: math, tables and callouts through MarkdownRenderer', info['math'] and info['table'] and info['callout'])
    check('render: links into study docs are marked', info['studyLinks'] >= 4 and info['external'], str(info['studyLinks']))
    # Other docs: the kata hides its skeleton and vectors, the topic mounts bank problems.
    open_doc(page, 'k-fx')
    k = page.evaluate("() => ({ got: renderedAnchors(), want: expectedAnchors('k-fx'), kata: document.querySelectorAll('.nb-study-doc .sr-block[data-block=kata]').length, code: document.querySelector('.nb-study-doc').textContent.includes('endmodule') })")
    check('render: a kata doc mounts its kata block and leaves its skeleton and vectors to it', k['got'] == k['want'] and k['kata'] == 1 and not k['code'], json.dumps(k))
    open_doc(page, 'fx-topic')
    t = page.evaluate("() => ({ got: renderedAnchors(), want: expectedAnchors('fx-topic'), problems: document.querySelectorAll('.nb-study-doc .sr-block[data-block=problem]').length, items: document.querySelectorAll('.nb-study-doc li[data-a]').length })")
    check('render: a topic renders its passages, items and bank problems', t['got'] == t['want'] and t['problems'] == 2 and t['items'] == 2, json.dumps(t))


def section_follow(page):
    open_doc(page, 'fx-units')
    page.evaluate("() => { scroller().scrollTop = 0; }")
    depth0 = page.evaluate("() => V().backDepth()")
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-div#bezout\"]'), 'touch', 60)")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div' && !!studyEl('.sr-passage[data-a=\"bezout\"].sr-flash')", 4000)
    check('finger tap: follows the link and flashes the target', ok)
    check('finger tap: one entry on the back stack', page.evaluate("() => V().backDepth()") == depth0 + 1)
    # A slow press (over 300 ms, under the hold) and a drag do nothing.
    open_doc(page, 'fx-units')
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-div#bezout\"]'), 'touch', 360, { noClick: true })")
    page.wait_for_timeout(300)
    check('finger: a 360 ms press neither follows nor peeks', page.evaluate("() => V().currentDoc() === 'fx-units' && !document.querySelector('.nb-study-peek').isShown()"))
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-div#bezout\"]'), 'touch', 120, { move: 24, noClick: true })")
    page.wait_for_timeout(200)
    check('finger: a drag does not follow', page.evaluate("() => V().currentDoc() === 'fx-units'"))
    # Same-doc link.
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-units#order-thm\"]'), 'touch', 50)")
    ok = wait_js(page, "() => !!studyEl('.sr-passage[data-a=\"order-thm\"].sr-flash')", 3000)
    check('finger tap: a link within the doc scrolls to and flashes its target', ok and page.evaluate("() => Math.abs(topInView(studyEl('[data-a=\"order-thm\"]')) - 16) < 4"))
    # A mouse click follows too (laptop).
    page.evaluate("() => { scroller().scrollTop = 0; }")
    page.click('.nb-study-doc a[data-study-to="fx-div#cong-arith"]') if page.evaluate("() => !!studyEl('a[data-study-to=\"fx-div#cong-arith\"]')") else None
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div'", 3000)
    check('mouse click: follows the link', ok)
    # A link to a missing anchor opens the doc at the top with a notice.
    open_doc(page, 'fx-units')
    n0 = page.evaluate("() => notices.length")
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-topic#moves\"]'), 'touch', 50)")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-topic'", 3000)
    msg = page.evaluate("n => notices.slice(n).join(' | ')", n0)
    check('finger tap: a missing anchor opens the doc and says so', ok and '#moves is not in build 1' in msg, msg)
    # External links open in the browser, not in the view.
    open_doc(page, 'fx-units')
    page.evaluate("() => { window.opened = []; window.open = (u) => { opened.push(u); return null; }; }")
    page.evaluate("() => press(studyEl('a.external-link'), 'touch', 50)")
    page.wait_for_timeout(100)
    check('finger tap: an external link opens outside', page.evaluate("() => opened.length === 1 && opened[0] === 'https://example.org/x.pdf' && V().currentDoc() === 'fx-units'"))


def section_back(page):
    t0 = time.time()
    ok = open_doc(page, 'fx-long')
    open_ms = (time.time() - t0) * 1000
    stats = page.evaluate("() => V().stats")
    n = len(page.evaluate("() => renderedAnchors()"))
    print(f'  fx-long: {n} passages rendered in {stats["lastRenderMs"]:.0f} ms (open to fully rendered {open_ms:.0f} ms)')
    check('render: a 67-passage doc renders completely', ok and n == len(page.evaluate("() => expectedAnchors('fx-long')")), str(n))
    check('render: a 67-passage doc renders in under 1.5 s', stats['lastRenderMs'] < 1500, f"{stats['lastRenderMs']:.0f} ms")
    top = page.evaluate("""() => {
      const a = studyEl('a[data-study-to="fx-units#order-thm"]');
      scroller().scrollTop = Math.max(0, scroller().scrollTop + topInView(a) - 200);
      return scroller().scrollTop;
    }""")
    check('back: the long doc scrolls (setup)', top > 1000, str(top))
    saves0 = page.evaluate("() => window.saveLayoutRequests || 0")
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-units#order-thm\"]'), 'touch', 50)")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-units' && !!studyEl('.sr-passage[data-a=\"order-thm\"].sr-flash')", 4000)
    check('back: followed into fx-units', ok)
    saves1 = page.evaluate("() => window.saveLayoutRequests || 0")
    page.click('.nb-study-hdr [data-act="back"]')
    ok = wait_js(page, "() => V().currentDoc() === 'fx-long' && V().renderDone()", 4000)
    now = page.evaluate("() => scroller().scrollTop")
    check('back: returns to the doc at the same scroll position', ok and abs(now - top) <= 2, f'{now} vs {top}')
    saves2 = page.evaluate("() => window.saveLayoutRequests || 0")
    check('back: following a link and Back each ask Obsidian to save the layout', saves1 > saves0 and saves2 > saves1, f'{saves0} {saves1} {saves2}')
    # Back across a dropped render (the doc is rendered again from scratch).
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-units#order-thm\"]'), 'touch', 50)")
    wait_doc(page, 'fx-units')
    for i in range(7):
        open_doc(page, f'g-{i:03d}')
    for _ in range(7):
        page.click('.nb-study-hdr [data-act="back"]')
        page.wait_for_timeout(60)
    ok = wait_js(page, "() => V().currentDoc() === 'fx-units' && V().renderDone()", 4000)
    page.click('.nb-study-hdr [data-act="back"]')
    ok = wait_js(page, "() => V().currentDoc() === 'fx-long' && V().renderDone()", 4000)
    now = page.evaluate("() => scroller().scrollTop")
    check('back: restores the scroll of a doc whose tab was closed meanwhile', ok and abs(now - top) <= 2, f'{now} vs {top}')


def section_peek(page):
    open_doc(page, 'fx-long')
    page.evaluate("""() => { const a = studyEl('a[data-study-to="fx-units#h-units"]'); scroller().scrollTop += topInView(a) - 200; }""")
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-units#h-units\"]'), 'touch', 520, { noClick: true })")
    ok = wait_js(page, "() => document.querySelector('.nb-study-peek').isShown() && document.querySelector('.nb-study-peek .sr-peek-passage')", 2000)
    peek = page.evaluate("() => ({ text: document.querySelector('.nb-study-peek').textContent, doc: V().currentDoc(), to: document.querySelector('.nb-study-peek').dataset.to })")
    check('hold 450 ms: shows a peek of the target', ok and peek['to'] == 'fx-units#h-units' and 'Units' in peek['text'] and 'unit' in peek['text'], peek['text'][:120])
    check('hold: does not navigate', peek['doc'] == 'fx-long')
    check('peek: a proof shows as fogged, never its text', 'Proof fogged' in peek['text'] and 'ax - kn' not in peek['text'])
    page.screenshot(path=os.path.join(OUT, 'study_peek.png'))
    # A pointer down outside closes it.
    page.evaluate("() => { const s = scroller(); s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 3, isPrimary: true, clientX: 10, clientY: 300 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 3 })); }")
    check('peek: a touch outside closes it', page.evaluate("() => !document.querySelector('.nb-study-peek').isShown()"))
    # Peek of a passage with links; the Pencil taps a link inside the peek: it follows (no writing there).
    page.evaluate("""() => { const a = studyEl('a[data-study-to="fx-units#needs"]'); scroller().scrollTop += topInView(a) - 200; }""")
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-units#needs\"]'), 'touch', 520, { noClick: true })")
    ok = wait_js(page, "() => !!document.querySelector('.nb-study-peek a[data-study-to=\"fx-div#bezout\"]')", 2000)
    check('peek: renders the passage with its links', ok)
    page.evaluate("() => press(document.querySelector('.nb-study-peek a[data-study-to=\"fx-div#bezout\"]'), 'pen', 50)")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div' && !document.querySelector('.nb-study-peek').isShown()", 3000)
    check('peek: a Pencil tap on a link in the peek follows it', ok)
    # The peek's Open button.
    open_doc(page, 'fx-units')
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-div#bezout\"]'), 'touch', 520, { noClick: true })")
    wait_js(page, "() => document.querySelector('.nb-study-peek').isShown()", 2000)
    page.click('.nb-study-peek [data-peek-open]')
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div' && !!studyEl('.sr-passage[data-a=\"bezout\"].sr-flash')", 3000)
    check('peek: Open follows to the target', ok)


def section_pen(page):
    open_doc(page, 'fx-units')
    page.evaluate("() => { scroller().scrollTop = 0; }")
    before = page.evaluate("() => ({ doc: V().currentDoc(), depth: V().backDepth(), pen: V().gestureStats().penIgnored })")
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-div#bezout\"]'), 'pen', 60)")
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-div#bezout\"]'), 'pen', 600)")
    page.wait_for_timeout(300)
    after = page.evaluate("() => ({ doc: V().currentDoc(), depth: V().backDepth(), pen: V().gestureStats().penIgnored, peek: document.querySelector('.nb-study-peek').isShown() })")
    check('pen over a link: never follows it', after['doc'] == 'fx-units' and after['depth'] == before['depth'], json.dumps(after))
    check('pen held on a link: never peeks', not after['peek'])
    check('pen: the gestures saw the pen and let it write', after['pen'] == before['pen'] + 2)
    # A stylus touch on the page is prevented (no scroll under the Pencil); a finger touch is not.
    r = page.evaluate("""() => {
      const a = studyEl('a[data-study-to="fx-div#bezout"]');
      const mk = type => { const t = new Touch({ identifier: 1, target: a, clientX: 10, clientY: 10 }); Object.defineProperty(t, 'touchType', { value: type }); return t; };
      const pen = new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [mk('stylus')], changedTouches: [mk('stylus')] });
      const finger = new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [mk('direct')], changedTouches: [mk('direct')] });
      a.dispatchEvent(pen); a.dispatchEvent(finger);
      return { pen: pen.defaultPrevented, finger: finger.defaultPrevented };
    }""")
    check('pen: a stylus touch on the page is held from scrolling; a finger is not', r['pen'] and not r['finger'], json.dumps(r))
    # A Pencil tap still reaches the page ink's controls: role=button and no-ink elements are not held.
    r = page.evaluate("""() => {
      const body = studyEl('.nb-study-passages'), box = document.createElement('div');
      box.className = 'test-pen-controls';
      box.innerHTML = '<span role="button">b</span><div class="no-ink">n</div><div class="nb-study-no-ink">s</div>';
      body.appendChild(box);
      const out = [...box.children].map(el => {
        const t = new Touch({ identifier: 2, target: el, clientX: 10, clientY: 10 });
        Object.defineProperty(t, 'touchType', { value: 'stylus' });
        const ev = new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      box.remove();
      return out;
    }""")
    check('pen: a stylus touch on role=button, .no-ink or .nb-study-no-ink is not held', r == [False, False, False], json.dumps(r))
    # Inside a block (proof steps, problem statements, derive prompts) the Pencil writes over a link
    # as on the rest of the page; only on the ink's controls (.no-ink) does it tap like a finger.
    page.evaluate("""() => {
      const blk = studyEl('.sr-block');
      const a = document.createElement('a');
      a.className = 'internal-link sr-ref test-block-link';
      a.setAttribute('href', '#'); a.setAttribute('data-study-to', 'fx-div#bezout'); a.textContent = 'Bezout in a block';
      blk.appendChild(a);
      const c = document.createElement('div');
      c.className = 'no-ink test-block-control';
      c.innerHTML = '<a class="internal-link sr-ref" href="#" data-study-to="fx-div#bezout">Bezout on a control</a>';
      blk.appendChild(c);
    }""")
    before = page.evaluate("() => ({ depth: V().backDepth(), pen: V().gestureStats().penIgnored, block: studyEl('.sr-block').getAttribute('data-block') })")
    page.evaluate("() => press(studyEl('.test-block-link'), 'pen', 60)")
    page.wait_for_timeout(200)
    after = page.evaluate("() => ({ doc: V().currentDoc(), depth: V().backDepth(), pen: V().gestureStats().penIgnored })")
    check('pen over a link inside a block: writes, never follows', after['doc'] == 'fx-units' and after['depth'] == before['depth'] and after['pen'] == before['pen'] + 1, json.dumps([before, after]))
    page.evaluate("() => press(studyEl('.test-block-control a'), 'pen', 60)")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div'", 3000)
    check('pen on a link in a no-ink control: taps like a finger and follows', ok)
    page.evaluate("() => V().back()")
    wait_doc(page, 'fx-units')
    page.evaluate("() => document.querySelectorAll('.test-block-link, .test-block-control').forEach(e => e.remove())")


def section_tabs(page):
    for i in range(8):
        open_doc(page, f'g-{i + 10:03d}')
        r = page.evaluate("""() => {
          const strip = document.querySelector('.nb-study-tabs'), on = strip.querySelector('.nb-study-tab.is-active');
          const s = strip.getBoundingClientRect(), a = on ? on.getBoundingClientRect() : null;
          return { n: strip.querySelectorAll('.nb-study-tab').length, tabs: V().openTabs().length, active: on ? on.dataset.tab : null, inView: !!a && a.left >= s.left - 1 && a.right <= s.right + 1 };
        }""")
    check('tabs: at most 6', r['n'] == 6 and r['tabs'] == 6, json.dumps(r))
    check('tabs: the active one is the doc on screen and in view', r['active'] == 'g-017' and r['inView'], json.dumps(r))
    page.evaluate("() => { scroller().scrollTop = 40; }")
    page.click('.nb-study-tab[data-tab="g-015"] .nb-study-tab-open')
    ok = wait_js(page, "() => V().currentDoc() === 'g-015'", 3000)
    page.click('.nb-study-tab[data-tab="g-017"] .nb-study-tab-open')
    ok2 = wait_js(page, "() => V().currentDoc() === 'g-017'", 3000)
    check('tabs: switching shows each doc, keeping its scroll', ok and ok2 and page.evaluate("() => scroller().scrollTop") == page.evaluate("() => Math.min(40, scroller().scrollHeight - scroller().clientHeight)"))
    saves = page.evaluate("() => window.saveLayoutRequests || 0")
    page.click('.nb-study-tab[data-tab="g-017"] .nb-study-tab-close')
    ok = wait_js(page, "() => V().currentDoc() === 'g-016' && V().openTabs().length === 5", 3000)
    check('tabs: closing the active tab shows its neighbour', ok)
    check('tabs: switching and closing tabs ask Obsidian to save the layout', page.evaluate("() => window.saveLayoutRequests || 0") > saves)
    saves = page.evaluate("() => window.saveLayoutRequests || 0")
    page.click('.nb-study-tab[data-tab="g-013"] .nb-study-tab-close')
    ok = wait_js(page, "() => V().openTabs().length === 4 && V().currentDoc() === 'g-016'", 3000)
    check('tabs: closing a background tab saves the layout', ok and page.evaluate("() => window.saveLayoutRequests || 0") == saves + 1)
    # The cache holds only the open tabs, also when a new doc opens from the oldest tab (the one
    # the strip drops): its rendered DOM, blocks and page ink go with the tab.
    for d in ['g-030', 'g-031']:
        open_doc(page, d)
    page.click('.nb-study-tab[data-tab="g-012"] .nb-study-tab-open')
    ok = wait_js(page, "() => V().currentDoc() === 'g-012' && V().openTabs().length === 6 && V().openTabs()[0] === 'g-012'", 3000)
    open_doc(page, 'g-032')
    r = page.evaluate("() => ({ tabs: V().openTabs(), cache: V().cachedDocs(), docs: document.querySelectorAll('.nb-study-doc').length })")
    check('tabs: a 7th doc opened from the oldest tab leaves the cache equal to the tabs', ok and sorted(r['cache']) == sorted(r['tabs']) and len(r['tabs']) == 6 and 'g-012' not in r['cache'], json.dumps(r))


def section_header(page):
    open_doc(page, 'fx-units')
    page.evaluate("""() => {
      window.uiCalls = [];
      window.realUi = { openToday: plugin.study.ui.openToday, openMap: plugin.study.ui.openMap };
      plugin.study.ui.openToday = async () => { uiCalls.push('today'); };
      plugin.study.ui.openMap = async () => { uiCalls.push('map'); };
    }""")
    page.click('.nb-study-hdr [data-act="today"]')
    page.click('.nb-study-hdr [data-act="map"]')
    check('header: Today and Map call ctx.ui', page.evaluate("() => uiCalls.join(',')") == 'today,map')
    page.evaluate("() => Object.assign(plugin.study.ui, realUi)")
    n0 = page.evaluate("() => notices.length")
    page.click('.nb-study-hdr [data-act="changes"]')
    page.wait_for_timeout(150)
    r = page.evaluate("n => ({ notes: notices.slice(n).join(' | '), panel: !!document.querySelector('[class*=changes]:not([data-act])') })", n0)
    check('header: Changes opens the doc\'s changes (S5 stub or panel)', 'fx-units' in r['notes'] or r['panel'], json.dumps(r))
    page.click('.nb-study-hdr [data-act="library"]')
    check('header: Library shows the library over the doc', page.evaluate("() => document.querySelector('.nb-study-lib').isShown() && V().currentDoc() === 'fx-units'"))
    page.click('.nb-study-lib-close')
    check('library: Close returns to the doc', page.evaluate("() => !document.querySelector('.nb-study-lib').isShown()"))


def section_open_paths(page):
    page.evaluate("() => protocolHandlers.notebook({ action: 'notebook', study: 'fx-div', a: 'cong-arith' })")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div' && !!studyEl('.sr-passage[data-a=\"cong-arith\"].sr-flash')", 3000)
    check('protocol: obsidian://notebook?study=<id>&a=<anchor> opens and flashes', ok)
    page.evaluate("() => plugin.study.ui.openDrill('fx-units', 'd-order-divides')")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-units' && !!studyEl('.sr-passage[data-a=\"d-order-divides\"].sr-flash')", 3000)
    check('ctx.ui.openDrill: opens the doc at the derive prompt and flashes it', ok)
    r = page.evaluate("""async () => {
      const md = app.workspace.getLeaf(true);
      await md.openFile(app.vault.getFile('study/basics/fx-units.md'));
      const cmd = commands['open-as-study'];
      const yes = cmd.checkCallback(true);
      const menu = new obsidian.Menu();
      app.workspace.trigger('file-menu', menu, app.vault.getFile('study/basics/fx-units.md'), 'more-options', md);
      const item = menu.items.find(i => i.title === 'Open as study doc');
      const other = new obsidian.Menu();
      app.workspace.trigger('file-menu', other, app.vault.getFile('study/notes-not-study.md'), 'more-options', md);
      await md.openFile(app.vault.getFile('study/notes-not-study.md'));
      const no = cmd.checkCallback(true);
      await md.openFile(app.vault.getFile('study/basics/fx-div.md'));
      cmd.checkCallback(false);
      await sleep(300);
      return { yes, no, item: !!item, otherItem: other.items.some(i => i.title === 'Open as study doc') };
    }""")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div'", 3000)
    check('"Open as study doc": offered for a study doc, not for other notes', r['yes'] and not r['no'], json.dumps(r))
    check('"Open as study doc": in the file menu of a study doc only', r['item'] and not r['otherItem'])
    check('"Open as study doc": opens the doc in the study view', ok)


def section_content_change(page):
    open_doc(page, 'fx-units')
    page.evaluate("""() => { const el = studyEl('[data-a="order-thm"]'); scroller().scrollTop += topInView(el) - 120; }""")
    off0 = page.evaluate("() => topInView(studyEl('[data-a=\"order-thm\"]'))")
    page.evaluate("""() => {
      const p = 'study/basics/fx-units.md';
      const t = fs.get(p).replace('build: 2', 'build: 3').replace('## Units', '## Units\\n\\nA new paragraph a rewrite added above the theorem, long enough to push the rest of the doc down by a line or two. ^new-par');
      externalWrite(p, t);
    }""")
    ok = wait_js(page, "() => !!studyEl('.sr-passage[data-a=\"new-par\"]') && V().renderDone()", 5000)
    page.wait_for_timeout(100)
    r = page.evaluate("() => ({ meta: studyEl('.sr-meta').textContent, off: topInView(studyEl('[data-a=\"order-thm\"]')) })")
    check('content change: the doc re-renders with the new passage', ok and 'build 3' in r['meta'], r['meta'])
    check('content change: the passage in view stays where it was', abs(r['off'] - off0) <= 3, f"{r['off']} vs {off0}")
    page.evaluate("() => externalWrite('study/basics/fx-units.md', fs.get('study/basics/fx-units.md'))")


def section_ink(page):
    # Page ink (S4, merged as #80): a Pencil stroke over a passage writes to this device's ink
    # file (the settings tab set device "test-pad"), then survives closing and reopening the view.
    open_doc(page, 'fx-units')
    page.wait_for_timeout(150)
    page.evaluate("() => { window._inkEl = studyEl('[data-a=\"unit-gcd\"]'); strokeOver(_inkEl, 14); }")
    check('ink: a pen stroke on the page does not navigate', page.evaluate("() => V().currentDoc() === 'fx-units'"))
    page.wait_for_timeout(1300)
    saved = page.evaluate("() => fileJson('study/ink/fx-units.test-pad.json')")
    strokes = (saved or {}).get('strokes', [])
    ok = any(s.get('at', {}).get('a') == 'unit-gcd' for s in strokes)
    check('ink: the stroke saved to study/ink/fx-units.test-pad.json at its passage', ok, json.dumps(saved)[:200] if saved else 'no file')
    # Close the leaf and reopen the view: the stroke is loaded back and drawn under its passage.
    page.evaluate("() => app.workspace.getLeavesOfType('notebook-study')[0].detach()")
    page.evaluate("() => commands['open-study'].callback()")
    ok = open_doc(page, 'fx-units')
    page.wait_for_timeout(300)
    px = page.evaluate("""() => {
      const doc = document.querySelector('.nb-study-doc'), el = studyEl('[data-a="unit-gcd"]');
      const dr = doc.getBoundingClientRect(), r = el.getBoundingClientRect(), s = dr.width / 800;
      return inkPx((r.left - dr.left) / s + 40, (r.top - dr.top) / s + 4, (r.left - dr.left) / s + 260, (r.top - dr.top) / s + 28);
    }""")
    check('ink: after reopening the view the stroke is drawn under its passage', ok and px > 50, f'reopen {ok}, pixels {px}')


def section_marks(page):
    # Marks on the real plugin (S5 over S2's engine): a dot per markable passage, "lost" asks the
    # engine's triage, logs the mark to this device's log, the engine folds it, the scaffold opens.
    open_doc(page, 'fx-topic')
    page.wait_for_timeout(200)
    r = page.evaluate("""async () => {
      const dots = [...document.querySelectorAll('.nb-study-margin .nb-st-dot')].map(d => d.dataset.a);
      document.querySelector('.nb-study-margin .nb-st-dot[data-a="cue-gcd"]').click();
      await sleep(30);
      const menu = document.querySelector('.nb-st-menu');
      const verbs = menu ? [...menu.querySelectorAll('button')].map(b => b.textContent) : [];
      if (menu) [...menu.querySelectorAll('button')].find(b => b.textContent === 'lost').click();
      await sleep(400);
      const sc = document.querySelector('.nb-st-scaffold[data-a="cue-gcd"]');
      const log = (fs.get('study/log/test-pad.jsonl') || '').trim().split('\\n').filter(Boolean).map(l => JSON.parse(l));
      return { dots, verbs, sc: !!sc, basics: sc ? sc.textContent : '', log,
               marks: plugin.study.engine().marks('fx-topic'), tri: plugin.study.engine().triage('fx-topic', 'cue-gcd', 'lost') };
    }""")
    check('marks: a dot on every markable passage and list item of the topic', 'cue-gcd' in r['dots'] and 'cue-broken' in r['dots'], r['dots'])
    check('marks: the dot menu offers lost, easy, forgot', r['verbs'][:3] == ['lost', 'easy', 'forgot'], r['verbs'])
    check('marks: lost logs one mark event to study/log/test-pad.jsonl',
          [(e['type'], e['a'], e['verb']) for e in r['log'] if e['type'] == 'mark'] == [('mark', 'cue-gcd', 'lost')], r['log'])
    check('marks: the engine folds the logged mark', [(m['a'], m['verb']) for m in r['marks']] == [('cue-gcd', 'lost')], r['marks'])
    check('marks: the engine triages a first lost as a scaffold resting on fx-div, and the scaffold opens',
          r['tri'].get('action') == 'scaffold' and r['tri'].get('basics') == ['fx-div'] and r['sc'] and 'Divisibility' in r['basics'], (r['tri'], r['basics'][:120]))
    # One tap on a marked dot clears it: the engine drops the open mark and the scaffold goes.
    r = page.evaluate("""async () => {
      document.querySelector('.nb-study-margin .nb-st-dot[data-a="cue-gcd"]').click();
      await sleep(400);
      return { sc: !!document.querySelector('.nb-st-scaffold[data-a="cue-gcd"]'), marks: plugin.study.engine().marks('fx-topic') };
    }""")
    check('marks: a tap on the marked dot clears it: the scaffold goes and the engine drops the mark', not r['sc'] and not r['marks'], r)


def section_panels(page):
    # Today and Map on the real engine: the plan's picks come from engine.todayPlan, a pick opens
    # the standalone problem view (ctx.ui.openProblem), and every ctx.ui hook is filled.
    r = page.evaluate("""async () => {
      const ui = plugin.study.ui;
      const filled = ['openDoc', 'openDrill', 'openProblem', 'openKata', 'openToday', 'openMap'].filter(k => !/not built yet/.test(String(ui[k])));
      await ui.openToday();
      await sleep(200);
      const l = app.workspace.getLeavesOfType('notebook-study-today')[0];
      const el = l ? l.view.contentEl : null;
      const plan = plugin.study.engine().todayPlan(plugin.study.settings().minutes);
      const items = el ? [...el.querySelectorAll('.nb-sp-item')].map(e => e.textContent) : [];
      return { filled, today: !!el, items, picks: plan.picks.map(p => p.id), text: el ? el.textContent : '' };
    }""")
    check('panels: every ctx.ui hook is filled', len(r['filled']) == 6, r['filled'])
    check('panels: Today lists the engine plan\'s picks', r['today'] and len(r['picks']) > 0 and len(r['items']) >= len(r['picks']), (r['picks'], r['items'][:6], r['text'][:300]))
    r = page.evaluate("""async () => {
      const l = app.workspace.getLeavesOfType('notebook-study-today')[0];
      const it = [...l.view.contentEl.querySelectorAll('.nb-sp-item')].find(e => /problem/.test(e.textContent));
      if (!it) return { tapped: false };
      (it.querySelector('button, a, .nb-sp-t') || it).click();
      // The view mounts its card after the old-ink copy (S12), so it comes a little later.
      let pv = null, card = null;
      for (let i = 0; i < 100 && !card; i++) {
        await sleep(30);
        pv = app.workspace.getLeavesOfType('notebook-study-problem')[0];
        card = pv ? pv.view.contentEl.querySelector('.nb-sb-pb') : null;
      }
      return { tapped: true, problem: !!pv, card: !!card, cardId: card ? card.dataset.problem : '', id: pv ? pv.view.getState().id : '',
               title: pv ? pv.view.getDisplayText() : '', body: pv ? pv.view.contentEl.textContent.slice(0, 200) : '' };
    }""")
    check('panels: a Today problem pick opens the standalone problem view',
          r.get('problem') and r.get('card') and r.get('cardId') == r.get('id') != '' and 'not in the study folder' not in r.get('body', ''), r)
    r = page.evaluate("""async () => {
      await plugin.study.ui.openMap();
      await sleep(200);
      const l = app.workspace.getLeavesOfType('notebook-study-map')[0];
      return { map: !!l, text: l ? l.view.contentEl.textContent.slice(0, 200) : '' };
    }""")
    check('panels: the Map opens on the engine\'s basics', r['map'] and 'Divisibility (fixture)' in r['text'], r)


def section_layout(page, w, h, tag):
    page.set_viewport_size({'width': w, 'height': h})
    page.wait_for_timeout(250)
    open_doc(page, 'fx-units')
    page.evaluate("() => { scroller().scrollTop = 0; }")
    page.wait_for_timeout(200)
    r = page.evaluate("""() => {
      const s = scroller(), sizer = document.querySelector('.nb-study-sizer'), doc = document.querySelector('.nb-study-doc');
      const hdr = document.querySelector('.nb-study-hdr');
      const btns = [...hdr.querySelectorAll(':scope > button, .nb-study-tools > button')].map(b => b.getBoundingClientRect());
      return {
        sw: s.clientWidth, sizerW: sizer.getBoundingClientRect().width, docW: doc.getBoundingClientRect().width,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        scrollerOverflow: s.scrollWidth - s.clientWidth,
        hdrOverflow: hdr.scrollWidth - hdr.clientWidth,
        btnsOnScreen: btns.every(b => b.left >= -1 && b.top >= -1),
        transform: doc.style.transform,
      };
    }""")
    scale = min(1.4, r['sw'] / 800)
    check(f'layout {tag}: paper scaled to the view width (max 1.4x)', abs(r['docW'] - 800 * scale) < 2 and abs(r['sizerW'] - int(800 * scale)) <= 1, json.dumps(r))
    check(f'layout {tag}: no horizontal overflow', r['pageOverflow'] <= 0 and r['scrollerOverflow'] <= 0 and r['hdrOverflow'] <= 0, json.dumps(r))
    check(f'layout {tag}: header buttons on screen', r['btnsOnScreen'])
    page.screenshot(path=os.path.join(OUT, f'study_{tag}.png'))
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-div#bezout\"]'), 'touch', 60)")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-div' && !!studyEl('.sr-passage[data-a=\"bezout\"].sr-flash')", 3000)
    check(f'layout {tag}: a finger tap follows', ok)
    page.click('.nb-study-hdr [data-act="library"]')
    page.wait_for_timeout(150)
    r2 = page.evaluate("() => ({ overflow: document.querySelector('.nb-study-lib').scrollWidth - document.querySelector('.nb-study-lib').clientWidth })")
    check(f'layout {tag}: the library fits', r2['overflow'] <= 0, json.dumps(r2))
    page.screenshot(path=os.path.join(OUT, f'study_library_{tag}.png'))
    page.click('.nb-study-lib-close')


# ---------------------------------------------------------------- S5 marks and S8 panels (mock context)

# The fixture: two basics (logic <- sets) and a topic doc that needs sets; a track with a
# deadline, a rating history, a problem, a kata and a Today plan.
MARKS_PANELS_SETUP = """() => {
  const S = window.study;
  const { doc, index, passage } = S;
  const logic = doc('b-logic', 'basic', { title: 'Propositional logic' });
  const sets = doc('b-sets', 'basic', {
    title: 'Sets and maps', needs: ['b-logic'], build: 2, areas: ['discrete'],
    derives: [{ anchor: 'dr-1', doc: 'b-sets', prompt: 'Show A intersect B = B intersect A', solution: null }],
  });
  const topic = doc('topic-dp', 'topic', {
    title: 'Dynamic programming', needs: ['b-sets'], build: 3, areas: ['algorithms'], tracks: ['cs-core'],
    passages: [
      passage('p-lab', 'label', "Written by a model for Adit. Not Adit's words."),
      passage('h-why', 'heading', 'Why', { level: 2, text: 'Why' }),
      passage('p-def', 'paragraph', 'A recurrence with overlapping subproblems.'),
      passage('p-list', 'list', '- one\\n- two', { items: [
        { anchor: 'i-one', line: 0, text: 'Memoise the top-down form' },
        { anchor: 'i-two', line: 1, text: 'Tabulate the bottom-up form' },
      ] }),
      passage('p-rule', 'rule', '---'),
      passage('p-fog', 'callout', '> [!proof] Proof', { block: { type: 'fog', id: 'p-proof1' } }),
      passage('h-changes', 'heading', 'Changes', { level: 2, text: 'Changes' }),
      passage('p-ch1', 'paragraph', 'Build 2 rewrote the memoisation paragraph.'),
    ],
  });
  const problem = {
    id: 'inv-alg-1', doc: 'topic-dp', bank: null, title: 'Longest increasing subsequence', d: 5,
    area: 'algorithms', statement: 'Find the LIS length.', solution: null, methods: ['dp'], unchecked: false,
  };
  const kata = {
    id: 'k-add', title: 'Ripple-carry adder', area: 'digital', needs: ['b-logic'], d: null,
    level: 'hidden', spec: '', ports: [], skeleton: '', vectors: null,
  };
  const tracks = [{ id: 'cs-core', deadline: '2025-07-01', until: null, weight: 1, areas: ['algorithms'], docs: '*' }];
  const content = index([logic, sets, topic], tracks, [problem], [kata]);

  const eng = new S.MockEngine();
  eng.basicsList = [
    { id: 'b-logic', stage: 3, due: '2025-06-12', push: 1, streak: 2, last: 'clean', history: [] },
    { id: 'b-sets', stage: 2, due: '2025-06-08', push: 0, streak: 0, last: 'shaky', history: [] },
  ];
  eng.triageBasics = ['b-sets'];
  eng.plan = {
    date: '2025-06-10',
    drills: [{ basic: 'b-sets', item: 'dr-1', overdue: 2, track: 'cs-core' }],
    picks: [
      { kind: 'problem', id: 'inv-alg-1', d: 5, E: 0.65, hidden: false, reach: false, why: 'In the stretch band' },
      { kind: 'kata', id: 'k-add', d: null, E: null, hidden: true, reach: false, why: 'Hidden-topic slot' },
    ],
    next: { track: 'cs-core', date: '2025-07-01', days: 21 },
    settledToday: 1,
  };
  eng.ratings.set('algorithms', 4.6);
  eng.ratings.set('discrete', 3.1);
  eng.hist.set('algorithms', [
    { t: '2025-06-01', r: 4.4 }, { t: '2025-06-05', r: 4.5 }, { t: '2025-06-10', r: 4.6 },
  ]);
  eng.acc = { p: 0.8, n: 12 };
  eng.blockersList = [{ track: 'cs-core', date: '2025-07-01', basics: ['b-sets'] }];

  const plugin = new obsidian.Plugin();
  const ctx = S.makeCtx({ engine: eng, content, plugin });
  S.registerPanels(ctx);
  window.S = S; window.eng = eng; window.ctx = ctx; window.plugin = plugin;
  window.docs = { logic, sets, topic };
  window.sleep = ms => new Promise(r => setTimeout(r, ms));
  window.lastToast = () => (window.mhost ? mhost.toasts[mhost.toasts.length - 1] : '') || '';
}"""


def part_marks_panels(b):
    """S5 marks and S8 Today/Map, on the mock StudyContext from test/out/study-fixture.js (a mocked
    engine steered through triageOverride), in its own browser context."""
    ctxp = b.new_context(device_scale_factor=1, viewport={'width': 1000, 'height': 700})
    page = ctxp.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(f'http://localhost:{port}/test/harness.html')
    page.add_script_tag(url=f'http://localhost:{port}/test/out/study-fixture.js')
    page.evaluate(MARKS_PANELS_SETUP)
    ev = page.evaluate

    # ================= S8: Today =================
    r = ev("""async () => {
      const names = Object.keys(commands).filter(k => k.startsWith('open-study'));
      const ribbon = plugin.ribbon.map(x => ({ icon: x.icon, title: x.title }));
      commands['open-study-today'].callback();
      await sleep(60);
      const el = view.contentEl;
      const item = (t) => [...el.querySelectorAll('.nb-sp-item')].find(e => e.textContent.includes(t));
      const out = {
        names, ribbon, type: view.getViewType(), display: view.getDisplayText(),
        date: el.querySelector('.nb-sp-date').textContent,
        next: el.querySelector('.nb-sp-next').textContent,
        sections: [...el.querySelectorAll('h3')].map(h => h.textContent),
        drill: item('Sets and maps') ? item('Sets and maps').textContent : null,
        picks: [...el.querySelectorAll('.nb-sp-item')].length,
        hidden: item('?') && item('?').querySelector('.nb-sp-t').textContent,
        shown: item('Longest') ? item('Longest').textContent.slice(0, 40) : null,
        settled: [...el.querySelectorAll('.nb-sp-empty')].map(e => e.textContent).find(t => t.includes('settled')),
        noReq: [...el.querySelectorAll('.nb-sp-empty')].some(e => e.textContent.includes('No pending')),
      };
      out.drillClick = (() => { const d = item('Sets and maps'); d && d.click(); return !!d; })();
      return out;
    }""")
    check('today: commands open-study-today and open-study-map registered',
          r['names'] == ['open-study-today', 'open-study-map'], r['names'])
    check('today: the ribbon icon opens Today', r['ribbon'] == [{'icon': 'calendar-days', 'title': 'Open Today'}], r['ribbon'])
    check('today: opens the Today panel', r['type'] == 'notebook-study-today' and r['display'] == 'Today')
    check('today: the date and the nearest deadline show', 'Jun 10' in r['date'] and 'cs-core' in r['next'] and '21 d left' in r['next'], r['next'])
    check('today: drills, picks, settled and requests sections', len(r['sections']) == 4, r['sections'])
    check('today: the drill card names the basic and its overdue flag',
          r['drill'] and 'Sets and maps' in r['drill'] and '2 d overdue' in r['drill'], r['drill'])
    check('today: the hidden pick shows "?" not its topic',
          r['hidden'] == '?' and 'Ripple' not in str(r['picks']), r['hidden'])
    check('today: the visible pick names the problem with its band flag',
          r['shown'] and 'Longest increasing subsequence' in r['shown'], r['shown'])
    check('today: settled-today count and empty requests row', r['settled'] == '1 settled so far.' and r['noReq'], r['settled'])
    r2 = ev("() => [ctx.uiCalls.filter(c => c.fn === 'openDrill').map(c => c.args), ctx.uiCalls.length]")
    check('today: a drill card opens the drill in one tap', r2[0] == [['b-sets', 'dr-1']], r2)

    # re-render on context change
    r = ev("""async () => {
      eng.plan = { ...eng.plan, settledToday: 3 };
      ctx.fire('events');
      await sleep(30);
      return [...view.contentEl.querySelectorAll('.nb-sp-empty')].map(e => e.textContent).find(t => t.includes('settled'));
    }""")
    check('today: re-renders when the context changes', r == '3 settled so far.', r)

    # pending requests section
    r = ev("""async () => {
      eng.pending.push({ doc: 'topic-dp', a: 'p-def', kind: 'rewrite', t: '2025-06-10T09:00:00', build: 3 });
      ctx.fire('events');
      await sleep(30);
      const el = view.contentEl;
      const row = [...el.querySelectorAll('.nb-sp-item')].find(e => e.textContent.includes('topic-dp') || e.textContent.includes('Dynamic programming'));
      if (row) row.click();
      return { row: row ? row.textContent : null, calls: ctx.uiCalls.filter(c => c.fn === 'openDoc').map(c => c.args) };
    }""")
    check('today: a pending request row opens the doc at its anchor',
          r['row'] and 'rewrite' in r['row'] and r['calls'] == [['topic-dp', 'p-def']], r)

    # ================= S8: Map =================
    r = ev("""async () => {
      commands['open-study-map'].callback();
      await sleep(80);
      const el = view.contentEl;
      const nodes = [...el.querySelectorAll('.nb-map-node')].map(n => ({ id: n.dataset.node, layer: n.dataset.layer, cls: n.className, t: n.textContent }));
      return {
        type: view.getViewType(), display: view.getDisplayText(),
        sections: [...el.querySelectorAll('h3')].map(h => h.firstChild.textContent),
        nodes,
        edges: el.querySelectorAll('svg.nb-map-edges path').length,
        layers: el.querySelectorAll('.nb-map-layer').length,
        rates: [...el.querySelectorAll('.nb-map-rate')].map(c => c.textContent.slice(0, 30)),
        sparks: el.querySelectorAll('svg.nb-map-spark').length,
        ladders: el.querySelectorAll('svg.nb-map-lad').length,
        acc: el.querySelector('.nb-map-accfill').style.width,
        accText: el.querySelector('.nb-map-acc').parentElement.textContent,
        track: [...el.querySelectorAll('.nb-map-track')].map(c => c.textContent),
      };
    }""")
    check('map: opens the Study map panel', r['type'] == 'notebook-study-map' and r['display'] == 'Study map')
    check('map: basics, ratings, methods and tracks sections', r['sections'] == ['Basics', 'Ratings', 'Method identification', 'Tracks'], r['sections'])
    layers = {n['id']: n['layer'] for n in r['nodes']}
    check('map: the graph layers the needs chain (logic, sets, dp)', layers.get('b-logic') == '0' and layers.get('b-sets') == '1' and layers.get('topic-dp') == '2', layers)
    check('map: a node per basic and topic, edges drawn between needs',
          len(r['nodes']) == 3 and r['edges'] == 2 and r['layers'] == 3, (len(r['nodes']), r['edges']))
    sets_node = next((n for n in r['nodes'] if n['id'] == 'b-sets'), {})
    logic_node = next((n for n in r['nodes'] if n['id'] == 'b-logic'), {})
    check('map: node fill is the stage, ring the push level', 's2' in sets_node.get('cls', '') and 's3' in logic_node.get('cls', '') and 'p1' in logic_node.get('cls', ''), sets_node)
    check('map: a rating card per area with ladder and sparkline',
          len(r['rates']) == 2 and any('algorithms' in c and '4.60' in c for c in r['rates']) and r['sparks'] == 1 and r['ladders'] == 2, r['rates'])
    check('map: method identification accuracy', r['acc'] == '80%' and '12 hidden settles' in r['accText'], r['accText'][:80])
    check('map: the track shows the deadline and its blocker',
          r['track'] and 'cs-core' in r['track'][0] and '21 d left' in r['track'][0] and 'Sets and maps (stage 2)' in r['track'][0], r['track'])

    # tap a node -> detail -> drill
    r = ev("""async () => {
      const el = view.contentEl;
      const before = ctx.uiCalls.length;
      [...el.querySelectorAll('.nb-map-node')].find(n => n.dataset.node === 'b-sets').click();
      await sleep(30);
      const d = el.querySelector('.nb-map-detail');
      const text = d.textContent;
      const btns = [...d.querySelectorAll('button')].map(b => b.textContent);
      const drill = [...d.querySelectorAll('button')].find(b => b.textContent === 'Drill');
      if (drill) drill.click();
      return { text, btns, calls: ctx.uiCalls.slice(before) };
    }""")
    check('map: tapping a node opens its detail (stage, due, rests on, feeds)',
          'Sets and maps' in r['text'] and '2 of 5' in r['text'] and 'overdue' in r['text'] and 'Propositional logic' in r['text'] and 'Dynamic programming' in r['text'], r['text'][:120])
    check('map: the detail Drill button opens the first derive',
          r['calls'] == [{'fn': 'openDrill', 'args': ['b-sets', 'dr-1']}], r['calls'])

    # Feeds lists only basics and topics: a hidden kata that needs a basic never shows (review, major 2)
    r = ev("""async () => {
      const c = ctx.content();
      const hk = S.doc('k-add', 'kata', { title: 'Ripple-carry adder', needs: ['b-logic'] });
      hk.kata = c.katas.get('k-add');
      const vk = S.doc('k-open', 'kata', { title: 'Open kata doc', needs: ['b-logic'] });
      vk.kata = { ...c.katas.get('k-add'), id: 'k-open', title: 'Open kata doc', level: 'simple' };
      c.docs.set('k-add', hk); c.docs.set('k-open', vk);
      c.usedBy.set('b-logic', [...(c.usedBy.get('b-logic') || []), 'k-add', 'k-open']);
      ctx.fire('content');
      await sleep(40);
      const el = view.contentEl;
      [...el.querySelectorAll('.nb-map-node')].find(n => n.dataset.node === 'b-logic').click();
      await sleep(30);
      const d = el.querySelector('.nb-map-detail');
      const dts = [...d.querySelectorAll('dt')];
      const feedDd = dts.find(x => x.textContent === 'Feeds').nextElementSibling;
      const out = { feeds: [...feedDd.querySelectorAll('button')].map(b => b.textContent), text: el.textContent };
      c.docs.delete('k-add'); c.docs.delete('k-open');
      c.usedBy.set('b-logic', c.usedBy.get('b-logic').filter(x => x !== 'k-add' && x !== 'k-open'));
      ctx.fire('content');
      await sleep(30);
      return out;
    }""")
    check('map: Feeds lists only basics and topics, never a hidden kata',
          r['feeds'] == ['Sets and maps'] and 'Ripple' not in r['text'] and 'Open kata doc' not in r['text'], r['feeds'])

    # the stage legend swatches carry the node colours (review, minor)
    r = ev("""() => [...view.contentEl.querySelectorAll('.nb-map-sw')].map(e => getComputedStyle(e).backgroundColor)""")
    check('map: the stage legend swatches are coloured like the dots',
          len(r) == 6 and r[0] == 'rgb(158, 158, 158)' and r[5] == 'rgb(0, 105, 92)' and len(set(r)) == 6, r)

    # 390 px pass
    r = ev("""async () => {
      const leaf = document.getElementById('leaf');
      const old = leaf.style.width;
      leaf.style.width = '390px';
      await sleep(60);
      const w = view.contentEl.scrollWidth;
      const sp = view.contentEl.querySelector('.nb-sp');
      const lr = leaf.getBoundingClientRect();
      const wide = [];
      for (const e of sp.querySelectorAll('*')) {
        const q = e.getBoundingClientRect();
        if (q.right - lr.left > 390.5 || q.width > 390.5 || e.scrollWidth > 392)
          wide.push(e.tagName + '.' + e.className + ' w' + Math.round(q.width) + ' sw' + e.scrollWidth);
      }
      const nodesFit = [...view.contentEl.querySelectorAll('.nb-map-node')].every(n => n.offsetWidth <= 390);
      const inner = sp.scrollWidth;
      leaf.style.width = old;
      return { w, nodesFit, inner, wide: wide.slice(0, 10) };
    }""")
    check('map: renders inside 390 px', r['w'] <= 392 and r['inner'] <= 392 and r['nodesFit'], r)

    # ================= S5: marks =================
    r = ev("""async () => {
      eng.pending.length = 0;   // the Today test seeded one; marks starts clean
      eng.triageCalls.length = 0;
      const box = document.createElement('div');
      box.id = 'study-host';
      document.body.appendChild(box);
      window.mhost = S.makeHost(ctx, docs.topic, box);
      window.marks = S.attachMarks(mhost.host);
      await sleep(30);
      const dots = [...mhost.host.margin.querySelectorAll('.nb-st-dot')];
      return { n: dots.length, anchors: dots.map(d => d.dataset.a), margin: mhost.host.margin.className,
        label: dots.find(d => d.dataset.a === 'h-why').textContent };
    }""")
    check('marks: a dot per markable passage and anchored list item',
          r['n'] == 7 and set(r['anchors']) == {'h-why', 'p-def', 'p-list', 'i-one', 'i-two', 'h-changes', 'p-ch1'}, r['anchors'])
    check('marks: the margin column is styled and headings read "mark"', 'nb-st-margin' in r['margin'] and r['label'] == 'mark', r)

    r = ev("""async () => {
      mhost.host.margin.querySelector('.nb-st-dot[data-a="p-def"]').click();
      await sleep(20);
      const menu = mhost.host.margin.querySelector('.nb-st-menu');
      const verbs = menu ? [...menu.querySelectorAll('button')].map(b => b.textContent) : [];
      if (menu) [...menu.querySelectorAll('button')].find(b => b.textContent === 'lost').click();
      await sleep(40);
      const dot = mhost.host.margin.querySelector('.nb-st-dot[data-a="p-def"]');
      const sc = document.querySelector('.nb-st-scaffold[data-a="p-def"]');
      return { verbs, cls: dot.className, sc: !!sc,
        head: sc && sc.querySelector('.nb-st-kick').textContent,
        basics: sc ? [...sc.querySelectorAll('.nb-st-basiclink')].map(b => b.textContent) : [],
        att: sc ? !sc.querySelector('.nb-st-sc-att').hidden : false,
        surf: S.inkSurfaces.has('attempt:p-def'),
        calls: eng.triageCalls.slice(-2), logged: ctx.logged.map(e => e.type + ':' + e.a + ':' + e.verb) };
    }""")
    check('marks: tapping a dot offers lost, easy, forgot', r['verbs'] == ['lost', 'easy', 'forgot'], r['verbs'])
    check('marks: lost triages first, then logs the mark event',
          r['calls'][0] == {'doc': 'topic-dp', 'a': 'p-def', 'verb': 'lost'} and 'mark:p-def:lost' in r['logged'], (r['calls'], r['logged']))
    check('marks: a struggling mark opens the scaffold with basics and an attempt box',
          r['cls'] == 'nb-st-dot on struggling' and r['sc'] and 'struggling' in r['head'] and r['basics'] == ['Sets and maps'] and r['att'] and r['surf'],
          (r['cls'], r['basics']))

    # attempt ink logs an attempt event after the 2 s debounce
    r = ev("""async () => {
      const n0 = ctx.logged.filter(e => e.type === 'attempt').length;
      S.inkSurfaces.get('attempt:p-def').addStrokes(3);
      await sleep(400);
      const mid = ctx.logged.filter(e => e.type === 'attempt').length;
      await sleep(2100);
      const sc = document.querySelector('.nb-st-scaffold[data-a="p-def"]');
      return { n0, mid, att: ctx.logged.filter(e => e.type === 'attempt').map(e => e.strokes),
        count: sc.querySelector('.nb-st-sc-count').textContent,
        status: sc.querySelector('.nb-st-sc-status').textContent };
    }""")
    check('marks: attempt ink logs one attempt event after a 2 s debounce',
          r['n0'] == 0 and r['mid'] == 0 and r['att'] == [3] and r['count'] == '3 strokes', r)

    # still lost -> budget exhausted -> drill instead
    r = ev("""async () => {
      eng.budgetVal = { left: 0, used: 3 };
      ctx.fire('events');
      await sleep(30);
      const sc = document.querySelector('.nb-st-scaffold[data-a="p-def"]');
      const dot = mhost.host.margin.querySelector('.nb-st-dot[data-a="p-def"]');
      const btn = [...sc.querySelectorAll('.nb-st-sc-foot button')].find(b => b.textContent.startsWith('Drill'));
      const n0 = ctx.uiCalls.length;
      if (btn) btn.click();
      return { cls: dot.className, btn: btn && btn.textContent, calls: ctx.uiCalls.slice(n0),
        status: sc.querySelector('.nb-st-sc-status').textContent };
    }""")
    check('marks: exhausted budget offers "Drill <basic> instead" and opens it',
          'exhausted' in r['cls'] and r['btn'] == 'Drill Sets and maps instead' and
          r['calls'] == [{'fn': 'openDrill', 'args': ['b-sets', 'dr-1']}] and 'All 3 rewrites' in r['status'], r)

    # eligible -> two-tap rewrite request -> requested
    r = ev("""async () => {
      eng.budgetVal = { left: 2, used: 1 };
      eng.triageOverride = (d, a, v) =>
        eng.pending.some(r => r.doc === d && r.a === a) ? { action: 'requested', at: new Date().toISOString() }
          : { action: 'eligible', left: 2 };
      ctx.fire('events');
      await sleep(30);
      const sc = document.querySelector('.nb-st-scaffold[data-a="p-def"]');
      const btn = [...sc.querySelectorAll('.nb-st-sc-foot button')].find(b => b.textContent.startsWith('Request rewrite'));
      const n0 = ctx.logged.filter(e => e.type === 'rewrite-request').length;
      btn.click();
      await sleep(20);
      const armed = { text: btn.textContent, armed: btn.classList.contains('armed'),
        n: ctx.logged.filter(e => e.type === 'rewrite-request').length - n0 };
      btn.click();
      await sleep(60);
      const req = eng.pending.find(p => p.doc === 'topic-dp');
      const logged = ctx.logged.filter(e => e.type === 'rewrite-request').pop();
      return { label: btn.textContent, armed, rev: logged && logged.rev,
        hash: ctx.content().anchors.get('topic-dp').get('p-def').hash,
        reqs: ctx.logged.filter(e => e.type === 'rewrite-request').length,
        banner: sc.querySelector('.nb-st-sc-banner').textContent,
        bannerOn: !sc.querySelector('.nb-st-sc-banner').hidden,
        dot: mhost.host.margin.querySelector('.nb-st-dot[data-a="p-def"]').className,
        req };
    }""")
    check('marks: eligible shows "Request rewrite (2 of 3 left)"', r['label'].startswith('Request rewrite'), r['label'])
    check('marks: the rewrite request needs two taps and then logs once',
          r['armed']['n'] == 0 and r['armed']['armed'] and r['reqs'] == 1, (r['armed'], r['reqs']))
    check('marks: the rewrite request carries rev = the passage hash',
          r['rev'] and r['rev'] == r['hash'], (r['rev'], r['hash']))
    check('marks: a pending request reads as "requested"',
          r['bannerOn'] and 'Rewrite requested' in r['banner'] and 'requested' in r['dot'], r['banner'])

    # rebuild-basic on a second anchor: two-tap confirm logs rebuild-request per basic
    r = ev("""async () => {
      eng.triageOverride = { action: 'rebuild-basic', basics: ['b-sets'] };
      ctx.fire('events');
      await sleep(30);
      mhost.host.margin.querySelector('.nb-st-dot[data-a="i-one"]').click();
      await sleep(20);
      [...mhost.host.margin.querySelectorAll('.nb-st-menu button')].find(b => b.textContent === 'lost').click();
      await sleep(40);
      const sc = document.querySelector('.nb-st-scaffold[data-a="i-one"]');
      const head = sc.querySelector('.nb-st-kick').textContent;
      const btn = [...sc.querySelectorAll('.nb-st-sc-foot button')].find(b => b.textContent.startsWith('Request rebuild'));
      btn.click(); await sleep(20);
      const armedN = ctx.logged.filter(e => e.type === 'rebuild-request').length;
      btn.click(); await sleep(60);
      return { head, label: btn.textContent, armedN,
        reqs: ctx.logged.filter(e => e.type === 'rebuild-request'),
        banner: sc.querySelector('.nb-st-sc-banner').textContent,
        toast: lastToast() };
    }""")
    check('marks: a gap in a basic explains the rebuild before the two-tap',
          'gap is in a basic' in r['head'] and r['label'].startswith('Request rebuild'), (r['head'], r['label']))
    check('marks: the confirmed rebuild logs one rebuild-request per basic',
          r['armedN'] == 0 and len(r['reqs']) == 1 and r['reqs'][0]['doc'] == 'b-sets' and r['reqs'][0]['a'] == 'topic-dp#i-one', r['reqs'])
    check('marks: the banner and toast say "Rebuild requested"',
          'Rebuild requested' in r['banner'] and 'Rebuild requested' in r['toast'], (r['banner'], r['toast']))

    # once the engine answers 'requested', the banner finds the cross-doc rebuild by <doc>#<anchor>
    r = ev("""async () => {
      eng.triageOverride = (d, a) => a === 'i-one' ? { action: 'requested', at: new Date().toISOString() } : { action: 'eligible', left: 2 };
      ctx.fire('events');
      await sleep(30);
      const sc = document.querySelector('.nb-st-scaffold[data-a="i-one"]');
      eng.triageOverride = { action: 'rebuild-basic', basics: ['b-sets'] };
      return sc.querySelector('.nb-st-sc-banner').textContent;
    }""")
    check('marks: a requested rebuild on a linked basic reads "Rebuild requested"',
          r.startswith('Rebuild requested'), r)

    # rebuild landing: the request leaves pending when a newer build lands
    r = ev("""async () => {
      eng.triageOverride = null;
      // The laptop answered the rewrite: the request is gone, the doc rebuilt.
      eng.pending = eng.pending.filter(p => !(p.doc === 'topic-dp' && p.kind === 'rewrite'));
      docs.topic.build = 4;
      ctx.fire('content');
      await sleep(40);
      return { toast: lastToast(), rerenders: mhost.rerenders, reanchors: mhost.pageInk.reanchors,
        relayouts: mhost.relayouts };
    }""")
    check('marks: a landed build toasts the ink reanchor counts and rerenders',
          'Rebuilt Dynamic programming (build 4)' in r['toast'] and '2 strokes followed' in r['toast'] and
          r['rerenders'] == 1 and r['reanchors'] == 1, r)

    # tap a marked dot clears it
    r = ev("""async () => {
      const dot = mhost.host.margin.querySelector('.nb-st-dot[data-a="i-one"]');
      dot.click();
      await sleep(40);
      return { cls: dot.className, sc: !!document.querySelector('.nb-st-scaffold[data-a="i-one"]'),
        cleared: ctx.logged.filter(e => e.type === 'mark' && e.a === 'i-one').map(e => e.verb),
        toast: lastToast() };
    }""")
    check('marks: one tap on a marked dot clears the mark',
          'nb-st-dot on' not in r['cls'] and not r['sc'] and r['cleared'] == ['lost', 'clear'] and 'cleared' in r['toast'], r)

    # ================= S5: Changes =================
    r = ev("""async () => {
      const c0 = plugin._cleanups.length;
      await S.openChanges(ctx, 'topic-dp');
      const m = modals[modals.length - 1];
      const added = plugin._cleanups.slice(c0);
      const hadStyle = !!document.getElementById('nb-st-changes-css');
      for (const fn of added) fn();
      const styleCleanup = { added: added.length, hadStyle, gone: !document.getElementById('nb-st-changes-css') };
      const t = m.contentEl.textContent;
      const heads = [...m.contentEl.querySelectorAll('h4')].map(h => h.textContent);
      const marks = [...m.contentEl.querySelectorAll('.nb-st-mark')].map(e => e.textContent);
      const n0 = ctx.uiCalls.length;
      const row = m.contentEl.querySelector('.nb-st-mark');
      if (row) row.click();
      return { styleCleanup, title: m.titleEl.textContent, heads, marks, openCalls: ctx.uiCalls.slice(n0),
        closed: !document.body.contains(m.modalEl), t };
    }""")
    check('changes: the panel shows build, budget, requests, marks and the ## Changes section',
          r['title'] == 'Changes · Dynamic programming' and
          r['heads'] == ['Pending requests', 'Marks', 'Changes section'] and
          '4 · cs-core' in r['t'] and '1 of 3 used' in r['t'] and 'rewrote the memoisation' in r['t'], (r['title'], r['heads']))
    check('changes: the injected style is removed by a cleanup registered on the plugin',
          r['styleCleanup'] == {'added': 1, 'hadStyle': True, 'gone': True}, r['styleCleanup'])
    check('changes: mark rows list the open marks and open their anchor',
          len(r['marks']) == 1 and 'lost' in r['marks'][0] and '#p-def' in r['marks'][0] and
          r['openCalls'] == [{'fn': 'openDoc', 'args': ['topic-dp', 'p-def']}] and r['closed'], (r['marks'], r['openCalls']))

    r = ev("() => { marks.destroy(); const left = document.querySelectorAll('.nb-st-dot').length; document.getElementById('study-host').remove(); return left; }")
    check('marks: destroy removes the dots', r == 0, r)

    # The attempt box takes the Pencil through S4's real ink (review, major 1): the scaffold root
    # is not .no-ink, only its rows are, so a pen stroke in the box is kept and logs an attempt.
    r = ev("""async () => {
      eng.triageOverride = null;
      eng.budgetVal = { left: 3, used: 0 };
      eng.pending.length = 0;
      eng.marksByDoc.clear();
      const ctx2 = S.makeCtx({ engine: eng, content: ctx.content(), plugin, settings: { device: 'ipad' } });
      const box = document.createElement('div');
      box.id = 'study-host2';
      document.body.appendChild(box);
      const h2 = S.makeHost(ctx2, docs.topic, box, { ink: S.createInkApi(ctx2) });
      const m2 = S.attachMarks(h2.host);
      await sleep(20);
      h2.host.margin.querySelector('.nb-st-dot[data-a="p-def"]').click();
      await sleep(20);
      [...h2.host.margin.querySelectorAll('.nb-st-menu button')].find(b => b.textContent === 'lost').click();
      await sleep(60);
      const sc = box.querySelector('.nb-st-scaffold[data-a="p-def"]');
      const surf = sc.querySelector('.nb-study-ink-surface');
      const rows = ['.nb-st-sc-h', '.nb-st-sc-banner', '.nb-st-sc-basics', '.nb-st-sc-foot'].map(q => sc.querySelector(q).classList.contains('no-ink'));
      surf.scrollIntoView();
      await sleep(20);
      const rr = surf.getBoundingClientRect();
      const pen = (pts) => {
        const init = (q, extra = {}) => ({ pointerId: 7, pointerType: 'pen', pressure: 0.5, clientX: q[0], clientY: q[1], bubbles: true, cancelable: true, button: 0, buttons: 1, ...extra });
        surf.dispatchEvent(new PointerEvent('pointerdown', init(pts[0])));
        for (const q of pts.slice(1)) surf.dispatchEvent(new PointerEvent('pointermove', init(q)));
        surf.dispatchEvent(new PointerEvent('pointerup', init(pts[pts.length - 1], { buttons: 0, pressure: 0 })));
      };
      const pts = [];
      for (let i = 0; i < 12; i++) pts.push([rr.left + 30 + i * 12, rr.top + 40 + (i % 2) * 10]);
      pen(pts);
      await sleep(2300);
      const att = ctx2.logged.filter(e => e.type === 'attempt' && e.a === 'p-def').map(e => e.strokes);
      const count = sc.querySelector('.nb-st-sc-count').textContent;
      m2.destroy();
      box.remove();
      return { rootNoInk: sc.classList.contains('no-ink'), rows, att, count };
    }""")
    check('marks: the scaffold root is not .no-ink; its header, banner, basics and foot rows are',
          not r['rootNoInk'] and r['rows'] == [True, True, True, True], r)
    check('marks: a Pencil stroke in the attempt box (real createInkApi) is kept and logs an attempt',
          r['att'] == [1] and r['count'] == '1 stroke', r)

    page.locator('#leaf').screenshot(path=os.path.join(OUT, 'study_map.png'))
    check('marks/panels: no page errors', not errors, errors[:3])
    ctxp.close()


def main():
    files = fixture_files()
    files['study/topics/fx-long.md'] = long_doc()
    files.update(generated_docs())
    srv = serve.start(port, ROOT)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1024, 'height': 768})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'{base_url}/test/harness.html')
            page.evaluate(SETUP_JS, files)
            page.evaluate("async () => { window.pluginData = { study: { root: '/study/', device: 'Test Pad', minutes: 45 } }; window.plugin = await loadPlugin(); }")
            for name, fn in [('settings', section_settings), ('library', section_library), ('render', section_render), ('follow', section_follow),
                             ('back', section_back), ('peek', section_peek), ('pen', section_pen), ('tabs', section_tabs), ('header', section_header),
                             ('open paths', section_open_paths), ('content change', section_content_change), ('ink', section_ink), ('marks', section_marks), ('panels', section_panels)]:
                try:
                    fn(page)
                except Exception as e:
                    check(f'{name}: section ran without an exception', False, repr(e)[:300])
            for (w, h, tag) in [(1024, 768, '1024x768'), (390, 844, '390x844')]:
                try:
                    section_layout(page, w, h, tag)
                except Exception as e:
                    check(f'layout {tag}: section ran without an exception', False, repr(e)[:300])
            check('no page errors', not errors, ' | '.join(errors[:5]))
            try:
                part_marks_panels(browser)
            except Exception as e:
                check('marks/panels: part ran without an exception', False, repr(e)[:300])
            browser.close()
    finally:
        srv.terminate()
    print(f'\n{len(failures)} failure(s)' if failures else '\nall study view checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()

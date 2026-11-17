# The study view (docs/study/SPEC.md, The study view; tickets S3, S4, S5 on docs/study/BOARD.md),
# on the mock harness (test/harness.html + test/mock-obsidian.js), like run_view_test.py. Loads the
# fixtures in test/fixtures/study/ into the mock vault under study/, plus a generated 60-passage
# doc (fx-long) and 120 generated basics, then checks: settings, the library (groups, search, no
# proofs or solutions), every passage rendered with its data-a, block mounts, finger taps that
# follow and flash, Back with scroll restore, a 450 ms hold that peeks (never a proof), Pencil
# events over a link that do not navigate, tabs, the header buttons, the protocol handler, "Open
# as study doc", re-render on a content change, and the layout at 1024x768 and 390x844.
# Sections for page ink (S4) and marks (S5) are marked SKIP until those tickets add them.
# Port 8771 (NB_STUDY_TEST_PORT overrides). Screenshots land in test/out/. Exits non-zero on a failure.
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
FIX = os.path.join(HERE, 'fixtures', 'study')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_STUDY_TEST_PORT', 8771))
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
  window.studyEl = sel => document.querySelector('.nb-study-doc ' + sel);
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
    print(f'  library: {len(rows)} rows in {lib_ms:.0f} ms (open to listed, including the first index load)')
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
    page.evaluate("() => press(studyEl('a[data-study-to=\"fx-units#order-thm\"]'), 'touch', 50)")
    ok = wait_js(page, "() => V().currentDoc() === 'fx-units' && !!studyEl('.sr-passage[data-a=\"order-thm\"].sr-flash')", 4000)
    check('back: followed into fx-units', ok)
    page.click('.nb-study-hdr [data-act="back"]')
    ok = wait_js(page, "() => V().currentDoc() === 'fx-long' && V().renderDone()", 4000)
    now = page.evaluate("() => scroller().scrollTop")
    check('back: returns to the doc at the same scroll position', ok and abs(now - top) <= 2, f'{now} vs {top}')
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
    page.click('.nb-study-tab[data-tab="g-017"] .nb-study-tab-close')
    ok = wait_js(page, "() => V().currentDoc() === 'g-016' && V().openTabs().length === 5", 3000)
    check('tabs: closing the active tab shows its neighbour', ok)


def section_header(page):
    open_doc(page, 'fx-units')
    page.evaluate("""() => {
      window.uiCalls = [];
      plugin.study.ui.openToday = async () => { uiCalls.push('today'); };
      plugin.study.ui.openMap = async () => { uiCalls.push('map'); };
    }""")
    page.click('.nb-study-hdr [data-act="today"]')
    page.click('.nb-study-hdr [data-act="map"]')
    check('header: Today and Map call ctx.ui', page.evaluate("() => uiCalls.join(',')") == 'today,map')
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
      const doc = document.querySelector('.nb-study-doc'), el = doc.querySelector('[data-a="unit-gcd"]');
      const dr = doc.getBoundingClientRect(), r = el.getBoundingClientRect(), s = dr.width / 800;
      return inkPx((r.left - dr.left) / s + 40, (r.top - dr.top) / s + 4, (r.left - dr.left) / s + 260, (r.top - dr.top) / s + 28);
    }""")
    check('ink: after reopening the view the stroke is drawn under its passage', ok and px > 50, f'reopen {ok}, pixels {px}')


def section_marks(page):
    skip('marks', 'S5 adds this section: lost in a topic shows the scaffold, two taps request a rewrite, lost in a basic requests a rebuild, Changes lists it')


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


def main():
    files = fixture_files()
    files['study/topics/fx-long.md'] = long_doc()
    files.update(generated_docs())
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
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
                             ('open paths', section_open_paths), ('content change', section_content_change), ('ink', section_ink), ('marks', section_marks)]:
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
            browser.close()
    finally:
        srv.terminate()
    print(f'\n{len(failures)} failure(s)' if failures else '\nall study view checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()

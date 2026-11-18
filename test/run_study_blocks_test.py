# The study blocks (S6, S7) in a browser: the drill (Done refused before 3 strokes, one drill event
# per grade, the replay with a stall marker), the recall card, the fog gate (a reveal refused before
# 3 strokes, after-reveal ink carries `e`), fog at push 3 (the hook), and the problem block (chips
# locked until ink, a verdict takes two taps, both tick lists, the call and settle fields, Skip ticks
# on a reopened settled card) and the standalone problem view behind ctx.ui.openProblem (a hidden
# pick shows no doc title before the settle). Uses the mock obsidian module's in-memory vault
# (test/harness.html), the S4 ink module and the blocks bundled by test/study-blocks-build.mjs.
# Run: python test/run_study_blocks_test.py (port NB_TEST_PORT_BASE + 10, or NB_STUDY_BLOCKS_PORT).
# Exits 1 on any failure.
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
import serve  # test/serve.py: the static server, refusing a port another run holds

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_STUDY_BLOCKS_PORT', int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 10))

subprocess.run(['node', 'test/study-blocks-build.mjs'], cwd=ROOT, check=True, shell=(os.name == 'nt'))
srv = serve.start(port, ROOT)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(name)

# The S1 fixtures plus the blocks' own (an invented basic with derives and a numbers card).
FILES = []
for base in ('test/fixtures/study', 'test/fixtures/study-blocks'):
    for dirpath, _, names in os.walk(os.path.join(ROOT, base)):
        for n in sorted(names):
            if not n.endswith('.md'):
                continue
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, os.path.join(ROOT, base)).replace('\\', '/')
            with open(full, encoding='utf-8') as f:
                FILES.append({'path': 'study/' + rel, 'text': f.read().replace('\r\n', '\n')})

SETUP = r"""
(files => {
  const SB = window.studyBlocks;
  window.content = SB.buildIndex(files);
  window.events = [];
  window.toasts = [];
  window.opened = [];
  window.PUSH = 0;
  const listeners = new Set();
  let n = 0;
  window.emit = what => { for (const fn of [...listeners]) fn(what); };
  window.ctx = {
    app: window.app,
    plugin: new obsidian.Plugin(),
    ui: { toast: m => toasts.push(m), openDoc: async (d, a) => { opened.push([d, a]); }, openToday: async () => {} },
    settings: () => ({ root: 'study', device: 'desktop', minutes: 60, devTools: false }),
    content: () => window.content,
    events: () => window.events,
    log: async e => {
      const ev = { v: 1, id: 'desktop-' + (++n), t: new Date().toISOString(), dev: 'desktop', ...e };
      events.push(ev);
      emit('events');
      return ev;
    },
    engine: () => ({ pushLevel: () => window.PUSH, basic: id => ({ id, stage: 1, due: null }), rating: () => 3 }),
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  /* The context the block ink is filed under; a copy gets fresh ink stores that re-read the files. */
  window.inkCtx = ctx;
  window.ink = SB.createInkApi(ctx);
  const leaf = document.getElementById('leaf');
  leaf.style.cssText = 'width:900px;height:700px;overflow:auto;position:relative;border:1px solid #ccc';
  /* Mounts a block (`fog`, `drill`, `recall`, `problem`) on a passage of a doc into a fresh box. */
  window.mountBlock = (kind, docId, anchor) => {
    leaf.innerHTML = '';
    const doc = content.docs.get(docId);
    const passage = doc.passages.find(p => p.anchor === anchor || (p.block && p.block.id === anchor)) ||
      { anchor, block: { type: kind, id: anchor } };
    const el = document.createElement('div');
    el.style.cssText = 'width:820px;padding:8px';
    leaf.appendChild(el);
    const env = {
      ctx, doc, passage, ink,
      open: (d, a) => opened.push([d, a]),
      peek: () => {},
      relayout: () => {},
      toast: m => toasts.push(m),
      render: async (md, into) => { const d = document.createElement('div'); d.className = 'md'; d.textContent = md; into.appendChild(d); },
    };
    window.box = el;
    window.env = env;
    window.handle = kind === 'hook' ? SB.mountHook(el, env, anchor) : SB[kind](el, env);
    return el;
  };
  /* A pen stroke across an element, `dy` px under its top (pointer events, as the Pencil sends). */
  window.penStroke = (target, dy = 30) => {
    const r = target.getBoundingClientRect();
    const init = (x, y, extra = {}) => ({ pointerId: 7, pointerType: 'pen', pressure: 0.5, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1, ...extra });
    const y0 = r.top + dy;
    target.dispatchEvent(new PointerEvent('pointerdown', init(r.left + 40, y0)));
    for (let i = 1; i <= 12; i++) target.dispatchEvent(new PointerEvent('pointermove', init(r.left + 40 + i * 14, y0 + 5 * Math.sin(i / 2))));
    target.dispatchEvent(new PointerEvent('pointerup', init(r.left + 40 + 12 * 14, y0, { buttons: 0, pressure: 0 })));
  };
  window.surf = (key, scope = box) => scope.querySelector(`[data-ink-key="${CSS.escape(key)}"]`);
  window.btn = (act, scope = box) => scope.querySelector(`button[data-sb="${act}"]`);
  window.click = (b) => { b.click(); };
  window.evs = type => events.filter(e => e.type === type);
})
"""

def ev(page, js):
    return page.evaluate(js)

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        context = b.new_context(viewport={'width': 1000, 'height': 800})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.add_script_tag(url=f'http://localhost:{port}/test/out/study-blocks.js')
        page.evaluate(SETUP, FILES)

        # --- 1. drill: Start, Done refused before 3 strokes, the model's steps only after Done, one event per grade
        ev(page, "() => mountBlock('drill', 'fx-drill', 'd-odd-square')")
        check('the drill hides the model steps before Done', ev(page, "() => !box.textContent.includes('4k^2')"))
        ev(page, "() => click(btn('start'))")
        ev(page, "() => { penStroke(surf('drill:d-odd-square'), 30); penStroke(surf('drill:d-odd-square'), 80); }")
        r = ev(page, "() => { const d = btn('done'); const was = d.disabled; d.disabled = false; d.click(); return [was, box.querySelector('.nb-sb-drill').dataset.phase, box.querySelector('.nb-sb-gate').textContent]; }")
        check('Done is refused before 3 strokes', r[0] is True and r[1] == 'live', r)
        check('the gate says how many strokes so far', '2 so far' in r[2], r)
        ev(page, "() => penStroke(surf('drill:d-odd-square'), 130)")
        r = ev(page, "() => { const d = btn('done'); const was = d.disabled; d.click(); return [was, box.querySelector('.nb-sb-drill').dataset.phase]; }")
        check('Done opens after 3 strokes', r == [False, 'done'], r)
        check('after Done the model steps show', ev(page, "() => box.textContent.includes('4k^2')"))
        check('no drill event before the grade', ev(page, "() => evs('drill').length") == 0)
        ev(page, "() => { box.querySelector('button[data-grade=\"shaky\"]').click(); }")
        page.wait_for_timeout(50)
        ev(page, "() => { const c = box.querySelector('button[data-grade=\"clean\"]'); c.disabled = false; c.click(); }")
        page.wait_for_timeout(50)
        d = ev(page, "() => evs('drill')")
        check('a drill grade logs exactly one drill event', len(d) == 1 and d[0]['grade'] == 'shaky' and d[0]['item'] == 'd-odd-square' and d[0]['src'] == 'drill' and d[0]['doc'] == 'fx-drill' and d[0]['ms'] >= 0, d)
        check('the replay controls and timeline show', ev(page, "() => !!box.querySelector('.nb-sb-tl.no-ink') && !!box.querySelector('canvas.nb-sb-replay') && box.querySelectorAll('[data-speed]').length === 3"))

        # --- 2. replay with a stall marker: strokes already in the file with a 75 s gap between them
        ev(page, "() => studyBlocks.flushInk(inkCtx)")
        ev(page, """() => {
          const now = Date.now(), pts = [[10, 40, 0.5, 0], [60, 42, 0.5, 300]];
          fs.set('study/ink/fx-drill.desktop.json', JSON.stringify({ v: 1, doc: 'fx-drill', strokes: [
            { id: 's-a', p: pts, t0: now - 100000, e: 0, blk: 'drill:d-even-cube' },
            { id: 's-b', p: pts, t0: now - 95000, e: 0, blk: 'drill:d-even-cube' },
            { id: 's-c', p: pts, t0: now - 20000, e: 0, blk: 'drill:d-even-cube' }] }));
          dirs.add('study'); dirs.add('study/ink');
        }""")
        ev(page, "() => { window.inkCtx = Object.assign({}, ctx); window.ink = studyBlocks.createInkApi(inkCtx); mountBlock('drill', 'fx-drill', 'd-even-cube'); }")
        page.wait_for_timeout(200)
        r = ev(page, "() => [box.querySelector('.nb-sb-drill').dataset.phase, surf('drill:d-even-cube') ? 1 : 0]")
        check('strokes already in the file resume the attempt', r[0] == 'live', r)
        ev(page, "() => btn('done').click()")
        r = ev(page, "() => [...box.querySelectorAll('.nb-sb-stall')].map(s => +s.dataset.ms)")
        check('the replay marks the stall over 30 s', len(r) == 1 and 70000 < r[0] < 80000, r)
        ev(page, "() => { btn('play').click(); }")
        page.wait_for_timeout(300)
        t = ev(page, "() => +box.querySelector('.nb-sb-drill').dataset.replayT")
        check('Play runs the replay from the start', 0 < t < 100000, t)

        # --- 3. recall: Show after 3 strokes, then the answer and a grade logged with src recall
        ev(page, "() => mountBlock('recall', 'fx-card', 'n1')")
        check('the recall answer is hidden before Show', ev(page, "() => !box.textContent.includes('42 litres')"))
        ev(page, "() => { for (const y of [30, 80]) penStroke(surf('recall:n1'), y); }")
        check('Show is locked before 3 strokes', ev(page, "() => btn('done').disabled") is True)
        ev(page, "() => { penStroke(surf('recall:n1'), 130); btn('done').click(); }")
        check('Show reveals the answer after 3 strokes', ev(page, "() => box.textContent.includes('42 litres')"))
        ev(page, "() => box.querySelector('button[data-grade=\"clean\"]').click()")
        page.wait_for_timeout(50)
        d = ev(page, "() => evs('drill').filter(e => e.src === 'recall')")
        check('a recall grade logs a drill event with src recall', len(d) == 1 and d[0]['item'] == 'n1' and d[0]['grade'] == 'clean', d)

        # --- 4. fog at push 0: a reveal refused before 3 strokes, allowed after; after-reveal ink carries e
        ev(page, "() => { window.PUSH = 0; mountBlock('fog', 'fx-units', 'p-unit-gcd'); }")
        check('fogged steps keep their text out of the DOM', ev(page, "() => !box.textContent.includes('Bézout gives')"))
        ev(page, "() => { penStroke(surf('fog:p-unit-gcd'), 30); penStroke(surf('fog:p-unit-gcd'), 80); }")
        r = ev(page, "() => { const b = btn('reveal'); const was = b.disabled; b.disabled = false; b.click(); return [was, box.textContent.includes('a common divisor')]; }")
        check('a fog reveal is refused before 3 strokes', r == [True, False], r)
        ev(page, "() => penStroke(surf('fog:p-unit-gcd'), 130)")
        r = ev(page, "() => { const b = btn('reveal'); const was = b.disabled; b.click(); return [was, box.textContent.includes('a common divisor')]; }")
        check('a fog reveal is allowed after 3 strokes', r == [False, True], r)
        ev(page, "() => penStroke(surf('fog:p-unit-gcd'), 180)")
        es = ev(page, "async () => { await studyBlocks.flushInk(inkCtx); return JSON.parse(fs.get('study/ink/fx-units.desktop.json')).strokes.filter(s => s.blk === 'fog:p-unit-gcd').map(s => s.e || 0); }")
        check('ink written after a reveal carries e', es == [0, 0, 0, 1], es)
        ev(page, "() => btn('done').click()")
        page.wait_for_timeout(50)
        f = ev(page, "() => evs('fog')")
        check('Done logs one fog event', len(f) == 1 and f[0]['proof'] == 'p-unit-gcd' and f[0]['reveals'] == 1 and f[0]['steps'] == 2, f)

        # --- 5. fog at push 3: the theorem posed as a problem first
        ev(page, "() => { window.PUSH = 3; mountBlock('fog', 'fx-units', 'p-order-thm'); }")
        check('push 3 mounts the hook card for the theorem', ev(page, "() => !!box.querySelector('.nb-sb-pb[data-problem=\"fx-units/order-thm\"]') && !box.textContent.includes('minimality')"))

        # --- 6. the problem block: chips locked until ink, two-tap verdict, ticks, the events
        ev(page, "() => { window.PUSH = 0; mountBlock('problem', 'fx-units', 'inv-fx-last-digit'); }")
        r = ev(page, "() => [...box.querySelectorAll('button[data-sb=\"conf\"]')].map(b => b.disabled)")
        check('the six confidence chips are locked before ink', r == [True] * 6, r)
        ev(page, "() => { const b = box.querySelector('button[data-conf=\"70\"]'); b.disabled = false; b.click(); }")
        check('a chip tap before ink commits nothing', ev(page, "() => evs('call').length === 0 && box.querySelector('.nb-sb-pb').dataset.phase === 'call'"))
        ev(page, "() => penStroke(surf('call:inv-fx-last-digit'), 40)")
        r = ev(page, "() => [...box.querySelectorAll('button[data-sb=\"conf\"]')].map(b => b.disabled)")
        check('the chips unlock after ink', r == [False] * 6, r)
        check('the solution is not in the DOM before the settle', ev(page, "() => !box.textContent.includes('2401')"))
        ev(page, "() => box.querySelector('button[data-conf=\"70\"]').click()")
        page.wait_for_timeout(50)
        c = ev(page, "() => evs('call')")
        check('the chip logs the call with every field', len(c) == 1 and {k: c[0][k] for k in ('type', 'item', 'conf', 'hidden', 'reach', 'd')} == {'type': 'call', 'item': 'inv-fx-last-digit', 'conf': 70, 'hidden': False, 'reach': False, 'd': 2.4}, c)
        check('a timer runs after the call', ev(page, "() => /\\d:\\d\\d/.test(box.querySelector('.nb-sb-timer').textContent)"))
        ev(page, "() => box.querySelector('button[data-verb=\"held\"]').click()")
        check('one tap on a verdict only arms it', ev(page, "() => box.querySelector('.nb-sb-pb').dataset.phase") == 'attempt')
        ev(page, "() => box.querySelector('button[data-verb=\"held\"]').click()")
        check('the second tap settles', ev(page, "() => box.querySelector('.nb-sb-pb').dataset.phase") == 'settled')
        check('no settle event before the ticks are saved', ev(page, "() => evs('settle').length") == 0)
        ticks = ev(page, "() => [...box.querySelectorAll('.nb-sb-ticks[data-list=\"called\"] button[data-sb=\"tick\"]')].map(b => b.dataset.m)")
        check('the called list has methods.md and the solution methods', all(m in ticks for m in ('order', 'bezout', 'fx-div/cong-arith')), ticks)
        check('the solution waits for the called ticks', ev(page, "() => !box.textContent.includes('2401')"))
        ev(page, "() => { box.querySelector('.nb-sb-ticks[data-list=\"called\"] button[data-m=\"order\"]').click(); btn('calldone').click(); }")
        used = ev(page, "() => [...box.querySelectorAll('.nb-sb-ticks[data-list=\"used\"] button[aria-pressed=\"true\"]')].map(b => b.dataset.m)")
        check('the used list starts from the solution methods', sorted(used) == ['fx-div/cong-arith', 'order'], used)
        check('the solution opens after the called ticks', ev(page, "() => box.textContent.includes('2401')"))
        ev(page, "() => btn('useddone').click()")
        page.wait_for_timeout(80)
        s = ev(page, "() => evs('settle')")
        want = {'type': 'settle', 'item': 'inv-fx-last-digit', 'verdict': 'held', 'help': 0, 'gaveUp': False, 'called': ['order'], 'used': ['order', 'fx-div/cong-arith'], 'hidden': False, 'hook': False}
        check('saving the ticks logs one settle with every field', len(s) == 1 and {k: s[0][k] for k in want} == want and isinstance(s[0]['ms'], int) and s[0]['ms'] >= 0, s)
        check('the card is done after the settle', ev(page, "() => box.querySelector('.nb-sb-pb').dataset.phase") == 'done')

        # --- 7. "held after help" logs held with help 1; a settled card reopened without ticks offers Skip ticks
        ev(page, "() => mountBlock('problem', 'fx-units', 'inv-fx-unit-sum')")
        ev(page, "() => { penStroke(surf('call:inv-fx-unit-sum'), 40); box.querySelector('button[data-conf=\"none\"]').click(); }")
        ev(page, "() => { const h = box.querySelector('button[data-verb=\"help\"]'); h.click(); h.click(); }")
        check('the verdict "held after help" settles in two taps', ev(page, "() => box.querySelector('.nb-sb-pb').dataset.phase") == 'settled')
        check('Skip ticks is not offered on the first open', ev(page, "() => box.querySelector('.nb-sb-skip').hidden") is True)
        ev(page, "() => { handle.destroy(); mountBlock('problem', 'fx-units', 'inv-fx-unit-sum'); }")
        r = ev(page, "() => [box.querySelector('.nb-sb-pb').dataset.phase, box.querySelector('.nb-sb-stepA').hidden, box.querySelector('.nb-sb-skip').hidden]")
        check('reopened, the settled card shows its tick step again, with Skip ticks', r == ['settled', False, False], r)
        ev(page, "() => btn('skip').click()")
        page.wait_for_timeout(80)
        s = ev(page, "() => evs('settle').filter(e => e.item === 'inv-fx-unit-sum')")
        check('Skip ticks logs the settle with empty lists; held after help is held with help 1', len(s) == 1 and s[0]['verdict'] == 'held' and s[0]['help'] == 1 and s[0]['called'] == [] and s[0]['used'] == [] and s[0]['gaveUp'] is False, s)
        c = ev(page, "() => evs('call').filter(e => e.item === 'inv-fx-unit-sum')")
        check('the "-" chip logs conf null', len(c) == 1 and c[0]['conf'] is None, c)

        # --- 8. the standalone problem view: a hidden pick shows no doc title before the settle
        r = ev(page, """async () => {
          studyBlocks.register(ctx);
          await ctx.ui.openProblem('inv-fx-consecutive', { hidden: true, why: 'A stretch pick.' });
          const v = app.workspace.getLeavesOfType('notebook-study-problem')[0].view;
          window.pv = v;
          window.box = v.contentEl;
          return [v.getDisplayText(), v.contentEl.textContent];
        }""")
        title, text = r
        check('the problem view opens with ctx.ui.openProblem', 'n^2 + n' in text, text[:200])
        check('a hidden pick shows neither the doc title nor the problem title', 'Parity drills' not in text and 'Consecutive product' not in text and 'Consecutive product' not in title, [title, text[:300]])
        check('a hidden pick shows "?" for the topic', title == 'Problem ?' and ev(page, "() => box.querySelector('.nb-sb-q').textContent") == '?', title)
        ev(page, "() => { penStroke(surf('call:inv-fx-consecutive'), 40); box.querySelector('button[data-conf=\"60\"]').click(); }")
        ev(page, "() => { const m = box.querySelector('button[data-verb=\"missed\"]'); m.click(); m.click(); }")
        check('settled but not ticked, the doc title stays hidden', ev(page, "() => !box.textContent.includes('Parity drills')"))
        ev(page, "() => { box.querySelector('.nb-sb-ticks[data-list=\"called\"] button[data-sb=\"none\"]').click(); btn('calldone').click(); }")
        check('after the called ticks the topic is revealed', ev(page, "() => box.textContent.includes('Parity drills')"))
        ev(page, "() => btn('useddone').click()")
        page.wait_for_timeout(80)
        s = ev(page, "() => evs('settle').filter(e => e.item === 'inv-fx-consecutive')")
        c = ev(page, "() => evs('call').filter(e => e.item === 'inv-fx-consecutive')")
        check('the hidden pick logs hidden in the call and the settle', len(c) == 1 and c[0]['hidden'] is True and len(s) == 1 and s[0]['hidden'] is True and s[0]['called'] == [] and s[0]['used'] == ['parity'], [c, s])
        f = ev(page, "async () => { await studyBlocks.flushInk(ctx); const j = fs.get('study/ink/problems.desktop.json'); return j ? JSON.parse(j).strokes.map(s => s.blk) : null; }")
        check('the standalone view files its ink under the problems doc', f == ['call:inv-fx-consecutive'], f)
        r = ev(page, "async () => { await ctx.ui.openProblem('putnam-2019-a1'); const v = app.workspace.getLeavesOfType('notebook-study-problem').find(l => l.view.getState().id === 'putnam-2019-a1').view; return [v.getDisplayText(), v.contentEl.textContent, !!v.contentEl.querySelector('a.nb-sb-ext')]; }")
        check('a bank problem opens by reference with its statement link', 'Putnam 2019 A1' in r[1] and r[2] and r[0] == 'Problem · Putnam 2019 A1', r[:1])

        page.screenshot(path=os.path.join(OUT, 'study-blocks.png'))
        check('no page errors', not errors, errors[:3])
        b.close()
finally:
    srv.terminate()

print(f'{len(failures)} failure(s)' if failures else 'all study blocks checks passed')
sys.exit(1 if failures else 0)

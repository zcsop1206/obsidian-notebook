# The kata block (src/study/blocks/kata.ts, ticket S9) in headless Chromium, on an invented
# fixture kata (an 8-bit accumulator written for this test, not one of the portfolio's katas).
# The block is mounted with a fake BlockEnv: a context whose event log is an in-memory list (and
# can be told to reject writes), and a stand-in for S4's ink surface where a pen pointerdown adds
# a stroke and fires onChange, the way the real surface reports Pencil strokes.
#
# Checks: a Pencil-only call (no typed line) unlocks the confidence chips and Commit, and undo
# locks them again; a wrong design shows the first mismatch and logs nothing; a correct one
# passes; a settled kata that was never ticked shows its tick step again on the next mount; the
# ticks log exactly one `kata` event; a failed write toasts and is retried on the next mount;
# Skip ticks logs empty lists; a `kata` event synced from another device settles an open block;
# a basics link opens on a tap and peeks on a 450 ms hold.
#
# Port: NB_STUDY_KATA_PORT, else NB_TEST_PORT_BASE + 11 (default 8776). The bundle lands in test/out/study-kata.js.
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
import serve  # test/serve.py: the static server, refusing a port another run holds

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_STUDY_KATA_PORT', int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 11))
base_url = f'http://localhost:{port}'

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    if not ok:
        failures.append(name)

# Bundle the block and the index builder for the browser (esbuild from the repo's devDependencies).
ENTRY = """
import { mount } from '../src/study/blocks/kata';
import { buildIndex } from '../src/study/format/index-build';
const N = Node.prototype as any;
if (!N.appendText) N.appendText = function (t: string) { this.appendChild(document.createTextNode(t)); };
(window as any).kataTest = { mount, buildIndex };
"""
BUILD = """
import esbuild from 'esbuild';
await esbuild.build({
  absWorkingDir: process.cwd(), bundle: true, platform: 'browser', format: 'iife', target: 'es2020', logLevel: 'warning',
  stdin: { contents: process.env.KATA_ENTRY, resolveDir: 'test', loader: 'ts', sourcefile: 'study-kata-entry.ts' },
  outfile: 'test/out/study-kata.js',
});
"""
r = subprocess.run(['node', '--input-type=module', '-e', BUILD], cwd=ROOT, env={**os.environ, 'KATA_ENTRY': ENTRY},
                   capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout, r.stderr)
    sys.exit('bundle failed')

KATA = """---
study: kata
id: k-fx-acc
title: Accumulator (fixture)
area: dd
needs: [fx-div]
build: 1
d: 1.0
level: simple
---

> Written by a model for Adit. Not Adit's words.

> [!kata] Accumulator
> `acc` adds `d` on every cycle with `en` high; `rst` clears it.
^spec

```ports
input clk
input rst
input en
input [7:0] d
output reg [7:0] acc
```

```skeleton
module k_fx_acc(input clk, input rst, input en, input [7:0] d, output reg [7:0] acc);
endmodule
```

```vectors
rst en d | acc
1 0 00 | 00
0 1 05 | 05
0 0 07 | 05
0 1 10 | 15
0 1 F0 | 05
```
"""

GOOD = """module k_fx_acc(input clk, input rst, input en, input [7:0] d, output reg [7:0] acc);
always @(posedge clk) begin
  if (rst) acc <= 8'd0;
  else if (en) acc <= acc + d;
end
endmodule"""

# Ignores en: adds 07 on the third row, so the first mismatch is cycle 3 (expected 05, got 0C).
WRONG = """module k_fx_acc(input clk, input rst, input en, input [7:0] d, output reg [7:0] acc);
always @(posedge clk) begin
  if (rst) acc <= 8'd0;
  else acc <= acc + d;
end
endmodule"""

files = [{'path': 'study/katas/k-fx-acc.md', 'text': KATA}]
for rel in ['methods.md', 'basics/fx-div.md', 'basics/fx-units.md']:
    with open(os.path.join(HERE, 'fixtures', 'study', *rel.split('/')), encoding='utf8') as f:
        files.append({'path': 'study/' + rel, 'text': f.read()})

# The fake env, the in-memory event log and the pen surface.
SETUP = """(files) => {
  const content = kataTest.buildIndex(files);
  const doc = content.docs.get('k-fx-acc');
  const T = window.T = { events: [], listeners: [], toasts: [], peeks: [], opens: [], failLog: false, logCalls: 0, handle: null };
  T.fire = what => T.listeners.slice().forEach(f => f(what));
  const ctx = {
    app: {}, plugin: {}, ui: {},
    settings: () => ({ root: 'study', device: 'test', minutes: 60, devTools: false }),
    content: () => content,
    events: () => T.events.slice(),
    log: async e => {
      T.logCalls++;
      await new Promise(r => setTimeout(r, 20));
      if (T.failLog) throw new Error('disk full (test)');
      const ev = { v: 1, id: 'test-' + T.logCalls, t: new Date().toISOString(), dev: 'test', ...e };
      T.events.push(ev);
      T.fire('events');
      return ev;
    },
    engine: () => ({}),
    onChange: fn => { T.listeners.push(fn); return () => { T.listeners = T.listeners.filter(x => x !== fn); }; },
  };
  const ink = {
    page: () => ({ relayout() {}, reanchor: () => ({ moved: 0, changed: 0, orphaned: 0 }), undo: () => null, destroy() {} }),
    surface: (_d, container, key, opts) => {
      const el = container.createDiv({ cls: 'fake-ink' });
      el.style.height = (typeof opts.height === 'function' ? opts.height() : opts.height || 320) + 'px';
      const strokes = (T.ink = T.ink || {})[key] = T.ink[key] || [];
      let fns = [];
      const ro = () => typeof opts.readOnly === 'function' ? opts.readOnly() : !!opts.readOnly;
      const fire = () => fns.slice().forEach(f => f(strokes.slice()));
      el.addEventListener('pointerdown', ev => {
        if (ev.pointerType !== 'pen' || ro()) return;
        strokes.push({ id: 's' + strokes.length, p: [[ev.offsetX, ev.offsetY, 0.5, 0]], t0: Date.now(), blk: key });
        fire();
      });
      return {
        el, strokes: () => strokes.slice(), count: () => strokes.length,
        onChange: fn => { fns.push(fn); return () => { fns = fns.filter(x => x !== fn); }; },
        setReadOnly() {}, layout() {},
        undo: () => { const s = strokes.pop() || null; if (s) fire(); return s; },
        clear: () => { strokes.length = 0; fire(); },
        destroy: () => { fns = []; el.remove(); },
      };
    },
  };
  T.env = {
    ctx, doc, passage: doc.passages.find(p => p.block && p.block.type === 'kata') || doc.passages[0], ink,
    open: (id, a) => T.opens.push(id), peek: (id, a, near) => T.peeks.push(id),
    relayout() {}, toast: m => T.toasts.push(m),
    render: async (md, into) => { into.textContent = md; },
  };
  T.box = document.getElementById('leaf');
  T.box.style.height = 'auto';
  T.mount = () => { if (T.handle) T.handle.destroy(); T.box.innerHTML = ''; T.handle = kataTest.mount(T.box, T.env); };
  T.reset = () => { if (T.handle) T.handle.destroy(); T.handle = null; window.localStorage.clear(); T.events = []; T.ink = {}; T.toasts = []; T.peeks = []; T.opens = []; T.failLog = false; T.logCalls = 0; };
  T.pen = () => {
    const el = T.box.querySelector('.nb-study-kata-call .fake-ink');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'pen', bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }));
  };
  T.state = () => JSON.parse(window.localStorage.getItem('nb-study-kata:k-fx-acc:k-fx-acc') || 'null');
  T.q = s => T.box.querySelector(s);
  T.code = src => { const ta = T.q('.nb-study-kata-src'); ta.value = src; ta.dispatchEvent(new Event('input')); };
  T.chips = () => [...T.box.querySelectorAll('[data-conf]')].map(b => b.disabled);
  T.kataEvents = () => T.events.filter(e => e.type === 'kata');
  return !!doc && !!doc.kata && doc.kata.vectors.rows.length;
}"""

def call_through(page):
    """Pencil-only call: one pen stroke, 70%, commit."""
    page.evaluate('() => { T.pen(); }')
    page.click('[data-conf="70"]')
    page.click('[data-k="commit"]')

srv = serve.start(port, ROOT)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={'width': 1000, 'height': 1400})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'{base_url}/test/harness.html')
        page.add_script_tag(url=f'{base_url}/test/out/study-kata.js')
        rows = page.evaluate(SETUP, files)
        check('fixture: the invented kata parses with five vector rows', rows == 5, rows)

        # ---- 1. a Pencil-only call unlocks the chips and Commit
        page.evaluate('() => { T.reset(); T.mount(); }')
        check('call: chips locked before any ink', all(page.evaluate('() => T.chips()')))
        check('call: commit locked before any ink', page.evaluate('() => T.q(\'[data-k="commit"]\').disabled'))
        page.evaluate('() => T.pen()')
        check('call: one pen stroke unlocks every chip', not any(page.evaluate('() => T.chips()')))
        check('call: the typed line is still empty', page.evaluate("() => T.q('.nb-study-kata-line').value") == '')
        page.click('[data-k="undo"]')
        check('call: undo of the only stroke locks the chips again', all(page.evaluate('() => T.chips()')))
        page.evaluate('() => T.pen()')
        page.click('[data-conf="70"]')
        check('call: a chip with ink unlocks Commit', not page.evaluate('() => T.q(\'[data-k="commit"]\').disabled'))
        page.click('[data-k="commit"]')
        check('call: commit opens the editor', page.evaluate("() => !!T.q('.nb-study-kata-src')"))
        st = page.evaluate('() => T.state()')
        check('call: the committed state has no line and 70%', st and st['committed'] and st['call'] == '' and st['conf'] == 70, st)

        # ---- 2. a wrong design shows the first mismatch and logs nothing
        page.evaluate('(src) => T.code(src)', WRONG)
        page.click('[data-k="run"]')
        res = page.evaluate("() => T.q('.nb-study-kata-result').textContent")
        check('run: a wrong design fails', 'FAIL' in res, res)
        check('run: the first mismatch is cycle 3', 'First mismatch at cycle 3' in res, res)
        cells = page.evaluate("() => [...T.box.querySelectorAll('.nb-study-kata-result td')].map(t => t.textContent)")
        check('run: the mismatch row names acc, expected 05, got 0C', len(cells) == 4 and cells[0] == '3' and cells[1] == 'acc'
              and '05' in cells[2].upper() and '0C' in cells[3].upper(), cells)
        check('run: the waveform is drawn', page.evaluate("() => !!T.q('.nb-study-kata-result svg')"))
        check('run: a failed run logs nothing', page.evaluate('() => T.logCalls') == 0)

        # ---- 3. a correct design passes; the tick step survives a remount; the ticks log once
        page.evaluate('(src) => T.code(src)', GOOD)
        page.click('[data-k="run"]')
        res = page.evaluate("() => T.q('.nb-study-kata-result').textContent")
        check('run: a correct design passes', 'PASS' in res and '5 cycles' in res, res)
        check('settle: shows the verdict', 'Passed on run 2' in page.evaluate("() => T.q('.nb-study-kata-settle').textContent"))
        check('settle: nothing is logged before the ticks', page.evaluate('() => T.logCalls') == 0)
        page.evaluate('() => T.mount()')
        check('settle: a remount shows the tick step again', page.evaluate("""() => !!T.q('[data-k="calldone"]') && !!T.q('[data-k="skipticks"]')"""))
        page.click('[data-k="calldone"]')
        check('ticks: "what it took" is pre-ticked from the needs', page.evaluate(
            """() => T.q('[data-list="used"] [data-m="bezout"]').getAttribute('aria-pressed')""") == 'true')
        page.click('[data-k="useddone"]')
        page.wait_for_function('() => T.state() && T.state().logged')
        evs = page.evaluate('() => T.kataEvents()')
        check('ticks: exactly one kata event', len(evs) == 1, evs)
        if evs:
            e = evs[0]
            check('ticks: the event says pass on 2 runs', e['pass'] is True and e['runs'] == 2 and e['gaveUp'] is False, e)
            check('ticks: the event carries the used list', 'bezout' in e['used'], e)
        page.evaluate('() => T.mount()')
        page.wait_for_timeout(80)
        check('ticks: a remount logs nothing more', len(page.evaluate('() => T.kataEvents()')) == 1)
        check('ticks: the settled view shows the method result', 'Method:' in page.evaluate("() => T.q('.nb-study-kata-settle').textContent"))

        # ---- 4. hold to peek, tap to open
        link = '.nb-study-kata-settle a'
        check('basics: the link to fx-div is there', page.evaluate(f"() => !!T.q('{link}')"))
        page.click(link)
        check('basics: a tap opens the basic', page.evaluate('() => T.opens') == ['fx-div'], page.evaluate('() => T.opens'))
        box = page.query_selector(link).bounding_box()
        page.mouse.move(box['x'] + 4, box['y'] + 4)
        page.mouse.down()
        page.wait_for_timeout(550)
        page.mouse.up()
        check('basics: a 450 ms hold peeks', page.evaluate('() => T.peeks') == ['fx-div'], page.evaluate('() => T.peeks'))
        check('basics: the hold does not also open', page.evaluate('() => T.opens.length') == 1)

        # ---- 5. a failed write toasts and is retried on the next mount; Skip ticks logs empty lists
        page.evaluate('() => { T.reset(); T.failLog = true; T.mount(); }')
        call_through(page)
        page.evaluate('(src) => T.code(src)', GOOD)
        page.click('[data-k="run"]')
        page.click('[data-k="skipticks"]')
        page.click('[data-k="skipticks"]')
        page.wait_for_function('() => T.toasts.length > 0')
        check('retry: the failed write toasts', page.evaluate('() => T.toasts') == ['Could not save the kata result; it will retry'],
              page.evaluate('() => T.toasts'))
        st = page.evaluate('() => T.state()')
        check('retry: a failed write leaves the kata unlogged', st['logged'] is False and st['usedDone'] is True, st)
        check('retry: nothing in the log yet', len(page.evaluate('() => T.kataEvents()')) == 0)
        check('skip: the settled view says the ticks were skipped', 'Ticks skipped' in page.evaluate("() => T.q('.nb-study-kata-settle').textContent"))
        page.evaluate('() => { T.failLog = false; T.mount(); }')
        page.wait_for_function('() => T.state().logged')
        evs = page.evaluate('() => T.kataEvents()')
        check('retry: the next mount writes the event once', len(evs) == 1, evs)
        if evs:
            check('skip: the event has empty called and used lists', evs[0]['called'] == [] and evs[0]['used'] == [], evs[0])
        page.evaluate('() => T.mount()')
        page.wait_for_timeout(80)
        check('retry: a later mount does not log again', len(page.evaluate('() => T.kataEvents()')) == 1)

        # ---- 6. a kata event synced from another device settles an open block
        page.evaluate('() => { T.reset(); T.mount(); }')
        call_through(page)
        check('sync: the block is open before the sync', page.evaluate("() => T.q('.nb-study-kata-settle').style.display") == 'none')
        page.evaluate("""() => {
          T.events.push({ v: 1, id: 'laptop-1', t: new Date().toISOString(), dev: 'laptop', type: 'kata', kata: 'k-fx-acc',
            pass: true, runs: 1, gaveUp: false, ms: 60000, called: ['bezout'], used: ['bezout'], hidden: false });
          T.fire('events');
        }""")
        settle = page.evaluate("() => T.q('.nb-study-kata-settle').textContent")
        check('sync: the block shows the synced settle', 'Passed on run 1' in settle and 'Method: hit' in settle, settle)
        check('sync: give-up is off after the sync', page.evaluate('() => T.q(\'[data-k="giveup"]\').disabled'))
        check('sync: the device logs nothing of its own', page.evaluate('() => T.logCalls') == 0)
        page.evaluate('() => T.handle.destroy()')
        check('destroy: the block unsubscribes from onChange', page.evaluate('() => T.listeners.length') == 0)

        check('no page errors', not errors, errors)
        b.close()
finally:
    srv.terminate()

print(f'\n{len(failures)} failed' if failures else '\nall passed')
sys.exit(1 if failures else 0)

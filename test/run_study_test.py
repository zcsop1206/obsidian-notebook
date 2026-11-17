# Drives the study UI in headless Chromium against test/harness.html's mock obsidian and
# in-memory vault, with the fixture, mock engine and mock StudyContext from
# test/out/study-fixture.js (built by test/build.mjs). Sections:
#
#   S5 marks     margin dots on every markable passage and anchored list item, the verb menu,
#                triage actions (scaffold + attempt ink, two-tap rebuild and rewrite requests,
#                budget-exhausted drilling, requested/clear), recheck on content/events change,
#                rebuild landing, and the Changes modal.
#   S8 panels    the open-study-today / open-study-map commands, the ribbon icon, the Today
#                panel (date, deadline, drills, picks with hidden "?", settled, requests),
#                the Map panel (basics graph, ratings, method accuracy, tracks), re-render on
#                context change, and a 390 px width pass.
#
# The engine is mocked (S2 lands separately): triage policies are steered through
# engine.triageOverride and the budget/pending knobs. Run with
# `python test/run_study_test.py`; screenshots land in test/out/. Exits non-zero on failure.
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 5
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

failures = []

def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail != '' and not ok else ''))
    if not ok:
        failures.append(name)

# The fixture: two basics (logic <- sets) and a topic doc that needs sets; a track with a
# deadline, a rating history, a problem, a kata and a Today plan.
SETUP = """() => {
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

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctxp = b.new_context(device_scale_factor=1, viewport={'width': 1000, 'height': 700})
        page = ctxp.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.add_script_tag(url=f'http://localhost:{port}/test/out/study-fixture.js')
        page.evaluate(SETUP)
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
          return { label: btn.textContent, armed,
            reqs: ctx.logged.filter(e => e.type === 'rewrite-request').length,
            banner: sc.querySelector('.nb-st-sc-banner').textContent,
            bannerOn: !sc.querySelector('.nb-st-sc-banner').hidden,
            dot: mhost.host.margin.querySelector('.nb-st-dot[data-a="p-def"]').className,
            req };
        }""")
        check('marks: eligible shows "Request rewrite (2 of 3 left)"', r['label'].startswith('Request rewrite'), r['label'])
        check('marks: the rewrite request needs two taps and then logs once',
              r['armed']['n'] == 0 and r['armed']['armed'] and r['reqs'] == 1, (r['armed'], r['reqs']))
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
              r['armedN'] == 0 and len(r['reqs']) == 1 and r['reqs'][0]['doc'] == 'b-sets' and r['reqs'][0]['a'] == 'i-one', r['reqs'])
        check('marks: the banner and toast say "Rebuild requested"',
              'Rebuild requested' in r['banner'] and 'Rebuild requested' in r['toast'], (r['banner'], r['toast']))

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
          await S.openChanges(ctx, 'topic-dp');
          const m = modals[modals.length - 1];
          const t = m.contentEl.textContent;
          const heads = [...m.contentEl.querySelectorAll('h4')].map(h => h.textContent);
          const marks = [...m.contentEl.querySelectorAll('.nb-st-mark')].map(e => e.textContent);
          const n0 = ctx.uiCalls.length;
          const row = m.contentEl.querySelector('.nb-st-mark');
          if (row) row.click();
          return { title: m.titleEl.textContent, heads, marks, openCalls: ctx.uiCalls.slice(n0),
            closed: !document.body.contains(m.modalEl), t };
        }""")
        check('changes: the panel shows build, budget, requests, marks and the ## Changes section',
              r['title'] == 'Changes · Dynamic programming' and
              r['heads'] == ['Pending requests', 'Marks', 'Changes section'] and
              '4 · cs-core' in r['t'] and '1 of 3 used' in r['t'] and 'rewrote the memoisation' in r['t'], (r['title'], r['heads']))
        check('changes: mark rows list the open marks and open their anchor',
              len(r['marks']) == 1 and 'lost' in r['marks'][0] and '#p-def' in r['marks'][0] and
              r['openCalls'] == [{'fn': 'openDoc', 'args': ['topic-dp', 'p-def']}] and r['closed'], (r['marks'], r['openCalls']))

        r = ev("() => { marks.destroy(); const left = document.querySelectorAll('.nb-st-dot').length; document.getElementById('study-host').remove(); return left; }")
        check('marks: destroy removes the dots', r == 0, r)

        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'study_map.png'))
        check('no page errors', not errors, errors[:3])
finally:
    srv.terminate()

print()
if failures:
    print(f'{len(failures)} FAILURE(S):')
    for f in failures:
        print(' -', f)
    sys.exit(1)
print('all checks passed')

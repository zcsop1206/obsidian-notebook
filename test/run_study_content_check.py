# Real-content check for study mode. When STUDY_CONTENT_DIR is set, loads every .md under that
# folder into the mock vault under "study/" (in memory only; nothing is copied into the repo),
# starts the plugin on test/harness.html, opens the library, then opens every study doc in the
# study view, and Today and the Map. It fails on any console error or page error, on a doc that
# renders no passages, and on a doc whose rendered passages differ from the ones the parser says
# the view must show. Without STUDY_CONTENT_DIR it prints SKIP and exits 0.
#
#   STUDY_CONTENT_DIR="C:/Users/.../EngineeringPortfolio/content/study" python test/run_study_content_check.py
#
# Port: NB_STUDY_CONTENT_PORT, else NB_TEST_PORT_BASE + 12 (8777). Needs main.js (npm run build).
import os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.environ.get('STUDY_CONTENT_DIR', '').strip()
port = int(os.environ.get('NB_STUDY_CONTENT_PORT', int(os.environ.get('NB_TEST_PORT_BASE', 8765)) + 12))

if not SRC:
    print('SKIP study content check: STUDY_CONTENT_DIR is not set')
    sys.exit(0)
if not os.path.isdir(SRC):
    print(f'FAIL STUDY_CONTENT_DIR is not a folder: {SRC}')
    sys.exit(1)

from playwright.sync_api import sync_playwright

failures = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
    sys.stdout.flush()
    if not ok:
        failures.append(name)


def content_files():
    files = {}
    for dirpath, _, names in os.walk(SRC):
        for n in sorted(names):
            if not n.endswith('.md'):
                continue
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, SRC).replace(os.sep, '/')
            with open(full, encoding='utf-8') as f:
                files['study/' + rel] = f.read().replace('\r\n', '\n')
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
  window.sleep = ms => new Promise(r => setTimeout(r, ms));
  window.V = () => { const l = app.workspace.getLeavesOfType('notebook-study')[0]; return l ? l.view : null; };
  // The passages the view must render: all but solutions and a kata's own skeleton and vectors.
  window.expectedAnchors = id => {
    const d = plugin.study.content().docs.get(id);
    return d.passages.filter(p => !(p.block && p.block.type === 'solution') && !(p.callout && p.callout.type === 'solution')
      && !(d.kind === 'kata' && p.kind === 'code' && (p.lang === 'skeleton' || p.lang === 'vectors'))).map(p => p.anchor);
  };
  window.renderedAnchors = () => [...document.querySelectorAll('.nb-study-doc .sr-passage[data-a]')]
    .filter(e => !e.closest('.nb-study-margin, .nb-st-scaffold')).map(e => e.getAttribute('data-a'));
}"""


def main():
    files = content_files()
    print(f'{len(files)} .md files from {SRC}')
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1024, 'height': 768})
            errors = []
            page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            page.on('console', lambda m: errors.append(f'console.error: {m.text}') if m.type == 'error' else None)
            page.goto(f'http://localhost:{port}/test/harness.html')
            page.evaluate(SETUP_JS, files)
            page.evaluate("async () => { window.pluginData = { study: { root: 'study', device: 'check' } }; window.plugin = await loadPlugin(); }")
            try:
                page.wait_for_function("() => plugin.study && plugin.study.content().docs.size > 0", timeout=15000)
            except Exception:
                pass
            idx = page.evaluate("""() => {
              const c = plugin.study.content();
              return { docs: [...c.docs.values()].map(d => ({ id: d.id, kind: d.kind, path: d.path, warnings: d.warnings || [] })),
                       problems: c.problems.size, katas: c.katas.size, methods: c.methods.size };
            }""")
            docs = idx['docs']
            check('content: the loader indexed docs', len(docs) > 0, f'{len(docs)} docs')
            print(f"{len(docs)} docs, {idx['problems']} problems, {idx['katas']} katas, {idx['methods']} methods")
            for d in docs:
                for w in d['warnings']:
                    print(f"  WARN {d['id']}: {w}")
            if errors:
                check('load: no console errors while indexing', False, ' | '.join(errors[:5]))
                errors.clear()

            # The library.
            page.evaluate("() => commands['open-study'].callback()")
            ok = True
            try:
                page.wait_for_function("() => V() && document.querySelector('.nb-study-lib') && document.querySelector('.nb-study-lib').isShown()", timeout=6000)
            except Exception:
                ok = False
            n = page.evaluate("() => document.querySelectorAll('.nb-study-lib [data-doc], .nb-study-lib .nb-study-lib-item, .nb-study-lib button').length")
            check('library: opens and lists entries', ok and n > 0, f'shown {ok}, {n} entries')
            check('library: no console errors', not errors, ' | '.join(errors[:5]))
            errors.clear()

            # Every doc in the study view.
            for d in docs:
                did = d['id']
                page.evaluate("d => plugin.study.ui.openDoc(d)", did)
                ok = True
                try:
                    page.wait_for_function("d => V() && V().currentDoc() === d && V().renderDone()", arg=did, timeout=15000)
                except Exception:
                    ok = False
                page.wait_for_timeout(120)
                r = page.evaluate("d => ({ got: renderedAnchors(), want: expectedAnchors(d) })", did)
                got, want = r['got'], r['want']
                missing = [a for a in want if a not in got]
                check(f"doc {did} ({d['kind']}): renders {len(got)} passages", ok and len(got) > 0, f'rendered {ok}, {len(got)} passages')
                if want:
                    check(f'doc {did}: every expected passage is on the page', not missing, f'missing {missing[:8]}')
                check(f'doc {did}: no console errors', not errors, ' | '.join(errors[:4])[:900])
                errors.clear()

            # Today and the Map on the real engine.
            for name, js in [('Today', "() => plugin.study.ui.openToday()"), ('Map', "() => plugin.study.ui.openMap()")]:
                page.evaluate(js)
                page.wait_for_timeout(400)
                check(f'{name}: opens without console errors', not errors, ' | '.join(errors[:4])[:900])
                errors.clear()
            browser.close()
    finally:
        srv.terminate()
    print(f'\n{len(failures)} failure(s)' if failures else '\nall study content checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()

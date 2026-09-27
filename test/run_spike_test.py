# Drives the spike in headless Chromium with a mock obsidian module and a fake mic.
# Run from anywhere: python test/run_spike_test.py. Screenshots land in test/out/.
import json, os, re, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
os.makedirs(OUT, exist_ok=True)
port = 8765
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=os.path.dirname(HERE), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

def dump_fs(page):
    return page.evaluate("""() => [...fs.entries()].map(([k, v]) => [k, typeof v === 'string' ? v.length : v.length, typeof v])""")

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(permissions=['microphone'], device_scale_factor=2)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        page.goto(f'http://localhost:{port}/test/harness.html')
        page.evaluate("async () => { window.p = await loadPlugin(); await p.open(); }")

        # --- ink: synthetic pen strokes with varying pressure, one touch, one tap, one real mouse stroke
        page.evaluate("""async () => {
          const c = view.canvas, r = c.getBoundingClientRect();
          const fire = (type, x, y, p, id = 7, pt = 'pen') => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: pt, pressure: p, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, tiltX: 20, tiltY: -5 }));
          const sleep = ms => new Promise(res => setTimeout(res, ms));
          for (let k = 0; k < 3; k++) {
            const y0 = 80 + k * 90;
            fire('pointerdown', 40, y0, 0.2);
            for (let i = 1; i <= 80; i++) { const x = 40 + i * 9, y = y0 + 30 * Math.sin(i / 8); fire('pointermove', x, y, 0.1 + 0.8 * i / 80); await sleep(4); }
            fire('pointerup', 760, y0, 0);
          }
          fire('pointerdown', 300, 400, 0.5, 9, 'touch');
          fire('pointerdown', 800, 420, 0.6); fire('pointerup', 800, 420, 0);
        }""")
        box = page.locator('canvas').bounding_box()
        page.mouse.move(box['x'] + 60, box['y'] + 420)
        page.mouse.down()
        for i in range(40):
            page.mouse.move(box['x'] + 60 + i * 12, box['y'] + 420 + (i % 10) * 4, steps=2)
        page.mouse.up()
        page.wait_for_timeout(400)
        print('HUD:\n' + page.inner_text('.nbspike-hud'))
        page.locator('#leaf').screenshot(path=os.path.join(OUT, 'shot_canvas.png'))

        page.evaluate("() => view.save()")
        page.wait_for_timeout(300)
        svg_name = page.evaluate("() => [...fs.keys()].find(k => k.endsWith('.svg'))")
        svg = page.evaluate(f"() => fs.get('{svg_name}')")
        meta = json.loads(re.search(r'<!\[CDATA\[(.*)\]\]>', svg).group(1))
        print('SVG', svg_name, len(svg), 'bytes;', len(meta['strokes']), 'strokes;', [s['type'] for s in meta['strokes']], 'first pts', meta['strokes'][0]['pts'][:3])
        print('RESULTS.md:\n' + page.evaluate("() => fs.get('_spike/_results.md')"))
        with open(os.path.join(OUT, 'ink.svg'), 'w') as f: f.write(svg)
        for scheme in ['light', 'dark']:
            p2 = ctx.new_page(); p2.emulate_media(color_scheme=scheme)
            p2.set_content(f"<body style='margin:0;background:{'#fff' if scheme=='light' else '#1e1e1e'}'><img src='http://localhost:{port}/test/out/ink.svg'></body>")
            p2.wait_for_timeout(300); p2.screenshot(path=os.path.join(OUT, f'shot_svg_{scheme}.png')); p2.close()

        # --- audio A: appendBinary present; background, killed track, resume, stop
        page.evaluate("async () => { await p.recorder.start(); }")
        page.wait_for_timeout(5000)
        page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }""")
        page.wait_for_timeout(1500)
        page.evaluate("() => p.recorder.track().stop()")  # simulate iOS taking the mic away
        page.wait_for_timeout(1500)
        page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }""")
        page.wait_for_timeout(5000)
        print('HUD during rec:', page.inner_text('.nbspike-hud').splitlines()[-1])
        page.evaluate("async () => { await p.recorder.stop(); }")
        dirA = page.evaluate("() => p.recorder.dir")
        print('LOG A:\n' + page.evaluate(f"() => fs.get('{dirA}/_log.md')"))

        decode = """async (path) => {
          const bytes = fs.get(path);
          const ac = new OfflineAudioContext(1, 1, 48000);
          try { const buf = await ac.decodeAudioData(bytes.slice().buffer); return `${path}: ${bytes.length} bytes, decodes to ${buf.duration.toFixed(2)} s`; }
          catch (e) { return `${path}: ${bytes.length} bytes, DECODE FAILED ${e}`; }
        }"""
        for f in page.evaluate(f"() => [...fs.keys()].filter(k => k.startsWith('{dirA}/audio-'))"):
            print(page.evaluate(decode, f))

        # --- audio C: what the iPad does. Hidden, then back with the mic live and the recorder
        # saying "recording" but delivering nothing. Then the same stall while visible (watchdog).
        page.evaluate("async () => { await p.recorder.start(); }")
        page.wait_for_timeout(4500)
        page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); p.recorder.rec.ondataavailable = null; }""")
        page.wait_for_timeout(2000)
        page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }""")
        page.wait_for_timeout(4500)
        page.evaluate("() => { p.recorder.rec.ondataavailable = null; }")  # stall while visible
        page.wait_for_timeout(9000)
        page.evaluate("async () => { await p.recorder.stop(); }")
        dirC = page.evaluate("() => p.recorder.dir")
        logC = page.evaluate(f"() => fs.get('{dirC}/_log.md')")
        print('LOG C:\n' + logC)
        segsC = sorted(page.evaluate(f"() => [...fs.keys()].filter(k => k.startsWith('{dirC}/audio-'))"))
        for f in segsC:
            print(page.evaluate(decode, f))
        ok_c = len(segsC) == 3 and 'back after' in logC and 'no audio for' in logC and 'DECODE FAILED' not in ''.join(page.evaluate(decode, f) for f in segsC)
        print('AUDIO C', 'ok: return and watchdog each started a new segment' if ok_c else 'FAILED')

        # --- audio B: no appendBinary, then a crash mid-recording, then recovery on next load
        page.evaluate("async () => { delete adapter.appendBinary; await p.recorder.start(); }")
        page.wait_for_timeout(7000)
        dirB = page.evaluate("""async () => {
          const r = p.recorder; r.rec.ondataavailable = null; r.rec.onstop = null; r.rec.stop(); r.stream.getTracks().forEach(t => t.stop());
          await r.q.run(() => {}); return r.dir; }""")
        print('before recovery:', [k for k, *_ in dump_fs(page) if k.startswith(dirB)])
        page.evaluate("async () => { window.p2 = await loadPlugin(); await new Promise(r => setTimeout(r, 500)); }")
        after = [k for k, *_ in dump_fs(page) if k.startswith(dirB)]
        print('after recovery:', after)
        print('LOG B tail:\n' + '\n'.join(page.evaluate(f"() => fs.get('{dirB}/_log.md')").splitlines()[-3:]))
        for f in [k for k in after if '/audio-' in k]:
            print(page.evaluate(decode, f))
        print('notices:', page.evaluate("() => notices"))
        print('page errors:', errors)
        b.close()
finally:
    srv.terminate()

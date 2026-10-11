// The uniform pen's advanced settings (#69): per-stroke smoothing (`smooth`, the refit radius),
// the stabiliser (`stab`), tapered ends (`taper`) and the thin-line boost; their place in the
// file format (absent = today's drawing, so old files keep their bytes), LiveFit with them, the
// PDF export of a tapered stroke, the settings and the pen lab's variants.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  centreline, followRate, LiveFit, liveFit, refit, refitRadius, refitStep, REFIT_RADIUS, stabilise, strokeGeometry, strokePath, TAPER_TIP,
} from '../../src/format/outline';
import { readPage, writePage, newPage, type PenStroke, type Point } from '../../src/format/page';
import { strokeOps } from '../../src/ink/export-pdf';
import { DEFAULT_TUNING, parseTuning, tuningFields } from '../../src/ink/pen';
import { BOOST_DEVICE_PX, paintPath, setThinLineBoost } from '../../src/ink/renderer';
import { LAB_WORD, labStrokes, labVariants } from '../../src/debug/pen-lab';

/** A seeded wavy, noisy stroke in the Pencil's 0.5 px steps (about 0.45 px apart). */
function wobbly(n: number, seed = 3): Point[] {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round((100 + i * 0.45 + 0.5 * rnd()) * 2) / 2, y = Math.round((200 + 6 * Math.sin(i / 25) + 0.8 * rnd()) * 2) / 2;
    const q = pts[pts.length - 1];
    if (q && Math.hypot(x - q.x, y - q.y) < 0.25) continue;
    pts.push({ x, y, p: 0.1, t: i * 2 });
  }
  return pts;
}

const pen = (points: Point[], extra: Partial<PenStroke> = {}): PenStroke =>
  ({ id: 'aaaaaaaa', tool: 'pen', nib: 'uniform', color: '#000000', size: 2.5, points, ...extra });

test('#69 defaults: a stroke without the new fields, or with the default values, is drawn exactly as before', () => {
  const pts = wobbly(400), s = pen(pts);
  assert.deepEqual(tuningFields(DEFAULT_TUNING), {});
  // Before #69: centreline(refit(points, refitStep)) with the 1.5 px radius.
  assert.equal(strokePath(s), centreline(refit(pts, refitStep(s))));
  assert.equal(strokePath(pen(pts, { smooth: REFIT_RADIUS })), strokePath(s));
  assert.equal(strokePath(pen(pts, { stab: 0, taper: 0 })), strokePath(s));
  assert.equal(strokeGeometry(s).ends, '');
  assert.equal(refitStep(pen(pts, { smooth: 1.5 })), refitStep(s));
  // The pressure nib (out of scope) is unaffected by the uniform pen's defaults.
  const p = { ...s, nib: 'pressure' as const };
  assert.equal(strokePath(p), strokePath({ tool: 'pen', nib: 'pressure', size: 2.5, points: pts }));
});

test('#69 format: smooth, stab and taper round-trip in the metadata after size; absent stays absent', () => {
  const page = newPage('p-0a0b0c');
  page.strokes.push(pen(wobbly(80), { id: 'aaaaaaa1', smooth: 3, stab: 0.35, taper: 2 }));
  page.strokes.push(pen(wobbly(80, 5), { id: 'aaaaaaa2' }));
  page.strokes.push({ ...pen(wobbly(80, 7), { id: 'aaaaaaa3', smooth: 0 }), nib: 'pressure' });
  const text = writePage(page);
  assert.match(text, /\{"id":"aaaaaaa1","tool":"pen","nib":"uniform","color":"#000000","size":2.5,"smooth":3,"stab":0.35,"taper":2,"points":/);
  assert.match(text, /\{"id":"aaaaaaa2","tool":"pen","nib":"uniform","color":"#000000","size":2.5,"points":/);
  assert.match(text, /\{"id":"aaaaaaa3","tool":"pen","nib":"pressure","color":"#000000","size":2.5,"smooth":0,"points":/);
  const back = readPage(text);
  const [a, b, c] = back.strokes as PenStroke[];
  assert.deepEqual([a.smooth, a.stab, a.taper], [3, 0.35, 2]);
  assert.ok(!('smooth' in b) && !('stab' in b) && !('taper' in b), JSON.stringify(Object.keys(b)));
  assert.equal(c.smooth, 0);
  assert.equal(writePage(back), text, 'read then written: the same bytes');
});

test('#69 format: values out of range, or a stabiliser or taper on the pressure nib or the highlighter, are refused', () => {
  const bad = (fields: Record<string, unknown>, nib = 'uniform', tool = 'pen') => {
    const s = { id: 'aaaaaaaa', tool, ...(tool === 'pen' ? { nib } : {}), color: '#000000', size: 2, ...fields, points: [1, 2, 0.5, 0] };
    return `<svg><metadata><![CDATA[${JSON.stringify({ format: 'notebook-ink/1', id: 'p-0a0b0c', size: { width: 100, height: 100 }, template: { kind: 'blank' }, strokes: [s] })}]]></metadata></svg>`;
  };
  assert.throws(() => readPage(bad({ smooth: 11 })), /invalid smooth/);
  assert.throws(() => readPage(bad({ smooth: -1 })), /invalid smooth/);
  assert.throws(() => readPage(bad({ stab: 1.5 })), /invalid stab/);
  assert.throws(() => readPage(bad({ taper: 'long' })), /invalid taper/);
  assert.throws(() => readPage(bad({ stab: 0.3 }, 'pressure')), /only the uniform nib/);
  assert.throws(() => readPage(bad({ taper: 2 }, 'pressure')), /only the uniform nib/);
  assert.throws(() => readPage(bad({ smooth: 1 }, '', 'highlighter')), /only pen strokes/);
  assert.equal((readPage(bad({ smooth: 1.04, stab: 0.333, taper: 2.06 })).strokes[0] as PenStroke).smooth, 1);
  const s = readPage(bad({ smooth: 1.04, stab: 0.333, taper: 2.06 })).strokes[0] as PenStroke;
  assert.deepEqual([s.smooth, s.stab, s.taper], [1, 0.33, 2.1]);
});

test('#69 smoothing: the refit radius and step follow `smooth`; 0 turns the refit off; more smoothing, a smoother line', () => {
  const pts = wobbly(600);
  assert.equal(refitRadius(pen(pts)), 1.5);
  assert.equal(refitRadius(pen(pts, { smooth: 3 })), 3);
  assert.equal(refitStep(pen(pts, { smooth: 3 })), 2 * refitStep(pen(pts)));
  assert.equal(refitStep(pen(pts, { smooth: 0.75 })), refitStep(pen(pts)) / 2);
  assert.equal(strokePath(pen(pts, { smooth: 0 })), centreline(pts), 'off: the samples themselves');
  // Roughness: RMS second difference of the refitted points' y over the squared spacing (a curvature).
  const rough = (s: PenStroke) => {
    const q = refit(s.points, refitStep(s), refitRadius(s));
    let sum = 0;
    for (let i = 1; i < q.length - 1; i++) {
      const h = (Math.hypot(q[i].x - q[i - 1].x, q[i].y - q[i - 1].y) + Math.hypot(q[i + 1].x - q[i].x, q[i + 1].y - q[i].y)) / 2;
      sum += ((q[i - 1].y - 2 * q[i].y + q[i + 1].y) / (h * h)) ** 2;
    }
    return Math.sqrt(sum / (q.length - 2));
  };
  const r = [0, 1, 1.5, 3, 5].map(smooth => rough(pen(pts, { smooth })));
  for (let i = 1; i < r.length; i++) assert.ok(r[i] < r[i - 1], `roughness ${r.map(v => v.toFixed(3)).join(' > ')}`);
});

test('#69 stabiliser: an exponential follow (perfect-freehand streamline), first and last samples kept, raw points untouched', () => {
  const pts = wobbly(300), copy = JSON.stringify(pts);
  assert.deepEqual(stabilise(pts, 0), pts);
  const st = stabilise(pts, 0.35), rate = followRate(0.35);
  assert.equal(rate, 0.15 + 0.65 * 0.85);
  assert.deepEqual(st[0], pts[0]);
  assert.deepEqual(st[st.length - 1], pts[pts.length - 1], 'ends where the pen lifted');
  assert.equal(st.length, pts.length + 1, 'the follow points, then the last sample');
  assert.ok(Math.abs(st[1].x - (pts[0].x + rate * (pts[1].x - pts[0].x))) < 1e-12);
  assert.equal(JSON.stringify(pts), copy);
  // Stronger stabilising: less jitter in the stabilised points.
  const jitter = (q: Point[]) => { let s = 0; for (let i = 1; i < q.length - 1; i++) s += (q[i - 1].y - 2 * q[i].y + q[i + 1].y) ** 2; return s; };
  assert.ok(jitter(stabilise(pts, 0.6)) < jitter(stabilise(pts, 0.2)) && jitter(stabilise(pts, 0.2)) < jitter(pts));
  // The committed stroke is drawn from the stabilised points.
  const s = pen(pts, { stab: 0.35 });
  assert.equal(strokePath(s), centreline(refit(st, refitStep(s), refitRadius(s))));
  assert.notEqual(strokePath(s), strokePath(pen(pts)));
});

test('#69 LiveFit with smoothing and a stabiliser equals the committed refit for every prefix', () => {
  const pts = wobbly(500);
  for (const extra of [{ stab: 0.35 }, { stab: 0.6, smooth: 3 }, { smooth: 5 }, { smooth: 0 }, { stab: 0.2, smooth: 1 }] as Partial<PenStroke>[]) {
    const s = pen(pts, extra), fit = liveFit(s), trace: Point[] = [];
    let settled = 0, frozen: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      trace.push(pts[i]);
      const n = fit.update(trace), want = refit(stabilise(trace, s.stab ?? 0), refitStep(s), refitRadius(s));
      assert.equal(n, want.length, `${JSON.stringify(extra)}: count at ${i}`);
      if (i % 7 === 0 || i === pts.length - 1) assert.deepEqual(fit.slice(0), want, `${JSON.stringify(extra)}: points at ${i}`);
      // Settled points never change.
      assert.ok(fit.settled >= settled);
      assert.deepEqual(fit.slice(0, frozen.length), frozen);
      settled = fit.settled;
      frozen = fit.slice(0, settled);
    }
    assert.equal(strokePath({ ...s, points: fit.slice(0) }, true), strokePath(s), `${JSON.stringify(extra)}: live path = committed path`);
  }
  // Without settings, as before.
  assert.deepEqual(new LiveFit(refitStep(pen(pts))).update(pts), liveFit(pen(pts)).update(pts));
});

/** The subpaths of a path `d` as lists of [x, y] (M, L, Q end points; Z dropped). */
function subpaths(d: string): number[][][] {
  return d.split('M').filter(Boolean).map(sp => (sp.match(/-?[\d.]+ -?[\d.]+(?=[LQZ]|$)/g) ?? []).map(v => v.split(' ').map(Number)));
}

test('#69 taper: the even middle is the centreline cut L from each end; the ends are two closed polygons meeting it', () => {
  const pts = wobbly(400), s = pen(pts, { taper: 2 }), plain = pen(pts);
  const g = strokeGeometry(s), full = subpaths(strokePath(plain))[0];
  const mid = subpaths(g.d), ends = subpaths(g.ends);
  assert.equal(mid.length, 1);
  assert.equal(ends.length, 2, 'head and tail');
  assert.equal((g.ends.match(/Z/g) ?? []).length, 2);
  // The middle starts and ends inside the stroke, about L = 2 × 2.5 = 5 px (of arc) from its ends.
  const m = mid[0], [a, b] = [m[0], m[m.length - 1]];
  const d0 = Math.hypot(a[0] - full[0][0], a[1] - full[0][1]), d1 = Math.hypot(b[0] - full[full.length - 1][0], b[1] - full[full.length - 1][1]);
  assert.ok(d0 > 4 && d0 <= 5.01 && d1 > 4 && d1 <= 5.01, `${d0} ${d1}`);
  // Each end reaches its tip and is `size` wide where it meets the middle.
  const near = (p: number[], q: number[], e: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= e;
  for (const [poly, join, tip] of [[ends[0], a, full[0]], [ends[1], b, full[full.length - 1]]] as [number[][], number[], number[]][]) {
    // Two corners half the size from the join, either side.
    const corners = poly.filter(p => Math.abs(Math.hypot(p[0] - join[0], p[1] - join[1]) - 1.25) < 0.015);
    assert.ok(corners.length >= 2 && corners.some(p => near(p, [2 * join[0] - corners[0][0], 2 * join[1] - corners[0][1]], 0.03)), `corners at the join ${JSON.stringify(corners)}`);
    assert.ok(poly.some(p => near(p, tip, 2.5 * TAPER_TIP / 2 + 0.02)), 'the round tip at the stroke end');
    assert.ok(poly.every(p => !near(p, tip, 2.5 * TAPER_TIP / 2 - 0.02)), 'and no wider than TAPER_TIP there');
    // Wound like canvas arc(): positive shoelace area.
    let area = 0;
    for (let k = 0; k < poly.length; k++) area += poly[k][0] * poly[(k + 1) % poly.length][1] - poly[(k + 1) % poly.length][0] * poly[k][1];
    assert.ok(area > 0, `area ${area}`);
  }
  // Short stroke: the ends meet in the middle at a dot `size` wide.
  const short = strokeGeometry(pen(wobbly(12), { taper: 4 }));
  assert.match(short.d, /^M(-?[\d.]+) (-?[\d.]+)L\1 \2$/);
  assert.equal(subpaths(short.ends).length, 2);
  // A one-point stroke (a dot) has nothing to taper.
  const dot = strokeGeometry(pen([{ x: 5, y: 5, p: 0.5, t: 0 }], { taper: 2 }));
  assert.deepEqual(dot, { d: 'M5 5L5 5', ends: '' });
  // The live pieces: only the head, only the tail, or none.
  assert.equal(subpaths(strokeGeometry(s, false, 'head').ends).length, 1);
  assert.equal(subpaths(strokeGeometry(s, false, 'tail').ends).length, 1);
  assert.deepEqual(strokeGeometry(s, false, 'none'), { d: strokePath(plain), ends: '' });
  // The pressure nib (no taper there) and the highlighter have no ends.
  assert.equal(strokeGeometry({ tool: 'highlighter', size: 18, points: pts }).ends, '');
});

test('#69 taper: the middle is the same curve as the untapered centreline (sampled points lie on it)', () => {
  const pts = wobbly(300), s = pen(pts, { taper: 2 });
  const curve = (d: string) => {
    // Flatten M/L/Q finely.
    const out: number[][] = [];
    const t = d.match(/[MLQ]|-?[\d.]+/g) ?? [];
    let i = 0, cmd = '';
    const n = () => Number(t[i++]);
    while (i < t.length) {
      if (/[MLQ]/.test(t[i])) cmd = t[i++];
      if (cmd === 'Q') {
        const [x0, y0] = out[out.length - 1], cx = n(), cy = n(), x1 = n(), y1 = n();
        for (let k = 1; k <= 40; k++) { const u = k / 40, v = 1 - u; out.push([v * v * x0 + 2 * u * v * cx + u * u * x1, v * v * y0 + 2 * u * v * cy + u * u * y1]); }
      } else out.push([n(), n()]);
    }
    return out;
  };
  const full = curve(strokePath(pen(pts))), mid = curve(strokeGeometry(s).d);
  const dist = (p: number[]) => Math.min(...full.map(q => Math.hypot(p[0] - q[0], p[1] - q[1])));
  const worst = Math.max(...mid.filter((_, k) => k % 5 === 0).map(dist));
  assert.ok(worst < 0.03, `the middle is within ${worst} px of the untapered curve`);
});

test('#69 SVG: a tapered stroke is a group of its stroked middle and its filled ends; default ink keeps classes u and i', () => {
  const page = newPage('p-0a0b0c');
  page.strokes.push(pen(wobbly(120), { id: 'aaaaaaa1', taper: 2 }));
  page.strokes.push(pen(wobbly(120, 9), { id: 'aaaaaaa2', taper: 4, color: '#1e6fff' }));
  const text = writePage(page), [a, b] = page.strokes;
  const ga = strokeGeometry(a), gb = strokeGeometry(b);
  assert.ok(text.includes(`<g data-id="aaaaaaa1"><path class="u" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="${ga.d}"/><path class="i" d="${ga.ends}"/></g>`));
  assert.ok(text.includes(`<g data-id="aaaaaaa2"><path fill="none" stroke="#1e6fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="${gb.d}"/><path fill="#1e6fff" d="${gb.ends}"/></g>`));
  assert.ok(text.includes('.u{stroke:#1f1f1f}'));
});

test('#69 PDF: a tapered stroke is stroked (its middle), then its ends filled in the same colour', () => {
  const s = pen(wobbly(120), { taper: 2, color: '#e0301e' });
  const ops = strokeOps(s);
  assert.match(ops, /^0\.878 0\.188 0\.118 RG 2\.5 w 1 J 1 j\n[\s\S]*\nS\n0\.878 0\.188 0\.118 rg\n[\s\S]*\nf\n$/);
  assert.equal((ops.match(/\nh/g) ?? []).length, 2, 'two closed ends');
  assert.equal(strokeOps(pen(wobbly(120))).includes(' rg'), false, 'untapered: stroked only, as before');
});

test('#69 settings: levels parsed, anything else the default; only non-default values go into strokes', () => {
  assert.deepEqual(parseTuning(undefined), DEFAULT_TUNING);
  assert.deepEqual(DEFAULT_TUNING, { smooth: 1.5, stab: 0, taper: 0, boost: false });
  assert.deepEqual(parseTuning({ smooth: 3, stab: 0.35, taper: 2, boost: true }), { smooth: 3, stab: 0.35, taper: 2, boost: true });
  assert.deepEqual(parseTuning({ smooth: 2, stab: 'x', taper: -1, boost: 1 }), DEFAULT_TUNING);
  assert.deepEqual(parseTuning('nonsense'), DEFAULT_TUNING);
  assert.deepEqual(tuningFields({ smooth: 1.5, stab: 0.2, taper: 0, boost: true }), { stab: 0.2 });
  assert.deepEqual(tuningFields({ smooth: 0, stab: 0, taper: 4, boost: false }), { smooth: 0, taper: 4 });
});

test('#69 thin-line boost: off by default; on, lines under 1.5 px are drawn at least 2 device px wide, only where they are thinner', () => {
  const ctx = (scale: number) => {
    const c = { lineWidth: 0, lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '', getTransform: () => ({ a: scale, b: 0, c: 0, d: scale }), stroke() {}, fill() {} };
    return c as unknown as CanvasRenderingContext2D & { lineWidth: number };
  };
  const width = (size: number, scale: number) => {
    const c = ctx(scale);
    paintPath(c, { tool: 'pen', nib: 'uniform', size }, {} as Path2D, '#000');
    return c.lineWidth;
  };
  try {
    assert.equal(setThinLineBoost(false), false);
    assert.equal(width(0.5, 2.6), 0.5, 'off');
    assert.equal(setThinLineBoost(true), true);
    // The iPad at 100%: about 2.6 device px per page px.
    assert.equal(width(0.5, 2.6), BOOST_DEVICE_PX / 2.6);
    assert.equal(width(1, 2.6), 1, 'already 2.6 device px');
    assert.equal(width(1.5, 1), 1.5, 'not 1.5 px or more');
    assert.equal(width(1, 1), 2);
    // From about 150% (1.3 × 1.5 × 2 = 3.9 device px per page px; 4 here) nothing is under 2 device px.
    assert.ok(Math.abs(width(0.5, 3.9) - 0.5) < 0.02);
    assert.equal(width(0.5, 4), 0.5);
    assert.equal(width(1, 8), 1);
  } finally {
    setThinLineBoost(false);
  }
});

test('#69 pen lab: today\'s pen, the settings in use, then each other level on its own, the word as uniform strokes', () => {
  const v = labVariants({ smooth: 3, stab: 0.35, taper: 2, boost: false });
  assert.deepEqual(v.map(x => x.name), ["Today's pen", 'Your settings', 'Smoothing Off', 'Smoothing Light (1 px)', 'Smoothing Strong (3 px)',
    'Smoothing Max (5 px)', 'Stabiliser Light', 'Stabiliser Normal', 'Stabiliser Strong', 'Taper Short (2 × size)', 'Taper Long (4 × size)', 'Thin-line boost']);
  assert.deepEqual(v[0].tuning, DEFAULT_TUNING);
  const strokes = labStrokes(v[1].tuning, 1);
  assert.equal(strokes.length, LAB_WORD.length);
  assert.deepEqual([strokes[0].smooth, strokes[0].stab, strokes[0].taper, strokes[0].size, strokes[0].nib], [3, 0.35, 2, 1, 'uniform']);
  assert.ok(strokes[0].points.length > 100 && strokes[1].points.length === 1);
  assert.ok(!('smooth' in labStrokes(DEFAULT_TUNING, 1)[0]));
});

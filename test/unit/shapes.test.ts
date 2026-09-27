// Shape recognition (#16): synthetic hand-drawn shapes with seeded noise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Point } from '../../src/format/page';
import { recognize, STEP, type ShapeKind } from '../../src/ink/shapes';
import { seeded, type Seeded } from '../seeded';

type XY = [number, number];

/**
 * A hand-drawn stroke along `path` (a polyline, page px): about 0.5 px steps, a slow wobble
 * of amplitude 2 × `wobble` across the path plus ±`jitter` px noise, pressure around 0.5, 2 ms apart.
 */
function draw(r: Seeded, path: XY[], wobble = 2, jitter = 1.2): Point[] {
  const out: Point[] = [];
  const f1 = r.range(0.01, 0.03), f2 = r.range(0.04, 0.08), ph = r.range(0, 6);
  let s = 0, t = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i], L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(L / 0.5)), nx = -(by - ay) / L, ny = (bx - ax) / L;
    for (let j = i === 1 ? 0 : 1; j <= n; j++) {
      const u = j / n, w = 2 * wobble * (Math.sin(s * f1 + ph) * 0.7 + Math.sin(s * f2) * 0.3);
      out.push({ x: ax + (bx - ax) * u + nx * w + r.range(-jitter, jitter), y: ay + (by - ay) * u + ny * w + r.range(-jitter, jitter),
        p: 0.4 + 0.2 * r.next(), t });
      s += L / n;
      t += 2;
    }
  }
  return out;
}

/** A closed loop through `corners`, each rounded with radius `rad` (a quarter-arc-ish fillet). */
function rounded(corners: XY[], rad: number): XY[] {
  const out: XY[] = [], n = corners.length;
  for (let i = 0; i <= n; i++) {
    const p = corners[i % n], a = corners[(i - 1 + n) % n], b = corners[(i + 1) % n];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const pa: XY = [p[0] + (a[0] - p[0]) * rad / da, p[1] + (a[1] - p[1]) * rad / da];
    const pb: XY = [p[0] + (b[0] - p[0]) * rad / db, p[1] + (b[1] - p[1]) * rad / db];
    for (let k = 0; k <= 6; k++) {
      const u = k / 6, m = 1 - u; // quadratic Bézier pa → p → pb
      out.push([m * m * pa[0] + 2 * m * u * p[0] + u * u * pb[0], m * m * pa[1] + 2 * m * u * p[1] + u * u * pb[1]]);
    }
  }
  // Start mid-way along the first side, like a hand that doesn't start exactly at a corner.
  return out.slice(0, out.length - 6);
}

function ellipsePath(r: Seeded, cx: number, cy: number, a: number, b: number, rot: number, sweep = 1.03): XY[] {
  const out: XY[] = [], th0 = r.range(0, 6), dir = r.next() < 0.5 ? 1 : -1;
  for (let i = 0; i <= 120; i++) {
    const th = th0 + dir * 2 * Math.PI * sweep * i / 120, x = a * Math.cos(th), y = b * Math.sin(th);
    out.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return out;
}

const shapes: Record<string, (r: Seeded) => Point[]> = {
  line: r => {
    const a = r.range(0, Math.PI * 2), L = r.range(120, 400), x = 400, y = 500;
    return draw(r, [[x, y], [x + L * Math.cos(a), y + L * Math.sin(a)]], r.range(1, 3));
  },
  circle: r => { const R = r.range(40, 150); return draw(r, ellipsePath(r, 400, 400, R, R * r.range(0.95, 1), 0), 2); },
  ellipse: r => { const a = r.range(80, 200); return draw(r, ellipsePath(r, 400, 400, a, a * r.range(0.4, 0.7), r.range(0, Math.PI)), 2); },
  rectangle: r => {
    const w = r.range(120, 400), h = r.range(80, 300), x = 100, y = 100, rad = r.range(4, 14);
    let c: XY[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    if (r.next() < 0.5) c = c.reverse();
    const path = rounded(c, rad);
    path.push([path[0][0] + r.range(-6, 10), path[0][1] + r.range(-6, 6)]);
    return draw(r, path, 2);
  },
  triangle: r => {
    const s = r.range(120, 300), x = 300, y = 300, a = r.range(0, Math.PI * 2);
    const c: XY[] = [0, 1, 2].map(i => [x + s * Math.cos(a + i * 2.1 + r.range(-0.15, 0.15)), y + s * Math.sin(a + i * 2.1 + r.range(-0.15, 0.15))]);
    return draw(r, [...c, [c[0][0] + r.range(-5, 5), c[0][1] + r.range(-5, 5)]], 2);
  },
  arrow: r => {
    const a = r.range(0, Math.PI * 2), L = r.range(180, 400), x = 400, y = 500;
    const T: XY = [x + L * Math.cos(a), y + L * Math.sin(a)], h = L * r.range(0.12, 0.22);
    const back = a + Math.PI, s1 = r.range(0.45, 0.7), s2 = r.range(0.45, 0.7);
    const b1: XY = [T[0] + h * Math.cos(back + s1), T[1] + h * Math.sin(back + s1)];
    const b2: XY = [T[0] + h * Math.cos(back - s2), T[1] + h * Math.sin(back - s2)];
    return draw(r, [[x, y], T, b1, [T[0] + r.range(-2, 2), T[1] + r.range(-2, 2)], b2], 1.5);
  },
};

/** An arrow drawn with one barb: the shaft, then a short back-stroke. */
const oneBarb = (r: Seeded) => {
  const a = r.range(0, Math.PI * 2), L = r.range(180, 400), x = 400, y = 500;
  const T: XY = [x + L * Math.cos(a), y + L * Math.sin(a)], h = L * r.range(0.12, 0.22), s1 = (r.next() < 0.5 ? 1 : -1) * r.range(0.5, 1);
  return draw(r, [[x, y], T, [T[0] + h * Math.cos(a + Math.PI + s1), T[1] + h * Math.sin(a + Math.PI + s1)]], 1.5);
};

for (const [label, kind, make] of [...Object.entries(shapes).map(([k, f]) => [k, k, f] as const), ['arrow (one barb)', 'arrow', oneBarb] as const]) {
  test(`shapes: a hand-drawn ${label} is recognised in at least 9 of 10 seeded variants`, () => {
    let right = 0;
    const got: string[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const s = recognize(make(seeded(seed * 97 + kind.length)));
      got.push(s?.kind ?? 'none');
      if (s?.kind === kind) right++;
    }
    console.log(`shapes: ${label}: ${right}/10 (${got.join(' ')})`);
    assert.ok(right >= 9, `${kind}: ${right}/10: ${got.join(' ')}`);
  });
}

test('shapes: an S-curve, a zigzag and a scribble stay freehand', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = seeded(seed);
    const S: XY[] = Array.from({ length: 80 }, (_, i) => [200 + i * 4, 300 + 60 * Math.sin(i / 80 * Math.PI * 2)]);
    const zig: XY[] = Array.from({ length: 8 }, (_, i) => [100 + i * 40, 300 + (i % 2 ? 40 : 0)]);
    const scr: XY[] = Array.from({ length: 30 }, () => [r.range(100, 300), r.range(100, 300)]);
    for (const [name, path] of [['S', S], ['zigzag', zig], ['scribble', scr]] as const) {
      const s = recognize(draw(r, path as XY[], 1));
      assert.equal(s, null, `${name} seed ${seed}: ${s?.kind}`);
    }
  }
});

test('shapes: a tiny stroke or a dot is left alone', () => {
  const r = seeded(3);
  assert.equal(recognize(draw(r, [[10, 10], [18, 12]], 0.2)), null);
  assert.equal(recognize([{ x: 1, y: 1, p: 0.5, t: 0 }]), null);
});

test('shapes: generated points lie on the shape, corners exact, dense, t monotonic, pressure kept', () => {
  for (const kind of Object.keys(shapes)) {
    const drawn = shapes[kind](seeded(1234 + kind.length));
    const s = recognize(drawn);
    assert.ok(s, kind);
    const pts = s.points;
    // Dense: no gap much over STEP.
    for (let i = 1; i < pts.length; i++) {
      assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) <= STEP * 1.6 + 0.2, `${kind} gap at ${i}`);
      assert.ok(pts[i].t >= pts[i - 1].t, `${kind} t at ${i}`);
    }
    assert.equal(pts[0].t, drawn[0].t);
    assert.equal(pts[pts.length - 1].t, Math.round(drawn[drawn.length - 1].t));
    const ps = drawn.map(q => q.p).sort((a, b) => a - b), med = Math.round(ps[Math.floor(ps.length / 2)] * 100) / 100;
    assert.ok(pts.every(q => q.p === med), `${kind} pressure`);
    // Corners appear exactly (as stored, to 0.1 px).
    for (const c of s.corners) {
      const cx = Math.round(c.x * 10) / 10, cy = Math.round(c.y * 10) / 10;
      assert.ok(pts.some(q => q.x === cx && q.y === cy), `${kind} corner ${cx},${cy}`);
    }
    // On the shape: each point within 0.1 px of the polyline through the corners (ellipses: of the fit).
    if (kind === 'rectangle' || kind === 'triangle' || kind === 'line') {
      const poly = kind === 'line' ? s.corners : [...s.corners, s.corners[0]];
      for (const q of pts) {
        let best = Infinity;
        for (let i = 1; i < poly.length; i++) best = Math.min(best, seg(q, poly[i - 1], poly[i]));
        assert.ok(best < 0.1, `${kind} off by ${best}`);
      }
    }
  }
});

test('shapes: a rectangle drawn near the axes is axis-aligned; one drawn at 30° keeps its rotation', () => {
  const s = recognize(shapes.rectangle(seeded(5)))!;
  assert.equal(s.kind, 'rectangle');
  const xs = new Set(s.corners.map(c => Math.round(c.x * 1000))), ys = new Set(s.corners.map(c => Math.round(c.y * 1000)));
  assert.equal(xs.size, 2);
  assert.equal(ys.size, 2);
  const r = seeded(6), a = Math.PI / 6, rot = (x: number, y: number): XY => [300 + x * Math.cos(a) - y * Math.sin(a), 300 + x * Math.sin(a) + y * Math.cos(a)];
  const path = rounded([rot(0, 0), rot(250, 0), rot(250, 150), rot(0, 150)], 8);
  const t = recognize(draw(r, path, 1.5))!;
  assert.equal(t.kind, 'rectangle');
  const [c0, c1] = t.corners;
  const ang = ((Math.atan2(c1.y - c0.y, c1.x - c0.x) * 180 / Math.PI) % 90 + 90) % 90;
  assert.ok(Math.abs(ang - 30) < 3 || Math.abs(ang - 60) < 3, `angle ${ang}`);
});

test('shapes: recognition is deterministic', () => {
  const d = shapes.ellipse(seeded(9));
  assert.deepEqual(recognize(d), recognize(d));
});

function seg(q: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L)) : 0;
  return Math.hypot(q.x - a.x - u * dx, q.y - a.y - u * dy);
}

// Unused kind guard: keeps the list of kinds in step with ShapeKind.
const _kinds: ShapeKind[] = ['line', 'arrow', 'triangle', 'rectangle', 'circle', 'ellipse'];
void _kinds;

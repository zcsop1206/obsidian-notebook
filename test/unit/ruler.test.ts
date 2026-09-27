// The ruler (#20): its geometry (ruler.ts) and ruled sampling in input.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSamples, newTrace, type PageMap, type Sample } from '../../src/ink/input';
import {
  angleOf, direction, distanceTo, edges, formatLength, halfLength, lineAngleDiff, maxAngularError, moveRuler, nearestEdge, normAngle,
  fmtAngle, parseAngle, projectOnto, PX_PER_CM, PX_PER_IN, RULER_WIDTH, rotateRuler, snapAngle, tickStep,
} from '../../src/ink/ruler';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('ruler: angles normalise to [0, 360) and snap to 15° within 2°', () => {
  near(normAngle(-30), 330);
  near(normAngle(720), 0);
  near(normAngle(359.9999999999999), 0);
  near(snapAngle(31.9), 30);
  near(snapAngle(28), 30);
  near(snapAngle(27.9), 27.9);
  near(snapAngle(32.1), 32.1);
  near(snapAngle(-1.5), 0);
  near(snapAngle(358.5), 0);
  near(snapAngle(44), 45);
  near(snapAngle(52.5), 52.5);
});

test('ruler: typed angles', () => {
  assert.equal(parseAngle('30'), 30);
  assert.equal(parseAngle(' 12.5° '), 12.5);
  assert.equal(parseAngle('360'), 0);
  assert.equal(parseAngle('0'), 0);
  assert.equal(parseAngle('-5'), null);
  assert.equal(parseAngle('361'), null);
  assert.equal(parseAngle('abc'), null);
  assert.equal(parseAngle(''), null);
  assert.equal(fmtAngle(30), '30');
  assert.equal(fmtAngle(12.34), '12.3');
  assert.equal(fmtAngle(359.97), '0');
});

test('ruler: direction is counter-clockwise on screen (page y points down)', () => {
  const d = direction(30);
  near(d.x, Math.cos(Math.PI / 6));
  near(d.y, -0.5);
  near(angleOf([{ x: 0, y: 0 }, { x: d.x * 100, y: d.y * 100 }]), 30, 1e-9);
  near(angleOf([{ x: 0, y: 0 }, { x: 0, y: 100 }]), 270);
});

test('ruler: two edges at ±width/2; projection lands on the line; the nearer edge within reach', () => {
  const r = { cx: 400, cy: 500, angle: 30 };
  const [a, b] = edges(r);
  near(distanceTo({ x: r.cx, y: r.cy }, a), RULER_WIDTH / 2, 1e-9);
  near(distanceTo({ x: r.cx, y: r.cy }, b), RULER_WIDTH / 2, 1e-9);
  near(distanceTo({ x: a.x, y: a.y }, b), RULER_WIDTH, 1e-9);
  const p = { x: 123, y: 456 }, q = projectOnto(p, a);
  near(distanceTo(q, a), 0, 1e-9);
  // p − q is perpendicular to the edge.
  near((p.x - q.x) * a.dx + (p.y - q.y) * a.dy, 0, 1e-9);
  // 10 px outside edge a, beyond the centre line from b.
  const n = { x: a.x - r.cx, y: a.y - r.cy }, k = (RULER_WIDTH / 2 + 10) / (RULER_WIDTH / 2);
  const out = { x: r.cx + n.x * k, y: r.cy + n.y * k };
  assert.deepEqual(nearestEdge(r, out, 20), a);
  assert.equal(nearestEdge(r, out, 5), null);
  // Just inside edge b.
  const inB = { x: b.x + (r.cx - b.x) * 0.1, y: b.y + (r.cy - b.y) * 0.1 };
  assert.deepEqual(nearestEdge(r, inB, 20), b);
  // 40 px away: nothing.
  const k40 = (RULER_WIDTH / 2 + 40) / (RULER_WIDTH / 2);
  assert.equal(nearestEdge(r, { x: r.cx + n.x * k40, y: r.cy + n.y * k40 }, 20), null);
});

test('ruler: the length crosses any page', () => {
  near(halfLength({ width: 816, height: 1056 }), Math.hypot(816, 1056));
});

test('ruler: one finger moves it; two fingers turn it around their centroid, snapped', () => {
  const r = { cx: 400, cy: 500, angle: 0 };
  assert.deepEqual(moveRuler(r, { x: 10, y: 10 }, { x: 30, y: 5 }), { cx: 420, cy: 495, angle: 0 });
  // Fingers either side of the centre; turned 28° counter-clockwise on screen: snaps to 30.
  const at = (deg: number, c = { x: 400, y: 500 }): [{ x: number; y: number }, { x: number; y: number }] => {
    const d = direction(deg);
    return [{ x: c.x - d.x * 100, y: c.y - d.y * 100 }, { x: c.x + d.x * 100, y: c.y + d.y * 100 }];
  };
  let t = rotateRuler(r, at(0), at(28));
  near(t.angle, 30, 1e-9);
  near(t.cx, 400, 1e-9);
  near(t.cy, 500, 1e-9);
  t = rotateRuler(r, at(0), at(22));
  near(t.angle, 22, 1e-9);
  // Clockwise.
  t = rotateRuler(r, at(0), at(-50));
  near(t.angle, 310, 1e-9);
  // Unsnapped.
  t = rotateRuler(r, at(0), at(29), false);
  near(t.angle, 29, 1e-9);
  // Turning around a centroid away from the centre moves the centre; the fingers also move.
  const off = { cx: 500, cy: 500, angle: 0 };
  t = rotateRuler(off, at(0, { x: 400, y: 500 }), at(90, { x: 410, y: 520 }));
  near(t.angle, 90, 1e-9);
  // The centre was 100 px right of the centroid; turned 90° counter-clockwise it's 100 px above it.
  near(t.cx, 410, 1e-9);
  near(t.cy, 420, 1e-9);
  // The snap turns the centre too: the ruler stays under the fingers.
  t = rotateRuler(off, at(0), at(14));
  near(t.angle, 15, 1e-9);
  const d15 = direction(15);
  near(t.cx, 400 + d15.x * 100, 1e-9);
  near(t.cy, 500 + d15.y * 100, 1e-9);
});

test('ruler: lengths at 96 px per inch', () => {
  near(PX_PER_CM, 37.79527559055118, 1e-9);
  assert.equal(formatLength(10 * PX_PER_CM, 'cm'), '10.0 cm');
  assert.equal(formatLength(96 * 3.5, 'in'), '3.50 in');
  assert.equal(formatLength(377.95, 'cm'), '10.0 cm');
  assert.equal(formatLength(0, 'in'), '0.00 in');
  near(tickStep('cm').step, PX_PER_CM / 2, 1e-12);
  near(tickStep('in').step, PX_PER_IN / 4, 1e-12);
});

test('ruler: angle differences between lines ignore direction', () => {
  near(lineAngleDiff(30, 210), 0, 1e-9);
  near(lineAngleDiff(30, 29.9), 0.1, 1e-9);
  near(lineAngleDiff(1, 179), 2, 1e-9);
});

// A pen drag from `from` to `to` (client px) sampled every 2 px with jitter, through the map.
function drag(map: PageMap, from: [number, number], to: [number, number], jitter: number, seed = 1): ReturnType<typeof newTrace> {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const n = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2);
  const samples: Sample[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    samples.push({ clientX: from[0] + (to[0] - from[0]) * u + rnd() * jitter, clientY: from[1] + (to[1] - from[1]) * u + rnd() * jitter,
      pressure: 0.2 + 0.6 * u, pointerType: 'pen', timeStamp: 1000 + i * 2 });
  }
  const trace = newTrace();
  addSamples(trace, samples, map);
  return trace;
}

test('ruler: ruled samples lie on the edge at 30° ± 0.1° at 50%, 100% and 400%, with pressure and times kept', () => {
  const r = { cx: 408, cy: 528, angle: 30 };
  for (const zoom of [0.5, 1, 4]) {
    const k = 1.1 * zoom; // CSS px per page px (a fitted scale times the zoom)
    const [edge] = edges(r);
    const map: PageMap = { left: 50, top: 80, sx: 1 / k, sy: 1 / k, t0: 1000, edge };
    const d = direction(30);
    // From 8 px (CSS) off the edge, 300 page px along it, with 3 CSS px of hand wobble.
    const start = { x: edge.x - d.x * 150, y: edge.y - d.y * 150 }, end = { x: edge.x + d.x * 150, y: edge.y + d.y * 150 };
    const cl = (p: { x: number; y: number }, off: number): [number, number] => [50 + p.x * k - edge.dy * off, 80 + p.y * k + edge.dx * off];
    const trace = drag(map, cl(start, 8), cl(end, -6), 3, zoom * 7);
    const pts = trace.points;
    assert.ok(pts.length > 50, `${pts.length} points`);
    const err = maxAngularError(pts, 30);
    assert.ok(err <= 0.1, `zoom ${zoom}: ${err}°`);
    near(lineAngleDiff(angleOf(pts), 30), 0, 0.1);
    // Every point within rounding of the edge.
    for (const p of pts) assert.ok(distanceTo(p, edge) <= 0.08, `${distanceTo(p, edge)}`);
    assert.ok(new Set(pts.map(p => p.p)).size > 10, 'pressure kept');
    assert.equal(pts[0].t, 0);
    assert.ok(pts.every((p, i) => i === 0 || p.t >= pts[i - 1].t));
    console.log(`ruler: zoom ${zoom}: max angular error ${err.toFixed(4)}° over ${pts.length} points`);
  }
});

test('ruler: a 10 cm ruled line measures 10 cm ± 0.5 mm', () => {
  const r = { cx: 400, cy: 500, angle: 30 };
  const [edge] = edges(r);
  const map: PageMap = { left: 0, top: 0, sx: 1, sy: 1, t0: 0, edge };
  const d = direction(30), L = 10 * PX_PER_CM;
  const trace = drag(map, [edge.x, edge.y], [edge.x + d.x * L, edge.y + d.y * L], 1.5);
  const pts = trace.points, a = pts[0], b = pts[pts.length - 1];
  const mm = Math.hypot(b.x - a.x, b.y - a.y) / PX_PER_CM * 10;
  assert.ok(Math.abs(mm - 100) <= 0.5, `${mm} mm`);
});

test('ruler: without an edge, sampling is unchanged', () => {
  const map: PageMap = { left: 0, top: 0, sx: 1, sy: 1, t0: 0 };
  const trace = drag(map, [10, 10], [200, 60], 3);
  assert.ok(maxAngularError(trace.points, angleOf(trace.points), 20) > 0.1, 'a wobbly line stays wobbly');
});

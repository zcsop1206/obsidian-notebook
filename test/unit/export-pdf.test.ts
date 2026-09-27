// Export as PDF (#18), the pure parts: quadratic-to-cubic conversion (exact), SVG paths to PDF
// operators, colours, the page transform and size, templates, and a note built into a PDF.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strokePath } from '../../src/format/outline';
import { newPage, type Page } from '../../src/format/page';
import {
  arcToCubics, buildPdf, pageSizePt, pageTransform, pathOps, pdfColor, pdfPath, quadToCubic, strokeOps, templateOps,
} from '../../src/ink/export-pdf';
import { fakeJpeg } from './pdf-writer.test';

const bez = (p0: number[], c1: number[], c2: number[], p3: number[], t: number) => [0, 1].map(k =>
  (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * c1[k] + 3 * (1 - t) * t * t * c2[k] + t ** 3 * p3[k]);
const quad = (p0: number[], q: number[], p2: number[], t: number) => [0, 1].map(k => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * q[k] + t * t * p2[k]);

test('export: Q to C is exact (the cubic traces the quadratic)', () => {
  const p0: [number, number] = [10, 20], q: [number, number] = [40, -5], p2: [number, number] = [70, 30];
  const [c1, c2] = quadToCubic(p0, q, p2);
  const close = (a: number[], b: number[]) => a.every((v, k) => Math.abs(v - b[k]) < 1e-12);
  assert.ok(close(c1, [30, 10 / 3]) && close(c2, [50, 20 / 3]), `${c1} ${c2}`);
  for (let t = 0; t <= 1; t += 0.125) {
    const a = bez(p0, c1, c2, p2, t), b = quad(p0, q, p2, t);
    assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `t ${t}`);
  }
});

test('export: SVG path to PDF operators', () => {
  assert.equal(pathOps('M1 2L3 4H5V6Z'), '1 2 m\n3 4 l\n5 4 l\n5 6 l\nh');
  assert.equal(pathOps('M0 0Q3 3 6 0Z'), '0 0 m\n2 2 4 2 6 0 c\nh');
  // A dot (two semicircle arcs) becomes 4 quarter-circle cubics that stay on the circle.
  const ops = pathOps('M9 10A1 1 0 1 0 11 10A1 1 0 1 0 9 10Z').split('\n');
  assert.equal(ops.filter(o => o.endsWith(' c')).length, 4);
  for (const o of ops.filter(o => o.endsWith(' c'))) {
    const n = o.split(' ').slice(4, 6).map(Number);
    assert.ok(Math.abs(Math.hypot(n[0] - 10, n[1] - 10) - 1) < 1e-3, o);
  }
  const [seg] = arcToCubics([1, 0], 1, 1, false, true, [0, 1]);
  const mid = bez([1, 0], seg[0], seg[1], seg[2], 0.5);
  assert.ok(Math.abs(Math.hypot(mid[0], mid[1]) - 1) < 3e-4);
});

test('export: a pen stroke is its saved outline, filled; default ink black, others their colour', () => {
  const s = { id: 'aaaaaaaa', tool: 'pen' as const, nib: 'uniform' as const, color: '#000000', size: 3,
    points: [0, 1, 2, 3, 4, 5].map(i => ({ x: 100 + i * 10, y: 100 + (i % 2) * 5, p: 0.5, t: i * 8 })) };
  const ops = strokeOps(s);
  assert.ok(ops.startsWith('0 0 0 rg\n') && ops.endsWith('\nf\n'));
  const qs = (strokePath(s).match(/Q/g) ?? []).length;
  assert.equal((ops.match(/ c$/gm) ?? []).length, qs);
  assert.ok(strokeOps({ ...s, color: '#1e5bd8' }).startsWith('0.118 0.357 0.847 rg'));
  assert.equal(pdfColor('#ffffff'), '1 1 1');
  assert.equal(pdfColor('#c9c9c9'), '0.788 0.788 0.788');
});

test('export: page size and transform (px to pt, y flipped)', () => {
  assert.deepEqual(pageSizePt({ width: 816, height: 1056 }), { width: 612, height: 792 });
  assert.deepEqual(pageSizePt({ width: 288, height: 288 }), { width: 216, height: 216 });
  assert.equal(pageTransform(1056), '0.75 0 0 -0.75 0 792 cm');
});

test('export: templates as vector paths, with renderTemplate geometry', () => {
  const size = { width: 816, height: 1056 };
  const lined = templateOps({ kind: 'lined', rule: 'college', margin: true }, size);
  assert.equal((lined.match(/ m /g) ?? []).length, Math.ceil((1056 - 96) / 27) + 1);
  assert.ok(lined.includes('0 96 m 816 96 l') && lined.includes('0.91 0.627 0.627 RG 1 w 120 0 m 120 1056 l S'));
  assert.match(templateOps({ kind: 'fill', color: '#fff59d' }, { width: 288, height: 288 }), /^1 0\.961 0\.616 rg 0 0 288 288 re f/);
  assert.ok(templateOps({ kind: 'dots', spacing: '5mm' }, size).includes('18.9 18.9 m 18.9 18.9 l'));
  assert.equal(templateOps({ kind: 'blank' }, size), '');
});

test('export: pdf path next to the note, numbered when taken', () => {
  const taken = new Set(['School/Waves.pdf', 'School/Waves 1.pdf']);
  assert.equal(pdfPath('School', 'Waves', p => taken.has(p)), 'School/Waves 2.pdf');
  assert.equal(pdfPath('', 'Waves', p => taken.has(p)), 'Waves.pdf');
});

test('export: a note builds into a PDF with a page each, images deduplicated', async () => {
  const img = 'data:image/jpeg;base64,AAAA';
  const a: Page = { ...newPage('p-000001'), template: { kind: 'image', image: img }, strokes: [
    { id: 'aaaaaaaa', tool: 'highlighter', color: '#ffeb3b', size: 12, points: [{ x: 10, y: 10, p: 0.5, t: 0 }, { x: 90, y: 10, p: 0.5, t: 9 }] },
  ] };
  const b: Page = { ...newPage('p-000002', { width: 288, height: 288 }), images: [{ id: 'i-000001', x: 5, y: 5, width: 50, height: 40, data: img }] };
  const calls: string[] = [];
  const bytes = await buildPdf([a, b, { size: { width: 100, height: 100 } }], 'T', {
    compress: false, yieldFn: async () => {}, jpeg: async d => { calls.push(d); return fakeJpeg(8, 8); } });
  let s = ''; for (const c of bytes) s += String.fromCharCode(c);
  assert.equal(calls.length, 1);
  assert.equal((s.match(/\/Subtype \/Image/g) ?? []).length, 1);
  assert.match(s, /\/Count 3 >>/);
  assert.match(s, /\/MediaBox \[0 0 216 216\]/);
  assert.match(s, /\/MediaBox \[0 0 75 75\]/);
  assert.match(s, /q 50 0 0 -40 5 45 cm \/Im0 Do Q/);
  assert.match(s, /q \/Ha gs \/Hl Do Q/);
});

// The sample note in test/fixtures/: three Letter pages drawn with handwriting-like curves from
// a seeded generator, so the output is reproducible. `npm run fixture` writes it; a unit test
// regenerates it in memory and checks it matches the committed files byte for byte.
import { newPageId, newStrokeId } from '../src/format/ids';
import { readNote, writeNote } from '../src/format/note';
import { DEFAULT_INK, LETTER, newPage, writePage, type Nib, type Page, type Point } from '../src/format/page';
import { seeded, type Seeded } from './seeded';

export const FIXTURE_NAME = 'sample';

const BLUE = '#1e5bd8';
const RED = '#d0312d';
const YELLOW = '#ffd400';
const PINK = '#ff5fa2';
const GREEN = '#3ddc84';

const TAU = 2 * Math.PI;

/** A cursive-looking word: a prolate cycloid whose loops vary per letter, slanted, with pressure. */
function cursive(r: Seeded, x0: number, base: number, letters: number): { points: Point[]; dots: [number, number][] } {
  const a = 2.1;
  const shape = Array.from({ length: letters }, () => {
    const k = r.next();
    if (k < 0.2) return { h: r.range(26, 33), loop: r.range(1.7, 2.1), dot: false }; // l, h, k
    if (k < 0.35) return { h: r.range(9, 12), loop: r.range(0.5, 0.8), dot: true }; // i
    return { h: r.range(10, 15), loop: r.range(0.6, 1.5), dot: false }; // e, u, n, …
  });
  const phase = r.range(0, TAU);
  const points: Point[] = [];
  const dots: [number, number][] = [];
  let t = 0;
  const end = Math.PI + letters * TAU;
  for (let s = Math.PI; s <= end; s += 0.11) {
    const i = Math.min(letters - 1, Math.floor((s - Math.PI) / TAU));
    const { h, loop } = shape[i];
    const y = base - h * (1 + Math.cos(s)) / 2;
    const x = x0 + a * s - a * loop * Math.sin(s) + 0.25 * (base - y);
    const ramp = Math.min(1, points.length / 6);
    const p = (0.5 + 0.2 * Math.sin(s * 0.45 + phase)) * (0.5 + 0.5 * ramp) + r.range(-0.02, 0.02);
    points.push({ x: x + r.range(-0.15, 0.15), y: y + r.range(-0.15, 0.15), p, t });
    t += r.range(3.6, 4.8);
  }
  shape.forEach((sh, i) => {
    if (sh.dot) dots.push([x0 + a * (Math.PI + (i + 0.5) * TAU) + 6, base - 22]);
  });
  return { points, dots };
}

/** A nearly straight stroke from (x0, y0) to (x1, y1) with a slight wobble. */
function line(r: Seeded, x0: number, y0: number, x1: number, y1: number, wobble = 1.2): Point[] {
  const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / 3));
  const phase = r.range(0, TAU);
  const points: Point[] = [];
  let t = 0;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    points.push({
      x: x0 + (x1 - x0) * f,
      y: y0 + (y1 - y0) * f + wobble * Math.sin(f * 5 + phase),
      p: 0.5 + 0.1 * Math.sin(f * 7 + phase),
      t,
    });
    t += r.range(3.6, 4.8);
  }
  return points;
}

/** A hand-drawn ellipse around (cx, cy), overshooting its start a little. */
function ellipse(r: Seeded, cx: number, cy: number, rx: number, ry: number): Point[] {
  const points: Point[] = [];
  let t = 0;
  const start = r.range(0, TAU);
  for (let u = 0; u <= TAU * 1.08; u += 0.06) {
    const k = 1 + 0.04 * Math.sin(u * 3);
    points.push({ x: cx + rx * k * Math.cos(start + u), y: cy + ry * k * Math.sin(start + u), p: 0.55 + 0.15 * Math.sin(u), t });
    t += r.range(3.6, 4.8);
  }
  return points;
}

class PageBuilder {
  page: Page;
  constructor(private r: Seeded, id: string) {
    this.page = newPage(id, LETTER);
  }
  private nextId() {
    return newStrokeId(this.page.strokes.map(s => s.id), this.r.bytes);
  }
  pen(nib: Nib, color: string, size: number, points: Point[]) {
    this.page.strokes.push({ id: this.nextId(), tool: 'pen', nib, color, size, points });
  }
  highlight(color: string, size: number, points: Point[]) {
    this.page.strokes.push({ id: this.nextId(), tool: 'highlighter', color, size, points });
  }
  /** Words across a line starting at x0, returning where each word started and ended. */
  write(nib: Nib, color: string, x0: number, x1: number, base: number, size = 2.2): [number, number][] {
    const spans: [number, number][] = [];
    let x = x0;
    for (;;) {
      const letters = 2 + Math.floor(this.r.next() * 6);
      const width = letters * TAU * 2.1 + 10;
      if (x + width > x1) break;
      const w = cursive(this.r, x, base, letters);
      this.pen(nib, color, size, w.points);
      for (const [dx, dy] of w.dots) this.pen(nib, color, size, [{ x: dx, y: dy, p: 0.6, t: 0 }]);
      spans.push([x, x + width]);
      x += width + this.r.range(14, 22);
    }
    return spans;
  }
}

/**
 * A Letter page densely covered in handwriting: `count` strokes of cursive words (and i dots)
 * in the default ink, row after row. For the ink view's large-note test.
 */
export function densePage(r: Seeded, id: string, count: number): Page {
  const b = new PageBuilder(r, id);
  for (let pass = 0; b.page.strokes.length < count; pass++) {
    for (let base = 60 + pass * 11; base < LETTER.height - 30 && b.page.strokes.length < count; base += 34) {
      b.write(pass % 2 ? 'pressure' : 'uniform', DEFAULT_INK, 48 + pass * 7, 768, base);
    }
  }
  b.page.strokes.length = count;
  return b.page;
}

/** The fixture's files, keyed by path relative to test/fixtures/. */
export function buildFixture(): Map<string, string> {
  const r = seeded(20260926);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(newPageId(ids, r.bytes));

  // Page 1: pen strokes in the default black and two other colours, with i dots. The top half
  // uses the uniform nib, the bottom half the pressure nib.
  const p1 = new PageBuilder(r, ids[0]);
  const rows = [120, 176, 232, 288, 344, 400, 456, 512, 568, 624];
  rows.forEach((base, k) => {
    const nib: Nib = k < 5 ? 'uniform' : 'pressure';
    const color = k === 2 || k === 7 ? BLUE : k === 4 || k === 9 ? RED : DEFAULT_INK;
    const spans = p1.write(nib, color, 72, 744, base);
    if (k === 0 && spans.length) p1.pen('uniform', BLUE, 2.2, line(r, 72, base + 10, spans[spans.length - 1][1], base + 12));
    if (k === 6 && spans.length > 1) {
      const [a, b] = spans[1];
      p1.pen('pressure', RED, 3, ellipse(r, (a + b) / 2, base - 10, (b - a) / 2 + 12, 26));
    }
  });

  // Page 2: highlighter strokes crossing each other, under pen strokes.
  const p2 = new PageBuilder(r, ids[1]);
  p2.highlight(YELLOW, 20, line(r, 66, 142, 560, 142, 0.8));
  p2.highlight(PINK, 20, line(r, 66, 212, 480, 212, 0.8));
  p2.highlight(GREEN, 20, line(r, 120, 100, 460, 300, 1.5));
  p2.highlight(YELLOW, 20, line(r, 400, 90, 330, 330, 1.5));
  [150, 220, 290, 360].forEach((base, k) => p2.write(k % 2 ? 'pressure' : 'uniform', DEFAULT_INK, 72, 744, base));

  // Page 3: empty.
  const p3 = new PageBuilder(r, ids[2]);

  const files = new Map<string, string>();
  const note = readNote(
    '---\nink: 1\npaper: letter\ntemplate: blank\ntags: [fixture]\n---\n' +
    '# Sample ink note\n\nThe notebook-ink/1 test fixture, made by `npm run fixture` (test/fixture.ts).\n',
    FIXTURE_NAME,
  );
  note.pages = ids;
  files.set(`${FIXTURE_NAME}.md`, writeNote(note));
  for (const b of [p1, p2, p3]) files.set(`${FIXTURE_NAME}/${b.page.id}.svg`, writePage(b.page));
  return files;
}

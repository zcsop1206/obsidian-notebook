// A page's strokes in a uniform grid (#7), so the stroke eraser finds what it touches without
// looking at every stroke on a full page.
//
// The page is divided into CELL × CELL page px cells. A stroke is listed in every cell that
// any of its points, grown by the stroke's half width, overlaps; points off the page count in
// the nearest edge cell. A query (the eraser moving from a to b with radius r) looks at the
// cells overlapping the segment's box grown by r, and tests the points of the strokes listed
// there: a stroke is hit if any point is within r + its half width of the segment. The iPad
// Pencil samples densely (about 471 samples/s, a fraction of a px apart when writing), so
// testing points rather than the segments between them is enough.
//
// Allocation-light: no objects are created per query besides the ids pushed to `out`; each
// stroke keeps its box and two stamps that stop it being tested twice in one query.
import type { Size, Stroke } from '../format/page';

/** Cell size in page px. */
export const CELL = 32;

export interface XY {
  x: number;
  y: number;
}

/**
 * How far a stroke's ink reaches from its points: half its width, or for the pressure nib
 * (up to 1.25 × size wide at full pressure) a little more.
 */
export function halfWidth(s: Stroke): number {
  return s.tool === 'pen' && s.nib === 'pressure' ? s.size * 0.65 : s.size / 2;
}

interface Entry {
  id: string;
  points: readonly XY[];
  hw: number;
  /** The points' box grown by hw. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The cells listing this entry. */
  cells: number[];
  /** The query that hit it last. */
  hit: number;
  /** The segment that tested it last. */
  tested: number;
}

export class SpatialIndex {
  readonly cols: number;
  readonly rows: number;
  private cells: (Entry[] | undefined)[];
  private entries = new Map<string, Entry>();
  private queries = 0;
  private segments = 0;

  /** An index for a page of this size, holding `strokes`. */
  constructor(size: Size, strokes: Iterable<Stroke> = []) {
    this.cols = Math.max(1, Math.ceil(size.width / CELL));
    this.rows = Math.max(1, Math.ceil(size.height / CELL));
    this.cells = new Array(this.cols * this.rows);
    for (const s of strokes) this.add(s);
  }

  /** Strokes in the index. */
  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  private col(x: number): number {
    const c = Math.floor(x / CELL);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private row(y: number): number {
    const r = Math.floor(y / CELL);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  /** Adds a stroke (replacing one with the same id). */
  add(stroke: Stroke) {
    if (this.entries.has(stroke.id)) this.remove(stroke.id);
    const hw = halfWidth(stroke);
    const e: Entry = { id: stroke.id, points: stroke.points, hw, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, cells: [], hit: 0, tested: 0 };
    this.entries.set(stroke.id, e);
    const cols = this.cols, cells = this.cells;
    let pc0 = -1, pc1 = -1, pr0 = -1, pr1 = -1;
    for (const p of stroke.points) {
      if (p.x < e.x0) e.x0 = p.x;
      if (p.y < e.y0) e.y0 = p.y;
      if (p.x > e.x1) e.x1 = p.x;
      if (p.y > e.y1) e.y1 = p.y;
      const c0 = this.col(p.x - hw), c1 = this.col(p.x + hw), r0 = this.row(p.y - hw), r1 = this.row(p.y + hw);
      if (c0 === pc0 && c1 === pc1 && r0 === pr0 && r1 === pr1) continue; // same cells as the last point
      pc0 = c0; pc1 = c1; pr0 = r0; pr1 = r1;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = r * cols + c;
          const cell = cells[k];
          // Strokes are added one at a time, so if this one is in the cell it's the last entry.
          if (cell && cell[cell.length - 1] === e) continue;
          if (cell) cell.push(e);
          else cells[k] = [e];
          e.cells.push(k);
        }
      }
    }
    e.x0 -= hw;
    e.y0 -= hw;
    e.x1 += hw;
    e.y1 += hw;
  }

  /** Removes a stroke; returns whether it was there. */
  remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    for (const k of e.cells) {
      const cell = this.cells[k]!;
      const i = cell.indexOf(e);
      const last = cell.pop()!;
      if (last !== e) cell[i] = last;
    }
    return true;
  }

  /**
   * The ids of the strokes with a point within `radius` + the stroke's half width of the
   * segment a→b (a point if a is b), appended to `out`.
   */
  hit(a: XY, b: XY, radius: number, out: string[] = []): string[] {
    this.queries++;
    this.segment(a.x, a.y, b.x, b.y, radius, out);
    return out;
  }

  /**
   * The ids of the strokes the polyline `path` touches (as `hit` for each segment, each id
   * once), appended to `out`. A single point is tested on its own.
   */
  hitPath(path: readonly XY[], radius: number, out: string[] = []): string[] {
    if (!path.length) return out;
    this.queries++;
    if (path.length === 1) this.segment(path[0].x, path[0].y, path[0].x, path[0].y, radius, out);
    for (let i = 1; i < path.length; i++) this.segment(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y, radius, out);
    return out;
  }

  private segment(ax: number, ay: number, bx: number, by: number, radius: number, out: string[]) {
    const q = this.queries, s = ++this.segments;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const sx0 = Math.min(ax, bx) - radius, sx1 = Math.max(ax, bx) + radius;
    const sy0 = Math.min(ay, by) - radius, sy1 = Math.max(ay, by) + radius;
    const c0 = this.col(sx0), c1 = this.col(sx1), r0 = this.row(sy0), r1 = this.row(sy1);
    const cols = this.cols, cells = this.cells;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = cells[r * cols + c];
        if (!cell) continue;
        for (let j = 0; j < cell.length; j++) {
          const e = cell[j];
          if (e.hit === q || e.tested === s) continue;
          e.tested = s;
          // The segment's box grown by radius misses the stroke's box grown by hw: no point is near.
          if (sx1 < e.x0 || sx0 > e.x1 || sy1 < e.y0 || sy0 > e.y1) continue;
          const reach = radius + e.hw, reach2 = reach * reach, pts = e.points;
          for (let i = 0; i < pts.length; i++) {
            const px = pts[i].x - ax, py = pts[i].y - ay;
            let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = px - t * dx, ey = py - t * dy;
            if (ex * ex + ey * ey <= reach2) {
              e.hit = q;
              out.push(e.id);
              break;
            }
          }
        }
      }
    }
  }
}

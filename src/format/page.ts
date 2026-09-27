// The page file: one SVG per page, holding the page's raw data as JSON in <metadata>
// (format notebook-ink/1) and the drawing generated from it. writePage is a pure function of
// the page model; readPage reads only the metadata and ignores the drawing.
import { isPageId, isStrokeId } from './ids';
import { fmt1, strokePath } from './outline';
import { parseTemplate, renderTemplate, type Size, type Template } from './template';

export type { Size } from './template';

export const FORMAT = 'notebook-ink/1';

/** Page sizes in CSS px at 96 px/in. */
export const LETTER: Readonly<Size> = Object.freeze({ width: 816, height: 1056 });
export const A4: Readonly<Size> = Object.freeze({ width: 794, height: 1123 });

export type Paper = 'letter' | 'a4';
export const PAPER_SIZES: Readonly<Record<Paper, Readonly<Size>>> = { letter: LETTER, a4: A4 };

/** The default ink colour. It's drawn near-black in light mode and near-white in dark mode. */
export const DEFAULT_INK = '#000000';

export type Tool = 'pen' | 'highlighter';
export const TOOLS: readonly Tool[] = ['pen', 'highlighter'];

/**
 * A pen stroke's nib: `uniform` draws the same width whatever the pressure, angle or speed;
 * `pressure` gets wider with pressure. Pressure is recorded either way. Add new nibs here, to
 * NIBS, and to the outline options in outline.ts.
 */
export type Nib = 'uniform' | 'pressure';
export const NIBS: readonly Nib[] = ['uniform', 'pressure'];

/** One sample. x and y in CSS px on the page, pressure 0..1, t in ms since the stroke's first point. */
export interface Point {
  x: number;
  y: number;
  p: number;
  t: number;
}

interface StrokeBase {
  /** 8 lowercase hex characters, unique within the page. */
  id: string;
  /** Lowercase `#rrggbb`. `#000000` is the default ink, which follows dark mode. */
  color: string;
  /** Width in CSS px, stored to 0.1 px (for the pressure nib, the width at pressure 0.5). */
  size: number;
  points: Point[];
}

export interface PenStroke extends StrokeBase {
  tool: 'pen';
  nib: Nib;
}

/** Always constant width; has no nib. */
export interface HighlighterStroke extends StrokeBase {
  tool: 'highlighter';
}

export type Stroke = PenStroke | HighlighterStroke;

export interface Page {
  /** `p-` and 6 lowercase hex characters; the file is `<id>.svg`. */
  id: string;
  /** In CSS px at 96 px/in. Stored per page, so a page can differ from its note's paper. */
  size: Size;
  template: Template;
  /** In drawing order. Highlighter strokes are drawn under all pen strokes. */
  strokes: Stroke[];
}

/** An empty page. */
export function newPage(id: string, size: Size = LETTER, template: Template = { kind: 'blank' }): Page {
  return { id, size: { width: size.width, height: size.height }, template, strokes: [] };
}

// ---- rounding

const round = (n: number, k: number) => Math.round(n * k) / k || 0; // `|| 0` turns -0 into 0
/** Coordinates and page sizes: 0.1 px. */
export const roundXY = (n: number) => round(n, 10);
/** Pressure: 0.01, clamped to 0..1. */
export const roundP = (n: number) => round(Math.min(1, Math.max(0, n)), 100);
/** Stroke width: 0.1 px, like coordinates. */
export const roundSize = roundXY;

/**
 * Points as stored: one flat array `[x, y, p, dt, x, y, p, dt, …]`, x and y rounded to 0.1 px,
 * p to 0.01, dt in whole ms since the previous point (0 for the first, never negative).
 */
export function encodePoints(points: readonly Point[]): number[] {
  const out: number[] = [];
  let prev = 0;
  points.forEach((pt, i) => {
    const t = Math.round(pt.t);
    const dt = i === 0 ? 0 : Math.max(0, t - prev);
    out.push(roundXY(pt.x), roundXY(pt.y), roundP(pt.p), dt || 0);
    prev = i === 0 ? t : Math.max(prev, t);
  });
  return out;
}

/** The inverse of encodePoints: t becomes ms since the first point. */
export function decodePoints(flat: readonly number[]): Point[] {
  const points: Point[] = [];
  let t = 0;
  for (let i = 0; i < flat.length; i += 4) {
    if (i > 0) t += Math.max(0, Math.round(flat[i + 3])) || 0;
    points.push({ x: roundXY(flat[i]), y: roundXY(flat[i + 1]), p: roundP(flat[i + 2]), t });
  }
  return points;
}

// ---- validation

const COLOR_RE = /^#[0-9a-f]{6}$/;

function fail(msg: string): never {
  throw new Error('Invalid ink page: ' + msg);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);

function checkSize(size: unknown): Size {
  const s = size as Size;
  if (typeof s !== 'object' || s === null || !isNum(s.width) || !isNum(s.height) || s.width <= 0 || s.height <= 0) {
    fail('size must be { width, height } with positive numbers');
  }
  return { width: roundXY(s.width), height: roundXY(s.height) };
}

/** A stroke's fields other than its points, validated and in canonical form. */
type StrokeHead = { id: string; tool: 'pen'; nib: Nib; color: string; size: number }
  | { id: string; tool: 'highlighter'; color: string; size: number };

function checkStroke(s: unknown, i: number, seen: Set<string>): StrokeHead {
  const st = s as { id?: unknown; tool?: unknown; nib?: unknown; color?: unknown; size?: unknown };
  if (typeof st !== 'object' || st === null) fail(`stroke ${i} is not an object`);
  if (typeof st.id !== 'string' || !isStrokeId(st.id)) fail(`stroke ${i} has an invalid id ${JSON.stringify(st.id)}`);
  const id = st.id;
  if (seen.has(id)) fail(`stroke id ${id} is used twice`);
  seen.add(id);
  const color = typeof st.color === 'string' ? st.color.toLowerCase() : '';
  if (!COLOR_RE.test(color)) fail(`stroke ${id} has an invalid colour ${JSON.stringify(st.color)} (expected #rrggbb)`);
  const size = isNum(st.size) ? roundSize(st.size) : 0;
  if (size <= 0) fail(`stroke ${id} has an invalid size ${JSON.stringify(st.size)} (at least 0.05 px)`);
  if (st.tool === 'pen') {
    if (!NIBS.includes(st.nib as Nib)) fail(`pen stroke ${id} has an unknown nib ${JSON.stringify(st.nib)} (expected ${NIBS.join(' or ')})`);
    return { id, tool: 'pen', nib: st.nib as Nib, color, size };
  }
  if (st.tool === 'highlighter') {
    if (st.nib !== undefined) fail(`highlighter stroke ${id} has a nib; only pen strokes do`);
    return { id, tool: 'highlighter', color, size };
  }
  return fail(`stroke ${id} has an unknown tool ${JSON.stringify(st.tool)}`);
}

// ---- writing

/** Default ink (`.i`, fill) and template lines (`.t`, stroke) follow dark mode. */
const STYLE =
  '<style>.i{fill:#1f1f1f}.t{stroke:#c9c9c9}' +
  '@media (prefers-color-scheme:dark){.i{fill:#e6e3de}.t{stroke:#3c3c3c}}</style>';

function layer(id: string, attrs: string, items: string[]): string {
  const open = `<g id="${id}"${attrs}>`;
  return items.length ? `${open}\n${items.join('\n')}\n</g>` : `${open}</g>`;
}

/**
 * The page's SVG file. Deterministic: the same page always gives the same bytes. Rounds
 * points as `encodePoints` does, and throws if the page is invalid.
 */
export function writePage(page: Page): string {
  if (typeof page.id !== 'string' || !isPageId(page.id)) fail(`invalid page id ${JSON.stringify(page.id)}`);
  const size = checkSize(page.size);
  const template = parseTemplate(page.template);
  const seen = new Set<string>();
  const strokes = page.strokes.map((s, i) => {
    const head = checkStroke(s, i, seen);
    if (!Array.isArray(s.points) || s.points.length === 0) fail(`stroke ${head.id} has no points`);
    for (const pt of s.points) {
      if (!isNum(pt.x) || !isNum(pt.y) || !isNum(pt.p) || !isNum(pt.t)) fail(`stroke ${head.id} has a non-numeric point`);
    }
    const flat = encodePoints(s.points);
    return { ...head, flat, points: decodePoints(flat) };
  });

  const json = (v: unknown) => JSON.stringify(v);
  const strokeJson = strokes.map(s =>
    `{"id":${json(s.id)},"tool":${json(s.tool)},` + (s.tool === 'pen' ? `"nib":${json(s.nib)},` : '') +
    `"color":${json(s.color)},"size":${json(s.size)},"points":${json(s.flat)}}`);
  const meta =
    `{"format":${json(FORMAT)},"id":${json(page.id)},"size":${json(size)},"template":${json(template)},"strokes":[` +
    (strokeJson.length ? '\n' + strokeJson.join(',\n') + '\n' : '') + ']}';

  const path = (s: Stroke) => {
    const paint = s.color === DEFAULT_INK ? 'class="i"' : `fill="${s.color}"`;
    return `<path data-id="${s.id}" ${paint} d="${strokePath(s)}"/>`;
  };
  const w = fmt1(size.width), h = fmt1(size.height);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    STYLE,
    // `]]>` could only occur inside a JSON string, where `>` may be escaped instead.
    `<metadata><![CDATA[${meta.replace(/]]>/g, ']]\\u003e')}]]></metadata>`,
    layer('template', '', renderTemplate(template, size)),
    // Highlighter paths are opaque and the layer is translucent, so crossing strokes don't darken.
    layer('highlight', ' opacity="0.4"', strokes.filter(s => s.tool === 'highlighter').map(path)),
    layer('ink', '', strokes.filter(s => s.tool === 'pen').map(path)),
    layer('objects', '', []),
    '</svg>',
    '',
  ].join('\n');
}

// ---- reading

/**
 * Reads a page from its SVG file. Only <metadata> is read; the drawing is regenerated by
 * writePage. Throws if the file isn't a notebook-ink/1 page or its data is invalid.
 */
export function readPage(svgText: string): Page {
  const m = /<metadata>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/metadata>/.exec(svgText);
  if (!m) throw new Error('Not an ink page: no <metadata> with page data');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new Error('Not an ink page: <metadata> is not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail('metadata is not an object');
  if (data.format !== FORMAT) {
    throw new Error(`Unsupported ink page format ${JSON.stringify(data.format)} (expected "${FORMAT}")`);
  }
  if (typeof data.id !== 'string' || !isPageId(data.id)) fail(`invalid page id ${JSON.stringify(data.id)}`);
  const size = checkSize(data.size);
  const template = parseTemplate(data.template);
  if (!Array.isArray(data.strokes)) fail('strokes must be an array');
  const seen = new Set<string>();
  const strokes: Stroke[] = data.strokes.map((s: unknown, i: number) => {
    const head = checkStroke(s, i, seen);
    const flat: unknown = (s as { points?: unknown }).points;
    if (!Array.isArray(flat) || flat.length === 0 || flat.length % 4 !== 0 || !flat.every(isNum)) {
      fail(`stroke ${head.id} points must be a non-empty flat array of [x, y, p, dt] numbers`);
    }
    return { ...head, points: decodePoints(flat) };
  });
  return { id: data.id, size, template, strokes };
}

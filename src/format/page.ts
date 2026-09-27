// The page file: one SVG per page, holding the page's raw data as JSON in <metadata>
// (format notebook-ink/1) and the drawing generated from it. writePage is a pure function of
// the page model; readPage reads only the metadata and ignores the drawing, with one exception:
// a pdf template's image (#14) is stored once, as the <image> of the <g id="template"> layer,
// not in the metadata, and readPage reads it back from there (see template.ts).
//
// Images (#12): a page's `images` are drawn in <g id="objects">, between the template and the
// highlight layer, as <image data-id="i-…" x y width height preserveAspectRatio="none"
// href="data:…">. Like a pdf template's image, the bytes are stored once, in the drawing: the
// metadata's `images` hold id, x, y, width and height, and readPage reads each image's data
// back from the <image> with its data-id. A stroke written on an image carries its id in `on`
// (the ink belongs to the image: it moves, scales and is deleted with it). A page without
// images writes `images` and `on` nowhere, and its objects layer stays the empty last layer,
// so pages written before #12 keep their bytes.
//
// Off-page coordinates (#35): a stroke belongs to the page it started on and may run off its
// edges and back. Its points are stored as they were sampled, not clamped to the page, so x
// and y can be negative or beyond the page's width and height; the outline near the edge keeps
// its true shape, and the drawing is clipped by the page (the SVG's viewBox, the view's canvases).
import { isImageId, isPageId, isStrokeId } from './ids';
import { fmt1, strokePathCached, type OutlineInput } from './outline';
import { fixedPaper, IMAGE_RE, metadataTemplate, parseTemplate, renderTemplate, type Size, type Template } from './template';

export type { Size } from './template';

export const FORMAT = 'notebook-ink/1';

/** Page sizes in CSS px at 96 px/in. */
export const LETTER: Readonly<Size> = Object.freeze({ width: 816, height: 1056 });
export const A4: Readonly<Size> = Object.freeze({ width: 794, height: 1123 });

export type Paper = 'letter' | 'a4';
export const PAPER_SIZES: Readonly<Record<Paper, Readonly<Size>>> = { letter: LETTER, a4: A4 };

/**
 * A note's paper (#27): Letter, A4, or a custom size `<width>x<height>` in CSS px to 0.1 px
 * (a sticky note is `288x288`), as the index's `paper:` stores it.
 */
export type NotePaper = Paper | `${number}x${number}`;

/** The largest side of a custom paper, in px (about 200 in). */
export const MAX_PAPER_SIDE = 20000;

/** A custom paper from a size: `288x288`, sides rounded to 0.1 px. */
export function sizePaper(size: Size): NotePaper {
  return `${fmt1(roundXY(size.width))}x${fmt1(roundXY(size.height))}` as NotePaper;
}

/**
 * The paper a `paper:` value names, in canonical form (lowercase, custom sizes to 0.1 px), or
 * null if it's not letter, a4 or `<width>x<height>` with sides from 0.1 to MAX_PAPER_SIDE px.
 */
export function parsePaper(value: string): NotePaper | null {
  const v = value.trim().toLowerCase();
  if (v === 'letter' || v === 'a4') return v;
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(v);
  if (!m) return null;
  const width = roundXY(Number(m[1])), height = roundXY(Number(m[2]));
  if (!(width > 0 && height > 0 && width <= MAX_PAPER_SIDE && height <= MAX_PAPER_SIDE)) return null;
  return sizePaper({ width, height });
}

/** A paper's page size (a fresh object). Throws on an invalid paper. */
export function paperSize(paper: NotePaper): Size {
  if (paper === 'letter' || paper === 'a4') return { ...PAPER_SIZES[paper] };
  const p = parsePaper(paper);
  if (!p || p === 'letter' || p === 'a4') throw new Error(`Unknown paper "${paper}"`);
  const [w, h] = p.split('x').map(Number);
  return { width: w, height: h };
}

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
  /** The id of the image this stroke was written on (#12), if any. */
  on?: string;
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
  /** Images on the page (#12), bottom first, drawn under all strokes. Absent or empty: none. */
  images?: PageImage[];
}

/** An image placed on a page (#12). Coordinates in page px, rounded like points (0.1 px). */
export interface PageImage {
  /** `i-` and 6 lowercase hex characters, unique within the page. */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `data:image/jpeg;base64,…` or png, at the image's own resolution; '' if missing. */
  data: string;
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

/** An image's fields, validated and rounded (data: '' unless a base64 JPEG or PNG data URL). */
function checkImage(v: unknown, i: number, seen: Set<string>): PageImage {
  const im = v as Partial<PageImage>;
  if (typeof im !== 'object' || im === null) fail(`image ${i} is not an object`);
  if (typeof im.id !== 'string' || !isImageId(im.id)) fail(`image ${i} has an invalid id ${JSON.stringify(im.id)}`);
  if (seen.has(im.id)) fail(`image id ${im.id} is used twice`);
  seen.add(im.id);
  if (!isNum(im.x) || !isNum(im.y) || !isNum(im.width) || !isNum(im.height)) fail(`image ${im.id} needs numeric x, y, width and height`);
  const width = roundXY(im.width), height = roundXY(im.height);
  if (width <= 0 || height <= 0) fail(`image ${im.id} has no area`);
  const data = typeof im.data === 'string' && IMAGE_RE.test(im.data) ? im.data : '';
  return { id: im.id, x: roundXY(im.x), y: roundXY(im.y), width, height, data };
}

/** A stroke's `on`, kept only if it names one of the page's images. */
const onImage = (s: unknown, images: ReadonlySet<string>): string | undefined => {
  const on = (s as { on?: unknown }).on;
  return typeof on === 'string' && images.has(on) ? on : undefined;
};

// ---- writing

/** Default ink (`.i`, fill) and template lines (`.t`, stroke) follow dark mode (not on pdf pages). */
const STYLE =
  '<style>.i{fill:#1f1f1f}.t{stroke:#c9c9c9}' +
  '@media (prefers-color-scheme:dark){.i{fill:#e6e3de}.t{stroke:#3c3c3c}}</style>';

/**
 * For pdf pages (#14) and fill pages (#27): the paper is the PDF's own or a fixed colour, the
 * same in both modes, so the ink doesn't flip.
 */
const PDF_STYLE = '<style>.i{fill:#1f1f1f}.t{stroke:#c9c9c9}</style>';

/** A stroke's points as the file stores them, and the inputs of its outline (#37). */
interface Encoded {
  points: readonly Point[];
  n: number;
  first: Point;
  last: Point;
  /** The points' JSON: encodePoints, stringified. */
  json: string;
  /** Whether the points are already as stored (decodePoints(encodePoints(points)) equals them). */
  canonical: boolean;
  /** The outline's input when the points aren't canonical: the stored points. */
  decoded: Point[];
}
const encoded = new WeakMap<object, Encoded>();

/**
 * A stroke's encoded points and outline `d`, memoised per stroke object so a save only encodes
 * and outlines new or changed strokes (#37). Validates the points on a miss. The cache is
 * keyed by the points array (identity, length, first and last point), and the outline by
 * strokePathCached (tool, nib, size too), so the bytes are those of an uncached write.
 */
function encodedStroke(s: Stroke, head: StrokeHead): { json: string; d: string } {
  const points = s.points;
  let e = Array.isArray(points) ? encoded.get(s) : undefined;
  const n = Array.isArray(points) ? points.length : 0;
  if (!e || e.points !== points || e.n !== n || e.first !== points[0] || e.last !== points[n - 1]) {
    if (!Array.isArray(points) || n === 0) fail(`stroke ${head.id} has no points`);
    for (const pt of points) {
      if (!isNum(pt.x) || !isNum(pt.y) || !isNum(pt.p) || !isNum(pt.t)) fail(`stroke ${head.id} has a non-numeric point`);
    }
    const flat = encodePoints(points);
    const decoded = decodePoints(flat);
    const canonical = decoded.every((q, i) => q.x === points[i].x && q.y === points[i].y && q.p === points[i].p && q.t === points[i].t);
    e = { points, n, first: points[0], last: points[n - 1], json: JSON.stringify(flat), canonical, decoded };
    encoded.set(s, e);
  }
  const input: OutlineInput = head.tool === 'pen'
    ? { tool: 'pen', nib: head.nib, size: head.size, points: e.decoded }
    : { tool: 'highlighter', size: head.size, points: e.decoded };
  // Canonical points and size: the stroke's own outline, which the renderer shares.
  const same = e.canonical && s.size === head.size && s.tool === head.tool && (s.tool !== 'pen' || head.tool !== 'pen' || s.nib === head.nib);
  return { json: e.json, d: strokePathCached(same ? s : outlineKey(e, input)) };
}

/** One stable outline input per encoded entry and head, so strokePathCached can hit on it. */
const inputs = new WeakMap<Encoded, OutlineInput>();
function outlineKey(e: Encoded, input: OutlineInput): OutlineInput {
  const c = inputs.get(e);
  if (c && c.tool === input.tool && c.size === input.size && (c.tool !== 'pen' || input.tool !== 'pen' || c.nib === input.nib)) return c;
  inputs.set(e, input);
  return input;
}

/**
 * The page's SVG file. Deterministic: the same page always gives the same bytes. Rounds
 * points as `encodePoints` does, and throws if the page is invalid.
 */
export function writePage(page: Page): string {
  if (typeof page.id !== 'string' || !isPageId(page.id)) fail(`invalid page id ${JSON.stringify(page.id)}`);
  const size = checkSize(page.size);
  const template = parseTemplate(page.template);
  const imageIds = new Set<string>();
  const images = (page.images ?? []).map((im, i) => checkImage(im, i, imageIds));
  const seen = new Set<string>();
  const strokes = page.strokes.map((s, i) => {
    const head = checkStroke(s, i, seen);
    const on = onImage(s, imageIds);
    const enc = encodedStroke(s, head);
    return { ...head, on, pointsJson: enc.json, d: enc.d };
  });

  const json = (v: unknown) => JSON.stringify(v);
  const strokeJson = strokes.map(s =>
    `{"id":${json(s.id)},"tool":${json(s.tool)},` + (s.tool === 'pen' ? `"nib":${json(s.nib)},` : '') +
    `"color":${json(s.color)},"size":${json(s.size)},` + (s.on ? `"on":${json(s.on)},` : '') + `"points":${s.pointsJson}}`);
  const imageJson = images.map(im => json({ id: im.id, x: im.x, y: im.y, width: im.width, height: im.height }));
  const meta =
    `{"format":${json(FORMAT)},"id":${json(page.id)},"size":${json(size)},"template":${json(metadataTemplate(template))},` +
    (images.length ? `"images":[\n${imageJson.join(',\n')}\n],` : '') + `"strokes":[` +
    (strokeJson.length ? '\n' + strokeJson.join(',\n') + '\n' : '') + ']}';

  const w = fmt1(size.width), h = fmt1(size.height);
  const image = (im: PageImage) =>
    `<image data-id="${im.id}" x="${fmt1(im.x)}" y="${fmt1(im.y)}" width="${fmt1(im.width)}" height="${fmt1(im.height)}" preserveAspectRatio="none" href="${im.data}"/>`;
  // One array of pieces joined once: the paths of a dense page are megabytes, and joining each
  // layer first and then the file copied them twice (#37).
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n`,
    fixedPaper(template) ? PDF_STYLE : STYLE, '\n',
    // `]]>` could only occur inside a JSON string, where `>` may be escaped instead.
    `<metadata><![CDATA[${meta.replace(/]]>/g, ']]\\u003e')}]]></metadata>\n`,
  ];
  // A layer of items, each on its own line; an item is one or more pieces.
  const layer = (id: string, attrs: string, items: readonly (string | readonly string[])[]) => {
    out.push(`<g id="${id}"${attrs}>`);
    for (const item of items) {
      out.push('\n');
      if (typeof item === 'string') out.push(item);
      else for (const piece of item) out.push(piece);
    }
    out.push(items.length ? '\n</g>\n' : '</g>\n');
  };
  const paths = (tool: Stroke['tool']) => strokes.filter(s => s.tool === tool).map(s =>
    [`<path data-id="${s.id}" ${s.color === DEFAULT_INK ? 'class="i"' : `fill="${s.color}"`} d="`, s.d, '"/>']);
  layer('template', '', renderTemplate(template, size));
  // With images, the objects layer sits under the ink; without, it stays last and empty (#12).
  if (images.length) layer('objects', '', images.filter(im => im.data).map(image));
  // Highlighter paths are opaque and the layer is translucent, so crossing strokes don't darken.
  layer('highlight', ' opacity="0.4"', paths('highlighter'));
  layer('ink', '', paths('pen'));
  if (!images.length) layer('objects', '', []);
  out.push('</svg>\n');
  return out.join('');
}

// ---- reading

/**
 * A pdf template's image, from the `href` of the first <image> in the template layer, or ''
 * if there's none or it isn't a base64 JPEG or PNG data URL.
 */
function templateImage(svgText: string): string {
  const m = /<g id="template"[^>]*>\s*<image\b[^>]*?\shref="([^"]*)"/.exec(svgText);
  return m && IMAGE_RE.test(m[1]) ? m[1] : '';
}

/** The `href` of each <image data-id="i-…"> of the objects layer (#12), by id. */
function objectImages(svgText: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<image data-id="(i-[0-9a-f]{6})"[^>]*?\shref="([^"]*)"/g;
  for (let m = re.exec(svgText); m; m = re.exec(svgText)) if (!out.has(m[1])) out.set(m[1], m[2]);
  return out;
}

/**
 * Reads a page from its SVG file. Only <metadata> is read, and the drawing is regenerated by
 * writePage, except for a pdf template's image, read from the template layer (a page whose
 * image is missing still reads, with image ''). Throws if the file isn't a notebook-ink/1 page
 * or its data is invalid.
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
  let template = parseTemplate(data.template);
  if (template.kind === 'pdf' || template.kind === 'image') template = { ...template, image: templateImage(svgText) };
  if (data.images !== undefined && !Array.isArray(data.images)) fail('images must be an array');
  const imageIds = new Set<string>();
  const hrefs = data.images ? objectImages(svgText) : null;
  const images = ((data.images ?? []) as unknown[]).map((v, i) => checkImage({ ...(v as object), data: hrefs?.get((v as PageImage)?.id) }, i, imageIds));
  if (!Array.isArray(data.strokes)) fail('strokes must be an array');
  const seen = new Set<string>();
  const strokes: Stroke[] = data.strokes.map((s: unknown, i: number) => {
    const head = checkStroke(s, i, seen);
    const flat: unknown = (s as { points?: unknown }).points;
    if (!Array.isArray(flat) || flat.length === 0 || flat.length % 4 !== 0 || !flat.every(isNum)) {
      fail(`stroke ${head.id} points must be a non-empty flat array of [x, y, p, dt] numbers`);
    }
    const on = onImage(s, imageIds);
    return on ? { ...head, on, points: decodePoints(flat) } : { ...head, points: decodePoints(flat) };
  });
  return images.length ? { id: data.id, size, template, strokes, images } : { id: data.id, size, template, strokes };
}

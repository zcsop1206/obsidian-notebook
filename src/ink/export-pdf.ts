// "Export note as PDF" (#18): every page of a note as one PDF, in light mode, with the ink as
// vectors. One PDF page per ink page, sized page px × 72/96 (Letter is 612 × 792 pt). Each page
// is drawn as the editor composites it: the template (fill, lines, grid, dots as vector paths;
// a pdf or image page's embedded image stretched to the page), the page's images (#12), the
// highlighter strokes as one transparency group drawn at HIGHLIGHT_ALPHA (so crossings don't
// darken), then the pen strokes. A stroke is its saved outline (strokePath: the refitted pen
// outline as quadratic curves, converted exactly to cubic Béziers; the highlighter's polygon),
// filled with the nonzero rule.
//
// Images: a JPEG is embedded as it is (DCTDecode). A PNG is decoded through a canvas and
// re-encoded as JPEG over white, so its transparency is lost (a limitation; an SMask would keep
// it). There is no text and no font. Default ink (#000000) is black; template lines are the
// light theme's grey, the margin line its pink.
//
// The file is saved next to the note as `<note>.pdf` (`<note> 1.pdf`… if taken), and on the
// iPad also offered to the share sheet (navigator.share with a File) where it takes files. This
// module takes Obsidian's Notice and Platform through ExportEnv, so its pure parts are unit-tested.
import type { Vault } from 'obsidian';
import { strokePath } from '../format/outline';
import { DEFAULT_INK, type Page, type Size, type Stroke } from '../format/page';
import { deflate, num, PdfWriter, type Content, type Resources } from '../format/pdf-writer';
import { FIRST_LINE, GRID_SPACING, MARGIN_COLOR, MARGIN_X, RULE_SPACING, type Template } from '../format/template';
import { uniqueName } from './names';
import { HIGHLIGHT_ALPHA } from './renderer';
import type { NoteStore } from './store';

/** Points per CSS px: 72 pt and 96 px per inch. */
export const PT_PER_PX = 72 / 96;
/** Template lines, as the light theme draws them (page.ts's `.t`). */
export const LINE_COLOR = '#c9c9c9';
/** Default ink in the export. */
export const EXPORT_INK = '#000000';
/** JPEG quality of PNGs re-encoded for the PDF. */
const PNG_JPEG_QUALITY = 0.92;

const enc = new TextEncoder();

/** `#rrggbb` as PDF colour operands `r g b` (0..1, 3 decimals). */
export function pdfColor(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '0 0 0';
  return [m[1], m[2], m[3]].map(h => num(parseInt(h, 16) / 255)).join(' ');
}

/** A page's size in points. */
export const pageSizePt = (size: Size): Size => ({ width: size.width * PT_PER_PX, height: size.height * PT_PER_PX });

/**
 * The transform that lets page px be written as stored: scale by PT_PER_PX and flip y (PDF's
 * y goes up from the bottom), as a `cm` operator for a page `heightPx` tall.
 */
export const pageTransform = (heightPx: number): string => `${num(PT_PER_PX)} 0 0 ${num(-PT_PER_PX)} 0 ${num(heightPx * PT_PER_PX)} cm`;

type XY = [number, number];

/** The cubic Bézier control points of the quadratic from p0 through control q to p2 (exact: at 2/3). */
export function quadToCubic(p0: XY, q: XY, p2: XY): [XY, XY] {
  return [
    [p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])],
    [p2[0] + 2 / 3 * (q[0] - p2[0]), p2[1] + 2 / 3 * (q[1] - p2[1])],
  ];
}

/**
 * Cubic segments for an SVG arc (without rotation) from `p0` to `p`, by the SVG spec's
 * endpoint-to-centre conversion, in pieces of at most 90°. Each piece is [c1, c2, end].
 */
export function arcToCubics(p0: XY, rx: number, ry: number, large: boolean, sweep: boolean, p: XY): [XY, XY, XY][] {
  rx = Math.abs(rx); ry = Math.abs(ry);
  const dx = (p0[0] - p[0]) / 2, dy = (p0[1] - p[1]) / 2;
  if ((dx === 0 && dy === 0)) return [];
  if (rx === 0 || ry === 0) return [[p0, p, p]];
  const lambda = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num2 = rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx;
  const den = rx * rx * dy * dy + ry * ry * dx * dx;
  let co = Math.sqrt(Math.max(0, num2 / den));
  if (large === sweep) co = -co;
  const cxp = co * rx * dy / ry, cyp = -co * ry * dx / rx;
  const cx = cxp + (p0[0] + p[0]) / 2, cy = cyp + (p0[1] + p[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (dx - cxp) / rx, (dy - cyp) / ry);
  let dt = angle((dx - cxp) / rx, (dy - cyp) / ry, (-dx - cxp) / rx, (-dy - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n, k = 4 / 3 * Math.tan(step / 4);
  const out: [XY, XY, XY][] = [];
  let a = t1;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const end: XY = i === n - 1 ? [p[0], p[1]] : [cx + rx * cb, cy + ry * sb];
    out.push([[cx + rx * (ca - k * sa), cy + ry * (sa + k * ca)], [cx + rx * (cb + k * sb), cy + ry * (sb - k * cb)], end]);
    a = b;
  }
  return out;
}

/**
 * PDF path construction operators (m, l, c, h) for an SVG path `d` with absolute commands
 * M, L, H, V, Q, A and Z, the ones strokePath writes. Quadratics become cubics exactly; arcs
 * become cubics within 0.03% of the radius. Unknown commands end the conversion.
 */
export function pathOps(d: string): string {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let i = 0, cmd = '';
  let cur: XY = [0, 0], start: XY = [0, 0];
  const isCmd = (t: string | undefined) => t !== undefined && /^[A-Za-z]$/.test(t);
  const n = () => Number(tokens[i++]);
  const xy = (p: XY) => num(p[0]) + ' ' + num(p[1]);
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) return out.join('\n');
    switch (cmd) {
      case 'M': cur = start = [n(), n()]; out.push(xy(cur) + ' m'); cmd = 'L'; break;
      case 'L': cur = [n(), n()]; out.push(xy(cur) + ' l'); break;
      case 'H': cur = [n(), cur[1]]; out.push(xy(cur) + ' l'); break;
      case 'V': cur = [cur[0], n()]; out.push(xy(cur) + ' l'); break;
      case 'Q': {
        const q: XY = [n(), n()], p: XY = [n(), n()];
        const [c1, c2] = quadToCubic(cur, q, p);
        out.push(`${xy(c1)} ${xy(c2)} ${xy(p)} c`);
        cur = p;
        break;
      }
      case 'A': {
        const rx = n(), ry = n(); n(); // rotation: strokePath writes 0
        const large = n() !== 0, sweep = n() !== 0, p: XY = [n(), n()];
        for (const [c1, c2, e] of arcToCubics(cur, rx, ry, large, sweep, p)) out.push(`${xy(c1)} ${xy(c2)} ${xy(e)} c`);
        cur = p;
        break;
      }
      case 'Z': case 'z': out.push('h'); cur = start; if (!isCmd(tokens[i])) return out.join('\n'); break;
      default: return out.join('\n');
    }
  }
  return out.join('\n');
}

/** Positions from `from` in steps of `step` while below `end`, to 0.1 px (as template.ts lays them out). */
function steps(step: number, end: number, from = step): number[] {
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const v = Math.round((from + k * step) * 10) / 10;
    if (v >= end) return out;
    out.push(v);
  }
}

/**
 * A template's vector drawing in page px (fill, lines, grid, dots), the same geometry as
 * renderTemplate. Blank, pdf and image kinds give '' (their image is drawn separately).
 */
export function templateOps(template: Template, size: Size): string {
  const w = num(size.width), h = num(size.height);
  const line = `${pdfColor(LINE_COLOR)} RG 1 w 0 J\n`;
  switch (template.kind) {
    case 'fill': return `${pdfColor(template.color)} rg 0 0 ${w} ${h} re f\n`;
    case 'lined': {
      const ys = steps(RULE_SPACING[template.rule], size.height, FIRST_LINE);
      let s = ys.length ? line + ys.map(y => `0 ${num(y)} m ${w} ${num(y)} l`).join('\n') + '\nS\n' : '';
      if (template.margin) s += `${pdfColor(MARGIN_COLOR)} RG 1 w ${MARGIN_X} 0 m ${MARGIN_X} ${h} l S\n`;
      return s;
    }
    case 'grid': {
      const sp = GRID_SPACING[template.spacing];
      const d = [...steps(sp, size.height).map(y => `0 ${num(y)} m ${w} ${num(y)} l`), ...steps(sp, size.width).map(x => `${num(x)} 0 m ${num(x)} ${h} l`)];
      return d.length ? line + d.join('\n') + '\nS\n' : '';
    }
    case 'dots': {
      // Each dot a zero-length round-capped segment 2 px wide: a filled dot of radius 1 px, as
      // the SVG's 0.5 px circle stroked 1 px wide draws it.
      const sp = GRID_SPACING[template.spacing];
      const xs = steps(sp, size.width - sp / 2), ys = steps(sp, size.height - sp / 2);
      if (!xs.length || !ys.length) return '';
      const d: string[] = [];
      for (const y of ys) for (const x of xs) d.push(`${num(x)} ${num(y)} m ${num(x)} ${num(y)} l`);
      return `${pdfColor(LINE_COLOR)} RG 2 w 1 J\n${d.join('\n')}\nS\n`;
    }
    default: return '';
  }
}

/** A stroke's fill in page px: its outline path and `f`, in its colour ('' if it has no outline). */
export function strokeOps(s: Stroke): string {
  const ops = pathOps(strokePath(s));
  if (!ops) return '';
  return `${pdfColor(s.color === DEFAULT_INK ? EXPORT_INK : s.color)} rg\n${ops}\nf\n`;
}

/** Turns an image data URL into JPEG bytes for the PDF, or null if it can't. */
export type JpegSource = (dataUrl: string) => Promise<Uint8Array | null>;

/** The bytes of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The browser's JpegSource: a JPEG's own bytes; a PNG drawn on white in a canvas and encoded
 * as JPEG (transparency is lost). Null if the image doesn't decode.
 */
export const browserJpeg: JpegSource = async dataUrl => {
  if (dataUrl.startsWith('data:image/jpeg;')) return dataUrlBytes(dataUrl);
  if (!dataUrl.startsWith('data:image/png;')) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([dataUrlBytes(dataUrl) as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', PNG_JPEG_QUALITY));
    canvas.width = canvas.height = 0;
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch (e) {
    console.warn('[notebook] export: an image did not decode', e);
    return null;
  }
};

export interface BuildOptions {
  jpeg?: JpegSource;
  /** Compress content streams where CompressionStream exists (default true). */
  compress?: boolean;
  /** Called after each page is built, to show progress. */
  progress?: (done: number, total: number) => void;
  /** Awaited after each page, so a long note doesn't block the UI (default: a macrotask). */
  yieldFn?: () => Promise<void>;
}

/** A page to export: a page, or only a size for a page that couldn't be read (exported blank). */
export type ExportPage = Page | { size: Size };

/** The PDF of these pages. Deterministic for the same pages and options. */
export async function buildPdf(pages: readonly ExportPage[], title: string, opts: BuildOptions = {}): Promise<Uint8Array> {
  const jpeg = opts.jpeg ?? browserJpeg;
  const compress = opts.compress ?? true;
  const yieldFn = opts.yieldFn ?? (() => new Promise<void>(r => setTimeout(r, 0)));
  const w = new PdfWriter();
  // One XObject per distinct image, so a PDF template's image used on many pages is stored once.
  const images = new Map<string, number | null>();
  const imageRef = async (data: string): Promise<number | null> => {
    if (!data) return null;
    if (!images.has(data)) {
      let ref: number | null = null;
      try {
        const bytes = await jpeg(data);
        if (bytes) ref = w.jpeg(bytes).ref;
      } catch (e) {
        console.warn('[notebook] export: an image was left out', e);
      }
      images.set(data, ref);
    }
    return images.get(data) ?? null;
  };
  const content = async (text: string): Promise<Content> => {
    const data = enc.encode(text);
    const z = compress ? await deflate(data) : null;
    return z ? { data: z, filter: 'FlateDecode' } : { data };
  };

  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const size = pg.size;
    const res: Required<Resources> = { xobjects: {}, extGStates: {} };
    let body = `q\n${pageTransform(size.height)}\n`;
    if ('template' in pg) {
      const t = pg.template;
      body += templateOps(t, size);
      const drawImage = (name: string, x: number, y: number, iw: number, ih: number) =>
        `q ${num(iw)} 0 0 ${num(-ih)} ${num(x)} ${num(y + ih)} cm /${name} Do Q\n`;
      if (t.kind === 'pdf' || t.kind === 'image') {
        const ref = await imageRef(t.image);
        if (ref) { res.xobjects.T0 = ref; body += drawImage('T0', 0, 0, size.width, size.height); }
      }
      for (const [k, im] of (pg.images ?? []).entries()) {
        const ref = await imageRef(im.data);
        if (ref) { res.xobjects[`Im${k}`] = ref; body += drawImage(`Im${k}`, im.x, im.y, im.width, im.height); }
      }
      const highlights = pg.strokes.filter(s => s.tool === 'highlighter').map(strokeOps).join('');
      if (highlights) {
        res.xobjects.Hl = w.form([0, 0, size.width, size.height], await content(highlights), {}, true);
        res.extGStates.Ha = w.alpha(HIGHLIGHT_ALPHA);
        body += 'q /Ha gs /Hl Do Q\n';
      }
      body += pg.strokes.filter(s => s.tool === 'pen').map(strokeOps).join('');
    }
    body += 'Q\n';
    const pt = pageSizePt(size);
    w.page(pt.width, pt.height, await content(body), res);
    opts.progress?.(i + 1, pages.length);
    await yieldFn();
  }
  return w.finish({ title });
}

// ---- saving and sharing

/** What exporting needs from Obsidian and the platform (Notice, Platform.isIosApp). */
export interface ExportEnv {
  notice(message: string, timeout?: number): { setMessage?(message: string): unknown; hide(): void; noticeEl?: HTMLElement };
  /** Offer the share sheet (Platform.isIosApp). */
  ios: boolean;
}

/** Notes with more pages than this show a progress notice. */
const PROGRESS_PAGES = 3;

/** The path for a note's PDF: `<dir>/<basename>.pdf`, numbered if taken. */
export function pdfPath(dir: string, basename: string, taken: (path: string) => boolean): string {
  const prefix = dir ? dir + '/' : '';
  return prefix + uniqueName(basename, n => taken(`${prefix}${n}.pdf`)) + '.pdf';
}

type ShareNavigator = Navigator & { canShare?(data: { files: File[] }): boolean; share?(data: { files: File[]; title?: string }): Promise<void> };

/**
 * Offers the file to the share sheet where files can be shared; never throws. Where the share
 * needs a fresh tap (the user activation expired while the PDF was built), a notice offers it.
 */
async function share(bytes: Uint8Array, name: string, title: string, env: ExportEnv): Promise<void> {
  const nav = (typeof navigator === 'undefined' ? null : navigator) as ShareNavigator | null;
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function' || typeof File === 'undefined') return;
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/pdf' });
  let ok = false;
  try { ok = nav.canShare({ files: [file] }); } catch { ok = false; }
  if (!ok) return;
  const go = async () => {
    try {
      await nav.share!({ files: [file], title });
      return true;
    } catch (e) {
      const n = (e as Error)?.name;
      if (n === 'AbortError') return true; // the user closed the sheet
      if (n !== 'NotAllowedError') console.warn('[notebook] share PDF', e);
      return n !== 'NotAllowedError';
    }
  };
  if (await go()) return;
  const n = env.notice('Tap here to share the PDF.', 0);
  n.noticeEl?.addEventListener('click', () => { n.hide(); void go(); }, { once: true });
}

/**
 * Exports the open note to `<note>.pdf` next to it and returns the path, or null if it failed
 * (shown in a notice). Pages are taken from the store, unsaved changes included.
 */
export async function exportNotePdf(vault: Vault, store: NoteStore, notePath: string, basename: string, env: ExportEnv,
  opts: BuildOptions = {}): Promise<string | null> {
  const slots = store.slots;
  const progress = slots.length > PROGRESS_PAGES ? env.notice('Exporting PDF…', 0) : null;
  try {
    let unreadable = 0;
    const pages: ExportPage[] = slots.map(slot => {
      const page = store.page(slot);
      if (!page) unreadable++;
      return page ?? { size: slot.size };
    });
    const bytes = await buildPdf(pages, basename, {
      ...opts,
      progress: (done, total) => { progress?.setMessage?.(`Exporting PDF: page ${done} of ${total}`); opts.progress?.(done, total); },
    });
    const slash = notePath.lastIndexOf('/');
    const path = pdfPath(slash < 0 ? '' : notePath.slice(0, slash), basename, p => !!vault.getAbstractFileByPath(p));
    await vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    progress?.hide();
    env.notice(`Exported the note as ${path}` + (unreadable ? ` (${unreadable} unreadable page${unreadable > 1 ? 's' : ''} left blank)` : ''));
    if (env.ios) await share(bytes, path.slice(path.lastIndexOf('/') + 1), basename, env);
    return path;
  } catch (e) {
    progress?.hide();
    console.error('[notebook] export PDF', e);
    env.notice(`Couldn't export the PDF: ${(e as Error).message}`);
    return null;
  }
}

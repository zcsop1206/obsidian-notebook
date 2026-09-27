// Page templates: the model stored in a page's <metadata> and the renderer for its
// <g id="template"> layer. Built-in kinds: blank, lined, grid and dots (#19); #14/#21 add PDF
// page images. Each new kind adds a member to `Template`, a case to `parseTemplate`, a case to
// `renderTemplate`, and names in BUILT_IN_TEMPLATES.
//
// The `pdf` kind (#14) is a page of an imported PDF: `source` (the PDF's path relative to the
// folder holding the page file, the note's page folder, e.g. `lecture.pdf` for the PDF copied
// beside the pages, so moving or renaming the page folder never breaks it), `page` (1-based) and `image`, a data URL of the
// page rendered at about 150 dpi. It is the one exception to "the metadata is the source of
// truth": to store the image once, the metadata holds only kind, source and page, and the image
// bytes live in the drawing, as the <image> of the template layer, which readPage reads back
// (see page.ts). A pdf template has no reversible name: templateName gives the fixed label
// `pdf`, which parseTemplateName rejects, and it's not in BUILT_IN_TEMPLATES or TEMPLATE_KINDS
// (which list the kinds a user can choose). A PDF note's `template:` frontmatter is `blank`.
//
// The `fill` kind (#27) is a solid background of a fixed colour, the same in light and dark mode
// (a sticky note's pale yellow). Like a pdf page, its paper doesn't follow dark mode, so default
// ink on it stays dark in both modes (`fixedPaper`, which also covers the `image` kind of #12, see ImageTemplate). Built-in entries may carry a page `size`
// (the sticky note, the index card): a note or page made from one gets that size.
//
// Every template has a reversible name (`lined-college-margin`), used by the note's
// `template:` frontmatter, the settings and menus. parseTemplateName throws on an unknown
// name; code reading a name from a file the user can edit (the note's frontmatter, saved
// settings) catches that and uses blank with a console warning.

export interface Size {
  width: number;
  height: number;
}

/** No lines: the template layer is empty. */
export interface BlankTemplate {
  kind: 'blank';
}

/** Ruled lines: college rule 9/32 in, wide rule 11/32 in, optionally with a margin line. */
export interface LinedTemplate {
  kind: 'lined';
  rule: 'college' | 'wide';
  margin: boolean;
}

/** Square grid from the page's top-left corner. */
export interface GridTemplate {
  kind: 'grid';
  spacing: '5mm' | '1/4in';
}

/** Dot grid, starting one spacing in from the top and left edges. */
export interface DotsTemplate {
  kind: 'dots';
  spacing: '5mm';
}

/**
 * A page of a PDF (#14): the page's image embedded in the page file, and a reference to the
 * PDF for sharp rendering in the editor. See the header.
 */
export interface PdfTemplate {
  kind: 'pdf';
  /** The PDF's path relative to the page file's folder (the page folder), `/`-separated, e.g. `lecture.pdf`. */
  source: string;
  /** 1-based page number in the PDF. */
  page: number;
  /** `data:image/jpeg;base64,…` (or png) of the page, or '' if it's missing. */
  image: string;
}

/** A solid background of a fixed colour, the same in both modes (#27, sticky notes). */
export interface FillTemplate {
  kind: 'fill';
  /** Lowercase `#rrggbb`. */
  color: string;
}

/**
 * An image inserted as a whole page (#12): like a pdf page, the image is the paper (white in
 * dark mode too) and its bytes are stored once, in the drawing's template layer; the metadata
 * holds only the kind. No reversible name (templateName gives `image`).
 */
export interface ImageTemplate {
  kind: 'image';
  /** `data:image/jpeg;base64,…` (or png), or '' if it's missing. */
  image: string;
}

/** A page's template, discriminated by `kind`. Extend this union with new kinds. */
export type Template = BlankTemplate | LinedTemplate | GridTemplate | DotsTemplate | PdfTemplate | FillTemplate | ImageTemplate;
/** The kinds with a default (not `pdf`, `fill` or `image`, which are chosen otherwise). */
export type TemplateKind = Exclude<Template['kind'], 'pdf' | 'fill' | 'image'>;

export const TEMPLATE_KINDS: readonly TemplateKind[] = ['blank', 'lined', 'grid', 'dots'];

export const isTemplateKind = (s: string): s is TemplateKind => (TEMPLATE_KINDS as readonly string[]).includes(s);

const RULES: readonly LinedTemplate['rule'][] = ['college', 'wide'];
const GRID_SPACINGS: readonly GridTemplate['spacing'][] = ['5mm', '1/4in'];
const DOT_SPACINGS: readonly DotsTemplate['spacing'][] = ['5mm'];

/** Line spacing in CSS px at 96 px/in. */
export const RULE_SPACING: Readonly<Record<LinedTemplate['rule'], number>> = { college: 27, wide: 33 };
/** Grid and dot spacing in CSS px: 5 mm is 18.9 px (96 / 25.4 × 5, to 0.1 px). */
export const GRID_SPACING: Readonly<Record<GridTemplate['spacing'], number>> = { '5mm': 18.9, '1/4in': 24 };
/** Where the first ruled line is, from the top: about 1 in. */
export const FIRST_LINE = 96;
/** The margin line, from the left edge: 1.25 in. */
export const MARGIN_X = 120;
/** The margin line's colour, the same in light and dark mode. */
export const MARGIN_COLOR = '#e8a0a0';

/** The default template for a kind. */
export function defaultTemplate(kind: TemplateKind): Template {
  switch (kind) {
    case 'blank': return { kind: 'blank' };
    case 'lined': return { kind: 'lined', rule: 'college', margin: false };
    case 'grid': return { kind: 'grid', spacing: '5mm' };
    case 'dots': return { kind: 'dots', spacing: '5mm' };
  }
  return unknownKind(kind as string);
}

function badOption(kind: string, option: string, value: unknown, expected: readonly unknown[]): never {
  throw new Error(`Invalid page template: ${kind} ${option} ${JSON.stringify(value)} (expected ${expected.map(v => JSON.stringify(v)).join(' or ')})`);
}

/**
 * Validates a template read from a page's metadata and returns it in canonical form (fixed
 * key order, no other keys, so writing it again gives the same bytes). Throws if it's invalid.
 */
export function parseTemplate(value: unknown): Template {
  if (typeof value !== 'object' || value === null || typeof (value as { kind?: unknown }).kind !== 'string') {
    throw new Error('Invalid page template: expected an object with a "kind"');
  }
  const v = value as { kind: string; color?: unknown; rule?: unknown; margin?: unknown; spacing?: unknown; source?: unknown; page?: unknown; image?: unknown };
  switch (v.kind) {
    case 'blank': return { kind: 'blank' };
    case 'lined': {
      if (!RULES.includes(v.rule as LinedTemplate['rule'])) badOption('lined', 'rule', v.rule, RULES);
      if (typeof v.margin !== 'boolean') badOption('lined', 'margin', v.margin, [true, false]);
      return { kind: 'lined', rule: v.rule as LinedTemplate['rule'], margin: v.margin };
    }
    case 'grid': {
      if (!GRID_SPACINGS.includes(v.spacing as GridTemplate['spacing'])) badOption('grid', 'spacing', v.spacing, GRID_SPACINGS);
      return { kind: 'grid', spacing: v.spacing as GridTemplate['spacing'] };
    }
    case 'dots': {
      if (!DOT_SPACINGS.includes(v.spacing as DotsTemplate['spacing'])) badOption('dots', 'spacing', v.spacing, DOT_SPACINGS);
      return { kind: 'dots', spacing: v.spacing as DotsTemplate['spacing'] };
    }
    case 'fill': {
      const color = typeof v.color === 'string' ? v.color.toLowerCase() : '';
      if (!FILL_RE.test(color)) throw new Error(`Invalid page template: fill color ${JSON.stringify(v.color)} (expected #rrggbb)`);
      return { kind: 'fill', color };
    }
    case 'pdf': {
      if (!isPdfSource(v.source)) {
        throw new Error(`Invalid page template: pdf source ${JSON.stringify(v.source)} (expected a path relative to the page folder, like "lecture.pdf")`);
      }
      if (typeof v.page !== 'number' || !Number.isInteger(v.page) || v.page < 1) {
        throw new Error(`Invalid page template: pdf page ${JSON.stringify(v.page)} (expected a whole number from 1)`);
      }
      // The metadata holds no image (it's read from the drawing), so a missing one is ''.
      const image = v.image === undefined ? '' : v.image;
      if (typeof image !== 'string' || (image !== '' && !IMAGE_RE.test(image))) {
        throw new Error(`Invalid page template: pdf image (expected a base64 JPEG or PNG data URL, or '')`);
      }
      return { kind: 'pdf', source: v.source, page: v.page, image };
    }
    case 'image': {
      const image = v.image === undefined ? '' : v.image;
      if (typeof image !== 'string' || (image !== '' && !IMAGE_RE.test(image))) {
        throw new Error(`Invalid page template: image (expected a base64 JPEG or PNG data URL, or '')`);
      }
      return { kind: 'image', image };
    }
  }
  return unknownKind(v.kind);
}

const FILL_RE = /^#[0-9a-f]{6}$/;

/**
 * Whether the template draws its own paper, the same in both modes (pdf and fill): default ink
 * on such a page is dark in dark mode too, in the file and in the editor.
 */
export const fixedPaper = (template: Template): boolean => template.kind === 'pdf' || template.kind === 'fill' || template.kind === 'image';

/** Whether two templates are the same (pdf templates by source and page; the image isn't compared). */
export const sameTemplate = (a: Template, b: Template): boolean =>
  JSON.stringify(metadataTemplate(parseTemplate(a))) === JSON.stringify(metadataTemplate(parseTemplate(b)));

/** A data URL a pdf template's image may hold: safe inside an SVG attribute. */
export const IMAGE_RE = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]*={0,2}$/;

/** A relative, `/`-separated path without empty, `.` or `..` segments. */
function isPdfSource(s: unknown): s is string {
  return typeof s === 'string' && s !== '' && !/[\\\u0000-\u001f]/.test(s) &&
    s.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * The template as the page's metadata stores it: a pdf template without its image (which is
 * stored once, in the drawing). Other kinds unchanged.
 */
export function metadataTemplate(template: Template): Omit<PdfTemplate, 'image'> | Omit<ImageTemplate, 'image'> | Exclude<Template, PdfTemplate | ImageTemplate> {
  if (template.kind === 'image') return { kind: 'image' };
  if (template.kind !== 'pdf') return template;
  return { kind: 'pdf', source: template.source, page: template.page };
}

/** A PDF page's size in CSS px (96 px/in) from its size in PDF points (72 per inch), to 0.1 px. */
export const pointsToPx = (pt: number) => Math.round(pt * 96 / 72 * 10) / 10 || 0;

// ---- names

export interface BuiltInTemplate {
  /** For frontmatter and settings, e.g. `lined-college-margin`. */
  name: string;
  /** For menus, e.g. "Lined, college rule, with margin". */
  label: string;
  template: Template;
  /** The page size the template comes in (#27: sticky note, index card), if it has one. */
  size?: Size;
}

/** A sticky note's colour: pale yellow, the same in both modes. */
export const STICKY_COLOR = '#fff59d';
/** An index card's colour: a warm off-white. */
export const CARD_COLOR = '#fffdf5';

/** Every built-in template, in menu order. */
export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = Object.freeze([
  { name: 'blank', label: 'Blank', template: { kind: 'blank' } },
  { name: 'lined-college', label: 'Lined, college rule', template: { kind: 'lined', rule: 'college', margin: false } },
  { name: 'lined-college-margin', label: 'Lined, college rule, with margin', template: { kind: 'lined', rule: 'college', margin: true } },
  { name: 'lined-wide', label: 'Lined, wide rule', template: { kind: 'lined', rule: 'wide', margin: false } },
  { name: 'lined-wide-margin', label: 'Lined, wide rule, with margin', template: { kind: 'lined', rule: 'wide', margin: true } },
  { name: 'grid-5mm', label: 'Grid, 5 mm', template: { kind: 'grid', spacing: '5mm' } },
  { name: 'grid-quarter-inch', label: 'Grid, ¼ in', template: { kind: 'grid', spacing: '1/4in' } },
  { name: 'dots-5mm', label: 'Dots, 5 mm', template: { kind: 'dots', spacing: '5mm' } },
  { name: 'sticky-3in', label: 'Sticky note 3 × 3 in', template: { kind: 'fill', color: STICKY_COLOR }, size: { width: 288, height: 288 } },
  { name: 'index-card', label: 'Index card 5 × 3 in', template: { kind: 'fill', color: CARD_COLOR }, size: { width: 480, height: 288 } },
] as BuiltInTemplate[]);

/** The fixed name of every pdf template. Not reversible: parseTemplateName rejects it. */
export const PDF_TEMPLATE_NAME = 'pdf';

/** The fixed name of every image template (#12). Not reversible, like PDF_TEMPLATE_NAME. */
export const IMAGE_TEMPLATE_NAME = 'image';

/**
 * The name of a template, e.g. `grid-quarter-inch`. The inverse of parseTemplateName, except
 * for pdf templates, which all have the name `pdf` (PDF_TEMPLATE_NAME) and can't be parsed back.
 */
export function templateName(template: Template): string {
  const t = parseTemplate(template);
  switch (t.kind) {
    case 'pdf': return PDF_TEMPLATE_NAME;
    case 'image': return IMAGE_TEMPLATE_NAME;
    case 'blank': return 'blank';
    case 'lined': return `lined-${t.rule}${t.margin ? '-margin' : ''}`;
    case 'grid': return t.spacing === '5mm' ? 'grid-5mm' : 'grid-quarter-inch';
    case 'dots': return 'dots-5mm';
    case 'fill': {
      // A built-in's colour gives its name; any other colour is `fill-rrggbb`.
      const b = BUILT_IN_TEMPLATES.find(e => e.template.kind === 'fill' && e.template.color === t.color);
      return b ? b.name : `fill-${t.color.slice(1)}`;
    }
  }
}

const FILL_NAME_RE = /^fill-([0-9a-f]{6})$/;

export const isTemplateName = (name: string): boolean => BUILT_IN_TEMPLATES.some(b => b.name === name) || FILL_NAME_RE.test(name);

/** The page size a named template comes in (a fresh object), or null if it has none. */
export function templateSize(name: string): Size | null {
  const size = BUILT_IN_TEMPLATES.find(t => t.name === name)?.size;
  return size ? { width: size.width, height: size.height } : null;
}

/** The template with this name (a fresh object). Throws if there's none. */
export function parseTemplateName(name: string): Template {
  const b = BUILT_IN_TEMPLATES.find(t => t.name === name);
  const fill = FILL_NAME_RE.exec(name);
  if (!b && fill) return { kind: 'fill', color: '#' + fill[1] };
  if (!b) throw new Error(`Unknown template "${name}" (expected ${BUILT_IN_TEMPLATES.map(t => t.name).join(', ')})`);
  return parseTemplate(b.template);
}

/** The menu label of a template, e.g. "Grid, 5 mm". */
export function templateLabel(template: Template): string {
  if (template.kind === 'pdf') return `PDF page ${template.page}`;
  if (template.kind === 'image') return 'Image';
  const name = templateName(template);
  return BUILT_IN_TEMPLATES.find(b => b.name === name)?.label ?? `Colour ${(template as FillTemplate).color}`;
}

// ---- rendering

/** A coordinate to 0.1 px, without float noise or -0. */
const num = (n: number) => String(Math.round(n * 10) / 10 || 0);

/** Positions k × step for k = 1, 2, … while below `end`. */
function steps(step: number, end: number, from = step): number[] {
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const v = Math.round((from + k * step) * 10) / 10;
    if (v >= end) return out;
    out.push(v);
  }
}

/** Template lines: coloured by the page's <style> (`.t`), light or dark. */
const linePath = (d: string) => `<path class="t" fill="none" stroke-width="1" d="${d}"/>`;

/**
 * The contents of a page's <g id="template"> layer, one SVG element per string. Deterministic.
 * Lines use `class="t"`, whose stroke colour follows dark mode through the page's <style>;
 * the margin line has a fixed colour.
 */
export function renderTemplate(template: Template, size: Size): string[] {
  const w = num(size.width), h = num(size.height);
  switch (template.kind) {
    case 'blank': return [];
    case 'lined': {
      const ys = steps(RULE_SPACING[template.rule], size.height, FIRST_LINE);
      const out = [linePath(ys.map(y => `M0 ${num(y)}H${w}`).join(''))];
      if (template.margin) out.push(`<path fill="none" stroke="${MARGIN_COLOR}" stroke-width="1" d="M${MARGIN_X} 0V${h}"/>`);
      return out;
    }
    case 'grid': {
      const s = GRID_SPACING[template.spacing];
      const d = steps(s, size.height).map(y => `M0 ${num(y)}H${w}`).join('') +
        steps(s, size.width).map(x => `M${num(x)} 0V${h}`).join('');
      return [linePath(d)];
    }
    case 'dots': {
      // Each dot is a small circle of two arcs, radius 0.5 px, stroked 1 px wide: a dot of
      // radius about 1 px. (Not zero-length round-capped segments: WebKit has a history of
      // not drawing those.) Each circle starts and ends at its left point, so relative moves
      // step from dot to dot. Rows start one spacing in and stop at least half a spacing from
      // the right and bottom.
      const s = GRID_SPACING[template.spacing];
      const xs = steps(s, size.width - s / 2), ys = steps(s, size.height - s / 2);
      if (!xs.length || !ys.length) return [];
      const dot = 'a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0';
      const row = dot + `m${num(s)} 0${dot}`.repeat(xs.length - 1);
      const d = ys.map(y => `M${num(xs[0] - 0.5)} ${num(y)}${row}`).join('');
      return [`<path class="t" fill="none" stroke-width="1" d="${d}"/>`];
    }
    case 'fill': {
      if (!FILL_RE.test(template.color)) throw new Error('Invalid page template: fill color is not #rrggbb');
      return [`<rect x="0" y="0" width="${w}" height="${h}" fill="${template.color}"/>`];
    }
    case 'pdf': {
      // The page image, stretched to the page (its pixel size rounds a little differently).
      if (!template.image) return [];
      if (!IMAGE_RE.test(template.image)) throw new Error('Invalid page template: pdf image is not a base64 data URL');
      return [`<image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" href="${template.image}"/>`];
    }
    case 'image': {
      // The image fills the page, which was sized to its aspect (#12).
      if (!template.image) return [];
      if (!IMAGE_RE.test(template.image)) throw new Error('Invalid page template: image is not a base64 data URL');
      return [`<image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" href="${template.image}"/>`];
    }
  }
  return unknownKind((template as { kind: string }).kind);
}

function unknownKind(kind: string): never {
  throw new Error(`Unknown page template "${kind}"`);
}

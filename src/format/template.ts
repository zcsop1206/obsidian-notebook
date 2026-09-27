// Page templates: the model stored in a page's <metadata> and the renderer for its
// <g id="template"> layer. Built-in kinds: blank, lined, grid and dots (#19); #14/#21 add PDF
// page images. Each new kind adds a member to `Template`, a case to `parseTemplate`, a case to
// `renderTemplate`, and names in BUILT_IN_TEMPLATES.
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

/** A page's template, discriminated by `kind`. Extend this union with new kinds. */
export type Template = BlankTemplate | LinedTemplate | GridTemplate | DotsTemplate;
export type TemplateKind = Template['kind'];

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
  return unknownKind(kind);
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
  const v = value as { kind: string; rule?: unknown; margin?: unknown; spacing?: unknown };
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
  }
  return unknownKind(v.kind);
}

// ---- names

export interface BuiltInTemplate {
  /** For frontmatter and settings, e.g. `lined-college-margin`. */
  name: string;
  /** For menus, e.g. "Lined, college rule, with margin". */
  label: string;
  template: Template;
}

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
] as BuiltInTemplate[]);

/** The name of a template, e.g. `grid-quarter-inch`. The inverse of parseTemplateName. */
export function templateName(template: Template): string {
  const t = parseTemplate(template);
  switch (t.kind) {
    case 'blank': return 'blank';
    case 'lined': return `lined-${t.rule}${t.margin ? '-margin' : ''}`;
    case 'grid': return t.spacing === '5mm' ? 'grid-5mm' : 'grid-quarter-inch';
    case 'dots': return 'dots-5mm';
  }
}

export const isTemplateName = (name: string): boolean => BUILT_IN_TEMPLATES.some(b => b.name === name);

/** The template with this name (a fresh object). Throws if there's none. */
export function parseTemplateName(name: string): Template {
  const b = BUILT_IN_TEMPLATES.find(t => t.name === name);
  if (!b) throw new Error(`Unknown template "${name}" (expected ${BUILT_IN_TEMPLATES.map(t => t.name).join(', ')})`);
  return parseTemplate(b.template);
}

/** The menu label of a template, e.g. "Grid, 5 mm". */
export const templateLabel = (template: Template): string =>
  BUILT_IN_TEMPLATES.find(b => b.name === templateName(template))!.label;

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
      // Each dot is a zero-length subpath with a round cap, 2 px wide: a dot of radius 1 px.
      // Rows start one spacing in and stop at least half a spacing from the right and bottom.
      const s = GRID_SPACING[template.spacing];
      const xs = steps(s, size.width - s / 2), ys = steps(s, size.height - s / 2);
      if (!xs.length || !ys.length) return [];
      const row = 'h0' + `m${num(s)} 0h0`.repeat(xs.length - 1);
      const d = ys.map(y => `M${num(xs[0])} ${num(y)}${row}`).join('');
      return [`<path class="t" fill="none" stroke-width="2" stroke-linecap="round" d="${d}"/>`];
    }
  }
  return unknownKind((template as { kind: string }).kind);
}

function unknownKind(kind: string): never {
  throw new Error(`Unknown page template "${kind}"`);
}

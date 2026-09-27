// Page templates: the model stored in a page's <metadata> and the renderer for its
// <g id="template"> layer. Only `blank` exists so far; #19 adds lined, grid and dots, and
// #14/#21 add PDF page images. Each new kind adds a member to `Template`, a case to
// `parseTemplate` and a case to `renderTemplate`.

export interface Size {
  width: number;
  height: number;
}

/** No lines: the template layer is empty. */
export interface BlankTemplate {
  kind: 'blank';
}

/** A page's template, discriminated by `kind`. Extend this union with new kinds. */
export type Template = BlankTemplate;
export type TemplateKind = Template['kind'];

export const TEMPLATE_KINDS: readonly TemplateKind[] = ['blank'];

export const isTemplateKind = (s: string): s is TemplateKind => (TEMPLATE_KINDS as readonly string[]).includes(s);

/** The default template for a kind name, as used by a note's `template:` frontmatter. */
export function defaultTemplate(kind: TemplateKind): Template {
  switch (kind) {
    case 'blank': return { kind: 'blank' };
  }
  return unknownKind(kind);
}

/**
 * Validates a template read from a page's metadata and returns it in canonical form (fixed
 * key order, so writing it again gives the same bytes).
 */
export function parseTemplate(value: unknown): Template {
  if (typeof value !== 'object' || value === null || typeof (value as { kind?: unknown }).kind !== 'string') {
    throw new Error('Invalid page template: expected an object with a "kind"');
  }
  const kind = (value as { kind: string }).kind;
  switch (kind) {
    case 'blank': return { kind: 'blank' };
  }
  return unknownKind(kind);
}

/**
 * The contents of a page's <g id="template"> layer, one SVG element per string. Lines use
 * `class="t"`, whose stroke colour follows dark mode through the page's <style>.
 */
export function renderTemplate(template: Template, size: Size): string[] {
  void size;
  switch (template.kind) {
    case 'blank': return [];
  }
  return unknownKind((template as { kind: string }).kind);
}

function unknownKind(kind: string): never {
  throw new Error(`Unknown page template "${kind}"`);
}

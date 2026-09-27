// Pure pieces of choosing, changing and importing templates (#54, #56), unit-tested: the rows of
// every template list (favourites first), page sizes as the owner reads them, the question asked
// before a template change resizes pages (#56), and the pages a PDF imported into an open note
// becomes (#54).
import { A4, LETTER, type Size } from '../format/page';
import { BUILT_IN_TEMPLATES, type PdfTemplate, type Template } from '../format/template';
import { orderFavourites } from './favourites';
import type { TemplateEntry } from './templates';

/** One row: a template and the page size it comes in, if any, or the custom-size entry. */
export interface TemplateItem {
  label: string;
  /** `blank`, `sticky-3in`, `tpl:<name>`…, or '' for "Custom size…". */
  name: string;
  template: Template | null;
  size?: Size;
  /** A custom template from the templates folder (#54): it has a preview, rename and delete. */
  custom?: boolean;
}

export const CUSTOM_SIZE_LABEL = 'Custom size…';

/** A custom template's label in menus: its name and what it is. */
export function customLabel(e: Pick<TemplateEntry, 'label' | 'template'>): string {
  const kind = e.template.kind === 'pdf' ? 'PDF' : e.template.kind === 'image' ? 'image' : 'custom';
  return `${e.label} (${kind})`;
}

/**
 * The rows: built-ins, then custom templates, the favourites among them moved first in the
 * order they were starred, then (if `custom`) "Custom size…".
 */
export function templateItems(entries: readonly TemplateEntry[], custom: boolean, favourites: readonly string[] = []): TemplateItem[] {
  const items: TemplateItem[] = BUILT_IN_TEMPLATES.map(b => ({ label: b.label, name: b.name, template: b.template, size: b.size }));
  for (const e of entries) items.push({ label: customLabel(e), name: e.name, template: e.template, size: e.size, custom: true });
  const ordered = orderFavourites(items, i => i.name, favourites);
  if (custom) ordered.push({ label: CUSTOM_SIZE_LABEL, name: '', template: null });
  return ordered;
}


export const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height;

/** A length in px as inches, to 0.01 in (96 px per inch). */
const inches = (px: number) => String(Math.round(px / 96 * 100) / 100);

/** A size in inches: `3 × 3 in`. */
export const inchesLabel = (size: Size): string => `${inches(size.width)} × ${inches(size.height)} in`;

/** A size as the owner knows it: `Letter (8.5 × 11 in)`, `A4 (8.27 × 11.69 in)` or `3 × 3 in`. */
export function sizeLabel(size: Size): string {
  const name = sameSize(size, LETTER) ? 'Letter' : sameSize(size, A4) ? 'A4' : null;
  return name ? `${name} (${inchesLabel(size)})` : inchesLabel(size);
}

const INK_OUTSIDE = "Ink outside the new size stays in the file but won't be visible.";

/** The question before one page is resized to a template's size (#56). */
export function resizeMessage(page: Size, template: Size): string {
  return `This page is ${sizeLabel(page)}; the template is ${sizeLabel(template)}. Resize the page to the template's size? ${INK_OUTSIDE}`;
}

/** The pages (of `sizes`) whose size isn't `size`. */
export const resizedCount = (sizes: readonly Size[], size: Size): number => sizes.filter(s => !sameSize(s, size)).length;

/** The question before a template change of every page resizes `changed` of `total` pages (#56). */
export function resizeAllMessage(changed: number, total: number, template: Size): string {
  const which = changed === total ? (total === 1 ? 'The page' : `All ${total} pages`) : `${changed} of ${total} pages`;
  const are = changed === 1 ? 'is' : 'are';
  return `${which} ${are} a different size from the template, ${sizeLabel(template)}. Resize ${changed === 1 ? 'it' : 'them'} to the template's size? ${INK_OUTSIDE}`;
}

/** A rendered PDF page: its size in px and its image (a JPEG data URL, or '' if it didn't render). */
export interface RenderedPdfPage {
  size: Size;
  image: string;
}

/**
 * The pages a PDF imported into an open note becomes (#54): one per PDF page, in order, each at
 * its page's size with a pdf template of that page whose source is the PDF's copy in the note's
 * page folder (`source`, a file name there).
 */
export function pdfPages(source: string, rendered: readonly RenderedPdfPage[]): { template: PdfTemplate; size: Size }[] {
  return rendered.map((r, i) => ({ template: { kind: 'pdf', source, page: i + 1, image: r.image }, size: { width: r.size.width, height: r.size.height } }));
}

/** Where a PDF can be copied into a folder: `<base>.pdf`, `<base> 1.pdf`… the first free one (`taken` says). */
export function pdfCopyName(base: string, taken: (fileName: string) => boolean): string {
  if (!taken(`${base}.pdf`)) return `${base}.pdf`;
  for (let i = 1; ; i++) if (!taken(`${base} ${i}.pdf`)) return `${base} ${i}.pdf`;
}

// Pure pieces of choosing and importing templates (#54), unit-tested: the rows of every template
// list (favourites first), and the pages a PDF imported into an open note becomes.
import type { Size } from '../format/page';
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

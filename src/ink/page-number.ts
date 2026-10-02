// The page indicator's text and what a typed page number means (#64); pure, for go-to-page.ts.

/** The indicator's text for page `index` (0-based) of `total`, or '' with no pages. */
export const pageLabel = (index: number, total: number) => (total > 0 ? `${Math.max(0, index) + 1} / ${total}` : '');

/**
 * The 0-based page a typed page number means in a note of `total` pages: the first number in
 * the text ("37", " 37 ", "37 / 812"), clamped to the note. Null if there is no number or no page.
 */
export function parsePageNumber(text: string, total: number): number | null {
  const m = /-?\d+/.exec(text);
  if (!m || total <= 0) return null;
  const n = parseInt(m[0], 10);
  return Math.max(1, Math.min(total, n)) - 1;
}

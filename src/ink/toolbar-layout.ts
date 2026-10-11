// The toolbar's layout rules (#71), pure so the unit tests can check them without a DOM.
//
// The toolbar is one row that never wraps. What it shows depends on its width: at 900 px and up
// an inline strip of colours sits between the tools and the favourites; then, from the roomiest
// layout down, the first one whose buttons fit is used: the page actions with "Page" and
// "Import" labelled, the same without the labels, the page actions folded into a "⋯" overflow
// menu (undo and redo stay out), and last, if even that is too wide, without the colour strip.
// toolbar.ts measures each candidate in turn (scrollWidth against clientWidth), so the result
// follows the real button sizes, fonts and Obsidian's own styles rather than a guessed width.
//
// Also here: the toolbar's two button sizes (a setting, for the owner's hand and screen) and the
// width of the size bar drawn under the pen and highlighter buttons.
import { HIGHLIGHTER_MAX_SIZE, HIGHLIGHTER_MIN_SIZE, MAX_SIZE, MIN_SIZE } from './pen';

/** The toolbar's width from which the inline colour strip is shown, in CSS px. */
export const STRIP_MIN_WIDTH = 900;

export interface ToolbarLayout {
  /** The inline colour strip is shown. */
  strip: boolean;
  /** The page actions (all but undo and redo) are in the "⋯" menu. */
  collapsed: boolean;
  /** "Page" and "Import" show their text labels. */
  labels: boolean;
}

/** The layouts to try at a toolbar width, roomiest first; the first that fits is used. */
export function toolbarLayouts(width: number): ToolbarLayout[] {
  const strip = width >= STRIP_MIN_WIDTH;
  const out: ToolbarLayout[] = [
    { strip, collapsed: false, labels: true },
    { strip, collapsed: false, labels: false },
    { strip, collapsed: true, labels: false },
  ];
  if (strip) out.push({ strip: false, collapsed: true, labels: false });
  return out;
}

/** The toolbar's button sizes (setting "Toolbar size"). */
export type ToolbarSize = 'compact' | 'comfortable';
export const TOOLBAR_SIZES: readonly ToolbarSize[] = ['compact', 'comfortable'];
/** Button side in CSS px for each toolbar size. */
export const TOOLBAR_BUTTON_PX: Readonly<Record<ToolbarSize, number>> = Object.freeze({ compact: 36, comfortable: 44 });
export const DEFAULT_TOOLBAR_SIZE: ToolbarSize = 'comfortable';

/** A toolbar size read from settings, or the default. */
export function parseToolbarSize(v: unknown): ToolbarSize {
  return TOOLBAR_SIZES.includes(v as ToolbarSize) ? (v as ToolbarSize) : DEFAULT_TOOLBAR_SIZE;
}

/** The longest size bar under a tool button, in CSS px (fits a compact button). */
export const SIZE_BAR_MAX = 26;
const SIZE_BAR_MIN = 4;

/**
 * The width of the 3 px bar under the pen or highlighter button: grows with the size over the
 * tool's whole range, on the same log scale as the size slider, so 0.5 px and 16 px (or 4 and 48
 * for the highlighter) are the shortest and longest bars.
 */
export function sizeBarWidth(tool: 'pen' | 'highlighter', size: number): number {
  const [min, max] = tool === 'highlighter' ? [HIGHLIGHTER_MIN_SIZE, HIGHLIGHTER_MAX_SIZE] : [MIN_SIZE, MAX_SIZE];
  const s = Math.min(max, Math.max(min, Number.isFinite(size) ? size : min));
  const u = Math.log(s / min) / Math.log(max / min);
  return Math.round(SIZE_BAR_MIN + (SIZE_BAR_MAX - SIZE_BAR_MIN) * u);
}

// Pen settings (#5): the nib, colour and size the next stroke is written with. Held in memory
// by the ink view; persistence and the real picker are #10.
import { DEFAULT_INK, NIBS, type Nib } from '../format/page';

/** The tool the next stroke of the Pencil uses. Highlighter is #6, eraser is #7. */
export type ToolKind = 'pen' | 'highlighter' | 'eraser';
export const TOOL_KINDS: readonly ToolKind[] = ['pen', 'highlighter', 'eraser'];

export interface PenSettings {
  tool: ToolKind;
  nib: Nib;
  /** Lowercase `#rrggbb`; `#000000` is the default ink, drawn in the theme's ink colour. */
  color: string;
  /** Width in page px, 0.5 to 16 in 0.5 steps (for the pressure nib, the width at pressure 0.5). */
  size: number;
}

export const DEFAULT_PEN: Readonly<PenSettings> = Object.freeze({ tool: 'pen', nib: 'uniform', color: DEFAULT_INK, size: 2.5 });

export interface ColorPreset {
  color: string;
  name: string;
}

/** The eight preset colours, default black first. Any other `#rrggbb` is allowed too. */
export const COLOR_PRESETS: readonly ColorPreset[] = Object.freeze([
  { color: DEFAULT_INK, name: 'Black' },
  { color: '#1e6fff', name: 'Blue' },
  { color: '#e0301e', name: 'Red' },
  { color: '#1f9d55', name: 'Green' },
  { color: '#f28c28', name: 'Orange' },
  { color: '#7b4fd6', name: 'Purple' },
  { color: '#ff5fa2', name: 'Pink' },
  { color: '#8a8a8a', name: 'Grey' },
]);

/** The three quick sizes. */
export const SIZE_PRESETS: readonly number[] = Object.freeze([1.5, 2.5, 4]);

export const MIN_SIZE = 0.5;
export const MAX_SIZE = 16;
export const SIZE_STEP = 0.5;

/** Limits a size to 0.5–16 px, rounded to the nearest 0.5 px. */
export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PEN.size;
  const r = Math.round(n / SIZE_STEP) * SIZE_STEP;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, r));
}

/** The colour as lowercase `#rrggbb`, or null if it isn't one. */
export function parseColor(c: unknown): string | null {
  if (typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/**
 * The settings with `change` applied. Sizes are clamped; an unknown nib or a colour that isn't
 * `#rrggbb` throws.
 */
export function withPen(pen: Readonly<PenSettings>, change: Partial<PenSettings>): PenSettings {
  const next = { ...pen };
  if (change.tool !== undefined) {
    if (!TOOL_KINDS.includes(change.tool)) throw new Error(`Unknown tool ${JSON.stringify(change.tool)} (expected ${TOOL_KINDS.join(', ')})`);
    next.tool = change.tool;
  }
  if (change.nib !== undefined) {
    if (!NIBS.includes(change.nib)) throw new Error(`Unknown nib ${JSON.stringify(change.nib)} (expected ${NIBS.join(' or ')})`);
    next.nib = change.nib;
  }
  if (change.color !== undefined) {
    const color = parseColor(change.color);
    if (!color) throw new Error(`Invalid pen colour ${JSON.stringify(change.color)} (expected #rrggbb)`);
    next.color = color;
  }
  if (change.size !== undefined) next.size = clampSize(change.size);
  return next;
}

/** The preset after `color`, wrapping round; a custom colour goes to the first preset. */
export function nextColor(color: string): string {
  const i = COLOR_PRESETS.findIndex(c => c.color === color);
  return COLOR_PRESETS[(i + 1) % COLOR_PRESETS.length].color;
}

/** The smallest preset size above `size`, or the first preset after the largest. */
export function nextSize(size: number): number {
  return SIZE_PRESETS.find(s => s > size) ?? SIZE_PRESETS[0];
}

// ---- the highlighter (#6)

/** The highlighter's own colour and size, kept while the pen is in use. */
export interface HighlighterSettings {
  /** Lowercase `#rrggbb`, drawn as is in both themes. */
  color: string;
  /** Width in page px, 4 to 48 in 0.5 steps. */
  size: number;
}

export const DEFAULT_HIGHLIGHTER: Readonly<HighlighterSettings> = Object.freeze({ color: '#ffd400', size: 18 });

/** The five highlighter colours, yellow first. */
export const HIGHLIGHTER_COLORS: readonly ColorPreset[] = Object.freeze([
  { color: '#ffd400', name: 'Yellow' },
  { color: '#3ddc84', name: 'Green' },
  { color: '#ff5fa2', name: 'Pink' },
  { color: '#4fc3f7', name: 'Blue' },
  { color: '#ffa726', name: 'Orange' },
]);

/** The two highlighter sizes. */
export const HIGHLIGHTER_SIZES: readonly number[] = Object.freeze([14, 24]);

export const HIGHLIGHTER_MIN_SIZE = 4;
export const HIGHLIGHTER_MAX_SIZE = 48;

/** Limits a highlighter size to 4–48 px, rounded to the nearest 0.5 px. */
export function clampHighlighterSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HIGHLIGHTER.size;
  const r = Math.round(n / SIZE_STEP) * SIZE_STEP;
  return Math.min(HIGHLIGHTER_MAX_SIZE, Math.max(HIGHLIGHTER_MIN_SIZE, r));
}

/** The settings with `change` applied. Sizes are clamped; a colour that isn't `#rrggbb` throws. */
export function withHighlighter(settings: Readonly<HighlighterSettings>, change: Partial<HighlighterSettings>): HighlighterSettings {
  const next = { ...settings };
  if (change.color !== undefined) {
    const color = parseColor(change.color);
    if (!color) throw new Error(`Invalid highlighter colour ${JSON.stringify(change.color)} (expected #rrggbb)`);
    next.color = color;
  }
  if (change.size !== undefined) next.size = clampHighlighterSize(change.size);
  return next;
}

/** The highlighter preset after `color`, wrapping round; a custom colour goes to the first preset. */
export function nextHighlighterColor(color: string): string {
  const i = HIGHLIGHTER_COLORS.findIndex(c => c.color === color);
  return HIGHLIGHTER_COLORS[(i + 1) % HIGHLIGHTER_COLORS.length].color;
}

/** The smallest highlighter size above `size`, or the first after the largest. */
export function nextHighlighterSize(size: number): number {
  return HIGHLIGHTER_SIZES.find(s => s > size) ?? HIGHLIGHTER_SIZES[0];
}

// ---- the eraser (#7)

/** The stroke eraser's settings. Held next to the pen by the ink view. */
export interface EraserSettings {
  /** Hit radius in page px: one of ERASER_SIZES. */
  size: number;
}

/** The two eraser sizes: hit radius in page px. */
export const ERASER_SIZES: readonly number[] = Object.freeze([6, 14]);

export const DEFAULT_ERASER: Readonly<EraserSettings> = Object.freeze({ size: 6 });

/** The settings with `change` applied. A size goes to the nearest preset; a non-number throws. */
export function withEraser(eraser: Readonly<EraserSettings>, change: Partial<EraserSettings>): EraserSettings {
  const next = { ...eraser };
  if (change.size !== undefined) {
    const n = change.size;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`Invalid eraser size ${JSON.stringify(n)} (expected ${ERASER_SIZES.join(' or ')})`);
    next.size = ERASER_SIZES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best));
  }
  return next;
}

/** The eraser size after `size`, wrapping round. */
export function nextEraserSize(size: number): number {
  return ERASER_SIZES.find(s => s > size) ?? ERASER_SIZES[0];
}

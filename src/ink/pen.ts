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

// Pen settings (#5): the nib, colour and size the next stroke is written with. Held by the ink
// view and saved in the plugin settings with the favourite presets (#10: see the end).
import { DEFAULT_INK, NIBS, type Nib } from '../format/page';

/**
 * The tool the next stroke of the Pencil uses. Highlighter is #6, eraser is #7, lasso is #11
 * (it selects strokes instead of writing; like the eraser, it can't be a favourite preset).
 */
export type ToolKind = 'pen' | 'highlighter' | 'eraser' | 'lasso';
export const TOOL_KINDS: readonly ToolKind[] = ['pen', 'highlighter', 'eraser', 'lasso'];

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

/**
 * How the eraser erases: `partial` (#15, the default, as Notability's) cuts out only the part of
 * a stroke under it and keeps the rest; `stroke` (#7) removes every stroke it touches whole.
 */
export type EraserMode = 'partial' | 'stroke';
export const ERASER_MODES: readonly EraserMode[] = ['partial', 'stroke'];

/** The eraser's settings. Held next to the pen by the ink view. */
export interface EraserSettings {
  /** Hit radius in page px: one of ERASER_SIZES. */
  size: number;
  mode: EraserMode;
}

/** The two eraser sizes: hit radius in page px. */
export const ERASER_SIZES: readonly number[] = Object.freeze([6, 14]);

export const DEFAULT_ERASER: Readonly<EraserSettings> = Object.freeze({ size: 6, mode: 'partial' });

/** The settings with `change` applied. A size goes to the nearest preset; a non-number or an unknown mode throws. */
export function withEraser(eraser: Readonly<EraserSettings>, change: Partial<EraserSettings>): EraserSettings {
  const next = { ...eraser };
  if (change.size !== undefined) {
    const n = change.size;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`Invalid eraser size ${JSON.stringify(n)} (expected ${ERASER_SIZES.join(' or ')})`);
    next.size = ERASER_SIZES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best));
  }
  if (change.mode !== undefined) {
    if (!ERASER_MODES.includes(change.mode)) throw new Error(`Invalid eraser mode ${JSON.stringify(change.mode)} (expected ${ERASER_MODES.join(' or ')})`);
    next.mode = change.mode;
  }
  return next;
}

/** The eraser size after `size`, wrapping round. */
export function nextEraserSize(size: number): number {
  return ERASER_SIZES.find(s => s > size) ?? ERASER_SIZES[0];
}

// ---- the toolbar (#10): size stepping, favourite presets and the saved tool state

/** `size` moved one 0.5 px step thinner (dir -1) or thicker (+1), clamped for the tool. */
export function stepSize(tool: 'pen' | 'highlighter', size: number, dir: -1 | 1): number {
  const next = size + dir * SIZE_STEP;
  return tool === 'highlighter' ? clampHighlighterSize(next) : clampSize(next);
}

/** A favourite: a tool with its colour, size and (for the pen) nib, applied with one tap. */
export interface PenPreset {
  tool: 'pen' | 'highlighter';
  /** Lowercase `#rrggbb`. */
  color: string;
  size: number;
  /** The pen's nib; absent for the highlighter. */
  nib?: Nib;
}

/** At most this many favourites (#10: more is out of scope). */
export const MAX_PRESETS = 5;

export const DEFAULT_PRESETS: readonly PenPreset[] = Object.freeze([
  { tool: 'pen', color: DEFAULT_INK, size: 2.5, nib: 'uniform' },
  { tool: 'pen', color: '#1e6fff', size: 2.5, nib: 'uniform' },
  { tool: 'pen', color: '#e0301e', size: 2.5, nib: 'uniform' },
  { tool: 'pen', color: DEFAULT_INK, size: 4, nib: 'pressure' },
  { tool: 'highlighter', color: '#ffd400', size: 18 },
] satisfies PenPreset[]);

/** A preset read from settings, normalised (size clamped for its tool), or null if it isn't one. */
export function parsePreset(v: unknown): PenPreset | null {
  if (typeof v !== 'object' || v === null) return null;
  const d = v as Record<string, unknown>;
  const color = parseColor(d.color);
  if ((d.tool !== 'pen' && d.tool !== 'highlighter') || !color || typeof d.size !== 'number' || !Number.isFinite(d.size)) return null;
  if (d.tool === 'highlighter') return { tool: 'highlighter', color, size: clampHighlighterSize(d.size) };
  const nib = d.nib === undefined ? 'uniform' : d.nib;
  if (!NIBS.includes(nib as Nib)) return null;
  return { tool: 'pen', color, size: clampSize(d.size), nib: nib as Nib };
}

/**
 * The presets read from settings: each slot a preset or null (an empty slot), at most
 * MAX_PRESETS. Invalid entries become empty slots, with a warning; a missing or non-array value
 * gives the defaults.
 */
export function parsePresets(v: unknown): (PenPreset | null)[] {
  if (v === undefined) return DEFAULT_PRESETS.map(p => ({ ...p }));
  if (!Array.isArray(v)) {
    console.warn('[notebook]', 'Favourite presets in settings are not a list; using the defaults');
    return DEFAULT_PRESETS.map(p => ({ ...p }));
  }
  if (v.length > MAX_PRESETS) console.warn('[notebook]', `${v.length} favourite presets in settings; keeping the first ${MAX_PRESETS}`);
  return v.slice(0, MAX_PRESETS).map((x, i) => {
    if (x === null) return null;
    const p = parsePreset(x);
    if (!p) console.warn('[notebook]', `Invalid favourite preset ${i + 1} in settings: ${JSON.stringify(x)}; slot left empty`);
    return p;
  });
}

/** The preset for the tool in use, or null for the eraser and the lasso. */
export function presetOf(pen: Readonly<PenSettings>, highlighter: Readonly<HighlighterSettings>): PenPreset | null {
  if (pen.tool === 'pen') return { tool: 'pen', color: pen.color, size: pen.size, nib: pen.nib };
  if (pen.tool === 'highlighter') return { tool: 'highlighter', color: highlighter.color, size: highlighter.size };
  return null;
}

/** Whether the tool in use and its settings are exactly the preset's. */
export function matchesPreset(preset: Readonly<PenPreset> | null, pen: Readonly<PenSettings>, highlighter: Readonly<HighlighterSettings>): boolean {
  if (!preset || preset.tool !== pen.tool) return false;
  if (preset.tool === 'highlighter') return preset.color === highlighter.color && preset.size === highlighter.size;
  return preset.color === pen.color && preset.size === pen.size && (preset.nib ?? 'uniform') === pen.nib;
}

/** Every tool's current settings, saved in the plugin settings so they survive a restart. */
export interface ToolState {
  pen: PenSettings;
  highlighter: HighlighterSettings;
  eraser: EraserSettings;
}

export const DEFAULT_TOOL_STATE: Readonly<ToolState> = Object.freeze({ pen: { ...DEFAULT_PEN }, highlighter: { ...DEFAULT_HIGHLIGHTER }, eraser: { ...DEFAULT_ERASER } });

/**
 * The tool state read from settings. Each field is checked on its own: an invalid one keeps its
 * default, with a warning.
 */
export function parseToolState(v: unknown): ToolState {
  const out: ToolState = { pen: { ...DEFAULT_PEN }, highlighter: { ...DEFAULT_HIGHLIGHTER }, eraser: { ...DEFAULT_ERASER } };
  if (v === undefined) return out;
  if (typeof v !== 'object' || v === null) {
    console.warn('[notebook]', `Invalid tool settings ${JSON.stringify(v)}; using the defaults`);
    return out;
  }
  const d = v as Record<string, unknown>;
  const obj = (x: unknown) => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {});
  const apply = <T>(name: string, value: unknown, fn: (value: unknown) => T): T | undefined => {
    if (value === undefined) return undefined;
    try {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('not a number');
      return fn(value);
    } catch (e) {
      console.warn('[notebook]', `Invalid ${name} ${JSON.stringify(value)} in settings; using the default (${(e as Error).message})`);
      return undefined;
    }
  };
  const num = (value: unknown) => {
    if (typeof value !== 'number') throw new Error('not a number');
    return value;
  };
  const p = obj(d.pen), h = obj(d.highlighter), e = obj(d.eraser);
  out.pen = withPen(out.pen, {
    tool: apply('tool', p.tool, t => withPen(DEFAULT_PEN, { tool: t as ToolKind }).tool),
    nib: apply('pen nib', p.nib, n => withPen(DEFAULT_PEN, { nib: n as Nib }).nib),
    color: apply('pen colour', p.color, c => withPen(DEFAULT_PEN, { color: c as string }).color),
    size: apply('pen size', p.size, s => clampSize(num(s))),
  });
  out.highlighter = withHighlighter(out.highlighter, {
    color: apply('highlighter colour', h.color, c => withHighlighter(DEFAULT_HIGHLIGHTER, { color: c as string }).color),
    size: apply('highlighter size', h.size, s => clampHighlighterSize(num(s))),
  });
  out.eraser = withEraser(out.eraser, {
    size: apply('eraser size', e.size, s => withEraser(DEFAULT_ERASER, { size: num(s) }).size),
    mode: apply('eraser mode', e.mode, m => withEraser(DEFAULT_ERASER, { mode: m as EraserMode }).mode),
  });
  return out;
}

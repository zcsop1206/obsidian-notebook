/*
 * The pen lab (#69), in the ink debug view: one recorded word written with each candidate
 * setting of the uniform pen's "Advanced pen" options side by side, at 100% and 400%, so the
 * owner can compare them on the iPad on one screen and say which should be the default. The
 * word is a cursive word and its i dot from the test fixture (test/fixtures/sample, page 1, the
 * first word; written by test/fixture.ts), moved to the origin; its raw points are drawn as the
 * editor draws a stroke with those settings (strokeGeometry and paintPath, the page bitmap's
 * code), in the theme's ink. 100% is an open ink view's fitted width (CSS px per page px), or
 * 1 CSS px per page px when no ink view is open. Each variant changes one setting from today's
 * pen; "Your settings" is the combination in the plugin settings now.
 */
import { strokeGeometry } from '../format/outline';
import { decodePoints, type PenStroke } from '../format/page';
import { DEFAULT_TUNING, SIZE_PRESETS, SMOOTHING_LEVELS, STABILISER_LEVELS, TAPER_LEVELS, tuningFields, type PenTuning } from '../ink/pen';
import { canvasPath, paintPath, setThinLineBoost, thinLineBoost } from '../ink/renderer';

/** The word's strokes as the file stores points: [x, y, pressure, ms since the previous point]. */
export const LAB_WORD: readonly (readonly number[])[] = [
  [4.7, 26.1, 0.32, 0, 5, 26, 0.39, 4, 5.4, 25.8, 0.42, 5, 5.6, 25.6, 0.51, 4, 6.2, 25.5, 0.58, 4, 6.4, 25.1, 0.63, 4, 7.1, 24.6, 0.68, 4, 7.5, 24.5, 0.7, 5,
    7.8, 23.9, 0.69, 4, 8.2, 23.3, 0.69, 4, 8.6, 22.8, 0.7, 4, 9, 22.2, 0.7, 5, 9.4, 21.5, 0.68, 4, 10.1, 20.8, 0.71, 4, 10.4, 20.2, 0.71, 4, 10.8, 19.7, 0.7, 5,
    11.1, 18.9, 0.71, 4, 11.6, 18.2, 0.7, 4, 11.8, 17.6, 0.69, 3, 12.3, 17.1, 0.71, 4, 12.5, 16.5, 0.68, 4, 12.8, 16.1, 0.7, 4, 12.9, 15.6, 0.71, 5,
    13.2, 15, 0.68, 4, 13.6, 14.6, 0.68, 5, 13.8, 14.4, 0.69, 4, 13.9, 14.4, 0.66, 4, 14, 14.1, 0.65, 4, 14, 14.1, 0.67, 5, 14.2, 14.1, 0.65, 4,
    14.4, 14.2, 0.65, 4, 14.5, 14.4, 0.65, 4, 14.6, 14.4, 0.62, 4, 14.5, 14.7, 0.63, 5, 14.5, 15.2, 0.61, 4, 14.6, 15.6, 0.6, 4, 14.6, 15.9, 0.62, 5,
    14.8, 16.3, 0.6, 3, 14.6, 17, 0.6, 4, 14.8, 17.6, 0.59, 4, 14.7, 18.3, 0.57, 4, 14.7, 18.7, 0.55, 4, 14.9, 19.4, 0.56, 5, 14.9, 20.2, 0.53, 4,
    15, 20.8, 0.51, 4, 15.1, 21.4, 0.53, 5, 15.3, 22, 0.51, 4, 15.4, 22.5, 0.5, 5, 15.6, 23.2, 0.5, 4, 15.6, 23.8, 0.48, 4, 15.9, 24.3, 0.46, 4,
    15.9, 24.6, 0.47, 5, 16.1, 25, 0.44, 3, 16.4, 25.4, 0.45, 4, 16.7, 25.8, 0.45, 5, 17.2, 25.9, 0.42, 4, 17.5, 26.1, 0.42, 4, 17.8, 26.1, 0.41, 5,
    18.2, 26, 0.39, 3, 18.7, 25.9, 0.37, 5, 19.1, 25.8, 0.39, 4, 19.6, 25.4, 0.38, 5, 20, 25.3, 0.38, 3, 20.3, 24.8, 0.34, 5, 21, 24.5, 0.37, 4,
    21.6, 24, 0.35, 5, 22, 23.7, 0.32, 4, 22.2, 23.1, 0.34, 4, 22.8, 22.5, 0.33, 5, 23.1, 21.9, 0.34, 4, 23.7, 21.3, 0.3, 5, 23.9, 20.9, 0.31, 3,
    24.4, 20.3, 0.32, 5, 24.6, 19.8, 0.32, 4, 25.2, 19.1, 0.32, 3, 25.3, 18.6, 0.32, 5, 25.8, 17.8, 0.31, 4, 26, 17.6, 0.31, 4, 26.1, 17, 0.28, 4,
    26.5, 16.7, 0.29, 5, 26.5, 16.1, 0.29, 4, 26.8, 15.9, 0.31, 4, 26.7, 15.6, 0.32, 5, 26.8, 15.4, 0.29, 4, 27, 15.1, 0.32, 5, 27, 15.2, 0.3, 4,
    27.1, 15.2, 0.3, 3, 27.1, 15.3, 0.31, 4, 27.2, 15.3, 0.31, 5, 27.2, 15.6, 0.34, 4, 27.2, 15.8, 0.33, 4, 27.2, 16, 0.32, 4, 27.2, 16.4, 0.36, 4,
    27.2, 17, 0.33, 5, 27.3, 17.4, 0.34, 4, 27, 17.7, 0.35, 4, 27.3, 18.3, 0.39, 4, 27.1, 18.8, 0.36, 4, 27.2, 19.5, 0.37, 4, 27.2, 20.1, 0.4, 4,
    27.3, 20.5, 0.41, 5, 27.5, 21.2, 0.43, 5, 27.6, 21.7, 0.41, 3, 27.6, 22.4, 0.41, 4, 27.8, 22.9, 0.42, 4, 28.1, 23.3, 0.43, 4, 28.1, 23.9, 0.48, 4,
    28.4, 24.4, 0.48, 4, 28.7, 24.7, 0.46, 4, 29, 25.2, 0.49, 5, 29.4, 25.4, 0.51, 4, 29.8, 25.5, 0.52, 4, 30.1, 26, 0.5, 4, 30.6, 26.1, 0.51, 4,
    30.8, 26, 0.54, 4, 31.3, 26, 0.55, 3, 31.9, 25.8, 0.57, 5, 32.6, 25.8, 0.57, 3, 33.2, 25.3, 0.58, 4, 33.8, 25.2, 0.59, 4, 34.5, 24.5, 0.58, 4,
    35.1, 24.3, 0.61, 4, 35.7, 23.6, 0.59, 4, 36.1, 22.9, 0.63, 4, 36.9, 22.5, 0.61, 4, 37.2, 21.6, 0.62, 4, 37.8, 20.9, 0.64, 5, 38.2, 20.2, 0.65, 4,
    38.7, 19.6, 0.65, 4, 39.1, 18.8, 0.67, 4, 39.5, 18, 0.68, 4, 39.8, 17.4, 0.68, 5, 40.3, 16.6, 0.69, 4, 40.5, 15.7, 0.7, 5, 40.6, 15.3, 0.67, 4,
    40.9, 14.5, 0.7, 3, 41, 14, 0.69, 4, 41, 13.5, 0.69, 4, 41.3, 13.2, 0.71, 5, 41.1, 12.9, 0.7, 4, 41.2, 12.6, 0.7, 4, 41, 12.4, 0.7, 4,
    41.2, 12.3, 0.71, 5, 41.1, 12.1, 0.72, 4, 40.9, 12.2, 0.72, 4, 40.8, 12.5, 0.71, 4, 40.6, 12.7, 0.68, 4, 40.4, 12.8, 0.68, 4, 40.5, 13.2, 0.69, 4,
    40.2, 13.6, 0.69, 4, 40, 14.3, 0.7, 4, 39.9, 15, 0.69, 4, 39.8, 15.6, 0.66, 5, 39.7, 16.2, 0.67, 4, 39.8, 16.8, 0.67, 4, 39.5, 17.7, 0.65, 5,
    39.7, 18.4, 0.64, 5, 39.7, 19.1, 0.64, 4, 39.8, 19.7, 0.66, 4, 39.9, 20.4, 0.62, 4, 39.9, 21.2, 0.63, 4, 40.1, 22.1, 0.62, 4, 40.4, 22.6, 0.62, 4,
    40.7, 23.2, 0.59, 4, 41, 23.8, 0.58, 5, 41.2, 24.2, 0.59, 4, 41.7, 24.8, 0.58, 4, 41.9, 25.3, 0.55, 5, 42.6, 25.4, 0.58, 3, 42.9, 25.8, 0.54, 5,
    43.3, 26.1, 0.54, 5, 43.9, 26.1, 0.52, 4],
  [17.2, 4, 0.6, 0],
];

/** The page area the word is drawn in, page px. */
export const LAB_BOX = { width: 48, height: 30 };

/** One cell of the lab: a name and the settings it's written with. */
export interface LabVariant {
  name: string;
  tuning: PenTuning;
}

/** Today's pen, the settings in use, then each other level of each setting on its own. */
export function labVariants(current: Readonly<PenTuning>): LabVariant[] {
  const d = DEFAULT_TUNING, out: LabVariant[] = [{ name: "Today's pen", tuning: { ...d } }, { name: 'Your settings', tuning: { ...current } }];
  for (const [v, label] of SMOOTHING_LEVELS) if (v !== d.smooth) out.push({ name: `Smoothing ${label}`, tuning: { ...d, smooth: v } });
  for (const [v, label] of STABILISER_LEVELS) if (v !== d.stab) out.push({ name: `Stabiliser ${label}`, tuning: { ...d, stab: v } });
  for (const [v, label] of TAPER_LEVELS) if (v !== d.taper) out.push({ name: `Taper ${label}`, tuning: { ...d, taper: v } });
  out.push({ name: 'Thin-line boost', tuning: { ...d, boost: true } });
  return out;
}

/** The word as uniform pen strokes of `size` written with `tuning`. */
export function labStrokes(tuning: Readonly<PenTuning>, size: number): PenStroke[] {
  return LAB_WORD.map((flat, i) => ({
    id: `0000000${i}`, tool: 'pen', nib: 'uniform', color: '#000000', size, points: decodePoints(flat), ...tuningFields(tuning),
  }));
}

/** What the lab needs from the debug view. */
export interface LabHost {
  /** The settings in use ("Your settings"). */
  tuning(): Readonly<PenTuning>;
  /** CSS px per page px at an ink view's 100%, or null. */
  fitScale(): number | null;
  /** The pen size to start with. */
  penSize(): number;
  /** Ink and paper colours. */
  colors(): { ink: string; paper: string };
}

export class PenLab {
  readonly el: HTMLElement;
  private size: number;
  /** Cells drawn, for tests. */
  drawn = 0;

  constructor(parent: HTMLElement, private host: LabHost) {
    this.el = parent.createDiv({ cls: 'nbspike-lab' });
    this.size = host.penSize();
    this.render();
  }

  /** Builds the size row and the cells and draws them. */
  render() {
    const el = this.el, k = this.host.fitScale() ?? 1;
    el.empty();
    const bar = el.createDiv({ cls: 'nbspike-lab-bar' });
    bar.createSpan({ text: `Pen lab (#69): uniform pen at ${this.size} px; 100% is ${Math.round(k * 100) / 100} CSS px per page px${this.host.fitScale() ? '' : ' (no ink view open)'}. Size:` });
    for (const s of [0.5, 1, ...SIZE_PRESETS]) {
      const b = bar.createEl('button', { cls: 'nbspike-lab-size', text: `${s}` });
      b.toggleClass('is-active', s === this.size);
      b.addEventListener('click', () => {
        this.size = s;
        this.render();
      });
    }
    const grid = el.createDiv({ cls: 'nbspike-lab-grid' });
    const before = thinLineBoost(), { ink, paper } = this.host.colors();
    try {
      for (const v of labVariants(this.host.tuning())) {
        const cell = grid.createDiv({ cls: 'nbspike-lab-cell' });
        cell.dataset.name = v.name;
        cell.createDiv({ cls: 'nbspike-lab-name', text: v.name });
        const row = cell.createDiv({ cls: 'nbspike-lab-row' });
        for (const zoom of [1, 4]) this.draw(row, v.tuning, k, zoom, ink, paper);
        this.drawn++;
      }
    } finally {
      setThinLineBoost(before);
    }
  }

  /** One canvas: the word at `zoom` × `k` CSS px per page px, at device resolution. */
  private draw(parent: HTMLElement, tuning: PenTuning, k: number, zoom: number, ink: string, paper: string) {
    const scale = k * zoom, dpr = window.devicePixelRatio || 1;
    const w = Math.ceil(LAB_BOX.width * scale), h = Math.ceil(LAB_BOX.height * scale);
    const c = parent.createEl('canvas', { cls: 'nbspike-lab-canvas' });
    c.dataset.zoom = String(zoom);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    setThinLineBoost(tuning.boost);
    for (const s of labStrokes(tuning, this.size)) {
      const g = strokeGeometry(s);
      paintPath(ctx, s, canvasPath(s, g.d), ink, g.ends ? new Path2D(g.ends) : null);
    }
  }
}

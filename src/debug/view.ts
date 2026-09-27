/*
 * The ink debug view: the spike's pen and audio test, moved over as-is. A graph-paper canvas
 * with Clear, Save page and Record, and a readout of Apple Pencil measurements (sample rate,
 * pressure, tilt, coalesced and predicted events, handler delay). Save page writes an SVG and
 * the measurements under _spike/.
 */
import { ItemView, Notice } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { Recorder } from './recorder';
import { type InkStroke, toSvg, width } from './ink-svg';
import { ROOT, appendText, ensureDir, fmt, kb, median, mmss, stamp, yn } from './util';

export const VIEW_TYPE_DEBUG = 'notebook-debug';

/** A stroke while it is drawn, with the counters the readout needs. */
interface LiveStroke extends InkStroke {
  id: number;
  ts0: number;
  events: number;
  samples: number;
  delays: number[];
  pmin: number;
  pmax: number;
  predicted: number;
}

interface StrokeStats {
  type: string;
  eventsPerS: number;
  samplesPerS: number;
  delay: number;
  pmin: number;
  pmax: number;
  predicted: number;
}

interface Measurements {
  cancels: number;
  touches: number;
  hovers: number;
  coalesced: boolean | null;
  predicted: boolean | null;
  last: { type: string; p: number; tiltX: number; tiltY: number; alt?: number; az?: number } | null;
}

export class DebugView extends ItemView {
  plugin: { recorder: Recorder };
  strokes: LiveStroke[] = [];
  stats: StrokeStats[] = [];
  cur: LiveStroke | null = null;
  m: Measurements = { cancels: 0, touches: 0, hovers: 0, coalesced: null, predicted: null, last: null };
  recButton!: HTMLButtonElement;
  hud!: HTMLDivElement;
  page!: HTMLDivElement;
  canvas!: HTMLCanvasElement;
  ctx!: CanvasRenderingContext2D;
  observer?: ResizeObserver;
  rect!: DOMRect;
  color = '';
  size!: { w: number; h: number };

  constructor(leaf: WorkspaceLeaf, plugin: { recorder: Recorder }) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE_DEBUG; }
  getDisplayText() { return 'Ink debug'; }
  getIcon() { return 'pencil'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('nbspike');
    const bar = root.createDiv({ cls: 'nbspike-bar' });
    const button = (label: string, fn: () => unknown) => {
      const b = bar.createEl('button', { text: label });
      b.addEventListener('click', fn);
      return b;
    };
    button('Clear', () => this.clear());
    button('Save page', () => this.save());
    this.recButton = button('Record', () => this.plugin.recorder.toggle());
    this.hud = root.createDiv({ cls: 'nbspike-hud' });
    this.page = root.createDiv({ cls: 'nbspike-page' });
    this.canvas = this.page.createEl('canvas');
    this.ctx = (this.canvas.getContext('2d', { desynchronized: true }) || this.canvas.getContext('2d'))!;

    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.down(e));
    c.addEventListener('pointermove', e => this.move(e));
    c.addEventListener('pointerup', e => this.up(e));
    c.addEventListener('pointercancel', e => this.up(e));
    // Keep Pencil drags from scrolling, selecting text or opening Obsidian's sidebars.
    const block = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    c.addEventListener('touchstart', block, { passive: false });
    c.addEventListener('touchmove', block, { passive: false });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.page);
    this.registerInterval(window.setInterval(() => this.renderHud(), 250));
    this.resize();
    this.renderHud();
  }

  async onClose() {
    if (this.observer) this.observer.disconnect();
  }

  resize() {
    const w = this.page.clientWidth, h = this.page.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = { w, h };
    this.redraw();
  }

  inkColor() {
    return getComputedStyle(this.contentEl).getPropertyValue('--text-normal').trim() || '#222';
  }

  redraw() {
    this.color = this.inkColor();
    this.ctx.clearRect(0, 0, this.size.w, this.size.h);
    for (const s of this.strokes) this.paint(s, 0);
  }

  paint(s: InkStroke, from: number) {
    const ctx = this.ctx, pts = s.pts;
    ctx.strokeStyle = ctx.fillStyle = this.color;
    ctx.lineCap = ctx.lineJoin = 'round';
    if (pts.length === 1 && from === 0) {
      const [x, y, p] = pts[0];
      ctx.beginPath();
      ctx.arc(x, y, width(p) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = Math.max(1, from); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.lineWidth = width((a[2] + b[2]) / 2);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }

  down(e: PointerEvent) {
    if (e.pointerType === 'touch') { this.m.touches++; return; }
    if ((e.pointerType === 'mouse' && e.button !== 0) || this.cur) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    this.rect = this.canvas.getBoundingClientRect();
    this.color = this.inkColor();
    this.m.coalesced = typeof e.getCoalescedEvents === 'function';
    this.m.predicted = typeof e.getPredictedEvents === 'function';
    this.cur = { id: e.pointerId, type: e.pointerType, t0: Date.now(), ts0: e.timeStamp, pts: [], events: 0, samples: 0, delays: [], pmin: Infinity, pmax: -Infinity, predicted: 0 };
    this.sample(this.cur, e);
    this.paint(this.cur, 0);
  }

  sample(s: LiveStroke, e: PointerEvent) {
    s.samples++;
    const x = e.clientX - this.rect.left, y = e.clientY - this.rect.top, p = e.pressure;
    s.pmin = Math.min(s.pmin, p);
    s.pmax = Math.max(s.pmax, p);
    this.m.last = { type: e.pointerType, p, tiltX: e.tiltX, tiltY: e.tiltY, alt: e.altitudeAngle, az: e.azimuthAngle };
    const prev = s.pts[s.pts.length - 1];
    if (prev && Math.hypot(x - prev[0], y - prev[1]) < 0.25) return;
    s.pts.push([x, y, p, Math.round(e.timeStamp - s.ts0)]);
  }

  move(e: PointerEvent) {
    const s = this.cur;
    if (!s || e.pointerId !== s.id) {
      if (e.pointerType === 'pen' && e.buttons === 0) this.m.hovers++;
      return;
    }
    e.preventDefault();
    s.events++;
    const delay = performance.now() - e.timeStamp;
    if (delay >= 0 && delay < 1000) s.delays.push(delay);
    const list = this.m.coalesced ? e.getCoalescedEvents() : [];
    const from = s.pts.length;
    for (const ce of list.length ? list : [e]) this.sample(s, ce);
    if (this.m.predicted) s.predicted = Math.max(s.predicted, e.getPredictedEvents().length);
    this.paint(s, from);
  }

  up(e: PointerEvent) {
    const s = this.cur;
    if (!s || e.pointerId !== s.id) return;
    if (e.type === 'pointercancel') this.m.cancels++;
    this.cur = null;
    this.strokes.push(s);
    const dur = s.pts[s.pts.length - 1][3];
    if (dur > 150 && s.events > 3) {
      this.stats.push({
        type: s.type,
        eventsPerS: s.events / dur * 1000,
        samplesPerS: (s.samples - 1) / dur * 1000,
        delay: median(s.delays),
        pmin: s.pmin,
        pmax: s.pmax,
        predicted: s.predicted,
      });
    }
  }

  clear() {
    this.strokes = [];
    this.redraw();
  }

  measured(stats: StrokeStats[]) {
    const med = (k: 'eventsPerS' | 'samplesPerS' | 'delay') => median(stats.map(x => x[k]).filter(Number.isFinite));
    return {
      events: fmt(med('eventsPerS')),
      samples: fmt(med('samplesPerS')),
      delay: fmt(med('delay'), 1),
      predicted: stats.length ? Math.max(...stats.map(x => x.predicted)) : 0,
    };
  }

  renderHud() {
    const m = this.m, L = m.last, last = this.stats[this.stats.length - 1], r = this.measured(this.stats.slice(-10));
    const rec = this.plugin.recorder;
    this.hud.setText([
      L ? `last input: ${L.type}, pressure ${fmt(L.p, 2)}, tilt ${fmt(L.tiltX)}/${fmt(L.tiltY)} deg, altitude ${fmt(L.alt, 2)}, azimuth ${fmt(L.az, 2)} rad`
        : 'last input: none yet, write with the Pencil',
      `last 10 strokes: ${r.events} move events/s, ${r.samples} samples/s, handler delay ${r.delay} ms (median)`,
      `coalesced events ${yn(m.coalesced)}, predicted events ${yn(m.predicted)} (up to ${r.predicted} ahead), last stroke pressure ${last ? `${fmt(last.pmin, 2)} to ${fmt(last.pmax, 2)}` : '-'}`,
      `strokes ${this.strokes.length}, cancelled ${m.cancels}, finger touches ignored ${m.touches}, pen hover events ${m.hovers}`,
      rec.state === 'idle' ? 'audio: idle'
        : `audio: ${rec.state} ${mmss(rec.elapsed)}, ${kb(rec.bytes)}, segment ${rec.segment}, ${rec.lateChunks} late chunks`,
    ].join('\n'));
    this.recButton.setText(rec.state === 'idle' ? 'Record' : 'Stop');
  }

  async save() {
    if (!this.strokes.length) { new Notice('Nothing to save'); return; }
    const a = this.app.vault.adapter;
    await ensureDir(a, ROOT);
    const name = `ink-${stamp()}.svg`;
    const svg = toSvg(this.strokes, this.size);
    await a.write(`${ROOT}/${name}`, svg);
    const r = this.measured(this.stats), m = this.m;
    const points = this.strokes.reduce((n, s) => n + s.pts.length, 0);
    const types = [...new Set(this.strokes.map(s => s.type))].join(', ');
    await appendText(a, `${ROOT}/_results.md`,
      `\n## Ink ${new Date().toLocaleString()}\n\n` +
      `- device: ${navigator.userAgent}\n` +
      `- input: ${types}; ${this.strokes.length} strokes, ${points} points, ${kb(svg.length)} SVG\n` +
      `- median over ${this.stats.length} strokes: ${r.events} move events/s, ${r.samples} samples/s, handler delay ${r.delay} ms\n` +
      `- coalesced events ${yn(m.coalesced)}, predicted events ${yn(m.predicted)} (up to ${r.predicted} ahead)\n` +
      `- cancelled strokes ${m.cancels}, finger touches ignored ${m.touches}, pen hover events ${m.hovers}\n\n` +
      `![](${name})\n`,
      '# Notebook spike results\n');
    new Notice(`Saved ${ROOT}/${name}`);
  }
}

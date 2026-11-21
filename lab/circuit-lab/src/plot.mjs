// An SVG plot that takes ink: axes and grid, ghost layers (an earlier sketch and curve), the solver's
// curves, and the sketch, drawn with the Pencil, a finger or a mouse. Strokes are kept in data
// coordinates, so a plot can be redrawn on new axes. Written by a model.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export const pen = { only: false, seen: false, listeners: new Set() };

export class InkPlot {
  /**
   * opts: { w, h, x: { min, max, log, ticks: [v], fmt(v) }, y: { min, max, ticks, fmt }, xLabel, yLabel,
   *         inkClass, onInk(strokes), mark0 (draw the t = 0 line) }
   */
  constructor(host, opts) {
    this.host = host;
    this.o = { w: 640, h: 300, aspect: 0.47, ...opts };
    this.strokes = [];
    this.ghost = { strokes: [], curves: [] };
    this.truth = [];
    this.locked = false;
    this.svg = el('svg', { class: 'plot', viewBox: `0 0 ${this.o.w} ${this.o.h}`, role: 'img' });
    this.svg.setAttribute('aria-label', `${this.o.yLabel || 'value'} against ${this.o.xLabel || 'x'}; draw on it to sketch`);
    host.appendChild(this.svg);
    this.gAxes = el('g', {}, this.svg);
    this.clip = `clip${Math.random().toString(36).slice(2, 8)}`;
    const defs = el('defs', {}, this.svg);
    this.clipRect = el('rect', {}, el('clipPath', { id: this.clip }, defs));
    this.gGhost = el('g', { 'clip-path': `url(#${this.clip})` }, this.svg);
    this.gTruth = el('g', { 'clip-path': `url(#${this.clip})` }, this.svg);
    this.gInk = el('g', {}, this.svg);
    this.live = null;
    this._wire();
    this.setAxes(opts);
    // The viewBox follows the plot's real width (320 to 640 px), so ticks stay legible on a phone.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { const w = this._width(); if (Math.abs(w - this.o.w) > 8) this.setAxes({}); }).observe(host);
  }

  _width() { const cw = this.host.clientWidth; return cw ? Math.max(320, Math.min(640, Math.round(cw))) : this.o.w; }

  get m() { return { l: 54, r: 14, t: 12, b: 34 }; }
  fx(x) { return this.o.x.log ? Math.log10(x) : x; }
  px(x) { const { l, r } = this.m; const a = this.fx(this.o.x.min), b = this.fx(this.o.x.max); return l + ((this.fx(x) - a) / (b - a)) * (this.o.w - l - r); }
  py(y) { const { t, b } = this.m; return t + ((this.o.y.max - y) / (this.o.y.max - this.o.y.min)) * (this.o.h - t - b); }
  dataAt(sx, sy) {
    const { l, r, t, b } = this.m;
    const u = (sx - l) / (this.o.w - l - r), v = (sy - t) / (this.o.h - t - b);
    const a = this.fx(this.o.x.min), c = this.fx(this.o.x.max);
    const fx = a + u * (c - a);
    return [this.o.x.log ? 10 ** fx : fx, this.o.y.max - v * (this.o.y.max - this.o.y.min)];
  }

  setAxes(opts) {
    Object.assign(this.o, opts);
    this.o.w = this._width();
    this.o.h = Math.round(this.o.w * this.o.aspect);
    this.svg.setAttribute('viewBox', `0 0 ${this.o.w} ${this.o.h}`);
    const { l, r, t, b } = this.m, W = this.o.w, H = this.o.h;
    Object.entries({ x: l, y: t, width: W - l - r, height: H - t - b }).forEach(([k, v]) => this.clipRect.setAttribute(k, v));
    this.gAxes.replaceChildren();
    el('rect', { class: 'plot-bg', x: l, y: t, width: W - l - r, height: H - t - b }, this.gAxes);
    const xs = this.o.x.ticks, ys = this.o.y.ticks;
    if (this.o.x.minor) for (const v of this.o.x.minor) el('line', { class: 'grid minor', x1: this.px(v), x2: this.px(v), y1: t, y2: H - b }, this.gAxes);
    for (const v of xs) {
      el('line', { class: 'grid', x1: this.px(v), x2: this.px(v), y1: t, y2: H - b }, this.gAxes);
      const tx = el('text', { class: 'tick', x: this.px(v), y: H - b + 15, 'text-anchor': 'middle' }, this.gAxes);
      tx.textContent = this.o.x.fmt(v);
    }
    for (const v of ys) {
      el('line', { class: v === 0 ? 'grid zero' : 'grid', x1: l, x2: W - r, y1: this.py(v), y2: this.py(v) }, this.gAxes);
      const ty = el('text', { class: 'tick', x: l - 6, y: this.py(v) + 4, 'text-anchor': 'end' }, this.gAxes);
      ty.textContent = this.o.y.fmt(v);
    }
    if (this.o.mark0) {
      el('line', { class: 'grid switch', x1: this.px(0), x2: this.px(0), y1: t, y2: H - b }, this.gAxes);
    }
    const xl = el('text', { class: 'axis-label', x: W - r, y: H - 3, 'text-anchor': 'end' }, this.gAxes);
    xl.textContent = this.o.xLabel || '';
    const yl = el('text', { class: 'axis-label', x: 4, y: t + 2, 'text-anchor': 'start', transform: `rotate(90 4 ${t + 2})` }, this.gAxes);
    yl.textContent = this.o.yLabel || '';
    this.redraw();
  }

  path(points, cls, parent) {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${this.px(p[0]).toFixed(1)} ${this.py(p[1]).toFixed(1)}`).join('');
    return el('path', { class: cls, d }, parent);
  }

  redraw() {
    this.gGhost.replaceChildren();
    for (const c of this.ghost.curves) this.path(c, 'ghost-curve', this.gGhost);
    for (const s of this.ghost.strokes) this.path(s, 'ghost-ink', this.gGhost);
    this.gTruth.replaceChildren();
    for (const c of this.truth) this.path(c.pts, c.cls || 'truth', this.gTruth);
    this.gInk.replaceChildren();
    for (const s of this.strokes) this.path(s, `ink ${this.o.inkClass || ''}`, this.gInk);
  }

  setTruth(curves) { this.truth = curves; this.redraw(); }
  setGhost(g) { this.ghost = g; this.redraw(); }
  clear() { this.strokes = []; this.redraw(); this.o.onInk?.(this.strokes); }
  undo() { this.strokes.pop(); this.redraw(); this.o.onInk?.(this.strokes); }
  lock(on) { this.locked = on; this.svg.classList.toggle('locked', on); }

  _wire() {
    const svg = this.svg;
    let id = null, pts = null;
    const local = (e) => {
      const m = svg.getScreenCTM();
      if (!m) return null;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return this.dataAt(p.x, p.y);
    };
    const accept = (e) => {
      if (e.pointerType === 'pen' && !pen.seen) { pen.seen = true; pen.only = true; pen.listeners.forEach((f) => f()); }
      return !(pen.only && e.pointerType === 'touch');
    };
    svg.addEventListener('pointerdown', (e) => {
      if (this.locked || id !== null || !accept(e) || e.button > 0) return;
      e.preventDefault();
      id = e.pointerId;
      try { svg.setPointerCapture(id); } catch { /* capture is optional */ }
      const p = local(e);
      pts = p ? [p] : [];
      this.live = this.path(pts, `ink ${this.o.inkClass || ''}`, this.gInk);
    });
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) { const p = local(ev); if (p) pts.push(p); }
      this.live.setAttribute('d', pts.map((p, i) => `${i ? 'L' : 'M'}${this.px(p[0]).toFixed(1)} ${this.py(p[1]).toFixed(1)}`).join(''));
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (pts && pts.length > 1) this.strokes.push(pts);
      pts = null; this.live = null;
      this.redraw();
      this.o.onInk?.(this.strokes);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }
}

/** Ticks for a linear axis: symmetric, at quarters of the top. */
export const symTicks = (top) => [-top, -top / 2, 0, top / 2, top];
/** Decade ticks and their 2..9 minors for a log axis. */
export function logTicks(lo, hi) {
  const major = [], minor = [];
  for (let k = Math.round(Math.log10(lo)); k <= Math.round(Math.log10(hi)); k++) {
    major.push(10 ** k);
    if (10 ** k < hi) for (let m = 2; m < 10; m++) minor.push(m * 10 ** k);
  }
  return { major, minor };
}

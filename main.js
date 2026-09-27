'use strict';
/*
 * Notebook spike. Throwaway code to measure two things inside Obsidian on the iPad
 * before building the real notebook plugin:
 *   1. Apple Pencil input: sample rate, pressure, tilt, coalesced events, dropped strokes.
 *   2. Audio recording: does it survive screen lock, app switching and a force quit.
 * Everything it writes goes under _spike/ in the vault.
 */

const { Plugin, ItemView, Notice } = require('obsidian');

const VIEW_TYPE = 'notebook-spike';
const ROOT = '_spike';
const CHUNK_MS = 2000;
const INK_BASE = 2.2; // stroke width in CSS px at pressure 0.5

const pad = (n, w = 2) => String(n).padStart(w, '0');
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const width = p => INK_BASE * (0.4 + 1.2 * (p > 0 ? p : 0.5));

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function clock(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function mmss(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
}
function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function kb(bytes) {
  return bytes < 1e6 ? `${Math.round(bytes / 1024)} kB` : `${r1(bytes / 1048576)} MB`;
}
function fmt(v, d = 0) {
  return Number.isFinite(v) ? v.toFixed(d) : '-';
}
function yn(v) {
  return v == null ? '?' : v ? 'yes' : 'no';
}

// Runs async jobs one at a time so file appends land in order.
class Queue {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const next = this.p.then(fn);
    this.p = next.catch(e => console.error('[notebook-spike]', e));
    return next;
  }
}

async function ensureDir(adapter, path) {
  let acc = '';
  for (const part of path.split('/')) {
    acc = acc ? `${acc}/${part}` : part;
    if (!(await adapter.exists(acc))) await adapter.mkdir(acc);
  }
}

async function appendText(adapter, path, text, header = '') {
  if (await adapter.exists(path)) await adapter.append(path, text);
  else await adapter.write(path, header + text);
}

async function mergeParts(adapter, dir, file) {
  if (!(await adapter.exists(dir))) return 0;
  const files = (await adapter.list(dir)).files.sort();
  const bufs = [];
  for (const f of files) bufs.push(new Uint8Array(await adapter.readBinary(f)));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  await adapter.writeBinary(file, out.buffer);
  await adapter.rmdir(dir, true);
  return out.length;
}

function pickFormat() {
  const options = [['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']];
  for (const [mime, ext] of options) if (MediaRecorder.isTypeSupported(mime)) return [mime, ext];
  return ['', 'bin'];
}

/* ---------------- audio ---------------- */

class Recorder {
  constructor(plugin) {
    this.plugin = plugin;
    this.state = 'idle';
    this.q = new Queue();
    this.bytes = 0;
    this.segment = 0;
    this.lateChunks = 0;
    this.onVisibility = () => this.visibilityChanged();
    this.onPageHide = e => this.note(`pagehide (persisted ${e.persisted})`);
    this.onPageShow = e => this.note(`pageshow (persisted ${e.persisted})`);
    this.onFreeze = () => this.note('page frozen');
    this.onResume = () => this.note('page resumed');
  }

  get adapter() { return this.plugin.app.vault.adapter; }
  get elapsed() { return this.state === 'idle' ? 0 : Date.now() - this.startedAt; }

  toggle() {
    if (this.state === 'idle') return this.start();
    if (this.state === 'recording') return this.stop();
  }

  async start() {
    if (this.state !== 'idle') return;
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
      new Notice('MediaRecorder is not available here');
      return;
    }
    this.state = 'starting';
    this.dir = `${ROOT}/rec-${stamp()}`;
    this.logPath = `${this.dir}/_log.md`;
    this.startedAt = Date.now();
    this.segment = 0;
    this.bytes = 0;
    this.chunks = 0;
    this.lateChunks = 0;
    this.worstGap = 0;
    this.hiddenAt = null;
    this.hasAppend = typeof this.adapter.appendBinary === 'function';
    [this.mime, this.ext] = pickFormat();

    await ensureDir(this.adapter, this.dir);
    await this.adapter.write(this.logPath, `# Audio spike ${this.dir.slice(ROOT.length + 5)}\n\n`);
    await this.adapter.write(`${this.dir}/meta.json`, JSON.stringify({
      mime: this.mime, ext: this.ext, hasAppend: this.hasAppend, started: new Date(this.startedAt).toISOString(),
    }, null, 1));
    this.note(`device: ${navigator.userAgent}`);
    this.note(`format ${this.mime || 'browser default'}; appendBinary ${this.hasAppend ? 'yes' : 'no, writing parts'}; chunk every ${CHUNK_MS} ms`);

    if (!(await this.openMic())) {
      new Notice('Microphone unavailable, see the log');
      this.state = 'idle';
      return;
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('freeze', this.onFreeze);
    document.addEventListener('resume', this.onResume);
    await this.holdScreen();
    this.state = 'recording';
    this.startSegment();
    this.ticker = window.setInterval(() => this.summary(), 60000);
    this.dog = window.setInterval(() => this.watchdog(), 1000);
    new Notice('Recording');
  }

  async openMic() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.note(`microphone refused: ${e.name}: ${e.message}`);
      return false;
    }
    const track = this.stream.getAudioTracks()[0];
    const s = track.getSettings ? track.getSettings() : {};
    this.note(`mic "${track.label}": ${s.sampleRate || '?'} Hz, ${s.channelCount || '?'} ch, echoCancellation ${s.echoCancellation}, noiseSuppression ${s.noiseSuppression}, autoGainControl ${s.autoGainControl}`);
    track.onmute = () => {
      this.note('mic muted (input interrupted)');
      // If the system never gives the input back, start over on a fresh stream.
      window.setTimeout(() => {
        if (this.state === 'recording' && track === this.track() && track.muted && document.visibilityState === 'visible') {
          this.reopen('mic still muted after 3 s');
        }
      }, 3000);
    };
    track.onunmute = () => this.note('mic unmuted');
    track.onended = () => this.note('mic track ended');
    return true;
  }

  track() { return this.stream && this.stream.getAudioTracks()[0]; }

  startSegment() {
    const n = pad(++this.segment);
    const seg = { n, file: `${this.dir}/audio-${n}.${this.ext}`, parts: `${this.dir}/parts-${n}`, append: this.hasAppend, idx: 0, bytes: 0 };
    let rec;
    try {
      rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 96000 } : { audioBitsPerSecond: 96000 });
    } catch (e) {
      this.note(`MediaRecorder failed: ${e.name}: ${e.message}`);
      return;
    }
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) this.chunk(seg, ev.data); };
    rec.onerror = ev => this.note(`recorder error: ${ev.error ? ev.error.name : 'unknown'}`);
    rec.onstop = () => {
      this.note(`segment ${n} closed: ${kb(seg.bytes)} in ${seg.idx} chunks`);
      if (!seg.append) this.q.run(() => mergeParts(this.adapter, seg.parts, seg.file));
    };
    rec.start(CHUNK_MS);
    this.rec = rec;
    if (this.segment === 1) this.lastChunk = Date.now();
    this.note(`segment ${n} started as ${rec.mimeType || this.mime || 'default'}`);
  }

  chunk(seg, blob) {
    const now = Date.now(), gap = now - this.lastChunk;
    this.lastChunk = now;
    this.worstGap = Math.max(this.worstGap, gap);
    if (gap > CHUNK_MS * 1.75) {
      this.lateChunks++;
      this.note(`chunk arrived ${r1(gap / 1000)} s after the previous one`);
    }
    this.chunks++;
    this.bytes += blob.size;
    seg.bytes += blob.size;
    const idx = ++seg.idx;
    this.q.run(async () => {
      const buf = await blob.arrayBuffer();
      if (seg.append) {
        if (idx === 1) await this.adapter.writeBinary(seg.file, buf);
        else await this.adapter.appendBinary(seg.file, buf);
      } else {
        if (idx === 1) await ensureDir(this.adapter, seg.parts);
        await this.adapter.writeBinary(`${seg.parts}/${pad(idx, 5)}.bin`, buf);
      }
    });
  }

  async visibilityChanged() {
    const track = this.track();
    this.note(`app ${document.visibilityState}; mic ${track ? track.readyState + (track.muted ? ', muted' : '') : 'gone'}; recorder ${this.rec ? this.rec.state : 'none'}`);
    if (document.visibilityState === 'hidden') { this.hiddenAt = Date.now(); return; }
    if (this.state !== 'recording') return;
    await this.holdScreen();
    // On iOS the mic unmutes and the recorder still says "recording" after a lock or app
    // switch, but it never delivers audio again. So always start over on a fresh stream.
    const away = this.hiddenAt ? r1((Date.now() - this.hiddenAt) / 1000) : null;
    this.hiddenAt = null;
    if (away != null) await this.reopen(`back after ${away} s hidden (audio from that time is lost)`);
    else if (!track || track.readyState === 'ended') await this.reopen('mic track had ended');
    else if (!this.rec || this.rec.state === 'inactive') {
      this.note('recorder had stopped, starting a new segment');
      this.startSegment();
    }
  }

  // Restarts the recording if no chunk has arrived for 3 timeslices while visible.
  watchdog() {
    if (this.state !== 'recording' || this.reopening || document.visibilityState !== 'visible') return;
    const quiet = Date.now() - this.lastChunk;
    if (quiet > CHUNK_MS * 3) this.reopen(`no audio for ${r1(quiet / 1000)} s`);
  }

  async reopen(reason) {
    if (this.reopening) return;
    this.reopening = true;
    try {
      this.note(`${reason}, reopening the mic`);
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      if (await this.openMic()) this.startSegment();
      this.lastChunk = Date.now();
    } finally {
      this.reopening = false;
    }
  }

  async holdScreen() {
    if (this.wake && !this.wake.released) return;
    if (!navigator.wakeLock) {
      if (!this.wakeNoted) this.note('screen wake lock: not available');
      this.wakeNoted = true;
      return;
    }
    try {
      this.wake = await navigator.wakeLock.request('screen');
      this.note('screen wake lock: held');
      this.wake.addEventListener('release', () => this.note('screen wake lock: released'));
    } catch (e) {
      this.note(`screen wake lock: refused (${e.name})`);
    }
  }

  async stop() {
    if (this.state !== 'recording') return;
    this.state = 'stopping';
    window.clearInterval(this.ticker);
    window.clearInterval(this.dog);
    const rec = this.rec;
    if (rec && rec.state !== 'inactive') {
      await new Promise(res => { rec.addEventListener('stop', () => res(), { once: true }); rec.stop(); });
    }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.wake && !this.wake.released) await this.wake.release().catch(() => {});
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('freeze', this.onFreeze);
    document.removeEventListener('resume', this.onResume);
    const duration = this.elapsed;
    this.summary();
    this.note('session stopped');
    await this.q.run(() => {});
    this.state = 'idle';
    const name = this.dir.slice(ROOT.length + 1);
    await appendText(this.adapter, `${ROOT}/_results.md`,
      `\n## Audio ${new Date(this.startedAt).toLocaleString()}\n\n` +
      `${mmss(duration)} recorded, ${kb(this.bytes)} (${kb(this.bytes / Math.max(duration / 60000, 1 / 60))}/min), ` +
      `${this.segment} segment(s), ${this.lateChunks} late chunk(s), longest gap ${r1(this.worstGap / 1000)} s. ` +
      `[log](${name}/_log.md)\n`,
      '# Notebook spike results\n');
    new Notice(`Saved ${this.dir}`);
  }

  summary() {
    const mins = Math.max(this.elapsed, 1000) / 60000;
    this.note(`so far: ${this.chunks} chunks, ${kb(this.bytes)} (${kb(this.bytes / mins)}/min), ${this.lateChunks} late, longest gap ${r1(this.worstGap / 1000)} s, ${this.segment} segment(s)`);
  }

  note(msg) {
    console.log('[notebook-spike]', msg);
    if (!this.logPath) return;
    const line = `- ${clock()} +${mmss(Date.now() - this.startedAt)} ${msg}\n`;
    const path = this.logPath;
    this.q.run(() => this.adapter.append(path, line));
  }

  // After a crash or force quit: rebuild any segments left as parts, and mark the log.
  async recover() {
    const a = this.adapter;
    if (!(await a.exists(ROOT))) return;
    for (const dir of (await a.list(ROOT)).folders) {
      if (!/\/rec-[\d-]+$/.test(dir) || (this.state !== 'idle' && dir === this.dir)) continue;
      const log = `${dir}/_log.md`;
      const text = (await a.exists(log)) ? await a.read(log) : '';
      if (text.includes('session stopped') || text.includes('recovered after')) continue;
      let meta = {};
      try { meta = JSON.parse(await a.read(`${dir}/meta.json`)); } catch (e) { /* no meta, keep .bin */ }
      const rebuilt = [];
      for (const parts of (await a.list(dir)).folders.filter(f => /\/parts-\d+$/.test(f))) {
        const n = parts.split('parts-')[1];
        rebuilt.push(`segment ${n} rebuilt from parts (${kb(await mergeParts(a, parts, `${dir}/audio-${n}.${meta.ext || 'bin'}`))})`);
      }
      await appendText(a, log, `- ${clock()} recovered after unclean exit: ${rebuilt.length ? rebuilt.join('; ') : 'audio was appended live, nothing to rebuild'}\n`);
      new Notice(`Recovered an interrupted recording in ${dir}`);
    }
  }
}

/* ---------------- ink ---------------- */

function outline(pts) {
  const n = pts.length;
  if (n === 1) {
    const [x, y, p] = pts[0], r = r1(width(p) / 2);
    return `M${r1(x - r)} ${r1(y)}a${r} ${r} 0 1 0 ${r1(2 * r)} 0a${r} ${r} 0 1 0 ${r1(-2 * r)} 0Z`;
  }
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const [x, y, p] = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, r = width(p) / 2;
    const nx = -dy / len * r, ny = dx / len * r;
    left.push(`${r1(x + nx)} ${r1(y + ny)}`);
    right.push(`${r1(x - nx)} ${r1(y - ny)}`);
  }
  const rEnd = r1(width(pts[n - 1][2]) / 2), rStart = r1(width(pts[0][2]) / 2);
  const back = right.slice().reverse();
  return `M${left.join('L')}A${rEnd} ${rEnd} 0 0 0 ${back[0]}L${back.join('L')}A${rStart} ${rStart} 0 0 0 ${left[0]}Z`;
}

function toSvg(strokes, page) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const [x, y] of s.pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const m = 12;
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  const data = {
    format: 'notebook-ink/0',
    created: new Date().toISOString(),
    page,
    strokes: strokes.map(s => ({ t0: s.t0, type: s.type, pts: s.pts.map(([x, y, p, t]) => [r1(x), r1(y), r2(p), t]) })),
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(x0)} ${r1(y0)} ${r1(x1 - x0)} ${r1(y1 - y0)}" width="${Math.ceil(x1 - x0)}" height="${Math.ceil(y1 - y0)}">\n` +
    `<style>path{fill:#1f1f1f}@media (prefers-color-scheme:dark){path{fill:#e6e3de}}</style>\n` +
    `<metadata><![CDATA[${JSON.stringify(data)}]]></metadata>\n` +
    strokes.map(s => `<path d="${outline(s.pts)}"/>`).join('\n') +
    '\n</svg>\n';
}

class SpikeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.strokes = [];
    this.stats = [];
    this.cur = null;
    this.m = { cancels: 0, touches: 0, hovers: 0, coalesced: null, predicted: null, last: null };
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Notebook spike'; }
  getIcon() { return 'pencil'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('nbspike');
    const bar = root.createDiv({ cls: 'nbspike-bar' });
    const button = (label, fn) => {
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
    this.ctx = this.canvas.getContext('2d', { desynchronized: true }) || this.canvas.getContext('2d');

    const c = this.canvas;
    c.addEventListener('pointerdown', e => this.down(e));
    c.addEventListener('pointermove', e => this.move(e));
    c.addEventListener('pointerup', e => this.up(e));
    c.addEventListener('pointercancel', e => this.up(e));
    // Keep Pencil drags from scrolling, selecting text or opening Obsidian's sidebars.
    const block = e => { e.preventDefault(); e.stopPropagation(); };
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

  paint(s, from) {
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

  down(e) {
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

  sample(s, e) {
    s.samples++;
    const x = e.clientX - this.rect.left, y = e.clientY - this.rect.top, p = e.pressure;
    s.pmin = Math.min(s.pmin, p);
    s.pmax = Math.max(s.pmax, p);
    this.m.last = { type: e.pointerType, p, tiltX: e.tiltX, tiltY: e.tiltY, alt: e.altitudeAngle, az: e.azimuthAngle };
    const prev = s.pts[s.pts.length - 1];
    if (prev && Math.hypot(x - prev[0], y - prev[1]) < 0.25) return;
    s.pts.push([x, y, p, Math.round(e.timeStamp - s.ts0)]);
  }

  move(e) {
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

  up(e) {
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

  measured(stats) {
    const med = k => median(stats.map(x => x[k]).filter(Number.isFinite));
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

/* ---------------- plugin ---------------- */

module.exports = class NotebookSpike extends Plugin {
  async onload() {
    this.recorder = new Recorder(this);
    this.registerView(VIEW_TYPE, leaf => new SpikeView(leaf, this));
    this.addRibbonIcon('pencil', 'Notebook spike', () => this.open());
    this.addCommand({ id: 'open', name: 'Open pen and audio test', callback: () => this.open() });
    this.addCommand({ id: 'toggle-recording', name: 'Start or stop test recording', callback: () => this.recorder.toggle() });
    this.app.workspace.onLayoutReady(() => {
      this.recorder.recover().catch(e => console.error('[notebook-spike] recover', e));
    });
  }

  onunload() {
    this.recorder.stop();
  }

  async open() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
  }
};

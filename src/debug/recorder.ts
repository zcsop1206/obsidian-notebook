/*
 * The spike's test recorder, moved over as-is. It measures whether audio recording survives
 * screen lock, app switching and a force quit inside Obsidian on the iPad. Chunks are written
 * as they arrive (appended when adapter.appendBinary exists, else as parts merged on stop),
 * and each return from hidden starts a new segment. Writes to _spike/rec-<stamp>/.
 */
import { Notice } from 'obsidian';
import type { DataAdapter, Plugin } from 'obsidian';
import { LOG_PREFIX, Queue, ROOT, appendText, clock, ensureDir, kb, mmss, pad, r1, stamp } from './util';

const CHUNK_MS = 2000;

type State = 'idle' | 'starting' | 'recording' | 'stopping';

interface Segment {
  n: string;
  file: string;
  parts: string;
  append: boolean;
  idx: number;
  bytes: number;
}

interface Meta {
  mime: string;
  ext: string;
  hasAppend: boolean;
  started: string;
  segments: { file: string; startMs: number; audioEndMs?: number }[];
}

async function mergeParts(adapter: DataAdapter, dir: string, file: string) {
  if (!(await adapter.exists(dir))) return 0;
  const files = (await adapter.list(dir)).files.sort();
  const bufs: Uint8Array[] = [];
  for (const f of files) bufs.push(new Uint8Array(await adapter.readBinary(f)));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  await adapter.writeBinary(file, out.buffer);
  await adapter.rmdir(dir, true);
  return out.length;
}

function pickFormat(): [string, string] {
  const options = [['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']];
  for (const [mime, ext] of options) if (MediaRecorder.isTypeSupported(mime)) return [mime, ext];
  return ['', 'bin'];
}

export class Recorder {
  plugin: Plugin;
  state: State = 'idle';
  q = new Queue();
  bytes = 0;
  segment = 0;
  lateChunks = 0;
  chunks = 0;
  worstGap = 0;
  startedAt = 0;
  lastChunk = 0;
  hiddenAt: number | null = null;
  hasAppend = false;
  reopening = false;
  wakeNoted = false;
  dir = '';
  logPath = '';
  mime = '';
  ext = '';
  meta!: Meta;
  stream?: MediaStream;
  rec?: MediaRecorder;
  wake?: WakeLockSentinel;
  ticker?: number;
  dog?: number;
  onVisibility: () => void;
  onPageHide: (e: PageTransitionEvent) => void;
  onPageShow: (e: PageTransitionEvent) => void;
  onFreeze: () => void;
  onResume: () => void;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.onVisibility = () => this.visibilityChanged();
    this.onPageHide = e => this.note(`pagehide (persisted ${e.persisted})`);
    this.onPageShow = e => this.note(`pageshow (persisted ${e.persisted})`);
    this.onFreeze = () => this.note('page frozen');
    this.onResume = () => this.note('page resumed');
  }

  get adapter(): DataAdapter { return this.plugin.app.vault.adapter; }
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
    // segments[].startMs places each file on the recording's timeline; the time between one
    // segment's audio and the next start is lost (Obsidian was hidden). audioEndMs is set when known.
    this.meta = { mime: this.mime, ext: this.ext, hasAppend: this.hasAppend, started: new Date(this.startedAt).toISOString(), segments: [] };
    await this.adapter.write(`${this.dir}/meta.json`, JSON.stringify(this.meta, null, 1));
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
      const err = e as Error;
      this.note(`microphone refused: ${err.name}: ${err.message}`);
      return false;
    }
    const track = this.stream.getAudioTracks()[0];
    const s: MediaTrackSettings = track.getSettings ? track.getSettings() : {};
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
    const seg: Segment = { n, file: `${this.dir}/audio-${n}.${this.ext}`, parts: `${this.dir}/parts-${n}`, append: this.hasAppend, idx: 0, bytes: 0 };
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(this.stream!, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 96000 } : { audioBitsPerSecond: 96000 });
    } catch (e) {
      const err = e as Error;
      this.note(`MediaRecorder failed: ${err.name}: ${err.message}`);
      return;
    }
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) this.chunk(seg, ev.data); };
    rec.onerror = ev => {
      const error = (ev as Event & { error?: DOMException }).error;
      this.note(`recorder error: ${error ? error.name : 'unknown'}`);
    };
    rec.onstop = () => {
      this.note(`segment ${n} closed: ${kb(seg.bytes)} in ${seg.idx} chunks`);
      if (!seg.append) this.q.run(() => mergeParts(this.adapter, seg.parts, seg.file));
    };
    rec.start(CHUNK_MS);
    this.rec = rec;
    this.meta.segments.push({ file: `audio-${n}.${this.ext}`, startMs: Date.now() - this.startedAt });
    this.saveMeta();
    if (this.segment === 1) this.lastChunk = Date.now();
    this.note(`segment ${n} started as ${rec.mimeType || this.mime || 'default'}`);
  }

  chunk(seg: Segment, blob: Blob) {
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
    if (this.reopening) return; // the watchdog got there first
    if (this.hiddenAt) return this.resume();
    const now = this.track();
    if (!now || now.readyState === 'ended') await this.reopen('mic track had ended');
    else if (!this.rec || this.rec.state === 'inactive') {
      this.note('recorder had stopped, starting a new segment');
      this.startSegment();
    }
  }

  // On iOS the mic unmutes and the recorder still says "recording" after a lock or app
  // switch, but it never delivers audio again. So always start over on a fresh stream.
  resume() {
    const hiddenAt = this.hiddenAt!;
    const away = r1((Date.now() - hiddenAt) / 1000), last = this.meta.segments[this.meta.segments.length - 1];
    if (last) { last.audioEndMs = hiddenAt - this.startedAt; this.saveMeta(); }
    this.hiddenAt = null;
    return this.reopen(`back after ${away} s hidden (audio from that time is lost)`);
  }

  saveMeta() {
    const path = `${this.dir}/meta.json`, text = JSON.stringify(this.meta, null, 1);
    this.q.run(() => this.adapter.write(path, text));
  }

  // Restarts the recording if no chunk has arrived for 3 timeslices while visible. On the
  // iPad this can run before the visibilitychange event on return, so it handles that too.
  watchdog() {
    if (this.state !== 'recording' || this.reopening || document.visibilityState !== 'visible') return;
    if (this.hiddenAt) { this.resume(); return; }
    const quiet = Date.now() - this.lastChunk;
    if (quiet > CHUNK_MS * 3) this.reopen(`no audio for ${r1(quiet / 1000)} s`);
  }

  async reopen(reason: string) {
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
      this.note(`screen wake lock: refused (${(e as Error).name})`);
    }
  }

  async stop() {
    if (this.state !== 'recording') return;
    this.state = 'stopping';
    window.clearInterval(this.ticker);
    window.clearInterval(this.dog);
    const rec = this.rec;
    if (rec && rec.state !== 'inactive') {
      await new Promise<void>(res => { rec.addEventListener('stop', () => res(), { once: true }); rec.stop(); });
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

  note(msg: string) {
    console.log(LOG_PREFIX, msg);
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
      let meta: { ext?: string } = {};
      try { meta = JSON.parse(await a.read(`${dir}/meta.json`)); } catch (e) { /* no meta, keep .bin */ }
      const rebuilt: string[] = [];
      for (const parts of (await a.list(dir)).folders.filter(f => /\/parts-\d+$/.test(f))) {
        const n = parts.split('parts-')[1];
        rebuilt.push(`segment ${n} rebuilt from parts (${kb(await mergeParts(a, parts, `${dir}/audio-${n}.${meta.ext || 'bin'}`))})`);
      }
      await appendText(a, log, `- ${clock()} recovered after unclean exit: ${rebuilt.length ? rebuilt.join('; ') : 'audio was appended live, nothing to rebuild'}\n`);
      new Notice(`Recovered an interrupted recording in ${dir}`);
    }
  }
}

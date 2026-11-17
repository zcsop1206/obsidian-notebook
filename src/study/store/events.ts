/**
 * The event logs: <root>/log/<device>.jsonl, append-only, one JSON event per line (SPEC.md,
 * Storage). Each device writes only its own file, so sync never merges one file from two devices.
 * The store reads every device's log, skips lines it cannot parse (counted in `skipped`), dedupes by
 * id and sorts by time then id; it appends to this device's log (rotating past 5 MB) and reloads,
 * debounced, when a log under the root changes (another device's log arriving by sync).
 *
 * Only `import type` from obsidian, so the unit tests can run it against a fake adapter.
 */
import type { App, EventRef, TAbstractFile } from 'obsidian';
import type { NewEvent } from '../context';
import type { StudyEvent } from '../types';
import { isoLocal } from '../engine/rules';

/** A log past this size starts the next part: <device>-2.jsonl, -3, ... */
export const ROTATE_BYTES = 5 * 1024 * 1024;
export const RELOAD_DEBOUNCE_MS = 300;

/** A device name fit for a file name: lowercase letters, digits and hyphens. A trailing `-<digits>` is
 * joined (`ipad-2` -> `ipad2`) so it can never be read as another device's second log part. */
export function cleanDevice(name: string): string {
  const d = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-(\d+)$/, '$1');
  return d || 'device';
}

/** `<device>-<ms base36>-<4 random base36>` (SPEC.md, Storage). */
export function newEventId(device: string, now: Date): string {
  let r = '';
  while (r.length < 4) r += Math.floor(Math.random() * 36).toString(36);
  return `${device}-${now.getTime().toString(36)}-${r}`;
}

function isEvent(x: unknown): x is StudyEvent {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const e = x as Record<string, unknown>;
  return typeof e.id === 'string' && e.id !== '' && typeof e.type === 'string' && typeof e.t === 'string' && isFinite(Date.parse(e.t))
    && typeof e.v === 'number';
}

/** One log file's lines: blank lines are ignored, lines that are not an event are counted. */
export function parseLog(text: string): { events: StudyEvent[]; skipped: number } {
  const events: StudyEvent[] = [];
  let skipped = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let x: unknown;
    try { x = JSON.parse(line); } catch { skipped++; continue; }
    if (isEvent(x)) events.push(x); else skipped++;
  }
  return { events, skipped };
}

/** Dedupe by id (the first copy wins) and sort by time, then id. */
export function mergeEvents(lists: StudyEvent[][]): StudyEvent[] {
  const seen = new Set<string>();
  const out: { e: StudyEvent; ms: number }[] = [];
  for (const L of lists) {
    for (const e of L) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ e, ms: Date.parse(e.t) });
    }
  }
  out.sort((a, b) => a.ms - b.ms || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
  return out.map(x => x.e);
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function sameIds(a: StudyEvent[], b: StudyEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

export class EventStore {
  /** Lines in the logs that could not be read as events, at the last reload. */
  skipped = 0;
  private events: StudyEvent[] = [];
  /** Events appended in this session: kept even if a reload races their write. */
  private own: StudyEvent[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private current: { dev: string; n: number; path: string; bytes: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadedOnce = false;

  constructor(private app: App, private root: () => string, private device: () => string, private changed: () => void) {}

  /** Every event from every device's log, sorted by time then id. */
  all(): StudyEvent[] {
    return this.events;
  }

  /** True once the logs have been read. */
  loaded(): boolean {
    return this.loadedOnce;
  }

  logDir(): string {
    const r = this.root().replace(/^\/+|\/+$/g, '');
    return r ? `${r}/log` : 'log';
  }

  /** Read every log/*.jsonl under the root. Calls `changed` when the event list differs. */
  async reload(): Promise<StudyEvent[]> {
    const a = this.app.vault.adapter;
    const dir = this.logDir();
    const lists: StudyEvent[][] = [];
    let skipped = 0;
    try {
      if (await a.exists(dir)) {
        const listed = await a.list(dir);
        const files = listed.files.map(f => (f.includes('/') ? f : `${dir}/${f}`)).filter(f => f.endsWith('.jsonl')).sort();
        for (const f of files) {
          try {
            const r = parseLog(await a.read(f));
            lists.push(r.events);
            skipped += r.skipped;
          } catch (err) {
            console.error('[study] cannot read', f, err);
          }
        }
      }
    } catch (err) {
      console.error('[study] cannot list', dir, err);
    }
    lists.push(this.own);
    const merged = mergeEvents(lists);
    this.skipped = skipped;
    const differs = !sameIds(merged, this.events);
    this.events = merged;
    this.loadedOnce = true;
    if (differs) this.changed();
    return merged;
  }

  /** Append to this device's log; the engine sees the event at once, and the promise resolves once it is written. */
  append(e: NewEvent): Promise<StudyEvent> {
    const dev = cleanDevice(this.device());
    const now = new Date();
    const full = { ...e, v: 1, id: newEventId(dev, now), t: isoLocal(now), dev } as StudyEvent;
    this.own.push(full);
    const last = this.events[this.events.length - 1];
    if (!last || Date.parse(last.t) <= now.getTime()) this.events = [...this.events, full];
    else this.events = mergeEvents([this.events, [full]]);
    this.changed();
    const line = JSON.stringify(full) + '\n';
    const p = this.queue.then(() => this.write(dev, line));
    this.queue = p.catch(err => console.error('[study] cannot write the event log', err));
    return p.then(() => full);
  }

  private async ensureDir(dir: string): Promise<void> {
    const a = this.app.vault.adapter;
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (p && !(await a.exists(p))) await a.mkdir(p);
    }
  }

  private part(dev: string, n: number): string {
    return `${this.logDir()}/${n <= 1 ? dev : `${dev}-${n}`}.jsonl`;
  }

  private async sizeOf(path: string): Promise<number> {
    const a = this.app.vault.adapter;
    if (!(await a.exists(path))) return 0;
    try {
      const st = typeof a.stat === 'function' ? await a.stat(path) : null;
      if (st && typeof st.size === 'number') return st.size;
    } catch { /* fall back to reading it */ }
    return utf8Bytes(await a.read(path));
  }

  /** This device's current log part: the highest that exists, or the next one once it is past 5 MB. */
  private async target(dev: string): Promise<string> {
    const a = this.app.vault.adapter;
    if (!this.current || this.current.dev !== dev) {
      const re = new RegExp(`^${dev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?\\.jsonl$`);
      let n = 1;
      try {
        for (const f of (await a.list(this.logDir())).files) {
          const m = re.exec(f.slice(f.lastIndexOf('/') + 1));
          if (m) n = Math.max(n, m[1] ? Number(m[1]) : 1);
        }
      } catch { /* a new folder: part 1 */ }
      const path = this.part(dev, n);
      this.current = { dev, n, path, bytes: await this.sizeOf(path) };
    }
    if (this.current.bytes >= ROTATE_BYTES) {
      const n = this.current.n + 1;
      this.current = { dev, n, path: this.part(dev, n), bytes: 0 };
    }
    return this.current.path;
  }

  private async write(dev: string, line: string): Promise<void> {
    const a = this.app.vault.adapter;
    await this.ensureDir(this.logDir());
    const path = await this.target(dev);
    if (!(await a.exists(path))) await a.write(path, line);
    else if (typeof (a as { append?: unknown }).append === 'function') await a.append(path, line);
    else await a.write(path, (await a.read(path)) + line); // Obsidian before 1.12.3
    if (this.current && this.current.path === path) this.current.bytes += utf8Bytes(line);
  }

  /** Vault listeners: reload (debounced 300 ms) when a log under the root changes; also the first load. Returns the cleanup for plugin.register. */
  watch(): () => void {
    const v = this.app.vault;
    const refs: EventRef[] = [];
    const touch = (path: string) => {
      if (!path.startsWith(this.logDir() + '/') || !path.endsWith('.jsonl')) return;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; void this.reload(); }, RELOAD_DEBOUNCE_MS);
    };
    refs.push(v.on('modify', (f: TAbstractFile) => touch(f.path)));
    refs.push(v.on('create', (f: TAbstractFile) => touch(f.path)));
    refs.push(v.on('delete', (f: TAbstractFile) => touch(f.path)));
    refs.push(v.on('rename', (f: TAbstractFile, old: string) => { touch(f.path); touch(old); }));
    void this.reload();
    return () => {
      for (const r of refs) v.offref(r);
      if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    };
  }
}

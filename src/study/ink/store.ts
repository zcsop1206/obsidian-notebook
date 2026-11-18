/**
 * One doc's ink across devices (SPEC.md, Storage: Ink). Reads every `ink/<doc-id>.<device>.json`,
 * shows their union, and writes only this device's file: 1 s after the last change, at once on
 * `pagehide` and when the page is hidden, and when the last user of the doc's ink lets go.
 * Strokes written before the files finish loading are kept and merged. Another device's file
 * changing on disk (a sync) is re-read.
 *
 * A device never writes another device's file. Deleting or keeping another device's stroke is
 * recorded in this device's own file (`hide`, `keep`; model.ts) and applied to the union.
 *
 * Nor does it write over its own file without having read it: when the file could not be listed
 * or read at load, or did not hold valid JSON, the first write reads it again and merges what it
 * holds (or saves a copy of text that is not JSON beside it) before writing.
 */
import type { InkStroke } from '../view/host';
import {
  SAVE_DELAY_MS, deviceOf, inkFolder, inkPath, lastOwnIndex, parseInkFile, serializeInkFile, strokeKey, unionStrokes,
  type InkFile,
} from './model';

/** The parts of Obsidian's DataAdapter the store uses. */
export interface InkAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export type InkListener = (why: 'load' | 'add' | 'remove' | 'keep' | 'sync') => void;

/** What DocInkStore.adopt resolves to: how many strokes it added, and whether nothing is left unwritten after its flush. */
export interface Adopted {
  added: number;
  saved: boolean;
}

/**
 * Text a write may replace once it was read: blank, or valid JSON. `parsed` is parseInkFile's
 * reading of it: any stroke, hide or keep there means the JSON parsed, so it is not parsed twice.
 */
function readable(text: string, parsed: InkFile): boolean {
  if (parsed.strokes.length || parsed.hide || parsed.keep || !text.trim()) return true;
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Where an own file that is not valid JSON is saved before a write replaces it: beside it, never `.json`. */
export function unreadablePath(path: string, at: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`;
  return `${path}.unreadable-${stamp}.txt`;
}

export class DocInkStore {
  /** Every device's file, this device's included (created on first write). */
  private files = new Map<string, InkFile>();
  /** The union, recomputed after every change. */
  private all: InkStroke[] = [];
  /** Strokes added before the files loaded. */
  private early: InkStroke[] = [];
  private listeners = new Set<InkListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private ownExisted = false;
  /**
   * This device's file was read cleanly at load (listed, read, and blank or valid JSON), or the
   * listing showed there is none. Until then a write reads the file again first (reconcile).
   */
  private ownClean = false;
  private writing: Promise<void> = Promise.resolve();
  private loaded = false;
  readonly ready: Promise<void>;

  constructor(private adapter: InkAdapter, readonly root: string, readonly device: string, readonly docId: string) {
    this.ready = this.load();
  }

  get path(): string { return inkPath(this.root, this.docId, this.device); }

  private own(): InkFile {
    let f = this.files.get(this.device);
    if (!f) { f = { v: 1, doc: this.docId, strokes: [] }; this.files.set(this.device, f); }
    return f;
  }

  private async load(): Promise<void> {
    const folder = inkFolder(this.root);
    let paths: string[] = [];
    let listed = false;
    try {
      if (await this.adapter.exists(folder)) paths = (await this.adapter.list(folder)).files;
      listed = true;
    } catch (e) { console.error('[study] ink: listing failed', e); }
    let ownOk = true;
    for (const p of paths) {
      const dev = deviceOf(p, this.root, this.docId);
      if (!dev) continue;
      try {
        const text = await this.adapter.read(p);
        const f = parseInkFile(text, this.docId);
        this.files.set(dev, f);
        if (dev === this.device) { this.ownExisted = true; ownOk = readable(text, f); }
      } catch (e) {
        if (dev === this.device) ownOk = false;
        console.error('[study] ink: reading failed', p, e);
      }
    }
    this.ownClean = listed && ownOk;
    this.loaded = true;
    if (this.early.length) {
      this.own().strokes.push(...this.early);
      this.early = [];
      this.dirty = true;
      this.schedule();
    }
    this.recompute('load');
  }

  /** Re-reads another device's file after it changed on disk (sync). Own-file events are our writes. */
  async reload(path: string): Promise<boolean> {
    const dev = deviceOf(path, this.root, this.docId);
    if (!dev || dev === this.device) return false;
    await this.ready;
    try {
      if (await this.adapter.exists(path)) this.files.set(dev, parseInkFile(await this.adapter.read(path), this.docId));
      else this.files.delete(dev);
    } catch (e) { console.error('[study] ink: re-reading failed', path, e); return false; }
    this.recompute('sync');
    return true;
  }

  private recompute(why: Parameters<InkListener>[0]): void {
    const files = [...this.files.entries()].map(([dev, file]) => ({ dev, file }));
    if (this.early.length) files.push({ dev: this.device, file: { v: 1, doc: this.docId, strokes: this.early } });
    this.all = unionStrokes(files);
    for (const fn of [...this.listeners]) { try { fn(why); } catch (e) { console.error('[study] ink listener', e); } }
  }

  onChange(fn: InkListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** The union of every device's strokes (do not mutate). */
  strokes(): readonly InkStroke[] { return this.all; }

  /** Strokes of one block canvas, or of the page (`null`). */
  strokesOf(blk: string | null): InkStroke[] { return this.all.filter(s => (s.blk ?? null) === blk); }

  /** Adds a stroke written on this device. */
  add(s: InkStroke): InkStroke {
    const st: InkStroke = { ...s };
    delete st.dev;
    if (this.loaded) this.own().strokes.push(st);
    else this.early.push(st);
    this.touch('add');
    return { ...st, dev: this.device };
  }

  /**
   * Adds strokes this device wrote under another doc's file, ids kept (S12: a problem's old
   * standalone ink moving to its home doc). Going through the store, not the file, means open
   * surfaces show them at once and the store's next write keeps them. Ids this device's file
   * already holds are skipped, so adopting twice adds nothing. Then flushes, and resolves to how
   * many were added and whether nothing is left unwritten (`saved`): false when the write failed
   * or this device's file could not be read (the store keeps the strokes and retries).
   */
  async adopt(strokes: readonly InkStroke[]): Promise<Adopted> {
    await this.ready;
    const own = this.own();
    const have = new Set(own.strokes.map(s => s.id));
    let n = 0;
    for (const s of strokes) {
      if (!s || typeof s.id !== 'string' || have.has(s.id)) continue;
      const st: InkStroke = { ...s };
      delete st.dev;
      own.strokes.push(st);
      have.add(st.id);
      n++;
    }
    if (n) this.touch('add');
    await this.flush();
    return { added: n, saved: !this.dirty };
  }

  /**
   * Removes strokes by key (`<dev>:<id>`): this device's from its file, other devices' by hiding
   * them in this device's file. Returns how many were removed.
   */
  remove(keys: Iterable<string>): number {
    const ks = new Set(keys);
    if (!ks.size) return 0;
    let n = 0;
    const own = this.own();
    const before = own.strokes.length;
    own.strokes = own.strokes.filter(s => !ks.has(`${this.device}:${s.id}`));
    const eb = this.early.length;
    this.early = this.early.filter(s => !ks.has(`${this.device}:${s.id}`));
    n += before - own.strokes.length + eb - this.early.length;
    const shown = new Set(this.all.map(strokeKey));
    for (const k of ks) {
      if (k.startsWith(this.device + ':') || !shown.has(k)) continue;
      const hide = new Set(own.hide ?? []);
      hide.add(k);
      own.hide = [...hide];
      n++;
    }
    if (n) this.touch('remove');
    return n;
  }

  /** This device's latest stroke in `blk` (null = page ink), removed. Other devices' strokes are never undone. */
  undo(blk: string | null): InkStroke | null {
    const i = lastOwnIndex(this.all, this.device, blk);
    if (i < 0) return null;
    const s = this.all[i];
    this.remove([strokeKey(s)]);
    return s;
  }

  /**
   * Keep: changed strokes now belong to the passage's new text (`rev`) at `build`. Own strokes
   * change in place; other devices' go to this device's keep map.
   */
  keep(keys: Iterable<string>, rev: string, build: number): number {
    const ks = new Set(keys);
    let n = 0;
    const own = this.own();
    for (const s of own.strokes) {
      if (!ks.has(`${this.device}:${s.id}`) || !s.at) continue;
      s.at = { ...s.at, rev, v: build };
      n++;
    }
    for (const k of ks) {
      if (k.startsWith(this.device + ':')) continue;
      own.keep = { ...(own.keep ?? {}), [k]: rev };
      n++;
    }
    if (n) this.touch('keep');
    return n;
  }

  private touch(why: Parameters<InkListener>[0]): void {
    this.dirty = true;
    this.recompute(why);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, SAVE_DELAY_MS);
  }

  /** Writes this device's file now if anything changed. Writes are serialized. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.writing = this.writing.then(() => this.write());
    return this.writing;
  }

  private async write(): Promise<void> {
    await this.ready;
    if (!this.dirty) return;
    if (!this.ownClean && !(await this.reconcile())) { this.retry(); return; }
    const own = this.own();
    if (!this.ownExisted && !own.strokes.length && !(own.hide ?? []).length && !Object.keys(own.keep ?? {}).length) { this.dirty = false; return; }
    this.dirty = false;
    const text = serializeInkFile(this.docId, own.strokes, own.hide, own.keep);
    try {
      const folder = inkFolder(this.root);
      const parts = folder.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (!(await this.adapter.exists(p))) await this.adapter.mkdir(p);
      }
      await this.adapter.write(this.path, text);
      this.ownExisted = true;
    } catch (e) {
      // Kept dirty and tried again later; the strokes stay on screen meanwhile.
      this.dirty = true;
      console.error('[study] ink: saving failed', this.path, e);
      this.retry();
    }
  }

  /** Writes again later: after a failed write, or while this device's file still cannot be read. */
  private retry(): void {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, SAVE_DELAY_MS * 5);
  }

  /**
   * Before the first write over this device's file when it did not load cleanly: reads it again.
   * Absent now, there is nothing to keep. Valid JSON (or blank) is merged into memory: its strokes
   * whose ids memory lacks, its hides, and the keeps memory lacks, shown at once. Text that is not
   * JSON is first saved beside the file (unreadablePath). Resolves false, so nothing is written
   * and the change stays pending, when the file still cannot be read or the copy cannot be saved.
   */
  private async reconcile(): Promise<boolean> {
    try {
      if (await this.adapter.exists(this.path)) {
        const text = await this.adapter.read(this.path);
        const f = parseInkFile(text, this.docId);
        if (readable(text, f)) this.merge(f);
        else await this.adapter.write(unreadablePath(this.path, new Date()), text);
        this.ownExisted = true;
      }
    } catch (e) {
      console.error('[study] ink: reading this device\'s file before a write failed; not written', this.path, e);
      return false;
    }
    this.ownClean = true;
    return true;
  }

  /** Merges this device's file, read again, into memory (reconcile). */
  private merge(disk: InkFile): void {
    const own = this.own();
    const have = new Set(own.strokes.map(s => s.id));
    const add = disk.strokes.filter(s => !have.has(s.id));
    if (add.length) own.strokes = [...add, ...own.strokes];
    const hide = new Set([...(own.hide ?? []), ...(disk.hide ?? [])]);
    if (hide.size) own.hide = [...hide];
    const keep = { ...(disk.keep ?? {}), ...(own.keep ?? {}) };
    if (Object.keys(keep).length) own.keep = keep;
    this.recompute('sync');
  }

  /** True while a change waits to be written. */
  pending(): boolean { return this.dirty; }
}

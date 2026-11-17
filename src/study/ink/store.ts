/**
 * One doc's ink across devices (SPEC.md, Storage: Ink). Reads every `ink/<doc-id>.<device>.json`,
 * shows their union, and writes only this device's file: 1 s after the last change, at once on
 * `pagehide` and when the page is hidden, and when the last user of the doc's ink lets go.
 * Strokes written before the files finish loading are kept and merged. Another device's file
 * changing on disk (a sync) is re-read.
 *
 * A device never writes another device's file. Deleting or keeping another device's stroke is
 * recorded in this device's own file (`hide`, `keep`; model.ts) and applied to the union.
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
    try {
      if (await this.adapter.exists(folder)) paths = (await this.adapter.list(folder)).files;
    } catch (e) { console.error('[study] ink: listing failed', e); }
    for (const p of paths) {
      const dev = deviceOf(p, this.root, this.docId);
      if (!dev) continue;
      try {
        this.files.set(dev, parseInkFile(await this.adapter.read(p), this.docId));
        if (dev === this.device) this.ownExisted = true;
      } catch (e) { console.error('[study] ink: reading failed', p, e); }
    }
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
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, SAVE_DELAY_MS * 5);
    }
  }

  /** True while a change waits to be written. */
  pending(): boolean { return this.dirty; }
}

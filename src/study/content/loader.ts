/**
 * Reads every markdown file under the study root into a ContentIndex, lazily on first use, and
 * rebuilds it (debounced) when a file under the root changes. Owned by S3 (study view).
 */
import { TFile, type App, type EventRef } from 'obsidian';
import { buildIndex } from '../format/index-build';
import type { ContentIndex } from '../types';

const EMPTY: ContentIndex = {
  docs: new Map(), usedBy: new Map(), anchors: new Map(), problems: new Map(), katas: new Map(),
  bank: new Map(), tracks: [], methods: new Map(), warnings: [],
};

export class ContentLoader {
  private current: ContentIndex = EMPTY;
  private loaded = false;
  private timer: number | null = null;

  constructor(private app: App, private root: () => string, private changed: () => void) {}

  index(): ContentIndex {
    if (!this.loaded) { this.loaded = true; void this.reload(); }
    return this.current;
  }

  async reload(): Promise<ContentIndex> {
    const prefix = this.root().replace(/\/+$/, '') + '/';
    const files = this.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === 'md');
    const sources = await Promise.all(files.map(async f => ({ path: f.path, text: await this.app.vault.cachedRead(f) })));
    this.current = buildIndex(sources);
    this.loaded = true;
    this.changed();
    return this.current;
  }

  /** Vault listeners; returns the cleanup for plugin.register. */
  watch(): () => void {
    const refs: EventRef[] = [];
    const touch = (path: string) => {
      if (!this.loaded || !path.startsWith(this.root().replace(/\/+$/, '') + '/') || !path.endsWith('.md')) return;
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { this.timer = null; void this.reload(); }, 500);
    };
    const v = this.app.vault;
    refs.push(v.on('modify', f => { if (f instanceof TFile) touch(f.path); }));
    refs.push(v.on('create', f => { if (f instanceof TFile) touch(f.path); }));
    refs.push(v.on('delete', f => touch(f.path)));
    refs.push(v.on('rename', (f, old) => { touch(f.path); touch(old); }));
    return () => { for (const r of refs) v.offref(r); if (this.timer !== null) window.clearTimeout(this.timer); };
  }
}

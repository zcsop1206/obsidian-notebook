// The study event store (SPEC.md, Storage) against a fake vault adapter: reading every device's log,
// skipping bad lines, dedupe and sort, append with and without adapter.append, rotation past 5 MB,
// and the debounced reload on vault events.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import { EventStore, ROTATE_BYTES, cleanDevice, mergeEvents, parseLog } from '../../src/study/store/events';
import { foldState } from '../../src/study/engine';
import { buildIndex } from '../../src/study/format/index-build';
import type { StudyEvent } from '../../src/study/types';

type Handler = (...args: unknown[]) => void;

function fakeApp(opts: { append?: boolean; stat?: boolean } = {}) {
  const fs = new Map<string, string>();
  const dirs = new Set<string>();
  const sizes = new Map<string, number>();
  const calls: string[] = [];
  const handlers: Record<string, Handler[]> = {};
  const adapter: Record<string, unknown> = {
    async exists(p: string) { return fs.has(p) || dirs.has(p); },
    async mkdir(p: string) { calls.push(`mkdir ${p}`); dirs.add(p); },
    async write(p: string, d: string) { calls.push(`write ${p}`); fs.set(p, String(d)); },
    async read(p: string) { calls.push(`read ${p}`); if (!fs.has(p)) throw new Error(`ENOENT ${p}`); return fs.get(p)!; },
    async list(p: string) {
      calls.push(`list ${p}`);
      const kids = (q: string) => q.startsWith(p + '/') && !q.slice(p.length + 1).includes('/');
      return { files: [...fs.keys()].filter(kids), folders: [...dirs].filter(kids) };
    },
  };
  if (opts.append !== false) {
    adapter.append = async (p: string, d: string) => {
      calls.push(`append ${p}`);
      if (!fs.has(p)) throw new Error(`append to missing ${p}`);
      fs.set(p, fs.get(p)! + d);
    };
  }
  if (opts.stat) {
    adapter.stat = async (p: string) => (fs.has(p) ? { type: 'file', size: sizes.get(p) ?? new TextEncoder().encode(fs.get(p)!).length, ctime: 0, mtime: 0 } : null);
  }
  const vault = {
    adapter,
    on(name: string, cb: Handler) { (handlers[name] = handlers[name] || []).push(cb); return { name, cb }; },
    offref(ref: { name: string; cb: Handler }) { const L = handlers[ref.name] || []; const i = L.indexOf(ref.cb); if (i >= 0) L.splice(i, 1); },
    trigger(name: string, ...args: unknown[]) { for (const cb of [...(handlers[name] || [])]) cb(...args); },
    handlerCount() { return Object.values(handlers).reduce((n, L) => n + L.length, 0); },
  };
  return { app: { vault } as unknown as App, fs, dirs, sizes, calls, vault };
}

function line(e: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, dev: 'x', ...e });
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

test('reload reads every device\'s log, skips bad lines (counted), dedupes by id and sorts by time then id', async () => {
  const f = fakeApp();
  f.dirs.add('study');
  f.dirs.add('study/log');
  // 16:00+02:00 is 14:00Z, earlier than 10:00-05:00 (15:00Z), though it sorts later as text
  f.fs.set('study/log/ipad.jsonl', [
    line({ id: 'ipad-b', t: '2026-11-15T10:00:00.000-05:00', type: 'open', doc: 'a' }),
    '',
    '{not json',
    line({ id: 'ipad-a', t: '2026-11-15T10:00:00.000-05:00', type: 'open', doc: 'b' }),
    JSON.stringify({ id: 'no-version', t: '2026-11-15T10:00:00Z', type: 'open' }),
    line({ id: 'bad-time', t: 'yesterday', type: 'open' }),
    '',
  ].join('\n'));
  f.fs.set('study/log/desktop.jsonl', [
    line({ id: 'desk-1', t: '2026-11-15T16:00:00.000+02:00', type: 'open', doc: 'c' }),
    line({ id: 'ipad-a', t: '2026-11-15T10:00:00.000-05:00', type: 'open', doc: 'dup' }),
  ].join('\r\n') + '\r\n');
  f.fs.set('study/log/readme.txt', 'not a log');
  f.fs.set('study/basics/x.jsonl', line({ id: 'elsewhere', t: '2026-11-15T10:00:00Z', type: 'open', doc: 'z' }));
  let changed = 0;
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => { changed++; });
  assert.deepEqual(store.all(), []);
  const all = await store.reload();
  assert.deepEqual(all.map(e => e.id), ['desk-1', 'ipad-a', 'ipad-b']);
  assert.equal(store.skipped, 3, 'bad JSON, no version, bad time');
  assert.equal(changed, 1);
  assert.equal(store.loaded(), true);
  await store.reload();
  assert.equal(changed, 1, 'nothing new: no change notice');
});

test('a missing log folder reads as no events', async () => {
  const f = fakeApp();
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => {});
  assert.deepEqual(await store.reload(), []);
  assert.equal(store.skipped, 0);
});

test('append creates the folders and the file, fills id, t and dev, and the engine sees it at once', async () => {
  const f = fakeApp();
  let changed = 0;
  const store = new EventStore(f.app, () => 'content/study/', () => 'iPad Pro', () => { changed++; });
  const p = store.append({ type: 'mark', doc: 'fe-moves', a: 'p-crt', verb: 'lost', build: 1 });
  assert.equal(store.all().length, 1, 'in memory before the write resolves');
  assert.equal(changed, 1);
  const e = await p;
  assert.equal(e.v, 1);
  assert.equal(e.dev, 'ipad-pro');
  assert.match(e.id, /^ipad-pro-[0-9a-z]+-[0-9a-z]{4}$/);
  assert.match(e.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, 'ISO with the device offset');
  assert.ok(Math.abs(Date.parse(e.t) - Date.now()) < 5000);
  assert.ok(f.dirs.has('content') && f.dirs.has('content/study') && f.dirs.has('content/study/log'));
  const text = f.fs.get('content/study/log/ipad-pro.jsonl')!;
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(parseLog(text).events, [e]);
  await store.append({ type: 'attempt', doc: 'fe-moves', a: 'p-crt', strokes: 3 });
  assert.ok(f.calls.includes('append content/study/log/ipad-pro.jsonl'), 'adapter.append once the file exists');
  assert.equal(parseLog(f.fs.get('content/study/log/ipad-pro.jsonl')!).events.length, 2);
  const again = new EventStore(f.app, () => 'content/study', () => 'laptop', () => {});
  assert.deepEqual((await again.reload()).map(x => x.id), store.all().map(x => x.id), 'another device reads it back');
});

test('without adapter.append (before Obsidian 1.12.3) append reads and writes; concurrent appends keep order', async () => {
  const f = fakeApp({ append: false });
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => {});
  const written = await Promise.all([0, 1, 2, 3, 4].map(i => store.append({ type: 'attempt', doc: 'd', a: `a${i}`, strokes: i })));
  assert.ok(!f.calls.some(c => c.startsWith('append')));
  const back = parseLog(f.fs.get('study/log/ipad.jsonl')!).events;
  assert.deepEqual(back.map(e => e.id), written.map(e => e.id), 'every line, in order, none lost');
});

test('rotation: a log past 5 MB starts <device>-2.jsonl, then continues the highest part', async () => {
  const f = fakeApp({ stat: true });
  f.dirs.add('study');
  f.dirs.add('study/log');
  f.fs.set('study/log/ipad.jsonl', line({ id: 'old', t: '2026-11-01T10:00:00Z', type: 'open', doc: 'a' }) + '\n');
  f.sizes.set('study/log/ipad.jsonl', ROTATE_BYTES);
  f.fs.set('study/log/ipadx.jsonl', '');
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => {});
  await store.append({ type: 'open', doc: 'b' });
  assert.ok(f.fs.has('study/log/ipad-2.jsonl'), 'a new part');
  assert.equal(parseLog(f.fs.get('study/log/ipad.jsonl')!).events.length, 1, 'the full part is left as it was');
  // a fresh session finds the highest part and continues it
  const g = fakeApp({ stat: true });
  g.dirs.add('study');
  g.dirs.add('study/log');
  for (const n of ['ipad', 'ipad-2', 'ipad-3']) g.fs.set(`study/log/${n}.jsonl`, '');
  g.sizes.set('study/log/ipad.jsonl', ROTATE_BYTES + 10);
  g.sizes.set('study/log/ipad-2.jsonl', ROTATE_BYTES + 10);
  const s2 = new EventStore(g.app, () => 'study', () => 'ipad', () => {});
  await s2.append({ type: 'open', doc: 'b' });
  assert.equal(parseLog(g.fs.get('study/log/ipad-3.jsonl')!).events.length, 1);
  // without stat, the size comes from reading the file
  const h = fakeApp();
  h.dirs.add('study');
  h.dirs.add('study/log');
  h.fs.set('study/log/ipad.jsonl', 'x'.repeat(ROTATE_BYTES));
  const s3 = new EventStore(h.app, () => 'study', () => 'ipad', () => {});
  await s3.append({ type: 'open', doc: 'b' });
  assert.ok(h.fs.has('study/log/ipad-2.jsonl'));
  // the store rotates by itself as its own appends pass the limit
  const k = fakeApp({ stat: true });
  const s4 = new EventStore(k.app, () => 'study', () => 'ipad', () => {});
  await s4.append({ type: 'open', doc: 'b' });
  (s4 as unknown as { current: { bytes: number } }).current.bytes = ROTATE_BYTES;
  await s4.append({ type: 'open', doc: 'c' });
  assert.ok(k.fs.has('study/log/ipad-2.jsonl'));
});

test('a reload that races an append keeps this session\'s events; a reload picks up another device\'s new lines', async () => {
  const f = fakeApp();
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => {});
  const e = await store.append({ type: 'open', doc: 'a' });
  f.fs.delete('study/log/ipad.jsonl'); // as if the read came before the write landed
  assert.deepEqual((await store.reload()).map(x => x.id), [e.id]);
  f.fs.set('study/log/laptop.jsonl', line({ id: 'laptop-1', t: '2020-01-01T00:00:00Z', type: 'open', doc: 'b' }) + '\n');
  assert.deepEqual((await store.reload()).map(x => x.id), ['laptop-1', e.id]);
});

test('watch: the first load, then a reload debounced 300 ms after changes to logs under the root only; cleanup removes the listeners', async () => {
  const f = fakeApp();
  f.dirs.add('study');
  f.dirs.add('study/log');
  f.fs.set('study/log/laptop.jsonl', line({ id: 'l1', t: '2026-11-15T10:00:00Z', type: 'open', doc: 'a' }) + '\n');
  let changed = 0;
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => { changed++; });
  const stop = store.watch();
  await wait(20);
  assert.deepEqual(store.all().map(e => e.id), ['l1'], 'watch loads the logs');
  assert.equal(changed, 1);
  const lists = () => f.calls.filter(c => c === 'list study/log').length;
  const n0 = lists();
  f.fs.set('study/log/laptop.jsonl', f.fs.get('study/log/laptop.jsonl') + line({ id: 'l2', t: '2026-11-15T11:00:00Z', type: 'open', doc: 'b' }) + '\n');
  f.vault.trigger('modify', { path: 'study/log/laptop.jsonl' });
  f.vault.trigger('modify', { path: 'study/log/laptop.jsonl' });
  f.vault.trigger('create', { path: 'study/log/phone.jsonl' });
  f.vault.trigger('modify', { path: 'study/basics/fe-div.md' });
  f.vault.trigger('modify', { path: 'other/log/x.jsonl' });
  await wait(100);
  assert.equal(lists(), n0, 'debounced: nothing yet');
  await wait(350);
  assert.equal(lists(), n0 + 1, 'one reload for the burst');
  assert.deepEqual(store.all().map(e => e.id), ['l1', 'l2']);
  assert.equal(changed, 2);
  f.vault.trigger('rename', { path: 'study/notes.md' }, 'study/log/old.jsonl');
  await wait(400);
  assert.equal(lists(), n0 + 2, 'a rename away from log/ counts');
  stop();
  assert.equal(f.vault.handlerCount(), 0);
  f.vault.trigger('modify', { path: 'study/log/laptop.jsonl' });
  await wait(400);
  assert.equal(lists(), n0 + 2, 'no reload after cleanup');
});

test('device names: lowercase, file-safe, and never read as another device\'s log part', () => {
  assert.equal(cleanDevice('iPad Pro'), 'ipad-pro');
  assert.equal(cleanDevice('ipad-2'), 'ipad2');
  assert.equal(cleanDevice('  Laptop!! '), 'laptop');
  assert.equal(cleanDevice(''), 'device');
});

test('mergeEvents and the engine: events from the store fold into the engine', async () => {
  const f = fakeApp();
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => {});
  const a = await store.append({ type: 'open', doc: 'fx-div' });
  const b: StudyEvent = { v: 1, id: 'laptop-0', t: '2020-01-01T00:00:00Z', dev: 'laptop', type: 'open', doc: 'fx-units' };
  assert.deepEqual(mergeEvents([[a], [b, a]]).map(e => e.id), ['laptop-0', a.id]);
  const content = buildIndex([
    { path: 'study/basics/fx-div.md', text: '---\nstudy: basic\nid: fx-div\ntitle: D\narea: nt\nneeds: []\nbuild: 1\n---\n\nText. ^t\n' },
  ]);
  const eng = foldState(content, store.all(), new Date());
  assert.equal(eng.basic('fx-div').stage, 1, 'opened on this device');
});

test('overlapping reloads: an older, slower read never replaces a newer one, so newly synced events are not dropped', async () => {
  const f = fakeApp();
  f.dirs.add('study');
  f.dirs.add('study/log');
  f.fs.set('study/log/ipad.jsonl', line({ id: 'ipad-1', t: '2026-11-15T10:00:00Z', type: 'open', doc: 'a' }) + '\n');
  const adapter = f.app.vault.adapter as unknown as { read: (p: string) => Promise<string> };
  const read = adapter.read.bind(adapter);
  // The first reload's read is slow: it sees the file before the sync and finishes last.
  let slow = true;
  adapter.read = async (p: string) => {
    const text = await read(p);
    if (slow) { slow = false; await wait(40); }
    return text;
  };
  let changed = 0;
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => { changed++; });
  const first = store.reload();
  await wait(5);
  // another device's log arrives by sync while the first read is still in flight
  f.fs.set('study/log/desktop.jsonl', line({ id: 'desk-1', t: '2026-11-15T11:00:00Z', type: 'open', doc: 'b' }) + '\n');
  const second = store.reload();
  assert.deepEqual((await second).map(e => e.id), ['ipad-1', 'desk-1']);
  assert.deepEqual((await first).map(e => e.id), ['ipad-1', 'desk-1'], 'the superseded reload answers with the newer read');
  assert.deepEqual(store.all().map(e => e.id), ['ipad-1', 'desk-1'], 'the older read did not overwrite the list');
  assert.equal(changed, 1);
});

test('a failed log write stays pending and is retried, in order, on the next append or reload', async () => {
  const f = fakeApp();
  const adapter = f.app.vault.adapter as unknown as { append: (p: string, d: string) => Promise<void>; write: (p: string, d: string) => Promise<void> };
  const write = adapter.write.bind(adapter);
  const append = adapter.append.bind(adapter);
  let failing = true;
  adapter.write = async (p, d) => { if (failing) throw new Error('disk full'); return write(p, d); };
  adapter.append = async (p, d) => { if (failing) throw new Error('disk full'); return append(p, d); };
  const store = new EventStore(f.app, () => 'study', () => 'ipad', () => {});
  const errors = console.error;
  console.error = () => {};
  try {
    const a = await store.append({ type: 'open', doc: 'a' }).then(() => 'written', () => 'failed');
    assert.equal(a, 'failed');
    assert.equal(store.pending(), 1);
    assert.deepEqual(store.all().map(e => e.type === 'open' && e.doc), ['a'], 'the engine still sees it');
    assert.equal(f.fs.get('study/log/ipad.jsonl'), undefined);
    const b = await store.append({ type: 'open', doc: 'b' }).then(() => 'written', () => 'failed');
    assert.equal(b, 'failed', 'still failing: both wait');
    assert.equal(store.pending(), 2);
    failing = false;
    await store.append({ type: 'open', doc: 'c' });
    assert.equal(store.pending(), 0);
    assert.deepEqual(parseLog(f.fs.get('study/log/ipad.jsonl')!).events.map(e => e.type === 'open' && e.doc), ['a', 'b', 'c'], 'retried in order, each once');
    // a reload retries too
    failing = true;
    await store.append({ type: 'open', doc: 'd' }).catch(() => {});
    assert.equal(store.pending(), 1);
    failing = false;
    await store.reload();
    await wait(0);
    for (let i = 0; i < 20 && store.pending(); i++) await wait(5);
    assert.equal(store.pending(), 0);
    assert.deepEqual(parseLog(f.fs.get('study/log/ipad.jsonl')!).events.map(e => e.type === 'open' && e.doc), ['a', 'b', 'c', 'd']);
  } finally {
    console.error = errors;
  }
});

// Custom templates (#21, #54) and sized templates in the store (#27): the registry over a fake
// vault folder (any page file without strokes, `tpl:` names with `pdf:` read as an alias; saving,
// renaming and deleting), and the store's template resolver (custom defaults, size inheritance,
// the PDF copy).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage } from '../../src/format/page';
import { parseTemplateName, type ImageTemplate, type PdfTemplate } from '../../src/format/template';
import { NoteStore, type NoteFiles } from '../../src/ink/store';
import { canonicalName, cleanFolder, isCustomName, TemplateRegistry } from '../../src/ink/templates';

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ+/8=';

/** Just enough of Obsidian's vault for the registry: files in a map, events. */
function fakeVault() {
  const files = new Map<string, string | ArrayBuffer>();
  const dirs = new Set<string>();
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  const file = (path: string) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return { path, name, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : '' };
  };
  const trigger = (name: string, ...a: unknown[]) => (handlers[name] ?? []).forEach(h => h(...a));
  const vault = {
    reads: 0,
    getFiles: () => [...files.keys()].map(file),
    getFileByPath: (p: string) => (files.has(p) ? file(p) : null),
    getAbstractFileByPath: (p: string) => (files.has(p) || dirs.has(p) ? file(p) : null),
    cachedRead: async (f: { path: string }) => { vault.reads++; return files.get(f.path) as string; },
    readBinary: async (f: { path: string }) => files.get(f.path) as ArrayBuffer,
    read: async (f: { path: string }) => files.get(f.path) as string,
    createFolder: async (p: string) => { dirs.add(p); },
    createBinary: async (p: string, d: ArrayBuffer) => { files.set(p, d); trigger('create', file(p)); },
    create: async (p: string, d: string) => { if (files.has(p)) throw new Error('exists'); files.set(p, d); trigger('create', file(p)); },
    modify: async (f: { path: string }, d: string) => { files.set(f.path, d); trigger('modify', file(f.path)); },
    rename: async (f: { path: string }, to: string) => {
      if (files.has(to)) throw new Error('exists');
      files.set(to, files.get(f.path)!); files.delete(f.path); trigger('rename', file(to), f.path);
    },
    delete: async (f: { path: string }) => { files.delete(f.path); trigger('delete', file(f.path)); },
    on: (name: string, cb: (...a: unknown[]) => void) => { (handlers[name] ??= []).push(cb); return { name, cb }; },
    put: (p: string, d: string | ArrayBuffer, ev = 'create') => { files.set(p, d); trigger(ev, file(p)); },
    files,
  };
  return vault;
}

function registryWith(folder = 'templates/ink') {
  const vault = fakeVault();
  const app = { vault } as never;
  const component = { registerEvent: () => {} } as never;
  const written = writePage(newPage('p-000009', undefined, { kind: 'blank' }));
  const reg = new TemplateRegistry(app, () => folder);
  reg.watch(component);
  const tpl = (source: string, page = 1, size = { width: 816, height: 1056 }) =>
    writePage(newPage('p-000001', size, { kind: 'pdf', source, page, image: IMAGE }));
  vault.files.set('templates/ink/Engineering.svg', tpl('Engineering.pdf', 2, { width: 612, height: 792 }));
  vault.files.set('templates/ink/Engineering.pdf', new Uint8Array([1, 2, 3]).buffer);
  vault.files.set('templates/ink/Lab.svg', tpl('Lab.pdf'));
  vault.files.set('templates/ink/Lab.pdf', new Uint8Array([4]).buffer);
  vault.files.set('templates/ink/Lined.svg', writePage(newPage('p-000002', undefined, parseTemplateName('lined-college'))));
  // A page with writing on it is not a template.
  vault.files.set('templates/ink/Written.svg', written.replace('"strokes":[]', '"strokes":[{"id":"s-000001","tool":"pen","nib":"uniform","color":"#000000","size":2,"points":[[1,1,0.5,0],[5,5,0.5,8]]}]'));
  vault.files.set('templates/ink/notes.md', '# not a template');
  vault.files.set('templates/ink/broken.svg', '<svg/>');
  vault.files.set('templates/ink/sub/Deep.svg', tpl('Deep.pdf'));
  vault.files.set('elsewhere/Other.svg', tpl('Other.pdf'));
  return { vault, reg };
}

test('registry: lists the page files without strokes directly in the folder, any kind, sorted, cached until the folder changes', async () => {
  const { vault, reg } = registryWith();
  assert.ok(vault.files.get('templates/ink/Written.svg')!.toString().includes('s-000001'), 'the written page has a stroke');
  assert.deepEqual(reg.entries, []);
  const list = await reg.load();
  assert.deepEqual(list.map(e => e.name), ['tpl:Engineering', 'tpl:Lab', 'tpl:Lined']);
  assert.deepEqual(list[0].size, { width: 612, height: 792 });
  assert.equal((list[0].template as PdfTemplate).page, 2);
  assert.equal((list[0].template as PdfTemplate).image, IMAGE);
  assert.deepEqual([list[2].template, list[2].size], [{ kind: 'lined', rule: 'college', margin: false }, { width: 816, height: 1056 }]);
  assert.equal(reg.entries.length, 3);
  const reads = vault.reads;
  await reg.load();
  assert.equal(vault.reads, reads, 'cached');
  assert.equal(reg.scans, 1);
  // A change elsewhere keeps the cache; one in the folder reloads.
  vault.put('elsewhere/x.md', 'x');
  await reg.load();
  assert.equal(reg.scans, 1);
  vault.put('templates/ink/Zeta.svg', writePage(newPage('p-000003', undefined, { kind: 'pdf', source: 'Zeta.pdf', page: 1, image: '' })));
  assert.deepEqual((await reg.load()).map(e => e.name), ['tpl:Engineering', 'tpl:Lab', 'tpl:Lined', 'tpl:Zeta']);
  assert.equal(reg.scans, 2);
});

test('registry: tpl: names, with pdf: read as an alias of the same file', async () => {
  const { reg } = registryWith();
  await reg.load();
  assert.deepEqual(reg.resolve('tpl:Engineering'), reg.resolve('pdf:Engineering'));
  assert.equal(reg.get('pdf:Lined')!.name, 'tpl:Lined', 'any kind answers to either prefix');
  assert.equal(canonicalName('pdf:Lab'), 'tpl:Lab');
  assert.equal(canonicalName('lined-college'), 'lined-college');
  assert.deepEqual(['tpl:x', 'pdf:x', 'tpl:', 'blank', 'fill-ffffff'].map(isCustomName), [true, true, false, false, false]);
});

test('registry: resolve, nameOf and a changed folder setting', async () => {
  let folder = 'templates/ink/';
  const { reg } = registryWith();
  (reg as unknown as { folderSetting: () => string }).folderSetting = () => folder;
  assert.equal(reg.folder, 'templates/ink');
  await reg.load();
  const r = reg.resolve('pdf:Engineering')!;
  assert.deepEqual(r.size, { width: 612, height: 792 });
  assert.equal((r.template as PdfTemplate).source, 'Engineering.pdf');
  (r.template as PdfTemplate).page = 9; // a fresh copy
  assert.equal(reg.resolve('pdf:Engineering')!.template.kind, 'pdf');
  assert.equal((reg.resolve('pdf:Engineering')!.template as PdfTemplate).page, 2);
  assert.equal(reg.resolve('pdf:Nope'), null);
  assert.equal(reg.nameOf(reg.resolve('pdf:Lab')!.template), 'tpl:Lab');
  assert.equal(reg.nameOf(reg.resolve('tpl:Lined')!.template), null, 'a lined template is named by whoever chose it');
  assert.equal(reg.nameOf({ kind: 'pdf', source: 'Lab.pdf', page: 1, image: '' }), null, 'an imported page with another image');
  assert.equal(reg.nameOf({ kind: 'blank' }), null);
  folder = 'elsewhere';
  assert.deepEqual((await reg.load()).map(e => e.name), ['tpl:Other']);
  assert.equal(cleanFolder('/a//b/'), 'a/b');
});

test('registry: ensureCopied copies the PDF into a page folder once', async () => {
  const { vault, reg } = registryWith();
  await reg.load();
  const t = reg.resolve('pdf:Engineering')!.template;
  await Promise.all([reg.ensureCopied(t, 'School/lecture'), reg.ensureCopied(t, 'School/lecture')]);
  assert.deepEqual(new Uint8Array(vault.files.get('School/lecture/Engineering.pdf') as ArrayBuffer), new Uint8Array([1, 2, 3]));
  vault.files.set('School/lecture/Engineering.pdf', new Uint8Array([9]).buffer);
  await reg.ensureCopied(t, 'School/lecture');
  assert.deepEqual(new Uint8Array(vault.files.get('School/lecture/Engineering.pdf') as ArrayBuffer), new Uint8Array([9]), 'kept');
  await reg.ensureCopied({ kind: 'blank' }, 'School/lecture'); // nothing to do
});

// ---- the store

class MemFiles implements NoteFiles {
  files = new Map<string, string>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, text: string) { this.files.set(path, text); }
  list(folder: string) { return [...this.files.keys()].filter(k => k.startsWith(folder + '/')).map(k => k.slice(folder.length + 1)); }
}

async function openStore(paper: string, template: string, options = {}) {
  const files = new MemFiles();
  const note = newNote('lec', paper as never, template);
  note.pages = ['p-000001'];
  files.files.set('dir/lec.md', writeNote(note));
  files.files.set('dir/lec/p-000001.svg', writePage(newPage('p-000001')));
  let next = 0xb0;
  const store = new NoteStore(files, 'dir/lec.md', 'lec', {
    pageChanged: () => {}, indexChanged: () => {}, notice: () => {}, saved: () => {},
  }, { newId: () => `p-${(next++).toString(16).padStart(6, '0')}`, ...options });
  await store.load();
  return { files, store };
}

test('store: a sticky note\'s pages inherit its paper; a sized template or size given per page wins', async () => {
  const { files, store } = await openStore('288x288', 'sticky-3in');
  assert.deepEqual(store.paperSize, { width: 288, height: 288 });
  const a = store.addPage();
  assert.deepEqual(a.size, { width: 288, height: 288 });
  assert.deepEqual(a.page!.template, { kind: 'fill', color: '#fff59d' });
  const b = store.addPage(parseTemplateName('lined-college'));
  assert.deepEqual(b.size, { width: 288, height: 288 }, 'another template: the paper');
  const c = store.addPage(parseTemplateName('index-card'), { width: 480, height: 288 });
  assert.deepEqual(c.size, { width: 480, height: 288 });
  const d = store.insertPage(0, { kind: 'blank' }, { width: 816, height: 1056 });
  assert.deepEqual(d.size, { width: 816, height: 1056 });
  await store.flush();
  assert.deepEqual(readPage(files.files.get(`dir/lec/${c.id}.svg`)!).size, { width: 480, height: 288 });
  const re = readNote(files.files.get('dir/lec.md')!, 'lec');
  assert.equal(re.paper, '288x288');
  assert.equal(re.pages.length, 5);
});

test('store: a letter note whose default is a sized built-in gets pages of that size', async () => {
  const { store } = await openStore('letter', 'index-card');
  assert.deepEqual(store.addPage().size, { width: 480, height: 288 });
});

test('store: pdf:<name> and tpl:<name> defaults resolve through the resolver; unknown names fall back to blank', async () => {
  const { reg, vault } = registryWith();
  await reg.load();
  const used: string[] = [];
  const opts = reg.storeOptions();
  const { store, files } = await openStore('612x792', 'pdf:Engineering', {
    ...opts, templateUsed: (t: PdfTemplate, folder: string) => { used.push(`${t.source} ${folder}`); opts.templateUsed!(t, folder); },
  });
  const slot = store.addPage();
  assert.deepEqual(slot.size, { width: 612, height: 792 });
  const t = slot.page!.template as PdfTemplate;
  assert.deepEqual([t.kind, t.source, t.page, t.image], ['pdf', 'Engineering.pdf', 2, IMAGE]);
  assert.deepEqual(used, ['Engineering.pdf dir/lec']);
  await new Promise(r => setTimeout(r, 0));
  assert.ok(vault.files.has('dir/lec/Engineering.pdf'), 'the PDF copied into the page folder');
  // Setting it as every page's template names it back, as tpl:Lab.
  store.setAllTemplates(reg.resolve('pdf:Lab')!.template);
  assert.equal(store.index.template, 'tpl:Lab');
  await store.flush();
  assert.match(files.files.get('dir/lec.md')!, /template: tpl:Lab/);
  // A tpl: default of another kind, at its own size; setAllTemplates takes the chooser's name.
  const { store: s4 } = await openStore('letter', 'tpl:Lined', opts);
  assert.deepEqual(s4.addPage().page!.template, { kind: 'lined', rule: 'college', margin: false });
  s4.setAllTemplates({ kind: 'fill', color: '#fff59d' }, { width: 400, height: 400 }, 'tpl:Big sticky');
  assert.equal(s4.index.template, 'tpl:Big sticky');
  s4.setAllTemplates({ kind: 'fill', color: '#fff59d' }, { width: 288, height: 288 });
  assert.equal(s4.index.template, 'sticky-3in', 'without a name: the built-in name');
  // Changing one pdf template for another is a change (not both named `pdf`).
  const before = store.setPageTemplate(slot.id, reg.resolve('pdf:Engineering')!.template);
  assert.equal((before as PdfTemplate).source, 'Lab.pdf');
  assert.equal((store.page(slot) !.template as PdfTemplate).source, 'Engineering.pdf');

  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  try {
    const { store: s2 } = await openStore('letter', 'pdf:Missing', opts);
    assert.deepEqual(s2.addPage().page!.template, { kind: 'blank' });
    const { store: s5 } = await openStore('letter', 'tpl:Missing', opts);
    assert.deepEqual(s5.addPage().page!.template, { kind: 'blank' });
    const { store: s3 } = await openStore('letter', 'pdf:Engineering');
    assert.deepEqual(s3.addPage().page!.template, { kind: 'blank' }, 'no resolver');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 3);
});

test('store: changing a page\'s template to a sized one sets its size; the old size restores it', async () => {
  const { store, files } = await openStore('letter', 'blank');
  const slot = store.slots[0];
  const had = { ...slot.size };
  const before = store.setPageTemplate(slot.id, parseTemplateName('sticky-3in'), { width: 288, height: 288 });
  assert.deepEqual(before, { kind: 'blank' });
  assert.deepEqual([slot.size, store.page(slot)!.size], [{ width: 288, height: 288 }, { width: 288, height: 288 }]);
  await store.flush();
  assert.deepEqual(readPage(files.files.get(slot.path)!).size, { width: 288, height: 288 });
  store.setPageTemplate(slot.id, before!, had);
  assert.deepEqual(store.page(slot)!.size, { width: 816, height: 1056 });
  // Without a size, the size is kept.
  store.setPageTemplate(slot.id, { kind: 'grid', spacing: '5mm' });
  assert.deepEqual(slot.size, { width: 816, height: 1056 });
  // All pages: each entry of what was replaced has the size it had.
  store.addPage();
  const all = store.setAllTemplates(parseTemplateName('index-card'), { width: 480, height: 288 });
  assert.deepEqual(all.pages.map(p => p.size), [{ width: 816, height: 1056 }, { width: 816, height: 1056 }]);
  assert.ok(store.slots.every(s => s.size.width === 480 && s.size.height === 288));
  for (const p of all.pages) store.setPageTemplate(p.id, p.template, p.size);
  assert.ok(store.slots.every(s => s.size.width === 816));
});

test('registry: save writes a page file without strokes (a PDF beside it for a pdf template) and lists it', async () => {
  const { vault, reg } = registryWith('templates/new');
  const fill = await reg.save('Big sticky', { kind: 'fill', color: '#FFEE00' }, { width: 400, height: 300 });
  assert.equal(fill, 'tpl:Big sticky');
  const pg = readPage(vault.files.get('templates/new/Big sticky.svg') as string);
  assert.deepEqual([pg.template, pg.size, pg.strokes.length], [{ kind: 'fill', color: '#ffee00' }, { width: 400, height: 300 }, 0]);
  assert.deepEqual(reg.resolve(fill), { template: { kind: 'fill', color: '#ffee00' }, size: { width: 400, height: 300 } });
  // Taken names get a number; unsafe characters are cleaned.
  assert.equal(await reg.save('Big sticky', { kind: 'blank' }, { width: 100, height: 100 }), 'tpl:Big sticky 1');
  assert.equal(await reg.save('a/b:c', { kind: 'blank' }, { width: 100, height: 100 }), 'tpl:a b c');
  const pdf = await reg.save('Slide', { kind: 'pdf', source: 'lecture.pdf', page: 3, image: IMAGE }, { width: 612, height: 792 }, new Uint8Array([7, 7]).buffer);
  const t = reg.resolve(pdf)!.template as PdfTemplate;
  assert.deepEqual([t.source, t.page, t.image], ['Slide.pdf', 3, IMAGE]);
  assert.deepEqual(new Uint8Array(vault.files.get('templates/new/Slide.pdf') as ArrayBuffer), new Uint8Array([7, 7]));
  let refused = false;
  await reg.save('No PDF', { kind: 'pdf', source: 'x.pdf', page: 1, image: '' }, { width: 1, height: 1 }).catch(() => { refused = true; });
  assert.ok(refused && !vault.files.has('templates/new/No PDF.svg'), 'a pdf template without its PDF is refused');
  const image: ImageTemplate = { kind: 'image', image: IMAGE };
  const im = await reg.save('Photo', image, { width: 816, height: 612 });
  assert.equal(reg.nameOf({ kind: 'image', image: IMAGE }), im, 'an image page made from it is named back');
  assert.equal(reg.nameOf({ kind: 'image', image: IMAGE.replace('/9j', '/8j') }), null);
});

test('registry: rename and delete a template (and its own PDF); pages made from it are untouched', async () => {
  const { vault, reg } = registryWith();
  await reg.load();
  // A note page made from Engineering keeps its copy.
  const t = reg.resolve('tpl:Engineering')!.template;
  await reg.ensureCopied(t, 'School/lecture');
  const renamed = await reg.rename('pdf:Engineering', 'Eng/2');
  assert.equal(renamed, 'tpl:Eng 2');
  assert.ok(!vault.files.has('templates/ink/Engineering.svg') && !vault.files.has('templates/ink/Engineering.pdf'));
  const pg = readPage(vault.files.get('templates/ink/Eng 2.svg') as string);
  assert.equal((pg.template as PdfTemplate).source, 'Eng 2.pdf', 'the page refers to the renamed PDF');
  assert.deepEqual(new Uint8Array(vault.files.get('templates/ink/Eng 2.pdf') as ArrayBuffer), new Uint8Array([1, 2, 3]));
  assert.deepEqual(reg.entries.map(e => e.name), ['tpl:Eng 2', 'tpl:Lab', 'tpl:Lined']);
  assert.ok(vault.files.has('School/lecture/Engineering.pdf'), 'the copy in the note stays');
  // A rename onto a taken name is numbered; to its own name, nothing happens.
  assert.equal(await reg.rename('tpl:Lined', 'Lab'), 'tpl:Lab 1');
  assert.equal(await reg.rename('tpl:Lab 1', 'Lab 1'), 'tpl:Lab 1');
  assert.equal(await reg.rename('tpl:Nope', 'x'), null);
  assert.equal(await reg.delete('tpl:Eng 2'), true);
  assert.ok(!vault.files.has('templates/ink/Eng 2.svg') && !vault.files.has('templates/ink/Eng 2.pdf'));
  assert.equal(await reg.delete('tpl:Eng 2'), false);
  assert.deepEqual(reg.entries.map(e => e.name), ['tpl:Lab', 'tpl:Lab 1']);
  assert.ok(vault.files.has('School/lecture/Engineering.pdf'));
});

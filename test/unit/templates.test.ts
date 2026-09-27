// PDF templates (#21) and sized templates in the store (#27): the registry over a fake vault
// folder, and the store's template resolver (`pdf:` defaults, size inheritance, the PDF copy).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNote, readNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage } from '../../src/format/page';
import { parseTemplateName, type PdfTemplate } from '../../src/format/template';
import { NoteStore, type NoteFiles } from '../../src/ink/store';
import { cleanFolder, TemplateRegistry } from '../../src/ink/templates';

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
    createFolder: async (p: string) => { dirs.add(p); },
    createBinary: async (p: string, d: ArrayBuffer) => { files.set(p, d); trigger('create', file(p)); },
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
  const reg = new TemplateRegistry(app, () => folder);
  reg.watch(component);
  const tpl = (source: string, page = 1, size = { width: 816, height: 1056 }) =>
    writePage(newPage('p-000001', size, { kind: 'pdf', source, page, image: IMAGE }));
  vault.files.set('templates/ink/Engineering.svg', tpl('Engineering.pdf', 2, { width: 612, height: 792 }));
  vault.files.set('templates/ink/Engineering.pdf', new Uint8Array([1, 2, 3]).buffer);
  vault.files.set('templates/ink/Lab.svg', tpl('Lab.pdf'));
  vault.files.set('templates/ink/Lab.pdf', new Uint8Array([4]).buffer);
  vault.files.set('templates/ink/Lined.svg', writePage(newPage('p-000002', undefined, parseTemplateName('lined-college'))));
  vault.files.set('templates/ink/notes.md', '# not a template');
  vault.files.set('templates/ink/broken.svg', '<svg/>');
  vault.files.set('templates/ink/sub/Deep.svg', tpl('Deep.pdf'));
  vault.files.set('elsewhere/Other.svg', tpl('Other.pdf'));
  return { vault, reg };
}

test('registry: lists the pdf-template pages directly in the folder, sorted, cached until the folder changes', async () => {
  const { vault, reg } = registryWith();
  assert.deepEqual(reg.entries, []);
  const list = await reg.load();
  assert.deepEqual(list.map(e => e.name), ['pdf:Engineering', 'pdf:Lab']);
  assert.deepEqual(list[0].size, { width: 612, height: 792 });
  assert.equal(list[0].template.page, 2);
  assert.equal(list[0].template.image, IMAGE);
  assert.equal(reg.entries.length, 2);
  const reads = vault.reads;
  await reg.load();
  assert.equal(vault.reads, reads, 'cached');
  assert.equal(reg.scans, 1);
  // A change elsewhere keeps the cache; one in the folder reloads.
  vault.put('elsewhere/x.md', 'x');
  await reg.load();
  assert.equal(reg.scans, 1);
  vault.put('templates/ink/Zeta.svg', writePage(newPage('p-000003', undefined, { kind: 'pdf', source: 'Zeta.pdf', page: 1, image: '' })));
  assert.deepEqual((await reg.load()).map(e => e.name), ['pdf:Engineering', 'pdf:Lab', 'pdf:Zeta']);
  assert.equal(reg.scans, 2);
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
  assert.equal(reg.nameOf(reg.resolve('pdf:Lab')!.template), 'pdf:Lab');
  assert.equal(reg.nameOf({ kind: 'pdf', source: 'Lab.pdf', page: 1, image: '' }), null, 'an imported page with another image');
  assert.equal(reg.nameOf({ kind: 'blank' }), null);
  folder = 'elsewhere';
  assert.deepEqual((await reg.load()).map(e => e.name), ['pdf:Other']);
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

test('store: pdf:<name> defaults resolve through the resolver; unknown names fall back to blank', async () => {
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
  // Setting it as every page's template names it back as pdf:Engineering.
  store.setAllTemplates(reg.resolve('pdf:Lab')!.template);
  assert.equal(store.index.template, 'pdf:Lab');
  await store.flush();
  assert.match(files.files.get('dir/lec.md')!, /template: pdf:Lab/);
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
    const { store: s3 } = await openStore('letter', 'pdf:Engineering');
    assert.deepEqual(s3.addPage().page!.template, { kind: 'blank' }, 'no resolver');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
});

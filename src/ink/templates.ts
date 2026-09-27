// Custom templates (#21, #54): a vault-aware registry of the templates in the templates folder
// (settings, default `templates/ink`). A custom template is an ordinary ink page file there with
// no strokes, `<name>.svg`: its template (any kind: blank, lined, grid, dots, fill, pdf, image)
// and its page size are the template. A PDF template (#21) also has its PDF beside it,
// `<name>.pdf`, which the page's pdf template names as its `source`.
//
// Its name is `tpl:<name>` (#54). `pdf:<name>`, the name #21 gave PDF templates, is read as an
// alias of the same file, so notes' `template:` frontmatter and settings written before keep
// working; new references are written as `tpl:`. A note's `template:` frontmatter may hold one,
// and the chooser and the new-note dialog list them after the built-ins (favourites first).
// `parseTemplateName` knows only built-ins; the store resolves custom names through the
// resolver this registry provides (`StoreOptions.resolveTemplate`), and names a pdf or image
// template back through `nameTemplate`: one whose source, page and image (pdf) or image (image)
// match a registered one is `tpl:<name>`; others (an imported PDF's pages) keep the fixed name
// `pdf` or `image`. Other kinds are named by the chooser, which knows which entry was chosen.
//
// A page made from a custom template gets a copy of its template (for a pdf, source, page and
// image) and its size. `source` is relative to the page folder, so a PDF template's PDF is
// copied into the note's page folder on first use (`templateUsed`), which the sharp render
// (#14) then finds unchanged.
//
// The folder is scanned lazily (only `.svg` files directly in it that read as ink pages without
// strokes) and cached until a vault event touches the folder or the setting changes. The
// registry also saves, renames and deletes templates (#54); pages made from a template keep
// their copy, so renaming or deleting one leaves every page as it is.
// No runtime import of `obsidian`, so the unit tests can drive it with a fake vault.
import type { App, Component, TAbstractFile, TFile } from 'obsidian';
import { newPageId } from '../format/ids';
import { newPage, readPage, writePage, type Size } from '../format/page';
import { parseTemplate, type Template } from '../format/template';
import type { TemplatePrefs } from './favourites';
import { cleanName, uniqueName } from './names';
import type { StoreOptions } from './store';

/** A folder setting as a vault path: `/`-separated, no leading, trailing or doubled slashes ('' is the root). */
export const cleanFolder = (f: string) => f.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');

/** A folder's vault path joined with a relative path. */
const join = (folder: string, rel: string) => (folder ? `${folder}/${rel}` : rel);

/** The prefix of a custom template's name (#54). */
export const TPL_PREFIX = 'tpl:';
/** The prefix #21 gave PDF templates, read as an alias of `tpl:`. */
export const PDF_PREFIX = 'pdf:';

/** Whether a template name is a custom template's (`tpl:<name>`, or the older `pdf:<name>`). */
export const isCustomName = (name: string): boolean => /^(?:tpl|pdf):./.test(name);

/** A template name as written from now on: `pdf:<name>` becomes `tpl:<name>`; others unchanged. */
export const canonicalName = (name: string): string => (name.startsWith(PDF_PREFIX) ? TPL_PREFIX + name.slice(PDF_PREFIX.length) : name);

export interface TemplateEntry {
  /** `tpl:<name>`. */
  name: string;
  /** For menus: the file's basename. */
  label: string;
  /** Vault path of the template's page file. */
  path: string;
  template: Template;
  size: Size;
}

/** #21's name for an entry, kept for callers that only ever saw PDF templates. */
export type PdfTemplateEntry = TemplateEntry;

/** The file access saving, renaming and deleting templates needs: a subset of Obsidian's Vault. */
type VaultFile = Pick<TFile, 'path' | 'name' | 'basename' | 'extension'>;

export class TemplateRegistry {
  private cache: Promise<TemplateEntry[]> | null = null;
  private cachedFolder = '';
  private last: TemplateEntry[] = [];
  /** Copies in progress, per destination path. */
  private copies = new Map<string, Promise<void>>();
  /** Folder scans done (for tests). */
  scans = 0;
  /** The favourite templates and the default template in the settings (#54), set by the plugin. */
  prefs: TemplatePrefs | null = null;

  constructor(private app: App, private folderSetting: () => string) {}

  /** The templates folder's vault path, without a trailing slash. */
  get folder(): string {
    return cleanFolder(this.folderSetting() || '');
  }

  /** Forgets the cached list when a vault change touches the folder. */
  watch(component: Component) {
    const vault = this.app.vault;
    const touch = (file: TAbstractFile, oldPath?: string) => {
      if (this.inFolder(file.path) || (oldPath !== undefined && this.inFolder(oldPath))) this.invalidate();
    };
    component.registerEvent(vault.on('create', f => touch(f)));
    component.registerEvent(vault.on('modify', f => touch(f)));
    component.registerEvent(vault.on('delete', f => touch(f)));
    component.registerEvent(vault.on('rename', (f, old) => touch(f, old)));
  }

  private inFolder(path: string): boolean {
    const f = this.folder;
    return f === '' ? !path.includes('/') : path === f || path.startsWith(f + '/');
  }

  /** Forgets the cached list; if it had been loaded, loads it again (so `entries` stays current). */
  invalidate() {
    const had = this.cache !== null;
    this.cache = null;
    if (had) void this.load();
  }

  /** The templates in the folder, sorted by name; scanned once until something changes. */
  load(): Promise<TemplateEntry[]> {
    if (this.cache && this.cachedFolder === this.folder) return this.cache;
    this.cachedFolder = this.folder;
    const scan = this.scan().then(entries => {
      if (this.cache === scan) this.last = entries;
      return entries;
    });
    this.cache = scan;
    return scan;
  }

  /** The templates as last loaded (for synchronous callers: the store's resolver). */
  get entries(): readonly TemplateEntry[] {
    return this.last;
  }

  /** The `.svg` files directly in the folder. */
  private folderFiles(): VaultFile[] {
    const folder = this.folder;
    return this.app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'svg' &&
      (folder === '' ? !f.path.includes('/') : f.path === `${folder}/${f.name}`));
  }

  private async scan(): Promise<TemplateEntry[]> {
    this.scans++;
    const vault = this.app.vault;
    const out: TemplateEntry[] = [];
    for (const f of this.folderFiles()) {
      try {
        const page = readPage(await vault.cachedRead(f as TFile));
        // A page with writing on it is a page, not a template.
        if (page.strokes.length) continue;
        out.push({ name: TPL_PREFIX + f.basename, label: f.basename, path: f.path, template: page.template, size: page.size });
      } catch (e) {
        // Not an ink page: not a template.
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** The entry with this `tpl:<name>` (or `pdf:<name>`), from the last load. */
  get(name: string): TemplateEntry | null {
    const n = canonicalName(name);
    return this.last.find(e => e.name === n) ?? null;
  }

  /** A custom name's template (a fresh copy) and size, from the last load, or null. */
  resolve(name: string): { template: Template; size: Size } | null {
    const e = this.get(name);
    return e ? { template: parseTemplate(e.template), size: { ...e.size } } : null;
  }

  /**
   * The registered template this pdf or image template was made from (pdf: same source, page
   * and image; image: same image), or null. Other kinds aren't told apart by their template
   * alone (a custom fill may be a built-in's colour at another size): null.
   */
  entryOf(template: Template): TemplateEntry | null {
    if (template.kind === 'pdf') {
      return this.last.find(e => e.template.kind === 'pdf' && e.template.source === template.source &&
        e.template.page === template.page && e.template.image === template.image) ?? null;
    }
    if (template.kind === 'image' && template.image) {
      return this.last.find(e => e.template.kind === 'image' && e.template.image.length === template.image.length &&
        e.template.image === template.image) ?? null;
    }
    return null;
  }

  /** `tpl:<name>` for a pdf or image template made from a registered one, or null. */
  nameOf(template: Template): string | null {
    return this.entryOf(template)?.name ?? null;
  }

  /**
   * Copies a PDF template's PDF into a page folder (vault path) if it isn't there yet. Does
   * nothing for other templates. Never rejects (a failure is logged; the page keeps its JPEG).
   */
  ensureCopied(template: Template, pageFolder: string): Promise<void> {
    const entry = this.entryOf(template);
    if (!entry || template.kind !== 'pdf' || entry.template.kind !== 'pdf') return Promise.resolve();
    const vault = this.app.vault;
    const dest = join(cleanFolder(pageFolder), template.source);
    const from = join(dirOf(entry.path), entry.template.source);
    if (dest === from) return Promise.resolve();
    const pending = this.copies.get(dest);
    if (pending) return pending;
    const run = (async () => {
      if (vault.getAbstractFileByPath(dest)) return;
      const src = vault.getFileByPath(from);
      if (!src) throw new Error(`${from} not found`);
      const bytes = await vault.readBinary(src);
      const dir = dirOf(dest);
      if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
      if (!vault.getAbstractFileByPath(dest)) await vault.createBinary(dest, bytes);
    })().catch(e => console.warn('[notebook] could not copy the PDF template into', dest, e))
      .finally(() => this.copies.delete(dest));
    this.copies.set(dest, run);
    return run;
  }

  /** The store options that let a note use these templates. */
  storeOptions(): Pick<StoreOptions, 'resolveTemplate' | 'nameTemplate' | 'templateUsed'> {
    return {
      resolveTemplate: name => this.resolve(name),
      nameTemplate: t => this.nameOf(t),
      templateUsed: (t, folder) => void this.ensureCopied(t, folder),
    };
  }

  // ---- saving, renaming and deleting (#54)

  /** Whether `<base>.svg` or `<base>.pdf` is taken in the folder. */
  private taken(base: string): boolean {
    const vault = this.app.vault, f = this.folder;
    return !!vault.getAbstractFileByPath(join(f, `${base}.svg`)) || !!vault.getAbstractFileByPath(join(f, `${base}.pdf`));
  }

  /** Creates the folder and its parents if missing. */
  private async ensureFolder() {
    const vault = this.app.vault;
    let acc = '';
    for (const part of this.folder.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part;
      if (vault.getAbstractFileByPath(acc)) continue;
      await vault.createFolder(acc);
    }
  }

  /**
   * Saves a template as `<folder>/<name>.svg`, an ink page with no strokes of this template and
   * size (the name cleaned, and made unique if taken); returns its `tpl:<name>` once the
   * registry lists it. A pdf template needs `pdf`, the PDF's bytes: they're written beside it
   * as `<name>.pdf`, which becomes its source. Throws if a file can't be written.
   */
  async save(name: string, template: Template, size: Size, pdf?: ArrayBuffer): Promise<string> {
    const t = parseTemplate(template);
    if (t.kind === 'pdf' && !pdf) throw new Error('A PDF template needs its PDF');
    const base = uniqueName(cleanName(name), n => this.taken(n));
    await this.ensureFolder();
    const vault = this.app.vault;
    if (t.kind === 'pdf') {
      await vault.createBinary(join(this.folder, `${base}.pdf`), pdf!.slice(0));
      t.source = `${base}.pdf`;
    }
    const page = newPage(newPageId([]), { width: size.width, height: size.height }, t);
    await vault.create(join(this.folder, `${base}.svg`), writePage(page));
    this.invalidate();
    await this.load();
    return TPL_PREFIX + base;
  }

  /** The PDF a pdf entry names, if it's in the templates folder and no other entry uses it. */
  private ownPdf(entry: TemplateEntry): string | null {
    if (entry.template.kind !== 'pdf') return null;
    const path = join(dirOf(entry.path), entry.template.source);
    const shared = this.last.some(e => e !== entry && e.template.kind === 'pdf' && join(dirOf(e.path), e.template.source) === path);
    return shared || dirOf(path) !== dirOf(entry.path) ? null : path;
  }

  /**
   * Renames a custom template (and its own PDF, whose name its page then refers to); returns
   * the new `tpl:<name>` (made unique if taken), or null if there's no such template. Pages
   * made from it keep their copy.
   */
  async rename(name: string, to: string): Promise<string | null> {
    await this.load();
    const entry = this.get(name);
    if (!entry) return null;
    const vault = this.app.vault;
    const clean = cleanName(to);
    if (clean === entry.label) return entry.name;
    const base = uniqueName(clean, n => n !== entry.label && this.taken(n));
    const svg = vault.getFileByPath(entry.path);
    if (!svg) return null;
    const pdfPath = this.ownPdf(entry);
    const pdf = pdfPath ? vault.getFileByPath(pdfPath) : null;
    const newSvg = join(this.folder, `${base}.svg`);
    if (pdf) {
      await vault.rename(pdf, join(this.folder, `${base}.pdf`));
      const page = readPage(await vault.read(svg));
      if (page.template.kind === 'pdf') page.template = { ...page.template, source: `${base}.pdf` };
      await vault.modify(svg, writePage(page));
    }
    await vault.rename(svg, newSvg);
    this.invalidate();
    await this.load();
    return TPL_PREFIX + base;
  }

  /**
   * Deletes a custom template's page file (and its own PDF); returns false if there's no such
   * template. Pages made from it keep their copy.
   */
  async delete(name: string): Promise<boolean> {
    await this.load();
    const entry = this.get(name);
    if (!entry) return false;
    const vault = this.app.vault;
    // To the trash the user chose in Obsidian's settings, where there's a file manager (not in the tests).
    const remove = (f: TFile) => (this.app.fileManager?.trashFile ? this.app.fileManager.trashFile(f) : vault.delete(f));
    const pdfPath = this.ownPdf(entry);
    const svg = vault.getFileByPath(entry.path);
    if (svg) await remove(svg);
    const pdf = pdfPath ? vault.getFileByPath(pdfPath) : null;
    if (pdf) await remove(pdf);
    this.invalidate();
    await this.load();
    return true;
  }
}

/** The folder part of a vault path ('' at the root). */
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Registries of loaded plugin instances, newest last (one in Obsidian; the tests load several). */
const registries: TemplateRegistry[] = [];

/**
 * Makes this the plugin's registry, which the ink view and the dialogs use; returns the function
 * that removes it again (plugin unload), leaving an older instance's in place.
 */
export function setTemplateRegistry(registry: TemplateRegistry): () => void {
  registries.push(registry);
  return () => {
    const i = registries.lastIndexOf(registry);
    if (i >= 0) registries.splice(i, 1);
  };
}

export function templateRegistry(): TemplateRegistry | null {
  return registries[registries.length - 1] ?? null;
}

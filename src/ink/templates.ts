// PDF templates (#21): a vault-aware registry of the templates in the templates folder
// (settings, default `templates/ink`). A PDF template is two files there: `<name>.pdf`, the PDF,
// and `<name>.svg`, an ordinary ink page with no strokes whose pdf template is one page of it
// (`source: '<name>.pdf'`, the page, the embedded JPEG) at that page's size.
//
// Its name is `pdf:<name>`: a note's `template:` frontmatter may hold one, and the chooser and
// the new-note dialog list them after the built-ins. `parseTemplateName` knows only built-ins;
// the store resolves `pdf:` names through the resolver this registry provides
// (`StoreOptions.resolveTemplate`), and names a pdf template back through `nameTemplate`: a pdf
// template whose source, page and image match a registered one is `pdf:<name>`; other pdf
// templates (an imported PDF's pages) keep the fixed name `pdf`.
//
// A page made from a PDF template gets a copy of its template (source, page and image) and its
// size. `source` is relative to the page folder, so the PDF is copied into the note's page
// folder on first use (`templateUsed`), which the sharp render (#14) then finds unchanged.
//
// The folder is scanned lazily (only `.svg` files directly in it that read as ink pages with a
// pdf template) and cached until a vault event touches the folder or the setting changes.
// No runtime import of `obsidian`, so the unit tests can drive it with a fake vault.
import type { App, Component, TAbstractFile } from 'obsidian';
import { readPage, type Size } from '../format/page';
import { parseTemplate, type PdfTemplate, type Template } from '../format/template';
import type { StoreOptions } from './store';

/** A folder setting as a vault path: `/`-separated, no leading, trailing or doubled slashes ('' is the root). */
export const cleanFolder = (f: string) => f.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');

/** A folder's vault path joined with a relative path. */
const join = (folder: string, rel: string) => (folder ? `${folder}/${rel}` : rel);

/** The prefix of a PDF template's name. */
export const PDF_PREFIX = 'pdf:';

export interface PdfTemplateEntry {
  /** `pdf:<name>`. */
  name: string;
  /** For menus: the file's basename. */
  label: string;
  /** Vault path of the template's page file. */
  path: string;
  template: PdfTemplate;
  size: Size;
}

export class TemplateRegistry {
  private cache: Promise<PdfTemplateEntry[]> | null = null;
  private cachedFolder = '';
  private last: PdfTemplateEntry[] = [];
  /** Copies in progress, per destination path. */
  private copies = new Map<string, Promise<void>>();
  /** Folder scans done (for tests). */
  scans = 0;

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

  /** The PDF templates in the folder, sorted by name; scanned once until something changes. */
  load(): Promise<PdfTemplateEntry[]> {
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
  get entries(): readonly PdfTemplateEntry[] {
    return this.last;
  }

  private async scan(): Promise<PdfTemplateEntry[]> {
    this.scans++;
    const vault = this.app.vault;
    const folder = this.folder;
    const files = vault.getFiles().filter(f => f.extension.toLowerCase() === 'svg' &&
      (folder === '' ? !f.path.includes('/') : f.path === `${folder}/${f.name}`));
    const out: PdfTemplateEntry[] = [];
    for (const f of files) {
      try {
        const page = readPage(await vault.cachedRead(f));
        if (page.template.kind !== 'pdf') continue;
        out.push({ name: PDF_PREFIX + f.basename, label: f.basename, path: f.path, template: page.template, size: page.size });
      } catch (e) {
        // Not an ink page: not a template.
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** The entry with this `pdf:<name>`, from the last load. */
  get(name: string): PdfTemplateEntry | null {
    return this.last.find(e => e.name === name) ?? null;
  }

  /** A `pdf:<name>`'s template (a fresh copy) and size, from the last load, or null. */
  resolve(name: string): { template: Template; size: Size } | null {
    const e = this.get(name);
    return e ? { template: parseTemplate(e.template), size: { ...e.size } } : null;
  }

  /** The registered template this pdf template was made from, or null. */
  entryOf(template: Template): PdfTemplateEntry | null {
    if (template.kind !== 'pdf') return null;
    return this.last.find(e => e.template.source === template.source && e.template.page === template.page &&
      e.template.image === template.image) ?? null;
  }

  /** `pdf:<name>` for a template made from a registered one, or null. */
  nameOf(template: Template): string | null {
    return this.entryOf(template)?.name ?? null;
  }

  /**
   * Copies a PDF template's PDF into a page folder (vault path) if it isn't there yet. Does
   * nothing for other templates. Never rejects (a failure is logged; the page keeps its JPEG).
   */
  ensureCopied(template: Template, pageFolder: string): Promise<void> {
    const entry = this.entryOf(template);
    if (!entry || template.kind !== 'pdf') return Promise.resolve();
    const vault = this.app.vault;
    const dest = join(cleanFolder(pageFolder), template.source);
    const from = join(entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/'))), entry.template.source);
    if (dest === from) return Promise.resolve();
    const pending = this.copies.get(dest);
    if (pending) return pending;
    const run = (async () => {
      if (vault.getAbstractFileByPath(dest)) return;
      const src = vault.getFileByPath(from);
      if (!src) throw new Error(`${from} not found`);
      const bytes = await vault.readBinary(src);
      const dir = dest.slice(0, Math.max(0, dest.lastIndexOf('/')));
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
}

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

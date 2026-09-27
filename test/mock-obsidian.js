// A mock of the parts of the Obsidian API the plugin uses, for test/harness.html. Files live in
// the in-memory `fs` map (path -> string | Uint8Array) and folders in `dirs`; the vault API and
// vault.adapter share them. Only one leaf is shown at a time, in #leaf.
(() => {
  // ---- Obsidian's DOM helpers
  const P = HTMLElement.prototype;
  P.empty = function () { this.innerHTML = ''; };
  P.addClass = function (...c) { this.classList.add(...c); };
  P.removeClass = function (...c) { this.classList.remove(...c); };
  P.toggleClass = function (c, on) { this.classList.toggle(c, on); };
  P.hasClass = function (c) { return this.classList.contains(c); };
  P.setText = function (t) { this.textContent = t; };
  P.hide = function () { this.style.display = 'none'; };
  P.show = function () { this.style.display = ''; };
  P.createEl = function (tag, o = {}) {
    const el = document.createElement(tag);
    if (typeof o === 'string') o = { cls: o };
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
    if (o.text) el.textContent = o.text;
    if (o.type) el.type = o.type;
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  P.createDiv = function (o = {}) { return this.createEl('div', o); };
  P.createSpan = function (o = {}) { return this.createEl('span', o); };
  window.createDiv = o => document.createElement('div').createDiv(o);

  window.notices = [];
  class Notice { constructor(m) { notices.push(m); } hide() {} }

  // ---- files
  window.fs = new Map();
  window.dirs = new Set();
  const adapter = {
    async exists(p) { return fs.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async write(p, d) { fs.set(p, String(d)); },
    async read(p) { if (!fs.has(p)) throw new Error('ENOENT ' + p); return fs.get(p); },
    async append(p, d) { if (!fs.has(p)) throw new Error('append to missing ' + p); fs.set(p, fs.get(p) + d); },
    async writeBinary(p, b) { fs.set(p, new Uint8Array(b.slice(0))); },
    async appendBinary(p, b) { const old = fs.get(p); const n = new Uint8Array(old.length + b.byteLength); n.set(old); n.set(new Uint8Array(b), old.length); fs.set(p, n); },
    async readBinary(p) { return fs.get(p).slice().buffer; },
    async list(p) {
      const kids = q => q.startsWith(p + '/') && !q.slice(p.length + 1).includes('/');
      return { files: [...fs.keys()].filter(kids), folders: [...dirs].filter(kids) };
    },
    async remove(p) { fs.delete(p); },
    async rmdir(p, rec) { for (const k of [...fs.keys()]) if (k.startsWith(p + '/')) fs.delete(k); for (const k of [...dirs]) if (k === p || k.startsWith(p + '/')) dirs.delete(k); },
  };
  window.adapter = adapter;

  class Events {
    constructor() { this._handlers = {}; }
    on(name, cb, ctx) { (this._handlers[name] ??= []).push(cb); return { e: this, name, cb }; }
    offref(ref) { const l = this._handlers[ref.name] || []; const i = l.indexOf(ref.cb); if (i >= 0) l.splice(i, 1); }
    trigger(name, ...args) { for (const cb of [...(this._handlers[name] || [])]) cb(...args); }
  }

  const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const basename = p => p.slice(p.lastIndexOf('/') + 1);

  class TAbstractFile {
    constructor(path) { this.path = path; this.name = basename(path); }
    get parent() { return this.path === '/' ? null : vault.getFolder(dirname(this.path)); }
  }
  class TFile extends TAbstractFile {
    get basename() { return this.name.includes('.') ? this.name.slice(0, this.name.lastIndexOf('.')) : this.name; }
    get extension() { return this.name.includes('.') ? this.name.slice(this.name.lastIndexOf('.') + 1) : ''; }
    get stat() { const d = fs.get(this.path); return { size: d ? d.length : 0, mtime: 0, ctime: 0 }; }
  }
  class TFolder extends TAbstractFile {
    isRoot() { return this.path === '/'; }
    get children() {
      const prefix = this.isRoot() ? '' : this.path + '/';
      const kids = q => q.startsWith(prefix) && q.length > prefix.length && !q.slice(prefix.length).includes('/');
      return [...[...dirs].filter(kids).map(p => vault.getFolder(p)), ...[...fs.keys()].filter(kids).map(p => vault.getFile(p))];
    }
  }

  const fileObjects = new Map();
  const vault = new Events();
  Object.assign(vault, {
    adapter,
    getFile(p) { let f = fileObjects.get(p); if (!(f instanceof TFile)) { f = new TFile(p); fileObjects.set(p, f); } return f; },
    getFolder(p) { if (p === '' || p === '/') p = '/'; let f = fileObjects.get('dir:' + p); if (!f) { f = new TFolder(p); fileObjects.set('dir:' + p, f); } return f; },
    getRoot() { return this.getFolder('/'); },
    getAbstractFileByPath(p) { if (fs.has(p)) return this.getFile(p); if (dirs.has(p) || p === '/' || p === '') return this.getFolder(p); return null; },
    getFileByPath(p) { return fs.has(p) ? this.getFile(p) : null; },
    getFolderByPath(p) { return dirs.has(p) ? this.getFolder(p) : null; },
    async read(file) { if (!fs.has(file.path)) throw new Error('ENOENT ' + file.path); return fs.get(file.path); },
    async cachedRead(file) { return this.read(file); },
    async modify(file, text) {
      if (!fs.has(file.path)) throw new Error('modify: no file ' + file.path);
      vault.writes.push(file.path);
      fs.set(file.path, text);
      this.trigger('modify', file);
    },
    async create(path, text) {
      if (fs.has(path) || dirs.has(path)) throw new Error('File already exists.');
      const dir = dirname(path);
      if (dir && !dirs.has(dir)) throw new Error('create: no folder ' + dir);
      vault.writes.push(path);
      fs.set(path, text);
      const f = this.getFile(path);
      this.trigger('create', f);
      return f;
    },
    async createFolder(path) {
      if (fs.has(path) || dirs.has(path)) throw new Error('Folder already exists.');
      const dir = dirname(path);
      if (dir && !dirs.has(dir)) throw new Error('createFolder: no parent ' + dir);
      dirs.add(path);
      const f = this.getFolder(path);
      this.trigger('create', f);
      return f;
    },
    async delete(file) { fs.delete(file.path); this.trigger('delete', file); },
    /** Paths written through modify/create, in order (for tests). */
    writes: [],
  });
  /** Tests: change a file as a sync would, with the vault's modify event. */
  window.externalWrite = (path, text) => {
    const existed = fs.has(path);
    fs.set(path, text);
    vault.trigger(existed ? 'modify' : 'create', vault.getFile(path));
  };

  // Frontmatter as Obsidian's metadata cache would see it; window.coldCache = true simulates a
  // file the cache hasn't read yet.
  const metadataCache = new Events();
  metadataCache.getFileCache = file => {
    if (window.coldCache) return null;
    const text = fs.get(file.path);
    if (typeof text !== 'string') return null;
    const lines = text.split(/\r?\n/);
    if (!/^---\s*$/.test(lines[0])) return {};
    const frontmatter = {};
    for (let i = 1; i < lines.length && !/^---\s*$/.test(lines[i]); i++) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (m) frontmatter[m[1]] = m[2];
    }
    return { frontmatter };
  };

  // ---- components and views
  class Component {
    constructor() { this._cleanups = []; this._children = []; }
    load() { this.onload?.(); }
    unload() { for (const c of this._children) c.unload(); for (const f of this._cleanups.splice(0)) f(); this.onunload?.(); }
    register(cb) { this._cleanups.push(cb); }
    registerEvent(ref) { this._cleanups.push(() => ref.e.offref(ref)); }
    registerDomEvent(el, type, cb, opts) { el.addEventListener(type, cb, opts); this._cleanups.push(() => el.removeEventListener(type, cb, opts)); }
    registerInterval(id) { this._cleanups.push(() => clearInterval(id)); return id; }
    addChild(c) { this._children.push(c); c.load(); return c; }
  }
  class View extends Component {
    constructor(leaf) {
      super();
      this.leaf = leaf;
      this.app = leaf.app;
      this.navigation = false;
      this.containerEl = document.createElement('div');
      this.containerEl.className = 'workspace-leaf-content';
      this.headerEl = this.containerEl.createDiv({ cls: 'view-header' });
      this.actionsEl = this.headerEl.createDiv({ cls: 'view-actions' });
      this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
    }
    getState() { return {}; }
    async setState(state, result) {}
    getIcon() { return ''; }
    addAction(icon, title, cb) {
      const b = this.actionsEl.createEl('button', { cls: 'view-action', attr: { 'aria-label': title, 'data-icon': icon } });
      b.textContent = title;
      b.addEventListener('click', cb);
      return b;
    }
    async open() { this.load(); await this.onOpen?.(); }
    async close() { await this.onClose?.(); this.unload(); }
    async onOpen() {}
    async onClose() {}
  }
  class ItemView extends View {}
  class FileView extends ItemView {
    constructor(leaf) { super(leaf); this.file = null; this.allowNoFile = false; this.navigation = true; }
    getDisplayText() { return this.file ? this.file.basename : 'No file'; }
    getState() { return this.file ? { file: this.file.path } : {}; }
    async setState(state, result) {
      if (state && typeof state.file === 'string') {
        const f = vault.getAbstractFileByPath(state.file);
        if (f instanceof TFile) await this.loadFile(f);
      }
    }
    async loadFile(file) {
      if (this.file === file) return;
      if (this.file) await this.onUnloadFile(this.file);
      this.file = file;
      await this.onLoadFile(file);
    }
    async close() {
      await this.onClose?.();
      if (this.file) { const f = this.file; this.file = null; await this.onUnloadFile(f); }
      this.unload();
    }
    async onLoadFile(file) {}
    async onUnloadFile(file) {}
    async onRename(file) {}
    canAcceptExtension(ext) { return false; }
  }
  // The markdown view shows the file's text in a <pre>.
  class MarkdownView extends FileView {
    getViewType() { return 'markdown'; }
    getState() { return { ...super.getState(), mode: 'source' }; }
    async onLoadFile(file) { this.contentEl.empty(); this.contentEl.createEl('pre', { cls: 'mock-markdown', text: await vault.read(file) }); }
  }

  const viewTypes = { markdown: leaf => new MarkdownView(leaf) };
  const host = () => document.getElementById('leaf');
  let leafIds = 0;

  class WorkspaceLeaf extends Events {
    constructor(app) {
      super();
      this.app = app;
      this.id = 'leaf' + (++leafIds);
      this.view = null;
      this.containerEl = document.createElement('div');
      this.containerEl.className = 'workspace-leaf';
      this.containerEl.style.cssText = 'height:100%;display:flex;flex-direction:column';
    }
    async setViewState(state, eState) {
      const ws = this.app.workspace;
      if (!ws.leaves.includes(this)) ws.leaves.push(this);
      const type = state.type;
      if (this.view && this.view.getViewType() === type) {
        await this.view.setState(state.state || {}, {});
      } else {
        if (this.view) await this.view.close();
        this.containerEl.innerHTML = '';
        const make = viewTypes[type];
        if (!make) throw new Error('mock: no view type ' + type);
        const v = make(this);
        this.view = v;
        v.containerEl.style.cssText = 'height:100%;display:flex;flex-direction:column';
        v.contentEl.style.cssText = 'flex:1;min-height:0';
        this.containerEl.appendChild(v.containerEl);
        ws.show(this);
        await v.open();
        await v.setState(state.state || {}, {});
      }
      ws.setActiveLeaf(this);
      window.view = this.view;
    }
    getViewState() { return { type: this.view ? this.view.getViewType() : 'empty', state: this.view ? this.view.getState() : {} }; }
    async openFile(file, openState) {
      const type = file.extension === 'md' ? 'markdown' : file.extension;
      await this.setViewState({ type, state: { file: file.path }, active: true, ...(openState || {}) });
    }
    async detach() {
      const ws = this.app.workspace;
      if (this.view) await this.view.close();
      this.view = null;
      this.containerEl.remove();
      ws.leaves = ws.leaves.filter(l => l !== this);
      if (ws.activeLeaf === this) ws.activeLeaf = null;
      const next = ws.leaves[ws.leaves.length - 1];
      if (next) { ws.show(next); ws.setActiveLeaf(next); }
    }
    getDisplayText() { return this.view ? this.view.getDisplayText() : ''; }
  }

  class Workspace extends Events {
    constructor(app) { super(); this.app = app; this.leaves = []; this.activeLeaf = null; }
    onLayoutReady(cb) { cb(); }
    getLeavesOfType(type) { return this.leaves.filter(l => l.view && l.view.getViewType() === type); }
    getLeaf(newLeaf) {
      if (!newLeaf && this.activeLeaf) return this.activeLeaf;
      const leaf = new WorkspaceLeaf(this.app);
      this.leaves.push(leaf);
      return leaf;
    }
    show(leaf) { const h = host(); if (leaf.containerEl.parentElement !== h) { h.innerHTML = ''; h.appendChild(leaf.containerEl); } }
    revealLeaf(leaf) { this.show(leaf); this.setActiveLeaf(leaf); }
    setActiveLeaf(leaf) { if (this.activeLeaf !== leaf) { this.activeLeaf = leaf; this.trigger('active-leaf-change', leaf); } }
    getActiveFile() { const v = this.activeLeaf && this.activeLeaf.view; return v && v.file ? v.file : null; }
    getActiveViewOfType(cls) { const v = this.activeLeaf && this.activeLeaf.view; return v instanceof cls ? v : null; }
    getMostRecentLeaf() { return this.activeLeaf; }
  }

  const app = { vault, metadataCache };
  app.workspace = new Workspace(app);
  window.app = app;

  // ---- menus, modals, settings
  class Menu {
    constructor() { this.items = []; }
    addItem(cb) { const item = { title: '', icon: '', click: null, setTitle(t) { this.title = t; return this; }, setIcon(i) { this.icon = i; return this; }, onClick(f) { this.click = f; return this; } }; cb(item); this.items.push(item); return this; }
    addSeparator() { return this; }
  }
  window.modals = [];
  class Modal {
    constructor(app) { this.app = app; this.modalEl = document.createElement('div'); this.modalEl.className = 'modal'; this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' }); this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' }); }
    open() { document.body.appendChild(this.modalEl); modals.push(this); this.onOpen?.(); }
    close() { this.onClose?.(); this.modalEl.remove(); const i = modals.indexOf(this); if (i >= 0) modals.splice(i, 1); }
  }
  // Lists every item as a .suggestion-item (no filtering); clicking one closes the modal and
  // chooses it, as selecting a suggestion does in Obsidian.
  class FuzzySuggestModal extends Modal {
    constructor(app) { super(app); this.placeholder = ''; }
    setPlaceholder(p) { this.placeholder = p; }
    onOpen() {
      for (const item of this.getItems()) {
        const el = this.contentEl.createDiv({ cls: 'suggestion-item', text: this.getItemText(item) });
        el.addEventListener('click', evt => { this.close(); this.onChooseItem(item, evt); });
      }
    }
    onClose() { this.contentEl.empty(); }
  }
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); } }
  class Setting {
    constructor(el) { this.settingEl = el.createDiv({ cls: 'setting-item' }); }
    setName(n) { this.settingEl.dataset.name = n; this.settingEl.createDiv({ cls: 'setting-item-name', text: n }); return this; }
    setDesc(d) { this.settingEl.createDiv({ cls: 'setting-item-description', text: d }); return this; }
    addDropdown(cb) {
      const sel = this.settingEl.createEl('select');
      const d = { selectEl: sel, addOption(v, t) { const o = sel.createEl('option', { text: t }); o.value = v; return d; }, setValue(v) { sel.value = v; return d; }, getValue() { return sel.value; }, onChange(f) { sel.addEventListener('change', () => f(sel.value)); return d; } };
      cb(d);
      return this;
    }
  }

  // ---- plugin
  const commands = {};
  window.commands = commands;
  window.pluginData = null;
  class Plugin extends Component {
    constructor() { super(); this.app = app; this.settingTabs = []; this.ribbon = []; }
    registerView(t, f) { viewTypes[t] = f; }
    addRibbonIcon(icon, title, cb) { const el = document.createElement('div'); el.setAttribute('aria-label', title); el.addEventListener('click', cb); this.ribbon.push({ icon, title, el }); return el; }
    addCommand(c) { commands[c.id] = c; return c; }
    addSettingTab(t) { this.settingTabs.push(t); }
    async loadData() { return window.pluginData; }
    async saveData(d) { window.pluginData = JSON.parse(JSON.stringify(d)); }
  }

  const normalizePath = p => {
    p = p.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
    return p === '' ? '/' : p;
  };
  const setIcon = (el, name) => el.setAttribute('data-icon', name);
  const Platform = { isMobile: false, isMobileApp: false, isIosApp: false, isDesktop: true, isDesktopApp: true };

  window.obsidian = {
    Plugin, Component, View, ItemView, FileView, MarkdownView, Notice, Events, TAbstractFile, TFile, TFolder,
    WorkspaceLeaf, Menu, Modal, FuzzySuggestModal, PluginSettingTab, Setting, Platform, normalizePath, setIcon,
  };

  window.loadPlugin = async () => {
    const code = await (await fetch('../main.js?' + Date.now())).text();
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, m => { if (m !== 'obsidian') throw new Error(m); return window.obsidian; });
    // esbuild's cjs output puts `export default` on module.exports.default, as Obsidian expects.
    const P = module.exports.default ?? module.exports;
    const p = new P();
    await p.onload();
    return p;
  };
})();

// Figure ink (S13): the `fig:` key from an item and a file name (plain, spaced, URL-encoded), no
// surface when the statement has no image or the image fails to load, the surface's height from
// the image's natural size, the wrap under the canvas, the duplicate-name suffix and the cleanup.
// Runs under node:test on a minimal fake DOM (document.createElement is stubbed below).
import test from 'node:test';
import assert from 'node:assert/strict';
import { figureHeight, figureKey, figureName, figureSurface, mountFigureInk } from '../../src/study/blocks/figure-ink';
import type { BlockEnv, InkSurface, InkSurfaceOptions } from '../../src/study/view/host';
import type { StudyDoc } from '../../src/study/types';

type Listener = (e: unknown) => void;

/** A minimal element: children, inline style, class, attributes, load/error listeners. */
class El {
  tag: string;
  children: El[] = [];
  parentNode: El | null = null;
  style: Record<string, string> = {};
  className = '';
  private attrs = new Map<string, string>();
  private ls = new Map<string, Listener[]>();
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(c: El): El {
    c.remove();
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  prepend(c: El): void {
    c.remove();
    this.children.unshift(c);
    c.parentNode = this;
  }
  insertBefore(c: El, ref: El | null): El {
    c.remove();
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: El): El {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  addEventListener(t: string, fn: Listener): void {
    const a = this.ls.get(t) || [];
    a.push(fn);
    this.ls.set(t, a);
  }
  removeEventListener(t: string, fn: Listener): void {
    const a = this.ls.get(t) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  fire(t: string): void {
    for (const fn of (this.ls.get(t) || []).slice()) fn({ type: t });
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (e: El): void => {
      for (const c of e.children) {
        if (sel === 'img' ? c.tag === 'img' : c.className.split(/\s+/).indexOf(sel.replace(/^\./, '')) >= 0) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  closest(sel: string): El | null {
    const want = sel.replace(/^\./, '');
    let e: El | null = this;
    while (e) {
      if (e.className.split(/\s+/).indexOf(want) >= 0) return e;
      e = e.parentNode;
    }
    return null;
  }
}

class Img extends El {
  naturalWidth = 0;
  naturalHeight = 0;
  complete = false;
  constructor(src = '') {
    super('img');
    this.setAttribute('src', src);
  }
  get src(): string {
    return this.getAttribute('src') || '';
  }
}

(globalThis as unknown as Record<string, unknown>).document = { createElement: (t: string) => new El(t) };

const DOC = { id: 'fx-fig' } as unknown as StudyDoc;

interface MountCall {
  container: El;
  key: string;
  opts: InkSurfaceOptions | undefined;
}

/** A fake BlockEnv whose ink.surface records the call, appends el like the real one, returns a stub. */
function fakeEnv(): { env: BlockEnv; calls: MountCall[]; surfaces: { el: El; destroyed: number }[]; relayouts: () => number } {
  const calls: MountCall[] = [];
  const surfaces: { el: El; destroyed: number }[] = [];
  let relayouts = 0;
  const env = {
    doc: DOC,
    ink: {
      surface: (_doc: StudyDoc, container: HTMLElement, key: string, opts?: InkSurfaceOptions): InkSurface => {
        calls.push({ container: container as unknown as El, key, opts });
        const s = {
          el: new El('div') as unknown as HTMLElement,
          destroyed: 0,
          strokes: () => [],
          count: () => 0,
          onChange: () => () => {},
          setReadOnly: () => {},
          undo: () => null,
          clear: () => {},
          layout: () => {},
          destroy: () => {
            s.destroyed++;
            s.el.remove();
          },
        } as unknown as InkSurface & { destroyed: number };
        surfaces.push(s as unknown as { el: El; destroyed: number });
        container.appendChild(s.el);
        return s;
      },
    },
    relayout: () => {
      relayouts++;
    },
  };
  return { env: env as unknown as BlockEnv, calls, surfaces, relayouts: () => relayouts };
}

const asImg = (e: El) => e as unknown as HTMLImageElement;

test('figure-ink: the key from an item and a file name, spaces and URL-encoded names alike', () => {
  assert.equal(figureName('figs/circuit.svg'), 'circuit.svg');
  assert.equal(figureName('circuit.svg'), 'circuit.svg');
  assert.equal(figureName('figs/mesh currents.svg'), 'mesh currents.svg');
  assert.equal(figureName('figs/mesh%20currents.svg'), 'mesh currents.svg', 'encoded and plain names key alike');
  assert.equal(figureName('https://vault.local/figs/node%20map.png?v=3'), 'node map.png');
  assert.equal(figureName('app://local/study/figs/x.svg?mtime=1#frag'), 'x.svg');
  assert.equal(figureName(''), '');
  assert.equal(figureKey('inv-el-rc', 'circuit.svg'), 'fig:inv-el-rc:circuit.svg');
  assert.equal(figureKey('el-rlc/thm', 'mesh currents.svg'), 'fig:el-rlc/thm:mesh currents.svg');
});

test('figure-ink: the surface height is the image aspect ratio at 800 paper px', () => {
  assert.equal(figureHeight(400, 300), 600);
  assert.equal(figureHeight(1200, 600), 400);
  assert.equal(figureHeight(800, 800), 800);
  assert.ok(figureHeight(0, 0) >= 1, 'degenerate sizes still give a positive height');
});

test('figure-ink: a loaded image gets a surface over it, the image under the canvas', () => {
  const { env, calls, surfaces } = fakeEnv();
  const parent = new El('div');
  const img = new Img('figs/circuit.svg');
  img.complete = true;
  img.naturalWidth = 400;
  img.naturalHeight = 300;
  parent.appendChild(img);
  const s = figureSurface(asImg(img), env, 'fig:item:circuit.svg');
  assert.ok(s, 'a surface was mounted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'fig:item:circuit.svg');
  const box = calls[0].container;
  assert.equal(box.className, 'nb-study-figure');
  assert.equal(box.parentNode, parent, 'the box stands where the image stood');
  assert.equal(img.style.width, '100%', 'the image fills the box');
  assert.equal(surfaces[0].el.children[0], img, 'the image was prepended under the canvas');
  const h = calls[0].opts && calls[0].opts.height;
  assert.equal(typeof h === 'function' ? h() : h, 600, 'height from the natural size');
});

test('figure-ink: a second call on the same image returns the same surface', () => {
  const { env, calls } = fakeEnv();
  const parent = new El('div');
  const img = new Img('a.svg');
  img.complete = true;
  img.naturalWidth = 100;
  img.naturalHeight = 50;
  parent.appendChild(img);
  const s1 = figureSurface(asImg(img), env, 'fig:i:a.svg');
  const s2 = figureSurface(asImg(img), env, 'fig:i:a.svg');
  assert.equal(s1, s2);
  assert.equal(calls.length, 1, 'no double mount on a re-render');
});

test('figure-ink: no surface when the statement has no image', () => {
  const { env, calls } = fakeEnv();
  const stmt = new El('div');
  stmt.appendChild(new El('p'));
  const cleanup = mountFigureInk(stmt as unknown as HTMLElement, env, 'inv-x');
  assert.equal(calls.length, 0);
  assert.doesNotThrow(() => cleanup());
});

test('figure-ink: no surface when the image already failed to load', () => {
  const { env, calls } = fakeEnv();
  const parent = new El('div');
  const img = new Img('gone.svg');
  img.complete = true;
  img.naturalWidth = 0; // complete with no natural size: the browser already gave up
  parent.appendChild(img);
  const s = figureSurface(asImg(img), env, 'fig:i:gone.svg');
  assert.equal(s, null);
  assert.equal(calls.length, 0);
  assert.equal(img.parentNode, parent, 'nothing was added around the image');
});

test('figure-ink: an image still loading mounts on load; an error adds nothing', () => {
  const { env, calls } = fakeEnv();
  const parent = new El('div');
  const img = new Img('late.svg');
  parent.appendChild(img);
  const s = figureSurface(asImg(img), env, 'fig:i:late.svg');
  assert.equal(s, null, 'no surface yet');
  assert.equal(img.parentNode!.className, 'nb-study-figure', 'the wrap is in place while it loads');
  img.naturalWidth = 200;
  img.naturalHeight = 100;
  img.fire('load');
  assert.equal(calls.length, 1, 'mounted once the image loaded');
  assert.equal(calls[0].key, 'fig:i:late.svg');
  // A second image that errors is unwrapped and never surfaces.
  const bad = new Img('never.svg');
  parent.appendChild(bad);
  assert.equal(figureSurface(asImg(bad), env, 'fig:i:never.svg'), null);
  bad.fire('error');
  assert.equal(calls.length, 1, 'no mount on error');
  assert.equal(bad.parentNode, parent, 'the image was put back');
  assert.equal(parent.querySelectorAll('.nb-study-figure').length, 1, 'the failed box was removed');
});

test('figure-ink: mountFigureInk keys each image by its file name and cleans all of it up', () => {
  const { env, calls, surfaces } = fakeEnv();
  const stmt = new El('div');
  const a = new Img('figs/node map.svg');
  const b = new Img('figs/mesh%20currents.svg');
  const c = new Img('other/node%20map.svg'); // same file name: a new key, never shared strokes
  for (const i of [a, b, c]) {
    i.complete = true;
    i.naturalWidth = 400;
    i.naturalHeight = 200;
    stmt.appendChild(i);
  }
  const cleanup = mountFigureInk(stmt as unknown as HTMLElement, env, 'inv-el-rc');
  assert.deepEqual(calls.map(x => x.key), ['fig:inv-el-rc:node map.svg', 'fig:inv-el-rc:mesh currents.svg', 'fig:inv-el-rc:node map.svg~2']);
  assert.equal(surfaces.length, 3);
  cleanup();
  assert.deepEqual(surfaces.map(s => s.destroyed), [1, 1, 1]);
  assert.equal(stmt.querySelectorAll('.nb-study-figure').length, 0, 'the boxes are gone');
  assert.equal(stmt.children.length, 3);
  assert.ok(stmt.children.indexOf(a) === 0 && stmt.children.indexOf(b) === 1 && stmt.children.indexOf(c) === 2, 'the images are back in place');
  assert.doesNotThrow(() => cleanup(), 'the cleanup is idempotent');
});

test('figure-ink: the cleanup cancels a pending load', () => {
  const { env, calls } = fakeEnv();
  const stmt = new El('div');
  const img = new Img('slow.svg');
  stmt.appendChild(img);
  const cleanup = mountFigureInk(stmt as unknown as HTMLElement, env, 'inv-x');
  cleanup();
  img.naturalWidth = 100;
  img.naturalHeight = 100;
  img.fire('load');
  assert.equal(calls.length, 0, 'a load after cleanup mounts nothing');
});

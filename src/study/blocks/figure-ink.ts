/**
 * Ink on figures (S13, docs/study/threads/S13.md): a Pencil-writable ink surface over each image a
 * problem statement or a drill prompt renders, so Adit can label nodes, draw mesh currents or
 * circle the supernode on the schematic itself, in the doc and in the standalone problem view.
 *
 * figureSurface wraps one image in `.nb-study-figure` (inline-block, max-width 100%: exactly as
 * wide as the displayed image), sets the image to the box's width, and once it has loaded mounts
 * an env.ink.surface over it with the image under the canvas. mountFigureInk does that for every
 * image in a rendered container and returns a cleanup. Strokes file under env.doc's ink sidecar
 * keyed `fig:<itemId>:<file name>`: a renamed figure is a new version (FORMAT.md), so it starts
 * blank while the old strokes stay in the file, unshown.
 *
 * Always on: no button, no read-only. The surface carries `.nb-study-ink`, which page ink's
 * PAGE_INK_SKIP already skips, so a figure has exactly one ink layer. The surface's canvas only
 * acts on pen and mouse pointerdowns; fingers never draw and nothing prevents a touch scroll.
 * Figure ink is FIGURE_INK in both themes: the figures are drawn on white, where the theme's
 * --text-normal (light grey in the dark theme) would leave the labels nearly invisible.
 * Nothing here imports 'obsidian', so the pure parts run under node:test.
 */
import type { BlockEnv, InkSurface } from '../view/host';

/** The paper width every ink surface draws on. */
const PAPER_W = 800;

/** The colour figure strokes draw in, whatever the theme: dark on the figures' white. */
export const FIGURE_INK = '#1f1f1f';

/** The paper height a figure's surface needs: the image's aspect ratio at 800 paper px wide. */
export function figureHeight(naturalWidth: number, naturalHeight: number): number {
  const w = Math.max(1, naturalWidth || 0);
  const h = Math.max(1, naturalHeight || 0);
  return Math.max(1, (PAPER_W * h) / w);
}

/**
 * The file name a figure's src points at: the last `/` segment with query and hash stripped,
 * URL-decoded, so `my fig.png` and `my%20fig.png` name the same file. Returns '' for no src.
 */
export function figureName(src: string): string {
  const s = String(src || '').split('#')[0].split('?')[0];
  const last = s.slice(s.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last; // malformed escapes: use it as written
  }
}

/** The ink key a figure in `itemId`'s statement or prompt files its strokes under. */
export function figureKey(itemId: string, name: string): string {
  return `fig:${itemId}:${name}`;
}

interface FigureMount {
  /** The mounted surface (null while the image loads, or after it failed). */
  surface: InkSurface | null;
  /** Undoes everything: listeners off, the image put back where it was, the box and surface gone. */
  destroy(): void;
}

/** Every image figureSurface touched, so mountFigureInk's cleanup reaches late mounts too. */
const mounts = new WeakMap<HTMLImageElement, FigureMount>();

/**
 * Wraps `img` in a `.nb-study-figure` box and, once the image has loaded (`naturalWidth > 0`),
 * mounts `env.ink.surface(env.doc, box, key, {height, color})` with `height` the image's aspect
 * ratio in paper px and `color` FIGURE_INK; the image is prepended into `surface.el`, under its canvas. Returns the surface when
 * the image was already loaded, else null: the mount still happens on `load`, and on `error`
 * everything is unwrapped again — an image that never loads gains nothing.
 *
 * Calling it twice on the same image returns the first result (idempotent on re-renders).
 */
export function figureSurface(img: HTMLImageElement, env: BlockEnv, key: string): InkSurface | null {
  const had = mounts.get(img);
  if (had) return had.surface;
  const parent = img.parentNode;
  if (!parent) return null;
  if (img.complete === true && !(img.naturalWidth > 0)) return null; // already failed: add nothing

  const box = document.createElement('div');
  box.className = 'nb-study-figure';
  parent.insertBefore(box, img);
  box.appendChild(img);
  img.style.width = '100%';
  img.setAttribute('draggable', 'false'); // a held finger scrolls; the image never starts a drag

  const rec: FigureMount = { surface: null, destroy };
  mounts.set(img, rec);
  let done = false;

  function mount(): void {
    if (done || !(img.naturalWidth > 0)) return;
    done = true;
    const surface = env.ink.surface(env.doc, box, key, {
      height: () => figureHeight(img.naturalWidth, img.naturalHeight),
      color: () => FIGURE_INK,
    });
    rec.surface = surface;
    // The paper border createInkApi draws would put the surface 2 px wider than the image.
    surface.el.style.border = 'none';
    surface.el.style.borderRadius = '0';
    // The canvas is position:absolute over the whole surface element: the image sits under it.
    surface.el.prepend(img);
    try {
      env.relayout();
    } catch (e) {
      console.error('[study] figure ink relayout', e);
    }
  }

  function destroy(): void {
    done = true;
    img.removeEventListener('load', mount);
    img.removeEventListener('error', destroy);
    // Put the image back where the box stands (it may sit inside surface.el), then drop the box.
    if (box.parentNode) box.parentNode.insertBefore(img, box);
    box.remove();
    if (rec.surface) {
      rec.surface.destroy();
      rec.surface = null;
    }
  }

  img.addEventListener('load', mount);
  img.addEventListener('error', destroy);
  if (img.naturalWidth > 0) {
    mount();
    return rec.surface;
  }
  return null;
}

/**
 * Mounts figure ink on every `img` inside `container`, keyed `fig:<itemId>:<file name>`; a second
 * image resolving to the same name gets `~2`, `~3` and so on, so duplicates never share a stroke
 * set. Returns the cleanup: destroys every surface, cancels every pending load and puts the
 * images back.
 */
export function mountFigureInk(container: HTMLElement, env: BlockEnv, itemId: string): () => void {
  const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
  const used = new Map<string, number>();
  for (const img of imgs) {
    const name = figureName(img.getAttribute('src') || img.src || '');
    const n = used.get(name) || 0;
    used.set(name, n + 1);
    figureSurface(img, env, figureKey(itemId, n ? `${name}~${n + 1}` : name));
  }
  return () => {
    for (const img of imgs) {
      try {
        mounts.get(img)?.destroy();
      } catch (e) {
        console.error('[study] figure ink cleanup', e);
      }
    }
  };
}

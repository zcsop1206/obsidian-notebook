/**
 * Anchored ink for study docs and blocks (SPEC.md, Storage: Ink). Owned by S4 on
 * docs/study/BOARD.md. STUB: surfaces are inert boxes and page ink draws nothing until S4 lands.
 * S4 reuses the notebook's pen pipeline where it can (src/ink/input.ts sampling,
 * src/format/outline.ts outlines) and the demo's SR.ink (lab/study-reader/src/core.js) for anchoring.
 */
import type { StudyContext } from '../context';
import type { InkApi, InkStroke } from '../view/host';

export function createInkApi(ctx: StudyContext): InkApi {
  void ctx;
  return {
    page: () => ({ relayout: () => {}, reanchor: () => ({ moved: 0, changed: 0, orphaned: 0 }), undo: () => null, destroy: () => {} }),
    surface: (_doc, container, _key, opts) => {
      const el = container.createDiv({ cls: 'nb-study-ink-todo' });
      const h = typeof opts?.height === 'function' ? opts.height() : opts?.height ?? 320;
      el.style.height = `${h}px`;
      const strokes: InkStroke[] = [];
      return {
        el,
        strokes: () => strokes,
        count: () => strokes.length,
        onChange: () => () => {},
        setReadOnly: () => {},
        undo: () => null,
        clear: () => {},
        layout: () => {},
        destroy: () => el.remove(),
      };
    },
  };
}

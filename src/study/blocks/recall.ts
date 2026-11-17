/**
 * The recall block (SPEC.md, Blocks: Recall): a numbers card's prompt, a page to write the answer
 * on, Show after 3 strokes, then the answer and a one-tap grade (clean, shaky, failed), logged as a
 * `drill` event with `src: 'recall'`. Owned by S6 on docs/study/BOARD.md. Reference:
 * lab/study-reader/src/block-drill.js (the same runner, without the Start card and the replay).
 */
import type { BlockHandle, BlockMount } from '../view/host';
import { runDrill } from './drill';

export const mount: BlockMount = (el, env): BlockHandle => {
  const anchor = env.passage.block?.id || env.passage.anchor;
  const rc = env.doc.recalls.find(r => r.anchor === anchor);
  if (!rc) {
    el.createDiv({ cls: 'nb-sb nb-sb-hint', text: `Recall card ${anchor} is not in this doc.` });
    return { destroy: () => el.empty() };
  }
  const api = runDrill(el, env, {
    item: rc.anchor,
    key: `recall:${rc.anchor}`,
    src: 'recall',
    prompt: rc.prompt,
    steps: undefined,
    answer: rc.answer ? rc.answer.markdown : null,
    kicker: 'Recall',
  });
  return { destroy: () => { api.destroy(); el.empty(); } };
};

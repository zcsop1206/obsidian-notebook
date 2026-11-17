/**
 * The kata block: katas: design call, editor, vector runs, settle. Owned by S9 on docs/study/BOARD.md.
 * STUB: shows a placeholder until S9 lands. Port from lab/study-reader/src/block-kata.js.
 */
import type { BlockMount } from '../view/host';

export const mount: BlockMount = (el, env) => {
  el.createDiv({ cls: 'nb-study-block-todo', text: `${env.passage.callout?.title || 'kata'}: this block arrives with S9.` });
  return { destroy: () => el.empty() };
};

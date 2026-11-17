/**
 * The recall block: recall prompts on numbers cards. Owned by S6 on docs/study/BOARD.md.
 * STUB: shows a placeholder until S6 lands. Port from lab/study-reader/src/block-drill.js.
 */
import type { BlockMount } from '../view/host';

export const mount: BlockMount = (el, env) => {
  el.createDiv({ cls: 'nb-study-block-todo', text: `${env.passage.callout?.title || 'recall'}: this block arrives with S6.` });
  return { destroy: () => el.empty() };
};

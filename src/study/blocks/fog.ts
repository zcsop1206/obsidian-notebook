/**
 * The fog block: proof callouts: fog by push level, cold drill, hook. Owned by S6 on docs/study/BOARD.md.
 * STUB: shows a placeholder until S6 lands. Port from lab/study-reader/src/block-fog.js.
 */
import type { BlockMount } from '../view/host';

export const mount: BlockMount = (el, env) => {
  el.createDiv({ cls: 'nb-study-block-todo', text: `${env.passage.callout?.title || 'fog'}: this block arrives with S6.` });
  return { destroy: () => el.empty() };
};

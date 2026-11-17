/**
 * The problem block: problems: call band, confidence, settle, ticks, solution. Owned by S7 on docs/study/BOARD.md.
 * STUB: shows a placeholder until S7 lands. Port from lab/study-reader/src/block-problem.js.
 */
import type { BlockMount } from '../view/host';

export const mount: BlockMount = (el, env) => {
  el.createDiv({ cls: 'nb-study-block-todo', text: `${env.passage.callout?.title || 'problem'}: this block arrives with S7.` });
  return { destroy: () => el.empty() };
};

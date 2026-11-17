/**
 * Which mount function a passage's block uses. Shared by S6, S7 and S9: each fills its own file;
 * this table only changes if a block type is added (through the board).
 */
import type { BlockRef } from '../types';
import type { BlockMount } from '../view/host';
import { mount as fog } from './fog';
import { mount as drill } from './drill';
import { mount as recall } from './recall';
import { mount as problem } from './problem';
import { mount as kata } from './kata';

export const BLOCKS: Record<Exclude<BlockRef['type'], 'solution'>, BlockMount> = { fog, drill, recall, problem, kata };

/** Solutions are never mounted on their own: their problem, derive or recall block shows them. */
export function mountFor(ref: BlockRef): BlockMount | null {
  return ref.type === 'solution' ? null : BLOCKS[ref.type];
}

/**
 * Registers the study blocks the view mounts on proof, problem, derive, recall, solution and kata passages.
 * Owned by S6 (fog and drill), S7 (problem), S9 (kata) on docs/study/BOARD.md. Blocks themselves mount
 * through BLOCKS in ./index.ts; this file wires the context's open* hooks (ui.openKata from S9, the
 * problem hook from S7, and so on) as each ticket lands.
 */
import type { StudyContext } from '../context';
import { registerUi as registerKataUi } from './kata';

export function register(ctx: StudyContext): void {
  registerKataUi(ctx);
}

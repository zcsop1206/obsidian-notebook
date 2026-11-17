/**
 * The Changes panel for a doc: build, rewrite budget, pending requests, marks and the doc's
 * `## Changes` section. Owned by S5 on docs/study/BOARD.md. STUB until S5 lands.
 */
import type { StudyContext } from '../context';

export async function openChanges(ctx: StudyContext, docId: string): Promise<void> {
  ctx.ui.toast(`Changes for ${docId}: arrives with S5.`);
}

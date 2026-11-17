/**
 * Margin marks and the triage UI (SPEC.md, Marks and triage; Decision 6). Owned by S5 on
 * docs/study/BOARD.md. STUB: no dots until S5 lands. Port from the demo's reader.js marks code.
 */
import type { Marks, MarksHost } from './host';

export function attachMarks(host: MarksHost): Marks {
  void host;
  return { refresh: () => {}, destroy: () => {} };
}

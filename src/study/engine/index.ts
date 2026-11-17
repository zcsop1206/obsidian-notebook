/**
 * The engine (SPEC.md, Engine): pure state over (content, events, now). STUB until ticket S2,
 * which ports lab/study-reader/src/engine.js here with the SPEC decisions applied.
 */
import type { Engine } from '../types';

export function createEngine(now: () => Date = () => new Date()): Engine {
  const notYet = (what: string): never => { throw new Error(`study engine: ${what} is not built yet (ticket S2)`); };
  return {
    now,
    today: () => {
      const d = now();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    update: () => {},
    basic: () => notYet('basic'),
    basics: () => [],
    rating: () => notYet('rating'),
    ratingHistory: () => [],
    methodAccuracy: () => ({ p: 0.75, n: 0 }),
    pushLevel: () => 0,
    expected: (d, r) => 1 / (1 + Math.pow(10, (d - r) / 2)),
    triage: () => ({ action: 'noted' }),
    budget: () => ({ left: 3, used: 0 }),
    marks: () => [],
    pendingRequests: () => [],
    todayPlan: () => notYet('todayPlan'),
    pickProblem: () => null,
    pickKata: () => null,
    blockers: () => [],
  };
}

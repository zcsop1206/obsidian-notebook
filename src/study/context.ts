/**
 * The glue every study module receives: settings, the content index, the event log and the
 * engine, plus change notifications. Implemented in index.ts; modules never reach around it.
 */
import type { App, Plugin } from 'obsidian';
import type { ContentIndex, Engine, StudyEvent } from './types';

export interface StudySettings {
  /** The study root inside the vault (FORMAT.md); `study` in the portfolio vault. */
  root: string;
  /** This device's name in event ids and log file names (`ipad`, `laptop`). Lowercase, no spaces. */
  device: string;
  /** Minutes Today plans for on a weekday; Saturday doubles it. */
  minutes: number;
  /** Shows the simulated clock and the demo buttons (development only). */
  devTools: boolean;
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = { root: 'study', device: '', minutes: 60, devTools: false };

/** What a caller passes to `log`: an event without the fields the store fills in. */
export type NewEvent = StudyEvent extends infer E ? (E extends StudyEvent ? Omit<E, 'v' | 'id' | 't' | 'dev'> : never) : never;

/**
 * Ways to open things, filled in by the modules that own them at register time (view: docs and
 * drills; blocks: problems and katas; panels: Today and Map). Until a module fills one, calling it
 * shows a notice. Callers never import another module's UI directly; they go through here.
 */
export interface StudyUi {
  openDoc(docId: string, anchor?: string): Promise<void>;
  openDrill(docId: string, anchor: string): Promise<void>;
  openProblem(id: string, opts?: { hidden?: boolean; reach?: boolean; why?: string }): Promise<void>;
  openKata(id: string, opts?: { hidden?: boolean; reach?: boolean; why?: string }): Promise<void>;
  openToday(): Promise<void>;
  openMap(): Promise<void>;
  toast(message: string, ms?: number): void;
}

export interface StudyContext {
  app: App;
  plugin: Plugin;
  /** Open docs, drills, problems, katas, Today and Map (see StudyUi). */
  ui: StudyUi;
  settings(): StudySettings;
  /** The current content index; rebuilt when a file under the root changes. */
  content(): ContentIndex;
  /** Every event from every device's log, sorted by time then id. */
  events(): StudyEvent[];
  /** Append to this device's log; resolves once written. */
  log(e: NewEvent): Promise<StudyEvent>;
  engine(): Engine;
  /** Called after the content index or the event list changes. Returns an unsubscribe. */
  onChange(fn: (what: 'content' | 'events') => void): () => void;
}

/**
 * Study mode's entry point: builds the StudyContext and hands it to each feature module.
 * main.ts calls registerStudy(this) once in onload. Each feature module is owned by one ticket
 * on docs/study/BOARD.md; this file only wires them and should rarely change.
 */
import type { Plugin } from 'obsidian';
import { DEFAULT_STUDY_SETTINGS, type NewEvent, type StudyContext, type StudySettings } from './context';
import type { ContentIndex, Engine, StudyEvent } from './types';
import { ContentLoader } from './content/loader';
import { EventStore } from './store/events';
import { createEngine } from './engine';
import { register as registerView } from './view/register';
import { register as registerBlocks } from './blocks/register';
import { register as registerPanels } from './panels/register';

export function registerStudy(plugin: Plugin): StudyContext {
  const listeners = new Set<(what: 'content' | 'events') => void>();
  const emit = (what: 'content' | 'events') => { for (const fn of listeners) { try { fn(what); } catch (e) { console.error('[study]', e); } } };
  const settings = (): StudySettings => {
    const s = (plugin as unknown as { settings?: { study?: Partial<StudySettings> } }).settings?.study;
    return { ...DEFAULT_STUDY_SETTINGS, ...(s || {}) };
  };
  const loader = new ContentLoader(plugin.app, () => settings().root, () => { engine.update(loader.index(), store.all()); emit('content'); });
  const store = new EventStore(plugin.app, () => settings().root, () => settings().device, () => { engine.update(loader.index(), store.all()); emit('events'); });
  const engine: Engine = createEngine();
  const ctx: StudyContext = {
    app: plugin.app,
    plugin,
    settings,
    content: (): ContentIndex => loader.index(),
    events: (): StudyEvent[] => store.all(),
    log: (e: NewEvent) => store.append(e),
    engine: () => engine,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  plugin.register(loader.watch());
  plugin.register(store.watch());
  registerView(ctx);
  registerBlocks(ctx);
  registerPanels(ctx);
  return ctx;
}

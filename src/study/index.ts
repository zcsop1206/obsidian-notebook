/**
 * Study mode's entry point: builds the StudyContext and hands it to each feature module.
 * main.ts calls registerStudy(this) once in onload. Each feature module is owned by one ticket
 * on docs/study/BOARD.md; this file only wires them and should rarely change.
 */
import { Notice, Platform, type Plugin } from 'obsidian';
import { DEFAULT_STUDY_SETTINGS, type NewEvent, type StudyContext, type StudySettings, type StudyUi } from './context';
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
  // Each device needs its own log and ink files, so an unset device name comes from the platform.
  const platformDevice = Platform.isMobile ? (Platform.isTablet ? 'ipad' : 'phone') : 'desktop';
  const settings = (): StudySettings => {
    const s = (plugin as unknown as { settings?: { study?: Partial<StudySettings> } }).settings?.study;
    const merged = { ...DEFAULT_STUDY_SETTINGS, ...(s || {}) };
    if (!merged.device || merged.device === DEFAULT_STUDY_SETTINGS.device) merged.device = platformDevice;
    return merged;
  };
  const notYet = (what: string) => async () => { new Notice(`Study mode: ${what} is not built yet.`); };
  const ui: StudyUi = {
    openDoc: notYet('the study view'),
    openDrill: notYet('drills'),
    openProblem: notYet('problems'),
    openKata: notYet('katas'),
    openToday: notYet('Today'),
    openMap: notYet('the map'),
    toast: (message: string, ms?: number) => { new Notice(message, ms); },
  };
  const loader = new ContentLoader(plugin.app, () => settings().root, () => { engine.update(loader.index(), store.all()); emit('content'); });
  const store = new EventStore(plugin.app, () => settings().root, () => settings().device, () => { engine.update(loader.index(), store.all()); emit('events'); });
  const engine: Engine = createEngine();
  const ctx: StudyContext = {
    app: plugin.app,
    plugin,
    ui,
    settings,
    content: (): ContentIndex => loader.index(),
    events: (): StudyEvent[] => store.all(),
    log: (e: NewEvent) => store.append(e),
    engine: () => engine,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  // Study mode must never take the ink editor down: each step is guarded on its own, so a module
  // that fails to register is logged and the others (and the rest of the plugin) still load.
  const guard = (what: string, fn: () => void) => {
    try { fn(); } catch (e) { console.error(`[study] ${what} failed to start`, e); }
  };
  guard('the content loader', () => plugin.register(loader.watch()));
  guard('the event store', () => plugin.register(store.watch()));
  guard('the study view', () => registerView(ctx));
  guard('the blocks', () => registerBlocks(ctx));
  guard('Today and Map', () => registerPanels(ctx));
  return ctx;
}

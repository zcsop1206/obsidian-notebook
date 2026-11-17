/**
 * The event logs: study/log/<device>.jsonl, append-only, one JSON event per line (SPEC.md,
 * Storage). STUB until ticket S2: keeps events in memory only. S2 replaces the body of this
 * class (same public surface): read every device's log, append to this device's, merge by time.
 */
import type { App } from 'obsidian';
import type { NewEvent } from '../context';
import type { StudyEvent } from '../types';

export class EventStore {
  private events: StudyEvent[] = [];

  constructor(private app: App, private root: () => string, private device: () => string, private changed: () => void) {}

  all(): StudyEvent[] {
    return this.events;
  }

  async append(e: NewEvent): Promise<StudyEvent> {
    const now = new Date();
    const full = { ...e, v: 1, id: `${this.device()}-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, t: now.toISOString(), dev: this.device() } as StudyEvent;
    this.events.push(full);
    this.changed();
    return full;
  }

  watch(): () => void {
    return () => {};
  }
}

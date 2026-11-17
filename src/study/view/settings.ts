/**
 * Study settings from saved data (`settings.study` in the plugin's data.json), validated. Pure, so
 * the unit tests can run it; src/settings.ts calls it from parseSettings. Owned by S3.
 */
import { DEFAULT_STUDY_SETTINGS, type StudySettings } from '../context';

export const MINUTES_MIN = 10;
export const MINUTES_MAX = 600;

/** A vault folder: forward slashes, no leading, trailing or doubled slashes, no `.` or `..`. */
export function cleanRoot(v: string): string {
  return v.replace(/\\/g, '/').split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..').join('/');
}

/** A device name for file names and event ids: lowercase letters, digits and hyphens; '' means "from the platform". */
export function cleanDevice(v: string): string {
  return v.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

export function parseStudySettings(data: unknown): StudySettings {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Partial<Record<keyof StudySettings, unknown>>;
  const root = typeof d.root === 'string' ? cleanRoot(d.root) : '';
  const device = typeof d.device === 'string' ? cleanDevice(d.device) : '';
  let minutes = DEFAULT_STUDY_SETTINGS.minutes;
  const m = typeof d.minutes === 'number' ? d.minutes : typeof d.minutes === 'string' ? Number(d.minutes) : NaN;
  if (Number.isFinite(m)) minutes = Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(m)));
  return {
    root: root || DEFAULT_STUDY_SETTINGS.root,
    device,
    minutes,
    devTools: typeof d.devTools === 'boolean' ? d.devTools : DEFAULT_STUDY_SETTINGS.devTools,
  };
}

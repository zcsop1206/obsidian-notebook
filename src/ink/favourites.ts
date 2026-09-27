// Favourite templates (#54): the names of starred templates (built-in names such as `sticky-3in`,
// or custom `tpl:<name>`), in the order they were starred, kept in the plugin settings
// (`favouriteTemplates`). Starred templates come first in the template chooser, the new-note
// dialog and the page-settings menu, and the first one that exists is the default for new notes
// unless the setting `favouriteDefault` is turned off (then, or with no favourites, the
// settings' default template is). Pure, so it's unit-tested.
import { isTemplateName } from '../format/template';
import { canonicalName, isCustomName } from './templates';

/** At most this many favourites are kept. */
export const MAX_FAVOURITES = 50;

/** Whether a name may be a favourite: a built-in's, or a custom template's. */
export const favouriteName = (name: string): boolean => isTemplateName(name) || isCustomName(name);

/**
 * Favourites from saved settings: strings that name a built-in or custom template (`pdf:` names
 * written as `tpl:`), without duplicates, at most MAX_FAVOURITES. Anything else is dropped with
 * a console warning.
 */
export function parseFavourites(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    console.warn('[notebook]', `Favourite templates in settings aren't a list; ignored`);
    return [];
  }
  const out: string[] = [];
  const bad: unknown[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !favouriteName(v)) bad.push(v);
    else if (!out.includes(canonicalName(v)) && out.length < MAX_FAVOURITES) out.push(canonicalName(v));
  }
  if (bad.length) console.warn('[notebook]', `Unknown favourite templates in settings ignored: ${JSON.stringify(bad)}`);
  return out;
}

export const isFavourite = (list: readonly string[], name: string): boolean => !!name && list.includes(canonicalName(name));

/** The list with `name` removed if it's there, else appended. */
export function toggleFavourite(list: readonly string[], name: string): string[] {
  const n = canonicalName(name);
  if (list.includes(n)) return list.filter(f => f !== n);
  return favouriteName(n) ? [...list, n].slice(-MAX_FAVOURITES) : [...list];
}

/** The list after a template was renamed (`to`) or deleted (`to` null). */
export function renameFavourite(list: readonly string[], from: string, to: string | null): string[] {
  const f = canonicalName(from), t = to === null ? null : canonicalName(to);
  const out: string[] = [];
  for (const n of list) {
    const m = n === f ? t : n;
    if (m !== null && !out.includes(m)) out.push(m);
  }
  return out;
}

/** The items with the favourites first, in the favourites' order, then the rest in their order. */
export function orderFavourites<T>(items: readonly T[], nameOf: (item: T) => string, favourites: readonly string[]): T[] {
  const rank = (item: T) => {
    const i = favourites.indexOf(canonicalName(nameOf(item)));
    return i < 0 ? Infinity : i;
  };
  return items.map((item, i) => ({ item, i, r: rank(item) }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r)).map(e => e.item);
}

/**
 * The template name new notes start with: with `useFavourite`, the first favourite that exists
 * (`known`); otherwise, or if none does, the settings' default template.
 */
export function defaultTemplateName(setting: string, useFavourite: boolean, favourites: readonly string[], known: (name: string) => boolean): string {
  return (useFavourite ? favourites.find(known) : undefined) ?? setting;
}

/** What the chooser, dialogs and menus need of the settings. */
export interface TemplatePrefs {
  favourites(): readonly string[];
  /** Stars or unstars a template (saving the settings); returns whether it's now a favourite. */
  toggle(name: string): boolean;
  /** A custom template was renamed (`to`) or deleted (null): favourites and the default follow. */
  renamed(from: string, to: string | null): void;
}

interface PrefsHost {
  settings: { favouriteTemplates: string[]; template: string };
  saveSettings(): Promise<void>;
}

/** TemplatePrefs over the plugin's settings. */
export function settingsPrefs(host: PrefsHost): TemplatePrefs {
  const save = () => void host.saveSettings().catch(e => console.error('[notebook]', 'saving favourite templates', e));
  return {
    favourites: () => host.settings.favouriteTemplates,
    toggle(name) {
      host.settings.favouriteTemplates = toggleFavourite(host.settings.favouriteTemplates, name);
      save();
      return isFavourite(host.settings.favouriteTemplates, name);
    },
    renamed(from, to) {
      host.settings.favouriteTemplates = renameFavourite(host.settings.favouriteTemplates, from, to);
      if (canonicalName(host.settings.template) === canonicalName(from)) host.settings.template = to ?? 'blank';
      save();
    },
  };
}

// Names for new ink notes. Pure, so they're unit-tested.
//
// One-tap new notes (#72) are named from a pattern, `newNoteName` in the settings, formatted with
// moment as Obsidian's daily notes are: the default `YYYY-MM-DD [Note]` gives "2026-10-10 Note"
// (text in square brackets is kept as written). A name already taken gets ` 1`, ` 2`… The
// formatter is passed in (main.ts gives moment's), so this module stays free of Obsidian.

export const DEFAULT_NAME = 'Untitled ink note';

/** The default pattern of a new note's name (#72): today's date and "Note". */
export const DEFAULT_NAME_PATTERN = 'YYYY-MM-DD [Note]';

/**
 * A usable note name: characters that break file names or links become spaces, and
 * whitespace is collapsed. Empty or dots-only names give DEFAULT_NAME.
 */
export function cleanName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|#^[\]\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  return clean || DEFAULT_NAME;
}

/** `name`, or `name 1`, `name 2`… the first one for which `taken` is false. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let i = 1; ; i++) if (!taken(`${name} ${i}`)) return `${name} ${i}`;
}

/**
 * The name of a new note from the pattern (#72): `format` turns a pattern into text (moment's
 * format of now), the result is cleaned (cleanName) and made unique (uniqueName). An empty
 * pattern is the default one; a formatter that throws gives DEFAULT_NAME.
 */
export function patternName(pattern: string, format: (pattern: string) => string, taken: (candidate: string) => boolean): string {
  let text: string;
  try {
    text = format(pattern.trim() || DEFAULT_NAME_PATTERN);
  } catch (e) {
    text = DEFAULT_NAME;
  }
  return uniqueName(cleanName(text), taken);
}

/**
 * A notes folder as typed in the settings (#72): a vault path without leading or trailing
 * slashes and without empty, `.` or `..` parts; '' is the vault root.
 */
export function cleanFolder(folder: string): string {
  return folder.split(/[\\/]+/).map(p => p.trim()).filter(p => p && p !== '.' && p !== '..').join('/');
}

// Names for new ink notes. Pure, so they're unit-tested.

export const DEFAULT_NAME = 'Untitled ink note';

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

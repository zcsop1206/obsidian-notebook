// Page and stroke ids. Ids are random so that reordering pages or strokes never renames
// anything. The random source is injectable so tests and the fixture script are reproducible.

/** Fills `bytes` with random values, like `crypto.getRandomValues`. */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

/** The default source: the platform CSPRNG (in the iOS web view, desktop Obsidian and Node 22). */
export const cryptoRandom: RandomSource = bytes => {
  crypto.getRandomValues(bytes);
};

/** `p-` and 6 lowercase hex characters, e.g. `p-7f3a0c`. Also the page's file name, without `.svg`. */
export const PAGE_ID_RE = /^p-[0-9a-f]{6}$/;
/** 8 lowercase hex characters, unique within a page. */
export const STROKE_ID_RE = /^[0-9a-f]{8}$/;

export const isPageId = (s: string) => PAGE_ID_RE.test(s);
export const isStrokeId = (s: string) => STROKE_ID_RE.test(s);

/** `chars` lowercase hex characters (`chars` even). */
export function randomHex(chars: number, random: RandomSource = cryptoRandom): string {
  const bytes = new Uint8Array(chars / 2);
  random(bytes);
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

function unique(make: () => string, taken: Iterable<string>): string {
  const used = taken instanceof Set ? taken as Set<string> : new Set(taken);
  // With 16M page ids and 4G stroke ids a clash is rare; retry until the id is free.
  for (;;) {
    const id = make();
    if (!used.has(id)) return id;
  }
}

/**
 * A new page id that isn't in `taken`. Pass every id the note uses (its index and any page
 * files already in its folder), so the id is unique within the note.
 */
export function newPageId(taken: Iterable<string>, random: RandomSource = cryptoRandom): string {
  return unique(() => 'p-' + randomHex(6, random), taken);
}

/** A new stroke id that isn't in `taken` (the ids of the page's other strokes). */
export function newStrokeId(taken: Iterable<string>, random: RandomSource = cryptoRandom): string {
  return unique(() => randomHex(8, random), taken);
}

/** An image's id on its page (#12): `i-` and 6 lowercase hex characters, e.g. `i-3b9f0e`. */
export const IMAGE_ID_RE = /^i-[0-9a-f]{6}$/;

export const isImageId = (s: string) => IMAGE_ID_RE.test(s);

/** A new image id that isn't in `taken` (the ids of the page's other images). */
export function newImageId(taken: Iterable<string>, random: RandomSource = cryptoRandom): string {
  return unique(() => 'i-' + randomHex(6, random), taken);
}

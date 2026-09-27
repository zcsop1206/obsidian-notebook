// The note index: a markdown file (`lecture.md`) whose frontmatter marks it as an ink note and
// whose body embeds each page in order with a standard markdown image link into the note's
// folder: `![](lecture/p-7f3a0c.svg)`. Everything else in the file is kept verbatim.
import { isPageId } from './ids';
import type { Paper } from './page';

export interface NoteIndex {
  /** The note's file name without `.md`; its pages live in the folder of the same name next to it. */
  basename: string;
  paper: Paper;
  /** Template kind name for new pages (`blank`; #19 adds more). */
  template: string;
  /** Page ids in order. */
  pages: string[];
  /** The rest of the file as read, which writeNote keeps. Absent for a new note. */
  source?: NoteSource;
}

type Key = 'ink' | 'paper' | 'template';
const KEYS: readonly Key[] = ['ink', 'paper', 'template'];

/** A frontmatter line: one of the keys this module owns, or any other line kept as is. */
export type FrontLine = { key: Key } | { raw: string };
/** A body line: text kept as is, or a page embed (with the page it held and its alt text). */
export type BodyLine = string | { page: string; alt: string };

export interface NoteSource {
  eol: '\n' | '\r\n';
  front: readonly FrontLine[];
  body: readonly BodyLine[];
}

export const PAPERS: readonly Paper[] = ['letter', 'a4'];

/** A new, empty note. */
export function newNote(basename: string, paper: Paper = 'letter', template = 'blank'): NoteIndex {
  return { basename, paper, template, pages: [] };
}

/** A page's path relative to the note's folder (unencoded), e.g. `lecture/p-7f3a0c.svg`. */
export const pagePath = (basename: string, id: string) => `${basename}/${id}.svg`;

/** The `---` line that opens and closes frontmatter. */
const isFence = (line: string) => /^---[ \t]*$/.test(line);

/** Whether a markdown file's frontmatter marks it as an ink note (`ink:` key). */
export function isInkNote(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  if (!isFence(lines[0])) return false;
  for (let i = 1; i < lines.length && !isFence(lines[i]); i++) {
    if (/^ink\s*:/.test(lines[i])) return true;
  }
  return false;
}

// ---- reading

const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, '$2');

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

/** The page id if `line` is an embed of a page in `basename`'s folder. */
function embedOf(line: string, basename: string): { page: string; alt: string } | null {
  const m = /^!\[([^\]]*)\]\((.*)\)\s*$/.exec(line);
  if (!m) return null;
  let url = m[2];
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
  const prefix = basename + '/';
  for (const u of [url, safeDecode(url)]) {
    if (u.startsWith(prefix) && u.endsWith('.svg')) {
      const id = u.slice(prefix.length, -4);
      if (isPageId(id)) return { page: id, alt: m[1] };
    }
  }
  return null;
}

/**
 * Reads a note index. `noteBasename` is the note's file name without `.md`. Throws if the file
 * isn't an ink note (no frontmatter with `ink: 1`) or a page is embedded twice.
 */
export function readNote(markdown: string, noteBasename: string): NoteIndex {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const end = isFence(lines[0]) ? lines.findIndex((l, i) => i > 0 && isFence(l)) : -1;
  if (end < 0) throw new Error('Not an ink note: no frontmatter');

  const values: Partial<Record<Key, string>> = {};
  const front: FrontLine[] = [];
  for (const line of lines.slice(1, end)) {
    const m = /^(ink|paper|template)\s*:(.*)$/.exec(line);
    if (!m) {
      front.push({ raw: line });
      continue;
    }
    const key = m[1] as Key;
    // A repeated key takes the last value (as YAML does) and is written once, at the first.
    if (!(key in values)) front.push({ key });
    values[key] = unquote(m[2].trim());
  }

  if (values.ink === undefined) throw new Error('Not an ink note: the frontmatter has no "ink: 1"');
  if (values.ink !== '1') throw new Error(`Unsupported ink note version "ink: ${values.ink}" (expected 1)`);
  const paper = (values.paper ?? 'letter').toLowerCase() as Paper;
  if (!PAPERS.includes(paper)) throw new Error(`Unknown paper "${values.paper}" (expected letter or a4)`);
  const template = values.template || 'blank';

  const pages: string[] = [];
  const body: BodyLine[] = lines.slice(end + 1).map(line => {
    const embed = embedOf(line, noteBasename);
    if (!embed) return line;
    if (pages.includes(embed.page)) throw new Error(`Page ${embed.page} is embedded twice in the note`);
    pages.push(embed.page);
    return embed;
  });

  return { basename: noteBasename, paper, template, pages, source: { eol, front, body } };
}

// ---- writing

/** Percent-encodes the characters that would break a markdown link destination. */
const encodePath = (path: string) =>
  path.replace(/[\s%()<>[\]#?^|\\]/g, c => c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c));

const embedLine = (basename: string, id: string, alt: string) =>
  `![${alt}](${encodePath(pagePath(basename, id))})`;

const isBlank = (l: BodyLine) => typeof l === 'string' && l.trim() === '';

const NEW_SOURCE: NoteSource = { eol: '\n', front: KEYS.map(key => ({ key })), body: [''] };

/**
 * The note's markdown. Writes the known frontmatter keys, one embed per page in order, and
 * keeps every other line. Embeds fill the places pages had when read; extra pages go after
 * the last embed (or at the end), and places left over are removed with one blank line
 * next to them. Embeds are separated by a blank line.
 */
export function writeNote(index: NoteIndex): string {
  const { basename, pages } = index;
  if (!PAPERS.includes(index.paper)) throw new Error(`Unknown paper "${index.paper}"`);
  if (!basename || /[\r\n/]/.test(basename)) throw new Error(`Invalid note name "${basename}"`);
  if (!index.template || /[\r\n]/.test(index.template)) throw new Error(`Invalid template "${index.template}"`);
  const seen = new Set<string>();
  for (const id of pages) {
    if (!isPageId(id)) throw new Error(`Invalid page id "${id}"`);
    if (seen.has(id)) throw new Error(`Page ${id} is listed twice`);
    seen.add(id);
  }

  const src = index.source ?? NEW_SOURCE;
  const values: Record<Key, string> = { ink: '1', paper: index.paper, template: index.template };
  const out: string[] = ['---'];
  for (const key of KEYS) if (!src.front.some(l => 'key' in l && l.key === key)) out.push(`${key}: ${values[key]}`);
  for (const l of src.front) out.push('key' in l ? `${l.key}: ${values[l.key]}` : l.raw);
  out.push('---');

  const body = src.body;
  const alts = new Map<string, string>();
  const slots: number[] = [];
  body.forEach((l, i) => {
    if (typeof l !== 'string') {
      slots.push(i);
      if (!alts.has(l.page)) alts.set(l.page, l.alt);
    }
  });
  const embed = (id: string) => embedLine(basename, id, alts.get(id) ?? '');

  // Places left over when pages were removed, each with one adjacent blank line.
  const drop = new Set<number>();
  const last = body.length > 0 && body[body.length - 1] === '' ? body.length - 1 : body.length; // keep the final newline
  for (const i of slots.slice(pages.length)) {
    drop.add(i);
    if (i > 0 && isBlank(body[i - 1]) && !drop.has(i - 1)) drop.add(i - 1);
    else if (i + 1 < last && isBlank(body[i + 1])) drop.add(i + 1);
  }

  // Pages beyond the places read go after the last embed, or at the end if there was none.
  const extra = pages.slice(slots.length);
  const appendAtEnd = (lines: string[]) => {
    extra.forEach((id, k) => {
      if (k > 0 || (lines.length > 0 && !isBlank(lines[lines.length - 1]))) lines.push('');
      lines.push(embed(id));
    });
  };

  const bodyOut: string[] = [];
  let slot = 0;
  body.forEach((l, i) => {
    if (slots.length === 0 && i === last) appendAtEnd(bodyOut);
    if (drop.has(i)) return;
    if (typeof l === 'string') {
      bodyOut.push(l);
      return;
    }
    bodyOut.push(embed(pages[slot]));
    if (++slot === slots.length) for (const id of extra) bodyOut.push('', embed(id));
  });
  if (slots.length === 0 && last === body.length) appendAtEnd(bodyOut);

  return out.concat(bodyOut).join(src.eol);
}

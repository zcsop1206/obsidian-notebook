// The note index: a markdown file (`lecture.md`) whose frontmatter marks it as an ink note and
// whose body embeds each page in order with a standard markdown image link into the note's
// folder: `![](lecture/p-7f3a0c.svg)`. Everything else in the file is kept verbatim. The pages'
// folder is normally the note's basename, but any relative folder is read (a folder renamed by
// hand, or one that couldn't follow a rename, #26), the folder of the first page embed; page-shaped embeds from other folders are text.
import { isPageId } from './ids';
import { parsePaper, type NotePaper, type Paper } from './page';

export interface NoteIndex {
  /** The note's file name without `.md`; its pages normally live in the folder of the same name next to it. */
  basename: string;
  /**
   * The folder holding the pages, relative to the note's own folder (`/`-separated, may start
   * with `../`): the basename unless it was read otherwise.
   */
  folder: string;
  /** `letter`, `a4`, or a custom size such as `288x288` (#27): the size of pages added later. */
  paper: NotePaper;
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
export function newNote(basename: string, paper: NotePaper = 'letter', template = 'blank'): NoteIndex {
  return { basename, folder: basename, paper, template, pages: [] };
}

/**
 * A page's path relative to the note's folder (unencoded), e.g. `lecture/p-7f3a0c.svg`, given
 * the pages' folder (the basename by default).
 */
export const pagePath = (folder: string, id: string) => `${folder}/${id}.svg`;

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

/** Whether `folder` is a usable relative folder: no scheme, not absolute, no empty or `.` parts. */
export function isRelativeFolder(folder: string): boolean {
  if (!folder || /[\r\n:\\]/.test(folder) || folder.startsWith('/')) return false;
  return folder.split('/').every(part => part !== '' && part !== '.');
}

/** The page id and its folder if `line` is an embed of a page (`<folder>/p-xxxxxx.svg`). */
function embedOf(line: string): { page: string; alt: string; folder: string } | null {
  const m = /^!\[([^\]]*)\]\((.*)\)\s*$/.exec(line);
  if (!m) return null;
  let url = m[2];
  if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
  for (const u of [safeDecode(url), url]) {
    const e = /^(.+)\/(p-[^/]*)\.svg$/.exec(u);
    if (e && isPageId(e[2]) && isRelativeFolder(e[1])) return { page: e[2], alt: m[1], folder: e[1] };
  }
  return null;
}

/**
 * Reads a note index. `noteBasename` is the note's file name without `.md`. Throws if the file
 * isn't an ink note (no frontmatter with `ink: 1`) or a page is embedded twice. The pages'
 * folder is the one the first page embed uses (the basename if there is none); page-shaped
 * embeds from other folders are kept as text.
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
  const paper = parsePaper(values.paper ?? 'letter');
  if (!paper) throw new Error(`Unknown paper "${values.paper}" (expected letter, a4 or <width>x<height> in px)`);
  const template = values.template || 'blank';

  const pages: string[] = [];
  let folder: string | null = null;
  const body: BodyLine[] = lines.slice(end + 1).map(line => {
    const embed = embedOf(line);
    // The first page embed sets the folder; a page-shaped embed from another folder is text.
    if (!embed || (folder !== null && embed.folder !== folder)) return line;
    if (pages.includes(embed.page)) throw new Error(`Page ${embed.page} is embedded twice in the note`);
    folder = embed.folder;
    pages.push(embed.page);
    return { page: embed.page, alt: embed.alt };
  });

  return { basename: noteBasename, folder: folder ?? noteBasename, paper, template, pages, source: { eol, front, body } };
}

// ---- writing

/** Percent-encodes the characters that would break a markdown link destination. */
const encodePath = (path: string) =>
  path.replace(/[\s%()<>[\]#?^|\\]/g, c => c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c));

/**
 * A standard markdown image embed of a path, e.g. a page's vault path for "Copy embed for this
 * page" (#27): `![](School/lecture/p-7f3a0c.svg)`, link-breaking characters encoded.
 */
export const markdownEmbed = (path: string) => `![](${encodePath(path)})`;

const embedLine = (folder: string, id: string, alt: string) =>
  `![${alt}](${encodePath(pagePath(folder, id))})`;

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
  const folder = index.folder ?? basename;
  if (typeof index.paper !== 'string' || parsePaper(index.paper) !== index.paper) throw new Error(`Unknown paper "${index.paper}"`);
  if (!basename || /[\r\n/]/.test(basename)) throw new Error(`Invalid note name "${basename}"`);
  if (!isRelativeFolder(folder)) throw new Error(`Invalid page folder "${folder}"`);
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
  const embed = (id: string) => embedLine(folder, id, alts.get(id) ?? '');

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

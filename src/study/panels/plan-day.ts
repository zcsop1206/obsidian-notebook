/**
 * The day file (ticket S42): `<study root>/plan/<YYYY-MM-DD>.md`, written once by the laptop
 * planner and then edited only by hand. Today shows its rows first. This module is pure (no
 * Obsidian imports): the parser, the label splitter and the one-line toggle used for ticking.
 *
 * A row is a checkbox line `- [ ] <minutes> · <rest>` (or `- [x]`, `* [ ]`, `- [X]`), where
 * `<rest>` is `<deliverable> · <label>` or just `private`. The label may hold `[[id]]` or
 * `[[id|alias]]` links and `**bold**`. Every other line (frontmatter, the `#` header, prose,
 * `hours …`, `answer …`) is not a row.
 */

export interface DayLink {
  /** The link target without any `#heading` part. */
  id: string;
  /** The text after `|`, if any. */
  alias: string | null;
}

export interface DayRow {
  /** 0-based line number in the file. */
  line: number;
  /** The whole line as read (without its line ending): what `toggleRow` expects to find. */
  raw: string;
  ticked: boolean;
  /** null for a checkbox line that does not start with `<minutes> ·`. */
  minutes: number | null;
  /** The first `·` field (`private` for a private row); '' when the row has one field only. */
  deliverable: string;
  /** Everything after the deliverable, `·` included; '' for a private row. */
  label: string;
  links: DayLink[];
}

export interface DayFile {
  header: { minutes: number } | null;
  rows: DayRow[];
}

/** A run of label text: plain, bold, or a link (shown by the caller as title, alias or id). */
export interface LabelSeg {
  text: string;
  bold: boolean;
  link?: DayLink;
}

const BOX = /^(\s*[-*]\s+\[)([ xX])(\]\s?)(.*)$/;
const LINK = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/;

/** Every `[[…]]` match in `s` (a fresh global regex each time, so no shared lastIndex). */
function linkMatches(s: string): RegExpExecArray[] {
  const re = new RegExp(LINK.source, 'g');
  const out: RegExpExecArray[] = [];
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m);
  return out;
}

function linksOf(label: string): DayLink[] {
  const out: DayLink[] = [];
  for (const m of linkMatches(label)) {
    const id = m[1].split('#')[0].trim();
    if (id) out.push({ id, alias: m[2] != null && m[2].trim() ? m[2].trim() : null });
  }
  return out;
}

/** True for a private row: the deliverable is `private` and nothing follows it. */
export function isPrivate(r: Pick<DayRow, 'deliverable' | 'label'>): boolean {
  return r.deliverable === 'private' && !r.label;
}

export function parseDayFile(text: string): DayFile {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  let i = 0;
  // Frontmatter: a leading `---` block.
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) { /* skip */ }
    i++;
  }
  let header: DayFile['header'] = null;
  let sawHeader = false;
  const rows: DayRow[] = [];
  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (!sawHeader && /^#\s/.test(raw)) {
      sawHeader = true;
      const m = raw.match(/(\d+)\s*min\b/);
      if (m) header = { minutes: +m[1] };
      continue;
    }
    const b = raw.match(BOX);
    if (!b) continue;
    const body = b[4].trim();
    if (!body) continue;
    let minutes: number | null = null;
    let rest = body;
    const mm = body.match(/^(\d+)\s*·\s*(.*)$/) || body.match(/^(\d+)$/);
    if (mm) {
      minutes = +mm[1];
      rest = (mm[2] ?? '').trim();
    }
    let deliverable = '';
    let label = rest;
    if (minutes != null) {
      const k = rest.match(/^(.*?)\s*·\s*(.*)$/);
      if (k) {
        deliverable = k[1].trim();
        label = k[2].trim();
      } else if (rest === 'private') {
        deliverable = 'private';
        label = '';
      }
    }
    rows.push({ line: i, raw, ticked: b[2] !== ' ', minutes, deliverable, label, links: linksOf(label) });
  }
  return { header, rows };
}

/**
 * The label as runs of text: `**…**` is bold, `[[id]]` / `[[id|alias]]` is a link; the markup
 * itself never appears in a run. A `**` without its pair stays as text.
 */
export function labelSegments(label: string): LabelSeg[] {
  const parts = label.split('**');
  // An even number of parts means one `**` has no partner: glue the last part back on.
  if (parts.length % 2 === 0) {
    const last = parts.pop() as string;
    parts[parts.length - 1] += '**' + last;
  }
  const out: LabelSeg[] = [];
  parts.forEach((part, k) => {
    const bold = k % 2 === 1;
    let at = 0;
    for (const m of linkMatches(part)) {
      const idx = m.index;
      if (idx > at) out.push({ text: part.slice(at, idx), bold });
      const id = m[1].split('#')[0].trim();
      const alias = m[2] != null && m[2].trim() ? m[2].trim() : null;
      out.push({ text: alias ?? id, bold, link: { id, alias } });
      at = idx + m[0].length;
    }
    if (at < part.length) out.push({ text: part.slice(at), bold });
  });
  return out.filter(s => s.text !== '' || s.link);
}

/**
 * Flips `[ ]` and `[x]` on line `line` of `text`, only when that line still reads exactly
 * `expectedRowText` (a row's `raw`); otherwise returns null and nothing should be written. Line
 * endings (LF or CRLF) and every other line are kept byte for byte.
 */
export function toggleRow(text: string, line: number, expectedRowText: string): string | null {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) return null;
  const cur = lines[line];
  const cr = cur.endsWith('\r') ? '\r' : '';
  const bare = cr ? cur.slice(0, -1) : cur;
  if (bare !== expectedRowText) return null;
  const b = bare.match(BOX);
  if (!b) return null;
  lines[line] = b[1] + (b[2] === ' ' ? 'x' : ' ') + b[3] + b[4] + cr;
  return lines.join('\n');
}

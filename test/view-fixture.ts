// Bundled by test/build.mjs into test/out/view-fixture.js for test/harness.html: the format
// functions, strokePath, how a stroke's path is painted (#60) and template names (to check what
// the ink view wrote) and a generator for large notes, on window.ink.
import { newPageId } from '../src/format/ids';
import { newNote, readNote, writeNote } from '../src/format/note';
import { centreline, isStroked, outlinePath, polygon, refit, smoothCurve, strokeOutline, strokePath } from '../src/format/outline';
import { readPage, writePage } from '../src/format/page';
import { parseTemplateName, templateName } from '../src/format/template';
import { densePage } from './fixture';
import { seeded } from './seeded';
import { canvasPath, centrelineArea, paintPath } from '../src/ink/renderer';

/**
 * The files of a note `name` in `folder` ('' for the vault root) with `pages` Letter pages of
 * `strokes` handwriting strokes each, keyed by vault path.
 */
function largeNote(folder: string, name: string, pages: number, strokes: number): Record<string, string> {
  const r = seeded(4242);
  const dir = folder ? folder + '/' : '';
  const note = newNote(name, 'letter', 'blank');
  const files: Record<string, string> = {};
  for (let i = 0; i < pages; i++) {
    const page = densePage(r, newPageId(note.pages, r.bytes), strokes);
    note.pages.push(page.id);
    files[`${dir}${name}/${page.id}.svg`] = writePage(page);
  }
  files[`${dir}${name}.md`] = writeNote(note);
  return files;
}

(window as unknown as { ink: unknown }).ink = { readPage, writePage, readNote, writeNote, templateName, parseTemplateName, largeNote, strokePath, strokeOutline, polygon,
  outlinePath, centreline, isStroked, refit, smoothCurve, canvasPath, paintPath, centrelineArea };

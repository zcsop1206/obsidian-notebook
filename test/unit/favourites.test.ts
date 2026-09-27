// Favourite templates (#54): parsing them from settings, starring, ordering every template list,
// following renames, the default template of new notes; and the pure parts of #56's question
// and of a PDF imported into an open note.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultTemplateName, isFavourite, MAX_FAVOURITES, orderFavourites, parseFavourites, renameFavourite, settingsPrefs, toggleFavourite,
} from '../../src/ink/favourites';
import { templateItems, pdfCopyName, pdfPages } from '../../src/ink/template-changes';

const quiet = <T>(fn: () => T): { value: T; warnings: unknown[][] } => {
  const warn = console.warn, warnings: unknown[][] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = warn;
  }
};

test('favourites: parsed defensively from settings; pdf: names written as tpl:', () => {
  assert.deepEqual(parseFavourites(undefined), []);
  const r = quiet(() => parseFavourites(['sticky-3in', 'pdf:Lab', 'tpl:Lab', 7, 'nope', 'tpl:', 'grid-5mm', 'sticky-3in', 'fill-00ff00']));
  assert.deepEqual(r.value, ['sticky-3in', 'tpl:Lab', 'grid-5mm', 'fill-00ff00']);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(quiet(() => parseFavourites('sticky-3in')).value, []);
  const many = Array.from({ length: 80 }, (_, i) => `tpl:T${i}`);
  assert.equal(parseFavourites(many).length, MAX_FAVOURITES);
});

test('favourites: toggling, renaming and deleting', () => {
  let list = toggleFavourite([], 'sticky-3in');
  list = toggleFavourite(list, 'pdf:Lab');
  assert.deepEqual(list, ['sticky-3in', 'tpl:Lab']);
  assert.ok(isFavourite(list, 'pdf:Lab') && isFavourite(list, 'tpl:Lab') && !isFavourite(list, 'blank') && !isFavourite(list, ''));
  assert.deepEqual(toggleFavourite(list, 'sticky-3in'), ['tpl:Lab']);
  assert.deepEqual(toggleFavourite(list, 'not-a-template'), list, 'unknown names are not starred');
  assert.deepEqual(renameFavourite(['a-x', 'tpl:Lab', 'grid-5mm'].slice(1), 'tpl:Lab', 'tpl:Lab 2'), ['tpl:Lab 2', 'grid-5mm']);
  assert.deepEqual(renameFavourite(['tpl:Lab', 'grid-5mm'], 'pdf:Lab', null), ['grid-5mm']);
  assert.deepEqual(renameFavourite(['tpl:A', 'tpl:B'], 'tpl:A', 'tpl:B'), ['tpl:B'], 'no duplicates');
});

test('favourites: first in the chooser, in the order starred; the rest keep their order; "Custom size…" last', () => {
  const entries = [
    { name: 'tpl:Lab', label: 'Lab', path: 't/Lab.svg', template: { kind: 'pdf' as const, source: 'Lab.pdf', page: 1, image: '' }, size: { width: 612, height: 792 } },
    { name: 'tpl:Card', label: 'Card', path: 't/Card.svg', template: { kind: 'fill' as const, color: '#ffeeaa' }, size: { width: 400, height: 300 } },
  ];
  const plain = templateItems(entries, true);
  assert.deepEqual(plain.map(i => i.name).slice(-4), ['index-card', 'tpl:Lab', 'tpl:Card', '']);
  assert.deepEqual(plain.slice(-3).map(i => i.label), ['Lab (PDF)', 'Card (custom)', 'Custom size…']);
  assert.ok(plain.slice(-3, -1).every(i => i.custom) && !plain[0].custom);
  const fav = templateItems(entries, true, ['tpl:Card', 'grid-5mm', 'tpl:Gone']);
  assert.deepEqual(fav.map(i => i.name).slice(0, 4), ['tpl:Card', 'grid-5mm', 'blank', 'lined-college']);
  assert.equal(fav[fav.length - 1].name, '');
  assert.equal(fav.length, plain.length);
  assert.deepEqual(orderFavourites(['a', 'b', 'c', 'd'], x => x, ['d', 'b']), ['d', 'b', 'a', 'c']);
});

test('favourites: the first existing favourite is the default template of new notes unless turned off', () => {
  const known = (n: string) => n !== 'tpl:Gone';
  assert.equal(defaultTemplateName('lined-college', true, ['tpl:Gone', 'sticky-3in'], known), 'sticky-3in');
  assert.equal(defaultTemplateName('lined-college', false, ['sticky-3in'], known), 'lined-college');
  assert.equal(defaultTemplateName('lined-college', true, [], known), 'lined-college');
  assert.equal(defaultTemplateName('lined-college', true, ['tpl:Gone'], known), 'lined-college');
});

test('settings: the favourites host stars, unstars and follows renames and deletes, saving each time', async () => {
  const s = { template: 'tpl:Lab', favouriteTemplates: ['tpl:Lab', 'dots-5mm'] };
  let saves = 0;
  const host = { settings: s, saveSettings: async () => { saves++; } };
  const prefs = settingsPrefs(host);
  assert.equal(prefs.toggle('sticky-3in'), true);
  assert.equal(prefs.toggle('dots-5mm'), false);
  assert.deepEqual(prefs.favourites(), ['tpl:Lab', 'sticky-3in']);
  prefs.renamed('tpl:Lab', 'tpl:Lab 2');
  assert.deepEqual([s.favouriteTemplates, s.template], [['tpl:Lab 2', 'sticky-3in'], 'tpl:Lab 2']);
  prefs.renamed('tpl:Lab 2', null);
  assert.deepEqual([s.favouriteTemplates, s.template], [['sticky-3in'], 'blank']);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(saves, 4);
});

test('PDF into an open note (#54): one pdf page per PDF page at its size; the copy gets a free name', () => {
  const pages = pdfPages('lecture 1.pdf', [
    { size: { width: 816, height: 1056 }, image: 'data:image/jpeg;base64,AA==' },
    { size: { width: 793.7, height: 1122.5 }, image: '' },
  ]);
  assert.deepEqual(pages, [
    { template: { kind: 'pdf', source: 'lecture 1.pdf', page: 1, image: 'data:image/jpeg;base64,AA==' }, size: { width: 816, height: 1056 } },
    { template: { kind: 'pdf', source: 'lecture 1.pdf', page: 2, image: '' }, size: { width: 793.7, height: 1122.5 } },
  ]);
  const taken = new Set(['lecture.pdf', 'lecture 1.pdf']);
  assert.equal(pdfCopyName('lecture', n => taken.has(n)), 'lecture 2.pdf');
  assert.equal(pdfCopyName('slides', n => taken.has(n)), 'slides.pdf');
});

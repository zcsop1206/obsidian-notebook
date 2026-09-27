// The pdf page template (#14): validation, the template layer's <image>, and the page file
// round trip, with the image stored once (in the drawing, not the metadata).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newPage, readPage, writePage } from '../../src/format/page';
import {
  isTemplateName, metadataTemplate, parseTemplate, parseTemplateName, pointsToPx, renderTemplate, templateLabel,
  templateName, type PdfTemplate,
} from '../../src/format/template';

// A 1×1 JPEG-ish payload: only its form matters to the format.
const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJ+/8=';
const PDF: PdfTemplate = { kind: 'pdf', source: 'lecture.pdf', page: 3, image: IMAGE };

test('pdf template: parses in canonical key order; a missing image is empty', () => {
  const got = parseTemplate({ image: IMAGE, page: 3, source: 'lecture.pdf', kind: 'pdf', extra: 1 });
  assert.equal(JSON.stringify(got), JSON.stringify(PDF));
  assert.deepEqual(parseTemplate({ kind: 'pdf', source: 'a b/Q&A (1).pdf', page: 1 }), { kind: 'pdf', source: 'a b/Q&A (1).pdf', page: 1, image: '' });
  assert.deepEqual(parseTemplate({ ...PDF, image: 'data:image/png;base64,iVBORw0KGgo=' }).kind, 'pdf');
});

test('pdf template: rejects bad fields', () => {
  const bad: [unknown, RegExp][] = [
    [{ ...PDF, source: '' }, /pdf source ""/],
    [{ ...PDF, source: undefined }, /pdf source undefined/],
    [{ ...PDF, source: '/abs/x.pdf' }, /pdf source/],
    [{ ...PDF, source: '../x.pdf' }, /pdf source/],
    [{ ...PDF, source: 'a//x.pdf' }, /pdf source/],
    [{ ...PDF, source: 'a\\x.pdf' }, /pdf source/],
    [{ ...PDF, source: 7 }, /pdf source 7/],
    [{ ...PDF, page: 0 }, /pdf page 0/],
    [{ ...PDF, page: 1.5 }, /pdf page 1.5/],
    [{ ...PDF, page: '2' }, /pdf page "2"/],
    [{ ...PDF, page: undefined }, /pdf page undefined/],
    [{ ...PDF, image: 'http://example.com/x.jpg' }, /pdf image/],
    [{ ...PDF, image: 'data:image/jpeg;base64,abc"/><script>' }, /pdf image/],
    [{ ...PDF, image: 'data:image/svg+xml;base64,PHN2Zz4=' }, /pdf image/],
    [{ ...PDF, image: 5 }, /pdf image/],
  ];
  for (const [value, re] of bad) assert.throws(() => parseTemplate(value), re, JSON.stringify(value));
});

test('pdf template: a fixed name and a label, not a built-in', () => {
  assert.equal(templateName(PDF), 'pdf');
  assert.equal(templateName({ ...PDF, page: 9 }), 'pdf');
  assert.equal(templateLabel(PDF), 'PDF page 3');
  assert.ok(!isTemplateName('pdf'));
  assert.throws(() => parseTemplateName('pdf'), /Unknown template "pdf"/);
});

test('pdf template: renders its image over the whole page, or nothing without one', () => {
  const size = { width: 1122.5, height: 793.7 };
  assert.deepEqual(renderTemplate(PDF, size),
    [`<image x="0" y="0" width="1122.5" height="793.7" preserveAspectRatio="none" href="${IMAGE}"/>`]);
  assert.deepEqual(renderTemplate({ ...PDF, image: '' }, size), []);
});

test('pdf template: points to CSS px at 96/72, to 0.1 px', () => {
  assert.equal(pointsToPx(612), 816);
  assert.equal(pointsToPx(792), 1056);
  assert.equal(pointsToPx(595.28), 793.7);
  assert.equal(pointsToPx(841.89), 1122.5);
  assert.deepEqual(metadataTemplate(PDF), { kind: 'pdf', source: 'lecture.pdf', page: 3 });
  assert.deepEqual(metadataTemplate({ kind: 'grid', spacing: '5mm' }), { kind: 'grid', spacing: '5mm' });
});

test('pdf page: the image is stored once, in the template layer, and read back from there', () => {
  const page = newPage('p-0a1b2c', { width: pointsToPx(841.89), height: pointsToPx(595.28) }, PDF);
  page.strokes.push({ id: '0000abcd', tool: 'pen', nib: 'uniform', color: '#000000', size: 2, points: [{ x: 10, y: 10, p: 0.5, t: 0 }, { x: 40, y: 12, p: 0.5, t: 8 }] });
  const svg = writePage(page);
  assert.equal(svg.split(IMAGE).length, 2, 'the image occurs exactly once');
  const meta = /<metadata><!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/.exec(svg)![1];
  assert.ok(meta.includes('"template":{"kind":"pdf","source":"lecture.pdf","page":3}'), meta.slice(0, 200));
  assert.ok(!meta.includes('base64'));
  assert.match(svg, /<g id="template">\n<image x="0" y="0" width="1122.5" height="793.7" preserveAspectRatio="none" href="data:image\/jpeg;base64,[^"]+"\/>\n<\/g>/);
  assert.match(svg, /viewBox="0 0 1122.5 793.7"/);
  const back = readPage(svg);
  assert.deepEqual(back.template, PDF);
  assert.deepEqual(back.size, { width: 1122.5, height: 793.7 });
  assert.equal(back.strokes.length, 1);
  assert.equal(writePage(back), svg, 'round trip is byte-stable');
});

test('pdf page: a page whose image is missing or mangled still reads, with no image', () => {
  const svg = writePage(newPage('p-0a1b2c', { width: 816, height: 1056 }, PDF));
  const without = svg.replace(/<image[^>]*\/>\n/, '');
  assert.deepEqual(readPage(without).template, { ...PDF, image: '' });
  const mangled = svg.replace('base64,', 'base64,!');
  assert.deepEqual(readPage(mangled).template, { ...PDF, image: '' });
  const noImage = writePage(newPage('p-0a1b2c', { width: 816, height: 1056 }, { ...PDF, image: '' }));
  assert.match(noImage, /<g id="template"><\/g>/);
  assert.deepEqual(readPage(noImage).template, { ...PDF, image: '' });
  // An image elsewhere in the drawing isn't taken for the template's.
  const elsewhere = noImage.replace('<g id="objects"></g>', `<g id="objects"><image href="${IMAGE}"/></g>`);
  assert.equal((readPage(elsewhere).template as PdfTemplate).image, '');
});

test('pdf page: bad pdf fields in the metadata are rejected', () => {
  const svg = writePage(newPage('p-0a1b2c', { width: 816, height: 1056 }, PDF));
  assert.throws(() => readPage(svg.replace('"page":3', '"page":0')), /pdf page 0/);
  assert.throws(() => readPage(svg.replace('"source":"lecture.pdf"', '"source":"../x.pdf"')), /pdf source/);
});

test('pdf page: default ink does not flip in dark mode; other pages keep the dark-mode style', () => {
  const pdf = writePage(newPage('p-0a1b2c', { width: 816, height: 1056 }, PDF));
  assert.match(pdf, /<style>\.i\{fill:#1f1f1f\}\.t\{stroke:#c9c9c9\}<\/style>/);
  assert.ok(!pdf.includes('prefers-color-scheme'));
  for (const template of [{ kind: 'blank' }, { kind: 'grid', spacing: '5mm' }] as const) {
    const svg = writePage(newPage('p-0a1b2c', { width: 816, height: 1056 }, template));
    assert.ok(svg.includes('@media (prefers-color-scheme:dark){.i{fill:#e6e3de}.t{stroke:#3c3c3c}}'));
  }
});

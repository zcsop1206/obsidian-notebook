// Images on pages (#12): the format (images in the objects layer, strokes' `on`, the `image`
// template), the geometry (images.ts) and the store's image operations.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isImageId, newImageId } from '../../src/format/ids';
import { newNote, writeNote } from '../../src/format/note';
import { newPage, readPage, writePage, type Page, type PageImage, type Stroke } from '../../src/format/page';
import { metadataTemplate, parseTemplate, renderTemplate, templateLabel, templateName } from '../../src/format/template';
import {
  imageAt, imageBox, imagePageSize, imagesBounds, imagesInLoop, inkOn, offImage, placeImage, storedSize, transformImage, unionBox, withImageIds,
} from '../../src/ink/images';
import { moveBy, resizeBy, transformStroke } from '../../src/ink/lasso';
import { NoteStore, type NoteFiles } from '../../src/ink/store';
import { seeded } from '../seeded';

// A 1×1 PNG and a tiny JPEG-looking data URL (only the shape is checked).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AL//Z';

const pts = (list: [number, number][]) => list.map(([x, y], i) => ({ x, y, p: 0.5, t: i * 5 }));
const pen = (id: string, list: [number, number][], on?: string): Stroke =>
  ({ id, tool: 'pen', nib: 'uniform', color: '#000000', size: 2, points: pts(list), ...(on ? { on } : {}) });
const img = (id: string, x: number, y: number, width: number, height: number, data = JPG): PageImage => ({ id, x, y, width, height, data });

function annotated(): Page {
  const page = newPage('p-0a0b0c');
  page.images = [img('i-000001', 100, 100, 300, 200), img('i-000002', 200.04, 400, 100, 100, PNG)];
  page.strokes = [pen('00000001', [[120, 120], [180, 150]], 'i-000001'), pen('00000002', [[500, 700], [520, 720]])];
  return page;
}

test('images: ids are i- and 6 hex, unique among those taken', () => {
  const r = seeded(3);
  const taken = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = newImageId(taken, r.bytes);
    assert.ok(isImageId(id), id);
    assert.ok(!taken.has(id));
    taken.add(id);
  }
  assert.ok(!isImageId('p-000000') && !isImageId('i-00000g') && !isImageId('00000001'));
});

test('images: a page with images and ink on them round-trips; the bytes live once, in the objects layer', () => {
  const page = annotated();
  const svg = writePage(page);
  const back = readPage(svg);
  assert.deepEqual(back.images, [img('i-000001', 100, 100, 300, 200), img('i-000002', 200, 400, 100, 100, PNG)]);
  assert.equal(back.strokes[0].on, 'i-000001');
  assert.ok(!('on' in back.strokes[1]));
  assert.equal(writePage(back), svg, 'writing what was read gives the same bytes');
  // Each image's data appears exactly once in the file, not in the metadata.
  assert.equal(svg.split(JPG).length - 1, 1);
  assert.equal(svg.split(PNG).length - 1, 1);
  const meta = /<metadata><!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/.exec(svg)![1];
  assert.ok(!meta.includes('data:'), 'no bytes in the metadata');
  const data = JSON.parse(meta);
  assert.deepEqual(data.images[0], { id: 'i-000001', x: 100, y: 100, width: 300, height: 200 });
  assert.equal(data.strokes[0].on, 'i-000001');
  // Layer order: template, objects, highlight, ink; one objects layer.
  const order = (svg.match(/<g id="\w+"/g) ?? []).map(g => g.slice(7, -1));
  assert.deepEqual(order, ['template', 'objects', 'highlight', 'ink']);
  assert.match(svg, /<image data-id="i-000001" x="100" y="100" width="300" height="200" preserveAspectRatio="none" href="data:image\/jpeg;base64,/);
});

test('images: a page without images writes as before (no images, no on, objects layer last and empty)', () => {
  const page = newPage('p-0a0b0c');
  page.strokes = [pen('00000002', [[500, 700], [520, 720]])];
  const svg = writePage(page);
  assert.ok(!svg.includes('"images"') && !svg.includes('"on"'));
  assert.ok(svg.endsWith('<g id="objects"></g>\n</svg>\n'));
  assert.equal(writePage({ ...page, images: [] }), svg, 'an empty list is the same as none');
  const back = readPage(svg);
  assert.ok(!('images' in back), 'reading gives no images key');
  assert.equal(writePage(back), svg);
});

test("images: an image whose bytes are missing still reads (data ''); on naming no image is dropped", () => {
  const svg = writePage(annotated()).replace(/ href="data:image\/png[^"]*"/, '');
  const back = readPage(svg);
  assert.equal(back.images![1].data, '');
  assert.equal(back.images![0].data, JPG);
  const page = annotated();
  page.strokes[1] = { ...page.strokes[1], on: 'i-0000ff' };
  assert.ok(!('on' in readPage(writePage(page)).strokes[1]));
  assert.throws(() => writePage({ ...annotated(), images: [img('i-000001', 0, 0, 1, 1), img('i-000001', 0, 0, 1, 1)] }), /used twice/);
  assert.throws(() => writePage({ ...annotated(), images: [img('x-000001', 0, 0, 1, 1)] }), /invalid id/);
  assert.throws(() => writePage({ ...annotated(), images: [img('i-000001', 0, 0, 0, 1)] }), /no area/);
});

test('images: the image template stores its bytes once, in the template layer, and reads them back', () => {
  const t = parseTemplate({ kind: 'image', image: JPG });
  assert.deepEqual(t, { kind: 'image', image: JPG });
  assert.deepEqual(metadataTemplate(t), { kind: 'image' });
  assert.deepEqual(parseTemplate({ kind: 'image' }), { kind: 'image', image: '' });
  assert.throws(() => parseTemplate({ kind: 'image', image: 'http://example.com/a.jpg' }));
  assert.equal(templateName(t), 'image');
  assert.equal(templateLabel(t), 'Image');
  assert.deepEqual(renderTemplate(t, { width: 816, height: 612 }), [`<image x="0" y="0" width="816" height="612" preserveAspectRatio="none" href="${JPG}"/>`]);
  const page = newPage('p-0a0b0c', { width: 816, height: 612 }, t);
  const svg = writePage(page);
  assert.equal(svg.split(JPG).length - 1, 1);
  assert.ok(svg.includes('"template":{"kind":"image"}'));
  assert.ok(!svg.includes('prefers-color-scheme'), 'the image is the paper: ink stays dark in dark mode');
  assert.deepEqual(readPage(svg).template, t);
  assert.equal(writePage(readPage(svg)), svg);
});

test('images: stored at most 4096 px on the long edge, never scaled up', () => {
  assert.deepEqual(storedSize(4000, 3000), { width: 4000, height: 3000 });
  assert.deepEqual(storedSize(4032, 3024), { width: 4032, height: 3024 });
  assert.deepEqual(storedSize(8192, 4096), { width: 4096, height: 2048 });
  assert.deepEqual(storedSize(3000, 12000), { width: 1024, height: 4096 });
  assert.deepEqual(storedSize(5000, 3), { width: 4096, height: 2 });
  assert.deepEqual(storedSize(1, 1), { width: 1, height: 1 });
});

test('images: placed at most half the page, aspect kept, centred and kept on the page', () => {
  const letter = { width: 816, height: 1056 };
  const a = placeImage(4032, 3024, letter, 408, 528);
  assert.equal(a.width, 408);
  assert.equal(a.height, 306);
  assert.deepEqual([a.x, a.y], [204, 375]);
  const tall = placeImage(1000, 4000, letter, 408, 528);
  assert.equal(tall.height, 528);
  assert.equal(tall.width, 132);
  const corner = placeImage(4032, 3024, letter, 0, 2000);
  assert.deepEqual([corner.x, corner.y], [0, 1056 - 306]);
  assert.deepEqual(imagePageSize(4032, 3024, letter), { width: 816, height: 612 });
});

test('images: hits (topmost), lasso by centre, bounds', () => {
  const page = annotated();
  const [a, b] = page.images!;
  assert.equal(imageAt(page.images, 150, 150), a);
  assert.equal(imageAt([a, img('i-000003', 120, 120, 50, 50)], 130, 130)!.id, 'i-000003', 'the topmost wins');
  assert.equal(imageAt(page.images, 50, 50), null);
  assert.equal(imageAt(undefined, 50, 50), null);
  const loop = [{ x: 150, y: 150 }, { x: 350, y: 150 }, { x: 350, y: 250 }, { x: 150, y: 250 }]; // around a's centre only
  assert.deepEqual(imagesInLoop(page.images, loop), ['i-000001']);
  assert.deepEqual(imagesInLoop(page.images, loop.slice(0, 2)), []);
  assert.deepEqual(imageBox(a), [100, 100, 400, 300]);
  assert.deepEqual(imagesBounds([a, b]), [100, 100, 400, 500]);
  assert.deepEqual(unionBox(null, [1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(unionBox([0, 5, 2, 6], [1, 2, 3, 4]), [0, 2, 3, 6]);
  assert.deepEqual(inkOn(page.strokes, ['i-000001']).map(s => s.id), ['00000001']);
  assert.deepEqual(inkOn(page.strokes, []), []);
});

test('images: a move or resize transforms the image and its ink together', () => {
  const page = annotated();
  const a = page.images![0], ink = page.strokes[0];
  const m = moveBy(10, -20);
  assert.deepEqual(transformImage(a, m), { ...a, x: 110, y: 80 });
  const r = resizeBy([100, 100, 400, 300], 2);
  const big = transformImage(a, r);
  assert.deepEqual([big.x, big.y, big.width, big.height], [100, 100, 600, 400]);
  const s = transformStroke(ink, r);
  assert.equal(s.on, 'i-000001', 'the ink stays on its image');
  assert.deepEqual(s.points.map(p => [p.x, p.y]), [[140, 140], [260, 200]]);
  // Relative to the image, the ink is where it was.
  const rel = (x: number, im: PageImage) => (x - im.x) / im.width;
  assert.equal(rel(s.points[0].x, big), rel(ink.points[0].x, a));
});

test('images: copies get fresh image ids and their ink follows; ink of other images drops its on', () => {
  const page = annotated();
  const strokes = [...page.strokes, pen('00000003', [[0, 0], [1, 1]], 'i-000009')];
  const r = seeded(5);
  const out = withImageIds([page.images![0]], strokes, new Set(['i-000001', 'i-000002']), true, r.bytes);
  const id = out.images[0].id;
  assert.ok(isImageId(id) && id !== 'i-000001');
  assert.equal(out.strokes[0].on, id);
  assert.ok(!('on' in out.strokes[1]) && !('on' in out.strokes[2]));
  assert.equal(page.images![0].id, 'i-000001', 'the originals are untouched');
  assert.ok(!('on' in offImage(strokes[0])));
});

function memFiles(): NoteFiles & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async p => files.get(p) ?? null,
    write: async (p, t) => void files.set(p, t),
    list: () => [],
    delete: async p => void files.delete(p),
    isFolder: () => false,
  };
}

test('images: the store adds, replaces and removes images, and inserts an image page', async () => {
  const fs = memFiles();
  const note = newNote('N', 'letter', 'blank');
  const page = newPage('p-0a0b0c');
  note.pages.push(page.id);
  fs.files.set('N/p-0a0b0c.svg', writePage(page));
  const text = writeNote(note);
  fs.files.set('N.md', text);
  const store = new NoteStore(fs, 'N.md', 'N', { pageChanged() {}, indexChanged() {}, notice() {}, saved() {} }, { delay: 1e9, maxDelay: 1e9 });
  await store.load(text);
  const a = img('i-000001', 10, 10, 100, 50), b = img('i-000002', 20, 20, 10, 10, PNG);
  assert.ok(store.addImage('p-0a0b0c', a));
  assert.ok(store.addImage('p-0a0b0c', b));
  assert.ok(!store.addImage('p-0a0b0c', a), 'an id is used once');
  assert.ok(!store.addImage('p-ffffff', a));
  const old = store.replaceImages('p-0a0b0c', [{ id: 'i-000001', image: { ...a, x: 30 } }]);
  assert.deepEqual(old, [{ id: 'i-000001', image: a }]);
  const removed = store.removeImages('p-0a0b0c', ['i-000001']);
  assert.deepEqual(removed, [{ index: 0, image: { ...a, x: 30 } }]);
  store.addImage('p-0a0b0c', removed[0].image, removed[0].index);
  assert.deepEqual(store.slots[0].page!.images!.map(im => im.id), ['i-000001', 'i-000002'], 'put back where it was');
  await store.flush();
  const saved = readPage(fs.files.get('N/p-0a0b0c.svg')!);
  assert.deepEqual(saved.images, [{ ...a, x: 30 }, b]);
  const slot = store.insertPage(1, { kind: 'image', image: JPG }, { width: 816, height: 612 });
  assert.deepEqual(slot.size, { width: 816, height: 612 });
  await store.flush();
  const pg = readPage(fs.files.get(slot.path)!);
  assert.deepEqual(pg.template, { kind: 'image', image: JPG });
  assert.deepEqual(pg.size, { width: 816, height: 612 });
  store.close();
});

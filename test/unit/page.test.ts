import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  A4, decodePoints, encodePoints, FORMAT, LETTER, newPage, readPage, writePage, type Page,
} from '../../src/format/page';
import { strokePath } from '../../src/format/outline';
import { seeded } from '../seeded';
import { KINDS, randomPage } from './helpers';

const metaJson = (svg: string) => JSON.parse(/<!\[CDATA\[([\s\S]*)\]\]>/.exec(svg)![1]);

for (const tool of [...KINDS, 'mixed'] as const) {
  for (const count of [0, 1, 500]) {
    test(`round trip: ${count} ${tool} strokes, write → read → write is identical`, () => {
      const page = randomPage(seeded(count * 7 + tool.length), count, tool);
      const first = writePage(page);
      const read = readPage(first);
      const second = writePage(read);
      assert.equal(second, first);
      // Reading the second file gives the same model again.
      assert.deepEqual(readPage(second), read);
      assert.equal(read.strokes.length, count);
      assert.equal(read.id, page.id);
      assert.deepEqual(read.strokes.map(s => s.id), page.strokes.map(s => s.id));
    });
  }
}

test('writePage is deterministic and does not modify the page', () => {
  const page = randomPage(seeded(3), 20, 'mixed');
  const copy = JSON.parse(JSON.stringify(page));
  assert.equal(writePage(page), writePage(page));
  assert.deepEqual(page, copy);
});

test('rounding: x, y to 0.1 px, p to 0.01, t to whole ms as deltas from the previous point', () => {
  const pts = [
    { x: 10.04, y: 20.06, p: 0.123, t: 1000.4 },
    { x: 10.16, y: -0.04, p: 0.996, t: 1004.6 },
    { x: 815.96, y: 1055.99, p: 1.7, t: 1004.2 }, // time going backwards clamps to 0 ms
    { x: 3, y: 4, p: -0.2, t: 1020 },
  ];
  const flat = encodePoints(pts);
  assert.deepEqual(flat, [10, 20.1, 0.12, 0, 10.2, 0, 1, 5, 816, 1056, 1, 0, 3, 4, 0, 15]);
  assert.deepEqual(decodePoints(flat), [
    { x: 10, y: 20.1, p: 0.12, t: 0 },
    { x: 10.2, y: 0, p: 1, t: 5 },
    { x: 816, y: 1056, p: 1, t: 5 },
    { x: 3, y: 4, p: 0, t: 20 },
  ]);
  assert.deepEqual(encodePoints(decodePoints(flat)), flat);
  // No -0 or float noise in the file.
  const page: Page = { ...newPage('p-000001'), strokes: [{ id: 'aaaaaaaa', tool: 'pen', nib: 'pressure', color: '#000000', size: 2.2449, points: pts }] };
  const svg = writePage(page);
  assert.ok(!svg.includes('-0,') && !svg.includes('-0 ') && !/\d\.\d{3,}/.test(svg), 'no -0 or excess digits');
  const s = readPage(svg).strokes[0];
  assert.equal(s.size, 2.2);
  assert.deepEqual(s.points, decodePoints(flat));
});

test('uppercase colours are written lowercase; invalid colours are rejected', () => {
  const page = newPage('p-00000a');
  page.strokes.push({ id: '0000000a', tool: 'pen', nib: 'uniform', color: '#1E5BD8', size: 2, points: [{ x: 1, y: 1, p: 0.5, t: 0 }] });
  assert.equal(readPage(writePage(page)).strokes[0].color, '#1e5bd8');
  page.strokes[0].color = 'blue';
  assert.throws(() => writePage(page), /colour/);
});

test('SVG layout: header, style, metadata, the four layers in order', () => {
  const page = randomPage(seeded(11), 6, 'mixed');
  page.strokes[0].color = '#000000';
  page.strokes[1].color = '#000000';
  page.strokes[2].color = '#d0312d';
  const svg = writePage(page);
  const lines = svg.split('\n');
  assert.equal(lines[0], '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 816 1056" width="816" height="1056">');
  assert.match(lines[1], /^<style>\.i\{fill:#1f1f1f\}\.t\{stroke:#c9c9c9\}@media \(prefers-color-scheme:dark\)\{\.i\{fill:#e6e3de\}\.t\{stroke:#3c3c3c\}\}<\/style>$/);
  assert.match(lines[2], /^<metadata><!\[CDATA\[\{"format":"notebook-ink\/1","id":"p-[0-9a-f]{6}","size":\{"width":816,"height":1056\},"template":\{"kind":"blank"\},"strokes":\[$/);
  const order = ['<g id="template">', '<g id="highlight" opacity="0.4">', '<g id="ink">', '<g id="objects">'].map(g => svg.indexOf(g));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'layers in order');
  assert.ok(svg.endsWith('</svg>\n'));
  // One path per line; default black uses the dark-mode class, other colours a literal fill.
  const paths = lines.filter(l => l.startsWith('<path'));
  assert.equal(paths.length, 6);
  for (const s of page.strokes) {
    const line = paths.find(l => l.includes(`data-id="${s.id}"`))!;
    assert.ok(line, s.id);
    if (s.color === '#000000') assert.ok(line.includes('class="i"') && !line.includes('fill='), line);
    else assert.ok(line.includes(`fill="${s.color}"`) && !line.includes('class='), line);
  }
  // Highlighter paths sit in the highlight layer, pen paths in the ink layer.
  const hl = svg.slice(svg.indexOf('<g id="highlight"'), svg.indexOf('<g id="ink"'));
  const ink = svg.slice(svg.indexOf('<g id="ink"'), svg.indexOf('<g id="objects"'));
  for (const s of page.strokes) assert.ok((s.tool === 'highlighter' ? hl : ink).includes(s.id));
});

test('an empty page still has all four (empty) layers', () => {
  const svg = writePage(newPage('p-abcdef', A4));
  assert.equal(svg, [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="794" height="1123">',
    '<style>.i{fill:#1f1f1f}.t{stroke:#c9c9c9}@media (prefers-color-scheme:dark){.i{fill:#e6e3de}.t{stroke:#3c3c3c}}</style>',
    '<metadata><![CDATA[{"format":"notebook-ink/1","id":"p-abcdef","size":{"width":794,"height":1123},"template":{"kind":"blank"},"strokes":[]}]]></metadata>',
    '<g id="template"></g>',
    '<g id="highlight" opacity="0.4"></g>',
    '<g id="ink"></g>',
    '<g id="objects"></g>',
    '</svg>',
    '',
  ].join('\n'));
  assert.deepEqual(readPage(svg), { id: 'p-abcdef', size: { width: 794, height: 1123 }, template: { kind: 'blank' }, strokes: [] });
});

test('page size is stored per page', () => {
  const page = newPage('p-0000aa', { width: 612.34, height: 792 });
  const read = readPage(writePage(page));
  assert.deepEqual(read.size, { width: 612.3, height: 792 });
  assert.match(writePage(read), /viewBox="0 0 612.3 792" width="612.3" height="792"/);
  assert.deepEqual(readPage(writePage(newPage('p-0000ab'))).size, LETTER);
});

test('readPage ignores the drawn paths and uses only the metadata', () => {
  const page = randomPage(seeded(5), 3, 'pen/pressure');
  const svg = writePage(page);
  const tampered = svg.replace(/ d="[^"]*"/g, ' d="M0 0Z"').replace('<g id="objects"></g>', '<g id="objects"><path d="M1 1"/></g>');
  assert.equal(writePage(readPage(tampered)), svg);
});

test('a one-point stroke is a dot of diameter size', () => {
  const d = strokePath({ tool: 'pen', nib: 'pressure', size: 4, points: [{ x: 100, y: 50, p: 0.2, t: 0 }] });
  assert.equal(d, 'M98 50A2 2 0 1 0 102 50A2 2 0 1 0 98 50Z');
});

test('pressure nib width follows pressure; uniform nib and highlighter widths do not', () => {
  const width = (s: { tool: 'pen'; nib: 'uniform' | 'pressure' } | { tool: 'highlighter' }, p: number) => {
    const points = Array.from({ length: 30 }, (_, i) => ({ x: 100 + i * 4, y: 100, p, t: i * 4 }));
    const ys = strokePath({ ...s, size: 10, points }).match(/-?[\d.]+ -?[\d.]+/g)!.map(v => Number(v.split(' ')[1]));
    return Math.max(...ys) - Math.min(...ys);
  };
  const pressure = { tool: 'pen', nib: 'pressure' } as const;
  assert.ok(width(pressure, 0.9) > width(pressure, 0.5) + 2 && width(pressure, 0.5) > width(pressure, 0.1) + 2);
  assert.ok(Math.abs(width(pressure, 0.5) - 10) < 0.5, 'pressure nib at 0.5 is `size` wide');
  for (const s of [{ tool: 'pen', nib: 'uniform' }, { tool: 'highlighter' }] as const) {
    for (const p of [0, 0.1, 0.5, 0.9, 1]) assert.ok(Math.abs(width(s, p) - 10) < 0.5, `${s.tool} at ${p}: ${width(s, p)}`);
  }
});

test('size takes any positive number, stored to 0.1 px', () => {
  for (const [size, stored] of [[0.04, 0], [0.05, 0.1], [1.25, 1.3], [3.14159, 3.1], [17, 17]]) {
    const page = newPage('p-0000c0');
    page.strokes.push({ id: '000000c0', tool: 'highlighter', color: '#ffd400', size, points: [{ x: 1, y: 1, p: 0.5, t: 0 }] });
    if (stored === 0) assert.throws(() => writePage(page), /invalid size/);
    else assert.equal(readPage(writePage(page)).strokes[0].size, stored);
  }
});

test('pen strokes carry their nib; highlighter strokes have none', () => {
  const page = randomPage(seeded(12), 6, 'mixed');
  const svg = writePage(page);
  const json = metaJson(svg);
  for (const s of json.strokes) {
    if (s.tool === 'pen') assert.ok(Object.keys(s).join() === 'id,tool,nib,color,size,points' && ['uniform', 'pressure'].includes(s.nib));
    else assert.equal(Object.keys(s).join(), 'id,tool,color,size,points');
  }
  assert.deepEqual(readPage(svg).strokes.map(s => s.tool === 'pen' ? s.nib : '-'), page.strokes.map(s => s.tool === 'pen' ? s.nib : '-'));
});

test('files in another format are rejected with a clear error', () => {
  const spike = '<svg xmlns="http://www.w3.org/2000/svg"><metadata><![CDATA[{"format":"notebook-ink/0","page":{"w":1,"h":1},"strokes":[]}]]></metadata></svg>';
  assert.throws(() => readPage(spike), /Unsupported ink page format "notebook-ink\/0" \(expected "notebook-ink\/1"\)/);
  assert.throws(() => readPage('<svg xmlns="http://www.w3.org/2000/svg"/>'), /no <metadata>/);
  assert.throws(() => readPage('<svg><metadata><![CDATA[{nope]]></metadata></svg>'), /not valid JSON/);
  assert.equal(FORMAT, 'notebook-ink/1');
});

test('invalid page data is rejected', () => {
  const good = metaJson(writePage(randomPage(seeded(9), 3, 'mixed')));
  const svgOf = (m: unknown) => `<svg><metadata><![CDATA[${JSON.stringify(m)}]]></metadata></svg>`;
  const bad = (edit: (m: any) => void, re: RegExp) => {
    const m = JSON.parse(JSON.stringify(good));
    edit(m);
    assert.throws(() => readPage(svgOf(m)), re);
  };
  assert.doesNotThrow(() => readPage(svgOf(good)));
  bad(m => { m.id = 'page1'; }, /invalid page id/);
  bad(m => { m.size = { width: 0, height: 5 }; }, /size/);
  bad(m => { m.template = { kind: 'wallpaper' }; }, /Unknown page template "wallpaper"/);
  bad(m => { m.strokes[1].id = m.strokes[0].id; }, /used twice/);
  bad(m => { m.strokes[0].id = 'XYZ'; }, /invalid id/);
  bad(m => { m.strokes[0].tool = 'marker'; }, /unknown tool/);
  bad(m => { m.strokes[0].nib = 'calligraphy'; }, /unknown nib "calligraphy" \(expected uniform or pressure\)/);
  bad(m => { delete m.strokes[0].nib; }, /unknown nib/);
  bad(m => { m.strokes[2].nib = 'uniform'; }, /highlighter stroke [0-9a-f]{8} has a nib/);
  bad(m => { m.strokes[0].points = [1, 2, 3]; }, /points/);
  bad(m => { m.strokes[0].points = []; }, /points/);
  bad(m => { m.strokes[0].size = -1; }, /size/);
});

test('writePage rejects pages it cannot write', () => {
  const page = randomPage(seeded(10), 2, 'pen/uniform');
  assert.throws(() => writePage({ ...page, id: 'p-12' }), /invalid page id/);
  assert.throws(() => writePage({ ...page, template: { kind: 'lined' } as never }), /Unknown page template "lined"/);
  assert.throws(() => writePage({ ...page, strokes: [{ ...page.strokes[0], points: [] }] }), /no points/);
  assert.throws(() => writePage({ ...page, strokes: [page.strokes[0], page.strokes[0]] }), /used twice/);
});

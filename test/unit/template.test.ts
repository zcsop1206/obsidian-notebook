// Page templates: the model, names, and the SVG of each kind's template layer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A4, LETTER, newPage, readPage, writePage } from '../../src/format/page';
import {
  BUILT_IN_TEMPLATES, defaultTemplate, isTemplateName, parseTemplate, parseTemplateName, renderTemplate,
  TEMPLATE_KINDS, templateLabel, templateName, type Template,
  fixedPaper, sameTemplate, STICKY_COLOR, templateSize,
} from '../../src/format/template';

/** The segments of a path's `d` as [command, numbers] pairs. */
function segments(el: string): [string, number[]][] {
  const d = /\sd="([^"]*)"/.exec(el)![1];
  const out: [string, number[]][] = [];
  const re = /([MmHhVvAa])([^MmHhVvAa]*)/g;
  for (let m = re.exec(d); m; m = re.exec(d)) out.push([m[1], m[2].trim() ? m[2].trim().split(/[ ,]+/).map(Number) : []]);
  return out;
}

test('names: every built-in template round-trips through its name', () => {
  assert.deepEqual(BUILT_IN_TEMPLATES.map(b => b.name), [
    'blank', 'lined-college', 'lined-college-margin', 'lined-wide', 'lined-wide-margin', 'grid-5mm', 'grid-quarter-inch', 'dots-5mm',
    'sticky-3in', 'index-card',
  ]);
  for (const b of BUILT_IN_TEMPLATES) {
    assert.equal(templateName(b.template), b.name);
    assert.deepEqual(parseTemplateName(b.name), b.template);
    assert.equal(templateName(parseTemplateName(b.name)), b.name);
    assert.equal(templateLabel(b.template), b.label);
    assert.ok(isTemplateName(b.name));
  }
  assert.equal(templateLabel({ kind: 'lined', rule: 'college', margin: true }), 'Lined, college rule, with margin');
  // A fresh object each time, so changing it doesn't change the built-in list.
  const t = parseTemplateName('grid-5mm') as { spacing: string };
  t.spacing = '1/4in';
  assert.equal(templateName(parseTemplateName('grid-5mm')), 'grid-5mm');
  assert.throws(() => parseTemplateName('lined'), /Unknown template "lined"/);
  assert.throws(() => parseTemplateName('Blank'), /Unknown template/);
  assert.ok(!isTemplateName('grid'));
});

test('parseTemplate: every kind, in canonical key order, and a default per kind', () => {
  const cases: [unknown, Template][] = [
    [{ kind: 'blank', extra: 1 }, { kind: 'blank' }],
    [{ margin: true, rule: 'wide', kind: 'lined' }, { kind: 'lined', rule: 'wide', margin: true }],
    [{ kind: 'lined', rule: 'college', margin: false }, { kind: 'lined', rule: 'college', margin: false }],
    [{ spacing: '1/4in', kind: 'grid' }, { kind: 'grid', spacing: '1/4in' }],
    [{ kind: 'dots', spacing: '5mm' }, { kind: 'dots', spacing: '5mm' }],
  ];
  for (const [input, want] of cases) {
    const got = parseTemplate(input);
    assert.deepEqual(got, want);
    assert.equal(JSON.stringify(got), JSON.stringify(want)); // key order too
  }
  for (const kind of TEMPLATE_KINDS) assert.equal(parseTemplate(defaultTemplate(kind)).kind, kind);
  assert.deepEqual(TEMPLATE_KINDS, ['blank', 'lined', 'grid', 'dots']);
});

test('parseTemplate rejects bad options', () => {
  assert.throws(() => parseTemplate(null), /expected an object/);
  assert.throws(() => parseTemplate({ kind: 3 }), /expected an object/);
  assert.throws(() => parseTemplate({ kind: 'wallpaper' }), /Unknown page template "wallpaper"/);
  assert.throws(() => parseTemplate({ kind: 'lined', rule: 'narrow', margin: false }), /lined rule "narrow" \(expected "college" or "wide"\)/);
  assert.throws(() => parseTemplate({ kind: 'lined', rule: 'college' }), /lined margin undefined/);
  assert.throws(() => parseTemplate({ kind: 'lined', rule: 'college', margin: 'yes' }), /lined margin "yes"/);
  assert.throws(() => parseTemplate({ kind: 'grid', spacing: '1cm' }), /grid spacing "1cm"/);
  assert.throws(() => parseTemplate({ kind: 'grid' }), /grid spacing undefined/);
  assert.throws(() => parseTemplate({ kind: 'dots', spacing: '1/4in' }), /dots spacing "1\/4in" \(expected "5mm"\)/);
});

test('render: blank is empty', () => {
  assert.deepEqual(renderTemplate({ kind: 'blank' }, LETTER), []);
});

test('render: lined, college and wide rule, from 1 in down to the bottom, with a pink margin line', () => {
  for (const [rule, step] of [['college', 27], ['wide', 33]] as const) {
    for (const size of [LETTER, A4]) {
      const [lines, ...rest] = renderTemplate({ kind: 'lined', rule, margin: false }, size);
      assert.equal(rest.length, 0);
      assert.match(lines, /^<path class="t" fill="none" stroke-width="1" d="[^"]+"\/>$/);
      const segs = segments(lines);
      const ys = segs.filter(s => s[0] === 'M').map(s => s[1][1]);
      assert.ok(segs.every(([c, n], i) => (i % 2 ? c === 'H' && n[0] === size.width : c === 'M' && n[0] === 0)), 'full-width horizontal lines');
      assert.equal(ys[0], 96);
      assert.ok(ys.every((y, i) => i === 0 || y - ys[i - 1] === step));
      assert.ok(ys[ys.length - 1] < size.height && ys[ys.length - 1] + step >= size.height, 'down to the bottom');
    }
  }
  assert.equal(segments(renderTemplate({ kind: 'lined', rule: 'college', margin: false }, LETTER)[0]).length / 2, 36);
  assert.equal(segments(renderTemplate({ kind: 'lined', rule: 'wide', margin: false }, LETTER)[0]).length / 2, 30);
  const withMargin = renderTemplate({ kind: 'lined', rule: 'wide', margin: true }, A4);
  assert.equal(withMargin.length, 2);
  assert.equal(withMargin[1], '<path fill="none" stroke="#e8a0a0" stroke-width="1" d="M120 0V1123"/>');
});

test('render: grid lines from the page edges, 5 mm (18.9 px) and 1/4 in (24 px)', () => {
  for (const [spacing, step] of [['5mm', 18.9], ['1/4in', 24]] as const) {
    const out = renderTemplate({ kind: 'grid', spacing }, LETTER);
    assert.equal(out.length, 1);
    assert.match(out[0], /^<path class="t" fill="none" stroke-width="1" d="[^"]+"\/>$/);
    const segs = segments(out[0]);
    const ys: number[] = [], xs: number[] = [];
    for (let i = 0; i < segs.length; i += 2) {
      const [[, m], [c, n]] = [segs[i], segs[i + 1]];
      if (c === 'H') {
        assert.deepEqual([m[0], n[0]], [0, LETTER.width]);
        ys.push(m[1]);
      } else {
        assert.deepEqual([c, m[1], n[0]], ['V', 0, LETTER.height]);
        xs.push(m[0]);
      }
    }
    const expect = (end: number) => {
      const v: number[] = [];
      for (let k = 1; Math.round(k * step * 10) / 10 < end; k++) v.push(Math.round(k * step * 10) / 10);
      return v;
    };
    assert.deepEqual(ys, expect(LETTER.height));
    assert.deepEqual(xs, expect(LETTER.width));
    assert.ok(!/\d\.\d\d/.test(out[0]), 'one decimal at most');
  }
  assert.deepEqual(segments(renderTemplate({ kind: 'grid', spacing: '1/4in' }, LETTER)[0]).length / 2, 43 + 33);
  assert.deepEqual(segments(renderTemplate({ kind: 'grid', spacing: '5mm' }, LETTER)[0]).length / 2, 55 + 43);
});

test('render: dots at the 5 mm grid points, one spacing in, circles of two arcs (radius 0.5 px, 1 px stroke)', () => {
  const [el] = renderTemplate({ kind: 'dots', spacing: '5mm' }, LETTER);
  assert.match(el, /^<path class="t" fill="none" stroke-width="1" d="[^"]+"\/>$/);
  assert.ok(!el.includes('linecap') && !/[hHvV]0(?![.\d])/.test(el), 'no zero-length segments');
  assert.ok(!/\d\.\d\d/.test(el), 'one decimal at most');
  // Walk the path: each dot is two relative half-circle arcs from its left point and back.
  let x = 0, y = 0;
  const dots: [number, number][] = [];
  const segs = segments(el);
  for (let i = 0; i < segs.length; i++) {
    const [c, n] = segs[i];
    if (c === 'M') [x, y] = n;
    else if (c === 'm') { x += n[0]; y += n[1]; }
    else {
      assert.equal(c, 'a');
      assert.deepEqual([n, segs[i + 1]], [[0.5, 0.5, 0, 1, 0, 1, 0], ['a', [0.5, 0.5, 0, 1, 0, -1, 0]]]);
      dots.push([Math.round((x + 0.5) * 10) / 10, Math.round(y * 10) / 10]);
      i++;
    }
  }
  const xs = [...new Set(dots.map(d => d[0]))], ys = [...new Set(dots.map(d => d[1]))];
  assert.equal(dots.length, xs.length * ys.length);
  assert.deepEqual([xs[0], ys[0]], [18.9, 18.9]);
  assert.ok(xs.every((v, i) => i === 0 || Math.abs(v - xs[i - 1] - 18.9) < 0.01));
  assert.ok(xs[xs.length - 1] <= LETTER.width - 18.9 / 2 && ys[ys.length - 1] <= LETTER.height - 18.9 / 2);
  assert.deepEqual([xs.length, ys.length], [42, 55]);
});

test('render: deterministic, and every template writes and reads back in a page', () => {
  for (const b of BUILT_IN_TEMPLATES) {
    assert.deepEqual(renderTemplate(b.template, A4), renderTemplate(parseTemplate(JSON.parse(JSON.stringify(b.template))), A4));
    const page = newPage('p-0000aa', LETTER, b.template);
    const svg = writePage(page);
    assert.equal(writePage(readPage(svg)), svg);
    assert.deepEqual(readPage(svg).template, b.template);
    const layer = /<g id="template">([\s\S]*?)<\/g>/.exec(svg)![1];
    assert.equal(layer.trim(), renderTemplate(b.template, LETTER).join('\n'));
    // The <style> is the same for every template with paper that follows dark mode.
    if (b.template.kind === 'fill') continue;
    assert.match(svg, /<style>\.i\{fill:#1f1f1f\}\.t\{stroke:#c9c9c9\}@media \(prefers-color-scheme:dark\)\{\.i\{fill:#e6e3de\}\.t\{stroke:#3c3c3c\}\}<\/style>/);
  }
});

// ---- sized templates and the fill kind (#27)

test('fill: parses, renders a full-page rect of its colour, and has reversible names', () => {
  assert.deepEqual(parseTemplate({ kind: 'fill', color: '#FFF59D', extra: 1 }), { kind: 'fill', color: '#fff59d' });
  assert.throws(() => parseTemplate({ kind: 'fill', color: 'yellow' }), /fill color "yellow"/);
  assert.throws(() => parseTemplate({ kind: 'fill' }), /fill color/);
  assert.deepEqual(renderTemplate({ kind: 'fill', color: '#fff59d' }, { width: 288, height: 288 }),
    ['<rect x="0" y="0" width="288" height="288" fill="#fff59d"/>']);
  assert.equal(templateName({ kind: 'fill', color: STICKY_COLOR }), 'sticky-3in');
  assert.equal(templateName({ kind: 'fill', color: '#abcdef' }), 'fill-abcdef');
  assert.deepEqual(parseTemplateName('fill-abcdef'), { kind: 'fill', color: '#abcdef' });
  assert.ok(isTemplateName('fill-abcdef') && !isTemplateName('fill-xyz'));
  assert.equal(templateLabel({ kind: 'fill', color: '#abcdef' }), 'Colour #abcdef');
  assert.ok(fixedPaper({ kind: 'fill', color: '#abcdef' }) && fixedPaper({ kind: 'pdf', source: 'a.pdf', page: 1, image: '' }));
  assert.ok(!fixedPaper({ kind: 'blank' }));
  assert.ok(sameTemplate({ kind: 'pdf', source: 'a.pdf', page: 1, image: '' }, { kind: 'pdf', source: 'a.pdf', page: 1, image: 'data:image/png;base64,AA==' }));
  assert.ok(!sameTemplate({ kind: 'pdf', source: 'a.pdf', page: 1, image: '' }, { kind: 'pdf', source: 'b.pdf', page: 1, image: '' }));
});

test('sized built-ins: sticky note and index card carry their size; others have none', () => {
  assert.deepEqual(templateSize('sticky-3in'), { width: 288, height: 288 });
  assert.deepEqual(templateSize('index-card'), { width: 480, height: 288 });
  assert.equal(templateSize('lined-college'), null);
  assert.equal(templateSize('nope'), null);
  const s = templateSize('sticky-3in')!;
  s.width = 1;
  assert.equal(templateSize('sticky-3in')!.width, 288);
  assert.equal(templateLabel(parseTemplateName('sticky-3in')), 'Sticky note 3 × 3 in');
});

test('fill page: fixed colour, dark ink in both modes, reads back byte-stable', () => {
  const page = newPage('p-0000ab', { width: 288, height: 288 }, parseTemplateName('sticky-3in'));
  const svg = writePage(page);
  assert.ok(svg.includes('<style>.i{fill:#1f1f1f}.t{stroke:#c9c9c9}</style>'));
  assert.ok(!svg.includes('prefers-color-scheme'));
  assert.ok(svg.includes('viewBox="0 0 288 288"') && svg.includes('fill="#fff59d"'));
  assert.equal(writePage(readPage(svg)), svg);
  assert.deepEqual(readPage(svg).size, { width: 288, height: 288 });
});

// The PDF writer (#18): a one-page file parses (header, xref offsets, trailer, page tree,
// MediaBox), streams carry their Length, JPEGs are read for their size, output is deterministic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jpegInfo, num, PdfWriter, textString } from '../../src/format/pdf-writer';

const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };

/** A minimal JPEG header: SOI, an APP0 segment, SOF0 of w × h with 3 components, EOI. */
export function fakeJpeg(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

function build() {
  const w = new PdfWriter();
  const img = w.jpeg(fakeJpeg(300, 200));
  const gs = w.alpha(0.4);
  const form = w.form([0, 0, 816, 1056], { data: new TextEncoder().encode('0 0 1 rg 0 0 10 10 re f') }, {}, true);
  w.page(612, 792, { data: new TextEncoder().encode('q 0.75 0 0 -0.75 0 792 cm /Im0 Do /G gs /F Do Q') },
    { xobjects: { Im0: img.ref, F: form }, extGStates: { G: gs } });
  return { bytes: w.finish({ title: 'Lecture 3' }), img };
}

test('pdf writer: header, xref offsets at each object, trailer and page tree', () => {
  const { bytes } = build();
  const s = latin1(bytes);
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1]);
  assert.equal(s.slice(startxref, startxref + 5), 'xref\n');
  const [, first, count] = /^xref\n(\d+) (\d+)\n/.exec(s.slice(startxref))!.map(Number);
  assert.equal(first, 0);
  const rows = s.slice(startxref).split('\n').slice(2, 2 + count);
  assert.equal(rows[0], '0000000000 65535 f ');
  for (let n = 1; n < count; n++) {
    const off = Number(rows[n].slice(0, 10));
    assert.equal(s.slice(off, off + `${n} 0 obj`.length), `${n} 0 obj`, `object ${n}`);
  }
  const trailer = /trailer\n<< \/Size (\d+) \/Root (\d+) 0 R \/Info (\d+) 0 R >>/.exec(s)!;
  assert.equal(Number(trailer[1]), count);
  const root = Number(trailer[2]);
  const pagesRef = Number(new RegExp(`\\n${root} 0 obj\\n<< /Type /Catalog /Pages (\\d+) 0 R >>`).exec('\n' + s)![1]);
  assert.match(s, new RegExp(`${pagesRef} 0 obj\\n<< /Type /Pages /Kids \\[\\d+ 0 R\\] /Count 1 >>`));
  assert.match(s, /\/Type \/Page \/Parent \d+ 0 R \/MediaBox \[0 0 612 792\]/);
  assert.match(s, new RegExp(`/Title ${textString('Lecture 3')}`));
  assert.match(s, new RegExp(`/Producer ${textString('Notebook plugin')}`));
  assert.match(s, /\/Type \/ExtGState \/ca 0\.4 \/CA 0\.4/);
  assert.match(s, /\/Group << \/Type \/Group \/S \/Transparency \/I true \/K true >>/);
});

test('pdf writer: every stream Length matches its bytes; the image is stored unchanged', () => {
  const { bytes, img } = build();
  const s = latin1(bytes);
  const re = /\/Length (\d+) >>\nstream\n/g;
  let n = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index + m[0].length, len = Number(m[1]);
    assert.equal(s.slice(start + len, start + len + 10), '\nendstream');
    n++;
  }
  assert.equal(n, 3);
  assert.equal(img.width, 300);
  assert.equal(img.height, 200);
  assert.match(s, /\/Subtype \/Image \/Width 300 \/Height 200 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode \/Length 29 >>/);
  assert.ok(s.includes(latin1(fakeJpeg(300, 200))));
});

test('pdf writer: deterministic output', () => {
  assert.deepEqual([...build().bytes], [...build().bytes]);
});

test('pdf writer: numbers, text strings, JPEG info', () => {
  assert.equal(num(1 / 3), '0.333');
  assert.equal(num(-0.0001), '0');
  assert.equal(num(612), '612');
  assert.equal(num(1e6 + 0.00049), '1000000');
  assert.equal(num(-2.5), '-2.5');
  assert.equal(textString('Aé'), '<FEFF004100E9>');
  assert.deepEqual(jpegInfo(fakeJpeg(1, 65535)), { width: 1, height: 65535, components: 3 });
  assert.equal(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.throws(() => new PdfWriter().jpeg(new Uint8Array([1, 2, 3])), /Not a JPEG/);
});

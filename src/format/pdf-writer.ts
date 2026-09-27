// A tiny PDF 1.4 writer (#18), pure and dependency-free: numbered objects, content streams,
// JPEG image XObjects, ExtGStates, Form XObjects (transparency groups), pages, the xref table
// with byte offsets, and a trailer with /Info (Title, Producer). No fonts, no text. The output
// is deterministic: no dates or IDs unless given. Content streams are written raw unless the
// caller passes them already compressed (`deflate`, when the platform has CompressionStream).
//
// Numbers in content streams are written by `num`: at most 3 decimals, no exponent, no -0.

const enc = new TextEncoder();

/** A number for a PDF file: up to 3 decimals, never exponent notation or -0. */
export function num(n: number): string {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  if (r === 0) return '0';
  let s = r.toFixed(3);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** A PDF text string as UTF-16BE hex with a byte order mark (any Unicode title). */
export function textString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

export interface JpegInfo {
  width: number;
  height: number;
  /** 1 (gray), 3 (RGB) or 4 (CMYK). */
  components: number;
}

/** The size and components of a baseline or progressive JPEG, from its SOF marker; null if it isn't one. */
export function jpegInfo(b: Uint8Array): JpegInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 >= b.length) return null;
      const height = (b[i + 5] << 8) | b[i + 6], width = (b[i + 7] << 8) | b[i + 8], components = b[i + 9];
      return width > 0 && height > 0 && [1, 3, 4].includes(components) ? { width, height, components } : null;
    }
    if (m === 0xda || m === 0xd9) return null; // scan data before any SOF
    i += 2 + len;
  }
  return null;
}

/** Deflates bytes (zlib format, as /FlateDecode wants) with CompressionStream, or null where there's none. */
export async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS || typeof Response === 'undefined' || typeof Blob === 'undefined') return null;
  try {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CS('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A content stream's bytes and, if compressed, its filter. */
export interface Content {
  data: Uint8Array;
  filter?: 'FlateDecode';
}

/** Resources of a page or form: names (without `/`) to object numbers. */
export interface Resources {
  xobjects?: Record<string, number>;
  extGStates?: Record<string, number>;
}

function resourceDict(r: Resources): string {
  const part = (key: string, m?: Record<string, number>) => {
    const names = m ? Object.keys(m) : [];
    return names.length ? `/${key} << ${names.map(n => `/${n} ${m![n]} 0 R`).join(' ')} >> ` : '';
  };
  return `<< /ProcSet [/PDF /ImageC /ImageB] ${part('XObject', r.xobjects)}${part('ExtGState', r.extGStates)}>>`;
}

export class PdfWriter {
  /** Object bodies by number (index 0 unused); null while reserved. */
  private objects: (Uint8Array[] | null)[] = [null];
  private pageRefs: number[] = [];
  private readonly pagesRef: number;
  private readonly catalogRef: number;
  private gstates = new Map<string, number>();

  constructor() {
    this.catalogRef = this.reserve();
    this.pagesRef = this.reserve();
  }

  /** A new object number, to be filled with `set`. */
  reserve(): number {
    this.objects.push(null);
    return this.objects.length - 1;
  }

  /** Object `n`'s body: a dictionary (or any object), and a stream whose /Length is added to it. */
  set(n: number, dict: string, stream?: Uint8Array): number {
    if (!stream) {
      this.objects[n] = [enc.encode(`${n} 0 obj\n${dict}\nendobj\n`)];
      return n;
    }
    const d = dict.replace(/>>\s*$/, `/Length ${stream.length} >>`);
    this.objects[n] = [enc.encode(`${n} 0 obj\n${d}\nstream\n`), stream, enc.encode('\nendstream\nendobj\n')];
    return n;
  }

  add(dict: string, stream?: Uint8Array): number {
    return this.set(this.reserve(), dict, stream);
  }

  /** A JPEG as an Image XObject at its own pixel size (DCTDecode, the bytes unchanged). Throws if it isn't a JPEG. */
  jpeg(bytes: Uint8Array): { ref: number; width: number; height: number } {
    const info = jpegInfo(bytes);
    if (!info) throw new Error('Not a JPEG image');
    const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
    const ref = this.add(`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode >>`, bytes);
    return { ref, width: info.width, height: info.height };
  }

  /** An ExtGState with this constant fill and stroke alpha (one object per alpha). */
  alpha(ca: number): number {
    const key = num(ca);
    let ref = this.gstates.get(key);
    if (!ref) {
      ref = this.add(`<< /Type /ExtGState /ca ${key} /CA ${key} >>`);
      this.gstates.set(key, ref);
    }
    return ref;
  }

  /**
   * A Form XObject over `bbox` ([x0, y0, x1, y1] in the space it's drawn in). With `group`, it's
   * an isolated knockout transparency group: its contents are composited together first, then
   * onto the page once, with the alpha in effect where it's drawn.
   */
  form(bbox: readonly number[], content: Content, resources: Resources = {}, group = false): number {
    const g = group ? '/Group << /Type /Group /S /Transparency /I true /K true >> ' : '';
    const filter = content.filter ? `/Filter /${content.filter} ` : '';
    return this.add(`<< /Type /XObject /Subtype /Form /BBox [${bbox.map(num).join(' ')}] ${g}/Resources ${resourceDict(resources)} ${filter}>>`, content.data);
  }

  /** A page of `width` × `height` points drawing `content`. Pages are in the order added. */
  page(width: number, height: number, content: Content, resources: Resources = {}): number {
    const filter = content.filter ? `/Filter /${content.filter} ` : '';
    const contents = this.add(`<< ${filter}>>`, content.data);
    const ref = this.add(`<< /Type /Page /Parent ${this.pagesRef} 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] ` +
      `/Resources ${resourceDict(resources)} /Contents ${contents} 0 R >>`);
    this.pageRefs.push(ref);
    return ref;
  }

  get pageCount(): number {
    return this.pageRefs.length;
  }

  /** The finished file. Throws if an object was reserved and never set. */
  finish(info: { title?: string; producer?: string } = {}): Uint8Array {
    this.set(this.pagesRef, `<< /Type /Pages /Kids [${this.pageRefs.map(r => `${r} 0 R`).join(' ')}] /Count ${this.pageRefs.length} >>`);
    this.set(this.catalogRef, `<< /Type /Catalog /Pages ${this.pagesRef} 0 R >>`);
    const infoFields = [info.title !== undefined ? `/Title ${textString(info.title)}` : '', `/Producer ${textString(info.producer ?? 'Notebook plugin')}`];
    const infoRef = this.add(`<< ${infoFields.filter(Boolean).join(' ')} >>`);

    // Header with a binary comment, so tools treat the file as binary.
    const chunks: Uint8Array[] = [enc.encode('%PDF-1.4\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
    let offset = chunks[0].length + chunks[1].length;
    const offsets: number[] = [0];
    for (let n = 1; n < this.objects.length; n++) {
      const body = this.objects[n];
      if (!body) throw new Error(`PDF object ${n} was never written`);
      offsets.push(offset);
      for (const c of body) { chunks.push(c); offset += c.length; }
    }
    const size = this.objects.length;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${size} /Root ${this.catalogRef} 0 R /Info ${infoRef} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(enc.encode(xref));

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

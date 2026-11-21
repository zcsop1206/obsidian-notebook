// Draws a circuit from its grid layout (circuits.mjs) as an SVG string. Colours come from CSS classes:
// sch-w (wires and bodies), sch-t (text), sch-p (the probe), sch-m (control marks). Written by a model.
import { UNIT } from './circuits.mjs';

const U = 60; // px per grid unit
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** SI formatting: 3 significant figures, trailing zeros dropped. */
export function si(x, unit = '') {
  if (x === 0) return `0 ${unit}`.trim();
  const P = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
  const a = Math.abs(x);
  const [m, p] = P.find(([m]) => a >= m * 0.9995) || P[P.length - 1];
  const v = +(x / m).toPrecision(3);
  return `${v} ${p}${unit}`.trim();
}

/** Subscript after the first underscore: v_C -> v<tspan>C</tspan>. */
const sub = (name) => {
  const i = name.indexOf('_');
  if (i < 0) return esc(name);
  return `${esc(name.slice(0, i))}<tspan class="sch-sub" dy="3">${esc(name.slice(i + 1))}</tspan><tspan dy="-3"></tspan>`;
};

// Bodies in local coordinates: along +x from -hl to hl, centred on the part.
const BODY = {
  R: { hl: 18, d: 'M-18 0 L-15 -6 L-9 6 L-3 -6 L3 6 L9 -6 L15 6 L18 0' },
  C: { hl: 4, d: 'M-4 -12 V12 M4 -12 V12' },
  L: { hl: 20, d: 'M-20 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0' },
  V: { hl: 15, circle: true },
  I: { hl: 15, circle: true, arrow: true },
  E: { hl: 15, diamond: true },
  H: { hl: 15, diamond: true },
  G: { hl: 15, diamond: true, arrow: true },
  F: { hl: 15, diamond: true, arrow: true },
};

function valueLabel(part, k, vals, ac) {
  const v = vals[part.n];
  if (k === 'V' && ac) return `${si(v, 'V')} peak`;
  if (k === 'H' || k === 'E') return `${+v.toPrecision(3)}${k === 'H' ? ' Ω' : ''}·${part.gain}`;
  if (k === 'F' || k === 'G') return `${+v.toPrecision(3)}${k === 'G' ? ' S' : ''}·${part.gain}`;
  return si(v, UNIT[k]);
}

export function schematicSVG(spec, vals, { ac = false } = {}) {
  const sch = spec.sch;
  const pts = [];
  const g = [];
  const W = (p) => { pts.push(p); return p; };
  const xy = ([x, y]) => W([x * U, y * U]);
  const line = (a, b, cls = 'sch-w') => `<line class="${cls}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  const text = (p, s, anchor = 'middle', cls = 'sch-t') => {
    const wd = String(s).replace(/<[^>]*>/g, '').length * 8.2 + 4;
    const x0 = anchor === 'start' ? p[0] : anchor === 'end' ? p[0] - wd : p[0] - wd / 2;
    W([x0, p[1] - 13]); W([x0 + wd, p[1] + 5]);
    return `<text class="${cls}" x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" text-anchor="${anchor}">${s}</text>`; };
  const arrowHead = (tip, d, cls) => {
    const n = [-d[1], d[0]];
    const a = [tip[0] - d[0] * 7 + n[0] * 4, tip[1] - d[1] * 7 + n[1] * 4];
    const b = [tip[0] - d[0] * 7 - n[0] * 4, tip[1] - d[1] * 7 - n[1] * 4];
    return `<path class="${cls} fill" d="M${tip[0]} ${tip[1]} L${a[0]} ${a[1]} L${b[0]} ${b[1]} Z"/>`;
  };

  for (const w of sch.wires || []) {
    const p = w.map(xy);
    g.push(`<polyline class="sch-w" points="${p.map((q) => q.join(',')).join(' ')}"/>`);
  }

  const probe = spec.probe || spec.out;
  for (const part of sch.parts) {
    if (part.spdt) { g.push(spdt(part)); continue; }
    if (part.opamp) { g.push(opamp(part)); continue; }
    const k = part.n[0];
    const a = xy(part.a), b = xy(part.b);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const ang = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
    const vertical = Math.abs(d[0]) < 0.5;
    const side = part.side || (vertical ? 'r' : 't');
    // Unit normal toward the label side, and toward the other side for probes and marks.
    const nl = side === 'r' ? [1, 0] : side === 'l' ? [-1, 0] : side === 't' ? [0, -1] : [0, 1];
    const no = [-nl[0], -nl[1]];

    if (k === 'S') {
      const hl = 14;
      g.push(line(a, [c[0] - d[0] * hl, c[1] - d[1] * hl]), line([c[0] + d[0] * hl, c[1] + d[1] * hl], b));
      const body = [];
      body.push('<circle class="sch-w fillbg" cx="-12" cy="0" r="2.6"/><circle class="sch-w fillbg" cx="12" cy="0" r="2.6"/>');
      if (part.sw === 'close') body.push('<line class="sch-w" x1="-10" y1="-1" x2="9" y2="-13"/><path class="sch-m" d="M12 -15 Q16 -9 13 -4"/><path class="sch-m fill" d="M13 -3 L10 -8 L15.5 -7 Z"/>');
      else body.push('<line class="sch-w" x1="-10" y1="-1" x2="11" y2="-2"/><path class="sch-m" d="M3 -5 Q6 -14 13 -16"/><path class="sch-m fill" d="M14 -16.5 L8.5 -19 L9.5 -13.5 Z"/>');
      // Local -y is drawn toward the label side for horizontal switches (top), right for vertical ones.
      g.push(`<g transform="translate(${c[0]} ${c[1]}) rotate(${ang})">${body.join('')}</g>`);
      g.push(text([c[0] + no[0] * 16, c[1] + no[1] * 16 + 8], 't = 0', 'middle', 'sch-t small'));
      continue;
    }

    const B = BODY[k];
    g.push(line(a, [c[0] - d[0] * B.hl, c[1] - d[1] * B.hl]), line([c[0] + d[0] * B.hl, c[1] + d[1] * B.hl], b));
    const body = [];
    if (B.d) body.push(`<path class="sch-w" d="${B.d}"/>`);
    if (B.circle) body.push('<circle class="sch-w fillbg" cx="0" cy="0" r="15"/>');
    if (B.diamond) body.push('<path class="sch-w fillbg" d="M-15 0 L0 -15 L15 0 L0 15 Z"/>');
    if (B.arrow) body.push('<path class="sch-w" d="M-8 0 H6"/><path class="sch-w fill" d="M9 0 L3 -4 L3 4 Z"/>');
    g.push(`<g transform="translate(${c[0]} ${c[1]}) rotate(${ang})">${body.join('')}</g>`);
    if ((k === 'V' && !ac) || k === 'E' || k === 'H') {
      g.push(text([c[0] - d[0] * 7, c[1] - d[1] * 7 + 4], '+', 'middle', 'sch-t sign'));
      g.push(text([c[0] + d[0] * 7, c[1] + d[1] * 7 + 4], '−', 'middle', 'sch-t sign'));
    }
    if (k === 'V' && ac) {
      g.push(`<path class="sch-w" d="M${c[0] - 8} ${c[1]} q4 -9 8 0 t8 0"/>`);
      g.push(text([c[0] - d[0] * 24 + no[0] * 2, c[1] - d[1] * 24 + 4], '+', 'middle', 'sch-t sign'));
    }

    // Name and value on the label side.
    const off = vertical ? 22 : 18;
    const lp = [c[0] + nl[0] * off, c[1] + nl[1] * off];
    const anchor = side === 'r' ? 'start' : side === 'l' ? 'end' : 'middle';
    const raw = valueLabel(part, k, vals, ac);
    const value = part.gain ? esc(raw.slice(0, -part.gain.length)) + sub(part.gain) : esc(raw);
    if (vertical) { g.push(text([lp[0], lp[1] - 2], sub(part.n), anchor, 'sch-t name')); g.push(text([lp[0], lp[1] + 13], value, anchor)); }
    else if (side === 't') { g.push(text([lp[0], lp[1] - 14], sub(part.n), anchor, 'sch-t name')); g.push(text([lp[0], lp[1] - 1], value, anchor)); }
    else { g.push(text([lp[0], lp[1] + 10], sub(part.n), anchor, 'sch-t name')); g.push(text([lp[0], lp[1] + 23], value, anchor)); }

    // The probe (accent) or a control mark (muted), on the other side.
    const marks = [];
    if (probe && probe.el === part.n) marks.push({ ...probe, cls: 'sch-p' });
    if (part.mark) marks.push({ ...part.mark, cls: 'sch-m' });
    for (const m of marks) {
      if (m.kind === 'v') {
        const o = vertical ? 11 : 11;
        g.push(text([a[0] + d[0] * (len / 2 - B.hl - 6) + no[0] * o, a[1] + d[1] * (len / 2 - B.hl - 6) + no[1] * o + 5], '+', 'middle', `${m.cls} sign`));
        g.push(text([b[0] - d[0] * (len / 2 - B.hl - 6) + no[0] * o, b[1] - d[1] * (len / 2 - B.hl - 6) + no[1] * o + 5], '−', 'middle', `${m.cls} sign`));
        const np = [c[0] + no[0] * (vertical ? 22 : 22), c[1] + no[1] * (vertical ? 22 : 22) + 4];
        g.push(text(np, sub(m.name), vertical ? (no[0] > 0 ? 'start' : 'end') : 'middle', `${m.cls} name`));
      } else {
        const o = vertical ? 16 : 15;
        const s0 = [c[0] - d[0] * 12 + no[0] * o, c[1] - d[1] * 12 + no[1] * o];
        const s1 = [c[0] + d[0] * 12 + no[0] * o, c[1] + d[1] * 12 + no[1] * o];
        g.push(line(s0, s1, m.cls), arrowHead(s1, d, m.cls));
        const np = vertical ? [s0[0] + no[0] * 6, (s0[1] + s1[1]) / 2 + 4] : [(s0[0] + s1[0]) / 2, s0[1] + no[1] * 9 + (no[1] > 0 ? 4 : 0)];
        g.push(text(np, sub(m.name), vertical ? (no[0] > 0 ? 'start' : 'end') : 'middle', `${m.cls} name`));
      }
    }
  }

  function spdt(part) {
    const p = xy(part.p), c1 = xy(part.c1), c2 = xy(part.c2);
    const toward = (q, r) => { const L = Math.hypot(q[0] - p[0], q[1] - p[1]); return [p[0] + ((q[0] - p[0]) * (L - r)) / L, p[1] + ((q[1] - p[1]) * (L - r)) / L]; };
    const out = [];
    out.push(`<circle class="sch-w fill" cx="${p[0]}" cy="${p[1]}" r="2.6"/>`);
    out.push(`<circle class="sch-w fillbg" cx="${c1[0]}" cy="${c1[1]}" r="2.6"/>`, `<circle class="sch-w fillbg" cx="${c2[0]}" cy="${c2[1]}" r="2.6"/>`);
    out.push(line(p, toward(c1, 3)));
    // Arc from near contact 1 to near contact 2, bulging away from the pivot.
    const m = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
    const away = [m[0] - p[0], m[1] - p[1]]; const al = Math.hypot(...away);
    const ctl = [m[0] + (away[0] / al) * 22, m[1] + (away[1] / al) * 22];
    const e1 = [c1[0] + (ctl[0] - c1[0]) * 0.35, c1[1] + (ctl[1] - c1[1]) * 0.35];
    const e2 = [c2[0] + (ctl[0] - c2[0]) * 0.35, c2[1] + (ctl[1] - c2[1]) * 0.35];
    out.push(`<path class="sch-m" d="M${e1[0]} ${e1[1]} Q${ctl[0]} ${ctl[1]} ${e2[0]} ${e2[1]}"/>`);
    const td = [e2[0] - ctl[0], e2[1] - ctl[1]]; const tl = Math.hypot(...td);
    out.push(arrowHead(e2, [td[0] / tl, td[1] / tl], 'sch-m'));
    out.push(text([ctl[0] + (away[0] / al) * 12, ctl[1] + (away[1] / al) * 12 + 4], 't = 0', away[0] < -0.5 * al ? 'end' : away[0] > 0.5 * al ? 'start' : 'middle', 'sch-t small'));
    return out.join('');
  }

  function opamp(part) {
    const [x, y] = part.at;
    const L = xy([x - 0.5, y - 0.5]), Lb = xy([x - 0.5, y + 0.5]), R = xy([x + 0.5, y]);
    const out = [`<path class="sch-w fillbg" d="M${L[0]} ${L[1]} L${R[0]} ${R[1]} L${Lb[0]} ${Lb[1]} Z"/>`];
    const im = xy([x - 0.5, y - 0.25]), ip = xy([x - 0.5, y + 0.25]);
    out.push(text([im[0] + 8, im[1] + 4], '−', 'middle', 'sch-t sign'), text([ip[0] + 8, ip[1] + 5], '+', 'middle', 'sch-t sign'));
    return out.join('');
  }

  for (const p of sch.dots || []) { const q = xy(p); g.push(`<circle class="sch-w fill" cx="${q[0]}" cy="${q[1]}" r="3"/>`); }
  for (const p of sch.gnd || []) {
    const [x, y] = xy(p); W([x, y + 18]);
    g.push(`<path class="sch-w" d="M${x} ${y} v8 M${x - 10} ${y + 8} h20 M${x - 6} ${y + 12} h12 M${x - 2.5} ${y + 16} h5"/>`);
  }
  for (const t of sch.terminals || []) {
    const q = xy(t.at);
    g.push(`<circle class="sch-p fillbg" cx="${q[0]}" cy="${q[1]}" r="3.5"/>`);
    g.push(text([q[0], q[1] - 10], sub(t.name), 'middle', 'sch-p name'));
  }

  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const pad = 6;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - x0 + pad, h = Math.max(...ys) - y0 + pad;
  return `<svg class="sch" viewBox="${x0.toFixed(0)} ${y0.toFixed(0)} ${w.toFixed(0)} ${h.toFixed(0)}" width="${w.toFixed(0)}" role="img" aria-label="${esc(spec.title)}">${g.join('')}</svg>`;
}

/* block-drill.js: the blank-page drill, ported from lab/blank-drill.
   SR.drill.run(el, spec) puts a drill in el: the statement to prove, Start, a running clock, a ruled
   blank page for the Pencil or a mouse (fingers scroll), Undo and More paper, and Done, which unlocks
   after 3 strokes and only then shows the model's steps. Give up (two taps) also needs those 3 strokes
   (attempt before reveal); it shows the steps and counts as failed. A live attempt follows its proof
   into another build of the doc (SR.drill.carry). A self-grade (clean / shaky / failed) goes to engine.recordDrill; the stage ladder shows
   the move and the next due day. The attempt replays (play/pause, 1x/4x/16x, seek on the timeline) with
   stalls over 30 s marked on the timeline and as clock badges on the page, a time map colours strokes
   early to late, and stats give total, inking and the longest stall with the step it came before (a
   guess from where the next stroke sits on the page).
   SR.drill.open(fogOrBasic) opens the same in a sheet. SR.blocks.register('drill') mounts it inside a
   doc for <div class="blk" data-block="drill" data-id="FOG-ID or BASIC-ID">. block-fog.js calls
   SR.drill.run at push level 2. Attempts persist in SR.store under 'drill-<fog id>'; every view of the
   same drill shares one attempt. Written by a model for Adit. Not Adit's words. */
(function () {
  'use strict';
  var SR = window.SR = window.SR || {};
  var HAS = Object.prototype.hasOwnProperty;

  var W = 800;                 // paper width in paper units, as every SR.ink page
  var STALL = 30000;           // a gap over 30 s with no ink is a stall
  var MIN_STROKES = 3;         // Done unlocks after this many strokes: attempt before reveal
  var H_PAGE = 1000, H_IDLE = 300, H_MORE = 500, H_MAX = 4000;
  var DAY = 864e5, HIST_MAX = 8, SPEEDS = [1, 4, 16];
  var INTERVALS_DEFAULT = [1, 2, 4, 7, 14, 30];   /* the engine's constants.INTERVALS, for the ladder labels */
  var GRADES = ['clean', 'shaky', 'failed'];
  var PUSH_TEXT = ['fog lifted step by step', 'fog lifted in two chunks', 'blank-page drills', 'problem-first hooks'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LABEL_MODEL = "Written by a model for Adit. Not Adit's words.";
  var CLOCK = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  /* ---------- small helpers ---------- */
  function esc(s) {
    if (SR.esc) return SR.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dur(ms) {
    var s = Math.floor(Math.max(0, ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    s %= 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }
  function ymd(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function validDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function dayNum(s) { var a = String(s).split('-'); return Math.round(Date.UTC(+a[0], +a[1] - 1, +a[2]) / DAY); }
  function dayDiff(a, b) { return dayNum(a) - dayNum(b); }
  function dayLabel(s) { var a = String(s).split('-'), d = new Date(+a[0], +a[1] - 1, +a[2]); return WD[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate(); }
  function shortDay(s) { var a = String(s).split('-'); return MON[(+a[1] - 1 + 12) % 12] + ' ' + (+a[2]); }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x'; }
  function copy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function store() { return SR.store; }
  function emit(evt, data) { if (SR.bus) SR.bus.emit(evt, data); }
  /* core.js queues typesets until MathJax is ready and drops an element whose ancestor is in the same
     batch, so a drill inside a doc may typeset at any time. */
  function typeset(el) { if (el && typeof SR.typeset === 'function') SR.typeset(el); }

  /* ---------- content ---------- */
  function content() { return SR.content || {}; }
  function fogs() { return content().fog || {}; }
  function docOf(id) { var d = content().docs || {}; return id && HAS.call(d, id) ? d[id] : null; }
  function docTitle(id) { var d = docOf(id); return d && d.title ? String(d.title) : String(id || ''); }
  /* The build of a doc on screen: the reader's answer first (it knows which builds exist), then the engine. */
  function buildOf(docId) {
    var v = 0;
    try { if (SR.reader && typeof SR.reader.version === 'function') v = +SR.reader.version(docId) || 0; } catch (e) { v = 0; }
    if (!(v > 0) && SR.engine && typeof SR.engine.docVersion === 'function') {
      try { v = +SR.engine.docVersion(docId) || 0; } catch (e2) { v = 0; }
    }
    return v > 0 ? v : 1;
  }
  /* The same proof in the build currently shown (nt-units build 2 has its own fog ids). */
  function currentFog(id) {
    var F = fogs(), f = F[id];
    if (!f) return id;
    var cur = buildOf(f.doc);
    if ((f.version || 1) === cur) return id;
    var ids = Object.keys(F);
    for (var i = 0; i < ids.length; i++) {
      var g = F[ids[i]];
      if (g && g.doc === f.doc && g.anchor === f.anchor && (g.version || 1) === cur) return ids[i];
    }
    return id;
  }
  /* The proofs a basic's own doc carries in its current build (else any fog resting on it). */
  function proofsOf(basic) {
    var F = fogs(), out = [], b = buildOf(basic);
    Object.keys(F).forEach(function (id) {
      var f = F[id];
      if (f && f.basic === basic && f.doc === basic && Array.isArray(f.steps) && (f.version || 1) === b) out.push(id);
    });
    if (!out.length) Object.keys(F).forEach(function (id) { var f = F[id]; if (f && f.basic === basic && Array.isArray(f.steps)) out.push(id); });
    return out;
  }
  function normSteps(steps) {
    return (Array.isArray(steps) ? steps : []).map(function (s) {
      if (typeof s === 'string') return { html: s, topic: '' };
      s = s || {};
      return { html: String(s.html != null ? s.html : s.tex != null ? s.tex : ''), topic: String(s.topic || s.label || s.short || '') };
    });
  }
  function keyFor(fogId, basic, title) { return 'drill-' + (fogId || ((basic || 'drill') + '-' + slug(title))); }

  /* ---------- engine.js keeps stages, due days and push levels; without it a grade is not recorded ---------- */
  function eng() { var e = SR.engine; return e && typeof e.recordDrill === 'function' ? e : null; }
  function ecall(fn) {
    var e = eng();
    if (!e || typeof e[fn] !== 'function') return undefined;
    try { return e[fn].apply(e, [].slice.call(arguments, 1)); }
    catch (er) { console.error('[SR] engine.' + fn + ' failed:', er); return undefined; }
  }
  function intervals() {
    var e = eng(), c = e && e.constants;
    return c && Array.isArray(c.INTERVALS) && c.INTERVALS.length === 6 ? c.INTERVALS : INTERVALS_DEFAULT;
  }
  function today() { var t = ecall('today'); return validDay(t) ? t : ymd(Date.now()); }
  function stageOf(b) { return b ? clamp(Math.round(+ecall('stage', b) || 0), 0, 5) : 0; }
  /* The interval a stage would get now, with the engine's cap near a deadline: max(1, floor(days_left / 3)). */
  function cappedIv(stage, dl) {
    var iv = intervals()[clamp(stage, 0, 5)];
    if (dl && typeof dl.daysLeft === 'number' && isFinite(dl.daysLeft)) iv = Math.min(iv, Math.max(1, Math.floor(Math.max(0, dl.daysLeft) / 3)));
    return iv;
  }
  function dueText(due, td) {
    var d = dayDiff(due, td);
    if (d === 0) return 'due today';
    if (d < 0) return 'overdue ' + (-d) + ' d';
    return 'due ' + dayLabel(due) + ' (in ' + d + ' d)';
  }
  function deadlineText(dl) {
    if (!dl || !validDay(dl.date)) return '';
    var lab = String(dl.label || dl.id || '');
    if (dl.source === 'task') lab = 'task “' + (lab.length > 36 ? lab.slice(0, 35).replace(/[\s,:;]+$/, '') + '…' : lab) + '”';
    return lab + ' ' + (dl.daysLeft === 0 ? 'today' : 'in ' + dl.daysLeft + ' d');
  }

  /* ---------- attempts: one shared model per storage key ---------- */
  var models = Object.create(null);
  function validAtt(a) { return !!a && typeof a === 'object' && typeof a.start === 'number' && Array.isArray(a.strokes); }
  function model(key) {
    var m = models[key];
    if (m) return m;
    var a = store().get(key, null);
    if (!validAtt(a)) a = null;
    else a.strokes = a.strokes.filter(function (s) { return s && Array.isArray(s.p); });
    m = models[key] = { key: key, att: a, subs: [] };
    return m;
  }
  function peekAtt(key) { var m = models[key]; if (m) return m.att; var a = store().get(key, null); return validAtt(a) ? a : null; }
  function persist(m) { if (m.att) store().set(m.key, m.att); else store().del(m.key); }
  function notify(m, from) { m.subs.slice().forEach(function (inst) { if (inst !== from) inst.sync(); }); }
  /* The same proof in the other builds of its doc (same doc and anchor, another fog id). */
  function siblingFogs(fogId) {
    var F = fogs(), f = F[fogId], out = [];
    if (!f) return out;
    Object.keys(F).forEach(function (id) { var g = F[id]; if (id !== fogId && g && g.doc === f.doc && g.anchor === f.anchor) out.push(id); });
    return out;
  }
  /* A rebuild switches a doc's build while a blank-page attempt on one of its proofs may be running. That
     live attempt (its ink and its clock) moves to the same proof in the build now shown: one attempt, one
     clock. Finished attempts stay where they are. Returns the attempt now under this proof's key, or null. */
  function carry(fogId) {
    if (!fogId || !fogs()[fogId]) return null;
    var key = keyFor(fogId), here = peekAtt(key);
    if (here) return here;
    var sib = siblingFogs(fogId);
    for (var i = 0; i < sib.length; i++) {
      var k2 = keyFor(sib[i]), a = peekAtt(k2);
      if (!a || a.end != null) continue;
      var moved = copy(a);
      moved.fogId = fogId;
      moved.carriedFrom = sib[i];
      var to = model(key), from = model(k2);
      to.att = moved; persist(to);
      from.att = null; persist(from);
      notify(from, null); notify(to, null);
      if (!from.subs.length) delete models[k2];
      if (!to.subs.length) delete models[key];
      return moved;
    }
    return null;
  }
  function histAll() { var h = store().get('drill-hist', {}); return h && typeof h === 'object' ? h : {}; }
  function histOf(key) { var h = histAll()[key]; return Array.isArray(h) ? h : []; }
  function histPush(key, e) {
    var h = histAll(), l = Array.isArray(h[key]) ? h[key] : [];
    l.push(e);
    if (l.length > HIST_MAX) l.splice(0, l.length - HIST_MAX);
    h[key] = l;
    store().set('drill-hist', h);
  }

  /* ---------- analysis: stalls, inking, and a guess at the step a stall came before ----------
     Times are ms from Start. A stroke's points carry ms since its own pen-down (t0, epoch ms). The step
     guess cuts the inked part of the page into one band per model step, top to bottom, and takes the
     band of the stroke after the stall. It never reads the ink itself. */
  function strokeSpan(s, start) {
    var p = s.p, base = (typeof s.t0 === 'number' ? s.t0 : start) - start;
    var t0 = Math.max(0, base + (+p[0][3] || 0));
    return { t0: t0, t1: Math.max(t0, base + (+p[p.length - 1][3] || 0)) };
  }
  function analyse(att, nSteps) {
    var ss = (att && att.strokes) || [], tot = Math.max(0, +att.end || 0), N = Math.max(1, nSteps | 0);
    var stalls = [], spans = [], ys = [], prev = 0, inking = 0, i;
    for (i = 0; i < ss.length; i++) {
      var s = ss[i];
      if (!s || !s.p || !s.p.length) { spans.push(null); ys.push(null); continue; }
      var sp = strokeSpan(s, att.start);
      spans.push(sp);
      if (sp.t0 - prev > STALL) stalls.push({ from: prev, to: sp.t0, next: i });
      prev = Math.max(prev, sp.t1);
      inking += sp.t1 - sp.t0;
      var sum = 0;
      for (var j = 0; j < s.p.length; j++) sum += s.p[j][1];
      ys.push(sum / s.p.length);
    }
    if (tot - prev > STALL) stalls.push({ from: prev, to: tot, next: -1 });
    var known = ys.filter(function (y) { return y != null; });
    var lo = Math.min.apply(null, known.concat([Infinity])), hi = Math.max.apply(null, known.concat([-Infinity]));
    function band(y) { return y == null || !(hi > lo) ? 0 : Math.min(N - 1, Math.floor((y - lo) / (hi - lo) * N)); }
    var lastInk = -1;
    for (i = ss.length - 1; i >= 0; i--) if (ys[i] != null) { lastInk = i; break; }
    stalls.forEach(function (st) {
      if (st.next >= 0) { var p0 = ss[st.next].p[0]; st.x = p0[0]; st.y = p0[1]; st.step = band(ys[st.next]); }
      else st.step = lastInk >= 0 ? band(ys[lastInk]) : 0;
    });
    var longest = null;
    stalls.forEach(function (st) { if (!longest || st.to - st.from > longest.to - longest.from) longest = st; });
    return { total: tot, inking: inking, strokes: known.length, stalls: stalls, spans: spans, longest: longest, steps: N };
  }
  /* The strokes as they stood at time T (ms from Start): later strokes left out, the one being written cut. */
  function frameList(att, T) {
    var out = [], ss = att.strokes;
    for (var i = 0; i < ss.length; i++) {
      var s = ss[i];
      if (!s || !s.p || !s.p.length) continue;
      var base = (typeof s.t0 === 'number' ? s.t0 : att.start) - att.start, p = s.p;
      if (base + (+p[0][3] || 0) > T) continue;
      if (base + (+p[p.length - 1][3] || 0) <= T) { out.push(s); continue; }
      var n = 1;
      while (n < p.length && base + (+p[n][3] || 0) <= T) n++;
      out.push({ p: p.slice(0, n), t0: s.t0 });
    }
    return out;
  }

  /* ---------- time-map colours: accent (early) -> after -> warn (late) ---------- */
  var pal = null, palT = 0;
  function rgbOf(c) {
    c = String(c || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (m) {
      var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1], n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function palette() {
    var now = Date.now();
    if (!pal || now - palT > 400) {
      pal = [rgbOf(SR.css('--accent')) || [47, 95, 208], rgbOf(SR.css('--after')) || [138, 63, 252], rgbOf(SR.css('--warn')) || [183, 121, 31]];
      palT = now;
    }
    return pal;
  }
  function ramp(f) {
    f = clamp(isFinite(f) ? f : 0, 0, 1);
    var P = palette(), a, b, u;
    if (f < 0.5) { a = P[0]; b = P[1]; u = f * 2; } else { a = P[1]; b = P[2]; u = (f - 0.5) * 2; }
    return 'rgb(' + a.map(function (v, i) { return Math.round(v + (b[i] - v) * u); }).join(',') + ')';
  }
  function ruled(ctx, w, h) {
    ctx.strokeStyle = SR.css('--line') || '#d9d4ca';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var y = 44; y < h; y += 44) { ctx.moveTo(14, y); ctx.lineTo(w - 14, y); }
    ctx.stroke();
  }

  /* ---------- styles (every rule starts with .drl so it beats the .page rules in base.css) ---------- */
  var CSS = [
    '.drl{font:14px/1.45 var(--ui);color:var(--text);margin:4px 0;text-align:left}',
    '.drl .drl-kick{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}',
    '.drl .drl-title{font:600 18px/1.3 var(--serif);margin:3px 0 2px}',
    '.drl .drl-meta{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;color:var(--muted);font-size:13px;margin-top:3px}',
    '.drl .drl-chip{font:12px var(--mono);border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--text)}',
    '.drl .drl-sw{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:10px 0 2px}',
    '.drl .drl-sw button{display:flex;flex-direction:column;align-items:flex-start;text-align:left;line-height:1.25;max-width:230px;padding:5px 10px}',
    '.drl .drl-sw small{font-size:11px;color:var(--muted)}',
    '.drl .drl-stmt{font:17px/1.55 var(--serif);margin:10px 0 4px;padding:8px 14px;border-left:3px solid var(--accent);background:var(--tint)}',
    '.drl .drl-stmt b{font-weight:600}',
    '.drl .drl-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 8px;padding:6px 0}',
    '.drl.sheet .drl-bar{position:sticky;top:-12px;z-index:4;background:var(--bg);border-bottom:1px solid var(--line)}',
    '.drl .drl-timer{font:600 22px/1 var(--ui);font-variant-numeric:tabular-nums;min-width:4.4ch}',
    '.drl .drl-status{color:var(--muted);font-size:13px}',
    '.drl .drl-work{display:grid;grid-template-columns:minmax(0,1fr);gap:18px}',
    '.drl.two.is-done .drl-work{grid-template-columns:minmax(0,1.08fr) minmax(300px,1fr);align-items:start}',
    '.drl .drl-paper{position:relative}',
    '.drl .drl-paper.live .sr-ink{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}',
    '.drl .drl-ovl{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:14px 18px;text-align:center;border-radius:8px;',
    'background:var(--paper);background:color-mix(in srgb,var(--paper) 93%,transparent);font:16px/1.45 var(--serif);color:var(--muted)}',
    '.drl .drl-ovl p{margin:0;max-width:46ch}',
    '.drl .drl-ovl .drl-ovl-s{font:13px/1.4 var(--ui)}',
    '.drl .drl-start{font:600 17px var(--ui);padding:10px 36px;min-height:46px}',
    '.drl .drl-bdgs{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden;border-radius:8px}',
    '.drl .drl-bdg{position:absolute;transform:translate(-50%,-135%);display:flex;align-items:center;gap:4px;background:var(--warn);color:var(--paper);border-radius:999px;',
    'padding:2px 8px 2px 5px;font:600 12px/1.3 var(--ui);white-space:nowrap;font-variant-numeric:tabular-nums;box-shadow:0 1px 4px var(--shadow)}',
    '.drl .drl-bdg.below{transform:translate(-50%,40%)}',
    '.drl .drl-bdg.longest{background:var(--bad)}',
    '.drl .drl-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}',
    '.drl .drl-gate{font-size:13px;color:var(--muted)}',
    '.drl .drl-rp{display:flex;flex-direction:column;gap:8px;margin-top:10px}',
    '.drl .drl-rpc{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.drl .drl-seg{display:inline-flex;gap:4px}',
    '.drl .drl-rpt{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}',
    '.drl .drl-tl{position:relative;height:44px;border:1px solid var(--line);border-radius:6px;background:var(--paper);touch-action:none;cursor:pointer;overflow:hidden;outline:none}',
    '.drl .drl-tl:focus-visible{box-shadow:0 0 0 2px var(--accent)}',
    '.drl .drl-tl .ink{position:absolute;top:24px;height:10px;background:var(--text);opacity:.5;min-width:2px;border-radius:2px}',
    '.drl .drl-tl .stall{position:absolute;top:0;bottom:0;background:var(--fog);background:color-mix(in srgb,var(--warn) 22%,transparent);border-left:2px solid var(--warn)}',
    '.drl .drl-tl .stall.longest{background:color-mix(in srgb,var(--bad) 22%,transparent);border-left-color:var(--bad)}',
    '.drl .drl-tl .lab{position:absolute;top:3px;left:4px;font-size:11px;font-weight:600;color:var(--warn);white-space:nowrap}',
    '.drl .drl-tl .stall.longest .lab{color:var(--bad)}',
    '.drl .drl-tl .head{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--accent)}',
    '.drl .drl-legend{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}',
    '.drl .drl-legend i{display:block;width:140px;height:8px;border-radius:4px;background:linear-gradient(to right,var(--accent),var(--after),var(--warn))}',
    '.drl .drl-sec{margin-top:16px}',
    '.drl .drl-stats dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 14px;margin:6px 0 0}',
    '.drl .drl-stats dt{color:var(--muted)}',
    '.drl .drl-stats dd{margin:0;font-variant-numeric:tabular-nums}',
    '.drl .drl-guess{font-style:normal;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 4px;color:var(--muted);margin-left:4px}',
    '.drl .drl-fine{font-size:12px;color:var(--muted);margin:8px 0 0}',
    '.drl .drl-by{margin:2px 0 6px}',
    '.drl .drl-steps{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}',
    '.drl .drl-steps li{margin:0;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:9px 12px}',
    '.drl .drl-steps li.guess{border-color:var(--bad)}',
    '.drl .drl-sth{font:600 13px/1.35 var(--ui)}',
    '.drl .drl-stn{color:var(--accent);margin-right:6px}',
    '.drl .drl-stg{font-weight:600;font-size:11px;color:var(--bad);margin-left:6px}',
    '.drl .drl-stb{font:16px/1.5 var(--serif);margin-top:4px;overflow-x:auto;overflow-y:hidden}',
    '.drl .drl-note{margin:6px 0 0;font-size:13px;color:var(--muted)}',
    '.drl .drl-gb{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}',
    '.drl .drl-gb button{display:flex;flex-direction:column;align-items:flex-start;line-height:1.2;min-width:100px;padding:7px 12px}',
    '.drl .drl-gb small{font-size:11px;color:var(--muted)}',
    '.drl .drl-gb .g-clean{border-color:var(--good)}.drl .drl-gb .g-shaky{border-color:var(--warn)}.drl .drl-gb .g-failed{border-color:var(--bad)}',
    '.drl .drl-gb button.sel small{color:inherit}',
    '.drl .drl-ladder{position:relative;margin:14px 0 6px;padding-top:24px}',
    '.drl .drl-rungs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px}',
    '.drl .drl-rung{border:1px solid var(--line);border-radius:6px;padding:4px 2px;text-align:center;font-size:12px;color:var(--muted);background:var(--paper);transition:background .5s,color .5s}',
    '.drl .drl-rung b{display:block;font-size:15px;color:var(--text);transition:color .5s}',
    '.drl .drl-rung.on{background:var(--tint);background:color-mix(in srgb,var(--accent) 16%,var(--paper))}',
    '.drl .drl-rung.cur{background:var(--accent);border-color:var(--accent);color:var(--paper)}.drl .drl-rung.cur b{color:var(--paper)}',
    '.drl .drl-marker{position:absolute;top:0;transform:translateX(-50%);transition:left .9s cubic-bezier(.3,1.35,.5,1);font:600 12px var(--ui);color:var(--accent);white-space:nowrap}',
    '.drl .drl-next{margin:6px 0 0}',
    '.drl .drl-hist{margin:8px 0 0;font-size:12px;color:var(--muted)}',
    '@media (prefers-reduced-motion:reduce){.drl .drl-marker,.drl .drl-rung,.drl .drl-rung b{transition:none}}'
  ].join('\n');
  function injectCss() { if (SR.style) SR.style('drill', CSS); }

  var SKELETON =
    '<div class="drl-head"></div>' +
    '<div class="drl-sw" role="group" aria-label="Proofs in this basic" hidden></div>' +
    '<div class="drl-stmt" hidden></div>' +
    '<div class="drl-bar">' +
      '<span class="drl-timer" role="timer">0:00</span><span class="drl-status"></span><span class="sp"></span>' +
      '<button type="button" data-drl="undo">Undo</button>' +
      '<button type="button" data-drl="giveup" class="warn">Give up</button>' +
      '<button type="button" data-drl="done" class="primary">Done</button>' +
      '<button type="button" data-drl="again">New attempt</button>' +
    '</div>' +
    '<div class="drl-work">' +
      '<div class="drl-a">' +
        '<div class="drl-paper">' +
          '<div class="drl-bdgs" aria-hidden="true"></div>' +
          '<div class="drl-ovl"><p>Blank page. Write it out from memory. None of the model’s version shows until you tap Done.</p>' +
            '<button type="button" class="primary drl-start" data-drl="start">Start</button>' +
            '<p class="drl-ovl-s">The clock starts when you tap Start. The Pencil or a mouse writes; fingers scroll.</p></div>' +
        '</div>' +
        '<div class="drl-foot"><span class="drl-gate"></span><span class="sp"></span>' +
          '<button type="button" data-drl="more">More paper</button>' +
          '<button type="button" data-drl="done" class="primary">Done</button></div>' +
        '<div class="drl-rp" hidden>' +
          '<div class="drl-rpc"><button type="button" data-drl="play">Play</button>' +
            '<span class="drl-seg" role="group" aria-label="Replay speed">' +
            SPEEDS.map(function (s) { return '<button type="button" data-speed="' + s + '" aria-pressed="false">' + s + '×</button>'; }).join('') + '</span>' +
            '<button type="button" data-drl="tmap" aria-pressed="false">Time map</button><span class="sp"></span><span class="drl-rpt"></span></div>' +
          '<div class="drl-tl" tabindex="0" role="slider" aria-label="Replay timeline: tap or drag to seek" aria-valuemin="0"></div>' +
          '<div class="drl-legend" hidden><span>early</span><i></i><span>late</span></div>' +
        '</div>' +
        '<div class="drl-stats drl-sec" hidden></div>' +
      '</div>' +
      '<div class="drl-b" hidden><div class="drl-model"></div><div class="drl-grade drl-sec"></div></div>' +
    '</div>';

  var prefs = { speed: 4 };

  /* ---------- one drill view ---------- */
  function run(el, spec) {
    if (!el || !el.appendChild) throw new Error('SR.drill.run needs an element');
    if (!SR.ink || !SR.store) throw new Error('SR.drill.run needs core.js');
    if (el.__srDrill && typeof el.__srDrill.destroy === 'function') el.__srDrill.destroy();
    injectCss();
    spec = spec || {};
    var inline = !!(el.closest && el.closest('.page, #sr-stack, .sr-doc'));
    /* Inside a doc the theorem usually sits right above the block (content puts each proof's .thm just
       before its fog block), so the drill does not repeat it unless asked to. */
    function statementAbove() {
      var blk = el.closest ? el.closest('.blk') : null, p = blk && blk.previousElementSibling;
      return !!p && !/^H[1-6]$/.test(p.tagName);
    }

    function resolve(s) {
      var F = fogs(), fogId = s.fogId && F[s.fogId] ? s.fogId : null, f, custom;
      if (!fogId && Array.isArray(s.steps)) {
        var ids = Object.keys(F);
        for (var i = 0; i < ids.length; i++) if (F[ids[i]] && F[ids[i]].steps === s.steps) { fogId = ids[i]; break; }
      }
      custom = Array.isArray(s.steps) && s.steps.length > 0 && !(fogId && F[fogId].steps === s.steps);
      if (fogId && !custom) fogId = currentFog(fogId);
      f = fogId ? F[fogId] : null;
      var basic = s.basic || (f && f.basic) || null;
      var title = (f && f.title) || s.title || (basic ? docTitle(basic) : 'Proof');
      var given = s.statement != null && s.statement !== '';
      var statement = given ? String(s.statement) : (f && f.statement) || '';
      return {
        fogId: fogId, basic: basic, title: title, statement: statement,
        showStatement: !!statement && (!inline || s.showStatement === true || (s.showStatement !== false && !statementAbove())),
        steps: normSteps(custom ? s.steps : (f ? f.steps : [])),
        key: s.key || keyFor(fogId, basic, title)
      };
    }
    /* A drill of a basic (a sheet opened without a key, e.g. reader.drill from Today or the scaffold)
       offers every proof of the basic. It opens on the one asked for when the caller fixed it, else on an
       unfinished attempt (live, or shown but not graded), else on the proof drilled least recently, so
       repeated drills of a basic rotate through its theorems. A caller that passes a key (block-fog) or
       fixed: true gets exactly the proof it named. */
    function initialPick(list, given, fixed) {
      if (fixed && given && list.indexOf(given) >= 0) return given;
      for (var i = 0; i < list.length; i++) {
        var a = peekAtt(keyFor(list[i]));
        if (a && (a.end == null || !a.grade)) return list[i];
      }
      var best = null, bestDay = null, first = true;
      list.forEach(function (id) {
        var h = histOf(keyFor(id)), last = h.length ? h[h.length - 1].day : null;
        if (first) { best = id; bestDay = last; first = false; return; }
        if (bestDay === null) return;
        if (last === null || dayNum(last) < dayNum(bestDay)) { best = id; bestDay = last; }
      });
      return best || given;
    }

    var cur = resolve(spec);
    var pinned = !!spec.fixed || !!spec.key;
    var choose = (spec.choose != null ? !!spec.choose : !inline && !pinned) && !!cur.basic;
    var list = [];
    if (cur.basic && (choose || (!cur.fogId && !cur.steps.length))) {
      list = proofsOf(cur.basic);
      if (cur.fogId && list.indexOf(cur.fogId) < 0) list.unshift(cur.fogId);
      var pick = list.length ? initialPick(list, cur.fogId, pinned) : null;
      if (pick && pick !== cur.fogId) cur = resolve({ fogId: pick, basic: cur.basic, showStatement: spec.showStatement });
    }
    if (list.length < 2) choose = false;
    /* autoStart: the caller already had its own Start tap, so the clock starts at once, the first time
       only; after New attempt the Start button is back. (block-fog calls api.start() itself instead.) */
    var autoStart = !!spec.autoStart;

    var m = null, dead = false, wasConnected = false, timer = 0, lastH = -1, busy = false, animate = false;
    var rp = { T: 0, playing: false, speed: prefs.speed, tmap: false, raf: 0, last: 0 };
    var an = null, doneSig = '', stepsSig = '', gradeSig = '', headHtml = '', swHtml = '', tlDown = null, ro = null;
    var offs = [], inst = { sync: function () { sync(); } };

    var root = document.createElement('div');
    root.className = 'drl no-ink ' + (inline ? 'inline' : 'sheet');
    el.innerHTML = '';
    el.appendChild(root);
    root.innerHTML = SKELETON;
    function q(s) { return root.querySelector(s); }
    var D = {
      head: q('.drl-head'), sw: q('.drl-sw'), stmt: q('.drl-stmt'), timer: q('.drl-timer'), status: q('.drl-status'),
      undo: q('[data-drl="undo"]'), give: q('[data-drl="giveup"]'), again: q('[data-drl="again"]'),
      dones: [].slice.call(root.querySelectorAll('[data-drl="done"]')), more: q('[data-drl="more"]'),
      paper: q('.drl-paper'), bdgs: q('.drl-bdgs'), ovl: q('.drl-ovl'), foot: q('.drl-foot'), gate: q('.drl-gate'),
      rp: q('.drl-rp'), play: q('[data-drl="play"]'), seg: q('.drl-seg'), tmap: q('[data-drl="tmap"]'), rpt: q('.drl-rpt'),
      tl: q('.drl-tl'), legend: q('.drl-legend'), stats: q('.drl-stats'), b: q('.drl-b'), model: q('.drl-model'), grade: q('.drl-grade')
    };

    function attach(key) { m = model(key); if (m.subs.indexOf(inst) < 0) m.subs.push(inst); }
    function detach() {
      if (!m) return;
      var i = m.subs.indexOf(inst);
      if (i >= 0) m.subs.splice(i, 1);
      if (!m.subs.length && models[m.key] === m) delete models[m.key];
      m = null;
    }
    function phase() { var a = m && m.att; return !a ? 'idle' : a.end == null ? 'live' : 'done'; }
    /* Idle, the page only has to hold the Start card: at least 260 px on screen at any width. */
    function paperH() {
      var a = m && m.att;
      if (a) return clamp(+a.H || H_PAGE, 200, H_MAX);
      var w = D.paper.clientWidth;
      return w > 0 ? Math.max(H_IDLE, Math.ceil(260 * W / w)) : H_IDLE;
    }
    function inkList() {
      var ph = phase(), a = m && m.att;
      if (ph === 'live') return a.strokes;
      if (ph === 'done') return rp.T >= a.end ? a.strokes : frameList(a, rp.T);
      return [];
    }
    function inkColor(st) {
      if (rp.tmap && phase() === 'done') {
        var a = m.att;
        return ramp(((typeof st.t0 === 'number' ? st.t0 : a.start) - a.start) / Math.max(1, a.end));
      }
      return '--ink';
    }

    if (cur.fogId && !spec.key) carry(cur.fogId);
    attach(cur.key);
    var ink = SR.ink.create(D.paper, {
      width: W,
      height: paperH,
      strokes: inkList,
      color: inkColor,
      readOnly: function () { return dead || phase() !== 'live'; },
      background: ruled,
      className: 'drl-ink',
      onChange: function () {
        if (!m || phase() !== 'live') return;
        persist(m);
        syncBar();
        notify(m, inst);
      }
    });
    var giveTap = SR.twoTap(D.give, 'Tap again: show it, counts as failed', function () { doDone(true); });
    var againTap = SR.twoTap(D.again, 'Tap again to clear this attempt', function () { doAgain(); });

    /* ---------- rendering ---------- */
    function renderHead() {
      var b = cur.basic, e = eng(), h = '<div class="drl-kick"><span class="sr-kick">Blank-page drill</span>';
      if (!inline) h += '<span class="sr-by">' + esc(SR.LABEL_MODEL || LABEL_MODEL) + '</span>';  /* in a doc, the doc's byline covers it */
      if (!e) h += '<span class="sr-hint">engine.js is not loaded: grades here are not recorded</span>';
      h += '</div>';
      if (!cur.showStatement && !inline) h += '<div class="drl-title">' + esc(cur.title) + '</div>';
      if (b) {
        var st = stageOf(b), due = ecall('due', b), td = today(), dl = ecall('deadline', b);
        h += '<div class="drl-meta"><span class="drl-chip">' + esc(docTitle(b)) + '</span><span class="sr-stage s' + st + '">stage ' + st + ' of 5</span>' +
          (validDay(due) ? '<span>' + esc(dueText(due, td)) + '</span>' : '') +
          (dl && validDay(dl.date) ? '<span>' + esc(deadlineText(dl)) + '</span>' : '') +
          '<span class="sr-demo">' + esc(SR.LABEL_DEMO || 'Demo data') + '</span></div>';
      } else h += '<div class="drl-meta"><span>No basic is named for this drill, so a grade here is not recorded.</span></div>';
      if (h !== headHtml) { headHtml = h; D.head.innerHTML = h; }
    }
    function proofStatus(id) {
      var a = peekAtt(keyFor(id));
      if (a && a.end == null) return 'in progress';
      if (a && !a.grade) return 'to grade';
      var h = histOf(keyFor(id)), l = h[h.length - 1];
      return l ? 'last ' + shortDay(l.day) + ' · ' + l.grade : 'not drilled yet';
    }
    function renderSwitch() {
      if (!choose) { if (!D.sw.hidden) { D.sw.hidden = true; D.sw.innerHTML = ''; swHtml = ''; } return; }
      var F = fogs(), h = '<span class="sr-hint">Proofs in ' + esc(docTitle(cur.basic)) + '</span>';
      list.forEach(function (id) {
        var f = F[id] || {};
        h += '<button type="button" data-drl-fog="' + esc(id) + '" aria-pressed="' + (id === cur.fogId) + '"><span>' + esc(f.title || id) + '</span><small>' + esc(proofStatus(id)) + '</small></button>';
      });
      if (h !== swHtml) { swHtml = h; D.sw.innerHTML = h; }
      D.sw.hidden = false;
    }
    function renderStmt() {
      if (cur.showStatement) {
        D.stmt.innerHTML = '<b>' + esc(cur.title) + '.</b> ' + cur.statement;
        D.stmt.hidden = false;
        typeset(D.stmt);
      } else { D.stmt.innerHTML = ''; D.stmt.hidden = true; }
    }
    function syncBar() {
      var ph = phase(), a = m && m.att, n = ph === 'live' ? a.strokes.length : 0;
      D.undo.hidden = ph !== 'live';
      D.undo.disabled = !n;
      D.give.hidden = ph !== 'live';
      D.give.disabled = n < MIN_STROKES;
      D.dones.forEach(function (b) { b.hidden = ph !== 'live'; b.disabled = n < MIN_STROKES; });
      D.again.hidden = !(ph === 'done' && a.grade);
      D.foot.hidden = ph !== 'live';
      D.more.disabled = !(ph === 'live' && paperH() < H_MAX);
      D.gate.textContent = ph === 'live' && n < MIN_STROKES
        ? 'Done and Give up unlock after ' + MIN_STROKES + ' strokes (' + n + ' so far): write what you can first. Give up then shows the steps and counts as failed.' : '';
      D.status.textContent = ph === 'idle' ? 'not started' : ph === 'live' ? 'clock running'
        : (a.gaveUp ? 'gave up' : 'attempt ended') + (a.grade ? ' · graded ' + a.grade : ' · grade it against the steps');
      if (ph !== 'live') giveTap.disarm();
      if (!(ph === 'done' && a.grade)) againTap.disarm();
    }
    function tick() {
      var ph = phase(), a = m && m.att;
      D.timer.textContent = dur(ph === 'idle' ? 0 : ph === 'live' ? Date.now() - a.start : a.end);
    }
    function startTimer() {
      if (timer) return;
      timer = setInterval(function () {
        if (dead) return;
        if (!root.isConnected) { if (wasConnected && !inline) destroy(); return; }
        if (phase() !== 'live') { stopTimer(); return; }
        tick();
      }, 250);
    }
    function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }

    function sync() {
      if (dead || !m) return;
      if (root.isConnected) wasConnected = true;
      else if (wasConnected && !inline) { destroy(); return; }
      var ph = phase();
      root.classList.toggle('is-idle', ph === 'idle');
      root.classList.toggle('is-live', ph === 'live');
      root.classList.toggle('is-done', ph === 'done');
      D.paper.classList.toggle('live', ph === 'live');
      D.ovl.hidden = ph !== 'idle';
      syncBar();
      if (ph === 'done') ensureDone();
      else {
        pause(true);
        if (doneSig || stepsSig || gradeSig) { doneSig = stepsSig = gradeSig = ''; an = null; }
        D.rp.hidden = true; D.stats.hidden = true; D.b.hidden = true;
        D.bdgs.innerHTML = ''; D.model.innerHTML = ''; D.grade.innerHTML = ''; D.stats.innerHTML = ''; D.tl.innerHTML = '';
      }
      var h = paperH();
      if (h !== lastH) { lastH = h; ink.layout(); } else ink.redraw();
      renderHead();
      renderSwitch();
      if (ph === 'live') startTimer(); else stopTimer();
      tick();
    }

    /* ---------- after Done: analysis, timeline, badges, stats, steps, grade ---------- */
    function ensureDone() {
      var a = m.att, base = m.key + '|' + a.start, sig = base + '|' + a.end + '|' + a.strokes.length + '|' + paperH();
      if (sig !== doneSig) {
        var fresh = doneSig.indexOf(base + '|') !== 0;
        doneSig = sig;
        an = analyse(a, cur.steps.length);
        if (fresh) { pause(true); rp.T = a.end; } else rp.T = Math.min(rp.T, a.end);
        renderTimeline(); renderBadges(); renderStats();
      }
      var L = an.longest, ssig = base + '|' + (L && a.strokes.length ? L.step + ':' + (L.next >= 0 ? 'b' : 'a') : '-');
      if (ssig !== stepsSig) { stepsSig = ssig; renderSteps(); }
      var gsig = ssig + '|' + (a.grade || '') + '|' + JSON.stringify(a.res || null) + '|' + (a.grade ? '' : stageOf(cur.basic) + ':' + today());
      if (gsig !== gradeSig) { gradeSig = gsig; renderGrade(); }
      D.rp.hidden = false; D.stats.hidden = false; D.b.hidden = false;
      updRpUI();
    }
    function pct(v, tot) { return (clamp(v / Math.max(1, tot), 0, 1) * 100).toFixed(3) + '%'; }
    function renderTimeline() {
      var a = m.att, tot = Math.max(1, a.end), h = '';
      an.stalls.forEach(function (s) {
        h += '<div class="stall' + (s === an.longest ? ' longest' : '') + '" style="left:' + pct(s.from, tot) + ';width:' + pct(s.to - s.from, tot) + '">' +
          '<span class="lab">' + dur(s.to - s.from) + '</span></div>';
      });
      an.spans.forEach(function (sp) { if (sp) h += '<div class="ink" style="left:' + pct(sp.t0, tot) + ';width:' + pct(sp.t1 - sp.t0, tot) + '"></div>'; });
      D.tl.innerHTML = h + '<div class="head"></div>';
      D.tl.setAttribute('aria-valuemax', String(Math.round(tot / 1000)));
    }
    function renderBadges() {
      var H = paperH(), h = '';
      an.stalls.forEach(function (s, i) {
        if (s.next < 0 || s.x == null) return;
        var x = clamp(s.x, 36, W - 36);
        h += '<div class="drl-bdg' + (s === an.longest ? ' longest' : '') + (s.y < 40 ? ' below' : '') + '" data-i="' + i + '" style="left:' +
          (x / W * 100).toFixed(3) + '%;top:' + (clamp(s.y, 0, H) / H * 100).toFixed(3) + '%">' + CLOCK + dur(s.to - s.from) + '</div>';
      });
      D.bdgs.innerHTML = h;
    }
    function stallPlace(L) {
      var a = m.att, st = cur.steps[L.step], name = st && st.topic ? ' (' + st.topic + ')' : '';
      if (!a.strokes.length) return 'on a blank page';
      if (L.next >= 0) return 'before step ' + (L.step + 1) + name;
      return 'after step ' + (L.step + 1) + name + ', before Done';
    }
    function renderStats() {
      var a = m.att, lens = an.stalls.map(function (s) { return s.to - s.from; });
      var stallTot = lens.reduce(function (x, v) { return x + v; }, 0), L = an.longest;
      var hist = histOf(m.key).filter(function (e) { return e.t0 !== a.start; }).slice(-4).reverse();
      D.stats.innerHTML = '<div class="sr-kick">Where the time went</div><dl>' +
        '<dt>Total</dt><dd>' + dur(an.total) + '</dd>' +
        '<dt>Inking</dt><dd>' + dur(an.inking) + ' (' + Math.round(100 * an.inking / Math.max(1, an.total)) + '%) in ' + an.strokes + ' stroke' + (an.strokes === 1 ? '' : 's') + '</dd>' +
        '<dt>Stalls</dt><dd>' + (lens.length ? lens.length + ' over 30 s: ' + lens.map(dur).join(', ') + ' (total ' + dur(stallTot) + ')' : 'none over 30 s') + '</dd>' +
        '<dt>Longest</dt><dd>' + (L ? esc(dur(L.to - L.from) + ' at ' + dur(L.from) + ', ' + stallPlace(L)) + (a.strokes.length ? '<em class="drl-guess">guess</em>' : '') : 'no stall over 30 s') + '</dd>' +
        '</dl><p class="drl-fine">Step guess: the inked part of the page is cut into ' + an.steps + ' equal bands, top to bottom, one per model step, and the stroke after the stall picks the band. It does not read your ink.</p>' +
        (hist.length ? '<p class="drl-hist">Earlier attempts: ' + hist.map(function (e) {
          return esc(shortDay(e.day) + ' ' + e.grade + (e.gaveUp ? ' (gave up)' : '') + ', ' + dur(e.total));
        }).join(' · ') + '</p>' : '');
    }
    function renderSteps() {
      var a = m.att, L = an && an.longest, hasInk = a.strokes.length > 0;
      var h = '<div class="sr-kick">The model’s version, step by step</div><p class="sr-by drl-by">' + esc(SR.LABEL_MODEL || LABEL_MODEL) + '</p><ol class="drl-steps">';
      if (!cur.steps.length) h += '<li>The demo content has no steps for this drill.</li>';
      cur.steps.forEach(function (st, i) {
        var g = !!(L && hasInk && L.step === i);
        h += '<li' + (g ? ' class="guess"' : '') + '><div class="drl-sth"><span class="drl-stn">Step ' + (i + 1) + '</span>' + esc(st.topic) +
          (g ? '<span class="drl-stg">longest stall ' + (L.next >= 0 ? 'before' : 'after') + ' this (guess)</span>' : '') + '</div>' +
          '<div class="drl-stb">' + st.html + '</div></li>';
      });
      D.model.innerHTML = h + '</ol>';
      typeset(D.model);
    }
    function resNotes(res) {
      var out = [];
      if (res.capped && res.deadline) out.push('The interval is capped at ' + res.interval + ' d by ' + deadlineText(res.deadline) + ': at most a third of the days left.');
      if (res.sameDay && res.grade === 'clean') out.push('The stage already rose today; it rises at most once a day.');
      if (res.pushAfter != null && res.pushBefore != null && res.pushAfter !== res.pushBefore) {
        out.push('Push level ' + res.pushBefore + ' → ' + res.pushAfter + ': proofs in this basic now open as ' + (PUSH_TEXT[res.pushAfter] || 'level ' + res.pushAfter) + '.');
      }
      return out;
    }
    function renderGrade() {
      var a = m.att, b = cur.basic, res = a.res, g = a.grade, iv = intervals();
      var from = res ? res.stageBefore : stageOf(b);
      var h = '<div class="sr-kick">Grade yourself</div>';
      if (a.gaveUp) h += '<p class="drl-note">You gave up, so this attempt counts as failed.</p>';
      else if (!g) h += '<p class="drl-note">Compare your page with the steps. Clean: every step there, in order. Shaky: there, with a gap or a slip. Failed: a step missing.</p>';
      h += '<div class="drl-gb" role="group" aria-label="Grade">' + GRADES.map(function (x) {
        var sub = x === 'clean' ? 'stage +1' : x === 'shaky' ? 'stage stays' : 'back to 0';
        return '<button type="button" data-grade="' + x + '" class="g-' + x + (g === x ? ' sel' : '') + '" aria-pressed="' + (g === x) + '"' +
          (g || !b ? ' disabled' : '') + '>' + cap(x) + '<small>' + sub + '</small></button>';
      }).join('') + '</div>';
      h += '<div class="drl-ladder"><div class="drl-marker">▼ stage</div><div class="drl-rungs">' +
        iv.map(function (v, i) { return '<div class="drl-rung" data-i="' + i + '"><b>' + i + '</b>' + v + ' d</div>'; }).join('') + '</div></div>';
      var next = '';
      if (res) {
        var days = typeof res.interval === 'number' ? res.interval : dayDiff(res.due, a.gradeDay || today());
        next = esc(cap(g) + ': stage ' + res.stageBefore + ' → ' + res.stageAfter + '. Next due ' + (validDay(res.due) ? dayLabel(res.due) : '?') +
          ' (in ' + days + ' d).') + resNotes(res).map(function (t) { return '<br><span class="drl-note">' + esc(t) + '</span>'; }).join('');
      } else if (g && !b) next = 'Graded ' + esc(g) + '. No basic is named, so nothing was recorded.';
      else if (g) next = 'Graded ' + esc(g) + '. The engine did not record it.';
      else if (b) {
        var dl = ecall('deadline', b), up = Math.min(5, from + 1), rose = ecall('roseToday', b) === true;
        next = esc('Now at stage ' + from + '. Clean → ' + (rose ? from + ', since it already rose today' : up) + ' (' + cappedIv(rose ? from : up, dl) + ' d), shaky stays ' + from +
          ' (' + cappedIv(from, dl) + ' d), failed → 0 (' + cappedIv(0, dl) + ' d).');
      } else next = 'No basic is named for this drill, so a grade is not recorded.';
      D.grade.innerHTML = h + '<p class="drl-next">' + next + '</p>';
      if (res && animate) {
        animate = false;
        setLadder(res.stageBefore);
        var mk = D.grade.querySelector('.drl-marker');
        if (mk) void mk.offsetWidth;
        setTimeout(function () { if (!dead && m && m.att && m.att.res) setLadder(m.att.res.stageAfter); }, 80);
      } else setLadder(res ? res.stageAfter : from);
    }
    function setLadder(n) {
      var mk = D.grade.querySelector('.drl-marker');
      if (!mk) return;
      mk.style.left = ((n + 0.5) / 6 * 100) + '%';
      [].forEach.call(D.grade.querySelectorAll('.drl-rung'), function (r) {
        var i = +r.getAttribute('data-i');
        r.classList.toggle('on', i < n);
        r.classList.toggle('cur', i === n);
      });
    }

    /* ---------- replay ---------- */
    function updHead() {
      var a = m && m.att;
      if (!a || a.end == null || !an) return;
      var tot = Math.max(1, a.end), hd = D.tl.querySelector('.head');
      if (hd) hd.style.left = (clamp(rp.T / tot, 0, 1) * 100) + '%';
      D.rpt.textContent = dur(rp.T) + ' / ' + dur(a.end);
      D.tl.setAttribute('aria-valuenow', String(Math.round(rp.T / 1000)));
      D.tl.setAttribute('aria-valuetext', dur(rp.T) + ' of ' + dur(a.end));
      [].forEach.call(D.bdgs.children, function (bd) {
        var s = an.stalls[+bd.getAttribute('data-i')];
        bd.style.visibility = s && rp.T >= s.to ? 'visible' : 'hidden';
      });
    }
    function updRpUI() {
      D.play.textContent = rp.playing ? 'Pause' : 'Play';
      [].forEach.call(D.seg.children, function (b) { b.setAttribute('aria-pressed', String(+b.getAttribute('data-speed') === rp.speed)); });
      D.tmap.setAttribute('aria-pressed', String(rp.tmap));
      D.legend.hidden = !rp.tmap;
      updHead();
    }
    function setT(t) {
      var a = m && m.att;
      if (!a || a.end == null) return;
      rp.T = clamp(+t || 0, 0, a.end);
      ink.redraw();
      updHead();
    }
    function frame(now) {
      rp.raf = 0;
      if (!rp.playing || dead) return;
      var a = m && m.att;
      if (!a || a.end == null || !root.isConnected) { pause(true); return; }
      rp.T += Math.max(0, now - rp.last) * rp.speed;
      rp.last = now;
      if (rp.T >= a.end) { rp.T = a.end; rp.playing = false; }
      ink.redraw();
      if (rp.playing) { updHead(); rp.raf = requestAnimationFrame(frame); } else updRpUI();
    }
    function play() {
      var a = m && m.att;
      if (!a || a.end == null) return;
      if (rp.T >= a.end) rp.T = 0;
      rp.playing = true;
      rp.last = performance.now();
      if (!rp.raf) rp.raf = requestAnimationFrame(frame);
      updRpUI();
    }
    function pause(silent) {
      rp.playing = false;
      if (rp.raf) { cancelAnimationFrame(rp.raf); rp.raf = 0; }
      if (!silent && phase() === 'done') updRpUI();
    }
    function setSpeed(s) { if (SPEEDS.indexOf(+s) < 0) return; rp.speed = prefs.speed = +s; updRpUI(); }
    function setTmap(on) { rp.tmap = !!on; ink.redraw(); updRpUI(); }
    function seekEvent(e) {
      var a = m && m.att;
      if (!a || a.end == null) return;
      var r = D.tl.getBoundingClientRect();
      setT(clamp((e.clientX - r.left) / (r.width || 1), 0, 1) * a.end);
    }
    D.tl.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      tlDown = e.pointerId;
      pause();
      try { D.tl.setPointerCapture(e.pointerId); } catch (_) {}
      seekEvent(e);
    });
    D.tl.addEventListener('pointermove', function (e) { if (tlDown === e.pointerId) seekEvent(e); });
    function tlUp(e) { if (tlDown === e.pointerId) tlDown = null; }
    D.tl.addEventListener('pointerup', tlUp);
    D.tl.addEventListener('pointercancel', tlUp);
    D.tl.addEventListener('lostpointercapture', tlUp);
    D.tl.addEventListener('keydown', function (e) {
      var a = m && m.att;
      if (!a || a.end == null) return;
      var step = Math.max(1000, a.end / 40), k = e.key, t = null;
      if (k === 'ArrowLeft' || k === 'ArrowDown') t = rp.T - step;
      else if (k === 'ArrowRight' || k === 'ArrowUp') t = rp.T + step;
      else if (k === 'Home') t = 0;
      else if (k === 'End') t = a.end;
      else if (k === ' ' || k === 'Enter') { if (rp.playing) pause(); else play(); }
      else return;
      if (t !== null) { pause(); setT(t); }
      e.preventDefault();
    });

    /* ---------- actions ---------- */
    function publicAtt() { return m && m.att ? copy(m.att) : null; }
    function cb(name) {
      if (typeof spec[name] !== 'function') return;
      try { spec[name].apply(null, [].slice.call(arguments, 1)); } catch (e) { console.error('[SR] drill ' + name + ' callback failed:', e); }
    }
    function doStart() {
      if (!m || m.att) return;
      m.att = { v: 1, start: Date.now(), end: null, strokes: [], H: H_PAGE, grade: null, res: null, gaveUp: false,
        day: today(), fogId: cur.fogId, basic: cur.basic };
      persist(m);
      sync();
      notify(m, inst);
      cb('onStart', publicAtt());
      emit('drill:start', { key: m.key, fogId: cur.fogId, basic: cur.basic });
    }
    function doDone(gaveUp) {
      var a = m && m.att;
      if (!a || a.end != null) return;
      if (a.strokes.length < MIN_STROKES) return;   /* attempt before reveal, for Give up as well as Done */
      var lastT = 0;
      a.strokes.forEach(function (s) { if (s && s.p && s.p.length) lastT = Math.max(lastT, strokeSpan(s, a.start).t1); });
      a.end = Math.max(Date.now() - a.start, lastT, 1);
      a.gaveUp = !!gaveUp;
      persist(m);
      sync();
      notify(m, inst);
      cb('onDone', publicAtt());
      emit('drill:done', { key: m.key, fogId: cur.fogId, basic: cur.basic, gaveUp: !!gaveUp, ms: a.end, strokes: a.strokes.length });
      if (gaveUp) doGrade('failed', true);
      else if (D.b.scrollIntoView && !inline && !root.classList.contains('two')) {
        try { D.b.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
      }
    }
    function doGrade(g, auto) {
      var a = m && m.att;
      if (!a || a.end == null || a.grade || GRADES.indexOf(g) < 0) return;
      if (a.gaveUp && g !== 'failed') return;
      var res = null;
      if (cur.basic) { busy = true; try { res = ecall('recordDrill', cur.basic, g) || null; } finally { busy = false; } }
      a.grade = g;
      a.gradeDay = today();
      a.res = res ? copy({ basic: res.basic, grade: res.grade, stageBefore: res.stageBefore, stageAfter: res.stageAfter, pushBefore: res.pushBefore,
        pushAfter: res.pushAfter, due: res.due, interval: res.interval, capped: !!res.capped, sameDay: !!res.sameDay, deadline: res.deadline || null }) : null;
      var L = an && an.longest;
      histPush(m.key, { day: a.gradeDay, t0: a.start, grade: g, total: a.end, gaveUp: !!a.gaveUp, strokes: a.strokes.length,
        longest: L ? L.to - L.from : 0 });
      animate = true;
      persist(m);
      gradeSig = '';
      sync();
      notify(m, inst);
      var out = a.res ? copy(a.res) : { grade: g };
      cb(typeof spec.onGrade === 'function' ? 'onGrade' : 'onResult', out, publicAtt());
      emit('drill:grade', { key: m.key, fogId: cur.fogId, basic: cur.basic, grade: g, auto: !!auto, res: copy(a.res) });
    }
    function doAgain() {
      var a = m && m.att;
      if (!a || a.end == null || !a.grade) return;
      pause(true);
      m.att = null;
      persist(m);
      sync();
      notify(m, inst);
    }
    function doMore() {
      var a = m && m.att;
      if (!a || a.end != null) return;
      a.H = Math.min(H_MAX, paperH() + H_MORE);
      persist(m);
      sync();
      notify(m, inst);
    }
    function select(fogId) {
      if (!fogId || fogId === cur.fogId || !fogs()[fogId]) return;
      pause(true);
      detach();
      cur = resolve({ fogId: fogId, basic: cur.basic, showStatement: spec.showStatement });
      if (cur.fogId) carry(cur.fogId);
      attach(cur.key);
      doneSig = stepsSig = gradeSig = headHtml = '';
      an = null;
      lastH = -1;
      renderStmt();
      sync();
    }
    root.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || !root.contains(b) || b.disabled) return;
      var act = b.getAttribute('data-drl');
      if (act === 'start') doStart();
      else if (act === 'undo') { if (phase() === 'live') ink.undo(); }
      else if (act === 'done') doDone(false);
      else if (act === 'more') doMore();
      else if (act === 'play') { if (rp.playing) pause(); else play(); }
      else if (act === 'tmap') setTmap(!rp.tmap);
      else if (b.hasAttribute('data-speed')) setSpeed(b.getAttribute('data-speed'));
      else if (b.hasAttribute('data-grade')) doGrade(b.getAttribute('data-grade'));
      else if (b.hasAttribute('data-drl-fog')) select(b.getAttribute('data-drl-fog'));
    });

    function destroy() {
      if (dead) return;
      dead = true;
      stopTimer();
      pause(true);
      offs.forEach(function (off) { try { off(); } catch (e) {} });
      offs = [];
      if (ro) { ro.disconnect(); ro = null; }
      try { giveTap.destroy(); againTap.destroy(); } catch (e) {}
      try { ink.destroy(); } catch (e2) {}
      detach();
      if (el.__srDrill === api) el.__srDrill = null;
    }

    if (SR.bus) {
      offs.push(SR.bus.on('theme', function () { pal = null; if (!dead) ink.redraw(); }));
      offs.push(SR.bus.on('engine:change', function () {
        if (dead || busy || !m) return;
        renderHead();
        if (phase() === 'done' && !m.att.grade) ensureDone();
      }));
      offs.push(SR.bus.on('sheet:close', function () { if (!dead && !inline && wasConnected && !root.isConnected) destroy(); }));
    }
    if (!inline && typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { if (!dead) root.classList.toggle('two', root.clientWidth >= 860); });
      ro.observe(root);
    }

    var api = {
      el: root,
      key: function () { return m ? m.key : null; },
      fogId: function () { return cur.fogId; },
      basic: function () { return cur.basic; },
      proofs: function () { return list.slice(); },
      phase: phase,
      attempt: publicAtt,
      analysis: function () { return an ? copy(an) : null; },
      start: doStart,
      done: function () { doDone(false); },
      giveUp: function () { doDone(true); },
      grade: function (g) { doGrade(g); },
      again: doAgain,
      more: doMore,
      select: select,
      play: play,
      pause: function () { pause(); },
      seek: setT,
      speed: setSpeed,
      timeMap: setTmap,
      replayTime: function () { return rp.T; },
      sync: sync,
      destroy: destroy
    };
    el.__srDrill = api;
    renderStmt();
    sync();
    if (autoStart && m && !m.att && !histOf(m.key).length) doStart();
    return api;
  }

  /* ---------- a drill in a sheet (Today, the scaffold's "Drill the basic instead") ---------- */
  function open(target, opts) {
    opts = opts || {};
    var F = fogs(), isFog = !!(target && F[target]), basic = isFog ? F[target].basic : target;
    var fogId = isFog ? target : (proofsOf(basic)[0] || null);
    if (!fogId && !basic) { if (SR.toast) SR.toast('No drill for ' + target + ' in the demo content.'); return null; }
    var sh = SR.sheet.open({ id: 'drill-' + (basic || fogId), title: 'Drill · ' + docTitle(basic || (F[fogId] || {}).doc), wide: true, keepOnNav: true });
    [].forEach.call(sh.body.children, function (c) { if (c.__srDrill) c.__srDrill.destroy(); });
    sh.body.innerHTML = '';
    var host = document.createElement('div');
    sh.body.appendChild(host);
    var api = run(host, { fogId: fogId, basic: basic, fixed: isFog, choose: opts.choose });
    return { sheet: sh, drill: api };
  }

  SR.drill = {
    run: run,
    open: open,
    carry: carry,
    analyse: analyse,
    frameList: frameList,
    STALL_MS: STALL,
    MIN_STROKES: MIN_STROKES
  };

  if (SR.bus) SR.bus.on('demo:reset', function () { models = Object.create(null); });

  /* <div class="blk" data-block="drill" data-id="FOG-ID">: that proof, cold.
     <div class="blk" data-block="drill" data-id="BASIC-ID">: the basic's proofs, with a switcher. */
  if (SR.blocks) {
    SR.blocks.register('drill', {
      mount: function (el, id, ctx) {
        var F = fogs(), spec;
        if (id && F[id]) spec = { fogId: id, basic: F[id].basic, fixed: true, choose: false, showStatement: true };
        else if (id && docOf(id)) spec = { basic: id, choose: true, showStatement: true };
        else {
          el.innerHTML = '<div class="blk-ph">Drill &middot; the demo content has no drill named ' + esc(id) + '.</div>';
          return {};
        }
        spec.docId = ctx && ctx.docId;
        var api = run(el, spec);
        return { drill: api, destroy: function () { api.destroy(); } };
      }
    });
  }
})();

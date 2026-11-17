/* block-fog.js: the fog block, a proof (or worked example) inside a doc, fogged by the push level of
   its basic, engine.pushLevel(basic):
     0 steps   one step at a time; each reveal needs 3 new strokes in the attempt ink
     1 chunks  the steps merged into the content's chunks (two bigger parts); same gate
     2 cold    the proof is hidden; a blank-page drill (SR.drill.run, block-drill.js) opens in place
     3 hook    the theorem becomes a problem-first hook: a block-problem.js session over the item
               'thm:<fog id>#<n>' (call band above a commit line, confidence locked until ink, settle
               verbs, method ticks, the model's proof only after that), plus a note that the area is in
               push mode and Today now holds hidden-topic problems. Settling grades the basic like a
               drill (engine.settleProblem on a theorem item); the rating does not move.
   Provenance ink: each stroke carries e = reveals at write; strokes written after a reveal draw in
   --after. Done reports engine.recordFog once per finished attempt (levels 0-1; at 2 the drill
   reports through engine.recordDrill, at 3 the hook through engine.settleProblem). A clean proof (no
   reveals) collapses the model's text behind "show the model's version" and earns a "yours" badge. An
   attempt keeps its mode while it is open or finished, so a push change never swaps the view under it;
   idle blocks follow the level. No step text and no step topic is in the DOM until that step is revealed.
   A rebuild swaps a doc's build, and build 2 of a doc has its own fog ids: an unfinished attempt on the
   same proof (same doc and anchor) in the other build carries into this one once, and a finished one is
   shown read-only under "your attempt on build n". State per fog id in SR.store 'fog-<id>'.
   Written by a model for Adit. Not Adit's words. */
(function () {
  'use strict';
  var SR = window.SR = window.SR || {};
  var HAS = Object.prototype.hasOwnProperty;
  var W = 800, NEED = 3, H0 = 400, HSTEP = 264, HMAX = 2000;
  var MODES = ['steps', 'chunks', 'cold', 'hook'];
  var GRADES = ['clean', 'shaky', 'failed'];
  var ENDS = GRADES.concat(['moot']);   /* a hook settled moot is finished without a grade */
  var CHIP = { steps: 'fog: steps', chunks: 'fog: chunks', cold: 'fog: cold', hook: 'fog: hook' };
  var TIP = {
    steps: 'Push level 0: the proof opens one step at a time; each reveal needs 3 new strokes of yours.',
    chunks: 'Push level 1: the proof opens in two bigger parts; each reveal needs 3 new strokes of yours.',
    cold: 'Push level 2: the proof is hidden; write it on a blank page, then Done shows all of it.',
    hook: 'Push level 3: the statement is a problem now; call the method and plan, then prove it.'
  };
  var BARS = [[96, 88, 72], [92, 97, 64, 80], [85, 94, 58], [98, 76, 90, 52]];

  /* ---------- small helpers ---------- */
  function esc(s) {
    if (SR.esc) return SR.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function nowMs() { return typeof SR.now === 'function' ? SR.now() : Date.now(); }
  function sget(k) { try { return SR.store ? SR.store.get(k, null) : null; } catch (e) { return null; } }
  function sset(k, v) { try { if (SR.store) SR.store.set(k, v); } catch (e) {} }
  function sdel(k) { try { if (SR.store) SR.store.del(k); } catch (e) {} }
  /* core.js queues typesets until MathJax is ready and drops an element whose ancestor is in the same
     batch (the doc node the reader queued covers this block), so a block may typeset at any time. */
  function typeset(el) {
    if (!el || !SR.typeset) return null;
    try { return SR.typeset(el); } catch (e) { console.error('[SR] fog: typeset failed:', e); }
    return null;
  }
  function toast(msg, ms) { if (SR.toast) SR.toast(msg, ms); }
  function content() { return SR.content || {}; }
  function fogOf(id) { var f = content().fog; return f && HAS.call(f, id) ? f[id] : null; }
  function docOf(id) { var d = content().docs; return id && d && HAS.call(d, id) ? d[id] : null; }
  function titleOf(id) { var d = docOf(id); return (d && d.title) || String(id || ''); }
  function areaLabel(a) {
    var ca = content().areas && content().areas[a];
    if (ca && ca.label) return String(ca.label);
    var e = SR.engine;
    return (e && e.AREA_NAMES && e.AREA_NAMES[a]) || a || 'this area';
  }
  function engineOf(ctx) { return (ctx && ctx.engine) || SR.engine || null; }
  function call(ctx, fn, args) {
    var e = engineOf(ctx);
    if (!e || typeof e[fn] !== 'function') return undefined;
    try { return e[fn].apply(e, args || []); } catch (err) { console.error('[SR] fog: engine.' + fn + ' failed:', err); return undefined; }
  }
  function pushOf(ctx, basic) { var n = Math.floor(+call(ctx, 'pushLevel', [basic])); return n >= 0 && n <= 3 ? n : 0; }
  function fmtDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return String(s || '');
    var t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return SR.fmt && SR.fmt.date ? SR.fmt.date(t) : s;
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function ruled(ctx, w, h) {
    ctx.strokeStyle = (SR.css && SR.css('--line')) || '#d9d4ca';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var y = 44; y < h; y += 44) { ctx.moveTo(14, y); ctx.lineTo(w - 14, y); }
    ctx.stroke();
  }
  function inkColor(s) { return (+s.e || 0) > 0 ? '--after' : '--ink'; }

  /* ---------- units: single steps (level 0) or the content's chunks (level 1) ---------- */
  function range(a, b) { var o = []; for (var i = a; i < b; i++) o.push(i); return o; }
  function chunkUnits(f) {
    var n = f.steps.length, seen = {}, out = [];
    (Array.isArray(f.chunks) ? f.chunks : []).forEach(function (c) {
      if (!Array.isArray(c)) return;
      var u = [];
      c.forEach(function (x) { x = Number(x); if (x >= 0 && x < n && x === Math.floor(x) && !seen[x]) { seen[x] = 1; u.push(x); } });
      if (u.length) out.push(u.sort(function (a, b) { return a - b; }));
    });
    if (!out.length) {
      var h = Math.ceil(n / 2);
      return h < n ? [range(0, h), range(h, n)] : [range(0, n)];
    }
    var miss = range(0, n).filter(function (i) { return !seen[i]; });  /* steps no chunk names go with the last part */
    if (miss.length) out[out.length - 1] = out[out.length - 1].concat(miss).sort(function (a, b) { return a - b; });
    return out;
  }
  function unitsOf(f, mode) { return mode === 'chunks' ? chunkUnits(f) : range(0, f.steps.length).map(function (i) { return [i]; }); }
  /* Mirrors engine.fogGrade: no reveals is clean, every unit revealed is failed, anything between shaky. */
  function gradeOf(reveals, units) { if (units > 0 && reveals >= units) return 'failed'; return reveals > 0 ? 'shaky' : 'clean'; }
  function pickRes(r) {
    if (!r || typeof r !== 'object') return null;
    var o = {};
    ['grade', 'stageBefore', 'stageAfter', 'pushBefore', 'pushAfter', 'due', 'interval', 'sameDay', 'capped'].forEach(function (k) { if (r[k] !== undefined) o[k] = r[k]; });
    return o;
  }
  function bars(rows, seed) {
    var h = '';
    for (var r = 0; r < rows; r++) { var set = BARS[(seed + Math.floor(r / 3)) % BARS.length]; h += '<span style="width:' + set[r % set.length] + '%"></span>'; }
    return '<div class="bars">' + h + '</div>';
  }

  /* ---------- the result line after a finished attempt (Done, or a graded drill) ---------- */
  function resultText(r, basic, hasEngine) {
    if (!r) return hasEngine ? '' : 'Not recorded: engine.js is not loaded in this build.';
    var bt = titleOf(basic), s = '';
    if (r.stageAfter != null) {
      if (r.stageBefore == null) s = bt + ' is at stage ' + r.stageAfter;
      else if (r.sameDay) s = bt + ' stays at stage ' + r.stageAfter + ' (a stage rises once a day)';
      else if (r.stageAfter !== r.stageBefore) s = bt + ': stage ' + r.stageBefore + ' → ' + r.stageAfter;
      else s = bt + ' stays at stage ' + r.stageAfter;
      s += (r.due ? ', next drill ' + fmtDay(r.due) : '') + '.';
    }
    if (r.pushAfter != null) {
      var pa = Math.max(0, Math.min(3, +r.pushAfter || 0)), pb = r.pushBefore == null ? null : Math.max(0, Math.min(3, +r.pushBefore || 0));
      if (pb === null) s += ' Push ' + pa + ' (' + CHIP[MODES[pa]] + ').';
      else if (pa > pb) s += ' Push ' + pb + ' → ' + pa + ': the next attempt is ' + CHIP[MODES[pa]] + '.';
      else if (pa < pb) s += ' Push ' + pb + ' → ' + pa + ': eased to ' + CHIP[MODES[pa]] + '.';
      else s += ' Push stays at ' + pa + ' (' + CHIP[MODES[pa]] + ').';
    }
    return s.trim();
  }

  /* ---------- state ---------- */
  function skey(id) { return 'fog-' + id; }
  function blank(mode, hist) {
    return { v: 1, mode: mode, strokes: [], reveals: 0, done: false, grade: null, shown: false, h: H0, started: false, open: false,
      res: null, tDone: 0, moved: null, seen: 0, since: 0, hist: hist || [], hookN: 1, carried: null, carriedTo: null };
  }
  function loadState(id) {
    var s = sget(skey(id));
    if (!s || typeof s !== 'object' || MODES.indexOf(s.mode) < 0) return null;
    var b = blank(s.mode, Array.isArray(s.hist) ? s.hist.filter(function (x) { return x && GRADES.indexOf(x.grade) >= 0; }).slice(-12) : []);
    b.strokes = Array.isArray(s.strokes) ? s.strokes.filter(function (k) { return k && Array.isArray(k.p); }) : [];
    b.reveals = Math.max(0, Math.floor(+s.reveals || 0));
    b.done = !!s.done;
    b.grade = ENDS.indexOf(s.grade) >= 0 ? s.grade : null;
    if (b.done && !b.grade) b.done = false;
    b.hookN = Math.max(1, Math.floor(+s.hookN || 1));
    b.carried = s.carried && typeof s.carried === 'object' && s.carried.from ? s.carried : null;
    b.carriedTo = typeof s.carriedTo === 'string' ? s.carriedTo : null;
    b.shown = !!s.shown;
    b.h = Math.max(H0, Math.min(HMAX, +s.h || H0));
    b.started = !!s.started;
    b.open = !!s.open;
    b.res = s.res && typeof s.res === 'object' ? s.res : null;
    b.tDone = +s.tDone || 0;
    b.moved = s.moved && MODES.indexOf(s.moved.from) >= 0 ? s.moved : null;
    b.seen = +s.seen || 0;
    b.since = +s.since || 0;
    return b;
  }
  /* block-drill.js keeps one attempt per proof under 'drill-<fog id>', shared by every view of that
     drill (this block, Today, the scaffold's drill). Read only, to mirror a grade made in another view. */
  function peekDrill(id) {
    var a = sget('drill-' + id);
    return a && typeof a === 'object' && +a.start > 0 ? a : null;
  }
  function drillAttempt(id) {
    if (!SR.drill || typeof SR.drill.run !== 'function') return null;
    /* a live attempt on this proof in another build of the doc moves here first (block-drill.js) */
    if (typeof SR.drill.carry === 'function') { try { SR.drill.carry(id); } catch (e) { console.error('[SR] fog: drill carry failed:', e); } }
    return peekDrill(id);
  }
  /* Idle: nothing written, revealed, opened or finished, so the block may follow the push level. */
  function idle(s) { return !s.done && !s.started && !s.open && !s.strokes.length && !s.reveals; }

  /* ---------- the same proof in another build of its doc ---------- */
  function siblings(id) {
    var F = content().fog || {}, f = F[id], out = [];
    if (!f) return out;
    Object.keys(F).forEach(function (k) { var g = F[k]; if (k !== id && g && g.doc === f.doc && g.anchor === f.anchor) out.push(k); });
    return out;
  }
  function buildOf(fid) { var f = fogOf(fid); return (f && +f.version) || 1; }
  /* A reveal count re-cut onto another build's units: by proportion, at least 1 when anything was
     revealed (the grade stays honest), never more than the units there are. */
  function mapReveals(k, nFrom, nTo) {
    k = Math.max(0, Math.floor(+k || 0));
    if (!k || !nFrom || !nTo) return 0;
    return Math.min(nTo, Math.max(1, Math.round(k * nTo / nFrom)));
  }
  /* The first time this proof's block mounts with nothing of its own, an unfinished inked attempt on the
     same proof in another build carries over: the ink as written (provenance re-mapped like the reveals),
     the reveals mapped onto this build's units, the source marked so it is carried once. */
  function carryInto(id, f) {
    var sib = siblings(id);
    for (var i = 0; i < sib.length; i++) {
      var s = loadState(sib[i]);
      if (!s || s.done || s.carriedTo || (s.mode !== 'steps' && s.mode !== 'chunks') || (!s.strokes.length && !s.reveals)) continue;
      var fo = fogOf(sib[i]), nFrom = unitsOf(fo, s.mode).length, nTo = unitsOf(f, s.mode).length;
      var st = blank(s.mode, []);
      st.reveals = mapReveals(s.reveals, nFrom, nTo);
      st.strokes = s.strokes.map(function (k) {
        var c = JSON.parse(JSON.stringify(k));
        if ((+c.e || 0) > 0) c.e = Math.min(st.reveals, mapReveals(c.e, nFrom, nTo));
        return c;
      });
      st.h = s.h;
      st.started = true;
      st.carried = { from: sib[i], build: buildOf(sib[i]), reveals: s.reveals, units: nFrom, strokes: s.strokes.length };
      s.carriedTo = id;
      sset(skey(sib[i]), s);
      return st;
    }
    return null;
  }
  /* Finished attempts on this proof in other builds, newest first: shown read-only in this build. */
  function earlier(id, st) {
    var out = [];
    siblings(id).forEach(function (sid) {
      if (st && st.carried && st.carried.from === sid) return;
      var s = loadState(sid);
      if (s && s.done && s.strokes.length) out.push({ id: sid, build: buildOf(sid), st: s });
    });
    return out.sort(function (a, b) { return (b.st.tDone || 0) - (a.st.tDone || 0); });
  }
  /* What a doc's proofs hold in one build, for the reader's rebuild note: [{id, done, grade, strokes, drill}]. */
  function attemptsIn(docId, version) {
    var F = content().fog || {}, out = [];
    Object.keys(F).forEach(function (fid) {
      var f = F[fid];
      if (!f || f.doc !== docId || (version != null && ((+f.version) || 1) !== +version)) return;
      var s = loadState(fid), a = peekDrill(fid);
      if (s && !idle(s)) out.push({ id: fid, done: !!s.done, grade: s.grade, strokes: s.strokes.length, reveals: s.reveals, carriedTo: s.carriedTo, drill: false });
      else if (a && a.end == null) out.push({ id: fid, done: false, grade: null, strokes: (a.strokes || []).length, reveals: 0, carriedTo: null, drill: true });
    });
    return out;
  }

  /* ---------- the block ---------- */
  function fogBlock(el, id, f, ctx) {
    var basic = f.basic || ctx.docId || '';
    var working = /^worked/i.test(f.title || '');
    var noun = working ? 'working' : 'proof';
    var lvl0 = pushOf(ctx, basic), st = loadState(id);
    if (!st || idle(st)) {
      var cst = carryInto(id, f);
      if (cst) { if (st) { cst.hist = st.hist; cst.hookN = st.hookN; } st = cst; sset(skey(id), st); }
    }
    if (!st) st = blank(MODES[lvl0]);
    else if (idle(st) && st.mode !== MODES[lvl0]) {
      st.moved = { from: st.mode, to: MODES[lvl0], up: lvl0 > MODES.indexOf(st.mode) };
      st.mode = MODES[lvl0];
    }
    var V = {}, ink = null, drillH = null, hookH = null, prevInk = null, destroyed = false, offs = [];
    var lastResT = 0, lastResG = '', autoStart = false, footSig = '', resSig = '';
    /* Level 2 (and level 3 without block-problem.js): mirror the shared drill attempt of this proof (it may
       have been worked in Today). */
    if (st.mode === 'cold' || (st.mode === 'hook' && !(SR.problem && typeof SR.problem.mount === 'function'))) {
      var a0 = drillAttempt(id);
      /* seen: that attempt is already counted; since: after "Try again", only attempts begun later count */
      if (a0 && GRADES.indexOf(a0.grade) >= 0 && +a0.start !== st.seen && +a0.start >= st.since) {
        st.done = true; st.started = true; st.grade = a0.grade; st.res = pickRes(a0.res); st.seen = +a0.start; st.moved = null;
        st.tDone = nowMs();
        st.hist.push({ t: st.tDone, mode: st.mode, grade: a0.grade });
        if (st.hist.length > 12) st.hist.splice(0, st.hist.length - 12);
        sset(skey(id), st);  /* saved now, so a remount does not mirror the same attempt again */
      }
      if (a0 && st.mode === 'cold' && !a0.grade && +a0.start >= st.since) st.open = true;  /* an attempt in progress shows its page */
    }

    function save() { if (!destroyed) sset(skey(id), st); }
    function relayout() { if (ctx.relayout) { try { ctx.relayout(); } catch (e) {} } }
    function units() { return unitsOf(f, st.mode); }
    function inked() { return st.mode === 'steps' || st.mode === 'chunks'; }
    function fresh() { var c = 0; st.strokes.forEach(function (k) { if ((+k.e || 0) === st.reveals) c++; }); return c; }
    function hookId() { return 'thm:' + id + '#' + (st.hookN || 1); }
    /* Level 3 needs block-problem.js and an engine that knows theorem items; without them the old
       "prove it cold" card (the drill in a sheet) stands in. */
    function canHook() { return !!(SR.problem && typeof SR.problem.mount === 'function' && call(ctx, 'problem', [hookId()])); }

    /* ----- rendering ----- */
    function headHtml() {
      return '<div class="fg-h"><span class="sr-kick">' + (working ? 'Working' : 'Proof') + '</span>' +
        '<span class="fg-chip m-' + st.mode + '" title="' + esc(TIP[st.mode]) + '">' + esc(CHIP[st.mode]) + '</span>' +
        '<span class="fg-moved"></span><span class="fg-yours" hidden>yours</span><span class="sp"></span><span class="fg-status"></span></div>' + prevHtml();
    }
    /* A finished attempt on this proof in another build of the doc, read-only behind a disclosure. */
    function prevHtml() {
      var L = earlier(id, st);
      if (!L.length) return '';
      var e = L[0], s = e.st;
      return '<details class="fg-prev" data-prev="' + esc(e.id) + '"><summary>Your attempt on build ' + e.build + ': ' + esc(s.grade) +
        (s.grade === 'clean' ? ' (yours)' : '') + ' · ' + plural(s.strokes.length, 'stroke') + (s.tDone && SR.fmt ? ' · ' + SR.fmt.date(s.tDone) : '') +
        '</summary><div class="fg-prevink"></div></details>';
    }
    function wirePrev() {
      var d = el.querySelector('.fg-prev');
      if (!d) return;
      d.addEventListener('toggle', function () {
        if (!d.open || prevInk || destroyed || !SR.ink) { relayout(); return; }
        var s = loadState(d.getAttribute('data-prev'));
        if (!s) return;
        prevInk = SR.ink.create(d.querySelector('.fg-prevink'), { width: W, height: s.h || H0, strokes: function () { return s.strokes; },
          color: inkColor, readOnly: true, background: ruled, className: 'fg-paper' });
        relayout();
      });
    }
    function inkHtml() {
      var word = st.mode === 'chunks' ? 'part' : 'step';
      return '<div class="fg-alab"><span>Your attempt: write the ' + noun + ' before you lift the fog.</span><span><i class="fg-sw own"></i>before any reveal<i class="fg-sw after"></i>after a reveal</span></div>' +
        '<div class="fg-ink"></div>' +
        '<div class="sr-row fg-tools"><button type="button" data-fog="undo">Undo</button><button type="button" data-fog="more">More paper</button><span class="sp"></span>' +
        '<button type="button" class="primary" data-fog="reveal" aria-label="Reveal the next ' + word + '">Write first</button><button type="button" data-fog="done">Done</button></div>' +
        '<div class="sr-hint fg-need" aria-live="polite"></div><div class="fg-proof"></div>';
    }
    function coldHtml() {
      if (st.open) return '<div class="fg-drill"></div>';
      var rows = Math.min(9, 2 + f.steps.length), had = !!drillAttempt(id);
      return '<div class="sr-fog fg-cold">' + bars(rows, id.length) +
        '<div class="fg-capt"><span>The ' + noun + ' is hidden at this push level. Write it cold on a blank page; Done shows all of it, then you grade it.</span>' +
        '<span class="sp"></span><button type="button" class="primary" data-fog="open">' + (had ? 'Open the blank page' : 'Start on a blank page') + '</button></div></div>';
    }
    function hookHtml() {
      var note = '<p class="sr-hint fg-pushnote">' + esc(pushNote()) + ' <button type="button" class="fg-linkbtn" data-fog="today">Open Today</button></p>';
      if (canHook()) return '<div class="fg-hookpb"></div>' + note;
      return '<div class="fg-hook"><button type="button" class="primary" data-fog="sheet">Prove it cold</button>' +
        '<span class="fg-hook-line">The statement above is the problem now.</span></div>' + note;
    }
    /* Level 3: the problem-first session over this theorem (block-problem.js), inline in the block. */
    function mountHook(host) {
      if (destroyed || hookH || !host) return;
      var item = call(ctx, 'problem', [hookId()]);
      if (!item) return;
      try {
        hookH = SR.problem.mount(host, item, { hook: true, hidden: false, reach: false, relayout: ctx.relayout || null });
      } catch (e) {
        console.error('[SR] fog: the problem-first hook failed to mount:', e);
        host.innerHTML = '<div class="sr-hint fg-nodrill">The problem card failed to load.</div>';
      }
    }
    /* Mirror the hook's session: begun (so the block no longer follows the push level) and settled. */
    function syncHook() {
      if (destroyed || st.mode !== 'hook') return false;
      var hid = hookId(), P = SR.problem, status = P && typeof P.status === 'function' ? P.status(hid) : null;
      var rec = call(ctx, 'settled', [hid]), changed = false;
      if (status && status !== 'new' && !st.started) { st.started = true; st.moved = null; changed = true; }
      if (rec && !st.done) {
        st.done = true; st.started = true; st.moved = null; st.tDone = nowMs();
        st.grade = GRADES.indexOf(rec.grade) >= 0 ? rec.grade : 'moot';
        st.res = pickRes(rec.drill);
        if (st.grade !== 'moot') {
          st.hist.push({ t: st.tDone, mode: 'hook', grade: st.grade });
          if (st.hist.length > 12) st.hist.splice(0, st.hist.length - 12);
        }
        changed = true;
      }
      if (changed) save();
      return changed;
    }
    function pushNote() {
      var bd = docOf(basic) || {}, a = bd.area || ctx.area || '', where = areaLabel(a);
      var plan = call(ctx, 'todayPlan'), sl = plan && plan.slots ? plan.slots[a] : null;
      var kata = (sl && sl.kind === 'kata') || (!sl && (bd.track === 'asic' || a === 'dd'));
      var what = kata ? 'katas whose spec does not name the technique' : 'problems that hide their topic';
      if (sl && sl.hidden > 0) return 'Push mode in ' + where + ': ' + what + ' are now in Today (' + sl.hidden + ' of ' + (sl.filled || sl.total) + ' ' + (kata ? 'kata' : 'problem') + ' slots).';
      return 'Push mode in ' + where + ': one ' + (kata ? 'kata' : 'problem') + ' slot in three in Today now goes to ' + what + '.';
    }
    function render() {
      teardown();
      if (st.mode === 'hook') syncHook();
      el.classList.add('fg', 'no-ink');
      el.classList.toggle('fg-wide', (st.mode === 'cold' && st.open) || st.mode === 'hook');
      el.setAttribute('data-mode', st.mode);
      var h = headHtml();
      if (inked()) h += inkHtml();
      else if (st.mode === 'cold') h += coldHtml();
      else h += hookHtml();
      h += '<div class="sr-hint fg-res" hidden></div><div class="sr-row fg-foot" hidden></div>';
      el.innerHTML = h;
      footSig = ''; resSig = '';
      V = {
        chip: el.querySelector('.fg-chip'), moved: el.querySelector('.fg-moved'), yours: el.querySelector('.fg-yours'),
        status: el.querySelector('.fg-status'), ink: el.querySelector('.fg-ink'), undo: el.querySelector('[data-fog="undo"]'),
        more: el.querySelector('[data-fog="more"]'), reveal: el.querySelector('[data-fog="reveal"]'), done: el.querySelector('[data-fog="done"]'),
        need: el.querySelector('.fg-need'), proof: el.querySelector('.fg-proof'), drill: el.querySelector('.fg-drill'),
        res: el.querySelector('.fg-res'), foot: el.querySelector('.fg-foot'), hookpb: el.querySelector('.fg-hookpb')
      };
      wirePrev();
      if (V.hookpb) mountHook(V.hookpb);
      if (inked() && SR.ink && V.ink) {
        ink = SR.ink.create(V.ink, {
          width: W,
          height: function () { return st.h; },
          strokes: function () { return st.strokes; },
          color: inkColor,
          meta: function () { return { e: st.reveals }; },
          background: ruled,
          readOnly: function () { return !!st.done; },
          className: 'fg-paper',
          onChange: function () {
            if (st.strokes.length) { st.started = true; st.moved = null; }
            save();
            update();
          }
        });
        renderProof();
      }
      if (V.drill) mountInline(V.drill, autoStart);
      autoStart = false;
      update();
      relayout();
    }
    /* The inline drill (block-drill.js) in place of the fog. */
    function mountInline(host, auto) {
      if (destroyed || !host.isConnected || drillH) return;
      host.innerHTML = '';
      drillH = mountDrill(host, false);
      /* One tap on "Start on a blank page" starts the clock; a remount never starts a new attempt. */
      if (auto && drillH && typeof drillH.start === 'function' && (typeof drillH.phase !== 'function' || drillH.phase() === 'idle')) {
        try { drillH.start(); } catch (e) { console.error('[SR] fog: drill start failed:', e); }
      }
    }
    function renderProof() {
      if (!V.proof) return;
      var U = units(), n = U.length, h;
      if (st.done && st.grade === 'clean') {
        V.proof.innerHTML = '<details class="fg-model"><summary>show the model\'s version</summary><div class="fg-msteps">' +
          U.map(function (u, i) { return unitHtml(u, i, n, false); }).join('') + '</div></details>';
        var d = V.proof.querySelector('details');
        d.addEventListener('toggle', function () { if (d.open) typeset(d); relayout(); });
        return;
      }
      h = '<div class="sr-kick fg-ph">The model\'s ' + noun + '</div>';
      U.forEach(function (u, i) {
        if (i < st.reveals) h += unitHtml(u, i, n, false);
        else if (st.done && st.shown) h += unitHtml(u, i, n, true);
        else h += fogUnitHtml(u, i, n);
      });
      V.proof.innerHTML = h;
      typeset(V.proof);
    }
    function unitHtml(u, i, n, late) {
      var chunk = st.mode === 'chunks', head = (chunk ? 'Part ' : 'Step ') + (i + 1) + ' of ' + n, body;
      if (chunk) {
        body = u.map(function (k) {
          var s = f.steps[k] || {};
          return '<div class="fg-sub"><span class="fg-subk">Step ' + (k + 1) + (s.topic ? ' · ' + esc(s.topic) : '') + '</span>' + (s.html || '') + '</div>';
        }).join('');
      } else {
        var s0 = f.steps[u[0]] || {};
        if (s0.topic) head += ' · ' + s0.topic;
        body = s0.html || '';
      }
      return '<div class="fg-step shown' + (late ? ' late' : '') + '" data-u="' + i + '"><div class="fg-stepk">' + esc(head) + (late ? ' · shown after Done' : '') + '</div><div class="fg-body">' + body + '</div></div>';
    }
    function fogUnitHtml(u, i, n) {
      var label = (st.mode === 'chunks' ? 'Part ' : 'Step ') + (i + 1) + ' of ' + n + ', fogged';
      return '<div class="fg-step sr-fog" data-u="' + i + '" aria-label="' + esc(label) + '"><div class="fg-stepk">' + esc(label) + '</div>' +
        bars(st.mode === 'chunks' ? Math.min(8, 2 + u.length) : 3, i + id.length) + '</div>';
    }

    /* ----- status, tools, result, foot ----- */
    function update() {
      if (destroyed || !V.status) return;
      var U = inked() ? units() : null, n = U ? U.length : 0, lv = pushOf(ctx, basic), cur = MODES[lv];
      var yours = st.done && st.grade === 'clean';
      el.classList.toggle('is-done', !!st.done);
      el.classList.toggle('is-yours', yours);
      V.yours.hidden = !yours;
      V.moved.textContent = st.moved && idle(st) ? (st.moved.up ? 'pushed up from ' : 'eased from ') + CHIP[st.moved.from]
        : st.carried && !st.done ? 'continued from build ' + st.carried.build + (st.carried.reveals ? ' (' + st.carried.reveals + ' of ' + st.carried.units + ' revealed there)' : '')
        : '';
      var s = 'not started', cls = '';
      if (st.done && st.grade) {
        s = st.grade; cls = 'g-' + st.grade;
        if (U && st.grade === 'shaky') s += ' · ' + st.reveals + ' of ' + n + ' revealed';
      } else if (U && (st.strokes.length || st.reveals)) s = 'open' + (st.reveals ? ' · ' + st.reveals + ' of ' + n + ' revealed' : '');
      else if (!U && (st.started || st.open)) s = 'open';
      V.status.textContent = s;
      V.status.className = 'fg-status' + (cls ? ' ' + cls : '');
      if (U) updateTools(n);
      updateResult(U, n);
      updateFoot(cur);
    }
    function updateTools(n) {
      var fr = fresh(), total = st.strokes.length, word = st.mode === 'chunks' ? 'part' : 'step', canDone = total >= NEED || st.reveals > 0;
      V.undo.disabled = st.done || !total;
      V.more.disabled = st.done || st.h >= HMAX;
      V.done.hidden = st.done;
      V.done.disabled = !canDone;
      var r = V.reveal, need = '';
      r.classList.add('primary');
      if (st.done) {
        if (st.grade === 'shaky' && !st.shown && st.reveals < n) {
          r.hidden = false; r.disabled = false; r.textContent = 'Show the rest'; r.classList.remove('primary');
          need = 'Attempt closed. Showing the rest does not change the grade.';
        } else r.hidden = true;
      } else if (st.reveals >= n) {
        r.hidden = false; r.disabled = true; r.textContent = 'All revealed';
        need = 'Every ' + word + ' is revealed.';
      } else if (fr < NEED) {
        r.hidden = false; r.disabled = true; r.textContent = 'Write first';
        need = fr + ' of ' + NEED + ' new strokes for the next reveal.';
      } else {
        r.hidden = false; r.disabled = false; r.textContent = 'Reveal ' + word + ' ' + (st.reveals + 1) + ' of ' + n;
        need = 'The next reveal is open.';
      }
      if (!st.done) need += canDone ? ' Done now counts ' + gradeOf(st.reveals, n) + '.' : ' Done needs ' + NEED + ' strokes of your own.';
      V.need.textContent = need;
    }
    function updateResult(U, n) {
      var html = '';
      /* at level 3 the problem session in the block shows its own result */
      if (st.done && st.grade && !(st.mode === 'cold' && st.open) && !(st.mode === 'hook' && hookH)) {
        var word = st.mode === 'chunks' ? 'part' : 'step', head;
        if (U) head = st.grade === 'clean' ? 'Clean: no reveals. Your ink is the ' + noun + ' now; the model\'s version waits behind the link.'
          : st.grade === 'shaky' ? 'Shaky: ' + st.reveals + ' of ' + plural(n, word) + ' revealed.' : 'Failed: every ' + word + ' was revealed.';
        else head = 'Graded ' + st.grade + ' on the blank page.';
        html = esc((head + ' ' + resultText(st.res, basic, !!engineOf(ctx))).trim());
        if (st.grade !== 'clean' && basic && basic !== ctx.docId && docOf(basic)) html += ' Rests on <a class="ref" data-to="' + esc(basic) + '">' + esc(titleOf(basic)) + '</a>.';
      }
      if (html === resSig) return;
      resSig = html;
      V.res.innerHTML = html;
      V.res.hidden = !html;
    }
    function histText() {
      var L = st.hist.slice(0, st.done ? -1 : st.hist.length).slice(-3);
      if (!L.length) return '';
      return 'Earlier: ' + L.map(function (x) { return x.grade + ' (' + (CHIP[x.mode] || x.mode).replace('fog: ', '') + (x.t ? ', ' + (SR.fmt ? SR.fmt.date(x.t) : '') : '') + ')'; }).join(' · ') + '.';
    }
    function updateFoot(cur) {
      var act = null, armed = '', msg = '';
      if (inked()) {
        if (st.done) { act = 'again'; armed = 'Tap again: this page is cleared'; }
        else if (cur !== st.mode && (st.strokes.length || st.reveals)) { msg = 'Push is now at ' + CHIP[cur] + '.'; act = 'over'; armed = 'Tap again: this attempt is dropped'; }
      } else if (st.mode === 'hook' && st.done && cur === 'hook' && hookH) {
        act = 'again'; armed = 'Tap again: a fresh card for this proof';
      } else if (cur !== st.mode && (st.done || st.started || st.open)) {
        act = 'next';
        if (st.mode === 'cold' && st.open && !st.done) { msg = 'Push is now at ' + CHIP[cur] + '.'; armed = 'Tap again to leave this page'; }
        else if (st.mode === 'hook' && !st.done) { msg = 'Push is now at ' + CHIP[cur] + '.'; armed = 'Tap again: this card is dropped'; }
      }
      var label = act === 'again' ? 'Try again at ' + CHIP[cur] : act === 'over' ? 'Start over at ' + CHIP[cur] : act === 'next' ? 'Next attempt at ' + CHIP[cur] : '';
      var hist = histText(), sig = [act, label, armed, msg, hist].join('|');
      if (sig === footSig) return;
      footSig = sig;
      V.foot.innerHTML = '';
      V.foot.hidden = !act && !hist;
      if (msg) V.foot.insertAdjacentHTML('beforeend', '<span class="sr-hint">' + esc(msg) + '</span>');
      if (act) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fg-next';
        b.setAttribute('data-fog-act', act);
        b.textContent = label;
        V.foot.appendChild(b);
        if (armed && SR.twoTap) SR.twoTap(b, armed, restart);
        else b.addEventListener('click', restart);
      }
      if (hist) V.foot.insertAdjacentHTML('beforeend', '<span class="sp"></span><span class="fg-hist">' + esc(hist) + '</span>');
    }

    /* ----- actions ----- */
    function onReveal() {
      var n = units().length;
      if (st.done) {
        if (st.grade === 'shaky' && !st.shown) { st.shown = true; save(); renderProof(); update(); relayout(); }
        return;
      }
      if (st.reveals >= n || fresh() < NEED) return;
      st.reveals++;
      st.started = true; st.moved = null;
      save();
      renderProof();
      update();
      relayout();
      var u = V.proof && V.proof.querySelector('.fg-step[data-u="' + (st.reveals - 1) + '"]');
      if (u && u.scrollIntoView) { try { u.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
    }
    function onDone() {
      var n = units().length;
      if (st.done || !(st.strokes.length >= NEED || st.reveals > 0)) return;
      /* Mark the attempt finished before the engine emits, so this and the other blocks see it closed. */
      st.done = true; st.started = true; st.moved = null; st.tDone = nowMs();
      st.grade = gradeOf(st.reveals, n);
      save();
      var r = call(ctx, 'recordFog', [id, { reveals: st.reveals, steps: n, done: true, basic: basic }]);
      if (r && GRADES.indexOf(r.grade) >= 0) st.grade = r.grade;
      st.res = pickRes(r);
      st.hist.push({ t: st.tDone, mode: st.mode, grade: st.grade, reveals: st.reveals, units: n });
      if (st.hist.length > 12) st.hist.splice(0, st.hist.length - 12);
      save();
      if (ink) { ink.setReadOnly(null); ink.redraw(); }
      renderProof();
      update();
      relayout();
      if (r && r.pushAfter != null && r.pushBefore != null && r.pushAfter !== r.pushBefore) {
        toast(titleOf(basic) + ': push ' + r.pushBefore + ' → ' + r.pushAfter + '. Its other ' + (working ? 'blocks' : 'proofs') + ' not yet started now open at ' + CHIP[MODES[Math.max(0, Math.min(3, r.pushAfter))]] + '.', 5200);
      }
    }
    function restart() {
      var lv = pushOf(ctx, basic), hist = st.hist.slice(), seen = st.seen, hn = (st.hookN || 1) + (st.mode === 'hook' ? 1 : 0);
      st = blank(MODES[lv], hist);
      st.seen = seen;  /* the drill attempt already counted is not mirrored again */
      st.hookN = hn;   /* a settled or dropped hook is not reopened: the next one is a fresh problem card */
      st.since = Date.now();
      save();
      render();
    }
    function onMore() {
      if (st.done) return;
      st.h = Math.min(HMAX, st.h + HSTEP);
      save();
      if (ink) ink.layout();
      update();
      relayout();
    }
    function openCold() {
      autoStart = !drillAttempt(id);
      st.open = true; st.moved = null;
      save();
      render();
    }
    function onStart() {
      if (destroyed || st.started) return;
      st.started = true; st.moved = null;
      save();
      if (st.mode === 'cold' && !st.open) render();  /* started elsewhere: the card now offers to open that page */
      else update();
    }
    function onClick(e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-fog]') : null;
      if (!b || !el.contains(b) || b.disabled) return;
      if (V.drill && V.drill.contains(b)) return;  /* the drill owns its own controls */
      switch (b.getAttribute('data-fog')) {
        case 'undo': if (ink && !st.done) ink.undo(); break;
        case 'more': onMore(); break;
        case 'reveal': onReveal(); break;
        case 'done': onDone(); break;
        case 'open': openCold(); break;
        case 'sheet': openSheet(); break;
        case 'today':
          if (SR.reader && typeof SR.reader.openPanel === 'function') SR.reader.openPanel('today');
          break;
      }
    }

    /* ----- the drill (levels 2 and 3): block-drill.js -----
       A grade arrives through the drill's onGrade(res, attempt) callback and its 'drill:grade' bus event
       (exact fog id), so a grade made in another view of the same proof (Today) is mirrored too. */
    function onGrade(res, att) {
      if (destroyed || !(st.mode === 'cold' || (st.mode === 'hook' && !hookH))) return;   /* hook mode: only the fallback card's drill */
      var g = (res && res.grade) || (att && att.grade);
      if (GRADES.indexOf(g) < 0) return;
      var r = pickRes(res && res.stageAfter != null ? res : null), t = Date.now();
      if (g === lastResG && t - lastResT < 2500) {
        /* The callback and the bus reported the same grade: keep one entry, with the numbers if either had them. */
        if (r && !st.res) { st.res = r; save(); update(); }
        return;
      }
      lastResG = g; lastResT = t;
      var a = att && +att.start > 0 ? att : drillAttempt(id);
      st.started = true; st.done = true; st.grade = g; st.tDone = nowMs(); st.res = r; st.moved = null;
      if (a) st.seen = +a.start;
      st.hist.push({ t: st.tDone, mode: st.mode, grade: g });
      if (st.hist.length > 12) st.hist.splice(0, st.hist.length - 12);
      save();
      update();
      relayout();
    }
    function mountDrill(host, inSheet) {
      /* fixed + choose:false: this proof only, no switcher. Inline, the statement stands right above in the doc. */
      var spec = { fogId: id, basic: basic, steps: f.steps, title: f.title || titleOf(basic), fixed: true, choose: false, source: 'fog',
        onStart: onStart, onGrade: onGrade };
      if (inSheet) spec.statement = f.statement || '';
      var D = SR.drill;
      if (!D || typeof D.run !== 'function') {
        host.innerHTML = '<div class="sr-hint fg-nodrill">The blank-page drill (block-drill.js) is not loaded in this build.</div>';
        return null;
      }
      try { return D.run(host, spec) || null; }
      catch (e) {
        console.error('[SR] fog: SR.drill.run failed:', e);
        host.innerHTML = '<div class="sr-hint fg-nodrill">The blank-page drill failed to start.</div>';
        return null;
      }
    }
    /* block-drill.js has its own drill sheet; open this proof there, without the proof switcher. */
    function openSheet() {
      if (SR.drill && typeof SR.drill.open === 'function') {
        try { if (SR.drill.open(id, { choose: false })) return; } catch (e) { console.error('[SR] fog: SR.drill.open failed:', e); }
      }
      toast('The blank-page drill (block-drill.js) is not loaded in this build.');
    }
    function onDrillEvent(d, evt) {
      if (destroyed || !d || d.fogId !== id || !(st.mode === 'cold' || (st.mode === 'hook' && !hookH))) return;
      if (evt === 'drill:start') onStart();
      else if (evt === 'drill:grade') onGrade(d.res, { grade: d.grade });
    }

    /* ----- engine changes: an idle block follows the push level; others refresh their labels ----- */
    function onEngine() {
      if (destroyed) return;
      syncHook();
      var want = MODES[pushOf(ctx, basic)];
      if (idle(st) && st.mode !== want) {
        st.moved = { from: st.mode, to: want, up: MODES.indexOf(want) > MODES.indexOf(st.mode) };
        st.mode = want;
        save();
        render();
        return;
      }
      update();
    }
    function teardown() {
      if (ink) { try { ink.destroy(); } catch (e) {} ink = null; }
      if (prevInk) { try { prevInk.destroy(); } catch (e) {} prevInk = null; }
      if (drillH && typeof drillH.destroy === 'function') { try { drillH.destroy(); } catch (e) { console.error(e); } }
      drillH = null;
      if (hookH && typeof hookH.destroy === 'function') { try { hookH.destroy(); } catch (e) { console.error(e); } }
      hookH = null;
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      offs.forEach(function (off) { try { off(); } catch (e) {} });
      offs = [];
      teardown();
      el.removeEventListener('click', onClick);
    }

    el.addEventListener('click', onClick);
    render();
    if (SR.bus) {
      offs.push(SR.bus.on('engine:change', onEngine));
      offs.push(SR.bus.on('drill:start', onDrillEvent));
      offs.push(SR.bus.on('drill:grade', onDrillEvent));
      offs.push(SR.bus.on('problem:state', function (d) { if (!destroyed && d && st.mode === 'hook' && d.id === hookId() && syncHook()) update(); }));
    }
    return {
      destroy: destroy,
      id: id,
      mode: function () { return st.mode; },
      state: function () { return JSON.parse(JSON.stringify(st)); }
    };
  }

  /* ---------- styles: injected once; selectors carry two classes so they win over base.css ---------- */
  var CSS = [
    '.blk.fg{margin:12px 0 18px;font:14px/1.45 var(--ui);color:var(--text)}',
    '.page .blk.fg.fg-wide{margin-right:-120px}',
    '.blk.fg .fg-h{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0 0 6px}',
    '.blk.fg .fg-chip{display:inline-block;font:600 11px/1.6 var(--ui);letter-spacing:.02em;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:0 8px;white-space:nowrap;cursor:help}',
    '.blk.fg .fg-chip.m-chunks{border-color:var(--accent);color:var(--accent)}',
    '.blk.fg .fg-chip.m-cold{border-color:var(--accent);background:var(--tint);color:var(--accent)}',
    '.blk.fg .fg-chip.m-hook{border-color:var(--accent);background:var(--accent);color:var(--paper)}',
    '.blk.fg .fg-moved{font-size:12px;color:var(--after)}',
    '.blk.fg .fg-yours{font:650 11px/1.6 var(--ui);background:var(--good);color:var(--paper);border-radius:999px;padding:0 9px;letter-spacing:.02em}',
    '.blk.fg .fg-status{font-size:12px;line-height:1.5;border:1px solid currentColor;border-radius:999px;padding:0 8px;white-space:nowrap;color:var(--muted)}',
    '.blk.fg .fg-status.g-clean{color:var(--good)}.blk.fg .fg-status.g-shaky{color:var(--warn)}.blk.fg .fg-status.g-failed{color:var(--bad)}',
    '.blk.fg .fg-alab{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:2px 10px;font-size:12px;color:var(--muted);margin:2px 0 6px}',
    '.fg-sw{display:inline-block;width:16px;height:3px;border-radius:2px;vertical-align:middle;margin:0 5px 0 8px}',
    '.fg-sw.own{background:var(--ink)}.fg-sw.after{background:var(--after)}',
    '.blk.fg.is-yours .fg-paper{border:2px solid var(--good)}',
    '.blk.fg .fg-tools{margin:6px 0 2px}',
    '.blk.fg .fg-need{margin:2px 0 0;font-size:12.5px}',
    '.blk.fg .fg-proof{margin:10px 0 4px}',
    '.fg .fg-ph{margin:0 0 4px}',
    '.fg .fg-step{margin:8px 0;padding:8px 14px;border-radius:8px}',
    '.fg .fg-step.shown{border-left:3px solid var(--after);border-radius:0 8px 8px 0;padding:6px 4px 6px 12px}',
    '.fg .fg-step.shown.late{border-left-style:dashed}',
    '.fg .fg-stepk{font:600 12px/1.4 var(--ui);color:var(--muted);letter-spacing:.01em;margin-bottom:3px}',
    '.fg .fg-body{font:17px/1.55 var(--serif);color:var(--text)}',
    '.fg .fg-sub{margin:2px 0 10px}',
    '.fg .fg-subk{display:block;font:600 12px/1.4 var(--ui);color:var(--muted);letter-spacing:.01em}',
    '.fg .fg-model{border:1px solid var(--line);border-radius:8px;padding:0 12px;margin:6px 0;background:var(--paper)}',
    '.fg .fg-model>summary{cursor:pointer;color:var(--accent);font:14px/1.4 var(--ui);padding:8px 0}',
    '.blk.fg .fg-res{margin:8px 0 0;font-size:13px;color:var(--muted)}',
    '.blk.fg .fg-foot{margin:8px 0 0}',
    '.blk.fg .fg-hist{font-size:12px;color:var(--muted)}',
    '.blk.fg .fg-cold{padding:10px 14px 12px}',
    '.blk.fg .fg-capt{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font:14px/1.4 var(--ui);color:var(--text);margin-top:4px}',
    '.blk.fg .fg-hook{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 12px;border:1px solid var(--accent);border-radius:10px;background:var(--tint)}',
    '.blk.fg .fg-hook-line{font:15px/1.4 var(--ui)}',
    '.blk.fg .fg-pushnote{margin:8px 0 0;font-size:13px;line-height:1.5}',
    '.blk.fg .fg-linkbtn{font-size:13px;padding:2px 10px;min-height:28px;margin-left:4px;color:var(--accent);border-color:var(--accent);vertical-align:baseline}',
    '.blk.fg .fg-nodrill{padding:10px 0}',
    '.blk.fg .fg-prev{margin:2px 0 8px;font-size:13px;color:var(--muted)}',
    '.blk.fg .fg-prev>summary{cursor:pointer;color:var(--accent);padding:4px 0}',
    '.blk.fg .fg-prevink{margin-top:6px}',
    '.blk.fg .fg-hookpb{margin:4px 0 6px}'
  ].join('\n');
  if (SR.style) SR.style('block-fog', CSS);
  else {
    try { var se = document.createElement('style'); se.id = 'sr-style-block-fog'; se.textContent = CSS; (document.head || document.documentElement).appendChild(se); } catch (e) {}
  }

  /* ---------- registration ---------- */
  function mount(el, id, ctx) {
    var f = fogOf(id);
    if (!f || !Array.isArray(f.steps) || !f.steps.length) {
      el.innerHTML = '<div class="blk-ph">Proof block ' + esc(id) + ' is not in the demo content.</div>';
      return {};
    }
    return fogBlock(el, id, f, ctx || {});
  }
  SR.fog = { MODES: MODES.slice(), CHIP: CHIP, units: unitsOf, grade: gradeOf, stateOf: function (id) { return loadState(id); },
    siblings: siblings, attempts: attemptsIn, mapReveals: mapReveals };
  if (SR.blocks && typeof SR.blocks.register === 'function') SR.blocks.register('fog', { mount: mount });
  else console.error('[SR] block-fog.js: core.js (SR.blocks) is not loaded');
})();

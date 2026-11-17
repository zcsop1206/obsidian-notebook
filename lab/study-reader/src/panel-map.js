/* panel-map.js: the Today and Map panels behind the reader header's Today and Map buttons.
   Today: engine.todayPlan(). The drills due (ranked, with why), the next ship date, the day's problem and
   kata slots with d and E (a hidden-topic pick shows "?" where the topic would be and nothing that names a
   method), and what was settled today. Map: the basics of each track as a graph (fill = drill stage, rings =
   push level, fogged = every prerequisite below stage 2), the sample ledger tasks with ship dates and the
   weak basics that block them (engine.blockers), ratings with sparklines and the stretch band on a
   difficulty ladder, and method-identification accuracy beside solve rate.
   Written by a model for Adit. Not Adit's words. Everything shown is demo data from the simulated engine.
   Plain browser script. Attaches SR.panels = {init, open, today, map, refresh}; the reader's openPanel calls
   SR.panels.today() and SR.panels.map(), and main.js calls SR.panels.init(). */
(function () {
  'use strict';
  var SR = window.SR = window.SR || {};
  var P = SR.panels = SR.panels || {};
  var HAS = Object.prototype.hasOwnProperty;
  var DAY = 864e5;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var AREA_NAMES = { nt: 'Number theory & algebra', cp: 'Combinatorics & probability', an: 'Analysis',
    lg: 'Linear algebra & geometry', dd: 'Digital design', gr: 'General reasoning' };
  var TRACK_NAMES = { putnam: 'Putnam', asic: 'ASIC competition' };
  var TRACK_SHORT = { putnam: 'Putnam', asic: 'ASIC' };
  var CLOSED = /^(done|x|closed|shipped|cancelled|canceled)$/i;
  /* Putnam positions on the d scale: A1/B1 3, A2/B2 4, A3/B3 5.5, A4/B4 6.5, A5/B5 8, A6/B6 9.5. */
  var RUNGS = [[3, 1], [4, 2], [5.5, 3], [6.5, 4], [8, 5], [9.5, 6]];
  var PUSH_TEXT = [
    'Level 0: proofs fogged step by step; each reveal needs 3 new strokes.',
    'Level 1: proof steps merged into two bigger chunks.',
    'Level 2: proofs fully hidden; you write them cold as a blank-page drill.',
    'Level 3: theorems turn into problem-first hooks, and the area gets hidden-topic slots.'
  ];
  var S = { inited: false, sel: null, plan: null, ctx: null, timer: 0 };

  /* ---------- guarded access ---------- */
  function esc(s) {
    if (SR.esc) return SR.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function has(fn) { var e = SR.engine; return !!(e && typeof e[fn] === 'function'); }
  function ecall(fn) {
    var e = SR.engine;
    if (!e || typeof e[fn] !== 'function') return undefined;
    try { return e[fn].apply(e, [].slice.call(arguments, 1)); }
    catch (err) { console.error('[SR] panels: engine.' + fn + ' failed:', err); return undefined; }
  }
  function K(name, d) { var e = SR.engine, c = e && e.constants; return c && c[name] != null ? c[name] : d; }
  function C() { return SR.content || {}; }
  function docMap() { return C().docs || {}; }
  function doc(id) { var m = docMap(); return id && HAS.call(m, id) ? m[id] : null; }
  /* Doc order: content.library first, then any other docs (the reader uses the same order). */
  function docIds() {
    var m = docMap(), out = [], lib = Array.isArray(C().library) ? C().library : [];
    lib.forEach(function (id) { if (HAS.call(m, id) && out.indexOf(id) < 0) out.push(id); });
    Object.keys(m).forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
    return out;
  }
  function title(id) { var d = doc(id); return d && d.title ? String(d.title) : String(id || ''); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).replace(/[\s,:;]+$/, '') + '…' : s; }
  function problems() { return Array.isArray(C().problems) ? C().problems : []; }
  function katas() { return Array.isArray(C().katas) ? C().katas : []; }
  function findById(list, id) { for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i]; return null; }
  function tasks() { return Array.isArray(C().pmTasks) ? C().pmTasks : []; }
  function taskOpen(t) { return !!t && !CLOSED.test(String(t.status || '')); }
  function tests() { return Array.isArray(C().tests) ? C().tests : []; }
  function testOf(track) { var L = tests(); for (var i = 0; i < L.length; i++) if (L[i] && L[i].track === track) return L[i]; return null; }
  function testName(t) { return t.label || TRACK_NAMES[t.track] || t.id || ''; }
  function areaName(a) {
    var ca = (C().areas || {})[a];
    if (ca && ca.label) return String(ca.label);
    return AREA_NAMES[a] || String(a || '');
  }
  function areaList() { var e = SR.engine; return e && Array.isArray(e.AREAS) && e.AREAS.length ? e.AREAS.slice() : Object.keys(AREA_NAMES); }
  function areaTrack(a) { var ca = (C().areas || {})[a]; return (ca && ca.track) || (a === 'dd' ? 'asic' : 'putnam'); }
  function trackName(tr) { return TRACK_NAMES[tr] || String(tr || ''); }
  function methodEntry(id) {
    var m = C().methods || {}, all = [].concat(m.math || [], m.design || []);
    return findById(all, id);
  }
  function methodLabel(id) {
    var l = ecall('methodLabel', id);
    if (l && l !== id) return String(l);
    var e = methodEntry(id);
    return (e && e.label) || String(id);
  }

  /* ---------- dates (YYYY-MM-DD, day arithmetic in UTC like the engine) and numbers ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function dayNum(s) { var a = String(s).split('-'); return Math.round(Date.UTC(+a[0], +a[1] - 1, +a[2]) / DAY); }
  function today() {
    var t = ecall('today');
    if (validDate(t)) return t;
    var d = new Date(SR.now ? SR.now() : Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function nice(s) { if (!validDate(s)) return String(s == null ? '' : s); var a = s.split('-'); return MON[+a[1] - 1] + ' ' + (+a[2]); }
  function niceDow(s) { return validDate(s) ? DOW[new Date(dayNum(s) * DAY).getUTCDay()] + ' ' + nice(s) : nice(s); }
  function daysFrom(s, base) { return dayNum(s) - dayNum(base || today()); }
  function f2(x) { x = +x; return isFinite(x) ? (Math.round(x * 100) / 100).toFixed(2) : '–'; }
  function f1(x) { x = +x; return isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) : '–'; }
  function pct(x) { return x == null || !isFinite(x) ? '–' : Math.round(x * 100) + '%'; }
  function clampStage(n) { n = Math.round(+n || 0); return n < 0 ? 0 : n > 5 ? 5 : n; }
  function clampPush(n) { n = Math.round(+n || 0); return n < 0 ? 0 : n > 3 ? 3 : n; }
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }
  function byDue(a, b) {
    var x = validDate(a.due) ? dayNum(a.due) : Infinity, y = validDate(b.due) ? dayNum(b.due) : Infinity;
    return x - y;
  }

  /* ---------- small shared pieces ---------- */
  function labels() {
    return '<div class="pn-labels"><span class="sr-demo">' + esc(SR.LABEL_DEMO || 'Demo data') + '</span><span class="sr-by">' +
      esc(SR.LABEL_MODEL || "Written by a model for Adit. Not Adit's words.") + '</span></div>';
  }
  function stagePill(stage, push) {
    var s = clampStage(stage), p = clampPush(push);
    return '<span class="sr-stage s' + s + '">stage ' + s + (p ? ' · push ' + p : '') + '</span>';
  }
  function docLink(id) { return '<a class="ref" data-to="' + esc(id) + '">' + esc(title(id)) + '</a>'; }
  /* The top of both panels: labels, then the test countdowns with the panel's buttons beside them.
     The sheet title carries the simulated date. */
  function topRow(day, other) {
    var chips = tests().map(function (t) {
      var n = validDate(t.date) ? daysFrom(t.date, day) : null;
      return '<span class="pn-test"><b>' + esc(testName(t)) + '</b> ' + esc(nice(t.date)) +
        (n == null ? '' : n >= 0 ? ' · <span class="pn-num">' + n + ' d</span>' : ' · past') + '</span>';
    }).join('');
    return labels() + '<div class="pn-row2">' + chips + '<span class="pn-btns"><button type="button" data-act="demo">Demo controls</button>' +
      '<button type="button" data-act="' + other + '">' + (other === 'map' ? 'Map' : 'Today') + ' ›</button></span></div>';
  }
  /* An expected-score gauge: 0..1, the stretch band shaded, a tick at E. */
  function gauge(E) {
    E = +E;
    if (!isFinite(E)) return '';
    var lo = K('E_LO', 0.6), hi = K('E_HI', 0.7), m = Math.max(0, Math.min(1, E));
    return '<span class="pn-gauge" role="img" aria-label="Expected score ' + f2(E) + ', stretch band ' + f2(lo) + ' to ' + f2(hi) + '">' +
      '<span class="b" style="left:' + (lo * 100).toFixed(1) + '%;width:' + ((hi - lo) * 100).toFixed(1) + '%"></span>' +
      '<span class="m" style="left:' + (m * 100).toFixed(1) + '%"></span></span>';
  }
  function bandFlag(x) {
    if (x.hidden) return '<span class="pn-flag after">hidden topic</span>';
    if (x.reach) return '<span class="pn-flag after">reach</span>';
    var E = +x.E, lo = K('E_LO', 0.6), hi = K('E_HI', 0.7);
    var inBand = typeof x.inBand === 'boolean' ? x.inBand : (E >= lo - 1e-9 && E <= hi + 1e-9);
    if (inBand) return '<span class="pn-flag good">in band</span>';
    return E < lo ? '<span class="pn-flag warn">harder than the band</span>' : '<span class="pn-flag muted">easier than the band</span>';
  }
  function foot() {
    return '<p class="pn-foot">' + esc(SR.LABEL_DEMO || 'Demo data') + ': stages, ratings, tasks and dates come from the simulated engine; the tasks are ' +
      'invented sample lines in the format of the task ledger. Demo controls move the clock, make an area comfortable (push mode) or simulate misses.</p>';
  }
  function noEngine(which) {
    var h = '<div class="pn">' + labels() + '<p class="pn-empty">engine.js is not loaded in this build. ' +
      (which === 'map' ? 'Stages, push levels, blockers and ratings all come from it.' : 'The drills, problems and katas for the day all come from it.') + '</p>';
    if (which === 'map' && tasks().length) {
      h += '<div class="pn-kick">Sample ledger lines</div>' + tasks().map(function (t) { return '<code class="pn-line">' + esc(t.line || t.text) + '</code>'; }).join('');
    }
    return h + '</div>';
  }
  function verdictOf(kind, r) {
    if (kind === 'kata') {
      if (r.score === 1) return ['passed first run', 'good'];
      if (r.score > 0) return ['passed after failed runs', 'warn'];
      return [r.gaveUp ? 'gave up' : 'did not pass', 'bad'];
    }
    if (r.verdict === 'moot') return ['moot', 'muted'];
    if (r.verdict === 'held') return r.help ? ['held after help', 'warn'] : ['held', 'good'];
    return [r.verdict === 'blind' ? 'blind' : 'missed', 'bad'];
  }
  /* Every settled problem and kata (engine.settledAll, newest first) with its content item. */
  function settledAll() {
    var out = [];
    (ecall('settledAll') || []).forEach(function (r) {
      /* theorem hooks (push level 3) are not in the problem bank; the engine builds their items */
      var kind = r.kind === 'kata' ? 'kata' : r.kind === 'theorem' ? 'theorem' : 'problem';
      var item = kind === 'theorem' ? ecall('problem', r.id) : findById(kind === 'kata' ? katas() : problems(), r.id);
      if (item) out.push({ kind: kind, item: item, r: r });
    });
    return out;
  }
  function blockersByTask() {
    var out = {};
    (ecall('blockers') || []).forEach(function (b) { if (b && b.task && b.task.id) out[b.task.id] = b; });
    return out;
  }
  function taskStatus(t, b, day) {
    if (!taskOpen(t)) return 'done';
    if (b) return b.atRisk ? 'risk' : 'blocked';
    if (validDate(t.due) && daysFrom(t.due, day) < 0) return 'overdue';
    return 'clear';
  }
  var STATUS = { risk: ['at risk', 'bad'], blocked: ['blocked', 'warn'], overdue: ['overdue', 'bad'], clear: ['clear', 'good'], done: ['done', 'muted'] };

  /* ================= Today ================= */
  function renderToday(sh) {
    if (!has('todayPlan')) { sh.setTitle('Today'); sh.body.innerHTML = noEngine('today'); return; }
    var plan = ecall('todayPlan');
    if (!plan) { sh.body.innerHTML = '<div class="pn">' + labels() + '<p class="pn-empty">The plan for today could not be computed.</p></div>'; return; }
    S.plan = plan;
    var day = plan.day || today();
    sh.setTitle('Today · ' + niceDow(day));
    sh.body.innerHTML = '<div class="pn pn-today">' + todayTop(plan, day) + drillSec(plan, day) + shipCard(day) +
      problemSec(plan) + kataSec(plan) + settledSec(day) + foot() + '</div>';
  }
  function todayTop(plan, day) {
    var push = plan.push || {}, on = Object.keys(push).filter(function (a) { return !!push[a]; });
    var pushHtml = on.length
      ? '<div class="pn-push">' + on.map(function (a) { return '<span class="pn-pchip on">' + esc(areaName(a)) + ': push mode</span>'; }).join('') + '</div>'
      : '<p class="pn-sub">No area in push mode yet. An area enters it when one of its basics reaches push level 3.</p>';
    return '<div class="pn-top">' + topRow(day, 'map') + pushHtml + '</div>';
  }
  function drillSec(plan, day) {
    var L = plan.drills || [];
    var h = '<section class="pn-sec"><h3 class="pn-h">Drills<span class="pn-count">' + (L.length ? L.length + ' due' : 'none due') + '</span></h3>' +
      '<p class="pn-sub">Ranked by the nearest deadline that needs the basic (its test date or the earliest open task that names it); days overdue break ties.</p>';
    if (!L.length) h += nextDueNote(day);
    L.forEach(function (x) { h += drillCard(x); });
    return h + '</section>';
  }
  function nextDueNote(day) {
    var L = (ecall('basics') || []).filter(function (b) { return validDate(b.due) && dayNum(b.due) > dayNum(day); });
    L.sort(function (a, b) { return dayNum(a.due) - dayNum(b.due); });
    if (!L.length) return '<p class="pn-empty">Nothing due.</p>';
    var b = L[0];
    return '<p class="pn-empty">Nothing due today. Next: ' + esc(b.title || title(b.id)) + ' on ' + esc(nice(b.due)) + ' (in ' + daysFrom(b.due, day) + ' d).</p>';
  }
  function deadlineText(dl) {
    if (!dl) return 'No deadline ahead.';
    var what = dl.source === 'test' ? esc(dl.label) : 'task “' + esc(clip(dl.label, 64)) + '”';
    return 'Nearest deadline: ' + what + ' · ' + esc(nice(dl.date)) + ' · ' + (dl.daysLeft != null ? dl.daysLeft + ' d' : '');
  }
  function drillCard(x) {
    var od = +x.overdue || 0, dl = x.deadline;
    var flag = od > 0 ? '<span class="pn-flag bad">' + od + ' d overdue</span>' : '<span class="pn-flag warn">due today</span>';
    var calc = dl && dl.daysLeft != null ? 'deadline in ' + plural(dl.daysLeft, 'day') : 'no deadline ahead';
    return '<div class="pn-item pn-drill" data-basic="' + esc(x.basic) + '">' +
      '<div class="pn-ih"><span class="pn-t">' + esc(title(x.basic)) + '</span>' + stagePill(x.stage, x.push) + '</div>' +
      '<div class="pn-im">' + flag + '<span class="pn-num">' + calc + '</span></div>' +
      '<div class="pn-why">' + deadlineText(x.deadline) + '</div>' +
      '<div class="pn-acts"><button type="button" class="primary" data-act="drill" data-basic="' + esc(x.basic) + '">Drill</button>' +
      '<button type="button" data-act="open" data-doc="' + esc(x.basic) + '">Open basic</button></div></div>';
  }
  /* The soonest open ledger task, and what blocks it: the Today side of the project ledger. */
  function shipCard(day) {
    var byTask = blockersByTask();
    var L = tasks().filter(function (t) { return taskOpen(t) && validDate(t.due) && dayNum(t.due) >= dayNum(day); }).sort(byDue);
    if (!L.length) return '';
    var t = L[0], b = byTask[t.id], st = STATUS[taskStatus(t, b, day)], n = daysFrom(t.due, day);
    var weak = b ? (b.detail || []).map(function (d) {
      return docLink(d.basic) + ' (stage ' + clampStage(d.stage) + '; stage ' + K('KNOWN_STAGE', 3) + ' by ' + esc(nice(d.reachBy)) + (d.atRisk ? ', after the ship date' : '') + ')';
    }).join(', ') : '';
    return '<section class="pn-sec"><h3 class="pn-h">Next ship date</h3><div class="pn-item pn-ship">' +
      '<div class="pn-ih"><span class="pn-t">' + (t.priority ? '<span class="pn-pri" title="priority">!</span> ' : '') + esc(t.text) + '</span><span class="pn-flag ' + st[1] + '">' + st[0] + '</span></div>' +
      '<div class="pn-im"><span class="pn-num">' + esc(nice(t.due)) + ' · ' + n + ' d</span>' + (t.chain ? '<span class="pn-mono">&gt;' + esc(t.chain) + '</span>' : '') + '</div>' +
      '<div class="pn-why">' + (weak ? 'Blocked by ' + weak + '.' : 'Every basic it needs is at stage ' + K('KNOWN_STAGE', 3) + ' or more.') + '</div>' +
      '<div class="pn-acts"><button type="button" data-act="map">All ship dates on the Map ›</button></div></div></section>';
  }
  function slotText(plan, kind) {
    var sl = plan.slots || {}, parts = [];
    Object.keys(sl).forEach(function (a) {
      var m = sl[a];
      if (!m || m.kind !== kind) return;
      var s = areaName(a) + ': ' + m.filled + ' of ' + m.total + ' slots';
      if (m.push) {
        s += kind === 'problem' ? ', push mode, so ' + m.hidden + ' ' + (m.hidden === 1 ? 'comes' : 'come') + ' from another area with the topic hidden'
          : ', push mode: harder katas first, ' + m.hidden + ' with the technique not named';
      } else {
        s += kind === 'problem' ? '; hidden-topic slots open in push mode' : '; simple katas until push mode';
      }
      if (m.reach) s += '; one reach slot after ' + K('CLEAN_RUN', 3) + ' clean in a row';
      parts.push(s + '.');
    });
    var lead = kind === 'problem'
      ? 'Each pick aims at E ≈ ' + f2(K('E_TARGET', 0.65)) + ' (band ' + f2(K('E_LO', 0.6)) + '–' + f2(K('E_HI', 0.7)) + '); hidden-topic picks sit one step easier, because spotting the method is the stretch. '
      : '';
    return esc(lead + parts.join(' '));
  }
  function problemSec(plan) {
    var L = plan.problems || [];
    var h = '<section class="pn-sec"><h3 class="pn-h">Problems<span class="pn-count">' + L.length + '</span></h3><p class="pn-sub">' + slotText(plan, 'problem') + '</p>';
    if (!L.length) h += '<p class="pn-empty">No unsettled problems left near your targets. Reset demo refills the bank.</p>';
    L.forEach(function (x) { h += problemCard(x); });
    return h + '</section>';
  }
  /* Where an open session stands (block-problem.js): a call begun, an attempt running, or a verdict given
     whose method ticks are not saved yet, so the rating has not moved. */
  var SESSION = { call: ['call begun', 'muted'], attempt: ['in progress', 'warn'], settled: ['finish settling: tick the methods', 'bad'] };
  function sessionFlag(id) {
    var P2 = SR.problem, st = P2 && typeof P2.status === 'function' ? P2.status(id) : null, f = st && SESSION[st];
    return f ? '<span class="pn-flag ' + f[1] + '">' + esc(f[0]) + '</span>' : '';
  }
  /* A hidden-topic pick shows its source and number (or "Invented n") and "?": never its area, methods or basics. */
  function problemCard(x) {
    var p = x.problem || findById(problems(), x.id) || {};
    var chips = x.hidden ? '<span class="pn-chip q" title="Topic hidden">?</span>' : '<span class="pn-chip">' + esc(areaName(p.area)) + '</span>';
    if (x.reach) chips += '<span class="pn-chip reach">reach</span>';
    if (x.eased) chips += '<span class="pn-chip eased">eased</span>';
    chips += sessionFlag(x.id);
    return '<button type="button" class="pn-item pn-open" data-act="problem" data-id="' + esc(x.id) + '">' +
      '<span class="pn-ih"><span class="pn-t">' + esc(p.label || x.id) + '</span>' + chips + '<span class="pn-go">Open ›</span></span>' +
      '<span class="pn-im">' + gauge(x.E) + '<span class="pn-num">d ' + f1(x.d) + ' · E ' + f2(x.E) + '</span>' + bandFlag(x) + '</span>' +
      '<span class="pn-why">' + esc(x.why || '') + '</span></button>';
  }
  function kataSec(plan) {
    var L = plan.katas || [];
    var h = '<section class="pn-sec"><h3 class="pn-h">Design katas<span class="pn-count">' + L.length + '</span></h3><p class="pn-sub">' + slotText(plan, 'kata') + '</p>';
    if (!L.length) h += '<p class="pn-empty">No unsettled katas left. Reset demo refills them.</p>';
    L.forEach(function (x) { h += kataCard(x); });
    return h + '</section>';
  }
  function kataCard(x) {
    var k = x.kata || findById(katas(), x.id) || {}, level = x.level || k.level || 'simple';
    var chips = (x.hidden ? '<span class="pn-chip q" title="Technique not named">?</span>' : '<span class="pn-chip">' + esc(areaName(k.area || 'dd')) + '</span>') +
      '<span class="pn-chip' + (level === 'hard' ? ' hard' : '') + '">' + esc(level) + '</span>';
    if (x.reach) chips += '<span class="pn-chip reach">reach</span>';
    return '<button type="button" class="pn-item pn-open" data-act="kata" data-id="' + esc(x.id) + '">' +
      '<span class="pn-ih"><span class="pn-t">' + esc(k.title || x.id) + '</span>' + chips + '<span class="pn-go">Open ›</span></span>' +
      '<span class="pn-im">' + gauge(x.E) + '<span class="pn-num">d ' + f1(x.d) + ' · E ' + f2(x.E) + '</span>' + bandFlag(x) + '</span>' +
      '<span class="pn-why">' + esc(x.why || '') + '</span></button>';
  }
  function settledSec(day) {
    var L = settledAll().filter(function (x) { return x.r.day === day; });
    if (!L.length) return '';
    return '<section class="pn-sec"><h3 class="pn-h">Settled today<span class="pn-count">' + L.length + '</span></h3>' + L.map(settledCard).join('') + '</section>';
  }
  /* After a settle the topic, the methods and the basics behind it may all be shown. */
  function settledCard(x) {
    var r = x.r, it = x.item, v = verdictOf(x.kind, r);
    var name = x.kind === 'kata' ? (it.title || it.id) : (it.label || it.id);
    var scored = r.score !== null && r.score !== undefined;
    var dr = (+r.rAfter) - (+r.rBefore), g = r.drill;
    var rate = x.kind === 'theorem'
      ? (g ? esc(title(it.basic)) + ' stage ' + g.stageBefore + ' → ' + g.stageAfter + ' (graded ' + esc(g.grade) + '); a proof at push 3 does not move the rating' : 'Moot: nothing counted.')
      : scored ? esc(areaName(r.area)) + ' r ' + f2(r.rBefore) + ' → ' + f2(r.rAfter) + ' (' + (dr >= 0 ? '+' : '') + f2(dr) + ') at E ' + f2(r.E)
      : 'Moot: no rating change.';
    var meth = '';
    if (scored) {
      if (r.methodsPending) meth = 'Method ticks not given yet, so method identification is not counted.';
      else if (r.methodHit === true) meth = 'Your call named every method it took.';
      else if (r.methodHit === false) {
        var miss = (r.took || []).filter(function (m) { return (r.called || []).indexOf(m) < 0; });
        meth = 'Your call missed ' + miss.map(methodLabel).join(', ') + '.';
      }
    }
    var missed = scored && (r.score === 0 || r.methodHit === false);
    var back = missed && Array.isArray(r.linksBack) && r.linksBack.length
      ? '<span class="pn-why">Back to the basics it used: ' + r.linksBack.filter(function (b) { return !!doc(b); }).map(docLink).join(', ') + '</span>' : '';
    var gapDoc = r.recognitionGap && doc(r.recognitionGap.doc) ? r.recognitionGap.doc : null;
    var gap = r.recognitionGap && r.recognitionGap.note ? '<span class="pn-note">' + esc(r.recognitionGap.note) + '</span>' : '';
    return '<div class="pn-item pn-settled">' +
      '<div class="pn-ih"><span class="pn-t">' + esc(name) + '</span>' + (r.hidden ? '<span class="pn-chip q">was hidden</span>' : '') +
      '<span class="pn-flag ' + v[1] + '">' + esc(v[0]) + '</span></div>' +
      '<div class="pn-im"><span class="pn-num">' + rate + '</span></div>' +
      (meth ? '<div class="pn-why">' + esc(meth) + '</div>' : '') + back + gap +
      '<div class="pn-acts">' + (x.kind === 'theorem'
        ? '<button type="button" data-act="open" data-doc="' + esc(it.doc || it.basic) + '">Open ' + esc(clip(title(it.doc || it.basic), 28)) + '</button>'
        : '<button type="button" data-act="' + x.kind + '" data-id="' + esc(it.id) + '" data-settled="1">Open</button>') +
      (gapDoc ? '<button type="button" data-act="changes" data-doc="' + esc(gapDoc) + '">Recognise list of ' + esc(clip(title(gapDoc), 32)) + '</button>' : '') + '</div></div>';
  }

  /* ================= Map ================= */
  function renderMap(sh) {
    if (!has('basics')) { sh.body.innerHTML = noEngine('map'); return; }
    var day = today(), basics = ecall('basics') || [], bl = ecall('blockers') || [];
    var ctx = { day: day, basics: basics, info: {}, blockers: bl, byTask: {}, blockedBy: {} };
    basics.forEach(function (b) { ctx.info[b.id] = b; });
    bl.forEach(function (b) {
      if (!b || !b.task) return;
      ctx.byTask[b.task.id] = b;
      (b.weakBasics || []).forEach(function (id) { (ctx.blockedBy[id] = ctx.blockedBy[id] || []).push(b); });
    });
    S.ctx = ctx;
    if (S.sel && !ctx.info[S.sel] && !doc(S.sel)) S.sel = null;
    sh.setTitle('Map · ' + niceDow(day));
    sh.body.innerHTML = '<div class="pn pn-map">' + mapTop(ctx) + mapNav() + basicsSec(ctx) + shipSec(ctx) + ratingsSec(ctx) + methodsSec() + foot() + '</div>';
    layoutGraphs(sh.body);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { if (!sh.closed) layoutGraphs(sh.body); });
  }
  function mapTop(ctx) { return '<div class="pn-top">' + topRow(ctx.day, 'today') + '</div>'; }
  function mapNav() {
    return '<nav class="pn-nav" aria-label="Map sections">' + [['basics', 'Basics'], ['ship', 'Ship dates'], ['ratings', 'Ratings'], ['methods', 'Methods']].map(function (x) {
      return '<button type="button" data-act="jump" data-jump="' + x[0] + '">' + x[1] + '</button>';
    }).join('') + '</nav>';
  }

  /* ---------- basics graph ---------- */
  function legend() {
    var sw = '';
    for (var i = 0; i <= 5; i++) sw += '<span class="pn-sw s' + i + '">' + i + '</span>';
    return '<div class="pn-legend"><span>Drill stage</span>' + sw +
      '<span class="pn-lg"><span class="pn-ringdemo"></span>push level: one ring per level, 3 rings = push mode</span>' +
      '<span class="pn-lg"><span class="pn-fogdemo"></span>fogged: every prerequisite below stage 2</span>' +
      '<span class="pn-lg"><span class="pn-topicdemo"></span>topic doc</span></div>';
  }
  function trackRank(tr) { var o = ['putnam', 'asic']; var i = o.indexOf(tr); return i < 0 ? 9 : i; }
  function basicsSec(ctx) {
    var tracks = [];
    ctx.basics.forEach(function (b) { if (tracks.indexOf(b.track) < 0) tracks.push(b.track); });
    tracks.sort(function (a, b) { return trackRank(a) - trackRank(b); });
    var h = '<section class="pn-sec" data-sec="basics"><h3 class="pn-h">Basics<span class="pn-count">' + plural(ctx.basics.length, 'basic') + '</span></h3>' +
      '<p class="pn-sub">Each basic rests on the ones above it. Intervals by stage: ' + K('INTERVALS', [1, 2, 4, 7, 14, 30]).join(', ') +
      ' days (clean +1, shaky stays, failed back to 0), capped near a deadline. Tap a basic for its due date, deadline and the tasks it blocks.</p>' + legend();
    if (!tracks.length) h += '<p class="pn-empty">No basics in the demo content.</p>';
    h += '<div class="pn-tracks">' + tracks.map(function (tr) { return trackHtml(tr, ctx); }).join('') + '</div>';
    return h + '<div class="pn-detail" aria-live="polite">' + detailHtml(S.sel, ctx) + '</div></section>';
  }
  /* Layers by longest path from the track's roots; topic docs sit below the basics they rest on. */
  function graphOf(tr, ctx) {
    var ids = ctx.basics.filter(function (b) { return b.track === tr; }).map(function (b) { return b.id; });
    var topics = docIds().filter(function (id) { var d = doc(id); return d && d.kind === 'topic' && (d.track || areaTrack(d.area)) === tr; });
    var all = ids.concat(topics), order = docIds(), needs = {}, layer = {};
    all.forEach(function (id) {
      var nd = ctx.info[id] ? ctx.info[id].needs : ((doc(id) || {}).needs || []);
      needs[id] = (nd || []).filter(function (x, i, a) { return x !== id && all.indexOf(x) >= 0 && a.indexOf(x) === i; });
    });
    function L(id, seen) {
      if (layer[id] != null) return layer[id];
      if (seen[id]) return 0;
      seen[id] = 1;
      var m = -1;
      needs[id].forEach(function (x) { m = Math.max(m, L(x, seen)); });
      return (layer[id] = m + 1);
    }
    all.forEach(function (id) { L(id, {}); });
    var layers = [];
    all.forEach(function (id) { (layers[layer[id]] = layers[layer[id]] || []).push(id); });
    layers = layers.filter(Boolean);
    layers.forEach(function (row) { row.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); }); });
    var li = {};
    layers.forEach(function (row, i) { row.forEach(function (id) { li[id] = i; }); });
    var edges = [];
    all.forEach(function (id) {
      var isTopic = !ctx.info[id];
      needs[id].forEach(function (x) {
        var soft = ctx.info[x] && clampStage(ctx.info[x].stage) < 2 ? 1 : 0;
        edges.push([x, id, isTopic ? 'uses' : 'pre', soft]);
      });
    });
    return { all: all, layers: layers, li: li, needs: needs, edges: edges };
  }
  function fogged(id, g, ctx) {
    var nd = (g.needs[id] || []).filter(function (x) { return !!ctx.info[x]; });
    return nd.length > 0 && nd.every(function (x) { return clampStage(ctx.info[x].stage) < 2; });
  }
  function trackHtml(tr, ctx) {
    var g = graphOf(tr, ctx), t = testOf(tr), n = t && validDate(t.date) ? daysFrom(t.date, ctx.day) : null;
    var mine = ctx.basics.filter(function (b) { return b.track === tr; });
    var due = mine.filter(function (b) { return b.overdue >= 0; }).length;
    var below = mine.filter(function (b) { return clampStage(b.stage) < K('KNOWN_STAGE', 3); }).length;
    var head = '<div class="pn-trh"><b>' + esc(trackName(tr)) + '</b>' +
      '<span class="pn-muted">' + (t && validDate(t.date) ? 'test ' + esc(nice(t.date)) + (n != null ? (n >= 0 ? ' · ' + n + ' d' : ' · past') : '') : 'no test date') + '</span>' +
      '<span class="pn-trs">' + plural(mine.length, 'basic') + ' · ' + due + ' due · ' + below + ' below stage ' + K('KNOWN_STAGE', 3) + '</span></div>';
    var body = '<div class="pn-graph" data-track="' + esc(tr) + '" data-edges="' + esc(JSON.stringify(g.edges)) + '">' +
      '<svg class="pn-edges" aria-hidden="true" focusable="false"></svg>';
    g.layers.forEach(function (row, i) {
      body += '<div class="pn-layer">' + row.map(function (id) { return nodeHtml(id, i, g, ctx); }).join('') + '</div>';
    });
    return '<div class="pn-track">' + head + body + '</div>' + unmapped(tr, ctx) + '</div>';
  }
  function nodeHtml(id, li, g, ctx) {
    var b = ctx.info[id], fog = fogged(id, g, ctx), sel = S.sel === id;
    var base = ' data-act="node" data-node="' + esc(id) + '" data-layer="' + li + '"' + (sel ? ' aria-current="true"' : '');
    if (!b) {
      var cues = has('recognise') ? (ecall('recognise', id) || []).length : 0;
      return '<button type="button" class="pn-node topic' + (fog ? ' fog' : '') + (sel ? ' pn-sel' : '') + '"' + base + ' data-ring="0">' +
        '<span class="pn-nt">' + esc(title(id)) + '</span><span class="pn-nm">topic doc · rests on ' + plural(g.needs[id].length, 'basic') +
        (cues ? ' · ' + plural(cues, 'cue') + ' to recognise' : '') + '</span></button>';
    }
    var st = clampStage(b.stage), pu = clampPush(b.push), flags = '';
    if (b.overdue > 0) flags += '<span class="pn-flag bad">' + b.overdue + ' d overdue</span>';
    else if (b.overdue === 0) flags += '<span class="pn-flag warn">due today</span>';
    var bl = ctx.blockedBy[id] || [];
    if (bl.length) {
      var risk = bl.some(function (x) { return (x.detail || []).some(function (d) { return d.basic === id && d.atRisk; }); });
      flags += '<span class="pn-flag ' + (risk ? 'bad' : 'warn') + '">blocks ' + plural(bl.length, 'task') + '</span>';
    }
    if (b.version > 1) flags += '<span class="pn-flag after">build ' + b.version + '</span>';
    if (fog) flags += '<span class="pn-flag muted">fogged</span>';
    return '<button type="button" class="pn-node s' + st + ' p' + pu + (fog ? ' fog' : '') + (sel ? ' pn-sel' : '') + '"' + base + ' data-ring="' + (pu * 5) + '">' +
      '<span class="pn-nt">' + esc(b.title || title(id)) + '</span><span class="pn-nm">stage ' + st + ' · push ' + pu + '</span>' +
      (flags ? '<span class="pn-flags">' + flags + '</span>' : '') + '</button>';
  }
  /* Areas of a track with no basics written: fog of war at the area level. */
  function unmapped(tr, ctx) {
    var withB = {};
    ctx.basics.forEach(function (b) { withB[b.area] = 1; });
    var L = areaList().filter(function (a) { return areaTrack(a) === tr && !withB[a]; });
    if (!L.length) return '';
    return '<div class="pn-fogrow"><span class="pn-kick">Not mapped yet</span>' + L.map(function (a) {
      var r = ecall('rating', a);
      return '<span class="pn-fogchip">' + esc(areaName(a)) + (r != null ? ' · r ' + f2(r) : '') + '</span>';
    }).join('') + '<span class="pn-hint2">No basics written for these areas yet; they are rated from problems only, and supply hidden-topic picks.</span></div>';
  }

  /* Edges are drawn after layout: nodes are ordinary buttons (they wrap text), the SVG under them is
     sized to the graph box. Neighbouring layers get a vertical curve; an edge that skips a layer runs
     in a lane on the right, inner lanes for shorter spans. Ends stop outside a node's push rings. */
  function layoutGraphs(root) {
    if (!root) return;
    [].forEach.call(root.querySelectorAll('.pn-graph'), drawEdges);
  }
  function drawEdges(g) {
    var svg = g.querySelector('svg.pn-edges');
    if (!svg) return;
    var W = g.clientWidth, H = g.clientHeight, gr = g.getBoundingClientRect();
    if (!W || !H || !gr.width) return;
    var k = W / gr.width, edges;
    try { edges = JSON.parse(g.getAttribute('data-edges') || '[]'); } catch (e) { edges = []; }
    var pos = {};
    [].forEach.call(g.querySelectorAll('[data-node]'), function (el) {
      var r = el.getBoundingClientRect();
      pos[el.getAttribute('data-node')] = { l: (r.left - gr.left) * k, t: (r.top - gr.top) * k, r: (r.right - gr.left) * k, b: (r.bottom - gr.top) * k,
        layer: +el.getAttribute('data-layer') || 0, ring: +el.getAttribute('data-ring') || 0 };
    });
    var tr = String(g.getAttribute('data-track') || 'x').replace(/[^\w-]/g, '');
    var near = [], skip = [];
    edges.forEach(function (e) {
      var a = pos[e[0]], b = pos[e[1]];
      if (!a || !b) return;
      (b.layer - a.layer > 1 ? skip : near).push({ a: a, b: b, kind: e[2], soft: !!e[3] });
    });
    skip.sort(function (x, y) { return (x.b.layer - x.a.layer) - (y.b.layer - y.a.layer) || x.a.layer - y.a.layer; });
    var out = [];
    function cls(e) { return 'pn-edge ' + (e.kind === 'uses' ? 'uses' : 'pre') + (e.soft ? ' soft' : ''); }
    function mk(e) { return 'url(#pn-ar-' + tr + (e.kind === 'uses' ? '-a' : '-m') + ')'; }
    near.forEach(function (e) {
      var a = e.a, b = e.b, x1 = (a.l + a.r) / 2, y1 = a.b + a.ring, x2 = (b.l + b.r) / 2, y2 = b.t - b.ring - 2, my = (y1 + y2) / 2;
      out.push('<path class="' + cls(e) + '" d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'C' + x1.toFixed(1) + ' ' + my.toFixed(1) + ' ' +
        x2.toFixed(1) + ' ' + my.toFixed(1) + ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '" marker-end="' + mk(e) + '"/>');
    });
    skip.forEach(function (e, i) {
      var a = e.a, b = e.b, sx = a.r + a.ring, sy = (a.t + a.b) / 2, ex = b.r + b.ring + 2, ey = (b.t + b.b) / 2;
      /* a cubic with both control points at x = cx peaks at 0.125 (sx + ex) + 0.75 cx: put the peak on the lane */
      var bulge = Math.max(a.r + a.ring, b.r + b.ring) + 12 + 11 * i, cx = (bulge - 0.125 * (sx + ex)) / 0.75;
      out.push('<path class="' + cls(e) + '" d="M' + sx.toFixed(1) + ' ' + sy.toFixed(1) + 'C' + cx.toFixed(1) + ' ' + sy.toFixed(1) + ' ' +
        cx.toFixed(1) + ' ' + ey.toFixed(1) + ' ' + ex.toFixed(1) + ' ' + ey.toFixed(1) + '" marker-end="' + mk(e) + '"/>');
    });
    var defs = '<defs>' + ['m', 'a'].map(function (c) {
      return '<marker id="pn-ar-' + tr + '-' + c + '" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto">' +
        '<path class="pn-arrow' + (c === 'a' ? ' a' : '') + '" d="M0 0L10 5L0 10z"/></marker>';
    }).join('') + '</defs>';
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.innerHTML = defs + out.join('');
  }

  /* ---------- detail of the selected node ---------- */
  function pips(n) { var h = '<span class="pn-pips" aria-hidden="true">'; for (var i = 1; i <= 5; i++) h += '<i' + (i <= n ? ' class="f"' : '') + '></i>'; return h + '</span>'; }
  function detailHtml(id, ctx) {
    if (!id || (!ctx.info[id] && !doc(id))) {
      return '<p class="pn-empty">Tap a basic for its stage, push level, due date, nearest deadline, what it rests on and feeds, and the tasks it blocks.</p>';
    }
    var b = ctx.info[id], d = doc(id) || {};
    var feeds = docIds().filter(function (x) { var dx = doc(x); return dx && (dx.needs || []).indexOf(id) >= 0; });
    var tks = tasks().filter(function (t) { return (t.needs || []).indexOf(id) >= 0; }).sort(byDue);
    /* each task that needs this doc: "blocked here" when this basic is one of its blockers, else the task's own status */
    var taskRows = tks.length ? tks.map(function (t) {
      var bk = ctx.byTask[t.id], det = bk ? (bk.detail || []).filter(function (x) { return x.basic === id; })[0] : null;
      var st = STATUS[taskStatus(t, bk, ctx.day)], others = bk ? (bk.weakBasics || []).filter(function (x) { return x !== id; }) : [];
      var flag = det ? '<span class="pn-flag ' + (det.atRisk ? 'bad' : 'warn') + '">' + (det.atRisk ? 'blocked here, at risk' : 'blocked here') + '</span>'
        : '<span class="pn-flag ' + st[1] + '">' + st[0] + '</span>';
      var note = det ? 'stage ' + K('KNOWN_STAGE', 3) + ' by ' + esc(nice(det.reachBy)) + ' with clean drills' : '';
      if (others.length) note += (note ? '; ' : '') + (det ? 'also blocked by ' : 'by ') + others.map(function (x) { return esc(title(x)); }).join(', ');
      return '<li>' + esc(clip(t.text, 70)) + ' <span class="pn-muted">· ' + esc(nice(t.due)) + '</span> ' + flag +
        (note ? ' <span class="pn-muted">' + note + '</span>' : '') + '</li>';
    }).join('') : '';
    var g = null;
    ctx.basics.some(function (x) { if (x.id === id) { g = graphOf(x.track, ctx); return true; } return false; });
    if (!b) {
      /* a topic doc */
      var cues = has('recognise') ? (ecall('recognise', id) || []) : [];
      var uses = (d.needs || []).filter(function (x) { return !!ctx.info[x]; });
      return '<div class="pn-dcard"><div class="pn-dh"><span class="pn-dt">' + esc(title(id)) + '</span><span class="pn-chip">topic doc</span><span class="pn-sp"></span>' +
        '<button type="button" class="primary" data-act="open" data-doc="' + esc(id) + '">Open</button></div>' +
        '<div class="pn-sub">' + esc(areaName(d.area)) + ' · ' + esc(trackName(d.track || areaTrack(d.area))) + '</div>' +
        '<dl class="pn-kv"><dt>Rests on</dt><dd>' + (docItems(uses) || 'nothing in the map') + '</dd>' +
        '<dt>Recognise</dt><dd>' + plural(cues.length, 'cue') + ' logged from settled problems <button type="button" data-act="changes" data-doc="' + esc(id) + '">Open Changes</button></dd>' +
        (taskRows ? '<dt>Tasks</dt><dd><ul class="pn-list">' + taskRows + '</ul></dd>' : '') + '</dl></div>';
    }
    var st = clampStage(b.stage), pu = clampPush(b.push), od = +b.overdue;
    var gg = g || { needs: {} };
    var fog = g ? fogged(id, g, ctx) : false;
    var dueTxt = od > 0 ? od + ' d overdue' : od === 0 ? 'due today' : 'in ' + (-od) + ' d';
    var last = b.last ? esc(b.last.grade || '') + (b.last.day ? ' · ' + esc(nice(b.last.day)) : '') + ' · stage ' + b.last.from + ' → ' + b.last.to +
      (b.last.src === 'seed' ? ' <span class="pn-muted">(seeded)</span>' : '') : 'none yet';
    var hist = ecall('drillHistory', id) || [];
    var rests = (b.needs || []).filter(function (x) { return !!doc(x); });
    function docItems(ids) {
      if (!ids.length) return '';
      var bs = ids.filter(function (x) { return !!ctx.info[x]; }), ts = ids.filter(function (x) { return !ctx.info[x]; });
      return bs.map(function (x) { return '<span class="pn-li">' + docLink(x) + ' ' + stagePill(ctx.info[x].stage, ctx.info[x].push) + '</span>'; })
        .concat(ts.map(function (x) { return '<span class="pn-li">' + docLink(x) + ' <span class="pn-muted">topic doc</span></span>'; })).join('');
    }
    return '<div class="pn-dcard"><div class="pn-dh"><span class="pn-dt">' + esc(b.title || title(id)) + '</span>' + stagePill(st, pu) + '<span class="pn-sp"></span>' +
      '<button type="button" class="primary" data-act="drill" data-basic="' + esc(id) + '">Drill</button>' +
      '<button type="button" data-act="open" data-doc="' + esc(id) + '">Open</button></div>' +
      '<div class="pn-sub">' + esc(areaName(b.area)) + ' · ' + esc(trackName(b.track)) + ' · build ' + (b.version || 1) + (b.rebuilt ? ' (rebuilt from its prerequisites)' : '') + '</div>' +
      '<dl class="pn-kv">' +
      '<dt>Stage</dt><dd>' + st + ' of 5 ' + pips(st) + '</dd>' +
      '<dt>Push</dt><dd>' + esc(PUSH_TEXT[pu]) + '</dd>' +
      '<dt>Due</dt><dd>' + esc(nice(b.due)) + ' · ' + dueTxt + '</dd>' +
      '<dt>Deadline</dt><dd>' + deadlineText(b.deadline).replace(/^Nearest deadline: /, '') + '</dd>' +
      '<dt>Last result</dt><dd>' + last + '</dd>' +
      (hist.length > 1 ? '<dt>History</dt><dd>' + stageSpark(hist) + histText(hist) + '</dd>' : '') +
      '<dt>Rests on</dt><dd>' + (docItems(rests) || 'nothing in the map') + '</dd>' +
      '<dt>Feeds</dt><dd>' + (docItems(feeds) || 'nothing yet') + '</dd>' +
      '<dt>Tasks</dt><dd>' + (taskRows ? '<ul class="pn-list">' + taskRows + '</ul>' : 'no ledger task needs it') + '</dd></dl>' +
      (fog ? '<p class="pn-note">Fogged: everything it rests on (' + (gg.needs[id] || []).map(title).map(esc).join(', ') + ') is below stage 2. Firm those up first.</p>' : '') +
      (b.weak ? '<p class="pn-note">Weak (stage 1 or below, or its last drill failed): a lost mark on a passage that rests on it rebuilds this basic whole, free of the rewrite budget.</p>' : '') +
      '</div>';
  }

  /* The stage after each graded retrieval of a basic (engine.drillHistory), as a step line over 0..5. */
  var SRC_TEXT = { seed: 'seeded', drill: 'drill', fog: 'proof', demo: 'demo' };
  function stageSpark(hist) {
    var L = hist.slice(-12), w = 132, h = 34, n = L.length;
    function x(i) { return n < 2 ? w - 6 : 6 + i * (w - 12) / (n - 1); }
    function y(st) { return h - 5 - clampStage(st) / 5 * (h - 10); }
    var d = 'M' + x(0).toFixed(1) + ' ' + y(L[0].to).toFixed(1);
    for (var i = 1; i < n; i++) d += 'H' + x(i).toFixed(1) + 'V' + y(L[i].to).toFixed(1);
    var dots = L.map(function (e, i) {
      return '<circle class="' + esc(e.grade || '') + '" cx="' + x(i).toFixed(1) + '" cy="' + y(e.to).toFixed(1) + '" r="2.6"/>';
    }).join('');
    return '<svg class="pn-hspark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Stage after each of the last ' +
      plural(n, 'result') + '"><path d="' + d + '"/>' + dots + '</svg>';
  }
  function histText(hist) {
    return '<span class="pn-muted pn-htext">' + hist.slice(-4).reverse().map(function (e) {
      return esc((e.grade || '?') + ' ' + nice(e.day) + ' (' + (SRC_TEXT[e.src] || e.src || '') + ', ' + e.from + '→' + e.to + ')');
    }).join(' · ') + '</span>';
  }

  /* ---------- ship dates: the sample ledger tasks, their chains and blockers ---------- */
  function scaleFor(day, open) {
    var start = dayNum(day), end = start + 7;
    open.forEach(function (t) { if (validDate(t.due)) end = Math.max(end, dayNum(t.due)); });
    tests().forEach(function (t) { if (validDate(t.date)) end = Math.max(end, dayNum(t.date)); });
    return {
      start: start, end: end,
      at: function (s) { return validDate(s) ? Math.max(0, Math.min(100, (dayNum(s) - start) / (end - start) * 100)) : null; }
    };
  }
  function axisLabel(p, text, row) {
    var al = p < 9 ? 'l' : p > 91 ? 'r' : 'c';
    return '<span class="pn-al ' + row + ' ' + al + '" style="left:' + p.toFixed(2) + '%">' + esc(text) + '</span>';
  }
  function axisHtml(sc) {
    var h = '<div class="pn-axis" aria-hidden="true">';
    tests().forEach(function (t) {
      if (!validDate(t.date) || dayNum(t.date) < sc.start) return;
      var p = sc.at(t.date);
      h += '<span class="tk" style="left:' + p.toFixed(2) + '%"></span>' + axisLabel(p, (TRACK_SHORT[t.track] || testName(t)) + ' ' + nice(t.date), 'top');
    });
    var d = new Date(sc.start * DAY);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    for (var guard = 0; guard < 24 && d.getTime() / DAY <= sc.end; guard++) {
      var p2 = (d.getTime() / DAY - sc.start) / (sc.end - sc.start) * 100;
      h += '<span class="mt" style="left:' + p2.toFixed(2) + '%"></span>' + axisLabel(p2, MON[d.getUTCMonth()] + ' 1', 'bot');
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return h + '</div>';
  }
  function chainsHtml(all, ctx) {
    var map = {}, order = [];
    all.forEach(function (t) {
      if (!t || !t.chain) return;
      var s = String(t.chain), i = s.indexOf('/'), name = i < 0 ? s : s.slice(0, i);
      var kind = i < 0 ? (t.project === 'putnam' ? 'course' : 'build') : s.slice(i + 1);
      if (!map[name]) { map[name] = []; order.push(name); }
      map[name].push({ t: t, kind: kind });
    });
    return order.map(function (name) {
      var steps = map[name], next = null, kinds = {}, kindOrder = [];
      for (var i = 0; i < steps.length; i++) if (taskOpen(steps[i].t)) { next = steps[i].t.id; break; }
      steps.forEach(function (s) { if (!kinds[s.kind]) kindOrder.push(s.kind); kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
      var summary = kindOrder.map(function (k) { return kinds[k] + ' ' + k; }).join(', ');
      if (kinds.build && !kinds.ship && !kinds.reach) summary += ' · no ship or reach step: work nobody will see';
      var body = steps.map(function (s, j) {
        var t = s.t, st = taskStatus(t, ctx.byTask[t.id], ctx.day), isNext = t.id === next;
        var tag = st === 'done' ? 'done' : (isNext ? 'next · ' : '') + STATUS[st][0];
        return (j ? '<span class="pn-sep" aria-hidden="true">→</span>' : '') +
          '<span class="pn-step ' + st + (isNext ? ' next' : '') + '"><b>' + esc(clip(t.text, 58)) + '</b><small>' + esc(nice(t.due)) + ' · ' + esc(s.kind) + ' · ' + esc(tag) + '</small></span>';
      }).join('');
      return '<div class="pn-chain"><div class="pn-chain-h"><span class="pn-mono">&gt;' + esc(name) + '</span><span class="pn-muted">' + esc(summary) + '</span></div>' +
        '<div class="pn-steps">' + body + '</div></div>';
    }).join('');
  }
  function taskRow(t, sc, ctx) {
    var b = ctx.byTask[t.id], st = taskStatus(t, b, ctx.day), lab = STATUS[st];
    var n = validDate(t.due) ? daysFrom(t.due, ctx.day) : null;
    var h = '<div class="pn-task ' + st + '"><div class="pn-task-h">' +
      '<span class="pn-date">' + (validDate(t.due) ? esc(nice(t.due)) : 'no date') + '<small>' + (n == null ? '' : n > 0 ? n + ' d left' : n === 0 ? 'due today' : (-n) + ' d over') + '</small></span>' +
      '<span class="pn-task-t">' + (t.priority ? '<span class="pn-pri" title="priority">!</span> ' : '') + esc(t.text) + '</span>' +
      '<span class="pn-flag ' + lab[1] + '">' + lab[0] + '</span></div>';
    /* runway: today at the left edge, the ship date as a diamond, a dot where each blocking basic reaches stage 3 */
    var dp = sc.at(t.due), aria = 'Runway to ' + nice(t.due);
    h += '<div class="pn-run" role="img" aria-label="' + esc(aria) + '"><span class="rail"></span>';
    tests().forEach(function (x) { var p = sc.at(x.date); if (p != null && p > 0) h += '<span class="tst" style="left:' + p.toFixed(2) + '%"></span>'; });
    if (dp != null) h += '<span class="win ' + st + '" style="width:' + dp.toFixed(2) + '%"></span>';
    (b ? b.detail || [] : []).forEach(function (x) {
      var p = sc.at(x.reachBy);
      if (p != null) h += '<span class="rb' + (x.atRisk ? ' risk' : '') + '" style="left:' + p.toFixed(2) + '%"></span>';
    });
    if (dp != null) h += '<span class="due ' + st + '" style="left:' + dp.toFixed(2) + '%"></span>';
    h += '</div><div class="pn-needs">';
    var needs = (t.needs || []).filter(function (x) { return !!doc(x); });
    if (!needs.length) h += '<span class="pn-need pn-muted">Needs no basics' + (/\/ship$/.test(String(t.chain || '')) ? ': the ship step of its chain.' : '.') + '</span>';
    needs.forEach(function (id) {
      var info = ctx.info[id], det = b ? (b.detail || []).filter(function (x) { return x.basic === id; })[0] : null;
      if (det) {
        h += '<span class="pn-need"><span class="pn-dot ' + (det.atRisk ? 'bad' : 'warn') + '"></span>' + docLink(id) + stagePill(det.stage, det.push) +
          '<span class="pn-muted">stage ' + K('KNOWN_STAGE', 3) + ' by ' + esc(nice(det.reachBy)) + ' with clean drills' + (det.atRisk ? ', after the ship date' : '') + '</span>' +
          '<button type="button" data-act="drill" data-basic="' + esc(id) + '">Drill</button></span>';
      } else if (info) {
        h += '<span class="pn-need"><span class="pn-dot good"></span>' + docLink(id) + stagePill(info.stage, info.push) + '<span class="pn-muted">ready</span></span>';
      } else {
        h += '<span class="pn-need"><span class="pn-dot"></span>' + docLink(id) + '<span class="pn-muted">topic doc</span></span>';
      }
    });
    h += '</div>';
    if (t.line) h += '<code class="pn-line">' + esc(t.line) + '</code>';
    return h + '</div>';
  }
  function shipSec(ctx) {
    var all = tasks(), open = all.filter(taskOpen).sort(byDue), done = all.filter(function (t) { return !taskOpen(t); });
    var h = '<section class="pn-sec" data-sec="ship"><h3 class="pn-h">Ship dates<span class="pn-count">' + plural(open.length, 'open task') + '</span></h3>' +
      '<p class="pn-sub">Invented sample lines in the format of the task ledger. A task names the basics it needs; one below stage ' + K('KNOWN_STAGE', 3) +
      ' blocks it. Each runway starts today (' + esc(nice(ctx.day)) + '): the diamond is the ship date, a dot is where clean drills would bring a blocking basic to stage ' +
      K('KNOWN_STAGE', 3) + ' (red when that is after the ship date), dashed lines are the test dates.</p>';
    if (!all.length) return h + '<p class="pn-empty">No tasks in the demo content.</p></section>';
    var sc = scaleFor(ctx.day, open);
    h += chainsHtml(all, ctx) + axisHtml(sc) + open.map(function (t) { return taskRow(t, sc, ctx); }).join('');
    if (done.length) {
      h += '<div class="pn-done"><span class="pn-kick">Done</span>' + done.map(function (t) {
        return '<span class="pn-donechip">✓ ' + esc(clip(t.text, 60)) + (validDate(t.due) ? ' · ' + esc(nice(t.due)) : '') + '</span>';
      }).join('') + '</div>';
    }
    return h + '</section>';
  }

  /* ---------- ratings ---------- */
  /* Within 0.25 of a rung (either side) reads as that rung; between two rungs, as the range. Closeness is
     tested against every rung before any range, so the labels are symmetric around each rung. */
  function ladderText(r) {
    if (!(r >= 2.75)) return 'below Putnam A1';
    var i;
    for (i = 0; i < RUNGS.length; i++) if (Math.abs(r - RUNGS[i][0]) <= 0.25) return 'Putnam A' + RUNGS[i][1] + ' level';
    for (i = 0; i + 1 < RUNGS.length; i++) {
      if (r > RUNGS[i][0] && r < RUNGS[i + 1][0]) return 'Putnam A' + RUNGS[i][1] + '–A' + RUNGS[i + 1][1] + ' level';
    }
    return 'Putnam A6 level';
  }
  function spark(hist) {
    var v = (hist || []).map(function (x) { return +x.r; }).filter(function (x) { return isFinite(x); });
    if (!v.length) return '';
    var w = 120, h = 36, lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
    if (hi - lo < 0.5) { var m = (hi + lo) / 2; lo = m - 0.25; hi = m + 0.25; }
    var pts = v.map(function (r, i) {
      var x = v.length === 1 ? w - 6 : 6 + i * (w - 12) / (v.length - 1), y = h - 6 - (r - lo) / (hi - lo) * (h - 12);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var last = pts[pts.length - 1].split(',');
    return '<svg class="pn-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Rating history, ' + plural(v.length, 'point') + '">' +
      (v.length > 1 ? '<polyline points="' + pts.join(' ') + '"/>' : '<line class="flat" x1="6" x2="' + (w - 6) + '" y1="' + last[1] + '" y2="' + last[1] + '"/>') +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3.5"/></svg>';
  }
  /* The difficulty ladder (d from 1 to 10): the stretch band (E 0.60 to 0.70) and target (E 0.65), the
     hidden-topic pitch one step below, the reach pitch when it is open, and the rating r as a dot. */
  function ladder(a, r, tg, tgH, tgR) {
    var w = 340, h = 58, d0 = 1, d1 = 10, y = 30;
    function x(d) { d = Math.max(d0, Math.min(d1, +d)); return (12 + (d - d0) * (w - 24) / (d1 - d0)).toFixed(1); }
    function tick(cls, d, y1, y2) { return '<line class="' + cls + '" x1="' + x(d) + '" x2="' + x(d) + '" y1="' + y1 + '" y2="' + y2 + '"/>'; }
    var s = '<svg class="pn-lad" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Difficulty ladder: r ' + f2(r) +
      (tg ? ', stretch target d ' + f2(tg.d) : '') + '">';
    s += '<line class="ax" x1="' + x(d0) + '" x2="' + x(d1) + '" y1="' + y + '" y2="' + y + '"/>';
    if (areaTrack(a) === 'putnam') {
      RUNGS.forEach(function (g) { s += tick('rung', g[0], y - 7, y) + '<text x="' + x(g[0]) + '" y="' + (y - 11) + '" text-anchor="middle">A' + g[1] + '</text>'; });
    } else {
      katas().forEach(function (k) { if ((k.area || 'dd') === a && isFinite(+k.d)) s += tick('rung', k.d, y - 7, y); });
      s += '<text x="' + (w - 12) + '" y="' + (y - 11) + '" text-anchor="end">ticks: the katas in the bank</text>';
    }
    if (tg && tg.band) s += '<rect class="band" x="' + x(tg.band.lo) + '" y="' + (y - 7) + '" width="' + Math.max(3, x(tg.band.hi) - x(tg.band.lo)).toFixed(1) + '" height="14" rx="3"/>';
    if (tgH) s += tick('hid', tgH.d, y - 9, y + 9);
    if (tgR) s += tick('rch', tgR.d, y - 10, y + 10);
    if (tg) s += tick('tgt', tg.d, y - 10, y + 10);
    s += '<circle class="r" cx="' + x(r) + '" cy="' + y + '" r="6"/>';
    s += '<text x="' + x(d0) + '" y="' + (y + 22) + '">d 1</text><text x="' + x(d1) + '" y="' + (y + 22) + '" text-anchor="end">10</text>' +
      '<text class="rl" x="' + x(r) + '" y="' + (y + 22) + '" text-anchor="middle">r</text></svg>';
    return s;
  }
  function rateCard(a) {
    var r = +ecall('rating', a);
    if (!isFinite(r)) return '';
    var hist = ecall('history', a) || [], tg = ecall('target', a, {}) || null, tgH = ecall('target', a, { hidden: true }) || null;
    var st = ecall('streaks', a) || { miss: 0, clean: 0 }, push = !!ecall('inPush', a);
    var CR = K('CLEAN_RUN', 3), MR = K('MISS_RUN', 2), reachOpen = (st.clean || 0) >= CR;
    var tgR = reachOpen ? (ecall('target', a, { reach: true }) || null) : null;
    var acc = ecall('methodAccuracy', a) || { hits: 0, total: 0 }, sol = ecall('solveRate', a) || { held: 0, total: 0 };
    var notes = [];
    if (areaTrack(a) === 'putnam') notes.push(ladderText(r));
    if (tg) notes.push('target d ' + f2(tg.d) + (tg.eased ? ', eased one step' : ''));
    if ((st.miss || 0) >= MR) notes.push(st.miss + ' misses in a row: picks eased one step');
    else if (reachOpen) notes.push(st.clean + ' clean in a row: one reach allowed (E ' + f2(K('E_REACH', 0.4)) + ')');
    else if (st.clean > 0) notes.push('clean run ' + st.clean + ' of ' + CR);
    else if (st.miss > 0) notes.push('miss run ' + st.miss + ' of ' + MR);
    notes.push(sol.total ? 'held ' + sol.held + ' of ' + sol.total : 'nothing settled');
    if (acc.total) notes.push('method called ' + acc.hits + ' of ' + acc.total);
    return '<div class="pn-rate"><div class="pn-rate-h"><b>' + esc(areaName(a)) + '</b>' + (push ? '<span class="pn-flag after">push mode</span>' : '') +
      '<span class="pn-rv" title="rating r">' + f2(r) + '</span></div>' + ladder(a, r, tg, tgH, tgR) +
      '<div class="pn-rate-f">' + spark(hist) + '<span class="pn-rate-n">' + esc(notes.join(' · ')) + '</span></div></div>';
  }
  function ratingsSec() {
    var h = '<section class="pn-sec" data-sec="ratings"><h3 class="pn-h">Ratings</h3>' +
      '<p class="pn-sub">A pick of difficulty d has expected score E = 1/(1 + 10<sup>(d − r)/2</sup>). Held scores 1, held after help 0.75, missed or blind 0, moot nothing; then r ← r + 0.6(score − E).</p>' +
      '<div class="pn-rates">' + areaList().map(rateCard).join('') + '</div>' +
      '<div class="pn-key"><span><i class="k-r"></i>your rating r</span><span><i class="k-band"></i>stretch band, E ' + f2(K('E_LO', 0.6)) + '–' + f2(K('E_HI', 0.7)) +
      '</span><span><i class="k-tgt"></i>target, E ' + f2(K('E_TARGET', 0.65)) + '</span><span><i class="k-hid"></i>hidden-topic pitch, one step easier</span>' +
      '<span><i class="k-rch"></i>reach, E ' + f2(K('E_REACH', 0.4)) + ', after ' + K('CLEAN_RUN', 3) + ' clean in a row</span>' +
      '<span>A1–A6: Putnam positions A1/B1 … A6/B6 at d 3, 4, 5.5, 6.5, 8, 9.5</span><span>line: r after each settle</span></div></section>';
    return h;
  }

  /* ---------- method identification ---------- */
  function accRow(label, a, sub, alt) {
    a = a || { hits: 0, total: 0 };
    var rate = a.total ? a.hits / a.total : null;
    return '<div class="pn-accrow' + (sub ? ' sub' : '') + '"><span class="l">' + esc(label) + '</span><span class="pn-num">' + a.hits + ' of ' + a.total + '</span>' +
      '<span class="pn-bar' + (alt ? ' alt' : '') + '"><i style="width:' + (rate == null ? 0 : Math.round(rate * 100)) + '%"></i></span><span class="pn-num pc">' + pct(rate) + '</span></div>';
  }
  function cueLink(m) {
    var e = methodEntry(m);
    if (!e || !e.cue) return '';
    var d = String(e.cue).split('#')[0];
    return doc(d) ? ' <a class="ref" data-to="' + esc(e.cue) + '">the cue in ' + esc(title(d)) + '</a>' : '';
  }
  function methodsSec() {
    var all = ecall('methodAccuracy') || { hits: 0, total: 0 };
    var vis = ecall('methodAccuracy', null, { hidden: false }), hid = ecall('methodAccuracy', null, { hidden: true });
    var pr = ecall('methodAccuracy', null, { kind: 'problem' }), kt = ecall('methodAccuracy', null, { kind: 'kata' });
    var th = ecall('methodAccuracy', null, { kind: 'theorem' }) || { hits: 0, total: 0 };
    var sol = ecall('solveRate') || { held: 0, clean: 0, total: 0 };
    var h = '<section class="pn-sec" data-sec="methods"><h3 class="pn-h">Method identification</h3>' +
      '<p class="pn-sub">After a settle you tick the methods your call named and the methods the item took. A hit means the call named every method it took. ' +
      'It is counted apart from solving: you can solve without calling the method, or call it and still miss.</p>' +
      '<div class="pn-acc">' + accRow('Called the method', all) + accRow('topic given', vis, true) + accRow('topic hidden', hid, true) +
      accRow('problems', pr, true) + accRow('design katas', kt, true) + (th.total ? accRow('proofs at push 3', th, true) : '') +
      accRow('Held (help allowed)', { hits: sol.held, total: sol.total }, false, true) + accRow('held clean', { hits: sol.clean, total: sol.total }, true, true) + '</div>';
    /* which methods the calls missed, from the settled records */
    var took = {}, missed = {};
    settledAll().forEach(function (x) {
      var r = x.r;
      if (r.methodsPending || r.score === null || r.score === undefined) return;
      (r.took || []).forEach(function (m) {
        took[m] = (took[m] || 0) + 1;
        if ((r.called || []).indexOf(m) < 0) missed[m] = (missed[m] || 0) + 1;
      });
    });
    var L = Object.keys(missed).sort(function (a, b) { return missed[b] - missed[a] || took[b] - took[a]; }).slice(0, 5);
    h += '<div class="pn-kick">Methods your calls missed</div>';
    if (L.length) {
      h += '<ul class="pn-list">' + L.map(function (m) {
        return '<li>' + esc(methodLabel(m)) + ' <span class="pn-muted">missed ' + missed[m] + ' of ' + took[m] + '</span>' + cueLink(m) + '</li>';
      }).join('') + '</ul>';
    } else {
      h += '<p class="pn-sub">' + (Object.keys(took).length ? 'None missed so far.' : 'Nothing settled with method ticks yet. Settle a problem or kata from Today to start the count.') + '</p>';
    }
    var topics = docIds().filter(function (id) { var d = doc(id); return d && d.kind === 'topic'; });
    if (topics.length) {
      h += '<div class="pn-kick">Recognise lists</div>' + topics.map(function (id) {
        var cues = has('recognise') ? (ecall('recognise', id) || []) : [];
        return '<div class="pn-recrow"><span><b>' + esc(title(id)) + '</b> <span class="pn-muted">' + plural(cues.length, 'cue') + ' logged</span></span>' +
          '<button type="button" data-act="changes" data-doc="' + esc(id) + '">Open Changes</button>' +
          (cues.length ? '<ul class="pn-list">' + cues.slice(-3).reverse().map(function (e) { return '<li>' + esc(e.text) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
      }).join('') +
        '<p class="pn-sub">A cue is logged when a settled item took a method whose basic you hold at stage ' + K('KNOWN_STAGE', 3) + ' or more and your call did not name it.</p>';
    }
    return h + '</section>';
  }

  /* ================= actions ================= */
  function openDoc(id, anchor) {
    var R = SR.reader;
    if (id && R && typeof R.open === 'function') { R.open(id, anchor); return; }
    if (SR.toast) SR.toast('The reader is not loaded.');
  }
  function drill(id) {
    if (!id) return;
    var R = SR.reader;
    if (R && typeof R.drill === 'function') {
      try { R.drill(id); return; } catch (e) { console.error('[SR] panels: drill failed:', e); }
    }
    openDoc(id);
  }
  function openDemo() {
    var R = SR.reader;
    if (R && typeof R.openPanel === 'function') R.openPanel('demo');
  }
  function openChanges(id) {
    var R = SR.reader;
    if (!R || !id) return;
    if (typeof R.current === 'function' && R.current() !== id) openDoc(id);
    else if (SR.sheet) SR.sheet.closeAll(true);
    if (typeof R.openPanel === 'function') R.openPanel('changes');
  }
  function planEntry(kind, id) {
    var L = S.plan ? (kind === 'kata' ? S.plan.katas : S.plan.problems) || [] : [];
    return findById(L, id);
  }
  function openProblem(id, settled) {
    var x = settled ? null : planEntry('problem', id), p = (x && x.problem) || findById(problems(), id);
    if (!p) return;
    var rec = has('settled') ? ecall('settled', id) : null;
    var o = { hidden: x ? !!x.hidden : !!(rec && rec.hidden), reach: x ? !!x.reach : !!(rec && rec.reach), from: 'today' };
    if (x) { o.d = x.d; o.E = x.E; o.why = x.why; o.slot = x.slot; }
    if (SR.problem && typeof SR.problem.open === 'function') {
      try { SR.problem.open(p, o); return; } catch (e) { console.error('[SR] panels: problem.open failed:', e); }
    }
    if (SR.toast) SR.toast('block-problem.js is not loaded in this build.');
  }
  function openKata(id, settled) {
    var x = settled ? null : planEntry('kata', id), k = (x && x.kata) || findById(katas(), id);
    if (!k) return;
    var rec = has('kataResult') ? ecall('kataResult', id) : null;
    var o = { hidden: x ? !!x.hidden : !!(k.hidden || (rec && rec.hidden)), reach: x ? !!x.reach : !!(rec && rec.reach), from: 'today' };
    if (x) { o.d = x.d; o.E = x.E; o.why = x.why; o.slot = x.slot; }
    if (SR.kata && typeof SR.kata.open === 'function') {
      try { SR.kata.open(k, o); return; } catch (e) { console.error('[SR] panels: kata.open failed:', e); }
    }
    if (SR.toast) SR.toast('block-kata.js is not loaded in this build.');
  }
  function jump(sh, key) {
    var el = sh.body.querySelector('[data-sec="' + key + '"]');
    if (!el) return;
    var nav = sh.body.querySelector('.pn-nav'), off = nav ? nav.offsetHeight + 6 : 8;
    var top = el.getBoundingClientRect().top - sh.body.getBoundingClientRect().top + sh.body.scrollTop - off;
    try { sh.body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); } catch (e) { sh.body.scrollTop = Math.max(0, top); }
  }
  function selectNode(sh, id) {
    if (!id) return;
    S.sel = id;
    if (SR.store) SR.store.set('map-sel', id);
    [].forEach.call(sh.body.querySelectorAll('.pn-node'), function (el) {
      var on = el.getAttribute('data-node') === id;
      el.classList.toggle('pn-sel', on);
      if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
    });
    var box = sh.body.querySelector('.pn-detail');
    if (!box || !S.ctx) return;
    box.innerHTML = detailHtml(id, S.ctx);
    var br = sh.body.getBoundingClientRect(), r = box.getBoundingClientRect();
    if (r.top > br.bottom - 120) {
      var top = r.top - br.top + sh.body.scrollTop - 80;
      try { sh.body.scrollTo({ top: top, behavior: 'smooth' }); } catch (e) { sh.body.scrollTop = top; }
    }
  }
  function onClick(sh, e) {
    var t = e.target, a = t && t.closest ? t.closest('[data-act]') : null;
    if (!a || !sh.body.contains(a)) return;
    var act = a.getAttribute('data-act');
    if (act === 'drill') drill(a.getAttribute('data-basic'));
    else if (act === 'open') openDoc(a.getAttribute('data-doc'));
    else if (act === 'problem') openProblem(a.getAttribute('data-id'), a.hasAttribute('data-settled'));
    else if (act === 'kata') openKata(a.getAttribute('data-id'), a.hasAttribute('data-settled'));
    else if (act === 'node') selectNode(sh, a.getAttribute('data-node'));
    else if (act === 'jump') jump(sh, a.getAttribute('data-jump'));
    else if (act === 'demo') openDemo();
    else if (act === 'changes') openChanges(a.getAttribute('data-doc'));
    else if (act === 'map') { sh.close(); openMap(); }
    else if (act === 'today') { sh.close(); openToday(); }
  }

  /* ================= sheets ================= */
  function paint(sh, fn) {
    var y = sh.body.scrollTop;
    try { fn(sh); }
    catch (e) {
      console.error('[SR] panels: render failed:', e);
      sh.body.innerHTML = '<p class="sr-hint">This panel failed to render: ' + esc(e && e.message ? e.message : e) + '</p>';
    }
    sh.body.scrollTop = y;
  }
  function wire(sh) {
    if (sh.__pnWired) return;
    sh.__pnWired = true;
    sh.body.addEventListener('click', function (e) { onClick(sh, e); });
  }
  function live(id) { var s = SR.sheet && SR.sheet.get(id); return s && !s.closed ? s : null; }
  function openToday() {
    P.init();
    if (!SR.sheet) return null;
    var sh = SR.sheet.open({ id: 'today', title: 'Today', className: 'pn-sheet' });
    wire(sh);
    paint(sh, renderToday);
    return sh;
  }
  function openMap() {
    P.init();
    if (!SR.sheet) return null;
    var fresh = !live('map');
    var sh = SR.sheet.open({ id: 'map', title: 'Map', wide: true, className: 'pn-sheet' });
    wire(sh);
    if (fresh) {
      sh.body.scrollTop = 0;
      if (typeof ResizeObserver === 'function' && !sh.__pnRO) {
        var raf = 0;
        sh.__pnRO = new ResizeObserver(function () {
          if (raf) return;
          raf = requestAnimationFrame(function () { raf = 0; if (!sh.closed) layoutGraphs(sh.body); });
        });
        sh.__pnRO.observe(sh.body);
        sh.onClose = function () { if (sh.__pnRO) { sh.__pnRO.disconnect(); sh.__pnRO = null; } };
      }
    }
    paint(sh, renderMap);
    return sh;
  }
  function refresh() {
    var t = live('today'), m = live('map');
    if (t) paint(t, renderToday);
    if (m) paint(m, renderMap);
  }
  function schedule() {
    if (S.timer) return;
    S.timer = setTimeout(function () { S.timer = 0; refresh(); }, 40);
  }

  /* ================= styles ================= */
  var CSS = [
    '.pn{font-size:14.5px;line-height:1.45;color:var(--text)}',
    '.pn-muted{color:var(--muted)}.pn-sp{flex:1}.pn-num{font-variant-numeric:tabular-nums}',
    '.pn-top{display:flex;flex-direction:column;gap:8px;margin:0 0 4px}',
    '.pn-labels{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}',
    '.pn-row2{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.pn-btns{display:flex;gap:8px;margin-left:auto}',
    '.pn-btns button,.pn-acts button,.pn-recrow button,.pn-dh button{min-height:40px;padding:7px 14px}',
    '.pn-push{display:flex;flex-wrap:wrap;gap:6px}',
    '.pn-test,.pn-pchip{display:inline-block;border:1px solid var(--line);background:var(--paper);border-radius:999px;padding:4px 11px;font-size:13px}',
    '.pn-pchip.on{border-color:var(--after);color:var(--after);font-weight:600}',
    '.pn-sec{margin:22px 0 0}',
    '.pn-h{display:flex;align-items:baseline;gap:10px;font-size:17px;font-weight:650;margin:0 0 4px}',
    '.pn-count{font-size:13px;font-weight:500;color:var(--muted)}',
    '.pn-sub{font-size:13px;line-height:1.45;color:var(--muted);margin:0 0 8px}',
    '.pn-kick{font:600 11.5px/1.4 var(--ui);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:14px 0 4px}',
    '.pn-empty{font-size:14px;color:var(--muted);border:1px dashed var(--line);border-radius:12px;padding:12px 14px;margin:8px 0}',
    '.pn-item{display:block;width:100%;text-align:left;font:inherit;font-size:14.5px;line-height:1.45;color:var(--text);background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0;min-height:44px}',
    'button.pn-item{cursor:pointer}button.pn-item:hover,button.pn-item:focus-visible{border-color:var(--accent)}',
    '.pn-ih{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}',
    '.pn-t{font-size:16px;font-weight:650;line-height:1.3;margin:0 auto 0 0}',
    '.pn-go{color:var(--accent);font-weight:600;font-size:13.5px}',
    '.pn-im{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:7px;font-size:13.5px}',
    '.pn-why{display:block;margin-top:6px;font-size:13px;line-height:1.45;color:var(--muted)}',
    '.pn-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
    '.pn-note{display:block;margin:8px 0 0;font-size:13px;line-height:1.45;padding:6px 10px;border-left:3px solid var(--after);background:var(--tint);border-radius:0 8px 8px 0}',
    '.pn-chip{display:inline-block;font:600 12px/1.6 var(--ui);border:1px solid var(--line);border-radius:999px;padding:0 9px;color:var(--muted);background:var(--bg);white-space:nowrap}',
    '.pn-chip.q{color:var(--after);border-color:var(--after);font-size:13px}',
    '.pn-chip.reach{color:var(--after);border-color:var(--after)}.pn-chip.eased{color:var(--warn);border-color:var(--warn)}.pn-chip.hard{color:var(--text);border-color:var(--text)}',
    '.pn-flag{display:inline-block;font:600 12px/1.55 var(--ui);border:1px solid currentColor;border-radius:999px;padding:0 8px;background:var(--paper);white-space:nowrap}',
    '.pn-flag.bad{color:var(--bad)}.pn-flag.warn{color:var(--warn)}.pn-flag.good{color:var(--good)}.pn-flag.after{color:var(--after)}.pn-flag.muted{color:var(--muted)}',
    '.pn-gauge{position:relative;display:inline-block;flex:0 0 auto;width:112px;height:8px;border-radius:4px;background:var(--line);vertical-align:middle}',
    '.pn-gauge .b{position:absolute;top:0;bottom:0;background:var(--good);opacity:.7;border-radius:2px}',
    '.pn-gauge .m{position:absolute;top:-4px;width:4px;height:16px;margin-left:-2px;border-radius:2px;background:var(--text)}',
    '.pn-pri{color:var(--bad);font-weight:700}.pn-mono{font:600 13px var(--mono)}',
    '.pn-foot{margin:26px 0 0;font-size:12.5px;line-height:1.45;color:var(--muted)}',
    /* map */
    '.pn-nav{position:sticky;top:-12px;z-index:5;display:flex;gap:6px;flex-wrap:wrap;background:var(--bg);box-shadow:0 -6px 0 var(--bg);padding:8px 0;margin:8px 0 0;border-bottom:1px solid var(--line)}',
    '.pn-nav button{min-height:36px;border-radius:999px;padding:5px 14px}',
    '.pn-legend{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:12.5px;color:var(--muted);margin:2px 0 10px}',
    '.pn-sw{display:inline-flex;align-items:center;justify-content:center;width:22px;height:18px;border-radius:4px;font:600 11px var(--ui);background:var(--s0);color:var(--s0t);margin-left:-8px}',
    '.pn-sw.s0{margin-left:0}.pn-sw.s1{background:var(--s1);color:var(--s1t)}.pn-sw.s2{background:var(--s2);color:var(--s2t)}.pn-sw.s3{background:var(--s3);color:var(--s3t)}.pn-sw.s4{background:var(--s4);color:var(--s4t)}.pn-sw.s5{background:var(--s5);color:var(--s5t)}',
    '.pn-lg{display:inline-flex;align-items:center;gap:7px}',
    '.pn-ringdemo{display:inline-block;width:22px;height:14px;border-radius:4px;background:var(--s2);box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--after)}',
    '.pn-fogdemo{display:inline-block;width:22px;height:14px;border-radius:4px;border:1px dashed var(--muted);background:repeating-linear-gradient(135deg,var(--fog) 0 4px,var(--paper) 4px 8px)}',
    '.pn-topicdemo{display:inline-block;width:22px;height:14px;border-radius:4px;border:1.5px solid var(--accent);background:var(--paper)}',
    '.pn-tracks{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));align-items:start}',
    '.pn-track{min-width:0;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:12px 12px 8px}',
    '.pn-trh{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;font-size:14px}.pn-trh b{font-size:16px}',
    '.pn-trs{flex-basis:100%;font-size:12.5px;color:var(--muted)}',
    '.pn-graph{position:relative;padding:22px 66px 4px 20px}',
    '.pn-edges{position:absolute;left:0;top:0;pointer-events:none;overflow:visible;z-index:0}',
    '.pn-layer{position:relative;z-index:1;display:flex;gap:30px;margin:0 0 46px}.pn-layer:last-child{margin-bottom:16px}',
    '.pn-node{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;font:inherit;line-height:1.3;min-height:60px;padding:10px 13px;border-radius:12px;border:1px solid transparent;background:var(--s0);color:var(--s0t);cursor:pointer}',
    '.pn-node.s1{background:var(--s1);color:var(--s1t)}.pn-node.s2{background:var(--s2);color:var(--s2t)}.pn-node.s3{background:var(--s3);color:var(--s3t)}.pn-node.s4{background:var(--s4);color:var(--s4t)}.pn-node.s5{background:var(--s5);color:var(--s5t)}',
    '.pn-node.s0{border-color:var(--line)}',
    '.pn-nt{font-size:15px;font-weight:650}.pn-nm{font-size:12.5px;opacity:.88}',
    '.pn-flags{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}.pn-node .pn-flag{font-size:11.5px}',
    '.pn-node.p1{box-shadow:0 0 0 3px var(--paper),0 0 0 5px var(--after)}',
    '.pn-node.p2{box-shadow:0 0 0 3px var(--paper),0 0 0 5px var(--after),0 0 0 8px var(--paper),0 0 0 10px var(--after)}',
    '.pn-node.p3{box-shadow:0 0 0 3px var(--paper),0 0 0 5px var(--after),0 0 0 8px var(--paper),0 0 0 10px var(--after),0 0 0 13px var(--paper),0 0 0 15px var(--after)}',
    '.pn-node.fog{background:repeating-linear-gradient(135deg,var(--fog) 0 8px,var(--paper) 8px 16px);color:var(--muted);border:1.5px dashed var(--muted)}',
    '.pn-node.topic{background:var(--paper);color:var(--text);border:1.5px solid var(--accent)}',
    '.pn-node.pn-sel{outline:2.5px solid currentColor;outline-offset:-6px}',
    '.pn-node:focus-visible{outline:2.5px solid var(--accent);outline-offset:3px}',
    '.pn-edge{fill:none;stroke:var(--muted);stroke-width:1.7}.pn-edge.soft{stroke-dasharray:5 4;opacity:.75}',
    '.pn-edge.uses{stroke:var(--accent);stroke-dasharray:2 4;opacity:.75}',
    '.pn-arrow{fill:var(--muted)}.pn-arrow.a{fill:var(--accent)}',
    '.pn-fogrow{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;margin:10px 2px 2px}.pn-fogrow .pn-kick{margin:0 4px 0 0}',
    '.pn-fogchip{font-size:12.5px;color:var(--muted);border:1px dashed var(--muted);border-radius:999px;padding:3px 10px;background:repeating-linear-gradient(135deg,var(--fog) 0 6px,transparent 6px 12px)}',
    '.pn-hint2{flex-basis:100%;font-size:12.5px;color:var(--muted)}',
    '.pn-detail{margin:12px 0 0}',
    '.pn-dcard{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:12px 14px}',
    '.pn-dh{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.pn-dt{font-size:17px;font-weight:650}',
    '.pn-kv{display:grid;grid-template-columns:minmax(84px,auto) minmax(0,1fr);gap:7px 14px;margin:10px 0 0;font-size:14px}',
    '.pn-kv dt{color:var(--muted)}.pn-kv dd{margin:0;min-width:0}',
    '.pn-li{display:inline-block;margin:0 16px 4px 0}',
    '.pn-pips{display:inline-flex;gap:3px;vertical-align:middle;margin:0 6px}.pn-pips i{width:14px;height:8px;border-radius:2px;background:var(--line)}.pn-pips i.f{background:var(--accent)}',
    '.pn-list{margin:4px 0 8px;padding-left:18px}.pn-list li{margin:5px 0;font-size:13.5px}',
    /* ship dates */
    '.pn-chain{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:8px 0 12px}',
    '.pn-chain-h{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;font-size:13px}',
    '.pn-steps{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}',
    '.pn-step{display:inline-flex;flex-direction:column;border:1.5px solid var(--line);border-radius:10px;padding:6px 10px;font-size:13px;line-height:1.3;max-width:230px;background:var(--bg)}',
    '.pn-step b{font-weight:600}.pn-step small{color:var(--muted);font-size:12px;margin-top:2px}',
    '.pn-step.done{opacity:.6}.pn-step.blocked{border-color:var(--warn)}.pn-step.risk,.pn-step.overdue{border-color:var(--bad)}.pn-step.clear{border-color:var(--good)}',
    '.pn-step.next{box-shadow:0 0 0 2px var(--accent)}.pn-sep{color:var(--muted)}',
    '.pn-axis{position:relative;height:44px;margin:14px 0 0;font-size:12px;color:var(--muted)}',
    '.pn-al{position:absolute;white-space:nowrap}.pn-al.top{top:0;font-weight:600;color:var(--text)}.pn-al.bot{top:17px}',
    '.pn-al.c{transform:translateX(-50%)}.pn-al.r{transform:translateX(-100%)}',
    '.pn-axis .tk{position:absolute;top:34px;bottom:0;border-left:1px dashed var(--muted)}',
    '.pn-axis .mt{position:absolute;top:35px;bottom:0;border-left:1px solid var(--line)}',
    '.pn-task{background:var(--paper);border:1px solid var(--line);border-left:5px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0}',
    '.pn-task.risk,.pn-task.overdue{border-left-color:var(--bad)}.pn-task.blocked{border-left-color:var(--warn)}.pn-task.clear{border-left-color:var(--good)}',
    '.pn-task-h{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline}',
    '.pn-date{font-weight:650;font-variant-numeric:tabular-nums;min-width:64px;font-size:15px}.pn-date small{display:block;font-weight:500;font-size:12px;color:var(--muted)}',
    '.pn-task-t{flex:1 1 200px;font-size:15px;font-weight:600;line-height:1.35}',
    '.pn-run{position:relative;height:24px;margin:8px 0 2px}',
    '.pn-run .rail{position:absolute;left:0;right:0;top:11px;height:2px;background:var(--line);border-radius:1px}',
    '.pn-run .tst{position:absolute;top:1px;bottom:1px;border-left:1px dashed var(--muted)}',
    '.pn-run .win{position:absolute;left:0;top:10px;height:4px;border-radius:2px;background:var(--muted)}',
    '.pn-run .win.risk,.pn-run .win.overdue{background:var(--bad)}.pn-run .win.blocked{background:var(--warn)}.pn-run .win.clear{background:var(--good)}',
    '.pn-run .due{position:absolute;top:6px;width:12px;height:12px;margin-left:-6px;transform:rotate(45deg);background:var(--paper);border:2px solid var(--text)}',
    '.pn-run .rb{position:absolute;top:5px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--warn);border:2px solid var(--paper)}.pn-run .rb.risk{background:var(--bad)}',
    '.pn-needs{display:flex;flex-direction:column;gap:6px;margin-top:6px}',
    '.pn-need{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;font-size:14px}.pn-need button{min-height:34px;padding:4px 12px}',
    '.pn-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--line)}',
    '.pn-dot.good{background:var(--good)}.pn-dot.warn{background:var(--warn)}.pn-dot.bad{background:var(--bad)}',
    '.pn-line{display:block;margin-top:8px;font:12px/1.45 var(--mono);color:var(--muted);white-space:pre-wrap;word-break:break-word}',
    '.pn-done{margin:10px 0 0;font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px;align-items:center}.pn-done .pn-kick{margin:0 4px 0 0}',
    '.pn-donechip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;background:var(--paper)}',
    /* ratings */
    '.pn-rates{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))}',
    '.pn-rate{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:10px 12px;min-width:0}',
    '.pn-rate-h{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}.pn-rate-h b{font-size:15px}',
    '.pn-rv{margin-left:auto;font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}',
    '.pn-rate-f{display:flex;gap:10px;align-items:center}',
    '.pn-rate-n{flex:1;min-width:0;font-size:13px;line-height:1.45;color:var(--muted)}',
    '.pn-spark{flex:0 0 auto}',
    '.pn-hspark{display:block;margin:2px 0 4px}.pn-hspark path{fill:none;stroke:var(--accent);stroke-width:1.8;stroke-linejoin:round}',
    '.pn-hspark circle{fill:var(--muted)}.pn-hspark circle.clean{fill:var(--good)}.pn-hspark circle.shaky{fill:var(--warn)}.pn-hspark circle.failed{fill:var(--bad)}',
    '.pn-htext{display:block;font-size:12.5px;line-height:1.45}',
    '.pn-lad{display:block;width:100%;max-width:460px;height:auto;margin:2px 0 4px}',
    '.pn-lad text.rl{fill:var(--accent);font-weight:700}',
    '.pn-spark polyline{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}',
    '.pn-spark .flat{stroke:var(--line);stroke-width:2;stroke-dasharray:3 3}.pn-spark circle{fill:var(--accent)}',
    '.pn-lad .ax{stroke:var(--line);stroke-width:2}.pn-lad .band{fill:var(--good);opacity:.32}',
    '.pn-lad .tgt{stroke:var(--good);stroke-width:2.5}.pn-lad .hid{stroke:var(--after);stroke-width:1.8;stroke-dasharray:2 2}',
    '.pn-lad .rch{stroke:var(--after);stroke-width:2.5}.pn-lad .rung{stroke:var(--muted);stroke-width:1.2}',
    '.pn-lad .r{fill:var(--accent);stroke:var(--paper);stroke-width:2}',
    '.pn-lad text{font-size:11px;font-family:var(--ui);fill:var(--muted)}',
    '.pn-key{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--muted);margin:10px 0 0;align-items:center}',
    '.pn-key i{display:inline-block;vertical-align:-2px;margin-right:6px}',
    '.pn-key .k-r{width:11px;height:11px;border-radius:50%;background:var(--accent)}',
    '.pn-key .k-band{width:18px;height:10px;border-radius:3px;background:var(--good);opacity:.4}',
    '.pn-key .k-tgt{width:3px;height:14px;background:var(--good)}',
    '.pn-key .k-hid{width:0;height:14px;border-left:2px dashed var(--after)}',
    '.pn-key .k-rch{width:3px;height:14px;background:var(--after)}',
    /* methods */
    '.pn-acc{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:8px 12px}',
    '.pn-accrow{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(70px,170px) 44px;gap:10px;align-items:center;padding:5px 0;font-size:14px}',
    '.pn-accrow.sub{font-size:13px;color:var(--muted)}.pn-accrow.sub .l{padding-left:16px}.pn-accrow .pc{text-align:right}',
    '.pn-bar{position:relative;display:block;height:8px;border-radius:4px;background:var(--line);overflow:hidden}',
    '.pn-bar i{position:absolute;left:0;top:0;bottom:0;background:var(--accent);border-radius:4px}.pn-bar.alt i{background:var(--good)}',
    '.pn-recrow{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:8px 0}',
    '.pn-recrow .pn-list{flex-basis:100%;margin:0}',
    '@media (max-width:600px){.pn-graph{padding:20px 54px 4px 18px}.pn-layer{margin-bottom:40px}.pn-accrow{grid-template-columns:minmax(0,1fr) auto 44px}.pn-accrow .pn-bar{display:none}' +
      '.pn-kv{grid-template-columns:minmax(0,1fr)}.pn-kv dt{margin-top:4px}.pn-t{font-size:15.5px}}'
  ].join('\n');
  if (SR.style) SR.style('panel-map', CSS);
  else {
    var st = document.createElement('style');
    st.id = 'sr-style-panel-map';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ================= public ================= */
  P.init = function () {
    if (S.inited) return;
    S.inited = true;
    if (SR.store) S.sel = SR.store.get('map-sel', null);
    if (SR.bus) {
      SR.bus.on('engine:change', schedule);
      SR.bus.on('reader:changes', schedule);
      SR.bus.on('demo:reset', function () { S.sel = null; S.plan = null; schedule(); });
      SR.bus.on('problem:state', schedule);   /* a session's status shows on its Today card */
      SR.bus.on('kata:change', schedule);
    }
    window.addEventListener('resize', function () { var m = live('map'); if (m) layoutGraphs(m.body); });
  };
  P.today = function () { return openToday(); };
  P.map = function () { return openMap(); };
  P.open = function (name) { return name === 'map' ? openMap() : openToday(); };
  P.refresh = refresh;
})();

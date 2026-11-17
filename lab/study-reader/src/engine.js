/* Study Reader engine: drill stages, push levels, ratings, problem and kata
   slots, method identification, rebuild rationing, Changes log, simulated clock.
   Written by a model for Adit. Not Adit's words. Seeded stages, ratings and
   history are demo data.
   Browser: attaches SR.engine to window.SR (reads SR.content, SR.store and
   SR.bus lazily). Node: module.exports carries createEngine and the pure
   functions for tests. No DOM, no network, no eval. */
(function (root) {
  'use strict';
  var SR = root.SR = root.SR || {};

  /* ---------- the agreed numbers ---------- */
  var DAY = 86400000;
  var STATE_V = 1;
  var AREAS = ['nt', 'cp', 'an', 'lg', 'dd', 'gr'];
  var AREA_NAMES = {
    nt: 'number theory & algebra', cp: 'combinatorics & probability', an: 'analysis',
    lg: 'linear algebra & geometry', dd: 'digital design', gr: 'general reasoning'
  };
  var R_START = {nt: 3, cp: 4, an: 4, lg: 4, dd: 4, gr: 4};
  var K = 0.6;                                   // r <- r + K (score - E)
  var E_TARGET = 0.65, E_LO = 0.60, E_HI = 0.70; // stretch band
  var E_REACH = 0.40;                            // one reach after CLEAN_RUN clean holds
  var HIDDEN_STEP = 1;                           // hidden-topic picks: target d - 1
  var EASE_STEP = 1;                             // after MISS_RUN misses in a row: d - 1
  var MISS_RUN = 2, CLEAN_RUN = 3;
  var SLOTS = 3, HIDDEN_EVERY = 3;               // push areas: every third slot is hidden-topic (1/3)
  var INTERVALS = [1, 2, 4, 7, 14, 30];          // days, by stage 0..5
  var MAX_STAGE = 5, KNOWN_STAGE = 3;            // stage >= 3: Adit knows the basic's methods
  var REWRITE_MAX = 3, ELIGIBLE_MS = DAY;        // rewrites per doc; wait before a rewrite
  var THEOREM_D = 2.5;                           // a basic's proof at push level 3, posed as a problem (unless the fog sets d)
  var VERDICTS = ['held', 'missed', 'blind', 'moot'];
  var GRADES = ['clean', 'shaky', 'failed'];
  var CLOSED = /^(done|x|closed|shipped|cancelled|canceled)$/i;
  var DEFAULT_TESTS = [
    {id: 'putnam', date: '2026-12-05', track: 'putnam'},
    {id: 'asic', date: '2027-01-18', track: 'asic'}
  ];
  var TEST_NAMES = {putnam: 'Putnam', asic: 'ASIC competition'};
  // Demo data: starting stage, due offset from the first day, last result, clean streak.
  var SEED = {
    'nt-divisibility': {stage: 3, dueIn: 2, last: 'clean', streak: 2},   // push 2
    'nt-units':        {stage: 1, dueIn: -1, last: 'shaky', streak: 0},  // push 0; a lost mark rebuilds it
    'nt-crt':          {stage: 2, dueIn: 0, last: 'clean', streak: 1},   // push 1
    'dd-lfsr':         {stage: 2, dueIn: -2, last: 'clean', streak: 1},  // push 1
    'dd-crc':          {stage: 3, dueIn: 1, last: 'clean', streak: 1}    // push 1
  };
  var SEED_DEFAULT = {stage: 2, dueIn: 0, last: null, streak: 0};

  /* ---------- small helpers ---------- */
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function copy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (has(s, k)) t[k] = s[k];
    }
    return t;
  }
  function uniq(a) {
    var out = [];
    (a || []).forEach(function (x) { if (x != null && out.indexOf(x) < 0) out.push(x); });
    return out;
  }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  // Difficulty of a problem or kata as a number (NaN when missing).
  function dOf(x) { var d = x && x.d; return typeof d === 'number' ? d : (d != null && d !== '' && isFinite(Number(d)) ? Number(d) : NaN); }
  function hash01(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }

  /* ---------- dates: YYYY-MM-DD strings, day arithmetic in UTC ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function dayNum(s) { var a = String(s).split('-'); return Math.round(Date.UTC(+a[0], +a[1] - 1, +a[2]) / DAY); }
  function fromDayNum(n) { return new Date(n * DAY).toISOString().slice(0, 10); }
  function addDays(s, k) { return fromDayNum(dayNum(s) + k); }
  function dayDiff(a, b) { return dayNum(a) - dayNum(b); }   // a - b in days

  /* ---------- pure rules ---------- */
  // Expected score of a problem of difficulty d at rating r.
  function expected(d, r) { return 1 / (1 + Math.pow(10, (d - r) / 2)); }
  // The difficulty whose expected score at rating r is E.
  function dForE(r, E) { return r + 2 * Math.log10(1 / E - 1); }
  function rateUpdate(r, d, score) {
    var E = expected(d, r);
    return {E: E, r: score == null ? r : r + K * (score - E)};
  }
  function clampStage(n) { n = Math.round(Number(n) || 0); return n < 0 ? 0 : n > MAX_STAGE ? MAX_STAGE : n; }
  // Drill stages: clean +1, shaky stays, failed back to 0.
  function nextStage(stage, grade) {
    stage = clampStage(stage);
    if (grade === 'clean') return Math.min(MAX_STAGE, stage + 1);
    if (grade === 'failed') return 0;
    return stage;
  }
  // Interval for a stage, capped near a deadline at max(1, floor(days_left / 3)).
  function intervalFor(stage, daysLeft) {
    var iv = INTERVALS[clampStage(stage)];
    if (typeof daysLeft === 'number' && isFinite(daysLeft)) iv = Math.min(iv, Math.max(1, Math.floor(Math.max(0, daysLeft) / 3)));
    return iv;
  }
  function deadlineFactor(daysLeft) {
    if (typeof daysLeft !== 'number' || !isFinite(daysLeft)) return 1;
    return 1 + 2 * Math.exp(-Math.max(0, daysLeft) / 14);
  }
  // priority = overdue days * (1 + 2 exp(-days_to_deadline / 14))
  function priority(overdue, daysLeft) { return Math.max(0, overdue) * deadlineFactor(daysLeft); }
  // The push level a basic has earned: 1 at stage >= 2 with the last result clean,
  // 2 at stage >= 3 with >= 2 clean in a row, 3 at stage >= 4.
  function eligiblePush(stage, streak, last) {
    if (stage >= 4) return 3;
    if (stage >= 3 && streak >= 2) return 2;
    if (stage >= 2 && last === 'clean') return 1;
    return 0;
  }
  // Raised by a clean result (to what it has earned), held by shaky, one failure drops a level.
  function nextPush(push, grade, stageAfter, streakAfter) {
    push = Math.max(0, Math.min(3, Number(push) || 0));
    if (grade === 'failed') return Math.max(0, push - 1);
    if (grade === 'clean') return Math.max(push, eligiblePush(stageAfter, streakAfter, 'clean'));
    return push;
  }
  // held 1, held after help 0.75, missed or blind 0, moot no score.
  function scoreFor(verdict, help) {
    if (verdict === 'moot') return null;
    if (verdict === 'held') return help ? 0.75 : 1;
    return 0;
  }
  // Kata: pass on the first run 1, pass after failed runs 0.75, gave up or no pass 0.
  function kataScore(pass, runs, gaveUp) {
    if (pass && !gaveUp) return (Number(runs) || 1) <= 1 ? 1 : 0.75;
    return 0;
  }
  function isHiddenSlot(i, push) { return !!push && (i % HIDDEN_EVERY) === HIDDEN_EVERY - 1; }
  // Fog: no reveals is clean, every step revealed is failed, anything between is shaky.
  function fogGrade(reveals, steps, clean) {
    reveals = Math.max(0, Number(reveals) || 0);
    steps = Math.max(0, Number(steps) || 0);
    if (steps > 0 && reveals >= steps) return 'failed';
    if (reveals > 0) return 'shaky';
    return clean === false ? 'shaky' : 'clean';
  }
  function seedBasic(id, day) {
    var sd = has(SEED, id) ? SEED[id] : SEED_DEFAULT;
    var stage = sd.stage, due = addDays(day, sd.dueIn), hist = [];
    if (sd.last) {
      var n = sd.last === 'clean' ? Math.max(1, sd.streak) : 1, d = addDays(due, -INTERVALS[stage]), st = stage;
      for (var i = 0; i < n; i++) {
        var from = sd.last === 'clean' ? Math.max(0, st - 1) : st;
        hist.unshift({t: null, day: d, grade: sd.last, from: from, to: st, src: 'seed'});
        st = from;
        d = addDays(d, -INTERVALS[st]);
      }
    }
    return {stage: stage, due: due, push: eligiblePush(stage, sd.streak, sd.last), streak: sd.streak,
      last: sd.last, raisedOn: null, hist: hist};
  }
  // In the page SR.store (core.js) is always there; this in-memory store only serves an engine
  // created without one (node, or a test that passes no store). Nothing persists in it.
  function makeMemoryStore() {
    var mem = {};
    return {
      get: function (k) { try { return has(mem, k) ? JSON.parse(mem[k]) : null; } catch (e) { return null; } },
      set: function (k, v) { mem[k] = JSON.stringify(v); },
      del: function (k) { delete mem[k]; }
    };
  }

  /* ---------- the engine ---------- */
  function createEngine(o) {
    o = o || {};
    function getter(x) { return typeof x === 'function' ? x : function () { return x; }; }
    var getContent = getter(o.content), getStore = getter(o.store), getBus = getter(o.bus);
    var realNow = typeof o.realNow === 'function' ? o.realNow : function () { return Date.now(); };
    var memory = makeMemoryStore();
    var state;

    /* content, read lazily */
    function C() { var c = null; try { c = getContent(); } catch (e) {} return c || {}; }
    function docs() { return C().docs || {}; }
    function doc(id) { var d = docs(); return has(d, id) ? d[id] : null; }
    function docTitle(id) { var d = doc(id); return (d && d.title) || id; }
    function basicIds() {
      var d = docs(), ids = Object.keys(d).filter(function (k) { return d[k] && d[k].kind === 'basic'; });
      return ids.length ? ids : Object.keys(SEED);
    }
    function isBasic(id) { return basicIds().indexOf(id) >= 0; }
    function areaOf(id) {
      var d = doc(id);
      if (d && d.area) return d.area;
      var m = /^([a-z]{2})-/.exec(String(id));
      return m && has(AREA_NAMES, m[1]) ? m[1] : 'gr';
    }
    function trackOf(id) { var d = doc(id); return (d && d.track) || (areaOf(id) === 'dd' ? 'asic' : 'putnam'); }
    function problems() { var p = C().problems; return Array.isArray(p) ? p : []; }
    function katas() { var k = C().katas; return Array.isArray(k) ? k : []; }
    function tests() { var t = C().tests; return Array.isArray(t) && t.length ? t : DEFAULT_TESTS; }
    function tasks() { var t = C().pmTasks; return Array.isArray(t) ? t : []; }
    function taskOpen(t) { return !!t && !CLOSED.test(String(t.status || '')); }
    function problemById(id) {
      var a = problems();
      for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i];
      return theoremItem(id);
    }
    /* At push level 3 a basic's theorem becomes a problem-first hook: 'thm:<fog id>#<attempt>' is that
       proof posed as a problem (statement, the model's steps as the solution after settling). It never
       enters Today's slots; settling it grades the basic like a drill (see settleTheorem). */
    var THM = /^thm:([^#]+)(?:#(\d+))?$/;
    function plainText(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
    function theoremItem(id) {
      var m = THM.exec(String(id || '')), F = C().fog || {}, f = m && has(F, m[1]) ? F[m[1]] : null;
      if (!f || !f.basic) return null;
      var steps = Array.isArray(f.steps) ? f.steps : [], d = Number(f.d), worked = /^worked/i.test(String(f.title || ''));
      return {id: String(id), kind: 'theorem', fogId: m[1], attempt: m[2] ? Number(m[2]) : 1, worked: worked, label: (worked ? 'Work it: ' : 'Proof: ') + (f.title || m[1]),
        title: f.title || m[1], statement: f.statement || '', d: f.d != null && isFinite(d) ? d : THEOREM_D, area: areaOf(f.basic),
        basic: f.basic, doc: f.doc || f.basic, methods: Array.isArray(f.methods) ? f.methods.slice() : [], basics: [f.basic], hiddenOK: false,
        solution: steps.map(function (s, i) {
          return '<p><b>Step ' + (i + 1) + (s && s.topic ? ' · ' + plainText(s.topic) : '') + '.</b> ' + ((s && s.html) || '') + '</p>';
        }).join('')};
    }
    function kataById(id) { var a = katas(); for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i]; return null; }
    function kataArea(k) { return (k && k.area) || (k && k.basics && k.basics.length ? areaOf(k.basics[0]) : 'dd'); }
    function methodEntry(id) {
      var m = C().methods || {}, all = [].concat(m.math || [], m.design || []);
      for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
      return null;
    }
    function methodLabel(id) { var e = methodEntry(id); return (e && e.label) || id; }
    function testName(t) { return t.label || t.name || TEST_NAMES[t.id] || TEST_NAMES[t.track] || t.id; }
    function areasWhere(track) {
      var out = [];
      basicIds().forEach(function (id) { if (trackOf(id) === track && out.indexOf(areaOf(id)) < 0) out.push(areaOf(id)); });
      return out;
    }
    function problemAreas() { var a = areasWhere('putnam'); return a.length ? a : ['nt']; }
    function kataAreas() { var a = areasWhere('asic'); return a.length ? a : ['dd']; }

    /* store, bus, state */
    function store() {
      var s = null;
      try { s = getStore(); } catch (e) {}
      return s && typeof s.get === 'function' && typeof s.set === 'function' ? s : memory;
    }
    function seed() {
      var t = realNow(), day = ymd(t);
      var s = {v: STATE_V, clock: {days: 0}, seededOn: day, basics: {}, ratings: {}, streaks: {}, settled: {}, katas: {},
        methods: [], marks: {}, budget: {}, changes: {}, versions: {}, rewrites: {}, queued: {}, fog: {}};
      AREAS.forEach(function (a) {
        s.ratings[a] = {r: R_START[a], hist: [{t: t, day: day, r: R_START[a], src: 'start'}]};
        s.streaks[a] = {miss: 0, clean: 0};
      });
      Object.keys(SEED).forEach(function (id) { s.basics[id] = seedBasic(id, day); });
      return s;
    }
    function load() {
      var s = null;
      try { s = store().get('engine'); } catch (e) { s = null; }
      if (!s || typeof s !== 'object' || s.v !== STATE_V || !s.basics || !s.ratings || !s.clock) s = seed();
      ['streaks', 'settled', 'katas', 'marks', 'budget', 'changes', 'versions', 'rewrites', 'queued', 'fog'].forEach(function (k) {
        if (!s[k] || typeof s[k] !== 'object') s[k] = {};
      });
      if (!Array.isArray(s.methods)) s.methods = [];
      return s;
    }
    function save() { try { store().set('engine', state); } catch (e) {} }
    function emit(type, data) {
      var b = null;
      try { b = getBus(); } catch (e) {}
      if (b && typeof b.emit === 'function') { try { b.emit('engine:change', assign({type: type}, data)); } catch (e2) {} }
    }
    function commit(type, data) { save(); emit(type, data); }
    state = load();

    /* simulated clock */
    function now() { return realNow() + (state.clock.days || 0) * DAY; }
    function today() { return addDays(ymd(realNow()), state.clock.days || 0); }
    function advanceDays(n) {
      n = Math.round(Number(n) || 0);
      state.clock.days = (state.clock.days || 0) + n;
      commit('clock', {days: n, today: today()});
      return today();
    }

    /* basics */
    function B(id) {
      var b = state.basics[id];
      if (b) return b;
      b = seedBasic(id, today());
      if (isBasic(id)) { state.basics[id] = b; save(); }
      return b;
    }
    function stage(id) { return B(id).stage; }
    function setStage(id, n) {
      var b = B(id);
      b.stage = clampStage(n);
      commit('stage', {basic: id, stage: b.stage});
      return b.stage;
    }
    function lastDrill(id) { var h = B(id).hist; return h.length ? copy(h[h.length - 1]) : null; }
    // Every graded retrieval of a basic, oldest first: {t, day, grade, from, to, src ('seed' | 'drill' |
    // 'fog' | 'demo'), push}. At most the last 40 are kept.
    function drillHistory(id) { return copy(B(id).hist); }
    // A clean result raises the stage at most once a simulated day: true when today's rise is spent.
    function roseToday(id) { return B(id).raisedOn === today(); }
    function due(id) { return B(id).due; }
    function pushLevel(id) { return Math.max(0, Math.min(3, B(id).push || 0)); }
    function inPush(area) { return basicIds().some(function (id) { return areaOf(id) === area && pushLevel(id) >= 3; }); }
    function weak(id) { var l = lastDrill(id); return stage(id) <= 1 || !!(l && l.grade === 'failed'); }

    // Nearest deadline for a basic: its track's test date (if still ahead) or the
    // earliest open pm task that needs it. An open task past due counts as 0 days left.
    function deadline(id) {
      var day = today(), tr = trackOf(id), best = null;
      function cand(c) { if (!best || dayNum(c.date) < dayNum(best.date)) best = c; }
      tests().forEach(function (t) {
        if (t && t.track === tr && validDate(t.date) && dayDiff(t.date, day) >= 0) cand({date: t.date, source: 'test', id: t.id, label: testName(t)});
      });
      tasks().forEach(function (t) {
        if (taskOpen(t) && validDate(t.due) && (t.needs || []).indexOf(id) >= 0) cand({date: t.due, source: 'task', id: t.id, label: t.text || t.id});
      });
      if (!best) return null;
      best.daysLeft = Math.max(0, dayDiff(best.date, day));
      return best;
    }
    function deadlineText(dl) {
      if (!dl) return 'no deadline';
      return (dl.source === 'test' ? dl.label : 'task “' + String(dl.label).slice(0, 60) + '”') + ' ' + dl.date + ' (' + dl.daysLeft + ' d)';
    }

    // One graded retrieval of a basic (drill or fog). The stage rises at most once per
    // simulated day, so several clean proofs in one sitting do not stack stages.
    function applyResult(id, grade, src) {
      var b = B(id), day = today();
      var before = {stage: b.stage, push: pushLevel(id)}, sameDay = false;
      if (grade === 'clean') {
        if (b.raisedOn === day) sameDay = true;
        else { b.stage = nextStage(b.stage, 'clean'); b.raisedOn = day; }
        b.streak = (b.streak || 0) + 1;
      } else if (grade === 'shaky') {
        b.streak = 0;
      } else {
        b.stage = 0; b.streak = 0; b.raisedOn = null;
      }
      b.last = grade;
      b.push = nextPush(before.push, grade, b.stage, b.streak);
      var dl = deadline(id), iv = intervalFor(b.stage, dl ? dl.daysLeft : null);
      b.due = addDays(day, iv);
      b.hist.push({t: now(), day: day, grade: grade, from: before.stage, to: b.stage, src: src, push: b.push});
      if (b.hist.length > 40) b.hist.splice(0, b.hist.length - 40);
      return {basic: id, grade: grade, stageBefore: before.stage, stageAfter: b.stage, pushBefore: before.push, pushAfter: b.push,
        due: b.due, interval: iv, capped: iv < INTERVALS[b.stage], sameDay: sameDay, deadline: dl};
    }
    function recordDrill(basic, grade) {
      if (GRADES.indexOf(grade) < 0 || !basic) return null;
      var res = applyResult(basic, grade, 'drill');
      commit('drill', {basic: basic, grade: grade});
      return res;
    }
    function recordFog(fogId, r) {
      r = r || {};
      var f = (C().fog || {})[fogId] || null, basic = r.basic || (f && f.basic);
      if (!basic) return null;
      // Steps are the units revealed: the merged chunks at push level 1, single steps otherwise.
      var steps = r.steps != null ? Number(r.steps)
        : (f && pushLevel(basic) === 1 && Array.isArray(f.chunks) && f.chunks.length ? f.chunks.length : (f && f.steps ? f.steps.length : 0));
      var reveals = Math.max(0, Number(r.reveals) || 0);
      if (!r.done) {
        var s = stage(basic), p = pushLevel(basic);
        return {basic: basic, grade: null, done: false, stageBefore: s, stageAfter: s, pushBefore: p, pushAfter: p};
      }
      var grade = fogGrade(reveals, steps, r.clean);
      var res = applyResult(basic, grade, 'fog');
      state.fog[fogId] = {t: now(), day: today(), reveals: reveals, steps: steps, grade: grade, push: res.pushBefore};
      commit('fog', {fogId: fogId, basic: basic, grade: grade});
      return assign(res, {fogId: fogId, done: true});
    }
    // The last finished attempt of a fog block: {t, day, reveals, steps, grade, push} or null.
    function fogRecord(fogId) { return has(state.fog, fogId) ? copy(state.fog[fogId]) : null; }

    /* ratings and streaks */
    function R(area) {
      var a = state.ratings[area];
      if (!a) {
        var r0 = has(R_START, area) ? R_START[area] : 4;
        a = state.ratings[area] = {r: r0, hist: [{t: now(), day: today(), r: r0, src: 'start'}]};
      }
      return a;
    }
    function rating(area) { return R(area).r; }
    function history(area) { return copy(R(area).hist); }
    function streakRec(area) { var s = state.streaks[area]; if (!s) s = state.streaks[area] = {miss: 0, clean: 0}; return s; }
    function streaks(area) { return copy(streakRec(area)); }

    // Stretch target: E = 0.65. Hidden-topic: one step below it. Eased: one step
    // easier after 2 misses in a row. Reach (allowed after 3 clean holds): E = 0.40.
    function target(area, opt) {
      opt = opt || {};
      var r = rating(area), st = streakRec(area), base = dForE(r, E_TARGET), d, eased = false;
      if (opt.reach) d = dForE(r, E_REACH);
      else {
        d = base;
        if (opt.hidden) d -= HIDDEN_STEP;
        if (st.miss >= MISS_RUN) { d -= EASE_STEP; eased = true; }
      }
      return {d: d, E: expected(d, r), r: r, base: base, eased: eased, hidden: !!opt.hidden, reach: !!opt.reach,
        band: {lo: dForE(r, E_HI), hi: dForE(r, E_LO)}};
    }

    /* picks */
    function closest(cands, targetOf) {
      var day = today(), best = null, bs = Infinity, bh = 0;
      cands.forEach(function (x) {
        var s = Math.abs(dOf(x) - targetOf(x)), h = hash01(day + '|' + x.id);
        if (s < bs - 1e-9 || (Math.abs(s - bs) <= 1e-9 && h < bh)) { best = x; bs = s; bh = h; }
      });
      return best;
    }
    // An area is practised when the demo has a basic in it, or something in it was settled and counted.
    // General reasoning always counts: hidden-topic slots draw from "other practised areas or general reasoning".
    function practised(area) {
      if (area === 'gr') return true;
      if (basicIds().some(function (id) { return areaOf(id) === area; })) return true;
      var all = [];
      Object.keys(state.settled).forEach(function (k) { all.push(state.settled[k]); });
      Object.keys(state.katas).forEach(function (k) { all.push(state.katas[k]); });
      return all.some(function (x) { return x && x.area === area && x.kind !== 'theorem' && x.score !== null; });
    }
    // After MISS_RUN misses the target eases a step. The bank may have nothing near the eased target, so
    // eased picks keep to items at or below the plain stretch target (E >= 0.65) whenever any are left:
    // an eased pick is never harder than an uneased one would have been.
    function easeFilter(area, cands) {
      var tg = target(area, {});
      if (!tg.eased) return cands;
      var easier = cands.filter(function (x) { return dOf(x) <= tg.base + 1e-9; });
      return easier.length ? easier : cands;
    }
    // Regular: same area, nearest the area's target. Hidden: hiddenOK problems from another practised
    // area (or general reasoning), nearest that area's hidden target.
    function pickProblem(area, opt) {
      opt = opt || {};
      var ex = opt.exclude || [], hidden = !!opt.hidden, reach = !!opt.reach && !hidden;
      var cands = problems().filter(function (p) {
        if (!p || !isFinite(dOf(p)) || has(state.settled, p.id) || ex.indexOf(p.id) >= 0) return false;
        if (hidden) return !!p.hiddenOK && p.area !== area && has(AREA_NAMES, p.area) && practised(p.area);
        return p.area === area;
      });
      if (!hidden && !reach) cands = easeFilter(area, cands);
      return closest(cands, function (p) { return target(hidden ? p.area : area, {hidden: hidden, reach: reach}).d; });
    }
    // Hidden slots take hidden katas only. Otherwise: simple katas outside push mode; in push mode a
    // harder kata comes first when it is within reach (E >= E_REACH), else the nearest visible kata;
    // a reach slot may take any visible kata.
    function pickKata(area, opt) {
      opt = opt || {};
      var ex = opt.exclude || [], hidden = !!opt.hidden, reach = !!opt.reach && !hidden;
      var cands = katas().filter(function (k) {
        if (!k || !isFinite(dOf(k)) || has(state.katas, k.id) || ex.indexOf(k.id) >= 0 || kataArea(k) !== area) return false;
        return hidden ? !!k.hidden : !k.hidden;
      });
      if (!hidden && !reach) {
        if (inPush(area)) {
          var r = rating(area), hard = cands.filter(function (k) { return k.level === 'hard' && expected(dOf(k), r) >= E_REACH - 1e-9; });
          if (hard.length) cands = hard;
        } else {
          cands = cands.filter(function (k) { return k.level !== 'hard'; });
        }
        cands = easeFilter(area, cands);
      }
      return closest(cands, function () { return target(area, {hidden: hidden, reach: reach}).d; });
    }
    function slotSpecs(area) {
      var push = inPush(area), specs = [], i;
      for (i = 0; i < SLOTS; i++) specs.push({slot: i, hidden: isHiddenSlot(i, push), reach: false});
      if (streakRec(area).clean >= CLEAN_RUN) {
        for (i = 0; i < specs.length; i++) if (!specs[i].hidden) { specs[i].reach = true; break; }
      }
      return {push: push, specs: specs};
    }
    // easedOK: the target was eased and the pick really sits at or below the uneased target.
    function problemWhy(t, hidden, reach, E, easedOK) {
      if (hidden) return 'Topic hidden: finding the method is part of the problem. Pitched one step below your stretch target (E ' + f2(E) + ').';
      if (reach) return 'Reach, after ' + CLEAN_RUN + ' clean holds in a row: E ' + f2(E) + ' (target E ' + f2(E_REACH) + ').';
      if (t.eased) return easedOK ? 'Eased one step after ' + MISS_RUN + ' misses in a row: E ' + f2(E) + '.'
        : 'After ' + MISS_RUN + ' misses in a row this pick should be one step easier, but nothing easier is left in the bank: E ' + f2(E) + '.';
      return 'Stretch: E ' + f2(E) + ' at r ' + f2(t.r) + ' (band ' + f2(E_LO) + '–' + f2(E_HI) + ').';
    }
    function fillProblems(area, out, meta) {
      var ss = slotSpecs(area), used = out.map(function (x) { return x.id; }), m = {kind: 'problem', push: ss.push, total: SLOTS, hidden: 0, filled: 0, reach: false};
      ss.specs.forEach(function (s) {
        var p = pickProblem(area, {hidden: s.hidden, reach: s.reach, exclude: used});
        if (!p) return;
        used.push(p.id);
        var t = target(s.hidden ? p.area : area, {hidden: s.hidden, reach: s.reach});
        var E = expected(dOf(p), rating(p.area)), easedOK = t.eased && dOf(p) <= t.d + EASE_STEP + 1e-9;
        if (s.hidden) m.hidden++;
        if (s.reach) m.reach = true;
        m.filled++;
        out.push({problem: p, id: p.id, slot: s.slot, slotArea: area, hidden: s.hidden, reach: s.reach, eased: easedOK,
          easeShort: t.eased && !easedOK, d: dOf(p), E: E, target: t.d, targetE: t.E, inBand: E >= E_LO - 1e-9 && E <= E_HI + 1e-9,
          topic: s.hidden ? null : (AREA_NAMES[p.area] || p.area), why: problemWhy(t, s.hidden, s.reach, E, easedOK)});
      });
      meta[area] = m;
    }
    function fillKatas(area, out, meta) {
      var ss = slotSpecs(area), used = out.map(function (x) { return x.id; }), m = {kind: 'kata', push: ss.push, total: SLOTS, hidden: 0, filled: 0, reach: false};
      ss.specs.forEach(function (s) {
        var k = pickKata(area, {hidden: s.hidden, reach: s.reach, exclude: used});
        if (!k) return;
        used.push(k.id);
        var E = expected(dOf(k), rating(area)), t = target(area, {}), easedOK = !s.hidden && !s.reach && t.eased && dOf(k) <= t.base + 1e-9;
        if (s.hidden) m.hidden++;
        if (s.reach) m.reach = true;
        m.filled++;
        var short = !s.hidden && !s.reach && t.eased && !easedOK;
        var why = s.hidden ? 'Technique not named: work out what the spec needs.'
          : s.reach ? 'Reach, after ' + CLEAN_RUN + ' clean passes in a row: E ' + f2(E) + '.'
          : easedOK ? 'Eased one step after ' + MISS_RUN + ' misses in a row: E ' + f2(E) + '.'
          : short ? 'After ' + MISS_RUN + ' misses in a row this kata should be one step easier, but nothing easier is left: E ' + f2(E) + '.'
          : k.level === 'hard' ? 'Push mode: a harder multi-part kata, within reach (E ' + f2(E) + ').'
          : 'Kata near your stretch (E ' + f2(E) + ').';
        out.push({kata: k, id: k.id, slot: s.slot, slotArea: area, hidden: s.hidden, reach: s.reach, level: k.level || 'simple', eased: easedOK, easeShort: short,
          d: dOf(k), E: E, topic: s.hidden ? null : (AREA_NAMES[area] || area), why: why});
      });
      meta[area] = m;
    }
    function drillWhy(od, dl) {
      return (dl ? 'Nearest deadline: ' + deadlineText(dl) : 'No deadline ahead') + (od > 0 ? '; overdue ' + od + ' d.' : '; due today.');
    }
    // Due drills, ranked by the nearest deadline that needs the basic (its test date or the earliest open
    // task), then by days overdue. `priority` (overdue x deadline weight) is kept for display.
    function todayPlan() {
      var day = today();
      var drills = basicIds().map(function (id) {
        var b = B(id), od = dayDiff(day, b.due);
        if (od < 0) return null;
        var dl = deadline(id), f = deadlineFactor(dl ? dl.daysLeft : null);
        return {basic: id, priority: od * f, overdue: od, factor: f, deadline: dl, daysLeft: dl ? dl.daysLeft : null, stage: b.stage,
          push: pushLevel(id), due: b.due, why: drillWhy(od, dl)};
      }).filter(Boolean).sort(function (a, b) {
        var da = a.daysLeft == null ? Infinity : a.daysLeft, db = b.daysLeft == null ? Infinity : b.daysLeft;
        return (da === db ? 0 : da - db) || b.overdue - a.overdue || a.stage - b.stage || (a.basic < b.basic ? -1 : 1);
      });
      var probs = [], kts = [], slots = {};
      problemAreas().forEach(function (a) { fillProblems(a, probs, slots); });
      kataAreas().forEach(function (a) { fillKatas(a, kts, slots); });
      var push = {};
      AREAS.forEach(function (a) { push[a] = inPush(a); });
      return {day: day, drills: drills, problems: probs, katas: kts, push: push, slots: slots};
    }
    function planEntry(kind, id) {
      var p = todayPlan(), L = kind === 'kata' ? p.katas : p.problems;
      for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i];
      return null;
    }

    /* settling, method identification */
    // A method's own basic(s), from the method entry in content (e.g. modular -> nt-units).
    // A general method with no basic (parity, construction ...) has none.
    function methodBasics(m) {
      var e = methodEntry(m);
      return e ? uniq([].concat(e.basic || [], e.basics || [])).filter(isBasic) : [];
    }
    // "Adit knew the method": its basic is at stage >= 3. A method with no basic of its own
    // can be missed (method accuracy counts it) but is never a recognition gap.
    function knownVia(m) {
      var known = methodBasics(m).filter(function (b) { return stage(b) >= KNOWN_STAGE; });
      return known.length ? known[0] : null;
    }
    function topicFor(basic) {
      var ds = docs(), ids = Object.keys(ds), i;
      for (i = 0; i < ids.length; i++) if (ds[ids[i]] && ds[ids[i]].kind === 'topic' && (ds[ids[i]].needs || []).indexOf(basic) >= 0) return ids[i];
      var ar = areaOf(basic);
      for (i = 0; i < ids.length; i++) if (ds[ids[i]] && ds[ids[i]].kind === 'topic' && ds[ids[i]].area === ar) return ids[i];
      return basic;
    }
    function settleCommon(x) {
      var a = R(x.area), rBefore = a.r, E = expected(x.d, rBefore), rAfter = rBefore, t = now(), day = today();
      var st = streakRec(x.area);
      if (x.score !== null) {
        rAfter = rBefore + K * (x.score - E);
        a.r = rAfter;
        a.hist.push({t: t, day: day, r: rAfter, src: x.kind, id: x.id});
        if (a.hist.length > 200) a.hist.splice(0, a.hist.length - 200);
        if (x.score === 1) { st.clean += 1; st.miss = 0; }
        else if (x.score === 0) { st.miss += 1; st.clean = 0; }
        else { st.miss = 0; st.clean = 0; }
        if (x.reach) st.clean = 0;   // the reach is spent
      }
      return assign({id: x.id, kind: x.kind, label: x.label, area: x.area, d: x.d, verdict: x.verdict, help: !!x.help, score: x.score,
        E: E, rBefore: rBefore, rAfter: rAfter, hidden: !!x.hidden, reach: !!x.reach,
        confidence: x.confidence, ms: x.ms, streak: copy(st), t: t, day: day}, methodPart(x));
    }
    // Method identification for one settled item. `called` missing means the ticks have not
    // been given yet (nothing counted); `took` missing defaults to the item's own methods.
    // Called again with the ticks later, it replaces the item's entry and never re-rates.
    function methodPart(x) {
      var pending = !Array.isArray(x.called);
      var called = pending ? [] : uniq(x.called);
      var took = uniq(Array.isArray(x.took) ? x.took : (x.item.methods || []));
      var methodHit = null, extra = [], gaps = [];
      state.methods = state.methods.filter(function (m) { return !(m.kind === x.kind && m.id === x.id); });
      if (!pending && x.score !== null && took.length) {
        methodHit = took.every(function (m) { return called.indexOf(m) >= 0; });
        extra = called.filter(function (m) { return took.indexOf(m) < 0; });
        took.forEach(function (m) {
          if (called.indexOf(m) >= 0) return;
          var kb = knownVia(m);
          if (kb) gaps.push({method: m, label: methodLabel(m), basic: kb, stage: stage(kb), doc: topicFor(kb)});
        });
        state.methods.push({t: now(), day: today(), id: x.id, kind: x.kind, area: x.area, hidden: !!x.hidden, called: called, took: took,
          hit: methodHit, confidence: x.confidence});
      }
      var recognitionGap = null;
      if (gaps.length) {
        gaps.forEach(function (g) {
          var logged = (state.changes[g.doc] || []).some(function (e) { return e.kind === 'recognise' && e.item === x.id && e.method === g.method; });
          if (!logged) {
            logChange(g.doc, 'Recognise: ' + g.label + ' was the way into ' + x.label + ', and the call did not name it. You hold ' +
              docTitle(g.basic) + ' at stage ' + g.stage + '.', 'recognise', {method: g.method, item: x.id, basic: g.basic}, true);
          }
        });
        recognitionGap = {methods: gaps, doc: gaps[0].doc,
          note: 'Recognition gap: you knew ' + gaps.map(function (g) { return g.label; }).join(', ') + ' (stage ' + KNOWN_STAGE +
            ' or more) but the call did not name it. Logged to the Recognise list of ' + docTitle(gaps[0].doc) + '.'};
      }
      var linksBack = (x.item.basics || []).slice();
      took.forEach(function (m) { linksBack = linksBack.concat(methodBasics(m)); });
      linksBack = uniq(linksBack).filter(isBasic);
      return {called: called, took: took, methodsPending: pending, methodHit: methodHit, extra: extra, gaps: gaps,
        recognitionGap: recognitionGap, linksBack: linksBack};
    }
    // Ticks sent after the item was settled: update method identification only.
    function retick(kind, rec, item, o2) {
      if (!Array.isArray(o2.called) && !Array.isArray(o2.took)) return assign(copy(rec), {already: true});
      var called = Array.isArray(o2.called) ? o2.called : (rec.methodsPending ? undefined : rec.called);
      assign(rec, methodPart({kind: kind, id: rec.id, item: item, label: rec.label, area: rec.area, hidden: rec.hidden, score: rec.score,
        called: called, took: Array.isArray(o2.took) ? o2.took : rec.took, confidence: rec.confidence}));
      commit('settle', {kind: kind, id: rec.id, update: true});
      return assign(copy(rec), {already: true, updated: true});
    }
    // Optional extras the UI may pass when settling: the confidence chip (%) and time spent (ms).
    function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
    function settleProblem(id, o2) {
      o2 = o2 || {};
      var p = problemById(id);
      if (!p || !isFinite(dOf(p))) return null;
      if (has(state.settled, id)) return retick(state.settled[id].kind === 'theorem' ? 'theorem' : 'problem', state.settled[id], p, o2);
      var verdict = o2.verdict, help = !!o2.help || !!o2.gaveUp;
      if (verdict === 'help') { verdict = 'held'; help = true; }
      if (/^gave[ -]?up$/i.test(String(verdict))) { verdict = 'missed'; help = true; }
      if (VERDICTS.indexOf(verdict) < 0) return null;   // nothing recorded without a settle verb
      if (p.kind === 'theorem') return settleTheorem(id, p, o2, verdict, help);
      var pe = (typeof o2.hidden === 'boolean' && typeof o2.reach === 'boolean') ? null : planEntry('problem', id);
      var hidden = typeof o2.hidden === 'boolean' ? o2.hidden : !!(pe && pe.hidden);
      var reach = typeof o2.reach === 'boolean' ? o2.reach : !!(pe && pe.reach);
      var res = settleCommon({kind: 'problem', id: id, item: p, label: p.label || id, area: p.area || 'gr', d: dOf(p),
        score: scoreFor(verdict, help), verdict: verdict, help: help, called: o2.called, took: o2.took, hidden: hidden, reach: reach,
        confidence: num(o2.confidence), ms: num(o2.ms)});
      state.settled[id] = res;
      commit('settle', {kind: 'problem', id: id, verdict: verdict});
      return copy(res);
    }
    // A theorem proved problem-first (push level 3) is a retrieval of its basic, posed as a problem: the
    // call and its ticks count for method identification (judged against what Adit knew when calling),
    // and the verdict grades the basic like a drill (held clean, held after help shaky, missed or blind
    // failed, moot nothing). The area rating does not move: it tracks problems from the bank.
    function settleTheorem(id, p, o2, verdict, help) {
      var a = R(p.area), score = scoreFor(verdict, help), conf = num(o2.confidence);
      var mp = methodPart({kind: 'theorem', id: id, item: p, label: p.label, area: p.area, hidden: false, score: score,
        called: o2.called, took: o2.took, confidence: conf});
      var grade = verdict === 'moot' ? null : verdict === 'held' ? (help ? 'shaky' : 'clean') : 'failed';
      var drill = grade ? applyResult(p.basic, grade, 'hook') : null;
      var res = assign({id: id, kind: 'theorem', label: p.label, area: p.area, d: dOf(p), verdict: verdict, help: help, score: score,
        E: null, rBefore: a.r, rAfter: a.r, rated: false, hidden: false, reach: false, confidence: conf, ms: num(o2.ms),
        t: now(), day: today(), fogId: p.fogId, basic: p.basic, grade: grade, drill: drill}, mp);
      state.settled[id] = res;
      commit('settle', {kind: 'theorem', id: id, verdict: verdict, basic: p.basic, grade: grade});
      return copy(res);
    }
    function settleKata(id, o2) {
      o2 = o2 || {};
      var k = kataById(id);
      if (!k || !isFinite(dOf(k))) return null;
      if (has(state.katas, id)) return retick('kata', state.katas[id], k, o2);
      var score = kataScore(o2.pass, o2.runs, o2.gaveUp);
      var verdict = score > 0 ? 'held' : o2.gaveUp ? 'gave up' : 'missed';
      var pe = (typeof o2.hidden === 'boolean' && typeof o2.reach === 'boolean') ? null : planEntry('kata', id);
      var hidden = typeof o2.hidden === 'boolean' ? o2.hidden : !!(k.hidden || (pe && pe.hidden));
      var reach = typeof o2.reach === 'boolean' ? o2.reach : !!(pe && pe.reach);
      var res = settleCommon({kind: 'kata', id: id, item: k, label: k.title || id, area: kataArea(k), d: dOf(k), score: score,
        verdict: verdict, help: score === 0.75, called: o2.called, took: o2.took, hidden: hidden, reach: reach,
        confidence: num(o2.confidence), ms: num(o2.ms)});
      res.pass = !!o2.pass; res.runs = Number(o2.runs) || 0; res.gaveUp = !!o2.gaveUp;
      state.katas[id] = res;
      commit('settle', {kind: 'kata', id: id, verdict: verdict});
      return copy(res);
    }
    function settled(id) { return has(state.settled, id) ? copy(state.settled[id]) : null; }
    function kataResult(id) { return has(state.katas, id) ? copy(state.katas[id]) : null; }
    // Every settled problem and kata record (each carries kind 'problem' or 'kata'), newest first.
    function settledAll() {
      var out = [];
      Object.keys(state.settled).forEach(function (k) { out.push(copy(state.settled[k])); });
      Object.keys(state.katas).forEach(function (k) { out.push(copy(state.katas[k])); });
      return out.sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    }
    function methodFilter(area, opt) {
      opt = opt || {};
      return state.methods.filter(function (m) {
        return (!area || m.area === area) && (opt.hidden == null || m.hidden === !!opt.hidden) && (!opt.kind || m.kind === opt.kind);
      });
    }
    function methodAccuracy(area, opt) {
      var L = methodFilter(area, opt), hits = L.filter(function (m) { return m.hit; }).length;
      return {hits: hits, total: L.length, rate: L.length ? hits / L.length : null};
    }
    function solveRate(area) {
      var all = [];
      Object.keys(state.settled).forEach(function (k) { all.push(state.settled[k]); });
      Object.keys(state.katas).forEach(function (k) { all.push(state.katas[k]); });
      var L = all.filter(function (x) { return x.score !== null && x.kind !== 'theorem' && (!area || x.area === area); });
      return {held: L.filter(function (x) { return x.score > 0; }).length, clean: L.filter(function (x) { return x.score === 1; }).length, total: L.length};
    }

    /* Changes log */
    function logChange(docId, text, kind, extra, quiet) {
      if (!docId) return null;
      var L = state.changes[docId] || (state.changes[docId] = []);
      var e = assign({t: now(), day: today(), text: String(text), kind: kind || 'note'}, extra);
      L.push(e);
      if (L.length > 200) L.splice(0, L.length - 200);
      if (!quiet) commit('change', {docId: docId});
      return copy(e);
    }
    function changes(docId) { return copy(state.changes[docId] || []); }
    function recognise(docId) { return changes(docId).filter(function (e) { return e.kind === 'recognise'; }); }

    /* versions, budget, marks */
    function docVersion(id) { return state.versions[id] || 1; }
    // The reader switches builds (after a rebuild-basic, or from its build buttons) and
    // writes the Changes entry itself, so this does not log.
    function setDocVersion(id, v) {
      v = Math.max(1, Math.round(Number(v) || 1));
      var was = docVersion(id);
      if (v === was) return v;
      state.versions[id] = v;
      commit('version', {docId: id, version: v, from: was});
      return v;
    }
    function nextVersion(id) {
      var d = doc(id), v = docVersion(id), best = null;
      if (!d || !d.versions) return null;
      Object.keys(d.versions).forEach(function (k) { var n = Number(k); if (n > v && (best === null || n < best)) best = n; });
      return best;
    }
    function rebuilt(id) { return docVersion(id) > 1 || has(state.queued, id); }
    function budget(docId) {
      var used = state.budget[docId] || 0;
      return {used: used, max: REWRITE_MAX, left: Math.max(0, REWRITE_MAX - used)};
    }
    function markRec(docId, anchor) { return (state.marks[docId] || {})[anchor] || null; }
    function setMark(docId, anchor, m) { (state.marks[docId] || (state.marks[docId] = {}))[anchor] = m; return m; }
    function marks(docId) { return copy(state.marks[docId] || {}); }
    function mark(docId, anchor) { return copy(markRec(docId, anchor)); }
    function clearMark(docId, anchor) {
      if (!markRec(docId, anchor)) return false;
      delete state.marks[docId][anchor];
      commit('mark', {docId: docId, anchor: anchor, cleared: true});
      return true;
    }

    // The HTML of the marked passage in the doc's current version: from the anchored
    // element to the next anchored element (a heading runs to the next heading).
    function passageHtml(docId, anchor) {
      var d = doc(docId);
      if (!d || !d.versions) return '';
      var html = String(d.versions[docVersion(docId)] || d.versions[1] || ''), key = 'data-a="' + anchor + '"';
      var i = html.indexOf(key);
      if (i < 0) return '';
      var start = html.lastIndexOf('<', i), end;
      var tag = ((/^<([a-zA-Z0-9]+)/.exec(html.slice(start)) || [])[1] || '').toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        var re = new RegExp('<h[1-' + tag.charAt(1) + '][\\s>]', 'ig');
        re.lastIndex = i;
        var m = re.exec(html);
        end = m ? m.index : html.length;
      } else {
        var j = html.indexOf('data-a="', i + key.length);
        end = j < 0 ? html.length : html.lastIndexOf('<', j);
      }
      return html.slice(start, end);
    }
    function blockIds(html, type) {
      var out = [], re = /<div\b[^>]*>/g, m;
      while ((m = re.exec(html))) {
        if (m[0].indexOf('data-block="' + type + '"') < 0) continue;
        var idm = /data-id="([^"]+)"/.exec(m[0]);
        if (idm) out.push(idm[1]);
      }
      return out;
    }
    // Basics a passage links to: its links (from the reader or the HTML), the basics of its fog
    // blocks and visible katas. Problem hooks are left out so a scaffold never names a hook's method.
    function linkedBasics(docId, anchor, links) {
      var out = [];
      function add(id) { if (id && id !== docId && isBasic(id) && out.indexOf(id) < 0) out.push(id); }
      (links || []).forEach(function (l) { add(String(l).split('#')[0]); });
      var html = passageHtml(docId, anchor), re = /data-to="([^"#]*)/g, m;
      while ((m = re.exec(html))) add(m[1]);
      blockIds(html, 'fog').forEach(function (fid) { var f = (C().fog || {})[fid]; if (f) add(f.basic); });
      blockIds(html, 'kata').forEach(function (kid) { var k = kataById(kid); if (k && !k.hidden) (k.basics || []).forEach(add); });
      return out;
    }
    // Basics a passage rests on, for the scaffold to show: the linked ones; failing that, the doc's
    // needs. Only linked basics decide a rebuild (triage), never this fallback.
    function passageBasics(docId, anchor, links) {
      var out = linkedBasics(docId, anchor, links);
      if (!out.length) {
        var d = doc(docId);
        ((d && d.needs) || []).forEach(function (id) { if (id && id !== docId && isBasic(id) && out.indexOf(id) < 0) out.push(id); });
      }
      return out;
    }
    function pullForward(ids) {
      var day = today(), moved = [];
      uniq(ids).forEach(function (id) {
        if (!isBasic(id)) return;
        var b = B(id);
        if (dayDiff(b.due, day) > 0) { b.due = day; moved.push(id); }
      });
      return moved;
    }
    function weakest(ids) {
      var L = uniq(ids).filter(isBasic).sort(function (a, b) { return stage(a) - stage(b) || dayNum(due(a)) - dayNum(due(b)) || (a < b ? -1 : 1); });
      return L.length ? L[0] : null;
    }
    function names(ids) { return ids.map(docTitle).join(', '); }
    function when(ms) { var d = new Date(ms); return ymd(ms) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

    // A margin mark. 'lost' is rationed: a gap in a basic rebuilds that basic (free);
    // otherwise scaffold, and a rewrite only after a day still lost with an attempt in ink.
    function triage(q) {
      q = q || {};
      var docId = q.docId, anchor = q.anchor, verb = q.verb || 'lost', d = doc(docId);
      if (!d || !anchor) return {action: 'noted', status: null, reason: 'Unknown passage.', basics: []};
      var linked = linkedBasics(docId, anchor, q.links), rest = passageBasics(docId, anchor, q.links), mk = markRec(docId, anchor), t = now();
      if (verb === 'clear') {
        clearMark(docId, anchor);
        return {action: 'noted', status: 'cleared', reason: 'Mark cleared.', basics: rest};
      }
      if (verb !== 'lost') {
        setMark(docId, anchor, {verb: verb, t: t, status: 'noted'});
        var reason = 'Marked ' + verb + '.';
        if (verb === 'forgot') {
          var moved = pullForward(d.kind === 'basic' ? [docId].concat(rest) : rest);
          reason = moved.length ? 'Marked forgot. Drill pulled forward to today: ' + names(moved) + '.' : 'Marked forgot. The drills it rests on are already due.';
        }
        commit('triage', {docId: docId, anchor: anchor, verb: verb, action: 'noted'});
        return {action: 'noted', status: 'noted', reason: reason, basics: rest};
      }
      var strokes = q.attemptStrokes != null ? Math.max(0, Number(q.attemptStrokes) || 0) : ((mk && mk.attemptStrokes) || 0);

      // 1. The gap is in a basic: the mark is on a basic, or a basic the passage links to is weak
      // (stage <= 1 or its last drill failed). Rebuild that whole basic from its prerequisites
      // (budget-free). A passage that links no basic is never rebuilt through the doc's needs.
      // The engine decides; the reader switches the version, re-anchors ink and writes the
      // basic's Changes entry. The request is recorded so a basic is rebuilt once, then rationed.
      var weakLinked = linked.filter(function (b) { return weak(b) && !rebuilt(b); });
      var targets = weakLinked.length ? weakLinked : (d.kind === 'basic' && !rebuilt(docId) ? [docId] : []);
      if (targets.length) {
        var queued = [], versions = {};
        targets.forEach(function (b) {
          var nv = nextVersion(b);
          state.queued[b] = t;
          if (nv) versions[b] = nv; else queued.push(b);
        });
        if (targets.indexOf(docId) < 0) {
          logChange(docId, 'Lost at #' + anchor + ': the gap is in ' + names(targets) + ', so that basic is rebuilt from its prerequisites instead of this passage. No rewrite budget spent.',
            'rebuild', {anchor: anchor, basics: targets}, true);
        }
        setMark(docId, anchor, {verb: 'lost', t: t, since: t, status: 'rebuilt', attemptStrokes: strokes, basics: targets});
        commit('triage', {docId: docId, anchor: anchor, verb: 'lost', action: 'rebuild-basic'});
        var why = weakLinked.length
          ? 'The gap is in a basic: ' + targets.map(function (b) { return docTitle(b) + ' (stage ' + stage(b) + (weak(b) && stage(b) > 1 ? ', last drill failed' : '') + ')'; }).join(', ') + '. '
          : 'Lost inside a basic. ';
        why += queued.length < targets.length ? 'The whole basic is rebuilt from its prerequisites. No rewrite budget spent.'
          : 'A rebuild from its prerequisites is queued for the teach pass (no rebuilt version in this demo). No rewrite budget spent.';
        return {action: 'rebuild-basic', status: 'rebuilt', reason: why, basics: targets, versions: versions, queued: queued};
      }

      // 2. Rationed: scaffold now, a rewrite only after a day still lost with an attempt.
      var cont = mk && mk.verb === 'lost' && (mk.status === 'struggling' || mk.status === 'eligible' || mk.status === 'exhausted');
      if (!cont) {
        setMark(docId, anchor, {verb: 'lost', t: t, since: t, status: 'struggling', attemptStrokes: strokes, basics: rest});
        commit('triage', {docId: docId, anchor: anchor, verb: 'lost', action: 'scaffold'});
        return {action: 'scaffold', status: 'struggling', basics: rest, since: t, eligibleAt: t + ELIGIBLE_MS,
          reason: 'Not a gap in a basic. The basics this passage rests on are linked, and the box below is for your attempt. ' +
            'If it is still lost after a day and the box has ink, a rewrite can be requested.'};
      }
      return ration(docId, anchor, d, mk, rest, strokes, t, true);
    }
    // A lost mark already in the rationed cycle: still scaffold, eligible, or out of budget. remark: Adit
    // marked it lost again (triage); otherwise a recheck (a stroke, the clock, a rewrite elsewhere on the doc).
    function ration(docId, anchor, d, mk, rest, strokes, t, remark) {
      mk.attemptStrokes = strokes;
      mk.basics = rest;
      var at = mk.since + ELIGIBLE_MS, waited = t >= at, inked = strokes > 0;
      if (!waited || !inked) {
        mk.status = 'struggling';
        commit('triage', {docId: docId, anchor: anchor, verb: 'lost', action: 'scaffold'});
        return {action: 'scaffold', status: 'struggling', basics: rest, since: mk.since, eligibleAt: at,
          reason: !waited ? (remark ? 'Still lost. ' : 'Not a gap in a basic: the basics it rests on are linked, and the box is for your attempt. ') +
            'A rewrite opens at ' + when(at) + (inked ? '.' : ', once the box has an attempt in ink.')
            : 'A day has passed. Write an attempt in the box first; then a rewrite can be requested.'};
      }
      var bud = budget(docId);
      if (bud.used >= bud.max) {
        mk.status = 'exhausted';
        var drill = weakest(rest.length ? rest : (d.kind === 'basic' ? [docId] : []));
        if (drill) pullForward([drill]);
        commit('triage', {docId: docId, anchor: anchor, verb: 'lost', action: 'budget-exhausted'});
        return {action: 'budget-exhausted', status: 'exhausted', basics: rest, drill: drill, since: mk.since, eligibleAt: at,
          reason: 'This doc has used its ' + bud.max + ' rewrites.' + (drill ? ' Drill ' + docTitle(drill) + ' instead; it is due today.' : '')};
      }
      mk.status = 'eligible';
      commit('triage', {docId: docId, anchor: anchor, verb: 'lost', action: 'eligible'});
      return {action: 'eligible', status: 'eligible', basics: rest, since: mk.since, eligibleAt: at, left: bud.left,
        reason: 'A day still lost, and the box has an attempt. A rewrite can be requested (' + bud.left + ' of ' + bud.max + ' left).'};
    }
    // Re-evaluate an existing mark without starting a new cycle: for re-renders, a moved
    // clock, or a changed attempt box. Returns null when there is no mark.
    function recheck(docId, anchor, attemptStrokes) {
      var mk = markRec(docId, anchor), d = doc(docId);
      if (!mk || !d) return null;
      var rest = passageBasics(docId, anchor);
      if (mk.verb !== 'lost') return {action: 'noted', status: mk.status || 'noted', basics: rest, reason: 'Marked ' + mk.verb + '.'};
      if (mk.status === 'rebuilt') {
        return {action: 'rebuild-basic', status: 'rebuilt', basics: (mk.basics || []).slice(), queued: [], versions: {}, done: true,
          reason: 'The gap was in a basic: ' + names(mk.basics || []) + ' was rebuilt from its prerequisites.'};
      }
      if (mk.status === 'rewritten') {
        var bud = budget(docId);
        return {action: 'noted', status: 'rewritten', basics: rest, html: rewriteOf(docId, anchor),
          reason: 'Rewritten after a day still lost (' + bud.used + ' of ' + bud.max + ' rewrites used).'};
      }
      var strokes = attemptStrokes != null ? Math.max(0, Number(attemptStrokes) || 0) : (mk.attemptStrokes || 0);
      return ration(docId, anchor, d, mk, rest, strokes, now(), false);
    }
    function requestRewrite(docId, anchor) {
      var mk = markRec(docId, anchor), bud = budget(docId);
      if (bud.used >= bud.max) return {ok: false, reason: 'budget', used: bud.used, max: bud.max, left: 0};
      var ok = mk && mk.verb === 'lost' && (mk.status === 'eligible' ||
        (mk.status === 'struggling' && now() >= mk.since + ELIGIBLE_MS && (mk.attemptStrokes || 0) > 0));
      if (!ok) return {ok: false, reason: 'not-eligible', used: bud.used, max: bud.max, left: bud.left};
      state.budget[docId] = bud.used + 1;
      mk.status = 'rewritten';
      mk.rewrittenAt = now();
      var html = ((C().rewrites || {})[docId] || {})[anchor] || null;
      (state.rewrites[docId] || (state.rewrites[docId] = {}))[anchor] = {t: now(), day: today(), available: !!html};
      logChange(docId, 'Rewrote #' + anchor + ' after a day still lost and an attempt in ink (' + (bud.used + 1) + ' of ' + bud.max + ' rewrites used).' +
        (html ? '' : ' Queued for the teach pass: this demo has no rewrite of that passage.'), 'rewrite', {anchor: anchor}, true);
      commit('rewrite', {docId: docId, anchor: anchor});
      return {ok: true, used: bud.used + 1, max: bud.max, left: bud.max - bud.used - 1, html: html};
    }
    function rewriteOf(docId, anchor) {
      if (!has(state.rewrites[docId] || {}, anchor)) return null;
      return ((C().rewrites || {})[docId] || {})[anchor] || null;
    }
    function rewritten(docId) { return Object.keys(state.rewrites[docId] || {}); }

    /* map: blockers between pm tasks and weak basics */
    // Earliest day a basic can reach stage 3 with clean drills on each due date.
    function reachKnownBy(id) {
      var b = B(id), day = today(), d = dayDiff(b.due, day) > 0 ? b.due : day, s = b.stage, dl = deadline(id);
      if (s >= KNOWN_STAGE) return d;
      for (var guard = 0; guard < 12; guard++) {
        s = Math.min(MAX_STAGE, s + 1);
        if (s >= KNOWN_STAGE) return d;
        d = addDays(d, intervalFor(s, dl ? dayDiff(dl.date, d) : null));
      }
      return d;
    }
    function blockers() {
      var out = [];
      tasks().forEach(function (t) {
        if (!taskOpen(t)) return;
        var needs = uniq(t.needs || []).filter(isBasic);
        var w = needs.filter(function (b) { return stage(b) < KNOWN_STAGE || weak(b); });
        if (!w.length) return;
        var detail = w.map(function (b) {
          var by = reachKnownBy(b), risk = validDate(t.due) ? dayDiff(by, t.due) > 0 : false;
          return {basic: b, stage: stage(b), push: pushLevel(b), due: due(b), reachBy: by, atRisk: risk,
            why: docTitle(b) + ' at stage ' + stage(b) + ': stage ' + KNOWN_STAGE + ' by ' + by + ' with clean drills' + (risk ? ', after this task is due' : '') + '.'};
        });
        out.push({task: t, weakBasics: w, detail: detail, atRisk: detail.some(function (x) { return x.atRisk; }),
          daysLeft: validDate(t.due) ? dayDiff(t.due, today()) : null});
      });
      return out.sort(function (a, b) { return (validDate(a.task.due) ? dayNum(a.task.due) : Infinity) - (validDate(b.task.due) ? dayNum(b.task.due) : Infinity); });
    }
    function basicInfo(id) {
      var b = B(id), od = dayDiff(today(), b.due);
      return {id: id, title: docTitle(id), area: areaOf(id), track: trackOf(id), stage: b.stage, push: pushLevel(id), due: b.due,
        overdue: od, isDue: od >= 0, deadline: deadline(id), weak: weak(id), known: b.stage >= KNOWN_STAGE, last: lastDrill(id),
        roseToday: roseToday(id), version: docVersion(id), rebuilt: rebuilt(id), needs: ((doc(id) || {}).needs || []).slice()};
    }
    function basics() { return basicIds().map(basicInfo); }

    /* demo helpers */
    function makeComfortable(area) {
      var ids = basicIds().filter(function (id) { return areaOf(id) === area; }), day = today();
      ids.forEach(function (id) {
        var b = B(id), from = b.stage;
        b.stage = Math.max(b.stage, 4);
        b.streak = Math.max(b.streak || 0, 2);
        b.last = 'clean';
        b.push = 3;
        var dl = deadline(id);
        b.due = addDays(day, intervalFor(b.stage, dl ? dl.daysLeft : null));
        b.hist.push({t: now(), day: day, grade: 'clean', from: from, to: b.stage, src: 'demo', push: 3});
      });
      commit('demo', {what: 'comfortable', area: area});
      return {area: area, basics: ids, push: inPush(area)};
    }
    function simulateRun(area, n, score, src) {
      var a = R(area), st = streakRec(area), r0 = a.r, out = [];
      for (var i = 0; i < n; i++) {
        var tg = target(area, {}), rb = a.r, E = expected(tg.d, rb);
        a.r = rb + K * (score - E);
        a.hist.push({t: now(), day: today(), r: a.r, src: src});
        if (score === 0) { st.miss += 1; st.clean = 0; } else { st.clean += 1; st.miss = 0; }
        out.push({d: tg.d, E: E, rBefore: rb, rAfter: a.r});
      }
      commit('demo', {what: src, area: area, n: n});
      return {area: area, rBefore: r0, rAfter: a.r, streak: copy(st), runs: out};
    }
    function simulateMisses(area, n) { return simulateRun(area, n == null ? MISS_RUN : Math.max(0, Math.round(n)), 0, 'demo-miss'); }
    function simulateHolds(area, n) { return simulateRun(area, n == null ? CLEAN_RUN : Math.max(0, Math.round(n)), 1, 'demo-hold'); }
    function reset() {
      try { store().del('engine'); } catch (e) {}
      state = seed();
      commit('reset', {});
    }

    return {
      // clock
      now: now, today: today, advanceDays: advanceDays,
      // basics and drills
      stage: stage, setStage: setStage, lastDrill: lastDrill, drillHistory: drillHistory, roseToday: roseToday, due: due,
      deadline: deadline, pushLevel: pushLevel, inPush: inPush,
      recordFog: recordFog, fogRecord: fogRecord, recordDrill: recordDrill, basics: basics, basicInfo: basicInfo, weak: weak,
      // ratings, picks, settling
      rating: rating, history: history, streaks: streaks, target: target, pickProblem: pickProblem, pickKata: pickKata,
      settleProblem: settleProblem, settleKata: settleKata, settled: settled, kataResult: kataResult, settledAll: settledAll,
      methodAccuracy: methodAccuracy, solveRate: solveRate, methodLabel: methodLabel,
      problem: problemById, kata: kataById, expected: expected,
      // marks, rebuilds, rewrites, changes
      triage: triage, recheck: recheck, requestRewrite: requestRewrite, budget: budget, marks: marks, mark: mark, clearMark: clearMark,
      rewriteOf: rewriteOf, rewritten: rewritten, passageBasics: passageBasics, linkedBasics: linkedBasics, practised: practised,
      logChange: function (docId, text, kind) { return logChange(docId, text, kind); },
      changes: changes, recognise: recognise, docVersion: docVersion, setDocVersion: setDocVersion,
      // panels
      todayPlan: todayPlan, blockers: blockers,
      // demo
      makeComfortable: makeComfortable, simulateMisses: simulateMisses, simulateHolds: simulateHolds, reset: reset,
      // constants
      AREAS: AREAS.slice(), AREA_NAMES: assign({}, AREA_NAMES), constants: CONSTANTS,
      _state: function () { return copy(state); }
    };
  }

  var CONSTANTS = {
    K: K, E_TARGET: E_TARGET, E_LO: E_LO, E_HI: E_HI, E_REACH: E_REACH, HIDDEN_STEP: HIDDEN_STEP, EASE_STEP: EASE_STEP,
    MISS_RUN: MISS_RUN, CLEAN_RUN: CLEAN_RUN, SLOTS: SLOTS, HIDDEN_EVERY: HIDDEN_EVERY, INTERVALS: INTERVALS.slice(),
    MAX_STAGE: MAX_STAGE, KNOWN_STAGE: KNOWN_STAGE, REWRITE_MAX: REWRITE_MAX, ELIGIBLE_MS: ELIGIBLE_MS, THEOREM_D: THEOREM_D,
    R_START: assign({}, R_START), DEFAULT_TESTS: copy(DEFAULT_TESTS)
  };

  SR.engine = createEngine({
    content: function () { return SR.content; },
    store: function () { return SR.store; },
    bus: function () { return SR.bus; }
  });

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      createEngine: createEngine, CONSTANTS: CONSTANTS, SEED: copy(SEED), AREAS: AREAS.slice(), AREA_NAMES: assign({}, AREA_NAMES),
      expected: expected, dForE: dForE, rateUpdate: rateUpdate, nextStage: nextStage, intervalFor: intervalFor,
      deadlineFactor: deadlineFactor, priority: priority, eligiblePush: eligiblePush, nextPush: nextPush,
      scoreFor: scoreFor, kataScore: kataScore, isHiddenSlot: isHiddenSlot, fogGrade: fogGrade, seedBasic: seedBasic,
      ymd: ymd, addDays: addDays, dayDiff: dayDiff, hash01: hash01
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

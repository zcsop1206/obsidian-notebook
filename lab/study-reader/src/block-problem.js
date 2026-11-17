/* block-problem.js: problem cards, problem sessions and the problem-first hook.
   - SR.problem.open(problem | id | Today entry, {hidden, reach, why}) opens one problem as a session in a
     side sheet (Today uses it). SR.problem.mount(el, problem, opts) puts the same session inline anywhere.
   - SR.blocks.register('problem'): a hook (data-hook="1") stays a collapsed card until every basic it rests
     on is at push level 3; then it opens inline at the top of its doc, before the text that names methods.
     A settled hook shows a one-line summary. A problem block without data-hook is always open in place.
   A session: the card (competition: label and archive link only; invented: the statement; hidden: no area,
   no topic, a "?" badge), an ink call band above a commit line (method + plan), confidence chips that stay
   off until the band has ink and commit the call, a timer, work paper, the settle verbs (two taps each)
   and, for invented problems and theorem hooks, a two-tap give up. Settling (or giving up) first asks which
   methods the call named, before any solution text opens; then which methods it took. Verdict and ticks go
   in one engine.settleProblem call, so an attempt closed half way is still open in Today. The result
   shows E, r before and after, method hit or miss, the recognition-gap note and links back to the basics
   it used. Competition solutions are a link to the archive's solutions PDF, after settling.
   A theorem hook (kind 'theorem', id 'thm:<fog id>#<n>', mounted by block-fog.js at push level 3) is the
   same session over a basic's theorem: its result is the basic's stage move instead of a rating change.
   Nothing before settling names a method, a basic or an approach.
   Written by a model for Adit. Not Adit's words. */
(function () {
  'use strict';
  var SR = window.SR = window.SR || {};
  if (!SR.blocks || !SR.ink || !SR.store || !SR.bus || !SR.sheet) {
    console.error('[SR] block-problem.js needs core.js loaded first');
    return;
  }
  var esc = SR.esc;
  var HAS = Object.prototype.hasOwnProperty;
  var W = 800, CALL_H = 230, WORK_H = 520, WORK_STEP = 400, WORK_MAX = 2800, ARM_MS = 3500;
  var KEY = 'problem-';               /* SR.store key per problem: 'problem-<id>' */
  var CONF = [50, 60, 70, 80, 90];
  var VERBS = [
    { v: 'held', label: 'held', sub: 'the call worked' },
    { v: 'help', label: 'held after help', sub: 'worked, after help' },
    { v: 'missed', label: 'missed', sub: 'chose wrong' },
    { v: 'blind', label: 'blind', sub: 'unknown unknown' },
    { v: 'moot', label: 'moot', sub: 'does not count' }
  ];
  var MODEL = SR.LABEL_MODEL || "Written by a model for Adit. Not Adit's words.";
  var DEMO = SR.LABEL_DEMO || 'Demo data';
  var GUESS = "Area and methods of competition problems are a model's guess.";
  var seq = 0;

  /* ---------- small helpers ---------- */
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (HAS.call(s, k)) t[k] = s[k];
    }
    return t;
  }
  function copy(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function uniq(a) { var o = []; (a || []).forEach(function (x) { if (x != null && o.indexOf(x) < 0) o.push(x); }); return o; }
  function f2(x) { x = +x; return isFinite(x) ? (Math.round(x * 100) / 100).toFixed(2) : '-'; }
  function fmtD(d) { var n = +d; return isFinite(n) ? String(Math.round(n * 100) / 100) : '?'; }
  function z2(n) { return (n < 10 ? '0' : '') + n; }
  function clock(ms) { var d = new Date(ms || Date.now()); return z2(d.getHours()) + ':' + z2(d.getMinutes()); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function hasE(fn) { var e = SR.engine; return !!(e && typeof e[fn] === 'function'); }
  function ecall(fn) {
    var e = SR.engine;
    if (!e || typeof e[fn] !== 'function') return undefined;
    try { return e[fn].apply(e, [].slice.call(arguments, 1)); }
    catch (err) { console.error('[SR] engine.' + fn + ' failed:', err); return undefined; }
  }
  function content() { return SR.content || {}; }
  function docOf(id) { var d = content().docs || {}; return id && HAS.call(d, id) ? d[id] : null; }
  function titleOf(id) { var d = docOf(id); return (d && d.title) || String(id || ''); }
  function isBasic(id) { var d = docOf(id); return !!d && d.kind === 'basic'; }
  function areaName(a) {
    var ca = content().areas && content().areas[a];
    if (ca && ca.label) return String(ca.label);
    var e = SR.engine, n = e && e.AREA_NAMES && e.AREA_NAMES[a];
    return n ? cap(n) : String(a || '');
  }
  function problems() { var p = content().problems; return Array.isArray(p) ? p : []; }
  /* A problem object from a problem, its id, or a Today plan entry ({problem, hidden, ...}). */
  function findProblem(x) {
    if (!x) return null;
    if (typeof x === 'object' && x.problem && typeof x.problem === 'object') x = x.problem;
    var id = typeof x === 'string' ? x : x.id;
    if (!id) return null;
    var p = hasE('problem') ? ecall('problem', id) : null;
    if (p) return p;
    var L = problems();
    for (var i = 0; i < L.length; i++) if (L[i] && L[i].id === id) return L[i];
    return typeof x === 'object' && x.d != null ? x : null;
  }
  function methodLists() {
    var m = content().methods || {};
    return { math: Array.isArray(m.math) ? m.math : [], design: Array.isArray(m.design) ? m.design : [] };
  }
  function methodEntry(id) {
    var m = methodLists(), all = m.math.concat(m.design);
    for (var i = 0; i < all.length; i++) if (all[i] && all[i].id === id) return all[i];
    return null;
  }
  function mLabel(id) {
    var e = methodEntry(id);
    if (e && e.label) return e.label;
    var l = hasE('methodLabel') ? ecall('methodLabel', id) : null;
    return l || String(id);
  }
  function labels(ids) { return esc((ids || []).map(mLabel).join(', ')); }
  /* The fixed list to tick from: the math methods, plus any method the problem lists that is not in it. */
  function methodChoices(p) {
    var list = methodLists().math.slice(), have = list.map(function (m) { return m.id; });
    (p.methods || []).forEach(function (id) {
      if (have.indexOf(id) < 0) { list.push(methodEntry(id) || { id: id, label: id }); have.push(id); }
    });
    return list;
  }
  function stagePill(b) {
    if (!isBasic(b) || !hasE('stage')) return '';
    var st = Math.max(0, Math.min(5, +ecall('stage', b) || 0)), pl = hasE('pushLevel') ? +ecall('pushLevel', b) || 0 : 0;
    return ' <span class="sr-stage s' + st + '">stage ' + st + (pl ? ' &middot; push ' + pl : '') + '</span>';
  }
  function archiveLink(p) {
    if (p.link) return String(p.link);
    var m = /^Putnam (\d{4})\b/.exec(p.label || '');
    return m ? 'https://kskedlaya.org/putnam-archive/' + m[1] + '.pdf' : null;
  }
  function solutionsLink(p) {
    var l = archiveLink(p), m = l && /^(https:\/\/kskedlaya\.org\/putnam-archive\/)(\d{4})\.pdf$/.exec(l);
    return m ? m[1] + m[2] + 's.pdf' : null;
  }
  function yearOf(p) { var m = /(\d{4})/.exec((p.label || '') + ' ' + (p.link || '')); return m ? m[1] : ''; }
  /* Model-written HTML goes in without anchors or blocks, so the reader never measures or mounts inside it. */
  function cleanHtml(html) {
    var t = document.createElement('template');
    t.innerHTML = String(html || '');
    [].forEach.call(t.content.querySelectorAll('script, .blk'), function (x) { x.remove(); });
    [].forEach.call(t.content.querySelectorAll('[data-a]'), function (x) { x.removeAttribute('data-a'); });
    var d = document.createElement('div');
    d.appendChild(t.content);
    return d.innerHTML;
  }
  /* The doc's Recognise heading ('nt-moves#recognise'), else the doc itself. */
  function recogniseRef(docId) {
    var d = docOf(docId);
    if (!d || !d.versions) return docId;
    var v = hasE('docVersion') ? ecall('docVersion', docId) : 1;
    var html = String(d.versions[v] || d.versions[1] || '');
    var m = /<h2[^>]*data-a="([^"]+)"[^>]*>\s*Recogni[sz]e\s*<\/h2>/i.exec(html);
    return m ? docId + '#' + m[1] : docId;
  }
  function planEntry(id) {
    if (!hasE('todayPlan')) return null;
    var plan = ecall('todayPlan'), L = (plan && plan.problems) || [];
    for (var i = 0; i < L.length; i++) if (L[i] && L[i].id === id) return L[i];
    return null;
  }
  function showNext(el) {
    if (!el || !el.scrollIntoView) return;
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(false); }
  }

  /* ---------- ratings: engine.js keeps them (NaN without it) ---------- */
  function rating(area) { var r = +ecall('rating', area); return isFinite(r) ? r : NaN; }
  function expectedFor(p) {
    var r = rating(p.area), d = +p.d, e = isFinite(d) && isFinite(r) ? +ecall('expected', d, r) : NaN;
    return isFinite(e) ? e : null;
  }

  /* ---------- per-problem state, shared by every view of the problem ----------
     phase: 'call' (writing the call) -> 'attempt' (committed) -> 'settled' (verdict given). recorded: the
     engine has it (verdict and ticks go in together at Save; moot goes in at once). */
  function fresh(id) {
    return { v: 1, id: id, phase: 'call', call: [], work: [], workH: WORK_H, conf: null, committedAt: null,
      gaveUp: false, gaveUpAt: null, verdict: null, help: false, settledAt: null, ms: null,
      called: [], calledNone: false, calledDone: false, took: [], tookInit: false, tookDone: false,
      hidden: null, reach: null, recorded: false, res: null };
  }
  /* The engine has a record this state does not show (local state lost, or recorded from another view). */
  function adopt(s, rec) {
    s.phase = 'settled';
    s.recorded = true;
    s.verdict = rec.verdict === 'held' && rec.help && !s.gaveUp ? 'help' : rec.verdict;
    s.help = !!rec.help;
    s.res = copy(rec);
    s.settledAt = s.settledAt || rec.t || Date.now();
    if (s.ms == null && rec.ms != null) s.ms = rec.ms;
    if (s.conf == null && rec.confidence != null) s.conf = rec.confidence;
    if (typeof rec.hidden === 'boolean') s.hidden = rec.hidden;
    if (typeof rec.reach === 'boolean') s.reach = rec.reach;
    if (!rec.methodsPending || rec.score === null) {
      s.calledDone = s.tookDone = true;
      s.called = (rec.called || []).slice();
      s.took = (rec.took || []).slice();
      s.calledNone = !s.called.length;
    } else s.tookDone = false;
  }
  function readState(id) {
    var s = SR.store.get(KEY + id, null);
    if (!s || typeof s !== 'object' || s.v !== 1 || s.id !== id || !Array.isArray(s.call) || !Array.isArray(s.work)) s = fresh(id);
    if (!Array.isArray(s.called)) s.called = [];
    if (!Array.isArray(s.took)) s.took = [];
    var rec = hasE('settled') ? ecall('settled', id) : null;
    if (rec && (s.phase !== 'settled' || !s.recorded)) adopt(s, rec);
    else if (!rec && s.recorded && SR.engine) s = fresh(id); /* the engine was reset */
    return s;
  }
  function writeState(s, src) {
    SR.store.set(KEY + s.id, s);
    SR.bus.emit('problem:state', { id: s.id, src: src || 0, phase: s.phase });
  }
  /* 'new' (nothing written), 'call' (call ink, not committed), 'attempt', 'settled' (verdict given, not all
     recorded yet), 'done'. */
  function statusOf(id) {
    var s = readState(id);
    if (s.phase === 'settled') return s.recorded && (s.tookDone || s.verdict === 'moot') ? 'done' : 'settled';
    if (s.phase === 'attempt') return 'attempt';
    return s.call.length ? 'call' : 'new';
  }
  function verdictText(s) {
    var v = s.verdict;
    if (v === 'help') return 'held after help';
    if (v === 'held' && s.gaveUp) return 'held after giving up';
    if (s.gaveUp && (v === 'missed' || v === 'blind')) return v + ' (gave up)';
    return v || '';
  }

  /* ---------- ink backgrounds (paper units) ---------- */
  function commitLine(ctx, w, h) {
    var y = h - 40, c = SR.css('--muted') || '#6b675f';
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.moveTo(24, y); ctx.lineTo(w - 24, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c;
    ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText('commit line', 24, y + 22);
  }
  function ruled(ctx, w, h) {
    ctx.strokeStyle = SR.css('--line') || '#d9d4ca';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var y = 44; y < h; y += 44) { ctx.moveTo(14, y); ctx.lineTo(w - 14, y); }
    ctx.stroke();
  }

  /* ---------- styles ---------- */
  SR.style('problem', [
    '.pb{font:14px/1.45 var(--ui);color:var(--text)}',
    '.pb .sr-card{margin:10px 0}',
    '.pb .pb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.pb .pb-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}',
    '.pb .pb-badges{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.pb .pb-q{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--after);color:var(--after);font:700 14px/1 var(--ui)}',
    '.pb .pb-reach{color:var(--warn)}',
    '.pb .pb-stmt{font:18px/1.55 var(--serif);margin:10px 0 6px}',
    '.pb .pb-stmt p{margin:.45em 0}',
    '.pb .pb-comp{font:600 21px/1.35 var(--serif);margin:10px 0 6px}',
    '.pb .pb-ext{color:var(--accent);text-decoration:none;border-bottom:1px solid currentColor}',
    '.pb .pb-meta{margin-top:8px}',
    '.pb .pb-meta div{margin-top:3px}',
    '.pb .sr-demo{margin-left:4px}',
    '.pb .sr-by{margin:6px 0 0}',
    '.pb .pb-callhint{margin:4px 0 8px}',
    '.pb .pb-callrow{margin-top:8px}',
    '.pb .pb-chips{display:inline-flex;flex-wrap:wrap;gap:6px}',
    '.pb .pb-chips button{min-width:58px}',
    '.pb .pb-frozen .pb-band::after{content:"";position:absolute;inset:0;background:var(--accent);opacity:.06;pointer-events:none}',
    '.pb .pb-lock{margin:10px 0}',
    '.pb .pb-lockmsg{margin:6px 0 2px;text-align:center;font-weight:600}',
    '.pb .pb-timer{font-variant-numeric:tabular-nums;font-weight:600;color:var(--muted)}',
    '.pb .pb-timer.on{color:var(--accent)}',
    '.pb .pb-after{color:var(--after);font-weight:600}',
    '.pb .pb-verbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px;margin-top:8px}',
    '.pb .pb-verbs button{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 6px;min-height:52px}',
    '.pb .pb-verbs small{font-size:11px;color:var(--muted);line-height:1.25;text-align:center}',
    '.pb .pb-verbs button.sel small{color:var(--paper)}',
    '.pb .pb-verbs button.armed small{color:var(--bad)}',
    '.pb .pb-giveup{margin-top:10px}',
    '.pb .pb-result{font-variant-numeric:tabular-nums;margin:6px 0}',
    '.pb .pb-up{color:var(--good)}.pb .pb-down{color:var(--bad)}',
    '.pb .pb-step{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}',
    '.pb .pb-steph{font-weight:650;margin-bottom:2px}',
    '.pb .pb-toggles{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}',
    '.pb .pb-toggles button{font-size:13px;padding:5px 10px;min-height:32px}',
    '.pb .pb-toggles button.on{font-weight:600;background:var(--tint)}',
    '.pb .pb-sum{margin-top:10px}',
    '.pb .pb-guess{margin:6px 0}',
    '.pb .pb-final{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}',
    '.pb .pb-final p{margin:6px 0}',
    '.pb .pb-hit{color:var(--good)}.pb .pb-miss{color:var(--bad)}',
    '.pb .pb-gap{margin:10px 0;padding:8px 12px;border-left:3px solid var(--after);background:var(--tint);border-radius:0 8px 8px 0}',
    '.pb .pb-links{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;margin:6px 0}',
    '.pb .pb-back{margin-top:12px}',
    '.pb .pb-solbody{border-left:3px solid var(--good);padding-left:12px;font:17px/1.55 var(--serif)}',
    '.pb .pb-solbody p{margin:.45em 0}',
    '.pb .pb-hookbar{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px 12px;border:1px solid var(--accent);border-radius:10px;background:var(--tint)}',
    '.pb .pb-hookbar .sr-kick{color:var(--accent)}',
    '.pb.pb-mini{background:var(--paper);border:1px dashed var(--line);border-radius:10px;padding:10px 12px}',
    '.pb.pb-mini .pb-minitext{margin:6px 0 0}',
    '.pb-ph{margin:8px 0;font:13px/1.4 var(--ui)}',
    '.page .blk.pb-wide{margin-right:-120px}',
    '.pb-sheet{max-width:920px;margin:0 auto}'
  ].join('\n'));

  /* ---------- a session: one problem, from the call to the result ---------- */
  function makeSession(host, p, o) {
    o = o || {};
    var token = ++seq, inline = o.mode === 'inline', comp = p.kind === 'competition', thm = p.kind === 'theorem';
    var S = readState(p.id), dead = false, timer = 0, armed = null, armTimer = 0, offs = [], bodyDone = false;
    var root = document.createElement('div');
    root.className = 'pb ' + (inline ? 'pb-inline no-ink' : 'pb-sheet') + (thm ? ' pb-thm' : '');
    root.setAttribute('data-problem', p.id);
    root.innerHTML = skeleton();
    host.appendChild(root);
    function q(sel) { return root.querySelector(sel); }
    /* Hidden is fixed when the call is committed; before that it follows how the problem was opened. */
    function hidden() { return S.phase !== 'call' && typeof S.hidden === 'boolean' ? S.hidden : o.hidden === true; }
    function reach() { return S.phase !== 'call' && typeof S.reach === 'boolean' ? S.reach : o.reach === true; }
    function settled() { return S.phase === 'settled'; }
    function moot() { return S.verdict === 'moot'; }
    function afterInk() { return S.gaveUp || settled(); }
    /* The first tick step (what the call named) comes before any solution text: after a verdict, or right
       after giving up. Only then does the solution open, so those ticks are made without it in view. */
    function ticksOpen() { return (settled() || S.gaveUp) && !moot(); }
    function solutionOpen() { return (S.gaveUp || settled()) && (S.calledDone || moot()); }
    /* The verdict can be changed (two taps) until the call ticks are confirmed and the solution opens. */
    function verbsOpen() { return S.phase === 'attempt' || (settled() && !S.calledDone && !S.recorded && !moot()); }
    function save() { if (!dead) writeState(S, token); }

    function skeleton() {
      var chips = CONF.map(function (c) { return '<button type="button" data-conf="' + c + '">' + c + '%</button>'; }).join('');
      var verbs = VERBS.map(function (x) {
        return '<button type="button" data-verb="' + x.v + '"><span>' + esc(x.label) + '</span><small>' + esc(x.sub) + '</small></button>';
      }).join('');
      return (inline ? '<div class="pb-hookbar"><span class="sr-kick">' + (thm ? (p.worked ? 'Work it' : 'Prove it') + ', problem first' : o.hook ? 'Problem first' : 'Problem') + '</span>' +
          (thm ? '<span class="sr-hint">Push level 3: call the method and your plan before you write ' + (p.worked ? 'the working' : 'the proof') + '.</span>'
            : o.hook ? '<span class="sr-hint">Call it before you read on: the page below names methods.</span>' : '') +
          '<span class="sp"></span><button type="button" data-pb="panel">Open in a panel</button></div>' : '') +
        '<div class="sr-card pb-card"><div class="pb-head"><span class="sr-kick pb-kick"></span><span class="pb-badges"></span></div>' +
          '<div class="pb-body"></div><div class="pb-meta sr-hint"></div></div>' +
        '<div class="sr-card pb-callsec"><div class="pb-row"><span class="sr-kick">Call</span><span class="sp"></span><span class="sr-hint pb-stamp"></span></div>' +
          '<p class="sr-hint pb-callhint">In ink, above the commit line: the method you will use and your plan. Then tap a confidence to commit. Nothing below opens before that.</p>' +
          '<div class="pb-callink"></div>' +
          '<div class="pb-row pb-callrow"><button type="button" data-pb="cundo">Undo</button>' +
          '<span class="pb-chips" role="group" aria-label="Confidence">' + chips + '</span></div></div>' +
        '<div class="sr-fog pb-lock"><div class="bars"><span style="width:82%"></span><span style="width:61%"></span><span style="width:90%"></span><span style="width:47%"></span></div>' +
          '<p class="pb-lockmsg">Locked until you commit a call: the work paper, settling, the solution.</p></div>' +
        '<div class="pb-below" hidden>' +
          '<div class="sr-card pb-worksec"><div class="pb-row"><span class="sr-kick">Work</span><span class="sp"></span><span class="pb-timer">0:00</span></div>' +
            '<p class="sr-hint">Ink written after you settle or give up shows in <span class="pb-after">this colour</span>.</p>' +
            '<div class="pb-workink"></div>' +
            '<div class="pb-row" style="margin-top:8px"><button type="button" data-pb="wundo">Undo</button><button type="button" data-pb="more">More paper</button>' +
            '<span class="sp"></span><span class="sr-hint pb-wcount"></span></div></div>' +
          '<div class="sr-card pb-settlesec"><div class="sr-kick">Settle the call</div><p class="sr-hint pb-settlehint"></p>' +
            '<div class="pb-verbs">' + verbs + '</div>' +
            (comp ? '' : '<div class="pb-row pb-giveup"><button type="button" data-pb="giveup">Give up and open the solution</button></div>') + '</div>' +
          '<div class="sr-card pb-aftersec" hidden><div class="pb-row"><span class="sr-kick">Settled</span><span class="sp"></span><span class="sr-demo">' + esc(DEMO) + '</span></div>' +
            '<div class="pb-result"></div><div class="pb-reveal sr-hint" hidden></div>' +
            '<div class="pb-step pb-stepA" hidden><div class="pb-steph">1 &middot; Which methods did your call name?</div>' +
              '<p class="sr-hint">Read your call above and tick what it named. The solution opens after this, so these ticks are yours alone.</p>' +
              '<div class="pb-toggles" data-list="called"></div>' +
              '<div class="pb-row"><button type="button" class="primary" data-pb="calldone">These are what my call named</button></div></div>' +
            '<div class="pb-sum pb-sumA sr-hint" hidden></div>' +
            '<div class="pb-step pb-stepB" hidden><div class="pb-steph">2 &middot; Which methods did it actually take?</div>' +
              '<p class="sr-hint pb-stepBhint"></p><div class="pb-guess sr-hint" hidden></div>' +
              '<div class="pb-toggles" data-list="took"></div>' +
              '<div class="pb-row"><button type="button" class="primary" data-pb="tookdone">Save and settle</button><span class="sr-hint pb-tookn"></span></div></div>' +
            '<div class="pb-final" hidden></div></div>' +
          '<div class="sr-card pb-solsec"><div class="sr-kick">' + (comp ? 'Solutions' : 'Solution') + '</div><div class="pb-sol"></div></div>' +
        '</div>';
    }

    var callInk = SR.ink.create(q('.pb-callink'), {
      width: W, height: CALL_H, className: 'pb-band',
      strokes: function () { return S.call; },
      readOnly: function () { return dead || S.phase !== 'call'; },
      background: commitLine,
      onChange: function () { save(); renderCall(); }
    });
    var workInk = SR.ink.create(q('.pb-workink'), {
      width: W, height: function () { return S.workH || WORK_H; },
      strokes: function () { return S.work; },
      readOnly: function () { return dead || S.phase === 'call'; },
      background: ruled,
      color: function (st) { return st && st.e ? '--after' : '--ink'; },
      meta: function () { return afterInk() ? { e: 1 } : null; },
      onChange: function () { save(); renderWorkCount(); }
    });
    var giveTap = q('[data-pb="giveup"]') ? SR.twoTap(q('[data-pb="giveup"]'), 'Tap again to give up and open it', giveUp) : null;

    /* ----- rendering ----- */
    function render() {
      if (dead) return;
      renderCard(); renderCall(); renderLock(); renderWork(); renderSettle(); renderAfter(); renderSol(); syncTimer();
      callInk.setReadOnly(null);
      workInk.setReadOnly(null);
      relayout();
    }
    function relayout() { if (inline && typeof o.relayout === 'function') o.relayout(); }
    function renderCard() {
      q('.pb-kick').textContent = thm ? (p.worked ? 'Work it · ' : 'Prove it · ') + (p.title || p.label || p.id) : 'Problem · ' + (p.label || p.id) + ' · d ' + fmtD(p.d);
      var b = '';
      if (thm) b += '<span class="sr-badge">' + esc(titleOf(p.basic)) + '</span>';
      else if (hidden()) b += '<span class="pb-q" title="Topic hidden" aria-label="Topic hidden">?</span><span class="sr-hint">topic hidden</span>';
      else if (p.area) b += '<span class="sr-badge">' + esc(areaName(p.area)) + '</span>';
      if (reach()) b += '<span class="sr-badge pb-reach">reach</span>';
      q('.pb-badges').innerHTML = b;
      if (!bodyDone) {
        bodyDone = true;
        var body = q('.pb-body'), al = archiveLink(p);
        if (comp) {
          body.innerHTML = '<div class="pb-comp">' + esc(p.label || p.id) + '</div>' +
            (al ? '<p><a class="pb-ext" href="' + esc(al) + '" target="_blank" rel="noopener">Open the problem in the Putnam archive' + (yearOf(p) ? ' (' + yearOf(p) + ', PDF)' : '') + ' &#8599;</a></p>' : '') +
            '<p class="sr-hint">Competition problems appear here by source and number only. Work it from the archive page.</p>';
        } else if (thm && inline) {
          /* inside its fog block the theorem is printed just above; the panel view repeats it */
          body.innerHTML = '<p class="sr-hint">The ' + (p.worked ? 'question' : 'statement') + ' is the one just above this card.</p>';
        } else {
          body.innerHTML = '<div class="pb-stmt">' + cleanHtml(p.statement || '<p>(No statement in this build.)</p>') + '</div><p class="sr-by">' + esc(MODEL) + '</p>';
          SR.typeset(body).then(relayout);
        }
      }
      renderMeta();
    }
    function renderMeta() {
      var h = '', r0 = S.res;
      if (thm) {
        var st = hasE('stage') ? +ecall('stage', p.basic) : NaN;
        q('.pb-meta').innerHTML = (p.worked ? 'The question above' : 'The theorem above') + ', posed as a problem. Settling grades ' + esc(titleOf(p.basic)) +
          (isFinite(st) ? ' (stage ' + st + ' now)' : '') + ' like a drill: held clean, held after help shaky, missed or blind failed. ' +
          'Your rating does not move. <span class="sr-demo">' + esc(DEMO) + '</span>';
        return;
      }
      if (S.recorded && r0 && isFinite(+r0.E)) h += 'Settled at E ' + f2(r0.E) + ' &middot; d ' + fmtD(p.d);
      else {
        var E = expectedFor(p);
        if (E != null) h += hidden() ? 'E ' + f2(E) + ' (expected score)' : 'E ' + f2(E) + ' &middot; your r ' + f2(rating(p.area)) + ' in ' + esc(areaName(p.area));
      }
      h += ' <span class="sr-demo">' + esc(DEMO) + '</span>';
      if (o.why) h += '<div>' + esc(o.why) + '</div>';
      if (comp && !hidden()) h += '<div>' + esc(GUESS) + '</div>';
      q('.pb-meta').innerHTML = h;
    }
    function renderCall() {
      var frozen = S.phase !== 'call', n = S.call.length;
      q('.pb-callsec').classList.toggle('pb-frozen', frozen);
      var u = q('[data-pb="cundo"]');
      u.hidden = frozen;
      u.disabled = !n;
      [].forEach.call(root.querySelectorAll('[data-conf]'), function (b) {
        var c = +b.getAttribute('data-conf');
        b.disabled = frozen || !n;
        b.classList.toggle('sel', S.conf === c);
        b.hidden = frozen && S.conf !== c;
      });
      q('.pb-callhint').hidden = frozen;
      q('.pb-stamp').textContent = frozen ? 'Committed ' + clock(S.committedAt) + ' · ' + S.conf + '% · read-only'
        : n ? 'Tap a confidence to commit.' : 'Confidence unlocks once the call has ink.';
    }
    function renderLock() {
      var locked = S.phase === 'call';
      q('.pb-lock').hidden = !locked;
      q('.pb-below').hidden = locked;
    }
    function renderWork() {
      q('[data-pb="more"]').disabled = (S.workH || WORK_H) >= WORK_MAX;
      renderWorkCount();
      renderTimer();
    }
    function renderWorkCount() {
      var n = S.work.length;
      q('.pb-wcount').textContent = n ? plural(n, 'stroke') : '';
      q('[data-pb="wundo"]').disabled = !n;
    }
    function renderTimer() {
      var t = q('.pb-timer'), on = S.phase === 'attempt';
      t.classList.toggle('on', on);
      t.textContent = S.phase === 'call' ? 'not started' : on ? SR.fmt.dur(Date.now() - (S.committedAt || Date.now())) : SR.fmt.dur(S.ms || 0) + ' · settled';
    }
    function syncTimer() {
      if (S.phase === 'attempt' && !timer) timer = setInterval(function () { if (!dead) renderTimer(); }, 1000);
      else if (S.phase !== 'attempt' && timer) { clearInterval(timer); timer = 0; }
    }
    function renderSettle() {
      var open = verbsOpen();
      [].forEach.call(root.querySelectorAll('[data-verb]'), function (b) {
        var v = b.getAttribute('data-verb'), x = null;
        for (var i = 0; i < VERBS.length; i++) if (VERBS[i].v === v) x = VERBS[i];
        var isArmed = open && armed === v;
        b.classList.toggle('sel', S.verdict === v);
        b.classList.toggle('armed', isArmed);
        b.disabled = !open || S.verdict === v;
        b.hidden = v === 'help' && S.gaveUp && S.verdict !== 'help';
        b.querySelector('small').textContent = isArmed ? (settled() ? 'tap again to change' : 'tap again to settle')
          : (v === 'held' && S.gaveUp ? 'the call worked (after help)' : x.sub);
      });
      var g = q('[data-pb="giveup"]');
      if (g) g.hidden = S.gaveUp || settled();
      q('.pb-settlehint').textContent = !settled()
        ? (S.gaveUp ? (S.calledDone ? 'You gave up and the solution is open below. Now settle the call: did the method you named work? Two taps.'
            : 'You gave up. First tick what your call named, below; the solution opens after that. Then settle the call here (two taps).')
          : 'When you are done, settle the call: did the method you named work? Each verb takes two taps.')
        : open ? 'Verdict: ' + verdictText(S) + '. Two taps on another verb change it, until you confirm the ticks below.'
        : 'Settled ' + verdictText(S) + (S.ms != null ? ' at ' + SR.fmt.dur(S.ms) : '') + '.';
    }
    function renderToggles(list) {
      var box = q('.pb-toggles[data-list="' + list + '"]'), sel = list === 'called' ? S.called : S.took;
      var h = methodChoices(p).map(function (m) {
        var on = sel.indexOf(m.id) >= 0;
        return '<button type="button" data-m="' + esc(m.id) + '" data-list="' + list + '" aria-pressed="' + on + '"' + (on ? ' class="on"' : '') + '>' + esc(m.label) + '</button>';
      }).join('');
      if (list === 'called') h += '<button type="button" data-pb="cnone" aria-pressed="' + !!S.calledNone + '"' + (S.calledNone ? ' class="on"' : '') + '>none of these</button>';
      box.innerHTML = h;
    }
    function renderAfter() {
      var sec = q('.pb-aftersec');
      sec.hidden = !settled() && !S.gaveUp;
      if (sec.hidden) return;
      var r = S.res || {}, m = moot();
      q('.pb-result').innerHTML = !settled() ? '<b>Gave up</b> <span class="sr-hint">&middot; settle the call above once the solution is open</span>'
        : S.recorded ? resultHtml(r, m)
        : '<b>' + esc(verdictText(S)) + '</b>' + (S.ms != null ? ' &middot; ' + SR.fmt.dur(S.ms) : '') + (S.conf != null ? ' &middot; called at ' + S.conf + '%' : '') +
          ' <span class="sr-hint">&middot; ' + (thm ? 'the basic\'s stage updates' : 'the rating updates') + ' when you save the ticks below</span>';
      var rv = q('.pb-reveal'), show = settled() && hidden() && (S.calledDone || m);
      rv.hidden = !show;
      if (show) rv.innerHTML = 'Topic, hidden while you worked: <b>' + esc(areaName(p.area)) + '</b>.';
      var A = q('.pb-stepA'), B = q('.pb-stepB'), sumA = q('.pb-sumA'), fin = q('.pb-final');
      A.hidden = !ticksOpen() || S.calledDone;
      sumA.hidden = m || !S.calledDone;
      B.hidden = m || !settled() || !S.calledDone || S.tookDone;
      fin.hidden = !(S.recorded && (m || S.tookDone));
      if (!A.hidden) {
        renderToggles('called');
        q('[data-pb="calldone"]').disabled = !(S.called.length || S.calledNone);
      }
      if (!sumA.hidden) sumA.innerHTML = 'Your call named: ' + (S.calledNone || !S.called.length ? 'none of the listed methods' : labels(S.called)) + '.';
      if (!B.hidden) {
        renderToggles('took');
        q('.pb-stepBhint').textContent = comp
          ? 'Read the archive solution below (or your own route, if it worked), then tick the methods it took.'
          : thm && !(p.methods || []).length ? 'Read the model\'s ' + (p.worked ? 'working' : 'proof') + ' below (or your own route, if it worked), then tick the methods it took.'
          : 'Pre-ticked with the methods of the solution below. If your own route worked, tick the methods it used instead.';
        var gs = q('.pb-guess'), pm = p.methods || [];
        gs.hidden = !(comp && pm.length);
        if (comp && pm.length) gs.innerHTML = "A model's guess, which may be wrong: " + labels(pm) + ' <button type="button" data-pb="guess">Use the guess</button>';
        q('[data-pb="tookdone"]').disabled = !S.took.length;
        q('.pb-tookn').textContent = S.took.length ? '' : 'Tick at least one.';
      }
      if (!fin.hidden) fin.innerHTML = finalHtml(r, m);
    }
    function resultHtml(r, m) {
      var area = esc(areaName(r.area || p.area));
      if (thm) {
        var dr = r.drill, bt = esc(titleOf(p.basic));
        if (m || !dr) return '<b>Moot</b>: nothing counted; ' + bt + ' keeps its stage.';
        return '<b>' + esc(verdictText(S)) + '</b> &middot; graded ' + esc(r.grade || dr.grade) + ' &middot; ' + bt + ': stage ' + dr.stageBefore + ' &rarr; <b>' + dr.stageAfter + '</b>' +
          (dr.pushAfter !== dr.pushBefore ? ', push ' + dr.pushBefore + ' &rarr; ' + dr.pushAfter : '') + (dr.due ? ', next drill ' + esc(dr.due) : '') +
          (dr.sameDay ? ' (a stage rises once a day)' : '') + ' &middot; rating unchanged' +
          (S.ms != null ? ' &middot; ' + SR.fmt.dur(S.ms) : '') + (S.conf != null ? ' &middot; called at ' + S.conf + '%' : '');
      }
      if (m) return '<b>Moot</b>: nothing counted. E ' + f2(r.E) + ' &middot; r ' + f2(r.rBefore) + ' in ' + area + ', unchanged.';
      var d = (+r.rAfter) - (+r.rBefore), cls = d > 0.0005 ? 'pb-up' : d < -0.0005 ? 'pb-down' : '';
      return '<b>' + esc(verdictText(S)) + '</b> &middot; score ' + esc(String(r.score)) + ' &middot; E ' + f2(r.E) +
        ' &middot; r ' + f2(r.rBefore) + ' &rarr; <b class="' + cls + '">' + f2(r.rAfter) + '</b> (' + (d >= 0 ? '+' : '') + f2(d) + ') in ' + area +
        (S.ms != null ? ' &middot; ' + SR.fmt.dur(S.ms) : '') + (S.conf != null ? ' &middot; called at ' + S.conf + '%' : '');
    }
    function finalHtml(r, m) {
      var h = '';
      if (m) h += '<p class="sr-hint">Moot: no rating change and no method check.</p>';
      else {
        var took = r.took || [], called = r.called || [];
        if (r.methodHit === true) h += '<p><b class="pb-hit">Method: hit.</b> Your call named every method it took (' + labels(took) + ').</p>';
        else if (r.methodHit === false) {
          var miss = took.filter(function (x) { return called.indexOf(x) < 0; });
          h += '<p><b class="pb-miss">Method: missed.</b> It took ' + labels(miss) + ', which your call did not name.' +
            (called.length ? ' Your call named ' + labels(called) + '.' : '') + '</p>';
        } else h += '<p class="sr-hint">Method check not counted.</p>';
        if (r.extra && r.extra.length) h += '<p class="sr-hint">Also named, not needed: ' + labels(r.extra) + '.</p>';
        if (r.recognitionGap) h += gapHtml(r.recognitionGap);
        h += accuracyHtml();
      }
      return h + linksHtml(r);
    }
    function gapHtml(g) {
      var links = (g.methods || []).map(function (x) {
        var e = methodEntry(x.method), cue = e && e.cue && docOf(String(e.cue).split('#')[0]) ? e.cue : null;
        var to = cue || recogniseRef(x.doc || g.doc);
        return '<a class="ref" data-to="' + esc(to) + '">' + (cue ? 'The cue for ' : 'Recognise list: ') + esc(x.label || mLabel(x.method)) + '</a>';
      }).join('');
      return '<div class="pb-gap">' + esc(g.note || 'Recognition gap.') + (links ? '<div class="pb-links">' + links + '</div>' : '') + '</div>';
    }
    function accuracyHtml() {
      if (!hasE('methodAccuracy')) return '';
      var all = ecall('methodAccuracy') || {}, ar = ecall('methodAccuracy', p.area) || {}, hid = ecall('methodAccuracy', null, { hidden: true }) || {};
      var sr = hasE('solveRate') ? ecall('solveRate', p.area) || {} : {}, bits = [];
      if (all.total) bits.push('Calls that named every method: ' + all.hits + ' of ' + all.total);
      if (ar.total && ar.total !== all.total) bits.push(ar.hits + ' of ' + ar.total + ' in ' + areaName(p.area));
      if (hid.total) bits.push(hid.hits + ' of ' + hid.total + ' with the topic hidden');
      if (sr.total) bits.push('held, counted separately: ' + sr.held + ' of ' + sr.total + ' in ' + areaName(p.area));
      return bits.length ? '<p class="sr-hint">' + esc(bits.join(' · ')) + '.</p>' : '';
    }
    function linksHtml(r) {
      var ids = uniq((r.linksBack && r.linksBack.length ? r.linksBack : p.basics) || []).filter(function (b) { return !!docOf(b); });
      var bad = S.verdict === 'missed' || S.verdict === 'blind';
      var head = '<div class="sr-kick">' + (bad ? 'Back to the basics it used' : 'The basics it used') + '</div>';
      if (!ids.length) {
        var ar = content().areas && content().areas[p.area], topic = ar && ar.topic && docOf(ar.topic) ? ar.topic : null;
        return '<div class="pb-back">' + head + '<p class="sr-hint">No basic in this demo covers its methods' + ((r.took || []).length ? ' (' + labels(r.took) + ')' : '') + '.' +
          (topic ? ' Topic doc: <a class="ref" data-to="' + esc(topic) + '">' + esc(titleOf(topic)) + '</a>.' : '') + '</p></div>';
      }
      return '<div class="pb-back">' + head + '<div class="pb-links">' + ids.map(function (b) {
        return '<span><a class="ref" data-to="' + esc(b) + '">' + esc(titleOf(b)) + '</a>' + stagePill(b) + '</span>';
      }).join('') + '</div><p class="sr-hint">Tap to open one; hold to peek.</p></div>';
    }
    function renderSol() {
      var box = q('.pb-sol'), open = solutionOpen(), k = (open ? 'open' : 'shut') + ':' + S.phase + ':' + (S.tookDone ? 1 : 0) + ':' + (S.gaveUp ? 1 : 0);
      if (box.__k === k) return;
      box.__k = k;
      if (comp) {
        var sl = solutionsLink(p), al = archiveLink(p);
        box.innerHTML = open
          ? (sl || al ? '<p><a class="pb-ext" href="' + esc(sl || al) + '" target="_blank" rel="noopener">' +
              esc(sl ? 'Putnam ' + yearOf(p) + ' solutions in the archive (PDF)' : 'The archive page') + ' &#8599;</a></p>' : '') +
            '<p class="sr-hint">Written by the archive\'s authors, not reproduced here. Find ' + esc(p.label || p.id) + ' in it' + (S.tookDone ? '.' : ', then tick the methods it took.') + '</p>'
          : '<p class="sr-hint">' + (settled() ? 'The archive solutions link opens once you tick what your call named.' : 'The archive solutions link appears after you settle.') + '</p>';
        return;
      }
      box.innerHTML = open
        ? '<div class="pb-solbody">' + cleanHtml(p.solution || '<p>(No solution in this build.)</p>') + '</div><p class="sr-by">' + esc(MODEL) + '</p>'
        : '<p class="sr-hint">' + (settled() || S.gaveUp ? 'Opens once you tick what your call named.' : 'Locked until you settle, or give up.') + '</p>';
      if (open) SR.typeset(box).then(relayout);
    }

    /* ----- actions ----- */
    function commit(c) {
      if (S.phase !== 'call' || !S.call.length || CONF.indexOf(c) < 0) return;
      S.conf = c;
      S.committedAt = Date.now();
      S.phase = 'attempt';
      S.hidden = o.hidden === true;
      S.reach = o.reach === true;
      save();
      render();
    }
    function onVerb(v) {
      if (!verbsOpen() || S.verdict === v) return;
      if (armed === v) { disarm(true); settle(v); return; }
      clearTimeout(armTimer);
      armed = v;
      armTimer = setTimeout(function () { disarm(false); }, ARM_MS);
      renderSettle();
    }
    function disarm(silent) {
      clearTimeout(armTimer);
      armTimer = 0;
      if (armed) { armed = null; if (!silent && !dead) renderSettle(); }
    }
    function giveUp() {
      if (comp || S.phase !== 'attempt' || S.gaveUp) return;
      S.gaveUp = true;
      S.gaveUpAt = Date.now();
      save();
      render();
    }
    /* The verdict is kept here until the ticks are saved; moot has nothing to tick and is recorded at once. */
    function settle(v) {
      if (!verbsOpen()) return;
      var first = S.phase === 'attempt', now = Date.now();
      if (first) { S.ms = now - (S.committedAt || now); S.settledAt = now; }
      S.verdict = v;
      S.help = v === 'help' || S.gaveUp;
      S.phase = 'settled';
      if (v === 'moot') { S.calledDone = S.tookDone = true; S.called = []; S.took = []; record(); return; }
      save();
      render();
      if (first) showNext(q('.pb-aftersec'));
    }
    /* One engine call with the verdict and both tick lists (or the verdict alone for moot). */
    function record() {
      if (S.recorded) return true;
      var verdict = S.verdict === 'help' ? 'held' : S.verdict;
      var args = { verdict: verdict, help: !!S.help, gaveUp: !!S.gaveUp, confidence: S.conf, ms: S.ms, hidden: S.hidden === true, reach: S.reach === true };
      if (verdict !== 'moot') { args.called = S.calledNone ? [] : S.called.slice(); args.took = S.took.slice(); }
      var res = ecall('settleProblem', p.id, args);
      if (!res) { SR.toast('Could not settle ' + (p.label || p.id) + (SR.engine ? ': the engine did not record it.' : ': engine.js is not loaded in this build.')); save(); render(); return false; }
      /* recorded from another view meanwhile: the engine kept that verdict and took these ticks */
      if (res.already) { adopt(S, res); save(); render(); return true; }
      S.res = copy(res);
      S.recorded = true;
      S.tookDone = true;
      save();
      render();
      return true;
    }
    function toggleMethod(list, m) {
      if (!ticksOpen()) return;
      var a, i;
      if (list === 'called') {
        if (S.calledDone) return;
        a = S.called; i = a.indexOf(m);
        if (i >= 0) a.splice(i, 1); else a.push(m);
        S.calledNone = false;
      } else {
        if (!settled() || !S.calledDone || S.tookDone) return;
        a = S.took; i = a.indexOf(m);
        if (i >= 0) a.splice(i, 1); else a.push(m);
      }
      save();
      renderAfter();
    }
    function callDone() {
      if (!ticksOpen() || S.calledDone || !(S.called.length || S.calledNone)) return;
      S.calledDone = true;
      if (!S.tookInit) { S.tookInit = true; if (!comp) S.took = uniq(p.methods || []); }
      save();
      render();
      showNext(settled() ? q('.pb-stepB') : q('.pb-solsec'));
    }
    function finishMethods() {
      if (!settled() || !S.calledDone || S.tookDone || !S.took.length) return;
      if (record()) showNext(q('.pb-final'));
    }
    function onClick(e) {
      var t = e.target, b = t && t.closest ? t.closest('button') : null;
      if (!b || !root.contains(b) || b.disabled) return;
      if (b.hasAttribute('data-conf')) { commit(+b.getAttribute('data-conf')); return; }
      if (b.hasAttribute('data-verb')) { onVerb(b.getAttribute('data-verb')); return; }
      if (b.hasAttribute('data-m')) { toggleMethod(b.getAttribute('data-list'), b.getAttribute('data-m')); return; }
      switch (b.getAttribute('data-pb')) {
        case 'cundo': if (S.phase === 'call') callInk.undo(); break;
        case 'wundo': workInk.undo(); break;
        case 'more':
          S.workH = Math.min(WORK_MAX, (S.workH || WORK_H) + WORK_STEP);
          save(); workInk.layout(); renderWork(); relayout();
          break;
        case 'cnone':
          if (ticksOpen() && !S.calledDone) { S.calledNone = !S.calledNone; if (S.calledNone) S.called = []; save(); renderAfter(); }
          break;
        case 'calldone': callDone(); break;
        case 'guess': if (S.calledDone && !S.tookDone) { S.took = uniq(p.methods || []); save(); renderAfter(); } break;
        case 'tookdone': finishMethods(); break;
        case 'panel': SR.problem.open(p, { hidden: hidden(), reach: reach() }); break;
      }
    }
    root.addEventListener('click', onClick);

    /* Another view of the same problem changed it (the inline hook and a sheet can both be open). */
    offs.push(SR.bus.on('problem:state', function (d) {
      if (dead || !d || d.id !== p.id || d.src === token) return;
      S = readState(p.id);
      render();
      callInk.redraw();
      workInk.layout();
    }));
    offs.push(SR.bus.on('engine:change', function (d) {
      if (dead) return;
      if (d && d.type === 'reset') { S = readState(p.id); render(); callInk.redraw(); workInk.layout(); return; }
      if (!S.recorded) renderMeta();
    }));
    render();

    return {
      el: root, problem: p,
      state: function () { return copy(S); },
      render: render,
      destroy: function () {
        if (dead) return;
        dead = true;
        clearInterval(timer);
        clearTimeout(armTimer);
        offs.forEach(function (f) { try { f(); } catch (e) {} });
        root.removeEventListener('click', onClick);
        if (giveTap) giveTap.destroy();
        callInk.destroy();
        workInk.destroy();
      }
    };
  }

  /* ---------- the problem block inside docs ---------- */
  /* The basics a hook rests on: the problem's basics that this doc stands on (a basic doc stands on itself,
     a topic on its needs); failing that, the doc's own basics. */
  function hookBasics(p, ctx) {
    var d = (ctx && (ctx.doc || docOf(ctx.docId))) || null, own = [];
    if (d && d.kind === 'basic') own = [d.id || ctx.docId];
    else if (d) own = (d.needs || []).filter(isBasic);
    var pb = (p.basics || []).filter(function (b) { return own.indexOf(b) >= 0; });
    if (pb.length) return pb;
    return own.length ? own : (p.basics || []).filter(isBasic);
  }
  /* Keeps the passage at the top of the screen still while a hook moves above it. */
  function keepView(el, fn, ctx) {
    var host = el.closest ? el.closest('#sr-dochost') : null;
    var rel = function () { if (ctx && typeof ctx.relayout === 'function') ctx.relayout(); };
    if (!host || !(window.scrollY > 0)) { fn(); rel(); return; }
    var hdr = document.getElementById('sr-hdr'), top0 = hdr ? hdr.getBoundingClientRect().bottom : 0;
    var els = host.querySelectorAll('[data-a]'), ref = null, y0 = 0;
    for (var i = 0; i < els.length; i++) {
      if (els[i].closest('.blk')) continue;
      var r = els[i].getBoundingClientRect();
      if (r.height > 0 && r.top >= top0) { ref = els[i]; y0 = r.top; break; }
    }
    fn();
    var dy = ref ? ref.getBoundingClientRect().top - y0 : 0;
    rel();
    /* after the reader's relayout (same frame, registered first) has resized the page wrapper */
    if (Math.abs(dy) > 0.5) requestAnimationFrame(function () { window.scrollBy(0, dy); });
  }
  function summaryText(s) {
    var r = s.res || {};
    if (!s.recorded) return 'Verdict ' + verdictText(s) + ' · method ticks pending: open it to finish settling.';
    var bits = ['Settled ' + verdictText(s)];
    if (s.verdict !== 'moot') {
      bits.push(r.methodHit === true ? 'method hit' : r.methodHit === false ? 'method missed' : 'method not counted');
      if (isFinite(+r.rBefore) && isFinite(+r.rAfter)) bits.push('r ' + f2(r.rBefore) + ' → ' + f2(r.rAfter));
    }
    return bits.join(' · ') + '.';
  }
  function mountBlock(el, id, ctx) {
    var p = findProblem(id);
    if (!p) { el.innerHTML = '<div class="blk-ph">Problem ' + esc(id) + ' is not in this build.</div>'; return {}; }
    var ha = el.getAttribute('data-hook'), isHook = ha != null && ha !== '0' && ha !== 'false';
    var V = { mode: null, sess: null, ph: null, dead: false, pending: false }, bs = hookBasics(p, ctx || {});
    el.classList.add('pb-blk');
    /* Open when every basic under the hook is at push level 3; with no basics, when the area is in push mode. */
    function pushInfo() {
      if (!hasE('pushLevel')) return { ok: false, min: 0 };
      if (!bs.length) { var on = !!ecall('inPush', (ctx && ctx.area) || p.area); return { ok: on, min: on ? 3 : 0 }; }
      var lv = bs.map(function (b) { return +ecall('pushLevel', b) || 0; });
      return { ok: lv.every(function (x) { return x >= 3; }), min: Math.min.apply(null, lv) };
    }
    /* 'here' (a plain problem block), 'open' (hook at the top of the doc), 'collapsed', 'summary'. An open hook
       stays open (so the result stays on screen) until the doc is rendered again; it only folds back if the
       push level drops before anything was written. */
    function decide() {
      if (!isHook) return 'here';
      var st = statusOf(p.id), pi = pushInfo();
      if (V.mode === 'open') return st === 'new' && !pi.ok ? 'collapsed' : 'open';
      if (st === 'settled' || st === 'done') return 'summary';
      return pi.ok ? 'open' : 'collapsed';
    }
    function scrollToHook() {
      var hdr = document.getElementById('sr-hdr'), y = el.getBoundingClientRect().top + window.scrollY - (hdr ? hdr.offsetHeight : 0) - 12;
      window.scrollTo(0, Math.max(0, y));
    }
    function placeTop() {
      if (V.ph) return;
      var dn = el.closest('.sr-doc'), pg = dn && dn.querySelector('.page'), at = pg && (pg.querySelector('.meta') || pg.querySelector('h1'));
      if (!at || !el.parentNode) return;
      V.ph = document.createElement('div');
      V.ph.className = 'pb-ph no-ink';
      V.ph.innerHTML = '<button type="button">This problem is open at the top of the page &#8593;</button>';
      V.ph.firstChild.addEventListener('click', scrollToHook);
      el.parentNode.insertBefore(V.ph, el);
      var after = at;
      while (after.nextElementSibling && after.nextElementSibling.classList.contains('pb-top')) after = after.nextElementSibling;
      after.insertAdjacentElement('afterend', el);
      el.classList.add('pb-top');
    }
    function placeBack() {
      if (!V.ph) return;
      if (V.ph.parentNode) V.ph.parentNode.insertBefore(el, V.ph);
      V.ph.remove();
      V.ph = null;
      el.classList.remove('pb-top');
    }
    function renderMini(m) {
      var st = readState(p.id), h;
      if (m === 'summary') {
        h = '<div class="pb pb-mini no-ink"><div class="pb-row"><span class="sr-kick">Problem first · ' + esc(p.label || p.id) + '</span><span class="sp"></span>' +
          '<button type="button" data-pb="view">Open</button></div><p class="sr-hint pb-minitext">' + esc(summaryText(st)) + '</p></div>';
      } else {
        var pi = pushInfo(), prog = st.phase === 'attempt' ? ' Attempt under way since ' + clock(st.committedAt) + '.' : st.call.length ? ' A call is started, not committed.' : '';
        h = '<div class="pb pb-mini no-ink"><div class="pb-row"><span class="sr-kick">Problem first · ' + esc(p.label || p.id) + ' · d ' + fmtD(p.d) + '</span><span class="sp"></span>' +
          '<button type="button" data-pb="view">' + (st.phase === 'call' && !st.call.length ? 'Try it now' : 'Continue') + '</button></div>' +
          '<p class="sr-hint pb-minitext">It opens at the top of this page, before the text, once the basics under it reach push level 3 (lowest now: ' + pi.min + ' of 3).' + esc(prog) + '</p></div>';
      }
      el.innerHTML = h;
    }
    /* initial: the first render at mount. The reader is about to place the view itself (scroll to an
       anchor, restore a position), so no scroll compensation then. */
    function apply(force, initial) {
      if (V.dead) return;
      var m = decide();
      if (m === V.mode && !force) {
        if (m === 'collapsed' || m === 'summary') renderMini(m);
        return;
      }
      /* The doc is parked (another doc is on screen): opening or folding the hook now would shift the
         scroll position the reader restores on return, so wait until the doc is shown again. */
      if (!initial && (m === 'open' || V.mode === 'open') && !el.closest('#sr-dochost')) {
        V.pending = true;
        if (V.mode === 'collapsed' || V.mode === 'summary') renderMini(V.mode);
        return;
      }
      (initial ? function (e, fn) { fn(); } : keepView)(el, function () {
        if (V.sess) { V.sess.destroy(); V.sess = null; }
        el.innerHTML = '';
        el.classList.toggle('pb-wide', m === 'open' || m === 'here');
        if (m === 'open') placeTop(); else placeBack();
        V.mode = m;
        if (m === 'open' || m === 'here') {
          V.sess = makeSession(el, p, { mode: 'inline', hook: m === 'open', hidden: false, reach: false,
            relayout: ctx && typeof ctx.relayout === 'function' ? ctx.relayout : null });
        } else renderMini(m);
      }, ctx);
    }
    function onElClick(e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-pb="view"]') : null;
      if (!b || !el.contains(b) || (V.sess && V.sess.el.contains(b))) return;
      SR.problem.open(p, { hidden: false, reach: false });
    }
    el.addEventListener('click', onElClick);
    /* The doc is shown again after a change waited. Apply it once the reader's navigation code has run (a
       microtask: same task, after it): a followed link has scrolled to its anchor, and keepView holds that
       anchor still; a tab switch or Back restored a position from the old layout, so land on the hook. */
    function onShown(d) {
      if (!V.pending || V.dead || !d || !ctx || d.docId !== ctx.docId) return;
      V.pending = false;
      var followed = false, offF = SR.bus.on('reader:follow', function () { followed = true; });
      Promise.resolve().then(function () {
        offF();
        if (V.dead) return;
        if (followed) { apply(false); return; }
        apply(false, true);
        if (typeof ctx.relayout === 'function') ctx.relayout();
        requestAnimationFrame(function () { if (!V.dead && V.mode === 'open') scrollToHook(); });
      });
    }
    var offs = [
      SR.bus.on('engine:change', function () { apply(false); }),
      SR.bus.on('problem:state', function (d) { if (d && d.id === p.id && (V.mode === 'collapsed' || V.mode === 'summary')) apply(false); }),
      SR.bus.on('reader:doc', onShown)
    ];
    apply(true, true);
    if (ctx && typeof ctx.relayout === 'function') ctx.relayout();
    return {
      mode: function () { return V.mode; },
      session: function () { return V.sess; },
      destroy: function () {
        if (V.dead) return;
        V.dead = true;
        offs.forEach(function (f) { try { f(); } catch (er) {} });
        el.removeEventListener('click', onElClick);
        if (V.sess) { V.sess.destroy(); V.sess = null; }
        placeBack();
      }
    };
  }
  SR.blocks.register('problem', { mount: mountBlock });

  /* ---------- public API ---------- */
  var P = SR.problem = SR.problem || {};
  /* open(problem | id | Today entry, {hidden, reach, why}) -> {sheet, session, close}. When the caller does
     not say both hidden and reach, the missing flags (and the why line) come from today's plan entry for the
     problem, so a hidden slot stays hidden however it is opened. */
  P.open = function (x, opts) {
    var p = findProblem(x);
    if (!p) { SR.toast('That problem is not in this build.'); return null; }
    var o = assign({}, x && typeof x === 'object' && x.problem && typeof x.problem === 'object' ? { hidden: x.hidden, reach: x.reach, why: x.why } : {}, opts || {});
    if (typeof o.hidden !== 'boolean' || typeof o.reach !== 'boolean') {
      var pe = planEntry(p.id);
      if (pe) {
        if (typeof o.hidden !== 'boolean') o.hidden = !!pe.hidden;
        if (typeof o.reach !== 'boolean') o.reach = !!pe.reach;
        if (o.why == null && pe.why) o.why = pe.why;
      }
    }
    var sh = SR.sheet.open({ id: 'problem-' + p.id, title: 'Problem · ' + (p.label || p.id), wide: true });
    if (sh.__pb) { sh.__pb.destroy(); sh.__pb = null; }
    sh.body.innerHTML = '';
    var host = document.createElement('div');
    sh.body.appendChild(host);
    var sess = makeSession(host, p, assign({ mode: 'sheet' }, o));
    sh.__pb = sess;
    sh.onClose = function () { if (sh.__pb) { sh.__pb.destroy(); sh.__pb = null; } };
    sh.body.scrollTop = 0;
    return { sheet: sh, session: sess, close: sh.close };
  };
  /* mount(el, problem, {hidden, reach, why}) -> session api: the same session inline (e.g. inside a card). */
  P.mount = function (el, x, opts) {
    var p = findProblem(x);
    if (!p || !el) return null;
    return makeSession(el, p, assign({ mode: 'inline' }, opts || {}));
  };
  P.find = findProblem;
  P.state = function (id) { var p = findProblem(id); return p ? copy(readState(p.id)) : null; };
  /* 'new', 'call', 'attempt', 'settled' (verdict given, ticks not saved yet: still open in Today), 'done' */
  P.status = function (id) { var p = findProblem(id); return p ? statusOf(p.id) : null; };
  P.hookBasics = hookBasics;
})();

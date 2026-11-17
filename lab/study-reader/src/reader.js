/* reader.js: the linked-reader shell. Paper pages (fixed 800 px layout scaled to fit), library and
   search, tabs, links with a back stack, long-press peek, margin marks that call engine.triage and act
   on the result, the scaffold after a lost mark (linked basics + an attempt box), rewrites against the
   doc's budget, a per-doc Changes panel, ink anchored to text and re-anchored when a build changes,
   and the Demo drawer. engine.js owns every rule (builds, budget, Changes, rationing); without it the
   docs still render and read, and a mark is only noted. */
(function () {
  'use strict';
  var SR = window.SR = window.SR || {};
  var R = SR.reader = SR.reader || {};
  var esc = SR.esc;
  var W = 800, DAY = 864e5;
  var AREAS = [['nt', 'Number theory & algebra'], ['cp', 'Combinatorics & probability'], ['an', 'Analysis'],
    ['lg', 'Linear algebra & geometry'], ['dd', 'Digital design'], ['gr', 'General reasoning']];
  var TRACKS = { putnam: 'Putnam', asic: 'ASIC competition' };
  var LOST_STATES = ['struggling', 'eligible', 'exhausted', 'rebuilt', 'rewritten'];
  var HAS = Object.prototype.hasOwnProperty;

  var S = {
    cur: null, tabs: [], back: [], marks: {}, ink: {}, cache: {}, anchors: {}, orphanPos: {}, orphHtml: '',
    scale: 1, H: 1, menuKey: null, pendingNav: null, keepView: null, scroll: {}, idx: null, ovlHtml: '',
    theme: 'auto', demoArea: 'nt'
  };
  var D = {};
  var docInk = null, srcCache = {}, quiet = 0, relayoutRaf = 0;

  /* ---------- guarded access ---------- */
  function content() { return SR.content || null; }
  function docMap() { var c = content(); return (c && c.docs) || {}; }
  function doc(id) { var m = docMap(); return id && HAS.call(m, id) ? m[id] : null; }
  /* Doc order: content.library when it lists ids, then any other docs in content order. */
  function docIds() {
    var m = docMap(), c = content(), out = [];
    ((c && Array.isArray(c.library)) ? c.library : []).forEach(function (id) { if (HAS.call(m, id) && out.indexOf(id) < 0) out.push(id); });
    Object.keys(m).forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
    return out;
  }
  function title(id) { var d = doc(id); return d && d.title ? String(d.title) : String(id || ''); }
  function shortTitle(id) { var d = doc(id), t = (d && d.short) || title(id); return t.length > 26 ? t.slice(0, 25) + '\u2026' : t; }
  function has(fn) { var e = SR.engine; return !!(e && typeof e[fn] === 'function'); }
  function ecall(fn) {
    var e = SR.engine;
    if (!e || typeof e[fn] !== 'function') return undefined;
    try { return e[fn].apply(e, [].slice.call(arguments, 1)); }
    catch (err) { console.error('[SR] engine.' + fn + ' failed:', err); return undefined; }
  }
  function quietly(fn) { quiet++; try { return fn(); } finally { quiet--; } }
  function areaName(a) {
    var c = content(), ca = c && c.areas && c.areas[a];
    if (ca && ca.label) return String(ca.label);
    for (var i = 0; i < AREAS.length; i++) if (AREAS[i][0] === a) return AREAS[i][1];
    return a || '';
  }
  function parseTo(to) {
    to = String(to || '');
    var i = to.indexOf('#');
    return i < 0 ? { doc: to, a: '' } : { doc: to.slice(0, i), a: to.slice(i + 1) };
  }
  function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /* ---------- builds, rewrites, changes, budget: all kept by engine.js ---------- */
  var NO_ENGINE = 'engine.js is not loaded in this build, so marks are only noted: no rebuilds, scaffolds or rewrites.';
  function versionsOf(id) {
    var d = doc(id);
    if (!d || !d.versions) return [1];
    var vs = Object.keys(d.versions).map(Number).filter(function (n) { return n > 0 && d.versions[n] != null; });
    vs.sort(function (a, b) { return a - b; });
    return vs.length ? vs : [1];
  }
  function version(id) {
    var vs = versionsOf(id), v = has('docVersion') ? +ecall('docVersion', id) || 1 : 1;
    if (vs.indexOf(v) >= 0) return v;
    var best = vs[0];
    vs.forEach(function (x) { if (x <= v) best = x; });
    return best;
  }
  function setVersion(id, v) {
    quietly(function () { ecall('setDocVersion', id, v); });
  }
  function rewrittenMap() { return SR.store.get('rewritten', {}) || {}; }
  /* Rewritten anchors of a doc -> rewrite number (0 when only the engine knows it was rewritten). */
  function rewrittenFor(id) {
    var out = {}, loc = rewrittenMap()[id] || {};
    Object.keys(loc).forEach(function (a) { out[a] = loc[a]; });
    if (has('rewritten')) {
      var l = ecall('rewritten', id);
      if (Array.isArray(l)) l.forEach(function (a) { if (!HAS.call(out, a)) out[a] = 0; });
    }
    return out;
  }
  function sigOf(id) { return version(id) + '|' + Object.keys(rewrittenFor(id)).sort().join(','); }
  function changeCounts() { var o = {}; docIds().forEach(function (id) { o[id] = changesOf(id).length; }); return o; }
  function sourceHtml(id) {
    var d = doc(id);
    if (!d || !d.versions) return '';
    var v = version(id);
    return d.versions[v] != null ? String(d.versions[v]) : String(d.versions[versionsOf(id)[0]] || '');
  }
  function changesOf(id) { var l = ecall('changes', id); return Array.isArray(l) ? l : []; }
  function logChange(id, text) {
    quietly(function () { ecall('logChange', id, text); });
    SR.bus.emit('reader:changes', { docId: id });
  }
  /* Logs unless the engine already logged something for this doc since `before` was counted. */
  function logOnce(id, text, before) { if (changesOf(id).length > before) return; logChange(id, text); }
  function budgetOf(id) {
    var b = ecall('budget', id);
    return b && b.max != null ? { used: +b.used || 0, max: +b.max } : { used: 0, max: 3 };
  }
  function rewriteReq(id, a) {
    var r = quietly(function () { return ecall('requestRewrite', id, a); });
    return r || { ok: false, reason: 'no-engine' };
  }

  /* ---------- parsed source (current build + rewrites), shared by render, peek and search ---------- */
  function sourceRoot(id) {
    var sig = sigOf(id), c = srcCache[id];
    if (c && c.sig === sig) return c.root;
    var root = document.createElement('div');
    root.innerHTML = sourceHtml(id);
    applyRewrites(id, root);
    srcCache[id] = { sig: sig, root: root };
    return root;
  }
  function findAnchor(root, a) {
    if (!root || !a) return null;
    var els = root.querySelectorAll('[data-a="' + cssq(a) + '"]');
    for (var i = 0; i < els.length; i++) if (!els[i].closest('.blk, .sr-scaffold')) return els[i];
    return els[0] || null;
  }
  function applyRewrites(id, root) {
    var rw = rewrittenFor(id), c = content(), src = c && c.rewrites && c.rewrites[id];
    if (!src || !Object.keys(rw).length) return;
    Object.keys(rw).forEach(function (a) {
      var html = src[a];
      if (html == null) return;
      var el = findAnchor(root, a);
      if (!el) return;
      var t = document.createElement('div');
      t.innerHTML = String(html);
      var nel;
      if (t.children.length === 1 && (!t.firstElementChild.hasAttribute('data-a') || t.firstElementChild.getAttribute('data-a') === a)) nel = t.firstElementChild;
      else { nel = document.createElement('div'); while (t.firstChild) nel.appendChild(t.firstChild); }
      nel.setAttribute('data-a', a);
      nel.classList.add('sr-rewritten');
      var tag = document.createElement('span');
      tag.className = 'sr-rw-tag';
      tag.textContent = 'Rewritten after a lost mark' + (rw[a] ? ' (rewrite ' + rw[a] + ' of ' + budgetOf(id).max + ')' : '') + '. Written by a model for Adit.';
      nel.insertBefore(tag, nel.firstChild);
      el.parentNode.replaceChild(nel, el);
    });
  }
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  /* Text of an anchor without its nested anchors; blocks become [type:id] tokens (forRev) or vanish. */
  function ownText(el, forRev) {
    var c = el.cloneNode(true), i;
    var nested = c.querySelectorAll('[data-a]');
    for (i = 0; i < nested.length; i++) nested[i].remove();
    var blks = c.querySelectorAll('.blk');
    for (i = 0; i < blks.length; i++) {
      blks[i].replaceWith(document.createTextNode(forRev ? ' [' + (blks[i].getAttribute('data-block') || '') + ':' + (blks[i].getAttribute('data-id') || '') + '] ' : ' '));
    }
    if (!forRev) { var tags = c.querySelectorAll('.sr-rw-tag'); for (i = 0; i < tags.length; i++) tags[i].remove(); }
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function revOf(el) {
    if (el.hasAttribute('data-rev')) return 'r' + el.getAttribute('data-rev');
    return hashStr(ownText(el, true));
  }

  /* ---------- rendering ---------- */
  function metaLine(id) {
    var d = doc(id) || {}, v = version(id), vs = versionsOf(id), bits = [];
    bits.push(d.kind === 'basic' ? 'Basic' : d.kind === 'topic' ? 'Topic doc' : 'Doc');
    if (d.area) bits.push(areaName(d.area));
    if (d.track) bits.push((TRACKS[d.track] || d.track) + ' track');
    bits.push('build ' + v + (vs.length > 1 ? ' of ' + vs[vs.length - 1] : ''));
    var s = bits.map(esc).join(' &middot; ');
    if (v > 1 && d.rebuiltFrom) s += '<br>Rebuilt from its prerequisites: ' + esc(d.rebuiltFrom);
    return s;
  }
  function buildDoc(id) {
    var v = version(id), i;
    var root = sourceRoot(id).cloneNode(true);
    var revs = {}, all = root.querySelectorAll('[data-a]');
    for (i = 0; i < all.length; i++) {
      var a = all[i].getAttribute('data-a');
      if (!HAS.call(revs, a)) revs[a] = revOf(all[i]);
    }
    var pages = [].filter.call(root.children, function (el) { return el.classList.contains('page'); });
    if (!pages.length) {
      var pg = document.createElement('div');
      pg.className = 'page';
      while (root.firstChild) pg.appendChild(root.firstChild);
      root.appendChild(pg);
      pages = [pg];
    }
    var first = pages[0], head = '';
    if (!/Not Adit(?:'|&#39;|&rsquo;|\u2019)s words/.test(sourceHtml(id))) head += '<div class="byline">' + esc(SR.LABEL_MODEL) + '</div>';
    if (!first.querySelector('h1')) head += '<h1 data-a="top">' + esc(title(id)) + '</h1>';
    if (head) first.insertAdjacentHTML('afterbegin', head);
    if (!first.querySelector('.meta')) {
      var h1 = first.querySelector('h1');
      if (h1) h1.insertAdjacentHTML('afterend', '<div class="meta">' + metaLine(id) + '</div>');
    }
    var foot = title(id) + ' \u00b7 build ' + v;
    pages.forEach(function (p, k) { p.setAttribute('data-n', foot + '  \u00b7  ' + (k + 1) + ' / ' + pages.length); });
    var node = document.createElement('section');
    node.className = 'sr-doc';
    node.setAttribute('data-doc', id);
    node.setAttribute('data-ver', String(v));
    while (root.firstChild) node.appendChild(root.firstChild);
    return { node: node, revs: revs, v: v };
  }
  function curEntry() { return S.cur ? S.cache[S.cur] || null : null; }
  function curNode() { var e = curEntry(); return e ? e.node : null; }
  function ensureRendered(id) {
    var sig = sigOf(id), e = S.cache[id];
    if (e && e.sig === sig) return e;
    if (e) dropCache(id);
    var b = buildDoc(id);
    e = S.cache[id] = { id: id, node: b.node, revs: b.revs, v: b.v, sig: sig, mounted: false, typeset: false };
    addScaffolds(id, e.node);
    return e;
  }
  function dropCache(id) {
    var e = S.cache[id];
    if (!e) return;
    SR.blocks.unmountAll(e.node);
    destroyScaffolds(e.node);
    if (e.node.parentNode) e.node.parentNode.removeChild(e.node);
    delete S.cache[id];
  }
  function blockCtx(id) {
    var d = doc(id) || {};
    return {
      docId: id, version: version(id), engine: SR.engine || null,
      doc: d, area: d.area || null, track: d.track || null,
      open: function (docId, anchor) { SR.sheet.closeAll(true); follow(docId + (anchor ? '#' + anchor : '')); },
      peek: function (ref, anchorEl) { openPeek(ref, anchorEl); },
      relayout: requestRelayout,
      toast: SR.toast
    };
  }
  function showDoc(id) {
    if (!doc(id)) return false;
    closeMenu(true);
    closePeek();
    if (S.cur && S.cur !== id) S.scroll[S.cur] = window.scrollY;
    var e = ensureRendered(id);
    var old = D.host.firstElementChild;
    if (old && old !== e.node) D.park.appendChild(old);
    if (e.node.parentNode !== D.host) D.host.appendChild(e.node);
    S.cur = id;
    SR.store.set('doc', id);
    ensureTab(id);
    if (!e.mounted) { e.mounted = true; SR.blocks.mountAll(e.node, blockCtx(id)); }
    if (!e.typeset) { e.typeset = true; SR.typeset(e.node).then(function () { onDocTypeset(id); }); }
    renderTabs();
    relayout();
    SR.bus.emit('reader:doc', { docId: id, version: e.v });
    return true;
  }
  function onDocTypeset(id) {
    if (id !== S.cur) return;
    relayout();
    var now = performance.now();
    if (S.keepView && S.keepView.doc === id && now < S.keepView.until) {
      var el = findAnchor(curNode(), S.keepView.a);
      if (el && el.getClientRects().length) window.scrollBy(0, el.getBoundingClientRect().top - S.keepView.vpTop);
      S.keepView = null;
    } else if (S.pendingNav && S.pendingNav.doc === id && now < S.pendingNav.until) {
      scrollToAnchor(id, S.pendingNav.a, false);
    }
    S.pendingNav = null;
  }
  function rerenderCurrent(keepA, stats) {
    var id = S.cur;
    if (!id) return;
    var node = curNode(), el = keepA && node ? findAnchor(node, keepA) : null;
    var vpTop = el && el.getClientRects().length ? el.getBoundingClientRect().top : null;
    var y = window.scrollY;
    dropCache(id);
    showDoc(id);
    var nel = vpTop !== null ? findAnchor(curNode(), keepA) : null;
    if (nel && nel.getClientRects().length) {
      window.scrollBy(0, nel.getBoundingClientRect().top - vpTop);
      S.keepView = { doc: id, a: keepA, vpTop: vpTop, until: performance.now() + 4000 };
    } else window.scrollTo(0, y);
    if (stats) {
      var st = inkStats(id), note = S.rebuildNote && S.rebuildNote[id] ? ' ' + S.rebuildNote[id] : '';
      if (S.rebuildNote) delete S.rebuildNote[id];
      SR.toast('Rebuilt ' + title(id) + ' (build ' + version(id) + '): ' + plural(st.moved, 'stroke') + (st.moved === 1 ? ' followed its anchor, ' : ' followed their anchors, ') +
        st.changed + ' on rewritten text, ' + st.orphaned + ' orphaned.' + note, 6200);
    }
  }
  /* Proof attempts on a doc's old build: an unfinished one carries into the new build's proof (block-fog.js,
     block-drill.js), a finished one is shown read-only under its proof. One sentence for the toast and the
     Changes entry, or '' when there were none. */
  function attemptNote(id, from, to) {
    var L = SR.fog && typeof SR.fog.attempts === 'function' ? SR.fog.attempts(id, from) || [] : [];
    var open = L.filter(function (x) { return !x.done && !x.carriedTo; }).length, done = L.filter(function (x) { return x.done; }).length;
    if (!open && !done) return '';
    var bits = [];
    if (open) bits.push((open === 1 ? 'the unfinished proof attempt continues' : open + ' unfinished proof attempts continue') + ' in build ' + to);
    if (done) bits.push((done === 1 ? 'the finished one is' : done + ' finished ones are') + ' shown under ' + (done === 1 ? 'its proof' : 'their proofs'));
    var s = bits.join('; ');
    return 'From build ' + from + ': ' + s + '.';
  }
  function inkStats(id) {
    var mv = 0, ch = 0, or = 0;
    (S.ink[id] || []).forEach(function (st) {
      var at = st.at;
      if (!at) { mv++; return; }
      var A = S.anchors[at.a];
      if (!A) or++; else if (A.rev !== at.rev) ch++; else mv++;
    });
    return { moved: mv, changed: ch, orphaned: or };
  }

  /* ---------- layout ---------- */
  function requestRelayout() {
    if (relayoutRaf) return;
    relayoutRaf = requestAnimationFrame(function () { relayoutRaf = 0; relayout(); });
  }
  function relayout() {
    if (!D.stack) return;
    var cs = getComputedStyle(D.main);
    var avail = D.main.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    var s = Math.max(0.2, Math.min(1, avail / W));
    S.scale = s;
    D.stack.style.transform = 'scale(' + s + ')';
    measure();
    buildOrphans();
    S.H = Math.max(1, D.stack.offsetHeight);
    D.wrap.style.width = (W * s) + 'px';
    D.wrap.style.height = Math.ceil(S.H * s) + 'px';
    D.ovl.style.height = S.H + 'px';
    if (docInk) docInk.layout();
    rescaleInks(s);
    paintOverlay();
    updHeader();
  }
  /* Ink boxes inside the page (proof attempts, scaffold boxes, kata sketches, inline drills) keep their CSS
     size when the page scale changes, so their own ResizeObserver never fires: re-lay each one whenever
     the scale it was last laid out at differs (a wider window, Split View to full screen, a doc shown again). */
  function rescaleInks(s) {
    if (!SR.ink || typeof SR.ink.instances !== 'function') return;
    SR.ink.instances().forEach(function (i) {
      if (i === docInk || !i.el || i.__srScale === s || !D.stack.contains(i.el)) return;
      i.__srScale = s;
      try { i.layout(); } catch (e) { console.error('[SR] ink relayout failed:', e); }
    });
  }
  function measure() {
    var map = {}, node = curNode();
    if (node) {
      var sr = D.stack.getBoundingClientRect(), s = S.scale || 1, e = curEntry(), revs = (e && e.revs) || {};
      var els = node.querySelectorAll('[data-a]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i], a = el.getAttribute('data-a');
        if (HAS.call(map, a) || el.closest('.sr-scaffold')) continue;
        var rev = HAS.call(revs, a) ? revs[a] : '';
        if (!el.getClientRects().length) { map[a] = { hidden: true, rev: rev, el: el }; continue; }
        map[a] = { top: (el.getBoundingClientRect().top - sr.top) / s, rev: rev, el: el };
      }
    }
    S.anchors = map;
    return map;
  }
  function inkList() {
    if (!S.cur) return [];
    if (!S.ink[S.cur]) S.ink[S.cur] = loadInk(S.cur);
    return S.ink[S.cur];
  }
  function loadInk(id) {
    var l = SR.store.get('ink-' + id, []);
    return Array.isArray(l) ? l.filter(function (s) { return s && Array.isArray(s.p); }) : [];
  }
  function saveInk(id) { SR.store.set('ink-' + id, S.ink[id] || []); }
  function buildOrphans() {
    S.orphanPos = {};
    var groups = {}, order = [];
    inkList().forEach(function (st) {
      if (!st.at || st.at.a == null || HAS.call(S.anchors, st.at.a)) return;
      if (!groups[st.at.a]) { groups[st.at.a] = []; order.push(st.at.a); }
      groups[st.at.a].push(st);
    });
    if (!order.length) { if (S.orphHtml) { D.orph.innerHTML = ''; S.orphHtml = ''; } return; }
    var ext = {}, h = '<div class="page orphan" data-n="Orphaned ink"><h1>Orphaned ink</h1><div class="meta">Strokes whose anchor is gone from this build of ' +
      esc(title(S.cur)) + '. They wait here until you delete them.</div>';
    order.forEach(function (a) {
      var mn = Infinity, mx = -Infinity;
      groups[a].forEach(function (st) { st.p.forEach(function (q) { if (q[1] < mn) mn = q[1]; if (q[1] > mx) mx = q[1]; }); });
      ext[a] = mn;
      var hh = Math.max(40, Math.min(1400, mx - mn + 28));
      h += '<div class="og" data-g="' + esc(a) + '"><div class="oglbl">was at <code>#' + esc(a) + '</code> &middot; ' + plural(groups[a].length, 'stroke') +
        ' <button type="button" data-act="odel" data-a="' + esc(a) + '">delete</button></div><div class="ogspace" style="height:' + Math.round(hh) + 'px"></div></div>';
    });
    h += '</div>';
    if (h !== S.orphHtml) { D.orph.innerHTML = h; S.orphHtml = h; }
    var sr = D.stack.getBoundingClientRect(), s = S.scale || 1;
    [].forEach.call(D.orph.querySelectorAll('.og'), function (g) {
      var r = g.querySelector('.ogspace').getBoundingClientRect(), a = g.getAttribute('data-g');
      S.orphanPos[a] = { top: (r.top - sr.top) / s + 14, minY: ext[a] };
    });
  }

  /* ---------- doc ink: anchored to the nearest [data-a] above the stroke ---------- */
  function placeStroke(st) {
    var at = st.at;
    if (!at || at.a == null) return {};
    var A = S.anchors[at.a];
    if (A) {
      if (A.hidden) return null;
      return { dy: A.top - (+at.dy || 0), alpha: A.rev !== at.rev ? 0.35 : 1 };
    }
    var g = S.orphanPos[at.a];
    if (!g) return null;
    return { dy: g.top - g.minY };
  }
  function anchorStroke(st) {
    var mn = Infinity, mx = -Infinity;
    st.p.forEach(function (q) { if (q[1] < mn) mn = q[1]; if (q[1] > mx) mx = q[1]; });
    var cy = (mn + mx) / 2, best = null, bt = -Infinity, a;
    for (a in S.anchors) {
      var v = S.anchors[a];
      if (v.hidden) continue;
      if (v.top <= cy + 2 && v.top > bt) { bt = v.top; best = a; }
    }
    if (best === null) {
      for (a in S.anchors) if (!S.anchors[a].hidden && (best === null || S.anchors[a].top < S.anchors[best].top)) best = a;
    }
    if (best === null) return;
    var A = S.anchors[best];
    st.at = { a: best, dy: Math.round(A.top * 10) / 10, rev: A.rev, v: version(S.cur) };
  }
  var INK_SKIP = '.sr-ink, button, input, textarea, select, label, summary, [contenteditable="true"], [contenteditable=""], .mark, .markmenu, .cchip, .oglbl, .no-ink, #sr-peek';
  function inkIgnore(e) {
    var t = e.target;
    if (!t || !t.closest) return false;
    if (t.closest(INK_SKIP)) return true;
    if ((e.pointerType || 'pen') === 'mouse' && t.closest('.ref, a[href], .chip, [role="button"], [data-act]')) return true;
    return false;
  }

  /* ---------- overlay: margin chips, changed-ink chips, the mark menu ---------- */
  function markInfo(m) {
    if (!m) return { cls: '', label: '' };
    if (m.verb === 'easy') return { cls: 'easy', label: 'easy' };
    if (m.verb === 'forgot') return { cls: 'forgot', label: 'forgot' };
    switch (m.state) {
      case 'struggling': return { cls: 'struggling', label: 'struggling' };
      case 'eligible': return { cls: 'eligible', label: 'rewrite ready' };
      case 'exhausted': return { cls: 'lost', label: 'lost, no rewrites' };
      case 'rebuilt': return { cls: 'rebuilt', label: 'rebuilt' };
      case 'rewritten': return { cls: 'rewritten', label: 'rewritten' };
      default: return { cls: 'lost', label: 'lost' };
    }
  }
  function stateText(m) {
    if (!m) return '';
    var when = m.t ? ' \u00b7 ' + SR.fmt.dateTime(m.t) : '';
    if (m.verb !== 'lost') return m.verb + when;
    return markInfo(m).label + when;
  }
  function paintOverlay(force) {
    if (!D.ovl) return;
    if (!S.cur) { if (S.ovlHtml) { D.ovl.innerHTML = ''; S.ovlHtml = ''; } return; }
    var items = [];
    Object.keys(S.anchors).forEach(function (a) {
      var A = S.anchors[a];
      if (A.hidden || !A.el || a === 'top' || A.el.tagName === 'H1' || A.el.closest('.blk, .sr-scaffold')) return;
      items.push({ kind: 'mark', a: a, top: A.top, h2: A.el.tagName === 'H2' });
    });
    var changed = {};
    inkList().forEach(function (st) {
      var at = st.at;
      if (!at) return;
      var A = S.anchors[at.a];
      if (A && !A.hidden && A.rev !== at.rev) changed[at.a] = (changed[at.a] || 0) + 1;
    });
    Object.keys(changed).forEach(function (a) { items.push({ kind: 'changed', a: a, top: S.anchors[a].top, n: changed[a] }); });
    items.sort(function (x, y) { return (x.top - y.top) || (x.kind === 'mark' ? -1 : 1); });
    var y = -Infinity, h = '', menu = '';
    items.forEach(function (it) {
      var top = Math.max(it.top, y + 3), ts = top.toFixed(1);
      if (it.kind === 'changed') {
        h += '<div class="cchip" style="top:' + ts + 'px"><span>changed &middot; ' + plural(it.n, 'stroke') + '</span><button type="button" data-act="keep" data-a="' + esc(it.a) +
          '">keep</button><button type="button" data-act="del" data-a="' + esc(it.a) + '">delete</button></div>';
        y = top + 58;
        return;
      }
      var key = S.cur + '#' + it.a, m = S.marks[key], info = markInfo(m), cls = 'mark', label = '';
      if (m) { cls += ' on ' + info.cls; label = info.label; }
      else if (it.h2) label = 'mark';
      else cls += ' dot';
      h += '<span class="' + cls + '" data-key="' + esc(key) + '" style="top:' + ts + 'px" role="button" aria-label="Mark #' + esc(it.a) + '">' + esc(label) + '</span>';
      y = top + 25;
      if (S.menuKey === key) menu = menuHtml(key, top + 28);
    });
    h += menu;
    if (force || h !== S.ovlHtml) { D.ovl.innerHTML = h; S.ovlHtml = h; }
  }
  function menuHtml(key, top) {
    var m = S.marks[key];
    var h = '<div class="markmenu" data-key="' + esc(key) + '" style="top:' + top.toFixed(1) + 'px">';
    if (m) h += '<div class="mm-state">' + esc(stateText(m)) + '</div>';
    h += '<button type="button" data-verb="lost" class="lost">' + (m && m.verb === 'lost' ? 'still lost' : 'lost') + '</button>' +
      '<button type="button" data-verb="easy" class="easy">easy</button><button type="button" data-verb="forgot" class="forgot">forgot</button>';
    if (m) h += '<button type="button" data-verb="clear">clear mark</button>';
    return h + '</div>';
  }
  function openMenu(key) { S.menuKey = key; paintOverlay(true); }
  function closeMenu(silent) {
    if (!S.menuKey) return;
    S.menuKey = null;
    if (!silent) paintOverlay(true);
  }

  /* ---------- marks and triage ---------- */
  function saveMarks() { SR.store.set('marks', S.marks); }
  function emitMarks() { SR.bus.emit('reader:marks', S.marks); }
  function attemptCount(key) { var l = SR.store.get('attempt-' + key, []); return Array.isArray(l) ? l.length : 0; }
  function sectionEls(root, el) {
    if (el.tagName !== 'H2') return [el];
    var out = [el], n = el.nextElementSibling;
    while (n && n.tagName !== 'H2') { out.push(n); n = n.nextElementSibling; }
    return out;
  }
  /* data-to targets of the links inside a passage (a heading's passage runs to the next heading). */
  function passageLinks(id, a) {
    var root = sourceRoot(id), el = a ? findAnchor(root, a) : null, out = [];
    (el ? sectionEls(root, el) : [root]).forEach(function (scope) {
      [scope].concat([].slice.call(scope.querySelectorAll('.ref[data-to]'))).forEach(function (r) {
        if (r.matches && r.matches('.ref[data-to]')) { var to = r.getAttribute('data-to'); if (out.indexOf(to) < 0) out.push(to); }
      });
    });
    return out;
  }
  /* engine.triage decides every mark; without engine.js a mark is only noted. */
  function triage(args) {
    var r = quietly(function () { return ecall('triage', args); });
    return r && r.action ? r : { action: 'noted', reason: NO_ENGINE, basics: [] };
  }
  function setMark(key, verb) {
    var t = parseTo(key);
    if (!t.doc || !t.a) return;
    closeMenu(true);
    var now = SR.now(), m = S.marks[key] || { doc: t.doc, a: t.a, t: now };
    m.prev = m.verb === 'lost' ? m.state || '' : '';
    m.verb = verb;
    m.tLast = now;
    /* easy or forgot ends a lost cycle in the engine; a later lost mark starts a new one with its own since */
    if (verb !== 'lost') { delete m.since; delete m.eligibleAt; }
    S.marks[key] = m;
    var snap = changeCounts();
    var res = triage({ docId: t.doc, anchor: t.a, verb: verb, attemptStrokes: attemptCount(key), links: passageLinks(t.doc, t.a) }) || { action: 'noted' };
    m.action = res.action;
    m.reason = res.reason || '';
    if (verb !== 'lost') {
      m.state = 'noted';
      saveMarks();
      removeScaffold(key);
      paintOverlay(true);
      SR.toast(res.reason && res.reason.length > 14 ? res.reason : 'Marked #' + t.a + ' ' + verb, 4200);
      emitMarks();
      return;
    }
    act(key, m, res, snap);
  }
  function act(key, m, res, snap) {
    var basics = (res.basics || []).filter(function (b) { return !!doc(b); });
    if (basics.length) m.basics = basics;
    else if (!m.basics) m.basics = [];
    m.drill = res.drill && doc(res.drill) ? res.drill : null;
    if (res.action === 'rebuild-basic') { doRebuild(key, m, basics.length ? basics : [m.doc], res, snap || {}); return; }
    /* the engine owns the lost cycle: its since and eligibleAt, not the first time this passage was marked */
    if (res.since) m.since = res.since;
    if (res.eligibleAt) m.eligibleAt = res.eligibleAt;
    var msg;
    switch (res.action) {
      case 'scaffold':
        m.state = 'struggling';
        if (!m.since) m.since = SR.now();
        msg = m.prev === 'struggling' ? 'Not yet: a rewrite needs a day still lost and ink in the attempt box.' : 'Lost here: try it on paper first. The basics it rests on are linked.';
        break;
      case 'eligible':
        m.state = 'eligible';
        msg = 'Still lost after a day, with an attempt: you can request a rewrite.';
        break;
      case 'budget-exhausted':
        m.state = 'exhausted';
        msg = 'No rewrites left on ' + title(m.doc) + '. Drill the basic instead.';
        break;
      default:
        m.state = 'noted';
        msg = res.reason || 'Marked #' + m.a + ' lost';
    }
    saveMarks();
    if (m.state === 'noted') removeScaffold(key); else ensureScaffold(key);
    paintOverlay(true);
    requestRelayout();
    SR.toast(msg, 4600);
    emitMarks();
  }
  /* engine.triage decides; the reader switches the build (to res.versions[b] when the engine names one,
     else the highest build), re-anchors ink and writes the basic's Changes entry (a basic in res.queued
     has no second build in the demo, so its rebuild is logged as queued). Nothing is logged twice:
     logOnce compares against change counts taken before triage ran. */
  function doRebuild(key, m, basics, res, snap) {
    m.state = 'rebuilt';
    m.basics = basics;
    var rebuilt = [], named = (res && res.versions) || {};
    basics.forEach(function (b) {
      var vs = versionsOf(b), cur = version(b), d = doc(b), before = HAS.call(snap, b) ? snap[b] : changesOf(b).length;
      var top = +named[b] > 0 && vs.indexOf(+named[b]) >= 0 ? +named[b] : vs[vs.length - 1];
      if (top > cur) {
        var an = attemptNote(b, cur, top);
        setVersion(b, top);
        logOnce(b, 'Rebuilt whole from its prerequisites (build ' + top + ') after a lost mark on ' + title(m.doc) + ' #' + m.a + '.' + (d && d.rebuiltFrom ? ' ' + d.rebuiltFrom : '') +
          (an ? ' ' + an : ''), before);
        if (an) (S.rebuildNote = S.rebuildNote || {})[b] = an;
        rebuilt.push(b);
      } else {
        logOnce(b, 'Lost mark on ' + title(m.doc) + ' #' + m.a + ': the gap is in this basic, so it is rebuilt whole from its prerequisites' +
          (top > 1 && cur >= top ? ' (already at build ' + cur + ').' : ' (simulated: the demo content has no second build of it).'), before);
      }
    });
    saveMarks();
    Object.keys(S.cache).forEach(function (id) { if (id !== S.cur && S.cache[id].sig !== sigOf(id)) dropCache(id); });
    if (rebuilt.indexOf(S.cur) >= 0) rerenderCurrent(m.a, true);
    else {
      ensureScaffold(key);
      paintOverlay(true);
      requestRelayout();
      SR.toast(rebuilt.length ? 'The gap is in a basic: ' + rebuilt.map(title).join(', ') + ' rebuilt from its prerequisites. The banner links to it.' :
        'The gap is in a basic: ' + basics.map(title).join(', ') + '. Rebuild logged in its Changes.', 5200);
    }
    emitMarks();
  }
  function clearMark(key) {
    var t = parseTo(key);
    if (has('clearMark')) quietly(function () { ecall('clearMark', t.doc, t.a); });
    delete S.marks[key];
    saveMarks();
    closeMenu(true);
    removeScaffold(key);
    paintOverlay(true);
    requestRelayout();
    SR.toast('Mark cleared');
    emitMarks();
  }

  /* ---------- the scaffold after a lost mark: linked basics, attempt box, rewrite or drill ---------- */
  function ruled(ctx, w, h) {
    ctx.strokeStyle = SR.css('--line') || '#d9d4ca';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var y = 44; y < h; y += 44) { ctx.moveTo(14, y); ctx.lineTo(w - 14, y); }
    ctx.stroke();
  }
  function addScaffolds(id, node) {
    Object.keys(S.marks).forEach(function (key) {
      var m = S.marks[key];
      if (m && m.doc === id && m.verb === 'lost' && LOST_STATES.indexOf(m.state) >= 0) placeScaffold(node, key);
    });
  }
  function ensureScaffold(key) {
    var m = S.marks[key], e = m && S.cache[m.doc];
    if (e) placeScaffold(e.node, key);
  }
  function scaffoldEl(node, key) { return node ? node.querySelector('.sr-scaffold[data-key="' + cssq(key) + '"]') : null; }
  function removeScaffold(key) {
    var e = S.cache[parseTo(key).doc], sc = e && scaffoldEl(e.node, key);
    if (!sc) return;
    if (sc.__ink) sc.__ink.destroy();
    sc.remove();
    requestRelayout();
  }
  function destroyScaffolds(node) {
    [].forEach.call(node.querySelectorAll('.sr-scaffold'), function (sc) { if (sc.__ink) { sc.__ink.destroy(); sc.__ink = null; } });
  }
  function insertAfterPassage(el, sc) {
    if (el.tagName === 'H2') {
      var n = el.nextElementSibling;
      while (n && n.tagName !== 'H2') n = n.nextElementSibling;
      if (n) n.parentNode.insertBefore(sc, n); else el.parentNode.appendChild(sc);
      return;
    }
    var host = el;
    if (el.tagName === 'LI' && el.parentNode && /^(UL|OL)$/.test(el.parentNode.tagName)) host = el.parentNode;
    else if (/^(TD|TH|TR|DT|DD|SPAN|B|I|EM|STRONG|A)$/.test(el.tagName)) host = el.closest('table, dl, p, div') || el;
    host.insertAdjacentElement('afterend', sc);
  }
  function placeScaffold(node, key) {
    var m = S.marks[key];
    if (!m || !node) return null;
    var sc = scaffoldEl(node, key);
    if (!sc) {
      var el = findAnchor(node, m.a);
      if (!el) return null;
      sc = document.createElement('div');
      sc.className = 'sr-scaffold no-ink';
      sc.setAttribute('data-key', key);
      sc.innerHTML = '<div class="sr-sc-h"></div><div class="sr-sc-banner" hidden></div><div class="sr-sc-basics" hidden></div>' +
        '<div class="sr-sc-att" hidden><div class="sr-sc-lab">Your attempt: what the passage claims and why, in your own words.</div>' +
        '<div class="sr-sc-ink"></div><div class="sr-row sr-sc-tools"><button type="button" data-sc="undo">Undo</button><button type="button" data-sc="more">More paper</button>' +
        '<span class="sp"></span><span class="sr-hint sr-sc-count"></span></div></div><div class="sr-row sr-sc-foot"></div><div class="sr-hint sr-sc-status"></div>';
      insertAfterPassage(el, sc);
      sc.addEventListener('click', function (e) { onScaffoldClick(e, sc); });
    }
    updateScaffold(sc);
    return sc;
  }
  function headFor(m) {
    switch (m.state) {
      case 'rebuilt': return 'Lost here: rebuilt';
      case 'eligible': return 'Lost here: rewrite ready';
      case 'exhausted': return 'Lost here: no rewrites left';
      case 'rewritten': return 'Lost here: rewritten';
      default: return 'Lost here: struggling';
    }
  }
  function stagePill(id) {
    var d = doc(id);
    if (!d || d.kind !== 'basic' || !has('stage')) return '';
    var st = +ecall('stage', id) || 0, pl = has('pushLevel') ? +ecall('pushLevel', id) || 0 : 0;
    return ' <span class="sr-stage s' + Math.max(0, Math.min(5, st)) + '">stage ' + st + (pl ? ' &middot; push ' + pl : '') + '</span>';
  }
  function updateScaffold(sc) {
    var key = sc.getAttribute('data-key'), m = S.marks[key];
    if (!m) return;
    var basics = (m.basics || []).filter(function (b) { return !!doc(b); }), st = m.state;
    sc.querySelector('.sr-sc-h').innerHTML = '<span class="sr-kick">' + esc(headFor(m)) + '</span>' + (m.reason ? '<span class="sr-hint">' + esc(m.reason) + '</span>' : '');
    var banner = sc.querySelector('.sr-sc-banner');
    if (st === 'rebuilt') {
      banner.hidden = false;
      var others = basics.filter(function (b) { return b !== m.doc; });
      banner.innerHTML = (basics.indexOf(m.doc) >= 0 ? 'This basic is now build ' + version(m.doc) + '. Ink on changed passages is dimmed; ink whose passage is gone waits on the last page. ' : '') +
        (others.length ? 'Rebuilt: ' + others.map(function (b) { return '<a class="ref" data-to="' + esc(b) + '">' + esc(title(b)) + ' (build ' + version(b) + ')</a>'; }).join(', ') + '.' : '') ||
        'Rebuilt.';
    } else if (st === 'rewritten') {
      banner.hidden = false;
      banner.textContent = 'The passage above was rewritten (rewrite ' + (m.rewriteN || '?') + ' of ' + budgetOf(m.doc).max + ' on this doc). Your attempt stays below.';
    } else banner.hidden = true;
    var bl = sc.querySelector('.sr-sc-basics');
    if (basics.length && st !== 'rebuilt') {
      bl.hidden = false;
      bl.innerHTML = '<span class="sr-hint">Rests on</span> ' + basics.map(function (b) { return '<a class="ref" data-to="' + esc(b) + '">' + esc(title(b)) + '</a>' + stagePill(b); }).join(' ');
    } else bl.hidden = true;
    var att = sc.querySelector('.sr-sc-att'), showAtt = st === 'struggling' || st === 'eligible' || st === 'exhausted' || st === 'rewritten';
    att.hidden = !showAtt;
    if (showAtt && !sc.__ink) {
      sc.__ink = SR.ink.create(sc.querySelector('.sr-sc-ink'), {
        width: W,
        height: function () { var mm = S.marks[key]; return (mm && mm.h) || 220; },
        key: 'attempt-' + key,
        background: ruled,
        readOnly: function () { var mm = S.marks[key]; return !mm || mm.state === 'rewritten'; },
        onChange: function () { recheckMarks(key); updateScaffoldStatus(sc); }
      });
    }
    if (sc.__ink) sc.__ink.setReadOnly(st === 'rewritten');
    renderFoot(sc, m, basics);
    updateScaffoldStatus(sc);
  }
  function renderFoot(sc, m, basics) {
    var foot = sc.querySelector('.sr-sc-foot'), key = sc.getAttribute('data-key');
    foot.innerHTML = '';
    function btn(label, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      if (fn) b.addEventListener('click', fn);
      foot.appendChild(b);
      return b;
    }
    if (m.state === 'struggling') btn('Still lost', '', function () { setMark(key, 'lost'); }).setAttribute('data-sc-act', 'still');
    if (m.state === 'eligible') {
      var b = budgetOf(m.doc), left = Math.max(0, b.max - b.used);
      var rb = btn('Request rewrite (' + left + ' of ' + b.max + ' left)', 'primary');
      rb.setAttribute('data-sc-act', 'rewrite');
      SR.twoTap(rb, 'Tap again to spend 1 of ' + left, function () { requestRewrite(key); });
    }
    if (m.state === 'exhausted') {
      var drills = m.drill ? [m.drill] : basics;
      drills.forEach(function (bid) { btn('Drill ' + title(bid) + ' instead', 'primary', function () { openDrill(bid); }).setAttribute('data-sc-act', 'drill'); });
      if (!drills.length) foot.insertAdjacentHTML('beforeend', '<span class="sr-hint">No linked basic to drill.</span>');
    }
    var sp = document.createElement('span');
    sp.className = 'sp';
    foot.appendChild(sp);
    btn('Clear mark', '', function () { clearMark(key); });
  }
  function updateScaffoldStatus(sc) {
    var key = sc.getAttribute('data-key'), m = S.marks[key];
    if (!m) return;
    var n = attemptCount(key), cnt = sc.querySelector('.sr-sc-count'), out = sc.querySelector('.sr-sc-status');
    if (cnt) cnt.textContent = n ? plural(n, 'stroke') : 'empty';
    var b = budgetOf(m.doc), left = Math.max(0, b.max - b.used), now = SR.now(), txt = '';
    if (m.state === 'struggling') {
      var since = m.since || now, at = m.eligibleAt || since + DAY;
      txt = 'Since ' + SR.fmt.dateTime(since) + ' · ' + (now >= at ?
        (n ? 'a day has passed and the box has ink: tap Still lost if you still are' : 'a day has passed; a rewrite needs ink in the box') :
        'rewrite possible from ' + SR.fmt.dateTime(at) + ' with ink in the box') +
        ' · ' + left + ' of ' + b.max + ' rewrites left on this doc.';
    } else if (m.state === 'eligible') txt = 'A rewrite spends 1 of the ' + left + ' left on this doc.';
    else if (m.state === 'exhausted') txt = 'All ' + b.max + ' rewrites on this doc are used.';
    out.textContent = txt;
    out.hidden = !txt;
  }
  /* Re-evaluates rationed lost marks without starting a new cycle (engine.recheck): after the clock
     moves or the attempt box changes, a struggling mark can become eligible; after a rewrite spends the
     doc's budget, its other marks show fewer rewrites left or none (onlyDoc). No-op without the engine. */
  function recheckMarks(onlyKey, onlyDoc) {
    if (!has('recheck')) return;
    var changedAny = false;
    Object.keys(S.marks).forEach(function (key) {
      if (onlyKey && key !== onlyKey) return;
      var m = S.marks[key];
      if (onlyDoc && (!m || m.doc !== onlyDoc)) return;
      if (!m || m.verb !== 'lost' || ['struggling', 'eligible', 'exhausted'].indexOf(m.state) < 0) return;
      var res = quietly(function () { return ecall('recheck', m.doc, m.a, attemptCount(key)); });
      if (!res || !res.action) return;
      var ns = res.action === 'eligible' ? 'eligible' : res.action === 'budget-exhausted' ? 'exhausted' : res.action === 'scaffold' ? 'struggling' : null;
      if (!ns) return;
      if (res.reason) m.reason = res.reason;
      if (res.eligibleAt) m.eligibleAt = res.eligibleAt;
      if (res.drill && doc(res.drill)) m.drill = res.drill;
      if (ns !== m.state) { m.state = ns; changedAny = true; }
      var e = S.cache[m.doc], sc = e && scaffoldEl(e.node, key);
      if (sc) updateScaffold(sc);
    });
    if (changedAny) { saveMarks(); paintOverlay(true); emitMarks(); }
  }
  function onScaffoldClick(e, sc) {
    var b = e.target.closest('[data-sc]');
    if (!b) return;
    var key = sc.getAttribute('data-key'), m = S.marks[key], what = b.getAttribute('data-sc');
    if (what === 'undo' && sc.__ink) sc.__ink.undo();
    else if (what === 'more' && m) {
      m.h = Math.min(1600, (m.h || 220) + 176);
      saveMarks();
      if (sc.__ink) sc.__ink.layout();
    }
  }
  function requestRewrite(key) {
    var m = S.marks[key];
    if (!m) return;
    var before = changesOf(m.doc).length, res = rewriteReq(m.doc, m.a) || { ok: false }, b = budgetOf(m.doc);
    if (!res.ok && res.reason === 'not-eligible') {
      m.state = 'struggling';
      saveMarks();
      ensureScaffold(key);
      paintOverlay(true);
      SR.toast('Not eligible yet: a rewrite needs a day still lost and ink in the attempt box.', 4600);
      emitMarks();
      return;
    }
    if (!res.ok) {
      m.state = 'exhausted';
      m.reason = 'This doc has used its ' + (res.max || b.max) + ' rewrites.';
      saveMarks();
      recheckMarks(null, m.doc);   /* the engine's reason, its drill pick, and the doc's other marks */
      ensureScaffold(key);
      paintOverlay(true);
      SR.toast('No rewrites left on ' + title(m.doc) + ' (' + (res.used != null ? res.used : b.used) + ' of ' + (res.max || b.max) + '). Drill the basic instead.', 4600);
      emitMarks();
      return;
    }
    var c = content(), html = c && c.rewrites && c.rewrites[m.doc] && c.rewrites[m.doc][m.a] != null ? c.rewrites[m.doc][m.a] : (res.html || null);
    if (html != null) {
      var rw = rewrittenMap();
      (rw[m.doc] = rw[m.doc] || {})[m.a] = res.used || 1;
      SR.store.set('rewritten', rw);
    }
    logOnce(m.doc, (html != null ? 'Rewrote #' + m.a : 'Rewrite of #' + m.a + ' requested (simulated: the demo content has no rewrite for this passage)') +
      ' after a lost mark held a day with an attempt on paper. Rewrite ' + (res.used || '?') + ' of ' + (res.max || b.max) + '.', before);
    m.state = 'rewritten';
    m.rewriteN = res.used;
    m.reason = 'Rewritten after a day still lost, with an attempt on paper.';
    saveMarks();
    /* The rewrite spent budget: the doc's other lost marks now show fewer rewrites left, or none (then the
       drill instead). The engine logs the rewrite quietly, so nothing else re-checks them. */
    recheckMarks(null, m.doc);
    if (html != null && m.doc === S.cur) rerenderCurrent(m.a, false);
    else { if (html != null) dropCache(m.doc); ensureScaffold(key); paintOverlay(true); }
    SR.toast(html != null ? 'Rewrote #' + m.a + '. Ink on the old text is dimmed; keep or delete it in the margin.' : 'Rewrite logged in Changes (no rewrite text in the demo content).', 4800);
    emitMarks();
  }
  /* A blank-page drill of a basic in a sheet (block-drill.js: the basic's proofs with a switcher). */
  function openDrill(basic) {
    if (SR.drill && typeof SR.drill.open === 'function') {
      try { if (SR.drill.open(basic, { choose: true })) return; } catch (e) { console.error('[SR] drill failed to start:', e); }
    }
    SR.toast(SR.drill ? 'No drill for ' + title(basic) + ' in the demo content; opening the basic.' : 'block-drill.js is not loaded; opening the basic.');
    follow(basic);
  }

  /* ---------- peek ---------- */
  function cleanClone(el) {
    var c = el.cloneNode(true);
    var blocks = [].slice.call(c.querySelectorAll('.blk'));
    if (c.classList && c.classList.contains('blk')) blocks.unshift(c);
    blocks.forEach(function (b) {
      var ph = document.createElement('div');
      ph.className = 'blk-ph';
      ph.textContent = b.getAttribute('data-block') === 'fog' ? 'Proof fogged: open the doc to work it.' : 'Interactive block: open the doc to use it.';
      if (b === c) c = ph; else b.replaceWith(ph);
    });
    [c].concat([].slice.call(c.querySelectorAll('[data-a]'))).forEach(function (x) { if (x.removeAttribute) x.removeAttribute('data-a'); });
    return c;
  }
  function openPeek(to, anchorEl) {
    var t = parseTo(to);
    if (!doc(t.doc)) { SR.toast('No doc "' + t.doc + '" in this build'); return; }
    var src = sourceRoot(t.doc), box = document.createElement('div');
    box.className = 'pk-b';
    var el = t.a && t.a !== 'top' ? findAnchor(src, t.a) : null;
    if (t.a && t.a !== 'top' && !el) box.innerHTML = '<p class="muted">#' + esc(t.a) + ' is not in the current build of ' + esc(title(t.doc)) + '.</p>';
    else if (!el) {
      box.innerHTML = '<p class="sr-hint">' + metaLine(t.doc) + '</p>';
      var h2 = src.querySelector('h2');
      if (h2) sectionEls(src, h2).slice(0, 4).forEach(function (x) { box.appendChild(cleanClone(x)); });
      else if (src.firstElementChild) box.appendChild(cleanClone(src.firstElementChild));
    } else sectionEls(src, el).slice(0, 4).forEach(function (x) { box.appendChild(cleanClone(x)); });
    D.peek.innerHTML = '<div class="pk-h"><span>Peek &middot; ' + esc(title(t.doc)) + (t.a && t.a !== 'top' ? ' <code>#' + esc(t.a) + '</code>' : '') +
      '</span><span class="sp"></span><button type="button" data-open>Open</button><button type="button" data-close aria-label="Close">&times;</button></div>';
    D.peek.appendChild(box);
    D.peek.setAttribute('data-to', to);
    D.peek.hidden = false;
    D.peek.scrollTop = 0;
    SR.typeset(box);
    SR.bus.emit('reader:peek', { to: to });
  }
  function closePeek() {
    if (!D.peek || D.peek.hidden) return;
    D.peek.hidden = true;
    D.peek.innerHTML = '';
  }

  /* ---------- navigation ---------- */
  function scrollToAnchor(id, a, flash) {
    var node = curNode();
    if (!a || a === 'top') {
      window.scrollTo(0, 0);
      S.pendingNav = { doc: id, a: '', until: performance.now() + 2500 };
      return;
    }
    var el = findAnchor(node, a);
    if (!el || !el.getClientRects().length) {
      window.scrollTo(0, 0);
      SR.toast('#' + a + ' is not in this build of ' + title(id));
      return;
    }
    var y = el.getBoundingClientRect().top + window.scrollY - D.hdr.offsetHeight - 16;
    window.scrollTo(0, Math.max(0, y));
    if (flash) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      setTimeout(function () { el.classList.remove('flash'); }, 1800);
    }
    S.pendingNav = { doc: id, a: a, until: performance.now() + 2500 };
  }
  function follow(to) {
    var t = parseTo(to);
    if (!doc(t.doc)) { SR.toast('No doc "' + t.doc + '" in this build'); return; }
    if (S.cur) {
      S.back.push({ doc: S.cur, y: window.scrollY });
      if (S.back.length > 30) S.back.shift();
    }
    updBack();
    closePeek();
    closeMenu(true);
    if (t.doc !== S.cur) showDoc(t.doc);
    scrollToAnchor(t.doc, t.a, true);
    SR.bus.emit('reader:follow', { to: to });
  }
  function back() {
    var b = S.back.pop();
    if (!b) return;
    if (b.doc !== S.cur) showDoc(b.doc);
    window.scrollTo(0, b.y);
    updBack();
  }
  function updBack() {
    if (!D.back) return;
    D.back.hidden = !S.back.length;
    D.back.textContent = '\u2190 Back' + (S.back.length > 1 ? ' (' + S.back.length + ')' : '');
  }

  /* ---------- tabs ---------- */
  function saveTabs() { SR.store.set('tabs', S.tabs); }
  function defaultDoc() {
    if (doc('nt-moves')) return 'nt-moves';
    var ids = docIds();
    for (var i = 0; i < ids.length; i++) if ((doc(ids[i]) || {}).kind === 'topic') return ids[i];
    return ids[0] || null;
  }
  function initialTabs() {
    var picks = ['nt-moves', 'dd-framing'].filter(function (x) { return !!doc(x); });
    if (!picks.length) picks = docIds().filter(function (x) { return (doc(x) || {}).kind === 'topic'; }).slice(0, 2);
    if (!picks.length && docIds().length) picks = [docIds()[0]];
    S.tabs = picks;
    saveTabs();
  }
  function ensureTab(id) {
    if (S.tabs.indexOf(id) >= 0) return;
    S.tabs.push(id);
    while (S.tabs.length > 6) S.tabs.splice(S.tabs[0] === id ? 1 : 0, 1);
    saveTabs();
  }
  function renderTabs() {
    if (!D.tabs) return;
    D.tabs.innerHTML = S.tabs.map(function (id) {
      return '<span class="sr-tab' + (id === S.cur ? ' on' : '') + '"><button type="button" data-tab="' + esc(id) + '" title="' + esc(title(id)) + '">' + esc(shortTitle(id)) + '</button>' +
        (S.tabs.length > 1 ? '<button type="button" class="x" data-close="' + esc(id) + '" aria-label="Close ' + esc(title(id)) + '">&times;</button>' : '') + '</span>';
    }).join('');
    /* Keep the active tab in view when the strip overflows; moves only the strip, never the page. */
    var on = D.tabs.querySelector('.sr-tab.on');
    if (on && D.tabs.scrollWidth > D.tabs.clientWidth) {
      var tr = D.tabs.getBoundingClientRect(), ar = on.getBoundingClientRect();
      if (ar.right > tr.right) D.tabs.scrollLeft += ar.right - tr.right + 8;
      else if (ar.left < tr.left) D.tabs.scrollLeft -= tr.left - ar.left + 8;
    }
  }
  function onTabsClick(e) {
    var c = e.target.closest('[data-close]');
    if (c) {
      var id = c.getAttribute('data-close'), i = S.tabs.indexOf(id);
      if (i < 0 || S.tabs.length < 2) return;
      S.tabs.splice(i, 1);
      saveTabs();
      if (id === S.cur) { var nx = S.tabs[Math.max(0, i - 1)]; showDoc(nx); window.scrollTo(0, S.scroll[nx] || 0); }
      else renderTabs();
      return;
    }
    var b = e.target.closest('[data-tab]');
    if (!b) return;
    var tid = b.getAttribute('data-tab');
    if (tid === S.cur) return;
    showDoc(tid);
    window.scrollTo(0, S.scroll[tid] || 0);
  }

  /* ---------- library and search ---------- */
  var TEX = [[/\\varphi|\\phi/g, '\u03c6'], [/\\equiv/g, '\u2261'], [/\\pmod\{([^}]*)\}/g, '(mod $1)'], [/\\pmod\s*(\w+)/g, '(mod $1)'],
    [/\\bmod/g, 'mod'], [/\\gcd/g, 'gcd'], [/\\cdot(?![a-z])/g, '\u00b7'], [/\\times/g, '\u00d7'], [/\\(?:leq|le)(?![a-z])/g, '\u2264'],
    [/\\(?:geq|ge)(?![a-z])/g, '\u2265'], [/\\(?:neq|ne)(?![a-z])/g, '\u2260'], [/\\nmid/g, '\u2224'], [/\\mid/g, '|'], [/\\in(?![a-z])/g, '\u2208'],
    [/\\to(?![a-z])/g, '\u2192'], [/\\mapsto/g, '\u21a6'], [/\\oplus/g, '\u2295'], [/\\(?:ldots|cdots|dots)/g, '\u2026'], [/\\infty/g, '\u221e'],
    [/\\sum/g, '\u03a3'], [/\\mathbb\{Z\}/g, '\u2124'], [/\\(?:operatorname|text|mathrm|mathbf|textbf|mathit)\{([^}]*)\}/g, '$1'],
    [/\\[,;:! ]/g, ' '], [/\\[a-zA-Z]+/g, ''], [/[{}$]/g, ''], [/\s+/g, ' ']];
  function detex(s) {
    s = String(s || '');
    TEX.forEach(function (r) { s = s.replace(r[0], r[1]); });
    return s.trim();
  }
  function searchIndex() {
    var ids = docIds(), sig = ids.map(sigOf).join(';');
    if (S.idx && S.idx.sig === sig) return S.idx.items;
    var items = [];
    ids.forEach(function (id) {
      items.push({ doc: id, a: '', text: title(id), plain: title(id).toLowerCase(), rank: 2 });
      [].forEach.call(sourceRoot(id).querySelectorAll('[data-a]'), function (el) {
        if (el.closest('.blk') || el.tagName === 'H1' || el.getAttribute('data-a') === 'top') return; /* the title entry covers it */
        var t = ownText(el, false);
        if (t) items.push({ doc: id, a: el.getAttribute('data-a'), text: t, plain: (t + ' ' + detex(t)).toLowerCase(), rank: el.tagName === 'H2' ? 1 : 0 });
      });
    });
    S.idx = { sig: sig, items: items };
    return items;
  }
  function search(q) {
    var terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    var out = searchIndex().filter(function (it) { return terms.every(function (t) { return it.plain.indexOf(t) >= 0; }); });
    out.sort(function (x, y) { return y.rank - x.rank; });
    return out.slice(0, 40).map(function (it) { return { doc: it.doc, a: it.a, text: it.text }; });
  }
  function highlight(s, terms) {
    var re = new RegExp(terms.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'ig');
    var out = '', last = 0, m;
    while ((m = re.exec(s)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }
  function snippet(text, q) {
    var plain = detex(text), low = plain.toLowerCase(), terms = q.toLowerCase().split(/\s+/).filter(Boolean), i = -1;
    terms.some(function (t) { i = low.indexOf(t); return i >= 0; });
    var start = Math.max(0, i - 50), end = Math.min(plain.length, Math.max(0, i) + 110);
    return (start > 0 ? '\u2026' : '') + highlight(plain.slice(start, end), terms) + (end < plain.length ? '\u2026' : '');
  }
  function openLibrary(q) {
    var sh = SR.sheet.open({ id: 'library', title: 'Library' });
    if (!sh.body.querySelector('.sr-search')) {
      sh.body.innerHTML = '<input type="search" class="sr-search" placeholder="Search all docs" aria-label="Search all docs" autocomplete="off" spellcheck="false">' +
        '<div class="sr-results"></div><div class="sr-libbody"></div>';
      sh.body.querySelector('.sr-search').addEventListener('input', function () { renderResults(sh); });
      sh.body.addEventListener('click', function (e) {
        var b = e.target.closest('[data-open]');
        if (!b) return;
        var to = b.getAttribute('data-open');
        sh.close();
        follow(to);
      });
    }
    if (q != null) sh.body.querySelector('.sr-search').value = q;
    renderResults(sh);
    renderLibBody(sh);
    return sh;
  }
  function renderResults(sh) {
    var inp = sh.body.querySelector('.sr-search'), box = sh.body.querySelector('.sr-results');
    if (!inp || !box) return;
    var q = inp.value.trim();
    if (q.length < 2) { box.innerHTML = ''; return; }
    var res = search(q);
    box.innerHTML = res.length ? '<div class="sr-kick">' + res.length + (res.length >= 40 ? '+' : '') + (res.length === 1 ? ' match' : ' matches') + '</div>' +
      res.map(function (r) {
        return '<button type="button" class="sr-res" data-open="' + esc(r.doc + (r.a ? '#' + r.a : '')) + '"><span class="t">' + esc(title(r.doc)) + '</span>' +
          (r.a && r.a !== 'top' ? ' <code>#' + esc(r.a) + '</code>' : '') + '<span class="s">' + snippet(r.text, q) + '</span></button>';
      }).join('') : '<p class="sr-hint">No matches in the current builds.</p>';
  }
  function renderLibBody(sh) {
    var box = sh.body.querySelector('.sr-libbody');
    if (!box) return;
    var c = content(), ids = docIds(), h = '';
    if (!ids.length) { box.innerHTML = '<p class="sr-hint">No docs loaded: content.js is missing from this build.</p>'; return; }
    var tests = (c && c.tests) || [];
    if (tests.length) {
      h += '<div class="sr-card"><div class="sr-kick">Tests</div>' + tests.map(function (t) {
        var days = Math.ceil((Date.parse(t.date + 'T00:00:00') - SR.now()) / DAY);
        return '<div>' + esc(TRACKS[t.track] || t.id || t.track) + ' &middot; ' + esc(t.date) + ' &middot; ' + (days >= 0 ? plural(days, 'day') + ' left' : 'past') + '</div>';
      }).join('') + '</div>';
    }
    var tracks = [];
    ids.forEach(function (id) { var tr = (doc(id) || {}).track || 'other'; if (tracks.indexOf(tr) < 0) tracks.push(tr); });
    tracks.forEach(function (tr) {
      h += '<div class="sr-libgrp sr-kick">' + esc(TRACKS[tr] || (tr === 'other' ? 'Other' : tr)) + '</div>';
      ['topic', 'basic', ''].forEach(function (kind) {
        ids.filter(function (id) { var d = doc(id) || {}; return (d.track || 'other') === tr && (kind ? d.kind === kind : d.kind !== 'topic' && d.kind !== 'basic'); }).forEach(function (id) {
          var d = doc(id) || {}, nm = Object.keys(S.marks).filter(function (k) { return S.marks[k].doc === id; }).length;
          var info = [d.kind === 'basic' ? 'Basic' : d.kind === 'topic' ? 'Topic' : 'Doc', d.area ? areaName(d.area) : '', 'build ' + version(id), nm ? plural(nm, 'mark') : ''].filter(Boolean).join(' \u00b7 ');
          h += '<button type="button" class="sr-librow' + (id === S.cur ? ' cur' : '') + '" data-open="' + esc(id) + '"><span class="t">' + esc(title(id)) + '</span><span class="sr-hint">' + esc(info) + '</span>' + stagePill(id) + '</button>';
        });
      });
    });
    h += '<p class="sr-hint">Stages and push levels are ' + esc(SR.LABEL_DEMO.toLowerCase()) + ' from the simulated engine. The docs are written by a model for Adit, not Adit\'s words.</p>';
    box.innerHTML = h;
  }

  /* ---------- Changes panel ---------- */
  function isRecognise(x) { return x && (x.kind === 'recognise' || /^recogni[sz]e/i.test(String(x.text || ''))); }
  function openChanges(id) {
    id = id || S.cur;
    if (!id) return null;
    var sh = SR.sheet.open({ id: 'changes', title: 'Changes \u00b7 ' + title(id) });
    sh.__doc = id;
    renderChanges(sh, id);
    return sh;
  }
  function renderChanges(sh, id) {
    var d = doc(id) || {}, list = changesOf(id).slice().sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    var rec = list.filter(isRecognise), rest = list.filter(function (x) { return !isRecognise(x); });
    var b = budgetOf(id), v = version(id), vs = versionsOf(id);
    function li(x) { return '<li><span class="when">' + (x.t ? esc(SR.fmt.dateTime(x.t)) : '') + '</span>' + esc(x.text || '') + '</li>'; }
    var h = '<div class="sr-card"><div class="sr-kick">Build</div><div>Build ' + v + (vs.length > 1 ? ' of ' + vs[vs.length - 1] : '') + '</div>' +
      (v > 1 && d.rebuiltFrom ? '<p class="sr-hint">Rebuilt from its prerequisites: ' + esc(d.rebuiltFrom) + '</p>' : '') +
      (vs.length > 1 ? '<div class="sr-row">' + vs.map(function (x) { return '<button type="button" data-ver="' + x + '"' + (x === v ? ' class="on" disabled' : '') + '>Show build ' + x + '</button>'; }).join('') + '</div>' : '') + '</div>';
    h += '<div class="sr-card"><div class="sr-kick">Rewrite budget</div><div>' + b.used + ' of ' + b.max + ' rewrites used on this doc</div>' +
      '<p class="sr-hint">A lost mark on a passage first gets the basics it rests on and an attempt box. A rewrite can be requested only after a day still lost with ink in the box. A gap in a basic rebuilds the whole basic, free.</p></div>';
    h += '<div class="sr-card"><div class="sr-kick">Recognise list</div>' + (rec.length ? '<ul class="sr-log">' + rec.map(li).join('') + '</ul>' :
      '<p class="sr-hint">No cues yet. A cue lands here when a settled problem took a method you knew but did not call.</p>') + '</div>';
    h += '<div class="sr-card"><div class="sr-kick">Log</div>' + (rest.length ? '<ul class="sr-log">' + rest.map(li).join('') + '</ul>' : '<p class="sr-hint">No rebuilds or rewrites yet.</p>') + '</div>';
    var mk = Object.keys(S.marks).filter(function (k) { return S.marks[k].doc === id; }).map(function (k) { return S.marks[k]; }).sort(function (x, y) { return (x.t || 0) - (y.t || 0); });
    h += '<div class="sr-card"><div class="sr-kick">Marks the teach pass would read</div>' + (mk.length ? '<ul class="sr-log">' + mk.map(function (m) {
      return '<li><code>#' + esc(m.a) + '</code> ' + esc(m.verb) + (m.verb === 'lost' && m.state ? ' (' + esc(markInfo(m).label) + ')' : '') + ' <span class="when">' + esc(SR.fmt.dateTime(m.t || 0)) + '</span></li>';
    }).join('') + '</ul>' : '<p class="sr-hint">No marks on this doc.</p>') + '</div>';
    sh.body.innerHTML = h;
    [].forEach.call(sh.body.querySelectorAll('[data-ver]'), function (btn) {
      btn.addEventListener('click', function () {
        var nv = +btn.getAttribute('data-ver');
        setVersion(id, nv);
        if (id === S.cur) rerenderCurrent(null, false); else dropCache(id);
        renderChanges(sh, id);
        SR.toast('Showing build ' + nv + ' of ' + title(id));
      });
    });
  }

  /* ---------- Demo drawer ---------- */
  function openDemo() {
    var sh = SR.sheet.open({ id: 'demo', title: 'Demo controls' });
    renderDemo(sh);
    return sh;
  }
  function renderDemo(sh) {
    var area = S.demoArea, ok = !!SR.engine;
    var r = has('rating') ? ecall('rating', area) : null, push = has('inPush') ? ecall('inPush', area) : null;
    var h = '<p><span class="sr-demo">' + esc(SR.LABEL_DEMO) + '</span></p>' +
      '<div class="sr-card"><div class="sr-kick">Simulated clock</div><div class="sr-row"><b id="sr-demo-clock">' + esc(SR.fmt.dateTime(SR.now())) + '</b><span class="sp"></span>' +
      '<button type="button" data-demo="day"' + (has('advanceDays') ? '' : ' disabled') + '>Advance a day</button></div></div>' +
      '<div class="sr-card"><div class="sr-kick">Area</div><div class="sr-row sr-areas">' + AREAS.map(function (a) {
        return '<button type="button" data-area="' + a[0] + '"' + (a[0] === area ? ' class="sel"' : '') + ' title="' + esc(a[1]) + '">' + a[0] + '</button>';
      }).join('') + '</div><p class="sr-hint">' + esc(areaName(area)) + (r != null ? ' &middot; r ' + esc(SR.fmt.num(r)) : '') +
      (push != null ? ' &middot; ' + (push ? 'push mode' : 'not in push mode') : '') + '</p><div class="sr-row">' +
      '<button type="button" data-demo="comfy"' + (has('makeComfortable') ? '' : ' disabled') + '>Make comfortable</button>' +
      '<button type="button" data-demo="miss"' + (has('simulateMisses') ? '' : ' disabled') + '>Simulate 2 misses</button>' +
      '<button type="button" data-demo="holds"' + (has('simulateHolds') ? '' : ' disabled') + '>Simulate 3 clean holds</button></div>' +
      '<p class="sr-hint">Comfortable: every basic of the area at stage 4 and push 3 (push mode). Misses ease the next pick one step; three clean holds open one reach pick.</p></div>' +
      '<div class="sr-card"><div class="sr-kick">Reset</div><p class="sr-hint">Clears ink, marks, ratings, stages, rewrites, builds and the clock in this browser.</p>' +
      '<button type="button" class="warn" data-demo="reset">Reset demo</button></div>' +
      (ok ? '' : '<p class="sr-hint">engine.js is not loaded in this build, so the clock, area and rating controls are off.</p>');
    sh.body.innerHTML = h;
    sh.body.querySelector('[data-demo="day"]').addEventListener('click', function () { ecall('advanceDays', 1); SR.toast('Clock: ' + SR.fmt.dateTime(SR.now())); renderDemo(sh); onClockMaybe(); });
    sh.body.querySelector('[data-demo="comfy"]').addEventListener('click', function () { ecall('makeComfortable', S.demoArea); SR.toast(areaName(S.demoArea) + ': comfortable'); renderDemo(sh); });
    sh.body.querySelector('[data-demo="miss"]').addEventListener('click', function () { ecall('simulateMisses', S.demoArea, 2); SR.toast(areaName(S.demoArea) + ': 2 misses'); renderDemo(sh); });
    sh.body.querySelector('[data-demo="holds"]').addEventListener('click', function () { ecall('simulateHolds', S.demoArea, 3); SR.toast(areaName(S.demoArea) + ': 3 clean holds, one reach pick open'); renderDemo(sh); });
    [].forEach.call(sh.body.querySelectorAll('[data-area]'), function (b) { b.addEventListener('click', function () { S.demoArea = b.getAttribute('data-area'); renderDemo(sh); }); });
    SR.twoTap(sh.body.querySelector('[data-demo="reset"]'), 'Tap again to reset', resetDemo);
  }
  function onClockMaybe() {
    var node = curNode();
    if (node) [].forEach.call(node.querySelectorAll('.sr-scaffold'), updateScaffoldStatus);
    updHeader();
  }
  function resetDemo() {
    SR.sheet.closeAll();
    closePeek();
    S.menuKey = null;
    Object.keys(S.cache).forEach(dropCache);
    srcCache = {};
    S.idx = null;
    var theme = S.theme;
    SR.store.clear();
    SR.store.set('theme', theme);
    quietly(function () { ecall('reset'); });
    S.marks = {}; S.ink = {}; S.back = []; S.scroll = {}; S.cur = null; S.orphHtml = ''; S.ovlHtml = '';
    D.orph.innerHTML = '';
    initialTabs();
    var id = defaultDoc();
    if (id) showDoc(id);
    window.scrollTo(0, 0);
    updBack();
    SR.bus.emit('demo:reset');
    SR.toast('Demo reset');
  }

  /* ---------- panels from panel-map.js (Today, Map) ---------- */
  function openPanel(name) {
    if (name === 'library') return openLibrary();
    if (name === 'changes') return openChanges();
    if (name === 'demo') return openDemo();
    /* Today and Map live in panel-map.js (SR.panels). */
    var P = SR.panels;
    if (P && typeof P[name] === 'function') { P[name](); return null; }
    return SR.sheet.open({ id: 'panel-' + name, title: name === 'today' ? 'Today' : name === 'map' ? 'Map' : name,
      html: '<p class="sr-hint">panel-map.js is not loaded in this build.</p>' });
  }

  /* ---------- header, theme, engine changes ---------- */
  function updHeader() {
    if (!D.undo) return;
    D.undo.disabled = !S.cur || !inkList().length;
    var n = S.cur ? changesOf(S.cur).length : 0;
    D.changes.textContent = n ? 'Changes (' + n + ')' : 'Changes';
    D.clock.textContent = has('now') ? 'Simulated clock: ' + SR.fmt.dateTime(SR.now()) : '';
  }
  function applyTheme(mode) {
    if (['auto', 'light', 'dark'].indexOf(mode) < 0) mode = 'auto';
    S.theme = mode;
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    if (D.theme) D.theme.textContent = mode === 'auto' ? 'Theme: auto' : mode === 'light' ? 'Theme: light' : 'Theme: dark';
    SR.store.set('theme', mode);
    SR.ink.redrawAll();
    SR.bus.emit('theme', mode);
  }
  function refreshSheets() {
    var lib = SR.sheet.get('library');
    if (lib) renderLibBody(lib);
    var ch = SR.sheet.get('changes');
    if (ch) renderChanges(ch, ch.__doc || S.cur);
    var dm = SR.sheet.get('demo');
    if (dm) { var c = dm.body.querySelector('#sr-demo-clock'); if (c) c.textContent = SR.fmt.dateTime(SR.now()); }
  }
  function onEngineChange(data) {
    if (quiet) return;
    Object.keys(S.cache).forEach(function (id) { if (id !== S.cur && S.cache[id].sig !== sigOf(id)) dropCache(id); });
    var e = curEntry();
    if (e && e.sig !== sigOf(S.cur)) rerenderCurrent(null, false);
    if (data && data.type === 'clock') recheckMarks();
    refreshSheets();
    onClockMaybe();
  }

  /* ---------- pointer plumbing: long-press peek, link taps, chip taps ---------- */
  var lp = null, lastType = 'mouse', suppressUntil = 0, suppressRef = null;
  function cancelLP() { if (lp) { clearTimeout(lp.timer); lp = null; } }
  function onAnyDown(e) {
    lastType = e.pointerType || 'mouse';
    var t = e.target;
    if (D.peek && !D.peek.hidden && !(t && t.closest && t.closest('#sr-peek'))) closePeek();
    if (lastType === 'pen' || (lastType === 'mouse' && e.button !== 0)) return;
    var r = t && t.closest ? t.closest('.ref[data-to]') : null;
    if (!r || r.closest('#sr-peek')) return;
    cancelLP();
    lp = { pid: e.pointerId, x: e.clientX, y: e.clientY, ref: r, fired: false };
    lp.timer = setTimeout(function () {
      if (!lp) return;
      lp.fired = true;
      openPeek(lp.ref.getAttribute('data-to'), lp.ref);
    }, 450);
  }
  /* After a long press opened a peek, the click that may follow on the same link must not navigate.
     Only that link is suppressed, so a quick tap on the peek's Open button or another link still works. */
  function lpEnd(e) {
    if (lp && e.pointerId === lp.pid) {
      if (lp.fired) { suppressUntil = performance.now() + 700; suppressRef = lp.ref; }
      cancelLP();
    }
  }
  /* The Pencil writes over the page text, links included, so there a pen tap never follows a link. Where it
     cannot write (panels, the peek, blocks and scaffolds marked no-ink) a pen tap on a link follows it like
     any button next to it. */
  function penWrites(r) { return !!D.stack && D.stack.contains(r) && !r.closest(INK_SKIP); }
  function onRefClick(e) {
    var t = e.target, r = t && t.closest ? t.closest('.ref[data-to]') : null;
    if (!r) return;
    e.preventDefault();
    if (lastType === 'pen' && penWrites(r)) return;
    if (r.closest('.sr-sheet')) SR.sheet.closeAll(true);
    follow(r.getAttribute('data-to'));
  }
  function onStackClick(e) {
    var t = e.target;
    if (!t || !t.closest || t.closest('.ref[data-to]')) return;
    var mb = t.closest('.markmenu [data-verb]');
    if (mb) {
      var key = mb.closest('.markmenu').getAttribute('data-key'), verb = mb.getAttribute('data-verb');
      if (verb === 'clear') clearMark(key); else setMark(key, verb);
      return;
    }
    if (t.closest('.markmenu')) return;
    var mk = t.closest('.mark[data-key]');
    if (mk) {
      var k = mk.getAttribute('data-key');
      if (S.menuKey === k) closeMenu(); else openMenu(k);
      return;
    }
    var act = t.closest('[data-act]');
    if (act && (D.ovl.contains(act) || D.orph.contains(act))) { doAct(act.getAttribute('data-act'), act.getAttribute('data-a')); return; }
    if (S.menuKey) closeMenu();
  }
  function doAct(kind, a) {
    var L = inkList(), A = S.anchors[a];
    if (kind === 'keep') {
      L.forEach(function (st) { if (st.at && st.at.a === a && A) st.at.rev = A.rev; });
      SR.toast('Kept: the ink now belongs to the new text');
    } else if (kind === 'del') {
      S.ink[S.cur] = L.filter(function (st) { return !(st.at && st.at.a === a && A && st.at.rev !== A.rev); });
      SR.toast('Deleted the strokes on the old text');
    } else if (kind === 'odel') {
      S.ink[S.cur] = L.filter(function (st) { return !(st.at && st.at.a === a); });
      SR.toast('Deleted the orphaned strokes');
    }
    saveInk(S.cur);
    relayout();
  }

  /* Every .ref[data-to] anywhere (docs, peek, scaffolds, blocks, panels) becomes a focusable link:
     keyboard users can reach it, and touch targeting treats it as interactive. */
  function linkify(root) {
    if (!root || root.nodeType !== 1) return;
    var list = root.matches && root.matches('.ref[data-to]') ? [root] : [];
    list = list.concat([].slice.call(root.querySelectorAll ? root.querySelectorAll('.ref[data-to]') : []));
    list.forEach(function (r) {
      if (!r.hasAttribute('tabindex')) r.setAttribute('tabindex', '0');
      if (!r.hasAttribute('role') && !r.hasAttribute('href')) r.setAttribute('role', 'link');
    });
  }
  function watchLinks() {
    linkify(document.body);
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) linkify(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- shell ---------- */
  function buildShell() {
    var app = document.getElementById('sr-app');
    if (!app) { app = document.createElement('div'); app.id = 'sr-app'; document.body.appendChild(app); }
    app.innerHTML =
      '<header class="sr-hdr gut" id="sr-hdr">' +
        '<span class="sr-brand">Study reader<span class="tag">Demo</span></span>' +
        '<button type="button" id="sr-lib">Library</button>' +
        '<nav class="sr-tabs" id="sr-tabs" aria-label="Open docs"></nav>' +
        '<button type="button" id="sr-back" hidden>&larr; Back</button>' +
        '<span class="sp"></span>' +
        '<span class="sr-tools">' +
          '<button type="button" id="sr-today">Today</button>' +
          '<button type="button" id="sr-map">Map</button>' +
          '<button type="button" id="sr-changes">Changes</button>' +
          '<button type="button" id="sr-undo">Undo ink</button>' +
          '<button type="button" id="sr-demo">Demo</button>' +
          '<button type="button" id="sr-theme">Theme: auto</button>' +
        '</span>' +
      '</header>' +
      '<main class="sr-main gut" id="sr-main">' +
        '<div class="sr-top"><p class="sr-by">' + esc(SR.LABEL_MODEL) + '</p><span class="sr-demo">' + esc(SR.LABEL_DEMO) + '</span><span class="sr-hint" id="sr-clock"></span></div>' +
        '<p class="hint">Finger: tap a blue link to go there, hold one to peek, scroll freely. Pencil or mouse: write anywhere; on the page text the Pencil writes over links instead of following them. ' +
        'The dots in the right margin mark a passage lost, easy or forgot.</p>' +
        '<div id="sr-wrap"><div id="sr-stack"><div id="sr-dochost"></div><div id="sr-orph"></div><div id="sr-ovl"></div></div></div>' +
      '</main>' +
      '<div class="sr-park" id="sr-park" aria-hidden="true"></div>' +
      '<div id="sr-peek" hidden></div>';
    function $(id) { return document.getElementById(id); }
    D.app = app; D.hdr = $('sr-hdr'); D.main = $('sr-main'); D.wrap = $('sr-wrap'); D.stack = $('sr-stack'); D.host = $('sr-dochost');
    D.orph = $('sr-orph'); D.ovl = $('sr-ovl'); D.park = $('sr-park'); D.peek = $('sr-peek'); D.tabs = $('sr-tabs'); D.back = $('sr-back');
    D.undo = $('sr-undo'); D.changes = $('sr-changes'); D.theme = $('sr-theme'); D.clock = $('sr-clock');
  }
  function wire() {
    D.tabs.addEventListener('click', onTabsClick);
    D.back.addEventListener('click', back);
    document.getElementById('sr-lib').addEventListener('click', function () { openLibrary(); });
    document.getElementById('sr-today').addEventListener('click', function () { openPanel('today'); });
    document.getElementById('sr-map').addEventListener('click', function () { openPanel('map'); });
    D.changes.addEventListener('click', function () { openChanges(); });
    document.getElementById('sr-demo').addEventListener('click', function () { openDemo(); });
    D.undo.addEventListener('click', function () {
      if (!docInk || !inkList().length) { SR.toast('No ink on this doc'); return; }
      docInk.undo();
      relayout();
    });
    D.theme.addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      applyTheme(order[(order.indexOf(S.theme) + 1) % 3]);
    });
    D.peek.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('[data-close]')) { closePeek(); return; }
      if (t.closest('[data-open]')) { var to = D.peek.getAttribute('data-to'); closePeek(); SR.sheet.closeAll(true); follow(to); }
    });
    document.addEventListener('pointerdown', onAnyDown, true);
    window.addEventListener('pointermove', function (e) {
      if (lp && e.pointerId === lp.pid && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLP();
    }, { passive: true });
    window.addEventListener('pointerup', lpEnd, true);
    window.addEventListener('pointercancel', lpEnd, true);
    document.addEventListener('click', function (e) {
      if (!suppressRef) return;
      var hit = performance.now() < suppressUntil && e.target && e.target.nodeType === 1 && suppressRef.contains(e.target);
      suppressRef = null;
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    document.addEventListener('click', onRefClick);
    D.stack.addEventListener('click', onStackClick);
    /* Escape closes the topmost thing only. The peek sits above every sheet, so it takes the key in the capture
       phase and marks it handled; core.js's sheet handler then leaves the panel under the peek open. */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !D.peek || D.peek.hidden) return;
      closePeek();
      e.preventDefault();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (!e.defaultPrevented && !SR.sheet.top()) closeMenu(); return; }
      var t = e.target;
      if (e.key === 'Enter' && t && t.matches && t.matches('.ref[data-to]')) {
        e.preventDefault();
        if (t.closest('.sr-sheet')) SR.sheet.closeAll(true);
        follow(t.getAttribute('data-to'));
      }
    });
    var lastW = document.documentElement.clientWidth, rt = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (document.documentElement.clientWidth !== lastW) { lastW = document.documentElement.clientWidth; relayout(); }
      }, 120);
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(requestRelayout).observe(D.host);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(requestRelayout);
    SR.bus.on('engine:change', onEngineChange);
    SR.bus.on('typeset', requestRelayout);
    SR.bus.on('theme', function () { if (docInk) docInk.redraw(); });
    SR.bus.on('blocks:register', function (type) {
      Object.keys(S.cache).forEach(function (id) {
        var e = S.cache[id];
        [].forEach.call(e.node.querySelectorAll('.blk[data-block="' + cssq(type) + '"]'), function (el) {
          if (el.__srBlock && el.__srBlock.missing) { el.__srBlock = null; el.innerHTML = ''; }
        });
        if (e.mounted) SR.blocks.mountAll(e.node, blockCtx(id));
      });
    });
  }

  R.init = function () {
    if (R._inited) return;
    R._inited = true;
    buildShell();
    applyTheme(SR.store.get('theme', 'auto'));
    S.marks = SR.store.get('marks', {}) || {};
    S.tabs = (SR.store.get('tabs', []) || []).filter(function (id) { return !!doc(id); });
    docInk = SR.ink.create(D.stack, {
      overlay: true,
      surface: D.stack,
      width: W,
      height: function () { return S.H || 1; },
      strokes: inkList,
      color: function () { return '--ink'; },
      place: placeStroke,
      ignore: inkIgnore,
      readOnly: function () { return !S.cur; },
      onStroke: anchorStroke,
      onChange: function () { if (S.cur) saveInk(S.cur); paintOverlay(); updHeader(); }
    });
    wire();
    watchLinks();
    if (!docIds().length) {
      D.host.innerHTML = '<div class="page"><div class="sr-empty">No docs loaded: content.js is missing from this build.</div></div>';
      relayout();
      return;
    }
    if (!S.tabs.length) initialTabs();
    var start = SR.store.get('doc');
    if (!doc(start)) start = defaultDoc();
    showDoc(start);
    updBack();
    recheckMarks();
  };

  /* ---------- public API (see INTERFACES.md) ---------- */
  /* open/follow from panels and blocks: sheets close (except keepOnNav ones) so the doc is visible. */
  R.open = function (docId, anchor) { SR.sheet.closeAll(true); follow(docId + (anchor ? '#' + anchor : '')); };
  R.follow = function (to) { SR.sheet.closeAll(true); follow(to); };
  R.show = showDoc;
  R.back = back;
  R.current = function () { return S.cur; };
  R.peek = function (ref, anchorEl) { openPeek(ref, anchorEl); };
  R.closePeek = closePeek;
  R.relayout = requestRelayout;
  R.rerender = function (docId) { if (!docId || docId === S.cur) rerenderCurrent(null, false); else dropCache(docId); };
  R.openPanel = openPanel;
  R.marks = function () { return JSON.parse(JSON.stringify(S.marks)); };
  R.setMark = setMark;
  R.clearMark = clearMark;
  R.ink = function () { return docInk; };
  R.inkOf = function (docId) { return (S.ink[docId] || loadInk(docId)).slice(); };
  R.anchors = function () { return S.anchors; };
  R.version = version;
  R.setVersion = function (docId, v) { setVersion(docId, v); if (docId === S.cur) rerenderCurrent(null, true); else dropCache(docId); };
  R.title = title;
  R.docs = docIds;
  R.ctx = blockCtx;
  R.search = search;
  R.drill = openDrill;
  R.reset = resetDemo;
  R.theme = applyTheme;
})();

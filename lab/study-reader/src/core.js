/* core.js: SR.store, SR.bus, SR.typeset, SR.css, SR.esc, SR.twoTap, SR.ink, SR.blocks,
   plus small UI helpers every file may use: SR.toast, SR.sheet, SR.style, SR.fmt, SR.now, SR.el.
   Plain browser script, no modules. Everything hangs off window.SR. */
(function () {
  'use strict';
  var SR = window.SR = window.SR || {};
  var PFX = 'lab-study-reader-';
  SR.LABEL_MODEL = "Written by a model for Adit. Not Adit's words.";
  SR.LABEL_DEMO = 'Demo data';

  /* MathJax config. It has to exist before the async MathJax script (the last tag in the page) runs.
     startup.typeset:false: nothing is typeset until SR.typeset asks; pageReady tells SR when MathJax is usable.
     enableMenu:false: no context menu, so formulas carry no tabindex or menu listeners; otherwise a finger
     tap beside a link can be retargeted onto a nearby formula, which is focusable and the link is not. */
  if (!window.MathJax) {
    window.MathJax = {
      tex: { inlineMath: [['$', '$'], ['\\(', '\\)']] },
      svg: { fontCache: 'global' },
      options: { enableMenu: false },
      startup: {
        typeset: false,
        pageReady: function () {
          return window.MathJax.startup.defaultPageReady().then(function () {
            if (window.SR && typeof window.SR._mathReady === 'function') window.SR._mathReady();
          });
        }
      }
    };
  }

  /* ---------------- store: JSON in localStorage under the prefix, with an in-memory copy so the
     page keeps working for the session when localStorage throws (sandboxed iframe, private mode). */
  var mem = Object.create(null);
  var lsOK = (function () {
    try { var k = PFX + '__probe'; window.localStorage.setItem(k, '1'); window.localStorage.removeItem(k); return true; }
    catch (e) { return false; }
  })();
  function lsKeys() {
    var out = [];
    if (!lsOK) return out;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PFX) === 0) out.push(k.slice(PFX.length));
      }
    } catch (e) {}
    return out;
  }
  SR.store = {
    prefix: PFX,
    persistent: lsOK,
    get: function (k, d) {
      var dflt = d === undefined ? null : d, raw = null;
      if (Object.prototype.hasOwnProperty.call(mem, k)) raw = mem[k];
      else if (lsOK) { try { raw = localStorage.getItem(PFX + k); } catch (e) { raw = null; } }
      if (raw == null) return dflt;
      try { return JSON.parse(raw); } catch (e) { return dflt; }
    },
    set: function (k, v) {
      var raw;
      try { raw = JSON.stringify(v); } catch (e) { return false; }
      if (raw === undefined) { SR.store.del(k); return true; }
      mem[k] = raw;
      if (lsOK) { try { localStorage.setItem(PFX + k, raw); } catch (e) { return false; } }
      return true;
    },
    del: function (k) {
      delete mem[k];
      if (lsOK) { try { localStorage.removeItem(PFX + k); } catch (e) {} }
    },
    keys: function () {
      var seen = Object.create(null), out = [];
      Object.keys(mem).concat(lsKeys()).forEach(function (k) { if (!seen[k]) { seen[k] = 1; out.push(k); } });
      return out;
    },
    clear: function () {
      var ks = lsKeys();
      mem = Object.create(null);
      if (lsOK) ks.forEach(function (k) { try { localStorage.removeItem(PFX + k); } catch (e) {} });
    }
  };

  /* ---------------- bus */
  var handlers = Object.create(null);
  SR.bus = {
    on: function (evt, fn) {
      (handlers[evt] = handlers[evt] || []).push(fn);
      return function () { SR.bus.off(evt, fn); };
    },
    off: function (evt, fn) {
      var l = handlers[evt]; if (!l) return;
      var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    /* Returns how many handlers ran. A throwing handler is logged and does not stop the others. */
    emit: function (evt, data) {
      var l = handlers[evt]; if (!l || !l.length) return 0;
      var n = 0;
      l.slice().forEach(function (fn) {
        try { fn(data, evt); n++; } catch (e) { console.error('[SR] handler for "' + evt + '" failed:', e); }
      });
      return n;
    }
  };

  /* ---------------- small helpers */
  SR.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  SR.css = function (name) {
    if (!name) return '';
    name = String(name);
    if (name.indexOf('--') !== 0) name = '--' + name;
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) { return ''; }
  };
  SR.el = function (html) {
    var t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild;
  };
  SR.style = function (id, cssText) {
    var sid = 'sr-style-' + id, el = document.getElementById(sid);
    if (!el) { el = document.createElement('style'); el.id = sid; document.head.appendChild(el); }
    if (el.textContent !== cssText) el.textContent = cssText;
    return el;
  };
  SR.now = function () {
    var e = SR.engine;
    if (e && typeof e.now === 'function') {
      try { var t = +e.now(); if (t > 0) return t; } catch (er) { console.error('[SR] engine.now failed:', er); }
    }
    return Date.now();
  };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function z(x) { return (x < 10 ? '0' : '') + x; }
  SR.fmt = {
    date: function (ms) { var d = new Date(ms); return MON[d.getMonth()] + ' ' + d.getDate(); },
    dateTime: function (ms) { var d = new Date(ms); return MON[d.getMonth()] + ' ' + d.getDate() + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); },
    iso: function (ms) { var d = new Date(ms); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); },
    dur: function (ms) { ms = Math.max(0, ms || 0); var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + z(s % 60); },
    num: function (x, d) { x = +x; if (!isFinite(x)) return '-'; return x.toFixed(d == null ? 2 : d); }
  };

  /* ---------------- typeset: queue until MathJax is ready, then typeset in order */
  var mathReady = false, pending = [], chain = Promise.resolve();
  /* The connected elements of a batch, minus any that sit inside another one of the batch. One MathJax
     call over an element and its own ancestor processes the inner math twice and throws (splitText), so
     a block that queues itself inside the doc the reader queued is covered by the doc's pass instead. */
  function outermost(els) {
    var live = [];
    els.forEach(function (x) { if (x && x.isConnected && live.indexOf(x) < 0) live.push(x); });
    return live.filter(function (x) {
      for (var i = 0; i < live.length; i++) if (live[i] !== x && live[i].contains(x)) return false;
      return true;
    });
  }
  function runTypeset(els) {
    chain = chain.then(function () {
      var live = outermost(els);
      if (!live.length || !window.MathJax || typeof window.MathJax.typesetPromise !== 'function') return;
      return window.MathJax.typesetPromise(live);
    }).catch(function (e) {
      console.warn('[SR] MathJax typeset failed:', e);
    }).then(function () {
      SR.bus.emit('typeset', els);
    });
    return chain;
  }
  SR.typeset = function (el) {
    if (!el) return Promise.resolve();
    if (!mathReady) {
      return new Promise(function (res) {
        var p = null;
        for (var i = 0; i < pending.length; i++) if (pending[i].el === el) { p = pending[i]; break; }
        if (!p) { p = { el: el, waiters: [] }; pending.push(p); }
        p.waiters.push(res);
      });
    }
    return runTypeset([el]);
  };
  SR.mathReady = function () { return mathReady; };
  SR._mathReady = function () {
    if (mathReady) return;
    mathReady = true;
    var list = pending; pending = [];
    if (list.length) {
      runTypeset(list.map(function (p) { return p.el; })).then(function () {
        list.forEach(function (p) { p.waiters.forEach(function (f) { f(); }); });
      });
    }
    SR.bus.emit('math:ready');
  };

  /* ---------------- two-tap confirmation: native dialogs never show in the artifact frame */
  SR.twoTap = function (btn, armedText, fn, ms) {
    var timer = null, base = null;
    function disarm() {
      clearTimeout(timer); timer = null;
      btn.classList.remove('armed');
      if (base !== null) btn.textContent = base;
      base = null;
    }
    function onClick(e) {
      if (btn.disabled) return;
      if (btn.classList.contains('armed')) { disarm(); fn(e); return; }
      base = btn.textContent;
      btn.classList.add('armed');
      btn.textContent = armedText || 'Tap again to confirm';
      timer = setTimeout(disarm, ms || 3500);
    }
    btn.addEventListener('click', onClick);
    return { disarm: disarm, destroy: function () { disarm(); btn.removeEventListener('click', onClick); } };
  };

  /* ---------------- toast */
  var toastTimer = 0;
  SR.toast = function (msg, ms) {
    var t = document.getElementById('sr-toast');
    if (!t) { t = document.createElement('div'); t.id = 'sr-toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 3600);
  };

  /* ---------------- sheets: right-hand panels stacked above the page */
  var sheets = [];
  function sheetById(id) { for (var i = 0; i < sheets.length; i++) if (id && sheets[i].id === id) return sheets[i]; return null; }
  SR.sheet = {
    /* o: {id, title, html | node, wide, className, onClose, keepOnNav} -> {id, el, body, close(), setTitle(t), setBody(htmlOrNode)} */
    open: function (o) {
      o = o || {};
      var ex = sheetById(o.id);
      if (ex) {
        if (o.title != null) ex.setTitle(o.title);
        if (o.html != null || o.node) ex.setBody(o.node || o.html);
        if (o.onClose) ex.onClose = o.onClose;
        return ex;
      }
      var depth = sheets.length;
      var bd = document.createElement('div');
      bd.className = 'sr-backdrop';
      bd.style.zIndex = String(60 + depth * 2);
      var el = document.createElement('aside');
      el.className = 'sr-sheet' + (o.wide ? ' wide' : '') + (o.className ? ' ' + o.className : '');
      el.style.zIndex = String(61 + depth * 2);
      el.setAttribute('role', 'dialog');
      if (o.id) el.setAttribute('data-sheet', o.id);
      el.innerHTML = '<div class="sr-sheet-h"><span class="sr-sheet-t"></span><span class="sp"></span><button type="button" class="sr-sheet-x">Close</button></div><div class="sr-sheet-b"></div>';
      var body = el.querySelector('.sr-sheet-b');
      var api = {
        id: o.id || null, el: el, body: body, keepOnNav: !!o.keepOnNav, onClose: o.onClose || null, closed: false,
        setTitle: function (t) { el.querySelector('.sr-sheet-t').textContent = t || ''; el.setAttribute('aria-label', t || 'Panel'); },
        setBody: function (x) {
          if (x == null) return;
          if (typeof x === 'string') { body.innerHTML = x; SR.typeset(body); }
          else { body.innerHTML = ''; body.appendChild(x); }
        },
        close: function () {
          if (api.closed) return;
          api.closed = true;
          var i = sheets.indexOf(api); if (i >= 0) sheets.splice(i, 1);
          bd.remove(); el.remove();
          if (typeof api.onClose === 'function') { try { api.onClose(); } catch (e) { console.error(e); } }
          SR.bus.emit('sheet:close', api.id);
        }
      };
      api.setTitle(o.title || '');
      if (o.node || o.html != null) api.setBody(o.node || o.html);
      bd.addEventListener('click', api.close);
      el.querySelector('.sr-sheet-x').addEventListener('click', api.close);
      document.body.appendChild(bd);
      document.body.appendChild(el);
      sheets.push(api);
      SR.bus.emit('sheet:open', api.id);
      return api;
    },
    get: sheetById,
    top: function () { return sheets[sheets.length - 1] || null; },
    all: function () { return sheets.slice(); },
    close: function (id) { var s = id ? sheetById(id) : sheets[sheets.length - 1]; if (s) s.close(); },
    closeAll: function (exceptKeep) {
      sheets.slice().reverse().forEach(function (s) { if (!(exceptKeep && s.keepOnNav)) s.close(); });
    }
  };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !sheets.length || e.defaultPrevented) return;   /* handled above a sheet (the reader's peek) */
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return; /* an editor keeps its Escape */
    sheets[sheets.length - 1].close();
  });

  /* ---------------- ink */
  var inks = [];
  function resolveColor(c, fallback) {
    if (c == null || c === '') c = fallback || '--ink';
    c = String(c).trim();
    var m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(c);
    if (m) return SR.css(m[1]) || (m[2] ? m[2].trim() : '') || '#888';
    if (c.slice(0, 2) === '--') return SR.css(c) || '#888';
    return c;
  }
  /* Quadratic curves through the midpoints, offset by (dx, dy). One point draws a dot. */
  function drawPath(ctx, p, dx, dy) {
    var n = p ? p.length : 0;
    if (!n) return;
    dx = dx || 0; dy = dy || 0;
    ctx.beginPath();
    if (n === 1) { ctx.arc(p[0][0] + dx, p[0][1] + dy, Math.max(0.6, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill(); return; }
    ctx.moveTo(p[0][0] + dx, p[0][1] + dy);
    if (n === 2) ctx.lineTo(p[1][0] + dx, p[1][1] + dy);
    else {
      ctx.lineTo((p[0][0] + p[1][0]) / 2 + dx, (p[0][1] + p[1][1]) / 2 + dy);
      for (var i = 1; i < n - 1; i++) {
        ctx.quadraticCurveTo(p[i][0] + dx, p[i][1] + dy, (p[i][0] + p[i + 1][0]) / 2 + dx, (p[i][1] + p[i + 1][1]) / 2 + dy);
      }
      ctx.lineTo(p[n - 1][0] + dx, p[n - 1][1] + dy);
    }
    ctx.stroke();
  }
  function validStroke(s) { return s && Array.isArray(s.p); }

  /* SR.ink.create(container, opts) -> api. See INTERFACES.md for every option. Two modes:
     fit (default): a .sr-ink box is appended to container; the paper (opts.width wide, opts.height tall)
       is scaled to the box width.
     overlay: the canvas is laid over container, which is already in paper units (the reader's page
       stack); pointer events are read from opts.surface (default container). */
  function create(container, opts) {
    opts = opts || {};
    var W = +opts.width > 0 ? +opts.width : 800;
    var overlay = !!opts.overlay;
    var canvas = document.createElement('canvas');
    canvas.className = 'sr-ink-canvas';
    var wrap;
    if (overlay) {
      wrap = container;
      canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2';
      container.appendChild(canvas);
    } else {
      wrap = document.createElement('div');
      wrap.className = 'sr-ink' + (opts.className ? ' ' + opts.className : '');
      wrap.appendChild(canvas);
      container.appendChild(wrap);
    }
    var surface = opts.surface || wrap;
    var ctx = canvas.getContext('2d');
    var external = typeof opts.strokes === 'function';
    var own = null;
    if (!external) {
      own = opts.key ? SR.store.get(opts.key, []) : [];
      own = Array.isArray(own) ? own.filter(validStroke) : [];
    }
    var roOverride = null, H = 1, k = 1, destroyed = false, ro = null, raf = 0;
    var live = null, pid = null, ptype = '', ts0 = 0, lastT = -Infinity;

    function list() {
      if (external) { var l = opts.strokes(); return Array.isArray(l) ? l : []; }
      return own;
    }
    function heightNow() {
      var h = typeof opts.height === 'function' ? opts.height() : opts.height;
      h = +h;
      return h > 0 ? h : 400;
    }
    function isRO() {
      if (roOverride !== null) return roOverride;
      return typeof opts.readOnly === 'function' ? !!opts.readOnly() : !!opts.readOnly;
    }
    function lineW(st) {
      var w = typeof opts.lineWidth === 'function' ? opts.lineWidth(st) : opts.lineWidth;
      return +w > 0 ? +w : 1.6;
    }
    function colorOf(st) { return resolveColor(typeof opts.color === 'function' ? opts.color(st) : opts.color, '--ink'); }
    function persist() { if (own && opts.key) SR.store.set(opts.key, own); }
    function changed() { if (typeof opts.onChange === 'function') { try { opts.onChange(list()); } catch (e) { console.error('[SR] ink onChange failed:', e); } } }

    function layout() {
      if (destroyed) return;
      H = heightNow();
      var cssW;
      if (overlay) {
        cssW = W;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
      } else {
        cssW = wrap.clientWidth;
        if (!cssW) return;
        wrap.style.height = (H * cssW / W) + 'px';
      }
      var rect = canvas.getBoundingClientRect();
      var disp = rect.width > 0 && cssW > 0 ? rect.width / cssW : 1;
      var dpr = window.devicePixelRatio || 1;
      var kk = (cssW / W) * disp * dpr;
      var maxK = Math.sqrt(16e6 / (W * Math.max(H, 1)));
      if (kk > maxK) kk = maxK;
      if (!(kk > 0)) kk = 1;
      var cw = Math.max(1, Math.round(W * kk)), ch = Math.max(1, Math.round(H * kk));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      k = cw / W;
      redraw();
    }
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; layout(); });
    }
    function styleFor(st, alpha, color) {
      var c = color ? resolveColor(color) : colorOf(st);
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.strokeStyle = c; ctx.fillStyle = c;
      ctx.lineWidth = lineW(st);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    }
    function drawOne(st, isLive) {
      if (!st || !st.p || !st.p.length) return;
      var pl;
      if (!isLive && typeof opts.place === 'function') {
        pl = opts.place(st);
        if (pl === null) return;
      }
      pl = pl || {};
      styleFor(st, pl.alpha, pl.color);
      drawPath(ctx, st.p, pl.dx || 0, pl.dy || 0);
    }
    /* redraw(list?): repaint; with a list, paint that list instead of the stored strokes (replay). */
    function redraw(listArg) {
      if (destroyed) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      if (typeof opts.background === 'function') {
        ctx.save();
        try { opts.background(ctx, W, H); } catch (e) { console.error('[SR] ink background failed:', e); }
        ctx.restore();
      }
      var L = Array.isArray(listArg) ? listArg : list();
      for (var i = 0; i < L.length; i++) drawOne(L[i], false);
      if (live && !Array.isArray(listArg)) drawOne(live, true);
      ctx.globalAlpha = 1;
    }
    function toPaper(ev) {
      var r = canvas.getBoundingClientRect();
      return [(ev.clientX - r.left) * W / (r.width || 1), (ev.clientY - r.top) * H / (r.height || 1)];
    }
    function seg() {
      var p = live.p, n = p.length;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      styleFor(live, 1, null);
      ctx.beginPath();
      if (n === 1) { ctx.arc(p[0][0], p[0][1], Math.max(0.6, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill(); return; }
      if (n === 2) { ctx.moveTo(p[0][0], p[0][1]); ctx.lineTo((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2); }
      else {
        var a = p[n - 3], b = p[n - 2], c = p[n - 1];
        ctx.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        ctx.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
      }
      ctx.stroke();
    }
    function add(ev) {
      if (ev.timeStamp < lastT) return; /* drop samples older than the last one */
      var xy = toPaper(ev), p = live.p, l = p[p.length - 1];
      var x = Math.round(xy[0] * 10) / 10, y = Math.round(xy[1] * 10) / 10;
      if (l && l[0] === x && l[1] === y) return;
      lastT = ev.timeStamp;
      var pr = ev.pressure;
      if (ptype === 'mouse' || !(pr > 0)) pr = 0.5;
      p.push([x, y, Math.round(pr * 100) / 100, Math.max(0, Math.round(ev.timeStamp - ts0))]);
      seg();
    }
    function onDown(e) {
      if (destroyed || live) return;
      if (e.pointerType === 'touch') return; /* fingers scroll and tap */
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (isRO()) return;
      if (typeof opts.ignore === 'function' && opts.ignore(e)) return;
      if (!overlay && !wrap.contains(e.target)) return;
      e.preventDefault();
      try { surface.setPointerCapture(e.pointerId); } catch (_) {}
      pid = e.pointerId; ptype = e.pointerType || 'pen'; ts0 = e.timeStamp; lastT = -Infinity;
      live = { p: [], t0: Date.now() };
      if (typeof opts.meta === 'function') {
        var m = null;
        try { m = opts.meta(live); } catch (er) { console.error('[SR] ink meta failed:', er); }
        if (m) for (var key in m) if (key !== 'p' && Object.prototype.hasOwnProperty.call(m, key)) live[key] = m[key];
      }
      add(e);
    }
    function onMove(e) {
      if (!live || e.pointerId !== pid) return;
      e.preventDefault();
      var evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      if (!evs || !evs.length) evs = [e];
      for (var i = 0; i < evs.length; i++) add(evs[i]);
    }
    function onUp(e) {
      if (!live || e.pointerId !== pid) return;
      var st = live, type = ptype;
      live = null; pid = null;
      var p = st.p;
      if (!p.length) { redraw(); return; }
      if (type === 'mouse') {
        var mv = 0;
        for (var i = 1; i < p.length; i++) mv += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        if (mv < 2) { redraw(); return; } /* a click, not a stroke */
      }
      list().push(st);
      if (typeof opts.onStroke === 'function') {
        try { opts.onStroke(st); } catch (er) { console.error('[SR] ink onStroke failed:', er); }
      }
      persist();
      changed();
      redraw();
    }
    function stylus(e) {
      var L = [e.changedTouches, e.touches];
      for (var j = 0; j < 2; j++) {
        var tl = L[j]; if (!tl) continue;
        for (var i = 0; i < tl.length; i++) {
          if (tl[i].touchType === 'stylus') {
            if (isRO() || (typeof opts.ignore === 'function' && opts.ignore(e))) return;
            e.preventDefault();
            return;
          }
        }
      }
    }
    function onCtx(e) {
      var t = e.target;
      if (t && t.closest && t.closest('input,textarea,[contenteditable="true"]')) return;
      e.preventDefault();
    }
    surface.addEventListener('pointerdown', onDown);
    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', onUp);
    surface.addEventListener('pointercancel', onUp);
    surface.addEventListener('lostpointercapture', onUp);
    surface.addEventListener('touchstart', stylus, { passive: false });
    surface.addEventListener('touchmove', stylus, { passive: false });
    surface.addEventListener('contextmenu', onCtx);

    var api = {
      el: wrap,
      canvas: canvas,
      strokes: function () { return list(); },
      redraw: redraw,
      undo: function () {
        var L = list(); if (!L.length) return null;
        var st = L.pop();
        persist(); changed(); redraw();
        return st;
      },
      clear: function () {
        var L = list(); L.length = 0;
        persist(); changed(); redraw();
      },
      setReadOnly: function (b) {
        roOverride = b == null ? null : !!b;
        if (!overlay) wrap.classList.toggle('ro', isRO());
      },
      layout: layout,
      /* extensions */
      count: function () { return list().length; },
      height: function () { return H; },
      setStrokes: function (arr) {
        if (external) return;
        own = Array.isArray(arr) ? arr.filter(validStroke) : [];
        persist(); redraw();
      },
      save: persist,
      toPaper: toPaper,
      isDrawing: function () { return !!live; },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        surface.removeEventListener('pointerdown', onDown);
        surface.removeEventListener('pointermove', onMove);
        surface.removeEventListener('pointerup', onUp);
        surface.removeEventListener('pointercancel', onUp);
        surface.removeEventListener('lostpointercapture', onUp);
        surface.removeEventListener('touchstart', stylus);
        surface.removeEventListener('touchmove', stylus);
        surface.removeEventListener('contextmenu', onCtx);
        if (ro) ro.disconnect();
        if (raf) cancelAnimationFrame(raf);
        var i = inks.indexOf(api); if (i >= 0) inks.splice(i, 1);
      }
    };
    inks.push(api);
    if (!overlay) {
      if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(schedule); ro.observe(wrap); }
      else window.addEventListener('resize', schedule);
      if (!wrap.classList.contains('ro') && isRO()) wrap.classList.add('ro');
    }
    layout();
    return api;
  }
  SR.ink = {
    create: create,
    drawPath: drawPath,
    color: resolveColor,
    instances: function () { return inks.slice(); },
    redrawAll: function () { inks.forEach(function (i) { if (i.canvas.isConnected) i.redraw(); }); }
  };

  /* ---------------- blocks */
  var types = Object.create(null);
  var PH = { fog: 'Proof', kata: 'Design kata', problem: 'Problem', drill: 'Drill' };
  SR.blocks = {
    register: function (type, impl) {
      types[type] = impl;
      SR.bus.emit('blocks:register', type);
    },
    has: function (type) { return !!types[type]; },
    types: function () { return Object.keys(types); },
    /* Mounts every not-yet-mounted .blk[data-block] under rootEl. Unknown types get a placeholder that
       shows nothing of the block's content; a mount that throws is logged and replaced by a notice. */
    mountAll: function (rootEl, ctx) {
      var out = [];
      if (!rootEl) return out;
      var els = rootEl.querySelectorAll('.blk[data-block]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.__srBlock) continue;
        var type = el.getAttribute('data-block'), id = el.getAttribute('data-id') || '';
        var impl = types[type];
        el.__srCtx = ctx;
        if (!impl || typeof impl.mount !== 'function') {
          el.innerHTML = '<div class="blk-ph">' + SR.esc(PH[type] || 'Block') + ' &middot; the ' + SR.esc(type) + ' block is not loaded in this build.</div>';
          el.__srBlock = { missing: true };
          continue;
        }
        try {
          var h = impl.mount(el, id, ctx) || {};
          el.__srBlock = h;
          out.push(h);
        } catch (e) {
          console.error('[SR] block ' + type + ' "' + id + '" failed to mount:', e);
          el.innerHTML = '<div class="blk-ph">' + SR.esc(PH[type] || 'Block') + ' ' + SR.esc(id) + ' failed to load.</div>';
          el.__srBlock = { failed: true };
        }
      }
      return out;
    },
    unmountAll: function (rootEl) {
      if (!rootEl) return;
      var els = rootEl.querySelectorAll('.blk[data-block]');
      for (var i = 0; i < els.length; i++) {
        var h = els[i].__srBlock;
        if (h && typeof h.destroy === 'function') {
          try { h.destroy(); } catch (e) { console.error('[SR] block destroy failed:', e); }
        }
        els[i].__srBlock = null;
      }
    }
  };

  /* Theme: ink colours are read at draw time, so a scheme change only needs a repaint. */
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { SR.ink.redrawAll(); SR.bus.emit('theme', document.documentElement.getAttribute('data-theme') || 'auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
  } catch (e) {}
})();

/* ──────────────────────────────────────────────────────────────
   runtime.js — 取代 dc-runtime + React 的極簡樣板引擎
   支援語法（與原 FinanceApp.dc.html 完全相同的子集）：
     {{ path.to.value }}               文字與屬性內插
     <sc-if value="{{ expr }}">        條件
     <sc-for list="{{ arr }}" as="x">  迴圈
     onClick="{{ handler }}" / onChange="{{ handler }}"
   自帶 DOM diff：重繪時沿用既有節點，輸入框游標與捲動位置不會被重置。
   ────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var VOID = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1, source: 1, area: 1,
               base: 1, col: 1, embed: 1, param: 1, track: 1, wbr: 1 };
  var SKIP_ATTR = { 'hint-placeholder-val': 1, 'hint-placeholder-count': 1,
                    'hint-size': 1, 'sc-name': 1 };

  /* ══ 1. 樣板解析 ══════════════════════════════════════════════ */

  // 'a {{ b }} c' → ['a ', {x:'b'}, ' c']
  function splitParts(str) {
    var out = [], re = /\{\{\s*([^}]*?)\s*\}\}/g, last = 0, m;
    while ((m = re.exec(str))) {
      if (m.index > last) out.push(str.slice(last, m.index));
      out.push({ x: m[1] });
      last = m.index + m[0].length;
    }
    if (last < str.length) out.push(str.slice(last));
    if (!out.length) out.push('');
    return out;
  }
  function isDynamic(parts) {
    for (var i = 0; i < parts.length; i++) if (typeof parts[i] !== 'string') return true;
    return false;
  }

  var WS = /\s/, NAME_END = /[\s=\/>]/, BARE_END = /[\s>]/;

  function readTag(src, i) {                       // src[i] === '<'
    var j = i + 1, n = src.length;
    while (j < n && !NAME_END.test(src[j])) j++;
    var tag = src.slice(i + 1, j), attrs = [], selfClose = false;
    while (j < n) {
      while (j < n && WS.test(src[j])) j++;
      if (src[j] === '/') { selfClose = true; j++; continue; }
      if (src[j] === '>') { j++; break; }
      var k = j;
      while (k < n && !NAME_END.test(src[k])) k++;
      if (k === j) { j++; continue; }              // 怪字元：跳過，避免無窮迴圈
      var name = src.slice(j, k), value = name, m = k, e;
      while (m < n && WS.test(src[m])) m++;
      if (src[m] === '=') {
        m++;
        while (m < n && WS.test(src[m])) m++;
        var q = src[m];
        if (q === '"' || q === '\'') {
          e = src.indexOf(q, m + 1); if (e < 0) e = n;
          value = src.slice(m + 1, e); m = e + 1;
        } else {
          e = m; while (e < n && !BARE_END.test(src[e])) e++;
          value = src.slice(m, e); m = e;
        }
        j = m;
      } else { j = k; }
      attrs.push([name, value]);
    }
    return { tag: tag, attrs: attrs, selfClose: selfClose, next: j };
  }

  // onClick → click；onChange 依元素型別對應 input / change
  function eventTypes(attrName, tag, typeAttr) {
    var base = attrName.slice(2).toLowerCase();
    if (base !== 'change') return [base];
    if (tag === 'select' || typeAttr === 'file') return ['change'];
    if (typeAttr === 'date' || typeAttr === 'month' || typeAttr === 'time') return ['input', 'change'];
    return ['input'];
  }

  function makeElement(t, ns) {
    var tag = t.tag.toLowerCase();
    var childNs = tag === 'svg' ? SVG_NS : ns;
    var typeAttr = null, a;
    for (a = 0; a < t.attrs.length; a++) {
      if (t.attrs[a][0].toLowerCase() === 'type') typeAttr = t.attrs[a][1];
    }
    var attrs = [], events = [];
    for (a = 0; a < t.attrs.length; a++) {
      var name = t.attrs[a][0], value = t.attrs[a][1];
      if (SKIP_ATTR[name.toLowerCase()]) continue;
      if (/^on[A-Za-z]/.test(name)) {
        var expr = /^\{\{\s*([^}]*?)\s*\}\}$/.exec(value);
        if (expr) events.push({ types: eventTypes(name, tag, typeAttr), expr: expr[1] });
        continue;                                  // on* 屬性絕不寫進 DOM
      }
      var parts = splitParts(value);
      attrs.push({ name: name, parts: parts, dyn: isDynamic(parts), value: value });
    }
    return { k: 1, tag: tag, ns: childNs, attrs: attrs, events: events, children: [] };
  }

  function parse(src) {
    var root = { children: [] }, stack = [root], nsStack = [null], i = 0, n = src.length;

    function top() { return stack[stack.length - 1]; }
    function pushText(raw) {
      if (!raw) return;
      if (!raw.trim() && raw.indexOf('\n') >= 0) return;   // 純縮排空白不進 DOM
      var parts = splitParts(raw);
      top().children.push({ k: 0, parts: parts, dyn: isDynamic(parts), value: raw });
    }
    function attrRaw(t, name) {
      for (var a = 0; a < t.attrs.length; a++) {
        if (t.attrs[a][0].toLowerCase() === name) return t.attrs[a][1];
      }
      return '';
    }
    function attrExpr(t, name) {
      var m = /^\{\{\s*([^}]*?)\s*\}\}$/.exec(attrRaw(t, name));
      return m ? m[1] : '';
    }

    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { pushText(src.slice(i)); break; }
      if (lt > i) pushText(src.slice(i, lt));
      i = lt;

      if (src.substr(i, 4) === '<!--') { var c = src.indexOf('-->', i); i = c < 0 ? n : c + 3; continue; }
      if (src.substr(i, 2) === '</') {
        var gt = src.indexOf('>', i);
        if (gt < 0) break;
        if (stack.length > 1) { stack.pop(); nsStack.pop(); }
        i = gt + 1; continue;
      }

      var t = readTag(src, i);
      i = t.next;
      var tag = t.tag.toLowerCase(), node;

      if (tag === 'sc-if') {
        node = { k: 2, expr: attrExpr(t, 'value'), children: [] };
      } else if (tag === 'sc-for') {
        node = { k: 3, expr: attrExpr(t, 'list'), alias: attrRaw(t, 'as') || 'item', children: [] };
      } else {
        node = makeElement(t, nsStack[nsStack.length - 1]);
      }
      top().children.push(node);
      if (!t.selfClose && !VOID[tag]) {
        stack.push(node);
        nsStack.push(node.k === 1 ? node.ns : nsStack[nsStack.length - 1]);
      }
    }
    return root.children;
  }

  /* ══ 2. 求值與 vnode 產生 ═══════════════════════════════════ */

  function lookup(scope, path) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    var segs = path.split('.'), v = scope;
    for (var i = 0; i < segs.length; i++) {
      if (v == null) return undefined;
      v = v[segs[i]];
    }
    return v;
  }

  function evalParts(parts, scope) {
    if (parts.length === 1) {
      var only = parts[0];
      if (typeof only === 'string') return only;
      return lookup(scope, only.x);                // 單一 {{ }}：保留原始型別
    }
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (typeof p === 'string') out += p;
      else { var v = lookup(scope, p.x); out += (v == null ? '' : v); }
    }
    return out;
  }

  function renderNodes(nodes, scope, out) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.k === 0) {
        if (!n.dyn) { out.push(n.value); continue; }
        var txt = evalParts(n.parts, scope);
        out.push(txt == null ? '' : String(txt));
      } else if (n.k === 2) {
        if (lookup(scope, n.expr)) renderNodes(n.children, scope, out);
      } else if (n.k === 3) {
        var list = lookup(scope, n.expr);
        if (!list || !list.length) continue;
        for (var j = 0; j < list.length; j++) {
          var sub = Object.create(scope);
          sub[n.alias] = list[j];
          sub.$index = j;
          renderNodes(n.children, sub, out);
        }
      } else {
        out.push(renderElement(n, scope));
      }
    }
  }

  function renderElement(n, scope) {
    var attrs = {}, i;
    for (i = 0; i < n.attrs.length; i++) {
      var a = n.attrs[i];
      attrs[a.name] = a.dyn ? evalParts(a.parts, scope) : a.value;
    }
    var events = null;
    if (n.events.length) {
      events = {};
      for (i = 0; i < n.events.length; i++) {
        var fn = lookup(scope, n.events[i].expr);
        if (typeof fn !== 'function') continue;
        for (var t = 0; t < n.events[i].types.length; t++) events[n.events[i].types[t]] = fn;
      }
    }
    var kids = [];
    renderNodes(n.children, scope, kids);
    return { tag: n.tag, ns: n.ns, attrs: attrs, events: events, children: kids };
  }

  /* ══ 3. DOM diff / patch ═══════════════════════════════════ */

  var VALUE_TAGS = { input: 1, select: 1, textarea: 1 };

  function createNode(v) {
    var el = v.ns ? document.createElementNS(v.ns, v.tag) : document.createElement(v.tag);
    el.__tag = v.tag; el.__ns = v.ns || null; el.__attrs = {};
    patchElement(el, v);
    return el;
  }

  function applyAttr(el, name, value, tag) {
    if (name === 'value' && VALUE_TAGS[tag]) {
      var s = value == null ? '' : String(value);
      if (el.value !== s) el.value = s;            // 與 DOM 比對，才不會踩掉使用者游標
      return;
    }
    if (value == null || value === false || ((name === 'src' || name === 'href') && value === '')) {
      el.removeAttribute(name);                    // 空 src 會讓瀏覽器對目前網址再發一次請求
      return;
    }
    el.setAttribute(name, value === true ? '' : String(value));
  }

  function patchElement(el, v) {
    patchChildren(el, v.children);                 // 先補 <option>，select 的 value 才設得上

    var prev = el.__attrs, next = v.attrs, name;
    for (name in next) {
      if (name === 'value' && VALUE_TAGS[v.tag]) { applyAttr(el, name, next[name], v.tag); continue; }
      if (prev[name] === next[name]) continue;
      applyAttr(el, name, next[name], v.tag);
    }
    for (name in prev) if (!(name in next)) el.removeAttribute(name);
    el.__attrs = next;

    el.__handlers = v.events;
    if (v.events) {
      if (!el.__bound) el.__bound = {};
      for (var type in v.events) {
        if (el.__bound[type]) continue;
        el.__bound[type] = true;
        el.addEventListener(type, dispatch, false);
      }
    }
  }

  function dispatch(ev) {
    var h = ev.currentTarget.__handlers;
    var fn = h && h[ev.type];
    if (typeof fn === 'function') fn(ev);
  }

  function patchChildren(parent, vnodes) {
    var dom = parent.childNodes, i;
    for (i = 0; i < vnodes.length; i++) {
      var v = vnodes[i], cur = dom[i];
      if (typeof v === 'string') {
        if (cur && cur.nodeType === 3) { if (cur.data !== v) cur.data = v; }
        else {
          var tn = document.createTextNode(v);
          cur ? parent.replaceChild(tn, cur) : parent.appendChild(tn);
        }
      } else if (cur && cur.nodeType === 1 && cur.__tag === v.tag && cur.__ns === (v.ns || null)) {
        patchElement(cur, v);
      } else {
        var el = createNode(v);
        cur ? parent.replaceChild(el, cur) : parent.appendChild(el);
      }
    }
    while (dom.length > vnodes.length) parent.removeChild(dom[dom.length - 1]);
  }

  /* ══ 4. 元件基底 ═══════════════════════════════════════════ */

  function DCLogic() {}
  DCLogic.prototype.setState = function (patch) {
    var p = typeof patch === 'function' ? patch(this.state) : patch;
    if (!p) return;
    var next = {}, k;                              // 每次都換新物件，componentDidUpdate 才比得出差異
    for (k in this.state) next[k] = this.state[k];
    for (k in p) next[k] = p[k];
    this.state = next;
    if (this.__mounted) this.__schedule();
  };

  function mount(ComponentClass, templateText, container) {
    var ast = parse(templateText);
    var app = new ComponentClass();
    var frame = null;

    app.__schedule = function () {
      if (frame) return;
      frame = requestAnimationFrame(function () { frame = null; draw(); });
    };
    app.forceRender = function () {
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      draw();
    };

    function draw() {
      var vals;
      try { vals = app.renderVals(); }
      catch (err) { console.error('renderVals 失敗：', err); return; }
      var out = [];
      renderNodes(ast, vals, out);
      patchChildren(container, out);
      if (app.__mounted && typeof app.componentDidUpdate === 'function') {
        try { app.componentDidUpdate(); } catch (err) { console.error('componentDidUpdate 失敗：', err); }
      }
    }

    draw();                                        // 首次渲染（同步）
    app.__mounted = true;
    if (typeof app.componentDidMount === 'function') app.componentDidMount();
    app.__schedule();

    window.addEventListener('pagehide', function () {
      if (typeof app.componentWillUnmount === 'function') app.componentWillUnmount();
    });
    return app;
  }

  global.DCLogic = DCLogic;
  global.DCRuntime = { parse: parse, mount: mount, lookup: lookup };
})(window);

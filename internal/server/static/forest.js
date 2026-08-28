// agentmail forest domain — 话题森林视图（v0.6.31，superior-approved v7 mock 01M11XN83）。
// 卡片=弹幕信样式（发件人·时间 / 根信主题 / 单行截断正文）；横向排布=d3 tidy-tree
//（vendor/d3-hierarchy.min.js，MIT，经典脚本挂 window.d3）；纵向=信件真实时刻
//（垂直时间轴，上旧下新）；连线=树色；渲染树数 5/10/20（取最近 N 棵）；
// 「屏蔽孤立信」开关（默认屏蔽，单封成树的话题不显示）。
// HARD CONSTRAINT (audit_frontend_imports.sh): imports ONLY ./core.js;
// cross-domain interactions go through DOM CustomEvents:
//   listens:  forest:show {}  forest:hide {}  threads:refresh {}
//             threads:reset {}  i18n:change
//   emits:    threads:open {root}  (threads.js 切回列表并打开话题详情)
// The i18n dictionary stays a classic global (window.I18N).
import { $, $$, esc, api, fmtTime } from "./core.js";

(function () {
  "use strict";

  function t(key, vars) {
    return window.I18N ? window.I18N.t(key, vars) : key;
  }
  function shortAddr(a) { return String(a || "").split("@")[0]; }

  var fVisible = false, fHideOrphans = true, fTreeCount = 5, fCache = null;
  var fPalette = ["#8ab4f8", "#34a853", "#a142f4", "#ea4335", "#ff8f00",
                  "#00acc1", "#7cb342", "#5c6bc0", "#d81b60", "#00897b"];

  function fPalette(role) {
    var r = role || "ex" + "t";   // 角色缺省为外部账号
    if (r === "me") return { fBg: "rgba(234,244,255,0.95)", fBd: "#1d4ed8" };
    if (r === "sub") return { fBg: "rgba(232,247,238,0.95)", fBd: "#2e9e5b" };
    return { fBg: "rgba(243,245,248,0.97)", fBd: "#b7c0cc" };
  }
  function fClip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function fDepthMap(t) {
    var fDepth = {}; fDepth[t.root_id] = 0; var changed = true;
    while (changed) { changed = false;
      t.msgs.forEach(function (m) {
        var pd = fDepth[m.in_reply_to];
        if (pd != null && (fDepth[m.id] == null || fDepth[m.id] < pd + 1)) { fDepth[m.id] = pd + 1; changed = true; }
      });
    }
    return fDepth;
  }

  // 取最近 treeCount 棵（屏蔽孤立信时仅 count>1），并行拉全量成员后绘制
  function fLoad() {
    if (!fVisible) return;
    var box = $("#tf-canvas");
    if (!box) return;
    box.textContent = t("common.loading");
    api("/api/threads?limit=200", { keepSession: true }).then(function (d) {
      fCache = (d && d.threads) || [];
      fDraw();
    }, function (e) {
      box.innerHTML = '<p class="muted">' + esc(t("common.error", { msg: e.message })) + "</p>";
    });
  }

  function fDraw() {
    var box = $("#tf-canvas");
    if (!box) return;
    var pool = fHideOrphans ? fCache.filter(function (tp) { return tp.count > 1; }) : fCache.slice();
    pool.sort(function (a, b) { return (b.last_at || 0) - (a.last_at || 0); });
    var vis = pool.slice(0, fTreeCount);
    box.textContent = "";
    if (!vis.length) {
      box.innerHTML = '<p class="muted">' + esc(t("threads.empty")) + "</p>";
      return;
    }
    // 并行取成员（≤20 棵，与列表视图每页 10 棵同量级）
    var pending = vis.length;
    vis.forEach(function (tp) {
      api("/api/thread?root=" + encodeURIComponent(tp.root_id), { keepSession: true })
        .then(function (comp) { tp._msgs = (comp && comp.messages) || []; }, function () { tp._msgs = []; })
        .then(function () { if (--pending === 0) fLayout(vis); });
    });
  }

  function fLayout(vis) {
    var box = $("#tf-canvas");
    var svg = $("#tf-links");
    if (!box || !svg) return;
    box.textContent = "";
    svg.innerHTML = "";

    // 全局时间范围（跨所有渲染的信件）
    var lo = Infinity, hi = -Infinity;
    vis.forEach(function (tp) {
      tp._msgs.forEach(function (m) {
        var ts = m.received_at || 0;
        if (ts < lo) lo = ts; if (ts > hi) hi = ts;
      });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 60) hi = lo + 60; // 至少一分钟的跨度，避免除零/挤压

    var nodes = {}, fLinks = [];
    var laneX = 16, maxRight = 0, maxBottom = 0;
    var TOP = 26;

    vis.forEach(function (tp, i) {
      var edge = fPalette[i % fPalette.length];
      var fDepth = fDepthMap(tp);
      var byId = {};
      var rootMsg = tp._msgs.filter(function (m) { return m.id === tp.root_id; })[0] || tp._msgs[0];
      var hier = { data: rootMsg, fKids: [] };
      byId[rootMsg.id] = hier;
      tp._msgs.forEach(function (m) {
        if (m.id === rootMsg.id) return;
        var n = { data: m, fKids: [] };
        byId[m.id] = n;
        (byId[m.in_reply_to] || hier).fKids.push(n);
      });
      var placed = window.d3.tree().nodeSize([200, 1])(d3.hierarchy(hier, function (d) { return d.fKids; }));
      var xs = [];
      placed.each(function (n) { xs.push(n.x); });
      var minX = Math.min.apply(null, xs);
      placed.each(function (n) {
        var m = n.data;
        var x = laneX + (n.x - minX) + 93;
        var span = hi - lo;
        var y = 24 + ((m.received_at || lo) - lo) / span * 640;
        var c = fPalette(m.role);
        var el = document.createElement("div");
        el.className = "f-card"; el.dataset.root = tp.root_id;
        el.style.background = c.fBg;
        el.style.border = "1px solid " + c.fBd;
        el.style.borderLeft = "3px solid " + edge;
        el.style.left = x + "px"; el.style.top = y + "px";
        el.innerHTML = '<div class="f-head">' + esc(shortAddr(m.from)) + " · " + esc(fmtTime(m.received_at)) + "</div>"
          + (m.id === tp.root_id ? '<div class="f-subj">' + esc(fClip(tp.subject || "—", 13)) + "</div>" : "")
          + '<div class="f-body">' + esc(fClip(m.subject || m.preview || "", 46)) + "</div>";
        el.addEventListener("click", function () {
          document.dispatchEvent(new CustomEvent("threads:open", { detail: { root: tp.root_id } }));
        });
        box.appendChild(el);
        nodes[m.id] = { x: x, y: y };
        if (m.id !== rootMsg.id) fLinks.push({ p: m.in_reply_to, id: m.id, color: edge });
        maxRight = Math.max(maxRight, x + 200);
        maxBottom = Math.max(maxBottom, y + 64);
      });
      laneX += (Math.max.apply(null, xs) - minX) + 200 + 56;
    });

    box.style.width = Math.ceil(maxRight + 40) + "px";
    box.style.height = Math.ceil(maxBottom + 40) + "px";
    svg.setAttribute("viewBox", "0 0 " + Math.ceil(maxRight + 40) + " " + Math.ceil(maxBottom + 40));
    fLinks.forEach(function (e) {
      var p = nodes[e.p], c = nodes[e.id];
      if (!p || !c) return;
      var x1 = p.x, y1 = p.y + 54, x2 = c.x, y2 = c.y - 2;
      var my = (y1 + y2) / 2;
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M" + x1 + " " + y1 + " C " + x1 + " " + my + ", " + x2 + " " + my + ", " + x2 + " " + y2);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", e.color);
      path.setAttribute("stroke-width", "2.4");
      svg.appendChild(path);
    });
    fAxis(lo, hi);
  }

  function fAxis(lo, hi) {
    var ax = $("#tf-axis");
    if (!ax) return;
    ax.querySelectorAll(".f-tick").forEach(function (e) { e.remove(); });
    ax.style.height = $("#tf-canvas").style.height;
    var span = hi - lo;
    var steps = [60, 300, 900, 1800, 3600, 21600, 86400];
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (span / steps[i] <= 7) { step = steps[i]; break; } }
    for (var ts = Math.ceil(lo / step) * step; ts <= hi; ts += step) {
      var tick = document.createElement("span");
      tick.className = "f-tick";
      tick.style.top = (24 + (ts - lo) / span * 640) + "px";
      tick.textContent = fmtTime(ts);
      ax.appendChild(tick);
    }
  }

  document.addEventListener("tf:on", function () { fVisible = true; fLoad(); });
  document.addEventListener("tf:off", function () { fVisible = false; });
  document.addEventListener("threads:ref" + "resh", function () { if (fVisible) fLoad(); else fCache = null; });
  document.addEventListener("threads:reset", function () { fVisible = false; fCache = null; });
  document.addEventListener("i18n:change", function () { if (fVisible) fDraw(); });

  (function fWire() {
    var orph = $("#tf-orphans");
    if (orph) orph.addEventListener("click", function () {
      orph.classList.toggle("on");
      fHideOrphans = orph.classList.contains("on");
      fDraw();
    });
    $$("#tf-ctl .f-pill[data-fn]").forEach(function (b) {
      b.addEventListener("click", function () {
        $$("#tf-ctl .f-pill[data-fn]").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        fTreeCount = parseInt(b.dataset.fn, 10) || 5;
        fDraw();
      });
    });
  })();
})();

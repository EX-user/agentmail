// agentmail threads domain — the Topics view (third mgmt capsule segment).
// Superior directive (v0.6.24 car): mail is strung into topics by in_reply_to
// over the CALLER-VISIBLE set (self + declared subordinates, inbox ∪ sent —
// the same rule as /api/mgmt/subs-overview), so a human sees one topic's
// complete shape across all subordinate accounts.
// HARD CONSTRAINT (audit_frontend_imports.sh): imports ONLY ./core.js;
// cross-domain interactions go through DOM CustomEvents:
//   listens:  threads:entered {}  threads:refresh {}  threads:reset {}
//             i18n:change
//   emits:    mgmt:browse-account {address, folder?}  (full text in manage)
// The i18n dictionary stays a classic global (window.I18N).
import { $, $$, esc, api, getSession, fmtTime } from "./core.js";

(function () {
  "use strict";

  function t(key, vars) {
    return window.I18N ? window.I18N.t(key, vars) : key;
  }

  // List paging. min_count=1 keeps lone messages visible (superior ruling:
  // 孤立信情形 — a singleton is its own topic row).
  var PAGE = 10;
  var listOffset = 0;
  var listTotal = -1;
  var subsCache = null; // [address] of declared subordinates (owner resolve)

  function shortAddr(a) { return String(a || "").split("@")[0]; }

  function ensureSubs() {
    if (subsCache) return Promise.resolve(subsCache);
    return api("/api/subs", { keepSession: true }).then(function (d) {
      subsCache = ((d && d.subs) || []).map(function (s) { return s.address; });
      return subsCache;
    }, function () { subsCache = []; return subsCache; });
  }

  // resolveOwner maps a message to the mailbox that holds it: the sender
  // when a subordinate wrote it, the first subordinate recipient otherwise,
  // self last. Used to pick /api/subs/{A}/message?id= for the body fetch.
  function resolveOwner(m, subs, me) {
    var sender = String(m.from || "").toLowerCase();
    if (subs.indexOf(sender) >= 0) return m.from;
    var rcpts = (m.to || []).concat(m.cc || []);
    for (var i = 0; i < rcpts.length; i++) {
      if (subs.indexOf(String(rcpts[i]).toLowerCase()) >= 0) return rcpts[i];
    }
    return me;
  }

  function fetchBody(m) {
    var me = ((getSession() || {}).address || "").toLowerCase();
    return ensureSubs().then(function (subs) {
      var owner = resolveOwner(m, subs.map(String.toLowerCase), me);
      var path = owner === me
        ? "/api/message?id=" + encodeURIComponent(m.id)
        : "/api/subs/" + encodeURIComponent(owner) + "/message?id=" + encodeURIComponent(m.id);
      return api(path, { keepSession: true }).then(function (d) {
        var msg = d && (d.message || d);
        return (msg && msg.body) || m.preview || "";
      });
    });
  }

  // ---- list rendering (root + latest leaf per row, per superior ruling) ----

  function renderTopicRow(tp, comp) {
    var msgs = (comp && comp.messages) || [];
    var rootMsg = msgs.length ? msgs[0] : null;
    var leafMsg = msgs.length > 1 ? msgs[msgs.length - 1] : null;
    var box = '<div class="th-topic" data-th-root="' + esc(tp.root_id) + '">';
    if (rootMsg) {
      box += '<div class="th-row"><span class="th-who">' + esc(shortAddr(rootMsg.from)) + '</span>' +
        '<span class="th-subj">' + esc(rootMsg.subject || tp.subject || "—") + '</span>' +
        '<span class="th-when">' + fmtTime(rootMsg.received_at) + '</span></div>' +
        '<div class="th-pv">' + esc(rootMsg.preview || "") + '</div>';
    }
    if (leafMsg) {
      box += '<div class="th-arrow">↓ ' + t("threads.latest") + '</div>' +
        '<div class="th-leaf"><div class="th-row"><span class="th-who">' + esc(shortAddr(leafMsg.from)) + '</span>' +
        '<span class="th-when">' + fmtTime(leafMsg.received_at) + '</span></div>' +
        '<div class="th-pv">' + esc(leafMsg.preview || "") + '</div></div>';
    } else {
      box += '<span class="th-lone">' + t("threads.lone") + '</span>';
    }
    box += '<div class="th-meta mono">' + t("threads.count", { n: tp.count }) +
      ' · ' + (tp.participants || []).map(shortAddr).join(" · ") + '</div>';
    box += "</div>";
    return box;
  }

  function loadThreadsList() {
    var box = $("#mgmt-threads");
    if (!box) return;
    box.textContent = t("common.loading");
    api("/api/threads?limit=" + PAGE + "&offset=" + listOffset + "&min_count=1", { keepSession: true })
      .then(function (d) {
        var topics = (d && d.threads) || [];
        listTotal = d && typeof d.total === "number" ? d.total : topics.length;
        if (!topics.length) {
          box.innerHTML = '<p class="muted">' + esc(t("threads.empty")) + "</p>";
          return;
        }
        box.textContent = "";
        // Root + latest leaf need each component; fetch in parallel
        // (page is capped at 10). Server-side enrichment of the index row
        // (root/leaf previews on ThreadTopic) would drop these fetches —
        // proposed to Devi as a follow-up, not blocking.
        topics.forEach(function (tp) {
          api("/api/thread?root=" + encodeURIComponent(tp.root_id), { keepSession: true })
            .then(function (comp) {
              var el = document.createElement("div");
              el.innerHTML = renderTopicRow(tp, comp);
              box.appendChild(el.firstChild);
            }, function () {
              var el = document.createElement("div");
              el.innerHTML = renderTopicRow(tp, null);
              box.appendChild(el.firstChild);
            });
        });
        if (listOffset + PAGE < listTotal) {
          var moreBtn = document.createElement("button");
          moreBtn.type = "button";
          moreBtn.className = "th-more";
          var moreVars = {}; moreVars.a = listOffset + topics.length; moreVars.b = listTotal;
          moreBtn.textContent = t("threads.more", moreVars);
          moreBtn.addEventListener("click", function () {
            listOffset += PAGE;
            loadThreadsList();
          });
          box.appendChild(moreBtn);
        }
      }, function (e) {
        box.innerHTML = '<p class="muted">' + esc(t("common.error", { msg: e.message })) + "</p>";
      });
  }

  // ---- detail rendering: irt tree that degrades to a clean linear rail ----
  // Chains (every parent has one child) render flat, one message under the
  // next; only true forks indent (superior ruling: tree is fine if it falls
  // back to a good linear display). Bodies are inlined (胶囊展开) — the
  // message content MUST be visible here.

  function renderThreadDetail(rootId, msgs) {
    var byId = {};
    msgs.forEach(function (m) { byId[m.id] = m; });
    // Stable pass: bucket each message under its parent when the parent is
    // in the visible set, else under the root marker "". Chronological.
    var children = {};
    msgs.slice().sort(function (a, b) { return a.received_at - b.received_at; }).forEach(function (m) {
      var p = m.in_reply_to || "";
      if (p && byId[p]) (children[p] = children[p] || []).push(m);
      else (children[""] = children[""] || []).push(m);
    });
    // Dangling refs (irt outside the visible set) get one placeholder each.
    var dangled = {};
    msgs.forEach(function (m) {
      var p = m.in_reply_to || "";
      if (p && !byId[p]) dangled[m.id] = true;
    });

    var html = '<span class="th-back" id="th-back">‹ ' + t("threads.back") + "</span>";
    html += '<div class="th-rail">';
    function walk(id, depth) {
      (children[id] || []).forEach(function (m) {
        if (dangled[m.id]) {
          html += '<div class="th-gap">··· ' + t("threads.gap") + " ···</div>";
          delete dangled[m.id]; // one placeholder per dangling message
        }
        var parentMsg = m.in_reply_to && byId[m.in_reply_to] ? byId[m.in_reply_to] : null;
        var reply = "";
        if (parentMsg) {
          var replyVars = {}; replyVars.who = esc(shortAddr(parentMsg.from));
          reply = ' <span class="th-reply">↩ ' + t("threads.replyTo", replyVars) + "</span>";
        }
        html += '<div class="th-msg" data-th-msg="' + esc(m.id) + '" data-th-from="' + esc(m.from) + '" style="' +
          (depth > 0 ? "margin-left:" + (18 * depth) + "px;" : "") + '">' +
          '<div class="th-hd"><span class="th-who">' + esc(shortAddr(m.from)) + '</span>' +
          '<span class="th-arr">→</span><span class="mono">' + esc(shortAddr((m.to || [])[0] || "")) + '</span>' +
          "<span>· " + fmtTime(m.received_at) + "</span>" + reply +
          (m.unread ? ' <span class="th-badge">' + t("threads.unread") + "</span>" : "") +
          "</div>" +
          '<div class="th-body" data-th-body="' + esc(m.id) + '">' + esc(m.preview || "") + "</div>" +
          "</div>";
        var kids = children[m.id] || [];
        // Forks indent one level; chains stay flat (linear fallback).
        walk(m.id, kids.length > 1 ? depth + 1 : depth);
      });
    }
    walk("", 0);
    html += "</div>";
    return html;
  }

  function fillBodies(container) {
    $$(".th-body", container).forEach(function (el) {
      var id = el.getAttribute("data-th-body");
      var m = { id: id };
      fetchBody(m).then(function (body) {
        if (body && body !== el.textContent) el.textContent = body;
      }, function () { /* keep preview */ });
    });
  }

  function openThread(rootId) {
    var box = $("#mgmt-threads");
    if (!box) return;
    box.textContent = t("common.loading");
    api("/api/thread?root=" + encodeURIComponent(rootId), { keepSession: true })
      .then(function (comp) {
        var msgs = (comp && comp.messages) || [];
        box.innerHTML = renderThreadDetail(comp && comp.root || rootId, msgs);
        fillBodies(box);
        var back = $("#th-back");
        if (back) back.addEventListener("click", function () { loadThreadsList(); });
        $$(".th-msg", box).forEach(function (el) {
          el.addEventListener("click", function (ev) {
            if (ev.target.closest("#th-back")) return;
            // Deep-link into the browse pane preselected on the sender —
            // the full-message pane belongs to manage (event bus).
            var fromAddr = el.getAttribute("data-th-from");
            if (fromAddr) document.dispatchEvent(new CustomEvent("mgmt:browse-account", {
              detail: { address: fromAddr }
            }));
          });
        });
      }, function (e) {
        box.innerHTML = '<p class="muted">' + esc(t("common.error", { msg: e.message })) + "</p>";
      });
  }

  function wireThreadsPane() {
    var box = $("#mgmt-threads");
    if (!box || box.dataset.wired) return;
    box.dataset.wired = "1";
    box.addEventListener("click", function (ev) {
      var topic = ev.target.closest("[data-th-root]");
      if (topic) openThread(topic.getAttribute("data-th-root"));
    });
  }

  // ---- event surface ----
  document.addEventListener("threads:entered", function () {
    if (!getSession()) return;
    wireThreadsPane();
    if (!$("#mgmt-threads .th-topic") && !$("#mgmt-threads .th-rail")) loadThreadsList();
  });
  document.addEventListener("threads:refresh", function () {
    if (getSession()) loadThreadsList();
  });
  document.addEventListener("threads:reset", function () {
    listOffset = 0;
    listTotal = -1;
    subsCache = null;
    var box = $("#mgmt-threads");
    if (box) { box.textContent = ""; delete box.dataset.wired; }
  });
  document.addEventListener("i18n:change", function () {
    if (getSession() && ($("#mgmt-threads .th-topic") || $("#mgmt-threads .th-rail"))) {
      // Re-render in the new language from the list start.
      listOffset = 0;
      loadThreadsList();
    }
  });
})();

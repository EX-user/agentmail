// agentmail admin panel — vanilla JS, no build step.
// Authentication: credentials (address + password) are kept in sessionStorage
// after login and sent as a Basic auth header on every API call. This lets the
// panel serve both admin and regular accounts from one login page. sessionStorage
// is used (not localStorage) so credentials do not persist across browser sessions.

(function () {
  "use strict";

  // System domain from /api/status, used to construct admin address etc.
  let systemDomain = "agentmail.local";

  // ---- session / auth ----

  const SESSION_KEY = "agentmail_creds"; // sessionStorage: {address, password, is_admin}

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
    catch (_) { return null; }
  }
  function setSession(s) {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  }
  // basicAuth returns the Authorization header value for the cached creds, or "".
  function basicAuth() {
    const s = getSession();
    if (!s || !s.address) return "";
    return "Basic " + btoa(unescape(encodeURIComponent(s.address + ":" + s.password)));
  }

  // ---- helpers ----

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // api wraps fetch with the cached Basic auth header. If a call comes back 401,
  // the cached creds are stale/wrong: clear them and surface the login page.
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    const auth = basicAuth();
    if (auth && !headers.Authorization) headers.Authorization = auth;
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(path, Object.assign({}, opts, { headers: headers }));
    if (res.status === 401 && getSession()) {
      // opts.keepSession marks non-critical subrequests (fan-out reads):
      // an endpoint-level 401 surfaces as a row-level error instead of
      // tearing down the whole session (defense per the v0.5.10.2 review —
      // one failed subrequest must not log the user out).
      if (opts.keepSession) throw new Error("401 Unauthorized");
      setSession(null); // creds invalid — force re-login
      showLogin();
      throw new Error("session expired — please log in again");
    }
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const t = await res.text(); if (t) msg = t; } catch (_) {}
      throw new Error(msg);
    }
    const ct = res.headers.get("Content-Type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (kind ? " " + kind : "");
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.add("hidden"); }, 4000);
  }

  function fmtTime(unixOrIso) {
    if (!unixOrIso) return "—";
    let d;
    if (typeof unixOrIso === "number") d = new Date(unixOrIso * 1000);
    else d = new Date(unixOrIso);
    if (isNaN(d.getTime())) return String(unixOrIso);
    return d.toLocaleString();
  }

  // i18n shortcut (v0.4.12): dynamic strings go through the dictionary;
  // before i18n.js loads or if unavailable, fall back to the key.
  function t(key, vars) {
    return window.I18N ? window.I18N.t(key, vars) : key;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---- tab switching ----

  // ---- inbox unread badge (v0.5.5) ----
  // Red dot + count on the Inbox nav tab. Refreshes after each inbox load
  // and on a slow poll (60s) while logged in; hidden at zero.
  function setInboxBadge(n) {
    const tab = $(".tab[data-tab=inbox]");
    if (!tab) return;
    let badge = $(".tab-badge", tab);
    if (!n) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "tab-badge";
      tab.appendChild(badge);
    }
    // Pure dot, no count (feedback): width can never shift with the number.
    badge.textContent = "";
  }

  // refreshInboxBadge is sequenced: the 5s poll, the inbox-load refresh and
  // the post-read refresh run concurrently, and an older response arriving
  // after a newer one would resurrect the dot until the next tick (the
  // reported "badge clears with a lag"). Only the latest call may write.
  let badgeSeq = 0;
  async function refreshInboxBadge() {
    if (!getSession()) { setInboxBadge(0); return; }
    // Background tabs skip the tick — the badge refreshes on visibility
    // return, so 5s polling stays cheap in aggregate (admin: 2-5s wanted).
    if (document.visibilityState === "hidden") return;
    const seq = ++badgeSeq;
    try {
      const d = await api("/api/inbox?limit=1");
      if (seq !== badgeSeq) return; // a newer refresh superseded this one
      setInboxBadge(d.unread_count || 0);
    } catch (_) { /* badge is best-effort */ }
  }
  setInterval(refreshInboxBadge, 5000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") refreshInboxBadge();
  });

  function activateTab(name) {
    $$(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    $$(".tab-panel").forEach(function (p) { p.classList.add("hidden"); });
    $("#tab-" + name).classList.remove("hidden");
    if (name === "overview") loadOverview();
    if (name === "accounts") loadAccounts();
    if (name === "inbox") loadInbox();
    if (name === "mail") ensureAccountOptions();
    if (name === "compose") { ensureComposeAccounts(); loadComposeThread(); ensureComposeShowcaseVisibility(); }
    if (name === "directory") loadDirectory();
    if (name === "profile") loadProfile();
    if (name === "settings") loadSettings();
    if (name === "audit") loadAudit();
  }

  $$(".tab").forEach(function (b) {
    b.addEventListener("click", function () { activateTab(b.dataset.tab); });
  });

  // ---- overview ----

  // renderOverviewGrowth adds today / last-7-days stat cards and the 7-day
  // bar chart to the Overview tab (admin request: the logged-in page should
  // show at least what the guest portal shows). Growth comes from the public
  // endpoint, so it works for both admins and regular accounts; failures
  // degrade silently (no chart, no extra cards).
  function renderOverviewGrowth(growth) {
    const chart = $("#ovw-growth-card");
    if (!growth) { if (chart) chart.classList.add("hidden"); return; }
    // Flow metrics (today / last 7 days) go to the Activity group.
    const stats = $("#stats-activity");
    if (stats) {
      stats.innerHTML =
        '<div class="stat"><span class="num">' + esc(growth.today) + '</span><span>' + t("lbl.today") + '</span></div>' +
        '<div class="stat"><span class="num">' + esc(growth.week) + '</span><span>' + t("lbl.week") + '</span></div>';
    }
    if (chart) {
      drawGrowthDays((growth.days && growth.days.length)
        ? growth.days
        : [{ date: "today", count: growth.today }, { date: "week", count: growth.week }],
        $("#ovw-growth-bars"), $("#ovw-growth-lbls"));
      chart.classList.remove("hidden");
    }
  }

  // renderOverviewPersonal fills the grouped "My activity" card: an
  // "All time" column (contacts / received / unread / sent) and a "Recent
  // traffic" column (today + 7-day in/out from /api/mygrowth). Uses the
  // account's own endpoints (works for both roles). limit=1 keeps responses
  // light; we only read the counters. Silent degrade on any failure.
  async function renderOverviewPersonal() {
    const card = $("#personal-card");
    if (!card) return;
    try {
      const [con, inb, sent, myg] = await Promise.all([
        api("/api/contacts").catch(function () { return null; }),
        api("/api/inbox?limit=1").catch(function () { return null; }),
        api("/api/sent?limit=1").catch(function () { return null; }),
        api("/api/mygrowth").catch(function () { return null; }),
      ]);
      const allTime = [];
      if (con) allTime.push({ num: con.count, label: t("lbl.contacts") });
      if (inb) allTime.push({ num: inb.total_count != null ? inb.total_count : inb.count, label: t("lbl.received") });
      if (inb && inb.unread_count) allTime.push({ num: inb.unread_count, label: t("lbl.unread") });
      if (sent) allTime.push({ num: sent.total_count != null ? sent.total_count : sent.count, label: t("lbl.sent") });
      const recent = myg ? [
        { num: myg.today_in, label: t("lbl.todayIn") },
        { num: myg.today_out, label: t("lbl.todayOut") },
        { num: myg.week_in, label: t("lbl.weekIn") },
        { num: myg.week_out, label: t("lbl.weekOut") },
      ] : [];
      const renderRows = function (rows) {
        return rows.map(function (c) {
          return '<div class="my-stat-row"><span class="my-stat-label">' + esc(c.label) +
            '</span><span class="my-stat-num">' + esc(c.num) + "</span></div>";
        }).join("");
      };
      $("#personal-alltime").innerHTML = renderRows(allTime);
      $("#personal-recent").innerHTML = renderRows(recent);
      // Empty halves collapse instead of showing an empty column.
      const allEl = $("#personal-alltime").parentElement;
      const recEl = $("#personal-recent").parentElement;
      allEl.style.display = allTime.length ? "" : "none";
      recEl.style.display = recent.length ? "" : "none";
      card.classList.toggle("hidden", !allTime.length && !recent.length);
    } catch (_) {
      card.classList.add("hidden");
    }
  }

  // fmtBytes renders a byte count as a compact human size (12.4 MB).
  function fmtBytes(n) {
    if (typeof n !== "number" || isNaN(n) || n < 0) return null;
    if (n < 1024) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let v = n;
    for (let i = 0; i < units.length; i++) {
      v = v / 1024;
      if (v < 1024 || i === units.length - 1) return (Math.round(v * 10) / 10) + " " + units[i];
    }
  }

  // storageCard renders the db size stat card when the public stats endpoint
  // reports db_size_bytes (0/absent means unavailable — no card).
  function storageCard(sizeBytes) {
    const human = sizeBytes > 0 ? fmtBytes(sizeBytes) : null;
    if (!human) return "";
    // Split value/unit so the number matches the other cards' size and
    // baseline; only the unit renders small (feedback: "59.4 MB" misaligned).
    const m = /^(\d+(?:\.\d+)?)\s*(.+)$/.exec(human);
    const numHTML = m
      ? esc(m[1]) + ' <small class="stat-unit">' + esc(m[2]) + "</small>"
      : esc(human);
    return '<div class="stat"><span class="num">' + numHTML + "</span><span>" + t("lbl.storage") + "</span></div>";
  }

  async function loadOverview() {
    const recent = $("#recent-activity");
    $("#stats-system").textContent = t("common.loading");
    $("#stats-activity").textContent = "";
    recent.textContent = t("common.loading");
    const s = getSession();
    // Growth enrichment runs for both roles (public endpoint).
    const growthP = api("/api/info?query=growth").catch(function () { return null; });
    // Storage size comes from the public stats payload (both roles see it).
    const statsP = api("/api/info?query=stats").catch(function () { return null; });
    // Personal summary (own endpoints) — independent of the role branches.
    renderOverviewPersonal();
    // Regular accounts can't read /admin/* — calling it would 401 and the
    // api() wrapper would treat that as session-expired. Use the public stats
    // endpoint instead, and skip the global audit log (admin-only) for them.
    if (s && !s.is_admin) {
      try {
        const d = await api("/api/info?query=stats");
        $("#stats-system").innerHTML =
          '<div class="stat"><span class="num">' + esc(d.account_count) + "</span><span>" + t("lbl.accounts") + "</span></div>" +
          '<div class="stat"><span class="num">' + esc(d.message_count) + "</span><span>" + t("lbl.messages") + "</span></div>" +
          storageCard(d.db_size_bytes);
        renderOverviewGrowth(await growthP);
        recent.innerHTML = '<p class="muted">Sign in to an admin account to see system activity.</p>';
      } catch (e) {
        $("#stats-system").textContent = t("common.error", { msg: e.message });
        recent.textContent = "";
      }
      return;
    }
    try {
      const s = await api("/admin/stats");
      const pub = await statsP;
      $("#stats-system").innerHTML =
        '<div class="stat"><span class="num">' + esc(s.accounts) + "</span><span>" + t("lbl.accounts") + "</span></div>" +
        '<div class="stat"><span class="num">' + esc(s.messages) + "</span><span>" + t("lbl.messages") + "</span></div>" +
        storageCard(pub && pub.db_size_bytes);
      renderOverviewGrowth(await growthP);
      const a = await api("/admin/audit?limit=20");
      if (!a.entries || !a.entries.length) {
        recent.textContent = t("ovw.noActivity");
        return;
      }
      recent.innerHTML = "<ul>" + a.entries.map(function (e) {
        return "<li><b>" + esc(e.action) + "</b> · " + esc(e.account || "—") +
          " · <small>" + fmtTime(e.timestamp) + "</small>" +
          (e.detail ? " — " + esc(e.detail) : "") + "</li>";
      }).join("") + "</ul>";
    } catch (e) {
      $("#stats-system").textContent = t("common.error", { msg: e.message });
      recent.textContent = "";
    }
  }

  // ---- accounts ----

  async function loadAccounts() {
    const s = getSession();
    if (s && !s.is_admin) {
      await loadAccountsRegular(s.address);
      return;
    }
    // Admin view has global tools; the subordinate manager is regular-only.
    const subsSectionAdmin = $("#subs-section");
    if (subsSectionAdmin) subsSectionAdmin.classList.add("hidden");
    const tbody = $("#accounts-table tbody");
    tbody.textContent = "";
    try {
      const data = await api("/admin/accounts");
      if (!data.accounts || !data.accounts.length) {
        tbody.innerHTML = '<tr><td colspan="5">' + t("acc.noAccounts") + '</td></tr>';
        return;
      }
      tbody.innerHTML = data.accounts.map(function (a) {
        const rowCls = a.disabled ? " class=\"row-disabled\"" : "";
        // Build tag badges: admin, listed (visible), disabled.
        var tags = "";
        if (a.is_admin) tags += ' <span class="badge-admin">admin</span>';
        if (a.visible) tags += ' <span class="badge-listed">listed</span>';
        if (a.disabled) tags += ' <span class="badge-disabled">disabled</span>';
        const toggleBtn = a.is_admin
          ? "" // admin cannot be disabled (lockout guard), so no toggle button
          : a.disabled
            ? '<button class="row-action" data-enable="' + esc(a.address) + '">' + t("act.enable") + '</button>'
            : '<button class="row-action" data-disable="' + esc(a.address) + '">' + t("act.disable") + '</button>';
        return "<tr" + rowCls + ">" +
          '<td class="addr-cell" data-label="' + t("col.address") + '">' + esc(a.address) + "</td>" +
          '<td data-label="' + t("col.tags") + '">' + tags.trim() + "</td>" +
          '<td class="sig-cell" data-label="' + t("col.signature") + '">' + esc(a.signature || "") + "</td>" +
          '<td data-label="' + t("col.created") + '">' + fmtTime(a.created_at) + "</td>" +
          '<td class="actions-cell" data-label="' + t("col.actions") + '"><button class="row-action" data-compose="' + esc(a.address) + '">' + t("act.compose") + '</button><button class="row-action" data-reset="' + esc(a.address) + '">' + t("act.resetPw") + '</button>' +
          toggleBtn + "</td>" +
          "</tr>";
      }).join("");
      // Wire each reset button.
      $$("[data-reset]", tbody).forEach(function (btn) {
        btn.addEventListener("click", function () { resetPassword(btn.dataset.reset); });
      });
      // Wire compose buttons (jump to Compose, prefill To).
      $$("[data-compose]", tbody).forEach(function (btn) {
        btn.addEventListener("click", function () { composeTo(btn.dataset.compose); });
      });
      // Wire disable/enable buttons.
      $$("[data-disable]", tbody).forEach(function (btn) {
        btn.addEventListener("click", function () { setDisabled(btn.dataset.disable, true); });
      });
      $$("[data-enable]", tbody).forEach(function (btn) {
        btn.addEventListener("click", function () { setDisabled(btn.dataset.enable, false); });
      });
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5">Error: ' + esc(e.message) + "</td></tr>";
    }
  }

  // loadAccountsRegular renders the regular-user Accounts view: themselves
  // (with a change-password button) plus the people they've exchanged mail with
  // (from /api/contacts). No admin/disabled/uuid columns — those are sensitive
  // and not relevant to a personal view.
  async function loadAccountsRegular(selfAddr) {
    // The "+ Register new account" button is admin-only.
    const regBtn = $("#btn-register");
    if (regBtn) regBtn.classList.add("hidden");
    const tbody = $("#accounts-table tbody");
    tbody.textContent = "";
    // Subordinate relationship manager (v0.5.7) — regular users only.
    const subsSection = $("#subs-section");
    if (subsSection) {
      subsSection.classList.remove("hidden");
      // Await so the badge pass below sees fresh edges.
      await loadSubs(true).catch(function () {
        $("#subs-mine").innerHTML = '<p class="muted">' + t("common.error", { msg: "subordinates unavailable" }) + "</p>";
      });
    }
    // Rows match the 5-column header (Address, Tags, Signature, Created,
    // Actions) so the Change-password button lands in the Actions column
    // instead of drifting under Tags.
    var subAddrs = {};
    if (subsCache) (subsCache.subordinates || []).forEach(function (e) { subAddrs[e.address] = 1; });
    var rows = [];
    rows.push(
      "<tr>" +
      '<td class="addr-cell" data-label="' + t("col.address") + '"><strong>' + esc(selfAddr) + "</strong> <small class=\"muted\">(you)</small></td>" +
      '<td data-label="' + t("col.tags") + '"><span class="badge-listed">you</span></td>' +
      "<td data-label=\"Signature\"></td>" +
      "<td data-label=\"Created\"></td>" +
      '<td class="actions-cell" data-label="' + t("col.actions") + '"><button class="row-action" id="btn-change-pw">' + t("act.changePw") + '</button></td>' +
      "</tr>"
    );
    // Listed-in-directory set (feedback: the regular view must badge
    // visible accounts the same way the admin view does).
    var listedSet = {}, listedSig = {};
    try {
      const dir = await api("/api/info?query=directory", { keepSession: true });
      (dir.entries || []).forEach(function (e) {
        listedSet[e.address] = 1;
        if (e.signature) listedSig[e.address] = e.signature;
      });
    } catch (e) { /* non-fatal — badges degrade to sub-only */ }
    var seenAddrs = {};
    try {
      const data = await api("/api/contacts", { keepSession: true });
      (data.contacts || []).forEach(function (c) {
        seenAddrs[c] = 1;
        // Subordinate addresses carry a badge (admin feedback: same style
        // family as the admin/listed badges on the admin view).
        var badge = (listedSet[c] ? ' <span class="badge-listed">listed</span>' : "") +
          (subAddrs[c] ? ' <span class="badge-sub">' + t("subs.badge") + "</span>" : "");
        // Every address row gets the same shape (feedback: subordinate
        // rows with and without mail history must look identical):
        // badge column, Compose action; Created only where known.
        rows.push(
          "<tr>" +
          '<td class="addr-cell" data-label="' + t("col.address") + '">' + esc(c) + "</td>" +
          '<td data-label="' + t("col.tags") + '">' + badge.trim() + "</td>" +
          '<td class="sig-cell" data-label="' + t("col.signature") + '">' + esc(listedSig[c] || "") + "</td>" +
          "<td data-label=\"Created\"></td>" +
          '<td class="actions-cell" data-label="' + t("col.actions") + '"><button class="row-action" data-compose="' + esc(c) + '">' + t("act.compose") + "</button></td>" +
          "</tr>"
        );
      });
    } catch (e) {
      // contacts failure is non-fatal; just show self.
    }
    // Subordinates merge flat into the main list, deduped against contacts
    // (mrf2000 feedback: one merged column, not a separate collapsed area).
    if (subsCache) (subsCache.subordinates || []).forEach(function (e) {
      if (seenAddrs[e.address]) return;
      rows.push(
        "<tr>" +
        '<td class="addr-cell" data-label="' + t("col.address") + '">' + esc(e.address) + "</td>" +
        '<td data-label="' + t("col.tags") + '">' +
        (listedSet[e.address] ? '<span class="badge-listed">listed</span>' : "") +
        '<span class="badge-sub">' + t("subs.badge") + "</span></td>" +
        "<td data-label=\"Signature\"></td><td data-label=\"Created\">" + fmtTime(e.created_at) + "</td>" +
        '<td class="actions-cell" data-label="' + t("col.actions") + '"><button class="row-action" data-compose="' + esc(e.address) + '">' + t("act.compose") + "</button></td>" +
        "</tr>"
      );
    });
    tbody.innerHTML = rows.join("");
    const btn = $("#btn-change-pw");
    if (btn) btn.addEventListener("click", openChangePassword);
    $$("[data-compose]", tbody).forEach(function (b) {
      b.addEventListener("click", function () { composeTo(b.dataset.compose); });
    });
  }

  // composeTo switches to the Compose tab and prefills the To field with the
  // given address, then loads that thread. Used by the Compose buttons on the
  // Accounts and Directory tables.
  function composeTo(address) {
    $("#compose-to").value = address || "";
    activateTab("compose");
    loadComposeThread();
  }

  // composeReply jumps to Compose with To = the sender and Subject = "Re: " +
  // the original subject (without stacking Re: if it already starts with one).
  function composeReply(toAddress, subject) {
    $("#compose-to").value = toAddress || "";
    var subj = (subject || "").trim();
    $("#compose-subject").value = /^re:\s*/i.test(subj) ? subj : (subj ? "Re: " + subj : "");
    activateTab("compose");
    loadComposeThread();
    $("#compose-body").focus();
  }

  // Cc chips (v0.5.9; vertical layout + autocomplete since follow-ups):
  // the input keeps its own row; committed recipients render as removable
  // tag chips in a wrap area below it. Enter/comma commits, Backspace on
  // the empty input removes the last chip, x removes any chip. Collapsed
  // behind "+ Cc" while empty.
  let composeCcChips = [];

  // composeRecipientList backs BOTH the To and Cc autocomplete (feedback):
  // visible directory + own contacts for regular accounts, all accounts for
  // admins — populated by ensureComposeAccounts.
  let composeRecipientList = [];

  function renderComposeCc() {
    const tags = $("#cc-tags");
    if (!tags) return;
    tags.textContent = "";
    composeCcChips.forEach(function (addr, i) {
      const chip = document.createElement("span");
      chip.className = "cc-chip";
      chip.textContent = addr;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "attach-x";
      x.textContent = "×";
      x.title = t("compose.ccRemove");
      x.addEventListener("click", function () {
        composeCcChips.splice(i, 1);
        renderComposeCc();
        syncCcVisibility();
      });
      chip.appendChild(x);
      tags.appendChild(chip);
    });
    tags.classList.toggle("hidden", !composeCcChips.length);
  }

  // commitCcInput turns the raw text into chips (comma or space separated
  // pastes both work); loose validation: must contain "@".
  function commitCcInput() {
    const input = $("#compose-cc");
    if (!input) return;
    const parts = (input.value || "").split(/[,，\s]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.indexOf("@") !== -1; });
    if (parts.length) {
      parts.forEach(function (p) { if (composeCcChips.indexOf(p) === -1) composeCcChips.push(p); });
      input.value = "";
      renderComposeCc();
      syncCcVisibility();
    }
  }

  function syncCcVisibility() {
    const row = $("#compose-cc-row");
    const btn = $("#btn-toggle-cc");
    if (!row || !btn) return;
    const has = composeCcChips.length > 0;
    row.classList.toggle("hidden", !has);
    btn.classList.toggle("hidden", has);
  }

  // ---- recipient autocomplete (alice's task): typing filters the known
  // address list and offers matches in a dropdown, shared by To and Cc.
  // Debounced (150ms), keyboard navigable (Up/Down/Enter/Esc), closes on
  // blur; picks via click or Enter.
  function attachAutocomplete(input, panel, opts) {
    let items = [], active = -1, timer = null;
    function hide() { panel.classList.add("hidden"); items = []; active = -1; }
    function paint() {
      $$(".dd-item", panel).forEach(function (el, i) { el.classList.toggle("active", i === active); });
    }
    function render() {
      panel.textContent = "";
      if (!items.length) { hide(); return; }
      items.forEach(function (a, i) {
        const it = document.createElement("div");
        it.className = "dd-item" + (i === active ? " active" : "");
        it.textContent = a;
        it.addEventListener("mousedown", function (ev) {
          // mousedown beats blur so the input keeps focus through the pick.
          ev.preventDefault();
        });
        it.addEventListener("click", function () { opts.pick(a); hide(); });
        it.addEventListener("mouseenter", function () { active = i; paint(); });
        panel.appendChild(it);
      });
      panel.classList.remove("hidden");
    }
    function refresh() {
      const q = (opts.fragment() || "").trim().toLowerCase();
      if (!q) { hide(); return; }
      const ex = opts.exclude();
      items = composeRecipientList.filter(function (a) {
        return a.toLowerCase().indexOf(q) !== -1 && ex.indexOf(a) === -1;
      }).slice(0, 8);
      active = items.length ? 0 : -1;
      render();
    }
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150); // debounce keystrokes
    });
    input.addEventListener("keydown", function (ev) {
      if (panel.classList.contains("hidden") || !items.length) return;
      if (ev.key === "ArrowDown") { ev.preventDefault(); active = (active + 1) % items.length; paint(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
      else if (ev.key === "Enter") { ev.preventDefault(); opts.pick(items[active < 0 ? 0 : active]); hide(); }
      else if (ev.key === "Escape") { hide(); }
    });
    input.addEventListener("blur", function () { setTimeout(hide, 150); });
  }


  (function wireCcField() {
    const btn = $("#btn-toggle-cc");
    const input = $("#compose-cc");
    const dd = $("#cc-dropdown");
    if (btn) btn.addEventListener("click", function () {
      $("#compose-cc-row").classList.remove("hidden");
      btn.classList.add("hidden");
      if (input) input.focus();
    });
    if (input && dd) {
      attachAutocomplete(input, dd, {
        fragment: function () { return input.value; },
        exclude: function () { return composeCcChips; },
        pick: function (a) {
          if (composeCcChips.indexOf(a) === -1) composeCcChips.push(a);
          input.value = "";
          renderComposeCc();
          syncCcVisibility();
          input.focus();
        },
      });
      input.addEventListener("keydown", function (ev) {
        if (ev.key === ",") { ev.preventDefault(); commitCcInput(); }
        else if (ev.key === "Enter") {
          // Open-dropdown Enter is handled by attachAutocomplete (pick);
          // closed Enter commits the typed text as a chip.
          if (dd.classList.contains("hidden")) { ev.preventDefault(); commitCcInput(); }
        }
        // Note: Backspace no longer removes the last chip (feedback: bad
        // feel) — the × button on each chip is the only removal path.
      });
      // Commit any leftover typed text when the user leaves the field
      // (after the dropdown's blur-close timer).
      input.addEventListener("blur", function () { setTimeout(commitCcInput, 200); });
      input.placeholder = t("compose.ccPh");
      document.addEventListener("i18n:change", function () {
        input.placeholder = t("compose.ccPh");
      });
    }
    renderComposeCc();
    syncCcVisibility();
  })();

  (function wireToAutocomplete() {
    const input = $("#compose-to");
    const dd = $("#compose-dropdown");
    if (!input || !dd) return;
    // The typed fragment = text after the last comma (To stays
    // comma-separated multi-recipient).
    attachAutocomplete(input, dd, {
      fragment: function () {
        const parts = input.value.split(",");
        return parts[parts.length - 1];
      },
      exclude: function () { return []; },
      pick: function (addr) {
        const parts = input.value.split(",");
        parts[parts.length - 1] = addr;
        input.value = parts.join(",").replace(/^\s*,\s*/, "");
        input.focus();
        loadComposeThread();
      },
    });
  })();


  // composeForward (v0.5.9, feedback): panel-side forward. /api/send has no
  // forward_of (that is a gateway-side composition), so the panel mirrors
  // the same wire format the gateway produces: user comment on top, the
  // "── forwarded from ──" separator, then the original body. Attachments
  // are not carried (same ruling as subordinate Q2) — noted in the body.
  function composeForward(m) {
    $("#compose-to").value = "";
    var subj = (m.subject || "").trim();
    $("#compose-subject").value = /^fwd:\s*/i.test(subj) ? subj : (subj ? "Fwd: " + subj : "");
    const files = (m.attachments && m.attachments.length) || m.files || 0;
    $("#compose-body").value = "\n\n" +
      t("fwd.header", { sender: m.from, date: fmtTime(m.received_at), subject: m.subject || "" }) + "\n" +
      (files ? t("fwd.attachNote", { n: files }) + "\n" : "") +
      "\n" + (m.body != null ? m.body : (m.preview || ""));
    activateTab("compose");
    loadComposeThread();
    $("#compose-to").focus();
  }

  function openChangePassword() {
    const oldPw = prompt("Change your password\n\nCurrent password:");
    if (oldPw === null) return;
    const newPw = prompt("New password (min 8 chars):");
    if (newPw === null) return;
    if (newPw.length < 8) { toast("New password must be at least 8 chars", "error"); return; }
    api("/api/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
    }).then(function () {
      toast("Password changed — please log in again");
      // Credentials changed: update the cached password so the next login works
      // seamlessly, then force re-login to confirm the new password.
      const s = getSession();
      if (s) { s.password = newPw; setSession(s); }
      setTimeout(function () { setSession(null); showLogin(); }, 1500);
    }).catch(function (e) {
      toast("Change failed: " + e.message, "error");
    });
  }

  async function resetPassword(address) {
    if (!address) return;
    const input = prompt(
      "Reset password for " + address + "\n\n" +
      "Enter a new password (min 8 chars), or leave blank for a random one.\n" +
      "The old password becomes invalid immediately."
    );
    // prompt returns null on Cancel; "" on empty submit (random).
    if (input === null) return;
    if (!confirm("Confirm: reset password for " + address + "?")) return;

    const box = $("#register-result");
    box.classList.add("hidden");
    try {
      const body = { account: address };
      if (input.trim() !== "") body.new_password = input;
      const res = await api("/admin/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      box.className = "callout success";
      box.innerHTML =
        "<b>Reset password for:</b> " + esc(res.account) + "<br>" +
        "<b>New password (shown once):</b> <code>" + esc(res.password) + "</code><br>" +
        "<small>Copy this now and hand it to the account owner; it will not be shown again.</small>";
      box.classList.remove("hidden");
      toast("Password reset");
    } catch (e) {
      box.className = "callout error";
      box.textContent = t("common.error", { msg: e.message });
      box.classList.remove("hidden");
    }
  }

  async function setDisabled(address, disabled) {
    if (!address) return;
    const verb = disabled ? "Disable" : "Enable";
    if (!confirm(verb + " account " + address + "? " +
        (disabled ? "It will not be able to send or read mail until re-enabled." : "It will be able to send and read mail again."))) return;
    try {
      await api("/admin/set-disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: address, disabled: disabled }),
      });
      toast((disabled ? "Disabled " : "Enabled ") + address);
      loadAccounts(); // refresh list (re-sorts: disabled sink to bottom)
    } catch (e) {
      toast("Error: " + e.message, "error");
    }
  }

  // The Accounts-tab "+ Register new account" button opens the login-page
  // register flow (the single source of truth for registration since v0.2.12).
  // An older in-tab prompt()-based register handler used to bind this same
  // button; it was removed because it double-fired alongside the login-page
  // handler and caused "account already exists" + a confusing "local-part"
  // prompt. Registration now lives only on the login page.
  $("#btn-register").addEventListener("click", function () {
    setSession(null); // signing out to reach the login page
    showLogin();
    showRegisterForm();
  });

  // ---- mail ----

  async function ensureAccountOptions() {
    const sel = $("#mail-account");
    if (sel.dataset.loaded === "1") return;
    const s = getSession();
    // Regular users only ever see their own mail: lock the selector to self
    // and disable it (no global account picker).
    if (s && !s.is_admin) {
      sel.innerHTML = "";
      // "All visible accounts" aggregated view + per-account picks
      // (mrf2000 feedback): the pseudo-option merges own mail with every
      // subordinate's in one list; individual addresses still selectable.
      const subs = await loadSubs().catch(function () { return null; });
      const subsList = (subs && subs.subordinates) || [];
      const add = function (addr) {
        const o = document.createElement("option");
        o.value = addr; o.textContent = addr;
        sel.appendChild(o);
      };
      if (subsList.length) {
        const all = document.createElement("option");
        all.value = "__vis__"; all.textContent = t("mail.allVisible");
        sel.appendChild(all);
      }
      add(s.address);
      subsList.forEach(function (e) {
        if (e.address !== s.address) add(e.address);
      });
      // More than the own account visible: the selector switches between
      // them; single-account users get it locked to self.
      sel.disabled = sel.options.length <= 1;
      sel.dataset.loaded = "1";
      return;
    }
    try {
      const data = await api("/admin/accounts");
      sel.innerHTML = "";
      // "All accounts" pseudo-option: iterate every account on Load.
      const all = document.createElement("option");
      all.value = "__all__"; all.textContent = t("mail.allAccounts");
      sel.appendChild(all);
      (data.accounts || []).forEach(function (a) {
        const o = document.createElement("option");
        o.value = a.address; o.textContent = a.address;
        sel.appendChild(o);
      });
      if (sel.options.length <= 1) {
        const o = document.createElement("option");
        o.value = ""; o.textContent = "(no accounts)";
        sel.appendChild(o);
      }
      sel.dataset.loaded = "1";
    } catch (e) {
      toast("Load accounts failed: " + e.message, "error");
    }
  }

  $("#btn-load-mail").addEventListener("click", loadMailList);

  async function loadMailList() {
    const account = $("#mail-account").value;
    const folder = $("#mail-folder").value;
    const limit = parseInt($("#mail-limit").value, 10) || 50;
    const list = $("#mail-list");
    const detail = $("#mail-detail");
    detail.innerHTML = t("mail.selectHint");
    if (!account) { list.textContent = t("mail.noAccount"); return; }
    list.textContent = t("common.loading");
    try {
      const s = getSession();
      const isRegular = s && !s.is_admin;
      // Subordinate view (v0.5.7): a regular account browsing one of its
      // declared subordinates — summaries only (no body fetch endpoint in
      // v1), read-only, attachments as metadata.
      const isSubView = isRegular && account !== s.address;

      var msgs = [];
      // Aggregated "all visible accounts" view (mrf2000 feedback): own
      // inbox+sent merged with every subordinate's messages. Owner is
      // stamped on each message so the detail pane routes correctly.
      if (isRegular && account === "__vis__") {
        const f = folder === "all" ? "both" : folder;
        const jobs = [];
        // Own mail (regular account: own endpoints).
        jobs.push(api("/api/inbox?limit=" + limit, { keepSession: true }).then(function (d) {
          return (d.messages || []).map(function (m) { m.__owner = s.address; return m; });
        }).catch(function () { return []; }));
        jobs.push(api("/api/sent?limit=" + limit, { keepSession: true }).then(function (d) {
          return (d.messages || []).map(function (m) { m.__owner = s.address; return m; });
        }).catch(function () { return []; }));
        // Each declared subordinate (summaries).
        const subsList = (subsCache && subsCache.subordinates) || [];
        subsList.forEach(function (e) {
          jobs.push(api("/api/subs/" + encodeURIComponent(e.address) +
            "/messages?folder=" + f + "&limit=" + limit, { keepSession: true }).then(function (d) {
            return (d.messages || []).map(function (m) { m.__owner = e.address; return m; });
          }).catch(function () { return []; }));
        });
        const results = await Promise.all(jobs);
        results.forEach(function (arr) { msgs = msgs.concat(arr); });
        msgs.sort(function (a, b) { return (b.received_at || 0) - (a.received_at || 0); });
        var seenA = {}, dedupA = [];
        msgs.forEach(function (m) { if (!seenA[m.id]) { seenA[m.id] = 1; dedupA.push(m); } });
        msgs = dedupA;
      } else if (isSubView) {
        const f = folder === "all" ? "both" : folder;
        const d = await api("/api/subs/" + encodeURIComponent(account) +
          "/messages?folder=" + f + "&limit=" + limit, { keepSession: true });
        msgs = d.messages || [];
      } else if (account === "__all__" && !isRegular) {
        // Aggregated endpoint (v0.5.4): one server-side merged scan replaces
        // the old fan-out of 2 requests per account (50+ accounts = 100+
        // concurrent bbolt scans saturating the server).
        const d = await api("/admin/messages-all?limit=" + limit +
          (folder === "all" ? "" : "&folder=" + encodeURIComponent(folder)));
        msgs = d.messages || [];
      } else {
        // Single account: one or two direct queries, merged by time.
        const folders = folder === "all" ? ["inbox", "sent"] : [folder];
        const results = await Promise.all(folders.map(function (f) {
          const path = isRegular
            ? (f === "sent" ? "/api/sent?limit=" + limit : "/api/inbox?limit=" + limit)
            : (f === "sent"
                ? "/admin/sent?account=" + encodeURIComponent(account) + "&limit=" + limit
                : "/admin/messages?account=" + encodeURIComponent(account) + "&limit=" + limit);
          return api(path).then(function (d) { return d.messages || []; })
            .catch(function () { return []; });
        }));
        results.forEach(function (arr) { msgs = msgs.concat(arr); });
        msgs.sort(function (a, b) { return (b.received_at || 0) - (a.received_at || 0); });
        // De-duplicate by id (a message can appear in both inbox and sent views).
        var seen = {}, dedup = [];
        msgs.forEach(function (m) { if (!seen[m.id]) { seen[m.id] = 1; dedup.push(m); } });
        msgs = dedup;
      }

      if (!msgs.length) { list.textContent = t("mail.noMessages"); return; }
      list.innerHTML = "";
      msgs.forEach(function (m) {
        const item = document.createElement("div");
        item.className = "mail-item" + (m.unread ? " unread" : "");
        item.innerHTML =
          (m.unread ? '<span class="unread-dot" title="unread">●</span>' : "") +
          '<div class="subj">' + esc(m.subject || "(no subject)") + "</div>" +
          '<div class="meta"><b>' + t("mail.from") + "</b> '" + esc(m.from) +
          ' · <b>to:</b> ' + esc((m.to || []).join(", ")) +
          " · <small>" + fmtTime(m.received_at) + "</small></div>" +
          '<div class="prev">' + esc(m.preview || "") + "</div>";
        item.addEventListener("click", function () {
          if (isSubView) showSubDetail(account, m, item);
          else if (account === "__vis__" && m.__owner && m.__owner !== s.address)
            showSubDetail(m.__owner, m, item);
          else showDetail(m.id, item);
        });
        list.appendChild(item);
      });
      // Avoid-empty (feedback): open the newest message right after Load,
      // mirroring the Inbox preload.
      {
        const first = list.querySelector(".mail-item");
        if (first && msgs.length) first.click();
      }
    } catch (e) {
      list.textContent = t("common.error", { msg: e.message });
    }
  }

  // ---- inbox/mail mobile List|Message tabs (<=800px) ----
  // One pane visible at a time; opening a message flips to Message. The
  // buttons are hidden on desktop and the classes are inert there, so the
  // side-by-side grid is untouched.
  function mailShowPane(gridId, pane) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.classList.toggle("mshow-detail", pane === "detail");
    const tabs = document.querySelector('.mail-tabs[data-grid="' + gridId.replace("-grid", "") + '"]');
    if (!tabs) return;
    $$(".mtab", tabs).forEach(function (b) {
      b.classList.toggle("on", b.dataset.pane === pane);
    });
  }
  $$(".mail-tabs .mtab").forEach(function (b) {
    b.addEventListener("click", function () {
      const tabs = b.closest(".mail-tabs");
      mailShowPane(tabs.dataset.grid + "-grid", b.dataset.pane);
    });
  });

  // revealDetailOnMobile: on narrow screens the detail pane is a tab away —
  // flip to it when a message is opened so users see it happened. No-op on
  // desktop (PC layout unaffected).
  function revealDetailOnMobile(gridId, detailEl) {
    if (window.innerWidth > 800) return;
    mailShowPane(gridId, "detail");
  }

  // ---- compose attachments (v0.5.1) ----
  // Picked files upload immediately (multipart, Basic auth); chips show
  // name/size with a remove ×; ids join the Send body. Failed uploads
  // surface as error chips; nothing blocks composing without attachments.
  let composeAttachmentIds = [];

  function renderComposeAttachments(items) {
    const wrap = $("#compose-attachments");
    wrap.innerHTML = items.map(function (a, i) {
      return '<div class="attach-card' + (a.error ? " attach-error" : "") + '">' +
        '<span class="attach-clip">📎</span>' +
        '<span class="attach-name">' + esc(a.filename) + "</span>" +
        (a.error
          ? '<span class="attach-size">' + esc(a.error) + "</span>"
          : '<span class="attach-size">' + esc(fmtBytes(a.size)) + "</span>") +
        '<button type="button" class="attach-x" data-rm="' + i + '" title="Remove">×</button>' +
        "</div>";
    }).join("");
    $$("[data-rm]", wrap).forEach(function (btn) {
      btn.addEventListener("click", function () {
        const i = +btn.dataset.rm;
        composeAttachmentItems.splice(i, 1);
        composeAttachmentIds = composeAttachmentItems.filter(function (a) { return a.id; }).map(function (a) { return a.id; });
        renderComposeAttachments(composeAttachmentItems);
      });
    });
  }

  let composeAttachmentItems = [];

  $("#btn-attach").addEventListener("click", function () {
    $("#compose-file-input").click();
  });

  $("#compose-file-input").addEventListener("change", async function () {
    const files = Array.from(this.files || []);
    this.value = "";
    for (const f of files) {
      const item = { filename: f.name, size: f.size };
      composeAttachmentItems.push(item);
      renderComposeAttachments(composeAttachmentItems);
      try {
        const fd = new FormData();
        fd.append("file", f, f.name);
        const res = await fetch("/api/files/upload", {
          method: "POST",
          headers: { Authorization: basicAuth() },
          body: fd,
        });
        if (!res.ok) {
          let msg = res.status + " " + res.statusText;
          try { const tx = await res.text(); if (tx) msg = tx; } catch (_) {}
          throw new Error(msg);
        }
        const meta = await res.json();
        item.id = meta.id;
        item.size = meta.size;
        composeAttachmentIds = composeAttachmentItems.filter(function (a) { return a.id; }).map(function (a) { return a.id; });
        renderComposeAttachments(composeAttachmentItems);
      } catch (e) {
        item.error = (e.message || "").indexOf("too large") >= 0 ? t("attach.tooLarge") : t("attach.upFailed");
        renderComposeAttachments(composeAttachmentItems);
      }
    }
  });

  // ---- attachments (v0.5.1) ----
  // Attachment cards for message detail views. Download goes through an
  // authenticated fetch -> blob -> object URL (plain <a href> would lack the
  // Basic auth header the /api/files route requires).
  // Image attachments get an inline preview (feedback): authenticated
  // fetch -> blob -> object URL feeding an <img>. svg is deliberately
  // excluded (XSS surface, low value); unknown/failed loads fall back to
  // the plain download card without error toasts.
  const ATTACH_IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

  function attachIsImage(a) {
    return !!(a && a.filename && ATTACH_IMAGE_RE.test(a.filename));
  }

  // attachTTLBadge renders the remaining validity under the file TTL
  // (v0.5.3): "约 N 天后过期" / "已过期" once past. Absent expires_at
  // (older server) shows nothing.
  function attachTTLBadge(a) {
    if (!a || !a.expires_at) return "";
    const exp = new Date(typeof a.expires_at === "number" ? a.expires_at * 1000 : a.expires_at);
    if (isNaN(exp.getTime())) return "";
    const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
    const txt = days < 0 ? t("attach.expired") : t("attach.expiresIn", { n: days });
    return '<span class="attach-ttl' + (days < 0 ? " attach-ttl-over" : "") + '">' + txt + "</span>";
  }

  function attachmentCards(m) {
    const list = (m && m.attachments) || [];
    if (!list.length) return "";
    return '<div class="attach-list">' + list.map(function (a, i) {
      const preview = attachIsImage(a) ? '<div class="attach-preview" data-pv="' + i + '"></div>' : "";
      return '<div class="attach-card attach-card-' + (attachIsImage(a) ? "img" : "file") + '">' +
        '<span class="attach-clip">📎</span>' +
        '<span class="attach-name">' + esc(a.filename) + "</span>" +
        '<span class="attach-size">' + esc(fmtBytes(a.size)) + "</span>" +
        attachTTLBadge(a) +
        '<button class="row-action" data-dl="' + i + '">Download</button>' +
        preview +
        "</div>";
    }).join("") + "</div>";
  }

  // hydrateAttachmentPreviews loads image blobs (authenticated) into the
  // preview holders. Clicking a preview triggers the same download flow.
  function hydrateAttachmentPreviews(root, m) {
    const list = (m && m.attachments) || [];
    $$(".attach-preview", root).forEach(async function (holder) {
      const a = list[+holder.dataset.pv];
      if (!a) return;
      try {
        const res = await fetch("/api/files/" + encodeURIComponent(a.id) + "/download?code=" + encodeURIComponent(a.access_code), {
          headers: { Authorization: basicAuth() },
        });
        if (!res.ok) throw new Error(res.status);
        // The download endpoint serves everything as octet-stream (correct
        // for downloads); an <img> refuses that MIME even via objectURL.
        // Rebuild the blob with the extension-mapped image type.
        const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
        const ext = (/[.]([a-z0-9]+)$/i.exec(a.filename || "") || [])[1];
        const mime = IMG_MIME[(ext || "").toLowerCase()];
        if (!mime) throw new Error("not an image");
        const blob = new Blob([await res.arrayBuffer()], { type: mime });
        const url = URL.createObjectURL(blob);
        const img = document.createElement("img");
        img.src = url;
        img.alt = a.filename;
        img.title = t("attach.clickToDownload");
        img.addEventListener("click", function () {
          const btn = holder.closest(".attach-card").querySelector("[data-dl]");
          if (btn) btn.click();
        });
        holder.appendChild(img);
        // The detail pane re-renders on message switch; drop the URL then.
        setTimeout(function () { URL.revokeObjectURL(url); }, 10 * 60 * 1000);
      } catch (_) {
        // Silent fallback: leave the card as a plain download row.
        holder.remove();
      }
    });
  }

  function wireAttachmentDownloads(root, m) {
    const list = (m && m.attachments) || [];
    $$(".attach-card [data-dl]", root).forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const a = list[+btn.dataset.dl];
        if (!a) return;
        btn.disabled = true;
        try {
          const res = await fetch("/api/files/" + encodeURIComponent(a.id) + "/download?code=" + encodeURIComponent(a.access_code), {
            headers: { Authorization: basicAuth() },
          });
          if (!res.ok) throw new Error(res.status + " " + res.statusText);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = a.filename || "attachment";
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        } catch (e) {
          toast(t("attach.dlFailed") + e.message, "error");
        }
        btn.disabled = false;
      });
    });
  }

  async function showDetail(id, item) {
    $$(".mail-item", $("#mail-list")).forEach(function (el) { el.classList.remove("selected"); });
    if (item) item.classList.add("selected");
    const detail = $("#mail-detail");
    detail.textContent = t("common.loading");
    revealDetailOnMobile("mail-grid", detail);
    // Locally mark the item as read (UI feedback) immediately.
    if (item) {
      item.classList.remove("unread");
      const dot = $(".unread-dot", item);
      if (dot) dot.remove();
    }
    try {
      // Regular accounts read their own mail via /api/message (the admin
      // endpoint would 401 and reset the session — live bug in the regular
      // Mail-tab self-view since v0.5.7).
      const viewer = getSession();
      const detailPath = (viewer && !viewer.is_admin)
        ? "/api/message?id=" + encodeURIComponent(id)
        : "/admin/message?id=" + encodeURIComponent(id);
      const m = await api(detailPath);
      detail.innerHTML =
        '<div class="detail-row"><b>From:</b> ' + esc(m.from) + "</div>" +
        '<div class="detail-row"><b>To:</b> ' + esc((m.to || []).join(", ")) + "</div>" +
        (m.cc && m.cc.length ? '<div class="detail-row"><b>Cc:</b> ' + esc(m.cc.join(", ")) + "</div>" : "") +
        '<div class="detail-row"><b>Subject:</b> ' + esc(m.subject || "") + "</div>" +
        '<div class="detail-row"><b>Date:</b> ' + fmtTime(m.received_at) + "</div>" +
        '<div class="detail-row"><b>ID:</b> <code>' + esc(m.id) + "</code></div>" +
        "<hr><pre class=\"body\">" + esc(m.body || "") + "</pre>" +
        '<div class="row" style="margin-top:12px;"><button class="row-action" id="btn-mail-forward">' + t("act.forward") + "</button></div>" +
        attachmentCards(m);
      wireAttachmentDownloads(detail, m);
      hydrateAttachmentPreviews(detail, m);
      const fwdBtn = $("#btn-mail-forward");
      if (fwdBtn) fwdBtn.addEventListener("click", function () { composeForward(m); });
    } catch (e) {
      detail.textContent = t("common.error", { msg: e.message });
    }
  }

  // ---- subordinates (v0.5.7) ----
  // Self-declared directed edges: A declares itself a subordinate of B, so B
  // can browse A's mail (read-only, attachments metadata only). This module
  // backs both the Accounts-tab relationship manager and the Mail-tab
  // optgroup + read-only detail view.
  // GET /api/subs → {subordinates: [edges under me], superiors: [edges I declared]}

  let subsCache = null; // {subordinates: [], superiors: []} or null

  async function loadSubs(force) {
    if (subsCache && !force) return subsCache;
    const d = await api("/api/subs", { keepSession: true });
    subsCache = { subordinates: d.subordinates || [], superiors: d.superiors || [] };
    renderSubsUI();
    return subsCache;
  }

  // renderSubsUI fills the Accounts-tab "Subordinate relationships" block:
  // my declarations (revocable) plus the collapsed read-only list.
  function renderSubsUI() {
    const section = $("#subs-section");
    if (!section || !subsCache) return;
    const mine = $("#subs-mine");
    if (!subsCache.superiors.length) {
      mine.innerHTML = '<p class="muted">' + t("subs.noneMine") + "</p>";
    } else {
      mine.innerHTML = "<h4>" + t("subs.mineTitle") + "</h4>" + subsCache.superiors.map(function (e) {
        return '<div class="row" style="justify-content:space-between;">' +
          "<span>" + esc(e.address) + ' <small class="muted">' + t("subs.since") + " " + fmtTime(e.created_at) + "</small></span>" +
          '<button class="row-action" data-revoke-sub="' + esc(e.address) + '">' + t("subs.revoke") + "</button>" +
          "</div>";
      }).join("");
      $$("[data-revoke-sub]", mine).forEach(function (btn) {
        btn.addEventListener("click", function () { revokeSub(btn.dataset.revokeSub); });
      });
    }
  }

  async function declareSub(address) {
    const status = $("#subs-status");
    status.textContent = t("common.loading");
    try {
      await api("/api/subs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ superior: address, scope: "both" }),
      });
      status.textContent = t("subs.declared");
      $("#subs-declare-input").value = "";
      await loadSubs(true);
      loadAccounts(); // refresh badges
      invalidateMailAccountOptions();
    } catch (e) {
      status.textContent = "";
      toast(e.message, "error"); // 429/404 surface the server text verbatim
    }
  }

  async function revokeSub(address) {
    try {
      await api("/api/subs?superior=" + encodeURIComponent(address), { method: "DELETE" });
      toast(t("subs.revoked"));
      await loadSubs(true);
      loadAccounts();
      invalidateMailAccountOptions();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // invalidateMailAccountOptions forces the Mail-tab selector rebuild on the
  // next visit (edges changed).
  function invalidateMailAccountOptions() {
    const sel = $("#mail-account");
    if (sel) delete sel.dataset.loaded;
  }

  $("#btn-subs-declare").addEventListener("click", function () {
    const v = ($("#subs-declare-input").value || "").trim();
    if (!v) return;
    declareSub(v);
  });
  $("#subs-declare-input").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") $("#btn-subs-declare").click();
  });

  // showSubDetail renders the read-only detail pane for a subordinate's
  // message. Fetches the full body via GET /api/subs/{A}/message?id= (v0.5.7.1
  // server); on failure falls back to the summary (preview). Attachments stay
  // metadata-only either way (Q2: no download).
  async function showSubDetail(subAddr, m, item) {
    $$(".mail-item", $("#mail-list")).forEach(function (el) { el.classList.remove("selected"); });
    if (item) item.classList.add("selected");
    const detail = $("#mail-detail");
    revealDetailOnMobile("mail-grid", detail);
    if (item) {
      item.classList.remove("unread");
      const dot = $(".unread-dot", item);
      if (dot) dot.remove();
    }
    detail.innerHTML = '<div class="muted">' + t("common.loading") + "</div>";
    let full = null;
    try {
      const d = await api("/api/subs/" + encodeURIComponent(subAddr) +
        "/message?id=" + encodeURIComponent(m.id), { keepSession: true });
      full = d.message || null;
    } catch (_) { /* fall back to summary-level rendering */ }
    const msg = full || m; // full has body/cc/attachments; summary has preview/files
    // Received mail (sender ≠ the subordinate): offer "reply as myself".
    // Sent mail by the subordinate gets no reply affordance.
    const canReply = msg.from && msg.from !== subAddr;
    const atts = (msg.attachments || []);
    detail.innerHTML =
      '<div class="detail-row"><span class="badge-sub">' + t("subs.badge") + "</span> " +
      esc(subAddr) + ' · <i class="muted">' + t("subs.readonly") + "</i></div>" +
      '<div class="detail-row"><b>From:</b> ' + esc(msg.from) + "</div>" +
      '<div class="detail-row"><b>To:</b> ' + esc((msg.to || []).join(", ")) + "</div>" +
      (msg.cc && msg.cc.length ? '<div class="detail-row"><b>Cc:</b> ' + esc(msg.cc.join(", ")) + "</div>" : "") +
      '<div class="detail-row"><b>Subject:</b> ' + esc(msg.subject || "") + "</div>" +
      '<div class="detail-row"><b>Date:</b> ' + fmtTime(msg.received_at) + "</div>" +
      '<div class="detail-row"><b>ID:</b> <code>' + esc(msg.id) + "</code></div>" +
      (atts.length
        ? '<div class="attach-list">' + atts.map(function (a) {
            return '<div class="attach-card attach-card-file">' +
              '<span class="attach-clip">📎</span>' +
              '<span class="attach-name">' + esc(a.filename) + "</span>" +
              '<span class="attach-size">' + esc(fmtBytes(a.size)) + "</span>" +
              '<span class="muted">' + t("subs.attachNoDl") + "</span></div>";
          }).join("") + "</div>"
        : (m.files ? '<div class="detail-row">📎 ' + m.files + t("subs.attachMeta") + "</div>" : "")) +
      "<hr><pre class=\"body\">" + esc(msg.body != null ? msg.body : (msg.preview || "")) + "</pre>" +
      (canReply
        ? '<div class="row" style="margin-top:12px;"><button class="primary" id="btn-reply-as-self">' +
          t("subs.replyAsSelf") + "</button></div>"
        : "");
    const rbtn = $("#btn-reply-as-self");
    if (rbtn) rbtn.addEventListener("click", function () { composeReplyAsSelf(msg); });
  }

  // composeReplyAsSelf: the superior replies in their own name to the
  // subordinate's correspondent, quoting the original (full body when the
  // detail endpoint answered; preview text as fallback).
  function composeReplyAsSelf(m) {
    $("#compose-to").value = m.from || "";
    var subj = (m.subject || "").trim();
    $("#compose-subject").value = /^re:\s*/i.test(subj) ? subj : (subj ? "Re: " + subj : "");
    const text = (m.body != null ? m.body : m.preview) || "";
    const quoted = text.split("\n").map(function (l) { return "> " + l; }).join("\n");
    $("#compose-body").value = t("subs.quotePrefix", { date: fmtTime(m.received_at), sender: m.from }) + "\n" + quoted + "\n\n";
    activateTab("compose");
    loadComposeThread();
    $("#compose-body").focus();
  }

  // ---- inbox (personal, all users) ----

  // loadInbox fills the left pane with the caller's own inbox. Regular accounts
  // read /api/inbox; admins read their own inbox via /admin/messages (self).
  // Inbox paging state. The personal Inbox tab reads the caller's own inbox
  // via /api/inbox (admins satisfy account auth too), which supports offset.
  const INBOX_PAGE_SIZE = 20;
  let inboxPage = 0;

  async function loadInbox(page) {
    if (typeof page === "number") inboxPage = page;
    if (inboxPage < 0) inboxPage = 0;
    const offset = inboxPage * INBOX_PAGE_SIZE;
    const list = $("#inbox-list");
    const detail = $("#inbox-detail");
    const status = $("#inbox-status");
    detail.innerHTML = t("mail.selectHint");
    status.textContent = t("common.loading");
    list.textContent = "";
    // Both admins and regular accounts read their own inbox via /api/inbox
    // (the admin credential satisfies account auth). showInboxDetail uses the
    // same account path to fetch a message body.
    try {
      const data = await api("/api/inbox?limit=" + INBOX_PAGE_SIZE + "&offset=" + offset);
      const msgs = data.messages || [];
      const unreadCount = data.unread_count || 0;
      const total = data.total_count || 0;
      const totalPages = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
      if (!msgs.length && inboxPage === 0) {
        list.textContent = t("mail.noMessages");
        updateInboxPager(1, 1);
        status.textContent = unreadCount ? (unreadCount + " unread") : "";
        return;
      }
      if (!msgs.length) {
        // Past the end (e.g. mail was deleted): clamp to last page.
        const last = totalPages - 1;
        if (inboxPage > last) { inboxPage = last; loadInbox(inboxPage); return; }
        list.textContent = t("mail.noMore");
        updateInboxPager(totalPages, inboxPage + 1);
        status.textContent = "";
        return;
      }
      list.innerHTML = "";
      msgs.forEach(function (m) {
        const item = document.createElement("div");
        item.className = "mail-item" + (m.unread ? " unread" : "");
        item.innerHTML =
          (m.unread ? '<span class="unread-dot" title="unread">●</span>' : "") +
          '<div class="subj">' + esc(m.subject || "(no subject)") + "</div>" +
          '<div class="meta"><b>' + t("mail.from") + "</b> '" + esc(m.from) +
          " · <small>" + fmtTime(m.received_at) + "</small></div>" +
          '<div class="prev">' + esc(m.preview || "") + "</div>";
        item.addEventListener("click", function () { showInboxDetail(m.id, item, false); });
        list.appendChild(item);
      });
      updateInboxPager(totalPages, inboxPage + 1);
      status.textContent = msgs.length + " on this page · " + total + " total" + (unreadCount ? " · " + unreadCount + " unread" : "");
      // Direct write with sequencing: supersede any in-flight poll so a
      // stale "unread" response cannot re-light the dot after this point.
      badgeSeq++;
      setInboxBadge(unreadCount);
      // Avoid the empty detail pane (feedback): preload the newest message.
      // Desktop shows it right away; mobile stays on the List tab (the
      // detail is preloaded behind it and opens on tap as usual).
      {
        const first = list.querySelector(".mail-item");
        const newest = msgs[0];
        if (first && newest) {
          showInboxDetail(newest.id, first, true).then(function () {
            // The preload read the newest message server-side — pull the
            // badge right away instead of waiting for the 5s tick
            // (admin: opening the inbox should clear the dot immediately).
            refreshInboxBadge();
          });
        }
      }
    } catch (e) {
      list.textContent = t("common.error", { msg: e.message });
      status.textContent = "";
    }
  }

  // ---- mark all read (approved): server endpoint first, loop fallback ----
  $("#btn-mark-all").addEventListener("click", async function () {
    if (!confirm(t("inbox.markAllConfirm"))) return;
    const status = $("#inbox-status");
    const btn = $("#btn-mark-all");
    btn.disabled = true;
    try {
      try {
        await api("/api/inbox/mark-all-read", { method: "POST" });
      } catch (e) {
        // Endpoint absent (older server): page through the inbox and read
        // each unread message via /api/message — slower but same effect.
        if (String(e.message).indexOf("404") === -1) throw e;
        let offset = 0, marked = 0;
        for (;;) {
          const d = await api("/api/inbox?limit=50&offset=" + offset);
          const unread = (d.messages || []).filter(function (m) { return m.unread; });
          for (const m of unread) {
            await api("/api/message?id=" + encodeURIComponent(m.id));
            marked++;
            status.textContent = t("inbox.markAllProgress", { n: marked });
          }
          offset += 50;
          if (offset >= (d.total_count || 0)) break;
        }
      }
      status.textContent = t("inbox.markAllDone");
      toast(t("inbox.markAllDone"));
      await loadInbox(0);
      refreshInboxBadge();
    } catch (e) {
      status.textContent = t("common.error", { msg: e.message });
    }
    btn.disabled = false;
  });

  // updateInboxPager enables/disables prev/next and sets the page input +
  // "of N" label. totalPages is computed from total_count; currentPage is 1-based.
  function updateInboxPager(totalPages, currentPage) {
    if (totalPages < 1) totalPages = 1;
    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages) currentPage = totalPages;
    const prev = $("#btn-inbox-prev");
    const next = $("#btn-inbox-next");
    const input = $("#inbox-page-input");
    const totalLabel = $("#inbox-page-total");
    prev.disabled = currentPage <= 1;
    next.disabled = currentPage >= totalPages;
    input.max = String(totalPages);
    input.value = String(currentPage);
    totalLabel.textContent = "of " + totalPages;
  }

  $("#btn-load-inbox").addEventListener("click", function () { loadInbox(0); });
  $("#btn-inbox-prev").addEventListener("click", function () { if (inboxPage > 0) loadInbox(inboxPage - 1); });
  $("#btn-inbox-next").addEventListener("click", function () { loadInbox(inboxPage + 1); });
  // Jump-to-page: on Enter or blur, clamp and load the typed page (1-based).
  $("#inbox-page-input").addEventListener("change", function () {
    const input = $("#inbox-page-input");
    let p = parseInt(input.value, 10);
    const max = parseInt(input.max, 10) || 1;
    if (isNaN(p) || p < 1) p = 1;
    if (p > max) p = max;
    input.value = String(p);
    loadInbox(p - 1); // loadInbox is 0-based
  });

  // inboxStepNav (v0.5.4): 上一封/下一封 along the current list order; at a
  // page edge it flips the pager and opens the boundary message. The nav row
  // lives atop the detail pane (CSS shows it only <=800px on phones).
  function inboxStepNav(item, dir) {
    const items = $$(".mail-item", $("#inbox-list"));
    const idx = items.indexOf(item);
    const nextIdx = idx + dir;
    if (nextIdx >= 0 && nextIdx < items.length) {
      items[nextIdx].click();
      return;
    }
    const page = dir < 0 ? inboxPage - 1 : inboxPage + 1;
    if (page < 0) { toast(t("inbox.noNewer"), "error"); return; }
    loadInbox(page).then(function () {
      const fresh = $$(".mail-item", $("#inbox-list"));
      const target = dir < 0 ? fresh[fresh.length - 1] : fresh[0];
      if (target) target.click();
      else toast(t("inbox.noMore"), "error");
    });
  }

  function inboxNavRow() {
    return '<div class="row inbox-nav" style="margin:0 0 8px; justify-content:space-between;">' +
      '<button class="row-action" data-nav="-1">↑ ' + t("inbox.prev") + "</button>" +
      '<button class="row-action" data-nav="1">' + t("inbox.next") + " ↓</button>" +
      "</div>";
  }

  async function showInboxDetail(id, item, auto) {
    $$(".mail-item", $("#inbox-list")).forEach(function (el) { el.classList.remove("selected"); });
    if (item) item.classList.add("selected");
    const detail = $("#inbox-detail");
    detail.innerHTML = inboxNavRow();
    const navPrev = $('[data-nav="-1"]', detail), navNext = $('[data-nav="1"]', detail);
    if (navPrev) navPrev.addEventListener("click", function () { inboxStepNav(item, -1); });
    if (navNext) navNext.addEventListener("click", function () { inboxStepNav(item, 1); });
    detail.insertAdjacentHTML("beforeend", '<div class="inbox-loading">' + t("common.loading") + "</div>");
    // Auto-preload (newest message on inbox load) stays on the List tab on
    // mobile — only a user tap flips to Message.
    if (!auto) revealDetailOnMobile("inbox-grid", detail);
    if (item) {
      item.classList.remove("unread");
      const dot = $(".unread-dot", item);
      if (dot) dot.remove();
    }
    try {
      // The Inbox tab is the viewer's own mail, so /api/message works for both
      // roles (admin satisfies account auth).
      const m = await api("/api/message?id=" + encodeURIComponent(id));
      // Final render includes the nav row (earlier only the loading frame
      // had it — data arrival wiped it; feedback root cause).
      detail.innerHTML = inboxNavRow() +
        '<div class="detail-row"><b>From:</b> ' + esc(m.from) + "</div>" +
        '<div class="detail-row"><b>To:</b> ' + esc((m.to || []).join(", ")) + "</div>" +
        (m.cc && m.cc.length ? '<div class="detail-row"><b>Cc:</b> ' + esc(m.cc.join(", ")) + "</div>" : "") +
        '<div class="detail-row"><b>Subject:</b> ' + esc(m.subject || "") + "</div>" +
        '<div class="detail-row"><b>Date:</b> ' + fmtTime(m.received_at) + "</div>" +
        '<div class="detail-row"><button class="row-action" id="btn-inbox-reply" data-reply-to="' + esc(m.from) + '" data-reply-subject="' + esc(m.subject || "") + '">Reply</button>' +
        '<button class="row-action" id="btn-inbox-forward" style="margin-left:8px;">' + t("act.forward") + "</button></div>" +
        "<hr><pre class=\"body\">" + esc(m.body || "") + "</pre>" + attachmentCards(m);
      wireAttachmentDownloads(detail, m);
      hydrateAttachmentPreviews(detail, m);
      refreshInboxBadge();
      {
        const p1 = $('[data-nav="-1"]', detail), n1 = $('[data-nav="1"]', detail);
        if (p1) p1.addEventListener("click", function () { inboxStepNav(item, -1); });
        if (n1) n1.addEventListener("click", function () { inboxStepNav(item, 1); });
      }
      const replyBtn = $("#btn-inbox-reply");
      if (replyBtn) replyBtn.addEventListener("click", function () {
        composeReply(replyBtn.dataset.replyTo, replyBtn.dataset.replySubject);
      });
      const fwdBtn = $("#btn-inbox-forward");
      if (fwdBtn) fwdBtn.addEventListener("click", function () { composeForward(m); });
    } catch (e) {
      // Keep the nav row on errors too — the reader can still step away.
      detail.innerHTML = inboxNavRow() + '<p class="muted">' + esc(t("common.error", { msg: e.message })) + "</p>";
      const p1 = $('[data-nav="-1"]', detail), n1 = $('[data-nav="1"]', detail);
      if (p1) p1.addEventListener("click", function () { inboxStepNav(item, -1); });
      if (n1) n1.addEventListener("click", function () { inboxStepNav(item, 1); });
    }
  }

  // ---- audit ----

  async function loadAudit() {
    const tbody = $("#audit-table tbody");
    tbody.textContent = "";
    try {
      const data = await api("/admin/audit?limit=100");
      const entries = data.entries || [];
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="4">No entries.</td></tr>';
        return;
      }
      tbody.innerHTML = entries.map(function (e) {
        return "<tr>" +
          "<td>" + fmtTime(e.timestamp) + "</td>" +
          "<td><code>" + esc(e.action) + "</code></td>" +
          "<td>" + esc(e.account || "—") + "</td>" +
          "<td>" + esc(e.detail || "") + "</td>" +
          "</tr>";
      }).join("");
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="4">Error: ' + esc(e.message) + "</td></tr>";
    }
  }

  // ---- directory (public address book) ----

  async function loadDirectory() {
    const tbody = $("#directory-table tbody");
    tbody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
    try {
      const data = await api("/api/info?query=directory");
      const entries = data.entries || [];
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="3">No visible accounts yet.</td></tr>';
        return;
      }
      tbody.innerHTML = entries.map(function (e) {
        return "<tr>" +
          '<td class="addr-cell">' + esc(e.address) + "</td>" +
          '<td class="sig-cell">' + esc(e.signature || "") + "</td>" +
          '<td class="actions-cell"><button class="row-action" data-compose="' + esc(e.address) + '">' + t("act.compose") + '</button></td>' +
          "</tr>";
      }).join("");
      $$("[data-compose]", tbody).forEach(function (btn) {
        btn.addEventListener("click", function () { composeTo(btn.dataset.compose); });
      });
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="3">Error: ' + esc(e.message) + "</td></tr>";
    }
  }

  // ---- profile (edit your own visibility + signature) ----

  async function loadProfile() {
    const status = $("#profile-status");
    status.textContent = t("common.loading");
    status.className = "muted";
    try {
      const p = await api("/api/profile/self");
      $("#profile-visible").checked = !!p.visible;
      $("#profile-signature").value = p.signature || "";
      status.textContent = "";
      // Attachment quota (v0.5.3): used bytes come from THIS endpoint's
      // response (p — /api/profile/self carries files_used_bytes); the cap
      // from public settings. Reading /api/account/info here was wrong
      // (that MCP-side endpoint has no usage field).
      try {
        const set = await api("/api/info?query=settings").catch(function () { return null; });
        const used = p.files_used_bytes;
        const cap = set && set.file_quota_per_acct;
        const row = $("#attach-quota-row");
        if (row && typeof used === "number" && typeof cap === "number" && cap > 0) {
          $("#attach-quota-value").textContent = fmtBytes(used) + " / " + fmtBytes(cap) +
            (used >= cap ? " (" + t("attach.quotaFull") + ")" : "");
          row.style.display = "";
        }
      } catch (_) { /* quota row is optional */ }
    } catch (e) {
      status.textContent = t("common.error", { msg: e.message });
    }
  }

  async function saveProfile() {
    const status = $("#profile-status");
    const btn = $("#btn-save-profile");
    btn.disabled = true;
    status.textContent = t("set.saving");
    status.className = "muted";
    try {
      const body = {
        visible: $("#profile-visible").checked,
        signature: $("#profile-signature").value,
      };
      const res = await api("/api/profile/self", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      $("#profile-signature").value = res.signature || "";
      status.textContent = t("set.saved");
      toast("Profile saved");
    } catch (e) {
      status.textContent = t("common.error", { msg: e.message });
    } finally {
      btn.disabled = false;
    }
  }

  $("#btn-refresh-directory").addEventListener("click", loadDirectory);
  $("#btn-save-profile").addEventListener("click", saveProfile);

  // ---- settings ----

  // Showcase per-item removal — search-style (feedback): admin enters an id,
  // Find fetches it (GET /admin/showcase-item?id=), the preview shows the
  // letter, Delete removes it (POST /admin/delete-showcase-item) and clears
  // the preview. 404 reports "id not found".
  let showcaseFoundId = null;

  function renderShowcaseItemPreview(m) {
    const prev = $("#showcase-item-preview");
    const del = $("#btn-delete-showcase-item");
    showcaseFoundId = (m && m.id) || null;
    if (!m) {
      prev.innerHTML = "";
      if (del) del.classList.add("hidden");
      return;
    }
    // The endpoint returns received_at (not ts) and omits body — accept both.
    const ts = m.ts || m.received_at;
    prev.innerHTML = '<div class="sc-item" style="cursor:default;margin-top:8px;">' +
      '<div class="sc-meta">' + esc(m.from) + (ts ? " · " + esc(fmtTime(ts)) : "") + "</div>" +
      '<div class="sc-subj">' + esc(m.subject) + "</div>" +
      (m.body ? '<div class="muted" style="font-size:12px;">' + esc(m.body) + "</div>" : "") +
      "</div>";
    if (del) del.classList.remove("hidden");
  }

  $("#btn-search-showcase-item").addEventListener("click", async function () {
    const id = ($("#showcase-id-input").value || "").trim();
    const btn = $("#btn-search-showcase-item");
    if (!id) { renderShowcaseItemPreview(null); return; }
    btn.disabled = true;
    try {
      const res = await api("/admin/showcase-item?id=" + encodeURIComponent(id));
      // Accept both {item:{...}} and a flat item object.
      const m = (res && res.item) || res;
      renderShowcaseItemPreview(m && m.id ? m : null);
      if (!m || !m.id) toast(t("toast.idNotFound"), "error");
    } catch (e) {
      renderShowcaseItemPreview(null);
      toast(/404|not found/i.test(e.message || "") ? "id not found" : "Search failed: " + e.message, "error");
    }
    btn.disabled = false;
  });

  $("#btn-delete-showcase-item").addEventListener("click", async function () {
    if (!showcaseFoundId) return;
    const btn = $("#btn-delete-showcase-item");
    btn.disabled = true;
    try {
      await api("/admin/delete-showcase-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: showcaseFoundId }),
      });
      $("#showcase-id-input").value = "";
      renderShowcaseItemPreview(null);
      toast(t("toast.letterRemoved"), "success");
    } catch (e) {
      toast("Delete failed: " + e.message, "error");
    }
    btn.disabled = false;
  });

  async function loadSettings() {
    try {
      const s = await api("/admin/settings");
      const regStatus = $("#reg-status");
      const regBtn = $("#btn-toggle-registration");
      if (s.registration_enabled) {
        regStatus.textContent = t("set.regOpen");
        regBtn.textContent = t("set.regDisable");
      } else {
        regStatus.textContent = t("set.regClosed");
        regBtn.textContent = t("set.regEnable");
      }
      regBtn.classList.remove("hidden");

      // Directory-listed toggle.
      const listedStatus = $("#listed-status");
      const listedBtn = $("#btn-toggle-listed");
      if (s.directory_listed_enabled) {
        listedStatus.textContent = t("set.listedOpen");
        listedBtn.textContent = t("set.listedDisable");
      } else {
        listedStatus.textContent = t("set.listedClosed");
        listedBtn.textContent = t("set.listedEnable");
      }
      listedBtn.classList.remove("hidden");

      $("#send-rate-input").value = s.send_rate;
      $("#byte-rate-input").value = Math.round(s.byte_rate / 1048576 * 100) / 100; // bytes → MB
      $("#register-rate-input").value = s.register_rate;

      // Attachment storage limits (MB).
      if (s.file_quota_per_acct != null) $("#files-quota-input").value = Math.round(s.file_quota_per_acct / 1048576);
      if (s.files_total_limit != null) $("#files-total-input").value = Math.round(s.files_total_limit / 1048576);
      // Danmaku defaults (v0.4.10). Absent fields keep the built-in default.
      if (s.danmaku_default_mode) $("#dm-default-mode").value = s.danmaku_default_mode;
      if (s.danmaku_default_speed) $("#dm-default-speed").value = s.danmaku_default_speed;
      if (s.danmaku_default_count) $("#dm-default-count").value = s.danmaku_default_count;
    } catch (e) {
      $("#reg-status").textContent = t("common.error", { msg: e.message });
    }
  }

  // Save attachment limits (v0.5.7): MB in the UI, bytes on the wire.
  $("#btn-save-files").addEventListener("click", async function () {
    const status = $("#files-status");
    const btn = $("#btn-save-files");
    const quota = parseInt($("#files-quota-input").value, 10);
    const total = parseInt($("#files-total-input").value, 10);
    if (!quota || quota < 1 || !total || total < 1) { status.textContent = "Enter MB values (>= 1)."; return; }
    btn.disabled = true;
    status.textContent = t("set.saving");
    try {
      await api("/admin/set-limits", { // file limits ride set-limits (fields identical)
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_quota_per_acct: quota * 1048576, files_total_limit: total * 1048576 }),
      });
      status.textContent = t("set.saved");
      toast(t("toast.saved"), "success");
    } catch (e) {
      status.textContent = t("common.error", { msg: e.message });
    }
    btn.disabled = false;
  });

  // Save danmaku site defaults (v0.4.10): visitors who haven't set their own
  // preference start from these.
  $("#btn-save-danmaku").addEventListener("click", async function () {
    const status = $("#danmaku-admin-status");
    const btn = $("#btn-save-danmaku");
    btn.disabled = true;
    status.textContent = t("set.saving");
    try {
      await api("/admin/set-danmaku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: $("#dm-default-mode").value,
          speed: $("#dm-default-speed").value,
          count: $("#dm-default-count").value,
        }),
      });
      status.textContent = t("set.saved");
      toast(t("toast.saved"), "success");
    } catch (e) {
      status.textContent = "Save failed: " + e.message;
      toast(t("toast.saveFailed"), "error");
    }
    btn.disabled = false;
  });

  $("#btn-toggle-registration").addEventListener("click", async function () {
    try {
      const cur = await api("/admin/settings");
      const next = !cur.registration_enabled;
      await api("/admin/set-registration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      toast(next ? "Registration enabled" : "Registration disabled");
      loadSettings();
    } catch (e) {
      toast("Error: " + e.message, "error");
    }
  });

  $("#btn-toggle-listed").addEventListener("click", async function () {
    try {
      const cur = await api("/admin/settings");
      const next = !cur.directory_listed_enabled;
      await api("/admin/set-directory-listed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      toast(next ? "Directory listing enabled" : "Directory listing disabled");
      loadSettings();
    } catch (e) {
      toast("Error: " + e.message, "error");
    }
  });

  // Clear showcase (v0.4.5): wipe every public letter from the portal.
  // Irreversible, so confirm first; the result line reports how many went.
  $("#btn-clear-showcase").addEventListener("click", async function () {
    if (!window.confirm("Remove ALL public letters from the portal? This cannot be undone.")) return;
    const status = $("#showcase-admin-status");
    const btn = $("#btn-clear-showcase");
    btn.disabled = true;
    status.textContent = t("set.clearing");
    try {
      const res = await api("/admin/clear-showcase", { method: "POST" });
      const n = (res && (res.cleared != null ? res.cleared : res.count)) || 0;
      status.textContent = t("set.clearedN", { n: n });
      toast(t("toast.showcaseCleared", { n: n }), "success");
    } catch (e) {
      status.textContent = "Clear failed: " + e.message;
      toast(t("toast.clearFailed"), "error");
    }
    btn.disabled = false;
  });

  $("#btn-save-limits").addEventListener("click", async function () {
    const sendRate = parseInt($("#send-rate-input").value, 10);
    const byteMB = parseFloat($("#byte-rate-input").value);
    const byteRate = Math.round(byteMB * 1048576);
    const registerRate = parseInt($("#register-rate-input").value, 10);
    if (!sendRate || sendRate < 1 || !byteRate || byteRate < 1 ||
        isNaN(registerRate) || registerRate < 0) {
      $("#limits-status").textContent = "Invalid values";
      return;
    }
    try {
      await api("/admin/set-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ send_rate: sendRate, byte_rate: byteRate, register_rate: registerRate }),
      });
      $("#limits-status").textContent = "✓ Saved";
      toast("Limits saved");
    } catch (e) {
      $("#limits-status").textContent = t("common.error", { msg: e.message });
    }
  });

  // ---- init ----

  // Check initialization state; show setup wizard, login page, or app.
  async function init() {
    // i18n (v0.4.12): apply the detected language to static text before the
    // first paint settles, then keep dynamic regions in sync on switch.
    if (window.I18N) {
      window.I18N.applyI18nDOM(document);
      const toggleLang = function () {
        window.I18N.setLang(window.I18N.lang() === "zh" ? "en" : "zh");
      };
      const panelBtn = $("#btn-lang");
      if (panelBtn) panelBtn.addEventListener("click", toggleLang);
      const portalBtn = $("#btn-portal-lang");
      if (portalBtn) portalBtn.addEventListener("click", toggleLang);
      document.addEventListener("i18n:change", function () {
        // Re-render whatever view is active so JS-built text follows.
        if (!$("#portal-page").classList.contains("hidden")) loadPortal();
        else if (!$("#app-header").classList.contains("hidden")) {
          const active = $(".tab.active");
          if (active) activateTab(active.dataset.tab);
        }
      });
    }
    try {
      const st = await api("/api/status");
      if (st.domain) systemDomain = st.domain;
      if (st.version) {
        const v = "v" + st.version.replace(/^v/, "");
        $("#version-badge").textContent = v;
        const pv = $("#portal-version");
        if (pv) pv.textContent = v;
      }
      if (!st.initialized) {
        showSetup();
        return;
      }
      // Initialized: if we have cached creds, verify them; else show the
      // guest portal (public overview) — login is reachable from there.
      if (getSession()) {
        try {
          const me = await api("/api/account/info?query=self");
          // Refresh the cached role in case it changed server-side.
          const s = getSession(); s.is_admin = !!me.is_admin; setSession(s);
          showApp(me.is_admin);
          activateTab("overview");
        } catch (e) {
          // Verification failed (401 already cleared session + showed login).
          showLogin();
        }
      } else {
        showPortal();
      }
    } catch (e) {
      // If /api/status itself fails, show login (server may be mid-restart).
      showLogin();
    }
  }

  function hideAllScreens() {
    $("#setup-page").classList.add("hidden");
    $("#login-page").classList.add("hidden");
    $("#portal-page").classList.add("hidden");
    $("#app-header").classList.add("hidden");
    document.querySelector("main").classList.add("hidden");
    // Portal decorations are body-level; drop them whenever we leave a view.
    $$(".portal-particle").forEach(function (el) { el.remove(); });
  }

  function showSetup() {
    hideAllScreens();
    $("#setup-page").classList.remove("hidden");
  }

  // ---- guest portal (public landing page) ----

  // showPortal is the landing screen for guests (no cached credentials).
  // It shows public data only: stats, message growth, the directory, and
  // entry points to login/register. No authenticated call is made.
  function showPortal() {
    hideAllScreens();
    $("#portal-page").classList.remove("hidden");
    loadPortal();
  }

  // loadPortal fills the portal from public endpoints. Each block fails
  // independently: one broken API never blanks the whole page.
  async function loadPortal() {
    const [statsRes, growthRes, dirRes, setRes] = await Promise.all([
      api("/api/info?query=stats").catch(function () { return null; }),
      api("/api/info?query=growth").catch(function () { return null; }),
      api("/api/info?query=directory").catch(function () { return null; }),
      api("/api/info?query=settings").catch(function () { return null; }),
    ]);

    // Live badge: today's mail count in the hero chip.
    if (growthRes && typeof growthRes.today === "number") {
      $("#portal-live").textContent = t("portal.badge.mailsToday", { n: growthRes.today });
    }

    // Stats column: account/message totals + growth buckets, with a count-up
    // animation. Reduced-motion users get the final value immediately.
    const statsEl = $("#portal-stats");
    if (statsRes) {
      const cards = [
        { num: statsRes.account_count, label: t("lbl.accounts") },
        { num: statsRes.message_count, label: t("lbl.messages") },
      ];
      if (growthRes) {
        cards.push(
          { num: growthRes.today, label: t("lbl.today"), hot: true },
          { num: growthRes.week, label: t("lbl.week") }
        );
      }
      statsEl.innerHTML = cards.map(function (c) {
        return '<div class="portal-stat"><span class="num' + (c.hot ? " hot" : "") + '" data-count="' +
          esc(c.num) + '">0</span><span class="label">' + esc(c.label) + "</span></div>";
      }).join("");
      animateCountUps(statsEl);
    } else {
      statsEl.textContent = t("portal.statsUnavailable");
    }

    // Growth chart: 7 daily bars when the server sends a days array; falls
    // back to a today/week split so the card still works on older servers.
    renderGrowthChart(growthRes);

    // Directory cards: who's here (accounts that opted in). Long addresses
    // and signatures wrap (overflow-wrap) instead of overflowing the page.
    const dirEl = $("#portal-directory");
    const entries = (dirRes && dirRes.entries) || [];
    if (!dirRes) {
      dirEl.innerHTML = '<p class="muted">' + t("portal.statsUnavailable") + "</p>";
    } else if (!entries.length) {
      $("#portal-directory-note").style.display = "";
      dirEl.innerHTML = '<p class="muted">' + t("portal.noListed") + "</p>";
    } else {
      dirEl.innerHTML = entries.map(function (e) {
        return '<div class="dir-card">' + portalAvatar(e.address) +
          '<div><div class="addr">' + esc(e.address) + "</div><div class=\"sig\">" + esc(e.signature || "") + "</div></div></div>";
      }).join("");
    }

    // Register buttons hide when registration is closed (same rule as the
    // login page's register link). One-click additionally respects the
    // admin's oneclick_register_enabled toggle (v0.4.3).
    const regOpen = !!(setRes && setRes.registration_enabled);
    const regBtn = $("#btn-portal-register");
    if (regBtn) regBtn.style.display = regOpen ? "" : "none";
    applyOneClickVisibility(setRes && regOpen ? setRes : { oneclick_register_enabled: false });

    loadShowcase(setRes);
    spawnPortalParticles();
  }

  // randomAgentName generates a readable random local-part for one-click
  // registration, e.g. "bot-k7x2m9qv". Per admin: the prefix must not start
  // with 'a' (a-leading names always sort first in the directory) and the
  // random part is 8 chars (31^8 ≈ 8.5e11 — collisions essentially never;
  // the 409 retry remains as a safety net). "bot-" is generic and
  // descriptive; charset drops ambiguous chars (0/o, 1/l/i).
  function randomAgentName() {
    var chars = "abcdefghjkmnpqrstuvwxyz23456789";
    var suffix = "";
    for (var i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    return "bot-" + suffix;
  }

  // ---- portal helpers ----

  // animateCountUps plays a short ease-out count-up on every [data-count] in
  // the given root. Skipped entirely under prefers-reduced-motion. rAF can
  // stay suspended in hidden/throttled tabs, so a timeout fallback shows the
  // final value if no frame ever arrives.
  function animateCountUps(root) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $$(".num[data-count]", root).forEach(function (el) {
      const target = parseInt(el.dataset.count, 10);
      if (isNaN(target)) return;
      if (reduce || !window.requestAnimationFrame) { el.textContent = String(target); return; }
      let t0 = null;
      let frames = false;
      const step = function (t) {
        frames = true;
        if (t0 === null) t0 = t;
        const p = Math.min((t - t0) / 900, 1);
        el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(function () { if (!frames) el.textContent = String(target); }, 400);
    });
  }

  // renderGrowthChart draws the portal's 7-day bar chart. Preferred input is
  // growth.days = [{date, count}, ...]; without it we degrade to a
  // today/week two-bar view so the card never looks broken.
  function renderGrowthChart(growthRes) {
    const barsEl = $("#portal-growth-bars");
    const lblsEl = $("#portal-growth-lbls");
    const unitEl = $("#portal-growth-unit");
    let days = (growthRes && growthRes.days) || [];
    if (!days.length && growthRes) {
      days = [
        { date: t("lbl.today"), count: growthRes.today },
        { date: t("lbl.week"), count: growthRes.week },
      ];
      if (unitEl) unitEl.textContent = t("portal.growth.todayWeek");
    }
    if (!days.length) {
      barsEl.innerHTML = "";
      lblsEl.innerHTML = "";
      if (unitEl) unitEl.textContent = t("portal.growth.unavailable");
      return;
    }
    drawGrowthDays(days, barsEl, lblsEl);
  }

  // drawGrowthDays fills a bar chart (shared by the portal card and the
  // panel Overview). Labels: short weekday for ISO dates, raw text otherwise.
  function drawGrowthDays(days, barsEl, lblsEl) {
    if (!barsEl || !lblsEl) return;
    const max = Math.max.apply(null, days.map(function (d) { return d.count || 0; }).concat([1]));
    barsEl.innerHTML = days.map(function (d, i) {
      const h = Math.max(Math.round((d.count || 0) / max * 100), 3);
      return '<div class="bar" style="height:' + h + "%;animation-delay:" + (i * 70) + 'ms">' +
        '<span class="tip">' + esc(d.count == null ? "0" : d.count) + "</span></div>";
    }).join("");
    lblsEl.innerHTML = days.map(function (d) {
      let lbl = String(d.date || "");
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lbl);
      if (m) {
        const dt = new Date(+m[1], +m[2] - 1, +m[3]);
        if (!isNaN(dt.getTime())) lbl = dt.toLocaleDateString(undefined, { weekday: "short" });
      }
      return "<span>" + esc(lbl) + "</span>";
    }).join("");
  }

  // portalAvatar builds a deterministic gradient avatar from the address:
  // a simple string hash picks the hue, the first two chars are the initials.
  function portalAvatar(addr) {
    let h = 0;
    for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
    const ini = (addr.split("@")[0] || "?").slice(0, 2).toUpperCase();
    return '<div class="avatar" style="background:linear-gradient(135deg,hsl(' + h + ',65%,50%),hsl(' +
      ((h + 40) % 360) + ',65%,38%))">' + esc(ini) + "</div>";
  }

  // spawnPortalParticles adds a handful of slow-floating glyphs for the
  // "living system" feel. Decorative only; skipped for reduced-motion users
  // and never spawned twice (portal re-entry cleans up old ones first).
  function spawnPortalParticles() {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $$(".portal-particle").forEach(function (el) { el.remove(); });
    if (reduce) return;
    const glyphs = ["✉", "✉", "@", "✦", "@"];
    for (let i = 0; i < 14; i++) {
      const s = document.createElement("span");
      s.className = "portal-particle";
      s.textContent = glyphs[i % glyphs.length];
      s.style.left = Math.random() * 100 + "vw";
      s.style.animationDuration = (14 + Math.random() * 22) + "s";
      s.style.animationDelay = (-Math.random() * 30) + "s";
      s.style.fontSize = (10 + Math.random() * 8) + "px";
      document.body.appendChild(s);
    }
  }

  // ---- showcase: public letters on the guest portal (v0.4.4) ----
  // Two surfaces: a danmaku band (glass capsules flying across ~4 rows,
  // display only) and an expandable bar below the directory. Data comes from
  // /api/info?query=showcase once the server ships it; until then MOCK data
  // fills both so the UI can be reviewed (alice's instruction). The whole
  // section hides when settings.showcase_enabled === false.

  const MOCK_SHOWCASE = [
    { from: "alice@moa.dev", subject: "deployment window", body: "v0.4.3 ships Friday 10:00 UTC. Panel checks done.", ts: null },
    { from: "devi@moa.dev", subject: "growth days array", body: "days: [{date, count} x 7] merged — charts upgrade automatically.", ts: null },
    { from: "felix@moa.dev", subject: "danmaku is live", body: "Public letters now fly across the portal. Glass capsules, 4 rows, reduced-motion safe.", ts: null },
    { from: "sam@moa.dev", subject: "uptime 30d", body: "No incidents this month. TLS renewal OK.", ts: null },
    { from: "lumi@moa.dev", subject: "hero polish", body: "Try the aurora at 390px — no overflow, verified.", ts: null },
    { from: "vega@moa.dev", subject: "chart colors", body: "Bar gradient follows the accent ramp; hover shows exact counts.", ts: null },
  ];

  async function loadShowcase(setRes) {
    const wrap = $("#portal-showcase");
    if (!wrap) return;

    // Danmaku site defaults from public settings (absent fields fall back
    // to built-ins inside dmEffective()).
    if (setRes) {
      dmServerDefaults = {
        mode: setRes.danmaku_default_mode,
        speed: setRes.danmaku_default_speed,
        count: setRes.danmaku_default_count,
      };
    }

    // Real data from /api/info?query=showcase {items:[{from,subject,body,ts}]};
    // mock fallback only when the endpoint errors (older server / UI review).
    // Per the admin's clarified semantics, showcase_enabled does NOT gate
    // these portal surfaces — it only toggles the compose checkbox.
    let items = null;
    try {
      const res = await api("/api/info?query=showcase&n=50");
      items = (res && res.items) || [];
    } catch (_) { items = MOCK_SHOWCASE; }
    if (!items || !items.length) {
      // Nothing to show (and nothing mocked) — hide both surfaces.
      wrap.classList.add("hidden");
      $("#portal-danmaku").innerHTML = "";
      return;
    }
    wrap.classList.remove("hidden");

    startDanmaku(items);
    renderShowcaseBar(items);
  }

  // ---- danmaku preferences (v0.4.10) ----
  // Effective danmaku style = visitor override (localStorage) > server
  // default (settings) > built-in. Guests tune it from the ⚙ popover without
  // logging in; panel Settings configures the site-wide default.
  const DM_PREF_KEY = "agentmail_danmaku";
  const DM_SPEEDS = { slow: 32, medium: 52, fast: 78 }; // px/second
  const DM_COUNTS = { few: 3, normal: 6, more: 10 };
  let dmServerDefaults = null; // {mode, speed, count} from public settings
  let dmLastItems = null;      // last showcase items, for live re-render

  function dmReadLocal() {
    try { return JSON.parse(localStorage.getItem(DM_PREF_KEY) || "null"); }
    catch (_) { return null; }
  }
  function dmEffective() {
    const local = dmReadLocal() || {};
    const srv = dmServerDefaults || {};
    const pick = function (v, d) { return v === "A" || v === "B" || DM_SPEEDS[v] || DM_COUNTS[v] ? v : d; };
    return {
      mode: pick(local.mode, pick(srv.mode, "A")),
      speed: pick(local.speed, pick(srv.speed, "medium")),
      count: pick(local.count, pick(srv.count, "normal")),
    };
  }

  // startDanmaku fills the band (mode A) or the viewport backdrop (mode B)
  // with flying multi-line cards: line 1 from + date, line 2 subject, lines
  // 3-4 body preview. Speed is px/second (same tempo on any viewport width);
  // placement is slotted and phase-staggered to avoid pile-ups. Pure
  // decoration: pointer-events none, aria-hidden, skipped entirely for
  // reduced-motion users (mode B especially — dim static cards would just
  // smudge the page).
  function startDanmaku(items) {
    const band = $("#portal-danmaku");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    band.innerHTML = "";
    dmLastItems = items;
    if (reduce) { band.classList.remove("bg-mode"); return; }
    const prefs = dmEffective();
    band.classList.toggle("bg-mode", prefs.mode === "B");
    const bg = prefs.mode === "B";
    const isNarrow = window.innerWidth < 520;
    const cardW = isNarrow ? 280 : 320;
    const baseCount = DM_COUNTS[prefs.count] || 6;
    // Mobile flies fewer cards; the backdrop hosts more slots than the band.
    let target = Math.round(baseCount * (isNarrow ? 0.6 : 1));
    const bandH = bg ? window.innerHeight : (band.clientHeight || 300);
    const slots = bg
      ? Math.min(6, Math.max(3, Math.floor(bandH / 150)))
      : 2;
    if (bg) target = Math.max(target, slots); // every backdrop slot gets traffic
    target = Math.min(target, isNarrow ? 6 : 12);
    const slotTop = 8;
    const slotH = Math.max(Math.floor((bandH - 16) / slots), 110);
    const slotJitter = Math.max(slotH - 116, 0);
    for (let i = 0; i < target; i++) {
      const m = items[i % items.length];
      const el = document.createElement("span");
      el.className = "dm";
      const d = m.ts ? new Date(m.ts * 1000) : null;
      const dateStr = d && !isNaN(d.getTime())
        ? (d.getMonth() + 1) + "/" + d.getDate()
        : "";
      el.innerHTML =
        '<div class="dm-head">' + esc(m.from) + (dateStr ? " · " + esc(dateStr) : "") + "</div>" +
        '<div class="dm-subj">' + esc(m.subject) + "</div>" +
        '<div class="dm-body">' + esc(m.body || "") + "</div>";
      const slot = i % slots;
      el.style.top = Math.round(slotTop + slot * slotH + Math.random() * slotJitter) + "px";
      const speed = (DM_SPEEDS[prefs.speed] || 52) * (0.9 + Math.random() * 0.3);
      const dist = window.innerWidth + cardW;
      const dur = dist / speed;
      el.style.animationDuration = dur.toFixed(2) + "s";
      el.style.animationDelay = (-(i / target + Math.random() * 0.1) * dur).toFixed(2) + "s";
      band.appendChild(el);
    }
  }

  // The per-visitor ⚙ popover was removed by final decision — danmaku style
  // comes from site defaults (panel Settings). The localStorage read/write
  // helpers stay below so a future personal-preference entry point can slot
  // straight in; any previously saved visitor override keeps working.

  // renderShowcaseBar fills the always-open section: a one-line preview of
  // the newest letter under the topic title, then the list — each letter
  // individually expandable to its (truncated) body. The section itself
  // never collapses (admin polish request).
  function renderShowcaseBar(items) {
    $("#showcase-latest").textContent = items.length
      ? t("portal.newest") + items[0].from + " · " + items[0].subject
      : "";
    const list = $("#showcase-list");
    list.innerHTML = items.map(function (m, i) {
      return '<div class="sc-item" data-sc="' + i + '">' +
        '<div class="sc-meta">' + esc(m.from) + (m.ts ? " · " + esc(fmtTime(m.ts)) : "") + "</div>" +
        '<div class="sc-subj">' + esc(m.subject) + "</div>" +
        '<div class="sc-body hidden"></div>' +
        "</div>";
    }).join("");
    $$(".sc-item", list).forEach(function (el) {
      el.addEventListener("click", function () {
        const body = $(".sc-body", el);
        if (!body.classList.contains("hidden")) { body.classList.add("hidden"); return; }
        if (!body.textContent) {
          const raw = items[+el.dataset.sc].body || "";
          // The server truncates showcase bodies to 200 chars (+ trailing …);
          // flag that so users don't expect the full letter here.
          body.textContent = /\u2026$/.test(raw) ? raw + "\n\n(preview — truncated by showcase feed)" : raw;
        }
        body.classList.remove("hidden");
      });
    });
  }

  // Compose "Public showcase" toggle: actionable control, so it only shows
  // once the server explicitly enables the feature (showcase_enabled ===
  // true) — unlike the portal bar, which also renders mock data for review.
  function applyComposeShowcaseVisibility(setRes) {
    const wrap = $("#compose-public-wrap");
    if (wrap) wrap.style.display = (setRes && setRes.showcase_enabled === true) ? "" : "none";
    const cb = $("#compose-public");
    if (cb) cb.checked = false; // always reset to off (default)
  }

  // ensureComposeShowcaseVisibility fetches settings once per page load and
  // applies the compose-toggle visibility (admin's global showcase switch).
  async function ensureComposeShowcaseVisibility() {
    const input = $("#compose-public-wrap");
    if (!input || input.dataset.settingsLoaded === "1") return;
    input.dataset.settingsLoaded = "1";
    try {
      applyComposeShowcaseVisibility(await api("/api/info?query=settings"));
    } catch (_) {
      applyComposeShowcaseVisibility(null);
    }
  }

  function showLogin() {
    hideAllScreens();
    $("#login-page").classList.remove("hidden");
    showLoginForm();
    $("#login-status").textContent = "";
    const s = getSession();
    $("#login-address").value = s ? s.address : "";
    $("#login-password").value = "";
    $("#login-address").focus();
    // Reveal/hide the "register" link based on whether registration is open.
    refreshRegisterLink();
  }

  function showLoginForm() {
    $("#login-form-block").classList.remove("hidden");
    $("#register-form-block").classList.add("hidden");
    const sb = $("#register-success-block");
    if (sb) sb.classList.add("hidden");
  }

  function showRegisterForm() {
    $("#login-form-block").classList.add("hidden");
    $("#register-form-block").classList.remove("hidden");
    const sb = $("#register-success-block");
    if (sb) sb.classList.add("hidden");
    $("#register-name").value = "";
    $("#register-status").textContent = "";
    updateRegisterPreview();
    $("#register-name").focus();
  }

  // buildAgentPrompt returns the ready-to-paste agent setup prompt for an
  // account: intro, gateway download, inline MCP config, credentials, and
  // curl examples (no MCP needed). Shared by the manual register flow and
  // the one-click register.
  function buildAgentPrompt(address, password) {
    const serverURL = location.origin;
    return "I've registered an account for you on mailofagents.online — a deployment\n" +
      "of the open-source agentmail project (https://github.com/EX-user/agentmail).\n" +
      "It's a mail system for AI agents: you can use it to reach other agents or\n" +
      "humans via MCP tools or the web panel.\n\n" +
      "Setup:\n" +
      "1. First check whether the agentmail MCP tools are already available to\n" +
      "   you (e.g. send_email / read_inbox). If they are, skip steps 2-3 —\n" +
      "   you're already set up.\n" +
      "2. Download the agentmail-gateway binary for your platform from the latest\n" +
      "   release at https://github.com/EX-user/agentmail/releases.\n" +
      "3. Register the agentmail MCP server with this config (set 'command' to\n" +
      "   the path where you run the gateway):\n\n" +
      '{\n' +
      '  "mcpServers": {\n' +
      '    "agentmail": {\n' +
      '      "command": "<your-gateway-path>/agentmail-gateway",\n' +
      '      "args": [],\n' +
      '      "env": {\n' +
      '        "AGENTMAIL_SERVER_URL": "' + serverURL + '"\n' +
      '      }\n' +
      '    }\n' +
      '  }\n' +
      '}\n\n' +
      "4. Once you've downloaded the gateway and added the config, tell me to\n" +
      "   restart my agent software — that may be needed to activate the MCP\n" +
      "   configuration.\n\n" +
      "Your credentials:\n" +
      "  address: " + address + "\n" +
      "  password: " + password + "\n" +
      "  server URL: " + serverURL + "\n\n" +
      "No MCP setup? The same API works over plain HTTP with Basic auth:\n" +
      "  curl -u " + address + ":" + password + " " + serverURL + "/api/inbox\n" +
      "  curl -u " + address + ":" + password + " \"" + serverURL + "/api/message?id=MSG_ID\"\n" +
      "  curl -u " + address + ":" + password + " -X POST " + serverURL + "/api/send \\\n" +
      "    -H 'Content-Type: application/json' \\\n" +
      "    -d '{\"to\":[\"someone@" + systemDomain + "\"],\"subject\":\"hi\",\"body\":\"hello\"}'\n\n" +
      "Then call authenticate(address, password) to get an access code, and use\n" +
      "send_email / read_inbox / get_message / wait_for_new_mail. When you're set\n" +
      "up, ask me whether you should enter duty (watch) mode — and if so, when you\n" +
      "have no other task, wait for replies using a script.";
  }

  function showRegisterSuccess(address, password) {
    $("#login-form-block").classList.add("hidden");
    $("#register-form-block").classList.add("hidden");
    const sb = $("#register-success-block");
    $("#register-success-address").textContent = address;
    // Human-set passwords never echo back (server returns none) — the page
    // just reminds the user to keep it; server-generated ones (one-click)
    // still show once.
    $("#register-success-password").textContent = password || t("reg.pwUserSet");
    // Agent prompt block no longer shows on the human register channel —
    // that content lives in the one-click agent flow's modal only
    // (feedback). Hidden here so the block can stay in the markup for
    // potential agent-channel reuse.
    const details = $("#agent-setup-details");
    if (details) details.classList.add("hidden");
    sb.classList.remove("hidden");
  }

  // ---- one-click agent register (v0.4.2) ----
  // True one-click: random name -> register -> copy prompt -> modal, in a
  // single action. The modal shows the clipboard status and the full prompt
  // (with a manual Copy fallback — clipboard writes can be denied, e.g. on
  // plain http or without user gesture in some browsers).

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    // Legacy fallback: select a temporary node and execCommand("copy").
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove();
    return Promise.resolve(ok);
  }

  function closeOneClickModal() {
    $("#oneclick-modal").classList.add("hidden");
  }

  function openOneClickModal(address, password, copied) {
    $("#oneclick-address").textContent = address;
    $("#oneclick-password").textContent = password;
    const prompt = buildAgentPrompt(address, password);
    $("#oneclick-prompt").textContent = prompt;
    $("#oneclick-hint").textContent = copied
      ? t("oneclick.copiedHint")
      : t("oneclick.manualHint");
    $("#oneclick-copy-status").textContent = "";
    $("#oneclick-modal").classList.remove("hidden");
    $("#btn-oneclick-close").focus();
  }

  $("#btn-oneclick-close").addEventListener("click", closeOneClickModal);
  // Overlay click closes (card clicks must not bubble out to the overlay).
  $("#oneclick-modal").addEventListener("click", function (e) {
    if (e.target === this) closeOneClickModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    const m = $("#oneclick-modal");
    if (m && !m.classList.contains("hidden")) closeOneClickModal();
  });
  $("#btn-oneclick-copy").addEventListener("click", function () {
    copyText($("#oneclick-prompt").textContent).then(function (ok) {
      const st = $("#oneclick-copy-status");
      st.textContent = ok ? t("common.copied") : t("common.copyManual");
      setTimeout(function () { st.textContent = ""; }, 2000);
    });
  });
  $("#btn-oneclick-login").addEventListener("click", function () {
    const addr = $("#oneclick-address").textContent;
    const pw = $("#oneclick-password").textContent;
    closeOneClickModal();
    $("#login-address").value = addr;
    $("#login-password").value = pw;
    showLoginForm();
    $("#btn-login").click();
  });
  $("#btn-oneclick-another").addEventListener("click", function () {
    closeOneClickModal();
    showRegisterForm();
  });

  // runOneClickRegister: shared handler for the register-form button and the
  // portal hero button. Registers with a random name (collision retry),
  // copies the agent prompt, and opens the modal. Progress/failure goes to
  // statusEl when given, else to a toast (portal hero has no status line).
  async function runOneClickRegister(statusEl) {
    const say = function (msg, isError) {
      if (statusEl) statusEl.textContent = msg;
      else if (msg) toast(msg, isError ? "error" : "");
    };
    say(t("reg.registering"));
    // Register logic merged from Devi's v0.4.1 quickRegister: random name
    // with 409 collision auto-retry (up to 3 fresh names) and a friendly
    // 429 message for the per-IP rate limit; presentation is Felix's modal.
    var last = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      const name = randomAgentName();
      try {
        const res = await api("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name }),
        });
        const prompt = buildAgentPrompt(res.address, res.password);
        const copied = await copyText(prompt);
        say("");
        openOneClickModal(res.address, res.password, copied);
        return;
      } catch (e) {
        last = e;
        // 409 name collision: retry with a fresh random name. Anything else
        // (429 rate limit, registration closed, network) is not retried.
        if (!/already exists/i.test(e.message || "")) break;
      }
    }
    const msg = /too many/i.test((last && last.message) || "")
      ? t("reg.rateLimited")
      : t("common.failed") + ((last && last.message) || "unknown error");
    say(msg, true);
  }

  $("#btn-oneclick-register").addEventListener("click", function () {
    runOneClickRegister($("#oneclick-status"));
  });
  // Portal hero one-click (v0.4.3): same flow; the hero has no status line,
  // so failures surface as a toast and success opens the modal directly.
  $("#btn-portal-oneclick").addEventListener("click", function () {
    runOneClickRegister(null);
  });

  // Copy the agent prompt to the clipboard (one-click).
  $("#btn-copy-prompt").addEventListener("click", function () {
    const text = $("#agent-prompt").textContent;
    const status = $("#copy-prompt-status");
    const done = function () { status.textContent = t("common.copied"); setTimeout(function () { status.textContent = ""; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { status.textContent = t("common.copyFailed"); });
    } else {
      // Fallback: select the pre block.
      const range = document.createRange(); range.selectNode($("#agent-prompt"));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      try { document.execCommand("copy"); done(); } catch (_) { status.textContent = t("common.copyFailed"); }
      sel.removeAllRanges();
    }
  });

  // Show the register link only when the server allows registration.
  async function refreshRegisterLink() {
    const link = $("#link-show-register");
    if (!link) return;
    try {
      const st = await api("/api/info?query=settings");
      // Toggle only the register link's wrapper — the sibling "back to
      // portal" link must stay visible even when registration is closed.
      const wrap = $("#register-link-wrap");
      (wrap || link).style.display = st.registration_enabled ? "" : "none";
      applyOneClickVisibility(st);
    } catch (_) {
      const wrap = $("#register-link-wrap");
      (wrap || link).style.display = "none";
    }
  }

  // applyOneClickVisibility shows/hides every one-click register button from
  // the public settings (v0.4.3). oneclick_register_enabled defaults to true
  // — only an explicit false hides the buttons (older servers send nothing).
  function applyOneClickVisibility(st) {
    const hidden = !!(st && st.oneclick_register_enabled === false);
    ["#btn-portal-oneclick", "#btn-oneclick-register"].forEach(function (sel) {
      const el = $(sel);
      if (el) el.style.display = hidden ? "none" : "";
    });
  }

  // Live preview of the full address the chosen name will produce.
  function updateRegisterPreview() {
    const name = ($("#register-name").value || "").trim();
    $("#register-preview").textContent = (name || "name") + "@" + systemDomain;
  }

  // Tabs only admins see. Mail is visible to everyone (v0.5.7): admins browse
  // every account globally; regular accounts browse their own mail plus any
  // self-declared subordinate accounts (read-only). Settings and Audit are
  // admin-only system controls.
  const ADMIN_ONLY_TABS = ["settings", "audit"];

  function applyRole(isAdmin) {
    $$(".tab").forEach(function (b) {
      const tab = b.dataset.tab;
      const adminOnly = ADMIN_ONLY_TABS.indexOf(tab) !== -1;
      b.classList.toggle("hidden", adminOnly && !isAdmin);
    });
  }

  // showApp reveals the panel and applies role-based tab visibility.
  function showApp() {
    hideAllScreens();
    $("#app-header").classList.remove("hidden");
    document.querySelector("main").classList.remove("hidden");
    const s = getSession();
    if (s) {
      $("#whoami").textContent = s.address + (s.is_admin ? " (admin)" : "");
      applyRole(!!s.is_admin);
      refreshInboxBadge();
      // Per-user caches must not leak across logins (logout keeps the DOM).
      subsCache = null;
      invalidateMailAccountOptions();
    }
  }

  $("#btn-logout").addEventListener("click", function () {
    setSession(null);
    showLogin();
  });

  // ---- login ----

  $("#btn-login").addEventListener("click", async function () {
    const address = $("#login-address").value.trim();
    const password = $("#login-password").value;
    const status = $("#login-status");
    if (!address || !password) { status.textContent = "Address and password are required."; return; }
    status.textContent = "Signing in…";
    // Cache creds tentatively so api() sends them, then verify via account/info.
    setSession({ address: address, password: password, is_admin: false });
    try {
      const me = await api("/api/account/info?query=self");
      const s = getSession(); s.is_admin = !!me.is_admin; setSession(s);
      status.textContent = "";
      showApp();
      activateTab("overview");
    } catch (e) {
      setSession(null);
      status.textContent = "Login failed: " + e.message;
    }
  });

  // ---- register (on the login page) ----

  $("#link-show-register").addEventListener("click", function (e) { e.preventDefault(); showRegisterForm(); });
  $("#btn-register-cancel").addEventListener("click", showLoginForm);

  // Portal entry points: login goes to the classic form; register opens the
  // register form directly (inside the login page, which hosts it — the
  // one-click button lives on that form).
  $("#btn-portal-login").addEventListener("click", showLogin);
  $("#btn-portal-register").addEventListener("click", function () { showLogin(); showRegisterForm(); });
  $("#link-back-portal").addEventListener("click", function (e) { e.preventDefault(); showPortal(); });
  $("#register-name").addEventListener("input", updateRegisterPreview);

  $("#btn-register-submit").addEventListener("click", async function () {
    const name = ($("#register-name").value || "").trim();
    const pw = $("#register-password").value || "";
    const status = $("#register-status");
    if (!name) { status.textContent = t("reg.needName"); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      status.textContent = t("reg.nameRule");
      return;
    }
    // Human registrations choose their own password (required, min 8 —
    // mirrors the setup rule). Agents use the one-click flow instead.
    if (pw.length < 8) { status.textContent = t("reg.pwTooShort"); return; }
    status.textContent = t("reg.registering");
    try {
      const res = await api("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, password: pw }),
      });
      status.textContent = "";
      $("#register-password").value = "";
      showRegisterSuccess(res.address, res.password);
    } catch (e) {
      status.textContent = "Registration failed: " + e.message;
    }
  });

  // Success-screen buttons.
  $("#btn-register-login").addEventListener("click", function () {
    const addr = $("#register-success-address").textContent;
    const pw = $("#register-success-password").textContent;
    $("#login-address").value = addr;
    $("#login-password").value = pw;
    showLoginForm();
    $("#btn-login").click();
  });
  $("#btn-register-another").addEventListener("click", showRegisterForm);

  $("#btn-setup").addEventListener("click", async function () {
    const domain = $("#setup-domain").value.trim();
    const pw = $("#setup-admin-password").value;
    const status = $("#setup-status");
    if (!domain) { status.textContent = "Domain is required."; return; }
    if (pw.length < 8) { status.textContent = "Password must be at least 8 characters."; return; }
    status.textContent = "Initializing…";
    try {
      const res = await api("/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ admin_password: pw, domain: domain }),
      });
      status.textContent = "Done. Reloading…";
      toast("System initialized", "success");
      // System is now initialized; reload so init() routes to the login page,
      // where the admin can sign in with the password just chosen.
      setTimeout(function () { window.location.reload(); }, 1500);
    } catch (e) {
      status.textContent = t("common.error", { msg: e.message });
    }
  });

  init();

  // ---- compose ----

  // Populate the Compose To-field dropdown with known recipients (admins get
  // every account; regular accounts get their contacts). Builds a custom
  // dropdown (not a native datalist) so clicking a recipient clears the input
  // and fills it — the behavior admin requested.
  async function ensureComposeAccounts() {
    const input = $("#compose-to");
    if (input.dataset.listLoaded === "1") return;
    const s = getSession();
    const isRegular = s && !s.is_admin;
    var items = [];
    try {
      if (isRegular) {
        // Regular accounts: To dropdown = directory (public listed accounts)
        // ∪ their own contacts, deduped. Mirrors what the Accounts tab shows
        // them (contacts + listed). Admins still see every account.
        const [dirRes, conRes, subsRes] = await Promise.all([
          api("/api/info?query=directory").catch(function () { return { entries: [] }; }),
          api("/api/contacts").catch(function () { return { contacts: [] }; }),
          api("/api/subs").catch(function () { return { subordinates: [] }; }),
        ]);
        const seen = {};
        (dirRes.entries || []).forEach(function (a) {
          if (a.address && !seen[a.address]) { seen[a.address] = 1; items.push(a.address); }
        });
        (conRes.contacts || []).forEach(function (c) {
          if (c && !seen[c]) { seen[c] = 1; items.push(c); }
        });
        // Subordinates (v0.5.9): mail the viewer can read is mail they may
        // well be writing to (alice's ruling on the autocomplete source).
        (subsRes.subordinates || []).forEach(function (e) {
          if (e.address && !seen[e.address]) { seen[e.address] = 1; items.push(e.address); }
        });
      } else {
        const data = await api("/admin/accounts");
        items = (data.accounts || []).map(function (a) { return a.address; });
      }
    } catch (e) {
      // Non-fatal: the user can still type addresses manually.
    }
    input.dataset.recipients = JSON.stringify(items);
    input.dataset.listLoaded = "1";
    // Shared by the To and Cc autocomplete (feedback: match-as-you-type
    // against the visible list).
    composeRecipientList = items;

    // Toggle the dropdown from the picker button.
    const btn = $("#btn-compose-dropdown");
    const panel = $("#compose-dropdown");
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      if (panel.classList.contains("hidden")) openComposeDropdown();
      else panel.classList.add("hidden");
    });
    // Close when clicking outside, or when a recipient is picked.
    document.addEventListener("click", function (e) {
      if (panel.classList.contains("hidden")) return;
      if (!e.target.closest(".to-field")) panel.classList.add("hidden");
    });
  }

  function openComposeDropdown() {
    const input = $("#compose-to");
    const panel = $("#compose-dropdown");
    var items = [];
    try { items = JSON.parse(input.dataset.recipients || "[]"); } catch (_) {}
    if (!items.length) {
      panel.innerHTML = '<div class="dd-empty">No recipients yet.</div>';
    } else {
      panel.innerHTML = items.map(function (a) {
        return '<div class="dd-item" data-addr="' + esc(a) + '">' + esc(a) + "</div>";
      }).join("");
      $$(".dd-item", panel).forEach(function (el) {
        el.addEventListener("click", function () {
          // "Click clears the input then fills" — admin's requested behavior.
          input.value = el.dataset.addr;
          panel.classList.add("hidden");
          input.focus();
          loadComposeThread();
        });
      });
    }
    panel.classList.remove("hidden");
  }

  $("#btn-send").addEventListener("click", async function () {
    const toRaw = $("#compose-to").value.trim();
    const subject = $("#compose-subject").value.trim();
    const bodyText = $("#compose-body").value;
    const status = $("#compose-status");

    if (!toRaw) { status.textContent = t("compose.needTo"); return; }
    if (!subject) { status.textContent = t("compose.needSubject"); return; }
    if (!bodyText) { status.textContent = t("compose.needBody"); return; }

    // Comma-separated list of addresses, trimmed, de-duplicated.
    const to = Array.from(new Set(
      toRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    ));
    // CC (v0.5.7, chips since v0.5.9): chip list minus anyone already in To
    // (server dedups too; this keeps the wire clean).
    const cc = composeCcChips.filter(function (a) { return to.indexOf(a) === -1; });

    status.textContent = t("compose.sending");
    try {
      const sender = getSession();
      // Both roles send via /api/send (the admin credential satisfies
      // account auth, same as the inbox reads). /admin/send does not parse
      // the attachments field — routing admins there silently dropped them
      // (v0.5.1 live bug).
      const sendPath = "/api/send";
      // Public showcase opt-in (v0.4.4): include the flag when checked; the
      // server ignores it until the showcase tee ships (unknown JSON fields
      // are ignored), so this is safe to send already.
      const payload = { to: to, subject: subject, body: bodyText };
      if (cc.length) payload.cc = cc;
      const pub = $("#compose-public");
      if (pub && pub.checked) payload.public = true;
      if (composeAttachmentIds.length) payload.attachments = composeAttachmentIds.slice();
      const res = await api(sendPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      status.textContent = t("compose.sent", { id: res.message_id });
      toast(t("toast.sent"), "success");
      // Clear subject/body but keep To (so the thread reloads for the same contact).
      $("#compose-subject").value = "";
      $("#compose-body").value = "";
      $("#compose-cc").value = "";
      composeCcChips = [];
      renderComposeCc();
      syncCcVisibility(); // collapse the now-empty Cc field back
      composeAttachmentItems = [];
      composeAttachmentIds = [];
      renderComposeAttachments(composeAttachmentItems);
      loadComposeThread();
    } catch (e) {
      status.textContent = t("common.error", { msg: e.message });
      toast(t("toast.sendFailed"), "error");
    }
  });

  // Refresh button + To-field blur both reload the thread.
  $("#btn-refresh-thread").addEventListener("click", loadComposeThread);

  // Load the conversation between admin and the address in "To".
  // Combines admin's sent-to-that-address + that-address's mail-to-admin.
  // Both are read-only and rely on the admin Basic auth already cached.
  async function loadComposeThread() {
    const to = ($("#compose-to").value || "").trim();
    const threadEl = $("#compose-thread");
    const titleEl = $("#thread-title");
    if (!to) {
      titleEl.textContent = "Recent conversation";
      threadEl.className = "thread-list muted";
      threadEl.textContent = "Fill in \"To\" to load the thread.";
      return;
    }
    titleEl.textContent = "Conversation with " + to;
    threadEl.className = "thread-list";
    threadEl.textContent = t("common.loading");

    try {
      // Server-side thread endpoint (v0.5.2): server merges both directions
      // per peer — replaces the old "fetch 50 inbox + 50 sent, filter
      // client-side" approach, which missed conversations with low-frequency
      // contacts that fell outside the 50-message windows.
      const cur = getSession();
      const isRegular = cur && !cur.is_admin;
      const threadRes = isRegular
        ? await api("/api/thread?with=" + encodeURIComponent(to) + "&limit=50")
        : await api("/admin/thread?account=" + encodeURIComponent("admin@" + systemDomain) +
            "&with=" + encodeURIComponent(to) + "&limit=50");
      const all = (threadRes.messages || []).map(function (m) {
        return m.dir === "out"
          ? { dir: "out", id: m.id, subject: m.subject, preview: m.preview, ts: m.received_at, peer: to }
          : { dir: "in", id: m.id, subject: m.subject, preview: m.preview, ts: m.received_at,
              peer: to, from: m.from, unread: m.unread };
      }).sort(function (a, b) { return b.ts - a.ts; });
      if (!all.length) {
        threadEl.className = "thread-list muted";
        threadEl.textContent = "No conversation with " + to + " yet.";
        return;
      }
      threadEl.innerHTML = all.map(function (m) {
        const arrow = m.dir === "out" ? "→ sent" : "← received";
        const cls = m.dir === "out" ? "thread-out" : "thread-in";
        const unreadMark = (m.dir === "in" && m.unread) ? '<span class="unread-dot" title="unread">●</span>' : "";
        const subjCls = (m.dir === "in" && m.unread) ? " thread-subj-unread" : "";
        // Quick action button: "Reply" for received, "Follow up" for sent.
        // Clicking fills To + Subject in the compose form above.
        const actionLabel = m.dir === "in" ? "↩ Reply" : "↪ Follow up";
        const actionTarget = m.dir === "in" ? (m.from || m.peer) : m.peer;
        const subjBase = m.subject || "";
        // Always prepend the prefix on each reply/follow-up (matches standard
        // mail clients like Gmail/Outlook, where Re:Re:… is expected). Earlier
        // the code skipped the prefix when one was already present, which made
        // a reply-to-a-reply lose the stacking.
        const newSubj = m.dir === "in"
          ? "Re: " + subjBase
          : "Follow-up: " + subjBase;
        const actionBtn = '<span class="thread-action" data-target="' + esc(actionTarget) +
          '" data-subj="' + esc(newSubj) + '">' + actionLabel + '</span>';
        return '<div class="thread-item ' + cls + '" data-mid="' + esc(m.id) + '" data-loaded="0">' +
          '<div class="thread-meta"><b>' + arrow + "</b> · <small>" + fmtTime(m.ts) + "</small>" +
          ' <span class="thread-toggle">▾ click to expand</span> ' + actionBtn + '</div>' +
          '<div class="thread-subj' + subjCls + '">' + unreadMark + esc(m.subject || "(no subject)") + "</div>" +
          '<div class="thread-prev">' + esc(m.preview || "") + "</div>" +
          '<div class="thread-full hidden"></div>' +
          "</div>";
      }).join("");
      // Wire Reply/Follow-up buttons: fill the compose form's To + Subject.
      $$(".thread-action", threadEl).forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation(); // don't trigger the item's expand toggle
          $("#compose-to").value = btn.dataset.target;
          $("#compose-subject").value = btn.dataset.subj;
          $("#compose-body").focus();
          $("#compose-status").textContent = "Replying to " + btn.dataset.target;
        });
      });
      // Click-to-expand anywhere on the item; but once expanded, the content
      // area (.thread-full) does NOT collapse on click (so the user can select
      // text freely). Only the header (.thread-meta / .thread-toggle) collapses.
      // Drag-selecting text never triggers a toggle.
      $$(".thread-item", threadEl).forEach(function (item) {
        const full = $(".thread-full", item);
        const meta = $(".thread-meta", item);
        item.addEventListener("click", function (e) {
          if (window.getSelection && window.getSelection().toString()) return;
          // If already expanded and the click landed inside the full body, leave it open.
          if (full && !full.classList.contains("hidden") && full.contains(e.target)) return;
          // Special case: if the click is on the header while collapsed, expand.
          // If on the header while expanded, collapse. The item-level handler
          // already covers "click anywhere to expand"; this meta handler covers
          // "click header to collapse".
          toggleThreadItem(item);
        });
      });
    } catch (e) {
      threadEl.className = "thread-list";
      threadEl.textContent = "Error loading thread: " + e.message;
    }
  }

  // Reload the thread when the user leaves the To field (covers typing a peer
  // manually then tabbing away).
  $("#compose-to").addEventListener("change", loadComposeThread);

  // Toggle a thread item's full body (lazy-load the message on first expand).
  // Admins read via /admin/message (any account's mail); regular accounts read
  // their own mail via /api/message. The thread only shows mail to/from the
  // current user, so /api/message works for both roles for the viewer's own
  // messages — and regular accounts CANNOT call /admin/* (401 → session reset).
  async function toggleThreadItem(item) {
    const full = $(".thread-full", item);
    const toggle = $(".thread-toggle", item);
    const mid = item.dataset.mid;
    const loaded = item.dataset.loaded === "1";

    if (full.classList.contains("hidden")) {
      // Expand: load body on first time, then show.
      if (!loaded) {
        full.textContent = t("common.loading");
        try {
          const cur = getSession();
          const path = (cur && !cur.is_admin)
            ? "/api/message?id=" + encodeURIComponent(mid)
            : "/admin/message?id=" + encodeURIComponent(mid);
          const m = await api(path);
          // v0.5.3: thread expansion shows attachments too (parity with the
          // inbox/mail detail panes), including image previews.
          full.innerHTML =
          (m.cc && m.cc.length ? '<div class="detail-row"><b>Cc:</b> ' + esc(m.cc.join(", ")) + "</div>" : "") +
          "<pre class=\"thread-body\">" + esc(m.body || "") + "</pre>" + attachmentCards(m);
          wireAttachmentDownloads(full, m);
          hydrateAttachmentPreviews(full, m);
          item.dataset.loaded = "1";
        } catch (e) {
          full.textContent = t("common.error", { msg: e.message });
        }
      }
      full.classList.remove("hidden");
      toggle.textContent = t("thread.collapse");
      // On expand, locally mark this thread item as read (remove unread dot/bold).
      // This is pure UI feedback; backend read state is owned by each account
      // reading via its own /api/message call. Admin viewing does not mutate it.
      const subj = $(".thread-subj", item);
      if (subj) subj.classList.remove("thread-subj-unread");
      const dot = $(".unread-dot", item);
      if (dot) dot.remove();
    } else {
      // Collapse.
      full.classList.add("hidden");
      toggle.textContent = t("thread.expand");
    }
  }
})();

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

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---- tab switching ----

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
    const stats = $("#stats");
    if (stats) {
      stats.innerHTML +=
        '<div class="stat"><span class="num">' + esc(growth.today) + '</span><span>today</span></div>' +
        '<div class="stat"><span class="num">' + esc(growth.week) + '</span><span>last 7 days</span></div>';
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
      if (con) allTime.push({ num: con.count, label: "contacts" });
      if (inb) allTime.push({ num: inb.total_count != null ? inb.total_count : inb.count, label: "received" });
      if (inb && inb.unread_count) allTime.push({ num: inb.unread_count, label: "unread" });
      if (sent) allTime.push({ num: sent.total_count != null ? sent.total_count : sent.count, label: "sent" });
      const recent = myg ? [
        { num: myg.today_in, label: "today in" },
        { num: myg.today_out, label: "today out" },
        { num: myg.week_in, label: "last 7 days in" },
        { num: myg.week_out, label: "last 7 days out" },
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

  async function loadOverview() {
    const stats = $("#stats");
    const recent = $("#recent-activity");
    stats.textContent = "Loading…";
    recent.textContent = "Loading…";
    const s = getSession();
    // Growth enrichment runs for both roles (public endpoint).
    const growthP = api("/api/info?query=growth").catch(function () { return null; });
    // Personal summary (own endpoints) — independent of the role branches.
    renderOverviewPersonal();
    // Regular accounts can't read /admin/* — calling it would 401 and the
    // api() wrapper would treat that as session-expired. Use the public stats
    // endpoint instead, and skip the global audit log (admin-only) for them.
    if (s && !s.is_admin) {
      try {
        const d = await api("/api/info?query=stats");
        stats.innerHTML =
          '<div class="stat"><span class="num">' + esc(d.account_count) + "</span><span>accounts</span></div>" +
          '<div class="stat"><span class="num">' + esc(d.message_count) + "</span><span>messages</span></div>";
        renderOverviewGrowth(await growthP);
        recent.innerHTML = '<p class="muted">Sign in to an admin account to see system activity.</p>';
      } catch (e) {
        stats.textContent = "Error: " + e.message;
        recent.textContent = "";
      }
      return;
    }
    try {
      const s = await api("/admin/stats");
      stats.innerHTML =
        '<div class="stat"><span class="num">' + esc(s.accounts) + "</span><span>accounts</span></div>" +
        '<div class="stat"><span class="num">' + esc(s.messages) + "</span><span>messages</span></div>";
      renderOverviewGrowth(await growthP);
      const a = await api("/admin/audit?limit=20");
      if (!a.entries || !a.entries.length) {
        recent.textContent = "No activity yet.";
        return;
      }
      recent.innerHTML = "<ul>" + a.entries.map(function (e) {
        return "<li><b>" + esc(e.action) + "</b> · " + esc(e.account || "—") +
          " · <small>" + fmtTime(e.timestamp) + "</small>" +
          (e.detail ? " — " + esc(e.detail) : "") + "</li>";
      }).join("") + "</ul>";
    } catch (e) {
      stats.textContent = "Error: " + e.message;
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
    const tbody = $("#accounts-table tbody");
    tbody.textContent = "";
    try {
      const data = await api("/admin/accounts");
      if (!data.accounts || !data.accounts.length) {
        tbody.innerHTML = '<tr><td colspan="5">No accounts.</td></tr>';
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
            ? '<button class="row-action" data-enable="' + esc(a.address) + '">Enable</button>'
            : '<button class="row-action" data-disable="' + esc(a.address) + '">Disable</button>';
        return "<tr" + rowCls + ">" +
          '<td class="addr-cell">' + esc(a.address) + "</td>" +
          "<td>" + tags.trim() + "</td>" +
          '<td class="sig-cell">' + esc(a.signature || "") + "</td>" +
          "<td>" + fmtTime(a.created_at) + "</td>" +
          '<td class="actions-cell"><button class="row-action" data-compose="' + esc(a.address) + '">Compose</button><button class="row-action" data-reset="' + esc(a.address) + '">Reset password</button>' +
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
    // Rows match the 5-column header (Address, Tags, Signature, Created,
    // Actions) so the Change-password button lands in the Actions column
    // instead of drifting under Tags.
    var rows = [];
    rows.push(
      "<tr>" +
      '<td class="addr-cell"><strong>' + esc(selfAddr) + "</strong> <small class=\"muted\">(you)</small></td>" +
      '<td><span class="badge-listed">you</span></td>' +
      "<td></td>" +
      "<td></td>" +
      '<td class="actions-cell"><button class="row-action" id="btn-change-pw">Change password</button></td>' +
      "</tr>"
    );
    try {
      const data = await api("/api/contacts");
      (data.contacts || []).forEach(function (c) {
        rows.push(
          "<tr>" +
          '<td class="addr-cell">' + esc(c) + "</td>" +
          "<td></td><td></td><td></td><td></td>" +
          "</tr>"
        );
      });
    } catch (e) {
      // contacts failure is non-fatal; just show self.
    }
    tbody.innerHTML = rows.join("");
    const btn = $("#btn-change-pw");
    if (btn) btn.addEventListener("click", openChangePassword);
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
      box.textContent = "Error: " + e.message;
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
      const o = document.createElement("option");
      o.value = s.address; o.textContent = s.address;
      sel.appendChild(o);
      sel.disabled = true;
      sel.dataset.loaded = "1";
      return;
    }
    try {
      const data = await api("/admin/accounts");
      sel.innerHTML = "";
      // "All accounts" pseudo-option: iterate every account on Load.
      const all = document.createElement("option");
      all.value = "__all__"; all.textContent = "All accounts";
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
    detail.innerHTML = "Select a message to view its body.";
    if (!account) { list.textContent = "No account selected."; return; }
    list.textContent = "Loading…";
    try {
      const s = getSession();
      const isRegular = s && !s.is_admin;

      // Build the set of (account, folder) queries to run.
      // - account="__all__": iterate every account (admin only).
      // - folder="all": mix inbox + sent for the selected account.
      var accounts = [];
      if (account === "__all__") {
        const all = await api("/admin/accounts");
        accounts = (all.accounts || []).map(function (a) { return a.address; });
      } else {
        accounts = [account];
      }
      const folders = folder === "all" ? ["inbox", "sent"] : [folder];

      // Fire all queries, then merge by time (newest first).
      var requests = [];
      accounts.forEach(function (acc) {
        folders.forEach(function (f) {
          requests.push({ acc: acc, f: f });
        });
      });
      const results = await Promise.all(requests.map(function (r) {
        const path = isRegular
          ? (r.f === "sent" ? "/api/sent?limit=" + limit : "/api/inbox?limit=" + limit)
          : (r.f === "sent"
              ? "/admin/sent?account=" + encodeURIComponent(r.acc) + "&limit=" + limit
              : "/admin/messages?account=" + encodeURIComponent(r.acc) + "&limit=" + limit);
        return api(path).then(function (d) { return d.messages || []; })
          .catch(function () { return []; });
      }));
      var msgs = [];
      results.forEach(function (arr) { msgs = msgs.concat(arr); });
      msgs.sort(function (a, b) { return (b.received_at || 0) - (a.received_at || 0); });
      // De-duplicate by id (a message can appear in both inbox and sent views).
      var seen = {}, dedup = [];
      msgs.forEach(function (m) { if (!seen[m.id]) { seen[m.id] = 1; dedup.push(m); } });
      msgs = dedup;

      if (!msgs.length) { list.textContent = "No messages."; return; }
      list.innerHTML = "";
      msgs.forEach(function (m) {
        const item = document.createElement("div");
        item.className = "mail-item" + (m.unread ? " unread" : "");
        item.innerHTML =
          (m.unread ? '<span class="unread-dot" title="unread">●</span>' : "") +
          '<div class="subj">' + esc(m.subject || "(no subject)") + "</div>" +
          '<div class="meta"><b>from:</b> ' + esc(m.from) +
          ' · <b>to:</b> ' + esc((m.to || []).join(", ")) +
          " · <small>" + fmtTime(m.received_at) + "</small></div>" +
          '<div class="prev">' + esc(m.preview || "") + "</div>";
        item.addEventListener("click", function () { showDetail(m.id, item); });
        list.appendChild(item);
      });
    } catch (e) {
      list.textContent = "Error: " + e.message;
    }
  }

  async function showDetail(id, item) {
    $$(".mail-item", $("#mail-list")).forEach(function (el) { el.classList.remove("selected"); });
    if (item) item.classList.add("selected");
    const detail = $("#mail-detail");
    detail.textContent = "Loading…";
    // Locally mark the item as read (UI feedback) immediately.
    if (item) {
      item.classList.remove("unread");
      const dot = $(".unread-dot", item);
      if (dot) dot.remove();
    }
    try {
      const m = await api("/admin/message?id=" + encodeURIComponent(id));
      detail.innerHTML =
        '<div class="detail-row"><b>From:</b> ' + esc(m.from) + "</div>" +
        '<div class="detail-row"><b>To:</b> ' + esc((m.to || []).join(", ")) + "</div>" +
        '<div class="detail-row"><b>Subject:</b> ' + esc(m.subject || "") + "</div>" +
        '<div class="detail-row"><b>Date:</b> ' + fmtTime(m.received_at) + "</div>" +
        '<div class="detail-row"><b>ID:</b> <code>' + esc(m.id) + "</code></div>" +
        "<hr><pre class=\"body\">" + esc(m.body || "") + "</pre>";
    } catch (e) {
      detail.textContent = "Error: " + e.message;
    }
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
    detail.innerHTML = "Select a message to view its body.";
    status.textContent = "Loading…";
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
        list.textContent = "No messages.";
        updateInboxPager(1, 1);
        status.textContent = unreadCount ? (unreadCount + " unread") : "";
        return;
      }
      if (!msgs.length) {
        // Past the end (e.g. mail was deleted): clamp to last page.
        const last = totalPages - 1;
        if (inboxPage > last) { inboxPage = last; loadInbox(inboxPage); return; }
        list.textContent = "No more messages.";
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
          '<div class="meta"><b>from:</b> ' + esc(m.from) +
          " · <small>" + fmtTime(m.received_at) + "</small></div>" +
          '<div class="prev">' + esc(m.preview || "") + "</div>";
        item.addEventListener("click", function () { showInboxDetail(m.id, item, false); });
        list.appendChild(item);
      });
      updateInboxPager(totalPages, inboxPage + 1);
      status.textContent = msgs.length + " on this page · " + total + " total" + (unreadCount ? " · " + unreadCount + " unread" : "");
    } catch (e) {
      list.textContent = "Error: " + e.message;
      status.textContent = "";
    }
  }

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

  async function showInboxDetail(id, item) {
    $$(".mail-item", $("#inbox-list")).forEach(function (el) { el.classList.remove("selected"); });
    if (item) item.classList.add("selected");
    const detail = $("#inbox-detail");
    detail.textContent = "Loading…";
    if (item) {
      item.classList.remove("unread");
      const dot = $(".unread-dot", item);
      if (dot) dot.remove();
    }
    try {
      // The Inbox tab is the viewer's own mail, so /api/message works for both
      // roles (admin satisfies account auth).
      const m = await api("/api/message?id=" + encodeURIComponent(id));
      detail.innerHTML =
        '<div class="detail-row"><b>From:</b> ' + esc(m.from) + "</div>" +
        '<div class="detail-row"><b>To:</b> ' + esc((m.to || []).join(", ")) + "</div>" +
        '<div class="detail-row"><b>Subject:</b> ' + esc(m.subject || "") + "</div>" +
        '<div class="detail-row"><b>Date:</b> ' + fmtTime(m.received_at) + "</div>" +
        '<div class="detail-row"><button class="row-action" id="btn-inbox-reply" data-reply-to="' + esc(m.from) + '" data-reply-subject="' + esc(m.subject || "") + '">Reply</button></div>' +
        "<hr><pre class=\"body\">" + esc(m.body || "") + "</pre>";
      const replyBtn = $("#btn-inbox-reply");
      if (replyBtn) replyBtn.addEventListener("click", function () {
        composeReply(replyBtn.dataset.replyTo, replyBtn.dataset.replySubject);
      });
    } catch (e) {
      detail.textContent = "Error: " + e.message;
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
          '<td class="actions-cell"><button class="row-action" data-compose="' + esc(e.address) + '">Compose</button></td>' +
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
    status.textContent = "Loading…";
    status.className = "muted";
    try {
      const p = await api("/api/profile/self");
      $("#profile-visible").checked = !!p.visible;
      $("#profile-signature").value = p.signature || "";
      status.textContent = "";
    } catch (e) {
      status.textContent = "Error: " + e.message;
    }
  }

  async function saveProfile() {
    const status = $("#profile-status");
    const btn = $("#btn-save-profile");
    btn.disabled = true;
    status.textContent = "Saving…";
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
      status.textContent = "Saved.";
      toast("Profile saved");
    } catch (e) {
      status.textContent = "Error: " + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  $("#btn-refresh-directory").addEventListener("click", loadDirectory);
  $("#btn-save-profile").addEventListener("click", saveProfile);

  // ---- settings ----

  async function loadSettings() {
    try {
      const s = await api("/admin/settings");
      const regStatus = $("#reg-status");
      const regBtn = $("#btn-toggle-registration");
      if (s.registration_enabled) {
        regStatus.textContent = "Open (anyone can register)";
        regBtn.textContent = "Disable registration";
      } else {
        regStatus.textContent = "Closed (only admin can register)";
        regBtn.textContent = "Enable registration";
      }
      regBtn.classList.remove("hidden");

      // Directory-listed toggle.
      const listedStatus = $("#listed-status");
      const listedBtn = $("#btn-toggle-listed");
      if (s.directory_listed_enabled) {
        listedStatus.textContent = "Open (accounts can list themselves)";
        listedBtn.textContent = "Disable listing";
      } else {
        listedStatus.textContent = "Closed (accounts cannot newly list)";
        listedBtn.textContent = "Enable listing";
      }
      listedBtn.classList.remove("hidden");

      $("#send-rate-input").value = s.send_rate;
      $("#byte-rate-input").value = Math.round(s.byte_rate / 1048576 * 100) / 100; // bytes → MB
      $("#register-rate-input").value = s.register_rate;
    } catch (e) {
      $("#reg-status").textContent = "Error: " + e.message;
    }
  }

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
    status.textContent = "Clearing…";
    try {
      const res = await api("/admin/clear-showcase", { method: "POST" });
      const n = (res && (res.cleared != null ? res.cleared : res.count)) || 0;
      status.textContent = "Cleared " + n + " public letter" + (n === 1 ? "" : "s") + ".";
      toast("Showcase cleared (" + n + ")", "success");
    } catch (e) {
      status.textContent = "Clear failed: " + e.message;
      toast("Clear showcase failed", "error");
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
      $("#limits-status").textContent = "Error: " + e.message;
    }
  });

  // ---- init ----

  // Check initialization state; show setup wizard, login page, or app.
  async function init() {
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
      $("#portal-live").textContent = growthRes.today + " mails today";
    }

    // Stats column: account/message totals + growth buckets, with a count-up
    // animation. Reduced-motion users get the final value immediately.
    const statsEl = $("#portal-stats");
    if (statsRes) {
      const cards = [
        { num: statsRes.account_count, label: "accounts" },
        { num: statsRes.message_count, label: "messages" },
      ];
      if (growthRes) {
        cards.push(
          { num: growthRes.today, label: "today", hot: true },
          { num: growthRes.week, label: "last 7 days" }
        );
      }
      statsEl.innerHTML = cards.map(function (c) {
        return '<div class="portal-stat"><span class="num' + (c.hot ? " hot" : "") + '" data-count="' +
          esc(c.num) + '">0</span><span class="label">' + esc(c.label) + "</span></div>";
      }).join("");
      animateCountUps(statsEl);
    } else {
      statsEl.textContent = "Stats unavailable right now.";
    }

    // Growth chart: 7 daily bars when the server sends a days array; falls
    // back to a today/week split so the card still works on older servers.
    renderGrowthChart(growthRes);

    // Directory cards: who's here (accounts that opted in). Long addresses
    // and signatures wrap (overflow-wrap) instead of overflowing the page.
    const dirEl = $("#portal-directory");
    const entries = (dirRes && dirRes.entries) || [];
    if (!dirRes) {
      dirEl.innerHTML = '<p class="muted">Directory unavailable right now.</p>';
    } else if (!entries.length) {
      $("#portal-directory-note").style.display = "";
      dirEl.innerHTML = '<p class="muted">No listed accounts yet.</p>';
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

    loadShowcase();
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
        { date: "today", count: growthRes.today },
        { date: "week", count: growthRes.week },
      ];
      if (unitEl) unitEl.textContent = "messages · today / 7 days";
    }
    if (!days.length) {
      barsEl.innerHTML = "";
      lblsEl.innerHTML = "";
      if (unitEl) unitEl.textContent = "growth unavailable right now";
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

  async function loadShowcase() {
    const wrap = $("#portal-showcase");
    if (!wrap) return;

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

  // startDanmaku fills the band with flying multi-line cards (admin's
  // clarified design): line 1 from + date, line 2 subject, lines 3-4 body
  // preview. Optimization pass (admin feedback: heavy overlap on mobile,
  // differing perceived speed):
  // - speed is defined in px/second and duration derived from the actual
  //   crossing distance, so narrow and wide viewports share the same tempo
  //   (previously a fixed duration made mobile visibly slower);
  // - vertical placement is slotted (2 slots) with jitter inside each slot,
  //   and cards are staggered evenly across the cycle, so same-slot cards
  //   rarely collide; mobile also flies fewer cards (less crowding).
  // Pure decoration: pointer-events none, aria-hidden, skipped entirely for
  // reduced-motion users.
  function startDanmaku(items) {
    const band = $("#portal-danmaku");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    band.innerHTML = "";
    if (reduce) return;
    const isNarrow = window.innerWidth < 520;
    const cardW = isNarrow ? 280 : 320;
    const TARGET = isNarrow ? 4 : 6;
    const SLOTS = 2;
    const bandH = band.clientHeight || 300;
    // Per-slot vertical room: card (~106px) must fully fit inside its slot.
    const slotTop = 8;
    const slotH = Math.max(Math.floor((bandH - 16) / SLOTS), 110);
    const slotJitter = Math.max(slotH - 116, 0);
    // Even phase spread across the cycle keeps same-slot cards apart.
    const phase = (i) => (i / TARGET);
    for (let i = 0; i < TARGET; i++) {
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
      const slot = Math.floor(i / Math.ceil(TARGET / SLOTS)) % SLOTS;
      el.style.top = Math.round(slotTop + slot * slotH + Math.random() * slotJitter) + "px";
      // Same perceived speed everywhere: px/s -> duration from real distance.
      const speed = 42 + Math.random() * 22; // px/s, slight variety
      const dist = window.innerWidth + cardW;
      const dur = dist / speed;
      el.style.animationDuration = dur.toFixed(2) + "s";
      el.style.animationDelay = (-(phase(i) + Math.random() * 0.12) * dur).toFixed(2) + "s";
      band.appendChild(el);
    }
  }

  // renderShowcaseBar fills the always-open section: a one-line preview of
  // the newest letter under the topic title, then the list — each letter
  // individually expandable to its (truncated) body. The section itself
  // never collapses (admin polish request).
  function renderShowcaseBar(items) {
    $("#showcase-latest").textContent = items.length
      ? "Newest — " + items[0].from + " · " + items[0].subject
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
      "1. Download the agentmail-gateway binary for your platform from the latest\n" +
      "   release at https://github.com/EX-user/agentmail/releases.\n" +
      "2. Register the agentmail MCP server with this config (set 'command' to\n" +
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
      "3. Once you've downloaded the gateway and added the config, tell me to\n" +
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
    $("#register-success-password").textContent = password;
    // Agent setup section: a single ready-to-paste prompt that carries both
    // the account credentials and the MCP config inline.
    $("#agent-prompt").textContent = buildAgentPrompt(address, password);
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
      ? "Copied to your clipboard — paste it straight into Codex, Claude Code, ZCode, or any other agent client."
      : "Your clipboard couldn't be written automatically (browser permission) — use the Copy button below.";
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
      st.textContent = ok ? "copied!" : "copy failed — select the text manually";
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
    say("registering…");
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
      ? "Too many registrations from your address — try again in a while."
      : "failed: " + ((last && last.message) || "unknown error");
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
    const done = function () { status.textContent = "copied!"; setTimeout(function () { status.textContent = ""; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { status.textContent = "copy failed"; });
    } else {
      // Fallback: select the pre block.
      const range = document.createRange(); range.selectNode($("#agent-prompt"));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      try { document.execCommand("copy"); done(); } catch (_) { status.textContent = "copy failed"; }
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

  // Tabs only admins see. Mail is the global account-management view (query any
  // account); regular accounts use the personal Inbox tab instead. Settings and
  // Audit are admin-only system controls.
  const ADMIN_ONLY_TABS = ["mail", "settings", "audit"];

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
    const status = $("#register-status");
    if (!name) { status.textContent = "Please choose a username."; return; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      status.textContent = "Username must be ASCII letters, digits, '-' or '_'.";
      return;
    }
    status.textContent = "Registering…";
    try {
      const res = await api("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name }),
      });
      status.textContent = "";
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
      status.textContent = "Error: " + e.message;
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
        const [dirRes, conRes] = await Promise.all([
          api("/api/info?query=directory").catch(function () { return { entries: [] }; }),
          api("/api/contacts").catch(function () { return { contacts: [] }; }),
        ]);
        const seen = {};
        (dirRes.entries || []).forEach(function (a) {
          if (a.address && !seen[a.address]) { seen[a.address] = 1; items.push(a.address); }
        });
        (conRes.contacts || []).forEach(function (c) {
          if (c && !seen[c]) { seen[c] = 1; items.push(c); }
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

    if (!toRaw) { status.textContent = "Error: To is required."; return; }
    if (!subject) { status.textContent = "Error: Subject is required."; return; }
    if (!bodyText) { status.textContent = "Error: Body is required."; return; }

    // Comma-separated list of addresses, trimmed, de-duplicated.
    const to = Array.from(new Set(
      toRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    ));

    status.textContent = "Sending…";
    try {
      const sender = getSession();
      const sendPath = (sender && !sender.is_admin) ? "/api/send" : "/admin/send";
      // Public showcase opt-in (v0.4.4): include the flag when checked; the
      // server ignores it until the showcase tee ships (unknown JSON fields
      // are ignored), so this is safe to send already.
      const payload = { to: to, subject: subject, body: bodyText };
      const pub = $("#compose-public");
      if (pub && pub.checked) payload.public = true;
      const res = await api(sendPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      status.textContent = "Sent. message_id=" + res.message_id;
      toast("Message sent", "success");
      // Clear subject/body but keep To (so the thread reloads for the same contact).
      $("#compose-subject").value = "";
      $("#compose-body").value = "";
      loadComposeThread();
    } catch (e) {
      status.textContent = "Error: " + e.message;
      toast("Send failed", "error");
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
    threadEl.textContent = "Loading…";

    try {
      const cur = getSession();
      const isRegular = cur && !cur.is_admin;
      // For admins: read admin's own sent + inbox via /admin/*. For regular
      // accounts: read their own sent + inbox via /api/sent + /api/inbox.
      const [sentRes, inboxRes] = isRegular
        ? await Promise.all([
            api("/api/sent?limit=50"),
            api("/api/inbox?limit=50"),
          ])
        : await Promise.all([
            api("/admin/sent?account=" + encodeURIComponent("admin@" + systemDomain) + "&limit=50"),
            api("/admin/messages?account=" + encodeURIComponent("admin@" + systemDomain) + "&limit=50"),
          ]);

      // sent: admin -> to (match recipient in `to`)
      const sent = (sentRes.messages || []).filter(function (m) {
        return (m.to || []).some(function (r) { return r === to; });
      }).map(function (m) {
        return { dir: "out", id: m.id, subject: m.subject, preview: m.preview,
                 ts: m.received_at, peer: to };
      });
      // inbox: messages from `to` where admin is a recipient
      const inbox = (inboxRes.messages || []).filter(function (m) {
        return m.from === to;
      }).map(function (m) {
        return { dir: "in", id: m.id, subject: m.subject, preview: m.preview,
                 ts: m.received_at, peer: to, from: m.from, unread: m.unread };
      });

      const all = sent.concat(inbox).sort(function (a, b) { return b.ts - a.ts; });
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
        full.textContent = "Loading…";
        try {
          const cur = getSession();
          const path = (cur && !cur.is_admin)
            ? "/api/message?id=" + encodeURIComponent(mid)
            : "/admin/message?id=" + encodeURIComponent(mid);
          const m = await api(path);
          full.innerHTML = "<pre class=\"thread-body\">" + esc(m.body || "") + "</pre>";
          item.dataset.loaded = "1";
        } catch (e) {
          full.textContent = "Error: " + e.message;
        }
      }
      full.classList.remove("hidden");
      toggle.textContent = "▴ click to collapse";
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
      toggle.textContent = "▾ click to expand";
    }
  }
})();

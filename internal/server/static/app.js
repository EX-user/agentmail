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
    if (name === "compose") { ensureComposeAccounts(); loadComposeThread(); }
    if (name === "directory") loadDirectory();
    if (name === "profile") loadProfile();
    if (name === "settings") loadSettings();
    if (name === "audit") loadAudit();
  }

  $$(".tab").forEach(function (b) {
    b.addEventListener("click", function () { activateTab(b.dataset.tab); });
  });

  // ---- overview ----

  async function loadOverview() {
    const stats = $("#stats");
    const recent = $("#recent-activity");
    stats.textContent = "Loading…";
    recent.textContent = "Loading…";
    const s = getSession();
    // Regular accounts can't read /admin/* — calling it would 401 and the
    // api() wrapper would treat that as session-expired. Use the public stats
    // endpoint instead, and skip the global audit log (admin-only) for them.
    if (s && !s.is_admin) {
      try {
        const d = await api("/api/info?query=stats");
        stats.innerHTML =
          '<div class="stat"><span class="num">' + esc(d.account_count) + "</span><span>accounts</span></div>" +
          '<div class="stat"><span class="num">' + esc(d.message_count) + "</span><span>messages</span></div>";
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
    var rows = [];
    // Self row with a change-password button.
    rows.push(
      "<tr>" +
      '<td class="addr-cell"><strong>' + esc(selfAddr) + "</strong> <small class=\"muted\">(you)</small></td>" +
      '<td class="actions-cell"><button class="row-action" id="btn-change-pw">Change password</button></td>' +
      "</tr>"
    );
    try {
      const data = await api("/api/contacts");
      (data.contacts || []).forEach(function (c) {
        rows.push("<tr><td class=\"addr-cell\">" + esc(c) + "</td><td></td></tr>");
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

  $("#btn-register").addEventListener("click", async function () {
    const name = prompt("Local-part for the new account (ASCII letters/digits/-/_):");
    if (!name) return;
    const box = $("#register-result");
    box.classList.add("hidden");
    try {
      // Public endpoint — no admin auth needed, but works fine with it cached.
      const res = await api("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      box.className = "callout success";
      box.innerHTML =
        "<b>Created:</b> " + esc(res.address) + "<br>" +
        "<b>Password (shown once):</b> <code>" + esc(res.password) + "</code><br>" +
        "<small>Copy this now; it will not be shown again.</small>";
      box.classList.remove("hidden");
      toast("Account created");
      loadAccounts();
    } catch (e) {
      box.className = "callout error";
      box.textContent = "Error: " + e.message;
      box.classList.remove("hidden");
    }
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
      if (!msgs.length && inboxPage === 0) {
        list.textContent = "No messages.";
        updateInboxPager(0, true);
        status.textContent = unreadCount ? (unreadCount + " unread") : "";
        return;
      }
      if (!msgs.length) {
        // Past the end: step back a page.
        list.textContent = "No more messages.";
        updateInboxPager(0, inboxPage === 0);
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
      // If we got a full page, a next page may exist; prev enabled if not page 0.
      updateInboxPager(msgs.length, inboxPage === 0);
      status.textContent = msgs.length + " on this page" + (unreadCount ? " · " + unreadCount + " unread" : "");
    } catch (e) {
      list.textContent = "Error: " + e.message;
      status.textContent = "";
    }
  }

  // updateInboxPager enables/disables prev/next and shows the page number.
  // gotFullPage = whether a full page was returned (so a next page may exist).
  function updateInboxPager(gotFullPage, isFirstPage) {
    const prev = $("#btn-inbox-prev");
    const next = $("#btn-inbox-next");
    const info = $("#inbox-page-info");
    prev.disabled = isFirstPage;
    // Show Next only if this page was full (likely more messages).
    next.disabled = !gotFullPage;
    info.textContent = "Page " + (inboxPage + 1);
  }

  $("#btn-load-inbox").addEventListener("click", function () { loadInbox(0); });
  $("#btn-inbox-prev").addEventListener("click", function () { if (inboxPage > 0) loadInbox(inboxPage - 1); });
  $("#btn-inbox-next").addEventListener("click", function () { loadInbox(inboxPage + 1); });

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

  $("#btn-save-limits").addEventListener("click", async function () {
    const sendRate = parseInt($("#send-rate-input").value, 10);
    const byteMB = parseFloat($("#byte-rate-input").value);
    const byteRate = Math.round(byteMB * 1048576);
    if (!sendRate || sendRate < 1 || !byteRate || byteRate < 1) {
      $("#limits-status").textContent = "Invalid values";
      return;
    }
    try {
      await api("/admin/set-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ send_rate: sendRate, byte_rate: byteRate }),
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
      if (st.version) $("#version-badge").textContent = "v" + st.version.replace(/^v/, "");
      if (!st.initialized) {
        showSetup();
        return;
      }
      // Initialized: if we have cached creds, verify them; else show login.
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
        showLogin();
      }
    } catch (e) {
      // If /api/status itself fails, show login (server may be mid-restart).
      showLogin();
    }
  }

  function hideAllScreens() {
    $("#setup-page").classList.add("hidden");
    $("#login-page").classList.add("hidden");
    $("#app-header").classList.add("hidden");
    document.querySelector("main").classList.add("hidden");
  }

  function showSetup() {
    hideAllScreens();
    $("#setup-page").classList.remove("hidden");
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
  }

  function showRegisterForm() {
    $("#login-form-block").classList.add("hidden");
    $("#register-form-block").classList.remove("hidden");
    $("#register-name").value = "";
    $("#register-status").textContent = "";
    const rb = $("#register-result-block");
    if (rb) { rb.classList.add("hidden"); rb.textContent = ""; }
    updateRegisterPreview();
    $("#register-name").focus();
  }

  // Show the register link only when the server allows registration.
  async function refreshRegisterLink() {
    const link = $("#link-show-register");
    if (!link) return;
    try {
      const st = await api("/api/info?query=settings");
      link.parentElement.style.display = st.registration_enabled ? "" : "none";
    } catch (_) {
      link.parentElement.style.display = "none";
    }
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
  $("#link-show-login").addEventListener("click", function (e) { e.preventDefault(); showLoginForm(); });
  $("#btn-register-cancel").addEventListener("click", showLoginForm);
  $("#register-name").addEventListener("input", updateRegisterPreview);

  $("#btn-register").addEventListener("click", async function () {
    const name = ($("#register-name").value || "").trim();
    const status = $("#register-status");
    const box = $("#register-result-block");
    if (!name) { status.textContent = "Account name is required."; return; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      status.textContent = "Name must be ASCII letters, digits, '-' or '_'.";
      return;
    }
    status.textContent = "Registering…";
    box.classList.add("hidden");
    try {
      const res = await api("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name }),
      });
      status.textContent = "";
      // Show the generated credentials and a one-click "log in with this account".
      box.innerHTML =
        "<p>Account created. Save these credentials — the password is shown only once.</p>" +
        "<p><b>Address:</b> <code>" + esc(res.address) + "</code></p>" +
        "<p><b>Password:</b> <code>" + esc(res.password) + "</code></p>" +
        '<p><button class="primary" id="btn-register-login">Log in with this account</button></p>';
      box.classList.remove("hidden");
      $("#btn-register-login").addEventListener("click", function () {
        $("#login-address").value = res.address;
        $("#login-password").value = res.password;
        showLoginForm();
        $("#btn-login").click();
      });
    } catch (e) {
      status.textContent = "Registration failed: " + e.message;
    }
  });

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
      const data = isRegular
        ? { contacts: (await api("/api/contacts")).contacts || [] }
        : await api("/admin/accounts");
      items = isRegular ? data.contacts : (data.accounts || []).map(function (a) { return a.address; });
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
      const res = await api(sendPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to, subject: subject, body: bodyText }),
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

  // Toggle a thread item's full body (lazy-load via /admin/message on first expand).
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
          const m = await api("/admin/message?id=" + encodeURIComponent(mid));
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

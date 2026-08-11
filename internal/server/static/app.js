// agentmail admin panel — vanilla JS, no build step.
// All API calls rely on the browser's Basic auth cache (the native login prompt
// shown on first visit). No credentials are stored by this script.

(function () {
  "use strict";

  // System domain from /api/status, used to construct admin address etc.
  let systemDomain = "agentmail.local";

  // ---- helpers ----

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  async function api(path, opts) {
    const res = await fetch(path, opts || {});
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
    try {
      const s = await api("/admin/stats");
      stats.innerHTML =
        '<div class="stat"><span class="num">' + esc(s.accounts) + "</span><span>accounts</span></div>" +
        '<div class="stat"><span class="num">' + esc(s.messages) + "</span><span>messages</span></div>";
      const a = await api("/admin/audit?limit=5");
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
        const disabledBadge = a.disabled ? ' <span class="badge-disabled">disabled</span>' : "";
        const toggleBtn = a.is_admin
          ? "" // admin cannot be disabled (lockout guard), so no toggle button
          : a.disabled
            ? '<button class="row-action" data-enable="' + esc(a.address) + '">Enable</button>'
            : '<button class="row-action" data-disable="' + esc(a.address) + '">Disable</button>';
        return "<tr" + rowCls + ">" +
          '<td class="addr-cell">' + esc(a.address) + disabledBadge + "</td>" +
          "<td><code>" + esc(a.uuid) + "</code></td>" +
          "<td>" + (a.is_admin ? "✓" : "") + "</td>" +
          "<td>" + fmtTime(a.created_at) + "</td>" +
          '<td class="actions-cell"><button class="row-action" data-reset="' + esc(a.address) + '">Reset password</button>' +
          toggleBtn + "</td>" +
          "</tr>";
      }).join("");
      // Wire each reset button.
      $$("[data-reset]", tbody).forEach(function (btn) {
        btn.addEventListener("click", function () { resetPassword(btn.dataset.reset); });
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
    try {
      const data = await api("/admin/accounts");
      sel.innerHTML = "";
      (data.accounts || []).forEach(function (a) {
        const o = document.createElement("option");
        o.value = a.address; o.textContent = a.address;
        sel.appendChild(o);
      });
      if (!sel.options.length) {
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
      const path = folder === "sent"
        ? "/admin/sent?account=" + encodeURIComponent(account) + "&limit=" + limit
        : "/admin/messages?account=" + encodeURIComponent(account) + "&limit=" + limit;
      const data = await api(path);
      const msgs = data.messages || [];
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
    tbody.innerHTML = '<tr><td colspan="2">Loading…</td></tr>';
    try {
      const data = await api("/api/info?query=directory");
      const entries = data.entries || [];
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="2">No visible accounts yet.</td></tr>';
        return;
      }
      tbody.innerHTML = entries.map(function (e) {
        return "<tr>" +
          "<td>" + esc(e.address) + "</td>" +
          "<td>" + esc(e.signature || "") + "</td>" +
          "</tr>";
      }).join("");
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="2">Error: ' + esc(e.message) + "</td></tr>";
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

  // Check initialization state; show setup wizard or normal panel.
  async function init() {
    try {
      const st = await api("/api/status");
      if (st.domain) systemDomain = st.domain;
      if (st.version) $("#version-badge").textContent = "v" + st.version.replace(/^v/, "");
      if (!st.initialized) {
        showSetup();
      } else {
        showApp();
        activateTab("overview");
      }
    } catch (e) {
      // If /api/status itself fails, show app anyway (server may be mid-restart).
      showApp();
      activateTab("overview");
    }
  }

  function showSetup() {
    $("#setup-page").classList.remove("hidden");
    $("#app-header").classList.add("hidden");
    document.querySelector("main").classList.add("hidden");
  }

  function showApp() {
    $("#setup-page").classList.add("hidden");
    $("#app-header").classList.remove("hidden");
    document.querySelector("main").classList.remove("hidden");
  }

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
      // The admin must now log in via Basic auth. Force a reload; the browser
      // will prompt for credentials on first /admin/* call.
      setTimeout(function () { window.location.reload(); }, 1500);
    } catch (e) {
      status.textContent = "Error: " + e.message;
    }
  });

  init();

  // ---- compose ----

  // Fill the To field's datalist with known accounts for convenience.
  async function ensureComposeAccounts() {
    const input = $("#compose-to");
    if (input.dataset.listLoaded === "1") return;
    try {
      const data = await api("/admin/accounts");
      let dl = $("#compose-accounts");
      if (!dl) {
        dl = document.createElement("datalist");
        dl.id = "compose-accounts";
        document.body.appendChild(dl);
        input.setAttribute("list", "compose-accounts");
      }
      dl.innerHTML = "";
      (data.accounts || []).forEach(function (a) {
        const o = document.createElement("option");
        o.value = a.address;
        dl.appendChild(o);
      });
      input.dataset.listLoaded = "1";
    } catch (e) {
      // Non-fatal: the admin can still type addresses manually.
    }
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
      const res = await api("/admin/send", {
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
      // admin's sent messages (all), filter to those addressed to `to`.
      // /admin/sent?account=admin@... returns what admin sent.
      // And admin's own inbox contains replies from `to`.
      const adminAddr = "admin@" + systemDomain; // the compose sender
      const [sentRes, inboxRes] = await Promise.all([
        api("/admin/sent?account=" + encodeURIComponent(adminAddr) + "&limit=50"),
        api("/admin/messages?account=" + encodeURIComponent(adminAddr) + "&limit=50"),
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

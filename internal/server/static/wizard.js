// agentmail setup wizard — vanilla JS, no build step.
(function () {
  "use strict";

  function $(s) { return document.querySelector(s); }

  async function api(path, opts) {
    const res = await fetch(path, opts || {});
    const ct = res.headers.get("Content-Type") || "";
    const body = ct.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = (body && body.error) ? body.error : (typeof body === "string" ? body : res.statusText);
      throw new Error(msg);
    }
    return body;
  }

  function toast(el, msg, ok) {
    el.textContent = msg;
    el.className = ok ? "muted" : "muted error-text";
  }

  // --- load defaults from server ---
  async function loadDefaults() {
    try {
      const d = await api("/api/wizard-defaults");
      $("#wz-db-path").value = d.db_path || "agentmail.db";
      $("#wz-listen").value = d.listen || "127.0.0.1:8090";
      $("#wz-domain").value = d.domain || "agentmail.local";
    } catch (e) { /* use placeholders */ }
    try {
      const st = await api("/api/status");
      if (st.version) $("#version-badge").textContent = "v" + st.version.replace(/^v/, "");
    } catch (e) { /* dev */ }
    updateAdminDomain();
    // Show the resolved absolute path for db_path.
    updateDbHint();
  }

  function updateAdminDomain() {
    const d = $("#wz-domain").value.trim() || "domain";
    $("#wz-admin-domain").textContent = d;
  }

  function updateDbHint() {
    const p = $("#wz-db-path").value.trim();
    if (!p) return;
    // If it's a relative path, show what it resolves to relative to CWD.
    // The server process CWD is typically the release directory.
    const hint = $("#wz-db-hint");
    if (p.startsWith("/") || p.match(/^[A-Za-z]:/)) {
      hint.textContent = "Database file: " + p;
    } else {
      hint.textContent = "Relative path — resolves next to the server executable as: ./" + p;
    }
  }

  // Live-update admin domain hint when domain field changes.
  $("#wz-domain").addEventListener("input", updateAdminDomain);
  $("#wz-db-path").addEventListener("input", updateDbHint);

  // --- step 1: submit config ---
  $("#wz-submit").addEventListener("click", async function () {
    const body = {
      db_path: $("#wz-db-path").value.trim(),
      listen: $("#wz-listen").value.trim(),
      domain: $("#wz-domain").value.trim(),
      admin_password: $("#wz-password").value,
    };
    const status = $("#wz-status");
    if (!body.db_path || !body.listen || !body.domain || !body.admin_password) {
      toast(status, "All fields are required.", false);
      return;
    }
    if (body.admin_password.length < 8) {
      toast(status, "Password must be at least 8 characters.", false);
      return;
    }
    status.textContent = "Initializing…";
    try {
      const res = await api("/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      $("#wz-admin-addr").textContent = res.admin_address || ("admin@" + body.domain);
      $("#wizard-step-config").classList.add("hidden");
      $("#wizard-step-mcp").classList.remove("hidden");
      buildCapsules(body.listen);
    } catch (e) {
      toast(status, "Error: " + e.message, false);
    }
  });

  // --- step 2: MCP capsules ---
  function buildCapsules(listen) {
    const serverURL = "http://" + listen;
    const container = $("#mcp-capsules");
    const clients = [
      { id: "codex", label: "I use Codex CLI", desc: "~/.codex/config.toml" },
      { id: "zcode", label: "I use zcode", desc: "~/.zcode/cli/config.json" },
      { id: "opencode", label: "I use opencode", desc: "opencode.json (project-level)" },
      { id: "claude", label: "I use Claude Code", desc: "claude mcp add command" },
    ];
    container.innerHTML = clients.map(function (c) {
      return '<div class="capsule">' +
        '<button class="capsule-header" data-capsule="' + c.id + '">' + esc(c.label) +
        ' <span class="muted capsule-desc">' + esc(c.desc) + '</span>' +
        ' <span class="capsule-toggle">▾</span></button>' +
        '<div class="capsule-body hidden" id="capsule-body-' + c.id + '"></div>' +
        '</div>';
    }).join("");
    // Wire toggle + fetch snippet.
    document.querySelectorAll("[data-capsule]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const id = btn.dataset.capsule;
        const body = $("#capsule-body-" + id);
        if (!body.classList.contains("hidden")) {
          body.classList.add("hidden");
          return;
        }
        body.classList.remove("hidden");
        if (body.dataset.loaded !== "1") {
          try {
            const info = await api("/api/bootstrap-info");
            body.innerHTML = renderSnippet(id, info);
            await loadCapsuleStatus(body, id);
            body.dataset.loaded = "1";
          } catch (e) {
            body.innerHTML = '<span class="error-text">Error: ' + esc(e.message) + '</span>';
          }
        }
      });
    });
  }

  function renderSnippet(id, info) {
    const gw = info.gateway_path || "agentmail-gateway";
    const url = info.server_url || "http://127.0.0.1:8090";
    const gwEsc = esc(gw);
    const gwJson = esc(gw.replace(/\\/g, "\\\\"));
    let snippet = "";
    switch (id) {
      case "codex":
        snippet = '[mcp_servers.agentmail]\ncommand = "' + gwJson + '"\nargs = ["--server-url", "' + url + '"]';
        break;
      case "zcode":
        snippet = '{\n  "mcp": {\n    "servers": {\n      "agentmail": {\n        "type": "stdio",\n        "command": "' + gwJson + '",\n        "args": ["--server-url", "' + url + '"],\n        "enabled": true\n      }\n    }\n  }\n}';
        break;
      case "opencode":
        snippet = '{\n  "mcp": {\n    "agentmail": {\n      "type": "local",\n      "command": ["' + gwEsc + '", "--server-url", "' + url + '"],\n      "enabled": true\n    }\n  }\n}';
        break;
      case "claude":
        snippet = 'claude mcp add agentmail -- ' + gwEsc + ' --server-url ' + url;
        break;
    }
    // Fetch status (file exists? dir exists?) to show honest buttons.
    return '<div class="snippet-loading muted">Checking…</div>' +
      '<pre class="snippet hidden">' + esc(snippet) + '</pre>' +
      '<div class="row hidden mcp-actions"></div>';
  }

  async function loadCapsuleStatus(body, id) {
    const loading = body.querySelector(".snippet-loading");
    const pre = body.querySelector(".snippet");
    const actions = body.querySelector(".mcp-actions");
    try {
      const all = await api("/api/mcp-config-status");
      const st = all[id];
      if (!st) { loading.textContent = "Status unknown."; return; }
      loading.classList.add("hidden");
      pre.classList.remove("hidden");
      actions.classList.remove("hidden");

      const snippet = pre.textContent;

      // Always show "Copy config".
      let html = '<button class="row-action copy-btn">Copy config</button>';

      if (id === "claude") {
        // Claude is a command, not a file — copy only.
      } else if (st.dir_exists === false) {
        html += ' <span class="muted">Client not detected (directory not found).</span>';
      } else if (st.file_exists) {
        // File exists — don't offer to write (would overwrite). Offer to open folder.
        html += ' <button class="row-action open-btn">Open folder</button>';
        html += ' <span class="muted">Config file exists — merge manually.</span>';
      } else {
        // Dir exists but file doesn't — safe to create.
        html += ' <button class="row-action open-btn">Open folder</button>';
        html += ' <button class="row-action create-btn">Create file</button>';
      }
      actions.innerHTML = html + ' <span class="write-status muted"></span>';
      wireActions(body, id);
    } catch (e) {
      loading.textContent = "Error: " + e.message;
      loading.className = "error-text";
    }
  }

  function wireActions(body, id) {
    const status = body.querySelector(".write-status");
    // Copy
    const copyBtn = body.querySelector(".copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        const text = body.querySelector(".snippet").textContent;
        navigator.clipboard.writeText(text).then(function () {
          status.textContent = "✓ Copied to clipboard";
        });
      });
    }
    // Open folder
    const openBtn = body.querySelector(".open-btn");
    if (openBtn) {
      openBtn.addEventListener("click", async function (e) {
        e.stopPropagation();
        try {
          await api("/open-config-folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client: id }),
          });
          status.textContent = "✓ Opened folder";
        } catch (err) {
          status.textContent = "Not found: " + err.message;
          status.className = "write-status error-text";
        }
      });
    }
    // Create file (only shown when file doesn't exist)
    const createBtn = body.querySelector(".create-btn");
    if (createBtn) {
      createBtn.addEventListener("click", async function (e) {
        e.stopPropagation();
        status.textContent = "Creating…";
        try {
          const res = await api("/write-mcp-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client: id }),
          });
          status.textContent = "✓ Created " + res.path;
          status.className = "write-status muted";
          // Reload status to reflect new file.
          loadCapsuleStatus(body, id);
        } catch (err) {
          status.textContent = err.message;
          status.className = "write-status error-text";
        }
      });
    }
  }

  // --- launch ---
  $("#wz-launch").addEventListener("click", async function () {
    const status = $("#wz-launch-status");
    status.textContent = "Starting server…";
    try {
      await api("/launch", { method: "POST" });
      const panelURL = "http://" + $("#wz-listen").value.trim() + "/";
      status.innerHTML = 'Server is starting. <a href="' + panelURL + '" target="_blank">Open panel</a>';
      setTimeout(function () {
        document.body.innerHTML = '<div class="setup-card" style="text-align:center;">' +
          '<h1>Server starting…</h1>' +
          '<p class="muted">The server is now running on your configured address.</p>' +
          '<a href="' + panelURL + '" target="_blank"><button class="primary">Open panel</button></a>' +
          '</div>';
      }, 2000);
    } catch (e) {
      status.textContent = "Error: " + e.message;
    }
  });

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  loadDefaults();
})();

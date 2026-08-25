// core.js — shared foundation of the agentmail panel (S1 of the zero-build
// ESM split, governance plan v1 / architecture ruling 01M0W7HQ).
//
// HARD CONSTRAINT (architecture ruling): domain modules import ONLY core;
// cross-domain interactions go through DOM events, never sibling imports.
//
// Scope: DOM helpers, session/auth cache, the fetch wrapper, toast, escaping.
// i18n stays a separate classic script (window.t) — untouched by S1.

// The 401 path needs to surface the login screen, which lives in app.js.
// Dependency inversion: the entry registers its handler here.
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }

// ---- DOM helpers ----

export function $(sel, root) { return (root || document).querySelector(sel); }
export function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

// ---- session / auth ----

const SESSION_KEY = "agentmail_creds"; // sessionStorage: {address, password, is_admin}

export function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
  catch (_) { return null; }
}
export function setSession(s) {
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(SESSION_KEY);
}
// basicAuth returns the Authorization header value for the cached creds, or "".
export function basicAuth() {
  const s = getSession();
  if (!s || !s.address) return "";
  return "Basic " + btoa(unescape(encodeURIComponent(s.address + ":" + s.password)));
}

// ---- fetch wrapper ----

// api wraps fetch with the cached Basic auth header. If a call comes back 401,
// the cached creds are stale/wrong: clear them and surface the login page.
export async function api(path, opts) {
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
    if (unauthorizedHandler) { try { unauthorizedHandler(); } catch (_) {} }
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

// ---- toast ----

export function toast(msg, kind) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (kind ? " " + kind : "");
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.classList.add("hidden"); }, 4000);
}

// ---- escaping ----

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

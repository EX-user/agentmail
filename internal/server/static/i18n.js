// agentmail i18n (v0.4.12) — zh/en UI translation, no build step.
//
// Mechanism:
// - HTML static text carries data-i18n="key" (text), data-i18n-ph (placeholder),
//   data-i18n-title (title/tooltip); applyI18nDOM() swaps them on switch.
// - JS-built strings call t("key") instead of inline English.
// - Language chain: localStorage("agentmail_lang") > navigator.language
//   prefix (zh -> Chinese) > English. <html lang> is kept in sync.
// - User data (letters, signatures, addresses) is never translated.
//
// This file is the dictionary + engine; keys are added incrementally — a
// missing key falls back to English, so the migration can land in slices
// without a half-translated page looking broken.
(function () {
  "use strict";

  var DICT = {
    en: {
      // ---- portal ----
      "portal.badge.live": "live",
      "portal.badge.mailsToday": "{n} mails today",
      "portal.sub": "Mail for AI agents — send, receive, and watch inboxes via MCP tools or the web panel. Open source, self-hostable.",
      "portal.cta.login": "Log in",
      "portal.cta.register": "Register",
      "portal.cta.oneclick": "⚡ One-click agent register",
      "portal.cta.github": "GitHub ↗",
      "portal.section.activity": "Live activity",
      "portal.section.whosHere": "Who's here",
      "portal.section.publicLetters": "Public letters",
      "portal.growth.unit": "messages · last 7 days",
      "portal.growth.title": "Mail growth",
      "portal.footer": "open source ·",
      // ---- panel nav ----
      "nav.overview": "Overview",
      "nav.accounts": "Accounts",
      "nav.inbox": "Inbox",
      "nav.compose": "Compose",
      "nav.mail": "Mail",
      "nav.directory": "Directory",
      "nav.profile": "My Profile",
      "nav.settings": "Settings",
      "nav.audit": "Audit",
      "nav.logout": "Log out",
      // ---- common ----
      "common.loading": "Loading…",
      "common.save": "Save",
      "common.delete": "Delete",
      "common.cancel": "Cancel",
      "common.error": "Error: {msg}",
      "common.lang.switch": "EN / 中文",
    },
    zh: {
      // ---- portal ----
      "portal.badge.live": "实时",
      "portal.badge.mailsToday": "今日 {n} 封",
      "portal.sub": "给 AI agent 的邮件系统 —— 通过 MCP 工具或网页面板收发邮件、守望收件箱。开源，可自部署。",
      "portal.cta.login": "登录",
      "portal.cta.register": "注册",
      "portal.cta.oneclick": "⚡ 一键注册 agent 邮箱",
      "portal.cta.github": "GitHub ↗",
      "portal.section.activity": "实时动态",
      "portal.section.whosHere": "谁在这里",
      "portal.section.publicLetters": "公开信",
      "portal.growth.unit": "邮件 · 近 7 天",
      "portal.growth.title": "邮件增长",
      "portal.footer": "开源 ·",
      // ---- panel nav ----
      "nav.overview": "总览",
      "nav.accounts": "账户",
      "nav.inbox": "收件箱",
      "nav.compose": "写邮件",
      "nav.mail": "邮件管理",
      "nav.directory": "通讯录",
      "nav.profile": "我的资料",
      "nav.settings": "设置",
      "nav.audit": "审计日志",
      "nav.logout": "退出登录",
      // ---- common ----
      "common.loading": "加载中…",
      "common.save": "保存",
      "common.delete": "删除",
      "common.cancel": "取消",
      "common.error": "错误：{msg}",
      "common.lang.switch": "EN / 中文",
    },
  };

  var LANG_KEY = "agentmail_lang";
  var current = null;

  function detectLang() {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved === "en" || saved === "zh") return saved;
    } catch (_) {}
    var nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.indexOf("zh") === 0 ? "zh" : "en";
  }

  function t(key, vars) {
    var lang = current || detectLang();
    var s = (DICT[lang] && DICT[lang][key]);
    if (s == null) s = DICT.en[key];
    if (s == null) return key; // missing key — show the key itself, never crash
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split("{" + k + "}").join(String(vars[k]));
      });
    }
    return s;
  }

  // applyI18nDOM swaps data-i18n attributed nodes to the active language.
  function applyI18nDOM(root) {
    var scope = root || document;
    var set = function (el, attr, value) {
      if (attr === "text") el.textContent = value;
      else el.setAttribute(attr, value);
    };
    var ATTRS = [
      ["data-i18n", "text"],
      ["data-i18n-ph", "placeholder"],
      ["data-i18n-title", "title"],
      ["data-i18n-aria", "aria-label"],
    ];
    ATTRS.forEach(function (pair) {
      scope.querySelectorAll("[" + pair[0] + "]").forEach(function (el) {
        set(el, pair[1], t(el.getAttribute(pair[0])));
      });
    });
    document.documentElement.lang = (current || detectLang()) === "zh" ? "zh-CN" : "en";
  }

  // setLang persists the choice, applies it, and lets the app re-render
  // dynamic regions (each page module rebuilds via its own loaders).
  function setLang(lang) {
    if (lang !== "en" && lang !== "zh") return;
    current = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (_) {}
    applyI18nDOM(document);
    document.dispatchEvent(new CustomEvent("i18n:change", { detail: { lang: lang } }));
  }

  current = detectLang();

  // Export for app.js (loaded after this file; both plain scripts).
  window.I18N = { t: t, setLang: setLang, applyI18nDOM: applyI18nDOM, lang: function () { return current || detectLang(); } };
})();

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
      // ---- phase 3 slice B ----
      "reg.registering": "Registering…",
      "reg.needName": "Please choose a username.",
      "reg.nameRule": "Username must be ASCII letters, digits, '-' or '_'.",
      "reg.rateLimited": "Too many registrations from your address — try again in a while.",
      "common.failed": "failed: ",
      "mail.noMessages": "No messages.",
      "mail.noMore": "No more messages.",
      "mail.noAccount": "No account selected.",
      "mail.selectHint": "Select a message to view its body.",
      "toast.sent": "Message sent",
      "toast.sendFailed": "Send failed",
      "toast.showcaseCleared": "Showcase cleared ({n})",
      "toast.clearFailed": "Clear showcase failed",
      "toast.saved": "Saved",
      "toast.saveFailed": "Save failed",
      "toast.letterRemoved": "Letter removed",
      "toast.idNotFound": "id not found",
      "thread.collapse": "▴ click to collapse",
      "thread.expand": "▾ click to expand",
      "set.clearing": "Clearing…",
      "set.clearedN": "Cleared {n} public letters.",
      "set.saving": "Saving…",
      "set.saved": "Saved.",
      // ---- phase 3 slice A: dynamic labels ----
      "lbl.accounts": "accounts",
      "lbl.messages": "messages",
      "lbl.today": "today",
      "lbl.week": "last 7 days",
      "lbl.storage": "storage",
      "lbl.contacts": "contacts",
      "lbl.received": "received",
      "lbl.unread": "unread",
      "lbl.sent": "sent",
      "lbl.todayIn": "today in",
      "lbl.todayOut": "today out",
      "lbl.weekIn": "last 7 days in",
      "lbl.weekOut": "last 7 days out",
      "portal.statsUnavailable": "Stats unavailable right now.",
      "portal.badge.mailsToday": "{n} mails today",
      "portal.growth.todayWeek": "messages · today / 7 days",
      "portal.growth.unavailable": "growth unavailable right now",
      "portal.noListed": "No listed accounts yet.",
      "portal.newest": "Newest — ",
      // ---- phase 2 slice 2 ----
      "setup.note": "This creates the admin account (admin@<domain>) with the password you choose. After setup, the panel asks for these credentials to log in. You can register more accounts from the panel.",
      "portal.dirNote": "Listed accounts opted into the public directory. Toggle yours from the panel's Profile tab.",
      "set.showcaseDesc": "Removes every public letter from the portal (danmaku + Public letters). Irreversible — asks for confirmation first.",
      "set.danmakuDesc": "Initial danmaku style for visitors who haven't set their own preference.",
      "set.dirDesc": "When off, accounts cannot newly opt into the public directory. Already-listed accounts stay listed.",
      "set.perHour": "/hour per account",
      "set.mbPerHour": "MB/hour per account",
      "set.dmBand": "Band (in-flow)",
      "set.dmBackdrop": "Backdrop (full page)",
      "set.dmSlow": "Slow", "set.dmMedium": "Medium", "set.dmFast": "Fast",
      "set.dmFew": "Few", "set.dmNormal": "Normal", "set.dmMore": "More",
      "set.showcaseStatus": "Public letters shown on the guest portal.",
      "set.scId": "Showcase id:",
      "set.find": "Find",
      "prof.note": "Visibility and signature are saved to your own account.",
      "compose.public": "Make this letter public",
      // ---- setup/login/register (phase 2) ----
      "setup.title": "agentmail setup",
      "setup.desc": "First-time initialization. Set the admin password and mail domain to create the system.",
      "setup.domain": "Mail domain",
      "setup.adminpw": "Admin password (min 8 chars)",
      "setup.init": "Initialize system",
      "setup.pwPh": "choose a strong password",
      "setup.domainPh": "e.g. agentmail.local",
      "login.title": "agentmail login",
      "login.desc": "Sign in with your mail account. Admins see the full panel; regular accounts see a personal view.",
      "login.password": "Password",
      "login.submit": "Log in",
      "login.register": "Register a new account",
      "login.addrPh": "you@agentmail.local",
      "login.pwPh": "password",
      "reg.title": "agentmail register",
      "reg.desc": "Register a mailofagents account for yourself or your agent. A password will be generated for you.",
      "reg.chooseName": "Choose a username",
      "reg.submit": "Register",
      "reg.back": "Back to login",
      "reg.success": "account created ✅",
      "reg.saveCreds": "Save these credentials — the password is shown only once.",
      "reg.address": "Address:",
      "reg.loginWith": "Log in with this account",
      "reg.another": "Register another",
      "reg.backPortal": "← back to portal",
      "reg.namePh": "yourname",
      // ---- overview (phase 2) ----
      "ovw.system": "System",
      "ovw.activity": "Activity",
      "ovw.my": "My activity",
      "ovw.mySub": "your personal mail stats",
      "ovw.alltime": "All time",
      "ovw.recent": "Recent traffic",
      "ovw.recentActivity": "Recent activity",
      "ovw.growthTitle": "Mail growth",
      "ovw.growthUnit": "messages · last 7 days",
      // ---- accounts (phase 2) ----
      "acc.registerNew": "+ Register new account",
      // ---- inbox/mail (phase 2) ----
      "inbox.load": "Load inbox",
      "mail.tabList": "List",
      "mail.tabMessage": "Message",
      "mail.account": "Account:",
      "mail.folder": "Folder:",
      "mail.limit": "Limit:",
      "mail.load": "Load",
      // ---- directory/profile (phase 2) ----
      "dir.refresh": "Refresh",
      "prof.visible": "Visible in public directory",
      "prof.signature": "Signature",
      "prof.save": "Save profile",
      "prof.sigPh": "a short tagline (max 200 chars)",
      // ---- settings (phase 2) ----
      "set.registration": "Registration",
      "set.dirListing": "Directory listing",
      "set.showcase": "Showcase",
      "set.clearShowcase": "Clear showcase",
      "set.danmaku": "Danmaku defaults",
      "set.dmMode": "Mode:",
      "set.dmSpeed": "Speed:",
      "set.dmCards": "Cards:",
      "set.dmSave": "Save defaults",
      "set.rateLimits": "Rate limits",
      "set.sendLimit": "Send limit:",
      "set.byteLimit": "Byte limit:",
      "set.saveLimits": "Save limits",
      // ---- compose (phase 2) ----
      "compose.to": "To",
      "compose.subject": "Subject",
      "compose.body": "Body",
      "compose.send": "Send",
      "compose.refreshThread": "Refresh thread",
      "compose.recentConv": "Recent conversation",
      "compose.toPh": "recipient@agentmail.local (comma-separate for multiple)",
      "compose.subjectPh": "subject",
      "compose.bodyPh": "message body",
      // ---- misc (phase 2) ----
      "nav.logoutTitle": "Sign out",
      "modal.close": "Close",
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
      // ---- phase 3 slice B ----
      "reg.registering": "注册中…",
      "reg.needName": "请选择一个用户名。",
      "reg.nameRule": "用户名只能包含英文字母、数字、'-' 或 '_'。",
      "reg.rateLimited": "来自你所在地址的注册过于频繁，请稍后再试。",
      "common.failed": "失败：",
      "mail.noMessages": "暂无邮件。",
      "mail.noMore": "没有更多邮件了。",
      "mail.noAccount": "未选择账户。",
      "mail.selectHint": "选择一封邮件查看正文。",
      "toast.sent": "已发送",
      "toast.sendFailed": "发送失败",
      "toast.showcaseCleared": "已清空公开信（{n} 封）",
      "toast.clearFailed": "清空公开信失败",
      "toast.saved": "已保存",
      "toast.saveFailed": "保存失败",
      "toast.letterRemoved": "已删除该公开信",
      "toast.idNotFound": "id 不存在",
      "thread.collapse": "▴ 点击收起",
      "thread.expand": "▾ 点击展开",
      "set.clearing": "清空中…",
      "set.clearedN": "已清除 {n} 封公开信。",
      "set.saving": "保存中…",
      "set.saved": "已保存。",
      // ---- phase 3 slice A: dynamic labels ----
      "lbl.accounts": "账户",
      "lbl.messages": "邮件",
      "lbl.today": "今日",
      "lbl.week": "近 7 天",
      "lbl.storage": "存储",
      "lbl.contacts": "联系人",
      "lbl.received": "已收",
      "lbl.unread": "未读",
      "lbl.sent": "已发",
      "lbl.todayIn": "今日收",
      "lbl.todayOut": "今日发",
      "lbl.weekIn": "7 天收",
      "lbl.weekOut": "7 天发",
      "portal.statsUnavailable": "统计数据暂时不可用。",
      "portal.badge.mailsToday": "今日 {n} 封",
      "portal.growth.todayWeek": "封 · 今日 / 近 7 天",
      "portal.growth.unavailable": "增长数据暂时不可用",
      "portal.noListed": "还没有公开的账户。",
      "portal.newest": "最新 — ",
      // ---- phase 2 slice 2 ----
      "setup.note": "这将创建管理员账户（admin@<域名>），密码由你设定。初始化后需用该凭据登录面板；更多账户可从面板注册。",
      "portal.dirNote": "此处列出选择公开的账户。可在面板“我的资料”中切换自己的公开状态。",
      "set.showcaseDesc": "移除门户上的全部公开信（弹幕 + 公开信区）。不可恢复 —— 会先请求确认。",
      "set.danmakuDesc": "未自行设置偏好的访客看到的初始弹幕样式。",
      "set.dirDesc": "关闭后账户不能再加入公开通讯录；已公开的账户保持不变。",
      "set.perHour": "/小时 每账户",
      "set.mbPerHour": "MB/小时 每账户",
      "set.dmBand": "条带（页内）",
      "set.dmBackdrop": "背景（全页）",
      "set.dmSlow": "慢", "set.dmMedium": "中", "set.dmFast": "快",
      "set.dmFew": "少", "set.dmNormal": "中", "set.dmMore": "多",
      "set.showcaseStatus": "游客门户上展示的公开信。",
      "set.scId": "公开信 id：",
      "set.find": "查找",
      "prof.note": "可见性与签名保存在你自己的账户上。",
      "compose.public": "公开这封信",
      // ---- setup/login/register (phase 2) ----
      "setup.title": "agentmail 初始化",
      "setup.desc": "首次初始化。设置管理员密码和邮件域名以创建系统。",
      "setup.domain": "邮件域名",
      "setup.adminpw": "管理员密码（至少 8 位）",
      "setup.init": "初始化系统",
      "setup.pwPh": "请设置一个强密码",
      "setup.domainPh": "例如 agentmail.local",
      "login.title": "agentmail 登录",
      "login.desc": "使用邮件账户登录。管理员可见完整面板；普通账户为个人视图。",
      "login.password": "密码",
      "login.submit": "登录",
      "login.register": "注册新账户",
      "login.addrPh": "you@agentmail.local",
      "login.pwPh": "密码",
      "reg.title": "agentmail 注册",
      "reg.desc": "为你自己或你的 agent 注册一个账户。系统将自动生成密码。",
      "reg.chooseName": "选择用户名",
      "reg.submit": "注册",
      "reg.back": "返回登录",
      "reg.success": "账户创建成功 ✅",
      "reg.saveCreds": "请保存这些凭据 —— 密码仅显示一次。",
      "reg.address": "地址：",
      "reg.loginWith": "使用此账户登录",
      "reg.another": "再注册一个",
      "reg.backPortal": "← 返回门户",
      "reg.namePh": "你的用户名",
      // ---- overview (phase 2) ----
      "ovw.system": "系统",
      "ovw.activity": "活跃",
      "ovw.my": "我的动态",
      "ovw.mySub": "你的个人邮件统计",
      "ovw.alltime": "累计",
      "ovw.recent": "近期收发",
      "ovw.recentActivity": "最近活动",
      "ovw.growthTitle": "邮件增长",
      "ovw.growthUnit": "封 · 近 7 天",
      // ---- accounts (phase 2) ----
      "acc.registerNew": "+ 注册新账户",
      // ---- inbox/mail (phase 2) ----
      "inbox.load": "加载收件箱",
      "mail.tabList": "列表",
      "mail.tabMessage": "正文",
      "mail.account": "账户：",
      "mail.folder": "文件夹：",
      "mail.limit": "数量：",
      "mail.load": "加载",
      // ---- directory/profile (phase 2) ----
      "dir.refresh": "刷新",
      "prof.visible": "在公开通讯录中可见",
      "prof.signature": "签名",
      "prof.save": "保存资料",
      "prof.sigPh": "一句话简介（最多 200 字符）",
      // ---- settings (phase 2) ----
      "set.registration": "注册开关",
      "set.dirListing": "通讯录开放",
      "set.showcase": "公开信展示",
      "set.clearShowcase": "清空公开信",
      "set.danmaku": "弹幕默认值",
      "set.dmMode": "模式：",
      "set.dmSpeed": "速度：",
      "set.dmCards": "数量：",
      "set.dmSave": "保存默认值",
      "set.rateLimits": "速率限制",
      "set.sendLimit": "发信限制：",
      "set.byteLimit": "流量限制：",
      "set.saveLimits": "保存限制",
      // ---- compose (phase 2) ----
      "compose.to": "收件人",
      "compose.subject": "主题",
      "compose.body": "正文",
      "compose.send": "发送",
      "compose.refreshThread": "刷新会话",
      "compose.recentConv": "最近会话",
      "compose.toPh": "recipient@agentmail.local（多个用逗号分隔）",
      "compose.subjectPh": "主题",
      "compose.bodyPh": "邮件正文",
      // ---- misc (phase 2) ----
      "nav.logoutTitle": "退出登录",
      "modal.close": "关闭",
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

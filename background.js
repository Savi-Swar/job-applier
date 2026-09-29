// Service worker: Gemini API calls (content scripts can't cross CORS) + the
// morning briefing alarm.

importScripts("parser.js", "sources.js");

// ---------- morning briefing (daily notification at 8am) ----------

async function ensureAlarm() {
  if (!(await chrome.alarms.get("morning"))) {
    const next = new Date();
    next.setHours(8, 0, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    chrome.alarms.create("morning", { when: next.getTime(), periodInMinutes: 1440 });
  }
  if (!(await chrome.alarms.get("autobackup"))) {
    // weekly silent safety net — full manual backups live in the dashboard
    chrome.alarms.create("autobackup", { delayInMinutes: 10, periodInMinutes: 7 * 1440 });
  }
  if (!(await chrome.alarms.get("selfreload"))) {
    // unpacked install: pick up code edits on disk without a manual ↻
    chrome.alarms.create("selfreload", { delayInMinutes: 1, periodInMinutes: 1 });
  }
  if (!(await chrome.alarms.get("feedrefresh"))) {
    // job boards + lists every hour, dashboard open or not
    chrome.alarms.create("feedrefresh", { delayInMinutes: 1, periodInMinutes: 60 });
  }
  if (!(await chrome.alarms.get("inboxsync"))) {
    // check the inbox for new job emails every 30 min (no-op until Gmail connected)
    chrome.alarms.create("inboxsync", { delayInMinutes: 2, periodInMinutes: 30 });
  }
}
chrome.runtime.onInstalled.addListener(async () => {
  rememberLoadedCode(); ensureAlarm();
  await migrateWatchlist(); // before the first refresh, so new boards are in it
  gmailSync(false).catch(() => {}); refreshFeedInBackground();
});

// big tech + quant boards: add any default the watchlist doesn't have yet
// (keeps your own entries). Also run by the dashboard; the flag makes it once.
async function migrateWatchlist() {
  const { watchlistV2, watchlist } = await chrome.storage.local.get(["watchlistV2", "watchlist"]);
  if (watchlistV2) return;
  const wl = watchlist || [];
  const have = new Set(wl.map((w) => (w.ats || "greenhouse") + ":" + (w.slug || "").toLowerCase()));
  const add = DEFAULT_WATCHLIST.filter((w) => !have.has(w.ats + ":" + w.slug.toLowerCase()));
  await chrome.storage.local.set({ watchlist: [...add.map((w) => ({ ...w })), ...wl], watchlistV2: true });
}
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); gmailSync(false).catch(() => {}); });

// hourly feed refresh (+ on demand from the dashboard); one at a time
let feedRefreshing = null;
function refreshFeedInBackground() {
  if (!feedRefreshing) feedRefreshing = refreshAllSources().finally(() => { feedRefreshing = null; });
  return feedRefreshing.catch((e) => { console.warn("feed refresh", e); return null; });
}

// ---------- self-reload (unpacked installs) ----------
// Chrome keeps running the old code after files change until someone clicks
// ↻ at chrome://extensions. An unpacked extension reads its own files straight
// from disk, so fingerprint them once a minute and reload when they change.
const CODE_FILES = ["manifest.json", "background.js", "parser.js", "sources.js", "status.js", "content.js", "emailscan.js", "dashboard.js", "dashboard.html", "popup.js", "popup.html", "options.js", "options.html"];
async function codeFingerprint() {
  let h = 0;
  for (const f of CODE_FILES) {
    const t = await fetch(chrome.runtime.getURL(f), { cache: "no-store" }).then((r) => r.text()).catch(() => "");
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  }
  return h;
}
// fingerprint of the code Chrome actually loaded — saved at install/reload
// (the service worker itself restarts constantly, so it can't live in memory)
async function rememberLoadedCode() {
  await chrome.storage.local.set({ loadedCodeFingerprint: await codeFingerprint() });
}
async function reloadIfCodeChanged() {
  if (chrome.runtime.getManifest().update_url) return; // store install: never
  const { loadedCodeFingerprint } = await chrome.storage.local.get("loadedCodeFingerprint");
  const now = await codeFingerprint();
  if (loadedCodeFingerprint == null) { await chrome.storage.local.set({ loadedCodeFingerprint: now }); return; }
  if (now !== loadedCodeFingerprint) chrome.runtime.reload(); // onInstalled re-saves it
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "selfreload") { await reloadIfCodeChanged(); return; }
  if (alarm.name === "feedrefresh") { await refreshFeedInBackground(); return; }
  if (alarm.name === "autobackup") {
    try {
      const all = await chrome.storage.local.get(null);
      delete all.feedCache;
      if (!all.tracker || !Object.keys(all.tracker).length) return; // nothing worth saving yet
      const url = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(all));
      await chrome.downloads.download({
        url,
        filename: `job-applier-backups/auto-backup-${new Date().toISOString().slice(0, 10)}.json`,
        conflictAction: "overwrite",
      });
      await chrome.storage.local.set({ lastBackupAt: Date.now() });
    } catch (e) { /* try again next week */ }
    return;
  }
  if (alarm.name === "inboxsync") {
    try { await gmailSync(false); } catch (e) { /* not connected / token expired — silent */ }
    return;
  }
  if (alarm.name !== "morning") return;
  try {
    // GitHub sources only here — service workers have no DOMParser for LinkedIn;
    // the dashboard refresh (which the notification opens) fetches everything.
    const lists = await Promise.all(
      GH_SOURCES.map(async (s) => {
        const res = await fetch(s.url);
        return res.ok ? parseReadme(await res.text(), s.id) : [];
      })
    );
    const jobs = dedupeJobs(lists);
    const fresh = jobs.filter((j) => !j.closed && j.daysOld != null && j.daysOld <= 1).length;
    const { profile } = await chrome.storage.local.get("profile");
    const name = profile?.personal?.firstName || "there";
    // badge on the toolbar icon — visible even if the notification is missed
    chrome.action.setBadgeBackgroundColor({ color: "#d03325" });
    chrome.action.setBadgeText({ text: fresh ? String(fresh) : "" });
    chrome.notifications.create("morning-brief", {
      type: "basic",
      iconUrl: "icon128.png",
      title: `Good morning, ${name} ☀️`,
      message: fresh
        ? `${fresh} new posting${fresh === 1 ? "" : "s"} in the last 24h — apply early, the first 24-48h matter most.`
        : "No brand-new postings today — good day to clear some backlog.",
      priority: 1,
    });
  } catch (e) {
    // network down at 8am — skip silently, tomorrow's alarm still fires
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === "morning-brief") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#tab-today") });
    chrome.notifications.clear(id);
  }
  if (id === "inbox-import") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#tab-tracker") });
    chrome.notifications.clear(id);
  }
});

// ---------- Gemini ----------

// Free-tier daily quotas are PER MODEL (and per key) — so when one model's
// quota runs dry we fall through the chain, and when a key is exhausted we
// rotate to the next one. Field autofill never touches the API at all.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.0-flash"];
const geminiUrl = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

// Personal-use default. If this folder is ever shared/published, remove this.
const DEFAULT_API_KEY = "";

const BG_VERSION = 12; // v12 = hourly background feed + big-tech/quant boards — dashboard checks this

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "REFRESH_FEED") {
    refreshFeedInBackground().then((feedCache) =>
      sendResponse(feedCache ? { ok: true, feedCache } : { ok: false, error: "refresh failed" }));
    return true;
  }
  if (msg.type === "PING") {
    sendResponse({ ok: true, v: BG_VERSION });
    return; // synchronous response
  }
  if (msg.type === "LLM_DRAFT") {
    draftAnswer(msg.question, msg.jobText, msg.pastAnswers)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "LLM_ANALYZE") {
    analyzePosting(msg.jobText)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === "LLM_TASK") {
    llmTask(msg.task, msg.ctx || {})
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === "GMAIL_SYNC") {
    gmailSync(msg.interactive !== false)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
});

// ---------- autonomous inbox monitor (Gmail API) ----------

// OAuth via launchWebAuthFlow so the client id/secret can live in Options (no
// manifest edit). Uses the authorization-code + PKCE flow — Google disabled the
// old implicit (response_type=token) grant for Web-application clients, which
// left the sign-in window hanging with nothing to show. The refresh token lets
// the every-30-min background sync renew access silently, no popup.
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomVerifier() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function s256(v) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return b64url(new Uint8Array(d));
}
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}
async function tokenPost(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(data.error_description || data.error || `token endpoint ${res.status}`);
  return data;
}
async function storeTokens(t, fallbackRefresh) {
  const patch = { gmailAccess: t.access_token, gmailAccessExp: Date.now() + (t.expires_in || 3600) * 1000 };
  if (t.refresh_token) patch.gmailRefresh = t.refresh_token;
  else if (fallbackRefresh) patch.gmailRefresh = fallbackRefresh;
  await chrome.storage.local.set(patch);
  return t.access_token;
}

async function gmailToken(interactive) {
  const { gmailAccess, gmailAccessExp, gmailRefresh, gmailClientId, gmailClientSecret } =
    await chrome.storage.local.get([
      "gmailAccess", "gmailAccessExp", "gmailRefresh", "gmailClientId", "gmailClientSecret",
    ]);
  // 1. cached access token still good? use it (60s safety margin)
  if (gmailAccess && gmailAccessExp && Date.now() < gmailAccessExp - 60000) return gmailAccess;
  if (!gmailClientId) throw new Error("Gmail not connected — add your Google client ID in the dashboard.");

  const redirect = chrome.identity.getRedirectURL();

  // 2. silent refresh (this is how the background sync stays connected)
  if (gmailRefresh) {
    try {
      const t = await tokenPost({
        client_id: gmailClientId,
        ...(gmailClientSecret ? { client_secret: gmailClientSecret } : {}),
        refresh_token: gmailRefresh,
        grant_type: "refresh_token",
      });
      return storeTokens(t, gmailRefresh);
    } catch (e) {
      if (!interactive) throw e; // background run: give up quietly
      // interactive: refresh died (revoked/expired) → fall through to re-consent
    }
  }
  if (!interactive) throw new Error("Gmail not connected yet — open the dashboard and click Connect.");

  // 3. interactive: authorization code + PKCE
  const verifier = randomVerifier();
  const challenge = await s256(verifier);
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code" +
    `&client_id=${encodeURIComponent(gmailClientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent(GMAIL_SCOPE)}` +
    "&access_type=offline&prompt=consent" +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  const out = await withTimeout(
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }),
    120000,
    "Sign-in timed out — no Google window completed. Reload the extension at chrome://extensions (↻) and try again."
  );
  const m = (out || "").match(/[?#&]code=([^&]+)/);
  if (!m) throw new Error("Sign-in was cancelled or returned no authorization code.");
  const t = await tokenPost({
    client_id: gmailClientId,
    ...(gmailClientSecret ? { client_secret: gmailClientSecret } : {}),
    code: decodeURIComponent(m[1]),
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirect,
  });
  return storeTokens(t);
}

function b64urlDecode(s) {
  s = (s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  try {
    // decode base64 → UTF-8 (emails are utf-8; atob gives latin1)
    return decodeURIComponent(escape(atob(s)));
  } catch { try { return atob(s); } catch { return ""; } }
}

// flatten a Gmail message payload to text, converting <a href> to "text url"
function gmailMessageText(payload) {
  const parts = [];
  (function walk(p) { if (!p) return; if (p.body && p.body.data) parts.push({ mime: p.mimeType || "", data: p.body.data }); (p.parts || []).forEach(walk); })(payload);
  let html = "", plain = "";
  for (const p of parts) {
    const d = b64urlDecode(p.data);
    if (/html/.test(p.mime)) html += d; else if (/plain/.test(p.mime)) plain += d;
  }
  return html ? htmlToImportText(html) : plain;
}

async function gmailSync(interactive) {
  const token = await gmailToken(interactive);
  const auth = { headers: { Authorization: "Bearer " + token } };
  // parser catch-up: after a parser upgrade, re-scan emails that were already
  // marked synced — their jobs were parsed with the old (buggy) code
  const PARSER_V = 11;
  const { gmailParserV } = await chrome.storage.local.get("gmailParserV");
  if (gmailParserV !== PARSER_V)
    await chrome.storage.local.set({ syncedEmailIds: [], gmailParserV: PARSER_V });
  // Jobright + common job-alert senders, last 21 days
  const q = encodeURIComponent(
    'newer_than:21d (from:jobright.ai OR from:jobrightai OR subject:("job matches" OR "new jobs" OR "job alert" OR "matches for you"))'
  );
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100`, auth);
  if (listRes.status === 401) {
    await chrome.storage.local.remove(["gmailAccess", "gmailAccessExp"]); // force a refresh next run
    throw new Error("Gmail token expired — syncing again will refresh it automatically.");
  }
  if (!listRes.ok) throw new Error(`Gmail API ${listRes.status}`);
  const ids = ((await listRes.json()).messages || []).map((m) => m.id);

  const { syncedEmailIds = [], importedJobs = {} } =
    await chrome.storage.local.get(["syncedEmailIds", "importedJobs"]);
  const fresh = ids.filter((id) => !syncedEmailIds.includes(id));
  dedupeStore(importedJobs, "imported");
  const known = idIndex(importedJobs);

  let added = 0, scanned = 0;
  const debugTexts = []; // flattened bodies — dumped to Downloads for parser debugging
  for (const id of fresh) {
    const mRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, auth);
    if (!mRes.ok) continue;
    const msg = await mRes.json();
    const text = gmailMessageText(msg.payload);
    const emailedAt = +msg.internalDate || Date.now();
    debugTexts.push(`===== EMAIL ${id} =====\n` + text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n").slice(0, 9000));
    scanned++;
    for (const j of jobLinksOnly(parseImport(text))) {
      // email cards always carry a role — a bare "Imported job" here means we
      // grabbed one of Jobright's own navigation links, not a posting
      if (!j.role || j.role === "Imported job") continue;
      // known job (same id under any URL form): heal whatever the old parser
      // missed (name, location, salary, date) instead of duplicating it
      const id = jobUrlId(j.link);
      const url = known.get(id) || normalizeUrl(j.link);
      const prev = importedJobs[url];
      if (prev) {
        if (!prev.company && j.company) prev.company = j.company;
        if (!prev.location && j.location) prev.location = j.location;
        if (!prev.salary && j.salary) prev.salary = j.salary;
        if (!prev.postedAt) { prev.postedAt = emailedAt - (j.agoMin || 0) * 60000; prev.emailedAt = emailedAt; }
        continue;
      }
      // feed only — tracking is the user's call (＋ track / apply flow).
      // postedAt = when the email arrived minus the card's "N minutes ago".
      importedJobs[url] = {
        url, link: j.link, company: j.company, role: j.role,
        location: j.location || "", salary: j.salary || "",
        source: "imported", addedAt: Date.now(),
        postedAt: emailedAt - (j.agoMin || 0) * 60000, emailedAt,
      };
      known.set(id, url);
      added++;
    }
  }

  await chrome.storage.local.set({
    syncedEmailIds: [...syncedEmailIds, ...fresh].slice(-1500), // 3 weeks of alerts is ~400 emails
    importedJobs, lastGmailSync: Date.now(),
  });
  if (debugTexts.length) {
    try {
      await chrome.downloads.download({
        url: "data:text/plain;charset=utf-8," + encodeURIComponent(debugTexts.join("\n\n")),
        filename: "job-applier-backups/jobright-debug-latest.txt",
        conflictAction: "overwrite",
      });
    } catch {}
  }
  if (added) {
    try {
      chrome.notifications.create("inbox-import", {
        type: "basic", iconUrl: "icon128.png",
        title: `📥 ${added} new job${added === 1 ? "" : "s"} from your inbox`,
        message: "Added to your feed from job-alert emails.", priority: 1,
      });
    } catch {}
  }
  return { emails: fresh.length, scanned, jobs: added };
}

// ---------- AI writer suite (follow-ups, referral outreach, tailoring, prep) ----------

async function llmTask(task, ctx) {
  const { profile = {} } = await chrome.storage.local.get("profile");
  const me = JSON.stringify({ ...profile, masterResume: undefined }, null, 1);
  const jobBlock = [
    ctx.company ? `Company: ${ctx.company}` : "",
    ctx.role ? `Role: ${ctx.role}` : "",
    ctx.jobText ? `Job posting (may be noisy):\n${ctx.jobText.slice(0, 7000)}` : "",
  ].filter(Boolean).join("\n");

  const COMMON = "Be direct and specific. Never invent experience, numbers, or names — only use what's in my profile/resume. No corporate fluff.";

  const prompts = {
    followup: [
      `Write a follow-up email for a job application. It has been ${ctx.daysSince ?? "several"} days since I applied with no response.`,
      (ctx.daysSince ?? 0) >= 14
        ? "This is a SECOND follow-up — even shorter, gracious, with a soft close."
        : "First follow-up: brief, warm, restate fit in one line, easy to reply to.",
      "Output exactly: 'Subject: …' on line 1, blank line, then a 3-5 sentence body. Sign off with my first name.",
      COMMON, "", "=== MY PROFILE ===", me, "", jobBlock,
    ],
    referral_msgs: [
      `I want a referral at ${ctx.company || "this company"} for the role below. Write 3 messages:`,
      "1) LinkedIn connection note (MUST be under 280 characters) to an employee I don't know — mention the shared school if my profile has one.",
      "2) The referral ask to send AFTER they accept: 2-4 sentences, makes it easy to say yes, offers my resume + posting link.",
      "3) A thank-you to send after they refer me: 2 sentences.",
      "Label each message clearly. " + COMMON, "", "=== MY PROFILE ===", me, "", jobBlock,
    ],
    tailor: [
      "Tailor my resume to this job posting. From my master resume below, produce:",
      "1) A 1-2 line professional summary targeted at this exact role.",
      "2) My most relevant bullets, rewritten to naturally include these exact keywords where TRUTHFUL: " + ((ctx.buzzwords || []).join(", ") || "(none extracted — use the posting)") + ". Keep each bullet ≤2 lines, start with strong verbs, keep every real number.",
      "3) 'Could NOT include truthfully:' — list keywords my experience genuinely doesn't support. Do not fake them.",
      COMMON, "", "=== MASTER RESUME ===", profile.masterResume || "(no master resume saved — tell me to paste one in Options and stop)", "", jobBlock,
    ],
    prep: [
      "Build me a focused interview-prep sheet for this role. Sections:",
      "• Technical topics they'll probably test (from the requirements), each with 2-3 example questions",
      "• 5 behavioral questions tied to this specific job description, each with a one-line hint of which of MY experiences to use",
      `• 3 things to know about ${ctx.company || "the company"} before the call`,
      "• 3 sharp questions for me to ask them",
      "Keep it tight — one screen of prep, not an essay. " + COMMON, "", "=== MY PROFILE ===", me, "", jobBlock,
    ],
    cover: [
      "Write a complete cover letter for this application, ready to paste or attach.",
      "Rules: under 300 words, 3 paragraphs (hook + why I fit with 1-2 concrete proofs from my resume + close with availability), no clichés ('I am writing to express…'), sounds like a sharp student not a press release.",
      "Output plain text only, starting with 'Dear Hiring Team,' and ending with my first name.",
      COMMON, "", "=== MY PROFILE ===", me, "", "=== MASTER RESUME ===",
      profile.masterResume || "(no master resume — use profile highlights only)", "", jobBlock,
    ],
    review: [
      "You are a brutally honest ATS + top-tech recruiter resume reviewer. Review my master resume:",
      "• Score it /10 for a US SWE/quant internship hunt, one-line reason",
      "• Top 5 highest-impact fixes, most important first",
      "• Every bullet that lacks a number — quote it and suggest the metric to add",
      "• ATS parsing risks (formatting, headers, columns)",
      COMMON, "", "=== MASTER RESUME ===", profile.masterResume || "(no master resume saved — tell me to paste one in Options and stop)",
    ],
  };
  if (!prompts[task]) throw new Error("Unknown task: " + task);
  return callGemini(prompts[task].join("\n"), { long: true });
}

// ---------- Claude bridge (his Max plan via local `claude` CLI — free) ----------

const BRIDGE = "http://127.0.0.1:8976";
let bridgeAliveUntil = 0; // ping cache so we don't probe on every call

async function callClaudeBridge(prompt) {
  if (Date.now() > bridgeAliveUntil) {
    const ping = await fetch(BRIDGE + "/ping", { signal: AbortSignal.timeout(900) });
    if (!ping.ok) throw new Error("bridge down");
    bridgeAliveUntil = Date.now() + 60000;
  }
  const res = await fetch(BRIDGE + "/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(160000),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    if (res.status === 503) bridgeAliveUntil = 0; // not logged in / CLI missing — recheck later
    throw new Error(data.error || `bridge ${res.status}`);
  }
  return data.text;
}

async function callGemini(prompt, { json = false, long = false } = {}) {
  // Claude (Max plan, free) first; Gemini free tier as the fallback
  try {
    const text = await callClaudeBridge(prompt);
    if (text?.trim()) return text.trim();
  } catch (e) { /* bridge offline or not logged in — Gemini path below */ }

  const { apiKey } = await chrome.storage.local.get("apiKey");
  // comma/space-separated key pool — rotate when one runs out of free quota
  const keys = (apiKey || DEFAULT_API_KEY).split(/[,\s]+/).filter(Boolean);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: json ? 0.2 : 0.6,
      maxOutputTokens: long ? 3000 : 1500,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  });

  let lastDetail = "";
  for (const model of GEMINI_MODELS) {
    for (const key of keys) {
      let res;
      try {
        res = await fetch(geminiUrl(model, key), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch (e) {
        throw new Error("Network error reaching Gemini — check your connection.");
      }
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (text.trim()) return text.trim();
        lastDetail = `${model}: empty response`;
        continue;
      }
      const errBody = await res.text();
      lastDetail = `${model}: ${res.status}`;
      // quota/rate/retired-model → try the next model or key; anything else is a real error
      if (res.status === 429 || res.status === 404 || res.status === 503 ||
          errBody.includes("RESOURCE_EXHAUSTED") || errBody.includes("overloaded")) continue;
      throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 250)}`);
    }
  }
  throw new Error(
    "Daily free Gemini quota is used up across all models/keys (" + lastDetail + "). " +
    "It resets at midnight PT. Field autofill is unaffected — only AI drafting pauses. " +
    "Tip: add extra free keys in Options, comma-separated, for ~3× more headroom each."
  );
}

async function draftAnswer(question, jobText, pastAnswers = []) {
  const { profile, templates = [], resumes = [], activeResumeId } =
    await chrome.storage.local.get(["profile", "templates", "resumes", "activeResumeId"]);
  if (!profile) throw new Error("No profile set. Add one in the extension options.");

  const activeResume =
    resumes.find((r) => r.id === activeResumeId) || resumes[0] || null;

  const prompt = [
    "You are helping me fill out a job application. Write an answer to the application question below, in first person, as if I wrote it myself.",
    "",
    "Rules:",
    "- 2-5 sentences unless the question clearly needs more (e.g. a cover letter: 3 short paragraphs max).",
    "- Plain, direct, specific. No buzzwords, no 'I am excited to leverage synergies' fluff.",
    "- Only claim things supported by my profile below. Never invent experience, numbers, or names.",
    "- Ground the answer in the job posting where relevant.",
    "- If one of my templates fits this question, use it as the base and tailor it to this job.",
    "- Output ONLY the answer text, no preamble, no quotes, no markdown.",
    "",
    "=== MY PROFILE ===",
    JSON.stringify(profile, null, 2),
    activeResume
      ? `\n=== RESUME I'M SUBMITTING ===\n"${activeResume.name}" — intended for: ${activeResume.usedFor || "general"}`
      : "",
    templates.length
      ? "\n=== MY ANSWER TEMPLATES ===\n" +
        templates.map((t) => `--- ${t.name} ---\n${t.text}`).join("\n")
      : "",
    pastAnswers.length
      ? "\n=== HOW I ANSWERED SIMILAR QUESTIONS BEFORE (adapt to THIS job — never copy company-specific bits across companies) ===\n" +
        pastAnswers.map((p) => `Q: ${p.q}\nA: ${p.a}`).join("\n---\n")
      : "",
    "",
    "=== JOB POSTING (page text, may be noisy) ===",
    (jobText || "").slice(0, 9000),
    "",
    "=== APPLICATION QUESTION ===",
    question,
  ].join("\n");

  return callGemini(prompt);
}

async function analyzePosting(jobText) {
  const prompt = [
    "Analyze this job posting. Return STRICT JSON with exactly these keys:",
    '{"company": string, "role": string,',
    ' "requiredSkills": string[],   // hard requirements: languages, tools, frameworks, degrees',
    ' "niceToHave": string[],       // preferred/bonus qualifications',
    ' "buzzwords": string[],        // exact resume keywords an ATS or recruiter would scan for, taken verbatim from the posting',
    ' "salary": string,             // pay if stated, else ""',
    ' "summary": string}            // 2 sentences: what the job actually is',
    "Keep each list to the 10 most important items. Use the posting's own wording.",
    "",
    "=== JOB POSTING ===",
    (jobText || "").slice(0, 12000),
  ].join("\n");

  const raw = await callGemini(prompt, { json: true });
  try {
    return JSON.parse(raw);
  } catch {
    // model occasionally wraps JSON in fences despite the mime type
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Could not parse analysis JSON.");
  }
}

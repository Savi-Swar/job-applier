// Dashboard: Today briefing, postings feed, calendar, spreadsheet tracker, profile.
// Parsing/classification helpers come from parser.js (loaded first by dashboard.html).

const STATUSES = ["saved", "filled", "applied", "OA", "interview", "offer", "rejected", "ghosted"];
// CSS vars so every status color adapts to light/dark themes
const STATUS_COLORS = {
  saved: "var(--ink-3)", filled: "var(--orange)", applied: "var(--accent)", OA: "var(--violet)",
  interview: "var(--teal)", offer: "var(--green)", rejected: "var(--red)", ghosted: "var(--ink-3)",
};

// ---------- theme ----------

async function initTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  const dark = theme === "dark"; // light is the default — dark is opt-in
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.getElementById("themeToggle").textContent = dark ? "☀️" : "🌙";
}
document.getElementById("themeToggle").addEventListener("click", async () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.getElementById("themeToggle").textContent = dark ? "☀️" : "🌙";
  await chrome.storage.local.set({ theme: dark ? "dark" : "light" });
});

// ---------- toast ----------

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
const REFERRALS = ["none", "want one", "asked", "referred"];
const CATEGORIES = ["SWE", "Quant", "ML/AI", "Data", "Hardware", "Security", "PM", "Other"];
// quick location chips — OR logic, none selected = everywhere
const LOC_CHIPS = {
  "NYC": /new york|nyc|brooklyn|manhattan/i,
  "Bay Area": /san francisco|\bsf\b|bay area|palo alto|mountain view|menlo park|sunnyvale|santa clara|san jose|oakland|cupertino|redwood/i,
  "Seattle": /seattle|bellevue|redmond/i,
  "Chicago": /chicago/i,
  "Boston": /boston|cambridge, ?ma/i,
  "Philly": /philadelphia/i,
  "LA": /los angeles|santa monica|el segundo|pasadena|irvine/i,
  "Austin": /austin/i,
  "Remote": /remote/i,
};
const SRC_NAME = { ...Object.fromEntries(GH_SOURCES.map((s) => [s.id, s.name])), linkedin: "LinkedIn", watch: "Watchlist", imported: "Imported" };

// (titleCase / parseJobUrl / parseImport moved to parser.js — shared with the
// email scanner content script)

// all feed jobs = fetched sources + imported, deduped (imported kept fresh)
function withImported(fetched, importedJobs) {
  const imp = Object.values(importedJobs || {}).map((j) => ({
    ...j, source: "imported", category: j.category || categorize(j.role, ""),
    // postedAt (email arrival minus the card's "N minutes ago") → live age
    daysOld: j.postedAt ? Math.max(0, Math.floor((Date.now() - j.postedAt) / 864e5)) : (j.daysOld ?? 0),
    closed: false, noSponsorship: false, citizenOnly: false, salary: j.salary || "",
  }));
  return dedupeJobs([imp, fetched]); // imp first → imported entry wins on dupes
}
const SECTIONS = ["today", "feed", "calendar", "tracker", "profile"];

// ---------- LinkedIn guest listing (public, no login) ----------

async function fetchLinkedIn(q) {
  const params = new URLSearchParams({
    keywords: q.keywords,
    location: q.location || "United States",
    start: "0",
  });
  const res = await fetch(
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" + params
  );
  if (!res.ok) throw new Error(`LinkedIn "${q.keywords}": HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  return [...doc.querySelectorAll(".base-card")]
    .map((card) => {
      const link = card.querySelector("a.base-card__full-link")?.getAttribute("href") || "";
      const role = card.querySelector(".base-search-card__title")?.textContent.trim() || "";
      const company = card.querySelector(".base-search-card__subtitle")?.textContent.trim() || "";
      const location = card.querySelector(".job-search-card__location")?.textContent.trim() || "";
      const dt = card.querySelector("time[datetime]")?.getAttribute("datetime");
      let daysOld = null;
      const m = dt && dt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) daysOld = Math.max(0, Math.round((Date.now() - new Date(+m[1], +m[2] - 1, +m[3])) / 864e5));
      return {
        source: "linkedin", company, role, location,
        category: categorize(role, ""), salary: "",
        link: link ? normalizeUrl(link) : null, daysOld,
        closed: !link, noSponsorship: false, citizenOnly: false,
      };
    })
    .filter((j) => j.company && j.role);
}

// ---------- company watchlist (direct Greenhouse/Lever board APIs) ----------
// These are public JSON endpoints — postings show up here the moment a company
// posts them, often days before the aggregator lists catch up.

async function fetchWatch(w) {
  const slug = (w.slug || "").trim().toLowerCase();
  if (!slug) return [];
  let jobs = [];
  if (w.ats === "lever") {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!res.ok) throw new Error(`Watchlist ${slug} (Lever): HTTP ${res.status}`);
    jobs = (await res.json()).map((j) => ({
      source: "watch", company: w.name || slug, role: j.text,
      location: j.categories?.location || "", category: categorize(j.text, ""),
      salary: "", link: normalizeUrl(j.hostedUrl),
      daysOld: j.createdAt ? Math.max(0, Math.round((Date.now() - j.createdAt) / 864e5)) : null,
      closed: false, noSponsorship: false, citizenOnly: false,
    }));
  } else if (w.ats === "amazon") {
    // amazon.jobs public search — slug is the search query
    const q = w.slug || "software engineer intern";
    const res = await fetch(`https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q)}&result_limit=100`);
    if (!res.ok) throw new Error(`Watchlist Amazon: HTTP ${res.status}`);
    jobs = ((await res.json()).jobs || []).map((j) => ({
      source: "watch", company: w.name || "Amazon", role: j.title,
      location: j.normalized_location || j.location || "", category: categorize(j.title, ""),
      salary: "", link: normalizeUrl("https://www.amazon.jobs" + j.job_path),
      daysOld: parseDaysOld(j.posted_date || ""),
      closed: false, noSponsorship: false, citizenOnly: false,
    }));
  } else if (w.ats === "eightfold") {
    // Eightfold (Netflix & co) — slug is "host|domain", e.g. explore.jobs.netflix.net|netflix.com
    const [host, domain] = slug.split("|");
    const res = await fetch(`https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain || "")}&query=intern&num=100`);
    if (!res.ok) throw new Error(`Watchlist ${w.name || host} (Eightfold): HTTP ${res.status}`);
    jobs = ((await res.json()).positions || []).map((p) => ({
      source: "watch", company: w.name || host, role: p.name,
      location: (p.location || "").split(",").slice(0, 2).join(", "), category: categorize(p.name, ""),
      salary: "", link: normalizeUrl(p.canonicalPositionUrl || `https://${host}/careers/job/${p.id}`),
      daysOld: p.t_create ? Math.max(0, Math.round((Date.now() - p.t_create * 1000) / 864e5)) : null,
      closed: false, noSponsorship: false, citizenOnly: false,
    }));
  } else {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (!res.ok) throw new Error(`Watchlist ${slug} (Greenhouse): HTTP ${res.status}`);
    jobs = ((await res.json()).jobs || []).map((j) => ({
      source: "watch", company: w.name || slug, role: j.title,
      location: j.location?.name || "", category: categorize(j.title, ""),
      salary: "", link: normalizeUrl(j.absolute_url),
      daysOld: j.updated_at ? Math.max(0, Math.round((Date.now() - new Date(j.updated_at)) / 864e5)) : null,
      closed: false, noSponsorship: false, citizenOnly: false,
    }));
  }
  // full boards are huge (Stripe: 500+) — keep the early-career slice
  return jobs.filter((j) => /intern|co-?op|campus|university|new grad|graduate|early career/i.test(j.role));
}

// ---------- feed refresh ----------

async function refreshFeed() {
  const btn = document.getElementById("refresh");
  btn.disabled = true;
  btn.textContent = "Fetching…";
  for (const id of ["feedTable", "freshTable", "backlogTable", "cookedTable"])
    document.getElementById(id).classList.add("loading");
  const { linkedinQueries = [], watchlist = [] } =
    await chrome.storage.local.get(["linkedinQueries", "watchlist"]);
  const results = await Promise.allSettled([
    ...GH_SOURCES.map(async (s) => {
      const res = await fetch(s.url);
      if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status}`);
      return parseReadme(await res.text(), s.id);
    }),
    ...linkedinQueries.filter((q) => q.keywords).map(fetchLinkedIn),
    ...watchlist.map(fetchWatch),
  ]);
  const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason.message || r.reason));
  const jobs = dedupeJobs(results.filter((r) => r.status === "fulfilled").map((r) => r.value));
  await chrome.storage.local.set({ feedCache: { fetchedAt: Date.now(), jobs, errors } });
  btn.disabled = false;
  btn.textContent = "Refresh feed";
  for (const id of ["feedTable", "freshTable", "backlogTable", "cookedTable"])
    document.getElementById(id).classList.remove("loading");
  toast(`Feed refreshed — ${jobs.length} postings${errors.length ? ` (${errors.length} source${errors.length > 1 ? "s" : ""} failed)` : ""}`);
  render();
}

// ---------- filters (persisted) ----------

const FILTER_IDS = ["fSearch", "fLocation", "fDays", "fSort", "fHideClosed", "fHideTracked", "fEasyOnly"];

// the boards where autofill handles ~everything in one click
function isEasyApply(link) {
  return !!link && /greenhouse\.io|lever\.co|ashbyhq\.com/i.test(link);
}

// stable identity for a job across refreshes (same key the deduper uses)
// tracker entry for this posting under any URL form (same job id)
const _trackIdx = new WeakMap();
function trackedEntry(tracker, link) {
  if (!link || !tracker) return null;
  const k = normalizeUrl(link);
  if (tracker[k]) return tracker[k];
  let idx = _trackIdx.get(tracker);
  if (!idx) { idx = idIndex(tracker); _trackIdx.set(tracker, idx); }
  const hit = idx.get(jobUrlId(link));
  return hit ? tracker[hit] : null;
}

function jobKey(j) {
  return j.link ? normalizeUrl(j.link) : `${j.company}::${j.role}`.toLowerCase();
}

function readFilters() {
  return {
    search: document.getElementById("fSearch").value.trim().toLowerCase(),
    location: document.getElementById("fLocation").value.trim().toLowerCase(),
    days: parseInt(document.getElementById("fDays").value, 10) || null,
    sort: document.getElementById("fSort").value,
    hideClosed: document.getElementById("fHideClosed").checked,
    hideTracked: document.getElementById("fHideTracked").checked,
    easyOnly: document.getElementById("fEasyOnly").checked,
    cats: [...document.querySelectorAll("#fCats .chip.on")].map((c) => c.dataset.v),
    sources: [...document.querySelectorAll("#fSources .chip.on")].map((c) => c.dataset.v),
    locs: [...document.querySelectorAll("#fLocs .chip.on")].map((c) => c.dataset.v),
  };
}

async function saveFilters() {
  const f = readFilters();
  f.rawDays = document.getElementById("fDays").value;
  f.rawSearch = document.getElementById("fSearch").value;
  f.rawLocation = document.getElementById("fLocation").value;
  // remember which chips existed at save time, so new sources default ON later
  f.knownSources = [...document.querySelectorAll("#fSources .chip")].map((c) => c.dataset.v);
  await chrome.storage.local.set({ feedFilters: f });
}

async function restoreFilters() {
  const { feedFilters: f } = await chrome.storage.local.get("feedFilters");
  if (!f) return;
  document.getElementById("fSearch").value = f.rawSearch || "";
  document.getElementById("fLocation").value = f.rawLocation || "";
  document.getElementById("fDays").value = f.rawDays || "";
  document.getElementById("fSort").value = f.sort || "age";
  document.getElementById("fHideClosed").checked = f.hideClosed !== false;
  document.getElementById("fHideTracked").checked = !!f.hideTracked;
  document.getElementById("fEasyOnly").checked = !!f.easyOnly;
  document.querySelectorAll("#fCats .chip").forEach((c) =>
    c.classList.toggle("on", f.cats.includes(c.dataset.v)));
  document.querySelectorAll("#fLocs .chip").forEach((c) =>
    c.classList.toggle("on", (f.locs || []).includes(c.dataset.v)));
  document.querySelectorAll("#fSources .chip").forEach((c) =>
    c.classList.toggle("on",
      f.sources.includes(c.dataset.v) || !(f.knownSources || []).includes(c.dataset.v)));
}

function applyFilters(jobs, f, tracker) {
  return jobs.filter((j) => {
    const hid = !!(f.hidden && f.hidden[jobKey(j)]);
    if (f.showHidden ? !hid : hid) return false; // hidden jobs live in their own view
    if (f.hideClosed && j.closed) return false;
    if (f.easyOnly && !isEasyApply(j.link)) return false;
    if (!f.sources.includes(j.source)) return false;
    if (!f.cats.includes(j.category)) return false;
    if (f.days != null && (j.daysOld == null || j.daysOld > f.days)) return false;
    if (f.location && !j.location.toLowerCase().includes(f.location)) return false;
    if (f.locs?.length && !f.locs.some((l) => LOC_CHIPS[l]?.test(j.location))) return false;
    if (f.search && !(j.company + " " + j.role).toLowerCase().includes(f.search)) return false;
    if (f.hideTracked && trackedEntry(tracker, j.link)) return false;
    return true;
  });
}

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function ageLabel(d) {
  if (d == null) return "";
  if (d === 0) return "today";
  if (d < 30) return d + "d";
  return Math.round(d / 30) + "mo";
}

function catClass(c) { return "cat " + (c || "").replace("/", ""); }

// Fill defaults so entries created by older versions / content script render fine.
function normEntry(e) {
  return {
    location: "", salary: "", category: "", appliedAt: null,
    referral: "none", referrer: "", nextStep: "", notes: "",
    skills: [], buzzwords: [],
    ...e,
  };
}

async function upsertTracker(url, patch) {
  const { tracker = {} } = await chrome.storage.local.get("tracker");
  url = storeKey(tracker, url); // same posting already tracked under another URL form
  const prev = tracker[url] ? normEntry(tracker[url]) : null;
  tracker[url] = {
    ...(prev || normEntry({ url, addedAt: Date.now(), status: "saved", title: "", company: "" })),
    ...patch,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ tracker });
  return tracker[url];
}

// ---------- pending apply confirmations ----------

async function addPending(job) {
  const { pendingApply = {} } = await chrome.storage.local.get("pendingApply");
  pendingApply[normalizeUrl(job.link)] = { ...job, clickedAt: Date.now() };
  await chrome.storage.local.set({ pendingApply });
}

async function resolvePending(url, applied) {
  const { pendingApply = {} } = await chrome.storage.local.get("pendingApply");
  const job = pendingApply[url];
  delete pendingApply[url];
  await chrome.storage.local.set({ pendingApply });
  if (job && applied !== null) {
    await upsertTracker(url, {
      title: job.role, company: job.company, location: job.location,
      category: job.category, salary: job.salary, source: job.source || "",
      status: applied ? "applied" : "saved",
      appliedAt: applied ? Date.now() : null,
    });
    if (applied) toast(`🎉 Applied to ${job.company} — tracked`);
  }
  render();
}

async function renderPending() {
  const { pendingApply = {} } = await chrome.storage.local.get("pendingApply");
  const items = Object.entries(pendingApply).sort((a, b) => b[1].clickedAt - a[1].clickedAt);
  const html = items.map(([url, j]) => `
    <div class="pendingCard" data-url="${esc(url)}">
      <div class="q">Did you apply to <b>${esc(j.company)}</b> — ${esc(j.role)}?</div>
      <button class="yes">✓ Yes, applied</button>
      <button class="no">Not yet, keep saved</button>
      <button class="no dismiss" title="Forget it" aria-label="Dismiss">✕</button>
    </div>`).join("");
  for (const boxId of ["pending", "todayPending"]) {
    const box = document.getElementById(boxId);
    box.innerHTML = html;
    box.querySelectorAll(".pendingCard").forEach((card) => {
      const url = card.dataset.url;
      card.querySelector(".yes").addEventListener("click", () => resolvePending(url, true));
      card.querySelector(".no:not(.dismiss)").addEventListener("click", () => resolvePending(url, false));
      card.querySelector(".dismiss").addEventListener("click", () => resolvePending(url, null));
    });
  }
}

// ---------- match scoring ----------

function attachScores(jobs, profile, tracker) {
  // your history with each company feeds back into the score
  const history = { responded: new Set(), rejected: new Set() };
  for (const e of Object.values(tracker || {})) {
    const co = (e.company || "").toLowerCase();
    if (!co) continue;
    if (["OA", "interview", "offer"].includes(e.status)) history.responded.add(co);
    else if (["rejected", "ghosted"].includes(e.status)) history.rejected.add(co);
  }
  for (const j of jobs) if (!j._fit) j._fit = scoreJob(j, profile, history);
  return jobs;
}

function sortJobs(jobs, mode) {
  // stable tiebreakers so same-age (or same-score) jobs never look random:
  // date → newest, then best-fit, then company A-Z.
  const byCompany = (a, b) => (a.company || "").localeCompare(b.company || "");
  const byAge = (a, b) => (a.daysOld ?? 9999) - (b.daysOld ?? 9999);
  const byFit = (a, b) => (b._fit?.score ?? 0) - (a._fit?.score ?? 0);
  return jobs.sort(
    mode === "match"
      ? (a, b) => byFit(a, b) || byAge(a, b) || byCompany(a, b)
      : (a, b) => byAge(a, b) || byFit(a, b) || byCompany(a, b)
  );
}

function fitBadge(f) {
  if (!f) return "";
  const cls = f.score >= 75 ? "hi" : f.score >= 55 ? "mid" : f.score >= 35 ? "low" : "bad";
  const tip = `${f.score}/100 · ${f.reasons.join(" · ") || "baseline"}`;
  return `<span class="fit ${cls}" title="${esc(tip)}">${fitGrade(f.score)}</span>`;
}

// 0–100 match score → letter grade (raw number stays in the hover tooltip)
function fitGrade(score) {
  const cuts = [[93, "A+"], [85, "A"], [80, "A-"], [75, "B+"], [70, "B"], [65, "B-"], [60, "C+"], [55, "C"], [50, "C-"], [35, "D"]];
  for (const [min, g] of cuts) if (score >= min) return g;
  return "F";
}

// ---------- shared jobs table ----------

function jobsTableHtml(jobs, tracker, hidden = {}) {
  const rows = jobs.map((j, i) => {
    const tracked = trackedEntry(tracker, j.link);
    const hid = !!hidden[jobKey(j)];
    return `<tr data-i="${i}">
      <td>${fitBadge(j._fit)}</td>
      <td><b>${esc(j.company)}</b>${j.closed ? '<span class="badge closed">closed</span>' : ""}${tracked ? `<span class="badge applied">${esc(tracked.status)}</span>` : ""}</td>
      <td>${esc(j.role)}${j.salary ? `<div class="muted">${esc(j.salary)}</div>` : ""}${j.noSponsorship ? '<span class="badge" title="No visa sponsorship">🛂</span>' : ""}${j.citizenOnly ? '<span class="badge" title="US citizenship required">🇺🇸</span>' : ""}</td>
      <td><span class="${catClass(j.category)}">${esc(j.category)}</span></td>
      <td>${esc(j.location)}</td>
      <td class="muted mono" style="white-space:nowrap">${ageLabel(j.daysOld)}${j.daysOld > 21 ? ' <span class="badge cooked" title="21+ days old — highkey cooked">💀</span>' : ""}</td>
      <td class="muted">${esc(SRC_NAME[j.source] || j.source || "")}</td>
      <td style="white-space:nowrap">
        <button class="ghost details" title="Details" aria-label="Job details">ⓘ</button>
        ${j.link ? `<a class="applyLink" href="${esc(j.link)}" target="_blank" rel="noreferrer">${isEasyApply(j.link) ? "⚡ " : ""}apply ↗</a>` : ""}
        ${j.link && !tracked ? ` <button class="ghost save">＋</button>` : ""}
        ${hid
          ? ` <button class="ghost unhide" title="Bring it back" aria-label="Unhide job">↩ unhide</button>`
          : ` <button class="ghost hideJob" title="Hide — not interested" aria-label="Hide job">🙈</button>`}
      </td>
    </tr>`;
  });
  return `<div class="scroll"><table><thead><tr><th title="Match grade — hover a grade for the score and why">Fit</th><th>Company</th><th>Role</th><th>Cat</th><th>Location</th><th>Age</th><th>Source</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function wireJobRows(box, jobs) {
  box.querySelectorAll("tr[data-i]").forEach((tr) => {
    const j = jobs[+tr.dataset.i];
    tr.querySelector("a.applyLink")?.addEventListener("click", () => {
      addPending(j).then(renderPending); // tab opens; queue "did you apply?"
    });
    tr.querySelector("button.save")?.addEventListener("click", async () => {
      await upsertTracker(normalizeUrl(j.link), {
        title: j.role, company: j.company, location: j.location,
        category: j.category, salary: j.salary, source: j.source || "", status: "saved",
      });
      toast(`Saved ${j.company} to your tracker`);
      render();
    });
    tr.querySelector("button.details")?.addEventListener("click", () => openDetail(j));
    tr.querySelector("button.hideJob")?.addEventListener("click", async () => {
      const { hiddenJobs = {} } = await chrome.storage.local.get("hiddenJobs");
      hiddenJobs[jobKey(j)] = { ts: Date.now(), company: j.company, role: j.role };
      await chrome.storage.local.set({ hiddenJobs });
      toast(`Hidden: ${j.company} — check 🙈 hidden to undo`);
      render();
    });
    tr.querySelector("button.unhide")?.addEventListener("click", async () => {
      const { hiddenJobs = {} } = await chrome.storage.local.get("hiddenJobs");
      delete hiddenJobs[jobKey(j)];
      await chrome.storage.local.set({ hiddenJobs });
      toast(`${j.company} is back in the feed`);
      render();
    });
  });
}

// ---------- Today ----------

async function renderToday() {
  const { feedCache, tracker = {}, profile, importedJobs = {} } =
    await chrome.storage.local.get(["feedCache", "tracker", "profile", "importedJobs"]);

  const h = new Date().getHours();
  const name = profile?.personal?.firstName || "there";
  document.getElementById("greeting").innerHTML =
    `<span class="grad">${esc(`${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}, ${name}`)}</span> ${h < 12 ? "☀️" : h < 18 ? "👋" : "🌙"}`;
  document.getElementById("heroDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const { hiddenJobs = {} } = await chrome.storage.local.get("hiddenJobs");
  const freshBox = document.getElementById("freshTable");
  const backBox = document.getElementById("backlogTable");
  const cookedBox = document.getElementById("cookedTable");
  if (!feedCache) {
    freshBox.innerHTML = `<div class="empty">Feed hasn't loaded yet…</div>`;
    backBox.innerHTML = "";
    cookedBox.innerHTML = "";
    return;
  }

  // honor saved feed filters (categories, sources, search…) but override the age window;
  // Today is always sorted by match score — that's the point of the briefing
  const f = { ...readFilters(), days: null, hidden: hiddenJobs, showHidden: false };
  const pool = sortJobs(attachScores(applyFilters(withImported(feedCache.jobs, importedJobs), f, tracker), profile, tracker), "match");
  const fresh = pool.filter((j) => j.daysOld != null && j.daysOld <= 2);
  const backlog = pool.filter((j) => j.daysOld == null || (j.daysOld >= 3 && j.daysOld <= 21));
  const cooked = pool.filter((j) => j.daysOld != null && j.daysOld > 21);

  const all = Object.values(tracker).map(normEntry);
  const appliedPlus = all.filter((e) => !["saved", "filled"].includes(e.status));
  const week = all.filter((e) => e.appliedAt && Date.now() - e.appliedAt < 7 * 864e5).length;
  const streak = streakDays(all);
  document.getElementById("todayStats").innerHTML =
    `<div class="stat"><b style="color:var(--red)">${fresh.length}</b><span>fresh (48h)</span></div>` +
    `<div class="stat"><b>${backlog.length}</b><span>backlog</span></div>` +
    `<div class="stat"><b style="color:var(--ink-3)">${cooked.length}</b><span>💀 cooked</span></div>` +
    `<div class="stat"><b style="color:var(--accent)">${appliedPlus.length}</b><span>applied total</span></div>` +
    `<div class="stat"><b style="color:${week ? "var(--green)" : "var(--red)"}">${week}</b><span>this week</span></div>` +
    `<div class="stat"><b style="color:${streak ? "var(--orange)" : "var(--ink-3)"}">${streak ? "🔥" + streak : "0"}</b><span>day streak</span></div>`;

  await renderActions(all);
  await renderChecklist();

  document.getElementById("freshHead").textContent = `🔥 Fresh · ${fresh.length}`;
  document.getElementById("backlogHead").textContent = `📦 Backlog · ${backlog.length}`;
  document.getElementById("cookedHead").textContent = `💀 Cooked · ${cooked.length}`;

  // headline the single best fresh match — one obvious first move each morning
  const pick = fresh.find((j) => !trackedEntry(tracker, j.link));
  document.getElementById("heroPick").innerHTML = pick
    ? `🎯 Top pick today: <a href="${esc(pick.link)}" target="_blank" rel="noreferrer" id="heroPickLink"><b>${esc(pick.role)}</b> at <b>${esc(pick.company)}</b></a> ${fitBadge(pick._fit)}`
    : "";
  document.getElementById("heroPickLink")?.addEventListener("click", () => addPending(pick).then(renderPending));

  freshBox.innerHTML = fresh.length
    ? jobsTableHtml(fresh, tracker)
    : `<div class="empty">Nothing new in the last 48h for your filters.</div>`;
  if (fresh.length) wireJobRows(freshBox, fresh);

  const backShown = backlog.slice(0, 150);
  backBox.innerHTML = backShown.length
    ? jobsTableHtml(backShown, tracker) +
      (backlog.length > 150 ? `<div class="empty">…and ${backlog.length - 150} more in the Feed tab.</div>` : "")
    : `<div class="empty">Backlog is clear 🎉</div>`;
  if (backShown.length) wireJobRows(backBox, backShown);

  const cookedShown = cooked.slice(0, 100);
  cookedBox.innerHTML = cookedShown.length
    ? jobsTableHtml(cookedShown, tracker) +
      (cooked.length > 100 ? `<div class="empty">…and ${cooked.length - 100} more, equally cooked, in the Feed tab.</div>` : "")
    : `<div class="empty">Nothing cooked. Yet.</div>`;
  if (cookedShown.length) wireJobRows(cookedBox, cookedShown);
}

// ---------- setup checklist (first-run guidance) ----------

async function renderChecklist() {
  const box = document.getElementById("checklist");
  const { profile, resumes = [], profileConfirmed, checklistDismissed, tracker = {} } =
    await chrome.storage.local.get(["profile", "resumes", "profileConfirmed", "checklistDismissed", "tracker"]);
  if (checklistDismissed) { box.innerHTML = ""; return; }

  const entries = Object.values(tracker);
  const steps = [
    { done: !!profileConfirmed, label: "Review your profile & save it", href: "options.html" },
    { done: !!(profile?.authorization?.authorizedUS && profile?.authorization?.needsSponsorship), label: "Answer the two work-authorization questions", href: "options.html" },
    { done: resumes.length > 0, label: "Upload your resume PDF", href: "#tab-profile" },
    { done: entries.length > 0, label: "Fill your first application (open any ⚡ job — it fills itself)", href: "#tab-feed" },
    { done: entries.some((e) => !["saved", "filled"].includes(e.status)), label: "Submit + confirm your first application", href: "#tab-feed" },
  ];
  const remaining = steps.filter((s) => !s.done).length;
  if (!remaining) { box.innerHTML = ""; return; }

  box.innerHTML = `<div class="checkCard">
    <h3>🚀 Setup — ${steps.length - remaining}/${steps.length} done
      <button class="ghost" id="dismissCheck" title="Hide forever">✕</button></h3>
    ${steps.map((s) => `
      <div class="checkItem ${s.done ? "done" : ""}">
        <span class="tick">${s.done ? "✓" : ""}</span>
        ${s.done ? esc(s.label) : `<a href="${esc(s.href)}">${esc(s.label)}</a>`}
      </div>`).join("")}
  </div>`;
  box.querySelector("#dismissCheck").addEventListener("click", async () => {
    await chrome.storage.local.set({ checklistDismissed: true });
    box.innerHTML = "";
  });
  box.querySelectorAll('a[href^="#tab-"]').forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); setTab(a.getAttribute("href").replace("#tab-", "")); render(); })
  );
}

// ---------- streak & follow-up actions ----------

// "OA due Friday" / "interview 7/22" / "due tomorrow" → a real Date, best-effort
function parseDeadline(text) {
  if (!text) return null;
  const now = new Date();
  const lower = text.toLowerCase();
  let m = lower.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) {
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2], 23, 59);
    if (d.getTime() < now.getTime() - 864e5) d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  if (lower.includes("today")) return now;
  if (lower.includes("tomorrow")) return new Date(now.getTime() + 864e5);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < 7; i++)
    if (lower.includes(days[i])) {
      const d = new Date(now);
      d.setDate(d.getDate() + (((i - now.getDay()) % 7 + 7) % 7 || 7));
      return d;
    }
  return null;
}

function streakDays(entries) {
  const days = new Set(entries.filter((e) => e.appliedAt).map((e) => new Date(e.appliedAt).toDateString()));
  let s = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1); // streak survives until today ends
  while (days.has(d.toDateString())) { s++; d.setDate(d.getDate() - 1); }
  return s;
}

// The follow-up engine: offers are won in the follow-up, so the tracker
// generates concrete next actions instead of waiting to be looked at.
function buildActions(entries) {
  const acts = [];
  const now = Date.now();
  const daysSince = (t) => Math.floor((now - t) / 864e5);
  for (const e of entries) {
    if (e.status === "applied" && e.appliedAt) {
      const d = daysSince(e.appliedAt);
      if (d >= 25)
        acts.push({ kind: "ghost", cls: "dead", e, msg: `No reply <b>${d} days</b> after applying — that's a ghost. Close it out and spend the energy elsewhere.`, quick: { label: "Mark ghosted", patch: { status: "ghosted" } } });
      else if (d >= 14)
        acts.push({ kind: "follow2", cls: "warn", e, msg: `<b>${d} days</b> since you applied. One more short nudge — then let it go.` });
      else if (d >= 7)
        acts.push({ kind: "follow1", cls: "", e, msg: `<b>${d} days</b> of silence. A 3-line follow-up to the recruiter measurably lifts response rates.` });
    }
    if (e.status === "filled" && daysSince(e.updatedAt) >= 1)
      acts.push({ kind: "unsubmitted", cls: "warn", e, msg: `You filled this form but never confirmed submitting — finish it or drop it.`, quick: { label: "I applied ✓", patch: { status: "applied", appliedAt: now } } });
    if (e.status === "saved" && daysSince(e.addedAt) >= 4)
      acts.push({ kind: "staleSave", cls: "", e, msg: `Saved <b>${daysSince(e.addedAt)} days</b> ago and untouched. It ages like milk — apply or cut it.` });
    if (e.referral === "want one" && daysSince(e.updatedAt) >= 3)
      acts.push({ kind: "refNudge", cls: "", e, msg: `You wanted a referral here. Time to actually message someone.` });
    if (e.nextStep && !["rejected", "ghosted", "offer"].includes(e.status)) {
      const dl = parseDeadline(e.nextStep);
      const soon = dl && dl.getTime() - now < 2.5 * 864e5;
      acts.push({ kind: "next", cls: soon ? "dead" : "warn", e,
        msg: `${soon ? "⏰ <b>Due soon</b> — " : ""}Next step: <b>${esc(e.nextStep)}</b>` });
    }
  }
  const order = { next: 0, unsubmitted: 1, follow1: 2, follow2: 3, refNudge: 4, ghost: 5, staleSave: 6 };
  return acts.sort((a, b) => order[a.kind] - order[b.kind]);
}

async function renderActions(entries) {
  const box = document.getElementById("actions");
  const { dismissedActions = {} } = await chrome.storage.local.get("dismissedActions");
  const acts = buildActions(entries).filter((a) => !dismissedActions[`${a.kind}|${a.e.url}`]).slice(0, 8);
  if (!acts.length) { box.innerHTML = ""; return; }

  box.innerHTML =
    `<h3 class="secHead">⚡ Needs attention</h3>
     <p class="secSub">Concrete next moves from your pipeline — offers are won in the follow-up.</p>` +
    acts.map((a, i) => `
      <div class="actionCard ${a.cls}" data-i="${i}">
        <div class="q"><b>${esc(a.e.company)}</b> — ${esc(a.e.title)}<br><span style="color:var(--ink-2)">${a.msg}</span></div>
        ${["follow1", "follow2", "refNudge"].includes(a.kind) ? `<button class="yes draft">✍️ Draft it</button>` : ""}
        ${a.quick ? `<button class="yes quick">${esc(a.quick.label)}</button>` : ""}
        <a href="${esc(a.e.url)}" target="_blank" rel="noreferrer"><button class="no">Open ↗</button></a>
        <button class="no dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
      </div>`).join("");

  box.querySelectorAll(".actionCard").forEach((card) => {
    const a = acts[+card.dataset.i];
    const key = `${a.kind}|${a.e.url}`;
    card.querySelector(".draft")?.addEventListener("click", () =>
      openDetail({ ...a.e, link: a.e.url }, a.kind === "refNudge" ? "referral" : "followup")
    );
    card.querySelector(".quick")?.addEventListener("click", async () => {
      await upsertTracker(a.e.url, a.quick.patch);
      render();
    });
    card.querySelector(".dismiss").addEventListener("click", async () => {
      const { dismissedActions = {} } = await chrome.storage.local.get("dismissedActions");
      dismissedActions[key] = Date.now();
      await chrome.storage.local.set({ dismissedActions });
      renderActions(entries);
    });
  });
}

// ---------- Calendar ----------

let calMonth = (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();
let calSelected = null; // "YYYY-MM-DD"

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function renderCalendar() {
  const { feedCache, tracker = {} } = await chrome.storage.local.get(["feedCache", "tracker"]);
  const grid = document.getElementById("calGrid");
  const title = document.getElementById("calTitle");

  const postedBy = {}; // dayKey -> jobs[]
  for (const j of feedCache?.jobs || []) {
    if (j.daysOld == null) continue;
    const d = new Date(Date.now() - j.daysOld * 864e5);
    (postedBy[dayKey(d)] ||= []).push(j);
  }
  const appliedBy = {}; // dayKey -> entries[]
  const dueBy = {}; // dayKey -> entries[] with a parsed nextStep deadline
  for (const e of Object.values(tracker).map(normEntry)) {
    if (e.appliedAt) (appliedBy[dayKey(new Date(e.appliedAt))] ||= []).push(e);
    if (e.nextStep && !["rejected", "ghosted", "offer"].includes(e.status)) {
      const dl = parseDeadline(e.nextStep);
      if (dl) (dueBy[dayKey(dl)] ||= []).push(e);
    }
  }

  const first = new Date(calMonth.y, calMonth.m, 1);
  title.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const startPad = first.getDay();
  const daysInMonth = new Date(calMonth.y, calMonth.m + 1, 0).getDate();
  const todayK = dayKey(new Date());

  let html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .map((d) => `<div class="calHead">${d}</div>`).join("");
  for (let i = 0; i < startPad; i++) html += `<div class="calCell off"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const k = dayKey(new Date(calMonth.y, calMonth.m, d));
    const nPosted = postedBy[k]?.length || 0;
    const nApplied = appliedBy[k]?.length || 0;
    const nDue = dueBy[k]?.length || 0;
    html += `<div class="calCell ${k === todayK ? "today" : ""} ${k === calSelected ? "sel" : ""}" data-k="${k}">
      <span class="d">${d}</span>
      ${nDue ? `<span class="n" style="color:var(--orange)">⏰ ${nDue} due</span>` : ""}
      ${nPosted ? `<span class="n" style="color:var(--accent)">${nPosted} posted</span>` : ""}
      ${nApplied ? `<span class="n" style="color:var(--green)">${nApplied} applied</span>` : ""}
    </div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".calCell[data-k]").forEach((cell) =>
    cell.addEventListener("click", () => {
      calSelected = cell.dataset.k;
      renderCalendar();
    })
  );

  const dayBox = document.getElementById("calDay");
  if (!calSelected) { dayBox.innerHTML = `<div class="empty">Click a day to see its postings and your applications.</div>`; return; }
  const posted = postedBy[calSelected] || [];
  const applied = appliedBy[calSelected] || [];
  const due = dueBy[calSelected] || [];
  let out = `<h3 class="secHead">${new Date(calSelected + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h3>`;
  if (due.length)
    out += `<p><b style="color:var(--orange)">⏰ Due (${due.length}):</b> ` +
      due.map((e) => `<a href="${esc(e.url)}" target="_blank">${esc(e.company)} — ${esc(e.nextStep)}</a>`).join(" · ") + `</p>`;
  if (applied.length)
    out += `<p><b style="color:var(--green)">You applied (${applied.length}):</b> ` +
      applied.map((e) => `<a href="${esc(e.url)}" target="_blank">${esc(e.company)} — ${esc(e.title)}</a>`).join(" · ") + `</p>`;
  out += posted.length
    ? jobsTableHtml(posted, (await chrome.storage.local.get("tracker")).tracker || {})
    : `<div class="empty">No postings dated this day.</div>`;
  dayBox.innerHTML = out;
  if (posted.length) wireJobRows(dayBox, posted);
}

document.getElementById("calPrev").addEventListener("click", () => {
  calMonth.m--; if (calMonth.m < 0) { calMonth.m = 11; calMonth.y--; }
  calSelected = null; renderCalendar();
});
document.getElementById("calNext").addEventListener("click", () => {
  calMonth.m++; if (calMonth.m > 11) { calMonth.m = 0; calMonth.y++; }
  calSelected = null; renderCalendar();
});

// ---------- job detail modal ----------

function closeModal() { document.getElementById("modalWrap").style.display = "none"; }
document.getElementById("modalBack").addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

async function fetchDescription(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the posting`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  doc.querySelectorAll("script, style, noscript, nav, footer, header").forEach((n) => n.remove());
  const el =
    doc.querySelector('[class*="description" i], #content, .job__description, main, article') ||
    doc.body;
  const text = (el?.textContent || "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  if (text.length < 300)
    throw new Error("This site renders with JavaScript — open the posting and use the popup's 🔍 Analyze instead.");
  return text.slice(0, 12000);
}

async function openDetail(jobLike, autoTool) {
  const { tracker = {}, feedCache, jobDetails = {}, profile } =
    await chrome.storage.local.get(["tracker", "feedCache", "jobDetails", "profile"]);
  const url = storeKey(tracker, jobLike.link || jobLike.url);
  const jid = jobUrlId(jobLike.link || jobLike.url);
  const feedJob = (feedCache?.jobs || []).find((x) => x.link && jobUrlId(x.link) === jid);
  const entry = tracker[url] ? normEntry(tracker[url]) : null;
  const j = {
    company: entry?.company || jobLike.company || feedJob?.company || "",
    role: entry?.title || jobLike.role || feedJob?.role || "",
    location: entry?.location || jobLike.location || feedJob?.location || "",
    salary: entry?.salary || jobLike.salary || feedJob?.salary || "",
    category: entry?.category || jobLike.category || feedJob?.category || "",
    source: jobLike.source || feedJob?.source || "",
    daysOld: jobLike.daysOld ?? feedJob?.daysOld ?? null,
  };
  const detail = jobDetails[url];
  const e = entry || normEntry({});

  const modal = document.getElementById("modal");
  const chips = (list, cls) =>
    (list || []).map((s) => `<span class="cat ${cls}">${esc(s)}</span>`).join(" ");

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start">
      <div>
        <h2>${esc(j.company)}</h2>
        <div>${esc(j.role)}</div>
        <div class="muted">${[j.location, j.salary, j.daysOld != null ? "posted " + ageLabel(j.daysOld) + (j.daysOld > 0 ? " ago" : "") : "", SRC_NAME[j.source] || ""].filter(Boolean).map(esc).join(" · ")}
          ${j.category ? `<span class="${catClass(j.category)}">${esc(j.category)}</span>` : ""}</div>
      </div>
      <button class="ghost" id="mClose" aria-label="Close">✕</button>
    </div>
    <p style="margin:12px 0">
      <a href="${esc(url)}" target="_blank" rel="noreferrer" id="mApply"><button class="primary">Open posting &amp; apply ↗</button></a>
    </p>
    <div class="grid2">
      <div><label>Status</label><select id="mStatus">${STATUSES.map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div><label>Applied on</label><input type="date" id="mApplied" value="${e.appliedAt ? new Date(e.appliedAt).toISOString().slice(0, 10) : ""}"></div>
      <div><label>Referral</label><select id="mReferral">${REFERRALS.map((r) => `<option ${r === e.referral ? "selected" : ""}>${r}</option>`).join("")}</select></div>
      <div><label>Referrer</label><input id="mReferrer" value="${esc(e.referrer)}" placeholder="who?"></div>
      <div><label>Next step</label><input id="mNext" value="${esc(e.nextStep)}" placeholder="e.g. OA due Friday"></div>
      <div><label>Notes</label><input id="mNotes" value="${esc(e.notes)}"></div>
    </div>
    ${entry ? "" : `<p class="muted" style="margin:0 0 10px">Not tracked yet — editing any field above adds it.</p>`}
    <div id="mAI">
      ${detail?.analysis ? aiHtml(detail) : `<button class="ghost" id="mAnalyze">🔍 Fetch description &amp; AI analysis</button><span class="muted" id="mAIStatus"></span>`}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <button class="ghost" data-tool="referral">🤝 Get a referral</button>
      <button class="ghost" data-tool="followup">✉️ Follow-up email</button>
      <button class="ghost" data-tool="tailor">🎯 Tailor resume</button>
      <button class="ghost" data-tool="cover">📄 Cover letter</button>
      <button class="ghost" data-tool="prep">📚 Prep me</button>
      <span class="muted" id="mToolStatus"></span>
    </div>
    <div id="mToolOut" style="margin-top:10px"></div>`;

  function aiHtml(d) {
    const a = d.analysis || {};
    // gap analysis: your skills vs the posting's requirements
    let fitLine = "";
    const mySkills = (profile?.skills || []).map((s) => s.toLowerCase());
    if (mySkills.length && a.requiredSkills?.length) {
      const have = a.requiredSkills.filter((r) =>
        mySkills.some((m) => r.toLowerCase().includes(m) || m.includes(r.toLowerCase())));
      const missing = a.requiredSkills.filter((r) => !have.includes(r));
      fitLine = `<p><b>Your fit:</b> you cover <b>${have.length}/${a.requiredSkills.length}</b> required skills${
        missing.length ? ` — worth addressing: ${missing.slice(0, 4).map(esc).join(", ")}` : " — strong match 🎯"}</p>`;
    }
    return (
      fitLine +
      (a.summary ? `<p class="muted">${esc(a.summary)}</p>` : "") +
      (a.requiredSkills?.length ? `<p><b>Required:</b> ${chips(a.requiredSkills, "SWE")}</p>` : "") +
      (a.niceToHave?.length ? `<p><b>Nice to have:</b> ${chips(a.niceToHave, "")}</p>` : "") +
      (a.buzzwords?.length ? `<p><b>Resume buzzwords:</b> ${chips(a.buzzwords, "Quant")}</p>` : "") +
      (d.desc ? `<details><summary style="cursor:pointer">Full description</summary><pre class="desc">${esc(d.desc)}</pre></details>` : "")
    );
  }

  modal.querySelector("#mClose").addEventListener("click", closeModal);
  modal.querySelector("#mApply").addEventListener("click", () => {
    addPending({ ...j, role: j.role, link: url }).then(renderPending);
  });

  const saveField = async (k, v) => {
    const patch = {
      [k]: v,
      title: j.role, company: j.company, location: j.location,
      category: j.category, salary: j.salary,
    };
    if (k === "status" && v === "applied" && !modal.querySelector("#mApplied").value)
      patch.appliedAt = Date.now();
    await upsertTracker(url, patch);
    render();
  };
  modal.querySelector("#mStatus").addEventListener("change", (ev) => saveField("status", ev.target.value));
  modal.querySelector("#mApplied").addEventListener("change", (ev) =>
    saveField("appliedAt", ev.target.value ? new Date(ev.target.value + "T12:00:00").getTime() : null));
  modal.querySelector("#mReferral").addEventListener("change", (ev) => saveField("referral", ev.target.value));
  modal.querySelector("#mReferrer").addEventListener("change", (ev) => saveField("referrer", ev.target.value));
  modal.querySelector("#mNext").addEventListener("change", (ev) => saveField("nextStep", ev.target.value));
  modal.querySelector("#mNotes").addEventListener("change", (ev) => saveField("notes", ev.target.value));

  modal.querySelector("#mAnalyze")?.addEventListener("click", async () => {
    const btn = modal.querySelector("#mAnalyze");
    const st = modal.querySelector("#mAIStatus");
    btn.disabled = true;
    try {
      st.textContent = " fetching posting…";
      const desc = await fetchDescription(url);
      st.textContent = " analyzing with Gemini…";
      const res = await chrome.runtime.sendMessage({ type: "LLM_ANALYZE", jobText: desc });
      if (!res.ok) throw new Error(res.error);
      const d = { fetchedAt: Date.now(), desc, analysis: res.data };
      const { jobDetails = {} } = await chrome.storage.local.get("jobDetails");
      jobDetails[url] = d;
      await chrome.storage.local.set({ jobDetails });
      if (res.data.requiredSkills?.length)
        await upsertTracker(url, {
          skills: res.data.requiredSkills, buzzwords: res.data.buzzwords || [],
          title: j.role, company: j.company,
        });
      modal.querySelector("#mAI").innerHTML = aiHtml(d);
    } catch (err) {
      st.textContent = " " + String(err.message || err);
      btn.disabled = false;
    }
  });

  // ---- AI toolkit: referrals, follow-up, tailoring, prep ----
  const toolOut = modal.querySelector("#mToolOut");
  const toolStatus = modal.querySelector("#mToolStatus");

  const outBlock = (text, note) =>
    `${note ? `<p class="muted" style="margin:0 0 6px">${note}</p>` : ""}
     <pre class="desc" style="max-height:340px" id="mToolText">${esc(text)}</pre>
     <button class="ghost" id="mCopyTool">📋 Copy</button>`;

  function wireCopy() {
    modal.querySelector("#mCopyTool")?.addEventListener("click", async (ev) => {
      await navigator.clipboard.writeText(modal.querySelector("#mToolText").textContent);
      ev.target.textContent = "✓ Copied";
      setTimeout(() => (ev.target.textContent = "📋 Copy"), 2000);
    });
  }

  async function runTool(tool) {
    const jobText = (jobDetails[url]?.desc || "").slice(0, 7000);
    const ctx = { company: j.company, role: j.role, jobText };

    if (tool === "referral") {
      const school = profile?.education?.school || "";
      const li = (kw) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`;
      toolOut.innerHTML = `
        <p style="margin:6px 0"><b>Find someone to ask</b> — referred applications convert ~10x better than cold ones:</p>
        <p style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0">
          <a href="${esc(li(j.company + " " + school))}" target="_blank"><button class="ghost">🎓 ${esc(j.company)} + your school</button></a>
          <a href="${esc(li(j.company + " recruiter university"))}" target="_blank"><button class="ghost">🧑‍💼 ${esc(j.company)} recruiters</button></a>
          <a href="${esc(li(j.company + " software engineer intern"))}" target="_blank"><button class="ghost">👥 ${esc(j.company)} engineers</button></a>
        </p>
        <button class="primary" id="mRefMsgs">✍️ Draft my 3 outreach messages</button>
        <div id="mRefOut" style="margin-top:8px"></div>`;
      toolOut.querySelector("#mRefMsgs").addEventListener("click", async (ev) => {
        ev.target.disabled = true; ev.target.textContent = "Drafting…";
        const res = await chrome.runtime.sendMessage({ type: "LLM_TASK", task: "referral_msgs", ctx });
        toolOut.querySelector("#mRefOut").innerHTML = res.ok ? outBlock(res.text) : `<p class="muted">${esc(res.error)}</p>`;
        wireCopy();
        ev.target.disabled = false; ev.target.textContent = "✍️ Draft my 3 outreach messages";
        if (res.ok) await upsertTracker(url, { referral: entry?.referral === "none" || !entry ? "want one" : entry.referral, title: j.role, company: j.company });
      });
      return;
    }

    if (tool === "prep") {
      // quick research links render instantly, the AI sheet follows below
      const g = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
      toolOut.innerHTML = `
        <p style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0">
          <a href="${esc(g(`site:leetcode.com/discuss ${j.company} interview`))}" target="_blank"><button class="ghost">🧩 LeetCode threads</button></a>
          <a href="${esc(g(`${j.company} ${j.role} interview questions glassdoor`))}" target="_blank"><button class="ghost">🚪 Glassdoor questions</button></a>
          <a href="${esc(g(`${j.company} intern interview process reddit`))}" target="_blank"><button class="ghost">💬 Reddit experiences</button></a>
        </p><div id="mPrepHolder"></div>`;
    }

    // LLM tools — tailor, cover & prep results are cached per job
    const cacheKey = { tailor: "tailorOut", prep: "prepOut", cover: "coverOut" }[tool];
    const sink = tool === "prep" ? toolOut.querySelector("#mPrepHolder") : toolOut;
    if (cacheKey && jobDetails[url]?.[cacheKey]) {
      sink.innerHTML = outBlock(jobDetails[url][cacheKey], "Cached — re-run from the button to regenerate.");
      wireCopy();
      return;
    }
    toolStatus.textContent = " thinking…";
    if (tool === "followup") ctx.daysSince = e.appliedAt ? Math.floor((Date.now() - e.appliedAt) / 864e5) : undefined;
    if (tool === "tailor") ctx.buzzwords = jobDetails[url]?.analysis?.buzzwords || entry?.buzzwords || [];
    const res = await chrome.runtime.sendMessage({ type: "LLM_TASK", task: tool, ctx });
    toolStatus.textContent = "";
    if (!res.ok) { sink.innerHTML = `<p class="muted">${esc(res.error)}</p>`; return; }
    sink.innerHTML = outBlock(res.text,
      tool === "tailor" ? "Paste these into your resume doc — the AI was told to never invent facts." : "");
    wireCopy();
    if (cacheKey) {
      const { jobDetails: jd = {} } = await chrome.storage.local.get("jobDetails");
      jd[url] = { ...(jd[url] || {}), [cacheKey]: res.text };
      await chrome.storage.local.set({ jobDetails: jd });
    }
  }

  modal.querySelectorAll("[data-tool]").forEach((b) =>
    b.addEventListener("click", () => runTool(b.dataset.tool))
  );

  document.getElementById("modalWrap").style.display = "";
  if (autoTool) runTool(autoTool);
}

// ---------- feed rendering ----------

async function renderFeed() {
  const { feedCache, tracker = {}, profile, hiddenJobs = {}, importedJobs = {} } =
    await chrome.storage.local.get(["feedCache", "tracker", "profile", "hiddenJobs", "importedJobs"]);
  const meta = document.getElementById("feedMeta");
  const box = document.getElementById("feedTable");

  await renderPending();
  document.getElementById("hiddenCount").textContent = Object.keys(hiddenJobs).length;

  const nImported = Object.keys(importedJobs).length;
  if (!feedCache && !nImported) {
    meta.textContent = "";
    box.innerHTML = `<div class="empty">No feed yet — hit <b>Refresh feed</b>, or <b>📥 Import</b> jobs from a Jobright email.</div>`;
    return;
  }

  const all = withImported(feedCache ? feedCache.jobs : [], importedJobs);
  const f = readFilters();
  f.hidden = hiddenJobs;
  f.showHidden = document.getElementById("fShowHidden").checked;
  const jobs = sortJobs(attachScores(applyFilters(all, f, tracker), profile, tracker), f.sort);

  const ageMin = feedCache ? Math.round((Date.now() - feedCache.fetchedAt) / 60000) : 0;
  meta.textContent =
    `${jobs.length} shown / ${all.length} total` +
    (feedCache ? ` · fetched ${ageMin < 60 ? ageMin + "m" : Math.round(ageMin / 60) + "h"} ago` : "") +
    (nImported ? ` · ${nImported} imported` : "") +
    (feedCache?.errors?.length ? ` · errors: ${feedCache.errors.join("; ")}` : "");

  const shown = jobs.slice(0, 500);
  box.innerHTML = shown.length
    ? jobsTableHtml(shown, tracker, hiddenJobs) +
      (jobs.length > 500 ? `<div class="empty">…and ${jobs.length - 500} more — narrow the filters.</div>` : "")
    : `<div class="empty">${f.showHidden ? "Nothing hidden yet — the 🙈 button on any row puts it here." : "Nothing matches these filters."}</div>`;
  if (shown.length) wireJobRows(box, shown);
}

// ---------- tracker (spreadsheet grid) ----------

async function renderTracker() {
  const { tracker = {} } = await chrome.storage.local.get("tracker");
  const box = document.getElementById("trackerTable");
  const statsBox = document.getElementById("trackerStats");
  const q = document.getElementById("tSearch").value.trim().toLowerCase();
  const statusFilter = document.getElementById("tStatus").value;
  const refOnly = document.getElementById("tReferralsOnly").checked;

  const all = Object.values(tracker).map(normEntry);
  const entries = all
    .filter((e) => !q || (e.company + " " + e.title + " " + e.notes + " " + e.referrer).toLowerCase().includes(q))
    .filter((e) => !statusFilter || e.status === statusFilter)
    .filter((e) => !refOnly || e.referral !== "none")
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const counts = {};
  for (const e of all) counts[e.status] = (counts[e.status] || 0) + 1;
  const nRef = all.filter((e) => e.referral !== "none").length;
  statsBox.innerHTML =
    `<div class="stat"><b>${all.length}</b><span>total</span></div>` +
    STATUSES.filter((s) => counts[s]).map(
      (s) => `<div class="stat"><b style="color:${STATUS_COLORS[s]}">${counts[s]}</b><span>${s}</span></div>`
    ).join("") +
    (nRef ? `<div class="stat"><b style="color:var(--violet)">${nRef}</b><span>referrals</span></div>` : "");

  if (!entries.length) {
    box.innerHTML = `<div class="empty">Nothing here${q || statusFilter || refOnly ? " with these filters" : " yet — filling a form, confirming an apply, or hitting “＋ track” adds entries"}.</div>`;
    return;
  }

  box.innerHTML = `<div class="scroll"><table><thead><tr>
    <th>Company</th><th>Role</th><th>Status</th><th>Applied</th>
    <th>Referral</th><th>Referrer</th><th>Next step</th><th>Notes</th><th>Added</th><th></th>
  </tr></thead><tbody>${entries.map((e) => `
    <tr data-url="${esc(e.url)}">
      <td><b>${esc(e.company)}</b>${e.category ? `<div><span class="${catClass(e.category)}">${esc(e.category)}</span></div>` : ""}</td>
      <td><a href="${esc(e.url)}" target="_blank" rel="noreferrer">${esc(e.title)}</a>${e.location ? `<div class="muted">${esc(e.location)}</div>` : ""}${
        e.skills?.length ? `<div>${e.skills.slice(0, 6).map((s) => `<span class="cat" title="required skill">${esc(s)}</span>`).join(" ")}</div>` : ""
      }</td>
      <td><select class="cell" data-k="status" style="color:${STATUS_COLORS[e.status] || "#333"};font-weight:600">${STATUSES.map(
        (s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
      <td><input class="cell" type="date" data-k="appliedAt" value="${e.appliedAt ? new Date(e.appliedAt).toISOString().slice(0, 10) : ""}"></td>
      <td><select class="cell" data-k="referral">${REFERRALS.map(
        (r) => `<option ${r === e.referral ? "selected" : ""}>${r}</option>`).join("")}</select></td>
      <td><input class="cell" data-k="referrer" value="${esc(e.referrer)}" placeholder="who?"></td>
      <td><input class="cell wide" data-k="nextStep" value="${esc(e.nextStep)}" placeholder="e.g. OA due Fri"></td>
      <td><input class="cell wide" data-k="notes" value="${esc(e.notes)}" placeholder="notes…"></td>
      <td class="muted" style="white-space:nowrap">${new Date(e.addedAt).toLocaleDateString()}</td>
      <td style="white-space:nowrap"><button class="ghost details">ⓘ</button> <button class="ghost del" title="Remove from tracker" aria-label="Remove from tracker">✕</button></td>
    </tr>`).join("")}</tbody></table></div>`;

  box.querySelectorAll("tr[data-url]").forEach((tr) => {
    const url = tr.dataset.url;
    tr.querySelectorAll("[data-k]").forEach((el) =>
      el.addEventListener("change", async () => {
        const k = el.dataset.k;
        let v = el.value;
        if (k === "appliedAt") v = v ? new Date(v + "T12:00:00").getTime() : null;
        const patch = { [k]: v };
        // picking a date implies you applied; setting status applied stamps today
        if (k === "appliedAt" && v) patch.status = statusAtLeast(tr, "applied");
        if (k === "status" && v === "applied") {
          const cur = tr.querySelector('[data-k="appliedAt"]').value;
          if (!cur) patch.appliedAt = Date.now();
        }
        await upsertTracker(url, patch);
        renderTracker();
        renderFeed(); // badges may change
      })
    );
    tr.querySelector("button.details").addEventListener("click", async () => {
      const { tracker = {} } = await chrome.storage.local.get("tracker");
      if (tracker[url]) openDetail({ ...normEntry(tracker[url]), link: url });
    });
    tr.querySelector("button.del").addEventListener("click", async () => {
      const { tracker = {} } = await chrome.storage.local.get("tracker");
      delete tracker[url];
      await chrome.storage.local.set({ tracker });
      render();
    });
  });

  function statusAtLeast(tr, min) {
    const cur = tr.querySelector('[data-k="status"]').value;
    return STATUSES.indexOf(cur) >= STATUSES.indexOf(min) ? cur : min;
  }
}

// ---------- export ----------

const EXPORT_COLS = [
  ["Company", (e) => e.company], ["Role", (e) => e.title], ["Category", (e) => e.category],
  ["Location", (e) => e.location], ["Status", (e) => e.status],
  ["Applied", (e) => (e.appliedAt ? new Date(e.appliedAt).toISOString().slice(0, 10) : "")],
  ["Referral", (e) => e.referral], ["Referrer", (e) => e.referrer],
  ["Next step", (e) => e.nextStep], ["Notes", (e) => e.notes],
  ["Salary", (e) => e.salary], ["Link", (e) => e.url],
  ["Added", (e) => new Date(e.addedAt).toISOString().slice(0, 10)],
];

async function exportRows() {
  const { tracker = {} } = await chrome.storage.local.get("tracker");
  const entries = Object.values(tracker).map(normEntry).sort((a, b) => a.addedAt - b.addedAt);
  return [EXPORT_COLS.map(([h]) => h), ...entries.map((e) => EXPORT_COLS.map(([, fn]) => fn(e) ?? ""))];
}

document.getElementById("copySheets").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget; // capture before awaits — currentTarget is null after dispatch
  const rows = await exportRows();
  const tsv = rows.map((r) => r.map((c) => String(c).replace(/[\t\n]/g, " ")).join("\t")).join("\n");
  await navigator.clipboard.writeText(tsv);
  btn.textContent = "✓ Copied — paste into the sheet";
  toast("Tracker copied — paste into the new sheet with ⌘V");
  setTimeout(() => (btn.textContent = "📋 Copy for Sheets"), 4000);
  chrome.tabs.create({ url: "https://sheets.new" });
});

document.getElementById("exportCsv").addEventListener("click", async () => {
  const rows = await exportRows();
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "applications.csv";
  a.click();
});

// ---------- profile tab ----------

function barChartSvg(weeks) {
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const bw = 30, gap = 14, h = 92;
  const w = weeks.length * (bw + gap);
  return `<svg width="${w}" height="${h + 24}" role="img">` + weeks.map((wk, i) => {
    const bh = Math.max(wk.count ? 6 : 2, Math.round((wk.count / max) * h));
    const x = i * (bw + gap);
    return `<rect x="${x}" y="${h - bh}" width="${bw}" height="${bh}" rx="6" fill="var(--accent)" opacity="${wk.count ? 0.9 : 0.12}"></rect>
      <text x="${x + bw / 2}" y="${h - bh - 5}" font-size="11" font-weight="650" text-anchor="middle" fill="var(--ink-2)">${wk.count || ""}</text>
      <text x="${x + bw / 2}" y="${h + 16}" font-size="9.5" text-anchor="middle" fill="var(--ink-3)">${wk.label}</text>`;
  }).join("") + `</svg>`;
}

function rateTable(title, rows) {
  if (!rows.length) return "";
  return `<p style="margin:10px 0 4px"><b style="font-size:12.5px">${esc(title)}</b></p>
    <table class="mini"><thead><tr><th>${esc(title)}</th><th>Applied</th><th>Heard back</th><th>Rate</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.applied}</td><td>${r.responded}</td>
      <td><b style="color:${r.rate >= 20 ? "var(--green)" : r.rate > 0 ? "var(--accent)" : "var(--ink-3)"}">${r.rate}%</b></td></tr>`).join("") +
    `</tbody></table>`;
}

function groupRates(entries, keyFn) {
  const groups = {};
  for (const e of entries) {
    const k = keyFn(e);
    if (!k) continue;
    const g = (groups[k] ||= { name: k, applied: 0, responded: 0 });
    g.applied++;
    if (["OA", "interview", "offer", "rejected"].includes(e.status)) g.responded++;
  }
  return Object.values(groups)
    .map((g) => ({ ...g, rate: Math.round((g.responded / g.applied) * 100) }))
    .sort((a, b) => b.applied - a.applied)
    .slice(0, 6);
}

async function renderProfile() {
  const { profile, tracker = {}, resumes = [], activeResumeId, templates = [], linkedinQueries = [], watchlist = [], lastBackupAt } =
    await chrome.storage.local.get(["profile", "tracker", "resumes", "activeResumeId", "templates", "linkedinQueries", "watchlist", "lastBackupAt"]);

  // stats: "applied+" = anything at or past the applied stage (incl. rejected/ghosted)
  const all = Object.values(tracker).map(normEntry);
  const appliedPlus = all.filter((e) => !["saved", "filled"].includes(e.status));
  const week = all.filter((e) => e.appliedAt && Date.now() - e.appliedAt < 7 * 864e5).length;
  const interviews = all.filter((e) => ["interview", "offer"].includes(e.status)).length;
  const offers = all.filter((e) => e.status === "offer").length;
  document.getElementById("profileStats").innerHTML =
    `<div class="stat"><b>${all.length}</b><span>tracked</span></div>` +
    `<div class="stat"><b style="color:var(--accent)">${appliedPlus.length}</b><span>applied</span></div>` +
    `<div class="stat"><b>${week}</b><span>this week</span></div>` +
    `<div class="stat"><b style="color:var(--teal)">${interviews}</b><span>interviews</span></div>` +
    `<div class="stat"><b style="color:var(--green)">${offers}</b><span>offers</span></div>` +
    (appliedPlus.length ? `<div class="stat"><b>${Math.round((interviews / appliedPlus.length) * 100)}%</b><span>interview rate</span></div>` : "");

  // profile summary card
  const p = profile || {};
  const pi = p.personal || {};
  document.getElementById("profileCard").innerHTML = profile
    ? `<b>${esc([pi.firstName, pi.lastName].filter(Boolean).join(" "))}</b> · ${esc(pi.email || "")}<br>
       ${esc(pi.location || "")}${p.education?.school ? " · " + esc(p.education.school) : ""}${p.education?.gradYear ? " '" + esc(String(p.education.gradYear).slice(-2)) : ""}<br>
       <span class="muted">${["linkedin", "github", "website"].map((k) => p.links?.[k]).filter(Boolean).map((u) => `<a href="${esc(u)}" target="_blank">${esc(u.replace(/https?:\/\/(www\.)?/, ""))}</a>`).join(" · ")}</span>`
    : 'No profile yet — <a href="#" id="editProfile2">set it up</a>.';

  // resumes
  document.getElementById("resumeList").innerHTML = resumes.map((r) => `
    <div class="itemRow" data-id="${esc(r.id)}">
      <input type="radio" name="activeResume" title="attach this one by default" ${r.id === (activeResumeId || resumes[0]?.id) ? "checked" : ""}>
      <span class="name">${esc(r.name)}</span>
      <input type="text" class="usedFor" value="${esc(r.usedFor || "")}" placeholder="used for… (e.g. quant roles)">
      <button class="ghost delRes" title="Delete resume" aria-label="Delete resume">✕</button>
    </div>`).join("") || `<div class="muted">No resumes uploaded yet.</div>`;
  document.querySelectorAll("#resumeList .itemRow").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('input[type="radio"]').addEventListener("change", () =>
      chrome.storage.local.set({ activeResumeId: id }));
    row.querySelector(".usedFor").addEventListener("change", async (e) => {
      const { resumes = [] } = await chrome.storage.local.get("resumes");
      const r = resumes.find((x) => x.id === id);
      if (r) r.usedFor = e.target.value;
      await chrome.storage.local.set({ resumes });
    });
    row.querySelector(".delRes").addEventListener("click", async () => {
      let { resumes = [], activeResumeId } = await chrome.storage.local.get(["resumes", "activeResumeId"]);
      resumes = resumes.filter((x) => x.id !== id);
      if (activeResumeId === id) activeResumeId = resumes[0]?.id || null;
      await chrome.storage.local.set({ resumes, activeResumeId });
      renderProfile();
    });
  });

  // templates
  document.getElementById("templateList").innerHTML = templates.map((t, i) => `
    <div class="itemRow" data-i="${i}">
      <input type="text" class="tName" value="${esc(t.name)}" placeholder="template name">
      <button class="ghost delTpl" title="Delete template" aria-label="Delete template">✕</button>
      <textarea class="tText" placeholder="the answer, in your voice…">${esc(t.text)}</textarea>
    </div>`).join("");
  document.querySelectorAll("#templateList .itemRow").forEach((row) => {
    const i = +row.dataset.i;
    const save = async () => {
      const { templates = [] } = await chrome.storage.local.get("templates");
      if (!templates[i]) return;
      templates[i].name = row.querySelector(".tName").value;
      templates[i].text = row.querySelector(".tText").value;
      await chrome.storage.local.set({ templates });
    };
    row.querySelector(".tName").addEventListener("change", save);
    row.querySelector(".tText").addEventListener("change", save);
    row.querySelector(".delTpl").addEventListener("click", async () => {
      const { templates = [] } = await chrome.storage.local.get("templates");
      templates.splice(i, 1);
      await chrome.storage.local.set({ templates });
      renderProfile();
    });
  });

  // linkedin searches
  document.getElementById("liList").innerHTML = linkedinQueries.map((q, i) => `
    <div class="itemRow" data-i="${i}">
      <input type="text" class="liKw" value="${esc(q.keywords)}" placeholder="keywords (e.g. software engineer intern)">
      <input type="text" class="liLoc" value="${esc(q.location || "")}" placeholder="location (e.g. United States)">
      <button class="ghost delLi" title="Delete search" aria-label="Delete search">✕</button>
    </div>`).join("");
  document.querySelectorAll("#liList .itemRow").forEach((row) => {
    const i = +row.dataset.i;
    const save = async () => {
      const { linkedinQueries = [] } = await chrome.storage.local.get("linkedinQueries");
      if (!linkedinQueries[i]) return;
      linkedinQueries[i].keywords = row.querySelector(".liKw").value;
      linkedinQueries[i].location = row.querySelector(".liLoc").value;
      await chrome.storage.local.set({ linkedinQueries });
    };
    row.querySelector(".liKw").addEventListener("change", save);
    row.querySelector(".liLoc").addEventListener("change", save);
    row.querySelector(".delLi").addEventListener("click", async () => {
      const { linkedinQueries = [] } = await chrome.storage.local.get("linkedinQueries");
      linkedinQueries.splice(i, 1);
      await chrome.storage.local.set({ linkedinQueries });
      renderProfile();
    });
  });

  // watchlist
  document.getElementById("watchList").innerHTML = watchlist.map((w, i) => `
    <div class="itemRow" data-i="${i}">
      <input type="text" class="wSlug" value="${esc(w.slug || "")}" placeholder="slug (e.g. stripe)">
      <select class="wAts" style="padding:6px;border:1px solid var(--line);border-radius:8px;font-size:12px">
        <option value="greenhouse" ${!["lever", "amazon", "eightfold"].includes(w.ats) ? "selected" : ""}>Greenhouse</option>
        <option value="lever" ${w.ats === "lever" ? "selected" : ""}>Lever</option>
        <option value="amazon" ${w.ats === "amazon" ? "selected" : ""}>Amazon</option>
        <option value="eightfold" ${w.ats === "eightfold" ? "selected" : ""}>Eightfold</option>
      </select>
      <input type="text" class="wName" value="${esc(w.name || "")}" placeholder="display name (optional)">
      <button class="ghost delWatch" title="Stop watching" aria-label="Stop watching">✕</button>
    </div>`).join("");
  document.querySelectorAll("#watchList .itemRow").forEach((row) => {
    const i = +row.dataset.i;
    const save = async () => {
      const { watchlist = [] } = await chrome.storage.local.get("watchlist");
      if (!watchlist[i]) return;
      watchlist[i].slug = row.querySelector(".wSlug").value.trim();
      watchlist[i].ats = row.querySelector(".wAts").value;
      watchlist[i].name = row.querySelector(".wName").value.trim();
      await chrome.storage.local.set({ watchlist });
    };
    row.querySelector(".wSlug").addEventListener("change", save);
    row.querySelector(".wAts").addEventListener("change", save);
    row.querySelector(".wName").addEventListener("change", save);
    row.querySelector(".delWatch").addEventListener("click", async () => {
      const { watchlist = [] } = await chrome.storage.local.get("watchlist");
      watchlist.splice(i, 1);
      await chrome.storage.local.set({ watchlist });
      renderProfile();
    });
  });

  // ---- insights ----
  const appliedEntries = all.filter((e) => e.appliedAt);
  const monday = (t) => { const d = new Date(t); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d; };
  const thisMon = monday(new Date());
  const weeksArr = [];
  for (let i = 7; i >= 0; i--) {
    const start = new Date(thisMon); start.setDate(start.getDate() - i * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    weeksArr.push({
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      count: appliedEntries.filter((e) => e.appliedAt >= start.getTime() && e.appliedAt < end.getTime()).length,
    });
  }
  document.getElementById("insightsChart").innerHTML = weeksArr.some((w) => w.count)
    ? barChartSvg(weeksArr)
    : `<div class="empty" style="padding:20px 0">Nothing yet — the first bar starts with your first application.</div>`;

  const stageCounts = [
    ["applied", appliedPlus.length],
    ["OA+", all.filter((e) => ["OA", "interview", "offer"].includes(e.status)).length],
    ["interview", all.filter((e) => ["interview", "offer"].includes(e.status)).length],
    ["offer", offers],
  ];
  const fMax = Math.max(1, stageCounts[0][1]);
  document.getElementById("insightsFunnel").innerHTML = stageCounts[0][1]
    ? stageCounts.map(([lbl, n], i) => `
        <div class="funnelRow">
          <span class="lbl">${esc(lbl)}</span>
          <div class="bar" style="width:${Math.round((n / fMax) * 220)}px; opacity:${0.95 - i * 0.18}"></div>
          <span class="n">${n}${i > 0 && stageCounts[0][1] ? ` <span class="muted">(${Math.round((n / stageCounts[0][1]) * 100)}%)</span>` : ""}</span>
        </div>`).join("")
    : `<div class="empty" style="padding:20px 0">Funnel appears once you've applied somewhere.</div>`;

  const SRC_LABEL = { ...SRC_NAME, autofill: "Direct (autofill)", manual: "Manual" };
  const srcRows = groupRates(appliedEntries, (e) => SRC_LABEL[e.source] || (e.source ? e.source : null));
  const resRows = groupRates(appliedEntries, (e) => e.resumeUsed || null);
  document.getElementById("insightsSources").innerHTML =
    (srcRows.length || resRows.length)
      ? rateTable("Source", srcRows) + rateTable("Resume", resRows)
      : `<div class="empty" style="padding:20px 0">Once responses come in, you'll see which sources and resumes convert.</div>`;

  document.getElementById("backupInfo").textContent = lastBackupAt
    ? `Last backup: ${new Date(lastBackupAt).toLocaleDateString()}${Date.now() - lastBackupAt > 7 * 864e5 ? " — getting stale!" : ""}`
    : "Never backed up yet.";

  const editLink = document.getElementById("editProfile2");
  if (editLink) editLink.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
}

// ---- brutal resume review ----

document.getElementById("reviewResume").addEventListener("click", async () => {
  const st = document.getElementById("reviewStatus");
  const out = document.getElementById("reviewOut");
  const { profile } = await chrome.storage.local.get("profile");
  if (!profile?.masterResume?.trim()) {
    out.innerHTML = `<p class="muted">Paste your master resume in Options first (Material for AI answers → Master resume).</p>`;
    return;
  }
  st.textContent = " reviewing…";
  const res = await chrome.runtime.sendMessage({ type: "LLM_TASK", task: "review", ctx: {} });
  st.textContent = "";
  out.innerHTML = res.ok
    ? `<pre style="white-space:pre-wrap;font:12.5px/1.6 inherit;background:var(--code-bg);border-radius:12px;padding:14px 16px;max-height:320px;overflow-y:auto">${esc(res.text)}</pre>`
    : `<p class="muted">${esc(res.error)}</p>`;
});

// ---- inbox monitor (Gmail) ----

(async () => {
  // getRedirectURL() === https://<runtime.id>.chromiumapp.org/ — derive it from
  // runtime.id (always available) so the URI shows even before the identity
  // permission is active (i.e. before a full extension reload).
  const redirect =
    (chrome.identity && chrome.identity.getRedirectURL && chrome.identity.getRedirectURL()) ||
    `https://${chrome.runtime.id}.chromiumapp.org/`;
  document.getElementById("redirectUri").textContent = redirect;
  document.getElementById("copyRedirect").addEventListener("click", () => {
    navigator.clipboard.writeText(redirect); toast("Redirect URI copied");
  });
  const { gmailClientId, gmailClientSecret, lastGmailSync } = await chrome.storage.local.get(["gmailClientId", "gmailClientSecret", "lastGmailSync"]);
  if (gmailClientId) document.getElementById("gmailClientId").value = gmailClientId;
  if (gmailClientSecret) document.getElementById("gmailClientSecret").value = gmailClientSecret;
  if (lastGmailSync)
    document.getElementById("gmailStatus").textContent = `Connected · last synced ${new Date(lastGmailSync).toLocaleString()}`;
  // stale-worker detector: an old background can't answer PING (or answers v<2)
  if (!(await bgIsCurrent()))
    document.getElementById("gmailStatus").innerHTML = STALE_BG_MSG;
})();

const STALE_BG_MSG =
  `<span style="color:var(--red)">⚠️ The extension's background code is out of date — Chrome is still running the old version. ` +
  `Open <b>chrome://extensions</b>, find <b>Job Applier</b>, click the <b>↻ reload</b> arrow on its card, then refresh this page.</span>`;

async function bgIsCurrent() {
  try {
    const pong = await chrome.runtime.sendMessage({ type: "PING" });
    return !!pong && pong.v >= 10; // v10 = healing rescan loaded
  } catch { return false; }
}

document.getElementById("gmailSaveConnect").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  const status = document.getElementById("gmailStatus");
  const id = document.getElementById("gmailClientId").value.trim();
  const secret = document.getElementById("gmailClientSecret").value.trim();
  if (!id) { status.textContent = "Paste your OAuth Client ID first."; return; }
  if (!secret) { status.textContent = "Paste your Client secret too (it's next to the Client ID in Google Cloud)."; return; }
  if (!(await bgIsCurrent())) { status.innerHTML = STALE_BG_MSG; return; } // refuse to hang on the old worker
  // new client id/secret invalidates any cached tokens from a previous attempt
  await chrome.storage.local.set({ gmailClientId: id, gmailClientSecret: secret });
  await chrome.storage.local.remove(["gmailAccess", "gmailAccessExp", "gmailRefresh"]);
  btn.disabled = true; btn.textContent = "Connecting…"; status.textContent = "Opening Google sign-in…";
  const res = await chrome.runtime.sendMessage({ type: "GMAIL_SYNC", interactive: true });
  btn.disabled = false; btn.textContent = "Connect & sync";
  if (res.ok) {
    status.innerHTML = `<span style="color:var(--green)">✓ Connected — scanned ${res.emails} email${res.emails === 1 ? "" : "s"}, imported ${res.jobs} job${res.jobs === 1 ? "" : "s"}. Auto-syncs every 30 min.</span>`;
    render();
  } else {
    status.innerHTML = `<span style="color:var(--red)">${esc(res.error)}</span>`;
  }
});

// ---- backup / restore ----

document.getElementById("backupBtn").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  delete all.feedCache; // refetchable and big
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(all)], { type: "application/json" }));
  a.download = `job-applier-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  await chrome.storage.local.set({ lastBackupAt: Date.now() });
  toast("Backup downloaded ⬇");
  renderProfile();
});

document.getElementById("restoreBtn").addEventListener("click", () =>
  document.getElementById("restoreFile").click()
);
document.getElementById("restoreFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.profile && !data.tracker) throw new Error("not a Job Applier backup");
      if (!confirm(`Restore backup? This overwrites your current profile and tracker (${Object.keys(data.tracker || {}).length} tracked jobs in the backup).`)) return;
      await chrome.storage.local.set(data);
      render();
      await restoreFilters();
    } catch (err) {
      alert("Restore failed: " + (err.message || err));
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

document.getElementById("editProfile").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("resumeUpload").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const { resumes = [], activeResumeId } = await chrome.storage.local.get(["resumes", "activeResumeId"]);
    resumes.push({
      id: crypto.randomUUID(), name: file.name, type: file.type,
      dataUrl: reader.result, usedFor: "",
    });
    await chrome.storage.local.set({
      resumes,
      activeResumeId: activeResumeId || resumes[0].id,
    });
    e.target.value = "";
    renderProfile();
  };
  reader.readAsDataURL(file);
});

document.getElementById("addTemplate").addEventListener("click", async () => {
  const { templates = [] } = await chrome.storage.local.get("templates");
  templates.push({ name: "New template", text: "" });
  await chrome.storage.local.set({ templates });
  renderProfile();
});

document.getElementById("addWatch").addEventListener("click", async () => {
  const { watchlist = [] } = await chrome.storage.local.get("watchlist");
  watchlist.push({ slug: "", ats: "greenhouse", name: "" });
  await chrome.storage.local.set({ watchlist });
  renderProfile();
});

document.getElementById("addLi").addEventListener("click", async () => {
  const { linkedinQueries = [] } = await chrome.storage.local.get("linkedinQueries");
  linkedinQueries.push({ keywords: "", location: "United States" });
  await chrome.storage.local.set({ linkedinQueries });
  renderProfile();
});

// ---------- wiring ----------

function chip(v, label, on) {
  return `<span class="chip ${on ? "on" : ""}" data-v="${esc(v)}">${esc(label)}</span>`;
}

document.getElementById("fCats").insertAdjacentHTML(
  "beforeend",
  CATEGORIES.map((c) => chip(c, c, true)).join("") // all on — hiding categories hid real jobs
);
// ---------- import dialog ----------

document.getElementById("importBtn").addEventListener("click", () => {
  const modal = document.getElementById("modal");
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start">
      <h2>📥 Import jobs</h2><button class="ghost" id="impClose" aria-label="Close">✕</button>
    </div>
    <p class="muted" style="margin:6px 0 12px">Paste your <b>Jobright email</b> (select all → copy → paste), a list of job links, or anything with URLs. Every job link is pulled in, scored, and saved to your tracker.</p>
    <textarea id="impText" placeholder="Paste the Jobright email or job links here…" style="width:100%;min-height:200px;padding:10px;border:1px solid var(--line);border-radius:10px;font:12.5px/1.5 inherit;background:var(--surface);color:var(--ink)"></textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <button class="primary" id="impRun">Import</button>
      <label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="impTrack"> also save to tracker</label>
      <span class="muted" id="impStatus"></span>
    </div>
    <div id="impPreview" style="margin-top:12px"></div>`;
  modal.querySelector("#impClose").addEventListener("click", closeModal);
  modal.querySelector("#impRun").addEventListener("click", runImport);
  document.getElementById("modalWrap").style.display = "";
});

async function runImport() {
  const text = document.getElementById("impText").value;
  const status = document.getElementById("impStatus");
  const preview = document.getElementById("impPreview");
  const parsed = parseImport(text);
  if (!parsed.length) { status.textContent = "No job links found in that text."; return; }

  const { importedJobs = {}, tracker = {} } = await chrome.storage.local.get(["importedJobs", "tracker"]);
  const alsoTrack = document.getElementById("impTrack").checked;
  let added = 0;
  const known = idIndex(importedJobs);
  for (const j of parsed) {
    if (known.has(jobUrlId(j.link))) continue; // same posting already imported
    const url = normalizeUrl(j.link);
    known.set(jobUrlId(j.link), url);
    importedJobs[url] = { url, link: j.link, company: j.company, role: j.role, location: j.location || "", source: "imported", addedAt: Date.now(), daysOld: 0 };
    added++;
    if (alsoTrack && !trackedEntry(tracker, j.link)) {
      tracker[url] = { url, title: j.role, company: j.company, location: j.location || "", status: "saved", source: "imported",
        notes: "", addedAt: Date.now(), updatedAt: Date.now() };
    }
  }
  await chrome.storage.local.set({ importedJobs, ...(alsoTrack ? { tracker } : {}) });
  status.innerHTML = `<span style="color:var(--green)">✓ Imported ${added}${alsoTrack ? " (saved to tracker)" : ""}</span>`;
  preview.innerHTML = `<div class="scroll" style="max-height:220px;overflow-y:auto"><table><tbody>${
    parsed.map((j) => `<tr><td><b>${esc(j.company || "—")}</b></td><td>${esc(j.role)}</td><td><a href="${esc(j.link)}" target="_blank">↗</a></td></tr>`).join("")
  }</tbody></table></div>`;
  toast(`Imported ${added} job${added > 1 ? "s" : ""}`);
  render();
}

document.getElementById("fLocs").insertAdjacentHTML(
  "beforeend",
  Object.keys(LOC_CHIPS).map((l) => chip(l, l, false)).join("")
);
document.getElementById("fSources").insertAdjacentHTML(
  "beforeend",
  GH_SOURCES.map((s) => chip(s.id, s.name, true)).join("") +
    chip("linkedin", "LinkedIn", true) + chip("watch", "Watchlist", true) + chip("imported", "Imported", true)
);
document.querySelectorAll(".chips .chip").forEach((c) =>
  c.addEventListener("click", () => {
    c.classList.toggle("on");
    saveFilters();
    renderFeed();
    renderToday();
  })
);

document.getElementById("tStatus").insertAdjacentHTML(
  "beforeend",
  STATUSES.map((s) => `<option value="${s}">${s}</option>`).join("")
);

history.scrollRestoration = "manual"; // stop reload/anchor scroll jumps past the hero

function setTab(name) {
  if (!SECTIONS.includes(name)) name = "today";
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  for (const sec of SECTIONS)
    document.getElementById(sec).style.display = sec === name ? "" : "none";
  document.title = `Job Applier — ${{ today: "Today", feed: "Feed", calendar: "Calendar", tracker: "Applications", profile: "Profile" }[name]}`;
  // "#tab-<name>" matches no element id, so the browser never fragment-scrolls
  // past the hero (plain "#today" would anchor to <section id="today">).
  history.replaceState(null, "", "#tab-" + name);
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tab[data-tab]").forEach((t) =>
  t.addEventListener("click", () => { setTab(t.dataset.tab); render(); })
);

// global search: filters the feed from any tab (tracker tab filters tracker)
document.getElementById("globalSearch").addEventListener("input", (e) => {
  const v = e.target.value;
  const cur = document.querySelector(".tab.active")?.dataset.tab;
  if (cur === "tracker") {
    document.getElementById("tSearch").value = v;
    renderTracker();
  } else {
    if (cur !== "feed") setTab("feed");
    document.getElementById("fSearch").value = v;
    saveFilters();
    renderFeed();
    renderToday();
  }
});

document.getElementById("refresh").addEventListener("click", refreshFeed);
for (const id of FILTER_IDS)
  document.getElementById(id).addEventListener("input", () => { saveFilters(); renderFeed(); renderToday(); });
// hidden view is a transient peek — deliberately not persisted
document.getElementById("fShowHidden").addEventListener("input", renderFeed);
for (const id of ["tSearch", "tStatus", "tReferralsOnly"])
  document.getElementById(id).addEventListener("input", renderTracker);

// returning to this tab after an apply-click -> surface the confirmation cards
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderPending();
});

// keyboard: "/" focuses feed search, 1-5 switch tabs
document.addEventListener("keydown", (e) => {
  if (/input|textarea|select/i.test(document.activeElement?.tagName || "")) return;
  if (e.key === "/") {
    e.preventDefault();
    document.getElementById("globalSearch").focus();
  } else if (["1", "2", "3", "4", "5"].includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    setTab(SECTIONS[+e.key - 1]);
    render();
  }
});

function render() { renderToday(); renderFeed(); renderTracker(); renderProfile(); renderCalendar(); }

// one-time migrations + seed defaults
async function migrate() {
  const store = await chrome.storage.local.get(["resume", "resumes", "templates", "linkedinQueries", "profile", "watchlist"]);
  const patch = {};
  // seed the real profile from the resume — fills EMPTY fields even on an
  // already-saved profile (never overwrites anything the user typed)
  function fillMissing(dst, src) {
    let changed = false;
    for (const k of Object.keys(src)) {
      const sv = src[k], dv = dst[k];
      if (sv && typeof sv === "object" && !Array.isArray(sv)) {
        if (!dv || typeof dv !== "object") { dst[k] = {}; }
        if (fillMissing(dst[k], sv)) changed = true;
      } else if (
        (dv === undefined || dv === null || dv === "" || (Array.isArray(dv) && !dv.length)) &&
        sv !== undefined && sv !== null && sv !== "" && !(Array.isArray(sv) && !sv.length)
      ) {
        dst[k] = sv;
        changed = true;
      }
    }
    return changed;
  }
  if (typeof DEFAULT_PROFILE !== "undefined") {
    if (!store.profile) patch.profile = DEFAULT_PROFILE;
    else {
      const merged = JSON.parse(JSON.stringify(store.profile));
      let changed = fillMissing(merged, DEFAULT_PROFILE);
      // upgrade auto-seeded skills to the fuller resume list — only if untouched
      // (old seed ended with ML/LLM and lacked Express; a customized list won't match)
      if (Array.isArray(merged.skills) && merged.skills.includes("LLM") &&
          merged.skills.includes("Hugging Face") && !merged.skills.includes("Express")) {
        merged.skills = DEFAULT_PROFILE.skills.slice();
        changed = true;
      }
      if (!merged.languages || !merged.languages.length) { merged.languages = ["English"]; changed = true; }
      if (changed) patch.profile = merged;
    }
  }
  if (store.resume && !(store.resumes || []).length) {
    patch.resumes = [{ id: "legacy", name: store.resume.name, type: store.resume.type, dataUrl: store.resume.dataUrl, usedFor: "general" }];
    patch.activeResumeId = "legacy";
  }
  const SEED_TEMPLATES = [
    { name: "Why this company?", text: "I'm drawn to teams that ship systems where correctness actually matters — I've built an agentic AI platform executing real CRM actions (with confirmation gates and snapshot undo, because tools that touch real data can't guess), and a quant backtest engine where I spent more time killing lookahead bias than adding features. I want to work somewhere the engineering bar is set by problems like that. [The AI swaps in company-specific details from the posting.]" },
    { name: "Tell me about a project", text: "I co-founded Bridge AI, where I built an agentic system with a 45-tool registry that executes real CRM actions — creating deals, moving pipeline stages, drafting follow-ups — with confirmation gates and snapshot-based undo for destructive ops. Under it sits a RAG pipeline on PostgreSQL/pgvector (halfvec-3072 + hybrid tsvector search) and a routing layer across 7 LLM providers with fallback chains and per-call cost attribution. The hard part wasn't the AI — it was making it trustworthy enough to touch production data." },
    { name: "Cover letter", text: "Hook: sophomore at Penn doing a CS (SEAS) + Finance (Wharton) dual degree; USACO Gold; already shipped production systems at two startups and founded a web agency that ran 20+ client sites. Middle: pick the most relevant of — Bridge AI agentic platform / Tara Ventures ad-optimization bandits / FZ Jülich EEG-ML research (AUC 0.89) / Vig quant engine. Close: available May 2027, can start interviewing anytime." },
  ];
  const OLD_PLACEHOLDERS = ["Write 3-4 sentences here", "Describe your best project", "A 3-paragraph skeleton"];
  if (store.templates === undefined) patch.templates = SEED_TEMPLATES;
  else if (
    store.templates.length === 3 &&
    store.templates.every((t) => OLD_PLACEHOLDERS.some((p) => (t.text || "").startsWith(p)))
  )
    patch.templates = SEED_TEMPLATES; // untouched placeholders → upgrade to the personalized set
  if (store.linkedinQueries === undefined)
    patch.linkedinQueries = [
      { keywords: "software engineer intern 2027", location: "United States" },
      { keywords: "quantitative intern 2027", location: "United States" },
      { keywords: "software engineer intern (Google OR Meta OR Apple)", location: "United States" },
    ];
  else if (!store.linkedinQueries.some((q) => /google|meta|apple/i.test(q.keywords || "")))
    // FAANG without a public board API (Google/Meta/Apple) ride in via LinkedIn
    patch.linkedinQueries = [
      ...store.linkedinQueries,
      { keywords: "software engineer intern (Google OR Meta OR Apple)", location: "United States" },
    ];
  if (store.watchlist === undefined)
    patch.watchlist = [
      { slug: "software engineer intern", ats: "amazon", name: "Amazon" },
      { slug: "explore.jobs.netflix.net|netflix.com", ats: "eightfold", name: "Netflix" },
      { slug: "stripe", ats: "greenhouse", name: "Stripe" },
      { slug: "palantir", ats: "lever", name: "Palantir" },
    ];
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (store.resume && patch.resumes) await chrome.storage.local.remove("resume");

  // one-time: imported jobs no longer auto-save to the tracker — clear the
  // auto-added entries the user never touched (edited ones stay)
  const { gmailNoAutoTrack } = await chrome.storage.local.get("gmailNoAutoTrack");
  if (!gmailNoAutoTrack) {
    const { tracker: t = {} } = await chrome.storage.local.get("tracker");
    let untracked = 0;
    for (const k of Object.keys(t)) {
      const e = t[k];
      if (e?.source === "imported" && e.status === "saved" && !e.notes && !e.nextStep &&
          !e.appliedAt && (!e.referral || e.referral === "none") && (e.updatedAt || 0) <= (e.addedAt || 0)) {
        delete t[k]; untracked++;
      }
    }
    await chrome.storage.local.set({ tracker: t, gmailNoAutoTrack: true });
    if (untracked) toast(`Imported jobs now stay in the feed — cleared ${untracked} auto-tracked entries`);
  }

  // one-time (v2): the in-Gmail scanner kept auto-tracking every imported job
  // as "saved" after the API sync stopped — clear those untouched entries too
  const { importNoAutoTrackV2 } = await chrome.storage.local.get("importNoAutoTrackV2");
  if (!importNoAutoTrackV2) {
    const { tracker: t = {} } = await chrome.storage.local.get("tracker");
    let untracked = 0;
    for (const k of Object.keys(t)) {
      const e = t[k];
      if (e?.source === "imported" && e.status === "saved" && !e.notes && !e.nextStep &&
          !e.appliedAt && (!e.referral || e.referral === "none") && (e.updatedAt || 0) <= (e.addedAt || 0)) {
        delete t[k]; untracked++;
      }
    }
    await chrome.storage.local.set({ tracker: t, importNoAutoTrackV2: true });
    if (untracked) toast(`Cleared ${untracked} auto-tracked imports — they're still in your feed`);
  }

  // every load: collapse stored duplicates (same job id under different URLs)
  {
    const { importedJobs: ij = {}, tracker: tr = {} } = await chrome.storage.local.get(["importedJobs", "tracker"]);
    const a = dedupeStore(ij, "imported"), b = dedupeStore(tr, "tracker");
    if (a || b) {
      await chrome.storage.local.set({ importedJobs: ij, tracker: tr });
      toast(`Merged ${a + b} duplicate job${a + b > 1 ? "s" : ""}`);
    }
  }

  // one-time: saved filters from when only SWE/Quant/ML-AI chips defaulted on
  // were hiding real jobs (Hardware, Data, Other…) — turn every category on
  const { feedFilters } = await chrome.storage.local.get("feedFilters");
  if (feedFilters && !feedFilters.catsAllV1) {
    feedFilters.cats = CATEGORIES.slice();
    feedFilters.catsAllV1 = true;
    await chrome.storage.local.set({ feedFilters });
  }

  // one-time: purge imports that came in as wrapped urldefense.com links
  // (UPenn Proofpoint) before the unwrapper existed, then re-sync. Only runs
  // once the NEW background worker is live — purging while the old parser is
  // still loaded would just re-import the same junk (or nothing).
  if (!(await bgIsCurrent())) return;
  const { importedJobs = {}, tracker = {}, gmailRefresh } =
    await chrome.storage.local.get(["importedJobs", "tracker", "gmailRefresh"]);
  // (no wiping here — the worker's rescan heals stored entries in place;
  // a dashboard-side wipe raced the worker's synced-ids memory and could
  // leave the feed empty)
  // junk shapes from earlier parser versions: wrapped urldefense links, and
  // entries that got Jobright's branding ("Jobright"/blank co.) as the company
  const isJunk = (co, link) =>
    /urldefense/i.test(link || "") || /^jobright/i.test(co || "") || /%/.test(co || "") ||
    /jobright\.ai\/jobs\/recommend/i.test(link || "");
  let purged = 0;
  for (const k of Object.keys(importedJobs))
    if (/urldefense/i.test(k) || isJunk(importedJobs[k]?.company, importedJobs[k]?.link)) { delete importedJobs[k]; purged++; }
  for (const k of Object.keys(tracker))
    if (/urldefense/i.test(k) || (tracker[k]?.source === "imported" && isJunk(tracker[k]?.company, k))) { delete tracker[k]; purged++; }
  const { syncedEmailIds = [] } = await chrome.storage.local.get("syncedEmailIds");
  if (purged || (gmailRefresh && !Object.keys(importedJobs).length && syncedEmailIds.length)) {
    // second clause: an earlier cleanup emptied the feed but the re-sync never
    // landed (old worker / swallowed error) — clear the id memory and retry.
    await chrome.storage.local.set({ importedJobs, tracker, syncedEmailIds: [] });
    if (purged) toast(`Cleaned ${purged} wrapped-link imports — re-syncing your inbox…`);
    chrome.runtime.sendMessage({ type: "GMAIL_SYNC", interactive: false })
      .then((res) => {
        if (res?.ok) { toast(`✓ Inbox re-synced — ${res.jobs} job${res.jobs === 1 ? "" : "s"} imported`); render(); }
        else document.getElementById("gmailStatus").innerHTML =
          `<span style="color:var(--red)">Re-sync failed: ${esc(res?.error || "no response")} — hit Connect &amp; sync.</span>`;
      })
      .catch((e) => {
        document.getElementById("gmailStatus").innerHTML =
          `<span style="color:var(--red)">Re-sync failed: ${esc(String(e.message || e))} — hit Connect &amp; sync.</span>`;
      });
  }
}

// initial load: migrate, restore filters, route by hash, show cache, refresh if stale (>2h)
(async () => {
  try { chrome.action.setBadgeText({ text: "" }); } catch {} // you've seen today's jobs
  await initTheme();
  await migrate();
  await restoreFilters();
  setTab(location.hash.replace(/^#(tab-)?/, "") || "today");
  render();
  const { feedCache } = await chrome.storage.local.get("feedCache");
  if (!feedCache || Date.now() - feedCache.fetchedAt > 2 * 3600e3) refreshFeed();
})();

// Job-board sources for the feed. Loaded by dashboard.html (script tag) and
// background.js (importScripts), so the feed refreshes hourly even with the
// dashboard closed — keep this file free of DOM APIs (no DOMParser/document).
// Depends on parser.js (categorize, normalizeUrl, parseReadme, parseDaysOld,
// GH_SOURCES, dedupeJobs).

// early-career titles only — big-company boards are mostly full-time roles.
// \bintern\b so "Internal Audit" / "International" don't sneak in.
const EARLY_RE = /\bintern(ship)?s?\b|\bco-?op\b|new grad|\buniversity (grad|graduate|hire)|early career|\bapprentice|\bstudent\b|\brotational\b|\bsummer 20\d\d\b/i;

// company boards list worldwide roles — keep US (and remote/unspecified) ones
const US_STATE = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_RE = new RegExp(`\\b(united states|usa|u\\.s\\.|remote|nyc|sf bay)\\b|,\\s*(${US_STATE})\\b|,\\s*US\\b|^(new york|san francisco|seattle|chicago|boston|austin|menlo park|mountain view|sunnyvale|cupertino|redmond|palo alto)\\b`, "i");
const isUS = (loc) => !loc || US_RE.test(loc);

// staff roles that merely mention early careers ("Campus Recruiter, Early
// Careers", "Rotational Coordinator") aren't openings for you
const STAFF_RE = /\b(recruit\w*|coordinator|manager|director|head of|lead|specialist|partner|advisor|counsel|administrator)\b/i;
const isEarly = (title) => EARLY_RE.test(title) &&
  (!STAFF_RE.test(title) || /\bintern(ship)?s?\b|new grad|university grad|rotational product manager|associate product manager/i.test(title));

const daysSince = (ms) => (ms ? Math.max(0, Math.floor((Date.now() - ms) / 864e5)) : null);

function job(source, company, role, location, link, daysOld, extra = {}) {
  return {
    source, company, role, location: location || "", link: link ? normalizeUrl(link) : null,
    category: categorize(role, extra.repoCategory || ""), salary: extra.salary || "", daysOld,
    closed: false, noSponsorship: !!extra.noSponsorship, citizenOnly: !!extra.citizenOnly,
  };
}

// ---------- LinkedIn guest listing (public, no login) ----------

function htmlText(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchLinkedIn(q) {
  const params = new URLSearchParams({ keywords: q.keywords, location: q.location || "United States", start: "0" });
  const res = await fetch("https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" + params);
  if (!res.ok) throw new Error(`LinkedIn "${q.keywords}": HTTP ${res.status}`);
  const html = await res.text();
  // regex over the guest cards (DOMParser isn't available in the service worker)
  return html.split(/<li[\s>]/).slice(1).map((card) => {
    const link = (card.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/) || card.match(/href="([^"]*\/jobs\/view\/[^"]+)"/) || [])[1] || "";
    const role = htmlText((card.match(/class="base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
    const company = htmlText((card.match(/class="base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/) || [])[1]);
    const location = htmlText((card.match(/class="job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    const dt = (card.match(/<time[^>]*datetime="(\d{4})-(\d{2})-(\d{2})"/) || []);
    const daysOld = dt[1] ? daysSince(new Date(+dt[1], +dt[2] - 1, +dt[3]).getTime()) : null;
    const j = job("linkedin", company, role, location, link.replace(/&amp;/g, "&"), daysOld);
    j.closed = !link;
    return j;
  }).filter((j) => j.company && j.role);
}

// ---------- SimplifyJobs (the big community internship list) ----------

async function fetchSimplify() {
  const res = await fetch("https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json");
  if (!res.ok) throw new Error(`SimplifyJobs: HTTP ${res.status}`);
  const all = await res.json();
  return all
    .filter((x) => x.active && x.is_visible !== false && x.url && Date.now() - x.date_posted * 1000 < 60 * 864e5)
    .map((x) => job("simplify", x.company_name, x.title, (x.locations || []).slice(0, 3).join(" · "), x.url,
      daysSince(x.date_posted * 1000), {
        repoCategory: x.category || "",
        noSponsorship: /does not offer sponsorship/i.test(x.sponsorship || ""),
        citizenOnly: /citizenship/i.test(x.sponsorship || ""),
      }));
}

// ---------- company boards ----------

// Remember when we first saw each posting, for boards that don't expose a
// posted date (Meta). Jobs already up the first time a source is fetched get
// no date (unknown age) — only ones that appear later count as fresh.
async function firstSeenDays(source, ids) {
  const { firstSeen = {} } = await chrome.storage.local.get("firstSeen");
  const now = Date.now();
  const baseline = !firstSeen["__baseline:" + source];
  if (baseline) {
    firstSeen["__baseline:" + source] = now;
    // ids stamped before baselines existed were just "first fetch" — unknown age
    for (const k of Object.keys(firstSeen)) if (k.startsWith(source + ":")) firstSeen[k] = -1;
  }
  const out = {};
  for (const id of ids) {
    const k = source + ":" + id;
    if (!firstSeen[k]) firstSeen[k] = baseline ? -1 : now; // -1 = was already up
    out[id] = firstSeen[k] > 0 ? daysSince(firstSeen[k]) : null;
  }
  for (const k of Object.keys(firstSeen))
    if (!k.startsWith("__baseline:") && firstSeen[k] > 0 && now - firstSeen[k] > 120 * 864e5) delete firstSeen[k];
  await chrome.storage.local.set({ firstSeen });
  return out;
}

async function fetchMeta(w) {
  // metacareers.com is a Relay app: get a fresh LSD token from the search page,
  // then call the same GraphQL query the page uses (returns every open role).
  const page = await fetch("https://www.metacareers.com/jobsearch/", { credentials: "omit" }).then((r) => r.text());
  const lsd = (page.match(/"LSD",\[\],\{"token":"([^"]+)"/) || page.match(/name="lsd" value="([^"]+)"/) || [])[1];
  if (!lsd) throw new Error("Meta: no LSD token on the search page");
  // persisted-query id of CareersJobSearchResultsV2DataQuery (read off the
  // live site Sep 2026); override per watchlist entry if Meta ever rotates it
  const docId = w.docId || "27129360303422352";
  const vars = {
    search_input: { q: "", divisions: [], offices: [], roles: [], leadership_levels: [], saved_jobs: [], saved_searches: [],
      sub_teams: [], teams: [], is_leadership: false, is_remote_only: false, sort_by_new: true, results_per_page: null },
    viewasUserID: null, isLoggedIn: false,
  };
  const res = await fetch("https://www.metacareers.com/graphql", {
    method: "POST", credentials: "omit",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-FB-LSD": lsd, "X-FB-Friendly-Name": "CareersJobSearchResultsV2DataQuery" },
    body: new URLSearchParams({ lsd, doc_id: docId, variables: JSON.stringify(vars), fb_api_req_friendly_name: "CareersJobSearchResultsV2DataQuery" }),
  });
  if (!res.ok) throw new Error(`Meta: HTTP ${res.status}`);
  const data = JSON.parse((await res.text()).split("\n")[0]);
  const all = data?.data?.job_search_with_featured_jobs_v2?.all_jobs;
  if (!Array.isArray(all)) throw new Error("Meta: unexpected response (query id may have changed)");
  const early = all.filter((j) => isEarly(j.title));
  const seen = await firstSeenDays("meta", early.map((j) => j.id));
  return early.map((j) => job("watch", "Meta", j.title, (j.locations || []).slice(0, 3).join(" · "),
    `https://www.metacareers.com/profile/job_details/${j.id}/`, seen[j.id]))
    .filter((j) => (j.location || "").split(" · ").some(isUS));
}

async function fetchGoogle() {
  // careers page embeds results as AF_initDataCallback ds:1 → [rows, _, total, perPage]
  const out = [];
  for (const level of ["INTERN_AND_APPRENTICE", "EARLY"]) {
    for (let page = 1; page <= 8; page++) {
      const res = await fetch(`https://www.google.com/about/careers/applications/jobs/results?target_level=${level}&sort_by=date&page=${page}`);
      if (!res.ok) { if (page > 1) break; throw new Error(`Google: HTTP ${res.status}`); }
      const m = (await res.text()).match(/AF_initDataCallback\(\{key: 'ds:1'[\s\S]*?data:(\[[\s\S]*?\]), sideChannel/);
      if (!m) { if (page > 1) break; throw new Error("Google: results block not found"); }
      const d = JSON.parse(m[1]);
      const rows = d[0] || [];
      for (const j of rows) {
        const desc = (j[10] && j[10][1]) || "";
        const pay = desc.match(/US:\s*\$([\d,]+)\s*-\s*\$([\d,]+)/) || [];
        out.push(job("watch", j[7] || "Google", j[1], (j[9] || []).map((l) => (l[0] || "").replace(/, USA$/, "")).slice(0, 3).join(" · "),
          `https://www.google.com/about/careers/applications/jobs/results/${j[0]}`,
          j[12] && j[12][0] ? daysSince(j[12][0] * 1000) : null,
          { salary: pay[1] ? `$${Math.round(+pay[1].replace(/,/g, "") / 1000)}K - $${Math.round(+pay[2].replace(/,/g, "") / 1000)}K/yr` : "" }));
      }
      if (rows.length < (d[3] || 20) || page * (d[3] || 20) >= (d[2] || 0)) break;
    }
  }
  return out.filter((j) => isEarly(j.role) && (j.location || "").split(" · ").some(isUS));
}

async function fetchMicrosoft() {
  const out = [];
  let count = Infinity;
  for (let start = 0; start < Math.min(count, 200); start += 10) {
    if (start) await new Promise((r) => setTimeout(r, 500)); // it throttles rapid paging
    const res = await fetch(`https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=intern&location=United%20States&start=${start}`);
    if (!res.ok) { if (start > 0) break; throw new Error(`Microsoft: HTTP ${res.status}`); }
    let d;
    try { d = JSON.parse(await res.text()).data || {}; }
    catch { if (start > 0) break; throw new Error("Microsoft: throttled — will retry next hour"); }
    count = d.count ?? 0;
    const ps = d.positions || [];
    for (const p of ps) out.push(job("watch", "Microsoft", p.name, (p.standardizedLocations || p.locations || []).slice(0, 3).join(" · "),
      `https://apply.careers.microsoft.com/careers/job/${p.id}`, p.postedTs ? daysSince(p.postedTs * 1000) : null));
    if (!ps.length) break;
  }
  return out.filter((j) => isEarly(j.role) && isUS(j.location));
}

async function fetchApple() {
  const out = [];
  for (let page = 1; page <= 8; page++) {
    const res = await fetch(`https://jobs.apple.com/en-us/search?team=internships-STDNT-INTRN&sort=newest&page=${page}`);
    if (!res.ok) { if (page > 1) break; throw new Error(`Apple: HTTP ${res.status}`); }
    const m = (await res.text()).match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/);
    if (!m) throw new Error("Apple: hydration data not found");
    const s = JSON.parse(JSON.parse('"' + m[1] + '"')).loaderData?.search || {};
    const rows = s.searchResults || [];
    for (const x of rows) {
      const us = (x.locations || []).filter((l) => /USA/.test(l.countryID || "") || /United States/i.test(l.countryName || ""));
      if (!us.length) continue; // Apple's intern board is global — keep US roles
      out.push(job("watch", "Apple", x.postingTitle, us.map((l) => l.name).slice(0, 3).join(" · "),
        `https://jobs.apple.com/en-us/details/${x.positionId}/${x.transformedPostingTitle || ""}`,
        x.postDateInGMT ? daysSince(Date.parse(x.postDateInGMT)) : null));
    }
    if (rows.length < 20 || page * 20 >= (s.totalRecords || 0)) break;
  }
  return out;
}

async function fetchJibe(w) {
  // Jibe-hosted careers sites (SIG): slug = host, e.g. careers.sig.com
  const host = (w.slug || "").trim();
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://${host}/api/jobs?keywords=intern&page=${page}`);
    if (!res.ok) { if (page > 1) break; throw new Error(`${w.name || host}: HTTP ${res.status}`); }
    const d = await res.json();
    const rows = (d.jobs || []).map((x) => x.data || x);
    for (const x of rows) out.push(job("watch", w.name || host, x.title, [x.city, x.state].filter(Boolean).join(", "),
      `https://${host}/jobs/${x.slug || x.req_id}`, x.posted_date ? daysSince(Date.parse(x.posted_date)) : null));
    if (rows.length < 10 || out.length >= (d.totalCount || 0)) break;
  }
  return out.filter((j) => isEarly(j.role) && isUS(j.location));
}

async function fetchWatch(w) {
  const slug = (w.slug || "").trim().toLowerCase();
  if (w.ats === "meta") return fetchMeta(w);
  if (w.ats === "google") return fetchGoogle();
  if (w.ats === "microsoft") return fetchMicrosoft();
  if (w.ats === "apple") return fetchApple();
  if (w.ats === "jibe") return fetchJibe(w);
  if (!slug) return [];
  let jobs = [];
  if (w.ats === "lever") {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!res.ok) throw new Error(`Watchlist ${slug} (Lever): HTTP ${res.status}`);
    jobs = (await res.json()).map((j) => job("watch", w.name || slug, j.text, j.categories?.location || "", j.hostedUrl,
      j.createdAt ? daysSince(j.createdAt) : null));
  } else if (w.ats === "amazon") {
    // amazon.jobs public search — slug is the search query
    const q = w.slug || "software engineer intern";
    const res = await fetch(`https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q)}&result_limit=100&sort=recent`);
    if (!res.ok) throw new Error(`Watchlist Amazon: HTTP ${res.status}`);
    jobs = ((await res.json()).jobs || []).map((j) => job("watch", w.name || "Amazon", j.title,
      j.normalized_location || j.location || "", "https://www.amazon.jobs" + j.job_path, parseDaysOld(j.posted_date || "")));
  } else if (w.ats === "eightfold") {
    // Eightfold (Netflix & co) — slug is "host|domain", e.g. explore.jobs.netflix.net|netflix.com
    const [host, domain] = slug.split("|");
    const res = await fetch(`https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain || "")}&query=intern&num=100`);
    if (!res.ok) throw new Error(`Watchlist ${w.name || host} (Eightfold): HTTP ${res.status}`);
    jobs = ((await res.json()).positions || []).map((p) => job("watch", w.name || host, p.name,
      (p.location || "").split(",").slice(0, 2).join(", "), p.canonicalPositionUrl || `https://${host}/careers/job/${p.id}`,
      p.t_create ? daysSince(p.t_create * 1000) : null));
  } else {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (!res.ok) throw new Error(`Watchlist ${slug} (Greenhouse): HTTP ${res.status}`);
    jobs = ((await res.json()).jobs || []).map((j) => job("watch", w.name || slug, j.title, j.location?.name || "", j.absolute_url,
      // first_published is the real post date; updated_at moves on every edit
      daysSince(Date.parse(j.first_published || j.updated_at || "") || 0)));
  }
  // full boards are huge (Stripe: 500+) — keep the early-career, US slice
  return jobs.filter((j) => isEarly(j.role) && isUS(j.location));
}

// Big tech + top quant/trading firms, pulled straight from their own boards —
// postings show up here the moment they go live, days before the lists.
const DEFAULT_WATCHLIST = [
  { ats: "meta", slug: "meta", name: "Meta" },
  { ats: "google", slug: "google", name: "Google" },
  { ats: "microsoft", slug: "microsoft", name: "Microsoft" },
  { ats: "apple", slug: "apple", name: "Apple" },
  { ats: "amazon", slug: "software engineer intern", name: "Amazon" },
  { ats: "eightfold", slug: "explore.jobs.netflix.net|netflix.com", name: "Netflix" },
  { ats: "greenhouse", slug: "janestreet", name: "Jane Street" },
  { ats: "greenhouse", slug: "wehrtyou", name: "Hudson River Trading" },
  { ats: "greenhouse", slug: "jumptrading", name: "Jump Trading" },
  { ats: "greenhouse", slug: "imc", name: "IMC Trading" },
  { ats: "greenhouse", slug: "optiverus", name: "Optiver" },
  { ats: "greenhouse", slug: "drweng", name: "DRW" },
  { ats: "greenhouse", slug: "towerresearchcapital", name: "Tower Research Capital" },
  { ats: "greenhouse", slug: "fiveringsllc", name: "Five Rings" },
  { ats: "jibe", slug: "careers.sig.com", name: "Susquehanna (SIG)" },
  { ats: "greenhouse", slug: "akunacapital", name: "Akuna Capital" },
  { ats: "greenhouse", slug: "oldmissioncapital", name: "Old Mission" },
  { ats: "greenhouse", slug: "virtu", name: "Virtu Financial" },
  { ats: "greenhouse", slug: "point72", name: "Point72" },
  { ats: "greenhouse", slug: "flowtraders", name: "Flow Traders" },
  { ats: "greenhouse", slug: "anthropic", name: "Anthropic" },
  { ats: "greenhouse", slug: "databricks", name: "Databricks" },
  { ats: "greenhouse", slug: "stripe", name: "Stripe" },
  { ats: "lever", slug: "palantir", name: "Palantir" },
  { ats: "greenhouse", slug: "scaleai", name: "Scale AI" },
  { ats: "greenhouse", slug: "figma", name: "Figma" },
  { ats: "greenhouse", slug: "robinhood", name: "Robinhood" },
  { ats: "greenhouse", slug: "coinbase", name: "Coinbase" },
  { ats: "greenhouse", slug: "lyft", name: "Lyft" },
  { ats: "greenhouse", slug: "airbnb", name: "Airbnb" },
];

// Fetch every source, dedupe, and store the feed. Runs hourly from the
// background worker and on demand from the dashboard's Refresh button.
async function refreshAllSources() {
  const { linkedinQueries = [], watchlist = [] } = await chrome.storage.local.get(["linkedinQueries", "watchlist"]);
  const tasks = [
    ...GH_SOURCES.map((s) => ({ name: s.name, run: async () => {
      const res = await fetch(s.url);
      if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status}`);
      return parseReadme(await res.text(), s.id);
    } })),
    { name: "SimplifyJobs", run: fetchSimplify },
    ...linkedinQueries.filter((q) => q.keywords).map((q) => ({ name: `LinkedIn "${q.keywords}"`, run: () => fetchLinkedIn(q) })),
    ...watchlist.map((w) => ({ name: w.name || w.slug, run: () => fetchWatch(w) })),
  ];
  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  const errors = [], perSource = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") perSource[tasks[i].name] = r.value.length;
    else { errors.push(String(r.reason?.message || r.reason)); perSource[tasks[i].name] = "error"; }
  });
  // company boards first → their direct links win over list/aggregator copies
  const ordered = [...results.keys()].sort((a, b) => (tasks[b].name in watchIndex(watchlist)) - (tasks[a].name in watchIndex(watchlist)));
  const jobs = dedupeJobs(ordered.map((i) => (results[i].status === "fulfilled" ? results[i].value : [])));
  const feedCache = { fetchedAt: Date.now(), jobs, errors, perSource };
  await chrome.storage.local.set({ feedCache });
  return feedCache;
}

function watchIndex(watchlist) {
  const o = {};
  for (const w of watchlist) o[w.name || w.slug] = 1;
  return o;
}

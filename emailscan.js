// Autonomous Jobright import — runs inside Gmail / Outlook. When you open a
// Jobright email, it silently pulls every job link out of it and imports them
// into the feed + tracker. No paste, no OAuth, no server. (parser.js loads first
// and provides parseJobUrl / jobUrlId / normalizeUrl / jobLinksOnly / titleCase.)

if (!window.__jobApplierEmailScan) {
  window.__jobApplierEmailScan = true;

  const TITLE_RE = /(intern|co-?op|new grad|engineer|developer|analyst|scientist|manager|researcher|research|consultant|associate|trader|quant|designer|architect|programmer|swe|sde)/i;
  const processed = new Set(); // canonical job-ids already imported this page-load

  // Gmail wraps links in google.com/url?q=…; Outlook in safelinks; UPenn's
  // Proofpoint in urldefense.com/v3. parser.js's unwrapUrl handles all three.
  function unwrap(href) {
    if (!href) return "";
    try {
      const u = new URL(href, location.href);
      if (u.hostname.endsWith("google.com") && u.pathname === "/url")
        return unwrapUrl(u.searchParams.get("q") || u.searchParams.get("url") || href);
      return unwrapUrl(u.href);
    } catch { return /^https?:/.test(href) ? unwrapUrl(href) : ""; }
  }

  // does the link look like a real job posting? (accepts Jobright's own job links)
  function isJobLink(href) {
    return /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|workable\.com|jobvite\.com|bamboohr\.com|oraclecloud\.com|successfactors|taleo\.net|eightfold\.ai|jobright\.ai\/jobs|linkedin\.com\/jobs|\/job(s)?\/|\/careers?\/|\/position/i.test(href) &&
      !/unsubscribe|email-preferences|\.(png|jpg|gif|css)|facebook\.com|twitter\.com|x\.com|instagram|jobright\.ai\/(settings|profile|feedback|blog|home|dashboard|referral|about)/i.test(href);
  }

  // pull role/company from the email card around this link when the URL can't give them
  function fromBlock(a) {
    const block = a.closest("td, tr, div[style], table") || a.parentElement?.parentElement || a.parentElement;
    if (!block) return {};
    const lines = block.innerText.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 12);
    const role = lines.find((l) => TITLE_RE.test(l) && l.length < 110);
    const company = lines.find((l) => l !== role && /^[A-Z0-9]/.test(l) && l.length < 45 && !TITLE_RE.test(l) && !/apply|view|match|remote|hybrid|\$|📍|salary|save|new/i.test(l));
    return { role, company };
  }

  function extractJobs() {
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const href = unwrap(a.getAttribute("href"));
      if (!isJobLink(href)) continue;
      let { company, role } = parseJobUrl(href);
      const txt = a.textContent.trim();
      if (!role && TITLE_RE.test(txt)) role = txt;
      if (!role || !company) { const b = fromBlock(a); role = role || b.role; company = company || b.company; }
      out.push({ link: href, company: (company || "").slice(0, 60), role: (role || "Imported job").slice(0, 120) });
    }
    // dedupe by canonical id
    const seen = new Set();
    return out.filter((j) => { const k = jobUrlId(j.link); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  async function scan() {
    // only act on Jobright emails
    if (!/jobright/i.test(document.body.innerText.slice(0, 60000))) return;
    const jobs = extractJobs().filter((j) => !processed.has(jobUrlId(j.link)));
    if (!jobs.length) return;

    const { importedJobs = {}, tracker = {}, settings = {} } =
      await chrome.storage.local.get(["importedJobs", "tracker", "settings"]);
    let added = 0;
    for (const j of jobs) {
      processed.add(jobUrlId(j.link));
      const url = normalizeUrl(j.link);
      if (importedJobs[url]) continue;
      importedJobs[url] = { url, link: j.link, company: j.company, role: j.role, source: "imported", addedAt: Date.now(), daysOld: 0 };
      if (settings.autoImportTrack !== false && !tracker[url])
        tracker[url] = { url, title: j.role, company: j.company, status: "saved", source: "imported", notes: "", addedAt: Date.now(), updatedAt: Date.now() };
      added++;
    }
    if (added) { await chrome.storage.local.set({ importedJobs, tracker }); banner(added); }
  }

  function banner(n) {
    let b = document.getElementById("__japBanner");
    if (!b) {
      b = document.createElement("div");
      b.id = "__japBanner";
      b.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#1c2433;color:#fff;" +
        "font:13px/1.4 -apple-system,sans-serif;padding:12px 16px;border-radius:12px;" +
        "box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center";
      document.documentElement.appendChild(b);
    }
    b.innerHTML = `⚡ Imported <b style="margin:0 3px">${n}</b> job${n > 1 ? "s" : ""} from Jobright → your feed & tracker`;
    clearTimeout(b._t);
    b._t = setTimeout(() => b.remove(), 5000);
  }

  // Gmail/Outlook are SPAs that mutate constantly — debounce the scan.
  let t;
  const kick = () => { clearTimeout(t); t = setTimeout(scan, 1200); };
  new MutationObserver(kick).observe(document.body, { childList: true, subtree: true });
  setTimeout(scan, 1500);
}

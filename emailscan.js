// Autonomous Jobright import — runs inside Gmail / Outlook. When you open a
// Jobright email, it silently pulls every job out of it and imports them into
// the feed. No paste, no OAuth, no server. (parser.js loads first and provides
// htmlToImportText / parseImport / jobLinksOnly / jobUrlId / idIndex.)

if (!window.__jobApplierEmailScan) {
  window.__jobApplierEmailScan = true;

  const processed = new Set(); // job ids already imported this page-load

  // the open message body/bodies — Gmail: div.a3s; Outlook: the reading pane
  function messageRoots() {
    // Gmail keeps previously opened conversations in the DOM, hidden — only
    // parse what's on screen or their jobs get the wrong email date
    return [...document.querySelectorAll("div.a3s, [aria-label='Message body'], div[role='document']")]
      .filter((r) => r.offsetParent !== null);
  }

  // when the open email arrived (Gmail shows it as the .g3 timestamp's title)
  function emailedAt() {
    const t = [...document.querySelectorAll(".g3[title]")].find((e) => e.offsetParent !== null)?.getAttribute("title");
    const d = t ? Date.parse(t.replace(/\u202f/g, " ").replace(/ at /, " ")) : NaN;
    return Number.isFinite(d) ? d : Date.now();
  }

  async function scan() {
    // Parse the email exactly like the Gmail API sync does (parser.js
    // htmlToImportText → parseImport), so a Jobright card yields its real
    // company / role / location / salary instead of the whole card glued
    // into the title.
    const roots = messageRoots().filter((r) => /jobright/i.test(r.innerText.slice(0, 60000)));
    if (!roots.length) return;
    const when = emailedAt();
    const jobs = jobLinksOnly(parseImport(roots.map((r) => htmlToImportText(r.innerHTML)).join("\n")))
      .filter((j) => j.role && j.role !== "Imported job" && !processed.has(jobUrlId(j.link)));
    if (!jobs.length) return;

    // feed only — tracking is the user's call (＋ track / apply flow), same as
    // the Gmail API sync. Dedupe on the job id, not the raw URL, so the same
    // posting reached through a different link form isn't imported twice.
    const { importedJobs = {} } = await chrome.storage.local.get("importedJobs");
    const known = idIndex(importedJobs);
    let added = 0, fixed = 0;
    for (const j of jobs) {
      const id = jobUrlId(j.link);
      processed.add(id);
      const postedAt = when - (j.agoMin || 0) * 60000;
      const prevKey = known.get(id);
      const prev = prevKey && importedJobs[prevKey];
      if (prev) {
        // an earlier bad parse of this job → replace it with the good one
        if (isMangledImport(prev)) {
          Object.assign(prev, { company: j.company, role: j.role, location: j.location || "", salary: j.salary || "" });
          fixed++;
        }
        if (!prev.location && j.location) prev.location = j.location;
        if (!prev.salary && j.salary) prev.salary = j.salary;
        if (!prev.postedAt || postedAt < prev.postedAt) { prev.postedAt = postedAt; prev.emailedAt = when; }
        continue;
      }
      const url = normalizeUrl(j.link);
      importedJobs[url] = {
        url, link: j.link, company: j.company, role: j.role,
        location: j.location || "", salary: j.salary || "",
        source: "imported", addedAt: Date.now(), postedAt, emailedAt: when,
      };
      known.set(id, url);
      added++;
    }
    if (added || fixed) { await chrome.storage.local.set({ importedJobs }); banner(added, fixed); }
  }

  function banner(n, fixed = 0) {
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
    b.innerHTML = `⚡ Imported <b style="margin:0 3px">${n}</b> job${n === 1 ? "" : "s"} from Jobright → your feed` +
      (fixed ? ` · fixed ${fixed}` : "");
    clearTimeout(b._t);
    b._t = setTimeout(() => b.remove(), 5000);
  }

  // Gmail/Outlook are SPAs that mutate constantly — debounce the scan.
  let t;
  const kick = () => { clearTimeout(t); t = setTimeout(scan, 1200); };
  new MutationObserver(kick).observe(document.body, { childList: true, subtree: true });
  setTimeout(scan, 1500);
}

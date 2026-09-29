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
    const here = location.hash;
    // data-jap-scanned = the open email is fully handled (lets automation and
    // debugging confirm nothing was skipped before moving to the next one)
    const done = (what) => { if (location.hash === here) document.documentElement.dataset.japScanned = here + "|" + what; };
    const roots = messageRoots().filter((r) => /jobright/i.test(r.innerText.slice(0, 60000)));
    if (!roots.length) return done("no-jobright");
    const when = emailedAt();
    const jobs = jobLinksOnly(parseImport(roots.map((r) => htmlToImportText(r.innerHTML)).join("\n")))
      .filter((j) => j.role && j.role !== "Imported job" && !processed.has(jobUrlId(j.link)));
    if (!jobs.length) return done("0");

    // feed only — tracking is the user's call. The background worker does the
    // write (one serialized writer), so several Gmail tabs importing at once
    // can't overwrite each other's jobs.
    for (const j of jobs) processed.add(jobUrlId(j.link));
    // the worker can be asleep or busy (hourly feed refresh) — retry with
    // backoff instead of dropping this email's jobs
    const payload = { type: "IMPORT_JOBS", jobs: jobs.map((j) => ({ ...j, emailedAt: when })) };
    let res = null;
    for (let attempt = 0; attempt < 6 && !res?.ok; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      res = await chrome.runtime.sendMessage(payload).catch(() => null);
    }
    if (res?.ok && (res.added || res.fixed)) banner(res.added, res.fixed);
    if (res?.ok) done(String(res.added || 0));
    else for (const j of jobs) processed.delete(jobUrlId(j.link)); // next scan tries again
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

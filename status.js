// Local health page: open http://127.0.0.1:<any port>/__job-applier-status
// to see what the extension is actually running and holding — source counts,
// errors, grades, imports — and trigger a refresh. Read-only view of this
// extension's own storage; only ever injected on that localhost path.

(async () => {
  const out = document.getElementById("jap-status") || document.body.appendChild(document.createElement("pre"));
  out.id = "jap-status";
  const bgPing = await chrome.runtime.sendMessage({ type: "PING" }).catch(() => null);

  if (/[?&]refresh=1/.test(location.search)) {
    out.textContent = "refreshing feed…";
    await chrome.runtime.sendMessage({ type: "REFRESH_FEED" }).catch(() => null);
  }

  const st = await chrome.storage.local.get(["feedCache", "importedJobs", "tracker", "profile", "watchlist",
    "lastGmailSync", "gmailRefresh", "feedFilters", "loadedCodeFingerprint"]);
  const fc = st.feedCache || { jobs: [], errors: [] };
  const imported = Object.values(st.importedJobs || {});
  const tracker = Object.values(st.tracker || {});
  const history = { responded: new Set(), rejected: new Set() };
  const imp = [...imported.filter((j) => !isMangledImport(j)).map((j) => ({ ...j, source: "imported",
    category: j.category || categorize(j.role, ""),
    daysOld: j.postedAt ? Math.floor((Date.now() - j.postedAt) / 864e5) : 0 }))];
  // same merge the dashboard does: imports first, then the fetched feed
  const scored = dedupeJobs([imp, fc.jobs]).map((j) => ({ ...j, _fit: scoreJob(j, st.profile, history) }))
    .sort((a, b) => b._fit.score - a._fit.score);
  const gradeDist = {};
  for (const j of scored) gradeDist[j._fit.grade] = (gradeDist[j._fit.grade] || 0) + 1;
  const bySrc = {};
  for (const j of scored) bySrc[j.source] = (bySrc[j.source] || 0) + 1;
  const ids = new Map();
  let dupes = 0;
  for (const j of scored) { const k = j.link ? jobUrlId(j.link) : ""; if (k && ids.has(k)) dupes++; else ids.set(k, 1); }

  const status = {
    backgroundVersion: bgPing?.v ?? "unreachable",
    feed: { fetchedMinAgo: fc.fetchedAt ? Math.round((Date.now() - fc.fetchedAt) / 60000) : null, jobs: fc.jobs.length,
      perSource: fc.perSource || null, errors: fc.errors },
    imports: { total: imported.length, mangled: imported.filter(isMangledImport).length,
      mangledSamples: imported.filter(isMangledImport).slice(0, 10).map((j) => `${j.company} | ${j.role}`) },
    tracker: { total: tracker.length, autoSavedImports: tracker.filter((e) => e.source === "imported" && e.status === "saved").length },
    gmail: { connected: !!st.gmailRefresh, lastSyncMinAgo: st.lastGmailSync ? Math.round((Date.now() - st.lastGmailSync) / 60000) : null },
    watchlist: (st.watchlist || []).map((w) => w.name || w.slug),
    merged: { total: scored.length, bySource: bySrc, duplicateIds: dupes, gradeDist,
      aMinusAndUp: scored.filter((j) => ["S+", "S", "A+", "A", "A-"].includes(j._fit.grade)).length },
    minGradeFilter: st.feedFilters?.minGrade ?? "(default A-)",
    top: scored.slice(0, 40).map((j) => `${j._fit.grade.padEnd(2)} ${String(j._fit.score).padStart(3)}  ${j.company} — ${cleanRole(j.role, j.location)}  [${j.location || "?"}] ${j.daysOld ?? "?"}d ${j.source}`),
    sampleByCompany: ["Microsoft", "Meta", "Google", "Apple", "Jane Street", "Citadel", "Hudson River Trading", "Optiver"]
      .map((c) => { const j = scored.find((x) => companyTier(x.company) && x.company.toLowerCase().startsWith(c.toLowerCase()));
        return j ? `${c}: ${j._fit.grade} (${j._fit.score}) ${j.role}` : `${c}: none in feed`; }),
    oddities: scored.filter((j) => !j.company || !j.role || j.role.length > 110 || /jobright/i.test(j.company)).slice(0, 10)
      .map((j) => `${j.source} | ${j.company} | ${j.role}`),
  };
  out.textContent = JSON.stringify(status, null, 2);
  document.title = "job-applier status ✓";
})().catch((e) => {
  (document.getElementById("jap-status") || document.body).textContent = "status error: " + (e.stack || e);
});

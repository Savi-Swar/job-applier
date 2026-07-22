const statusEl = document.getElementById("status");
const fillBtn = document.getElementById("fill");

// ---- resume picker ----
(async () => {
  const { resumes = [], activeResumeId } = await chrome.storage.local.get([
    "resumes", "activeResumeId",
  ]);
  if (resumes.length < 2) return; // nothing to pick with 0/1 resumes
  const row = document.getElementById("resumeRow");
  const sel = document.getElementById("resumePick");
  row.style.display = "";
  sel.innerHTML = resumes
    .map((r) => `<option value="${r.id}" ${r.id === activeResumeId ? "selected" : ""}>${escapeHtml(r.name)}${r.usedFor ? " — " + escapeHtml(r.usedFor) : ""}</option>`)
    .join("");
  sel.addEventListener("change", () =>
    chrome.storage.local.set({ activeResumeId: sel.value })
  );
})();

// ---- auto-fill toggle ----
(async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const box = document.getElementById("autoFill");
  box.checked = settings.autoFill !== false; // on by default
  box.addEventListener("change", async () => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    settings.autoFill = box.checked;
    await chrome.storage.local.set({ settings });
  });
})();

// ---- ensure content script is present in the active tab, return tab ----
async function readyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let alive = false;
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    alive = !!(pong && pong.ok);
  } catch (_) { /* not injected yet */ }
  if (!alive) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
  return tab;
}

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("openDashboard").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// ---- tracker buttons (work without injecting the content script) ----

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) {
      if (k.startsWith("utm_") || k === "ref" || k === "src" || k === "source")
        url.searchParams.delete(k);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

function guessFromTab(tab) {
  const t = tab.title || "";
  let m = t.match(/Job Application for (.+?) at (.+)/i); // Greenhouse
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  m = t.match(/^(.+?)\s*@\s*(.+)$/); // Ashby
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  m = t.match(/^(.+?)\s*[-–]\s*(.+)$/); // Lever-style "Company - Role"
  if (m && tab.url.includes("lever.co")) return { title: m[2].trim(), company: m[1].trim() };
  let host = "";
  try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
  return { title: t.slice(0, 120), company: host };
}

async function trackTab(status) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = normalizeUrl(tab.url);
  const { tracker = {} } = await chrome.storage.local.get("tracker");
  const prev = tracker[url] || {};
  const guess = guessFromTab(tab);
  tracker[url] = {
    url,
    title: prev.title || guess.title,
    company: prev.company || guess.company,
    status, // explicit button click always wins
    appliedAt: status === "applied" ? prev.appliedAt || Date.now() : prev.appliedAt || null,
    notes: prev.notes || "",
    addedAt: prev.addedAt || Date.now(),
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ tracker });
  return tracker[url];
}

// ---- analyze posting: required skills, nice-to-haves, ATS buzzwords ----

document.getElementById("analyze").addEventListener("click", async () => {
  const btn = document.getElementById("analyze");
  const box = document.getElementById("analysis");
  btn.disabled = true;
  btn.textContent = "Analyzing…";
  try {
    const tab = await readyTab();
    const page = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_TEXT" });
    if (!page?.ok) throw new Error("Couldn't read this page.");
    const res = await chrome.runtime.sendMessage({ type: "LLM_ANALYZE", jobText: page.text });
    if (!res.ok) throw new Error(res.error);
    const a = res.data;

    const chips = (list, cls) =>
      (list || []).map((s) => `<span class="skill ${cls}">${escapeHtml(s)}</span>`).join("");
    box.innerHTML =
      (a.summary ? `<p class="muted" style="margin:8px 0 0">${escapeHtml(a.summary)}</p>` : "") +
      (a.requiredSkills?.length ? `<h3>Required skills</h3>${chips(a.requiredSkills, "")}` : "") +
      (a.niceToHave?.length ? `<h3>Nice to have</h3>${chips(a.niceToHave, "nice")}` : "") +
      (a.buzzwords?.length ? `<h3>Resume buzzwords (use these words)</h3>${chips(a.buzzwords, "buzz")}` : "") +
      (a.salary ? `<h3>Salary</h3>${escapeHtml(a.salary)}` : "");

    // persist onto the tracker entry (auto-saves the job if not tracked yet)
    const url = normalizeUrl(tab.url);
    const { tracker = {} } = await chrome.storage.local.get("tracker");
    const prev = tracker[url] || {};
    const guess = guessFromTab(tab);
    tracker[url] = {
      url,
      title: prev.title || a.role || guess.title,
      company: prev.company || a.company || guess.company,
      status: prev.status || "saved",
      notes: prev.notes || "",
      salary: prev.salary || a.salary || "",
      skills: a.requiredSkills || [],
      buzzwords: a.buzzwords || [],
      addedAt: prev.addedAt || Date.now(),
      updatedAt: Date.now(),
      ...(prev.appliedAt ? { appliedAt: prev.appliedAt } : {}),
      ...(prev.referral ? { referral: prev.referral, referrer: prev.referrer } : {}),
      ...(prev.nextStep ? { nextStep: prev.nextStep } : {}),
    };
    await chrome.storage.local.set({ tracker });
  } catch (err) {
    box.innerHTML = `<p class="err">${escapeHtml(String(err.message || err))}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Analyze posting — skills & buzzwords";
  }
});

document.getElementById("markApplied").addEventListener("click", async () => {
  const e = await trackTab("applied");
  statusEl.innerHTML = `<span class="ok">Tracked as applied: ${escapeHtml(e.company)}</span>`;
});

document.getElementById("trackOnly").addEventListener("click", async () => {
  const e = await trackTab("saved");
  statusEl.innerHTML = `<span class="ok">Saved to tracker: ${escapeHtml(e.company)}</span>`;
});

fillBtn.addEventListener("click", async () => {
  fillBtn.disabled = true;
  statusEl.textContent = "Filling…";
  try {
    const tab = await readyTab();
    const useAI = document.getElementById("useAI").checked;
    const res = await chrome.tabs.sendMessage(tab.id, { type: "FILL_PAGE", useAI });
    if (!res.ok) throw new Error(res.error);

    const r = res.report;
    const lines = [];
    lines.push(`<span class="ok">Filled from profile: ${r.filled.length}</span>`);
    if (r.resume) lines.push(`<span class="ok">Resume attached</span>`);
    if (r.ai.length) lines.push(`<span class="warn">AI drafts (review!): ${r.ai.length}</span>`);
    if (r.needsClick && r.needsClick.length)
      lines.push(
        `<span class="warn">🔎 Search fields pre-typed — just click the highlighted option:</span><br>` +
          r.needsClick.map((s) => "• " + escapeHtml(s.slice(0, 70))).join("<br>")
      );
    if (r.skipped.length)
      lines.push(
        `<span class="warn">Left for you: ${r.skipped.length}</span><br>` +
          r.skipped.map((s) => "• " + escapeHtml(s.slice(0, 70))).join("<br>")
      );
    if (!r.filled.length && !r.ai.length && !r.resume)
      lines.push(`<span class="warn">No fillable fields found on this page.</span>`);
    statusEl.innerHTML = lines.join("<br>");
  } catch (err) {
    statusEl.innerHTML = `<span class="err">${escapeHtml(String(err.message || err))}</span>`;
  } finally {
    fillBtn.disabled = false;
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Structured profile form modeled on the standard ATS question bank
// (Greenhouse / Lever / Workday / iCIMS). Saved as a nested `profile` object;
// content.js maps each site's field wording onto these answers.

const YESNO = ["", "Yes", "No"];

const SECTIONS = [
  {
    title: "About you",
    hint: "The basics every single application asks for.",
    fields: [
      { k: "personal.firstName", l: "First name" },
      { k: "personal.lastName", l: "Last name" },
      { k: "personal.preferredName", l: "Preferred name", ph: "optional" },
      { k: "personal.email", l: "Email" },
      { k: "personal.phone", l: "Phone", ph: "+1 555 123 4567" },
      { k: "personal.pronouns", l: "Pronouns", ph: "optional" },
    ],
  },
  {
    title: "Mailing address",
    hint: "Workday and iCIMS almost always want a full address; Greenhouse usually just city.",
    fields: [
      { k: "personal.address.street", l: "Street address", full: true },
      { k: "personal.address.city", l: "City" },
      { k: "personal.address.state", l: "State / province" },
      { k: "personal.address.zip", l: "ZIP / postal code" },
      { k: "personal.address.country", l: "Country" },
    ],
  },
  {
    title: "Links",
    fields: [
      { k: "links.linkedin", l: "LinkedIn URL" },
      { k: "links.github", l: "GitHub URL" },
      { k: "links.website", l: "Portfolio / website", ph: "optional" },
    ],
  },
  {
    title: "Education",
    hint: "If a form only has one education slot, this one is used.",
    fields: [
      { k: "education.school", l: "School / university" },
      { k: "education.degree", l: "Degree", type: "select", opts: ["", "High school", "Associate's", "Bachelor's", "Master's", "MBA", "PhD", "Other"] },
      { k: "education.major", l: "Major / field of study" },
      { k: "education.gpa", l: "GPA", ph: "optional" },
      { k: "education.startYear", l: "Start year", ph: "2023" },
      { k: "education.gradYear", l: "Graduation year", ph: "2027" },
    ],
  },
  {
    title: "Education — second degree (optional)",
    hint: "Dual degree? On forms, click their \"Add education\" button first — the autofill then puts degree #1 in the first block and this one in the second.",
    fields: [
      { k: "education2.school", l: "School / university" },
      { k: "education2.degree", l: "Degree", type: "select", opts: ["", "High school", "Associate's", "Bachelor's", "Master's", "MBA", "PhD", "Other"] },
      { k: "education2.major", l: "Major / field of study" },
      { k: "education2.gpa", l: "GPA", ph: "optional" },
      { k: "education2.startYear", l: "Start year" },
      { k: "education2.gradYear", l: "Graduation year" },
    ],
  },
  {
    title: "Experience",
    fields: [
      { k: "work.company", l: "Current / most recent employer" },
      { k: "work.title", l: "Current / most recent title" },
      { k: "work.yearsExperience", l: "Years of experience", type: "select", opts: ["", "0-1", "1-2", "2-3", "3-5", "5+"] },
      { k: "skillsText", l: "Your skills (comma-separated)", full: true,
        ph: "Python, C++, React, ML, signal processing, SQL… — powers the feed's match scores and per-job fit analysis" },
    ],
  },
  {
    title: "Work authorization",
    hint: "Asked on virtually every US application, usually as a Yes/No pair.",
    fields: [
      { k: "authorization.authorizedUS", l: "Legally authorized to work in the US?", type: "select", opts: YESNO },
      { k: "authorization.needsSponsorship", l: "Will you need visa sponsorship?", type: "select", opts: YESNO },
      { k: "authorization.visaStatus", l: "Visa / immigration status", ph: "e.g. F-1 (CPT/OPT eligible)", full: true },
    ],
  },
  {
    title: "Logistics & standard screeners",
    hint: "The yes/no wall at the end of most applications. Autofill answers these (including radio buttons) so you don't click the same ten circles every time.",
    fields: [
      { k: "logistics.startDate", l: "Earliest start date", ph: "Immediately / June 2027" },
      { k: "logistics.noticePeriod", l: "Notice period", ph: "None" },
      { k: "logistics.salary", l: "Salary expectation", ph: "leave blank to skip" },
      { k: "logistics.howHeard", l: "\"How did you hear about us?\"", ph: "Company careers page" },
      { k: "logistics.relocate", l: "Willing to relocate?", type: "select", opts: YESNO },
      { k: "logistics.over18", l: "Are you 18 or older?", type: "select", opts: YESNO, def: "Yes" },
      { k: "logistics.backgroundCheck", l: "Consent to a background check?", type: "select", opts: YESNO, def: "Yes" },
      { k: "logistics.previouslyEmployed", l: "Previously employed by the company?", type: "select", opts: YESNO, def: "No" },
      { k: "logistics.relativesAtCompany", l: "Relatives working at the company?", type: "select", opts: YESNO, def: "No" },
      { k: "logistics.clearance", l: "Active security clearance?", type: "select", opts: YESNO, def: "No" },
      { k: "logistics.nonCompete", l: "Bound by a non-compete?", type: "select", opts: YESNO, def: "No" },
    ],
  },
  {
    title: "Demographics — voluntary EEO (optional)",
    hint: "US applications include voluntary self-identification questions. Set your own answers, or leave blank — anything blank auto-fills \"Decline to self-identify\" so these required sections don't block submitting. Never used for anything else.",
    fields: [
      { k: "demographics.gender", l: "Gender identity", type: "select", opts: ["", "Decline to self-identify", "Male", "Female", "Non-binary"] },
      { k: "demographics.raceEthnicity", l: "Race / ethnicity", type: "select", opts: ["", "Decline to self-identify", "Asian", "Black or African American", "Hispanic or Latino", "White", "Native American or Alaska Native", "Native Hawaiian or Other Pacific Islander", "Two or More Races"] },
      { k: "demographics.hispanicLatino", l: "Hispanic / Latino?", type: "select", opts: ["", "Decline to self-identify", "Yes", "No"] },
      { k: "demographics.veteran", l: "Veteran status", type: "select", opts: ["", "Decline to self-identify", "I am not a protected veteran", "I identify as one or more of the classifications of a protected veteran"] },
      { k: "demographics.disability", l: "Disability status", type: "select", opts: ["", "Decline to self-identify", "No, I do not have a disability", "Yes, I have a disability, or have had one in the past"] },
      { k: "demographics.transgender", l: "Do you identify as transgender?", type: "select", opts: ["", "Decline to self-identify", "No", "Yes"] },
      { k: "demographics.sexualOrientation", l: "Sexual orientation", type: "select", opts: ["", "Decline to self-identify", "Heterosexual", "Gay", "Lesbian", "Bisexual", "Queer"] },
    ],
  },
  {
    title: "Material for AI answers",
    hint: "Not typed into forms directly — this is what Gemini draws on for \"why us?\" and project questions. Real numbers, real stack, no fluff.",
    fields: [
      { k: "highlightsText", l: "Your highlights (one per line)", type: "textarea", full: true,
        ph: "Built X using Y, results Z…\nResearch project on …\nHackathon win …" },
      { k: "masterResume", l: "Master resume (paste the full text)", type: "textarea", full: true,
        ph: "Paste your complete resume as plain text. Powers per-job resume tailoring and the brutal resume review — the AI only ever uses what's actually in here." },
      { k: "tone", l: "Tone notes for the AI", ph: "Direct and specific, no corporate buzzwords", full: true },
    ],
  },
];

// ---------- path helpers ----------

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] || {};
  o[keys.at(-1)] = value;
}

// ---------- render ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

document.getElementById("form").innerHTML = SECTIONS.map((sec) => `
  <div class="card">
    <h2>${esc(sec.title)}</h2>
    ${sec.hint ? `<p class="hint">${esc(sec.hint)}</p>` : `<div style="height:10px"></div>`}
    <div class="grid">
      ${sec.fields.map((f) => `
        <div class="field ${f.full ? "full" : ""}">
          <label>${esc(f.l)}</label>
          ${f.type === "select"
            ? `<select data-k="${f.k}">${f.opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`
            : f.type === "textarea"
            ? `<textarea data-k="${f.k}" placeholder="${esc(f.ph || "")}"></textarea>`
            : `<input data-k="${f.k}" placeholder="${esc(f.ph || "")}">`}
        </div>`).join("")}
    </div>
  </div>`).join("");

// ---------- load (with migration from the old flat-ish profile shape) ----------

function migrated(p) {
  if (!p) return {};
  const m = JSON.parse(JSON.stringify(p));
  m.personal = m.personal || {};
  m.personal.address = m.personal.address || {};
  if (m.personal.location && !m.personal.address.city) m.personal.address.city = m.personal.location;
  m.work = m.work || m.current || {};
  m.authorization = m.authorization || {};
  m.logistics = m.logistics || {};
  if (m.salaryExpectation && !m.logistics.salary) m.logistics.salary = m.salaryExpectation;
  if (m.availability && !m.logistics.startDate) m.logistics.startDate = m.availability;
  if (m.source && !m.logistics.howHeard) m.logistics.howHeard = m.source;
  // the old answers array carried work-auth answers; lift them into structured fields
  for (const a of m.answers || []) {
    const keys = (a.match || []).join(" ");
    if (/authorized/.test(keys) && !m.authorization.authorizedUS) m.authorization.authorizedUS = a.value;
    if (/sponsorship/.test(keys) && !m.authorization.needsSponsorship) m.authorization.needsSponsorship = a.value;
    if (/relocat/.test(keys) && !m.logistics.relocate) m.logistics.relocate = a.value;
  }
  m.answers = (m.answers || []).filter(
    (a) => !/authorized|sponsorship|relocat/.test((a.match || []).join(" "))
  );
  if (Array.isArray(m.highlights)) m.highlightsText = m.highlights.join("\n");
  if (Array.isArray(m.skills)) m.skillsText = m.skills.join(", ");
  return m;
}

async function load() {
  const { apiKey, profile, theme } = await chrome.storage.local.get(["apiKey", "profile", "theme"]);
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // Personal-use default key (also hardcoded in background.js as the fallback).
  document.getElementById("apiKey").value =
    apiKey || "";

  // no saved profile yet → pre-fill the form from the resume seed
  const p = migrated(profile || (typeof DEFAULT_PROFILE !== "undefined" ? DEFAULT_PROFILE : null));
  for (const el of document.querySelectorAll("[data-k]")) {
    const f = SECTIONS.flatMap((s) => s.fields).find((x) => x.k === el.dataset.k);
    const v = getPath(p, el.dataset.k);
    el.value = v != null && v !== "" ? v : (f?.def ?? "");
  }
  document.getElementById("answers").value = JSON.stringify(p.answers || [], null, 2);
  document.getElementById("expJson").value = JSON.stringify(
    p.experience || (typeof DEFAULT_PROFILE !== "undefined" ? DEFAULT_PROFILE.experience : []), null, 2);
}
load();

// ---------- unsaved-changes guard ----------

let dirty = false;
document.addEventListener("input", (e) => {
  if (e.target.matches("[data-k], #apiKey, #answers, #expJson")) dirty = true;
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault(); // browser shows "leave site?" prompt
});

// ---------- save ----------

document.getElementById("save").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  let answers, experience;
  try {
    answers = JSON.parse(document.getElementById("answers").value || "[]");
  } catch (err) {
    statusEl.innerHTML = `<span class="err">Custom answers JSON is invalid: ${esc(err.message)}</span>`;
    return;
  }
  try {
    experience = JSON.parse(document.getElementById("expJson").value || "[]");
    if (!Array.isArray(experience)) throw new Error("must be an array of entries");
  } catch (err) {
    statusEl.innerHTML = `<span class="err">Experience JSON is invalid: ${esc(err.message)}</span>`;
    return;
  }
  const { profile: existing } = await chrome.storage.local.get("profile");
  const profile = migrated(existing); // keep anything the form doesn't cover
  for (const el of document.querySelectorAll("[data-k]"))
    setPath(profile, el.dataset.k, el.value.trim());
  profile.answers = answers;
  profile.experience = experience;
  profile.highlights = (profile.highlightsText || "").split("\n").map((s) => s.trim()).filter(Boolean);
  profile.skills = (profile.skillsText || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  delete profile.current; delete profile.salaryExpectation; delete profile.availability; delete profile.source;

  await chrome.storage.local.set({
    apiKey: document.getElementById("apiKey").value.trim(),
    profile,
    profileConfirmed: true, // powers the Today-tab setup checklist
  });
  dirty = false;
  statusEl.innerHTML = `<span class="ok">Saved ✓</span>`;
  setTimeout(() => (statusEl.textContent = ""), 2500);
});

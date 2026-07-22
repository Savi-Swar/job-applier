// Content script: scans the page for form fields, fills them from the profile,
// and asks the background worker to draft answers for free-text questions.
// Injected on known job boards via manifest, and on any other page via the popup.

if (!window.__jobApplierLoaded) {
  window.__jobApplierLoaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FILL_PAGE") {
      fillPage(msg.useAI)
        .then((report) => sendResponse({ ok: true, report }))
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
      return true;
    }
    if (msg.type === "PING") {
      sendResponse({ ok: true });
    }
    if (msg.type === "GET_PAGE_TEXT") {
      sendResponse({ ok: true, text: pageJobText(), title: document.title, url: location.href });
    }
  });

  // ---------- field matching ----------

  // "legalNameSection_firstName" → "legal name section first name" — lets the
  // keyword rules match Workday's data-automation-id / camelCase attributes.
  function deCamel(s) {
    return (s || "").replace(/[_\-\[\]\.]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }

  // Everything we can learn about a field, lowercased, for keyword matching.
  function fieldText(el) {
    const bits = [];
    if (el.labels) for (const l of el.labels) bits.push(l.textContent);
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) bits.push(lab.textContent);
    }
    bits.push(
      el.getAttribute("aria-label") || "",
      el.getAttribute("placeholder") || "",
      deCamel(el.name),
      deCamel(el.id),
      deCamel(el.getAttribute("data-automation-id")),
      el.getAttribute("autocomplete") || ""
    );
    // note: deliberately NOT 'label' here — for a radio that would grab its own
    // tiny "Yes" label instead of the fieldset holding the actual question
    // (own-label text is already covered by el.labels above)
    const wrap = el.closest(
      'fieldset, .field, .application-question, [class*="question"], [class*="field"], [class*="Field"]'
    );
    if (wrap) bits.push(wrap.textContent.slice(0, 300));
    return bits.join(" | ").toLowerCase();
  }

  // The human-readable question for a field (for AI prompts and reporting).
  function fieldQuestion(el) {
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.textContent.trim();
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const wrap = el.closest('.field, .application-question, [class*="question"], fieldset');
    if (wrap) {
      const q = wrap.querySelector("label, legend, h3, h4, strong");
      if (q) return q.textContent.trim();
    }
    return el.getAttribute("placeholder") || el.name || "";
  }

  function matches(text, keys) {
    return keys.some((k) => text.includes(k));
  }

  // A radio/checkbox's OWN label ("Yes"), as opposed to the group's question
  // text ("Are you authorized…?") which fieldText() captures.
  function ownLabel(el) {
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    const l = el.closest("label");
    if (l) return l.textContent.trim();
    return (el.getAttribute("value") || "").trim();
  }

  // Ordered rules: first match wins. `not` guards against false positives
  // (e.g. "last name" also contains "name"). Reads the structured profile from
  // the options form; old flat-profile keys kept as fallbacks.
  function buildRules(p) {
    const pi = p.personal || {};
    const addr = pi.address || {};
    const links = p.links || {};
    const edu = p.education || {};
    const edu2 = p.education2 || {};
    const work = p.work || p.current || {};
    const exps = Array.isArray(p.experience) && p.experience.length ? p.experience : null;
    const auth = p.authorization || {};
    const lg = p.logistics || {};
    const city = addr.city || pi.location;
    // Dual degree: array values fill by occurrence — the 1st matching field on
    // the page gets [0], the 2nd (a repeated education block) gets [1].
    const pair = (a, b) => (edu2.school ? [a, b] : a);

    // phone: strip a leading "+<code> " so the national number stays valid when
    // the country code lives in its own field ("+1 445-214-2585" → "445-214-2585")
    const phoneNational = (pi.phone || "").replace(/^\+\d{1,3}[\s-]*/, "").trim();
    // country → common "(+code)" label variants so the phone-code menu matches
    const CC = { "united states": "+1", "usa": "+1", "us": "+1", "canada": "+1", "india": "+91",
      "united kingdom": "+44", "uk": "+44", "singapore": "+65", "australia": "+61", "germany": "+49" };
    const cc = (country) => {
      const code = CC[(country || "").toLowerCase()];
      return code ? `${country} (${code})` : null;
    };

    // demographics: build a candidate list = [your answer] then every common
    // "decline" wording, so a required EEO field always gets *something* valid.
    const d = p.demographics || {};
    const DECLINE = [
      "Decline to self-identify", "Decline to self identify", "I don't wish to answer",
      "I do not wish to answer", "I prefer not to answer", "Prefer not to answer",
      "Prefer not to say", "I don't wish to disclose", "Choose not to disclose",
      "I prefer not to disclose", "Do not wish to disclose", "Prefer not to disclose",
    ];
    const dem = (label, keys, val, extra = {}) => {
      const decline = d.declineUnset === false && !(val && val.trim()) ? [] : DECLINE;
      const candidates = [...(val && val.trim() && !/decline|prefer not/i.test(val) ? [val] : []), ...decline];
      return { keys, candidates, demLabel: label, ...extra };
    };
    return [
      { keys: ["first name", "first_name", "given name", "given-name"], value: pi.firstName },
      { keys: ["last name", "last_name", "family name", "family-name", "surname"], value: pi.lastName },
      { keys: ["full name", "your name", "full_name", "systemfield name"], not: ["first", "last", "preferred", "if different", "legal name"], value: [pi.firstName, pi.lastName].filter(Boolean).join(" ") },
      { keys: ["preferred name"], value: pi.preferredName || pi.firstName },
      { keys: ["email", "e-mail"], not: ["confirm"], value: pi.email },
      { keys: ["confirm email", "confirm e-mail", "verify email"], value: pi.email },
      // Country phone code is its OWN field (e.g. "United States (+1)"). Force it
      // to your country even if the site geo-defaulted somewhere else (Singapore).
      { keys: ["country phone code", "phone country code", "phone country", "dial code", "country code", "phone code"], candidates: [addr.country, cc(addr.country)].filter(Boolean), force: true },
      // Phone number field wants the NATIONAL number — never the "+1" prefix (that
      // fails validation when the country code is a separate field). And never the
      // Extension / Device-Type / Country-code fields.
      { keys: ["phone number", "mobile number", "cell phone", "telephone", "phone", "mobile"], not: ["extension", "device", "type", "country", "code", "confirm", "work phone"], value: phoneNational },
      { keys: ["phone extension", "extension"], value: "" }, // explicit no-fill
      { keys: ["linkedin"], value: links.linkedin },
      { keys: ["github", "git hub"], value: links.github },
      { keys: ["portfolio", "personal website", "personal site", "website", "url"], not: ["linkedin", "github", "company"], value: links.website },
      // address block — specific pieces before the generic "address"
      { keys: ["street address", "address line 1", "address line1", "address 1", "address1", "street"], value: addr.street },
      { keys: ["zip", "postal"], value: addr.zip },
      { keys: ["state", "province", "region"], not: ["united states", "statement", "estate"], value: addr.state },
      { keys: ["country"], not: ["country code"], value: addr.country },
      { keys: ["city", "town"], not: ["capacity", "electricity", "work experience", "employment", "employer"], value: city },
      { keys: ["current location", "location (city", "location"], not: ["relocat", "office location", "work location", "work experience", "employment", "employer", "job location"], value: [city, addr.state].filter(Boolean).join(", ") || city },
      { keys: ["address"], not: ["email", "work experience", "employer"], value: [addr.street, city, addr.state, addr.zip].filter(Boolean).join(", ") },
      // work & education — experience arrays fill multi-entry history blocks
      // by occurrence (1st Employer field = most recent job, 2nd = next, …)
      { keys: ["years of experience", "years experience", "years of relevant", "how many years"], value: work.yearsExperience },
      { keys: ["current company", "current employer", "employer", "organization", "organisation", "company name"], value: exps ? exps.map((e) => e.company) : work.company },
      { keys: ["current title", "job title", "current role", "your title", "position title", "title of your"], value: exps ? exps.map((e) => e.title) : work.title },
      // Workday work-experience LOCATION (per job) — must not get the home city
      { keys: ["work experience", "employer location", "company location", "job location", "employment location"], not: ["title", "company", "description", "date", "currently", "from", "to", "industry", "reference"], value: exps ? exps.map((e) => e.location) : null },
      { keys: ["job description", "role description", "duties", "responsibilities", "describe your role", "work performed", "job details", "description of duties", "primary responsibilities"], value: exps ? exps.map((e) => e.description) : null },
      { keys: ["currently work here", "current position", "i currently work", "present position", "still work"], value: "Yes" },
      { keys: ["school", "university", "college", "institution", "alma mater"], value: pair(edu.school, edu2.school) },
      { keys: ["degree"], value: pair(edu.degree, edu2.degree) },
      { keys: ["major", "field of study", "discipline", "concentration"], value: pair(edu.major, edu2.major) },
      { keys: ["graduation", "grad year", "end year", "completion date", "expected graduation"], value: pair(edu.gradYear, edu2.gradYear) },
      { keys: ["start year", "from year", "enrolled"], value: pair(edu.startYear, edu2.startYear) },
      { keys: ["start date month", "start month"], value: pair(edu.startMonth, edu2.startMonth) },
      { keys: ["end date month", "end month", "graduation month"], value: pair(edu.gradMonth, edu2.gradMonth) },
      { keys: ["gpa", "grade point"], value: pair(edu.gpa, edu2.gpa) },
      // authorization
      { keys: ["authorized to work", "legally authorized", "work authorization", "eligible to work", "legally eligible", "right to work"], value: auth.authorizedUS },
      { keys: ["sponsorship", "visa sponsor", "require visa", "h-1b"], value: auth.needsSponsorship },
      { keys: ["visa status", "immigration status", "citizenship status"], value: auth.visaStatus },
      // logistics & the standard screener wall
      { keys: ["salary", "compensation", "pay expectation", "desired pay", "expected pay", "hourly rate"], value: lg.salary || p.salaryExpectation },
      { keys: ["notice period"], value: lg.noticePeriod },
      { keys: ["start date", "earliest start", "available to start", "availability", "date available"], value: lg.startDate || p.availability },
      // "How did you hear about us" is usually a picklist — offer the common
      // option wordings so one actually matches instead of typing free text
      { keys: ["how did you hear", "how you heard", "hear about", "source", "referral source"], not: ["referral source name", "referred by"],
        candidates: [lg.howHeard, "Company Website", "Corporate Website", "Company careers page", "Careers Page", "Online", "Job Board", "LinkedIn", "Other"].filter(Boolean) },
      { keys: ["relocat"], value: lg.relocate },
      { keys: ["18 years", "at least 18", "over 18", "minimum age", "age of 18"], value: lg.over18 },
      { keys: ["background check", "background screening"], value: lg.backgroundCheck },
      { keys: ["previously employed", "previously worked", "former employee", "ever worked for", "ever been employed", "previous worker"], value: lg.previouslyEmployed },
      { keys: ["relative", "family member", "immediate family"], value: lg.relativesAtCompany },
      { keys: ["security clearance"], value: lg.clearance },
      { keys: ["non-compete", "noncompete", "non compete", "restrictive covenant"], value: lg.nonCompete },
      { keys: ["pronouns"], value: pi.pronouns },
      { keys: ["language", "languages spoken", "fluent in", "language proficiency"], not: ["programming"], candidates: (p.languages && p.languages.length ? p.languages : ["English"]) },

      // ----- voluntary EEO / demographics -----
      // Each fills your specific answer if set, else falls through decline synonyms
      // until one matches the form's actual options (wording varies by ATS).
      dem("gender identity", ["gender"], d.gender, { not: ["pronoun", "transgender"] }),
      dem("race / ethnicity", ["race", "ethnic", "ethnicity"], d.raceEthnicity),
      dem("hispanic / latino", ["hispanic", "latino", "latinx", "latina"], d.hispanicLatino),
      dem("veteran status", ["veteran", "protected veteran", "military service", "armed forces"], d.veteran),
      dem("disability status", ["disability", "chronic condition", "differently abled"], d.disability),
      dem("transgender", ["transgender"], d.transgender),
      dem("sexual orientation", ["sexual orientation", "orientation"], d.sexualOrientation),
      // user-defined custom answers appended at runtime
    ];
  }

  // ---------- setters that survive React ----------

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelect(el, value) {
    const want = normTxt(value);
    let opt = [...el.options].find(
      (o) =>
        normTxt(o.value) === want ||
        normTxt(o.textContent) === want ||
        (want.length > 2 && normTxt(o.textContent).includes(want))
    );
    // decline-worded value matches any decline-worded option
    if (!opt && DECLINE_RE.test(value)) opt = [...el.options].find((o) => DECLINE_RE.test(o.textContent));
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // React comboboxes (modern Greenhouse, Ashby): type the value, wait for the
  // async option list to render, click the matching option.
  function isCombobox(el) {
    return (
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-autocomplete") === "list" ||
      !!el.closest('[role="combobox"]')
    );
  }

  // setTimeout is throttled to 1s+ in background tabs — MessageChannel ticks
  // aren't, so fills stay fast even when the user switches away mid-fill.
  const _mc = new MessageChannel();
  const tick = () => new Promise((r) => { _mc.port1.onmessage = () => r(); _mc.port2.postMessage(0); });
  async function sleep(ms) {
    const end = performance.now() + ms;
    while (performance.now() < end) await tick();
  }

  // React widgets (react-select, Ashby toggles) act on pointer/mouse-down —
  // a bare .click() is silently ignored. Fire the full sequence.
  function clickReact(el) {
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }

  // Circuit breaker: after 3 comboboxes in a row where no option list ever
  // renders, assume this page's dropdowns don't react to programmatic input
  // and stop burning wait-time on the rest.
  let comboDeadStreak = 0;

  // Find the option menu that belongs to THIS combobox — never another widget's.
  // react-select renders <div class="select__menu"> as a sibling of the control
  // inside the shared select container. Scoping here is what stops the infamous
  // "filled random shit" bug (grabbing the phone country-code list for School).
  function ownMenu(el) {
    const control = el.closest('[class*="control"]') || el;
    // climb to the react-select root that holds both control and menu
    let root = control.parentElement;
    for (let i = 0; i < 4 && root; i++) {
      const m = root.querySelector('[class*="select__menu"], [role="listbox"]');
      if (m && isVisible(m)) return m;
      root = root.parentElement;
    }
    // aria linkage as a fallback
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    if (id) { const m = document.getElementById(id); if (m) return m; }
    return null;
  }

  function optionsIn(menu) {
    if (!menu) return [];
    return [...menu.querySelectorAll('[class*="option"], [role="option"], li')].filter(
      (o) => isVisible(o) && o.textContent.trim() && !/no options|loading/i.test(o.textContent)
    );
  }

  // normalize curly quotes / whitespace so "don't" == "don't"
  function normTxt(s) {
    return (s || "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  }
  // any "decline / prefer not to answer / I don't wish to disclose / do not want to
  // identify" wording, regardless of exact phrasing or punctuation
  const DECLINE_RE = /decline|prefer not|(don'?t|do not|not|choose not|rather not)\s+(wish\s+)?(to\s+)?(want\s+)?(to\s+)?(answer|disclose|identif|say|specify|state|provide)/i;

  function matchOption(opts, want) {
    const w = normTxt(want);
    const m =
      opts.find((o) => normTxt(o.textContent) === w) ||
      opts.find((o) => normTxt(o.textContent).startsWith(w)) ||
      opts.find((o) => { const t = normTxt(o.textContent); return w.startsWith(t) && t.length > 2; }) ||
      opts.find((o) => normTxt(o.textContent).includes(w));
    if (m) return m;
    // decline candidates match ANY decline-worded option
    if (DECLINE_RE.test(want)) return opts.find((o) => DECLINE_RE.test(o.textContent)) || null;
    return null;
  }

  // Open a react-select by firing a real pointer/mouse sequence on its control.
  function openSelect(el) {
    const control = el.closest('[class*="control"]') || el;
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
      control.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    el.focus();
  }

  // Push a search string into a react-select input. The native-setter + input
  // event is what fires React's onChange → react-select's onInputChange →
  // AsyncSelect.loadOptions. Proven against real React 18. (No execCommand — it
  // fires a SECOND input and desyncs the value tracker.)
  function typeSearch(el, text) {
    el.focus();
    setNativeValue(el, text); // setNativeValue already dispatches input + change
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: text.slice(-1) || "a" }));
  }

  // Is the menu still fetching? (react-select shows a "Loading…" notice)
  function menuLoading(menu) {
    return !!menu && /loading|searching/i.test(menu.textContent) &&
      !menu.querySelector('[class*="option"]');
  }

  // value may be a single string OR a priority list of candidate answers
  // (demographics: [your answer, "Decline to self-identify", "prefer not to answer", …]).
  async function fillCombobox(el, value, isRetry = false) {
    const cands = (Array.isArray(value) ? value : [value]).map(String).filter((v) => v.trim());
    if (!cands.length) return false;
    openSelect(el);
    await sleep(150);

    // static lists (country/degree/EEO/yes-no) have their options mounted the
    // moment the menu opens — try each candidate before typing
    let menu = ownMenu(el);
    let opts = optionsIn(menu);
    for (const c of cands) {
      const m = matchOption(opts, c);
      if (m) { clickReact(m); await sleep(120); comboDeadStreak = 0; return true; }
    }
    const value0 = cands[0]; // for the search path below

    // search field: type the query, then wait — through the async "Loading…"
    // state — for real results scoped to THIS menu. Up to 5s for slow networks.
    typeSearch(el, value0);
    const t0 = performance.now();
    let sawOptions = false;
    while (performance.now() - t0 < 5000) {
      await sleep(150);
      menu = ownMenu(el);
      if (menuLoading(menu)) continue; // keep waiting while it fetches
      opts = optionsIn(menu);
      if (opts.length) sawOptions = true;
      for (const c of cands) {
        const m = matchOption(opts, c);
        if (m) { clickReact(m); await sleep(150); comboDeadStreak = 0; return true; }
      }
      // options loaded but none match → stop waiting (prefix retry or give up)
      if (sawOptions && performance.now() - t0 > 700) break;
    }

    // "Mumbai, Maharashtra" found nothing? retry with just "Mumbai"
    if (!isRetry) {
      const short = value0.split(/[,(–-]/)[0].trim();
      if (short && short.length >= 2 && short.toLowerCase() !== value0.toLowerCase())
        return fillCombobox(el, short, true);
    }

    // genuinely no match anywhere: leave it typed + open for the user, flag it
    typeSearch(el, isRetry ? value0.split(/[,(–-]/)[0].trim() : value0);
    comboDeadStreak++;
    return "manual";
  }

  // "Type to add" tag fields (Workday skills, languages): type each value, pick
  // the suggestion if one appears, else press Enter to add it as a free tag.
  async function fillTagField(el, values) {
    let added = 0;
    for (const v of values.slice(0, 10)) {
      openSelect(el);
      typeSearch(el, v);
      await sleep(500); // wait for the suggestion dropdown
      const menu = ownMenu(el);
      const m = matchOption(optionsIn(menu), v);
      if (m) { clickReact(m); added++; }
      else {
        for (const key of ["Enter"])
          el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, keyCode: 13, which: 13 }));
        added++;
      }
      await sleep(250);
      try { setNativeValue(el, ""); } catch {}
    }
    return added;
  }

  // Workday-style dropdowns: a <button aria-haspopup="listbox"> that opens a menu
  async function fillListboxButton(el, value) {
    el.click();
    const want = String(value).toLowerCase();
    const t0 = performance.now();
    for (let tries = 0; tries < 6; tries++) {
      await sleep(200);
      const opts = [...document.querySelectorAll('[role="option"], [role="listbox"] li, [role="menuitem"]')].filter(isVisible);
      const match =
        opts.find((o) => o.textContent.trim().toLowerCase() === want) ||
        opts.find((o) => o.textContent.trim().toLowerCase().includes(want));
      if (match) {
        clickReact(match);
        await sleep(100);
        comboDeadStreak = 0;
        return true;
      }
      if (performance.now() - t0 > 900 && !opts.length) break;
    }
    // close the menu we opened so the page isn't left in a weird state
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    comboDeadStreak++;
    return false;
  }

  function highlight(el, color) {
    el.style.outline = `2px solid ${color}`;
    el.style.outlineOffset = "1px";
  }

  // ---------- undo ----------

  let lastUndo = [];

  function recordUndo(el, kind, prev) {
    lastUndo.push({ el, kind, prev });
  }

  function undoLastFill() {
    for (const u of lastUndo.reverse()) {
      try {
        if (u.kind === "radio") { u.el.checked = false; u.el.dispatchEvent(new Event("change", { bubbles: true })); }
        else if (u.kind === "select") { u.el.value = u.prev; u.el.dispatchEvent(new Event("change", { bubbles: true })); }
        else setNativeValue(u.el, u.prev);
        u.el.style.outline = "";
      } catch {}
    }
    lastUndo = [];
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && +st.opacity !== 0;
  }

  // ---------- resume upload ----------

  async function attachResume(input, resume) {
    const blob = await (await fetch(resume.dataUrl)).blob();
    const file = new File([blob], resume.name, { type: resume.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- job text for the AI prompt ----------

  function pageJobText() {
    const el =
      document.querySelector("#content, .job__description, [class*='jobDescription'], [class*='job-description'], main") ||
      document.body;
    return (document.title + "\n\n" + el.innerText).slice(0, 12000);
  }

  // Never autofilled under any circumstance (identity documents / legal jeopardy).
  // NOTE: EEO demographics (gender/race/veteran/disability/etc.) are NO LONGER here —
  // they fill from the profile's demographics section (default "Decline to self-identify").
  const SENSITIVE = [
    "date of birth", "criminal", "conviction", "social security", "ssn",
    "passport number", "driver's license", "driver license",
  ];
  // legal acknowledgements are a human's signature, not an autofill's
  const CONSENT = ["privacy policy", "acknowledg", "i agree", "terms of", "consent"];
  // bot traps: filling these flags the application as spam. NEVER touch.
  const TRAPS = ["honeypot", "honey-pot", "honey pot", "captcha"];

  // ---------- application tracker ----------

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

  function guessJob() {
    const t = document.title;
    let m = t.match(/Job Application for (.+?) at (.+)/i); // Greenhouse
    if (m) return { title: m[1].trim(), company: m[2].trim() };
    m = t.match(/^(.+?)\s*[-–]\s*(.+)$/); // Lever: "Company - Role"
    if (m && location.hostname.includes("lever.co"))
      return { title: m[2].trim(), company: m[1].trim() };
    m = t.match(/^(.+?)\s*@\s*(.+)$/); // Ashby: "Role @ Company"
    if (m) return { title: m[1].trim(), company: m[2].trim() };
    return { title: t.slice(0, 120), company: location.hostname.replace(/^www\./, "") };
  }

  async function trackApplication(defaults) {
    const url = normalizeUrl(location.href);
    const { tracker = {} } = await chrome.storage.local.get("tracker");
    const prev = tracker[url] || {};
    const guess = guessJob();
    tracker[url] = {
      ...prev,
      url,
      title: prev.title || guess.title,
      company: prev.company || guess.company,
      status: prev.status || defaults.status,
      notes: prev.notes || "",
      source: prev.source || "autofill",
      resumeUsed: defaults.resumeUsed || prev.resumeUsed || "",
      addedAt: prev.addedAt || Date.now(),
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ tracker });
  }

  // ---------- main ----------

  // Click "Add another education/experience" buttons so repeated blocks exist
  // before filling. Counts current blocks and adds until we have enough for the
  // profile (2 educations if dual-degree; N jobs from experience[]).
  async function expandRepeatingSections(profile) {
    // find an "Add" button for a section — matches the button's own text OR its
    // nearest section heading (Workday's button is often just "Add").
    const addBtn = (kw) =>
      [...document.querySelectorAll('button, a[role="button"], [data-automation-id*="add" i], [class*="add" i]')].find((b) => {
        if (!isVisible(b)) return false;
        const own = (b.textContent + " " + (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("data-automation-id") || "")).toLowerCase();
        if (!/\badd\b|\+/.test(own)) return false;
        if (kw.some((k) => own.includes(k))) return true;
        // otherwise, does a heading above this button mention the section?
        const sec = b.closest("section, fieldset, [data-automation-id]") || b.parentElement?.parentElement;
        const head = sec ? sec.textContent.slice(0, 200).toLowerCase() : "";
        return kw.some((k) => head.includes(k));
      });
    // count how many repeated blocks already exist by pulling the numeric index
    // out of any field id / name / data-automation-id containing a base token
    const blockCount = (bases) =>
      new Set(
        [...document.querySelectorAll("input, select, textarea, [data-automation-id]")]
          .map((el) => ((el.id || "") + " " + (el.name || "") + " " + (el.getAttribute("data-automation-id") || "")).toLowerCase())
          .filter((s) => bases.some((b) => s.includes(b)))
          .map((s) => (s.match(/[-_ ](\d+)(?:[-_ ]|$)/) || [])[1])
          .filter((x) => x != null)
      ).size;

    const plans = [];
    if (profile.education2 && profile.education2.school)
      plans.push({ kw: ["education", "school", "degree"], want: 2, bases: ["school", "degree", "discipline", "education"] });
    const nJobs = Array.isArray(profile.experience) ? Math.min(profile.experience.length, 4) : 0;
    if (nJobs > 1) plans.push({ kw: ["experience", "employment", "work history", "position"], want: nJobs, bases: ["jobtitle", "companyname", "workexperience", "employer", "roledescription"] });

    for (const plan of plans) {
      for (let guard = 0; guard < plan.want + 2; guard++) {
        const have = Math.max(1, blockCount(plan.bases));
        if (have >= plan.want) break;
        const btn = addBtn(plan.kw);
        if (!btn) break;
        clickReact(btn);
        await sleep(450); // let the new block mount
      }
    }
  }

  async function fillPage(useAI) {
    comboDeadStreak = 0; // fresh page assessment per run
    const store = await chrome.storage.local.get([
      "profile", "resume", "resumes", "activeResumeId",
    ]);
    const profile = store.profile;
    if (!profile) throw new Error("No profile set — open the extension options first.");

    // active resume from the multi-resume list; legacy single `resume` as fallback
    const resumes = store.resumes || [];
    const activeResume =
      resumes.find((r) => r.id === store.activeResumeId) || resumes[0] || store.resume || null;

    const rules = buildRules(profile);
    for (const a of profile.answers || []) {
      rules.push({ keys: a.match.map((m) => m.toLowerCase()), value: a.value });
    }

    // Dual degree / multiple jobs: many ATS show ONE education (or work) block
    // and an "Add another" button. Click those first so the second block exists
    // for the occurrence-based fill to populate.
    await expandRepeatingSections(profile);

    lastUndo = [];
    const report = { filled: [], ai: [], skipped: [], needsClick: [], resume: false };
    const fields = [
      ...document.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"]'),
    ].filter((el) =>
      // hidden file inputs are fair game — ATS often hide them behind a styled button
      el.type === "file" ? !el.disabled : isVisible(el) && !el.disabled && !el.readOnly
    );

    const aiTargets = [];

    for (const el of fields) {
      const type = (el.getAttribute("type") || el.tagName).toLowerCase();
      if (["hidden", "submit", "image", "reset"].includes(type)) continue;
      // plain buttons are skipped — but Workday-style listbox buttons are fields
      if (type === "button" && el.getAttribute("aria-haspopup") !== "listbox") continue;

      const text = fieldText(el);

      if (type === "file") {
        // match the field text, its section heading, OR — if this is the only
        // file input on the page (common on Workday) — attach the resume anyway.
        const accepts = (el.getAttribute("accept") || "").toLowerCase();
        const section = el.closest("section, fieldset, [data-automation-id], .field, [class*='upload' i]");
        const sectionText = (section ? section.textContent.slice(0, 200) : "").toLowerCase();
        const lone = document.querySelectorAll('input[type="file"]').length === 1;
        const notCoverLetter = !matches(text, ["cover letter", "transcript", "portfolio", "photo", "headshot"]);
        const looksResume =
          matches(text, ["resume", "cv", "curriculum"]) ||
          /resume|cv|curriculum/.test(sectionText) ||
          (lone && notCoverLetter && (/\.pdf|\.doc/.test(accepts) || accepts === ""));
        if (activeResume && looksResume && notCoverLetter) {
          try {
            await attachResume(el, activeResume);
            highlight(el, "#22a55b");
            report.resume = true;
          } catch (e) {
            report.skipped.push("resume upload failed: " + e.message);
          }
        } else if (!activeResume && looksResume) {
          report.skipped.push("resume (upload your PDF in the extension's Profile tab first)");
        }
        continue;
      }

      if (matches(text, TRAPS)) continue; // silent — the whole point is not to react to them

      if (matches(text, SENSITIVE)) {
        report.skipped.push(fieldQuestion(el) || "(sensitive field)");
        continue;
      }

      if (matches(text, CONSENT)) {
        report.skipped.push(fieldQuestion(el) || "(consent — yours to sign)");
        continue;
      }

      // ghost companions of custom widgets: zero identifiers and no combobox role
      // (data-automation-id counts as an identifier — Workday fields have only that)
      if (
        el.tagName === "INPUT" && !isCombobox(el) && !el.id && !el.name &&
        !el.getAttribute("aria-label") && !el.getAttribute("data-automation-id") &&
        (!el.labels || !el.labels.length)
      ) continue;

      if (type === "radio" && el.name) {
        const group = document.getElementsByName(el.name);
        if ([...group].some((r) => r.checked)) continue; // user already answered
      }

      // Skills / languages "type-to-add" tag fields: fill ALL values, not one.
      // (Only for empty text/combobox fields, so we don't spam a filled one.)
      if (
        (isCombobox(el) || (el.tagName === "INPUT" && (type === "text" || !el.getAttribute("type")))) &&
        !(el.value && el.value.trim())
      ) {
        if (matches(text, ["skills", "skill set", "key skills", "areas of expertise"]) &&
            !matches(text, ["clearance", "no skill"]) && (profile.skills || []).length) {
          const n = await fillTagField(el, profile.skills);
          if (n) { highlight(el, "#22a55b"); report.filled.push(`Skills (${n})`); continue; }
        }
        if (matches(text, ["languages", "language"]) && !matches(text, ["programming"])) {
          const langs = profile.languages && profile.languages.length ? profile.languages : ["English"];
          const n = await fillTagField(el, langs);
          if (n) { highlight(el, "#22a55b"); report.filled.push(`Languages (${n})`); continue; }
        }
      }

      const rule = rules.find(
        (r) =>
          ((r.candidates && r.candidates.length) || (r.value != null && r.value !== "")) &&
          matches(text, r.keys) && !(r.not && matches(text, r.not))
      );

      // don't clobber anything already typed — but still advance array-valued
      // rules (dual-degree blocks) so re-runs keep occurrence order aligned.
      // EXCEPTION: force rules (country phone code) override a wrong geo-default.
      const hasValue = type !== "radio" && type !== "checkbox" && el.value && el.value.trim();
      if (hasValue && !(rule && rule.force)) {
        if (rule && Array.isArray(rule.value) && el.tagName !== "SELECT") rule._uses = (rule._uses || 0) + 1;
        continue;
      }

      if (rule) {
        // candidate list: demographics carry [your answer, "Decline to self-identify", …]
        // and we fill the first that matches the form's actual options. Non-candidate
        // rules resolve to a single value (occurrence-indexed for dual-degree arrays).
        let cands;
        if (rule.candidates) cands = rule.candidates.filter(Boolean);
        else {
          let val = rule.value;
          if (Array.isArray(val)) val = val[Math.min(rule._uses || 0, val.length - 1)];
          cands = val == null || val === "" ? [] : [String(val)];
        }
        const val = cands[0]; // primary, for single-value paths (text/number)

        const prevVal = el.tagName === "BUTTON" || type === "radio" ? null : el.value;
        let ok = true;
        if (!cands.length) ok = false;
        else if (el.tagName === "BUTTON") {
          // Workday-style listbox button; skip if it already shows a chosen value
          // (unless force — country phone code must override a wrong geo-default)
          const cur = el.textContent.trim().toLowerCase();
          if (cur && !rule.force && !/select|choose|please|—|-$/i.test(cur) && cur.length > 2) ok = false;
          else { ok = false; for (const c of cands) { if (comboDeadStreak >= 3) break; if (await fillListboxButton(el, String(c))) { ok = true; break; } } }
        }
        else if (el.tagName === "SELECT") { ok = false; for (const c of cands) if (setSelect(el, c)) { ok = true; break; } }
        else if (type === "radio") {
          // click only the option whose OWN label matches a candidate ("Yes"/"No",
          // "Decline to self-identify"); the group question already matched via fieldText
          const own = normTxt(ownLabel(el));
          ok = cands.some((c) => {
            const want = normTxt(c);
            return own === want || own.startsWith(want + " ") || own.startsWith(want + ",") ||
              (want.length > 6 && own.includes(want)) ||
              (DECLINE_RE.test(c) && DECLINE_RE.test(own)); // decline ↔ decline
          });
          if (ok) clickReact(el);
        } else if (type === "checkbox") {
          ok = false; // still too ambiguous; leave to the user
        } else if (isCombobox(el)) {
          ok = comboDeadStreak >= 3 ? false : await fillCombobox(el, cands);
        } else if (type === "number") {
          const m = String(val).match(/-?\d+(\.\d+)?/);
          if (m) setNativeValue(el, m[0]);
          else ok = false;
        } else setNativeValue(el, String(val));

        // search field we pre-typed but can't auto-select: hand off to the user
        if (ok === "manual") {
          if (Array.isArray(rule.value)) rule._uses = (rule._uses || 0) + 1;
          highlight(el, "#e8961e"); // orange = your turn: pick from the open list
          (report.needsClick ||= []).push(`${fieldQuestion(el) || rule.keys[0]} → "${val}"`);
          continue;
        }
        if (ok) {
          if (Array.isArray(rule.value)) rule._uses = (rule._uses || 0) + 1;
          if (el.tagName !== "BUTTON")
            recordUndo(el, type === "radio" ? "radio" : el.tagName === "SELECT" ? "select" : "text", prevVal ?? "");
          highlight(el, "#22a55b");
          report.filled.push(fieldQuestion(el) || rule.keys[0]);
          continue;
        }
      }

      // Unmatched long-form questions -> AI drafting queue
      if (el.tagName === "TEXTAREA" && useAI) {
        const q = fieldQuestion(el);
        if (q && q.length > 8) aiTargets.push({ el, q });
      } else if (!rule) {
        const q = fieldQuestion(el);
        if (q) report.skipped.push(q);
      }
    }

    if (aiTargets.length) {
      const jobText = pageJobText();
      // answer memory: similar past answers ride along as context, so quality
      // compounds and drafts stay consistent across applications
      const { answerMemory = [] } = await chrome.storage.local.get("answerMemory");
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      for (const { el, q } of aiTargets) {
        const nq = norm(q);
        const pastAnswers = answerMemory
          .map((a) => ({ a, sim: nq === norm(a.q) ? 2 : norm(a.q).includes(nq) || nq.includes(norm(a.q)) ? 1 : 0 }))
          .filter((x) => x.sim > 0)
          .sort((x, y) => y.sim - x.sim)
          .slice(0, 2)
          .map((x) => ({ q: x.a.q, a: x.a.a }));
        const res = await chrome.runtime.sendMessage({ type: "LLM_DRAFT", question: q, jobText, pastAnswers });
        if (res && res.ok) {
          recordUndo(el, "text", el.value);
          setNativeValue(el, res.text);
          highlight(el, "#e8961e"); // orange = AI draft, review before submitting
          report.ai.push(q);
          answerMemory.unshift({ q, a: res.text, ts: Date.now() });
        } else {
          report.skipped.push(`${q} (AI: ${res ? res.error : "no response"})`);
        }
      }
      await chrome.storage.local.set({ answerMemory: answerMemory.slice(0, 100) });
    }

    // Ashby-style boolean questions: bare Yes/No <button> pairs, question in the container
    const ynButtons = [...document.querySelectorAll("button")].filter(
      (b) => isVisible(b) && /^(yes|no)$/i.test(b.textContent.trim())
    );
    const seenGroups = new Set();
    for (const btn of ynButtons) {
      const group = btn.parentElement;
      if (!group || seenGroups.has(group)) continue;
      seenGroups.add(group);
      const opts = [...group.querySelectorAll("button")].filter((b) => /^(yes|no)$/i.test(b.textContent.trim()));
      if (opts.length < 2) continue;
      // already answered? Ashby marks the chosen one via aria-pressed/data-state/class
      if (opts.some((b) => b.getAttribute("aria-pressed") === "true" || /selected|active/i.test(b.className))) continue;
      const qEl = group.closest('[class*="field" i], [class*="question" i], fieldset') || group.parentElement;
      const text = (qEl ? qEl.textContent.slice(0, 300) : "").toLowerCase();
      const rule = rules.find(
        (r) => r.value != null && r.value !== "" && !Array.isArray(r.value) &&
          /^(yes|no)$/i.test(String(r.value)) && matches(text, r.keys) && !(r.not && matches(text, r.not))
      );
      if (!rule) continue;
      if (text && SENSITIVE.concat(CONSENT).some((k) => text.includes(k))) continue;
      const target = opts.find((b) => b.textContent.trim().toLowerCase() === String(rule.value).trim().toLowerCase());
      if (target) {
        clickReact(target);
        highlight(target, "#22a55b");
        report.filled.push((qEl?.querySelector("label, legend, p, span")?.textContent || "yes/no question").trim().slice(0, 60));
        await sleep(60);
      }
    }

    report.skipped = [...new Set(report.skipped)]; // radio groups report per-option
    report.filled = [...new Set(report.filled)];

    if (report.filled.length || report.ai.length || report.resume) {
      await trackApplication({ status: "filled", resumeUsed: activeResume?.name || "" });
      report.tracked = true;
    }

    // gap log: remember what this site's form didn't cover, for future adapters
    if (report.skipped.length) {
      const { gapLog = {} } = await chrome.storage.local.get("gapLog");
      gapLog[location.hostname] = { url: location.href, skipped: report.skipped.slice(0, 20), ts: Date.now() };
      const keys = Object.keys(gapLog);
      if (keys.length > 30) delete gapLog[keys.sort((a, b) => gapLog[a].ts - gapLog[b].ts)[0]];
      await chrome.storage.local.set({ gapLog });
    }

    return report;
  }

  // ---------- zero-click experience: auto-fill + on-page widget ----------

  const ATS_HOSTS = [
    /greenhouse\.io$/, /lever\.co$/, /ashbyhq\.com$/, /myworkdayjobs\.com$/,
    /icims\.com$/, /smartrecruiters\.com$/, /workable\.com$/, /jobvite\.com$/,
    /bamboohr\.com$/, /dover\.com$/, /rippling-ats\.com$/, /oraclecloud\.com$/,
    /successfactors\.\w+$/, /taleo\.net$/, /eightfold\.ai$/,
  ];
  const isAtsHost = () => ATS_HOSTS.some((r) => r.test(location.hostname));

  // Conservative detector — never auto-type on a random website
  function looksLikeApplication() {
    const inputs = document.querySelectorAll("input, textarea, select").length;
    const hasResume = !!document.querySelector('input[type="file"]');
    const jobbish = /job|career|apply|position|vacan|intern/i.test(location.href + " " + document.title);
    return inputs >= 4 && jobbish && (hasResume || inputs >= 8);
  }

  function widget() {
    let w = document.getElementById("__japWidget");
    if (w) return w;
    w = document.createElement("div");
    w.id = "__japWidget";
    w.style.cssText =
      "position:fixed;bottom:18px;right:18px;z-index:2147483647;background:#1c2433;color:#fff;" +
      "border-radius:999px;padding:10px 16px;font:13px/1.3 -apple-system,sans-serif;display:flex;" +
      "gap:10px;align-items:center;box-shadow:0 8px 30px rgba(0,0,0,.35)";
    document.documentElement.appendChild(w);
    return w;
  }

  const wBtn = (label, title) =>
    `<button title="${title || ""}" style="background:rgba(255,255,255,.14);border:0;color:#fff;border-radius:999px;padding:5px 11px;font:12px -apple-system,sans-serif;cursor:pointer">${label}</button>`;

  function showWidget(report) {
    const w = widget();
    const left = report.skipped.length;
    const nClick = (report.needsClick || []).length;
    w.innerHTML =
      `<span>⚡ Filled <b>${report.filled.length + report.ai.length}</b>${report.resume ? " + resume" : ""}${nClick ? ` · <span style="color:#e8961e">${nClick} search field${nClick > 1 ? "s" : ""} pre-typed — click the highlighted one${nClick > 1 ? "s" : ""}</span>` : ""}${left ? ` · <span style="opacity:.7">${left} left</span>` : ""}</span>` +
      wBtn("✨ AI answers", "Draft answers for the free-text questions") +
      wBtn("↩", "Undo everything I filled") + wBtn("✕");
    const [aiB, undoB, closeB] = w.querySelectorAll("button");
    aiB.addEventListener("click", async () => {
      aiB.textContent = "✨ drafting…"; aiB.disabled = true;
      const rep = await fillPage(true).catch(() => null);
      if (rep) showWidget(rep);
    });
    undoB.addEventListener("click", () => { undoLastFill(); w.remove(); });
    closeB.addEventListener("click", () => w.remove());
  }

  function showSuggestWidget() {
    const w = widget();
    w.innerHTML = `<span>Looks like a job application.</span>` + wBtn("⚡ Fill it") + wBtn("✕");
    const [fillB, closeB] = w.querySelectorAll("button");
    fillB.addEventListener("click", async () => {
      fillB.textContent = "filling…";
      const rep = await fillPage(false).catch(() => null);
      if (rep) showWidget(rep);
    });
    closeB.addEventListener("click", () => w.remove());
  }

  let lastAutoUrl = location.href;
  let lastAutoAt = 0;

  async function autoKick(reason) {
    if (Date.now() - lastAutoAt < 4000) return;
    if (!looksLikeApplication()) return;
    const { settings = {} } = await chrome.storage.local.get("settings");
    if (settings.autoFill === false) return; // on by default; toggle off in the popup
    lastAutoAt = Date.now();
    if (isAtsHost()) {
      const rep = await fillPage(false).catch(() => null);
      if (rep && (rep.filled.length || rep.resume || rep.skipped.length)) showWidget(rep);
    } else {
      showSuggestWidget(); // unknown site: offer, never auto-type personal data
    }
  }

  (async () => {
    if (document.readyState !== "complete")
      await new Promise((r) => window.addEventListener("load", r, { once: true }));
    await sleep(1500); // let SPAs render their form
    const inFrame = window !== window.top;
    // in random page iframes (ads etc.), do nothing unless it's an ATS frame
    // or genuinely looks like an application form
    if (inFrame && !isAtsHost() && !looksLikeApplication()) return;
    autoKick("load");
    // Workday-style wizards change URL per step — refill each new page
    setInterval(() => {
      if (location.href !== lastAutoUrl) {
        lastAutoUrl = location.href;
        setTimeout(() => autoKick("nav"), 1500);
      }
    }, 1200);
  })();
}

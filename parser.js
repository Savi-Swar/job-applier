// Shared parsing + classification. Loaded by dashboard.html (script tag) and
// background.js (importScripts) — keep this file free of DOM and chrome.* APIs.

const GH_SOURCES = [
  {
    id: "speedyapply",
    name: "SpeedyApply",
    url: "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/README.md",
  },
  {
    id: "vanshb03",
    name: "Vansh",
    url: "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/README.md",
  },
  {
    id: "zshah101",
    name: "zshah",
    url: "https://raw.githubusercontent.com/zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships/main/README.md",
  },
  {
    id: "sndsh404",
    name: "sndsh",
    url: "https://raw.githubusercontent.com/sndsh404/summer-2027-internships/main/README.md",
  },
];

function categorize(role, repoCategory) {
  const r = (role + " " + (repoCategory || "")).toLowerCase();
  if (/(quant|trad(er|ing)|market mak|hedge fund|capital markets analyst)/.test(r)) return "Quant";
  if (/(machine learning|\bml\b|\bai\b|data scien|deep learning|\bllm\b|research scien|computer vision|\bnlp\b)/.test(r)) return "ML/AI";
  if (/(data engineer|data analyst|analytics|business intel)/.test(r)) return "Data";
  if (/(hardware|embedded|fpga|asic|silicon|firmware|chip design|rtl)/.test(r)) return "Hardware";
  if (/(security|infosec|penetration|threat)/.test(r)) return "Security";
  if (/(product manag|program manag|\bapm\b)/.test(r)) return "PM";
  if (/(software|swe|sde|full.?stack|backend|back.?end|front.?end|mobile|ios|android|platform|infrastructure|devops|site reliab|sre|developer|web dev|cloud|systems eng|engineer)/.test(r)) return "SWE";
  return "Other";
}

function stripTags(s) {
  return s
    .replace(/<img[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLink(cell) {
  let m = cell.match(/href="([^"]+)"/i);
  if (m) return m[1];
  m = cell.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (m) return m[1];
  m = cell.match(/(https?:\/\/[^\s|<)"']+)/);
  return m ? m[1] : null;
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function colIndex(header, keys) {
  return header.findIndex((h) => keys.some((k) => h.includes(k)));
}

function parseDaysOld(raw) {
  if (!raw) return null;
  const s = stripTags(raw);
  let m = s.match(/^(\d+)\s*d$/i); // "10d"
  if (m) return parseInt(m[1], 10);
  m = s.match(/^(\d+)\s*mo$/i); // "3mo"
  if (m) return parseInt(m[1], 10) * 30;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); // "2026-07-16"
  if (m) return Math.max(0, Math.round((Date.now() - new Date(+m[1], +m[2] - 1, +m[3])) / 864e5));
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?$/); // "Jul 09" / "Jul 16, 2026"
  if (m) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const mi = months.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi === -1) return null;
    let d = new Date(m[3] ? +m[3] : new Date().getFullYear(), mi, +m[2]);
    if (!m[3] && d > new Date()) d.setFullYear(d.getFullYear() - 1);
    return Math.max(0, Math.round((Date.now() - d) / 864e5));
  }
  return null;
}

function parseReadme(md, sourceId) {
  const jobs = [];
  const lines = md.split("\n");
  let header = null;
  let cols = null;
  let lastCompany = "";

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) { header = null; cols = null; continue; }
    if (/^\|[\s\-:|]+\|?$/.test(t)) continue; // separator row

    const cells = splitRow(t);
    if (!header) {
      header = cells.map((c) => stripTags(c).toLowerCase());
      cols = {
        company: colIndex(header, ["company"]),
        role: colIndex(header, ["role", "position", "title"]),
        location: colIndex(header, ["location"]),
        link: colIndex(header, ["apply", "application", "posting", "link"]),
        date: colIndex(header, ["age", "posted", "date", "added"]),
        category: colIndex(header, ["category"]),
        salary: colIndex(header, ["salary", "compensation", "pay"]),
      };
      continue;
    }
    if (cols.company === -1 || cols.role === -1) continue;
    if (cells.length < header.length - 1) continue;

    let company = stripTags(cells[cols.company] || "").replace(/[✓]/g, "").trim();
    if (!company || company === "↳") company = lastCompany;
    else lastCompany = company;

    const roleRaw = cells[cols.role] || "";
    const rowText = t;
    const role = stripTags(roleRaw).replace(/[🇺🇸🛂🔒🎓🆕~]/gu, "").replace(/\s+/g, " ").trim();
    const link = cols.link !== -1 ? extractLink(cells[cols.link]) : extractLink(rowText);

    if (!company || !role) continue;

    const repoCategory = cols.category !== -1 ? stripTags(cells[cols.category]) : "";
    jobs.push({
      source: sourceId,
      company,
      role,
      location: cols.location !== -1 ? stripTags(cells[cols.location]).replace(/<\/?br\/?>/gi, ", ") : "",
      category: categorize(role, repoCategory),
      salary: cols.salary !== -1 ? stripTags(cells[cols.salary]) : "",
      link,
      daysOld: cols.date !== -1 ? parseDaysOld(cells[cols.date]) : null,
      closed: rowText.includes("🔒") || !link,
      noSponsorship: rowText.includes("🛂"),
      citizenOnly: rowText.includes("🇺🇸"),
    });
  }
  return jobs;
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    // LinkedIn job links: the path is canonical, the query is all tracking
    if (url.hostname.endsWith("linkedin.com") && url.pathname.startsWith("/jobs/view/"))
      return url.origin + url.pathname.replace(/\/$/, "");
    for (const k of [...url.searchParams.keys()]) {
      const lk = k.toLowerCase();
      if (lk.startsWith("utm_") || ["ref", "src", "source", "refid", "trackingid", "position", "pagenum"].includes(lk))
        url.searchParams.delete(k);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

// Personalized match score 0-100. Rule-based (instant, free, explainable):
// skills overlap, freshness, authorization conflicts, and your own history
// with the company (they responded before? bump. they passed on you? note it).
function scoreJob(job, profile, history) {
  if (job.closed) return { score: 0, reasons: ["closed"] };
  const reasons = [];
  let score = 50;

  if (history) {
    const co = job.company.toLowerCase();
    if (history.responded?.has(co)) { score += 10; reasons.push("this company has responded to you before"); }
    else if (history.rejected?.has(co)) { score -= 12; reasons.push("they passed on you before"); }
  }

  const skills = (profile?.skills || []).map((s) => s.toLowerCase()).filter((s) => s.length > 1);
  const text = (job.role + " " + (job.category || "")).toLowerCase();
  const hits = skills.filter((s) => text.includes(s));
  if (hits.length) {
    score += Math.min(hits.length * 9, 27);
    reasons.push(`mentions your skills: ${hits.slice(0, 3).join(", ")}`);
  }

  if (job.daysOld != null) {
    if (job.daysOld <= 2) { score += 15; reasons.push("posted <48h — best window"); }
    else if (job.daysOld <= 7) { score += 8; reasons.push("posted this week"); }
    else if (job.daysOld > 21) { score -= 18; reasons.push("cooked (21d+)"); }
  }

  const needsSponsor = profile?.authorization?.needsSponsorship === "Yes";
  const notAuthorized = profile?.authorization?.authorizedUS === "No";
  if (job.noSponsorship && needsSponsor) {
    score -= 45; reasons.push("⚠ no sponsorship offered — you need it");
  }
  if (job.citizenOnly) {
    if (needsSponsor || notAuthorized) { score -= 45; reasons.push("⚠ US citizenship required"); }
    else { score -= 10; reasons.push("US citizenship required"); }
  }

  if (job.salary) { score += 5; reasons.push("salary listed"); }
  if (job.source === "watch") { score += 6; reasons.push("from your watchlist"); }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// One-time seed from Savitur's real resume (July 2026) — used only when no
// profile has been saved yet. Work-authorization answers are deliberately left
// blank: answer those yourself in Options before your first application.
const DEFAULT_PROFILE = {
  personal: {
    firstName: "Savitur", lastName: "Swarup", preferredName: "",
    email: "saviswa@seas.upenn.edu", phone: "+1 445-214-2585", pronouns: "",
    address: { street: "", city: "Philadelphia", state: "PA", zip: "", country: "United States" },
  },
  links: { linkedin: "https://linkedin.com/in/savitur-swarup", github: "", website: "" },
  education: {
    school: "University of Pennsylvania", degree: "Bachelor's",
    major: "Computer Science", gpa: "3.8", startYear: "2024", gradYear: "2028", startMonth: "August", gradMonth: "May",
  },
  education2: {
    school: "University of Pennsylvania (Wharton)", degree: "Bachelor's",
    major: "Economics (Finance)", gpa: "3.8", startYear: "2024", gradYear: "2028", startMonth: "August", gradMonth: "May",
  },
  work: { company: "Tara Ventures", title: "Software Engineer", yearsExperience: "2-3" },
  // most-recent-first — multi-entry work-history blocks fill in this order
  experience: [
    { company: "Tara Ventures", title: "Software Engineer", start: "06/2026", end: "Present", location: "Singapore",
      description: "Built an ad-optimization pipeline (Python, Meta Marketing API, Google Ads API) generating LLM-produced creatives with A/B testing; multi-armed bandit budget allocation auto-filtering underperformers, projected 50% ROAS improvement; closed-loop system feeding bandit/clustering results back into LLM generation." },
    { company: "Bridge AI", title: "Co-Founder & Software Engineer", start: "11/2025", end: "Present", location: "Philadelphia, PA",
      description: "Built an agentic AI system with a 45-tool registry executing real CRM actions with confirmation gates and snapshot-based undo; RAG pipeline on PostgreSQL/pgvector (halfvec-3072 + tsvector hybrid search); multi-LLM routing layer across 7 providers with fallback chains, consensus voting, and per-call cost attribution." },
    { company: "Forschungszentrum Jülich (RWTH Aachen University)", title: "Research Intern", start: "05/2026", end: "07/2026", location: "Jülich, Germany",
      description: "Built a harmonized EEG pipeline (Python, MNE) across 8 public datasets (504 subjects, 8 clinical conditions); microstate features separated neurodegenerative disease from controls (Alzheimer's AUC 0.89), generalizing to unseen FTD at AUC 0.92; robustness checks caught a spectral confound inflating a false depression result." },
    { company: "Jiro Web Solutions", title: "Founder / CEO", start: "01/2023", end: "08/2025", location: "Remote (Asia)",
      description: "Founded a freelance web-dev agency serving small businesses across Asia; hired and trained a team of 5; shipped 20+ production sites and mobile apps with React/React Native/Vue, Stripe payments, and Firebase/Supabase backends." },
    { company: "A*STAR, Centre for Frontier AI Research", title: "Research Intern", start: "06/2024", end: "09/2024", location: "Singapore",
      description: "Benchmarked multiple LLMs on multimodal sarcasm detection across datasets under Prof. Cheston Tan; built and fine-tuned a custom model from the benchmarking insights to improve context understanding and multimodal integration." },
  ],
  authorization: { authorizedUS: "", needsSponsorship: "", visaStatus: "" },
  logistics: {
    startDate: "May 2027", noticePeriod: "None", salary: "",
    howHeard: "Company careers page", relocate: "Yes", over18: "Yes",
    backgroundCheck: "Yes", previouslyEmployed: "No", relativesAtCompany: "No",
    clearance: "No", nonCompete: "No",
  },
  // Voluntary EEO. Left blank on purpose — set your own in Options if you wish.
  // declineUnset: true means any EEO question you leave blank auto-fills
  // "Decline to self-identify" so required demographic sections don't block submit.
  demographics: {
    gender: "", raceEthnicity: "", hispanicLatino: "", veteran: "",
    disability: "", transgender: "", sexualOrientation: "", declineUnset: true,
  },
  skills: [
    // Languages
    "Python", "TypeScript", "JavaScript", "C", "C++", "Java", "SQL",
    // ML/AI
    "PyTorch", "scikit-learn", "pandas", "NumPy", "XGBoost", "Hugging Face",
    "MNE-Python", "RAG", "pgvector",
    // Web/Backend
    "React", "React Native", "Node.js", "Express", "Next.js", "Prisma", "REST APIs",
    // Data/Infra
    "PostgreSQL", "Redis", "BullMQ", "pg-boss", "Supabase", "Firebase", "Docker",
  ],
  languages: ["English"],
  answers: [],
  highlights: [
    "At Tara Ventures: built an ad-optimization pipeline (Python, Meta Marketing API, Google Ads API) generating LLM-produced media with multi-armed bandit budget allocation — projected 50% ROAS improvement.",
    "Co-founded Bridge AI: agentic AI system with a 45-tool registry executing real CRM actions, RAG pipeline on PostgreSQL/pgvector (halfvec 3072 + hybrid search), and a multi-LLM routing layer across 7 providers with fallback chains and cost attribution.",
    "Founded Jiro Web Solutions at 17: freelance web-dev agency serving small businesses across Asia; hired and trained a team of 5; shipped 20+ production sites and mobile apps (React/React Native/Vue, Stripe, Firebase/Supabase).",
    "EEG research at Forschungszentrum Jülich (RWTH Aachen): harmonized pipeline across 8 public datasets (504 subjects); microstate features separated Alzheimer's from controls at AUC 0.89, generalizing to unseen FTD at AUC 0.92.",
    "A*STAR research intern: benchmarked multiple LLMs on multimodal sarcasm detection; built and fine-tuned a custom model from the benchmarking insights.",
    "Vig: quant research platform with a vol-targeted backtest engine — no-lookahead contract tests, purged walk-forward validation, deflated-Sharpe trial counting across 70+ tests.",
    "USA Computing Olympiad Gold Division; American Math Olympiad Gold Medalist.",
  ],
  tone: "Direct and specific, quietly confident. Real numbers over adjectives. No corporate buzzwords.",
  masterResume: `SAVITUR SWARUP
+1 445-214-2585 | saviswa@seas.upenn.edu | linkedin.com/in/savitur-swarup

EDUCATION
University of Pennsylvania — Philadelphia, PA. B.S.E. Computer Science (SEAS); B.S. Economics, Finance (Wharton); GPA 3.8/4.0. Expected May 2028.
Coursework: Data Structures & Algorithms, Computer Systems, Automata & Computability, Discrete Math, Probability, Linear Algebra.
Awards: USA Computing Olympiad Gold Division; American Math Olympiad Gold Medalist.

EXPERIENCE
Software Engineer — Tara Ventures, Singapore (June 2026 – Present)
- Developed an ad-optimization pipeline (Python, Meta Marketing API, Google Ads API) that generates LLM-produced media and A/B tests it across product verticals.
- Implemented multi-armed bandit budget allocation across variants, auto-filtering underperformers; projected 50% improvement in ROAS / cost-per-acquisition over prior campaigns.
- Built closed-loop system feeding bandit/clustering into LLM generation, tweaking creative/audience each cycle.

Co-Founder & Software Engineer — Bridge AI, Philadelphia, PA (Nov. 2025 – Present)
- Built an agentic AI system with a 45-tool registry executing real CRM actions (creating deals, moving pipeline stages, drafting follow-ups), with confirmation gates, snapshot-based undo, and trust-gating for destructive ops.
- Built a RAG pipeline on PostgreSQL/pgvector — halfvec(3072) embeddings + tsvector hybrid search with an async embedding worker; powers natural-language semantic search for contacts, notes, and documents.
- Engineered a multi-LLM routing layer across 7 providers (Claude, Gemini, OpenAI, Grok, Perplexity, DeepSeek, Qwen) with per-task routing, fallback chains, consensus voting, and per-call cost attribution.

Founder / CEO — Jiro Web Solutions (Jan. 2023 – Aug. 2025)
- Founded a freelance web-dev agency serving small businesses across Asia; hired and trained a team of 5.
- Built full-stack apps with secure auth, Stripe payments, and Firebase/Supabase (PostgreSQL) backends.
- Deployed 20+ production sites and mobile apps using React, React Native, and Vue.

RESEARCH
Research Intern — RWTH Aachen University, Forschungszentrum Jülich, Germany (May 2026 – Jul. 2026)
- Built a single harmonized EEG pipeline (Python, MNE) across 8 public datasets (504 subjects, 8 clinical conditions), fitting a global microstate model and extracting 24 features per subject for classification.
- Showed microstate features robustly separate neurodegenerative disease from controls (Alzheimer's AUC 0.89, FTD 0.80), with an Alzheimer's-trained model generalizing to unseen FTD at AUC 0.92.
- Ran robustness checks (age-confound regression, permutation tests with 5000 shuffles, cross-site validation, ComBat harmonization), catching a spectral confound that inflated a false depression result.

Research Intern — A*STAR, Centre for Frontier AI Research, Singapore (Jun. 2024 – Sep. 2024)
- Benchmarked multiple LLMs on multimodal sarcasm detection across various datasets under Prof. Cheston Tan.
- Built + fine-tuned custom model on benchmarking insights to improve context understanding and multimodal integration.

PROJECTS
Vig — Quant Research Platform (Python, 2026)
- Built a vol-targeted backtest engine with no-lookahead contract tests, purged walk-forward validation, and deflated-Sharpe trial-counting across 70 tests + CI.
- Reconstructed a point-in-time S&P universe to measure survivorship bias directly, showing most of the signal's edge was backtest artifact once bias was removed.
- Recovered net edge with no-trade turnover bands at half the cost drag, and caught a rename-leakage bug backdating index membership.

TECHNICAL SKILLS
Languages: Python, TypeScript, JavaScript, C/C++, Java, SQL
ML/AI: PyTorch, scikit-learn, pandas, NumPy, XGBoost, Hugging Face, MNE-Python, RAG (pgvector)
Web/Backend: React, React Native, Node.js, Express, Next.js, Prisma, REST APIs
Data/Infra: PostgreSQL, Redis, BullMQ, pg-boss, Supabase, Firebase, Docker`,
};

// Pull the canonical job ID out of known ATS URLs so the SAME posting collapses
// even when different repos link to it with different tracking/mirror URLs.
function jobUrlId(link) {
  try {
    const u = new URL(link);
    const host = u.hostname;
    let m;
    if (/greenhouse\.io/.test(host)) {
      m = link.match(/(?:jobs\/|gh_jid=|job_app\?[^#]*?for=[^&]*&?token=)(\d{5,})/) || u.pathname.match(/\/(\d{5,})(?:\/|$)/);
      if (m) return "gh:" + m[1];
    }
    if (/lever\.co/.test(host)) { m = u.pathname.match(/([0-9a-f]{8}-[0-9a-f-]{20,})/i); if (m) return "lever:" + m[1].toLowerCase(); }
    if (/ashbyhq\.com/.test(host)) { m = u.pathname.match(/([0-9a-f]{8}-[0-9a-f-]{20,})/i); if (m) return "ashby:" + m[1].toLowerCase(); }
    if (/myworkdayjobs\.com/.test(host)) { m = link.match(/_([A-Za-z0-9-]{6,})(?:[/?#]|$)/); if (m) return "wd:" + host.split(".")[0] + ":" + m[1]; }
    if (/oraclecloud\.com/.test(host)) { m = link.match(/job\/(\d{4,})/); if (m) return "orc:" + m[1]; }
    if (/icims\.com/.test(host)) { m = link.match(/jobs\/(\d{4,})/); if (m) return "icims:" + m[1]; }
    return normalizeUrl(link);
  } catch {
    return normalizeUrl(link);
  }
}

// Company + title signature that collapses cosmetic title variants
// ("SWE Intern" ≈ "Software Engineer Intern (Summer 2027) 🚀") but keeps
// genuinely distinct roles apart (Frontend vs Backend, NYC vs London).
function jobSignature(company, role) {
  const r = (role || "")
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}☀-➿←-⇿⬀-⯿]/gu, " ") // emoji/symbols
    .replace(/\b(summer|fall|autumn|winter|spring)\b/g, " ")
    .replace(/\b20\d{2}\b|['’]\d{2}\b/g, " ") // years / '27
    .replace(/\b(software engineer|software developer|swe|sde)\b/g, "swe")
    .replace(/\bintern(ship)?\b/g, "intern")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const co = (company || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return co + "::" + r;
}

// ---------- import parsing (pasted text / scanned emails → job entries) ----------

// Unwrap tracking/security redirect links so the real ATS URL gets parsed &
// stored. Handles Proofpoint URL Defense v3 (UPenn wraps every link as
// urldefense.com/v3/__url__;b64!!sig — some chars are replaced by * / **X runs
// and stashed base64url-encoded in the suffix), Proofpoint v2, Google's
// /url?q= and Outlook Safelinks. Loops for nested wrapping.
const UD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function unwrapUrlOnce(url) {
  let m = url.match(/urldefense\.com\/v3\/__(.*?)__;([A-Za-z0-9_-]*)!!/i);
  if (m) {
    let subs = "";
    if (m[2]) {
      try {
        const b = m[2].replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
        try { subs = decodeURIComponent(escape(bin)); } catch { subs = bin; }
      } catch {}
    }
    let i = 0;
    return m[1].replace(/\*\*([A-Za-z0-9_-])|\*/g, (tok, run) => {
      const n = run ? UD_B64.indexOf(run) + 2 : 1; // **X = run of idx+2 chars, * = one
      const s = subs.slice(i, i + n);
      i += n;
      return s || tok; // suffix exhausted → leave the token rather than corrupt
    });
  }
  m = url.match(/urldefense\.proofpoint\.com\/v2\/url\?u=([^&]+)/i);
  if (m) { try { return decodeURIComponent(m[1].replace(/-/g, "%").replace(/_/g, "/")); } catch {} }
  m = url.match(/(?:google\.[a-z.]+\/url\?(?:[^#]*?&)?q=|safelinks\.protection\.outlook\.com\/\?(?:[^#]*?&)?url=)([^&]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch {} }
  return url;
}

function unwrapUrl(url) {
  let u = String(url || "");
  for (let i = 0; i < 3; i++) {
    const next = unwrapUrlOnce(u);
    if (next === u) break;
    u = next;
  }
  return u;
}

function titleCase(s) {
  return (s || "").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
}

// best-effort company/role from a known ATS / LinkedIn URL
function parseJobUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname, p = decodeURIComponent(u.pathname);
    let m;
    if (h.endsWith("linkedin.com") && p.includes("/jobs/view/")) {
      m = p.match(/\/jobs\/view\/(.+?)-at-([a-z0-9.&'-]+?)-\d+/i);
      if (m) return { role: titleCase(m[1].replace(/-/g, " ")), company: titleCase(m[2].replace(/-/g, " ")) };
    }
    if (/greenhouse\.io/.test(h)) { m = p.match(/^\/(?:embed\/job_app\?.*?for=)?([^/?]+)/); if (m) return { company: titleCase(m[1].replace(/-/g, " ")) }; }
    if (/lever\.co/.test(h)) { m = p.match(/^\/([^/]+)/); if (m) return { company: titleCase(m[1].replace(/-/g, " ")) }; }
    if (/ashbyhq\.com/.test(h)) { m = p.match(/^\/([^/]+)/); if (m) return { company: titleCase(m[1].replace(/-/g, " ")) }; }
    if (/myworkdayjobs\.com/.test(h)) { return { company: titleCase(h.split(".")[0]) }; }
    // aggregator/redirect hosts aren't the employer — let the surrounding email
    // text (card lines) supply company & role instead
    if (/jobright\.ai$|lnkd\.in$|indeed\.com$|ziprecruiter\.com$|simplify\.jobs$/.test(h)) return {};
    return { company: titleCase(h.replace(/^www\.|^job-boards\.|^boards\.|^jobs\.|^apply\./, "").replace(/\.(com|io|co|net|ai|org).*$/, "")) };
  } catch { return {}; }
}

// parse text (pasted or an email body) into job entries: pull every URL, then
// borrow a role/company from the URL and from nearby lines.
function parseImport(text) {
  const urlRe = /https?:\/\/[^\s<>"')\]]+/g;
  const titleRe = /(intern|co-?op|new grad|engineer|developer|analyst|scientist|manager|researcher|research|consultant|associate|trader|quant|designer|architect|programmer|swe|sde)/i;
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  const out = [];
  const recent = [];
  for (const line of lines) {
    const urls = line.match(urlRe);
    if (!urls) { if (line && line.length < 120) { recent.push(line); if (recent.length > 8) recent.shift(); } continue; }
    for (const url of urls) {
      const clean = unwrapUrl(url.replace(/[).,]+$/, ""));
      let { company, role } = parseJobUrl(clean);
      let location = "";
      const before = line.slice(0, line.indexOf(url)).trim();
      const ctx = [...recent].reverse();
      // Jobright alert cards have a rigid shape anchored on the match-% line:
      //   <company> / <industry · stage> / NN% / <role — often on THIS url line> / <location> / <time ago>
      const pct = recent.findIndex((l) => /^\d{1,3}\s*%$/.test(l)); // UPenn variant renders "84 %" with a space
      const LOC_RE = /(Remote(?![a-z])|[A-Z][a-zA-Z.]*(?: [A-Z][a-zA-Z.]*)*, [A-Z]{2}(?![a-zA-Z]))/;
      if (pct !== -1) {
        // inside a %-anchored card the structure is trustworthy: the text
        // before the URL (or the line after the %) is the role even without a
        // keyword like "intern" (e.g. "Summer Trading Program")
        if (!role) {
          const cand =
            (before && !/^apply\s*now$/i.test(before) && before.length > 2 && !LOC_RE.test(before) && before) ||
            (recent[pct + 1] && !LOC_RE.test(recent[pct + 1]) && recent[pct + 1]) || "";
          if (cand) role = cand;
        }
        if (!company) {
          const hasInd = /·/.test(recent[pct - 1] || ""); // "Apps · Public Company" industry line
          const co = hasInd ? recent[pct - 2] : recent[pct - 1];
          // when the · industry line confirms the slot, accept title-ish names
          // too ("Binary App Developers"); \bicon\b — plain /icon/ ate "SemICONductors"
          if (co && (hasInd || !titleRe.test(co)) && !/jobright|\bicon\b|%/i.test(co) && !LOC_RE.test(co)) company = co;
        }
      }
      if (!role) role = (titleRe.test(before) && before) || ctx.find((l) => titleRe.test(l)) || "";
      if (!company)
        company = ctx.find((l) =>
          l !== role && /^[A-Z0-9]/.test(l) && l.length < 45 && !titleRe.test(l) && !LOC_RE.test(l) &&
          !/apply|view job|match|remote|%|\$|📍|salary|jobright|instant alert|early applicant|referrals?|ago\b|\bicon\b|·/i.test(l)) || "";
      const locLine = recent.slice(pct === -1 ? 0 : pct + 1).find((l) => l !== role && l !== company && LOC_RE.test(l));
      if (locLine) location = (locLine.match(LOC_RE) || [])[1] || "";
      // card extras: "$45/hr - $45/hr" salary line, "36 minutes ago" posting age
      const salLine = recent.find((l) => /^\$[\d,.]/.test(l) && l.length < 40);
      const agoM = recent.join(" | ").match(/(\d+)\s*(minute|hour|day|week)s?\s+ago/i);
      const agoMin = agoM ? +agoM[1] * { minute: 1, hour: 60, day: 1440, week: 10080 }[agoM[2].toLowerCase()] : null;
      out.push({
        company: company.slice(0, 60), role: (role || "Imported job").slice(0, 120), link: clean,
        location: location.slice(0, 60), salary: (salLine || "").slice(0, 40), agoMin,
      });
    }
    recent.length = 0;
  }
  // The same job URL appears several times per email card (icon link, role
  // line, APPLY NOW) with different context each time — merge the sightings,
  // preferring whichever parse found a real role, and fill gaps from the rest.
  const real = (r) => r && r !== "Imported job";
  const best = new Map();
  for (const j of out) {
    const k = jobUrlId(j.link);
    const a = best.get(k);
    if (!a) { best.set(k, j); continue; }
    const base = !real(a.role) && real(j.role) ? j : a;
    const other = base === a ? j : a;
    best.set(k, {
      link: a.link,
      role: base.role,
      company: base.company || other.company,
      location: base.location || other.location,
      salary: base.salary || other.salary,
      agoMin: base.agoMin ?? other.agoMin,
    });
  }
  return [...best.values()];
}

// filter parsed entries to real job-posting links only (drops unsubscribe,
// tracking, social, and jobright's own navigation links)
function jobLinksOnly(entries) {
  const ATS = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|workable\.com|jobvite\.com|bamboohr\.com|oraclecloud\.com|successfactors|taleo\.net|eightfold\.ai|linkedin\.com\/jobs|\/job(s)?\/|\/careers?\/|\/position/i;
  const SKIP = /unsubscribe|email-preferences|utm_medium=email.*(footer|header)|facebook\.com|twitter\.com|x\.com|instagram|\.png|\.jpg|\.gif|jobright\.ai\/(settings|profile|feedback|blog|home|dashboard|referral|onboarding|autofill|preferences)|jobright\.ai\/jobs\/recommend/i;
  return entries.filter((j) => ATS.test(j.link) && !SKIP.test(j.link));
}

function dedupeJobs(lists) {
  const jobs = [];
  const seenUrl = new Set();
  const seenSig = new Set();
  for (const list of lists) {
    for (const j of list) {
      const uid = j.link ? jobUrlId(j.link) : null;
      const sig = jobSignature(j.company, j.role);
      if ((uid && seenUrl.has(uid)) || seenSig.has(sig)) continue;
      if (uid) seenUrl.add(uid);
      seenSig.add(sig);
      jobs.push(j);
    }
  }
  return jobs;
}

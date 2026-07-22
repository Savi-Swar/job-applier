# Job Applier (personal Chrome extension)

Autofills job application forms from a saved profile, attaches your resume, and
drafts answers to free-text questions ("Why do you want to work here?") with the
free Gemini API. You review everything and click submit yourself.

Also includes a **dashboard** (popup → "Dashboard: feed & tracker") with five tabs:

- **Today** (home) — "Good morning, Savitur ☀️" briefing: fresh postings from the
  last 48h (apply early — that's when humans read applications), a 3–21 day
  backlog section, a 💀 cooked section, and week/total/streak stats. A Chrome
  notification fires **daily at 8am** with the fresh count; clicking it opens
  this tab. **⚡ Needs attention** generates concrete follow-up actions from
  your pipeline: 7/14-day silence nudges, 25-day "mark ghosted", unconfirmed
  fills, stale saves, referral reminders, and upcoming next steps — each with
  quick-action buttons and dismissal.
- **Match scoring** — every posting gets a personalized 0–100 fit score
  (hover for reasons): your skills mentioned in the role, freshness, salary
  listed, hard authorization conflicts (needs-sponsorship vs 🛂 postings,
  citizenship requirements) which sink a job to the bottom, plus your own
  history (companies that responded to you before get a boost; ones that
  passed on you get flagged). Feed sorts best-match by default; Today always.
- **Company watchlist** — watch dream companies' own Greenhouse/Lever boards
  directly via their public APIs (Profile tab; slug from the careers URL).
  Early-career postings land in the feed the moment they go up.
- **AI writer suite** — on any job's ⓘ detail page: 🤝 referral finder
  (LinkedIn people-search links + 3 drafted outreach messages), ✉️ follow-up
  emails (timed to days-of-silence, one click from the action cards),
  🎯 resume tailoring from your master resume (with a "could NOT include
  truthfully" honesty list), 📄 a full cover letter, and 📚 a per-job interview
  prep sheet with LeetCode/Glassdoor/Reddit research links. AI answers also
  build an **answer memory** so drafts get more consistent over time.
  "OA due Friday"-style next steps are parsed into real deadlines: ⏰ urgent
  action cards and calendar due-markers.
- **Safety** — weekly silent auto-backup to `Downloads/job-applier-backups/`,
  manual backup/restore, and a toolbar badge showing the fresh-postings count
  each morning (clears when you open the dashboard).
- **Calendar** — month grid showing postings per day (blue) and your
  applications per day (green); click a day to see both lists.

- **Postings feed** — parses four GitHub internship-list repos
  (speedyapply/2027-SWE-College-Jobs, vanshb03/Summer2027-Internships,
  zshah101/Automated-List…, sndsh404/summer-2027-internships) **plus LinkedIn**
  via its public guest listing (saved searches configurable in the Profile tab,
  no login needed — Jobright itself is login-gated so it can't be scraped, but
  it mostly resells these same postings). Everything is deduped,
  auto-categorized (SWE / Quant / ML-AI / Data / Hardware /
  Security / PM / Other) and shows salary where the source lists it.
  Filters (persisted): text search, location, max age, category chips,
  per-source, hide closed, hide already-tracked. Auto-refreshes when >6h old.
  Clicking **apply ↗** opens the posting AND queues a "Did you apply?" card —
  answer Yes and it lands in the tracker as *applied* with today's date.
- **Application tracker** — a spreadsheet-style grid: company, role, category,
  status (saved → filled → applied → OA → interview → offer / rejected /
  ghosted), applied date, referral pipeline (none → want one → asked →
  referred + who), next step, notes. Every form you fill is logged
  automatically; popup buttons "✓ Mark applied" and "＋ Track only" work on any
  page. **📋 Copy for Sheets** copies the whole grid as paste-ready rows and
  opens sheets.new; CSV export too.
- **Profile** — stats (applied count, this-week, interview rate), your profile
  summary, **multiple resumes** (upload several, note what each is used for,
  pick which to attach from the popup), **answer templates** the AI tailors per
  job, and your LinkedIn feed searches. Plus **insights**: applications-per-week
  chart, your funnel (applied → OA → interview → offer with conversion %), and
  response rates **by source and by resume** — so you double down on what
  converts. And **backup/restore**: one click exports everything to JSON
  (extension storage dies if the extension is removed — back up weekly).

Every job row has an **ⓘ details** button opening a full job page: posting info,
inline tracker editing (status/referral/dates/notes), and **Fetch description &
AI analysis** — it pulls the posting's text and runs Gemini to extract required
skills, nice-to-haves, and ATS buzzwords (cached per job). Works for
server-rendered sites (Greenhouse/Lever/Ashby/LinkedIn); JS-only sites (Workday)
say so and point you at the popup's 🔍 Analyze, which reads the rendered page.

The popup also has **🔍 Analyze posting** — on any job page it sends the posting
text to Gemini and returns required skills, nice-to-haves, and the exact
**ATS buzzwords** to use in your resume; results are saved onto the tracker entry.

Autofill loads automatically on Greenhouse, Lever, Ashby, Workday, iCIMS,
SmartRecruiters, Workable, Jobvite, BambooHR, Dover, and Rippling (and via the
popup button on any other site). LinkedIn Easy Apply is deliberately NOT
autofilled — LinkedIn bans automation and it's not worth your account.

⚠️ The Gemini API key is hardcoded in `background.js` and `options.js` for
personal use — **remove it before ever sharing or publishing this folder.**

## Install (no Chrome Web Store needed)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`job-applier`).
4. Pin the extension from the puzzle-piece menu so the button is visible.

After editing any file in this folder, hit the circular **reload** arrow on the
extension card in `chrome://extensions` to pick up changes.

## Set up (one time)

1. Right-click the extension icon → **Options**. It's a structured "fill this
   out once" form modeled on the real ATS question bank: name/contact, full
   mailing address, links, education, experience, the work-authorization pair,
   and the standard yes/no screener wall (18+, background check, relocation,
   previously employed, relatives at company, clearance, non-compete, notice
   period, start date, "how did you hear"). The autofill maps each site's
   wording onto these answers — including **radio buttons** for the yes/no
   questions. **Dual degree?** Fill the optional second education section; on
   forms, click the site's "Add education" button first, then Fill — degree #1
   goes in the first block, degree #2 in the second.
2. Fill "Your highlights" — that's what the AI draws on when writing answers.
3. Upload resume(s) in the dashboard's **Profile** tab.
4. Save. (A Gemini API key is pre-filled; get your own free at
   https://aistudio.google.com if it ever rate-limits.)

## The application experience

- **Zero-click autofill**: on known ATS pages (Greenhouse, Lever, Ashby,
  Workday, iCIMS, Oracle, SuccessFactors, Taleo, Eightfold…) the form fills
  itself ~1.5s after the page loads. A dark pill appears bottom-right:
  "⚡ Filled 12 + resume · 3 left for you" with **✨ AI answers** (drafts the
  free-text questions) and **↩ Undo**. Toggle auto-fill in the popup.
- **Any other site**: a conservative detector offers "Looks like a job
  application — ⚡ Fill it" (it never types on unknown sites uninvited).
- **Multi-step wizards** (Workday): each step re-fills automatically as the
  URL changes. Workday's `data-automation-id` markup and button-style
  dropdowns are handled; their account-creation wall is still yours.
- **⚡ easy-apply filter** in the feed shows only Greenhouse/Lever/Ashby
  postings — the tier where the whole flow is ~2 minutes per application.
- A **gap log** records any fields left unfilled per site (storage key
  `gapLog`) — report a bad site and its gaps are already captured for fixing.

## Use

1. Open a job application page (Greenhouse, Lever, and Ashby work best; on any
   other site the popup injects itself when you click the button).
2. Click the extension icon → **Fill this page**.
3. Green outline = filled from your profile. Orange outline = AI draft — **read
   and edit these before submitting**. The popup lists anything it left for you.
4. Submit yourself.

## What it deliberately does NOT do

- Click submit — that's always you.
- Fill demographic/EEO questions (race, gender, veteran, disability status) —
  those are skipped and left manual on purpose.
- Guess at checkboxes/radios or fancy custom dropdowns (React comboboxes) —
  too easy to get wrong silently; the popup reports them as "left for you".

## How it works

- `content.js` scans visible `input`/`textarea`/`select` elements, reads their
  labels/names/placeholders, and matches them against keyword rules built from
  your profile (`options.js` → `chrome.storage.local`).
- Unmatched `<textarea>` questions are sent to `background.js`, which calls
  Gemini with your profile + the job posting text scraped from the page, and the
  draft is typed in with an orange outline.
- Values are set via the native setters + `input`/`change` events so React-based
  forms (modern Greenhouse) register the change.
- Your resume is stored as a data URL and attached to file inputs labelled
  resume/CV via `DataTransfer`.

Everything (profile, resume, API key) lives in `chrome.storage.local` on your
machine only.

## Extending

Add stock answers in the profile's `answers` array:

```json
{ "match": ["security clearance"], "value": "No" }
```

Any field whose label contains a `match` string gets the `value`. To support a
new job board that misbehaves, look at its form in DevTools and extend the
rules in `buildRules()` in `content.js`.

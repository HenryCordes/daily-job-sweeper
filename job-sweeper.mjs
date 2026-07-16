#!/usr/bin/env node
// job-sweeper.mjs — daily sweep for remote dev jobs that fit your profile.
//
// Zero dependencies. Node 18+ (built-in fetch). Your profile lives in
// profile.config.mjs (copy profile.example.config.mjs and edit).
//   node job-sweeper.mjs             # sweep, print + write new matches
//   node job-sweeper.mjs --resolve   # also follow redirects to the real company URL (slower)
//   node job-sweeper.mjs --selftest  # validate filtering/dedupe offline (no network)
//
// State (next to this file): seen.json (dedupe), watchlist.json (self-growing ATS
// tokens), matches.csv (append-only log).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const p = (f) => join(DIR, f);
const lc = (s) => (s || "").toString().toLowerCase();
const anyIn = (hay, needles) => needles.some((n) => hay.includes(n));
const readJSON = (f, d) => (existsSync(p(f)) ? JSON.parse(readFileSync(p(f), "utf8")) : d);
const writeJSON = (f, o) => writeFileSync(p(f), JSON.stringify(o, null, 2));

// ---------- profile config (personal, gitignored) ----------
async function loadProfileConfig() {
  if (!existsSync(p("profile.config.mjs"))) {
    console.error("Missing profile.config.mjs — copy the example and edit it to your profile:\n  cp profile.example.config.mjs profile.config.mjs");
    process.exit(1);
  }
  return import("./profile.config.mjs");
}
// let (not const): --selftest swaps in a fixed fixture profile so it stays deterministic.
let { PROFILE, REGION_ALLOW_RE, MAX_AGE_DAYS, SEED_WATCHLIST, COMPANY_SLUGS, LINKEDIN_SEARCHES, FREEHIRE_REGIONS } = await loadProfileConfig();
const escHtml = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function renderHTML(matches, today) {
  const cell = "padding:15px 12px;border-bottom:1px solid #f0f1f3;vertical-align:top;";
  const badge = (s) => `<span style="display:inline-block;min-width:20px;text-align:center;background:#eef2fb;color:#35507e;border-radius:7px;padding:3px 9px;font-size:12px;font-weight:600;">${s}</span>`;
  // LinkedIn people-search links per row: recruiter (referral path) and role peers
  // (warm-intro path). Link generation only -- the user opens them; nothing is fetched.
  const people = (company, kw) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${company} ${kw}`)}&origin=GLOBAL_SEARCH_HEADER`;
  const roleKeyword = (title) => (title || "").replace(/\(.*?\)/g, " ").split(/[|,–—-]/)[0].replace(/\s+/g, " ").trim();
  const th = (t) => `<th style="text-align:left;padding:0 12px 11px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#9aa0a8;font-weight:600;border-bottom:2px solid #edeef0;">${t}</th>`;
  const rows = matches.map((m) => `<tr>
      <td style="${cell}">${badge(m.score)}</td>
      <td style="${cell}"><a href="${escHtml(m.url)}" style="color:#1f4e79;font-weight:600;font-size:14px;text-decoration:none;">${escHtml(m.title)}</a><div style="color:#9aa0a8;font-size:12px;margin-top:3px;">${escHtml(m.company)} · <a href="${escHtml(people(m.company, "recruiter"))}" style="color:#9aa0a8;">recruiters</a> · <a href="${escHtml(people(m.company, roleKeyword(m.title)))}" style="color:#9aa0a8;">peers</a></div></td>
      <td style="${cell}color:#6b7280;font-size:13px;">${escHtml(m.location)}</td>
      <td style="${cell}color:#9aa0a8;font-size:12px;">${escHtml(m.note)}</td>
    </tr>`).join("");
  const body = matches.length
    ? `<table role="presentation" width="100%" style="border-collapse:collapse;width:100%;"><thead><tr>${th("Fit")}${th("Role")}${th("Location")}${th("Why")}</tr></thead><tbody>${rows}</tbody></table>`
    : `<p style="color:#6b7280;font-size:14px;margin:6px 0 0;">No new matches today. Enjoy the quiet.</p>`;
  const n = matches.length;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f4f5f7;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" style="max-width:1360px;margin:0 auto;background:#ffffff;border:1px solid #ececec;border-radius:12px;">
<tr><td style="padding:28px 28px 6px;"><div style="font-size:19px;font-weight:700;color:#1a1d21;">${n} new remote role${n === 1 ? "" : "s"}</div><div style="font-size:13px;color:#9aa0a8;margin-top:3px;">${escHtml(PROFILE.headline)} &middot; ${today}</div></td></tr>
<tr><td style="padding:14px 20px 20px;">${body}</td></tr>
<tr><td style="padding:0 28px 26px;"><div style="border-top:1px solid #f0f1f3;padding-top:14px;color:#b3b7be;font-size:11px;">Role titles link straight to the posting. Full history attached as matches.csv.</div></td></tr>
</table></body></html>`;
}

// ---------- behaviour toggles ----------
const DROP_INTERMEDIARIES = true;      // hide Jobgether/Turing/agency reposts
const AGGREGATOR_REQUIRE_STACK = true; // aggregator roles must show a JS/TS signal

// ---------- profile ----------
const ROLE_RE = /\b(engineer|developer|programmer|architect|swe|full[ -]?stack|frontend|front[ -]?end)\b/;
// positive signal that this is actually a JS/TS role (drops Java/Python/etc.)
const STACK_SIGNAL = /\b(react|next\.?js|next|typescript|ts|node\.?js|node|javascript|js|vue|nuxt|svelte|sveltekit|remix|full[ -]?stack|frontend|front[ -]?end|web (developer|engineer))\b/;
// other languages / role types we don't want
const LANG_WORDS = /\b(java|kotlin|scala|ruby|rails|python|django|flask|elixir|phoenix|golang|rust|laravel|symfony|dotnet|perl|clojure|haskell|salesforce|abap|embedded|firmware|android|swift|unity|unreal|wordpress|drupal|magento)\b/;
const LANG_SUBSTR = [".net", "c#", "c++"];
const ROLE_EXCLUDE = ["junior", "intern", "graduate", "working student", "apprentice",
  "manager", "director", "head of", "vp ", "marketing", "sales", "account executive",
  "recruiter", "designer", "data scientist", "data engineer", "machine learning", " ml ",
  "devops", " sre", "qa ", "test engineer", "support engineer", "mobile", "ios ", "game "];

const INTERMEDIARY_RE = /(jobgether|proxify|turing|toptal|crossover|andela|x[- ]?team|braintrust|revelo|lemon\.io|gun\.io|arc\.dev|a\.team|gigster|jobot|cybercoders|robert half|staffing|recruit(?!ee)|talent pool)/i;

// ISO country code -> name, so location strings carry filterable country names
// (used by landingjobs' {country_code} objects and freehire's countries[]).
const COUNTRY_NAME = { PT: "Portugal", ES: "Spain", BR: "Brazil", DE: "Germany", NL: "Netherlands",
  FR: "France", GB: "United Kingdom", IE: "Ireland", PL: "Poland", BE: "Belgium", AT: "Austria",
  SE: "Sweden", DK: "Denmark", US: "United States" };

// ---------- net ----------
async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "job-sweeper/1.0", Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const ATS_URL_RE = /https?:\/\/(?:boards\.greenhouse\.io\/[^\s"'<>]+|jobs\.lever\.co\/[^\s"'<>]+|jobs\.ashbyhq\.com\/[^\s"'<>]+|[a-z0-9-]+\.recruitee\.com\/[^\s"'<>]+|apply\.workable\.com\/[^\s"'<>]+|[a-z0-9-]+\.jobs\.personio\.com\/[^\s"'<>]+|jobs\.smartrecruiters\.com\/[^\s"'<>]+)/i;
// Resolve an aggregator listing to the real company/ATS posting:
// 1) if the link redirects off the aggregator's host, use that final URL;
// 2) otherwise scan the page HTML for an outbound ATS apply link.
// Falls back to the original URL when neither is found.
async function resolveCompanyUrl(job) {
  const host = (u) => { try { return new URL(u).host; } catch { return ""; } };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(job.url, { redirect: "follow", signal: c.signal, headers: { "User-Agent": "job-sweeper/1.0" } });
    clearTimeout(t);
    if (r.url && host(r.url) && host(r.url) !== host(job.url)) return r.url;
    const m = (await r.text()).match(ATS_URL_RE);
    if (m) return m[0].replace(/&amp;/g, "&");
  } catch { }
  return job.url;
}
function parsePersonioXML(xml, token) {
  const tag = (b, t) => { const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
  const out = [];
  for (const m of xml.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
    const b = m[1], id = tag(b, "id"), name = tag(b, "name"), office = tag(b, "office");
    if (!name) continue;
    out.push({ source: `personio:${token}`, company: token, title: name, location: office || "",
      remote: /remote/i.test(office + " " + name), url: `https://${token}.jobs.personio.com/job/${id}`,
      tags: [tag(b, "recruitingCategory")].filter(Boolean), seniority: [], posted: tag(b, "createdAt") });
  }
  return out;
}
// WordPress "job_feed" RSS shape, shared by EU Remote Jobs and Jobspresso.
async function wpJobFeed(source, feedUrl) {
  const xml = await (await fetch(feedUrl, { headers: { "User-Agent": "job-sweeper/1.0" } })).text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    const tag = (t) => { const x = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
    out.push({ source, company: tag("job_listing:company") || tag("dc:creator") || "", title: tag("title"),
      location: tag("job_listing:location") || "Remote", remote: true, url: tag("link"),
      tags: [tag("job_listing:job_type"), tag("category")].filter(Boolean), seniority: [], posted: tag("pubDate"), desc: tag("description") });
  }
  return out;
}
const decodeEntities = (s) => s.replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
// Top-level comments in the monthly HN thread follow "Company | Role | Location | ..." on the first line.
function parseHNComment(c, storyId) {
  if (String(c.parent_id) !== String(storyId)) return null; // replies are not postings
  const raw = c.comment_text || "";
  const href = raw.match(/href="(https?:\/\/[^"]+)"/i);
  const text = decodeEntities(raw.replace(/<p>/gi, "\n").replace(/<[^>]+>/g, " "));
  const first = text.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  const parts = first.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null; // does not follow the posting convention
  const title = parts.slice(1).find((pp) => ROLE_RE.test(lc(pp)));
  if (!title) return null;
  return { source: "hnhiring", company: parts[0], title,
    location: parts.slice(1).filter((pp) => pp !== title).join(" | ") || "Remote",
    remote: /remote/i.test(text), url: href ? decodeEntities(href[1]) : `https://news.ycombinator.com/item?id=${c.objectID}`,
    tags: [], seniority: [], posted: c.created_at, desc: text };
}

// LinkedIn jobs-guest search returns an HTML fragment of <li> job cards keyed by a
// jobPosting URN; parse each chunk independently so one malformed card can't break
// the rest. Search cards carry no description.
function parseLinkedInCards(html) {
  const out = [];
  for (const chunk of html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1)) {
    const id = chunk.match(/^(\d+)/)?.[1];
    if (!id) continue;
    const grab = (re) => { const m = chunk.match(re); return m ? decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : ""; };
    const title = grab(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i);
    if (!title) continue;
    const href = chunk.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/i);
    out.push({ source: "linkedin", company: grab(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i),
      title, location: grab(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i) || "Remote",
      remote: true, // f_WT=2 (remote) is applied in the query
      url: href ? decodeEntities(href[1]).split("?")[0] : `https://www.linkedin.com/jobs/view/${id}`,
      tags: [], seniority: [], posted: chunk.match(/class="job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i)?.[1] || "" });
  }
  return out;
}

// ---------- adapters -> normalized job ----------
const ADAPTERS = {
  async remoteok() {
    const a = await getJSON("https://remoteok.com/api");
    return a.filter((x) => x.position).map((x) => ({
      source: "remoteok", company: x.company, title: x.position,
      location: x.location || "Remote", remote: true, url: x.apply_url || x.url, tags: x.tags || [], seniority: [], posted: x.date, desc: x.description,
    }));
  },
  async remotive() {
    const out = [];
    for (const q of ["full stack", "react", "node", "typescript", "frontend"]) {
      const d = await getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=50`);
      for (const j of d.jobs || []) out.push({
        source: "remotive", company: j.company_name, title: j.title,
        location: j.candidate_required_location || "Remote", remote: true, url: j.url,
        tags: j.tags || [], seniority: [], posted: j.publication_date, desc: j.description });
    }
    return out;
  },
  async jobicy() {
    const out = [];
    for (const t of ["react", "node.js", "typescript", "javascript"]) {
      const d = await getJSON(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(t)}`);
      for (const j of d.jobs || []) out.push({
        source: "jobicy", company: j.companyName, title: j.jobTitle,
        location: j.jobGeo || "Remote", remote: true, url: j.url,
        tags: [].concat(j.jobIndustry || [], j.jobType || []), seniority: [j.jobLevel].filter(Boolean), posted: j.pubDate, desc: j.jobExcerpt });
    }
    return out;
  },
  async himalayas() {
    const out = [];
    for (let off = 0; off < 400; off += 100) {
      const d = await getJSON(`https://himalayas.app/jobs/api?limit=100&offset=${off}`);
      for (const j of d.jobs || []) out.push({
        source: "himalayas", company: j.companyName, title: j.title,
        location: (j.locationRestrictions || []).join(", ") || "Remote", remote: true,
        url: j.applicationLink, tags: j.categories || [], seniority: j.seniority || [],
        posted: j.pubDate, timezones: j.timezoneRestrictions || [], expiry: j.expiryDate, desc: j.description });
    }
    return out;
  },
  async arbeitnow() {
    const d = await getJSON("https://www.arbeitnow.com/api/job-board-api");
    return (d.data || []).map((j) => ({
      source: "arbeitnow", company: j.company_name, title: j.title,
      location: j.location || "Remote", remote: !!j.remote, url: j.url, tags: j.tags || [], seniority: [], posted: j.created_at, desc: j.description }));
  },
  async workingnomads() {
    const a = await getJSON("https://www.workingnomads.com/api/exposed_jobs/");
    return (a || []).map((j) => ({
      source: "workingnomads", company: j.company_name, title: j.title,
      location: j.location || "Remote", remote: true, url: j.url, // /job/go/ redirects -> resolves to company
      tags: (j.tags || "").split(",").map((s) => s.trim()).filter(Boolean).concat(j.category_name ? [j.category_name] : []),
      seniority: [], posted: j.pub_date, desc: j.description }));
  },
  async weworkremotely() {
    const out = [];
    for (const c of ["remote-full-stack-programming-jobs", "remote-back-end-programming-jobs", "remote-front-end-programming-jobs"]) {
      let xml;
      try { xml = await (await fetch(`https://weworkremotely.com/categories/${c}.rss`, { headers: { "User-Agent": "job-sweeper/1.0" } })).text(); }
      catch { continue; }
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
        const b = m[1];
        const tag = (t) => { const x = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
        const raw = tag("title"), i = raw.indexOf(":"); // WWR titles are "Company: Role"
        out.push({ source: "weworkremotely", company: i > 0 ? raw.slice(0, i).trim() : "", title: i > 0 ? raw.slice(i + 1).trim() : raw,
          location: tag("region") || "Remote", remote: true, url: tag("link"),
          tags: [tag("category")].filter(Boolean), seniority: [], posted: tag("pubDate"), desc: tag("description") });
      }
    }
    return out;
  },
  async tryremotely() {
    let xml;
    try { xml = await (await fetch("https://tryremotely.com/feeds/remote-jobs.rss", { headers: { "User-Agent": "job-sweeper/1.0" } })).text(); }
    catch { return []; }
    const out = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const b = m[1];
      const tag = (t) => { const x = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
      out.push({ source: "tryremotely", company: tag("dc:creator") || tag("author") || "", title: tag("title"),
        location: "Remote", remote: true, url: tag("link"),
        tags: [tag("category")].filter(Boolean), seniority: [], posted: tag("pubDate"), desc: tag("description") });
    }
    return out;
  },
  async hiringcafe() {
    // hiring.cafe aggregates ~46 ATS platforms; POST search API, returns apply_url (real company link).
    const ss = {
      locations: [{ formatted_address: "United States", types: ["country"], geometry: { location: { lat: "39.8283", lon: "-98.5795" } }, id: "user_country", address_components: [{ long_name: "United States", short_name: "US", types: ["country"] }], options: { flexible_regions: ["anywhere_in_continent", "anywhere_in_world"] } }],
      workplaceTypes: ["Remote"], defaultToUserLocation: false, userLocation: null,
      physicalEnvironments: ["Office", "Outdoor", "Vehicle", "Industrial", "Customer-Facing"], physicalLaborIntensity: ["Low", "Medium", "High"], physicalPositions: ["Sitting", "Standing"],
      oralCommunicationLevels: ["Low", "Medium", "High"], computerUsageLevels: ["Low", "Medium", "High"], cognitiveDemandLevels: ["Low", "Medium", "High"],
      currency: { label: "Any", value: null }, frequency: { label: "Any", value: null }, minCompensationLowEnd: null, minCompensationHighEnd: null, maxCompensationLowEnd: null, maxCompensationHighEnd: null, restrictJobsToTransparentSalaries: false, calcFrequency: "Yearly",
      commitmentTypes: ["Full Time", "Part Time", "Contract", "Internship", "Temporary", "Seasonal", "Volunteer"], jobTitleQuery: "", jobDescriptionQuery: "",
      associatesDegreeFieldsOfStudy: [], excludedAssociatesDegreeFieldsOfStudy: [], bachelorsDegreeFieldsOfStudy: [], excludedBachelorsDegreeFieldsOfStudy: [], mastersDegreeFieldsOfStudy: [], excludedMastersDegreeFieldsOfStudy: [], doctorateDegreeFieldsOfStudy: [], excludedDoctorateDegreeFieldsOfStudy: [],
      associatesDegreeRequirements: [], bachelorsDegreeRequirements: [], mastersDegreeRequirements: [], doctorateDegreeRequirements: [], licensesAndCertifications: [], excludedLicensesAndCertifications: [], excludeAllLicensesAndCertifications: false,
      seniorityLevel: [], roleTypes: ["Individual Contributor", "People Manager"], roleYoeRange: [0, 20], excludeIfRoleYoeIsNotSpecified: false, managementYoeRange: [0, 20], excludeIfManagementYoeIsNotSpecified: false,
      securityClearances: ["None", "Confidential", "Secret", "Top Secret", "Top Secret/SCI", "Public Trust", "Interim Clearances", "Other"],
      languageRequirements: [], excludedLanguageRequirements: [], languageRequirementsOperator: "OR", excludeJobsWithAdditionalLanguageRequirements: false,
      airTravelRequirement: ["None", "Minimal", "Moderate", "Extensive"], landTravelRequirement: ["None", "Minimal", "Moderate", "Extensive"], morningShiftWork: [], eveningShiftWork: [], overnightShiftWork: [],
      weekendAvailabilityRequired: "Doesn't Matter", holidayAvailabilityRequired: "Doesn't Matter", overtimeRequired: "Doesn't Matter", onCallRequirements: ["None", "Occasional (once a month or less)", "Regular (once a week or more)"],
      benefitsAndPerks: [], applicationFormEase: [], companyNames: [], excludedCompanyNames: [], usaGovPref: null, industries: [], excludedIndustries: [], companyKeywords: [], companyKeywordsBooleanOperator: "OR", excludedCompanyKeywords: [],
      hideJobTypes: [], encouragedToApply: [], searchQuery: "", dateFetchedPastNDays: MAX_AGE_DAYS, hiddenCompanies: [], user: null, searchModeSelectedCompany: null,
      departments: [], restrictedSearchAttributes: [], sortBy: "default", technologyKeywordsQuery: "", requirementsKeywordsQuery: "", companyPublicOrPrivate: "all",
      latestInvestmentYearRange: [null, null], latestInvestmentSeries: [], latestInvestmentAmount: null, latestInvestmentCurrency: [], investors: [], excludedInvestors: [], isNonProfit: "all", companySizeRanges: [], minYearFounded: null, maxYearFounded: null, excludedLatestInvestmentSeries: [],
    };
    const out = [];
    for (const q of ["react", "full stack", "node", "typescript"]) {
      for (const page of [0, 1]) {
        let data;
        try {
          const r = await fetch("https://hiring.cafe/api/search-jobs", {
            method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "job-sweeper/1.0", Origin: "https://hiring.cafe", Referer: "https://hiring.cafe/" },
            body: JSON.stringify({ size: 100, page, searchState: { ...ss, searchQuery: q } }),
          });
          data = await r.json();
        } catch { continue; }
        for (const j of data?.results || data?.jobs || []) {
          const v = j.v5_processed_job_data || j.processed_job_data || {};
          out.push({
            source: "hiringcafe", company: v.company_name || j.source || "", title: v.job_title || j.job_information?.title || j.title || "",
            location: v.formatted_workplace_location || v.workplace_countries?.join(", ") || "", remote: /remote/i.test(v.workplace_type || "remote"),
            url: j.apply_url || j.job_information?.apply_url, tags: [v.seniority_level, v.workplace_type].filter(Boolean),
            seniority: [v.seniority_level].filter(Boolean), posted: v.estimated_publish_date || j.created_at, desc: j.job_information?.description || v.requirements_summary,
          });
        }
      }
    }
    return out;
  },
  async greenhouse(token) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`);
    return (d.jobs || []).map((j) => ({
      source: `greenhouse:${token}`, company: token, title: j.title,
      location: j.location?.name || "", remote: /remote/i.test(j.location?.name || ""),
      url: j.absolute_url, tags: [], seniority: [], posted: j.updated_at }));
  },
  async lever(token) {
    const a = await getJSON(`https://api.lever.co/v0/postings/${token}?mode=json`);
    return a.map((j) => ({
      source: `lever:${token}`, company: token, title: j.text,
      location: j.categories?.location || "", remote: /remote/i.test(j.workplaceType || j.categories?.location || ""),
      url: j.hostedUrl, tags: [j.categories?.team, j.categories?.commitment].filter(Boolean), seniority: [], posted: j.createdAt }));
  },
  async ashby(token) {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=false`);
    return (d.jobs || []).map((j) => ({
      source: `ashby:${token}`, company: token, title: j.title,
      location: j.location || "", remote: !!j.isRemote,
      url: j.jobUrl || j.applyUrl, tags: [j.team, j.department].filter(Boolean), seniority: [], posted: j.publishedAt }));
  },
  // --- best-effort ATS adapters (auto-skip if a company's shape differs) ---
  async recruitee(token) {
    const d = await getJSON(`https://${token}.recruitee.com/api/offers/`);
    return (d.offers || []).map((o) => ({
      source: `recruitee:${token}`, company: token, title: o.title,
      location: o.location || [o.city, o.country].filter(Boolean).join(", ") || "",
      remote: /remote/i.test(o.location || "") || !!o.remote,
      url: o.careers_url || o.careers_apply_url, tags: [o.department].filter(Boolean), seniority: [], posted: o.created_at }));
  },
  async smartrecruiters(token) {
    const d = await getJSON(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`);
    return (d.content || []).map((pp) => { const l = pp.location || {};
      return { source: `smartrecruiters:${token}`, company: token, title: pp.name,
        location: [l.city, l.region, l.country].filter(Boolean).join(", ") || "",
        remote: !!l.remote || /remote/i.test(l.city || ""),
        url: `https://jobs.smartrecruiters.com/${token}/${pp.id}`,
        tags: [pp.department?.label].filter(Boolean), seniority: [pp.experienceLevel?.label].filter(Boolean), posted: pp.releasedDate }; });
  },
  async workable(token) {
    const d = await getJSON(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`);
    return (d.jobs || []).map((j) => ({
      source: `workable:${token}`, company: d.name || token, title: j.title,
      location: [j.city, j.country].filter(Boolean).join(", ") || j.location || "",
      remote: !!j.remote || /remote/i.test([j.city, j.country, j.title].join(" ")),
      url: j.url || j.application_url || `https://apply.workable.com/${token}/j/${j.shortcode}/`,
      tags: [j.department].filter(Boolean), seniority: [], posted: j.published_on || j.created_at }));
  },
  async personio(token) {
    const r = await fetch(`https://${token}.jobs.personio.com/xml`, { headers: { "User-Agent": "job-sweeper/1.0" } });
    if (!r.ok) throw new Error(`${r.status}`);
    return parsePersonioXML(await r.text(), token);
  },
  async hnhiring() {
    // Monthly "Ask HN: Who is hiring?" thread via the Algolia HN API (no auth).
    const s = await getJSON("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10");
    const story = (s.hits || []).find((h) => /who is hiring\?/i.test(h.title || ""));
    if (!story) return [];
    const out = [];
    for (let page = 0; ; page++) {
      const d = await getJSON(`https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${story.objectID}&hitsPerPage=1000&page=${page}`);
      for (const c of d.hits || []) { const j = parseHNComment(c, story.objectID); if (j) out.push(j); }
      if (page + 1 >= (d.nbPages || 1) || page >= 4) break;
    }
    return out;
  },
  async euremotejobs() { return wpJobFeed("euremotejobs", "https://euremotejobs.com/?feed=job_feed"); },
  async jobspresso() { return wpJobFeed("jobspresso", "https://jobspresso.co/?feed=job_feed"); },
  async nodesk() {
    // Plain Hugo-generated RSS (no WP job_listing namespace); titles are "Role at Company".
    const xml = await (await fetch("https://nodesk.co/remote-jobs/index.xml", { headers: { "User-Agent": "job-sweeper/1.0" } })).text();
    const out = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
      const b = m[1];
      const tag = (t) => { const x = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
      const raw = tag("title"), i = raw.lastIndexOf(" at ");
      out.push({ source: "nodesk", company: i > 0 ? raw.slice(i + 4).trim() : "", title: i > 0 ? raw.slice(0, i).trim() : raw,
        location: "Remote", remote: true, url: tag("link"), tags: [], seniority: [], posted: tag("pubDate"), desc: tag("description") });
    }
    return out;
  },
  async landingjobs() {
    // Probe (2026-07-15) showed no company/city/skills fields as the brief guessed: company must be
    // parsed from the /at/<slug>/ URL path, locations are {country_code} objects, tags are flat strings.
    const a = await getJSON("https://landing.jobs/api/v1/jobs?remote=true");
    const jobs = Array.isArray(a) ? a : a.jobs || [];
    return jobs.map((j) => {
      const slug = j.url && j.url.match(/\/at\/([^/]+)\//);
      return { source: "landingjobs", company: slug ? slug[1].replace(/-/g, " ") : "", title: j.title,
        location: (j.locations || []).map((l) => COUNTRY_NAME[l.country_code] || l.country_code).filter(Boolean).join(", ") || "Remote",
        remote: j.remote !== false, url: j.url, tags: j.tags || [], seniority: [],
        posted: j.published_at || j.created_at, expiry: j.expires_at, desc: j.role_description };
    });
  },
  async "4dayweek"() {
    // Probe (2026-07-15): no url/apply_url field in the API; the real detail page is
    // https://4dayweek.io/job/<slug> (singular "job", confirmed via a company page's outbound links).
    // The plural /jobs/<slug> guess 308-redirects to the generic listing.
    const d = await getJSON("https://4dayweek.io/api/jobs");
    return (d.jobs || []).filter((j) => !j.is_expired && j.slug).map((j) => {
      const primary = (j.locations || []).find((l) => l.is_primary) || (j.locations || [])[0] || {};
      const isRemote = j.work_arrangement === "remote" || (j.locations || []).some((l) => l.work_arrangement === "remote");
      return { source: "4dayweek", company: j.company_name || j.company?.name || "", title: j.title,
        location: [primary.city, primary.country].filter(Boolean).join(", ") || "Remote",
        remote: isRemote, url: `https://4dayweek.io/job/${j.slug}`,
        tags: [j.category].filter(Boolean), seniority: [j.level].filter(Boolean), posted: j.posted };
    });
  },
  async freehire() {
    // freehire.dev aggregates ~50 ATS platforms; public JSON API, {data,meta} envelope.
    // Probe (2026-07-16): url points at the original source posting (justjoin.it, ATS
    // pages...), geography is often unresolved -- regions=none keeps that bucket and our
    // own region filter decides. countries[] map into the location string so the region
    // filter sees real country names (a region of "eu" only means the country is IN the
    // EU, not that the role hires EU-wide -- it must not act as an allow signal). The
    // exhaustive skills[] list stays out of tags: it would trip langExcluded on incidental
    // android/python mentions; the stack signal comes from the description instead.
    const out = [];
    for (const q of ["react", "full stack", "node", "typescript"]) {
      const params = new URLSearchParams({ q, limit: "50", offset: "0", semantic_ratio: "0",
        posted_within_days: String(MAX_AGE_DAYS), work_mode: "remote" });
      for (const r of FREEHIRE_REGIONS) params.append("regions", r);
      const d = await getJSON(`https://freehire.dev/api/v1/jobs/search?${params}`);
      for (const j of d.data || []) {
        const countries = (j.countries || []).map((c) => COUNTRY_NAME[c.toUpperCase()] || c.toUpperCase());
        if ((j.regions || []).includes("global")) countries.push("Worldwide");
        out.push({
          source: "freehire", company: j.company || "", title: j.title,
          location: [j.location, ...countries].filter(Boolean).join(", ") || "Remote",
          remote: true, // work_mode=remote facet applied in the query
          url: j.url, tags: [],
          seniority: [j.enrichment?.seniority].filter(Boolean),
          posted: j.posted_at || j.created_at, desc: j.description });
      }
    }
    return out;
  },
  async linkedin() {
    // LinkedIn's public jobs-guest endpoint (no auth). Automated access is against
    // LinkedIn ToS: personal use only, 3 requests per run, and never from CI --
    // GitHub runner IPs get blocked anyway (same class as the landing.jobs 403).
    if (process.env.GITHUB_ACTIONS) throw new Error("disabled in CI (blocked runner IPs / ToS)");
    const out = [];
    for (const [keywords, location] of LINKEDIN_SEARCHES) {
      const params = new URLSearchParams({ keywords, location, f_WT: "2", f_TPR: `r${MAX_AGE_DAYS * 86400}`, start: "0" });
      const r = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" } });
      if (!r.ok) throw new Error(`${r.status}`);
      out.push(...parseLinkedInCards(await r.text()));
    }
    return out;
  },
};

// probe order for fingerprinting an unknown company slug -> its ATS
const ATS_PROBES = [
  ["greenhouse", (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (d) => d?.jobs?.length],
  ["lever", (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, (d) => Array.isArray(d) && d.length],
  ["ashby", (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, (d) => d?.jobs?.length],
  ["recruitee", (s) => `https://${s}.recruitee.com/api/offers/`, (d) => d?.offers?.length],
  ["smartrecruiters", (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`, (d) => d?.content?.length || d?.totalFound],
  ["workable", (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`, (d) => d?.jobs?.length],
];
async function fingerprint(slug) {
  for (const [ats, mk, ok] of ATS_PROBES) {
    try { if (ok(await getJSON(mk(slug)))) return { ats, token: slug }; } catch { }
  }
  try { const r = await fetch(`https://${slug}.jobs.personio.com/xml`); if (r.ok && /<position>/i.test(await r.text())) return { ats: "personio", token: slug }; } catch { }
  return null;
}

// ---------- staleness + stack helpers ----------
const OFF_STACK_RE = /\b(vue|nuxt|angular|svelte|django|flask|laravel|symfony|rails|ruby|spring|golang)\b/;
const stripTags = (h) => lc(h).replace(/<[^>]+>/g, " ");
function parseWhen(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(v)) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(v); return isNaN(t) ? null : t;
}
function isStale(job) {
  const e = parseWhen(job.expiry); if (e && e < Date.now()) return true;                       // past deadline
  const p = parseWhen(job.posted); if (p && Date.now() - p > MAX_AGE_DAYS * 864e5) return true; // too old
  return false;
}

// ---------- classify / filter / score ----------
const isATS = (j) => /(greenhouse|lever|ashby|recruitee|smartrecruiters|workable|personio):/.test(j.source);
const isIntermediary = (j) => INTERMEDIARY_RE.test(`${j.company} ${j.url} ${j.source}`);

function langExcluded(hay) {
  return LANG_WORDS.test(hay) || LANG_SUBSTR.some((s) => hay.includes(s));
}
function regionOk(job) {
  // Require a region-allow signal (home country / region-wide / worldwide) in location, tags, or description.
  const hay = lc([job.location, (job.tags || []).join(" "), stripTags(job.desc || "")].join(" "));
  if (REGION_ALLOW_RE.test(hay)) return true;
  if (job.timezones && job.timezones.length) return job.timezones.some((t) => PROFILE.timezones.includes(t));
  return false; // bare "Remote", single-other-country, or other-continent only -> drop
}
function passesFilter(job) {
  const t = lc(job.title);
  const hay = t + " " + (job.tags || []).join(" ").toLowerCase();
  if (!ROLE_RE.test(t)) return false;
  if (isStale(job)) return false;
  if (langExcluded(hay)) return false;
  if (anyIn(t, ROLE_EXCLUDE)) return false;
  if (AGGREGATOR_REQUIRE_STACK && !isATS(job) && !STACK_SIGNAL.test(hay) && !STACK_SIGNAL.test(stripTags(job.desc || ""))) return false;
  if (!job.remote) return false;
  if (!regionOk(job)) return false;
  return true;
}
function fitScore(job) {
  const hay = lc([job.title, job.location, (job.tags || []).join(" "), (job.seniority || []).join(" "), stripTags(job.desc || "")].join(" "));
  let s = 0; const why = [];
  const hits = PROFILE.stack.filter((k) => hay.includes(k));
  s += hits.length * 10; if (hits.length) why.push(hits.slice(0, 4).join("/"));
  if (anyIn(hay, PROFILE.seniorityWords) || anyIn((job.seniority || []).map(lc), ["senior", "lead", "staff", "principal"])) { s += 20; why.push("senior"); }
  if (anyIn(lc(job.title), ["full stack", "fullstack", "full-stack"])) { s += 15; why.push("fullstack"); }
  if (isATS(job)) { s += 8; why.push("company site"); }
  if (REGION_ALLOW_RE.test(lc(job.location))) { s += 10; why.push("region fit"); }
  if (OFF_STACK_RE.test(hay) && !/\b(react|next|node)\b/.test(hay)) { s -= 40; why.push("off-stack (Vue/Python/etc.)"); }
  return { score: s, note: why.join(", ") || "title match" };
}

// ---------- dedupe keys ----------
function canonUrl(u) { try { const x = new URL(u); const path = x.host === "news.ycombinator.com" ? x.pathname + x.search : x.pathname; return (x.host + path).toLowerCase().replace(/\/+$/, ""); } catch { return lc(u); } }
// strip stack/qualifier tokens so "Full-Stack Engineer, React/Node" == "Full Stack Engineer (React/Node)"
const STACK_STRIP = /\b(react|reactjs|node|nodejs|next|nextjs|typescript|ts|javascript|js|vue|svelte|remix|graphql|aws|golang|senior|sr)\b/g;
function contentKey(j) {
  const t = lc(j.title).replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").replace(STACK_STRIP, " ").replace(/\s+/g, " ").trim();
  return lc(j.company).trim() + "|" + t;
}
const better = (a, b) => (isATS(a) !== isATS(b) ? isATS(a) : a.score >= b.score); // prefer company site, then score

// applied.json lists companies you've already applied to; exact match on the
// normalized name -- substring matching would false-positive short company
// names (a company "Nova" must not match "Supernova").
const normCompany = (s) => lc(s).replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

function harvestToken(url, watch) {
  const add = (ats, token) => { if (token && !watch.some((w) => w.ats === ats && lc(w.token) === lc(token))) watch.push({ ats, token }); };
  let m;
  if ((m = url?.match(/boards\.greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#&]+)/i))) add("greenhouse", m[1]);
  if ((m = url?.match(/jobs\.lever\.co\/([^/?#]+)/i))) add("lever", m[1]);
  if ((m = url?.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i))) add("ashby", m[1]);
  if ((m = url?.match(/([^./]+)\.recruitee\.com/i))) add("recruitee", m[1]);
  if ((m = url?.match(/jobs\.smartrecruiters\.com\/([^/?#]+)/i))) add("smartrecruiters", m[1]);
  if ((m = url?.match(/apply\.workable\.com\/([^/?#]+)/i)) && m[1] !== "api") add("workable", m[1]);
  if ((m = url?.match(/([^./]+)\.jobs\.personio\.com/i))) add("personio", m[1]);
}

// ---------- main ----------
async function run() {
  const resolve = process.argv.includes("--resolve");
  const seen = new Set(readJSON("seen.json", []));
  const watch = readJSON("watchlist.json", SEED_WATCHLIST);
  const applied = new Set(readJSON("applied.json", []).map(normCompany));
  const all = [];

  for (const name of ["remoteok", "remotive", "jobicy", "himalayas", "arbeitnow", "workingnomads", "weworkremotely", "tryremotely", "hiringcafe", "hnhiring", "euremotejobs", "jobspresso", "nodesk", "landingjobs", "4dayweek", "freehire", "linkedin"]) {
    try { all.push(...(await ADAPTERS[name]())); console.error(`ok   ${name}`); }
    catch (e) { console.error(`skip ${name}: ${e.message}`); }
  }
  // fingerprint new companies -> detect ATS, cache the result so we probe each slug once
  const probed = new Set(readJSON("fingerprinted.json", []));
  const known = new Set(watch.map((w) => lc(w.token)));
  for (const slug of COMPANY_SLUGS) {
    if (known.has(lc(slug)) || probed.has(lc(slug))) continue;
    const f = await fingerprint(slug);
    probed.add(lc(slug));
    if (f) { watch.push(f); known.add(lc(slug)); console.error(`fp   ${slug} -> ${f.ats}`); }
    else console.error(`fp   ${slug} -> none`);
  }
  writeJSON("fingerprinted.json", [...probed]);

  for (const { ats, token } of watch) {
    try { all.push(...(await ADAPTERS[ats](token))); console.error(`ok   ${ats}:${token}`); }
    catch (e) { console.error(`skip ${ats}:${token}: ${e.message}`); }
  }
  for (const j of all) harvestToken(j.url, watch); // self-grow watchlist

  // filter + dedupe (collapse the same role across sources; prefer company site)
  const byKey = new Map();
  let intermediaries = 0, appliedSkips = 0;
  for (const j of all) {
    if (!j.url) continue;
    const uKey = canonUrl(j.url), cKey = contentKey(j);
    if (seen.has(uKey) || seen.has(cKey)) continue;
    if (isIntermediary(j)) { intermediaries++; if (DROP_INTERMEDIARIES) continue; j.via = "intermediary"; }
    if (applied.has(normCompany(j.company))) { appliedSkips++; continue; }
    if (!passesFilter(j)) continue;
    const cand = { ...j, ...fitScore(j), uKey, cKey };
    const prev = byKey.get(cKey);
    if (!prev || better(cand, prev)) byKey.set(cKey, cand);
  }
  let matches = [...byKey.values()].sort((a, b) => b.score - a.score);

  // optionally resolve aggregator links to the real company URL
  if (resolve) {
    for (const m of matches) {
      if (isATS(m)) continue;
      const real = await resolveCompanyUrl(m);
      if (real && real !== m.url) { m.url = real; harvestToken(real, watch); }
    }
  }
  writeJSON("watchlist.json", watch);

  // persist
  const today = new Date().toISOString().slice(0, 10);
  for (const m of matches) { seen.add(canonUrl(m.url)); seen.add(m.cKey); }
  writeJSON("seen.json", [...seen]);
  if (!existsSync(p("matches.csv"))) writeFileSync(p("matches.csv"), "found,score,company,title,location,fit,url\n");
  if (matches.length) {
    const q = (v) => `"${(v ?? "").toString().replace(/"/g, '""')}"`;
    const lines = matches.map((m) => [today, m.score, m.company, m.title, m.location, m.note, m.url].map(q).join(",")).join("\n");
    writeFileSync(p("matches.csv"), lines + "\n", { flag: "a" });
  }
  writeFileSync(p("matches.html"), renderHTML(matches, today)); // email body + attachment

  console.log(`\n${matches.length} new matches (${today})` + (DROP_INTERMEDIARIES ? `  ·  ${intermediaries} intermediary reposts hidden` : "") + (appliedSkips ? `  ·  ${appliedSkips} already-applied companies hidden` : "") + `\n`);
  for (const m of matches.slice(0, 40))
    console.log(`  [${String(m.score).padStart(3)}] ${m.title} — ${m.company}\n        ${m.location} · ${m.note}\n        ${m.url}`);
}

// ---------- self-test (offline) ----------
function selftest() {
  // Fixed fixture profile (not the user's profile.config.mjs) so the selftest is
  // deterministic no matter how the config is edited. Region fixture: a candidate
  // in the Netherlands who can work Europe-wide.
  PROFILE = {
    stack: ["react", "next", "typescript", "javascript", "node", "graphql", "postgres", "aws"],
    seniorityWords: ["senior", "sr ", "sr.", "staff", "principal", "lead"],
    timezones: [-1, 0, 1, 2, 3],
    headline: "Senior fullstack (React / Node)",
  };
  REGION_ALLOW_RE = /\b(eu|emea|europe|european|cet|cest|netherlands|amsterdam|benelux|worldwide|anywhere|global)\b/i;
  MAX_AGE_DAYS = 45;
  const S = [
    { source: "himalayas", company: "Connection", title: "Sr Front End Developer", location: "United States", remote: true, url: "https://x.io/u1", tags: ["React"], seniority: ["Senior"] },
    { source: "himalayas", company: "Nebo", title: "Junior Marketing Project Manager", location: "United States", remote: true, url: "https://x.io/u2", tags: [], seniority: [] },
    { source: "lever:jobgether", company: "Jobgether", title: "Senior Full Stack Engineer (React/Node)", location: "Remote, Europe", remote: true, url: "https://jobs.lever.co/jobgether/u3", tags: [], seniority: [] },
    { source: "remotive", company: "AcmeJava", title: "Senior Software Engineer (Java, Spring)", location: "Remote, Europe", remote: true, url: "https://x.io/u4", tags: ["java"], seniority: [] },
    { source: "remotive", company: "Generic", title: "Senior Software Engineer", location: "Remote, Europe", remote: true, url: "https://x.io/u5", tags: [], seniority: [] },
    { source: "ashby:supabase", company: "supabase", title: "Senior Software Engineer", location: "Remote EMEA", remote: true, url: "https://jobs.ashbyhq.com/supabase/u6", tags: [], seniority: [] },
    { source: "remotive", company: "GoodCo", title: "Senior Full Stack Engineer (React/Node)", location: "Remote, Europe", remote: true, url: "https://goodco.com/u7", tags: ["typescript", "graphql"], seniority: ["Senior"] },
    { source: "greenhouse:goodco", company: "GoodCo", title: "Senior Full-Stack Engineer, React / Node", location: "Anywhere (EU)", remote: true, url: "https://boards.greenhouse.io/goodco/u8", tags: [], seniority: [] },
    { source: "recruitee:mollie", company: "mollie", title: "Senior Software Engineer", location: "Remote (EU)", remote: true, url: "https://mollie.recruitee.com/o/u9", tags: [], seniority: [] },
    { source: "remotive", company: "USRemote", title: "Senior React Developer", location: "Remote", remote: true, url: "https://x.io/u10", tags: [], seniority: ["Senior"] },
    { source: "remotive", company: "EUOpen", title: "Senior React Developer", location: "Remote", remote: true, url: "https://x.io/u11", tags: [], seniority: ["Senior"], desc: "Open to candidates anywhere in Europe." },
    { source: "remotive", company: "DescStack", title: "Senior Software Engineer", location: "Remote, Europe", remote: true, url: "https://x.io/u12", tags: [], seniority: [], desc: "Our stack is React, Node and TypeScript." },
    { source: "remotive", company: "DescNone", title: "Senior Software Engineer", location: "Remote, Europe", remote: true, url: "https://x.io/u13", tags: [], seniority: [], desc: "You will own our billing platform end to end." },
    // freehire: single-country Poland role (countries mapped into location) -> not workable from NL -> drop
    { source: "freehire", company: "VITA", title: "Senior Full Stack Developer", location: "Warszawa, Poland", remote: true, url: "https://justjoin.it/job-offer/u14", tags: [], seniority: [], desc: "Our stack is React, TypeScript and Node." },
    // freehire: unresolved geography (empty regions) and no allow signal anywhere -> drop
    { source: "freehire", company: "NoGeo", title: "Senior Full Stack Developer (React)", location: "Remote", remote: true, url: "https://x.io/u15", tags: [], seniority: [], desc: "React and Node." },
    // freehire: Netherlands role -> workable -> keep
    { source: "freehire", company: "Kassa", title: "Senior Full Stack Developer", location: "Amsterdam, Netherlands", remote: true, url: "https://x.io/u16", tags: [], seniority: [], desc: "React, TypeScript and Node." },
    // single-other-EU-country restriction (Germany-only) -> not workable from NL -> drop
    { source: "remotive", company: "BerlinOnly", title: "Senior Full Stack Engineer (React/Node)", location: "Remote, Germany", remote: true, url: "https://x.io/u17", tags: [], seniority: [], desc: "React and Node. You must be based in Germany." },
    // multi-country list that includes the Netherlands -> keep
    { source: "remotive", company: "MultiEU", title: "Senior Full Stack Engineer (React/Node)", location: "Germany (Remote); Netherlands (Remote); Spain (Remote)", remote: true, url: "https://x.io/u18", tags: [], seniority: [], desc: "React and Node." },
  ];
  const expectKeep = { "https://x.io/u1": false, "https://x.io/u2": false, "https://jobs.lever.co/jobgether/u3": false, "https://x.io/u4": false, "https://x.io/u5": false, "https://jobs.ashbyhq.com/supabase/u6": true, "https://goodco.com/u7": true, "https://boards.greenhouse.io/goodco/u8": true, "https://mollie.recruitee.com/o/u9": true, "https://x.io/u10": false, "https://x.io/u11": true, "https://x.io/u12": true, "https://x.io/u13": false, "https://justjoin.it/job-offer/u14": false, "https://x.io/u15": false, "https://x.io/u16": true, "https://x.io/u17": false, "https://x.io/u18": true };
  let pass = 0;
  for (const j of S) {
    const inter = isIntermediary(j) && DROP_INTERMEDIARIES;
    const keep = !inter && passesFilter(j);
    const ok = keep === expectKeep[j.url];
    pass += ok ? 1 : 0;
    console.log(`${ok ? "PASS" : "FAIL"} keep=${keep} ${inter ? "(intermediary) " : ""}${j.title} [${j.company}]`);
  }
  // dedupe: u7 (aggregator) + u8 (greenhouse) are the same role -> collapse to the company-site one
  const dd = new Map();
  for (const j of S.filter((x) => passesFilter(x) && !isIntermediary(x))) {
    const c = { ...j, ...fitScore(j) }; const k = contentKey(j); const prev = dd.get(k);
    if (!prev || better(c, prev)) dd.set(k, c);
  }
  const good = dd.get(contentKey(S[6]));
  const dedupeOk = [...dd.values()].filter((m) => lc(m.company) === "goodco").length === 1 && isATS(good);
  console.log(`${dedupeOk ? "PASS" : "FAIL"} dedupe GoodCo -> 1 row, company-site preferred (${good?.url})`);
  const ex = `<a class="apply" href="https://boards.greenhouse.io/acme/jobs/123?gh_src=x">Apply</a>`.match(ATS_URL_RE)?.[0];
  const extractorOk = ex === "https://boards.greenhouse.io/acme/jobs/123?gh_src=x";
  console.log(`${extractorOk ? "PASS" : "FAIL"} resolver extracts ATS link from page HTML (${ex})`);
  const expired = { source: "himalayas", company: "X", title: "Senior Software Engineer", location: "Remote (EU)", remote: true, url: "u", tags: [], seniority: [], expiry: Math.floor((Date.now() - 864e5) / 1000) };
  const expiryOk = !passesFilter(expired);
  console.log(`${expiryOk ? "PASS" : "FAIL"} drops expired posting (past deadline)`);
  const offNote = fitScore({ title: "Senior Full-Stack Engineer", location: "Remote (EU)", tags: [], seniority: ["Senior"], desc: "We build with Vue, Django and PostgreSQL." }).note;
  const offOk = /off-stack/.test(offNote);
  console.log(`${offOk ? "PASS" : "FAIL"} flags off-stack Vue/Django role (${offNote})`);
  const hnGood = { parent_id: 44001, objectID: "44002", created_at: new Date(Date.now() - 2 * 864e5).toISOString(),
    comment_text: `Acme Corp | Senior Full Stack Engineer | Remote (EU)<p>We build with React, TypeScript and Node on AWS.</p><p>Apply: <a href="https://jobs.acme.io/senior-fs" rel="nofollow">https:&#x2F;&#x2F;jobs.acme.io&#x2F;senior-fs</a></p>` };
  const hnReply = { parent_id: 44002, objectID: "44003", created_at: new Date().toISOString(), comment_text: "Is this open to contractors?" };
  const hj = parseHNComment(hnGood, "44001");
  const hnOk = !!hj && hj.company === "Acme Corp" && hj.title === "Senior Full Stack Engineer"
    && hj.url === "https://jobs.acme.io/senior-fs" && hj.remote === true && passesFilter(hj)
    && parseHNComment(hnReply, "44001") === null;
  console.log(`${hnOk ? "PASS" : "FAIL"} HN parser -> filterable job (${hj?.title} @ ${hj?.company})`);
  // no-href postings (e.g. contact-by-email) fall back to the HN permalink; two distinct
  // comments must canonicalize to distinct dedupe keys, or the second is silently swallowed.
  const hnNoHref1 = { parent_id: 44001, objectID: "55001", created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
    comment_text: `Beta GmbH | Senior Full Stack Engineer | Remote (EU)<p>React, TypeScript and Node. No link -- email jobs@beta.example with your CV.</p>` };
  const hnNoHref2 = { parent_id: 44001, objectID: "55002", created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
    comment_text: `Gamma AB | Senior Full Stack Engineer | Remote (EU)<p>React, TypeScript and Node. No link -- email jobs@gamma.example with your CV.</p>` };
  const hj1 = parseHNComment(hnNoHref1, "44001");
  const hj2 = parseHNComment(hnNoHref2, "44001");
  const hnUrlOk = !!hj1 && !!hj2
    && hj1.url === "https://news.ycombinator.com/item?id=55001"
    && hj2.url === "https://news.ycombinator.com/item?id=55002"
    && canonUrl(hj1.url) !== canonUrl(hj2.url);
  console.log(`${hnUrlOk ? "PASS" : "FAIL"} HN no-href fallback URLs distinct per objectID (${hj1?.url} -> ${canonUrl(hj1?.url)} | ${hj2?.url} -> ${canonUrl(hj2?.url)})`);
  // LinkedIn jobs-guest card fragment -> normalized, filterable job
  const liHtml = `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:4270000001">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/senior-full-stack-engineer-at-acme-4270000001?position=1&amp;pageNum=0">Senior Full Stack Engineer</a>
      <h3 class="base-search-card__title"> Senior Full Stack Engineer </h3>
      <h4 class="base-search-card__subtitle"><a href="https://nl.linkedin.com/company/acme?trk=x">Acme B.V.</a></h4>
      <span class="job-search-card__location">Amsterdam, North Holland, Netherlands</span>
      <time class="job-search-card__listdate" datetime="${new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10)}">5 days ago</time></div></li>`;
  const lj = parseLinkedInCards(liHtml)[0];
  const liOk = !!lj && lj.company === "Acme B.V." && lj.title === "Senior Full Stack Engineer"
    && lj.url === "https://www.linkedin.com/jobs/view/senior-full-stack-engineer-at-acme-4270000001"
    && lj.location.includes("Netherlands") && passesFilter(lj);
  console.log(`${liOk ? "PASS" : "FAIL"} LinkedIn card parser -> filterable job (${lj?.title} @ ${lj?.company})`);
  const appliedSet = new Set(["rocket io", "nova", "nova health"].map(normCompany));
  const appliedOk = normCompany("Rocket.IO") === "rocket io"
    && appliedSet.has(normCompany("Rocket.io")) && appliedSet.has(normCompany("Nova"))
    && !appliedSet.has(normCompany("Novaview Labs")) && appliedSet.has(normCompany("Nova Health (formerly FitTrack)"));
  console.log(`${appliedOk ? "PASS" : "FAIL"} applied-company normalization (exact match, no substring false positives)`);
  const refHtml = renderHTML([{ score: 42, url: "https://x.io/j", title: "Senior Full Stack Engineer (React/Node)", company: "GoodCo", location: "Remote (EU)", note: "senior" }], "2026-07-16");
  const refOk = refHtml.includes(encodeURIComponent("GoodCo recruiter")) && refHtml.includes(encodeURIComponent("GoodCo Senior Full Stack Engineer"));
  console.log(`${refOk ? "PASS" : "FAIL"} email rows carry recruiter + peers LinkedIn search links`);
  console.log(`\n${pass}/${S.length} filter + dedupe ${dedupeOk ? "ok" : "FAIL"} + resolver ${extractorOk ? "ok" : "FAIL"} + expiry ${expiryOk ? "ok" : "FAIL"} + stackfit ${offOk ? "ok" : "FAIL"} + hn ${hnOk ? "ok" : "FAIL"} + hnUrl ${hnUrlOk ? "ok" : "FAIL"} + linkedin ${liOk ? "ok" : "FAIL"} + applied ${appliedOk ? "ok" : "FAIL"} + referral ${refOk ? "ok" : "FAIL"}`);
  process.exit(pass === S.length && dedupeOk && extractorOk && expiryOk && offOk && hnOk && hnUrlOk && liOk && appliedOk && refOk ? 0 : 1);
}

process.argv.includes("--selftest") ? selftest() : run();

// profile.example.config.mjs — copy this file and make it yours:
//   cp profile.example.config.mjs profile.config.mjs
//
// Everything personal about the sweep lives here: what you do, where you can
// work from, and which companies you want checked every day. The example
// profile is a senior React/TypeScript developer working remotely from Europe.
// profile.config.mjs is gitignored, so your edits stay out of version control.

export const PROFILE = {
  // Keywords that raise a job's fit score (case-insensitive substring match
  // against title, location, tags and description).
  stack: ["react", "next", "typescript", "javascript", "node", "graphql", "postgres", "aws"],
  // Words that mark a role as senior enough to count toward the score.
  seniorityWords: ["senior", "sr ", "sr.", "staff", "principal", "lead"],
  // UTC offsets you can work in: the fallback for sources that publish timezone
  // restrictions instead of countries (e.g. Himalayas). -1..3 covers Europe.
  timezones: [-1, 0, 1, 2, 3],
  // One-line description of you, shown in the emailed shortlist header.
  headline: "Senior fullstack (React / Node)",
};

// A posting must show one of these signals in its location, tags, or
// description to count as workable from where you live. Keep tokens
// word-boundaried (\b) so short ones like "eu" don't match inside words.
// Add your own country and city so single-country roles from home still pass,
// e.g. |netherlands|amsterdam for someone in the Netherlands. Roles restricted
// to a single OTHER country deliberately don't qualify: a Berlin-only role
// usually can't hire from elsewhere, however remote it claims to be.
export const REGION_ALLOW_RE = /\b(eu|emea|europe|european|cet|cest|worldwide|anywhere|global)\b/i;

// Drop postings older than this many days (also passed to sources that filter
// by age server-side).
export const MAX_AGE_DAYS = 45;

// ATS boards swept on every run: { ats, token } where token is the company's
// slug on that ATS. The list self-grows at runtime: any company whose ATS link
// shows up in an aggregator feed is added to watchlist.json automatically.
export const SEED_WATCHLIST = [
  { ats: "ashby", token: "supabase" },
  { ats: "ashby", token: "posthog" },
  { ats: "ashby", token: "linear" },
  { ats: "greenhouse", token: "gitlab" },
  { ats: "greenhouse", token: "elastic" },
  { ats: "greenhouse", token: "docker" },
  { ats: "lever", token: "netlify" },
];

// Companies you care about whose ATS you don't know. On first run each slug is
// probed against every supported ATS ("fingerprinting"); hits join the
// watchlist, misses are cached in fingerprinted.json and never probed again.
// The slug is usually the company name in lowercase; a wrong guess simply
// finds nothing.
export const COMPANY_SLUGS = [
  "vercel", "sentry", "algolia", "grafanalabs", "sourcegraph", "zapier", "miro",
];

// Region buckets requested from freehire.dev. "global" = worldwide roles,
// "none" = postings whose geography freehire couldn't resolve (kept on purpose:
// REGION_ALLOW_RE above still decides). Swap "eu" for your own region bucket.
export const FREEHIRE_REGIONS = ["eu", "global", "none"];

// LinkedIn public job searches as [keywords, location] pairs. Local runs only:
// the adapter refuses to run in CI (LinkedIn ToS allows personal use at most,
// and GitHub runner IPs are blocked anyway).
export const LINKEDIN_SEARCHES = [
  ["senior full stack engineer", "European Union"],
  ["react developer", "European Union"],
];

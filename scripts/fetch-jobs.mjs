// Refreshes jobs.json from the two feeds our source probe found to be
// reachable, crawl-allowed, and to actually publish RSS/Atom feeds
// (see scripts/probe-sources.mjs and its logged results). Run daily by
// .github/workflows/update-jobs.yml. Leaves jobs.json untouched if both
// feeds fail, so a transient outage never wipes out good data.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FEEDS = [
  { url: "https://www.freejobalert.com/feed/", type: "rss", source: "Free Job Alert" },
  { url: "https://www.sarkarinaukriblog.com/feeds/posts/default", type: "atom", source: "Sarkari Naukri Blog" },
];

const UA = "Mozilla/5.0 (compatible; MetroLibraryJobsBot/1.0; +https://metrolibrary.in)";
const TIMEOUT_MS = 15000;
const MAX_JOBS = 18;

const BOARD_PATTERNS = [
  ["UPSSSC", /upsssc/i],
  ["UPPSC", /uppsc/i],
  ["UP Police", /up\s*police|uppbpb/i],
  ["SSC", /\bssc\b/i],
  ["UPSC", /\bupsc\b/i],
  ["Railway (RRB)", /\brrb\b|railway/i],
  ["IBPS", /\bibps\b/i],
  ["Bank", /\bbank\b/i],
  ["Police", /\bpolice\b/i],
  ["Army", /\barmy\b/i],
  ["Defence", /defen[cs]e/i],
];

const STATE_HINT = /uttar pradesh|\bup\s*police\b|upsssc|uppsc|uppbpb/i;

// Other states' own commissions/boards and names — these postings aren't
// relevant to a UP audience and, since our board detection above only
// recognizes UP + central boards, would otherwise fall through and get
// mislabeled as "Central". Drop them instead of mislabeling them.
const OTHER_STATE_HINT =
  /gujarat|\bgpsc\b|maharashtra|\bmpsc\b|madhya pradesh|\bmppsc\b|tamil nadu|\btnpsc\b|west bengal|\bwbpsc\b|rajasthan|\brpsc\b|\bharyana\b|\bhpsc\b|\bbihar\b|\bbpsc\b|jharkhand|\bjpsc\b|\bodisha\b|\bopsc\b|karnataka|\bkpsc\b|andhra pradesh|\bappsc\b|telangana|\btspsc\b|\bpunjab\b|\bppsc\b|uttarakhand|\bukpsc\b|\bkerala\b|\bassam\b|\bapsc\b|chhattisgarh|\bcgpsc\b|\bgoa\b|himachal|\bhppsc\b|\bjkpsc\b|manipur|meghalaya|mizoram|nagaland|\bsikkim\b|tripura/i;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return null;
  const cdata = match[1].trim().match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return decodeEntities(cdata ? cdata[1] : match[1]);
}

function parseRss(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml))) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const date = extractTag(block, "pubDate");
    if (title && link) items.push({ title, link, date, source });
  }
  return items;
}

function parseAtom(xml, source) {
  const items = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml))) {
    const block = match[1];
    const title = extractTag(block, "title");
    const linkMatch =
      block.match(/<link[^>]+rel=['"]alternate['"][^>]*href=['"]([^'"]+)['"]/i) ||
      block.match(/<link[^>]+href=['"]([^'"]+)['"]/i);
    const link = linkMatch ? decodeEntities(linkMatch[1]) : null;
    const date = extractTag(block, "published") || extractTag(block, "updated");
    if (title && link) items.push({ title, link, date, source });
  }
  return items;
}

function detectBoard(title) {
  for (const [name, pattern] of BOARD_PATTERNS) {
    if (pattern.test(title)) return name;
  }
  return null;
}

function detectCategory(title, board) {
  if (STATE_HINT.test(title) || board === "UPSSSC" || board === "UPPSC" || board === "UP Police") {
    return "state";
  }
  return "central";
}

async function fetchFeed(feed) {
  try {
    const res = await fetchWithTimeout(feed.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, text/xml" } });
    if (!res.ok) {
      console.log(`Skipping ${feed.source}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = feed.type === "rss" ? parseRss(xml, feed.source) : parseAtom(xml, feed.source);
    console.log(`${feed.source}: fetched ${items.length} items`);
    return items;
  } catch (err) {
    console.log(`Skipping ${feed.source}: ${err && err.message ? err.message : err}`);
    return [];
  }
}

const results = await Promise.all(FEEDS.map(fetchFeed));
const all = results.flat();

if (!all.length) {
  console.log("No items fetched from any feed; leaving jobs.json unchanged.");
  process.exit(0);
}

const seen = new Set();
const deduped = all.filter((item) => {
  if (seen.has(item.link)) return false;
  seen.add(item.link);
  return true;
});

const relevant = deduped.filter((item) => !OTHER_STATE_HINT.test(item.title));
console.log(`Filtered out ${deduped.length - relevant.length} other-state postings (${relevant.length} remain)`);

relevant.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

const jobs = relevant.slice(0, MAX_JOBS).map((item, i) => {
  const board = detectBoard(item.title) || item.source;
  return {
    id: `job-${i}-${Buffer.from(item.link).toString("base64url").slice(0, 12)}`,
    title: item.title,
    board,
    category: detectCategory(item.title, board),
    postedDate: item.date ? new Date(item.date).toISOString() : null,
    link: item.link,
  };
});

const output = {
  lastUpdated: new Date().toISOString(),
  sample: false,
  jobs,
};

const jobsJsonPath = fileURLToPath(new URL("../jobs.json", import.meta.url));
writeFileSync(jobsJsonPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote ${jobs.length} jobs to jobs.json`);

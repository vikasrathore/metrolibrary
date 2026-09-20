// One-off research script: checks candidate govt-job sources for a robots.txt,
// a likely RSS/Atom feed, and basic reachability, so we can pick real data
// sources for the daily job-refresh pipeline based on evidence, not guesses.
// Run manually via the "Probe Job Sources" GitHub Action. Prints a report to
// the workflow logs; does not write any files.

const CANDIDATES = [
  { name: "UPSSSC", url: "https://upsssc.gov.in" },
  { name: "UPPSC", url: "https://uppsc.up.nic.in" },
  { name: "UP Police (UPPBPB)", url: "https://uppbpb.gov.in" },
  { name: "SSC", url: "https://ssc.nic.in" },
  { name: "UPSC", url: "https://upsc.gov.in" },
  { name: "RRB (Railway)", url: "https://rrbapply.gov.in" },
  { name: "Employment News", url: "https://employmentnews.gov.in" },
  { name: "Sarkari Result", url: "https://www.sarkariresult.com" },
  { name: "Free Job Alert", url: "https://www.freejobalert.com" },
  { name: "Sarkari Naukri Blog", url: "https://www.sarkarinaukriblog.com" },
];

const FEED_PATHS = ["/feed", "/feed/", "/rss.xml", "/feed.xml", "/rss", "/atom.xml"];
const TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function checkRobots(baseUrl) {
  try {
    const res = await fetchWithTimeout(new URL("/robots.txt", baseUrl).toString());
    if (!res.ok) return { found: false };
    const text = await res.text();
    return { found: true, disallowsAll: /Disallow:\s*\/\s*$/m.test(text), snippet: text.slice(0, 300) };
  } catch {
    return { found: false };
  }
}

async function checkHomepage(baseUrl) {
  try {
    const res = await fetchWithTimeout(baseUrl, { method: "GET" });
    const text = await res.text();
    const feedLinkMatch = text.match(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/i);
    return { ok: res.ok, status: res.status, length: text.length, declaredFeedTag: feedLinkMatch ? feedLinkMatch[0] : null };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function checkFeedPaths(baseUrl) {
  const found = [];
  for (const path of FEED_PATHS) {
    try {
      const res = await fetchWithTimeout(new URL(path, baseUrl).toString());
      const contentType = res.headers.get("content-type") || "";
      if (res.ok && /xml|rss|atom/i.test(contentType)) {
        found.push({ path, contentType });
      }
    } catch {
      // ignore, try next path
    }
  }
  return found;
}

async function probe(candidate) {
  const [robots, homepage, feeds] = await Promise.all([
    checkRobots(candidate.url),
    checkHomepage(candidate.url),
    checkFeedPaths(candidate.url),
  ]);
  return { ...candidate, robots, homepage, feeds };
}

const results = await Promise.all(CANDIDATES.map(probe));

console.log("\n=== Govt Job Source Probe Report ===\n");
for (const r of results) {
  console.log(`--- ${r.name} (${r.url}) ---`);
  console.log(`  homepage: ${r.homepage.ok ? "reachable" : "FAILED"} (status ${r.homepage.status ?? "n/a"}${r.homepage.error ? ", error: " + r.homepage.error : ""})`);
  console.log(`  robots.txt: ${r.robots.found ? (r.robots.disallowsAll ? "found, DISALLOWS ALL crawling" : "found, crawling appears allowed") : "not found"}`);
  console.log(`  declared feed tag on homepage: ${r.homepage.declaredFeedTag || "none"}`);
  console.log(`  feed paths found: ${r.feeds.length ? r.feeds.map(f => f.path).join(", ") : "none"}`);
  console.log("");
}

console.log("=== Summary (usable candidates) ===");
for (const r of results) {
  const usable = r.homepage.ok && !(r.robots.disallowsAll) && (r.feeds.length > 0 || r.homepage.declaredFeedTag);
  if (usable) {
    console.log(`✔ ${r.name} — has a feed and allows crawling`);
  }
}

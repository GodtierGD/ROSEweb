/**
 * ROSE Demonlist — Cloudflare Worker API
 *
 * Routes:
 *   GET /api/list              -> clan's AREDL records, straight from AREDL (cached)
 *   GET /api/monthly           -> the same records, grouped by achieved_at month
 *   GET /api/progress          -> per-player progress, from the "PROGRESS" tab of a Google Sheet
 *   GET /api/videos            -> channel upload feed (non-YouTube-API), cached
 *   GET /api/unrated           -> rows from the "UNRATED" tab of a public Google Sheet
 *
 * Bindings expected (see wrangler.toml):
 *   CACHE               KV namespace       — short-lived cache for AREDL + Sheets responses
 *   AREDL_API_BASE      var                — e.g. "https://api.aredl.net"
 *   AREDL_CLAN_ID       var                — ROSE's clan UUID on AREDL
 *   CLAN_SHEET_ID       var                — the Google Sheet's id (the long string in its URL);
 *                                            backs the "UNRATED" and "PROGRESS" tabs
 *   VIDEO_FEED_URL      var (optional)     — RSS/JSON feed for the channel's uploads
 *
 * /api/list and /api/monthly both come from one AREDL endpoint:
 * GET /v2/api/aredl/clan/{AREDL_CLAN_ID} — no auth required. It returns the
 * clan's first victor/verifier per level (with achieved_at, video_url,
 * level position/points), plus members_points. It does NOT include every
 * clan member who's beaten a level, only the first — so there's no
 * "followingVictors" data available from this endpoint; that field is
 * simply omitted from /api/list for now. D1 and the sheet's old "Records"
 * tab are no longer used anywhere in this file.
 */
 
const JSON_HEADERS = {
  "content-type": "application/json;charset=UTF-8",
  "access-control-allow-origin": "*",
};
 
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
 
    try {
      if (pathname === "/api/list") return await handleList(env, ctx);
      if (pathname === "/api/monthly") return await handleMonthly(env, ctx);
      if (pathname === "/api/progress") return await handleProgress(env, ctx);
      if (pathname === "/api/videos") return await handleVideos(env, ctx);
      if (pathname === "/api/unrated") return await handleUnrated(env, ctx);
      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error", detail: String(err) }, 500);
    }
  },
};
 
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
 
async function cached(env, key, ttlSeconds, loader) {
  const hit = await env.CACHE.get(key, "json").catch(() => null);
  if (hit) return hit;
  const fresh = await loader();
  await env.CACHE.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds }).catch(() => {});
  return fresh;
}
 
/* ============================================================
   /api/list — the clan's AREDL records (first victor per level),
   straight from AREDL's clan profile endpoint.
   ============================================================ */
async function handleList(env) {
  const [profile, creatorByLevelId] = await Promise.all([
    getClanProfileCached(env),
    getCreatorLookupCached(env),
  ]);
 
  const entries = profile.records.map((r) => recordToLevelEntry(r, creatorByLevelId));
  return json(entries.sort((a, b) => a.rank - b.rank));
}
 
/* ============================================================
   /api/monthly — the same records, grouped by the month each was
   achieved (AREDL's own `achieved_at` field), newest month first.
   No D1, no manual snapshotting — this is always live.
   ============================================================ */
async function handleMonthly(env) {
  const [profile, creatorByLevelId] = await Promise.all([
    getClanProfileCached(env),
    getCreatorLookupCached(env),
  ]);
 
  const sorted = [...profile.records].sort(
    (a, b) => new Date(b.achieved_at) - new Date(a.achieved_at)
  );
 
  const grouped = {};
  for (const r of sorted) {
    const label = new Date(r.achieved_at).toLocaleString("en-US", { month: "long", year: "numeric" });
    (grouped[label] ||= []).push(recordToLevelEntry(r, creatorByLevelId));
  }
  for (const label in grouped) grouped[label].sort((a, b) => a.rank - b.rank);
  return json(grouped);
}
 
function recordToLevelEntry(r, creatorByLevelId) {
  return {
    rank: r.level.position,
    id: r.level.id,
    name: r.level.name,
    creator: creatorByLevelId.get(r.level.id) ?? "Unknown",
    verifier: r.submitted_by.global_name || r.submitted_by.username,
    points: r.level.points ?? null,
    videoUrl: r.video_url || null,
    achievedAt: r.achieved_at,
  };
}
 
/* ------------------------------------------------------------
   AREDL fetch helpers — all public, no auth required.
   ------------------------------------------------------------ */
async function getClanProfileCached(env) {
  return cached(env, "clan-profile:v1", 300, () => fetchClanProfile(env));
}
 
async function fetchClanProfile(env) {
  const res = await fetch(`${env.AREDL_API_BASE}/v2/api/aredl/clan/${env.AREDL_CLAN_ID}`);
  if (!res.ok) throw new Error(`AREDL clan fetch failed: ${res.status}`);
  return res.json();
}
 
async function fetchAredlLevels(env) {
  const res = await fetch(`${env.AREDL_API_BASE}/v2/api/aredl/levels`);
  if (!res.ok) throw new Error(`AREDL level list fetch failed: ${res.status}`);
  return res.json();
}
 
// level.id -> creator/publisher display name, built from one bulk fetch of
// every AREDL level rather than one request per clan-beaten level.
async function getCreatorLookupCached(env) {
  return new Map(
    Object.entries(
      await cached(env, "creator-lookup:v1", 1800, async () => {
        const levels = await fetchAredlLevels(env);
        const entries = levels.map((lvl) => [
          lvl.id,
          lvl.publisher?.global_name ??
            lvl.publisher?.username ??
            lvl.creators?.map((c) => c.global_name || c.username).join(", ") ??
            "Unknown",
        ]);
        return Object.fromEntries(entries);
      })
    )
  );
}
 
/* ============================================================
   /api/progress — from the "PROGRESS" tab of the Google Sheet
   ============================================================ */
async function handleProgress(env) {
  const rows = await cached(env, "progress:v1", 300, async () => {
    const raw = await fetchSheetRows(env, "PROGRESS");
    // Expect sheet columns: player | level | pct | status
    return raw
      .filter((row) => row.player && row.level)
      .map((row) => ({
        player: row.player,
        level: row.level,
        pct: Number(row.pct) || 0,
        status: row.status || (Number(row.pct) >= 100 ? "Completed" : "In progress"),
      }));
  });
 
  const byPlayer = {};
  for (const row of rows) {
    byPlayer[row.player] = byPlayer[row.player] || { player: row.player, entries: [] };
    byPlayer[row.player].entries.push({ level: row.level, pct: row.pct, status: row.status });
  }
  // Highest progress first within each player, matching the old D1 ordering.
  Object.values(byPlayer).forEach((p) => p.entries.sort((a, b) => b.pct - a.pct));
  return json(Object.values(byPlayer));
}
 
/* ============================================================
   /api/videos — non-YouTube-API feed, cached aggressively
   ============================================================ */
async function handleVideos(env) {
  const data = await cached(env, "videos:v1", 900, async () => {
    if (!env.VIDEO_FEED_URL) return [];
    const res = await fetch(env.VIDEO_FEED_URL);
    if (!res.ok) throw new Error(`video feed fetch failed: ${res.status}`);
    const feedText = await res.text();
    return parseVideoFeed(feedText);
  });
  return json(data);
}
 
// Minimal RSS <item> parser — works for most channel/RSS-style feeds
// without pulling in an XML library. Swap this out for whatever your
// actual feed source returns (JSON feed, sitemap, etc).
function parseVideoFeed(xml) {
  const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return items.slice(0, 12).map((item) => ({
    title: (item.match(/<title>(.*?)<\/title>/) || [])[1] || "Untitled",
    url: (item.match(/<link rel="alternate" href="(.*?)"/) || [])[1] || "#",
    channel: (item.match(/<author><name>(.*?)<\/name>/) || [])[1] || "",
    published: (item.match(/<published>(.*?)<\/published>/) || [])[1] || new Date().toISOString(),
    thumb: null,
  }));
}
 
/* ============================================================
   Google Sheets helper — reads a named tab of a public sheet via
   the gviz endpoint (no service account needed, sheet just needs
   to be shared as "anyone with the link can view"). Returns rows
   as plain objects keyed by lowercased column header.
   ============================================================ */
async function fetchSheetRows(env, tabName) {
  const sheetUrl =
    `https://docs.google.com/spreadsheets/d/${env.CLAN_SHEET_ID}` +
    `/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(tabName)}`;
 
  const res = await fetch(sheetUrl);
  if (!res.ok) throw new Error(`Sheets fetch failed for tab "${tabName}": ${res.status}`);
  const text = await res.text();
 
  // Response is wrapped: google.visualization.Query.setResponse({...});
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const payload = JSON.parse(text.slice(start, end + 1));
 
  const cols = payload.table.cols.map((c, i) => (c.label || `col${i}`).trim().toLowerCase());
  return payload.table.rows.map((r) => {
    const row = {};
    r.c.forEach((cell, i) => {
      row[cols[i]] = cell ? (cell.f ?? cell.v) : "";
    });
    return row;
  });
}
 
/* ============================================================
   /api/unrated — reads the "UNRATED" tab of the Google Sheet
   ============================================================ */
async function handleUnrated(env) {
  const data = await cached(env, "unrated:v1", 300, async () => {
    const rows = await fetchSheetRows(env, "UNRATED");
    // Expect sheet columns: name | creator | verifier | note
    return rows
      .filter((row) => row.name)
      .map((row) => ({
        name: row.name,
        creator: row.creator || "Unknown",
        verifier: row.verifier || row.player || "Unknown",
        note: row.note || "",
      }));
  });
  return json(data);
}
 
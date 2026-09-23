/**
 * RIFT Demonlist — Cloudflare Worker API
 *
 * Routes:
 *   GET /api/list              -> clan's rated beats, from AREDL (cached)
 *   GET /api/monthly           -> beats grouped by month, from D1 snapshots
 *   GET /api/progress          -> per-player progress, from D1
 *   GET /api/videos            -> channel upload feed (non-YouTube-API), cached
 *   GET /api/unrated           -> rows from the "UNRATED" tab of a public Google Sheet
 *
 * Bindings expected (see wrangler.toml):
 *   DB                 D1 database        — monthly snapshots, progress, video cache rows
 *   CACHE               KV namespace       — short-lived cache for AREDL + Sheets responses
 *   AREDL_API_BASE      var                — e.g. "https://api.aredl.net"
 *   AREDL_CLAN_ID       var                — the clan's id/slug on AREDL, if the API needs it
 *   UNRATED_SHEET_ID    var                — the Google Sheet's id (the long string in its URL)
 *   VIDEO_FEED_URL      var (optional)     — RSS/JSON feed for the channel's uploads
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
   /api/list — proxy + cache AREDL, filtered to this clan's beats
   ============================================================ */
async function handleList(env, ctx) {
  const data = await cached(env, "list:v1", 300, async () => {
    // AREDL exposes the full rated list; adjust the path/shape to match
    // whatever the current AREDL API contract is at deploy time.
    const res = await fetch(`${env.AREDL_API_BASE}/api/list`);
    if (!res.ok) throw new Error(`AREDL list fetch failed: ${res.status}`);
    const levels = await res.json();

    // Keep only levels beaten by a clan member. Adjust the field names
    // (`clan`, `verifier`, etc.) once you've checked the real response shape.
    return levels
      .filter((lvl) => (lvl.records || []).some((r) => r.clanId === env.AREDL_CLAN_ID))
      .map((lvl) => {
        const clanRecord = lvl.records.find((r) => r.clanId === env.AREDL_CLAN_ID);
        return {
          rank: lvl.position,
          name: lvl.name,
          creator: lvl.creator,
          verifier: clanRecord.player,
          points: lvl.points,
          videoUrl: clanRecord.videoUrl,
        };
      });
  });
  return json(data);
}

/* ============================================================
   /api/monthly — grouped from D1 snapshots (own data, not AREDL's
   live state, so past months never silently change)
   ============================================================ */
async function handleMonthly(env) {
  const { results } = await env.DB.prepare(
    `SELECT month, rank, name, creator, verifier, points, video_url as videoUrl
     FROM monthly_snapshots ORDER BY month DESC, rank ASC`
  ).all();

  const grouped = {};
  for (const row of results) {
    grouped[row.month] = grouped[row.month] || [];
    grouped[row.month].push({
      rank: row.rank, name: row.name, creator: row.creator,
      verifier: row.verifier, points: row.points, videoUrl: row.videoUrl,
    });
  }
  return json(grouped);
}

/* ============================================================
   /api/progress — from D1
   ============================================================ */
async function handleProgress(env) {
  const { results } = await env.DB.prepare(
    `SELECT player, level, pct, status FROM progress ORDER BY player, pct DESC`
  ).all();

  const byPlayer = {};
  for (const row of results) {
    byPlayer[row.player] = byPlayer[row.player] || { player: row.player, entries: [] };
    byPlayer[row.player].entries.push({ level: row.level, pct: row.pct, status: row.status });
  }
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
   /api/unrated — reads the "UNRATED" tab of a public Google Sheet
   via the gviz endpoint (no service account needed, sheet just
   needs to be shared as "anyone with the link can view").
   ============================================================ */
async function handleUnrated(env) {
  const data = await cached(env, "unrated:v1", 300, async () => {
    const sheetUrl =
      `https://docs.google.com/spreadsheets/d/${env.UNRATED_SHEET_ID}` +
      `/gviz/tq?tqx=out:json&sheet=UNRATED`;

    const res = await fetch(sheetUrl);
    if (!res.ok) throw new Error(`Sheets fetch failed: ${res.status}`);
    const text = await res.text();

    // Response is wrapped: google.visualization.Query.setResponse({...});
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const payload = JSON.parse(text.slice(start, end + 1));

    const cols = payload.table.cols.map((c, i) => (c.label || `col${i}`).trim().toLowerCase());
    return payload.table.rows
      .map((r) => {
        const row = {};
        r.c.forEach((cell, i) => {
          row[cols[i]] = cell ? (cell.f ?? cell.v) : "";
        });
        return row;
      })
      // Expect sheet columns: name | creator | verifier | note
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

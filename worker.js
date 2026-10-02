/**
 * ROSE Demonlist — Cloudflare Worker API
 *
 * Routes:
 *   GET /api/list              -> clan's AREDL records, straight from AREDL (cached)
 *   GET /api/monthly           -> the same records, grouped by achieved_at month
 *   GET /api/progress          -> per-player progress, from the "PROGRESS" tab of a Google Sheet
 *   GET /api/videos            -> channel upload feed (non-YouTube-API), cached
 *   GET /api/unrated           -> rows from the "UNRATED" tab of a public Google Sheet
 *   GET /api/members           -> clan members ranked by AREDL points (+ country, optional YouTube from "MEMBERS" tab)
 *   GET /api/other             -> top-10 most / fewest attempts, from the "HIGHATT" and "LOWATT" tabs
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
      if (pathname === "/api/members") return await handleMembers(env, ctx, request);
      if (pathname === "/api/other") return await handleOther(env, ctx);
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
 
function recordToLevelEntry(r, metaByLevelId) {
  const meta = metaByLevelId.get(r.level.id) || {};
  return {
    rank: r.level.position,
    id: r.level.id,
    levelId: meta.gameId ?? r.level.level_id ?? null, // in-game level id, used for thumbnails
    name: r.level.name,
    creator: meta.creator ?? "Unknown",
    verifierCountry: r.submitted_by.country ?? null,
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
      await cached(env, "creator-lookup:v2", 1800, async () => {
        const levels = await fetchAredlLevels(env);
        const entries = levels.map((lvl) => [
          lvl.id,
          {
            gameId: lvl.level_id ?? null,
            creator:
              lvl.publisher?.global_name ??
              lvl.publisher?.username ??
              lvl.creators?.map((c) => c.global_name || c.username).join(", ") ??
              "Unknown",
          },
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
  const rows = await cached(env, "progress:v2", 300, async () => {
    const raw = await fetchSheetRows(env, "PROGRESS");
    // Sheet columns: LEVELNAME | PLAYERNAME | FROMZERO (progress percent, 0-100)
    return raw
      .map((row) => {
        const pct = Math.max(0, Math.min(100, parseNum(pick(row, "fromzero", "pct", "progress", "percent"))));
        return {
          player: pick(row, "playername", "player"),
          level: pick(row, "levelname", "level"),
          pct,
          status: pick(row, "status") || (pct >= 100 ? "Completed" : "In progress"),
        };
      })
      .filter((row) => row.player && row.level);
  });

  const byPlayer = {};
  for (const row of rows) {
    byPlayer[row.player] = byPlayer[row.player] || { player: row.player, entries: [] };
    byPlayer[row.player].entries.push({ level: row.level, pct: row.pct, status: row.status });
  }
  // Highest progress first within each player.
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
    `https://docs.google.com/spreadsheets/d/${env.CLAN_SHEET_ID || env.UNRATED_SHEET_ID}` +
    `/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(tabName)}`;

  const res = await fetch(sheetUrl);
  if (!res.ok) throw new Error(`Sheets fetch failed for tab "${tabName}": ${res.status}`);
  const text = await res.text();

  // Response is wrapped: google.visualization.Query.setResponse({...});
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const payload = JSON.parse(text.slice(start, end + 1));

  // Header names are normalised: "LEVELNAME", "Level Name" and "level_name" all become "levelname".
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let cols = payload.table.cols.map((c, i) => norm(c.label) || `col${i}`);
  let rows = payload.table.rows;

  // Google sometimes fails to detect the header row when every column is text;
  // in that case the headers arrive as the first data row.
  if (payload.table.cols.every((c) => !c.label) && rows.length) {
    cols = rows[0].c.map((cell, i) => norm(cell && (cell.f ?? cell.v)) || `col${i}`);
    rows = rows.slice(1);
  }

  return rows.map((r) => {
    const row = {};
    (r.c || []).forEach((cell, i) => {
      row[cols[i]] = cell ? (cell.f ?? cell.v) : "";
    });
    return row;
  });
}

// First non-empty value among several possible column names.
function pick(row, ...keys) {
  for (const k of keys) if (row[k] !== undefined && row[k] !== "" && row[k] !== null) return row[k];
  return "";
}

// "12,345" / "45%" / 45 -> number
function parseNum(v) {
  const n = Number(String(v ?? "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/* ============================================================
   /api/unrated — reads the "UNRATED" tab of the Google Sheet
   ============================================================ */
async function handleUnrated(env) {
  const data = await cached(env, "unrated:v2", 300, async () => {
    const rows = await fetchSheetRows(env, "UNRATED");
    // Sheet columns: LEVELNAME | PLAYERNAME
    return rows
      .map((row) => ({
        name: pick(row, "levelname", "name", "level"),
        verifier: pick(row, "playername", "player", "verifier") || "Unknown",
      }))
      .filter((row) => row.name);
  });
  return json(data);
}

/* ============================================================
   /api/members — clan leaderboard by AREDL points.
   Points come from the clan endpoint's `members_points`. Country is read
   from that entry if present, otherwise looked up from the member's AREDL
   profile (capped to stay under Workers' subrequest limit). Optional
   "MEMBERS" sheet tab (player | youtube) adds a channel link per member.
   ============================================================ */
// AREDL's docs don't spell out the shape of a `members_points` entry, so find
// the points figure by looking for a numeric field whose name mentions
// points/score/contribution (top level first, then one level down).
function extractPoints(entry) {
  const looksLikePoints = (k) => /point|score|contrib/i.test(k);
  const toNum = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  for (const [k, v] of Object.entries(entry)) {
    if (looksLikePoints(k) && Number.isFinite(toNum(v))) return toNum(v);
  }
  for (const v of Object.values(entry)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (looksLikePoints(k2) && Number.isFinite(toNum(v2))) return toNum(v2);
      }
    }
  }
  return 0;
}

async function getMembersCached(env) {
  return cached(env, "members:v3", 600, async () => {
    const profile = await getClanProfileCached(env);
    const members = (profile.members_points || []).map((m) => {
      const u = m.user || m.member || m.player || m.profile || m;
      return {
        id: u.id ?? m.user_id ?? null,
        name: u.global_name || u.username || m.global_name || m.username || "Unknown",
        points: Math.round(extractPoints(m) * 100) / 100,
        country: u.country ?? null,
        youtube: null,
      };
    });

    const missing = members.filter((m) => m.country == null && m.id).slice(0, 30);
    await Promise.all(
      missing.map(async (m) => {
        try {
          const res = await fetch(`${env.AREDL_API_BASE}/v2/api/aredl/profile/${m.id}`);
          if (res.ok) m.country = (await res.json()).country ?? null;
        } catch {}
      })
    );

    try {
      const rows = await fetchSheetRows(env, "MEMBERS");
      const yt = new Map(
        rows
          .map((r) => [pick(r, "playername", "player"), pick(r, "youtube", "channel", "link")])
          .filter(([p, y]) => p && y)
          .map(([p, y]) => [String(p).toLowerCase(), y])
      );
      for (const m of members) m.youtube = yt.get(m.name.toLowerCase()) ?? null;
    } catch (err) {
      console.warn("MEMBERS tab not readable (optional):", String(err));
    }

    return members.sort((a, b) => b.points - a.points).map((m, i) => ({ ...m, rank: i + 1 }));
  });
}

async function handleMembers(env, ctx, request) {
  // /api/members?debug=1 shows the raw first entry AREDL returns, for diagnosing field names.
  if (request && new URL(request.url).searchParams.get("debug")) {
    const profile = await getClanProfileCached(env);
    return json({ sample: (profile.members_points || []).slice(0, 2), keys: Object.keys(profile) });
  }
  return json(await getMembersCached(env));
}

/* ============================================================
   /api/other — "HIGHATT" and "LOWATT" sheet tabs, each:
   LEVELNAME | PLAYERNAME | ATTEMPTS
   Returns { highest: [...top 10 most attempts], lowest: [...top 10 fewest] }.
   ============================================================ */
async function readAttempts(env, tab) {
  const rows = await fetchSheetRows(env, tab);
  return rows
    .map((r) => ({
      level: pick(r, "levelname", "level"),
      player: pick(r, "playername", "player"),
      attempts: parseNum(pick(r, "attempts", "att")),
      videoUrl: pick(r, "video", "link") || null,
    }))
    .filter((r) => r.level && r.player && r.attempts > 0);
}

async function handleOther(env) {
  const data = await cached(env, "other:v2", 300, async () => {
    const [high, low] = await Promise.all([readAttempts(env, "HIGHATT"), readAttempts(env, "LOWATT")]);
    return {
      highest: high.sort((a, b) => b.attempts - a.attempts).slice(0, 10),
      lowest: low.sort((a, b) => a.attempts - b.attempts).slice(0, 10),
    };
  });

  // Attach flags by matching player names against the members list (best-effort).
  try {
    const members = await getMembersCached(env);
    const byName = new Map(members.map((m) => [m.name.toLowerCase(), m.country]));
    for (const list of [data.highest, data.lowest])
      for (const r of list) r.country = byName.get(String(r.player).toLowerCase()) ?? null;
  } catch {}
  return json(data);
}

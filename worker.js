/**
 * ROSE Demonlist — Cloudflare Worker API
 *
 * Routes:
 *   GET /api/list              -> clan's rated beats, from AREDL (cached)
 *   GET /api/monthly           -> beats grouped by month, from D1 snapshots
 *   GET /api/progress          -> per-player progress, from the "PROGRESS" tab of a Google Sheet
 *   GET /api/videos            -> channel upload feed (non-YouTube-API), cached
 *   GET /api/unrated           -> rows from the "UNRATED" tab of a public Google Sheet
 *
 * Bindings expected (see wrangler.toml):
 *   DB                 D1 database        — monthly snapshots, video cache rows
 *   CACHE               KV namespace       — short-lived cache for AREDL + Sheets responses
 *   AREDL_API_BASE      var                — e.g. "https://api.aredl.net"
 *   AREDL_API_KEY       secret             — set via `wrangler secret put AREDL_API_KEY`
 *   CLAN_SHEET_ID       var                — the Google Sheet's id (the long string in its URL);
 *                                            backs the "Records", "UNRATED", and "PROGRESS" tabs
 *   VIDEO_FEED_URL      var (optional)     — RSS/JSON feed for the channel's uploads
 *
 * The clan isn't something AREDL's API knows about — AREDL just returns the
 * full public level list. "Which levels did ROSE beat" lives in the sheet's
 * "Records" tab (Player | Record | Date | Completion) and gets matched
 * against AREDL's level list by name. See handleList() below.
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
   /api/list — AREDL's full level list, cross-referenced against the
   clan's own "Records" sheet tab, with every victor on a level kept
   (not just the first) so the card can show who else beat it too.
   ============================================================ */
async function handleList(env) {
  const data = await cached(env, "list:v2", 300, async () => {
    const [aredlLevels, records] = await Promise.all([
      fetchAredlLevels(env),
      fetchSheetRows(env, "Records"),
    ]);

    // Group the clan's completions by level name, earliest first.
    const byLevel = {};
    for (const r of records) {
      if (!r.record) continue;
      (byLevel[r.record] ||= []).push(r);
    }
    for (const name in byLevel) {
      byLevel[name].sort((a, b) => parseUKDate(a.date) - parseUKDate(b.date));
    }

    const matched = [];
    for (const name in byLevel) {
      const level = aredlLevels.find((l) => l.name === name);
      if (!level) {
        warnUnmatchedLevel(name, aredlLevels, byLevel[name][0]);
        continue;
      }
      const [victor, ...rest] = byLevel[name];
      matched.push({ level, victor, followingVictors: rest.map((r) => r.player) });
    }

    // Levels where the sheet has no completion link fall back to AREDL's
    // own first verification video, fetched per-level (only for the ones
    // that need it, and only once per cache window — see `cached()` above).
    const withVideo = await Promise.all(
      matched.map(async ({ level, victor, followingVictors }) => {
        let videoUrl = victor.completion || null;
        if (!videoUrl) {
          try {
            const detail = await fetchAredlLevelDetail(env, level.id);
            videoUrl = detail.verifications?.[0]?.video_url ?? null;
          } catch (err) {
            console.warn(`Couldn't fetch fallback video for "${level.name}":`, err.message);
          }
        }
        return {
          rank: level.position,
          id: level.id,
          name: level.name,
          creator: level.publisher?.global_name ?? level.creator ?? "Unknown",
          verifier: victor.player,
          points: level.points ?? null,
          videoUrl,
          followingVictors,
        };
      })
    );

    return withVideo.sort((a, b) => a.rank - b.rank);
  });
  return json(data);
}

async function fetchAredlLevels(env) {
  // Confirmed endpoint as of this file's last check — re-verify against
  // AREDL's docs if this starts 404ing, since public APIs do move.
  const res = await fetch(`${env.AREDL_API_BASE}/v2/api/aredl/levels`, {
    headers: { Authorization: `Bearer ${env.AREDL_API_KEY}` },
  });
  if (!res.ok) throw new Error(`AREDL list fetch failed: ${res.status}`);
  return res.json();
}

async function fetchAredlLevelDetail(env, levelId) {
  const res = await fetch(`${env.AREDL_API_BASE}/v2/api/aredl/levels/${levelId}`, {
    headers: { Authorization: `Bearer ${env.AREDL_API_KEY}` },
  });
  if (!res.ok) throw new Error(`AREDL level detail fetch failed: ${res.status}`);
  return res.json();
}

// Sheet dates are entered as dd/mm/yyyy. Blank or malformed dates sort last
// rather than crashing the whole list.
function parseUKDate(dateStr) {
  if (!dateStr) return new Date(8640000000000000);
  const [day, month, year] = String(dateStr).split("/").map(Number);
  if (!day || !month || !year) return new Date(8640000000000000);
  return new Date(year, month - 1, day);
}

// A sheet row with a level name that doesn't exactly match any AREDL level
// (typo, renamed level, etc.) gets dropped from the list rather than
// crashing it — this logs which one and, if there's an obvious near-match,
// what it was probably supposed to be. Check `wrangler tail` for these.
function warnUnmatchedLevel(sheetName, aredlLevels, firstRecord) {
  const lower = sheetName.toLowerCase();
  const close = aredlLevels.find((l) => {
    const a = l.name.toLowerCase();
    return a.includes(lower) || lower.includes(a);
  });
  if (close) {
    console.warn(`Skipped "${sheetName}" by ${firstRecord.player} — did you mean "${close.name}"?`);
  } else {
    console.warn(`Skipped "${sheetName}" by ${firstRecord.player} — no matching AREDL level found.`);
  }
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

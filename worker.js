/**
 * ROSE Demonlist — Cloudflare Worker API
 *
 * Routes:
 *   GET /api/list              -> every main-list level ROSE has beaten, any member (cached)
 *   GET /api/monthly           -> the same, grouped by achieved_at month
 *   GET /api/progress          -> per-player progress, from the "PROGRESS" tab of a Google Sheet
 *   GET /api/videos            -> channel upload feed (non-YouTube-API), cached
 *   GET /api/unrated           -> rows from the "UNRATED" tab of a public Google Sheet
 *   GET /api/members           -> clan members ranked by summed real AREDL points (+ country, optional YouTube from "MEMBERS" tab)
 *   GET /api/other             -> top-10 most / fewest attempts, from the "HIGHATT" and "LOWATT" tabs
 *
 * Bindings expected (see wrangler.toml):
 *   CACHE               KV namespace       — short-lived cache for AREDL + Sheets responses
 *   AREDL_API_BASE      var                — e.g. "https://api.aredl.net"
 *   AREDL_CLAN_ID       var                — ROSE's clan UUID on AREDL
 *   CLAN_SHEET_ID       var                — the Google Sheet's id (the long string in its URL);
 *                                            backs the "UNRATED", "PROGRESS", "MEMBERS", "HIGHATT", "LOWATT" tabs
 *   VIDEO_FEED_URL      var (optional)     — RSS/JSON feed for the channel's uploads
 *
 * -------------------------------------------------------------------------
 * How completions are built (the important bit):
 * AREDL's `clan` endpoint only ever returns the FIRST clan member to beat
 * each level — it can't tell us who else beat it, and it reports clan
 * points as a pre-split "contribution" (level points / how many clan
 * members beat it), not a straight sum. Neither of those is good enough for
 * showing a player's full completion history or for summing real points.
 *
 * So instead, getClanCompletionsCached() below walks every clan member's own
 * AREDL profile (`/v2/api/aredl/profile/{id}`), which lists everything THEY
 * personally beat, and merges all of that into one level -> [completions]
 * map. /api/list, /api/monthly, and /api/members all read from this one
 * merged map, which is also what makes followingVictors possible now.
 *
 * Two caveats worth knowing:
 * 1. AREDL's docs don't spell out the exact field name a profile record
 *    uses to say *which level* it's for (the docs literally say it "omits
 *    the level field" without saying what replaces it). recordLevelId()
 *    below tries several plausible field names. If completions/points come
 *    out empty or wrong, hit /api/members?debug=1 — it dumps one real
 *    profile record's raw shape so the exact field name can be confirmed
 *    and recordLevelId() adjusted in one line.
 * 2. This does one subrequest per clan member (capped at MAX_MEMBERS_WALKED
 *    to stay under Workers' per-request subrequest limit — raise that cap,
 *    or upgrade to Workers Paid for a much higher limit, if ROSE's roster
 *    grows past it). Results are cached for 15 minutes either way.
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
   /api/list — every main-list level ROSE has beaten, with every
   clan member who's beaten it (not just the first).
   ============================================================ */
async function handleList(env) {
  const { byLevel } = await getClanCompletionsCached(env);
  const entries = Object.values(byLevel)
    .filter(({ level }) => level.position != null)
    .map(({ level, completions }) => levelEntryFromCompletions(level, completions));
  return json(entries.sort((a, b) => a.rank - b.rank));
}

/* ============================================================
   /api/monthly — the same completions, grouped by the month each
   level was first achieved by the clan (AREDL's achieved_at).
   ============================================================ */
async function handleMonthly(env) {
  const { byLevel } = await getClanCompletionsCached(env);
  const entries = Object.values(byLevel)
    .filter(({ level }) => level.position != null)
    .map(({ level, completions }) => levelEntryFromCompletions(level, completions))
    .filter((e) => e.achievedAt);

  const sorted = entries.sort((a, b) => new Date(b.achievedAt) - new Date(a.achievedAt));
  const grouped = {};
  for (const e of sorted) {
    const label = new Date(e.achievedAt).toLocaleString("en-US", { month: "long", year: "numeric" });
    (grouped[label] ||= []).push(e);
  }
  for (const label in grouped) grouped[label].sort((a, b) => a.rank - b.rank);
  return json(grouped);
}

// One AREDL level + its clan completions -> the shape the frontend expects.
// Earliest achieved_at among the clan's completions is "the" verifier shown
// on the card; everyone else becomes followingVictors.
function levelEntryFromCompletions(level, completions) {
  const sorted = [...completions].sort(
    (a, b) => new Date(recordAchievedAt(a.record) || 0) - new Date(recordAchievedAt(b.record) || 0)
  );
  const [first, ...rest] = sorted;
  return {
    rank: level.position,
    id: level.id,
    levelId: level.level_id ?? null, // in-game level id, used for thumbnails
    name: level.name,
    creator:
      level.publisher?.global_name ??
      level.publisher?.username ??
      level.creators?.map((c) => c.global_name || c.username).join(", ") ??
      "Unknown",
    verifier: first.member.global_name || first.member.username,
    verifierCountry: first.member.country ?? null,
    points: level.points ?? null,
    videoUrl: recordVideoUrl(first.record),
    achievedAt: recordAchievedAt(first.record),
    followingVictors: rest.map((c) => c.member.global_name || c.member.username),
  };
}

/* ------------------------------------------------------------
   AREDL fetch helpers — all public, no auth required.
   ------------------------------------------------------------ */
async function fetchAredlLevels(env) {
  const res = await fetch(`${env.AREDL_API_BASE}/v2/api/aredl/levels`);
  if (!res.ok) throw new Error(`AREDL level list fetch failed: ${res.status}`);
  return res.json();
}

async function getClanRosterCached(env) {
  return cached(env, "roster:v1", 1800, async () => {
    const res = await fetch(`${env.AREDL_API_BASE}/v2/api/clans/${env.AREDL_CLAN_ID}/members`);
    if (!res.ok) throw new Error(`Clan members fetch failed: ${res.status}`);
    return res.json();
  });
}

async function fetchMemberProfile(env, memberId) {
  const res = await fetch(`${env.AREDL_API_BASE}/v2/api/aredl/profile/${memberId}`);
  if (!res.ok) throw new Error(`Profile fetch failed for ${memberId}: ${res.status}`);
  return res.json();
}

// AREDL's profile endpoint describes its `records` as a resolved record that
// "omits the level field" without saying what identifies the level instead,
// so every plausible field name is tried. Adjust/extend this one function if
// /api/members?debug=1 shows a different real field name.
function recordLevelId(r) {
  return r.level_id ?? r.levelId ?? r.level?.id ?? r.aredl_level_id ?? null;
}
function recordAchievedAt(r) {
  return r.achieved_at ?? r.achievedAt ?? r.created_at ?? null;
}
function recordVideoUrl(r) {
  return r.video_url ?? r.videoUrl ?? null;
}

const MAX_MEMBERS_WALKED = 45; // keep total subrequests under Workers' per-request cap

// level AREDL-uuid -> { level, completions: [{ member, record }] }, merged
// from every clan member's own profile. See the file-header comment above
// for why this replaces the clan endpoint's first-victor-only records.
async function getClanCompletionsCached(env) {
  return cached(env, "completions:v1", 900, async () => {
    const [roster, levels] = await Promise.all([getClanRosterCached(env), fetchAredlLevels(env)]);
    const levelById = new Map(levels.map((l) => [l.id, l]));

    const members = roster.slice(0, MAX_MEMBERS_WALKED);
    if (roster.length > MAX_MEMBERS_WALKED) {
      console.warn(
        `ROSE has ${roster.length} members — only the first ${MAX_MEMBERS_WALKED} were walked for completions this cache cycle.`
      );
    }

    const perMember = await Promise.all(
      members.map(async (m) => {
        try {
          const profile = await fetchMemberProfile(env, m.id);
          return { member: m, records: profile.records || [] };
        } catch (err) {
          console.warn(`Couldn't load AREDL profile for ${m.global_name || m.username}:`, String(err));
          return { member: m, records: [] };
        }
      })
    );

    const byLevel = new Map();
    for (const { member, records } of perMember) {
      for (const r of records) {
        const levelId = recordLevelId(r);
        const level = levelId ? levelById.get(levelId) : null;
        if (!level) continue; // unresolved shape, or not a classic main-list level
        if (!byLevel.has(levelId)) byLevel.set(levelId, { level, completions: [] });
        byLevel.get(levelId).completions.push({ member, record: r });
      }
    }

    return { byLevel: Object.fromEntries(byLevel), members: perMember.map((p) => p.member) };
  });
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
   /api/members — clan leaderboard, points summed directly from
   real completions (see getClanCompletionsCached above) rather
   than AREDL's pre-split clan "contribution" figure. Country comes
   straight from the clan roster. Optional "MEMBERS" sheet tab
   (player | youtube) adds a channel link per member.
   ============================================================ */
async function getMembersCached(env) {
  return cached(env, "members:v5", 900, async () => {
    const { byLevel, members } = await getClanCompletionsCached(env);

    const pointsById = new Map();
    for (const { level, completions } of Object.values(byLevel)) {
      if (level.position == null) continue; // only main-list levels count toward points
      for (const { member } of completions) {
        pointsById.set(member.id, (pointsById.get(member.id) || 0) + (level.points || 0));
      }
    }

    const result = members.map((m) => ({
      id: m.id,
      name: m.global_name || m.username,
      points: Math.round((pointsById.get(m.id) || 0) * 100) / 100,
      country: m.country ?? null,
      youtube: null,
    }));

    try {
      const rows = await fetchSheetRows(env, "MEMBERS");
      const yt = new Map(
        rows
          .map((r) => [pick(r, "playername", "player"), pick(r, "youtube", "channel", "link")])
          .filter(([p, y]) => p && y)
          .map(([p, y]) => [String(p).toLowerCase(), y])
      );
      for (const m of result) m.youtube = yt.get(m.name.toLowerCase()) ?? null;
    } catch (err) {
      console.warn("MEMBERS tab not readable (optional):", String(err));
    }

    return result.sort((a, b) => b.points - a.points).map((m, i) => ({ ...m, rank: i + 1 }));
  });
}

async function handleMembers(env, ctx, request) {
  // /api/members?debug=1 shows one roster entry and one raw profile record,
  // for confirming the exact field name recordLevelId() should be reading.
  if (request && new URL(request.url).searchParams.get("debug")) {
    const roster = await getClanRosterCached(env);
    const sampleMember = roster[0] || null;
    const profile = sampleMember ? await fetchMemberProfile(env, sampleMember.id) : null;
    return json({
      rosterSample: sampleMember,
      profileRecordSample: profile?.records?.[0] || null,
      profileKeys: profile ? Object.keys(profile) : [],
    });
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
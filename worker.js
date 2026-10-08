/**
 * ROSE Demonlist — Cloudflare Worker API
 *
 * Routes:
 *   GET /api/list              -> every main-list level ROSE has beaten, any member (cached)
 *                                 add ?unrated=1 to also merge in placed UNRATED-sheet levels
 *   GET /api/monthly           -> the same, grouped by achieved_at month
 *   GET /api/progress          -> per-player progress, from the "PROGRESS" tab of a Google Sheet
 *   GET /api/videos            -> channel upload feed (non-YouTube-API), cached
 *   GET /api/unrated           -> the "UNRATED" sheet tab as its own list (with where each would sit on the main list)
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
      if (pathname === "/api/list") return await handleList(env, ctx, request);
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
   Points — based on ROSE's own CLAN ranking (not AREDL's raw
   `points`), on an exponential curve: the clan's single hardest
   beat is worth 500, the clan's easiest beat is worth 1, and every
   rank in between falls off exponentially. CLAN_POINTS_CURVE_K sets
   how aggressively points pull away toward the top (higher = top
   ranks worth disproportionately more). Recomputed from whatever
   the clan's current level count is every time this runs, so it
   adapts automatically as levels get added or removed — nothing
   here is a fixed table that needs updating by hand.
   ============================================================ */
const CLAN_POINTS_MAX = 500;
const CLAN_POINTS_MIN = 1;
const CLAN_POINTS_CURVE_K = 5;

function clanPointsForRank(clanRank, total) {
  if (total <= 1) return CLAN_POINTS_MAX;
  const t = (clanRank - 1) / (total - 1); // 0 at #1 (hardest), 1 at the bottom
  const raw = (Math.exp(-CLAN_POINTS_CURVE_K * t) - Math.exp(-CLAN_POINTS_CURVE_K)) / (1 - Math.exp(-CLAN_POINTS_CURVE_K));
  return Math.round(CLAN_POINTS_MIN + (CLAN_POINTS_MAX - CLAN_POINTS_MIN) * raw);
}

// level AREDL-uuid -> clan-curve points, ranked by real AREDL placement
// across every main-list level the clan has beaten (not a subset — points
// must mean the same thing on every page, so this always uses the full set).
function buildClanPointsMap(byLevel) {
  const levels = Object.values(byLevel)
    .map(({ level }) => level)
    .filter((level) => level.position != null)
    .sort((a, b) => a.position - b.position);
  const total = levels.length;
  const map = new Map();
  levels.forEach((level, i) => map.set(level.id, clanPointsForRank(i + 1, total)));
  return map;
}

/* ============================================================
   /api/list — every main-list level ROSE has beaten, with every
   clan member who's beaten it (not just the first).
   ============================================================ */
async function getRatedEntries(env) {
  const { byLevel } = await getClanCompletionsCached(env);
  const clanPoints = buildClanPointsMap(byLevel);
  return Object.values(byLevel)
    .filter(({ level }) => level.position != null)
    .map(({ level, completions }) => levelEntryFromCompletions(level, completions, clanPoints))
    .sort((a, b) => a.rank - b.rank);
}

async function handleList(env, ctx, request) {
  const rated = await getRatedEntries(env);
  const wantsUnrated = request && new URL(request.url).searchParams.get("unrated");
  if (!wantsUnrated) return json(rated);
  const { merged } = await combineWithUnrated(env, rated);
  return json(merged);
}

/* ============================================================
   /api/monthly — calculated independently per month, NOT from the
   all-time list. For each month, every completion achieved in that
   month is grouped by level; the earliest one that month is that
   month's first victor (shown on the card) and anyone else who beat
   the same level the same month becomes a following victor. So a
   level already beaten in an earlier month can still have a fresh
   "first victor of the month" later, and a level can appear in more
   than one month. Points still come from the clan-wide curve (a
   level is worth the same wherever it shows up).
   ============================================================ */
async function handleMonthly(env) {
  const { byLevel } = await getClanCompletionsCached(env);
  const clanPoints = buildClanPointsMap(byLevel);
  const monthLabel = (iso) => new Date(iso).toLocaleString("en-US", { month: "long", year: "numeric" });

  // month label -> [{ level, completions: [only that month's completions] }]
  const months = new Map();
  for (const { level, completions } of Object.values(byLevel)) {
    if (level.position == null) continue;
    const perMonth = new Map();
    for (const c of completions) {
      const at = recordAchievedAt(c.record);
      if (!at || isNaN(new Date(at))) continue; // can't place it in a month
      const label = monthLabel(at);
      if (!perMonth.has(label)) perMonth.set(label, []);
      perMonth.get(label).push(c);
    }
    for (const [label, monthCompletions] of perMonth) {
      if (!months.has(label)) months.set(label, []);
      months.get(label).push({ level, completions: monthCompletions });
    }
  }

  // Newest month first; within a month, hardest level first.
  const grouped = {};
  const entriesByMonth = [...months].map(([label, items]) => ({
    label,
    entries: items
      .map(({ level, completions }) => levelEntryFromCompletions(level, completions, clanPoints))
      .sort((a, b) => a.rank - b.rank),
  }));
  entriesByMonth.sort((a, b) => new Date(b.entries[0].achievedAt) - new Date(a.entries[0].achievedAt));
  for (const { label, entries } of entriesByMonth) grouped[label] = entries;
  return json(grouped);
}

// One AREDL level + its clan completions -> the shape the frontend expects.
// Earliest achieved_at among the clan's completions is "the" verifier shown
// on the card; everyone else becomes followingVictors.
function levelEntryFromCompletions(level, completions, clanPoints) {
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
    points: clanPoints?.get(level.id) ?? level.points ?? null,
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
  return cached(env, "completions:v2", 900, async () => {
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

    // FLEXIRECORDS: completions AREDL didn't accept but the clan does. An
    // AREDL record for the same member+level always wins over a flexi one.
    const flexi = await loadFlexiRecords(env, roster, levels);
    for (const { member, level, record } of flexi) {
      if (!byLevel.has(level.id)) byLevel.set(level.id, { level, completions: [] });
      const entry = byLevel.get(level.id);
      if (entry.completions.some((c) => c.member.id === member.id)) continue;
      entry.completions.push({ member, record });
    }

    return { byLevel: Object.fromEntries(byLevel), members: perMember.map((p) => p.member) };
  });
}

/* ============================================================
   FLEXIRECORDS — the "FLEXIRECORDS" sheet tab
   LEVELNAME | PLAYERNAME | ?COMPDATE | ?VIDEOLINK | ?REASON
   For records AREDL rejected on technicalities (an unlucky crash,
   a harmless mod, no mic...) that the clan accepts anyway. They are
   merged into the normal completions, so they count everywhere (List,
   Monthly, Members) exactly like an AREDL record. ?REASON is for the
   clan managers only and is never sent to the site.
   Completion date: the video's published date wins when there's a
   YouTube link; otherwise ?COMPDATE (D/M/Y). Needs one or the other.
   ============================================================ */
const FLEXI_MAX_DATE_FETCHES = 5; // new YouTube lookups per refresh (keeps subrequests low); the rest resolve next refresh

const normName = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function extractYouTubeIdServer(url) {
  const m = String(url || "").match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// "20/8/2025", "20-08-2025", "20.8.25", or gviz's "Date(2025,7,20)" -> ISO string (UTC midnight), or null.
function parseDMY(raw) {
  const str = String(raw ?? "").trim();
  if (!str) return null;
  let d, m, y;
  const g = str.match(/^Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})/);
  if (g) { y = +g[1]; m = +g[2] + 1; d = +g[3]; } // gviz months are 0-based
  else {
    const t = str.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (!t) return null;
    d = +t[1]; m = +t[2]; y = +t[3];
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString() : null;
}

// YouTube has no key-free API for this, so read the watch page's metadata.
async function fetchYouTubePublishDate(id) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${id}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        cookie: "CONSENT=YES+cb; SOCS=CAI",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m =
      html.match(/itemprop="datePublished"\s+content="([^"]+)"/) ||
      html.match(/content="([^"]+)"\s+itemprop="datePublished"/) ||
      html.match(/"publishDate":"([^"]+)"/) ||
      html.match(/"uploadDate":"([^"]+)"/);
    if (!m) return null;
    const dt = new Date(m[1]);
    return isNaN(dt) ? null : dt.toISOString();
  } catch (err) {
    console.warn(`YouTube date lookup failed for ${id}:`, String(err));
    return null;
  }
}

// videoId -> ISO publish date, remembered in KV forever (a video's publish
// date never changes), so each video is only ever looked up once.
async function resolveVideoDates(env, videoIds) {
  const store = (await env.CACHE.get("ytdates:v1", "json").catch(() => null)) || {};
  const pending = videoIds.filter((id) => !store[id]).slice(0, FLEXI_MAX_DATE_FETCHES);
  if (!pending.length) return store;
  const found = await Promise.all(pending.map(async (id) => [id, await fetchYouTubePublishDate(id)]));
  let changed = false;
  for (const [id, iso] of found) if (iso) { store[id] = iso; changed = true; }
  if (changed) await env.CACHE.put("ytdates:v1", JSON.stringify(store)).catch(() => {});
  return store;
}

async function loadFlexiRecords(env, roster, levels) {
  let rows;
  try {
    rows = await fetchSheetRows(env, "FLEXIRECORDS");
  } catch (err) {
    console.warn("FLEXIRECORDS tab not readable (optional):", String(err));
    return [];
  }

  const levelByName = new Map(levels.map((l) => [normName(l.name), l]));
  const memberByName = new Map();
  for (const m of roster) for (const n of [m.global_name, m.username]) if (n && !memberByName.has(normName(n))) memberByName.set(normName(n), m);

  const parsed = rows
    .map((r) => ({
      levelName: pick(r, "levelname", "level"),
      player: pick(r, "playername", "player"),
      video: String(pick(r, "videolink", "video")).trim(),
      compDate: parseDMY(pick(r, "compdate", "date")),
    }))
    .filter((r) => r.levelName && r.player);

  const ids = [...new Set(parsed.map((r) => extractYouTubeIdServer(r.video)).filter(Boolean))];
  const videoDates = ids.length ? await resolveVideoDates(env, ids) : {};

  const out = [];
  for (const r of parsed) {
    const level = levelByName.get(normName(r.levelName));
    const member = memberByName.get(normName(r.player));
    if (!level) { console.warn(`FLEXIRECORDS: no AREDL level named "${r.levelName}" — skipped.`); continue; }
    if (!member) { console.warn(`FLEXIRECORDS: "${r.player}" isn't in the clan roster — skipped.`); continue; }
    const id = extractYouTubeIdServer(r.video);
    const achievedAt = (id && videoDates[id]) || r.compDate; // video date preferred over ?COMPDATE
    if (!achievedAt) { console.warn(`FLEXIRECORDS: no usable date for ${r.player} / ${r.levelName} (needs ?VIDEOLINK or ?COMPDATE) — skipped for now.`); continue; }
    out.push({ member, level, record: { level_id: level.id, achieved_at: achievedAt, video_url: r.video || null, flexi: true } });
  }
  return out;
}

/* ============================================================
   /api/progress — from the "PROGRESS" tab of the Google Sheet
   ============================================================ */
// "40-85, 60-100" -> [{start:40,end:85}, {start:60,end:100}]. Each gets a
// `kind` so the frontend can prioritize overlaps: a run reaching 100% is a
// "finish" (proven they can close it out from that point), anything else is
// a plain practice "run". The 0->FROMZERO range is handled separately and
// always wins over both when drawing overlaps.
function parseRuns(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((chunk) => {
      const m = chunk.trim().match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
      if (!m) return null;
      const start = Math.max(0, Math.min(100, Number(m[1])));
      const end = Math.max(0, Math.min(100, Number(m[2])));
      if (end <= start) return null;
      return { start, end, kind: end >= 100 ? "finish" : "run" };
    })
    .filter(Boolean);
}

async function handleProgress(env) {
  const rows = await cached(env, "progress:v3", 300, async () => {
    const raw = await fetchSheetRows(env, "PROGRESS");
    // Sheet columns: LEVELNAME | PLAYERNAME | FROMZERO (percent, 0-100) | RUNS (optional, "40-85, 60-100")
    return raw
      .map((row) => {
        const pct = Math.max(0, Math.min(100, parseNum(pick(row, "fromzero", "pct", "progress", "percent"))));
        return {
          player: pick(row, "playername", "player"),
          level: pick(row, "levelname", "level"),
          pct,
          status: pick(row, "status") || (pct >= 100 ? "Completed" : "In progress"),
          runs: parseRuns(pick(row, "runs")),
        };
      })
      .filter((row) => row.player && row.level);
  });

  const byPlayer = {};
  for (const row of rows) {
    byPlayer[row.player] = byPlayer[row.player] || { player: row.player, entries: [] };
    byPlayer[row.player].entries.push({ level: row.level, pct: row.pct, status: row.status, runs: row.runs });
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
   UNRATED — the "UNRATED" sheet tab, its own list, and an optional
   overlay on the main list.
   Columns: LEVELNAME | PLAYERNAME | VERIFIER (1 = this player is the
   verifier) | CLANRANK | ?VIDEOLINK
   - Several rows can share a level; they're grouped into one level with
     one displayed victor (the verifier, else a "(First Victor)" row, else
     the first row) and everyone else as following victors. A trailing
     "(Verifier)" / "(First Victor)" in LEVELNAME is read as a hint and
     stripped from the displayed name.
   - CLANRANK is the position the level would hold on the main list
     (e.g. 5 = it would be #5, pushing the levels from #5 down by one).
     Levels without one only show on the Unrated tab.
   - Points aren't part of the clan curve: an unrated level gets points
     from the rated levels either side of it (the midpoint, or evenly
     spaced if several unrated levels sit in the same gap; the very top
     and bottom use 500 / 1 as the outer bound).
   ============================================================ */
function cleanUnratedName(raw) {
  let name = String(raw ?? "").trim();
  let verifierHint = false, firstHint = false;
  const m = name.match(/\s*\((verifier|first victor)\)\s*$/i);
  if (m) {
    name = name.slice(0, m.index).trim();
    if (/verifier/i.test(m[1])) verifierHint = true; else firstHint = true;
  }
  return { name, verifierHint, firstHint };
}

async function getUnratedLevelsCached(env) {
  return cached(env, "unrated:v3", 300, async () => {
    const rows = await fetchSheetRows(env, "UNRATED");
    const groups = new Map();
    rows.forEach((row, index) => {
      const { name, verifierHint, firstHint } = cleanUnratedName(pick(row, "levelname", "name", "level"));
      const player = String(pick(row, "playername", "player") || "").trim();
      if (!name || !player) return;
      const key = normName(name);
      if (!groups.has(key)) groups.set(key, { key, name, clanRank: null, sheetIndex: index, victors: [] });
      const g = groups.get(key);

      const rankRaw = pick(row, "clanrank");
      const rank = rankRaw === "" ? NaN : Number(String(rankRaw).replace(/[^\d.\-]/g, ""));
      if (g.clanRank == null && Number.isFinite(rank) && rank > 0) g.clanRank = rank;

      const vCell = pick(row, "verifier");
      const isVerifier = verifierHint || parseNum(vCell) > 0 || /^(true|yes|y|x|✓|✔)$/i.test(String(vCell).trim());
      g.victors.push({ player, isVerifier, isFirst: firstHint, videoUrl: String(pick(row, "videolink", "video") || "").trim() || null });
    });
    return [...groups.values()];
  });
}

// One sheet group -> a card entry shaped like a list entry.
function unratedEntry(g, countryByName) {
  const ordered = [...g.victors].sort((a, b) => (b.isVerifier - a.isVerifier) || (b.isFirst - a.isFirst));
  const shown = ordered[0];
  const seen = new Set([normName(shown.player)]);
  const following = [];
  for (const v of ordered.slice(1)) {
    if (seen.has(normName(v.player))) continue;
    seen.add(normName(v.player));
    following.push(v.player);
  }
  return {
    unrated: true,
    key: g.key,
    rank: null,
    name: g.name,
    creator: "Unknown",
    verifier: shown.player,
    verifierCountry: countryByName.get(normName(shown.player)) ?? null,
    points: null,
    videoUrl: shown.videoUrl || ordered.find((v) => v.videoUrl)?.videoUrl || null,
    achievedAt: null,
    followingVictors: following,
    clanRank: g.clanRank,
    placement: null,
    sheetIndex: g.sheetIndex,
  };
}

// Drops the placed unrated levels into the rated list at their CLANRANK and
// prices them from their rated neighbours. `rated` must be hardest-first and
// already carry clan-curve points. Rated entries get a `combinedRank` too.
async function combineWithUnrated(env, rated) {
  const [groups, roster] = await Promise.all([getUnratedLevelsCached(env), getClanRosterCached(env)]);
  const countryByName = new Map();
  for (const m of roster) for (const n of [m.global_name, m.username]) if (n && !countryByName.has(normName(n))) countryByName.set(normName(n), m.country ?? null);

  const unratedAll = groups.map((g) => unratedEntry(g, countryByName));
  const placed = unratedAll
    .filter((u) => u.clanRank != null)
    .sort((a, b) => a.clanRank - b.clanRank || a.sheetIndex - b.sheetIndex);

  const total = rated.length + placed.length;
  const slots = new Array(total).fill(null);
  for (const u of placed) {
    let pos = Math.min(Math.max(Math.round(u.clanRank), 1), total) - 1;
    while (pos < total && slots[pos]) pos++;
    if (pos >= total) { pos = total - 1; while (pos >= 0 && slots[pos]) pos--; }
    slots[pos] = u;
  }
  let ri = 0;
  for (let i = 0; i < total; i++) if (!slots[i]) slots[i] = rated[ri++];

  slots.forEach((e, i) => { e.combinedRank = i + 1; if (e.unrated) e.placement = i + 1; });

  // Price each run of consecutive unrated levels between its rated neighbours.
  for (let i = 0; i < total; ) {
    if (!slots[i].unrated) { i++; continue; }
    let j = i;
    while (j + 1 < total && slots[j + 1].unrated) j++;
    const above = i === 0 ? CLAN_POINTS_MAX : slots[i - 1].points;
    const below = j === total - 1 ? CLAN_POINTS_MIN : slots[j + 1].points;
    const k = j - i + 1;
    for (let t = 1; t <= k; t++) slots[i + t - 1].points = Math.round(above + ((below - above) * t) / (k + 1));
    i = j + 1;
  }

  const unplaced = unratedAll.filter((u) => u.clanRank == null).sort((a, b) => a.name.localeCompare(b.name));
  return { merged: slots, unratedAll: [...placed, ...unplaced] };
}

async function handleUnrated(env) {
  const rated = await getRatedEntries(env);
  const { unratedAll } = await combineWithUnrated(env, rated);
  return json(unratedAll);
}

/* ============================================================
   /api/members — clan leaderboard, points summed directly from
   real completions (see getClanCompletionsCached above), using the
   same clan-curve points as List/Monthly (not AREDL's own points,
   and not AREDL's pre-split clan "contribution" figure). Country
   comes straight from the clan roster. Optional "MEMBERS" sheet tab
   (player | youtube) adds a channel link per member.
   ============================================================ */
// Per-member stat blocks for the Members page dropdowns, derived from the
// same merged completions map as everything else. Only main-list levels
// count (AREDL's main list is the extreme demon list, so "extreme demon
// count" = how many main-list levels they've beaten). "First victory" uses
// the exact same earliest-achieved_at ordering as /api/list, so the member
// shown as a level's verifier there is the one credited with the first
// victory here.
function buildMemberStats(byLevel, clanPoints) {
  const stats = new Map(); // member id -> { completions: [], firstVictories: [] }
  const get = (id) => {
    if (!stats.has(id)) stats.set(id, { completions: [], firstVictories: [] });
    return stats.get(id);
  };

  for (const { level, completions } of Object.values(byLevel)) {
    if (level.position == null) continue;
    const sorted = [...completions].sort(
      (a, b) => new Date(recordAchievedAt(a.record) || 0) - new Date(recordAchievedAt(b.record) || 0)
    );
    sorted.forEach(({ member, record }, i) => {
      const s = get(member.id);
      s.completions.push({ level, achievedAt: recordAchievedAt(record), videoUrl: recordVideoUrl(record) });
      if (i === 0) s.firstVictories.push(level);
    });
  }

  const brief = (c) => ({
    id: c.level.id,
    levelId: c.level.level_id ?? null, // in-game id, for thumbnails
    name: c.level.name,
    position: c.level.position,
    points: clanPoints.get(c.level.id) ?? null,
    videoUrl: c.videoUrl || null,
  });

  const out = new Map();
  for (const [id, s] of stats) {
    const byHardest = [...s.completions].sort((a, b) => a.level.position - b.level.position);
    const dated = s.completions
      .filter((c) => c.achievedAt)
      .sort((a, b) => new Date(b.achievedAt) - new Date(a.achievedAt));
    out.set(id, {
      hardest: brief(byHardest[0]),
      extremeCount: s.completions.length,
      mostRecent: dated[0] ? { ...brief(dated[0]), achievedAt: dated[0].achievedAt } : null,
      firstVictories: {
        count: s.firstVictories.length,
        levels: s.firstVictories
          .sort((a, b) => a.position - b.position)
          .map((l) => ({ name: l.name, position: l.position })),
      },
      top: byHardest.slice(0, 5).map(brief),
    });
  }
  return out;
}

const EMPTY_MEMBER_STATS = {
  hardest: null,
  extremeCount: 0,
  mostRecent: null,
  firstVictories: { count: 0, levels: [] },
  top: [],
};

// Discord profile picture URL for a clan roster entry. Members with a custom
// avatar get it from Discord's CDN (animated "a_" hashes are gifs); members
// without one get Discord's default avatar for their account, picked the same
// way Discord does it ((id >> 22) % 6). No discord_id at all -> null, and the
// frontend falls back to an initial in a circle.
function discordAvatarUrl(m) {
  if (!m.discord_id) return null;
  if (m.discord_avatar) {
    const ext = String(m.discord_avatar).startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${m.discord_id}/${m.discord_avatar}.${ext}?size=64`;
  }
  try {
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(m.discord_id) >> 22n) % 6n)}.png`;
  } catch {
    return null;
  }
}

async function getMembersCached(env) {
  return cached(env, "members:v9", 900, async () => {
    const { byLevel, members } = await getClanCompletionsCached(env);
    const clanPoints = buildClanPointsMap(byLevel);
    const statsById = buildMemberStats(byLevel, clanPoints);

    const pointsById = new Map();
    for (const { level, completions } of Object.values(byLevel)) {
      if (level.position == null) continue; // only main-list levels count toward points
      const pts = clanPoints.get(level.id) || 0;
      for (const { member } of completions) {
        pointsById.set(member.id, (pointsById.get(member.id) || 0) + pts);
      }
    }

    const result = members.map((m) => ({
      id: m.id,
      name: m.global_name || m.username,
      points: Math.round((pointsById.get(m.id) || 0) * 100) / 100,
      country: m.country ?? null,
      avatar: discordAvatarUrl(m),
      stats: statsById.get(m.id) ?? EMPTY_MEMBER_STATS,
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
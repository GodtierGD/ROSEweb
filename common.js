/* ============================================================
   ROSE Demonlist — shared front-end logic
   Rename the clan in CONFIG.clanName. Point CONFIG.apiBase at your
   deployed Worker once it's live; until then every fetch() below
   falls back to the MOCK_* data at the bottom of this file so the
   pages render standalone.
   ============================================================ */
const CONFIG = {
  clanName: "ROSE",
  tagline: "Community Extreme Demon List",
  apiBase: "/api", // e.g. "https://roseweb.your-subdomain.workers.dev/api"
  discordUrl: "#",
};

const NAV_ITEMS = [
  { href: "index.html", label: "Home" },
  {
    label: "List",
    group: [
      { href: "list.html", label: "List" },
      { href: "monthly.html", label: "Monthly" },
      { href: "unrated.html", label: "Unrated", unrated: true },
      { href: "other.html", label: "Other" },
    ],
  },
  { href: "members.html", label: "Members" },
  { href: "progress.html", label: "Progress" },
  { href: "videos.html", label: "Videos" },
];

function renderNav(activeHref) {
  const mount = document.getElementById("site-nav");
  if (!mount) return;

  const linkCls = (item) =>
    ["", item.unrated ? "tab-unrated" : "", item.href === activeHref ? "active" : ""].filter(Boolean).join(" ").trim();

  const tabs = NAV_ITEMS.map((item) => {
    if (!item.group) return `<a href="${item.href}" class="${linkCls(item)}">${item.label}</a>`;

    const groupActive = item.group.some((g) => g.href === activeHref);
    const items = item.group
      .map((g) => {
        const cls = ["nav-dropdown-item", g.unrated ? "tab-unrated" : "", g.href === activeHref ? "active" : ""]
          .filter(Boolean).join(" ").trim();
        return `<a href="${g.href}" class="${cls}">${g.label}</a>`;
      })
      .join("");
    return `
      <div class="nav-dropdown${groupActive ? " active" : ""}">
        <button type="button" class="nav-dropdown-trigger">${item.label} <span class="nav-caret">&#9662;</span></button>
        <div class="nav-dropdown-menu">${items}</div>
      </div>
    `;
  }).join("");

  mount.innerHTML = `
    <div class="container">
      <a href="index.html" class="nav-brand">
        <span class="mark">${CONFIG.clanName}</span><span class="sub">${CONFIG.tagline}</span>
      </a>
      <button class="nav-toggle" id="nav-toggle" aria-label="Toggle menu">&#9776;</button>
      <div class="nav-tabs" id="nav-tabs">${tabs}</div>
    </div>
  `;

  const toggle = document.getElementById("nav-toggle");
  const tabsEl = document.getElementById("nav-tabs");
  toggle?.addEventListener("click", () => tabsEl.classList.toggle("open"));

  // Dropdown: click the trigger to open/close; clicking elsewhere closes it.
  mount.querySelectorAll(".nav-dropdown").forEach((dd) => {
    dd.querySelector(".nav-dropdown-trigger").addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = dd.classList.contains("open");
      mount.querySelectorAll(".nav-dropdown.open").forEach((o) => o.classList.remove("open"));
      if (!wasOpen) dd.classList.add("open");
    });
  });
  document.addEventListener("click", () => {
    mount.querySelectorAll(".nav-dropdown.open").forEach((o) => o.classList.remove("open"));
  });
}

/* ------------------------------------------------------------
   API helper — tries the Worker, falls back to bundled mock data
   so every page still works before the backend is deployed.
   ------------------------------------------------------------ */
async function apiGet(path, mockData) {
  try {
    const res = await fetch(`${CONFIG.apiBase}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[demonlist] falling back to mock data for ${path}:`, err.message);
    return mockData;
  }
}

/* ------------------------------------------------------------
   Tiering helper — purely visual, encodes rank into color weight
   ------------------------------------------------------------ */
function tierClass(rank) {
  if (rank <= 10) return "";
  if (rank <= 40) return "tier-mid";
  return "tier-low";
}

/* Deterministic placeholder background gradient per level, so
   cards without a real thumbnail still look distinct. Swap the
   `bg` field on a level object for a real image URL when you have one. */
function fallbackGradient(seed) {
  const hues = [352, 268, 200, 22, 320, 190];
  const h = hues[seed % hues.length];
  return `radial-gradient(circle at 30% 30%, hsl(${h} 90% 45%) 0%, hsl(${(h + 40) % 360} 70% 15%) 55%, #0b0a0e 100%)`;
}

const COUNTRY_NUM_TO_ISO2 = {"533":"aw","4":"af","24":"ao","660":"ai","248":"ax","8":"al","20":"ad","784":"ae","32":"ar","51":"am","16":"as","10":"aq","260":"tf","28":"ag","36":"au","40":"at","31":"az","108":"bi","56":"be","204":"bj","535":"bq","854":"bf","50":"bd","100":"bg","48":"bh","44":"bs","70":"ba","652":"bl","112":"by","84":"bz","60":"bm","68":"bo","76":"br","52":"bb","96":"bn","64":"bt","74":"bv","72":"bw","140":"cf","124":"ca","166":"cc","756":"ch","152":"cl","156":"cn","384":"ci","120":"cm","180":"cd","178":"cg","184":"ck","170":"co","174":"km","132":"cv","188":"cr","192":"cu","531":"cw","162":"cx","136":"ky","196":"cy","203":"cz","276":"de","262":"dj","212":"dm","208":"dk","214":"do","12":"dz","218":"ec","818":"eg","232":"er","732":"eh","724":"es","233":"ee","231":"et","246":"fi","242":"fj","238":"fk","250":"fr","234":"fo","583":"fm","266":"ga","826":"gb","268":"ge","831":"gg","288":"gh","292":"gi","324":"gn","312":"gp","270":"gm","624":"gw","226":"gq","300":"gr","308":"gd","304":"gl","320":"gt","254":"gf","316":"gu","328":"gy","344":"hk","334":"hm","340":"hn","191":"hr","332":"ht","348":"hu","360":"id","833":"im","356":"in","86":"io","372":"ie","364":"ir","368":"iq","352":"is","376":"il","380":"it","388":"jm","832":"je","400":"jo","392":"jp","398":"kz","404":"ke","417":"kg","116":"kh","296":"ki","659":"kn","410":"kr","414":"kw","418":"la","422":"lb","430":"lr","434":"ly","662":"lc","438":"li","144":"lk","426":"ls","440":"lt","442":"lu","428":"lv","446":"mo","663":"mf","504":"ma","492":"mc","498":"md","450":"mg","462":"mv","484":"mx","584":"mh","807":"mk","466":"ml","470":"mt","104":"mm","499":"me","496":"mn","580":"mp","508":"mz","478":"mr","500":"ms","474":"mq","480":"mu","454":"mw","458":"my","175":"yt","516":"na","540":"nc","562":"ne","574":"nf","566":"ng","558":"ni","570":"nu","528":"nl","578":"no","524":"np","520":"nr","554":"nz","512":"om","586":"pk","591":"pa","612":"pn","604":"pe","608":"ph","585":"pw","598":"pg","616":"pl","630":"pr","408":"kp","620":"pt","600":"py","275":"ps","258":"pf","634":"qa","638":"re","642":"ro","643":"ru","646":"rw","682":"sa","729":"sd","686":"sn","702":"sg","239":"gs","654":"sh","744":"sj","90":"sb","694":"sl","222":"sv","674":"sm","706":"so","666":"pm","688":"rs","728":"ss","678":"st","740":"sr","703":"sk","705":"si","752":"se","748":"sz","534":"sx","690":"sc","760":"sy","796":"tc","148":"td","768":"tg","764":"th","762":"tj","772":"tk","795":"tm","626":"tl","776":"to","780":"tt","788":"tn","792":"tr","798":"tv","158":"tw","834":"tz","800":"ug","804":"ua","581":"um","858":"uy","840":"us","860":"uz","336":"va","670":"vc","862":"ve","92":"vg","850":"vi","704":"vn","548":"vu","876":"wf","882":"ws","887":"ye","710":"za","894":"zm","716":"zw"};

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// AREDL gives countries as ISO 3166-1 numeric codes. Flags are images (flagcdn)
// because flag emoji don't render on Windows.
function flagHTML(num) {
  const iso = COUNTRY_NUM_TO_ISO2[num];
  if (!iso) return "";
  return `<img class="flag" src="https://flagcdn.com/24x18/${iso}.png" srcset="https://flagcdn.com/48x36/${iso}.png 2x" width="20" height="15" alt="${iso.toUpperCase()}" title="${iso.toUpperCase()}" loading="lazy">`;
}

// Internal rank is ROSE's own sequential numbering (#1 = hardest level the
// clan has beaten, #2 = next hardest, ...), distinct from a level's real
// AREDL placement, which can have gaps (the clan's hardest beat might be
// global AREDL #19, not #1). Computed once from the full hardest-to-easiest
// order so it stays stable regardless of filtering, search, or the current
// sort — and regardless of which page is asking, since it's always derived
// the same way from the same underlying `rank` (AREDL placement).
function assignInternalRanks(levels) {
  [...levels].sort((a, b) => a.rank - b.rank).forEach((lvl, i) => { lvl.internalRank = i + 1; });
}

// Maps a level for display under a given sort mode: whichever number isn't
// the big badge this time becomes a small `altRankLabel` next to the name.
function applyRankDisplay(level, sort) {
  const useAredl = sort === "aredl";
  return {
    ...level,
    rank: useAredl ? level.rank : level.internalRank,
    altRankLabel: useAredl ? `Internal #${level.internalRank}` : `AREDL #${level.rank}`,
  };
}

function levelCardHTML(level, index) {
  const tier = tierClass(level.rank);
  const bgStyle = level.bg ? `background-image:url('${level.bg}');background-size:cover;background-position:center;` : `background:${fallbackGradient(index)};`;
  const extraCount = level.followingVictors ? level.followingVictors.length : 0;
  const extraVictors = extraCount
    ? `<span class="extra-victors" title="${esc(level.followingVictors.join(", "))}">+${extraCount} victor${extraCount === 1 ? "" : "s"}</span>`
    : "";
  return `
    <div class="level-card" data-card="${index}">
      <div class="bg-layer" style="${bgStyle}"></div>
      <div class="fade-layer"></div>
      <div class="rank ${tier}">#${level.rank}</div>
      <div class="divider"></div>
      <div class="level-meta">
        <div class="name-row">
          <div class="name">${esc(level.name)}</div>
          ${level.altRankLabel ? `<span class="alt-rank">${esc(level.altRankLabel)}</span>` : ""}
        </div>
        <div class="by"><b>${esc(level.verifier)}</b>${flagHTML(level.verifierCountry)}${extraVictors}</div>
      </div>
      <div class="level-side">
        ${level.points ? `<span class="pill points">${level.points} pts</span>` : ""}
        ${level.videoUrl ? `<a class="watch-link" href="${esc(level.videoUrl)}" target="_blank" rel="noopener"><span>Watch</span> ▶</a>` : ""}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------
   YouTube thumbnail fallback — maxresdefault doesn't exist for every
   upload, so step down through qualities until one actually loads.
   Runs client-side (needs a real <img> load to tell a real thumbnail
   apart from YouTube's generic grey placeholder).
   ------------------------------------------------------------ */
const THUMB_QUALITIES = ["maxresdefault", "sddefault", "hqdefault", "mqdefault", "default"];

function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function resolveYouTubeThumbnail(videoId) {
  return new Promise((resolve) => {
    let i = 0;
    function tryNext() {
      if (i >= THUMB_QUALITIES.length) return resolve(null);
      const url = `https://img.youtube.com/vi/${videoId}/${THUMB_QUALITIES[i]}.jpg`;
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth > 200) resolve(url);
        else { i++; tryNext(); }
      };
      img.onerror = () => { i++; tryNext(); };
      img.src = url;
    }
    tryNext();
  });
}

// Call this after inserting levelCardHTML(...) output into the DOM, passing
// the same container and level array used to build it. Progressively
// upgrades each card's blurred placeholder to its real video thumbnail
// without blocking the initial render.
function loadImageOk(url, minWidth = 1) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth >= minWidth ? url : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// AREDL's own official thumbnail repo (All-Rated-Extreme-Demon-List/Thumbnails
// on GitHub) — auto-updated, has a "cards" crop built for exactly this use
// case. Served through jsDelivr rather than raw.githubusercontent.com, since
// raw.githubusercontent rate-limits/blocks hotlinking and jsDelivr is the
// standard CDN front for GitHub-hosted assets. The exact filename scheme
// (AREDL's internal level uuid vs the in-game numeric id, .webp vs .png)
// isn't confirmed, so every plausible combination is tried in order — each
// failure just falls through silently to the next candidate, ending at the
// community thumbnail service and then the completion video's own thumbnail.
function aredlThumbnailCandidates(level) {
  const base = "https://cdn.jsdelivr.net/gh/All-Rated-Extreme-Demon-List/Thumbnails@main/levels/cards/";
  const ids = [level.id, level.levelId].filter(Boolean);
  const exts = ["webp", "png"];
  const urls = [];
  for (const id of ids) for (const ext of exts) urls.push(`${base}${id}.${ext}`);
  return urls;
}

async function firstWorkingImage(urls) {
  for (const url of urls) {
    const ok = await loadImageOk(url);
    if (ok) return ok;
  }
  return null;
}

function hydrateThumbnails(container, levels) {
  levels.forEach(async (level, i) => {
    const card = container.querySelector(`[data-card="${i}"] .bg-layer`);
    if (!card) return;
    // 1) AREDL's own official thumbnail repo (best quality, most "official")
    let url = await firstWorkingImage(aredlThumbnailCandidates(level));
    // 2) the level's own in-game thumbnail (community thumbnail service)
    if (!url && level.levelId) url = await loadImageOk(`https://levelthumbs.prevter.me/thumbnail/${level.levelId}/small`);
    // 3) fall back to the completion video's YouTube thumbnail
    if (!url) {
      const videoId = extractYouTubeId(level.videoUrl);
      if (videoId) url = await resolveYouTubeThumbnail(videoId);
    }
    if (!url) return;
    card.style.backgroundImage = `url('${url}')`;
    card.style.backgroundSize = "cover";
    card.style.backgroundPosition = "center";
  });
}

/* ============================================================
   Mock data — replace once /api/* is live
   ============================================================ */
const MOCK_LIST = [
  { rank: 1, name: "Bloodbath", creator: "Riot", verifier: "Yaser", points: 500, videoUrl: "#", followingVictors: ["Comzy", "Skelezavr"] },
  { rank: 2, name: "Tidal Wave", creator: "OniLinkGD", verifier: "Zoink", points: 486, videoUrl: "#" },
  { rank: 3, name: "Acheron", creator: "Rusty313", verifier: "Skelezavr", points: 471, videoUrl: "#" },
  { rank: 4, name: "Slaughterhouse", creator: "iCedCave", verifier: "Friajir", points: 452, videoUrl: "#" },
  { rank: 5, name: "Kyouki", creator: "Zenthos", verifier: "Comzy", points: 430, videoUrl: "#" },
  { rank: 6, name: "Silent Clubstep", creator: "ryamu", verifier: "Ramenq", points: 410, videoUrl: "#" },
  { rank: 12, name: "Tartarus", creator: "ItzDolphy", verifier: "Player12", points: 340, videoUrl: "#" },
  { rank: 45, name: "Windy Landscape", creator: "Woogi1411", verifier: "Player45", points: 118, videoUrl: "#" },
];

const MOCK_MONTHLY = {
  "September 2026": [
    { rank: 1, name: "Bloodbath", creator: "Riot", verifier: "Yaser", points: 500, videoUrl: "#" },
    { rank: 7, name: "Firework", creator: "Bausha11", verifier: "Comzy", points: 398, videoUrl: "#" },
  ],
  "August 2026": [
    { rank: 3, name: "Acheron", creator: "Rusty313", verifier: "Skelezavr", points: 471, videoUrl: "#" },
  ],
};

const MOCK_PROGRESS = [
  {
    player: "Skelezavr",
    entries: [
      { level: "Acheron", pct: 100, status: "Completed", runs: [] },
      { level: "Avernus", pct: 87, status: "In progress", runs: [{ start: 60, end: 95, kind: "run" }] },
      { level: "Kyouki", pct: 62, status: "In progress", runs: [{ start: 85, end: 100, kind: "finish" }] },
    ],
  },
  {
    player: "Sterling",
    entries: [
      { level: "Zodiac", pct: 0, status: "In progress", runs: [{ start: 40, end: 75, kind: "run" }, { start: 90, end: 100, kind: "finish" }] },
    ],
  },
  {
    player: "Comzy",
    entries: [
      { level: "Kyouki", pct: 100, status: "Completed", runs: [] },
      { level: "Firework", pct: 100, status: "Completed", runs: [] },
      { level: "Silent Clubstep", pct: 41, status: "In progress", runs: [] },
    ],
  },
];

const MOCK_VIDEOS = [
  { title: "Bloodbath by Riot — 100%", channel: `${CONFIG.clanName} Clips`, published: "2026-09-18", url: "#", thumb: null },
  { title: "Kyouki Progress — 64% Run", channel: `${CONFIG.clanName} Clips`, published: "2026-09-14", url: "#", thumb: null },
  { title: "Firework Verification", channel: `${CONFIG.clanName} Clips`, published: "2026-09-06", url: "#", thumb: null },
];

const MOCK_UNRATED = [
  { name: "New Frontier", creator: "Zenthos", verifier: "Comzy", note: "Awaiting rate — submitted to mod team" },
  { name: "Hollow Point", creator: "ryamu", verifier: "Player12", note: "Under review" },
];

const MOCK_MEMBERS = [
  { rank: 1, name: "Skelezavr", points: 3120.5, country: 643, youtube: "#" },
  { rank: 2, name: "Comzy", points: 2874.1, country: 826, youtube: "#" },
  { rank: 3, name: "Yaser", points: 1990.8, country: 840, youtube: null },
  { rank: 4, name: "Player12", points: 842.3, country: 276, youtube: null },
];

const MOCK_OTHER = {
  highest: [
    { player: "Comzy", level: "Silent Clubstep", attempts: 48210, country: 826, videoUrl: "#" },
    { player: "Skelezavr", level: "Acheron", attempts: 31544, country: 643, videoUrl: "#" },
  ],
  lowest: [
    { player: "Yaser", level: "Tartarus", attempts: 14, country: 840, videoUrl: "#" },
    { player: "Player12", level: "Windy Landscape", attempts: 37, country: 276, videoUrl: "#" },
  ],
};
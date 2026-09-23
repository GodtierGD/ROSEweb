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
  { href: "list.html", label: "List" },
  { href: "monthly.html", label: "Monthly" },
  { href: "progress.html", label: "Progress" },
  { href: "videos.html", label: "Videos" },
  { href: "unrated.html", label: "UNRATED", unrated: true },
];

function renderNav(activeHref) {
  const mount = document.getElementById("site-nav");
  if (!mount) return;
  const tabs = NAV_ITEMS.map((item) => {
    const cls = ["", item.unrated ? "tab-unrated" : "", item.href === activeHref ? "active" : ""]
      .filter(Boolean)
      .join(" ")
      .trim();
    return `<a href="${item.href}" class="${cls}">${item.label}</a>`;
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

function levelCardHTML(level, index) {
  const tier = tierClass(level.rank);
  const bgStyle = level.bg ? `background-image:url('${level.bg}');background-size:cover;background-position:center;` : `background:${fallbackGradient(index)};`;
  return `
    <div class="level-card">
      <div class="bg-layer" style="${bgStyle}"></div>
      <div class="fade-layer"></div>
      <div class="rank ${tier}">#${level.rank}</div>
      <div class="divider"></div>
      <div class="level-meta">
        <div class="name">${level.name}</div>
        <div class="by">by <b>${level.creator}</b> — beaten by <b>${level.verifier}</b></div>
      </div>
      <div class="level-side">
        ${level.points ? `<span class="pill points">${level.points} pts</span>` : ""}
        ${level.videoUrl ? `<a class="watch-link" href="${level.videoUrl}" target="_blank" rel="noopener"><span>Watch</span> ▶</a>` : ""}
      </div>
    </div>
  `;
}

/* ============================================================
   Mock data — replace once /api/* is live
   ============================================================ */
const MOCK_LIST = [
  { rank: 1, name: "Bloodbath", creator: "Riot", verifier: "Yaser", points: 500, videoUrl: "#" },
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
      { level: "Acheron", pct: 100, status: "Completed" },
      { level: "Avernus", pct: 87, status: "In progress" },
      { level: "Kyouki", pct: 64, status: "In progress" },
    ],
  },
  {
    player: "Comzy",
    entries: [
      { level: "Kyouki", pct: 100, status: "Completed" },
      { level: "Firework", pct: 100, status: "Completed" },
      { level: "Silent Clubstep", pct: 41, status: "In progress" },
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

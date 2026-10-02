# ROSE Demonlist

A community demonlist for a clan's AREDL beats: **Home, List, Monthly, Members,
Videos, Unrated, Progress, Other**.

Pages open standalone right now (open `index.html`) — every page falls back
to mock data in `common.js` until the Worker API is live, so you can preview
and tweak the design before touching the backend.

## Rename the clan

Everything site-wide (name shown in the nav, footer, tagline, Discord link) is
one object at the top of `common.js`:

```js
const CONFIG = {
  clanName: "ROSE",
  tagline: "Community Extreme Demon List",
  apiBase: "/api",
  discordUrl: "#",
};
```

## Deploy the Worker

1. `npm install -g wrangler` (if you don't have it)
2. Create the KV namespace, then paste its id into
   `wrangler.toml`:
   ```
   wrangler kv namespace create CACHE
   ```
3. (D1 is no longer used — skip any migration.)
4. Fill in `wrangler.toml`'s `[vars]`:
   - `AREDL_API_BASE` — AREDL's current API base URL (check their docs; it can change)
   - `CLAN_SHEET_ID` — see below
   - `VIDEO_FEED_URL` — a public RSS/Atom feed for the channel (most platforms expose one without needing an API key)
5. `wrangler deploy`
6. In `common.js`, set `CONFIG.apiBase` to your deployed Worker's URL (e.g.
   `https://roseweb.<subdomain>.workers.dev/api`).

`handleList()` calls AREDL's real `/v2/api/aredl/levels` (and
`/v2/api/aredl/levels/{id}` for the per-level fallback video) — these are
confirmed endpoints, but worth re-checking against AREDL's docs if either
ever starts 404ing, since public APIs do move.

## Wire up the Google Sheet (Unrated, Progress, Other, Members)

Everything below reads one Google Sheet, each feature from its own tab.

1. Tabs and header row (row 1) — header names aren't case-sensitive:
   - `UNRATED`: `LEVELNAME`, `PLAYERNAME`
   - `PROGRESS`: `LEVELNAME`, `PLAYERNAME`, `FROMZERO` (progress percent, 0-100; 100 counts as Completed)
   - `HIGHATT`: `LEVELNAME`, `PLAYERNAME`, `ATTEMPTS` (most attempts — top 10 shown)
   - `LOWATT`: `LEVELNAME`, `PLAYERNAME`, `ATTEMPTS` (fewest attempts — top 10 shown)
   - `MEMBERS` (optional): `PLAYERNAME`, `YOUTUBE` — adds a YouTube button on the Members page.
   - Any other tab (like `Sheet Info`) is ignored.
2. Share the sheet as **"Anyone with the link can view"**.
3. Put the sheet id (the part between `/d/` and `/edit` in its URL) in `CLAN_SHEET_ID` in `wrangler.toml`.

Each tab is cached for 5 minutes. The old `Records` tab is no longer used — list and monthly come straight from AREDL.

## Members, flags and backgrounds

- `/api/members` ranks the clan by AREDL points using the clan endpoint's `members_points`; flags come from each member's AREDL country code (shown via flagcdn images).
- Level card backgrounds try the level's in-game thumbnail first, then fall back to the completion video's YouTube thumbnail.
- Every page has Open Graph tags so links unfurl nicely on Discord. To add a preview image, add an `og:image` meta tag with an absolute URL to each page.

## Deploy the frontend

`wrangler.toml`'s `[assets]` block already serves `index.html`, `style.css`,
`common.js` etc. straight from this same Worker — visiting the Worker's own
`*.workers.dev` URL (or a custom domain pointed at it) serves the site.
`.assetsignore` keeps the non-frontend files (`worker.js`, `wrangler.toml`,
the migration, this README) from being published as downloadable pages.

If you'd rather split the frontend onto Cloudflare Pages instead (its own
project, its own URL), remove the `[assets]` block and point a Pages project
at this repo instead — just make sure `CONFIG.apiBase` in `common.js` points
at the Worker's URL in that case, since they'd no longer share one origin.

## Project structure

```
index.html          Home
list.html            List (full ranked demonlist)
monthly.html         Monthly (archived by month)
progress.html        Progress (per-player progress bars, Google Sheet PROGRESS tab)
videos.html           Videos (channel upload feed)
unrated.html          UNRATED (Google Sheet tab)
style.css             Shared design system
common.js             Shared config, nav, API calls, mock data
worker.js             Cloudflare Worker: /api/list /api/monthly /api/progress /api/videos /api/unrated
0001_initial.sql       D1 schema for monthly snapshots
wrangler.toml
```

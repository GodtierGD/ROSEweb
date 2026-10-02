# ROSE Demonlist

A community demonlist for a clan's AREDL beats: **Home, List, Monthly, Progress,
Videos**, plus an **UNRATED** tab pulled live from a Google Sheet.

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
2. Create the D1 database and KV namespace, then paste their ids into
   `wrangler.toml`:
   ```
   wrangler d1 create rift-demonlist
   wrangler kv namespace create CACHE
   ```
3. Run the migration: `wrangler d1 execute rift-demonlist --file=0001_initial.sql`
4. Fill in `wrangler.toml`'s `[vars]`:
   - `AREDL_API_BASE` — AREDL's current API base URL (check their docs; it can change)
   - `CLAN_SHEET_ID` — see below (backs the Records, UNRATED, and PROGRESS tabs)
   - `VIDEO_FEED_URL` — a public RSS/Atom feed for the channel (most platforms expose one without needing an API key)
5. `wrangler deploy`
6. In `common.js`, set `CONFIG.apiBase` to your deployed Worker's URL (e.g.
   `https://roseweb.<subdomain>.workers.dev/api`).

`handleList()` calls AREDL's real `/v2/api/aredl/levels` (and
`/v2/api/aredl/levels/{id}` for the per-level fallback video) — these are
confirmed endpoints, but worth re-checking against AREDL's docs if either
ever starts 404ing, since public APIs do move.

## Wire up the Google Sheet (Records + UNRATED + Progress)

`/api/list`, `/api/unrated`, and `/api/progress` all read from the same
Google Sheet, each from their own tab.

1. In the Google Sheet, make sure there are three tabs, named exactly
   `Records`, `UNRATED`, and `PROGRESS`:
   - `Records` columns: `Player`, `Record` (the level's exact AREDL name),
     `Date` (dd/mm/yyyy), `Completion` (video link — leave blank to fall
     back to AREDL's own verification video). One row per completion; if
     several clan members beat the same level, give each their own row and
     the site sorts them by date, crediting the earliest as the verifier
     and listing the rest as "also beaten by …". A `Record` that doesn't
     exactly match an AREDL level name gets skipped rather than crashing
     the list — check `wrangler tail` for a warning naming the likely typo.
   - `UNRATED` columns: `name`, `creator`, `verifier` (or `player`), `note`
   - `PROGRESS` columns: `player`, `level`, `pct` (a number, 0–100), `status`
     (optional — if left blank, it's inferred as "Completed" at 100% and
     "In progress" otherwise)
2. Share the sheet as **"Anyone with the link can view"**.
3. Copy the sheet's id out of its URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
4. Paste that id into `CLAN_SHEET_ID` in `wrangler.toml`.

The Worker reads each tab through Google's `gviz` endpoint
(`/gviz/tq?tqx=out:json&sheet=<tab name>`) — no API key or service account
needed, just a publicly viewable sheet. Each is cached for 5 minutes per
request (`fetchSheetRows` in `worker.js`), so sheet edits show up on the site
shortly after you make them.

## Deploy the frontend

Either:
- **Cloudflare Pages**: point a Pages project at this repo, or
- **Same Worker**: uncomment the `[assets]` block in `wrangler.toml` to serve
  the pages and the API from one Worker.

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

# RIFT Demonlist

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
  clanName: "RIFT",
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
   - `AREDL_CLAN_ID` — your clan's id/slug as AREDL's API identifies it
   - `UNRATED_SHEET_ID` — see below
   - `VIDEO_FEED_URL` — a public RSS/Atom feed for the channel (most platforms expose one without needing an API key)
5. `wrangler deploy`
6. In `common.js`, set `CONFIG.apiBase` to your deployed Worker's URL (e.g.
   `https://rift-demonlist.<subdomain>.workers.dev/api`).

`worker.js` has the exact response shape AREDL's API returns marked as an
assumption in `handleList()` — check that against AREDL's actual docs before
deploying, since the field names in this file are a best guess.

## Wire up the UNRATED Google Sheet

1. In the Google Sheet, make sure there's a tab literally named `UNRATED`
   with columns: `name`, `creator`, `verifier` (or `player`), `note`.
2. Share the sheet as **"Anyone with the link can view"**.
3. Copy the sheet's id out of its URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
4. Paste that id into `UNRATED_SHEET_ID` in `wrangler.toml`.

The Worker reads it through Google's `gviz` endpoint (`/gviz/tq?tqx=out:json`)
— no API key or service account needed, just a publicly viewable sheet. It's
cached for 5 minutes per request (`handleUnrated` in `worker.js`), so sheet
edits show up on the site shortly after you make them.

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
progress.html        Progress (per-player progress bars)
videos.html           Videos (channel upload feed)
unrated.html          UNRATED (Google Sheet tab)
style.css             Shared design system
common.js             Shared config, nav, API calls, mock data
worker.js             Cloudflare Worker: /api/list /api/monthly /api/progress /api/videos /api/unrated
0001_initial.sql       D1 schema for monthly snapshots + progress
wrangler.toml
```

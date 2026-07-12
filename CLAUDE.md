# Printable

Turkish custom-print storefront (sticker, poster, kartvizit, ambalaj) with an STL upload/quote page and an admin panel.

Plain HTML + CSS + vanilla JS on the front end. **No build step, no framework, no bundler** — the files served are the files in the repo. Express + `better-sqlite3` on the back end, deployed to Vercel as a serverless function.

```
index.html / styles.css / script.js   storefront
stl-teklif.html / stl-viewer.js       STL upload + quote
admin.html / admin.css / admin.js     admin panel (auth-gated)
login.html                            admin login
server.js                             entire backend: schema, auth, uploads, routes
api/index.js                          3-line re-export of server.js for Vercel
data/printable.sqlite                 gitignored, seeded on first boot
```

`npm start` → http://localhost:3000. Local admin: `admin` / `printable-admin`.

## Conventions

- All user-facing copy, `alt` text, and API error messages are **Turkish**. Class names, IDs, and code are English. Money renders as `24.90 TL` via the shared `money()` helper.
- No tests exist. Verify a change by running the app and exercising the flow, not by reading the diff.

## Skills — load the relevant one before you start

| Working on | Skill |
|---|---|
| Any CSS / UI / layout / spacing change | `frontend-design` — **required**; `styles.css` is a stack of override layers where the naive edit silently does nothing |
| Running the app, previewing, verifying | `run-preview` |
| Routes, auth, uploads, Vercel in `server.js` | `api-endpoint` |
| `admin.html` / `admin.js` / `admin.css` | `admin-panel` |
| DB columns, tables, seed data | `sqlite-schema` — a new column needs a migration, not just a `CREATE TABLE` edit |
| Meta tags, OG/social previews, JSON-LD, alt text, a new public page | `seo` — meta is injected server-side; setting it from JS silently breaks social previews |

## Admin-managed content

The banner (images + per-slide copy), the category grid, the colour palette, product colours and all SEO fields are edited from `/admin`, not from the HTML. Editing `index.html` to change the hero headline or a category name is the wrong move — that markup is overwritten at runtime from `/api/hero-slides` and `/api/categories`, and is only the no-JS fallback.

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

`npm start` → http://localhost:3000. Admin accounts live in the `admin_users` table (scrypt-hashed), **not** in env: on an empty table the names in `ADMIN_USERS` (default `ogulcan,furkan`) are seeded with `ADMIN_PASSWORD`. After that, passwords are managed from `/admin` → Yöneticiler, and changing `ADMIN_PASSWORD` no longer affects existing accounts.

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
| DB columns, tables, seed data | `sqlite-schema` — a new column needs a migration, not just a `CREATE TABLE` edit, **and `SCHEMA_VERSION` must be bumped or none of it reaches an existing database** |
| Product card / product detail markup | `product-templates.js` — one template, rendered by both the server and the browser (see below) |
| Meta tags, OG/social previews, JSON-LD, alt text, a new public page | `seo` — meta is injected server-side; setting it from JS silently breaks social previews |

## Product markup is rendered twice — never copy the template

`product-templates.js` is loaded by **both** Node (`require` in `server.js`) and the browser (`<script>`, injected before `script.js` by `injectShell`). The server prints the first HTML for `/urunler`, `/urun/:id` and the `/landing` stage; the browser re-prints the same box on every interaction (filter, scale, colour). Both call the **same function**.

Copying a template into `script.js` or `urun.js` is how this breaks: the two drift, and the page visibly jumps when JS takes over while crawlers see different content than customers. If you change product markup, change it in `product-templates.js` only, and keep every function there **pure** — no DOM access, no module-level state. Selection state (`seciliOlcekId`, `seciliRenkId`, `stokGoster`) is a parameter; the server passes the same defaults the client starts with.

The same rule covers anything the server pre-renders into a JS-filled box — the `/urunler` filter lists and active-filter chips, the account name in the header. If the server's HTML and the JS re-render differ by even a wrapper class, the page shifts.

Verify parity by calling the function in Node and in the browser with the same fixture and diffing the strings; the live catalogue has no priced scales or per-colour photos, so those branches are only reachable with synthetic data.

## Admin-managed content

The banner (images + per-slide copy), the category grid, the colour palette, product colours, 3D printing materials, the pricing coefficients and all SEO fields are edited from `/admin`, not from the HTML. Editing `index.html` to change the hero headline or a category name is the wrong move — that markup is overwritten at runtime from `/api/hero-slides` and `/api/categories`, and is only the no-JS fallback.

## STL quote wizard (`/stl-teklif`)

Five steps: file → material → per-part colours → infill/quantity → contact. `stl-viewer.js` renders the STL with three.js (resolved through an **import map** in the page head — three's addons import the bare specifier `"three"` and silently die without it), measures it, and asks the server for the price at every change. **The browser never prices anything**; `POST /api/quotes` recomputes server-side and ignores any price it is sent.

**Uploads are `.stl` or `.3mf`.** An STL is a bag of triangles with no notion of "objects" and no colour, so `splitIntoParts()` welds coincident vertices and runs union-find over the triangles: every **connected component** becomes its own mesh the customer can colour independently (pick it from the list or click it in the 3D view). Models above 400k triangles skip the split and stay one part — welding every vertex costs more than the feature is worth. **3MF is parsed by hand (`parse3mf()`), not by three's `3MFLoader`.** MakerWorld/Bambu files use the 3MF *production extension*: the root `3dmodel.model` holds no geometry, only `<component>` references into other `.model` files inside the zip. three's loader looks for a `<mesh>` that isn't there and dies with "Cannot read properties of undefined (reading 'mesh')". Our parser resolves the components, applies the 4x3 row-vector transforms, and reads part names + extruder numbers from `Metadata/model_settings.config`, mapping them to the filament colours in `Metadata/project_settings.config`. Mesh XML is scanned with regex, not DOM — these files run to 20 MB and 200k+ triangles.

Bambu also paints colour **per triangle** (`paint_color` on `<triangle>`), which is surface data, not objects, and is not something we can turn into parts. When present we set `quotes.painted`, warn the customer, and badge it in the admin: the paint only survives in the original file, so that job must be printed from the uploaded 3MF, not from the generated per-part STLs.

On submit the browser exports **one binary STL per part** alongside the original file, so the workshop can drop them into a slicer and assign a filament each. Every part is translated by the *same* model-wide centre, never its own — that is what keeps the pieces aligned with each other; re-centring each part individually would scatter the model. A test asserts the original gaps between parts survive the round trip.

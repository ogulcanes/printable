---
name: api-endpoint
description: Add or change a backend route in server.js — new /api/* endpoint, auth-protected route, file upload, page route, or anything touching Express, better-sqlite3 queries, the admin session cookie, or Vercel deployment. Read before editing server.js or api/index.js.
---

# API & server — Printable

`server.js` is the entire backend: Express app, SQLite schema, auth, uploads, routes, and static serving, in that order, in one file. `api/index.js` just re-exports it (`module.exports = app`) so Vercel can use it as a serverless function — `vercel.json` rewrites `/(.*)` to it. **Never add routes to `api/index.js`**; it must stay a three-line re-export. `server.js` only calls `app.listen()` under `require.main === module`, which is what makes both targets work — don't break that guard.

## Route conventions

Match the existing style exactly — no router files, no controllers, no async wrappers:

```js
app.get("/api/products", (req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY created_at DESC").all());
});
```

- Register routes **before** the `app.get("/admin", …)` block at the bottom.
- Prepared statements inline: `db.prepare("… WHERE id = ?").get(req.params.id)`. Named params (`@name`) for INSERT/UPDATE, positional (`?`) for lookups. Never string-concatenate SQL.
- Multi-statement writes go inside `db.transaction(() => { … })` — see `POST /api/orders`.
- Status codes in use: `201` + the created row on POST, `204` + `.end()` on DELETE, `400` for validation, `401` from `requireAdmin`, `404` for a missing row.
- Errors are `{ error: "Turkish message." }`. The client (`admin.js` `api()`, `script.js`) reads `payload.error` and shows it to the user, so the message must be Turkish and user-facing.
- Helpers already exist: `money()`, `nullableMoney()`, `toInt()`. Trim strings and coerce `""` → `null` the way `productPayload()` does.

## Auth

Admin auth is a hand-rolled HMAC-signed cookie (`printable_admin`), not a session library. `requireAdmin` is the gate, and it is **async** — it awaits a DB lookup, so never call it from a sync context:

```js
app.post("/api/thing", requireAdmin, (req, res) => { … });
```

- Add `requireAdmin` to **every** write or read that exposes business data. Currently public and intentionally so: `GET /api/products`, `POST /api/customers`, `POST /api/checkout`, `POST /api/quotes`, `POST /api/reviews`, `POST /api/contact`, `POST /api/subscribe`. Everything else — stats, customer list, order list, product writes — is admin-only.
- **`POST /api/orders` is admin-only.** It is the panel form for opening an order by hand, and it lets the caller set `unit_price` for off-catalogue work. The storefront never touches it; it goes to `/api/checkout`, which rebuilds the cart from the catalogue and ignores any price the browser sends. Do not make `/api/orders` public to "fix" a checkout bug — that hands everyone their own price list.
- `requireAdmin` returns JSON `401` for `/api/*` and redirects to `/login` otherwise. `admin.js` turns a `401` into a redirect, so an unprotected-then-protected route change is visible immediately.
- Secrets come from env with dev fallbacks (`ADMIN_USER`, `ADMIN_PASSWORD`, `SESSION_SECRET`, see `.env.example`). Never commit a real secret; never log `ADMIN_PASSWORD` in code that runs in production.

## Uploads

`multer` writes to `uploads/` on disk: images only (`png|jpe?g|webp|gif`), 8 MB cap, filename `${Date.now()}-${slug}${ext}`. Use `upload.single("image")` and read `req.file`; the DB stores the public path `/uploads/<filename>`. Widening the mime filter or the size cap is a security decision — flag it rather than doing it silently.

## Serving new files

Static serving is explicit, not a `express.static(ROOT)`. A new top-level asset must be added to the allowlist:

```js
["styles.css", "script.js", "stl-viewer.js", "admin.css", "admin.js"].forEach(…)
```

A new HTML page needs its own `app.get("/route", (req,res) => res.sendFile(…))`, plus `requireAdmin` if it's an admin page.

## Vercel caveats — the local/deployed divergence

The app runs on Vercel as a serverless function, where the filesystem is ephemeral and mostly read-only:

- **SQLite writes do not persist** across invocations, and `data/*.sqlite` is gitignored — so a deployed instance starts from the seed each cold start. Do not design a feature that assumes durable local disk state without raising this first.
- **Uploaded files do not persist** either (`uploads/*` is gitignored and the FS is ephemeral).
- `better-sqlite3` is a native module; it must stay in `dependencies`, not `devDependencies`.

If the user asks for something that needs real persistence (durable orders, real uploads), say plainly that the current Vercel setup cannot hold it and that it needs an external DB / blob store, instead of shipping something that works locally and silently loses data in production.

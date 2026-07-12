---
name: admin-panel
description: Work on the Printable admin panel — admin.html, admin.js, admin.css, or login.html. Adding a tab, list, form, stat tile, badge, or wiring an admin action to an API. Read before editing any admin file.
---

# Admin panel — Printable

Three files: `admin.html` (static shell), `admin.js` (~260 lines, all behavior), `admin.css` (~465 lines). Vanilla JS, no framework, no bundler. Served from `server.js` behind `requireAdmin`.

## Architecture in one paragraph

A module-level `state = { products, customers, orders }` object holds everything. `refresh()` re-fetches all four endpoints in parallel (`/api/stats`, `/api/products`, `/api/customers`, `/api/orders`) and calls the three `render*()` functions, which overwrite `innerHTML` from template literals. There is no diffing and no partial update: **every mutation ends with `await refresh()`**. Follow that — do not hand-patch a row in the DOM.

## The four patterns to copy

**1. Fetch — always through `api()`, never raw `fetch`.**
```js
await api("/api/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});
```
`api()` handles the three things you'd otherwise forget: a `401` redirects to `/login`, a non-OK response throws with the server's Turkish `error` message, and a `204` returns `null` instead of exploding on `.json()`. Product create/update is the exception — it sends `FormData` (for the image upload) with **no** `Content-Type` header, letting the browser set the multipart boundary.

**2. Render — a `render*()` that rebuilds `innerHTML` and has an empty-state fallback.**
```js
qs("#thing-list").innerHTML = state.things.map((t) => `
  <article class="row"> … </article>
`).join("") || "<p>Henüz kayıt yok.</p>";
```
Also update the `#thing-count` header text. Use the shared `money()` (`24.90 TL`) and the `statusLabels` / `paymentLabels` / `statusClass` maps for anything the API returns as an English enum — the UI is Turkish, the data is not.

**3. Events — delegate from the container, keyed off `data-*`.**
```js
qs("#thing-list").addEventListener("click", async (event) => {
  const id = event.target.dataset.editThing;
  if (!id) return;
  …
  await refresh();
});
```
Because rows are re-created on every `refresh()`, a listener bound to a row is dead after the next render. Bind to the list (or `document`) once, at module scope, and read `event.target.dataset`.

**4. Forms — `preventDefault`, `FormData`, submit, `reset()`, `refresh()`.** The product form doubles as the edit form: a hidden `input[name=id]` decides `POST` vs `PUT /api/products/:id`, and clicking *Düzenle* fills the fields from `state.products` and scrolls the form into view. Keep that shape rather than adding a modal.

## Tabs and what they manage

`dashboard`, `banner` (hero slides: image, per-slide copy, buttons, order, visibility), `categories` (the storefront category grid), `colors` (the palette), `seo` (per-page meta + site-wide JSON-LD settings — see the `seo` skill), `products`, `orders`, `customers`.

- The SEO and colour forms send **JSON**; banner, category and product forms send **`FormData`** (they carry a file upload).
- `renderSeo()` has no list — it just refills the two forms from `state.seo`.
- The product form's colour checkboxes are rendered from `state.colors` by `renderProductColorOptions()` and post as repeated `color_ids` values. Because every `refresh()` re-renders them, the checked state is restored from `state.products`, never read back from the stale DOM — see `currentProductColorIds()`.

## How tabs work

`showTab(name)` toggles `.active` on `.tab` buttons (matched by `data-tab`) and on `.panel` sections (matched by `id`). A new screen = a `<button class="tab" data-tab="foo">` + a `<section class="panel" id="foo">` in `admin.html`. Anything with `data-open-tab` also navigates. No router, no hash.

## Session

`loadSession()` runs on load, hits `/api/session`, redirects to `/login` if not authed, and fills `#session-user`. `#logout-button` POSTs `/api/logout` and redirects. Every admin API call is protected server-side too — the client check is UX, not security. New admin endpoints must be wrapped in `requireAdmin` (see the `api-endpoint` skill).

## Styling & known rough edges

- `admin.css` uses `.row`, `.row-actions`, `.meta-line`, `.badge` (+ `.green` / `.orange` / `.blue`), `.brand-mark`, `.panel`, `.tab`. Reuse them; the admin CSS is not layered like `styles.css`, so a normal edit behaves normally.
- All copy is Turkish. Confirmations currently use native `confirm()` / `prompt()` / `alert()` — matching that is fine; replacing it is a UX decision, so ask first.
- **Template literals interpolate API data directly into `innerHTML`** (product names, customer names, notes). That is an XSS hole for admin-entered content. Do not widen it: for any *new* field, escape it, or say so if the user wants the quick path.

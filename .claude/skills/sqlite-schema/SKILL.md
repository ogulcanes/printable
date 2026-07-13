---
name: sqlite-schema
description: Change the Printable database — add a column or table, change a default, adjust the seed data, or query data/printable.sqlite. Read before touching the db.exec schema block in server.js, because CREATE TABLE IF NOT EXISTS will silently NOT add your new column to an existing database.
---

# SQLite schema — Printable

One `better-sqlite3` database, `data/printable.sqlite`, created and migrated by the `db.exec(\`…\`)` block at the top of `server.js`. It is gitignored, so every developer (and every Vercel cold start) has a different one.

## Current schema

- **products** — `id, name*, sku, category, description, color, price*, sale_price, width, height, depth, weight, stock*, image_path, is_active*, created_at, updated_at`
- **customers** — `id, name*, email, phone, address, city, notes, created_at`
- **orders** — `id, order_number* (unique, "PRN-########"), customer_id* → customers ON DELETE CASCADE, status* ('new'), payment_status* ('pending'), shipping_address, tracking_code, subtotal*, discount*, total*, notes, created_at, updated_at`
- **order_items** — `id, order_id* → orders ON DELETE CASCADE, product_id → products ON DELETE SET NULL, product_name*, quantity*, unit_price*, line_total*`
- **hero_slides** — `id, image_path*, image_alt, title, subtitle, primary_label, primary_href, secondary_label, secondary_href, sort_order*, is_active*, created_at, updated_at` — the storefront banner, managed from the admin "Banner" tab. Seeded with three slides. `image_path` is either an `/uploads/…` path or an external URL.
- **categories** — `id, name*, image_path, image_alt, href, sort_order*, is_active*, created_at, updated_at` — the "Kategorilere Göre Alışveriş" grid, managed from the admin "Kategoriler" tab. Seeded with six. `href` defaults to `#store-products`.
- **colors** — `id, name*, hex* ('#rrggbb', validated and lowercased server-side), sort_order*, is_active*, created_at` — the palette, managed from the admin "Renkler" tab. Seeded with eight.
- **product_colors** — `product_id* → products ON DELETE CASCADE, color_id* → colors ON DELETE CASCADE`, composite PK. Which palette colours a product offers; drives the swatch dots on the storefront product cards. `GET /api/products` joins these in as a `colors: [{id,name,hex}]` array. Deleting a colour removes it from every product (cascade), which is intended.
- **materials** — `id, name*, description, price_per_cm3*, sort_order*, is_active*, created_at` — 3D printing materials (PLA/PETG/ABS/Reçine), admin "Malzeme & Fiyat" tab. PLA's 8.50 TL/cm³ is the rate the old hardcoded formula used.
- **pricing_settings** — single row (`id = 1`): `setup_fee, size_fee_per_cm, min_order_total, shell_share, updated_at`. Note `min_order_total` is a floor on the **order total**, not the unit price — putting it on the unit price makes every material cost the same, which is a bug that was already caught once.
- **quotes** — `id, quote_number* (unique, "TKF-########"), customer_name*, email, phone, note, file_name, file_path, width, height, depth, volume_cm3*, material_id → materials ON DELETE SET NULL, material_name, color_id → colors ON DELETE SET NULL, color_name, infill*, quantity*, unit_price*, total*, status*, created_at` — submitted 3D print quotes with the uploaded STL. `material_name`/`color_name` are denormalised on purpose so a deleted material does not erase what the customer actually asked for.
- **quote_parts** — `id, quote_id* → quotes ON DELETE CASCADE, part_index*, volume_cm3*, color_id → colors ON DELETE SET NULL, color_name, color_hex` — one row per disconnected part of the uploaded STL, with the colour the customer picked for it. `color_name`/`color_hex` are denormalised so a deleted palette colour does not erase what was ordered. `quotes.color_name` still holds the first part's colour as a summary.
- **seo_pages** — `id, slug* (unique: 'home', 'stl-teklif'), label*, title, description, canonical, og_title, og_description, og_image, robots*, updated_at` — per-page meta, injected server-side. See the `seo` skill.
- **site_settings** — single row (`id = 1`, enforced by a CHECK): `site_name, site_url, description, logo_path, social_links, updated_at` — feeds the JSON-LD Organization/WebSite block.

`products` also carries `image_alt`, `meta_title`, `meta_description` (added by migration, not in the original CREATE TABLE).

(`*` = NOT NULL. `foreign_keys = ON` is set via pragma.) `status` values: `new, preparing, printed, shipped, delivered, cancelled` — the labels live in `admin.js` (`statusLabels`). `payment_status`: `pending, paid, failed, refunded`.

## The trap: adding a column does not apply to an existing DB

The schema block is `CREATE TABLE IF NOT EXISTS`. On any machine that has already run the app, the tables exist, so **editing the CREATE TABLE body is a no-op** — the new column never appears, and queries fail at runtime with `no such column`. Fresh clones work, your machine doesn't, and it looks like a caching bug.

Add the column to the `CREATE TABLE` (so fresh installs get it) **and** add an idempotent migration right after the `db.exec` block:

```js
const hasColumn = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

if (!hasColumn("products", "material")) {
  db.exec("ALTER TABLE products ADD COLUMN material TEXT");
}
```

Both, always. SQLite's `ALTER TABLE ADD COLUMN` cannot add a `NOT NULL` column without a default — give it a default or make it nullable.

## Seeding

The seed only runs when `products` is empty (`SELECT COUNT(*) … if (!existingProducts)`). It inserts three demo products with remote Shopify image URLs. Changing the seed will **not** change an existing DB — delete `data/printable.sqlite` and restart to re-seed, and tell the user that's what you did if you do it (it destroys their local orders and customers, so ask first).

## Inspecting

```bash
node -e "const d=require('better-sqlite3')('data/printable.sqlite');console.table(d.prepare('SELECT id,name,price,stock FROM products').all())"
node -e "const d=require('better-sqlite3')('data/printable.sqlite');console.log(d.prepare('PRAGMA table_info(orders)').all())"
```

## Writing queries

Prepared statements only, named params for writes, positional for lookups, `db.transaction()` for anything multi-statement (`POST /api/orders` is the reference). No ORM, no query builder. Money is `REAL` and rendered by a shared `money()` helper as `24.90 TL`.

## Persistence reality check

On Vercel the filesystem is ephemeral: writes to the SQLite file do not survive between invocations. Any feature that assumes durable storage (real orders, real uploads) needs an external database — raise that before building it, don't ship something that only works on localhost. See the `api-endpoint` skill.

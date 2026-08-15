---
name: sqlite-schema
description: Change the Printable database — add a column or table, change a default, adjust the seed data, or query it. Read before touching the schema block in server.js, because CREATE TABLE IF NOT EXISTS will silently NOT add your new column to an existing database, and initDb() skips the whole setup unless SCHEMA_VERSION is bumped.
---

# Database schema — Printable

**This is PostgreSQL, not SQLite** — the name is historical. `db.js` keeps the `better-sqlite3` call shape (`prepare().get/all/run`) but every call is `await`ed and the dialect is Postgres. Production is Supabase via `DATABASE_URL`; with that variable empty you get PGlite, an embedded Postgres in `data/pgdata`.

**`.env` points at the LIVE Supabase database.** Running the app locally reads and writes production. To test anything that writes, start an isolated server instead:

```bash
DATABASE_URL= PGLITE_DATA_DIR=/tmp/testdb PORT=3100 node server.js
```

The schema, migrations and seeds all live in `initDb()` at the top of `server.js`.

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
- **admin_users** — `id, username* (unique, lowercase, [a-z0-9_-] only), password_hash*, password_version*, created_at, updated_at` — panel hesapları. Şifreler scrypt ile saltlanır (`scrypt$salt$hash`); düz metin hiçbir yerde tutulmaz. `password_version` her şifre değişiminde artar ve oturum çerezinde taşınır, böylece şifre değişince o hesabın açık oturumları düşer. **Kullanıcı adı nokta içeremez** — çerez `kullanıcı.sürüm.bitiş.imza` biçiminde parçalanıyor. Tablo boşsa `ADMIN_USERS` isimleri `ADMIN_PASSWORD` ile tohumlanır.
- **seo_pages** — `id, slug* (unique: 'home', 'stl-teklif'), label*, title, description, canonical, og_title, og_description, og_image, robots*, updated_at` — per-page meta, injected server-side. See the `seo` skill.
- **site_settings** — single row (`id = 1`, enforced by a CHECK): `site_name, site_url, description, logo_path, social_links, updated_at` — feeds the JSON-LD Organization/WebSite block.

`products` also carries `image_alt`, `meta_title`, `meta_description` (added by migration, not in the original CREATE TABLE).

(`*` = NOT NULL. `foreign_keys = ON` is set via pragma.) `status` values: `new, preparing, printed, shipped, delivered, cancelled` — the labels live in `admin.js` (`statusLabels`). `payment_status`: `pending, paid, failed, refunded`.

## Trap 1: `initDb()` exits early unless you bump `SCHEMA_VERSION`

```js
const current = await db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
if (current?.value === SCHEMA_VERSION) return;      // <- everything below is skipped
```

Serverless pays for this block on every cold start, so it is skipped once the stored version matches. **Any change to the schema, the migration list or the seed data is invisible to an existing database until you increment `SCHEMA_VERSION`** (a bare string near the top of `server.js`). The last line of `initDb()` writes the new value back.

This bites hardest on seeds that look idempotent. A new `seo_pages` row added to `extraSeoPages` with `ON CONFLICT DO NOTHING` still never lands: the loop does not run at all. The page then serves the fallback title and it looks like a caching bug.

## Trap 2: adding a column does not apply to an existing DB

`CREATE TABLE IF NOT EXISTS` means editing the CREATE TABLE body is a no-op wherever the table already exists. Add the column there (so fresh installs get it) **and** ship an idempotent migration — the file already keeps a list of them:

```js
const eklenecekSutunlar = [
  ["site_settings", "show_stock", "INTEGER NOT NULL DEFAULT 1"],
  // …
];
```

Then bump `SCHEMA_VERSION`. Both, always.

## Seeding

Table seeds only run when the table is empty (`SELECT COUNT(*) … if (!existing…)`), so editing them never changes a populated database. For rows that must reach live databases, use the idempotent pattern next to `extraSeoPages`: `INSERT … ON CONFLICT DO NOTHING`, plus a `SCHEMA_VERSION` bump.

`ON CONFLICT DO NOTHING` inserts but never updates. To change a value on an existing row, either do a one-off `UPDATE` (not a migration — a migration re-runs on every version bump and would overwrite whatever the admin typed) or guard it: `SET x = @x WHERE COALESCE(NULLIF(TRIM(x), ''), '') = ''` fills only blanks.

## Inspecting

Everything is async, and this hits **production** unless you clear `DATABASE_URL`:

```bash
node -e "require('dotenv').config({quiet:true});const d=require('./db.js');
(async()=>{console.table(await d.prepare('SELECT id,name,price,stock FROM products').all());process.exit(0)})()"
```

Column list (Postgres, not `PRAGMA`):

```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders';
```

## Writing queries

Prepared statements only, named params for writes, positional for lookups, `db.transaction()` for anything multi-statement (`POST /api/orders` is the reference). No ORM, no query builder. Money is a float column and rendered by a shared `money()` helper as `24.90 TL`.

## Persistence reality check

Storage is Supabase, so data does survive between invocations — the old warning about an ephemeral SQLite file no longer applies. What still bites: `initDb()` runs on every cold start, so keep it cheap, and remember that a local run without `PGLITE_DATA_DIR` is talking to the live database.

/* SQLite → Postgres veri taşıma.
 *
 * Eski data/printable.sqlite dosyasındaki içeriği (ürünler, siparişler, kategoriler,
 * banner, site ayarları, teklifler…) db.js'in gösterdiği Postgres'e kopyalar.
 *
 *   node migrate-sqlite-to-postgres.js            → yerel PGlite'a
 *   DATABASE_URL=... node migrate-sqlite-to-postgres.js   → Supabase'e
 *
 * Hedef tablolar önce boşaltılır, sonra kayıtlar ID'leriyle birlikte yazılır ve
 * kimlik sayaçları ileri sarılır. Betik yeniden çalıştırılabilir.
 */
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const { createClient } = require("@libsql/client");
const db = require("./db.js");

const SQLITE_PATH = path.join(__dirname, "data", "printable.sqlite");

// Foreign key sırası: referans verilen tablo önce gelmeli.
const TABLES = [
  "products", "customers", "colors", "categories", "materials",
  "pricing_settings", "site_settings", "seo_pages", "hero_slides",
  "orders", "order_items",
  "product_colors", "product_categories", "price_history",
  "quotes", "quote_parts",
  "campaigns", "campaign_products", "campaign_categories",
  "reviews", "messages"
];

// id sütunu olan tablolarda kimlik sayacı, en büyük id'nin ötesine alınmalı;
// yoksa ilk yeni kayıt "duplicate key" hatası verir.
const NO_ID_TABLES = new Set([
  "product_colors", "product_categories", "campaign_products", "campaign_categories"
]);

const columnsOf = async (table) => (await db.prepare(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = ?
`).all(table)).map((r) => r.column_name);

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`Kaynak bulunamadı: ${SQLITE_PATH}`);
    process.exit(1);
  }

  const source = createClient({ url: `file:${SQLITE_PATH.replace(/\\/g, "/")}` });
  const target = process.env.DATABASE_URL ? "Supabase" : "yerel PGlite";
  console.log(`Kaynak : ${SQLITE_PATH}`);
  console.log(`Hedef  : ${target}\n`);

  await db.ready();

  // Ters sırada boşalt (bağımlı tablolar önce).
  for (const table of [...TABLES].reverse()) {
    try { await db.prepare(`DELETE FROM ${table}`).run(); } catch { /* tablo yoksa geç */ }
  }

  let total = 0;
  for (const table of TABLES) {
    let rows = [];
    try {
      rows = (await source.execute(`SELECT * FROM ${table}`)).rows;
    } catch {
      console.log(`  ${table.padEnd(20)} kaynakta yok, atlandı`);
      continue;
    }
    if (!rows.length) { console.log(`  ${table.padEnd(20)} 0`); continue; }

    // Yalnızca iki tarafta da bulunan sütunlar taşınır: şema zamanla değişmiş olabilir.
    const targetCols = await columnsOf(table);
    const cols = Object.keys(rows[0]).filter((c) => targetCols.includes(c));
    if (!cols.length) { console.log(`  ${table.padEnd(20)} ortak sütun yok, atlandı`); continue; }

    const placeholders = cols.map(() => "?").join(", ");
    const insert = db.prepare(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
    );

    // Kimlik sütununa açıkça değer yazabilmek için OVERRIDING SYSTEM VALUE gerekir.
    const insertWithId = db.prepare(
      `INSERT INTO ${table} (${cols.join(", ")}) OVERRIDING SYSTEM VALUE VALUES (${placeholders}) ON CONFLICT DO NOTHING`
    );
    const stmt = cols.includes("id") ? insertWithId : insert;

    for (const row of rows) {
      // Yayarak geçilmeli: tek dizi argümanı adaptörde "isimli parametre" sanılır.
      await stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
    }
    console.log(`  ${table.padEnd(20)} ${rows.length}`);
    total += rows.length;

    // Sayaçları ileri sar.
    if (cols.includes("id") && !NO_ID_TABLES.has(table)) {
      await db.prepare(`
        SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))
      `).get(table).catch(() => {});
    }
  }

  console.log(`\nToplam ${total} kayıt taşındı.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Taşıma başarısız:", error.message);
  process.exit(1);
});

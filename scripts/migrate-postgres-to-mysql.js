#!/usr/bin/env node
"use strict";

require("dotenv").config();
const pg = require("pg");
const mysql = require("mysql2/promise");
const { mysqlConfigured, mysqlConfig } = require("../mysql-config");

const APPLY = process.argv.includes("--apply");
const SOURCE_URL = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || "";

// Ebeveynler çocuklardan önce kopyalanır; temizleme bunun tersidir.
const TABLES = [
  "app_meta", "products", "customers", "customer_accounts", "customer_password_resets",
  "orders", "materials", "pricing_settings", "pricing_tiers", "colors", "categories",
  "quotes", "quote_parts", "product_colors", "product_categories", "price_history",
  "messages", "seo_pages", "blog_posts", "site_settings", "hero_slides", "campaigns",
  "katlac_items", "product_cost_scales", "product_images", "campaign_uses",
  "campaign_products", "campaign_categories", "admin_users", "subscribers", "reviews",
  "customer_showcases", "order_items"
];

const pgId = (name) => `"${String(name).replace(/"/g, '""')}"`;
const mysqlId = (name) => `\`${String(name).replace(/`/g, "``")}\``;

async function columnsByTable(source, target) {
  const sourceResult = await source.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const [targetRows] = await target.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
    ORDER BY table_name, ordinal_position
  `);

  const group = (rows) => rows.reduce((map, row) => {
    const table = row.table_name || row.TABLE_NAME;
    const column = row.column_name || row.COLUMN_NAME;
    if (!map.has(table)) map.set(table, []);
    map.get(table).push(column);
    return map;
  }, new Map());
  return { sourceColumns: group(sourceResult.rows), targetColumns: group(targetRows) };
}

async function counts(connection, kind) {
  const result = {};
  for (const table of TABLES) {
    const sql = kind === "pg"
      ? `SELECT COUNT(*)::int AS count FROM ${pgId(table)}`
      : `SELECT COUNT(*) AS count FROM ${mysqlId(table)}`;
    const response = kind === "pg" ? await connection.query(sql) : await connection.query(sql);
    const rows = kind === "pg" ? response.rows : response[0];
    result[table] = Number(rows[0].count);
  }
  return result;
}

async function insertRows(target, table, columns, rows) {
  const batchSize = 200;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    const values = batch.flatMap((row) => columns.map((column) => row[column] === undefined ? null : row[column]));
    await target.query(
      `INSERT INTO ${mysqlId(table)} (${columns.map(mysqlId).join(",")}) VALUES ${placeholders}`,
      values
    );
  }
}

async function main() {
  if (!SOURCE_URL) throw new Error("SOURCE_DATABASE_URL (veya DATABASE_URL) tanımlı değil.");
  if (!mysqlConfigured()) throw new Error("MySQL bağlantı değişkenleri tanımlı değil.");

  const source = new pg.Client({
    connectionString: SOURCE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000
  });
  const target = await mysql.createConnection(mysqlConfig());

  try {
    await source.connect();
    const { sourceColumns, targetColumns } = await columnsByTable(source, target);
    const missing = TABLES.filter((table) => !sourceColumns.has(table) || !targetColumns.has(table));
    if (missing.length) throw new Error(`Kaynak veya hedefte eksik tablo var: ${missing.join(", ")}`);

    const sourceCounts = await counts(source, "pg");
    const targetCounts = await counts(target, "mysql");
    const total = Object.values(sourceCounts).reduce((sum, count) => sum + count, 0);
    console.log(`Kaynak hazır: ${TABLES.length} tablo, ${total} satır.`);
    console.log(`Hedef hazır: ${Object.values(targetCounts).reduce((sum, count) => sum + count, 0)} mevcut satır.`);

    if (!APPLY) {
      console.log("Kontrol tamamlandı; hiçbir veri değiştirilmedi. Aktarım için --apply kullanın.");
      return;
    }

    await target.beginTransaction();
    await target.query("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const table of [...TABLES].reverse()) await target.query(`DELETE FROM ${mysqlId(table)}`);

      for (const table of TABLES) {
        const targetSet = new Set(targetColumns.get(table));
        const columns = sourceColumns.get(table).filter((column) => targetSet.has(column));
        const sourceOnly = sourceColumns.get(table).filter((column) => !targetSet.has(column));
        if (sourceOnly.length) throw new Error(`${table}: hedefte eksik sütunlar: ${sourceOnly.join(", ")}`);

        const result = await source.query(
          `SELECT ${columns.map(pgId).join(",")} FROM ${pgId(table)}`
        );
        await insertRows(target, table, columns, result.rows);
        console.log(`${table}: ${result.rowCount} satır aktarıldı.`);
      }

      const copiedCounts = await counts(target, "mysql");
      const mismatches = TABLES.filter((table) => copiedCounts[table] !== sourceCounts[table]);
      if (mismatches.length) throw new Error(`Satır sayısı uyuşmayan tablolar: ${mismatches.join(", ")}`);

      await target.commit();
      console.log("Veritabanı aktarımı tamamlandı ve satır sayıları doğrulandı.");
    } catch (error) {
      await target.rollback();
      throw error;
    } finally {
      await target.query("SET FOREIGN_KEY_CHECKS = 1");
    }
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Aktarım başarısız: ${error.message}`);
  process.exitCode = 1;
});

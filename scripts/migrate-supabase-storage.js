#!/usr/bin/env node
"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const mysql = require("mysql2/promise");
const { mysqlConfigured, mysqlConfig } = require("../mysql-config");

const APPLY = process.argv.includes("--apply");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_UPLOAD_DIR || path.join(__dirname, "..", "uploads"));
const PRIVATE_DIR = path.resolve(process.env.PRIVATE_UPLOAD_DIR || path.join(__dirname, "..", "private_uploads"));
const PRIVATE_PREFIX = "local-private:";

const safePublicPath = (key) => {
  const normalized = path.posix.normalize(String(key || "")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Güvensiz Storage yolu: ${key}`);
  }
  return normalized;
};

// Sunucu özel dosya referansları tek dosya adıdır. Storage'daki olası klasörleri
// kayıpsız biçimde düzleştiriyoruz; aynı hedefe çakışırsa aktarım durur.
const privateFilename = (key) => safePublicPath(key).replace(/[\\/]+/g, "--");

async function listAll(client, bucket, prefix = "") {
  const objects = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit: 1000, offset, sortBy: { column: "name", order: "asc" }
    });
    if (error) throw new Error(`${bucket} listelenemedi: ${error.message}`);
    if (!data?.length) break;

    for (const item of data) {
      const key = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id || item.metadata) objects.push({ key, size: Number(item.metadata?.size || 0) });
      else objects.push(...await listAll(client, bucket, key));
    }
    if (data.length < 1000) break;
  }
  return objects;
}

async function downloadOne(client, bucket, object, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const existing = await fs.promises.stat(destination).catch(() => null);
  if (existing) {
    if (!object.size || existing.size === object.size) return;
    throw new Error(`Hedefte farklı boyutta dosya var: ${destination}`);
  }

  const { data, error } = await client.storage.from(bucket).download(object.key);
  if (error) throw new Error(`${bucket}/${object.key} indirilemedi: ${error.message}`);
  const buffer = Buffer.from(await data.arrayBuffer());
  await fs.promises.writeFile(destination, buffer, { flag: "wx" });
}

async function rewriteDatabase(imageObjects, modelObjects) {
  if (!mysqlConfigured()) throw new Error("Dosya yollarını çevirmek için MySQL bağlantısı tanımlı değil.");
  const db = await mysql.createConnection(mysqlConfig());
  const q = (name) => `\`${String(name).replace(/`/g, "``")}\``;
  const publicPrefix = `${SUPABASE_URL}/storage/v1/object/public/images/`;

  try {
    await db.beginTransaction();

    // Görsel URL'leri farklı içerik tablolarında bulunabildiği için yalnızca
    // metin sütunlarında, tam Supabase public önekini /uploads/ ile değiştirir.
    const [textColumns] = await db.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND data_type IN ('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext')
    `);
    for (const row of textColumns) {
      const table = row.table_name || row.TABLE_NAME;
      const column = row.column_name || row.COLUMN_NAME;
      await db.query(
        `UPDATE ${q(table)} SET ${q(column)} = REPLACE(${q(column)}, ?, '/uploads/') WHERE ${q(column)} LIKE ?`,
        [publicPrefix, `%${publicPrefix}%`]
      );
    }

    const seen = new Set();
    for (const object of modelObjects) {
      const filename = privateFilename(object.key);
      if (seen.has(filename)) throw new Error(`Özel dosya adı çakışması: ${filename}`);
      seen.add(filename);
      const local = `${PRIVATE_PREFIX}${filename}`;
      await db.query("UPDATE quotes SET file_path = ? WHERE file_path = ?", [local, object.key]);
      await db.query("UPDATE quote_parts SET file_path = ? WHERE file_path = ?", [local, object.key]);
      await db.query("UPDATE katlac_items SET model_key = ? WHERE model_key = ?", [local, object.key]);
      await db.query(
        "UPDATE messages SET message = REPLACE(message, ?, ?) WHERE message LIKE ?",
        [`[[design-image:${object.key}]]`, `[[design-image:${local}]]`, `%[[design-image:${object.key}]]%`]
      );
    }

    await db.commit();
    console.log(`${imageObjects.length} görsel ve ${modelObjects.length} özel dosyanın veritabanı yolları güncellendi.`);
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı değil.");
  const client = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const [images, models] = await Promise.all([
    listAll(client, "images"),
    listAll(client, "models")
  ]);
  const totalBytes = [...images, ...models].reduce((sum, item) => sum + item.size, 0);
  console.log(`Storage hazır: ${images.length} açık görsel, ${models.length} özel dosya, ${(totalBytes / 1024 / 1024).toFixed(2)} MB.`);

  if (!APPLY) {
    console.log("Kontrol tamamlandı; dosya indirilmedi ve veritabanı değiştirilmedi. Aktarım için --apply kullanın.");
    return;
  }

  await fs.promises.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.promises.mkdir(PRIVATE_DIR, { recursive: true });
  for (const object of images) {
    await downloadOne(client, "images", object, path.join(PUBLIC_DIR, safePublicPath(object.key)));
  }
  for (const object of models) {
    await downloadOne(client, "models", object, path.join(PRIVATE_DIR, privateFilename(object.key)));
  }
  await rewriteDatabase(images, models);
  console.log("Supabase Storage aktarımı tamamlandı.");
}

main().catch((error) => {
  console.error(`Storage aktarımı başarısız: ${error.message}`);
  process.exitCode = 1;
});

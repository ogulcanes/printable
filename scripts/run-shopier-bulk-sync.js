require("dotenv").config();

const crypto = require("node:crypto");
const db = require("../db.js");

const GRANT_KEY = "shopier_bulk_sync_grant";
const ENDPOINT = "https://www.printable.com.tr/api/internal/shopier-bulk-sync";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncOne(token, product) {
  let lastError = "Bilinmeyen hata";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, product_id: product.id })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (body.shopier_sync_status === "synced" && body.shopier_product_id) return body;
      lastError = body.shopier_sync_error || `Durum: ${body.shopier_sync_status}`;
    } catch (error) {
      lastError = error.message;
    }
    if (attempt < 3) await sleep(attempt * 1500);
  }
  throw new Error(lastError);
}

async function main() {
  const token = crypto.randomBytes(36).toString("base64url");
  const value = JSON.stringify({
    digest: crypto.createHash("sha256").update(token).digest("hex"),
    expires_at: Date.now() + 30 * 60 * 1000
  });
  await db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `).run(GRANT_KEY, value);

  const products = await db.prepare("SELECT id, name FROM products ORDER BY id ASC").all();
  const results = [];
  const failures = [];
  console.log(`Shopier aktarımı başladı: ${products.length} ürün.`);

  try {
    for (const [index, product] of products.entries()) {
      try {
        const result = await syncOne(token, product);
        results.push(result);
        console.log(`[${index + 1}/${products.length}] OK  #${product.id} ${product.name}`);
      } catch (error) {
        failures.push({ id: product.id, name: product.name, error: error.message });
        console.error(`[${index + 1}/${products.length}] HATA #${product.id} ${product.name}: ${error.message}`);
      }
      await sleep(350);
    }
  } finally {
    await db.prepare("DELETE FROM app_meta WHERE key = ?").run(GRANT_KEY);
  }

  console.log(`Tamamlandı: ${results.length} başarılı, ${failures.length} hatalı.`);
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(`Toplu Shopier aktarımı başlatılamadı: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());

const fs = require("fs");
const os = require("os");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const previewRoot = path.join(os.tmpdir(), "printable-custom-products-preview");
const previewDatabase = path.join(previewRoot, "pgdata");
const port = Number(process.env.PREVIEW_PORT || 3100);

fs.mkdirSync(previewDatabase, { recursive: true });

// server.js loads .env from the current directory. Moving to an isolated folder
// prevents the preview process from ever reading the live Supabase credentials.
process.chdir(previewRoot);

Object.assign(process.env, {
  DATABASE_URL: "",
  PGLITE_DATA_DIR: previewDatabase,
  PORT: String(port),
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  PAYTR_MERCHANT_ID: "",
  PAYTR_MERCHANT_KEY: "",
  PAYTR_MERCHANT_SALT: "",
  SESSION_SECRET: "printable-local-preview-only",
  ADMIN_USER: "preview",
  ADMIN_USERS: "preview",
  ADMIN_PASSWORD: "preview1234",
});

const app = require(path.join(projectRoot, "server.js"));
const db = require(path.join(projectRoot, "db.js"));

const waitForApplication = async (baseUrl) => {
  let lastError;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/products`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError || new Error("Önizleme sunucusu hazırlanamadı.");
};

const start = async () => {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });

  const baseUrl = `http://localhost:${port}`;

  try {
    await waitForApplication(baseUrl);

    // These products remain inactive in production. They are enabled only in
    // this isolated PGlite preview database; prices and stock mode come from
    // the real product definitions so the preview matches the future release.
    await db.prepare(`
      UPDATE products
      SET
        is_active = 1,
        updated_at = NOW()
      WHERE sku IN ('PR-CUSTOM-001', 'PR-CUSTOM-002', 'PR-CUSTOM-003')
    `).run();

    console.log("");
    console.log("Kişiye özel ürün önizlemesi hazır:");
    console.log(`  Ürün listesi:       ${baseUrl}/urunler`);
    console.log(`  İsme özel anahtarlık: ${baseUrl}/urun/900001`);
    console.log(`  Araba modeli:         ${baseUrl}/urun/900002`);
    console.log(`  Fotoğraftan 3B baskı: ${baseUrl}/urun/900003`);
    console.log(`  Yönetim paneli:       ${baseUrl}/admin`);
    console.log("  Yönetim girişi:       preview / preview1234");
    console.log("");
    console.log("Durdurmak için bu terminalde Ctrl+C tuşlarına basın.");

    const shutdown = () => {
      server.close(async () => {
        if (typeof db.close === "function") await db.close();
        process.exit(0);
      });
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    server.close();
    throw error;
  }
};

start().catch((error) => {
  console.error("Önizleme başlatılamadı:", error);
  process.exit(1);
});

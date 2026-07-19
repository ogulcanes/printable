require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const db = require("./db.js");
const storage = require("./storage.js");

const app = express();

/* Express 4, async bir route handler reddedildiğinde isteği yanıtsız bırakır:
   istemci hata almaz, sonsuza kadar bekler. Route'ların tamamı async olduğu için
   tek bir beklenmedik hata sayfayı süresiz askıda bırakabiliyordu. Her handler'ı
   sarmalayıp reddi hata middleware'ine yönlendiriyoruz.
   (fn.length >= 4 → zaten hata middleware'i, dokunma.) */
["get", "post", "put", "patch", "delete"].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => original(path, ...handlers.map((fn) =>
    (typeof fn !== "function" || fn.length >= 4)
      ? fn
      : (req, res, next) => {
        try { return Promise.resolve(fn(req, res, next)).catch(next); }
        catch (error) { return next(error); }
      }
  ));
});

/* Vercel/CDN arkasında istek fonksiyona http olarak ulaşır; req.protocol da
   "http" der. Bu, canonical ve og:url'in http:// olarak yayınlanmasına yol
   açıyordu — arama motorları http ve https'i ayrı adres sayar. Proxy
   başlıklarına güvenerek doğru protokolü okuyoruz. */
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
// Vercel'de proje klasörü salt-okunurdur; yazılabilen tek yer /tmp. Yalnızca
// geçici dosyalar için kullanılır — kalıcı veri Turso'da, görseller Blob'da.
const WRITABLE_ROOT = process.env.VERCEL ? "/tmp" : ROOT;
const DATA_DIR = path.join(WRITABLE_ROOT, "data");
const UPLOAD_DIR = path.join(WRITABLE_ROOT, "uploads");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "printable-admin";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-printable-session-secret";
const SESSION_COOKIE = "printable_admin";
const KDV_RATE = 20; // Ürün fiyatları KDV dahildir; faturada bu oranla ayrıştırılır.

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Şema, migration ve seed artık asenkron. Modül yüklenirken bir kez başlar;
   `dbReady` sözü tutulana kadar hiçbir istek veritabanına dokunamaz (aşağıdaki
   hazırlık kapısına bakın). Vercel'de her soğuk başlatmada tekrar çalışır ama
   hepsi IF NOT EXISTS / boşsa-ekle olduğu için ikinci kez zararsızdır. */
/* Şema sürümü. Şemayı, migration listesini veya seed'i değiştirdiğinizde bunu
   artırın; bir sonraki açılışta kurulum yeniden çalışır. */
const SCHEMA_VERSION = "2";

async function initDb() {
  /* Sunucusuz ortamda bu fonksiyon HER soğuk başlatmada çalışır. Tüm şemayı,
     migration'ları ve seed kontrollerini her seferinde yapmak uzak bir
     veritabanında onlarca gidiş-dönüş demek — istekler zaman aşımına uğruyordu.
     Kurulum güncelse iki sorguda çıkıyoruz. */
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const current = await db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
  if (current?.value === SCHEMA_VERSION) return;

  await db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    sku TEXT,
    category TEXT,
    description TEXT,
    color TEXT,
    price REAL NOT NULL DEFAULT 0,
    sale_price REAL,
    width REAL,
    height REAL,
    depth REAL,
    weight REAL,
    stock INTEGER NOT NULL DEFAULT 0,
    image_path TEXT,
    meta_keywords TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address TEXT,
    city TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_number TEXT NOT NULL UNIQUE,
    customer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    shipping_address TEXT,
    tracking_code TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    notes TEXT,
    invoice_type TEXT,
    tc_no TEXT,
    tax_office TEXT,
    tax_number TEXT,
    company_name TEXT,
    billing_address TEXT,
    payment_method TEXT,
    tax_rate REAL NOT NULL DEFAULT 20,
    tax_amount REAL NOT NULL DEFAULT 0,
    shipping_method TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price_per_cm3 REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS pricing_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    setup_fee REAL NOT NULL DEFAULT 120,
    size_fee_per_cm REAL NOT NULL DEFAULT 2.5,
    min_order_total REAL NOT NULL DEFAULT 150,
    shell_share REAL NOT NULL DEFAULT 0.15,
    color_change_fee REAL NOT NULL DEFAULT 35,
    tax_rate REAL NOT NULL DEFAULT 20,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- colors ve categories yukarıda: Postgres, foreign key verilen tablonun
  -- ÖNCE tanımlanmış olmasını ister (SQLite ileriye referansa izin veriyordu).
  CREATE TABLE IF NOT EXISTS colors (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    hex TEXT NOT NULL DEFAULT '#000000',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    image_path TEXT,
    image_alt TEXT,
    href TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quote_number TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    note TEXT,
    file_name TEXT,
    file_path TEXT,
    width REAL,
    height REAL,
    depth REAL,
    volume_cm3 REAL NOT NULL DEFAULT 0,
    material_id INTEGER,
    material_name TEXT,
    color_id INTEGER,
    color_name TEXT,
    infill INTEGER NOT NULL DEFAULT 15,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE SET NULL,
    FOREIGN KEY(color_id) REFERENCES colors(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS quote_parts (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quote_id INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    volume_cm3 REAL NOT NULL DEFAULT 0,
    color_id INTEGER,
    color_name TEXT,
    color_hex TEXT,
    FOREIGN KEY(quote_id) REFERENCES quotes(id) ON DELETE CASCADE,
    FOREIGN KEY(color_id) REFERENCES colors(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS product_colors (
    product_id INTEGER NOT NULL,
    color_id INTEGER NOT NULL,
    PRIMARY KEY (product_id, color_id),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(color_id) REFERENCES colors(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS product_categories (
    product_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    PRIMARY KEY (product_id, category_id),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id INTEGER NOT NULL,
    price REAL NOT NULL,
    sale_price REAL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    subject TEXT,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS seo_pages (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    title TEXT,
    description TEXT,
    canonical TEXT,
    og_title TEXT,
    og_description TEXT,
    og_image TEXT,
    robots TEXT NOT NULL DEFAULT 'index,follow',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    site_name TEXT,
    site_url TEXT,
    description TEXT,
    logo_path TEXT,
    social_links TEXT,
    default_og_image TEXT,
    phone TEXT,
    email TEXT,
    whatsapp TEXT,
    contact_address TEXT,
    working_hours TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS hero_slides (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    image_path TEXT NOT NULL,
    title TEXT,
    subtitle TEXT,
    primary_label TEXT,
    primary_href TEXT,
    secondary_label TEXT,
    secondary_href TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Kampanyalar. Tek tablo üç senaryoyu da karşılar:
  --   1) Kupon kodu      : code dolu, müşteri ödeme sayfasında girer
  --   2) Otomatik indirim: code NULL, sepet koşulu tutunca kendiliğinden uygulanır
  --                        ("3 adet alana %15", "500 TL üzeri 50 TL indirim")
  --   3) Hediye ürün     : kind='gift', koşul tutunca sepete 0 TL'lik satır eklenir
  --                        ("5 adet X alana Y hediye")
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE,
    kind TEXT NOT NULL DEFAULT 'discount',
    discount_type TEXT NOT NULL DEFAULT 'percent',
    discount_value REAL NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'all',
    min_quantity INTEGER NOT NULL DEFAULT 0,
    min_order_total REAL NOT NULL DEFAULT 0,
    gift_product_id INTEGER,
    gift_quantity INTEGER NOT NULL DEFAULT 1,
    starts_at TEXT,
    ends_at TEXT,
    usage_limit INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(gift_product_id) REFERENCES products(id) ON DELETE SET NULL
  );

  -- scope='products' / 'categories' iken kampanyanın hangi ürünleri kapsadığı.
  CREATE TABLE IF NOT EXISTS campaign_products (
    campaign_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, product_id),
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS campaign_categories (
    campaign_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, category_id),
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  -- Bülten aboneleri. Form daha önce hiçbir yere kaydetmiyordu.
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Müşteri değerlendirmeleri. Herkese açık gönderim, admin onayından sonra yayında.
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    is_approved INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id INTEGER NOT NULL,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
  );
`);

/* CREATE TABLE IF NOT EXISTS never adds a column to a database that already
   exists, so every new column needs an explicit, idempotent migration as well.
   (SQLite'ta PRAGMA table_info idi; Postgres'te karşılığı information_schema.)

   Tüm kolonlar TEK sorguda çekilip bellekte kontrol ediliyor. Ayrı ayrı
   sorulunca her migration bir gidiş-dönüş demekti; uzak bir veritabanında
   (Supabase) bu tek başına soğuk başlatmaya saniyeler ekliyordu. */
const existingColumns = new Set(
  (await db.prepare(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
  `).all()).map((r) => `${r.table_name}.${r.column_name}`)
);
const hasColumn = async (table, column) => existingColumns.has(`${table}.${column}`);

for (const [table, column, type] of [
  ["products", "meta_title", "TEXT"],
  ["products", "meta_description", "TEXT"],
  ["products", "meta_keywords", "TEXT"],
  ["products", "image_alt", "TEXT"],
  ["hero_slides", "image_alt", "TEXT"],
  ["site_settings", "default_og_image", "TEXT"],
  // e-fatura + ödeme bilgileri sipariş üzerinde tutulur (fatura anlık görüntüsü).
  ["orders", "invoice_type", "TEXT"],
  ["orders", "tc_no", "TEXT"],
  ["orders", "tax_office", "TEXT"],
  ["orders", "tax_number", "TEXT"],
  ["orders", "company_name", "TEXT"],
  ["orders", "billing_address", "TEXT"],
  ["orders", "payment_method", "TEXT"],
  // KDV dökümü + kargo yöntemi (kargo alıcı ödemeli).
  ["orders", "tax_rate", "REAL NOT NULL DEFAULT 20"],
  ["orders", "tax_amount", "REAL NOT NULL DEFAULT 0"],
  ["orders", "shipping_method", "TEXT"],
  // Admin-editable KDV oranı + iletişim bilgileri.
  ["pricing_settings", "tax_rate", "REAL NOT NULL DEFAULT 20"],
  ["site_settings", "phone", "TEXT"],
  ["site_settings", "email", "TEXT"],
  ["site_settings", "contact_address", "TEXT"],
  ["site_settings", "working_hours", "TEXT"],
  // Ayrı WhatsApp hattı; boşsa telefon numarası kullanılır.
  ["site_settings", "whatsapp", "TEXT"],
  // Siparişe uygulanan kampanyaların anlık görüntüsü (kampanya sonradan silinse
  // bile siparişte ne uygulandığı kaybolmasın diye isimleriyle saklanır).
  ["orders", "campaign_summary", "TEXT"],
  // Renamed: the floor applies to the order total, not to the unit price.
  ["pricing_settings", "min_order_total", "REAL NOT NULL DEFAULT 150"],
  // Each extra colour means a filament swap: purge waste plus machine time.
  ["pricing_settings", "color_change_fee", "REAL NOT NULL DEFAULT 35"],
  // Per-part STL the workshop can drop straight into a slicer.
  ["quote_parts", "file_path", "TEXT"],
  ["quote_parts", "name", "TEXT"],
  // Surface-painted 3MF: the paint only survives in the original file.
  ["quotes", "painted", "INTEGER NOT NULL DEFAULT 0"]
]) {
  if (!(await hasColumn(table, column))) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

const existingMaterials = (await db.prepare("SELECT COUNT(*) count FROM materials").get()).count;
if (!existingMaterials) {
  const seedMaterial = db.prepare(`
    INSERT INTO materials (name, description, price_per_cm3, sort_order)
    VALUES (@name, @description, @price_per_cm3, @sort_order)
  `);
  // PLA keeps the 8.50 TL/cm3 rate the old hardcoded formula used, so prices do not move.
  const materials = [
    { name: "PLA", description: "Standart, ekonomik, iç mekan kullanımı", price_per_cm3: 8.5 },
    { name: "PETG", description: "Dayanıklı, ısıya ve neme daha dirençli", price_per_cm3: 11 },
    { name: "ABS", description: "Mekanik parçalar, yüksek sıcaklık dayanımı", price_per_cm3: 10 },
    { name: "Reçine (SLA)", description: "Yüksek detay, pürüzsüz yüzey", price_per_cm3: 18 }
  ];
  for (const [index, material] of materials.entries()) {
    await seedMaterial.run({ ...material, sort_order: index + 1 });
  }
}

if (!(await db.prepare("SELECT COUNT(*) count FROM pricing_settings").get()).count) {
  await db.prepare(`
    INSERT INTO pricing_settings (id, setup_fee, size_fee_per_cm, min_order_total, shell_share)
    VALUES (1, 120, 2.5, 150, 0.15)
  `).run();
}

const existingColors = (await db.prepare("SELECT COUNT(*) count FROM colors").get()).count;
if (!existingColors) {
  const seedColor = db.prepare("INSERT INTO colors (name, hex, sort_order) VALUES (@name, @hex, @sort_order)");
  const colors = [
    { name: "Beyaz", hex: "#ffffff" },
    { name: "Siyah", hex: "#1f2128" },
    { name: "Turuncu", hex: "#ff6542" },
    { name: "Kırmızı", hex: "#e02f2f" },
    { name: "Mavi", hex: "#2ba9ff" },
    { name: "Yeşil", hex: "#1f8f67" },
    { name: "Sarı", hex: "#f8d861" },
    { name: "Pembe", hex: "#ff4aa1" }
  ];
  for (const [index, color] of colors.entries()) {
    await seedColor.run({ ...color, sort_order: index + 1 });
  }
}

const existingCategories = (await db.prepare("SELECT COUNT(*) count FROM categories").get()).count;
if (!existingCategories) {
  const seedCategory = db.prepare(`
    INSERT INTO categories (name, image_path, image_alt, href, sort_order)
    VALUES (@name, @image_path, @image_alt, @href, @sort_order)
  `);
  // 3D baskı alt kategorileri — kapak görselleri temsili MakerWorld ürünlerinden,
  // admin panelinden değiştirilebilir. Bir ürün birden fazla kategoride olabilir.
  const categories = [
    { name: "Figürler", image_path: "https://makerworld.bblmw.com/makerworld/model/USf3226a122488f2/design/613a3d21dba2bbba.jpg?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı figür kategorisi" },
    { name: "Anahtarlıklar", image_path: "https://makerworld.bblmw.com/makerworld/model/USe2e8a5bf3ddaed/design/34e00292d363c821.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı anahtarlık kategorisi" },
    { name: "Fidget & Stres", image_path: "https://makerworld.bblmw.com/makerworld/model/US9a6f7ab9cda059/design/2025-09-11_7ae60a50cbf4a8.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı fidget ve stres oyuncağı kategorisi" },
    { name: "Düdükler", image_path: "https://makerworld.bblmw.com/makerworld/model/US208abf1d1f1a36/design/2024-01-09_42430df1b0709.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı düdük kategorisi" },
    { name: "Ev & Organizer", image_path: "https://makerworld.bblmw.com/makerworld/model/US9f63a04055cd4b/design/2026-01-13_59140b7190323.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı ev ve organizer kategorisi" }
  ];
  for (const [index, category] of categories.entries()) {
    await seedCategory.run({ ...category, href: "#store-products", sort_order: index + 1 });
  }
}

const existingSeoPages = (await db.prepare("SELECT COUNT(*) count FROM seo_pages").get()).count;
if (!existingSeoPages) {
  const seedPage = db.prepare(`
    INSERT INTO seo_pages (slug, label, title, description, canonical, og_title, og_description, og_image, robots)
    VALUES (@slug, @label, @title, @description, @canonical, @og_title, @og_description, @og_image, @robots)
  `);
  const seoSeeds = [
    {
      slug: "home",
      label: "Ana sayfa",
      title: "Printable | 3D Baskı Figür, Oyuncak ve Anahtarlık",
      description: "Hazır 3D baskı figür, oyuncak, anahtarlık ve fidget ürünleri. STL dosyanızı yükleyin, 3D baskı için anında fiyat alın.",
      canonical: "",
      og_title: "Printable | 3D Baskı Ürünleri ve STL Baskı Hizmeti",
      og_description: "Eklemli figürler, sevimli anahtarlıklar, fidget ve düdükler. Kendi STL dosyanızı da bastırın.",
      og_image: "",
      robots: "index,follow"
    },
    {
      slug: "urunler",
      label: "Ürünler sayfası",
      title: "Tüm 3D Baskı Ürünleri | Printable",
      description: "Figür, anahtarlık, fidget, düdük ve daha fazlası. Kategori, renk ve fiyata göre filtreleyin.",
      canonical: "",
      og_title: "Tüm 3D Baskı Ürünleri | Printable",
      og_description: "3D baskı ürünlerini kategori, renk ve fiyata göre filtreleyerek keşfedin.",
      og_image: "",
      robots: "index,follow"
    },
    {
      slug: "stl-teklif",
      label: "STL teklif sayfası",
      title: "STL Yükle, 3D Baskı Fiyatı Al | Printable",
      description: "STL dosyanızı yükleyin, malzeme ve dolgu oranına göre 3D baskı fiyatınızı anında görün.",
      canonical: "",
      og_title: "STL Yükle, 3D Baskı Fiyatı Al",
      og_description: "STL dosyanızı yükleyin, 3D baskı teklifinizi anında alın.",
      og_image: "",
      robots: "index,follow"
    }
  ];
  for (const page of seoSeeds) await seedPage.run(page);
}

// Pages that shipped after the seo_pages seed already ran on live databases get their
// rows idempotently (slug is UNIQUE, INSERT OR IGNORE is a no-op if already present).
const addSeoPage = db.prepare(`
  INSERT INTO seo_pages (slug, label, title, description, og_title, og_description, robots)
  VALUES (@slug, @label, @title, @description, @og_title, @og_description, 'index,follow')
  ON CONFLICT (slug) DO NOTHING
`);
const extraSeoPages = [
  {
    slug: "urunler", label: "Ürünler sayfası",
    title: "Tüm 3D Baskı Ürünleri | Printable",
    description: "Figür, anahtarlık, fidget, düdük ve daha fazlası. Kategori, renk ve fiyata göre filtreleyin.",
    og_title: "Tüm 3D Baskı Ürünleri | Printable",
    og_description: "3D baskı ürünlerini kategori, renk ve fiyata göre filtreleyerek keşfedin."
  },
  {
    slug: "hakkinda", label: "Hakkımızda sayfası",
    title: "Hakkımızda | Printable",
    description: "Printable; hazır 3D baskı figür, oyuncak ve anahtarlık satan, aynı zamanda STL baskı hizmeti veren bir atölyedir.",
    og_title: "Hakkımızda | Printable",
    og_description: "Tasarımı gerçeğe dönüştüren 3D baskı atölyesi."
  },
  {
    slug: "iletisim", label: "İletişim sayfası",
    title: "İletişim | Printable",
    description: "Sorularınız, özel baskı talepleriniz ve iş birlikleri için Printable ile iletişime geçin.",
    og_title: "İletişim | Printable",
    og_description: "Printable ile iletişime geçin."
  },
  {
    slug: "sss", label: "S.S.S. sayfası",
    title: "Sıkça Sorulan Sorular | Printable",
    description: "3D baskı ürünleri, kargo, ödeme, e-fatura ve iade hakkında sık sorulan sorular.",
    og_title: "Sıkça Sorulan Sorular | Printable",
    og_description: "3D baskı, kargo, ödeme ve e-fatura hakkında merak edilenler."
  }
];
for (const page of extraSeoPages) await addSeoPage.run(page);

const SITE_CONTACT = {
  phone: "0543 687 4208",
  social_links: "https://www.instagram.com/printablestr\nhttps://www.tiktok.com/@printabletr"
};

const existingSite = (await db.prepare("SELECT COUNT(*) count FROM site_settings").get()).count;
if (!existingSite) {
  await db.prepare(`
    INSERT INTO site_settings (id, site_name, site_url, description, logo_path, social_links, default_og_image, phone)
    VALUES (1, @site_name, @site_url, @description, @logo_path, @social_links, @default_og_image, @phone)
  `).run({
    site_name: "Printable",
    site_url: "",
    description: "Özel 3D baskı figür, oyuncak ve anahtarlık ürünleri; STL baskı hizmeti.",
    logo_path: "/assets/printable-logo.svg",
    default_og_image: "",
    ...SITE_CONTACT
  });
}

// Mevcut veritabanlarına gerçek iletişim bilgilerini taşı. Sadece boş alanları
// doldurur; admin panelinden girilen bir değerin üstüne asla yazmaz.
await db.prepare(`
  UPDATE site_settings SET
    phone = COALESCE(NULLIF(TRIM(phone), ''), @phone),
    social_links = COALESCE(NULLIF(TRIM(social_links), ''), @social_links)
  WHERE id = 1
`).run(SITE_CONTACT);

const existingProducts = (await db.prepare("SELECT COUNT(*) count FROM products").get()).count;
if (!existingProducts) {
  const seedProduct = db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path, image_alt, meta_keywords)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path, @image_alt, @meta_keywords)
  `);
  const seedProducts = [
    // 3D baskı ürünleri — MakerWorld kapak görselleri, admin'den güncellenebilir.
    { name: "Oynar Eklemli Toothless Ejderha Anahtarlık", sku: "PR-3D-001", category: null, description: "Destek gerektirmeden basılan, tüm eklemleri oynayan sevimli Toothless ejderha anahtarlık.", color: "PLA / çok renkli", price: 199, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/USe2e8a5bf3ddaed/design/34e00292d363c821.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Oynar eklemli Toothless ejderha anahtarlık 3D baskı", meta_keywords: "toothless, ejderha anahtarlık, oynar eklemli ejderha, dişsiz ejderha, 3d baskı ejderha" },
    { name: "Urban Spider-Man Figürü", sku: "PR-3D-002", category: null, description: "Hareketli pozların sergilendiği detaylı Urban Spider-Man koleksiyon figürü.", color: "PLA / çok renkli", price: 299, sale_price: 249, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/USf3226a122488f2/design/613a3d21dba2bbba.jpg?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Urban Spider-Man 3D baskı koleksiyon figürü", meta_keywords: "spiderman, örümcek adam figürü, koleksiyon figürü, marvel, 3d baskı figür" },
    { name: "Gezegen Dişlili Fidget Spinner", sku: "PR-3D-003", category: null, description: "Gezegen dişli mekanizmalı, parmakla döndürülen tatmin edici fidget spinner.", color: "PLA / çok renkli", price: 249, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US3fa154f896830/design/2024-09-22_de7d140930a96.gif?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Gezegen dişlili 3D baskı fidget spinner", meta_keywords: "fidget spinner, gezegen dişli, stres çarkı, 3d baskı oyuncak" },
    { name: "Minecraft TNT Sonsuzluk Küpü", sku: "PR-3D-004", category: null, description: "Minecraft TNT temalı, sonsuz katlanan stres atma küpü.", color: "PLA / çok renkli", price: 229, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US12141e05f5f0fd/design/2025-08-21_8f51c9c715866.jpg?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Minecraft TNT sonsuzluk küpü 3D baskı", meta_keywords: "minecraft, tnt, sonsuzluk küpü, infinity cube, stres küpü, 3d baskı" },
    { name: "Mini Oynar Yengeç Anahtarlık", sku: "PR-3D-005", category: null, description: "Cebe sığan, tüm bacakları oynayan mini yengeç anahtarlık.", color: "PLA / çok renkli", price: 149, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US12e41188080aab/design/2025-07-23_3378c9e01bc278.jpg?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Mini oynar yengeç anahtarlık 3D baskı", meta_keywords: "yengeç anahtarlık, oynar yengeç, mini figür, 3d baskı anahtarlık" },
    { name: "Sevimli Oynar Ender Ejderha (Minecraft)", sku: "PR-3D-006", category: null, description: "Minecraft evreninden, oynar eklemli sevimli Ender ejderha figürü.", color: "PLA / çok renkli", price: 279, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US2cec27bd30066e/design/4e48dee9d2d8e1f5.jpg?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Sevimli oynar Ender ejderha 3D baskı figürü", meta_keywords: "minecraft, ender ejderha, ender dragon, oynar figür, 3d baskı" },
    { name: "Sesli Düdük", sku: "PR-3D-007", category: null, description: "Tek parça basılan, gerçekten yüksek sesli çıkan düdük.", color: "PLA / çok renkli", price: 99, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US208abf1d1f1a36/design/2024-01-09_42430df1b0709.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Sesli 3D baskı düdük", meta_keywords: "düdük, sesli düdük, spor düdüğü, 3d baskı düdük" },
    { name: "Rocktopus – The Rock Ahtapot Figürü", sku: "PR-3D-008", category: null, description: "Dwayne 'The Rock' Johnson esintili, esprili Rocktopus ahtapot figürü.", color: "PLA / çok renkli", price: 349, sale_price: 299, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US6190ca67669c45/design/2023-09-25_8rzk09cv34gg.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Rocktopus The Rock ahtapot 3D baskı figürü", meta_keywords: "the rock, dwayne johnson, ahtapot figürü, rocktopus, komik figür, 3d baskı" },
    { name: "Sevimli Esnek Bebek Ejderha Anahtarlık", sku: "PR-3D-009", category: null, description: "Esnek gövdeli, sevimli bebek ejderha oyuncağı ve anahtarlık.", color: "PLA / çok renkli", price: 179, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US422918d45a4599/design/635bbc2657e9d831.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Sevimli esnek bebek ejderha anahtarlık 3D baskı", meta_keywords: "bebek ejderha, esnek ejderha, flexi dragon, anahtarlık, 3d baskı oyuncak" },
    { name: "Kuş Sesli Su Düdüğü", sku: "PR-3D-010", category: null, description: "İçine biraz su koyup üflediğinizde gerçek kuş sesi çıkaran düdük.", color: "PLA / çok renkli", price: 119, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/UScb82f263114ea6/design/1cd37e5d307e246d.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Kuş sesli su düdüğü 3D baskı", meta_keywords: "kuş düdüğü, su düdüğü, kuş sesi, 3d baskı düdük" },
    { name: "2026 Dünya Kupası Düdüğü", sku: "PR-3D-011", category: null, description: "2026 Dünya Kupası temalı, sesli hakem düdüğü.", color: "PLA / çok renkli", price: 129, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/USb0e373f9ff76f9/design/3698b5b15f6b7d96.webp?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "2026 Dünya Kupası temalı 3D baskı düdük", meta_keywords: "dünya kupası 2026, hakem düdüğü, futbol düdüğü, 3d baskı" },
    { name: "Açılı Fidget Küp Stres Oyuncağı", sku: "PR-3D-012", category: null, description: "Altı yüzünde farklı hareketler sunan açılı fidget küp stres oyuncağı.", color: "PLA / çok renkli", price: 199, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US9a6f7ab9cda059/design/2025-09-11_7ae60a50cbf4a8.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Açılı fidget küp stres oyuncağı 3D baskı", meta_keywords: "fidget küp, stres oyuncağı, açılı fidget, 3d baskı oyuncak" },
    { name: "Twerking Ghostface Figürü", sku: "PR-3D-013", category: null, description: "Eğlenceli Twerking Ghostface figürü — parti ve masaüstü için.", color: "PLA / çok renkli", price: 259, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US9586770665c394/design/2025-09-15_d14c8919233368.jpg?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Twerking Ghostface 3D baskı figürü", meta_keywords: "ghostface, scream, twerking, komik figür, 3d baskı figür" },
    { name: "Boks Eldiveni Anahtarlık (Sol El)", sku: "PR-3D-014", category: null, description: "Boks eldiveni şeklinde şık anahtarlık (sol el).", color: "PLA / çok renkli", price: 149, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US98a21712a93141/design/2025-11-22_a82377e6e5808.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Boks eldiveni anahtarlık sol el 3D baskı", meta_keywords: "boks eldiveni, anahtarlık, boks figürü, 3d baskı anahtarlık" },
    { name: "Sevimli Sallanan Penguen", sku: "PR-3D-015", category: null, description: "Dokununca sallanan, AMS gerektirmeden basılan sevimli penguen.", color: "PLA / çok renkli", price: 189, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/USb73ca708d54e53/design/c8ff7e84b2e36794.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Sevimli sallanan penguen 3D baskı", meta_keywords: "penguen, sallanan penguen, sevimli figür, 3d baskı oyuncak" },
    { name: "Ejderha Kafası Masaüstü Düzenleyici Tepsi", sku: "PR-3D-016", category: null, description: "Ejderha kafası formunda masaüstü / giriş düzenleyici tepsi — anahtar ve takı için.", color: "PLA / çok renkli", price: 399, sale_price: null, width: null, height: null, depth: null, weight: null, stock: 25, image_path: "https://makerworld.bblmw.com/makerworld/model/US9f63a04055cd4b/design/2026-01-13_59140b7190323.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "Ejderha kafası masaüstü düzenleyici tepsi 3D baskı", meta_keywords: "ejderha tepsi, masaüstü organizer, catchall tray, ejderha kafası, 3d baskı ev" }
  ];
  for (const product of seedProducts) await seedProduct.run(product);

  const productIdBySku = db.prepare("SELECT id FROM products WHERE sku = ?");

  // Give the seeded products a few palette colours so the storefront swatches
  // are not empty on a fresh install.
  const linkColor = db.prepare(`
    INSERT INTO product_colors (product_id, color_id)
    SELECT ?, id FROM colors WHERE name = ?
    ON CONFLICT DO NOTHING
  `);
  for (const [sku, names] of [
    ["PR-3D-001", ["Beyaz", "Siyah", "Turuncu"]],
    ["PR-3D-002", ["Mavi", "Siyah", "Kırmızı"]],
    ["PR-3D-003", ["Mavi", "Sarı", "Siyah"]]
  ]) {
    const product = await productIdBySku.get(sku);
    if (product) for (const name of names) await linkColor.run(product.id, name);
  }

  // A product can belong to more than one category — link by name so it survives
  // whatever ids the category seed produced.
  const linkCategory = db.prepare(`
    INSERT INTO product_categories (product_id, category_id)
    SELECT ?, id FROM categories WHERE name = ?
    ON CONFLICT DO NOTHING
  `);
  for (const [sku, names] of [
    ["PR-3D-001", ["Figürler", "Anahtarlıklar"]],
    ["PR-3D-002", ["Figürler"]],
    ["PR-3D-003", ["Fidget & Stres"]],
    ["PR-3D-004", ["Fidget & Stres"]],
    ["PR-3D-005", ["Figürler", "Anahtarlıklar"]],
    ["PR-3D-006", ["Figürler"]],
    ["PR-3D-007", ["Düdükler"]],
    ["PR-3D-008", ["Figürler"]],
    ["PR-3D-009", ["Figürler", "Anahtarlıklar"]],
    ["PR-3D-010", ["Düdükler"]],
    ["PR-3D-011", ["Düdükler"]],
    ["PR-3D-012", ["Fidget & Stres"]],
    ["PR-3D-013", ["Figürler"]],
    ["PR-3D-014", ["Anahtarlıklar"]],
    ["PR-3D-015", ["Figürler"]],
    ["PR-3D-016", ["Ev & Organizer"]]
  ]) {
    const product = await productIdBySku.get(sku);
    if (product) for (const name of names) await linkCategory.run(product.id, name);
  }
}

// Baseline price history: every product gets at least one entry so the log is never
// empty and the "current price since" reference exists. Idempotent — only products
// that have no history yet are seeded.
await db.prepare(`
  INSERT INTO price_history (product_id, price, sale_price)
  SELECT p.id, p.price, p.sale_price FROM products p
  WHERE NOT EXISTS (SELECT 1 FROM price_history h WHERE h.product_id = p.id)
`).run();

const existingSlides = (await db.prepare("SELECT COUNT(*) count FROM hero_slides").get()).count;
if (!existingSlides) {
  const seedSlide = db.prepare(`
    INSERT INTO hero_slides (image_path, title, subtitle, primary_label, primary_href, secondary_label, secondary_href, sort_order)
    VALUES (@image_path, @title, @subtitle, @primary_label, @primary_href, @secondary_label, @secondary_href, @sort_order)
  `);
  const slides = [
    {
      image_path: "https://images.unsplash.com/photo-1572044162444-ad60f128bdea?auto=format&fit=crop&w=1800&q=75",
      title: "3D Baskı Figür, Oyuncak ve Anahtarlıklar",
      subtitle: "Hazır 3D baskı ürünlerini keşfedin veya kendi STL dosyanızı yükleyin",
      primary_label: "Ürünleri incele",
      primary_href: "/urunler",
      secondary_label: "STL yükle, fiyat al",
      secondary_href: "/stl-teklif",
      sort_order: 1
    },
    {
      image_path: "https://images.unsplash.com/photo-1503694978374-8a2fa686963a?auto=format&fit=crop&w=1800&q=75",
      title: "Eklemli Figürler ve Sevimli Anahtarlıklar",
      subtitle: "PLA ile dayanıklı, renkli ve oynar eklemli 3D baskılar",
      primary_label: "Ürünleri incele",
      primary_href: "/urunler",
      secondary_label: "Teklif al",
      secondary_href: "/stl-teklif",
      sort_order: 2
    },
    {
      image_path: "https://images.unsplash.com/photo-1622547748225-3fc4abd2cca0?auto=format&fit=crop&w=1800&q=75",
      title: "3D Modelinizi Yükleyin, Fiyatı Görün",
      subtitle: "STL veya 3MF dosyanızı yükleyin, anında teklif alın",
      primary_label: "STL yükle, fiyat al",
      primary_href: "/stl-teklif",
      secondary_label: "",
      secondary_href: "",
      sort_order: 3
    }
  ];
  for (const slide of slides) await seedSlide.run(slide);
}

// Kurulum tamam: sonraki soğuk başlatmalar bu satır sayesinde erken çıkacak.
await db.prepare(`
  INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
`).run(SCHEMA_VERSION);
}   // <-- initDb() sonu

/* Şema hazır olana kadar hiçbir istek veritabanına dokunmamalı. initDb() modül
   yüklenirken bir kez başlar; aşağıdaki kapı her isteği o söz tutulana kadar
   bekletir. Vercel'de her soğuk başlatmada bir kez ödenen bir gecikme. */
const dbReady = initDb().then(
  () => console.log("Veritabanı hazır."),
  (error) => {
    console.error("VERİTABANI BAŞLATILAMADI:", error.message);
    throw error;
  }
);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      cb(null, `${Date.now()}-${safe}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype));
  },
  limits: { fileSize: 8 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Hazırlık kapısı: şema/seed bitmeden hiçbir route veritabanına dokunamaz.
// Statik dosyalardan önce durmasın diye onları aşağıda tanımlıyoruz.
app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch {
    res.status(503).json({ error: "Veritabanı şu anda hazır değil, birazdan tekrar deneyin." });
  }
});

app.use("/uploads", express.static(UPLOAD_DIR));

/* Tarayıcının dosyayı doğrudan Supabase Storage'a yüklemesi için imzalı adres.
   Dosya sunucudan geçmez — Vercel'in ~4.5 MB istek sınırı böylece aşılır.
   Görsel yüklemesi admin'e özel; model yüklemesi teklif formundan herkese açık,
   o yüzden uzantı doğrulaması burada, sunucuda yapılır. */
app.post("/api/uploads/sign", async (req, res) => {
  const kind = req.body?.kind === "image" ? "image" : "model";
  if (kind === "image" && !isAuthed(req)) {
    return res.status(401).json({ error: "Yetkiniz yok." });
  }
  if (!storage.enabled) {
    return res.status(503).json({ error: "Dosya depolama yapılandırılmamış." });
  }
  try {
    const signed = await storage.createUploadUrl(kind, req.body?.filename);
    res.json({ path: signed.path, signedUrl: signed.signedUrl, token: signed.token });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.use("/assets", express.static(path.join(ROOT, "assets")));
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);

// Absolute URLs — Open Graph and canonical are ignored by crawlers when relative.
function absoluteUrl(req, value, siteUrl) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const base = (siteUrl || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`;
}

// Meta tags must be in the HTML the server sends: crawlers and social-preview
// bots (WhatsApp, X, LinkedIn) do not run our JavaScript.
async function seoHead(req, slug) {
  const page = await db.prepare("SELECT * FROM seo_pages WHERE slug = ?").get(slug) || {};
  const site = await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};

  const title = page.title || site.site_name || "Printable";
  const description = page.description || site.description || "";
  const canonical = absoluteUrl(req, page.canonical || req.originalUrl.split("?")[0], site.site_url);
  const ogTitle = page.og_title || title;
  const ogDescription = page.og_description || description;
  const ogImage = absoluteUrl(req, page.og_image || site.default_og_image, site.site_url);
  const logo = absoluteUrl(req, site.logo_path, site.site_url);
  const siteUrl = absoluteUrl(req, "/", site.site_url);

  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    description && `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta name="robots" content="${escapeHtml(page.robots || "index,follow")}">`,
    canonical && `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeHtml(site.site_name || "Printable")}">`,
    `<meta property="og:locale" content="tr_TR">`,
    `<meta property="og:title" content="${escapeHtml(ogTitle)}">`,
    ogDescription && `<meta property="og:description" content="${escapeHtml(ogDescription)}">`,
    canonical && `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    ogImage && `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
    `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeHtml(ogTitle)}">`,
    ogDescription && `<meta name="twitter:description" content="${escapeHtml(ogDescription)}">`,
    ogImage && `<meta name="twitter:image" content="${escapeHtml(ogImage)}">`
  ].filter(Boolean);

  // Roll the active products' own keywords up into a page-level keywords meta.
  // Meta keywords are a weak ranking signal, but this is the correct place for it:
  // server-rendered, where crawlers see it (the product grid itself is JS-rendered).
  if (slug === "home") {
    const rows = await db.prepare("SELECT meta_keywords FROM products WHERE is_active = 1 AND meta_keywords IS NOT NULL AND meta_keywords <> ''").all();
    const keywords = [...new Set(
      rows.flatMap((row) => row.meta_keywords.split(",")).map((word) => word.trim().toLowerCase()).filter(Boolean)
    )].slice(0, 40).join(", ");
    if (keywords) tags.push(`<meta name="keywords" content="${escapeHtml(keywords)}">`);
  }

  const sameAs = (site.social_links || "").split(/[\s,]+/).filter(Boolean);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: site.site_name || "Printable",
        url: siteUrl,
        ...(logo ? { logo } : {}),
        ...(site.description ? { description: site.description } : {}),
        ...(sameAs.length ? { sameAs } : {})
      },
      {
        "@type": "WebSite",
        name: site.site_name || "Printable",
        url: siteUrl,
        inLanguage: "tr-TR"
      }
    ]
  };
  // "<" is escaped so a value can never break out of the script element.
  tags.push(`<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`);

  return tags.join("\n    ");
}

// One header for every public page, injected server-side so the navbar can never
// drift between pages again. `active` marks the current main-await link (home | urunler | stl-teklif).
async function renderHeader(active) {
  const link = (href, label, key) => `<a${active === key ? ' class="active"' : ""} href="${href}">${label}</a>`;
  return `
    <header class="site-header">
      <div class="container header-main">
        <a class="logo printable-logo" href="/" aria-label="Printable ana sayfa">
          <span>Printable</span>
        </a>
        <!-- Yalnızca mobilde görünür; menüyü açar. -->
        <button class="nav-toggle" type="button" id="nav-toggle"
                aria-label="Menüyü aç" aria-expanded="false" aria-controls="main-links">
          <span></span><span></span><span></span>
        </button>
        <nav class="main-links" id="main-links" aria-label="Ana menü">
          ${await link("/", "Ana Sayfa", "home")}
          ${await link("/urunler", "Ürünler", "urunler")}
          ${await link("/stl-teklif", "3D Baskı Teklifi", "stl-teklif")}
          ${await link("/hakkinda", "Hakkımızda", "hakkinda")}
          ${await link("/iletisim", "İletişim", "iletisim")}
        </nav>
        <nav class="header-actions" aria-label="Mağaza işlemleri">
          <button class="search-toggle icon-button" type="button" aria-label="Arama aç" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.3-4.3m1.3-5.2a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"/></svg>
          </button>
          <a class="cart icon-button" href="#cart-panel" aria-label="Sepet">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 8h14l-1.4 7.2a2 2 0 0 1-2 1.6H9a2 2 0 0 1-2-1.7L5.8 4H3"/><path d="M9.5 20.5h.01M17.5 20.5h.01"/></svg>
            <strong id="cart-count">0</strong>
          </a>
          <a class="admin-link icon-button" href="/admin" aria-label="Yönetim paneli">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
          </a>
          <a class="header-quote" href="/stl-teklif">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 7.2v9.6L12 21l7.5-4.2V7.2L12 3Z"/><path d="M12 12 4.8 7.4M12 12l7.2-4.6M12 12v8.5"/></svg>
            <span>3D Baskı Teklifi</span>
          </a>
        </nav>
      </div>
      <form class="search search-popover" role="search">
        <input type="search" placeholder="Ürün ara">
        <button type="submit">Ara</button>
      </form>
    </header>`;
}

// Shared cart drawer. Item rows + a footer with the subtotal and a link to the
// full /odeme checkout flow. Rendered on every page that loads script.js.
function renderCartPanel() {
  return `
    <section class="cart-panel" id="cart-panel" aria-label="Sepet">
      <div class="cart-panel__header">
        <h2>Sepetiniz</h2>
        <button id="close-cart" type="button" aria-label="Sepeti kapat">Kapat</button>
      </div>
      <div id="cart-items" class="cart-items"></div>
      <div class="cart-panel__footer" id="cart-footer" hidden>
        <div class="cart-subtotal"><span>Ara toplam</span><strong id="cart-subtotal">0.00 TL</strong></div>
        <p class="cart-note">Fiyatlara KDV eklenir · Kargo alıcı ödemeli</p>
        <a class="cart-checkout" href="/odeme">Ödemeye geç</a>
        <button type="button" class="cart-continue" id="cart-continue">Alışverişe devam et</button>
      </div>
    </section>`;
}

// "0543 687 4208" → "905436874208". wa.me wants digits only, with the country
// code and without the trunk "0"; numbers already in +90/90 form pass through.
function whatsappDigits(value) {
  const digits = (value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("90")) return digits;
  return `90${digits.replace(/^0+/, "")}`;
}

// social_links is one URL per line (admin-managed). The network is derived from
// the host so the admin never has to pick an icon — an unknown host still gets a
// link, just with the generic globe glyph.
const SOCIAL_ICONS = {
  instagram: `<path d="M12 2.2c3.2 0 3.6 0 4.8.07 1.2.05 1.8.25 2.2.42.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.17.4.37 1 .42 2.2.07 1.2.07 1.6.07 4.8s0 3.6-.07 4.8c-.05 1.2-.25 1.8-.42 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.17-1 .37-2.2.42-1.2.07-1.6.07-4.8.07s-3.6 0-4.8-.07c-1.2-.05-1.8-.25-2.2-.42-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.17-.4-.37-1-.42-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.07-4.8c.05-1.2.25-1.8.42-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.17 1-.37 2.2-.42C8.4 2.2 8.8 2.2 12 2.2Zm0 1.8c-3.1 0-3.5 0-4.7.07-1.1.05-1.7.24-2.1.4-.5.2-.9.44-1.3.84-.4.4-.64.8-.84 1.3-.16.4-.35 1-.4 2.1C2.6 9.9 2.6 10.3 2.6 12s0 2.1.06 3.3c.05 1.1.24 1.7.4 2.1.2.5.44.9.84 1.3.4.4.8.64 1.3.84.4.16 1 .35 2.1.4 1.2.06 1.6.06 4.7.06s3.5 0 4.7-.06c1.1-.05 1.7-.24 2.1-.4.5-.2.9-.44 1.3-.84.4-.4.64-.8.84-1.3.16-.4.35-1 .4-2.1.06-1.2.06-1.6.06-3.3s0-2.1-.06-3.3c-.05-1.1-.24-1.7-.4-2.1a3.5 3.5 0 0 0-.84-1.3 3.5 3.5 0 0 0-1.3-.84c-.4-.16-1-.35-2.1-.4C15.5 4 15.1 4 12 4Zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 1.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Zm5.2-3.1a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z"/>`,
  tiktok: `<path d="M16.6 2h-3.1v14.1a2.6 2.6 0 1 1-2.6-2.6c.2 0 .5 0 .7.1v-3.2a6 6 0 0 0-.7 0 5.8 5.8 0 1 0 5.8 5.8V9.4a7 7 0 0 0 4.1 1.3V7.5a4.1 4.1 0 0 1-4.2-4.1V2Z"/>`,
  whatsapp: `<path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2Zm0 1.9a8.1 8.1 0 1 1-4.2 15l-.3-.2-3 .8.8-3-.2-.3A8.1 8.1 0 0 1 12 3.9Zm-3.7 4c-.2 0-.5.1-.7.4-.3.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.7 2.7 4.2 3.7 2.1.8 2.5.7 3 .6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.5-.3l-1.8-.9c-.3-.1-.5-.1-.6.1l-.8 1c-.2.2-.3.2-.5.1-.3-.1-1.2-.4-2.2-1.4-.8-.7-1.4-1.6-1.5-1.9-.2-.2 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5v-.5c-.1-.1-.6-1.5-.8-2-.2-.5-.4-.4-.6-.5h-.5Z"/>`,
  generic: `<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 1.9c1 0 2.3 1.9 2.8 5.2H9.2c.5-3.3 1.8-5.2 2.8-5.2ZM8.9 11h6.2a20 20 0 0 1 0 2H8.9a20 20 0 0 1 0-2Zm-1.8 2H4.1a8.1 8.1 0 0 1 0-2h3a22 22 0 0 0 0 2Zm1.8 2h5.8c-.5 3.3-1.8 5.2-2.9 5.2s-2.4-1.9-2.9-5.2Zm7.8-2a22 22 0 0 0 0-2h3a8.1 8.1 0 0 1 0 2h-3Zm2.4-4h-2.7a13 13 0 0 0-1.3-4A8.1 8.1 0 0 1 19.1 9ZM9.8 5a13 13 0 0 0-1.3 4H5.8a8.1 8.1 0 0 1 4-4Zm-4 10h2.7a13 13 0 0 0 1.3 4 8.1 8.1 0 0 1-4-4Zm8.4 4a13 13 0 0 0 1.3-4h2.7a8.1 8.1 0 0 1-4 4Z"/>`
};

function socialAccounts(links) {
  return (links || "").split(/[\s,]+/).filter(Boolean).map((url) => {
    const host = url.replace(/^https?:\/\//i, "").toLowerCase();
    if (host.includes("instagram.com")) return { url, key: "instagram", label: "Instagram" };
    if (host.includes("tiktok.com")) return { url, key: "tiktok", label: "TikTok" };
    if (host.includes("facebook.com")) return { url, key: "generic", label: "Facebook" };
    if (host.includes("youtube.com")) return { url, key: "generic", label: "YouTube" };
    if (host.includes("x.com") || host.includes("twitter.com")) return { url, key: "generic", label: "X" };
    return { url, key: "generic", label: "Sosyal medya" };
  });
}

// Contact block shared by the footer and the floating WhatsApp button.
async function contactInfo() {
  const site = await db.prepare("SELECT phone, email, whatsapp, social_links FROM site_settings WHERE id = 1").get() || {};
  const phone = (site.phone || "").trim();
  return {
    phone,
    email: (site.email || "").trim(),
    wa: whatsappDigits((site.whatsapp || "").trim() || phone),
    accounts: socialAccounts(site.social_links)
  };
}

// Shared footer, injected server-side so links stay consistent across every page.
async function renderFooter() {
  const { phone, email, wa, accounts } = await contactInfo();
  const socialRow = accounts.length
    ? `<div class="footer-social">${accounts.map((a) =>
        `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" aria-label="${escapeHtml(a.label)}"><svg viewBox="0 0 24 24" aria-hidden="true">${SOCIAL_ICONS[a.key]}</svg></a>`
      ).join("")}</div>`
    : "";
  const contactRow = [
    phone && `<a class="footer-contact__line" href="tel:${escapeHtml(phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(phone)}</a>`,
    wa && `<a class="footer-contact__line" href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp'tan yazın</a>`,
    email && `<a class="footer-contact__line" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
  ].filter(Boolean).join("");

  return `
    <footer class="footer">
      <div class="container newsletter">
        <h2>Bültenimize abone olun</h2>
        <form id="newsletter-form" novalidate>
          <input type="email" name="email" placeholder="E-posta adresiniz" autocomplete="email" required>
          <button type="submit">Abone ol</button>
        </form>
        <p class="newsletter__msg" id="newsletter-msg" role="status" hidden></p>
      </div>
      <div class="container footer__grid">
        <div><h3>Kategoriler</h3><a href="/urunler">Figürler</a><a href="/urunler">Anahtarlıklar</a><a href="/urunler">Fidget & Stres</a><a href="/urunler">Düdükler</a></div>
        <div><h3>Kurumsal</h3><a href="/hakkinda">Hakkımızda</a><a href="/iletisim">İletişim</a><a href="/stl-teklif">Özel 3D baskı</a><a href="/urunler">Tüm ürünler</a></div>
        <div><h3>Müşteri Desteği</h3><a href="/iletisim">Bize ulaşın</a><a href="/sss">İade & Değişim</a><a href="/sss">Kargo</a><a href="/sss">S.S.S.</a></div>
        <div class="footer-logo printable-wordmark">
          <strong>Printable</strong>
          <p>Özel 3D baskı ürünleri ve STL baskı hizmeti.</p>
          <p>Türkiye</p>
          <div class="footer-contact">${contactRow}</div>
          ${socialRow}
        </div>
      </div>
    </footer>`;
}

// Floating WhatsApp button — replaces the old inert "?" bubble on every page.
async function renderChatButton() {
  const { wa } = await contactInfo();
  if (!wa) return "";
  return `
    <a class="chat" href="https://wa.me/${wa}" target="_blank" rel="noopener" aria-label="WhatsApp'tan yazın">
      <svg viewBox="0 0 24 24" aria-hidden="true">${SOCIAL_ICONS.whatsapp}</svg>
    </a>`;
}

async function injectShell(html, headActive) {
  return html
    .replace("<!--header-->", await renderHeader(headActive))
    .replace("<!--cart-->", renderCartPanel())
    .replace("<!--footer-->", await renderFooter())
    .replace("<!--chat-->", await renderChatButton());
}

async function sendPage(req, res, file, slug) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  res.type("html").send(await injectShell(html.replace("<!--seo-->", await seoHead(req, slug)), slug));
}

app.get("/", async (req, res) => await sendPage(req, res, "index.html", "home"));
app.get("/urunler", async (req, res) => await sendPage(req, res, "urunler.html", "urunler"));
app.get("/stl-teklif", async (req, res) => await sendPage(req, res, "stl-teklif.html", "stl-teklif"));
app.get("/hakkinda", async (req, res) => await sendPage(req, res, "hakkinda.html", "hakkinda"));
app.get("/iletisim", async (req, res) => await sendPage(req, res, "iletisim.html", "iletisim"));
app.get("/sss", async (req, res) => await sendPage(req, res, "sss.html", "sss"));

// Per-product SEO: crawlers need real title/description/og:image/JSON-LD in the HTML
// (the visible detail is filled by urun.js, matching the rest of the JS-rendered site).
async function productMetaTags(req, product) {
  const site = await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
  const title = product.meta_title || `${product.name} | Printable`;
  const description = product.meta_description || product.description || site.description || "";
  const canonical = absoluteUrl(req, `/urun/${product.id}`, site.site_url);
  const image = absoluteUrl(req, product.image_path || site.default_og_image, site.site_url);
  const price = Number(product.sale_price || product.price || 0).toFixed(2);

  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    description && `<meta name="description" content="${escapeHtml(description)}">`,
    product.meta_keywords && `<meta name="keywords" content="${escapeHtml(product.meta_keywords)}">`,
    `<meta name="robots" content="index,follow">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="${escapeHtml(site.site_name || "Printable")}">`,
    `<meta property="og:locale" content="tr_TR">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    description && `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    image && `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    description && `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    image && `<meta name="twitter:image" content="${escapeHtml(image)}">`
  ].filter(Boolean);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    ...(image ? { image } : {}),
    ...(description ? { description } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    brand: { "@type": "Brand", name: site.site_name || "Printable" },
    offers: {
      "@type": "Offer",
      price,
      priceCurrency: "TRY",
      availability: product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: canonical
    }
  };
  tags.push(`<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`);

  // Breadcrumb trail helps search engines show Ana Sayfa › Ürünler › ürün in results.
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Ana Sayfa", item: absoluteUrl(req, "/", site.site_url) },
      { "@type": "ListItem", position: 2, name: "Ürünler", item: absoluteUrl(req, "/urunler", site.site_url) },
      { "@type": "ListItem", position: 3, name: product.name, item: canonical }
    ]
  };
  tags.push(`<script type="application/ld+json">${JSON.stringify(breadcrumb).replace(/</g, "\\u003c")}</script>`);
  return tags.join("\n    ");
}

app.get("/urun/:id", async (req, res) => {
  const product = await db.prepare("SELECT * FROM products WHERE id = ? AND is_active = 1").get(req.params.id);
  if (!product) return res.redirect(302, "/urunler");
  const html = fs.readFileSync(path.join(ROOT, "urun.html"), "utf8");
  res.type("html").send(await injectShell(html.replace("<!--seo-->", await productMetaTags(req, withColors(product))), "urunler"));
});

// Checkout flow — noindex (a transactional page crawlers should not list).
app.get("/odeme", async (req, res) => {
  const site = await db.prepare("SELECT site_name FROM site_settings WHERE id = 1").get() || {};
  const head = [
    `<title>Ödeme | ${escapeHtml(site.site_name || "Printable")}</title>`,
    `<meta name="robots" content="noindex,nofollow">`
  ].join("\n    ");
  const html = fs.readFileSync(path.join(ROOT, "odeme.html"), "utf8");
  res.type("html").send(await injectShell(html.replace("<!--seo-->", head), ""));
});

// Tell crawlers what to index and where the sitemap is. Admin and API paths are off-limits.
app.get("/robots.txt", async (req, res) => {
  const site = await db.prepare("SELECT site_url FROM site_settings WHERE id = 1").get() || {};
  const base = (site.site_url || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.type("text/plain").send(
    ["User-agent: *", "Allow: /", "Disallow: /admin", "Disallow: /login", "Disallow: /api/", "Disallow: /odeme", "", `Sitemap: ${base}/sitemap.xml`, ""].join("\n")
  );
});

// Dynamic sitemap: the static pages plus every active product detail page.
app.get("/sitemap.xml", async (req, res) => {
  const site = await db.prepare("SELECT site_url FROM site_settings WHERE id = 1").get() || {};
  const urls = [
    { loc: "/", priority: "1.0" },
    { loc: "/urunler", priority: "0.9" },
    { loc: "/stl-teklif", priority: "0.8" },
    { loc: "/hakkinda", priority: "0.5" },
    { loc: "/iletisim", priority: "0.5" },
    { loc: "/sss", priority: "0.5" }
  ];
  // `await x.all().forEach(...)` aslında `await (Promise.forEach(...))` demek:
  // .forEach Promise üzerinde yok, sitemap bu yüzden hata veriyordu.
  const activeProducts = await db.prepare(
    "SELECT id, updated_at FROM products WHERE is_active = 1 ORDER BY id"
  ).all();
  activeProducts.forEach((p) => urls.push({
    loc: `/urun/${p.id}`,
    priority: "0.7",
    lastmod: String(p.updated_at instanceof Date ? p.updated_at.toISOString() : p.updated_at || "").slice(0, 10)
  }));

  const body = urls.map((u) => {
    const loc = escapeHtml(absoluteUrl(req, u.loc, site.site_url));
    return `  <url>\n    <loc>${loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}\n    <priority>${u.priority}</priority>\n  </url>`;
  }).join("\n");

  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  );
});

["styles.css", "script.js", "stl-viewer.js", "admin.css", "admin.js", "urunler.js", "urun.js", "odeme.js", "iletisim.js"].forEach((file) => {
  app.get(`/${file}`, async (req, res) => res.sendFile(path.join(ROOT, file)));
});

function signSession(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((cookie) => {
    const index = cookie.indexOf("=");
    return [cookie.slice(0, index).trim(), decodeURIComponent(cookie.slice(index + 1))];
  }));
}

function isAuthed(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return false;
  const [user, expires, signature] = raw.split(".");
  if (!user || !expires || !signature || Number(expires) < Date.now()) return false;
  const expected = signSession(`${user}.${expires}`);
  try {
    return user === ADMIN_USER && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Admin login required." });
  return res.redirect("/login");
}

function setSessionCookie(res) {
  const expires = Date.now() + 1000 * 60 * 60 * 12;
  const value = `${ADMIN_USER}.${expires}`;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(`${value}.${signSession(value)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
}

app.get("/login", async (req, res) => {
  if (isAuthed(req)) return res.redirect("/admin");
  return res.sendFile(path.join(ROOT, "login.html"));
});

app.post("/api/login", async (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASSWORD) {
    setSessionCookie(res);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
});

app.post("/api/logout", async (req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/session", async (req, res) => {
  res.json({ authed: isAuthed(req), user: isAuthed(req) ? ADMIN_USER : null });
});

const money = (value) => Number(value || 0);
const nullableMoney = (value) => value === "" || value == null ? null : Number(value);
const toInt = (value) => Number.parseInt(value || "0", 10);

/* Bir görselin kaynağı üç yerden gelebilir:
     1) image_key   — tarayıcı doğrudan Supabase Storage'a yükledi, elimizde anahtar var
     2) file        — multer ile diske yazıldı (yerel geliştirme)
     3) image_url   — admin elle bir adres yapıştırdı
   Hiçbiri yoksa mevcut görsel korunur (düzenlemede alan boş bırakılmış demektir). */
function resolveImagePath(body, file) {
  if (body.image_key) return storage.publicUrl(body.image_key);
  if (file) return `/uploads/${file.filename}`;
  return body.image_url?.trim() || body.current_image || null;
}

function productPayload(body, file) {
  return {
    name: body.name?.trim(),
    sku: body.sku?.trim() || null,
    category: body.category?.trim() || null,
    description: body.description?.trim() || null,
    color: body.color?.trim() || null,
    price: money(body.price),
    sale_price: nullableMoney(body.sale_price),
    width: nullableMoney(body.width),
    height: nullableMoney(body.height),
    depth: nullableMoney(body.depth),
    weight: nullableMoney(body.weight),
    stock: toInt(body.stock),
    image_path: resolveImagePath(body, file),
    image_alt: body.image_alt?.trim() || null,
    meta_title: body.meta_title?.trim() || null,
    meta_description: body.meta_description?.trim() || null,
    meta_keywords: body.meta_keywords?.trim() || null,
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.get("/api/stats", requireAdmin, async (req, res) => {
  const stats = {
    products: (await db.prepare("SELECT COUNT(*) count FROM products").get()).count,
    customers: (await db.prepare("SELECT COUNT(*) count FROM customers").get()).count,
    orders: (await db.prepare("SELECT COUNT(*) count FROM orders").get()).count,
    revenue: (await db.prepare("SELECT COALESCE(SUM(total), 0) total FROM orders").get()).total,
    quotes: (await db.prepare("SELECT COUNT(*) count FROM quotes WHERE status = 'new'").get()).count,
    messages: (await db.prepare("SELECT COUNT(*) count FROM messages WHERE is_read = 0").get()).count
  };
  res.json(stats);
});

const colorsOfProduct = db.prepare(`
  SELECT colors.* FROM colors
  JOIN product_colors ON product_colors.color_id = colors.id
  WHERE product_colors.product_id = ?
  ORDER BY colors.sort_order ASC, colors.id ASC
`);

// Only the id/name the storefront and admin need — categories carry image/alt/href
// too, but a product card just filters and badges by these two.
const categoriesOfProduct = db.prepare(`
  SELECT categories.id, categories.name FROM categories
  JOIN product_categories ON product_categories.category_id = categories.id
  WHERE product_categories.product_id = ?
  ORDER BY categories.sort_order ASC, categories.id ASC
`);

// Only approved reviews count towards the public score, so an unmoderated
// 1-star cannot drag a product's rating down before anyone has seen it.
const ratingOfProduct = db.prepare(`
  SELECT ROUND(AVG(rating)::numeric, 1) AS average, COUNT(*) AS count
  FROM reviews WHERE product_id = ? AND is_approved = 1
`);

/* Liste için toplu sürüm. withColors ürün BAŞINA 3 sorgu yapıyor; 16 ürünlük
   katalogda bu 49 sorgu demek. Uzak bir veritabanında (Supabase) ve küçük bir
   bağlantı havuzunda sorgular sıraya girip zaman aşımına uğruyordu — tarayıcı
   aynı anda birkaç uç noktayı çağırdığında 500 dönüyordu.
   Burada tüm ilişkiler 3 sorguda çekilip bellekte eşleştiriliyor. */
async function decorateProducts(products) {
  if (!products.length) return [];
  const ids = products.map((p) => p.id);
  const list = `(${ids.map(() => "?").join(",")})`;

  const [colorRows, categoryRows, ratingRows] = await Promise.all([
    db.prepare(`
      SELECT pc.product_id, c.* FROM colors c
      JOIN product_colors pc ON pc.color_id = c.id
      WHERE pc.product_id IN ${list}
      ORDER BY c.sort_order ASC, c.id ASC
    `).all(...ids),
    db.prepare(`
      SELECT pc.product_id, cat.id, cat.name FROM categories cat
      JOIN product_categories pc ON pc.category_id = cat.id
      WHERE pc.product_id IN ${list}
      ORDER BY cat.sort_order ASC, cat.id ASC
    `).all(...ids),
    db.prepare(`
      SELECT product_id, ROUND(AVG(rating)::numeric, 1) AS average, COUNT(*) AS count
      FROM reviews WHERE is_approved = 1 AND product_id IN ${list}
      GROUP BY product_id
    `).all(...ids)
  ]);

  const bucket = (rows) => rows.reduce((map, row) => {
    const { product_id, ...rest } = row;
    (map[product_id] ||= []).push(rest);
    return map;
  }, {});
  const colors = bucket(colorRows);
  const categories = bucket(categoryRows);
  const ratings = Object.fromEntries(ratingRows.map((r) => [r.product_id, { average: r.average, count: r.count }]));

  return products.map((product) => ({
    ...product,
    rating: ratings[product.id] || { average: null, count: 0 },
    colors: colors[product.id] || [],
    categories: categories[product.id] || []
  }));
}

// Tek ürün için: POST/PUT sonrası dönen kayıtta kullanılır.
const withColors = async (product) => ({
  ...product,
  rating: (await ratingOfProduct.get(product.id)) || { average: null, count: 0 },
  colors: await colorsOfProduct.all(product.id),
  categories: await categoriesOfProduct.all(product.id)
});

// A multi-select posts one value per checked box; multer/urlencoded gives a string
// when exactly one is checked and an array when several are.
async function setProductColors(productId, colorIds) {
  const ids = [].concat(colorIds ?? []).map((id) => toInt(id)).filter(Boolean);
  await db.transaction(async (tx) => {
    await tx.prepare("DELETE FROM product_colors WHERE product_id = ?").run(productId);
    const link = tx.prepare("INSERT INTO product_colors (product_id, color_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
    for (const colorId of ids) await link.run(productId, colorId);
  });
}

// Same shape as setProductColors — the category multi-select posts repeated category_ids.
async function setProductCategories(productId, categoryIds) {
  const ids = [].concat(categoryIds ?? []).map((id) => toInt(id)).filter(Boolean);
  await db.transaction(async (tx) => {
    await tx.prepare("DELETE FROM product_categories WHERE product_id = ?").run(productId);
    const link = tx.prepare("INSERT INTO product_categories (product_id, category_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
    for (const categoryId of ids) await link.run(productId, categoryId);
  });
}

const insertPriceHistory = db.prepare(
  "INSERT INTO price_history (product_id, price, sale_price) VALUES (?, ?, ?)"
);
// Append a price-history row. Call on create, and on update only when the price or
// discount actually changed, so the log stays a meaningful timeline of changes.
async function logPrice(productId, price, salePrice) {
  await insertPriceHistory.run(productId, price, salePrice ?? null);
}
const priceChanged = (before, price, salePrice) =>
  Number(before.price) !== Number(price) || (before.sale_price ?? null) !== (salePrice ?? null);

app.get("/api/products", async (req, res) => {
  // id breaks the tie: the seed inserts every product in the same second, so
  // created_at alone leaves "en yeni" in arbitrary order.
  const products = await db.prepare("SELECT * FROM products ORDER BY created_at DESC, id DESC").all();
  res.json(await decorateProducts(products));
});

app.get("/api/products/:id", async (req, res) => {
  const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });
  res.json(await withColors(product));
});

/* ---------- müşteri değerlendirmeleri ---------- */

// Public: yalnızca onaylanmış yorumlar.
app.get("/api/products/:id/reviews", async (req, res) => {
  res.json(await db.prepare(`
    SELECT id, author_name, rating, comment, created_at
    FROM reviews WHERE product_id = ? AND is_approved = 1
    ORDER BY created_at DESC, id DESC
  `).all(req.params.id));
});

// Public gönderim. is_approved = 0 ile kaydedilir; yayına admin karar verir.
app.post("/api/products/:id/reviews", async (req, res) => {
  const product = await db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });

  const name = req.body.author_name?.trim();
  const rating = toInt(req.body.rating);
  const comment = req.body.comment?.trim() || null;

  if (!name) return res.status(400).json({ error: "Adınızı yazın." });
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Puan 1 ile 5 yıldız arasında olmalıdır." });
  }
  // Serbest metin herkese açık; sınırsız uzunluk moderasyon ekranını kullanılmaz hale getirir.
  if (name.length > 60) return res.status(400).json({ error: "Adınız en fazla 60 karakter olabilir." });
  if (comment && comment.length > 1000) {
    return res.status(400).json({ error: "Yorumunuz en fazla 1000 karakter olabilir." });
  }

  await db.prepare(`
    INSERT INTO reviews (product_id, author_name, rating, comment)
    VALUES (@product_id, @author_name, @rating, @comment)
  `).run({ product_id: product.id, author_name: name, rating, comment });

  res.status(201).json({ ok: true });
});

// Admin: onay bekleyenler dahil hepsi.
app.get("/api/reviews", requireAdmin, async (req, res) => {
  res.json(await db.prepare(`
    SELECT reviews.*, products.name AS product_name
    FROM reviews
    LEFT JOIN products ON products.id = reviews.product_id
    ORDER BY reviews.is_approved ASC, reviews.created_at DESC, reviews.id DESC
  `).all());
});

app.patch("/api/reviews/:id", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM reviews WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Yorum bulunamadı." });
  db.prepare("UPDATE reviews SET is_approved = ? WHERE id = ?")
    .run(req.body.is_approved ? 1 : 0, current.id);
  res.json(await db.prepare("SELECT * FROM reviews WHERE id = ?").get(current.id));
});

app.delete("/api/reviews/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM reviews WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/products/:id/price-history", async (req, res) => {
  const rows = await db.prepare(
    "SELECT id, price, sale_price, changed_at FROM price_history WHERE product_id = ? ORDER BY changed_at DESC, id DESC"
  ).all(req.params.id);
  res.json(rows);
});

app.post("/api/products", requireAdmin, upload.single("image"), async (req, res) => {
  const product = productPayload(req.body, req.file);
  if (!product.name) return res.status(400).json({ error: "Ürün adı zorunludur." });

  const result = await db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path, image_alt, meta_title, meta_description, meta_keywords, is_active)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path, @image_alt, @meta_title, @meta_description, @meta_keywords, @is_active)
  `).run(product);

  setProductColors(result.lastInsertRowid, req.body.color_ids);
  setProductCategories(result.lastInsertRowid, req.body.category_ids);
  await logPrice(result.lastInsertRowid, product.price, product.sale_price);
  res.status(201).json(withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid)));
});

app.put("/api/products/:id", requireAdmin, upload.single("image"), async (req, res) => {
  const current = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Ürün bulunamadı." });
  const product = productPayload({ ...req.body, current_image: current.image_path }, req.file);
  product.id = current.id;

  await db.prepare(`
    UPDATE products SET
      name=@name, sku=@sku, category=@category, description=@description, color=@color,
      price=@price, sale_price=@sale_price, width=@width, height=@height, depth=@depth,
      weight=@weight, stock=@stock, image_path=@image_path, image_alt=@image_alt,
      meta_title=@meta_title, meta_description=@meta_description, meta_keywords=@meta_keywords, is_active=@is_active,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run(product);

  setProductColors(current.id, req.body.color_ids);
  setProductCategories(current.id, req.body.category_ids);
  if (priceChanged(current, product.price, product.sale_price)) {
    await logPrice(current.id, product.price, product.sale_price);
  }
  res.json(withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(current.id)));
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

function heroSlidePayload(body, file) {
  return {
    image_path: resolveImagePath(body, file),
    image_alt: body.image_alt?.trim() || null,
    title: body.title?.trim() || null,
    subtitle: body.subtitle?.trim() || null,
    primary_label: body.primary_label?.trim() || null,
    primary_href: body.primary_href?.trim() || null,
    secondary_label: body.secondary_label?.trim() || null,
    secondary_href: body.secondary_href?.trim() || null,
    sort_order: toInt(body.sort_order),
    is_active: body.is_active === "0" ? 0 : 1
  };
}

// Storefront gets only active slides; an authenticated admin can ask for all of them.
app.get("/api/hero-slides", async (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  const slides = await db.prepare(`
    SELECT * FROM hero_slides
    ${all ? "" : "WHERE is_active = 1"}
    ORDER BY sort_order ASC, id ASC
  `).all();
  res.json(slides);
});

app.post("/api/hero-slides", requireAdmin, upload.single("image"), async (req, res) => {
  const slide = heroSlidePayload(req.body, req.file);
  if (!slide.image_path) return res.status(400).json({ error: "Banner görseli zorunludur (dosya yükleyin veya URL girin)." });

  const result = await db.prepare(`
    INSERT INTO hero_slides (image_path, image_alt, title, subtitle, primary_label, primary_href, secondary_label, secondary_href, sort_order, is_active)
    VALUES (@image_path, @image_alt, @title, @subtitle, @primary_label, @primary_href, @secondary_label, @secondary_href, @sort_order, @is_active)
  `).run(slide);

  res.status(201).json(await db.prepare("SELECT * FROM hero_slides WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/hero-slides/:id", requireAdmin, upload.single("image"), async (req, res) => {
  const current = await db.prepare("SELECT * FROM hero_slides WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Banner görseli bulunamadı." });

  const slide = heroSlidePayload({ ...req.body, current_image: current.image_path }, req.file);
  if (!slide.image_path) return res.status(400).json({ error: "Banner görseli zorunludur (dosya yükleyin veya URL girin)." });
  slide.id = current.id;

  await db.prepare(`
    UPDATE hero_slides SET
      image_path=@image_path, image_alt=@image_alt, title=@title, subtitle=@subtitle,
      primary_label=@primary_label, primary_href=@primary_href,
      secondary_label=@secondary_label, secondary_href=@secondary_href,
      sort_order=@sort_order, is_active=@is_active, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run(slide);

  res.json(await db.prepare("SELECT * FROM hero_slides WHERE id = ?").get(current.id));
});

app.delete("/api/hero-slides/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM hero_slides WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- 3D printing quote: one pricing engine, used by both the live preview and
// the saved quote, so what the customer sees is what the server records.
// "model" is what the customer uploaded (.stl or .3mf); "part_files" are the
// per-part STLs the wizard generates, one per coloured piece, ready for a slicer.
const uploadModel = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safe = path.basename(file.originalname, ext)
        .replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => cb(null, /\.(stl|3mf)$/i.test(file.originalname)),
  limits: { fileSize: 80 * 1024 * 1024, files: 65 }
}).fields([
  { name: "model", maxCount: 1 },
  { name: "part_files", maxCount: 64 }
]);

const pricingSettings = async () => await db.prepare("SELECT * FROM pricing_settings WHERE id = 1").get();

async function priceQuote({ volume_cm3, max_dim_mm, material_id, infill, quantity, color_count }) {
  const settings = await pricingSettings();
  const material = material_id
    ? await db.prepare("SELECT * FROM materials WHERE id = ? AND is_active = 1").get(material_id)
    : null;
  if (!material) return { error: "Malzeme seçilmedi." };

  const volume = Math.max(0, Number(volume_cm3) || 0);
  const maxDim = Math.max(0, Number(max_dim_mm) || 0);
  const infillRatio = Math.min(100, Math.max(0, toInt(infill))) / 100;
  const qty = Math.max(1, toInt(quantity) || 1);

  // The shell is always printed solid, so only the interior scales with infill.
  const usedVolume = volume * (settings.shell_share + (1 - settings.shell_share) * infillRatio);
  const materialFee = usedVolume * material.price_per_cm3;
  const sizeFee = (maxDim / 10) * settings.size_fee_per_cm;
  // Per piece. Setup is charged once per order, and the floor applies to the
  // order total — putting the floor on the unit price would swallow the whole
  // material difference and make every material cost the same.
  const unitPrice = materialFee + sizeFee;

  // Every colour beyond the first means a filament swap on every copy: the purge
  // tower is thrown away and the machine sits there doing it.
  const colors = Math.max(1, toInt(color_count) || 1);
  const colorFee = settings.color_change_fee * (colors - 1) * qty;

  const total = Math.max(settings.min_order_total, settings.setup_fee + unitPrice * qty + colorFee);

  return {
    material: { id: material.id, name: material.name, price_per_cm3: material.price_per_cm3 },
    volume_cm3: volume,
    used_volume_cm3: usedVolume,
    infill: Math.round(infillRatio * 100),
    quantity: qty,
    setup_fee: settings.setup_fee,
    material_fee: materialFee,
    size_fee: sizeFee,
    unit_price: unitPrice,
    color_count: colors,
    color_change_fee: settings.color_change_fee,
    color_fee: colorFee,
    min_order_total: settings.min_order_total,
    total
  };
}

app.get("/api/materials", async (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  res.json(await db.prepare(`
    SELECT * FROM materials
    ${all ? "" : "WHERE is_active = 1"}
    ORDER BY sort_order ASC, id ASC
  `).all());
});

function materialPayload(body) {
  return {
    name: body.name?.trim(),
    description: body.description?.trim() || null,
    price_per_cm3: Math.max(0, Number(body.price_per_cm3) || 0),
    sort_order: toInt(body.sort_order),
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.post("/api/materials", requireAdmin, async (req, res) => {
  const material = materialPayload(req.body);
  if (!material.name) return res.status(400).json({ error: "Malzeme adı zorunludur." });
  const result = await db.prepare(`
    INSERT INTO materials (name, description, price_per_cm3, sort_order, is_active)
    VALUES (@name, @description, @price_per_cm3, @sort_order, @is_active)
  `).run(material);
  res.status(201).json(await db.prepare("SELECT * FROM materials WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/materials/:id", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM materials WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Malzeme bulunamadı." });
  const material = materialPayload(req.body);
  if (!material.name) return res.status(400).json({ error: "Malzeme adı zorunludur." });
  material.id = current.id;
  await db.prepare(`
    UPDATE materials SET name=@name, description=@description, price_per_cm3=@price_per_cm3,
      sort_order=@sort_order, is_active=@is_active WHERE id=@id
  `).run(material);
  res.json(await db.prepare("SELECT * FROM materials WHERE id = ?").get(current.id));
});

app.delete("/api/materials/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM materials WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/pricing", requireAdmin, async (req, res) => res.json(await pricingSettings()));

app.put("/api/pricing", requireAdmin, async (req, res) => {
  const shell = Number(req.body.shell_share);
  await db.prepare(`
    UPDATE pricing_settings SET
      setup_fee=@setup_fee, size_fee_per_cm=@size_fee_per_cm,
      min_order_total=@min_order_total, shell_share=@shell_share,
      color_change_fee=@color_change_fee, tax_rate=@tax_rate, updated_at=CURRENT_TIMESTAMP
    WHERE id=1
  `).run({
    setup_fee: Math.max(0, Number(req.body.setup_fee) || 0),
    size_fee_per_cm: Math.max(0, Number(req.body.size_fee_per_cm) || 0),
    min_order_total: Math.max(0, Number(req.body.min_order_total) || 0),
    shell_share: Math.min(1, Math.max(0, Number.isFinite(shell) ? shell : 0.15)),
    color_change_fee: Math.max(0, Number(req.body.color_change_fee) || 0),
    tax_rate: Math.min(100, Math.max(0, Number(req.body.tax_rate) ?? 20))
  });
  res.json(await pricingSettings());
});

// Live price for the wizard. The browser never computes the price itself.
app.post("/api/quote-price", async (req, res) => {
  const price = await priceQuote(req.body);
  if (price.error) return res.status(400).json({ error: price.error });
  res.json(price);
});

/* Supabase yapılandırılmışsa dosyalar tarayıcıdan doğrudan Storage'a yüklenmiş
   olur ve burada yalnızca anahtarları gelir; multer devreye girmez. Yerel
   geliştirmede eski davranış (diske yükleme) korunur. */
/* Depolama açıkken dosyalar zaten yüklenmiş olur, ama form hâlâ multipart olarak
   gelir. Multer'ı tamamen atlarsak hiçbir şey multipart'ı çözmez ve req.body boş
   kalır — "Ad soyad zorunludur" hatası buradan çıkıyordu. .none() dosya kabul
   etmez ama metin alanlarını ayrıştırır. */
const textFieldsOnly = multer().none();
const modelUploadMiddleware = (req, res, next) =>
  (storage.enabled ? textFieldsOnly(req, res, next) : uploadModel(req, res, next));

app.post("/api/quotes", modelUploadMiddleware, async (req, res) => {
  const body = req.body;
  const modelFile = req.files?.model?.[0] || null;
  const partFiles = req.files?.part_files || [];

  // Doğrudan yüklemede tarayıcı yalnızca anahtar gönderir.
  const uploadedModel = typeof body.model_path === "string" ? body.model_path : null;
  let uploadedParts = [];
  try {
    uploadedParts = JSON.parse(body.part_paths || "[]");
    if (!Array.isArray(uploadedParts)) uploadedParts = [];
  } catch { uploadedParts = []; }
  if (!body.customer_name?.trim()) return res.status(400).json({ error: "Ad soyad zorunludur." });
  if (!body.email?.trim() && !body.phone?.trim()) {
    return res.status(400).json({ error: "E-posta veya telefon bilgisi gereklidir." });
  }

  // The wizard posts one entry per disconnected part of the STL, each with its
  // own colour. A single-part model simply yields one entry.
  let parts = [];
  try {
    parts = JSON.parse(body.parts || "[]");
  } catch {
    parts = [];
  }
  if (!Array.isArray(parts)) parts = [];

  // Colour count is derived from the parts, never taken from the browser.
  const distinctColors = new Set(parts.map((part) => part.color_id).filter(Boolean));

  // Recomputed here on purpose: a price posted by the browser is never trusted.
  const price = await priceQuote({ ...body, color_count: Math.max(1, distinctColors.size) });
  if (price.error) return res.status(400).json({ error: price.error });

  const primaryColorId = parts[0]?.color_id || body.color_id || null;
  const color = primaryColorId ? await db.prepare("SELECT * FROM colors WHERE id = ?").get(primaryColorId) : null;
  const quoteNumber = `TKF-${Date.now().toString().slice(-8)}`;

  const result = await db.prepare(`
    INSERT INTO quotes (quote_number, customer_name, email, phone, note, file_name, file_path,
      width, height, depth, volume_cm3, material_id, material_name, color_id, color_name,
      infill, quantity, unit_price, total, painted)
    VALUES (@quote_number, @customer_name, @email, @phone, @note, @file_name, @file_path,
      @width, @height, @depth, @volume_cm3, @material_id, @material_name, @color_id, @color_name,
      @infill, @quantity, @unit_price, @total, @painted)
  `).run({
    quote_number: quoteNumber,
    customer_name: body.customer_name.trim(),
    email: body.email?.trim() || null,
    phone: body.phone?.trim() || null,
    note: body.note?.trim() || null,
    file_name: modelFile?.originalname || body.model_name?.trim() || null,
    // Supabase'de: gizli kovadaki anahtar. Yerelde: /uploads/... yolu.
    file_path: uploadedModel || (modelFile ? `/uploads/${modelFile.filename}` : null),
    width: nullableMoney(body.width),
    height: nullableMoney(body.height),
    depth: nullableMoney(body.depth),
    volume_cm3: price.volume_cm3,
    material_id: price.material.id,
    material_name: price.material.name,
    color_id: color?.id || null,
    color_name: color?.name || null,
    infill: price.infill,
    quantity: price.quantity,
    unit_price: price.unit_price,
    total: price.total,
    painted: body.painted === "1" ? 1 : 0
  });

  // Renkler transaction dışında okunuyor: salt-okunur sorgular yazma
  // transaction'ını gereksiz yere uzun tutmasın.
  const partColors = await Promise.all(parts.map((part) => (part.color_id
    ? db.prepare("SELECT * FROM colors WHERE id = ?").get(part.color_id)
    : Promise.resolve(null))));

  await db.transaction(async (tx) => {
    const insertPart = tx.prepare(`
      INSERT INTO quote_parts (quote_id, part_index, name, volume_cm3, color_id, color_name, color_hex, file_path)
      VALUES (@quote_id, @part_index, @name, @volume_cm3, @color_id, @color_name, @color_hex, @file_path)
    `);
    for (const [index, part] of parts.entries()) {
      const partColor = partColors[index];
      // part_files arrive in the same order as parts.
      const file = partFiles[index];
      await insertPart.run({
        quote_id: result.lastInsertRowid,
        part_index: index + 1,
        name: part.name?.trim() || null,
        volume_cm3: Math.max(0, Number(part.volume_cm3) || 0),
        color_id: partColor?.id || null,
        color_name: partColor?.name || null,
        color_hex: partColor?.hex || null,
        file_path: uploadedParts[index] || (file ? `/uploads/${file.filename}` : null)
      });
    }
  });

  res.status(201).json(await withParts(await db.prepare("SELECT * FROM quotes WHERE id = ?").get(result.lastInsertRowid)));
});

const partsOfQuote = db.prepare("SELECT * FROM quote_parts WHERE quote_id = ? ORDER BY part_index");
/* Müşteri dosyaları gizli kovada durur — herkese açık bir adresleri yoktur.
   Admin listesine süreli imzalı indirme adresleri eklenir. Yerel geliştirmede
   yollar zaten /uploads/... olduğu için olduğu gibi bırakılır. */
const isStorageKey = (value) => Boolean(value) && !String(value).startsWith("/uploads/");

const withParts = async (quote) => {
  const parts = await partsOfQuote.all(quote.id);
  if (!storage.enabled) return { ...quote, parts };
  return {
    ...quote,
    download_url: isStorageKey(quote.file_path) ? await storage.signedModelUrl(quote.file_path) : quote.file_path,
    parts: await Promise.all(parts.map(async (part) => ({
      ...part,
      download_url: isStorageKey(part.file_path) ? await storage.signedModelUrl(part.file_path) : part.file_path
    })))
  };
};

app.get("/api/quotes", requireAdmin, async (req, res) => {
  const quotes = await db.prepare("SELECT * FROM quotes ORDER BY created_at DESC").all();
  res.json(await Promise.all(quotes.map(withParts)));
});

app.patch("/api/quotes/:id", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM quotes WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Teklif bulunamadı." });
  await db.prepare("UPDATE quotes SET status=@status WHERE id=@id").run({
    id: current.id,
    status: req.body.status || current.status
  });
  res.json(await db.prepare("SELECT * FROM quotes WHERE id = ?").get(current.id));
});

app.delete("/api/quotes/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM quotes WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/colors", async (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  res.json(await db.prepare(`
    SELECT * FROM colors
    ${all ? "" : "WHERE is_active = 1"}
    ORDER BY sort_order ASC, id ASC
  `).all());
});

const HEX = /^#[0-9a-f]{6}$/i;

function colorPayload(body) {
  const hex = body.hex?.trim().toLowerCase();
  return {
    name: body.name?.trim(),
    hex: HEX.test(hex) ? hex : null,
    sort_order: toInt(body.sort_order),
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.post("/api/colors", requireAdmin, async (req, res) => {
  const color = colorPayload(req.body);
  if (!color.name) return res.status(400).json({ error: "Renk adı zorunludur." });
  if (!color.hex) return res.status(400).json({ error: "Geçerli bir renk kodu seçin (#rrggbb)." });

  const result = await db.prepare(`
    INSERT INTO colors (name, hex, sort_order, is_active)
    VALUES (@name, @hex, @sort_order, @is_active)
  `).run(color);

  res.status(201).json(await db.prepare("SELECT * FROM colors WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/colors/:id", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM colors WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Renk bulunamadı." });

  const color = colorPayload(req.body);
  if (!color.name) return res.status(400).json({ error: "Renk adı zorunludur." });
  if (!color.hex) return res.status(400).json({ error: "Geçerli bir renk kodu seçin (#rrggbb)." });
  color.id = current.id;

  await db.prepare("UPDATE colors SET name=@name, hex=@hex, sort_order=@sort_order, is_active=@is_active WHERE id=@id").run(color);
  res.json(await db.prepare("SELECT * FROM colors WHERE id = ?").get(current.id));
});

// The join rows go with it (ON DELETE CASCADE), so products lose the swatch too.
app.delete("/api/colors/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM colors WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

function categoryPayload(body, file) {
  return {
    name: body.name?.trim(),
    image_path: resolveImagePath(body, file),
    image_alt: body.image_alt?.trim() || null,
    href: body.href?.trim() || "#store-products",
    sort_order: toInt(body.sort_order),
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.get("/api/categories", async (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  res.json(await db.prepare(`
    SELECT * FROM categories
    ${all ? "" : "WHERE is_active = 1"}
    ORDER BY sort_order ASC, id ASC
  `).all());
});

app.post("/api/categories", requireAdmin, upload.single("image"), async (req, res) => {
  const category = categoryPayload(req.body, req.file);
  if (!category.name) return res.status(400).json({ error: "Kategori adı zorunludur." });

  const result = await db.prepare(`
    INSERT INTO categories (name, image_path, image_alt, href, sort_order, is_active)
    VALUES (@name, @image_path, @image_alt, @href, @sort_order, @is_active)
  `).run(category);

  res.status(201).json(await db.prepare("SELECT * FROM categories WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/categories/:id", requireAdmin, upload.single("image"), async (req, res) => {
  const current = await db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Kategori bulunamadı." });

  const category = categoryPayload({ ...req.body, current_image: current.image_path }, req.file);
  if (!category.name) return res.status(400).json({ error: "Kategori adı zorunludur." });
  category.id = current.id;

  await db.prepare(`
    UPDATE categories SET
      name=@name, image_path=@image_path, image_alt=@image_alt, href=@href,
      sort_order=@sort_order, is_active=@is_active, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run(category);

  res.json(await db.prepare("SELECT * FROM categories WHERE id = ?").get(current.id));
});

app.delete("/api/categories/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM categories WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/seo", requireAdmin, async (req, res) => {
  res.json({
    pages: await db.prepare("SELECT * FROM seo_pages ORDER BY id").all(),
    site: await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {}
  });
});

app.put("/api/seo/pages/:slug", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM seo_pages WHERE slug = ?").get(req.params.slug);
  if (!current) return res.status(404).json({ error: "Sayfa bulunamadı." });

  await db.prepare(`
    UPDATE seo_pages SET
      title=@title, description=@description, canonical=@canonical,
      og_title=@og_title, og_description=@og_description, og_image=@og_image,
      robots=@robots, updated_at=CURRENT_TIMESTAMP
    WHERE slug=@slug
  `).run({
    slug: current.slug,
    title: req.body.title?.trim() || null,
    description: req.body.description?.trim() || null,
    canonical: req.body.canonical?.trim() || null,
    og_title: req.body.og_title?.trim() || null,
    og_description: req.body.og_description?.trim() || null,
    og_image: req.body.og_image?.trim() || null,
    robots: req.body.robots?.trim() || "index,follow"
  });

  res.json(await db.prepare("SELECT * FROM seo_pages WHERE slug = ?").get(current.slug));
});

app.put("/api/seo/site", requireAdmin, async (req, res) => {
  await db.prepare(`
    UPDATE site_settings SET
      site_name=@site_name, site_url=@site_url, description=@description,
      logo_path=@logo_path, social_links=@social_links, default_og_image=@default_og_image,
      phone=@phone, email=@email, whatsapp=@whatsapp, contact_address=@contact_address, working_hours=@working_hours,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=1
  `).run({
    site_name: req.body.site_name?.trim() || null,
    site_url: req.body.site_url?.trim().replace(/\/$/, "") || null,
    description: req.body.description?.trim() || null,
    logo_path: req.body.logo_path?.trim() || null,
    social_links: req.body.social_links?.trim() || null,
    default_og_image: req.body.default_og_image?.trim() || null,
    phone: req.body.phone?.trim() || null,
    email: req.body.email?.trim() || null,
    whatsapp: req.body.whatsapp?.trim() || null,
    contact_address: req.body.contact_address?.trim() || null,
    working_hours: req.body.working_hours?.trim() || null
  });

  res.json(await db.prepare("SELECT * FROM site_settings WHERE id = 1").get());
});

app.get("/api/customers", requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all());
});

app.post("/api/customers", async (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ error: "Müşteri adı zorunludur." });
  const result = await db.prepare(`
    INSERT INTO customers (name, email, phone, address, city, notes)
    VALUES (@name, @email, @phone, @address, @city, @notes)
  `).run({
    name: req.body.name.trim(),
    email: req.body.email?.trim() || null,
    phone: req.body.phone?.trim() || null,
    address: req.body.address?.trim() || null,
    city: req.body.city?.trim() || null,
    notes: req.body.notes?.trim() || null
  });
  res.status(201).json(await db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid));
});

app.get("/api/orders", requireAdmin, async (req, res) => {
  const orders = await db.prepare(`
    SELECT orders.*, customers.name customer_name, customers.email customer_email
    FROM orders
    JOIN customers ON customers.id = orders.customer_id
    ORDER BY orders.created_at DESC
  `).all();

  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?");
  res.json(await Promise.all(
    orders.map(async (order) => ({ ...order, items: await items.all(order.id) }))
  ));
});

app.post("/api/orders", async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!req.body.customer_id) return res.status(400).json({ error: "Müşteri seçimi zorunludur." });
  if (!items.length) return res.status(400).json({ error: "En az bir sipariş ürünü gereklidir." });

  // Ürünleri transaction'dan önce oku: salt-okunur sorgular yazma kilidini tutmasın.
  const normalized = await Promise.all(items.map(async (item) => {
    const product = item.product_id
      ? await db.prepare("SELECT * FROM products WHERE id = ?").get(item.product_id)
      : null;
    const quantity = Math.max(1, toInt(item.quantity));
    const unitPrice = money(item.unit_price || product?.sale_price || product?.price);
    return {
      product_id: product?.id || null,
      product_name: product?.name || item.product_name || "Özel ürün",
      quantity,
      unit_price: unitPrice,
      line_total: quantity * unitPrice
    };
  }));

  const subtotal = normalized.reduce((sum, item) => sum + item.line_total, 0);
  const discount = money(req.body.discount);
  const total = Math.max(0, subtotal - discount);
  const orderNumber = `PRN-${Date.now().toString().slice(-8)}`;

  const id = await db.transaction(async (tx) => {
    const result = await tx.prepare(`
      INSERT INTO orders (order_number, customer_id, status, payment_status, shipping_address, tracking_code, subtotal, discount, total, notes)
      VALUES (@order_number, @customer_id, @status, @payment_status, @shipping_address, @tracking_code, @subtotal, @discount, @total, @notes)
    `).run({
      order_number: orderNumber,
      customer_id: toInt(req.body.customer_id),
      status: req.body.status || "new",
      payment_status: req.body.payment_status || "pending",
      shipping_address: req.body.shipping_address || null,
      tracking_code: req.body.tracking_code || null,
      subtotal,
      discount,
      total,
      notes: req.body.notes || null
    });

    const insertItem = tx.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
      VALUES (@order_id, @product_id, @product_name, @quantity, @unit_price, @line_total)
    `);
    for (const item of normalized) await insertItem.run({ ...item, order_id: result.lastInsertRowid });
    return result.lastInsertRowid;
  });

  res.status(201).json(await db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
});

/* ---------- kampanya motoru ----------
   Tüm hesaplama burada, sunucuda yapılır. Tarayıcı yalnızca sepeti ve varsa kupon
   kodunu gönderir; gönderdiği hiçbir indirim tutarına güvenilmez. */

// money() burada Number()'dan ibaret; yüzde hesabı 0.30000000000000004 gibi
// artıklar üretir ve bu tutar müşteriye gösterilip siparişe yazılıyor.
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const campaignProductIds = db.prepare("SELECT product_id FROM campaign_products WHERE campaign_id = ?");
const campaignCategoryIds = db.prepare("SELECT category_id FROM campaign_categories WHERE campaign_id = ?");
const categoryIdsOfProduct = db.prepare("SELECT category_id FROM product_categories WHERE product_id = ?");

// Aktif, tarihi geçmemiş ve kullanım limiti dolmamış kampanyalar.
async function liveCampaigns() {
  return await db.prepare(`
    SELECT * FROM campaigns
    WHERE is_active = 1
      AND (starts_at IS NULL OR starts_at::date <= CURRENT_DATE)
      AND (ends_at   IS NULL OR ends_at::date   >= CURRENT_DATE)
      AND (usage_limit IS NULL OR used_count < usage_limit)
    ORDER BY id ASC
  `).all();
}

// Kampanyanın kapsadığı sepet satırları.
async function eligibleItems(campaign, items) {
  if (campaign.scope === "products") {
    const rows = await campaignProductIds.all(campaign.id);
    const ids = new Set(rows.map((r) => r.product_id));
    return items.filter((item) => ids.has(item.product_id));
  }
  if (campaign.scope === "categories") {
    const rows = await campaignCategoryIds.all(campaign.id);
    const wanted = new Set(rows.map((r) => r.category_id));
    // filter() asenkron bir koşul kabul etmez — Promise döner ve her zaman
    // "doğru" sayılır, yani kampanya kapsam dışı ürünlere de uygulanırdı.
    // Önce eşleşmeleri topla, sonra sıraya göre filtrele.
    const matches = await Promise.all(items.map(async (item) => {
      if (!item.product_id) return false;
      const cats = await categoryIdsOfProduct.all(item.product_id);
      return cats.some((r) => wanted.has(r.category_id));
    }));
    return items.filter((_, index) => matches[index]);
  }
  return items;
}

const campaignLabel = (campaign) => campaign.kind === "gift"
  ? `${campaign.name} (hediye)`
  : campaign.discount_type === "percent"
    ? `${campaign.name} (%${campaign.discount_value})`
    : `${campaign.name} (${money(campaign.discount_value)} TL)`;

// Bir kampanyanın bu sepete uygulanıp uygulanmadığı + tutarı.
async function evaluateOne(campaign, items) {
  const eligible = await eligibleItems(campaign, items);
  if (!eligible.length) return null;

  const quantity = eligible.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = eligible.reduce((sum, item) => sum + item.line_total, 0);
  if (campaign.min_quantity && quantity < campaign.min_quantity) return null;
  if (campaign.min_order_total && subtotal < campaign.min_order_total) return null;

  if (campaign.kind === "gift") {
    const gift = campaign.gift_product_id
      ? await db.prepare("SELECT id, name FROM products WHERE id = ?").get(campaign.gift_product_id)
      : null;
    if (!gift) return null;
    // Temiz ad: "(Hediye)" son ekini yalnızca sipariş kalemi eklerken koyuyoruz,
    // yoksa ödeme özetinde "… (Hediye) — Hediye" diye iki kez yazıyor.
    return {
      campaign,
      discount: 0,
      gift: { product_id: gift.id, product_name: gift.name, quantity: Math.max(1, campaign.gift_quantity) },
      label: campaignLabel(campaign)
    };
  }

  // Sabit indirim kapsadığı tutarı aşamaz, yoksa sipariş eksiye düşer.
  const raw = campaign.discount_type === "percent"
    ? subtotal * (campaign.discount_value / 100)
    : Math.min(campaign.discount_value, subtotal);
  const discount = round2(raw);
  if (discount <= 0) return null;
  return { campaign, discount, gift: null, label: campaignLabel(campaign) };
}

/* Sepete uygulanacak her şeyi döndürür.
   code verilmişse ve geçersizse `error` dolar — otomatik kampanyalar yine uygulanır,
   çünkü yanlış yazılmış bir kupon hak edilmiş bir indirimi iptal etmemeli. */
async function evaluateCampaigns(items, code) {
  const typed = String(code || "").trim().toUpperCase();
  const live = await liveCampaigns();
  const applied = [];
  const gifts = [];
  let discount = 0;
  let error = null;

  // 1) Otomatik kampanyalar (kodu olmayanlar). Sırayla: discount toplamı
  //    paylaşılan bir değişken, paralel çalıştırmak yarış koşulu yaratır.
  for (const campaign of live.filter((c) => !c.code)) {
    const result = await evaluateOne(campaign, items);
    if (!result) continue;
    discount += result.discount;
    if (result.gift) gifts.push(result.gift);
    applied.push({ id: campaign.id, name: campaign.name, label: result.label, amount: result.discount, kind: campaign.kind });
  }

  // 2) Kupon kodu — sepette yalnızca bir tane geçerli olur.
  if (typed) {
    const coupon = live.find((c) => (c.code || "").toUpperCase() === typed);
    if (!coupon) {
      // Kodun neden çalışmadığını ayırt et: hiç yok mu, süresi/limiti mi dolmuş.
      const known = await db.prepare("SELECT * FROM campaigns WHERE UPPER(code) = ?").get(typed);
      error = known ? "Bu kampanya kodunun süresi dolmuş veya kullanım hakkı bitmiş." : "Kampanya kodu geçersiz.";
    } else {
      const result = await evaluateOne(coupon, items);
      if (!result) {
        error = coupon.min_quantity
          ? `Bu kod için kapsamdaki ürünlerden en az ${coupon.min_quantity} adet almalısınız.`
          : coupon.min_order_total
            ? `Bu kod ${money(coupon.min_order_total)} TL ve üzeri alışverişlerde geçerli.`
            : "Bu kod sepetinizdeki ürünler için geçerli değil.";
      } else {
        discount += result.discount;
        if (result.gift) gifts.push(result.gift);
        applied.push({ id: coupon.id, name: coupon.name, code: coupon.code, label: result.label, amount: result.discount, kind: coupon.kind });
      }
    }
  }

  const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
  // Toplam indirim sepeti aşamaz — birden çok kampanya üst üste binerse sipariş eksiye düşerdi.
  return { discount: round2(Math.min(discount, subtotal)), gifts, applied, error };
}

// Sepet satırlarını ürün tablosundan yeniden fiyatlar — istemciden gelen fiyat yok sayılır.
async function normalizeCartItems(items) {
  return Promise.all((Array.isArray(items) ? items : []).map(async (item) => {
    const product = item.product_id
      ? await db.prepare("SELECT * FROM products WHERE id = ?").get(item.product_id)
      : null;
    const quantity = Math.max(1, toInt(item.quantity));
    const unitPrice = money(product?.sale_price || product?.price || item.unit_price);
    return {
      product_id: product?.id || null,
      product_name: product?.name || item.product_name || "Ürün",
      quantity,
      unit_price: unitPrice,
      line_total: money(quantity * unitPrice)
    };
  }));
}

// Ödeme sayfasının önizlemesi. Burada dönen tutar bilgilendirmedir; sipariş
// oluşturulurken /api/checkout aynı motoru yeniden çalıştırır.
app.post("/api/campaigns/preview", async (req, res) => {
  const items = await normalizeCartItems(req.body.items);
  if (!items.length) return res.json({ discount: 0, gifts: [], applied: [], error: null, incentives: [] });
  const result = await evaluateCampaigns(items, req.body.code);
  res.json({ ...result, incentives: await incentiveHints(items) });
});

/* "Şu kadar daha ekle, şunu kazan" mesajları — henüz tutmayan ama az kalan
   otomatik kampanyalar. Satışı artıran asıl kısım bu. */
async function incentiveHints(items) {
  const live = await liveCampaigns();
  const hints = await Promise.all(live.filter((c) => !c.code).map(async (campaign) => {
    if (await evaluateOne(campaign, items)) return null;      // zaten kazanılmış
    const eligible = await eligibleItems(campaign, items);
    if (!eligible.length) return null;                   // kapsam sepette yok
    const quantity = eligible.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = eligible.reduce((sum, item) => sum + item.line_total, 0);

    if (campaign.min_quantity && quantity < campaign.min_quantity) {
      const need = campaign.min_quantity - quantity;
      return { text: `${need} adet daha ekleyin, ${campaignLabel(campaign)} kazanın.` };
    }
    if (campaign.min_order_total && subtotal < campaign.min_order_total) {
      const need = money(campaign.min_order_total - subtotal);
      return { text: `${need} TL daha ekleyin, ${campaignLabel(campaign)} kazanın.` };
    }
    return null;
  }));
  return hints.filter(Boolean);
}

/* ---------- kampanya yönetimi (admin) ---------- */

const campaignWithTargets = async (campaign) => ({
  ...campaign,
  product_ids: (await campaignProductIds.all(campaign.id)).map((r) => r.product_id),
  category_ids: (await campaignCategoryIds.all(campaign.id)).map((r) => r.category_id)
});

app.get("/api/campaigns", requireAdmin, async (req, res) => {
  const rows = await db.prepare("SELECT * FROM campaigns ORDER BY is_active DESC, id DESC").all();
  res.json(await Promise.all(rows.map(campaignWithTargets)));
});

function campaignPayload(body) {
  const kind = body.kind === "gift" ? "gift" : "discount";
  const scope = ["all", "products", "categories"].includes(body.scope) ? body.scope : "all";
  return {
    name: body.name?.trim(),
    // Boş kod = otomatik kampanya. UNIQUE olduğu için "" yerine NULL şart.
    code: body.code?.trim().toUpperCase() || null,
    kind,
    discount_type: body.discount_type === "fixed" ? "fixed" : "percent",
    discount_value: kind === "gift" ? 0 : money(body.discount_value),
    scope,
    min_quantity: Math.max(0, toInt(body.min_quantity)),
    min_order_total: money(body.min_order_total),
    gift_product_id: kind === "gift" ? toInt(body.gift_product_id) || null : null,
    gift_quantity: Math.max(1, toInt(body.gift_quantity) || 1),
    starts_at: body.starts_at?.trim() || null,
    ends_at: body.ends_at?.trim() || null,
    usage_limit: toInt(body.usage_limit) || null,
    is_active: body.is_active === false || body.is_active === "false" ? 0 : 1
  };
}

function validateCampaign(payload) {
  if (!payload.name) return "Kampanya adı zorunludur.";
  if (payload.kind === "gift" && !payload.gift_product_id) return "Hediye kampanyası için hediye ürünü seçin.";
  if (payload.kind === "discount" && !(payload.discount_value > 0)) return "İndirim değeri sıfırdan büyük olmalıdır.";
  if (payload.kind === "discount" && payload.discount_type === "percent" && payload.discount_value > 100) {
    return "Yüzde indirim 100'den büyük olamaz.";
  }
  if (payload.starts_at && payload.ends_at && payload.ends_at < payload.starts_at) {
    return "Bitiş tarihi başlangıç tarihinden önce olamaz.";
  }
  return null;
}

async function setCampaignTargets(campaignId, body) {
  await db.prepare("DELETE FROM campaign_products WHERE campaign_id = ?").run(campaignId);
  await db.prepare("DELETE FROM campaign_categories WHERE campaign_id = ?").run(campaignId);
  const link = async (table, column, values) => {
    const stmt = db.prepare(`INSERT INTO ${table} (campaign_id, ${column}) VALUES (?, ?) ON CONFLICT DO NOTHING`);
    const ids = [].concat(values ?? []).map((v) => toInt(v)).filter(Boolean);
    for (const id of ids) await stmt.run(campaignId, id);
  };
  await link("campaign_products", "product_id", body.product_ids);
  await link("campaign_categories", "category_id", body.category_ids);
}

app.post("/api/campaigns", requireAdmin, async (req, res) => {
  const payload = campaignPayload(req.body);
  const problem = validateCampaign(payload);
  if (problem) return res.status(400).json({ error: problem });
  if (payload.code && await db.prepare("SELECT id FROM campaigns WHERE UPPER(code) = ?").get(payload.code)) {
    return res.status(400).json({ error: "Bu kampanya kodu zaten kullanılıyor." });
  }

  const result = await db.prepare(`
    INSERT INTO campaigns (name, code, kind, discount_type, discount_value, scope, min_quantity,
      min_order_total, gift_product_id, gift_quantity, starts_at, ends_at, usage_limit, is_active)
    VALUES (@name, @code, @kind, @discount_type, @discount_value, @scope, @min_quantity,
      @min_order_total, @gift_product_id, @gift_quantity, @starts_at, @ends_at, @usage_limit, @is_active)
  `).run(payload);
  await setCampaignTargets(result.lastInsertRowid, req.body);

  const id = result.lastInsertRowid;
  res.status(201).json(await campaignWithTargets(await db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id)));
});

app.put("/api/campaigns/:id", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Kampanya bulunamadı." });
  const payload = campaignPayload(req.body);
  const problem = validateCampaign(payload);
  if (problem) return res.status(400).json({ error: problem });
  const clash = payload.code && await db.prepare("SELECT id FROM campaigns WHERE UPPER(code) = ? AND id <> ?").get(payload.code, current.id);
  if (clash) return res.status(400).json({ error: "Bu kampanya kodu zaten kullanılıyor." });

  await db.prepare(`
    UPDATE campaigns SET name=@name, code=@code, kind=@kind, discount_type=@discount_type,
      discount_value=@discount_value, scope=@scope, min_quantity=@min_quantity,
      min_order_total=@min_order_total, gift_product_id=@gift_product_id, gift_quantity=@gift_quantity,
      starts_at=@starts_at, ends_at=@ends_at, usage_limit=@usage_limit, is_active=@is_active
    WHERE id=@id
  `).run({ ...payload, id: current.id });
  await setCampaignTargets(current.id, req.body);

  res.json(await campaignWithTargets(await db.prepare("SELECT * FROM campaigns WHERE id = ?").get(current.id)));
});

app.delete("/api/campaigns/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM campaigns WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Turkish national ID (TC Kimlik No): 11 digits with two trailing checksum digits.
function isValidTC(value) {
  const tc = String(value || "").trim();
  if (!/^[1-9][0-9]{10}$/.test(tc)) return false;
  const d = tc.split("").map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  if ((((oddSum * 7) - evenSum) % 10 + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}
const isValidVKN = (value) => /^[0-9]{10}$/.test(String(value || "").trim());

// One-shot checkout: create the customer, validate the e-fatura details, price the
// items server-side (never trusting client prices), and write the order atomically.
app.post("/api/checkout", async (req, res) => {
  const body = req.body || {};
  const customer = body.customer || {};
  const invoice = body.invoice || {};
  const items = Array.isArray(body.items) ? body.items : [];

  if (!customer.name?.trim()) return res.status(400).json({ error: "Ad soyad zorunludur." });
  if (!customer.phone?.trim()) return res.status(400).json({ error: "Telefon numarası zorunludur." });
  if (!customer.city?.trim()) return res.status(400).json({ error: "İl zorunludur." });
  if (!customer.district?.trim()) return res.status(400).json({ error: "İlçe zorunludur." });
  if (!customer.address?.trim()) return res.status(400).json({ error: "Açık adres zorunludur." });
  if (!items.length) return res.status(400).json({ error: "Sepetiniz boş." });

  const invoiceType = invoice.type === "corporate" ? "corporate" : "individual";
  if (invoiceType === "individual") {
    if (!isValidTC(invoice.tc_no)) return res.status(400).json({ error: "Geçerli bir TC Kimlik Numarası girin." });
  } else {
    if (!invoice.company_name?.trim()) return res.status(400).json({ error: "Şirket unvanı zorunludur." });
    if (!invoice.tax_office?.trim()) return res.status(400).json({ error: "Vergi dairesi zorunludur." });
    if (!isValidVKN(invoice.tax_number)) return res.status(400).json({ error: "Geçerli bir vergi numarası girin (10 hane)." });
  }

  const paymentMethod = ["havale", "kapida", "kart"].includes(body.payment_method) ? body.payment_method : "havale";

  // Fiyatlama ve kampanya hesabı transaction'dan ÖNCE: bunlar salt-okunur
  // sorgular, yazma kilidini gereksiz yere tutmasınlar.
  const normalized = await normalizeCartItems(items);
  const subtotal = round2(normalized.reduce((sum, item) => sum + item.line_total, 0));

  // Kampanyalar burada yeniden hesaplanır; tarayıcının gönderdiği indirim yok sayılır.
  const campaigns = await evaluateCampaigns(normalized, body.coupon_code);
  const discount = Math.min(campaigns.discount, subtotal);
  const netTotal = round2(subtotal - discount);

  // Prices are KDV-hariç (net); VAT is added on top — and on the *discounted*
  // net, not the original. Shipping is recipient-paid, so it is not added.
  const taxRate = (await pricingSettings())?.tax_rate ?? KDV_RATE;

  const orderNumber = await db.transaction(async (tx) => {
    const cust = await tx.prepare("INSERT INTO customers (name, email, phone, address, city) VALUES (?,?,?,?,?)").run(
      customer.name.trim(), customer.email?.trim() || null, customer.phone.trim(), customer.address.trim(), customer.city?.trim() || null
    );

    const taxAmount = round2(netTotal * taxRate / 100);
    const grandTotal = round2(netTotal + taxAmount);
    // Compose the structured address (mahalle / ilçe / il / posta kodu) into one line.
    const locality = [
      customer.neighborhood?.trim() && `${customer.neighborhood.trim()} Mah.`,
      [customer.district?.trim(), customer.city?.trim()].filter(Boolean).join("/"),
      customer.postal_code?.trim()
    ].filter(Boolean).join(" ");
    const shippingAddress = [customer.address.trim(), locality].filter(Boolean).join(" — ");
    const billingAddress = invoice.same_as_shipping === false && invoice.billing_address?.trim()
      ? invoice.billing_address.trim()
      : shippingAddress;
    const generatedNumber = `PRN-${Date.now().toString().slice(-8)}`;

    const order = await tx.prepare(`
      INSERT INTO orders (order_number, customer_id, status, payment_status, shipping_address, subtotal, discount, total, notes,
        invoice_type, tc_no, tax_office, tax_number, company_name, billing_address, payment_method,
        tax_rate, tax_amount, shipping_method, campaign_summary)
      VALUES (@order_number, @customer_id, 'new', 'pending', @shipping_address, @subtotal, @discount, @total, @notes,
        @invoice_type, @tc_no, @tax_office, @tax_number, @company_name, @billing_address, @payment_method,
        @tax_rate, @tax_amount, 'recipient_paid', @campaign_summary)
    `).run({
      order_number: generatedNumber,
      customer_id: cust.lastInsertRowid,
      shipping_address: shippingAddress,
      subtotal,
      discount,
      // Kampanya sonradan silinse bile siparişte ne uygulandığı okunabilir kalsın.
      campaign_summary: campaigns.applied.length
        ? campaigns.applied.map((c) => c.label).join(" · ")
        : null,
      total: grandTotal,
      notes: body.notes?.trim() || null,
      invoice_type: invoiceType,
      tc_no: invoiceType === "individual" ? String(invoice.tc_no).trim() : null,
      tax_office: invoiceType === "corporate" ? invoice.tax_office.trim() : null,
      tax_number: invoiceType === "corporate" ? String(invoice.tax_number).trim() : null,
      company_name: invoiceType === "corporate" ? invoice.company_name.trim() : null,
      billing_address: billingAddress,
      payment_method: paymentMethod,
      tax_rate: taxRate,
      tax_amount: taxAmount
    });

    const insertItem = tx.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
      VALUES (@order_id, @product_id, @product_name, @quantity, @unit_price, @line_total)
    `);
    for (const item of normalized) {
      await insertItem.run({ ...item, order_id: order.lastInsertRowid });
    }

    // Hediyeler siparişe 0 TL'lik satır olarak yazılır: atölye ne göndereceğini
    // sipariş kaleminden görür, tutar etkilenmez.
    for (const gift of campaigns.gifts) {
      await insertItem.run({
        order_id: order.lastInsertRowid,
        product_id: gift.product_id,
        product_name: `${gift.product_name} (Hediye)`,
        quantity: gift.quantity,
        unit_price: 0,
        line_total: 0
      });
    }

    const bump = tx.prepare("UPDATE campaigns SET used_count = used_count + 1 WHERE id = ?");
    for (const c of campaigns.applied) await bump.run(c.id);
    return generatedNumber;
  });

  res.status(201).json({ order_number: orderNumber });
});

app.patch("/api/orders/:id", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Sipariş bulunamadı." });
  await db.prepare(`
    UPDATE orders SET status=@status, payment_status=@payment_status, tracking_code=@tracking_code, notes=@notes, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({
    id: current.id,
    status: req.body.status || current.status,
    payment_status: req.body.payment_status || current.payment_status,
    tracking_code: req.body.tracking_code ?? current.tracking_code,
    notes: req.body.notes ?? current.notes
  });
  res.json(await db.prepare("SELECT * FROM orders WHERE id = ?").get(current.id));
});

// Public site info — KDV oranı + iletişim bilgileri (storefront ve /iletisim kullanır).
app.get("/api/site-info", async (req, res) => {
  const site = await db.prepare("SELECT phone, email, contact_address, working_hours, social_links FROM site_settings WHERE id = 1").get() || {};
  const pricing = await db.prepare("SELECT tax_rate FROM pricing_settings WHERE id = 1").get() || {};
  const { wa } = await contactInfo();
  res.json({
    tax_rate: pricing.tax_rate ?? 20,
    phone: site.phone || "",
    email: site.email || "",
    whatsapp: wa ? `https://wa.me/${wa}` : "",
    address: site.contact_address || "",
    working_hours: site.working_hours || "",
    social_links: site.social_links || ""
  });
});

/* Bülten aboneliği. Bu form daha önce hiçbir yere gitmiyordu: action'ı, JS'i ve
   sunucu ucu yoktu; gönderilince sayfa yenileniyor, e-posta kayboluyordu. */
app.post("/api/subscribe", async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    return res.status(400).json({ error: "Geçerli bir e-posta adresi girin." });
  }
  if (email.length > 160) return res.status(400).json({ error: "E-posta adresi çok uzun." });

  // Aynı adres ikinci kez gelirse hata değil, sessizce başarı: kullanıcıya
  // "zaten kayıtlısınız" demek abonelik listesini sızdırmak olurdu.
  await db.prepare(`
    INSERT INTO subscribers (email) VALUES (?) ON CONFLICT (email) DO NOTHING
  `).run(email);

  res.status(201).json({ ok: true });
});

app.get("/api/subscribers", requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT * FROM subscribers ORDER BY created_at DESC").all());
});

app.delete("/api/subscribers/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM subscribers WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// Public contact form → stored as a message the admin can read in the "Mesajlar" tab.
app.post("/api/contact", async (req, res) => {
  const name = req.body.name?.trim();
  const message = req.body.message?.trim();
  if (!name || !message) return res.status(400).json({ error: "Ad soyad ve mesaj alanları zorunludur." });
  await db.prepare("INSERT INTO messages (name, email, phone, subject, message) VALUES (?,?,?,?,?)").run(
    name,
    req.body.email?.trim() || null,
    req.body.phone?.trim() || null,
    req.body.subject?.trim() || null,
    message
  );
  res.status(201).json({ ok: true });
});

app.get("/api/messages", requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT * FROM messages ORDER BY created_at DESC, id DESC").all());
});

app.patch("/api/messages/:id", requireAdmin, async (req, res) => {
  const current = await db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Mesaj bulunamadı." });
  await db.prepare("UPDATE messages SET is_read = ? WHERE id = ?").run(req.body.is_read ? 1 : 0, current.id);
  res.json(await db.prepare("SELECT * FROM messages WHERE id = ?").get(current.id));
});

app.delete("/api/messages/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM messages WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/admin", requireAdmin, async (req, res) => res.sendFile(path.join(ROOT, "admin.html")));

/* Son durak: yukarıdaki sarmalayıcının yakaladığı her hata buraya düşer.
   Sessiz bir askıda kalma yerine log'a yazılıp 500 dönülür. */
app.use((error, req, res, next) => {
  console.error("İSTEK HATASI:", req.method, req.originalUrl, "→", error.message);
  if (res.headersSent) return next(error);
  const wantsJson = req.originalUrl.startsWith("/api/");
  res.status(500);
  return wantsJson
    ? res.json({ error: "Beklenmeyen bir sunucu hatası oluştu." })
    : res.type("html").send("<h1>Bir hata oluştu</h1><p>Lütfen birazdan tekrar deneyin.</p>");
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Printable running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Local admin login: ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
  });

  // Yerel geliştirmede veritabanı süreç içinde gömülü çalışır; sert kapanışta
  // veri klasörü bozulabiliyor. Sinyalleri yakalayıp düzgün kapatıyoruz.
  const shutdown = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = app;

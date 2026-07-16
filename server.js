const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DB_PATH = path.join(DATA_DIR, "printable.sqlite");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "printable-admin";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-printable-session-secret";
const SESSION_COOKIE = "printable_admin";
const KDV_RATE = 20; // Ürün fiyatları KDV dahildir; faturada bu oranla ayrıştırılır.

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address TEXT,
    city TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price_per_cm3 REAL NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pricing_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    setup_fee REAL NOT NULL DEFAULT 120,
    size_fee_per_cm REAL NOT NULL DEFAULT 2.5,
    min_order_total REAL NOT NULL DEFAULT 150,
    shell_share REAL NOT NULL DEFAULT 0.15,
    color_change_fee REAL NOT NULL DEFAULT 35,
    tax_rate REAL NOT NULL DEFAULT 20,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE SET NULL,
    FOREIGN KEY(color_id) REFERENCES colors(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS quote_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    volume_cm3 REAL NOT NULL DEFAULT 0,
    color_id INTEGER,
    color_name TEXT,
    color_hex TEXT,
    FOREIGN KEY(quote_id) REFERENCES quotes(id) ON DELETE CASCADE,
    FOREIGN KEY(color_id) REFERENCES colors(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hex TEXT NOT NULL DEFAULT '#000000',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    price REAL NOT NULL,
    sale_price REAL,
    changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    subject TEXT,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    image_path TEXT,
    image_alt TEXT,
    href TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS seo_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    title TEXT,
    description TEXT,
    canonical TEXT,
    og_title TEXT,
    og_description TEXT,
    og_image TEXT,
    robots TEXT NOT NULL DEFAULT 'index,follow',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    contact_address TEXT,
    working_hours TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS hero_slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_path TEXT NOT NULL,
    title TEXT,
    subtitle TEXT,
    primary_label TEXT,
    primary_href TEXT,
    secondary_label TEXT,
    secondary_href TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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

// CREATE TABLE IF NOT EXISTS never adds a column to a database that already exists,
// so every new column needs an explicit, idempotent migration as well.
const hasColumn = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column);

[
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
  // Renamed: the floor applies to the order total, not to the unit price.
  ["pricing_settings", "min_order_total", "REAL NOT NULL DEFAULT 150"],
  // Each extra colour means a filament swap: purge waste plus machine time.
  ["pricing_settings", "color_change_fee", "REAL NOT NULL DEFAULT 35"],
  // Per-part STL the workshop can drop straight into a slicer.
  ["quote_parts", "file_path", "TEXT"],
  ["quote_parts", "name", "TEXT"],
  // Surface-painted 3MF: the paint only survives in the original file.
  ["quotes", "painted", "INTEGER NOT NULL DEFAULT 0"]
].forEach(([table, column, type]) => {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
});

const existingMaterials = db.prepare("SELECT COUNT(*) count FROM materials").get().count;
if (!existingMaterials) {
  const seedMaterial = db.prepare(`
    INSERT INTO materials (name, description, price_per_cm3, sort_order)
    VALUES (@name, @description, @price_per_cm3, @sort_order)
  `);
  // PLA keeps the 8.50 TL/cm3 rate the old hardcoded formula used, so prices do not move.
  [
    { name: "PLA", description: "Standart, ekonomik, iç mekan kullanımı", price_per_cm3: 8.5 },
    { name: "PETG", description: "Dayanıklı, ısıya ve neme daha dirençli", price_per_cm3: 11 },
    { name: "ABS", description: "Mekanik parçalar, yüksek sıcaklık dayanımı", price_per_cm3: 10 },
    { name: "Reçine (SLA)", description: "Yüksek detay, pürüzsüz yüzey", price_per_cm3: 18 }
  ].forEach((material, index) => seedMaterial.run({ ...material, sort_order: index + 1 }));
}

if (!db.prepare("SELECT COUNT(*) count FROM pricing_settings").get().count) {
  db.prepare(`
    INSERT INTO pricing_settings (id, setup_fee, size_fee_per_cm, min_order_total, shell_share)
    VALUES (1, 120, 2.5, 150, 0.15)
  `).run();
}

const existingColors = db.prepare("SELECT COUNT(*) count FROM colors").get().count;
if (!existingColors) {
  const seedColor = db.prepare("INSERT INTO colors (name, hex, sort_order) VALUES (@name, @hex, @sort_order)");
  [
    { name: "Beyaz", hex: "#ffffff" },
    { name: "Siyah", hex: "#1f2128" },
    { name: "Turuncu", hex: "#ff6542" },
    { name: "Kırmızı", hex: "#e02f2f" },
    { name: "Mavi", hex: "#2ba9ff" },
    { name: "Yeşil", hex: "#1f8f67" },
    { name: "Sarı", hex: "#f8d861" },
    { name: "Pembe", hex: "#ff4aa1" }
  ].forEach((color, index) => seedColor.run({ ...color, sort_order: index + 1 }));
}

const existingCategories = db.prepare("SELECT COUNT(*) count FROM categories").get().count;
if (!existingCategories) {
  const seedCategory = db.prepare(`
    INSERT INTO categories (name, image_path, image_alt, href, sort_order)
    VALUES (@name, @image_path, @image_alt, @href, @sort_order)
  `);
  // 3D baskı alt kategorileri — kapak görselleri temsili MakerWorld ürünlerinden,
  // admin panelinden değiştirilebilir. Bir ürün birden fazla kategoride olabilir.
  [
    { name: "Figürler", image_path: "https://makerworld.bblmw.com/makerworld/model/USf3226a122488f2/design/613a3d21dba2bbba.jpg?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı figür kategorisi" },
    { name: "Anahtarlıklar", image_path: "https://makerworld.bblmw.com/makerworld/model/USe2e8a5bf3ddaed/design/34e00292d363c821.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı anahtarlık kategorisi" },
    { name: "Fidget & Stres", image_path: "https://makerworld.bblmw.com/makerworld/model/US9a6f7ab9cda059/design/2025-09-11_7ae60a50cbf4a8.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı fidget ve stres oyuncağı kategorisi" },
    { name: "Düdükler", image_path: "https://makerworld.bblmw.com/makerworld/model/US208abf1d1f1a36/design/2024-01-09_42430df1b0709.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı düdük kategorisi" },
    { name: "Ev & Organizer", image_path: "https://makerworld.bblmw.com/makerworld/model/US9f63a04055cd4b/design/2026-01-13_59140b7190323.png?x-oss-process=image/resize,w_1200/ignore-error,1", image_alt: "3D baskı ev ve organizer kategorisi" }
  ].forEach((category, index) => seedCategory.run({ ...category, href: "#store-products", sort_order: index + 1 }));
}

const existingSeoPages = db.prepare("SELECT COUNT(*) count FROM seo_pages").get().count;
if (!existingSeoPages) {
  const seedPage = db.prepare(`
    INSERT INTO seo_pages (slug, label, title, description, canonical, og_title, og_description, og_image, robots)
    VALUES (@slug, @label, @title, @description, @canonical, @og_title, @og_description, @og_image, @robots)
  `);
  [
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
  ].forEach((page) => seedPage.run(page));
}

// Pages that shipped after the seo_pages seed already ran on live databases get their
// rows idempotently (slug is UNIQUE, INSERT OR IGNORE is a no-op if already present).
const addSeoPage = db.prepare(`
  INSERT OR IGNORE INTO seo_pages (slug, label, title, description, og_title, og_description, robots)
  VALUES (@slug, @label, @title, @description, @og_title, @og_description, 'index,follow')
`);
[
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
].forEach((page) => addSeoPage.run(page));

const existingSite = db.prepare("SELECT COUNT(*) count FROM site_settings").get().count;
if (!existingSite) {
  db.prepare(`
    INSERT INTO site_settings (id, site_name, site_url, description, logo_path, social_links, default_og_image)
    VALUES (1, @site_name, @site_url, @description, @logo_path, @social_links, @default_og_image)
  `).run({
    site_name: "Printable",
    site_url: "",
    description: "Özel 3D baskı figür, oyuncak ve anahtarlık ürünleri; STL baskı hizmeti.",
    logo_path: "/assets/printable-logo.svg",
    social_links: "",
    default_og_image: ""
  });
}

const existingProducts = db.prepare("SELECT COUNT(*) count FROM products").get().count;
if (!existingProducts) {
  const seedProduct = db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path, image_alt, meta_keywords)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path, @image_alt, @meta_keywords)
  `);
  [
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
  ].forEach((product) => seedProduct.run(product));

  const productIdBySku = db.prepare("SELECT id FROM products WHERE sku = ?");

  // Give the seeded products a few palette colours so the storefront swatches
  // are not empty on a fresh install.
  const linkColor = db.prepare(`
    INSERT OR IGNORE INTO product_colors (product_id, color_id)
    SELECT ?, id FROM colors WHERE name = ?
  `);
  [
    ["PR-3D-001", ["Beyaz", "Siyah", "Turuncu"]],
    ["PR-3D-002", ["Mavi", "Siyah", "Kırmızı"]],
    ["PR-3D-003", ["Mavi", "Sarı", "Siyah"]]
  ].forEach(([sku, names]) => {
    const product = productIdBySku.get(sku);
    if (product) names.forEach((name) => linkColor.run(product.id, name));
  });

  // A product can belong to more than one category — link by name so it survives
  // whatever ids the category seed produced.
  const linkCategory = db.prepare(`
    INSERT OR IGNORE INTO product_categories (product_id, category_id)
    SELECT ?, id FROM categories WHERE name = ?
  `);
  [
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
  ].forEach(([sku, names]) => {
    const product = productIdBySku.get(sku);
    if (product) names.forEach((name) => linkCategory.run(product.id, name));
  });
}

// Baseline price history: every product gets at least one entry so the log is never
// empty and the "current price since" reference exists. Idempotent — only products
// that have no history yet are seeded.
db.prepare(`
  INSERT INTO price_history (product_id, price, sale_price)
  SELECT p.id, p.price, p.sale_price FROM products p
  WHERE NOT EXISTS (SELECT 1 FROM price_history h WHERE h.product_id = p.id)
`).run();

const existingSlides = db.prepare("SELECT COUNT(*) count FROM hero_slides").get().count;
if (!existingSlides) {
  const seedSlide = db.prepare(`
    INSERT INTO hero_slides (image_path, title, subtitle, primary_label, primary_href, secondary_label, secondary_href, sort_order)
    VALUES (@image_path, @title, @subtitle, @primary_label, @primary_href, @secondary_label, @secondary_href, @sort_order)
  `);
  [
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
  ].forEach((slide) => seedSlide.run(slide));
}

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
app.use("/uploads", express.static(UPLOAD_DIR));
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
function seoHead(req, slug) {
  const page = db.prepare("SELECT * FROM seo_pages WHERE slug = ?").get(slug) || {};
  const site = db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};

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
    const rows = db.prepare("SELECT meta_keywords FROM products WHERE is_active = 1 AND meta_keywords IS NOT NULL AND meta_keywords <> ''").all();
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
// drift between pages again. `active` marks the current main-link (home | urunler | stl-teklif).
function renderHeader(active) {
  const link = (href, label, key) => `<a${active === key ? ' class="active"' : ""} href="${href}">${label}</a>`;
  return `
    <header class="site-header">
      <div class="container header-main">
        <a class="logo printable-logo" href="/" aria-label="Printable ana sayfa">
          <span>Printable</span>
        </a>
        <nav class="main-links" aria-label="Ana menü">
          ${link("/", "Ana Sayfa", "home")}
          ${link("/urunler", "Ürünler", "urunler")}
          ${link("/stl-teklif", "3D Baskı Teklifi", "stl-teklif")}
          ${link("/hakkinda", "Hakkımızda", "hakkinda")}
          ${link("/iletisim", "İletişim", "iletisim")}
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

// Shared footer, injected server-side so links stay consistent across every page.
function renderFooter() {
  return `
    <footer class="footer">
      <div class="container newsletter">
        <h2>Bültenimize abone olun</h2>
        <form>
          <input type="email" placeholder="E-posta adresiniz">
          <button type="submit">Abone ol</button>
        </form>
      </div>
      <div class="container footer__grid">
        <div><h3>Kategoriler</h3><a href="/urunler">Figürler</a><a href="/urunler">Anahtarlıklar</a><a href="/urunler">Fidget & Stres</a><a href="/urunler">Düdükler</a></div>
        <div><h3>Kurumsal</h3><a href="/hakkinda">Hakkımızda</a><a href="/iletisim">İletişim</a><a href="/stl-teklif">Özel 3D baskı</a><a href="/urunler">Tüm ürünler</a></div>
        <div><h3>Müşteri Desteği</h3><a href="/iletisim">Bize ulaşın</a><a href="/sss">İade & Değişim</a><a href="/sss">Kargo</a><a href="/sss">S.S.S.</a></div>
        <div class="footer-logo printable-wordmark"><strong>Printable</strong><p>Özel 3D baskı ürünleri ve STL baskı hizmeti.</p><p>Türkiye</p></div>
      </div>
    </footer>`;
}

function injectShell(html, headActive) {
  return html
    .replace("<!--header-->", renderHeader(headActive))
    .replace("<!--cart-->", renderCartPanel())
    .replace("<!--footer-->", renderFooter());
}

function sendPage(req, res, file, slug) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  res.type("html").send(injectShell(html.replace("<!--seo-->", seoHead(req, slug)), slug));
}

app.get("/", (req, res) => sendPage(req, res, "index.html", "home"));
app.get("/urunler", (req, res) => sendPage(req, res, "urunler.html", "urunler"));
app.get("/stl-teklif", (req, res) => sendPage(req, res, "stl-teklif.html", "stl-teklif"));
app.get("/hakkinda", (req, res) => sendPage(req, res, "hakkinda.html", "hakkinda"));
app.get("/iletisim", (req, res) => sendPage(req, res, "iletisim.html", "iletisim"));
app.get("/sss", (req, res) => sendPage(req, res, "sss.html", "sss"));

// Per-product SEO: crawlers need real title/description/og:image/JSON-LD in the HTML
// (the visible detail is filled by urun.js, matching the rest of the JS-rendered site).
function productMetaTags(req, product) {
  const site = db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
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

app.get("/urun/:id", (req, res) => {
  const product = db.prepare("SELECT * FROM products WHERE id = ? AND is_active = 1").get(req.params.id);
  if (!product) return res.redirect(302, "/urunler");
  const html = fs.readFileSync(path.join(ROOT, "urun.html"), "utf8");
  res.type("html").send(injectShell(html.replace("<!--seo-->", productMetaTags(req, withColors(product))), "urunler"));
});

// Checkout flow — noindex (a transactional page crawlers should not list).
app.get("/odeme", (req, res) => {
  const site = db.prepare("SELECT site_name FROM site_settings WHERE id = 1").get() || {};
  const head = [
    `<title>Ödeme | ${escapeHtml(site.site_name || "Printable")}</title>`,
    `<meta name="robots" content="noindex,nofollow">`
  ].join("\n    ");
  const html = fs.readFileSync(path.join(ROOT, "odeme.html"), "utf8");
  res.type("html").send(injectShell(html.replace("<!--seo-->", head), ""));
});

// Tell crawlers what to index and where the sitemap is. Admin and API paths are off-limits.
app.get("/robots.txt", (req, res) => {
  const site = db.prepare("SELECT site_url FROM site_settings WHERE id = 1").get() || {};
  const base = (site.site_url || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.type("text/plain").send(
    ["User-agent: *", "Allow: /", "Disallow: /admin", "Disallow: /login", "Disallow: /api/", "Disallow: /odeme", "", `Sitemap: ${base}/sitemap.xml`, ""].join("\n")
  );
});

// Dynamic sitemap: the static pages plus every active product detail page.
app.get("/sitemap.xml", (req, res) => {
  const site = db.prepare("SELECT site_url FROM site_settings WHERE id = 1").get() || {};
  const urls = [
    { loc: "/", priority: "1.0" },
    { loc: "/urunler", priority: "0.9" },
    { loc: "/stl-teklif", priority: "0.8" },
    { loc: "/hakkinda", priority: "0.5" },
    { loc: "/iletisim", priority: "0.5" },
    { loc: "/sss", priority: "0.5" }
  ];
  db.prepare("SELECT id, updated_at FROM products WHERE is_active = 1 ORDER BY id").all()
    .forEach((p) => urls.push({ loc: `/urun/${p.id}`, priority: "0.7", lastmod: String(p.updated_at || "").slice(0, 10) }));

  const body = urls.map((u) => {
    const loc = escapeHtml(absoluteUrl(req, u.loc, site.site_url));
    return `  <url>\n    <loc>${loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}\n    <priority>${u.priority}</priority>\n  </url>`;
  }).join("\n");

  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  );
});

["styles.css", "script.js", "stl-viewer.js", "admin.css", "admin.js", "urunler.js", "urun.js", "odeme.js", "iletisim.js"].forEach((file) => {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(ROOT, file)));
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

app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/admin");
  return res.sendFile(path.join(ROOT, "login.html"));
});

app.post("/api/login", (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASSWORD) {
    setSessionCookie(res);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authed: isAuthed(req), user: isAuthed(req) ? ADMIN_USER : null });
});

const money = (value) => Number(value || 0);
const nullableMoney = (value) => value === "" || value == null ? null : Number(value);
const toInt = (value) => Number.parseInt(value || "0", 10);

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
    image_path: file ? `/uploads/${file.filename}` : body.current_image || null,
    image_alt: body.image_alt?.trim() || null,
    meta_title: body.meta_title?.trim() || null,
    meta_description: body.meta_description?.trim() || null,
    meta_keywords: body.meta_keywords?.trim() || null,
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.get("/api/stats", requireAdmin, (req, res) => {
  const stats = {
    products: db.prepare("SELECT COUNT(*) count FROM products").get().count,
    customers: db.prepare("SELECT COUNT(*) count FROM customers").get().count,
    orders: db.prepare("SELECT COUNT(*) count FROM orders").get().count,
    revenue: db.prepare("SELECT COALESCE(SUM(total), 0) total FROM orders").get().total,
    quotes: db.prepare("SELECT COUNT(*) count FROM quotes WHERE status = 'new'").get().count,
    messages: db.prepare("SELECT COUNT(*) count FROM messages WHERE is_read = 0").get().count
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

// One decorate step so /api/products, POST and PUT all return the same shape:
// the product row plus its colours and categories.
const withColors = (product) => ({
  ...product,
  colors: colorsOfProduct.all(product.id),
  categories: categoriesOfProduct.all(product.id)
});

// A multi-select posts one value per checked box; multer/urlencoded gives a string
// when exactly one is checked and an array when several are.
function setProductColors(productId, colorIds) {
  const ids = [].concat(colorIds ?? []).map((id) => toInt(id)).filter(Boolean);
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM product_colors WHERE product_id = ?").run(productId);
    const link = db.prepare("INSERT OR IGNORE INTO product_colors (product_id, color_id) VALUES (?, ?)");
    ids.forEach((colorId) => link.run(productId, colorId));
  });
  replace();
}

// Same shape as setProductColors — the category multi-select posts repeated category_ids.
function setProductCategories(productId, categoryIds) {
  const ids = [].concat(categoryIds ?? []).map((id) => toInt(id)).filter(Boolean);
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM product_categories WHERE product_id = ?").run(productId);
    const link = db.prepare("INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)");
    ids.forEach((categoryId) => link.run(productId, categoryId));
  });
  replace();
}

const insertPriceHistory = db.prepare(
  "INSERT INTO price_history (product_id, price, sale_price) VALUES (?, ?, ?)"
);
// Append a price-history row. Call on create, and on update only when the price or
// discount actually changed, so the log stays a meaningful timeline of changes.
function logPrice(productId, price, salePrice) {
  insertPriceHistory.run(productId, price, salePrice ?? null);
}
const priceChanged = (before, price, salePrice) =>
  Number(before.price) !== Number(price) || (before.sale_price ?? null) !== (salePrice ?? null);

app.get("/api/products", (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all();
  res.json(products.map(withColors));
});

app.get("/api/products/:id", (req, res) => {
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });
  res.json(withColors(product));
});

app.get("/api/products/:id/price-history", (req, res) => {
  const rows = db.prepare(
    "SELECT id, price, sale_price, changed_at FROM price_history WHERE product_id = ? ORDER BY changed_at DESC, id DESC"
  ).all(req.params.id);
  res.json(rows);
});

app.post("/api/products", requireAdmin, upload.single("image"), (req, res) => {
  const product = productPayload(req.body, req.file);
  if (!product.name) return res.status(400).json({ error: "Ürün adı zorunludur." });

  const result = db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path, image_alt, meta_title, meta_description, meta_keywords, is_active)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path, @image_alt, @meta_title, @meta_description, @meta_keywords, @is_active)
  `).run(product);

  setProductColors(result.lastInsertRowid, req.body.color_ids);
  setProductCategories(result.lastInsertRowid, req.body.category_ids);
  logPrice(result.lastInsertRowid, product.price, product.sale_price);
  res.status(201).json(withColors(db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid)));
});

app.put("/api/products/:id", requireAdmin, upload.single("image"), (req, res) => {
  const current = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Ürün bulunamadı." });
  const product = productPayload({ ...req.body, current_image: current.image_path }, req.file);
  product.id = current.id;

  db.prepare(`
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
    logPrice(current.id, product.price, product.sale_price);
  }
  res.json(withColors(db.prepare("SELECT * FROM products WHERE id = ?").get(current.id)));
});

app.delete("/api/products/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

function heroSlidePayload(body, file) {
  return {
    image_path: file ? `/uploads/${file.filename}` : (body.image_url?.trim() || body.current_image || null),
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
app.get("/api/hero-slides", (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  const slides = db.prepare(`
    SELECT * FROM hero_slides
    ${all ? "" : "WHERE is_active = 1"}
    ORDER BY sort_order ASC, id ASC
  `).all();
  res.json(slides);
});

app.post("/api/hero-slides", requireAdmin, upload.single("image"), (req, res) => {
  const slide = heroSlidePayload(req.body, req.file);
  if (!slide.image_path) return res.status(400).json({ error: "Banner görseli zorunludur (dosya yükleyin veya URL girin)." });

  const result = db.prepare(`
    INSERT INTO hero_slides (image_path, image_alt, title, subtitle, primary_label, primary_href, secondary_label, secondary_href, sort_order, is_active)
    VALUES (@image_path, @image_alt, @title, @subtitle, @primary_label, @primary_href, @secondary_label, @secondary_href, @sort_order, @is_active)
  `).run(slide);

  res.status(201).json(db.prepare("SELECT * FROM hero_slides WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/hero-slides/:id", requireAdmin, upload.single("image"), (req, res) => {
  const current = db.prepare("SELECT * FROM hero_slides WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Banner görseli bulunamadı." });

  const slide = heroSlidePayload({ ...req.body, current_image: current.image_path }, req.file);
  if (!slide.image_path) return res.status(400).json({ error: "Banner görseli zorunludur (dosya yükleyin veya URL girin)." });
  slide.id = current.id;

  db.prepare(`
    UPDATE hero_slides SET
      image_path=@image_path, image_alt=@image_alt, title=@title, subtitle=@subtitle,
      primary_label=@primary_label, primary_href=@primary_href,
      secondary_label=@secondary_label, secondary_href=@secondary_href,
      sort_order=@sort_order, is_active=@is_active, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run(slide);

  res.json(db.prepare("SELECT * FROM hero_slides WHERE id = ?").get(current.id));
});

app.delete("/api/hero-slides/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM hero_slides WHERE id = ?").run(req.params.id);
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

const pricingSettings = () => db.prepare("SELECT * FROM pricing_settings WHERE id = 1").get();

function priceQuote({ volume_cm3, max_dim_mm, material_id, infill, quantity, color_count }) {
  const settings = pricingSettings();
  const material = material_id
    ? db.prepare("SELECT * FROM materials WHERE id = ? AND is_active = 1").get(material_id)
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

app.get("/api/materials", (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  res.json(db.prepare(`
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

app.post("/api/materials", requireAdmin, (req, res) => {
  const material = materialPayload(req.body);
  if (!material.name) return res.status(400).json({ error: "Malzeme adı zorunludur." });
  const result = db.prepare(`
    INSERT INTO materials (name, description, price_per_cm3, sort_order, is_active)
    VALUES (@name, @description, @price_per_cm3, @sort_order, @is_active)
  `).run(material);
  res.status(201).json(db.prepare("SELECT * FROM materials WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/materials/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM materials WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Malzeme bulunamadı." });
  const material = materialPayload(req.body);
  if (!material.name) return res.status(400).json({ error: "Malzeme adı zorunludur." });
  material.id = current.id;
  db.prepare(`
    UPDATE materials SET name=@name, description=@description, price_per_cm3=@price_per_cm3,
      sort_order=@sort_order, is_active=@is_active WHERE id=@id
  `).run(material);
  res.json(db.prepare("SELECT * FROM materials WHERE id = ?").get(current.id));
});

app.delete("/api/materials/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM materials WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/pricing", requireAdmin, (req, res) => res.json(pricingSettings()));

app.put("/api/pricing", requireAdmin, (req, res) => {
  const shell = Number(req.body.shell_share);
  db.prepare(`
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
  res.json(pricingSettings());
});

// Live price for the wizard. The browser never computes the price itself.
app.post("/api/quote-price", (req, res) => {
  const price = priceQuote(req.body);
  if (price.error) return res.status(400).json({ error: price.error });
  res.json(price);
});

app.post("/api/quotes", uploadModel, (req, res) => {
  const body = req.body;
  const modelFile = req.files?.model?.[0] || null;
  const partFiles = req.files?.part_files || [];
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
  const price = priceQuote({ ...body, color_count: Math.max(1, distinctColors.size) });
  if (price.error) return res.status(400).json({ error: price.error });

  const primaryColorId = parts[0]?.color_id || body.color_id || null;
  const color = primaryColorId ? db.prepare("SELECT * FROM colors WHERE id = ?").get(primaryColorId) : null;
  const quoteNumber = `TKF-${Date.now().toString().slice(-8)}`;

  const result = db.prepare(`
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
    file_name: modelFile?.originalname || null,
    file_path: modelFile ? `/uploads/${modelFile.filename}` : null,
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

  const insertPart = db.prepare(`
    INSERT INTO quote_parts (quote_id, part_index, name, volume_cm3, color_id, color_name, color_hex, file_path)
    VALUES (@quote_id, @part_index, @name, @volume_cm3, @color_id, @color_name, @color_hex, @file_path)
  `);
  db.transaction(() => {
    parts.forEach((part, index) => {
      const partColor = part.color_id
        ? db.prepare("SELECT * FROM colors WHERE id = ?").get(part.color_id)
        : null;
      // part_files arrive in the same order as parts.
      const file = partFiles[index];
      insertPart.run({
        quote_id: result.lastInsertRowid,
        part_index: index + 1,
        name: part.name?.trim() || null,
        volume_cm3: Math.max(0, Number(part.volume_cm3) || 0),
        color_id: partColor?.id || null,
        color_name: partColor?.name || null,
        color_hex: partColor?.hex || null,
        file_path: file ? `/uploads/${file.filename}` : null
      });
    });
  })();

  res.status(201).json(withParts(db.prepare("SELECT * FROM quotes WHERE id = ?").get(result.lastInsertRowid)));
});

const partsOfQuote = db.prepare("SELECT * FROM quote_parts WHERE quote_id = ? ORDER BY part_index");
const withParts = (quote) => ({ ...quote, parts: partsOfQuote.all(quote.id) });

app.get("/api/quotes", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM quotes ORDER BY created_at DESC").all().map(withParts));
});

app.patch("/api/quotes/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM quotes WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Teklif bulunamadı." });
  db.prepare("UPDATE quotes SET status=@status WHERE id=@id").run({
    id: current.id,
    status: req.body.status || current.status
  });
  res.json(db.prepare("SELECT * FROM quotes WHERE id = ?").get(current.id));
});

app.delete("/api/quotes/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM quotes WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/colors", (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  res.json(db.prepare(`
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

app.post("/api/colors", requireAdmin, (req, res) => {
  const color = colorPayload(req.body);
  if (!color.name) return res.status(400).json({ error: "Renk adı zorunludur." });
  if (!color.hex) return res.status(400).json({ error: "Geçerli bir renk kodu seçin (#rrggbb)." });

  const result = db.prepare(`
    INSERT INTO colors (name, hex, sort_order, is_active)
    VALUES (@name, @hex, @sort_order, @is_active)
  `).run(color);

  res.status(201).json(db.prepare("SELECT * FROM colors WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/colors/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM colors WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Renk bulunamadı." });

  const color = colorPayload(req.body);
  if (!color.name) return res.status(400).json({ error: "Renk adı zorunludur." });
  if (!color.hex) return res.status(400).json({ error: "Geçerli bir renk kodu seçin (#rrggbb)." });
  color.id = current.id;

  db.prepare("UPDATE colors SET name=@name, hex=@hex, sort_order=@sort_order, is_active=@is_active WHERE id=@id").run(color);
  res.json(db.prepare("SELECT * FROM colors WHERE id = ?").get(current.id));
});

// The join rows go with it (ON DELETE CASCADE), so products lose the swatch too.
app.delete("/api/colors/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM colors WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

function categoryPayload(body, file) {
  return {
    name: body.name?.trim(),
    image_path: file ? `/uploads/${file.filename}` : (body.image_url?.trim() || body.current_image || null),
    image_alt: body.image_alt?.trim() || null,
    href: body.href?.trim() || "#store-products",
    sort_order: toInt(body.sort_order),
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.get("/api/categories", (req, res) => {
  const all = req.query.all === "1" && isAuthed(req);
  res.json(db.prepare(`
    SELECT * FROM categories
    ${all ? "" : "WHERE is_active = 1"}
    ORDER BY sort_order ASC, id ASC
  `).all());
});

app.post("/api/categories", requireAdmin, upload.single("image"), (req, res) => {
  const category = categoryPayload(req.body, req.file);
  if (!category.name) return res.status(400).json({ error: "Kategori adı zorunludur." });

  const result = db.prepare(`
    INSERT INTO categories (name, image_path, image_alt, href, sort_order, is_active)
    VALUES (@name, @image_path, @image_alt, @href, @sort_order, @is_active)
  `).run(category);

  res.status(201).json(db.prepare("SELECT * FROM categories WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/categories/:id", requireAdmin, upload.single("image"), (req, res) => {
  const current = db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Kategori bulunamadı." });

  const category = categoryPayload({ ...req.body, current_image: current.image_path }, req.file);
  if (!category.name) return res.status(400).json({ error: "Kategori adı zorunludur." });
  category.id = current.id;

  db.prepare(`
    UPDATE categories SET
      name=@name, image_path=@image_path, image_alt=@image_alt, href=@href,
      sort_order=@sort_order, is_active=@is_active, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run(category);

  res.json(db.prepare("SELECT * FROM categories WHERE id = ?").get(current.id));
});

app.delete("/api/categories/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM categories WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/seo", requireAdmin, (req, res) => {
  res.json({
    pages: db.prepare("SELECT * FROM seo_pages ORDER BY id").all(),
    site: db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {}
  });
});

app.put("/api/seo/pages/:slug", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM seo_pages WHERE slug = ?").get(req.params.slug);
  if (!current) return res.status(404).json({ error: "Sayfa bulunamadı." });

  db.prepare(`
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

  res.json(db.prepare("SELECT * FROM seo_pages WHERE slug = ?").get(current.slug));
});

app.put("/api/seo/site", requireAdmin, (req, res) => {
  db.prepare(`
    UPDATE site_settings SET
      site_name=@site_name, site_url=@site_url, description=@description,
      logo_path=@logo_path, social_links=@social_links, default_og_image=@default_og_image,
      phone=@phone, email=@email, contact_address=@contact_address, working_hours=@working_hours,
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
    contact_address: req.body.contact_address?.trim() || null,
    working_hours: req.body.working_hours?.trim() || null
  });

  res.json(db.prepare("SELECT * FROM site_settings WHERE id = 1").get());
});

app.get("/api/customers", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all());
});

app.post("/api/customers", (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ error: "Müşteri adı zorunludur." });
  const result = db.prepare(`
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
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid));
});

app.get("/api/orders", requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT orders.*, customers.name customer_name, customers.email customer_email
    FROM orders
    JOIN customers ON customers.id = orders.customer_id
    ORDER BY orders.created_at DESC
  `).all();

  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?");
  res.json(orders.map((order) => ({ ...order, items: items.all(order.id) })));
});

app.post("/api/orders", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!req.body.customer_id) return res.status(400).json({ error: "Müşteri seçimi zorunludur." });
  if (!items.length) return res.status(400).json({ error: "En az bir sipariş ürünü gereklidir." });

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, customer_id, status, payment_status, shipping_address, tracking_code, subtotal, discount, total, notes)
    VALUES (@order_number, @customer_id, @status, @payment_status, @shipping_address, @tracking_code, @subtotal, @discount, @total, @notes)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
    VALUES (@order_id, @product_id, @product_name, @quantity, @unit_price, @line_total)
  `);

  const create = db.transaction(() => {
    const normalized = items.map((item) => {
      const product = item.product_id ? db.prepare("SELECT * FROM products WHERE id = ?").get(item.product_id) : null;
      const quantity = Math.max(1, toInt(item.quantity));
      const unitPrice = money(item.unit_price || product?.sale_price || product?.price);
      return {
        product_id: product?.id || null,
        product_name: product?.name || item.product_name || "Özel ürün",
        quantity,
        unit_price: unitPrice,
        line_total: quantity * unitPrice
      };
    });
    const subtotal = normalized.reduce((sum, item) => sum + item.line_total, 0);
    const discount = money(req.body.discount);
    const total = Math.max(0, subtotal - discount);
    const orderNumber = `PRN-${Date.now().toString().slice(-8)}`;
    const result = insertOrder.run({
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

    normalized.forEach((item) => insertItem.run({ ...item, order_id: result.lastInsertRowid }));
    return result.lastInsertRowid;
  });

  const id = create();
  res.status(201).json(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
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
app.post("/api/checkout", (req, res) => {
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

  const create = db.transaction(() => {
    const cust = db.prepare("INSERT INTO customers (name, email, phone, address, city) VALUES (?,?,?,?,?)").run(
      customer.name.trim(), customer.email?.trim() || null, customer.phone.trim(), customer.address.trim(), customer.city?.trim() || null
    );

    const normalized = items.map((item) => {
      const product = item.product_id ? db.prepare("SELECT * FROM products WHERE id = ?").get(item.product_id) : null;
      const quantity = Math.max(1, toInt(item.quantity));
      const unitPrice = money(product?.sale_price || product?.price || item.unit_price);
      return {
        product_id: product?.id || null,
        product_name: product?.name || item.product_name || "Ürün",
        quantity,
        unit_price: unitPrice,
        line_total: quantity * unitPrice
      };
    });
    const subtotal = normalized.reduce((sum, item) => sum + item.line_total, 0);
    // Prices are KDV-hariç (net); VAT is added on top. Shipping is recipient-paid
    // (alıcı ödemeli), so it is not added to the total.
    const taxRate = pricingSettings().tax_rate ?? KDV_RATE;
    const taxAmount = money(subtotal * taxRate / 100);
    const grandTotal = money(subtotal + taxAmount);
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
    const orderNumber = `PRN-${Date.now().toString().slice(-8)}`;

    const order = db.prepare(`
      INSERT INTO orders (order_number, customer_id, status, payment_status, shipping_address, subtotal, discount, total, notes,
        invoice_type, tc_no, tax_office, tax_number, company_name, billing_address, payment_method,
        tax_rate, tax_amount, shipping_method)
      VALUES (@order_number, @customer_id, 'new', 'pending', @shipping_address, @subtotal, 0, @total, @notes,
        @invoice_type, @tc_no, @tax_office, @tax_number, @company_name, @billing_address, @payment_method,
        @tax_rate, @tax_amount, 'recipient_paid')
    `).run({
      order_number: orderNumber,
      customer_id: cust.lastInsertRowid,
      shipping_address: shippingAddress,
      subtotal,
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

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
      VALUES (@order_id, @product_id, @product_name, @quantity, @unit_price, @line_total)
    `);
    normalized.forEach((item) => insertItem.run({ ...item, order_id: order.lastInsertRowid }));
    return orderNumber;
  });

  res.status(201).json({ order_number: create() });
});

app.patch("/api/orders/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Sipariş bulunamadı." });
  db.prepare(`
    UPDATE orders SET status=@status, payment_status=@payment_status, tracking_code=@tracking_code, notes=@notes, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({
    id: current.id,
    status: req.body.status || current.status,
    payment_status: req.body.payment_status || current.payment_status,
    tracking_code: req.body.tracking_code ?? current.tracking_code,
    notes: req.body.notes ?? current.notes
  });
  res.json(db.prepare("SELECT * FROM orders WHERE id = ?").get(current.id));
});

// Public site info — KDV oranı + iletişim bilgileri (storefront ve /iletisim kullanır).
app.get("/api/site-info", (req, res) => {
  const site = db.prepare("SELECT phone, email, contact_address, working_hours, social_links FROM site_settings WHERE id = 1").get() || {};
  const pricing = db.prepare("SELECT tax_rate FROM pricing_settings WHERE id = 1").get() || {};
  res.json({
    tax_rate: pricing.tax_rate ?? 20,
    phone: site.phone || "",
    email: site.email || "",
    address: site.contact_address || "",
    working_hours: site.working_hours || "",
    social_links: site.social_links || ""
  });
});

// Public contact form → stored as a message the admin can read in the "Mesajlar" tab.
app.post("/api/contact", (req, res) => {
  const name = req.body.name?.trim();
  const message = req.body.message?.trim();
  if (!name || !message) return res.status(400).json({ error: "Ad soyad ve mesaj alanları zorunludur." });
  db.prepare("INSERT INTO messages (name, email, phone, subject, message) VALUES (?,?,?,?,?)").run(
    name,
    req.body.email?.trim() || null,
    req.body.phone?.trim() || null,
    req.body.subject?.trim() || null,
    message
  );
  res.status(201).json({ ok: true });
});

app.get("/api/messages", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM messages ORDER BY created_at DESC, id DESC").all());
});

app.patch("/api/messages/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Mesaj bulunamadı." });
  db.prepare("UPDATE messages SET is_read = ? WHERE id = ?").run(req.body.is_read ? 1 : 0, current.id);
  res.json(db.prepare("SELECT * FROM messages WHERE id = ?").get(current.id));
});

app.delete("/api/messages/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM messages WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/admin", requireAdmin, (req, res) => res.sendFile(path.join(ROOT, "admin.html")));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Printable running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Local admin login: ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
  });
}

module.exports = app;

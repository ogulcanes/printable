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
  ["products", "image_alt", "TEXT"],
  ["hero_slides", "image_alt", "TEXT"],
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
  // Placeholder artwork inherited from the demo theme — replace these from the admin panel.
  const demoImage = (n) => `https://new-ella-demo-07.myshopify.com/cdn/shop/files/super_market_1_${n}.png?v=1754039110&width=300`;
  ["Sticker", "Kartvizit", "Poster", "Etiket", "Ambalaj", "Promosyon"].forEach((name, index) => {
    seedCategory.run({
      name,
      image_path: demoImage(index + 1),
      image_alt: `${name} baskı kategorisi`,
      href: "#store-products",
      sort_order: index + 1
    });
  });
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
      title: "Printable | Markanız İçin Özel Baskı ve 3D Baskı",
      description: "Sticker, poster, kartvizit ve ambalaj baskısı. STL dosyanızı yükleyin, 3D baskı için anında fiyat alın.",
      canonical: "",
      og_title: "Printable | Özel Baskı ve 3D Baskı Çözümleri",
      og_description: "Sticker, poster, kartvizit, ambalaj ve 3D baskı. Net fiyat, hızlı üretim.",
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

const existingSite = db.prepare("SELECT COUNT(*) count FROM site_settings").get().count;
if (!existingSite) {
  db.prepare(`
    INSERT INTO site_settings (id, site_name, site_url, description, logo_path, social_links)
    VALUES (1, @site_name, @site_url, @description, @logo_path, @social_links)
  `).run({
    site_name: "Printable",
    site_url: "",
    description: "Markanız için özel baskı ve 3D baskı çözümleri.",
    logo_path: "/assets/printable-logo.svg",
    social_links: ""
  });
}

const existingProducts = db.prepare("SELECT COUNT(*) count FROM products").get().count;
if (!existingProducts) {
  const seedProduct = db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path)
  `);
  [
    {
      name: "Custom Sticker Pack",
      sku: "PR-STK-001",
      category: "Stickers",
      description: "Marka ambalajları için mat laminasyonlu özel sticker paketi.",
      color: "Tam renk",
      price: 24.9,
      sale_price: 19.9,
      width: 10,
      height: 10,
      depth: 0.1,
      weight: 0.2,
      stock: 120,
      image_path: "https://new-ella-demo-07.myshopify.com/cdn/shop/files/product-1.jpg?v=1750319850&width=500"
    },
    {
      name: "A4 Poster Print",
      sku: "PR-POS-A4",
      category: "Posters",
      description: "Premium saten kağıda yüksek çözünürlüklü A4 poster baskı.",
      color: "CMYK",
      price: 39,
      sale_price: 29,
      width: 21,
      height: 29.7,
      depth: 0.1,
      weight: 0.08,
      stock: 80,
      image_path: "https://new-ella-demo-07.myshopify.com/cdn/shop/files/product-laptop-1_8ba38545-e982-4cc5-a601-9f7adb782d6f.jpg?v=1750319712&width=500"
    },
    {
      name: "Business Card Set",
      sku: "PR-BC-250",
      category: "Cards",
      description: "Soft touch yüzeyli 250 adet çift taraflı kartvizit.",
      color: "Beyaz",
      price: 59,
      sale_price: 49,
      width: 8.5,
      height: 5.5,
      depth: 0.03,
      weight: 0.4,
      stock: 65,
      image_path: "https://new-ella-demo-07.myshopify.com/cdn/shop/files/product-app-4_23546feb-c1d6-4645-819e-10afcda659f6.jpg?v=1750319766&width=500"
    }
  ].forEach((product) => seedProduct.run(product));

  // Give the seeded products a few palette colours so the storefront swatches
  // are not empty on a fresh install.
  const linkColor = db.prepare(`
    INSERT OR IGNORE INTO product_colors (product_id, color_id)
    SELECT ?, id FROM colors WHERE name = ?
  `);
  [
    [1, ["Beyaz", "Turuncu", "Siyah"]],
    [2, ["Mavi", "Sarı", "Pembe"]],
    [3, ["Beyaz", "Siyah"]]
  ].forEach(([productId, names]) => names.forEach((name) => linkColor.run(productId, name)));
}

const existingSlides = db.prepare("SELECT COUNT(*) count FROM hero_slides").get().count;
if (!existingSlides) {
  const seedSlide = db.prepare(`
    INSERT INTO hero_slides (image_path, title, subtitle, primary_label, primary_href, secondary_label, secondary_href, sort_order)
    VALUES (@image_path, @title, @subtitle, @primary_label, @primary_href, @secondary_label, @secondary_href, @sort_order)
  `);
  [
    {
      image_path: "https://images.unsplash.com/photo-1572044162444-ad60f128bdea?auto=format&fit=crop&w=1800&q=75",
      title: "Markanız İçin Özel Baskı Ürünleri",
      subtitle: "Sticker, poster, kartvizit ve ambalaj çözümleri",
      primary_label: "STL yükle, fiyat al",
      primary_href: "/stl-teklif",
      secondary_label: "Ürünleri incele",
      secondary_href: "#store-products",
      sort_order: 1
    },
    {
      image_path: "https://images.unsplash.com/photo-1503694978374-8a2fa686963a?auto=format&fit=crop&w=1800&q=75",
      title: "Ofset Kalitesinde Seri Baskı",
      subtitle: "Net fiyat, hızlı üretim ve zamanında teslimat",
      primary_label: "Ürünleri incele",
      primary_href: "#store-products",
      secondary_label: "Teklif al",
      secondary_href: "/stl-teklif",
      sort_order: 2
    },
    {
      image_path: "https://images.unsplash.com/photo-1622547748225-3fc4abd2cca0?auto=format&fit=crop&w=1800&q=75",
      title: "3D Modelinizi Yükleyin, Fiyatı Görün",
      subtitle: "STL dosyanızı yükleyin, anında teklif alın",
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
  const ogImage = absoluteUrl(req, page.og_image, site.site_url);
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

function sendPage(req, res, file, slug) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  res.type("html").send(html.replace("<!--seo-->", seoHead(req, slug)));
}

app.get("/", (req, res) => sendPage(req, res, "index.html", "home"));
app.get("/stl-teklif", (req, res) => sendPage(req, res, "stl-teklif.html", "stl-teklif"));
["styles.css", "script.js", "stl-viewer.js", "admin.css", "admin.js"].forEach((file) => {
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
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.get("/api/stats", requireAdmin, (req, res) => {
  const stats = {
    products: db.prepare("SELECT COUNT(*) count FROM products").get().count,
    customers: db.prepare("SELECT COUNT(*) count FROM customers").get().count,
    orders: db.prepare("SELECT COUNT(*) count FROM orders").get().count,
    revenue: db.prepare("SELECT COALESCE(SUM(total), 0) total FROM orders").get().total,
    quotes: db.prepare("SELECT COUNT(*) count FROM quotes WHERE status = 'new'").get().count
  };
  res.json(stats);
});

const colorsOfProduct = db.prepare(`
  SELECT colors.* FROM colors
  JOIN product_colors ON product_colors.color_id = colors.id
  WHERE product_colors.product_id = ?
  ORDER BY colors.sort_order ASC, colors.id ASC
`);

const withColors = (product) => ({ ...product, colors: colorsOfProduct.all(product.id) });

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

app.get("/api/products", (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all();
  res.json(products.map(withColors));
});

app.post("/api/products", requireAdmin, upload.single("image"), (req, res) => {
  const product = productPayload(req.body, req.file);
  if (!product.name) return res.status(400).json({ error: "Ürün adı zorunludur." });

  const result = db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path, image_alt, meta_title, meta_description, is_active)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path, @image_alt, @meta_title, @meta_description, @is_active)
  `).run(product);

  setProductColors(result.lastInsertRowid, req.body.color_ids);
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
      meta_title=@meta_title, meta_description=@meta_description, is_active=@is_active,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run(product);

  setProductColors(current.id, req.body.color_ids);
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
      color_change_fee=@color_change_fee, updated_at=CURRENT_TIMESTAMP
    WHERE id=1
  `).run({
    setup_fee: Math.max(0, Number(req.body.setup_fee) || 0),
    size_fee_per_cm: Math.max(0, Number(req.body.size_fee_per_cm) || 0),
    min_order_total: Math.max(0, Number(req.body.min_order_total) || 0),
    shell_share: Math.min(1, Math.max(0, Number.isFinite(shell) ? shell : 0.15)),
    color_change_fee: Math.max(0, Number(req.body.color_change_fee) || 0)
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
      logo_path=@logo_path, social_links=@social_links, updated_at=CURRENT_TIMESTAMP
    WHERE id=1
  `).run({
    site_name: req.body.site_name?.trim() || null,
    site_url: req.body.site_url?.trim().replace(/\/$/, "") || null,
    description: req.body.description?.trim() || null,
    logo_path: req.body.logo_path?.trim() || null,
    social_links: req.body.social_links?.trim() || null
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

app.get("/admin", requireAdmin, (req, res) => res.sendFile(path.join(ROOT, "admin.html")));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Printable running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Local admin login: ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
  });
}

module.exports = app;

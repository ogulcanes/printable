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
/* Varsayılanlar yalnızca yerel geliştirme içindir. Canlıda SESSION_SECRET unutulursa
   sır depoda yazılı olduğu için herkes kendine geçerli bir admin çerezi imzalayabilir.
   Bu durumda sunucuyu komple düşürmüyoruz — vitrin çalışmaya devam etsin — ama
   admin girişini kapatıyoruz: müşteriye kapalı dükkan, saldırgana açık kasa demek. */
const IS_PRODUCTION = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
const ADMIN_LOCKED = IS_PRODUCTION && ["ADMIN_PASSWORD", "SESSION_SECRET"].some((key) => !process.env[key]);
if (ADMIN_LOCKED) {
  console.error("UYARI: ADMIN_PASSWORD veya SESSION_SECRET tanımlı değil — admin paneli kilitlendi.");
}
const SESSION_COOKIE = "printable_admin";
const CUSTOMER_SESSION_COOKIE = "printable_customer";
/* İlk kurulumda açılacak panel hesapları. Sadece admin_users tablosu boşken
   kullanılır; sonrası panelden yönetilir. ADMIN_USER da listeye katılır ki
   eski tek-hesap kurulumları giriş yapabilmeye devam etsin. */
const SEED_ADMIN_USERS = [...new Set(
  (process.env.ADMIN_USERS || "ogulcan,furkan").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean).concat(ADMIN_USER.toLowerCase())
)];
const KDV_RATE = 20; // Ürün fiyatları KDV dahildir; faturada bu oranla ayrıştırılır.
const FREE_SHIPPING_THRESHOLD = 599; // İndirim sonrası KDV dâhil ürün toplamı.

/* Şifreler scrypt ile saklanır: her hesaba rastgele salt, sabit-zamanlı karşılaştırma.
   Biçim: scrypt$<salt-hex>$<hash-hex>. Düz metin şifre hiçbir yere yazılmaz. */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(String(plain), salt, 64).toString("hex")}`;
}

/* Var olmayan kullanıcı için de gerçek bir özet doğrulaması yapabilelim diye:
   giriş denemesinin süresi "bu kullanıcı adı kayıtlı mı" sorusunu ele vermesin. */
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(32).toString("hex"));

function verifyPassword(plain, stored) {
  const [scheme, salt, expected] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Şema, migration ve seed artık asenkron. Modül yüklenirken bir kez başlar;
   `dbReady` sözü tutulana kadar hiçbir istek veritabanına dokunamaz (aşağıdaki
   hazırlık kapısına bakın). Vercel'de her soğuk başlatmada tekrar çalışır ama
   hepsi IF NOT EXISTS / boşsa-ekle olduğu için ikinci kez zararsızdır. */
/* Şema sürümü. Şemayı, migration listesini veya seed'i değiştirdiğinizde bunu
   artırın; bir sonraki açılışta kurulum yeniden çalışır. */
const SCHEMA_VERSION = "14";

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
    unit_cost REAL,
    cost_inputs TEXT,
    cost_updated_at TIMESTAMPTZ,
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

  CREATE TABLE IF NOT EXISTS customer_accounts (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    password_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS customer_password_resets (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(account_id) REFERENCES customer_accounts(id) ON DELETE CASCADE
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
    density_g_cm3 REAL NOT NULL DEFAULT 1.24,
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
    show_stock INTEGER NOT NULL DEFAULT 1,
    track_stock INTEGER NOT NULL DEFAULT 0,
    min_cart_total REAL NOT NULL DEFAULT 0,
    company_title TEXT,
    legal_address TEXT,
    tax_office TEXT,
    tax_number TEXT,
    mersis TEXT,
    return_address TEXT,
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

  /* Katlaç kataloğu — YALNIZCA panelde görünen özel liste.

     Bilerek products tablosundan ayrı: products'taki her satır /api/products
     ile herkese açık dönüyor (gizli olanlar bile), yani oraya koysaydım
     "sadece ben göreyim" isteği ilk günden kırılırdı. Buradaki hiçbir kayıt
     hiçbir vitrin ucundan çıkmaz; tüm rotaları requireAdmin arkasında.

     Vitrine taşınmak istendiğinde ürün olarak ayrıca eklenir — bu tablo
     fiyat çalışması ve iç envanter için. */
  CREATE TABLE IF NOT EXISTS katlac_items (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'İsimsiz katlaç',
    price REAL NOT NULL DEFAULT 0,
    image_path TEXT NOT NULL,
    note TEXT,
    source_url TEXT,
    model_key TEXT,
    model_name TEXT,
    /* Vitrine çıkarıldıysa üretilen ürünün id'si. Bağ tek yönlü ve gevşek:
       FOREIGN KEY YOK, çünkü bu kolon var olan veritabanlarına ALTER TABLE ile
       ekleniyor ve migration listesi kısıt ekleyemiyor — kısıtı yalnızca yeni
       kurulumlara koymak, iki ortamı sessizce farklı davranan hâle getirirdi.
       Ürün silinirse id boşta kalır; okuyan taraf ürünü bulamayınca katlacı
       "vitrinde değil" sayar ve yeniden çıkarmaya izin verir. */
    product_id INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  /* Ürün başına ÖLÇEK başına maliyet VE satış fiyatı. Bir katlaç büyük/küçük
     boyda farklı filament ve süre tükettiği için tek maliyet yetmiyor. Her
     satır bir ölçeğin (etiket) girdileri, hesaplanan net maliyeti ve o
     maliyetten çıkan kârlı satış fiyatı.

     price DOLUYSA ölçek müşteriye açık bir VARYANT olur: ürün sayfasında
     seçilir, sepete o ölçeğin fiyatıyla girer (tekstildeki beden/renk gibi).
     Boşsa ölçek yalnızca iç maliyet kaydıdır ve mağazada görünmez.

     products.unit_cost bu satırların EN DÜŞÜĞÜ olarak özetleniyor — liste
     rozeti ve public gizleme onu kullandığı için bozmuyoruz. */
  CREATE TABLE IF NOT EXISTS product_cost_scales (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id INTEGER NOT NULL,
    scale TEXT NOT NULL DEFAULT 'Standart',
    unit_cost REAL NOT NULL DEFAULT 0,
    price REAL,
    inputs TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (product_id, scale),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  /* Ürün galerisi. products.image_path "kapak" olarak kalır — ürün kartları,
     paylaşım görseli ve arama sonuçları onu kullanır; burası ek fotoğraflar.
     color_id doluysa fotoğraf o renge aittir: müşteri rengi seçince galeri
     o rengin fotoğraflarına geçer. Boşsa fotoğraf ürünün geneline aittir. */
  CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id INTEGER NOT NULL,
    color_id INTEGER,
    image_path TEXT NOT NULL,
    image_alt TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY(color_id) REFERENCES colors(id) ON DELETE SET NULL
  );

  /* Kampanyayı kim, ne zaman, ne kadar indirimle kullandı. used_count'un
     kendisi tek bir sayı; "kim kullandı" sorusunu ancak bu tablo yanıtlar.
     Sipariş silinirse kayıt da gider, ama müşteri adı burada kopyalanmış
     durur ki geçmiş rapor bozulmasın. */
  CREATE TABLE IF NOT EXISTS campaign_uses (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    order_id INTEGER,
    order_number TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    discount_amount REAL NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
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

  -- Panel yöneticileri. Şifreler scrypt ile saltlanıp özetlenir, asla düz metin tutulmaz.
  -- password_version her şifre değişiminde artar; oturum çerezi bu değeri taşıdığı için
  -- şifre değişince o kullanıcının açık oturumları anında geçersizleşir.
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    -- Sipariş edilen ölçek ADI, kopyalanarak. Ölçek sonradan silinse ya da adı
    -- değişse bile atölye ne bastığını sipariş kaleminden okuyabilsin.
    scale TEXT,
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
  /* Ürün başına maliyet. unit_cost hızlı gösterim için (liste, kâr marjı),
     cost_inputs ise hesabın girdilerinin anlık görüntüsü: aylar sonra "bu
     25,48 nereden çıktı" sorusunun yanıtı ve yeniden hesaplamak için. */
  ["products", "unit_cost", "REAL"],
  ["products", "cost_inputs", "TEXT"],
  ["products", "cost_updated_at", "TIMESTAMPTZ"],
  /* Ölçeğin satış fiyatı (maliyet + hedef kâr marjı). Doluysa ölçek müşteriye
     açık bir varyanttır; sipariş kalemine hangi ölçeğin gittiği yazılır. */
  ["product_cost_scales", "price", "REAL"],
  ["order_items", "scale", "TEXT"],
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
  /* Mağaza ayarları. min_cart_total, pricing_settings.min_order_total ile
     KARIŞTIRILMAMALI: o STL teklifinin fiyat tabanı, bu ise sepetin altına
     inemeyeceği tutar. */
  ["site_settings", "show_stock", "INTEGER NOT NULL DEFAULT 1"],
  /* Stok TAKİBİ, stok GÖSTERİMİnden ayrı: show_stock sadece sayıyı sitede
     gösterir, track_stock ise siparişte stoğu düşürür ve yetmeyen sepeti
     reddeder. Varsayılan kapalı — mevcut davranış bu ve açmak iş akışını
     değiştiren bir karar, sessizce başlatılmamalı. */
  ["site_settings", "track_stock", "INTEGER NOT NULL DEFAULT 0"],
  /* Katlaç kaynağı: MakerWorld vb. modelin linki ve yüklenen STL/3MF.
     model_key gizli "models" kovasında; indirmek imzalı adres gerektirir. */
  ["katlac_items", "source_url", "TEXT"],
  ["katlac_items", "model_key", "TEXT"],
  ["katlac_items", "model_name", "TEXT"],
  // Katlaçtan üretilen vitrin ürünü (bkz. tablo tanımındaki not).
  ["katlac_items", "product_id", "INTEGER"],
  ["site_settings", "min_cart_total", "REAL NOT NULL DEFAULT 0"],
  /* Satıcı kimliği — mesafeli satış sözleşmesi ve iade sayfaları bunlardan
     üretilir. Boş bırakılırsa sayfalar eksik olduklarını açıkça yazar. */
  ["site_settings", "company_title", "TEXT"],
  ["site_settings", "legal_address", "TEXT"],
  ["site_settings", "tax_office", "TEXT"],
  ["site_settings", "tax_number", "TEXT"],
  ["site_settings", "mersis", "TEXT"],
  ["site_settings", "return_address", "TEXT"],
  // Siparişe uygulanan kampanyaların anlık görüntüsü (kampanya sonradan silinse
  // bile siparişte ne uygulandığı kaybolmasın diye isimleriyle saklanır).
  ["orders", "campaign_summary", "TEXT"],
  // Renamed: the floor applies to the order total, not to the unit price.
  ["pricing_settings", "min_order_total", "REAL NOT NULL DEFAULT 150"],
  // Each extra colour means a filament swap: purge waste plus machine time.
  ["pricing_settings", "color_change_fee", "REAL NOT NULL DEFAULT 35"],
  // Used for the customer's approximate filament/resin weight calculation.
  ["materials", "density_g_cm3", "REAL"],
  // Per-part STL the workshop can drop straight into a slicer.
  ["quote_parts", "file_path", "TEXT"],
  ["quote_parts", "name", "TEXT"],
  // Surface-painted 3MF: the paint only survives in the original file.
  ["quotes", "painted", "INTEGER NOT NULL DEFAULT 0"]
]) {
  if (!(await hasColumn(table, column))) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

await db.exec(`
  UPDATE materials SET density_g_cm3 = CASE
    WHEN LOWER(name) LIKE '%petg%' THEN 1.27
    WHEN LOWER(name) LIKE '%abs%' THEN 1.04
    WHEN LOWER(name) LIKE '%reçine%' OR LOWER(name) LIKE '%resin%' THEN 1.10
    ELSE 1.24
  END
  WHERE density_g_cm3 IS NULL
`);

const existingMaterials = (await db.prepare("SELECT COUNT(*) count FROM materials").get()).count;
if (!existingMaterials) {
  const seedMaterial = db.prepare(`
    INSERT INTO materials (name, description, price_per_cm3, density_g_cm3, sort_order)
    VALUES (@name, @description, @price_per_cm3, @density_g_cm3, @sort_order)
  `);
  // PLA keeps the 8.50 TL/cm3 rate the old hardcoded formula used, so prices do not move.
  const materials = [
    { name: "PLA", description: "Standart, ekonomik, iç mekan kullanımı", price_per_cm3: 8.5, density_g_cm3: 1.24 },
    { name: "PETG", description: "Dayanıklı, ısıya ve neme daha dirençli", price_per_cm3: 11, density_g_cm3: 1.27 },
    { name: "ABS", description: "Mekanik parçalar, yüksek sıcaklık dayanımı", price_per_cm3: 10, density_g_cm3: 1.04 },
    { name: "Reçine (SLA)", description: "Yüksek detay, pürüzsüz yüzey", price_per_cm3: 18, density_g_cm3: 1.10 }
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
  },
  {
    slug: "katalog", label: "Katalog sayfası",
    title: "Ürün Kataloğu ve Toplu Alım Fiyatları | Printable",
    description: "Tüm 3D baskı ürünleri, renk seçenekleri ve adede göre inen toplu alım fiyatları tek sayfada.",
    og_title: "Ürün Kataloğu ve Toplu Alım Fiyatları | Printable",
    og_description: "Renkleriyle birlikte tüm ürünler ve toplu alım kademeleri."
  },
  {
    slug: "mesafeli-satis", label: "Mesafeli satış sözleşmesi",
    title: "Mesafeli Satış Sözleşmesi | Printable",
    description: "Printable mesafeli satış sözleşmesi: taraflar, teslimat, ödeme, cayma hakkı ve uyuşmazlık çözümü.",
    og_title: "Mesafeli Satış Sözleşmesi | Printable",
    og_description: "Sipariş koşullarımız ve yasal haklarınız."
  },
  {
    slug: "iade", label: "İade ve cayma hakkı sayfası",
    title: "İade, Değişim ve Cayma Hakkı | Printable",
    description: "14 gün içinde koşulsuz iade. İade süreci, kargo bedeli ve siparişe özel baskılardaki istisna.",
    og_title: "İade ve Cayma Hakkı | Printable",
    og_description: "14 gün içinde iade edin; süreci adım adım anlattık."
  },
  {
    slug: "gizlilik", label: "Gizlilik ve KVKK sayfası",
    title: "Gizlilik Politikası ve KVKK Aydınlatma Metni | Printable",
    description: "Hangi verilerinizi neden topluyoruz, ne kadar saklıyoruz ve KVKK kapsamındaki haklarınız neler?",
    og_title: "Gizlilik Politikası ve KVKK | Printable",
    og_description: "Verilerinizi nasıl işlediğimizi sade bir dille açıkladık."
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
    logo_path: "/assets/printable-logo.png",
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

// Panel yöneticileri: tablo boşsa ADMIN_USERS'taki isimler ADMIN_PASSWORD ile açılır.
// Şifreler bundan sonra panelden değiştirilir; env yalnızca ilk kurulumu tohumlar.
const adminCount = await db.prepare("SELECT COUNT(*)::int AS count FROM admin_users").get();
if (!adminCount.count) {
  const seedAdmin = db.prepare(
    "INSERT INTO admin_users (username, password_hash) VALUES (@username, @password_hash) ON CONFLICT (username) DO NOTHING"
  );
  for (const username of SEED_ADMIN_USERS) {
    await seedAdmin.run({ username, password_hash: hashPassword(ADMIN_PASSWORD) });
  }
}

/* Eski tek-maliyet kayıtlarını ölçek tablosuna taşı. Bir kez çalışır:
   ölçek tablosu boşsa ve products.unit_cost dolu ürünler varsa, her birini
   cost_inputs.olcek etiketiyle (yoksa "Standart") bir ölçek satırına dönüştür.
   Böylece daha önce atanmış maliyetler (Creeper, TNT, Basketbol...) kaybolmaz. */
const scaleCount = await db.prepare("SELECT COUNT(*)::int AS count FROM product_cost_scales").get();
if (!scaleCount.count) {
  const eskiler = await db.prepare("SELECT id, unit_cost, cost_inputs FROM products WHERE unit_cost IS NOT NULL").all();
  const tasi = db.prepare(`
    INSERT INTO product_cost_scales (product_id, scale, unit_cost, inputs)
    VALUES (?, ?, ?, ?) ON CONFLICT (product_id, scale) DO NOTHING
  `);
  for (const p of eskiler) {
    let olcek = "Standart";
    try { const j = JSON.parse(p.cost_inputs); if (j?.olcek?.trim()) olcek = j.olcek.trim(); } catch { /* etiketsiz */ }
    await tasi.run(p.id, olcek, p.unit_cost, p.cost_inputs);
  }
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
/* Sözü SADECE başarılıysa önbellekle. Eskiden tek bir söz tutuluyordu ve soğuk
   başlatma sırasında Supabase'e bağlanma bir kez takılırsa o red kalıcı olarak
   saklanıyordu: o fonksiyon örneğine düşen her istek, veritabanı çoktan ayağa
   kalkmış olsa bile, örnek geri dönüşene kadar 503 alıyordu. Başarısızlıkta
   önbelleği boşaltıyoruz ki sonraki istek yeniden denesin. */
let dbReadyPromise = null;

function ensureDbReady() {
  if (!dbReadyPromise) {
    dbReadyPromise = initDb().then(
      () => console.log("Veritabanı hazır."),
      (error) => {
        console.error("VERİTABANI BAŞLATILAMADI:", error.message);
        dbReadyPromise = null;
        throw error;
      }
    );
  }
  return dbReadyPromise;
}

// Soğuk başlatmada kuruluma hemen başla; ilk istek beklerken ilerlemiş olsun.
// catch şart: kimse beklemeden reddedilirse Node süreci düşürür.
ensureDbReady().catch(() => {});

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
    await ensureDbReady();
    next();
  } catch {
    // Kurulum bir sonraki istekte yeniden denenecek; istemciye de bunu söyle.
    res.set("Retry-After", "2");
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
  if (kind === "image" && !(await isAuthed(req))) {
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
// Tarayicinin otomatik istegi 404 uretmesin.
app.get("/favicon.ico", async (req, res) => res.redirect(301, "/assets/favicon-32.png"));
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
/* Sekme ikonu. Tarayıcı istemesek de /favicon.ico istiyor; tanımlamazsak
   her sayfa yüklemesinde 404 üretiyor ve sekmede boş ikon görünüyor. */
const FAVICON_TAGS = [
  `<link rel="icon" href="/assets/favicon-32.png" type="image/png" sizes="32x32">`,
  `<link rel="icon" href="/assets/favicon-512.png" type="image/png" sizes="512x512">`,
  `<link rel="apple-touch-icon" href="/assets/favicon-180.png" sizes="180x180">`,
].join("\n");

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
    FAVICON_TAGS,
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
    <div class="top-strip">
      <div class="container top-strip__inner">
        <span>599 TL ve üzeri siparişlerde ücretsiz kargo</span>
        <span>Güvenli alışveriş · Siparişe özel üretim</span>
      </div>
    </div>
    <header class="site-header">
      <div class="container header-main">
        <a class="logo printable-logo" href="/" aria-label="Printable ana sayfa">
          <img src="/assets/printable-logo-transparent.png" alt="Printable">
        </a>
        <!-- Yalnızca mobilde görünür; menüyü açar. -->
        <button class="nav-toggle" type="button" id="nav-toggle"
                aria-label="Menüyü aç" aria-expanded="false" aria-controls="main-links">
          <span></span><span></span><span></span>
        </button>
        <nav class="main-links" id="main-links" aria-label="Ana menü">
          ${await link("/", "Ana Sayfa", "home")}
          ${await link("/urunler", "Ürünler", "urunler")}
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
          <a class="admin-link icon-button" href="/hesap" aria-label="Müşteri hesabım">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
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
        <p class="cart-note" id="cart-shipping-note">599 TL ve üzeri ücretsiz kargo</p>
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
        <div><h3>Kurumsal</h3><a href="/katalog">Katalog</a><a href="/hakkinda">Hakkımızda</a><a href="/iletisim">İletişim</a><a href="/stl-teklif">Özel 3D baskı</a><a href="/urunler">Tüm ürünler</a></div>
        <div><h3>Müşteri Desteği</h3><a href="/iletisim">Bize ulaşın</a><a href="/iade">İade & Değişim</a><a href="/sss">Kargo</a><a href="/sss">S.S.S.</a></div>
        <div><h3>Yasal</h3><a href="/mesafeli-satis">Mesafeli Satış Sözleşmesi</a><a href="/iade">İade ve Cayma Hakkı</a><a href="/gizlilik">Gizlilik ve KVKK</a></div>
        <div class="footer-logo printable-wordmark">
          <a class="footer-brand-logo" href="/" aria-label="Printable ana sayfa">
            <img src="/assets/printable-logo-transparent.png" alt="Printable">
          </a>
          <p>Hazır 3D modellerden özenle üretilen baskı ürünleri.</p>
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
  const whatsapp = wa ? `
      <a class="chat" href="https://wa.me/${wa}" target="_blank" rel="noopener" aria-label="WhatsApp'tan yazın">
        <svg viewBox="0 0 24 24" aria-hidden="true">${SOCIAL_ICONS.whatsapp}</svg>
      </a>` : "";
  return `
    <div class="mobile-sticky-actions">
      <a class="mobile-products-cta" href="/urunler">Ürünleri gör</a>
      ${whatsapp}
    </div>`;
}

async function injectShell(html, headActive) {
  return html
    .replace("<!--header-->", await renderHeader(headActive))
    .replace("<!--cart-->", renderCartPanel())
    .replace("<!--footer-->", await renderFooter())
    .replace("<!--chat-->", await renderChatButton());
}

/* Satıcı kimliği yasal sayfalarda TEK yerden gelir: /admin → Ayarlar. Metni
   HTML'e gömmek, unvan ya da adres değiştiğinde üç sayfayı birden güncellemeyi
   unutmak demekti — mesafeli satış sözleşmesinde yanlış satıcı bilgisi ise
   sayfayı hükümsüz kılar. Doldurulmamış alanı gizlemiyoruz; eksik olduğunu
   açıkça yazıyoruz ki yarım bir sözleşme tam görünmesin. */
async function renderSellerBlock() {
  const s = await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
  // MERSİS her satıcıda olmaz (şahıs şirketinde yok); boşsa satırı hiç gösterme.
  // Diğerleri yasal zorunluluk: boş olsalar bile satır kalsın ki eksik görünsün.
  const zorunlu = new Set(["Unvan", "Adres", "Telefon", "E-posta", "Vergi dairesi", "Vergi / TC kimlik no"]);
  const goster = [
    ["Unvan", s.company_title],
    ["Adres", s.legal_address],
    ["Telefon", s.phone],
    ["E-posta", s.email],
    ["Vergi dairesi", s.tax_office],
    ["Vergi / TC kimlik no", s.tax_number],
    ["MERSİS no", s.mersis]
  ].filter(([etiket, deger]) => deger?.trim() || zorunlu.has(etiket));
  const eksik = goster.filter(([, deger]) => !deger?.trim()).map(([etiket]) => etiket);

  const govde = goster.map(([etiket, deger]) => `
    <tr><th>${escapeHtml(etiket)}</th><td>${deger?.trim()
      ? escapeHtml(deger)
      : '<span class="legal-missing">Belirtilmemiş</span>'}</td></tr>`).join("");

  /* Uyarı hangi alanların eksik olduğunu ve nereden doldurulacağını söylemeli:
     telefon ile e-posta SEO sekmesinde, diğerleri Ayarlar'da duruyor. Sadece
     "eksik" demek, Ayarlar'ı eksiksiz doldurup uyarının neden geçmediğini
     anlamayan bir yöneticiye hiçbir şey anlatmıyordu. */
  const seoSekmesi = new Set(["Telefon", "E-posta"]);
  const nerede = eksik.some((e) => seoSekmesi.has(e))
    ? (eksik.every((e) => seoSekmesi.has(e)) ? "<em>SEO</em>" : "<em>Ayarlar</em> ve <em>SEO</em>")
    : "<em>Ayarlar</em>";

  const uyari = eksik.length
    ? `<p class="legal-warning legal-warning--admin"><strong>Bu sayfa henüz eksik.</strong> Şu alanlar doldurulmamış: <strong>${eksik.map(escapeHtml).join(", ")}</strong>. Sayfanın yasal olarak geçerli olması için yönetim panelindeki ${nerede} bölümünden tamamlanmalıdır.</p>`
    : "";

  return `${uyari}<table class="legal-table legal-table--seller"><tbody>${govde}</tbody></table>`;
}

async function renderReturnAddress() {
  const s = await db.prepare("SELECT return_address, legal_address, company_title FROM site_settings WHERE id = 1").get() || {};
  const adres = s.return_address?.trim() || s.legal_address?.trim();
  if (!adres) {
    return '<p class="legal-warning legal-warning--admin"><strong>İade adresi belirtilmemiş.</strong> Yönetim panelindeki <em>Ayarlar</em> bölümünden ekleyin.</p>';
  }
  return `<p class="legal-address">${s.company_title?.trim() ? `<strong>${escapeHtml(s.company_title)}</strong><br>` : ""}${escapeHtml(adres).replace(/\n/g, "<br>")}</p>`;
}

const guncellemeSatiri = () =>
  `Son güncelleme: ${new Date().toLocaleDateString("tr-TR", { year: "numeric", month: "long", day: "numeric" })}`;

async function sendPage(req, res, file, slug) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  let sayfa = html.replace("<!--seo-->", await seoHead(req, slug));
  // Yasal sayfa yer tutucuları — diğer sayfalarda bunlar zaten yok, replace no-op.
  if (sayfa.includes("<!--satici-->")) sayfa = sayfa.replaceAll("<!--satici-->", await renderSellerBlock());
  if (sayfa.includes("<!--iade-adresi-->")) sayfa = sayfa.replace("<!--iade-adresi-->", await renderReturnAddress());
  if (sayfa.includes("<!--guncelleme-->")) sayfa = sayfa.replace("<!--guncelleme-->", guncellemeSatiri());
  res.type("html").send(await injectShell(sayfa, slug));
}

app.get("/", async (req, res) => await sendPage(req, res, "index.html", "home"));
app.get("/urunler", async (req, res) => await sendPage(req, res, "urunler.html", "urunler"));
app.get("/stl-teklif", async (req, res) => await sendPage(req, res, "stl-teklif.html", "stl-teklif"));
app.get("/hakkinda", async (req, res) => await sendPage(req, res, "hakkinda.html", "hakkinda"));
app.get("/iletisim", async (req, res) => await sendPage(req, res, "iletisim.html", "iletisim"));
app.get("/hesap", async (req, res) => await sendPage(req, res, "hesap.html", "hesap"));
app.get("/sss", async (req, res) => await sendPage(req, res, "sss.html", "sss"));
app.get("/mesafeli-satis", async (req, res) => await sendPage(req, res, "mesafeli-satis.html", "mesafeli-satis"));
app.get("/iade", async (req, res) => await sendPage(req, res, "iade.html", "iade"));
app.get("/gizlilik", async (req, res) => await sendPage(req, res, "gizlilik.html", "gizlilik"));
app.get("/katalog", async (req, res) => await sendPage(req, res, "katalog.html", "katalog"));

// Per-product SEO: crawlers need real title/description/og:image/JSON-LD in the HTML
// (the visible detail is filled by urun.js, matching the rest of the JS-rendered site).
async function productMetaTags(req, product) {
  const site = await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
  const title = product.meta_title || `${product.name} | Printable`;
  const description = product.meta_description || product.description || site.description || "";
  const canonical = absoluteUrl(req, `/urun/${product.id}`, site.site_url);
  const image = absoluteUrl(req, product.image_path || site.default_og_image, site.site_url);
  /* Ölçekli ürünün tek bir fiyatı yok. Böyle ürünlerde teklif AggregateOffer
     olur: arama sonucunda "120–260 TL" aralığı görünür, tek fiyat yazıp
     müşteriyi yanıltmamış oluruz. */
  const olcekler = satisOlcekleri(await db.prepare(
    "SELECT id, scale, price FROM product_cost_scales WHERE product_id = ?"
  ).all(product.id), product.sale_price || product.price);
  const price = Number(
    (olcekler.length ? olcekler[0].price : product.sale_price || product.price) || 0
  ).toFixed(2);

  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    FAVICON_TAGS,
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
    offers: olcekler.length > 1
      ? {
          "@type": "AggregateOffer",
          lowPrice: price,
          highPrice: Number(olcekler[olcekler.length - 1].price).toFixed(2),
          offerCount: olcekler.length,
          priceCurrency: "TRY",
          availability: product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          url: canonical
        }
      : {
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
  // withColors await edilmezse productMetaTags'e ürün yerine Promise gider ve
  // başlık "undefined | Printable" olur.
  const decorated = await withColors(product);
  res.type("html").send(await injectShell(html.replace("<!--seo-->", await productMetaTags(req, decorated)), "urunler"));
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
    ["User-agent: *", "Allow: /", "Disallow: /admin", "Disallow: /login", "Disallow: /hesap", "Disallow: /api/", "Disallow: /odeme", "", `Sitemap: ${base}/sitemap.xml`, ""].join("\n")
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
    { loc: "/katalog", priority: "0.8" },
    { loc: "/mesafeli-satis", priority: "0.3" },
    { loc: "/iade", priority: "0.4" },
    { loc: "/gizlilik", priority: "0.3" },
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

["styles.css", "script.js", "stl-viewer.js", "admin.css", "admin.js", "urunler.js", "urun.js", "odeme.js", "iletisim.js", "katalog.js", "hesap.js"].forEach((file) => {
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

/* Çerez biçimi: <kullanıcı>.<şifre-sürümü>.<bitiş>.<imza>
   İmza çerezi bizim ürettiğimizi kanıtlar, ama yetkiyi çerezin iddiasına değil
   veritabanına soruyoruz: hesap silinmişse ya da şifresi değişmişse (sürüm artar)
   eldeki çerez anında geçersiz olur. Kullanıcı adları nokta içeremez — parçalamayı
   bozardı; createAdminUser bunu zorunlu kılıyor. */
async function currentAdmin(req) {
  if (ADMIN_LOCKED) return null;
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const [user, version, expires, signature] = raw.split(".");
  if (!user || !version || !expires || !signature || Number(expires) < Date.now()) return null;
  const expected = signSession(`${user}.${version}.${expires}`);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const row = await db.prepare("SELECT id, username, password_version FROM admin_users WHERE username = ?").get(user);
  if (!row || String(row.password_version) !== version) return null;
  return row;
}

const isAuthed = async (req) => Boolean(await currentAdmin(req));

async function requireAdmin(req, res, next) {
  const admin = await currentAdmin(req);
  if (admin) {
    req.admin = admin;
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Admin login required." });
  return res.redirect("/login");
}

function setSessionCookie(res, admin) {
  const expires = Date.now() + 1000 * 60 * 60 * 12;
  const value = `${admin.username}.${admin.password_version}.${expires}`;
  // Canlıda Secure: çerez düz metin bağlantıya asla düşmesin. Yerelde http olduğu için kapalı.
  const secure = IS_PRODUCTION ? " Secure;" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(`${value}.${signSession(value)}`)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=43200`);
}

app.get("/login", async (req, res) => {
  if (await currentAdmin(req)) return res.redirect("/admin");
  return res.sendFile(path.join(ROOT, "login.html"));
});

app.post("/api/login", async (req, res) => {
  if (ADMIN_LOCKED) return res.status(503).json({ error: "Yönetim paneli yapılandırma eksikliği nedeniyle kapalı." });
  const username = String(req.body.username || "").trim().toLowerCase();
  const row = await db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username);
  /* Kullanıcı yoksa da özet doğrulaması çalıştırılır: aksi halde yanıt süresi
     "bu kullanıcı var mı" sorusunu ele verir. */
  const ok = verifyPassword(req.body.password, row ? row.password_hash : DUMMY_PASSWORD_HASH);
  if (row && ok) {
    setSessionCookie(res, row);
    return res.json({ ok: true, user: row.username });
  }
  return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
});

app.post("/api/logout", async (req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/session", async (req, res) => {
  const admin = await currentAdmin(req);
  res.json({ authed: Boolean(admin), user: admin ? admin.username : null });
});

/* ---------- Müşteri hesabı ----------
   Admin ve müşteri çerezleri tamamen ayrıdır. Şifre sürümü çerezde taşınır;
   şifre yenilenince açık müşteri oturumlarının tamamı anında geçersizleşir. */
const normalizeCustomerEmail = (value) => String(value || "").trim().toLowerCase();
const validCustomerEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(value);

async function currentCustomer(req) {
  const raw = parseCookies(req)[CUSTOMER_SESSION_COOKIE];
  if (!raw) return null;
  const [id, version, expires, signature] = raw.split(".");
  if (!id || !version || !expires || !signature || Number(expires) < Date.now()) return null;
  const expected = signSession(`${id}.${version}.${expires}`);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const account = await db.prepare(`
    SELECT id, name, email, phone, password_version, created_at
    FROM customer_accounts WHERE id = ?
  `).get(id);
  return account && String(account.password_version) === version ? account : null;
}

function setCustomerSessionCookie(res, account) {
  const expires = Date.now() + 1000 * 60 * 60 * 24 * 30;
  const value = `${account.id}.${account.password_version}.${expires}`;
  const secure = IS_PRODUCTION ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(`${value}.${signSession(value)}`)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=2592000`
  );
}

function clearCustomerSessionCookie(res) {
  const secure = IS_PRODUCTION ? " Secure;" : "";
  res.setHeader(
    "Set-Cookie",
    `${CUSTOMER_SESSION_COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`
  );
}

async function requireCustomer(req, res, next) {
  const customer = await currentCustomer(req);
  if (!customer) return res.status(401).json({ error: "Lütfen müşteri hesabınıza giriş yapın." });
  req.customer = customer;
  next();
}

app.post("/api/customer/register", async (req, res) => {
  const name = String(req.body.name || "").trim().replace(/\s+/g, " ");
  const email = normalizeCustomerEmail(req.body.email);
  const phone = String(req.body.phone || "").trim();
  const password = String(req.body.password || "");
  if (name.length < 2) return res.status(400).json({ error: "Ad soyad en az 2 karakter olmalı." });
  if (!validCustomerEmail(email) || email.length > 160) {
    return res.status(400).json({ error: "Geçerli bir e-posta adresi girin." });
  }
  if (password.length < 8) return res.status(400).json({ error: "Şifre en az 8 karakter olmalı." });
  const existing = await db.prepare("SELECT id FROM customer_accounts WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Bu e-posta adresiyle zaten bir hesap var." });

  const result = await db.prepare(`
    INSERT INTO customer_accounts (name, email, phone, password_hash)
    VALUES (@name, @email, @phone, @password_hash)
  `).run({ name, email, phone: phone || null, password_hash: hashPassword(password) });
  const account = await db.prepare("SELECT * FROM customer_accounts WHERE id = ?").get(result.lastInsertRowid);
  setCustomerSessionCookie(res, account);
  res.status(201).json({ ok: true, customer: { id: account.id, name, email, phone } });
});

app.post("/api/customer/login", async (req, res) => {
  const email = normalizeCustomerEmail(req.body.email);
  const account = await db.prepare("SELECT * FROM customer_accounts WHERE email = ?").get(email);
  const ok = verifyPassword(req.body.password, account ? account.password_hash : DUMMY_PASSWORD_HASH);
  if (!account || !ok) return res.status(401).json({ error: "E-posta veya şifre hatalı." });
  setCustomerSessionCookie(res, account);
  res.json({ ok: true, customer: { id: account.id, name: account.name, email: account.email, phone: account.phone } });
});

app.post("/api/customer/logout", async (req, res) => {
  clearCustomerSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/customer/session", async (req, res) => {
  const customer = await currentCustomer(req);
  res.json({
    authed: Boolean(customer),
    customer: customer ? { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone } : null
  });
});

app.get("/api/customer/orders", requireCustomer, async (req, res) => {
  const orders = await db.prepare(`
    SELECT o.id, o.order_number, o.status, o.payment_status, o.total, o.tracking_code,
           o.shipping_method, o.created_at
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE LOWER(c.email) = ?
    ORDER BY o.created_at DESC
    LIMIT 100
  `).all(req.customer.email);
  res.json(orders);
});

app.put("/api/customer/profile", requireCustomer, async (req, res) => {
  const name = String(req.body.name || "").trim().replace(/\s+/g, " ");
  const phone = String(req.body.phone || "").trim();
  if (name.length < 2) return res.status(400).json({ error: "Ad soyad en az 2 karakter olmalı." });
  await db.prepare(`
    UPDATE customer_accounts SET name = ?, phone = ?, updated_at = NOW() WHERE id = ?
  `).run(name, phone || null, req.customer.id);
  res.json({ ok: true, customer: { id: req.customer.id, name, email: req.customer.email, phone } });
});

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || "Printable <noreply@printable.com.tr>";
  if (!apiKey) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Printable şifre yenileme",
      html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6">
        <h2>Şifrenizi yenileyin</h2>
        <p>Merhaba ${escapeHtml(name)},</p>
        <p>Printable hesabınız için şifre yenileme bağlantısı istendi.</p>
        <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#ff6542;color:#fff;text-decoration:none;font-weight:700">Yeni şifre oluştur</a></p>
        <p>Bu bağlantı 30 dakika geçerlidir. İsteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>
      </div>`
    })
  });
  return response.ok;
}

app.post("/api/customer/forgot-password", async (req, res) => {
  const email = normalizeCustomerEmail(req.body.email);
  if (!validCustomerEmail(email)) return res.status(400).json({ error: "Geçerli bir e-posta adresi girin." });
  if (IS_PRODUCTION && !process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: "Şifre e-postası servisi henüz yapılandırılmamış." });
  }
  const account = await db.prepare("SELECT id, name, email FROM customer_accounts WHERE email = ?").get(email);
  if (account) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await db.prepare("DELETE FROM customer_password_resets WHERE account_id = ? OR expires_at < NOW()").run(account.id);
    await db.prepare(`
      INSERT INTO customer_password_resets (account_id, token_hash, expires_at)
      VALUES (?, ?, NOW() + INTERVAL '30 minutes')
    `).run(account.id, tokenHash);
    const origin = `${req.protocol}://${req.get("host")}`;
    const sent = await sendPasswordResetEmail({
      to: account.email,
      name: account.name,
      resetUrl: `${origin}/hesap?reset=${token}`
    });
    if (!sent && !IS_PRODUCTION) {
      console.log(`Customer password reset URL: ${origin}/hesap?reset=${token}`);
    }
  }
  res.json({ ok: true, message: "Hesap bulunursa şifre yenileme bağlantısı e-posta adresine gönderildi." });
});

app.post("/api/customer/reset-password", async (req, res) => {
  const token = String(req.body.token || "");
  const password = String(req.body.password || "");
  if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ error: "Şifre yenileme bağlantısı geçersiz." });
  if (password.length < 8) return res.status(400).json({ error: "Şifre en az 8 karakter olmalı." });
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const reset = await db.prepare(`
    SELECT r.id, r.account_id, a.email
    FROM customer_password_resets r
    JOIN customer_accounts a ON a.id = r.account_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > NOW()
  `).get(tokenHash);
  if (!reset) return res.status(400).json({ error: "Bağlantı geçersiz veya süresi dolmuş." });
  await db.transaction(async (tx) => {
    await tx.prepare(`
      UPDATE customer_accounts
      SET password_hash = ?, password_version = password_version + 1, updated_at = NOW()
      WHERE id = ?
    `).run(hashPassword(password), reset.account_id);
    await tx.prepare("UPDATE customer_password_resets SET used_at = NOW() WHERE id = ?").run(reset.id);
  });
  clearCustomerSessionCookie(res);
  res.json({ ok: true });
});

/* ---------- Maliyet hesaplayıcı ayarları ----------
   Hesap tamamen tarayıcıda yapılıyor (anında sonuç, sunucuya gitmeye gerek
   yok). Burada saklanan yalnızca GİRDİLER: elektrik fiyatı, yazıcı gücü,
   aylık kira gibi değerler her hesapta aynı, her seferinde yeniden yazmak
   anlamsız. localStorage yerine veritabanı, çünkü iki yönetici var ve
   atölyenin gider verisi ikisinde de aynı olmalı.

   Yeni tablo açmadım: app_meta zaten anahtar/değer deposu. */
const MALIYET_ANAHTARI = "cost_calculator";

app.get("/api/cost-settings", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").get(MALIYET_ANAHTARI);
  if (!row) return res.json(null);
  try {
    res.json(JSON.parse(row.value));
  } catch {
    res.json(null);   // bozuk kayıt hesabı kilitlemesin
  }
});

app.put("/api/cost-settings", requireAdmin, async (req, res) => {
  const govde = req.body && typeof req.body === "object" ? req.body : {};
  // Yalnızca bilinen alanlar ve yalnızca sayı: gövde olduğu gibi saklanırsa
  // ileride bu JSON'a ne geldiğini kimse bilemez.
  const ALANLAR = ["adet", "agirlik", "sure", "filamentFiyat", "elektrikFiyat", "guc",
    "iscilik", "amortisman", "fire", "kira", "aylikCalisma", "karMarji",
    "kargo", "kdv", "komisyon", "belirlenen"];
  const temiz = {};
  for (const alan of ALANLAR) {
    const deger = Number(govde[alan]);
    temiz[alan] = Number.isFinite(deger) && deger >= 0 ? deger : 0;
  }
  await db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `).run(MALIYET_ANAHTARI, JSON.stringify(temiz));
  res.json(temiz);
});

/* Hesaplanan maliyeti bir ÜRÜNE bağlar.

   Ayrı bir uç, PUT /api/products/:id değil: o uç ürün formunun tamamını
   bekliyor ve maliyet ataması sırasında ürünün diğer alanlarını taşımak
   gereksiz risk. Girdilerin anlık görüntüsü de saklanıyor — aylar sonra
   "bu 25,48 nereden çıktı" sorusunun yanıtı ve hesabı yeniden açmak için. */
/* products.unit_cost'u ölçeklerin EN DÜŞÜĞÜ olarak özetler; hiç ölçek yoksa
   NULL yapar. Liste rozeti, kâr marjı ve public gizleme hâlâ bu sütuna
   baktığı için her ölçek değişikliğinden sonra çağrılıyor.

   products.price da burada özetleniyor: fiyatı girilmiş ölçeklerin EN DÜŞÜĞÜ.
   Ürün kartında tek bir fiyat gösterilebiliyor, o yüzden orada BAŞLANGIÇ
   fiyatı yazıyor; müşteri ürün sayfasında ölçeği seçince kendi fiyatına
   geçiyor. Hiçbir ölçeğin fiyatı yoksa ürünün elle girilmiş fiyatına
   dokunulmuyor — maliyet kaydı fiyatı sıfırlamamalı.

   Değişiklik price_history'ye de düşer: fiyat maliyetten türetilse bile
   "ne zaman ne oldu" zincirinin kopmaması gerekiyor. */
async function ozetMaliyet(productId) {
  const oncesi = await db.prepare("SELECT price, sale_price FROM products WHERE id = ?").get(productId);
  const ozet = await db.prepare(
    "SELECT MIN(unit_cost) AS enaz, COUNT(*)::int AS adet FROM product_cost_scales WHERE product_id = ?"
  ).get(productId);
  const enucuz = ozet.adet
    ? await db.prepare("SELECT inputs FROM product_cost_scales WHERE product_id = ? ORDER BY unit_cost ASC LIMIT 1").get(productId)
    : null;
  // price > 0 aynı zamanda NULL'ları eler (NULL > 0 → NULL, satır düşer).
  const satis = await db.prepare(
    "SELECT MIN(price) AS enaz FROM product_cost_scales WHERE product_id = ? AND price > 0"
  ).get(productId);
  const yeniFiyat = Number(satis?.enaz) > 0 ? round2(Number(satis.enaz)) : null;

  await db.prepare(`
    UPDATE products SET unit_cost = @unit_cost, cost_inputs = @cost_inputs,
      cost_updated_at = @stamp, price = COALESCE(@price, price),
      updated_at = CURRENT_TIMESTAMP WHERE id = @id
  `).run({
    id: productId,
    unit_cost: ozet.adet ? round2(ozet.enaz) : null,
    cost_inputs: enucuz?.inputs || null,
    price: yeniFiyat,
    stamp: ozet.adet ? new Date().toISOString() : null
  });

  if (yeniFiyat !== null && oncesi && priceChanged(oncesi, yeniFiyat, oncesi.sale_price)) {
    await logPrice(productId, yeniFiyat, oncesi.sale_price ?? null);
  }
  return { price: yeniFiyat, previous_price: oncesi ? Number(oncesi.price) : null };
}

// Bir ürünün tüm ölçek kayıtları (en ucuzdan pahalıya).
app.get("/api/products/:id/costs", requireAdmin, async (req, res) => {
  res.json(await db.prepare(
    "SELECT id, scale, unit_cost, price, inputs, updated_at FROM product_cost_scales WHERE product_id = ? ORDER BY unit_cost ASC, id ASC"
  ).all(req.params.id));
});

/* Bir ölçek ekler ya da günceller. Aynı ürün + aynı ölçek etiketi ikinci kez
   atanınca üzerine yazılır (upsert); farklı etiket yeni bir ölçek olur.

   price gönderilirse (hesabın "kârlı satış fiyatı" çıktısı) ölçek mağazada
   seçilebilir bir varyanta dönüşür ve ürünün fiyatı ozetMaliyet içinde
   güncellenir. Gönderilmezse ölçek yalnızca iç maliyet kaydı olarak kalır. */
app.post("/api/products/:id/cost", requireAdmin, async (req, res) => {
  const urun = await db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!urun) return res.status(404).json({ error: "Ürün bulunamadı." });

  const maliyet = Number(req.body.unit_cost);
  if (!Number.isFinite(maliyet) || maliyet < 0) {
    return res.status(400).json({ error: "Maliyet 0 veya daha büyük bir sayı olmalı." });
  }
  const bosFiyat = req.body.price === null || req.body.price === undefined || req.body.price === "";
  const fiyat = bosFiyat ? null : Number(req.body.price);
  if (fiyat !== null && (!Number.isFinite(fiyat) || fiyat < 0)) {
    return res.status(400).json({ error: "Satış fiyatı 0 veya daha büyük bir sayı olmalı." });
  }
  const olcek = String(req.body.scale || "").trim() || "Standart";

  await db.prepare(`
    INSERT INTO product_cost_scales (product_id, scale, unit_cost, price, inputs)
    VALUES (@product_id, @scale, @unit_cost, @price, @inputs)
    ON CONFLICT (product_id, scale) DO UPDATE
      SET unit_cost = EXCLUDED.unit_cost, price = EXCLUDED.price,
          inputs = EXCLUDED.inputs, updated_at = NOW()
  `).run({
    product_id: urun.id,
    scale: olcek,
    unit_cost: round2(maliyet),
    price: fiyat === null ? null : round2(fiyat),
    inputs: req.body.inputs && typeof req.body.inputs === "object" ? JSON.stringify(req.body.inputs) : null
  });

  const fiyatlama = await ozetMaliyet(urun.id);
  res.json({
    product: await withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(urun.id)),
    pricing: fiyatlama,
    scales: await db.prepare("SELECT id, scale, unit_cost, price, inputs FROM product_cost_scales WHERE product_id = ? ORDER BY unit_cost ASC").all(urun.id)
  });
});

/* Tek bir ölçeği siler (scaleId ile). scaleId yoksa ürünün TÜM ölçekleri. */
app.delete("/api/products/:id/cost", requireAdmin, async (req, res) => {
  const urun = await db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!urun) return res.status(404).json({ error: "Ürün bulunamadı." });
  if (req.query.scaleId) {
    await db.prepare("DELETE FROM product_cost_scales WHERE id = ? AND product_id = ?").run(req.query.scaleId, urun.id);
  } else {
    await db.prepare("DELETE FROM product_cost_scales WHERE product_id = ?").run(urun.id);
  }
  await ozetMaliyet(urun.id);
  res.status(204).end();
});

/* ---------- Katlaç kataloğu (yalnızca panel) ----------
   Her rota requireAdmin arkasında; bu listenin herkese açık bir ucu YOK. */

/* Katlaç listesi, vitrindeki karşılığıyla birlikte. Fiyat iki yerde
   tutulmuyor: katlaç bir ürüne bağlıysa geçerli fiyat ÜRÜNÜN fiyatıdır
   (ölçeklerden hesaplanan), katlac_items.price yalnızca henüz vitrine
   çıkmamış kayıtlar için elle girilen tahmindir. Panel ve PDF listesi
   ikisini de bu alandan okur, böylece iki farklı fiyat gösterme ihtimali
   ortadan kalkar. */
app.get("/api/katlac", requireAdmin, async (req, res) => {
  const liste = await db.prepare(
    "SELECT * FROM katlac_items ORDER BY sort_order ASC, id ASC"
  ).all();

  const idler = [...new Set(liste.map((k) => k.product_id).filter(Boolean))];
  if (!idler.length) return res.json(liste.map((k) => ({ ...k, product: null })));

  // Tek sorguda: katlaç başına ürün sorgusu N+1 olurdu.
  const urunler = await decorateProducts(await db.prepare(
    `SELECT * FROM products WHERE id IN (${idler.map(() => "?").join(",")})`
  ).all(...idler));
  const esle = Object.fromEntries(urunler.map((u) => [u.id, u]));

  res.json(liste.map((k) => {
    const urun = esle[k.product_id];
    return {
      ...k,
      // Ürün silinmişse bağ boşta: katlaç "vitrinde değil" sayılır.
      product: urun
        ? {
            id: urun.id, name: urun.name, price: Number(urun.price) || 0,
            is_active: urun.is_active, scales: urun.scales, unit_cost: urun.unit_cost
          }
        : null
    };
  }));
});

/* Katlacı vitrine çıkarır: kayıttan bir ÜRÜN üretir ve ikisini bağlar.

   Neden kopyalama, taşıma değil: katlaç kaydı modelin kendisidir — kaynak
   linki ve basılacak STL/3MF orada durur ve orada kalmalı. Ürün ise onun
   satılabilir hâli. Atölye "bu siparişi hangi dosyadan basacağım" sorusunu
   bağ üzerinden yanıtlar; ürün formuna dosya alanı eklemek katlaç tablosunu
   gereksiz kılardı ve "sadece ben göreyim" listesi vitrine sızardı.

   Ürün fiyatsız (0) açılırsa PASİF başlar: 0 TL'lik bir ürünü vitrine
   koymak sipariş kabul etmek demek. Maliyet sekmesinden ölçek atandığında
   fiyat oluşur, yayına almak yöneticinin kararı olarak kalır. */
app.post("/api/katlac/:id/publish", requireAdmin, async (req, res) => {
  const katlac = await db.prepare("SELECT * FROM katlac_items WHERE id = ?").get(req.params.id);
  if (!katlac) return res.status(404).json({ error: "Katlaç bulunamadı." });

  if (katlac.product_id) {
    const mevcut = await db.prepare("SELECT id, name FROM products WHERE id = ?").get(katlac.product_id);
    if (mevcut) {
      return res.status(400).json({ error: `Bu katlaç zaten "${mevcut.name}" ürününe bağlı.` });
    }
    // Ürün silinmiş: boşta kalan bağı temizleyip yeniden çıkarmaya izin ver.
  }

  const fiyat = Math.max(0, Number(katlac.price) || 0);
  const sonuc = await db.prepare(`
    INSERT INTO products (name, description, price, stock, image_path, image_alt, is_active)
    VALUES (@name, @description, @price, 0, @image_path, @image_alt, @is_active)
  `).run({
    name: katlac.name,
    description: katlac.note || null,
    price: fiyat,
    image_path: katlac.image_path,
    image_alt: katlac.name,
    is_active: fiyat > 0 ? 1 : 0
  });

  await logPrice(sonuc.lastInsertRowid, fiyat, null);
  await db.prepare("UPDATE katlac_items SET product_id = ?, updated_at = NOW() WHERE id = ?")
    .run(sonuc.lastInsertRowid, katlac.id);

  const urun = await withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(sonuc.lastInsertRowid));
  res.status(201).json({ product: urun, published: urun.is_active === 1 });
});

/* Bağı koparır — ürünü SİLMEZ. Yanlış katlaca bağlanmışsa ya da ürün elle
   yönetilmek isteniyorsa kullanılır; ürünü silmek ayrı ve bilinçli bir iş. */
app.delete("/api/katlac/:id/publish", requireAdmin, async (req, res) => {
  const katlac = await db.prepare("SELECT id FROM katlac_items WHERE id = ?").get(req.params.id);
  if (!katlac) return res.status(404).json({ error: "Katlaç bulunamadı." });
  await db.prepare("UPDATE katlac_items SET product_id = NULL, updated_at = NOW() WHERE id = ?").run(katlac.id);
  res.status(204).end();
});

app.post("/api/katlac", requireAdmin, upload.single("image"), async (req, res) => {
  const yol = resolveImagePath({ image_key: req.body.image_key, image_url: req.body.image_url }, req.file);
  if (!yol) return res.status(400).json({ error: "Görsel dosyası veya adresi gerekli." });
  const son = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS son FROM katlac_items").get();
  const sonuc = await db.prepare(`
    INSERT INTO katlac_items (name, price, image_path, note, sort_order)
    VALUES (@name, @price, @image_path, @note, @sort_order)
  `).run({
    name: req.body.name?.trim() || "İsimsiz katlaç",
    price: Math.max(0, Number(req.body.price) || 0),
    image_path: yol,
    note: req.body.note?.trim() || null,
    sort_order: Number(son.son) + 1
  });
  res.status(201).json(await db.prepare("SELECT * FROM katlac_items WHERE id = ?").get(sonuc.lastInsertRowid));
});

app.put("/api/katlac/:id", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT * FROM katlac_items WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Katlaç bulunamadı." });
  const fiyat = Number(req.body.price);
  if (req.body.price !== undefined && (!Number.isFinite(fiyat) || fiyat < 0)) {
    return res.status(400).json({ error: "Fiyat 0 veya daha büyük bir sayı olmalı." });
  }
  // Model dosyası tarayıcıdan doğrudan Storage'a yüklendi; forma yalnızca
  // anahtarı geldi. "" gelirse dosya kaldırılmak isteniyor demektir.
  const modelAnahtari = req.body.model_key === undefined ? row.model_key
    : (req.body.model_key?.trim() || null);

  await db.prepare(`
    UPDATE katlac_items SET name = @name, price = @price, note = @note,
      source_url = @source_url, model_key = @model_key, model_name = @model_name,
      sort_order = @sort_order, updated_at = NOW() WHERE id = @id
  `).run({
    id: row.id,
    // Gönderilmeyen alan mevcut değerini korur: panel tek alan da kaydedebilsin.
    name: req.body.name === undefined ? row.name : (req.body.name.trim() || "İsimsiz katlaç"),
    price: req.body.price === undefined ? row.price : fiyat,
    note: req.body.note === undefined ? row.note : (req.body.note?.trim() || null),
    source_url: req.body.source_url === undefined ? row.source_url : (req.body.source_url?.trim() || null),
    model_key: modelAnahtari,
    model_name: req.body.model_name === undefined ? row.model_name : (req.body.model_name?.trim() || null),
    sort_order: req.body.sort_order === undefined ? row.sort_order : toInt(req.body.sort_order)
  });
  res.json(await db.prepare("SELECT * FROM katlac_items WHERE id = ?").get(row.id));
});

/* Yüklenen STL/3MF gizli "models" kovasında; kalıcı genel adresi yok. İndirmek
   için kısa ömürlü imzalı adres üretiliyor. Dış kaynak adresi (source_url)
   buraya girmez, o zaten tarayıcıda doğrudan açılıyor. */
app.get("/api/katlac/:id/model", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT model_key, model_name FROM katlac_items WHERE id = ?").get(req.params.id);
  if (!row || !row.model_key) return res.status(404).json({ error: "Bu katlaç için yüklü model dosyası yok." });
  const url = await storage.signedModelUrl(row.model_key);
  if (!url) return res.status(503).json({ error: "İndirme adresi üretilemedi." });
  res.json({ url, name: row.model_name });
});

app.delete("/api/katlac/:id", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT id, model_key FROM katlac_items WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Katlaç bulunamadı." });
  // Kaydı silerken yüklü model dosyasını da depodan temizle.
  if (row.model_key) await storage.remove("model", row.model_key);
  await db.prepare("DELETE FROM katlac_items WHERE id = ?").run(row.id);
  res.status(204).end();
});

/* Mağaza ayarları: stok görünürlüğü, minimum sepet tutarı ve satıcı kimliği.
   SEO formuyla aynı tabloyu (site_settings) yazdıkları için birbirlerinin
   alanlarını ezmemeleri gerekir — bu yüzden ikisi de yalnızca kendi
   sütunlarını UPDATE eder, satırın tamamını değil. */
app.get("/api/settings", requireAdmin, async (req, res) => {
  const s = await db.prepare(`
    SELECT show_stock, track_stock, min_cart_total, company_title, legal_address,
           tax_office, tax_number, mersis, return_address
    FROM site_settings WHERE id = 1
  `).get() || {};
  res.json({
    show_stock: s.show_stock ?? 1,
    track_stock: s.track_stock ?? 0,
    min_cart_total: s.min_cart_total ?? 0,
    company_title: s.company_title || "",
    legal_address: s.legal_address || "",
    tax_office: s.tax_office || "",
    tax_number: s.tax_number || "",
    mersis: s.mersis || "",
    return_address: s.return_address || ""
  });
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  const minTutar = Number(req.body.min_cart_total);
  if (!Number.isFinite(minTutar) || minTutar < 0) {
    return res.status(400).json({ error: "Minimum sepet tutarı 0 veya daha büyük bir sayı olmalı." });
  }
  const metin = (deger) => (typeof deger === "string" && deger.trim() ? deger.trim() : null);

  await db.prepare(`
    UPDATE site_settings SET
      show_stock=@show_stock, track_stock=@track_stock, min_cart_total=@min_cart_total,
      company_title=@company_title, legal_address=@legal_address,
      tax_office=@tax_office, tax_number=@tax_number, mersis=@mersis,
      return_address=@return_address, updated_at=NOW()
    WHERE id = 1
  `).run({
    // Checkbox işaretli değilse tarayıcı alanı hiç göndermez; yokluğu "kapalı" demek.
    show_stock: req.body.show_stock === true || req.body.show_stock === "1" || req.body.show_stock === 1 ? 1 : 0,
    track_stock: req.body.track_stock === true || req.body.track_stock === "1" || req.body.track_stock === 1 ? 1 : 0,
    min_cart_total: minTutar,
    company_title: metin(req.body.company_title),
    legal_address: metin(req.body.legal_address),
    tax_office: metin(req.body.tax_office),
    tax_number: metin(req.body.tax_number),
    mersis: metin(req.body.mersis),
    return_address: metin(req.body.return_address)
  });
  res.json({ ok: true });
});

// Panel yöneticileri. Şifre özeti hiçbir yanıtta dönmez.
app.get("/api/admin-users", requireAdmin, async (req, res) => {
  res.json(await db.prepare("SELECT id, username, created_at, updated_at FROM admin_users ORDER BY username").all());
});

app.post("/api/admin-users", requireAdmin, async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: "Kullanıcı adı 3-32 karakter olmalı; sadece harf, rakam, tire ve alt çizgi kullanılabilir." });
  }
  if (password.length < 8) return res.status(400).json({ error: "Şifre en az 8 karakter olmalı." });
  if (await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(username)) {
    return res.status(400).json({ error: "Bu kullanıcı adı zaten kullanılıyor." });
  }
  const result = await db.prepare(
    "INSERT INTO admin_users (username, password_hash) VALUES (@username, @password_hash)"
  ).run({ username, password_hash: hashPassword(password) });
  res.status(201).json(await db.prepare("SELECT id, username, created_at, updated_at FROM admin_users WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/admin-users/:id/password", requireAdmin, async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 8) return res.status(400).json({ error: "Şifre en az 8 karakter olmalı." });
  const row = await db.prepare("SELECT * FROM admin_users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Yönetici bulunamadı." });
  /* Kendi şifresini değiştiren mevcut şifresini doğrulamak zorunda: panelde açık
     unutulmuş bir oturumun hesabı ele geçirmesini engeller. Başkasının şifresini
     sıfırlarken bu istenmez — kilitlenen arkadaşına yardım edebilmeli. */
  if (row.id === req.admin.id && !verifyPassword(req.body.current_password, row.password_hash)) {
    return res.status(400).json({ error: "Mevcut şifreniz hatalı." });
  }
  await db.prepare(
    "UPDATE admin_users SET password_hash = @password_hash, password_version = password_version + 1, updated_at = NOW() WHERE id = @id"
  ).run({ id: row.id, password_hash: hashPassword(password) });
  // Şifre sürümü arttı: kendi çerezimiz de geçersizleşti, yenisini ver.
  if (row.id === req.admin.id) {
    setSessionCookie(res, { username: row.username, password_version: row.password_version + 1 });
  }
  res.json({ ok: true });
});

app.delete("/api/admin-users/:id", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT id FROM admin_users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Yönetici bulunamadı." });
  if (row.id === req.admin.id) return res.status(400).json({ error: "Kendi hesabınızı silemezsiniz." });
  const total = await db.prepare("SELECT COUNT(*)::int AS count FROM admin_users").get();
  if (total.count <= 1) return res.status(400).json({ error: "Son yönetici hesabı silinemez." });
  await db.prepare("DELETE FROM admin_users WHERE id = ?").run(row.id);
  res.status(204).end();
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

const seoMetniKisalt = (value, max) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * .7 ? lastSpace : max).replace(/[.,;:!?-]+$/, "")}…`;
};

/* Ürün SEO alanları boş bırakılırsa tutarlı varsayılanlar üret.
   Yönetici elle bir değer girdiyse asla üzerine yazılmaz. Böylece yeni ürün
   eklemek için SEO uzmanlığı gerekmez; önemli ürünler yine tek tek özelleştirilebilir. */
function otomatikUrunSeo(body) {
  const name = String(body.name || "").replace(/\s+/g, " ").trim();
  const description = String(body.description || "").replace(/\s+/g, " ").trim();
  const color = String(body.color || "").replace(/\s+/g, " ").trim();
  const category = String(body.category || "").replace(/\s+/g, " ").trim();
  const title = seoMetniKisalt(`${name} | 3D Baskı Ürün | Printable`, 60);
  const descriptionBase = description
    ? `${description} Printable'da farklı renk ve ölçek seçeneklerini inceleyin.`
    : `${name}, siparişe özel üretilen 3D baskı ürün. Renk ve ölçek seçeneklerini Printable'da inceleyin.`;
  const stopWords = new Set(["olan", "olarak", "için", "veya", "ürünü", "ürün", "uygun", "farklı", "seçenekleri"]);
  const descriptionWords = `${name} ${description}`.toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word))
    .slice(0, 6);
  const keywords = [...new Set([
    name.toLocaleLowerCase("tr"),
    category.toLocaleLowerCase("tr"),
    color.toLocaleLowerCase("tr"),
    ...descriptionWords,
    "3d baskı",
    "3d baskı ürün",
    "printable"
  ].filter(Boolean))].join(", ");

  return {
    meta_title: body.meta_title?.trim() || title,
    meta_description: body.meta_description?.trim() || seoMetniKisalt(descriptionBase, 160),
    meta_keywords: body.meta_keywords?.trim() || keywords,
    image_alt: body.image_alt?.trim() || `${name} 3D baskı ürün görseli`
  };
}

function productPayload(body, file) {
  const seo = otomatikUrunSeo(body);
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
    image_alt: seo.image_alt,
    meta_title: seo.meta_title,
    meta_description: seo.meta_description,
    meta_keywords: seo.meta_keywords,
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

  const [colorRows, categoryRows, ratingRows, imageRows, scaleRows] = await Promise.all([
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
    `).all(...ids),
    // Galeri de tek sorguda: ürün başına ayrı sorgu N+1 demek olurdu.
    db.prepare(`
      SELECT id, product_id, color_id, image_path, image_alt, sort_order
      FROM product_images WHERE product_id IN ${list}
      ORDER BY sort_order ASC, id ASC
    `).all(...ids),
    // Maliyet ölçekleri de toplu; public'te maliyetiGizle bunu siler.
    db.prepare(`
      SELECT id, product_id, scale, unit_cost, price, inputs FROM product_cost_scales
      WHERE product_id IN ${list} ORDER BY unit_cost ASC, id ASC
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
  const images = bucket(imageRows);
  const scales = bucket(scaleRows);

  return products.map((product) => ({
    ...product,
    rating: ratings[product.id] || { average: null, count: 0 },
    colors: colors[product.id] || [],
    categories: categories[product.id] || [],
    images: images[product.id] || [],
    cost_scales: scales[product.id] || [],
    scales: satisOlcekleri(scales[product.id], product.sale_price || product.price)
  }));
}

/* Ölçeklerin MÜŞTERİYE açık hâli: ölçeğin özel fiyatı varsa onu, yoksa ürünün
   ana satış fiyatını kullanır. Eski %75 / %100 kayıtları maliyet ölçeği olarak
   oluşturulmuş ve fiyatları ürün üzerinde tutulmuştu; onları gizlemek yerine
   aynı ürün fiyatıyla seçilebilir varyant olarak gösteriyoruz.

   unit_cost ve inputs ticari sır olduğu için bu listeye hiç girmiyor. */
const satisOlcekleri = (rows, fallbackPrice = null) => (rows || [])
  .map((s) => ({
    id: s.id,
    scale: s.scale,
    price: Number(s.price) > 0 ? round2(Number(s.price)) : round2(Number(fallbackPrice))
  }))
  .filter((s) => s.price > 0)
  .sort((a, b) => a.price - b.price);

// Tek ürün için: POST/PUT sonrası dönen kayıtta kullanılır.
const imagesOfProduct = db.prepare(`
  SELECT id, color_id, image_path, image_alt, sort_order
  FROM product_images WHERE product_id = ?
  ORDER BY sort_order ASC, id ASC
`);

const withColors = async (product) => {
  const olcekler = await db.prepare(
    "SELECT id, scale, unit_cost, price, inputs FROM product_cost_scales WHERE product_id = ? ORDER BY unit_cost ASC, id ASC"
  ).all(product.id);
  return {
    ...product,
    rating: (await ratingOfProduct.get(product.id)) || { average: null, count: 0 },
    colors: await colorsOfProduct.all(product.id),
    categories: await categoriesOfProduct.all(product.id),
    images: await imagesOfProduct.all(product.id),
    cost_scales: olcekler,
    scales: satisOlcekleri(olcekler, product.sale_price || product.price)
  };
};

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

/* Maliyet verisi TİCARİ SIR: /api/products herkese açık, ürünün kaça mal
   olduğu müşteriye ya da rakibe gitmemeli. Yalnızca giriş yapmış yöneticiye
   dönüyor. Ayrı bir uç açmak yerine burada süzmek yeterli — panel zaten bu
   listeyi kullanıyor.

   `scales` BİLEREK kalıyor: o, satisOlcekleri'nden geçmiş hâli, yalnızca ölçek
   adı ve satış fiyatı. Müşteri zaten bu ikisini görmek zorunda — seçtiği
   varyant ve ödeyeceği tutar. Silinen `cost_scales` ise maliyeti taşıyor. */
const maliyetiGizle = (urun) => {
  const { unit_cost, cost_inputs, cost_updated_at, cost_scales, ...kalan } = urun;
  return kalan;
};

app.get("/api/products", async (req, res) => {
  // id breaks the tie: the seed inserts every product in the same second, so
  // created_at alone leaves "en yeni" in arbitrary order.
  const products = await db.prepare("SELECT * FROM products ORDER BY created_at DESC, id DESC").all();
  const suslu = await decorateProducts(products);
  res.json(await isAuthed(req) ? suslu : suslu.map(maliyetiGizle));
});

app.get("/api/products/:id", async (req, res) => {
  const product = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });
  const suslu = await withColors(product);
  res.json(await isAuthed(req) ? suslu : maliyetiGizle(suslu));
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

  // await şart: beklenmezse renk/kategori bağlantıları yanıt gönderildikten
  // sonra tamamlanır (ya da hiç tamamlanmaz) ve hata sessizce yutulur.
  await setProductColors(result.lastInsertRowid, req.body.color_ids);
  await setProductCategories(result.lastInsertRowid, req.body.category_ids);
  await logPrice(result.lastInsertRowid, product.price, product.sale_price);
  res.status(201).json(await withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid)));
});

app.patch("/api/products/:id/active", requireAdmin, async (req, res) => {
  const isActive = req.body.is_active === true || req.body.is_active === 1 || req.body.is_active === "1";
  if (isActive) {
    const product = await db.prepare("SELECT price FROM products WHERE id = ?").get(req.params.id);
    if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });
    const pricedScale = await db.prepare(
      "SELECT id FROM product_cost_scales WHERE product_id = ? AND price > 0 LIMIT 1"
    ).get(req.params.id);
    if (!(Number(product.price) > 0) && !pricedScale) {
      return res.status(400).json({
        error: "Ürünü aktif etmek için önce satış fiyatı olan en az bir ölçek ekleyin."
      });
    }
  }
  const result = await db.prepare(`
    UPDATE products SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(isActive ? 1 : 0, req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Ürün bulunamadı." });
  res.json({ id: Number(req.params.id), is_active: isActive ? 1 : 0 });
});

app.put("/api/products/:id", requireAdmin, upload.single("image"), async (req, res) => {
  const current = await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Ürün bulunamadı." });

  /* Gövdede olmayan alan MEVCUT değerini korur.

     productPayload eksik alanı null/0 yapıyor, is_active ise gönderilmediğinde
     1 oluyordu. Yani {"stock": 5} gibi kısmi bir istek ürünün adını,
     açıklamasını ve meta alanlarını siler, fiyatını 0'a düşürür ve pasif
     ürünü yayına alırdı. Panel şu an formun tamamını gönderdiği için
     tetiklenmiyordu; katlaç ve galeri uçlarında bilinçli olarak yazılan
     koruma burada eksikti. */
  const gonderilen = { ...req.body };
  const KORUNACAK = ["name", "sku", "category", "description", "color", "price", "sale_price",
    "width", "height", "depth", "weight", "stock", "image_alt", "meta_title",
    "meta_description", "meta_keywords", "is_active"];
  for (const alan of KORUNACAK) {
    if (gonderilen[alan] === undefined && current[alan] !== undefined && current[alan] !== null) {
      gonderilen[alan] = alan === "is_active" ? String(current[alan]) : current[alan];
    }
  }

  const product = productPayload({ ...gonderilen, current_image: current.image_path }, req.file);
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

  /* color_ids/category_ids gönderilmediyse bağlara DOKUNMA: bu iki
     fonksiyon önce hepsini siliyor, undefined gelince ürün renksiz ve
     kategorisiz kalırdı. */
  if (req.body.color_ids !== undefined) await setProductColors(current.id, req.body.color_ids);
  if (req.body.category_ids !== undefined) await setProductCategories(current.id, req.body.category_ids);
  if (priceChanged(current, product.price, product.sale_price)) {
    await logPrice(current.id, product.price, product.sale_price);
  }
  res.json(await withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(current.id)));
});

/* ---------- Ürün galerisi ----------
   Fotoğraflar ürün formundan ayrı yönetilir: tek bir dev formda 10 dosyayı
   birlikte göndermek hem Vercel'in istek sınırına takılır hem de tek bir
   yükleme hatası ürünün tamamının kaydını düşürürdü. Her fotoğraf kendi
   isteğiyle gelir; biri patlarsa diğerleri kaydedilmiş olur. */

app.post("/api/products/:id/images", requireAdmin, upload.single("image"), async (req, res) => {
  const product = await db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });

  const yol = resolveImagePath({ image_key: req.body.image_key, image_url: req.body.image_url }, req.file);
  if (!yol) return res.status(400).json({ error: "Fotoğraf dosyası veya adresi gerekli." });

  // Yeni fotoğraf sona eklenir; sıralamayı admin sürükleyerek değil, sıra
  // numarasıyla değiştiriyor (basit ve dokunmatik ekranda güvenilir).
  const son = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS son FROM product_images WHERE product_id = ?").get(product.id);
  const renkId = toInt(req.body.color_id) || null;

  const sonuc = await db.prepare(`
    INSERT INTO product_images (product_id, color_id, image_path, image_alt, sort_order)
    VALUES (@product_id, @color_id, @image_path, @image_alt, @sort_order)
  `).run({
    product_id: product.id,
    color_id: renkId,
    image_path: yol,
    image_alt: req.body.image_alt?.trim() || null,
    sort_order: Number(son.son) + 1
  });

  res.status(201).json(await db.prepare("SELECT * FROM product_images WHERE id = ?").get(sonuc.lastInsertRowid));
});

app.patch("/api/products/:id/images/:imageId", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT * FROM product_images WHERE id = ? AND product_id = ?")
    .get(req.params.imageId, req.params.id);
  if (!row) return res.status(404).json({ error: "Fotoğraf bulunamadı." });

  await db.prepare(`
    UPDATE product_images SET color_id = @color_id, image_alt = @image_alt, sort_order = @sort_order WHERE id = @id
  `).run({
    id: row.id,
    // color_id gönderilmediyse mevcut değeri koru; "" gönderildiyse renk bağını kaldır.
    color_id: req.body.color_id === undefined ? row.color_id : (toInt(req.body.color_id) || null),
    image_alt: req.body.image_alt === undefined ? row.image_alt : (req.body.image_alt?.trim() || null),
    sort_order: req.body.sort_order === undefined ? row.sort_order : toInt(req.body.sort_order)
  });
  res.json(await db.prepare("SELECT * FROM product_images WHERE id = ?").get(row.id));
});

app.delete("/api/products/:id/images/:imageId", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT id FROM product_images WHERE id = ? AND product_id = ?")
    .get(req.params.imageId, req.params.id);
  if (!row) return res.status(404).json({ error: "Fotoğraf bulunamadı." });
  await db.prepare("DELETE FROM product_images WHERE id = ?").run(row.id);
  res.status(204).end();
});

/* Galerideki bir fotoğrafı kapak yap. Kapak products.image_path'te durur:
   ürün kartları, arama sonuçları ve paylaşım görseli onu kullanıyor. */
app.post("/api/products/:id/images/:imageId/cover", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT image_path, image_alt FROM product_images WHERE id = ? AND product_id = ?")
    .get(req.params.imageId, req.params.id);
  if (!row) return res.status(404).json({ error: "Fotoğraf bulunamadı." });
  /* Alt metin de taşınır: kapak değişip alt metin eski fotoğrafınki kalırsa
     ürün sayfası yanlış görseli tarif eder (SEO ve ekran okuyucu için hatalı).
     Galeri fotoğrafının alt metni boşsa üründekine dokunmuyoruz. */
  await db.prepare(`
    UPDATE products SET image_path = ?, image_alt = COALESCE(?, image_alt), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(row.image_path, row.image_alt || null, req.params.id);
  res.json(await withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id)));
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
  const all = req.query.all === "1" && await isAuthed(req);
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
  const estimatedWeight = usedVolume * (Number(material.density_g_cm3) || 1.24);
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
    material: {
      id: material.id,
      name: material.name,
      price_per_cm3: material.price_per_cm3,
      density_g_cm3: Number(material.density_g_cm3) || 1.24
    },
    volume_cm3: volume,
    used_volume_cm3: usedVolume,
    estimated_weight_g: estimatedWeight,
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
  const all = req.query.all === "1" && await isAuthed(req);
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
    density_g_cm3: Math.max(0.01, Number(body.density_g_cm3) || 1.24),
    sort_order: toInt(body.sort_order),
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.post("/api/materials", requireAdmin, async (req, res) => {
  const material = materialPayload(req.body);
  if (!material.name) return res.status(400).json({ error: "Malzeme adı zorunludur." });
  const result = await db.prepare(`
    INSERT INTO materials (name, description, price_per_cm3, density_g_cm3, sort_order, is_active)
    VALUES (@name, @description, @price_per_cm3, @density_g_cm3, @sort_order, @is_active)
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
      density_g_cm3=@density_g_cm3,
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
  const all = req.query.all === "1" && await isAuthed(req);
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
  const all = req.query.all === "1" && await isAuthed(req);
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

/* Panelden elle sipariş açma. Vitrin bu rotayı kullanmaz — o /api/checkout'a gider.
   requireAdmin şart: aşağıda birim fiyat istemciden gelebiliyor (admin katalog dışı
   bir iş için fiyat yazabilsin diye), yani yetkisiz bırakılırsa herkes kendi
   fiyatını belirleyerek sipariş açabilirdi. */
app.post("/api/orders", requireAdmin, async (req, res) => {
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
      // Elle açılan siparişte ölçek serbest bir not: panel bir ölçek adı
      // gönderirse kaleme yazılır, göndermezse boş kalır.
      scale: String(item.scale || "").trim() || null,
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
      INSERT INTO order_items (order_id, product_id, product_name, scale, quantity, unit_price, line_total)
      VALUES (@order_id, @product_id, @product_name, @scale, @quantity, @unit_price, @line_total)
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
    if (result.gift) gifts.push({ ...result.gift, campaign_id: campaign.id });
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
        if (result.gift) gifts.push({ ...result.gift, campaign_id: coupon.id });
        applied.push({ id: coupon.id, name: coupon.name, code: coupon.code, label: result.label, amount: result.discount, kind: coupon.kind });
      }
    }
  }

  const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
  // Toplam indirim sepeti aşamaz — birden çok kampanya üst üste binerse sipariş eksiye düşerdi.
  return { discount: round2(Math.min(discount, subtotal)), gifts, applied, error };
}

// Sepet satırlarını ürün tablosundan yeniden fiyatlar — istemciden gelen fiyat yok sayılır.
/* Sepet kalemlerini katalogdan yeniden kurar. Tarayıcıdan SADECE ürün kimliği ve
   adet okunur; isim ve fiyat her zaman veritabanından gelir.

   Katalogda olmayan (veya yayından kaldırılmış) bir kalem sessizce düşürülür —
   eskiden böyle bir kalem için tarayıcının gönderdiği unit_price kullanılıyordu ve
   negatif bir fiyat sepet toplamını, KDV'yi ve genel toplamı eksiye çekebiliyordu. */
async function normalizeCartItems(items) {
  const rows = await Promise.all((Array.isArray(items) ? items : []).map(async (item) => {
    if (!item.product_id) return null;
    const product = await db.prepare("SELECT * FROM products WHERE id = ? AND is_active = 1").get(item.product_id);
    if (!product) return null;
    const quantity = Math.min(999, Math.max(1, toInt(item.quantity)));

    /* Ölçekli üründe birim fiyat ÖLÇEĞİN fiyatıdır. Tarayıcıdan gelen tek şey
       ölçeğin id'si; fiyat burada veritabanından okunuyor — sepetteki tutara
       da, gönderilen scale_id'nin gerçekten o ürüne ait olduğuna da güvenmiyoruz.
       Ölçek gelmemişse (ölçekler eklenmeden önce doldurulmuş eski bir sepet)
       en ucuz ölçek seçilir: müşteriyi ödeme adımında boş çevirmek yerine
       kartta gördüğü başlangıç fiyatını uygulamak doğru olan. */
    const olcekler = satisOlcekleri(await db.prepare(
      "SELECT id, scale, price FROM product_cost_scales WHERE product_id = ?"
    ).all(product.id), product.sale_price || product.price);
    const olcek = olcekler.length
      ? olcekler.find((s) => s.id === toInt(item.scale_id)) || olcekler[0]
      : null;

    /* Ölçekli üründe sale_price uygulanmıyor: indirimli fiyat ürünün tamamına
       ait tek bir sayı, ölçek başına fiyatla birlikte hangisinin geçerli
       olduğu belirsizleşirdi. */
    const unitPrice = olcek
      ? Math.max(0, money(olcek.price))
      : Math.max(0, money(product.sale_price || product.price));
    return {
      product_id: product.id,
      product_name: product.name,
      scale: olcek ? olcek.scale : null,
      scale_id: olcek ? olcek.id : null,
      quantity,
      unit_price: unitPrice,
      line_total: money(quantity * unitPrice)
    };
  }));
  return rows.filter(Boolean);
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

/* Katalog: ürünler + renkler + toplu alım kademeleri.

   Kademeler AYRI bir tabloda tutulmuyor, canlı kampanyalardan üretiliyor.
   Ayrı tutsaydık katalogda "10 adet %15" yazıp ödemede uygulanmama ihtimali
   doğardı — müşteriye verilmiş yalan bir söz. Böyle olunca katalog her zaman
   ödemenin gerçekten yapacağı indirimi gösteriyor.

   Yalnızca adet koşulu olan (min_quantity > 0) kampanyalar kademe sayılır;
   "500 TL üstü kargo bedava" gibi tutar koşullu olanlar ürün satırında
   anlamsız olurdu. */
app.get("/api/catalog", async (req, res) => {
  const urunler = await decorateProducts(
    await db.prepare("SELECT * FROM products WHERE is_active = 1 ORDER BY id DESC").all()
  );
  const kampanyalarTumu = await liveCampaigns();
  const kampanyalar = kampanyalarTumu.filter((c) => c.min_quantity > 0);

  // Kapsam listelerini bir kez oku; ürün başına sorgu N+1 olurdu.
  const kapsamlar = await Promise.all(kampanyalar.map(async (c) => ({
    kampanya: c,
    urunIdleri: c.scope === "products"
      ? new Set((await campaignProductIds.all(c.id)).map((r) => r.product_id))
      : null,
    kategoriIdleri: c.scope === "categories"
      ? new Set((await campaignCategoryIds.all(c.id)).map((r) => r.category_id))
      : null
  })));

  const kademeler = (urun) => kapsamlar
    .filter(({ kampanya, urunIdleri, kategoriIdleri }) => {
      // Hediye kampanyasının indirim değeri 0'a zorlanıyor; kademe satırı
      // "%0 indirim, 0 TL kazanç" gibi anlamsız bir satır üretirdi.
      if (kampanya.kind === "gift") return false;
      if (kampanya.scope === "products") return urunIdleri.has(urun.id);
      if (kampanya.scope === "categories") return (urun.categories || []).some((k) => kategoriIdleri.has(k.id));
      return true;   // scope === "all"
    })
    .map(({ kampanya }) => {
      /* Ölçekli üründe kademe EN UCUZ ölçeğin fiyatından hesaplanır (kartta
         gösterilen başlangıç fiyatı); o üründe sale_price uygulanmıyor. */
      const birim = urun.scales?.length
        ? Number(urun.scales[0].price) || 0
        : Number(urun.sale_price || urun.price) || 0;
      const yuzde = kampanya.discount_type === "percent";
      /* Sabit indirim sepete BİR KEZ uygulanır (evaluateOne), adet başına
         değil. Kademe adedine bölüp birim fiyat göstermek yalnızca TAM o
         adette doğru; üstünde müşteri daha fazla öder. Bu yüzden yüzde
         kademeleri "10+ adet", sabit kademeleri "10 adette" diye
         etiketleniyor — quantity_exact bunu istemciye söylüyor. */
      const indirimliBirim = yuzde
        ? birim * (1 - Number(kampanya.discount_value) / 100)
        : Math.max(0, birim - Number(kampanya.discount_value) / kampanya.min_quantity);

      /* min_order_total katalogda yok sayılıyordu: "10 adet %15" yazıp
         ödemede uygulanmayabiliyordu, çünkü evaluateOne ara toplam bu
         tutarın altındaysa kampanyayı hiç döndürmüyor. Koşulu kademeyle
         birlikte gönderiyoruz ki katalog söz vermeden önce şartı yazsın. */
      const enAzTutar = Number(kampanya.min_order_total) || 0;
      const buUrunleKarsilanir = round2(indirimliBirim * kampanya.min_quantity) >= enAzTutar;

      return {
        name: kampanya.name,
        // code BİLEREK yok — /api/catalog herkese açık. Tek kullanımlık özel
        // bir kupon burada yayınlanırsa ilk gelen hakkı yakardı.
        min_quantity: kampanya.min_quantity,
        quantity_exact: !yuzde,
        discount_type: kampanya.discount_type,
        discount_value: Number(kampanya.discount_value),
        min_order_total: enAzTutar,
        min_order_met: buUrunleKarsilanir,
        unit_price: round2(indirimliBirim),
        total_price: round2(indirimliBirim * kampanya.min_quantity),
        saving: round2((birim - indirimliBirim) * kampanya.min_quantity)
      };
    })
    .sort((a, b) => a.min_quantity - b.min_quantity);

  res.json({
    products: urunler.map((p) => ({
      id: p.id, name: p.name, sku: p.sku, description: p.description,
      image_path: p.image_path, image_alt: p.image_alt,
      price: Number(p.price), sale_price: p.sale_price == null ? null : Number(p.sale_price),
      stock: p.stock, colors: p.colors, categories: p.categories,
      // Seçilebilir ölçekler (varsa): katalogdaki fiyat en ucuz ölçeğinkidir.
      scales: p.scales,
      tiers: kademeler(p)
    })),
    /* Adet koşulu olmayan kampanyalar. KOD YAYINLANMIYOR: bu uç herkese
       açık, tek kullanımlık ya da belirli bir müşteriye verilmiş bir kupon
       burada görünseydi ilk gelen hakkı yakardı. Kodunu duyurmak isteyen
       kampanya adına yazabilir. */
    general_campaigns: kampanyalarTumu
      .filter((c) => !c.min_quantity)
      .map((c) => ({ name: c.name, kind: c.kind, discount_type: c.discount_type, discount_value: Number(c.discount_value), min_order_total: Number(c.min_order_total) }))
  });
});

/* Bir kampanyayı kimlerin kullandığı. used_count tek bir sayı; "hangi
   müşteri" sorusunu ancak bu liste yanıtlar. Müşteri adı ve telefonu kayıt
   anında kopyalandığı için sipariş silinse bile geçmiş bozulmuyor. */
app.get("/api/campaigns/:id/uses", requireAdmin, async (req, res) => {
  const campaign = await db.prepare("SELECT id, name, code, usage_limit, used_count FROM campaigns WHERE id = ?").get(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Kampanya bulunamadı." });
  const uses = await db.prepare(`
    SELECT id, order_id, order_number, customer_name, customer_phone, customer_email, discount_amount, created_at
    FROM campaign_uses WHERE campaign_id = ? ORDER BY created_at DESC
  `).all(campaign.id);
  res.json({
    campaign,
    total_discount: round2(uses.reduce((toplam, u) => toplam + Number(u.discount_amount || 0), 0)),
    uses
  });
});

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

  if (body.payment_method !== "kart") {
    return res.status(400).json({ error: "Yalnızca kredi veya banka kartıyla ödeme kabul edilir." });
  }
  const paymentMethod = "kart";

  // Fiyatlama ve kampanya hesabı transaction'dan ÖNCE: bunlar salt-okunur
  // sorgular, yazma kilidini gereksiz yere tutmasınlar.
  const normalized = await normalizeCartItems(items);
  // Katalogda karşılığı kalmayan kalemler yukarıda düşürülür; hepsi düştüyse sipariş açma.
  if (!normalized.length) return res.status(400).json({ error: "Sepetinizdeki ürünler artık satışta değil. Sepetinizi güncelleyip tekrar deneyin." });
  const subtotal = round2(normalized.reduce((sum, item) => sum + item.line_total, 0));

  /* Minimum sepet tutarı burada da kontrol edilir. Ödeme sayfası kullanıcıyı
     zaten uyarıyor ama o sadece arayüz; isteği doğrudan atan biri sınırı
     aşabilirdi. Kontrol indirim ÖNCESİ ara toplama göre: kupon kullanan
     müşteri minimumun altına düşmüş sayılmasın. */
  const magaza = await db.prepare("SELECT min_cart_total, track_stock FROM site_settings WHERE id = 1").get() || {};
  const minCart = Number(magaza.min_cart_total ?? 0);
  if (minCart > 0 && subtotal < minCart) {
    return res.status(400).json({ error: `Minimum sipariş tutarı ${minCart.toFixed(2)} TL. Sepetinize biraz daha ürün ekleyin.` });
  }

  /* Stok takibi kapalıyken (varsayılan) stok bir bilgi alanıdır: sipariş
     stoktan düşmez ve yetersiz stok siparişi engellemez. Açıldığında ikisi de
     devreye girer. Ayar panelden yönetiliyor çünkü bu bir iş akışı kararı. */
  const stokTakibi = Number(magaza.track_stock ?? 0) === 1;
  if (stokTakibi) {
    const yetersiz = [];
    for (const item of normalized) {
      const urun = await db.prepare("SELECT name, stock FROM products WHERE id = ?").get(item.product_id);
      if (!urun || urun.stock < item.quantity) {
        yetersiz.push(`${urun?.name || "Ürün"} (kalan: ${urun?.stock ?? 0})`);
      }
    }
    if (yetersiz.length) {
      return res.status(400).json({ error: `Şu ürünlerde yeterli stok kalmadı: ${yetersiz.join(", ")}. Sepetinizi güncelleyip tekrar deneyin.` });
    }
  }

  // Kampanyalar burada yeniden hesaplanır; tarayıcının gönderdiği indirim yok sayılır.
  const campaigns = await evaluateCampaigns(normalized, body.coupon_code);
  const discount = Math.min(campaigns.discount, subtotal);
  const netTotal = round2(subtotal - discount);

  // Prices are KDV-hariç (net); VAT is added on top — and on the *discounted*
  // net, not the original. Shipping is recipient-paid, so it is not added.
  const taxRate = (await pricingSettings())?.tax_rate ?? KDV_RATE;

  const orderNumber = await db.transaction(async (tx) => {
    /* Kontenjan rezervasyonu — sipariş yazılmadan ÖNCE, çünkü kontenjan
       dolmuşsa indirim de düşmeli. Kontrol ile artırma tek ifadede: kararı
       veritabanı veriyor, satır güncellenmediyse kontenjan o an dolmuş
       demektir. Eskiden limit yukarıda okunup burada körlemesine +1
       yapılıyordu; aynı anda gelen istekler hepsi "yer var" cevabı alıp
       limiti aşabiliyordu. */
    const rezerve = tx.prepare(`
      UPDATE campaigns SET used_count = used_count + 1
      WHERE id = ? AND (usage_limit IS NULL OR used_count < usage_limit)
    `);
    const gecerliKampanyalar = [];
    for (const c of campaigns.applied) {
      const sonuc = await rezerve.run(c.id);
      if (sonuc.changes) gecerliKampanyalar.push(c);
    }
    const gecerliIdler = new Set(gecerliKampanyalar.map((c) => c.id));
    const gecerliHediyeler = campaigns.gifts.filter((g) => !g.campaign_id || gecerliIdler.has(g.campaign_id));

    // Tutarı rezervasyondan SONRA, yalnızca hak edilen indirimlerle hesapla.
    const uygulananIndirim = Math.min(
      round2(gecerliKampanyalar.reduce((toplam, c) => toplam + (Number(c.amount) || 0), 0)),
      subtotal
    );
    const uygulananNet = round2(subtotal - uygulananIndirim);

    const cust = await tx.prepare("INSERT INTO customers (name, email, phone, address, city) VALUES (?,?,?,?,?)").run(
      customer.name.trim(), customer.email?.trim() || null, customer.phone.trim(), customer.address.trim(), customer.city?.trim() || null
    );

    const taxAmount = round2(uygulananNet * taxRate / 100);
    const grandTotal = round2(uygulananNet + taxAmount);
    const shippingMethod = grandTotal >= FREE_SHIPPING_THRESHOLD ? "free" : "recipient_paid";
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
        @tax_rate, @tax_amount, @shipping_method, @campaign_summary)
    `).run({
      order_number: generatedNumber,
      customer_id: cust.lastInsertRowid,
      shipping_address: shippingAddress,
      subtotal,
      discount: uygulananIndirim,
      // Kampanya sonradan silinse bile siparişte ne uygulandığı okunabilir kalsın.
      campaign_summary: gecerliKampanyalar.length
        ? gecerliKampanyalar.map((c) => c.label).join(" · ")
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
      tax_amount: taxAmount,
      shipping_method: shippingMethod
    });

    const insertItem = tx.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, scale, quantity, unit_price, line_total)
      VALUES (@order_id, @product_id, @product_name, @scale, @quantity, @unit_price, @line_total)
    `);
    for (const item of normalized) {
      await insertItem.run({ ...item, order_id: order.lastInsertRowid });
    }

    // Hediyeler siparişe 0 TL'lik satır olarak yazılır: atölye ne göndereceğini
    // sipariş kaleminden görür, tutar etkilenmez.
    for (const gift of gecerliHediyeler) {
      await insertItem.run({
        order_id: order.lastInsertRowid,
        product_id: gift.product_id,
        product_name: `${gift.product_name} (Hediye)`,
        scale: null,
        quantity: gift.quantity,
        unit_price: 0,
        line_total: 0
      });
    }

    /* Kimin kullandığı burada kayda geçer. Sayaç yukarıda zaten rezerve
       edildi; burada yalnızca hak edilen kullanımlar yazılıyor, böylece
       used_count ile bu listenin uzunluğu her zaman aynı kalıyor. */
    const kullanimKaydi = tx.prepare(`
      INSERT INTO campaign_uses (campaign_id, order_id, order_number, customer_name, customer_phone, customer_email, discount_amount)
      VALUES (@campaign_id, @order_id, @order_number, @customer_name, @customer_phone, @customer_email, @discount_amount)
    `);
    for (const c of gecerliKampanyalar) {
      await kullanimKaydi.run({
        campaign_id: c.id,
        order_id: order.lastInsertRowid,
        order_number: generatedNumber,
        customer_name: customer.name.trim(),
        customer_phone: customer.phone.trim(),
        customer_email: customer.email?.trim() || null,
        discount_amount: Number(c.amount) || 0
      });
    }

    // Stok takibi açıksa satılan adet düşülür. Kapalıyken (varsayılan) stok
    // yalnızca bilgi amaçlı bir sayı olarak kalır.
    if (stokTakibi) {
      const dus = tx.prepare("UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?");
      for (const item of normalized) await dus.run(item.quantity, item.product_id);
    }

    return { order_number: generatedNumber, shipping_method: shippingMethod };
  });

  res.status(201).json(orderNumber);
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
  const site = await db.prepare("SELECT phone, email, contact_address, working_hours, social_links, show_stock, min_cart_total FROM site_settings WHERE id = 1").get() || {};
  const pricing = await db.prepare("SELECT tax_rate FROM pricing_settings WHERE id = 1").get() || {};
  const { wa } = await contactInfo();
  res.json({
    tax_rate: pricing.tax_rate ?? 20,
    phone: site.phone || "",
    email: site.email || "",
    whatsapp: wa ? `https://wa.me/${wa}` : "",
    address: site.contact_address || "",
    working_hours: site.working_hours || "",
    social_links: site.social_links || "",
    show_stock: site.show_stock ?? 1,
    min_cart_total: Number(site.min_cart_total ?? 0),
    free_shipping_threshold: FREE_SHIPPING_THRESHOLD
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

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const db = require("./db.js");
// Ürün kartı/detayı işaretlemesi. Tarayıcı da AYNI dosyayı yüklüyor.
const sablonlar = require("./product-templates.js");
const storage = require("./storage.js");
const shopier = require("./shopier.js");

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
// Blog stays reachable by its direct URL while it is being reviewed, but it is
// not advertised or indexed until BLOG_DISCOVERABLE=1 is explicitly enabled.
const BLOG_DISCOVERABLE = process.env.BLOG_DISCOVERABLE === "1";
const ADMIN_LOCKED = IS_PRODUCTION && ["ADMIN_PASSWORD", "SESSION_SECRET"].some((key) => !process.env[key]);
if (ADMIN_LOCKED) {
  console.error("UYARI: ADMIN_PASSWORD veya SESSION_SECRET tanımlı değil — admin paneli kilitlendi.");
}
const SESSION_COOKIE = "printable_admin";
const CUSTOMER_SESSION_COOKIE = "printable_customer";
const STORE_NOTIFICATION_EMAILS = [...new Set([
  "info@printable.com.tr",
  ...String(process.env.STORE_NOTIFICATION_EMAILS || "")
    .split(",").map((email) => email.trim()).filter(Boolean)
])];
/* İlk kurulumda açılacak panel hesapları. Sadece admin_users tablosu boşken
   kullanılır; sonrası panelden yönetilir. ADMIN_USER da listeye katılır ki
   eski tek-hesap kurulumları giriş yapabilmeye devam etsin. */
const SEED_ADMIN_USERS = [...new Set(
  (process.env.ADMIN_USERS || "ogulcan,furkan").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean).concat(ADMIN_USER.toLowerCase())
)];
const KDV_RATE = 0; // Vitrinde görünen fiyat müşterinin ödediği nihai ürün fiyatıdır.
const FREE_SHIPPING_THRESHOLD = 599; // İndirim sonrası nihai ürün toplamı.

/* PayTR bilgileri yalnızca sunucuda tutulur. Test modu bilinçli olarak güvenli
   varsayılandır: gerçek tahsilat ancak PAYTR_TEST_MODE=0 açıkça verilirse başlar. */
const PAYTR_MERCHANT_ID = String(process.env.PAYTR_MERCHANT_ID || "").trim();
const PAYTR_MERCHANT_KEY = String(process.env.PAYTR_MERCHANT_KEY || "").trim();
const PAYTR_MERCHANT_SALT = String(process.env.PAYTR_MERCHANT_SALT || "").trim();
const PAYTR_CONFIGURED = Boolean(PAYTR_MERCHANT_ID && PAYTR_MERCHANT_KEY && PAYTR_MERCHANT_SALT);
const PAYTR_TEST_MODE = process.env.PAYTR_TEST_MODE === "0" ? "0" : "1";
const PAYTR_DEBUG_ON = process.env.PAYTR_DEBUG_ON === "1"
  ? "1"
  : process.env.PAYTR_DEBUG_ON === "0" ? "0" : PAYTR_TEST_MODE;
const PAYTR_NO_INSTALLMENT = process.env.PAYTR_NO_INSTALLMENT === "1" ? "1" : "0";
const PAYTR_MAX_INSTALLMENT = new Set(["0", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"])
  .has(String(process.env.PAYTR_MAX_INSTALLMENT || "0"))
  ? String(process.env.PAYTR_MAX_INSTALLMENT || "0")
  : "0";
const PAYTR_TIMEOUT_LIMIT = String(Math.min(60, Math.max(5, Number.parseInt(process.env.PAYTR_TIMEOUT_LIMIT || "30", 10) || 30)));
const PAYTR_TOKEN_URL = "https://www.paytr.com/odeme/api/get-token";
const PAYTR_IFRAME_BASE = "https://www.paytr.com/odeme/guvenli/";

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
const SCHEMA_VERSION = "32";

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
    shopier_product_id TEXT,
    shopier_product_url TEXT,
    shopier_sync_status TEXT NOT NULL DEFAULT 'pending',
    shopier_sync_error TEXT,
    shopier_synced_at TIMESTAMPTZ,
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
    payment_provider TEXT,
    payment_reference TEXT UNIQUE,
    payment_failure_code TEXT,
    payment_failure_message TEXT,
    payment_collected_amount INTEGER,
    payment_test_mode INTEGER,
    inventory_deducted INTEGER NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ,
    tax_rate REAL NOT NULL DEFAULT 0,
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
    tax_rate REAL NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  /* Gramaj kademeleri — "çok alana ucuz gram". Kademe MUTLAK bir gram fiyatı
     değil, YÜZDE indirim tutar: mutlak yazsaydık "500 g üstü 4 TL" kuralı
     reçineyi (10,50 TL/g) maliyetin çok altına düşürürdü. Yüzde ile PLA
     5,00 → 4,00 inerken reçine de aynı oranda iner, malzemeler arası fark
     korunur.

     min_grams, siparişin TAMAMININ gramajıdır (parça ağırlığı × adet):
     müşteriyi tek bir dev parça basmaya değil, sepeti büyütmeye teşvik eder. */
  CREATE TABLE IF NOT EXISTS pricing_tiers (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    min_grams REAL NOT NULL DEFAULT 0,
    discount_percent REAL NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  -- Blog posts are deliberately content-first: the automation can send one
  -- complete record without relying on a page builder or client-side state.
  -- Status keeps drafts and scheduled posts out of the public index.
  CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    excerpt TEXT,
    content TEXT NOT NULL DEFAULT '',
    cover_image TEXT,
    cover_alt TEXT,
    media_url TEXT,
    media_type TEXT NOT NULL DEFAULT 'none',
    author_name TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    published_at TIMESTAMPTZ,
    meta_title TEXT,
    meta_description TEXT,
    meta_keywords TEXT,
    canonical TEXT,
    og_title TEXT,
    og_description TEXT,
    og_image TEXT,
    robots TEXT NOT NULL DEFAULT 'index,follow',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (media_type IN ('none', 'image', 'video', 'embed')),
    CHECK (status IN ('draft', 'scheduled', 'published'))
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
    per_customer_limit INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    show_on_banner INTEGER NOT NULL DEFAULT 0,
    show_on_popup INTEGER NOT NULL DEFAULT 0,
    popup_repeat_minutes INTEGER,
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
    media_type TEXT NOT NULL DEFAULT 'image',
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
  ["products", "shopier_product_id", "TEXT"],
  ["products", "shopier_product_url", "TEXT"],
  ["products", "shopier_sync_status", "TEXT NOT NULL DEFAULT 'pending'"],
  ["products", "shopier_sync_error", "TEXT"],
  ["products", "shopier_synced_at", "TIMESTAMPTZ"],
  ["product_images", "media_type", "TEXT NOT NULL DEFAULT 'image'"],
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
  ["orders", "payment_provider", "TEXT"],
  ["orders", "payment_reference", "TEXT"],
  ["orders", "payment_failure_code", "TEXT"],
  ["orders", "payment_failure_message", "TEXT"],
  ["orders", "payment_collected_amount", "INTEGER"],
  /* Ölçüm kimlikleri. Satın alma olayı ödeme onaylandığında SUNUCUDAN
     gönderiliyor; o an istek PayTR'den geliyor, müşterinin tarayıcısından
     değil, dolayısıyla çerezler yok. Bu yüzden client_id sipariş
     oluşturulurken yakalanıp burada saklanıyor — onsuz satış GA4'te
     kimsesiz bir olay olur ve reklam tıklamasıyla ilişkilendirilemez. */
  ["orders", "ga_client_id", "TEXT"],
  ["orders", "ga_session_id", "TEXT"],
  ["orders", "payment_test_mode", "INTEGER"],
  ["orders", "inventory_deducted", "INTEGER NOT NULL DEFAULT 0"],
  ["orders", "paid_at", "TIMESTAMPTZ"],
  // KDV dökümü + kargo yöntemi (kargo alıcı ödemeli).
  ["orders", "tax_rate", "REAL NOT NULL DEFAULT 0"],
  ["orders", "tax_amount", "REAL NOT NULL DEFAULT 0"],
  ["orders", "shipping_method", "TEXT"],
  // Eski kurulumlardan kalan fiyat ayarı + iletişim bilgileri.
  ["pricing_settings", "tax_rate", "REAL NOT NULL DEFAULT 0"],
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
  ["quotes", "painted", "INTEGER NOT NULL DEFAULT 0"],
  // Sitede üstteki geri sayım şeridinde duyurulsun mu? Kodu herkese açık
  // yayınlamayı admin bilerek seçtiğinde işaretlenir (bkz. /api/campaigns/banner).
  ["campaigns", "show_on_banner", "INTEGER NOT NULL DEFAULT 0"],
  // Aynı duyuru, ilk ziyarette bir kez açılan pencere olarak.
  ["campaigns", "show_on_popup", "INTEGER NOT NULL DEFAULT 0"],
  /* Pencere kapatıldıktan kaç dakika sonra tekrar açılabilir?
     NULL = bir daha açılmaz, 0 = her sayfa yüklemesinde. */
  ["campaigns", "popup_repeat_minutes", "INTEGER"],
  /* Kişi başı kullanım hakkı. usage_limit ile KARIŞTIRILMAMALI: o site
     genelinde toplam kontenjan, bu ise aynı müşterinin kaç kez
     kullanabileceği. NULL = kişi başı sınır yok. */
  ["campaigns", "per_customer_limit", "INTEGER"]
]) {
  if (!(await hasColumn(table, column))) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Eski tabloda ALTER ile eklenen payment_reference için de benzersizlik garantisi.
await db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_reference_unique
  ON orders (payment_reference) WHERE payment_reference IS NOT NULL;
`);

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
  // Fiyatlar içeride hacimle hesaplanır; müşteri tarafındaki baz gramdır.
  const materials = [
    { name: "PLA", description: "Standart, ekonomik, iç mekan kullanımı", price_per_cm3: 6.20, density_g_cm3: 1.24 },
    { name: "PETG", description: "Dayanıklı, ısıya ve neme daha dirençli", price_per_cm3: 8.26, density_g_cm3: 1.27 },
    { name: "ABS", description: "Mekanik parçalar, yüksek sıcaklık dayanımı", price_per_cm3: 6.24, density_g_cm3: 1.04 },
    { name: "Reçine (SLA)", description: "Yüksek detay, pürüzsüz yüzey", price_per_cm3: 11.55, density_g_cm3: 1.10 }
  ];
  for (const [index, material] of materials.entries()) {
    await seedMaterial.run({ ...material, sort_order: index + 1 });
  }
}

/* PLA 5,00 TL/g temel alınır. Diğer malzemelerin birbirine olan eski oranı
   korunarak gram fiyatları: ABS 6,00; PETG 6,50; Reçine 10,50 TL/g.
   Hesap motoru hacim kullandığı için değerler yoğunlukla çarpılmıştır.

   Sürüm anahtarıyla korunuyor: bu blok eskiden her SCHEMA_VERSION artışında
   koşulsuz çalışıyordu, yani panelden elle girilen her fiyat bir sonraki
   şema güncellemesinde sessizce eski değere dönüyordu. Artık zam yalnızca
   bir kez, kendi sürümüyle iner; sonrasında fiyatın sahibi paneldir. */
const FIYAT_REVIZYONU = "2026-08-gram-zam";
const fiyatRevizyonu = await db.prepare("SELECT value FROM app_meta WHERE key = 'materials_price_rev'").get();
if (fiyatRevizyonu?.value !== FIYAT_REVIZYONU) {
  await db.prepare(`
    UPDATE materials SET price_per_cm3 = CASE
      WHEN LOWER(name) = 'pla' THEN 6.20
      WHEN LOWER(name) = 'petg' THEN 8.26
      WHEN LOWER(name) = 'abs' THEN 6.24
      WHEN LOWER(name) = 'reçine (sla)' OR LOWER(name) = 'resin (sla)' THEN 11.55
      ELSE price_per_cm3
    END
    WHERE LOWER(name) IN ('pla', 'petg', 'abs', 'reçine (sla)', 'resin (sla)')
  `).run();
  await db.prepare(`
    INSERT INTO app_meta (key, value) VALUES ('materials_price_rev', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(FIYAT_REVIZYONU);
}

/* Varsayılan kademe merdiveni. PLA üzerinden okunuşu:
   5,00 → 4,50 → 4,20 → 4,00 TL/g. */
const VARSAYILAN_KADEMELER = [[0, 0], [250, 10], [500, 16], [1000, 20]];

/* Kademeler yalnızca tablo boşken tohumlanır — panelden değiştirilen bir
   kademe bir sonraki şema güncellemesinde geri gelmemeli. */
if (!(await db.prepare("SELECT COUNT(*) count FROM pricing_tiers").get()).count) {
  const seedTier = db.prepare("INSERT INTO pricing_tiers (min_grams, discount_percent) VALUES (?, ?)");
  for (const [grams, percent] of VARSAYILAN_KADEMELER) await seedTier.run(grams, percent);
}

/* Eşikler bir kez yukarı kaydırıldı: ilk indirim 100 g yerine 250 g'de
   başlıyor — 100 g fazla ucuza geliyordu. Fiyat zammıyla aynı kalıp: sürüm
   anahtarına bağlı, bir kez iner, sonrasında kademelerin sahibi yine panel.
   Tablo dolu olduğu için yukarıdaki tohumlama canlıya ulaşmıyor, güncelleme
   ancak böyle geçiyor. */
const KADEME_REVIZYONU = "2026-08-esik-250";
const kademeRevizyonu = await db.prepare("SELECT value FROM app_meta WHERE key = 'pricing_tiers_rev'").get();
if (kademeRevizyonu?.value !== KADEME_REVIZYONU) {
  await db.transaction(async (tx) => {
    await tx.prepare("DELETE FROM pricing_tiers").run();
    const ekle = tx.prepare("INSERT INTO pricing_tiers (min_grams, discount_percent) VALUES (?, ?)");
    for (const [grams, percent] of VARSAYILAN_KADEMELER) await ekle.run(grams, percent);
  });
  await db.prepare(`
    INSERT INTO app_meta (key, value) VALUES ('pricing_tiers_rev', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(KADEME_REVIZYONU);
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
      title: "3D Baskı Ürünleri ve Özel Parça Tasarımı | Printable",
      description: "Hazır 3D baskı figür, oyuncak ve anahtarlık ürünleri. Modeliniz yoksa parçanızı biz çizeriz; STL dosyanızı yükleyip anında fiyat alın.",
      canonical: "",
      og_title: "3D Baskı Ürünleri ve Özel Parça Tasarımı | Printable",
      og_description: "Hazır ürünler, ölçüye göre özel parça çizimi ve STL baskı — hepsi tek atölyede.",
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
    slug: "blog", label: "Blog sayfası",
    title: "3D Baskı Rehberi, Fikirler ve İpuçları | Printable",
    description: "3D baskı malzemeleri, tasarım fikirleri, ürün rehberleri ve atölyeden pratik bilgiler.",
    og_title: "Printable Blog | 3D Baskı Rehberi ve Fikirler",
    og_description: "3D baskı dünyasından anlaşılır rehberler, fikirler ve pratik ipuçları."
  },
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
  },
  {
    slug: "landing", label: "Ürün seçkisi (landing) sayfası",
    title: "Printable Ürün Seçkisi | 3D Baskı Ürünleri",
    description: "Öne çıkan 3D baskı figür, oyuncak, anahtarlık ve fidget ürünlerini fiyatlarıyla inceleyin; Katlaç ve Spinball koleksiyonlarını keşfedin.",
    og_title: "Printable Ürün Seçkisi | 3D Baskı Ürünleri",
    og_description: "Öne çıkan 3D baskı ürünlerini fiyatlarıyla görün, seçin ve doğrudan sepetinize ekleyin."
  },
  {
    slug: "tasarim", label: "Özel tasarım sayfası",
    title: "Özel Parça Tasarımı ve Teknik Çizim | Printable",
    description: "Dosyanız yoksa parçanızı biz çizeriz: yedek parça, adaptör, kasnak ve özel aparatların 3D tasarımını yapıp basıyoruz.",
    og_title: "Özel Parça Tasarımı ve Teknik Çizim | Printable",
    og_description: "Ölçüyü siz verin, çizimi ve baskısını biz yapalım."
  },
  {
    slug: "anahtarlik-katalogu", label: "Anahtarlık toptan kataloğu",
    title: "Toptan Anahtarlık Kataloğu | Printable",
    description: "3D baskılı anahtarlık koleksiyonunu inceleyin, istediğiniz modelleri seçip Excel listesi olarak indirin.",
    og_title: "Toptan Anahtarlık Kataloğu | Printable",
    og_description: "Seçtiğiniz anahtarlık modellerini tek tıkla Excel'e aktarın."
  }
];
for (const page of extraSeoPages) await addSeoPage.run(page);

/* Paylaşım görseli. ON CONFLICT DO NOTHING satırı zaten varsa hiçbir alanı
   güncellemez, bu yüzden og_image ayrı geliyor. SADECE boşsa doldurur —
   adminden girilen bir görselin üstüne asla yazmaz. Varsayılan site görseli
   bu sayfada yanlış: reklam ve WhatsApp paylaşımında ejderha tepsi fotoğrafı
   yerine çizim işlerini gösteren kart çıkmalı. */
const varsayilanOgGorselleri = [
  { slug: "tasarim", og_image: "/assets/tasarim/tasarim-og-1200x630.jpg" },
  // Landing'in meta'sı eskiden HTML'e gömülüydü ve kendi paylaşım görseli vardı;
  // sunucuya devredilirken kaybolmasın.
  { slug: "landing", og_image: "/assets/shopier/21.jpg" }
];
for (const g of varsayilanOgGorselleri) {
  await db.prepare(`
    UPDATE seo_pages SET og_image = @og_image
     WHERE slug = @slug AND COALESCE(NULLIF(TRIM(og_image), ''), '') = ''
  `).run(g);
}

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

// These five records belong to the standalone wholesale keychain catalogue,
// not the storefront product inventory. Remove the misplaced previous release
// on every database migration; the SKU scope is explicit and safe.
await db.prepare("DELETE FROM products WHERE sku IN ('MW-2325579', 'MW-2081222', 'MW-1682650', 'MW-2316097', 'MW-1518291')").run();

// A published example makes the new blog design and its structured-data output
// visible immediately. It is safe to edit or delete later from Admin > Blog.
await db.prepare(`
  INSERT INTO blog_posts (slug, title, excerpt, content, cover_image, cover_alt, author_name, status, published_at, meta_title, meta_description, meta_keywords, canonical, og_title, og_description, og_image, robots)
  VALUES (@slug, @title, @excerpt, @content, @cover_image, @cover_alt, @author_name, 'published', NOW(), @meta_title, @meta_description, @meta_keywords, @canonical, @og_title, @og_description, @og_image, 'index,follow')
  ON CONFLICT (slug) DO NOTHING
`).run({
  slug: "3d-baski-anahtarlik-secerken-nelere-dikkat-etmeli",
  title: "3D Baskı Anahtarlık Seçerken Nelere Dikkat Etmeli?",
  excerpt: "Malzeme, kullanım amacı ve tasarım detayları üzerinden uzun ömürlü bir 3D baskı anahtarlık seçmenin kısa rehberi.",
  content: `<p>3D baskı anahtarlıklar, küçük bir hediyeyi veya günlük kullandığınız anahtar takımını kişiselleştirmenin pratik yoludur. Doğru modeli seçerken görünüm kadar kullanım şekli de önemlidir.</p>
<h2>1. Kullanım amacını belirleyin</h2><p>Çanta süsü, promosyon ürünü veya günlük anahtarlık için farklı kalınlıklar ve halka noktaları gerekir. Sık kullanılacak bir modelde bağlantı halkasının gövdeden yeterince kalın olmasına dikkat edin.</p>
<h2>2. Malzeme seçimi fark yaratır</h2><p>PLA, canlı renkleri ve temiz yüzeyiyle dekoratif anahtarlıklar için güçlü bir başlangıçtır. Daha esnek ya da darbeye dayanıklı bir kullanım gerekiyorsa tasarım ve malzeme seçimini birlikte değerlendirmek en iyi sonucu verir.</p>
<h2>3. Tasarımı okunaklı tutun</h2><p>Çok küçük yazılar ve ince detaylar baskıda kaybolabilir. Tek bakışta ayırt edilebilen siluetler, güçlü kontrastlar ve sade renk kombinasyonları anahtarlıkta daha etkili görünür.</p>
<h2>4. Kişiselleştirme seçeneklerini inceleyin</h2><p>İsim, renk veya küçük bir simge eklemek anahtarlığı daha anlamlı hâle getirir. İlham için <a href="/anahtarlik-katalogu">anahtarlık kataloğundaki modelleri</a> inceleyebilir, baskıya uygun bir fikriniz varsa bize iletebilirsiniz.</p>
<p>İyi bir anahtarlık; hafif, dayanıklı ve sizi yansıtan bir tasarımı bir araya getirir. Seçim yaparken bu dört başlık, hem kullanım ömrünü hem de görünümü iyileştirir.</p>`,
  cover_image: "/assets/blog/3d-baski-anahtarlik-secim-rehberi.png",
  cover_alt: "3D yazıcı ve renkli anahtarlık örnekleriyle 3D baskı atölyesi",
  author_name: "Printable Atölye",
  meta_title: "3D Baskı Anahtarlık Seçme Rehberi | Printable",
  meta_description: "3D baskı anahtarlık seçerken malzeme, kullanım amacı, tasarım ve kişiselleştirme ayrıntılarına dair pratik rehber.",
  meta_keywords: "3d baskı anahtarlık, anahtarlık seçme rehberi, pla anahtarlık, kişiselleştirilmiş anahtarlık",
  canonical: "/blog/3d-baski-anahtarlik-secerken-nelere-dikkat-etmeli",
  og_title: "3D Baskı Anahtarlık Seçme Rehberi",
  og_description: "Dayanıklı, kullanışlı ve kişisel bir 3D baskı anahtarlık için 4 pratik ipucu.",
  og_image: "/assets/blog/3d-baski-anahtarlik-secim-rehberi.png"
});

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

const localUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    cb(null, `${Date.now()}-${safe}${ext}`);
  }
});

const upload = multer({
  storage: localUploadStorage,
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype));
  },
  limits: { fileSize: 8 * 1024 * 1024 }
});

// Ürün galerisi fotoğrafın yanında kısa MP4/WEBM ürün videoları da kabul eder.
// Kapak, banner ve kategori yüklemeleri yukarıdaki image-only middleware'de kalır.
const galleryUpload = multer({
  storage: localUploadStorage,
  fileFilter: (req, file, cb) => {
    cb(null, /^(image\/(png|jpe?g|webp|gif)|video\/(mp4|webm))$/i.test(file.mimetype));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
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
  const requestedKind = req.body?.kind;
  const kind = ["image", "media", "model"].includes(requestedKind) ? requestedKind : "model";
  if (kind !== "model" && !(await isAuthed(req))) {
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

// Google Analytics measurement IDs are public identifiers, not secrets. The
// environment variable makes it easy to use another stream without a deploy;
// the fallback keeps the production stream active on every public page.
const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || "G-MSSH4XTMNC";
const googleAnalyticsTag = /^G-[A-Z0-9]+$/.test(GA_MEASUREMENT_ID)
  ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","${GA_MEASUREMENT_ID}");</script>`
  : "";

/* ---------- Sunucu taraflı satın alma ölçümü (GA4 Measurement Protocol) ----------
 *
 * Satın alma olayı eskiden yalnızca tarayıcıdan gidiyordu: müşteri ödeme sonrası
 * "ödemeniz onaylandı" ekranına döndüğünde. Tarayıcıyı erken kapatan müşterinin
 * satışı GA4'e hiç düşmüyordu — para hesaba geçiyor, ölçüm kaçıyordu.
 *
 * Artık olayı PayTR ödemeyi onayladığı anda sunucu gönderiyor; müşteri ne
 * yaparsa yapsın kayıt oluşuyor.
 *
 * api_secret GİZLİDİR, istemciye asla gönderilmez (GA4 → Veri akışları →
 * Measurement Protocol API gizli anahtarları'ndan üretilir). Tanımlı değilse
 * fonksiyon sessizce çıkar; ölçüm eksikliği sipariş akışını bozmamalı. */
const GA_API_SECRET = process.env.GA_API_SECRET || "";

/* Açılışta durumu bir kez yaz. Anahtar tanımlı değilken fonksiyon sessizce
   çıkıyor; hata da log'a düşmediği için "çalışıyor" ile "hiç denenmedi"
   dışarıdan ayırt edilemiyordu. Bu satır o belirsizliği kaldırır. */
console.log(GA_API_SECRET
  ? "GA4 sunucu taraflı satın alma ölçümü: ETKİN"
  : "GA4 sunucu taraflı satın alma ölçümü: KAPALI (GA_API_SECRET tanımsız) — ölçüm yalnızca tarayıcıdan yapılacak");

/* GA4'ün `_ga` çerezi "GA1.1.<client_id>" biçimindedir; client_id iki parçadır
   (rastgele sayı + ilk ziyaret zaman damgası). Oturum kimliği ise mülke özel
   `_ga_<ölçüm kimliği>` çerezinde, "GS2.1.s<session_id>$..." içinde durur. */
function gaKimlikleri(req) {
  const cookies = parseCookies(req);
  const ga = cookies._ga || "";
  const parcalar = ga.split(".");
  const clientId = parcalar.length >= 4 ? `${parcalar[2]}.${parcalar[3]}` : null;

  const oturumCerezi = Object.entries(cookies).find(([ad]) => ad.startsWith("_ga_"));
  const eslesme = oturumCerezi ? String(oturumCerezi[1]).match(/(?:^|\.)s?(\d{9,})/) : null;
  return { clientId, sessionId: eslesme ? eslesme[1] : null };
}

async function gaSatinAlmaBildir(orderId) {
  if (!GA_API_SECRET || !/^G-[A-Z0-9]+$/.test(GA_MEASUREMENT_ID)) return;

  const order = await db.prepare(`
    SELECT order_number, total, ga_client_id, ga_session_id FROM orders WHERE id = ?
  `).get(orderId);
  /* client_id yoksa göndermiyoruz. Rastgele bir kimlikle göndermek satışı
     GA4'te kimsesiz bir kullanıcıya yazar: ciro görünür ama hangi reklamın
     getirdiği kaybolur — ölçümün asıl amacı da buydu. */
  if (!order?.ga_client_id) return;

  const items = (await db.prepare(`
    SELECT product_id, product_name, quantity, unit_price FROM order_items WHERE order_id = ?
  `).all(orderId)).map((i) => ({
    item_id: String(i.product_id ?? ""),
    item_name: i.product_name,
    price: Number(i.unit_price) || 0,
    quantity: Number(i.quantity) || 1
  }));

  const govde = {
    client_id: order.ga_client_id,
    events: [{
      name: "purchase",
      params: {
        /* Aynı transaction_id ile gelen satın almaları GA4 tekilleştiriyor;
           tarayıcı da aynı olayı göndermiş olsa iki kez sayılmaz. */
        transaction_id: order.order_number,
        currency: "TRY",
        value: Number(order.total) || 0,
        items,
        ...(order.ga_session_id ? { session_id: order.ga_session_id } : {}),
        engagement_time_msec: 1
      }
    }]
  };

  const yanit = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(GA_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA_API_SECRET)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(govde) }
  );
  // MP başarıda 204 döner ve gövde vermez; hata ayrıntısı yalnızca debug ucunda.
  if (!yanit.ok) throw new Error(`GA4 Measurement Protocol ${yanit.status}`);
  // Başarıyı da yaz: siparişin ölçüme gidip gitmediği log'dan doğrulanabilsin.
  console.log(`GA4 satın alma bildirildi: ${order.order_number} (${Number(order.total).toFixed(2)} TL)`);
}

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
  /* /tasarim reklamda öne çıkarılacak bir HİZMET sayfası, ürün listesi değil.
     Organization + WebSite bunu anlatmıyor; arama motoruna ne sattığımızı
     söyleyen düğüm bu. Yalnızca o slug'a eklenir. */
  if (slug === "tasarim") {
    jsonLd["@graph"].push({
      "@type": "Service",
      name: "Özel parça tasarımı ve 3D baskı",
      serviceType: "3D modelleme ve 3D baskı hizmeti",
      description: "Ölçü, fotoğraf veya krokiden yola çıkarak yedek parça, adaptör, kasnak ve özel aparatların 3D tasarımını yapıp üretiyoruz.",
      ...(canonical ? { url: canonical } : {}),
      provider: { "@type": "Organization", name: site.site_name || "Printable", url: siteUrl },
      areaServed: { "@type": "Country", name: "Türkiye" },
      availableChannel: {
        "@type": "ServiceChannel",
        serviceUrl: absoluteUrl(req, "/iletisim", site.site_url)
      }
    });
  }

  /* Breadcrumb. Arama sonucunda ham adres yerine "Ana Sayfa › Ürünler" yolu
     görünür — ürün sayfalarında zaten vardı (productMetaTags), alt sayfalarda
     yoktu. Google en az iki basamak istiyor, o yüzden ana sayfaya eklenmiyor.
     Ad olarak menüdeki/başlıktaki karşılığı kullanılıyor; Google "adres
     yapısını değil, kullanıcının izlediği yolu yansıtın" diyor. */
  const yolAdlari = {
    urunler: "Ürünler",
    tasarim: "Özel Tasarım",
    "stl-teklif": "STL Teklif",
    hakkinda: "Hakkımızda",
    iletisim: "İletişim",
    sss: "Sıkça Sorulan Sorular",
    katalog: "Katalog",
    "anahtarlik-katalogu": "Toptan Anahtarlık Kataloğu",
    landing: "Ürün Seçkisi",
    iade: "İade ve Cayma Hakkı",
    gizlilik: "Gizlilik ve KVKK",
    "mesafeli-satis": "Mesafeli Satış Sözleşmesi"
  };
  if (yolAdlari[slug]) {
    jsonLd["@graph"].push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Ana Sayfa", item: siteUrl },
        { "@type": "ListItem", position: 2, name: yolAdlari[slug], item: absoluteUrl(req, `/${slug}`, site.site_url) }
      ]
    });
  }

  /* /landing bir ürün seçkisi sayfası; ona uygun düğüm ItemList. Yalnızca
     SUNUCUNUN BASTIĞI beş vitrin ürünü listeleniyor — aşağıdaki raf hâlâ JS ile
     doluyor ve yapısal verinin sayfada görünmeyen içeriği anlatmaması gerekiyor.
     Fiyatlar da aynı sorgudan geldiği için şema ile ekrandaki rakam ayrışamaz. */
  if (slug === "landing") {
    const urunler = await db.prepare(
      "SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC, id DESC"
    ).all();
    const secim = sablonlar.preferredProductList(
      (await decorateProducts(urunler)).map(maliyetiGizle), [21, 53, 22, 39, 35], 5
    );
    if (secim.length) {
      jsonLd["@graph"].push({
        "@type": "ItemList",
        name: "Öne çıkan 3D baskı ürünleri",
        numberOfItems: secim.length,
        itemListElement: secim.map((p, i) => {
          const adres = absoluteUrl(req, `/urun/${p.id}`, site.site_url);
          const gorsel = absoluteUrl(req, p.image_path, site.site_url);
          return {
            "@type": "ListItem",
            position: i + 1,
            item: {
              "@type": "Product",
              name: p.name,
              ...(gorsel ? { image: gorsel } : {}),
              url: adres,
              brand: { "@type": "Brand", name: site.site_name || "Printable" },
              offers: {
                "@type": "Offer",
                price: Number(sablonlar.displayPrice(p) || 0).toFixed(2),
                priceCurrency: "TRY",
                availability: p.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
                url: adres
              }
            }
          };
        })
      });
    }
  }

  // "<" is escaped so a value can never break out of the script element.
  tags.push(`<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`);

  return tags.join("\n    ");
}

// One header for every public page, injected server-side so the navbar can never
// drift between pages again. `active` marks the current main-await link (home | urunler | stl-teklif).

// Üst kısımdaki geri sayımlı kampanya şeridi. Kampanya yoksa boş döner ve hiçbir
// şey basılmaz. Sayaç istemcide çalışır (sunucu her istekte hesaplamaz); kod bir
// tıkla panoya kopyalanır.
async function renderPromoBar() {
  const campaign = await liveBannerCampaign();
  if (!campaign) return "";
  const { name, code, deadline } = bannerPayload(campaign);
  const amount = promoAmount(campaign);
  return `
    <div class="campaign-bar" id="campaign-bar" data-deadline="${escapeHtml(deadline || "")}">
      <div class="container campaign-bar__inner">
        <span class="campaign-bar__msg"><strong>${escapeHtml(name)}</strong> — ${amount} indirim</span>
        <button type="button" class="campaign-bar__code" id="campaign-bar-code" data-code="${escapeHtml(code)}">
          Kod: <strong>${escapeHtml(code)}</strong>
        </button>
        ${deadline ? `<span class="campaign-bar__timer" id="campaign-bar-timer" aria-live="off"></span>` : ""}
      </div>
    </div>
    <script>(function(){
      var bar=document.getElementById('campaign-bar');
      if(!bar) return;
      var codeBtn=document.getElementById('campaign-bar-code');
      if(codeBtn) codeBtn.addEventListener('click', function(){
        var code=codeBtn.getAttribute('data-code');
        if(navigator.clipboard) navigator.clipboard.writeText(code).catch(function(){});
        codeBtn.classList.add('is-copied');
        setTimeout(function(){ codeBtn.classList.remove('is-copied'); }, 1500);
      });
      var deadline=bar.getAttribute('data-deadline');
      var timerEl=document.getElementById('campaign-bar-timer');
      if(!deadline || !timerEl) return;
      var end=new Date(deadline).getTime();
      function pad(n){ return String(n).padStart(2,'0'); }
      function tick(){
        var diff=end-Date.now();
        if(diff<=0){ bar.remove(); return; }
        var d=Math.floor(diff/86400000), h=Math.floor((diff%86400000)/3600000), m=Math.floor((diff%3600000)/60000), s=Math.floor((diff%60000)/1000);
        timerEl.textContent=(d>0 ? d+'g ' : '')+pad(h)+':'+pad(m)+':'+pad(s);
      }
      tick();
      setInterval(tick, 1000);
    })();</script>`;
}

// "%15" / "50.00 TL" — şerit ve pencere aynı kampanyayı aynı biçimde yazsın.
function promoAmount(campaign) {
  return campaign.discount_type === "percent"
    ? `%${Number(campaign.discount_value)}`
    : `${money(campaign.discount_value)} TL`;
}

/* Penceredeki ürün şeridi. Kampanya belirli ürünleri/kategorileri kapsıyorsa
   onları gösterir, kapsam tüm katalogsa vitrinin en yenilerini: müşteri kodu
   görüp "peki neye harcayacağım" diye düşünmeden ürüne geçebilsin.
   LIMIT sorguda: pencere her public sayfaya basıldığı için tüm katalog
   süslenmemeli, yalnızca gösterilecek birkaç satır. */
async function promoProducts(campaign, limit = 4) {
  let ids = null;
  if (campaign.scope === "products") {
    ids = (await campaignProductIds.all(campaign.id)).map((r) => r.product_id);
  } else if (campaign.scope === "categories") {
    const kategoriler = (await campaignCategoryIds.all(campaign.id)).map((r) => r.category_id);
    ids = kategoriler.length
      ? (await db.prepare(`
          SELECT DISTINCT product_id FROM product_categories
          WHERE category_id IN (${kategoriler.map(() => "?").join(",")})
        `).all(...kategoriler)).map((r) => r.product_id)
      : [];
  }
  /* Kapsam işaretli ama hiç ürün bağlanmamışsa şeridi boş bırakmak yerine vitrine
     düşüyoruz — ama o ürünler kampanyaya dahil DEĞİL, indirimli fiyat yazılamaz. */
  const kapsamDisi = Boolean(ids && !ids.length);
  const kapsam = ids && ids.length ? `AND id IN (${ids.map(() => "?").join(",")})` : "";
  const rows = await db.prepare(`
    SELECT * FROM products WHERE is_active = 1 ${kapsam}
    ORDER BY created_at DESC, id DESC
    LIMIT ${Number(limit)}
  `).all(...(ids && ids.length ? ids : []));
  return { urunler: (await decorateProducts(rows)).map(maliyetiGizle), kapsamDisi };
}

/* Ürün başına yazılabilecek indirim yüzdesi — yalnızca kesin olduğunda.
   Sabit tutarlı indirim sepetin TAMAMINDAN düşüyor (bkz. evaluateOne), yani iki
   adet alanda birim başına düşen tutar yarıya iner; adet/tutar koşullu kampanyada
   ise tek ürün alan müşteri o fiyatı hiç görmez. İkisinde de üstü çizili fiyat
   yalan olurdu, o yüzden 0 dönüp yalnızca normal fiyatı yazıyoruz. */
function promoUnitPercent(campaign) {
  if (campaign.kind === "gift") return 0;
  if (campaign.discount_type !== "percent") return 0;
  if (Number(campaign.min_quantity) > 1 || Number(campaign.min_order_total) > 0) return 0;
  return Number(campaign.discount_value) || 0;
}

/* Şeritteki mini ürün kartı. product-templates.js'teki productCardHTML'in
   KOPYASI DEĞİL: o kartın sepet düğmesi, rozetleri ve renk noktaları var ve
   tarayıcı onu yeniden basıyor. Bu yalnızca sunucuda üretilen bir küçük resim
   + fiyat bağlantısı; ortak olan fiyat/görsel yardımcıları şablon dosyasından
   çağrılıyor ki fiyat mantığı iki yerde ayrışmasın. */
function promoProductHTML(product, yuzde = 0) {
  const olcekler = sablonlar.productScales(product);
  const den = olcekler.length > 1 ? "'den" : "";
  const taban = sablonlar.displayPrice(product);
  /* Ödeme sayfasının hesabıyla BİREBİR aynı sırayla: önce indirim yuvarlanır,
     sonra düşülür (evaluateOne + /api/checkout böyle yapıyor). Doğrudan
     taban*0.85 yazmak fiyatların bir kısmında bir kuruş sapıyor ve pencerede
     yazan fiyat sepette tutmuyordu. */
  const indirimli = yuzde ? round2(taban - round2(taban * (yuzde / 100))) : 0;
  const fiyat = indirimli
    ? `${sablonlar.money(indirimli)}${den}<s>${sablonlar.money(taban)}</s>`
    : `${sablonlar.money(taban)}${den}`;
  return `
    <a class="promo-modal__product" href="/urun/${product.id}">
      <img src="${escapeHtml(sablonlar.gorselAdresi(product.image_path, 300) || "/assets/printable-logo.svg")}"
           alt="${escapeHtml(product.image_alt || product.name)}" loading="lazy">
      <span class="promo-modal__product-name">${escapeHtml(product.name)}</span>
      <span class="promo-modal__product-price">${fiyat}</span>
    </a>`;
}

/* Kampanya penceresi. Şeritten bağımsız işaretlenir (show_on_popup): şerit
   sürekli durur, pencere böler. Kapatma anı localStorage'a kampanya kimliğiyle
   yazılır ve popup_repeat_minutes kadar süre geçmeden yeniden açılmaz — boşsa
   hiç açılmaz, 0 ise her sayfa yüklemesinde açılır. Kimlik kampanyaya bağlı
   olduğu için yeni kampanya her ziyaretçiye sıfırdan görünür. */
async function renderPromoPopup() {
  const campaign = await livePromoCampaign("show_on_popup");
  if (!campaign) return "";
  const { name, code, deadline } = bannerPayload(campaign);
  const amount = promoAmount(campaign);
  const { urunler, kapsamDisi } = await promoProducts(campaign);
  const yuzde = kapsamDisi ? 0 : promoUnitPercent(campaign);
  const urunBasligi = campaign.scope === "all" || kapsamDisi
    ? "Öne çıkan ürünler"
    : "Kampanyaya dahil ürünler";
  return `
    <div class="promo-modal" id="promo-modal" data-campaign="${campaign.id}" data-deadline="${escapeHtml(deadline || "")}"
         data-repeat="${campaign.popup_repeat_minutes === null || campaign.popup_repeat_minutes === undefined ? "" : Number(campaign.popup_repeat_minutes)}" hidden>
      <div class="promo-modal__backdrop" data-promo-close></div>
      <div class="promo-modal__card" role="dialog" aria-modal="true" aria-labelledby="promo-modal-title">
        <button type="button" class="promo-modal__close" data-promo-close aria-label="Kampanya penceresini kapat">×</button>
        <span class="promo-modal__eyebrow">Kampanya</span>
        <p class="promo-modal__amount">${amount}<span>indirim</span></p>
        <h2 id="promo-modal-title">${escapeHtml(name)}</h2>
        <p class="promo-modal__lead">Kodu ödeme adımında girin, indirim sepetinize uygulansın.</p>
        <button type="button" class="promo-modal__code" id="promo-modal-code" data-code="${escapeHtml(code)}">
          Kod: <strong>${escapeHtml(code)}</strong>
        </button>
        ${deadline ? `<p class="promo-modal__timer">Kampanyanın bitmesine <strong id="promo-modal-timer"></strong></p>` : ""}
        ${urunler.length ? `
        <div class="promo-modal__picks">
          <span class="promo-modal__picks-title">${urunBasligi}${yuzde ? " · kod uygulanmış fiyat" : ""}</span>
          <!-- map'e doğrudan fonksiyon verilmez: ikinci argüman dizinin indeksi olur ve yüzde yerine geçer. -->
          <div class="promo-modal__products">${urunler.map((u) => promoProductHTML(u, yuzde)).join("")}</div>
        </div>` : ""}
        <a class="promo-modal__cta" href="/urunler">Alışverişe başla</a>
      </div>
    </div>
    <script>(function(){
      var modal=document.getElementById('promo-modal');
      if(!modal) return;
      var key='printable_promo_'+modal.getAttribute('data-campaign');
      /* Bekleme suresi dakika cinsinden: bos = bir daha acma, 0 = her yuklemede.
         Saklanan deger son kapatmanin zamani; eski surumden kalan '1' degeri de
         cok eski bir zaman damgasi gibi okunur ve pencere yeniden acilir. */
      var bekleme=parseInt(modal.getAttribute('data-repeat'), 10);
      try {
        var son=localStorage.getItem(key);
        if(son){
          if(isNaN(bekleme)) return;
          if(Date.now()-Number(son) < bekleme*60000) return;
        }
      } catch(e) {}

      function close(){
        modal.classList.remove('is-open');
        document.body.classList.remove('promo-modal-open');
        setTimeout(function(){ modal.hidden=true; }, 200);
        try { localStorage.setItem(key, String(Date.now())); } catch(e) {}
        document.removeEventListener('keydown', onKey);
      }
      function onKey(e){ if(e.key==='Escape') close(); }

      modal.querySelectorAll('[data-promo-close]').forEach(function(el){ el.addEventListener('click', close); });

      var codeBtn=document.getElementById('promo-modal-code');
      if(codeBtn) codeBtn.addEventListener('click', function(){
        if(navigator.clipboard) navigator.clipboard.writeText(codeBtn.getAttribute('data-code')).catch(function(){});
        codeBtn.classList.add('is-copied');
        setTimeout(function(){ codeBtn.classList.remove('is-copied'); }, 1500);
      });

      var deadline=modal.getAttribute('data-deadline');
      var timerEl=document.getElementById('promo-modal-timer');
      if(deadline && timerEl){
        var end=new Date(deadline).getTime();
        function pad(n){ return String(n).padStart(2,'0'); }
        function tick(){
          var diff=end-Date.now();
          if(diff<=0){ close(); return; }
          var d=Math.floor(diff/86400000), h=Math.floor((diff%86400000)/3600000), m=Math.floor((diff%3600000)/60000), s=Math.floor((diff%60000)/1000);
          timerEl.textContent=(d>0 ? d+' gün ' : '')+pad(h)+':'+pad(m)+':'+pad(s);
        }
        tick();
        setInterval(tick, 1000);
      }

      /* Sayfa daha açılırken değil, okumaya başladıktan sonra: hemen basılan
         pencere kapatılıp geçiliyor. */
      setTimeout(function(){
        modal.hidden=false;
        document.body.classList.add('promo-modal-open');
        requestAnimationFrame(function(){ modal.classList.add('is-open'); });
        document.addEventListener('keydown', onKey);
        var closeBtn=modal.querySelector('.promo-modal__close');
        if(closeBtn) closeBtn.focus();
      }, 1800);
    })();</script>`;
}

async function renderHeader(active, customer) {
  const link = (href, label, key) => `<a${active === key ? ' class="active"' : ""} href="${href}">${label}</a>`;
  /* Müşterinin adı çerezden zaten biliniyor; HTML'e burada basılır. Eskiden
     yalnızca script.js /api/customer/session dönüşünde yazıyordu, yani giriş
     yapmış kullanıcı HER sayfa açılışında önce "Hesabım" görüp sonra adının
     belirmesini izliyordu. Sunucu bilgiyi ilk baytta gönderebiliyorken bunu
     bir isteğin dönüşüne bırakmak gereksizdi. */
  /* Başlıkta yalnızca ilk ad. Üç kelimelik bir isim aksiyon sütununu 386'dan
     470px'e çıkarıyor ve `1fr auto 1fr` ızgarasında sol sütunu ezerek menüyü
     merkezden 99px sola kaydırıyordu. Tam ad zaten /hesap sayfasında. */
  const accountLabel = customer?.name?.trim().split(/\s+/)[0] || "Hesabım";
  const accountClass = `admin-link icon-button${customer ? " is-authenticated" : ""}`;
  const accountAria = customer ? `${customer.name} hesabı` : "Müşteri hesabım";
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
          <!-- 400px'lik sürüm: kaynak dosya 1550x550 ve 623 KB idi, başlıkta 33px
               yüksekliğinde gösteriliyordu. Her sayfada iki kez inen, sitedeki en
               ağır dosyaydı. width/height, yazı tipi yüklenirken satırın
               zıplamaması için duruyor. -->
          <picture>
            <source srcset="/assets/printable-logo-transparent-400.webp" type="image/webp">
            <img src="/assets/printable-logo-transparent-400.png" alt="Printable" width="400" height="142">
          </picture>
        </a>
        <!-- Yalnızca mobilde görünür; menüyü açar. -->
        <button class="nav-toggle" type="button" id="nav-toggle"
                aria-label="Menüyü aç" aria-expanded="false" aria-controls="main-links">
          <span></span><span></span><span></span>
        </button>
        <nav class="main-links" id="main-links" aria-label="Ana menü">
          ${await link("/", "Ana Sayfa", "home")}
          ${await link("/urunler", "Ürünler", "urunler")}
          ${BLOG_DISCOVERABLE ? await link("/blog", "Blog", "blog") : ""}
          ${await link("/tasarim", "Özel Tasarım", "tasarim")}
          ${await link("/hakkinda", "Hakkımızda", "hakkinda")}
          ${await link("/iletisim", "İletişim", "iletisim")}
          <!-- Aynı CTA'nın mobil kopyası: 1050px altında header-actions'ta
               hamburgere yer kalmıyor, buton açılır menünün içine geçiyor. -->
          <a class="nav-cta" href="/stl-teklif">Ücretsiz Teklif Al</a>
        </nav>
        <nav class="header-actions" aria-label="Mağaza işlemleri">
          <button class="search-toggle icon-button" type="button" aria-label="Arama aç" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.3-4.3m1.3-5.2a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"/></svg>
          </button>
          <a class="cart icon-button" href="#cart-panel" aria-label="Sepet">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 8h14l-1.4 7.2a2 2 0 0 1-2 1.6H9a2 2 0 0 1-2-1.7L5.8 4H3"/><path d="M9.5 20.5h.01M17.5 20.5h.01"/></svg>
            <strong id="cart-count">0</strong>
          </a>
          <a class="${accountClass}" href="/hesap" aria-label="${escapeHtml(accountAria)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
            <span class="account-link__label">${escapeHtml(accountLabel)}</span>
          </a>
          <a class="header-cta" href="/stl-teklif">Ücretsiz Teklif Al</a>
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

const CONTACT_CARD_ICONS = {
  phone: `<path d="M6.8 3h3l1.5 3.7-1.9 1.4a12 12 0 0 0 5.5 5.5l1.4-1.9L20 13.2v3a1.8 1.8 0 0 1-2 1.8A15.2 15.2 0 0 1 5 5a1.8 1.8 0 0 1 1.8-2Z"/>`,
  email: `<path d="M3.5 6.5h17v11h-17z"/><path d="m3.5 7 8.5 6 8.5-6"/>`,
  address: `<path d="M12 21s6.5-5.6 6.5-10.2A6.5 6.5 0 0 0 5.5 10.8C5.5 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.4"/>`,
  hours: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 2"/>`,
  social: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/>`
};

function contactCard({ title, icon, content, className = "", hint = "" }) {
  return `<div class="contact-item contact-card${className ? ` ${className}` : ""}">
    <span class="contact-card__icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icon}</svg></span>
    <div class="contact-card__body">
      <h3>${escapeHtml(title)}</h3>
      <p>${content}</p>
      ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
    </div>
  </div>`;
}

// İletişim bilgileri ilk HTML'e basılır. Böylece API yanıtını beklerken ziyaretçi
// yönetim paneline ait taslak metinleri görmez ve kartlar sonradan yer değiştirmez.
async function renderContactDetails() {
  const site = await db.prepare(`
    SELECT phone, email, whatsapp, social_links, legal_address, contact_address, working_hours
    FROM site_settings WHERE id = 1
  `).get() || {};
  const phone = String(site.phone || "").trim();
  const email = String(site.email || "").trim();
  const wa = whatsappDigits(String(site.whatsapp || "").trim() || phone);
  const address = String(site.legal_address || site.contact_address || "").trim();
  const workingHours = String(site.working_hours || "").trim();
  const accounts = socialAccounts(site.social_links).filter((account) => /^https?:\/\//i.test(account.url));
  const cards = [];

  if (wa) cards.push(contactCard({
    title: "WhatsApp",
    icon: SOCIAL_ICONS.whatsapp,
    content: `<a href="https://wa.me/${escapeHtml(wa)}" target="_blank" rel="noopener">WhatsApp'tan mesaj gönderin</a>`,
    className: "contact-card--wa",
    hint: "En hızlı yanıt burada"
  }));
  if (phone) cards.push(contactCard({
    title: "Telefon",
    icon: CONTACT_CARD_ICONS.phone,
    content: `<a href="tel:${escapeHtml(phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(phone)}</a>`
  }));
  if (email) cards.push(contactCard({
    title: "E-posta",
    icon: CONTACT_CARD_ICONS.email,
    content: `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
  }));
  if (address) cards.push(contactCard({
    title: "Adres",
    icon: CONTACT_CARD_ICONS.address,
    content: escapeHtml(address)
  }));
  if (workingHours) cards.push(contactCard({
    title: "Çalışma saatleri",
    icon: CONTACT_CARD_ICONS.hours,
    content: escapeHtml(workingHours)
  }));
  if (accounts.length) cards.push(contactCard({
    title: "Sosyal medya",
    icon: CONTACT_CARD_ICONS.social,
    className: "contact-card--social",
    content: accounts.map((account) =>
      `<a href="${escapeHtml(account.url)}" target="_blank" rel="noopener">${escapeHtml(account.label)}</a>`
    ).join("")
  }));

  return cards.join("\n");
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
        <div><h3>Kurumsal</h3><a href="/katalog">Katalog</a><a href="/hakkinda">Hakkımızda</a><a href="/iletisim">İletişim</a><a href="/stl-teklif">Özel 3D baskı</a><a href="/tasarim">Özel tasarım</a><a href="/urunler">Tüm ürünler</a></div>
        <div><h3>Müşteri Desteği</h3><a href="/iletisim">Bize ulaşın</a><a href="/iade">İade & Değişim</a><a href="/sss">Kargo</a><a href="/sss">S.S.S.</a></div>
        <div><h3>Yasal</h3><a href="/mesafeli-satis">Mesafeli Satış Sözleşmesi</a><a href="/iade">İade ve Cayma Hakkı</a><a href="/gizlilik">Gizlilik ve KVKK</a></div>
        <div class="footer-logo printable-wordmark">
          <a class="footer-brand-logo" href="/" aria-label="Printable ana sayfa">
            <picture>
              <source srcset="/assets/printable-logo-transparent-400.webp" type="image/webp">
              <img src="/assets/printable-logo-transparent-400.png" alt="Printable" width="400" height="142">
            </picture>
          </a>
          <p>Hazır 3D modellerden özenle üretilen baskı ürünleri.</p>
          <p>Türkiye</p>
          <a class="footer-cta" href="/stl-teklif">Ücretsiz Teklif Al</a>
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

async function injectShell(html, headActive, customer) {
  return html
    /* Ürün şablonları script.js'ten ÖNCE yüklenmeli — script.js oradaki
       isimleri (money, productCardHTML…) kullanıyor. Her sayfanın HTML'ine tek
       tek yazmak yerine buradan enjekte ediliyor: yeni bir sayfa eklendiğinde
       unutulacak bir adım kalmasın. */
    .replace(/<script src="\/?script\.js"><\/script>/,
      '<script src="/product-templates.js"></script>\n    <script src="/script.js"></script>')
    .replace("</head>", `${googleAnalyticsTag}\n  </head>`)
    .replace("<!--header-->", `${await renderPromoBar()}${await renderHeader(headActive, customer)}${await renderPromoPopup()}`)
    .replace("<!--cart-->", renderCartPanel())
    .replace("<!--footer-->", await renderFooter())
    .replace("<!--chat-->", await renderChatButton());
}

/* Satıcı kimliği yasal sayfalarda TEK yerden gelir: /admin → Ayarlar. Metni
   HTML'e gömmek, satıcı adı ya da adres değiştiğinde üç sayfayı birden
   güncellemeyi unutmak demekti. PayTR'nin site kontrolünde aradığı temel
   kimlik alanları satıcı adı, açık adres, telefon ve e-postadır. Ziyaretçiye
   bunların dışında bir satıcı alanı gösterilmez. */
async function renderSellerBlock() {
  const s = await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
  const zorunlu = new Set(["Satıcı", "Adres", "Telefon", "E-posta"]);
  const goster = [
    ["Satıcı", s.company_title],
    ["Adres", s.legal_address],
    ["Telefon", s.phone],
    ["E-posta", s.email]
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
  const s = await db.prepare("SELECT legal_address, company_title FROM site_settings WHERE id = 1").get() || {};
  const adres = s.legal_address?.trim();
  if (!adres) {
    return '<p class="legal-warning legal-warning--admin"><strong>İade adresi belirtilmemiş.</strong> Yönetim panelindeki <em>Ayarlar</em> bölümünden ekleyin.</p>';
  }
  return `<p class="legal-address">${s.company_title?.trim() ? `<strong>${escapeHtml(s.company_title)}</strong><br>` : ""}${escapeHtml(adres).replace(/\n/g, "<br>")}</p>`;
}

const guncellemeSatiri = () =>
  `Son güncelleme: ${new Date().toLocaleDateString("tr-TR", { year: "numeric", month: "long", day: "numeric" })}`;

/* S.S.S. sayfasının FAQPage şeması. Soru-cevaplar sayfanın kendi HTML'inden
   okunur; ikinci bir listeyi server.js'te tutmak, biri güncellenip diğeri
   unutulduğunda arama sonucunda yanlış cevap göstermek demekti. Google
   FAQPage için soru ve cevabın sayfada görünür olmasını şart koşuyor —
   tek kaynak zaten bu yüzden doğru olan. */
function faqPageSchema(html) {
  const sorular = [...html.matchAll(
    /<details class="faq-item">\s*<summary>([\s\S]*?)<\/summary>\s*<div class="faq-answer">([\s\S]*?)<\/div>\s*<\/details>/g
  )].map(([, soru, cevap]) => ({
    "@type": "Question",
    name: metinAl(soru),
    acceptedAnswer: { "@type": "Answer", text: metinAl(cevap) }
  })).filter((q) => q.name && q.acceptedAnswer.text);

  if (!sorular.length) return "";
  const jsonLd = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: sorular };
  return `\n    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`;
}

// Etiketleri atıp düz metne indirger; &amp; gibi girişleri de geri çevirir.
const metinAl = (parca) => parca
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, " ")
  .trim();

/* /urunler kataloğunun ilk HTML'i. Sıralama urunler.js'in filtresiz
   varsayılanıyla (en yeni önce) aynı olmalı, yoksa JS yüklenince kartlar yer
   değiştirir. Kart işaretlemesi product-templates.js'ten geliyor — tarayıcı da
   aynı fonksiyonu çağırıyor. */
async function renderProductGrid(query) {
  const products = await db.prepare(
    "SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC, id DESC"
  ).all();
  let suslu = (await decorateProducts(products)).map(maliyetiGizle);

  /* Ana sayfadaki kategori kartları ve ürün sayfasındaki etiketler buraya
     ?kategori=<id> ile geliyor; ?indirim=1 ve ?q= de var. Sunucu bunları
     uygulamazsa ziyaretçi önce 47 ürünü görüp sonra listenin 17'ye düşmesini
     izliyor — filtreyi JS'e bırakmak tam da kaldırmak istediğimiz sıçramayı
     geri getirir. Süzme mantığı urunler.js'teki `matches` ile aynı. */
  const kategori = Number(query.kategori);
  if (kategori) {
    suslu = suslu.filter((p) => (p.categories || []).some((c) => c.id === kategori));
  }
  if (query.indirim === "1") {
    // Ölçekli üründe sale_price uygulanmıyor, o yüzden indirimli sayılmıyor.
    suslu = suslu.filter((p) => !(p.scales || []).length && p.sale_price && p.price > p.sale_price);
  }
  const arama = String(query.q || "").trim().toLocaleLowerCase("tr-TR").slice(0, 80);
  if (arama) {
    suslu = suslu.filter((p) =>
      `${p.name || ""} ${p.description || ""} ${(p.categories || []).map((c) => c.name).join(" ")}`
        .toLocaleLowerCase("tr-TR").includes(arama));
  }

  return suslu.map(sablonlar.productCardHTML).join("")
    || `<p class="products-empty">Ürün bulunamadı.</p>`;
}

/* Banner. İşaretleme script.js'teki applyHeroSlides / renderHeroCopy ile birebir
   aynı olmalı: JS aynı görselleri yeniden basınca hiçbir şey değişmesin.
   Boş bırakılırsa .hero__copy'nin h1/span/buton iskeleti hiç oluşmaz ve
   renderHeroCopy null'a yazmaya çalışır — bu yüzden slayt yoksa bile iskelet
   basılıyor. */
async function renderHero(sayfa) {
  const slaytlar = await db.prepare(
    "SELECT image_path, image_alt, title, subtitle, primary_label, primary_href, secondary_label, secondary_href FROM hero_slides WHERE is_active = 1 ORDER BY sort_order, id"
  ).all();

  const gorseller = slaytlar.map((s, i) => {
    const alt = s.image_alt || s.title || "Printable banner görseli";
    const oncelik = i === 0 ? ' fetchpriority="high"' : ' loading="lazy"';
    // Banner tam genişlikte; 1600px 2172px'lik orijinali gereksiz kılıyor.
    return `<img class="hero__slide${i === 0 ? " is-active" : ""}" src="${escapeHtml(sablonlar.gorselAdresi(s.image_path, 1600))}" alt="${escapeHtml(alt)}"${oncelik}>`;
  }).join("\n              ");

  const ilk = slaytlar[0] || {};
  const buton = (sinif, etiket, adres) =>
    `<a class="btn ${sinif}" href="${escapeHtml(adres || "#")}"${etiket ? "" : " hidden"}><span>${escapeHtml(etiket || "")}</span></a>`;
  const metin = `
              <h1>${escapeHtml(ilk.title || "")}</h1>
              <span>${escapeHtml(ilk.subtitle || "")}</span>
              <div class="hero-actions">
                ${buton("btn--light", ilk.primary_label, ilk.primary_href)}
                ${buton("btn--ghost", ilk.secondary_label, ilk.secondary_href)}
              </div>`;

  return sayfa
    .replace("<!--hero-slaytlari-->", gorseller)
    .replace("<!--hero-metni-->", metin);
}

/* Ana sayfa vitrinleri. Seçim mantığı script.js'teki ile BİREBİR aynı olmalı —
   JS aynı kutuları yeniden bastığında kartlar yer değiştirmesin. Eskiden ana
   sayfanın 1602 kelimesinin 1000'i yalnızca JS ile geliyordu; tarayıcı için
   sayfa üçte bir boyutundaydı. */
async function renderHomeGrids(sayfa) {
  const products = await db.prepare(
    "SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC, id DESC"
  ).all();
  const aktif = (await decorateProducts(products)).map(maliyetiGizle);
  const izgara = (liste) => liste.map(sablonlar.productCardHTML).join("")
    || `<p class="products-empty">Ürün bulunamadı.</p>`;

  // En pahalı ürün panelde; sonraki dördü 2x2 ızgarada (script.js: featured).
  const secki = [...aktif].sort((a, b) => (b.sale_price || b.price) - (a.sale_price || a.price));
  const indirimli = aktif.filter((p) => p.sale_price && p.price > p.sale_price)
    .sort((a, b) => sablonlar.discountPercent(b) - sablonlar.discountPercent(a));

  /* İndirim bölümü boşken gizli kalmalı; ürün varsa hidden'ı sunucu kaldırır ki
     bölüm ilk HTML'de açık gelsin ve JS onu açarken sayfa kaymasın. */
  const enIyi = indirimli.length ? sablonlar.discountPercent(indirimli[0]) : 0;
  const ozet = indirimli.length
    ? `${indirimli.length} ürün indirimde · en yüksek indirim %${enIyi} · stoklarla sınırlı`
    : "";

  return sayfa
    .replace("<!--vitrin-yeni-->", izgara(aktif))
    .replace("<!--vitrin-secki-->", izgara(secki.slice(1, 5)))
    .replace("<!--vitrin-cok-satan-->", izgara(aktif.slice(0, 5)))
    .replace("<!--vitrin-onerilen-->", izgara([...aktif].reverse().slice(0, 4)))
    .replace("<!--vitrin-indirim-->", indirimli.length ? izgara(indirimli.slice(0, 5)) : "")
    .replace("<!--indirim-gizli-->", indirimli.length ? "" : " hidden")
    .replace("<!--indirim-ozet-->", escapeHtml(ozet));
}

/* /landing vitrini. Seçim script.js'teki renderProductLanding ile aynı: sabit
   id listesi, eksik kalırsa katalog sırasından tamamlanır. */
async function renderLandingStage() {
  const products = await db.prepare(
    "SELECT * FROM products WHERE is_active = 1 ORDER BY created_at DESC, id DESC"
  ).all();
  const suslu = (await decorateProducts(products)).map(maliyetiGizle);
  return sablonlar.preferredProductList(suslu, [21, 53, 22, 39, 35], 5)
    .map(sablonlar.commerceStageCardHTML).join("");
}

/* /urunler filtre seçenekleri. İşaretleme urunler.js'teki renderCategoryFilters
   / renderColorFilters ile BİREBİR aynı olmalı: JS aynı kutuyu yeniden
   bastığında yükseklik değişmezse sayfa hiç kaymaz. Yan fayda, kategori ve renk
   adlarının JS'siz HTML'de de bulunması. */
async function renderProductFilters(sayfa, query) {
  const categories = await db.prepare(
    "SELECT id, name FROM categories WHERE is_active = 1 ORDER BY sort_order, id"
  ).all();
  const colors = await db.prepare(
    "SELECT id, name, hex FROM colors WHERE is_active = 1 ORDER BY sort_order, id"
  ).all();

  const seciliKategori = Number(query.kategori) || null;
  const indirimli = query.indirim === "1";
  const arama = String(query.q || "").trim().toLocaleLowerCase("tr-TR").slice(0, 80);

  /* Aktif filtre etiketleri de sunucudan. Kutu boş+hidden başlayıp JS onu
     doldurunca 32px büyüyor ve ürün ızgarasını aşağı itiyordu — kategori
     bağlantısıyla gelen her ziyaretçide görülen bir kayma. İşaretleme
     urunler.js'teki renderActiveChips ile aynı. */
  const etiketler = [];
  const kategoriAdi = categories.find((c) => c.id === seciliKategori);
  if (kategoriAdi) etiketler.push(`<button type="button" class="chip" data-remove-category="${kategoriAdi.id}">${escapeHtml(kategoriAdi.name)} ✕</button>`);
  if (indirimli) etiketler.push(`<button type="button" class="chip" data-remove-sale>İndirimli ✕</button>`);
  if (arama) etiketler.push(`<button type="button" class="chip" data-remove-query>Arama: ${escapeHtml(arama)} ✕</button>`);
  sayfa = sayfa.replace(
    '<!--aktif-filtreler--><div id="active-filters" class="active-filters" hidden></div>',
    `<div id="active-filters" class="active-filters"${etiketler.length ? "" : " hidden"}>${etiketler.join("")}</div>`
  );

  const kategoriler = categories.map((category) => `
      <label class="filter-check">
        <input type="checkbox" data-filter="category" value="${category.id}"${category.id === seciliKategori ? " checked" : ""}>
        ${escapeHtml(category.name)}
      </label>
    `).join("") || "<p class='filter-empty'>Kategori yok.</p>";

  const renkler = colors.map((color) => `
      <label class="filter-check filter-check--color">
        <input type="checkbox" data-filter="color" value="${color.id}">
        <span class="color-dot" style="background:${escapeHtml(color.hex)}"></span>${escapeHtml(color.name)}
      </label>
    `).join("") || "<p class='filter-empty'>Renk yok.</p>";

  return sayfa
    .replace("<!--filtre-kategoriler-->", kategoriler)
    .replace("<!--filtre-renkler-->", renkler);
}

async function sendPage(req, res, file, slug) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  /* FAQPage şeması, sayfada .faq-item varsa basılır — slug listesi tutmak,
     yeni bir S.S.S. bölümü eklendiğinde unutulacak bir adım demekti. */
  let sayfa = html.replace("<!--seo-->", (await seoHead(req, slug)) + faqPageSchema(html));
  // Yasal sayfa yer tutucuları — diğer sayfalarda bunlar zaten yok, replace no-op.
  if (sayfa.includes("<!--satici-->")) sayfa = sayfa.replaceAll("<!--satici-->", await renderSellerBlock());
  if (sayfa.includes("<!--iade-adresi-->")) sayfa = sayfa.replace("<!--iade-adresi-->", await renderReturnAddress());
  if (sayfa.includes("<!--guncelleme-->")) sayfa = sayfa.replace("<!--guncelleme-->", guncellemeSatiri());
  if (sayfa.includes("<!--contact-details-->")) sayfa = sayfa.replace("<!--contact-details-->", await renderContactDetails());
  if (sayfa.includes("<!--filtre-kategoriler-->")) sayfa = await renderProductFilters(sayfa, req.query);
  if (sayfa.includes("<!--urun-izgarasi-->")) sayfa = sayfa.replace("<!--urun-izgarasi-->", await renderProductGrid(req.query));
  if (sayfa.includes("<!--landing-vitrin-->")) sayfa = sayfa.replace("<!--landing-vitrin-->", await renderLandingStage());
  if (sayfa.includes("<!--hero-slaytlari-->")) sayfa = await renderHero(sayfa);
  if (sayfa.includes("<!--vitrin-yeni-->")) sayfa = await renderHomeGrids(sayfa);
  res.type("html").send(await injectShell(sayfa, slug, await pageCustomer(req, res)));
}

/* Sayfa HTML'i artık müşterinin adını taşıyor, yani kişisel. Paylaşımlı bir
   önbelleğe düşerse bir ziyaretçiye başkasının adı gösterilir. Bugün sayfalara
   hiç Cache-Control verilmiyor (Vercel de fonksiyon çıktısını kendiliğinden
   önbelleğe almıyor), ama bu güvenlik araya bir CDN girdiği gün sessizce
   kaybolurdu. Yalnızca oturum varken işaretlenir; anonim sayfa eskisi gibi. */
async function pageCustomer(req, res) {
  const customer = await currentCustomer(req);
  if (customer) res.setHeader("Cache-Control", "private, no-store");
  return customer;
}

app.get("/", async (req, res) => await sendPage(req, res, "index.html", "home"));
app.get("/landing", async (req, res) => await sendPage(req, res, "landing.html", "landing"));
app.get("/katlac-spinball", async (req, res) => res.redirect(301, "/landing"));
app.get("/urunler", async (req, res) => await sendPage(req, res, "urunler.html", "urunler"));
app.get("/stl-teklif", async (req, res) => await sendPage(req, res, "stl-teklif.html", "stl-teklif"));
app.get("/tasarim", async (req, res) => await sendPage(req, res, "tasarim.html", "tasarim"));
app.get("/hakkinda", async (req, res) => await sendPage(req, res, "hakkinda.html", "hakkinda"));
app.get("/iletisim", async (req, res) => await sendPage(req, res, "iletisim.html", "iletisim"));
app.get("/hesap", async (req, res) => await sendPage(req, res, "hesap.html", "hesap"));
app.get("/sss", async (req, res) => await sendPage(req, res, "sss.html", "sss"));
app.get("/mesafeli-satis", async (req, res) => await sendPage(req, res, "mesafeli-satis.html", "mesafeli-satis"));
app.get("/iade", async (req, res) => await sendPage(req, res, "iade.html", "iade"));
app.get("/gizlilik", async (req, res) => await sendPage(req, res, "gizlilik.html", "gizlilik"));
app.get("/katalog", async (req, res) => await sendPage(req, res, "katalog.html", "katalog"));
app.get("/anahtarlik-katalogu", async (req, res) => await sendPage(req, res, "anahtarlik-katalogu.html", "anahtarlik-katalogu"));

// Per-product SEO: crawlers need real title/description/og:image/JSON-LD in the HTML
// (the visible detail is filled by urun.js, matching the rest of the JS-rendered site).
async function productMetaTags(req, product) {
  const site = await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
  const title = product.meta_title || `${product.name} | Printable`;
  const description = product.meta_description || product.description || site.description || "";
  const canonical = absoluteUrl(req, `/urun/${product.id}`, site.site_url);
  const image = absoluteUrl(req, product.image_path || site.default_og_image, site.site_url);
  /* Vitrin şu an tek boy sattığı için (bkz. satisOlcekleri) burası tek fiyatlı
     Offer basıyor. Aşağıdaki AggregateOffer dalı, boylar ayrı fiyatlarla
     satılmaya başlanınca devreye girer: o zaman ürünün tek bir fiyatı olmaz ve
     arama sonucunda "120–260 TL" aralığı göstermek tek fiyat yazıp müşteriyi
     yanıltmaktan doğrudur. */
  const olcekler = satisOlcekleri(await db.prepare(
    "SELECT id, scale, price, unit_cost FROM product_cost_scales WHERE product_id = ? ORDER BY unit_cost ASC, id ASC"
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
  const decorated = maliyetiGizle(await withColors(product));
  /* Detay da ilk HTML'de. Ölçek/renk seçimi varsayılanla basılıyor — urun.js de
     aynı varsayılanlarla açılıyor, dolayısıyla JS devraldığında işaretleme
     değişmiyor. stokGoster istemcide /api/site-info'dan geliyor; burada aynı
     değeri vermezsek stok satırı sonradan belirip sayfayı kaydırırdı. */
  const ayar = await db.prepare("SELECT show_stock FROM site_settings WHERE id = 1").get() || {};
  const detay = sablonlar.productDetailHTML(decorated, {
    stokGoster: Number(ayar.show_stock ?? 1) === 1
  });
  res.type("html").send(await injectShell(
    html
      .replace("<!--seo-->", await productMetaTags(req, decorated))
      .replace("<!--urun-detayi-->", detay),
    "urunler", await pageCustomer(req, res)
  ));
});

// Checkout flow — noindex (a transactional page crawlers should not list).
app.get("/odeme", async (req, res) => {
  const site = await db.prepare("SELECT site_name FROM site_settings WHERE id = 1").get() || {};
  const head = [
    `<title>Ödeme | ${escapeHtml(site.site_name || "Printable")}</title>`,
    `<meta name="robots" content="noindex,nofollow">`
  ].join("\n    ");
  const html = fs.readFileSync(path.join(ROOT, "odeme.html"), "utf8");
  res.type("html").send(await injectShell(html.replace("<!--seo-->", head), "", await pageCustomer(req, res)));
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
    { loc: "/landing", priority: "0.9" },
    { loc: "/urunler", priority: "0.9" },
    ...(BLOG_DISCOVERABLE ? [{ loc: "/blog", priority: "0.8" }] : []),
    { loc: "/stl-teklif", priority: "0.8" },
    { loc: "/tasarim", priority: "0.7" },
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
  if (BLOG_DISCOVERABLE) {
    await publishDueBlogPosts();
    const publishedPosts = await db.prepare("SELECT slug, status, published_at, updated_at FROM blog_posts WHERE status = 'published' ORDER BY id").all();
    publishedPosts.filter(blogIsPublic).forEach((post) => urls.push({
      loc: `/blog/${post.slug}`,
      priority: "0.7",
      lastmod: String(post.updated_at instanceof Date ? post.updated_at.toISOString() : post.updated_at || "").slice(0, 10)
    }));
  }

  const body = urls.map((u) => {
    const loc = escapeHtml(absoluteUrl(req, u.loc, site.site_url));
    return `  <url>\n    <loc>${loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}\n    <priority>${u.priority}</priority>\n  </url>`;
  }).join("\n");

  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
  );
});

const blogIsPublic = (post) => post.status === "published"
  && (!post.published_at || new Date(post.published_at).getTime() <= Date.now());

function formatBlogDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("tr-TR", {
    day: "numeric", month: "long", year: "numeric"
  }).format(date);
}

function blogCardHTML(post) {
  const cover = post.cover_image
    ? `<img src="${escapeHtml(post.cover_image)}" alt="${escapeHtml(post.cover_alt || post.title)}" loading="lazy">`
    : `<div class="blog-card__placeholder" aria-hidden="true">Printable</div>`;
  return `<article class="blog-card">
    <a class="blog-card__image" href="/blog/${encodeURIComponent(post.slug)}">${cover}</a>
    <div class="blog-card__body">
      <p class="blog-card__meta">${escapeHtml(formatBlogDate(post.published_at || post.created_at))}${post.author_name ? ` · ${escapeHtml(post.author_name)}` : ""}</p>
      <h2><a href="/blog/${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h2>
      ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ""}
      <a class="blog-card__more" href="/blog/${encodeURIComponent(post.slug)}">Yazıyı oku <span aria-hidden="true">→</span></a>
    </div>
  </article>`;
}

function blogMediaHTML(post) {
  if (!post.media_url || post.media_type === "none") return "";
  if (post.media_type === "video") return `<video class="blog-post__media" controls preload="metadata" src="${escapeHtml(post.media_url)}"></video>`;
  if (post.media_type === "embed" && /^https:\/\/(www\.)?(youtube\.com|youtu\.be|player\.vimeo\.com)\//i.test(post.media_url)) {
    return `<div class="blog-post__embed"><iframe src="${escapeHtml(post.media_url)}" title="${escapeHtml(post.title)} videosu" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>`;
  }
  return `<img class="blog-post__media" src="${escapeHtml(post.media_url)}" alt="${escapeHtml(post.title)}">`;
}

async function blogMetaTags(req, post) {
  const site = await db.prepare("SELECT * FROM site_settings WHERE id = 1").get() || {};
  const canonical = absoluteUrl(req, post.canonical || `/blog/${post.slug}`, site.site_url);
  const image = absoluteUrl(req, post.og_image || post.cover_image || site.default_og_image, site.site_url);
  const title = post.meta_title || `${post.title} | ${site.site_name || "Printable"}`;
  const description = post.meta_description || post.excerpt || "";
  const datePublished = post.published_at || post.created_at;
  const tags = [
    `<title>${escapeHtml(title)}</title>`, FAVICON_TAGS,
    description && `<meta name="description" content="${escapeHtml(description)}">`,
    post.meta_keywords && `<meta name="keywords" content="${escapeHtml(post.meta_keywords)}">`,
    `<meta name="robots" content="${BLOG_DISCOVERABLE ? escapeHtml(post.robots || "index,follow") : "noindex,follow"}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:locale" content="tr_TR">`,
    `<meta property="og:title" content="${escapeHtml(post.og_title || title)}">`,
    description && `<meta property="og:description" content="${escapeHtml(post.og_description || description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    image && `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="article:published_time" content="${escapeHtml(new Date(datePublished).toISOString())}">`,
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`
  ].filter(Boolean);
  const article = {
    "@context": "https://schema.org", "@type": "BlogPosting", headline: post.title,
    ...(description ? { description } : {}), ...(image ? { image } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    datePublished: new Date(datePublished).toISOString(), dateModified: new Date(post.updated_at || datePublished).toISOString(),
    author: { "@type": "Person", name: post.author_name || site.site_name || "Printable" },
    publisher: { "@type": "Organization", name: site.site_name || "Printable" }
  };
  tags.push(`<script type="application/ld+json">${JSON.stringify(article).replace(/</g, "\\u003c")}</script>`);
  return tags.join("\n    ");
}

app.get("/blog", async (req, res) => {
  const posts = (await db.prepare("SELECT * FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC NULLS LAST, id DESC").all())
    .filter(blogIsPublic);
  const html = fs.readFileSync(path.join(ROOT, "blog.html"), "utf8");
  const blogHead = (await seoHead(req, "blog")).replace(/<meta name="robots" content="[^"]*">/, `<meta name="robots" content="${BLOG_DISCOVERABLE ? "index,follow" : "noindex,follow"}">`);
  res.type("html").send(await injectShell(html
    .replace("<!--seo-->", blogHead)
    .replace("<!--blog-list-->", posts.map(blogCardHTML).join("") || '<p class="blog-empty">Yeni yazılar çok yakında burada olacak.</p>'), "blog", await pageCustomer(req, res)));
});

app.get("/blog/:slug", async (req, res) => {
  const post = await db.prepare("SELECT * FROM blog_posts WHERE slug = ?").get(req.params.slug);
  if (!post || !blogIsPublic(post)) return res.status(404).redirect("/blog");
  const html = fs.readFileSync(path.join(ROOT, "blog-yazi.html"), "utf8");
  const cover = post.cover_image ? `<img class="blog-post__cover" src="${escapeHtml(post.cover_image)}" alt="${escapeHtml(post.cover_alt || post.title)}">` : "";
  res.type("html").send(await injectShell(html
    .replace("<!--seo-->", await blogMetaTags(req, post))
    .replace("<!--blog-title-->", escapeHtml(post.title))
    .replace("<!--blog-meta-->", `${escapeHtml(formatBlogDate(post.published_at || post.created_at))}${post.author_name ? ` · ${escapeHtml(post.author_name)}` : ""}`)
    .replace("<!--blog-cover-->", cover)
    .replace("<!--blog-media-->", blogMediaHTML(post))
    .replace("<!--blog-content-->", post.content || ""), "blog", await pageCustomer(req, res)));
});

["styles.css", "script.js", "product-templates.js", "stl-viewer.js", "admin.css", "admin.js", "urunler.js", "urun.js", "odeme.js", "iletisim.js", "katalog.js", "hesap.js", "anahtarlik-katalog.js"].forEach((file) => {
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
  const firstName = String(req.body.first_name || "").trim().replace(/\s+/g, " ");
  const lastName = String(req.body.last_name || "").trim().replace(/\s+/g, " ");
  const name = `${firstName} ${lastName}`.trim();
  const email = normalizeCustomerEmail(req.body.email);
  const phone = String(req.body.phone || "").trim();
  const password = String(req.body.password || "");
  if (firstName.length < 2 || lastName.length < 2) {
    return res.status(400).json({ error: "Ad ve soyad en az 2 karakter olmalı." });
  }
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
  const ownerNotified = await notifyNewCustomerAccount({ name, email, phone }).catch(() => false);
  if (STORE_NOTIFICATION_EMAILS.length && !ownerNotified) console.error(`Yeni üyelik bildirimi gönderilemedi: ${email}`);
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
    SELECT o.id, o.order_number, o.status, o.payment_status, o.subtotal, o.discount,
           o.tax_rate, o.tax_amount, o.total, o.tracking_code, o.shipping_address,
           o.shipping_method, o.payment_method, o.campaign_summary, o.created_at, o.updated_at
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE LOWER(c.email) = ?
    ORDER BY o.created_at DESC
    LIMIT 100
  `).all(req.customer.email);
  if (!orders.length) return res.json([]);
  const items = await db.prepare(`
    SELECT oi.order_id, oi.product_id, oi.product_name, oi.scale, oi.quantity, oi.unit_price, oi.line_total,
           p.image_path AS product_image
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE LOWER(c.email) = ?
    ORDER BY o.created_at DESC, oi.id ASC
  `).all(req.customer.email);
  const itemsByOrder = new Map();
  for (const item of items) {
    const current = itemsByOrder.get(item.order_id) || [];
    current.push(item);
    itemsByOrder.set(item.order_id, current);
  }
  res.json(orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) || [] })));
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

const emailMoney = (value) => `${Number(value || 0).toFixed(2)} TL`;

async function sendTransactionalEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || "Printable <info@printable.com.tr>";
  if (!apiKey) return false;
  const recipients = (Array.isArray(to) ? to : [to]).map((email) => String(email).trim()).filter(Boolean);
  if (!recipients.length) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: recipients, subject, html }),
      signal: controller.signal
    });
    return response.ok;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  return sendTransactionalEmail({
    to,
    subject: "Printable şifre yenileme",
    html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6">
        <h2>Şifrenizi yenileyin</h2>
        <p>Merhaba ${escapeHtml(name)},</p>
        <p>Printable hesabınız için şifre yenileme bağlantısı istendi.</p>
        <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#ff6542;color:#fff;text-decoration:none;font-weight:700">Yeni şifre oluştur</a></p>
        <p>Bu bağlantı 30 dakika geçerlidir. İsteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>
      </div>`
  });
}

async function sendOrderReceivedEmail({ to, name, orderNumber, items, total }) {
  const lines = items.map((item) => `<li style="padding:7px 0;border-bottom:1px solid #eee"><strong>${escapeHtml(item.product_name)}</strong> · ${Number(item.quantity)} adet · ${emailMoney(item.line_total)}</li>`).join("");
  return sendTransactionalEmail({
    to,
    subject: `Siparişiniz alındı · ${orderNumber}`,
    html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6;max-width:600px">
      <h2>Siparişinizi aldık 🎉</h2>
      <p>Merhaba ${escapeHtml(name)},</p>
      <p><strong>${escapeHtml(orderNumber)}</strong> numaralı siparişiniz üretim sırasına alındı.</p>
      <ul style="padding-left:18px">${lines}</ul>
      <p style="font-size:18px"><strong>Toplam: ${emailMoney(total)}</strong></p>
      <p>Ürününüz kargoya verildiğinde takip bilgilerini ayrıca paylaşacağız.</p>
      <p><a href="https://printable.com.tr/hesap" style="color:#ff6542;font-weight:700">Siparişlerimi görüntüle</a></p>
    </div>`
  });
}

async function sendShippingUpdateEmail({ to, name, orderNumber, trackingCode }) {
  return sendTransactionalEmail({
    to,
    subject: `Siparişiniz kargoda · ${orderNumber}`,
    html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6;max-width:600px">
      <h2>Siparişiniz kargoya verildi</h2>
      <p>Merhaba ${escapeHtml(name)},</p>
      <p><strong>${escapeHtml(orderNumber)}</strong> numaralı siparişiniz yola çıktı.</p>
      ${trackingCode ? `<p><strong>Kargo takip kodu:</strong> ${escapeHtml(trackingCode)}</p>` : ""}
      <p><a href="https://printable.com.tr/hesap" style="color:#ff6542;font-weight:700">Sipariş detayını görüntüle</a></p>
    </div>`
  });
}

async function sendStoreNotification({ subject, html }) {
  if (!STORE_NOTIFICATION_EMAILS.length) return false;
  return sendTransactionalEmail({ to: STORE_NOTIFICATION_EMAILS, subject, html });
}

async function notifyNewCustomerAccount({ name, email, phone }) {
  return sendStoreNotification({
    subject: "Yeni Printable üyeliği",
    html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6">
      <h2>Yeni üye kaydı</h2>
      <p><strong>Ad soyad:</strong> ${escapeHtml(name)}</p>
      <p><strong>E-posta:</strong> ${escapeHtml(email)}</p>
      ${phone ? `<p><strong>Telefon:</strong> ${escapeHtml(phone)}</p>` : ""}
      <p><a href="https://printable.com.tr/admin" style="color:#ff6542;font-weight:700">Yönetim panelini aç</a></p>
    </div>`
  });
}

async function notifyNewOrder({ name, email, phone, orderNumber, items, total }) {
  const lines = items.map((item) => `<li>${escapeHtml(item.product_name)} · ${Number(item.quantity)} adet · ${emailMoney(item.line_total)}</li>`).join("");
  return sendStoreNotification({
    subject: `Yeni sipariş · ${orderNumber}`,
    html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6">
      <h2>Yeni sipariş geldi 🎉</h2>
      <p><strong>Sipariş:</strong> ${escapeHtml(orderNumber)}</p>
      <p><strong>Müşteri:</strong> ${escapeHtml(name)}<br><strong>E-posta:</strong> ${escapeHtml(email || "Belirtilmedi")}<br><strong>Telefon:</strong> ${escapeHtml(phone || "Belirtilmedi")}</p>
      <ul>${lines}</ul>
      <p><strong>Toplam: ${emailMoney(total)}</strong></p>
      <p><a href="https://printable.com.tr/admin" style="color:#ff6542;font-weight:700">Siparişi panelde aç</a></p>
    </div>`
  });
}

async function notifyNewQuote({ quoteNumber, name, email, phone, fileName, materialName, infill,
  quantity, width, height, depth, volumeCm3, partCount, colorCount, painted, note, total }) {
  const dimensions = [width, height, depth]
    .map((value) => value == null ? "?" : Number(value).toFixed(2))
    .join(" × ");
  return sendStoreNotification({
    subject: `Yeni 3D baskı teklifi · ${quoteNumber}`,
    html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6;max-width:640px">
      <h2>Yeni 3D baskı teklifi geldi</h2>
      <p><strong>Teklif:</strong> ${escapeHtml(quoteNumber)}</p>
      <p><strong>Müşteri:</strong> ${escapeHtml(name)}<br>
        <strong>E-posta:</strong> ${escapeHtml(email || "Belirtilmedi")}<br>
        <strong>Telefon:</strong> ${escapeHtml(phone || "Belirtilmedi")}</p>
      <p><strong>Model:</strong> ${escapeHtml(fileName || "Dosya adı yok")}<br>
        <strong>Ölçüler:</strong> ${escapeHtml(dimensions)} mm<br>
        <strong>Hacim:</strong> ${Number(volumeCm3 || 0).toFixed(2)} cm³<br>
        <strong>Malzeme:</strong> ${escapeHtml(materialName || "Belirtilmedi")} · %${Number(infill || 0)} dolgu · ${Number(quantity || 0)} adet<br>
        <strong>Parça / renk:</strong> ${Number(partCount || 0)} parça · ${Number(colorCount || 1)} renk${painted ? " · boyalı 3MF" : ""}</p>
      <p style="font-size:18px"><strong>Teklif toplamı: ${emailMoney(total)}</strong></p>
      ${note ? `<div style="padding:12px;border-left:3px solid #ff6542;background:#fff7f3"><strong>Müşteri notu</strong><br>${escapeHtml(note)}</div>` : ""}
      <p><a href="https://printable.com.tr/admin" style="color:#ff6542;font-weight:700">Teklifi yönetim panelinde aç</a></p>
    </div>`
  });
}

async function notifyNewContactMessage({ name, email, phone, subject, message }) {
  const cleanSubject = String(subject || "Genel iletişim").replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  return sendStoreNotification({
    subject: `Yeni iletişim mesajı · ${cleanSubject || "Genel iletişim"}`,
    html: `<div style="font-family:Arial,sans-serif;color:#171c2c;line-height:1.6;max-width:640px">
      <h2>Yeni iletişim mesajı geldi</h2>
      <p><strong>Gönderen:</strong> ${escapeHtml(name)}<br>
        <strong>E-posta:</strong> ${escapeHtml(email || "Belirtilmedi")}<br>
        <strong>Telefon:</strong> ${escapeHtml(phone || "Belirtilmedi")}<br>
        <strong>Konu:</strong> ${escapeHtml(cleanSubject || "Genel iletişim")}</p>
      <div style="padding:14px;border-left:3px solid #ff6542;background:#fff7f3;white-space:pre-wrap">${escapeHtml(message)}</div>
      <p><a href="https://printable.com.tr/admin" style="color:#ff6542;font-weight:700">Mesajı yönetim panelinde aç</a></p>
    </div>`
  });
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
    SELECT show_stock, track_stock, min_cart_total, company_title, legal_address
    FROM site_settings WHERE id = 1
  `).get() || {};
  res.json({
    show_stock: s.show_stock ?? 1,
    track_stock: s.track_stock ?? 0,
    min_cart_total: s.min_cart_total ?? 0,
    company_title: s.company_title || "",
    legal_address: s.legal_address || ""
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
      tax_office=NULL, tax_number=NULL, mersis=NULL, return_address=NULL,
      updated_at=NOW()
    WHERE id = 1
  `).run({
    // Checkbox işaretli değilse tarayıcı alanı hiç göndermez; yokluğu "kapalı" demek.
    show_stock: req.body.show_stock === true || req.body.show_stock === "1" || req.body.show_stock === 1 ? 1 : 0,
    track_stock: req.body.track_stock === true || req.body.track_stock === "1" || req.body.track_stock === 1 ? 1 : 0,
    min_cart_total: minTutar,
    company_title: metin(req.body.company_title),
    legal_address: metin(req.body.legal_address)
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

function resolveGalleryMediaType(body, file, mediaPath) {
  if (file?.mimetype?.startsWith("video/")) return "video";
  if (body.media_type === "video") return "video";
  return /\.(mp4|webm)(?:[?#]|$)/i.test(mediaPath || "") ? "video" : "image";
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
    revenue: (await db.prepare("SELECT COALESCE(SUM(total), 0) total FROM orders WHERE payment_status = 'paid'").get()).total,
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
      SELECT id, product_id, color_id, image_path, image_alt, media_type, sort_order
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

/* Ölçeklerin MÜŞTERİYE açık hâli — VİTRİN TEK BOY SATAR.

   %75 / %100 kayıtları maliyet ölçeği olarak girilmiş ve ikisi de ürünün aynı
   satış fiyatını taşıyor. Bunları seçilebilir varyant diye sunmak müşteriye
   "iki boy, tek fiyat" gibi anlamsız bir seçim yaptırıyordu; üstelik hangi
   boyu aldığı fiyattan anlaşılmıyordu. Artık en küçük boy (en düşük maliyetli
   ölçek) satılıyor, hangi boy olduğu ürün sayfasında yazıyla söyleniyor.

   Kırpma ŞABLONDA değil BURADA: bu fonksiyondan hem katalog hem de ödeme
   doğrulaması geçiyor. Şablonda gizleseydik elle scale_id gönderip satılmayan
   boyu sipariş etmek hâlâ mümkün olurdu.

   Sıralama maliyete göre: fiyatlar eşit olduğunda "en ucuz" ölçütü hangi boyun
   satılacağını belirlemiyordu, sıraya kalıyordu. Maliyet küçük boyu başa alır.

   Boyları ayrı fiyatlarla satmaya karar verilirse slice(0, 1) kaldırılır;
   ürün sayfasındaki ölçek seçici (product-templates.js) kendiliğinden geri
   gelir — orada koşul zaten "birden fazla ölçek varsa".

   unit_cost ve inputs ticari sır olduğu için bu listeye hiç girmiyor. */
const satisOlcekleri = (rows, fallbackPrice = null) => (rows || [])
  .map((s) => ({
    id: s.id,
    scale: s.scale,
    price: Number(s.price) > 0 ? round2(Number(s.price)) : round2(Number(fallbackPrice)),
    maliyet: Number(s.unit_cost) || 0
  }))
  .filter((s) => s.price > 0)
  .sort((a, b) => a.maliyet - b.maliyet || a.price - b.price || a.id - b.id)
  .slice(0, 1)
  .map(({ maliyet, ...s }) => s);

// Tek ürün için: POST/PUT sonrası dönen kayıtta kullanılır.
const imagesOfProduct = db.prepare(`
  SELECT id, color_id, image_path, image_alt, media_type, sort_order
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

/* Shopier senkronizasyonu ürün kaydını geri almamalı: Shopier geçici olarak
   erişilemezse Printable ürünü yine kaydedilir, hata panelde görünür ve aynı
   ürün daha sonra yeniden gönderilebilir. Aynı Node örneğinde eşzamanlı iki
   galeri isteğinin iki ayrı Shopier ürünü açmasını da bu kilit engeller. */
const activeShopierSyncs = new Map();

function shopierCompatibilityImage(productId) {
  const relativePath = path.join("assets", "shopier", `${productId}.jpg`);
  return fs.existsSync(path.join(ROOT, relativePath))
    ? `https://www.printable.com.tr/${relativePath.split(path.sep).join("/")}`
    : null;
}

async function performShopierSync(productId) {
  let product = await db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
  if (!product) return null;

  if (!shopier.isConfigured()) {
    await db.prepare(`
      UPDATE products SET shopier_sync_status = 'not_configured',
        shopier_sync_error = 'SHOPIER_API_KEY sunucu ortam değişkeni henüz tanımlı değil.'
      WHERE id = ?
    `).run(productId);
    return withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(productId));
  }

  await db.prepare(`
    UPDATE products SET shopier_sync_status = 'syncing', shopier_sync_error = NULL WHERE id = ?
  `).run(productId);
  product = await withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(productId));
  product.shopier_image_path = shopierCompatibilityImage(product.id);

  try {
    let result;
    try {
      result = await shopier.syncProduct(product);
    } catch (error) {
      /* Shopier kaydı panelden silindiyse eski kimliğe PUT 404 verir. Başka bir
         mağaza/anahtardan kalmış kimlik de bu mağazaya 403 döner. API anahtarının
         genel yazma yetkisi üstte doğrulandığı için iki durumda da eşlemeyi bırakıp
         Printable ürününü bu mağazada bir kez yeniden aç. */
      if ([403, 404].includes(error?.status) && product.shopier_product_id) {
        result = await shopier.syncProduct({
          ...product,
          shopier_product_id: null,
          shopier_product_url: null
        });
      } else {
        throw error;
      }
    }

    await db.prepare(`
      UPDATE products SET shopier_product_id = @shopier_product_id,
        shopier_product_url = @shopier_product_url, shopier_sync_status = 'synced',
        shopier_sync_error = NULL, shopier_synced_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id: productId,
      shopier_product_id: result.productId,
      shopier_product_url: result.productUrl || null
    });
  } catch (error) {
    const message = String(error?.message || "Bilinmeyen Shopier senkronizasyon hatası").slice(0, 1000);
    console.error(`[Shopier] Ürün ${productId} senkronize edilemedi: ${message}`);
    await db.prepare(`
      UPDATE products SET shopier_sync_status = 'failed', shopier_sync_error = ? WHERE id = ?
    `).run(message, productId);
  }

  return withColors(await db.prepare("SELECT * FROM products WHERE id = ?").get(productId));
}

function synchronizeProductWithShopier(productId) {
  const key = String(productId);
  if (activeShopierSyncs.has(key)) return activeShopierSyncs.get(key);
  const running = performShopierSync(productId).finally(() => activeShopierSyncs.delete(key));
  activeShopierSyncs.set(key, running);
  return running;
}

/* Maliyet verisi TİCARİ SIR: /api/products herkese açık, ürünün kaça mal
   olduğu müşteriye ya da rakibe gitmemeli. Yalnızca giriş yapmış yöneticiye
   dönüyor. Ayrı bir uç açmak yerine burada süzmek yeterli — panel zaten bu
   listeyi kullanıyor.

   `scales` BİLEREK kalıyor: o, satisOlcekleri'nden geçmiş hâli, yalnızca ölçek
   adı ve satış fiyatı. Müşteri zaten bu ikisini görmek zorunda — seçtiği
   varyant ve ödeyeceği tutar. Silinen `cost_scales` ise maliyeti taşıyor. */
const maliyetiGizle = (urun) => {
  const {
    unit_cost, cost_inputs, cost_updated_at, cost_scales,
    shopier_product_id, shopier_product_url, shopier_sync_status,
    shopier_sync_error, shopier_synced_at,
    ...kalan
  } = urun;
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

/* ---------- blog ---------- */

const slugify = (value) => String(value || "")
  .toLocaleLowerCase("tr").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/ı/g, "i").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 110);

function sanitizeBlogHtml(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|object|embed|form)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(?:script|style|object|embed|form)[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, "");
}

async function publishDueBlogPosts() {
  await db.prepare("UPDATE blog_posts SET status = 'published', updated_at = CURRENT_TIMESTAMP WHERE status = 'scheduled' AND published_at IS NOT NULL AND published_at <= NOW()").run();
}

function blogPayload(body, files = {}) {
  const coverFile = files.image?.[0];
  const mediaFile = files.media?.[0];
  const mediaUrl = body.media_key ? storage.publicUrl(body.media_key) : mediaFile ? `/uploads/${mediaFile.filename}` : body.media_url?.trim() || body.current_media || null;
  const status = ["draft", "scheduled", "published"].includes(body.status) ? body.status : "draft";
  const title = String(body.title || "").replace(/\s+/g, " ").trim();
  return {
    slug: slugify(body.slug || title), title,
    excerpt: seoMetniKisalt(body.excerpt || "", 300) || null,
    content: sanitizeBlogHtml(body.content),
    cover_image: body.cover_key ? storage.publicUrl(body.cover_key) : resolveImagePath({ image_url: body.cover_image, current_image: body.current_cover }, coverFile),
    cover_alt: body.cover_alt?.trim() || title || null,
    media_url: mediaUrl,
    media_type: ["none", "image", "video", "embed"].includes(body.media_type) ? body.media_type : (mediaUrl ? "image" : "none"),
    author_name: body.author_name?.trim() || "Printable", status,
    published_at: body.published_at?.trim() || (status === "published" ? new Date().toISOString() : null),
    meta_title: seoMetniKisalt(body.meta_title || `${title} | Printable`, 70) || null,
    meta_description: seoMetniKisalt(body.meta_description || body.excerpt || "", 170) || null,
    meta_keywords: body.meta_keywords?.trim() || null, canonical: body.canonical?.trim() || null,
    og_title: body.og_title?.trim() || null, og_description: body.og_description?.trim() || null,
    og_image: body.og_image?.trim() || null, robots: body.robots?.trim() || "index,follow"
  };
}

app.get("/api/blog", async (req, res) => {
  await publishDueBlogPosts();
  const posts = await db.prepare("SELECT * FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC NULLS LAST, id DESC").all();
  res.json(posts.filter(blogIsPublic));
});

app.get("/api/blog-posts", requireAdmin, async (req, res) => {
  await publishDueBlogPosts();
  res.json(await db.prepare("SELECT * FROM blog_posts ORDER BY created_at DESC, id DESC").all());
});

app.post("/api/blog-posts", requireAdmin, galleryUpload.fields([{ name: "image", maxCount: 1 }, { name: "media", maxCount: 1 }]), async (req, res) => {
  const post = blogPayload(req.body, req.files || {});
  if (!post.title || !post.slug) return res.status(400).json({ error: "Başlık ve geçerli bir slug zorunludur." });
  if (post.status === "scheduled" && !post.published_at) return res.status(400).json({ error: "Zamanlanmış yazı için yayın tarihi girin." });
  if (await db.prepare("SELECT id FROM blog_posts WHERE slug = ?").get(post.slug)) return res.status(409).json({ error: "Bu slug zaten kullanılıyor." });
  const result = await db.prepare(`INSERT INTO blog_posts (slug, title, excerpt, content, cover_image, cover_alt, media_url, media_type, author_name, status, published_at, meta_title, meta_description, meta_keywords, canonical, og_title, og_description, og_image, robots) VALUES (@slug, @title, @excerpt, @content, @cover_image, @cover_alt, @media_url, @media_type, @author_name, @status, @published_at, @meta_title, @meta_description, @meta_keywords, @canonical, @og_title, @og_description, @og_image, @robots)`).run(post);
  res.status(201).json(await db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/blog-posts/:id", requireAdmin, galleryUpload.fields([{ name: "image", maxCount: 1 }, { name: "media", maxCount: 1 }]), async (req, res) => {
  const current = await db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Blog yazısı bulunamadı." });
  const post = blogPayload({ ...req.body, current_cover: current.cover_image, current_media: current.media_url }, req.files || {});
  if (!post.title || !post.slug) return res.status(400).json({ error: "Başlık ve geçerli bir slug zorunludur." });
  if (await db.prepare("SELECT id FROM blog_posts WHERE slug = ? AND id <> ?").get(post.slug, current.id)) return res.status(409).json({ error: "Bu slug zaten kullanılıyor." });
  await db.prepare(`UPDATE blog_posts SET slug=@slug, title=@title, excerpt=@excerpt, content=@content, cover_image=@cover_image, cover_alt=@cover_alt, media_url=@media_url, media_type=@media_type, author_name=@author_name, status=@status, published_at=@published_at, meta_title=@meta_title, meta_description=@meta_description, meta_keywords=@meta_keywords, canonical=@canonical, og_title=@og_title, og_description=@og_description, og_image=@og_image, robots=@robots, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({ ...post, id: current.id });
  res.json(await db.prepare("SELECT * FROM blog_posts WHERE id = ?").get(current.id));
});

app.delete("/api/blog-posts/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM blog_posts WHERE id = ?").run(req.params.id);
  res.status(204).end();
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
  res.status(201).json(await synchronizeProductWithShopier(result.lastInsertRowid));
});

app.post("/api/products/:id/shopier-sync", requireAdmin, async (req, res) => {
  const product = await db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });
  res.json(await synchronizeProductWithShopier(product.id));
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
  res.json(await synchronizeProductWithShopier(current.id));
});

/* ---------- Ürün galerisi ----------
   Fotoğraflar ürün formundan ayrı yönetilir: tek bir dev formda 10 dosyayı
   birlikte göndermek hem Vercel'in istek sınırına takılır hem de tek bir
   yükleme hatası ürünün tamamının kaydını düşürürdü. Her fotoğraf kendi
   isteğiyle gelir; biri patlarsa diğerleri kaydedilmiş olur. */

app.post("/api/products/:id/images", requireAdmin, galleryUpload.single("image"), async (req, res) => {
  const product = await db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Ürün bulunamadı." });

  const yol = resolveImagePath({ image_key: req.body.image_key, image_url: req.body.image_url }, req.file);
  if (!yol) return res.status(400).json({ error: "Fotoğraf veya video dosyası ya da adresi gerekli." });
  const mediaType = resolveGalleryMediaType(req.body, req.file, yol);

  // Yeni fotoğraf sona eklenir; sıralamayı admin sürükleyerek değil, sıra
  // numarasıyla değiştiriyor (basit ve dokunmatik ekranda güvenilir).
  const son = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS son FROM product_images WHERE product_id = ?").get(product.id);
  const renkId = toInt(req.body.color_id) || null;

  const sonuc = await db.prepare(`
    INSERT INTO product_images (product_id, color_id, image_path, image_alt, media_type, sort_order)
    VALUES (@product_id, @color_id, @image_path, @image_alt, @media_type, @sort_order)
  `).run({
    product_id: product.id,
    color_id: renkId,
    image_path: yol,
    image_alt: req.body.image_alt?.trim() || null,
    media_type: mediaType,
    sort_order: Number(son.son) + 1
  });

  await synchronizeProductWithShopier(product.id);
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
  await synchronizeProductWithShopier(req.params.id);
  res.json(await db.prepare("SELECT * FROM product_images WHERE id = ?").get(row.id));
});

app.delete("/api/products/:id/images/:imageId", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT id FROM product_images WHERE id = ? AND product_id = ?")
    .get(req.params.imageId, req.params.id);
  if (!row) return res.status(404).json({ error: "Fotoğraf bulunamadı." });
  await db.prepare("DELETE FROM product_images WHERE id = ?").run(row.id);
  await synchronizeProductWithShopier(req.params.id);
  res.status(204).end();
});

/* Galerideki bir fotoğrafı kapak yap. Kapak products.image_path'te durur:
   ürün kartları, arama sonuçları ve paylaşım görseli onu kullanıyor. */
app.post("/api/products/:id/images/:imageId/cover", requireAdmin, async (req, res) => {
  const row = await db.prepare("SELECT image_path, image_alt, media_type FROM product_images WHERE id = ? AND product_id = ?")
    .get(req.params.imageId, req.params.id);
  if (!row) return res.status(404).json({ error: "Fotoğraf bulunamadı." });
  if (row.media_type === "video") return res.status(400).json({ error: "Video kapak görseli olamaz." });
  /* Alt metin de taşınır: kapak değişip alt metin eski fotoğrafınki kalırsa
     ürün sayfası yanlış görseli tarif eder (SEO ve ekran okuyucu için hatalı).
     Galeri fotoğrafının alt metni boşsa üründekine dokunmuyoruz. */
  await db.prepare(`
    UPDATE products SET image_path = ?, image_alt = COALESCE(?, image_alt), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(row.image_path, row.image_alt || null, req.params.id);
  res.json(await synchronizeProductWithShopier(req.params.id));
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

const pricingTiers = async () => await db.prepare(`
  SELECT id, min_grams, discount_percent FROM pricing_tiers ORDER BY min_grams ASC, id ASC
`).all();

/* Sipariş gramajının düştüğü kademe ve bir üstü. Kademeler artan sırada
   geldiği için "eşiği geçilenlerin sonuncusu" aranan kademedir; hiçbiri
   geçilmediyse indirim yok. Bir üst kademe müşteriye "şu kadar gram daha
   eklersen gram fiyatın şu olur" diyebilmek için döner. */
function tierFor(tiers, totalGrams) {
  const reached = tiers.filter((t) => totalGrams >= Number(t.min_grams));
  return {
    current: reached.length ? reached[reached.length - 1] : { min_grams: 0, discount_percent: 0 },
    next: tiers.find((t) => Number(t.min_grams) > totalGrams) || null
  };
}

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
  const density = Number(material.density_g_cm3) || 1.24;
  const estimatedWeight = usedVolume * density;

  /* Kademe indirimi siparişin TAMAMININ gramajına bakar (parça × adet): adet
     artırmak da kademe atlatır, teşvik etmek istediğimiz davranış bu.
     İndirim yalnızca MALZEME ücretine uygulanır — boyut ücreti makine
     zamanıdır, çok gram basmak onu ucuzlatmaz. */
  const tiers = await pricingTiers();
  const totalWeight = estimatedWeight * qty;
  const { current: tier, next: nextTier } = tierFor(tiers, totalWeight);
  const tierDiscount = Math.min(100, Math.max(0, Number(tier.discount_percent) || 0)) / 100;

  const basePerGram = material.price_per_cm3 / density;
  const perGram = basePerGram * (1 - tierDiscount);

  const materialFee = usedVolume * material.price_per_cm3 * (1 - tierDiscount);
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

  /* Kademenin müşteriye kazandırdığı tutar. Yüzdeden çarparak değil, indirimsiz
     toplamı bütünüyle kurup farkını alarak buluyoruz: minimum sipariş tutarı
     tabanı devredeyse indirimin bir kısmı tabana yutulur ve "şu kadar kazandınız"
     yazısı müşterinin cebinde göremediği bir rakamı vaat ederdi. */
  const indirimsizBirim = usedVolume * material.price_per_cm3 + sizeFee;
  const indirimsizToplam = Math.max(
    settings.min_order_total,
    settings.setup_fee + indirimsizBirim * qty + colorFee
  );
  const tierSavings = Math.max(0, indirimsizToplam - total);

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
    total_weight_g: totalWeight,
    /* Gram fiyatı iki değerle döner: zamsız taban ve kademe uygulanmış hâli.
       Vitrin ikisini birden gösterip üstünü çiziyor — indirimin görünmesi
       kademenin varlık sebebi. */
    price_per_gram_base: basePerGram,
    price_per_gram: perGram,
    tier_discount_percent: Number(tier.discount_percent) || 0,
    tier_min_grams: Number(tier.min_grams) || 0,
    tier_savings: tierSavings,
    total_without_tier: indirimsizToplam,
    next_tier: nextTier
      ? {
          min_grams: Number(nextTier.min_grams),
          discount_percent: Number(nextTier.discount_percent),
          grams_needed: Number(nextTier.min_grams) - totalWeight,
          price_per_gram: basePerGram * (1 - Number(nextTier.discount_percent) / 100)
        }
      : null,
    tiers: tiers.map((t) => ({
      min_grams: Number(t.min_grams),
      discount_percent: Number(t.discount_percent),
      price_per_gram: basePerGram * (1 - Number(t.discount_percent) / 100),
      active: Number(t.min_grams) === Number(tier.min_grams)
    })),
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
      color_change_fee=@color_change_fee, updated_at=CURRENT_TIMESTAMP
    WHERE id=1
  `).run({
    setup_fee: Math.max(0, Number(req.body.setup_fee) || 0),
    size_fee_per_cm: Math.max(0, Number(req.body.size_fee_per_cm) || 0),
    min_order_total: Math.max(0, Number(req.body.min_order_total) || 0),
    shell_share: Math.min(1, Math.max(0, Number.isFinite(shell) ? shell : 0.15)),
    color_change_fee: Math.max(0, Number(req.body.color_change_fee) || 0)
  });
  res.json(await pricingSettings());
});

/* Kademeler herkese açık: zaten /api/quote-price yanıtının içinde dönüyorlar
   ve sayfada müşteriye gösteriliyorlar — gizlenecek bir taraf yok. Ayrı uç,
   dosya yüklenmeden de merdiveni gösterebilmek için. */
app.get("/api/pricing-tiers", async (req, res) => res.json(await pricingTiers()));

/* Kademe listesi bir bütün olarak kaydedilir: satır satır PUT/DELETE yerine
   "gelen liste yeni gerçektir". Aralarındaki ilişki (eşiklerin sırası,
   çakışmaması) tek tek düzenlemede kolayca bozulur. */
app.put("/api/pricing-tiers", requireAdmin, async (req, res) => {
  const gelen = Array.isArray(req.body?.tiers) ? req.body.tiers : null;
  if (!gelen) return res.status(400).json({ error: "Kademe listesi gönderilmedi." });

  const temiz = [];
  for (const satir of gelen) {
    const grams = Math.max(0, Number(satir?.min_grams) || 0);
    const percent = Number(satir?.discount_percent) || 0;
    if (percent < 0 || percent > 90) {
      return res.status(400).json({ error: "İndirim oranı %0 ile %90 arasında olmalıdır." });
    }
    if (temiz.some((t) => t.min_grams === grams)) {
      return res.status(400).json({ error: `Aynı gram eşiği birden fazla kez girilmiş: ${grams} g.` });
    }
    temiz.push({ min_grams: grams, discount_percent: percent });
  }
  temiz.sort((a, b) => a.min_grams - b.min_grams);

  /* Eşik büyüdükçe indirim de büyümeli. Aksi hâlde müşteri gram ekleyince
     fiyatı ARTAN bir merdiven çıkar — teşvik yerine ceza. */
  for (let i = 1; i < temiz.length; i += 1) {
    if (temiz[i].discount_percent < temiz[i - 1].discount_percent) {
      return res.status(400).json({ error: "Gram eşiği arttıkça indirim oranı azalamaz." });
    }
  }

  await db.transaction(async (tx) => {
    await tx.prepare("DELETE FROM pricing_tiers").run();
    const ekle = tx.prepare("INSERT INTO pricing_tiers (min_grams, discount_percent) VALUES (?, ?)");
    for (const satir of temiz) await ekle.run(satir.min_grams, satir.discount_percent);
  });
  res.json(await pricingTiers());
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

  const savedQuote = await db.prepare("SELECT * FROM quotes WHERE id = ?").get(result.lastInsertRowid);
  const ownerNotified = await notifyNewQuote({
    quoteNumber: savedQuote.quote_number,
    name: savedQuote.customer_name,
    email: savedQuote.email,
    phone: savedQuote.phone,
    fileName: savedQuote.file_name,
    materialName: savedQuote.material_name,
    infill: savedQuote.infill,
    quantity: savedQuote.quantity,
    width: savedQuote.width,
    height: savedQuote.height,
    depth: savedQuote.depth,
    volumeCm3: savedQuote.volume_cm3,
    partCount: parts.length,
    colorCount: Math.max(1, distinctColors.size),
    painted: Boolean(savedQuote.painted),
    note: savedQuote.note,
    total: savedQuote.total
  }).catch((error) => {
    console.error(`3D teklif bildirimi gönderilemedi (${quoteNumber}):`, error.message);
    return false;
  });
  if (!ownerNotified) console.error(`3D teklif bildirimi gönderilemedi: ${quoteNumber}`);

  res.status(201).json({ ...await withParts(savedQuote), notification_sent: ownerNotified });
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
      phone=@phone, email=@email, whatsapp=@whatsapp,
      contact_address=NULL, working_hours=NULL,
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
    whatsapp: req.body.whatsapp?.trim() || null
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

/* Duyurulacak tek kampanya: canlı, kodlu ve istenen vitrin sütunu işaretli
   olanlardan bitişi en yakın olan (aciliyet en yüksek olan öne çıksın).
   Sütun adı SQL'e gömüldüğü için beyaz listeden geçer — dışarıdan gelen bir
   değerin buraya ulaşması mümkün değil, öyle de kalsın. */
async function livePromoCampaign(column) {
  if (!["show_on_banner", "show_on_popup"].includes(column)) return null;
  return await db.prepare(`
    SELECT * FROM campaigns
    WHERE is_active = 1 AND ${column} = 1 AND code IS NOT NULL
      AND (starts_at IS NULL OR starts_at::date <= CURRENT_DATE)
      AND (ends_at   IS NULL OR ends_at::date   >= CURRENT_DATE)
      AND (usage_limit IS NULL OR used_count < usage_limit)
    ORDER BY (ends_at IS NULL), ends_at ASC, id DESC
    LIMIT 1
  `).get();
}

const liveBannerCampaign = () => livePromoCampaign("show_on_banner");

// ends_at yalnızca tarih tutuyor (bkz. liveCampaigns); şeritteki geri sayım o günün
// sonuna kadar çalışsın diye 23:59:59'a tamamlanır.
function bannerPayload(campaign) {
  return {
    name: campaign.name,
    code: campaign.code,
    discount_type: campaign.discount_type,
    discount_value: Number(campaign.discount_value),
    deadline: campaign.ends_at ? `${campaign.ends_at}T23:59:59` : null
  };
}

/* Kişi başı kullanım için müşteri kimliği. Sitede misafir alışverişi var ve her
   sipariş yeni bir customers satırı açıyor; "aynı müşteri mi" sorusunu
   yanıtlayan tek iz campaign_uses'a kopyalanan iletişim bilgisi. E-posta VEYA
   telefon eşleşmesi yeter — birini değiştiren müşteri diğerinden yakalanır.
   Telefon rakamlara indirgenip son 10 haneye bakılır: "0532 111 22 33",
   "+90 532 111 22 33" ve "532 111 22 33" aynı kişidir. */
function customerIdentity(source) {
  const phone = String(source?.phone || "").replace(/\D/g, "").slice(-10);
  return {
    email: String(source?.email || "").trim().toLowerCase(),
    phone: phone.length === 10 ? phone : ""
  };
}

// Bu kampanyayı bu müşteri daha önce kaç kez kullandı?
async function customerUseCount(campaignId, identity, target = db) {
  const row = await target.prepare(`
    SELECT COUNT(*) AS n FROM campaign_uses
    WHERE campaign_id = ?
      AND ( (? <> '' AND LOWER(TRIM(COALESCE(customer_email, ''))) = ?)
         OR (? <> '' AND RIGHT(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?) )
  `).get(campaignId, identity.email, identity.email, identity.phone, identity.phone);
  return Number(row?.n) || 0;
}

/* Kişi başı hak doldu mu? Kimliği henüz bilmiyorsak engellemiyoruz — sepet
   önizlemesinde müşteri e-postasını daha yazmamış olabilir. Asıl kontrol
   siparişin yazıldığı transaction'da; orada kimlik her zaman dolu. */
async function perCustomerLimitReached(campaign, identity, target = db) {
  if (!campaign.per_customer_limit) return false;
  if (!identity?.email && !identity?.phone) return false;
  return (await customerUseCount(campaign.id, identity, target)) >= campaign.per_customer_limit;
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

  /* Hangi kalemleri kapsadığının imzası. evaluateCampaigns bununla aynı ürün
     kümesini hedefleyen adet kademelerini tanıyıp yalnızca en iyisini
     uyguluyor — "10+ %5", "50+ %12", "100+ %20" üst üste binerse müşteri
     100 adette %37 indirim alırdı ve katalog %20 yazdığı için sözle
     gerçek tutmazdı. */
  const scopeKey = eligible.map((item) => item.product_id).sort((a, b) => a - b).join(",");

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
      label: campaignLabel(campaign),
      scopeKey
    };
  }

  // Sabit indirim kapsadığı tutarı aşamaz, yoksa sipariş eksiye düşer.
  const raw = campaign.discount_type === "percent"
    ? subtotal * (campaign.discount_value / 100)
    : Math.min(campaign.discount_value, subtotal);
  const discount = round2(raw);
  if (discount <= 0) return null;
  return { campaign, discount, gift: null, label: campaignLabel(campaign), scopeKey };
}

/* Sepete uygulanacak her şeyi döndürür.
   code verilmişse ve geçersizse `error` dolar — otomatik kampanyalar yine uygulanır,
   çünkü yanlış yazılmış bir kupon hak edilmiş bir indirimi iptal etmemeli. */
async function evaluateCampaigns(items, code, identity = null) {
  const typed = String(code || "").trim().toUpperCase();
  const live = await liveCampaigns();
  const applied = [];
  const gifts = [];
  let discount = 0;
  let error = null;

  // 1) Otomatik kampanyalar (kodu olmayanlar). Sırayla: discount toplamı
  //    paylaşılan bir değişken, paralel çalıştırmak yarış koşulu yaratır.
  const otomatik = [];
  for (const campaign of live.filter((c) => !c.code)) {
    if (await perCustomerLimitReached(campaign, identity)) continue;
    const result = await evaluateOne(campaign, items);
    if (result) otomatik.push({ campaign, result });
  }

  /* Adet kademeleri ÜST ÜSTE BİNMEZ: aynı ürün kümesini hedefleyen adet
     koşullu indirimlerden yalnızca en iyisi uygulanır. 100 adet alan müşteri
     "10+", "50+" ve "100+" kademelerinin üçünü birden hak eder; toplasaydık
     katalogda yazan orandan çok daha fazlasını verirdik. Katalog zaten tek
     bir kademe (en ucuz birim) gösteriyor — burası onunla aynı hesabı yapar.

     Farklı ürün kümelerini hedefleyenler ayrı gruplardır ve birlikte
     uygulanır; sepetteki iki ayrı ürün grubunun kendi kademesi olabilir.
     Hediye kampanyaları yarışmaya girmez: indirimleri 0 olduğu için
     karşılaştırmayı hep kaybeder ve hak edilmiş hediye düşerdi. */
  const kademeYarisi = new Map();
  for (const aday of otomatik) {
    if (!aday.campaign.min_quantity || aday.campaign.kind === "gift") continue;
    const mevcut = kademeYarisi.get(aday.result.scopeKey);
    if (!mevcut || aday.result.discount > mevcut.result.discount) kademeYarisi.set(aday.result.scopeKey, aday);
  }
  const kazananKademeler = new Set([...kademeYarisi.values()].map((x) => x.campaign.id));

  for (const { campaign, result } of otomatik) {
    const kademe = campaign.min_quantity && campaign.kind !== "gift";
    if (kademe && !kazananKademeler.has(campaign.id)) continue;
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
    } else if (await perCustomerLimitReached(coupon, identity)) {
      /* Kod hâlâ canlı ama bu müşteri hakkını doldurmuş. Ayrı bir mesaj: yukarıdaki
         "süresi dolmuş" cevabı müşteriyi kodun bittiğine inandırır, oysa sorun kodda
         değil. Kimlik ödeme formundan geliyor, bu yüzden e-posta/telefon yazılır
         yazılmaz uyarı görünür — sipariş verdikten sonra değil. */
      error = "Bu kampanya kodunu daha önce kullandınız.";
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
      "SELECT id, scale, price, unit_cost FROM product_cost_scales WHERE product_id = ? ORDER BY unit_cost ASC, id ASC"
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
  // Kimlik (e-posta/telefon) formda doluysa gelir; kişi başı hakkı bitmiş kodu
  // müşteri siparişi göndermeden önce öğrensin.
  const result = await evaluateCampaigns(items, req.body.code, customerIdentity(req.body));
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

/* Sitedeki geri sayım şeridinde gösterilecek kampanya. Herkese açık: /api/catalog'un
   aksine kodu BİLEREK yayınlıyoruz, çünkü admin show_on_banner ile "bu kodu herkese
   duyur" demiş oluyor. Birden fazla işaretliyse bitişi en yakın olan kazanır. */
app.get("/api/campaigns/banner", async (req, res) => {
  const campaign = await liveBannerCampaign();
  res.json(campaign ? bannerPayload(campaign) : null);
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
    // Kişi başı hak; boş = sınırsız (toplam kontenjandan ayrı, bkz. migration notu).
    per_customer_limit: toInt(body.per_customer_limit) || null,
    is_active: body.is_active === false || body.is_active === "false" ? 0 : 1,
    // Aktif/pasif alma PUT'u tüm kaydı (0/1 sayısal) geri gönderiyor; boolean ve
    // sayısal doğru değerlerin ikisini de kabul etmezsek şeriti sessizce kapatırdı.
    show_on_banner: [true, "true", 1, "1"].includes(body.show_on_banner) ? 1 : 0,
    show_on_popup: [true, "true", 1, "1"].includes(body.show_on_popup) ? 1 : 0,
    /* Boş = pencere bir kez açılır, 0 = her sayfa yüklemesinde. Boşluk kontrolü
       toInt'ten ÖNCE: toInt("") de 0 döndürüyor, ikisini ayırmazsak boş bırakan
       admin farkında olmadan "her yüklemede aç" demiş olurdu. */
    popup_repeat_minutes: String(body.popup_repeat_minutes ?? "").trim() === ""
      ? null
      : Math.max(0, toInt(body.popup_repeat_minutes))
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
  // Şerit ve pencere kodu herkese açık yayınlar; kodsuz kampanya ikisinde de sessizce hiç görünmezdi.
  if (payload.show_on_banner && !payload.code) return "Şeritte göstermek için bir kampanya kodu girin.";
  if (payload.show_on_popup && !payload.code) return "Açılır pencerede göstermek için bir kampanya kodu girin.";
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
      min_order_total, gift_product_id, gift_quantity, starts_at, ends_at, usage_limit, per_customer_limit,
      is_active, show_on_banner, show_on_popup, popup_repeat_minutes)
    VALUES (@name, @code, @kind, @discount_type, @discount_value, @scope, @min_quantity,
      @min_order_total, @gift_product_id, @gift_quantity, @starts_at, @ends_at, @usage_limit, @per_customer_limit,
      @is_active, @show_on_banner, @show_on_popup, @popup_repeat_minutes)
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
      starts_at=@starts_at, ends_at=@ends_at, usage_limit=@usage_limit,
      per_customer_limit=@per_customer_limit, is_active=@is_active,
      show_on_banner=@show_on_banner, show_on_popup=@show_on_popup,
      popup_repeat_minutes=@popup_repeat_minutes
    WHERE id=@id
  `).run({ ...payload, id: current.id });
  await setCampaignTargets(current.id, req.body);

  res.json(await campaignWithTargets(await db.prepare("SELECT * FROM campaigns WHERE id = ?").get(current.id)));
});

app.delete("/api/campaigns/:id", requireAdmin, async (req, res) => {
  await db.prepare("DELETE FROM campaigns WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

const paytrHmac = (value) => crypto
  .createHmac("sha256", PAYTR_MERCHANT_KEY)
  .update(String(value), "utf8")
  .digest("base64");

const paymentStatusToken = (reference) => crypto
  .createHmac("sha256", SESSION_SECRET)
  .update(`paytr-status:${reference}`, "utf8")
  .digest("hex");

function safeTextEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function paytrClientIp(req) {
  const value = String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return value.slice(0, 39);
}

/* PayTR sepet satırlarının toplamı tahsilat tutarıyla birebir eşleşsin. İndirim
   ve sipariş indirimi ürün satırlarına oransal dağıtılır;
   son satır kuruş farkını kapatır. */
function paytrBasket(items, total) {
  const paidItems = items.filter((item) => Number(item.line_total) > 0);
  const subtotal = paidItems.reduce((sum, item) => sum + Number(item.line_total), 0);
  const totalCents = Math.round(Number(total) * 100);
  let allocated = 0;

  return paidItems.map((item, index) => {
    const cents = index === paidItems.length - 1
      ? totalCents - allocated
      : Math.round(totalCents * Number(item.line_total) / subtotal);
    allocated += cents;
    const scale = item.scale ? ` (${item.scale})` : "";
    const quantity = Number(item.quantity) > 1 ? ` × ${Number(item.quantity)}` : "";
    return [`${item.product_name}${scale}${quantity}`.slice(0, 120), (cents / 100).toFixed(2), 1];
  });
}

async function requestPaytrIframe({ req, order, customer, items, origin, statusToken }) {
  const paymentAmount = String(Math.round(Number(order.total) * 100));
  const userBasket = Buffer.from(JSON.stringify(paytrBasket(items, order.total)), "utf8").toString("base64");
  const userIp = paytrClientIp(req);
  const hashString = [
    PAYTR_MERCHANT_ID,
    userIp,
    order.payment_reference,
    customer.email,
    paymentAmount,
    userBasket,
    PAYTR_NO_INSTALLMENT,
    PAYTR_MAX_INSTALLMENT,
    "TL",
    PAYTR_TEST_MODE
  ].join("");
  const paytrToken = paytrHmac(hashString + PAYTR_MERCHANT_SALT);
  const resultUrl = (state) => {
    const url = new URL("/odeme", origin);
    url.searchParams.set("paytr", state);
    url.searchParams.set("ref", order.payment_reference);
    url.searchParams.set("token", statusToken);
    return url.toString();
  };
  const form = new URLSearchParams({
    merchant_id: PAYTR_MERCHANT_ID,
    user_ip: userIp,
    merchant_oid: order.payment_reference,
    email: customer.email,
    payment_amount: paymentAmount,
    paytr_token: paytrToken,
    user_basket: userBasket,
    debug_on: PAYTR_DEBUG_ON,
    no_installment: PAYTR_NO_INSTALLMENT,
    max_installment: PAYTR_MAX_INSTALLMENT,
    user_name: customer.name.slice(0, 60),
    user_address: order.shipping_address.slice(0, 400),
    user_phone: customer.phone.slice(0, 20),
    merchant_ok_url: resultUrl("success"),
    merchant_fail_url: resultUrl("failed"),
    timeout_limit: PAYTR_TIMEOUT_LIMIT,
    currency: "TL",
    test_mode: PAYTR_TEST_MODE,
    lang: "tr"
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(PAYTR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok || payload?.status !== "success" || !payload.token) {
      throw new Error(payload?.reason || `PayTR token isteği başarısız (${response.status}).`);
    }
    return `${PAYTR_IFRAME_BASE}${encodeURIComponent(payload.token)}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function releaseOrderReservations(tx, order) {
  const uses = await tx.prepare("SELECT campaign_id FROM campaign_uses WHERE order_id = ?").all(order.id);
  for (const use of uses) {
    await tx.prepare("UPDATE campaigns SET used_count = GREATEST(0, used_count - 1) WHERE id = ?").run(use.campaign_id);
  }
  if (uses.length) await tx.prepare("DELETE FROM campaign_uses WHERE order_id = ?").run(order.id);

  if (Number(order.inventory_deducted) === 1) {
    const quantities = await tx.prepare(`
      SELECT product_id, SUM(quantity)::int AS quantity
      FROM order_items
      WHERE order_id = ? AND product_id IS NOT NULL AND line_total > 0
      GROUP BY product_id
    `).all(order.id);
    for (const item of quantities) {
      await tx.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(item.quantity, item.product_id);
    }
  }
}

async function markPendingPaymentFailed(reference, code, message) {
  return db.transaction(async (tx) => {
    const order = await tx.prepare("SELECT * FROM orders WHERE payment_reference = ? FOR UPDATE").get(reference);
    if (!order || order.payment_status !== "pending") return false;
    await releaseOrderReservations(tx, order);
    await tx.prepare(`
      UPDATE orders SET payment_status = 'failed', payment_failure_code = ?,
        payment_failure_message = ?, inventory_deducted = 0, updated_at = NOW()
      WHERE id = ?
    `).run(String(code || "payment_failed").slice(0, 50), String(message || "Ödeme tamamlanamadı.").slice(0, 500), order.id);
    return true;
  });
}

async function notifyPaidOrder(orderId) {
  const order = await db.prepare(`
    SELECT o.*, c.name customer_name, c.email customer_email, c.phone customer_phone
    FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?
  `).get(orderId);
  if (!order) return;
  const items = await db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(order.id);
  const tasks = [];
  if (process.env.RESEND_API_KEY && order.customer_email) {
    tasks.push(sendOrderReceivedEmail({
      to: order.customer_email,
      name: order.customer_name,
      orderNumber: order.order_number,
      items,
      total: order.total
    }));
  }
  if (process.env.RESEND_API_KEY && STORE_NOTIFICATION_EMAILS.length) {
    tasks.push(notifyNewOrder({
      name: order.customer_name,
      email: order.customer_email,
      phone: order.customer_phone,
      orderNumber: order.order_number,
      items,
      total: order.total
    }));
  }
  const results = await Promise.allSettled(tasks);
  if (results.some((result) => result.status === "rejected" || result.value === false)) {
    console.error(`Ödenen sipariş e-postası gönderilemedi: ${order.order_number}`);
  }
}

// Ödeme başlangıcı: sipariş "pending" açılır ve kart formu PayTR iframe'ine taşınır.
// Siparişi "paid" yapan tek yer aşağıdaki imzalı PayTR callback'idir.
app.post("/api/checkout", async (req, res) => {
  const body = req.body || {};
  const customer = body.customer || {};
  const items = Array.isArray(body.items) ? body.items : [];

  if (!PAYTR_CONFIGURED) {
    return res.status(503).json({ error: "Kartlı ödeme altyapısı henüz etkinleştirilmemiş." });
  }

  if (!customer.name?.trim()) return res.status(400).json({ error: "Ad soyad zorunludur." });
  if (!customer.phone?.trim()) return res.status(400).json({ error: "Telefon numarası zorunludur." });
  const customerEmail = normalizeCustomerEmail(customer.email);
  if (!validCustomerEmail(customerEmail) || customerEmail.length > 100 || /[^\x00-\x7F]/.test(customerEmail)) {
    return res.status(400).json({ error: "PayTR ödemesi için geçerli bir e-posta adresi zorunludur." });
  }
  if (!customer.city?.trim()) return res.status(400).json({ error: "İl zorunludur." });
  if (!customer.district?.trim()) return res.status(400).json({ error: "İlçe zorunludur." });
  if (!customer.address?.trim()) return res.status(400).json({ error: "Açık adres zorunludur." });
  if (!items.length) return res.status(400).json({ error: "Sepetiniz boş." });

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
  if (subtotal <= 0) return res.status(400).json({ error: "Sepet toplamı ödeme için geçerli değil." });

  /* Minimum sepet tutarı burada da kontrol edilir. Ödeme sayfası kullanıcıyı
     zaten uyarıyor ama o sadece arayüz; isteği doğrudan atan biri sınırı
     aşabilirdi. Kontrol indirim ÖNCESİ ara toplama göre: kupon kullanan
     müşteri minimumun altına düşmüş sayılmasın. */
  const magaza = await db.prepare("SELECT min_cart_total, track_stock, site_url FROM site_settings WHERE id = 1").get() || {};
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
  const kimlik = customerIdentity({ email: customerEmail, phone: customer.phone });
  const campaigns = await evaluateCampaigns(normalized, body.coupon_code, kimlik);
  const discount = Math.min(campaigns.discount, subtotal);
  const netTotal = round2(subtotal - discount);

  // Vitrindeki fiyat nihai ürün fiyatıdır. Kampanya indirimi düşüldükten sonra
  // ayrıca KDV eklenmez; kargo alıcı ödemeliyse o da çevrimiçi tahsilata girmez.
  const taxRate = KDV_RATE;

  const pendingOrder = await db.transaction(async (tx) => {
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
      /* Kişi başı hak son kez BURADA doğrulanır. Yukarıdaki hesap da bakıyor ama
         arada geçen sürede müşterinin başka bir sekmede sipariş vermiş olması
         mümkün; kontenjan rezervasyonuyla aynı transaction'da tekrar sorulur.
         Kontenjanın aksine tek ifadeye sığmıyor (sayım campaign_uses'ta, artış
         campaigns'te), yani aynı anda gelen iki istek teorik olarak ikisi de
         geçebilir — hakkı bir fazla kullanmak, siparişi kaybetmekten iyidir. */
      const kampanya = await tx.prepare("SELECT id, per_customer_limit FROM campaigns WHERE id = ?").get(c.id);
      if (kampanya && await perCustomerLimitReached(kampanya, kimlik, tx)) continue;
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
      customer.name.trim(), customerEmail, customer.phone.trim(), customer.address.trim(), customer.city?.trim() || null
    );

    const taxAmount = 0;
    const grandTotal = uygulananNet;
    const shippingMethod = grandTotal >= FREE_SHIPPING_THRESHOLD ? "free" : "recipient_paid";
    // Compose the structured address (mahalle / ilçe / il / posta kodu) into one line.
    const locality = [
      customer.neighborhood?.trim() && `${customer.neighborhood.trim()} Mah.`,
      [customer.district?.trim(), customer.city?.trim()].filter(Boolean).join("/"),
      customer.postal_code?.trim()
    ].filter(Boolean).join(" ");
    const shippingAddress = [customer.address.trim(), locality].filter(Boolean).join(" — ");
    const generatedNumber = `PRN-${Date.now().toString().slice(-8)}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    // PayTR merchant_oid yalnızca alfanümerik olmalı; ziyaretçiye gösterilen sipariş
    // numarasından ayrı ve tahmin edilmesi zor bir ödeme referansı kullanıyoruz.
    const paymentReference = `PAY${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`.toUpperCase();

    const order = await tx.prepare(`
      INSERT INTO orders (order_number, customer_id, status, payment_status, shipping_address, subtotal, discount, total, notes,
        invoice_type, tc_no, tax_office, tax_number, company_name, billing_address, payment_method,
        payment_provider, payment_reference, inventory_deducted,
        tax_rate, tax_amount, shipping_method, campaign_summary,
        ga_client_id, ga_session_id)
      VALUES (@order_number, @customer_id, 'new', 'pending', @shipping_address, @subtotal, @discount, @total, @notes,
        @invoice_type, @tc_no, @tax_office, @tax_number, @company_name, @billing_address, @payment_method,
        'paytr', @payment_reference, @inventory_deducted,
        @tax_rate, @tax_amount, @shipping_method, @campaign_summary,
        @ga_client_id, @ga_session_id)
    `).run({
      order_number: generatedNumber,
      payment_reference: paymentReference,
      /* Ölçüm kimlikleri BURADA yakalanmalı: bu istek müşterinin tarayıcısından
         geliyor, çerezler burada. Ödeme onayı PayTR'den sunucuya geliyor ve
         orada çerez yok. */
      ga_client_id: gaKimlikleri(req).clientId,
      ga_session_id: gaKimlikleri(req).sessionId,
      inventory_deducted: stokTakibi ? 1 : 0,
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
      invoice_type: null,
      tc_no: null,
      tax_office: null,
      tax_number: null,
      company_name: null,
      billing_address: shippingAddress,
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
        customer_email: customerEmail,
        discount_amount: Number(c.amount) || 0
      });
    }

    // Stok takibi açıksa satılan adet düşülür. Kapalıyken (varsayılan) stok
    // yalnızca bilgi amaçlı bir sayı olarak kalır.
    if (stokTakibi) {
      const dus = tx.prepare("UPDATE products SET stock = GREATEST(0, stock - ?) WHERE id = ?");
      for (const item of normalized.filter((row) => Number(row.line_total) > 0)) {
        await dus.run(item.quantity, item.product_id);
      }
    }

    return {
      id: order.lastInsertRowid,
      order_number: generatedNumber,
      payment_reference: paymentReference,
      shipping_address: shippingAddress,
      shipping_method: shippingMethod,
      total: grandTotal
    };
  });

  const statusToken = paymentStatusToken(pendingOrder.payment_reference);
  let siteOrigin;
  try {
    siteOrigin = new URL(magaza.site_url || `${req.protocol}://${req.get("host")}`).origin;
  } catch {
    siteOrigin = `${req.protocol}://${req.get("host")}`;
  }

  try {
    const iframeUrl = await requestPaytrIframe({
      req,
      order: pendingOrder,
      customer: {
        name: customer.name.trim(),
        email: customerEmail,
        phone: customer.phone.trim()
      },
      items: normalized,
      origin: siteOrigin,
      statusToken
    });
    return res.status(201).json({
      order_number: pendingOrder.order_number,
      iframe_url: iframeUrl,
      shipping_method: pendingOrder.shipping_method,
      total: pendingOrder.total
    });
  } catch (error) {
    console.error(`PayTR iframe tokenı alınamadı (${pendingOrder.order_number}):`, error.message);
    await markPendingPaymentFailed(pendingOrder.payment_reference, "token_error", error.message);
    return res.status(502).json({ error: "Güvenli ödeme ekranı şu anda açılamadı. Lütfen biraz sonra tekrar deneyin." });
  }
});

/* PayTR Bildirim URL'si: Mağaza Paneli'nde tam olarak
   https://www.printable.com.tr/api/paytr/callback tanımlanmalı. Başarı/fail dönüş
   sayfaları bilgilendirme içindir; ödeme durumunu yalnızca bu imzalı POST değiştirir. */
app.post("/api/paytr/callback", async (req, res) => {
  if (!PAYTR_CONFIGURED) {
    return res.status(503).type("text/plain").send("PAYTR notification failed");
  }

  const reference = String(req.body.merchant_oid || "");
  const status = String(req.body.status || "");
  const totalAmount = String(req.body.total_amount || "");
  const receivedHash = String(req.body.hash || "");
  if (!/^[A-Za-z0-9]{1,64}$/.test(reference) || !["success", "failed"].includes(status) || !/^\d+$/.test(totalAmount)) {
    return res.status(400).type("text/plain").send("PAYTR notification failed");
  }

  const expectedHash = paytrHmac(`${reference}${PAYTR_MERCHANT_SALT}${status}${totalAmount}`);
  if (!safeTextEqual(receivedHash, expectedHash)) {
    console.error(`PayTR callback imzası geçersiz: ${reference}`);
    return res.status(400).type("text/plain").send("PAYTR notification failed");
  }

  let paidOrderId = null;
  try {
    const result = await db.transaction(async (tx) => {
      const order = await tx.prepare("SELECT * FROM orders WHERE payment_reference = ? FOR UPDATE").get(reference);
      if (!order) return { missing: true };
      // PayTR aynı bildirimi tekrar gönderebilir. İlk kesin sonuçtan sonra yalnızca OK dön.
      if (order.payment_status !== "pending") return { duplicate: true };

      if (status === "failed") {
        await releaseOrderReservations(tx, order);
        await tx.prepare(`
          UPDATE orders SET payment_status = 'failed', payment_failure_code = ?,
            payment_failure_message = ?, payment_test_mode = ?, inventory_deducted = 0,
            updated_at = NOW()
          WHERE id = ?
        `).run(
          String(req.body.failed_reason_code || "payment_failed").slice(0, 50),
          String(req.body.failed_reason_msg || "Ödeme tamamlanamadı.").slice(0, 500),
          req.body.test_mode === "1" ? 1 : 0,
          order.id
        );
        return { failed: true };
      }

      const expectedCents = Math.round(Number(order.total) * 100);
      const collectedCents = Number.parseInt(totalAmount, 10);
      // total_amount imzanın parçasıdır; taksit vade farkıyla beklenenden yüksek
      // olabilir ama daha düşük bir tahsilatı sipariş ödemesi sayamayız.
      if (!Number.isSafeInteger(collectedCents) || collectedCents < expectedCents) {
        return { amountMismatch: true, expectedCents, collectedCents };
      }

      await tx.prepare(`
        UPDATE orders SET payment_status = 'paid', payment_collected_amount = ?,
          payment_test_mode = ?, paid_at = NOW(), payment_failure_code = NULL,
          payment_failure_message = NULL, updated_at = NOW()
        WHERE id = ?
      `).run(collectedCents, req.body.test_mode === "1" ? 1 : 0, order.id);
      return { paid: true, orderId: order.id };
    });

    if (result.missing) {
      console.error(`PayTR callback siparişi bulunamadı: ${reference}`);
      return res.status(404).type("text/plain").send("PAYTR notification failed");
    }
    if (result.amountMismatch) {
      console.error(`PayTR tutar uyuşmazlığı (${reference}): beklenen ${result.expectedCents}, gelen ${result.collectedCents}`);
      return res.status(400).type("text/plain").send("PAYTR notification failed");
    }
    if (result.paid) paidOrderId = result.orderId;
  } catch (error) {
    console.error(`PayTR callback işlenemedi (${reference}):`, error.message);
    return res.status(500).type("text/plain").send("PAYTR notification failed");
  }

  // Bildirimler ödeme onayından sonra gider; e-posta arızası ödeme kaydını bozmaz.
  if (paidOrderId) await notifyPaidOrder(paidOrderId).catch((error) => {
    console.error(`Ödenen sipariş bildirimi gönderilemedi (${reference}):`, error.message);
  });
  /* Ölçüm de aynı mantıkla: PayTR'ye "OK" dönmeyi hiçbir koşulda engellemez.
     Burada hata fırlatırsak PayTR bildirimi başarısız sayıp tekrar dener. */
  if (paidOrderId) await gaSatinAlmaBildir(paidOrderId).catch((error) => {
    console.error(`GA4 satın alma olayı gönderilemedi (${reference}):`, error.message);
  });
  return res.type("text/plain").send("OK");
});

// Başarı/fail yönlendirme sayfası callback'ten bağımsızdır. Tarayıcı yalnızca
// kendisine verilen HMAC'li kısa tokenla bu siparişin ödeme durumunu okuyabilir.
app.get("/api/paytr/status", async (req, res) => {
  const reference = String(req.query.ref || "");
  const token = String(req.query.token || "");
  if (!/^[A-Za-z0-9]{1,64}$/.test(reference) || !safeTextEqual(token, paymentStatusToken(reference))) {
    return res.status(404).json({ error: "Ödeme kaydı bulunamadı." });
  }
  const order = await db.prepare(`
    SELECT order_number, payment_status, payment_failure_message, shipping_method, total
    FROM orders WHERE payment_reference = ?
  `).get(reference);
  if (!order) return res.status(404).json({ error: "Ödeme kaydı bulunamadı." });
  return res.json({
    order_number: order.order_number,
    payment_status: order.payment_status,
    failure_message: order.payment_status === "failed" ? order.payment_failure_message || "Ödeme tamamlanamadı." : "",
    shipping_method: order.shipping_method,
    /* Dönüşüm ölçümü için: reklam raporunda "kaç sipariş" değil "kaç liralık
       sipariş" görünsün. Müşterinin az önce ödediği tutar, referans+token
       doğrulandıktan sonra dönüyor. */
    total: order.total
  });
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
  const updated = await db.prepare("SELECT * FROM orders WHERE id = ?").get(current.id);
  const shippingStarted = (current.status !== "shipped" && updated.status === "shipped") ||
    (!current.tracking_code && updated.tracking_code);
  if (shippingStarted) {
    const customer = await db.prepare("SELECT name, email FROM customers WHERE id = ?").get(updated.customer_id);
    if (customer?.email) {
      const sent = await sendShippingUpdateEmail({
        to: customer.email,
        name: customer.name,
        orderNumber: updated.order_number,
        trackingCode: updated.tracking_code
      }).catch(() => false);
      if (!sent) console.error(`Kargo e-postası gönderilemedi: ${updated.order_number}`);
    }
  }
  res.json(updated);
});

// Public site info — iletişim ve vitrin ayarları.
app.get("/api/site-info", async (req, res) => {
  const site = await db.prepare("SELECT phone, email, legal_address, working_hours, social_links, show_stock, min_cart_total FROM site_settings WHERE id = 1").get() || {};
  const { wa } = await contactInfo();
  res.json({
    tax_rate: KDV_RATE,
    phone: site.phone || "",
    email: site.email || "",
    whatsapp: wa ? `https://wa.me/${wa}` : "",
    address: site.legal_address || "",
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
  const contact = {
    name,
    email: req.body.email?.trim() || null,
    phone: req.body.phone?.trim() || null,
    subject: req.body.subject?.trim() || null,
    message
  };
  await db.prepare("INSERT INTO messages (name, email, phone, subject, message) VALUES (?,?,?,?,?)").run(
    contact.name,
    contact.email,
    contact.phone,
    contact.subject,
    contact.message
  );
  const ownerNotified = await notifyNewContactMessage(contact).catch((error) => {
    console.error("İletişim formu bildirimi gönderilemedi:", error.message);
    return false;
  });
  if (!ownerNotified) console.error("İletişim formu bildirimi gönderilemedi.");
  res.status(201).json({ ok: true, notification_sent: ownerNotified });
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

/* Eşleşmeyen adresler. Express'in varsayılanı İngilizce bir "Cannot GET /..."
   satırıydı: ziyaretçi sitenin tamamen çöktüğünü sanıp çıkıyordu. Kendi
   sayfamız gerçek 404 döner, başlık/footer'ı taşır ve nereye gidileceğini
   söyler. noindex — kırık adresler dizine girmemeli.
   /api/ altı JSON döner; oradan HTML beklenmez. */
app.use(async (req, res, next) => {
  if (req.method !== "GET" || req.originalUrl.startsWith("/api/")) return next();
  try {
    const site = await db.prepare("SELECT site_name FROM site_settings WHERE id = 1").get() || {};
    const head = [
      `<title>Sayfa bulunamadı | ${escapeHtml(site.site_name || "Printable")}</title>`,
      FAVICON_TAGS,
      `<meta name="robots" content="noindex,follow">`
    ].join("\n    ");
    const html = fs.readFileSync(path.join(ROOT, "404.html"), "utf8");
    res.status(404).type("html").send(
      await injectShell(html.replace("<!--seo-->", head), "", await pageCustomer(req, res))
    );
  } catch (error) { next(error); }
});

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

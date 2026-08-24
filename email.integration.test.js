const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "printable-email-test-"));
process.env.PGLITE_DATA_DIR = testDataDir;
process.env.DATABASE_URL = "";
process.env.RESEND_API_KEY = "re_test_key";
process.env.MAIL_FROM = "Printable Test <noreply@printable.com.tr>";
process.env.STORE_NOTIFICATION_EMAILS = "operations@example.com";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.PAYTR_MERCHANT_ID = "123456";
process.env.PAYTR_MERCHANT_KEY = "TESTKEY";
process.env.PAYTR_MERCHANT_SALT = "TESTSALT";
process.env.PAYTR_TEST_MODE = "1";
process.env.SESSION_SECRET = "email-test-session-secret-that-is-long";
process.env.ADMIN_PASSWORD = "email-test-admin-password";

const realFetch = global.fetch;
const resendRequests = [];
let resendMode = "success";

global.fetch = async (url, options = {}) => {
  if (String(url) === "https://api.resend.com/emails") {
    resendRequests.push(JSON.parse(String(options.body || "{}")));
    return new Response(JSON.stringify({ id: "email-test-id" }), {
      status: resendMode === "success" ? 200 : 503,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (String(url) === "https://www.paytr.com/odeme/api/get-token") {
    const form = new URLSearchParams(String(options.body || ""));
    return new Response(JSON.stringify({
      status: "success",
      token: `FAKE${form.get("merchant_oid")}`
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, options);
};

const app = require("./server.js");
const db = require("./db.js");
const keychainProducts = require("./anahtarlik-katalog.js");
const productTemplates = require("./product-templates.js");
let server;
let baseUrl;

async function request(url, options = {}) {
  const response = await realFetch(`${baseUrl}${url}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const storeMessage = (prefix) => resendRequests.find((entry) => String(entry.subject).startsWith(prefix));

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test("Kademeli ürün kampanyası yalnızca bir kez uygulanır", async () => {
  // İlk istek şema/seed kurulumunu ve tek seferlik fiyat revizyonlarını çalıştırır.
  const { response } = await request("/api/products");
  assert.equal(response.status, 200);

  const special = await db.prepare("SELECT id, price, sale_price FROM products WHERE sku = 'PR-3D-001'").get();
  const deal = await db.prepare("SELECT price, sale_price FROM products WHERE sku = 'PR-3D-002'").get();
  const history = await db.prepare(`
    SELECT COUNT(*)::int count, MIN(price) min_price, MAX(price) max_price
    FROM price_history WHERE product_id = ?
  `).get(special.id);
  const revision = await db.prepare("SELECT value FROM app_meta WHERE key = 'products_price_rev'").get();
  const campaignRevision = await db.prepare("SELECT value FROM app_meta WHERE key = 'product_campaign_rev'").get();

  assert.deepEqual(special, { id: special.id, price: 143.28, sale_price: 128.95 });
  assert.deepEqual(deal, { price: 215.28, sale_price: 172.22 });
  assert.deepEqual(history, { count: 2, min_price: 119.4, max_price: 143.28 });
  assert.equal(revision.value, "2026-08-tum-urunler-yuzde-40-indirim");
  assert.equal(campaignRevision.value, "2026-08-normal-arti20-kademeli-indirim");

  const secondRequest = await request("/api/products");
  assert.equal(secondRequest.response.status, 200);
  const unchanged = await db.prepare("SELECT price, sale_price FROM products WHERE sku = 'PR-3D-001'").get();
  assert.deepEqual(unchanged, { price: 143.28, sale_price: 128.95 });
});

test("Yüzde 20 ve yüzde 10 indirimleri ayrı etiketlenir, yüzde 5 etiketsiz kalır", () => {
  const fixture = (salePrice) => ({
    id: 999,
    name: "Kampanya Test Ürünü",
    price: 100,
    sale_price: salePrice,
    stock: 10,
    image_path: "/assets/printable-logo.svg",
    colors: [],
    scales: []
  });

  const dealHTML = productTemplates.productCardHTML(fixture(80));
  const specialHTML = productTemplates.productCardHTML(fixture(90));
  const generalHTML = productTemplates.productCardHTML(fixture(95));

  assert.match(dealHTML, /campaign-badge--deal/);
  assert.match(dealHTML, /Fırsat · %20/);
  assert.match(specialHTML, /campaign-badge--special/);
  assert.match(specialHTML, /Özel İndirim · %10/);
  assert.match(generalHTML, /<s>/);
  assert.doesNotMatch(generalHTML, /campaign-badge|Fırsat|Özel İndirim/);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  global.fetch = realFetch;
  const resolved = path.resolve(testDataDir);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("printable-email-test-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("İletişim formu info adresine bildirim gönderir", async () => {
  const { response, payload } = await request("/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "İletişim Testi",
      email: "iletisim@example.com",
      phone: "05550000001",
      subject: "Ürün sorusu",
      message: "Spinball hakkında bilgi almak istiyorum."
    })
  });

  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.notification_sent, true);
  const email = storeMessage("Yeni iletişim mesajı");
  assert.ok(email);
  assert.deepEqual(email.to, ["info@printable.com.tr", "operations@example.com"]);
  assert.match(email.html, /Spinball hakkında bilgi almak istiyorum/);
  const row = await db.prepare("SELECT * FROM messages WHERE email = ?").get("iletisim@example.com");
  assert.equal(row.subject, "Ürün sorusu");
});

test("Özel parça tasarım talebi panel kaydı ve mağaza e-postası oluşturur", async () => {
  const { response, payload } = await request("/api/design-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Tasarım Testi",
      email: "tasarim@example.com",
      phone: "05550000002",
      message: "Kırılan kahve makinesi kapağını yeniden çizdirmek istiyorum."
    })
  });

  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.notification_sent, true);
  const email = storeMessage("Yeni özel parça tasarım talebi");
  assert.ok(email);
  assert.deepEqual(email.to, ["info@printable.com.tr", "operations@example.com"]);
  assert.match(email.html, /Kırılan kahve makinesi kapağını/);
  const row = await db.prepare("SELECT * FROM messages WHERE email = ?").get("tasarim@example.com");
  assert.equal(row.subject, "Özel parça tasarım talebi");
});

test("Toplu anahtarlık talebi adet kurallarını uygular, panele ve e-postaya düşer", async () => {
  const page = await realFetch(`${baseUrl}/anahtarlik-katalogu`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /href="\/anahtarlik-katalogu"[^>]*>Toptan Anahtarlık</);
  assert.match(html, /Her modelden en az <strong>5 adet<\/strong>/);
  assert.match(html, /Sipariş toplamı en az <strong>50 adet<\/strong>/);
  assert.doesNotMatch(html, /Excel'e Aktar|Excel dosyası/i);
  assert.match(html, /name="first_name"[^>]*required/);
  assert.match(html, /name="last_name"[^>]*required/);
  assert.match(html, /name="phone"[^>]*required/);
  assert.match(html, /name="email"[^>]*required/);

  const tooFewPerModel = await request("/api/keychain-bulk-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      first_name: "Toplu", last_name: "Test", phone: "05550000003", email: "toplu@example.com",
      items: [{ id: keychainProducts[0].id, quantity: 4 }]
    })
  });
  assert.equal(tooFewPerModel.response.status, 400);

  const belowTotal = await request("/api/keychain-bulk-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      first_name: "Toplu", last_name: "Test", phone: "05550000003", email: "toplu@example.com",
      items: keychainProducts.slice(0, 9).map((product) => ({ id: product.id, quantity: 5 }))
    })
  });
  assert.equal(belowTotal.response.status, 400);

  const items = keychainProducts.slice(0, 10).map((product) => ({ id: product.id, quantity: 5 }));
  const valid = await request("/api/keychain-bulk-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      first_name: "Toplu", last_name: "Müşteri", phone: "05550000003", email: "toplu@example.com", items
    })
  });
  assert.equal(valid.response.status, 201);
  assert.equal(valid.payload.total_quantity, 50);
  assert.equal(valid.payload.notification_sent, true);

  const email = storeMessage("Yeni toplu anahtarlık talebi");
  assert.ok(email);
  assert.deepEqual(email.to, ["info@printable.com.tr", "operations@example.com"]);
  assert.match(email.html, /Toplu Müşteri/);
  assert.match(email.html, new RegExp(keychainProducts[0].name));
  assert.match(email.html, /toplam 50 adet/i);
  const row = await db.prepare("SELECT * FROM messages WHERE email = ? AND subject = ?").get(
    "toplu@example.com", "Toplu anahtarlık sipariş talebi"
  );
  assert.ok(row);
  assert.match(row.message, /toplam 50 adet/i);
  assert.match(row.message, /5 adet/);
});

test("İletişim sayfası taslak metin göstermeden sunucuda hazırlanır", async () => {
  const response = await realFetch(`${baseUrl}/iletisim`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /eklenecek/i);
  assert.doesNotMatch(html, /data-contact=/i);
  assert.match(html, /href="tel:/i);
  assert.match(html, /WhatsApp'tan mesaj gönderin/);
});

test("Özel tasarım sayfası WhatsApp iletişimini açılışta vurgular", async () => {
  const response = await realFetch(`${baseUrl}/tasarim`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /class="design-whatsapp-cta"/);
  assert.match(html, /WhatsApp'tan İletişime Geç/);
  assert.match(html, /https:\/\/wa\.me\/\d+\?text=/);
  assert.doesNotMatch(html, /<!--design-whatsapp-->/);
});

test("Ana sayfa Spinball ve Katlaç için 10, 50, 100 adetlik sepet alanını içerir", async () => {
  const homeResponse = await realFetch(`${baseUrl}/`);
  const home = await homeResponse.text();
  const scriptResponse = await realFetch(`${baseUrl}/script.js`);
  const storefrontScript = await scriptResponse.text();
  assert.equal(homeResponse.status, 200);
  assert.match(home, /class="hero"/);
  assert.doesNotMatch(home, /class="landing-hero"/);
  assert.match(home, /id="bulk-commerce"/);
  assert.match(storefrontScript, /BULK_QUANTITIES = \[10, 50, 100\]/);
  assert.match(storefrontScript, /Toplu satış/);
  assert.match(storefrontScript, /data-bulk-quantity/);
  assert.match(storefrontScript, /addToCart\(product, bulkQuantity, scale\)/);
});

test("Genel landing sayfası tüm mağazayı anlatır ve Katlaç ile Spinball'u içerir", async () => {
  const response = await realFetch(`${baseUrl}/landing`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /class="product-commerce-hero"/);
  assert.match(html, /id="landing-product-stage"/);
  assert.match(html, /id="landing-feature-products"/);
  assert.match(html, /Tüm ürünleri keşfet/);
  assert.match(html, /Dosyanı yükle, fiyat al/);
  assert.match(html, /id="category-grid"/);
  assert.match(html, /id="sale-section"/);
  assert.match(html, /Katlaç[\s\S]*Spinball/);
  assert.match(html, /\/assets\/shopier\/21\.jpg/);
  assert.match(html, /\/assets\/shopier\/22\.jpg/);
  assert.match(html, /\/assets\/shopier\/35\.jpg/);
  assert.match(html, /\/assets\/shopier\/53\.jpg/);
  assert.match(html, /\/assets\/shopier\/39\.jpg/);
  assert.match(html, /href="\/urun\/53"/);
  assert.match(html, /href="\/urun\/39"/);
  assert.match(html, /id="bulk-commerce"/);
  assert.match(html, /10, 50 ve 100 adet/);
});

test("Eski Katlaç ve Spinball landing adresi genel landing sayfasına yönlenir", async () => {
  const response = await fetch(`${baseUrl}/katlac-spinball`, { redirect: "manual" });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "/landing");
});

test("3D teklif formu özet e-postasını info adresine gönderir", async () => {
  const material = await db.prepare("SELECT id FROM materials WHERE is_active = 1 ORDER BY id LIMIT 1").get();
  const color = await db.prepare("SELECT id FROM colors WHERE is_active = 1 ORDER BY id LIMIT 1").get();
  const form = new FormData();
  form.set("customer_name", "Teklif Testi");
  form.set("email", "teklif@example.com");
  form.set("phone", "05550000002");
  form.set("note", "İki adet üretim için dönüş bekliyorum.");
  form.set("model_name", "test-model.stl");
  form.set("width", "40");
  form.set("height", "50");
  form.set("depth", "60");
  form.set("max_dim_mm", "60");
  form.set("volume_cm3", "25");
  form.set("material_id", String(material.id));
  form.set("infill", "30");
  form.set("quantity", "2");
  form.set("parts", JSON.stringify([{ name: "Gövde", volume_cm3: 25, color_id: color.id }]));

  const { response, payload } = await request("/api/quotes", { method: "POST", body: form });
  assert.equal(response.status, 201);
  assert.match(payload.quote_number, /^TKF-/);
  assert.equal(payload.notification_sent, true);
  const email = storeMessage("Yeni 3D baskı teklifi");
  assert.ok(email);
  assert.ok(email.to.includes("info@printable.com.tr"));
  assert.match(email.html, /test-model\.stl/);
  assert.match(email.html, /İki adet üretim için dönüş bekliyorum/);
});

test("Ödenen sipariş info adresine mağaza bildirimi gönderir", async () => {
  const products = await realFetch(`${baseUrl}/api/products`).then((response) => response.json());
  const product = products.find((item) => Number(item.is_active) === 1);
  assert.ok(product);
  const { response, payload } = await request("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: {
        name: "Sipariş Testi",
        phone: "05550000003",
        email: "siparis@example.com",
        city: "İstanbul",
        district: "Kağıthane",
        neighborhood: "Emniyetevleri",
        postal_code: "34415",
        address: "Test Sokak No: 1"
      },
      payment_method: "kart",
      items: [{ product_id: product.id, quantity: 1 }]
    })
  });
  assert.equal(response.status, 201);

  const reference = new URL(payload.iframe_url).pathname.split("/").pop().replace(/^FAKE/, "");
  const cents = Math.round(Number(payload.total) * 100);
  const callbackBody = new URLSearchParams({
    merchant_oid: reference,
    status: "success",
    total_amount: String(cents),
    hash: crypto.createHmac("sha256", "TESTKEY").update(`${reference}TESTSALTsuccess${cents}`).digest("base64")
  });
  const callback = await realFetch(`${baseUrl}/api/paytr/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: callbackBody
  });
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), "OK");

  const email = storeMessage("Yeni sipariş");
  assert.ok(email);
  assert.ok(email.to.includes("info@printable.com.tr"));
  assert.match(email.html, /Sipariş Testi/);
});

test("E-posta servisi hata verse de iletişim mesajı kaydedilir", async () => {
  resendMode = "failure";
  const { response, payload } = await request("/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Kayıt Testi", email: "kayit@example.com", message: "Bu mesaj kaybolmamalı." })
  });
  resendMode = "success";

  assert.equal(response.status, 201);
  assert.equal(payload.ok, true);
  assert.equal(payload.notification_sent, false);
  const row = await db.prepare("SELECT message FROM messages WHERE email = ?").get("kayit@example.com");
  assert.equal(row.message, "Bu mesaj kaybolmamalı.");
});

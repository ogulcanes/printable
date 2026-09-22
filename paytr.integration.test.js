const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const keychainCatalog = require("./anahtarlik-katalog.js");
const lighterCatalog = require("./cakmaklik-katalog.js");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "printable-paytr-test-"));
process.env.PGLITE_DATA_DIR = testDataDir;
process.env.DATABASE_URL = "";
process.env.RESEND_API_KEY = "";
process.env.STORE_NOTIFICATION_EMAILS = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.PAYTR_MERCHANT_ID = "123456";
process.env.PAYTR_MERCHANT_KEY = "TESTKEY";
process.env.PAYTR_MERCHANT_SALT = "TESTSALT";
process.env.PAYTR_TEST_MODE = "1";
process.env.SESSION_SECRET = "test-session-secret-that-is-long";
process.env.ADMIN_USER = "paytrtest";
process.env.ADMIN_PASSWORD = "test-admin-password";

const realFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url) === "https://www.paytr.com/odeme/api/get-token") {
    const form = new URLSearchParams(String(options?.body || ""));
    return new Response(JSON.stringify({
      status: "success",
      token: `FAKE${form.get("merchant_oid")}`
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, options);
};

const app = require("./server.js");
const db = require("./db.js");
let server;
let baseUrl;
let adminCookie;

const hmacBase64 = (text) => crypto.createHmac("sha256", "TESTKEY").update(text).digest("base64");
const statusToken = (reference) => crypto
  .createHmac("sha256", "test-session-secret-that-is-long")
  .update(`paytr-status:${reference}`)
  .digest("hex");

async function jsonRequest(url, options) {
  const response = await realFetch(`${baseUrl}${url}`, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function callback(reference, status, totalAmount, extra = {}) {
  const body = new URLSearchParams({
    merchant_oid: reference,
    status,
    total_amount: String(totalAmount),
    hash: hmacBase64(`${reference}TESTSALT${status}${totalAmount}`),
    payment_type: "card",
    currency: "TL",
    payment_amount: String(totalAmount),
    test_mode: "1",
    ...extra
  });
  return realFetch(`${baseUrl}/api/paytr/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
}

async function newCheckout(quantity = 1, overrides = {}) {
  const products = await realFetch(`${baseUrl}/api/products`).then((response) => response.json());
  const product = products.find((item) => Number(item.is_active) === 1);
  assert.ok(product, "Test için aktif ürün bulunmalı");
  const { response, payload } = await jsonRequest("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: {
        name: "PayTR Test",
        phone: "05555555555",
        email: "paytr.test@example.com",
        city: "İstanbul",
        district: "Kağıthane",
        neighborhood: "Emniyetevleri",
        postal_code: "34415",
        address: "Test Sokak No: 1",
        ...(overrides.customer || {})
      },
      ...(overrides.invoice ? { invoice: overrides.invoice } : {}),
      payment_method: "kart",
      items: [{ product_id: product.id, quantity }]
    })
  });
  assert.equal(response.status, 201);
  assert.match(payload.iframe_url, /^https:\/\/www\.paytr\.com\/odeme\/guvenli\/FAKEPAY[A-Z0-9]+$/);
  return {
    ...payload,
    reference: new URL(payload.iframe_url).pathname.split("/").pop().replace(/^FAKE/, ""),
    cents: Math.round(Number(payload.total) * 100)
  };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const login = await realFetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "paytrtest", password: "test-admin-password" })
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  global.fetch = realFetch;
  const resolved = path.resolve(testDataDir);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("printable-paytr-test-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("Bülten aboneliği veritabanına tek kayıt yazar", async () => {
  const email = "newsletter.test@example.com";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { response, payload } = await jsonRequest("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    assert.equal(response.status, 201);
    assert.equal(payload.ok, true);
  }

  const row = await db.prepare("SELECT COUNT(*) AS total FROM subscribers WHERE email = ?").get(email);
  assert.equal(Number(row.total), 1);
});

test("Anahtarlık ve çakmaklık katalogları fiyat ve kampanyalarıyla mağazaya aktarılır", async () => {
  const products = await realFetch(`${baseUrl}/api/products`).then((response) => response.json());
  const bySku = new Map(products.map((product) => [product.sku, product]));
  const eskiSeedModelIds = new Set(["2532585", "2678811", "1634037", "2465337"]);

  for (const model of [...keychainCatalog, ...lighterCatalog]) {
    if (eskiSeedModelIds.has(model.id)) continue;
    assert.ok(bySku.has(`MW-${model.id}`), `${model.id} katalog modeli ürün olarak eklenmeli`);
  }

  const kampanyaOrnekleri = [];
  for (const [catalog, price, category] of [
    [keychainCatalog, 89.99, "Anahtarlıklar"],
    [lighterCatalog, 69.99, "Çakmaklıklar"]
  ]) {
    for (const slot of [0, 1, 2, 3]) {
      const index = catalog.findIndex((model, i) => i % 4 === slot && !eskiSeedModelIds.has(model.id));
      const product = bySku.get(`MW-${catalog[index].id}`);
      assert.ok(product, `${category} için ${slot}. kampanya grubu bulunmalı`);
      assert.equal(Number(product.price), price);
      assert.ok(product.categories.some((item) => item.name === category));
      if (slot < 3) {
        const discount = [5, 10, 15][slot];
        assert.equal(Number(product.sale_price), Math.round(price * (1 - discount / 100) * 100) / 100);
      } else {
        assert.equal(product.sale_price, null);
        assert.ok((product.promotions || []).some((campaign) => campaign.name.includes("4 Al 3 Öde")));
        kampanyaOrnekleri.push({ product, discount: price, category });
      }
    }
  }

  const campaigns = await realFetch(`${baseUrl}/api/campaigns`, {
    headers: { Cookie: adminCookie }
  }).then((response) => response.json());
  assert.ok(campaigns.some((campaign) => campaign.name === "Anahtarlıklarda 4 Al 3 Öde"));
  assert.ok(campaigns.some((campaign) => campaign.name === "Çakmaklıklarda 4 Al 3 Öde"));

  for (const { product, discount, category } of kampanyaOrnekleri) {
    const { payload } = await jsonRequest("/api/campaigns/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ product_id: product.id, quantity: 4 }] })
    });
    assert.equal(Number(payload.discount), discount, `${category} 4 al 3 öde indirimi bir ürün bedeli olmalı`);
    assert.ok(payload.applied.some((campaign) => campaign.name.includes("4 Al 3 Öde")));
  }

  const sample = kampanyaOrnekleri[0].product;
  const productsPage = await realFetch(`${baseUrl}/urunler`).then((response) => response.text());
  const productPage = await realFetch(`${baseUrl}/urun/${sample.id}`).then((response) => response.text());
  assert.match(productsPage, /4 AL 3 ÖDE/);
  assert.match(productPage, /4 AL 3 ÖDE/);
  assert.match(productPage, /bir ürün bedeli otomatik düşsün/);

  const homePage = await realFetch(`${baseUrl}/`).then((response) => response.text());
  assert.match(homePage, /class="campaign-showcase"/);
  assert.match(homePage, /4 AL/);
  assert.match(homePage, /3 ÖDE/);
  assert.match(homePage, /href="\/urunler\?kampanya=4al3"/);
  assert.match(homePage, /href="\/urunler\?indirim=1&amp;oran=15"/);
  assert.match(homePage, /campaign-showcase__products--bundle/);
  assert.match(homePage, /campaign-showcase__products--single/);
  assert.match(homePage, /campaign-showcase__products--all/);
  assert.ok((homePage.match(/data-campaign-product=/g) || []).length >= 5);
  const dragon = products.find((product) => product.sku === "PR-3D-017");
  assert.ok(dragon, "Işıklı Ejderha Figürü ürünü seed'de bulunmalı");
  assert.match(homePage, /class="dragon-spotlight"/);
  assert.match(homePage, /Alevi yak\./);
  assert.match(homePage, /Ejderhayı uyandır\./);
  assert.match(homePage, new RegExp(`data-add-product="${dragon.id}"`));
  assert.match(homePage, /isikli-ejderha-figuru-2\.png/);

  const bundlePage = await realFetch(`${baseUrl}/urunler?kampanya=4al3`).then((response) => response.text());
  const bundleOlmayan = products.find((product) => !(product.promotions || []).some((campaign) => campaign.name.includes("4 Al 3 Öde")));
  assert.match(bundlePage, /4 Al 3 Öde ✕/);
  assert.ok(bundlePage.includes(`href="/urun/${sample.id}"`));
  assert.ok(bundleOlmayan);
  assert.ok(!bundlePage.includes(`href="/urun/${bundleOlmayan.id}"`));

  const yuzdeOnBes = products.find((product) =>
    product.sale_price && Math.round((1 - Number(product.sale_price) / Number(product.price)) * 100) === 15
  );
  assert.ok(yuzdeOnBes, "%15 indirimli örnek ürün bulunmalı");
  const discountPage = await realFetch(`${baseUrl}/urunler?indirim=1&oran=15`).then((response) => response.text());
  assert.match(discountPage, /%15 özel indirim ✕/);
  assert.ok(discountPage.includes(`href="/urun/${yuzdeOnBes.id}"`));
});

test("Bireysel siparişte KDV net fiyatın üzerine eklenir", async () => {
  const order = await newCheckout();
  const row = await db.prepare(`
    SELECT invoice_type, tc_no, tax_office, tax_number, company_name,
      billing_address, shipping_address, subtotal, discount, total, tax_rate, tax_amount
    FROM orders WHERE payment_reference = ?
  `).get(order.reference);

  assert.equal(row.invoice_type, "individual");
  assert.equal(row.tc_no, null);
  assert.equal(row.tax_office, null);
  assert.equal(row.tax_number, null);
  assert.equal(row.company_name, null);
  assert.equal(row.billing_address, row.shipping_address);
  assert.equal(Number(row.tax_rate), 20);
  const net = Math.round((Number(row.subtotal) - Number(row.discount)) * 100) / 100;
  const tax = Math.round(net * 20 / 100 * 100) / 100;
  assert.equal(Number(row.tax_amount), tax);
  assert.equal(Number(row.total), Math.round((net + tax) * 100) / 100);
});

test("Panelden değiştirilen KDV oranı checkout ve site bilgisine uygulanır", async () => {
  const current = await realFetch(`${baseUrl}/api/settings`, {
    headers: { Cookie: adminCookie }
  }).then((response) => response.json());

  const saveTaxRate = async (taxRate) => realFetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ ...current, tax_rate: taxRate })
  });

  const changed = await saveTaxRate(10);
  assert.equal(changed.status, 200);
  try {
    const info = await realFetch(`${baseUrl}/api/site-info`).then((response) => response.json());
    assert.equal(Number(info.tax_rate), 10);

    const order = await newCheckout();
    const row = await db.prepare(`
      SELECT subtotal, discount, total, tax_rate, tax_amount
      FROM orders WHERE payment_reference = ?
    `).get(order.reference);
    const net = Math.round((Number(row.subtotal) - Number(row.discount)) * 100) / 100;
    const tax = Math.round(net * 10 / 100 * 100) / 100;
    assert.equal(Number(row.tax_rate), 10);
    assert.equal(Number(row.tax_amount), tax);
    assert.equal(Number(row.total), Math.round((net + tax) * 100) / 100);
  } finally {
    const restored = await saveTaxRate(20);
    assert.equal(restored.status, 200);
  }
});

test("Kurumsal fatura bilgileri ve farklı fatura adresi siparişe kaydedilir", async () => {
  const order = await newCheckout(1, {
    invoice: {
      type: "corporate",
      company_name: "Örnek Baskı Ltd. Şti.",
      tax_office: "Kağıthane",
      tax_number: "1234567890",
      billing_address: "Fatura Mah. Vergi Cad. No: 20 Şişli/İstanbul"
    }
  });
  const row = await db.prepare(`
    SELECT invoice_type, company_name, tax_office, tax_number, billing_address, shipping_address
    FROM orders WHERE payment_reference = ?
  `).get(order.reference);

  assert.equal(row.invoice_type, "corporate");
  assert.equal(row.company_name, "Örnek Baskı Ltd. Şti.");
  assert.equal(row.tax_office, "Kağıthane");
  assert.equal(row.tax_number, "1234567890");
  assert.equal(row.billing_address, "Fatura Mah. Vergi Cad. No: 20 Şişli/İstanbul");
  assert.notEqual(row.billing_address, row.shipping_address);
});

test("100 adetlik toplu paket tek sepet satırı olarak siparişe dönüşür", async () => {
  const order = await newCheckout(100);
  const item = await db.prepare(`
    SELECT oi.quantity, oi.unit_price, oi.line_total
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.payment_reference = ?
  `).get(order.reference);
  assert.equal(Number(item.quantity), 100);
  assert.equal(Number(item.line_total), Number(item.unit_price) * 100);
});

test("PayTR başarı callback'i ödemeyi tek kez onaylar", async () => {
  const order = await newCheckout();
  const first = await callback(order.reference, "success", order.cents);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "OK");

  const duplicate = await callback(order.reference, "success", order.cents);
  assert.equal(duplicate.status, 200);
  assert.equal(await duplicate.text(), "OK");

  const { response, payload } = await jsonRequest(
    `/api/paytr/status?ref=${order.reference}&token=${statusToken(order.reference)}`
  );
  assert.equal(response.status, 200);
  assert.equal(payload.payment_status, "paid");
  assert.equal(payload.order_number, order.order_number);
});

test("PayTR başarısız callback'i siparişi failed yapar", async () => {
  const order = await newCheckout();
  const response = await callback(order.reference, "failed", order.cents, {
    failed_reason_code: "6",
    failed_reason_msg: "Müşteri ödeme yapmaktan vazgeçti."
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");

  const { payload } = await jsonRequest(
    `/api/paytr/status?ref=${order.reference}&token=${statusToken(order.reference)}`
  );
  assert.equal(payload.payment_status, "failed");
  assert.equal(payload.failure_message, "Müşteri ödeme yapmaktan vazgeçti.");
});

test("Geçersiz callback imzası ve düşük tahsilat reddedilir", async () => {
  const badHashOrder = await newCheckout();
  const badHash = await realFetch(`${baseUrl}/api/paytr/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      merchant_oid: badHashOrder.reference,
      status: "success",
      total_amount: String(badHashOrder.cents),
      hash: "gecersiz"
    })
  });
  assert.equal(badHash.status, 400);

  const lowAmount = await callback(badHashOrder.reference, "success", badHashOrder.cents - 1);
  assert.equal(lowAmount.status, 400);

  const cleanup = await callback(badHashOrder.reference, "failed", badHashOrder.cents, {
    failed_reason_code: "test_cleanup",
    failed_reason_msg: "Test temizliği"
  });
  assert.equal(cleanup.status, 200);
});

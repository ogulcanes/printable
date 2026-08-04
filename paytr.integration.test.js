const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

async function newCheckout(quantity = 1) {
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
        address: "Test Sokak No: 1"
      },
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

test("Sipariş fatura veya kimlik bilgisi olmadan oluşturulur", async () => {
  const order = await newCheckout();
  const row = await db.prepare(`
    SELECT invoice_type, tc_no, tax_office, tax_number, company_name,
      billing_address, shipping_address, subtotal, discount, total, tax_rate, tax_amount
    FROM orders WHERE payment_reference = ?
  `).get(order.reference);

  assert.equal(row.invoice_type, null);
  assert.equal(row.tc_no, null);
  assert.equal(row.tax_office, null);
  assert.equal(row.tax_number, null);
  assert.equal(row.company_name, null);
  assert.equal(row.billing_address, row.shipping_address);
  assert.equal(Number(row.tax_rate), 0);
  assert.equal(Number(row.tax_amount), 0);
  assert.equal(Number(row.total), Number(row.subtotal) - Number(row.discount));
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

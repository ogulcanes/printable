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

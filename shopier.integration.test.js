const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "printable-shopier-test-"));
process.env.PGLITE_DATA_DIR = testDataDir;
process.env.DATABASE_URL = "";
process.env.RESEND_API_KEY = "";
process.env.STORE_NOTIFICATION_EMAILS = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.PAYTR_MERCHANT_ID = "";
process.env.PAYTR_MERCHANT_KEY = "";
process.env.PAYTR_MERCHANT_SALT = "";
process.env.SESSION_SECRET = "shopier-test-session-secret-that-is-long";
process.env.ADMIN_USER = "shopiertest";
process.env.ADMIN_PASSWORD = "shopier-test-admin-password";
process.env.SHOPIER_API_KEY = "test-shopier-token";

const realFetch = global.fetch;
const shopierRequests = [];
let shopierMode = "success";
let nextShopierId = 100;

global.fetch = async (url, options = {}) => {
  if (String(url).startsWith("https://api.shopier.com/v1/products")) {
    const request = {
      url: String(url),
      method: options.method,
      authorization: options.headers?.Authorization,
      body: JSON.parse(String(options.body || "{}"))
    };
    shopierRequests.push(request);
    if (shopierMode === "fail") {
      return new Response(JSON.stringify({ message: "Geçici Shopier test hatası" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      });
    }
    const id = request.method === "POST"
      ? `shopier-${nextShopierId += 1}`
      : request.url.split("/").pop();
    return new Response(JSON.stringify({ id, url: `https://www.shopier.com/${id}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return realFetch(url, options);
};

const app = require("./server.js");
const db = require("./db.js");
const { buildProductPayload } = require("./shopier.js");
let server;
let baseUrl;
let cookie;

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  const response = await realFetch(`${baseUrl}${url}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function productForm(name, price = "129.99") {
  const form = new FormData();
  form.set("name", name);
  form.set("price", price);
  form.set("stock", "7");
  form.set("description", `${name} açıklaması`);
  form.set("image_url", "https://cdn.example.com/products/test-product.jpg");
  form.set("is_active", "1");
  return form;
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  const login = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "shopiertest", password: "shopier-test-admin-password" })
  });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get("set-cookie").split(";")[0];
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
  global.fetch = realFetch;
  const resolved = path.resolve(testDataDir);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("printable-shopier-test-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("Shopier yükü videoları ve desteklenmeyen görselleri dışarıda bırakır", () => {
  const payload = buildProductPayload({
    name: "Medya Test Ürünü",
    price: 100,
    stock: 2,
    image_path: "https://cdn.example.com/cover.png",
    images: [
      { media_type: "video", image_path: "https://cdn.example.com/demo.mp4" },
      { media_type: "image", image_path: "https://cdn.example.com/unsupported.webp" },
      { media_type: "image", image_path: "https://cdn.example.com/cover.png" },
      ...Array.from({ length: 6 }, (_, index) => ({
        media_type: "image",
        image_path: `https://cdn.example.com/gallery-${index + 1}.jpg`
      }))
    ]
  });
  assert.equal(payload.media.length, 5);
  assert.deepEqual(payload.media.map((item) => item.placement), [1, 2, 3, 4, 5]);
  assert.equal(payload.media.some((item) => /\.(?:mp4|webp)$/.test(item.url)), false);
});

test("Shopier uyumluluk görseli kullanılırken ürün bilgileri birebir korunur", () => {
  const payload = buildProductPayload({
    name: "Sarı Lacivert Katlaç",
    description: "Ürünün eksiksiz açıklaması",
    price: 349.9,
    sale_price: 299.9,
    stock: 18,
    image_path: "https://cdn.example.com/products/katlac.jpg",
    shopier_image_path: "https://www.printable.com.tr/assets/shopier/41.jpg"
  });
  assert.equal(payload.title, "Sarı Lacivert Katlaç");
  assert.equal(payload.description, "Ürünün eksiksiz açıklaması");
  assert.deepEqual(payload.priceData, {
    currency: "TRY",
    price: "349.90",
    discount: true,
    discountedPrice: "299.90"
  });
  assert.equal(payload.stockQuantity, 18);
  assert.equal(payload.media[0].url, "https://www.printable.com.tr/assets/shopier/41.jpg");
});

test("Yeni Printable ürünü Shopier'de bir kez oluşturulur", async () => {
  const before = shopierRequests.length;
  const { response, payload } = await request("/api/products", {
    method: "POST",
    body: productForm("Shopier Otomatik Ürün")
  });

  assert.equal(response.status, 201);
  assert.equal(payload.shopier_sync_status, "synced");
  assert.match(payload.shopier_product_id, /^shopier-/);
  assert.equal(shopierRequests.length, before + 1);

  const remote = shopierRequests.at(-1);
  assert.equal(remote.url, "https://api.shopier.com/v1/products");
  assert.equal(remote.method, "POST");
  assert.equal(remote.authorization, "Bearer test-shopier-token");
  assert.equal(remote.body.title, "Shopier Otomatik Ürün");
  assert.deepEqual(remote.body.priceData, { currency: "TRY", price: "129.99", discount: false });
  assert.equal(remote.body.shippingPayer, "buyerPays");
  assert.equal(remote.body.media[0].url, "https://cdn.example.com/products/test-product.jpg");

  const row = await db.prepare(`
    SELECT shopier_product_id, shopier_sync_status, shopier_sync_error FROM products WHERE id = ?
  `).get(payload.id);
  assert.equal(row.shopier_product_id, payload.shopier_product_id);
  assert.equal(row.shopier_sync_status, "synced");
  assert.equal(row.shopier_sync_error, null);

  const publicResponse = await realFetch(`${baseUrl}/api/products/${payload.id}`);
  const publicProduct = await publicResponse.json();
  assert.equal(publicResponse.status, 200);
  assert.equal("shopier_product_id" in publicProduct, false);
  assert.equal("shopier_sync_error" in publicProduct, false);
});

test("Ürün düzenlemesi yeni kayıt açmadan mevcut Shopier ürününü günceller", async () => {
  const created = await request("/api/products", {
    method: "POST",
    body: productForm("Shopier Güncellenecek Ürün", "199.90")
  });
  const remoteId = created.payload.shopier_product_id;

  const { response, payload } = await request(`/api/products/${created.payload.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ price: 249.5, sale_price: 219.5, stock: 4 })
  });

  assert.equal(response.status, 200);
  assert.equal(payload.shopier_product_id, remoteId);
  const remote = shopierRequests.at(-1);
  assert.equal(remote.url, `https://api.shopier.com/v1/products/${remoteId}`);
  assert.equal(remote.method, "PUT");
  assert.deepEqual(remote.body.priceData, { price: "249.50", discount: true, discountedPrice: "219.50" });
  assert.equal(remote.body.stockQuantity, 4);
});

test("Shopier hatası Printable ürününü kaybettirmez ve panelden yeniden denenebilir", async () => {
  shopierMode = "fail";
  const created = await request("/api/products", {
    method: "POST",
    body: productForm("Shopier Yeniden Deneme Ürünü")
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.shopier_sync_status, "failed");
  assert.match(created.payload.shopier_sync_error, /Geçici Shopier test hatası/);

  shopierMode = "success";
  const retried = await request(`/api/products/${created.payload.id}/shopier-sync`, { method: "POST" });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.payload.shopier_sync_status, "synced");
  assert.match(retried.payload.shopier_product_id, /^shopier-/);
});

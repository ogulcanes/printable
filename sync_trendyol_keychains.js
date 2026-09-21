const products = require("./anahtarlik-katalog.js");

async function main() {
const apiKey = process.env.TRENDYOL_API_KEY;
const apiSecret = process.env.TRENDYOL_API_SECRET;
const sellerId = process.env.TRENDYOL_SELLER_ID;
if (!apiKey || !apiSecret || !sellerId) throw new Error("Trendyol erişim bilgileri ortam değişkenlerinde bulunamadı.");

const blocked = /(hello kitty|light fury|mandalorian|minecraft|charizard|moxxie|pok[eé]ball|toothless|ender ejderha|charmander|psyduck|sylvester|nike|air jordan|tweety|repo robot|dünya kupası|pikachu|stitch|garfield|ghostface|mickey|minnie|iron man|tom esnek|minion|venom|batman|spider-man|cristiano|cr7|finn|olaf|bob the minion|hulk|darwin watterson|harry potter|gumball|sakura)/i;
const allowed = products.filter((product) => !blocked.test(`${product.name} ${product.note} ${product.url}`));
const toAbsoluteImage = (image) => `https://www.printable.com.tr${image}`;
const cleanDescription = (product) =>
  `PLA plastik malzemeden üretilen ${product.name}. ${product.note}. Anahtar ve çanta aksesuarı olarak günlük kullanıma uygundur.`
    .replace(/koleksiyon/gi, "");

const items = allowed.map((product) => ({
  barcode: `PNT-KC-${product.id}`,
  title: `3D Baskı ${product.name} Anahtarlık`.slice(0, 100),
  description: cleanDescription(product),
  productMainId: `PNT-KC-${product.id}`,
  brandId: 1041874,
  categoryId: 2840,
  quantity: 20,
  stockCode: `PNT-KC-${product.id}`,
  origin: "TR",
  dimensionalWeight: 1,
  listPrice: 149.99,
  salePrice: 149.99,
  vatRate: 20,
  deliveryOption: { deliveryDuration: 1 },
  images: [{ url: toAbsoluteImage(product.img) }],
  attributes: [
    { attributeId: 47, customAttributeValue: "Çok Renkli" },
    { attributeId: 1192, attributeValueId: 10617344 },
    { attributeId: 348, attributeValueId: 686230 },
    { attributeId: 1186, attributeValueId: 10559446 },
  ],
}));

if (items.some((item) => /koleksiyon/i.test(item.title) || /koleksiyon/i.test(item.description))) {
  throw new Error("Açıklama veya başlıkta yasaklı ifade bulundu.");
}
if (items.some((item) => !/^https:\/\//.test(item.images[0]?.url))) throw new Error("HTTPS görsel adresi eksik.");

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ ready: items.length, omitted: products.length - items.length, firstItem: items[0] }, null, 2));
  process.exit(0);
}

const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
const endpoint = `https://apigw.trendyol.com/integration/product/sellers/${encodeURIComponent(sellerId)}/v2/products`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: { Authorization: authorization, "Content-Type": "application/json", "User-Agent": "PrintableTrendyolSync/1.0" },
  body: JSON.stringify({ items }),
});
const body = await response.json().catch(async () => ({ raw: await response.text() }));
if (!response.ok) throw new Error(`Trendyol ürün aktarımı başarısız (${response.status}): ${JSON.stringify(body)}`);
console.log(JSON.stringify({ status: response.status, result: body, submitted: items.length, omitted: products.length - items.length }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

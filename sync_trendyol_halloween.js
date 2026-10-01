require("dotenv").config({ path: ".env.local", quiet: true });

const apiKey = process.env.TRENDYOL_API_KEY;
const apiSecret = process.env.TRENDYOL_API_SECRET;
const sellerId = process.env.TRENDYOL_SELLER_ID;
if (!apiKey || !apiSecret || !sellerId) throw new Error("Trendyol erişim bilgileri .env.local içinde eksik.");

const imageBase = "https://raw.githubusercontent.com/ogulcanes/printable/mysql-migration/assets/products/halloween";
const common = {
  brandId: 1041874,
  quantity: 10,
  origin: "TR",
  dimensionalWeight: 1,
  vatRate: 20,
  deliveryOption: { deliveryDuration: 1 }
};
const attr = (attributeId, attributeValueId) => ({ attributeId, attributeValueId });
const custom = (attributeId, customAttributeValue) => ({ attributeId, customAttributeValue });
const commonAttributes = (webColor) => [
  attr(348, webColor),
  custom(47, "Çok Renkli"),
  attr(1192, 10617344),
  attr(18, 314396)
];
const products = [
  {
    barcode: "PNT-HLW-001", productMainId: "PNT-HLW-001", stockCode: "PNT-HLW-001",
    title: "3D Baskı Somurtkan Azrail Halloween Dekor Figürü",
    description: "Kapüşonlu Azrail tasarımlı 3D baskı masaüstü dekor figürü. Raf, çalışma masası ve hediye köşeleri için uygundur.",
    categoryId: 1877, price: 426.88, image: "somurtkan-azrail-figur.png",
    attributes: [...commonAttributes(686230), attr(14, 3989), attr(20, 170)]
  },
  {
    barcode: "PNT-HLW-002", productMainId: "PNT-HLW-002", stockCode: "PNT-HLW-002",
    title: "3D Baskı Zincirli Hayalet LED Mumluk Halloween Dekoru",
    description: "Zincir kaideli hayalet ve balkabağı tasarımlı 3D baskı LED mumluk. Sadece pilli LED tealight ile kullanılır; gerçek mum ve LED mum ürüne dahil değildir.",
    categoryId: 1882, price: 524.48, image: "zincirli-hayalet-led-mumluk.png",
    attributes: [...commonAttributes(686230), attr(14, 1227171)]
  },
  {
    barcode: "PNT-HLW-003", productMainId: "PNT-HLW-003", stockCode: "PNT-HLW-003",
    title: "3D Baskı Korku Yüzleri Halloween Şekerliği",
    description: "Kabartmalı korku yüzleriyle tasarlanmış 3D baskı Halloween şekerliği. Paketli şeker, küçük atıştırmalık ve dekoratif kullanım için uygundur; gıda ile doğrudan temas için tasarlanmamıştır.",
    categoryId: 4419, price: 609.88, image: "korku-yuzleri-sekerlik.png",
    attributes: [...commonAttributes(6999), attr(14, 3989)]
  },
  {
    barcode: "PNT-HLW-004", productMainId: "PNT-HLW-004", stockCode: "PNT-HLW-004",
    title: "3D Baskı Zincirli İkili LED Mumluk Halloween Dekoru",
    description: "İki pilli LED tealight için tasarlanmış zincir formlu 3D baskı mumluk. Sadece LED mumla kullanın; gerçek mum ve LED mum ürüne dahil değildir.",
    categoryId: 1882, price: 487.88, image: "zincirli-ikili-led-mumluk.png",
    attributes: [...commonAttributes(686230), attr(14, 1227171)]
  },
  {
    barcode: "PNT-HLW-005", productMainId: "PNT-HLW-005", stockCode: "PNT-HLW-005",
    title: "3D Baskı Hayalet LED Mum Standı Halloween Dekoru",
    description: "Hayalet silüetli 3D baskı LED mum standı. PLA malzeme nedeniyle yalnızca pilli LED mum veya LED ışıkla kullanılır; gerçek mum ve açık alev kullanılmamalıdır. LED mum ürüne dahil değildir.",
    categoryId: 1882, price: 524.48, image: "hayalet-mumluk.png",
    attributes: [...commonAttributes(6998), attr(14, 1227171)]
  }
].map((product) => ({
  ...common,
  ...product,
  listPrice: product.price,
  salePrice: product.price,
  images: [{ url: `${imageBase}/${product.image}` }]
}));

async function main() {
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify(products, null, 2));
    return;
  }
  const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const endpoint = `https://apigw.trendyol.com/integration/product/sellers/${encodeURIComponent(sellerId)}/v2/products`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json", "User-Agent": "PrintableTrendyolSync/1.0" },
    body: JSON.stringify({ items: products })
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) throw new Error(`Trendyol ürün aktarımı başarısız (${response.status}): ${JSON.stringify(body)}`);
  console.log(JSON.stringify({ status: response.status, submitted: products.length, result: body }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

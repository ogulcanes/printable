const SHOPIER_API_BASE = "https://api.shopier.com/v1";

class ShopierSyncError extends Error {
  constructor(message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = "ShopierSyncError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const apiKey = () => String(process.env.SHOPIER_API_KEY || "").trim();
const isConfigured = () => Boolean(apiKey());

function publicShopierImage(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return parsed.protocol === "https:" && /\.(?:jpe?g|png|bmp)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function productMedia(product) {
  const candidates = [
    product.image_path,
    ...(product.images || [])
      .filter((image) => image.media_type !== "video")
      .map((image) => image.image_path)
  ];
  return [...new Set(candidates.filter(publicShopierImage))]
    .slice(0, 5)
    .map((url, index) => ({ type: "image", url, placement: index + 1 }));
}

function effectivePrice(product) {
  const scalePrices = (product.scales || [])
    .map((scale) => Number(scale.price))
    .filter((price) => Number.isFinite(price) && price > 0);
  const listed = Number(product.price);
  const regular = Number.isFinite(listed) && listed > 0
    ? listed
    : Math.min(...scalePrices);
  if (!Number.isFinite(regular) || regular <= 0) {
    throw new ShopierSyncError("Shopier'e göndermek için ürünün satış fiyatı 0'dan büyük olmalıdır.");
  }
  const listedSale = Number(product.sale_price);
  const sale = Number.isFinite(listedSale) && listedSale > 0 && listedSale < regular
    ? listedSale
    : null;
  return { regular, sale };
}

function buildProductPayload(product, { update = false } = {}) {
  const title = String(product.name || "").trim();
  if (!title) throw new ShopierSyncError("Shopier'e göndermek için ürün adı zorunludur.");

  const media = productMedia(product);
  if (!media.length) {
    throw new ShopierSyncError(
      "Shopier'e göndermek için herkese açık JPG, JPEG, PNG veya BMP biçiminde en az bir ürün görseli gereklidir."
    );
  }

  const { regular, sale } = effectivePrice(product);
  const priceData = {
    ...(!update ? { currency: "TRY" } : {}),
    price: regular.toFixed(2),
    discount: Boolean(sale),
    ...(sale ? { discountedPrice: sale.toFixed(2) } : {})
  };

  return {
    title,
    description: String(product.description || "").trim(),
    type: "physical",
    media,
    priceData,
    stockQuantity: Math.max(0, Math.trunc(Number(product.stock) || 0)),
    shippingPayer: "buyerPays"
  };
}

function errorMessage(body, status) {
  if (body && typeof body === "object") {
    const direct = body.message || body.error || body.detail || body.title;
    if (typeof direct === "string" && direct.trim()) return direct.trim().slice(0, 900);
    if (body.errors) {
      const rendered = typeof body.errors === "string" ? body.errors : JSON.stringify(body.errors);
      if (rendered && rendered !== "{}") return rendered.slice(0, 900);
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 900);
  return `Shopier API isteği başarısız oldu (HTTP ${status}).`;
}

async function syncProduct(product) {
  const token = apiKey();
  if (!token) return { configured: false };

  const update = Boolean(product.shopier_product_id);
  const endpoint = update
    ? `${SHOPIER_API_BASE}/products/${encodeURIComponent(product.shopier_product_id)}`
    : `${SHOPIER_API_BASE}/products`;
  // Yerel doğrulama hataları bağlantı hatası gibi raporlanmasın.
  const payload = buildProductPayload(product, { update });
  const controller = new AbortController();
  const configuredTimeout = Number.parseInt(process.env.SHOPIER_TIMEOUT_MS || "10000", 10);
  const timeoutMs = Math.min(20000, Math.max(1000, configuredTimeout || 10000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await global.fetch(endpoint, {
      method: update ? "PUT" : "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ShopierSyncError("Shopier yanıt vermedi; ürün panelden yeniden gönderilebilir.");
    }
    throw new ShopierSyncError(`Shopier bağlantısı kurulamadı: ${error?.message || "Bilinmeyen bağlantı hatası"}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = text; }

  if (!response.ok) {
    throw new ShopierSyncError(errorMessage(body, response.status), {
      status: response.status,
      retryAfter: response.headers.get("retry-after")
    });
  }

  const data = body?.data || body?.product || body || {};
  const productId = String(data.id || product.shopier_product_id || "").trim();
  if (!productId) throw new ShopierSyncError("Shopier başarılı yanıt verdi ancak ürün kimliği dönmedi.");
  return {
    configured: true,
    productId,
    productUrl: typeof data.url === "string" ? data.url : (product.shopier_product_url || null)
  };
}

module.exports = {
  SHOPIER_API_BASE,
  ShopierSyncError,
  buildProductPayload,
  isConfigured,
  productMedia,
  syncProduct
};

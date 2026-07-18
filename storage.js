/* Dosya depolama katmanı.
 *
 * Vercel'de iki sorun var:
 *   1) Dosya sistemi kalıcı değil — diske yazılan her şey soğuk başlatmada gider.
 *   2) Bir isteğin gövdesi en fazla ~4.5 MB olabilir. Müşterinin yüklediği STL/3MF
 *      dosyaları 10-100 MB; yani dosya sunucudan GEÇEMEZ.
 *
 * Çözüm: tarayıcı dosyayı doğrudan Supabase Storage'a yükler. Sunucu yalnızca
 * imzalı bir yükleme adresi üretir (küçük bir JSON), dosyaya hiç dokunmaz.
 *
 * İki kova kullanılır:
 *   images → herkese açık okuma (ürün/banner/kategori görselleri)
 *   models → gizli; müşteri dosyaları IP'sidir, yalnızca imzalı adresle indirilir
 *
 * Supabase yapılandırılmamışsa (yerel geliştirme) her şey eskisi gibi diske yazılır.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const enabled = Boolean(SUPABASE_URL && SERVICE_KEY);

const BUCKETS = { image: "images", model: "models" };

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MODEL_EXT = /\.(stl|3mf)$/i;

let client;
function supabase() {
  if (!client) {
    const { createClient } = require("@supabase/supabase-js");
    // service_role anahtarı RLS'i aşar; yalnızca sunucuda kullanılır.
    client = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  }
  return client;
}

// Çakışmayan, tahmin edilemeyen bir yol. Orijinal ad korunur ama temizlenir:
// müşteri dosya adı doğrudan yola girerse dizin dışına çıkma riski olur.
function safeKey(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  const base = path.basename(originalName || "dosya", ext)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "dosya";
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${base}${ext}`;
}

const extensionAllowed = (kind, name) =>
  (kind === "image" ? IMAGE_EXT : MODEL_EXT).test(name || "");

/* Tarayıcının doğrudan yükleme yapabilmesi için imzalı adres üretir.
   Dönen `path` daha sonra forma konur; sunucu dosyayı asla görmez. */
async function createUploadUrl(kind, originalName) {
  const bucket = BUCKETS[kind];
  if (!bucket) throw new Error("Geçersiz yükleme türü.");
  if (!extensionAllowed(kind, originalName)) {
    throw new Error(kind === "image"
      ? "Yalnızca PNG, JPG, WEBP ve GIF görselleri yüklenebilir."
      : "Yalnızca .stl ve .3mf dosyaları yüklenebilir.");
  }

  const key = safeKey(originalName);
  const { data, error } = await supabase().storage.from(bucket).createSignedUploadUrl(key);
  if (error) throw new Error(`Yükleme adresi alınamadı: ${error.message}`);
  return { bucket, path: key, signedUrl: data.signedUrl, token: data.token };
}

// Görseller herkese açık kovada; kalıcı genel adresleri vardır.
const publicUrl = (key) =>
  `${SUPABASE_URL}/storage/v1/object/public/${BUCKETS.image}/${key}`;

/* Model dosyaları gizli kovada. Admin'in indirebilmesi için süreli imzalı adres.
   Süre kısa: adres paylaşılsa bile uzun ömürlü olmasın. */
async function signedModelUrl(key, seconds = 3600) {
  if (!enabled || !key) return null;
  const { data, error } = await supabase().storage.from(BUCKETS.model)
    .createSignedUrl(key, seconds);
  return error ? null : data.signedUrl;
}

async function remove(kind, key) {
  if (!enabled || !key) return;
  await supabase().storage.from(BUCKETS[kind]).remove([key]).catch(() => {});
}

module.exports = {
  enabled,
  BUCKETS,
  safeKey,
  extensionAllowed,
  createUploadUrl,
  publicUrl,
  signedModelUrl,
  remove
};

/* Ürün işaretlemesi — TEK KAYNAK.
 *
 * Bu dosya hem tarayıcıda (<script src>) hem Node'da (require) çalışır. Sebebi
 * şu: ürün kartı ve ürün detayı artık iki yerde üretiliyor — sunucu ilk HTML'i
 * basıyor, tarayıcı ise etkileşim sırasında (filtre, ölçek seçimi, renk seçimi)
 * aynı kutuyu yeniden basıyor. Şablonu iki dosyaya kopyalasaydık, biri
 * güncellenip diğeri unutulduğunda sayfa JS yüklenince gözle görülür şekilde
 * zıplardı ve arama motorunun gördüğü içerik kullanıcının gördüğünden farklı
 * olurdu. Aynı fonksiyon iki tarafta da çağrıldığı sürece bu mümkün değil.
 *
 * Kural: buradaki her fonksiyon SAF olmalı — DOM'a dokunmamalı, modül düzeyinde
 * durum tutmamalı. Seçili ölçek/renk gibi durum parametreyle gelir; sunucu
 * varsayılanları geçer, tarayıcı kendi durumunu.
 */
(function (kok) {
  "use strict";

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESC[char]);

  const money = (value) => `${Number(value || 0).toFixed(2)} TL`;

  /* Kişiselleştirilebilir ürün türleri tek kaynaktan okunur. Bu dosya hem Node'da
     hem tarayıcıda çalıştığı için ürün sayfasındaki alanlar, sepet özeti ve
     sunucudaki doğrulama aynı ad/etiketleri kullanır. */
  const PRODUCT_CUSTOMIZATION_SCHEMAS = Object.freeze({
    name_keychain: Object.freeze({
      label: "İsme özel anahtarlık",
      intro: "Anahtarlıkta yer alacak ismi yazın. Türkçe karakter kullanabilirsiniz.",
      paintKitIncluded: true,
      fields: Object.freeze([
        Object.freeze({ name: "custom_name", label: "Yazılacak isim", type: "text", required: true, maxLength: 30, placeholder: "Örn. Zeynep" }),
        Object.freeze({ name: "customer_note", label: "Ek not", type: "textarea", required: false, maxLength: 300, placeholder: "Varsa tasarımla ilgili kısa notunuzu yazın." })
      ])
    }),
    car_model: Object.freeze({
      label: "İstediğiniz araba modeli",
      intro: "İstediğiniz aracın marka ve modelini yazın; varsa referans fotoğrafını ekleyin.",
      paintKitIncluded: true,
      fields: Object.freeze([
        Object.freeze({ name: "car_model", label: "Araba marka ve modeli", type: "text", required: true, maxLength: 100, placeholder: "Örn. Honda Civic EK9" }),
        Object.freeze({ name: "reference_image", label: "Referans fotoğrafı", type: "file", required: false, accept: "image/png,image/jpeg,image/webp,image/gif" }),
        Object.freeze({ name: "customer_note", label: "Ek not", type: "textarea", required: false, maxLength: 500, placeholder: "Renk, jant veya özel detay gibi isteklerinizi yazın." })
      ])
    }),
    photo_3d_print: Object.freeze({
      label: "Size özel 3 boyutlu baskı",
      intro: "Tatlı bir 3D modele dönüştürmemiz için net bir referans fotoğrafı yükleyin.",
      paintKitIncluded: true,
      fields: Object.freeze([
        Object.freeze({ name: "reference_image", label: "Dönüştürülecek fotoğraf", type: "file", required: true, accept: "image/png,image/jpeg,image/webp,image/gif" }),
        Object.freeze({ name: "customer_note", label: "Nasıl görünmesini istersiniz?", type: "textarea", required: false, maxLength: 700, placeholder: "Poz, ifade, eklenecek yazı veya korunmasını istediğiniz ayrıntıları yazın." })
      ])
    })
  });

  const productCustomizationSchema = (typeOrProduct) => {
    const type = typeof typeOrProduct === "object" ? typeOrProduct?.customization_type : typeOrProduct;
    return PRODUCT_CUSTOMIZATION_SCHEMAS[type] || null;
  };

  const productIsMadeToOrder = (product) => Number(product?.is_made_to_order) === 1;
  const productIsAvailable = (product) => productIsMadeToOrder(product) || Number(product?.stock) > 0;

  function customizationSummary(customization) {
    const schema = productCustomizationSchema(customization?.type);
    if (!schema) return [];
    const values = customization.values || {};
    const files = customization.files || {};
    const rows = schema.fields.flatMap((field) => {
      const value = field.type === "file" ? files[field.name]?.name : values[field.name];
      return String(value || "").trim() ? [{ label: field.label, value: String(value).trim() }] : [];
    });
    if (customization.paint_kit_included !== false && schema.paintKitIncluded) {
      rows.push({ label: "Paket", value: "Akrilik boya ve mini fırça seti dahil" });
    }
    return rows;
  }

  const customizationFieldHTML = (field) => {
    const id = `custom-${field.name}`;
    const ortak = `id="${id}" name="${field.name}" data-custom-field="${field.name}"${field.required ? " data-required=\"1\"" : ""}`;
    if (field.type === "textarea") {
      return `<label for="${id}">${escapeHtml(field.label)}${field.required ? " *" : ""}
        <textarea ${ortak} rows="3" maxlength="${field.maxLength}" placeholder="${escapeHtml(field.placeholder || "")}"></textarea>
      </label>`;
    }
    if (field.type === "file") {
      return `<label for="${id}" class="product-customization__file">${escapeHtml(field.label)}${field.required ? " *" : ""}
        <input ${ortak} type="file" accept="${escapeHtml(field.accept || "image/*")}">
        <small data-custom-file-name="${field.name}">PNG, JPG, WEBP veya GIF · En fazla 8 MB</small>
      </label>`;
    }
    return `<label for="${id}">${escapeHtml(field.label)}${field.required ? " *" : ""}
      <input ${ortak} type="${field.type || "text"}" maxlength="${field.maxLength || 200}"
             ${field.pattern ? `pattern="${escapeHtml(field.pattern)}"` : ""} placeholder="${escapeHtml(field.placeholder || "")}">
    </label>`;
  };

  function productCustomizationHTML(product) {
    const schema = productCustomizationSchema(product);
    if (!schema) return "";
    return `<fieldset class="product-customization" id="product-customization-form">
      <legend>${escapeHtml(schema.label)}</legend>
      <p class="product-customization__intro">${escapeHtml(schema.intro)}</p>
      <div class="product-customization__fields">${schema.fields.map(customizationFieldHTML).join("")}</div>
      ${schema.paintKitIncluded ? `<p class="product-customization__kit"><strong>Boyama seti dahil</strong><span>Akrilik boyalar ve mini fırça ürünle birlikte gönderilir.</span></p>` : ""}
      <p class="product-customization__status" id="product-customization-status" role="status" hidden></p>
    </fieldset>`;
  }

  /* Görseli gösterileceği boyutta ister.
   *
   * Supabase Storage'ın dönüştürme uç noktası hem küçültüyor hem tarayıcı
   * destekliyorsa WebP veriyor: 1560 KB'lık bir banner 1600px'te 46 KB'a,
   * 204 KB'lık ürün fotoğrafı 500px'te 40 KB'a iniyor. Kartlar 250px
   * genişliğinde gösterilirken 1-2 MB'lık orijinali indirmenin anlamı yok.
   *
   * Supabase DIŞINDAKİ adresler olduğu gibi geçer — MakerWorld görselleri
   * üçüncü tarafta, onları biz dönüştüremiyoruz. */
  const gorselAdresi = (url, genislik) => {
    const u = String(url || "");
    /* GIF dönüştürülmez: Supabase'in render uç noktası tek kare döndürüyor,
       yani animasyonlu ürün önizlemesi donuyor. Boyut kazancından çok
       görünüm önemli. */
    if (/\.gif(\?|$)/i.test(u)) return u;
    if (!u.includes("/storage/v1/object/public/")) return u;
    const [yol, sorgu] = u.split("?");
    /* resize=contain ŞART. Uç noktanın varsayılanı "cover" ve yalnızca width
       verdiğimizde yüksekliği orijinalinden alıyor: 1080x810'luk ürün fotoğrafı
       width=500 ile 500x810 dönüyor — yani fotoğrafın ortasından dar bir dilim.
       Kartlarda yarısı kesilmiş ürünlerin sebebi buydu. contain ile oran
       korunuyor (500x375) ve kırpma kararını CSS veriyor. */
    return `${yol.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/")}?width=${genislik}&resize=contain&quality=78${sorgu ? "&" + sorgu : ""}`;
  };

  const productScales = (product) => (product && product.scales) || [];

  /* Karttaki fiyat: ölçekli üründe EN UCUZ ölçeğin fiyatı, ölçeksizde varsa
     indirimli fiyat. Ölçekli üründe sale_price uygulanmaz — sunucu da öyle
     hesaplıyor (normalizeCartItems). */
  const displayPrice = (product) => {
    const scales = productScales(product);
    return scales.length ? scales[0].price : (product.sale_price || product.price);
  };

  const discountPercent = (product) =>
    product.sale_price && product.price > product.sale_price
      ? Math.round((1 - product.sale_price / product.price) * 100)
      : 0;

  /* Kampanya etiketi yalnızca öne çıkarılan %10 ve %20 gruplarında görünür.
     Genel %5 indirimi fiyata yansır ama kartı etiket kalabalığına çevirmez. */
  const promotionBadge = (product) => {
    const off = discountPercent(product);
    if (off >= 20) return { off, tier: "deal", label: "Fırsat" };
    if (off >= 10) return { off, tier: "special", label: "Özel İndirim" };
    return null;
  };

  const promotionBadgeHTML = (product, baseClass = "discount-badge") => {
    const badge = promotionBadge(product);
    return badge
      ? `<span class="${baseClass} campaign-badge campaign-badge--${badge.tier}">${badge.label} · %${badge.off}</span>`
      : "";
  };

  const stars = (rating) => {
    const rounded = Math.round(Number(rating) || 0);
    return `<span class="stars" aria-label="5 üzerinden ${rating}">${"★".repeat(rounded)}${"☆".repeat(5 - rounded)}</span>`;
  };

  /* Onaylı yorum ortalaması. Hiç yorum yoksa yıldız satırı hiç basılmaz —
     boş bir 5 yıldız sırası sıfır puan gibi okunuyordu. */
  const ratingHTML = (product) => product.rating?.count
    ? `<span class="card-rating" aria-label="5 üzerinden ${product.rating.average}">
         <span class="stars">${"★".repeat(Math.round(product.rating.average))}${"☆".repeat(5 - Math.round(product.rating.average))}</span>
         <small>(${product.rating.count})</small>
       </span>`
    : "";

  function productCardHTML(product) {
    const scales = productScales(product);
    const badgeHTML = !scales.length ? promotionBadgeHTML(product) : "";
    /* Ölçekli üründe indirim rozeti ve üstü çizili fiyat gösterilmiyor: fiyat
       ölçekten geliyor, sale_price o üründe uygulanmıyor (bkz. displayPrice). */
    const priceHTML = scales.length
      ? `${money(scales[0].price)}${scales.length > 1 ? `<span class="price-from">'den itibaren</span>` : ""}`
      : `${money(product.sale_price || product.price)}${product.sale_price ? ` <s>${money(product.price)}</s>` : ""}`;
    /* Birden fazla ölçek varsa karttan doğrudan sepete atmıyoruz — hangi boyu
       istediğini müşteri seçmeli; buton ürün sayfasına götürür (bkz.
       data-add-product işleyicisi). Kartın görünümü değişmesin diye yine
       <button>: .product-card button'un stili dört ayrı katmanda tanımlı,
       yeni bir sınıf onların hepsini yeniden yazmayı gerektirirdi. */
    const action = `<button data-add-product="${product.id}">${
      productCustomizationSchema(product) ? "Kişiselleştir" : scales.length > 1 ? "Ölçek seçin" : "Sepete ekle"}</button>`;
    /* Alanlar kaçışlanıyor. Ürün verisi admin panelinden geliyor, yani halka
       açık girdi değil — ama adında & ya da < geçen tek bir ürün işaretlemeyi
       bozmaya yeter, ve bu metin artık sunucunun bastığı ilk HTML'de de var.
       Detay şablonu zaten kaçışlıyordu; kart unutulmuştu. */
    return `
    <article class="product-card">
      ${badgeHTML}
      <a class="product-card__link" href="/urun/${product.id}">
        <img src="${escapeHtml(gorselAdresi(product.image_path, 500) || "/assets/printable-logo.svg")}" alt="${escapeHtml(product.image_alt || product.name)}" loading="lazy">
        <h3>${escapeHtml(product.name)}</h3>
      </a>
      ${ratingHTML(product)}
      <p>${priceHTML}</p>
      <div class="swatches">${(product.colors || []).map((color) => `<span style="background:${escapeHtml(color.hex)}" title="${escapeHtml(color.name)}"></span>`).join("")}</div>
      ${action}
    </article>
  `;
  }

  // ---- Ürün detayı ----------------------------------------------------------

  const galeriMedyaTuru = (item) =>
    item?.media_type === "video" || /\.(mp4|webm)(?:[?#]|$)/i.test(item?.image_path || item?.src || "")
      ? "video"
      : "image";

  const anaMedyaHTML = (kare) => kare?.type === "video"
    ? `<video id="gallery-main-video" src="${escapeHtml(kare.src)}" controls playsinline preload="metadata"
              aria-label="${escapeHtml(kare.alt || "Ürün videosu")}"></video>`
    : `<img id="gallery-main-image" src="${escapeHtml(gorselAdresi(kare?.src, 1000)) || "/assets/printable-logo.svg"}"
            alt="${escapeHtml(kare?.alt || "Ürün görseli")}">`;

  const olceklerOf = (product) => product.scales || [];

  /* Seçili ölçek. Ölçek yalnızca bir etiket değil, kendi fiyatı olan bir
     varyant. Varsayılan en ucuzu — kartta gördüğü fiyat bu, sayfa açılınca
     aynı rakamı görmeli. Sunucu da bu varsayılanla basıyor. */
  const seciliOlcek = (product, seciliOlcekId) =>
    olceklerOf(product).find((s) => s.id === seciliOlcekId) || olceklerOf(product)[0] || null;

  /* Galeride gösterilecek kareler. Renk seçili değilken kapak başta, sonra tüm
     galeri. Renk seçiliyken önce o rengin fotoğrafları — ana görsel her zaman
     ilk kare olduğu için, kırmızıyı seçene mavi kapak gösterilmemeli. */
  function galeriKareleri(product, seciliRenkId) {
    const kapak = product.image_path
      ? [{ src: product.image_path, alt: product.image_alt || product.name, colorId: null, type: "image" }]
      : [];
    const ekler = (product.images || [])
      .filter((g) => g.image_path !== product.image_path)
      .map((g) => ({
        src: g.image_path,
        alt: g.image_alt || product.name,
        colorId: g.color_id,
        type: galeriMedyaTuru(g)
      }));

    if (!seciliRenkId) return [...kapak, ...ekler];

    const tumu = [...kapak, ...ekler];
    return [
      ...tumu.filter((k) => k.colorId === seciliRenkId),
      ...tumu.filter((k) => k.colorId !== seciliRenkId)
    ];
  }

  function productDetailHTML(product, durum) {
    const { seciliOlcekId = null, seciliRenkId = null, stokGoster = true } = durum || {};
    const olcekler = olceklerOf(product);
    const olcek = seciliOlcek(product, seciliOlcekId);
    const price = olcek ? olcek.price : (product.sale_price || product.price);
    const madeToOrder = productIsMadeToOrder(product);
    const inStock = productIsAvailable(product);
    const onSale = !olcekler.length && product.sale_price && product.price > product.sale_price;
    const badgeHTML = onSale ? promotionBadgeHTML(product) : "";
    const cats = (product.categories || [])
      .map((c) => `<a class="chip" href="/urunler?kategori=${c.id}">${escapeHtml(c.name)}</a>`).join("");

    const olcekSecici = olcekler.length > 1
      ? `<div class="product-detail__scales">
           <span class="product-detail__scales-title">Ölçek</span>
           <div class="scale-picker" role="radiogroup" aria-label="Ölçek seçin">
             ${olcekler.map((s) => `
               <button type="button" class="scale-option ${s.id === olcek.id ? "active" : ""}"
                       role="radio" aria-checked="${s.id === olcek.id}" data-scale-pick="${s.id}">
                 <strong>${escapeHtml(s.scale)}</strong>
                 <span>${money(s.price)}</span>
               </button>`).join("")}
           </div>
         </div>`
      : olcek
        ? `<p class="product-detail__scale-single">Ölçek: <strong>${escapeHtml(olcek.scale)}</strong></p>`
        : "";

    // Rengin kendi fotoğrafı varsa nokta tıklanabilir olur; yoksa sade kalır
    // — tıklayınca hiçbir şey olmayan bir düğme kullanıcıyı yanıltır.
    const renkliFotoVar = (renkId) => (product.images || []).some((g) => g.color_id === renkId);
    const swatches = (product.colors || [])
      .map((c) => renkliFotoVar(c.id)
        ? `<button type="button" class="color-dot color-dot--action ${seciliRenkId === c.id ? "active" : ""}" style="background:${escapeHtml(c.hex)}" title="${escapeHtml(c.name)} fotoğraflarını göster" aria-label="${escapeHtml(c.name)} fotoğraflarını göster" data-color-pick="${c.id}"></button>`
        : `<span class="color-dot" style="background:${escapeHtml(c.hex)}" title="${escapeHtml(c.name)}"></span>`).join("");

    const kareler = galeriKareleri(product, seciliRenkId);

    return `
      <nav class="breadcrumb" aria-label="Sayfa yolu">
        <a href="/">Ana Sayfa</a><span aria-hidden="true">/</span>
        <a href="/urunler">Ürünler</a><span aria-hidden="true">/</span>
        <strong>${escapeHtml(product.name)}</strong>
      </nav>
      <div class="product-detail__grid">
        <div class="product-detail__media">
          <div class="gallery-main">
            ${anaMedyaHTML(kareler[0] || {
              src: "/assets/printable-logo.svg",
              alt: product.image_alt || product.name,
              type: "image"
            })}
          </div>
          ${kareler.length > 1 ? `
            <div class="gallery-thumbs" id="gallery-thumbs">
              ${kareler.map((k, i) => `
                <button type="button" class="gallery-thumb ${i === 0 ? "active" : ""} ${k.type === "video" ? "gallery-thumb--video" : ""}" data-gallery-index="${i}"
                        aria-label="${i + 1}. ${k.type === "video" ? "videoyu oynat" : "fotoğrafı göster"}">
                  ${k.type === "video"
                    ? `<video src="${escapeHtml(k.src)}" muted playsinline preload="metadata" tabindex="-1"></video><span aria-hidden="true">▶</span>`
                    : `<img src="${escapeHtml(gorselAdresi(k.src, 200))}" alt="">`}
                </button>`).join("")}
            </div>` : ""}
        </div>
        <div class="product-detail__info">
          ${cats ? `<div class="product-detail__cats">${cats}</div>` : ""}
          <h1>${escapeHtml(product.name)}</h1>
          ${product.rating?.count
            ? `<a class="product-detail__rating" href="#reviews-section">${stars(product.rating.average)}
                 <span>${product.rating.average} · ${product.rating.count} değerlendirme</span></a>`
            : `<a class="product-detail__rating product-detail__rating--empty" href="#reviews-section">${stars(0)}
                 <span>Henüz değerlendirilmemiş</span></a>`}
          <p class="product-detail__price">${money(price)}${onSale ? ` <s>${money(product.price)}</s>${badgeHTML ? ` ${badgeHTML}` : ""}` : ""}</p>
          ${onSale ? `<p class="product-detail__save">${money(product.price - product.sale_price)} tasarruf edin</p>` : ""}
          <p class="product-detail__tax">KDV dahil · Kargo alıcı ödemeli</p>
          ${olcekSecici}
          ${swatches ? `<div class="product-detail__colors"><span>Renkler</span><div class="swatches">${swatches}</div></div>` : ""}
          ${product.description ? `<p class="product-detail__desc">${escapeHtml(product.description)}</p>` : ""}
          ${productCustomizationHTML(product)}
          <ul class="product-detail__specs">
            ${product.color ? `<li><span>Malzeme</span><strong>${escapeHtml(product.color)}</strong></li>` : ""}
            ${product.sku ? `<li><span>Ürün kodu</span><strong>${escapeHtml(product.sku)}</strong></li>` : ""}
            ${madeToOrder
              ? `<li><span>Üretim</span><strong class="spec-in">Siparişe özel hazırlanır</strong></li>`
              : stokGoster || !inStock
              ? `<li><span>Stok</span><strong class="${inStock ? "spec-in" : "spec-out"}">${inStock ? product.stock + " adet" : "Tükendi"}</strong></li>`
              : ""}
          </ul>
          <div class="product-detail__actions">
            <label class="qty-field">Adet
              <input type="number" id="detail-qty" min="1" max="${madeToOrder ? 99 : Math.max(1, product.stock || 1)}" value="1" ${inStock ? "" : "disabled"}>
            </label>
            <button type="button" id="detail-add" ${inStock ? "" : "disabled"}>${inStock ? "Sepete ekle" : "Tükendi"}</button>
            <a class="btn-outline" href="/stl-teklif">Kendi modelinizi bastırın</a>
          </div>
        </div>
      </div>
    `;
  }

  // ---- /landing vitrini ------------------------------------------------------
  // Secim deterministik (sabit id listesi + katalog sirasi), yani sunucu ile
  // tarayici ayni bes urunu ayni sirada uretiyor.
function preferredProductList(active, ids, limit, excluded = new Set()) {
  const selected = [];
  ids.forEach((id) => {
    const product = active.find((item) => item.id === id);
    if (product && !excluded.has(product.id) && !selected.some((item) => item.id === product.id)) selected.push(product);
  });
  active.forEach((product) => {
    if (selected.length >= limit || excluded.has(product.id) || selected.some((item) => item.id === product.id)) return;
    selected.push(product);
  });
  return selected.slice(0, limit);
}

function commerceStageCardHTML(product, index) {
  const scales = productScales(product);
  const inStock = productIsAvailable(product);
  return `
    <article class="commerce-product${index === 0 ? " commerce-product--lead" : ""}">
      ${!scales.length ? promotionBadgeHTML(product, "commerce-product__discount") : ""}
      <a href="/urun/${product.id}">
        <img src="${gorselAdresi(product.image_path, index === 0 ? 900 : 500) || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}" ${index === 0 ? 'fetchpriority="high"' : 'loading="eager"'}>
      </a>
      <div>
        ${index === 0 ? "<span>Vitrin ürünü</span>" : ""}
        <h2>${product.name}</h2>
        <strong>${money(displayPrice(product))}${scales.length > 1 ? "'den başlayan" : ""}</strong>
        <button type="button" data-add-product="${product.id}" ${inStock ? "" : "disabled"}>${inStock ? (productCustomizationSchema(product) ? "Kişiselleştir" : scales.length > 1 ? "Boyunu seç" : "Sepete ekle") : "Tükendi"}</button>
      </div>
    </article>`;
}

  const disaAktar = {
    escapeHtml, money, stars, productScales, displayPrice, discountPercent, promotionBadge, promotionBadgeHTML, ratingHTML,
    productCardHTML, productDetailHTML, commerceStageCardHTML, preferredProductList, gorselAdresi,
    olceklerOf, seciliOlcek, galeriKareleri, anaMedyaHTML, galeriMedyaTuru,
    PRODUCT_CUSTOMIZATION_SCHEMAS, productCustomizationSchema, productCustomizationHTML, customizationSummary,
    productIsMadeToOrder, productIsAvailable
  };

  /* Node'da require, tarayıcıda global. Derleme adımı yok; tarayıcı bu dosyayı
     script.js'ten ÖNCE yüklemeli, çünkü script.js buradaki isimleri kullanıyor. */
  if (typeof module === "object" && module.exports) module.exports = disaAktar;
  else Object.assign(kok, disaAktar);
})(typeof globalThis !== "undefined" ? globalThis : this);

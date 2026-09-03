/* money, productScales, displayPrice, discountPercent, ratingHTML,
   productCardHTML: product-templates.js. Sunucu da AYNI fonksiyonlari
   cagirdigi icin ilk HTML ile JS yeniden bastiginda cikan HTML birebir ayni
   oluyor; sayfa zipplamiyor ve tarayici ile ziyaretci ayni seyi goruyor.
   Bu dosya product-templates.js YUKLENDIKTEN SONRA calismali. */

/* Dönüşüm ölçümü.
 *
 * GA4 kendiliğinden yalnızca "sayfa görüntülendi" diyor. Reklamın işe yarayıp
 * yaramadığını anlamak için siteye para kazandıran ANI bildirmek gerekiyor:
 * sepete ekleme, ödemeye başlama, tamamlanan sipariş (tutarıyla), iletişim
 * formu ve WhatsApp tıklaması.
 *
 * gtag yoksa (ölçüm kimliği tanımlı değilse, reklam engelleyici varsa) sessizce
 * hiçbir şey yapmaz — ölçüm eksikliği sitenin çalışmasını hiçbir koşulda
 * bozmamalı. */
function olay(ad, veri) {
  try {
    if (typeof gtag === "function") gtag("event", ad, veri || {});
  } catch { /* ölçüm hatası akışı kesmez */ }
}

// GA4'ün beklediği ürün biçimi.
const olayUrunu = (satir) => ({
  item_id: String(satir.id),
  item_name: satir.name,
  price: Number(satir.price) || 0,
  quantity: Number(satir.quantity) || 1,
  ...(satir.scale ? { item_variant: satir.scale } : {})
});

/* WhatsApp, çizim hizmetinin ana dönüşüm yolu — tıklama sayfadan ayrılmakla
   sonuçlandığı için delegasyonla yakalanıyor. */
document.addEventListener("click", (event) => {
  const wa = event.target.closest?.('a[href*="wa.me"]');
  if (wa) olay("whatsapp_click", { link_url: wa.href, sayfa: location.pathname });
}, true);

// Cart persists in localStorage so it survives page navigation (to /odeme and back).
const CART_KEY = "printable_cart";
function loadCart() {
  try {
    const data = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* ignore quota/privacy errors */ }
}
const cart = loadCart();
let freeShippingThreshold = 599;

/* Sepet satırının kimliği ÜRÜN + ÖLÇEK. Aynı katlacın küçük ve büyük boyu iki
   ayrı satır, iki ayrı fiyat; yalnızca ürün id'siyle eşleştirseydik biri
   diğerinin adedine eklenir ve müşteri yanlış boydan sipariş verirdi.
   Ölçeksiz ürünlerde (ve ölçekler eklenmeden önce doldurulmuş eski
   sepetlerde) anahtar "12:" olur — eski satırlar bozulmadan çalışır. */
const lineKey = (item) => item.line_id || `${item.id}:${item.scale_id || ""}`;

function cartCustomizationHTML(item) {
  const rows = typeof customizationSummary === "function" ? customizationSummary(item.customization) : [];
  return rows.map((row) =>
    `<span class="cart-item__scale"><strong>${escapeHtml(row.label)}:</strong> ${escapeHtml(row.value)}</span>`
  ).join("");
}

const storeProducts = document.querySelector("#store-products");
const cartPanel = document.querySelector("#cart-panel");
const cartCount = document.querySelector("#cart-count");
const cartItems = document.querySelector("#cart-items");
const searchToggle = document.querySelector(".search-toggle");
const searchPopover = document.querySelector(".search-popover");
const customerAccountLink = document.querySelector('a[href="/hesap"].icon-button');
const customerAccountLabel = customerAccountLink?.querySelector(".account-link__label");

/* Normal gezinmede adı sunucu ilk baytta basar; aynı bilgiyi hemen tekrar
   istemeyiz. Yalnızca geri/ileri önbelleğinden dönen sayfada oturumu uzlaştır. */
function reconcileCustomerSession() {
  if (!customerAccountLink) return;
  fetch("/api/customer/session")
    .then((response) => response.json())
    .then(({ authed, customer }) => {
      // Sunucu da ilk adı basıyor (renderHeader); farklı yazsak başlık JS
      // yüklenince değişir ve menüyü yeniden kaydırırdı.
      const label = authed ? (customer.name.trim().split(/\s+/)[0] || "Hesabım") : "Hesabım";
      const aria = authed ? `${customer.name} hesabı` : "Müşteri hesabım";
      customerAccountLink.classList.toggle("is-authenticated", Boolean(authed));
      // Değer aynıysa DOM'a dokunma: sunucu zaten doğru bastıysa gereksiz boyama olmasın.
      if (customerAccountLabel && customerAccountLabel.textContent !== label) {
        customerAccountLabel.textContent = label;
      }
      if (customerAccountLink.getAttribute("aria-label") !== aria) {
        customerAccountLink.setAttribute("aria-label", aria);
      }
    })
    .catch(() => {});
}
window.addEventListener("pageshow", (event) => {
  if (event.persisted) reconcileCustomerSession();
});

function fillProductGrid(target, products) {
  const grid = typeof target === "string" ? document.querySelector(target) : target;
  if (!grid) return;
  const active = products.filter((product) => product.is_active);
  grid.innerHTML = active.map(productCardHTML).join("") || `<p class="products-empty">Ürün bulunamadı.</p>`;
}

const cartSubtotal = () => cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

function renderCart() {
  if (cartCount) cartCount.textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
  if (!cartItems) return;
  cartItems.innerHTML = cart.map((item) => `
    <article class="cart-item">
      <img src="${item.image || "/assets/printable-logo.svg"}" alt="">
      <div class="cart-item__info">
        <h3>${item.name}</h3>
        ${item.scale ? `<span class="cart-item__scale">${item.scale}</span>` : ""}
        ${cartCustomizationHTML(item)}
        <p>${money(item.price)}</p>
        <div class="cart-qty">
          <button type="button" data-dec="${lineKey(item)}" aria-label="Azalt">−</button>
          <span>${item.quantity}</span>
          <button type="button" data-inc="${lineKey(item)}" aria-label="Artır">+</button>
        </div>
      </div>
      <div class="cart-item__end">
        <strong>${money(item.price * item.quantity)}</strong>
        <button type="button" class="cart-remove" data-remove-product="${lineKey(item)}">Kaldır</button>
      </div>
    </article>
  `).join("") || "<p class='cart-empty'>Sepetiniz boş.</p>";

  const footer = document.querySelector("#cart-footer");
  if (footer) footer.hidden = cart.length === 0;
  const subtotalEl = document.querySelector("#cart-subtotal");
  if (subtotalEl) subtotalEl.textContent = money(cartSubtotal());
  const shippingNote = document.querySelector("#cart-shipping-note");
  if (shippingNote) {
    const kalan = Math.max(0, freeShippingThreshold - cartSubtotal());
    shippingNote.textContent = kalan > 0
      ? `Ücretsiz kargoya ${money(kalan)} kaldı`
      : "Ücretsiz kargoyu kazandınız 🎉";
    shippingNote.classList.toggle("cart-note--qualified", kalan === 0);
  }
}

const categoryGrid = document.querySelector("#category-grid");

// Admin-managed. Tiles link to the filterable catalogue page, pre-filtered by category.
async function loadCategories() {
  if (!categoryGrid) return;
  try {
    const embeddedData = document.querySelector("#home-categories-data");
    if (embeddedData) {
      const categories = JSON.parse(embeddedData.textContent);
      if (Array.isArray(categories) && categories.length) {
        window.printableCategories = categories;
        fillCategoryCounts();
        return;
      }
    }

    const categories = await fetch("/api/categories").then((response) => response.json());
    if (!Array.isArray(categories) || !categories.length) return;
    window.printableCategories = categories;
    categoryGrid.innerHTML = categories.map((category) => `
      <a class="category-card" href="/urunler?kategori=${category.id}">
        <span class="category-card__media">
          <img src="${gorselAdresi(category.image_path, 500) || "/assets/printable-logo.svg"}" alt="${category.image_alt || ""}" loading="lazy">
        </span>
        <span class="category-card__body">
          <strong>${category.name}</strong>
          <small data-category-count="${category.id}"></small>
        </span>
      </a>
    `).join("");
    fillCategoryCounts();
  } catch {
    /* keep the fallback markup */
  }
}

// Categories and products load in parallel, so whichever finishes second fills
// the counts — the tiles just render without a count until then.
function fillCategoryCounts() {
  const products = (window.printableProducts || []).filter((p) => p.is_active);
  if (!products.length) return;
  document.querySelectorAll("[data-category-count]").forEach((el) => {
    const id = Number(el.dataset.categoryCount);
    const n = products.filter((p) => (p.categories || []).some((c) => c.id === id)).length;
    el.textContent = n ? `${n} ürün` : "Yakında";
  });
}

// Real numbers from the live catalogue, so the offers band reflects the shop as
// it actually is instead of a claim someone has to remember to update.
function renderLiveStats(active) {
  const strip = document.querySelector("#cyber-live");
  if (!strip) return;
  const onSale = active.filter((p) => p.sale_price && p.price > p.sale_price);
  const bestOff = onSale.reduce((max, p) => Math.max(max, discountPercent(p)), 0);
  const rated = active.filter((p) => p.rating?.count);
  const reviewCount = rated.reduce((sum, p) => sum + p.rating.count, 0);
  const averageScore = rated.length
    ? rated.reduce((sum, p) => sum + p.rating.average * p.rating.count, 0) / reviewCount
    : 0;

  const tiles = [
    active.length && { value: active.length, label: "hazır ürün" },
    bestOff && { value: `%${bestOff}`, label: "en yüksek indirim" },
    reviewCount && { value: averageScore.toFixed(1) + " ★", label: `${reviewCount} değerlendirme` }
  ].filter(Boolean);

  if (!tiles.length) return;
  strip.innerHTML = tiles.map((t) => `<div><dt>${t.value}</dt><dd>${t.label}</dd></div>`).join("");
  strip.hidden = false;
}

// The lead product keeps its own editorial card beside the supporting 2x2 grid.
function renderFeaturePanel(product) {
  const panel = document.querySelector("#feature-panel");
  if (!panel) return;
  if (!product) { panel.hidden = true; return; }

  const scales = productScales(product);
  const price = displayPrice(product);
  panel.innerHTML = `
    <a class="feature-panel__media" href="/urun/${product.id}">
      ${!scales.length ? promotionBadgeHTML(product) : ""}
      <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}" loading="lazy">
    </a>
    <div class="feature-panel__body">
      <p class="section-kicker">Haftanın seçimi</p>
      <h3><a href="/urun/${product.id}">${product.name}</a></h3>
      ${ratingHTML(product)}
      <p class="feature-panel__price">
        ${money(price)}${scales.length > 1
          ? `<span class="price-from">'den itibaren</span>`
          : (!scales.length && product.sale_price ? ` <s>${money(product.price)}</s>` : "")}
      </p>
      <button type="button" data-add-product="${product.id}">${productCustomizationSchema(product) ? "Kişiselleştir" : scales.length > 1 ? "Ölçek seçin" : "Sepete ekle"}</button>
    </div>`;
  panel.hidden = false;
}

/* preferredProductList ve commerceStageCardHTML product-templates.js'e
   tasindi: /landing vitrinini sunucu da basiyor. */

function landingShelfCardHTML(product) {
  const off = discountPercent(product);
  const scales = productScales(product);
  const inStock = productIsAvailable(product);
  return `
    <article class="landing-shelf-product">
      <a class="landing-shelf-product__media" href="/urun/${product.id}">
        ${!scales.length ? promotionBadgeHTML(product, "landing-shelf-product__discount") : ""}
        <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}" loading="lazy">
      </a>
      <div class="landing-shelf-product__body">
        <h3><a href="/urun/${product.id}">${product.name}</a></h3>
        <div class="landing-shelf-product__buy">
          <p><strong>${money(displayPrice(product))}</strong>${scales.length > 1 ? "<small>'den başlayan</small>" : (off ? `<s>${money(product.price)}</s>` : "")}</p>
          <button type="button" data-add-product="${product.id}" ${inStock ? "" : "disabled"} aria-label="${product.name}: ${inStock ? (productCustomizationSchema(product) ? "kişiselleştir" : "sepete ekle") : "tükendi"}">${inStock ? (productCustomizationSchema(product) || scales.length > 1 ? "Seç" : "+") : "—"}</button>
        </div>
      </div>
    </article>`;
}

function renderProductLanding(active) {
  const stage = document.querySelector("#landing-product-stage");
  const shelf = document.querySelector("#landing-feature-products");
  if (!stage && !shelf) return;

  // Beş farklı ürün tipini ilk ekranda tut; Spinball (53) ve Katlaç (39)
  // bu seçkinin sabit parçalarıdır, diğer ürünler katalogdan tamamlanır.
  const stageProducts = preferredProductList(active, [21, 53, 22, 39, 35], 5);
  if (stage && stageProducts.length) stage.innerHTML = stageProducts.map(commerceStageCardHTML).join("");

  const stageIds = new Set(stageProducts.map((product) => product.id));
  const shelfProducts = preferredProductList(active, [50, 49, 48, 38, 37, 36, 30, 29, 51, 7], 8, stageIds);
  if (shelf) shelf.innerHTML = shelfProducts.map(landingShelfCardHTML).join("");

  const count = document.querySelector("[data-landing-catalog-count]");
  if (count) count.textContent = `${active.length} ürünün tamamını keşfet`;
}

function renderFidgetSpotlight(active) {
  const section = document.querySelector("#fidget-spotlight");
  const spinballPanel = document.querySelector("#spinball-spotlight");
  const katlacPanel = document.querySelector("#katlac-spotlight");
  if (!section || !spinballPanel || !katlacPanel) return;

  const spinball = active.find((product) => product.id === 53)
    || active.find((product) => /spinball|helixcore/i.test(product.name || ""));
  const katlaclar = active.filter((product) => /katlaç|katlac/i.test(product.name || ""));
  if (!spinball && !katlaclar.length) return;

  section.hidden = false;

  if (spinball) {
    const video = (spinball.images || []).find((item) =>
      item.media_type === "video" || /\.(?:mp4|webm)(?:[?#]|$)/i.test(item.image_path || "")
    );
    const off = discountPercent(spinball);
    const currentPrice = displayPrice(spinball);
  const inStock = productIsAvailable(spinball);
    spinballPanel.innerHTML = `
      <div class="spinball-spotlight__media">
        ${video
          ? `<video class="spinball-spotlight__video" poster="${spinball.image_path || ""}"
                    muted loop playsinline preload="metadata" controls
                    aria-label="${spinball.name} kullanım videosu">
               <source src="${video.image_path}" type="video/mp4">
             </video>`
          : `<img src="${spinball.image_path || "/assets/printable-logo.svg"}"
                  alt="${spinball.image_alt || spinball.name}" loading="lazy">`}
        <span class="spinball-spotlight__motion">Basınca dönen mekanizma</span>
      </div>
      <div class="spinball-spotlight__copy">
        <p class="fidget-label">Yeni nesil fidget</p>
        <h3>Bas. Çevir. Rahatla.</h3>
        <p>${spinball.description || "Sıkma hareketini akıcı bir dönüşe çeviren, avuç içinde oynamalık mekanik fidget topu."}</p>
        <ul class="fidget-benefits" aria-label="Ürün özellikleri">
          <li>Mekanik ve tatmin edici hareket</li>
          <li>Avuç içinde rahat kullanım</li>
          <li>Masada ve molalarda elinin altında</li>
        </ul>
        <div class="spinball-spotlight__buy">
          <div>
            ${promotionBadgeHTML(spinball, "fidget-discount")}
            <strong>${money(currentPrice)}</strong>
            ${off ? `<s>${money(spinball.price)}</s>` : ""}
            <small>${inStock ? `${spinball.stock} adet stokta` : "Stokta yok"}</small>
          </div>
          <div class="fidget-actions">
            <button type="button" data-add-product="${spinball.id}" ${inStock ? "" : "disabled"}>${inStock ? "Hemen sepete ekle" : "Tükendi"}</button>
            <a href="/urun/${spinball.id}">Ürünü incele</a>
          </div>
        </div>
      </div>`;
    spinballPanel.hidden = false;

    const spotlightVideo = spinballPanel.querySelector("video");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (spotlightVideo && !reducedMotion && "IntersectionObserver" in window) {
      const videoObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) spotlightVideo.play().catch(() => {});
          else spotlightVideo.pause();
        });
      }, { threshold: 0.55 });
      videoObserver.observe(spotlightVideo);
    }
  }

  if (katlaclar.length) {
    const prices = katlaclar.map(displayPrice).map(Number).filter((price) => price > 0);
    const startingPrice = prices.length ? Math.min(...prices) : 0;
    katlacPanel.innerHTML = `
      <div class="katlac-spotlight__copy">
        <p class="fidget-label">Katlaç koleksiyonu</p>
        <h3>Katla. Aç. Yeniden başla.</h3>
        <p>Renkli, temalı ve elde çevirmesi keyifli Katlaçlardan tarzına uyanı seç. Tekrarlayan hareketiyle ellerini meşgul eder, masanda da iyi görünür.</p>
        <div class="katlac-spotlight__facts">
          <span><strong>${katlaclar.length}</strong> farklı tasarım</span>
          ${startingPrice ? `<span><strong>${money(startingPrice)}</strong>'den başlayan</span>` : ""}
        </div>
        <a class="katlac-spotlight__all" href="/urunler?q=katlaç">Tüm Katlaçları gör <span aria-hidden="true">→</span></a>
      </div>
      <div class="katlac-spotlight__models" id="katlac-models">
        ${katlaclar.slice(0, 6).map((product) => `
          <a class="katlac-mini" href="/urun/${product.id}">
            <img src="${product.image_path || "/assets/printable-logo.svg"}"
                 alt="${product.image_alt || product.name}" loading="lazy">
            <span>
              <strong>${product.name}</strong>
              <small>${money(displayPrice(product))}${productScales(product).length > 1 ? "'den itibaren" : ""}</small>
            </span>
          </a>`).join("")}
      </div>`;
    katlacPanel.hidden = false;
  }

  renderBulkCommerce(spinball, katlaclar);
}

const BULK_QUANTITIES = [10, 50, 100];
const BULK_LABELS = {
  10: "Başlangıç paketi",
  50: "İşletme paketi",
  100: "Yüksek adet"
};

function bulkTierFor(product, quantity, baseTotal) {
  return (product.tiers || [])
    .filter((tier) => tier.quantity_exact
      ? Number(tier.min_quantity) === quantity
      : Number(tier.min_quantity) <= quantity)
    .filter((tier) => !Number(tier.min_order_total) || baseTotal >= Number(tier.min_order_total))
    .sort((a, b) => Number(a.unit_price) - Number(b.unit_price))[0] || null;
}

function bulkPrice(product, quantity, scale) {
  const baseUnit = Number(scale?.price || displayPrice(product)) || 0;
  const baseTotal = baseUnit * quantity;
  const tier = bulkTierFor(product, quantity, baseTotal);
  if (!tier) return { unit: baseUnit, total: baseTotal, saving: 0, tier: null };

  let total = baseTotal;
  if (tier.discount_type === "percent") {
    total = baseTotal * (1 - Number(tier.discount_value || 0) / 100);
  } else if (tier.discount_type === "fixed") {
    total = Math.max(0, baseTotal - Number(tier.discount_value || 0));
  }
  return {
    unit: total / quantity,
    total,
    saving: Math.max(0, baseTotal - total),
    tier
  };
}

function bulkTiersHTML(product, scale = null) {
  return BULK_QUANTITIES.map((quantity) => {
    const offer = bulkPrice(product, quantity, scale);
    const featured = quantity === 50;
    return `
      <article class="bulk-tier${featured ? " bulk-tier--featured" : ""}">
        ${featured ? '<span class="bulk-tier__popular">En çok tercih edilen</span>' : ""}
        <div class="bulk-tier__heading">
          <span>${BULK_LABELS[quantity]}</span>
          <strong>${quantity}<small> adet</small></strong>
        </div>
        <div class="bulk-tier__price">
          <strong>${money(offer.unit)}</strong><span>/ adet</span>
        </div>
        <p>Toplam <strong>${money(offer.total)}</strong></p>
        ${offer.saving > 0
          ? `<span class="bulk-tier__saving">${money(offer.saving)} avantaj</span>`
          /* Kademe yoksa rozet BOŞ kalır: eskiden "Adet kampanyası sepette
             uygulanır" yazıyordu ve tanımlı kampanya olmadığında müşteriye
             verilmemiş bir söz veriyordu. Etiket yine de basılıyor çünkü
             margin-top:auto ile "sepete ekle" düğmelerini aynı hizada
             tutan şey bu. */
          : '<span class="bulk-tier__automatic" aria-hidden="true"></span>'}
        <button type="button" data-bulk-quantity="${quantity}">${quantity} adedi sepete ekle</button>
      </article>`;
  }).join("");
}

function bulkProductCardHTML(product, kind, products = []) {
  const scales = productScales(product);
  const selectedScale = scales[0] || null;
  const isKatlac = kind === "katlac";
  return `
    <article class="bulk-product bulk-product--${kind}" data-bulk-product-id="${product.id}" data-bulk-kind="${kind}">
      <header class="bulk-product__head">
        <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}" loading="lazy">
        <div>
          <span>${isKatlac ? "Katlaç toplu alım" : "Spinball toplu alım"}</span>
          <h3>${isKatlac ? "Modelini seç, paketini oluştur." : "Tek hamlede toplu sipariş."}</h3>
          <p>${isKatlac
            ? "Farklı Katlaç modellerini ayrı ayrı sepete ekleyerek karma paket hazırlayabilirsiniz."
            : "Etkinlik, mağaza, ekip hediyesi ve kurumsal dağıtımlar için hazır paketler."}</p>
        </div>
      </header>

      <div class="bulk-product__selectors">
        ${isKatlac ? `
          <label>Katlaç modeli
            <select data-bulk-product-select>
              ${products.map((item) => `<option value="${item.id}" ${item.id === product.id ? "selected" : ""}>${item.name}</option>`).join("")}
            </select>
          </label>` : `
          <div class="bulk-product__chosen"><span>Seçili ürün</span><strong>${product.name}</strong></div>`}
        ${/* Tek boy satıldığında seçici çıkmaz — tek seçenekli açılır liste
              müşteriye seçim yaptığını sandırır. Vitrin ölçeği sunucuda
              belirleniyor (satisOlcekleri). */
          scales.length > 1 ? `
          <label>Boy / ölçek
            <select data-bulk-scale-select>
              ${scales.map((scale) => `<option value="${scale.id}">${scale.scale} · ${money(scale.price)}</option>`).join("")}
            </select>
          </label>` : ""}
      </div>

      <div class="bulk-tiers" data-bulk-tiers>${bulkTiersHTML(product, selectedScale)}</div>
      <div class="bulk-product__foot">
        <span>Güvenli kart ödemesi · 599 TL üzeri ücretsiz kargo</span>
        <a href="/iletisim?subject=${encodeURIComponent(`${product.name} 100+ adet toplu sipariş`)}">100 adetten fazlası için teklif alın →</a>
      </div>
    </article>`;
}

function renderBulkCommerce(spinball, katlaclar) {
  const section = document.querySelector("#bulk-commerce");
  if (!section || (!spinball && !katlaclar.length)) return;
  section.innerHTML = `
    <header class="bulk-commerce__head">
      <div>
        <p class="section-kicker">Toplu satış</p>
        <h2 id="bulk-commerce-title">10, 50 veya 100 adet. Seçin, sepete ekleyin.</h2>
      </div>
      <p>Birim fiyatı, paket toplamını ve varsa adet avantajını sipariş vermeden önce görün. Kampanyalar ödeme öncesinde otomatik hesaplanır.</p>
    </header>
    <div class="bulk-commerce__grid">
      ${spinball ? bulkProductCardHTML(spinball, "spinball") : ""}
      ${katlaclar.length ? bulkProductCardHTML(katlaclar[0], "katlac", katlaclar) : ""}
    </div>
    <div class="bulk-commerce__assurance" aria-label="Toplu sipariş avantajları">
      <span><strong>3 paket</strong> 10 · 50 · 100 adet</span>
      <span><strong>Şeffaf fiyat</strong> Birim ve toplam birlikte</span>
      <span><strong>Karma Katlaç</strong> Modelleri ayrı ayrı ekleyin</span>
    </div>`;
  section.hidden = false;
}

// The homepage rows are curated slices of the same catalogue; /urunler owns real filtering.
async function loadProducts() {
  try {
    let products = null;
    let catalog = { products: [] };
    let embedded = false;
    const embeddedData = document.querySelector("#home-products-data");
    if (embeddedData) {
      try {
        const data = JSON.parse(embeddedData.textContent);
        if (Array.isArray(data)) {
          products = data;
          embedded = true;
        }
      } catch { /* Statik fallback aşağıdaki API'leri kullanır. */ }
    }

    if (!products) {
      [products, catalog] = await Promise.all([
        fetch("/api/products").then((response) => response.json()),
        fetch("/api/catalog").then((response) => response.json()).catch(() => ({ products: [] }))
      ]);
    }
    const catalogProducts = new Map((catalog.products || []).map((product) => [product.id, product]));
    products.forEach((product) => {
      product.tiers = catalogProducts.get(product.id)?.tiers || [];
    });
    window.printableProducts = products;
    const active = products.filter((product) => product.is_active);
    fillProductGrid(storeProducts, active);

    // The priciest product leads; the next four support it in the 2x2 grid.
    const featured = [...active].sort((a, b) => (b.sale_price || b.price) - (a.sale_price || a.price));
    renderFeaturePanel(featured[0]);
    fillProductGrid(".js-featured", featured.slice(1, 5));

    fillProductGrid(".js-popular", active.slice(0, 5));
    fillProductGrid(".js-recommended", [...active].reverse().slice(0, 4));
    renderProductLanding(active);
    if (!embedded) renderFidgetSpotlight(active);

    // Discounted products get their own section — hidden entirely when nothing is on sale.
    const onSale = active.filter((product) => product.sale_price && product.price > product.sale_price);
    const saleSection = document.querySelector("#sale-section");
    if (saleSection) {
      if (onSale.length) {
        // Deepest discount first — the band exists to show the best deal.
        const sorted = [...onSale].sort((a, b) => discountPercent(b) - discountPercent(a));
        fillProductGrid(".js-sale", sorted.slice(0, 5));
        const lead = document.querySelector("#sale-lead");
        if (lead) {
          // No case suffix on the number: "%17'ye" / "%20'ye" / "%30'a" / "%5'e"
          // all differ, and picking the right one from a digit is not worth it.
          const best = discountPercent(sorted[0]);
          lead.textContent = `${onSale.length} ürün indirimde · en yüksek indirim %${best} · stoklarla sınırlı`;
        }
        saleSection.hidden = false;
      } else {
        saleSection.hidden = true;
      }
    }

    renderLiveStats(active);
    fillCategoryCounts();
    observeCards();

    /* Kampanya kademeleri ilk ekran için gerekli değil. Sunucunun HTML'e gömdüğü
       ürünler hemen kullanılır; daha ağır katalog isteği tarayıcı boş kaldığında
       yalnızca toplu satış alanını zenginleştirir. */
    if (embedded && document.querySelector("#fidget-spotlight")) {
      const hydrateTiers = async () => {
        try {
          const deferredCatalog = await fetch("/api/catalog").then((response) => response.json());
          const deferredProducts = new Map((deferredCatalog.products || []).map((product) => [product.id, product]));
          products.forEach((product) => {
            product.tiers = deferredProducts.get(product.id)?.tiers || [];
          });
        } catch { /* Ürün vitrini kademeler olmadan da kullanılabilir. */ }
        renderFidgetSpotlight(active);
      };
      if ("requestIdleCallback" in window) requestIdleCallback(hydrateTiers, { timeout: 2500 });
      else setTimeout(hydrateTiers, 1200);
    }
  } catch {
    window.printableProducts = [];
  }
}

/* Add a product to the cart (used by every "Sepete ekle" button across the site).
   scale: müşterinin seçtiği ölçek nesnesi ({id, scale, price}). Verilmezse ve
   ürünün TEK ölçeği varsa o kullanılır — tek seçenekli bir listeden seçim
   istemek gereksiz. Birden fazlaysa çağıran taraf (ürün sayfası) seçtirmek
   zorunda; kartlar bu durumda zaten sepete ekleme butonu göstermiyor. */
function addToCart(product, quantity = 1, scale = null, customization = null) {
  const scales = productScales(product);
  const secili = scale || (scales.length === 1 ? scales[0] : null);
  const satir = {
    id: product.id,
    line_id: customization
      ? (globalThis.crypto?.randomUUID?.() || `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      : null,
    scale_id: secili ? secili.id : null,
    scale: secili ? secili.scale : null,
    name: product.name,
    price: secili ? secili.price : (product.sale_price || product.price),
    image: product.image_path || null,
    quantity,
    customization
  };
  const existing = cart.find((item) => lineKey(item) === lineKey(satir));
  if (existing) existing.quantity += quantity;
  else cart.push(satir);
  saveCart();
  renderCart();
  olay("add_to_cart", {
    currency: "TRY",
    value: satir.price * quantity,
    items: [olayUrunu(satir)]
  });
}

document.addEventListener("click", (event) => {
  const addId = event.target.dataset.addProduct;
  const bulkQuantity = Number(event.target.dataset.bulkQuantity || 0);
  const removeKey = event.target.dataset.removeProduct;
  const incKey = event.target.dataset.inc;
  const decKey = event.target.dataset.dec;
  if (addId) {
    const product = (window.printableProducts || []).find((item) => item.id === Number(addId));
    if (!product) return;
    // Ölçek seçilmeden sepete atılamaz: müşteriyi ürün sayfasına gönder.
    if (productCustomizationSchema(product) || productScales(product).length > 1) {
      location.href = `/urun/${product.id}`;
      return;
    }
    addToCart(product);
    cartPanel?.classList.add("open");
  }
  if (bulkQuantity) {
    const bulkCard = event.target.closest("[data-bulk-product-id]");
    const product = (window.printableProducts || []).find((item) => item.id === Number(bulkCard?.dataset.bulkProductId));
    if (!product) return;
    if (productCustomizationSchema(product)) {
      location.href = `/urun/${product.id}`;
      return;
    }
    const scaleId = Number(bulkCard.querySelector("[data-bulk-scale-select]")?.value || 0);
    const scale = productScales(product).find((item) => item.id === scaleId) || null;
    addToCart(product, bulkQuantity, scale);
    cartPanel?.classList.add("open");
  }
  if (incKey) {
    const item = cart.find((entry) => lineKey(entry) === incKey);
    if (item) { item.quantity += 1; saveCart(); renderCart(); }
  }
  if (decKey) {
    const item = cart.find((entry) => lineKey(entry) === decKey);
    if (item) {
      item.quantity -= 1;
      if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1);
      saveCart();
      renderCart();
    }
  }
  if (removeKey) {
    const index = cart.findIndex((item) => lineKey(item) === removeKey);
    if (index >= 0) { cart.splice(index, 1); saveCart(); renderCart(); }
  }
});

document.querySelector(".cart")?.addEventListener("click", (event) => {
  event.preventDefault();
  cartPanel.classList.add("open");
});

document.querySelector("#close-cart")?.addEventListener("click", () => cartPanel.classList.remove("open"));
document.querySelector("#cart-continue")?.addEventListener("click", () => cartPanel.classList.remove("open"));

const searchForm = document.querySelector(".search");

searchForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = searchForm.querySelector("input");
  if (input?.value.trim()) {
    location.href = `/urunler?q=${encodeURIComponent(input.value.trim())}`;
  }
});

document.addEventListener("change", (event) => {
  const bulkCard = event.target.closest("[data-bulk-product-id]");
  if (!bulkCard) return;

  if (event.target.matches("[data-bulk-product-select]")) {
    const katlaclar = (window.printableProducts || []).filter((product) => /katlaç|katlac/i.test(product.name || ""));
    const product = katlaclar.find((item) => item.id === Number(event.target.value));
    if (product) bulkCard.outerHTML = bulkProductCardHTML(product, "katlac", katlaclar);
    return;
  }

  if (event.target.matches("[data-bulk-scale-select]")) {
    const product = (window.printableProducts || []).find((item) => item.id === Number(bulkCard.dataset.bulkProductId));
    const scale = productScales(product).find((item) => item.id === Number(event.target.value)) || null;
    const tiers = bulkCard.querySelector("[data-bulk-tiers]");
    if (product && tiers) tiers.innerHTML = bulkTiersHTML(product, scale);
  }
});

searchToggle?.addEventListener("click", () => {
  const isOpen = searchPopover.classList.toggle("open");
  searchToggle.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) searchPopover.querySelector("input")?.focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    searchPopover?.classList.remove("open");
    searchToggle?.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("click", (event) => {
  if (!searchPopover || !searchToggle) return;
  if (searchPopover.contains(event.target) || searchToggle.contains(event.target)) return;
  searchPopover.classList.remove("open");
  searchToggle.setAttribute("aria-expanded", "false");
});

/* Mobil menü. Masaüstünde buton gizli olduğu için bu kod hiç devreye girmez. */
const navToggle = document.querySelector("#nav-toggle");
const mainLinks = document.querySelector("#main-links");

if (navToggle && mainLinks) {
  const setNav = (open) => {
    mainLinks.classList.toggle("open", open);
    navToggle.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Menüyü kapat" : "Menüyü aç");
  };

  navToggle.addEventListener("click", () => setNav(!mainLinks.classList.contains("open")));

  // Bir bağlantıya basınca menü kapanmalı, yoksa yeni sayfada açık kalmış gibi görünür.
  mainLinks.addEventListener("click", (event) => {
    if (event.target.closest("a")) setNav(false);
  });

  // Dışarı tıklama ve Escape ile kapat.
  document.addEventListener("click", (event) => {
    if (!mainLinks.classList.contains("open")) return;
    if (event.target.closest("#main-links") || event.target.closest("#nav-toggle")) return;
    setNav(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setNav(false);
  });
}

/* Bülten formu. Daha önce hiçbir yere bağlı değildi: gönderilince sayfa
   yenileniyor ve e-posta kayboluyordu. */
const newsletterForm = document.querySelector("#newsletter-form");

if (newsletterForm) {
  const msg = document.querySelector("#newsletter-msg");
  const show = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.hidden = false;
    msg.classList.toggle("newsletter__msg--ok", ok === true);
    msg.classList.toggle("newsletter__msg--err", ok === false);
  };

  newsletterForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = newsletterForm.elements.email.value.trim();
    const button = newsletterForm.querySelector("button");
    button.disabled = true;
    show("Kaydediliyor…", null);
    try {
      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Kayıt yapılamadı.");
      newsletterForm.reset();
      show("Teşekkürler! Bültenimize kaydınız alındı.", true);
    } catch (error) {
      show(error.message, false);
    } finally {
      button.disabled = false;
    }
  });
}

document.querySelectorAll("[data-carousel]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!storeProducts) return;
    const direction = button.dataset.carousel === "next" ? 1 : -1;
    storeProducts.scrollBy({
      left: direction * Math.min(620, storeProducts.clientWidth * .82),
      behavior: "smooth"
    });
  });
});

function observeCards() {
  const cards = document.querySelectorAll(".product-card");
  if (!("IntersectionObserver" in window)) {
    cards.forEach((card) => card.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: .18 });
  cards.forEach((card) => observer.observe(card));
}

const heroSlider = document.querySelector(".hero__slider");
const heroSlidesBox = document.querySelector(".hero__slides");
const heroCopy = document.querySelector(".hero__copy");
const heroDots = document.querySelector(".hero__dots");
const HERO_INTERVAL = 6000;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Rebuilds the slide images from the admin-managed banner. The markup already in
// index.html stays as the fallback when the API is unreachable.
function applyHeroSlides(slides) {
  document.querySelectorAll(".hero__slide").forEach((slide) => slide.remove());
  const images = slides.map((slide, i) => {
    const img = document.createElement("img");
    img.className = i === 0 ? "hero__slide is-active" : "hero__slide";
    // Sunucu da aynı boyutu istiyor (renderHero); farklı istesek tarayıcı
    // aynı görseli ikinci kez indirirdi.
    const source = gorselAdresi(slide.image_path, 900);
    const sourceSet = `${source} 900w, ${gorselAdresi(slide.image_path, 1600)} 1600w`;
    if (i === 0) {
      img.src = source;
      img.srcset = sourceSet;
      img.sizes = "100vw";
    } else {
      img.dataset.src = source;
      img.dataset.srcset = sourceSet;
      img.dataset.sizes = "100vw";
    }
    img.alt = slide.image_alt || slide.title || "Printable banner görseli";
    if (i === 0) img.fetchPriority = "high";
    else img.loading = "lazy";
    return img;
  });
  heroSlidesBox.prepend(...images);
}

function renderHeroCopy(slide) {
  if (!slide) return;
  const setButton = (selector, label, href) => {
    const button = heroCopy.querySelector(selector);
    if (!button) return;
    button.hidden = !label;
    button.querySelector("span").textContent = label || "";
    button.href = href || "#";
  };
  heroCopy.querySelector("h1").textContent = slide.title || "";
  heroCopy.querySelector(":scope > span").textContent = slide.subtitle || "";
  setButton(".btn--light", slide.primary_label, slide.primary_href);
  setButton(".btn--ghost", slide.secondary_label, slide.secondary_href);
}

function setupHeroSlider(slides) {
  const images = [...document.querySelectorAll(".hero__slide")];
  if (!heroSlider || images.length < 2) return;

  let index = 0;
  let timer = null;
  let swapTimer = null;

  const dots = images.map((image, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.setAttribute("aria-label", `${i + 1}. görsel`);
    dot.addEventListener("click", () => {
      show(i);
      restart();
    });
    heroDots.append(dot);
    return dot;
  });

  function activate(next) {
    index = next;
    images.forEach((image, i) => image.classList.toggle("is-active", i === index));
    dots.forEach((dot, i) => dot.setAttribute("aria-current", String(i === index)));
    if (!slides?.length) return;

    // Fade the copy out, swap the text mid-fade, fade it back in with the image.
    clearTimeout(swapTimer);
    if (reducedMotion.matches) return renderHeroCopy(slides[index]);
    heroCopy.classList.add("is-swapping");
    swapTimer = setTimeout(() => {
      renderHeroCopy(slides[index]);
      heroCopy.classList.remove("is-swapping");
    }, 250);
  }

  function show(next) {
    const nextIndex = (next + images.length) % images.length;
    const target = images[nextIndex];
    if (!target.dataset.src) return activate(nextIndex);

    const source = target.dataset.src;
    delete target.dataset.src;
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      activate(nextIndex);
    };
    target.addEventListener("load", reveal, { once: true });
    target.addEventListener("error", reveal, { once: true });
    if (target.dataset.srcset) {
      target.srcset = target.dataset.srcset;
      delete target.dataset.srcset;
    }
    if (target.dataset.sizes) {
      target.sizes = target.dataset.sizes;
      delete target.dataset.sizes;
    }
    target.src = source;
    if (target.complete) reveal();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  function restart() {
    stop();
    if (reducedMotion.matches) return;
    timer = setInterval(() => show(index + 1), HERO_INTERVAL);
  }

  document.querySelector(".hero__arrow--prev")?.addEventListener("click", () => {
    show(index - 1);
    restart();
  });
  document.querySelector(".hero__arrow--next")?.addEventListener("click", () => {
    show(index + 1);
    restart();
  });

  heroSlider.addEventListener("mouseenter", stop);
  heroSlider.addEventListener("mouseleave", restart);
  heroSlider.addEventListener("focusin", stop);
  heroSlider.addEventListener("focusout", restart);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : restart()));

  restart();
}

async function loadHeroSlides() {
  if (!heroSlider) return;
  let slides = null;
  let embedded = false;
  const embeddedData = document.querySelector("#hero-slides-data");
  if (embeddedData) {
    try {
      const data = JSON.parse(embeddedData.textContent);
      if (Array.isArray(data) && data.length) {
        slides = data;
        embedded = true;
      }
    } catch { /* Statik fallback aşağıdaki API'yi kullanır. */ }
  }
  if (!slides) {
    try {
      const data = await fetch("/api/hero-slides").then((response) => response.json());
      if (Array.isArray(data) && data.length) slides = data;
    } catch {
      slides = null;
    }
  }
  if (slides && !embedded) {
    applyHeroSlides(slides);
    renderHeroCopy(slides[0]);
  }
  setupHeroSlider(slides);
}

function hydrateGoogleReviews() {
  const section = document.querySelector(".google-reviews-home");
  if (!section) return;
  fetch("/api/google-reviews")
    .then((response) => response.json())
    .then((data) => {
      if (!data.connected) return;
      const summary = section.querySelector(".google-reviews-summary");
      const list = section.querySelector(".google-reviews-grid");
      const footer = section.querySelector(".google-reviews-home__footer");
      if (summary && data.summary) summary.outerHTML = data.summary;
      if (list && data.list) list.innerHTML = data.list;
      if (footer) footer.innerHTML = `${data.disclosure || ""}${data.homeCta || ""}`;
    })
    .catch(() => {});
}

loadProducts();
loadCategories();
loadHeroSlides();
renderCart();
observeCards();
if (document.querySelector(".google-reviews-home")) {
  if ("requestIdleCallback" in window) requestIdleCallback(hydrateGoogleReviews, { timeout: 2500 });
  else setTimeout(hydrateGoogleReviews, 1200);
}

/* Ana sayfa keşif kartı: ilk saniyelerde kullanıcıyı bölmez; biraz gezinince
   veya sayfada yeterince kalınca görünür. Kapatma yalnızca o sayfa içindir. */
function setupDiscoveryPopup() {
  const popup = document.querySelector("#discovery-popup");
  if (!popup) return;

  let minimumDelayPassed = false;
  let shown = false;
  const show = () => {
    if (shown || !minimumDelayPassed) return;
    shown = true;
    popup.hidden = false;
    requestAnimationFrame(() => popup.classList.add("is-visible"));
    window.removeEventListener("scroll", onScroll);
  };
  const onScroll = () => {
    const available = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    if (window.scrollY / available >= 0.35) show();
  };
  const dismiss = () => {
    popup.classList.remove("is-visible");
    setTimeout(() => { popup.hidden = true; }, 220);
  };

  popup.querySelector(".discovery-popup__close")?.addEventListener("click", dismiss);
  window.addEventListener("scroll", onScroll, { passive: true });

  setTimeout(() => {
    minimumDelayPassed = true;
    onScroll();
  }, 8000);
  // Sayfayı okumaya devam eden ama kaydırmayan kullanıcıya da nazikçe göster.
  setTimeout(show, 14000);
}

setupDiscoveryPopup();

const money = (value) => `${Number(value || 0).toFixed(2)} TL`;

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
let storefrontTaxRate = 20;
let freeShippingThreshold = 599;

/* Sepet satırının kimliği ÜRÜN + ÖLÇEK. Aynı katlacın küçük ve büyük boyu iki
   ayrı satır, iki ayrı fiyat; yalnızca ürün id'siyle eşleştirseydik biri
   diğerinin adedine eklenir ve müşteri yanlış boydan sipariş verirdi.
   Ölçeksiz ürünlerde (ve ölçekler eklenmeden önce doldurulmuş eski
   sepetlerde) anahtar "12:" olur — eski satırlar bozulmadan çalışır. */
const lineKey = (item) => `${item.id}:${item.scale_id || ""}`;

// Ürünün müşteriye açık ölçekleri: fiyatı girilmiş, ucuzdan pahalıya sıralı.
const productScales = (product) => (product && product.scales) || [];

/* Karttaki fiyat: ölçekli üründe EN UCUZ ölçeğin fiyatı ("… TL'den başlayan"),
   ölçeksizde varsa indirimli fiyat. Ölçekli üründe sale_price uygulanmaz —
   sunucu da öyle hesaplıyor (normalizeCartItems). */
const displayPrice = (product) => {
  const scales = productScales(product);
  return scales.length ? scales[0].price : (product.sale_price || product.price);
};

const storeProducts = document.querySelector("#store-products");
const cartPanel = document.querySelector("#cart-panel");
const cartCount = document.querySelector("#cart-count");
const cartItems = document.querySelector("#cart-items");
const searchToggle = document.querySelector(".search-toggle");
const searchPopover = document.querySelector(".search-popover");
const customerAccountLink = document.querySelector('a[href="/hesap"].icon-button');
const customerAccountLabel = customerAccountLink?.querySelector(".account-link__label");

if (customerAccountLink) {
  fetch("/api/customer/session")
    .then((response) => response.json())
    .then(({ authed, customer }) => {
      if (!authed) return;
      customerAccountLink.classList.add("is-authenticated");
      if (customerAccountLabel) customerAccountLabel.textContent = customer.name;
      customerAccountLink.setAttribute("aria-label", `${customer.name} hesabı`);
    })
    .catch(() => {});
}

// Shared card markup — reused by every product row on the homepage and by /urunler.
const discountPercent = (product) =>
  product.sale_price && product.price > product.sale_price
    ? Math.round((1 - product.sale_price / product.price) * 100)
    : 0;

// Approved-review average, filled in by the API. No reviews yet → no stars at
// all, rather than an empty 5-star row that reads as a zero score.
const ratingHTML = (product) => product.rating?.count
  ? `<span class="card-rating" aria-label="5 üzerinden ${product.rating.average}">
       <span class="stars">${"★".repeat(Math.round(product.rating.average))}${"☆".repeat(5 - Math.round(product.rating.average))}</span>
       <small>(${product.rating.count})</small>
     </span>`
  : "";

function productCardHTML(product) {
  const off = discountPercent(product);
  const scales = productScales(product);
  /* Ölçekli üründe indirim rozeti ve üstü çizili fiyat gösterilmiyor: fiyat
     ölçekten geliyor, sale_price o üründe uygulanmıyor (bkz. displayPrice). */
  const priceHTML = scales.length
    ? `${money(scales[0].price)}${scales.length > 1 ? `<span class="price-from">'den itibaren</span>` : ""}`
    : `${money(product.sale_price || product.price)}${product.sale_price ? ` <s>${money(product.price)}</s>` : ""}`;
  /* Birden fazla ölçek varsa karttan doğrudan sepete atmıyoruz — hangi boyu
     istediğini müşteri seçmeli; buton ürün sayfasına götürür (bkz. aşağıdaki
     data-add-product işleyicisi). Kartın görünümü değişmesin diye yine
     <button>: .product-card button'un stili dört ayrı katmanda tanımlı,
     yeni bir sınıf onların hepsini yeniden yazmayı gerektirirdi. */
  const action = `<button data-add-product="${product.id}">${
    scales.length > 1 ? "Ölçek seçin" : "Sepete ekle"}</button>`;
  return `
    <article class="product-card">
      ${off && !scales.length ? `<span class="discount-badge">-%${off}</span>` : ""}
      <a class="product-card__link" href="/urun/${product.id}">
        <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}" loading="lazy">
        <h3>${product.name}</h3>
      </a>
      ${ratingHTML(product)}
      <p>${priceHTML} <span class="price-tax">+ KDV</span></p>
      <div class="swatches">${(product.colors || []).map((color) => `<span style="background:${color.hex}" title="${color.name}"></span>`).join("")}</div>
      ${action}
    </article>
  `;
}

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
    const kdvliToplam = Math.round(cartSubtotal() * (1 + storefrontTaxRate / 100) * 100) / 100;
    const kalan = Math.max(0, freeShippingThreshold - kdvliToplam);
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
    const categories = await fetch("/api/categories").then((response) => response.json());
    if (!Array.isArray(categories) || !categories.length) return;
    window.printableCategories = categories;
    categoryGrid.innerHTML = categories.map((category) => `
      <a class="category-card" href="/urunler?kategori=${category.id}">
        <span class="category-card__media">
          <img src="${category.image_path || "/assets/printable-logo.svg"}" alt="${category.image_alt || ""}" loading="lazy">
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

  const off = discountPercent(product);
  const scales = productScales(product);
  const price = displayPrice(product);
  panel.innerHTML = `
    <a class="feature-panel__media" href="/urun/${product.id}">
      ${off && !scales.length ? `<span class="discount-badge">-%${off}</span>` : ""}
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
        <span class="price-tax">+ KDV</span>
      </p>
      <button type="button" data-add-product="${product.id}">${scales.length > 1 ? "Ölçek seçin" : "Sepete ekle"}</button>
    </div>`;
  panel.hidden = false;
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
    const inStock = Number(spinball.stock) > 0;
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
            ${off ? `<span class="fidget-discount">%${off} indirim</span>` : ""}
            <strong>${money(currentPrice)}</strong>
            ${off ? `<s>${money(spinball.price)}</s>` : ""}
            <span class="price-tax">+ KDV</span>
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
              <small>${money(displayPrice(product))}${productScales(product).length > 1 ? "'den itibaren" : ""} <em>+ KDV</em></small>
            </span>
          </a>`).join("")}
      </div>`;
    katlacPanel.hidden = false;
  }
}

// The homepage rows are curated slices of the same catalogue; /urunler owns real filtering.
async function loadProducts() {
  try {
    const products = await fetch("/api/products").then((response) => response.json());
    window.printableProducts = products;
    const active = products.filter((product) => product.is_active);
    fillProductGrid(storeProducts, active);

    // The priciest product leads; the next four support it in the 2x2 grid.
    const featured = [...active].sort((a, b) => (b.sale_price || b.price) - (a.sale_price || a.price));
    renderFeaturePanel(featured[0]);
    fillProductGrid(".js-featured", featured.slice(1, 5));

    fillProductGrid(".js-popular", active.slice(0, 5));
    fillProductGrid(".js-recommended", [...active].reverse().slice(0, 4));
    renderFidgetSpotlight(active);

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
  } catch {
    window.printableProducts = [];
  }
}

/* Add a product to the cart (used by every "Sepete ekle" button across the site).
   scale: müşterinin seçtiği ölçek nesnesi ({id, scale, price}). Verilmezse ve
   ürünün TEK ölçeği varsa o kullanılır — tek seçenekli bir listeden seçim
   istemek gereksiz. Birden fazlaysa çağıran taraf (ürün sayfası) seçtirmek
   zorunda; kartlar bu durumda zaten sepete ekleme butonu göstermiyor. */
function addToCart(product, quantity = 1, scale = null) {
  const scales = productScales(product);
  const secili = scale || (scales.length === 1 ? scales[0] : null);
  const satir = {
    id: product.id,
    scale_id: secili ? secili.id : null,
    scale: secili ? secili.scale : null,
    name: product.name,
    price: secili ? secili.price : (product.sale_price || product.price),
    image: product.image_path || null,
    quantity
  };
  const existing = cart.find((item) => lineKey(item) === lineKey(satir));
  if (existing) existing.quantity += quantity;
  else cart.push(satir);
  saveCart();
  renderCart();
}

document.addEventListener("click", (event) => {
  const addId = event.target.dataset.addProduct;
  const removeKey = event.target.dataset.removeProduct;
  const incKey = event.target.dataset.inc;
  const decKey = event.target.dataset.dec;
  if (addId) {
    const product = (window.printableProducts || []).find((item) => item.id === Number(addId));
    if (!product) return;
    // Ölçek seçilmeden sepete atılamaz: müşteriyi ürün sayfasına gönder.
    if (productScales(product).length > 1) {
      location.href = `/urun/${product.id}`;
      return;
    }
    addToCart(product);
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
    img.src = slide.image_path;
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

  function show(next) {
    index = (next + images.length) % images.length;
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
  try {
    const data = await fetch("/api/hero-slides").then((response) => response.json());
    if (Array.isArray(data) && data.length) slides = data;
  } catch {
    slides = null;
  }
  if (slides) {
    applyHeroSlides(slides);
    renderHeroCopy(slides[0]);
  }
  setupHeroSlider(slides);
}

loadProducts();
loadCategories();
loadHeroSlides();
renderCart();
fetch("/api/site-info").then((response) => response.json()).then((info) => {
  if (Number.isFinite(Number(info.tax_rate))) storefrontTaxRate = Number(info.tax_rate);
  if (Number.isFinite(Number(info.free_shipping_threshold))) {
    freeShippingThreshold = Number(info.free_shipping_threshold);
  }
  renderCart();
}).catch(() => {});
observeCards();

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

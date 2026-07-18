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
const storeProducts = document.querySelector("#store-products");
const cartPanel = document.querySelector("#cart-panel");
const cartCount = document.querySelector("#cart-count");
const cartItems = document.querySelector("#cart-items");
const searchToggle = document.querySelector(".search-toggle");
const searchPopover = document.querySelector(".search-popover");

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
  return `
    <article class="product-card">
      ${off ? `<span class="discount-badge">-%${off}</span>` : ""}
      <a class="product-card__link" href="/urun/${product.id}">
        <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}" loading="lazy">
        <h3>${product.name}</h3>
      </a>
      ${ratingHTML(product)}
      <p>${money(product.sale_price || product.price)}${product.sale_price ? ` <s>${money(product.price)}</s>` : ""} <span class="price-tax">+ KDV</span></p>
      <div class="swatches">${(product.colors || []).map((color) => `<span style="background:${color.hex}" title="${color.name}"></span>`).join("")}</div>
      <button data-add-product="${product.id}">Sepete ekle</button>
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
        <p>${money(item.price)}</p>
        <div class="cart-qty">
          <button type="button" data-dec="${item.id}" aria-label="Azalt">−</button>
          <span>${item.quantity}</span>
          <button type="button" data-inc="${item.id}" aria-label="Artır">+</button>
        </div>
      </div>
      <div class="cart-item__end">
        <strong>${money(item.price * item.quantity)}</strong>
        <button type="button" class="cart-remove" data-remove-product="${item.id}">Kaldır</button>
      </div>
    </article>
  `).join("") || "<p class='cart-empty'>Sepetiniz boş.</p>";

  const footer = document.querySelector("#cart-footer");
  if (footer) footer.hidden = cart.length === 0;
  const subtotalEl = document.querySelector("#cart-subtotal");
  if (subtotalEl) subtotalEl.textContent = money(cartSubtotal());
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

// The one product shown large beside the quad. Its own markup rather than a
// scaled-up .product-card: the card's centred, compact layout does not survive
// being stretched to a full column.
function renderFeaturePanel(product) {
  const panel = document.querySelector("#feature-panel");
  if (!panel) return;
  if (!product) { panel.hidden = true; return; }

  const off = discountPercent(product);
  const price = product.sale_price || product.price;
  panel.innerHTML = `
    <a class="feature-panel__media" href="/urun/${product.id}">
      ${off ? `<span class="discount-badge">-%${off}</span>` : ""}
      <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}" loading="lazy">
    </a>
    <div class="feature-panel__body">
      <p class="section-kicker">Haftanın seçimi</p>
      <h3><a href="/urun/${product.id}">${product.name}</a></h3>
      ${ratingHTML(product)}
      <p class="feature-panel__price">
        ${money(price)}${product.sale_price ? ` <s>${money(product.price)}</s>` : ""}
        <span class="price-tax">+ KDV</span>
      </p>
      <button type="button" data-add-product="${product.id}">Sepete ekle</button>
    </div>`;
  panel.hidden = false;
}

// The homepage rows are curated slices of the same catalogue; /urunler owns real filtering.
async function loadProducts() {
  try {
    const products = await fetch("/api/products").then((response) => response.json());
    window.printableProducts = products;
    const active = products.filter((product) => product.is_active);
    fillProductGrid(storeProducts, active);

    // The priciest goes in the feature panel, the next four fill the 2x2 quad —
    // exactly four, otherwise the block stops being a square.
    const featured = [...active].sort((a, b) => (b.sale_price || b.price) - (a.sale_price || a.price));
    renderFeaturePanel(featured[0]);
    fillProductGrid(".js-featured", featured.slice(1, 5));

    fillProductGrid(".js-popular", active.slice(0, 5));
    fillProductGrid(".js-recommended", [...active].reverse().slice(0, 4));

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

// Add a product to the cart (used by every "Sepete ekle" button across the site).
function addToCart(product, quantity = 1) {
  const existing = cart.find((item) => item.id === product.id);
  if (existing) existing.quantity += quantity;
  else cart.push({
    id: product.id,
    name: product.name,
    price: product.sale_price || product.price,
    image: product.image_path || null,
    quantity
  });
  saveCart();
  renderCart();
}

document.addEventListener("click", (event) => {
  const addId = event.target.dataset.addProduct;
  const removeId = event.target.dataset.removeProduct;
  const incId = event.target.dataset.inc;
  const decId = event.target.dataset.dec;
  if (addId) {
    const product = (window.printableProducts || []).find((item) => item.id === Number(addId));
    if (!product) return;
    addToCart(product);
    cartPanel?.classList.add("open");
  }
  if (incId) {
    const item = cart.find((entry) => entry.id === Number(incId));
    if (item) { item.quantity += 1; saveCart(); renderCart(); }
  }
  if (decId) {
    const item = cart.find((entry) => entry.id === Number(decId));
    if (item) {
      item.quantity -= 1;
      if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1);
      saveCart();
      renderCart();
    }
  }
  if (removeId) {
    const index = cart.findIndex((item) => item.id === Number(removeId));
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
    input.value = "";
    input.placeholder = "Arama sonraki sürümde aktif olacak";
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
observeCards();

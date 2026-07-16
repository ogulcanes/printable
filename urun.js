// Product detail page. Loaded AFTER script.js, so it reuses that file's globals
// (money, productCardHTML, observeCards, cart, renderCart, cartPanel). IIFE keeps
// its own helpers from colliding with script.js's top-level declarations.
(function () {
  const detail = document.querySelector("#product-detail");
  if (!detail) return;

  const match = location.pathname.match(/\/urun\/(\d+)/);
  const id = match ? Number(match[1]) : null;

  const notFound = () => `<p class="products-empty">Ürün bulunamadı. <a href="/urunler">Tüm ürünlere dön</a></p>`;

  if (!id) { detail.innerHTML = notFound(); return; }

  function render(product) {
    const price = product.sale_price || product.price;
    const inStock = product.stock > 0;
    const onSale = product.sale_price && product.price > product.sale_price;
    const off = onSale ? Math.round((1 - product.sale_price / product.price) * 100) : 0;
    const cats = (product.categories || [])
      .map((c) => `<a class="chip" href="/urunler?kategori=${c.id}">${c.name}</a>`).join("");
    const swatches = (product.colors || [])
      .map((c) => `<span class="color-dot" style="background:${c.hex}" title="${c.name}"></span>`).join("");

    detail.innerHTML = `
      <nav class="breadcrumb" aria-label="Sayfa yolu">
        <a href="/">Ana Sayfa</a><span aria-hidden="true">/</span>
        <a href="/urunler">Ürünler</a><span aria-hidden="true">/</span>
        <strong>${product.name}</strong>
      </nav>
      <div class="product-detail__grid">
        <div class="product-detail__media">
          <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.image_alt || product.name}">
        </div>
        <div class="product-detail__info">
          ${cats ? `<div class="product-detail__cats">${cats}</div>` : ""}
          <h1>${product.name}</h1>
          <p class="product-detail__price">${money(price)} <span class="price-tax">+ KDV</span>${onSale ? ` <s>${money(product.price)}</s> <span class="discount-badge">-%${off}</span>` : ""}</p>
          ${onSale ? `<p class="product-detail__save">${money(product.price - product.sale_price)} tasarruf edin</p>` : ""}
          <p class="product-detail__tax">Fiyata KDV eklenir · Kargo alıcı ödemeli</p>
          ${swatches ? `<div class="product-detail__colors"><span>Renkler</span><div class="swatches">${swatches}</div></div>` : ""}
          ${product.description ? `<p class="product-detail__desc">${product.description}</p>` : ""}
          <ul class="product-detail__specs">
            ${product.color ? `<li><span>Malzeme</span><strong>${product.color}</strong></li>` : ""}
            ${product.sku ? `<li><span>Ürün kodu</span><strong>${product.sku}</strong></li>` : ""}
            <li><span>Stok</span><strong class="${inStock ? "spec-in" : "spec-out"}">${inStock ? product.stock + " adet" : "Tükendi"}</strong></li>
          </ul>
          <div class="product-detail__actions">
            <label class="qty-field">Adet
              <input type="number" id="detail-qty" min="1" max="${Math.max(1, product.stock || 99)}" value="1" ${inStock ? "" : "disabled"}>
            </label>
            <button type="button" id="detail-add" ${inStock ? "" : "disabled"}>${inStock ? "Sepete ekle" : "Tükendi"}</button>
            <a class="btn-outline" href="/stl-teklif">Kendi modelinizi bastırın</a>
          </div>
        </div>
      </div>
    `;

    document.querySelector("#detail-add")?.addEventListener("click", () => {
      const qty = Math.max(1, parseInt(document.querySelector("#detail-qty").value, 10) || 1);
      addToCart(product, qty);
      if (typeof cartPanel !== "undefined" && cartPanel) cartPanel.classList.add("open");
    });
  }

  function renderRelated(all, product) {
    const catIds = new Set((product.categories || []).map((c) => c.id));
    const related = all.filter((p) =>
      p.is_active && p.id !== product.id && (p.categories || []).some((c) => catIds.has(c.id))
    ).slice(0, 5);
    if (!related.length) return;
    document.querySelector("#related-products").innerHTML = related.map(productCardHTML).join("");
    document.querySelector("#related-section").hidden = false;
    if (typeof observeCards === "function") observeCards();
  }

  async function init() {
    let product = null;
    let all = [];
    try {
      [product, all] = await Promise.all([
        fetch(`/api/products/${id}`).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/products").then((r) => r.json()).catch(() => [])
      ]);
    } catch { product = null; }
    if (!product || !product.is_active) { detail.innerHTML = notFound(); return; }
    window.printableProducts = all.length ? all : [product]; // so any data-add-product resolves
    render(product);
    renderRelated(all, product);
  }

  init();
})();

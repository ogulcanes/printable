// Catalogue page. Loaded AFTER script.js, so it reuses the globals defined there
// (money, productCardHTML, observeCards) and lets script.js own the cart. Wrapped in
// an IIFE so nothing here collides with script.js's top-level declarations.
(function () {
  const qs = (sel) => document.querySelector(sel);
  const grid = qs("#catalog-grid");
  if (!grid) return;

  const state = {
    categories: new Set(),
    colors: new Set(),
    priceMin: null,
    priceMax: null,
    inStock: false,
    onSale: false,
    sort: "new"
  };
  // Ölçekli üründe sale_price uygulanmıyor (bkz. script.js displayPrice), o
  // yüzden "indirimdekiler" filtresine de girmiyor.
  const isOnSale = (p) => !(p.scales || []).length && p.sale_price && p.price > p.sale_price;
  let products = [];
  let categories = [];
  let colors = [];

  // Fiyat filtresi ve sıralaması ölçekli üründe EN UCUZ ölçeğin fiyatına bakar
  // — kartta gösterilen fiyat da o (script.js: displayPrice).
  const priceOf = (p) => Number(displayPrice(p)) || 0;

  function renderCategoryFilters() {
    qs("#filter-categories").innerHTML = categories.map((category) => `
      <label class="filter-check">
        <input type="checkbox" data-filter="category" value="${category.id}" ${state.categories.has(category.id) ? "checked" : ""}>
        ${category.name}
      </label>
    `).join("") || "<p class='filter-empty'>Kategori yok.</p>";
  }

  function renderColorFilters() {
    qs("#filter-colors").innerHTML = colors.map((color) => `
      <label class="filter-check filter-check--color">
        <input type="checkbox" data-filter="color" value="${color.id}" ${state.colors.has(color.id) ? "checked" : ""}>
        <span class="color-dot" style="background:${color.hex}"></span>${color.name}
      </label>
    `).join("") || "<p class='filter-empty'>Renk yok.</p>";
  }

  function matches(p) {
    if (!p.is_active) return false;
    if (state.categories.size && !(p.categories || []).some((c) => state.categories.has(c.id))) return false;
    if (state.colors.size && !(p.colors || []).some((c) => state.colors.has(c.id))) return false;
    const price = priceOf(p);
    if (state.priceMin != null && price < state.priceMin) return false;
    if (state.priceMax != null && price > state.priceMax) return false;
    if (state.inStock && !(p.stock > 0)) return false;
    if (state.onSale && !isOnSale(p)) return false;
    return true;
  }

  function sortList(list) {
    const copy = [...list];
    if (state.sort === "price-asc") return copy.sort((a, b) => priceOf(a) - priceOf(b));
    if (state.sort === "price-desc") return copy.sort((a, b) => priceOf(b) - priceOf(a));
    if (state.sort === "name") return copy.sort((a, b) => a.name.localeCompare(b.name, "tr"));
    return copy; // "new" — API already returns newest first
  }

  function renderActiveChips() {
    const box = qs("#active-filters");
    const chips = [];
    state.categories.forEach((id) => {
      const c = categories.find((x) => x.id === id);
      if (c) chips.push(`<button type="button" class="chip" data-remove-category="${id}">${c.name} ✕</button>`);
    });
    state.colors.forEach((id) => {
      const c = colors.find((x) => x.id === id);
      if (c) chips.push(`<button type="button" class="chip" data-remove-color="${id}">${c.name} ✕</button>`);
    });
    if (state.priceMin != null || state.priceMax != null) {
      chips.push(`<button type="button" class="chip" data-remove-price>${state.priceMin ?? 0}–${state.priceMax ?? "∞"} TL ✕</button>`);
    }
    if (state.inStock) chips.push(`<button type="button" class="chip" data-remove-stock>Stokta ✕</button>`);
    if (state.onSale) chips.push(`<button type="button" class="chip" data-remove-sale>İndirimli ✕</button>`);
    box.innerHTML = chips.join("");
    box.hidden = chips.length === 0;
  }

  function apply() {
    const list = sortList(products.filter(matches));
    grid.innerHTML = list.map(productCardHTML).join("") || `<p class="products-empty">Seçtiğiniz filtrelere uygun ürün bulunamadı.</p>`;
    qs("#catalog-count").textContent = `${list.length} ürün`;
    renderActiveChips();
    if (typeof observeCards === "function") observeCards();
  }

  // ---- events ----
  qs("#filter-form").addEventListener("change", (event) => {
    const input = event.target;
    if (input.dataset.filter === "category") {
      input.checked ? state.categories.add(Number(input.value)) : state.categories.delete(Number(input.value));
    } else if (input.dataset.filter === "color") {
      input.checked ? state.colors.add(Number(input.value)) : state.colors.delete(Number(input.value));
    } else if (input.id === "in-stock") {
      state.inStock = input.checked;
    } else if (input.id === "on-sale") {
      state.onSale = input.checked;
    }
    apply();
  });

  const readPrice = () => {
    const min = qs("#price-min").value.trim();
    const max = qs("#price-max").value.trim();
    state.priceMin = min === "" ? null : Number(min);
    state.priceMax = max === "" ? null : Number(max);
    apply();
  };
  qs("#price-min").addEventListener("input", readPrice);
  qs("#price-max").addEventListener("input", readPrice);

  qs("#sort-select").addEventListener("change", (event) => {
    state.sort = event.target.value;
    apply();
  });

  qs("#clear-filters").addEventListener("click", () => {
    state.categories.clear();
    state.colors.clear();
    state.priceMin = state.priceMax = null;
    state.inStock = false;
    state.onSale = false;
    state.sort = "new";
    qs("#price-min").value = "";
    qs("#price-max").value = "";
    qs("#in-stock").checked = false;
    qs("#on-sale").checked = false;
    qs("#sort-select").value = "new";
    renderCategoryFilters();
    renderColorFilters();
    apply();
  });

  // Active-filter chips remove their own filter.
  qs("#active-filters").addEventListener("click", (event) => {
    const t = event.target;
    if (t.dataset.removeCategory) state.categories.delete(Number(t.dataset.removeCategory));
    else if (t.dataset.removeColor) state.colors.delete(Number(t.dataset.removeColor));
    else if (t.hasAttribute("data-remove-price")) { state.priceMin = state.priceMax = null; qs("#price-min").value = ""; qs("#price-max").value = ""; }
    else if (t.hasAttribute("data-remove-stock")) { state.inStock = false; qs("#in-stock").checked = false; }
    else if (t.hasAttribute("data-remove-sale")) { state.onSale = false; qs("#on-sale").checked = false; }
    else return;
    renderCategoryFilters();
    renderColorFilters();
    apply();
  });

  /* Mobil: filtreler tam ekran bir katmanda açılır. Seçimler anında uygulanır
     (masaüstündeki davranışın aynısı); "Uygula" yalnızca paneli kapatıp
     sonucu göstermek için var — kullanıcı için beklenen akış bu. */
  const filterPanel = qs("#catalog-filters");
  const backdrop = qs("#filter-backdrop");
  const toggleButton = qs("#filter-toggle");

  const setFilters = (open) => {
    filterPanel.classList.toggle("open", open);
    if (backdrop) backdrop.hidden = !open;
    toggleButton.setAttribute("aria-expanded", String(open));
    // Panel açıkken arka planın kaymasını engelle.
    document.body.classList.toggle("filters-open", open);
  };

  toggleButton.addEventListener("click", () => setFilters(!filterPanel.classList.contains("open")));
  qs("#apply-filters")?.addEventListener("click", () => setFilters(false));
  qs("#close-filters")?.addEventListener("click", () => setFilters(false));
  backdrop?.addEventListener("click", () => setFilters(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && filterPanel.classList.contains("open")) setFilters(false);
  });

  async function init() {
    try {
      [products, categories, colors] = await Promise.all([
        fetch("/api/products").then((r) => r.json()),
        fetch("/api/categories").then((r) => r.json()),
        fetch("/api/colors").then((r) => r.json())
      ]);
    } catch {
      qs("#catalog-count").textContent = "Ürünler yüklenemedi";
      return;
    }
    window.printableProducts = products; // so script.js's add-to-cart can resolve ids
    // Homepage links land here pre-filtered: ?kategori=<id> or ?indirim=1.
    const params = new URLSearchParams(location.search);
    const preset = Number(params.get("kategori"));
    if (preset && categories.some((c) => c.id === preset)) state.categories.add(preset);
    if (params.get("indirim") === "1") { state.onSale = true; qs("#on-sale").checked = true; }
    renderCategoryFilters();
    renderColorFilters();
    apply();
  }

  init();
})();

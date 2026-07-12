const state = {
  products: [],
  customers: [],
  orders: [],
  slides: [],
  categories: [],
  colors: [],
  seo: { pages: [], site: {} }
};

const money = (value) => `${Number(value || 0).toFixed(2)} TL`;
const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const statusClass = {
  new: "orange",
  preparing: "blue",
  printed: "blue",
  shipped: "green",
  delivered: "green",
  cancelled: "orange"
};
const statusLabels = {
  new: "Yeni",
  preparing: "Hazırlanıyor",
  printed: "Basıldı",
  shipped: "Kargoda",
  delivered: "Teslim edildi",
  cancelled: "İptal"
};
const paymentLabels = {
  pending: "Ödeme bekliyor",
  paid: "Ödendi",
  failed: "Başarısız",
  refunded: "İade edildi"
};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("Giriş gerekli");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "İstek başarısız oldu");
  }
  if (response.status === 204) return null;
  return response.json();
}

function showTab(name) {
  qsa(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  qsa(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === name));
}

function renderProducts() {
  qs("#product-count").textContent = `${state.products.length} ürün`;
  qs("#product-list").innerHTML = state.products.map((product) => `
    <article class="row">
      <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="">
      <div>
        <h3>${product.name}</h3>
        <p>${product.description || "Henüz açıklama yok."}</p>
        <div class="meta-line">
          <span class="badge">${product.category || "Kategori yok"}</span>
          <span class="badge">${product.color || "Renk yok"}</span>
          <span class="badge ${product.stock > 0 ? "green" : "orange"}">Stok ${product.stock}</span>
          <span class="badge blue">${money(product.sale_price || product.price)}${product.sale_price ? ` / <s>${money(product.price)}</s>` : ""}</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-edit-product="${product.id}">Düzenle</button>
        <button class="danger" data-delete-product="${product.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz ürün yok.</p>";

  const productSelects = qsa('select[name="product_id"]');
  productSelects.forEach((select) => {
    select.innerHTML = state.products.map((product) => `<option value="${product.id}">${product.name} - ${money(product.sale_price || product.price)}</option>`).join("");
  });
}

function renderSlides() {
  qs("#slide-count").textContent = `${state.slides.length} görsel`;
  qs("#slide-list").innerHTML = state.slides.map((slide) => `
    <article class="row">
      <img src="${slide.image_path}" alt="">
      <div>
        <h3>${slide.title || "Başlıksız banner"}</h3>
        <p>${slide.subtitle || "Alt başlık yok."}</p>
        <div class="meta-line">
          <span class="badge ${slide.is_active ? "green" : "orange"}">${slide.is_active ? "Yayında" : "Gizli"}</span>
          <span class="badge blue">Sıra ${slide.sort_order}</span>
          <span class="badge">${slide.primary_label || "1. buton yok"}</span>
          <span class="badge">${slide.secondary_label || "2. buton yok"}</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-edit-slide="${slide.id}">Düzenle</button>
        <button class="danger" data-delete-slide="${slide.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz banner görseli yok.</p>";
}

function renderColors() {
  qs("#color-count").textContent = `${state.colors.length} renk`;
  qs("#color-list").innerHTML = state.colors.map((color) => `
    <article class="row">
      <span class="color-dot" style="background:${color.hex}"></span>
      <div>
        <h3>${color.name}</h3>
        <p>${color.hex}</p>
        <div class="meta-line">
          <span class="badge ${color.is_active ? "green" : "orange"}">${color.is_active ? "Kullanımda" : "Pasif"}</span>
          <span class="badge blue">Sıra ${color.sort_order}</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-edit-color="${color.id}">Düzenle</button>
        <button class="danger" data-delete-color="${color.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz renk yok.</p>";
}

// Checkbox per palette colour; re-rendered on every refresh, so the product form
// reads its checked state from state.products rather than from the DOM.
function renderProductColorOptions(selectedIds = []) {
  qs("#product-colors").innerHTML = state.colors.map((color) => `
    <label class="color-option">
      <input type="checkbox" name="color_ids" value="${color.id}" ${selectedIds.includes(color.id) ? "checked" : ""}>
      <span class="color-dot" style="background:${color.hex}"></span>
      ${color.name}
    </label>
  `).join("") || "<p>Önce Renkler sekmesinden renk ekleyin.</p>";
}

function renderCategories() {
  qs("#category-count").textContent = `${state.categories.length} kategori`;
  qs("#category-list").innerHTML = state.categories.map((category) => `
    <article class="row">
      <img src="${category.image_path || "/assets/printable-logo.svg"}" alt="">
      <div>
        <h3>${category.name}</h3>
        <p>${category.href || "#store-products"}</p>
        <div class="meta-line">
          <span class="badge ${category.is_active ? "green" : "orange"}">${category.is_active ? "Yayında" : "Gizli"}</span>
          <span class="badge blue">Sıra ${category.sort_order}</span>
          <span class="badge">${category.image_alt || "Alt metin yok"}</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-edit-category="${category.id}">Düzenle</button>
        <button class="danger" data-delete-category="${category.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz kategori yok.</p>";
}

const SEO_PAGE_FIELDS = ["title", "description", "canonical", "og_title", "og_description", "og_image", "robots"];
const SEO_SITE_FIELDS = ["site_name", "site_url", "description", "logo_path", "social_links"];

function fillSeoPageForm(slug) {
  const page = state.seo.pages.find((item) => item.slug === slug);
  if (!page) return;
  const form = qs("#seo-page-form");
  form.elements.slug.value = page.slug;
  SEO_PAGE_FIELDS.forEach((key) => {
    form.elements[key].value = page[key] ?? "";
  });
  form.elements.robots.value = page.robots || "index,follow";
}

function renderSeo() {
  const select = qs("#seo-page-select");
  const selected = select.value || state.seo.pages[0]?.slug;
  select.innerHTML = state.seo.pages
    .map((page) => `<option value="${page.slug}">${page.label}</option>`)
    .join("");
  select.value = selected;
  fillSeoPageForm(select.value);

  const siteForm = qs("#seo-site-form");
  SEO_SITE_FIELDS.forEach((key) => {
    siteForm.elements[key].value = state.seo.site[key] ?? "";
  });
}

function renderCustomers() {
  qs("#customer-count").textContent = `${state.customers.length} kişi`;
  qs("#customer-list").innerHTML = state.customers.map((customer) => `
    <article class="row">
      <span class="brand-mark">${customer.name.slice(0, 1).toUpperCase()}</span>
      <div>
        <h3>${customer.name}</h3>
        <p>${customer.address || "Kayıtlı adres yok."}</p>
        <div class="meta-line">
          <span class="badge">${customer.email || "E-posta yok"}</span>
          <span class="badge">${customer.phone || "Telefon yok"}</span>
          <span class="badge blue">${customer.city || "Şehir yok"}</span>
        </div>
      </div>
      <span></span>
    </article>
  `).join("") || "<p>Henüz müşteri yok.</p>";

  const customerSelects = qsa('select[name="customer_id"]');
  customerSelects.forEach((select) => {
    select.innerHTML = state.customers.map((customer) => `<option value="${customer.id}">${customer.name}</option>`).join("");
  });
}

function renderOrders() {
  qs("#order-count").textContent = `${state.orders.length} sipariş`;
  const markup = state.orders.map((order) => `
    <article class="row">
      <span class="brand-mark">#</span>
      <div>
        <h3>${order.order_number} - ${order.customer_name}</h3>
        <p>${order.items.map((item) => `${item.quantity} adet ${item.product_name}`).join(", ")}</p>
        <div class="meta-line">
          <span class="badge ${statusClass[order.status] || ""}">${statusLabels[order.status] || order.status}</span>
          <span class="badge blue">${money(order.total)}</span>
          <span class="badge">${paymentLabels[order.payment_status] || order.payment_status}</span>
          <span class="badge">${order.tracking_code || "Takip kodu yok"}</span>
        </div>
      </div>
      <div class="row-actions">
        <select data-order-status="${order.id}">
          ${["new", "preparing", "printed", "shipped", "delivered", "cancelled"].map((status) => `<option value="${status}" ${status === order.status ? "selected" : ""}>${statusLabels[status]}</option>`).join("")}
        </select>
        <button data-track-order="${order.id}">Takip</button>
      </div>
    </article>
  `).join("") || "<p>Henüz sipariş yok.</p>";
  qs("#order-list").innerHTML = markup;
  qs("#recent-orders").innerHTML = markup;
}

async function refresh() {
  const [stats, products, customers, orders, slides, categories, colors, seo] = await Promise.all([
    api("/api/stats"),
    api("/api/products"),
    api("/api/customers"),
    api("/api/orders"),
    api("/api/hero-slides?all=1"),
    api("/api/categories?all=1"),
    api("/api/colors?all=1"),
    api("/api/seo")
  ]);
  state.products = products;
  state.customers = customers;
  state.orders = orders;
  state.slides = slides;
  state.categories = categories;
  state.colors = colors;
  state.seo = seo;
  qs("#stat-products").textContent = stats.products;
  qs("#stat-customers").textContent = stats.customers;
  qs("#stat-orders").textContent = stats.orders;
  qs("#stat-revenue").textContent = money(stats.revenue);
  renderProducts();
  renderCustomers();
  renderOrders();
  renderSlides();
  renderCategories();
  renderColors();
  renderProductColorOptions(currentProductColorIds());
  renderSeo();
}

// Preserve the ticked colours across a refresh while editing a product.
function currentProductColorIds() {
  const editingId = Number(qs('#product-form input[name="id"]').value);
  if (!editingId) return qsa('#product-colors input:checked').map((input) => Number(input.value));
  const product = state.products.find((item) => item.id === editingId);
  return (product?.colors || []).map((color) => color.id);
}

qsa(".tab").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
qsa("[data-open-tab]").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.openTab)));

async function loadSession() {
  const session = await api("/api/session");
  if (!session.authed) window.location.href = "/login";
  qs("#session-user").textContent = session.user || "admin";
}

qs("#logout-button").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

qs("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  formData.set("is_active", form.is_active.checked ? "1" : "0");
  const id = formData.get("id");
  await api(id ? `/api/products/${id}` : "/api/products", {
    method: id ? "PUT" : "POST",
    body: formData
  });
  form.reset();
  form.elements.id.value = "";
  form.is_active.checked = true;
  renderProductColorOptions([]);
  await refresh();
});

qs("#reset-product").addEventListener("click", () => {
  qs("#product-form").reset();
  qs('#product-form input[name="id"]').value = "";
  renderProductColorOptions([]);
});

qs("#product-list").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editProduct;
  const deleteId = event.target.dataset.deleteProduct;
  if (editId) {
    const product = state.products.find((item) => item.id === Number(editId));
    const form = qs("#product-form");
    Object.entries(product).forEach(([key, value]) => {
      if (form.elements[key] && key !== "image") form.elements[key].value = value ?? "";
    });
    form.is_active.checked = Boolean(product.is_active);
    renderProductColorOptions((product.colors || []).map((color) => color.id));
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (deleteId && confirm("Bu ürünü silmek istiyor musunuz?")) {
    await api(`/api/products/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

// The <input type="color"> and the hex text box are two views of one value.
qs("#color-picker").addEventListener("input", (event) => {
  qs("#color-hex").value = event.target.value;
});
qs("#color-hex").addEventListener("input", (event) => {
  const hex = event.target.value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) qs("#color-picker").value = hex;
});

function resetColorForm() {
  const form = qs("#color-form");
  form.reset();
  form.elements.id.value = "";
  form.elements.hex.value = "#ff6542";
  qs("#color-hex").value = "#ff6542";
  form.is_active.checked = true;
}

qs("#color-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  await api(id ? `/api/colors/${id}` : "/api/colors", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: form.elements.name.value,
      hex: form.elements.hex.value,
      sort_order: form.elements.sort_order.value,
      is_active: form.is_active.checked ? "1" : "0"
    })
  });
  resetColorForm();
  await refresh();
});

qs("#reset-color").addEventListener("click", resetColorForm);

qs("#color-list").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editColor;
  const deleteId = event.target.dataset.deleteColor;
  if (editId) {
    const color = state.colors.find((item) => item.id === Number(editId));
    const form = qs("#color-form");
    form.elements.id.value = color.id;
    form.elements.name.value = color.name;
    form.elements.hex.value = color.hex;
    qs("#color-hex").value = color.hex;
    form.elements.sort_order.value = color.sort_order;
    form.is_active.checked = Boolean(color.is_active);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (deleteId && confirm("Bu renk silinsin mi? Ürünlerden de kaldırılır.")) {
    await api(`/api/colors/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

function resetCategoryForm() {
  const form = qs("#category-form");
  form.reset();
  form.elements.id.value = "";
  form.is_active.checked = true;
}

qs("#category-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  formData.set("is_active", form.is_active.checked ? "1" : "0");
  const id = formData.get("id");
  await api(id ? `/api/categories/${id}` : "/api/categories", {
    method: id ? "PUT" : "POST",
    body: formData
  });
  resetCategoryForm();
  await refresh();
});

qs("#reset-category").addEventListener("click", resetCategoryForm);

qs("#category-list").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editCategory;
  const deleteId = event.target.dataset.deleteCategory;
  if (editId) {
    const category = state.categories.find((item) => item.id === Number(editId));
    const form = qs("#category-form");
    form.elements.id.value = category.id;
    form.elements.image_url.value = category.image_path || "";
    ["name", "image_alt", "href", "sort_order"].forEach((key) => {
      form.elements[key].value = category[key] ?? "";
    });
    form.is_active.checked = Boolean(category.is_active);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (deleteId && confirm("Bu kategoriyi silmek istiyor musunuz?")) {
    await api(`/api/categories/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

qs("#seo-page-select").addEventListener("change", (event) => fillSeoPageForm(event.target.value));

qs("#seo-page-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api(`/api/seo/pages/${data.slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  await refresh();
  alert("Sayfa SEO ayarları kaydedildi.");
});

qs("#seo-site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api("/api/seo/site", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  await refresh();
  alert("Site ayarları kaydedildi.");
});

function resetSlideForm() {
  const form = qs("#slide-form");
  form.reset();
  form.elements.id.value = "";
  form.is_active.checked = true;
}

qs("#slide-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  formData.set("is_active", form.is_active.checked ? "1" : "0");
  const id = formData.get("id");
  await api(id ? `/api/hero-slides/${id}` : "/api/hero-slides", {
    method: id ? "PUT" : "POST",
    body: formData
  });
  resetSlideForm();
  await refresh();
});

qs("#reset-slide").addEventListener("click", resetSlideForm);

qs("#slide-list").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editSlide;
  const deleteId = event.target.dataset.deleteSlide;
  if (editId) {
    const slide = state.slides.find((item) => item.id === Number(editId));
    const form = qs("#slide-form");
    form.elements.id.value = slide.id;
    form.elements.image_url.value = slide.image_path || "";
    ["image_alt", "title", "subtitle", "primary_label", "primary_href", "secondary_label", "secondary_href", "sort_order"].forEach((key) => {
      form.elements[key].value = slide[key] ?? "";
    });
    form.is_active.checked = Boolean(slide.is_active);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (deleteId && confirm("Bu banner görselini silmek istiyor musunuz?")) {
    await api(`/api/hero-slides/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

qs("#customer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api("/api/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  event.currentTarget.reset();
  await refresh();
});

qs("#order-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_id: data.customer_id,
      shipping_address: data.shipping_address,
      discount: data.discount,
      notes: data.notes,
      items: [{ product_id: data.product_id, quantity: data.quantity }]
    })
  });
  event.currentTarget.reset();
  await refresh();
});

qs("#order-list").addEventListener("change", async (event) => {
  const id = event.target.dataset.orderStatus;
  if (!id) return;
  await api(`/api/orders/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: event.target.value })
  });
  await refresh();
});

document.addEventListener("click", async (event) => {
  const id = event.target.dataset.trackOrder;
  if (!id) return;
  const order = state.orders.find((item) => item.id === Number(id));
  const tracking = prompt("Takip kodu", order.tracking_code || "");
  if (tracking === null) return;
  await api(`/api/orders/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracking_code: tracking })
  });
  await refresh();
});

loadSession()
  .then(refresh)
  .catch((error) => {
    if (error.message !== "Giriş gerekli") alert(error.message);
  });

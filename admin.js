const state = {
  products: [],
  customers: [],
  orders: []
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
  const [stats, products, customers, orders] = await Promise.all([
    api("/api/stats"),
    api("/api/products"),
    api("/api/customers"),
    api("/api/orders")
  ]);
  state.products = products;
  state.customers = customers;
  state.orders = orders;
  qs("#stat-products").textContent = stats.products;
  qs("#stat-customers").textContent = stats.customers;
  qs("#stat-orders").textContent = stats.orders;
  qs("#stat-revenue").textContent = money(stats.revenue);
  renderProducts();
  renderCustomers();
  renderOrders();
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
  await refresh();
});

qs("#reset-product").addEventListener("click", () => {
  qs("#product-form").reset();
  qs('#product-form input[name="id"]').value = "";
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
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (deleteId && confirm("Bu ürünü silmek istiyor musunuz?")) {
    await api(`/api/products/${deleteId}`, { method: "DELETE" });
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

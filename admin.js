const state = {
  products: [],
  customers: [],
  orders: [],
  slides: [],
  categories: [],
  colors: [],
  materials: [],
  quotes: [],
  messages: [],
  reviews: [],
  campaigns: [],
  subscribers: [],
  adminUsers: [],
  settings: {},
  katlac: [],
  sessionUser: null,
  pricing: {},
  seo: { pages: [], site: {} }
};

const money = (value) => `${Number(value || 0).toFixed(2)} TL`;
// Contact messages are public user input — escape before interpolating into innerHTML.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESC[char]);
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
const paymentMethodLabels = {
  havale: "Havale / EFT",
  kapida: "Kapıda ödeme",
  kart: "Kredi / banka kartı"
};

/* Paneldeki form ve buton dinleyicilerinin çoğu async ve try/catch'siz: api()
   hata fırlattığında sözü kimse yakalamıyordu, yani "Kaydet"e basınca hiçbir şey
   olmuyor ve kullanıcı kaydedildi sanıyordu. Tek bir yerden yakalayıp gösteriyoruz. */
window.addEventListener("unhandledrejection", (event) => {
  const message = event.reason?.message || String(event.reason || "");
  if (message === "Giriş gerekli") return;   // api() zaten /login'e yönlendirdi
  event.preventDefault();
  alert(message || "İşlem tamamlanamadı. Lütfen tekrar deneyin.");
});

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

/* Görseli sunucudan geçirmek yerine doğrudan depoya yükler.
   Sunucusuz platformun istek gövdesi sınırı ~4.5 MB; telefonla çekilmiş bir ürün
   fotoğrafı bunu rahatlıkla aşar. Sunucudan imzalı bir adres alıp dosyayı oraya
   yüklüyor, forma yalnızca anahtarı koyuyoruz.

   Depolama yapılandırılmamışsa (yerel geliştirme) dosya formda bırakılır ve
   sunucu eskisi gibi diske yazar. */
async function hoistImageUpload(formData) {
  const file = formData.get("image");
  if (!(file instanceof File) || !file.size) return;

  const signRes = await fetch("/api/uploads/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "image", filename: file.name })
  });
  if (signRes.status === 503) return;            // depolama kapalı → eski yol
  const signed = await signRes.json();
  if (!signRes.ok) throw new Error(signed.error || "Yükleme adresi alınamadı.");

  const put = await fetch(signed.signedUrl, { method: "PUT", body: file });
  if (!put.ok) throw new Error("Görsel yüklenemedi.");

  formData.delete("image");
  formData.set("image_key", signed.path);
}

function showTab(name) {
  qsa(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  qsa(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === name));
}

/* Ürün listesi arama/filtre durumu. Liste her refresh()'te sıfırdan
   çizildiği için filtre DOM'dan değil buradan okunur; aksi halde kaydetme
   sonrası filtre kendiliğinden sıfırlanırdı. */
const productFilters = { search: "", category: "", state: "", sort: "new" };

function filteredProducts() {
  const ara = productFilters.search.trim().toLocaleLowerCase("tr");
  let liste = state.products.filter((p) => {
    if (ara) {
      const havuz = [p.name, p.sku, p.description].filter(Boolean).join(" ").toLocaleLowerCase("tr");
      if (!havuz.includes(ara)) return false;
    }
    if (productFilters.category && !(p.categories || []).some((c) => String(c.id) === productFilters.category)) return false;
    if (productFilters.state === "active" && !p.is_active) return false;
    if (productFilters.state === "passive" && p.is_active) return false;
    if (productFilters.state === "sale" && !(p.sale_price && p.price > p.sale_price)) return false;
    if (productFilters.state === "nostock" && p.stock > 0) return false;
    return true;
  });

  const fiyat = (p) => Number(p.sale_price || p.price) || 0;
  if (productFilters.sort === "name") liste = [...liste].sort((a, b) => a.name.localeCompare(b.name, "tr"));
  else if (productFilters.sort === "price-asc") liste = [...liste].sort((a, b) => fiyat(a) - fiyat(b));
  else if (productFilters.sort === "price-desc") liste = [...liste].sort((a, b) => fiyat(b) - fiyat(a));
  else if (productFilters.sort === "stock") liste = [...liste].sort((a, b) => b.stock - a.stock);
  return liste;   // "new" → API zaten en yeniyi başa koyuyor
}

function renderProductFilterOptions() {
  const secim = qs("#product-filter-category");
  const onceki = productFilters.category;
  secim.innerHTML = '<option value="">Tüm kategoriler</option>'
    + state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  secim.value = onceki;
}

function renderProducts() {
  renderProductFilterOptions();
  const gosterilen = filteredProducts();
  const suzuluyor = gosterilen.length !== state.products.length;
  qs("#product-count").textContent = suzuluyor
    ? `${gosterilen.length} / ${state.products.length} ürün`
    : `${state.products.length} ürün`;
  qs("#product-list").innerHTML = gosterilen.map((product) => `
    <article class="row">
      <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="">
      <div>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.description) || "Henüz açıklama yok."}</p>
        <div class="meta-line">
          ${(product.categories || []).map((category) => `<span class="badge">${escapeHtml(category.name)}</span>`).join("") || '<span class="badge">Kategori yok</span>'}
          <span class="badge">${escapeHtml(product.color) || "Renk yok"}</span>
          <span class="badge ${product.stock > 0 ? "green" : "orange"}">Stok ${product.stock}</span>
          <span class="badge blue">${money(product.sale_price || product.price)}${product.sale_price ? ` / <s>${money(product.price)}</s>` : ""}</span>
          ${product.sale_price && product.price > 0 ? `<span class="badge orange">%${Math.round((1 - product.sale_price / product.price) * 100)} indirim</span>` : ""}
          ${product.rating?.count ? `<span class="badge">${product.rating.average} ★ (${product.rating.count} yorum)</span>` : ""}
          <span class="badge">Eklendi: ${formatDateTime(product.created_at)}</span>
        </div>
        <div class="price-history" data-history-for="${product.id}" hidden></div>
      </div>
      <div class="row-actions">
        <button data-edit-product="${product.id}">Düzenle</button>
        <button data-history-product="${product.id}">Fiyat geçmişi</button>
        <button class="danger" data-delete-product="${product.id}">Sil</button>
      </div>
    </article>
  `).join("") || (state.products.length
    ? "<p>Aramanıza uyan ürün yok. <button type='button' class='link-button' id='product-empty-clear'>Filtreleri temizle</button></p>"
    : "<p>Henüz ürün yok.</p>");

  const productSelects = qsa('select[name="product_id"]');
  productSelects.forEach((select) => {
    select.innerHTML = state.products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)} - ${money(product.sale_price || product.price)}</option>`).join("");
  });
}

function renderSlides() {
  qs("#slide-count").textContent = `${state.slides.length} görsel`;
  qs("#slide-list").innerHTML = state.slides.map((slide) => `
    <article class="row">
      <img src="${slide.image_path}" alt="">
      <div>
        <h3>${escapeHtml(slide.title) || "Başlıksız banner"}</h3>
        <p>${escapeHtml(slide.subtitle) || "Alt başlık yok."}</p>
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

const quoteStatusLabels = {
  new: "Yeni",
  contacted: "İletişime geçildi",
  quoted: "Fiyat verildi",
  won: "Kazanıldı",
  lost: "Kaybedildi"
};

function renderMaterials() {
  qs("#material-count").textContent = `${state.materials.length} malzeme`;
  qs("#material-list").innerHTML = state.materials.map((material) => `
    <article class="row">
      <span class="brand-mark">${material.name.slice(0, 1).toUpperCase()}</span>
      <div>
        <h3>${escapeHtml(material.name)}</h3>
        <p>${escapeHtml(material.description) || "Açıklama yok."}</p>
        <div class="meta-line">
          <span class="badge blue">${money(material.price_per_cm3)} / cm³</span>
          <span class="badge ${material.is_active ? "green" : "orange"}">${material.is_active ? "Kullanımda" : "Pasif"}</span>
          <span class="badge">Sıra ${material.sort_order}</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-edit-material="${material.id}">Düzenle</button>
        <button class="danger" data-delete-material="${material.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz malzeme yok.</p>";

  const form = qs("#pricing-form");
  ["setup_fee", "size_fee_per_cm", "min_order_total", "shell_share", "color_change_fee", "tax_rate"].forEach((key) => {
    form.elements[key].value = state.pricing[key] ?? "";
  });
}

function renderQuotes() {
  qs("#quote-count").textContent = `${state.quotes.length} teklif`;
  qs("#quote-list").innerHTML = state.quotes.map((quote) => `
    <article class="row">
      <span class="brand-mark">3D</span>
      <div>
        <h3>${escapeHtml(quote.quote_number)} - ${escapeHtml(quote.customer_name)}</h3>
        <p>${escapeHtml(quote.file_name) || "Dosya yok"} | ${quote.width ?? "?"} x ${quote.height ?? "?"} x ${quote.depth ?? "?"} mm | ${Number(quote.volume_cm3).toFixed(2)} cm³</p>
        <div class="meta-line">
          <span class="badge ${quote.status === "new" ? "orange" : "green"}">${quoteStatusLabels[quote.status] || quote.status}</span>
          <span class="badge blue">${money(quote.total)}</span>
          ${quote.painted ? '<span class="badge orange">Boyalı 3MF - orijinal dosyayla basın</span>' : ""}
          ${(() => {
            const colors = new Set((quote.parts || []).map((p) => p.color_name).filter(Boolean)).size;
            return colors > 1 ? `<span class="badge orange">${colors} renk - filament değişimi</span>` : "";
          })()}
          <span class="badge">${escapeHtml(quote.material_name) || "-"}</span>
          <span class="badge">%${quote.infill} dolgu</span>
          <span class="badge">${quote.quantity} adet</span>
          <span class="badge">${escapeHtml(quote.email || quote.phone) || "-"}</span>
        </div>
        <div class="meta-line">
          ${(quote.parts || []).length
            ? quote.parts.map((part) => `
                <span class="badge">
                  <span class="color-dot" style="background:${escapeHtml(part.color_hex) || "#ddd"}"></span>
                  ${escapeHtml(part.name) || `Parça ${part.part_index}`}: ${escapeHtml(part.color_name) || "renk yok"} (${Number(part.volume_cm3).toFixed(2)} cm³)
                  ${part.file_path ? `<a href="${escapeHtml(part.file_path)}" download>STL</a>` : ""}
                </span>
              `).join("")
            : `<span class="badge">${escapeHtml(quote.color_name) || "Renk yok"}</span>`}
        </div>
        ${quote.note ? `<p>Not: ${escapeHtml(quote.note)}</p>` : ""}
      </div>
      <div class="row-actions">
        ${quote.file_path ? `<a class="small-button" href="${escapeHtml(quote.file_path)}" download>STL indir</a>` : ""}
        <select data-quote-status="${quote.id}">
          ${Object.entries(quoteStatusLabels).map(([value, label]) => `<option value="${value}" ${value === quote.status ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        <button class="danger" data-delete-quote="${quote.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz teklif yok.</p>";
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

// Same pattern as the colour checkboxes: a product can be in several categories,
// posted as repeated category_ids. Checked state is restored from state, not the DOM.
function renderProductCategoryOptions(selectedIds = []) {
  qs("#product-categories").innerHTML = state.categories.map((category) => `
    <label class="color-option">
      <input type="checkbox" name="category_ids" value="${category.id}" ${selectedIds.includes(category.id) ? "checked" : ""}>
      ${category.name}
    </label>
  `).join("") || "<p>Önce Kategoriler sekmesinden kategori ekleyin.</p>";
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
const SEO_SITE_FIELDS = ["site_name", "site_url", "description", "logo_path", "default_og_image", "phone", "email", "whatsapp", "contact_address", "working_hours", "social_links"];

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
    // Guarded: a browser holding a cached admin.html without a field this list
    // knows about would otherwise throw here and take the whole SEO tab down.
    const field = siteForm.elements[key];
    if (field) field.value = state.seo.site[key] ?? "";
  });
}

function renderCustomers() {
  qs("#customer-count").textContent = `${state.customers.length} kişi`;
  qs("#customer-list").innerHTML = state.customers.map((customer) => `
    <article class="row">
      <span class="brand-mark">${escapeHtml(customer.name.slice(0, 1).toUpperCase())}</span>
      <div>
        <h3>${escapeHtml(customer.name)}</h3>
        <p>${escapeHtml(customer.address) || "Kayıtlı adres yok."}</p>
        <div class="meta-line">
          <span class="badge">${escapeHtml(customer.email) || "E-posta yok"}</span>
          <span class="badge">${escapeHtml(customer.phone) || "Telefon yok"}</span>
          <span class="badge blue">${escapeHtml(customer.city) || "Şehir yok"}</span>
        </div>
      </div>
      <span></span>
    </article>
  `).join("") || "<p>Henüz müşteri yok.</p>";

  const customerSelects = qsa('select[name="customer_id"]');
  customerSelects.forEach((select) => {
    select.innerHTML = state.customers.map((customer) => `<option value="${customer.id}">${escapeHtml(customer.name)}</option>`).join("");
  });
}

function renderOrders() {
  qs("#order-count").textContent = `${state.orders.length} sipariş`;
  const markup = state.orders.map((order) => `
    <article class="row">
      <span class="brand-mark">#</span>
      <div>
        <h3>${escapeHtml(order.order_number)} - ${escapeHtml(order.customer_name)}</h3>
        <p>${order.items.map((item) => `${item.quantity} adet ${escapeHtml(item.product_name)}`).join(", ")}</p>
        <div class="meta-line">
          <span class="badge ${statusClass[order.status] || ""}">${statusLabels[order.status] || order.status}</span>
          <span class="badge blue">${money(order.total)}</span>
          <span class="badge">KDV %${order.tax_rate ?? 20}: ${money(order.tax_amount)}</span>
          <span class="badge">Kargo: ${order.shipping_method === "recipient_paid" ? "Alıcı ödemeli" : "-"}</span>
          <span class="badge">${paymentLabels[order.payment_status] || order.payment_status}</span>
          <span class="badge">${paymentMethodLabels[order.payment_method] || "Ödeme yöntemi belirtilmemiş"}</span>
          <span class="badge">${escapeHtml(order.tracking_code) || "Takip kodu yok"}</span>
        </div>
        <div class="meta-line">
          <span class="badge ${order.invoice_type === "corporate" ? "blue" : ""}">${order.invoice_type === "corporate" ? "Kurumsal fatura" : "Bireysel fatura"}</span>
          ${order.invoice_type === "corporate"
            ? `<span class="badge">${escapeHtml(order.company_name) || "-"}</span><span class="badge">VKN ${escapeHtml(order.tax_number) || "-"}</span><span class="badge">${escapeHtml(order.tax_office) || "-"}</span>`
            : `<span class="badge">TC ${escapeHtml(order.tc_no) || "-"}</span>`}
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

function renderMessages() {
  const unread = state.messages.filter((m) => !m.is_read).length;
  qs("#message-count").textContent = `${state.messages.length} mesaj${unread ? ` · ${unread} okunmamış` : ""}`;
  qs("#message-list").innerHTML = state.messages.map((m) => `
    <article class="row ${m.is_read ? "" : "row--unread"}">
      <span class="brand-mark">✉</span>
      <div>
        <h3>${escapeHtml(m.name)}${m.subject ? ` — ${escapeHtml(m.subject)}` : ""} ${m.is_read ? "" : '<span class="badge orange">Yeni</span>'}</h3>
        <p>${escapeHtml(m.message)}</p>
        <div class="meta-line">
          <span class="badge">${escapeHtml(m.email) || "E-posta yok"}</span>
          <span class="badge">${escapeHtml(m.phone) || "Telefon yok"}</span>
          <span class="badge">${formatDateTime(m.created_at)}</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-toggle-message="${m.id}" data-read="${m.is_read ? 1 : 0}">${m.is_read ? "Okunmadı yap" : "Okundu yap"}</button>
        <button class="danger" data-delete-message="${m.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz mesaj yok.</p>";
}

// Yıldızlar metin olarak — puan 1-5 tam sayı, yarım yıldız yok.
const starsHtml = (rating) =>
  `<span class="stars" aria-label="5 üzerinden ${rating}">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>`;

function renderSubscribers() {
  qs("#subscriber-count").textContent = `${state.subscribers.length} abone`;
  // E-posta adresleri herkese açık formdan geliyor — escapeHtml zorunlu.
  qs("#subscriber-list").innerHTML = state.subscribers.map((s) => `
    <article class="row">
      <span class="brand-mark">@</span>
      <div>
        <h3>${escapeHtml(s.email)}</h3>
        <div class="meta-line"><span class="badge">${formatDateTime(s.created_at)}</span></div>
      </div>
      <div class="row-actions">
        <button class="danger" data-delete-subscriber="${s.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz abone yok.</p>";
}

function renderAdminUsers() {
  qs("#admin-count").textContent = `${state.adminUsers.length} yönetici`;
  qs("#admin-list").innerHTML = state.adminUsers.map((a) => {
    const self = a.username === state.sessionUser;
    return `
    <article class="row">
      <span class="brand-mark">${escapeHtml(a.username.slice(0, 1).toUpperCase())}</span>
      <div>
        <h3>${escapeHtml(a.username)}${self ? ' <span class="badge blue">siz</span>' : ""}</h3>
        <div class="meta-line"><span class="badge">Eklendi: ${formatDateTime(a.created_at)}</span></div>
      </div>
      <div class="row-actions">
        <button data-reset-admin="${a.id}" data-admin-name="${escapeHtml(a.username)}">Şifre ver</button>
        ${self ? "" : `<button class="danger" data-delete-admin="${a.id}" data-admin-name="${escapeHtml(a.username)}">Sil</button>`}
      </div>
    </article>
  `;
  }).join("") || "<p>Henüz yönetici yok.</p>";
}

function renderSettings() {
  const form = qs("#settings-form");
  form.elements.show_stock.checked = Number(state.settings.show_stock) === 1;
  form.elements.track_stock.checked = Number(state.settings.track_stock) === 1;
  form.elements.min_cart_total.value = Number(state.settings.min_cart_total) || 0;
  ["company_title", "legal_address", "tax_office", "tax_number", "mersis", "return_address"]
    .forEach((alan) => { form.elements[alan].value = state.settings[alan] || ""; });
}

function renderReviews() {
  const pending = state.reviews.filter((r) => !r.is_approved).length;
  qs("#review-count").textContent =
    `${state.reviews.length} yorum${pending ? ` · ${pending} onay bekliyor` : ""}`;
  // author_name ve comment herkese açık girdidir — escapeHtml zorunlu.
  qs("#review-list").innerHTML = state.reviews.map((r) => `
    <article class="row ${r.is_approved ? "" : "row--unread"}">
      <span class="brand-mark">${r.rating}★</span>
      <div>
        <h3>${escapeHtml(r.author_name)} — ${escapeHtml(r.product_name) || "Silinmiş ürün"}
          ${r.is_approved ? '<span class="badge green">Yayında</span>' : '<span class="badge orange">Onay bekliyor</span>'}
        </h3>
        <p>${escapeHtml(r.comment) || "<em>Yorum yazılmamış, sadece puan verilmiş.</em>"}</p>
        <div class="meta-line">
          <span class="badge">${starsHtml(r.rating)}</span>
          <span class="badge">${formatDateTime(r.created_at)}</span>
        </div>
      </div>
      <div class="row-actions">
        <button data-toggle-review="${r.id}" data-approved="${r.is_approved ? 1 : 0}">
          ${r.is_approved ? "Yayından kaldır" : "Onayla"}
        </button>
        <button class="danger" data-delete-review="${r.id}">Sil</button>
      </div>
    </article>
  `).join("") || "<p>Henüz yorum yok.</p>";
}

/* ---------- kampanyalar ---------- */

const campaignRule = (c) => {
  const parts = [];
  parts.push(c.code ? `Kod: ${escapeHtml(c.code)}` : "Otomatik uygulanır");
  parts.push(c.kind === "gift"
    ? `Hediye: ${escapeHtml(state.products.find((p) => p.id === c.gift_product_id)?.name || "ürün silinmiş")} x${c.gift_quantity}`
    : c.discount_type === "percent" ? `%${c.discount_value} indirim` : `${money(c.discount_value)} indirim`);
  parts.push({ all: "Tüm ürünler", products: "Seçili ürünler", categories: "Seçili kategoriler" }[c.scope]);
  if (c.min_quantity) parts.push(`en az ${c.min_quantity} adet`);
  if (c.min_order_total) parts.push(`en az ${money(c.min_order_total)}`);
  return parts.join(" · ");
};

function renderCampaigns() {
  const active = state.campaigns.filter((c) => c.is_active).length;
  qs("#campaign-count").textContent = `${state.campaigns.length} kampanya${active ? ` · ${active} aktif` : ""}`;
  qs("#campaign-list").innerHTML = state.campaigns.map((c) => {
    const limitText = c.usage_limit ? `${c.used_count}/${c.usage_limit} kullanıldı` : `${c.used_count} kez kullanıldı`;
    const dates = [c.starts_at, c.ends_at].filter(Boolean).join(" → ");
    return `
      <article class="row ${c.is_active ? "" : "row--unread"}">
        <span class="brand-mark">${c.kind === "gift" ? "🎁" : "%"}</span>
        <div>
          <h3>${escapeHtml(c.name)}
            ${c.is_active ? '<span class="badge green">Aktif</span>' : '<span class="badge orange">Pasif</span>'}
            ${c.code ? '<span class="badge blue">Kodlu</span>' : '<span class="badge">Otomatik</span>'}
          </h3>
          <p>${campaignRule(c)}</p>
          <div class="meta-line">
            <span class="badge">${limitText}</span>
            ${dates ? `<span class="badge">${dates}</span>` : ""}
          </div>
        </div>
        <div class="campaign-uses" data-uses-for="${c.id}" hidden></div>
        <div class="row-actions">
          <button data-edit-campaign="${c.id}">Düzenle</button>
          <button data-uses-campaign="${c.id}">Kullananlar</button>
          <button data-toggle-campaign="${c.id}" data-active="${c.is_active ? 1 : 0}">${c.is_active ? "Pasife al" : "Aktifleştir"}</button>
          <button class="danger" data-delete-campaign="${c.id}">Sil</button>
        </div>
      </article>`;
  }).join("") || "<p>Henüz kampanya yok.</p>";
}

// Kapsam ve tür seçimine göre ilgili alanları göster; gizli alanlar formu kirletmesin.
function syncCampaignFields() {
  const form = qs("#campaign-form");
  const kind = form.elements.kind.value;
  const scope = form.elements.scope.value;
  qs("[data-campaign-discount]").hidden = kind !== "discount";
  qs("[data-campaign-gift]").hidden = kind !== "gift";
  qs("[data-campaign-products]").hidden = scope !== "products";
  qs("[data-campaign-categories]").hidden = scope !== "categories";
  form.elements.discount_value.required = kind === "discount";
}

function renderCampaignOptions(campaign) {
  const productIds = new Set(campaign?.product_ids || []);
  const categoryIds = new Set(campaign?.category_ids || []);
  qs("#campaign-products").innerHTML = state.products.map((p) => `
    <label class="color-option">
      <input type="checkbox" name="product_ids" value="${p.id}" ${productIds.has(p.id) ? "checked" : ""}>
      ${escapeHtml(p.name)}
    </label>`).join("") || "<p>Ürün yok.</p>";
  qs("#campaign-categories").innerHTML = state.categories.map((c) => `
    <label class="color-option">
      <input type="checkbox" name="category_ids" value="${c.id}" ${categoryIds.has(c.id) ? "checked" : ""}>
      ${escapeHtml(c.name)}
    </label>`).join("") || "<p>Kategori yok.</p>";
  qs("#campaign-gift-product").innerHTML = state.products.map((p) =>
    `<option value="${p.id}" ${campaign?.gift_product_id === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`
  ).join("");
}

async function refresh() {
  const [stats, products, customers, orders, slides, categories, colors, materials, quotes, pricing, seo, messages, reviews, campaigns, subscribers, adminUsers, settings, katlac] = await Promise.all([
    api("/api/stats"),
    api("/api/products"),
    api("/api/customers"),
    api("/api/orders"),
    api("/api/hero-slides?all=1"),
    api("/api/categories?all=1"),
    api("/api/colors?all=1"),
    api("/api/materials?all=1"),
    api("/api/quotes"),
    api("/api/pricing"),
    api("/api/seo"),
    api("/api/messages"),
    api("/api/reviews"),
    api("/api/campaigns"),
    api("/api/subscribers"),
    api("/api/admin-users"),
    api("/api/settings"),
    api("/api/katlac")
  ]);
  state.products = products;
  state.customers = customers;
  state.orders = orders;
  state.slides = slides;
  state.categories = categories;
  state.colors = colors;
  state.materials = materials;
  state.quotes = quotes;
  state.pricing = pricing;
  state.seo = seo;
  state.messages = messages;
  state.reviews = reviews;
  state.campaigns = campaigns;
  state.adminUsers = adminUsers;
  state.settings = settings;
  state.katlac = katlac;
  state.subscribers = subscribers;
  qs("#stat-products").textContent = stats.products;
  qs("#stat-customers").textContent = stats.customers;
  qs("#stat-orders").textContent = stats.orders;
  qs("#stat-revenue").textContent = money(stats.revenue);
  qs("#stat-quotes").textContent = stats.quotes;
  renderProducts();
  renderCustomers();
  renderOrders();
  renderSlides();
  renderCategories();
  renderColors();
  renderMaterials();
  renderQuotes();
  renderMessages();
  renderReviews();
  renderCampaigns();
  renderSubscribers();
  renderAdminUsers();
  renderSettings();
  renderKatlac();
  // Yalnızca düzenlenmiyorken sıfırla — düzenleme sırasındaki seçimler kaybolmasın.
  if (!qs('#campaign-form input[name="id"]').value) renderCampaignOptions(null);
  syncCampaignFields();
  renderProductColorOptions(currentProductColorIds());
  renderProductCategoryOptions(currentProductCategoryIds());
  renderSeo();
}

qs("#message-list").addEventListener("click", async (event) => {
  const toggleId = event.target.dataset.toggleMessage;
  const deleteId = event.target.dataset.deleteMessage;
  if (toggleId) {
    const wasRead = event.target.dataset.read === "1";
    await api(`/api/messages/${toggleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_read: !wasRead })
    });
    await refresh();
  }
  if (deleteId && confirm("Bu mesaj silinsin mi?")) {
    await api(`/api/messages/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

qs("#subscriber-list").addEventListener("click", async (event) => {
  const id = event.target.dataset.deleteSubscriber;
  if (id && confirm("Bu abone silinsin mi?")) {
    await api(`/api/subscribers/${id}`, { method: "DELETE" });
    await refresh();
  }
});

/* İki kart tek forma bağlı: hangi butona basılırsa basılsın ayarların tamamı
   birlikte kaydedilir. Ayrı ayrı PUT etmek, ikinci kaydın birincinin
   alanlarını sıfırlamasına yol açardı. */
/* ---------- Ürün galerisi ----------
   Galeri yalnızca KAYITLI bir ürün için anlamlı: fotoğraf product_id'ye
   bağlanıyor, dolayısıyla yeni ürün formunda gizli tutuluyor. */
let galeriUrunId = null;

function renderGallery(product) {
  galeriUrunId = product?.id || null;
  const alan = qs("#product-gallery-field");
  const ipucu = qs("#product-gallery-hint");
  alan.hidden = !galeriUrunId;
  ipucu.hidden = Boolean(galeriUrunId);
  if (!galeriUrunId) return;

  // Renk atama listesi: yalnızca bu ürüne tanımlı renkler.
  const urunRenkleri = product.colors || [];
  qs("#gallery-color").innerHTML = '<option value="">Renk atama (isteğe bağlı)</option>'
    + urunRenkleri.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  const renkAdi = (id) => urunRenkleri.find((c) => c.id === id)?.name || "";
  const foto = product.images || [];

  qs("#product-gallery").innerHTML = foto.map((g, i) => `
    <figure class="gallery-item">
      <img src="${escapeHtml(g.image_path)}" alt="${escapeHtml(g.image_alt) || ""}">
      <figcaption>
        <select data-gallery-color="${g.id}">
          <option value="">Renk yok</option>
          ${urunRenkleri.map((c) => `<option value="${c.id}" ${c.id === g.color_id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
        </select>
        ${g.color_id && !renkAdi(g.color_id) ? '<span class="badge orange">Renk silinmiş</span>' : ""}
        <input type="text" data-gallery-alt="${g.id}" value="${escapeHtml(g.image_alt) || ""}" placeholder="Alt metin (SEO)">
        <div class="gallery-item__actions">
          <button type="button" class="small-button" data-gallery-up="${g.id}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="small-button" data-gallery-down="${g.id}" ${i === foto.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" class="small-button" data-gallery-cover="${g.id}">Kapak yap</button>
          <button type="button" class="small-button danger" data-gallery-delete="${g.id}">Sil</button>
        </div>
      </figcaption>
    </figure>
  `).join("") || "<p class='field-note'>Henüz galeri fotoğrafı yok.</p>";
}

// Düzenlenen ürünü state'ten tazeleyip galeriyi yeniden çizer.
async function galeriyiTazele() {
  if (!galeriUrunId) return;
  await refresh();
  const guncel = state.products.find((p) => p.id === galeriUrunId);
  if (guncel) renderGallery(guncel);
}

/* ---------- 3D baskı maliyet hesaplayıcı ----------
   Hesap tarayıcıda: her tuş vuruşunda sunucuya gitmek gereksiz gecikme
   olurdu. Sunucu yalnızca girdileri saklıyor (/api/cost-settings). */

const COST_ALANLAR = ["adet", "agirlik", "sure", "filamentFiyat", "elektrikFiyat", "guc",
  "iscilik", "amortisman", "fire", "kira", "aylikCalisma", "karMarji",
  "kargo", "kdv", "komisyon", "belirlenen"];

const yuvarla = (x) => Math.round((Number(x) || 0) * 100) / 100;

function costGirdileri() {
  const form = qs("#cost-form");
  const g = {};
  COST_ALANLAR.forEach((a) => { g[a] = Number(form.elements[a].value) || 0; });
  return g;
}

/* Google Sheets tablosundaki 12 çıktının birebir karşılığı. Sıra ve adlar
   kasıtlı olarak aynı: yan yana koyup karşılaştırılabilsin. */
function costHesapla(g) {
  const malzeme = (g.agirlik / 1000) * g.filamentFiyat * (1 + g.fire / 100) * g.adet;
  const elektrik = (g.guc / 1000) * g.sure * g.elektrikFiyat * g.adet;
  // Kira saatlik maliyete çevrilir; aylık çalışma 0 ise sıfıra bölmeyi önle.
  const kiraPayi = g.aylikCalisma > 0 ? (g.kira / g.aylikCalisma) * g.sure : 0;
  const iscilikAmortisman = (g.iscilik + g.amortisman + kiraPayi) * g.adet;
  const netMaliyet = malzeme + elektrik + iscilikAmortisman;

  const karliFiyat = netMaliyet * (1 + g.karMarji / 100);
  const kargoDahil = karliFiyat + g.kargo;
  const kdvTutari = kargoDahil * (g.kdv / 100);
  const kdvDahil = kargoDahil + kdvTutari;
  const komisyonFiyati = kdvDahil * (g.komisyon / 100);
  const komisyonKdv = komisyonFiyati * 0.20;          // hizmet bedeli KDV'si
  const komisyonlaFiyat = kdvDahil + komisyonFiyati + komisyonKdv;
  const fark = g.belirlenen - komisyonlaFiyat;

  return { malzeme, elektrik, iscilikAmortisman, netMaliyet, karliFiyat, kargoDahil,
    kdvTutari, kdvDahil, komisyonFiyati, komisyonKdv, komisyonlaFiyat, fark };
}

function renderCost() {
  const g = costGirdileri();
  const h = costHesapla(g);

  const satir = (etiket, deger, sinif = "") =>
    `<div class="cost-cell ${sinif}"><span>${etiket}</span><strong>${money(yuvarla(deger))}</strong></div>`;

  qs("#cost-results").innerHTML = [
    satir("Toplam malzeme mâliyeti", h.malzeme),
    satir("Toplam elektrik mâliyeti", h.elektrik),
    satir("Toplam işçilik ve amortisman", h.iscilikAmortisman),
    satir("Toplam net mâliyet", h.netMaliyet, "cost-cell--strong"),
    satir("Kârlı satış fiyatı", h.karliFiyat),
    satir("Kargo dâhil", h.kargoDahil),
    satir("KDV tutarı", h.kdvTutari),
    satir("KDV dâhil", h.kdvDahil),
    satir("Pazar yeri komisyon fiyatı", h.komisyonFiyati),
    satir("Pazar yeri komisyonunun KDV'si", h.komisyonKdv),
    satir("Pazar yeri komisyonla fiyatı", h.komisyonlaFiyat, "cost-cell--strong"),
    satir("Belirlenen fiyattan gelen ek kâr/zarar", h.fark,
      h.fark < 0 ? "cost-cell--loss" : "cost-cell--gain")
  ].join("");

  /* Komisyonlu fiyat, komisyonu KDV DÂHİL fiyatın üstüne ekliyor. Ama pazar
     yeri komisyonu satış fiyatının tamamından kestiği için, zam yapılmış
     fiyattan yine komisyon alınır ve hedef kâr tutmaz. Doğrusu bölerek
     brütleştirmektir. Tabloyu değiştirmiyorum — hesabı senin sayfanla aynı
     tutuyorum — ama farkı söylüyorum. */
  const uyari = qs("#cost-warning");
  const oran = (g.komisyon / 100) * 1.20;
  if (g.komisyon > 0 && oran < 1) {
    const dogruFiyat = h.kdvDahil / (1 - oran);
    const eksik = dogruFiyat - h.komisyonlaFiyat;
    uyari.hidden = false;
    uyari.innerHTML = `<strong>Komisyon notu:</strong> Pazar yeri komisyonu satış fiyatının
      <em>tamamından</em> kesilir. Komisyonu fiyatın üstüne eklemek yetmez; zamlı fiyattan da
      komisyon alınır. Hedef kârı tam tutturmak için satış fiyatı
      <strong>${money(yuvarla(dogruFiyat))}</strong> olmalı —
      yukarıdaki ${money(yuvarla(h.komisyonlaFiyat))} ile arada
      <strong>${money(yuvarla(eksik))}</strong> fark var.`;
  } else {
    uyari.hidden = true;
  }
}

qs("#cost-form").addEventListener("input", renderCost);

qs("#cost-save").addEventListener("click", async () => {
  await api("/api/cost-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(costGirdileri())
  });
  alert("Girdiler varsayılan olarak kaydedildi.");
});

qs("#cost-reset").addEventListener("click", () => {
  const form = qs("#cost-form");
  COST_ALANLAR.forEach((a) => { form.elements[a].value = a === "adet" ? 1 : 0; });
  renderCost();
});

async function loadCostSettings() {
  const kayit = await api("/api/cost-settings").catch(() => null);
  if (kayit) {
    const form = qs("#cost-form");
    COST_ALANLAR.forEach((a) => {
      if (kayit[a] !== undefined) form.elements[a].value = kayit[a];
    });
  }
  renderCost();
}

/* ---------- Katlaç kataloğu (yalnızca panel) ----------
   Her kart kendi başına kaydediliyor: 9 katlaçlık listede tek bir "hepsini
   kaydet" düğmesi, bir alandaki hatada diğerlerini de belirsiz bırakırdı. */
function renderKatlac() {
  const liste = state.katlac || [];
  qs("#katlac-count").textContent = `${liste.length} katlaç`;
  qs("#katlac-grid").innerHTML = liste.map((k) => `
    <article class="katlac-card" data-katlac="${k.id}">
      <img src="${escapeHtml(k.image_path)}" alt="${escapeHtml(k.name)}" loading="lazy">
      <div class="katlac-card__body">
        <label>Ad
          <input type="text" data-katlac-name="${k.id}" value="${escapeHtml(k.name)}">
        </label>
        <label>Fiyat (TL)
          <input type="number" min="0" step="0.01" data-katlac-price="${k.id}" value="${Number(k.price) || 0}">
        </label>
        <label>Not
          <input type="text" data-katlac-note="${k.id}" value="${escapeHtml(k.note) || ""}" placeholder="İsteğe bağlı">
        </label>
        <div class="katlac-card__actions">
          <button type="button" class="small-button" data-katlac-save="${k.id}">Kaydet</button>
          <button type="button" class="small-button danger" data-katlac-delete="${k.id}">Sil</button>
          <span class="katlac-status" data-katlac-status="${k.id}"></span>
        </div>
      </div>
    </article>
  `).join("") || "<p>Henüz katlaç eklenmemiş.</p>";
}

/* PDF sürümü. Ekrandaki kartlarda input var; onları yazdırmak boş kutular
   basar. Bu yüzden ayrı, sade bir düzen üretiliyor: 9 kayıt A4'te 2 sayfaya
   sığsın diye 3 sütun ve küçük görsel. */
/* PDF'e gömülen görsel kâğıtta ~42mm basılıyor; 1400px'lik aslı gereksiz ve
   dosyayı 13 MB'a çıkarıyordu (Chrome görseli PDF'e yeniden kodluyor).
   500px, 42mm'de 300 DPI eder — baskı için doğru çözünürlük, altına inmek
   kaliteyi düşürür, üstü boşa yer kaplar. Ölçüm: 700px→7.2MB, 500px→5.1MB,
   400px→4.1MB; hepsi tek sayfa.
   resize=contain ŞART: yalnızca width verilince Supabase görseli oranını
   koruyarak küçültmüyor, hedef genişliğe EZİYOR (1400x1050 → 500x1050).
   CSS cover bunu kırparak gizliyordu, yani orantı baştan beri bozuktu.
   Dönüştürme kapalı bir kurulumda adres yine çalışır, sadece küçültmez. */
const pdfGorseli = (url) => {
  if (!url || !url.includes("/storage/v1/object/public/")) return url;
  return `${url.replace("/object/public/", "/render/image/public/")}?width=500&resize=contain&quality=80`;
};

function renderKatlacPrint() {
  const liste = state.katlac || [];
  // Satır düzeni: görsel | ad + not | fiyat. Numara, telefonda okurken
  // "üçüncü sıradaki" demeyi kolaylaştırıyor.
  qs("#katlac-print-grid").innerHTML = liste.map((k, i) => `
    <article class="katlac-row">
      <span class="katlac-row__no">${String(i + 1).padStart(2, "0")}</span>
      <img class="katlac-row__img" src="${escapeHtml(pdfGorseli(k.image_path))}" alt="${escapeHtml(k.name)}">
      <div class="katlac-row__text">
        <h2>${escapeHtml(k.name)}</h2>
        ${k.note ? `<p>${escapeHtml(k.note)}</p>` : ""}
      </div>
      <span class="katlac-row__price">${Number(k.price) > 0
        ? money(k.price)
        : '<span class="katlac-row__nofiyat">fiyat belirtilmedi</span>'}</span>
    </article>
  `).join("");

  qs("#katlac-print-date").textContent =
    new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
  qs("#katlac-print-count").textContent = `${liste.length} ürün`;
}

/* Yazdırırken panelin geri kalanı gizlensin diye body'ye işaret koyuyoruz:
   admin.html tek sayfa, doğrudan yazdırmak bütün sekmeleri basardı. */
qs("#katlac-print").addEventListener("click", () => {
  renderKatlacPrint();
  document.body.classList.add("printing-katlac");
  // Görseller yüklenmeden yazdırmak boş kareler basar.
  const gorseller = [...document.querySelectorAll("#katlac-print-grid img")];
  Promise.all(gorseller.map((i) => i.complete ? Promise.resolve() : new Promise((r) => {
    i.addEventListener("load", r, { once: true });
    i.addEventListener("error", r, { once: true });
  }))).then(() => {
    window.print();
    document.body.classList.remove("printing-katlac");
  });
});

qs("#katlac-grid").addEventListener("click", async (event) => {
  const kaydet = event.target.dataset.katlacSave;
  const sil = event.target.dataset.katlacDelete;

  if (kaydet) {
    const durum = qs(`[data-katlac-status="${kaydet}"]`);
    durum.textContent = "Kaydediliyor…";
    await api(`/api/katlac/${kaydet}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: qs(`[data-katlac-name="${kaydet}"]`).value,
        price: qs(`[data-katlac-price="${kaydet}"]`).value,
        note: qs(`[data-katlac-note="${kaydet}"]`).value
      })
    });
    durum.textContent = "Kaydedildi ✓";
    // Listeyi yeniden çizmiyoruz: kullanıcı başka bir kartı düzenliyor olabilir,
    // altından DOM'u değiştirmek yazdığını kaybettirir. State'i elle güncelle.
    const kayit = state.katlac.find((k) => String(k.id) === kaydet);
    if (kayit) {
      kayit.name = qs(`[data-katlac-name="${kaydet}"]`).value;
      kayit.price = Number(qs(`[data-katlac-price="${kaydet}"]`).value) || 0;
      kayit.note = qs(`[data-katlac-note="${kaydet}"]`).value;
    }
    setTimeout(() => { durum.textContent = ""; }, 2500);
  } else if (sil) {
    if (!confirm("Bu katlaç listeden silinsin mi?")) return;
    await api(`/api/katlac/${sil}`, { method: "DELETE" });
    state.katlac = state.katlac.filter((k) => String(k.id) !== sil);
    renderKatlac();
  }
});

qs("#katlac-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const govde = new FormData(form);
  await hoistImageUpload(govde);        // depolama açıksa doğrudan Storage'a
  await api("/api/katlac", { method: "POST", body: govde });
  form.reset();
  await refresh();
});

function renderCampaignUses(veri) {
  const { campaign, uses, total_discount: toplam } = veri;
  const kontenjan = campaign.usage_limit
    ? `${campaign.used_count}/${campaign.usage_limit} kullanıldı · ${Math.max(0, campaign.usage_limit - campaign.used_count)} hak kaldı`
    : `${campaign.used_count} kez kullanıldı · limit yok`;

  if (!uses.length) {
    return `<p class="uses-summary">${kontenjan}</p><p>Bu kampanyayı henüz kimse kullanmadı.</p>`;
  }
  return `
    <p class="uses-summary">${kontenjan} · toplam ${money(toplam)} indirim verildi</p>
    <table class="uses-table">
      <thead><tr><th>Müşteri</th><th>İletişim</th><th>Sipariş</th><th>İndirim</th><th>Tarih</th></tr></thead>
      <tbody>
        ${uses.map((u) => `
          <tr>
            <td>${escapeHtml(u.customer_name) || "-"}</td>
            <td>${escapeHtml(u.customer_phone) || ""}${u.customer_email ? `<br><small>${escapeHtml(u.customer_email)}</small>` : ""}</td>
            <td>${escapeHtml(u.order_number) || "-"}</td>
            <td>${money(u.discount_amount)}</td>
            <td>${formatDateTime(u.created_at)}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

/* Galeri yüklemesi: her dosya KENDİ isteğiyle gider. Tek bir dev istekte
   göndermek Vercel'in ~4.5 MB gövde sınırına takılır ve tek bir hata bütün
   yüklemeyi düşürürdü; böyle olunca 5 fotoğraftan biri patlasa diğer 4'ü
   kaydedilmiş oluyor. Depolama açıksa dosya doğrudan Storage'a gidiyor. */
qs("#gallery-upload-btn").addEventListener("click", async () => {
  const secici = qs("#gallery-files");
  const dosyalar = [...secici.files];
  if (!galeriUrunId) return alert("Önce ürünü kaydedin.");
  if (!dosyalar.length) return alert("Yüklenecek fotoğraf seçin.");

  const renkId = qs("#gallery-color").value;
  const durum = qs("#gallery-status");
  durum.hidden = false;
  const hatalar = [];
  let yuklenen = 0;

  for (const [i, dosya] of dosyalar.entries()) {
    durum.textContent = `Yükleniyor ${i + 1}/${dosyalar.length}: ${dosya.name}`;
    try {
      const govde = new FormData();
      govde.set("image", dosya);
      if (renkId) govde.set("color_id", renkId);
      await hoistImageUpload(govde);          // depolama açıksa image_key'e çevirir
      await api(`/api/products/${galeriUrunId}/images`, { method: "POST", body: govde });
      yuklenen += 1;
    } catch (error) {
      hatalar.push(`${dosya.name}: ${error.message}`);
    }
  }

  secici.value = "";
  durum.textContent = hatalar.length
    ? `${yuklenen} fotoğraf yüklendi, ${hatalar.length} tanesi başarısız: ${hatalar.join(" | ")}`
    : `${yuklenen} fotoğraf yüklendi.`;
  await galeriyiTazele();
});

qs("#product-gallery").addEventListener("click", async (event) => {
  const t = event.target;
  const sil = t.dataset.galleryDelete;
  const kapak = t.dataset.galleryCover;
  const yukari = t.dataset.galleryUp;
  const asagi = t.dataset.galleryDown;

  if (sil) {
    if (!confirm("Bu fotoğraf silinsin mi?")) return;
    await api(`/api/products/${galeriUrunId}/images/${sil}`, { method: "DELETE" });
    await galeriyiTazele();
  } else if (kapak) {
    await api(`/api/products/${galeriUrunId}/images/${kapak}/cover`, { method: "POST" });
    await galeriyiTazele();
    alert("Kapak fotoğrafı güncellendi.");
  } else if (yukari || asagi) {
    /* Sıralama yer değiştirmeyle: iki fotoğrafın sort_order'ını takas et.
       Tek bir fotoğrafın numarasını değiştirmek eşitlik durumunda sırayı
       belirsiz bırakırdı (aynı sort_order → id'ye düşer). */
    const urun = state.products.find((p) => p.id === galeriUrunId);
    const liste = urun?.images || [];
    const indeks = liste.findIndex((g) => String(g.id) === (yukari || asagi));
    const hedef = yukari ? indeks - 1 : indeks + 1;
    if (indeks < 0 || hedef < 0 || hedef >= liste.length) return;
    await api(`/api/products/${galeriUrunId}/images/${liste[indeks].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sort_order: liste[hedef].sort_order })
    });
    await api(`/api/products/${galeriUrunId}/images/${liste[hedef].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sort_order: liste[indeks].sort_order })
    });
    await galeriyiTazele();
  }
});

// Renk ve alt metin: değişince kaydet (change, input değil — her harfte istek gitmesin).
qs("#product-gallery").addEventListener("change", async (event) => {
  const renk = event.target.dataset.galleryColor;
  const alt = event.target.dataset.galleryAlt;
  if (!renk && !alt) return;
  const govde = renk ? { color_id: event.target.value } : { image_alt: event.target.value };
  await api(`/api/products/${galeriUrunId}/images/${renk || alt}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(govde)
  });
  await galeriyiTazele();
});

/* Ürün arama/filtre. Sadece renderProducts() çağrılıyor — sunucuya gitmeye
   gerek yok, ürünler zaten state'te. Filtre kutuları listenin dışında
   olduğu için yeniden çizimde kaybolmuyorlar. */
const urunFiltreUygula = () => renderProducts();

qs("#product-search").addEventListener("input", (event) => {
  productFilters.search = event.target.value;
  urunFiltreUygula();
});
qs("#product-filter-category").addEventListener("change", (event) => {
  productFilters.category = event.target.value;
  urunFiltreUygula();
});
qs("#product-filter-state").addEventListener("change", (event) => {
  productFilters.state = event.target.value;
  urunFiltreUygula();
});
qs("#product-sort").addEventListener("change", (event) => {
  productFilters.sort = event.target.value;
  urunFiltreUygula();
});

function urunFiltreleriTemizle() {
  productFilters.search = "";
  productFilters.category = "";
  productFilters.state = "";
  productFilters.sort = "new";
  qs("#product-search").value = "";
  qs("#product-filter-state").value = "";
  qs("#product-sort").value = "new";
  renderProducts();
}
qs("#product-filter-clear").addEventListener("click", urunFiltreleriTemizle);
// Boş sonuç mesajındaki buton her çizimde yeniden oluşuyor: delege et.
qs("#product-list").addEventListener("click", (event) => {
  if (event.target.id === "product-empty-clear") urunFiltreleriTemizle();
});

qs("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const govde = {
    show_stock: form.elements.show_stock.checked ? 1 : 0,
    track_stock: form.elements.track_stock.checked ? 1 : 0,
    min_cart_total: form.elements.min_cart_total.value.trim() || 0
  };
  ["company_title", "legal_address", "tax_office", "tax_number", "mersis", "return_address"]
    .forEach((alan) => { govde[alan] = form.elements[alan].value; });

  await api("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(govde)
  });
  await refresh();
  alert("Ayarlar kaydedildi.");
});

qs("#admin-list").addEventListener("click", async (event) => {
  const resetId = event.target.dataset.resetAdmin;
  const deleteId = event.target.dataset.deleteAdmin;
  const name = event.target.dataset.adminName;
  try {
    if (resetId) {
      const password = prompt(`"${name}" için yeni şifre (en az 8 karakter):`);
      if (!password) return;
      await api(`/api/admin-users/${resetId}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      alert(`"${name}" hesabının şifresi güncellendi.`);
    } else if (deleteId) {
      if (!confirm(`"${name}" hesabı silinsin mi? Bu kişi artık panele giremez.`)) return;
      await api(`/api/admin-users/${deleteId}`, { method: "DELETE" });
    } else {
      return;
    }
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

qs("#admin-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await api("/api/admin-users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    form.reset();
    await refresh();
    alert("Yönetici eklendi.");
  } catch (error) {
    alert(error.message);
  }
});

/* Kendi şifresini değiştirmek sunucuda oturum çerezini tazeliyor; sayfayı
   yeniden yüklemeye gerek yok, ama diğer cihazlardaki oturumlar düşer. */
qs("#own-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const me = state.adminUsers.find((a) => a.username === state.sessionUser);
  if (!me) return alert("Oturum bilgisi okunamadı, sayfayı yenileyin.");
  try {
    await api(`/api/admin-users/${me.id}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    form.reset();
    alert("Şifreniz güncellendi.");
  } catch (error) {
    alert(error.message);
  }
});

qs("#review-list").addEventListener("click", async (event) => {
  const toggleId = event.target.dataset.toggleReview;
  const deleteId = event.target.dataset.deleteReview;
  if (toggleId) {
    const wasApproved = event.target.dataset.approved === "1";
    await api(`/api/reviews/${toggleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_approved: !wasApproved })
    });
    await refresh();
  }
  if (deleteId && confirm("Bu yorum silinsin mi?")) {
    await api(`/api/reviews/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

/* ---------- kampanya formu ---------- */

qs("#campaign-kind").addEventListener("change", syncCampaignFields);
qs("#campaign-scope").addEventListener("change", syncCampaignFields);

function resetCampaignForm() {
  const form = qs("#campaign-form");
  form.reset();
  form.elements.id.value = "";
  renderCampaignOptions(null);
  syncCampaignFields();
}

qs("#campaign-reset").addEventListener("click", resetCampaignForm);

qs("#campaign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  // Checkbox'lar tekrarlı isimle gelir; FormData.getAll ile diziye çevrilmeli.
  data.product_ids = qsa('#campaign-products input:checked').map((i) => i.value);
  data.category_ids = qsa('#campaign-categories input:checked').map((i) => i.value);
  data.is_active = data.is_active === "true";

  const id = data.id;
  delete data.id;
  await api(id ? `/api/campaigns/${id}` : "/api/campaigns", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  resetCampaignForm();
  await refresh();
});

qs("#campaign-list").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editCampaign;
  const toggleId = event.target.dataset.toggleCampaign;
  const deleteId = event.target.dataset.deleteCampaign;
  const usesId = event.target.dataset.usesCampaign;

  if (usesId) {
    const panel = qs(`.campaign-uses[data-uses-for="${usesId}"]`);
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = "<p>Yükleniyor…</p>";
    panel.innerHTML = renderCampaignUses(await api(`/api/campaigns/${usesId}/uses`));
    return;
  }

  if (editId) {
    const campaign = state.campaigns.find((c) => c.id === Number(editId));
    if (!campaign) return;
    const form = qs("#campaign-form");
    form.elements.id.value = campaign.id;
    form.elements.name.value = campaign.name;
    form.elements.code.value = campaign.code || "";
    form.elements.kind.value = campaign.kind;
    form.elements.scope.value = campaign.scope;
    form.elements.discount_type.value = campaign.discount_type;
    form.elements.discount_value.value = campaign.discount_value || "";
    form.elements.gift_quantity.value = campaign.gift_quantity || 1;
    form.elements.min_quantity.value = campaign.min_quantity || 0;
    form.elements.min_order_total.value = campaign.min_order_total || 0;
    form.elements.starts_at.value = campaign.starts_at || "";
    form.elements.ends_at.value = campaign.ends_at || "";
    form.elements.usage_limit.value = campaign.usage_limit || "";
    form.elements.is_active.value = campaign.is_active ? "true" : "false";
    renderCampaignOptions(campaign);
    syncCampaignFields();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (toggleId) {
    const campaign = state.campaigns.find((c) => c.id === Number(toggleId));
    if (!campaign) return;
    // PUT tam kayıt bekliyor; mevcut kampanyayı olduğu gibi geri gönder.
    await api(`/api/campaigns/${toggleId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...campaign, is_active: !campaign.is_active })
    });
    await refresh();
  }

  if (deleteId && confirm("Bu kampanya silinsin mi?")) {
    await api(`/api/campaigns/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

// Preserve the ticked colours across a refresh while editing a product.
function currentProductColorIds() {
  const editingId = Number(qs('#product-form input[name="id"]').value);
  if (!editingId) return qsa('#product-colors input:checked').map((input) => Number(input.value));
  const product = state.products.find((item) => item.id === editingId);
  return (product?.colors || []).map((color) => color.id);
}

// Same idea for the category checkboxes.
function currentProductCategoryIds() {
  const editingId = Number(qs('#product-form input[name="id"]').value);
  if (!editingId) return qsa('#product-categories input:checked').map((input) => Number(input.value));
  const product = state.products.find((item) => item.id === editingId);
  return (product?.categories || []).map((category) => category.id);
}

qsa(".tab").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
qsa("[data-open-tab]").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.openTab)));

async function loadSession() {
  const session = await api("/api/session");
  if (!session.authed) window.location.href = "/login";
  state.sessionUser = session.user || null;
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
  await hoistImageUpload(formData);
  const id = formData.get("id");
  await api(id ? `/api/products/${id}` : "/api/products", {
    method: id ? "PUT" : "POST",
    body: formData
  });
  form.reset();
  form.elements.id.value = "";
  form.is_active.checked = true;
  renderProductColorOptions([]);
  renderProductCategoryOptions([]);
  await refresh();
});

qs("#reset-product").addEventListener("click", () => {
  qs("#product-form").reset();
  qs('#product-form input[name="id"]').value = "";
  renderProductColorOptions([]);
  renderProductCategoryOptions([]);
  renderGallery(null);   // yeni ürüne geçildi: galeri bölümü gizlensin
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
    renderProductCategoryOptions((product.categories || []).map((category) => category.id));
    renderGallery(product);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (deleteId && confirm("Bu ürünü silmek istiyor musunuz?")) {
    await api(`/api/products/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
  const historyId = event.target.dataset.historyProduct;
  if (historyId) {
    const panel = qs(`.price-history[data-history-for="${historyId}"]`);
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = "<p>Yükleniyor…</p>";
    const rows = await api(`/api/products/${historyId}/price-history`);
    panel.innerHTML = renderPriceHistory(rows);
  }
});

// SQLite stores changed_at as UTC "YYYY-MM-DD HH:MM:SS"; render it in local Turkish format.
function formatDateTime(value) {
  if (!value) return "";
  const text = String(value);
  // İki biçim de gelebilir: Postgres ISO ("…T19:10:27.641Z") ve saat dilimsiz
  // "YYYY-MM-DD HH:MM:SS". İkincisi UTC kabul edilip Z ekleniyor; birincisine
  // Z eklemek "…ZZ" yapıp tarihi geçersiz kılar.
  const hasZone = /[TZ]|[+-]\d{2}:?\d{2}$/.test(text);
  const date = new Date(hasZone ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

function renderPriceHistory(rows) {
  if (!rows || !rows.length) return "<p>Fiyat kaydı yok.</p>";
  return `<table class="history-table">
    <thead><tr><th>Tarih</th><th>Fiyat</th><th>İndirimli</th></tr></thead>
    <tbody>${rows.map((row, index) => `
      <tr>
        <td>${formatDateTime(row.changed_at)}${index === 0 ? ' <span class="badge blue">güncel</span>' : ""}</td>
        <td>${money(row.price)}</td>
        <td>${row.sale_price != null ? money(row.sale_price) : "—"}</td>
      </tr>`).join("")}</tbody>
  </table>`;
}

function resetMaterialForm() {
  const form = qs("#material-form");
  form.reset();
  form.elements.id.value = "";
  form.is_active.checked = true;
}

qs("#material-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.is_active = form.is_active.checked ? "1" : "0";
  await api(data.id ? `/api/materials/${data.id}` : "/api/materials", {
    method: data.id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  resetMaterialForm();
  await refresh();
});

qs("#reset-material").addEventListener("click", resetMaterialForm);

qs("#material-list").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editMaterial;
  const deleteId = event.target.dataset.deleteMaterial;
  if (editId) {
    const material = state.materials.find((item) => item.id === Number(editId));
    const form = qs("#material-form");
    ["id", "name", "description", "price_per_cm3", "sort_order"].forEach((key) => {
      form.elements[key].value = material[key] ?? "";
    });
    form.is_active.checked = Boolean(material.is_active);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (deleteId && confirm("Bu malzeme silinsin mi?")) {
    await api(`/api/materials/${deleteId}`, { method: "DELETE" });
    await refresh();
  }
});

qs("#pricing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api("/api/pricing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  await refresh();
  alert("Fiyat katsayıları kaydedildi.");
});

qs("#quote-list").addEventListener("change", async (event) => {
  const id = event.target.dataset.quoteStatus;
  if (!id) return;
  await api(`/api/quotes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: event.target.value })
  });
  await refresh();
});

qs("#quote-list").addEventListener("click", async (event) => {
  const id = event.target.dataset.deleteQuote;
  if (!id || !confirm("Bu teklif silinsin mi?")) return;
  await api(`/api/quotes/${id}`, { method: "DELETE" });
  await refresh();
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
  await hoistImageUpload(formData);
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
  await hoistImageUpload(formData);
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

document.addEventListener("change", async (event) => {
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

loadCostSettings();

loadSession()
  .then(refresh)
  .catch((error) => {
    if (error.message !== "Giriş gerekli") alert(error.message);
  });

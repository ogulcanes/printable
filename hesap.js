(function () {
  const auth = document.querySelector("#account-auth");
  if (!auth) return;
  const dashboard = document.querySelector("#account-dashboard");
  const forms = {
    login: document.querySelector("#customer-login-form"),
    register: document.querySelector("#customer-register-form"),
    forgot: document.querySelector("#customer-forgot-form"),
    reset: document.querySelector("#customer-reset-form")
  };
  const tabs = [...document.querySelectorAll("[data-account-tab]")];
  const resetToken = new URLSearchParams(location.search).get("reset");

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const formatMoney = (value) => `${Number(value || 0).toFixed(2)} TL`;
  const statusLabels = {
    new: "Alındı", preparing: "Hazırlanıyor", shipped: "Kargoda",
    delivered: "Teslim edildi", cancelled: "İptal"
  };

  statusLabels.printed = "Baskı tamamlandı";

  function message(form, text, error = false) {
    const target = form.querySelector(".account-message");
    target.textContent = text || "";
    target.classList.toggle("is-error", error);
  }

  function showForm(name) {
    Object.entries(forms).forEach(([key, form]) => { form.hidden = key !== name; });
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.accountTab === name));
    document.querySelector(".account-tabs").hidden = !["login", "register"].includes(name);
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "İşlem tamamlanamadı.");
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("İstek zaman aşımına uğradı. Lütfen tekrar deneyin.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function renderOrders() {
    const box = document.querySelector("#customer-orders");
    const shippingLabels = { free: "Ücretsiz kargo", recipient_paid: "Alıcı ödemeli" };
    const paymentLabels = { pending: "Ödeme onayı bekleniyor", paid: "Ödendi", refunded: "İade edildi" };
    try {
      const orders = await request("/api/customer/orders");
      box.innerHTML = orders.length ? orders.map((order) => {
        const isCancelled = order.status === "cancelled";
        const productVisual = (item, compact = false) => {
          const image = item.product_image
            ? `<img src="${escapeHtml(item.product_image)}" alt="${escapeHtml(item.product_name)}">`
            : `<span class="order-product__placeholder" aria-hidden="true">3D</span>`;
          const productId = Number(item.product_id);
          const visual = productId > 0 ? `<a href="/urun/${productId}" class="order-product__image">${image}</a>` : `<span class="order-product__image">${image}</span>`;
          return compact ? visual : `${visual}<span class="order-product__info"><strong>${escapeHtml(item.product_name)}</strong>${item.scale ? `<small>Ölçek: ${escapeHtml(item.scale)}</small>` : ""}</span>`;
        };
        const orderItems = order.items || [];
        const items = orderItems.map((item) => `
          <li>${productVisual(item)}<span class="order-product__quantity">${Number(item.quantity)} adet</span><strong>${formatMoney(item.line_total)}</strong></li>`).join("");
        return `<article class="account-order">
          <div class="account-order__header">
            <span class="account-order__identity"><strong>${escapeHtml(order.order_number)}</strong><small>${new Date(order.created_at).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })}</small></span>
            <span class="account-order__status ${isCancelled ? "is-cancelled" : ""}">${escapeHtml(statusLabels[order.status] || order.status)}</span>
            <strong class="account-order__total">${formatMoney(order.total)}</strong>
          </div>
          <section class="account-order__products"><h3>Ürünler <span>(${orderItems.length})</span></h3><ul class="order-items">${items || "<li>Ürün bilgisi bulunamadı.</li>"}</ul></section>
          <div class="account-order__footer">
            <span>${escapeHtml(shippingLabels[order.shipping_method] || "Kargo yöntemi belirleniyor.")}</span>
            ${order.tracking_code ? `<span>Kargo takip: <strong>${escapeHtml(order.tracking_code)}</strong></span>` : ""}
            <span>${escapeHtml(paymentLabels[order.payment_status] || order.payment_status)}</span>
          </div>
        </article>`;
      }).join("") : `<div class="account-empty"><strong>Henüz siparişiniz yok.</strong><a href="/urunler">Ürünleri keşfedin</a></div>`;
    } catch (error) {
      box.innerHTML = `<p class="account-message is-error">${escapeHtml(error.message)}</p>`;
    }
  }

  async function showDashboard(customer) {
    document.querySelector(".account-page").classList.remove("account-page--loading");
    auth.hidden = true;
    dashboard.hidden = false;
    document.querySelector(".account-shell").classList.add("is-authenticated");
    document.querySelector("#account-welcome").textContent = `Merhaba, ${customer.name}`;
    const form = document.querySelector("#customer-profile-form");
    form.elements.name.value = customer.name || "";
    form.elements.email.value = customer.email || "";
    form.elements.phone.value = customer.phone || "";
    await renderOrders();
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => showForm(tab.dataset.accountTab)));

  /* `event.currentTarget` YALNIZCA olay dağıtımı sürerken doludur; ilk await'te
     handler geri döner ve tarayıcı onu null'a çeker. Formu await'ten önce
     yakalamak şart — aksi halde catch bloğu message(null, ...) çağırıyor,
     TypeError atıyor ve kullanıcı hiçbir hata mesajı görmüyordu: "Giriş yap"a
     basınca hiçbir şey olmuyor gibi görünüyordu. */
  forms.login.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    message(form, "");
    // Kayıt formundaki gibi bekleme durumu: yavaş bağlantıda istek uçarken
    // butonun sessiz kalması da "hiçbir şey olmuyor" gibi görünüyordu.
    button.disabled = true;
    button.textContent = "Giriş yapılıyor…";
    try {
      const data = await request("/api/customer/login", {
        method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      await showDashboard(data.customer);
    } catch (error) { message(form, error.message, true); }
    finally {
      button.disabled = false;
      button.textContent = "Giriş yap";
    }
  });

  forms.register.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    message(form, "");
    button.disabled = true;
    button.textContent = "Hesap oluşturuluyor…";
    try {
      const data = await request("/api/customer/register", { method: "POST", body: JSON.stringify(values) });
      await showDashboard(data.customer);
    } catch (error) { message(form, error.message, true); }
    finally {
      button.disabled = false;
      button.textContent = "Kayıt ol";
    }
  });

  forms.forgot.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    message(form, "Bağlantı gönderiliyor…");
    button.disabled = true;
    button.textContent = "Gönderiliyor…";
    try {
      const data = await request("/api/customer/forgot-password", {
        method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      message(form, data.message);
    } catch (error) { message(form, error.message, true); }
    finally {
      button.disabled = false;
      button.textContent = "Bağlantı gönder";
    }
  });

  forms.reset.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      await request("/api/customer/reset-password", {
        method: "POST", body: JSON.stringify({ token: resetToken, password: values.password })
      });
      history.replaceState({}, "", "/hesap");
      showForm("login");
      message(forms.login, "Şifreniz yenilendi. Yeni şifrenizle giriş yapabilirsiniz.");
    } catch (error) { message(form, error.message, true); }
  });

  document.querySelector("#customer-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await request("/api/customer/profile", {
        method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      document.querySelector("#account-welcome").textContent = `Merhaba, ${data.customer.name}`;
      message(form, "Bilgileriniz kaydedildi.");
    } catch (error) { message(form, error.message, true); }
  });

  document.querySelector("#customer-logout").addEventListener("click", async () => {
    await request("/api/customer/logout", { method: "POST", body: "{}" }).catch(() => {});
    location.href = "/hesap";
  });

  (async () => {
    if (resetToken) {
      auth.hidden = false;
      document.querySelector(".account-page").classList.remove("account-page--loading");
      return showForm("reset");
    }
    try {
      const session = await request("/api/customer/session");
      if (session.authed) return showDashboard(session.customer);
    } catch { /* giriş formu açık kalır */ }
    auth.hidden = false;
    document.querySelector(".account-page").classList.remove("account-page--loading");
    showForm("login");
  })();
})();

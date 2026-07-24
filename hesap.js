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
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "İşlem tamamlanamadı.");
    return data;
  }

  async function renderOrders() {
    const box = document.querySelector("#customer-orders");
    try {
      const orders = await request("/api/customer/orders");
      box.innerHTML = orders.length ? orders.map((order) => `
        <article class="account-order">
          <div><strong>${escapeHtml(order.order_number)}</strong><span>${new Date(order.created_at).toLocaleDateString("tr-TR")}</span></div>
          <div><span class="account-order__status">${escapeHtml(statusLabels[order.status] || order.status)}</span>
          ${order.tracking_code ? `<small>Kargo: ${escapeHtml(order.tracking_code)}</small>` : ""}</div>
          <strong>${formatMoney(order.total)}</strong>
        </article>`).join("") : `<div class="account-empty"><strong>Henüz siparişiniz yok.</strong><a href="/urunler">Ürünleri keşfedin</a></div>`;
    } catch (error) {
      box.innerHTML = `<p class="account-message is-error">${escapeHtml(error.message)}</p>`;
    }
  }

  async function showDashboard(customer) {
    auth.hidden = true;
    dashboard.hidden = false;
    document.querySelector("#account-welcome").textContent = `Merhaba, ${customer.name}`;
    const form = document.querySelector("#customer-profile-form");
    form.elements.name.value = customer.name || "";
    form.elements.email.value = customer.email || "";
    form.elements.phone.value = customer.phone || "";
    await renderOrders();
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => showForm(tab.dataset.accountTab)));

  forms.login.addEventListener("submit", async (event) => {
    event.preventDefault();
    message(event.currentTarget, "");
    try {
      const data = await request("/api/customer/login", {
        method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
      });
      await showDashboard(data.customer);
    } catch (error) { message(event.currentTarget, error.message, true); }
  });

  forms.register.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.password !== values.password_confirm) return message(event.currentTarget, "Şifreler eşleşmiyor.", true);
    try {
      const data = await request("/api/customer/register", { method: "POST", body: JSON.stringify(values) });
      await showDashboard(data.customer);
    } catch (error) { message(event.currentTarget, error.message, true); }
  });

  forms.forgot.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await request("/api/customer/forgot-password", {
        method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
      });
      message(event.currentTarget, data.message);
    } catch (error) { message(event.currentTarget, error.message, true); }
  });

  forms.reset.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.password !== values.password_confirm) return message(event.currentTarget, "Şifreler eşleşmiyor.", true);
    try {
      await request("/api/customer/reset-password", {
        method: "POST", body: JSON.stringify({ token: resetToken, password: values.password })
      });
      history.replaceState({}, "", "/hesap");
      showForm("login");
      message(forms.login, "Şifreniz yenilendi. Yeni şifrenizle giriş yapabilirsiniz.");
    } catch (error) { message(event.currentTarget, error.message, true); }
  });

  document.querySelector("#customer-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await request("/api/customer/profile", {
        method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
      });
      document.querySelector("#account-welcome").textContent = `Merhaba, ${data.customer.name}`;
      message(event.currentTarget, "Bilgileriniz kaydedildi.");
    } catch (error) { message(event.currentTarget, error.message, true); }
  });

  document.querySelector("#customer-logout").addEventListener("click", async () => {
    await request("/api/customer/logout", { method: "POST", body: "{}" }).catch(() => {});
    location.href = "/hesap";
  });

  (async () => {
    if (resetToken) return showForm("reset");
    try {
      const session = await request("/api/customer/session");
      if (session.authed) return showDashboard(session.customer);
    } catch { /* giriş formu açık kalır */ }
    showForm("login");
  })();
})();

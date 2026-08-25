// Multi-step checkout. Loaded after script.js, so it shares the global cart,
// money() and saveCart()/renderCart(). Server re-validates and re-prices everything.
(function () {
  const steps = document.querySelector("#checkout-steps");
  if (!steps) return;

  // PayTR yönlendirmeyi iframe içinde açarsa sonucu ana ödeme sayfasına taşı.
  if (window.self !== window.top) {
    window.top.location.replace(window.location.href);
    return;
  }

  const qs = (s) => document.querySelector(s);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const panels = [...document.querySelectorAll(".checkout-panel")];
  const stepItems = [...document.querySelectorAll("#checkout-steps li")];
  const cartNotice = qs("#cart-notice");
  if (cartNotice) {
    cartNotice.hidden = true;
    cartNotice.style.display = "none";
  }
  let step = 1;
  const LAST = 3;
  const returnParams = new URLSearchParams(window.location.search);
  const isPaymentReturn = ["success", "failed"].includes(returnParams.get("paytr"))
    && returnParams.has("ref") && returnParams.has("token");

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function preparePaymentResult() {
    showStep(3);
    qs(".payment-methods").hidden = true;
    qs("#co-submit").hidden = true;
    qs("#co-prev").hidden = true;
    qs("#co-next").hidden = true;
    qs("#checkout-result").hidden = false;
  }

  function showPaidOrder(data) {
    /* Sepet AZ SONRA boşaltılıyor; satırları ölçüme önce geçir yoksa dönüşüm
       ürünsüz kaydedilir. Tutar sunucudan geliyor (kargo, kupon ve kampanya
       uygulanmış hâli) — sepetten hesaplasak reklam raporundaki ciro yanlış
       olurdu.

       Aynı satın alma sunucudan da bildiriliyor (server.js: gaSatinAlmaBildir).
       Bilerek: sunucu tarafı müşteri sayfaya dönmese bile kaydeder, buradaki
       ise ölçüm anahtarı tanımlı değilken tek güvence. İkisi de AYNI
       transaction_id'yi (sipariş numarası) gönderdiği için GA4 tekilleştirir.
       Sipariş sayısıyla GA4'teki işlem sayısı ilk günlerde karşılaştırılmalı —
       tutmuyorsa bu iki yoldan biri kapatılmalı. */
    const satirlar = cart.map(olayUrunu);
    olay("purchase", {
      transaction_id: data.order_number,
      currency: "TRY",
      value: Number(data.total) || 0,
      items: satirlar
    });
    cart.length = 0;
    saveCart();
    if (typeof renderCart === "function") renderCart();
    preparePaymentResult();
    qs("#checkout-result").innerHTML = `
      <div class="checkout-success">
        <strong>Ödemeniz onaylandı! 🎉</strong>
        <p>Sipariş numaranız: <b>${escapeHtml(data.order_number)}</b></p>
        <p>Ödeme yöntemi: PayTR · Kredi / banka kartı</p>
        <p class="checkout-success__note">${data.shipping_method === "free"
          ? "Siparişiniz ücretsiz kargo ile gönderilecektir."
          : "Kargo ücreti teslimatta alıcı tarafından ödenir."}</p>
        <a class="btn-outline" href="/urunler">Alışverişe devam et</a>
      </div>`;
  }

  function showFailedPayment(message) {
    preparePaymentResult();
    qs("#checkout-result").innerHTML = `
      <div class="checkout-success checkout-success--failed">
        <strong>Ödeme tamamlanamadı.</strong>
        <p>${escapeHtml(message || "Kart işlemi onaylanmadı. Sepetiniz korunuyor; tekrar deneyebilirsiniz.")}</p>
        <a class="btn-outline" href="/odeme">Tekrar dene</a>
      </div>`;
  }

  function showPendingPayment(message) {
    preparePaymentResult();
    qs("#checkout-result").innerHTML = `
      <div class="checkout-success checkout-success--pending">
        <strong>Ödeme sonucu bekleniyor.</strong>
        <p>${escapeHtml(message || "Sonuç henüz ulaşmadı. Birkaç saniye sonra durumu yeniden kontrol edin.")}</p>
        <a class="btn-outline" href="${escapeHtml(window.location.href)}">Durumu yenile</a>
      </div>`;
  }

  async function showPaymentReturn() {
    preparePaymentResult();
    qs("#checkout-result").innerHTML = `
      <div class="checkout-success">
        <strong>Ödeme sonucu doğrulanıyor…</strong>
        <p>Lütfen bu sayfayı kapatmayın.</p>
      </div>`;
    const query = new URLSearchParams({
      ref: returnParams.get("ref"),
      token: returnParams.get("token")
    });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await fetch(`/api/paytr/status?${query}`, { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Ödeme sonucu okunamadı.");
        if (data.payment_status === "paid") return showPaidOrder(data);
        if (data.payment_status === "failed") return showFailedPayment(data.failure_message);
      } catch (error) {
        if (attempt === 11) return showPendingPayment(error.message);
      }
      await wait(1500);
    }

    showPendingPayment();
  }

  // Giriş yapan müşterinin temel bilgilerini teslimat formuna taşı; adres yine
  // siparişe özeldir ve müşteri tarafından doldurulur.
  fetch("/api/customer/session")
    .then((response) => response.json())
    .then(({ authed, customer }) => {
      if (!authed || !customer) return;
      const form = qs("#delivery-form");
      if (!form.name.value) form.name.value = customer.name || "";
      if (!form.email.value) form.email.value = customer.email || "";
      if (!form.phone.value) form.phone.value = customer.phone || "";
    })
    .catch(() => {});

  function renderCheckoutCart() {
    const box = qs("#checkout-cart");
    if (!cart.length) {
      box.innerHTML = `
        <div class="checkout-empty">
          <p class="checkout-empty__message">Sepetiniz boş. Beğendiğiniz ürünleri ekleyerek başlayın.</p>
          <a class="checkout-empty__action" href="/urunler">
            Ürünleri gör <span aria-hidden="true">→</span>
          </a>
        </div>`;
      return;
    }
    box.innerHTML = cart.map((item) => `
      <article class="checkout-item">
        <img src="${item.image || "/assets/printable-logo.svg"}" alt="" onerror="this.onerror=null;this.src='/assets/printable-logo.svg'">
        <div class="checkout-item__info">
          <h3>${item.name}</h3>
          ${item.scale ? `<span class="cart-item__scale">${escapeHtml(item.scale)}</span>` : ""}
          ${typeof cartCustomizationHTML === "function" ? cartCustomizationHTML(item) : ""}
          <p>${money(item.price)}</p>
          <div class="cart-qty">
            <button type="button" data-co-dec="${lineKey(item)}" aria-label="Azalt">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-co-inc="${lineKey(item)}" aria-label="Artır">+</button>
          </div>
        </div>
        <div class="checkout-item__end">
          <strong>${money(item.price * item.quantity)}</strong>
          <button type="button" class="cart-remove" data-co-remove="${lineKey(item)}">Kaldır</button>
        </div>
      </article>
    `).join("");
  }

  let minSepet = 0;   // panelden gelen minimum sipariş tutarı; 0 = sınır yok
  let freeShippingThreshold = 599;

  // Campaigns are computed server-side; this holds the last preview so the
  // summary can show it. The server recomputes everything on submit anyway.
  let campaigns = { discount: 0, gifts: [], applied: [], incentives: [] };

  function renderSummary() {
    const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const discount = Math.min(campaigns.discount || 0, subtotal);
    const net = subtotal - discount;
    const total = Math.round(net * 100) / 100;
    const ucretsizKargo = total >= freeShippingThreshold;
    qs("#summary-items").innerHTML = cart.map((i) =>
      `<div class="summary-item"><span>${i.quantity} × ${i.name}${
        i.scale ? ` <em>(${escapeHtml(i.scale)})</em>` : ""}${
        i.customization ? ` <em>(kişiye özel)</em>` : ""}</span><span>${money(i.price * i.quantity)}</span></div>`
    ).join("") || `<p class="summary-empty">Sepet boş</p>`;

    const rows = [
      ...(campaigns.applied || []).filter((c) => c.kind !== "gift").map((c) =>
        `<div class="summary-line summary-line--discount"><span>${escapeHtml(c.label)}</span><span>-${money(c.amount)}</span></div>`),
      ...(campaigns.gifts || []).map((g) =>
        `<div class="summary-line summary-line--gift"><span>🎁 ${escapeHtml(g.product_name)} ×${g.quantity}</span><span>Hediye</span></div>`),
      ...(campaigns.incentives || []).map((i) =>
        `<p class="summary-incentive">${escapeHtml(i.text)}</p>`)
    ].join("");
    qs("#summary-campaigns").innerHTML = rows;

    qs("#summary-subtotal").textContent = money(subtotal);
    qs("#summary-total").textContent = money(total);
    qs(".summary-shipping").textContent = ucretsizKargo ? "Ücretsiz" : "Alıcı ödemeli";
    const shippingNote = qs("#summary-shipping-note");
    if (shippingNote) {
      shippingNote.textContent = ucretsizKargo
        ? "Ücretsiz kargoyu kazandınız 🎉"
        : `Ücretsiz kargoya ${money(freeShippingThreshold - total)} kaldı.`;
      shippingNote.classList.toggle("summary-note--qualified", ucretsizKargo);
    }
  }

  // Ask the server what applies to this cart. Never computed in the browser.
  async function refreshCampaigns() {
    if (!cart.length) {
      campaigns = { discount: 0, gifts: [], applied: [], incentives: [] };
      renderSummary();
      return;
    }
    try {
      const res = await fetch("/api/campaigns/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: qs("#coupon-code")?.value || "",
          /* Kişi başı kullanım hakkı olan kodlar için: sunucu "bu kodu daha önce
             kullandınız" diyebilsin diye teslimat formundaki iletişim bilgisi
             gönderilir. Boşsa sunucu kimliği bilmez ve engellemez — asıl kontrol
             siparişte. */
          email: qs("#delivery-form")?.elements.email?.value || "",
          phone: qs("#delivery-form")?.elements.phone?.value || "",
          items: cart.map((i) => ({
            product_id: i.id,
            scale_id: i.scale_id || null,
            quantity: i.quantity,
            customization: i.customization || null
          }))
        })
      });
      campaigns = await res.json();
      const msg = qs("#coupon-message");
      if (msg) {
        const applied = (campaigns.applied || []).find((c) => c.code);
        msg.hidden = !campaigns.error && !applied;
        msg.textContent = campaigns.error || (applied ? `"${applied.code}" uygulandı.` : "");
        msg.classList.toggle("coupon-box__msg--err", Boolean(campaigns.error));
        msg.classList.toggle("coupon-box__msg--ok", !campaigns.error && Boolean(applied));
      }
    } catch {
      campaigns = { discount: 0, gifts: [], applied: [], incentives: [] };
    }
    renderSummary();
  }

  // Pull storefront thresholds so the summary matches the server's calculation.
  fetch("/api/site-info").then((r) => r.json()).then((info) => {
    if (info && Number.isFinite(Number(info.min_cart_total))) minSepet = Number(info.min_cart_total);
    if (info && Number.isFinite(Number(info.free_shipping_threshold))) {
      freeShippingThreshold = Number(info.free_shipping_threshold);
    }
    renderSummary();
    if (!isPaymentReturn) showStep(step);   // minimum sağlanmıyorsa Devam butonu kilitlensin
  }).catch(() => {});

  function refreshCartViews() {
    renderCheckoutCart();
    renderSummary();
    // Cart changed → the qualifying campaigns may have changed with it.
    refreshCampaigns();
    if (typeof renderCart === "function") renderCart(); // keep the header drawer + count in sync
  }

  qs("#coupon-apply")?.addEventListener("click", refreshCampaigns);
  /* İletişim bilgisi değişince kampanyaları yeniden sor: kişi başı hakkı dolmuş
     bir kod ancak müşteri kim olduğunu yazdıktan sonra anlaşılır. */
  ["email", "phone"].forEach((alan) => {
    qs("#delivery-form")?.elements[alan]?.addEventListener("change", refreshCampaigns);
  });
  qs("#coupon-code")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();   // inside a form this would submit the checkout
    refreshCampaigns();
  });

  function showStep(n) {
    step = Math.min(LAST, Math.max(1, n));
    panels.forEach((p) => p.classList.toggle("active", Number(p.dataset.step) === step));
    stepItems.forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle("active", s === step);
      li.classList.toggle("done", s < step);
    });
    qs("#co-prev").hidden = step === 1;
    qs("#co-next").hidden = step === LAST;
    qs("#co-submit").hidden = step !== LAST;
    const araToplam = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const altinda = minSepet > 0 && araToplam < minSepet;
    qs("#co-next").disabled = step === 1 && (cart.length === 0 || altinda);
    if (step === 1 && altinda && cart.length) {
      setError("#cart-error", `Minimum sipariş tutarı ${money(minSepet)}. Sepetinize ${money(minSepet - araToplam)} daha ekleyin.`);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const setError = (id, msg) => {
    const el = qs(id);
    el.textContent = msg || "";
    el.hidden = !msg;
  };

  function validateStep(n) {
    if (n === 1) {
      if (!cart.length) return false;
      const araToplam = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
      if (minSepet > 0 && araToplam < minSepet) {
        setError("#cart-error", `Minimum sipariş tutarı ${money(minSepet)}. Sepetinize ${money(minSepet - araToplam)} daha ekleyin.`);
        return false;
      }
      setError("#cart-error", "");
      return true;
    }
    if (n === 2) {
      const f = qs("#delivery-form");
      if (!f.name.value.trim() || !f.phone.value.trim() || !f.email.value.trim()) {
        setError("#delivery-error", "Ad soyad, telefon ve e-posta zorunludur.");
        return false;
      }
      if (!f.email.validity.valid) {
        setError("#delivery-error", "Geçerli bir e-posta adresi girin.");
        return false;
      }
      if (!f.city.value.trim() || !f.district.value.trim() || !f.address.value.trim()) {
        setError("#delivery-error", "İl, ilçe ve açık adres zorunludur.");
        return false;
      }
      setError("#delivery-error", "");
      return true;
    }
    return true;
  }

  // ---- events ----
  qs("#co-next").addEventListener("click", () => { if (validateStep(step)) showStep(step + 1); });
  qs("#co-prev").addEventListener("click", () => showStep(step - 1));

  // Cart quantity/remove inside the checkout step (own data-attrs; does not clash with the drawer).
  qs("#checkout-cart").addEventListener("click", (event) => {
    const inc = event.target.dataset.coInc;
    const dec = event.target.dataset.coDec;
    const rem = event.target.dataset.coRemove;
    // Satır kimliği ürün + ölçek (script.js: lineKey) — aynı ürünün iki boyu
    // sepette iki ayrı satır, biri diğerinin adedini değiştirmemeli.
    const key = inc || dec || rem;
    if (!key) return;
    const item = cart.find((i) => lineKey(i) === key);
    if (inc && item) item.quantity += 1;
    if (dec && item) { item.quantity -= 1; if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1); }
    if (rem) { const idx = cart.findIndex((i) => lineKey(i) === key); if (idx >= 0) cart.splice(idx, 1); }
    saveCart();
    refreshCartViews();
    qs("#co-next").disabled = cart.length === 0;
  });

  qs("#co-submit").addEventListener("click", async () => {
    if (!cart.length) { setError("#payment-error", "Sepetiniz boş."); return; }
    const d = qs("#delivery-form");
    const payload = {
      customer: {
        name: d.name.value.trim(),
        phone: d.phone.value.trim(),
        email: d.email.value.trim(),
        city: d.city.value.trim(),
        district: d.district.value.trim(),
        neighborhood: d.neighborhood.value.trim(),
        postal_code: d.postal_code.value.trim(),
        address: d.address.value.trim()
      },
      payment_method: "kart",
      // Only the code travels — the server prices the campaign itself.
      coupon_code: qs("#coupon-code")?.value.trim() || "",
      items: cart.map((i) => ({
        product_id: i.id,
        scale_id: i.scale_id || null,
        quantity: i.quantity,
        customization: i.customization || null
      }))
    };

    const button = qs("#co-submit");
    button.disabled = true;
    setError("#payment-error", "");
    olay("begin_checkout", {
      currency: "TRY",
      value: cart.reduce((t, i) => t + i.price * i.quantity, 0),
      items: cart.map(olayUrunu)
    });
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sipariş oluşturulamadı.");
      if (!/^https:\/\/www\.paytr\.com\/odeme\/guvenli\//.test(data.iframe_url || "")) {
        throw new Error("Güvenli ödeme ekranı açılamadı.");
      }
      // Sepet callback ile ödeme onaylanana kadar korunur. Kart bilgileri yalnızca
      // PayTR iframe'ine girilir; Printable sunucusuna hiçbir kart verisi gelmez.
      qs(".payment-methods").hidden = true;
      qs("#checkout-result").hidden = false;
      qs("#checkout-result").innerHTML = `
        <p><strong>Sipariş: ${escapeHtml(data.order_number)}</strong></p>
        <div class="paytr-frame-shell">
          <p class="paytr-loading" id="paytr-loading" role="status">Güvenli ödeme formu yükleniyor…</p>
          <iframe src="${escapeHtml(data.iframe_url)}" id="paytriframe" title="PayTR güvenli kart ödeme ekranı"
            frameborder="0" scrolling="no"></iframe>
        </div>`;
      // Ödeme formu üçüncü panelin içinde. Eski kod var olmayan "4. adımı" arayıp
      // üçüncü panelin active sınıfını kaldırdığı için iframe DOM'a eklense de görünmüyordu.
      panels.forEach((panel) => panel.classList.toggle("active", Number(panel.dataset.step) === 3));
      const iframe = qs("#paytriframe");
      const loading = qs("#paytr-loading");
      let iframeLoaded = false;
      iframe.addEventListener("load", () => {
        iframeLoaded = true;
        loading.hidden = true;
      }, { once: true });
      window.setTimeout(() => {
        if (!iframeLoaded) loading.textContent = "Ödeme formu beklenenden uzun sürüyor. İnternet bağlantınızı kontrol edip sayfayı yenileyebilirsiniz.";
      }, 12000);
      if (typeof window.iFrameResize === "function") window.iFrameResize({}, "#paytriframe");
      qs("#co-submit").hidden = true;
      qs("#co-prev").hidden = true;
      qs("#co-next").hidden = true;
    } catch (err) {
      setError("#payment-error", err.message);
      button.disabled = false;
    }
  });

  /* Sepetteki fiyat, ürün sepete atıldığı ANDA tarayıcıya kopyalanıyor ve orada
     kalıyor. Sepet günlerce bekleyebildiği için aradaki zam/indirim müşteriye
     yansımıyordu: ekranda eski tutarı görüp sunucunun hesapladığı yeni tutarı
     ödüyordu. Ödeme sayfası açılırken fiyatları katalogdan tazeliyor, değişen
     varsa açıkça söylüyoruz. Katalogdan kalkan ürün de burada ayıklanıyor —
     sunucu onu zaten reddederdi, müşteri en son adımda öğrenmesin. */
  async function fiyatlariTazele() {
    if (!cart.length) return;
    let katalog;
    try {
      katalog = await fetch("/api/products").then((r) => r.json());
    } catch {
      return;   // katalog okunamadıysa sepete dokunma; sunucu yine doğru fiyattan hesaplar
    }
    if (!Array.isArray(katalog)) return;

    const degisenler = [];
    const kalkanlar = [];
    let sepetDegisti = false;
    for (let i = cart.length - 1; i >= 0; i -= 1) {
      const satir = cart[i];
      const urun = katalog.find((p) => p.id === satir.id && p.is_active);
      if (!urun) {
        kalkanlar.push(satir.name);
        cart.splice(i, 1);
        sepetDegisti = true;
        continue;
      }
      /* Ölçekli üründe fiyat ölçekten gelir. Sepetteki ölçek silinmişse en
         ucuğuna düşülür (sunucu da öyle yapıyor) ve müşteriye söylenir —
         sessizce başka bir boyun fiyatını uygulamak olmaz. */
      const olcekler = urun.scales || [];
      const olcek = olcekler.length
        ? olcekler.find((s) => s.id === satir.scale_id) || olcekler[0]
        : null;
      // Satırın etiketi: ölçek değiştiyse "eski → yeni", yoksa sadece ölçek adı.
      const olcekDegisti = olcek && satir.scale_id && olcek.id !== satir.scale_id;
      const etiket = olcekDegisti
        ? `${urun.name} (${satir.scale || "ölçek"} → ${olcek.scale})`
        : urun.name + (olcek ? ` (${olcek.scale})` : "");
      satir.scale_id = olcek ? olcek.id : null;
      satir.scale = olcek ? olcek.scale : null;

      const guncel = Number(olcek ? olcek.price : (urun.sale_price || urun.price));
      if (Number.isFinite(guncel) && guncel !== Number(satir.price)) {
        degisenler.push({ ad: etiket, eski: Number(satir.price), yeni: guncel });
        satir.price = guncel;
      } else if (olcekDegisti) {
        degisenler.push({ ad: etiket, eski: Number(satir.price), yeni: guncel });
      }
      const guncelGorsel = urun.image_path || null;
      if (satir.name !== urun.name || satir.image !== guncelGorsel) {
        satir.name = urun.name;
        satir.image = guncelGorsel;
        sepetDegisti = true;
      }
    }

    if (!degisenler.length && !kalkanlar.length && !sepetDegisti) return;
    if (typeof saveCart === "function") saveCart();

    const kutu = qs("#cart-notice");
    if (kutu && (degisenler.length || kalkanlar.length)) {
      kutu.innerHTML = [
        ...degisenler.map((d) =>
          `<span><strong>${escapeHtml(d.ad)}</strong> fiyatı güncellendi: ${money(d.eski)} → <strong>${money(d.yeni)}</strong></span>`),
        ...kalkanlar.map((ad) =>
          `<span><strong>${escapeHtml(ad)}</strong> artık satışta olmadığı için sepetinizden çıkarıldı.</span>`)
      ].join("");
      kutu.hidden = false;
      kutu.style.removeProperty("display");
    }
    refreshCartViews();
    showStep(step);
  }

  refreshCartViews();
  if (isPaymentReturn) {
    showPaymentReturn();
  } else {
    showStep(1);
    fiyatlariTazele();
  }
})();

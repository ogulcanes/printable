// Multi-step checkout. Loaded after script.js, so it shares the global cart,
// money() and saveCart()/renderCart(). Server re-validates and re-prices everything.
(function () {
  const steps = document.querySelector("#checkout-steps");
  if (!steps) return;

  const qs = (s) => document.querySelector(s);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const panels = [...document.querySelectorAll(".checkout-panel")];
  const stepItems = [...document.querySelectorAll("#checkout-steps li")];
  let step = 1;
  const LAST = 4;

  // Client-side TC check for instant feedback; the server validates authoritatively.
  function isValidTC(v) {
    const tc = String(v || "").trim();
    if (!/^[1-9][0-9]{10}$/.test(tc)) return false;
    const d = tc.split("").map(Number);
    const odd = d[0] + d[2] + d[4] + d[6] + d[8];
    const even = d[1] + d[3] + d[5] + d[7];
    if ((((odd * 7) - even) % 10 + 10) % 10 !== d[9]) return false;
    return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
  }

  function renderCheckoutCart() {
    const box = qs("#checkout-cart");
    if (!cart.length) {
      box.innerHTML = `<p class="cart-empty">Sepetiniz boş. <a href="/urunler">Ürünlere göz atın</a></p>`;
      return;
    }
    box.innerHTML = cart.map((item) => `
      <article class="checkout-item">
        <img src="${item.image || "/assets/printable-logo.svg"}" alt="">
        <div class="checkout-item__info">
          <h3>${item.name}</h3>
          <p>${money(item.price)}</p>
          <div class="cart-qty">
            <button type="button" data-co-dec="${item.id}" aria-label="Azalt">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-co-inc="${item.id}" aria-label="Artır">+</button>
          </div>
        </div>
        <div class="checkout-item__end">
          <strong>${money(item.price * item.quantity)}</strong>
          <button type="button" class="cart-remove" data-co-remove="${item.id}">Kaldır</button>
        </div>
      </article>
    `).join("");
  }

  let taxRate = 20; // KDV hariç fiyatların üstüne eklenir; oran /api/site-info'dan gelir.

  // Campaigns are computed server-side; this holds the last preview so the
  // summary can show it. The server recomputes everything on submit anyway.
  let campaigns = { discount: 0, gifts: [], applied: [], incentives: [] };

  function renderSummary() {
    const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const discount = Math.min(campaigns.discount || 0, subtotal);
    const net = subtotal - discount;
    const tax = net * taxRate / 100;
    qs("#summary-items").innerHTML = cart.map((i) =>
      `<div class="summary-item"><span>${i.quantity} × ${i.name}</span><span>${money(i.price * i.quantity)}</span></div>`
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

    qs("#summary-tax-rate").textContent = `%${taxRate}`;
    qs("#summary-subtotal").textContent = money(subtotal);
    qs("#summary-tax").textContent = money(tax);
    qs("#summary-total").textContent = money(net + tax);
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
          items: cart.map((i) => ({ product_id: i.id, quantity: i.quantity }))
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

  // Pull the admin-set KDV rate so the summary matches the server's calculation.
  fetch("/api/site-info").then((r) => r.json()).then((info) => {
    if (info && Number.isFinite(Number(info.tax_rate))) { taxRate = Number(info.tax_rate); renderSummary(); }
  }).catch(() => {});

  function refreshCartViews() {
    renderCheckoutCart();
    renderSummary();
    // Cart changed → the qualifying campaigns may have changed with it.
    refreshCampaigns();
    if (typeof renderCart === "function") renderCart(); // keep the header drawer + count in sync
  }

  qs("#coupon-apply")?.addEventListener("click", refreshCampaigns);
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
    qs("#co-next").disabled = step === 1 && cart.length === 0;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const setError = (id, msg) => {
    const el = qs(id);
    el.textContent = msg || "";
    el.hidden = !msg;
  };

  function validateStep(n) {
    if (n === 1) return cart.length > 0;
    if (n === 2) {
      const f = qs("#delivery-form");
      if (!f.name.value.trim() || !f.phone.value.trim()) {
        setError("#delivery-error", "Ad soyad ve telefon zorunludur.");
        return false;
      }
      if (!f.city.value.trim() || !f.district.value.trim() || !f.address.value.trim()) {
        setError("#delivery-error", "İl, ilçe ve açık adres zorunludur.");
        return false;
      }
      setError("#delivery-error", "");
      return true;
    }
    if (n === 3) {
      const type = qs('input[name="invoice_type"]:checked').value;
      const f = qs("#invoice-form");
      if (type === "individual") {
        if (!isValidTC(f.tc_no.value)) { setError("#invoice-error", "Geçerli bir TC Kimlik Numarası girin (11 hane)."); return false; }
      } else {
        if (!f.company_name.value.trim()) { setError("#invoice-error", "Şirket unvanı zorunludur."); return false; }
        if (!f.tax_office.value.trim()) { setError("#invoice-error", "Vergi dairesi zorunludur."); return false; }
        if (!/^[0-9]{10}$/.test(f.tax_number.value.trim())) { setError("#invoice-error", "Vergi numarası 10 haneli olmalıdır."); return false; }
      }
      if (!qs("#same-address").checked && !f.billing_address.value.trim()) {
        setError("#invoice-error", "Fatura adresi girin veya teslimat adresiyle aynı seçeneğini işaretleyin.");
        return false;
      }
      setError("#invoice-error", "");
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
    const id = Number(inc || dec || rem);
    if (!id) return;
    const item = cart.find((i) => i.id === id);
    if (inc && item) item.quantity += 1;
    if (dec && item) { item.quantity -= 1; if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1); }
    if (rem) { const idx = cart.findIndex((i) => i.id === id); if (idx >= 0) cart.splice(idx, 1); }
    saveCart();
    refreshCartViews();
    qs("#co-next").disabled = cart.length === 0;
  });

  // Invoice type toggle
  document.querySelectorAll('input[name="invoice_type"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const type = qs('input[name="invoice_type"]:checked').value;
      document.querySelectorAll(".invoice-fields").forEach((box) => { box.hidden = box.dataset.for !== type; });
    });
  });

  qs("#same-address").addEventListener("change", (event) => {
    qs("#billing-address-field").hidden = event.target.checked;
  });

  qs("#co-submit").addEventListener("click", async () => {
    if (!cart.length) { setError("#payment-error", "Sepetiniz boş."); return; }
    const d = qs("#delivery-form");
    const inv = qs("#invoice-form");
    const type = qs('input[name="invoice_type"]:checked').value;
    const sameAddress = qs("#same-address").checked;
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
      invoice: {
        type,
        tc_no: inv.tc_no.value.trim(),
        company_name: inv.company_name.value.trim(),
        tax_office: inv.tax_office.value.trim(),
        tax_number: inv.tax_number.value.trim(),
        same_as_shipping: sameAddress,
        billing_address: sameAddress ? "" : inv.billing_address.value.trim()
      },
      payment_method: qs('input[name="payment_method"]:checked').value,
      // Only the code travels — the server prices the campaign itself.
      coupon_code: qs("#coupon-code")?.value.trim() || "",
      items: cart.map((i) => ({ product_id: i.id, quantity: i.quantity }))
    };

    const button = qs("#co-submit");
    button.disabled = true;
    setError("#payment-error", "");
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sipariş oluşturulamadı.");
      // Success: clear the cart and show confirmation.
      cart.length = 0;
      saveCart();
      if (typeof renderCart === "function") renderCart();
      qs("#checkout-result").hidden = false;
      qs("#checkout-result").innerHTML = `
        <div class="checkout-success">
          <strong>Siparişiniz alındı! 🎉</strong>
          <p>Sipariş numaranız: <b>${data.order_number}</b></p>
          <p>${payload.payment_method === "havale" ? "Havale/EFT bilgileri e-posta ile paylaşılacaktır." : payload.payment_method === "kapida" ? "Teslimatta ödeme alınacaktır." : ""}</p>
          <p class="checkout-success__note">Kargo ücreti teslimatta alıcı tarafından ödenir.</p>
          <a class="btn-outline" href="/urunler">Alışverişe devam et</a>
        </div>`;
      qs("#co-submit").hidden = true;
      qs("#co-prev").hidden = true;
      document.querySelectorAll(".checkout-panel[data-step]").forEach((p) => { if (p.dataset.step !== "4") p.classList.remove("active"); });
    } catch (err) {
      setError("#payment-error", err.message);
      button.disabled = false;
    }
  });

  refreshCartViews();
  showStep(1);
})();

/* Toptan katalog seçim aracı — anahtarlık ve çakmaklık katalogları ortak.

   Her iki sayfa da aynı akışı kullanıyor: kartı seç, adet yaz, iletişim
   bilgisiyle toplu talebi gönder. Mantık bu tek dosyada durur; sayfalar
   yalnızca kendi ürün listesini, kimlik önekini, uç noktasını ve alt
   sınırlarını verir. Yeni bir katalog eklerken bu dosya kopyalanmaz —
   initKatalogSecim() yeni bir yapılandırmayla çağrılır.

   Kart sınıfları (keychain-*) styles.css'teki ortak katalog bloğundan gelir;
   iki katalog da bilerek aynı görünümü paylaşır. Sınıf adları ortak, yalnızca
   element kimlikleri sayfaya göre öneklenir. */

function initKatalogSecim(config) {
  const {
    prefix,            // element kimlik öneki: "keychain", "lighter"…
    products,          // { id, name, tag, note, img } kayıtları
    endpoint,          // talebin gönderileceği API adresi
    minPerModel = 5,   // seçilen her modelden istenen en az adet
    minTotal = 50,     // siparişin tamamı için en az adet
    imageAltSuffix = "" // görsel alt metninin ürün adından sonraki kısmı
  } = config;

  const el = (name) => document.getElementById(`${prefix}-${name}`);
  const grid = el("grid");
  const selectAllBox = el("select-all");
  const countEl = el("count-selected");
  const totalEl = el("count-total");
  const totalQuantityEl = el("total-quantity");
  const exportHint = el("export-hint");
  const form = el("request-form");
  const submitBtn = el("request-submit");
  const statusEl = el("request-status");
  const formModelCount = el("form-model-count");
  const formTotal = el("form-total");
  const formRule = el("form-rule");

  if (!grid || !form) return;

  const escapeHtml = (value) => String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  totalEl.textContent = products.length;

  const selected = new Set();

  function showHint(text) {
    exportHint.textContent = text;
    exportHint.classList.add("is-visible");
  }

  function selectedItems() {
    return products.filter((product) => selected.has(product.id)).map((product) => ({
      id: product.id,
      quantity: Number(grid.querySelector(`[data-quantity-for="${product.id}"]`)?.value || 0)
    }));
  }

  function updateCount() {
    const items = selectedItems();
    const invalidQuantity = items.some((item) => !Number.isInteger(item.quantity) || item.quantity < minPerModel);
    const totalQuantity = items.reduce((sum, item) => sum + (Number.isFinite(item.quantity) ? item.quantity : 0), 0);
    countEl.textContent = selected.size;
    totalQuantityEl.textContent = totalQuantity;
    formModelCount.textContent = selected.size;
    formTotal.textContent = totalQuantity;
    selectAllBox.checked = selected.size === products.length;
    selectAllBox.indeterminate = selected.size > 0 && selected.size < products.length;
    submitBtn.disabled = !selected.size || invalidQuantity || totalQuantity < minTotal;

    if (!selected.size) {
      showHint(`Önce istediğiniz modelleri seçin. Toplam en az ${minTotal} adet olmalı.`);
      formRule.textContent = `Gönderebilmek için model seçin ve toplam ${minTotal} adede ulaşın.`;
    } else if (invalidQuantity) {
      showHint(`Seçilen her modelden en az ${minPerModel} adet yazmalısınız.`);
      formRule.textContent = `Her seçilen model için adet sayısı en az ${minPerModel} olmalı.`;
    } else if (totalQuantity < minTotal) {
      const remaining = minTotal - totalQuantity;
      showHint(`Minimum sipariş için ${remaining} adet daha ekleyin.`);
      formRule.textContent = `Gönderebilmek için ${remaining} adet daha ekleyin.`;
    } else {
      showHint("Seçiminiz hazır. İletişim bilgilerinizi yazıp talebi gönderebilirsiniz.");
      formRule.textContent = "Minimum adet koşulları tamamlandı.";
    }
  }

  function setSelected(id, cardEl, enabled) {
    const selectButton = cardEl.querySelector(".keychain-card__select");
    const quantityWrap = cardEl.querySelector(".keychain-card__quantity");
    const quantityInput = quantityWrap.querySelector("input");
    if (enabled) {
      selected.add(id);
      cardEl.classList.add("is-selected");
      quantityWrap.hidden = false;
      quantityInput.disabled = false;
      if (Number(quantityInput.value) < minPerModel) quantityInput.value = String(minPerModel);
    } else {
      selected.delete(id);
      cardEl.classList.remove("is-selected");
      quantityWrap.hidden = true;
      quantityInput.disabled = true;
    }
    selectButton.setAttribute("aria-pressed", String(enabled));
    updateCount();
  }

  function toggle(id, cardEl) { setSelected(id, cardEl, !selected.has(id)); }

  products.forEach((p) => {
    const name = escapeHtml(p.name);
    const tag = escapeHtml(p.tag);
    const card = document.createElement("article");
    card.className = "keychain-card";
    card.dataset.catalogId = p.id;
    card.innerHTML = `
      <button class="keychain-card__select" type="button" aria-pressed="false" aria-label="${name} modelini seç">
        <span class="keychain-card__thumb">
          <span class="keychain-card__tag">${tag}</span>
          ${p.img
            ? `<img src="${escapeHtml(p.img)}" alt="${name}${imageAltSuffix ? ` ${escapeHtml(imageAltSuffix)}` : ""}" loading="lazy">`
            : `<span class="keychain-card__fallback" aria-hidden="true"><span>3D</span><small>${tag}</small></span>`}
          <span class="keychain-card__check" aria-hidden="true"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span>
        </span>
        <span class="keychain-card__body">
          <span class="keychain-card__name">${name}</span>
          <span class="keychain-card__note">${escapeHtml(p.note)}</span>
        </span>
      </button>
      <div class="keychain-card__quantity" hidden>
        <label for="${prefix}-quantity-${p.id}">Adet</label>
        <input id="${prefix}-quantity-${p.id}" data-quantity-for="${p.id}" type="number" inputmode="numeric" min="${minPerModel}" step="1" value="${minPerModel}" disabled>
        <small>En az ${minPerModel}</small>
      </div>
    `;
    card.querySelector(".keychain-card__select").addEventListener("click", () => toggle(p.id, card));
    card.querySelector("input").addEventListener("input", updateCount);
    grid.appendChild(card);
  });

  selectAllBox.addEventListener("change", () => {
    /* Kutunun durumu DÖNGÜDEN ÖNCE okunmalı: setSelected() her çağrıda
       updateCount()'u çalıştırıyor, o da selectAllBox.checked'i yeniden
       hesaplıyor. Döngü içinde okunursa ilk kart seçildikten sonra kutu
       kendiliğinden false'a düşer ve geri kalan kartlar seçilmez. */
    const enable = selectAllBox.checked;
    grid.querySelectorAll(".keychain-card").forEach((card) => setSelected(card.dataset.catalogId, card, enable));
    updateCount();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "keychain-request-status";

    const items = selectedItems();
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    if (!items.length || items.some((item) => !Number.isInteger(item.quantity) || item.quantity < minPerModel)) {
      statusEl.textContent = `Seçtiğiniz her modelden en az ${minPerModel} adet yazın.`;
      statusEl.classList.add("is-error");
      return;
    }
    if (totalQuantity < minTotal) {
      statusEl.textContent = `Toplu sipariş toplamı en az ${minTotal} adet olmalıdır.`;
      statusEl.classList.add("is-error");
      return;
    }
    if (!form.reportValidity()) return;

    const formData = new FormData(form);
    const payload = {
      first_name: String(formData.get("first_name") || "").trim(),
      last_name: String(formData.get("last_name") || "").trim(),
      phone: String(formData.get("phone") || "").trim(),
      email: String(formData.get("email") || "").trim(),
      items
    };

    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Talebiniz gönderiliyor…";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Talebiniz gönderilemedi.");

      form.reset();
      grid.querySelectorAll(".keychain-card").forEach((card) => {
        const input = card.querySelector("input");
        input.value = String(minPerModel);
        setSelected(card.dataset.catalogId, card, false);
      });
      statusEl.textContent = "Talebiniz alındı. Fiyat ve teslimat bilgileri için sizinle iletişime geçeceğiz.";
      statusEl.classList.add("is-success");
    } catch (error) {
      statusEl.textContent = error.message;
      statusEl.classList.add("is-error");
    } finally {
      submitBtn.textContent = originalLabel;
      updateCount();
    }
  });

  updateCount();
}

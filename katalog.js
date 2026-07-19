// Katalog sayfası. script.js'ten SONRA yüklenir, money() ve escapeHtml gibi
// yardımcıları oradan alır. IIFE, script.js'in üst düzey adlarıyla çakışmasın diye.
(function () {
  const govde = document.querySelector("#catalog-body");
  if (!govde) return;

  const qs = (sel) => document.querySelector(sel);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const kacir = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  const durum = { arama: "", kategori: "", sadeceToplu: false };
  let veri = { products: [], general_campaigns: [] };

  const birimFiyat = (p) => Number(p.sale_price || p.price) || 0;

  /* Kademe etiketi. "10 adet %15 indirim" ile "10 adet 1.700,00 TL" farklı
     bilgiler: ilki kuralı, ikincisi cebinden çıkacak parayı söylüyor. İkisini
     birden gösteriyoruz — toplu alım yapan kişi toplam tutarı arıyor. */
  function kademeSatiri(k) {
    const kural = k.discount_type === "percent"
      ? `%${k.discount_value} indirim`
      : `${money(k.discount_value)} indirim`;
    return `
      <tr>
        <td><strong>${k.min_quantity}+ adet</strong></td>
        <td>${kacir(kural)}${k.code ? ` <span class="catalog-code">kod: ${kacir(k.code)}</span>` : ""}</td>
        <td class="catalog-num">${money(k.unit_price)}</td>
        <td class="catalog-num">${money(k.total_price)}</td>
        <td class="catalog-num catalog-save">${money(k.saving)}</td>
      </tr>`;
  }

  function urunKarti(p) {
    const indirimli = p.sale_price && p.price > p.sale_price;
    const renkler = (p.colors || []).length
      ? `<div class="catalog-colors">
           ${p.colors.map((c) => `<span class="catalog-color"><span class="color-dot" style="background:${kacir(c.hex)}"></span>${kacir(c.name)}</span>`).join("")}
         </div>`
      : `<p class="catalog-nocolor">Renk seçeneği tanımlı değil</p>`;

    const kademeler = (p.tiers || []).length
      ? `<table class="catalog-tiers">
           <thead>
             <tr><th>Adet</th><th>Kampanya</th><th>Birim</th><th>Toplam</th><th>Kazanç</th></tr>
           </thead>
           <tbody>${p.tiers.map(kademeSatiri).join("")}</tbody>
         </table>`
      : `<p class="catalog-notier">Bu ürün için tanımlı toplu alım kademesi yok — <a href="/iletisim">teklif isteyin</a>.</p>`;

    return `
      <article class="catalog-item">
        <div class="catalog-item__media">
          <img src="${kacir(p.image_path) || "/assets/printable-logo.svg"}" alt="${kacir(p.image_alt || p.name)}" loading="lazy">
        </div>
        <div class="catalog-item__body">
          <div class="catalog-item__head">
            <div>
              <h3><a href="/urun/${p.id}">${kacir(p.name)}</a></h3>
              <p class="catalog-meta">
                ${p.sku ? `<span>Kod: ${kacir(p.sku)}</span>` : ""}
                ${(p.categories || []).map((c) => `<span>${kacir(c.name)}</span>`).join("")}
              </p>
            </div>
            <p class="catalog-price">
              ${money(birimFiyat(p))}
              ${indirimli ? `<s>${money(p.price)}</s>` : ""}
              <small>tek adet</small>
            </p>
          </div>
          ${p.description ? `<p class="catalog-desc">${kacir(p.description)}</p>` : ""}
          ${renkler}
          ${kademeler}
        </div>
      </article>`;
  }

  function genelKampanyalar() {
    const kutu = qs("#catalog-general");
    const liste = veri.general_campaigns || [];
    if (!liste.length) { kutu.hidden = true; return; }
    kutu.hidden = false;
    kutu.innerHTML = `
      <h2>Tüm siparişlerde geçerli kampanyalar</h2>
      <ul>
        ${liste.map((c) => {
          const kural = c.kind === "gift"
            ? "hediye ürün"
            : c.discount_type === "percent" ? `%${c.discount_value} indirim` : `${money(c.discount_value)} indirim`;
          const kosul = c.min_order_total ? ` (${money(c.min_order_total)} ve üzeri alışverişlerde)` : "";
          return `<li><strong>${kacir(c.name)}</strong> — ${kacir(kural)}${kacir(kosul)}${c.code ? ` · kod: <span class="catalog-code">${kacir(c.code)}</span>` : ""}</li>`;
        }).join("")}
      </ul>`;
  }

  function ciz() {
    const ara = durum.arama.trim().toLocaleLowerCase("tr");
    const liste = veri.products.filter((p) => {
      if (ara) {
        const havuz = [p.name, p.sku].filter(Boolean).join(" ").toLocaleLowerCase("tr");
        if (!havuz.includes(ara)) return false;
      }
      if (durum.kategori && !(p.categories || []).some((c) => String(c.id) === durum.kategori)) return false;
      if (durum.sadeceToplu && !(p.tiers || []).length) return false;
      return true;
    });

    qs("#catalog-count").textContent = liste.length === veri.products.length
      ? `${liste.length} ürün`
      : `${liste.length} / ${veri.products.length} ürün`;

    govde.innerHTML = liste.map(urunKarti).join("")
      || `<p class="catalog-loading">Aramanıza uyan ürün bulunamadı.</p>`;
  }

  function kategorileriDoldur() {
    const gorulen = new Map();
    veri.products.forEach((p) => (p.categories || []).forEach((c) => gorulen.set(c.id, c.name)));
    qs("#catalog-category").innerHTML = '<option value="">Tüm kategoriler</option>'
      + [...gorulen].map(([id, ad]) => `<option value="${id}">${kacir(ad)}</option>`).join("");
  }

  qs("#catalog-search").addEventListener("input", (e) => { durum.arama = e.target.value; ciz(); });
  qs("#catalog-category").addEventListener("change", (e) => { durum.kategori = e.target.value; ciz(); });
  qs("#catalog-only-bulk").addEventListener("change", (e) => { durum.sadeceToplu = e.target.checked; ciz(); });
  qs("#catalog-print").addEventListener("click", () => window.print());

  async function baslat() {
    try {
      veri = await fetch("/api/catalog").then((r) => r.json());
    } catch {
      govde.innerHTML = `<p class="catalog-loading">Katalog yüklenemedi. Sayfayı yenileyin.</p>`;
      return;
    }
    if (!Array.isArray(veri.products)) veri.products = [];
    kategorileriDoldur();
    genelKampanyalar();
    ciz();
    qs("#catalog-date").textContent =
      `Bu katalog ${new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })} tarihinde oluşturulmuştur. Fiyatlar değişebilir.`;
  }

  baslat();
})();

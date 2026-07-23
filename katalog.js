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

  /* Ölçekli üründe birim fiyat EN UCUZ ölçeğinkidir; o üründe sale_price
     uygulanmıyor (bkz. script.js displayPrice, sunucuda normalizeCartItems). */
  const birimFiyat = (p) => Number(displayPrice(p)) || 0;

  /* Kademe etiketi. "10 adet %15 indirim" ile "10 adet 1.700,00 TL" farklı
     bilgiler: ilki kuralı, ikincisi cebinden çıkacak parayı söylüyor. İkisini
     birden gösteriyoruz — toplu alım yapan kişi toplam tutarı arıyor. */
  /* "10+ adet" yalnızca yüzde indirimde doğru. Sabit indirim sepete BİR KEZ
     uygulandığı için hesaplanan birim fiyat sadece TAM o adette geçerli;
     üstünde müşteri daha fazla öder. quantity_exact bunu ayırt ediyor. */
  const kademeAdet = (k) => (k.quantity_exact ? `${k.min_quantity} adette` : `${k.min_quantity}+ adet`);

  function kademeSatiri(k) {
    const kural = k.discount_type === "percent"
      ? `%${k.discount_value} indirim`
      : `${money(k.discount_value)} indirim`;
    /* Kampanyanın minimum sepet tutarı varsa ve bu ürün tek başına o tutarı
       karşılamıyorsa şartı yazıyoruz. Yazmasaydık katalog tutulamayacak bir
       söz verirdi: müşteri 10 adet alır, ara toplam sınırın altında kalır,
       ödemede indirim uygulanmaz. */
    const sart = k.min_order_total && !k.min_order_met
      ? ` <span class="catalog-cond">${money(k.min_order_total)} ve üzeri sepette</span>`
      : "";
    return `
      <tr>
        <td><strong>${kademeAdet(k)}</strong></td>
        <td>${kacir(kural)}${sart}</td>
        <td class="catalog-num">${money(k.unit_price)}</td>
        <td class="catalog-num">${money(k.total_price)}</td>
        <td class="catalog-num catalog-save">${money(k.saving)}</td>
      </tr>`;
  }

  function urunKarti(p) {
    const olcekler = p.scales || [];
    const indirimli = !olcekler.length && p.sale_price && p.price > p.sale_price;
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
              <small>${olcekler.length > 1 ? `tek adet · ${olcekler.length} ölçek` : "tek adet"}</small>
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
          return `<li><strong>${kacir(c.name)}</strong> — ${kacir(kural)}${kacir(kosul)}</li>`;
        }).join("")}
      </ul>`;
  }

  /* Kâğıt/PDF için yoğun fiyat listesi.

     Kart düzeni ekranda iyi ama yazdırınca 16 ürün metrelerce sürüyordu.
     Toptancı fiyat listesi mantığı: her ürün BİR satır, adet kademeleri
     SÜTUN. Sütunlar tüm ürünlerdeki farklı kademelerin birleşimi — bir
     ürün o kademeye girmiyorsa hücre boş kalır. */
  function tabloCiz(liste) {
    const kademeAdetleri = [...new Set(
      liste.flatMap((p) => (p.tiers || []).map((t) => t.min_quantity))
    )].sort((a, b) => a - b);

    const basliklar = [
      "<th>Ürün</th>", "<th>Kod</th>", "<th>Renkler</th>",
      '<th class="catalog-num">1 adet</th>',
      ...kademeAdetleri.map((n) => `<th class="catalog-num">${n} adet+</th>`)
    ].join("");

    const satirlar = liste.map((p) => {
      const birim = birimFiyat(p);
      const renkler = (p.colors || []).map((c) => kacir(c.name)).join(", ") || "—";
      const hucreler = kademeAdetleri.map((n) => {
        const t = (p.tiers || []).find((x) => x.min_quantity === n);
        return t
          ? `<td class="catalog-num"><strong>${money(t.unit_price)}</strong></td>`
          : `<td class="catalog-num catalog-empty">—</td>`;
      }).join("");
      return `
        <tr>
          <td class="catalog-tname">${kacir(p.name)}</td>
          <td>${kacir(p.sku) || "—"}</td>
          <td class="catalog-tcolors">${renkler}</td>
          <td class="catalog-num">${money(birim)}</td>
          ${hucreler}
        </tr>`;
    }).join("");

    return `
      <table class="catalog-table">
        <thead><tr>${basliklar}</tr></thead>
        <tbody>${satirlar}</tbody>
      </table>
      ${kademeAdetleri.length ? "" : '<p class="catalog-notier">Henüz toplu alım kademesi tanımlı değil.</p>'}`;
  }

  /* PDF'e gömülen görsel kâğıtta ~32mm basılıyor; 1400px'lik aslı gereksiz
     yer kaplıyor. Supabase'de duran görseller küçültülerek isteniyor.
     resize=contain ŞART: yalnızca width verilince Supabase oranı korumuyor,
     görseli hedef genişliğe eziyor. Dış adresler (MakerWorld) olduğu gibi
     kalır — onları dönüştüremeyiz. */
  const pdfGorseli = (url) => {
    if (!url) return url;
    if (url.includes("/storage/v1/object/public/")) {
      return `${url.replace("/object/public/", "/render/image/public/")}?width=400&resize=contain&quality=80`;
    }
    /* Ürün görsellerinin çoğu MakerWorld CDN'inde ve adreslerinde zaten
       "w_1200" var. 34 ürünün 1200px görselini PDF'e gömmek dosyayı 36 MB
       yapıyordu; aynı parametreyi 500'e çekmek e-postayla gönderilebilir
       hale getiriyor. 400px: kâğıtta 30mm basılan kare için 300 DPI eder,
       yani baskı çözünürlüğü tam. Ölçüm: 500px→10.5MB, 400px→7.3MB,
       320px→5.1MB. Parametre yoksa adrese dokunmuyoruz. */
    if (url.includes("x-oss-process=image/resize,w_")) {
      return url.replace(/resize,w_\d+/, "resize,w_400");
    }
    return url;
  };

  /* Yazdırma sürümü: katlaç kataloğuyla aynı dil — logo, tarih, numaralı
     satırlar. Kademeler satırın sağında dikey bir fiyat bloğu olarak
     duruyor; tabloda sütun olarak vermek 34 ürüne yayılınca okunmuyordu. */
  function yazdirmaCiz(liste) {
    document.querySelector("#print-rows").innerHTML = liste.map((p, i) => {
      const birim = birimFiyat(p);
      const indirimli = p.sale_price && p.price > p.sale_price;
      const renkler = (p.colors || []).map((c) => kacir(c.name)).join(", ");
      const kademeler = (p.tiers || []).map((t) =>
        `<span class="print-tier"><em>${t.quantity_exact ? t.min_quantity : t.min_quantity + "+"}</em> ${money(t.unit_price)}${
          t.min_order_total && !t.min_order_met ? `<i>*</i>` : ""}</span>`).join("");

      return `
        <article class="print-row">
          <span class="print-row__no">${String(i + 1).padStart(2, "0")}</span>
          <img class="print-row__img" src="${kacir(pdfGorseli(p.image_path)) || "/assets/printable-logo.svg"}"
               alt="${kacir(p.image_alt || p.name)}">
          <div class="print-row__text">
            <h2>${kacir(p.name)}</h2>
            <p class="print-row__meta">
              ${p.sku ? `<span>${kacir(p.sku)}</span>` : ""}
              ${(p.categories || []).map((c) => `<span>${kacir(c.name)}</span>`).join("")}
            </p>
            ${renkler ? `<p class="print-row__colors">${renkler}</p>` : ""}
          </div>
          <div class="print-row__prices">
            <span class="print-row__unit">${money(birim)}${indirimli ? ` <s>${money(p.price)}</s>` : ""}</span>
            ${kademeler ? `<span class="print-row__tiers">${kademeler}</span>` : ""}
          </div>
        </article>`;
    }).join("");

    const genel = veri.general_campaigns || [];
    const kutu = document.querySelector("#print-campaigns");
    kutu.innerHTML = genel.length
      ? `<strong>Tüm siparişlerde:</strong> ${genel.map((c) => {
          const kural = c.kind === "gift" ? "hediye ürün"
            : c.discount_type === "percent" ? `%${c.discount_value} indirim` : `${money(c.discount_value)} indirim`;
          return `${kacir(c.name)} — ${kacir(kural)}`;
        }).join(" · ")}`
      : "";
    kutu.hidden = !genel.length;

    document.querySelector("#print-date").textContent =
      new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
    document.querySelector("#print-count").textContent = `${liste.length} ürün`;

    // Yıldızlı kademelerin şartı dipnotta açıklansın.
    const sartliVar = liste.some((p) => (p.tiers || []).some((t) => t.min_order_total && !t.min_order_met));
    document.querySelector("#print-note").textContent = sartliVar
      ? "* Bu kademe yalnızca kampanyanın minimum sepet tutarı sağlandığında geçerlidir."
      : "";
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

    // Tablo görünümü ekranda seçilebiliyor; yazdırma sürümü her zaman hazır
    // tutuluyor ki filtre neyse PDF de onu bassın.
    qs("#catalog-table-view").innerHTML = liste.length
      ? tabloCiz(liste)
      : `<p class="catalog-loading">Aramanıza uyan ürün bulunamadı.</p>`;
    yazdirmaCiz(liste);
  }

  /* Ekranda görünüm seçimi. Yazdırma her hâlükârda tabloyu basar — kâğıtta
     kart düzeni okunabilir değil, kullanıcının ayrıca seçmesini beklemek
     yanlış çıktıyı varsayılan yapardı. */
  function gorunumSec(tablo) {
    document.body.classList.toggle("catalog-view-table", tablo);
    qs("#view-cards").classList.toggle("active", !tablo);
    qs("#view-table").classList.toggle("active", tablo);
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
  qs("#catalog-print").addEventListener("click", () => {
    const gorseller = [...document.querySelectorAll("#print-rows img")];
    Promise.all(gorseller.map((i) => i.complete ? Promise.resolve() : new Promise((r) => {
      i.addEventListener("load", r, { once: true });
      i.addEventListener("error", r, { once: true });
    }))).then(() => window.print());
  });
  qs("#view-cards").addEventListener("click", () => gorunumSec(false));
  qs("#view-table").addEventListener("click", () => gorunumSec(true));

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

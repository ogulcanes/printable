// Product detail page. Loaded AFTER script.js, so it reuses that file's globals
// (money, productCardHTML, observeCards, cart, renderCart, cartPanel). IIFE keeps
// its own helpers from colliding with script.js's top-level declarations.
(function () {
  const detail = document.querySelector("#product-detail");
  if (!detail) return;

  const match = location.pathname.match(/\/urun\/(\d+)/);
  const id = match ? Number(match[1]) : null;

  const notFound = () => `<p class="products-empty">Ürün bulunamadı. <a href="/urunler">Tüm ürünlere dön</a></p>`;

  if (!id) { detail.innerHTML = notFound(); return; }

  /* escapeHtml ve stars product-templates.js'ten geliyor. Yorumlar kimliksiz
     ziyaretçi girdisi — hiçbir yerde ham basılmıyor. */

  const reviewDate = (value) => {
    if (!value) return "";
    // Postgres ISO ("…T19:10:27.641Z") ve saat dilimsiz "YYYY-MM-DD HH:MM:SS"
    // biçimlerinin ikisini de kabul et; ISO'ya Z eklemek tarihi geçersiz kılar.
    const text = String(value);
    const hasZone = /[TZ]|[+-]\d{2}:?\d{2}$/.test(text);
    const date = new Date(hasZone ? text : `${text.replace(" ", "T")}Z`);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
  };

  let stokGoster = true;   // /api/site-info doldurur

  /* Galeride gösterilecek kareler.

     Renk seçili DEĞİLKEN: kapak başta, sonra tüm galeri. Ürün kartında görülen
     fotoğrafın sayfada da ilk açılması bekleniyor.

     Renk seçiliyken: önce O RENGİN fotoğrafları, sonra renksiz olanlar. Sıra
     önemli — ana görsel her zaman ilk kare olduğu için, kırmızıyı seçen
     müşteriye mavi kapak fotoğrafını göstermemek gerekiyor. Renksizler
     listeden atılmıyor çünkü çoğu ürünün renkten bağımsız çekimleri de var
     (ölçek, ambalaj, kullanım); onları gizlemek bilgi kaybı olurdu. */
  let seciliRenkId = null;

  /* Seçili ölçek (küçük/büyük boy gibi). Ölçek yalnızca bir etiket değil, kendi
     fiyatı olan bir varyant: seçim değişince sayfadaki fiyat da, sepete giden
     satır da değişir. Varsayılan en ucuzu — kartta gördüğü fiyat bu, sayfa
     açılınca aynı rakamı görmeli. Ölçeksiz ürünlerde null kalır. */
  let seciliOlcekId = null;
  // olceklerOf / seciliOlcek / galeriKareleri / anaMedyaHTML: product-templates.js

  function galeriyiBagla(product) {
    const thumbs = document.querySelector("#gallery-thumbs");
    const ana = document.querySelector(".gallery-main");
    if (!thumbs || !ana) return;
    thumbs.addEventListener("click", (event) => {
      const buton = event.target.closest("[data-gallery-index]");
      if (!buton) return;
      const kare = galeriKareleri(product, seciliRenkId)[Number(buton.dataset.galleryIndex)];
      if (!kare) return;
      ana.innerHTML = anaMedyaHTML(kare);
      thumbs.querySelectorAll(".gallery-thumb").forEach((b) => b.classList.toggle("active", b === buton));
    });
  }

  function render(product) {
    /* İşaretleme product-templates.js'te — sunucu ilk HTML'i AYNI fonksiyonla
       basıyor. Şablonu burada tutmak, sunucu sürümüyle zamanla ayrışıp sayfanın
       JS yüklenince zıplamasına yol açardı. Burada yalnızca durum ve olay
       bağlama kalıyor. */
    detail.innerHTML = productDetailHTML(product, { seciliOlcekId, seciliRenkId, stokGoster });

    galeriyiBagla(product);

    /* Renk noktasına basınca galeri o rengin fotoğraflarına geçer. Aynı renge
       tekrar basmak seçimi kaldırır — kullanıcı "hepsini göster"e dönebilsin. */
    detail.querySelectorAll("[data-color-pick]").forEach((nokta) => {
      nokta.addEventListener("click", () => {
        const secilen = Number(nokta.dataset.colorPick);
        seciliRenkId = seciliRenkId === secilen ? null : secilen;
        render(product);   // galeri ve nokta durumları yeniden çizilir
      });
    });

    // Ölçek değişince fiyat, seçili buton ve sepete gidecek satır değişir.
    detail.querySelectorAll("[data-scale-pick]").forEach((buton) => {
      buton.addEventListener("click", () => {
        seciliOlcekId = Number(buton.dataset.scalePick);
        render(product);
      });
    });

    document.querySelector("#detail-add")?.addEventListener("click", () => {
      const qty = Math.max(1, parseInt(document.querySelector("#detail-qty").value, 10) || 1);
      addToCart(product, qty, seciliOlcek(product, seciliOlcekId));
      if (typeof cartPanel !== "undefined" && cartPanel) cartPanel.classList.add("open");
    });
  }

  // Score breakdown + list. Rendered from the approved-only public endpoint, so
  // the count here always matches what the star average was computed from.
  function renderReviews(reviews) {
    const section = document.querySelector("#reviews-section");
    const summary = document.querySelector("#reviews-summary");
    const list = document.querySelector("#review-list");
    if (!section) return;
    section.hidden = false;

    const count = reviews.length;
    const average = count ? reviews.reduce((sum, r) => sum + r.rating, 0) / count : 0;

    summary.innerHTML = count
      ? `
        <strong class="reviews-summary__score">${average.toFixed(1)}</strong>
        ${stars(average)}
        <span class="reviews-summary__count">${count} değerlendirme</span>
        <div class="reviews-bars">
          ${[5, 4, 3, 2, 1].map((star) => {
            const n = reviews.filter((r) => r.rating === star).length;
            return `
              <div class="reviews-bar">
                <span>${star}★</span>
                <div class="reviews-bar__track"><i style="width:${count ? (n / count) * 100 : 0}%"></i></div>
                <span class="reviews-bar__n">${n}</span>
              </div>`;
          }).join("")}
        </div>`
      : `<strong class="reviews-summary__score">—</strong>
         ${stars(0)}
         <span class="reviews-summary__count">Henüz değerlendirme yok</span>
         <p class="reviews-summary__cta">İlk yorumu siz yazın.</p>`;

    list.innerHTML = reviews.map((r) => `
      <article class="review">
        <div class="review__head">
          <strong>${escapeHtml(r.author_name)}</strong>
          ${stars(r.rating)}
        </div>
        <span class="review__date">${reviewDate(r.created_at)}</span>
        ${r.comment ? `<p>${escapeHtml(r.comment)}</p>` : ""}
      </article>
    `).join("");
  }

  async function loadReviews() {
    try {
      const reviews = await fetch(`/api/products/${id}/reviews`).then((r) => r.json());
      renderReviews(Array.isArray(reviews) ? reviews : []);
    } catch {
      renderReviews([]);
    }
  }

  function wireReviewForm() {
    const form = document.querySelector("#review-form");
    if (!form) return;
    const status = document.querySelector("#review-status");
    const button = document.querySelector("#review-submit");
    const setStatus = (message, ok) => {
      status.textContent = message;
      status.hidden = !message;
      status.classList.toggle("contact-status--ok", ok === true);
      status.classList.toggle("contact-status--err", ok === false);
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.rating) { setStatus("Lütfen 1-5 arası bir puan seçin.", false); return; }
      button.disabled = true;
      setStatus("Gönderiliyor…", null);
      try {
        const res = await fetch(`/api/products/${id}/reviews`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || "Değerlendirme gönderilemedi.");
        form.reset();
        setStatus("Teşekkürler! Yorumunuz onaylandıktan sonra yayınlanacak.", true);
      } catch (error) {
        setStatus(error.message, false);
      } finally {
        button.disabled = false;
      }
    });
  }

  function renderRelated(all, product) {
    const catIds = new Set((product.categories || []).map((c) => c.id));
    const related = all.filter((p) =>
      p.is_active && p.id !== product.id && (p.categories || []).some((c) => catIds.has(c.id))
    ).slice(0, 5);
    if (!related.length) return;
    document.querySelector("#related-products").innerHTML = related.map(productCardHTML).join("");
    document.querySelector("#related-section").hidden = false;
    if (typeof observeCards === "function") observeCards();
  }

  async function init() {
    let product = null;
    let all = [];
    try {
      let bilgi;
      [product, all, bilgi] = await Promise.all([
        fetch(`/api/products/${id}`).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/products").then((r) => r.json()).catch(() => []),
        fetch("/api/site-info").then((r) => r.json()).catch(() => ({}))
      ]);
      if (bilgi && bilgi.show_stock !== undefined) stokGoster = Number(bilgi.show_stock) === 1;
    } catch { product = null; }
    if (!product || !product.is_active) { detail.innerHTML = notFound(); return; }
    window.printableProducts = all.length ? all : [product]; // so any data-add-product resolves
    render(product);
    renderRelated(all, product);
    wireReviewForm();
    loadReviews();
  }

  init();
})();

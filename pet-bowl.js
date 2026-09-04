/* İsme özel evcil hayvan mama kabı yapılandırıcısı.
 *
 * Bölüm ana sayfada, /urunler ve /landing'de aynı markup ile duruyor. Boyut,
 * fiyat ve renk listesi SADECE burada tanımlı: üç HTML dosyasına kopyalanırsa
 * biri güncellenip diğerleri unutulur ve ziyaretçi sayfaya göre farklı fiyat
 * görür. HTML tarafında yalnızca boş bir kap var, gerisini bu dosya basar.
 *
 * Ürün henüz katalogda değil (fiyat/stok kaydı yok), o yüzden sepet yerine
 * mevcut özel üretim talep formuna yönlendiriyoruz; seçimler URL ile taşınıyor
 * ve tasarim.js formu ona göre dolduruyor.
 */
(function () {
  const mounts = document.querySelectorAll("[data-pet-config]");
  if (!mounts.length) return;

  /* Fiyatlar KDV dahil, tek parça. Değişince tek yer burası. */
  const SIZES = [
    { id: "15", label: "15 cm", note: "Kedi & küçük ırk", price: 850 },
    { id: "20", label: "20 cm", note: "Orta ırk", price: 1250 },
    { id: "25", label: "25 cm", note: "Büyük ırk", price: 1750 }
  ];

  /* Panel rengi — gövde krem kalıyor, fotoğraftaki gibi. */
  const COLORS = [
    { id: "okyanus", name: "Okyanus Mavisi", hex: "#2e6799" },
    { id: "antrasit", name: "Antrasit", hex: "#343a42" },
    { id: "mercan", name: "Mercan", hex: "#ff6542" },
    { id: "yosun", name: "Yosun Yeşili", hex: "#5f8a5b" },
    { id: "gulkurusu", name: "Gül Kurusu", hex: "#c4737f" },
    { id: "krem", name: "Bisküvi", hex: "#d8c3a5" }
  ];

  const DEFAULT_NAME = "PAMUK";
  const MAX_NAME = 12;

  // Para biçimi site genelinde iki haneli: 1250.00 TL
  const money = (value) => `${Number(value || 0).toFixed(2)} TL`;
  // Türkçe büyük harf: "i" -> "İ". Varsayılan toUpperCase bunu "I" yapar.
  const upper = (value) => value.toLocaleUpperCase("tr-TR");

  const escapeHtml = (value) => String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  /* Kabartma yazı panelin içine sığmalı. Panelin isim hizasındaki genişliği
     ~150px; harf genişliği ~0.72em olduğundan bunu harf sayısına bölüp punto
     buluyoruz. Üst sınır olmasa tek harflik isim kabı boydan boya kaplardı. */
  const nameFontSize = (text) => Math.max(14, Math.min(38, 134 / (Math.max(text.length, 3) * 0.72)));

  /* Gövde ve panel aynı koni kenarlarını paylaşıyor: panelin alt dalgası
     y=152'de bitiyor, o hizada koninin kenarları x=59.7 ve x=240.3'te. Sayılar
     elle uydurulmadı, kenar denkleminden geliyor — koni değişirse ikisi de
     birlikte değişmeli, yoksa panel gövdenin dışına taşar. */
  const BODY = "M86,48 L46,206 Q150,228 254,206 L214,48 Z";
  const PANEL = "M86,46 L59.7,152 C70,180 90,184 108,170 C126,157 141,172 154,184 "
              + "C171,199 201,193 216,170 C226,155 234,160 240.3,152 L214,46 Z";

  function previewSvg() {
    return `
      <svg class="pet-preview__svg" viewBox="0 0 300 240" role="img" aria-labelledby="pet-preview-title">
        <title id="pet-preview-title">Seçtiğiniz renk ve isimle mama kabı önizlemesi</title>
        <defs>
          <linearGradient id="pet-steel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#fbfcfd"/><stop offset=".5" stop-color="#c6ced5"/>
            <stop offset="1" stop-color="#8a939b"/>
          </linearGradient>
          <radialGradient id="pet-bowl-in" cx=".5" cy=".18" r=".9">
            <stop offset="0" stop-color="#5f686f"/><stop offset=".6" stop-color="#8d959c"/>
            <stop offset="1" stop-color="#c3cad0"/>
          </radialGradient>
          <linearGradient id="pet-base" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#ded5c9"/><stop offset=".38" stop-color="#f7f2ec"/>
            <stop offset="1" stop-color="#d8cec1"/>
          </linearGradient>
          <linearGradient id="pet-shade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="rgba(0,0,0,.22)"/><stop offset=".38" stop-color="rgba(255,255,255,.12)"/>
            <stop offset="1" stop-color="rgba(0,0,0,.26)"/>
          </linearGradient>
          <clipPath id="pet-body-clip"><path d="${BODY}"/></clipPath>
        </defs>

        <ellipse cx="150" cy="220" rx="99" ry="12" fill="rgba(28,54,77,.15)"/>
        <path d="${BODY}" fill="url(#pet-base)"/>

        <g clip-path="url(#pet-body-clip)">
          <path data-pet-panel d="${PANEL}" fill="#2e6799"/>
          <path d="${PANEL}" fill="url(#pet-shade)"/>
        </g>
        <path d="${BODY}" fill="url(#pet-shade)" opacity=".55"/>

        <ellipse cx="150" cy="48" rx="64" ry="15.5" fill="url(#pet-steel)"/>
        <ellipse cx="150" cy="49" rx="54" ry="11.5" fill="url(#pet-bowl-in)"/>
        <path d="M104,44 A54,11.5 0 0 1 178,41" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.4" stroke-linecap="round"/>

        <g data-pet-name-group>
          <text data-pet-name-shadow class="pet-preview__name" x="150" y="122" text-anchor="middle" fill="rgba(0,0,0,.38)"></text>
          <text data-pet-name-light class="pet-preview__name" x="150" y="117.5" text-anchor="middle" fill="rgba(255,255,255,.32)"></text>
          <text data-pet-name class="pet-preview__name" x="150" y="119.6" text-anchor="middle"></text>
        </g>
      </svg>`;
  }

  function markup() {
    const sizes = SIZES.map((size, index) => `
      <label class="pet-size">
        <input type="radio" name="pet-size" value="${size.id}"${index === 1 ? " checked" : ""}>
        <span class="pet-size__box">
          <strong>${escapeHtml(size.label)}</strong>
          <small>${escapeHtml(size.note)}</small>
          <b>${money(size.price)}</b>
        </span>
      </label>`).join("");

    const colors = COLORS.map((color, index) => `
      <label class="pet-color" title="${escapeHtml(color.name)}">
        <input type="radio" name="pet-color" value="${color.id}"${index === 0 ? " checked" : ""}>
        <span class="pet-color__dot" style="--dot:${escapeHtml(color.hex)}"></span>
        <span class="pet-color__name">${escapeHtml(color.name)}</span>
      </label>`).join("");

    return `
      <div class="pet-config__preview">
        ${previewSvg()}
        <p class="pet-config__caption" data-pet-caption></p>
      </div>

      <div class="pet-config__controls">
        <fieldset class="pet-field">
          <legend>Boyut</legend>
          <div class="pet-sizes">${sizes}</div>
        </fieldset>

        <fieldset class="pet-field">
          <legend>Panel rengi</legend>
          <div class="pet-colors">${colors}</div>
        </fieldset>

        <div class="pet-field">
          <label class="pet-field__label" for="pet-name-input">Kaba yazılacak isim</label>
          <input id="pet-name-input" class="pet-name-input" type="text" maxlength="${MAX_NAME}"
                 placeholder="Örn. Pamuk" autocomplete="off" spellcheck="false">
          <small class="pet-field__hint">En fazla ${MAX_NAME} karakter. Panelin üzerine kabartma olarak basılır.</small>
        </div>

        <div class="pet-config__foot">
          <p class="pet-config__price">
            <strong data-pet-price></strong>
            <span data-pet-price-note></span>
          </p>
          <a class="pet-promo__primary" data-pet-cta href="/tasarim?talep=evcil-hayvan-mama-kabi#parca-talebi">
            İsme özel yaptır <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>`;
  }

  function wire(root) {
    const panel = root.querySelector("[data-pet-panel]");
    const nameNodes = root.querySelectorAll("[data-pet-name], [data-pet-name-shadow], [data-pet-name-light]");
    const mainName = root.querySelector("[data-pet-name]");
    const input = root.querySelector("#pet-name-input");
    const priceNode = root.querySelector("[data-pet-price]");
    const priceNote = root.querySelector("[data-pet-price-note]");
    const caption = root.querySelector("[data-pet-caption]");
    const cta = root.querySelector("[data-pet-cta]");

    const selectedSize = () => SIZES.find((s) => s.id === root.querySelector("input[name='pet-size']:checked").value);
    const selectedColor = () => COLORS.find((c) => c.id === root.querySelector("input[name='pet-color']:checked").value);

    function render() {
      const size = selectedSize();
      const color = selectedColor();
      const typed = input.value.trim();
      const shown = upper(typed || DEFAULT_NAME);

      panel.setAttribute("fill", color.hex);

      const fontSize = nameFontSize(shown);
      nameNodes.forEach((node) => {
        node.textContent = shown;
        node.setAttribute("font-size", fontSize);
      });
      /* İsim henüz yazılmadıysa örnek olduğu belli olsun; yazılınca tam opak. */
      root.querySelector("[data-pet-name-group]").style.opacity = typed ? "1" : ".55";
      // Kabartma, panelin kendi renginin koyusu gibi görünmeli.
      mainName.setAttribute("fill", color.hex);

      priceNode.textContent = money(size.price);
      priceNote.textContent = `${size.label} · ${color.name}`;
      caption.textContent = typed
        ? `Önizleme · ${shown} · ${size.label} · ${color.name}`
        : `Önizleme · isim yazınca burada görünür`;

      const params = new URLSearchParams({
        talep: "evcil-hayvan-mama-kabi",
        boyut: size.id,
        renk: color.name,
        fiyat: String(size.price)
      });
      if (typed) params.set("isim", typed);
      cta.href = `/tasarim?${params.toString()}#parca-talebi`;
    }

    root.addEventListener("change", render);
    input.addEventListener("input", render);
    render();
  }

  mounts.forEach((mount) => {
    mount.classList.add("pet-config");
    mount.innerHTML = markup();
    wire(mount);
  });
})();

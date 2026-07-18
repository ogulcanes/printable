// Contact form → POST /api/contact. Loaded after script.js (shared header/cart).
(function () {
  // Fill the admin-managed contact details. An unset field has no visitor-facing
  // value, so hide its whole card rather than showing the "[… eklenecek]" note.
  fetch("/api/site-info").then((r) => r.json()).then((info) => {
    const linkify = (el, value, href, external) => {
      const a = document.createElement("a");
      a.href = href; a.textContent = value; a.style.color = "var(--accent)";
      if (external) { a.target = "_blank"; a.rel = "noopener"; }
      el.textContent = ""; el.append(a);
    };
    document.querySelectorAll("[data-contact]").forEach((el) => {
      const key = el.dataset.contact;
      const value = (info[key] || "").trim();
      if (!value) {
        const card = el.closest(".contact-item");
        if (card) card.hidden = true;
        return;
      }
      el.classList.remove("placeholder");
      if (key === "phone") linkify(el, value, `tel:${value.replace(/[^0-9+]/g, "")}`);
      else if (key === "whatsapp") linkify(el, "WhatsApp'tan mesaj gönderin", value, true);
      else if (key === "email") linkify(el, value, `mailto:${value}`);
      else if (key === "social_links") {
        // Label by platform — a raw profile URL is long and unreadable in the card.
        const label = (url) => {
          const host = url.replace(/^https?:\/\//i, "").toLowerCase();
          if (host.includes("instagram.com")) return "Instagram";
          if (host.includes("tiktok.com")) return "TikTok";
          if (host.includes("facebook.com")) return "Facebook";
          if (host.includes("youtube.com")) return "YouTube";
          if (host.includes("x.com") || host.includes("twitter.com")) return "X";
          return url;
        };
        el.innerHTML = value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          .map((url) => `<a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);display:block">${label(url)}</a>`).join("");
      } else {
        el.textContent = value;
      }
    });
  }).catch(() => {});

  const form = document.querySelector("#contact-form");
  if (!form) return;
  const status = document.querySelector("#contact-status");
  const button = document.querySelector("#contact-submit");

  const setStatus = (msg, ok) => {
    status.textContent = msg;
    status.hidden = !msg;
    status.classList.toggle("contact-status--ok", !!ok);
    status.classList.toggle("contact-status--err", ok === false);
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.name?.trim() || !data.message?.trim()) {
      setStatus("Lütfen ad soyad ve mesaj alanlarını doldurun.", false);
      return;
    }
    button.disabled = true;
    setStatus("Gönderiliyor…", null);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || "Mesaj gönderilemedi.");
      form.reset();
      setStatus("Mesajınız alındı! En kısa sürede size döneceğiz.", true);
    } catch (err) {
      setStatus(err.message, false);
    } finally {
      button.disabled = false;
    }
  });
})();

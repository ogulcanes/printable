// Contact form → POST /api/contact. Loaded after script.js (shared header/cart).
(function () {
  // Fill the admin-managed contact details; leave the placeholder when a field is empty.
  fetch("/api/site-info").then((r) => r.json()).then((info) => {
    const linkify = (el, value, href) => {
      const a = document.createElement("a");
      a.href = href; a.textContent = value; a.style.color = "var(--accent)";
      el.textContent = ""; el.append(a);
    };
    document.querySelectorAll("[data-contact]").forEach((el) => {
      const key = el.dataset.contact;
      const value = (info[key] || "").trim();
      if (!value) return;
      el.classList.remove("placeholder");
      if (key === "phone") linkify(el, value, `tel:${value.replace(/[^0-9+]/g, "")}`);
      else if (key === "email") linkify(el, value, `mailto:${value}`);
      else if (key === "social_links") {
        el.innerHTML = value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          .map((url) => `<a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);display:block">${url}</a>`).join("");
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

// İletişim bilgileri ilk HTML'e sunucuda eklenir; bu dosya yalnızca formu yönetir.
(function () {
  const form = document.querySelector("#contact-form");
  if (!form) return;
  const status = document.querySelector("#contact-status");
  const button = document.querySelector("#contact-submit");
  const requestedSubject = new URLSearchParams(location.search).get("subject");
  if (requestedSubject && form.elements.subject) form.elements.subject.value = requestedSubject.slice(0, 160);

  const setStatus = (message, ok) => {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("contact-status--ok", Boolean(ok));
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
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Mesaj gönderilemedi.");
      form.reset();
      setStatus("Mesajınız alındı! En kısa sürede size döneceğiz.", true);
      /* Çizim hizmeti reklamının dönüşümü bu. Yalnızca sunucu 2xx döndükten
         sonra — gönderilemeyen bir formu dönüşüm saymak reklam bütçesini
         yanlış yöne kaydırır. */
      olay("generate_lead", { form_id: "contact-form", sayfa: location.pathname });
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      button.disabled = false;
    }
  });
})();

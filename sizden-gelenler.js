(function () {
  const form = document.querySelector("#customer-story-form");
  if (!form) return;

  const fileInput = form.elements.image;
  const fileName = document.querySelector("#customer-story-file-name");
  const status = document.querySelector("#customer-story-status");
  const submit = document.querySelector("#customer-story-submit");
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const maxBytes = 8 * 1024 * 1024;

  function setStatus(message, state) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("is-success", state === "success");
    status.classList.toggle("is-error", state === "error");
  }

  function selectedFile() {
    const file = fileInput.files?.[0];
    if (!file) throw new Error("Lütfen bir müşteri fotoğrafı seçin.");
    if (!allowedTypes.has(file.type)) throw new Error("Yalnızca PNG, JPG, WEBP veya GIF fotoğraf yükleyebilirsiniz.");
    if (file.size > maxBytes) throw new Error("Fotoğraf 8 MB'dan küçük olmalıdır.");
    return file;
  }

  async function uploadDirectly(file, data) {
    const signResponse = await fetch("/api/uploads/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "showcase", filename: file.name })
    });
    // Yerel/klasik sunucuda depolama kapalıysa fotoğraf multipart form ile gider.
    if (signResponse.status === 503) return;

    const signed = await signResponse.json().catch(() => ({}));
    if (!signResponse.ok) throw new Error(signed.error || "Fotoğraf için yükleme adresi alınamadı.");
    const uploadResponse = await fetch(signed.signedUrl, {
      method: "PUT",
      headers: file.type ? { "Content-Type": file.type } : undefined,
      body: file
    });
    if (!uploadResponse.ok) throw new Error("Fotoğraf yüklenemedi. Lütfen tekrar deneyin.");
    data.delete("image");
    data.set("image_key", signed.path);
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileName.textContent = file
      ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`
      : "PNG, JPG, WEBP veya GIF · en fazla 8 MB";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("", null);
    try {
      const file = selectedFile();
      if (!String(form.elements.customer_name.value || "").trim()) {
        throw new Error("Gösterilecek ad alanını doldurun.");
      }
      if (!form.elements.consent_confirmed.checked) {
        throw new Error("Gönderiyi alabilmemiz için yayın izni vermelisiniz.");
      }

      submit.disabled = true;
      submit.textContent = "Fotoğraf yükleniyor…";
      const data = new FormData(form);
      await uploadDirectly(file, data);
      submit.textContent = "Gönderiliyor…";

      const response = await fetch("/api/customer-showcases/submissions", {
        method: "POST",
        body: data
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Fotoğraf gönderilemedi.");

      form.reset();
      fileName.textContent = "PNG, JPG, WEBP veya GIF · en fazla 8 MB";
      setStatus("Teşekkürler! Fotoğrafınız incelemeye alındı. Onaylandıktan sonra vitrinde görünecek.", "success");
      if (typeof olay === "function") olay("generate_lead", { form_id: "customer-story-form", sayfa: location.pathname });
    } catch (error) {
      setStatus(error.message || "Fotoğraf gönderilemedi.", "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "İncelemeye gönder";
    }
  });
})();

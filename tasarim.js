(function () {
  const form = document.querySelector("#design-request-form");
  if (!form) return;

  const fileInput = document.querySelector("#design-image");
  const uploadArea = document.querySelector("#design-upload");
  const preview = document.querySelector("#design-image-preview");
  const fileName = document.querySelector("#design-image-name");
  const status = document.querySelector("#design-request-status");
  const button = document.querySelector("#design-request-submit");
  const maxImageBytes = 8 * 1024 * 1024;
  const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  let previewUrl = "";

  // Kampanya CTA'sından gelen ziyaretçi boş bir formla karşılaşmasın; ürün
  // niyetini forma taşıyarak yalnızca isim ve iletişim bilgisini tamamlasın.
  if (new URLSearchParams(location.search).get("talep") === "evcil-hayvan-mama-kabi") {
    const messageField = form.elements.message;
    if (messageField && !messageField.value.trim()) {
      messageField.value = "Evcil hayvanım için isme özel mama/su kabı standı yaptırmak istiyorum. İsim ve renk tercihlerimi paylaşacağım.";
    }
  }

  const setStatus = (message, ok) => {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("contact-status--ok", Boolean(ok));
    status.classList.toggle("contact-status--err", ok === false);
  };

  const clearPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    preview.removeAttribute("src");
    preview.hidden = true;
    fileName.textContent = "";
  };

  const showFile = (file) => {
    clearPreview();
    if (!file) return true;
    if (!allowedImageTypes.has(file.type)) {
      fileInput.value = "";
      setStatus("Lütfen PNG, JPG, WEBP veya GIF biçiminde bir görsel seçin.", false);
      return false;
    }
    if (file.size > maxImageBytes) {
      fileInput.value = "";
      setStatus("Görsel en fazla 8 MB olabilir.", false);
      return false;
    }
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    preview.hidden = false;
    fileName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    setStatus("", null);
    return true;
  };

  fileInput.addEventListener("change", () => showFile(fileInput.files?.[0]));

  ["dragenter", "dragover"].forEach((type) => uploadArea.addEventListener(type, (event) => {
    event.preventDefault();
    uploadArea.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => uploadArea.addEventListener(type, (event) => {
    event.preventDefault();
    uploadArea.classList.remove("is-dragging");
  }));
  uploadArea.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    showFile(file);
  });

  async function uploadToStorage(file, data) {
    if (!file) return;
    const signResponse = await fetch("/api/uploads/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "design", filename: file.name })
    });

    if (signResponse.status === 503) return;
    const signed = await signResponse.json().catch(() => ({}));
    if (!signResponse.ok) throw new Error(signed.error || "Görsel için yükleme adresi alınamadı.");

    const uploadResponse = await fetch(signed.signedUrl, {
      method: "PUT",
      headers: file.type ? { "Content-Type": file.type } : undefined,
      body: file
    });
    if (!uploadResponse.ok) throw new Error("Görsel yüklenemedi. Lütfen tekrar deneyin.");
    data.delete("image");
    data.set("image_path", signed.path);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const image = data.get("image");
    const selectedImage = image instanceof File && image.size ? image : null;
    const name = String(data.get("name") || "").trim();
    const message = String(data.get("message") || "").trim();
    const phone = String(data.get("phone") || "").trim();
    const email = String(data.get("email") || "").trim();
    // Seçilmemiş dosya alanı bazı tarayıcılarda boş bir File parçası üretir.
    // Canlıdaki metin-alanı ayrıştırıcısı bunu gerçek dosya sanıp reddetmesin.
    if (!selectedImage) data.delete("image");

    if (!name || !message) {
      setStatus("Lütfen parçanızı anlatın ve ad soyad alanını doldurun.", false);
      return;
    }
    if (!phone && !email) {
      setStatus("Size ulaşabilmemiz için telefon veya e-posta bilgilerinden birini yazın.", false);
      return;
    }
    if (selectedImage && !showFile(selectedImage)) return;

    button.disabled = true;
    setStatus(selectedImage ? "Görsel ve talebiniz gönderiliyor…" : "Talebiniz gönderiliyor…", null);
    try {
      await uploadToStorage(selectedImage, data);
      const response = await fetch("/api/design-requests", { method: "POST", body: data });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Talebiniz gönderilemedi.");
      form.reset();
      clearPreview();
      setStatus("Talebiniz alındı! Parçanızı inceleyip en kısa sürede size ulaşacağız.", true);
      if (typeof olay === "function") olay("generate_lead", { form_id: "design-request-form", sayfa: location.pathname });
    } catch (error) {
      setStatus(error.message || "Talebiniz gönderilemedi. Lütfen tekrar deneyin.", false);
    } finally {
      button.disabled = false;
    }
  });
})();

const money = (value) => `${Number(value || 0).toFixed(2)} TL`;
const cart = [];
const storeProducts = document.querySelector("#store-products");
const cartPanel = document.querySelector("#cart-panel");
const cartCount = document.querySelector("#cart-count");
const cartItems = document.querySelector("#cart-items");
const searchToggle = document.querySelector(".search-toggle");
const searchPopover = document.querySelector(".search-popover");

function renderProducts(products) {
  if (!storeProducts || !products.length) return;
  storeProducts.innerHTML = products.filter((product) => product.is_active).map((product) => `
    <article class="product-card">
      <img src="${product.image_path || "/assets/printable-logo.svg"}" alt="${product.name}">
      <h3>${product.name}</h3>
      <p>${money(product.sale_price || product.price)}${product.sale_price ? ` <s>${money(product.price)}</s>` : ""}</p>
      <div class="swatches"><span></span><span></span><span></span></div>
      <button data-add-product="${product.id}">Sepete ekle</button>
    </article>
  `).join("");
  observeCards();
}

function renderCart() {
  cartCount.textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
  cartItems.innerHTML = cart.map((item) => `
    <article class="cart-item">
      <div>
        <h3>${item.name}</h3>
        <p>${item.quantity} x ${money(item.price)}</p>
      </div>
      <button type="button" data-remove-product="${item.id}">Kaldır</button>
    </article>
  `).join("") || "<p>Sepetiniz boş.</p>";
}

async function loadProducts() {
  try {
    const products = await fetch("/api/products").then((response) => response.json());
    window.printableProducts = products;
    renderProducts(products);
  } catch {
    window.printableProducts = [];
  }
}

document.addEventListener("click", (event) => {
  const addId = event.target.dataset.addProduct;
  const removeId = event.target.dataset.removeProduct;
  if (addId) {
    const product = window.printableProducts.find((item) => item.id === Number(addId));
    const existing = cart.find((item) => item.id === product.id);
    if (existing) existing.quantity += 1;
    else cart.push({ id: product.id, name: product.name, price: product.sale_price || product.price, quantity: 1 });
    cartPanel.classList.add("open");
    renderCart();
  }
  if (removeId) {
    const index = cart.findIndex((item) => item.id === Number(removeId));
    if (index >= 0) cart.splice(index, 1);
    renderCart();
  }
});

document.querySelector(".cart")?.addEventListener("click", (event) => {
  event.preventDefault();
  cartPanel.classList.add("open");
});

document.querySelector("#close-cart")?.addEventListener("click", () => cartPanel.classList.remove("open"));

document.querySelector("#checkout-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cart.length) return alert("Sepetiniz boş.");
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const customer = await fetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: data.name,
        email: data.email,
        phone: data.phone,
        address: data.address
      })
    }).then((response) => response.json());
    const order = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: customer.id,
        shipping_address: data.address,
        items: cart.map((item) => ({ product_id: item.id, quantity: item.quantity }))
      })
    }).then((response) => response.json());
    cart.length = 0;
    renderCart();
    form.reset();
    alert(`Sipariş oluşturuldu: ${order.order_number}`);
  } catch {
    alert("Sipariş oluşturulamadı.");
  }
});

const searchForm = document.querySelector(".search");

searchForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = searchForm.querySelector("input");
  if (input?.value.trim()) {
    input.value = "";
    input.placeholder = "Arama sonraki sürümde aktif olacak";
  }
});

searchToggle?.addEventListener("click", () => {
  const isOpen = searchPopover.classList.toggle("open");
  searchToggle.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) searchPopover.querySelector("input")?.focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    searchPopover?.classList.remove("open");
    searchToggle?.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("click", (event) => {
  if (!searchPopover || !searchToggle) return;
  if (searchPopover.contains(event.target) || searchToggle.contains(event.target)) return;
  searchPopover.classList.remove("open");
  searchToggle.setAttribute("aria-expanded", "false");
});

document.querySelectorAll("[data-carousel]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!storeProducts) return;
    const direction = button.dataset.carousel === "next" ? 1 : -1;
    storeProducts.scrollBy({
      left: direction * Math.min(620, storeProducts.clientWidth * .82),
      behavior: "smooth"
    });
  });
});

function observeCards() {
  const cards = document.querySelectorAll(".product-card");
  if (!("IntersectionObserver" in window)) {
    cards.forEach((card) => card.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: .18 });
  cards.forEach((card) => observer.observe(card));
}

loadProducts();
renderCart();
observeCards();

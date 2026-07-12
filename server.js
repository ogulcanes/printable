const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DB_PATH = path.join(DATA_DIR, "printable.sqlite");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "printable-admin";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-printable-session-secret";
const SESSION_COOKIE = "printable_admin";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT,
    category TEXT,
    description TEXT,
    color TEXT,
    price REAL NOT NULL DEFAULT 0,
    sale_price REAL,
    width REAL,
    height REAL,
    depth REAL,
    weight REAL,
    stock INTEGER NOT NULL DEFAULT 0,
    image_path TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address TEXT,
    city TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    customer_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    shipping_address TEXT,
    tracking_code TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
  );
`);

const existingProducts = db.prepare("SELECT COUNT(*) count FROM products").get().count;
if (!existingProducts) {
  const seedProduct = db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path)
  `);
  [
    {
      name: "Custom Sticker Pack",
      sku: "PR-STK-001",
      category: "Stickers",
      description: "Marka ambalajları için mat laminasyonlu özel sticker paketi.",
      color: "Tam renk",
      price: 24.9,
      sale_price: 19.9,
      width: 10,
      height: 10,
      depth: 0.1,
      weight: 0.2,
      stock: 120,
      image_path: "https://new-ella-demo-07.myshopify.com/cdn/shop/files/product-1.jpg?v=1750319850&width=500"
    },
    {
      name: "A4 Poster Print",
      sku: "PR-POS-A4",
      category: "Posters",
      description: "Premium saten kağıda yüksek çözünürlüklü A4 poster baskı.",
      color: "CMYK",
      price: 39,
      sale_price: 29,
      width: 21,
      height: 29.7,
      depth: 0.1,
      weight: 0.08,
      stock: 80,
      image_path: "https://new-ella-demo-07.myshopify.com/cdn/shop/files/product-laptop-1_8ba38545-e982-4cc5-a601-9f7adb782d6f.jpg?v=1750319712&width=500"
    },
    {
      name: "Business Card Set",
      sku: "PR-BC-250",
      category: "Cards",
      description: "Soft touch yüzeyli 250 adet çift taraflı kartvizit.",
      color: "Beyaz",
      price: 59,
      sale_price: 49,
      width: 8.5,
      height: 5.5,
      depth: 0.03,
      weight: 0.4,
      stock: 65,
      image_path: "https://new-ella-demo-07.myshopify.com/cdn/shop/files/product-app-4_23546feb-c1d6-4645-819e-10afcda659f6.jpg?v=1750319766&width=500"
    }
  ].forEach((product) => seedProduct.run(product));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      cb(null, `${Date.now()}-${safe}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype));
  },
  limits: { fileSize: 8 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/assets", express.static(path.join(ROOT, "assets")));
app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.get("/stl-teklif", (req, res) => res.sendFile(path.join(ROOT, "stl-teklif.html")));
["styles.css", "script.js", "stl-viewer.js", "admin.css", "admin.js"].forEach((file) => {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(ROOT, file)));
});

function signSession(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((cookie) => {
    const index = cookie.indexOf("=");
    return [cookie.slice(0, index).trim(), decodeURIComponent(cookie.slice(index + 1))];
  }));
}

function isAuthed(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return false;
  const [user, expires, signature] = raw.split(".");
  if (!user || !expires || !signature || Number(expires) < Date.now()) return false;
  const expected = signSession(`${user}.${expires}`);
  try {
    return user === ADMIN_USER && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Admin login required." });
  return res.redirect("/login");
}

function setSessionCookie(res) {
  const expires = Date.now() + 1000 * 60 * 60 * 12;
  const value = `${ADMIN_USER}.${expires}`;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(`${value}.${signSession(value)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
}

app.get("/login", (req, res) => {
  if (isAuthed(req)) return res.redirect("/admin");
  return res.sendFile(path.join(ROOT, "login.html"));
});

app.post("/api/login", (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASSWORD) {
    setSessionCookie(res);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı." });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authed: isAuthed(req), user: isAuthed(req) ? ADMIN_USER : null });
});

const money = (value) => Number(value || 0);
const nullableMoney = (value) => value === "" || value == null ? null : Number(value);
const toInt = (value) => Number.parseInt(value || "0", 10);

function productPayload(body, file) {
  return {
    name: body.name?.trim(),
    sku: body.sku?.trim() || null,
    category: body.category?.trim() || null,
    description: body.description?.trim() || null,
    color: body.color?.trim() || null,
    price: money(body.price),
    sale_price: nullableMoney(body.sale_price),
    width: nullableMoney(body.width),
    height: nullableMoney(body.height),
    depth: nullableMoney(body.depth),
    weight: nullableMoney(body.weight),
    stock: toInt(body.stock),
    image_path: file ? `/uploads/${file.filename}` : body.current_image || null,
    is_active: body.is_active === "0" ? 0 : 1
  };
}

app.get("/api/stats", requireAdmin, (req, res) => {
  const stats = {
    products: db.prepare("SELECT COUNT(*) count FROM products").get().count,
    customers: db.prepare("SELECT COUNT(*) count FROM customers").get().count,
    orders: db.prepare("SELECT COUNT(*) count FROM orders").get().count,
    revenue: db.prepare("SELECT COALESCE(SUM(total), 0) total FROM orders").get().total
  };
  res.json(stats);
});

app.get("/api/products", (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all();
  res.json(products);
});

app.post("/api/products", requireAdmin, upload.single("image"), (req, res) => {
  const product = productPayload(req.body, req.file);
  if (!product.name) return res.status(400).json({ error: "Ürün adı zorunludur." });

  const result = db.prepare(`
    INSERT INTO products (name, sku, category, description, color, price, sale_price, width, height, depth, weight, stock, image_path, is_active)
    VALUES (@name, @sku, @category, @description, @color, @price, @sale_price, @width, @height, @depth, @weight, @stock, @image_path, @is_active)
  `).run(product);

  res.status(201).json(db.prepare("SELECT * FROM products WHERE id = ?").get(result.lastInsertRowid));
});

app.put("/api/products/:id", requireAdmin, upload.single("image"), (req, res) => {
  const current = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Ürün bulunamadı." });
  const product = productPayload({ ...req.body, current_image: current.image_path }, req.file);
  product.id = current.id;

  db.prepare(`
    UPDATE products SET
      name=@name, sku=@sku, category=@category, description=@description, color=@color,
      price=@price, sale_price=@sale_price, width=@width, height=@height, depth=@depth,
      weight=@weight, stock=@stock, image_path=@image_path, is_active=@is_active,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run(product);

  res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(current.id));
});

app.delete("/api/products/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/customers", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM customers ORDER BY created_at DESC").all());
});

app.post("/api/customers", (req, res) => {
  if (!req.body.name?.trim()) return res.status(400).json({ error: "Müşteri adı zorunludur." });
  const result = db.prepare(`
    INSERT INTO customers (name, email, phone, address, city, notes)
    VALUES (@name, @email, @phone, @address, @city, @notes)
  `).run({
    name: req.body.name.trim(),
    email: req.body.email?.trim() || null,
    phone: req.body.phone?.trim() || null,
    address: req.body.address?.trim() || null,
    city: req.body.city?.trim() || null,
    notes: req.body.notes?.trim() || null
  });
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(result.lastInsertRowid));
});

app.get("/api/orders", requireAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT orders.*, customers.name customer_name, customers.email customer_email
    FROM orders
    JOIN customers ON customers.id = orders.customer_id
    ORDER BY orders.created_at DESC
  `).all();

  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?");
  res.json(orders.map((order) => ({ ...order, items: items.all(order.id) })));
});

app.post("/api/orders", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!req.body.customer_id) return res.status(400).json({ error: "Müşteri seçimi zorunludur." });
  if (!items.length) return res.status(400).json({ error: "En az bir sipariş ürünü gereklidir." });

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, customer_id, status, payment_status, shipping_address, tracking_code, subtotal, discount, total, notes)
    VALUES (@order_number, @customer_id, @status, @payment_status, @shipping_address, @tracking_code, @subtotal, @discount, @total, @notes)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
    VALUES (@order_id, @product_id, @product_name, @quantity, @unit_price, @line_total)
  `);

  const create = db.transaction(() => {
    const normalized = items.map((item) => {
      const product = item.product_id ? db.prepare("SELECT * FROM products WHERE id = ?").get(item.product_id) : null;
      const quantity = Math.max(1, toInt(item.quantity));
      const unitPrice = money(item.unit_price || product?.sale_price || product?.price);
      return {
        product_id: product?.id || null,
        product_name: product?.name || item.product_name || "Özel ürün",
        quantity,
        unit_price: unitPrice,
        line_total: quantity * unitPrice
      };
    });
    const subtotal = normalized.reduce((sum, item) => sum + item.line_total, 0);
    const discount = money(req.body.discount);
    const total = Math.max(0, subtotal - discount);
    const orderNumber = `PRN-${Date.now().toString().slice(-8)}`;
    const result = insertOrder.run({
      order_number: orderNumber,
      customer_id: toInt(req.body.customer_id),
      status: req.body.status || "new",
      payment_status: req.body.payment_status || "pending",
      shipping_address: req.body.shipping_address || null,
      tracking_code: req.body.tracking_code || null,
      subtotal,
      discount,
      total,
      notes: req.body.notes || null
    });

    normalized.forEach((item) => insertItem.run({ ...item, order_id: result.lastInsertRowid }));
    return result.lastInsertRowid;
  });

  const id = create();
  res.status(201).json(db.prepare("SELECT * FROM orders WHERE id = ?").get(id));
});

app.patch("/api/orders/:id", requireAdmin, (req, res) => {
  const current = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!current) return res.status(404).json({ error: "Sipariş bulunamadı." });
  db.prepare(`
    UPDATE orders SET status=@status, payment_status=@payment_status, tracking_code=@tracking_code, notes=@notes, updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({
    id: current.id,
    status: req.body.status || current.status,
    payment_status: req.body.payment_status || current.payment_status,
    tracking_code: req.body.tracking_code ?? current.tracking_code,
    notes: req.body.notes ?? current.notes
  });
  res.json(db.prepare("SELECT * FROM orders WHERE id = ?").get(current.id));
});

app.get("/admin", requireAdmin, (req, res) => res.sendFile(path.join(ROOT, "admin.html")));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Printable running at http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Local admin login: ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
  });
}

module.exports = app;

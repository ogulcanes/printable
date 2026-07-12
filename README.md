# Printable Mağaza

Printable için ürün, müşteri ve sipariş yönetimi olan mağaza ve admin paneli.

## Yerel Geliştirme

```bash
npm install
npm start
```

Açılacak adresler:

- Mağaza: `http://localhost:3000/`
- Admin panel: `http://localhost:3000/admin`

Varsayılan yerel giriş:

- Kullanıcı adı: `admin`
- Şifre: `printable-admin`

Bu bilgileri `ADMIN_USER`, `ADMIN_PASSWORD` ve `SESSION_SECRET` ortam değişkenleriyle değiştirin.

## Vercel Notları

Projede `api/index.js` ve `vercel.json` var; bu sayede Express uygulaması Vercel Function olarak çalışabilir.

Canlı ortamda kalıcı veri için yerel SQLite dosyasına veya yerel `uploads/` klasörüne güvenmeyin. Vercel tarafında ürün, müşteri ve sipariş verisi için Neon Postgres veya Supabase Postgres; ürün fotoğrafları için Vercel Blob, Supabase Storage veya Cloudinary kullanılması önerilir.

Önerilen canlı kurulum:

- Veritabanı: Neon Postgres veya Supabase Postgres.
- Dosya yükleme: Vercel Blob, Supabase Storage veya Cloudinary.
- Ortam değişkenleri: Vercel panelinde `ADMIN_USER`, `ADMIN_PASSWORD` ve uzun rastgele bir `SESSION_SECRET` tanımlayın.

Mevcut SQLite yapı yerel geliştirme ve demo için uygundur. Gerçek sipariş almadan önce veri katmanını barındırılan veritabanına ve dosya depolamaya taşıyın.

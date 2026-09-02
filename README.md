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

## Vercel

Projede `api/index.js` ve `vercel.json` var; bu sayede Express uygulaması Vercel Function olarak çalışabilir.

Canlı ortamda kalıcı veri için yerel SQLite dosyasına veya yerel `uploads/` klasörüne güvenmeyin. Vercel tarafında ürün, müşteri ve sipariş verisi için Neon Postgres veya Supabase Postgres; ürün fotoğrafları için Vercel Blob, Supabase Storage veya Cloudinary kullanılması önerilir.

Önerilen canlı kurulum:

- Veritabanı: Neon Postgres veya Supabase Postgres.
- Dosya yükleme: Vercel Blob, Supabase Storage veya Cloudinary.
- Ortam değişkenleri: Vercel panelinde `ADMIN_USER`, `ADMIN_PASSWORD` ve uzun rastgele bir `SESSION_SECRET` tanımlayın.

## Alastyr Node.js + MySQL/MariaDB

Uygulama `MYSQL_URL` tanımlandığında MySQL/MariaDB kullanır. Supabase ortam
değişkenleri boş bırakıldığında görseller `PUBLIC_UPLOAD_DIR`, müşteri STL/3MF
ve referans dosyaları ise internete açık olmayan `PRIVATE_UPLOAD_DIR` altında
kalıcı diske yazılır.

Örnek üretim ayarları:

```bash
NODE_ENV=production
MYSQL_URL=mysql://kullanici:parola@localhost:3306/printable
PUBLIC_UPLOAD_DIR=/home/kullanici/printable/uploads
PRIVATE_UPLOAD_DIR=/home/kullanici/printable/private_uploads
```

cPanel ortam değişkenlerinde parolayı URL içine gömmek istemiyorsanız
`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` ve `MYSQL_DATABASE`
alanlarını ayrı ayrı tanımlayabilirsiniz. `MYSQL_URL` doluysa öncelik ondadır.

`ADMIN_PASSWORD` ve `SESSION_SECRET` ayrıca zorunludur. Supabase'ten geçiş
tamamlandıktan sonra `DATABASE_URL`, `SUPABASE_URL` ve
`SUPABASE_SERVICE_ROLE_KEY` canlı uygulamada kaldırılır.

### Supabase'ten aktarım

Önce Alastyr'da boş veritabanını oluşturup uygulamayı bir kez başlatın; bu,
MySQL şemasını kurar. Sonra bakım penceresinde eski Vercel uygulamasını yazmaya
kapatıp aşağıdaki işlemleri sırasıyla çalıştırın:

```bash
# Kaynak Supabase Postgres bağlantısı ile hedef MySQL'i yalnızca kontrol eder.
SOURCE_DATABASE_URL='postgresql://...' MYSQL_URL='mysql://...' npm run migrate:db:check

# Hedef MySQL tablolarını kaynak verinin birebir kopyasıyla değiştirir ve
# tüm tablo satır sayılarını doğrular.
SOURCE_DATABASE_URL='postgresql://...' MYSQL_URL='mysql://...' npm run migrate:db

# Storage envanterini kontrol eder; servis anahtarı yalnızca bu aktarımda kullanılır.
SUPABASE_URL='https://....supabase.co' SUPABASE_SERVICE_ROLE_KEY='...' \
MYSQL_URL='mysql://...' npm run migrate:storage:check

# images dosyalarını açık dizine, models dosyalarını özel dizine indirir ve
# MySQL'deki eski Supabase yollarını yerel yollara çevirir.
SUPABASE_URL='https://....supabase.co' SUPABASE_SERVICE_ROLE_KEY='...' \
MYSQL_URL='mysql://...' npm run migrate:storage
```

Gerçek bağlantı adreslerini veya servis anahtarlarını GitHub'a eklemeyin.
Aktarımdan sonra ürün, sipariş, teklif ve dosya indirme kontrolleri yapılmadan
DNS'i Alastyr'a çevirmeyin; eski Supabase projesini de doğrulama bitmeden silmeyin.

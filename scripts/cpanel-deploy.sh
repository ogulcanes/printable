#!/bin/bash
# Alastyr (cPanel) yayın betiği — .cpanel.yml bunu çağırır.
#
# cPanel > Git Version Control depoyu KENDİ klasörüne klonlar; o klasör çalışan
# uygulama değildir. Buradaki iş, klondaki dosyaları Node uygulamasının klasörüne
# kopyalamaktır.
#
# Hedef klasör = cPanel > Setup Node.js App > "Application root".
# Betik onu kendisi bulmaya çalışır; bulamazsa ya da birden fazla aday çıkarsa
# HİÇBİR ŞEY KOPYALAMADAN durur. Sabitlemek için deponun kökündeki .cpanel.yml
# içinde PRINTABLE_APP_DIR değerini ver.
#
# Kopyalanmayanlar: .env, data/, uploads/, node_modules/ — bunlar sunucunun malı,
# depoda yer almaz ve üzerine yazılmamalı. Betik hedefte hiçbir dosyayı silmez.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

die() { echo "HATA: $*" >&2; exit 1; }

# ---------------------------------------------------------------- hedef klasör
APP_DIR="${PRINTABLE_APP_DIR:-}"

if [ -n "$APP_DIR" ]; then
  echo "Hedef (elle verildi): $APP_DIR"
else
  echo "Hedef klasör aranıyor: $HOME altında server.js + package.json taşıyan klasör..."
  candidates="$(
    find "$HOME" -maxdepth 3 -type f -name server.js \
         -not -path "$REPO_DIR/*" -not -path "*/node_modules/*" 2>/dev/null |
    while IFS= read -r hit; do
      dir="$(dirname "$hit")"
      [ -f "$dir/package.json" ] && echo "$dir"
    done | sort -u
  )"

  count="$(printf '%s' "$candidates" | grep -c . || true)"

  if [ "$count" -eq 1 ]; then
    APP_DIR="$candidates"
    echo "Hedef bulundu: $APP_DIR"
  elif [ "$count" -eq 0 ]; then
    die "Uygulama klasörü bulunamadı. .cpanel.yml içinde PRINTABLE_APP_DIR değerini
     cPanel > Setup Node.js App > 'Application root' yoluna ayarla."
  else
    echo "Birden fazla aday bulundu:" >&2
    printf '  %s\n' $candidates >&2
    die "Hangisi olduğu belirsiz. .cpanel.yml içinde PRINTABLE_APP_DIR ile sabitle."
  fi
fi

# --------------------------------------------------------------- güvenlik ağı
# Yanlış yere kopyalamak, ev dizinini repo dosyalarıyla doldurmak demek.
[ -d "$APP_DIR" ]            || die "Klasör yok: $APP_DIR"
[ "$APP_DIR" != "$HOME" ]    || die "Hedef ev dizini olamaz: $APP_DIR"
[ "$APP_DIR" != "$REPO_DIR" ] || die "Hedef deponun kendisi olamaz: $APP_DIR"
[ -f "$APP_DIR/server.js" ]  || die "Burası uygulama klasörü değil (server.js yok): $APP_DIR"

# package.json değişirse bağımlılık kurulumu gerekir; sonunda uyaralım diye ölçüyoruz.
pkg_before="$(md5sum "$APP_DIR/package.json" 2>/dev/null | cut -d' ' -f1 || true)"

# -------------------------------------------------------------------- kopyala
# git ls-files = yalnızca depoda İZLENEN dosyalar. .env, data/, uploads/ ve
# node_modules/ zaten .gitignore'da olduğu için listeye hiç girmez.
#
# Liste önce geçici bir dosyaya yazılıyor; `done < <(git ls-files -z)` yazmak
# daha kısa olurdu ama cPanel'in jailed shell'inde /dev/fd yok ve process
# substitution "No such file or directory" ile ölüyor. Boruya sokmak da olmaz:
# döngü alt kabukta çalışır, sayaç geri dönmez.
file_list="$(mktemp)"
changed_list="$(mktemp)"
trap 'rm -f "$file_list" "$changed_list"' EXIT
git ls-files -z > "$file_list"

# ---------------------------------------------------------------------- yedek
# Hedefteki bir dosya depodakinden farklıysa, o fark depoya girmemiş bir
# değişikliktir. Üzerine yazmak onu geri dönülmez biçimde siler: 4 Eylül 2026'da
# tam olarak bu oldu, canlıdaki MySQL uyarlaması main'in Postgres sürümüyle
# ezildi ve site düştü. Artık önce yedek alınıyor, sonra kopyalanıyor.
while IFS= read -r -d '' file; do
  if [ -f "$APP_DIR/$file" ] && ! cmp -s "$file" "$APP_DIR/$file"; then
    printf '%s\n' "$file"
  fi
done < "$file_list" > "$changed_list"

if [ -s "$changed_list" ]; then
  backup_dir="$HOME/deploy-backups"
  mkdir -p "$backup_dir"
  backup="$backup_dir/printable-app-$(date +%Y%m%d-%H%M%S).tar.gz"
  tar -czf "$backup" -C "$APP_DIR" -T "$changed_list"
  echo "$(wc -l < "$changed_list") dosyanın eski hali yedeklendi: $backup"
  echo "Geri almak için: tar -xzf $backup -C $APP_DIR"
fi

copied=0
while IFS= read -r -d '' file; do
  target_dir="$APP_DIR/$(dirname "$file")"
  [ -d "$target_dir" ] || mkdir -p "$target_dir"
  cp -p "$file" "$APP_DIR/$file"
  copied=$((copied + 1))
done < "$file_list"

echo "$copied dosya kopyalandı -> $APP_DIR"

# ------------------------------------------------------------------- yeniden başlat
# HTML her istekte diskten okunuyor, CSS/JS statik — yani sadece ön yüz değiştiyse
# restart şart değil. Ama server.js değiştiyse şart, ve hangisi olduğunu burada
# ayırt etmek yerine her deploy'da yeniden başlatmak ucuz ve öngörülebilir.
# Passenger, tmp/restart.txt dosyasına dokunulunca uygulamayı yeniden başlatır.
mkdir -p "$APP_DIR/tmp"
touch "$APP_DIR/tmp/restart.txt"
echo "Uygulama yeniden başlatılmak üzere işaretlendi (tmp/restart.txt)."

pkg_after="$(md5sum "$APP_DIR/package.json" 2>/dev/null | cut -d' ' -f1 || true)"
if [ -n "$pkg_before" ] && [ "$pkg_before" != "$pkg_after" ]; then
  echo
  echo "DİKKAT: package.json değişti. Bağımlılıklar bu betikle KURULMAZ."
  echo "cPanel > Setup Node.js App > uygulamayı seç > 'Run NPM Install' çalıştır."
fi

echo "Yayın tamam."

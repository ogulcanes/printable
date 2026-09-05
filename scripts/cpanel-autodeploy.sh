#!/bin/bash
# Sunucunun kendi kendine yayınlaması — cPanel'de butona basmaya son.
#
# NEDEN BU VAR
# cPanel'in Git Version Control'ü depoyu klonlar ama kendiliğinden güncellemez:
# birinin "Update from Remote" + "Deploy HEAD Commit" düğmelerine basması
# gerekir. GitHub Actions'tan tetiklemek en temizi, ama o cPanel API token'ı
# ister ve Alastyr her hesapta token üretimine izin vermiyor. Bu betik aynı işi
# ters yönden yapar: dışarıdan sunucuya bağlanmak yerine sunucu belirli
# aralıklarla GitHub'a bakar. Depo herkese açık olduğu için hiçbir şifre,
# anahtar ya da token gerekmez.
#
# KURULUM (cPanel > Terminal içinde bir kez):
#   cd ~/repositories/printable && git pull && bash scripts/cpanel-autodeploy.sh --install
#
# Önce bir yayın yapar; yalnızca o yayın sorunsuz biterse crontab'a beş
# dakikada bir çalışan satırı ekler. Bozuk bir kurulumu zamanlayıcıya yazıp
# arkasını dönmek, beş dakikada bir sessizce başarısız olan bir iş demek olurdu.
#
# KALDIRMAK İÇİN:  crontab -e  ile PRINTABLE_AUTODEPLOY satırını sil.
#
# Kayıtlar: ~/printable-autodeploy.log

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${PRINTABLE_BRANCH:-mysql-migration}"
LOG_FILE="$HOME/printable-autodeploy.log"
CRON_ETIKET="PRINTABLE_AUTODEPLOY"

# .cpanel.yml ile aynı hedef; cpanel-deploy.sh klasörü aramak zorunda kalmasın.
export PRINTABLE_APP_DIR="${PRINTABLE_APP_DIR:-$HOME/printable-app}"

KURULUM="hayir"
if [ "${1:-}" = "--install" ]; then
  KURULUM="evet"
elif [ -n "${1:-}" ]; then
  echo "Bilinmeyen seçenek: $1 (yalnızca --install var)" >&2
  exit 2
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ------------------------------------------------------------- güncelleme var mı
cd "$REPO_DIR"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  log "HATA: burası bir git deposu değil: $REPO_DIR"
  exit 1
fi

git fetch --quiet origin "$BRANCH"

# cPanel klonu başka bir dalda duruyor olabilir (kurulumda hangisi seçildiyse).
# Yanlış dalda "ileri sarma yapılamadı" hatası vermek yerine doğru dala geç:
# yayınlanacak dal tek ve bellidir, klonun ondan sapması bir şeyi korumaz.
mevcut_dal="$(git rev-parse --abbrev-ref HEAD)"
if [ "$mevcut_dal" != "$BRANCH" ]; then
  log "Sunucudaki kopya '$mevcut_dal' dalındaydı, '$BRANCH' dalına geçiliyor."
  git checkout -B "$BRANCH" "origin/$BRANCH"
fi

onceki="$(git rev-parse HEAD)"
gelen="$(git rev-parse "origin/$BRANCH")"

if [ "$onceki" = "$gelen" ]; then
  if [ "$KURULUM" = "hayir" ]; then
    # Sessiz çık: cron beş dakikada bir çalışıyor, her seferinde satır yazarsa
    # kayıt dosyası hiçbir işe yaramayan binlerce satıra boğulur.
    exit 0
  fi
  log "Sunucu zaten güncel: ${onceki:0:7}"
else
  log "Yeni commit(ler) bulundu: ${onceki:0:7} -> ${gelen:0:7}"
  git log --oneline "$onceki..$gelen" | sed 's/^/    /'

  # --ff-only: sunucudaki kopya sadece takip eder, asla kendi başına birleştirme
  # yapmaz. Sunucuda elle bir değişiklik yapıldıysa burada durur ve haber verir;
  # sessizce üstüne yazıp o değişikliği kaybetmez.
  if ! git merge --ff-only "origin/$BRANCH"; then
    log "HATA: ileri sarma yapılamadı. Sunucudaki kopyada yerel değişiklik olabilir."
    log "      Elle bak:  cd $REPO_DIR && git status"
    exit 1
  fi

  log "Dosyalar uygulamaya kopyalanıyor..."
  bash "$REPO_DIR/scripts/cpanel-deploy.sh"
  log "Yayın tamam: $(git rev-parse --short HEAD)"
fi

# --------------------------------------------------------------------- kurulum
# Buraya ulaşıldıysa çekme ve kopyalama sorunsuz çalıştı; artık zamanlayıcıya
# yazmak güvenli.
if [ "$KURULUM" = "evet" ]; then
  satir="*/5 * * * * /bin/bash $REPO_DIR/scripts/cpanel-autodeploy.sh >> $LOG_FILE 2>&1 # $CRON_ETIKET"

  # Var olan satırı silip yeniden yazıyoruz: betik başka bir klasöre taşınırsa
  # eski satır yanlış yolu göstermeye devam eder ve sessizce hiçbir şey yapmaz.
  mevcut="$(crontab -l 2>/dev/null | grep -v "$CRON_ETIKET" || true)"
  printf '%s\n%s\n' "$mevcut" "$satir" | grep -v '^[[:space:]]*$' | crontab -

  echo
  log "Otomatik yayın kuruldu — beş dakikada bir çalışacak."
  log "  $satir"
  log "Kayıtlar: $LOG_FILE"
  log "Kaldırmak için: crontab -e  → $CRON_ETIKET satırını sil"
fi

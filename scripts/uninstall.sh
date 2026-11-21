#!/usr/bin/env bash
set -euo pipefail

SYSTEMD_UNIT="${MADAR_SYSTEMD_UNIT:-/etc/systemd/system/madar.service}"
REMOVE_DATA=0
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DEFAULT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

help() {
  cat <<'EOF'
استخدام: uninstall.sh [الخيارات]

الخيارات:
  --dir PATH      مسار تثبيت Madar (الافتراضي: $MADAR_DIR أو مجلد نسخة Madar الحالية)
  --remove-data   حذف volumes البيانات بعد تأكيد تفاعلي (تدميري)
  --help          عرض هذه المساعدة
EOF
}

die() { printf 'خطأ: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
warn() { printf 'تنبيه: %s\n' "$*" >&2; }

valid_path_text() {
  [[ -n "$1" && "$1" != *[$'\x01'-$'\x1f']* && "$1" != *$'\x7f'* ]]
}

looks_like_repo() {
  [[ -f "$1/docker-compose.yml" && -f "$1/scripts/install.sh" ]]
}

require_repo_layout() {
  looks_like_repo "$1" || die "المسار $1 ليس نسخة Madar صالحة؛ يلزم وجود docker-compose.yml و scripts/install.sh."
}

DIR=''
if [[ -n "${MADAR_DIR:-}" ]]; then
  valid_path_text "$MADAR_DIR" || die "قيمة MADAR_DIR فارغة أو تحتوي أحرف تحكم."
  DIR="$MADAR_DIR"
elif looks_like_repo "$REPO_DEFAULT"; then
  DIR="$REPO_DEFAULT"
elif looks_like_repo "$PWD"; then
  DIR="$PWD"
fi

while (($#)); do
  case "$1" in
    --dir)
      (($# >= 2)) || die "الخيار --dir يحتاج إلى مسار."
      valid_path_text "$2" || die "المسار الممرر إلى --dir فارغ أو يحتوي أحرف تحكم."
      DIR="$2"
      shift 2
      ;;
    --dir=*)
      DIR="${1#*=}"
      valid_path_text "$DIR" || die "المسار الممرر إلى --dir فارغ أو يحتوي أحرف تحكم."
      shift
      ;;
    --remove-data)
      REMOVE_DATA=1
      shift
      ;;
    --help|-h)
      help
      exit 0
      ;;
    *)
      printf 'خيار غير معروف: %s\n' "$1" >&2
      help >&2
      exit 1
      ;;
  esac
done

[[ -n "$DIR" ]] || die "تعذّر تحديد مسار التثبيت تلقائيًا. الرجاء تحديده صراحةً: bash scripts/uninstall.sh --dir /path/to/madar"

if (( REMOVE_DATA )); then
  if [[ ! -t 0 ]]; then
    die "--remove-data يحتاج إلى تأكيد تفاعلي؛ أعد التشغيل في طرفية تفاعلية. لم يُحذف أي شيء."
  fi
  read -r -p "سيحذف هذا الأمر volumes البيانات (wsd-data و code-server-*) نهائيًا. اكتب yes للتأكيد: " answer
  case "$answer" in
    yes|YES|Yes|نعم) ;;
    *) info "تم الإلغاء؛ لم يُحذف أي شيء."; exit 0 ;;
  esac
fi

if [[ -d "$DIR" ]]; then
  require_repo_layout "$DIR"
  TARGET_DIR="$(cd -- "$DIR" && pwd -P)"
else
  TARGET_DIR="$DIR"
fi

if [[ -f "$SYSTEMD_UNIT" ]]; then
  unit_wd="$(awk '/^WorkingDirectory=/{sub(/^WorkingDirectory=/, ""); print; exit}' "$SYSTEMD_UNIT" 2>/dev/null || true)"
  if [[ -z "$unit_wd" || "$unit_wd" != "$TARGET_DIR" ]]; then
    die "الوحدة madar.service تشير إلى مسار تثبيت آخر؛ تم الإلغاء، ولن تُحذف وحدة تخص تثبيتًا آخر على هذا المضيف."
  fi
fi

if [[ ! -d "$DIR" ]]; then
  warn "المجلد $DIR غير موجود؛ تم تخطي إيقاف Docker Compose."
else
  if [[ ! -f "$DIR/docker-compose.yml" ]]; then
    warn "ملف docker-compose.yml غير موجود في $DIR؛ تم تخطي إيقاف Docker Compose."
  else
    cd "$DIR"
    if (( REMOVE_DATA )); then
      info "جارٍ إيقاف Madar مع حذف volumes البيانات ..."
      docker compose down -v
    else
      info "جارٍ إيقاف Madar مع الاحتفاظ بالبيانات ..."
      docker compose down
    fi
  fi
  info "ملفات المشاريع لم تُلمس: $DIR/workspaces"
fi

if command -v systemctl >/dev/null 2>&1; then
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl disable --now madar.service >/dev/null 2>&1 || warn "تعذّر إيقاف أو تعطيل madar.service (قد لا يكون مثبّتًا)."
    rm -f "$SYSTEMD_UNIT" || warn "تعذّر حذف $SYSTEMD_UNIT."
    systemctl daemon-reload || warn "تعذّر تنفيذ systemctl daemon-reload."
    info "تمت إزالة وحدة systemd (إن كانت موجودة)."
  else
    info "لإزالة وحدة systemd، نفّذ:"
    printf 'sudo systemctl disable --now madar.service; sudo rm -f %q; sudo systemctl daemon-reload\n' "$SYSTEMD_UNIT"
  fi
else
  info "systemctl غير متاح؛ تم تخطي خطوة systemd."
fi

info "نسخة Madar في $DIR لم تُحذف. احذفها يدويًا إذا أردت."

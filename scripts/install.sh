#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/20057AMO/madar.git"
BRANCH="main"
SYSTEMD=1
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DEFAULT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SYSTEMD_UNIT="${MADAR_SYSTEMD_UNIT:-/etc/systemd/system/madar.service}"
PID1_DIR="${MADAR_SYSTEMD_PID1_DIR:-/run/systemd/system}"

help() {
  cat <<'EOF'
استخدام: install.sh [الخيارات]

الخيارات:
  --dir PATH      مسار التثبيت (الافتراضي: $MADAR_DIR أو مجلد نسخة Madar الحالية)
  --branch NAME   الفرع المستخدم عند استنساخ المستودع (الافتراضي: main)
  --no-systemd    تخطي تثبيت وحدة systemd
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

canonical_origin() {
  local norm="$1"
  while [[ "$norm" == */ ]]; do norm="${norm%/}"; done
  norm="${norm%.git}"
  while [[ "$norm" == */ ]]; do norm="${norm%/}"; done
  case "$norm" in
    git@github.com:*) norm="${norm#git@github.com:}" ;;
    https://github.com/*) norm="${norm#https://github.com/}" ;;
    http://github.com/*) norm="${norm#http://github.com/}" ;;
    github.com/*) norm="${norm#github.com/}" ;;
  esac
  printf '%s' "$norm"
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
    --branch)
      (($# >= 2)) || die "الخيار --branch يحتاج إلى اسم فرع."
      BRANCH="$2"
      shift 2
      ;;
    --branch=*)
      BRANCH="${1#*=}"
      shift
      ;;
    --no-systemd)
      SYSTEMD=0
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

[[ -n "$DIR" ]] || die "تعذّر تحديد مسار التثبيت تلقائيًا. الرجاء تحديده صراحةً: bash scripts/install.sh --dir /path/to/madar"

for tool in git docker curl awk grep cut tr; do
  command -v "$tool" >/dev/null 2>&1 || die "الأداة $tool غير مثبتة. ثبّتها ثم أعد التشغيل."
done
docker compose version >/dev/null 2>&1 || die "إضافة Docker Compose غير متاحة. استخدم Docker Engine 24+ أو Docker Desktop مع compose v2."

detect_systemd() {
  (( SYSTEMD )) || return 0
  if [[ ! -d "$PID1_DIR" ]]; then
    SYSTEMD=0
    warn "لم يتم اكتشاف systemd كعملية رقم 1؛ سيُثبَّت Madar ويُشغَّل الآن، وسيُتخطى تثبيت وحدة الإقلاع."
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    SYSTEMD=0
    warn "أمر systemctl غير متاح رغم وجود systemd؛ سيُتخطى تثبيت وحدة الإقلاع."
    return 0
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    local state
    state="$(systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "offline" ]]; then
      SYSTEMD=0
      warn "systemd في حالة offline؛ سيُتخطى تثبيت وحدة الإقلاع."
    fi
  fi
}
detect_systemd

if [[ ! -e "$DIR" ]]; then
  info "جارٍ استنساخ Madar في: $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --branch "$BRANCH" -- "$REPO" "$DIR" || die "فشل استنساخ المستودع."
  require_repo_layout "$DIR"
elif [[ -d "$DIR" ]]; then
  require_repo_layout "$DIR"
  [[ -d "$DIR/.git" || -f "$DIR/.git" ]] || die "المسار $DIR ليس نسخة Git من Madar."
  origin_url="$(git -C "$DIR" config --get remote.origin.url 2>/dev/null || true)"
  [[ "$(canonical_origin "$origin_url")" == "20057AMO/madar" ]] || die "المستودع في $DIR ليس النسخة الرسمية 20057AMO/madar."
  if [[ -n "$(git -C "$DIR" status --porcelain)" ]]; then
    die "النسخة في $DIR تحتوي تغييرات غير محفوظة. التحديث ملغي؛ لم يُنفَّذ أي أمر Compose. نظّفها أو انقلها ثم أعد التشغيل."
  fi
  info "جارٍ تحديث النسخة الحالية في $DIR ..."
  git -C "$DIR" pull --ff-only || die "فشل التحديث السريع (--ff-only). لم يُنفَّذ أي أمر Compose."
else
  die "المسار $DIR موجود لكنه ليس مجلدًا."
fi

cd "$DIR"
INSTALL_DIR="$(pwd -P)"

check_unit_collision() {
  local existing
  [[ -f "$SYSTEMD_UNIT" ]] || return 0
  existing="$(awk '/^WorkingDirectory=/{sub(/^WorkingDirectory=/, ""); print; exit}' "$SYSTEMD_UNIT" 2>/dev/null || true)"
  if [[ -z "$existing" || "$existing" != "$INSTALL_DIR" ]]; then
    die "توجد وحدة madar.service تشير إلى مسار تثبيت آخر؛ يُسمح بتثبيت Madar واحد فقط على كل مضيف."
  fi
}

UNIT_TEMPLATE="packaging/systemd/madar.service"
if (( SYSTEMD )); then
  [[ -f "$UNIT_TEMPLATE" ]] || die "قالب الوحدة $UNIT_TEMPLATE غير موجود في $INSTALL_DIR."
  check_unit_collision
fi

port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p=":${port}" '$4 ~ (p "$") { found = 1 } END { exit !found }'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 2
  fi
}

stack_running() {
  docker compose ps --status running --services 2>/dev/null | grep -qx app
}

env_port() {
  local file="$1" raw val
  [[ -f "$file" ]] || { printf '4097'; return; }
  raw="$(grep -m1 -E '^[[:space:]]*WSD_EMBED_PROXY_PORT=' "$file" | cut -d= -f2- || true)"
  val="${raw%%#*}"
  val="$(printf '%s' "$val" | tr -d " \t\r\n'\"")"
  printf '%s' "${val:-4097}"
}

if [[ -L .env || ( -e .env && ! -f .env ) ]]; then
  die "يوجد عنصر باسم .env في $INSTALL_DIR وليس ملفًا عاديًا؛ انقله أو احذفه ثم أعد التشغيل."
fi
if [[ -f .env ]]; then
  info "ملف .env موجود؛ لم يتم تغييره."
else
  [[ -f .env.example ]] || die ".env.example غير موجود في $INSTALL_DIR."
  ( umask 077; cp .env.example .env )
  info "تم إنشاء .env من .env.example بصلاحيات مقيّدة، مع ترك JWT_SECRET فارغًا."
fi

EMBED_PORT="$(env_port "$PWD/.env")"
[[ "$EMBED_PORT" =~ ^[0-9]+$ ]] && (( EMBED_PORT >= 1 && EMBED_PORT <= 65535 )) || die "قيمة WSD_EMBED_PROXY_PORT في .env غير صالحة؛ استخدم رقم منفذ بين 1 و 65535."

if stack_running; then
  info "Madar يعمل بالفعل في $INSTALL_DIR؛ تم تخطي فحص المنافذ 3000 و$EMBED_PORT لأن الحاويات تعمل وسيتم تحديثها."
else
  for port in 3000 "$EMBED_PORT"; do
    if port_listening "$port"; then
      die "المنفذ $port مستخدم بالفعل. أوقف العملية التي تستخدمه ثم أعد التشغيل."
    else
      probe_status=$?
      if (( probe_status == 2 )); then
        warn "لا تتوفر ss ولا lsof للتحقق من المنفذ $port؛ تأكد يدويًا أنه حر قبل المتابعة."
      fi
    fi
  done
fi

info "جارٍ بناء وتشغيل حاويات Madar ..."
# Workspace image toolchain pinned at build time (Ubuntu 26.04 / Node 24 LTS) via
# the compose build args; later refreshes are admin-gated in the UI (no auto-upgrade).
UBUNTU_VERSION=26.04 NODE_MAJOR=24 NODE_CHANNEL=lts docker compose up -d --build

wait_for_health() {
  local deadline=$(( SECONDS + 120 )) remaining timeout body
  while :; do
    remaining=$(( deadline - SECONDS ))
    (( remaining > 0 )) || return 1
    if (( remaining > 5 )); then timeout=5; else timeout="$remaining"; fi
    body="$(curl -fsS --max-time "$timeout" http://localhost:3000/api/health 2>/dev/null || true)"
    if [[ "$body" == *'"status":"ok"'* || "$body" == *'"status": "ok"'* ]]; then
      return 0
    fi
    (( SECONDS < deadline )) || return 1
    sleep 3
  done
}

if ! wait_for_health; then
  printf 'تعذّر الحصول على استجابة سليمة من /api/health خلال 120 ثانية.\n' >&2
  printf 'افحص السجلات: cd %q && docker compose logs --tail=100 app\n' "$INSTALL_DIR" >&2
  exit 1
fi
info "فحص الصحة نجح: http://localhost:3000/api/health"

if (( SYSTEMD )); then
  unit_tmp="$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/madar.service.XXXXXX")"
  trap 'rm -f "$unit_tmp"' EXIT
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *@MADAR_DIR@* ]]; then
      before="${line%%@MADAR_DIR@*}"
      after="${line#*@MADAR_DIR@}"
      printf '%s\n' "$before$INSTALL_DIR$after"
    else
      printf '%s\n' "$line"
    fi
  done < "$UNIT_TEMPLATE" > "$unit_tmp"

  if [[ "$(id -u)" -eq 0 ]]; then
    install -m 0644 "$unit_tmp" "$SYSTEMD_UNIT"
    systemctl daemon-reload
    systemctl enable --now madar.service
    info "تم تثبيت وتفعيل وحدة systemd: madar.service"
  else
    warn "الوحدة تعمل بصلاحيات root؛ تأكد أن ملكية $INSTALL_DIR لـ root وأن صلاحياتها تمنع تعديل المستخدمين العاديين لملفات المشروع، فأي تعديل يمكن أن يُنفَّذ كـroot عند الإقلاع. لا تضف ملفات env أو أسرارًا إلى الوحدة."
    info "لتفعيل التشغيل التلقائي عند الإقلاع، نفّذ الأمر التالي:"
    printf 'sudo install -m 0644 %q %q && sudo systemctl daemon-reload && sudo systemctl enable --now madar.service\n' "$unit_tmp" "$SYSTEMD_UNIT"
    warn "الملف $unit_tmp يحتوي على مسار التثبيت فقط، بلا أي أسرار أو EnvironmentFile."
    trap - EXIT
  fi
else
  info "تم تخطي تثبيت systemd بطلب منك (--no-systemd)."
fi

info ""
info "تم تثبيت Madar بنجاح في: $INSTALL_DIR"
info "اللوحة: http://localhost:3000 — أنشئ الحساب الأول عند الزيارة الأولى."
info "VS Code و OpenCode يُفتحان من داخل اللوحة عبر الوكيل المصادَق على المنفذ $EMBED_PORT."
info "تنبيه أمني: المنفذان 3000 و$EMBED_PORT يُنشران على 0.0.0.0. في أي نشر يتجاوز جهازك المحلي، أنهِ TLS أمامهما معًا قبل مشاركة العنوان مع الفريق."

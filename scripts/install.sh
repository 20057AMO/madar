#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/20057AMO/madar.git"
BRANCH="main"
SYSTEMD=1
PROD_TLS=0
MADAR_DOMAIN="${MADAR_DOMAIN:-}"
MADAR_EMAIL="${MADAR_EMAIL:-}"
MADAR_LAN_IP="${MADAR_LAN_IP:-}"
CERTBOT_WEBROOT="${MADAR_WEBROOT:-/var/www/certbot}"
NGINX_CONF="${MADAR_NGINX_CONF:-/etc/nginx/conf.d/madar.conf}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DEFAULT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SYSTEMD_UNIT="${MADAR_SYSTEMD_UNIT:-/etc/systemd/system/madar.service}"
CERTBOT_SERVICE_UNIT="${MADAR_CERTBOT_SERVICE_UNIT:-/etc/systemd/system/certbot-renew.service}"
CERTBOT_TIMER_UNIT="${MADAR_CERTBOT_TIMER_UNIT:-/etc/systemd/system/certbot-renew.timer}"
PID1_DIR="${MADAR_SYSTEMD_PID1_DIR:-/run/systemd/system}"

help() {
  cat <<'EOF'
استخدام: install.sh [الخيارات]

الخيارات:
  --dir PATH      مسار التثبيت (الافتراضي: $MADAR_DIR أو مجلد نسخة Madar الحالية)
  --branch NAME   الفرع المستخدم عند استنساخ المستودع (الافتراضي: main)
  --prod-tls      تثبيت نشر الإنتاج خلف nginx مع TLS وربط التطبيق على 127.0.0.1
  --domain NAME   نطاق الشهادة، مطلوب مع --prod-tls (أو MADAR_DOMAIN)
  --email ADDR    بريد Let's Encrypt، مطلوب مع --prod-tls (أو MADAR_EMAIL)
  --lan-ip IP     عنوان الواجهة العامة لـ :4097 (أو MADAR_LAN_IP؛ يُكتشف تلقائيًا)
  --no-systemd    تخطي تثبيت وحدة systemd (لا يعمل مع --prod-tls)
  --help          عرض هذه المساعدة
EOF
}

die() { printf 'خطأ: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
warn() { printf 'تنبيه: %s\n' "$*" >&2; }

valid_path_text() {
  [[ -n "$1" && "$1" != *[$'\x01'-$'\x1f']* && "$1" != *$'\x7f'* ]]
}

valid_domain() {
  [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]] || return 1
  [[ "$1" != "madar.example.com" ]] || return 1
  return 0
}

valid_email() {
  [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || return 1
  [[ "$1" != "admin@madar.example.com" ]] || return 1
  return 0
}

valid_ipv4() {
  local IFS=. o1 o2 o3 o4 octet
  [[ "$1" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  IFS=. read -r o1 o2 o3 o4 <<< "$1"
  for octet in "$o1" "$o2" "$o3" "$o4"; do
    (( 10#$octet <= 255 )) || return 1
  done
  (( 10#$o1 != 0 && 10#$o1 != 127 && 10#$o1 < 224 )) || return 1
  [[ "$1" != 169.254.* ]] || return 1
  [[ "$1" != 100.64.* ]] || return 1
  return 0
}

detect_lan_ip() {
  command -v ip >/dev/null 2>&1 || return 1
  local dev
  dev="$(ip -4 -o route show default 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
  [[ -n "$dev" ]] || return 1
  ip -4 -o addr show dev "$dev" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }'
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
    --prod-tls)
      PROD_TLS=1
      shift
      ;;
    --domain)
      (($# >= 2)) || die "الخيار --domain يحتاج إلى نطاق."
      MADAR_DOMAIN="$2"
      shift 2
      ;;
    --domain=*)
      MADAR_DOMAIN="${1#*=}"
      shift
      ;;
    --email)
      (($# >= 2)) || die "الخيار --email يحتاج إلى بريد إلكتروني."
      MADAR_EMAIL="$2"
      shift 2
      ;;
    --email=*)
      MADAR_EMAIL="${1#*=}"
      shift
      ;;
    --lan-ip)
      (($# >= 2)) || die "الخيار --lan-ip يحتاج إلى عنوان IPv4."
      MADAR_LAN_IP="$2"
      shift 2
      ;;
    --lan-ip=*)
      MADAR_LAN_IP="${1#*=}"
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

if (( PROD_TLS )); then
  (( SYSTEMD )) || die "الوضع --prod-tls يحتاج systemd لتثبيت nginx ووحدة التجديد."
  [[ "$(id -u)" -eq 0 ]] || die "الوضع --prod-tls يحتاج صلاحيات root لتثبيت nginx والشهادات ووحدات systemd."
  valid_domain "$MADAR_DOMAIN" || die "قيمة --domain غير صالحة أو ما زالت madar.example.com."
  valid_email "$MADAR_EMAIL" || die "قيمة --email غير صالحة أو ما زالت admin@madar.example.com."
  for tool in ip install nginx certbot systemctl; do
    command -v "$tool" >/dev/null 2>&1 || die "الأداة $tool مطلوبة للوضع --prod-tls."
  done
  if [[ -z "$MADAR_LAN_IP" ]]; then
    MADAR_LAN_IP="$(detect_lan_ip || true)"
  fi
  valid_ipv4 "$MADAR_LAN_IP" || die "تعذّر تحديد عنوان IPv4 عام صالح؛ مرّره عبر --lan-ip أو MADAR_LAN_IP."
fi

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
UNIT_TEMPLATE="packaging/systemd/madar.service"
RENEW_SERVICE_TEMPLATE="packaging/systemd/certbot-renew.service"
RENEW_TIMER_TEMPLATE="packaging/systemd/certbot-renew.timer"

COMPOSE_ARGS=(-f docker-compose.yml)
if (( PROD_TLS )); then
  COMPOSE_ARGS+=(-f docker-compose.prod-tls.yml)
fi
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

check_unit_collision() {
  local existing
  [[ -f "$SYSTEMD_UNIT" ]] || return 0
  existing="$(awk '/^WorkingDirectory=/{sub(/^WorkingDirectory=/, ""); print; exit}' "$SYSTEMD_UNIT" 2>/dev/null || true)"
  if [[ -z "$existing" || "$existing" != "$INSTALL_DIR" ]]; then
    die "توجد وحدة madar.service تشير إلى مسار تثبيت آخر؛ يُسمح بتثبيت Madar واحد فقط على كل مضيف."
  fi
}

if (( SYSTEMD )); then
  [[ -f "$UNIT_TEMPLATE" ]] || die "قالب الوحدة $UNIT_TEMPLATE غير موجود في $INSTALL_DIR."
  check_unit_collision
fi

if (( PROD_TLS )); then
  for file in docker-compose.prod-tls.yml deploy/nginx/madar.conf deploy/certbot/obtain.sh deploy/certbot/renew.sh scripts/check-prod-binding.sh "$RENEW_SERVICE_TEMPLATE" "$RENEW_TIMER_TEMPLATE"; do
    [[ -f "$file" ]] || die "ملف النشر $file غير موجود في $INSTALL_DIR."
  done
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
  compose ps --status running --services 2>/dev/null | grep -qx app
}

env_port() {
  local file="$1" raw val
  [[ -f "$file" ]] || { printf '4097'; return; }
  raw="$(grep -m1 -E '^[[:space:]]*WSD_EMBED_PROXY_PORT=' "$file" | cut -d= -f2- || true)"
  val="${raw%%#*}"
  val="$(printf '%s' "$val" | tr -d " \t\r\n'\"")"
  printf '%s' "${val:-4097}"
}

env_trust_proxy() {
  local file="$1" raw val
  [[ -f "$file" ]] || { printf ''; return; }
  raw="$(grep -m1 -E '^[[:space:]]*WSD_TRUST_PROXY=' "$file" | cut -d= -f2- || true)"
  val="${raw%%#*}"
  val="$(printf '%s' "$val" | tr -d " \t\r\n'\"")"
  printf '%s' "$val"
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

if (( PROD_TLS )); then
  trust_value="$(env_trust_proxy "$PWD/.env")"
  [[ -z "$trust_value" || "$trust_value" == 0 || "$trust_value" == false ]] || die "لا تضبط WSD_TRUST_PROXY في .env؛ التراكب الإنتاجي يضبطه وحده بعد تأمين المنافذ."
fi

if stack_running; then
  info "Madar يعمل بالفعل في $INSTALL_DIR؛ تم تخطي فحص المنافذ لأن الحاويات تعمل وسيتم تحديثها."
else
  check_ports=(3000)
  if (( PROD_TLS )); then
    check_ports+=( 4097 )
  else
    check_ports+=( "$EMBED_PORT" )
  fi
  for port in "${check_ports[@]}"; do
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

render_unit() {
  local source="$1" target="$2" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if (( PROD_TLS )); then
      [[ "$line" == @DEV_ONLY@* ]] && continue
      [[ "$line" == @PROD_TLS@* ]] && line="${line#@PROD_TLS@}"
    else
      [[ "$line" == @PROD_TLS@* ]] && continue
      [[ "$line" == @DEV_ONLY@* ]] && line="${line#@DEV_ONLY@}"
    fi
    line="${line//@MADAR_DIR@/$INSTALL_DIR}"
    line="${line//@MADAR_DOMAIN@/$MADAR_DOMAIN}"
    line="${line//@MADAR_EMAIL@/$MADAR_EMAIL}"
    line="${line//@MADAR_WEBROOT@/$CERTBOT_WEBROOT}"
    line="${line//@MADAR_NGINX_CONF@/$NGINX_CONF}"
    printf '%s\n' "$line"
  done < "$source" > "$target"
}

install_nginx_site() {
  local source="$1"
  rm -f -- "$NGINX_CONF"
  install -d -m 0755 "$(dirname -- "$NGINX_CONF")"
  install -m 0644 -- "$source" "$NGINX_CONF"
}

start_or_reload_nginx() {
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl enable --now nginx
  fi
}

TEMP_FILES=()
cleanup() {
  local file
  for file in "${TEMP_FILES[@]}"; do
    rm -f -- "$file" 2>/dev/null || true
  done
}
trap cleanup EXIT

if (( PROD_TLS )); then
  bootstrap_conf="$(mktemp "${TMPDIR:-/tmp}/madar-nginx-acme.XXXXXX")"
  final_conf="$(mktemp "${TMPDIR:-/tmp}/madar-nginx-final.XXXXXX")"
  TEMP_FILES+=("$bootstrap_conf" "$final_conf")

  cat > "$bootstrap_conf" <<EOF
server {
    listen 80;
    server_name $MADAR_DOMAIN;
    access_log off;

    location /.well-known/acme-challenge/ {
        root $CERTBOT_WEBROOT;
    }

    location / {
        return 404;
    }
}
EOF

  install -d -m 0755 "$CERTBOT_WEBROOT"
  install_nginx_site "$bootstrap_conf"
  nginx -t || die "فحص إعداد nginx الأولي فشل."
  start_or_reload_nginx

  info "جارٍ الحصول على شهادة TLS لـ $MADAR_DOMAIN ..."
  MADAR_DOMAIN="$MADAR_DOMAIN" MADAR_EMAIL="$MADAR_EMAIL" MADAR_WEBROOT="$CERTBOT_WEBROOT" MADAR_NGINX_CONF="$NGINX_CONF" bash deploy/certbot/obtain.sh

  compose config --quiet || die "فحص تركيب Docker Compose الإنتاجي فشل."
  info "جارٍ بناء وتشغيل حاويات Madar بالتراكب الإنتاجي ..."
  UBUNTU_VERSION=26.04 NODE_MAJOR=24 NODE_CHANNEL=lts compose up -d --build --remove-orphans
else
  info "جارٍ بناء وتشغيل حاويات Madar ..."
  UBUNTU_VERSION=26.04 NODE_MAJOR=24 NODE_CHANNEL=lts compose up -d --build
fi

wait_for_health() {
  local deadline=$(( SECONDS + 120 )) remaining timeout body
  while :; do
    remaining=$(( deadline - SECONDS ))
    (( remaining > 0 )) || return 1
    if (( remaining > 5 )); then timeout=5; else timeout="$remaining"; fi
    body="$(curl -fsS --max-time "$timeout" http://127.0.0.1:3000/api/health 2>/dev/null || true)"
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
info "فحص الصحة نجح: http://127.0.0.1:3000/api/health"

if (( PROD_TLS )); then
  awk -v domain="$MADAR_DOMAIN" -v lan_ip="$MADAR_LAN_IP" -v webroot="$CERTBOT_WEBROOT" '
  function replace_all(s, old, new,   out, idx) {
    out = ""
    while ((idx = index(s, old)) > 0) {
      out = out substr(s, 1, idx - 1) new
      s = substr(s, idx + length(old))
    }
    return out s
  }
  {
    line = $0
    line = replace_all(line, "madar.example.com", domain)
    line = replace_all(line, "/var/www/certbot", webroot)
    if (line == "    listen 4097 ssl;") line = "    listen " lan_ip ":4097 ssl;"
    print line
  }' deploy/nginx/madar.conf > "$final_conf"
  grep -q "server_name $MADAR_DOMAIN;" "$final_conf" || die "فشل تبديل النطاق في إعداد nginx."
  grep -q "listen $MADAR_LAN_IP:4097 ssl;" "$final_conf" || die "فشل تبديل عنوان :4097 في إعداد nginx."
  grep -q "root $CERTBOT_WEBROOT;" "$final_conf" || die "فشل تبديل مسار ACME في إعداد nginx."
  ! grep -q 'madar\.example\.com' "$final_conf" || die "بقيت قيمة النطاق النموذجية في إعداد nginx."

  install_nginx_site "$final_conf"
  if ! nginx -t; then
    install_nginx_site "$bootstrap_conf" || true
    die "فحص إعداد nginx النهائي فشل؛ أُعيد إعداد ACME_only المؤقت."
  fi
  start_or_reload_nginx
  info "تم تثبيت إعداد nginx النهائي: https://$MADAR_DOMAIN و https://$MADAR_DOMAIN:4097"

  bash scripts/check-prod-binding.sh --dir "$INSTALL_DIR" --check-running || die "فحص ربط الإنتاج فشل."
  info "حارسة الربط نجحت: المنفذان 3000 و4097 مرتبطان على 127.0.0.1."
fi

if (( SYSTEMD )); then
  unit_tmp="$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/madar.service.XXXXXX")"
  TEMP_FILES+=("$unit_tmp")
  render_unit "$UNIT_TEMPLATE" "$unit_tmp"

  if (( PROD_TLS )); then
    renew_service_tmp="$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/certbot-renew.service.XXXXXX")"
    renew_timer_tmp="$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/certbot-renew.timer.XXXXXX")"
    TEMP_FILES+=("$renew_service_tmp" "$renew_timer_tmp")
    render_unit "$RENEW_SERVICE_TEMPLATE" "$renew_service_tmp"
    render_unit "$RENEW_TIMER_TEMPLATE" "$renew_timer_tmp"
  fi

  if [[ "$(id -u)" -eq 0 ]]; then
    install -m 0644 "$unit_tmp" "$SYSTEMD_UNIT"
    if (( PROD_TLS )); then
      install -m 0644 "$renew_service_tmp" "$CERTBOT_SERVICE_UNIT"
      install -m 0644 "$renew_timer_tmp" "$CERTBOT_TIMER_UNIT"
    fi
    systemctl daemon-reload
    systemctl enable --now madar.service
    if (( PROD_TLS )); then
      systemctl enable --now certbot-renew.timer
      info "تم تثبيت وتفعيل وحدات systemd: madar.service و certbot-renew.timer"
    else
      info "تم تثبيت وتفعيل وحدة systemd: madar.service"
    fi
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
if (( PROD_TLS )); then
  info "اللوحة: https://$MADAR_DOMAIN"
  info "VS Code و OpenCode: https://$MADAR_DOMAIN:4097 — عبر الوكيل المصادَق، مع بوابة editor+"
  info "تأكد أن جدار النار يسمح بـ 80 و443 و$MADAR_LAN_IP:4097 فقط، ولا يسمح بالوصول المباشر إلى 127.0.0.1:3000."
else
  info "اللوحة: http://localhost:3000 — أنشئ الحساب الأول عند الزيارة الأولى."
  info "VS Code و OpenCode يُفتحان من داخل اللوحة عبر الوكيل المصادَق على المنفذ $EMBED_PORT."
  info "تنبيه أمني: المنفذان 3000 و$EMBED_PORT يُنشران على 0.0.0.0. في أي نشر يتجاوز جهازك المحلي، استخدم --prod-tls أو أنهِ TLS أمامهما معًا قبل مشاركة العنوان مع الفريق."
fi

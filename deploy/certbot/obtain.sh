#!/bin/sh
set -eu

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

domain=${MADAR_DOMAIN:-}
email=${MADAR_EMAIL:-admin@madar.example.com}
webroot=${MADAR_WEBROOT:-/var/www/certbot}
nginx_conf=${MADAR_NGINX_CONF:-/etc/nginx/conf.d/madar.conf}

valid_domain() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*|.*|*.) return 1 ;;
  esac
  case "$1" in *..*) return 1 ;; esac
  return 0
}

valid_email() {
  case "$1" in
    ''|*[[:space:]]*|*@*@*) return 1 ;;
    *@*.*) return 0 ;;
    *) return 1 ;;
  esac
}

reload_nginx() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    systemctl reload nginx
  elif [ -f /run/nginx.pid ] || [ -f /var/run/nginx.pid ]; then
    nginx -s reload
  else
    printf 'warning: nginx is not running; certificate obtained but nginx was not reloaded\n' >&2
  fi
}

[ "$(id -u)" = 0 ] || die "run as root"
valid_domain "$domain" || die "MADAR_DOMAIN is not a valid domain"
[ "$domain" != "madar.example.com" ] || die "replace MADAR_DOMAIN placeholder madar.example.com"
valid_email "$email" || die "MADAR_EMAIL is not a valid email"
[ "$email" != "admin@madar.example.com" ] || die "replace MADAR_EMAIL placeholder admin@madar.example.com"
case "$webroot" in /*) ;; *) die "MADAR_WEBROOT must be an absolute path" ;; esac
case "$webroot" in *[[:space:]]*) die "MADAR_WEBROOT must not contain whitespace" ;; esac
case "$nginx_conf" in /*) ;; *) die "MADAR_NGINX_CONF must be an absolute path" ;; esac
case "$nginx_conf" in *[[:space:]]*) die "MADAR_NGINX_CONF must not contain whitespace" ;; esac
for tool in nginx certbot; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done
[ -f "$nginx_conf" ] || die "nginx site $nginx_conf is missing"
mkdir -p "$webroot"

certbot certonly --webroot -w "$webroot" -d "$domain" --non-interactive --agree-tos --email "$email" --keep-until-expiring
nginx -t
reload_nginx
printf 'ok: certificate for %s is ready\n' "$domain"

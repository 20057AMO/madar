#!/bin/sh
set -eu

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

domain=${MADAR_DOMAIN:-}
webroot=${MADAR_WEBROOT:-/var/www/certbot}
nginx_conf=${MADAR_NGINX_CONF:-/etc/nginx/conf.d/madar.conf}

valid_domain() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*|.*|*.) return 1 ;;
  esac
  case "$1" in *..*) return 1 ;; esac
  return 0
}

reload_nginx() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    systemctl reload nginx
  elif [ -f /run/nginx.pid ] || [ -f /var/run/nginx.pid ]; then
    nginx -s reload
  else
    printf 'warning: nginx is not running; certificate renewed but nginx was not reloaded\n' >&2
  fi
}

resolve_script_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    */*)
      script_dir=$(CDPATH= cd -- "${1%/*}" && pwd -P) || return 1
      printf '%s/%s\n' "$script_dir" "${1##*/}"
      ;;
    *)
      resolved=$(command -v -- "$1" 2>/dev/null || true)
      [ -n "$resolved" ] || return 1
      printf '%s\n' "$resolved"
      ;;
  esac
}

if [ "${1:-}" = "--reload-nginx" ]; then
  [ "$#" -eq 1 ] || die "usage: $0 [--reload-nginx]"
  command -v nginx >/dev/null 2>&1 || die "missing tool: nginx"
  case "$nginx_conf" in /*) ;; *) die "MADAR_NGINX_CONF must be an absolute path" ;; esac
  [ -f "$nginx_conf" ] || die "nginx site $nginx_conf is missing"
  nginx -t
  reload_nginx
  printf 'ok: nginx reloaded after certificate renewal\n'
  exit 0
fi

[ "$#" -eq 0 ] || die "usage: $0 [--reload-nginx]"
[ "$(id -u)" = 0 ] || die "run as root"
valid_domain "$domain" || die "MADAR_DOMAIN is not a valid domain"
[ "$domain" != "madar.example.com" ] || die "replace MADAR_DOMAIN placeholder madar.example.com"
case "$webroot" in /*) ;; *) die "MADAR_WEBROOT must be an absolute path" ;; esac
case "$webroot" in *[[:space:]]*) die "MADAR_WEBROOT must not contain whitespace" ;; esac
case "$nginx_conf" in /*) ;; *) die "MADAR_NGINX_CONF must be an absolute path" ;; esac
case "$nginx_conf" in *[[:space:]]*) die "MADAR_NGINX_CONF must not contain whitespace" ;; esac
for tool in nginx certbot; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done
[ -f "$nginx_conf" ] || die "nginx site $nginx_conf is missing"
script_path=$(resolve_script_path "$0") || die "cannot resolve script path"
case "$script_path" in *\'*) die "script path contains a single quote" ;; esac
mkdir -p "$webroot"

certbot renew --webroot -w "$webroot" --non-interactive --quiet --deploy-hook "/bin/sh '$script_path' --reload-nginx"
printf 'ok: certificate renewal check finished\n'

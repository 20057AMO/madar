#!/bin/sh
set -eu

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { printf 'usage: %s [--dir DIR] [--check-running]\n' "$0" >&2; }

dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
check_running=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || { usage; exit 2; }
      dir=$2
      shift 2
      ;;
    --dir=*)
      dir=${1#*=}
      shift
      ;;
    --check-running)
      check_running=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

cd -- "$dir" || die "cannot enter $dir"
for tool in docker awk; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done
[ -f docker-compose.yml ] || die "docker-compose.yml missing in $dir"
[ -f docker-compose.prod-tls.yml ] || die "docker-compose.prod-tls.yml missing in $dir"

if ! cfg=$(docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml config); then
  die "docker compose config failed"
fi

if ! report=$(printf '%s\n' "$cfg" | awk '
function unquote(s) { gsub(/^["\047]|["\047]$/, "", s); return s }
function valueAfterColon(s) {
  v = s
  sub(/^[^:]*:[[:space:]]*/, "", v)
  return unquote(v)
}
function flush(    p, t) {
  if (!entry) return
  count++
  host = unquote(host)
  p = unquote(published)
  t = unquote(target)
  if (host != "127.0.0.1") { printf "BAD_HOST %s\n", host; bad = 1 }
  if (p == "" || t == "") { print "INCOMPLETE_BINDING"; bad = 1 }
  if (p != t) { printf "TARGET_MISMATCH %s %s\n", p, t; bad = 1 }
  if (p != "3000" && p != "4097") { printf "UNEXPECTED_PORT %s\n", p; bad = 1 }
  if (p == "3000") c3000++
  if (p == "4097") c4097++
  entry = 0
}
/^services:$/ { in_services = 1; next }
in_services && /^  [^[:space:]]/ {
  svc = $1; sub(/:$/, "", svc)
  in_app = (svc == "app")
  in_env = 0; in_ports = 0
  next
}
!in_app { next }
/^    environment:$/ { in_env = 1; in_ports = 0; next }
/^    ports:$/ { in_ports = 1; in_env = 0; next }
/^    [^[:space:]]/ { flush(); in_env = 0; in_ports = 0 }
in_env && /WSD_TRUSTED_PROXIES:/ {
  v = $0
  sub(/^[^:]*:[[:space:]]*/, "", v)
  v = unquote(v)
  gsub(/[[:space:]]/, "", v)
  trusted = v
  has_trusted = 1
}
in_env && /WSD_TRUST_PROXY:/ {
  v = $0
  sub(/^[^:]*:[[:space:]]*/, "", v)
  v = unquote(v)
  gsub(/[[:space:]]/, "", v)
  legacy = v
}
in_ports && /^      - / { flush(); entry = 1; host = ""; published = ""; target = "" }
in_ports && /host_ip:/ { host = valueAfterColon($0) }
in_ports && /published:/ { published = valueAfterColon($0) }
in_ports && /target:/ { target = valueAfterColon($0) }
END {
  flush()
  if (count != 2) { printf "BINDING_COUNT %d\n", count; bad = 1 }
  if (c3000 != 1 || c4097 != 1) { printf "PORT_SET 3000=%d 4097=%d\n", c3000, c4097; bad = 1 }
  if (has_trusted) {
    if (trusted == "") { printf "WSD_TRUSTED_PROXIES empty\n"; bad = 1 }
  } else if (legacy == "1" || legacy == "true") {
    printf "DEPRECATED WSD_TRUST_PROXY=%s; use WSD_TRUSTED_PROXIES in the prod overlay\n", legacy
    trusted = "WSD_TRUST_PROXY=" legacy
  } else {
    printf "WSD_TRUSTED_PROXIES missing\n"; bad = 1
  }
  if (trusted != "" && tolower(trusted) ~ /\/0$/) { printf "WILDCARD_TRUSTED_PROXY %s\n", trusted; bad = 1 }
  if (bad) exit 1
}
'); then
  printf '%s\n' "$report" >&2
  die "effective compose config failed the production binding guard"
fi

if [ "$check_running" -eq 1 ]; then
  state=$(docker inspect -f '{{.State.Running}}' wsd-pro 2>/dev/null || true)
  if [ "$state" != "true" ]; then
    printf 'skip: container wsd-pro is not running; runtime binding not checked\n'
  else
    if ! live=$(docker port wsd-pro 2>/dev/null); then
      die "cannot read published ports from running container wsd-pro"
    fi
    if ! live_report=$(printf '%s\n' "$live" | awk '
{
  sep = index($0, "->")
  if (!sep) { printf "UNPARSEABLE %s\n", $0; bad = 1; next }
  count++
  bind = substr($0, sep + 2)
  gsub(/^[[:space:]]+|[[:space:]]+$/, "", bind)
  parts = split(bind, a, ":")
  port = a[parts]
  if (port == "3000") c3000++
  else if (port == "4097") c4097++
  else { printf "UNEXPECTED_RUNTIME_PORT %s\n", port; bad = 1 }
  if (bind !~ /^127\.0\.0\.1:[0-9]+$/) { printf "BAD_RUNTIME_BIND %s\n", bind; bad = 1 }
}
END {
  if (count != 2) { printf "RUNTIME_BINDING_COUNT %d\n", count; bad = 1 }
  if (c3000 != 1 || c4097 != 1) { printf "RUNTIME_PORT_SET 3000=%d 4097=%d\n", c3000, c4097; bad = 1 }
  if (bad) exit 1
}
'); then
      printf '%s\n' "$live_report" >&2
      die "running container wsd-pro is not loopback-only on 3000 and 4097"
    fi
  fi
fi

printf 'ok: app ports 3000 and 4097 are bound to 127.0.0.1 and WSD_TRUSTED_PROXIES is configured\n'

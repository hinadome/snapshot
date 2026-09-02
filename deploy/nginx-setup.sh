#!/usr/bin/env bash
# Add Snapshot as an nginx site (HTTP or HTTPS) — without replacing existing sites.
#
# Safe behavior:
#   - Never overwrites /etc/nginx/nginx.conf
#   - Never edits other files under sites-enabled / conf.d
#   - Only installs/updates a dedicated Snapshot site file
#   - Always runs `nginx -t` before reload
#
# Usage:
#   ./deploy/nginx-setup.sh --domain snapshot.example.com --http
#   ./deploy/nginx-setup.sh --domain snapshot.example.com --certbot --email ops@example.com
#   ./deploy/nginx-setup.sh --domain snapshot.example.com --self-signed
#   ./deploy/nginx-setup.sh --domain snapshot.example.com --cert /path/fullchain.pem --key /path/privkey.pem
#   ./deploy/nginx-setup.sh --remove
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_HTTPS="${ROOT}/deploy/nginx/snapshot.conf.template"
TEMPLATE_HTTP="${ROOT}/deploy/nginx/snapshot-http.conf.template"
RATE_LIMITS="${ROOT}/deploy/nginx/snapshot-rate-limit.conf"
VALIDATE_DOMAIN_LIB="${ROOT}/deploy/lib/validate-domain.sh"
SITE_NAME="${SNAPSHOT_NGINX_SITE_NAME:-snapshot}"
UPSTREAM_HOST="${SNAPSHOT_NGINX_UPSTREAM_HOST:-127.0.0.1}"
UPSTREAM_PORT="${PORT:-${SNAPSHOT_PORT:-8787}}"
DOMAIN="${SNAPSHOT_DOMAIN:-}"
EMAIL="${SNAPSHOT_CERTBOT_EMAIL:-}"
CERT_PATH="${SNAPSHOT_SSL_CERT:-}"
KEY_PATH="${SNAPSHOT_SSL_KEY:-}"
MODE="" # http | certbot | self-signed | custom
DO_REMOVE=0
SKIP_BIND=0

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    die "need root or sudo for: $*"
  fi
}

usage() {
  cat <<'EOF'
Snapshot nginx front (additive — does not break existing sites)

  ./deploy/nginx-setup.sh --domain <hostname> --http
  ./deploy/nginx-setup.sh --domain <hostname> --certbot --email you@example.com
  ./deploy/nginx-setup.sh --domain <hostname> --self-signed
  ./deploy/nginx-setup.sh --domain <hostname> --cert fullchain.pem --key privkey.pem
  ./deploy/nginx-setup.sh --remove

Required:
  --domain NAME          server_name for this app only (new vhost)

Mode (pick one):
  --http                 HTTP only on port 80 (no TLS) — lab / private network
  --certbot --email E    Let's Encrypt HTTPS via certbot
  --self-signed          HTTPS with a local cert (browsers will warn)
  --cert PATH --key PATH HTTPS with existing certificate files

Options:
  --site-name NAME       nginx site id (default: snapshot)
  --upstream HOST:PORT   app backend (default: 127.0.0.1:8787)
  --skip-bind            Do not rewrite deploy/snapshot.env HOST=127.0.0.1
  --remove               Disable and delete only the Snapshot site file

Environment equivalents: SNAPSHOT_DOMAIN, SNAPSHOT_CERTBOT_EMAIL,
  SNAPSHOT_SSL_CERT, SNAPSHOT_SSL_KEY, PORT / SNAPSHOT_PORT

Note: updates SNAPSHOT_CORS_ORIGINS in deploy/snapshot.env to this site's
  origin (API CORS for browser→Snapshot). HAR-replay CORS is a per-job UI setting.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --http) MODE=http; shift ;;
    --certbot) MODE=certbot; shift ;;
    --self-signed) MODE=self-signed; shift ;;
    --cert) CERT_PATH="${2:-}"; MODE=custom; shift 2 ;;
    --key) KEY_PATH="${2:-}"; MODE=custom; shift 2 ;;
    --site-name) SITE_NAME="${2:-}"; shift 2 ;;
    --upstream)
      raw="${2:-}"
      if [[ "${raw}" == *:* ]]; then
        UPSTREAM_HOST="${raw%%:*}"
        UPSTREAM_PORT="${raw##*:}"
      else
        UPSTREAM_HOST="${raw}"
      fi
      shift 2
      ;;
    --skip-bind) SKIP_BIND=1; shift ;;
    --remove) DO_REMOVE=1; shift ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

detect_nginx_layout() {
  if [[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]]; then
    SITE_AVAILABLE="/etc/nginx/sites-available/${SITE_NAME}"
    SITE_ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"
    LAYOUT=debian
  elif [[ -d /etc/nginx/conf.d ]]; then
    SITE_AVAILABLE="/etc/nginx/conf.d/${SITE_NAME}.conf"
    SITE_ENABLED=""
    LAYOUT=confd
  else
    die "nginx config dirs not found (/etc/nginx/sites-available or conf.d). Is nginx installed?"
  fi
}

ensure_nginx_installed() {
  if have nginx; then
    log "nginx $(nginx -v 2>&1 | head -1) present"
    return
  fi
  log "nginx not found — installing"
  if have apt-get; then
    run_root apt-get update -y
    run_root apt-get install -y nginx
  elif have dnf; then
    run_root dnf install -y nginx
  elif have yum; then
    run_root yum install -y nginx
  else
    die "cannot install nginx automatically; install it and re-run"
  fi
}

ensure_nginx_running() {
  if have systemctl; then
    if systemctl is-active --quiet nginx 2>/dev/null; then
      log "nginx is already running (existing sites left untouched)"
    else
      log "starting nginx"
      run_root systemctl enable --now nginx
    fi
  else
    warn "systemctl unavailable — ensure nginx is running yourself"
  fi
}

nginx_test_and_reload() {
  log "Validating nginx config (nginx -t)"
  if ! run_root nginx -t; then
    die "nginx -t failed — Snapshot site NOT enabled; existing sites unchanged"
  fi
  log "Reloading nginx"
  if have systemctl; then
    run_root systemctl reload nginx
  else
    run_root nginx -s reload
  fi
}

remove_site() {
  detect_nginx_layout
  log "Removing Snapshot nginx site only (${SITE_NAME})"
  if [[ "${LAYOUT}" == "debian" ]]; then
    run_root rm -f "${SITE_ENABLED}"
    run_root rm -f "${SITE_AVAILABLE}"
  else
    run_root rm -f "${SITE_AVAILABLE}"
  fi
  if have nginx; then
    nginx_test_and_reload || warn "reload after remove failed"
  fi
  log "Done. Other nginx sites were not modified."
}

render_https_site() {
  local cert="$1" key="$2" out="$3"
  [[ -f "${TEMPLATE_HTTPS}" ]] || die "missing template ${TEMPLATE_HTTPS}"
  sed \
    -e "s|__SERVER_NAME__|${DOMAIN}|g" \
    -e "s|__UPSTREAM__|${UPSTREAM_HOST}:${UPSTREAM_PORT}|g" \
    -e "s|__SSL_CERT__|${cert}|g" \
    -e "s|__SSL_KEY__|${key}|g" \
    "${TEMPLATE_HTTPS}" > "${out}"
}

render_http_site() {
  local out="$1"
  [[ -f "${TEMPLATE_HTTP}" ]] || die "missing template ${TEMPLATE_HTTP}"
  sed \
    -e "s|__SERVER_NAME__|${DOMAIN}|g" \
    -e "s|__UPSTREAM__|${UPSTREAM_HOST}:${UPSTREAM_PORT}|g" \
    "${TEMPLATE_HTTP}" > "${out}"
}

install_rate_limits() {
  [[ -f "${RATE_LIMITS}" ]] || return 0
  local dest="/etc/nginx/conf.d/snapshot-rate-limit.conf"
  log "Installing rate limit zone ${dest} (additive)"
  run_root cp "${RATE_LIMITS}" "${dest}"
}

install_site_file() {
  local rendered="$1"
  detect_nginx_layout
  install_rate_limits
  log "Installing site file ${SITE_AVAILABLE} (additive)"
  run_root cp "${rendered}" "${SITE_AVAILABLE}"
  if [[ "${LAYOUT}" == "debian" ]]; then
    run_root ln -sfn "${SITE_AVAILABLE}" "${SITE_ENABLED}"
  fi
}

scheme_for_cors() {
  if [[ "${MODE}" == "http" ]]; then
    printf 'http'
  else
    printf 'https'
  fi
}

bind_app_localhost() {
  [[ "${SKIP_BIND}" -eq 1 ]] && return
  local env_path="${ROOT}/deploy/snapshot.env"
  local scheme
  scheme="$(scheme_for_cors)"
  if [[ ! -f "${env_path}" ]]; then
    warn "no ${env_path} yet — create it via ./deploy/vm-deploy.sh first"
    warn "set HOST=127.0.0.1 so Snapshot is not exposed on the public interface"
    return
  fi
  if grep -q '^HOST=' "${env_path}"; then
    sed -i.bak 's|^HOST=.*|HOST=127.0.0.1|' "${env_path}"
    rm -f "${env_path}.bak"
  else
    printf '\nHOST=127.0.0.1\n' >> "${env_path}"
  fi
  if grep -q '^SNAPSHOT_CORS_ORIGINS=' "${env_path}"; then
    sed -i.bak "s|^SNAPSHOT_CORS_ORIGINS=.*|SNAPSHOT_CORS_ORIGINS=${scheme}://${DOMAIN}|" "${env_path}"
    rm -f "${env_path}.bak"
  else
    printf 'SNAPSHOT_CORS_ORIGINS=%s://%s\n' "${scheme}" "${DOMAIN}" >> "${env_path}"
  fi
  log "Updated ${env_path}: HOST=127.0.0.1 (app only reachable via nginx)"

  if have systemctl && systemctl cat snapshot.service &>/dev/null; then
    log "Restarting snapshot so bind address takes effect"
    run_root systemctl restart snapshot.service || warn "could not restart snapshot.service"
  else
    warn "restart Snapshot yourself so it listens on 127.0.0.1:${UPSTREAM_PORT}"
  fi
}

ensure_self_signed() {
  local dir="/etc/nginx/ssl/snapshot"
  CERT_PATH="${dir}/fullchain.pem"
  KEY_PATH="${dir}/privkey.pem"
  if [[ -f "${CERT_PATH}" && -f "${KEY_PATH}" ]]; then
    log "Reusing self-signed cert at ${CERT_PATH}"
    return
  fi
  log "Generating self-signed certificate for ${DOMAIN}"
  run_root mkdir -p "${dir}"
  if run_root openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" \
    -subj "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN}" 2>/dev/null; then
    return
  fi
  run_root openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" \
    -subj "/CN=${DOMAIN}"
}

run_certbot() {
  [[ -n "${EMAIL}" ]] || die "--certbot requires --email"
  if ! have certbot; then
    log "Installing certbot"
    if have apt-get; then
      run_root apt-get update -y
      run_root apt-get install -y certbot python3-certbot-nginx
    elif have dnf; then
      run_root dnf install -y certbot python3-certbot-nginx
    else
      die "install certbot + python3-certbot-nginx, then re-run"
    fi
  fi

  ensure_self_signed
  local tmp
  tmp="$(mktemp)"
  render_https_site "${CERT_PATH}" "${KEY_PATH}" "${tmp}"
  install_site_file "${tmp}"
  rm -f "${tmp}"
  nginx_test_and_reload

  log "Requesting Let's Encrypt certificate for ${DOMAIN}"
  run_root certbot --nginx \
    -d "${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos \
    --non-interactive \
    --redirect \
    --keep-until-expiring

  CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  KEY_PATH="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  nginx_test_and_reload
}

# --- main ---

if [[ "${DO_REMOVE}" -eq 1 ]]; then
  remove_site
  exit 0
fi

[[ -n "${DOMAIN}" ]] || die "--domain is required (dedicated server_name; keeps other apps intact)"

# shellcheck source=deploy/lib/validate-domain.sh
source "${VALIDATE_DOMAIN_LIB}"
if ! validate_domain "${DOMAIN}"; then
  die "invalid domain name: ${DOMAIN} (use a hostname like snapshot.example.com)"
fi

if [[ -z "${MODE}" ]]; then
  if [[ -n "${CERT_PATH}" || -n "${KEY_PATH}" ]]; then
    MODE=custom
  else
    MODE=self-signed
    warn "No mode given — defaulting to --self-signed (use --http for plain HTTP, --certbot for real HTTPS)"
  fi
fi

ensure_nginx_installed
ensure_nginx_running
detect_nginx_layout

case "${MODE}" in
  http)
    tmp="$(mktemp)"
    render_http_site "${tmp}"
    install_site_file "${tmp}"
    rm -f "${tmp}"
    nginx_test_and_reload
    ;;
  certbot)
    run_certbot
    ;;
  self-signed)
    ensure_self_signed
    tmp="$(mktemp)"
    render_https_site "${CERT_PATH}" "${KEY_PATH}" "${tmp}"
    install_site_file "${tmp}"
    rm -f "${tmp}"
    nginx_test_and_reload
    ;;
  custom)
    [[ -n "${CERT_PATH}" && -n "${KEY_PATH}" ]] || die "--cert and --key required"
    [[ -f "${CERT_PATH}" ]] || die "cert not found: ${CERT_PATH}"
    [[ -f "${KEY_PATH}" ]] || die "key not found: ${KEY_PATH}"
    tmp="$(mktemp)"
    render_https_site "${CERT_PATH}" "${KEY_PATH}" "${tmp}"
    install_site_file "${tmp}"
    rm -f "${tmp}"
    nginx_test_and_reload
    ;;
  *)
    die "unknown mode: ${MODE}"
    ;;
esac

bind_app_localhost

SCHEME="$(scheme_for_cors)"
echo
echo "Snapshot nginx vhost installed for server_name=${DOMAIN}"
echo "  Mode:       ${MODE}"
echo "  Layout:     ${LAYOUT}"
echo "  Site file:  ${SITE_AVAILABLE}"
echo "  Upstream:   ${UPSTREAM_HOST}:${UPSTREAM_PORT}"
echo "  URL:        ${SCHEME}://${DOMAIN}/"
echo "  Health:     ${SCHEME}://${DOMAIN}/api/health"
echo
echo "Existing nginx sites were not modified."
if [[ "${MODE}" == "http" ]]; then
  echo "Ensure DNS for ${DOMAIN} points at this VM, and open port 80."
  echo "HTTP only — use --certbot or --self-signed for HTTPS when ready."
else
  echo "Ensure DNS for ${DOMAIN} points at this VM, and open ports 80/443."
fi
if [[ "${MODE}" == "self-signed" ]]; then
  echo "Browsers will warn on the self-signed cert until you switch to --certbot or --cert/--key."
fi

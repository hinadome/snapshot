#!/usr/bin/env bash
# Deploy Snapshot on a Linux VM (install deps, build, run via systemd or foreground).
#
# Usage (from monorepo root, as a user that can write the repo + optionally sudo):
#   ./deploy/vm-deploy.sh
#   ./deploy/vm-deploy.sh --nginx --domain snapshot.example.com --http
#   ./deploy/vm-deploy.sh --nginx --domain snapshot.example.com --certbot --email ops@example.com
#   ./deploy/vm-deploy.sh --build-only
#   ./deploy/vm-deploy.sh --foreground
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SNAPSHOT_SERVICE_NAME:-snapshot}"
SERVICE_FILE="${ROOT}/deploy/systemd/snapshot.service"
PORT="${PORT:-${SNAPSHOT_PORT:-8787}}"
DATA_DIR="${SNAPSHOT_DATA_DIR:-${ROOT}/data}"
WEB_DIST="${SNAPSHOT_WEB_DIST:-${ROOT}/apps/web/dist}"
HOST="${HOST:-${SNAPSHOT_HOST:-}}"
PUBLIC_BIND=0
NODE_MIN_MAJOR="${SNAPSHOT_NODE_MIN_MAJOR:-20}"
ENSURE_NODE_LIB="${ROOT}/deploy/lib/ensure-node.sh"

# Optional nginx front (HTTPS) — additive site only
WITH_NGINX=0
NGINX_DOMAIN="${SNAPSHOT_DOMAIN:-}"
NGINX_EMAIL="${SNAPSHOT_CERTBOT_EMAIL:-}"
NGINX_TLS="" # http | certbot | self-signed | custom
NGINX_CERT="${SNAPSHOT_SSL_CERT:-}"
NGINX_KEY="${SNAPSHOT_SSL_KEY:-}"
VALIDATE_DOMAIN_LIB="${ROOT}/deploy/lib/validate-domain.sh"

cd "${ROOT}"

# shellcheck source=deploy/lib/validate-domain.sh
source "${VALIDATE_DOMAIN_LIB}"

usage() {
  cat <<'EOF'
Snapshot VM deploy

  ./deploy/vm-deploy.sh                  Install, build, enable systemd
  ./deploy/vm-deploy.sh --nginx --domain NAME --http
                                         Same + nginx HTTP front on port 80
  ./deploy/vm-deploy.sh --nginx --domain NAME [--certbot --email E | --self-signed]
                                         Same + nginx HTTPS vhost (keeps other sites)
  ./deploy/vm-deploy.sh --build-only
  ./deploy/vm-deploy.sh --start | --stop | --status
  ./deploy/vm-deploy.sh --foreground
  ./deploy/vm-deploy.sh --public
                                         Bind 0.0.0.0 (requires SNAPSHOT_API_TOKEN)
  ./deploy/vm-deploy.sh --uninstall-service
  ./deploy/nginx-setup.sh ...            nginx-only (see that script --help)

Environment:
  PORT / SNAPSHOT_PORT     App listen port (default 8787)
  HOST / SNAPSHOT_HOST     Bind address (default 127.0.0.1; --public uses 0.0.0.0)
  SNAPSHOT_API_TOKEN       Optional API token (required with --public)
  SNAPSHOT_MAX_QUEUE       Max pending capture jobs (default 8)
  SNAPSHOT_DATA_DIR        Job data directory (default <repo>/data)
  SNAPSHOT_WEB_DIST        Built UI path
  SNAPSHOT_CORS_ORIGINS    CORS origins or *
  SNAPSHOT_DOMAIN          Hostname for nginx vhost
  SNAPSHOT_CERTBOT_EMAIL   Let's Encrypt email
  SNAPSHOT_NODE_MIN_MAJOR  Required Node major (default 20)
  SNAPSHOT_SKIP_NODE_INSTALL=1  Fail instead of auto-installing Node
EOF
}

needs_node() {
  case "${ACTION}" in
    build-only|deploy|foreground) return 0 ;;
    *) return 1 ;;
  esac
}

ACTION="deploy"
ARGS=("$@")
i=0
while [[ $i -lt ${#ARGS[@]} ]]; do
  a="${ARGS[$i]}"
  case "${a}" in
    -h|--help) usage; exit 0 ;;
    --build-only) ACTION=build-only ;;
    --start) ACTION=start ;;
    --stop) ACTION=stop ;;
    --status) ACTION=status ;;
    --foreground) ACTION=foreground ;;
    --public) PUBLIC_BIND=1 ;;
    --uninstall-service) ACTION=uninstall-service ;;
    --deploy) ACTION=deploy ;;
    --nginx) WITH_NGINX=1 ;;
    --domain)
      i=$((i + 1))
      NGINX_DOMAIN="${ARGS[$i]:-}"
      WITH_NGINX=1
      ;;
    --email)
      i=$((i + 1))
      NGINX_EMAIL="${ARGS[$i]:-}"
      ;;
    --http) NGINX_TLS=http; WITH_NGINX=1 ;;
    --certbot) NGINX_TLS=certbot; WITH_NGINX=1 ;;
    --self-signed) NGINX_TLS=self-signed; WITH_NGINX=1 ;;
    --cert)
      i=$((i + 1))
      NGINX_CERT="${ARGS[$i]:-}"
      NGINX_TLS=custom
      WITH_NGINX=1
      ;;
    --key)
      i=$((i + 1))
      NGINX_KEY="${ARGS[$i]:-}"
      NGINX_TLS=custom
      WITH_NGINX=1
      ;;
    *)
      printf 'error: unknown option: %s\n' "${a}" >&2
      usage
      exit 1
      ;;
  esac
  i=$((i + 1))
done

if [[ "${PUBLIC_BIND}" -eq 1 ]] && [[ -z "${SNAPSHOT_API_TOKEN:-}" ]]; then
  die "--public requires SNAPSHOT_API_TOKEN (e.g. export SNAPSHOT_API_TOKEN=\$(openssl rand -hex 32))"
fi

if [[ -z "${HOST}" ]]; then
  if [[ "${PUBLIC_BIND}" -eq 1 ]]; then
    HOST="0.0.0.0"
  else
    HOST="127.0.0.1"
  fi
fi

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

setup_node() {
  [[ -f "${ENSURE_NODE_LIB}" ]] || die "missing ${ENSURE_NODE_LIB}"
  export SNAPSHOT_NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-20}"
  # shellcheck source=deploy/lib/ensure-node.sh
  source "${ENSURE_NODE_LIB}"
  ensure_node
}

ensure_pnpm() {
  if have pnpm; then
    log "pnpm $(pnpm -v) OK"
    return
  fi
  log "Enabling pnpm via corepack"
  if have corepack; then
    corepack enable
    corepack prepare pnpm@9.15.9 --activate
  else
    die "pnpm not found and corepack unavailable. Install pnpm: npm install -g pnpm"
  fi
}

install_os_deps() {
  if [[ "${SNAPSHOT_SKIP_APT:-}" == "1" ]]; then
    log "Skipping OS deps (SNAPSHOT_SKIP_APT=1)"
    return
  fi
  if ! have apt-get; then
    warn "apt-get not found — install Playwright OS libraries manually if Chromium fails to launch"
    return
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    log "Installing Playwright Chromium OS dependencies (apt)"
    pnpm --filter @snapshot/replay exec playwright install-deps chromium || \
      warn "playwright install-deps failed; you may need to run it with sudo later"
  elif have sudo; then
    log "Installing Playwright Chromium OS dependencies (sudo apt)"
    sudo pnpm --filter @snapshot/replay exec playwright install-deps chromium || \
      warn "playwright install-deps failed"
  else
    warn "No sudo — skip OS deps. If capture fails, run: pnpm --filter @snapshot/replay exec playwright install-deps chromium"
  fi
}

build_app() {
  log "pnpm install"
  pnpm install --frozen-lockfile

  log "Install Playwright Chromium browser"
  pnpm --filter @snapshot/replay exec playwright install chromium

  install_os_deps

  log "Building packages + web UI"
  pnpm --filter @snapshot/core build
  pnpm --filter @snapshot/replay build
  pnpm --filter @snapshot/server build
  pnpm --filter @snapshot/web build

  mkdir -p "${DATA_DIR}/jobs"
  log "Build complete"
}

write_env_file() {
  local env_path="${ROOT}/deploy/snapshot.env"
  local bind_host="${HOST}"
  local cors="${SNAPSHOT_CORS_ORIGINS:-*}"
  if [[ "${WITH_NGINX}" -eq 1 ]]; then
    bind_host="127.0.0.1"
    if [[ -n "${NGINX_DOMAIN}" ]]; then
      if [[ "${NGINX_TLS}" == "http" ]]; then
        cors="http://${NGINX_DOMAIN}"
      else
        cors="https://${NGINX_DOMAIN}"
      fi
    fi
  fi
  cat > "${env_path}" <<EOF
# Generated by vm-deploy.sh — sourced by systemd unit
PORT=${PORT}
HOST=${bind_host}
NODE_ENV=production
SNAPSHOT_DATA_DIR=${DATA_DIR}
SNAPSHOT_WEB_DIST=${WEB_DIST}
SNAPSHOT_CORS_ORIGINS=${cors}
SNAPSHOT_API_TOKEN=${SNAPSHOT_API_TOKEN:-}
SNAPSHOT_MAX_QUEUE=${SNAPSHOT_MAX_QUEUE:-8}
EOF
  log "Wrote ${env_path} (HOST=${bind_host})"
}

install_systemd() {
  if ! have systemctl; then
    warn "systemctl not available — use: ./deploy/vm-deploy.sh --foreground"
    return 1
  fi

  write_env_file

  local unit_dest="/etc/systemd/system/${SERVICE_NAME}.service"
  local tmp
  tmp="$(mktemp)"
  sed \
    -e "s|@ROOT@|${ROOT}|g" \
    -e "s|@PORT@|${PORT}|g" \
    -e "s|@USER@|$(id -un)|g" \
    -e "s|@GROUP@|$(id -gn)|g" \
    -e "s|@NODE@|$(command -v node)|g" \
    "${SERVICE_FILE}" > "${tmp}"

  log "Installing systemd unit ${unit_dest}"
  if [[ "$(id -u)" -eq 0 ]]; then
    cp "${tmp}" "${unit_dest}"
    systemctl daemon-reload
    systemctl enable --now "${SERVICE_NAME}.service"
  elif have sudo; then
    sudo cp "${tmp}" "${unit_dest}"
    sudo systemctl daemon-reload
    sudo systemctl enable --now "${SERVICE_NAME}.service"
  else
    rm -f "${tmp}"
    die "Need root or sudo to install systemd unit"
  fi
  rm -f "${tmp}"
  log "Service ${SERVICE_NAME} enabled and started"
  return 0
}

setup_nginx() {
  [[ "${WITH_NGINX}" -eq 1 ]] || return 0
  [[ -n "${NGINX_DOMAIN}" ]] || die "--nginx requires --domain <hostname>"
  if declare -f validate_domain >/dev/null 2>&1; then
    validate_domain "${NGINX_DOMAIN}" || die "invalid domain: ${NGINX_DOMAIN}"
  fi

  local args=(--domain "${NGINX_DOMAIN}")
  case "${NGINX_TLS}" in
    http)
      args+=(--http)
      ;;
    certbot)
      [[ -n "${NGINX_EMAIL}" ]] || die "--certbot requires --email"
      args+=(--certbot --email "${NGINX_EMAIL}")
      ;;
    custom)
      [[ -n "${NGINX_CERT}" && -n "${NGINX_KEY}" ]] || die "--cert and --key required"
      args+=(--cert "${NGINX_CERT}" --key "${NGINX_KEY}")
      ;;
    self-signed|"")
      args+=(--self-signed)
      ;;
    *)
      die "unknown nginx mode: ${NGINX_TLS}"
      ;;
  esac
  args+=(--upstream "127.0.0.1:${PORT}")

  chmod +x "${ROOT}/deploy/nginx-setup.sh"
  if [[ "${NGINX_TLS}" == "http" ]]; then
    log "Configuring nginx HTTP front for ${NGINX_DOMAIN} (existing sites untouched)"
  else
    log "Configuring nginx HTTPS front for ${NGINX_DOMAIN} (existing sites untouched)"
  fi
  "${ROOT}/deploy/nginx-setup.sh" "${args[@]}"
}

cmd_start() {
  if have systemctl && systemctl cat "${SERVICE_NAME}.service" &>/dev/null; then
    sudo systemctl start "${SERVICE_NAME}.service"
    systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  else
    warn "No systemd unit installed. Run without --start, or use --foreground"
    return 1
  fi
}

cmd_stop() {
  if have systemctl && systemctl cat "${SERVICE_NAME}.service" &>/dev/null; then
    sudo systemctl stop "${SERVICE_NAME}.service"
  else
    warn "No systemd unit to stop"
  fi
}

cmd_status() {
  if have systemctl && systemctl cat "${SERVICE_NAME}.service" &>/dev/null; then
    systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  fi
  echo
  curl -sf "http://127.0.0.1:${PORT}/api/health" && echo " app health: ok" || echo "app health: unreachable"
  local d="${NGINX_DOMAIN:-${SNAPSHOT_DOMAIN:-}}"
  if [[ -n "${d}" ]]; then
    if [[ "${NGINX_TLS}" == "http" ]]; then
      curl -sf "http://${d}/api/health" && echo " nginx http health: ok" || echo "nginx http health: unreachable"
    else
      curl -skf "https://${d}/api/health" && echo " nginx https health: ok" || echo "nginx https health: unreachable"
    fi
  fi
}

cmd_foreground() {
  write_env_file
  set -a
  # shellcheck source=/dev/null
  source "${ROOT}/deploy/snapshot.env"
  set +a
  log "Listening on ${HOST:-0.0.0.0}:${PORT} (Ctrl+C to stop)"
  exec pnpm --filter @snapshot/server start
}

cmd_uninstall_service() {
  if ! have systemctl; then
    return 0
  fi
  if systemctl cat "${SERVICE_NAME}.service" &>/dev/null; then
    sudo systemctl disable --now "${SERVICE_NAME}.service" || true
    sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    sudo systemctl daemon-reload
    log "Removed ${SERVICE_NAME}.service"
  fi
}

if needs_node; then
  setup_node
  ensure_pnpm
fi

case "${ACTION}" in
  build-only) build_app ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  foreground)
    if [[ ! -f "${ROOT}/apps/server/dist/index.js" ]]; then
      build_app
    fi
    cmd_foreground
    ;;
  uninstall-service) cmd_uninstall_service ;;
  deploy)
    build_app
    if install_systemd; then
      setup_nginx
      echo
      if [[ "${WITH_NGINX}" -eq 1 ]]; then
        if [[ "${NGINX_TLS}" == "http" ]]; then
          echo "UI + API (HTTP):   http://${NGINX_DOMAIN}/"
          echo "Health:            http://${NGINX_DOMAIN}/api/health"
        else
          echo "UI + API (HTTPS):  https://${NGINX_DOMAIN}/"
          echo "Health:            https://${NGINX_DOMAIN}/api/health"
        fi
        echo "App (localhost):   http://127.0.0.1:${PORT}/api/health"
      else
        echo "UI + API:  http://localhost:${PORT}"
        echo "Health:    http://localhost:${PORT}/api/health"
        echo "Tip: add nginx with:"
        echo "  ./deploy/nginx-setup.sh --domain snapshot.example.com --http"
        echo "  ./deploy/nginx-setup.sh --domain snapshot.example.com --certbot --email you@example.com"
      fi
      echo "Status:    ./deploy/vm-deploy.sh --status"
      echo "Logs:      journalctl -u ${SERVICE_NAME} -f"
    else
      echo
      echo "Build OK. Start manually:"
      echo "  ./deploy/vm-deploy.sh --foreground"
    fi
    ;;
  *)
    echo "unknown action: ${ACTION}" >&2
    usage
    exit 1
    ;;
esac

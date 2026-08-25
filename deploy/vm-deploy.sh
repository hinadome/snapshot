#!/usr/bin/env bash
# Deploy Snapshot on a Linux VM (install deps, build, run via systemd or foreground).
#
# Usage (from monorepo root, as a user that can write the repo + optionally sudo):
#   ./deploy/vm-deploy.sh
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
HOST="${HOST:-${SNAPSHOT_HOST:-0.0.0.0}}"
NODE_MIN_MAJOR=20

# Optional nginx front (HTTPS) — additive site only
WITH_NGINX=0
NGINX_DOMAIN="${SNAPSHOT_DOMAIN:-}"
NGINX_EMAIL="${SNAPSHOT_CERTBOT_EMAIL:-}"
NGINX_TLS="" # certbot | self-signed | custom
NGINX_CERT="${SNAPSHOT_SSL_CERT:-}"
NGINX_KEY="${SNAPSHOT_SSL_KEY:-}"

cd "${ROOT}"

usage() {
  cat <<'EOF'
Snapshot VM deploy

  ./deploy/vm-deploy.sh                  Install, build, enable systemd
  ./deploy/vm-deploy.sh --nginx --domain NAME [--certbot --email E | --self-signed]
                                         Same + add nginx HTTPS vhost (keeps other sites)
  ./deploy/vm-deploy.sh --build-only
  ./deploy/vm-deploy.sh --start | --stop | --status
  ./deploy/vm-deploy.sh --foreground
  ./deploy/vm-deploy.sh --uninstall-service
  ./deploy/nginx-setup.sh ...            nginx-only (see that script --help)

Environment:
  PORT / SNAPSHOT_PORT     App listen port (default 8787)
  HOST / SNAPSHOT_HOST     Bind address (default 0.0.0.0; nginx sets 127.0.0.1)
  SNAPSHOT_DATA_DIR        Job data directory (default <repo>/data)
  SNAPSHOT_WEB_DIST        Built UI path
  SNAPSHOT_CORS_ORIGINS    CORS origins or *
  SNAPSHOT_DOMAIN          Hostname for nginx vhost
  SNAPSHOT_CERTBOT_EMAIL   Let's Encrypt email
EOF
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

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

ensure_node() {
  if have node; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if (( major >= NODE_MIN_MAJOR )); then
      log "Node $(node -v) OK"
      return
    fi
    warn "Node $(node -v) is older than ${NODE_MIN_MAJOR}; continuing anyway may fail"
    return
  fi
  die "Node.js >= ${NODE_MIN_MAJOR} is required. Install from https://nodejs.org/ or your package manager."
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
      cors="https://${NGINX_DOMAIN}"
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

  local args=(--domain "${NGINX_DOMAIN}")
  case "${NGINX_TLS}" in
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
      die "unknown TLS mode: ${NGINX_TLS}"
      ;;
  esac
  args+=(--upstream "127.0.0.1:${PORT}")

  chmod +x "${ROOT}/deploy/nginx-setup.sh"
  log "Configuring nginx HTTPS front for ${NGINX_DOMAIN} (existing sites untouched)"
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
    curl -skf "https://${d}/api/health" && echo " nginx https health: ok" || echo "nginx https health: unreachable"
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

ensure_node
ensure_pnpm

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
        echo "UI + API (HTTPS):  https://${NGINX_DOMAIN}/"
        echo "Health:            https://${NGINX_DOMAIN}/api/health"
        echo "App (localhost):   http://127.0.0.1:${PORT}/api/health"
      else
        echo "UI + API:  http://localhost:${PORT}"
        echo "Health:    http://localhost:${PORT}/api/health"
        echo "Tip: add HTTPS with:"
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

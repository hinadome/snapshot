#!/usr/bin/env bash
# Deploy Snapshot as Docker containers (parity with VM HTTPS options).
#
# Modes:
#   default        Publish app on host port (HTTP) — fine for lab/VPN
#   --host-nginx   Publish 127.0.0.1 only + configure *host* nginx (keeps existing sites)
#   --nginx        Docker nginx sidecar on 80/443 (use when host has no nginx)
#
# Usage:
#   ./deploy/container-deploy.sh
#   ./deploy/container-deploy.sh --host-nginx --domain snapshot.example.com --certbot --email ops@example.com
#   ./deploy/container-deploy.sh --nginx --domain snapshot.example.com --self-signed
#   ./deploy/container-deploy.sh --down
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_BASE="${ROOT}/deploy/docker-compose.yml"
COMPOSE_NGINX_STACK="${ROOT}/deploy/docker-compose.nginx.yml"
IMAGE="${SNAPSHOT_IMAGE:-snapshot:latest}"
PORT="${SNAPSHOT_PORT:-8787}"
BIND="${SNAPSHOT_BIND:-0.0.0.0}"
MEM_LIMIT="${SNAPSHOT_MEM_LIMIT:-2g}"

MODE=simple # simple | host-nginx | docker-nginx
DOMAIN="${SNAPSHOT_DOMAIN:-}"
EMAIL="${SNAPSHOT_CERTBOT_EMAIL:-}"
TLS_MODE="" # certbot | self-signed | custom
SSL_CERT="${SNAPSHOT_SSL_CERT:-}"
SSL_KEY="${SNAPSHOT_SSL_KEY:-}"

cd "${ROOT}"

usage() {
  cat <<'EOF'
Snapshot container deploy

  ./deploy/container-deploy.sh
      Build + start app (HTTP on SNAPSHOT_PORT, default 8787)

  ./deploy/container-deploy.sh --host-nginx --domain NAME [--certbot --email E | --self-signed]
      Recommended on a VM that already runs nginx:
      - App published only on 127.0.0.1:8787
      - Host nginx vhost + HTTPS via deploy/nginx-setup.sh (other sites untouched)

  ./deploy/container-deploy.sh --nginx --domain NAME [--self-signed | --cert/--key]
      Self-contained Docker nginx sidecar (host ports 80/443).
      Do NOT use this if the VM already uses host nginx on 80/443.

  ./deploy/container-deploy.sh --build-only | --up | --down | --logs | --status

Environment:
  SNAPSHOT_PORT           Host app port for simple/host-nginx (default 8787)
  SNAPSHOT_BIND           Bind address (default 0.0.0.0; host-nginx forces 127.0.0.1)
  SNAPSHOT_CORS_ORIGINS   CORS allow-list or *
  SNAPSHOT_IMAGE          Image tag (default snapshot:latest)
  SNAPSHOT_MEM_LIMIT      App container memory (default 2g)
  SNAPSHOT_HTTP_PORT      Docker-nginx host HTTP port (default 80)
  SNAPSHOT_HTTPS_PORT     Docker-nginx host HTTPS port (default 443)
EOF
}

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

ARGS=("$@")
i=0
ACTION=deploy
while [[ $i -lt ${#ARGS[@]} ]]; do
  a="${ARGS[$i]}"
  case "${a}" in
    -h|--help) usage; exit 0 ;;
    --build-only) ACTION=build-only ;;
    --up) ACTION=up ;;
    --down) ACTION=down ;;
    --logs) ACTION=logs ;;
    --status) ACTION=status ;;
    --deploy) ACTION=deploy ;;
    --host-nginx) MODE=host-nginx ;;
    --nginx) MODE=docker-nginx ;;
    --domain)
      i=$((i + 1))
      DOMAIN="${ARGS[$i]:-}"
      ;;
    --email)
      i=$((i + 1))
      EMAIL="${ARGS[$i]:-}"
      ;;
    --certbot) TLS_MODE=certbot ;;
    --self-signed) TLS_MODE=self-signed ;;
    --cert)
      i=$((i + 1))
      SSL_CERT="${ARGS[$i]:-}"
      TLS_MODE=custom
      ;;
    --key)
      i=$((i + 1))
      SSL_KEY="${ARGS[$i]:-}"
      TLS_MODE=custom
      ;;
    *)
      die "unknown option: ${a} (see --help)"
      ;;
  esac
  i=$((i + 1))
done

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    die "docker is required"
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_BIN=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_BIN=(docker-compose)
  else
    die "docker compose plugin or docker-compose is required"
  fi
}

compose_env() {
  export SNAPSHOT_PORT="${PORT}"
  export SNAPSHOT_BIND="${BIND}"
  export SNAPSHOT_IMAGE="${IMAGE}"
  export SNAPSHOT_MEM_LIMIT="${MEM_LIMIT}"
  export SNAPSHOT_CORS_ORIGINS="${SNAPSHOT_CORS_ORIGINS:-*}"
  if [[ -n "${DOMAIN}" && "${SNAPSHOT_CORS_ORIGINS:-*}" == "*" ]]; then
    export SNAPSHOT_CORS_ORIGINS="https://${DOMAIN}"
  fi
}

compose() {
  compose_env
  if [[ "${MODE}" == "docker-nginx" ]]; then
    "${COMPOSE_BIN[@]}" -f "${COMPOSE_NGINX_STACK}" "$@"
  else
    "${COMPOSE_BIN[@]}" -f "${COMPOSE_BASE}" "$@"
  fi
}

prepare_docker_nginx_tls() {
  local conf_dir="${ROOT}/deploy/nginx/docker"
  local cert_dir="${conf_dir}/certs"
  local template="${conf_dir}/default.conf.template"
  mkdir -p "${cert_dir}"

  [[ -n "${DOMAIN}" ]] || die "--nginx requires --domain"
  [[ -f "${template}" ]] || die "missing ${template}"

  case "${TLS_MODE}" in
    custom)
      [[ -n "${SSL_CERT}" && -n "${SSL_KEY}" ]] || die "--cert and --key required"
      [[ -f "${SSL_CERT}" ]] || die "cert not found: ${SSL_CERT}"
      [[ -f "${SSL_KEY}" ]] || die "key not found: ${SSL_KEY}"
      cp "${SSL_CERT}" "${cert_dir}/fullchain.pem"
      cp "${SSL_KEY}" "${cert_dir}/privkey.pem"
      ;;
    certbot)
      die "Let's Encrypt inside Docker sidecar is not automated here. Use --host-nginx --certbot (host nginx), or --self-signed / --cert/--key for --nginx"
      ;;
    self-signed|"")
      TLS_MODE=self-signed
      if [[ ! -f "${cert_dir}/fullchain.pem" || ! -f "${cert_dir}/privkey.pem" ]]; then
        log "Generating self-signed cert for ${DOMAIN}"
        if ! openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
          -keyout "${cert_dir}/privkey.pem" \
          -out "${cert_dir}/fullchain.pem" \
          -subj "/CN=${DOMAIN}" \
          -addext "subjectAltName=DNS:${DOMAIN}" 2>/dev/null; then
          openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
            -keyout "${cert_dir}/privkey.pem" \
            -out "${cert_dir}/fullchain.pem" \
            -subj "/CN=${DOMAIN}"
        fi
      else
        log "Reusing ${cert_dir}/fullchain.pem"
      fi
      ;;
    *)
      die "unknown TLS mode: ${TLS_MODE}"
      ;;
  esac

  sed -e "s|__SERVER_NAME__|${DOMAIN}|g" "${template}" > "${conf_dir}/default.conf"
  log "Wrote ${conf_dir}/default.conf"
}

setup_host_nginx() {
  [[ -n "${DOMAIN}" ]] || die "--host-nginx requires --domain"
  local args=(--domain "${DOMAIN}" --upstream "127.0.0.1:${PORT}" --skip-bind)
  case "${TLS_MODE}" in
    certbot)
      [[ -n "${EMAIL}" ]] || die "--certbot requires --email"
      args+=(--certbot --email "${EMAIL}")
      ;;
    custom)
      [[ -n "${SSL_CERT}" && -n "${SSL_KEY}" ]] || die "--cert and --key required"
      args+=(--cert "${SSL_CERT}" --key "${SSL_KEY}")
      ;;
    self-signed|"")
      args+=(--self-signed)
      ;;
    *)
      die "unknown TLS mode: ${TLS_MODE}"
      ;;
  esac
  chmod +x "${ROOT}/deploy/nginx-setup.sh"
  log "Configuring host nginx for ${DOMAIN} (existing sites untouched)"
  "${ROOT}/deploy/nginx-setup.sh" "${args[@]}"
}

cmd_build() {
  log "Building ${IMAGE}"
  compose build
  docker tag snapshot:latest "${IMAGE}" 2>/dev/null || true
}

cmd_up() {
  if [[ "${MODE}" == "docker-nginx" ]]; then
    prepare_docker_nginx_tls
    log "Starting Snapshot + Docker nginx (HTTPS)"
    compose up -d
    echo
    echo "UI + API (HTTPS):  https://${DOMAIN}/"
    echo "Health:            https://${DOMAIN}/api/health"
    echo "Note: host ports 80/443 — do not combine with an existing host nginx on the same ports"
  elif [[ "${MODE}" == "host-nginx" ]]; then
    BIND=127.0.0.1
    log "Starting Snapshot published on 127.0.0.1:${PORT} only"
    compose up -d
    setup_host_nginx
    echo
    echo "UI + API (HTTPS):  https://${DOMAIN}/"
    echo "Health:            https://${DOMAIN}/api/health"
    echo "App (localhost):   http://127.0.0.1:${PORT}/api/health"
  else
    log "Starting Snapshot on ${BIND}:${PORT}"
    compose up -d
    echo
    echo "UI + API:  http://localhost:${PORT}"
    echo "Health:    http://localhost:${PORT}/api/health"
    echo "Tip (VM with existing nginx):"
    echo "  ./deploy/container-deploy.sh --host-nginx --domain snapshot.example.com --certbot --email you@example.com"
  fi
  echo "Logs:      ./deploy/container-deploy.sh --logs"
  echo "Data volume: snapshot-data"
}

cmd_down() {
  log "Stopping Snapshot containers"
  # Tear down whichever stack may be running
  compose_env
  "${COMPOSE_BIN[@]}" -f "${COMPOSE_BASE}" down 2>/dev/null || true
  "${COMPOSE_BIN[@]}" -f "${COMPOSE_NGINX_STACK}" down 2>/dev/null || true
}

cmd_logs() {
  if [[ "${MODE}" == "docker-nginx" ]]; then
    compose logs -f
  else
    compose logs -f snapshot
  fi
}

cmd_status() {
  compose ps
  echo
  if [[ "${MODE}" == "docker-nginx" || (-n "${DOMAIN}" && "${MODE}" == "host-nginx") ]]; then
    local d="${DOMAIN}"
    if [[ -n "${d}" ]]; then
      curl -skf "https://${d}/api/health" && echo " https health: ok" || echo "https health: unreachable"
    fi
  fi
  curl -sf "http://127.0.0.1:${PORT}/api/health" && echo " app health: ok" || echo "app health: unreachable (expected if using docker-nginx without host publish)"
}

need_docker

# Infer stack for status/logs/down when flags omitted
if [[ "${MODE}" == "simple" ]]; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'snapshot-nginx'; then
    MODE=docker-nginx
  elif [[ -n "${DOMAIN}" ]] || [[ "${BIND}" == "127.0.0.1" ]]; then
    : # keep simple/host-nginx publish mode
  fi
fi

# host-nginx forces localhost bind
if [[ "${MODE}" == "host-nginx" ]]; then
  BIND=127.0.0.1
fi

case "${ACTION}" in
  build-only) cmd_build ;;
  up) cmd_up ;;
  down) cmd_down ;;
  logs) cmd_logs ;;
  status) cmd_status ;;
  deploy)
    cmd_build
    cmd_up
    ;;
  *)
    die "unknown action: ${ACTION}"
    ;;
esac

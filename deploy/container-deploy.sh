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
COMPOSE_NGINX_HTTP_STACK="${ROOT}/deploy/docker-compose.nginx-http.yml"
IMAGE="${SNAPSHOT_IMAGE:-snapshot:latest}"
PORT="${SNAPSHOT_PORT:-8787}"
BIND="${SNAPSHOT_BIND:-127.0.0.1}"
PUBLIC_BIND=0
MEM_LIMIT="${SNAPSHOT_MEM_LIMIT:-2g}"

MODE=simple # simple | host-nginx | docker-nginx
DOMAIN="${SNAPSHOT_DOMAIN:-}"
EMAIL="${SNAPSHOT_CERTBOT_EMAIL:-}"
TLS_MODE="" # http | certbot | self-signed | custom
SSL_CERT="${SNAPSHOT_SSL_CERT:-}"
SSL_KEY="${SNAPSHOT_SSL_KEY:-}"

VALIDATE_DOMAIN_LIB="${ROOT}/deploy/lib/validate-domain.sh"

cd "${ROOT}"

# shellcheck source=deploy/lib/validate-domain.sh
source "${VALIDATE_DOMAIN_LIB}"

require_valid_domain() {
  [[ -n "${DOMAIN}" ]] || die "--domain is required"
  validate_domain "${DOMAIN}" || die "invalid domain: ${DOMAIN}"
}

usage() {
  cat <<'EOF'
Snapshot container deploy

  ./deploy/container-deploy.sh
      Build + start app on 127.0.0.1:SNAPSHOT_PORT (default 8787)

  ./deploy/container-deploy.sh --public
      Publish on 0.0.0.0 (exposes API on the network — use with SNAPSHOT_API_TOKEN)

  ./deploy/container-deploy.sh --host-nginx --domain NAME --http
      Host nginx HTTP only (port 80); app on 127.0.0.1:8787

  ./deploy/container-deploy.sh --host-nginx --domain NAME [--certbot --email E | --self-signed]
      Recommended on a VM that already runs nginx:
      - App published only on 127.0.0.1:8787
      - Host nginx vhost + HTTPS via deploy/nginx-setup.sh (other sites untouched)

  ./deploy/container-deploy.sh --nginx --domain NAME --http
      Docker nginx HTTP sidecar (host port 80 only)

  ./deploy/container-deploy.sh --nginx --domain NAME [--self-signed | --cert/--key]
      Self-contained Docker nginx sidecar (host ports 80/443).
      Do NOT use this if the VM already uses host nginx on 80/443.

  ./deploy/container-deploy.sh --build-only | --up | --down | --logs | --status

Environment:
  SNAPSHOT_PORT           Host app port for simple/host-nginx (default 8787)
  SNAPSHOT_BIND           Host bind (default 127.0.0.1; --public uses 0.0.0.0)
  SNAPSHOT_API_TOKEN      Optional API bearer token (recommended with --public)
  SNAPSHOT_MAX_QUEUE      Max pending capture jobs (default 8)
  SNAPSHOT_CORS_ORIGINS   API CORS allow-list (browser→Snapshot REST) or *
                          (not HAR-replay CORS — use UI Enforce CORS / enforceCors)
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
    --public) PUBLIC_BIND=1 ;;
    --host-nginx) MODE=host-nginx ;;
    --nginx) MODE=docker-nginx ;;
    --http) TLS_MODE=http ;;
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

require_public_token() {
  if [[ "${PUBLIC_BIND}" -eq 1 ]] && [[ -z "${SNAPSHOT_API_TOKEN:-}" ]]; then
    die "--public requires SNAPSHOT_API_TOKEN (e.g. export SNAPSHOT_API_TOKEN=\$(openssl rand -hex 32))"
  fi
}

compose_env() {
  if [[ "${PUBLIC_BIND}" -eq 1 ]]; then
    BIND="0.0.0.0"
  elif [[ "${MODE}" == "host-nginx" ]]; then
    BIND="127.0.0.1"
  fi
  export SNAPSHOT_PORT="${PORT}"
  export SNAPSHOT_BIND="${BIND}"
  export SNAPSHOT_IMAGE="${IMAGE}"
  export SNAPSHOT_MEM_LIMIT="${MEM_LIMIT}"
  export SNAPSHOT_CORS_ORIGINS="${SNAPSHOT_CORS_ORIGINS:-}"
  if [[ -n "${DOMAIN}" && -z "${SNAPSHOT_CORS_ORIGINS:-}" ]]; then
    if [[ "${TLS_MODE}" == "http" ]]; then
      export SNAPSHOT_CORS_ORIGINS="http://${DOMAIN}"
    else
      export SNAPSHOT_CORS_ORIGINS="https://${DOMAIN}"
    fi
  fi
}

compose() {
  compose_env
  if [[ "${MODE}" == "docker-nginx" ]]; then
    if [[ "${TLS_MODE}" == "http" ]]; then
      "${COMPOSE_BIN[@]}" -f "${COMPOSE_NGINX_HTTP_STACK}" "$@"
    else
      "${COMPOSE_BIN[@]}" -f "${COMPOSE_NGINX_STACK}" "$@"
    fi
  else
    "${COMPOSE_BIN[@]}" -f "${COMPOSE_BASE}" "$@"
  fi
}

prepare_docker_nginx_tls() {
  require_valid_domain
  local conf_dir="${ROOT}/deploy/nginx/docker"
  local cert_dir="${conf_dir}/certs"
  mkdir -p "${cert_dir}"

  [[ -n "${DOMAIN}" ]] || die "--nginx requires --domain"

  if [[ "${TLS_MODE}" == "http" ]]; then
    local template="${conf_dir}/default-http.conf.template"
    [[ -f "${template}" ]] || die "missing ${template}"
    sed -e "s|__SERVER_NAME__|${DOMAIN}|g" "${template}" > "${conf_dir}/default.conf"
    log "Wrote ${conf_dir}/default.conf (HTTP only)"
    return
  fi

  local template="${conf_dir}/default.conf.template"
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
      die "Let's Encrypt inside Docker sidecar is not automated here. Use --host-nginx --certbot (host nginx), or --http / --self-signed / --cert/--key for --nginx"
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
  require_valid_domain
  local args=(--domain "${DOMAIN}" --upstream "127.0.0.1:${PORT}" --skip-bind)
  case "${TLS_MODE}" in
    http)
      args+=(--http)
      ;;
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
    if [[ "${TLS_MODE}" == "http" ]]; then
      log "Starting Snapshot + Docker nginx (HTTP)"
      compose up -d
      echo
      echo "UI + API (HTTP):   http://${DOMAIN}/"
      echo "Health:            http://${DOMAIN}/api/health"
      echo "Note: host port 80 — do not combine with an existing host nginx on the same port"
    else
      log "Starting Snapshot + Docker nginx (HTTPS)"
      compose up -d
      echo
      echo "UI + API (HTTPS):  https://${DOMAIN}/"
      echo "Health:            https://${DOMAIN}/api/health"
      echo "Note: host ports 80/443 — do not combine with an existing host nginx on the same ports"
    fi
  elif [[ "${MODE}" == "host-nginx" ]]; then
    BIND=127.0.0.1
    log "Starting Snapshot published on 127.0.0.1:${PORT} only"
    compose up -d
    setup_host_nginx
    echo
    if [[ "${TLS_MODE}" == "http" ]]; then
      echo "UI + API (HTTP):   http://${DOMAIN}/"
      echo "Health:            http://${DOMAIN}/api/health"
    else
      echo "UI + API (HTTPS):  https://${DOMAIN}/"
      echo "Health:            https://${DOMAIN}/api/health"
    fi
    echo "App (localhost):   http://127.0.0.1:${PORT}/api/health"
  else
    log "Starting Snapshot on ${BIND}:${PORT}"
    compose up -d
    echo
    echo "UI + API:  http://localhost:${PORT}"
    echo "Health:    http://localhost:${PORT}/api/health"
    echo "Tip (VM with existing nginx):"
    echo "  ./deploy/container-deploy.sh --host-nginx --domain snapshot.example.com --http"
    echo "  ./deploy/container-deploy.sh --host-nginx --domain snapshot.example.com --certbot --email you@example.com"
  fi
  echo "Logs:      ./deploy/container-deploy.sh --logs"
  echo "Data volume: snapshot-data"
}

cmd_down() {
  log "Stopping Snapshot containers"
  compose_env
  "${COMPOSE_BIN[@]}" -f "${COMPOSE_BASE}" down 2>/dev/null || true
  "${COMPOSE_BIN[@]}" -f "${COMPOSE_NGINX_STACK}" down 2>/dev/null || true
  "${COMPOSE_BIN[@]}" -f "${COMPOSE_NGINX_HTTP_STACK}" down 2>/dev/null || true
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
  if [[ -n "${DOMAIN}" ]] && [[ "${MODE}" == "docker-nginx" || "${MODE}" == "host-nginx" ]]; then
    if [[ "${TLS_MODE}" == "http" ]]; then
      curl -sf "http://${DOMAIN}/api/health" && echo " http health: ok" || echo "http health: unreachable"
    else
      curl -skf "https://${DOMAIN}/api/health" && echo " https health: ok" || echo "https health: unreachable"
    fi
  fi
  curl -sf "http://127.0.0.1:${PORT}/api/health" && echo " app health: ok" || echo "app health: unreachable (expected if using docker-nginx without host publish)"
}

need_docker

require_public_token

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

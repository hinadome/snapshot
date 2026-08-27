#!/usr/bin/env bash
# Ensure Node.js >= SNAPSHOT_NODE_MIN_MAJOR (default 20) is installed.
# Sourced by deploy/vm-deploy.sh — not meant to be run directly.
#
# Set SNAPSHOT_SKIP_NODE_INSTALL=1 to require a pre-installed Node instead.

# Always default — parent may use `set -u` and an empty exported value.
SNAPSHOT_NODE_MIN_MAJOR="${SNAPSHOT_NODE_MIN_MAJOR:-20}"
export SNAPSHOT_NODE_MIN_MAJOR

_ensure_node_min() {
  printf '%s' "${SNAPSHOT_NODE_MIN_MAJOR:-20}"
}

_ensure_node_log() { printf '==> %s\n' "$*"; }
_ensure_node_warn() { printf 'warning: %s\n' "$*" >&2; }
_ensure_node_die() { printf 'error: %s\n' "$*" >&2; exit 1; }

_ensure_node_have() { command -v "$1" >/dev/null 2>&1; }

_ensure_node_run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif _ensure_node_have sudo; then
    sudo "$@"
  else
    _ensure_node_die "need root or sudo to install Node.js (or install Node >= $(_ensure_node_min) manually)"
  fi
}

# Print installed Node major version, or empty if node missing.
_ensure_node_major() {
  if ! _ensure_node_have node; then
    return 1
  fi
  node -p 'process.versions.node.split(".")[0]'
}

_ensure_node_ok() {
  local major
  major="$(_ensure_node_major)" || return 1
  (( major >= $(_ensure_node_min) ))
}

_install_node_via_nodesource_apt() {
  local min
  min="$(_ensure_node_min)"
  local setup_url="https://deb.nodesource.com/setup_${min}.x"
  _ensure_node_log "Installing Node.js ${min}.x via NodeSource (apt)"
  _ensure_node_run_root apt-get update -y
  _ensure_node_run_root apt-get install -y ca-certificates curl gnupg
  curl -fsSL "${setup_url}" | _ensure_node_run_root bash -
  _ensure_node_run_root apt-get install -y nodejs
}

_install_node_via_nodesource_rpm() {
  local min
  min="$(_ensure_node_min)"
  local setup_url="https://rpm.nodesource.com/setup_${min}.x"
  _ensure_node_log "Installing Node.js ${min}.x via NodeSource (rpm)"
  _ensure_node_run_root yum install -y curl || _ensure_node_run_root dnf install -y curl
  curl -fsSL "${setup_url}" | _ensure_node_run_root bash -
  if _ensure_node_have dnf; then
    _ensure_node_run_root dnf install -y nodejs
  else
    _ensure_node_run_root yum install -y nodejs
  fi
}

_install_node_via_brew() {
  local min
  min="$(_ensure_node_min)"
  _ensure_node_log "Installing Node.js via Homebrew"
  if ! _ensure_node_have brew; then
    _ensure_node_die "Homebrew not found — install Node ${min}+ from https://nodejs.org/"
  fi
  brew install "node@${min}" || brew install node
  # Prefer versioned prefix when present
  local prefix
  prefix="$(brew --prefix "node@${min}" 2>/dev/null || true)"
  if [[ -n "${prefix}" && -d "${prefix}/bin" ]]; then
    export PATH="${prefix}/bin:${PATH}"
  fi
}

_install_node() {
  local min
  min="$(_ensure_node_min)"
  if [[ "${SNAPSHOT_SKIP_NODE_INSTALL:-}" == "1" ]]; then
    _ensure_node_die "Node.js >= ${min} required (SNAPSHOT_SKIP_NODE_INSTALL=1)"
  fi

  if _ensure_node_have apt-get; then
    _install_node_via_nodesource_apt
  elif _ensure_node_have dnf || _ensure_node_have yum; then
    _install_node_via_nodesource_rpm
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    _install_node_via_brew
  else
    _ensure_node_die "unsupported OS for automatic Node install — install Node >= ${min} manually (https://nodejs.org/)"
  fi

  hash -r 2>/dev/null || true
}

# Public: call from deploy scripts
ensure_node() {
  local min
  min="$(_ensure_node_min)"
  SNAPSHOT_NODE_MIN_MAJOR="${min}"

  if _ensure_node_ok; then
    _ensure_node_log "Node $(node -v) OK (>= ${min})"
    return 0
  fi

  if _ensure_node_have node; then
    _ensure_node_warn "Node $(node -v) is older than ${min}; upgrading"
  else
    _ensure_node_warn "Node.js not found; installing >= ${min}"
  fi

  _install_node

  if ! _ensure_node_ok; then
    _ensure_node_die "Node install finished but version is still insufficient (need >= ${min}, got $(node -v 2>/dev/null || echo none))"
  fi

  _ensure_node_log "Node $(node -v) ready"
}

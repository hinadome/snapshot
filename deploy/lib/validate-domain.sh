#!/usr/bin/env bash
# Validate hostname for nginx server_name (no shell/sed metacharacters).
# Usage: validate_domain "snapshot.example.com" || die "bad domain"

validate_domain() {
  local d="${1:-}"
  [[ -n "${d}" ]] || return 1
  [[ ${#d} -le 253 ]] || return 1
  # Labels: alphanumeric + hyphen; no leading/trailing hyphen per label
  [[ "${d}" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]]
}

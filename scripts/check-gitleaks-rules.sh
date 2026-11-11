#!/usr/bin/env bash
# Checks that named-secret-env-assignment in .gitleaks-custom.toml lets obvious
# placeholders through and still catches a real-looking password. Each sample is
# built here at runtime, so this file holds no value the rules would flag.
#
# Usage: bash scripts/check-gitleaks-rules.sh [path to gitleaks]

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
gitleaks="${1:-${repo_root}/.tools/gitleaks}"
readonly gitleaks
readonly config="${repo_root}/.gitleaks-custom.toml"
readonly rule="named-secret-env-assignment"

[ -x "${gitleaks}" ] || {
  echo "check-gitleaks-rules: gitleaks is not installed. Run: pnpm gitleaks:install" >&2
  exit 1
}

work="$(mktemp -d)"
readonly work
trap 'rm -rf "${work}"' EXIT

# Split so that neither the name nor the scheme appears whole in this file.
readonly name="DATABASE""_URL"
readonly scheme="postgres"
password="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
readonly password

status=0

# scan <file> [rule]: exits 0 when no rule (or only the named one) fires.
scan() {
  local args=(dir "$1" --config "${config}" --gitleaks-ignore-path "${work}"
    --ignore-gitleaks-allow --redact --no-banner --log-level error)
  if [ $# -gt 1 ]; then
    args+=(--enable-rule "$2")
  fi
  "${gitleaks}" "${args[@]}" > /dev/null
}

allowed() {
  local file="${work}/allowed-$((++count)).txt"
  printf '%s\n' "$1" > "${file}"
  if ! scan "${file}"; then
    echo "check-gitleaks-rules: a placeholder was flagged: $1" >&2
    status=1
  fi
}

caught() {
  local file="${work}/caught-$((++count)).txt"
  printf '%s\n' "$1" > "${file}"
  if scan "${file}" "${rule}"; then
    echo "check-gitleaks-rules: ${rule} missed a real-looking value" >&2
    status=1
  fi
}

count=0

allowed "      ${name}: \"placeholder\","
allowed "${name}=placeholder"
allowed "${name}=example"
allowed "${name}=<database-url>"
allowed "${name}=\"\""
allowed "${name}="
allowed "${name}=\${${name}}"
allowed "${name}=${scheme}://app:<password>@db.example.test/app"

caught "${name}=${scheme}://app:${password}@db.example.test/app"
caught "${name}=\"${scheme}://app:${password}@db.example.test/app\""
caught "${name}=placeholder${password}"
caught "${name}=<${password}"

if [ "${status}" -eq 0 ]; then
  echo "check-gitleaks-rules: ${count} samples behave as expected"
fi
exit "${status}"

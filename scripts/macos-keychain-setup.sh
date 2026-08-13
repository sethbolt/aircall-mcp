#!/usr/bin/env bash
set -euo pipefail

SERVICE="aircall-mcp"

read -r -p "Aircall API ID: " API_ID
read -r -s -p "Aircall API token: " API_TOKEN
printf '\n'

if [[ -z "$API_ID" || -z "$API_TOKEN" ]]; then
  echo "Both values are required." >&2
  exit 1
fi

store_secret() {
  local account="$1"
  local value="$2"

  # With -w as the final option, `security` reads the value from stdin rather
  # than exposing it in the process argument list. It asks twice for both new
  # and updated generic-password items.
  if ! printf '%s\n%s\n' "$value" "$value" \
    | security add-generic-password -U -s "$SERVICE" -a "$account" -w \
      >/dev/null 2>&1; then
    echo "Could not store $account in macOS Keychain." >&2
    return 1
  fi
}

store_secret AIRCALL_API_ID "$API_ID"
store_secret AIRCALL_API_TOKEN "$API_TOKEN"

unset API_ID API_TOKEN
echo "Stored Aircall credentials in macOS Keychain service: $SERVICE"

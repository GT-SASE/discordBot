#!/usr/bin/env bash
# Fails if a tracked file outside the Discord client and tests names a Discord
# host, so that only src/discord/client.ts sends to Discord.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

status=0
git grep -nIiE 'discord(app)?\.com|discord\.gg' -- . \
  ':(exclude)src/discord/client.ts' \
  ':(exclude,glob)**/*.test.ts' \
  ':(exclude,glob)**/*.test.tsx' \
  ':(exclude,glob)**/*.test.mts' \
  ':(exclude,glob)**/*.test.cts' \
  ':(exclude,glob)**/*.test.js' \
  ':(exclude,glob)**/*.test.jsx' \
  ':(exclude,glob)**/*.test.mjs' \
  ':(exclude,glob)**/*.test.cjs' || status=$?

case "${status}" in
  0)
    echo "check-discord-urls: only src/discord/client.ts should name a Discord host" >&2
    exit 1
    ;;
  1) ;; # git grep found nothing.
  *)
    echo "check-discord-urls: git grep failed" >&2
    exit "${status}"
    ;;
esac

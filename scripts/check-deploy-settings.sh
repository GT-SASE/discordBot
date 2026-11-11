#!/usr/bin/env bash
# Fails if a setting that decides what a Vercel deployment installs or publishes has
# changed. The deploy check runs this before it builds anything.
#
# Vercel's function build ignores installCommand, so .npmrc is what keeps package
# install scripts away from the project's environment variables. pnpm reads .npmrc as
# npm does, uses the last value in it, and reads other settings there too, such as the
# registry, so the whole file has to match. pnpm's own answer is then checked as well,
# since it is what the install will do. pnpm 10 also runs no dependency's build script
# unless package.json lists it in pnpm.onlyBuiltDependencies, which is empty.
#
# package.json must pin pnpm to one exact version and its hash, which Corepack and
# pnpm/action-setup both read, so every install uses the same pnpm.
#
# A package.json in a subdirectory makes the install run from there, with its own
# scripts and dependencies, and another lockfile, or a workspace file, picks another
# package manager or adds packages. Either would step around these checks and the check
# on the lockfile (pnpm lint:lockfile).
#
# Vercel does run a buildCommand from vercel.json, which could turn install scripts back
# on or run anything else with the project's variables. The project builds without one,
# so vercel.json may not set any command.
#
# Previews hold no secrets, but only main and staging are meant to deploy at all.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

status=0

fail() {
  echo "check-deploy-settings: $1" >&2
  status=1
}

if [ ! -f .npmrc ] || [ "$(cat .npmrc)" != "ignore-scripts=true" ]; then
  fail ".npmrc must hold only the line ignore-scripts=true"
fi

# The pinned pnpm, through Corepack, where pnpm itself is not installed.
if command -v pnpm > /dev/null; then
  pnpm_answer="$(pnpm config get ignore-scripts 2> /dev/null || true)"
else
  pnpm_answer="$(COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm config get ignore-scripts 2> /dev/null || true)"
fi
if [ "${pnpm_answer}" != "true" ]; then
  fail "pnpm config get ignore-scripts must print true"
fi

if ! node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const { packageManager, pnpm } = JSON.parse(readFileSync("package.json", "utf8"));
  const pinned = /^pnpm@[0-9]+\.[0-9]+\.[0-9]+\+sha512\.[0-9a-f]{128}$/;
  const built = pnpm?.onlyBuiltDependencies;
  if (!pinned.test(String(packageManager)) || !Array.isArray(built) || built.length > 0) {
    process.exit(1);
  }
'; then
  fail "package.json must pin pnpm by version and hash, and let no dependency build"
fi

# With -z, git does not quote a path that holds a non-ASCII character.
stray="$(git ls-files -z | tr '\0' '\n' | grep -E '(^|/)(package\.json|package-lock\.json|\.npmrc|\.yarnrc|\.yarnrc\.yml|bunfig\.toml|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|deno\.lock)$' | grep -vxE 'package\.json|pnpm-lock\.yaml|\.npmrc' || true)"
if [ -n "${stray}" ]; then
  fail "only the root may hold install settings, but these are tracked:"
  echo "${stray}" >&2
fi

if ! node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const { git } = JSON.parse(readFileSync("vercel.json", "utf8"));
  const found = JSON.stringify(git?.deploymentEnabled);
  const expected = JSON.stringify({ "**": false, main: true, staging: true });
  if (found !== expected) {
    process.exit(1);
  }
'; then
  fail "vercel.json must deploy main and staging and nothing else"
fi

if ! node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const settings = JSON.parse(readFileSync("vercel.json", "utf8"));
  if (Object.keys(settings).some((name) => /command$/i.test(name))) {
    process.exit(1);
  }
'; then
  fail "vercel.json must not set a command, such as buildCommand"
fi

exit "${status}"

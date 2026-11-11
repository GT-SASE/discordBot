/**
 * Fails if package-lock.json would install anything other than the published package
 * each entry names. Vercel bundles what the lockfile resolves to, and that code sees
 * every runtime secret, so one edited entry must not pass unnoticed.
 *
 * Every entry must resolve to the npm registry over HTTPS, at its own name and exactly
 * its own version's tarball, with a sha512 integrity. npm refuses a tarball that does
 * not match its integrity, so holding the URL to the name and version is enough. An
 * entry this does not recognise, such as a link or a bundled dependency, fails until
 * someone looks at it.
 *
 * Usage: node scripts/check-lockfile.ts
 */

import { readFileSync } from "node:fs";

const REGISTRY = "https://registry.npmjs.org";
// A lockfile key, which may nest. Each name starts with a letter or digit, so that
// "..", which a URL would resolve away, cannot stand in for one.
const PACKAGE_NAME = String.raw`(?:@[a-z0-9][\w.~-]*\/)?[a-zA-Z0-9][\w.~-]*`;
const LOCK_KEY = new RegExp(
  `^node_modules/(?:${PACKAGE_NAME}/node_modules/)*(${PACKAGE_NAME})$`,
);
const LOCK_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function entryProblem(key: string, entry: unknown): string | null {
  const name = LOCK_KEY.exec(key)?.[1];
  if (name === undefined) {
    return "is not a package under node_modules";
  }
  if (!isRecord(entry)) {
    return "is not an object";
  }
  if (entry.link !== undefined) {
    return "is a link";
  }
  if (entry.name !== undefined) {
    return "is an alias";
  }
  const version = entry.version;
  if (typeof version !== "string" || !LOCK_VERSION.test(version)) {
    return "has no exact version";
  }
  const file = `${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
  if (entry.resolved !== `${REGISTRY}/${name}/-/${file}`) {
    return "does not resolve to its own version's file on the registry";
  }
  const integrity = entry.integrity;
  if (typeof integrity !== "string" || !SHA512.test(integrity)) {
    return "has no sha512 integrity";
  }
  return null;
}

/** Why a parsed lockfile would install something other than what it names. */
export function lockfileProblems(lock: unknown): string[] {
  if (!isRecord(lock)) {
    return ["the lockfile is not an object"];
  }
  const problems: string[] = [];
  if (lock.lockfileVersion !== 3) {
    problems.push("lockfileVersion must be 3");
  }
  // Version 3 has only `packages`. Another section would go unchecked.
  if (lock.dependencies !== undefined) {
    problems.push("the old dependencies section is not expected");
  }
  const packages = lock.packages;
  const entries = Object.entries(isRecord(packages) ? packages : {}).filter(
    ([key]) => key !== "",
  );
  if (entries.length === 0) {
    problems.push("no packages are listed");
  }
  for (const [key, entry] of entries) {
    const problem = entryProblem(key, entry);
    if (problem !== null) {
      problems.push(`${key} ${problem}`);
    }
  }
  return problems;
}

function main(): void {
  const lock: unknown = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const problems = lockfileProblems(lock);
  for (const problem of problems) {
    console.error(`package-lock.json: ${problem}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(
    "Checked package-lock.json: every package from the npm registry, at its own name and version, with a sha512 hash.",
  );
}

if (import.meta.main) {
  main();
}

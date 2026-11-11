/**
 * Fails unless pnpm-lock.yaml only ever fetches packages from the registry, each pinned
 * by a sha512 integrity hash.
 *
 * pnpm writes a registry package as `resolution: {integrity: sha512-...}` and fetches it
 * from the registry in .npmrc, which check-deploy-settings.sh holds to npm's default. A
 * package from anywhere else is written another way: a tarball URL, a git repository and
 * commit, or a local directory. Any such resolution fails here, as does a missing or
 * weaker hash. `pnpm install --frozen-lockfile` then checks each download against its
 * hash, so the lockfile cannot be satisfied by other content.
 *
 * Each version the root importer asks for must also be one of those packages. A `link:`
 * or `file:` version points at a folder on the machine running the install, and a version
 * with no package entry has no resolution to check, so both fail.
 *
 * Usage: pnpm lint:lockfile
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const LOCKFILE = join(import.meta.dirname, "..", "pnpm-lock.yaml");

const REGISTRY_RESOLUTION =
  /^ {4}resolution: \{integrity: sha512-[A-Za-z0-9+/]+={0,2}\}$/;

const PACKAGE_KEY = /^ {2}'?([^']+?)'?:$/;
const IMPORTER_DEPENDENCY = /^ {6}'?([^']+?)'?:$/;
const IMPORTER_VERSION = /^ {8}version: '?([^']*?)'?$/;

/**
 * The packages entry an importer's version names. pnpm writes peers after the version in
 * brackets, which the entry's key leaves out, and an alias as the real name and version.
 */
function packageKeyFor(name: string, version: string): string {
  const bare = version.replace(/\(.*$/, "");
  return /^@?[^@]+@./.test(bare) ? bare : `${name}@${bare}`;
}

/** Each problem found, as a line number and what is wrong there. */
export function findLockfileProblems(text: string): string[] {
  const lines = text.split("\n");
  const problems: string[] = [];
  if (lines[0] !== "lockfileVersion: '9.0'") {
    problems.push("1: the lockfile must be version 9.0");
  }
  let section = "";
  let packages = 0;
  let inPackage = false;
  let resolved = true;
  let packageKey = "";
  /** Each package key, and whether it has a registry resolution. */
  const registryPackages = new Map<string, boolean>();
  const wanted: { line: number; key: string }[] = [];
  let dependency = "";
  const finishPackage = (line: number) => {
    if (inPackage) {
      registryPackages.set(packageKey, resolved);
    }
    if (inPackage && !resolved) {
      problems.push(`${String(line)}: a package with no registry resolution`);
    }
  };
  lines.forEach((line, index) => {
    const number = index + 1;
    if (/^[a-zA-Z]/.test(line)) {
      finishPackage(number);
      inPackage = false;
      section = line.replace(/:.*$/, "");
      return;
    }
    if (section === "importers" && /^ {2}\S/.test(line) && line !== "  .:") {
      problems.push(`${String(number)}: only the root may be an importer`);
    }
    if (section === "importers") {
      const name = IMPORTER_DEPENDENCY.exec(line)?.[1];
      if (name !== undefined) {
        dependency = name;
      }
      const version = IMPORTER_VERSION.exec(line)?.[1];
      if (version !== undefined) {
        if (/^(?:link|file):/.test(version)) {
          problems.push(
            `${String(number)}: an importer version from a local path`,
          );
        } else {
          wanted.push({
            line: number,
            key: packageKeyFor(dependency, version),
          });
        }
      }
    }
    if (section !== "packages") {
      if (/\b(?:tarball|repo|directory):/.test(line)) {
        problems.push(`${String(number)}: a package from outside the registry`);
      }
      return;
    }
    if (/^ {2}\S/.test(line)) {
      finishPackage(number);
      inPackage = true;
      resolved = false;
      packageKey = PACKAGE_KEY.exec(line)?.[1] ?? line.trim();
      packages += 1;
      return;
    }
    if (line.startsWith("    resolution:")) {
      if (REGISTRY_RESOLUTION.test(line)) {
        resolved = true;
      } else {
        problems.push(
          `${String(number)}: a resolution other than a registry sha512 hash`,
        );
      }
    }
  });
  finishPackage(lines.length);
  for (const { line, key } of wanted) {
    if (registryPackages.get(key) !== true) {
      problems.push(
        `${String(line)}: an importer version with no registry package by hash`,
      );
    }
  }
  if (packages === 0) {
    problems.push("the lockfile lists no packages");
  }
  return problems;
}

if (import.meta.main) {
  const problems = findLockfileProblems(readFileSync(LOCKFILE, "utf8"));
  for (const problem of problems) {
    console.error(`pnpm-lock.yaml:${problem}`);
  }
  if (problems.length === 0) {
    console.log(
      "pnpm-lock.yaml: every package comes from the registry, by hash.",
    );
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLockfileProblems } from "./check-lockfile.ts";

const HASH = `sha512-${"A".repeat(86)}==`;

function lockfile(
  packages: string,
  importers = "  .:\n    dependencies: {}\n",
) {
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

${importers}
packages:

${packages}
snapshots:

  a@1.0.0: {}
`;
}

describe("findLockfileProblems", () => {
  it("passes registry packages pinned by a sha512 hash", () => {
    expect(
      findLockfileProblems(
        lockfile(`  a@1.0.0:\n    resolution: {integrity: ${HASH}}\n`),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a tarball URL",
      `  a@1.0.0:\n    resolution: {integrity: ${HASH}, tarball: https://example.test/a.tgz}\n`,
    ],
    [
      "a git repository",
      "  a@1.0.0:\n    resolution: {commit: abc, repo: https://example.test/a.git, type: git}\n",
    ],
    [
      "a local directory",
      "  a@1.0.0:\n    resolution: {directory: ../a, type: directory}\n",
    ],
    ["a weaker hash", "  a@1.0.0:\n    resolution: {integrity: sha1-abc=}\n"],
    ["no resolution", "  a@1.0.0:\n    engines: {node: '>=18'}\n"],
  ])("refuses %s", (_name, packages) => {
    expect(findLockfileProblems(lockfile(packages))).not.toEqual([]);
  });

  it.each([
    ["a prerelease version", "a@1.0.0-rc.1"],
    ["a scoped name", "'@s/a@1.0.0'"],
    ["a name with dots and dashes", "a.b-c_d@1.0.0"],
  ])("passes a package key with %s", (_name, key) => {
    expect(
      findLockfileProblems(
        lockfile(`  ${key}:\n    resolution: {integrity: ${HASH}}\n`),
      ),
    ).toEqual([]);
  });

  it.each([
    ["a tarball URL for its version", "a@https://example.test/a-1.0.0.tgz"],
    ["a version range", "a@^1.0.0"],
    ["a dist tag", "a@latest"],
    ["no version", "a"],
    ["a version that walks up the path", "a@1.0.0/../../evil"],
    ["a name that walks up the path", "'../evil@1.0.0'"],
    ["a scope that walks up the path", "'@s/../evil@1.0.0'"],
    ["a git reference", "a@github:o/a#abc"],
  ])(
    "refuses a package key with %s, so its tarball is not its own version's file",
    (_name, key) => {
      expect(
        findLockfileProblems(
          lockfile(`  ${key}:\n    resolution: {integrity: ${HASH}}\n`),
        ),
      ).toEqual([expect.stringContaining("not its own version's file")]);
    },
  );

  const resolvedA = `  a@1.0.0:\n    resolution: {integrity: ${HASH}}\n`;
  const importing = (version: string, name = "a") =>
    `  .:\n    dependencies:\n      ${name}:\n        specifier: 1.0.0\n        version: ${version}\n`;

  it.each([
    ["a plain version", "1.0.0"],
    ["a version with peers", "1.0.0(b@2.0.0)"],
    ["a quoted version", "'1.0.0'"],
  ])(
    "passes an importer whose %s names a registry package",
    (_name, version) => {
      expect(
        findLockfileProblems(lockfile(resolvedA, importing(version))),
      ).toEqual([]);
    },
  );

  it("passes a scoped importer and an alias", () => {
    const packages = `  '@s/a@1.0.0':\n    resolution: {integrity: ${HASH}}\n${resolvedA}`;
    expect(
      findLockfileProblems(lockfile(packages, importing("1.0.0", "'@s/a'"))),
    ).toEqual([]);
    expect(
      findLockfileProblems(lockfile(packages, importing("a@1.0.0", "alias"))),
    ).toEqual([]);
  });

  it.each([
    ["link:/anywhere"],
    ["link:../a"],
    ["file:../a"],
    ["file:a.tgz"],
    ["'link:/anywhere'"],
  ])("refuses an importer version of %s", (version) => {
    expect(
      findLockfileProblems(lockfile(resolvedA, importing(version))),
    ).toEqual([expect.stringContaining("from a local path")]);
  });

  it.each([
    ["no package entry", "2.0.0", resolvedA],
    [
      "a package entry with no integrity hash",
      "1.0.0",
      "  a@1.0.0:\n    engines: {node: '>=18'}\n",
    ],
    [
      "a package entry from a tarball URL",
      "1.0.0",
      `  a@1.0.0:\n    resolution: {integrity: ${HASH}, tarball: https://example.test/a.tgz}\n`,
    ],
  ])("refuses an importer version with %s", (_name, version, packages) => {
    expect(
      findLockfileProblems(lockfile(packages, importing(version))),
    ).toContainEqual(expect.stringContaining("no registry package by hash"));
  });

  it("refuses a second importer, such as a workspace package", () => {
    expect(
      findLockfileProblems(
        lockfile(
          `  a@1.0.0:\n    resolution: {integrity: ${HASH}}\n`,
          "  .:\n    dependencies: {}\n\n  api:\n    dependencies: {}\n",
        ),
      ),
    ).not.toEqual([]);
  });

  it("refuses another lockfile version, and an empty one", () => {
    expect(findLockfileProblems("lockfileVersion: '6.0'\n")).not.toEqual([]);
  });

  it("passes this repo's lockfile", () => {
    const text = readFileSync(
      join(import.meta.dirname, "..", "pnpm-lock.yaml"),
      "utf8",
    );
    expect(findLockfileProblems(text)).toEqual([]);
  });

  it("reads a checkout with CRLF line endings the same way", () => {
    const text = readFileSync(
      join(import.meta.dirname, "..", "pnpm-lock.yaml"),
      "utf8",
    );
    expect(findLockfileProblems(text.replaceAll("\n", "\r\n"))).toEqual([]);
    expect(
      findLockfileProblems(
        lockfile(
          `  a@1.0.0:\n    resolution: {tarball: https://example.test/a.tgz}\n\n`,
        ).replaceAll("\n", "\r\n"),
      ),
    ).not.toEqual([]);
  });
});

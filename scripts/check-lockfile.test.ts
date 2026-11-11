import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lockfileProblems } from "./check-lockfile.ts";

const REGISTRY = "https://registry.npmjs.org";

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  name?: string;
}

describe("lockfile entries", () => {
  const integrity = `sha512-${"A".repeat(86)}==`;
  const key = "node_modules/@scope/pkg";
  const good: LockEntry = {
    version: "1.2.3",
    resolved: `${REGISTRY}/@scope/pkg/-/pkg-1.2.3.tgz`,
    integrity,
  };

  function problemsWith(entryKey: string, entry: LockEntry) {
    return lockfileProblems({
      lockfileVersion: 3,
      packages: { "": {}, [entryKey]: entry },
    });
  }

  it("passes the repository's own lockfile", () => {
    const lock: unknown = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    );

    expect(lockfileProblems(lock)).toEqual([]);
  });

  it.each<[string, string, LockEntry]>([
    ["a scoped package", key, good],
    [
      "a nested package",
      "node_modules/a/node_modules/plain",
      { ...good, resolved: `${REGISTRY}/plain/-/plain-1.2.3.tgz` },
    ],
    [
      "a prerelease",
      "node_modules/plain",
      {
        ...good,
        version: "1.2.3-rc.1",
        resolved: `${REGISTRY}/plain/-/plain-1.2.3-rc.1.tgz`,
      },
    ],
  ])("allows %s", (_label, entryKey, entry) => {
    expect(problemsWith(entryKey, entry)).toEqual([]);
  });

  it.each<[string, LockEntry]>([
    ["another host", { ...good, resolved: "http://127.0.0.1/pkg-1.2.3.tgz" }],
    [
      "plain HTTP to the registry",
      {
        ...good,
        resolved: "http://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz",
      },
    ],
    [
      "a registry lookalike",
      {
        ...good,
        resolved: `${REGISTRY}.example/@scope/pkg/-/pkg-1.2.3.tgz`,
      },
    ],
    [
      "another package's file",
      { ...good, resolved: `${REGISTRY}/evil/-/evil-1.2.3.tgz` },
    ],
    [
      "another version's file",
      { ...good, resolved: `${REGISTRY}/@scope/pkg/-/pkg-1.2.4.tgz` },
    ],
    ["a git source", { ...good, resolved: "git+https://example.test/pkg.git" }],
    ["no resolved URL", { version: "1.2.3", integrity }],
    ["no integrity", { version: "1.2.3", resolved: good.resolved ?? "" }],
    ["a weaker hash", { ...good, integrity: `sha1-${"A".repeat(27)}=` }],
    ["a link", { ...good, link: true }],
    ["an alias", { ...good, name: "evil" }],
    [
      "a version that walks the URL",
      {
        ...good,
        version: "1.2.3/../../evil",
        resolved: `${REGISTRY}/@scope/pkg/-/pkg-1.2.3/../../evil.tgz`,
      },
    ],
  ])("refuses %s", (_label, entry) => {
    expect(problemsWith(key, entry)).toHaveLength(1);
  });

  it.each([
    ["a workspace or link target", "packages/local"],
    ["a name that walks the URL", "node_modules/../evil"],
  ])("refuses %s", (_label, badKey) => {
    expect(problemsWith(badKey, good)).toHaveLength(1);
  });

  it("refuses a lockfile the check would not cover", () => {
    expect(lockfileProblems({ lockfileVersion: 2 })).toHaveLength(2);
    expect(
      lockfileProblems({
        lockfileVersion: 3,
        dependencies: {},
        packages: { [key]: good },
      }),
    ).toHaveLength(1);
    expect(lockfileProblems(null)).toHaveLength(1);
  });
});

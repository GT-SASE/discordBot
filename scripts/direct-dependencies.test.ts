import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Where each package comes from is checked by scripts/check-lockfile.ts, in `pnpm lint:lockfile`.

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function versionsIn(file: object, section: string): string[] {
  const entries: unknown = Reflect.get(file, section);
  if (typeof entries !== "object" || entries === null) {
    throw new Error(`package.json has no ${section} object`);
  }
  return Object.values(entries).map((version: unknown) => {
    if (typeof version !== "string") {
      throw new Error(`package.json has a ${section} version that is not text`);
    }
    return version;
  });
}

describe("direct dependencies", () => {
  it("pins every package to an exact version", () => {
    const file: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (typeof file !== "object" || file === null) {
      throw new Error("package.json does not hold an object");
    }
    const versions = [
      ...versionsIn(file, "dependencies"),
      ...versionsIn(file, "devDependencies"),
    ];

    expect(versions.filter((version) => !EXACT_VERSION.test(version))).toEqual(
      [],
    );
  });
});

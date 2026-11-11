import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Where each package comes from is checked by scripts/check-lockfile.ts, in
// `npm run lint:lockfile`.

// Every runtime dependency sees all the secrets, and a lookalike name is a known
// attack, so adding one should be a deliberate change that this test makes visible.
const RUNTIME = [
  "@supabase/postgrest-js",
  "@vercel/functions",
  "discord-api-types",
  "zod",
];

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function readPackageFile(): object {
  const file: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (typeof file !== "object" || file === null) {
    throw new Error("package.json does not hold an object");
  }
  return file;
}

function entriesIn(file: object, section: string): [string, string][] {
  const entries: unknown = Reflect.get(file, section);
  if (typeof entries !== "object" || entries === null) {
    throw new Error(`package.json has no ${section} object`);
  }
  return Object.entries(entries).map(([name, version]: [string, unknown]) => {
    if (typeof version !== "string") {
      throw new Error(`package.json has a ${section} version that is not text`);
    }
    return [name, version];
  });
}

describe("direct dependencies", () => {
  const file = readPackageFile();

  it("has only the allowed runtime packages", () => {
    const names = entriesIn(file, "dependencies").map(([name]) => name);

    expect(names.sort()).toEqual(RUNTIME);
  });

  it("pins every package to an exact version", () => {
    const versions = [
      ...entriesIn(file, "dependencies"),
      ...entriesIn(file, "devDependencies"),
    ].map(([, version]) => version);

    expect(versions.filter((version) => !EXACT_VERSION.test(version))).toEqual(
      [],
    );
  });
});

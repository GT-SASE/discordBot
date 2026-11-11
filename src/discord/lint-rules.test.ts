import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

const CONFIG_URL = pathToFileURL(
  join(import.meta.dirname, "..", "..", "eslint.config.js"),
).href;

const OUTSIDE = "src/handlers/sample.ts";

describe("one send path lint rule", () => {
  let linter: Linter;
  let blocks: Linter.Config[];

  beforeAll(async () => {
    const loaded = (await import(CONFIG_URL)) as { default: Linter.Config[] };
    blocks = loaded.default.filter(
      (block) =>
        block.name === "discord/one-send-path" ||
        block.name === "base/disable-directives",
    );
    linter = new Linter();
    expect(blocks).toHaveLength(2);
  });

  const problems = (code: string, filename = OUTSIDE) =>
    linter
      .verify(
        code,
        [
          {
            files: ["**/*.ts"],
            languageOptions: { parser: tseslint.parser },
          },
          ...blocks,
        ],
        { filename },
      )
      .map((problem) => problem.message);

  const refused = (code: string, filename?: string) => {
    expect(problems(code, filename).length).toBeGreaterThan(0);
  };

  it("refuses a bare fetch", () => {
    refused(`await fetch("https://example.test");`);
  });

  it.each(["globalThis", "global", "window", "self"])(
    "refuses fetch reached through %s",
    (object) => {
      refused(`await ${object}.fetch("https://example.test");`);
      refused(`await ${object}["fetch"]("https://example.test");`);
      refused(`const { fetch: send } = ${object};`);
      refused(`const g = ${object};`);
    },
  );

  it.each([
    "http",
    "https",
    "http2",
    "net",
    "tls",
    "dgram",
    "node:http",
    "node:https",
    "node:http2",
    "node:net",
    "node:tls",
    "node:dgram",
    "undici",
  ])("refuses a static or dynamic import of %s", (name) => {
    refused(`import * as m from "${name}";`);
    refused(`const m = await import("${name}");`);
    refused(`const m = require("${name}");`);
  });

  it("refuses a dynamic import of a name that is not a literal", () => {
    refused("const m = await import(`node:${name}`);");
    refused("const m = await import(name);");
  });

  it("refuses loading a builtin through process", () => {
    refused(`const m = process.getBuiltinModule("node:https");`);
  });

  it("refuses Discord's route helpers", () => {
    refused(`import { RouteBases } from "discord-api-types/v10";`);
    refused(`import { Routes } from "discord-api-types/rest/v10";`);
  });

  it("does not honour inline disable comments", () => {
    for (const code of [
      `// eslint-disable-next-line no-restricted-globals\nawait fetch("https://example.test");`,
      `/* eslint-disable */\nawait globalThis.fetch("https://example.test");`,
    ]) {
      expect(problems(code)).toContainEqual(
        expect.stringContaining("Send to Discord through"),
      );
    }
  });

  it("reports a disable comment that disables nothing", () => {
    expect(
      problems(
        `// eslint-disable-next-line no-console\nconst x = 1;`,
        "scripts/sample.ts",
      ),
    ).toEqual([expect.stringContaining("Unused eslint-disable directive")]);
  });

  it("allows the two client files to send", () => {
    for (const filename of ["src/discord/client.ts", "src/db/client.ts"]) {
      expect(
        problems(
          `const send = globalThis.fetch;\nawait send("https://example.test");`,
          filename,
        ),
      ).toEqual([]);
    }
  });

  it("allows the types and constants the bot uses", () => {
    expect(
      problems(`import { PermissionFlagsBits } from "discord-api-types/v10";`),
    ).toEqual([]);
  });
});

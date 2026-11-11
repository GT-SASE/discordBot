import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

const CONFIG_URL = pathToFileURL(
  join(import.meta.dirname, "..", "..", "eslint.config.js"),
).href;

const OUTSIDE = "src/discord/handler.ts";

describe("database lint rules", () => {
  let linter: Linter;
  let blocks: Linter.Config[];

  beforeAll(async () => {
    const loaded = (await import(CONFIG_URL)) as { default: Linter.Config[] };
    blocks = loaded.default.filter((block) => block.name?.startsWith("db/"));
    linter = new Linter();
    expect(blocks).toHaveLength(3);
  });

  const problems = (code: string, filename = "src/db/sample.ts") =>
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

  describe("inside src/db", () => {
    it("reads from and writes to schema tables only, never a name built at run time", () => {
      refused(`sql.select(COLUMNS).from("events");`);
      refused("sql.select(COLUMNS).from(`events${x}`);");
      refused(`sql.select(COLUMNS).from(pick(name));`);
      refused(`sql.update("tasks").set({ name });`);
      refused(`sql.insert(tableFor(name)).values({ name });`);
      expect(problems(`sql.select(COLUMNS).from(events);`)).toEqual([]);
    });

    it("refuses raw SQL, and SQL built any way but the tagged template", () => {
      refused("sql.raw(`DELETE FROM ${table}`);");
      refused(`const raw = sql.raw;`);
      refused(`sql(text);`);
      refused(`fragment(text);`);
      refused(`db.execute(text);`);
      refused("db.execute(`SELECT ${x}`);");
      expect(problems("db.execute(sql`SELECT public.f(${x})`);")).toEqual([]);
    });

    it("calls a database function only through a template written in place", () => {
      refused(`callFunction(db, call);`);
      refused("callFunction(db, `public.f(${x})`);");
      expect(
        problems("callFunction(db, fragment`public.f(p_x => ${x})`);"),
      ).toEqual([]);
    });

    it("refuses selecting or returning every column", () => {
      refused(`sql.select().from(events);`);
      refused(`sql.select("*").from(events);`);
      refused(`sql.update(tasks).set({ name }).returning();`);
      expect(problems(`sql.select({ id: events.id }).from(events);`)).toEqual(
        [],
      );
      expect(problems(`sql.select(EVENT_COLUMNS).from(events);`)).toEqual([]);
    });

    it("refuses reaching the driver behind Drizzle", () => {
      refused(`db.$client.query("DELETE FROM tasks");`);
    });

    it.each(["delete", "prepare", "onConflictDoUpdate", "onConflictDoNothing"])(
      "refuses .%s(), which the bot has no use for",
      (method) => {
        refused(`q.${method}(tasks);`);
      },
    );

    it("refuses inArray() and ilike() values that skip a validator", () => {
      refused(`inArray(events.id, ids);`);
      refused(`inArray(events.id, clean(ids));`);
      refused("ilike(events.name, `%${term}%`);");
      refused(`like(events.name, term);`);
      expect(problems(`inArray(events.id, uuidList(ids));`)).toEqual([]);
      expect(problems(`inArray(events.id, snowflakeList(ids));`)).toEqual([]);
      expect(problems(`ilike(events.name, searchPattern(term));`)).toEqual([]);
    });

    it("refuses spread, computed keys or a variable in a write", () => {
      refused(`sql.update(tasks).set({ ...input });`);
      refused(`sql.update(tasks).set({ [column]: value });`);
      refused(`sql.update(tasks).set(input);`);
      refused(`sql.insert(tasks).values(input);`);
      refused(`sql.insert(tasks).values({ ...input });`);
      expect(
        problems(`sql.insert(tasks).values({ name }).returning(COLUMNS);`),
      ).toEqual([]);
    });

    it("leaves a map's own set() alone", () => {
      expect(problems(`registry.set(handle, entry);`)).toEqual([]);
    });

    it("refuses a method called through a computed key", () => {
      refused(`q["delete"](x);`);
      refused(`q[name](x);`);
    });

    it("does not honour inline disable comments", () => {
      refused(
        `// eslint-disable-next-line no-restricted-syntax\nsql.raw(text);`,
      );
    });
  });

  describe("outside src/db", () => {
    it.each(["../db/internal.ts", "../../src/db/internal"])(
      "refuses importing the query client through %s",
      (path) => {
        refused(`import { run } from "${path}";`, OUTSIDE);
        refused(`import { run } from "${path}";`, "test/db/x.ts");
      },
    );

    it.each([
      `import { drizzle } from "drizzle-orm/node-postgres";`,
      `import { eq } from "drizzle-orm";`,
      `import { createSelectSchema } from "drizzle-zod";`,
      `import pg from "pg";`,
      `import { PGlite } from "@electric-sql/pglite";`,
    ])("refuses loading a driver in the bot's code: %s", (code) => {
      refused(code, OUTSIDE);
      refused(code, "api/x.ts");
    });

    it("lets tests and scripts set a database up", () => {
      expect(problems(`import pg from "pg";`, "test/db/x.ts")).toEqual([]);
      expect(problems(`import pg from "pg";`, "scripts/x.ts")).toEqual([]);
    });

    it("allows importing the opaque client and the functions", () => {
      expect(
        problems(`import { getDb } from "../db/client.ts";`, OUTSIDE),
      ).toEqual([]);
    });

    it.each([
      "db.execute(sql`SELECT 1`);",
      `q.update(tasks);`,
      `q.insert(tasks);`,
      `q.upsert({ name });`,
      `q.delete();`,
      `q.delete({ count: "exact" });`,
    ])("refuses %s", (code) => {
      refused(code, OUTSIDE);
    });

    it("leaves ordinary array, map, string and hash methods alone", () => {
      expect(
        problems(
          `list.filter(fn); text.match(re); Array.from(set); map.delete(key);
           headers.delete("x"); createHash("sha256").update(body);
           createHmac("sha256", secret).update(body);`,
          OUTSIDE,
        ),
      ).toEqual([]);
    });
  });
});

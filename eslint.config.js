import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import { builtinRules } from "eslint/use-at-your-own-risk";
import tseslint from "typescript-eslint";

/** Query methods the bot has no use for, and that could widen a write or a read. */
const BANNED_METHODS = [
  "delete",
  "prepare",
  "onConflictDoUpdate",
  "onConflictDoNothing",
].join("|");

// Every extension Node or the TypeScript compiler could load, so that a file cannot
// step around these rules by its name.
const EXTENSIONS = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

const SEND_THROUGH_CLIENT = "Send to Discord through src/discord/client.ts.";
// Node's networking modules, and the HTTP client fetch is built on.
const NETWORK_MODULES = "^(node:)?(http2?|https|net|tls|dgram|undici)$";

const QUERIES_ONLY_IN_DB = "Database queries belong in src/db/.";
const INTERNAL_ONLY_IN_DB = "Only src/db/ can reach the query client.";
const DRIVERS_ONLY_IN_DB =
  "Only src/db/ may load the database driver or Drizzle. Use the functions there.";

// A rule's options replace rather than merge across config blocks, so using the
// core rule names here would silently switch off the Discord rule below on the same
// files. The same core rules under another name run alongside it instead.
const dbRules = {
  rules: {
    imports: builtinRules.get("no-restricted-imports"),
    syntax: builtinRules.get("no-restricted-syntax"),
  },
};

export default defineConfig([
  globalIgnores(["coverage/", "dist/", ".tools/"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    name: "base/disable-directives",
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    // Only the Discord client sends to Discord, so that every send runs the managed
    // channel check. The database client is the other caller of fetch. Inline
    // disable comments are ignored here, so only the two client files can opt out.
    name: "discord/one-send-path",
    files: [`{src,api}/**/*.${EXTENSIONS}`],
    ignores: [
      "src/discord/client.ts",
      "src/db/client.ts",
      `**/*.test.${EXTENSIONS}`,
    ],
    linterOptions: { noInlineConfig: true },
    rules: {
      "no-restricted-globals": [
        "error",
        ...["fetch", "globalThis", "global", "window", "self"].map((name) => ({
          name,
          message: SEND_THROUGH_CLIENT,
        })),
      ],
      "no-restricted-properties": [
        "error",
        ...["globalThis", "global", "window", "self"].map((object) => ({
          object,
          property: "fetch",
          message: SEND_THROUGH_CLIENT,
        })),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: NETWORK_MODULES, message: SEND_THROUGH_CLIENT },
            {
              regex: "^discord-api-types(/.*)?$",
              importNames: ["RouteBases", "Routes"],
              message: SEND_THROUGH_CLIENT,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression[source.value=/${NETWORK_MODULES}/]`,
          message: SEND_THROUGH_CLIENT,
        },
        {
          selector: "ImportExpression:not([source.type='Literal'])",
          message: "Import a module by its literal name.",
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/${NETWORK_MODULES}/]`,
          message: SEND_THROUGH_CLIENT,
        },
        {
          selector:
            "CallExpression[callee.property.name='getBuiltinModule'], CallExpression[callee.name='getBuiltinModule']",
          message: SEND_THROUGH_CLIENT,
        },
      ],
    },
  },
  {
    name: "db/outside-boundary",
    files: [`**/*.${EXTENSIONS}`],
    ignores: ["src/db/**"],
    plugins: { db: dbRules },
    rules: {
      "db/imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/internal", "**/db/internal.ts"],
              message: INTERNAL_ONLY_IN_DB,
            },
          ],
        },
      ],
      "db/syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='execute'][arguments.0.type='TaggedTemplateExpression']",
          message: QUERIES_ONLY_IN_DB,
        },
        // A hash has update() too, and Node's digest API offers no other way to feed one.
        {
          selector:
            "CallExpression[callee.property.name=/^(update|insert|upsert)$/]:not([callee.object.callee.name=/^(createHash|createHmac)$/])",
          message: QUERIES_ONLY_IN_DB,
        },
        // Map, Set and Headers delete by a key, while the query method takes a table.
        {
          selector:
            "CallExpression[callee.property.name='delete']:not([arguments.0.type=/^(Literal|Identifier|MemberExpression|TemplateLiteral)$/])",
          message: QUERIES_ONLY_IN_DB,
        },
      ],
    },
  },
  {
    // Tests and scripts set databases up directly. The bot's own code goes through src/db.
    name: "db/drivers-in-app",
    files: [`{src,api}/**/*.${EXTENSIONS}`],
    ignores: ["src/db/**"],
    plugins: { db: dbRules },
    rules: {
      "db/imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/internal", "**/db/internal.ts"],
              message: INTERNAL_ONLY_IN_DB,
            },
            {
              regex:
                "^(drizzle-orm(/.*)?|drizzle-zod|pg|pg-.*|@electric-sql/.*)$",
              message: DRIVERS_ONLY_IN_DB,
            },
          ],
        },
      ],
    },
  },
  {
    name: "db/query-shape",
    files: [`src/db/**/*.${EXTENSIONS}`],
    ignores: [`src/db/**/*.test.${EXTENSIONS}`],
    linterOptions: { noInlineConfig: true },
    plugins: { db: dbRules },
    rules: {
      "db/syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='from']:not([arguments.0.type='Identifier'])",
          message: "Read from a table defined in schema.ts.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(insert|update)$/]:not([arguments.0.type='Identifier'])",
          message: "Write to a table defined in schema.ts.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(select|returning)$/]:not([arguments.length=1]), CallExpression[callee.property.name=/^(select|returning)$/][arguments.0.type=/^(TemplateLiteral|CallExpression|Literal)$/]",
          message:
            "List the columns, once, as an object or a constant. Do not select everything.",
        },
        {
          selector:
            "CallExpression[callee.property.name='raw'], MemberExpression[property.name='raw'], CallExpression[callee.name=/^(sql|fragment)$/]",
          message:
            "Build SQL only with the sql tagged template, so every value is a parameter.",
        },
        {
          selector:
            "CallExpression[callee.property.name='execute']:not([arguments.0.type='TaggedTemplateExpression'])",
          message: "Pass execute() a sql`...` template, written out in place.",
        },
        {
          selector:
            "CallExpression[callee.name='callFunction']:not([arguments.1.type='TaggedTemplateExpression'])",
          message:
            "Pass callFunction() a fragment`public.f(...)` template, written out in place.",
        },
        {
          selector: "MemberExpression[property.name='$client']",
          message: "Do not reach past Drizzle to the driver.",
        },
        {
          selector:
            "CallExpression[callee.name='inArray']:not([arguments.1.callee.name=/^(snowflakeList|uuidList)$/])",
          message:
            "inArray() values must be passed through snowflakeList() or uuidList().",
        },
        {
          selector:
            "CallExpression[callee.name=/^(ilike|like|notIlike|notLike)$/]:not([arguments.1.callee.name='searchPattern'])",
          message: "Search patterns must be built by searchPattern().",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(values|set)$/][arguments.length=1]:not([arguments.0.type='ObjectExpression'])",
          message: "Written values must be a literal object.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(values|set)$/][arguments.length=1] > ObjectExpression > SpreadElement",
          message: "Name each written field. Do not spread into a write.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(values|set)$/][arguments.length=1] > ObjectExpression > Property[computed=true]",
          message: "Name each written field. Do not compute a key.",
        },
        {
          selector: `CallExpression[callee.property.name=/^(${BANNED_METHODS})$/]`,
          message: "The bot does not use this query method.",
        },
        {
          selector: "CallExpression[callee.computed=true]",
          message: "Call methods by name.",
        },
      ],
    },
  },
]);

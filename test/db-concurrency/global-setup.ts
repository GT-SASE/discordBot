import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { SERVER_SETUP, migrateAsOwner, pgConnection } from "../db/harness.ts";

/**
 * Runs once before every concurrency test file. Roles belong to the whole cluster, and
 * the server setup and the baseline migration write them, so two files doing that at
 * once fail with "tuple concurrently updated". This does it one time, in a template
 * database with every migration applied. Each file then copies the template into a
 * database of its own, which writes nothing cluster-wide, so the files can run in
 * parallel.
 *
 * Needs CONCURRENCY_DATABASE_URL, pointing at a Postgres 17 superuser connection.
 * A missing or wrong server fails the run: these tests must never skip.
 */

const EXPECTED_MAJOR_VERSION = "17";

declare module "vitest" {
  export interface ProvidedContext {
    concurrencyAdminUrl: string;
    concurrencyTemplate: string;
  }
}

/**
 * Vitest 5 cannot print an error thrown here: mapping its stack fails, and only that
 * failure shows. So the reason is written out first.
 */
function fail(message: string): never {
  console.error(`concurrency tests: ${message}`);
  throw new Error(message);
}

export function urlForDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const adminUrl = process.env.CONCURRENCY_DATABASE_URL;
  if (!adminUrl) {
    fail(
      "CONCURRENCY_DATABASE_URL is not set, so the concurrency tests cannot run",
    );
  }
  const template = `concurrency_template_${randomBytes(6).toString("hex")}`;

  await withClient(adminUrl, async (cluster) => {
    const version = await cluster.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    const major = version.rows[0]?.server_version_num.slice(0, 2);
    if (major !== EXPECTED_MAJOR_VERSION) {
      fail(
        `the server must be Postgres ${EXPECTED_MAJOR_VERSION}, not ${String(major)}`,
      );
    }
    await cluster.query(`CREATE DATABASE ${template}`);
  });

  const dropTemplate = () =>
    withClient(adminUrl, async (cluster) => {
      await cluster.query(`DROP DATABASE IF EXISTS ${template}`);
    });

  try {
    // The template must have no open connection when a file copies it, so this one
    // closes before any file starts.
    await withClient(urlForDatabase(adminUrl, template), async (client) => {
      await client.query(SERVER_SETUP);
      await migrateAsOwner(pgConnection(client));
    });
  } catch (error) {
    console.error(
      `concurrency tests: migrating the template failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await dropTemplate();
    throw error;
  }

  project.provide("concurrencyAdminUrl", adminUrl);
  project.provide("concurrencyTemplate", template);
  return dropTemplate;
}

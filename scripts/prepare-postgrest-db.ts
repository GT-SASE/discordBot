/**
 * Prepares an empty Postgres database for a real PostgREST server: the server's
 * starting state, every migration, and the role PostgREST logs in as.
 *
 * Usage: POSTGREST_DATABASE_URL=<superuser URL> node scripts/prepare-postgrest-db.ts
 */

import pg from "pg";
import {
  SERVER_SETUP,
  migrateAsOwner,
  pgConnection,
} from "../test/db/harness.ts";

/**
 * NOINHERIT, so the login itself has no rights: PostgREST must switch to the role
 * named in a request's token, which the tests set to bot_app.
 */
const AUTHENTICATOR = `
  CREATE ROLE authenticator LOGIN NOINHERIT;
  GRANT bot_app TO authenticator;
`;

async function main(): Promise<void> {
  const connectionString = process.env.POSTGREST_DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    throw new Error("POSTGREST_DATABASE_URL must be set");
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(SERVER_SETUP);
    await migrateAsOwner(pgConnection(client));
    await client.query(AUTHENTICATOR);
  } finally {
    await client.end();
  }
  console.log("Database ready for PostgREST.");
}

await main();

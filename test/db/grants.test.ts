import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import {
  FIXTURE_DUE_DATE,
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import {
  BOT_APP,
  INSUFFICIENT_PRIVILEGE,
  OTHER_ROLE,
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
} from "./harness.ts";

const READ_ONLY_TABLES = [
  "config_audit",
  "event_reminder_log",
  "event_step_assignees",
  "event_steps",
  "guild_config",
  "managed_channels",
  "reminder_log",
  "setup_drafts",
];
const ALL_TABLES = [...READ_ONLY_TABLES, "events", "job_runs", "tasks"].sort();
/** Reached only through functions, so bot_app has no grant on it. */
const NO_GRANT_TABLES = ["interaction_claims", "task_reassignments"];
/** Kept by scripts/migrate.ts for its own use. */
const LEDGER_TABLES = ["schema_migrations"];

/** Every table-level grant allowed on the app's schemas. Anything else fails the test. */
const EXPECTED_TABLE_GRANTS = [
  "bot_app events SELECT",
  "bot_app job_runs SELECT",
  "bot_app tasks SELECT",
  ...READ_ONLY_TABLES.map((table) => `bot_app ${table} SELECT`),
].sort();

/** The only columns of events and tasks that can be written. Anything else fails the test. */
const EXPECTED_COLUMN_GRANTS = [
  ...[
    "channel_id",
    "created_by",
    "event_date",
    "guild_id",
    "name",
    "thread_id",
    "thread_status",
  ].map((column) => `bot_app events.${column} INSERT`),
  ...[
    "assignee_id",
    "created_by",
    "description",
    "due_date",
    "event_id",
    "guild_id",
  ].map((column) => `bot_app tasks.${column} INSERT`),
  ...[
    "event_date",
    "name",
    "overview_message_id",
    "status",
    "thread_id",
    "thread_status",
  ].map((column) => `bot_app events.${column} UPDATE`),
  // The text, date and person change only through edit_task.
  ...["completed_at", "deleted_at", "status"].map(
    (column) => `bot_app tasks.${column} UPDATE`,
  ),
].sort();

/** Every routine a role other than the owner can call. Trigger functions need no grant. */
const EXPECTED_ROUTINE_GRANTS = [
  "bot_app apply_config_change EXECUTE",
  "bot_app apply_role_bindings EXECUTE",
  "bot_app assign_event_step EXECUTE",
  "bot_app begin_job_run EXECUTE",
  "bot_app claim_event_post_attempt EXECUTE",
  "bot_app claim_event_reminder EXECUTE",
  "bot_app claim_interaction EXECUTE",
  "bot_app claim_reminder EXECUTE",
  "bot_app claim_reminders EXECUTE",
  "bot_app claim_step_handoff EXECUTE",
  "bot_app clear_thread_refusals EXECUTE",
  "bot_app complete_event_step EXECUTE",
  "bot_app edit_task EXECUTE",
  "bot_app expire_interaction_claims EXECUTE",
  "bot_app finish_job_run EXECUTE",
  "bot_app mark_channel_unavailable EXECUTE",
  "bot_app mark_event_reminder_sent EXECUTE",
  "bot_app mark_event_reminder_skipped EXECUTE",
  "bot_app mark_reminder_sent EXECUTE",
  "bot_app mark_reminder_skipped EXECUTE",
  "bot_app mark_reminders_sent EXECUTE",
  "bot_app mark_step_handoff_sent EXECUTE",
  "bot_app reclaim_event_reminder EXECUTE",
  "bot_app reclaim_reminder EXECUTE",
  "bot_app record_reminder_refused EXECUTE",
  "bot_app record_thread_refusal EXECUTE",
  "bot_app release_event_post_attempt EXECUTE",
  "bot_app save_setup_draft EXECUTE",
  "bot_app set_event_pickup_time EXECUTE",
  "bot_app soft_delete_event EXECUTE",
  "bot_app unassign_event_step EXECUTE",
];

const EXPECTED_TYPE_GRANTS = [
  "discord_id",
  "event_reminder_kind",
  "event_status",
  "event_step_kind",
  "job_run_status",
  "managed_channel_status",
  "reminder_kind",
  "reminder_state",
  "task_status",
  "thread_status",
].map((type) => `bot_app ${type} USAGE`);

/** Every column holding a Discord ID. A new one must be added here and use the domain. */
const DISCORD_ID_COLUMNS = [
  "config_audit.actor_id",
  "config_audit.guild_id",
  "event_reminder_log.message_id",
  "event_step_assignees.assigned_by",
  "event_step_assignees.guild_id",
  "event_step_assignees.removed_by",
  "event_step_assignees.user_id",
  "event_steps.completed_by",
  "event_steps.guild_id",
  "events.channel_id",
  "events.created_by",
  "events.guild_id",
  "events.overview_message_id",
  "events.thread_id",
  "guild_config.admin_role_id",
  "guild_config.eboard_role_id",
  "guild_config.events_committee_role_id",
  "guild_config.guild_id",
  "guild_config.marketing_role_id",
  "guild_config.officer_role_id",
  "guild_config.treasury_role_id",
  "interaction_claims.interaction_id",
  "managed_channels.channel_id",
  "managed_channels.guild_id",
  "reminder_log.message_id",
  "setup_drafts.actor_id",
  "setup_drafts.admin_role_id",
  "setup_drafts.eboard_role_id",
  "setup_drafts.events_committee_role_id",
  "setup_drafts.guild_id",
  "setup_drafts.marketing_role_id",
  "setup_drafts.officer_role_id",
  "setup_drafts.treasury_role_id",
  "task_reassignments.actor_id",
  "task_reassignments.guild_id",
  "tasks.assignee_id",
  "tasks.created_by",
  "tasks.guild_id",
];

/** One policy per table and command bot_app is granted. */
const EXPECTED_POLICIES = [
  ...ALL_TABLES.map((table) => `${table} bot_app_read SELECT {bot_app}`),
  ...["events", "tasks"].map(
    (table) => `${table} bot_app_insert INSERT {bot_app}`,
  ),
  ...["events", "tasks"].map(
    (table) => `${table} bot_app_update UPDATE {bot_app}`,
  ),
].sort();

const FOREIGN_KEYS = [
  "config_audit references guild_config",
  "event_reminder_log references events",
  "event_step_assignees references events",
  "event_steps references events",
  "events references managed_channels",
  "managed_channels references guild_config",
  "reminder_log references tasks",
  "task_reassignments references guild_config",
  "task_reassignments references tasks",
  "tasks references events",
];

describe("access", () => {
  let db: PGlite;

  /** Non-owner grants from a catalog ACL, as "grantee object privilege". PUBLIC is grantee 0. */
  async function aclGrants(
    from: string,
    name: string,
    acl: string,
    owner: string,
    where: string,
  ): Promise<string[]> {
    const { rows } = await db.query<{ grant: string }>(
      `SELECT coalesce(r.rolname, 'PUBLIC') || ' ' || ${name} || ' ' || a.privilege_type AS grant
       FROM ${from}
       CROSS JOIN LATERAL aclexplode(${acl}) AS a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE ${where} AND a.grantee <> ${owner}`,
    );
    return rows.map((row) => row.grant).sort();
  }

  beforeAll(async () => {
    db = await createMigratedDb();
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const taskId = await insertTask(db, guild, eventId);
    await queryAs(
      db,
      "bot_app",
      `SELECT public.claim_reminder($1, 'due_day', '${FIXTURE_DUE_DATE}')`,
      [taskId],
    );
    await queryAs(
      db,
      "bot_app",
      `SELECT public.assign_event_step($1, $2, 'budget_sheet', $3, $3)`,
      [eventId, guild.guildId, fakeId()],
    );
    await queryAs(
      db,
      "bot_app",
      // A step reminder can be claimed only for today or yesterday in the guild's zone.
      `SELECT public.claim_event_reminder($1, 'daily_steps', (now() AT TIME ZONE 'America/New_York')::date)`,
      [eventId],
    );
    await queryAs(
      db,
      "bot_app",
      `SELECT public.save_setup_draft($1, $2, $3, $3, $3, $3, $3, $3, 'abcdefgh12345678')`,
      [guild.guildId, fakeId(), fakeId()],
    );
    await insertFinishedJobRun(db, { status: "succeeded" });
    await queryAs(
      db,
      MIGRATION_OWNER,
      `INSERT INTO public.config_audit (guild_id, actor_id, action, new_values, version_after)
       VALUES ($1, $1, 'settings', '{}', 1)`,
      [guild.guildId],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  describe("exact grant lists", () => {
    it("the public schema holds exactly the expected tables", async () => {
      const { rows } = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      expect(rows.map((row) => row.tablename)).toEqual(
        [...ALL_TABLES, ...NO_GRANT_TABLES, ...LEDGER_TABLES].sort(),
      );
    });

    it("information_schema.role_table_grants matches", async () => {
      const { rows } = await db.query<{ grant: string }>(
        `SELECT grantee || ' ' || table_name || ' ' || privilege_type AS grant
         FROM information_schema.role_table_grants
         WHERE table_schema IN ('public', 'history') AND grantee <> $1`,
        [MIGRATION_OWNER],
      );
      expect(rows.map((row) => row.grant).sort()).toEqual(
        EXPECTED_TABLE_GRANTS,
      );
    });

    it("information_schema.role_routine_grants matches", async () => {
      const { rows } = await db.query<{ grant: string }>(
        `SELECT grantee || ' ' || routine_name || ' ' || privilege_type AS grant
         FROM information_schema.role_routine_grants
         WHERE routine_schema IN ('public', 'history') AND grantee <> $1`,
        [MIGRATION_OWNER],
      );
      expect(rows.map((row) => row.grant).sort()).toEqual(
        EXPECTED_ROUTINE_GRANTS,
      );
    });

    it("schema grants match", async () => {
      const grants = await aclGrants(
        "pg_namespace n",
        "n.nspname",
        `coalesce(n.nspacl, acldefault('n', n.nspowner))`,
        "n.nspowner",
        `n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual(["bot_app public USAGE"]);
    });

    it("no role has a grant on any sequence", async () => {
      const grants = await aclGrants(
        `pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`,
        "c.relname",
        `coalesce(c.relacl, acldefault('S', c.relowner))`,
        "c.relowner",
        `c.relkind = 'S' AND n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual([]);
    });

    it("type and domain grants match", async () => {
      const grants = await aclGrants(
        `pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace`,
        "t.typname",
        `coalesce(t.typacl, acldefault('T', t.typowner))`,
        "t.typowner",
        `t.typtype IN ('e', 'd') AND n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual(EXPECTED_TYPE_GRANTS);
    });

    it("column grants match", async () => {
      const grants = await aclGrants(
        `pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace`,
        `c.relname || '.' || att.attname`,
        "att.attacl",
        "c.relowner",
        `att.attacl IS NOT NULL AND n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual(EXPECTED_COLUMN_GRANTS);
    });
  });

  describe("catalog rules", () => {
    it("row level security is on, with bot_app's policies and no others", async () => {
      const { rows: tables } = await db.query<{
        relname: string;
        relrowsecurity: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p')`,
      );
      expect(tables.length).toBeGreaterThanOrEqual(ALL_TABLES.length);
      expect(tables.filter((table) => !table.relrowsecurity)).toEqual([]);

      const { rows: policies } = await db.query<{ policy: string }>(
        `SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || roles::text AS policy
         FROM pg_policies`,
      );
      expect(policies.map((row) => row.policy).sort()).toEqual(
        EXPECTED_POLICIES,
      );
    });

    it("every policy matches every row, so the grants alone decide", async () => {
      const { rows } = await db.query(
        `SELECT policyname FROM pg_policies
         WHERE coalesce(qual, 'true') <> 'true' OR coalesce(with_check, 'true') <> 'true'`,
      );
      expect(rows).toEqual([]);
    });

    it("the open-parent guard's comment says what it does for a removed channel", async () => {
      const { rows } = await db.query<{ comment: string }>(
        `SELECT obj_description('public.require_open_parent()'::regprocedure) AS comment`,
      );
      expect(rows[0]?.comment).toContain(
        "A task on an event in a removed channel is allowed",
      );
    });

    it("every function has a pinned, empty search_path", async () => {
      const { rows } = await db.query(
        `SELECT p.proname, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'history')
           AND p.proconfig IS DISTINCT FROM ARRAY['search_path=""']`,
      );
      expect(rows).toEqual([]);
    });

    it("no function in the public schema is overloaded", async () => {
      // An overload could be picked over the intended function by argument types, and
      // grants name one signature, so a second one would need its own review.
      const { rows } = await db.query(
        `SELECT p.proname, count(*)::int AS versions
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
         GROUP BY p.proname
         HAVING count(*) > 1`,
      );
      expect(rows).toEqual([]);
    });

    it("every Discord ID column uses the domain, and no other column does", async () => {
      const { rows } = await db.query<{ col: string }>(
        `SELECT table_name || '.' || column_name AS col
         FROM information_schema.columns
         WHERE table_schema = 'public' AND domain_name = 'discord_id'`,
      );
      expect(rows.map((row) => row.col).sort()).toEqual(DISCORD_ID_COLUMNS);
    });

    it("stores Discord IDs as text", async () => {
      const { rows } = await db.query(
        `SELECT DISTINCT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND domain_name = 'discord_id'`,
      );
      expect(rows).toEqual([{ data_type: "text" }]);
    });

    it("no foreign key cascades, so a hard delete cannot take other rows with it", async () => {
      const { rows } = await db.query<{
        fk: string;
        confdeltype: string;
        confupdtype: string;
      }>(
        `SELECT conrelid::regclass::text || ' references ' || confrelid::regclass::text AS fk,
                confdeltype::text AS confdeltype,
                confupdtype::text AS confupdtype
         FROM pg_constraint
         WHERE contype = 'f' AND connamespace = 'public'::regnamespace
         ORDER BY 1`,
      );
      expect(rows.map((row) => row.fk.replaceAll("public.", ""))).toEqual(
        FOREIGN_KEYS,
      );
      expect(
        rows.filter(
          (row) => row.confdeltype !== "a" || row.confupdtype !== "a",
        ),
      ).toEqual([]);
    });
  });

  describe.each(ALL_TABLES)("%s", (table) => {
    it("bot_app cannot DELETE", async () => {
      const code = await errorCodeOf(
        queryAs(db, "bot_app", `DELETE FROM public.${table}`),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("bot_app cannot TRUNCATE", async () => {
      const code = await errorCodeOf(
        queryAs(db, "bot_app", `TRUNCATE public.${table} CASCADE`),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("bot_app can read the seeded row", async () => {
      const rows = await queryAs(
        db,
        "bot_app",
        `SELECT * FROM public.${table}`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it.each([OTHER_ROLE])("%s cannot read or write", async (role) => {
      for (const sql of [
        `SELECT * FROM public.${table}`,
        `INSERT INTO public.${table} DEFAULT VALUES`,
        `DELETE FROM public.${table}`,
      ]) {
        expect(await errorCodeOf(queryAs(db, role, sql))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    });
  });

  describe.each([
    ["config_audit", "guild_id"],
    ["event_reminder_log", "state"],
    ["event_step_assignees", "removed_at"],
    ["event_steps", "status"],
    ["guild_config", "guild_id"],
    ["job_runs", "job_name"],
    ["managed_channels", "guild_id"],
    ["reminder_log", "task_id"],
    ["setup_drafts", "fingerprint"],
  ])("direct writes to %s", (table, column) => {
    it("bot_app cannot insert", async () => {
      const code = await errorCodeOf(
        queryAs(db, "bot_app", `INSERT INTO public.${table} DEFAULT VALUES`),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("bot_app cannot update", async () => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `UPDATE public.${table} SET ${column} = ${column}`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("job_runs", () => {
    it("bot_app cannot add a run dated in the future", async () => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `INSERT INTO public.job_runs (job_name, status, started_at, finished_at)
           VALUES ('reminders', 'succeeded', '2099-01-01', '2099-01-01')`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it.each([
      ["started_at", "now()"],
      ["heartbeat_at", "now()"],
      ["status", "'succeeded'"],
      ["finished_at", "now()"],
      ["results", "'{}'"],
      ["error", "NULL"],
    ])("bot_app cannot set %s directly", async (column, value) => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `UPDATE public.job_runs SET ${column} = ${value}`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("protected columns", () => {
    let guild: GuildFixture;
    let eventId: string;
    let taskId: string;

    beforeAll(async () => {
      guild = await insertGuild(db);
      eventId = await insertEvent(db, guild);
      taskId = await insertTask(db, guild, eventId);
    });

    it.each([
      ["events.deleted_at", `UPDATE public.events SET deleted_at = now()`],
      ["events.guild_id", `UPDATE public.events SET guild_id = guild_id`],
      ["events.channel_id", `UPDATE public.events SET channel_id = channel_id`],
      ["events.pickup_time", `UPDATE public.events SET pickup_time = '12:00'`],
      [
        "guild_config.treasury_role_id",
        `UPDATE public.guild_config SET treasury_role_id = NULL`,
      ],
      ["tasks.event_id", `UPDATE public.tasks SET event_id = event_id`],
      ["tasks.guild_id", `UPDATE public.tasks SET guild_id = guild_id`],
      ["tasks.created_by", `UPDATE public.tasks SET created_by = created_by`],
      ["tasks.id", `UPDATE public.tasks SET id = id`],
    ])("bot_app cannot change %s", async (_name, sql) => {
      expect(await errorCodeOf(queryAs(db, "bot_app", sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it.each([
      ["created_at", "'2000-01-01'"],
      ["updated_at", "'2000-01-01'"],
      ["deleted_at", "now()"],
      ["post_attempt_at", "'2099-01-01'"],
      ["pickup_time", "'12:00'"],
      ["status", "'closed'"],
      ["overview_message_id", "NULL"],
      ["id", "gen_random_uuid()"],
    ])("bot_app cannot set events.%s on a new event", async (column, value) => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by, ${column})
           VALUES ($1, $2, 'Forged', '2030-01-15', $3, ${value})`,
          [guild.guildId, guild.channelId, fakeId()],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it.each([
      ["created_at", "'2000-01-01'"],
      ["updated_at", "'2000-01-01'"],
      ["deleted_at", "now()"],
      ["completed_at", "now()"],
      ["status", "'done'"],
      ["id", "gen_random_uuid()"],
    ])("bot_app cannot set tasks.%s on a new task", async (column, value) => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by, ${column})
           VALUES ($1, $2, $3, 'Forged', '${FIXTURE_DUE_DATE}', $3, ${value})`,
          [eventId, guild.guildId, fakeId()],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("bot_app can still insert with the named columns", async () => {
      const rows = await queryAs(
        db,
        "bot_app",
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
         VALUES ($1, $2, 'Linked', '2030-01-15', $3, $4, 'active') RETURNING created_at`,
        [guild.guildId, guild.channelId, fakeId(), fakeId()],
      );
      expect(rows).toHaveLength(1);
    });

    it("bot_app can soft-delete a single task but cannot undelete an event", async () => {
      await queryAs(
        db,
        "bot_app",
        `UPDATE public.tasks SET deleted_at = now() WHERE id = $1`,
        [taskId],
      );
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `UPDATE public.events SET deleted_at = NULL WHERE id = $1`,
          [eventId],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a task cannot be moved to another event or guild", async () => {
      const other = await insertGuild(db);
      const otherEvent = await insertEvent(db, other);
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `UPDATE public.tasks SET event_id = $2, guild_id = $3 WHERE id = $1`,
          [taskId, otherEvent, other.guildId],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("bot_app can still make ordinary updates, and updated_at still refreshes", async () => {
      await db.exec(
        `UPDATE public.events SET updated_at = '2000-01-01' WHERE id = '${eventId}'`,
      );
      await queryAs(
        db,
        "bot_app",
        `UPDATE public.events SET name = 'Renamed', status = 'closed' WHERE id = $1`,
        [eventId],
      );
      const { rows } = await db.query(
        `SELECT name, status, updated_at > '2000-01-02' AS refreshed FROM public.events WHERE id = $1`,
        [eventId],
      );
      expect(rows).toEqual([
        { name: "Renamed", status: "closed", refreshed: true },
      ]);
    });
  });

  it("row level security still hides rows if a grant to another role appears by mistake", async () => {
    await db.exec(
      `BEGIN; GRANT USAGE ON SCHEMA public TO ${OTHER_ROLE}; GRANT SELECT ON public.tasks TO ${OTHER_ROLE};`,
    );
    try {
      const rows = await queryAs(db, OTHER_ROLE, `SELECT * FROM public.tasks`);
      expect(rows).toEqual([]);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it.each([BOT_APP, OTHER_ROLE])("%s cannot disable triggers", async (role) => {
    const code = await errorCodeOf(
      queryAs(db, role, `ALTER TABLE public.tasks DISABLE TRIGGER ALL`),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("bot_app cannot call trigger functions directly", async () => {
    const code = await errorCodeOf(
      queryAs(db, "bot_app", `SELECT public.require_open_parent()`),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
  describe("bot_app itself", () => {
    it("can log in, and has no other attribute", async () => {
      const { rows } = await db.query(
        `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
        [BOT_APP],
      );
      expect(rows).toEqual([
        {
          rolcanlogin: true,
          rolsuper: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ]);
    });

    it("has no password from the migrations: the operator sets one", async () => {
      const { rows } = await db.query(
        `SELECT rolpassword IS NULL AS no_password FROM pg_authid WHERE rolname = $1`,
        [BOT_APP],
      );
      expect(rows).toEqual([{ no_password: true }]);
    });

    it("is a member of no role, so it can neither inherit nor SET ROLE to more", async () => {
      const { rows } = await db.query(
        `SELECT roleid::regrole::text AS role FROM pg_auth_members
         WHERE member = $1::regrole`,
        [BOT_APP],
      );
      expect(rows).toEqual([]);
    });

    it("owns nothing", async () => {
      const { rows } = await db.query(
        `SELECT 'relation' AS kind FROM pg_class WHERE relowner = $1::regrole
         UNION ALL SELECT 'routine' FROM pg_proc WHERE proowner = $1::regrole
         UNION ALL SELECT 'type' FROM pg_type WHERE typowner = $1::regrole
         UNION ALL SELECT 'schema' FROM pg_namespace WHERE nspowner = $1::regrole
         UNION ALL SELECT 'database' FROM pg_database WHERE datdba = $1::regrole`,
        [BOT_APP],
      );
      expect(rows).toEqual([]);
    });

    it("has a statement timeout and the UTC zone, whatever pooler it comes through", async () => {
      const { rows } = await db.query<{ setting: string }>(
        `SELECT unnest(setconfig) AS setting FROM pg_db_role_setting
         WHERE setrole = $1::regrole`,
        [BOT_APP],
      );
      expect(rows.map((row) => row.setting).sort()).toEqual([
        "TimeZone=UTC",
        "idle_in_transaction_session_timeout=15s",
        "statement_timeout=10s",
      ]);
    });

    it.each([...ALL_TABLES, ...NO_GRANT_TABLES, ...LEDGER_TABLES])(
      "cannot DELETE from or TRUNCATE %s",
      async (table) => {
        for (const sql of [
          `DELETE FROM public.${table}`,
          `TRUNCATE public.${table}`,
        ]) {
          expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
            INSUFFICIENT_PRIVILEGE,
          );
        }
      },
    );

    it.each([
      "ALTER TABLE public.tasks ADD COLUMN forged text",
      "ALTER TABLE public.events DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE public.tasks OWNER TO bot_app",
      "ALTER FUNCTION public.claim_interaction(text) SECURITY INVOKER",
      "DROP TABLE public.reminder_log",
      "DROP POLICY bot_app_read ON public.tasks",
      "CREATE TABLE public.forged (id int)",
      "CREATE FUNCTION public.forged() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE SCHEMA forged",
      "ALTER ROLE bot_app BYPASSRLS",
      "ALTER ROLE bot_app CREATEROLE",
    ])("cannot run %s", async (sql) => {
      expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it.each([
      "SELECT * FROM history.row_versions",
      "INSERT INTO history.row_versions DEFAULT VALUES",
      "SELECT history.record_row_version()",
    ])("cannot reach the history schema: %s", async (sql) => {
      expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("cannot read the migration ledger or the tables reached only through functions", async () => {
      for (const table of [...NO_GRANT_TABLES, ...LEDGER_TABLES]) {
        expect(
          await errorCodeOf(
            queryAs(db, BOT_APP, `SELECT * FROM public.${table}`),
          ),
        ).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });
});

/**
 * The columns each read asks for, under the names the row checks in types.ts read. A
 * read lists what it needs and no more, so a column added later is never read by
 * accident. Each list is one map from a row's field to a table's column: the query
 * selects it and the check validates it, so the two cannot drift apart.
 */

import { sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  configAudit,
  events,
  guildConfig,
  jobRuns,
  managedChannels,
  setupDrafts,
  tasks,
} from "./schema.ts";

/** A row's field names, each naming a column of the table by its property in schema.ts. */
export type FieldNames<T extends PgTable> = Readonly<
  Record<string, keyof T["_"]["columns"] & string>
>;

/** The selection for `names`: each field, the table's column it names. */
export function columns<T extends PgTable, const N extends FieldNames<T>>(
  table: T,
  names: N,
): { [F in keyof N]: T["_"]["columns"][N[F]] } {
  const all = table as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(names).map(([field, column]) => [field, all[column]]),
  ) as { [F in keyof N]: T["_"]["columns"][N[F]] };
}

export const GUILD_CONFIG_FIELDS = {
  guild_id: "guildId",
  officer_role_id: "officerRoleId",
  admin_role_id: "adminRoleId",
  eboard_role_id: "eboardRoleId",
  events_committee_role_id: "eventsCommitteeRoleId",
  treasury_role_id: "treasuryRoleId",
  marketing_role_id: "marketingRoleId",
  timezone: "timezone",
  reminders_enabled: "remindersEnabled",
  version: "version",
} as const satisfies FieldNames<typeof guildConfig>;
export const GUILD_CONFIG_COLUMNS = columns(guildConfig, GUILD_CONFIG_FIELDS);

export const SETUP_DRAFT_FIELDS = {
  guild_id: "guildId",
  actor_id: "actorId",
  officer_role_id: "officerRoleId",
  admin_role_id: "adminRoleId",
  eboard_role_id: "eboardRoleId",
  events_committee_role_id: "eventsCommitteeRoleId",
  treasury_role_id: "treasuryRoleId",
  marketing_role_id: "marketingRoleId",
  fingerprint: "fingerprint",
  created_at: "createdAt",
} as const satisfies FieldNames<typeof setupDrafts>;
export const SETUP_DRAFT_COLUMNS = columns(setupDrafts, SETUP_DRAFT_FIELDS);

export const CONFIG_CHANGE_FIELDS = {
  id: "id",
  actor_id: "actorId",
  action: "action",
  old_values: "oldValues",
  new_values: "newValues",
  version_after: "versionAfter",
  created_at: "createdAt",
} as const satisfies FieldNames<typeof configAudit>;
export const CONFIG_CHANGE_COLUMNS = columns(configAudit, CONFIG_CHANGE_FIELDS);

export const MANAGED_CHANNEL_FIELDS = {
  guild_id: "guildId",
  channel_id: "channelId",
  status: "status",
} as const satisfies FieldNames<typeof managedChannels>;
export const MANAGED_CHANNEL_COLUMNS = columns(
  managedChannels,
  MANAGED_CHANNEL_FIELDS,
);

export const EVENT_FIELDS = {
  id: "id",
  guild_id: "guildId",
  channel_id: "channelId",
  name: "name",
  event_date: "eventDate",
  thread_id: "threadId",
  overview_message_id: "overviewMessageId",
  status: "status",
  thread_status: "threadStatus",
  created_by: "createdBy",
  deleted_at: "deletedAt",
  created_at: "createdAt",
} as const satisfies FieldNames<typeof events>;
export const EVENT_COLUMNS = columns(events, EVENT_FIELDS);

export const EVENT_CHOICE_FIELDS = {
  id: "id",
  name: "name",
  event_date: "eventDate",
  status: "status",
} as const satisfies FieldNames<typeof events>;
export const EVENT_CHOICE_COLUMNS = columns(events, EVENT_CHOICE_FIELDS);

export const TASK_FIELDS = {
  id: "id",
  event_id: "eventId",
  guild_id: "guildId",
  assignee_id: "assigneeId",
  description: "description",
  due_date: "dueDate",
  status: "status",
  completed_at: "completedAt",
  created_by: "createdBy",
  deleted_at: "deletedAt",
  updated_at: "updatedAt",
} as const satisfies FieldNames<typeof tasks>;
export const TASK_COLUMNS = columns(tasks, TASK_FIELDS);

export const TASK_CHOICE_FIELDS = {
  id: "id",
  description: "description",
  due_date: "dueDate",
} as const satisfies FieldNames<typeof tasks>;
export const TASK_CHOICE_COLUMNS = columns(tasks, TASK_CHOICE_FIELDS);

export const LIVE_TASK_CHOICE_FIELDS = {
  ...TASK_CHOICE_FIELDS,
  status: "status",
} as const satisfies FieldNames<typeof tasks>;
export const LIVE_TASK_CHOICE_COLUMNS = columns(tasks, LIVE_TASK_CHOICE_FIELDS);

export const JOB_RUN_FIELDS = {
  id: "id",
  job_name: "jobName",
  status: "status",
  started_at: "startedAt",
  heartbeat_at: "heartbeatAt",
  finished_at: "finishedAt",
  results: "results",
  error: "error",
} as const satisfies FieldNames<typeof jobRuns>;
export const JOB_RUN_COLUMNS = columns(jobRuns, JOB_RUN_FIELDS);

/**
 * A SQL expression to select as a field, with its columns kept as `"table"."column"`.
 * Drizzle strips the table from a column written straight into a selected expression
 * when the query reads one table, and a correlated subquery then compares the inner
 * table's columns with themselves. A column one template further in is left alone.
 */
export function selected<T>(expression: SQL<T>): SQL<T> {
  return sql<T>`${expression}`;
}

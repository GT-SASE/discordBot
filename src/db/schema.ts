/**
 * The tables and enums of db/migrations, for building queries. The SQL there is the
 * source of truth: this file only mirrors it, nothing generates a migration from it, and
 * test/db/drizzle-schema.test.ts fails if the two disagree on any table, column, type,
 * nullability, default or enum value.
 *
 * The history schema and the migration ledger are left out, since the bot's role has no
 * access to them.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  uuid,
} from "drizzle-orm/pg-core";

/** `public.discord_id`: text holding a Discord ID, checked by the domain. */
const discordId = customType<{ data: string; driverData: string }>({
  dataType: () => "discord_id",
});

const TIMESTAMP_TEXT =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?)([+-][0-9]{2})(?::?([0-9]{2}))?$/;

/**
 * Postgres's own text for a timestamptz, `2030-01-10 12:00:00.123456+00`, in ISO form.
 * Kept as text and not a Date, so the microseconds survive: an edit sends `updated_at`
 * back as the version it read, and a Date would round it to milliseconds and never match.
 * Text in any other form is passed on unchanged, for the row checks to refuse.
 */
export function isoTimestamp(value: string): string {
  const match = TIMESTAMP_TEXT.exec(value);
  if (match === null) {
    return value;
  }
  const [, day, clock, hours, minutes = "00"] = match;
  return `${String(day)}T${String(clock)}${String(hours)}:${minutes}`;
}

const NOW = sql`now()`;

/** `timestamp with time zone`, read as ISO text. See `isoTimestamp`. */
const timestamptz = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (value) => isoTimestamp(value),
});

export const managedChannelStatus = pgEnum("managed_channel_status", [
  "active",
  "unavailable",
  "removed",
]);
export const eventStatus = pgEnum("event_status", ["active", "closed"]);
export const threadStatus = pgEnum("thread_status", [
  "pending",
  "active",
  "missing",
]);
export const taskStatus = pgEnum("task_status", ["open", "done"]);
export const reminderKind = pgEnum("reminder_kind", [
  "three_days",
  "one_day",
  "due_day",
  "overdue",
]);
export const reminderState = pgEnum("reminder_state", [
  "claimed",
  "sent",
  "skipped",
]);
export const jobRunStatus = pgEnum("job_run_status", [
  "running",
  "succeeded",
  "failed",
]);
export const eventStepKind = pgEnum("event_step_kind", [
  "budget_sheet",
  "engage_post",
  "budget_approved",
  "food_pickup",
]);
export const eventReminderKind = pgEnum("event_reminder_kind", [
  "daily_steps",
  "pickup_two_days",
  "pickup_day",
]);

export const guildConfig = pgTable("guild_config", {
  guildId: discordId("guild_id").primaryKey(),
  officerRoleId: discordId("officer_role_id").notNull(),
  adminRoleId: discordId("admin_role_id").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  remindersEnabled: boolean("reminders_enabled").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamptz("created_at").notNull().default(NOW),
  updatedAt: timestamptz("updated_at").notNull().default(NOW),
  eboardRoleId: discordId("eboard_role_id"),
  eventsCommitteeRoleId: discordId("events_committee_role_id"),
  treasuryRoleId: discordId("treasury_role_id"),
  marketingRoleId: discordId("marketing_role_id"),
});

export const managedChannels = pgTable(
  "managed_channels",
  {
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    status: managedChannelStatus("status").notNull().default("active"),
    createdAt: timestamptz("created_at").notNull().default(NOW),
    updatedAt: timestamptz("updated_at").notNull().default(NOW),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
);

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: discordId("guild_id").notNull(),
  channelId: discordId("channel_id").notNull(),
  name: text("name").notNull(),
  eventDate: date("event_date", { mode: "string" }).notNull(),
  threadId: discordId("thread_id"),
  overviewMessageId: discordId("overview_message_id"),
  status: eventStatus("status").notNull().default("active"),
  threadStatus: threadStatus("thread_status").notNull().default("pending"),
  createdBy: discordId("created_by").notNull(),
  deletedAt: timestamptz("deleted_at"),
  createdAt: timestamptz("created_at").notNull().default(NOW),
  updatedAt: timestamptz("updated_at").notNull().default(NOW),
  postAttemptAt: timestamptz("post_attempt_at"),
  threadRefusals: integer("thread_refusals").notNull().default(0),
  pickupTime: time("pickup_time"),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  guildId: discordId("guild_id").notNull(),
  assigneeId: discordId("assignee_id").notNull(),
  description: text("description").notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  status: taskStatus("status").notNull().default("open"),
  completedAt: timestamptz("completed_at"),
  createdBy: discordId("created_by").notNull(),
  deletedAt: timestamptz("deleted_at"),
  createdAt: timestamptz("created_at").notNull().default(NOW),
  updatedAt: timestamptz("updated_at").notNull().default(NOW),
});

export const reminderLog = pgTable(
  "reminder_log",
  {
    taskId: uuid("task_id").notNull(),
    kind: reminderKind("kind").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    state: reminderState("state").notNull().default("claimed"),
    claimToken: uuid("claim_token").notNull().defaultRandom(),
    attempts: integer("attempts").notNull().default(1),
    claimedAt: timestamptz("claimed_at").notNull().default(NOW),
    sentAt: timestamptz("sent_at"),
    messageId: discordId("message_id"),
    refusedAttempts: integer("refused_attempts").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.kind, table.dueDate] }),
  ],
);

export const jobRuns = pgTable("job_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobName: text("job_name").notNull(),
  status: jobRunStatus("status").notNull().default("running"),
  startedAt: timestamptz("started_at").notNull().default(NOW),
  heartbeatAt: timestamptz("heartbeat_at").notNull().default(NOW),
  finishedAt: timestamptz("finished_at"),
  results: jsonb("results").notNull().default({}),
  error: text("error"),
});

export const configAudit = pgTable("config_audit", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  guildId: discordId("guild_id").notNull(),
  actorId: discordId("actor_id").notNull(),
  action: text("action").notNull(),
  oldValues: jsonb("old_values"),
  newValues: jsonb("new_values").notNull(),
  versionAfter: integer("version_after").notNull(),
  createdAt: timestamptz("created_at").notNull().default(NOW),
});

export const interactionClaims = pgTable("interaction_claims", {
  interactionId: discordId("interaction_id").primaryKey(),
  claimedAt: timestamptz("claimed_at").notNull().default(NOW),
});

export const taskReassignments = pgTable("task_reassignments", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  guildId: discordId("guild_id").notNull(),
  actorId: discordId("actor_id").notNull(),
  taskId: uuid("task_id").notNull(),
  createdAt: timestamptz("created_at").notNull().default(NOW),
});

export const setupDrafts = pgTable("setup_drafts", {
  guildId: discordId("guild_id").primaryKey(),
  actorId: discordId("actor_id").notNull(),
  officerRoleId: discordId("officer_role_id").notNull(),
  adminRoleId: discordId("admin_role_id").notNull(),
  eboardRoleId: discordId("eboard_role_id").notNull(),
  eventsCommitteeRoleId: discordId("events_committee_role_id").notNull(),
  treasuryRoleId: discordId("treasury_role_id").notNull(),
  marketingRoleId: discordId("marketing_role_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  createdAt: timestamptz("created_at").notNull().default(NOW),
});

export const eventSteps = pgTable(
  "event_steps",
  {
    eventId: uuid("event_id").notNull(),
    guildId: discordId("guild_id").notNull(),
    kind: eventStepKind("kind").notNull(),
    status: taskStatus("status").notNull().default("open"),
    completedAt: timestamptz("completed_at"),
    completedBy: discordId("completed_by"),
    handoffClaimedAt: timestamptz("handoff_claimed_at"),
    handoffSentAt: timestamptz("handoff_sent_at"),
    createdAt: timestamptz("created_at").notNull().default(NOW),
    updatedAt: timestamptz("updated_at").notNull().default(NOW),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.kind] })],
);

export const eventStepAssignees = pgTable("event_step_assignees", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  guildId: discordId("guild_id").notNull(),
  kind: eventStepKind("kind").notNull(),
  userId: discordId("user_id").notNull(),
  assignedBy: discordId("assigned_by").notNull(),
  removedAt: timestamptz("removed_at"),
  removedBy: discordId("removed_by"),
  createdAt: timestamptz("created_at").notNull().default(NOW),
});

export const eventReminderLog = pgTable(
  "event_reminder_log",
  {
    eventId: uuid("event_id").notNull(),
    kind: eventReminderKind("kind").notNull(),
    reminderDate: date("reminder_date", { mode: "string" }).notNull(),
    state: reminderState("state").notNull().default("claimed"),
    claimToken: uuid("claim_token").notNull().defaultRandom(),
    attempts: integer("attempts").notNull().default(1),
    claimedAt: timestamptz("claimed_at").notNull().default(NOW),
    sentAt: timestamptz("sent_at"),
    messageId: discordId("message_id"),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.kind, table.reminderDate] }),
  ],
);

export const TABLES = [
  configAudit,
  eventReminderLog,
  eventStepAssignees,
  eventSteps,
  events,
  guildConfig,
  interactionClaims,
  jobRuns,
  managedChannels,
  reminderLog,
  setupDrafts,
  taskReassignments,
  tasks,
] as const;

export const ENUMS = [
  eventReminderKind,
  eventStatus,
  eventStepKind,
  jobRunStatus,
  managedChannelStatus,
  reminderKind,
  reminderState,
  taskStatus,
  threadStatus,
] as const;

/*
 * What the bot's role may insert, as tables of their own. Drizzle names every column of a
 * table in an insert, writing DEFAULT for the ones not given, and Postgres needs the
 * INSERT grant on every column named. So an insert goes through one of these, which name
 * only the granted columns. They also stop code from writing any other column at all.
 */

export const eventInserts = pgTable("events", {
  guildId: discordId("guild_id").notNull(),
  channelId: discordId("channel_id").notNull(),
  name: text("name").notNull(),
  eventDate: date("event_date", { mode: "string" }).notNull(),
  createdBy: discordId("created_by").notNull(),
  threadId: discordId("thread_id"),
  threadStatus: threadStatus("thread_status"),
});

export const taskInserts = pgTable("tasks", {
  eventId: uuid("event_id").notNull(),
  guildId: discordId("guild_id").notNull(),
  assigneeId: discordId("assignee_id").notNull(),
  description: text("description").notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  createdBy: discordId("created_by").notNull(),
});

export const INSERT_TABLES = [eventInserts, taskInserts] as const;

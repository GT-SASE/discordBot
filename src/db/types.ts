/**
 * The rows the bot reads, and the checks every one passes before any code uses it.
 *
 * Each check is built with drizzle-zod from the table in schema.ts, so a column's type,
 * nullability and enum values come from the one mirror of db/migrations. The columns
 * Postgres cannot describe closely enough are tightened here: Discord IDs, UUIDs, dates,
 * timestamps kept as exact text, times of day and JSON objects. A row that fails is left
 * out and reported by its table, field and ID, never cast, and no value from it is kept.
 */

import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type {
  PlanEvent,
  PlanTask,
  ReminderKind,
  ReminderLogRow,
  ReminderState,
} from "../reminders/plan.ts";
import {
  CONFIG_CHANGE_FIELDS,
  EVENT_CHOICE_FIELDS,
  EVENT_FIELDS,
  GUILD_CONFIG_FIELDS,
  JOB_RUN_FIELDS,
  LIVE_TASK_CHOICE_FIELDS,
  MANAGED_CHANNEL_FIELDS,
  SETUP_DRAFT_FIELDS,
  TASK_CHOICE_FIELDS,
  TASK_FIELDS,
} from "./columns.ts";
import {
  configAudit,
  eventReminderLog,
  eventStepAssignees,
  eventSteps,
  events,
  guildConfig,
  jobRuns,
  managedChannels,
  reminderLog,
  setupDrafts,
  tasks,
} from "./schema.ts";
import { isTimestampText, isUuid } from "./validate.ts";

export type { ReminderKind, ReminderState };
export type ManagedChannelStatus = "active" | "unavailable" | "removed";
export type EventStatus = "active" | "closed";
export type ThreadStatus = "pending" | "active" | "missing";
export type TaskStatus = "open" | "done";
export type JobRunStatus = "running" | "succeeded" | "failed";
export type ConfigAuditAction = "role_bindings" | "settings";
export type EventStepKind =
  "budget_sheet" | "engage_post" | "budget_approved" | "food_pickup";
/** The steps people can be assigned to. Budget approved is marked by a role instead. */
export type AssignableStepKind = Exclude<EventStepKind, "budget_approved">;
/** The steps marked done by hand. Food pickup is done once it has a time and people. */
export type CompletableStepKind = Exclude<EventStepKind, "food_pickup">;
export type EventReminderKind =
  "daily_steps" | "pickup_two_days" | "pickup_day";

/** Which row was left out and which field failed. Holds no value from the row. */
export interface ExcludedRow {
  readonly table: string;
  readonly field: string;
  readonly id: string | null;
}

export type ParsedRow<T> =
  | { readonly ok: true; readonly row: T }
  | { readonly ok: false; readonly excluded: ExcludedRow };

export type RowParser<T> = (raw: unknown) => ParsedRow<T>;

export const EVENT_STEP_KINDS = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
  "food_pickup",
] as const satisfies readonly EventStepKind[];
export const ASSIGNABLE_STEP_KINDS = [
  "budget_sheet",
  "engage_post",
  "food_pickup",
] as const satisfies readonly AssignableStepKind[];
export const COMPLETABLE_STEP_KINDS = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
] as const satisfies readonly CompletableStepKind[];
export const EVENT_REMINDER_KINDS = [
  "daily_steps",
  "pickup_two_days",
  "pickup_day",
] as const satisfies readonly EventReminderKind[];

// Checks for what a column's type alone does not pin down -------------------------------

const Snowflake = z.string().refine(isSnowflake);
const Uuid = z.string().refine(isUuid);
/** Kept as the exact text, so it can be sent back as an expected value. */
const Timestamp = z.string().refine(isTimestampText);
const IsoDate = z.string().transform((value, context): DateOnly => {
  const date = parseIsoDate(value);
  if (date === null) {
    context.addIssue({ code: "custom", message: "not a date" });
    return z.NEVER;
  }
  return date;
});
const TIME_OF_DAY =
  /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,6})?)?$/;
/** A time of day as Postgres gives it, kept as `HH:MM`. */
const TimeOfDay = z
  .string()
  .regex(TIME_OF_DAY)
  .transform((value) => value.slice(0, 5));
/** A JSON object, not an array or a scalar. */
const JsonObject = z.record(z.string(), z.unknown());
/** Keeps an unreadable value as an invalid Date, which the planner treats as stale. */
const LooseDate = z
  .unknown()
  .transform(
    (value) => new Date(typeof value === "string" ? value : Number.NaN),
  );

// Each table's columns as drizzle-zod builds them, with the checks above. A column that
// may be null is made nullable by drizzle-zod after the check is applied. -------------

const guildConfigColumns = createSelectSchema(guildConfig, {
  guildId: () => Snowflake,
  officerRoleId: () => Snowflake,
  adminRoleId: () => Snowflake,
  eboardRoleId: () => Snowflake,
  eventsCommitteeRoleId: () => Snowflake,
  treasuryRoleId: () => Snowflake,
  marketingRoleId: () => Snowflake,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
}).shape;

const managedChannelColumns = createSelectSchema(managedChannels, {
  guildId: () => Snowflake,
  channelId: () => Snowflake,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
}).shape;

const eventColumns = createSelectSchema(events, {
  id: () => Uuid,
  guildId: () => Snowflake,
  channelId: () => Snowflake,
  eventDate: () => IsoDate,
  threadId: () => Snowflake,
  overviewMessageId: () => Snowflake,
  createdBy: () => Snowflake,
  deletedAt: () => Timestamp,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
  postAttemptAt: () => Timestamp,
  pickupTime: () => TimeOfDay,
}).shape;

const taskColumns = createSelectSchema(tasks, {
  id: () => Uuid,
  eventId: () => Uuid,
  guildId: () => Snowflake,
  assigneeId: () => Snowflake,
  dueDate: () => IsoDate,
  completedAt: () => Timestamp,
  createdBy: () => Snowflake,
  deletedAt: () => Timestamp,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
}).shape;

const reminderLogColumns = createSelectSchema(reminderLog, {
  taskId: () => Uuid,
  dueDate: () => IsoDate,
  claimToken: () => Uuid,
  claimedAt: () => Timestamp,
  sentAt: () => Timestamp,
  messageId: () => Snowflake,
}).shape;

const jobRunColumns = createSelectSchema(jobRuns, {
  id: () => Uuid,
  startedAt: () => Timestamp,
  heartbeatAt: () => Timestamp,
  finishedAt: () => Timestamp,
  results: () => JsonObject,
}).shape;

const configAuditColumns = createSelectSchema(configAudit, {
  guildId: () => Snowflake,
  actorId: () => Snowflake,
  // A text column with a check constraint, so the schema cannot see its two values.
  action: () => z.enum(["role_bindings", "settings"]),
  oldValues: () => JsonObject,
  newValues: () => JsonObject,
  createdAt: () => Timestamp,
}).shape;

const setupDraftColumns = createSelectSchema(setupDrafts, {
  guildId: () => Snowflake,
  actorId: () => Snowflake,
  officerRoleId: () => Snowflake,
  adminRoleId: () => Snowflake,
  eboardRoleId: () => Snowflake,
  eventsCommitteeRoleId: () => Snowflake,
  treasuryRoleId: () => Snowflake,
  marketingRoleId: () => Snowflake,
  createdAt: () => Timestamp,
}).shape;

const eventStepColumns = createSelectSchema(eventSteps, {
  eventId: () => Uuid,
  guildId: () => Snowflake,
  completedAt: () => Timestamp,
  completedBy: () => Snowflake,
  handoffClaimedAt: () => Timestamp,
  handoffSentAt: () => Timestamp,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
}).shape;

const assigneeColumns = createSelectSchema(eventStepAssignees, {
  id: () => Uuid,
  eventId: () => Uuid,
  guildId: () => Snowflake,
  // A check constraint keeps Budget approved out, which the enum alone allows.
  kind: () => z.enum(ASSIGNABLE_STEP_KINDS),
  userId: () => Snowflake,
  assignedBy: () => Snowflake,
  removedAt: () => Timestamp,
  removedBy: () => Snowflake,
  createdAt: () => Timestamp,
}).shape;

const eventReminderLogColumns = createSelectSchema(eventReminderLog, {
  eventId: () => Uuid,
  reminderDate: () => IsoDate,
  claimToken: () => Uuid,
  claimedAt: () => Timestamp,
  sentAt: () => Timestamp,
  messageId: () => Snowflake,
}).shape;

/** A row's fields, each the check of the table column it names. */
function fields<
  S extends z.ZodRawShape,
  const N extends Readonly<Record<string, keyof S>>,
>(shape: S, names: N): { [F in keyof N]: S[N[F]] } {
  return Object.fromEntries(
    Object.entries(names).map(([field, column]) => [field, shape[column]]),
  ) as { [F in keyof N]: S[N[F]] };
}

/**
 * A parser that runs `schema` and reports a failure by the path of its first issue.
 * Zod's own message is never read, since it can quote the value.
 */
function rowParser<T>(
  table: string,
  idColumn: string,
  schema: z.ZodType<T>,
): RowParser<T> {
  return (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, excluded: { table, field: "(row)", id: null } };
    }
    // Only the row's own data is read: a copy drops anything inherited.
    const parsed = schema.safeParse(structuredClone(raw));
    if (parsed.success) {
      return { ok: true, row: parsed.data };
    }
    const id = Object.hasOwn(raw, idColumn)
      ? (raw as Record<string, unknown>)[idColumn]
      : null;
    const field = parsed.error.issues[0]?.path.map(String).join(".") ?? "";
    return {
      ok: false,
      excluded: {
        table,
        field: field === "" ? "(row)" : field,
        id: isUuid(id) || isSnowflake(id) ? id : null,
      },
    };
  };
}

/** Orders assignments oldest first, then by ID, as every reader shows them. */
function byCreation(
  a: { id: string; created_at: string },
  b: { id: string; created_at: string },
): number {
  return a.created_at === b.created_at
    ? a.id.localeCompare(b.id)
    : Date.parse(a.created_at) - Date.parse(b.created_at);
}

// Rows keep the column names, so they can be passed straight to authorize().

export interface GuildConfig {
  guild_id: string;
  /** Shown as Events Directors. */
  officer_role_id: string;
  admin_role_id: string;
  /** The four below are null until /setup is run with them. */
  eboard_role_id: string | null;
  /** Stored and shown. Decides nothing yet. */
  events_committee_role_id: string | null;
  treasury_role_id: string | null;
  marketing_role_id: string | null;
  timezone: string;
  reminders_enabled: boolean;
  version: number;
}

export const parseGuildConfig: RowParser<GuildConfig> = rowParser(
  "guild_config",
  "guild_id",
  z.object(fields(guildConfigColumns, GUILD_CONFIG_FIELDS)),
);

export interface ConfigChange {
  id: number;
  actor_id: string;
  action: ConfigAuditAction;
  old_values: Readonly<Record<string, unknown>> | null;
  new_values: Readonly<Record<string, unknown>>;
  version_after: number;
  created_at: string;
}

export const parseConfigChange: RowParser<ConfigChange> = rowParser(
  "config_audit",
  "id",
  z.object(fields(configAuditColumns, CONFIG_CHANGE_FIELDS)),
);

export interface ManagedChannel {
  guild_id: string;
  channel_id: string;
  status: ManagedChannelStatus;
}

export const parseManagedChannel: RowParser<ManagedChannel> = rowParser(
  "managed_channels",
  "channel_id",
  z.object(fields(managedChannelColumns, MANAGED_CHANNEL_FIELDS)),
);

export interface EventRow {
  id: string;
  guild_id: string;
  channel_id: string;
  name: string;
  event_date: DateOnly;
  thread_id: string | null;
  overview_message_id: string | null;
  status: EventStatus;
  thread_status: ThreadStatus;
  created_by: string;
  deleted_at: string | null;
  created_at: string;
}

export const parseEvent: RowParser<EventRow> = rowParser(
  "events",
  "id",
  z.object(fields(eventColumns, EVENT_FIELDS)),
);

export interface EventChoice {
  id: string;
  name: string;
  event_date: DateOnly;
  status: EventStatus;
}

export const parseEventChoice: RowParser<EventChoice> = rowParser(
  "events",
  "id",
  z.object(fields(eventColumns, EVENT_CHOICE_FIELDS)),
);

export interface TaskRow {
  id: string;
  event_id: string;
  guild_id: string;
  assignee_id: string;
  description: string;
  due_date: DateOnly;
  status: TaskStatus;
  completed_at: string | null;
  created_by: string;
  deleted_at: string | null;
  /** The version to send back when editing, so a later edit is not overwritten. */
  updated_at: string;
}

export const parseTask: RowParser<TaskRow> = rowParser(
  "tasks",
  "id",
  z.object(fields(taskColumns, TASK_FIELDS)),
);

export interface TaskChoice {
  id: string;
  description: string;
  due_date: DateOnly;
}

export const parseTaskChoice: RowParser<TaskChoice> = rowParser(
  "tasks",
  "id",
  z.object(fields(taskColumns, TASK_CHOICE_FIELDS)),
);

export interface LiveTaskChoice extends TaskChoice {
  status: TaskStatus;
}

export const parseLiveTaskChoice: RowParser<LiveTaskChoice> = rowParser(
  "tasks",
  "id",
  z.object(fields(taskColumns, LIVE_TASK_CHOICE_FIELDS)),
);

export interface TaskId {
  id: string;
}

export const parseTaskId: RowParser<TaskId> = rowParser(
  "tasks",
  "id",
  z.object({ id: taskColumns.id }),
);

export interface OpenTask {
  id: string;
  event_id: string;
  description: string;
  due_date: DateOnly;
  event_name: string;
}

export const parseOpenTask: RowParser<OpenTask> = rowParser(
  "tasks",
  "id",
  z
    .object({
      id: taskColumns.id,
      event_id: taskColumns.eventId,
      description: taskColumns.description,
      due_date: taskColumns.dueDate,
      events: z.object({ name: eventColumns.name }),
    })
    .transform(({ events: event, ...task }): OpenTask => ({
      ...task,
      event_name: event.name,
    })),
);

export interface StaleClaim {
  task_id: string;
  kind: ReminderKind;
  due_date: DateOnly;
  claim_token: string;
  attempts: number;
  /** Attempts known not to have reached anyone. */
  refused_attempts: number;
  claimed_at: string;
}

export const parseStaleClaim: RowParser<StaleClaim> = rowParser(
  "reminder_log",
  "task_id",
  z.object({
    task_id: reminderLogColumns.taskId,
    kind: reminderLogColumns.kind,
    due_date: reminderLogColumns.dueDate,
    claim_token: reminderLogColumns.claimToken,
    attempts: reminderLogColumns.attempts,
    refused_attempts: reminderLogColumns.refusedAttempts,
    claimed_at: reminderLogColumns.claimedAt,
  }),
);

export const parseClaimState = rowParser(
  "reminder_log",
  "task_id",
  z.object({
    state: reminderLogColumns.state,
    claim_token: reminderLogColumns.claimToken,
  }),
);

export const parseTaskLiveness = rowParser(
  "tasks",
  "id",
  z.object({
    due_date: taskColumns.dueDate,
    status: taskColumns.status,
    deleted_at: taskColumns.deletedAt,
  }),
);

/**
 * One task the reminder run may act on. `task`, `event` and `log` have the shapes
 * the planner takes.
 */
export interface ReminderCandidate {
  guild_id: string;
  timezone: string;
  assignee_id: string;
  description: string;
  event_name: string;
  /** The version this read saw, for a claim to compare with. */
  updated_at: string;
  /** Runs in a row the event's thread has refused the bot. */
  thread_refusals: number;
  task: PlanTask;
  event: PlanEvent;
  log: ReminderLogRow[];
}

export const parseReminderCandidate: RowParser<ReminderCandidate> = rowParser(
  "tasks",
  "id",
  z
    .object({
      id: taskColumns.id,
      event_id: taskColumns.eventId,
      guild_id: taskColumns.guildId,
      assignee_id: taskColumns.assigneeId,
      description: taskColumns.description,
      due_date: taskColumns.dueDate,
      status: taskColumns.status,
      updated_at: taskColumns.updatedAt,
      events: z.object({
        id: eventColumns.id,
        name: eventColumns.name,
        thread_id: eventColumns.threadId,
        status: eventColumns.status,
        thread_status: eventColumns.threadStatus,
        thread_refusals: eventColumns.threadRefusals,
        managed_channels: z.object({
          guild_config: z.object({ timezone: guildConfigColumns.timezone }),
        }),
      }),
      reminder_log: z.array(
        z.object({
          kind: reminderLogColumns.kind,
          due_date: reminderLogColumns.dueDate,
          state: reminderLogColumns.state,
          claimed_at: LooseDate,
        }),
      ),
    })
    .transform((row): ReminderCandidate => ({
      guild_id: row.guild_id,
      timezone: row.events.managed_channels.guild_config.timezone,
      assignee_id: row.assignee_id,
      description: row.description,
      event_name: row.events.name,
      updated_at: row.updated_at,
      thread_refusals: row.events.thread_refusals,
      task: {
        id: row.id,
        eventId: row.event_id,
        dueDate: row.due_date,
        status: row.status,
        // The query only returns live tasks.
        deleted: false,
      },
      event: {
        id: row.events.id,
        threadId: row.events.thread_id,
        status: row.events.status,
        threadStatus: row.events.thread_status,
        // The query only returns live events on active channels.
        deleted: false,
        forumManaged: true,
      },
      log: row.reminder_log.map((log) => ({
        taskId: row.id,
        dueDate: log.due_date,
        kind: log.kind,
        state: log.state,
        claimedAt: log.claimed_at,
      })),
    })),
);

/** Where the planner's next page starts. */
export const parseCandidateCursor = rowParser(
  "tasks",
  "id",
  z
    .object({ due_date: taskColumns.dueDate, id: taskColumns.id })
    .transform(({ due_date: dueDate, id }) => ({ dueDate, id })),
);

export interface JobRun {
  id: string;
  job_name: string;
  status: JobRunStatus;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  results: Readonly<Record<string, unknown>>;
  error: string | null;
}

export const parseJobRun: RowParser<JobRun> = rowParser(
  "job_runs",
  "id",
  z.object(fields(jobRunColumns, JOB_RUN_FIELDS)),
);

export interface SetupDraft {
  guild_id: string;
  actor_id: string;
  officer_role_id: string;
  admin_role_id: string;
  eboard_role_id: string;
  events_committee_role_id: string;
  treasury_role_id: string;
  marketing_role_id: string;
  fingerprint: string;
  created_at: string;
}

export const parseSetupDraft: RowParser<SetupDraft> = rowParser(
  "setup_drafts",
  "guild_id",
  z.object(fields(setupDraftColumns, SETUP_DRAFT_FIELDS)),
);

export interface EventStep {
  event_id: string;
  kind: EventStepKind;
  status: TaskStatus;
  completed_at: string | null;
  completed_by: string | null;
  handoff_claimed_at: string | null;
  handoff_sent_at: string | null;
}

const EventStepRow = z.object({
  event_id: eventStepColumns.eventId,
  kind: eventStepColumns.kind,
  status: eventStepColumns.status,
  completed_at: eventStepColumns.completedAt,
  completed_by: eventStepColumns.completedBy,
  handoff_claimed_at: eventStepColumns.handoffClaimedAt,
  handoff_sent_at: eventStepColumns.handoffSentAt,
});

/** A live assignment. Removed ones are never returned. */
export interface StepAssignee {
  id: string;
  event_id: string;
  kind: AssignableStepKind;
  user_id: string;
  assigned_by: string;
  created_at: string;
}

const StepAssigneeRow = z.object({
  id: assigneeColumns.id,
  event_id: assigneeColumns.eventId,
  kind: assigneeColumns.kind,
  user_id: assigneeColumns.userId,
  assigned_by: assigneeColumns.assignedBy,
  created_at: assigneeColumns.createdAt,
});

/** One event's steps and the people on them, oldest assignment first. */
export interface EventWorkflow {
  event_id: string;
  /** `HH:MM` in the guild's timezone on the event's date, or null if not set. */
  pickup_time: string | null;
  /** One per kind, in the order of `EVENT_STEP_KINDS`. */
  steps: EventStep[];
  assignees: StepAssignee[];
}

export const parseEventWorkflow: RowParser<EventWorkflow> = rowParser(
  "events",
  "id",
  z
    .object({
      id: eventColumns.id,
      pickup_time: eventColumns.pickupTime,
      event_steps: z.array(EventStepRow),
      event_step_assignees: z.array(StepAssigneeRow),
    })
    .transform((row, context): EventWorkflow => {
      const steps: EventStep[] = [];
      for (const kind of EVENT_STEP_KINDS) {
        const step = row.event_steps.find((each) => each.kind === kind);
        if (step === undefined) {
          context.addIssue({
            code: "custom",
            message: "missing step",
            path: ["event_steps", kind],
          });
          return z.NEVER;
        }
        steps.push(step);
      }
      return {
        event_id: row.id,
        pickup_time: row.pickup_time,
        steps,
        assignees: [...row.event_step_assignees].sort(byCreation),
      };
    }),
);

/** One of a member's live assignments, for /mytasks. */
export interface UserStep {
  assignment_id: string;
  event_id: string;
  event_name: string;
  event_date: DateOnly;
  kind: AssignableStepKind;
  step_status: TaskStatus;
  /** `HH:MM`, or null if not set. */
  pickup_time: string | null;
}

const StepStatusRow = z.object({
  kind: eventStepColumns.kind,
  status: eventStepColumns.status,
});

export const parseUserStep: RowParser<UserStep> = rowParser(
  "event_step_assignees",
  "id",
  z
    .object({
      id: assigneeColumns.id,
      kind: assigneeColumns.kind,
      events: z.object({
        id: eventColumns.id,
        name: eventColumns.name,
        event_date: eventColumns.eventDate,
        pickup_time: eventColumns.pickupTime,
        event_steps: z.array(StepStatusRow),
      }),
    })
    .transform((row, context): UserStep => {
      const step = row.events.event_steps.find(
        (candidate) => candidate.kind === row.kind,
      );
      if (step === undefined) {
        context.addIssue({
          code: "custom",
          message: "missing step",
          path: ["events", "event_steps", row.kind],
        });
        return z.NEVER;
      }
      return {
        assignment_id: row.id,
        event_id: row.events.id,
        event_name: row.events.name,
        event_date: row.events.event_date,
        kind: row.kind,
        step_status: step.status,
        pickup_time: row.events.pickup_time,
      };
    }),
);

export interface EventReminderLogRow {
  kind: EventReminderKind;
  reminder_date: DateOnly;
  state: ReminderState;
  /** An unreadable value is kept as an invalid Date, which a planner should treat as stale. */
  claimed_at: Date;
}

/**
 * A live, active event on an active channel in a guild with reminders on, dated on or after
 * the date asked for, with what the event reminder run needs to plan its messages.
 */
export interface EventReminderCandidate {
  id: string;
  guild_id: string;
  name: string;
  event_date: DateOnly;
  thread_id: string | null;
  thread_status: ThreadStatus;
  created_by: string;
  thread_refusals: number;
  /** `HH:MM`, or null if not set. */
  pickup_time: string | null;
  timezone: string;
  /** The Events Directors role, pinged for a step nobody is assigned to. */
  events_director_role_id: string;
  steps: { kind: EventStepKind; status: TaskStatus }[];
  /** Live assignments only, oldest first. */
  assignees: { kind: AssignableStepKind; user_id: string }[];
  /** Log rows dated on or after the date asked for. */
  log: EventReminderLogRow[];
}

export const parseEventReminderCandidate: RowParser<EventReminderCandidate> =
  rowParser(
    "events",
    "id",
    z
      .object({
        id: eventColumns.id,
        guild_id: eventColumns.guildId,
        name: eventColumns.name,
        event_date: eventColumns.eventDate,
        thread_id: eventColumns.threadId,
        thread_status: eventColumns.threadStatus,
        created_by: eventColumns.createdBy,
        thread_refusals: eventColumns.threadRefusals,
        pickup_time: eventColumns.pickupTime,
        managed_channels: z.object({
          guild_config: z.object({
            timezone: guildConfigColumns.timezone,
            officer_role_id: guildConfigColumns.officerRoleId,
          }),
        }),
        event_steps: z.array(StepStatusRow),
        event_step_assignees: z.array(
          z.object({
            id: assigneeColumns.id,
            kind: assigneeColumns.kind,
            user_id: assigneeColumns.userId,
            created_at: assigneeColumns.createdAt,
          }),
        ),
        event_reminder_log: z.array(
          z.object({
            kind: eventReminderLogColumns.kind,
            reminder_date: eventReminderLogColumns.reminderDate,
            state: eventReminderLogColumns.state,
            claimed_at: LooseDate,
          }),
        ),
      })
      .transform(
        ({
          managed_channels: channel,
          event_steps: steps,
          event_step_assignees: assignees,
          event_reminder_log: log,
          ...event
        }): EventReminderCandidate => ({
          ...event,
          timezone: channel.guild_config.timezone,
          events_director_role_id: channel.guild_config.officer_role_id,
          steps,
          assignees: [...assignees]
            .sort(byCreation)
            .map(({ kind, user_id }) => ({ kind, user_id })),
          log,
        }),
      ),
  );

export interface EventReminderStaleClaim {
  event_id: string;
  kind: EventReminderKind;
  reminder_date: DateOnly;
  claim_token: string;
  attempts: number;
  claimed_at: string;
}

export const parseEventReminderStaleClaim: RowParser<EventReminderStaleClaim> =
  rowParser(
    "event_reminder_log",
    "event_id",
    z.object({
      event_id: eventReminderLogColumns.eventId,
      kind: eventReminderLogColumns.kind,
      reminder_date: eventReminderLogColumns.reminderDate,
      claim_token: eventReminderLogColumns.claimToken,
      attempts: eventReminderLogColumns.attempts,
      claimed_at: eventReminderLogColumns.claimedAt,
    }),
  );

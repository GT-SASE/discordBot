/**
 * The schema as the bot's role sees it, and the checks every row passes when read.
 *
 * `Database` follows supabase/migrations. Insert and Update list only what the role
 * is granted, so writing any other column fails to compile, and `deleted_at` cannot
 * be set back to null. Rows from the API are treated as unknown and go through a
 * parser here: a row that fails is left out and reported, never cast.
 */

import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type {
  PlanEvent,
  PlanTask,
  ReminderKind,
  ReminderLogRow,
  ReminderState,
} from "../reminders/plan.ts";
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

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type NoWrites = Record<string, never>;

export interface Database {
  public: {
    Tables: {
      guild_config: {
        Row: {
          guild_id: string;
          officer_role_id: string;
          admin_role_id: string;
          eboard_role_id: string | null;
          events_committee_role_id: string | null;
          treasury_role_id: string | null;
          marketing_role_id: string | null;
          timezone: string;
          reminders_enabled: boolean;
          version: number;
          created_at: string;
          updated_at: string;
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [];
      };
      managed_channels: {
        Row: {
          guild_id: string;
          channel_id: string;
          status: ManagedChannelStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [
          {
            foreignKeyName: "managed_channels_guild_id_fkey";
            columns: ["guild_id"];
            isOneToOne: false;
            referencedRelation: "guild_config";
            referencedColumns: ["guild_id"];
          },
        ];
      };
      events: {
        Row: {
          id: string;
          guild_id: string;
          channel_id: string;
          name: string;
          event_date: string;
          thread_id: string | null;
          overview_message_id: string | null;
          status: EventStatus;
          thread_status: ThreadStatus;
          created_by: string;
          deleted_at: string | null;
          post_attempt_at: string | null;
          thread_refusals: number;
          pickup_time: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          guild_id: string;
          channel_id: string;
          name: string;
          event_date: string;
          created_by: string;
          thread_id?: string;
          thread_status?: ThreadStatus;
        };
        Update: {
          name?: string;
          event_date?: string;
          thread_id?: string;
          overview_message_id?: string;
          status?: EventStatus;
          thread_status?: ThreadStatus;
        };
        Relationships: [
          {
            foreignKeyName: "events_guild_id_channel_id_fkey";
            columns: ["guild_id", "channel_id"];
            isOneToOne: false;
            referencedRelation: "managed_channels";
            referencedColumns: ["guild_id", "channel_id"];
          },
        ];
      };
      tasks: {
        Row: {
          id: string;
          event_id: string;
          guild_id: string;
          assignee_id: string;
          description: string;
          due_date: string;
          status: TaskStatus;
          completed_at: string | null;
          created_by: string;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          event_id: string;
          guild_id: string;
          assignee_id: string;
          description: string;
          due_date: string;
          created_by: string;
        };
        Update: {
          assignee_id?: string;
          description?: string;
          due_date?: string;
          status?: "done";
          completed_at?: string;
          deleted_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_event_id_guild_id_fkey";
            columns: ["event_id", "guild_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id", "guild_id"];
          },
        ];
      };
      reminder_log: {
        Row: {
          task_id: string;
          kind: ReminderKind;
          due_date: string;
          state: ReminderState;
          claim_token: string;
          attempts: number;
          refused_attempts: number;
          claimed_at: string;
          sent_at: string | null;
          message_id: string | null;
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [
          {
            foreignKeyName: "reminder_log_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      job_runs: {
        Row: {
          id: string;
          job_name: string;
          status: JobRunStatus;
          started_at: string;
          heartbeat_at: string;
          finished_at: string | null;
          results: Json;
          error: string | null;
        };
        // Written only through begin_job_run and finish_job_run.
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [];
      };
      // Read only by its trigger, so a row has nothing the bot may select.
      task_reassignments: {
        Row: Record<"", never>;
        Insert: { guild_id: string; actor_id: string; task_id: string };
        Update: NoWrites;
        Relationships: [];
      };
      config_audit: {
        Row: {
          id: number;
          guild_id: string;
          actor_id: string;
          action: ConfigAuditAction;
          old_values: Json;
          new_values: Json;
          version_after: number;
          created_at: string;
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [];
      };
      // Written only through save_setup_draft.
      setup_drafts: {
        Row: {
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
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [];
      };
      // Written only through the step functions.
      event_steps: {
        Row: {
          event_id: string;
          guild_id: string;
          kind: EventStepKind;
          status: TaskStatus;
          completed_at: string | null;
          completed_by: string | null;
          handoff_claimed_at: string | null;
          handoff_sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [
          {
            foreignKeyName: "event_steps_event_id_guild_id_fkey";
            columns: ["event_id", "guild_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id", "guild_id"];
          },
        ];
      };
      event_step_assignees: {
        Row: {
          id: string;
          event_id: string;
          guild_id: string;
          kind: AssignableStepKind;
          user_id: string;
          assigned_by: string;
          removed_at: string | null;
          removed_by: string | null;
          created_at: string;
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [
          {
            foreignKeyName: "event_step_assignees_event_id_guild_id_fkey";
            columns: ["event_id", "guild_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id", "guild_id"];
          },
        ];
      };
      event_reminder_log: {
        Row: {
          event_id: string;
          kind: EventReminderKind;
          reminder_date: string;
          state: ReminderState;
          claim_token: string;
          attempts: number;
          claimed_at: string;
          sent_at: string | null;
          message_id: string | null;
        };
        Insert: NoWrites;
        Update: NoWrites;
        Relationships: [
          {
            foreignKeyName: "event_reminder_log_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    // No views. The client's generics need this key, and an empty object type fails
    // lint, so it has one unusable entry instead.
    Views: Record<"", never>;
    Functions: {
      soft_delete_event: {
        Args: { p_event_id: string; p_guild_id: string };
        Returns: number | null;
      };
      claim_event_post_attempt: {
        Args: { p_event_id: string; p_guild_id: string };
        Returns: boolean;
      };
      release_event_post_attempt: {
        Args: { p_event_id: string; p_guild_id: string };
        Returns: boolean;
      };
      claim_reminder: {
        Args: {
          p_task_id: string;
          p_kind: ReminderKind;
          p_due_date: string;
          p_assignee_id: string | null;
          p_updated_at: string | null;
        };
        Returns: string | null;
      };
      claim_reminders: {
        Args: {
          p_task_ids: string[];
          p_kinds: ReminderKind[];
          p_due_dates: string[];
          p_assignee_ids: (string | null)[];
          p_updated_ats: (string | null)[];
        };
        Returns: Json;
      };
      record_reminder_refused: {
        Args: {
          p_task_id: string;
          p_kind: ReminderKind;
          p_due_date: string;
          p_claim_token: string;
        };
        Returns: boolean;
      };
      record_thread_refusal: {
        Args: { p_event_id: string; p_guild_id: string };
        Returns: number | null;
      };
      clear_thread_refusals: {
        Args: { p_event_id: string; p_guild_id: string };
        Returns: boolean;
      };
      reclaim_reminder: {
        Args: {
          p_task_id: string;
          p_kind: ReminderKind;
          p_due_date: string;
          p_claim_token: string;
          p_assignee_id: string | null;
          p_updated_at: string | null;
        };
        Returns: string | null;
      };
      mark_reminder_sent: {
        Args: {
          p_task_id: string;
          p_kind: ReminderKind;
          p_due_date: string;
          p_claim_token: string;
          p_message_id: string;
        };
        Returns: boolean;
      };
      mark_reminders_sent: {
        Args: {
          p_task_ids: string[];
          p_kinds: ReminderKind[];
          p_due_dates: string[];
          p_claim_tokens: string[];
          p_message_id: string;
        };
        Returns: Json;
      };
      mark_reminder_skipped: {
        Args: {
          p_task_id: string;
          p_kind: ReminderKind;
          p_due_date: string;
          p_claim_token: string;
        };
        Returns: boolean;
      };
      claim_interaction: {
        Args: { p_interaction_id: string };
        Returns: boolean;
      };
      expire_interaction_claims: {
        Args: Record<string, never>;
        Returns: number;
      };
      apply_role_bindings: {
        Args: {
          p_guild_id: string;
          p_expected_version: number;
          p_actor_id: string;
          p_officer_role_id: string;
          p_admin_role_id: string;
          p_eboard_role_id: string | null;
          p_events_committee_role_id: string | null;
          p_treasury_role_id: string | null;
          p_marketing_role_id: string | null;
        };
        Returns: number;
      };
      save_setup_draft: {
        Args: {
          p_guild_id: string;
          p_actor_id: string;
          p_officer_role_id: string;
          p_admin_role_id: string;
          p_eboard_role_id: string;
          p_events_committee_role_id: string;
          p_treasury_role_id: string;
          p_marketing_role_id: string;
          p_fingerprint: string;
        };
        Returns: boolean;
      };
      assign_event_step: {
        Args: {
          p_event_id: string;
          p_guild_id: string;
          p_kind: AssignableStepKind;
          p_user_id: string;
          p_actor_id: string;
        };
        // Null when there is no live event with that ID in that guild.
        Returns: boolean | null;
      };
      unassign_event_step: {
        Args: {
          p_event_id: string;
          p_guild_id: string;
          p_kind: AssignableStepKind;
          p_user_id: string;
          p_actor_id: string;
        };
        Returns: boolean | null;
      };
      complete_event_step: {
        Args: {
          p_event_id: string;
          p_guild_id: string;
          p_kind: CompletableStepKind;
          p_actor_id: string;
        };
        Returns: boolean | null;
      };
      claim_step_handoff: {
        Args: {
          p_event_id: string;
          p_guild_id: string;
          p_kind: CompletableStepKind;
        };
        Returns: boolean;
      };
      mark_step_handoff_sent: {
        Args: {
          p_event_id: string;
          p_guild_id: string;
          p_kind: CompletableStepKind;
        };
        Returns: boolean;
      };
      set_event_pickup_time: {
        Args: {
          p_event_id: string;
          p_guild_id: string;
          p_pickup_time: string;
          p_actor_id: string;
        };
        Returns: boolean | null;
      };
      claim_event_reminder: {
        Args: {
          p_event_id: string;
          p_kind: EventReminderKind;
          p_reminder_date: string;
        };
        Returns: string | null;
      };
      reclaim_event_reminder: {
        Args: {
          p_event_id: string;
          p_kind: EventReminderKind;
          p_reminder_date: string;
          p_claim_token: string;
        };
        Returns: string | null;
      };
      mark_event_reminder_sent: {
        Args: {
          p_event_id: string;
          p_kind: EventReminderKind;
          p_reminder_date: string;
          p_claim_token: string;
          p_message_id: string;
        };
        Returns: boolean;
      };
      mark_event_reminder_skipped: {
        Args: {
          p_event_id: string;
          p_kind: EventReminderKind;
          p_reminder_date: string;
          p_claim_token: string;
        };
        Returns: boolean;
      };
      apply_config_change: {
        Args: {
          p_guild_id: string;
          p_expected_version: number;
          p_actor_id: string;
          p_reminders_enabled: boolean | null;
          p_add_channel_ids: string[];
          p_remove_channel_ids: string[];
          p_timezone: string | null;
        };
        Returns: number;
      };
      mark_channel_unavailable: {
        Args: { p_guild_id: string; p_channel_id: string };
        Returns: boolean;
      };
      begin_job_run: {
        Args: {
          p_job_name: string;
          p_stale_after_seconds: number;
        };
        Returns: string | null;
      };
      finish_job_run: {
        Args: {
          p_id: string;
          p_finished_at: string;
          p_results: Json;
          p_error: string | null;
        };
        // An array of the finished row, or an empty one if nothing was finished.
        Returns: Json;
      };
    };
  };
}

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

class BadField extends Error {
  readonly field: string;

  constructor(field: string) {
    super("bad field");
    this.field = field;
  }
}

const TIME_OF_DAY =
  /^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,6})?)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readerFor(record: Record<string, unknown>) {
  const raw = (name: string): unknown =>
    Object.hasOwn(record, name) ? record[name] : undefined;

  function check<T>(name: string, isValid: (value: unknown) => value is T): T {
    const value = raw(name);
    if (!isValid(value)) {
      throw new BadField(name);
    }
    return value;
  }

  const isText = (value: unknown): value is string => typeof value === "string";

  const nested = <T>(name: string, parse: RowParser<T>, value: unknown): T => {
    const result = parse(value);
    if (!result.ok) {
      throw new BadField(`${name}.${result.excluded.field}`);
    }
    return result.row;
  };

  return {
    text: (name: string): string => check(name, isText),
    nullableText: (name: string): string | null =>
      raw(name) === null ? null : check(name, isText),
    snowflake: (name: string): string => check(name, isSnowflake),
    nullableSnowflake: (name: string): string | null =>
      raw(name) === null ? null : check(name, isSnowflake),
    uuid: (name: string): string => check(name, isUuid),
    date: (name: string): DateOnly => {
      const parsed = parseIsoDate(check(name, isText));
      if (parsed === null) {
        throw new BadField(name);
      }
      return parsed;
    },
    /** Kept as the exact text, so it can be sent back as an expected value. */
    timestamp: (name: string): string => check(name, isTimestampText),
    nullableTimestamp: (name: string): string | null =>
      raw(name) === null ? null : check(name, isTimestampText),
    /** A time of day as Postgres gives it, kept as `HH:MM`. */
    nullableTimeOfDay: (name: string): string | null => {
      if (raw(name) === null) {
        return null;
      }
      const value = check(name, isText);
      if (!TIME_OF_DAY.test(value)) {
        throw new BadField(name);
      }
      return value.slice(0, 5);
    },
    /** Keeps an unreadable value as an invalid Date, which the planner treats as stale. */
    looseDate: (name: string): Date => {
      const value = raw(name);
      return new Date(typeof value === "string" ? value : Number.NaN);
    },
    integer: (name: string): number =>
      check(name, (value): value is number => Number.isSafeInteger(value)),
    boolean: (name: string): boolean =>
      check(name, (value): value is boolean => typeof value === "boolean"),
    oneOf: <const T extends string>(name: string, allowed: readonly T[]): T =>
      check(name, (value): value is T =>
        allowed.some((candidate) => candidate === value),
      ),
    object: (name: string): Readonly<Record<string, unknown>> =>
      check(name, isRecord),
    nullableObject: (name: string): Readonly<Record<string, unknown>> | null =>
      raw(name) === null ? null : check(name, isRecord),
    one: <T>(name: string, parse: RowParser<T>): T =>
      nested(name, parse, raw(name)),
    many: <T>(name: string, parse: RowParser<T>): T[] =>
      check(name, (value): value is unknown[] => Array.isArray(value)).map(
        (item) => nested(name, parse, item),
      ),
  };
}

type RowReader = ReturnType<typeof readerFor>;

function rowParser<T>(
  table: string,
  idColumn: string,
  build: (read: RowReader) => T,
): RowParser<T> {
  return (raw) => {
    if (!isRecord(raw)) {
      return { ok: false, excluded: { table, field: "(row)", id: null } };
    }
    try {
      return { ok: true, row: build(readerFor(raw)) };
    } catch (error) {
      if (error instanceof BadField) {
        const id = Object.hasOwn(raw, idColumn) ? raw[idColumn] : null;
        return {
          ok: false,
          excluded: {
            table,
            field: error.field,
            id: isUuid(id) || isSnowflake(id) ? id : null,
          },
        };
      }
      throw error;
    }
  };
}

const CHANNEL_STATUSES = ["active", "unavailable", "removed"] as const;
const EVENT_STATUSES = ["active", "closed"] as const;
const THREAD_STATUSES = ["pending", "active", "missing"] as const;
const TASK_STATUSES = ["open", "done"] as const;
const REMINDER_KINDS = ["three_days", "one_day", "due_day", "overdue"] as const;
const REMINDER_STATES = ["claimed", "sent", "skipped"] as const;
const JOB_STATUSES = ["running", "succeeded", "failed"] as const;
const AUDIT_ACTIONS = ["role_bindings", "settings"] as const;
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

export const parseGuildConfig = rowParser(
  "guild_config",
  "guild_id",
  (read): GuildConfig => ({
    guild_id: read.snowflake("guild_id"),
    officer_role_id: read.snowflake("officer_role_id"),
    admin_role_id: read.snowflake("admin_role_id"),
    eboard_role_id: read.nullableSnowflake("eboard_role_id"),
    events_committee_role_id: read.nullableSnowflake(
      "events_committee_role_id",
    ),
    treasury_role_id: read.nullableSnowflake("treasury_role_id"),
    marketing_role_id: read.nullableSnowflake("marketing_role_id"),
    timezone: read.text("timezone"),
    reminders_enabled: read.boolean("reminders_enabled"),
    version: read.integer("version"),
  }),
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

export const parseConfigChange = rowParser(
  "config_audit",
  "id",
  (read): ConfigChange => ({
    id: read.integer("id"),
    actor_id: read.snowflake("actor_id"),
    action: read.oneOf("action", AUDIT_ACTIONS),
    old_values: read.nullableObject("old_values"),
    new_values: read.object("new_values"),
    version_after: read.integer("version_after"),
    created_at: read.timestamp("created_at"),
  }),
);

export interface ManagedChannel {
  guild_id: string;
  channel_id: string;
  status: ManagedChannelStatus;
}

export const parseManagedChannel = rowParser(
  "managed_channels",
  "channel_id",
  (read): ManagedChannel => ({
    guild_id: read.snowflake("guild_id"),
    channel_id: read.snowflake("channel_id"),
    status: read.oneOf("status", CHANNEL_STATUSES),
  }),
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

export const parseEvent = rowParser("events", "id", (read): EventRow => ({
  id: read.uuid("id"),
  guild_id: read.snowflake("guild_id"),
  channel_id: read.snowflake("channel_id"),
  name: read.text("name"),
  event_date: read.date("event_date"),
  thread_id: read.nullableSnowflake("thread_id"),
  overview_message_id: read.nullableSnowflake("overview_message_id"),
  status: read.oneOf("status", EVENT_STATUSES),
  thread_status: read.oneOf("thread_status", THREAD_STATUSES),
  created_by: read.snowflake("created_by"),
  deleted_at: read.nullableTimestamp("deleted_at"),
  created_at: read.timestamp("created_at"),
}));

export interface EventChoice {
  id: string;
  name: string;
  event_date: DateOnly;
  status: EventStatus;
}

export const parseEventChoice = rowParser(
  "events",
  "id",
  (read): EventChoice => ({
    id: read.uuid("id"),
    name: read.text("name"),
    event_date: read.date("event_date"),
    status: read.oneOf("status", EVENT_STATUSES),
  }),
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

export const parseTask = rowParser("tasks", "id", (read): TaskRow => ({
  id: read.uuid("id"),
  event_id: read.uuid("event_id"),
  guild_id: read.snowflake("guild_id"),
  assignee_id: read.snowflake("assignee_id"),
  description: read.text("description"),
  due_date: read.date("due_date"),
  status: read.oneOf("status", TASK_STATUSES),
  completed_at: read.nullableTimestamp("completed_at"),
  created_by: read.snowflake("created_by"),
  deleted_at: read.nullableTimestamp("deleted_at"),
  updated_at: read.timestamp("updated_at"),
}));

export interface TaskChoice {
  id: string;
  description: string;
  due_date: DateOnly;
}

export const parseTaskChoice = rowParser("tasks", "id", (read): TaskChoice => ({
  id: read.uuid("id"),
  description: read.text("description"),
  due_date: read.date("due_date"),
}));

export interface LiveTaskChoice extends TaskChoice {
  status: TaskStatus;
}

export const parseLiveTaskChoice = rowParser(
  "tasks",
  "id",
  (read): LiveTaskChoice => ({
    id: read.uuid("id"),
    description: read.text("description"),
    due_date: read.date("due_date"),
    status: read.oneOf("status", TASK_STATUSES),
  }),
);

export interface TaskId {
  id: string;
}

export const parseTaskId = rowParser("tasks", "id", (read): TaskId => ({
  id: read.uuid("id"),
}));

export interface OpenTask {
  id: string;
  event_id: string;
  description: string;
  due_date: DateOnly;
  event_name: string;
}

const parseEventName = rowParser("events", "id", (read) => read.text("name"));

export const parseOpenTask = rowParser("tasks", "id", (read): OpenTask => ({
  id: read.uuid("id"),
  event_id: read.uuid("event_id"),
  description: read.text("description"),
  due_date: read.date("due_date"),
  event_name: read.one("events", parseEventName),
}));

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

export const parseStaleClaim = rowParser(
  "reminder_log",
  "task_id",
  (read): StaleClaim => ({
    task_id: read.uuid("task_id"),
    kind: read.oneOf("kind", REMINDER_KINDS),
    due_date: read.date("due_date"),
    claim_token: read.uuid("claim_token"),
    attempts: read.integer("attempts"),
    refused_attempts: read.integer("refused_attempts"),
    claimed_at: read.timestamp("claimed_at"),
  }),
);

export const parseClaimState = rowParser("reminder_log", "task_id", (read) => ({
  state: read.oneOf("state", REMINDER_STATES),
  claim_token: read.uuid("claim_token"),
}));

export const parseTaskLiveness = rowParser("tasks", "id", (read) => ({
  due_date: read.date("due_date"),
  status: read.oneOf("status", TASK_STATUSES),
  deleted_at: read.nullableTimestamp("deleted_at"),
}));

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

const parseGuildTimezone = rowParser("guild_config", "guild_id", (read) =>
  read.text("timezone"),
);

const parseChannelTimezone = rowParser(
  "managed_channels",
  "channel_id",
  (read) => read.one("guild_config", parseGuildTimezone),
);

const parseCandidateEvent = rowParser("events", "id", (read) => ({
  name: read.text("name"),
  threadRefusals: read.integer("thread_refusals"),
  timezone: read.one("managed_channels", parseChannelTimezone),
  planEvent: {
    id: read.uuid("id"),
    threadId: read.nullableSnowflake("thread_id"),
    status: read.oneOf("status", EVENT_STATUSES),
    threadStatus: read.oneOf("thread_status", THREAD_STATUSES),
    // The query only returns live events on active channels.
    deleted: false,
    forumManaged: true,
  } satisfies PlanEvent,
}));

const parseCandidateLog = (taskId: string) =>
  rowParser("reminder_log", "task_id", (read): ReminderLogRow => ({
    taskId,
    dueDate: read.date("due_date"),
    kind: read.oneOf("kind", REMINDER_KINDS),
    state: read.oneOf("state", REMINDER_STATES),
    claimedAt: read.looseDate("claimed_at"),
  }));

export const parseReminderCandidate = rowParser(
  "tasks",
  "id",
  (read): ReminderCandidate => {
    const id = read.uuid("id");
    const event = read.one("events", parseCandidateEvent);
    return {
      guild_id: read.snowflake("guild_id"),
      timezone: event.timezone,
      assignee_id: read.snowflake("assignee_id"),
      description: read.text("description"),
      event_name: event.name,
      updated_at: read.timestamp("updated_at"),
      thread_refusals: event.threadRefusals,
      task: {
        id,
        eventId: read.uuid("event_id"),
        dueDate: read.date("due_date"),
        status: read.oneOf("status", TASK_STATUSES),
        // The query only returns live tasks.
        deleted: false,
      },
      event: event.planEvent,
      log: read.many("reminder_log", parseCandidateLog(id)),
    };
  },
);

/** Where the planner's next page starts. */
export const parseCandidateCursor = rowParser("tasks", "id", (read) => ({
  dueDate: read.date("due_date"),
  id: read.uuid("id"),
}));

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

export const parseJobRun = rowParser("job_runs", "id", (read): JobRun => ({
  id: read.uuid("id"),
  job_name: read.text("job_name"),
  status: read.oneOf("status", JOB_STATUSES),
  started_at: read.timestamp("started_at"),
  heartbeat_at: read.timestamp("heartbeat_at"),
  finished_at: read.nullableTimestamp("finished_at"),
  results: read.object("results"),
  error: read.nullableText("error"),
}));

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

export const parseSetupDraft = rowParser(
  "setup_drafts",
  "guild_id",
  (read): SetupDraft => ({
    guild_id: read.snowflake("guild_id"),
    actor_id: read.snowflake("actor_id"),
    officer_role_id: read.snowflake("officer_role_id"),
    admin_role_id: read.snowflake("admin_role_id"),
    eboard_role_id: read.snowflake("eboard_role_id"),
    events_committee_role_id: read.snowflake("events_committee_role_id"),
    treasury_role_id: read.snowflake("treasury_role_id"),
    marketing_role_id: read.snowflake("marketing_role_id"),
    fingerprint: read.text("fingerprint"),
    created_at: read.timestamp("created_at"),
  }),
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

export const parseEventStep = rowParser(
  "event_steps",
  "event_id",
  (read): EventStep => ({
    event_id: read.uuid("event_id"),
    kind: read.oneOf("kind", EVENT_STEP_KINDS),
    status: read.oneOf("status", TASK_STATUSES),
    completed_at: read.nullableTimestamp("completed_at"),
    completed_by: read.nullableSnowflake("completed_by"),
    handoff_claimed_at: read.nullableTimestamp("handoff_claimed_at"),
    handoff_sent_at: read.nullableTimestamp("handoff_sent_at"),
  }),
);

/** A live assignment. Removed ones are never returned. */
export interface StepAssignee {
  id: string;
  event_id: string;
  kind: AssignableStepKind;
  user_id: string;
  assigned_by: string;
  created_at: string;
}

export const parseStepAssignee = rowParser(
  "event_step_assignees",
  "id",
  (read): StepAssignee => ({
    id: read.uuid("id"),
    event_id: read.uuid("event_id"),
    kind: read.oneOf("kind", ASSIGNABLE_STEP_KINDS),
    user_id: read.snowflake("user_id"),
    assigned_by: read.snowflake("assigned_by"),
    created_at: read.timestamp("created_at"),
  }),
);

/** One event's steps and the people on them, oldest assignment first. */
export interface EventWorkflow {
  event_id: string;
  /** `HH:MM` in the guild's timezone on the event's date, or null if not set. */
  pickup_time: string | null;
  /** One per kind, in the order of `EVENT_STEP_KINDS`. */
  steps: EventStep[];
  assignees: StepAssignee[];
}

function byCreation(a: StepAssignee, b: StepAssignee): number {
  return a.created_at === b.created_at
    ? a.id.localeCompare(b.id)
    : Date.parse(a.created_at) - Date.parse(b.created_at);
}

export const parseEventWorkflow = rowParser(
  "events",
  "id",
  (read): EventWorkflow => {
    const steps = read.many("event_steps", parseEventStep);
    const ordered = EVENT_STEP_KINDS.map((kind) => {
      const step = steps.find((candidate) => candidate.kind === kind);
      if (step === undefined) {
        throw new BadField(`event_steps.${kind}`);
      }
      return step;
    });
    return {
      event_id: read.uuid("id"),
      pickup_time: read.nullableTimeOfDay("pickup_time"),
      steps: ordered,
      assignees: read
        .many("event_step_assignees", parseStepAssignee)
        .sort(byCreation),
    };
  },
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

const parseStepStatus = rowParser("event_steps", "kind", (read) => ({
  kind: read.oneOf("kind", EVENT_STEP_KINDS),
  status: read.oneOf("status", TASK_STATUSES),
}));

const parseUserStepEvent = rowParser("events", "id", (read) => ({
  id: read.uuid("id"),
  name: read.text("name"),
  event_date: read.date("event_date"),
  pickup_time: read.nullableTimeOfDay("pickup_time"),
  steps: read.many("event_steps", parseStepStatus),
}));

export const parseUserStep = rowParser(
  "event_step_assignees",
  "id",
  (read): UserStep => {
    const kind = read.oneOf("kind", ASSIGNABLE_STEP_KINDS);
    const event = read.one("events", parseUserStepEvent);
    const step = event.steps.find((candidate) => candidate.kind === kind);
    if (step === undefined) {
      throw new BadField(`events.event_steps.${kind}`);
    }
    return {
      assignment_id: read.uuid("id"),
      event_id: event.id,
      event_name: event.name,
      event_date: event.event_date,
      kind,
      step_status: step.status,
      pickup_time: event.pickup_time,
    };
  },
);

export interface EventReminderLogRow {
  kind: EventReminderKind;
  reminder_date: DateOnly;
  state: ReminderState;
  /** An unreadable value is kept as an invalid Date, which a planner should treat as stale. */
  claimed_at: Date;
}

const parseEventReminderLogRow = rowParser(
  "event_reminder_log",
  "event_id",
  (read): EventReminderLogRow => ({
    kind: read.oneOf("kind", EVENT_REMINDER_KINDS),
    reminder_date: read.date("reminder_date"),
    state: read.oneOf("state", REMINDER_STATES),
    claimed_at: read.looseDate("claimed_at"),
  }),
);

const parseCandidateGuild = rowParser("guild_config", "guild_id", (read) => ({
  timezone: read.text("timezone"),
  officer_role_id: read.snowflake("officer_role_id"),
}));

const parseCandidateChannel = rowParser(
  "managed_channels",
  "channel_id",
  (read) => read.one("guild_config", parseCandidateGuild),
);

const parseCandidateAssignee = rowParser(
  "event_step_assignees",
  "id",
  (read) => ({
    id: read.uuid("id"),
    kind: read.oneOf("kind", ASSIGNABLE_STEP_KINDS),
    user_id: read.snowflake("user_id"),
    created_at: read.timestamp("created_at"),
  }),
);

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

export const parseEventReminderCandidate = rowParser(
  "events",
  "id",
  (read): EventReminderCandidate => {
    const guild = read.one("managed_channels", parseCandidateChannel);
    const assignees = read
      .many("event_step_assignees", parseCandidateAssignee)
      .sort((a, b) =>
        a.created_at === b.created_at
          ? a.id.localeCompare(b.id)
          : Date.parse(a.created_at) - Date.parse(b.created_at),
      );
    return {
      id: read.uuid("id"),
      guild_id: read.snowflake("guild_id"),
      name: read.text("name"),
      event_date: read.date("event_date"),
      thread_id: read.nullableSnowflake("thread_id"),
      thread_status: read.oneOf("thread_status", THREAD_STATUSES),
      created_by: read.snowflake("created_by"),
      thread_refusals: read.integer("thread_refusals"),
      pickup_time: read.nullableTimeOfDay("pickup_time"),
      timezone: guild.timezone,
      events_director_role_id: guild.officer_role_id,
      steps: read.many("event_steps", parseStepStatus),
      assignees: assignees.map(({ kind, user_id }) => ({ kind, user_id })),
      log: read.many("event_reminder_log", parseEventReminderLogRow),
    };
  },
);

export interface EventReminderStaleClaim {
  event_id: string;
  kind: EventReminderKind;
  reminder_date: DateOnly;
  claim_token: string;
  attempts: number;
  claimed_at: string;
}

export const parseEventReminderStaleClaim = rowParser(
  "event_reminder_log",
  "event_id",
  (read): EventReminderStaleClaim => ({
    event_id: read.uuid("event_id"),
    kind: read.oneOf("kind", EVENT_REMINDER_KINDS),
    reminder_date: read.date("reminder_date"),
    claim_token: read.uuid("claim_token"),
    attempts: read.integer("attempts"),
    claimed_at: read.timestamp("claimed_at"),
  }),
);

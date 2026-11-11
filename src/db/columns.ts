/**
 * The columns each read asks for, under the names the row checks in types.ts read. A
 * read lists what it needs and no more, so a column added later is never read by
 * accident.
 */

import { sql, type SQL } from "drizzle-orm";
import {
  configAudit,
  events,
  guildConfig,
  jobRuns,
  managedChannels,
  setupDrafts,
  tasks,
} from "./schema.ts";

export const GUILD_CONFIG_COLUMNS = {
  guild_id: guildConfig.guildId,
  officer_role_id: guildConfig.officerRoleId,
  admin_role_id: guildConfig.adminRoleId,
  eboard_role_id: guildConfig.eboardRoleId,
  events_committee_role_id: guildConfig.eventsCommitteeRoleId,
  treasury_role_id: guildConfig.treasuryRoleId,
  marketing_role_id: guildConfig.marketingRoleId,
  timezone: guildConfig.timezone,
  reminders_enabled: guildConfig.remindersEnabled,
  version: guildConfig.version,
};

export const SETUP_DRAFT_COLUMNS = {
  guild_id: setupDrafts.guildId,
  actor_id: setupDrafts.actorId,
  officer_role_id: setupDrafts.officerRoleId,
  admin_role_id: setupDrafts.adminRoleId,
  eboard_role_id: setupDrafts.eboardRoleId,
  events_committee_role_id: setupDrafts.eventsCommitteeRoleId,
  treasury_role_id: setupDrafts.treasuryRoleId,
  marketing_role_id: setupDrafts.marketingRoleId,
  fingerprint: setupDrafts.fingerprint,
  created_at: setupDrafts.createdAt,
};

export const CONFIG_CHANGE_COLUMNS = {
  id: configAudit.id,
  actor_id: configAudit.actorId,
  action: configAudit.action,
  old_values: configAudit.oldValues,
  new_values: configAudit.newValues,
  version_after: configAudit.versionAfter,
  created_at: configAudit.createdAt,
};

export const MANAGED_CHANNEL_COLUMNS = {
  guild_id: managedChannels.guildId,
  channel_id: managedChannels.channelId,
  status: managedChannels.status,
};

export const EVENT_COLUMNS = {
  id: events.id,
  guild_id: events.guildId,
  channel_id: events.channelId,
  name: events.name,
  event_date: events.eventDate,
  thread_id: events.threadId,
  overview_message_id: events.overviewMessageId,
  status: events.status,
  thread_status: events.threadStatus,
  created_by: events.createdBy,
  deleted_at: events.deletedAt,
  created_at: events.createdAt,
};

export const EVENT_CHOICE_COLUMNS = {
  id: events.id,
  name: events.name,
  event_date: events.eventDate,
  status: events.status,
};

export const TASK_COLUMNS = {
  id: tasks.id,
  event_id: tasks.eventId,
  guild_id: tasks.guildId,
  assignee_id: tasks.assigneeId,
  description: tasks.description,
  due_date: tasks.dueDate,
  status: tasks.status,
  completed_at: tasks.completedAt,
  created_by: tasks.createdBy,
  deleted_at: tasks.deletedAt,
  updated_at: tasks.updatedAt,
};

export const TASK_CHOICE_COLUMNS = {
  id: tasks.id,
  description: tasks.description,
  due_date: tasks.dueDate,
};

export const LIVE_TASK_CHOICE_COLUMNS = {
  ...TASK_CHOICE_COLUMNS,
  status: tasks.status,
};

export const JOB_RUN_COLUMNS = {
  id: jobRuns.id,
  job_name: jobRuns.jobName,
  status: jobRuns.status,
  started_at: jobRuns.startedAt,
  heartbeat_at: jobRuns.heartbeatAt,
  finished_at: jobRuns.finishedAt,
  results: jobRuns.results,
  error: jobRuns.error,
};

/**
 * A SQL expression to select as a field, with its columns kept as `"table"."column"`.
 * Drizzle strips the table from a column written straight into a selected expression
 * when the query reads one table, and a correlated subquery then compares the inner
 * table's columns with themselves. A column one template further in is left alone.
 */
export function selected<T>(expression: SQL<T>): SQL<T> {
  return sql<T>`${expression}`;
}

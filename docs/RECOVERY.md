# Recovery

How to get data back. For a leaked secret, see [SECURITY.md](../SECURITY.md). Nothing here has been run on hosted Supabase.

Three layers, smallest first:

1. **Undo one change by hand.** Deletes are soft and `history.row_versions` keeps old copies of `events` and `tasks`, so most mistakes need no backup. See [Undoing a change](#undoing-a-change).
2. **The provider's backups.** Supabase takes the database backups. Restore from them when data is lost or damaged across the board.
3. **A manual export.** An occasional `pg_dump` kept privately, for when the provider's backups are gone or out of reach, such as after losing the account.

## The provider's backups

Unverified: what the current plan includes. Check the project's Database > Backups page, and Supabase's current documentation, when the project is set up and once a term. At the time of writing, daily backups come with paid plans, and point-in-time restore is a paid add-on. If the project has neither, the manual export below is the only backup, so take it more often.

To restore:

1. Turn reminders off with `/config` if the bot can still run, so it does not send from data that is about to change.
2. Choose the newest backup, or with point-in-time restore the last moment before the damage, from the Database > Backups page. A restore replaces the whole database and the project is unavailable while it runs. It also brings back the reminders setting as it was then, so turn reminders off again straight after.
3. Check that the restored database has every migration. Run `supabase migration list` against the linked project, and `supabase db push` for any missing, as [RUNBOOK.md](RUNBOOK.md#deploy-order) describes. Code newer than the schema can fail, so do this before the bot takes traffic.
4. Check `job_runs` and a few recent events and tasks, then turn reminders back on.

Anything done between the backup and the restore is lost, including posts the bot made in Discord, which stay in Discord. Tell people to check their tasks.

## A manual export

Take one before a risky migration, and otherwise once a term. You need a Postgres 17 `pg_dump`. Take the session pooler host and the CA file from the Supabase Connect panel, and enter the `postgres` password when asked. Never put it in the command or a file in this repo.

```sh
pg_dump --format=custom --no-owner --schema=public --schema=history \
  --file="bot-$(date +%Y-%m-%d).dump" \
  "postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres?sslmode=verify-full&sslrootcert=<ca-file>"
pg_restore --list "bot-$(date +%Y-%m-%d).dump" | head
```

**Expect:** the list names the app's tables. The file holds member IDs and task text:

- Encrypt it, and keep it somewhere private that only the maintainer and one other trusted officer can reach, never in this repository or a chat. `.gitignore` blocks `*.dump`, but do not rely on that.
- Keep the last two and delete older ones, in line with [Member data retention](RUNBOOK.md#member-data-retention).

Restoring an export is untested. Rehearse it on the staging project before relying on it: restore into a new, empty project with `pg_restore --no-owner --single-transaction`, record its migrations with `supabase migration repair`, then repoint `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in Vercel. Write down what worked here.

## If you ran the old backup job

Earlier versions ran a daily job in a separate private repo that committed `age`-encrypted dumps. If that job was ever set up, clean it up once the migration that drops `backup_ro` has been applied:

1. Disable the private repo's backup workflow, then delete the repo. Its encrypted dumps hold member IDs and task text.
2. Rotate `BACKUP_PGPASSWORD`. If `backup_ro` still exists, the migration's notice said so: set a new random password with `\password backup_ro` as `postgres` and do not record it.
3. Ask each key holder to delete their `age` identity file, including the password manager entry and the offline copy, so that no copy of a dump can be read again.

## Undoing a change

No bot command reverses `/event close`, Mark done or `/event delete`, because nothing is really deleted and a mistake is rare. A maintainer does it by hand. Run these as `postgres`, in the Supabase SQL Editor or `psql`. Each one should report that it changed 1 row. `test/db/recovery-procedures.test.ts` runs this SQL, as the tables' owner on PGlite. It has not been run on hosted Supabase.

Row history covers `events` and `tasks`, and these changes add to it. What SQL changes does not reach Discord: the post's overview stays as it was until the next change to that event's tasks. Reminder rows are kept, so a reminder already sent or skipped for a task's due date is not sent again.

Find the full IDs first. Commands show only the start of one.

```sql
SELECT id, name, event_date, status, deleted_at FROM public.events WHERE name ILIKE '%<part of the name>%';
SELECT id, description, due_date, status, deleted_at FROM public.tasks WHERE event_id = '<event id>';
```

**Reopen a closed event.** Its open tasks get reminders again.

```sql
-- undo: reopen event
UPDATE public.events SET status = 'active'
WHERE id = '<event id>' AND status = 'closed' AND deleted_at IS NULL;
```

**Reopen a task marked done.** Reopen its event first if that is closed too, or this fails with `CF410`, even as `postgres`.

```sql
-- undo: reopen task
UPDATE public.tasks SET status = 'open', completed_at = NULL
WHERE id = '<task id>' AND status = 'done';
```

**Undelete an event and its tasks.** `/event delete` gives the event and its tasks one timestamp, so matching on it brings back only those tasks. A task deleted earlier stays deleted. Keep the comparison in SQL as written, because a timestamp copied through other tools can lose its microseconds and then match nothing.

```sql
-- undo: undelete event
WITH gone AS (
  SELECT id, deleted_at FROM public.events WHERE id = '<event id>'
), tasks AS (
  UPDATE public.tasks AS task SET deleted_at = NULL
  FROM gone
  WHERE task.event_id = gone.id AND task.deleted_at = gone.deleted_at
  RETURNING 1
)
UPDATE public.events SET deleted_at = NULL
WHERE id = '<event id>' AND deleted_at IS NOT NULL;
```

**If that fails with `23505`** on `events_live_thread_uq`, its post now belongs to another event. See which one:

```sql
-- undo: find post holder
SELECT live.id, live.name, live.event_date
FROM public.events AS live
JOIN public.events AS gone ON gone.thread_id = live.thread_id
WHERE gone.id = '<event id>' AND live.deleted_at IS NULL;
```

Leave that post with the other event, and undelete this one without a post. Then in Discord, run `/event link` inside a new post in the same forum and choose this event in the event option. Until then it has no post and sends no reminders.

```sql
-- undo: undelete event without its post
WITH gone AS (
  SELECT id, deleted_at FROM public.events WHERE id = '<event id>'
), tasks AS (
  UPDATE public.tasks AS task SET deleted_at = NULL
  FROM gone
  WHERE task.event_id = gone.id AND task.deleted_at = gone.deleted_at
  RETURNING 1
)
UPDATE public.events
SET deleted_at = NULL, thread_id = NULL, overview_message_id = NULL, thread_status = 'pending'
WHERE id = '<event id>' AND deleted_at IS NOT NULL;
```

**Undelete one task.** Check first that its event is live, because this is not refused under a deleted event.

```sql
-- undo: undelete task
UPDATE public.tasks SET deleted_at = NULL
WHERE id = '<task id>' AND deleted_at IS NOT NULL;
```

**Put back an earlier assignee, description or due date.** List the versions, newest first. Each `old_row` is the row as it was before that change. Then copy the chosen version's `id` into the update. A closed event refuses this with `CF410` until it is reopened.

```sql
-- undo: list task versions
SELECT id, changed_at, old_row FROM history.row_versions
WHERE source_table = 'tasks' AND row_id = '<task id>'
ORDER BY id DESC;
```

```sql
-- undo: restore task version
UPDATE public.tasks AS task
SET assignee_id = version.old_row ->> 'assignee_id',
    description = version.old_row ->> 'description',
    due_date = (version.old_row ->> 'due_date')::date
FROM history.row_versions AS version
WHERE version.id = <version id>
  AND version.source_table = 'tasks'
  AND task.id::text = version.row_id;
```

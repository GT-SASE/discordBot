-- The custom backup job is gone: recovery now relies on Supabase's own backups and
-- point-in-time restore, plus an occasional manual export, as docs/RECOVERY.md says.
-- This takes away everything the earlier migrations gave backup_ro, then drops the role.
--
-- The earlier migrations stay as they are, because applied migrations must not change.
-- On a new database they still create the role and its access, and this removes both.
--
-- Revoking a privilege the role does not hold, and dropping a policy that does not
-- exist, are both no-ops, so this is safe on either of the two paths the role's
-- migration could take (BYPASSRLS, or one policy per table). The ALL TABLES and ALL
-- SEQUENCES forms also reach anything the removed grant-backup-role.psql script granted
-- by hand after a recovery, without dynamic SQL.
--
-- Roles belong to the cluster, and DROP ROLE fails if the role still holds anything in
-- another database, or anything granted by someone other than this migration's owner.
-- In that case the role is left in place with none of the access below, and with no
-- login and no BYPASSRLS wherever this owner may remove them, and a notice says so.
-- Nothing here touches table data.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'backup_ro') THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS backup_ro_read ON public.guild_config;
  DROP POLICY IF EXISTS backup_ro_read ON public.managed_channels;
  DROP POLICY IF EXISTS backup_ro_read ON public.events;
  DROP POLICY IF EXISTS backup_ro_read ON public.tasks;
  DROP POLICY IF EXISTS backup_ro_read ON public.reminder_log;
  DROP POLICY IF EXISTS backup_ro_read ON public.job_runs;
  DROP POLICY IF EXISTS backup_ro_read ON public.config_audit;
  DROP POLICY IF EXISTS backup_ro_read ON public.interaction_claims;
  DROP POLICY IF EXISTS backup_ro_read ON public.task_reassignments;
  DROP POLICY IF EXISTS backup_ro_read ON public.setup_drafts;
  DROP POLICY IF EXISTS backup_ro_read ON public.event_steps;
  DROP POLICY IF EXISTS backup_ro_read ON public.event_step_assignees;
  DROP POLICY IF EXISTS backup_ro_read ON public.event_reminder_log;
  DROP POLICY IF EXISTS backup_ro_read ON history.row_versions;

  REVOKE ALL ON ALL TABLES IN SCHEMA public, history FROM backup_ro;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, history FROM backup_ro;
  REVOKE ALL ON SCHEMA public, history FROM backup_ro;

  -- Granted only where the Supabase CLI created this table, and only if the owner could.
  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    BEGIN
      REVOKE ALL ON TABLE supabase_migrations.schema_migrations FROM backup_ro;
      REVOKE ALL ON SCHEMA supabase_migrations FROM backup_ro;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'could not revoke backup_ro''s read access to the applied migrations';
    END;
  END IF;

  BEGIN
    DROP ROLE backup_ro;
    RETURN;
  EXCEPTION WHEN dependent_objects_still_exist OR insufficient_privilege THEN
    RAISE NOTICE 'backup_ro was kept, with no access from this database';
  END;

  -- Only reached when the role could not be dropped. Each step may be refused on its own.
  BEGIN
    ALTER ROLE backup_ro NOLOGIN;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'backup_ro keeps whatever login it had';
  END;
  BEGIN
    ALTER ROLE backup_ro NOBYPASSRLS;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'backup_ro keeps BYPASSRLS if it had it';
  END;
END;
$$;

-- The club's fixed per-event workflow: four steps per event (Budget Sheet, Engage post,
-- Budget approved, Food pickup), the people assigned to each, the roles that are pinged
-- when a step is handed on, and the reminders posted in the event's thread.
--
-- Every write goes through a function here. The bot's role can read the new tables and
-- write none of them directly, and no role is given DELETE or TRUNCATE: an assignment is
-- removed by setting removed_at.
--
-- Lock order. A function that changes a step locks that event_steps row first and only
-- then reads the event FOR SHARE, or updates it. Nothing locks an event and then one of its
-- steps, so two of these functions cannot wait on each other.

-- Roles ---------------------------------------------------------------------------------

-- officer_role_id is shown as Events Directors from now on. The four new roles stay NULL
-- on an existing guild until /setup is run again, and a feature that needs one says so.
-- events_committee_role_id is stored and shown, and decides nothing yet.
ALTER TABLE public.guild_config
  ADD COLUMN eboard_role_id public.discord_id,
  ADD COLUMN events_committee_role_id public.discord_id,
  ADD COLUMN treasury_role_id public.discord_id,
  ADD COLUMN marketing_role_id public.discord_id,
  -- The @everyone role's ID equals the guild ID, as for the first two roles.
  ADD CONSTRAINT guild_config_eboard_not_everyone CHECK (eboard_role_id <> guild_id),
  ADD CONSTRAINT guild_config_events_committee_not_everyone
    CHECK (events_committee_role_id <> guild_id),
  ADD CONSTRAINT guild_config_treasury_not_everyone CHECK (treasury_role_id <> guild_id),
  ADD CONSTRAINT guild_config_marketing_not_everyone CHECK (marketing_role_id <> guild_id);

-- What /setup showed an admin, for the Confirm click to read back. Six role IDs do not fit
-- in a custom_id, and the ephemeral message's text is not trusted, so the click carries
-- only the config version and this fingerprint and the roles come from here. One row per
-- guild, replaced by the next /setup. A draft older than an hour is ignored by the reader.
CREATE TABLE public.setup_drafts (
  guild_id                 public.discord_id PRIMARY KEY,
  actor_id                 public.discord_id NOT NULL,
  officer_role_id          public.discord_id NOT NULL,
  admin_role_id            public.discord_id NOT NULL,
  eboard_role_id           public.discord_id NOT NULL,
  events_committee_role_id public.discord_id NOT NULL,
  treasury_role_id         public.discord_id NOT NULL,
  marketing_role_id        public.discord_id NOT NULL,
  fingerprint              text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT setup_drafts_officer_not_everyone CHECK (officer_role_id <> guild_id),
  CONSTRAINT setup_drafts_admin_not_everyone CHECK (admin_role_id <> guild_id),
  CONSTRAINT setup_drafts_eboard_not_everyone CHECK (eboard_role_id <> guild_id),
  CONSTRAINT setup_drafts_events_committee_not_everyone
    CHECK (events_committee_role_id <> guild_id),
  CONSTRAINT setup_drafts_treasury_not_everyone CHECK (treasury_role_id <> guild_id),
  CONSTRAINT setup_drafts_marketing_not_everyone CHECK (marketing_role_id <> guild_id),
  CONSTRAINT setup_drafts_fingerprint_shape CHECK (fingerprint ~ '^[A-Za-z0-9_-]{8,64}$')
);

-- Steps ---------------------------------------------------------------------------------

CREATE TYPE public.event_step_kind AS ENUM (
  'budget_sheet',
  'engage_post',
  'budget_approved',
  'food_pickup'
);
CREATE TYPE public.event_reminder_kind AS ENUM (
  'daily_steps',
  'pickup_two_days',
  'pickup_day'
);

-- Local time in the guild's timezone on the event's date. Set only by
-- set_event_pickup_time, so the bot's role is not granted the column.
ALTER TABLE public.events ADD COLUMN pickup_time time;

-- One row per event and kind, made by a trigger when the event is made. food_pickup is
-- done when the event has a pickup time and at least one person on it, and the functions
-- that change either keep its row in step. handoff_claimed_at and handoff_sent_at make the
-- ping that follows a step happen at most once.
CREATE TABLE public.event_steps (
  event_id           uuid NOT NULL,
  guild_id           public.discord_id NOT NULL,
  kind               public.event_step_kind NOT NULL,
  status             public.task_status NOT NULL DEFAULT 'open',
  completed_at       timestamptz,
  completed_by       public.discord_id,
  handoff_claimed_at timestamptz,
  handoff_sent_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, kind),
  FOREIGN KEY (event_id, guild_id) REFERENCES public.events (id, guild_id),
  CONSTRAINT event_steps_completed_matches_status
    CHECK ((completed_at IS NOT NULL) = (status = 'done')),
  CONSTRAINT event_steps_completed_by_matches_status
    CHECK ((completed_by IS NOT NULL) = (status = 'done')),
  CONSTRAINT event_steps_handoff_only_when_done
    CHECK (handoff_claimed_at IS NULL OR (status = 'done' AND kind <> 'food_pickup')),
  CONSTRAINT event_steps_handoff_sent_after_claim
    CHECK (handoff_sent_at IS NULL OR handoff_claimed_at IS NOT NULL)
);

-- Who owns a step. Budget approved has no owners: it is marked by a role. Only the event
-- is referenced, and not the step row as well, so that PostgREST finds one way from an
-- event to these rows and not two.
CREATE TABLE public.event_step_assignees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL,
  guild_id    public.discord_id NOT NULL,
  kind        public.event_step_kind NOT NULL,
  user_id     public.discord_id NOT NULL,
  assigned_by public.discord_id NOT NULL,
  removed_at  timestamptz,
  removed_by  public.discord_id,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, guild_id) REFERENCES public.events (id, guild_id),
  CONSTRAINT event_step_assignees_kind_assignable CHECK (kind <> 'budget_approved'),
  CONSTRAINT event_step_assignees_removed_together
    CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

-- One live assignment per person and step. A removed one stays, and the person can be
-- assigned again.
CREATE UNIQUE INDEX event_step_assignees_live_uq
  ON public.event_step_assignees (event_id, kind, user_id)
  WHERE removed_at IS NULL;
-- /mytasks: one person's live assignments in one guild.
CREATE INDEX event_step_assignees_by_user_idx
  ON public.event_step_assignees (guild_id, user_id)
  WHERE removed_at IS NULL;

-- The same claim cycle as reminder_log. reminder_date is the local date the message is
-- for: each day for daily_steps, two days before the event for pickup_two_days, and the
-- event's date for pickup_day. Moving the event therefore re-arms its pickup reminders.
CREATE TABLE public.event_reminder_log (
  event_id      uuid NOT NULL REFERENCES public.events (id),
  kind          public.event_reminder_kind NOT NULL,
  reminder_date date NOT NULL,
  state         public.reminder_state NOT NULL DEFAULT 'claimed',
  claim_token   uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts      integer NOT NULL DEFAULT 1,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  message_id    public.discord_id,
  PRIMARY KEY (event_id, kind, reminder_date),
  CONSTRAINT event_reminder_log_date_range
    CHECK (reminder_date BETWEEN '2000-01-01' AND '9999-12-31'),
  CONSTRAINT event_reminder_log_attempts_positive CHECK (attempts >= 1),
  CONSTRAINT event_reminder_log_sent_at_matches_state
    CHECK ((sent_at IS NOT NULL) = (state = 'sent')),
  CONSTRAINT event_reminder_log_message_only_when_sent
    CHECK (message_id IS NULL OR state = 'sent')
);

CREATE INDEX event_reminder_log_open_claims_idx ON public.event_reminder_log (claimed_at)
  WHERE state = 'claimed';

CREATE TRIGGER event_steps_set_updated_at BEFORE UPDATE ON public.event_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Steps for every new event. SECURITY DEFINER because the bot's role, which inserts the
-- event, has no write access to event_steps.
CREATE FUNCTION public.create_event_steps() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.event_steps (event_id, guild_id, kind)
  SELECT NEW.id, NEW.guild_id, kind
  FROM unnest(enum_range(NULL::public.event_step_kind)) AS kind;
  RETURN NULL;
END;
$$;

CREATE TRIGGER events_create_steps AFTER INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.create_event_steps();

-- Every existing event gets its steps too, deleted ones included, so that every event has
-- all four rows.
INSERT INTO public.event_steps (event_id, guild_id, kind)
SELECT event.id, event.guild_id, kind
FROM public.events AS event
CROSS JOIN unnest(enum_range(NULL::public.event_step_kind)) AS kind
ON CONFLICT (event_id, kind) DO NOTHING;

-- History -------------------------------------------------------------------------------

-- As history.record_row_version, for a table keyed by event and kind with no id column.
CREATE FUNCTION history.record_event_step_version() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  INSERT INTO history.row_versions (source_table, operation, row_id, old_row)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    (pg_catalog.to_jsonb(OLD) ->> 'event_id') || ':' || (pg_catalog.to_jsonb(OLD) ->> 'kind'),
    pg_catalog.to_jsonb(OLD)
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION history.record_event_step_version()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER event_steps_record_update AFTER UPDATE ON public.event_steps
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION history.record_event_step_version();
CREATE TRIGGER event_steps_record_delete AFTER DELETE ON public.event_steps
  FOR EACH ROW EXECUTE FUNCTION history.record_event_step_version();
CREATE TRIGGER event_step_assignees_record_update AFTER UPDATE ON public.event_step_assignees
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION history.record_row_version();
CREATE TRIGGER event_step_assignees_record_delete AFTER DELETE ON public.event_step_assignees
  FOR EACH ROW EXECUTE FUNCTION history.record_row_version();

CREATE TRIGGER event_steps_reject_truncate BEFORE TRUNCATE ON public.event_steps
  FOR EACH STATEMENT EXECUTE FUNCTION history.reject_truncate();
CREATE TRIGGER event_step_assignees_reject_truncate BEFORE TRUNCATE ON public.event_step_assignees
  FOR EACH STATEMENT EXECUTE FUNCTION history.reject_truncate();

-- Step functions ------------------------------------------------------------------------
--
-- Each returns NULL when there is no live event with that ID in that guild, so an unknown
-- event, another guild's and a deleted one look the same. A closed event raises SQLSTATE
-- CF410, as a task on one does.

-- Brings the food_pickup row in line with the event's pickup time and people. Called only
-- from the functions below, under the lock on that row. Returns the step's status.
CREATE FUNCTION public.sync_food_pickup_step(p_event_id uuid, p_actor_id text)
  RETURNS public.task_status
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  v_ready boolean;
  v_status public.task_status;
BEGIN
  SELECT event.pickup_time IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.event_step_assignees AS assignee
      WHERE assignee.event_id = event.id
        AND assignee.kind = 'food_pickup'
        AND assignee.removed_at IS NULL
    )
  INTO v_ready
  FROM public.events AS event
  WHERE event.id = p_event_id;

  UPDATE public.event_steps
  SET status = CASE WHEN v_ready THEN 'done'::public.task_status ELSE 'open'::public.task_status END,
      completed_at = CASE WHEN v_ready THEN coalesce(completed_at, now()) END,
      completed_by = CASE WHEN v_ready THEN coalesce(completed_by, p_actor_id) END
  WHERE event_id = p_event_id AND kind = 'food_pickup'
  RETURNING status INTO v_status;

  RETURN v_status;
END;
$$;

-- Adds a person to a step. True if this call added them, false if they were already on
-- it. Raises 22023 for Budget approved, CF428 for Food pickup before the budget is
-- approved, and CF431 once the step has its most people: 10, or 15 for Food pickup.
CREATE FUNCTION public.assign_event_step(
  p_event_id uuid,
  p_guild_id text,
  p_kind public.event_step_kind,
  p_user_id text,
  p_actor_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_count integer;
BEGIN
  IF p_kind IS NULL OR p_kind = 'budget_approved' THEN
    RAISE EXCEPTION 'this step has no assignees' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = p_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR SHARE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  IF p_kind = 'food_pickup' AND NOT EXISTS (
    SELECT 1 FROM public.event_steps
    WHERE event_id = p_event_id AND kind = 'budget_approved' AND status = 'done'
  ) THEN
    RAISE EXCEPTION 'budget is not approved' USING ERRCODE = 'CF428';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.event_step_assignees
    WHERE event_id = p_event_id AND kind = p_kind AND user_id = p_user_id AND removed_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.event_step_assignees
  WHERE event_id = p_event_id AND kind = p_kind AND removed_at IS NULL;
  IF v_count >= (CASE WHEN p_kind = 'food_pickup' THEN 15 ELSE 10 END) THEN
    RAISE EXCEPTION 'step assignee limit reached' USING ERRCODE = 'CF431';
  END IF;

  INSERT INTO public.event_step_assignees (event_id, guild_id, kind, user_id, assigned_by)
  VALUES (p_event_id, p_guild_id, p_kind, p_user_id, p_actor_id);

  IF p_kind = 'food_pickup' THEN
    PERFORM public.sync_food_pickup_step(p_event_id, p_actor_id);
  END IF;

  RETURN true;
END;
$$;

-- Takes a person off a step, keeping the row. True if this call removed them, false if
-- they were not on it. Removing the last pickup person reopens Food pickup.
CREATE FUNCTION public.unassign_event_step(
  p_event_id uuid,
  p_guild_id text,
  p_kind public.event_step_kind,
  p_user_id text,
  p_actor_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_removed boolean;
BEGIN
  IF p_kind IS NULL OR p_kind = 'budget_approved' THEN
    RAISE EXCEPTION 'this step has no assignees' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'an actor is needed' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = p_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR SHARE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  UPDATE public.event_step_assignees
  SET removed_at = now(),
      removed_by = p_actor_id
  WHERE event_id = p_event_id AND kind = p_kind AND user_id = p_user_id AND removed_at IS NULL;
  v_removed := FOUND;

  IF v_removed AND p_kind = 'food_pickup' THEN
    PERFORM public.sync_food_pickup_step(p_event_id, p_actor_id);
  END IF;

  RETURN v_removed;
END;
$$;

-- Marks Budget Sheet, Engage post or Budget approved done. True if this call did it, false
-- if it was done already. Food pickup is done by its time and people, so it raises 22023.
-- Who may call this is the bot's decision, made before the call.
CREATE FUNCTION public.complete_event_step(
  p_event_id uuid,
  p_guild_id text,
  p_kind public.event_step_kind,
  p_actor_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_status public.task_status;
  v_event public.events%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind = 'food_pickup' THEN
    RAISE EXCEPTION 'this step cannot be marked done' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_status
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = p_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR SHARE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  IF v_status <> 'open' THEN
    RETURN false;
  END IF;

  UPDATE public.event_steps
  SET status = 'done',
      completed_at = now(),
      completed_by = p_actor_id
  WHERE event_id = p_event_id AND kind = p_kind;

  RETURN true;
END;
$$;

-- The right to send the message that follows a finished step. True for exactly one
-- caller per step, ever. A caller that claims and then fails to send leaves the ping
-- unsent for good, which is the price of never sending it twice.
CREATE FUNCTION public.claim_step_handoff(
  p_event_id uuid,
  p_guild_id text,
  p_kind public.event_step_kind
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF p_kind IS NULL OR p_kind = 'food_pickup' THEN
    RAISE EXCEPTION 'this step has no hand-off' USING ERRCODE = '22023';
  END IF;

  UPDATE public.event_steps AS step
  SET handoff_claimed_at = now()
  WHERE step.event_id = p_event_id
    AND step.guild_id = p_guild_id
    AND step.kind = p_kind
    AND step.status = 'done'
    AND step.handoff_claimed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.events AS event
      WHERE event.id = p_event_id AND event.guild_id = p_guild_id AND event.deleted_at IS NULL
    );

  RETURN FOUND;
END;
$$;

-- Records that the claimed hand-off went out. False if it was not claimed or is recorded
-- already.
CREATE FUNCTION public.mark_step_handoff_sent(
  p_event_id uuid,
  p_guild_id text,
  p_kind public.event_step_kind
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.event_steps
  SET handoff_sent_at = now()
  WHERE event_id = p_event_id
    AND guild_id = p_guild_id
    AND kind = p_kind
    AND handoff_claimed_at IS NOT NULL
    AND handoff_sent_at IS NULL;

  RETURN FOUND;
END;
$$;

-- Sets the time of the food pickup. Raises CF428 before the budget is approved. Returns
-- whether Food pickup is now done, which also needs at least one person on it.
CREATE FUNCTION public.set_event_pickup_time(
  p_event_id uuid,
  p_guild_id text,
  p_pickup_time time,
  p_actor_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_event public.events%ROWTYPE;
BEGIN
  IF p_pickup_time IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'a pickup time and an actor are needed' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = 'food_pickup'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR UPDATE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.event_steps
    WHERE event_id = p_event_id AND kind = 'budget_approved' AND status = 'done'
  ) THEN
    RAISE EXCEPTION 'budget is not approved' USING ERRCODE = 'CF428';
  END IF;

  UPDATE public.events
  SET pickup_time = p_pickup_time
  WHERE id = p_event_id;

  RETURN public.sync_food_pickup_step(p_event_id, p_actor_id) = 'done';
END;
$$;

-- Event reminders -----------------------------------------------------------------------

-- Everything a reminder run's query checks, so that a run working from an out-of-date
-- read sends nothing: a live active event, an active channel, reminders on, and a date
-- that suits the kind. A pickup reminder also needs Food pickup set up.
CREATE FUNCTION public.event_reminder_allowed(
  p_event_id uuid,
  p_kind public.event_reminder_kind,
  p_reminder_date date
) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.events AS event
    JOIN public.managed_channels AS channel
      ON channel.guild_id = event.guild_id AND channel.channel_id = event.channel_id
    JOIN public.guild_config AS config
      ON config.guild_id = event.guild_id
    WHERE event.id = p_event_id
      AND event.status = 'active'
      AND event.deleted_at IS NULL
      AND channel.status = 'active'
      AND config.reminders_enabled
      AND CASE p_kind
        WHEN 'daily_steps' THEN p_reminder_date <= event.event_date
        WHEN 'pickup_two_days' THEN p_reminder_date = event.event_date - 2
        WHEN 'pickup_day' THEN p_reminder_date = event.event_date
        ELSE false
      END
      AND (
        p_kind = 'daily_steps'
        OR EXISTS (
          SELECT 1 FROM public.event_steps AS step
          WHERE step.event_id = event.id AND step.kind = 'food_pickup' AND step.status = 'done'
        )
      )
  );
$$;

-- Returns a claim token, or NULL if someone else holds it or the reminder is not due.
CREATE FUNCTION public.claim_event_reminder(
  p_event_id uuid,
  p_kind public.event_reminder_kind,
  p_reminder_date date
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_token uuid;
BEGIN
  INSERT INTO public.event_reminder_log (event_id, kind, reminder_date)
  SELECT p_event_id, p_kind, p_reminder_date
  WHERE public.event_reminder_allowed(p_event_id, p_kind, p_reminder_date)
  ON CONFLICT (event_id, kind, reminder_date) DO NOTHING
  RETURNING claim_token INTO v_token;

  RETURN v_token;
END;
$$;

-- Takes over a claim left unfinished for over an hour, given the token last seen on it.
-- Returns a new token, or NULL if the claim is fresh, finished or already taken over, or
-- the reminder is no longer due.
CREATE FUNCTION public.reclaim_event_reminder(
  p_event_id uuid,
  p_kind public.event_reminder_kind,
  p_reminder_date date,
  p_claim_token uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_token uuid;
BEGIN
  UPDATE public.event_reminder_log AS log
  SET claim_token = gen_random_uuid(),
      claimed_at = now(),
      attempts = log.attempts + 1
  WHERE log.event_id = p_event_id
    AND log.kind = p_kind
    AND log.reminder_date = p_reminder_date
    AND log.state = 'claimed'
    AND log.claim_token = p_claim_token
    AND log.claimed_at < now() - interval '1 hour'
    AND public.event_reminder_allowed(p_event_id, p_kind, p_reminder_date)
  RETURNING log.claim_token INTO v_token;

  RETURN v_token;
END;
$$;

-- Records a sent reminder. False if the token no longer holds the claim.
CREATE FUNCTION public.mark_event_reminder_sent(
  p_event_id uuid,
  p_kind public.event_reminder_kind,
  p_reminder_date date,
  p_claim_token uuid,
  p_message_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.event_reminder_log
  SET state = 'sent',
      sent_at = now(),
      message_id = p_message_id
  WHERE event_id = p_event_id
    AND kind = p_kind
    AND reminder_date = p_reminder_date
    AND state = 'claimed'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

-- Records a reminder deliberately not sent. False if the token no longer holds the claim.
CREATE FUNCTION public.mark_event_reminder_skipped(
  p_event_id uuid,
  p_kind public.event_reminder_kind,
  p_reminder_date date,
  p_claim_token uuid
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.event_reminder_log
  SET state = 'skipped'
  WHERE event_id = p_event_id
    AND kind = p_kind
    AND reminder_date = p_reminder_date
    AND state = 'claimed'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

-- Setup ---------------------------------------------------------------------------------

-- Saves what /setup showed, replacing any earlier draft for the guild.
CREATE FUNCTION public.save_setup_draft(
  p_guild_id text,
  p_actor_id text,
  p_officer_role_id text,
  p_admin_role_id text,
  p_eboard_role_id text,
  p_events_committee_role_id text,
  p_treasury_role_id text,
  p_marketing_role_id text,
  p_fingerprint text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.setup_drafts (
    guild_id, actor_id, officer_role_id, admin_role_id, eboard_role_id,
    events_committee_role_id, treasury_role_id, marketing_role_id, fingerprint
  )
  VALUES (
    p_guild_id, p_actor_id, p_officer_role_id, p_admin_role_id, p_eboard_role_id,
    p_events_committee_role_id, p_treasury_role_id, p_marketing_role_id, p_fingerprint
  )
  ON CONFLICT (guild_id) DO UPDATE
  SET actor_id = EXCLUDED.actor_id,
      officer_role_id = EXCLUDED.officer_role_id,
      admin_role_id = EXCLUDED.admin_role_id,
      eboard_role_id = EXCLUDED.eboard_role_id,
      events_committee_role_id = EXCLUDED.events_committee_role_id,
      treasury_role_id = EXCLUDED.treasury_role_id,
      marketing_role_id = EXCLUDED.marketing_role_id,
      fingerprint = EXCLUDED.fingerprint,
      created_at = now();

  RETURN true;
END;
$$;

-- As in 20261104000006_config_functions.sql, with the four new roles. Those may be NULL,
-- which leaves the role unbound. Dropped first so that no five-argument version remains.
DROP FUNCTION public.apply_role_bindings(text, integer, text, text, text);

CREATE FUNCTION public.apply_role_bindings(
  p_guild_id text,
  p_expected_version integer,
  p_actor_id text,
  p_officer_role_id text,
  p_admin_role_id text,
  p_eboard_role_id text,
  p_events_committee_role_id text,
  p_treasury_role_id text,
  p_marketing_role_id text
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_current public.guild_config%ROWTYPE;
  v_old_values jsonb;
  v_version integer;
BEGIN
  SELECT * INTO v_current
  FROM public.guild_config
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_current.version IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;

    v_old_values := jsonb_build_object(
      'officer_role_id', v_current.officer_role_id,
      'admin_role_id', v_current.admin_role_id,
      'eboard_role_id', v_current.eboard_role_id,
      'events_committee_role_id', v_current.events_committee_role_id,
      'treasury_role_id', v_current.treasury_role_id,
      'marketing_role_id', v_current.marketing_role_id
    );

    UPDATE public.guild_config
    SET officer_role_id = p_officer_role_id,
        admin_role_id = p_admin_role_id,
        eboard_role_id = p_eboard_role_id,
        events_committee_role_id = p_events_committee_role_id,
        treasury_role_id = p_treasury_role_id,
        marketing_role_id = p_marketing_role_id,
        version = version + 1
    WHERE guild_id = p_guild_id
    RETURNING version INTO v_version;
  ELSE
    IF p_expected_version IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;

    -- A concurrent first setup can pass the check above. The conflict leaves
    -- v_version null, which is reported as a stale version.
    INSERT INTO public.guild_config (
      guild_id, officer_role_id, admin_role_id, eboard_role_id,
      events_committee_role_id, treasury_role_id, marketing_role_id
    )
    VALUES (
      p_guild_id, p_officer_role_id, p_admin_role_id, p_eboard_role_id,
      p_events_committee_role_id, p_treasury_role_id, p_marketing_role_id
    )
    ON CONFLICT (guild_id) DO NOTHING
    RETURNING version INTO v_version;

    IF v_version IS NULL THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;
  END IF;

  INSERT INTO public.config_audit (guild_id, actor_id, action, old_values, new_values, version_after)
  VALUES (
    p_guild_id,
    p_actor_id,
    'role_bindings',
    v_old_values,
    jsonb_build_object(
      'officer_role_id', p_officer_role_id,
      'admin_role_id', p_admin_role_id,
      'eboard_role_id', p_eboard_role_id,
      'events_committee_role_id', p_events_committee_role_id,
      'treasury_role_id', p_treasury_role_id,
      'marketing_role_id', p_marketing_role_id
    ),
    v_version
  );

  RETURN v_version;
END;
$$;

-- Daily slot ----------------------------------------------------------------------------

-- As in 20261104000014_database_grants_and_lock_order.sql, with the slot moved from 14:00
-- to 15:00 UTC, which is 10:00 in New York in winter and 11:00 in summer. The crons in
-- vercel.json run at 15:00 and 17:00, and SLOT_START_HOUR_UTC in src/reminders/run.ts
-- must match. The arguments are unchanged, so the function keeps its grants.
CREATE OR REPLACE FUNCTION public.begin_job_run(
  p_job_name text,
  p_stale_after_seconds integer
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('job_runs:' || p_job_name, 0)
  );

  UPDATE public.job_runs
  SET status = 'failed',
      finished_at = now(),
      error = 'abandoned'
  WHERE job_name = p_job_name
    AND status = 'running'
    AND (
      heartbeat_at < now() - make_interval(secs => p_stale_after_seconds)
      OR heartbeat_at > clock_timestamp()
    );

  IF EXISTS (
    SELECT 1
    FROM public.job_runs
    WHERE job_name = p_job_name
      AND status = 'succeeded'
      AND started_at >= date_trunc('day', now() - interval '15 hours', 'UTC') + interval '15 hours'
      AND started_at <= clock_timestamp()
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.job_runs (job_name)
  VALUES (p_job_name)
  ON CONFLICT (job_name) WHERE status = 'running' DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Access --------------------------------------------------------------------------------

ALTER TABLE public.setup_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_step_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reminder_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.setup_drafts,
  public.event_steps,
  public.event_step_assignees,
  public.event_reminder_log
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON TYPE
  public.event_step_kind,
  public.event_reminder_kind
FROM PUBLIC;

REVOKE ALL ON FUNCTION
  public.create_event_steps(),
  public.sync_food_pickup_step(uuid, text),
  public.event_reminder_allowed(uuid, public.event_reminder_kind, date),
  public.assign_event_step(uuid, text, public.event_step_kind, text, text),
  public.unassign_event_step(uuid, text, public.event_step_kind, text, text),
  public.complete_event_step(uuid, text, public.event_step_kind, text),
  public.claim_step_handoff(uuid, text, public.event_step_kind),
  public.mark_step_handoff_sent(uuid, text, public.event_step_kind),
  public.set_event_pickup_time(uuid, text, time, text),
  public.claim_event_reminder(uuid, public.event_reminder_kind, date),
  public.reclaim_event_reminder(uuid, public.event_reminder_kind, date, uuid),
  public.mark_event_reminder_sent(uuid, public.event_reminder_kind, date, uuid, text),
  public.mark_event_reminder_skipped(uuid, public.event_reminder_kind, date, uuid),
  public.save_setup_draft(text, text, text, text, text, text, text, text, text),
  public.apply_role_bindings(text, integer, text, text, text, text, text, text, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON TYPE
  public.event_step_kind,
  public.event_reminder_kind
TO service_role;

-- Read-only for the bot's role, so a direct write cannot skip the locks, limits and claim
-- tokens above.
GRANT SELECT ON TABLE
  public.setup_drafts,
  public.event_steps,
  public.event_step_assignees,
  public.event_reminder_log
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.assign_event_step(uuid, text, public.event_step_kind, text, text),
  public.unassign_event_step(uuid, text, public.event_step_kind, text, text),
  public.complete_event_step(uuid, text, public.event_step_kind, text),
  public.claim_step_handoff(uuid, text, public.event_step_kind),
  public.mark_step_handoff_sent(uuid, text, public.event_step_kind),
  public.set_event_pickup_time(uuid, text, time, text),
  public.claim_event_reminder(uuid, public.event_reminder_kind, date),
  public.reclaim_event_reminder(uuid, public.event_reminder_kind, date, uuid),
  public.mark_event_reminder_sent(uuid, public.event_reminder_kind, date, uuid, text),
  public.mark_event_reminder_skipped(uuid, public.event_reminder_kind, date, uuid),
  public.save_setup_draft(text, text, text, text, text, text, text, text, text),
  public.apply_role_bindings(text, integer, text, text, text, text, text, text, text)
TO service_role;

-- The same read-only access for the backup role as every other table, by the two routes
-- 20261104000009_backup_role.sql explains.
GRANT SELECT ON TABLE
  public.setup_drafts,
  public.event_steps,
  public.event_step_assignees,
  public.event_reminder_log
TO backup_ro;

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'backup_ro') THEN
    CREATE POLICY backup_ro_read ON public.setup_drafts FOR SELECT TO backup_ro USING (true);
    CREATE POLICY backup_ro_read ON public.event_steps FOR SELECT TO backup_ro USING (true);
    CREATE POLICY backup_ro_read ON public.event_step_assignees FOR SELECT TO backup_ro USING (true);
    CREATE POLICY backup_ro_read ON public.event_reminder_log FOR SELECT TO backup_ro USING (true);
  END IF;
END;
$$;

-- Food pickup no longer waits for the budget to be approved. Its people and its time
-- can be set at any time, and its reminders already needed only a time and a person.
-- 0001 raised CF428 in both functions below until Budget approved was done. They are
-- recreated here as they were, minus that check.
--
-- CREATE OR REPLACE keeps each function's owner and grants. They are stated again below
-- so that this file shows them: no EXECUTE for PUBLIC, and EXECUTE for bot_app.

-- Adds a person to a step. True if this call added them, false if they were already on
-- it. Raises 22023 for Budget approved, and CF431 once the step has its most people: 10,
-- or 15 for Food pickup.
CREATE OR REPLACE FUNCTION public.assign_event_step(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind, p_user_id text, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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

-- Sets the time of the food pickup. Returns whether Food pickup is now done, which also
-- needs at least one person on it.
CREATE OR REPLACE FUNCTION public.set_event_pickup_time(p_event_id uuid, p_guild_id text, p_pickup_time time without time zone, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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

  UPDATE public.events
  SET pickup_time = p_pickup_time
  WHERE id = p_event_id;

  RETURN public.sync_food_pickup_step(p_event_id, p_actor_id) = 'done';
END;
$$;

REVOKE ALL ON FUNCTION
  public.assign_event_step(uuid, text, public.event_step_kind, text, text),
  public.set_event_pickup_time(uuid, text, time, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  public.assign_event_step(uuid, text, public.event_step_kind, text, text),
  public.set_event_pickup_time(uuid, text, time, text)
TO bot_app;

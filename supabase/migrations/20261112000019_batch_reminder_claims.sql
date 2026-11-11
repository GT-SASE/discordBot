-- Claims, and marks sent, the reminders of one message in one call each, where a run used
-- to make one call per reminder.
--
-- Each item goes through the single-item function, claim_reminder or mark_reminder_sent, so
-- its checks, the row it locks and its answer are exactly those of that function. Items are
-- taken in key order, so two calls that share reminders lock them in the same order. The
-- whole call is one transaction: a crash or error before it commits leaves every item as it
-- was, which is what a run already allows for when a single call fails.
--
-- Answers come back as a JSON array with one element per item, in the order given. The
-- lists must all be the same length, and at most 100 long, which is far more than one
-- message holds.

-- Each element is {"claim_token": <uuid or null>, "changed": <boolean>}. A null token is
-- claim_reminder's NULL: the reminder was not claimed. "changed" is true where
-- claim_reminder would have raised CF412 because the task changed since it was read; that
-- item claims nothing and the others go on.
CREATE FUNCTION public.claim_reminders(
  p_task_ids uuid[],
  p_kinds public.reminder_kind[],
  p_due_dates date[],
  p_assignee_ids text[],
  p_updated_ats timestamptz[]
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_count integer := coalesce(pg_catalog.array_length(p_task_ids, 1), 0);
  v_results jsonb[];
  v_item record;
  v_token uuid;
BEGIN
  IF v_count > 100
    OR coalesce(pg_catalog.array_length(p_kinds, 1), 0) <> v_count
    OR coalesce(pg_catalog.array_length(p_due_dates, 1), 0) <> v_count
    OR coalesce(pg_catalog.array_length(p_assignee_ids, 1), 0) <> v_count
    OR coalesce(pg_catalog.array_length(p_updated_ats, 1), 0) <> v_count
  THEN
    RAISE EXCEPTION 'reminder lists do not match' USING ERRCODE = '22023';
  END IF;

  v_results := pg_catalog.array_fill(NULL::jsonb, ARRAY[v_count]);

  FOR v_item IN
    SELECT item.task_id, item.kind, item.due_date, item.assignee_id, item.updated_at,
           item.position
    FROM unnest(p_task_ids, p_kinds, p_due_dates, p_assignee_ids, p_updated_ats)
      WITH ORDINALITY AS item(task_id, kind, due_date, assignee_id, updated_at, position)
    ORDER BY item.task_id, item.kind, item.due_date, item.position
  LOOP
    BEGIN
      v_token := public.claim_reminder(
        v_item.task_id,
        v_item.kind,
        v_item.due_date,
        v_item.assignee_id,
        v_item.updated_at
      );
      v_results[v_item.position] :=
        pg_catalog.jsonb_build_object('claim_token', v_token, 'changed', false);
    EXCEPTION WHEN SQLSTATE 'CF412' THEN
      v_results[v_item.position] :=
        pg_catalog.jsonb_build_object('claim_token', NULL, 'changed', true);
    END;
  END LOOP;

  RETURN pg_catalog.to_jsonb(v_results);
END;
$$;

-- Each element is mark_reminder_sent's answer for that item: false if the token no longer
-- holds the claim. Every item is marked with the one message ID.
CREATE FUNCTION public.mark_reminders_sent(
  p_task_ids uuid[],
  p_kinds public.reminder_kind[],
  p_due_dates date[],
  p_claim_tokens uuid[],
  p_message_id text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_count integer := coalesce(pg_catalog.array_length(p_task_ids, 1), 0);
  v_results jsonb[];
  v_item record;
BEGIN
  IF v_count > 100
    OR coalesce(pg_catalog.array_length(p_kinds, 1), 0) <> v_count
    OR coalesce(pg_catalog.array_length(p_due_dates, 1), 0) <> v_count
    OR coalesce(pg_catalog.array_length(p_claim_tokens, 1), 0) <> v_count
  THEN
    RAISE EXCEPTION 'reminder lists do not match' USING ERRCODE = '22023';
  END IF;

  v_results := pg_catalog.array_fill(NULL::jsonb, ARRAY[v_count]);

  FOR v_item IN
    SELECT item.task_id, item.kind, item.due_date, item.claim_token, item.position
    FROM unnest(p_task_ids, p_kinds, p_due_dates, p_claim_tokens)
      WITH ORDINALITY AS item(task_id, kind, due_date, claim_token, position)
    ORDER BY item.task_id, item.kind, item.due_date, item.position
  LOOP
    v_results[v_item.position] := pg_catalog.to_jsonb(
      public.mark_reminder_sent(
        v_item.task_id,
        v_item.kind,
        v_item.due_date,
        v_item.claim_token,
        p_message_id
      )
    );
  END LOOP;

  RETURN pg_catalog.to_jsonb(v_results);
END;
$$;

REVOKE ALL ON FUNCTION
  public.claim_reminders(uuid[], public.reminder_kind[], date[], text[], timestamptz[]),
  public.mark_reminders_sent(uuid[], public.reminder_kind[], date[], uuid[], text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.claim_reminders(uuid[], public.reminder_kind[], date[], text[], timestamptz[]),
  public.mark_reminders_sent(uuid[], public.reminder_kind[], date[], uuid[], text)
TO service_role;

-- Group lifecycle operations require every group to have exactly one owner,
-- while direct conversations must never have one. Fail before adding the
-- constraints if historical or manually edited data violates either rule, so
-- an operator can repair it safely.
DO $migration$
DECLARE
  invalid_conversation_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_conversation_count
    FROM "conversations" AS conversation
   WHERE (
          conversation."type" = 'GROUP'
          AND (
            SELECT COUNT(*)
              FROM "conversation_members" AS member
             WHERE member."conversation_id" = conversation."id"
               AND member."role" = 'OWNER'
          ) <> 1
        )
      OR (
          conversation."type" = 'DIRECT'
          AND EXISTS (
            SELECT 1
              FROM "conversation_members" AS member
             WHERE member."conversation_id" = conversation."id"
               AND member."role" = 'OWNER'
          )
        );

  IF invalid_conversation_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot enforce conversation ownership: %s conversation(s) have an invalid OWNER membership count.',
        invalid_conversation_count
      ),
      HINT = 'Assign exactly one OWNER to every GROUP conversation and none to DIRECT conversations, then retry the migration.';
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX "conversation_members_one_owner_per_conversation_idx"
  ON "conversation_members"("conversation_id")
  WHERE "role" = 'OWNER';

-- The partial index above rejects a second owner immediately. Deferred
-- constraint triggers complete the invariant at commit time: every surviving
-- GROUP must have one owner, and DIRECT conversations must have none. Deferral
-- is required because an ownership transfer demotes the old owner before it
-- promotes the new one inside the same transaction.
CREATE FUNCTION "assert_conversation_owner_invariant"(
  "target_conversation_id" UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $function$
DECLARE
  conversation_kind TEXT;
  owner_count BIGINT;
BEGIN
  SELECT conversation."type"::TEXT
    INTO conversation_kind
    FROM "conversations" AS conversation
   WHERE conversation."id" = "target_conversation_id";

  -- Cascading member deletes are valid when their conversation is deleted in
  -- the same transaction.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)
    INTO owner_count
    FROM "conversation_members" AS member
   WHERE member."conversation_id" = "target_conversation_id"
     AND member."role" = 'OWNER';

  IF conversation_kind = 'GROUP' AND owner_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'GROUP conversation %s must have exactly one OWNER membership; found %s.',
        "target_conversation_id",
        owner_count
      );
  END IF;

  IF conversation_kind = 'DIRECT' AND owner_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'DIRECT conversation %s cannot have an OWNER membership.',
        "target_conversation_id"
      );
  END IF;
END;
$function$;

CREATE FUNCTION "check_conversation_member_owner_invariant"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "assert_conversation_owner_invariant"(OLD."conversation_id");
    RETURN NULL;
  END IF;

  PERFORM "assert_conversation_owner_invariant"(NEW."conversation_id");
  IF TG_OP = 'UPDATE'
     AND OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id" THEN
    PERFORM "assert_conversation_owner_invariant"(OLD."conversation_id");
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "conversation_members_owner_insert_invariant"
AFTER INSERT ON "conversation_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."role" = 'OWNER')
EXECUTE FUNCTION "check_conversation_member_owner_invariant"();

CREATE CONSTRAINT TRIGGER "conversation_members_owner_update_invariant"
AFTER UPDATE OF "role", "conversation_id" ON "conversation_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."role" = 'OWNER' OR NEW."role" = 'OWNER')
EXECUTE FUNCTION "check_conversation_member_owner_invariant"();

CREATE CONSTRAINT TRIGGER "conversation_members_owner_delete_invariant"
AFTER DELETE ON "conversation_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."role" = 'OWNER')
EXECUTE FUNCTION "check_conversation_member_owner_invariant"();

CREATE FUNCTION "check_conversation_owner_invariant"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM "assert_conversation_owner_invariant"(NEW."id");
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "conversations_owner_invariant"
AFTER INSERT OR UPDATE OF "type" ON "conversations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "check_conversation_owner_invariant"();

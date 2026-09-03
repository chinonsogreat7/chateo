-- Add per-member conversation preferences, group metadata, and user blocks.

-- The previous schema permitted metadata-free GROUP rows. A group with no
-- membership has no safe creator to infer, so stop with an actionable error
-- before making schema changes instead of leaving a partially applied migration.
DO $migration$
DECLARE
  orphan_group_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO orphan_group_count
    FROM "conversations" AS conversation
   WHERE conversation."type" = 'GROUP'
     AND NOT EXISTS (
       SELECT 1
         FROM "conversation_members" AS member
        WHERE member."conversation_id" = conversation."id"
     );

  IF orphan_group_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot migrate %s pre-existing GROUP conversation(s) without members.',
        orphan_group_count
      ),
      HINT = 'Add at least one membership to each orphan group, or remove those orphan rows, then retry the migration.';
  END IF;
END;
$migration$;

CREATE TYPE "ConversationMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

ALTER TABLE "conversations"
  ADD COLUMN "name" VARCHAR(100),
  ADD COLUMN "avatar_url" TEXT,
  ADD COLUMN "created_by_id" UUID;

ALTER TABLE "conversation_members"
  ADD COLUMN "role" "ConversationMemberRole" NOT NULL DEFAULT 'MEMBER',
  ADD COLUMN "archived_at" TIMESTAMPTZ(3),
  ADD COLUMN "muted_at" TIMESTAMPTZ(3),
  ADD COLUMN "pinned_at" TIMESTAMPTZ(3);

-- Backfill legacy groups deterministically. joined_at identifies the earliest
-- member, and user_id provides a stable tie-breaker for equal timestamps.
WITH earliest_group_members AS (
  SELECT DISTINCT ON (member."conversation_id")
    member."conversation_id",
    member."user_id"
  FROM "conversation_members" AS member
  INNER JOIN "conversations" AS conversation
    ON conversation."id" = member."conversation_id"
  WHERE conversation."type" = 'GROUP'
  ORDER BY member."conversation_id", member."joined_at", member."user_id"
)
UPDATE "conversations" AS conversation
SET
  "name" = 'Migrated group ' || conversation."id"::text,
  "created_by_id" = earliest_member."user_id"
FROM earliest_group_members AS earliest_member
WHERE conversation."id" = earliest_member."conversation_id"
  AND conversation."type" = 'GROUP';

UPDATE "conversation_members" AS member
SET "role" = 'OWNER'
FROM "conversations" AS conversation
WHERE conversation."type" = 'GROUP'
  AND member."conversation_id" = conversation."id"
  AND member."user_id" = conversation."created_by_id";

CREATE TABLE "user_blocks" (
  "blocker_id" UUID NOT NULL,
  "blocked_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id"),
  CONSTRAINT "user_blocks_not_self_check" CHECK ("blocker_id" <> "blocked_id")
);

CREATE INDEX "conversations_created_by_id_idx"
  ON "conversations"("created_by_id");
CREATE INDEX "conversation_members_user_id_archived_at_idx"
  ON "conversation_members"("user_id", "archived_at");
CREATE INDEX "conversation_members_user_id_pinned_at_idx"
  ON "conversation_members"("user_id", "pinned_at");
CREATE INDEX "user_blocks_blocked_id_blocker_id_idx"
  ON "user_blocks"("blocked_id", "blocker_id");

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blocker_id_fkey"
  FOREIGN KEY ("blocker_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blocked_id_fkey"
  FOREIGN KEY ("blocked_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Direct conversations have no group metadata. Groups require a nonblank name
-- and creator while leaving the canonical direct-user pair empty.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_direct_pair_check";
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_shape_check"
  CHECK (
    (
      "type" = 'DIRECT'
      AND "direct_user_one_id" IS NOT NULL
      AND "direct_user_two_id" IS NOT NULL
      AND "direct_user_one_id" < "direct_user_two_id"
      AND "name" IS NULL
      AND "avatar_url" IS NULL
      AND "created_by_id" IS NULL
    )
    OR
    (
      "type" = 'GROUP'
      AND "direct_user_one_id" IS NULL
      AND "direct_user_two_id" IS NULL
      AND "name" IS NOT NULL
      AND length(btrim("name")) > 0
      AND "created_by_id" IS NOT NULL
    )
  );

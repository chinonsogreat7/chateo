ALTER TABLE "conversation_members"
  ADD COLUMN "muted_until" TIMESTAMPTZ(3),
  ADD COLUMN "favorited_at" TIMESTAMPTZ(3),
  ADD COLUMN "cleared_at" TIMESTAMPTZ(3),
  ADD COLUMN "cleared_through_message_id" UUID;

-- A null muted_at means unmuted. A non-null muted_at with no end time means
-- muted indefinitely; finite mutes must end after they begin.
ALTER TABLE "conversation_members"
  ADD CONSTRAINT "conversation_members_mute_window_check"
  CHECK (
    ("muted_at" IS NULL AND "muted_until" IS NULL)
    OR (
      "muted_at" IS NOT NULL
      AND ("muted_until" IS NULL OR "muted_until" > "muted_at")
    )
  );

ALTER TABLE "conversation_members"
  ADD CONSTRAINT "conversation_members_clear_boundary_check"
  CHECK (
    ("cleared_at" IS NULL AND "cleared_through_message_id" IS NULL)
    OR (
      "cleared_at" IS NOT NULL
      AND "cleared_through_message_id" IS NOT NULL
    )
  );

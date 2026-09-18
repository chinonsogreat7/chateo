-- Per-member visibility only: preserve the shared conversation and messages.
ALTER TABLE "conversation_members" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);
CREATE INDEX "conversation_members_user_id_deleted_at_idx"
  ON "conversation_members"("user_id", "deleted_at");

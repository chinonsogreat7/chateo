-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT');

-- AlterTable
ALTER TABLE "conversation_members"
  ADD COLUMN "unread_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_read_at" TIMESTAMPTZ(3);

-- Membership unread counters must never become negative.
ALTER TABLE "conversation_members"
  ADD CONSTRAINT "conversation_members_unread_count_check"
  CHECK ("unread_count" >= 0);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "client_message_id" UUID NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
    "text" VARCHAR(4000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "messages_text_check"
      CHECK (
        char_length("text") BETWEEN 1 AND 4000
        AND "text" !~ '^[[:space:]]*$'
      )
);

-- CreateIndex
CREATE UNIQUE INDEX "messages_sender_id_client_message_id_key"
  ON "messages"("sender_id", "client_message_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_id_idx"
  ON "messages"("conversation_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey"
  FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A sender must be a member of the conversation they are writing to. The API
-- checks this first; the composite FK also protects future/raw database writes.
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_sender_member_fkey"
  FOREIGN KEY ("conversation_id", "sender_id")
  REFERENCES "conversation_members"("conversation_id", "user_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

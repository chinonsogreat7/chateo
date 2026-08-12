-- A receipt belongs to both a message and a conversation member. The redundant
-- conversation_id lets PostgreSQL enforce that both sides refer to the same
-- conversation, which remains safe when group conversations are introduced.
ALTER TABLE "messages"
ADD CONSTRAINT "messages_id_conversation_id_key" UNIQUE ("id", "conversation_id");

ALTER TABLE "conversation_members"
ADD COLUMN "receipt_version" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "conversation_members_receipt_version_nonnegative_check"
CHECK ("receipt_version" >= 0);

CREATE TABLE "message_receipts" (
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "message_receipts_pkey" PRIMARY KEY ("message_id", "user_id"),
    CONSTRAINT "message_receipts_read_after_delivery_check"
      CHECK ("read_at" IS NULL OR "read_at" >= "delivered_at")
);

CREATE INDEX "message_receipts_conversation_id_user_id_read_at_idx"
ON "message_receipts"("conversation_id", "user_id", "read_at");

ALTER TABLE "message_receipts"
ADD CONSTRAINT "message_receipts_message_id_conversation_id_fkey"
FOREIGN KEY ("message_id", "conversation_id")
REFERENCES "messages"("id", "conversation_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_receipts"
ADD CONSTRAINT "message_receipts_conversation_id_user_id_fkey"
FOREIGN KEY ("conversation_id", "user_id")
REFERENCES "conversation_members"("conversation_id", "user_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "MessageKind" ADD VALUE 'VIDEO';
ALTER TYPE "MessageKind" ADD VALUE 'DOCUMENT';

ALTER TABLE "messages"
  ADD COLUMN "send_fingerprint" VARCHAR(64),
  ADD COLUMN "reply_to_message_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(3),
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "messages_version_check" CHECK ("version" >= 0),
  ADD CONSTRAINT "messages_send_fingerprint_check" CHECK ("send_fingerprint" IS NULL OR "send_fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "messages_reply_not_self_check" CHECK ("reply_to_message_id" IS NULL OR "reply_to_message_id" <> "id");

ALTER TABLE "messages" DROP CONSTRAINT "messages_text_kind_check";
ALTER TABLE "messages" ADD CONSTRAINT "messages_text_kind_check"
  CHECK ("deleted_at" IS NOT NULL OR "kind" <> 'TEXT' OR "text" IS NOT NULL);

CREATE INDEX "messages_reply_to_message_id_conversation_id_idx" ON "messages"("reply_to_message_id", "conversation_id");
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_conversation_id_fkey"
  FOREIGN KEY ("reply_to_message_id", "conversation_id") REFERENCES "messages"("id", "conversation_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "message_reactions" (
  "message_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "emoji" VARCHAR(32) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("message_id", "user_id"),
  CONSTRAINT "message_reactions_emoji_check" CHECK ("emoji" IN ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "message_reactions_user_id_idx" ON "message_reactions"("user_id");

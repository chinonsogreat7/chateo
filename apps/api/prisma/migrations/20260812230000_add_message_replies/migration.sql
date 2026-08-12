-- A reply target is optional, but when present it must belong to the same
-- conversation as the replying message. Replies are restricted from pointing
-- at a message that is being deleted.
ALTER TABLE "messages"
ADD COLUMN "reply_to_message_id" UUID;

CREATE INDEX "messages_reply_to_message_id_conversation_id_idx"
ON "messages"("reply_to_message_id", "conversation_id");

ALTER TABLE "messages"
ADD CONSTRAINT "messages_reply_to_message_id_conversation_id_fkey"
FOREIGN KEY ("reply_to_message_id", "conversation_id")
REFERENCES "messages"("id", "conversation_id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

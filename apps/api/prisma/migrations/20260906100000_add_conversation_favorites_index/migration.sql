CREATE INDEX "conversation_members_user_id_favorited_at_idx"
ON "conversation_members"("user_id", "favorited_at");

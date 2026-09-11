-- Keep existing avatar URLs readable; all new assignments use verified media.
ALTER TABLE "conversations" ADD COLUMN "avatar_media_id" UUID;

CREATE INDEX "conversations_avatar_media_id_idx" ON "conversations"("avatar_media_id");

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_avatar_media_id_fkey"
  FOREIGN KEY ("avatar_media_id") REFERENCES "media_assets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

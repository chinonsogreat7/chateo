-- AlterEnum
ALTER TYPE "MessageKind" ADD VALUE 'IMAGE';

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "text" DROP NOT NULL;

-- A claim is retained on the media asset even if its message attachment is
-- later deleted through cascading conversation cleanup.
ALTER TABLE "media_assets" ADD COLUMN "message_claimed_at" TIMESTAMPTZ(3);

-- TEXT validity is row-local and belongs in PostgreSQL. Requiring every IMAGE
-- row to have a child attachment is cross-table and remains application-enforced.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_text_kind_check"
  CHECK ("kind" <> 'TEXT' OR "text" IS NOT NULL);

-- CreateTable
CREATE TABLE "message_attachments" (
    "message_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("message_id", "position")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_media_asset_id_key" ON "message_attachments"("media_asset_id");

-- Data integrity constraints not expressible in the Prisma schema
ALTER TABLE "message_attachments"
  ADD CONSTRAINT "message_attachments_position_check"
  CHECK ("position" >= 0);

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

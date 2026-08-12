-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'GROUP');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'DIRECT',
    "direct_user_one_id" UUID,
    "direct_user_two_id" UUID,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id", "user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_direct_user_one_id_direct_user_two_id_key"
    ON "conversations"("direct_user_one_id", "direct_user_two_id");

-- CreateIndex
CREATE INDEX "conversations_direct_user_one_id_idx" ON "conversations"("direct_user_one_id");

-- CreateIndex
CREATE INDEX "conversations_direct_user_two_id_idx" ON "conversations"("direct_user_two_id");

-- CreateIndex
CREATE INDEX "conversations_last_activity_at_id_idx" ON "conversations"("last_activity_at", "id");

-- CreateIndex
CREATE INDEX "conversation_members_user_id_conversation_id_idx"
    ON "conversation_members"("user_id", "conversation_id");

-- Direct conversations must store the two user ids in canonical ascending order.
-- Group conversations intentionally leave the pair columns empty.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_direct_pair_check"
  CHECK (
    ("type" = 'DIRECT' AND "direct_user_one_id" IS NOT NULL AND "direct_user_two_id" IS NOT NULL
      AND "direct_user_one_id" < "direct_user_two_id")
    OR
    ("type" = 'GROUP' AND "direct_user_one_id" IS NULL AND "direct_user_two_id" IS NULL)
  );

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_user_one_id_fkey"
    FOREIGN KEY ("direct_user_one_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_direct_user_two_id_fkey"
    FOREIGN KEY ("direct_user_two_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

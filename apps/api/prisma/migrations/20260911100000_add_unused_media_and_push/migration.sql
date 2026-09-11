ALTER TABLE "media_assets" ADD COLUMN "unused_since" TIMESTAMPTZ(3);
CREATE INDEX "media_assets_status_unused_since_id_idx" ON "media_assets"("status", "unused_since", "id");

CREATE TYPE "PushStatus" AS ENUM ('PENDING', 'RECEIPT', 'SENT', 'SKIPPED', 'FAILED');
CREATE TABLE "push_devices" (
  "id" UUID NOT NULL PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "family_id" UUID NOT NULL,
  "platform" "DevicePlatform" NOT NULL,
  "token" VARCHAR(255),
  "token_hash" CHAR(64) UNIQUE,
  "version" INTEGER NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "registered_at" TIMESTAMPTZ(3) NOT NULL,
  "disabled_at" TIMESTAMPTZ(3),
  CHECK ("platform" IN ('IOS', 'ANDROID')),
  CHECK (("token" IS NULL) = ("token_hash" IS NULL)),
  CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "push_devices_user_id_disabled_at_idx" ON "push_devices"("user_id", "disabled_at");
CREATE TABLE "push_notifications" (
  "id" UUID NOT NULL PRIMARY KEY,
  "message_id" UUID NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "device_id" UUID NOT NULL REFERENCES "push_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "device_version" INTEGER NOT NULL CHECK ("device_version" >= 0),
  "status" "PushStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
  "lease_token" UUID,
  "lease_until" TIMESTAMPTZ(3),
  "ticket_id" VARCHAR(255),
  "ticket_at" TIMESTAMPTZ(3),
  "error_code" VARCHAR(64),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "push_notifications_message_id_device_id_key" UNIQUE ("message_id", "device_id")
);
CREATE INDEX "push_notifications_status_next_attempt_at_id_idx" ON "push_notifications"("status", "next_attempt_at", "id");
CREATE INDEX "push_notifications_device_id_idx" ON "push_notifications"("device_id");

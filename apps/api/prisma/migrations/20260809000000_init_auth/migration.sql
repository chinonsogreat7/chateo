-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('SIGN_IN');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SessionRevocationReason" AS ENUM ('ROTATED', 'LOGOUT', 'REUSE_DETECTED', 'ADMIN');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone_number" VARCHAR(16) NOT NULL,
    "phone_verified_at" TIMESTAMPTZ(3) NOT NULL,
    "display_name" VARCHAR(80),
    "avatar_url" TEXT,
    "profile_completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "phone_number" VARCHAR(16) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL DEFAULT 'SIGN_IN',
    "code_digest" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "resend_available_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts_remaining" INTEGER NOT NULL DEFAULT 5,
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_attempt_budgets" (
    "phone_number" VARCHAR(16) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "otp_attempt_budgets_pkey" PRIMARY KEY ("phone_number")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_digest" CHAR(64) NOT NULL,
    "device_name" VARCHAR(120),
    "platform" "DevicePlatform" NOT NULL DEFAULT 'UNKNOWN',
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" "SessionRevocationReason",
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_number_key" ON "users"("phone_number");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_number_created_at_idx" ON "otp_challenges"("phone_number", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "otp_attempt_budgets_locked_until_idx" ON "otp_attempt_budgets"("locked_until");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_digest_key" ON "auth_sessions"("token_digest");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_replaced_by_id_key" ON "auth_sessions"("replaced_by_id");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "auth_sessions_family_id_revoked_at_idx" ON "auth_sessions"("family_id", "revoked_at");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- Security and domain constraints not expressible in the Prisma schema
ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_number_e164_check"
  CHECK ("phone_number" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "users_profile_completion_check"
  CHECK ("profile_completed_at" IS NULL OR "display_name" IS NOT NULL);

ALTER TABLE "otp_challenges"
  ADD CONSTRAINT "otp_challenges_phone_number_e164_check"
  CHECK ("phone_number" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "otp_challenges_attempts_check"
  CHECK ("attempts_remaining" BETWEEN 0 AND 10),
  ADD CONSTRAINT "otp_challenges_time_order_check"
  CHECK ("last_sent_at" <= "resend_available_at" AND "last_sent_at" < "expires_at");

ALTER TABLE "otp_attempt_budgets"
  ADD CONSTRAINT "otp_attempt_budgets_phone_number_e164_check"
  CHECK ("phone_number" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "otp_attempt_budgets_failures_check"
  CHECK ("failed_attempts" BETWEEN 0 AND 10);

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_time_order_check"
  CHECK ("last_used_at" < "expires_at");

CREATE UNIQUE INDEX "otp_challenges_one_active_per_phone_purpose_key"
  ON "otp_challenges"("phone_number", "purpose")
  WHERE "consumed_at" IS NULL;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "auth_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

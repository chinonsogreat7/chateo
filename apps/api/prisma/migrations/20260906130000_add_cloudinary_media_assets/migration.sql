-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('PROFILE_AVATAR', 'GROUP_AVATAR', 'MESSAGE_ATTACHMENT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'DELETED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "avatar_media_id" UUID;

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "client_upload_id" UUID NOT NULL,
    "upload_fingerprint" VARCHAR(64) NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "cloudinary_public_id" VARCHAR(255) NOT NULL,
    "cloudinary_asset_id" VARCHAR(255),
    "resource_type" VARCHAR(16) NOT NULL DEFAULT 'image',
    "delivery_type" VARCHAR(32) NOT NULL DEFAULT 'upload',
    "format" VARCHAR(32),
    "mime_type" VARCHAR(127) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "content_sha256" VARCHAR(64),
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "original_filename" VARCHAR(255),
    "secure_url" TEXT,
    "etag" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_avatar_media_id_key" ON "users"("avatar_media_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_cloudinary_public_id_key" ON "media_assets"("cloudinary_public_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_cloudinary_asset_id_key" ON "media_assets"("cloudinary_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_owner_id_client_upload_id_key" ON "media_assets"("owner_id", "client_upload_id");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_created_at_idx" ON "media_assets"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "media_assets_status_expires_at_idx" ON "media_assets"("status", "expires_at");

-- Data integrity constraints not expressible in the Prisma schema
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_upload_fingerprint_check"
  CHECK ("upload_fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "media_assets_content_sha256_check"
  CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "media_assets_byte_size_check"
  CHECK ("byte_size" > 0),
  ADD CONSTRAINT "media_assets_dimensions_check"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)),
  ADD CONSTRAINT "media_assets_duration_check"
  CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0),
  ADD CONSTRAINT "media_assets_expiry_check"
  CHECK ("expires_at" > "created_at");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_media_id_fkey" FOREIGN KEY ("avatar_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

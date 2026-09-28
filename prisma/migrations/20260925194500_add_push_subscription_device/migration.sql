-- AlterTable
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "deviceType" TEXT;
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

-- Link daily update photos to a daily issue row (JSON issueId).
ALTER TABLE "DailyUpdatePhoto" ADD COLUMN IF NOT EXISTS "issueId" TEXT;

CREATE INDEX IF NOT EXISTS "DailyUpdatePhoto_issueId_idx" ON "DailyUpdatePhoto"("issueId");

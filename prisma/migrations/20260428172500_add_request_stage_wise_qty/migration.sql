-- Add stage-wise quantity payload for multi-stage requests.
ALTER TABLE "Request"
ADD COLUMN IF NOT EXISTS "stageWiseQty" JSONB;

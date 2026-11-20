-- Plot size master list for stages filtering
CREATE TABLE IF NOT EXISTS "PlotSize" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlotSize_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlotSize_name_key" ON "PlotSize"("name");

INSERT INTO "PlotSize" ("name", "sortOrder", "updatedAt")
VALUES
  ('1 Marla', 1, CURRENT_TIMESTAMP),
  ('3 Marla', 2, CURRENT_TIMESTAMP),
  ('5 Marla', 3, CURRENT_TIMESTAMP),
  ('10 Marla', 4, CURRENT_TIMESTAMP),
  ('15 Marla', 5, CURRENT_TIMESTAMP),
  ('1 Kanal', 6, CURRENT_TIMESTAMP),
  ('Other', 99, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- Link stages to a plot size (existing rows -> Other)
ALTER TABLE "Stage" ADD COLUMN IF NOT EXISTS "plotSizeId" INTEGER;

UPDATE "Stage" s
SET "plotSizeId" = ps.id
FROM "PlotSize" ps
WHERE ps.name = 'Other'
  AND s."plotSizeId" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Stage_name_key'
  ) THEN
    ALTER TABLE "Stage" DROP CONSTRAINT "Stage_name_key";
  END IF;
END $$;

DROP INDEX IF EXISTS "Stage_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Stage_name_plotSizeId_key"
  ON "Stage"("name", "plotSizeId");

CREATE INDEX IF NOT EXISTS "Stage_plotSizeId_idx" ON "Stage"("plotSizeId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Stage_plotSizeId_fkey'
  ) THEN
    ALTER TABLE "Stage"
      ADD CONSTRAINT "Stage_plotSizeId_fkey"
      FOREIGN KEY ("plotSizeId") REFERENCES "PlotSize"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

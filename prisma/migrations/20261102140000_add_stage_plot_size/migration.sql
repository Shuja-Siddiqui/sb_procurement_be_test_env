-- Add plot_size to Stage templates so stages can differ by project size.
ALTER TABLE "Stage" ADD COLUMN IF NOT EXISTS "plot_size" TEXT NOT NULL DEFAULT '';

-- Replace name-only uniqueness with name + plot_size.
DROP INDEX IF EXISTS "Stage_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Stage_name_plot_size_key" ON "Stage"("name", "plot_size");
CREATE INDEX IF NOT EXISTS "Stage_plot_size_idx" ON "Stage"("plot_size");

-- Speed up dashboard latest-requests: ORDER BY "createdAt" DESC without siteId filter.
CREATE INDEX IF NOT EXISTS "Request_createdAt_idx" ON "Request"("createdAt");

# Mark existing migrations as already applied WITHOUT running SQL (safe for production
# when the DB was created manually / outside Prisma and already matches prisma/schema.prisma).
#
# Prerequisites:
# 1) Backup production in Supabase.
# 2) Point DATABASE_URL at a DIRECT Postgres URL (db.<project>.supabase.co:5432), NOT the
#    transaction pooler — pooled URLs often break DDL and migrate tooling.
# 3) Confirm prod schema matches your repo (optional sanity check):
#      npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-url "$env:DATABASE_URL" --script
#    If that prints SQL, prod and schema.prisma differ — fix that before baselining.
#
# Run from sb_procurement_be_v2:
#   $env:DATABASE_URL = "<direct production URL>"
#   .\scripts\baseline-migrations.ps1

$ErrorActionPreference = "Stop"

$migrations = @(
  "20250912121002_init",
  "20260420120000_add_daily_material_update",
  "20260428130000_remove_cashflow_bank_mode_vendor",
  "20260428172500_add_request_stage_wise_qty",
  "20260429080419_init_supabase",
  "20260507104038_verify_shadow_apply"
)

if (-not $env:DATABASE_URL) {
  Write-Error "DATABASE_URL is not set. Use your production DIRECT connection string."
}

foreach ($name in $migrations) {
  Write-Host "Resolving as applied: $name"
  npx prisma migrate resolve --applied $name
}

Write-Host "Done. Future schema changes: create migrations locally, then run ``npm run db:migrate:deploy`` against prod with DATABASE_URL set (direct URL recommended)."

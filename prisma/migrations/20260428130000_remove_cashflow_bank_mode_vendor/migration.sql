-- Drop deprecated finance/vendor tables.
-- CASCADE ensures dependent foreign keys/indexes are removed safely.
DROP TABLE IF EXISTS "CashFlow" CASCADE;
DROP TABLE IF EXISTS "Bank" CASCADE;
DROP TABLE IF EXISTS "Mode" CASCADE;
DROP TABLE IF EXISTS "VendorProduct" CASCADE;
DROP TABLE IF EXISTS "Vendor" CASCADE;

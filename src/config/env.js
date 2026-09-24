const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "../../.env") });

const env = process.env.NODE_ENV || "local";

const useProductionDatabase = () => {
  const raw = String(process.env.USE_PRODUCTION_DATABASE || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
};

const applyDatabaseEnv = () => {
  if (useProductionDatabase()) {
    if (process.env.PRODUCTION_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.PRODUCTION_DATABASE_URL;
    }
    if (process.env.PRODUCTION_DIRECT_URL) {
      process.env.DIRECT_URL = process.env.PRODUCTION_DIRECT_URL;
    }
    return;
  }

  if (env === "production") {
    if (process.env.PRODUCTION_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.PRODUCTION_DATABASE_URL;
    }
    if (process.env.PRODUCTION_DIRECT_URL) {
      process.env.DIRECT_URL = process.env.PRODUCTION_DIRECT_URL;
    }
  }

  if (env === "local") {
    if (process.env.LOCAL_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.LOCAL_DATABASE_URL;
    }
    if (process.env.LOCAL_DIRECT_URL) {
      process.env.DIRECT_URL = process.env.LOCAL_DIRECT_URL;
    }
  }
};

applyDatabaseEnv();

module.exports = { env };

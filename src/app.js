const { env } = require("./config/env");

// Required Imports
const express = require("express");
const http = require("http");
const cors = require("cors");
const routes = require("./routes");
const expressFileUpload = require("express-fileupload");
const {
  ensureUploadsDir,
  UPLOADS_ROOT,
  UPLOADS_DIR,
} = require("./lib/uploadFile");
const { initLogger, requestLogger } = require("./lib/logger");

const { initSocket } = require("./lib/socket");

initLogger();

const app = express();
const server = http.createServer(app);
initSocket(server);

const PORT = process.env.PORT || 5000;

// Vercel / reverse proxies: honor X-Forwarded-Proto so req.protocol is https
app.set("trust proxy", 1);

// Middlewares
app.use(cors());
app.use(requestLogger);
// JSON / multipart: no practical cap unless JSON_BODY_LIMIT is set (e.g. "50mb" for production)
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || Number.MAX_SAFE_INTEGER;
app.use(express.json({ limit: jsonBodyLimit }));
app.use(
  expressFileUpload({
    limits: { fileSize: Number.MAX_SAFE_INTEGER },
    abortOnLimit: false,
  })
);
// Make uploads folder public (PDFs from agreement / daily update / chat land here)
// Route + folder name come from UPLOADS_DIR in .env (default: uploads)
ensureUploadsDir();
app.use(
  `/${UPLOADS_DIR}`,
  express.static(UPLOADS_ROOT, {
    setHeaders: (res, filePath) => {
      if (String(filePath).toLowerCase().endsWith(".pdf")) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "inline");
      }
      // Allow FE (different port/host) to fetch PDFs for preview
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  }),
);

// ✅ Add health route
app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/v1", routes);

// Start HTTP server for local/production Node hosting.
// On platforms like Vercel (serverless), exporting the Express app is enough.
if (env === "production" || env === "local") {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} in ${env} mode`);
  });
}

// For Vercel's @vercel/node, exporting the Express app is enough.
module.exports = app;

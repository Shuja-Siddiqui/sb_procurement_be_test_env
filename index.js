// Entry point for Vercel serverless function.
// Export the Express app instance created in src/app.js.

const app = require("./src/app");

// app here is already an Express instance (see src/app.js)
module.exports = app;

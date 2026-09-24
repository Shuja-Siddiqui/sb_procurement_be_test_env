const { env } = require("./config/env");

// Required Imports
const express = require("express");
const http = require("http"); // ✅ import http
const { initSocket } = require("./socket");
const cors = require("cors");
const routes = require("./routes");
const expressFileUpload = require("express-fileupload");
const { Server } = require("socket.io"); // ✅ import socket.io

const app = express();
const server = http.createServer(app); // ✅ create server using http
// const io = new Server(server, {
//   cors: {
//     origin: "*", // Customize in production for security
//     methods: ["GET", "POST"],
//   },
// });

const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors());
// JSON / multipart: no practical cap unless JSON_BODY_LIMIT is set (e.g. "50mb" for production)
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || Number.MAX_SAFE_INTEGER;
app.use(express.json({ limit: jsonBodyLimit }));
app.use(
  expressFileUpload({
    limits: { fileSize: Number.MAX_SAFE_INTEGER },
    abortOnLimit: false,
  })
);
// Make uploads folder public
app.use("/uploads", express.static("uploads"));

// ✅ Add health route
app.get("/health", (req, res) => res.json({ ok: true }));

// app.use(express.static(path.join(__dirname, "../public")));
app.use("/api/v1", routes);

// ✅ Socket.IO setup
// io.on("connection", (socket) => {
//   console.log("New client connected:", socket.id);

//   // Example event
//   socket.on("send_message", (data) => {
//     console.log("Message received:", data);
//     io.emit("receive_message", data); // broadcast to all clients
//   });

//   socket.on("join_room", (groupId) => {
//     socket.join(groupId.toString());
//     console.log(`User joined room ${groupId}`);
//   });

//   socket.on("disconnect", () => {
//     console.log("Client disconnected:", socket.id);
//   });
// });

initSocket(server); // ✅ Initialize socket

// Start server
// if (process.env.NODE_ENV === "local") {
//   app.listen(PORT, () => {
//     console.log(`\x1b[36m%s\x1b[0m`, `Server running on port ${PORT}`);
//   });
// }

// Start server (only if NODE_ENV === local)
// if (process.env.NODE_ENV === "local") {
//   server.listen(PORT, () => {
//     console.log(`Server running on port ${PORT}`);
//   });
// }

// Only start the HTTP server when running locally.
// On platforms like Vercel (serverless), we just export the Express app
// and let the platform handle the HTTP server.
if (env === "local") {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} in ${env} mode`);
  });
}

// For Vercel's @vercel/node, exporting the Express app is enough.
module.exports = app;

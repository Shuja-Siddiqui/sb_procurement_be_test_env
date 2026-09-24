let io = null;

function initSocket(server) {
  const { Server } = require("socket.io");

  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("⚡ Socket connected:", socket.id);

    socket.on("user_connected", (userId) => {
      const parsedUserId = Number(userId);
      if (!Number.isFinite(parsedUserId) || parsedUserId <= 0) return;
      const room = `user:${parsedUserId}`;
      socket.join(room);
      console.log(`👤 User ${parsedUserId} joined room ${room}`);
    });

    // Example event
    socket.on("send_message", (data) => {
      console.log("Message received:", data);
      io.emit("receive_message", data); // broadcast to all clients
    });

    socket.on("join_room", (roomId) => {
      console.log(roomId)
      console.log("👥 Joining room:", roomId);
      socket.join(roomId.toString());
    });
    console.log("hi");

    socket.on("disconnect", () => {
      console.log("🔌 Socket disconnected:", socket.id);
    });
  });
}

function getSocket() {
  if (!io) {
    throw new Error("❌ Socket.io not initialized");
  }
  return io;
}

function emitToUsers(userIds = [], eventName, payload) {
  if (!io || !Array.isArray(userIds) || userIds.length === 0 || !eventName) return;
  [...new Set(userIds)]
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .forEach((id) => {
      io.to(`user:${id}`).emit(eventName, payload);
    });
}

function emitBroadcast(eventName, payload) {
  if (!io || !eventName) return;
  io.emit(eventName, payload);
}

module.exports = { initSocket, getSocket, emitToUsers, emitBroadcast };

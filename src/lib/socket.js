let io = null;

const WRITE_ACTIONS = new Set([
  "create",
  "update",
  "upsert",
  "delete",
  "createMany",
  "updateMany",
  "deleteMany",
]);

const pickId = (key, result, args) => {
  const fromResult =
    result && typeof result === "object" && !Array.isArray(result)
      ? result[key]
      : undefined;
  if (fromResult != null && fromResult !== "") return Number(fromResult) || fromResult;

  const data = args?.data;
  if (data && typeof data === "object" && !Array.isArray(data) && data[key] != null) {
    return Number(data[key]) || data[key];
  }
  if (Array.isArray(data) && data[0] && data[0][key] != null) {
    return Number(data[0][key]) || data[0][key];
  }

  const where = args?.where;
  if (where && typeof where === "object" && where[key] != null) {
    return Number(where[key]) || where[key];
  }
  return null;
};

const initSocket = (httpServer) => {
  const { Server } = require("socket.io");
  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      credentials: false,
    },
    path: "/socket.io",
    transports: ["polling", "websocket"],
    allowUpgrades: true,
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  io.on("connection", (socket) => {
    console.log("[Socket] client connected", socket.id);
    socket.on("join", (rooms = []) => {
      const list = Array.isArray(rooms) ? rooms : [rooms];
      list
        .map((room) => String(room || "").trim())
        .filter(Boolean)
        .forEach((room) => socket.join(room));
      console.log("[Socket] join", { socketId: socket.id, rooms: list });
    });
    socket.on("disconnect", () => {
      console.log("[Socket] client disconnected", socket.id);
    });
  });

  console.log("[Socket] Socket.IO ready on path /socket.io");
  return io;
};

const getIO = () => io;

const emitDbChange = (payload = {}) => {
  if (!io) {
    console.warn("[Socket] emit skipped — io not initialized", {
      table: payload?.table,
      action: payload?.action,
    });
    return;
  }
  const table = String(payload.table || "").trim();
  if (!table) return;

  const eventPayload = {
    table,
    action: payload.action || "update",
    siteId: payload.siteId ?? null,
    groupId: payload.groupId ?? null,
    userId: payload.userId ?? null,
    record: payload.record ?? null,
    at: new Date().toISOString(),
  };

  io.emit("db:change", eventPayload);

  // Targeted rooms for chat / notifications when ids are known
  if (eventPayload.groupId != null) {
    io.to(`group:${eventPayload.groupId}`).emit("db:change", eventPayload);
  }
  if (eventPayload.userId != null) {
    io.to(`user:${eventPayload.userId}`).emit("db:change", eventPayload);
    // Dedicated notification event for Navbar badge/list refresh
    if (table === "Notification") {
      io.to(`user:${eventPayload.userId}`).emit("notification:new", eventPayload);
      io.emit("notification:new", eventPayload);
    }
  }
  io.to(`table:${table}`).emit("db:change", eventPayload);
};

const emitNotificationsCreated = (userIds = [], meta = {}) => {
  const ids = [...new Set((userIds || []).map((id) => Number(id)))].filter(
    (id) => Number.isFinite(id) && id > 0,
  );
  ids.forEach((userId) => {
    emitDbChange({
      table: "Notification",
      action: "createMany",
      userId,
      record: null,
      ...meta,
    });
  });
};

const shouldEmitAction = (action) => WRITE_ACTIONS.has(String(action || ""));

module.exports = {
  initSocket,
  getIO,
  emitDbChange,
  emitNotificationsCreated,
  shouldEmitAction,
  pickId,
};

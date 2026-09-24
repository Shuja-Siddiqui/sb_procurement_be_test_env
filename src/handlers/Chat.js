const { MessageType } = require("@prisma/client");
const prisma = require("../lib/prisma");
const Response = require("./Response");
const { getSocket } = require("../socket");

class Chat extends Response {
  // Create a group
  createGroup = async (req, res) => {
    try {
      const { name, createdById } = req.body;
      const group = await prisma.chatGroup.create({
        data: {
          name,
          createdById,
        },
      });

      // Add creator as a member
      await prisma.chatMember.create({
        data: {
          userId: createdById,
          groupId: group.id,
        },
      });

      return this.sendResponse(req, res, {
        status: 201,
        message: "Group created",
        data: group,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Group creation failed",
        error: error.message,
      });
    }
  };

  // Join a group
  joinGroup = async (req, res) => {
    try {
      const groupId = parseInt(req.params.id);
      const { userId } = req.body;

      const existing = await prisma.chatMember.findUnique({
        where: {
          userId_groupId: { userId, groupId },
        },
      });

      if (existing) {
        return this.sendResponse(req, res, {
          status: 400,
          message: "User already in group",
        });
      }

      const member = await prisma.chatMember.create({
        data: { userId, groupId },
      });

      return this.sendResponse(req, res, {
        status: 200,
        message: "User added to group",
        data: member,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Join group failed",
        error: error.message,
      });
    }
  };

  // Send a message
  sendMessage = async (req, res) => {
    try {
      const groupId = parseInt(req.params.id);
      const { senderId, content, audioDuration, type } = req.body;

      let mediaUrl = null;
      let audioBuffer = null;
      let fileBuffer = null;
      let fileName = null;
      let mimeType = null;

      if (type === "AUDIO") {
        const audioFile = req.files?.audio;
        if (!audioFile) {
          return res.status(400).json({ error: "No audio file uploaded" });
        }

        // ✅ Save audio directly to database (not file system)
        audioBuffer = audioFile.data;
      }
      // ✅ Handle file upload
      if (type === "FILE" || type === "IMAGE") {
        const file = req.files?.file;
        if (!file) {
          return res.status(400).json({ error: "No file uploaded" });
        }
        fileBuffer = file.data;
        fileName = file.name;
        mimeType = file.mimetype;
      }

      const message = await prisma.message.create({
        data: {
          senderId: parseInt(senderId),
          groupId,
          content:
            type === "AUDIO"
              ? "Voice message"
              : type === "FILE" || type === "IMAGE"
              ? `File: ${fileName}`
              : content,

          type: type || "TEXT",
          mediaUrl: mediaUrl || null,
          audioData: audioBuffer,
          audioDuration: type === "AUDIO" ? parseInt(audioDuration) : null,
          fileData: fileBuffer, // Add this field in your DB if not already present
          fileName,
          mimeType,
        },
        include: {
          sender: { select: { id: true, name: true } },
        },
      });
      // ✅ Update last message in Group table
      await prisma.chatGroup.update({
        where: { id: groupId },
        data: {
          lastMessage: message.content,
        },
      });
      await prisma.chatMember.updateMany({
        where: { groupId, userId: parseInt(senderId) },
        data: { lastSeenAt: new Date() },
      });
      const io = getSocket();
      io.to(groupId.toString()).emit("new_message", message);
      io.emit("send_message", message);

      return res.status(201).json(message);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  };

  // Get audio file
  getAudioMessage = async (req, res) => {
    try {
      const messageId = parseInt(req.params.id);
      const message = await prisma.message.findUnique({
        where: { id: messageId },
      });

      if (!message || !message.audioData) {
        return res.status(404).json({ error: "Audio not found" });
      }

      res.setHeader("Content-Type", "audio/webm");
      res.send(Buffer.from(message.audioData));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  // Get  file
  getFiles = async (req, res) => {
    try {
      const messageId = parseInt(req.params.id);
      const message = await prisma.message.findUnique({
        where: { id: messageId },
      });

      if (!message || !message.fileData) {
        return res.status(404).json({ error: "Audio not found" });
      }

      res.setHeader("Content-Type", "audio/webm");
      res.send(Buffer.from(message.fileData));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  // Get messages for a group
  getMessages = async (req, res) => {
    try {
      const groupId = parseInt(req.params.id);
      const skip = parseInt(req.query.skip);
      const take = parseInt(req.query.take);
      const messages = await prisma.message.findMany({
        where: { groupId },
        include: {
          sender: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
        // ✅ limit to first 40 messages
      });
      messages.reverse();
      // ✅ Total messages in this group
      const totalMessages = await prisma.message.count({
        where: { groupId },
      });

      const memberCount = await prisma.chatMember.count({
        where: { groupId },
      });

      return this.sendResponse(req, res, {
        status: 200,
        data: {
          memberCount,
          totalMessages,
          messages,
        },
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Could not fetch messages",
        error: error.message,
      });
    }
  };

  // Get  groups
  getGroupsByUserId = async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);

      const groups = await prisma.chatMember.findMany({
        where: { userId: userId },
        select: {
          groupId: true,
          group: {
            select: {
              name: true,
              lastMessage: true,
              // Add more fields if needed like createdAt, etc.
            },
          },
        },
      });
      return this.sendResponse(req, res, {
        status: 200,
        data: groups,
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Could not fetch groups",
        error: error.message,
      });
    }
  };

  // Get group members
  getGroupMembers = async (req, res) => {
    try {
      const groupId = parseInt(req.params.id);

      const members = await prisma.chatMember.findMany({
        where: { groupId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              role: true,
              number: true,
            },
          },
        },
      });

      return this.sendResponse(req, res, {
        status: 200,
        data: members.map((m) => m.user),
      });
    } catch (error) {
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to get members",
        error: error.message,
      });
    }
  };

  // Get media items (images, files, links) for a group
  getGroupMedia = async (req, res) => {
    try {
      const groupId = parseInt(req.params.id);

      const mediaMessages = await prisma.message.findMany({
        where: {
          groupId,
          type: {
            in: [MessageType.MEDIA, MessageType.FILE], // use enum values
          },
        },
        select: {
          id: true,
          type: true,
          content: true,
          fileName: true,
          mimeType: true,
          createdAt: true,
          sender: {
            select: { id: true, name: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });


      const buildUrl = (id) =>
        `${req.protocol}://${req.get("host")}/message/${id}/file`;

      const formatItem = (msg) => ({
        id: msg.id,
        name: msg.fileName || msg.content,
        type: msg.type.toLowerCase(),
        url: buildUrl(msg.mimeType === "link" ? msg.content : "msg.id"),
        mimeType: msg.mimeType,
        uploadedAt: msg.createdAt,
        uploadedBy: msg.sender.name,
      });

      const images = mediaMessages
        .filter((m) => m.type === MessageType.MEDIA)
        .map(formatItem);
      const files = mediaMessages
        .filter((m) => m.type === MessageType.FILE)
        .map(formatItem);
      const links = mediaMessages
        .filter((m) => m.type === MessageType.MEDIA && m.mimeType === "link")
        .map(formatItem);

      return this.sendResponse(req, res, {
        status: 200,
        data: {
          images,
          files,
          links,
        },
      });
    } catch (error) {
      console.error("getGroupMedia error:", error.message);
      return this.sendResponse(req, res, {
        status: 400,
        message: "Failed to get media",
        error: error.message,
      });
    }
  };

  getSeenByMessage = async (req, res) => {
    try {
      const { groupId } = req.params;
      const { userId } = req.body;

      if (!userId || isNaN(userId)) {
        return res.status(400).json({ message: "Invalid or missing userId" });
      }

      const member = await prisma.chatMember.findUnique({
        where: {
          userId_groupId: {
            userId: Number(userId),
            groupId: Number(groupId),
          },
        },
      });
      if (!member) {
        return res.status(404).json({ message: "Chat group not found" });
      }
      const updatedMember = await prisma.chatMember.update({
        where: {
          userId_groupId: {
            userId: Number(userId),
            groupId: Number(groupId),
          },
        },
        data: { lastSeenAt: new Date() },
      });
      return res.json(updatedMember);
    } catch (error) {
      console.error("getSeenByMessage error:", error.message);
      res.status(500).json({
        message: "Internal server error",
        error: error.message,
      });
    }
  };
}

module.exports = Chat;

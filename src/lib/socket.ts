import { Server } from "socket.io";
import { logger } from "@/lib/logger";

let io: Server;

// Define types for update payloads
type QueueUpdateData = {
  type?: string;
  status?: string;
  count?: number;
  entryId?: number;
};

type EntryUpdateData = {
  status?: string;
  type?: string;
  message?: string;
};

// biome-ignore lint/suspicious/noExplicitAny: Server type compatibility depends on runtime (Node vs Bun)
export const initSocket = (server: any) => {
  io = new Server(server, {
    cors: {
      origin: "*", // Configure properly in production
      methods: ["GET", "POST"],
    },
    path: "/socket.io",
  });

  const queueNamespace = io.of("/queueless");

  queueNamespace.on("connection", (socket) => {
    logger.info("Client connected to queueless namespace", {
      socketId: socket.id,
    });

    // Join room based on clinic/queue/entry
    socket.on("join-room", (room: string) => {
      socket.join(room);
      logger.info("Socket joined room", { socketId: socket.id, room });
    });

    socket.on("disconnect", () => {
      logger.info("Client disconnected", { socketId: socket.id });
    });
  });

  return io;
};

export const getSocketIO = () => {
  if (!io) {
    throw new Error("Socket.IO not initialized!");
  }
  return io;
};

export const notifyQueueUpdate = (queueId: number, data: QueueUpdateData) => {
  if (!io) {
    return;
  }
  io.of("/queueless").to(`queue:${queueId}`).emit("queue:update", data);
};

export const notifyEntryUpdate = (entryId: number, data: EntryUpdateData) => {
  if (!io) {
    return;
  }
  io.of("/queueless").to(`entry:${entryId}`).emit("entry:update", data);
};

import type { Socket } from "socket.io";
import { Server } from "socket.io";
import { db } from "@/database/db";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";

let io: Server;

const JOIN_ROOM_REGEX = /^(queue|entry):(\d+)$/;

// Define types for update payloads
type QueueUpdateData = {
  type?: string;
  status?: string;
  count?: number;
  entryId?: number;
  entry?: {
    id: number;
    position: number;
    name?: string | null;
    phoneNumber: string;
    status?: string;
  };
};

type EntryUpdateData = {
  status?: string;
  type?: string;
  message?: string;
};

type QueueUpdateEvent = QueueUpdateData & { queueId: number };
type EntryUpdateEvent = EntryUpdateData & { entryId: number };

type SocketUser = {
  id: number;
  clinicId?: number;
  branchId?: number;
  role: string;
};

type JoinRoomResult =
  | { ok: true; kind: "queue" | "entry"; id: number; room: string }
  | { ok: false; reason: string };

function parseJoinRoom(room: string): JoinRoomResult {
  const match = JOIN_ROOM_REGEX.exec(room);
  if (!match) {
    return { ok: false, reason: "invalid_room_format" };
  }
  const kind = match[1] as "queue" | "entry";
  const id = Number(match[2]);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, reason: "invalid_room_id" };
  }
  return { ok: true, kind, id, room };
}

function parseNumericField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

function normalizeSocketUser(raw: unknown): SocketUser | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const user = raw as Record<string, unknown>;
  const id = parseNumericField(user.id);
  if (!id) {
    return null;
  }
  const role = typeof user.role === "string" ? user.role : "";
  if (role.length === 0) {
    return null;
  }
  const clinicId = parseNumericField(user.clinicId) ?? undefined;
  const branchId = parseNumericField(user.branchId) ?? undefined;
  return { id, clinicId, branchId, role };
}

async function getUserFromSocketToken(
  token: string
): Promise<SocketUser | null> {
  const headers = new Headers({ cookie: `session_token=${token}` });
  headers.set("authorization", `Bearer ${token}`);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    return null;
  }
  return normalizeSocketUser(session.user);
}

function socketContext(socket: Socket, extra?: Record<string, unknown>) {
  return {
    module: "socket",
    namespace: "/queueless",
    socketId: socket.id,
    ip: socket.handshake.address,
    userId: (socket.data as Record<string, unknown>)?.userId,
    clinicId: (socket.data as Record<string, unknown>)?.clinicId,
    ...extra,
  };
}

async function canJoinRoom(
  user: SocketUser,
  parsed: Extract<JoinRoomResult, { ok: true }>
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!user.clinicId) {
    return { allowed: false, reason: "missing_clinic_context" };
  }
  if (parsed.kind === "queue") {
    const queue = await db.queue.findUnique({
      where: { id: parsed.id },
      select: { clinicId: true },
    });
    if (!queue) {
      return { allowed: false, reason: "queue_not_found" };
    }
    if (queue.clinicId !== user.clinicId) {
      return { allowed: false, reason: "queue_not_in_clinic" };
    }
    return { allowed: true };
  }
  const entry = await db.queueEntry.findUnique({
    where: { id: parsed.id },
    select: { queue: { select: { clinicId: true } } },
  });
  if (!entry) {
    return { allowed: false, reason: "entry_not_found" };
  }
  if (entry.queue.clinicId !== user.clinicId) {
    return { allowed: false, reason: "entry_not_in_clinic" };
  }
  return { allowed: true };
}

function setSocketUser(socket: Socket, user: SocketUser) {
  const data = socket.data as Record<string, unknown>;
  data.userId = user.id;
  data.clinicId = user.clinicId ?? null;
  data.branchId = user.branchId ?? null;
  data.role = user.role;
}

function getSocketUser(socket: Socket): SocketUser | null {
  const data = socket.data as Record<string, unknown>;
  const id = parseNumericField(data.userId);
  if (!id) {
    return null;
  }
  const role = typeof data.role === "string" ? data.role : "";
  if (role.length === 0) {
    return null;
  }
  const clinicId = parseNumericField(data.clinicId) ?? undefined;
  const branchId = parseNumericField(data.branchId) ?? undefined;
  return { id, clinicId, branchId, role };
}

async function getUserFromSocketHandshake(
  socket: Socket
): Promise<SocketUser | null> {
  const cookieHeader =
    typeof socket.handshake.headers.cookie === "string"
      ? socket.handshake.headers.cookie
      : null;

  if (cookieHeader) {
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader }),
    });
    const cookieUser = normalizeSocketUser(session?.user);
    if (cookieUser) {
      return cookieUser;
    }
  }

  const token =
    (socket.handshake.auth as Record<string, unknown> | undefined)?.token ??
    null;
  if (typeof token === "string" && token.length > 0) {
    return await getUserFromSocketToken(token);
  }

  return null;
}

async function handleJoinRoom(socket: Socket, room: string) {
  const parsed = parseJoinRoom(room);
  if (!parsed.ok) {
    logger.warn(
      "socket.join_room.denied",
      socketContext(socket, { room, reason: parsed.reason })
    );
    return;
  }
  const user = getSocketUser(socket);
  if (!user) {
    logger.warn(
      "socket.join_room.denied",
      socketContext(socket, { room, reason: "missing_user" })
    );
    return;
  }
  const allowed = await canJoinRoom(user, parsed);
  if (!allowed.allowed) {
    logger.warn(
      "socket.join_room.denied",
      socketContext(socket, {
        room,
        kind: parsed.kind,
        id: parsed.id,
        reason: allowed.reason,
      })
    );
    return;
  }
  socket.join(room);
  logger.info(
    "socket.join_room.allowed",
    socketContext(socket, { room, kind: parsed.kind, id: parsed.id })
  );
}

// biome-ignore lint/suspicious/noExplicitAny: Server type compatibility depends on runtime (Node vs Bun)
export const initSocket = (server: any) => {
  const allowedOrigins = [process.env.APP_URL, process.env.NEXT_UP_URL].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );

  io = new Server(server, {
    cors: {
      origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
      credentials: true,
      methods: ["GET", "POST"],
    },
    path: "/socket.io",
  });

  const queueNamespace = io.of("/queueless");

  queueNamespace.use(async (socket, next) => {
    try {
      const cookieHeader =
        typeof socket.handshake.headers.cookie === "string"
          ? socket.handshake.headers.cookie
          : null;

      const user = await getUserFromSocketHandshake(socket);
      if (user) {
        setSocketUser(socket, user);
        next();
        return;
      }

      const tokenPresent =
        typeof (socket.handshake.auth as Record<string, unknown> | undefined)
          ?.token === "string";
      logger.warn(
        tokenPresent
          ? "socket.auth.invalid_token"
          : "socket.auth.missing_token",
        socketContext(socket, { hasCookie: !!cookieHeader })
      );
      next(new Error("unauthorized"));
    } catch (error) {
      logger.error("socket.auth.error", socketContext(socket, { error }));
      next(new Error("unauthorized"));
    }
  });

  queueNamespace.on("connection", (socket) => {
    logger.info("socket.connected", socketContext(socket));

    // Join room based on clinic/queue/entry
    socket.on("join-room", async (room: string) => {
      try {
        await handleJoinRoom(socket, room);
      } catch (error) {
        logger.error(
          "socket.join_room.error",
          socketContext(socket, { room, error })
        );
      }
    });

    socket.on("disconnect", () => {
      logger.info("socket.disconnected", socketContext(socket));
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
  const payload: QueueUpdateEvent = { queueId, ...data };
  io.of("/queueless").to(`queue:${queueId}`).emit("queue:update", payload);
  logger.debug("socket.emit.queue_update", {
    module: "socket",
    namespace: "/queueless",
    room: `queue:${queueId}`,
    queueId,
    type: data.type,
    status: data.status,
    count: data.count,
    entryId: data.entryId,
  });
};

export const notifyEntryUpdate = (entryId: number, data: EntryUpdateData) => {
  if (!io) {
    return;
  }
  const payload: EntryUpdateEvent = { entryId, ...data };
  io.of("/queueless").to(`entry:${entryId}`).emit("entry:update", payload);
  logger.debug("socket.emit.entry_update", {
    module: "socket",
    namespace: "/queueless",
    room: `entry:${entryId}`,
    entryId,
    type: data.type,
    status: data.status,
  });
};

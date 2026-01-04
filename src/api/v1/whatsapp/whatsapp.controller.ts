import type { Context } from "hono";
import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import { QueueFlowService } from "@/services/queue-flow.service";
import redis from "@/services/redis.service";
import { WhatsAppService } from "@/services/whatsapp.service";
import {
  QueueEntryStatus,
  QueueSource,
} from "../../../../generated/prisma/client";

const SESSION_TTL = 3600; // 1 hour

type ClinicSearchResult = {
  id: number;
  name: string;
};

type ServiceSearchResult = {
  id: number;
  name: string;
  activeQueueId?: number;
};

type WhatsAppSession = {
  state:
    | "IDLE"
    | "AWAITING_CLINIC"
    | "AWAITING_SERVICE"
    | "AWAITING_TRAVEL_TIME";
  clinicId?: number;
  queueConfigId?: number;
  activeQueueId?: number;
  searchResults?: ClinicSearchResult[];
  servicesResults?: ServiceSearchResult[];
};

type WhatsAppPayload = {
  object: string;
  entry: Array<{
    changes: Array<{
      value: {
        messages: Array<{
          from: string;
          text: { body: string };
        }>;
      };
    }>;
  }>;
};

/**
 * Webhook verification (GET request from Meta / WhatsApp Cloud API)
 *
 * Meta sends:
 *  - hub.mode=subscribe
 *  - hub.challenge=<random string>
 *  - hub.verify_token=<your verify token>
 *
 * We must echo back the challenge when the verify token matches.
 */
export const verify = (c: Context) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!expectedToken) {
    logger.error(
      "WhatsApp webhook verification failed: verify token not configured"
    );
    return c.text("Verify token not configured", 500);
  }

  if (
    mode === "subscribe" &&
    token === expectedToken &&
    typeof challenge === "string"
  ) {
    logger.info("WhatsApp webhook verified successfully");
    return c.text(challenge, 200);
  }

  logger.warn("WhatsApp webhook verification failed: invalid mode or token", {
    mode,
  });

  return c.text("Forbidden", 403);
};

/**
 * Webhook message handler (POST request from Meta)
 */
export const webhook = async (c: Context) => {
  const body = (await c.req.json()) as WhatsAppPayload;

  if (body.object !== "whatsapp_business_account") {
    return c.json({ success: false }, 404);
  }

  const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) {
    return c.json({ success: true });
  }

  const from = message.from;
  const text = message.text?.body?.trim();

  if (!from) {
    return c.json({ success: true });
  }
  if (!text) {
    return c.json({ success: true });
  }

  logger.info("WhatsApp message received", { from, text });

  const sessionKey = `wa:session:${from}`;
  const sessionData = await redis.get(sessionKey);
  const session: WhatsAppSession = sessionData
    ? JSON.parse(sessionData)
    : { state: "IDLE" };

  try {
    const { updatedSession, responseMessage } = await processMessage(
      from,
      text,
      session
    );

    await redis.setex(sessionKey, SESSION_TTL, JSON.stringify(updatedSession));
    await WhatsAppService.sendMessage(from, responseMessage);

    return c.json({ success: true });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error("WhatsApp webhook processing error", { errorMessage, from });
    await WhatsAppService.sendMessage(
      from,
      "Sorry, something went wrong. Please type 'exit' to start over."
    );
    return c.json({ success: false, error: errorMessage }, 500);
  }
};

async function processMessage(
  from: string,
  text: string,
  session: WhatsAppSession
): Promise<{ updatedSession: WhatsAppSession; responseMessage: string }> {
  const lowerText = text.toLowerCase();

  const resetCommands = ["exit", "cancel", "reset", "start"];
  if (resetCommands.includes(lowerText)) {
    return {
      updatedSession: { state: "IDLE" },
      responseMessage:
        "Session reset. How can I help you today? 🏥\n\n- Type 'clinic' to find a clinic\n- Type 'status' to check your position",
    };
  }

  switch (session.state) {
    case "IDLE":
      return await handleIdle(from, lowerText, session);
    case "AWAITING_CLINIC":
      return await handleAwaitingClinic(text, session);
    case "AWAITING_SERVICE":
      return handleAwaitingService(text, session);
    case "AWAITING_TRAVEL_TIME":
      return await handleAwaitingTravelTime(from, text, session);
    default:
      return {
        updatedSession: { state: "IDLE" },
        responseMessage:
          "Welcome to QueueLess! 🏥\n\n- Type 'clinic' to find a clinic and join a queue.\n- Type 'status' to check your current position.\n- Type 'exit' to start over.",
      };
  }
}

async function handleIdle(
  from: string,
  lowerText: string,
  session: WhatsAppSession
): Promise<{ updatedSession: WhatsAppSession; responseMessage: string }> {
  const joinTriggers = ["clinic", "doctor", "join"];
  if (joinTriggers.some((t) => lowerText.includes(t))) {
    return {
      updatedSession: { ...session, state: "AWAITING_CLINIC" },
      responseMessage:
        "Which clinic are you looking for? (Type the name or city)",
    };
  }

  if (lowerText.includes("status")) {
    const activeEntry = await db.queueEntry.findFirst({
      where: {
        phoneNumber: from,
        status: { in: [QueueEntryStatus.WAITING, QueueEntryStatus.NOTIFIED] },
      },
      include: { queue: true },
      orderBy: { createdAt: "desc" },
    });

    if (!activeEntry) {
      return {
        updatedSession: session,
        responseMessage: "You don't have any active queue entries.",
      };
    }

    const waitingAhead = await db.queueEntry.count({
      where: {
        queueId: activeEntry.queueId,
        status: QueueEntryStatus.WAITING,
        position: { lt: activeEntry.position },
      },
    });

    return {
      updatedSession: session,
      responseMessage: `Your current status for ${activeEntry.queue.name}:\n\nPosition: ${activeEntry.position}\nPatients ahead: ${waitingAhead}\nStatus: ${activeEntry.status}`,
    };
  }

  return {
    updatedSession: session,
    responseMessage:
      "Welcome to QueueLess! 🏥\n\n- Type 'clinic' to find a clinic and join a queue.\n- Type 'status' to check your current position.\n- Type 'exit' to start over.",
  };
}

async function handleAwaitingClinic(
  text: string,
  session: WhatsAppSession
): Promise<{ updatedSession: WhatsAppSession; responseMessage: string }> {
  const clinics = await db.clinic.findMany({
    where: {
      name: { contains: text, mode: "insensitive" },
      queueConfigs: { some: { isPublic: true } },
    },
    select: { id: true, name: true },
    take: 5,
  });

  if (clinics.length === 0) {
    return {
      updatedSession: session,
      responseMessage: `No clinics found matching "${text}". Please try another name or type 'exit'.`,
    };
  }

  const selectionIndex = Number.parseInt(text, 10) - 1;
  const selectedFromSearch =
    !Number.isNaN(selectionIndex) && session.searchResults?.[selectionIndex];

  if (clinics.length === 1 || selectedFromSearch) {
    const selectedClinic = selectedFromSearch
      ? session.searchResults?.[selectionIndex]
      : clinics[0];

    if (!selectedClinic) {
      return {
        updatedSession: session,
        responseMessage: "Invalid selection. Please try again.",
      };
    }

    const services = await db.queueConfig.findMany({
      where: { clinicId: selectedClinic.id, isPublic: true },
      include: {
        queues: {
          where: { status: "OPEN" },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
      },
    });

    const servicesResults: ServiceSearchResult[] = services.map((s) => ({
      id: s.id,
      name: s.name,
      activeQueueId: s.queues[0]?.id,
    }));

    if (servicesResults.length === 0) {
      return {
        updatedSession: { state: "IDLE" },
        responseMessage: `Sorry, ${selectedClinic.name} has no public services available at the moment. Type 'exit' to try another clinic.`,
      };
    }

    return {
      updatedSession: {
        ...session,
        state: "AWAITING_SERVICE",
        clinicId: selectedClinic.id,
        servicesResults,
      },
      responseMessage: `Welcome to ${selectedClinic.name}. Which service do you need?\n\n${servicesResults
        .map(
          (s, i) => `${i + 1}. ${s.name}${s.activeQueueId ? "" : " (Closed)"}`
        )
        .join("\n")}`,
    };
  }

  return {
    updatedSession: { ...session, searchResults: clinics },
    responseMessage: `Found multiple clinics. Please select one by number:\n\n${clinics
      .map((c, i) => `${i + 1}. ${c.name}`)
      .join("\n")}`,
  };
}

function handleAwaitingService(
  text: string,
  session: WhatsAppSession
): { updatedSession: WhatsAppSession; responseMessage: string } {
  const selection = Number.parseInt(text, 10);
  const service = session.servicesResults?.[selection - 1];

  if (!service) {
    return {
      updatedSession: session,
      responseMessage:
        "Invalid selection. Please reply with the number of the service.",
    };
  }

  if (!service.activeQueueId) {
    return {
      updatedSession: session,
      responseMessage:
        "Sorry, this service is currently closed. Please select another one or type 'exit'.",
    };
  }

  return {
    updatedSession: {
      ...session,
      state: "AWAITING_TRAVEL_TIME",
      queueConfigId: service.id,
      activeQueueId: service.activeQueueId,
    },
    responseMessage:
      "How many minutes will it take you to reach the clinic? (e.g., 20)",
  };
}

async function handleAwaitingTravelTime(
  from: string,
  text: string,
  session: WhatsAppSession
): Promise<{ updatedSession: WhatsAppSession; responseMessage: string }> {
  const travelTime = Number.parseInt(text, 10);

  if (Number.isNaN(travelTime) || travelTime < 0) {
    return {
      updatedSession: session,
      responseMessage:
        "Please provide a valid number of minutes for your travel time.",
    };
  }

  if (!session.activeQueueId) {
    return {
      updatedSession: { state: "IDLE" },
      responseMessage:
        "Session expired or queue closed. Please start over by typing 'clinic'.",
    };
  }

  const entry = await QueueFlowService.joinQueue({
    queueId: session.activeQueueId,
    phoneNumber: from,
    source: QueueSource.WHATSAPP,
    travelTimeEstimate: travelTime,
  });

  return {
    updatedSession: { state: "IDLE" },
    responseMessage: `Success! You have joined the queue.\n\nTicket #${entry.position}\nEstimated wait: ${entry.estimatedWaitTime} mins.\n\nWe will notify you when it's time to leave home! 🏥`,
  };
}

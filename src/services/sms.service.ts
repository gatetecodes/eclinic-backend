import { addMinutes } from "date-fns";
import { db } from "@/database/db";
import { logger } from "@/lib/logger";
import {
  type OutboundSmsLog,
  type Prisma,
  SmsDeliveryStatus,
  SmsEventType,
} from "../../generated/prisma/client";
import { normalizeToE164, TwilioProvider } from "./twilio.provider";

const DEFAULT_RETRY_LIMIT = 3;
const REPLACE_REGEX = /\/$/;

function shouldSendForEvent(
  clinic: {
    isSmsEnabled: boolean;
    smsOnQueueJoined: boolean;
    smsOnQueueTurn: boolean;
    smsOnLabResultsReady: boolean;
    smsOnVisitCompletion: boolean;
  },
  eventType: SmsEventType
): boolean {
  if (!clinic.isSmsEnabled) {
    return false;
  }

  if (eventType === SmsEventType.QUEUE_JOINED) {
    return clinic.smsOnQueueJoined;
  }
  if (eventType === SmsEventType.QUEUE_TURN) {
    return clinic.smsOnQueueTurn;
  }
  if (eventType === SmsEventType.LAB_RESULTS_READY) {
    return clinic.smsOnLabResultsReady;
  }
  if (eventType === SmsEventType.VISIT_COMPLETED) {
    return clinic.smsOnVisitCompletion;
  }

  return false;
}

function getStatusCallbackUrl(): string | undefined {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) {
    return;
  }
  const base = backendUrl.replace(REPLACE_REGEX, "");
  return `${base}/api/v1/sms/webhook/status`;
}

function computeBackoffMinutes(attempt: number): number {
  if (attempt <= 1) {
    return 1;
  }
  if (attempt === 2) {
    return 5;
  }
  return 15;
}

async function markSent(logId: number, providerMessageId?: string) {
  await db.outboundSmsLog.update({
    where: { id: logId },
    data: {
      status: SmsDeliveryStatus.SENT,
      providerMessageId,
      sentAt: new Date(),
      failedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextRetryAt: null,
    },
  });
}

async function markFailed(
  log: OutboundSmsLog,
  params: {
    errorCode?: string;
    errorMessage?: string;
    retryable: boolean;
  }
) {
  const nextAttempt = log.attempts + 1;
  const canRetry = params.retryable && nextAttempt < log.maxAttempts;
  const nextRetryAt = canRetry
    ? addMinutes(new Date(), computeBackoffMinutes(nextAttempt))
    : null;

  await db.outboundSmsLog.update({
    where: { id: log.id },
    data: {
      status: SmsDeliveryStatus.FAILED,
      attempts: nextAttempt,
      failedAt: new Date(),
      lastErrorCode: params.errorCode,
      lastErrorMessage: params.errorMessage,
      nextRetryAt,
    },
  });
}

export const SmsService = {
  queueEventMessage: async (params: {
    clinicId: number;
    patientId?: number;
    visitId?: number;
    phoneNumber: string;
    message: string;
    eventType: SmsEventType;
    metadata?: Prisma.InputJsonObject;
  }) => {
    const clinic = await db.clinic.findUnique({
      where: { id: params.clinicId },
      select: {
        isSmsEnabled: true,
        smsOnQueueJoined: true,
        smsOnQueueTurn: true,
        smsOnLabResultsReady: true,
        smsOnVisitCompletion: true,
      },
    });

    if (!clinic) {
      logger.warn("SMS skip: clinic not found", { clinicId: params.clinicId });
      return;
    }

    if (!shouldSendForEvent(clinic, params.eventType)) {
      logger.info("SMS skip: clinic setting disabled", {
        clinicId: params.clinicId,
        eventType: params.eventType,
      });
      return;
    }

    const normalizedPhone = normalizeToE164(params.phoneNumber);
    if (!normalizedPhone) {
      logger.warn("SMS skip: invalid recipient phone", {
        clinicId: params.clinicId,
        visitId: params.visitId,
        patientId: params.patientId,
      });
      return;
    }

    const log = await db.outboundSmsLog.create({
      data: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        visitId: params.visitId,
        phoneNumber: normalizedPhone,
        message: params.message,
        eventType: params.eventType,
        status: SmsDeliveryStatus.QUEUED,
        attempts: 0,
        maxAttempts: DEFAULT_RETRY_LIMIT,
        metadata: params.metadata,
      },
    });

    await SmsService.dispatchLog(log.id);
  },

  dispatchLog: async (logId: number) => {
    const log = await db.outboundSmsLog.findUnique({ where: { id: logId } });
    if (!log) {
      return;
    }

    if (log.status === SmsDeliveryStatus.DELIVERED) {
      return;
    }

    const sendResult = await TwilioProvider.sendMessage({
      to: log.phoneNumber,
      body: log.message,
      statusCallbackUrl: getStatusCallbackUrl(),
    });

    if (sendResult.success) {
      await markSent(log.id, sendResult.providerMessageId);
      return;
    }

    await markFailed(log, {
      errorCode: sendResult.errorCode,
      errorMessage: sendResult.errorMessage,
      retryable: Boolean(sendResult.retryable),
    });
  },

  retryFailedMessages: async (limit = 100) => {
    const logs = await db.outboundSmsLog.findMany({
      where: {
        status: SmsDeliveryStatus.FAILED,
        nextRetryAt: { lte: new Date() },
      },
      orderBy: { nextRetryAt: "asc" },
      take: limit,
      select: { id: true, attempts: true, maxAttempts: true },
    });

    for (const log of logs) {
      if (log.attempts >= log.maxAttempts) {
        continue;
      }
      await SmsService.dispatchLog(log.id);
    }

    if (logs.length > 0) {
      logger.info("SMS retry cycle completed", { retried: logs.length });
    }
  },

  handleStatusCallback: async (payload: {
    messageSid?: string;
    messageStatus?: string;
    errorCode?: string;
    errorMessage?: string;
  }) => {
    const providerMessageId = payload.messageSid;
    if (!providerMessageId) {
      return;
    }

    const log = await db.outboundSmsLog.findFirst({
      where: { providerMessageId },
      select: { id: true, status: true },
    });

    if (!log) {
      logger.warn("SMS callback: unmatched provider message id", {
        providerMessageId,
      });
      return;
    }

    const status = (payload.messageStatus || "").toLowerCase();

    if (status === "delivered" || status === "read") {
      await db.outboundSmsLog.update({
        where: { id: log.id },
        data: {
          status: SmsDeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
          failedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: null,
        },
      });
      return;
    }

    if (status === "failed" || status === "undelivered") {
      await db.outboundSmsLog.update({
        where: { id: log.id },
        data: {
          status: SmsDeliveryStatus.FAILED,
          failedAt: new Date(),
          lastErrorCode: payload.errorCode,
          lastErrorMessage: payload.errorMessage,
          nextRetryAt: null,
        },
      });
    }
  },
};

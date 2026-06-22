import { notifyFlowUpdate } from "../lib/socket";

export type FlowEvent = {
  clinicId: number;
  branchId?: number;
  type: "visit.advanced" | "visit.created" | "visit.updated";
  fromStage?: string;
  toStage?: string;
  visit?: unknown;
  actorId?: number;
};

/**
 * Emit a live patient-flow event to a clinic's flow room. Safe to call from any
 * request path: if Socket.IO is not initialised it silently no-ops and clients
 * fall back to polling GET /visits/pipeline.
 */
export const emitFlowUpdate = (event: FlowEvent) => {
  try {
    notifyFlowUpdate(event.clinicId, {
      type: event.type,
      fromStage: event.fromStage,
      toStage: event.toStage,
      visit: event.visit,
      branchId: event.branchId,
      actorId: event.actorId,
    });
  } catch {
    /* never let live-event delivery break the request flow */
  }
};

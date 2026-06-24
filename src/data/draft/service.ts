/**
 * Async snake-draft state machine (Phase 4).
 *
 * This module was split for maintainability (tech-debt #3); it is now a
 * barrel that preserves the original public import surface. Nothing should
 * need to change its `from ".../draft/service"` imports.
 *
 *   ./commands.ts       Public operations: createDraftRoom, startDraft,
 *                       makePick, processExpiredPicks, forceCurrentAutopick,
 *                       getDraftState (+ their Input/Result/View types).
 *   ./internals.ts      Transaction-scoped helpers (load/order/apply/autopick)
 *                       and the in-transaction notification emitters.
 *   ./notifications.ts  Best-effort delivery of PENDING rows: deliverPending.
 *
 * See those files for the design notes that previously lived here (the core
 * notify -> pick -> advance -> autopick loop and the durable-notification
 * reliability model).
 */

export {
  createDraftRoom,
  startDraft,
  makePick,
  processExpiredPicks,
  forceCurrentAutopick,
  getDraftState,
} from "./commands.js";
export type {
  CreateDraftRoomInput,
  StartDraftInput,
  MakePickInput,
  MakePickResult,
  ProcessExpiredInput,
  ProcessExpiredResult,
  ForceAutopickResult,
  DraftStateView,
} from "./commands.js";

export { deliverPending } from "./notifications.js";

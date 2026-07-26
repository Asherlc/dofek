import { vi } from "vitest";
import type { SessionCallHandlers } from "./session-control.ts";

export function makeSessionCallHandlers(
  overrides: Partial<SessionCallHandlers> = {},
): SessionCallHandlers {
  return {
    logging: false,
    transferInProgress: false,
    failedTransferPending: false,
    applyStartPreferences: vi.fn(),
    startLogging: vi.fn(),
    stopLogging: vi.fn(),
    queueManualExport: vi.fn(),
    transferStoppedSession: vi.fn(),
    ...overrides,
  };
}

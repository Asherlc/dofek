import { vi } from "vitest";
import type { SessionCallHandlers } from "./session-control.ts";

export function makeSessionCallHandlers(
  overrides: Partial<SessionCallHandlers> = {},
): SessionCallHandlers {
  return {
    logging: false,
    transferInProgress: false,
    failedTransferPending: false,
    pendingManualExport: false,
    applyStartPreferences: vi.fn(),
    handleBlockedStart: vi.fn(),
    startLogging: vi.fn(),
    stopLogging: vi.fn(),
    queueManualExport: vi.fn(),
    transferStoppedSession: vi.fn(),
    ...overrides,
  };
}

export function createSettingsStorage(initial: Readonly<Record<string, string>> = {}) {
  const persisted = new Map(Object.entries(initial));
  return {
    persisted,
    getItem: vi.fn((key: string) => persisted.get(key) ?? null),
    removeItem: vi.fn((key: string) => persisted.delete(key)),
    setItem: vi.fn((key: string, value: string) => persisted.set(key, value)),
  };
}

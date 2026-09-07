import { vi } from "vitest";
import type { SessionCallHandlers } from "./session-control.ts";

export function deferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized");
      resolvePromise();
    },
  };
}

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

export function createSettingsComponents() {
  const buttons: Array<{ label: string; onClick(): void }> = [];
  const inputs: Array<{ label: string; value?: string; onChange(value: string): void }> = [];
  const links: Array<{ source: string }> = [];
  const images: Array<{ src: string }> = [];
  vi.stubGlobal("View", (props: unknown, children: unknown[]) => ({ props, children }));
  vi.stubGlobal("Button", (props: (typeof buttons)[number]) => {
    buttons.push(props);
    return { button: props };
  });
  vi.stubGlobal("TextInput", (props: (typeof inputs)[number]) => {
    inputs.push(props);
    return { input: props };
  });
  vi.stubGlobal("Link", (props: (typeof links)[number], children: unknown[]) => {
    links.push(props);
    return { link: props, children };
  });
  vi.stubGlobal("Image", (props: (typeof images)[number]) => {
    images.push(props);
    return { image: props };
  });
  return { buttons, inputs, links, images };
}

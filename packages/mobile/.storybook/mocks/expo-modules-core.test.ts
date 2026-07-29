import { describe, expect, it, vi } from "vitest";
import { LegacyEventEmitter } from "./expo-modules-core";

describe("expo-modules-core Storybook mock", () => {
  it("provides the legacy emitter constructor required by Expo modules", () => {
    const listener = vi.fn();
    const emitter = new LegacyEventEmitter({});
    const subscription = emitter.addListener("notification", listener);

    expect(subscription).toEqual({ remove: expect.any(Function) });
  });
});

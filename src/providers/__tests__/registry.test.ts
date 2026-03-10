import { describe, it, expect, beforeEach } from "vitest";
import { registerProvider, getProvider, getAllProviders, getEnabledProviders } from "../index.js";
import type { Provider, SyncResult } from "../types.js";
import type { Database } from "../../db/index.js";

function createMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test-provider",
    name: "Test Provider",
    validate: () => null,
    sync: async () => ({
      provider: "test-provider",
      recordsSynced: 0,
      errors: [],
      duration: 0,
    }),
    ...overrides,
  };
}

// The provider registry uses module-level state, so we need to test
// with unique IDs to avoid collisions across tests.
let testId = 0;
function uniqueId() {
  return `test-provider-${++testId}`;
}

describe("Provider Registry", () => {
  it("registers and retrieves a provider", () => {
    const id = uniqueId();
    const provider = createMockProvider({ id, name: "My Provider" });
    registerProvider(provider);

    expect(getProvider(id)).toBe(provider);
  });

  it("throws on duplicate registration", () => {
    const id = uniqueId();
    const provider = createMockProvider({ id });
    registerProvider(provider);

    expect(() => registerProvider(createMockProvider({ id }))).toThrow(
      `Provider '${id}' is already registered`,
    );
  });

  it("returns undefined for unknown provider", () => {
    expect(getProvider("nonexistent")).toBeUndefined();
  });

  it("returns only enabled providers (those that pass validation)", () => {
    const enabledId = uniqueId();
    const disabledId = uniqueId();

    registerProvider(createMockProvider({ id: enabledId, validate: () => null }));
    registerProvider(
      createMockProvider({ id: disabledId, validate: () => "Missing API key" }),
    );

    const enabled = getEnabledProviders();
    expect(enabled.some((p) => p.id === enabledId)).toBe(true);
    expect(enabled.some((p) => p.id === disabledId)).toBe(false);
  });
});

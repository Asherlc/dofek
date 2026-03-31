import { describe, expect, it } from "vitest";
import {
  getEnabledProviders,
  getEnabledSyncProviders,
  getProvider,
  registerProvider,
} from "./index.ts";
import type { Provider } from "./types.ts";

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
    registerProvider(createMockProvider({ id: disabledId, validate: () => "Missing API key" }));

    const enabled = getEnabledProviders();
    expect(enabled.some((p) => p.id === enabledId)).toBe(true);
    expect(enabled.some((p) => p.id === disabledId)).toBe(false);
  });

  it("returns only enabled sync providers (excludes import-only CSV providers)", () => {
    const syncId = uniqueId();
    const csvId = `${uniqueId()}-csv`;

    registerProvider(createMockProvider({ id: syncId, validate: () => null }));
    registerProvider({
      id: csvId,
      name: "CSV Import",
      importOnly: true,
      validate: () => null,
    });

    const enabledSyncProviders = getEnabledSyncProviders();
    expect(enabledSyncProviders.some((provider) => provider.id === syncId)).toBe(true);
    expect(enabledSyncProviders.some((provider) => provider.id === csvId)).toBe(false);
  });
});

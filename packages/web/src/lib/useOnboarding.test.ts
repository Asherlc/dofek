import { describe, expect, it, vi } from "vitest";

// Mock tRPC before importing the hook
interface MockQuery {
  data: unknown;
  isLoading: boolean;
}
const mockProviders: MockQuery = { data: undefined, isLoading: true };
const mockSettings: MockQuery = { data: undefined, isLoading: true };
const mockMutate = vi.fn();
const mockInvalidate = vi.fn();

vi.mock("./trpc.ts", () => ({
  trpc: {
    sync: {
      providers: { useQuery: () => mockProviders },
    },
    settings: {
      get: { useQuery: () => mockSettings },
      set: { useMutation: () => ({ mutate: mockMutate }) },
    },
    useUtils: () => ({
      settings: {
        get: { invalidate: mockInvalidate },
      },
    }),
  },
}));

// Import after mock setup
const { useOnboarding } = await import("./useOnboarding.ts");

describe("useOnboarding", () => {
  it("returns isLoading true while queries are loading", () => {
    mockProviders.data = undefined;
    mockProviders.isLoading = true;
    mockSettings.data = undefined;
    mockSettings.isLoading = true;

    const result = useOnboarding();
    expect(result.isLoading).toBe(true);
    expect(result.showOnboarding).toBe(false);
  });

  it("shows onboarding when no providers are authorized and not dismissed", () => {
    mockProviders.data = [
      { id: "strava", authorized: false },
      { id: "garmin", authorized: false },
    ];
    mockProviders.isLoading = false;
    mockSettings.data = null;
    mockSettings.isLoading = false;

    const result = useOnboarding();
    expect(result.showOnboarding).toBe(true);
  });

  it("hides onboarding when at least one provider is authorized", () => {
    mockProviders.data = [
      { id: "strava", authorized: true },
      { id: "garmin", authorized: false },
    ];
    mockProviders.isLoading = false;
    mockSettings.data = null;
    mockSettings.isLoading = false;

    const result = useOnboarding();
    expect(result.showOnboarding).toBe(false);
  });

  it("hides onboarding when setting is dismissed", () => {
    mockProviders.data = [];
    mockProviders.isLoading = false;
    mockSettings.data = { key: "onboarding_dismissed", value: true };
    mockSettings.isLoading = false;

    const result = useOnboarding();
    expect(result.showOnboarding).toBe(false);
  });

  it("dismiss calls the settings mutation", () => {
    mockProviders.data = [];
    mockProviders.isLoading = false;
    mockSettings.data = null;
    mockSettings.isLoading = false;

    const result = useOnboarding();
    result.dismiss();
    expect(mockMutate).toHaveBeenCalledWith(
      { key: "onboarding_dismissed", value: true },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});

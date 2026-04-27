import { describe, expect, it, vi } from "vitest";

// Mock tRPC before importing the hook
interface MockQuery {
  data: unknown;
  isLoading: boolean;
}
const mockProviders: MockQuery = { data: undefined, isLoading: true };
const mockProviderGuideStatus: MockQuery = { data: undefined, isLoading: true };
const mockMutate = vi.fn();
const mockInvalidate = vi.fn();

vi.mock("./trpc", () => ({
  trpc: {
    sync: {
      providers: { useQuery: () => mockProviders },
    },
    providerGuide: {
      status: { useQuery: () => mockProviderGuideStatus },
      dismiss: { useMutation: () => ({ mutate: mockMutate }) },
    },
    useUtils: () => ({
      providerGuide: {
        status: { invalidate: mockInvalidate },
      },
    }),
  },
}));

// Import after mock setup
const { useProviderGuide } = await import("./useProviderGuide");

describe("useProviderGuide", () => {
  it("returns isLoading true while queries are loading", () => {
    mockProviders.data = undefined;
    mockProviders.isLoading = true;
    mockProviderGuideStatus.data = undefined;
    mockProviderGuideStatus.isLoading = true;

    const result = useProviderGuide();
    expect(result.isLoading).toBe(true);
    expect(result.showProviderGuide).toBe(false);
  });

  it("shows provider guide when no providers are authorized and not dismissed", () => {
    mockProviders.data = [
      { id: "strava", authorized: false },
      { id: "garmin", authorized: false },
    ];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;

    const result = useProviderGuide();
    expect(result.showProviderGuide).toBe(true);
  });

  it("hides provider guide when at least one provider is authorized", () => {
    mockProviders.data = [
      { id: "strava", authorized: true },
      { id: "garmin", authorized: false },
    ];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;

    const result = useProviderGuide();
    expect(result.showProviderGuide).toBe(false);
  });

  it("ignores import-only providers when counting connected providers", () => {
    mockProviders.data = [
      { id: "cronometer-csv", authorized: true, importOnly: true },
      { id: "strong-csv", authorized: true, importOnly: true },
      { id: "strava", authorized: false, importOnly: false },
    ];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;

    const result = useProviderGuide();
    expect(result.showProviderGuide).toBe(true);
  });

  it("only returns providers with a connection or import flow for the guide", () => {
    mockProviders.data = [
      { id: "strava", authorized: false, importOnly: false, authType: "oauth" },
      { id: "broken", authorized: false, importOnly: false, authType: "none" },
      { id: "cronometer-csv", authorized: false, importOnly: true, authType: "file-import" },
    ];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;

    const result = useProviderGuide();
    expect(result.providers.map((provider) => provider.id)).toEqual(["strava", "cronometer-csv"]);
  });

  it("hides provider guide when dismissed", () => {
    mockProviders.data = [];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: true };
    mockProviderGuideStatus.isLoading = false;

    const result = useProviderGuide();
    expect(result.showProviderGuide).toBe(false);
  });

  it("dismiss calls the provider guide mutation", () => {
    mockProviders.data = [];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;

    const result = useProviderGuide();
    result.dismiss();
    expect(mockMutate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});

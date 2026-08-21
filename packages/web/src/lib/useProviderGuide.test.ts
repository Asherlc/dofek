import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock tRPC before importing the hook
interface MockQuery {
  data: unknown;
  error: Error | null;
  isLoading: boolean;
}
const mockProviders: MockQuery = { data: undefined, error: null, isLoading: true };
const mockProviderGuideStatus: MockQuery = { data: undefined, error: null, isLoading: true };
const mockMutate = vi.fn();
const mockInvalidate = vi.fn();

let mockSearchParams: { providerGuide: boolean } = { providerGuide: false };

vi.mock("./trpc.ts", () => ({
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

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearchParams,
}));

// Import after mock setup
const { useProviderGuide } = await import("./useProviderGuide.ts");

describe("useProviderGuide", () => {
  beforeEach(() => {
    mockProviders.error = null;
    mockProviderGuideStatus.error = null;
  });

  it("returns isLoading true while queries are loading", () => {
    mockProviders.data = undefined;
    mockProviders.isLoading = true;
    mockProviderGuideStatus.data = undefined;
    mockProviderGuideStatus.isLoading = true;
    mockSearchParams = { providerGuide: false };

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
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();
    expect(result.showProviderGuide).toBe(true);
  });

  it("does not reopen the guide when dismissal status fails to load", () => {
    mockProviders.data = [{ id: "strava", authorized: false }];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = undefined;
    mockProviderGuideStatus.error = new Error("Guide status is temporarily unavailable");
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();

    expect(result.showProviderGuide).toBe(false);
    expect(result.error).toBe(mockProviderGuideStatus.error);
  });

  it("does not reopen the guide when provider inventory fails to load", () => {
    mockProviders.data = undefined;
    mockProviders.error = new Error("Provider inventory is temporarily unavailable");
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();

    expect(result.showProviderGuide).toBe(false);
    expect(result.error).toBe(mockProviders.error);
  });

  it("does not show the guide while retained provider inventory is refreshing", () => {
    mockProviders.data = [{ id: "strava", authorized: false }];
    mockProviders.isLoading = true;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();

    expect(result.showProviderGuide).toBe(false);
  });

  it("uses retained dismissal status when its background refresh fails", () => {
    mockProviders.data = [{ id: "strava", authorized: false }];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.error = new Error("Guide status refresh failed");
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();

    expect(result.showProviderGuide).toBe(true);
    expect(result.error).toBe(mockProviderGuideStatus.error);
  });

  it("hides provider guide when at least one provider is authorized", () => {
    mockProviders.data = [
      { id: "strava", authorized: true },
      { id: "garmin", authorized: false },
    ];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: false };

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
    mockSearchParams = { providerGuide: false };

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
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();
    expect(result.providers.map((provider) => provider.id)).toEqual(["strava", "cronometer-csv"]);
  });

  it("hides provider guide when dismissed", () => {
    mockProviders.data = [];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: true };
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();
    expect(result.showProviderGuide).toBe(false);
  });

  it("forces provider guide when ?providerGuide=true query param is set", () => {
    mockProviders.data = [{ id: "strava", authorized: true, importOnly: false }];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: true };
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: true };

    const result = useProviderGuide();
    expect(result.showProviderGuide).toBe(true);
  });

  it("dismiss calls the provider guide mutation", () => {
    mockProviders.data = [];
    mockProviders.isLoading = false;
    mockProviderGuideStatus.data = { dismissed: false };
    mockProviderGuideStatus.isLoading = false;
    mockSearchParams = { providerGuide: false };

    const result = useProviderGuide();
    result.dismiss();
    expect(mockMutate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    const options = mockMutate.mock.calls.at(-1)?.[1];
    if (
      !options ||
      typeof options !== "object" ||
      !("onSuccess" in options) ||
      typeof options.onSuccess !== "function"
    ) {
      throw new Error("Expected dismissal success callback");
    }
    options.onSuccess();
    expect(mockInvalidate).toHaveBeenCalled();
  });
});

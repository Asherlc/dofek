import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient, locallyReportedErrorMeta } from "./query-client.ts";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

describe("createAppQueryClient", () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
  });

  it("reports query errors with only the procedure name", async () => {
    const queryClient = createAppQueryClient();
    const queryError = new Error("Unexpected end of JSON input");
    const secret = "session-token-must-not-leak";

    await expect(
      queryClient.fetchQuery({
        queryKey: [["processing", "status"], { input: { token: secret }, type: "query" }],
        retry: false,
        queryFn: async () => {
          throw queryError;
        },
      }),
    ).rejects.toThrow(queryError);

    expect(mockCaptureException).toHaveBeenCalledWith(queryError, {
      source: "react-query-query",
      operation: "processing.status",
      failureCount: 1,
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(secret);
  });

  it("does not duplicate a query error reported by its caller", async () => {
    const queryClient = createAppQueryClient();
    const queryError = new Error("Already reported");

    await expect(
      queryClient.fetchQuery({
        queryKey: [["sync", "status"], { input: { jobId: "secret-job-id" }, type: "query" }],
        meta: locallyReportedErrorMeta,
        retry: false,
        queryFn: async () => {
          throw queryError;
        },
      }),
    ).rejects.toThrow(queryError);

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("reports mutation errors without including variables", async () => {
    const queryClient = createAppQueryClient();
    const mutationError = new Error("Authentication failed");
    const secret = "password-must-not-leak";
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: [["credentialAuth", "signIn"]],
      mutationFn: async () => {
        throw mutationError;
      },
    });

    await expect(mutation.execute({ password: secret })).rejects.toThrow(mutationError);

    expect(mockCaptureException).toHaveBeenCalledWith(mutationError, {
      source: "react-query-mutation",
      operation: "credentialAuth.signIn",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(secret);
  });

  it("does not duplicate a mutation error reported by its caller", async () => {
    const queryClient = createAppQueryClient();
    const mutationError = new Error("Already reported");
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: [["credentialAuth", "signIn"]],
      meta: locallyReportedErrorMeta,
      mutationFn: async () => {
        throw mutationError;
      },
    });

    await expect(mutation.execute({ password: "secret" })).rejects.toThrow(mutationError);

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("configures default query options", () => {
    const queryClient = createAppQueryClient();
    const defaults = queryClient.getDefaultOptions();

    expect(defaults.queries).toMatchObject({
      staleTime: 0,
      gcTime: 0,
      refetchOnWindowFocus: false,
    });
  });
});

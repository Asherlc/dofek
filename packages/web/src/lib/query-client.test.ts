import { environmentManager, QueryObserver } from "@tanstack/react-query";
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

  it("marks locally reported errors with an immutable true flag", () => {
    expect(locallyReportedErrorMeta).toEqual({
      errorReportedLocally: true,
    });
    expect(Object.isFrozen(locallyReportedErrorMeta)).toBe(true);
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

  it("does not automatically retry a failed query", async () => {
    const queryClient = createAppQueryClient();
    const queryFn = vi.fn().mockRejectedValue(new Error("Server unavailable"));
    const wasServer = environmentManager.isServer();
    environmentManager.setIsServer(() => false);
    const observer = new QueryObserver(queryClient, {
      queryKey: ["offline-query"],
      queryFn,
      retryDelay: 0,
    });
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = observer.subscribe((result) => {
        if (result.isError) {
          unsubscribe();
          resolve();
        }
      });
    });

    try {
      await settled;
    } finally {
      environmentManager.setIsServer(() => wasServer);
    }

    expect(queryFn).toHaveBeenCalledOnce();
  });

  it("keeps authenticated data through route-away/back during an active session", async () => {
    const queryClient = createAppQueryClient();
    const queryKey = [
      ["recovery", "readinessScore"],
      { input: { days: 30, endDate: "2026-07-28" }, type: "query" },
    ];
    const routeObserver = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => ({ score: 82 }),
    });
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = routeObserver.subscribe((result) => {
        if (result.isSuccess) {
          unsubscribe();
          resolve();
        }
      });
    });

    await settled;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData(queryKey)).toEqual({ score: 82 });

    const returnedRouteObserver = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => {
        throw new Error("Server unavailable");
      },
    });
    const initialResult = returnedRouteObserver.getCurrentResult();

    expect(initialResult.data).toEqual({ score: 82 });
    expect(initialResult.isStale).toBe(true);

    await new Promise<void>((resolve) => {
      const unsubscribe = returnedRouteObserver.subscribe((result) => {
        if (result.isError) {
          expect(result.data).toEqual({ score: 82 });
          unsubscribe();
          resolve();
        }
      });
    });
  });

  it("does not persist authenticated health data into a cold browser session", async () => {
    const activeSessionClient = createAppQueryClient();
    const queryKey = [
      ["recovery", "readinessScore"],
      { input: { days: 30, endDate: "2026-07-28" }, type: "query" },
    ];
    await activeSessionClient.fetchQuery({
      queryKey,
      queryFn: async () => ({ score: 82 }),
    });

    const coldSessionClient = createAppQueryClient();

    expect(coldSessionClient.getQueryData(queryKey)).toBeUndefined();
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

  it.each([
    {
      name: "a missing mutation key",
      mutationKey: undefined,
    },
    {
      name: "a non-array procedure path",
      mutationKey: [123],
    },
    {
      name: "a procedure path with a non-string segment",
      mutationKey: [["credentialAuth", 123]],
    },
  ])("reports unknown for $name", async ({ mutationKey }) => {
    const queryClient = createAppQueryClient();
    const mutationError = new Error("Unknown operation failed");
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey,
      mutationFn: async () => {
        throw mutationError;
      },
    });

    await expect(mutation.execute(undefined)).rejects.toThrow(mutationError);

    expect(mockCaptureException).toHaveBeenCalledWith(mutationError, {
      source: "react-query-mutation",
      operation: "unknown",
    });
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
      gcTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
      retry: false,
    });
  });
});

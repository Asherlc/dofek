import { createTRPCClient, createTRPCUntypedClient } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { describe, expect, it, vi } from "vitest";
import { createMobileTrpcLinks } from "./trpc-links";

describe("createMobileTrpcLinks", () => {
  it("lets realtime finish independently while the motion HTTP response is pending", async () => {
    const motionResponse = Promise.withResolvers<void>();
    const realtimeResponse = Promise.withResolvers<void>();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const paths = url.pathname.split("/").at(-1)?.split(",") ?? [];
      await (paths.includes("inertialMeasurementUnitSync.pushSamples")
        ? motionResponse.promise
        : realtimeResponse.promise);
      const results = paths.map(() => ({ result: { data: { inserted: 1 } } }));
      return Response.json(url.searchParams.has("batch") ? results : results[0]);
    });
    const client = createTRPCClient<AppRouter>({
      links: createMobileTrpcLinks({
        url: "https://dofek.test/api/trpc",
        fetch: fetchImpl,
        methodOverride: "POST",
        headers: { Authorization: "Bearer session-token" },
      }),
    });
    const motion = client.inertialMeasurementUnitSync.pushSamples.mutate({
      deviceId: "whoop-123",
      deviceType: "whoop",
      samples: [],
      telemetry: { batchId: "11111111-1111-4111-8111-111111111111" },
    });
    const realtime = client.whoopBleSync.pushRealtimeData.mutate({
      deviceId: "whoop-123",
      samples: [],
      telemetry: { batchId: "22222222-2222-4222-8222-222222222222" },
    });
    const motionFinished = vi.fn();
    void motion.then(motionFinished);

    try {
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
        "/api/trpc/inertialMeasurementUnitSync.pushSamples",
        "/api/trpc/whoopBleSync.pushRealtimeData",
      ]);
      for (const [input, init] of fetchImpl.mock.calls) {
        expect(new URL(String(input)).searchParams.has("batch")).toBe(false);
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-token");
        expect(new Headers(init?.headers).get("x-dofek-upload-id")).toBe(
          String(input).includes("inertialMeasurementUnitSync")
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
        );
      }
      realtimeResponse.resolve();
      await expect(realtime).resolves.toEqual({ inserted: 1 });
      expect(motionFinished).not.toHaveBeenCalled();
    } finally {
      realtimeResponse.resolve();
      motionResponse.resolve();
      await Promise.all([motion, realtime]);
    }
    expect(motionFinished).toHaveBeenCalledOnce();
  });

  it("keeps dashboard requests independent and batches other requests by operation type", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const paths = url.pathname.split("/").at(-1)?.split(",") ?? [];
      const results = paths.map(() => ({ result: { data: {} } }));
      return Response.json(url.searchParams.has("batch") ? results : results[0]);
    });
    const client = createTRPCUntypedClient<AppRouter>({
      links: createMobileTrpcLinks({
        url: "https://dofek.test/api/trpc",
        fetch: fetchImpl,
        methodOverride: "POST",
      }),
    });
    await Promise.all([
      client.query("mobileDashboard.dashboard"),
      client.query("mobileDashboard.dashboardV2"),
      client.query("mobileDashboard.recovery"),
      client.query("mobileDashboard.trainingV2"),
      client.query("processing.status"),
      client.query("anomalyDetection.check"),
      client.mutation("healthKitSync.recordSync", {}),
      client.mutation("healthKitSync.pushQuantitySamples", {}),
    ]);

    const urls = fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.filter((url) => !url.searchParams.has("batch")).map((url) => url.pathname)).toEqual(
      [
        "/api/trpc/mobileDashboard.dashboard",
        "/api/trpc/mobileDashboard.dashboardV2",
        "/api/trpc/mobileDashboard.recovery",
        "/api/trpc/mobileDashboard.trainingV2",
      ],
    );
    expect(urls.filter((url) => url.searchParams.has("batch")).map((url) => url.pathname)).toEqual([
      "/api/trpc/processing.status,anomalyDetection.check",
      "/api/trpc/healthKitSync.recordSync,healthKitSync.pushQuantitySamples",
    ]);
  });
});

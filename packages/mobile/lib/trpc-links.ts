import { httpBatchLink, httpLink, splitLink, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";

export function createMobileTrpcLinks(
  options: Parameters<typeof httpLink<AppRouter>>[0] &
    Parameters<typeof httpBatchLink<AppRouter>>[0],
): TRPCLink<AppRouter>[] {
  const batchLink = httpBatchLink<AppRouter>(options);
  const individualLink = httpLink<AppRouter>(options);

  return [
    splitLink({
      condition: (operation) =>
        (operation.type === "mutation" &&
          (operation.path === "inertialMeasurementUnitSync.pushSamples" ||
            operation.path === "whoopBleSync.pushRealtimeData")) ||
        (operation.type === "query" &&
          (operation.path === "mobileDashboard.dashboard" ||
            operation.path === "mobileDashboard.dashboardV2" ||
            operation.path === "mobileDashboard.recovery" ||
            operation.path === "mobileDashboard.training")),
      true: individualLink,
      false: batchLink,
    }),
  ];
}

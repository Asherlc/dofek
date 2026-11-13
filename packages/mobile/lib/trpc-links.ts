import { httpBatchLink, httpLink, splitLink, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";

export function createMobileTrpcLinks(
  options: Parameters<typeof httpLink<AppRouter>>[0] &
    Parameters<typeof httpBatchLink<AppRouter>>[0],
): TRPCLink<AppRouter>[] {
  const batchLink = httpBatchLink<AppRouter>(options);
  const individualLink = httpLink<AppRouter>({
    ...options,
    headers: async (operationOptions) => {
      const headers =
        typeof options.headers === "function"
          ? await options.headers({ ...operationOptions, opList: [operationOptions.op] })
          : options.headers;
      const { op } = operationOptions;
      if (
        op.type === "mutation" &&
        (op.path === "inertialMeasurementUnitSync.pushSamples" ||
          op.path === "whoopBleSync.pushRealtimeData") &&
        typeof op.input === "object" &&
        op.input !== null
      ) {
        const telemetry = Reflect.get(op.input, "telemetry");
        if (typeof telemetry === "object" && telemetry !== null) {
          const batchId = Reflect.get(telemetry, "batchId");
          if (typeof batchId === "string") {
            return { ...headers, "x-dofek-upload-id": batchId };
          }
        }
      }
      return headers ?? {};
    },
  });

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
            operation.path === "mobileDashboard.trainingV2")),
      true: individualLink,
      false: batchLink,
    }),
  ];
}

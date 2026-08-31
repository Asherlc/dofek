import type { HealthExplorerSnapshot, HealthMetric } from "@dofek/mcp-contracts/health-explorer";
import { captureException } from "@sentry/react";
import { parseHealthExplorerResult } from "./health-explorer-result.ts";

type ToolApp = {
  callServerTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ structuredContent?: unknown }>;
};

export function createMetricRequestHandler({
  setSnapshot,
  setError,
}: {
  setSnapshot(snapshot: HealthExplorerSnapshot): void;
  setError(message: string): void;
}) {
  let latestRequest = 0;

  return async (app: ToolApp, snapshot: HealthExplorerSnapshot, metric: HealthMetric) => {
    const request = ++latestRequest;
    try {
      const result = await app.callServerTool({
        name: "render_health_explorer",
        arguments: { ...snapshot.range, metrics: [metric] },
      });
      const updatedSnapshot = parseHealthExplorerResult(result.structuredContent);
      if (request !== latestRequest) return;
      if (!updatedSnapshot) {
        setError("Dofek Explorer received an invalid response from the server. Please try again.");
        return;
      }
      setSnapshot(updatedSnapshot);
    } catch (cause) {
      captureException(cause);
      if (request === latestRequest) {
        setError(cause instanceof Error ? cause.message : "Unable to update Dofek Explorer.");
      }
    }
  };
}

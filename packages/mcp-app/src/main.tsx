import type { HealthExplorerSnapshot, HealthMetric } from "@dofek/mcp-contracts/health-explorer";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { HealthExplorer } from "./health-explorer.tsx";
import { parseHealthExplorerResult } from "./health-explorer-result.ts";

function ExplorerApp() {
  const [snapshot, setSnapshot] = useState<HealthExplorerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    app,
    isConnected,
    error: connectionError,
  } = useApp({
    appInfo: { name: "Dofek Analytics Explorer", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (result) => {
        const snapshot = parseHealthExplorerResult(result.structuredContent);
        if (!snapshot) {
          setError(
            "Dofek Explorer received an invalid response from the server. Please try again.",
          );
          return;
        }
        setError(null);
        setSnapshot(snapshot);
      };
    },
  });
  const onMetricChange = useCallback(
    async (metric: HealthMetric) => {
      if (!app || !snapshot) return;
      try {
        const result = await app.callServerTool({
          name: "render_health_explorer",
          arguments: { ...snapshot.range, metrics: [metric] },
        });
        const updatedSnapshot = parseHealthExplorerResult(result.structuredContent);
        if (!updatedSnapshot) {
          setError(
            "Dofek Explorer received an invalid response from the server. Please try again.",
          );
          return;
        }
        setSnapshot(updatedSnapshot);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to update Dofek Explorer.");
      }
    },
    [app, snapshot],
  );

  if (connectionError) return <p role="alert">{connectionError.message}</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!isConnected || !snapshot) return <p>Loading Dofek analytics…</p>;
  return <HealthExplorer snapshot={snapshot} onMetricChange={onMetricChange} />;
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Dofek Analytics Explorer root element is missing.");
}

createRoot(root).render(<ExplorerApp />);

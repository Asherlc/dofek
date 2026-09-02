import type { HealthExplorerSnapshot, HealthMetric } from "@dofek/mcp-contracts/health-explorer";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HealthExplorer } from "./health-explorer.tsx";
import { parseHealthExplorerResult } from "./health-explorer-result.ts";
import { createMetricRequestHandler } from "./metric-request.ts";

function ExplorerApp() {
  const [snapshot, setSnapshot] = useState<HealthExplorerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const metricRequestHandler = useRef(createMetricRequestHandler({ setError, setSnapshot }));
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
      await metricRequestHandler.current(app, snapshot, metric);
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

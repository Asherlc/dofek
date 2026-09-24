import type { DayNutritionPreview } from "@dofek/mcp-contracts/day-nutrition";
import type { HealthExplorerSnapshot, HealthMetric } from "@dofek/mcp-contracts/health-explorer";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DayNutritionPreviewPanel } from "./day-nutrition-preview.tsx";
import { parseDayNutritionResult } from "./day-nutrition-result.ts";
import { HealthExplorer } from "./health-explorer.tsx";
import { parseHealthExplorerResult } from "./health-explorer-result.ts";
import { createMetricRequestHandler } from "./metric-request.ts";

type AppView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "health-explorer"; snapshot: HealthExplorerSnapshot }
  | { kind: "day-nutrition"; preview: DayNutritionPreview }
  | { kind: "day-nutrition-unavailable" };

function DofekMcpApp() {
  const [view, setView] = useState<AppView>({ kind: "loading" });
  const metricRequestHandler = useRef(
    createMetricRequestHandler({
      setError: (message) => setView({ kind: "error", message }),
      setSnapshot: (snapshot) => setView({ kind: "health-explorer", snapshot }),
    }),
  );
  const {
    app,
    isConnected,
    error: connectionError,
  } = useApp({
    appInfo: { name: "Dofek", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (result) => {
        const healthSnapshot = parseHealthExplorerResult(result.structuredContent);
        if (healthSnapshot) {
          setView({ kind: "health-explorer", snapshot: healthSnapshot });
          return;
        }
        const dayNutrition = parseDayNutritionResult(result.structuredContent);
        if (dayNutrition.status === "ok") {
          setView({ kind: "day-nutrition", preview: dayNutrition.preview });
          return;
        }
        if (dayNutrition.status === "unavailable") {
          setView({ kind: "day-nutrition-unavailable" });
          return;
        }
        setView({
          kind: "error",
          message: "Dofek received an invalid response from the server. Please try again.",
        });
      };
    },
  });
  const onMetricChange = useCallback(
    async (metric: HealthMetric) => {
      if (!app || view.kind !== "health-explorer") return;
      await metricRequestHandler.current(app, view.snapshot, metric);
    },
    [app, view],
  );

  if (connectionError) return <p role="alert">{connectionError.message}</p>;
  if (!isConnected) return <p>Loading Dofek…</p>;
  if (view.kind === "loading") return <p>Loading Dofek…</p>;
  if (view.kind === "error") return <p role="alert">{view.message}</p>;
  if (view.kind === "day-nutrition-unavailable") {
    return (
      <p role="status">
        Day totals are unavailable because nutrition sources conflict for this date.
      </p>
    );
  }
  if (view.kind === "day-nutrition") {
    return <DayNutritionPreviewPanel preview={view.preview} />;
  }
  return <HealthExplorer snapshot={view.snapshot} onMetricChange={onMetricChange} />;
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Dofek MCP App root element is missing.");
}

createRoot(root).render(<DofekMcpApp />);

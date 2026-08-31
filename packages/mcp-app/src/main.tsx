import { healthExplorerSnapshotSchema, type HealthMetric } from "@dofek/mcp-contracts/health-explorer";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { createRoot } from "react-dom/client";
import { useCallback, useState } from "react";
import { HealthExplorer } from "./health-explorer.tsx";

function ExplorerApp() {
  const [snapshot, setSnapshot] = useState<ReturnType<typeof healthExplorerSnapshotSchema.parse> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { app, isConnected, error: connectionError } = useApp({
    appInfo: { name: "Dofek Analytics Explorer", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (result) => {
        const parsed = healthExplorerSnapshotSchema.safeParse(result.structuredContent);
        if (parsed.success) setSnapshot(parsed.data);
      };
    },
  });
  const onMetricChange = useCallback(async (metric: HealthMetric) => {
    if (!app || !snapshot) return;
    try {
      const result = await app.callServerTool({
        name: "render_health_explorer",
        arguments: { ...snapshot.range, metrics: [metric] },
      });
      setSnapshot(healthExplorerSnapshotSchema.parse(result.structuredContent));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update Dofek Explorer.");
    }
  }, [app, snapshot]);

  if (connectionError) return <p role="alert">{connectionError.message}</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!isConnected || !snapshot) return <p>Loading Dofek analytics…</p>;
  return <HealthExplorer snapshot={snapshot} onMetricChange={onMetricChange} />;
}

createRoot(document.getElementById("root")!).render(<ExplorerApp />);

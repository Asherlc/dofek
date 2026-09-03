import {
  type HealthExplorerSnapshot,
  healthExplorerSnapshotSchema,
} from "@dofek/mcp-contracts/health-explorer";

export function parseHealthExplorerResult(
  structuredContent: unknown,
): HealthExplorerSnapshot | null {
  const parsed = healthExplorerSnapshotSchema.safeParse(structuredContent);
  return parsed.success ? parsed.data : null;
}

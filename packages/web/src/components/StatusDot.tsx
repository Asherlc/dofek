import { operationalStatusColors } from "@dofek/scoring/colors";
import type { SyncStatus } from "./DataSourcesSyncTypes.ts";

export function StatusDot({ status }: { status: SyncStatus }) {
  const presentation: Record<
    SyncStatus,
    {
      label: string;
      symbol: string;
      tone: (typeof operationalStatusColors)[keyof typeof operationalStatusColors];
    }
  > = {
    idle: { label: "Idle", symbol: "—", tone: operationalStatusColors.neutral },
    syncing: { label: "Syncing", symbol: "↻", tone: operationalStatusColors.info },
    done: { label: "Synced", symbol: "✓", tone: operationalStatusColors.success },
    error: { label: "Error", symbol: "!", tone: operationalStatusColors.danger },
  };
  const { label, symbol, tone } = presentation[status];

  return (
    <output
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-semibold leading-none"
      aria-label={`Status: ${label}`}
      style={{
        backgroundColor: tone.surface,
        borderColor: tone.border,
        color: tone.foreground,
      }}
    >
      <span aria-hidden="true">{symbol}</span>
      <span>{label}</span>
    </output>
  );
}

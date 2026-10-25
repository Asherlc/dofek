import {
  type ActivityHardware,
  activityHardwareDetailsLabel,
  activityHardwareRoleLabels,
} from "@dofek/providers/activity-hardware";
import { providerLabel } from "@dofek/providers/providers";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface Props {
  data?: ActivityHardware;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}
export function ActivityHardwarePanel({ data, loading = false, error, onRetry }: Props) {
  return (
    <section
      className="rounded-xl border border-border bg-surface p-4 space-y-3"
      aria-label="Devices and sensors"
    >
      <h2 className="text-sm font-semibold text-foreground">Devices and sensors</h2>
      {error ? <QueryStatePanel error={error} onRetry={onRetry} height={72} /> : null}
      {!data && loading && !error ? (
        <QueryStatePanel variant="loading" contextLabel="Devices and sensors" height={72} />
      ) : null}
      {data?.items.map((item) => (
        <div key={item.id} className="space-y-1">
          <p className="text-sm font-medium text-foreground">{item.label}</p>
          <p className="text-xs text-muted">
            {activityHardwareRoleLabels[item.role]} · {providerLabel(item.providerId)}
            {item.sourceName ? ` · ${item.sourceName}` : ""}
          </p>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer py-1">
              {activityHardwareDetailsLabel(item.role)}
            </summary>
            <p className="py-1">{item.evidence}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-1">
              {item.manufacturer ? (
                <>
                  <dt>Manufacturer</dt>
                  <dd>{item.manufacturer}</dd>
                </>
              ) : null}
              {item.model && item.model !== item.label ? (
                <>
                  <dt>Model</dt>
                  <dd>{item.model}</dd>
                </>
              ) : null}
              {item.details.map((detail) => (
                <div className="contents" key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd className="break-all">{detail.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      ))}
      {data?.power.map((power) => (
        <p key={power.activityId} className="text-xs text-muted">
          {power.label}
        </p>
      ))}
      {data && data.items.length === 0 && data.power.length === 0 && !error ? (
        <QueryStatePanel variant="empty" message="No device metadata reported." height={64} />
      ) : null}
    </section>
  );
}

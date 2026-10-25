import {
  type ActivityHardware,
  activityHardwareRoleLabels,
} from "@dofek/providers/activity-hardware";
import { providerLabel } from "@dofek/providers/providers";
import { useState } from "react";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface Props {
  data?: ActivityHardware;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}
export function ActivityHardwarePanel({ data, loading = false, error, onRetry }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hasHardware = data && (data.items.length > 0 || data.power.length > 0);
  return (
    <section
      className="rounded-xl border border-border bg-surface p-4 space-y-3"
      aria-label="Devices and sensors"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Devices and sensors</h2>
        {hasHardware ? (
          <button
            type="button"
            aria-label="Device and sensor details"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex min-h-11 items-center gap-1 rounded px-2 text-xs text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
          >
            Details
            <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
          </button>
        ) : null}
      </div>
      {error ? <QueryStatePanel error={error} onRetry={onRetry} height={72} /> : null}
      {!data && loading && !error ? (
        <QueryStatePanel variant="loading" contextLabel="Devices and sensors" height={72} />
      ) : null}
      {data?.items.map((item, index) => (
        <div
          key={item.id}
          className={index > 0 ? "space-y-1 border-t border-border pt-3" : "space-y-1"}
        >
          <p className="text-sm font-medium text-foreground">{item.label}</p>
          <p className="text-xs text-muted">
            {activityHardwareRoleLabels[item.role]} · {providerLabel(item.providerId)}
          </p>
          {expanded ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 pt-2 text-xs text-muted">
              {item.sourceName &&
              item.sourceName !== item.label &&
              item.sourceName !== providerLabel(item.providerId) ? (
                <>
                  <dt>Source</dt>
                  <dd className="wrap-anywhere">{item.sourceName}</dd>
                </>
              ) : null}
              {item.manufacturer ? (
                <>
                  <dt>Manufacturer</dt>
                  <dd className="wrap-anywhere">{item.manufacturer}</dd>
                </>
              ) : null}
              {item.model && item.model !== item.label ? (
                <>
                  <dt>Model</dt>
                  <dd className="wrap-anywhere">{item.model}</dd>
                </>
              ) : null}
              {item.details.map((detail) => (
                <div className="contents" key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd className="wrap-anywhere">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ))}
      {expanded
        ? data?.power.map((power) => (
            <p key={power.activityId} className="text-xs text-muted">
              {power.label}
            </p>
          ))
        : null}
      {data && data.items.length === 0 && data.power.length === 0 && !error ? (
        <QueryStatePanel variant="empty" message="No device metadata reported." height={64} />
      ) : null}
    </section>
  );
}

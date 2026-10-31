import { formatRelativeTime } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import type { WhoopSensorSnapshot } from "@dofek/providers/whoop-sensors";
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface Props {
  data: WhoopSensorSnapshot | undefined;
  isLoading: boolean;
  error: string | null;
}

export function WhoopSensorDetails({ data, isLoading, error }: Props) {
  const [expanded, setExpanded] = useState(false);
  const units = useUnitConverter();
  return (
    <section className="card p-4 space-y-3" aria-label="WHOOP background sensors">
      <h2 className="text-sm font-medium">Background sensors</h2>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {!data && isLoading && (
        <QueryStatePanel variant="loading" contextLabel="Background sensors" />
      )}
      {data && data.records.length === 0 && (
        <p className="text-sm text-muted">No background sensor records uploaded yet.</p>
      )}
      {data && data.records.length > 0 && (
        <>
          <p>
            {data.skinTemperatureC === null
              ? "Skin temperature unavailable"
              : `Skin temperature: ${formatMeasurementText(units.formatTemperature(data.skinTemperatureC))}`}
          </p>
          {data.latestMeasuredAt && (
            <p className="text-xs text-muted">
              Measured {formatRelativeTime(data.latestMeasuredAt)}
            </p>
          )}
          {data.latestReceivedAt && (
            <p className="text-xs text-muted">
              Captured {formatRelativeTime(data.latestReceivedAt)}
            </p>
          )}
          <button
            type="button"
            className="text-sm text-accent"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            Raw sensor records
          </button>
          {expanded && (
            <div className="space-y-4">
              {data.records.map((record) => (
                <article
                  key={`${record.deviceId}:${record.captureId}`}
                  className="border-t border-border pt-3 space-y-1"
                >
                  <h3 className="text-sm font-medium">
                    {record.deviceInfo.name ?? record.deviceId}
                  </h3>
                  <p className="text-xs text-muted">
                    Record {record.layout} · {record.interpretation}
                  </p>
                  {record.deviceInfo.firmware && (
                    <p className="text-xs text-muted">Firmware {record.deviceInfo.firmware}</p>
                  )}
                  <ul className="text-xs">
                    {record.fields.map((field) => (
                      <li key={field.label}>
                        {field.label}: {field.value} {field.unit}
                      </li>
                    ))}
                  </ul>
                  <details>
                    <summary className="text-xs cursor-pointer">Packet bytes</summary>
                    <code className="block break-all text-xs max-h-48 overflow-auto">
                      {record.rawFrameHex}
                    </code>
                  </details>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function WhoopSensorPanel() {
  const query = trpc.whoopBleSync.sensorSnapshot.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  return (
    <WhoopSensorDetails
      data={query.data}
      isLoading={query.isLoading}
      error={query.error?.message ?? null}
    />
  );
}

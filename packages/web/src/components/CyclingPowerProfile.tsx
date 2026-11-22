import {
  formatDateMedium,
  formatDateShort,
  formatDurationSeconds,
  formatNumber,
} from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import { Link } from "@tanstack/react-router";
import type { AppRouterOutputs } from "dofek-server/router";
import { type ReactNode, useId, useState } from "react";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ProviderRecordDetail } from "../pages/ProviderRecordDetail.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

type Profile = AppRouterOutputs["cycling"]["powerProfile"];
type Weight = Profile["threshold"]["weight"];
type WeightRecord = { providerId: string; recordId: string };

const durationLabels = { 5: "5 seconds", 60: "1 minute", 300: "5 minutes" } as const;

function ProfileRow({
  label,
  detail,
  date,
  watts,
  wattsPerKg,
  missingMessage,
  children,
}: {
  label: string;
  detail?: string | null;
  date?: string | null;
  watts: number | null;
  wattsPerKg: number | null;
  missingMessage?: string;
  children?: ReactNode;
}) {
  const content = (
    <>
      <span className="font-semibold">{label}</span>
      <span className="text-muted">
        {watts === null ? missingMessage : detail}
        {date && <span className="block text-xs">{date}</span>}
      </span>
      <span className="text-right tabular-nums">
        {wattsPerKg !== null && (
          <span className="block font-semibold">{formatNumber(wattsPerKg, 2)} W/kg</span>
        )}
        {watts !== null && <span className="text-muted">{formatNumber(watts, 0)} W</span>}
      </span>
    </>
  );
  const rowLayout =
    "grid min-h-11 grid-cols-[minmax(4.5rem,1fr)_minmax(0,1.5fr)_auto_1rem] items-center gap-2 px-3 py-2 text-sm";
  return watts === null ? (
    <div className={rowLayout}>{content}</div>
  ) : (
    <details>
      <summary className={`${rowLayout} cursor-pointer list-none hover:bg-surface`}>
        {content}
        <span aria-hidden="true" className="text-center text-muted">
          ▾
        </span>
      </summary>
      <div className="flex flex-wrap gap-x-6 gap-y-2 px-3 pb-3 text-sm">{children}</div>
    </details>
  );
}

function BodyWeight({
  weight,
  openRecord,
}: {
  weight: Weight;
  openRecord: (record: WeightRecord) => void;
}) {
  const units = useUnitConverter();
  if (weight === null) return null;
  if (weight.value_kg === null) return <p className="text-muted">{weight.reason}</p>;

  return (
    <div>
      <p className="text-xs text-muted">Body weight</p>
      {weight.kind === "interpolated" && (
        <p>{formatMeasurementText(units.formatWeight(weight.value_kg))} interpolated</p>
      )}
      {weight.sources.map((source) => {
        const label = `${formatMeasurementText(units.formatWeight(source.value_kg))} · ${formatDateShort(source.date)}`;
        const recordId = source.record_id;
        return recordId ? (
          <button
            key={recordId}
            type="button"
            className="block min-h-8 cursor-pointer underline"
            onClick={() => openRecord({ providerId: source.provider, recordId })}
          >
            {label}
          </button>
        ) : (
          <p key={`${source.provider}:${source.recorded_at}`}>{label}</p>
        );
      })}
    </div>
  );
}

export function CyclingPowerProfile({
  profile,
  loading = false,
  error,
}: {
  profile?: Profile;
  loading?: boolean;
  error?: { message: string } | null;
}) {
  const headingId = useId();
  const [record, setRecord] = useState<WeightRecord | null>(null);

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-1 text-sm font-medium uppercase tracking-wider text-muted">
        Cycling power profile
      </h2>
      {error && <QueryStatePanel contextLabel="Cycling power profile" error={error} height={0} />}
      {loading && !profile && (
        <QueryStatePanel contextLabel="Cycling power profile" variant="loading" />
      )}
      {profile && (
        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted">
            <p>
              {profile.range.start_date ? formatDateMedium(profile.range.start_date) : "All time"} –{" "}
              {formatDateMedium(profile.range.end_date)}
            </p>
            <p>Maximal test status unverified</p>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border">
            {profile.efforts.map(({ duration_seconds, effort }) => (
              <ProfileRow
                key={duration_seconds}
                label={durationLabels[duration_seconds]}
                detail={effort?.activity_name ?? "Cycling activity"}
                date={effort ? formatDateShort(effort.date) : null}
                watts={effort?.watts ?? null}
                wattsPerKg={effort?.watts_per_kg ?? null}
                missingMessage="No recorded effort"
              >
                {effort && (
                  <>
                    {effort.start_offset_seconds !== null && effort.end_offset_seconds !== null && (
                      <div>
                        <p className="text-xs text-muted">Effort in ride</p>
                        <p>
                          {formatDurationSeconds(effort.start_offset_seconds, {
                            precision: "second",
                          })}{" "}
                          –{" "}
                          {formatDurationSeconds(effort.end_offset_seconds, {
                            precision: "second",
                          })}{" "}
                          elapsed
                        </p>
                      </div>
                    )}
                    <Link
                      to="/activity/$id"
                      params={{ id: effort.activity_id }}
                      className="underline"
                    >
                      View activity
                    </Link>
                    <BodyWeight weight={effort.weight} openRecord={setRecord} />
                  </>
                )}
              </ProfileRow>
            ))}
            <ProfileRow
              label="Threshold (FTP)"
              detail="Dofek cycling settings"
              date={
                profile.threshold.effective_from
                  ? `Effective ${formatDateMedium(profile.threshold.effective_from)}`
                  : null
              }
              watts={profile.threshold.watts}
              wattsPerKg={profile.threshold.watts_per_kg}
              missingMessage="No configured FTP"
            >
              <BodyWeight weight={profile.threshold.weight} openRecord={setRecord} />
            </ProfileRow>
          </div>
        </div>
      )}
      {record && (
        <ProviderRecordDetail
          input={{ ...record, dataType: "bodyMeasurements" }}
          onClose={() => setRecord(null)}
        />
      )}
    </section>
  );
}

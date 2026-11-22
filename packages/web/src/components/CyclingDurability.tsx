import {
  cyclingDurabilityDurations,
  cyclingDurabilityEmpty,
  cyclingDurabilityIntro,
  cyclingDurabilityNoLateEffort,
  cyclingDurabilityTitle,
  cyclingDurabilityWorkHelp,
  cyclingDurabilityWorkLevels,
  formatDurabilityOffset,
  formatDurabilityPower,
  formatDurabilityRange,
  formatDurabilityWeight,
  formatDurabilityWork,
} from "@dofek/format/cycling-durability";
import { formatDateMedium, formatNumber } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import type {
  CyclingDurabilityEffort,
  CyclingDurabilityResult,
  CyclingDurabilitySelection,
} from "dofek-server/types";
import { useId, useState } from "react";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../lib/trainingQueryOptions.ts";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export function CyclingDurability({ days }: { days: number | null }) {
  const [selection, setSelection] = useState<CyclingDurabilitySelection>({
    durationSeconds: 300,
    minimumWorkKilojoulesPerKg: 30,
  });
  const query = trpc.cycling.durability.useQuery(
    { days, ...selection },
    { ...TRAINING_SLOW_QUERY_OPTIONS, placeholderData: (previous) => previous },
  );
  return (
    <CyclingDurabilityPanel
      data={query.data}
      loading={query.isLoading}
      updating={query.isPlaceholderData}
      error={query.error}
      selection={selection}
      onChange={setSelection}
    />
  );
}

export function CyclingDurabilityPanel({
  data,
  error,
  loading,
  updating,
  selection,
  onChange,
}: {
  data?: CyclingDurabilityResult;
  error?: unknown;
  loading?: boolean;
  updating?: boolean;
  selection: CyclingDurabilitySelection;
  onChange: (selection: CyclingDurabilitySelection) => void;
}) {
  const heading = useId();
  const workHelp = useId();
  const referenceWeight =
    data?.presentation.absoluteWorkCutoffKilojoules == null
      ? undefined
      : data.baseline?.weight.value_kg;
  return (
    <section className="card p-4 space-y-4" aria-labelledby={heading}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-base font-semibold" id={heading}>
          {cyclingDurabilityTitle}
        </h2>
        {data ? (
          <p className="text-sm text-muted">
            {formatDurabilityRange(data.range.startDate, data.range.endDate)}
          </p>
        ) : null}
      </header>
      <p className="text-sm">{cyclingDurabilityIntro}</p>
      <div aria-busy={updating || loading} aria-live="polite">
        {data ? <DurabilityResult data={data} /> : null}
        {error ? (
          <QueryStatePanel contextLabel={cyclingDurabilityTitle} error={error} height={100} />
        ) : loading && !data ? (
          <QueryStatePanel contextLabel={cyclingDurabilityTitle} variant="loading" height={100} />
        ) : null}
      </div>
      <p className="text-sm text-muted" id={workHelp}>
        {cyclingDurabilityWorkHelp}
      </p>
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer font-medium">Change comparison</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            Effort length
            <select
              className="rounded border border-border-strong bg-surface p-2"
              value={selection.durationSeconds}
              onChange={(event) => {
                const duration = cyclingDurabilityDurations.find(
                  ({ value }) => value === Number(event.target.value),
                );
                if (duration) onChange({ ...selection, durationSeconds: duration.value });
              }}
            >
              {cyclingDurabilityDurations.map(({ label, value }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Pedaling before the effort
            <select
              aria-describedby={workHelp}
              className="rounded border border-border-strong bg-surface p-2"
              value={selection.minimumWorkKilojoulesPerKg}
              onChange={(event) => {
                const level = cyclingDurabilityWorkLevels.find(
                  (value) => value === Number(event.target.value),
                );
                if (level) onChange({ ...selection, minimumWorkKilojoulesPerKg: level });
              }}
            >
              {cyclingDurabilityWorkLevels.map((level) => (
                <option key={level} value={level}>
                  At least{" "}
                  {formatDurabilityWork(level * (referenceWeight ?? 1), referenceWeight == null)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
      {data?.baseline ? (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer font-medium">
            See the rides behind these numbers
          </summary>
          <p className="mt-3 text-sm text-muted">This comparison uses outdoor rides.</p>
          {data.sameEffort ? (
            <p className="text-sm">Both values came from the same effort.</p>
          ) : null}
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <EffortDetails label="Best at any point" effort={data.baseline} />
            {data.afterWork && !data.sameEffort ? (
              <EffortDetails label="Best after sustained riding" effort={data.afterWork} />
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DurabilityResult({ data }: { data: CyclingDurabilityResult }) {
  const { baseline, afterWork, presentation, selection } = data;
  if (!baseline)
    return <QueryStatePanel variant="empty" message={cyclingDurabilityEmpty} height={100} />;
  const { unit, difference, absoluteWorkCutoffKilojoules } = presentation;
  const cutoff =
    absoluteWorkCutoffKilojoules == null
      ? `${formatDurabilityWork(selection.minimumWorkKilojoulesPerKg, true)} of body weight`
      : `${formatDurabilityWork(absoluteWorkCutoffKilojoules)} of pedaling`;
  const duration = cyclingDurabilityDurations.find(
    ({ value }) => value === selection.durationSeconds,
  );
  const baselineValue = unit === "watts" ? baseline.watts : baseline.wattsPerKg;
  const afterValue = afterWork && (unit === "watts" ? afterWork.watts : afterWork.wattsPerKg);
  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
      <div>
        <p className="text-2xl font-semibold">
          {afterWork
            ? difference === 0
              ? "Same power"
              : `${formatDurabilityPower(difference, unit)} lower`
            : "No effort after this work"}
        </p>
        <p className="text-sm text-muted">
          Best {duration?.adjective} power after at least {cutoff}
        </p>
      </div>
      <div className="grid gap-2 text-sm">
        <PowerBar
          label="Best at any point in a ride"
          value={baselineValue}
          total={baselineValue}
          unit={unit}
        />
        {afterValue == null ? (
          <p>{cyclingDurabilityNoLateEffort}</p>
        ) : (
          <PowerBar
            label={`Best after at least ${cutoff}`}
            value={afterValue}
            total={baselineValue}
            unit={unit}
          />
        )}
      </div>
    </div>
  );
}

function PowerBar({
  label,
  value,
  total,
  unit,
}: {
  label: string;
  value: number;
  total: number;
  unit: CyclingDurabilityResult["presentation"]["unit"];
}) {
  return (
    <div>
      <div className="flex justify-between gap-4">
        <span>{label}</span>
        <strong className="shrink-0">{formatDurabilityPower(value, unit)}</strong>
      </div>
      <div aria-hidden="true" className="mt-1 h-2 overflow-hidden rounded-full bg-border">
        <div
          className="h-full bg-accent"
          style={{ width: total > 0 ? `${Math.min(100, (value / total) * 100)}%` : "0%" }}
        />
      </div>
    </div>
  );
}

function EffortDetails({ label, effort }: { label: string; effort: CyclingDurabilityEffort }) {
  const { weight, power, coverage } = effort;
  const units = useUnitConverter();
  return (
    <div className="space-y-1 text-sm">
      <h3 className="font-semibold">{label}</h3>
      <p>
        {effort.activityName ?? "Cycling ride"} · {formatDateMedium(effort.date)}
      </p>
      <p>
        {formatDurabilityOffset(effort.elapsedStartSeconds)}–
        {formatDurabilityOffset(effort.elapsedEndSeconds)} into the recording
      </p>
      <p>
        {formatDurabilityPower(effort.watts, "watts")} ·{" "}
        {formatDurabilityPower(effort.wattsPerKg, "w_per_kg")}
      </p>
      <p>
        {formatDurabilityWork(effort.workKilojoules)} before the effort (
        {formatNumber(effort.workKilojoulesPerKg, 1)} kJ/kg)
      </p>
      <p>
        {formatDurabilityWeight(
          weight.kind,
          formatMeasurementText(units.formatWeight(weight.value_kg)),
        )}
      </p>
      <p>
        Weight readings from{" "}
        {weight.sources.map(({ date }) => formatDateMedium(date)).join(" and ")}
      </p>
      <p>
        Power meter data from {power.provider}
        {power.deviceId ? ` · ${power.deviceId}` : ""}
      </p>
      {power.provenance === "meter_flag" ? (
        <p>The source confirms this ride used a power meter.</p>
      ) : null}
      <p>
        {coverage.observedSamples} readings during the effort · Typically{" "}
        {formatNumber(coverage.medianSampleIntervalSeconds, 1)} seconds apart
      </p>
      <p>Complete power data from ride start through the effort</p>
    </div>
  );
}

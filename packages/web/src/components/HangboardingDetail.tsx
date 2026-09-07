import { formatDurationSeconds } from "@dofek/format/format";
import type { HangboardingDetail as HangboardingDetailData } from "../../../server/src/repositories/hangboarding-repository.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface HangboardingDetailProps {
  data: HangboardingDetailData | undefined;
  loading: boolean;
  error: unknown;
}

function nullableValue(value: string | null): string {
  return value ?? "—";
}

function durationValue(value: number | null): string {
  return value === null ? "—" : formatDurationSeconds(value);
}

export function HangboardingDetail({ data, loading, error }: HangboardingDetailProps) {
  if (data == null && loading)
    return <QueryStatePanel variant="loading" contextLabel="Hangboarding details" height={220} />;
  if (data == null && error)
    return <QueryStatePanel error={error} contextLabel="Hangboarding details" height={220} />;
  if (data == null)
    return (
      <QueryStatePanel
        variant="empty"
        message="No Hangboarding details are available."
        height={220}
      />
    );

  return (
    <div className="space-y-4">
      {error ? <QueryStatePanel error={error} height={72} /> : null}
      {data.segmentsError ? (
        <div
          className="rounded border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          role="alert"
        >
          Some Hangboarding intervals could not be imported: {data.segmentsError} Re-import the
          activity to try again.
        </div>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2">
        <Metadata label="Plan" value={nullableValue(data.planName)} />
        <Metadata label="Board" value={nullableValue(data.boardName)} />
      </dl>

      {data.summary.exercises.length > 0 ? (
        <div className="divide-y divide-border rounded border border-border">
          {data.summary.exercises.map((exercise) => (
            <div key={exercise.label} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="font-medium text-foreground">{exercise.label}</span>
              <span className="text-sm text-subtle">
                {exercise.workIntervalCount} {exercise.workIntervalCount === 1 ? "hang" : "hangs"} ·{" "}
                {durationValue(exercise.workDurationSeconds)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <QueryStatePanel variant="empty" message="No completed hangs recorded." height={96} />
      )}

      <dl className="grid gap-3 sm:grid-cols-4">
        <Metadata label="Hangs" value={String(data.summary.workIntervalCount)} />
        <Metadata label="Hang time" value={durationValue(data.summary.totalWorkDurationSeconds)} />
        <Metadata label="Rest time" value={durationValue(data.summary.totalRestDurationSeconds)} />
        <Metadata label="Session time" value={durationValue(data.summary.durationSeconds)} />
      </dl>
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wider text-subtle">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );
}

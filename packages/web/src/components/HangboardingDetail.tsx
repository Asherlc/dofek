import { formatDateTime, formatDurationSeconds } from "@dofek/format/format";
import type { HangboardingDetail as HangboardingDetailData } from "../../../server/src/repositories/hangboarding-repository.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface HangboardingDetailProps {
  data: HangboardingDetailData | undefined;
  loading: boolean;
  error: Error | null;
}

function nullableValue(value: string | null): string {
  return value ?? "—";
}

export function HangboardingDetail({ data, loading, error }: HangboardingDetailProps) {
  if (data == null && loading) {
    return <QueryStatePanel variant="loading" contextLabel="Hangboarding details" height={220} />;
  }

  if (data == null && error) {
    return <QueryStatePanel error={error} contextLabel="Hangboarding details" height={220} />;
  }

  if (data == null) {
    return (
      <QueryStatePanel
        variant="empty"
        message="No Hangboarding details are available."
        height={220}
      />
    );
  }

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
        <Metadata label="Session" value={nullableValue(data.sessionId)} />
        <Metadata label="Board" value={nullableValue(data.boardName)} />
        <Metadata label="Board ID" value={nullableValue(data.boardId)} />
      </dl>

      {data.intervals.length === 0 ? (
        <QueryStatePanel variant="empty" message="No interval data available." height={120} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-left text-sm">
            <caption className="sr-only">Hangboarding intervals</caption>
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wider text-subtle">
                <th scope="col" className="px-2 py-2 font-medium">
                  Interval
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Type
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Started
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Ended
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {data.intervals.map((interval) => (
                <tr key={interval.id} className="border-b border-border last:border-b-0">
                  <td
                    className="px-2 py-2 text-foreground"
                    data-testid="hangboarding-interval-label"
                  >
                    {nullableValue(interval.label)}
                  </td>
                  <td className="px-2 py-2 text-subtle">{nullableValue(interval.intervalType)}</td>
                  <td className="px-2 py-2 whitespace-nowrap text-subtle">
                    {formatDateTime(interval.startedAt)}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-subtle">
                    {interval.endedAt == null ? "—" : formatDateTime(interval.endedAt)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-foreground">
                    {interval.durationSeconds == null
                      ? "—"
                      : formatDurationSeconds(interval.durationSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

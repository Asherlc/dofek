import {
  formatDateLong,
  formatDateMedium,
  formatDateShort,
  formatDurationMinutes,
  formatTimeOnly,
} from "@dofek/format/format";
import { sameDateNightLabel, timingLabel } from "@dofek/format/late-workout-sleep-labels";
import { providerLabel } from "@dofek/providers/providers";
import type { LateWorkoutSleep, LateWorkoutSleepNight } from "@dofek/training/late-workout-sleep";
import { useId, useState } from "react";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

interface LateWorkoutSleepCardProps {
  data?: LateWorkoutSleep;
  error?: { message: string } | null;
  isLoading?: boolean;
  isFetching?: boolean;
}

// Wake dates are calendar labels already resolved by the server.
const calendarDateOptions = { timeZone: "UTC" };

function NightEvidence({ night, timezone }: { night: LateWorkoutSleepNight; timezone: string }) {
  const clock = (value: string | null) =>
    value === null ? "Unavailable" : formatTimeOnly(value, { timeZone: timezone });
  const reference = night.habitualOnset;
  const load = night.load;
  const finishTiming = timingLabel(night.finishOffsetMinutes);
  const onsetTiming = timingLabel(night.actualOnsetOffsetMinutes);
  const maximumsByDate = new Map(load.maximums.map((maximum) => [maximum.date, maximum]));
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="font-semibold">
          Night ending {formatDateLong(night.date, calendarDateOptions)}
        </h5>
        <p className="capitalize">
          {load.category === null || load.score === null
            ? "Load unavailable"
            : `${load.category} · ${Number(load.score.toFixed(1))} points`}
        </p>
      </div>
      {night.reason && <p>{night.reason}</p>}
      {load.reason && load.reason !== night.reason && <p>{load.reason}</p>}
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-muted">Workout finished</dt>
          <dd>{clock(night.workoutFinish)}</dd>
          {finishTiming && <dd>{finishTiming}</dd>}
        </div>
        <div>
          <dt className="text-muted">Fell asleep</dt>
          <dd>{clock(night.actualOnset)}</dd>
          {onsetTiming && <dd>{onsetTiming}</dd>}
          {night.minutesFromFinishToSleep !== null && (
            <dd>{formatDurationMinutes(night.minutesFromFinishToSleep)} after workout</dd>
          )}
        </div>
        <div>
          <dt className="text-muted">Time asleep</dt>
          <dd>
            {night.durationMinutes === null
              ? (night.durationReason ?? "Unavailable")
              : formatDurationMinutes(night.durationMinutes)}
          </dd>
        </div>
      </dl>
      <p className="text-muted">
        Sleep record from {providerLabel(night.sleepProvider)} · Usual onset{" "}
        {clock(reference.timestamp)}
      </p>
      {reference.reason && <p>{reference.reason}</p>}
      <details className="space-y-2">
        <summary className="cursor-pointer py-2 font-medium">
          Source records and reference nights
        </summary>
        <p>
          Sleep records from {night.sourceProviders.map(providerLabel).join(", ")} ·{" "}
          {night.sourceSessionIds.join(", ")}
        </p>
        {night.workouts.map((workout) => (
          <p key={workout.id}>
            Workout {workout.id} · {workout.sourceProviders.map(providerLabel).join(", ")} ·{" "}
            {clock(workout.startedAt)} to {clock(workout.endedAt)}
            {workout.fitMemberId && ` · FIT record ${workout.fitMemberId}`}
            {workout.reason && ` · ${workout.reason}`}
          </p>
        ))}
        <p>
          {reference.observedCount} {reference.dayClass} reference nights · {reference.month} ·{" "}
          {reference.timezone}
        </p>
        <ul className="space-y-1">
          {reference.referenceNights.map((record) => (
            <li key={record.episodeId}>
              {formatDateShort(record.date, calendarDateOptions)} ·{" "}
              {providerLabel(record.sleepProvider)} · {record.episodeId}
            </li>
          ))}
          {reference.ambiguousReferenceDates.map((date) => (
            <li key={date}>
              {formatDateShort(date, calendarDateOptions)} · Multiple sleep records
            </li>
          ))}
        </ul>
        {load.coveredSeconds !== null && (
          <p>Heart-rate coverage: {formatDurationMinutes(load.coveredSeconds / 60)}</p>
        )}
        {Array.from(maximumsByDate.values(), (maximum) => (
          <p key={maximum.date}>
            Maximum heart rate on {formatDateShort(maximum.date, calendarDateOptions)} ·{" "}
            {maximum.bpm} bpm ·{" "}
            {maximum.basis === "profile" ? "Profile" : `Estimated from age ${maximum.age}`}
          </p>
        ))}
      </details>
    </div>
  );
}

export function LateWorkoutSleepCard({
  data,
  error,
  isLoading,
  isFetching,
}: LateWorkoutSleepCardProps) {
  const disclosureId = useId();
  const evidenceId = useId();
  const [expanded, setExpanded] = useState(false);
  const [episodeId, setEpisodeId] = useState<string>();
  const nights = [...(data?.nights ?? [])].sort((left, right) => {
    const matchedOrder = Number(right.status === "matched") - Number(left.status === "matched");
    return matchedOrder || right.date.localeCompare(left.date);
  });
  const nightsByDate = new Map<string, LateWorkoutSleepNight[]>();
  for (const night of nights) {
    const sameDate = nightsByDate.get(night.date);
    if (sameDate) sameDate.push(night);
    else nightsByDate.set(night.date, [night]);
  }
  const selected = nights.find((night) => night.episodeId === episodeId) ?? nights[0];
  return (
    <article className="space-y-3 rounded-xl border border-border bg-surface p-4 text-sm">
      <h3 className="text-base font-semibold">Late workouts &amp; sleep</h3>
      {error && <QueryStatePanel error={error} height={0} />}
      {!error && !data && isLoading && (
        <QueryStatePanel variant="loading" message="Loading late workout evidence." height={36} />
      )}
      {!error && isFetching && <output>Refreshing night evidence…</output>}
      {data && (
        <>
          <p className="text-muted">
            {data.range.startDate && data.range.endDate
              ? `${formatDateShort(data.range.startDate, calendarDateOptions)} – ${formatDateMedium(data.range.endDate, calendarDateOptions)} · `
              : null}
            {data.range.timezone}
          </p>
          {nights.length === 0 ? (
            <QueryStatePanel
              variant="empty"
              message="No nights with sleep evidence in this period."
              height={0}
            />
          ) : (
            <>
              <p>
                {data.matchedNightCount} matched {data.matchedNightCount === 1 ? "night" : "nights"}{" "}
                · {data.measuredLoadNightCount} with measured load
              </p>
              <button
                className="min-h-11 rounded-md border border-border px-3 font-medium"
                type="button"
                aria-expanded={expanded}
                aria-controls={disclosureId}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Hide nights" : "View nights"}
              </button>
              <div id={disclosureId} hidden={!expanded} className="space-y-3">
                {expanded && selected && (
                  <>
                    <h4 className="font-semibold">Compared with your usual sleep onset</h4>
                    <p className="flex flex-wrap gap-x-4 text-muted">
                      <span>
                        <span className="text-accent" aria-hidden="true">
                          ■{" "}
                        </span>
                        Workout finish
                      </span>
                      <span>
                        <span className="text-foreground" aria-hidden="true">
                          ●{" "}
                        </span>
                        Sleep onset
                      </span>
                      <span>
                        <span aria-hidden="true">│ </span>Usual onset
                      </span>
                    </p>
                    <div className="flex flex-wrap justify-between gap-2 text-xs text-muted">
                      <span>{formatDurationMinutes(Math.abs(data.axis.lowerMinutes))} earlier</span>
                      <span>{formatDurationMinutes(Math.abs(data.axis.upperMinutes))} later</span>
                    </div>
                    <fieldset
                      aria-label="Select a night"
                      className="min-w-0 max-h-96 space-y-1 overflow-y-auto p-1"
                    >
                      {nights.map((night) => {
                        const detail = sameDateNightLabel(
                          night,
                          nightsByDate.get(night.date),
                          data.range.timezone,
                          providerLabel,
                        );
                        const loadLabel =
                          night.status !== "matched"
                            ? "Context night"
                            : (night.load.category ?? "Load unavailable");
                        const label = [
                          formatDateLong(night.date, calendarDateOptions),
                          detail,
                          loadLabel,
                        ]
                          .filter(Boolean)
                          .join(", ");
                        return (
                          <button
                            key={night.episodeId}
                            type="button"
                            aria-label={label}
                            aria-pressed={night === selected}
                            aria-controls={evidenceId}
                            className="grid min-h-12 w-full grid-cols-[auto_1fr] items-center gap-x-3 rounded-md border border-border px-3 py-2 text-left aria-pressed:border-accent sm:grid-cols-[7rem_1fr_8rem]"
                            onClick={() => setEpisodeId(night.episodeId)}
                          >
                            <span>
                              <span className="block font-medium">
                                {formatDateShort(night.date, calendarDateOptions)}
                              </span>
                              {detail && <span className="block text-xs text-muted">{detail}</span>}
                            </span>
                            <span
                              className="relative order-last col-span-2 mx-2 my-2 block h-px bg-border sm:order-none sm:col-span-1"
                              aria-hidden="true"
                            >
                              <span
                                className="absolute top-0 h-4 w-px -translate-y-1/2 bg-muted"
                                style={{ left: `${data.axis.habitualPosition * 100}%` }}
                              />
                              {night.plot.workoutFinish !== null && (
                                <span
                                  className="absolute top-0 size-2 -translate-x-1/2 -translate-y-1/2 bg-accent"
                                  style={{ left: `${night.plot.workoutFinish * 100}%` }}
                                />
                              )}
                              {night.plot.actualOnset !== null && (
                                <span
                                  className="absolute top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-surface bg-foreground"
                                  style={{ left: `${night.plot.actualOnset * 100}%` }}
                                />
                              )}
                            </span>
                            <span className="justify-self-end capitalize">{loadLabel}</span>
                          </button>
                        );
                      })}
                    </fieldset>
                    <div id={evidenceId} aria-live="polite">
                      <NightEvidence
                        key={selected.episodeId}
                        night={selected}
                        timezone={data.range.timezone}
                      />
                    </div>
                    <aside className="space-y-1 border-t border-border pt-3">
                      <h4 className="font-semibold">Suggestion from the study</h4>
                      <p>
                        In a study of highly active adult WHOOP users, the authors suggested
                        finishing exercise at least four hours before sleep or choosing lighter
                        exercise close to bedtime.
                      </p>
                      <a className="underline" href="https://doi.org/10.1038/s41467-025-58271-x">
                        Leota et al., 2025
                      </a>
                    </aside>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </article>
  );
}

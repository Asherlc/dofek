import {
  formatClimbingHoldTypes,
  formatClimbingLocationPath,
} from "@dofek/format/climbing-context";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
  formatClimbingProjectDay,
  formatClimbingProjectHistory,
} from "@dofek/format/climbing-log";
import { formatDateMedium } from "@dofek/format/format";
import { providerLabel } from "@dofek/providers/providers";
import { climbingLogEntryAreaPath, climbingLogEntryName } from "@dofek/training/climbing-log";
import type { ClimbingProjectHistoryState } from "@dofek/training/climbing-project-history";
import { climbingTagGroups } from "@dofek/training/climbing-tag-presentation";
import type { ClimbingLogEntryDetail } from "../../../server/src/contracts/climbing-log-contracts.ts";
import { ClimbingLogEntryContext } from "../pages/activity-detail/components/ClimbingLogEntryContext.tsx";
import { ClimbingLogEntrySources } from "../pages/activity-detail/components/ClimbingLogEntrySources.tsx";

import { ClimbingCatalogueContext } from "./ClimbingCatalogueContext";
import { ClimbingPhotos } from "./ClimbingPhotos";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

function Fields({ values }: { values: Array<{ label: string; value: string }> }) {
  if (values.length === 0) return null;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[minmax(8rem,1fr)_2fr]">
      {values.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="text-subtle">{label}</dt>
          <dd className="break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProjectHistory({ data, error, isLoading }: ClimbingProjectHistoryState) {
  if (!data && !error && !isLoading) return null;
  const copy = data ? formatClimbingProjectHistory(data) : null;
  return (
    <section aria-label="Project history" className="space-y-2 rounded-lg border border-border p-3">
      <h4 className="font-medium">Project history</h4>
      {error && <QueryStatePanel error={error} height={0} />}
      {isLoading && !data && (
        <p role="status" className="text-xs text-subtle">
          Loading project history…
        </p>
      )}
      {copy && (
        <>
          <p className="font-semibold">{copy.summary}</p>
          <p className="text-xs text-subtle">{copy.detail}</p>
          {copy.methodDetail && <p className="text-xs text-subtle">{copy.methodDetail}</p>}
        </>
      )}
      {data && (
        <details>
          <summary className="min-h-11 w-fit content-center text-accent">View sessions</summary>
          <ul className="divide-y divide-border text-xs">
            {data.days.map((day) => (
              <li key={day.date} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
                <time dateTime={day.date} className="text-subtle">
                  {formatDateMedium(day.date, { timeZone: "UTC" })}
                </time>
                <span>{formatClimbingProjectDay(day)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function ClimbingLogEntryDetails({
  entry,
  projectHistory,
}: {
  entry: ClimbingLogEntryDetail;
  projectHistory?: ClimbingProjectHistoryState;
}) {
  const climb = entry.climb;
  const path = formatClimbingLocationPath(climbingLogEntryAreaPath(entry));
  const holds = formatClimbingHoldTypes(entry.holdTypes);
  const tagGroups = climbingTagGroups(entry.tags ?? [], entry.holdTypes);
  const gradedPitches = climb?.pitches.filter((pitch) => pitch.publishedGrades.length > 0) ?? [];
  return (
    <section className="space-y-4 text-sm" aria-label="Climbing log details">
      <ClimbingLogEntrySources
        climbKind={climb?.kind ?? null}
        name={climbingLogEntryName(entry)}
        sourceName={entry.sourceName}
        providerId={entry.providerId}
        links={entry.sourceLinks}
      />
      <Fields
        values={[
          ...(entry.climbedOn && !entry.chartAnnotations?.length
            ? [{ label: "Date", value: entry.climbedOn }]
            : []),
          ...(entry.discipline
            ? [{ label: "Discipline", value: entry.discipline.replaceAll("_", " ") }]
            : []),
        ]}
      />
      {path && <p className="text-xs text-subtle">{path}</p>}
      <ClimbingLogEntryContext entry={entry} />
      {holds && <p className="text-xs">{holds}</p>}
      {tagGroups.map((group) => (
        <section key={group.key}>
          <h4 className="font-medium">
            {providerLabel(group.providerId)} · {group.categoryLabel}
          </h4>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {group.tags.map((tag) => (
              <li key={tag.sourceKey}>{tag.label}</li>
            ))}
          </ul>
        </section>
      ))}
      {climb && (
        <>
          <Fields
            values={[
              ...(climb.kind ? [{ label: "Type", value: climb.kind }] : []),
              ...(climb.setting ? [{ label: "Setting", value: climb.setting }] : []),
              ...(climb.routeProtection?.length
                ? [{ label: "Protection", value: climb.routeProtection.join(", ") }]
                : []),
            ]}
          />
          {climb.publishedGrades.length > 0 && (
            <section>
              <h4 className="font-medium">Grades</h4>
              <p className="text-xs">{formatClimbingGradeComponents(climb.publishedGrades)}</p>
            </section>
          )}
          {gradedPitches.length > 0 && (
            <section>
              <h4 className="font-medium">Pitch grades</h4>
              <ul className="space-y-2 text-xs">
                {gradedPitches.map((pitch) => (
                  <li key={pitch.id}>
                    <p>
                      {pitch.number === null ? "Pitch" : `Pitch ${pitch.number}`}
                      {pitch.name === null ? "" : ` · ${pitch.name}`}
                    </p>
                    <p>{formatClimbingGradeComponents(pitch.publishedGrades)}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {entry.reportedGrades.length > 0 && (
        <section>
          <h4 className="font-medium">Reported grades</h4>
          <p className="text-xs">{formatClimbingGradeComponents(entry.reportedGrades)}</p>
        </section>
      )}
      {projectHistory && <ProjectHistory key={entry.id} {...projectHistory} />}
      {entry.attempts.length > 0 && (
        <section className="space-y-3">
          <h4 className="font-medium">
            {entry.recordedClimbAttemptCount === null
              ? "Recorded result"
              : entry.recordedClimbAttemptCount > 0
                ? `Attempts: ${entry.recordedClimbAttemptCount}`
                : "Attempts"}
          </h4>
          {entry.attempts.map((attempt) => {
            const pitch = climb?.pitches.find((candidate) => candidate.id === attempt.pitchId);
            const name =
              pitch?.name ??
              (pitch?.number != null
                ? `Pitch ${pitch.number}`
                : attempt.scope === "pitch"
                  ? "Pitch attempt"
                  : entry.recordedClimbAttemptCount === null && attempt.attemptIndex === null
                    ? "Climb"
                    : attempt.attemptIndex === null
                      ? "Attempt (order unknown)"
                      : `Attempt ${attempt.attemptIndex}`);
            return (
              <div key={attempt.id} className="space-y-2 rounded border border-border p-3">
                <h5 className="text-xs font-medium">
                  {name}
                  {attempt.scope === "pitch" && attempt.attemptIndex !== null
                    ? ` · Attempt ${attempt.attemptIndex}`
                    : ""}
                </h5>
                {attempt.rockResultLabels.length > 0 && (
                  <p className="text-xs text-green-500">{attempt.rockResultLabels.join(" · ")}</p>
                )}
                <Fields values={climbingAttemptDetailFields(attempt)} />
                {attempt.notes && <p className="whitespace-pre-wrap text-xs">{attempt.notes}</p>}
              </div>
            );
          })}
        </section>
      )}
      <ClimbingCatalogueContext id={entry.id} />
      {entry.photoLogEntryId !== null && <ClimbingPhotos id={entry.photoLogEntryId} />}
      {entry.notes && (
        <section>
          <h4 className="font-medium">Notes</h4>
          <p className="whitespace-pre-wrap text-xs">{entry.notes}</p>
        </section>
      )}
    </section>
  );
}

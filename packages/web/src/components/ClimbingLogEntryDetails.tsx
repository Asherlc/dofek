import {
  formatClimbingLocationPath,
  formatClimbingWallAngle,
} from "@dofek/format/climbing-context";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
} from "@dofek/format/climbing-log";
import type { ClimbingLogEntryDetail } from "../../../server/src/contracts/climbing-log-contracts.ts";
import { ClimbingLogEntrySources } from "../pages/activity-detail/components/ClimbingLogEntrySources.tsx";

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

export function ClimbingLogEntryDetails({ entry }: { entry: ClimbingLogEntryDetail }) {
  const climb = entry.climb;
  const path = formatClimbingLocationPath(climb?.areaPath ?? []);
  const angle = formatClimbingWallAngle(entry.wallAngle);
  const gradedPitches = climb?.pitches.filter((pitch) => pitch.publishedGrades.length > 0) ?? [];
  return (
    <section className="space-y-4 text-sm" aria-label="Climbing log details">
      <ClimbingLogEntrySources
        name={climb?.name ?? entry.title ?? "Climbing log"}
        sourceName={entry.sourceName}
        links={entry.sourceLinks}
      />
      <Fields
        values={[
          ...(entry.climbedOn ? [{ label: "Date", value: entry.climbedOn }] : []),
          ...(entry.discipline
            ? [{ label: "Discipline", value: entry.discipline.replaceAll("_", " ") }]
            : []),
        ]}
      />
      {path && <p className="text-xs text-subtle">{path}</p>}
      {entry.board && <p className="text-xs">Board: {entry.board.name}</p>}
      {angle && <p className="text-xs">{angle}</p>}
      {entry.holdType && <p className="text-xs">Hold type: {entry.holdType}</p>}
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
      {entry.attempts.length > 0 && (
        <section className="space-y-3">
          <h4 className="font-medium">
            {entry.recordedClimbAttemptCount === null ? "Recorded result" : "Attempts"}
          </h4>
          {entry.attempts.map((attempt, index) => {
            const pitch = climb?.pitches.find((candidate) => candidate.id === attempt.pitchId);
            const name =
              pitch?.name ??
              (pitch?.number != null
                ? `Pitch ${pitch.number}`
                : attempt.scope === "pitch"
                  ? "Pitch attempt"
                  : entry.recordedClimbAttemptCount === null
                    ? "Climb"
                    : `Attempt ${attempt.attemptIndex ?? index + 1}`);
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
      {entry.notes && (
        <section>
          <h4 className="font-medium">Notes</h4>
          <p className="whitespace-pre-wrap text-xs">{entry.notes}</p>
        </section>
      )}
    </section>
  );
}

import {
  formatClimbingLocationPath,
  formatClimbingWallAngle,
} from "@dofek/format/climbing-context";
import {
  climbingAttemptDetailFields,
  formatClimbingGradeComponents,
  formatGpsCoordinates,
} from "@dofek/format/climbing-log";
import type { ClimbingLogEntryDetail } from "../../../server/src/contracts/climbing-log-contracts.ts";

function Fields({ values }: { values: Array<{ label: string; value: string }> }) {
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
  return (
    <section className="space-y-4 text-sm" aria-label="Climbing log details">
      <Fields
        values={[
          { label: "Date", value: entry.climbedOn ?? "Date unknown" },
          { label: "Discipline", value: entry.discipline?.replaceAll("_", " ") ?? "Unknown" },
          ...(entry.title === null ? [] : [{ label: "Log title", value: entry.title }]),
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
              { label: "Climb kind", value: climb.kind ?? "Unknown" },
              { label: "Setting", value: climb.setting ?? "Unknown" },
              { label: "Route protection", value: climb.routeProtection?.join(", ") ?? "Unknown" },
              ...(climb.coordinates === null
                ? []
                : [{ label: "Climb coordinates", value: formatGpsCoordinates(climb.coordinates) }]),
              ...climb.areaPath.flatMap((area) =>
                area.coordinates === null
                  ? []
                  : [
                      {
                        label: `${area.name} coordinates`,
                        value: formatGpsCoordinates(area.coordinates),
                      },
                    ],
              ),
            ]}
          />
          <section>
            <h4 className="font-medium">Published climb grades</h4>
            <p className="text-xs">
              {formatClimbingGradeComponents(climb.publishedGrades) || "None recorded"}
            </p>
          </section>
          {climb.pitches.length > 0 && (
            <section>
              <h4 className="font-medium">Published pitch grades</h4>
              <ul className="space-y-2 text-xs">
                {climb.pitches.map((pitch) => (
                  <li key={pitch.id}>
                    <p>
                      {pitch.number === null ? "Pitch number unknown" : `Pitch ${pitch.number}`}
                      {pitch.name === null ? "" : ` · ${pitch.name}`}
                    </p>
                    <p>{formatClimbingGradeComponents(pitch.publishedGrades) || "None recorded"}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <section>
        <h4 className="font-medium">Reported grades</h4>
        <p className="text-xs">
          {formatClimbingGradeComponents(entry.reportedGrades) || "None recorded"}
        </p>
      </section>
      <section className="space-y-3">
        <h4 className="font-medium">Recorded attempts</h4>
        {entry.attempts.map((attempt) => (
          <div key={attempt.id} className="space-y-2 rounded border border-border p-3">
            <p className="text-xs font-medium">
              {attempt.scope === "pitch" ? "Pitch attempt" : "Whole-climb attempt"}
              {attempt.attemptIndex === null ? "" : ` · Order ${attempt.attemptIndex}`}
            </p>
            {attempt.rockResultLabels.length > 0 && (
              <p className="text-xs text-green-500">{attempt.rockResultLabels.join(" · ")}</p>
            )}
            <Fields values={climbingAttemptDetailFields(attempt)} />
            {attempt.notes && <p className="whitespace-pre-wrap text-xs">{attempt.notes}</p>}
          </div>
        ))}
      </section>
      {entry.notes && (
        <section>
          <h4 className="font-medium">Notes</h4>
          <p className="whitespace-pre-wrap text-xs">{entry.notes}</p>
        </section>
      )}
      <details>
        <summary className="cursor-pointer text-xs font-medium">Source record</summary>
        <div className="mt-2">
          <Fields
            values={[
              { label: "Log identifier", value: entry.id },
              { label: "Provider", value: entry.providerId },
              { label: "Source identifier", value: entry.externalId ?? "Unknown" },
              { label: "Activity reference", value: entry.activityId ?? "Unattached" },
              { label: "Climb reference", value: entry.climbId ?? "Unidentified" },
              { label: "Provider absence", value: entry.providerAbsentAt ?? "Not reported absent" },
            ]}
          />
        </div>
      </details>
      {entry.raw !== null && (
        <details>
          <summary className="cursor-pointer text-xs font-medium">Raw provider data</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-page p-3 text-xs">
            {JSON.stringify(entry.raw, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}

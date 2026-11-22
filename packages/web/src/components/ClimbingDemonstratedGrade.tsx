import { formatDateMedium, formatDateShort } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import type {
  ClimbingDemonstratedGrade as ClimbingDemonstratedGradeData,
  DemonstratedGradeCell,
  DemonstratedGradeSend,
} from "@dofek/training/climbing-demonstrated-grade";
import { gradeSystemLabel } from "@dofek/training/climbing-grades";
import { useId, useState } from "react";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const TYPES = [
  { key: "bouldering", label: "Bouldering", spoken: "bouldering" },
  { key: "lead", label: "Lead", spoken: "lead" },
  { key: "top_rope", label: "Top rope", spoken: "top rope" },
  { key: "unroped", label: "Unroped", spoken: "unroped" },
] as const;
const SETTINGS = [
  { key: "indoor", label: "Indoor", spoken: "indoor" },
  { key: "outdoor", label: "Outdoor", spoken: "outdoor" },
] as const;

type CellKey = `${(typeof TYPES)[number]["key"]}-${(typeof SETTINGS)[number]["key"]}`;

function cellKey<T extends string, S extends string>(type: T, setting: S): `${T}-${S}` {
  return `${type}-${setting}`;
}

function gradeCell(cells: readonly DemonstratedGradeCell[], key: CellKey) {
  const [type, setting] = key.split("-");
  return cells.find((cell) => cell.type === type && cell.setting === setting);
}

function firstAvailableKey(data: ClimbingDemonstratedGradeData | null | undefined): CellKey | null {
  if (!data) return null;
  for (const type of TYPES) {
    for (const setting of SETTINGS) {
      const key = cellKey(type.key, setting.key);
      if ((gradeCell(data.cells, key)?.grades.length ?? 0) > 0) return key;
    }
  }
  return null;
}

function methodLabel(method: DemonstratedGradeSend["ropeMethod"]): string | null {
  if (method === "follow") return "Follow";
  if (method === "top_rope") return "Top rope";
  if (method === "lead") return "Lead";
  if (method === "unroped") return "Unroped";
  return null;
}

function ascentStyleLabel(send: DemonstratedGradeSend, includeMethod: boolean): string {
  const method = includeMethod ? methodLabel(send.ropeMethod) : null;
  if (send.ascentStyle && method) return `${send.ascentStyle} · ${method}`;
  if (send.ascentStyle) return send.ascentStyle;
  if (method) return method;
  return "Ascent style unknown";
}

export function ClimbingDemonstratedGrade({
  data,
  loading = false,
  error = null,
}: {
  data?: ClimbingDemonstratedGradeData | null;
  loading?: boolean;
  error?: { message: string } | null;
}) {
  const headingId = useId();
  const keyId = useId();
  // `undefined` means "no choice yet"; `null` means the reader closed every panel.
  const [chosenKey, setChosenKey] = useState<CellKey | null | undefined>(undefined);
  const openKey =
    chosenKey === null
      ? null
      : chosenKey !== undefined && (gradeCell(data?.cells ?? [], chosenKey)?.grades.length ?? 0) > 0
        ? chosenKey
        : firstAvailableKey(data);

  if (loading && !data) {
    return <QueryStatePanel variant="loading" contextLabel="demonstrated grades" height={120} />;
  }
  if (error && !data) {
    return (
      <QueryStatePanel
        variant="error"
        error={error}
        contextLabel="Demonstrated grades"
        message={userFacingErrorMessage(error, "Demonstrated grades could not be loaded.")}
        height={120}
      />
    );
  }
  if (!data) {
    return (
      <QueryStatePanel
        variant="empty"
        message="No demonstrated grades in this period."
        height={120}
      />
    );
  }

  const bounded =
    !data.coverage.fullWindow && data.coverage.startDate && data.coverage.endDate
      ? { start: data.coverage.startDate, end: data.coverage.endDate }
      : { start: data.startDate, end: data.endDate };
  const windowLabel = `${formatDateShort(bounded.start)} – ${formatDateMedium(bounded.end)}`;
  const qualifier = data.coverage.fullWindow
    ? null
    : data.coverage.startDate && data.coverage.endDate
      ? "Limited to the climbing history available to your account."
      : "No climbing history is available to your account for this period.";
  const countWord = data.minimumDistinctClimbs === 3 ? "three" : String(data.minimumDistinctClimbs);
  const hasAnyGrade = data.cells.some((cell) => cell.grades.length > 0);

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 id={headingId} className="text-base font-semibold text-foreground">
          Demonstrated grade
        </h3>
        <p className="text-xs text-muted tabular-nums">{windowLabel}</p>
      </div>
      <p className="mt-1 text-sm text-muted">
        Highest published grade sent on {countWord} different climbs in the past three months.
      </p>
      {qualifier ? <p className="mt-1 text-xs text-muted">{qualifier}</p> : null}
      {error ? (
        <QueryStatePanel
          variant="error"
          error={error}
          contextLabel="Demonstrated grades"
          message={userFacingErrorMessage(error, "Demonstrated grades could not be loaded.")}
          height={0}
        />
      ) : null}
      {!hasAnyGrade ? (
        <QueryStatePanel
          variant="empty"
          message="No demonstrated grades in this period."
          height={0}
        />
      ) : null}

      <table
        aria-label="Demonstrated grade matrix"
        aria-describedby={keyId}
        className="mt-3 w-full table-fixed border-collapse text-center text-sm"
      >
        <thead>
          <tr className="border-b border-border text-xs text-muted">
            <th scope="col" className="w-[42%] py-1 text-left font-medium">
              Climbing type
            </th>
            {SETTINGS.map((setting) => (
              <th key={setting.key} scope="col" className="py-1 font-medium">
                {setting.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TYPES.map((type) => (
            <tr key={type.key} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-1 text-left font-medium">
                {type.label}
              </th>
              {SETTINGS.map((setting) => {
                const key = cellKey(type.key, setting.key);
                const grade = gradeCell(data.cells, key)?.grades[0];
                if (!grade) {
                  return (
                    <td key={setting.key} className="py-1 text-muted">
                      —
                    </td>
                  );
                }
                const expanded = openKey === key;
                return (
                  <td key={setting.key} className="py-1">
                    <button
                      type="button"
                      aria-label={`${setting.label} ${type.spoken}, ${grade.grade}, ${grade.count} climbs`}
                      aria-expanded={expanded}
                      aria-controls={`${keyId}-${key}`}
                      onClick={() => setChosenKey(expanded ? null : key)}
                      className={`inline-flex min-h-7 min-w-14 items-center justify-center gap-1 rounded px-1.5 font-semibold tabular-nums ${
                        expanded ? "border border-border bg-accent/10 text-accent" : "text-accent"
                      }`}
                    >
                      {grade.grade}
                      <span aria-hidden="true" className="text-xs leading-none">
                        {expanded ? "⌃" : "⌄"}
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p id={keyId} className="sr-only">
        A dash means insufficient evidence for a demonstrated grade.
      </p>

      {TYPES.flatMap((type) =>
        SETTINGS.map((setting) => {
          const key = cellKey(type.key, setting.key);
          const grade = gradeCell(data.cells, key)?.grades[0];
          if (!grade) return null;
          const label = `${setting.label} ${type.spoken} · ${grade.grade} · ${gradeSystemLabel(grade.gradeSystem)}${
            grade.publishedLabel ? ` · ${grade.publishedLabel}` : ""
          }`;
          return (
            <section
              key={key}
              id={`${keyId}-${key}`}
              aria-label={label}
              hidden={openKey !== key}
              className="mt-3 rounded-md bg-accent/5 p-3"
            >
              <h4 className="text-sm font-medium text-foreground">{label}</h4>
              <ul className="mt-1 divide-y divide-border">
                {grade.sends.map((send) => {
                  const style = ascentStyleLabel(send, type.key === "top_rope");
                  return (
                    <li
                      key={`${send.climbExternalId ?? send.logEntryId ?? ""}-${send.climbedOn}-${send.displayName ?? ""}`}
                      className="flex items-baseline justify-between gap-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0">
                        {send.activityId ? (
                          <a
                            href={`/activity/${encodeURIComponent(send.activityId)}`}
                            className="font-medium text-accent hover:underline"
                          >
                            {send.displayName ?? "Unnamed climb"}
                          </a>
                        ) : (
                          <span className="font-medium">{send.displayName ?? "Unnamed climb"}</span>
                        )}
                        <small className="block text-xs text-muted">
                          <span>{style}</span> ·{" "}
                          {send.sourceUrl ? (
                            <a
                              href={send.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent hover:underline"
                            >
                              {send.provider}
                            </a>
                          ) : (
                            send.provider
                          )}
                        </small>
                      </span>
                      <time
                        dateTime={send.climbedOn}
                        className="shrink-0 text-xs text-muted tabular-nums"
                      >
                        {formatDateShort(send.climbedOn)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        }),
      )}

      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer font-medium">How 3:3:3 works</summary>
        <p className="mt-1 leading-relaxed">
          Dofek’s adaptation of IRCRA 3:3:3 counts any confirmed free send, including an onsight,
          flash, redpoint, or send with an unspecified ascent style. Each climb counts once. Top
          rope includes climbs recorded as Follow.
        </p>
      </details>
    </section>
  );
}

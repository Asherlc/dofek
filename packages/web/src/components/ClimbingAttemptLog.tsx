import {
  type ClimbingGradePreference,
  type ClimbingGradeSystem,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  gradeOptionsForSystem,
  gradeSystemLabel,
} from "@dofek/training/climbing-grades";
import { useState } from "react";
import { z } from "zod";

const attemptOutcomeSchema = z.enum(["sent", "failed"]);
const climbTypeSchema = z.enum(["boulder", "route"]);
const failureReasonSchema = z.enum(["fell", "pumped", "skin", "technique", "fear"]);
const holdTypeSchema = z.enum(["crimp", "sloper", "pinch", "pocket", "jug"]);
type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;
type FailureReason = z.infer<typeof failureReasonSchema>;
type HoldType = z.infer<typeof holdTypeSchema>;

interface AttemptDraft {
  failureReason: FailureReason | null;
  id: number;
  notes: string;
  outcome: AttemptOutcome;
}

export interface ClimbingSessionSubmission {
  climbs: Array<{
    attempts: Array<{
      failureReason: FailureReason | null;
      notes: string | null;
      outcome: AttemptOutcome;
    }>;
    climbType: "boulder" | "route";
    grade: string;
    gradeSystem: ClimbingGradeSystem;
    holdType: HoldType | null;
    routeName: string | null;
    wallAngleDegrees: number | null;
  }>;
  endedAt: string | null;
  locationName: string | null;
  startedAt: string;
}

export function ClimbingAttemptLog({
  errorMessage,
  gradePreference = DEFAULT_CLIMBING_GRADE_PREFERENCE,
  onSubmit,
  submitting,
}: {
  errorMessage: string | null;
  gradePreference?: ClimbingGradePreference;
  onSubmit: (input: ClimbingSessionSubmission) => void;
  submitting: boolean;
}) {
  const [climbType, setClimbType] = useState<"boulder" | "route">("boulder");
  const [grade, setGrade] = useState("");
  const [wallAngleDegrees, setWallAngleDegrees] = useState<number | null>(0);
  const [holdType, setHoldType] = useState<HoldType>("crimp");
  const [routeName, setRouteName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [attempts, setAttempts] = useState<AttemptDraft[]>([
    { failureReason: "fell", id: 1, notes: "", outcome: "failed" },
  ]);

  function updateAttempt(attemptIndex: number, patch: Partial<AttemptDraft>): void {
    setAttempts((current) =>
      current.map((attempt, index) =>
        index === attemptIndex ? { ...attempt, ...patch } : attempt,
      ),
    );
  }

  const gradeSystem = gradePreference[climbType];
  const grades = gradeOptionsForSystem(gradeSystem);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          climbs: [
            {
              attempts: attempts.map((attempt) => ({
                failureReason: attempt.outcome === "sent" ? null : attempt.failureReason,
                notes: attempt.notes.trim() || null,
                outcome: attempt.outcome,
              })),
              climbType,
              grade,
              gradeSystem,
              holdType,
              routeName: routeName.trim() || null,
              wallAngleDegrees,
            },
          ],
          endedAt: null,
          locationName: locationName.trim() || null,
          startedAt: new Date().toISOString(),
        });
      }}
    >
      <p className="text-sm text-muted">
        Record each attempt so outcomes and failure reasons remain available for review.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="Climb type">
          <select
            aria-label="Climb type"
            className="input"
            onChange={(event) => {
              setClimbType(climbTypeSchema.parse(event.target.value));
              setGrade("");
            }}
            value={climbType}
          >
            <option value="boulder">Boulder</option>
            <option value="route">Route</option>
          </select>
        </Field>
        <Field label={`Grade (${gradeSystemLabel(gradeSystem)})`}>
          <select
            aria-label="Grade"
            className="input"
            onChange={(event) => setGrade(event.target.value)}
            required
            value={grade}
          >
            <option value="">Select grade</option>
            {grades.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Wall angle (degrees; positive is overhang)">
          <input
            aria-label="Wall angle (degrees; positive is overhang)"
            className="input"
            max={90}
            min={-90}
            onChange={(event) => {
              const nextWallAngleDegrees = event.target.valueAsNumber;
              setWallAngleDegrees(Number.isNaN(nextWallAngleDegrees) ? null : nextWallAngleDegrees);
            }}
            type="number"
            value={wallAngleDegrees ?? ""}
          />
        </Field>
        <Field label="Primary hold type">
          <select
            aria-label="Primary hold type"
            className="input"
            onChange={(event) => setHoldType(holdTypeSchema.parse(event.target.value))}
            value={holdType}
          >
            {["crimp", "sloper", "pinch", "pocket", "jug"].map((value) => (
              <option key={value} value={value}>
                {value[0]?.toUpperCase()}
                {value.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Route or problem name">
          <input
            aria-label="Route or problem name"
            className="input"
            onChange={(event) => setRouteName(event.target.value)}
            value={routeName}
          />
        </Field>
        <Field label="Location">
          <input
            aria-label="Location"
            className="input"
            onChange={(event) => setLocationName(event.target.value)}
            value={locationName}
          />
        </Field>
      </div>
      <div className="space-y-3">
        {attempts.map((attempt, attemptIndex) => (
          <div className="grid grid-cols-2 gap-3 rounded border border-border p-3" key={attempt.id}>
            <Field label={`Attempt ${attemptIndex + 1} outcome`}>
              <select
                aria-label={`Attempt ${attemptIndex + 1} outcome`}
                className="input"
                onChange={(event) => {
                  const outcome = attemptOutcomeSchema.parse(event.target.value);
                  updateAttempt(attemptIndex, {
                    failureReason: outcome === "sent" ? null : (attempt.failureReason ?? "fell"),
                    outcome,
                  });
                }}
                value={attempt.outcome}
              >
                <option value="failed">Failed</option>
                <option value="sent">Sent</option>
              </select>
            </Field>
            <Field label={`Attempt ${attemptIndex + 1} failure reason`}>
              <select
                aria-label={`Attempt ${attemptIndex + 1} failure reason`}
                className="input"
                disabled={attempt.outcome === "sent"}
                onChange={(event) =>
                  updateAttempt(attemptIndex, {
                    failureReason: failureReasonSchema.parse(event.target.value),
                  })
                }
                value={attempt.failureReason ?? ""}
              >
                {["fell", "pumped", "skin", "technique", "fear"].map((value) => (
                  <option key={value} value={value}>
                    {value[0]?.toUpperCase()}
                    {value.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ))}
      </div>
      <button
        aria-label="Add climbing attempt"
        className="rounded border border-border px-3 py-2 text-xs"
        onClick={() =>
          setAttempts((current) => [
            ...current,
            { failureReason: "fell", id: current.length + 1, notes: "", outcome: "failed" },
          ])
        }
        type="button"
      >
        Add attempt
      </button>
      {errorMessage ? (
        <p className="text-sm text-red-400" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button
        aria-label="Save climbing session"
        className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
        disabled={submitting}
        type="submit"
      >
        {submitting ? "Saving…" : "Save climbing session"}
      </button>
    </form>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <span>{label}</span>
      {children}
    </div>
  );
}

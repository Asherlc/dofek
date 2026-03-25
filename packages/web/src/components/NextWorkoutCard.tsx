import { chartColors, statusColors } from "@dofek/scoring/colors";
import { readinessLevelColor } from "@dofek/scoring/scoring";
import type { NextWorkoutRecommendation } from "dofek-server/types";
import { useEffect, useState } from "react";
import { isToday } from "../lib/format.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface NextWorkoutCardProps {
  data: NextWorkoutRecommendation | undefined;
  loading?: boolean;
}

function typeColor(type: NextWorkoutRecommendation["recommendationType"]): string {
  if (type === "rest") return chartColors.amber;
  if (type === "strength") return statusColors.positive;
  return statusColors.info;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export function NextWorkoutCard({ data, loading }: NextWorkoutCardProps) {
  const [open, setOpen] = useState(false);

  if (loading) {
    return <ChartLoadingSkeleton height={260} />;
  }

  if (!data || !isToday(new Date(data.generatedAt))) {
    return (
      <div className="card p-6 flex items-center justify-center h-[260px]">
        <span className="text-dim text-sm">Not enough data for a workout recommendation</span>
      </div>
    );
  }

  const recColor = typeColor(data.recommendationType);
  const readColor = readinessLevelColor(data.readiness.level);

  return (
    <>
      <div className="card p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-muted text-sm font-medium mb-1">Today&apos;s Recommendation</h3>
            <p className="text-2xl font-semibold text-foreground">{data.title}</p>
          </div>
          <span
            className="px-2.5 py-1 rounded-full text-xs font-medium"
            style={{ backgroundColor: `${recColor}1f`, color: recColor }}
          >
            {capitalize(data.recommendationType)}
          </span>
        </div>

        <p className="text-sm text-foreground leading-relaxed">{data.shortBlurb}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className="px-2 py-1 rounded text-xs"
            style={{ backgroundColor: `${readColor}1f`, color: readColor }}
          >
            Readiness:{" "}
            {data.readiness.score != null
              ? `${data.readiness.score}/100 (${data.readiness.level})`
              : "Unknown"}
          </span>
          {data.cardio && (
            <span className="px-2 py-1 rounded text-xs bg-accent/10 text-foreground">
              Cardio: {data.cardio.focus.toUpperCase()} for {data.cardio.durationMinutes} min
            </span>
          )}
          {data.strength && data.strength.focusMuscles.length > 0 && (
            <span className="px-2 py-1 rounded text-xs bg-accent/10 text-foreground">
              Focus: {data.strength.focusMuscles.join(", ")}
            </span>
          )}
        </div>

        <div className="mt-5">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center rounded-lg bg-accent/10 hover:bg-surface-hover px-3 py-1.5 text-xs text-foreground transition-colors"
          >
            View Detailed Plan
          </button>
        </div>
      </div>

      {open && <NextWorkoutModal data={data} onClose={() => setOpen(false)} />}
    </>
  );
}

function NextWorkoutModal({
  data,
  onClose,
}: {
  data: NextWorkoutRecommendation;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close recommendation details"
      />

      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{data.title}</h2>
            <p className="text-xs text-subtle mt-1">
              Generated{" "}
              {new Date(data.generatedAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-subtle hover:text-foreground transition-colors"
            aria-label="Close modal"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-5 h-5"
            >
              <title>Close</title>
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <section>
            <h3 className="text-xs font-medium text-subtle uppercase mb-2">Plan</h3>
            <ul className="space-y-2">
              {data.details.map((item) => (
                <li key={item} className="text-sm text-foreground">
                  • {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-medium text-subtle uppercase mb-2">Why This</h3>
            <ul className="space-y-2">
              {data.rationale.map((item) => (
                <li key={item} className="text-sm text-foreground">
                  • {item}
                </li>
              ))}
            </ul>
          </section>

          {data.strength && (
            <section className="rounded-lg border border-border bg-surface-solid/60 p-3">
              <h3 className="text-xs font-medium text-subtle uppercase mb-2">Strength Detail</h3>
              <p className="text-sm text-foreground">{data.strength.split}</p>
              <p className="text-xs text-muted mt-1">Target volume: {data.strength.targetSets}</p>
              {data.strength.focusMuscles.length > 0 && (
                <p className="text-xs text-muted mt-1">
                  Priority muscles: {data.strength.focusMuscles.join(", ")}
                </p>
              )}
            </section>
          )}

          {data.cardio && (
            <section className="rounded-lg border border-border bg-surface-solid/60 p-3">
              <h3 className="text-xs font-medium text-subtle uppercase mb-2">Cardio Detail</h3>
              <p className="text-sm text-foreground">{data.cardio.structure}</p>
              <p className="text-xs text-muted mt-1">
                Target zones: {data.cardio.targetZones.join(", ")}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

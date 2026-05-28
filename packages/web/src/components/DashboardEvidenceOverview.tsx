import type { ReactNode } from "react";
import type { Insight } from "./CorrelationCard.tsx";

export interface DashboardTrendSnapshot {
  latestRestingHeartRate: number | null | undefined;
  averageRestingHeartRate: number | null | undefined;
}

export function formatDashboardRange(endDate: string, days: number): string {
  const end = new Date(`${endDate}T12:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - days + 1);
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

export function correlationStrengthLabel(effectSize: number | null | undefined): string {
  if (effectSize == null) return "Collecting signal";
  const direction = effectSize >= 0 ? "positive" : "negative";
  const magnitude = Math.abs(effectSize);
  if (magnitude >= 0.6) return `Strong ${direction}`;
  if (magnitude >= 0.35) return `Emerging ${direction}`;
  return `Early ${direction}`;
}

export function trendPositionLabel(trend: DashboardTrendSnapshot): string {
  const { latestRestingHeartRate, averageRestingHeartRate } = trend;
  if (latestRestingHeartRate == null || averageRestingHeartRate == null) {
    return "Waiting for baseline";
  }
  if (latestRestingHeartRate < averageRestingHeartRate) return "below average";
  if (latestRestingHeartRate > averageRestingHeartRate) return "above average";
  return "at average";
}

export function DashboardEvidenceOverview({
  days,
  endDate,
  topInsight,
  insightError,
  trend,
  healthMonitor,
}: {
  days: number;
  endDate: string;
  topInsight?: Insight;
  insightError?: ReactNode;
  trend: DashboardTrendSnapshot;
  healthMonitor: ReactNode;
}) {
  const effectSize = topInsight?.effectSize;
  const correlationValue = effectSize == null ? "--" : Math.abs(effectSize).toFixed(2);
  const trendLabel = trendPositionLabel(trend);

  return (
    <section
      aria-label="Dashboard overview"
      className="dashboard-hero card p-5 sm:p-6 lg:min-h-[calc(100vh-4rem)]"
    >
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Overview</h2>
          <p className="mt-1 text-sm text-muted">{formatDashboardRange(endDate, days)}</p>
        </div>
        <span className="w-fit rounded-md border border-border bg-surface-solid px-3 py-1.5 text-xs font-medium text-foreground">
          {days} days
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <EvidenceCard eyebrow="Key correlation">
          {insightError ? (
            insightError
          ) : (
            <div>
              <h3 className="text-base font-medium leading-snug text-foreground">
                {topInsight?.message ?? "Sleep consistency + Heart Rate Variability"}
              </h3>
              <div className="mt-5 grid grid-cols-[0.7fr_1fr] items-end gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                    Correlation
                  </p>
                  <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-accent">
                    {correlationValue}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-accent">
                    {correlationStrengthLabel(effectSize)}
                  </p>
                  <p className="text-xs text-muted">{days}-day signal</p>
                </div>
                <MiniScatter direction={effectSize != null && effectSize < 0 ? "down" : "up"} />
              </div>
            </div>
          )}
        </EvidenceCard>

        <EvidenceCard eyebrow="Recent trend">
          <h3 className="text-base font-medium text-foreground">Resting heart rate</h3>
          <div className="mt-7 grid grid-cols-[0.65fr_1fr] items-end gap-5">
            <div>
              <p className="font-mono text-4xl font-bold tabular-nums text-danger">
                {trend.latestRestingHeartRate != null
                  ? Math.round(trend.latestRestingHeartRate)
                  : "--"}
              </p>
              <p className="text-xs text-muted">bpm</p>
              <p className="text-xs text-muted">{trendLabel}</p>
            </div>
            <MiniTrend />
          </div>
        </EvidenceCard>

        <EvidenceCard eyebrow="Training load compared with sleep consistency">
          <h3 className="max-w-sm text-base font-medium leading-relaxed text-foreground">
            Higher load weeks can be reviewed beside sleep and recovery.
          </h3>
          <div className="mt-5">
            <MiniScatter direction="down" />
          </div>
        </EvidenceCard>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-white/62 p-4">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-muted">
          Health monitor
        </p>
        {healthMonitor}
      </div>
    </section>
  );
}

function EvidenceCard({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <div className="min-h-[15rem] rounded-lg border border-border bg-white/62 p-5">
      <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
      {children}
    </div>
  );
}

function MiniScatter({ direction }: { direction: "up" | "down" }) {
  const points =
    direction === "up"
      ? [
          [10, 58],
          [18, 50],
          [28, 48],
          [38, 42],
          [50, 35],
          [62, 29],
          [76, 23],
          [88, 18],
          [22, 33],
          [44, 28],
          [68, 38],
        ]
      : [
          [10, 18],
          [18, 26],
          [28, 31],
          [38, 36],
          [50, 42],
          [62, 48],
          [76, 55],
          [88, 61],
          [22, 44],
          [44, 50],
          [68, 35],
        ];

  return (
    <svg viewBox="0 0 120 72" className="h-24 w-full" role="img" aria-hidden="true">
      <path d="M4 64H116" stroke="var(--color-border-strong)" strokeWidth="1" />
      <path d="M4 8V64" stroke="var(--color-border-strong)" strokeWidth="1" />
      <path
        d={direction === "up" ? "M8 60L112 14" : "M8 18L112 60"}
        stroke="var(--color-accent-secondary)"
        strokeWidth="1.5"
      />
      {points.map(([xPosition, yPosition]) => (
        <circle
          key={`${xPosition}-${yPosition}`}
          cx={xPosition}
          cy={yPosition}
          r="2.4"
          fill="var(--color-accent)"
        />
      ))}
    </svg>
  );
}

function MiniTrend() {
  return (
    <svg viewBox="0 0 160 72" className="h-24 w-full" role="img" aria-hidden="true">
      <path
        d="M0 18C18 20 28 38 44 34C62 30 72 48 90 44C110 40 122 56 160 52"
        fill="none"
        stroke="var(--color-danger)"
        strokeWidth="2"
      />
      <path
        d="M0 18C18 20 28 38 44 34C62 30 72 48 90 44C110 40 122 56 160 52L160 72L0 72Z"
        fill="var(--color-danger)"
        opacity="0.08"
      />
    </svg>
  );
}

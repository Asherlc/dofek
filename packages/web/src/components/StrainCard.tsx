import { strainColor, strainLabel, workloadRatioColor } from "@dofek/scoring/scoring";
import { selectRecentDailyLoad } from "@dofek/training/training";
import type { WorkloadRatioRow } from "dofek-server/types";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface StrainCardProps {
  data: WorkloadRatioRow[] | undefined;
  loading?: boolean;
}

function StrainRing({ strain, size = 120 }: { strain: number; size?: number }) {
  const maxStrain = 21;
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(strain / maxStrain, 1);
  const offset = circumference * (1 - fraction);
  const color = strainColor(strain);
  const center = size / 2;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        role="img"
        aria-label={`Strain gauge showing ${strain.toFixed(1)} out of ${maxStrain}`}
      >
        <title>Strain: {strain.toFixed(1)}</title>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#27272a"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums" style={{ color }}>
          {strain.toFixed(1)}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
          Strain
        </span>
      </div>
    </div>
  );
}

export function StrainCard({ data, loading }: StrainCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={200} />;
  }

  if (!data || data.length === 0) {
    return (
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-6 flex items-center justify-center h-[200px]">
        <span className="text-zinc-600 text-sm">No strain data yet</span>
      </div>
    );
  }

  const displayed = selectRecentDailyLoad(data);
  const today = data[data.length - 1];
  const strain = displayed?.strain ?? 0;
  const label = strainLabel(strain);
  const color = strainColor(strain);
  const workloadRatio = today?.workloadRatio;

  const dateLabel =
    displayed == null
      ? ""
      : displayed.date === today?.date
        ? "Today"
        : `Last training: ${new Date(displayed.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-6">
      <div className="flex items-center gap-6">
        <StrainRing strain={strain} size={120} />

        <div className="flex-1 space-y-3">
          <div>
            <span
              className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold"
              style={{ backgroundColor: `${color}20`, color }}
            >
              {label}
            </span>
            {dateLabel && <p className="text-xs text-zinc-500 mt-1">{dateLabel}</p>}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-lg font-bold text-zinc-100 tabular-nums">
                {today?.acuteLoad.toFixed(0) ?? "--"}
              </p>
              <p className="text-[10px] text-zinc-500">Acute (7d)</p>
            </div>
            <div>
              <p className="text-lg font-bold text-zinc-100 tabular-nums">
                {today?.chronicLoad.toFixed(0) ?? "--"}
              </p>
              <p className="text-[10px] text-zinc-500">Chronic (28d)</p>
            </div>
            <div>
              <p
                className="text-lg font-bold tabular-nums"
                style={{ color: workloadRatioColor(workloadRatio ?? null) }}
              >
                {workloadRatio != null ? workloadRatio.toFixed(2) : "--"}
              </p>
              <p className="text-[10px] text-zinc-500">Workload Ratio</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

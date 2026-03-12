import type { AnomalyRow } from "../../../server/src/routers/anomaly-detection.ts";

interface AnomalyAlertBannerProps {
  anomalies: AnomalyRow[];
  loading?: boolean;
}

export function AnomalyAlertBanner({ anomalies, loading }: AnomalyAlertBannerProps) {
  if (loading || anomalies.length === 0) return null;

  const hasAlert = anomalies.some((a) => a.severity === "alert");
  const bgColor = hasAlert ? "bg-red-950/50 border-red-800" : "bg-yellow-950/50 border-yellow-800";
  const textColor = hasAlert ? "text-red-300" : "text-yellow-300";

  // Check for illness pattern
  const hasElevatedHr = anomalies.some((a) => a.metric === "Resting Heart Rate");
  const hasDepressedHrv = anomalies.some((a) => a.metric === "Heart Rate Variability");
  const illnessPattern = hasElevatedHr && hasDepressedHrv;

  return (
    <div className={`rounded-lg border ${bgColor} p-4 space-y-2`}>
      <h3 className={`text-sm font-semibold ${textColor}`}>
        {hasAlert ? "Health Alert" : "Health Warning"}
      </h3>
      <ul className="space-y-1">
        {anomalies.map((a) => (
          <li key={`${a.date}-${a.metric}`} className="text-sm text-zinc-300">
            <span className="font-medium">{a.metric}</span>: {a.value}{" "}
            <span className="text-zinc-500">
              (baseline: {a.baselineMean} ± {a.baselineStddev}, z-score: {a.zScore})
            </span>
          </li>
        ))}
      </ul>
      {illnessPattern && (
        <p className="text-xs text-zinc-400 italic">
          Combined elevated resting HR and depressed HRV may indicate your body is fighting
          something. Consider taking it easy today.
        </p>
      )}
    </div>
  );
}

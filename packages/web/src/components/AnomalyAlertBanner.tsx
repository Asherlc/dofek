import type { AnomalyRow } from "../../../server/src/routers/anomaly-detection.ts";

interface AnomalyAlertBannerProps {
  anomalies: AnomalyRow[];
  loading?: boolean;
}

export function AnomalyAlertBanner({ anomalies, loading }: AnomalyAlertBannerProps) {
  if (loading || anomalies.length === 0) return null;

  const hasAlert = anomalies.some((anomaly) => anomaly.severity === "alert");
  const bgColor = hasAlert ? "bg-red-50/90 border-red-200" : "bg-yellow-50/90 border-yellow-300";
  const headingColor = hasAlert ? "text-red-800" : "text-yellow-900";
  const bodyColor = hasAlert ? "text-red-950" : "text-yellow-950";
  const detailColor = hasAlert ? "text-red-800" : "text-yellow-800";

  // Check for illness pattern
  const hasElevatedHr = anomalies.some((anomaly) => anomaly.metric === "Resting Heart Rate");
  const hasDepressedHrv = anomalies.some((anomaly) => anomaly.metric === "Heart Rate Variability");
  const illnessPattern = hasElevatedHr && hasDepressedHrv;

  return (
    <div className={`rounded-lg border ${bgColor} p-4 space-y-2`}>
      <h3 className={`text-sm font-semibold ${headingColor}`}>
        {hasAlert ? "Health Alert" : "Health Warning"}
      </h3>
      <ul className="space-y-1">
        {anomalies.map((anomaly) => (
          <li key={`${anomaly.date}-${anomaly.metric}`} className={`text-sm ${bodyColor}`}>
            <span className="font-medium">{anomaly.metric}</span>: {anomaly.value}{" "}
            <span className={detailColor}>
              (baseline: {anomaly.baselineMean} ± {anomaly.baselineStddev}, z-score:{" "}
              {anomaly.zScore})
            </span>
          </li>
        ))}
      </ul>
      {illnessPattern && (
        <p className={`text-xs ${detailColor} italic`}>
          Combined elevated resting HR and depressed HRV may indicate your body is fighting
          something. Consider taking it easy today.
        </p>
      )}
    </div>
  );
}
